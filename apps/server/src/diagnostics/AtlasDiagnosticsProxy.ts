/**
 * AtlasDiagnosticsProxy — a CONSTRAINED TRANSPORT PROXY over Atlas's diagnostics surface.
 *
 * This service does two things and nothing more:
 *
 *   1. `callHttp` proxies exactly three Atlas HTTP routes (see `AtlasDiagnosticsHttpRoute` in
 *      `@t3tools/contracts`) and returns the upstream status/body VERBATIM. It never
 *      re-encodes, aggregates, or interprets what Atlas answered — that is the browser's job,
 *      against `atlas-protocol`'s own schema. This server only decides whether the CALL was
 *      allowed to happen at all (a known, Atlas-driven, securely-credentialed instance) and
 *      enforces transport bounds (size, time).
 *   2. `openFeed`/`sendCommand` relay raw TEXT frames between the browser and Atlas's
 *      `/_feed?run_id=__diagnostics__` socket. No frame is parsed here; cursor and retry policy
 *      belong to the browser, which already speaks Atlas's wire format.
 *
 * The browser addresses a configured `ProviderInstanceId`, never a URL. Both entry points
 * resolve baseUrl/credential through the exact same decision `AtlasDriver.ts` uses to build a
 * turn-driving session (`readAtlasCredential`/`normalizeBaseUrl`, re-exported from there) — one
 * trusted seam, not a second copy of it.
 *
 * See `packages/contracts/src/atlasDiagnosticsProxy.ts` for the full module doc and the wire
 * contract.
 *
 * @module diagnostics/AtlasDiagnosticsProxy
 */
import {
  AtlasProxyCredentialInsecureError,
  AtlasProxyNotAtlasDriverError,
  AtlasProxyUnknownProviderInstanceError,
  type AtlasDiagnosticsCommand,
  AtlasProxyRelayOverflowError,
  AtlasProxyUnreachableError,
  AtlasProxyUpstreamTimeoutError,
  AtlasProxyUpstreamTooLargeError,
  ATLAS_PROVIDER_DRIVER_KIND,
  AtlasDiagnosticsRelaySessionId,
  DEFAULT_SERVER_SETTINGS,
  type AtlasDiagnosticsFeedInput,
  type AtlasDiagnosticsHttpInput,
  type AtlasDiagnosticsHttpResult,
  type AtlasDiagnosticsHttpRoute,
  type AtlasDiagnosticsProxyError,
  type AtlasDiagnosticsRelayEvent,
  type AtlasDiagnosticsSendCommandInput,
  type AtlasDiagnosticsSendCommandResult,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  AtlasSettings,
  normalizeBaseUrl,
  readAtlasCredential,
} from "../provider/Drivers/AtlasDriver.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A generous but finite ceiling — a diagnostics dump is telemetry, not a file transfer. */
export const ATLAS_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * The live relay needs its own bounds, and for the same reason the HTTP path has them: a
 * configured node is not a trusted one, and a browser that stops draining is not a rare case.
 *
 * A frame over `ATLAS_PROXY_MAX_FRAME_BYTES` CLOSES the relay rather than being truncated —
 * truncating would hand the browser a half a JSON document and let it decode garbage. A queue
 * that cannot accept a frame also closes it, rather than dropping one silently: the browser
 * owns the Atlas cursor, so a hole it cannot see is worse than a disconnect it can, and the
 * reconnect path already replays from that cursor.
 */
export const ATLAS_PROXY_MAX_FRAME_BYTES = 1024 * 1024;
export const ATLAS_PROXY_RELAY_BUFFER_FRAMES = 256;
// Close CODES are deliberately absent: a relay-originated end is a typed failure
// (`AtlasProxyRelayOverflowError`), not a `closed` event, because a close offered into a
// saturated queue can be refused. Upstream's own close still rides through as `closed`.
export const ATLAS_PROXY_DEFAULT_TIMEOUT_MS = 10_000;

const ROUTE_PATHS: Record<AtlasDiagnosticsHttpRoute, string> = {
  handshake: "/console/v1/handshake",
  diagnostics: "/console/v1/diagnostics",
  diagnosticsHistory: "/console/v1/diagnostics/history",
};

interface AtlasEndpointResolution {
  readonly baseUrl: string;
  readonly accessToken: string | undefined;
}

const decodeAtlasInstanceConfig = Schema.decodeUnknownOption(AtlasSettings);

