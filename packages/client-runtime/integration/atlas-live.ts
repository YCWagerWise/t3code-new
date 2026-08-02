// Live rig: doc 15 steps 1.2 + 1.3 against a booted node. Run: node integration/atlas-live.ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Socket from "effect/unstable/socket/Socket";
import { openThreadFeed } from "../src/rpc/atlas/threadFeed.ts";

const BASE = "http://127.0.0.1:3199";
let live: WebSocket | null = null;
const ctor = Layer.succeed(Socket.WebSocketConstructor, ((url: string) => {
  live = new WebSocket(url);
  return live;
}) as (url: string) => globalThis.WebSocket);

const main = Effect.gen(function* () {
  const seen: Array<{ kind: string; seq: number }> = [];
  let head = 0;
  let killed = false;
  const fiber = yield* openThreadFeed({
    socketBaseUrl: BASE,
    runId: "thr-rig",
    accessToken: "dev",
    backoff: { initialMillis: 200, factor: 1.5, capMillis: 1000 },
  }).pipe(
    Stream.runForEach((e) =>
      Effect.sync(() => {
        if (e.kind === "frame") {
          seen.push({ kind: e.frame.kind, seq: Number(e.frame.seq) });
          if (!killed && seen.length === 5) {
            killed = true;
            live?.close();
          } // 1.3 kill
        }
        if (e.kind === "replay-complete") head = e.head;
      }),
    ),
    Effect.forkChild,
  );
  yield* Effect.sleep(6000);
  yield* Fiber.interrupt(fiber);
  const seqs = seen.map((s) => s.seq);
  const dupes = seqs.filter((s, i) => seqs.indexOf(s) !== i);
  const ordered = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
  console.log(
    JSON.stringify({
      frames: seen.length,
      head,
      ordered,
      dupes,
      kinds: seen.map((s) => s.kind).join("→"),
    }),
  );
});
Effect.runPromise(main.pipe(Effect.provide(ctor))).catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
