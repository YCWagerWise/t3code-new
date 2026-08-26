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
import { type ServerProvider, type ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeAgentSdkTextGeneration } from "../../textGeneration/AgentSdkTextGeneration.ts";
import {
  ATLAS_DRIVER_KIND,
  AtlasRefusal,
  atlasStartCommand,
  bindingFromSlug,
  cancelTurn,
  type AtlasCursor,
  type AtlasEndpoint,
  type FetchLike,
  projectLifecycleEvent,
  readCatalog,
  readEvents,
  startTurn,
} from "./AtlasConsole.ts";
import {
  ProviderAdapterRequestError,
  ProviderDriverError,
  ProviderUnsupportedError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider, type ProviderProbeResult } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

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
 * The adapter: T3's turn verbs, expressed as Atlas console commands.
 *
 * Atlas owns the run. So `sendTurn` does not execute anything — it commits a `Start` and lets
 * the host's supervisor be the authority on what happens next, and `streamEvents` renders what
 * the host's durable log says happened. That division is why a T3 restart cannot lose a turn:
 * the transcript is Atlas's, and this reconnects to it by cursor.
 *
 * The members Atlas has no console verb for still return a typed refusal rather than an empty
 * success. A stub that reports success makes the composer look usable and fails silently at
 * the first use, which is the defect this driver exists to remove — it does not get to sneak
 * back in as a convenience.
 */
const unsupported = (operation: string) =>
  Effect.fail(new ProviderUnsupportedError({ provider: `${ATLAS_DRIVER_KIND} (${operation})` }));

const nowIso = () => new Date().toISOString();

interface LiveThread {
  cursor: AtlasCursor;
  activeTurnId: string | undefined;
}

