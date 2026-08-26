/**
 * AtlasConsole — the wire to a running atlas-host, and the projection of what it says.
 *
 * Atlas is the authority: it owns the run, the attempt, the transcript and the provider
 * binding. This module does not decide anything about a turn — it states intent on
 * `/console/v1/threads/{id}/commands` and projects `lifecycle_event`s into the
 * `ProviderRuntimeEvent`s T3 renders.
 *
 * # Why the projection is a pure function
 *
 * `projectLifecycleEvent` takes a decoded Atlas event and returns T3 events. No fetch, no
 * clock, no cursor state. That makes the interesting half — what an Atlas run state MEANS to
 * a lens — testable against captured bytes, and keeps the transport a thin thing that can be
 * driven by a stub in a test.
 *
 * # The cursor belongs to the reader
 *
 * Atlas's `lifecycle_event` is an ordered log keyed by `(epoch, seq)`, served at
 * `/events?epoch&after`. Replay is therefore a matter of remembering `seq` and asking again —
 * so a reconnect resumes exactly where it stopped instead of re-rendering a thread or
 * silently dropping the events that arrived while the socket was down. `epoch` is not a
 * refinement of `seq`: a bump means a new stream, not a gap in this one.
 *
 * @module provider/Drivers/AtlasConsole
 */
import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { EventId, ProviderDriverKind, TurnId } from "@t3tools/contracts";

export const ATLAS_DRIVER_KIND = ProviderDriverKind.make("atlas");

/** The subset of `fetch` this module uses, so a test supplies one without a network. */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

export interface AtlasEndpoint {
  readonly baseUrl: string;
  readonly accessToken: string | undefined;
  readonly fetch: FetchLike;
}

/** A provider and a model, kept apart — the shape Atlas persists and refuses against. */
export interface AtlasBinding {
  readonly provider: string;
  readonly model_id: string;
  readonly credential_ref?: string;
  readonly node_constraint?: string;
  readonly required_capabilities?: ReadonlyArray<string>;
}

/**
 * Atlas refused, and said why.
 *
 * Carried as its own shape rather than a generic failure because the message is the product:
 * "openai does not serve model X on this node" and "provider Y is not one this node can route"
 * send a user to different places, and flattening them into "turn failed" throws away the only
 * part they can act on.
 */
export class AtlasRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(input: { status: number; code: string; message: string }) {
    super(input.message);
    this.name = "AtlasRefusal";
    this.code = input.code;
    this.status = input.status;
  }
}

const headers = (endpoint: AtlasEndpoint): Record<string, string> => ({
  "Content-Type": "application/json",
  ...(endpoint.accessToken ? { Authorization: `Bearer ${endpoint.accessToken}` } : {}),
});

const parse = (body: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The `RunCommand::Start` envelope, as a pure value.
 *
 * Exported so a test asserts the exact bytes that reach the host rather than asserting a 202
 * came back. `binding` is omitted entirely when nothing is selected — Atlas treats an absent
 * binding as the node default and refuses a malformed one, so sending an empty object would
 * turn "no preference" into a refusal.
 */
export const atlasStartCommand = (input: {
  readonly fleetId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly actor: string;
  readonly text: string;
  readonly binding: AtlasBinding | undefined;
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
    ...(input.binding === undefined ? {} : { binding: input.binding }),
    ...(input.workspaceId === undefined ? {} : { workspace_id: input.workspaceId }),
  },
});

