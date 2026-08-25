/**
 * AtlasDriver — Atlas as a T3 provider, over its own console API.
 *
 * Atlas is the canonical authority for runs, turns, workspaces and provenance; T3 is a lens.
 * So this driver does NOT spawn anything and does not go through `t3code-agent`: it talks to a
 * running atlas-host over `/console/v1/*`, which is the surface Atlas already serves and
 * already treats as its contract.
 *
 * # Why not the ACP runtime
 *
 * The two shipped drivers both spawn `t3code-agent` ({@link ./AgentSdkDriver}). On this
 * machine that binary cannot be produced at all: `cargo build --bin t3code-agent` in
 * `backend/` fails during *manifest resolution*, because six of its twelve path dependencies
 * — `agent-sdk-acp`, `agent-sdk-shell`, `agent-sdk-usage`, `agent-sdk-metrics`,
 * `agent-sdk-exec` and `cairn` — do not exist in the agent-sdk-rs checkout it points at. That
 * is not a stale build to repair; those crates have never been present. So "restore the ACP
 * runtime" means writing five crates, and the honest first seam is the one Atlas already
 * exposes.
 *
 * # What this driver claims, and what it does not
 *
 * It claims REGISTRATION and READINESS: an Atlas provider that appears in the composer, and a
 * probe that reports what the host actually said. Everything it cannot yet do returns a typed
 * error rather than succeeding emptily — a stub that reports success is the display-only fix
 * this work exists to avoid, wearing a different costume.
 *
 * Readiness here is strictly better than the CLI drivers can manage. `AgentSdkDriver`
 * documents that "agent-sdk-rs authenticates ambiently … so auth genuinely cannot be probed
 * from here" and hardcodes `authenticated`. The Atlas handshake 401s, so `auth` is a real
 * answer.
 *
 * @module provider/Drivers/AtlasDriver
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeAgentSdkTextGeneration } from "../../textGeneration/AgentSdkTextGeneration.ts";
import { ProviderDriverError, ProviderUnsupportedError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider, type ProviderProbeResult } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

export const ATLAS_DRIVER_KIND = ProviderDriverKind.make("atlas");

/**
 * Where the node is and how to authenticate to it.
 *
 * `ProviderDriverKind` is an open branded slug and the contracts layer knows only the config
 * envelope, so this schema lives with the driver rather than in `@t3tools/contracts` — adding
 * an Atlas provider requires no contract change at all.
 */
export const AtlasSettings = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  /** Base URL of the atlas-host node, e.g. `http://127.0.0.1:3010`. */
  baseUrl: Schema.optional(Schema.String),
  /** Machine token or user JWT. Sent as `Authorization: Bearer …`. */
  accessToken: Schema.optional(Schema.String),
});
export type AtlasSettings = typeof AtlasSettings.Type;

const decodeAtlasSettings = Schema.decodeSync(AtlasSettings);

const DEFAULT_BASE_URL = "http://127.0.0.1:3010";

