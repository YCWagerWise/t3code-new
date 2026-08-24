/**
 * AgentSdkDriver — the single `ProviderDriver` factory backing every t3code
 * provider with agent-sdk-rs over ACP.
 *
 * t3code no longer talks to any vendor CLI. Both the "Claude" and "Codex"
 * providers are this one driver with a different `model` string: they spawn the
 * same `t3code-agent` binary (agent-sdk-rs), which serves official ACP on stdio
 * and picks its model from `T3CODE_AGENT_MODEL`. Because both instances use the
 * same adapter and emit the same ACP `session/update` shapes, they render
 * identically in the UI — the only difference is which model answers.
 *
 * @module provider/Drivers/AgentSdkDriver
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAgentSdkTextGeneration } from "../../textGeneration/AgentSdkTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAgentSdkAdapter } from "../Layers/AgentSdkAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

/** Path to the `t3code-agent` binary, overridable via env. */
const resolveAgentBinary = (env: NodeJS.ProcessEnv): string =>
  env.T3CODE_AGENT_BIN?.trim() || "t3code-agent";

/**
 * Whether the agent binary actually exists and is executable.
 *
 * A bare name like `t3code-agent` is resolved against PATH the way the spawn
 * itself will resolve it; an explicit `T3CODE_AGENT_BIN` path is checked
 * directly. Returns the resolved path, or `null` when nothing is runnable.
 *
 * This exists because the probe used to be a hardcoded
 * `installed: true, status: "ready"` (#240): the snapshot claimed the provider
 * was ready no matter what, so a missing binary surfaced only as a failed turn
 * after the user had already sent one. `installed` is a claim about the
 * filesystem, and nothing was checking the filesystem.
 */
/**
 * A candidate binary is USABLE only if it is a regular file the CURRENT
 * process can execute. `fs.exists` alone was the first fix for #240, but
 * a file that exists is not necessarily one this process can run — a
 * stray text file named `t3code-agent`, a script the developer forgot to
 * `chmod +x`, an explicit `T3CODE_AGENT_BIN` pointing at a `.tar.gz` a
 * build script left behind. Nor is "any exec bit set" enough: mode 0o001
 * grants execute only to `other`, so a file this user OWNS is not runnable
 * by this process even though a `mode & 0o111` check says yes.
 *
 * The right predicate is exactly what the OS applies at spawn time:
 * `access(path, X_OK)`, which walks (uid, gid, other) in the correct
 * order for THIS process. Node's `fs.access` with `constants.X_OK` is the
 * standard-library implementation of that check.
 *
 * Also require `type === "File"` (via `stat`) so a DIRECTORY named like
 * the binary — which happens with `mkdir` for logs — is not treated as
 * runnable just because `access` succeeds on the dir. Windows has no
 * executable bit; a plain existence check there matches the PATH-lookup
 * convention every other tool follows.
 */
const isRunnable = (candidate: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const { stat, access } = await import("node:fs/promises");
      const { constants } = await import("node:fs");
      if (!(await stat(candidate)).isFile()) return false;
      await access(candidate, constants.X_OK);
      return true;
    },
    catch: () => new Error("not runnable"),
  }).pipe(Effect.orElseSucceed(() => false));

export const findAgentBinary = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const bin = resolveAgentBinary(env);
    // An explicit path (absolute or relative) is used as given — a PATH lookup
    // would be wrong and would mask a bad `T3CODE_AGENT_BIN` override.
    if (path.isAbsolute(bin) || bin.includes(path.sep)) {
      return (yield* isRunnable(bin)) ? bin : null;
    }
    // A bare name resolves against PATH, the same way the spawn will.
    const separator = process.platform === "win32" ? ";" : ":";
    for (const dir of (env.PATH ?? "").split(separator)) {
      if (dir.length === 0) continue;
      const candidate = path.join(dir, bin);
      if (yield* isRunnable(candidate)) return candidate;
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));

export interface AgentSdkDriverDefinition<C> {
  /** Driver kind slug (kept as "claudeAgent" / "codex" so the UI stays intact). */
  readonly driverKind: string;
  /** UI display name. */
  readonly displayName: string;
  /** Prefix for the agent-sdk model spec, e.g. "claude-resume" / "codex-resume". */
  readonly modelPrefix: string;
  /** Models to advertise in the picker. `agentModel` overrides `${prefix}:${slug}`. */
  readonly models: ReadonlyArray<{ slug: string; name: string; agentModel?: string }>;
  /** Slug used when a turn carries no explicit selection. */
  readonly defaultModelSlug: string;
  /** Config schema (reuses the vendor settings schema for legacy hydration). */
  readonly configSchema: Schema.Codec<C, unknown>;
  /** Default config payload. */
  readonly defaultConfig: () => C;
  /**
   * Continuation identity for an instance, when the driver's is not simply its
   * instance id. Codex instances that share one CODEX_HOME share their session
   * history, so they must share a continuation key — two instances pointed at
   * the same home are the same conversation store, and keying by instance id
   * splits it (which is what the multi-instance registry slice asserts).
   */
  readonly continuationIdentity?: (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly config: C;
  }) => Effect.Effect<ProviderContinuationIdentity, never, Path.Path>;
}

