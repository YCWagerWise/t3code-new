/**
 * AtlasClient — the HTTP seam onto an Atlas node's Agent durable object.
 *
 * Every other provider in this codebase spawns a local CLI and speaks JSON-RPC
 * over stdio. Atlas does not: it is a networked ring of nodes, and a lens
 * reaches it over HTTP. That difference is the whole reason this module exists
 * instead of another `AcpSessionRuntime` consumer — `AcpSessionRuntime`
 * hard-requires a `ChildProcessSpawner`, so routing Atlas through ACP would
 * mean spawning a local proxy purely to relay HTTP. That is a shim over the
 * real seam, so we talk to the body directly.
 *
 * Route shape, verified against a live node:
 *
 * ```
 * POST {baseUrl}/Agent/{runId}/run   {"task": "...", "plugin": "coder"}
 *   -> 200, the agent's answer as the plain-text body
 * ```
 *
 * `/run` is documented in `atlas-host/src/lib.rs` as an "rpc-style one-shot:
 * seed, DRIVE THE RUN TO COMPLETION INLINE, and RETURN the answer in this one
 * call — no caller poll." So a turn is exactly one request; there is no
 * separate poll loop for the common case.
 *
 * `runId` addresses a durable isolate. Reusing an id continues that isolate's
 * transcript, which is what makes a thread resumable — but a *concurrent*
 * reuse desyncs it, so callers must pass a unique id per run unless they
 * intend continuation.
 *
 * @module provider/Layers/AtlasClient
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

/**
 * Failure talking to an Atlas node. Tagged so it stays distinguishable from
 * other failures in the Effect error channel rather than merging into a bare
 * `Error`.
 */
