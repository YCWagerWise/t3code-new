/**
 * E2E actions 051-066: commands that currently ACK success in the Rust
 * backend but do not persist their reducer-visible state.
 *
 * These cases are intentionally red until backend/src/server_main.rs handles
 * the command instead of falling through to the generic success ACK. The test
 * shape is fixed here so the browser runner cannot accidentally pass by
 * observing only optimistic client state:
 *
 *   1. drive the UI affordance
 *   2. assert the RPC ACK is Success
 *   3. assert the optimistic reducer applied the visible state
 *   4. reload the page
 *   5. assert the state survived replay from the Rust backend
 */

export type NoopCommandCase = {
  readonly id: number;
  readonly command: string;
  readonly uiAction: string;
  readonly optimisticSignal: string;
  readonly durableSignal: string;
};

export const noopCommandCases: readonly NoopCommandCase[] = [
  {
    id: 51,
    command: "thread.create",
    uiAction: "create a thread from the composer/sidebar",
    optimisticSignal: "new thread route and sidebar row appear",
    durableSignal: "thread remains in the replayed sidebar and thread snapshot after reload",
  },
  {
    id: 52,
    command: "thread.delete",
    uiAction: "delete the active thread",
    optimisticSignal: "thread disappears from the visible list",
    durableSignal: "thread stays deleted after reload and does not reappear from snapshot",
  },
  {
    id: 53,
    command: "thread.archive",
    uiAction: "archive the active thread",
    optimisticSignal: "thread leaves the active-thread list",
    durableSignal: "archivedAt is replayed and the thread stays out of the active list after reload",
  },
  {
    id: 54,
    command: "thread.unarchive",
    uiAction: "restore an archived thread",
    optimisticSignal: "thread returns to the active-thread list",
    durableSignal: "archivedAt remains null after reload",
  },
  {
    id: 55,
    command: "thread.settle",
    uiAction: "settle the active thread",
    optimisticSignal: "thread status becomes settled/idle in the UI",
    durableSignal: "settled state is replayed after reload",
  },
  {
    id: 56,
    command: "thread.unsettle",
    uiAction: "unsettle a settled thread",
    optimisticSignal: "settled indicator clears",
    durableSignal: "unsettled state is replayed after reload",
  },
  {
    id: 57,
    command: "thread.snooze",
    uiAction: "snooze the active thread",
    optimisticSignal: "thread leaves the unsnoozed list or shows snoozed state",
    durableSignal: "snoozedUntil is replayed after reload",
  },
  {
    id: 58,
    command: "thread.unsnooze",
    uiAction: "unsnooze a snoozed thread",
    optimisticSignal: "snoozed state clears",
    durableSignal: "snoozedUntil remains null after reload",
  },
  {
    id: 59,
    command: "thread.pin",
    uiAction: "pin the active thread",
    optimisticSignal: "thread appears in the pinned group",
    durableSignal: "pinned state is replayed after reload",
  },
  {
    id: 60,
    command: "thread.unpin",
    uiAction: "unpin a pinned thread",
    optimisticSignal: "thread leaves the pinned group",
    durableSignal: "pinned state remains absent after reload",
  },
  {
    id: 61,
    command: "thread.pin.reorder",
    uiAction: "reorder pinned threads",
    optimisticSignal: "pinned order changes",
    durableSignal: "pinned order is replayed after reload",
  },
  {
    id: 62,
    command: "thread.runtime-mode.set",
    uiAction: "change runtime mode",
    optimisticSignal: "runtime mode selector shows the new value",
    durableSignal: "runtime mode is replayed after reload",
  },
  {
    id: 63,
    command: "thread.interaction-mode.set",
    uiAction: "change interaction mode",
    optimisticSignal: "interaction mode selector shows the new value",
    durableSignal: "interaction mode is replayed after reload",
  },
  {
    id: 64,
    command: "thread.session.set",
    uiAction: "bind a session to the thread",
    optimisticSignal: "session status appears on the thread",
    durableSignal: "session binding is replayed after reload",
  },
  {
    id: 65,
    command: "thread.activity.append",
    uiAction: "append a thread activity item",
    optimisticSignal: "activity appears in the timeline",
    durableSignal: "activity is replayed after reload",
  },
  {
    id: 66,
    command: "project.create",
    uiAction: "create a project",
    optimisticSignal: "project appears in the sidebar/project picker",
    durableSignal: "project remains after reload and projects.list",
  },
  {
    id: 66,
    command: "project.delete",
    uiAction: "delete a project",
    optimisticSignal: "project disappears from the sidebar/project picker",
    durableSignal: "project remains deleted after reload and projects.list",
  },
];

export function assertNoopCommandCoverage(cases: readonly NoopCommandCase[] = noopCommandCases) {
  const expected = new Set([
    "thread.create",
    "thread.delete",
    "thread.archive",
    "thread.unarchive",
    "thread.settle",
    "thread.unsettle",
    "thread.snooze",
    "thread.unsnooze",
    "thread.pin",
    "thread.unpin",
    "thread.pin.reorder",
    "thread.runtime-mode.set",
    "thread.interaction-mode.set",
    "thread.session.set",
    "thread.activity.append",
    "project.create",
    "project.delete",
  ]);
  const actual = new Set(cases.map((testCase) => testCase.command));
  for (const command of expected) {
    if (!actual.has(command)) throw new Error(`missing noop-command e2e case for ${command}`);
  }
  if (actual.size !== expected.size) {
    throw new Error(`unexpected noop-command e2e case count ${actual.size}`);
  }
}

assertNoopCommandCoverage();
