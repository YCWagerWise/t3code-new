/**
 * Security-focused coverage for the Atlas diagnostics transport proxy. `resolveAtlasEndpoint` /
 * `buildHttpUrl` are pure and driven directly (the same seam-testing style
 * `classifyHandshake`/`AtlasDriver.test.ts` already uses); `callHttp`/`openFeed`/`sendCommand`
 * are driven through `make(...)` with injected fetch/socket fakes, provided
 * `ServerSettingsService.layerTest(...)` so no real settings file or network is touched.
 *
 * Required by the finding this proxy exists to satisfy: unknown provider instance, non-Atlas
 * driver, arbitrary URL/path attempt, non-sensitive credential, oversized/slow upstream, upstream
 * 401/404/409 passthrough, WS auth refusal/close, and proof the token never reaches a browser
 * RPC payload.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  ATLAS_PROVIDER_DRIVER_KIND,
  AtlasDiagnosticsCommand,
  AtlasDiagnosticsRelaySessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import {
  ATLAS_PROXY_MAX_BODY_BYTES,
  ATLAS_PROXY_MAX_FRAME_BYTES,
  ATLAS_PROXY_RELAY_BUFFER_FRAMES,
  make,
  testables,
  type ProxyFetch,
  type RelaySocketFactory,
  type RelaySocketHandlers,
} from "./AtlasDiagnosticsProxy.ts";

const { resolveAtlasEndpoint, buildHttpUrl } = testables;

const ATLAS_INSTANCE_ID = ProviderInstanceId.make("atlas");

function atlasInstance(overrides: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig {
  return {
    driver: ATLAS_PROVIDER_DRIVER_KIND,
    environment: [{ name: "ATLAS_ACCESS_TOKEN", value: "atlas-dev-token", sensitive: true }],
    config: { baseUrl: "http://127.0.0.1:3010" },
    ...overrides,
  };
}

function jsonResponse(status: number, body: string): ReturnType<ProxyFetch> {
  return Promise.resolve({
    status,
    body: null,
    text: () => Promise.resolve(body),
  });
}

function stubFetch(
  handler: (url: string, init: Parameters<ProxyFetch>[1]) => ReturnType<ProxyFetch>,
): ProxyFetch {
  return (url, init) => handler(url, init);
}

/**
 * Dispatches `drive` on a microtask, matching a real `WebSocket`: `open`/`message`/`close` are
 * NEVER synchronous with the call that constructs the socket. Driving it synchronously would
 * make a test pass by accident, racing ahead of `openFeed`'s own synchronous setup (session
 * registration) rather than proving the relay handles a genuinely async socket correctly.
 */
function fakeSocketFactory(drive: (handlers: RelaySocketHandlers) => void): {
  readonly factory: RelaySocketFactory;
  readonly sent: Array<string>;
} {
  const sent: Array<string> = [];
  const factory: RelaySocketFactory = (_url, handlers) => {
    queueMicrotask(() => drive(handlers));
    return { send: (data) => sent.push(data), close: () => {} };
  };
  return { factory, sent };
}

describe("resolveAtlasEndpoint", () => {
  it.effect("refuses an unknown provider instance", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveAtlasEndpoint(ATLAS_INSTANCE_ID, {}));
      expect(error._tag).toBe("AtlasProxyUnknownProviderInstanceError");
    }),
  );

  it.effect("refuses an instance configured for a different driver", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveAtlasEndpoint(ATLAS_INSTANCE_ID, {
          [ATLAS_INSTANCE_ID]: atlasInstance({ driver: ProviderDriverKind.make("codex") }),
        }),
      );
      expect(error._tag).toBe("AtlasProxyNotAtlasDriverError");
    }),
  );

  it.effect("refuses a credential stored non-sensitive rather than using it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveAtlasEndpoint(ATLAS_INSTANCE_ID, {
          [ATLAS_INSTANCE_ID]: atlasInstance({
            environment: [{ name: "ATLAS_ACCESS_TOKEN", value: "leaked", sensitive: false }],
          }),
        }),
      );
      expect(error._tag).toBe("AtlasProxyCredentialInsecureError");
      // The failure never carries the credential's value anywhere in the typed error.
      expect(JSON.stringify(error)).not.toContain("leaked");
    }),
  );

  it.effect("resolves a securely-stored token and the configured base URL", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveAtlasEndpoint(ATLAS_INSTANCE_ID, {
        [ATLAS_INSTANCE_ID]: atlasInstance(),
      });
      expect(resolved).toEqual({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "atlas-dev-token",
      });
    }),
  );
});

