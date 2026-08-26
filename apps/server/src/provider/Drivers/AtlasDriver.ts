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
import * as Queue from "effect/Queue";
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
  type AtlasFeedCursor,
  type AtlasLifecycleEvent,
  type FetchLike,
  fingerprint,
  parseAtlasCursor,
  projectFeedFrame,
  projectLifecycleEvent,
  readCatalog,
  readEvents,
  readFeed,
  resolveInput,
  startTurn,
  turnRequestId,
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
  /** Position in the FRAME feed — a different log with its own epoch space. */
  feedCursor: AtlasFeedCursor;
  activeTurnId: string | undefined;
  /**
   * The id the in-flight send was committed under, kept so a retry of the SAME logical send
   * reuses it. Cleared when the turn settles, so the next turn gets its own identity.
   */
  pendingRequestId: string | undefined;
  /** The last `request_ref` Atlas asked about, so a decision can name what it answers. */
  awaitingRef: string | undefined;
}

/** How long a reader waits after an empty page before asking again. */
const IDLE_POLL_MS = 400;
/** First retry delay after a failed read, doubled per consecutive failure. */
const RETRY_FLOOR_MS = 250;
/** Ceiling on that doubling: a node that is down must not be hammered, nor abandoned. */
const RETRY_CEILING_MS = 10_000;

/**
 * A sleep that a wake-up can cut short.
 *
 * The reader spends nearly all its life parked here. Without `wake` a send would have to wait
 * out a full idle interval before its own events were read, which is the "single delayed poll"
 * shape this design is required not to have; with it, a send returns as soon as Atlas has
 * something to say.
 */
const makeGate = (sleep: (ms: number) => Promise<void>) => {
  let release: (() => void) | undefined;
  let pending = false;
  return {
    wake: () => {
      pending = true;
      release?.();
      release = undefined;
    },
    wait: async (ms: number): Promise<void> => {
      if (pending) {
        pending = false;
        return;
      }
      await Promise.race([
        sleep(ms),
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      ]);
      pending = false;
      release = undefined;
    },
  };
};