export type AgentSdkDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/** Build a `ProviderDriver` that runs agent-sdk-rs with a fixed model. */
export function makeAgentSdkDriver<C extends { enabled?: boolean }>(
  def: AgentSdkDriverDefinition<C>,
): ProviderDriver<C, AgentSdkDriverEnv> & {
  /** The definition this driver advertises — read by the model-catalog check. */
  readonly definition: AgentSdkDriverDefinition<C>;
} {
  const DRIVER_KIND = ProviderDriverKind.make(def.driverKind);

  const withInstanceIdentity =
    (input: {
      readonly instanceId: ProviderInstance["instanceId"];
      readonly displayName: string | undefined;
      readonly accentColor: string | undefined;
      readonly continuationGroupKey: string;
    }) =>
    (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
    });

  return {
    definition: def,
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: def.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: def.configSchema,
    defaultConfig: def.defaultConfig,
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const eventLoggers = yield* ProviderEventLoggers;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const crypto = yield* Crypto.Crypto;
        const continuationIdentity =
          def.continuationIdentity === undefined
            ? defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId })
            : yield* def.continuationIdentity({ instanceId, config });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });

        const modelSpecBySlug = new Map(
          def.models.map((m) => [m.slug, m.agentModel ?? `${def.modelPrefix}:${m.slug}`]),
        );
        const resolveAgentModel = (slug: string | undefined): string => {
          const key = slug ?? def.defaultModelSlug;
          return modelSpecBySlug.get(key) ?? `${def.modelPrefix}:${key}`;
        };
        const adapter = yield* makeAgentSdkAdapter(
          {
            provider: DRIVER_KIND,
            defaultModelSlug: def.defaultModelSlug,
            resolveAgentModel,
            binaryPath: resolveAgentBinary(processEnv),
          },
          {
            environment: processEnv,
            ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
            instanceId,
          },
        );

        // Auxiliary generation (commit message, PR body, branch, title) runs on
        // the SELECTED model through a short-lived session of this same binary
        // (#216) — with a deterministic local fallback so a text nicety can
        // never block a commit.
        const textGeneration = makeAgentSdkTextGeneration({
          childProcessSpawner,
          crypto,
          resolveAgentModel,
          ...(resolveAgentBinary(processEnv) ? { binaryPath: resolveAgentBinary(processEnv) } : {}),
          environment: processEnv,
        });
        const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        });

        const agentBinaryPath = yield* findAgentBinary(processEnv);
        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const serverProvider = stampIdentity(
          buildServerProvider({
            presentation: { displayName: def.displayName, showInteractionModeToggle: false },
            enabled,
            checkedAt,
            models: def.models.map((m) => ({
              slug: m.slug,
              name: m.name,
              isCustom: false,
              isDefault: m.slug === def.defaultModelSlug,
              capabilities: null,
            })),
            probe: {
              // agent-sdk-rs authenticates ambiently (whatever `claude`/`codex`
              // is logged in as), so auth genuinely cannot be probed from here.
              // Installation CAN be, and must be (#240): claiming `installed:
              // true` for a binary that is not on disk makes the composer offer
              // a provider that cannot start, and the user discovers it only
              // after sending a turn.
              installed: agentBinaryPath !== null,
              version: null,
              status: agentBinaryPath !== null ? "ready" : "error",
              // `message` is the only reason channel `buildServerProvider`
              // forwards onto the snapshot, so the explanation goes here — an
              // `error` status with no message is a dead end for the user.
              ...(agentBinaryPath === null
                ? {
                    message: `agent binary "${resolveAgentBinary(processEnv)}" was not found on PATH; set T3CODE_AGENT_BIN`,
                  }
                : {}),
              auth: { status: "authenticated" },
            },
          }),
        );

        const snapshot: ServerProviderShape = {
          maintenanceCapabilities,
          getSnapshot: Effect.succeed(serverProvider),
          refresh: Effect.succeed(serverProvider),
          streamChanges: Stream.empty,
        };

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build agent-sdk snapshot: ${(cause as { message?: string })?.message ?? String(cause)}`,
              cause,
            }),
        ),
      ),
  };
}
