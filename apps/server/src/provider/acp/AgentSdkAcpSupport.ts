/**
 * AgentSdkAcpSupport — spawn the `t3code-agent` binary (agent-sdk-rs) and
 * drive it over official ACP.
 *
 * agent-sdk-rs is the model-neutral runtime: the SAME binary is Claude, Codex
 * or a local model depending on `T3CODE_AGENT_MODEL`. t3code no longer talks to
 * any vendor CLI directly — it spawns this one ACP process and the model is a
 * config knob. So "switch to Claude" and "switch to Codex" are two instances of
 * the same adapter with a different model string; they render identically
 * because they emit the same official ACP `session/update` shapes.
 *
 * Unlike the old Cursor path, the agent-sdk process takes its model from the
 * environment (not an in-band ACP `session/set_model` call), so model selection
 * here is a no-op — the model is fixed when the process spawns.
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Config the agent-sdk adapter needs to spawn its ACP child. */
export interface AgentSdkSpawnConfig {
  /** Path to the `t3code-agent` binary. Defaults to `t3code-agent` on PATH. */
  readonly binaryPath?: string | null | undefined;
  /**
   * The agent-sdk model spec, e.g. `claude-resume:claude-haiku-4-5-20251001`
   * or `codex-resume:gpt-5.6-sol`. Passed to the child as `T3CODE_AGENT_MODEL`.
   */
  readonly model: string;
  /** Optional session-store root, passed as `T3CODE_AGENT_DATA`. */
  readonly dataDir?: string | null | undefined;
}

export interface AgentSdkAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly spawnConfig: AgentSdkSpawnConfig;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Build the spawn descriptor for the agent-sdk ACP child. The binary serves
 * official ACP on stdin/stdout with no subcommand; the model + workspace are
 * injected via the environment the runtime already understands.
 */
export function buildAgentSdkSpawnInput(
  config: AgentSdkSpawnConfig,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const env: NodeJS.ProcessEnv = {
    ...(environment ?? {}),
    T3CODE_AGENT_MODEL: config.model,
    T3CODE_WORKSPACE: cwd,
    ...(config.dataDir ? { T3CODE_AGENT_DATA: config.dataDir } : {}),
  };
  return {
    command: config.binaryPath?.trim() || "t3code-agent",
    args: [],
    cwd,
    env,
  };
}

export const makeAgentSdkAcpRuntime = (
  input: AgentSdkAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAgentSdkSpawnInput(input.spawnConfig, input.cwd, input.environment),
        // agent-sdk-rs authenticates ambiently (whatever `claude`/`codex` is
        // logged in as); there is no ACP login handshake to name.
        authMethodId: "agent_sdk",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