export interface AtlasAdapterInput {
  readonly endpoint: AtlasEndpoint;
  readonly fleetId: string;
  readonly instanceId: string;
  /** Injectable so a test drives the reader deterministically instead of waiting on wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly idlePollMs?: number;
}

export const makeAtlasAdapter = (
  input: AtlasAdapterInput,
): ProviderAdapterShape<ProviderUnsupportedError | ProviderAdapterRequestError> => {
  // One cursor per thread, held by the READER. Atlas's log is the durable copy; this is only
  // the bookmark, so losing it costs a replay and never an event.
  const threads = new Map<string, LiveThread>();
  const emit = new Map<string, (events: ReadonlyArray<ProviderRuntimeEvent>) => void>();
  // Events the reader projected before anything was listening. The cursor has already advanced
  // past them, so dropping them would be a real loss rather than a replay — `ProviderService`
  // subscribes once for the adapter's lifetime, but a reader started before that subscription
  // must not have its first events fall on the floor. Bounded, because an adapter nobody ever
  // subscribes to must not grow without limit.
  let pending: Array<ProviderRuntimeEvent> = [];
  const PENDING_LIMIT = 1_000;

  const publish = (events: ReadonlyArray<ProviderRuntimeEvent>): void => {
    const sink = emit.get("*");
    if (sink === undefined) {
      pending = [...pending, ...events].slice(-PENDING_LIMIT);
      return;
    }
    sink(events);
  };
  const readers = new Map<string, { stop: () => void; wake: () => void }>();
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const idlePollMs = input.idlePollMs ?? IDLE_POLL_MS;

  const refuse = (operation: string, cause: unknown) =>
    new ProviderAdapterRequestError({
      provider: ATLAS_DRIVER_KIND,
      // The schema's field is `method`, and it is REQUIRED. This passed `operation`, so
      // constructing the error threw `Missing key at ["method"]` and the refusal never
      // reached the user at all — every failure path in this adapter raised a schema defect
      // instead of Atlas's sentence.
      method: operation,
      detail:
        cause instanceof AtlasRefusal
          ? // Atlas's own words. The refusal is the product — "openai does not serve model X
            // on this node" is what a user can act on, and replacing it with "turn failed"
            // throws away the only useful part.
            cause.message
          : String((cause as { message?: unknown })?.message ?? cause),
    });

  /**
   * Drive one thread's feed until the session stops.
   *
   * This is a LOOP, not a poll: it drains greedily while Atlas has events, parks on the gate
   * when it does not, and backs off on failure without moving the cursor — so a node that
   * blips costs a delay rather than a hole in the transcript. Events that arrive long after
   * the send that caused them (a tool call, a completion, an approval request) are delivered
   * because something is still reading, which is exactly what a single fire-and-forget read
   * after `sendTurn` could never do.
   */
  const startReader = (threadId: string): void => {
    if (readers.has(threadId)) return;
    let stopped = false;
    const gate = makeGate(sleep);
    readers.set(threadId, {
      stop: () => {
        stopped = true;
        gate.wake();
      },
      wake: gate.wake,
    });
    void (async () => {
      let backoff = 0;
      while (!stopped) {
        const live = threads.get(threadId);
        if (live === undefined) break;
        try {
          // Two logs, read together. The lifecycle log carries the turn's BOUNDARIES and the
          // frame feed carries what it SAID — a reader that takes only the first renders a
          // turn that starts and completes with nothing in between.
          const page = await readEvents(input.endpoint, threadId, live.cursor);
          const frames = await readFeed(input.endpoint, threadId, live.feedCursor);
          backoff = 0;
          const current = threads.get(threadId);
          if (current === undefined) break;
          threads.set(threadId, { ...current, cursor: page.cursor, feedCursor: frames.cursor });
          if (page.events.length > 0) observe(threadId, page.events);
          const projected = [
            ...page.events.flatMap((event) =>
              projectLifecycleEvent(event, {
                threadId: threadId as unknown as ThreadId,
                createdAt: nowIso(),
              }),
            ),
            ...frames.frames.flatMap((frame) =>
              projectFeedFrame(frame, {
                threadId: threadId as unknown as ThreadId,
                createdAt: nowIso(),
                ...(current.activeTurnId === undefined ? {} : { turnId: current.activeTurnId }),
              }),
            ),
          ];
          if (projected.length > 0) publish(projected);
          // More may already be waiting; ask again before parking.
          if (page.events.length > 0 || frames.frames.length > 0) continue;
          await gate.wait(idlePollMs);
        } catch {
          // A feed read that fails must not kill the reader: Atlas's log is durable and the
          // cursor is untouched, so the next attempt resumes at the same place. Backing off
          // rather than spinning keeps a down node from being hammered.
          backoff = backoff === 0 ? RETRY_FLOOR_MS : Math.min(backoff * 2, RETRY_CEILING_MS);
          await gate.wait(backoff);
        }
      }
      readers.delete(threadId);
    })();
  };

  /**
   * Track the facts the driver itself needs out of the log.
   *
   * `WaitingForInput` carries the `request_ref` a decision must name, and it is only ever
   * stated by the authority — so it is read off the feed rather than invented here.
   */
  const observe = (threadId: string, events: ReadonlyArray<AtlasLifecycleEvent>): void => {
    for (const event of events) {
      const live = threads.get(threadId);
      if (live === undefined) continue;
      // `kind` IS the observation kind the host wrote (`observation_kind` in
      // atlas-host/src/run_supervisor.rs), and the observation itself rides at
      // `payload.observation` — the same nesting `projectLifecycleEvent` reads a stop out of.
      const observation = event.payload["observation"] as Record<string, unknown> | undefined;
      if (event.kind === "waiting_for_input") {
        const requestRef = observation?.["request_ref"];
        // Only the authority names the ref a decision must quote; inventing one here would
        // produce a command Atlas cannot match to anything.
        if (typeof requestRef === "string") {
          threads.set(threadId, { ...live, awaitingRef: requestRef });
        }
      } else if (event.kind === "input.resolved") {
        threads.set(threadId, { ...live, awaitingRef: undefined });
      } else if (event.kind === "provider.stopped") {
        // The turn is over, so the identity that named it is spent: the next send is a new
        // turn and must not dedupe onto this one's receipt.
        threads.set(threadId, {
          ...live,
          pendingRequestId: undefined,
          activeTurnId: undefined,
          awaitingRef: undefined,
        });
      }
    }
  };

