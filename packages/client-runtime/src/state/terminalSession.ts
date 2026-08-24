import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

/**
 * WHO OWNS A PTY. Mirrors the backend's `TerminalOwner`
 * (`backend/src/terminal.rs:287`) and the wire union
 * `TerminalTargetInput` (`contracts/src/terminal.ts:72`).
 *
 * A union rather than `{ threadId, sessionId }` with one of them null, for the
 * reason the contract file already gives: two nullable fields make the
 * disagreeing state representable, and every reader then has to know which one
 * wins. Here the compiler decides instead — a pane has exactly one owner, and
 * `kind` is the only way to read it.
 *
 * This is the half of #149 the frontend was missing. It was not a missing
 * feature, it was a missing TYPE: `KnownTerminalSessionTarget` hardcoded
 * `threadId`, so a subagent's PTY was UNREPRESENTABLE and
 * `useKnownTerminalSessions` had no honest option but to filter it out.
 */
export type KnownTerminalSessionOwner =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | {
      readonly kind: "session";
      readonly sessionId: string;
      /** Where the child is running, when the backend knows it. */
      readonly worktreePath: string | null;
    };

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly owner: KnownTerminalSessionOwner;
  readonly terminalId: string;
}

/**
 * Read a pane's owner off the wire, exactly as `TerminalOwner::wire` writes it
 * (`backend/src/terminal.rs`): `threadId` set means a thread pane, `sessionId`
 * set means a child session. Returns `null` for a summary that names neither,
 * which is not addressable and must be skipped rather than guessed at.
 *
 * Lives HERE, beside the type, rather than inline in a React hook: it is the
 * rule for decoding an owner, and a second call site that re-derived it would
 * be free to get the precedence wrong. `sessionId` is `optional` in the
 * contract because the TypeScript server does not emit the key yet, so absent
 * and null both have to mean "not a child session".
 */
export function terminalOwnerOfSummary(summary: {
  readonly threadId: string | null;
  readonly sessionId?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}): KnownTerminalSessionOwner | null {
  if (summary.threadId !== null && summary.threadId !== undefined) {
    return { kind: "thread", threadId: summary.threadId as ThreadId };
  }
  if (summary.sessionId !== null && summary.sessionId !== undefined) {
    return {
      kind: "session",
      sessionId: summary.sessionId,
      worktreePath: summary.worktreePath ?? null,
    };
  }
  return null;
}

/** Whether two owners name the same pane owner. */
export function sameTerminalOwner(
  a: KnownTerminalSessionOwner,
  b: KnownTerminalSessionOwner,
): boolean {
  if (a.kind === "thread" && b.kind === "thread") {
    return a.threadId === b.threadId;
  }
  if (a.kind === "session" && b.kind === "session") {
    return a.sessionId === b.sessionId;
  }
  return false;
}

/** The thread that owns this pane, or `null` when a child session does. */
export function ownerThreadId(target: KnownTerminalSessionTarget): ThreadId | null {
  return target.owner.kind === "thread" ? target.owner.threadId : null;
}

/** The child session that owns this pane, or `null` when a thread does. */
export function ownerSessionId(target: KnownTerminalSessionTarget): string | null {
  return target.owner.kind === "session" ? target.owner.sessionId : null;
}

/**
 * Stable identity for a pane, for React keys and focus tracking. Namespaced by
 * `kind` so a thread and a session that happen to share an id cannot collide.
 */
export function terminalTargetKey(target: KnownTerminalSessionTarget): string {
  const owner =
    target.owner.kind === "thread"
      ? `thread:${target.owner.threadId}`
      : `session:${target.owner.sessionId}`;
  return `${target.environmentId}|${owner}|${target.terminalId}`;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  return {
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output":
      return {
        ...current,
        buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