export class AtlasClientError extends Schema.TaggedErrorClass<AtlasClientError>()(
  "AtlasClientError",
  {
    baseUrl: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Atlas ${this.operation} failed for node '${this.baseUrl}': ${this.detail}`;
  }
}

/**
 * One member of the Atlas gossip ring, as reported by `/_members`.
 *
 * This is *knowledge about a node* — it belongs to the body, and the lens only
 * renders it. It is what lets the Providers page list the fleet rather than
 * probing this machine's PATH.
 */
/**
 * One Ollama model as the node reports it.
 *
 * `tools` is the field that keeps a model picker honest: a model with
 * `tools: false` cannot drive a tool-enabled plugin, and `family` identifies
 * embedding-only models (e.g. `nomic-bert`) that must never be offered as a
 * chat model at all. Both are computed body-side; the lens only filters.
 */
export const AtlasOllamaModel = Schema.Struct({
  name: Schema.String,
  family: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  params: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  quant: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  size: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /**
   * Three-valued on purpose: `true` / `false` / absent.
   *
   * The node resolves this from a real `/api/show` probe on every vitals beat, so a
   * current node always sends it. A node too old to probe omits it, and that MUST NOT
   * decode to `false` — the value now reaches the screen as a "No tools" badge, and a
   * default would libel every model on an old node. Atlas keeps the same discipline
   * body-side (`known_tool_support` returns `Option<bool>`; `build_backend_named`
   * reroutes on a KNOWN false, never on absence), and this is where that care used to
   * be thrown away on arrival.
   */
  tools: Schema.optional(Schema.Boolean),
  /**
   * Runs remotely through the node's signed-in Ollama Cloud daemon rather than
   * from local weights. Cloud models never appear in `/api/tags`, so the node
   * probes and confirms them; older nodes simply omit the field.
   */
  cloud: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AtlasOllamaModel = typeof AtlasOllamaModel.Type;

export const AtlasOllamaVitals = Schema.Struct({
  loaded: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  models: Schema.Array(AtlasOllamaModel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export const AtlasVitals = Schema.Struct({
  ollama: Schema.optional(AtlasOllamaVitals),
});

/**
 * Versioned, non-secret deployment description advertised by newer Atlas
 * nodes. It is optional because a fleet can contain old and new binaries
 * during a rolling upgrade.
 */
export const AtlasBodyManifest = Schema.Struct({
  id: Schema.String,
  tools: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AtlasBodyManifest = typeof AtlasBodyManifest.Type;

export const AtlasMachineManifest = Schema.Struct({
  label: Schema.String,
  hostname: Schema.String,
  os: Schema.String,
  arch: Schema.String,
  roles: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export const AtlasRuntimeManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

export const AtlasExecutionManifest = Schema.Struct({
  default_body: Schema.NullOr(Schema.String),
  default_model: Schema.NullOr(Schema.String),
  backend: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
});

export const AtlasNodeManifest = Schema.Struct({
  schema_version: Schema.Number,
  machine: AtlasMachineManifest,
  runtime: AtlasRuntimeManifest,
  bodies: Schema.Array(AtlasBodyManifest).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  execution: AtlasExecutionManifest,
});
export type AtlasNodeManifest = typeof AtlasNodeManifest.Type;

export const AtlasMember = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  tools: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  age_ms: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  // NullOr *and* optional. A node omits these for itself when it has nothing to
  // report, but sends an explicit `null` for any PEER whose gossip beat carried
  // none — which is every node running a build older than the manifest work. A
  // mixed-version fleet therefore yields `null` here, and `Schema.optional`
  // alone rejects it, failing the decode of the ENTIRE member list over one
  // stale peer. That takes the whole provider offline: no models, no picker
  // entry, `installed: false`.
  vitals: Schema.optional(Schema.NullOr(AtlasVitals)),
  manifest: Schema.optional(Schema.NullOr(AtlasNodeManifest)),
});
export type AtlasMember = typeof AtlasMember.Type;

/**
 * Families that only produce embeddings. Offering one as a chat model yields
 * garbage, so they are excluded from the picker outright rather than shown and
 * left to fail at run time.
 */
const EMBEDDING_FAMILIES = new Set(["nomic-bert", "bert"]);

/**
 * A model this node can actually run, as offered to the user.
 *
 * `source` distinguishes a CLI-backed model (Claude / Codex, routed by
 * `build_backend_named` on the id prefix) from a local Ollama model.
 */
export interface AtlasModelOption {
  readonly id: string;
  readonly label: string;
  readonly source: "claude" | "codex" | "ollama" | "ollama-cloud";
  /** `false` ⇒ cannot drive a tool-enabled plugin. `undefined` ⇒ the node never probed. */
  readonly supportsTools: boolean | undefined;
  /**
   * Ready to answer without a cold start. Local Ollama models are resident in
   * memory; cloud models have no local load step at all.
   */
  readonly loaded: boolean;
  readonly detail: string;
}

/**
 * Derive the truthful model list for one node from its gossip vitals.
 *
 * Deliberately NOT a hardcoded catalogue. Atlas accepts any model string and
 * only discovers a bad one at run time — "There's an issue with the selected
 * model (…)" — so a static list would let a user pick something that does not
 * exist. Everything here comes from what the node reported.
 *
 * The CLI-backed entry is whatever the node DECLARES in
 * `manifest.execution.{default_model, backend}` — not a hardcoded `claude`/`codex`
 * pair. That pair was a lie in two directions: the id `"claude"` reached the CLI
 * verbatim as `claude --model claude`, which is not a valid model, and both were
 * offered on nodes that have neither CLI installed. A node that declares nothing
 * contributes no CLI entry, which is honest — an empty picker beats one listing
 * models that cannot run.
 */
export const modelOptionsForMember = (member: AtlasMember): ReadonlyArray<AtlasModelOption> => {
  const ollama = member.vitals?.ollama;
  const loaded = new Set(ollama?.loaded ?? []);
  const ollamaOptions = (ollama?.models ?? [])
    .filter((model) => !EMBEDDING_FAMILIES.has(model.family))
    .map((model): AtlasModelOption => {
      const detail = [model.params, model.cloud ? "cloud" : model.quant]
        .filter((part) => part !== "")
        .join(" · ");
      return {
        id: model.name,
        label: model.name,
        source: model.cloud ? "ollama-cloud" : "ollama",
        supportsTools: model.tools,
        // A cloud model has nothing to load locally, so it is never "cold".
        loaded: model.cloud ? true : loaded.has(model.name),
        detail,
      };
    });

  const execution = member.manifest?.execution;
  const declaredModel = execution?.default_model?.trim();
  // `backend` names the CLI the node routes through; absent means the Claude path,
  // which is `build_backend_named`'s own default.
  const backend = execution?.backend?.trim();
  const cliOptions: ReadonlyArray<AtlasModelOption> =
    declaredModel === undefined || declaredModel === ""
      ? []
      : [
          {
            id: declaredModel,
            label: declaredModel,
            source: backend === "codex" ? "codex" : "claude",
            supportsTools: true,
            loaded: true,
            detail: `${member.id} default${backend === undefined || backend === "" ? "" : ` · ${backend}`}`,
          },
        ];

  return [...cliOptions, ...ollamaOptions];
};

/**
 * The bodies this node can actually run, as it declares them.
 *
 * `plugin` is the one-lens-many-bodies selector, and an unknown name does not
 * fail — `resolve_plugin` silently degrades it to the node's default — so a
 * console that guesses `"coder"` would show one body while another answered.
 */
export const bodiesForMember = (member: AtlasMember): ReadonlyArray<string> =>
  (member.manifest?.bodies ?? []).map((body) => body.id);

/** The body a node runs when the caller names none. */
export const defaultBodyForMember = (member: AtlasMember): string | undefined => {
  const declared = member.manifest?.execution?.default_body?.trim();
  if (declared !== undefined && declared !== "") return declared;
  return bodiesForMember(member)[0];
};

export const AtlasMembers = Schema.Struct({
  members: Schema.Array(AtlasMember).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AtlasMembers = typeof AtlasMembers.Type;

const decodeMembers = Schema.decodeUnknownEffect(AtlasMembers);

/** Trailing slashes would produce `//Agent/...`, which the node rejects. */
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, "");

export interface AtlasRunInput {
  readonly baseUrl: string;
  readonly runId: string;
  readonly plugin: string;
  readonly task: string;
}

/**
 * Drive one Atlas run to completion and return its answer.
 *
 * Resolves with the response body verbatim. Atlas answers in plain text, not
 * JSON, so no decoding happens here — the caller decides how to render it.
 */
export const atlasRun = (
  input: AtlasRunInput,
): Effect.Effect<string, AtlasClientError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `${normalizeBaseUrl(input.baseUrl)}/Agent/${encodeURIComponent(input.runId)}/run`;
    const response = yield* client.execute(
      HttpClientRequest.post(url, {
        body: HttpBody.jsonUnsafe({ task: input.task, plugin: input.plugin }),
      }),
    );
    const text = yield* response.text;
    // Effect's HttpClient does not treat a non-2xx status as a failure, so a
    // node that 500s would otherwise surface its error body as if it were the
    // agent's answer. Check explicitly.
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new AtlasClientError({
          baseUrl: input.baseUrl,
          operation: "run",
          detail: `node returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        }),
      );
    }
    return text;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasClientError({
          baseUrl: input.baseUrl,
          operation: "run",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

/**
 * Read the live ring from a node.
 *
 * Used for the provider health check: an Atlas instance is "available" when its
 * node answers `/_members`, which also tells us what the rest of the fleet
 * looks like from there.
 */
export const atlasMembers = (
  baseUrl: string,
): Effect.Effect<ReadonlyArray<AtlasMember>, AtlasClientError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${normalizeBaseUrl(baseUrl)}/_members`);
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new AtlasClientError({
          baseUrl,
          operation: "members",
          detail: `node returned HTTP ${response.status}`,
        }),
      );
    }
    const json = yield* response.json;
    const decoded = yield* decodeMembers(json);
    return decoded.members;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasClientError({
          baseUrl,
          operation: "members",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    ),
  );