/** Commit a turn on the thread. Returns the snapshot Atlas recorded. */
export const startTurn = async (
  endpoint: AtlasEndpoint,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const threadId = String(command["thread_id"]);
  const response = await endpoint.fetch(
    `${endpoint.baseUrl}/console/v1/threads/${encodeURIComponent(threadId)}/commands`,
    { method: "POST", headers: headers(endpoint), body: JSON.stringify(command) },
  );
  const body = await response.text();
  const parsed = parse(body);
  if (response.status < 200 || response.status >= 300) {
    // Atlas answers a refusal as a StructuredError with a message written for a human. Pass it
    // through verbatim: rewriting it here would replace the authority's reason with the lens's
    // guess at one.
    throw new AtlasRefusal({
      status: response.status,
      code: typeof parsed?.["code"] === "string" ? (parsed["code"] as string) : "unknown",
      message:
        typeof parsed?.["message"] === "string"
          ? (parsed["message"] as string)
          : `atlas-host answered ${response.status}`,
    });
  }
  const run = parsed?.["run"];
  if (typeof run !== "object" || run === null) {
    throw new AtlasRefusal({
      status: response.status,
      code: "invalid_response",
      message: "atlas-host accepted the command but returned no run snapshot",
    });
  }
  return run as Record<string, unknown>;
};

/** Ask the thread's supervisor to stop the live attempt. */
export const cancelTurn = async (
  endpoint: AtlasEndpoint,
  input: { readonly threadId: string; readonly fleetId: string; readonly requestId: string },
): Promise<void> => {
  const response = await endpoint.fetch(
    `${endpoint.baseUrl}/console/v1/threads/${encodeURIComponent(input.threadId)}/commands`,
    {
      method: "POST",
      headers: headers(endpoint),
      body: JSON.stringify({
        protocol_version: 1,
        fleet_id: input.fleetId,
        thread_id: input.threadId,
        run_id: input.threadId,
        request_id: input.requestId,
        actor: "t3",
        command: { kind: "cancel" },
      }),
    },
  );
  if (response.status < 200 || response.status >= 300) {
    const parsed = parse(await response.text());
    throw new AtlasRefusal({
      status: response.status,
      code: typeof parsed?.["code"] === "string" ? (parsed["code"] as string) : "unknown",
      message:
        typeof parsed?.["message"] === "string"
          ? (parsed["message"] as string)
          : `cancel answered ${response.status}`,
    });
  }
};

/** Where a reader is in a thread's log. `seq` advances; a new `epoch` is a new stream. */
export interface AtlasCursor {
  readonly epoch: number;
  readonly after: number;
}

export interface AtlasEventPage {
  readonly events: ReadonlyArray<AtlasLifecycleEvent>;
  readonly cursor: AtlasCursor;
}

export interface AtlasLifecycleEvent {
  readonly epoch: number;
  readonly seq: number;
  readonly event_id: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Read everything after `cursor`.
 *
 * The returned cursor is advanced past what was read, so a caller loops on it and a reconnect
 * hands back the same value it stopped at. An empty page leaves the cursor untouched rather
 * than resetting it — the failure that would re-deliver a whole thread on every idle poll.
 */
export const readEvents = async (
  endpoint: AtlasEndpoint,
  threadId: string,
  cursor: AtlasCursor,
): Promise<AtlasEventPage> => {
  const url = `${endpoint.baseUrl}/console/v1/threads/${encodeURIComponent(threadId)}/events?epoch=${cursor.epoch}&after=${cursor.after}`;
  const response = await endpoint.fetch(url, { method: "GET", headers: headers(endpoint) });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new AtlasRefusal({
      status: response.status,
      code: "events_unavailable",
      message: `events answered ${response.status}`,
    });
  }
  const parsed = parse(body);
  const raw = Array.isArray(parsed?.["events"]) ? (parsed["events"] as unknown[]) : [];
  const events = raw.flatMap((entry) => {
    const decoded = decodeLifecycleEvent(entry);
    return decoded === null ? [] : [decoded];
  });
  const highest = events.reduce((max, event) => (event.seq > max ? event.seq : max), cursor.after);
  return { events, cursor: { epoch: cursor.epoch, after: highest } };
};

/**
 * One row of `lifecycle_event`, or `null` if it is not one.
 *
 * `payload_json` arrives as a STRING because that is the column's type; a reader that forgets
 * to parse it gets an object-shaped nothing and renders an empty turn.
 */
