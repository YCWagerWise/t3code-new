/**
 * The Atlas projection fold (doc 15 §2.2, arm table doc 16): FeedFrame → OrchestrationEvent[].
 *
 * Fuses the donor's three hops (AtlasAdapter → ProviderRuntimeIngestion → decider) into one
 * pure function. It emits DOMAIN events only; `threadReducer.applyThreadDetailEvent` — the
 * client's existing pure fold — builds the thread. One folding authority, not two.
 *
 * Invariants carried from doc 16 (each mutation-tested):
 *  1. one monotonic sequence; the caller's snapshotSequence must equal the last emitted
 *  2. strict lifecycle guard — a turn-close for a turn we are not in is dropped
 *  3. turn-end sweep — every assistant message finalizes (streaming:false) at turn end
 *  4. per-activity unique ids (`${frameId}:${i}` on multi-activity frames)
 *  5. tool_result ok:false ⇒ status:"failed" reaches the activity payload
 *  6. ctx with used<=0 emits nothing
 *  7. `hb` never reaches this fold (transport family) — so it can never close a turn
 */

import type { OrchestrationEvent } from "@t3tools/contracts";
import type { FeedFrame } from "@t3tools/contracts/atlas";

import * as DateTime from "effect/DateTime";

import type { ThreadFeedEvent } from "./threadFeed.ts";

export interface ProjectionState {
  readonly threadId: string;
  readonly runId: string;
  /** Last emitted sequence — the snapshot the caller publishes MUST carry this value. */
  readonly sequence: number;
  readonly activeTurnId: string | null;
  /** Assistant message ids opened this turn, finalized by the turn-end sweep. */
  readonly turnAssistantIds: ReadonlyArray<string>;
  readonly checkpointCount: number;
  readonly lastError: string | null;
}

export const initialProjectionState = (threadId: string, runId: string): ProjectionState => ({
  threadId,
  runId,
  sequence: 0,
  activeTurnId: null,
  turnAssistantIds: [],
  checkpointCount: 0,
  lastError: null,
});

export interface ProjectionResult {
  readonly state: ProjectionState;
  readonly events: ReadonlyArray<OrchestrationEvent>;
  /** The feed was recreated — the caller must publish a fresh snapshot before more events. */
  readonly reset?: boolean;
}

const iso = (ts: number): string => DateTime.formatIso(DateTime.makeUnsafe(ts));

/** The one boundary cast: payload shapes follow doc 16's tables and the test decodes every
 * emitted event through the real contract schema, so a shape lie fails there, not on screen. */
