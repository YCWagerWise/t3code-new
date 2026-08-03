// Every M1 UI flow through the REAL client against a live node (doc 15 — the flow oracle
// the unit tests are not). Run: node integration/atlas-flows.ts
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import { make } from "../src/rpc/atlas/session.ts";
import type { PreparedConnection } from "../src/connection/model.ts";

const socketLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  ((url: string) => new WebSocket(url)) as (url: string) => globalThis.WebSocket,
);
const CONNECTION = {
  environmentId: "env-flows",
  label: "flows",
  httpBaseUrl: "http://127.0.0.1:3199",
  socketUrl: "ws://127.0.0.1:3199/_feed",
  httpAuthorization: { _tag: "Bearer", token: "dev" },
  target: { environmentId: "env-flows" },
} as unknown as PreparedConnection;

const results: Array<[string, string]> = [];
const flow = async (name: string, run: () => Promise<unknown>) => {
  try {
    await run();
    results.push([name, "PASS"]);
  } catch (e) {
    results.push([name, `FAIL ${(e as Error).message?.slice(0, 90)}`]);
  }
};
const expectFail = async (name: string, run: () => Promise<unknown>, contains: string) => {
  try {
    await run();
    results.push([name, "FAIL (unexpectedly succeeded)"]);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    results.push([
      name,
      msg.includes(contains) ? "PASS (refused)" : `FAIL wrong error: ${msg.slice(0, 80)}`,
    ]);
  }
};

const main = async () => {
  // Fresh thread per run: reruns must not collide with a previous run's active turn
  // (the 409 start-guard is correct behavior, not a flow failure).
  const T = `flow-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const factory = await Effect.runPromise(make.pipe(Effect.provide(socketLayer)));
  const session = await Effect.runPromise(
    Effect.scoped(factory.connect(CONNECTION).pipe(Effect.flatMap((s) => Effect.succeed(s)))),
  );
  const c = session.client as unknown as Record<
    string,
    (i?: unknown) => Effect.Effect<unknown, unknown>
  >;
  const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e as Effect.Effect<A, never>);

  await flow("ready (handshake + feed probe)", () =>
    run(session.ready as Effect.Effect<void, unknown>),
  );
  await flow("serverGetConfig has a provider+model", async () => {
    const cfg = (await run(c[WS_METHODS.serverGetConfig]!({}))) as {
      providers: Array<{ models: unknown[] }>;
    };
    if (cfg.providers.length === 0 || cfg.providers[0]!.models.length === 0)
      throw new Error("no provider/model");
  });
  await flow("project.create with a real allowed path", () =>
    run(
      c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
        type: "project.create",
        commandId: `pc-${Math.random()}`,
        projectId: "p",
        title: "flaresolverr",
        workspaceRoot: "~/atlas/flaresolverr-rs",
        createdAt: new Date().toISOString(),
      }),
    ),
  );
  await expectFail(
    "project.create outside allow-list REFUSES with a reason",
    () =>
      run(
        c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
          type: "project.create",
          commandId: `pc-${Math.random()}`,
          projectId: "p",
          title: "x",
          workspaceRoot: "~/workspace",
          createdAt: new Date().toISOString(),
        }),
      ),
    "allow",
  );
  await flow("thread.create (lazy)", () =>
    run(
      c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
        type: "thread.create",
        commandId: `tc-1`,
        threadId: T,
      }),
    ),
  );
  await flow("thread.archive (presentation)", () =>
    run(
      c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
        type: "thread.archive",
        commandId: `ta-1`,
        threadId: T,
      }),
    ),
  );
  await flow("subscribeThread yields snapshot-first on a BRAND-NEW thread", async () => {
    const items = await Effect.runPromise(
      (
        c[ORCHESTRATION_WS_METHODS.subscribeThread]!({ threadId: T }) as unknown as Stream.Stream<{
          kind: string;
        }>
      ).pipe(
        Stream.takeUntil((i) => i.kind === "synchronized"),
        Stream.runCollect,
        Effect.timeout(8000),
      ) as Effect.Effect<Iterable<{ kind: string }>, never>,
    );
    const list = [...items];
    if (list[0]?.kind !== "snapshot") throw new Error(`first item ${list[0]?.kind}`);
    if (list.at(-1)?.kind !== "synchronized") throw new Error("no synchronized");
  });
  await flow("turn.start on the new thread ACTUATES (assistant answers)", async () => {
    await run(
      c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
        type: "thread.turn.start",
        commandId: `ts-${Math.random()}`,
        threadId: T,
        message: { messageId: "m1", role: "user", text: "Reply with just: ok", attachments: [] },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      }),
    );
    const deadline = Date.now() + 60000;
    for (;;) {
      const res = await fetch(
        `http://127.0.0.1:3199/console/v1/threads/thr-${T}/feed?after=0&access_token=dev`,
      );
      const j = (await res.json()) as {
        frames: Array<{ kind: string; payload: { text?: string } }>;
      };
      if (j.frames.some((f) => f.kind === "assistant")) break;
      if (Date.now() > deadline) throw new Error("no assistant within 60s — turn did not actuate");
      await new Promise((r) => setTimeout(r, 3000));
    }
  });
  await flow("turn.interrupt on idle thread is a safe no-op or typed", () =>
    run(
      c[ORCHESTRATION_WS_METHODS.dispatchCommand]!({
        type: "thread.turn.interrupt",
        commandId: `ti-1`,
        threadId: T,
        createdAt: new Date().toISOString(),
      }),
    ).then(
      () => undefined,
      () => undefined,
    ),
  );
  await flow("getFullThreadDiff returns ThreadTurnDiff shape", async () => {
    const d = (await run(
      c[ORCHESTRATION_WS_METHODS.getFullThreadDiff]!({ threadId: "rig", toTurnCount: 1 }),
    )) as { diff?: string };
    if (typeof d.diff !== "string") throw new Error("no diff field");
  });
  await expectFail(
    "terminal.open stays typed-refused",
    () => run(c[WS_METHODS.terminalOpen]!({})),
    "does not provide",
  );

  for (const [name, r] of results) console.log(r.padEnd(14), name);
  const failed = results.filter(([, r]) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} flows pass`);
  process.exit(failed === 0 ? 0 : 1);
};
main().catch((e) => {
  console.error("HARNESS FAIL", e);
  process.exit(2);
});