describe("buildHttpUrl — the allowlist", () => {
  const baseUrl = "http://127.0.0.1:3010";

  it("only ever produces one of the three allowlisted Atlas routes", () => {
    expect(
      buildHttpUrl(baseUrl, { providerInstanceId: ATLAS_INSTANCE_ID, route: "handshake" }),
    ).toBe(`${baseUrl}/console/v1/handshake`);
    expect(
      buildHttpUrl(baseUrl, { providerInstanceId: ATLAS_INSTANCE_ID, route: "diagnostics" }),
    ).toBe(`${baseUrl}/console/v1/diagnostics`);
    expect(
      buildHttpUrl(baseUrl, {
        providerInstanceId: ATLAS_INSTANCE_ID,
        route: "diagnosticsHistory",
        history: { epoch: 3, after: 10, limit: 50 },
      }),
    ).toBe(`${baseUrl}/console/v1/diagnostics/history?epoch=3&after=10&limit=50`);
  });

  it("refuses (returns null, not a guessed URL) for a route outside the allowlist", () => {
    // A browser can never SEND this — `AtlasDiagnosticsHttpRoute` is a closed schema literal
    // union decoded before this function runs. This proves the fallback itself refuses rather
    // than silently building `${baseUrl}undefined` if that boundary were ever bypassed.
    const arbitraryPathAttempt = {
      providerInstanceId: ATLAS_INSTANCE_ID,
      route: "../../etc/passwd",
    } as unknown as Parameters<typeof buildHttpUrl>[1];
    expect(buildHttpUrl(baseUrl, arbitraryPathAttempt)).toBeNull();
  });

  it("never lets the caller name an origin — baseUrl always comes from the resolved instance", () => {
    const url = buildHttpUrl(baseUrl, {
      providerInstanceId: ATLAS_INSTANCE_ID,
      route: "handshake",
    });
    expect(url).not.toBeNull();
    expect(new URL(url as string).origin).toBe(new URL(baseUrl).origin);
  });
});

