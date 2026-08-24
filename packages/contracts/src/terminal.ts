import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Client-side id for the first shell opened on a thread. Ids are uniformly
 * `term-N`; there's no "default" intrinsic. Kept as a named constant so callers
 * that want "the primary shell" don't hardcode `"term-1"`.
 */
export const DEFAULT_TERMINAL_ID = "term-1";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TerminalEnvKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
).check(Schema.isMaxLength(128));
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
const TerminalEnvSchema = Schema.Record(TerminalEnvKeySchema, TerminalEnvValueSchema).check(
  Schema.isMaxProperties(128),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

/**
 * Addressing a pane that belongs to a CHILD SESSION rather than a thread (#149).
 *
 * A subagent runs in its own session and usually its own worktree, and its PTY
 * is owned by Hearth — not by the thread that spawned it. Addressing it as
 * `{threadId, terminalId}` is not merely inconvenient, it is unrepresentable:
 * several child sessions of one thread would collide on the same key, so
 * "focus THAT subagent's terminal" has no expression at all.
 *
 * THE RUNTIME ALREADY SPEAKS THIS. `backend/src/terminal.rs` resolves a pane
 * target with `sessionId` WINNING over `threadId` (:293-307), carries
 * `ChildSession { session_id, worktree_path }` as a first-class pane kind
 * (:287), prefers `worktree_path` over `cwd` when both are given (:427), and
 * already emits `sessionId` and `worktreePath` on every pane snapshot
 * (:88-94, :141-146). The contract was the only thing that could not ask for
 * it, which is why #149 reads as a UI gap: the UI could not be written.
 *
 * `worktreePath` is optional because a child session need not have its own
 * worktree — a subagent sharing the parent's tree is normal, and requiring the
 * field would force callers to invent one.
 */
export const TerminalChildSessionInput = Schema.Struct({
  sessionId: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TerminalChildSessionInput = typeof TerminalChildSessionInput.Type;

/**
 * What a pane may be addressed BY: a thread, or a child session.
 *
 * A union rather than one struct with both fields optional, deliberately. Two
 * optional ids admit `{}` — a request that names no pane at all — and
 * `{threadId, sessionId}`, where the two disagree and the reader has to know
 * which wins. The union makes both unrepresentable, so the ambiguity is
 * resolved at the type level instead of by a precedence rule every caller has
 * to remember.
 *
 * Thread-addressed panes are UNCHANGED: `{threadId}` decodes exactly as before,
 * so no existing caller moves.
 */
export const TerminalTargetInput = Schema.Union([
  // Each variant explicitly FORBIDS the other's id. Effect structs ignore
  // excess properties, so a bare union of the two would happily decode
  // `{threadId, sessionId}` as the thread variant and silently drop the
  // session — sending the user to the parent thread's terminal while the UI
  // believed it had asked for a subagent's. Caught by
  // "rejects a target that names both a thread and a session"; `optional(Never)`
  // is what makes that assertion pass, rather than deleting the assertion.
  Schema.Struct({
    ...TerminalThreadInput.fields,
    sessionId: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...TerminalChildSessionInput.fields,
    threadId: Schema.optional(Schema.Never),
  }),
]);
export type TerminalTargetInput = typeof TerminalTargetInput.Type;

/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalAttachInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  restartIfNotRunning: Schema.optional(Schema.Boolean),
});
export type TerminalAttachInput = Schema.Codec.Encoded<typeof TerminalAttachInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  /**
   * NULL for a child-session pane (#149). `backend/src/terminal.rs:352-357`
   * (`TerminalOwner::wire`) returns `(threadId, null)` for a thread pane and
   * `(null, sessionId)` for a child session — a pane has exactly one owner, so
   * a non-nullable `threadId` made a subagent's pane literally undecodable and
   * the terminal would vanish rather than render. Exactly one of `threadId` /
   * `sessionId` is set.
   */
  threadId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /**
   * The child session this pane belongs to, when it is not a thread pane
   * (#149). `optional` and not merely nullable: the Rust backend always
   * emits the key (null for a thread pane) but the TypeScript server does
   * not yet, and a snapshot that fails to decode is a terminal the user
   * cannot see. Absent and null both mean 'a thread pane'.
   */
  sessionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

export const TerminalSummary = Schema.Struct({
  /**
   * NULL for a child-session pane (#149). `backend/src/terminal.rs:352-357`
   * (`TerminalOwner::wire`) returns `(threadId, null)` for a thread pane and
   * `(null, sessionId)` for a child session — a pane has exactly one owner, so
   * a non-nullable `threadId` made a subagent's pane literally undecodable and
   * the terminal would vanish rather than render. Exactly one of `threadId` /
   * `sessionId` is set.
   */
  threadId: Schema.NullOr(TrimmedNonEmptyStringSchema),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  /**
   * The child session this pane belongs to, when it is not a thread pane
   * (#149). `optional` and not merely nullable: the Rust backend always
   * emits the key (null for a thread pane) but the TypeScript server does
   * not yet, and a snapshot that fails to decode is a terminal the user
   * cannot see. Absent and null both mean 'a thread pane'.
   */
  sessionId: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  hasRunningSubprocess: Schema.Boolean,
  /** Server-computed display title (idle shell vs subprocess command). */
  label: Schema.String.check(Schema.isMaxLength(128)),
  updatedAt: Schema.String,
});
export type TerminalSummary = typeof TerminalSummary.Type;

const TerminalMetadataSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  terminals: Schema.Array(TerminalSummary),
});

const TerminalMetadataUpsertEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  terminal: TerminalSummary,
});

const TerminalMetadataRemoveEvent = Schema.Struct({
  type: Schema.Literal("remove"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
});

export const TerminalMetadataStreamEvent = Schema.Union([
  TerminalMetadataSnapshotEvent,
  TerminalMetadataUpsertEvent,
  TerminalMetadataRemoveEvent,
]);
export type TerminalMetadataStreamEvent = typeof TerminalMetadataStreamEvent.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalClosedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

const TerminalAttachSnapshotEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: TerminalSessionSnapshot,
});

export const TerminalAttachStreamEvent = Schema.Union([
  TerminalAttachSnapshotEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalClosedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalAttachStreamEvent = typeof TerminalAttachStreamEvent.Type;

export class TerminalCwdNotFoundError extends Schema.TaggedErrorClass<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd does not exist: ${this.cwd}`;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedErrorClass<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd is not a directory: ${this.cwd}`;
  }
}

export class TerminalCwdStatError extends Schema.TaggedErrorClass<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export class TerminalCwdOutsideWorktreeError extends Schema.TaggedErrorClass<TerminalCwdOutsideWorktreeError>()(
  "TerminalCwdOutsideWorktreeError",
  {
    cwd: Schema.String,
    worktreePath: Schema.String,
  },
) {
  override get message() {
    return `Terminal cwd ${this.cwd} is not inside the claimed worktree ${this.worktreePath}`;
  }
}

export class TerminalCwdNotAdmittedError extends Schema.TaggedErrorClass<TerminalCwdNotAdmittedError>()(
  "TerminalCwdNotAdmittedError",
  {
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Refused: ${this.cwd} is outside every project and worktree this environment owns`;
  }
}

export const TerminalCwdError = Schema.Union([
  TerminalCwdNotAdmittedError,
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
  TerminalCwdStatError,
  TerminalCwdOutsideWorktreeError,
]);
export type TerminalCwdError = typeof TerminalCwdError.Type;

export class TerminalHistoryError extends Schema.TaggedErrorClass<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedErrorClass<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalWriteError extends Schema.TaggedErrorClass<TerminalWriteError>()(
  "TerminalWriteError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write to terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
  }
}

export class TerminalResizeError extends Schema.TaggedErrorClass<TerminalResizeError>()(
  "TerminalResizeError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    terminalPid: Schema.Number,
    cols: TerminalColsSchema,
    rows: TerminalRowsSchema,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to resize terminal for thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid} to ${this.cols}x${this.rows}`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type TerminalError = typeof TerminalError.Type;
