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
