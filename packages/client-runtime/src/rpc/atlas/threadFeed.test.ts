import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import { openThreadFeed, type ThreadFeedEvent } from "./threadFeed.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  readyState = 0;
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: SocketEventType, listener: SocketListener) {
    const set = this.listeners.get(type) ?? new Set<SocketListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(_data: string) {}
  close() {
    if (this.readyState === 3) {
      return;
    }
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
  serverClose() {
    this.close();
  }
  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const EPOCH = 1700000000000;

const frame = (
  kind: string,
  seq: number,
  overrides?: { epoch?: number; role?: string; payload?: unknown },
) =>
  JSON.stringify({
    version: 1,
    epoch: overrides?.epoch ?? EPOCH,
    seq,
    ts: 1700000000100 + seq,
    run_id: "thr-t",
    role: overrides?.role ?? "agent",
    kind,
    payload: overrides?.payload ?? { text: `m${seq}` },
  });

const PERMISSION_ERROR_FRAME = JSON.stringify({
  version: 1,
  kind: "error",
  class: "permission_error",
  error: "forbidden: this run belongs to someone else",
});

const heartbeat = (seq: number, epoch = EPOCH) =>
  JSON.stringify({ version: 1, kind: "hb", run_id: "thr-t", ts: 1700000000500, seq, epoch });

const harness = Effect.fn("harness")(function* (options?: {
  cursor?: { afterSequence: number; epoch: number };
}) {
  const sockets: TestWebSocket[] = [];
  const layer = Layer.succeed(Socket.WebSocketConstructor, ((url: string) => {
    const ws = new TestWebSocket(url);
    sockets.push(ws);
    return ws as unknown as globalThis.WebSocket;
  }) as (url: string, protocols?: string | Array<string>) => globalThis.WebSocket);

  const events: ThreadFeedEvent[] = [];
  const fiber = yield* openThreadFeed({
    socketBaseUrl: "http://node.test",
    runId: "thr-t",
    accessToken: "secret-token",
    cursor: options?.cursor,
    backoff: { initialMillis: 2, factor: 1, capMillis: 2 },
  }).pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.provide(layer),
    Effect.forkChild,
  );

  const drain = Effect.gen(function* () {
    for (let i = 0; i < 20; i += 1) {
      yield* Effect.yieldNow;
    }
  });
  yield* drain;
  return { sockets, events, fiber, drain };
});

const kinds = (events: ReadonlyArray<ThreadFeedEvent>) =>
  events.map((e) => (e.kind === "frame" ? `frame:${e.frame.kind}(${e.frame.seq})` : e.kind));

it.effect("delivers frames in order and drops duplicates", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("assistant", 1));
    ws.serverMessage(frame("assistant", 2));
    // Replay overlap is the server's right; the duplicate is ours to drop. `>=` in the
    // dedupe comparison is the duplicate-on-resume bug.
    ws.serverMessage(frame("assistant", 2));
    ws.serverMessage(frame("assistant", 3));
    yield* h.drain;

    assert.deepEqual(kinds(h.events), [
      "connection",
      "frame:assistant(1)",
      "frame:assistant(2)",
      "frame:assistant(3)",
    ]);
    yield* Fiber.interrupt(h.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("console echoes advance the cursor without being forwarded", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("cmd", 1, { role: "console", payload: { text: "do it" } }));
    ws.serverMessage(frame("assistant", 2));
    yield* h.drain;

    // Not forwarded…
    assert.deepEqual(kinds(h.events), ["connection", "frame:assistant(2)"]);

    // …but delivered: the cursor moved past it, so the resume URL must start after it.
    ws.serverClose();
    yield* h.drain;
    yield* TestClock.adjust("10 millis");
    yield* h.drain;
    const resumed = new URL(h.sockets[1]!.url);
    assert.equal(resumed.searchParams.get("after"), "2");
    assert.equal(resumed.searchParams.get("epoch"), String(EPOCH));
    yield* Fiber.interrupt(h.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an epoch change resets state and replays from zero", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("assistant", 5));
    // The feed was recreated: seq restarts. Without the reset-before-dedupe order, every
    // replayed frame would read as a duplicate and the thread would render empty.
    ws.serverMessage(frame("assistant", 1, { epoch: EPOCH + 1 }));
    yield* h.drain;

    assert.deepEqual(kinds(h.events), [
      "connection",
      "frame:assistant(5)",
      "reset",
      "frame:assistant(1)",
    ]);
    yield* Fiber.interrupt(h.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an unknown kind is skipped without failing the stream", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("assistant", 1));
    // Additive wire evolution: a newer node's new kind must be ignorable, and its seq
    // must still advance the cursor (delivery advances, rendering doesn't).
    ws.serverMessage(frame("kind-from-the-future", 2));
    ws.serverMessage(frame("assistant", 3));
    yield* h.drain;

    assert.deepEqual(kinds(h.events), ["connection", "frame:assistant(1)", "frame:assistant(3)"]);
    yield* Fiber.interrupt(h.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("the first heartbeat marks replay-complete and is never forwarded", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("assistant", 1));
    ws.serverMessage(frame("assistant", 2));
    ws.serverMessage(heartbeat(2));
    ws.serverMessage(heartbeat(2)); // later heartbeats are liveness only
    yield* h.drain;

    assert.deepEqual(kinds(h.events), [
      "connection",
      "frame:assistant(1)",
      "frame:assistant(2)",
      "replay-complete",
    ]);
    const boundary = h.events.find((e) => e.kind === "replay-complete");
    assert.deepEqual(boundary, { kind: "replay-complete", head: 2, epoch: EPOCH });
    yield* Fiber.interrupt(h.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("socket loss reconnects with the cursor pair and never terminates the stream", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(frame("assistant", 7));
    yield* h.drain;
    ws.serverClose();
    yield* h.drain;
    yield* TestClock.adjust("10 millis");
    yield* h.drain;

    // Rule zero: a connection fact, not a run fact — the stream reported and resumed.
    assert.include(kinds(h.events), "connection");
    assert.equal(h.sockets.length, 2, "a new socket was opened");
    const resumed = new URL(h.sockets[1]!.url);
    // Together or not at all.
    assert.equal(resumed.searchParams.get("after"), "7");
    assert.equal(resumed.searchParams.get("epoch"), String(EPOCH));
    // Interruption succeeding proves the stream was still alive — a terminated fiber
    // would surface its own exit instead.
    const exit = yield* Fiber.interrupt(h.fiber).pipe(Effect.flatMap(() => Fiber.await(h.fiber)));
    assert.isTrue(exit._tag === "Failure", "ended by OUR interrupt, not its own failure");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a cursor without its epoch is never sent", () =>
  Effect.gen(function* () {
    // No cursor at all: neither parameter appears — `after` alone would resume into an
    // unverified epoch and silently merge two feeds' histories.
    const bare = yield* harness();
    const bareUrl = new URL(bare.sockets[0]!.url);
    assert.isNull(bareUrl.searchParams.get("after"));
    assert.isNull(bareUrl.searchParams.get("epoch"));
    yield* Fiber.interrupt(bare.fiber);

    const paired = yield* harness({ cursor: { afterSequence: 9, epoch: EPOCH } });
    const pairedUrl = new URL(paired.sockets[0]!.url);
    assert.equal(pairedUrl.searchParams.get("after"), "9");
    assert.equal(pairedUrl.searchParams.get("epoch"), String(EPOCH));
    yield* Fiber.interrupt(paired.fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a permission refusal fails the stream — retrying cannot fix auth", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const ws = h.sockets[0]!;
    ws.open();
    ws.serverMessage(PERMISSION_ERROR_FRAME);
    yield* h.drain;

    const exit = yield* Fiber.await(h.fiber);
    assert.isTrue(exit._tag === "Failure", "the stream fails typed instead of retrying");
    assert.equal(h.sockets.length, 1, "no reconnect after an authorization refusal");
  }).pipe(Effect.provide(TestClock.layer())),
);
