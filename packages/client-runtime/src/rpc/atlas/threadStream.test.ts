import { OrchestrationEvent, OrchestrationThreadDetailSnapshot } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import fixtures from "./__fixtures__/atlas-feed-frames.json" with { type: "json" };
import { openThreadStream, type ThreadStreamItem } from "./threadStream.ts";

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

type Listener = (e: { data?: unknown; type: string }) => void;
class TestWebSocket {
  readyState = 0;
  readonly url: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, l: Listener) {
    const s = this.listeners.get(type) ?? new Set<Listener>();
    s.add(l);
    this.listeners.set(type, s);
  }
  removeEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
    this.emit("close", { type: "close" });
  }
  open() {
    this.readyState = 1;
    this.emit("open", { type: "open" });
  }
  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }
  private emit(type: string, e: { data?: unknown; type: string }) {
    for (const l of this.listeners.get(type) ?? []) {
      l(e);
    }
  }
}

const EPOCH = 1785704325750;
const encodeWire = Schema.encodeSync(Schema.UnknownFromJsonString);
const WIRE_FIXTURES = (fixtures as ReadonlyArray<unknown>).map((f) => encodeWire(f));
const USER_FIXTURE = (fixtures as ReadonlyArray<{ kind: string }>).find((f) => f.kind === "user")!;
const WIRE_USER = encodeWire(USER_FIXTURE);
const WIRE_USER_NEW_EPOCH = encodeWire({ ...(USER_FIXTURE as object), seq: 1, epoch: EPOCH + 1 });
const heartbeat = `{"version":1,"kind":"hb","run_id":"thr-proof","ts":1785704326000,"seq":14,"epoch":${EPOCH}}`;

it.effect("snapshot first, schema-legal events, synchronized at the boundary", () =>
  Effect.gen(function* () {
    const sockets: TestWebSocket[] = [];
    const layer = Layer.succeed(Socket.WebSocketConstructor, ((url: string) => {
      const ws = new TestWebSocket(url);
      sockets.push(ws);
      return ws as unknown as globalThis.WebSocket;
    }) as (url: string) => globalThis.WebSocket);

    const items: ThreadStreamItem[] = [];
    const fiber = yield* openThreadStream({
      socketBaseUrl: "http://node.test",
      accessToken: "t",
      threadId: "t-1",
      runId: "thr-proof",
    }).pipe(
      Stream.runForEach((item) => Effect.sync(() => items.push(item))),
      Effect.provide(layer),
      Effect.forkChild,
    );
    for (let i = 0; i < 20; i += 1) {
      yield* Effect.yieldNow;
    }
    const ws = sockets[0]!;
    ws.open();
    for (const wire of WIRE_FIXTURES) {
      ws.serverMessage(wire);
    }
    ws.serverMessage(heartbeat);
    for (let i = 0; i < 30; i += 1) {
      yield* Effect.yieldNow;
    }
    yield* Fiber.interrupt(fiber);

    // Snapshot first, always — a client cannot fold events onto a thread it lacks.
    assert.equal(items[0]!.kind, "snapshot");
    decodeSnapshot((items[0] as { snapshot: unknown }).snapshot);

    const events = items.filter((i) => i.kind === "event");
    assert.isAtLeast(events.length, 5);
    let last = 0;
    for (const e of events) {
      const decoded = decodeEvent((e as { event: unknown }).event);
      assert.isAbove(decoded.sequence as number, last, "strictly increasing sequence");
      last = decoded.sequence as number;
    }
    // The replay boundary reaches the subscriber as `synchronized`, AFTER the events.
    const synchronizedAt = items.findIndex((i) => i.kind === "synchronized");
    assert.isAbove(synchronizedAt, events.length - 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a feed reset re-bases the client with a fresh snapshot before new events", () =>
  Effect.gen(function* () {
    const sockets: TestWebSocket[] = [];
    const layer = Layer.succeed(Socket.WebSocketConstructor, ((url: string) => {
      const ws = new TestWebSocket(url);
      sockets.push(ws);
      return ws as unknown as globalThis.WebSocket;
    }) as (url: string) => globalThis.WebSocket);

    const items: ThreadStreamItem[] = [];
    const fiber = yield* openThreadStream({
      socketBaseUrl: "http://node.test",
      accessToken: "t",
      threadId: "t-1",
      runId: "thr-proof",
    }).pipe(
      Stream.runForEach((item) => Effect.sync(() => items.push(item))),
      Effect.provide(layer),
      Effect.forkChild,
    );
    for (let i = 0; i < 20; i += 1) {
      yield* Effect.yieldNow;
    }
    const ws = sockets[0]!;
    ws.open();
    ws.serverMessage(WIRE_USER);
    // Epoch changes: the feed was recreated. The stream must emit a fresh snapshot
    // BEFORE the replayed-from-zero event, or the client folds new facts onto stale ones.
    ws.serverMessage(WIRE_USER_NEW_EPOCH);
    for (let i = 0; i < 30; i += 1) {
      yield* Effect.yieldNow;
    }
    yield* Fiber.interrupt(fiber);

    const kinds = items.map((i) => i.kind);
    const secondSnapshot = kinds.indexOf("snapshot", 1);
    assert.isAbove(secondSnapshot, 0, "reset produced a re-basing snapshot");
    assert.equal(kinds[secondSnapshot + 1], "event", "replayed event follows the snapshot");
  }).pipe(Effect.provide(TestClock.layer())),
);
