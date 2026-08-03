import { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { mapCatalog, openShellStream, type ShellStreamItem } from "./shellStream.ts";

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

const WORKSPACES = {
  workspaces: [
    {
      workspace_id: "ws-1",
      root: "/repo",
      name: "repo",
      created_at: 1000,
      updated_at: 2000,
      archived: 0,
    },
  ],
};
const RUNS = {
  runs: [
    {
      run_id: "thr-t1",
      kind: "thread",
      workspace_id: "ws-1",
      created_at: 1000,
      updated_at: 2000,
      status: "active",
    },
  ],
};

it("maps real catalog rows into a schema-legal shell snapshot", () => {
  const catalog = mapCatalog(WORKSPACES, RUNS);
  const snapshot = decodeSnapshot({
    snapshotSequence: 0,
    projects: catalog.projects,
    threads: catalog.threads,
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(snapshot.projects[0]!.id, "ws-1");
  assert.equal(snapshot.threads[0]!.id, "t1", "lens id strips the node's thr- marker");
});

it.effect("polls: snapshot+synchronized first, then upserts and removals with sequences", () =>
  Effect.gen(function* () {
    const catalogs = yield* Ref.make(mapCatalog(WORKSPACES, RUNS));
    const items: ShellStreamItem[] = [];
    const fiber = yield* openShellStream({
      fetchCatalog: Ref.get(catalogs),
      intervalMillis: 1000,
      nowMillis: Effect.succeed(1754179200000),
    }).pipe(
      Stream.runForEach((i) => Effect.sync(() => items.push(i))),
      Effect.forkChild,
    );
    for (let i = 0; i < 10; i += 1) {
      yield* Effect.yieldNow;
    }
    assert.deepEqual(
      items.map((i) => i.kind),
      ["snapshot", "synchronized"],
    );

    // A changed thread and a vanished project must surface as events on the next poll.
    yield* Ref.set(
      catalogs,
      mapCatalog(
        { workspaces: [] },
        {
          runs: [
            {
              run_id: "thr-t1",
              kind: "thread",
              workspace_id: "ws-1",
              created_at: 1000,
              updated_at: 3000,
              status: "done",
            },
          ],
        },
      ),
    );
    yield* TestClock.adjust("1100 millis");
    for (let i = 0; i < 10; i += 1) {
      yield* Effect.yieldNow;
    }
    const kinds = items.map((i) => i.kind);
    assert.include(kinds, "thread-upserted");
    assert.include(kinds, "project-removed");
    const seqs = items
      .filter((i) => "sequence" in i)
      .map((i) => (i as { sequence: number }).sequence);
    assert.deepEqual(
      seqs,
      seqs.map((_, n) => n + 1),
      "event sequences are monotonic from 1",
    );

    // An unchanged poll emits nothing — the sidebar must not churn.
    const before = items.length;
    yield* TestClock.adjust("1100 millis");
    for (let i = 0; i < 10; i += 1) {
      yield* Effect.yieldNow;
    }
    assert.equal(items.length, before, "no-change poll produced no events");
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(TestClock.layer())),
);
