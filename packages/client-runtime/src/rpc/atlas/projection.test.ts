import { OrchestrationEvent } from "@t3tools/contracts";
import type { FeedFrame } from "@t3tools/contracts/atlas";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import fixtures from "./__fixtures__/atlas-feed-frames.json" with { type: "json" };
import { applyFeedEvent, initialProjectionState, type ProjectionState } from "./projection.ts";

const decode = Schema.decodeUnknownSync(OrchestrationEvent);

const feed = (frame: unknown) => ({ kind: "frame", frame: frame as FeedFrame }) as const;
const turnDone = {
  version: 1,
  epoch: 1,
  seq: 99,
  ts: 1785704326000,
  run_id: "thr-proof",
  role: "agent",
  kind: "turn",
  payload: { state: "done" },
};

const replay = (frames: ReadonlyArray<unknown>) => {
  let state: ProjectionState = initialProjectionState("t-1", "thr-proof");
  const events: Array<OrchestrationEvent> = [];
  for (const f of frames) {
    const r = applyFeedEvent(state, feed(f));
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
};

it("replays the real fixture into schema-legal events with one monotonic sequence", () => {
  const { state, events } = replay([...fixtures, turnDone]);
  // Every event must decode through the REAL contract schema — a shape lie fails here.
  for (const e of events) decode(e);
  const seqs = events.map((e) => e.sequence as number);
  assert.deepEqual(
    seqs,
    seqs.map((_, i) => i + 1),
    "one monotonic sequence, no gaps",
  );
  assert.equal(state.sequence, seqs.at(-1), "snapshotSequence source == last emitted");
  const types = events.map((e) => e.type);
  assert.include(types, "thread.message-sent");
  assert.include(types, "thread.session-set");
  assert.include(types, "thread.activity-appended");
  assert.include(types, "thread.turn-diff-completed");
  // sweep: the assistant message finalizes at turn end
  const finals = events.filter(
    (e) =>
      e.type === "thread.message-sent" &&
      (e.payload as { streaming: boolean }).streaming === false &&
      (e.payload as { role: string }).role === "assistant",
  );
  assert.isAtLeast(finals.length, 1, "turn-end sweep finalized the assistant message");
});

it("drops a turn-close for a turn we are not in (strict guard)", () => {
  const { events } = replay([turnDone]);
  assert.deepEqual(events, [], "a stale close must not fabricate a session transition");
});

it("diff file activities get unique ids", () => {
  const diff = (fixtures as Array<{ kind: string }>).find((f) => f.kind === "diff")!;
  const start = (fixtures as Array<{ kind: string }>).find((f) => f.kind === "turn")!;
  const { events } = replay([
    start,
    { ...diff, payload: { unified: "x", files: [{ path: "a" }, { path: "b" }], checkpoint: 1 } },
  ]);
  const ids = events
    .filter((e) => e.type === "thread.activity-appended")
    .map((e) => (e.payload as { activity: { id: string } }).activity.id);
  assert.equal(new Set(ids).size, ids.length, "N file activities must not collide to 1");
});

it("a failed tool_result carries status failed", () => {
  const tr = (fixtures as Array<{ kind: string; payload: object }>).find(
    (f) => f.kind === "tool_result",
  )!;
  const { events } = replay([{ ...tr, payload: { tool: "run_bash", ok: false, summary: "boom" } }]);
  const a = events[0]!.payload as { activity: { payload: { status: string }; tone: string } };
  assert.equal(a.activity.payload.status, "failed");
  assert.equal(a.activity.tone, "error");
});

it("ctx with used<=0 emits nothing", () => {
  const ctx = (fixtures as Array<{ kind: string }>).find((f) => f.kind === "ctx")!;
  const { events } = replay([{ ...ctx, payload: { used: 0, window: 200000 } }]);
  assert.deepEqual(events, []);
});