  const stopReader = (threadId: string): void => {
    readers.get(threadId)?.stop();
    readers.delete(threadId);
  };

  return {
    provider: ATLAS_DRIVER_KIND,
    // Atlas refuses a binding change inside a live attempt by design: a selection is immutable
    // within an attempt and may change only between settled turns. Declaring `in-session`
    // would promise the composer something the authority will reject.
    capabilities: { sessionModelSwitch: "unsupported" },

    startSession: (start) =>
      Effect.sync(() => {
        const threadId = String(start.threadId);
        // Resume where the last process stopped. Resetting to `{epoch:1, after:0}` here — as
        // this driver used to — threw away the persisted position on every restart and
        // re-rendered the whole thread; an unparseable blob is the only case that replays.
        // One persisted blob carries BOTH positions: `{...lifecycle, feed?}`. An older blob
        // that predates the feed reader parses as the lifecycle half and starts the frame feed
        // at its beginning, which replays content rather than skipping it.
        const persisted = start.resumeCursor as Record<string, unknown> | undefined;
        const resumed = parseAtlasCursor(persisted) ?? { epoch: 1, after: 0 };
        const resumedFeed = parseAtlasCursor(persisted?.["feed"]) ?? { epoch: 0, after: 0 };
        threads.set(threadId, {
          cursor: resumed,
          feedCursor: resumedFeed,
          activeTurnId: undefined,
          pendingRequestId: undefined,
          awaitingRef: undefined,
        });
        startReader(threadId);
        return {
          provider: ATLAS_DRIVER_KIND,
          providerInstanceId: input.instanceId as never,
          status: "ready" as const,
          runtimeMode: start.runtimeMode,
          threadId: start.threadId,
          resumeCursor: { ...resumed, feed: resumedFeed },
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
            feedCursor: { epoch: 0, after: 0 },
            activeTurnId: undefined,
            pendingRequestId: undefined,
            awaitingRef: undefined,
          };
          // A session may not have been started through this adapter instance (a recovery
          // path); the reader is what makes the feed live, so ensure one either way.
          if (!threads.has(threadId)) threads.set(threadId, live);
          startReader(threadId);
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
          const text = turn.input ?? "";
          // Stable identity, minted BEFORE the network attempt and reused if this same send is
          // retried. Atlas dedupes on it and hands back the original receipt, so a lost 202
          // costs a re-post and not a second run.
          const requestId =
            live.pendingRequestId ?? turnRequestId({ threadId, cursor: live.cursor, text });
          threads.set(threadId, { ...live, pendingRequestId: requestId });
          const run = await startTurn(input.endpoint, {
            ...atlasStartCommand({
              fleetId: input.fleetId,
              threadId,
              runId: requestId,
              requestId,
              actor: "t3",
              text,
              binding: binding ?? undefined,
              workspaceId: undefined,
            }),
          });
          const runId = typeof run["run_id"] === "string" ? run["run_id"] : requestId;
          const committed = threads.get(threadId) ?? live;
          threads.set(threadId, { ...committed, activeTurnId: runId });
          // Wake the reader rather than reading here: one owner of the cursor means a send and
          // the loop can never advance it past each other.
          readers.get(threadId)?.wake();
          return {
            threadId: turn.threadId,
            turnId: TurnId.make(runId),
            // The cursor as it stands now. `ProviderService` persists exactly this value onto
            // the session binding (`ProviderService.ts` `directory.upsert({ resumeCursor })`),
            // which is what `startSession` reads back on the next process.
            resumeCursor: {
              ...(threads.get(threadId) ?? committed).cursor,
              feed: (threads.get(threadId) ?? committed).feedCursor,
            },
          };
        },
        catch: (cause) => refuse("sendTurn", cause),
      }),