/** Trailing slashes make `${base}/console/v1/...` produce a double slash, which some routers 404. */
const normalizeBaseUrl = (raw: string | undefined): string =>
  (raw?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

/** The subset of `fetch` this driver uses, so a test can supply one without a network. */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

export interface AtlasHostProbeInput {
  readonly baseUrl: string;
  readonly accessToken: string | undefined;
  readonly fetch: FetchLike;
}

/**
 * Ask the node what it is, and report what it said.
 *
 * This is the seam that decides `installed` / `status` / `auth`, tested directly the way
 * `findAgentBinary` is — the whole driver graph does not need standing up to prove the
 * classification is right.
 *
 * The distinction that matters and that #240 got wrong: *unreachable* and *unauthorised* are
 * different answers to a user. A node that is not running is `installed: false` — there is
 * nothing there. A node that answers 401 IS there, and the thing to fix is the token, so it
 * stays `installed: true` with an unauthenticated auth block. Neither is ever reported ready.
 */
export const probeAtlasHost = (input: AtlasHostProbeInput): Effect.Effect<ProviderProbeResult> =>
  Effect.promise(async () => {
    try {
      const response = await input.fetch(`${input.baseUrl}/console/v1/handshake`, {
        method: "GET",
        headers: input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {},
      });
      return classifyHandshake({
        baseUrl: input.baseUrl,
        status: response.status,
        body: await response.text(),
      });
    } catch (cause) {
      // Nothing is listening, DNS failed, the socket died. Not installed — there is no node
      // there to be misconfigured.
      return {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `atlas-host at ${input.baseUrl} is unreachable: ${describe(cause)}`,
      } satisfies ProviderProbeResult;
    }
  });

/**
 * What a handshake response means, as a pure function.
 *
 * Separated from the request so the classification — the part with the judgement in it — is
 * testable without a transport, and so the one rule that matters is stated in one place:
 * nothing here returns `ready` unless the node answered 200 with a body that is actually an
 * Atlas handshake.
 */
export const classifyHandshake = (input: {
  readonly baseUrl: string;
  readonly status: number;
  readonly body: string;
}): ProviderProbeResult => {
  if (input.status === 401 || input.status === 403) {
    // The node IS there; the token is what needs fixing. Reporting `installed: false` would
    // send the user to look for a missing install instead of at their credentials.
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unauthenticated" },
      message: `atlas-host at ${input.baseUrl} refused the access token (${input.status}); set the Atlas provider's accessToken`,
    };
  }
  if (input.status < 200 || input.status >= 300) {
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `atlas-host at ${input.baseUrl} answered ${input.status} on /console/v1/handshake`,
    };
  }
  // A 200 whose body is not a handshake is a different service on that port — reporting ready
  // would send the user's next turn somewhere that cannot run it.
  const ready = readHandshake(input.body);
  if (ready === null) {
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `${input.baseUrl} answered 200 but not with an Atlas handshake`,
    };
  }
  return {
    installed: true,
    version: `protocol ${ready.protocolVersion}`,
    status: "ready",
    auth:
      ready.subject === undefined
        ? { status: "authenticated" }
        : { status: "authenticated", label: ready.subject },
  };
};

const describe = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message?: unknown }).message)
    : String(cause);

/** `{protocol_version, authenticated_subject}` off a `ServerReady` body, or `null`. */
const readHandshake = (
  body: string,
): { readonly protocolVersion: number; readonly subject: string | undefined } | null => {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const protocolVersion = record["protocol_version"];
    if (typeof protocolVersion !== "number") return null;
    const subject = record["authenticated_subject"];
    return {
      protocolVersion,
      ...(typeof subject === "string" && subject.length > 0 ? { subject } : { subject: undefined }),
    };
  } catch {
    return null;
  }
};

/**
 * The `RunCommand::Start` envelope Atlas's command route expects.
 *
 * Pure and exported so a test asserts the exact bytes that reach the host rather than
 * asserting a 200 came back. `model_id` carries the picker's slug straight through: Atlas
 * validates it and refuses an unusable one explicitly rather than substituting a default, so
 * the refusal a user sees originates from the authority, not from a guess made here.
 */
export const atlasStartCommand = (input: {
  readonly fleetId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly actor: string;
  readonly text: string;
  readonly modelId: string | undefined;
  readonly workspaceId: string | undefined;
}): Record<string, unknown> => ({
  protocol_version: 1,
  fleet_id: input.fleetId,
  thread_id: input.threadId,
  run_id: input.runId,
  request_id: input.requestId,
  actor: input.actor,
  command: {
    kind: "start",
    text: input.text,
    limits: {},
    ...(input.modelId === undefined ? {} : { model_id: input.modelId }),
    ...(input.workspaceId === undefined ? {} : { workspace_id: input.workspaceId }),
  },
});

