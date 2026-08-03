import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import { WS_METHODS } from "@t3tools/contracts";
import { make } from "../src/rpc/atlas/session.ts";
import type { PreparedConnection } from "../src/connection/model.ts";

const socketLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  ((url: string) => new WebSocket(url)) as (url: string) => globalThis.WebSocket,
);
const CONNECTION = {
  environmentId: "e",
  label: "p",
  httpBaseUrl: "http://127.0.0.1:3199",
  socketUrl: "ws://127.0.0.1:3199/_feed",
  httpAuthorization: { _tag: "Bearer", token: "dev" },
  target: {},
} as unknown as PreparedConnection;

const main = Effect.gen(function* () {
  const factory = yield* make.pipe(Effect.provide(socketLayer));
  const session = yield* factory.connect(CONNECTION);
  const c = session.client as unknown as Record<
    string,
    (i: unknown) => Effect.Effect<unknown, unknown>
  >;
  for (const partialPath of ["~/", "~/at", "~/U", "~/D"]) {
    const r = (yield* c[WS_METHODS.filesystemBrowse]!({ partialPath }).pipe(Effect.orDie)) as {
      entries: Array<{ name: string }>;
    };
    console.log(
      JSON.stringify({
        partialPath,
        count: r.entries.length,
        first: r.entries.slice(0, 5).map((e) => e.name),
      }),
    );
  }
});
Effect.runPromise(Effect.scoped(main)).catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
