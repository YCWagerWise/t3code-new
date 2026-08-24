import { describe, expect, it } from "vite-plus/test";

import { terminalOwnerKey, terminalPaneKey } from "./terminal.ts";

/**
 * #149: a terminal command must be able to NAME a child session's pane.
 *
 * These keys are the concurrency keys for terminal commands: lifecycle
 * (open/clear/restart/close) is `serial` per owner key, and `resize` is
 * `latest` per pane key. So two panes sharing a key do not merely queue — a
 * `latest` scheduler DROPS the command it supersedes. Collapsing two subagents
 * onto one key loses one of their resizes outright.
 */
describe("terminal command addressing", () => {
  const environmentId = "env-1";

  it("gives two child sessions of the same thread DIFFERENT keys", () => {
    // The exact shape #149 describes: one thread, two subagents, each with its
    // own session and worktree. Under thread-only addressing both produced
    // JSON.stringify(["env-1", "t-1"]) and shared one serial queue.
    const a = terminalOwnerKey({
      environmentId,
      input: { threadId: "t-1", sessionId: "sess-a" },
    });
    const b = terminalOwnerKey({
      environmentId,
      input: { threadId: "t-1", sessionId: "sess-b" },
    });
    expect(a).not.toBe(b);
  });

  it("gives two child sessions with NO thread different keys", () => {
    // The worse half: with `threadId` absent, thread-only addressing produced
    // ["env-1", undefined] for EVERY subagent in the environment — one key for
    // all of them.
    const a = terminalOwnerKey({ environmentId, input: { sessionId: "sess-a" } });
    const b = terminalOwnerKey({ environmentId, input: { sessionId: "sess-b" } });
    expect(a).not.toBe(b);
    expect(a).not.toContain("undefined");
  });

  it("lets sessionId WIN over threadId, matching the runtime's own resolution", () => {
    // backend/src/terminal.rs resolves a pane target with sessionId winning
    // over threadId. A client that ordered these differently would serialize
    // commands under one identity while the server ran them under another.
    expect(terminalOwnerKey({ environmentId, input: { threadId: "t-1", sessionId: "s-1" } })).toBe(
      terminalOwnerKey({ environmentId, input: { threadId: "t-2", sessionId: "s-1" } }),
    );
  });

  it("keeps thread panes addressable exactly as before", () => {
    // Regression guard: the thread path is the one that already worked, and
    // #149 must not be "fixed" by breaking it.
    const a = terminalOwnerKey({ environmentId, input: { threadId: "t-1" } });
    const b = terminalOwnerKey({ environmentId, input: { threadId: "t-2" } });
    expect(a).not.toBe(b);
    expect(terminalOwnerKey({ environmentId, input: { threadId: "t-1" } })).toBe(a);
  });

  it("separates environments, so the same session id on two backends never collides", () => {
    expect(terminalOwnerKey({ environmentId: "env-1", input: { sessionId: "s" } })).not.toBe(
      terminalOwnerKey({ environmentId: "env-2", input: { sessionId: "s" } }),
    );
  });

  it("separates panes of ONE owner, and does not confuse a pane with its owner", () => {
    const one = terminalPaneKey({
      environmentId,
      input: { sessionId: "s-1", terminalId: "term-1" },
    });
    const two = terminalPaneKey({
      environmentId,
      input: { sessionId: "s-1", terminalId: "term-2" },
    });
    expect(one).not.toBe(two);
    // A thread and a session that happen to share an id string are different
    // owners; the tag in the key is what keeps them apart.
    expect(terminalOwnerKey({ environmentId, input: { sessionId: "x" } })).not.toBe(
      terminalOwnerKey({ environmentId, input: { threadId: "x" } }),
    );
  });
});