const mkEvents = (
  state: ProjectionState,
  frame: FeedFrame,
  bodies: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
): ProjectionResult => {
  let sequence = state.sequence;
  const events = bodies.map((body, i) => {
    sequence += 1;
    return {
      type: body.type,
      sequence,
      eventId: `atlas:${state.runId}:${frame.seq}:${i}`,
      aggregateKind: "thread",
      aggregateId: state.threadId,
      occurredAt: iso(Number(frame.ts)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: body.payload,
    } as unknown as OrchestrationEvent;
  });
  return { state: { ...state, sequence }, events };
};

const activity = (
  state: ProjectionState,
  frame: FeedFrame,
  index: number,
  a: {
    tone: "info" | "tool" | "approval" | "error";
    kind: string;
    summary: string;
    payload: Record<string, unknown>;
  },
) => ({
  type: "thread.activity-appended",
  payload: {
    threadId: state.threadId,
    activity: {
      id: `atlas:${state.runId}:${frame.seq}:${index}`,
      tone: a.tone,
      kind: a.kind,
      summary: a.summary,
      payload: a.payload,
      turnId: state.activeTurnId,
      createdAt: iso(Number(frame.ts)),
    },
  },
});

const sessionSet = (
  state: ProjectionState,
  status: "running" | "ready" | "interrupted" | "error",
  updatedAt: string,
) => ({
  type: "thread.session-set",
  payload: {
    threadId: state.threadId,
    session: {
      threadId: state.threadId,
      status,
      providerName: "atlas",
      runtimeMode: "full-access",
      activeTurnId: state.activeTurnId,
      lastError: state.lastError,
      updatedAt,
    },
  },
});

/** Finalize every assistant message the turn opened — without this a message stays
 * `streaming:true` forever and `latestTurn` never settles (reducer gates on it). */
const sweep = (state: ProjectionState, frame: FeedFrame) =>
  state.turnAssistantIds.map((messageId) => ({
    type: "thread.message-sent",
    payload: {
      threadId: state.threadId,
      messageId,
      role: "assistant",
      text: "",
      turnId: state.activeTurnId,
      streaming: false,
      createdAt: iso(Number(frame.ts)),
      updatedAt: iso(Number(frame.ts)),
    },
  }));

export const applyFeedEvent = (
  state: ProjectionState,
  event: ThreadFeedEvent,
): ProjectionResult => {
  if (event.kind === "reset") {
    return {
      state: { ...initialProjectionState(state.threadId, state.runId), sequence: state.sequence },
      events: [],
      reset: true,
    };
  }
  if (event.kind !== "frame") {
    return { state, events: [] }; // replay-complete / connection: the caller's business
  }
  const frame = event.frame;
  const at = iso(Number(frame.ts));
  const payload = frame.payload as Record<string, unknown>;

  switch (frame.kind) {
    case "user":
      return mkEvents(state, frame, [
        {
          type: "thread.message-sent",
          payload: {
            threadId: state.threadId,
            messageId: `user:${state.runId}:${frame.seq}`,
            role: "user",
            text: typeof payload.text === "string" ? payload.text : "",
            turnId: state.activeTurnId,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);

    case "assistant": {
      const messageId = `assistant:${state.runId}:${frame.seq}`;
      const next = { ...state, turnAssistantIds: [...state.turnAssistantIds, messageId] };
      return mkEvents(next, frame, [
        {
          type: "thread.message-sent",
          payload: {
            threadId: state.threadId,
            messageId,
            role: "assistant",
            text: typeof payload.text === "string" ? payload.text : "",
            turnId: state.activeTurnId,
            streaming: true,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
    }

    case "thinking":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "info",
          kind: "thinking",
          summary: "Thinking",
          payload: { detail: typeof payload.text === "string" ? payload.text : "" },
        }),
      ]);

    case "turn": {
      const turnState = typeof payload.state === "string" ? payload.state : "";
      if (turnState === "start") {
        const turnId = `turn:${state.runId}:${frame.seq}`;
        const next = { ...state, activeTurnId: turnId, turnAssistantIds: [], lastError: null };
        return mkEvents(next, frame, [sessionSet(next, "running", at)]);
      }
      // Strict lifecycle guard: a close with no turn in flight is a stale or foreign
      // frame — dropping it is the only defence against it closing a live turn later.
      if (state.activeTurnId === null) {
        return { state, events: [] };
      }
      const errorText = typeof payload.text === "string" ? payload.text : null;
      const closing =
        turnState === "error"
          ? { status: "error" as const, lastError: errorText ?? "turn failed" }
          : turnState === "cancelled"
            ? { status: "interrupted" as const, lastError: null }
            : { status: "ready" as const, lastError: null };
      const swept = sweep(state, frame);
      const errored =
        turnState === "error"
          ? [
              activity(state, frame, swept.length, {
                tone: "error",
                kind: "runtime.error",
                summary: "Runtime error",
                payload: { message: closing.lastError, detail: closing.lastError },
              }),
            ]
          : [];
      const closedState = { ...state, lastError: closing.lastError };
      const result = mkEvents(closedState, frame, [
        ...swept,
        ...errored,
        sessionSet({ ...closedState, activeTurnId: null }, closing.status, at),
      ]);
      return {
        ...result,
        state: { ...result.state, activeTurnId: null, turnAssistantIds: [] },
      };
    }

    case "tool_call":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "tool",
          kind: "tool.started",
          summary: typeof payload.tool === "string" ? payload.tool : "tool",
          payload: {
            itemType: "dynamic_tool_call",
            detail: typeof payload.tool === "string" ? payload.tool : "tool",
            data: { args: payload.args ?? null, callId: payload.call_id ?? null },
          },
        }),
      ]);

    case "tool_result": {
      const ok = payload.ok !== false;
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: ok ? "tool" : "error",
          kind: "tool.completed",
          summary: typeof payload.tool === "string" ? payload.tool : "tool",
          payload: {
            itemType: "dynamic_tool_call",
            // Absent status renders as a green check — a failed tool must say so.
            status: ok ? "completed" : "failed",
            detail: typeof payload.summary === "string" ? payload.summary : "",
            data: { callId: payload.call_id ?? null, durationMs: payload.duration_ms ?? null },
          },
        }),
      ]);
    }

    case "diff": {
      if (state.activeTurnId === null) {
        return { state, events: [] }; // a diff belongs to a turn; orphans are stale
      }
      const files = Array.isArray(payload.files)
        ? (payload.files as Array<Record<string, unknown>>)
        : [];
      // The node's checkpoint seq IS the turn count (AUTOINCREMENT from 1) — adopting it
      // makes TurnCountRange map 1:1 onto the diff route with no client-side join table.
      const nodeSeq =
        typeof payload.checkpoint === "number" ? payload.checkpoint : state.checkpointCount + 1;
      const next = { ...state, checkpointCount: nodeSeq };
      return mkEvents(next, frame, [
        {
          type: "thread.turn-diff-completed",
          payload: {
            threadId: state.threadId,
            turnId: state.activeTurnId,
            checkpointTurnCount: nodeSeq,
            checkpointRef: `atlas:${payload.checkpoint ?? frame.seq}`,
            status: "ready",
            files: files.map((f) => ({
              path: typeof f.path === "string" ? f.path : "?",
              kind: f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified",
              additions: 0,
              deletions: 0,
            })),
            assistantMessageId: null,
            completedAt: at,
          },
        },
        ...files.map((f, i) =>
          activity(state, frame, i + 1, {
            tone: "tool",
            kind: "tool.completed",
            summary: typeof f.path === "string" ? f.path : "file",
            payload: {
              itemType: "file_change",
              status: "completed",
              detail: typeof f.path === "string" ? f.path : "file",
              data: {
                path: f.path ?? null,
                changeStatus: f.status ?? null,
                unified: i === 0 ? (payload.unified ?? null) : null,
              },
            },
          }),
        ),
      ]);
    }

    case "ctx": {
      const used = typeof payload.used === "number" ? payload.used : 0;
      if (used <= 0) {
        return { state, events: [] }; // publishing zeros is the same as publishing nothing
      }
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "info",
          kind: "context-window.updated",
          summary: "Context updated",
          payload: { usedTokens: used, maxTokens: payload.window ?? null },
        }),
      ]);
    }

    case "approval":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "approval",
          kind: "approval.requested",
          summary: typeof payload.tool === "string" ? payload.tool : "approval",
          payload: {
            requestId: payload.request_id ?? null,
            requestType: payload.request_type ?? "command_execution_approval",
            detail: typeof payload.reason === "string" ? payload.reason : "approval requested",
            args: payload.args ?? null,
          },
        }),
      ]);

    case "question":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "info",
          kind: "user-input.requested",
          summary: "Input requested",
          payload: {
            requestId: payload.request_id ?? null,
            questions: payload.choices ?? [],
            detail: typeof payload.prompt === "string" ? payload.prompt : "input requested",
          },
        }),
      ]);

    case "deny":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "error",
          kind: "tool.denied",
          summary: typeof payload.tool === "string" ? payload.tool : "tool",
          payload: {
            toolName: payload.tool ?? "tool",
            detail: typeof payload.reason === "string" ? payload.reason : "denied",
          },
        }),
      ]);

    case "warning":
      return mkEvents(state, frame, [
        activity(state, frame, 0, {
          tone: "info",
          kind: "runtime.warning",
          summary: "Warning",
          payload: {
            message: payload.message ?? "",
            detail: typeof payload.message === "string" ? payload.message : "",
          },
        }),
      ]);

    // usage: no screen consumer in M1 (ledger later). lifecycle: the turn arms already
    // carry session status; edge: out of scope. Unknown kinds cannot reach here (decode).
    default:
      return { state, events: [] };
  }
};
