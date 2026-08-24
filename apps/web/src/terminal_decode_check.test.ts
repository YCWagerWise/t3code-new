import { test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  TerminalSessionSnapshot,
  TerminalAttachStreamEvent,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalSummary,
} from "@t3tools/contracts";

const now = new Date().toISOString();

// The exact snapshot the Rust `terminal::session_snapshot` emits.
const snapshot = {
  threadId: "t-1",
  terminalId: "term-1",
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 4321,
  history: "user@host:~$ ",
  exitCode: null,
  exitSignal: null,
  label: "shell",
  updatedAt: now,
};

const summary = {
  threadId: "t-1",
  terminalId: "term-1",
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 4321,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "shell",
  updatedAt: now,
};

test("terminal.open / restart snapshot decodes", () => {
  Schema.decodeUnknownSync(TerminalSessionSnapshot)(snapshot);
});

test("terminal summary decodes", () => {
  Schema.decodeUnknownSync(TerminalSummary)(summary);
});

test("terminal.attach stream events decode", () => {
  Schema.decodeUnknownSync(TerminalAttachStreamEvent)({ type: "snapshot", snapshot });
  Schema.decodeUnknownSync(TerminalAttachStreamEvent)({
    type: "output",
    threadId: "t-1",
    terminalId: "term-1",
    data: "[2J[H hello",
  });
  Schema.decodeUnknownSync(TerminalAttachStreamEvent)({
    type: "exited",
    threadId: "t-1",
    terminalId: "term-1",
    exitCode: 0,
    exitSignal: null,
  });
});

test("subscribeTerminalEvents events decode", () => {
  Schema.decodeUnknownSync(TerminalEvent)({
    type: "started",
    threadId: "t-1",
    terminalId: "term-1",
    snapshot,
  });
  Schema.decodeUnknownSync(TerminalEvent)({
    type: "output",
    threadId: "t-1",
    terminalId: "term-1",
    data: "x",
  });
  Schema.decodeUnknownSync(TerminalEvent)({
    type: "exited",
    threadId: "t-1",
    terminalId: "term-1",
    exitCode: 3,
    exitSignal: null,
  });
});

test("subscribeTerminalMetadata events decode", () => {
  Schema.decodeUnknownSync(TerminalMetadataStreamEvent)({ type: "snapshot", terminals: [summary] });
  Schema.decodeUnknownSync(TerminalMetadataStreamEvent)({ type: "upsert", terminal: summary });
});