    interruptTurn: (threadId) =>
      Effect.tryPromise({
        try: () => {
          const key = String(threadId);
          const live = threads.get(key);
          return cancelTurn(input.endpoint, {
            threadId: key,
            fleetId: input.fleetId,
            // Named after the turn it cancels, not the clock: a redelivered cancel resolves to
            // the same receipt instead of committing a second one.
            requestId: `t3:cancel:${key}:${live?.activeTurnId ?? live?.pendingRequestId ?? "current"}`,
          });
        },
        catch: (cause) => refuse("interruptTurn", cause),
      }),

    /**
     * Approve or decline a tool call.
     *
     * Atlas models this as `RunCommand::ResolveInput` on the console command endpoint, so the
     * decision goes to the authority over the same seam as start and cancel. The `request_ref`
     * is the one the feed stated in `WaitingForInput`; if the run is not waiting, Atlas
     * refuses and the user is told why rather than having the click swallowed.
     */
    respondToRequest: (threadId, requestId, decision) =>
      Effect.tryPromise({
        try: () => {
          const key = String(threadId);
          const requestRef = threads.get(key)?.awaitingRef ?? String(requestId);
          return resolveInput(input.endpoint, {
            threadId: key,
            fleetId: input.fleetId,
            requestId: `t3:resolve:${key}:${requestRef}:${fingerprint(String(decision))}`,
            requestRef,
            // The decision travels whole. Collapsing `acceptForSession`/`acceptAlways` into a
            // bare boolean here would throw away scope the authority is entitled to record.
            answer: { kind: "approval", decision: String(decision) },
          });
        },
        catch: (cause) => refuse("respondToRequest", cause),
      }),

    /** The same seam, carrying a structured answer instead of a decision. */
    respondToUserInput: (threadId, requestId, answers) =>
      Effect.tryPromise({
        try: () => {
          const key = String(threadId);
          const requestRef = threads.get(key)?.awaitingRef ?? String(requestId);
          return resolveInput(input.endpoint, {
            threadId: key,
            fleetId: input.fleetId,
            requestId: `t3:answer:${key}:${requestRef}:${fingerprint(JSON.stringify(answers))}`,
            requestRef,
            answer: { kind: "answer", answers },
          });
        },
        catch: (cause) => refuse("respondToUserInput", cause),
      }),

    stopSession: (threadId) =>
      Effect.sync(() => {
        stopReader(String(threadId));
        threads.delete(String(threadId));
      }),
    listSessions: () => Effect.succeed([]),
    hasSession: (threadId) => Effect.succeed(threads.has(String(threadId))),
    readThread: () => unsupported("readThread"),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () =>
      Effect.sync(() => {
        for (const threadId of [...readers.keys()]) stopReader(threadId);
        threads.clear();
        emit.clear();
        pending = [];
      }),
    // `Stream.asyncPush` does not exist in this Effect (4.0.0-beta) — the call threw
    // `asyncPush is not a function` while BUILDING the adapter object, so every Atlas session
    // died at construction. No test had ever stood the adapter up, so the whole driver was
    // dead on a path that typechecked. `Stream.callback` is the constructor this version
    // ships, and it is what `AgentSdkAdapter` reaches for the pub/sub equivalent of.
    streamEvents: Stream.callback<ProviderRuntimeEvent>((queue) =>
      Effect.sync(() => {
        emit.set("*", (events) => {
          for (const event of events) Queue.offerUnsafe(queue, event);
        });
        // Anything the reader projected before this subscription existed is delivered now,
        // in order, rather than lost behind an already-advanced cursor.
        if (pending.length > 0) {
          const buffered = pending;
          pending = [];
          for (const event of buffered) Queue.offerUnsafe(queue, event);
        }
        return Effect.sync(() => emit.delete("*"));
      }),
    ),
  };
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