export const decodeLifecycleEvent = (entry: unknown): AtlasLifecycleEvent | null => {
  if (typeof entry !== "object" || entry === null) return null;
  const row = entry as Record<string, unknown>;
  const seq = row["seq"];
  const kind = row["kind"];
  if (typeof seq !== "number" || typeof kind !== "string") return null;
  const rawPayload = row["payload_json"] ?? row["payload"];
  const payload =
    typeof rawPayload === "string"
      ? (parse(rawPayload) ?? {})
      : typeof rawPayload === "object" && rawPayload !== null
        ? (rawPayload as Record<string, unknown>)
        : {};
  return {
    epoch: typeof row["epoch"] === "number" ? (row["epoch"] as number) : 1,
    seq,
    event_id: typeof row["event_id"] === "string" ? (row["event_id"] as string) : `seq-${seq}`,
    run_id: typeof row["run_id"] === "string" ? (row["run_id"] as string) : "",
    attempt_id: typeof row["attempt_id"] === "string" ? (row["attempt_id"] as string) : "",
    kind,
    payload,
  };
};

/**
 * Atlas provider-stop outcomes, and what each means in T3's turn vocabulary.
 *
 * Taken from the `observation.stop.outcome` an atlas-host actually emits, not from the run
 * states I first assumed: `lifecycle_event` rows carry the ENVELOPE that caused them (a
 * command, an observation), never a rendered run state. Getting that wrong produced a
 * projection that silently emitted nothing against a live node while passing against
 * hand-written fixtures — which is why the fixtures are now captured bytes.
 */
const STOP_OUTCOMES: Record<string, "completed" | "failed" | "cancelled" | "interrupted"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  // The supervisor gave up waiting; the turn stopped without finishing. "completed" would
  // render a half-answer as a whole one, and "failed" would blame the body for a timeout that
  // was the supervisor's.
  stalled: "interrupted",
  limited: "interrupted",
};

/**
 * Project one Atlas lifecycle event into what T3 renders.
 *
 * Returns an array because the mapping is neither one-to-one nor total: an event with no T3
 * meaning yields `[]` rather than a synthetic event, since inventing one would put a turn on
 * screen that Atlas does not believe in.
 */