/**
 * The one place a `ProviderInstanceId` becomes "a baseUrl and a credential T3 is willing to
 * use" — shared by `callHttp` and `openFeed` so the HTTP and live paths can never disagree
 * about which node or token a browser's request reaches.
 */
const resolveAtlasEndpoint = (
  providerInstanceId: ProviderInstanceId,
  providerInstances: Readonly<Record<string, ProviderInstanceConfig>>,
): Effect.Effect<AtlasEndpointResolution, AtlasDiagnosticsProxyError> => {
  const instance = providerInstances[providerInstanceId];
  if (instance === undefined) {
    return Effect.fail(
      new AtlasProxyUnknownProviderInstanceError({
        providerInstanceId: String(providerInstanceId),
      }),
    );
  }
  if (instance.driver !== ATLAS_PROVIDER_DRIVER_KIND) {
    return Effect.fail(
      new AtlasProxyNotAtlasDriverError({
        providerInstanceId: String(providerInstanceId),
        driver: String(instance.driver),
      }),
    );
  }
  const credential = readAtlasCredential(instance.environment);
  if (credential.kind === "refused-insecure") {
    return Effect.fail(
      new AtlasProxyCredentialInsecureError({ providerInstanceId: String(providerInstanceId) }),
    );
  }
  const decoded = decodeAtlasInstanceConfig(instance.config);
  const baseUrl = normalizeBaseUrl(decoded._tag === "Some" ? decoded.value.baseUrl : undefined);
  return Effect.succeed({
    baseUrl,
    accessToken: credential.kind === "token" ? credential.value : undefined,
  });
};

/**
 * The ENTIRE surface for "which URL does the browser reach". `input.route` is already
 * schema-validated to one of the three literals before this runs (`AtlasDiagnosticsHttpRoute`),
 * but the lookup is guarded a second time here anyway — defense in depth against a value that
 * reached this function some other way (a future refactor, a decoding bug) rather than trusting
 * the schema boundary alone. There is no code path anywhere in this module that accepts a
 * caller-supplied path or origin; `baseUrl` always comes from `resolveAtlasEndpoint`, never from
 * `input`.
 */
