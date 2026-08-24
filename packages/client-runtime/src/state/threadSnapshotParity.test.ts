import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationThreadStreamItem } from "@t3tools/contracts";
import type { OrchestrationEvent } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";
// JSON module import — the bytes are the ones the Rust producer wrote.
import threadSnapshot from "../../../contracts/fixtures/subscribe_thread_worktree_snapshot.json" with { type: "json" };

/**
 * #6 / #2: reducer-visible contract parity for the thread-detail snapshot.
 *
 * `t3code-new/backend/src/contract_tests.rs::subscribe_thread_worktree_snapshot_is_a_recorded_fixture`
 * captures a REAL `orchestration.subscribeThread` snapshot frame from the
 * running handler — for a thread whose durable metadata is entirely
 * non-default: read-only runtime mode, `plan` interaction mode, a branch, and a
 * worktree — and writes it verbatim.
 *
 * Why this test and not another Rust assertion. The defect in #2 was a snapshot
 * that hard-coded `runtimeMode: "full-access"`, `branch: null` and
 * `worktreePath: null` beside the durable row it had just loaded. That frame
 * DECODES CLEANLY: the schema cannot tell a lie from a fact. The only thing
 * that catches it is comparing what the REDUCER ends up holding against what
 * the store recorded — which is what happens below, through the same contract
 * union and the same reducer the app runs.
 *
 * Honest limit: this is the snapshot/lifecycle-metadata half of the stop
 * condition. It is not the composed new-thread → streaming → cancel → approval
 * flow, which needs a browser this suite does not have.
 */
describe("subscribeThread snapshot reducer parity", () => {
  const decoded = Schema.decodeUnknownSync(OrchestrationThreadStreamItem)(threadSnapshot);

  it("decodes as a snapshot through the contract the reducer uses", () => {
    assert.strictEqual(decoded.kind, "snapshot");
  });

  it("carries the thread's DURABLE lifecycle metadata, not defaults", () => {
    if (decoded.kind !== "snapshot") throw new Error("not a snapshot");
    const thread = decoded.snapshot.thread;
    // Each assertion is one field the old hand-built snapshot hard-coded.
    assert.strictEqual(thread.runtimeMode, "approval-required");
    assert.strictEqual(thread.interactionMode, "plan");
    assert.strictEqual(thread.branch, "feat/sink");
    assert.strictEqual(thread.worktreePath, "/workspace/wt/t-wt-fixture");
    assert.strictEqual(thread.projectId, "p-1");
    assert.strictEqual(thread.latestTurn, null);
  });

  it("survives the reducer: an unrelated event does not reset the metadata", () => {
    if (decoded.kind !== "snapshot") throw new Error("not a snapshot");
    const thread = decoded.snapshot.thread;
    // A project event the thread reducer explicitly ignores. The point is not
    // the event — it is that the reducer's own output still holds the durable
    // metadata, so a client that has applied real traffic is still looking at a
    // read-only worktree thread rather than drifting to defaults.
    const event = {
      type: "project.meta-updated",
      payload: { projectId: thread.projectId, updatedAt: thread.updatedAt },
    } as unknown as OrchestrationEvent;
    const result = applyThreadDetailEvent(thread, event);
    assert.strictEqual(result.kind, "unchanged");

    // And the reducer's notion of THIS thread — the object the UI renders — is
    // still the durable one.
    const rendered = result.kind === "updated" ? result.thread : thread;
    assert.strictEqual(rendered.runtimeMode, "approval-required");
    assert.strictEqual(rendered.worktreePath, "/workspace/wt/t-wt-fixture");
    assert.strictEqual(rendered.branch, "feat/sink");
  });
});
