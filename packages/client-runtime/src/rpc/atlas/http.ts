/**
 * The Atlas HTTP half of the transport spine (doc 14 §6): handshake, paged feed replay,
 * checkpoint diffs, console commands, and the fleet catalog. Every response decodes
 * through the generated contract (`@t3tools/contracts/atlas`); every non-2xx surfaces the
 * node's `StructuredError` when one was sent, so a refusal reaches the caller typed
 * (`cursor_epoch_invalid`, `permission_denied`, …) rather than as a status number.
 */

import {
  CommandEnvelope,
  FeedFrame,
  RunSnapshot,
  ServerReady,
  StructuredError,
} from "@t3tools/contracts/atlas";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

export class AtlasHttpError extends Data.TaggedError("AtlasHttpError")<{
  readonly operation: string;
  readonly message: string;
  readonly status?: number | undefined;
  /** The node's typed refusal, when it sent one. */
  readonly structured?: StructuredError | undefined;
}> {}

const decodeServerReady = Schema.decodeUnknownEffect(ServerReady);
const decodeStructuredError = Schema.decodeUnknownEffect(StructuredError);
const decodeRunSnapshot = Schema.decodeUnknownEffect(RunSnapshot);

const FeedPage = Schema.Struct({
  version: Schema.Number,
  epoch: Schema.Number,
  head: Schema.Number,
  frames: Schema.Array(FeedFrame),
  has_more: Schema.Boolean,
});
export type FeedPage = typeof FeedPage.Type;
const decodeFeedPage = Schema.decodeUnknownEffect(FeedPage);

const DiffResponse = Schema.Struct({
  unified: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
    }),
  ),
  from: Schema.Unknown,
  to: Schema.Unknown,
});
export type DiffResponse = typeof DiffResponse.Type;
const decodeDiffResponse = Schema.decodeUnknownEffect(DiffResponse);

export interface AtlasHttpTarget {
  /** `http(s)://node` — no trailing slash (the node rejects `//Agent/...`). */
  readonly baseUrl: string;
  readonly bearerToken: string | null;
}

const request = Effect.fn("atlasHttp.request")(function* (
  target: AtlasHttpTarget,
  operation: string,
  path: string,
  init?: { readonly method?: "POST"; readonly body?: unknown },
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${target.baseUrl.replace(/\/+$/, "")}${path}`;
  let req =
    init?.method === "POST"
      ? HttpClientRequest.post(url, {
          body: HttpBody.jsonUnsafe(init.body),
        })
      : HttpClientRequest.get(url);
  if (target.bearerToken !== null && target.bearerToken !== "") {
    req = req.pipe(HttpClientRequest.bearerToken(target.bearerToken));
  }
  const response = yield* client.execute(req).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation,
          message: `the node could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    ),
  );
  const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));

  if (response.status < 200 || response.status >= 300) {
    // Prefer the node's own account of the refusal over our paraphrase of the status.
    const structured =
      json === undefined
        ? undefined
        : yield* decodeStructuredError(json).pipe(Effect.orElseSucceed(() => undefined));
    return yield* Effect.fail(
      new AtlasHttpError({
        operation,
        status: response.status,
        structured,
        message:
          structured?.message ?? `the node returned HTTP ${response.status} for ${operation}`,
      }),
    );
  }
  if (json === undefined) {
    return yield* Effect.fail(
      new AtlasHttpError({ operation, message: "the node returned non-JSON success" }),
    );
  }
  return json as unknown;
});

/** `GET /console/v1/handshake` — the authenticated identity/capability exchange. */
export const handshake = Effect.fn("atlasHttp.handshake")(function* (target: AtlasHttpTarget) {
  const json = yield* request(target, "handshake", "/console/v1/handshake");
  return yield* decodeServerReady(json).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation: "handshake",
          message: `handshake shape not recognised: ${String(cause)}`,
        }),
    ),
  );
});

/** `GET /console/v1/threads/{id}/feed` — one page of durable frames. */
export const feedPage = Effect.fn("atlasHttp.feedPage")(function* (
  target: AtlasHttpTarget,
  threadId: string,
  options?: {
    readonly after?: number;
    readonly epoch?: number;
    readonly limit?: number;
    readonly role?: string;
  },
) {
  const params = new URLSearchParams();
  // The pair rule again: after without epoch is a first fetch, not a resume.
  if (options?.after !== undefined && options.epoch !== undefined) {
    params.set("after", String(options.after));
    params.set("epoch", String(options.epoch));
  }
  if (options?.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options?.role !== undefined) {
    params.set("role", options.role);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const json = yield* request(
    target,
    "feedPage",
    `/console/v1/threads/${encodeURIComponent(threadId)}/feed${suffix}`,
  );
  return yield* decodeFeedPage(json).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation: "feedPage",
          message: `feed page shape not recognised: ${String(cause)}`,
        }),
    ),
  );
});

/** `GET /console/v1/threads/{id}/diff` — checkpoint-keyed; bare = full thread. */
export const threadDiff = Effect.fn("atlasHttp.threadDiff")(function* (
  target: AtlasHttpTarget,
  threadId: string,
  options?: { readonly from?: number; readonly to?: number },
) {
  const params = new URLSearchParams();
  if (options?.from !== undefined) {
    params.set("from", String(options.from));
  }
  if (options?.to !== undefined) {
    params.set("to", String(options.to));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const json = yield* request(
    target,
    "threadDiff",
    `/console/v1/threads/${encodeURIComponent(threadId)}/diff${suffix}`,
  );
  return yield* decodeDiffResponse(json).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation: "threadDiff",
          message: `diff shape not recognised: ${String(cause)}`,
        }),
    ),
  );
});

/** `GET /console/v1/threads/{id}` — the supervisor's authoritative run snapshot. */
export const runSnapshot = Effect.fn("atlasHttp.runSnapshot")(function* (
  target: AtlasHttpTarget,
  threadId: string,
) {
  const json = yield* request(
    target,
    "runSnapshot",
    `/console/v1/threads/${encodeURIComponent(threadId)}`,
  );
  const wrapped = json as { run?: unknown };
  return yield* decodeRunSnapshot(wrapped.run ?? json).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation: "runSnapshot",
          message: `run snapshot shape not recognised: ${String(cause)}`,
        }),
    ),
  );
});

/** `POST /console/v1/threads/{id}/commands` — idempotent by `request_id`; a retry MUST
 * reuse the envelope, which is why the caller builds it and this function only carries. */
export const postCommand = Effect.fn("atlasHttp.postCommand")(function* (
  target: AtlasHttpTarget,
  envelope: CommandEnvelope,
) {
  const json = yield* request(
    target,
    "postCommand",
    `/console/v1/threads/${encodeURIComponent(envelope.thread_id)}/commands`,
    { method: "POST", body: envelope },
  );
  const wrapped = json as { run?: unknown };
  return yield* decodeRunSnapshot(wrapped.run ?? json).pipe(
    Effect.mapError(
      (cause) =>
        new AtlasHttpError({
          operation: "postCommand",
          message: `command receipt shape not recognised: ${String(cause)}`,
        }),
    ),
  );
});

/** `GET /_members` — fleet catalog: node manifests, models, vitals. Discovery only;
 * never an execution boundary (donor: AtlasClient.ts:328-333). */
export const members = Effect.fn("atlasHttp.members")(function* (target: AtlasHttpTarget) {
  return yield* request(target, "members", "/_members");
});