const buildHttpUrl = (baseUrl: string, input: AtlasDiagnosticsHttpInput): string | null => {
  if (!Object.hasOwn(ROUTE_PATHS, input.route)) return null;
  const path = ROUTE_PATHS[input.route];
  if (input.route !== "diagnosticsHistory" || input.history === undefined) {
    return `${baseUrl}${path}`;
  }
  const params = new URLSearchParams();
  if (input.history.epoch !== undefined) params.set("epoch", String(input.history.epoch));
  if (input.history.after !== undefined) params.set("after", String(input.history.after));
  if (input.history.limit !== undefined) params.set("limit", String(input.history.limit));
  const query = params.toString();
  return query.length > 0 ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`;
};

const describeError = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String((cause as { message?: unknown }).message)
    : String(cause);

type BoundedReadOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false };

/** Pumps the response body in chunks, refusing to buffer past `maxBytes`. */
async function readBoundedBody(
  response: {
    readonly body: ReadableStream<Uint8Array> | null;
    readonly text: () => Promise<string>;
  },
  maxBytes: number,
): Promise<BoundedReadOutcome> {
  if (response.body === null) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes
      ? { ok: false }
      : { ok: true, text };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

export type ProxyFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly text: () => Promise<string>;
}>;

type FetchOutcome =
  | { readonly outcome: "response"; readonly status: number; readonly text: string }
  | { readonly outcome: "too-large" }
  | { readonly outcome: "timeout" }
  | { readonly outcome: "network-error"; readonly message: string };

async function fetchBounded(
  url: string,
  input: {
    readonly accessToken: string | undefined;
    readonly fetchImpl: ProxyFetch;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  },
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(url, {
      method: "GET",
      headers:
        input.accessToken === undefined ? {} : { Authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    const bounded = await readBoundedBody(response, input.maxBytes);
    if (!bounded.ok) return { outcome: "too-large" };
    return { outcome: "response", status: response.status, text: bounded.text };
  } catch (cause) {
    if (controller.signal.aborted) return { outcome: "timeout" };
    return { outcome: "network-error", message: describeError(cause) };
  } finally {
    clearTimeout(timer);
  }
}

// --- Live relay socket abstraction ----------------------------------------------------------
//
// Deliberately NOT `AtlasConsole.ts`'s `AtlasSocketFactory`: that shape's `onMessage` carries no
// payload (the console-presence mechanism only needs to know THAT a frame arrived, not what it
// said, since it reads events over HTTP separately). A relay has no other way to see a frame's
// bytes, so it needs its own minimal socket seam.

export interface RelaySocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  readonly onClose: (code: number, reason: string) => void;
}
export interface RelaySocket {
  send(data: string): void;
  close(): void;
}
export type RelaySocketFactory = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

const defaultRelaySocketFactory: RelaySocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    handlers.onMessage(typeof event.data === "string" ? event.data : "");
  });
  socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
  // `error` carries no code/reason on the wire; the `close` the spec guarantees follows it is
  // what actually reports one, so there is nothing honest to relay from `error` itself.
  socket.addEventListener("error", () => {});
  return {
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
  };
};

const feedWsUrl = (endpoint: AtlasEndpointResolution): string => {
  const base = endpoint.baseUrl.replace(/^http/, "ws");
  const token =
    endpoint.accessToken === undefined
      ? ""
      : `&access_token=${encodeURIComponent(endpoint.accessToken)}`;
  return `${base}/_feed?run_id=${encodeURIComponent("__diagnostics__")}${token}`;
};

export class AtlasDiagnosticsProxy extends Context.Service<
  AtlasDiagnosticsProxy,
  {
    readonly callHttp: (
      input: AtlasDiagnosticsHttpInput,
    ) => Effect.Effect<AtlasDiagnosticsHttpResult, AtlasDiagnosticsProxyError>;
    /**
     * `ownerId` identifies the CONNECTION opening the relay and is supplied by the transport,
     * never by the browser — otherwise a caller could simply claim someone else's ownership.
     */
    readonly openFeed: (
      input: AtlasDiagnosticsFeedInput,
      ownerId: string,
    ) => Stream.Stream<AtlasDiagnosticsRelayEvent, AtlasDiagnosticsProxyError>;
    readonly sendCommand: (
      input: AtlasDiagnosticsSendCommandInput,
      ownerId: string,
    ) => Effect.Effect<AtlasDiagnosticsSendCommandResult>;
  }
>()("t3/diagnostics/AtlasDiagnosticsProxy") {}

export interface AtlasDiagnosticsProxyDeps {
  readonly fetch?: ProxyFetch;
  readonly socketFactory?: RelaySocketFactory;
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  /** Test seam: replaces `crypto.randomUUID()` so a relay test can assert on a fixed id. */
  readonly mintRelaySessionId?: () => string;
}

const defaultFetch: ProxyFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<ProxyFetch>;

export const make = (deps?: AtlasDiagnosticsProxyDeps) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const fetchImpl = deps?.fetch ?? defaultFetch;
    const socketFactory = deps?.socketFactory ?? defaultRelaySocketFactory;
    const maxBytes = deps?.maxBodyBytes ?? ATLAS_PROXY_MAX_BODY_BYTES;
    const timeoutMs = deps?.timeoutMs ?? ATLAS_PROXY_DEFAULT_TIMEOUT_MS;
    const mintRelaySessionId = deps?.mintRelaySessionId ?? (() => crypto.randomUUID());

    // Live relay sockets, keyed by the id minted for their `openFeed` subscription — the only
    // state this service holds. `sendCommand` looks a session up here; it never reaches for a
    // socket any other way, so a stale or unknown id can only ever produce `{ sent: false }`.
    // #28: an id is not authority. Each session records the connection that opened it, so a
    // different authenticated caller holding the id cannot actuate someone else's socket.
    const relaySessions = new Map<
      string,
      { readonly socket: RelaySocket; readonly ownerId: string }
    >();

    // A settings-read failure degrades to "no instances configured" (an honest
    // `AtlasProxyUnknownProviderInstanceError` once resolution runs) rather than dying the
    // whole RPC — the same degrade-with-default treatment `ws.ts` already gives a failed
    // settings read elsewhere.
    const currentProviderInstances = settingsService.getSettings.pipe(
      Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
      Effect.map((settings) => settings.providerInstances),
    );

    const callHttp: AtlasDiagnosticsProxy["Service"]["callHttp"] = (input) =>
      Effect.gen(function* () {
        const providerInstances = yield* currentProviderInstances;
        const endpoint = yield* resolveAtlasEndpoint(input.providerInstanceId, providerInstances);
        const url = buildHttpUrl(endpoint.baseUrl, input);
        if (url === null) {
          // Unreachable in practice — `AtlasDiagnosticsHttpRoute` is a closed schema literal
          // union decoded before this handler ever runs — but refused explicitly rather than
          // silently building `${baseUrl}undefined` if it ever were.
          return yield* Effect.fail(
            new AtlasProxyUnreachableError({
              providerInstanceId: String(input.providerInstanceId),
              detail: `unknown diagnostics route "${String(input.route)}"`,
            }),
          );
        }
        const outcome = yield* Effect.promise(() =>
          fetchBounded(url, { accessToken: endpoint.accessToken, fetchImpl, timeoutMs, maxBytes }),
        );
        switch (outcome.outcome) {
          case "response":
            return { status: outcome.status, bodyText: outcome.text };
          case "too-large":
            return yield* Effect.fail(
              new AtlasProxyUpstreamTooLargeError({
                providerInstanceId: String(input.providerInstanceId),
                limitBytes: maxBytes,
              }),
            );
          case "timeout":
            return yield* Effect.fail(
              new AtlasProxyUpstreamTimeoutError({
                providerInstanceId: String(input.providerInstanceId),
              }),
            );
          case "network-error":
            return yield* Effect.fail(
              new AtlasProxyUnreachableError({
                providerInstanceId: String(input.providerInstanceId),
                detail: outcome.message,
              }),
            );
        }
      });

    const openFeed: AtlasDiagnosticsProxy["Service"]["openFeed"] = (input, ownerId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const providerInstances = yield* currentProviderInstances;
          const endpoint = yield* resolveAtlasEndpoint(input.providerInstanceId, providerInstances);
          const wsUrl = feedWsUrl(endpoint);
          return Stream.callback<AtlasDiagnosticsRelayEvent, AtlasDiagnosticsProxyError>(
            (queue) =>
              Effect.gen(function* () {
                const relaySessionId = AtlasDiagnosticsRelaySessionId.make(mintRelaySessionId());
                let isClosed = false;
                let socket: RelaySocket | undefined;

                /**
                 * Ends the relay on OUR terms by FAILING the stream, not by offering a
                 * `closed` event.
                 *
                 * Saturation is one of the triggers, and a terminal event offered into a full
                 * queue can itself be refused — the browser would drain stale frames and stop
                 * with no explanation, which is the silent gap this bound exists to prevent.
                 * A failure is not subject to capacity, so the signal always arrives.
                 */
                const failLocally = (detail: string) => {
                  if (isClosed) return;
                  isClosed = true;
                  relaySessions.delete(relaySessionId);
                  Queue.failCauseUnsafe(
                    queue,
                    Cause.fail(
                      new AtlasProxyRelayOverflowError({
                        providerInstanceId: input.providerInstanceId,
                        detail,
                      }),
                    ),
                  );
                  try {
                    socket?.close();
                  } catch {
                    // Already gone; the browser has its typed failure either way.
                  }
                };

                /**
                 * A refused offer means the browser is more than the buffer behind. Dropping
                 * the frame would leave a hole it cannot detect, so the relay ends instead and
                 * the reconnect replays from the cursor the browser already holds.
                 */
                const offerOrFail = (event: AtlasDiagnosticsRelayEvent) => {
                  if (isClosed) return;
                  if (!Queue.offerUnsafe(queue, event)) {
                    failLocally(
                      `the browser fell more than ${ATLAS_PROXY_RELAY_BUFFER_FRAMES} frames behind; ` +
                        "reconnect and replay from your cursor",
                    );
                  }
                };

                const handlers: RelaySocketHandlers = {
                  onOpen: () => {
                    offerOrFail({ kind: "open", relaySessionId });
                  },
                  onMessage: (data) => {
                    const bytes = Buffer.byteLength(data, "utf8");
                    if (bytes > ATLAS_PROXY_MAX_FRAME_BYTES) {
                      failLocally(
                        `a frame of ${bytes} bytes exceeds the ${ATLAS_PROXY_MAX_FRAME_BYTES}-byte relay limit`,
                      );
                      return;
                    }
                    offerOrFail({ kind: "message", raw: data });
                  },
                  onClose: (code, reason) => {
                    if (isClosed) return;
                    isClosed = true;
                    relaySessions.delete(relaySessionId);
                    // An ordinary upstream close is a `closed` EVENT, because it carries a code
                    // and reason worth delivering in order. But the queue may be exactly full,
                    // and an unchecked offer here would be refused and then ended — the browser
                    // would drain stale frames and see a clean EOF with no reason at all. If the
                    // event cannot be delivered, the relay fails instead, which capacity cannot
                    // refuse; the reason survives in the failure.
                    if (Queue.offerUnsafe(queue, { kind: "closed", code, reason })) {
                      Queue.endUnsafe(queue);
                      return;
                    }
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(
                        new AtlasProxyRelayOverflowError({
                          providerInstanceId: input.providerInstanceId,
                          detail: `upstream closed (${code}: ${reason}) while the browser was more than ${ATLAS_PROXY_RELAY_BUFFER_FRAMES} frames behind`,
                        }),
                      ),
                    );
                  },
                };

                // Constructing the socket can throw SYNCHRONOUSLY — a URL the runtime refuses,
                // a connection it declines outright. Left bare that becomes a defect outside the
                // declared error type, so the lens could not render `unreachable` for the very
                // failure most likely to cause it.
                try {
                  socket = socketFactory(wsUrl, handlers);
                } catch (cause) {
                  // Fails the QUEUE, not the setup effect. A setup-effect failure leaves the
                  // queue open and the consumer hanging forever — proven by the test for this
                  // branch, which timed out at 120s before this was corrected.
                  isClosed = true;
                  Queue.failCauseUnsafe(
                    queue,
                    Cause.fail(
                      new AtlasProxyUnreachableError({
                        providerInstanceId: input.providerInstanceId,
                        detail: cause instanceof Error ? cause.message : String(cause),
                      }),
                    ),
                  );
                  return;
                }
                // A socket that already closed SYNCHRONOUSLY (an immediate auth refusal) must
                // never be registered as sendable — `sendCommand` has to see it as gone, not as
                // a session it can still write to.
                if (!isClosed) relaySessions.set(relaySessionId, { socket, ownerId });
                const opened = socket;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    relaySessions.delete(relaySessionId);
                    if (!isClosed) opened.close();
                  }),
                );
              }),
            // Bounded so a browser that stops draining cannot grow this process without
            // limit. `dropping` is the backstop only: `offerOrClose` sees the refused offer
            // first and ends the relay, so a dropped frame is never a silent gap.
            {
              bufferSize: ATLAS_PROXY_RELAY_BUFFER_FRAMES,
              strategy: "dropping",
            },
          );
        }),
      );

    /**
     * Atlas tags `DiagnosticsCommand` adjacently in snake_case
     * (`#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]`), so the
     * browser names a command and the server writes the wire form. Bounded by the union's own
     * shape rather than a byte cap: there is no arbitrary text to be too large.
     */
    const encodeDiagnosticsCommand = (command: AtlasDiagnosticsCommand): string =>
      command.kind === "refresh"
        ? JSON.stringify({ kind: "refresh" })
        : JSON.stringify({
            kind: "retry",
            payload: {
              after: command.after,
              // Omitted upstream means "trust `after`" — preserved rather than defaulted.
              ...(command.epoch === undefined ? {} : { epoch: command.epoch }),
            },
          });

    const sendCommand: AtlasDiagnosticsProxy["Service"]["sendCommand"] = (input, ownerId) =>
      Effect.sync(() => {
        const session = relaySessions.get(input.relaySessionId);
        if (session === undefined) return { sent: false };
        // #28: holding the id is not holding the authority. A session may only be actuated by
        // the connection that opened it, so a leaked or guessed id is inert to anyone else.
        if (session.ownerId !== ownerId) return { sent: false };
        try {
          session.socket.send(encodeDiagnosticsCommand(input.command));
          return { sent: true };
        } catch {
          return { sent: false };
        }
      });

    return AtlasDiagnosticsProxy.of({ callHttp, openFeed, sendCommand });
  });

export const layer = Layer.effect(AtlasDiagnosticsProxy, make());

// Exposed for tests that want to construct the service without the settings/DI plumbing —
// mirrors `classifyHandshake`/`aggregateTraceDiagnostics` being pure, directly-testable seams
// beside their Effect-service wrappers.
export const testables = {
  resolveAtlasEndpoint,
  buildHttpUrl,
  fetchBounded,
  readBoundedBody,
  feedWsUrl,
};
