/**
 * ClaudeDriver — the "Claude" provider, backed by agent-sdk-rs over ACP.
 *
 * Not the Claude CLI: this spawns `t3code-agent` with model `claude-resume:*`
 * (i.e. `claude --print --resume` under the hood). Model is chosen at spawn
 * from the picker; see {@link ./AgentSdkDriver}.
 */
import { ClaudeSettings, MODEL_CATALOG_BY_PROVIDER, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type AgentSdkDriverEnv, makeAgentSdkDriver } from "./AgentSdkDriver.ts";
import { makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export type ClaudeDriverEnv = AgentSdkDriverEnv;

export const ClaudeDriver = makeAgentSdkDriver<ClaudeSettings>({
  driverKind: "claudeAgent",
  displayName: "Claude",
  modelPrefix: "claude-resume",
  // The ONE shared catalog (#221) — a slug the contracts registry names (a
  // default, a preferred model, an alias target) must be selectable here, or a
  // stored selection silently stops routing while the picker shows a different,
  // shorter list.
  models: [...(MODEL_CATALOG_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ?? [])],
  defaultModelSlug: "claude-sonnet-5",
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  // Claude keeps its conversation history under CLAUDE_CONFIG_DIR. Instances
  // sharing one home share that history, so they share a continuation key.
  continuationIdentity: ({ config }) =>
    makeClaudeContinuationGroupKey(config).pipe(
      Effect.map((continuationKey) => ({
        driverKind: ProviderDriverKind.make("claudeAgent"),
        continuationKey,
      })),
    ),
});
