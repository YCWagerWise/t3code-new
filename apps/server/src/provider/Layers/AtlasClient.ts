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
  tools: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
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
  vitals: Schema.optional(AtlasVitals),
  manifest: Schema.optional(AtlasNodeManifest),
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
  /** False ⇒ cannot drive a tool-enabled plugin. */
  readonly supportsTools: boolean;
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
 * `claude` and `codex` are included per `build_backend_named`'s routing rules
 * (`claude*` → Claude CLI, `codex`/`gpt*`/`o<n>` → Codex CLI). Whether those
 * CLIs are installed is a property of the node, not of this list — an absent
 * CLI surfaces as a run-time error the same way a bad Ollama tag does.
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

  return [
    {
      id: "claude",
      label: "Claude",
      source: "claude",
      supportsTools: true,
      loaded: true,
      detail: "Claude CLI login",
    },
    {
      id: "codex",
      label: "Codex",
      source: "codex",
      supportsTools: true,
      loaded: true,
      detail: "Codex CLI login",
    },
    ...ollamaOptions,
  ];
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
