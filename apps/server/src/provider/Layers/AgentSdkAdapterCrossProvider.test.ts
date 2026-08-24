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

/** `binaryPath` is spawned with NO arguments, so the mock agent needs a shim. */
function writeAgentShim(dir: string): string {
  const shim = NodePath.join(dir, "agent-shim.sh");
  NodeFS.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(mockAgentPath)} "$@"\n`);
  NodeFS.chmodSync(shim, 0o755);
  return shim;
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

/**
 * #284: a `sendTurn` whose `modelSelection.instanceId` does NOT match the
 * bound adapter's instance is REFUSED, and the refusal is visible at the
 * ACP child — not at directory.upsert-time after the fact.
 *
 * The adapter used to treat a cross-provider selection as `undefined`
 * inside `resolveTurnModel` and silently fall through to the session's
 * model. That let `directory.upsert` record a model payload the runtime
 * never routed: the UI would show "switched to codex" while the
 * conversation stayed on the old provider/session. That is not
 * first-class context-retaining switching; it is a split between UI
 * metadata and runtime execution.
 *
 * The guard at `AgentSdkAdapter.ts:900+` refuses instead. The proof this
 * is a fix rather than a claim is the second assertion: the CHILD saw
 * NEITHER a prompt for the refused turn NOR a `session/set_config_option`
 * that would have applied the mismatched selection.
 */
describe("AgentSdkAdapter.sendTurn — cross-provider selection is refused (#284)", () => {
  // `it.live`, NOT `it.effect`. `it.effect` runs on Effect's TEST CLOCK; we
  // spawn a real child process, so the test has to be on the real clock too.
  it.live(
    "refuses a sendTurn whose modelSelection.instanceId != boundInstanceId, and the agent sees no prompt or config change",
    () => {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cross-provider-"));
      const requestLogPath = NodePath.join(tmp, "requests.ndjson");
      process.env.T3_ACP_REQUEST_LOG_PATH = requestLogPath;
      const shim = writeAgentShim(tmp);
      const threadId = ThreadId.make("t-cross-provider");

      return Effect.gen(function* () {
        const adapter = yield* makeAgentSdkAdapter(
          {
            provider: ProviderDriverKind.make("codex"),
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
        const afterStart = methodsSeenBy(requestLogPath).length;

        // A sendTurn whose modelSelection.instanceId points at a
        // DIFFERENT provider instance ("claudeAgent" while the adapter is
        // bound to "codex") must be refused BEFORE any prompt or config
        // method reaches the child. The old silent-ignore path would have
        // written a `session/set_config_option` for the wrong model AND
        // sent the prompt through the wrong provider's live session.
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "route me to the wrong provider",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-5",
            },
          })
          .pipe(Effect.flip);

        const rendered = JSON.stringify(error);
        expect(rendered, `expected a ProviderAdapterValidationError, got ${rendered}`).toContain(
          "ProviderAdapterValidationError",
        );
        expect(rendered).toContain("sendTurn");
        // Message names both the bound instance and the requested one so a
        // client cannot mistake refusal for a runtime crash.
        expect(rendered).toContain("codex");
        expect(rendered).toContain("claudeAgent");

        // THE ASSERTION THAT MATTERS. Refusing the caller is not the same
        // as not sending. Counted off the child's own request log so it
        // cannot be satisfied by the adapter merely believing it refused:
        //   * no `session/prompt` reached the mock (the refused turn's
        //     input never ran);
        //   * no `session/set_config_option` reached the mock (the
        //     mismatched selection never applied).
        const during = methodsSeenBy(requestLogPath).slice(afterStart);
        expect(
          during.filter((m) => m.includes("prompt")).length,
          `no prompt should reach the mock for a refused cross-provider turn: ${JSON.stringify(during)}`,
        ).toBe(0);
        expect(
          during.filter((m) => m.includes("set_config_option")).length,
          `no set_config_option for the mismatched selection: ${JSON.stringify(during)}`,
        ).toBe(0);

        // And the adapter is still usable — a SAME-instance turn after the
        // refusal runs normally. The guard is per-call, not a permanent
        // wedge.
        yield* adapter.sendTurn({
          threadId,
          input: "actually route me to the bound provider",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "composer-2",
          },
        });
        const afterSameInstance = methodsSeenBy(requestLogPath).slice(afterStart);
        expect(
          afterSameInstance.filter((m) => m.includes("prompt")).length,
          "the same-instance turn after the refusal is allowed and reaches the mock",
        ).toBe(1);

        yield* adapter.stopSession(threadId).pipe(Effect.orElseSucceed(() => undefined));
      }).pipe(
        Effect.provide(ServerConfig.layerTest(tmp, { prefix: "t3-cross-provider-cfg-" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
    60_000,
  );
});