export interface AtlasFeedUrlInput {
  readonly baseUrl: string;
  readonly runId: string;
  readonly plugin: string;
  readonly token: string;
  /** Replay only events after this `seq`. Omit to replay the whole feed. */
  readonly after?: number;
  /** The epoch `after` was issued under; Atlas discards a cursor from another one. */
  readonly epoch?: number;
}

/**
 * The Console feed socket for one run.
 *
 * The token rides the query string because a browser cannot set headers on a
 * `WebSocket` — Atlas accepts it there or as a bearer header. That makes the URL
 * sensitive: it must not be logged verbatim.
 */
export const atlasFeedUrl = (input: AtlasFeedUrlInput): string => {
  const base = normalizeBaseUrl(input.baseUrl).replace(/^http/, "ws");
  const params = new URLSearchParams({
    run_id: input.runId,
    plugin: input.plugin,
    ...(input.token ? { access_token: input.token } : {}),
    // Sent together or not at all: a cursor without its epoch is unsafe to honour.
    ...(input.after !== undefined && input.epoch !== undefined
      ? { after: String(input.after), epoch: String(input.epoch) }
      : {}),
  });
  return `${base}/_feed?${params.toString()}`;
};

/**
 * Atlas-owned lifecycle projection for a run.
 *
 * This is deliberately separate from feed transport state. A connected socket
 * can be silent, while the supervisor can authoritatively declare the run
 * stalled (including the exact deadline and reason).
 */