describe("AtlasDiagnosticsProxy.callHttp", () => {
  it.effect(
    "passes an upstream 401 through verbatim as a successful proxy call, not a proxy error",
    () =>
      Effect.gen(function* () {
        const service = yield* make({
          fetch: stubFetch(() => jsonResponse(401, "unauthenticated")),
        });
        const result = yield* service.callHttp({
          providerInstanceId: ATLAS_INSTANCE_ID,
          route: "handshake",
        });
        expect(result).toEqual({ status: 401, bodyText: "unauthenticated" });
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
        ),
      ),
  );

  it.effect("passes an upstream 404 through verbatim", () =>
    Effect.gen(function* () {
      const service = yield* make({ fetch: stubFetch(() => jsonResponse(404, "not found")) });
      const result = yield* service.callHttp({
        providerInstanceId: ATLAS_INSTANCE_ID,
        route: "diagnostics",
      });
      expect(result).toEqual({ status: 404, bodyText: "not found" });
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("passes the history endpoint's 409 CURSOR_EPOCH_INVALID through verbatim", () =>
    Effect.gen(function* () {
      const service = yield* make({
        fetch: stubFetch(() =>
          jsonResponse(409, JSON.stringify({ code: "CURSOR_EPOCH_INVALID", expected_epoch: 4 })),
        ),
      });
      const result = yield* service.callHttp({
        providerInstanceId: ATLAS_INSTANCE_ID,
        route: "diagnosticsHistory",
        history: { epoch: 3, after: 0 },
      });
      expect(result.status).toBe(409);
      expect(result.bodyText).toContain("CURSOR_EPOCH_INVALID");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("refuses a response over the byte ceiling instead of buffering it", () =>
    Effect.gen(function* () {
      const oversized = "x".repeat(ATLAS_PROXY_MAX_BODY_BYTES + 1);
      const service = yield* make({
        fetch: stubFetch(() => jsonResponse(200, oversized)),
        maxBodyBytes: ATLAS_PROXY_MAX_BODY_BYTES,
      });
      const error = yield* Effect.flip(
        service.callHttp({ providerInstanceId: ATLAS_INSTANCE_ID, route: "diagnostics" }),
      );
      expect(error._tag).toBe("AtlasProxyUpstreamTooLargeError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("times out a slow upstream instead of hanging the RPC", () =>
    Effect.gen(function* () {
      const service = yield* make({
        // Mirrors real `fetch`'s abort contract: rejects once the timeout's `AbortController`
        // fires, rather than hanging forever regardless of the signal like a naive stub would.
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        timeoutMs: 20,
      });
      const error = yield* Effect.flip(
        service.callHttp({ providerInstanceId: ATLAS_INSTANCE_ID, route: "handshake" }),
      );
      expect(error._tag).toBe("AtlasProxyUpstreamTimeoutError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("refuses an unknown provider instance rather than guessing a node to call", () =>
    Effect.gen(function* () {
      const service = yield* make({ fetch: stubFetch(() => jsonResponse(200, "{}")) });
      const error = yield* Effect.flip(
        service.callHttp({ providerInstanceId: ATLAS_INSTANCE_ID, route: "handshake" }),
      );
      expect(error._tag).toBe("AtlasProxyUnknownProviderInstanceError");
    }).pipe(Effect.provide(serverSettingsLayerTest({ providerInstances: {} }))),
  );

  it.effect(
    "the token reaches the upstream Authorization header and NOWHERE in the RPC result",
    () =>
      Effect.gen(function* () {
        let capturedAuthHeader: string | undefined;
        const service = yield* make({
          fetch: stubFetch((_url, init) => {
            capturedAuthHeader = init.headers["Authorization"];
            return jsonResponse(200, JSON.stringify({ capabilities: ["diagnostics.read"] }));
          }),
        });
        const result = yield* service.callHttp({
          providerInstanceId: ATLAS_INSTANCE_ID,
          route: "handshake",
        });
        expect(capturedAuthHeader).toBe("Bearer atlas-dev-token");
        expect(Object.keys(result)).toEqual(["status", "bodyText"]);
        expect(JSON.stringify(result)).not.toContain("atlas-dev-token");
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
        ),
      ),
  );
});

/** Stands in for the per-connection id ws.ts supplies; never browser-controlled. */
const OWNER = "conn-owner-1";
/** A DIFFERENT authenticated connection, for the ownership tests. */
const OTHER_OWNER = "conn-owner-2";

describe("AtlasDiagnosticsProxy — live relay", () => {
  it.effect("relays open, a text frame, and a normal close verbatim", () =>
    Effect.gen(function* () {
      const { factory } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        handlers.onMessage('{"kind":"diagnostics_snapshot"}');
        handlers.onClose(1000, "normal");
      });
      const service = yield* make({
        socketFactory: factory,
        mintRelaySessionId: () => "session-1",
      });
      const events = Array.from(
        yield* Stream.runCollect(
          service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
        ),
      );
      expect(events).toEqual([
        { kind: "open", relaySessionId: "session-1" },
        { kind: "message", raw: '{"kind":"diagnostics_snapshot"}' },
        { kind: "closed", code: 1000, reason: "normal" },
      ]);
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect(
    "a WS auth refusal (immediate close, never opens) surfaces as a closed event, not a hang",
    () =>
      Effect.gen(function* () {
        const { factory } = fakeSocketFactory((handlers) => {
          // Atlas refusing the token on `/_feed` closes without ever firing `onOpen`.
          handlers.onClose(4401, "unauthenticated");
        });
        const service = yield* make({
          socketFactory: factory,
          mintRelaySessionId: () => "session-refused",
        });
        const events = Array.from(
          yield* Stream.runCollect(
            service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
          ),
        );
        expect(events).toEqual([{ kind: "closed", code: 4401, reason: "unauthenticated" }]);

        // A session that closed before this ever registered must not be sendable afterward.
        const sendResult = yield* service.sendCommand(
          {
            relaySessionId: AtlasDiagnosticsRelaySessionId.make("session-refused"),
            command: { kind: "refresh" },
          },
          OWNER,
        );
        expect(sendResult).toEqual({ sent: false });
      }).pipe(
        Effect.provide(
          serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
        ),
      ),
  );

  it.effect("sendCommand relays a raw command frame to the live socket for its session", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const { factory, sent } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        Deferred.doneUnsafe(opened, Effect.void);
      });
      const service = yield* make({
        socketFactory: factory,
        mintRelaySessionId: () => "session-2",
      });

      // Kept open (never drained to completion) so the session is still registered when
      // `sendCommand` runs — a finished `Stream.runDrain` would have closed the socket first.
      // Waiting on `opened` (rather than a bare yieldNow) is deterministic regardless of how
      // many fiber-forking layers sit between this test and `Stream.callback`'s own setup fork.
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER)),
      );
      yield* Deferred.await(opened);

      const result = yield* service.sendCommand(
        {
          relaySessionId: AtlasDiagnosticsRelaySessionId.make("session-2"),
          command: { kind: "refresh" },
        },
        OWNER,
      );
      expect(result).toEqual({ sent: true });
      expect(sent).toEqual(['{"kind":"refresh"}']);

      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("sendCommand against an unknown session honestly reports it was not sent", () =>
    Effect.gen(function* () {
      const service = yield* make();
      const result = yield* service.sendCommand(
        {
          relaySessionId: AtlasDiagnosticsRelaySessionId.make("never-opened"),
          command: { kind: "refresh" },
        },
        OWNER,
      );
      expect(result).toEqual({ sent: false });
    }).pipe(Effect.provide(serverSettingsLayerTest({ providerInstances: {} }))),
  );
});

/**
 * The bounds and the terminal invariant, each exercised at its actual branch.
 *
 * The commit that introduced these bounds added no tests for any of them, so every claim in
 * its message was a comment. These are the branches: a constructor that throws, a frame
 * exactly at and one past the ceiling, a consumer that never drains, and a session id used by
 * a connection that does not own it.
 */
describe("AtlasDiagnosticsProxy — relay bounds and terminal invariant", () => {
  it.effect("a synchronous socket-constructor throw is a typed failure, not a defect", () =>
    Effect.gen(function* () {
      const service = yield* make({
        socketFactory: () => {
          throw new Error("connection refused by the runtime");
        },
      });
      const outcome = yield* Stream.runCollect(
        service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
      ).pipe(
        Effect.map(() => "succeeded-unexpectedly"),
        // Asserting on the TAG proves the failure rode the declared error channel; a
        // defect would never reach a tagged catch at all.
        Effect.catchTag("AtlasProxyUnreachableError", (error) => Effect.succeed(error._tag)),
      );
      expect(outcome).toEqual("AtlasProxyUnreachableError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("a frame exactly at the byte ceiling is relayed, not refused", () =>
    Effect.gen(function* () {
      const exact = "x".repeat(ATLAS_PROXY_MAX_FRAME_BYTES);
      const { factory } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        handlers.onMessage(exact);
        handlers.onClose(1000, "normal");
      });
      const service = yield* make({ socketFactory: factory, mintRelaySessionId: () => "s-exact" });
      const events = Array.from(
        yield* Stream.runCollect(
          service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
        ),
      );
      expect(events.some((e) => e.kind === "message" && e.raw.length === exact.length)).toBe(true);
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  it.effect("one byte past the ceiling ends the relay with a typed overflow, never truncated", () =>
    Effect.gen(function* () {
      const tooBig = "x".repeat(ATLAS_PROXY_MAX_FRAME_BYTES + 1);
      const { factory } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        handlers.onMessage(tooBig);
      });
      const service = yield* make({ socketFactory: factory, mintRelaySessionId: () => "s-big" });
      const outcome = yield* Stream.runCollect(
        service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
      ).pipe(
        Effect.map(() => "succeeded-unexpectedly"),
        // Asserting on the TAG proves the failure rode the declared error channel; a
        // defect would never reach a tagged catch at all.
        Effect.catchTag("AtlasProxyRelayOverflowError", (error) => Effect.succeed(error._tag)),
      );
      expect(outcome).toEqual("AtlasProxyRelayOverflowError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  /**
   * THE ONE THE REVIEWER ASKED FOR BY NAME. A terminal event offered into a saturated queue
   * can itself be refused, which would leave the consumer draining stale frames and stopping
   * with no explanation. Failing the stream is not subject to capacity, so this proves the
   * signal actually arrives rather than trusting the comment that says it does.
   */
  it.effect("a consumer that never drains still receives the terminal signal", () =>
    Effect.gen(function* () {
      const { factory } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        // Emitted synchronously, before any consumer pulls, so the bounded queue saturates
        // deterministically — no sleeps, no scheduler luck.
        for (let i = 0; i < ATLAS_PROXY_RELAY_BUFFER_FRAMES + 50; i += 1) {
          handlers.onMessage(`{"seq":${i}}`);
        }
      });
      const service = yield* make({ socketFactory: factory, mintRelaySessionId: () => "s-flood" });
      const outcome = yield* Stream.runCollect(
        service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
      ).pipe(
        Effect.map(() => "succeeded-unexpectedly"),
        // Asserting on the TAG proves the failure rode the declared error channel; a
        // defect would never reach a tagged catch at all.
        Effect.catchTag("AtlasProxyRelayOverflowError", (error) => Effect.succeed(error._tag)),
      );
      expect(outcome).toEqual("AtlasProxyRelayOverflowError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );
});

describe("AtlasDiagnosticsProxy — close, ownership, and command boundaries", () => {
  /**
   * The branch the previous saturation test never reached: it overfilled via onMessage, so the
   * overflow failure always won before onClose ran. Here the queue is filled EXACTLY, so the
   * first refused offer is the close event itself.
   */
  it.effect("an upstream close that cannot be delivered fails rather than ending silently", () =>
    Effect.gen(function* () {
      const { factory } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        // open + (BUFFER - 1) messages == exactly BUFFER events queued, nothing refused yet.
        for (let i = 0; i < ATLAS_PROXY_RELAY_BUFFER_FRAMES - 1; i += 1) {
          handlers.onMessage(`{"seq":${i}}`);
        }
        // The close is the first event with nowhere to go.
        handlers.onClose(1000, "normal");
      });
      const service = yield* make({ socketFactory: factory, mintRelaySessionId: () => "s-full" });
      const outcome = yield* Stream.runCollect(
        service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER),
      ).pipe(
        Effect.map(() => "ended-without-saying-why"),
        Effect.catchTag("AtlasProxyRelayOverflowError", (error) => Effect.succeed(error._tag)),
      );
      expect(outcome).toEqual("AtlasProxyRelayOverflowError");
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );

  /**
   * #28. OTHER_OWNER was declared last round and never used, so this branch had never run.
   * The invariant is an AUTH-SESSION boundary, not a per-connection one: ws.ts passes the
   * authenticated session id, which reconnects on the same token share.
   */
  it.effect("a session opened by one principal cannot be actuated by another", () =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const { factory, sent } = fakeSocketFactory((handlers) => {
        handlers.onOpen();
        Deferred.doneUnsafe(opened, Effect.void);
      });
      const service = yield* make({ socketFactory: factory, mintRelaySessionId: () => "s-own" });
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID }, OWNER)),
      );
      yield* Deferred.await(opened);

      const foreign = yield* service.sendCommand(
        {
          relaySessionId: AtlasDiagnosticsRelaySessionId.make("s-own"),
          command: { kind: "refresh" },
        },
        OTHER_OWNER,
      );
      expect(foreign).toEqual({ sent: false });
      expect(sent).toEqual([]);

      const mine = yield* service.sendCommand(
        {
          relaySessionId: AtlasDiagnosticsRelaySessionId.make("s-own"),
          command: { kind: "refresh" },
        },
        OWNER,
      );
      expect(mine).toEqual({ sent: true });
      expect(sent).toEqual(['{"kind":"refresh"}']);

      yield* Fiber.interrupt(fiber);
    }).pipe(
      Effect.provide(
        serverSettingsLayerTest({ providerInstances: { [ATLAS_INSTANCE_ID]: atlasInstance() } }),
      ),
    ),
  );
});

/**
 * #29. The union narrowed the KIND but not the cursor, so the contract still accepted values
 * Atlas's `i64` cannot hold and T3 reported them sent.
 */
describe("AtlasDiagnosticsCommand — hostile cursor boundaries", () => {
  const decode = (value: unknown) =>
    Effect.runSync(
      Schema.decodeUnknownEffect(AtlasDiagnosticsCommand)(value).pipe(
        Effect.map(() => "accepted"),
        Effect.catch(() => Effect.succeed("refused")),
      ),
    );

  it("accepts refresh, and retry with and without an epoch", () => {
    expect(decode({ kind: "refresh" })).toEqual("accepted");
    expect(decode({ kind: "retry", after: 0 })).toEqual("accepted");
    expect(decode({ kind: "retry", after: 42, epoch: 7 })).toEqual("accepted");
    expect(decode({ kind: "retry", after: Number.MAX_SAFE_INTEGER })).toEqual("accepted");
  });

  it("refuses a cursor Atlas's i64 could not hold", () => {
    expect(decode({ kind: "retry", after: 1.5 })).toEqual("refused");
    expect(decode({ kind: "retry", after: Number.NaN })).toEqual("refused");
    expect(decode({ kind: "retry", after: Number.POSITIVE_INFINITY })).toEqual("refused");
    expect(decode({ kind: "retry", after: Number.MAX_VALUE })).toEqual("refused");
    expect(decode({ kind: "retry", after: -1 })).toEqual("refused");
    expect(decode({ kind: "retry", after: 1, epoch: 2.5 })).toEqual("refused");
  });

  it("refuses a command kind the relay does not implement", () => {
    expect(decode({ kind: "shutdown" })).toEqual("refused");
    expect(decode({ kind: "retry" })).toEqual("refused");
  });
});
