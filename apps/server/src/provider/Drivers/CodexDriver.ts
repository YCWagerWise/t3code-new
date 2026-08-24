/**
 * CodexDriver — the "Codex" provider, backed by agent-sdk-rs over ACP.
 *
 * Not the Codex CLI: this spawns `t3code-agent` with model `codex-resume:*`
 * (i.e. `codex exec resume` under the hood). Model is chosen at spawn from the
 * picker; the "Codex default" slug lets codex pick its own default model. See
 * {@link ./AgentSdkDriver}.
 */
import { CodexSettings, MODEL_CATALOG_BY_PROVIDER, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { type AgentSdkDriverEnv, makeAgentSdkDriver } from "./AgentSdkDriver.ts";
import { resolveCodexHomeLayout } from "./CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

export type CodexDriverEnv = AgentSdkDriverEnv;

export const CodexDriver = makeAgentSdkDriver<CodexSettings>({
  driverKind: "codex",
  displayName: "Codex",
  modelPrefix: "codex-resume",
  models: [
    // Empty spec => codex uses its own default model. This row is the driver's
    // own, not a model slug the registry knows about.
    { slug: "codex-default", name: "Codex (default)", agentModel: "codex-resume:" },
    // Everything else comes from the ONE shared catalog (#221), so a slug the
    // contracts registry names is always selectable and routable here.
    ...(MODEL_CATALOG_BY_PROVIDER[ProviderDriverKind.make("codex")] ?? []),
  ],
  defaultModelSlug: "codex-default",
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  // Codex keeps its session history in CODEX_HOME. Two instances pointed at the
  // same home ARE the same conversation store, so they share a continuation
  // key; keying continuation by instance id would split one history in two.
  continuationIdentity: ({ config }) =>
    resolveCodexHomeLayout(config).pipe(
      Effect.map((layout) => ({
        driverKind: ProviderDriverKind.make("codex"),
        continuationKey: layout.continuationKey,
      })),
    ),
});