export const projectLifecycleEvent = (
  event: AtlasLifecycleEvent,
  context: { readonly threadId: ThreadId; readonly createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> => {
  const base = {
    eventId: EventId.make(event.event_id),
    provider: ATLAS_DRIVER_KIND,
    threadId: context.threadId,
    createdAt: context.createdAt,
    // Atlas's run id IS the turn: one run is one user-to-agent cycle, with attempts beneath it.
    turnId: TurnId.make(event.run_id || `atlas-${event.seq}`),
  };

  if (event.kind === "command.accepted") {
    // The payload is the COMMAND ENVELOPE, so the binding lives under `command`, not at the
    // top level. Only a `start` opens a turn — a cancel is also a `command.accepted`.
    const command = event.payload["command"];
    if (typeof command !== "object" || command === null) return [];
    const record = command as Record<string, unknown>;
    if (record["kind"] !== "start") return [];
    const binding = record["binding"];
    const model =
      typeof binding === "object" && binding !== null
        ? // Provider AND model: "gpt-5.4" alone does not say who served it, which is the whole
          // reason the binding exists.
          `${(binding as Record<string, unknown>)["provider"]}/${(binding as Record<string, unknown>)["model_id"]}`
        : undefined;
    return [
      {
        ...base,
        type: "turn.started",
        payload: model === undefined ? {} : { model },
      } as ProviderRuntimeEvent,
    ];
  }

  if (event.kind === "provider.stopped") {
    const observation = event.payload["observation"];
    const stop =
      typeof observation === "object" && observation !== null
        ? (observation as Record<string, unknown>)["stop"]
        : undefined;
    if (typeof stop !== "object" || stop === null) return [];
    const outcome = (stop as Record<string, unknown>)["outcome"];
    const state = typeof outcome === "string" ? STOP_OUTCOMES[outcome] : undefined;
    if (state === undefined) return [];
    const providerCode = (stop as Record<string, unknown>)["provider_code"];
    return [
      {
        ...base,
        type: "turn.completed",
        payload: {
          state,
          ...(typeof providerCode === "string" && providerCode.length > 0
            ? { stopReason: providerCode }
            : {}),
        },
      } as ProviderRuntimeEvent,
    ];
  }

  return [];
};

// ─────────────────────── the lens's model slug ───────────────────────

/**
 * T3's `ModelSelection` carries ONE string, and Atlas needs two facts. So the slug is
 * `provider/model_id` — `anthropic/claude-opus-4-8` — and the provider travels inside it
 * rather than being re-derived at the far end.
 *
 * This is the lens-side half of the rule the host enforces: a bare model id cannot say which
 * company serves it, and the moment something has to guess, `gpt-5.4` means OpenAI on one node
 * and Ollama on another. Split on the FIRST separator only, because an ollama id legitimately
 * contains punctuation (`qwen2.5-coder:7b`) and a greedy split would corrupt it.
 */
export const bindingSlug = (binding: { provider: string; model_id: string }): string =>
  `${binding.provider}/${binding.model_id}`;

/**
 * Parse a picker slug back into a binding, or `null` if it is not one.
 *
 * `null` rather than a guess: a slug with no provider is exactly the ambiguous input this
 * design removes, and inventing a provider for it here would reintroduce the inference one
 * layer above the host that just stopped doing it.
 */
export const bindingFromSlug = (slug: string): AtlasBinding | null => {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  const provider = slug.slice(0, separator);
  const model_id = slug.slice(separator + 1);
  if (provider.trim() !== provider || model_id.trim() !== model_id) return null;
  return { provider, model_id };
};

/** One selectable model, as the composer's picker renders it. */
export interface AtlasCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly provider: string;
  readonly capabilities: ReadonlyArray<string>;
}

/**
 * Read `/_models` and flatten it into picker rows.
 *
 * Flattened for T3's list, but every row still NAMES its provider and its slug still carries
 * it — the grouping is lost, the identity is not. A provider that is unavailable contributes
 * no rows: offering a model this node has just said it cannot reach would produce a refusal at
 * send time, which is display-only readiness with extra steps.
 */
export const readCatalog = async (
  endpoint: AtlasEndpoint,
): Promise<ReadonlyArray<AtlasCatalogModel>> => {
  const response = await endpoint.fetch(`${endpoint.baseUrl}/_models`, {
    method: "GET",
    headers: headers(endpoint),
  });
  if (response.status < 200 || response.status >= 300) return [];
  const parsed = parse(await response.text());
  const providers = Array.isArray(parsed?.["providers"]) ? (parsed["providers"] as unknown[]) : [];
  return providers.flatMap((entry): ReadonlyArray<AtlasCatalogModel> => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (record["available"] !== true) return [];
    const provider = typeof record["provider"] === "string" ? record["provider"] : null;
    if (provider === null) return [];
    const models = Array.isArray(record["models"]) ? (record["models"] as unknown[]) : [];
    return models.flatMap((model): ReadonlyArray<AtlasCatalogModel> => {
      if (typeof model !== "object" || model === null) return [];
      const row = model as Record<string, unknown>;
      const modelId = typeof row["model_id"] === "string" ? row["model_id"] : null;
      if (modelId === null) return [];
      const capabilities = Array.isArray(row["capabilities"])
        ? (row["capabilities"] as unknown[]).filter(
            (capability): capability is string => typeof capability === "string",
          )
        : [];
      return [
        {
          slug: bindingSlug({ provider, model_id: modelId }),
          // The company is in the NAME the user reads, not only in the slug the code parses.
          name: `${provider} · ${modelId}`,
          provider,
          capabilities,
        },
      ];
    });
  });
};

