import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_ID,
  TerminalAttachInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalSummary,
  TerminalTargetInput,
  TerminalThreadInput,
  TerminalWriteInput,
} from "./terminal.ts";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalOpenInput", () => {
  it("accepts valid open input", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 120,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("accepts ultrawide terminal dimensions from xterm fit", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 423,
        rows: 40,
      }),
    ).toBe(true);
  });

  it("rejects invalid bounds", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        cols: 10,
        rows: 0,
      }),
    ).toBe(false);
  });

  it("requires terminalId — the client must always pick an id", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
      }),
    ).toBe(false);
  });

  it("accepts optional env overrides", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.t3/worktrees/feature-a",
      cols: 100,
      rows: 24,
      env: {
        T3CODE_PROJECT_ROOT: "/tmp/project",
        CUSTOM_FLAG: "1",
      },
    });
    expect(parsed.env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/tmp/project",
      CUSTOM_FLAG: "1",
    });
    expect(parsed.worktreePath).toBe("/tmp/project/.t3/worktrees/feature-a");
  });

  it("rejects invalid env keys", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
        env: {
          "bad-key": "1",
        },
      }),
    ).toBe(false);
  });
});

describe("TerminalAttachInput", () => {
  it("accepts explicit inactive-session restart intent", () => {
    const parsed = decodeSync(TerminalAttachInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: "/tmp/project",
      restartIfNotRunning: true,
    });

    expect(parsed.restartIfNotRunning).toBe(true);
  });
});

describe("TerminalWriteInput", () => {
  it("accepts non-empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "echo hello\n",
      }),
    ).toBe(true);
  });

  it("rejects empty data", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "",
      }),
    ).toBe(false);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalWriteInput, {
        threadId: "thread-1",
        data: "echo hello\n",
      }),
    ).toBe(false);
  });
});

describe("TerminalThreadInput", () => {
  it("trims thread ids", () => {
    const parsed = decodeSync(TerminalThreadInput, { threadId: " thread-1 " });
    expect(parsed.threadId).toBe("thread-1");
  });
});

describe("TerminalResizeInput", () => {
  it("accepts valid size", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 80,
        rows: 24,
      }),
    ).toBe(true);
  });

  it("rejects missing terminalId", () => {
    expect(
      decodes(TerminalResizeInput, {
        threadId: "thread-1",
        cols: 80,
        rows: 24,
      }),
    ).toBe(false);
  });
});

describe("TerminalClearInput", () => {
  it("requires terminalId", () => {
    expect(decodes(TerminalClearInput, { threadId: "thread-1" })).toBe(false);
  });

  it("accepts an explicit terminalId", () => {
    const parsed = decodeSync(TerminalClearInput, {
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalCloseInput", () => {
  it("accepts optional deleteHistory", () => {
    expect(
      decodes(TerminalCloseInput, {
        threadId: "thread-1",
        deleteHistory: true,
      }),
    ).toBe(true);
  });
});

describe("TerminalSessionSnapshot", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts running snapshots", () => {
    expect(
      decodes(TerminalSessionSnapshot, {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running",
        pid: 1234,
        history: "hello\n",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: isoTimestamp,
      }),
    ).toBe(true);
  });
});

describe("TerminalEvent", () => {
  const isoTimestamp = "2026-01-01T00:00:00.000Z";

  it("accepts output events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "output",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "line\n",
      }),
    ).toBe(true);
  });

  it("accepts exited events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "exited",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        exitCode: 0,
        exitSignal: null,
      }),
    ).toBe(true);
  });

  it("accepts closed events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "closed",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe(true);
  });

  it("accepts activity events", () => {
    expect(
      decodes(TerminalEvent, {
        type: "activity",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        hasRunningSubprocess: true,
        label: "vim",
      }),
    ).toBe(true);
  });

  it("accepts started events with snapshot worktree metadata", () => {
    expect(
      decodes(TerminalEvent, {
        type: "started",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        snapshot: {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: "/tmp/project/.t3/worktrees/feature-a",
          worktreePath: "/tmp/project/.t3/worktrees/feature-a",
          status: "running",
          pid: 1234,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Primary",
          updatedAt: isoTimestamp,
        },
      }),
    ).toBe(true);
  });
});

// #149: a subagent's PTY must be addressable. The Rust runtime already resolves
// a pane by `sessionId` in preference to `threadId`, carries a ChildSession
// pane kind with its own worktree, and emits `sessionId` on every snapshot
// (backend/src/terminal.rs:287, :293-307, :88-94). The contract could not ASK
// for any of it, which is the whole reason #149 reads as a missing UI path —
// the UI was unwritable.
describe("TerminalTargetInput (#149)", () => {
  it("still accepts a thread-addressed pane unchanged", () => {
    expect(decodeSync(TerminalTargetInput, { threadId: "t-1" })).toEqual({ threadId: "t-1" });
  });

  it("accepts a child session, with and without its own worktree", () => {
    expect(decodeSync(TerminalTargetInput, { sessionId: "s-1" })).toEqual({ sessionId: "s-1" });
    expect(decodeSync(TerminalTargetInput, { sessionId: "s-1", worktreePath: "/w/sub" })).toEqual({
      sessionId: "s-1",
      worktreePath: "/w/sub",
    });
  });

  // The two assertions that make the union worth being a union. With one struct
  // carrying both ids as optionals, BOTH of these would decode: a request
  // naming no pane at all, and a request naming two that disagree.
  it("rejects a target that names no pane", () => {
    expect(decodes(TerminalTargetInput, {})).toBe(false);
  });

  it("rejects a target that names both a thread and a session", () => {
    expect(decodes(TerminalTargetInput, { threadId: "t-1", sessionId: "s-1" })).toBe(false);
  });

  it("rejects blank ids rather than addressing a pane with an empty string", () => {
    expect(decodes(TerminalTargetInput, { sessionId: "   " })).toBe(false);
    expect(decodes(TerminalTargetInput, { threadId: "" })).toBe(false);
  });
});

describe("terminal snapshots carry the child session (#149)", () => {
  const snapshot = {
    threadId: "t-1",
    terminalId: "term-1",
    cwd: "/w",
    worktreePath: null,
    status: "running",
    pid: 42,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "zsh",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };

  // The TypeScript server does not emit `sessionId` yet. If the field were
  // required-but-nullable rather than optional, every one of its snapshots
  // would fail to decode — and a snapshot that fails to decode is a terminal
  // the user cannot see. That is why this is `optional(NullOr(...))`.
  it("decodes a snapshot with no sessionId at all", () => {
    expect(decodes(TerminalSessionSnapshot, snapshot)).toBe(true);
  });

  it("decodes an explicit null sessionId as a thread pane", () => {
    expect(decodes(TerminalSessionSnapshot, { ...snapshot, sessionId: null })).toBe(true);
  });

  it("carries the sessionId through when the pane is a child session", () => {
    const decoded = decodeSync(TerminalSessionSnapshot, {
      ...snapshot,
      sessionId: "s-1",
      worktreePath: "/w/sub",
    });
    expect(decoded.sessionId).toBe("s-1");
    expect(decoded.worktreePath).toBe("/w/sub");
  });

  it("applies the same shape to the metadata summary, so a list and a snapshot agree", () => {
    const { history: _history, ...summaryFields } = snapshot;
    const decoded = decodeSync(TerminalSummary, {
      ...summaryFields,
      hasRunningSubprocess: false,
      sessionId: "s-1",
    });
    expect(decoded.sessionId).toBe("s-1");
  });
});
