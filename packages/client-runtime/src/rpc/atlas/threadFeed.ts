/**
 * ThreadFeed — the run-socket substrate of the Atlas transport spine (doc 14 §4).
 *
 * One durable feed per run: opens `/_feed?run_id=…`, replays after the caller's cursor,
 * then streams live — delivering **ordered, deduped, echo-free, decoded** `FeedFrame`s
 * plus the three facts a projection needs and must not compute itself: replay caught up
 * (`replay-complete`), the feed was recreated (`reset`), the transport state changed
 * (`connection`).
 *
 * Rule zero (docs 08/12): socket loss is a connection fact, not a run fact. This stream
 * NEVER fails on transport — it reports `reconnecting` and resumes with its cursor. Its
 * one failure channel is authorization, which no amount of retrying fixes.
 *
 * Boundary detection: the server replays the stored tail first and sends its first `hb`
 * only after replay (ws.rs replays at connect, then enters the heartbeat loop) — so the
 * first `hb` of a connection IS the replay boundary, and its `epoch` is authoritative.
 */

import { FeedFrame, TransportFrame } from "@t3tools/contracts/atlas";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

export type ThreadFeedConnectionState = "connected" | "reconnecting";

export type ThreadFeedEvent =
  | { readonly kind: "frame"; readonly frame: FeedFrame }
  | { readonly kind: "replay-complete"; readonly head: number; readonly epoch: number }
  | { readonly kind: "reset"; readonly epoch: number }
  | { readonly kind: "connection"; readonly state: ThreadFeedConnectionState };

/** The stream's only failure: the node refused this caller. Retrying cannot fix it. */
export class ThreadFeedAuthError extends Data.TaggedError("ThreadFeedAuthError")<{
  readonly runId: string;
  readonly message: string;
}> {}

export interface ThreadFeedCursor {
  readonly afterSequence: number;
  readonly epoch: number;
}

export interface ThreadFeedOptions {
  /** `ws(s)://node` — derived from the connection's httpBaseUrl by the session. */
  readonly socketBaseUrl: string;
  readonly runId: string;
  /** Rides the query string (a browser WebSocket cannot set headers). The URL is a
   * secret — never log it verbatim. */
  readonly accessToken: string;
  readonly plugin?: string | undefined;
  /** Resume point. `after` and `epoch` travel together or not at all — a sequence
   * without its epoch is unsafe to honour, so an incomplete pair means full replay. */
  readonly cursor?: ThreadFeedCursor | undefined;
  readonly backoff?:
    | { readonly initialMillis: number; readonly factor: number; readonly capMillis: number }
    | undefined;
}

const DEFAULT_BACKOFF = { initialMillis: 500, factor: 1.5, capMillis: 5_000 };

const decodeFeedFrame = Schema.decodeUnknownEffect(FeedFrame);
const decodeTransportFrame = Schema.decodeUnknownEffect(TransportFrame);

const feedUrl = (
  options: ThreadFeedOptions,
  cursor: { seq: number; epoch: number | null },
): string => {
  const url = new URL(options.socketBaseUrl);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname = "/_feed";
  url.searchParams.set("run_id", options.runId);
  if (options.plugin !== undefined) {
    url.searchParams.set("plugin", options.plugin);
  }
  url.searchParams.set("access_token", options.accessToken);
  // Together or not at all: an epoch-less sequence must not be sent.
  if (cursor.epoch !== null) {
    url.searchParams.set("after", String(cursor.seq));
    url.searchParams.set("epoch", String(cursor.epoch));
  }
  return url.toString();
};

