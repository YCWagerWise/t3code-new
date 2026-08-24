// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

const promptCount = (methods: ReadonlyArray<string>): number =>
  methods.filter((m) => m.includes("prompt")).length;

/**
 * #201: a second `sendTurn` while one is in flight is REFUSED, and the refusal
 * is observable at the ACP child.
 *
 * The adapter used to claim the second send was a "steer folded into the active
 * turn". It was not: the ACP runtime serialises `session/prompt` behind
 * `promptSerializationSemaphore`, so the second prompt waited for the first RPC
 * to finish and was then sent as ANOTHER prompt — after the agent had already
 * completed the work it was supposed to steer. The user's correction arrived as
 * a second question.
 *
 * The guard at `AgentSdkAdapter.ts:890` refuses instead. What makes that a fix
 * rather than a claim is the third assertion below: the CHILD saw one prompt.
 * A guard that refuses the caller and still leaks the prompt downstream would
 * pass an error-shape assertion and fail this one.
 */
describe("AgentSdkAdapter.sendTurn — one turn at a time (#201)", () => {
  // `it.live`, NOT `it.effect`. `it.effect` runs on Effect's TEST CLOCK, where
  // `Effect.sleep` waits for the clock to be advanced by hand and never returns
  // on its own — this test hung for a full 60s timeout on exactly that. The
  // window here is held open by a real child process sleeping in real time, so
  // the test has to be on the real clock too.
  it.live(
    "refuses a second sendTurn while one is in flight, and the agent sees ONE prompt",
    () => {
      const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-concurrent-turn-"));
      const requestLogPath = NodePath.join(tmp, "requests.ndjson");
      process.env.T3_ACP_REQUEST_LOG_PATH = requestLogPath;
      // HOLD THE FIRST PROMPT OPEN DETERMINISTICALLY. Without this the mock
      // answers in microseconds and the "race" is a coin flip on scheduler
      // order — a test that passes because the window shut before it looked is
      // the same lie as the helper-only evidence this replaces.
      process.env.T3_ACP_PROMPT_DELAY_MS = "3000";
      const shim = writeAgentShim(tmp);
      const threadId = ThreadId.make("t-concurrent-turn");

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

        // FORK the first turn so it is genuinely in flight rather than settled.
        // Awaiting it would make the "second" send sequential, and a sequential
        // send is allowed — that is a different test that proves nothing here.
        const first = yield* adapter
          .sendTurn({ threadId, input: "the first, long-running request" })
          .pipe(Effect.forkScoped);

        // Wait until the CHILD has actually received the prompt. Sleeping a
        // fixed amount would make this pass or fail on machine speed; polling
        // the child's own log is the only signal that the window is really open.
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (promptCount(methodsSeenBy(requestLogPath).slice(afterStart)) > 0) break;
          yield* Effect.sleep("25 millis");
        }
        const promptsBefore = promptCount(methodsSeenBy(requestLogPath).slice(afterStart));
        expect(
          promptsBefore,
          "the first prompt must reach the agent before the race is meaningful",
        ).toBe(1);

        // THE RACE: a second send with the first still open.
        const error = yield* adapter
          .sendTurn({ threadId, input: "actually, do this instead" })
          .pipe(Effect.flip);

        const rendered = JSON.stringify(error);
        expect(rendered, `expected a ProviderAdapterValidationError, got ${rendered}`).toContain(
          "ProviderAdapterValidationError",
        );
        expect(rendered).toContain("sendTurn");
        expect(rendered).toContain("already running");

        // THE ASSERTION THAT MATTERS. Refusing the caller is not the same as not
        // sending: the old behaviour queued the second prompt behind the ACP
        // semaphore and delivered it late. Counted off the child's own request
        // log, so it cannot be satisfied by the adapter merely believing it
        // refused.
        const duringRace = promptCount(methodsSeenBy(requestLogPath).slice(afterStart));
        expect(duringRace, "the refused turn must never reach the agent as a second prompt").toBe(
          1,
        );

        // And the refusal did not break the session: the first turn still lands.
        yield* Fiber.join(first);

        const afterFirst = promptCount(methodsSeenBy(requestLogPath).slice(afterStart));
        expect(
          afterFirst,
          "the refused prompt must not arrive LATE either, once the semaphore frees",
        ).toBe(1);

        // A turn sent AFTER the first completes is allowed — the guard is
        // one-at-a-time, not one-ever. The delay knob is cleared first so this
        // one does not pay another three seconds.
        delete process.env.T3_ACP_PROMPT_DELAY_MS;
        yield* adapter.sendTurn({ threadId, input: "now that the first is done" });
        expect(promptCount(methodsSeenBy(requestLogPath).slice(afterStart))).toBe(2);

        yield* adapter.stopSession(threadId).pipe(Effect.orElseSucceed(() => undefined));
        delete process.env.T3_ACP_PROMPT_DELAY_MS;
      }).pipe(
        Effect.provide(ServerConfig.layerTest(tmp, { prefix: "t3-concurrent-turn-cfg-" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      );
    },
    60_000,
  );
});