/**
 * Read a persisted `resumeCursor` back into a cursor, or `null` if it is not one.
 *
 * T3 stores the cursor as an opaque `Schema.Unknown` blob on the session binding, so what
 * comes back on a restart is genuinely untyped and may be a value some older build wrote.
 * A shape that does not parse yields `null` and the caller starts from the beginning of the
 * epoch — a replay, which the projection is idempotent under. Guessing a cursor from a
 * partial shape would silently skip events, which is worse than replaying them.
 */
export const parseAtlasCursor = (raw: unknown): AtlasCursor | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const epoch = (raw as Record<string, unknown>)["epoch"];
  const after = (raw as Record<string, unknown>)["after"];
  // The lifecycle log counts epochs from 1; the frame feed uses 0 for "no stream read yet".
  if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch < 0) return null;
  if (typeof after !== "number" || !Number.isFinite(after) || after < 0) return null;
  return { epoch, after };
};

/**
 * FNV-1a over a string, as 8 lowercase hex digits.
 *
 * Used only to give a command a STABLE name derived from its own content. It is not a
 * security primitive and does not need to be one: the property that matters is that the same
 * logical send computes the same id on a retry, and the wall clock does not have that
 * property.
 */
export const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * The idempotency key for a turn, derived from durable state instead of the clock.
 *
 * Atlas dedupes commands on `request_id` against a durable receipt table
 * (`atlas-host/src/run_supervisor.rs`: `load_receipt(ctx.db(), &command.request_id)` marks a
 * repeat `duplicate` and returns the ORIGINAL receipt). That mechanism only works if the
 * caller sends the same id twice, and `Date.now()` guarantees it never does — a retry after a
 * lost 202 opened a second run.
 *
 * The cursor is the durable position in the thread's log, so `(epoch, after)` plus a
 * fingerprint of the turn's own content names this send and no other: a retry before any new
 * event computes an identical id and Atlas returns the first receipt, while the next real
 * turn is sent from a cursor the reader has since advanced and so gets its own id.
 */
export const turnRequestId = (input: {
  readonly threadId: string;
  readonly cursor: AtlasCursor;
  readonly text: string;
}): string =>
  `t3:${input.threadId}:${input.cursor.epoch}:${input.cursor.after}:${fingerprint(input.text)}`;

/**
 * Answer an Atlas `WaitingForInput` — the approval/answer path.
 *
 * This is a console COMMAND (`RunCommand::ResolveInput { request_ref, answer }`), on the same
 * `/commands` endpoint as start and cancel — not, as this driver previously claimed, something
 * only reachable over a feed socket. The host requires the run to be in `WaitingForInput` and
 * moves it back to `Running` (`atlas-host/src/run_supervisor.rs`), so a decision that arrives
 * for a run that is not waiting is REFUSED with Atlas's own words rather than dropped.
 */
export const resolveInput = async (
  endpoint: AtlasEndpoint,
  input: {
    readonly threadId: string;
    readonly fleetId: string;
    readonly requestId: string;
    readonly requestRef: string;
    readonly answer: unknown;
  },
): Promise<void> => {
  const response = await endpoint.fetch(
    `${endpoint.baseUrl}/console/v1/threads/${encodeURIComponent(input.threadId)}/commands`,
    {
      method: "POST",
      headers: headers(endpoint),
      body: JSON.stringify({
        protocol_version: 1,
        fleet_id: input.fleetId,
        thread_id: input.threadId,
        run_id: input.threadId,
        request_id: input.requestId,
        actor: "t3",
        command: { kind: "resolve_input", request_ref: input.requestRef, answer: input.answer },
      }),
    },
  );
  if (response.status < 200 || response.status >= 300) {
    const parsed = parse(await response.text());
    throw new AtlasRefusal({
      status: response.status,
      code: typeof parsed?.["code"] === "string" ? (parsed["code"] as string) : "unknown",
      message:
        typeof parsed?.["message"] === "string"
          ? (parsed["message"] as string)
          : `resolve_input answered ${response.status}`,
    });
  }
};

// ─────────────────────── the frame feed (what the turn SAID) ───────────────────────