/**
 * Every adapter member, refusing.
 *
 * Registration and readiness are what this commit claims. Driving a turn is the next seam, and
 * until it exists each entry point says so in a typed error. The alternative — returning empty
 * successes — would make the composer look usable and fail silently at the first turn, which
 * is the failure mode this whole line of work is about.
 */
const unsupported = (operation: string) =>
  Effect.fail(
    new ProviderUnsupportedError({
      provider: `${ATLAS_DRIVER_KIND} (${operation})`,
    }),
  );

const makeUnimplementedAtlasAdapter = (): ProviderAdapterShape<ProviderUnsupportedError> => ({
  provider: ATLAS_DRIVER_KIND,
  // Atlas refuses a model change inside a live attempt by design — a selection is immutable
  // within an attempt and may change only between settled turns. `in-session` would promise
  // the composer something the authority will reject.
  capabilities: { sessionModelSwitch: "unsupported" },
  startSession: () => unsupported("startSession"),
  sendTurn: () => unsupported("sendTurn"),
  interruptTurn: () => unsupported("interruptTurn"),
  respondToRequest: () => unsupported("respondToRequest"),
  respondToUserInput: () => unsupported("respondToUserInput"),
  stopSession: () => unsupported("stopSession"),
  listSessions: () => Effect.succeed([]),
  hasSession: () => Effect.succeed(false),
  readThread: () => unsupported("readThread"),
  rollbackThread: () => unsupported("rollbackThread"),
  stopAll: () => unsupported("stopAll"),
  streamEvents: Stream.empty,
});

export interface AtlasDriverDeps {
  readonly fetch?: FetchLike;
}

/** Build the Atlas driver. `deps.fetch` exists so a test can stand the driver up without a node. */
export const makeAtlasDriver = (deps?: AtlasDriverDeps): ProviderDriver<AtlasSettings, never> => ({
  driverKind: ATLAS_DRIVER_KIND,
  metadata: {
    displayName: "Atlas",
    // One instance per node URL is the natural unit, and two instances pointed at the same
    // node are two lenses on one authority — which Atlas already supports.
    supportsMultipleInstances: true,
  },
  configSchema: AtlasSettings,
  defaultConfig: (): AtlasSettings => decodeAtlasSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const baseUrl = normalizeBaseUrl(config.baseUrl);
      const fetchImpl =
        deps?.fetch ??
        ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
      const probe = yield* probeAtlasHost({
        baseUrl,
        accessToken: config.accessToken,
        fetch: fetchImpl,
      });
      const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: ATLAS_DRIVER_KIND,
        instanceId,
      });

      const serverProvider: ServerProvider = {
        ...buildServerProvider({
          driver: ATLAS_DRIVER_KIND,
          presentation: { displayName: displayName ?? "Atlas", showInteractionModeToggle: false },
          enabled,
          checkedAt,
          // Deliberately empty until the host's catalog is the source (`/_models`). A
          // hardcoded list here would be the hand-copied contract this seam exists to end,
          // and would offer models this node may not be able to run.
          models: [],
          probe,
        }),
        instanceId,
        driver: ATLAS_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      };

      const snapshot: ServerProviderShape = {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: ATLAS_DRIVER_KIND,
          packageName: null,
        }),
        getSnapshot: Effect.succeed(serverProvider),
        refresh: Effect.succeed(serverProvider),
        streamChanges: Stream.empty,
      };

      return {
        instanceId,
        driverKind: ATLAS_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: makeUnimplementedAtlasAdapter(),
        // Deterministic local generation, with no `deps`: commit messages and thread titles
        // come from the local fallback rather than a model call this driver cannot yet make.
        textGeneration: makeAgentSdkTextGeneration(),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: ATLAS_DRIVER_KIND,
            instanceId,
            detail: `Failed to build the Atlas provider snapshot: ${describe(cause)}`,
            cause,
          }),
      ),
    ),
});

export const AtlasDriver = makeAtlasDriver();
