//! PROOF (#149): a PTY owned by a child session is ADDRESSABLE.
//!
//! The frontend half of #149 was never a missing feature — it was a missing
//! TYPE. `KnownTerminalSessionTarget` hardcoded `threadId`, so a subagent's
//! terminal could not be named at all, and the selection layer had no honest
//! option but to filter it out. These tests pin the property that made it
//! unrepresentable, so it cannot regress back into a thread-only address.

import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  ownerSessionId,
  ownerThreadId,
  sameTerminalOwner,
  terminalOwnerOfSummary,
  terminalTargetKey,
  type KnownTerminalSessionTarget,
} from "./terminalSession.ts";

const ENV = EnvironmentId.make("env-local");

const threadPane: KnownTerminalSessionTarget = {
  environmentId: ENV,
  owner: { kind: "thread", threadId: ThreadId.make("thread-1") },
  terminalId: "term-1",
};

const sessionPane: KnownTerminalSessionTarget = {
  environmentId: ENV,
  owner: {
    kind: "session",
    sessionId: "sess-sub-9",
    worktreePath: "/tmp/wt/sub-9",
  },
  terminalId: "term-1",
};

describe("terminal owner addressing (#149)", () => {
  it("names a child session's PTY, which the thread-only target could not express", () => {
    expect(ownerSessionId(sessionPane)).toBe("sess-sub-9");
    // The point of the finding: a subagent row can now reach its own worktree
    // shell instead of being handed the parent thread's terminal.
    expect(sessionPane.owner.kind === "session" && sessionPane.owner.worktreePath).toBe(
      "/tmp/wt/sub-9",
    );
  });

  it("keeps the two owners mutually exclusive rather than nullable-and-both", () => {
    // The contract union (`TerminalTargetInput`) refused `{threadId, sessionId}`
    // with one null because it makes the disagreeing state representable. The
    // frontend target must not reintroduce it one layer up.
    expect(ownerThreadId(threadPane)).toBe("thread-1");
    expect(ownerSessionId(threadPane)).toBeNull();

    expect(ownerSessionId(sessionPane)).toBe("sess-sub-9");
    expect(ownerThreadId(sessionPane)).toBeNull();
  });

  it("does not collide a thread and a session that share an id and terminal", () => {
    // Both panes are `term-1`. Before the key was namespaced by owner kind, a
    // subagent whose session id matched a thread id would have overwritten that
    // thread's drawer in any map keyed by target.
    const collidingThread: KnownTerminalSessionTarget = {
      environmentId: ENV,
      owner: { kind: "thread", threadId: ThreadId.make("same-id") },
      terminalId: "term-1",
    };
    const collidingSession: KnownTerminalSessionTarget = {
      environmentId: ENV,
      owner: { kind: "session", sessionId: "same-id", worktreePath: null },
      terminalId: "term-1",
    };

    expect(terminalTargetKey(collidingThread)).not.toBe(terminalTargetKey(collidingSession));
  });

  it("is stable for the same pane, so a drawer is not remounted every render", () => {
    expect(terminalTargetKey(sessionPane)).toBe(terminalTargetKey({ ...sessionPane }));
  });
});

describe("decoding a pane owner off the wire (#149)", () => {
  it("THE REGRESSION: a child-session summary decodes instead of being dropped", () => {
    // This is the exact shape `TerminalOwner::wire` emits for a subagent PTY:
    // threadId null, sessionId set. The selection layer used to FILTER these
    // out — `.filter(summary => summary.threadId !== null)` — because the
    // target type could not name them. If this returns null again, every
    // subagent terminal silently disappears from the UI once more.
    const owner = terminalOwnerOfSummary({
      threadId: null,
      sessionId: "sess-sub-9",
      worktreePath: "/tmp/wt/sub-9",
    });

    expect(owner).not.toBeNull();
    expect(owner?.kind).toBe("session");
    expect(owner?.kind === "session" && owner.sessionId).toBe("sess-sub-9");
    expect(owner?.kind === "session" && owner.worktreePath).toBe("/tmp/wt/sub-9");
  });

  it("reads a thread pane exactly as before, so existing drawers are unaffected", () => {
    const owner = terminalOwnerOfSummary({ threadId: "thread-1", sessionId: null });
    expect(owner?.kind).toBe("thread");
    expect(owner?.kind === "thread" && owner.threadId).toBe("thread-1");
  });

  it("treats an ABSENT sessionId as a thread pane, not as an undecodable one", () => {
    // `sessionId` is `optional` in the contract because the TypeScript server
    // does not emit the key yet. Absent and null must both mean 'thread pane',
    // or every pane from that server stops rendering.
    const owner = terminalOwnerOfSummary({ threadId: "thread-1" });
    expect(owner?.kind).toBe("thread");
  });

  it("gives thread ownership precedence, so a both-fields summary cannot be ambiguous", () => {
    // The wire promises exactly one, but a buggy or older producer could send
    // both. Precedence is fixed here rather than left to each call site.
    const owner = terminalOwnerOfSummary({ threadId: "thread-1", sessionId: "sess-9" });
    expect(owner?.kind).toBe("thread");
  });

  it("returns null for a summary naming NEITHER owner, rather than inventing one", () => {
    expect(terminalOwnerOfSummary({ threadId: null, sessionId: null })).toBeNull();
  });

  it("does not match a thread against a session that shares its id", () => {
    expect(
      sameTerminalOwner(
        { kind: "thread", threadId: ThreadId.make("x") },
        { kind: "session", sessionId: "x", worktreePath: null },
      ),
    ).toBe(false);
  });
});
