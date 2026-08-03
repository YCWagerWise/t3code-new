// Doc 15 §2.6: subscribeThread through the FULL client against a live node.
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { make } from "../src/rpc/atlas/session.ts";
import type { PreparedConnection } from "../src/connection/model.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const socketLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  ((url: string) => new WebSocket(url)) as (url: string) => globalThis.WebSocket,
);
const CONNECTION = {
  environmentId: "env-live",
  label: "rig",
  httpBaseUrl: "http://127.0.0.1:3199",
  socketUrl: "ws://127.0.0.1:3199/_feed",
  httpAuthorization: { _tag: "Bearer", token: "dev" },
  target: { environmentId: "env-live" },
} as unknown as PreparedConnection;

const main = Effect.gen(function* () {
  const factory = yield* make.pipe(Effect.provide(socketLayer));
  const session = yield* factory.connect(CONNECTION);
  yield* session.ready;
  const client = session.client as unknown as Record<
    string,
    (i: unknown) => Stream.Stream<{ kind: string; snapshot?: unknown; event?: unknown }>
  >;
  const items: Array<{ kind: string; snapshot?: unknown; event?: unknown }> = [];
  const fiber = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]!({ threadId: "rig" }).pipe(
    Stream.runForEach((i) => Effect.sync(() => items.push(i))),
    Effect.forkChild,
  );
  yield* Effect.sleep(3000);
  yield* Fiber.interrupt(fiber);
  decodeSnapshot((items[0] as { snapshot: unknown }).snapshot);
  const events = items.filter((i) => i.kind === "event");
  for (const e of events) decodeEvent((e as { event: unknown }).event);
  const types = events.map((e) => (e.event as { type: string }).type);
  console.log(
    JSON.stringify({
      ready: true,
      first: items[0]!.kind,
      events: events.length,
      synchronized: items.some((i) => i.kind === "synchronized"),
      hasMessage: types.includes("thread.message-sent"),
      hasSession: types.includes("thread.session-set"),
      hasDiff: types.includes("thread.turn-diff-completed"),
      allSchemaLegal: true,
    }),
  );
});
Effect.runPromise(main).catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