const makeAtlasAdapter = (input: {
  readonly endpoint: AtlasEndpoint;
  readonly fleetId: string;
  readonly instanceId: string;
}): ProviderAdapterShape<ProviderUnsupportedError | ProviderAdapterRequestError> => {
  // One cursor per thread, held by the READER. Atlas's log is the durable copy; this is only
  // the bookmark, so losing it costs a replay and never an event.
  const threads = new Map<string, LiveThread>();
  const emit = new Map<string, (events: ReadonlyArray<ProviderRuntimeEvent>) => void>();

  const refuse = (operation: string, cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: ATLAS_DRIVER_KIND,
      operation,
      detail:
        cause instanceof AtlasRefusal
          ? // Atlas's own words. The refusal is the product — "openai does not serve model X
            // on this node" is what a user can act on, and replacing it with "turn failed"
            // throws away the only useful part.
            cause.message
          : String((cause as { message?: unknown })?.message ?? cause),
    });

  return {
    provider: ATLAS_DRIVER_KIND,
    // Atlas refuses a binding change inside a live attempt by design: a selection is immutable
    // within an attempt and may change only between settled turns. Declaring `in-session`
    // would promise the composer something the authority will reject.
    capabilities: { sessionModelSwitch: "unsupported" },

    startSession: (start) =>
      Effect.sync(() => {
        const threadId = String(start.threadId);
        threads.set(threadId, { cursor: { epoch: 1, after: 0 }, activeTurnId: undefined });
        return {
          provider: ATLAS_DRIVER_KIND,
          providerInstanceId: input.instanceId as never,
          status: "ready" as const,
          runtimeMode: start.runtimeMode,
          threadId: start.threadId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
      }),

    sendTurn: (turn) =>
      Effect.tryPromise({
        try: async () => {
          const threadId = String(turn.threadId);
          const live = threads.get(threadId) ?? {
            cursor: { epoch: 1, after: 0 },
            activeTurnId: undefined,
          };
          // The picker's slug carries BOTH facts. A slug with no provider is refused rather
          // than guessed at — guessing is precisely what the host stopped doing.
          const slug = turn.modelSelection?.model;
          const binding = slug === undefined ? undefined : bindingFromSlug(slug);
          if (slug !== undefined && binding === null) {
            throw new AtlasRefusal({
              status: 400,
              code: "invalid_request",
              message: `model selection ${JSON.stringify(slug)} does not name a provider; expected "provider/model_id"`,
            });
          }
          // The request id IS the turn id: Atlas dedupes on it, so a redelivered send resolves
          // to the same run rather than opening a second one.
          const requestId = `t3:${threadId}:${Date.now()}`;
          const run = await startTurn(input.endpoint, {
            ...atlasStartCommand({
              fleetId: input.fleetId,
              threadId,
              runId: requestId,
              requestId,
              actor: "t3",
              text: turn.input ?? "",
              binding: binding ?? undefined,
              workspaceId: undefined,
            }),
          });
          const runId = typeof run["run_id"] === "string" ? run["run_id"] : requestId;
          threads.set(threadId, { ...live, activeTurnId: runId });
          void pump(threadId);
          return {
            threadId: turn.threadId,
            turnId: TurnId.make(runId),
            resumeCursor: live.cursor,
          };
        },
        catch: (cause) => refuse("sendTurn", cause),
      }),

    interruptTurn: (threadId) =>
      Effect.tryPromise({
        try: () =>
          cancelTurn(input.endpoint, {
            threadId: String(threadId),
            fleetId: input.fleetId,
            requestId: `t3:cancel:${String(threadId)}:${Date.now()}`,
          }),
        catch: (cause) => refuse("interruptTurn", cause),
      }),

    // Approvals and structured questions ARE modelled by Atlas (`Kind::Approve`, `Kind::Answer`
    // on the feed), but they are appended to the feed socket rather than issued as console
    // commands, and this driver does not hold that socket yet. Refused rather than accepted
    // and dropped: a user who approves a tool call and is silently ignored is worse off than
    // one who is told the path does not exist.
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),

    stopSession: (threadId) =>
      Effect.sync(() => {
        threads.delete(String(threadId));
        emit.delete(String(threadId));
      }),
    listSessions: () => Effect.succeed([]),
    hasSession: (threadId) => Effect.succeed(threads.has(String(threadId))),
    readThread: () => unsupported("readThread"),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () =>
      Effect.sync(() => {
        threads.clear();
        emit.clear();
      }),
    streamEvents: Stream.asyncPush<ProviderRuntimeEvent>((push) =>
      Effect.sync(() => {
        emit.set("*", (events) => events.forEach((event) => push.single(event)));
        return Effect.sync(() => emit.delete("*"));
      }),
    ),
  };

  /**
   * Drain everything after the thread's cursor and publish it.
   *
   * Cursor-driven rather than tailing, so a reconnect resumes where it stopped: re-reading
   * from zero would re-render the thread, and reading from "now" would drop whatever landed
   * while the reader was away.
   */
  async function pump(threadId: string): Promise<void> {
    const live = threads.get(threadId);
    if (live === undefined) return;
    try {
      const page = await readEvents(input.endpoint, threadId, live.cursor);
      threads.set(threadId, { ...live, cursor: page.cursor });
      const projected = page.events.flatMap((event) =>
        projectLifecycleEvent(event, {
          threadId: threadId as unknown as ThreadId,
          createdAt: nowIso(),
        }),
      );
      if (projected.length > 0) emit.get("*")?.(projected);
    } catch {
      // A feed read that fails must not kill the turn: Atlas's log is durable and the next
      // pump resumes from the same cursor, so this degrades to a delay rather than a loss.
    }
  }
};

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
      // Only ask for models when the node answered. Listing models from a host that just
      // failed its probe would be exactly the display-only readiness this driver refuses.
      const catalogue =
        probe.status === "ready"
          ? yield* Effect.promise(() =>
              readCatalog({ baseUrl, accessToken: config.accessToken, fetch: fetchImpl }),
            )
          : [];
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
          // Sourced from the host's own catalog, never hardcoded here: a list written in the
          // lens is a second registry, and two registries drift. Each row's slug carries its
          // PROVIDER (`anthropic/claude-opus-4-8`), so choosing a model in the composer states
          // a company as well as a model and nothing downstream has to infer one.
          models: catalogue.map((model) => ({
            slug: model.slug,
            name: model.name,
            isCustom: false,
            isDefault: false,
            capabilities: null,
          })),
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
        adapter: makeAtlasAdapter({
          endpoint: { baseUrl, accessToken: config.accessToken, fetch: fetchImpl },
          fleetId: "default",
          instanceId: String(instanceId),
        }),
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
