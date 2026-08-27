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
  AtlasDiagnosticsRelaySessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import {
  ATLAS_PROXY_MAX_BODY_BYTES,
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
        yield* Stream.runCollect(service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID })),
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
          yield* Stream.runCollect(service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID })),
        );
        expect(events).toEqual([{ kind: "closed", code: 4401, reason: "unauthenticated" }]);

        // A session that closed before this ever registered must not be sendable afterward.
        const sendResult = yield* service.sendCommand({
          relaySessionId: AtlasDiagnosticsRelaySessionId.make("session-refused"),
          raw: '{"kind":"refresh"}',
        });
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
        Stream.runDrain(service.openFeed({ providerInstanceId: ATLAS_INSTANCE_ID })),
      );
      yield* Deferred.await(opened);

      const result = yield* service.sendCommand({
        relaySessionId: AtlasDiagnosticsRelaySessionId.make("session-2"),
        raw: '{"kind":"refresh"}',
      });
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
      const result = yield* service.sendCommand({
        relaySessionId: AtlasDiagnosticsRelaySessionId.make("never-opened"),
        raw: '{"kind":"refresh"}',
      });
      expect(result).toEqual({ sent: false });
    }).pipe(Effect.provide(serverSettingsLayerTest({ providerInstances: {} }))),
  );
});