/**
 * Where a reader is in a thread's FRAME feed.
 *
 * Separate from {@link AtlasCursor} because these are two different logs with two different
 * epoch spaces. The lifecycle log is the supervisor's record of what a run *did* — accepted,
 * connected, stopped — and its epoch counts from 1. The frame feed is what the turn *said*,
 * and its epoch is a wall-clock stamp minted per stream. Sharing one cursor between them would
 * mean one log's epoch silently resetting the other's position.
 */
export interface AtlasFeedCursor {
  readonly epoch: number;
  readonly after: number;
}

export interface AtlasFrame {
  readonly seq: number;
  readonly epoch: number;
  readonly kind: string;
  readonly role: string;
  readonly payload: Record<string, unknown>;
}

export interface AtlasFramePage {
  readonly frames: ReadonlyArray<AtlasFrame>;
  readonly cursor: AtlasFeedCursor;
}

const decodeFrame = (entry: unknown): AtlasFrame | null => {
  if (typeof entry !== "object" || entry === null) return null;
  const row = entry as Record<string, unknown>;
  const seq = row["seq"];
  const kind = row["kind"];
  if (typeof seq !== "number" || typeof kind !== "string") return null;
  const payload = row["payload"];
  return {
    seq,
    epoch: typeof row["epoch"] === "number" ? row["epoch"] : 0,
    kind,
    role: typeof row["role"] === "string" ? row["role"] : "",
    payload:
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {},
  };
};

/**
 * Read the thread's frames after `cursor`.
 *
 * The answer a model gave is published HERE, not on the lifecycle log — the drive's own comment
 * says it plainly: "the supervisor records that a run completed, never what it said"
 * (`atlas-host/src/lib.rs`, `publish_outcome_frames`). A driver that polls only `/events` can
 * therefore render a turn that starts and completes with nothing in between, which is exactly
 * the empty-turn failure this feed closes.
 *
 * A new `epoch` is a new stream, so the position resets to the start of it rather than being
 * carried across — an `after` from the previous epoch names a frame that is not in this one.
 */
export const readFeed = async (
  endpoint: AtlasEndpoint,
  threadId: string,
  cursor: AtlasFeedCursor,
): Promise<AtlasFramePage> => {
  const url =
    `${endpoint.baseUrl}/console/v1/threads/${encodeURIComponent(threadId)}/feed` +
    `?after=${cursor.after}${cursor.epoch > 0 ? `&epoch=${cursor.epoch}` : ""}`;
  const response = await endpoint.fetch(url, { method: "GET", headers: headers(endpoint) });
  const body = await response.text();
  if (response.status < 200 || response.status >= 300) {
    throw new AtlasRefusal({
      status: response.status,
      code: "feed_unavailable",
      message: `feed answered ${response.status}`,
    });
  }
  const parsed = parse(body);
  const epoch = typeof parsed?.["epoch"] === "number" ? (parsed["epoch"] as number) : cursor.epoch;
  const raw = Array.isArray(parsed?.["frames"]) ? (parsed["frames"] as unknown[]) : [];
  const frames = raw.flatMap((entry) => {
    const decoded = decodeFrame(entry);
    return decoded === null ? [] : [decoded];
  });
  // A stream we have not read before starts at its beginning, not at a stale offset.
  const base = epoch === cursor.epoch ? cursor.after : 0;
  const highest = frames.reduce((max, frame) => (frame.seq > max ? frame.seq : max), base);
  return { frames, cursor: { epoch, after: highest } };
};

/** Frames the console itself wrote. Echoing our own commands back as content would double them. */
const AGENT_ROLE = "agent";

/**
 * Turn one Atlas frame into T3 runtime events.
 *
 * Deliberately narrow: this projects CONTENT and REQUESTS only. Turn boundaries stay with the
 * supervisor's lifecycle log, because Atlas is explicit that a run has exactly one boundary
 * author (`run_supervisor::project_to_feed`) — projecting `turn`/`lifecycle` frames here as
 * well would make the lens a second author, and the two can disagree.
 *
 * An unrecognised kind returns nothing rather than guessing. Atlas's own note on why that
 * matters: an unknown *kind* is ignored, whereas an unknown turn *state* used to fall through
 * and render as a completed turn — closing the turn green while the agent was still working.
 */