export const AtlasRunLifecycleState = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "cancelling",
  "completed",
  "limited",
  "failed",
  "stalled",
  "cancelled",
]);
export type AtlasRunLifecycleState = typeof AtlasRunLifecycleState.Type;

export const AtlasEventCursor = Schema.Struct({
  epoch: Schema.Number,
  seq: Schema.Number,
});

export const AtlasAttemptIdentity = Schema.Struct({
  attempt_id: Schema.String,
  attempt_number: Schema.Number,
  retry_of_run_id: Schema.NullOr(Schema.String),
  resume_of_attempt_id: Schema.NullOr(Schema.String),
  resumed_from_checkpoint_id: Schema.NullOr(Schema.String),
});

export const AtlasExecutionLimits = Schema.Struct({
  max_turn_requests: Schema.NullOr(Schema.Number),
  max_tokens: Schema.NullOr(Schema.Number),
  session_budget_id: Schema.NullOr(Schema.String),
  max_tool_calls: Schema.NullOr(Schema.Number),
  max_wall_time_ms: Schema.NullOr(Schema.Number),
});

export const AtlasExecutionUsage = Schema.Struct({
  turn_requests: Schema.Number,
  tokens: Schema.Number,
  tool_calls: Schema.Number,
  wall_time_ms: Schema.Number,
});

export const AtlasTerminalOutcome = Schema.Struct({
  state: AtlasRunLifecycleState,
  reason: Schema.String,
  detail: Schema.Unknown,
  terminal_at_ms: Schema.Number,
});

export const AtlasRunChildSnapshot = Schema.Struct({
  child_run_id: Schema.String,
  parent_run_id: Schema.String,
  required: Schema.Boolean,
  settlement_policy: Schema.String,
  attempt: AtlasAttemptIdentity,
  state: AtlasRunLifecycleState,
  state_version: Schema.Number,
  lease_generation: Schema.Number,
  event_head: AtlasEventCursor,
  limits: AtlasExecutionLimits,
  usage: AtlasExecutionUsage,
  terminal: Schema.NullOr(AtlasTerminalOutcome),
  last_heartbeat_at_ms: Schema.NullOr(Schema.Number),
  last_progress_at_ms: Schema.NullOr(Schema.Number),
  last_progress_marker: Schema.NullOr(Schema.String),
  deadline_at_ms: Schema.NullOr(Schema.Number),
  resumable_checkpoint_id: Schema.NullOr(Schema.String),
});

export const AtlasRunSnapshot = Schema.Struct({
  protocol_version: Schema.Number,
  snapshot_version: Schema.Number,
  fleet_id: Schema.String,
  run_id: Schema.String,
  thread_id: Schema.String,
  attempt: AtlasAttemptIdentity,
  state: AtlasRunLifecycleState,
  state_version: Schema.Number,
  lease_generation: Schema.Number,
  last_provider_seq: Schema.Number,
  event_head: AtlasEventCursor,
  limits: AtlasExecutionLimits,
  usage: AtlasExecutionUsage,
  terminal: Schema.NullOr(AtlasTerminalOutcome),
  last_heartbeat_at_ms: Schema.NullOr(Schema.Number),
  last_progress_at_ms: Schema.NullOr(Schema.Number),
  last_progress_marker: Schema.NullOr(Schema.String),
  deadline_at_ms: Schema.NullOr(Schema.Number),
  resumable_checkpoint_id: Schema.NullOr(Schema.String),
  children: Schema.Array(AtlasRunChildSnapshot),
});
export type AtlasRunSnapshot = typeof AtlasRunSnapshot.Type;

const AtlasRunSnapshotResponse = Schema.Struct({ run: AtlasRunSnapshot });
const decodeRunSnapshot = Schema.decodeUnknownEffect(AtlasRunSnapshotResponse);

export const AtlasRunLifecycleEvent = Schema.Struct({
  epoch: Schema.Number,
  seq: Schema.Number,
  event_id: Schema.String,
  run_id: Schema.String,
  attempt_id: Schema.String,
  kind: Schema.String,
  payload_json: Schema.String,
  recorded_at: Schema.Number,
});
export type AtlasRunLifecycleEvent = typeof AtlasRunLifecycleEvent.Type;

const AtlasRunEventsResponse = Schema.Struct({
  events: Schema.Array(AtlasRunLifecycleEvent),
});
const decodeRunEvents = Schema.decodeUnknownEffect(AtlasRunEventsResponse);

