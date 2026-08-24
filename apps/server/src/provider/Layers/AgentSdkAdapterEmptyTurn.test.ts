// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeAgentSdkAdapter } from "./AgentSdkAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

/**
 * `binaryPath` is spawned with NO arguments, so the mock agent needs a
 * one-line executable wrapper.
 */
function writeAgentShim(dir: string): string {
  const shim = NodePath.join(dir, "agent-shim.sh");
  NodeFS.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(mockAgentPath)} "$@"\n`);
  NodeFS.chmodSync(shim, 0o755);
  return shim;
}

/** Every JSON-RPC request the agent actually RECEIVED, in order, with params. */
function requestsSeenBy(
  requestLogPath: string,
): ReadonlyArray<{ readonly method: string; readonly params: unknown }> {
  if (!NodeFS.existsSync(requestLogPath)) return [];
  return NodeFS.readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { readonly method?: unknown; readonly params?: unknown };
        return typeof parsed.method === "string"
          ? [{ method: parsed.method, params: parsed.params }]
          : [];
      } catch {
        return [];
      }
    });
}

/** Every JSON-RPC method the agent actually RECEIVED, in order. */
function methodsSeenBy(requestLogPath: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(requestLogPath)) return [];
  return NodeFS.readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { readonly method?: unknown };
        return typeof parsed.method === "string" ? [parsed.method] : [];
      } catch {
        return [];
      }
    });
}

describe("AgentSdkAdapter.sendTurn — an empty turn mutates nothing (#272)", () => {
  // The predicate test next door proves the RULE. This proves the ORDERING,
  // which is the actual defect: the emptiness check used to run after
  // `applyRequestedSessionConfiguration` (→ `session/set_model`) and after the
  // active turn id and session state were replaced, so a rejected send still
  // changed which model the next real turn would use. A reorder that keeps the
  // predicate intact would keep the other tests green — this one fails.
  it.effect(
    "rejects whitespace-only input WITHOUT sending set_model or prompt to the agent",
    () => {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-empty-turn-"));
      const requestLogPath = NodePath.join(tmp, "requests.ndjson");
      process.env.T3_ACP_REQUEST_LOG_PATH = requestLogPath;
      const shim = writeAgentShim(tmp);
      const threadId = ThreadId.make("t-empty-turn");

      return Effect.gen(function* () {
        const adapter = yield* makeAgentSdkAdapter(
          {
            provider: ProviderDriverKind.make("codex"),
            defaultModelSlug: "model-a",
            resolveAgentModel: (slug) => `codex-resume:${slug ?? "model-a"}`,
            binaryPath: shim,
          },
          { instanceId: ProviderInstanceId.make("codex") },
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          cwd: tmp,
          runtimeMode: "full-access",
        });

        const methodsAfterStart = methodsSeenBy(requestLogPath);

        // A model switch rides along, so a mutation-before-validation bug has
        // something visible to do.
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "   ",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "model-b",
              options: [],
            },
          })
          .pipe(Effect.flip);

        expect(String(JSON.stringify(error))).toContain("non-empty text or attachments");

        const methodsAfter = methodsSeenBy(requestLogPath);
        const newMethods = methodsAfter.slice(methodsAfterStart.length);
        expect(newMethods.filter((m) => m.includes("set_model") || m.includes("setModel"))).toEqual(
          [],
        );
        expect(newMethods.filter((m) => m.includes("prompt"))).toEqual([]);

        yield* adapter.stopSession(threadId).pipe(Effect.orElseSucceed(() => undefined));
      }).pipe(
        Effect.provide(ServerConfig.layerTest(tmp, { prefix: "t3-empty-turn-cfg-" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
    30_000,
  );

  // The assertion above proves nothing was SENT. This proves nothing was KEPT.
  //
  // #272 asks for `ctx.activeTurnId` and `ctx.session` to be unchanged, which are
  // private fields. Reaching into them would pin the implementation and still not
  // answer the question the finding actually poses — "context/model state can
  // drift from the visible conversation". So this asserts the drift itself: after
  // the rejected whitespace send that carried `model-b`, a REAL turn carrying no
  // selection of its own must still run on `model-a`. If the rejected send had
  // been allowed to write `ctx.session.model`, this turn would silently run on
  // `model-b` — the exact user-visible symptom, and one no predicate test sees.
  it.effect(
    "a rejected whitespace send does not leave its model behind for the next real turn",
    () => {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-empty-turn-keep-"));
      const requestLogPath = NodePath.join(tmp, "requests.ndjson");
      process.env.T3_ACP_REQUEST_LOG_PATH = requestLogPath;
      const shim = writeAgentShim(tmp);
      const threadId = ThreadId.make("t-empty-turn-keep");

      return Effect.gen(function* () {
        const adapter = yield* makeAgentSdkAdapter(
          {
            provider: ProviderDriverKind.make("codex"),
            // Slugs the mock agent actually accepts, so the follow-up turn
            // COMPLETES and its model reaches the wire where it can be read.
            // `model-a`/`model-b` never got that far — the turn died on an
            // invalid-slug error before proving anything.
            defaultModelSlug: "composer-2",
            resolveAgentModel: (slug) => slug ?? "composer-2",
            binaryPath: shim,
          },
          { instanceId: ProviderInstanceId.make("codex") },
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          cwd: tmp,
          runtimeMode: "full-access",
        });

        // Rejected — and it tries to switch the session to the OTHER model on its way out.
        yield* adapter
          .sendTurn({
            threadId,
            input: "   ",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "composer-2[fast=true]",
              options: [],
            },
          })
          .pipe(Effect.flip);

        const beforeReal = requestsSeenBy(requestLogPath).length;

        // A real turn, carrying NO selection: it must inherit the session's model,
        // which the rejected send must not have touched.
        yield* adapter.sendTurn({ threadId, input: "actually do something" });

        // EVERY request the agent saw for this turn, params included — not just
        // the ones whose method name we guessed. Filtering by `set_model` made the
        // assertion vacuous: that method never appears on this path, so the filter
        // was always empty and the check could not have failed. Asserting on the
        // whole wire is what makes a leaked `model-b` detectable wherever it rides.
        const wire = JSON.stringify(requestsSeenBy(requestLogPath).slice(beforeReal));
        expect(wire).toContain("composer-2");
        expect(wire).not.toContain("fast=true");

        yield* adapter.stopSession(threadId).pipe(Effect.orElseSucceed(() => undefined));
      }).pipe(
        Effect.provide(ServerConfig.layerTest(tmp, { prefix: "t3-empty-turn-keep-cfg-" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
    30_000,
  );
});
