import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { EnvironmentRpcUnavailableError } from "../client.ts";
import type { PreparedConnection } from "../../connection/model.ts";
import { make } from "./session.ts";

const CONNECTION = {
  environmentId: "env-atlas-test",
  label: "atlas test node",
  httpBaseUrl: "http://node.test",
  socketUrl: "ws://node.test/_feed",
  httpAuthorization: { _tag: "Bearer", token: "secret" },
  target: { environmentId: "env-atlas-test" },
} as unknown as PreparedConnection;

const socketLayer = Layer.succeed(Socket.WebSocketConstructor, ((url: string) => {
  void url;
  throw new Error("no socket should open during construction");
}) as (url: string) => globalThis.WebSocket);

const withSession = <A, E>(f: (client: Record<string, unknown>) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const factory = yield* make.pipe(Effect.provide(socketLayer));
    const session = yield* factory.connect(CONNECTION);
    return yield* f(session.client as unknown as Record<string, unknown>);
  }).pipe(Effect.scoped);

const ALL_TAGS = [...Object.values(WS_METHODS), ...Object.values(ORCHESTRATION_WS_METHODS)];

it.effect("every declared tag has an explicit fate — none fall through undefined", () =>
  withSession((client) =>
    Effect.sync(() => {
      // Construction covers the same method tables the type derives from; a tag that is
      // neither bound nor gated would be `undefined` here and a runtime crash in the app.
      assert.isAtLeast(ALL_TAGS.length, 70);
      for (const tag of ALL_TAGS) {
        assert.isFunction(client[tag], `tag "${tag}" has no fate`);
      }
    }),
  ),
);

it.effect("a gated unary tag fails typed, not with a crash", () =>
  withSession((client) =>
    Effect.gen(function* () {
      const method = client[WS_METHODS.terminalOpen] as () => Effect.Effect<
        never,
        EnvironmentRpcUnavailableError
      >;
      const failure = yield* Effect.orDie(Effect.flip(method()));
      assert.instanceOf(failure, EnvironmentRpcUnavailableError);
      assert.include((failure as EnvironmentRpcUnavailableError).message, "terminal.open");
    }),
  ),
);

it.effect("a gated stream tag fails AS A STREAM with the same typed error", () =>
  withSession((client) =>
    Effect.gen(function* () {
      // A Stream-shaped tag refusing via Effect.fail would defect the caller's pipeline;
      // the refusal must ride the stream's error channel.
      const method = client[WS_METHODS.subscribeTerminalEvents] as () => Stream.Stream<
        never,
        EnvironmentRpcUnavailableError
      >;
      const failure = yield* Effect.orDie(Effect.flip(Stream.runDrain(method())));
      assert.instanceOf(failure, EnvironmentRpcUnavailableError);
    }),
  ),
);

it.effect("removed-product tags are gated too — cloud relay does not resurrect", () =>
  withSession((client) =>
    Effect.gen(function* () {
      const method = client[WS_METHODS.cloudGetRelayClientStatus] as () => Effect.Effect<
        never,
        EnvironmentRpcUnavailableError
      >;
      const failure = yield* Effect.orDie(Effect.flip(method()));
      assert.instanceOf(failure, EnvironmentRpcUnavailableError);
    }),
  ),
);

it.effect("dispatchCommand refuses non-M1 command types typed — without any network", () =>
  withSession((client) =>
    Effect.gen(function* () {
      const dispatch = client[ORCHESTRATION_WS_METHODS.dispatchCommand] as (
        input: unknown,
      ) => Effect.Effect<never, EnvironmentRpcUnavailableError>;
      // thread.create is projection/catalog territory (slice 3+); the refusal must come
      // before any handshake or socket — the throwing constructor above enforces that.
      const failure = yield* Effect.orDie(
        Effect.flip(dispatch({ type: "thread.create", commandId: "cmd-1", threadId: "t-1" })),
      );
      assert.instanceOf(failure, EnvironmentRpcUnavailableError);
    }),
  ),
);