export const openThreadFeed = (
  options: ThreadFeedOptions,
): Stream.Stream<ThreadFeedEvent, ThreadFeedAuthError, Socket.WebSocketConstructor> =>
  Stream.callback<ThreadFeedEvent, ThreadFeedAuthError, Socket.WebSocketConstructor>((queue) =>
    Effect.gen(function* () {
      const makeWebSocket = yield* Socket.WebSocketConstructor;
      const backoff = options.backoff ?? DEFAULT_BACKOFF;

      // The cursor outlives every individual socket: reconnects resume from it.
      const cursor: { seq: number; epoch: number | null } = {
        seq: options.cursor?.afterSequence ?? 0,
        epoch: options.cursor?.epoch ?? null,
      };
      let attempt = 0;
      let authFailed = false;

      const offer = (event: ThreadFeedEvent) => Queue.offer(queue, event);

      /** One socket lifetime. Resolves void on transport loss (the loop reconnects) and
       * fails only on an authorization refusal. */
      const connectOnce: Effect.Effect<void, ThreadFeedAuthError> = Effect.callback<
        void,
        ThreadFeedAuthError
      >((resume) => {
        const ws = makeWebSocket(feedUrl(options, cursor));
        let settled = false;
        // Replay-boundary state is PER CONNECTION: after a reconnect the server replays
        // the gap and its first hb marks caught-up again.
        let sawFirstHeartbeat = false;

        const settle = (outcome: Effect.Effect<void, ThreadFeedAuthError>) => {
          if (!settled) {
            settled = true;
            resume(outcome);
          }
        };

        ws.addEventListener("open", () => {
          attempt = 0;
          Effect.runSync(Effect.ignore(offer({ kind: "connection", state: "connected" })));
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
          } catch {
            return; // not a frame; nothing to advance
          }
          const raw = parsed as {
            kind?: unknown;
            seq?: unknown;
            epoch?: unknown;
            role?: unknown;
            class?: unknown;
            error?: unknown;
          };

          // ── transport family: hb / error — liveness + boundary, never forwarded ──
          if (raw.kind === "hb") {
            const hbEpoch = typeof raw.epoch === "number" ? raw.epoch : cursor.epoch;
            if (hbEpoch !== null && cursor.epoch !== null && hbEpoch !== cursor.epoch) {
              cursor.epoch = hbEpoch;
              cursor.seq = 0;
              sawFirstHeartbeat = false;
              Effect.runSync(Effect.ignore(offer({ kind: "reset", epoch: hbEpoch })));
            }
            if (cursor.epoch === null && hbEpoch !== null) {
              cursor.epoch = hbEpoch;
            }
            if (!sawFirstHeartbeat && cursor.epoch !== null) {
              sawFirstHeartbeat = true;
              Effect.runSync(
                Effect.ignore(
                  offer({ kind: "replay-complete", head: cursor.seq, epoch: cursor.epoch }),
                ),
              );
            }
            // Keep the transport decode honest even though we only use two fields.
            Effect.runSync(Effect.ignore(Effect.exit(decodeTransportFrame(parsed))));
            return;
          }
          if (raw.kind === "error") {
            if (raw.class === "permission_error") {
              // Fail the QUEUE, not the connection effect: queue failure is the stream's
              // unambiguous end, whatever the callback-effect's own failure semantics.
              authFailed = true;
              Effect.runSync(
                Effect.ignore(
                  Queue.fail(
                    queue,
                    new ThreadFeedAuthError({
                      runId: options.runId,
                      message: typeof raw.error === "string" ? raw.error : "permission refused",
                    }),
                  ),
                ),
              );
              settle(Effect.void);
              ws.close();
              return;
            }
            // validation/transport error frames: the server closes after sending; the
            // close handler drives the reconnect. Nothing to forward.
            return;
          }

          // ── durable frames: envelope first (cursor advances on DELIVERY), decode
          //    second (rendering is the projection's problem) ──
          const seq = typeof raw.seq === "number" ? raw.seq : null;
          const epoch = typeof raw.epoch === "number" ? raw.epoch : null;
          if (seq === null || epoch === null) {
            return;
          }
          if (cursor.epoch !== null && epoch !== cursor.epoch) {
            // The feed was recreated: every accumulated fact is stale. Reset BEFORE
            // dedupe, or the replayed-from-zero frames would all read as duplicates.
            cursor.epoch = epoch;
            cursor.seq = 0;
            sawFirstHeartbeat = false;
            Effect.runSync(Effect.ignore(offer({ kind: "reset", epoch })));
          }
          if (cursor.epoch === null) {
            cursor.epoch = epoch;
          }
          if (seq <= cursor.seq) {
            return; // replay overlap is the server's right; duplicates are ours to drop
          }
          cursor.seq = seq;
          if (raw.role === "console") {
            return; // echoes advance the cursor and are not forwarded
          }

          const decoded = Effect.runSyncExit(decodeFeedFrame(parsed));
          if (Exit.isSuccess(decoded)) {
            Effect.runSync(Effect.ignore(offer({ kind: "frame", frame: decoded.value })));
            return;
          }
          // Undecodable: an unknown kind is additive wire evolution working as designed;
          // a known kind with a refused payload (e.g. an unrecognised turn state) is the
          // donor's rendered-as-completed bug being refused. Either way: skip, say so,
          // never crash the stream, never render.
          Effect.runSync(
            Effect.logWarning("[atlas-feed] skipped undecodable frame", {
              runId: options.runId,
              kind: typeof raw.kind === "string" ? raw.kind : "?",
              seq,
            }),
          );
        });

        ws.addEventListener("error", () => {
          settle(Effect.void);
        });
        ws.addEventListener("close", () => {
          settle(Effect.void);
        });

        return Effect.sync(() => {
          settled = true;
          ws.close();
        });
      });

      // The reconnect loop is the stream's whole life; interruption (the consumer
      // closing the stream) tears down the current socket via connectOnce's finalizer.
      while (true) {
        yield* connectOnce;
        if (authFailed) {
          return; // the queue already carries the refusal; do not reconnect past it
        }
        yield* offer({ kind: "connection", state: "reconnecting" });
        const delay = Math.min(
          backoff.capMillis,
          backoff.initialMillis * Math.pow(backoff.factor, attempt),
        );
        attempt += 1;
        // Half-jitter: a fleet of tabs must not thundering-herd a recovering node.
        const jitter = yield* Random.next;
        yield* Effect.sleep(delay * (0.5 + jitter * 0.5));
      }
    }),
  );