export interface AtlasRunAuthorityInput {
  readonly baseUrl: string;
  /** Atlas keys one durable supervisor isolate by thread id. */
  readonly threadId: string;
  readonly token: string;
}

export const AtlasFleetHandshake = Schema.Struct({
  protocol_version: Schema.Number,
  fleet_id: Schema.String,
  authenticated_subject: Schema.String,
  granted_scopes: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  connection_id: Schema.String,
  server_time_ms: Schema.Number,
  heartbeat_interval_ms: Schema.Number,
  replay_boundaries: Schema.Array(
    Schema.Struct({
      run_id: Schema.String,
      snapshot_version: Schema.Number,
      through: AtlasEventCursor,
    }),
  ),
});
export type AtlasFleetHandshake = typeof AtlasFleetHandshake.Type;
const decodeFleetHandshake = Schema.decodeUnknownEffect(AtlasFleetHandshake);

const authorityRequest = (
  input: AtlasRunAuthorityInput,
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, AtlasClientError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      input.token === "" ? request : request.pipe(HttpClientRequest.bearerToken(input.token)),
    );
    const json = yield* response.json;
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new AtlasClientError({
          baseUrl: input.baseUrl,
          operation,
          detail: `control plane returned HTTP ${response.status}`,
        }),
      );
    }
    return json;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof AtlasClientError
        ? cause
        : new AtlasClientError({
            baseUrl: input.baseUrl,
            operation,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );

/** Authenticate against the same control boundary used for run commands. */
export const atlasFleetHandshake = (
  input: Pick<AtlasRunAuthorityInput, "baseUrl" | "token">,
): Effect.Effect<AtlasFleetHandshake, AtlasClientError, HttpClient.HttpClient> =>
  authorityRequest(
    { ...input, threadId: "" },
    "fleet handshake",
    HttpClientRequest.get(`${normalizeBaseUrl(input.baseUrl)}/console/v1/handshake`),
  ).pipe(
    Effect.flatMap(decodeFleetHandshake),
    Effect.mapError((cause) =>
      cause instanceof AtlasClientError
        ? cause
        : new AtlasClientError({
            baseUrl: input.baseUrl,
            operation: "fleet handshake",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );

/** Read the supervisor's current authoritative state. */
export const atlasRunSnapshot = (
  input: AtlasRunAuthorityInput,
): Effect.Effect<AtlasRunSnapshot, AtlasClientError, HttpClient.HttpClient> => {
  const url = `${normalizeBaseUrl(input.baseUrl)}/console/v1/threads/${encodeURIComponent(input.threadId)}`;
  return authorityRequest(input, "run snapshot", HttpClientRequest.get(url)).pipe(
    Effect.flatMap(decodeRunSnapshot),
    Effect.map((response) => response.run),
    Effect.mapError((cause) =>
      cause instanceof AtlasClientError
        ? cause
        : new AtlasClientError({
            baseUrl: input.baseUrl,
            operation: "run snapshot",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );
};

/** Replay ordered authoritative lifecycle events after a supervisor cursor. */
export const atlasRunEvents = (
  input: AtlasRunAuthorityInput & { readonly epoch?: number; readonly after?: number },
): Effect.Effect<
  ReadonlyArray<AtlasRunLifecycleEvent>,
  AtlasClientError,
  HttpClient.HttpClient
> => {
  const params = new URLSearchParams();
  if (input.epoch !== undefined) params.set("epoch", String(input.epoch));
  if (input.after !== undefined) params.set("after", String(input.after));
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const url = `${normalizeBaseUrl(input.baseUrl)}/console/v1/threads/${encodeURIComponent(input.threadId)}/events${query}`;
  return authorityRequest(input, "run events", HttpClientRequest.get(url)).pipe(
    Effect.flatMap(decodeRunEvents),
    Effect.map((response) => response.events),
    Effect.mapError((cause) =>
      cause instanceof AtlasClientError
        ? cause
        : new AtlasClientError({
            baseUrl: input.baseUrl,
            operation: "run events",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );
};

export type AtlasRunCommand =
  | {
      readonly kind: "start";
      readonly text: string;
      readonly limits: {
        readonly max_turn_requests?: number | null;
        readonly max_tokens?: number | null;
        readonly session_budget_id?: string | null;
        readonly max_tool_calls?: number | null;
        readonly max_wall_time_ms?: number | null;
      };
    }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "resolve_input";
      readonly request_ref: string;
      readonly answer: unknown;
    };

export interface AtlasRunCommandInput extends AtlasRunAuthorityInput {
  readonly fleetId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly actor?: string;
  readonly expectedLeaseGeneration?: number | null;
  readonly command: AtlasRunCommand;
}

/** Durably propose an idempotent command to the Atlas supervisor. */
export const atlasRunCommand = (
  input: AtlasRunCommandInput,
): Effect.Effect<AtlasRunSnapshot, AtlasClientError, HttpClient.HttpClient> => {
  const url = `${normalizeBaseUrl(input.baseUrl)}/console/v1/threads/${encodeURIComponent(input.threadId)}/commands`;
  const request = HttpClientRequest.post(url, {
    body: HttpBody.jsonUnsafe({
      protocol_version: 1,
      fleet_id: input.fleetId,
      thread_id: input.threadId,
      run_id: input.runId,
      request_id: input.requestId,
      actor: input.actor ?? "t3-code",
      expected_lease_generation: input.expectedLeaseGeneration ?? null,
      command: input.command,
    }),
  });
  return authorityRequest(input, "run command", request).pipe(
    Effect.flatMap(decodeRunSnapshot),
    Effect.map((response) => response.run),
    Effect.mapError((cause) =>
      cause instanceof AtlasClientError
        ? cause
        : new AtlasClientError({
            baseUrl: input.baseUrl,
            operation: "run command",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
    ),
  );
};

/** A feed connection is the authenticated execution boundary, unlike `/_members`. */
export interface AtlasFeedReadinessInput {
  readonly baseUrl: string;
  readonly plugin: string;
  readonly token: string;
}

const FEED_READINESS_RUN_ID = "t3-readiness";
const FEED_READINESS_TIMEOUT_MS = 5_000;

const feedErrorDetail = (data: unknown): string | undefined => {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as { readonly class?: unknown; readonly error?: unknown };
    const error = typeof parsed.error === "string" ? parsed.error.trim() : "";
    const errorClass = typeof parsed.class === "string" ? parsed.class.trim() : "";
    if (error === "") return undefined;
    return errorClass === "" ? error : `${errorClass}: ${error}`;
  } catch {
    return undefined;
  }
};

/**
 * Prove that the credential can establish the same authenticated feed required
 * to execute a turn. A successful `/_members` response is discovery only.
 *
 * The feed is read-only until a console command is sent, so opening and
 * immediately closing this synthetic run subscription has no execution side
 * effects and does not create an Atlas run.
 */
export const atlasFeedReadiness = (
  input: AtlasFeedReadinessInput,
): Effect.Effect<void, AtlasClientError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        let socket: WebSocket | undefined;
        const finish = (outcome: "ready" | "error", detail?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (outcome === "ready") {
            // Do not leave an idle readiness subscriber attached to a durable run.
            socket?.close();
            resolve();
          } else {
            reject(new Error(detail ?? "feed did not complete its authenticated handshake"));
          }
        };
        const timeout = setTimeout(
          () => finish("error", `feed handshake timed out after ${FEED_READINESS_TIMEOUT_MS}ms`),
          FEED_READINESS_TIMEOUT_MS,
        );

        try {
          socket = new WebSocket(
            atlasFeedUrl({
              baseUrl: input.baseUrl,
              runId: FEED_READINESS_RUN_ID,
              plugin: input.plugin,
              token: input.token,
            }),
          );
          // TCP/WebSocket open only proves reachability. Atlas authenticates inside
          // the upgraded connection and may reject it with an error frame
          // immediately afterwards. The first authenticated heartbeat is the
          // readiness acknowledgement.
          socket.onopen = () => {};
          socket.onmessage = (event) => {
            const detail = feedErrorDetail(event.data);
            if (detail !== undefined) {
              finish("error", detail);
              return;
            }
            if (typeof event.data !== "string") return;
            try {
              const frame = JSON.parse(event.data) as { readonly kind?: unknown };
              if (frame.kind === "hb") finish("ready");
            } catch {
              // Ignore unrelated/non-JSON frames until authenticated readiness or
              // the bounded timeout. A readiness probe never sends a command.
            }
          };
          socket.onerror = () => finish("error", "feed handshake failed");
          socket.onclose = (event) =>
            finish("error", event.reason || `feed closed with code ${event.code}`);
        } catch (cause) {
          finish("error", cause instanceof Error ? cause.message : String(cause));
        }
      }),
    catch: (cause) =>
      new AtlasClientError({
        baseUrl: input.baseUrl,
        operation: "feed readiness",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