export const projectFeedFrame = (
  frame: AtlasFrame,
  context: { readonly threadId: ThreadId; readonly createdAt: string; readonly turnId?: string },
): ReadonlyArray<ProviderRuntimeEvent> => {
  if (frame.role !== AGENT_ROLE) return [];
  const base = {
    eventId: EventId.make(`atlas-frame-${frame.epoch}-${frame.seq}`),
    provider: ATLAS_DRIVER_KIND,
    threadId: context.threadId,
    createdAt: context.createdAt,
    ...(context.turnId === undefined ? {} : { turnId: TurnId.make(context.turnId) }),
  };
  const text = typeof frame.payload["text"] === "string" ? (frame.payload["text"] as string) : "";

  const delta = (streamKind: string): ReadonlyArray<ProviderRuntimeEvent> =>
    text.length === 0
      ? []
      : [
          {
            ...base,
            type: "content.delta",
            payload: { streamKind, delta: text },
          } as ProviderRuntimeEvent,
        ];

  switch (frame.kind) {
    // The answer. This is the frame whose absence made a completed Atlas turn render empty.
    case "assistant":
      return delta("assistant_text");
    case "thinking":
      return delta("reasoning_text");
    case "tool_call": {
      const name = frame.payload["name"] ?? frame.payload["tool"];
      return [
        {
          ...base,
          type: "item.started",
          payload: {
            itemType: "tool_call",
            ...(typeof name === "string" && name.length > 0 ? { title: name } : {}),
            data: frame.payload,
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "tool_result":
      return [
        {
          ...base,
          type: "item.completed",
          payload: { itemType: "tool_call", data: frame.payload },
        } as ProviderRuntimeEvent,
      ];
    // A held tool call. `request_id` is Atlas's `{run_id}:{call_id}` and is the ONLY string an
    // approval may quote back — `await_approval` matches on it exactly and ignores anything else.
    case "approval": {
      const requestId = frame.payload["request_id"];
      if (typeof requestId !== "string") return [];
      const requestType = frame.payload["request_type"];
      return [
        {
          ...base,
          requestId,
          type: "request.opened",
          payload: {
            requestType:
              typeof requestType === "string" && requestType.length > 0
                ? requestType
                : "command_execution_approval",
            ...(typeof frame.payload["reason"] === "string"
              ? { detail: frame.payload["reason"] as string }
              : {}),
            args: frame.payload["args"],
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "error":
      return [
        {
          ...base,
          type: "runtime.error",
          payload: {
            errorClass: "provider_error",
            message:
              typeof frame.payload["message"] === "string"
                ? (frame.payload["message"] as string)
                : "atlas reported an error",
          },
        } as ProviderRuntimeEvent,
      ];
    case "warning":
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message:
              typeof frame.payload["message"] === "string"
                ? (frame.payload["message"] as string)
                : "atlas reported a warning",
          },
        } as ProviderRuntimeEvent,
      ];
    // `user` is already in T3's own transcript; `turn`/`lifecycle` belong to the supervisor;
    // `ctx`/`usage` have no T3 runtime event. All deliberately silent.
    default:
      return [];
  }
};

// ─────────────────────── the console socket (answering back) ───────────────────────

/**
 * The minimum a socket must do for this driver, so a test can supply one.
 *
 * Deliberately not `WebSocket`: the driver only ever sends text and observes open/close, and
 * depending on the whole DOM interface would make it untestable without a real server.
 */
export interface AtlasSocket {
  send(data: string): void;
  close(): void;
}

export interface AtlasSocketHandlers {
  readonly onOpen: () => void;
  readonly onClose: () => void;
}

export type AtlasSocketFactory = (url: string, handlers: AtlasSocketHandlers) => AtlasSocket;

/** `http(s)://host` → `ws(s)://host`. The socket lives on the same origin as the console API. */
export const feedSocketUrl = (endpoint: AtlasEndpoint, threadId: string): string => {
  const base = endpoint.baseUrl.replace(/^http/, "ws");
  const token =
    endpoint.accessToken === undefined
      ? ""
      : `&access_token=${encodeURIComponent(endpoint.accessToken)}`;
  // `after=-1` asks for no replay: this socket exists to SEND and to be PRESENT, and the
  // frames are already being read over HTTP. Replaying them here would double every event.
  return `${base}/_feed?run_id=${encodeURIComponent(threadId)}&after=-1${token}`;
};

/** The default factory, over the runtime's own WebSocket. */
export const browserSocketFactory: AtlasSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("close", handlers.onClose);
  socket.addEventListener("error", handlers.onClose);
  return {
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
  };
};

/**
 * A console presence on a thread's feed, held for the life of the session.
 *
 * **This is not an optimisation — a held socket is what makes approval possible at all.**
 * `await_approval` (atlas-host) refuses a gated tool outright when nobody is listening:
 *
 *     if rx.live(feed::ROLE_CONSOLE).await.unwrap_or(0) == 0 {
 *         return ToolGate::Deny(".. and no console is attached to approve it")
 *     }
 *
 * So a driver that connected only once it had a decision to send would arrive after the gate
 * had already denied the call. The socket is opened when the session opens, and reconnects on
 * drop, so the answer is possible before the question is asked.
 */
export const makeConsolePresence = (input: {
  readonly endpoint: AtlasEndpoint;
  readonly threadId: string;
  readonly connect: AtlasSocketFactory;
  /** Injectable so a test drives reconnection without waiting on wall time. */
  readonly schedule?: (run: () => void, ms: number) => void;
}) => {
  const schedule =
    input.schedule ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms);
    });
  let socket: AtlasSocket | undefined;
  let open = false;
  let closed = false;
  let attempt = 0;
  // Decisions made while the socket was down. Dropping one silently would strand the turn that
  // is waiting for it, and Atlas's gate deadline is the only other thing that would end it.
  let queued: Array<string> = [];

  const flush = (): void => {
    if (!open || socket === undefined) return;
    const pending = queued;
    queued = [];
    for (const message of pending) socket.send(message);
  };

  const dial = (): void => {
    if (closed) return;
    socket = input.connect(feedSocketUrl(input.endpoint, input.threadId), {
      onOpen: () => {
        open = true;
        attempt = 0;
        flush();
      },
      onClose: () => {
        if (closed) return;
        open = false;
        socket = undefined;
        attempt += 1;
        // Re-dial, always. A presence that gives up after one drop stops being a console, and
        // atlas-host reads "no console attached" as a reason to DENY the next gated tool — so
        // a silently dead socket turns into refused tool calls rather than a visible error.
        schedule(dial, Math.min(250 * 2 ** (attempt - 1), 10_000));
      },
    });
  };

  dial();

  return {
    /** Queue-then-send, so a decision made during a reconnect is not lost. */
    send: (kind: string, payload: Record<string, unknown>): void => {
      queued = [...queued, JSON.stringify({ kind, payload })];
      flush();
    },
    reconnect: dial,
    isOpen: () => open,
    pending: () => queued.length,
    close: (): void => {
      closed = true;
      open = false;
      socket?.close();
      socket = undefined;
    },
  };
};
export type AtlasConsolePresence = ReturnType<typeof makeConsolePresence>;

/**
 * T3's five decisions, as the one boolean Atlas's `ApprovePayload` carries.
 *
 * `acceptForSession`/`acceptAlways` collapse to `true` here because the contract has nowhere
 * to put the scope — recording that fact rather than hiding it, since a caller reading this
 * back cannot tell a one-off accept from a standing one.
 */
export const approvalIsGranted = (decision: string): boolean =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
