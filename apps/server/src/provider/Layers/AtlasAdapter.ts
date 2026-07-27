/**
 * AtlasAdapterLive — the Atlas provider adapter.
 *
 * Every other adapter in this tree spends most of its lines *reconstructing*: it
 * receives a loosely-typed message stream from a local process and has to dig out
 * structure, normalize usage numbers, infer whether a turn was interrupted by
 * substring-matching an error string, and hold the open state (tools in flight,
 * pending approvals, partial text blocks) that the provider does not track.
 * `ClaudeAdapter.ts` is ~2,900 lines of exactly that before its contract methods
 * even begin.
 *
 * This adapter is small because none of that work belongs here. Atlas publishes a
 * durable, ordered, typed feed: `kind` is an enum rather than a string to
 * pattern-match, `seq` gives ordering, `turn{state:"error"}` *declares* an aborted
 * turn instead of requiring inference, and an `approval` frame carries its own
 * `request_id` instead of needing a pending-request map rebuilt from context. The
 * reconstruction happens once, in the substrate, where every Atlas lens inherits
 * it — rather than once per lens.
 *
 * So what is left here is the honest job of an adapter against a well-typed
 * source: connect, translate vocabulary, and satisfy the contract.
 *
 * Scope limits, stated rather than hidden:
 *   • `rollbackThread` is unsupported — Atlas has no checkpoint surface (GAP-009).
 *   • `readThread` returns an empty snapshot; the timeline is rebuilt from the
 *     feed's replay, not from a provider-side thread read.
 *   • successful tool calls do not appear yet: the Atlas-side tool observer fires
 *     only on failure (GAP-002 remainder).
 *
 * @module AtlasAdapterLive
 */
import {
  EventId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeItemId,
  type ThreadId,
  TurnId,
  type AtlasSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { AtlasAdapterShape } from "../Services/AtlasAdapter.ts";
import { atlasFeedUrl } from "./AtlasClient.ts";

export const ATLAS_ADAPTER_KIND = ProviderDriverKind.make("atlas");

const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

/**
 * An Atlas run id derived from a T3 thread id.
 *
 * The `thr-` prefix is load-bearing on the Atlas side: `/say` treats a `thr-*` id
 * as a WARM thread — one durable isolate that accumulates turns — where a bare id
 * is a one-shot run. A console conversation is a warm thread.
 */
const runIdForThread = (threadId: ThreadId): string => `thr-${threadId}`;

interface AtlasSessionState {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly socket: WebSocket;
  activeTurnId: TurnId | undefined;
  /** Model pinned for this session; a per-turn selection overrides it. */
  model: string | undefined;
  /**
   * Highest `seq` delivered, and the `epoch` it belongs to. Returned as the
   * resume cursor so a reconnect replays only what it missed. The epoch is not
   * decoration: a feed's `seq` restarts when its isolate is recreated, so a
   * cursor without its epoch names a different event.
   */
  cursor: { seq: number; epoch: number } | undefined;
  /**
   * Frames written before the socket finished opening.
   *
   * `startSession` returns as soon as `new WebSocket()` is constructed, which is
   * BEFORE the handshake completes, so a prompt `sendTurn` would otherwise be
   * dropped: the old `send` checked `readyState === OPEN` and silently did
   * nothing. A command lost that way produced a turn that never started and never
   * failed — the thread sat on "Working" indefinitely.
   */
  outbox: string[];
  /** Set by `stopSession`, so a deliberate close is not reported as a failure. */
  closing: boolean;
  readonly session: ProviderSession;
}

/** The resume cursor T3 persists between sessions. */
interface AtlasResumeCursor {
  readonly seq: number;
  readonly epoch: number;
}

const parseResumeCursor = (raw: unknown): AtlasResumeCursor | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const seq = num(record.seq);
  const epoch = num(record.epoch);
  return seq === undefined || epoch === undefined ? undefined : { seq, epoch };
};

/** One frame off the Atlas feed. Field names match `atlas-host/src/feed.rs`. */
interface AtlasFrame {
  readonly version?: number;
  readonly seq?: number;
  readonly epoch?: number;
  readonly kind?: string;
  readonly role?: string;
  readonly payload?: Record<string, unknown>;
  readonly error?: string;
  /** Declared by Atlas on an error frame. Never inferred here. */
  readonly class?: string;
}

const RUNTIME_ERROR_CLASSES = [
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
] as const;
type RuntimeErrorClassName = (typeof RUNTIME_ERROR_CLASSES)[number];

/**
 * Take the class Atlas declared, or fall back to `unknown`.
 *
 * Deliberately NOT a classifier. Recovering the class by pattern-matching the
 * message is how `isClaudeInterruptedMessage` happens — the lens guessing at a
 * semantic the provider never stated. Atlas knows at the point of failure and
 * says so; anything it does not say stays honestly unknown.
 */
const declaredErrorClass = (frame: AtlasFrame): RuntimeErrorClassName =>
  RUNTIME_ERROR_CLASSES.find((c) => c === frame.class) ?? "unknown";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** WebSocket readyState values, named so the intent survives a reader. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * Where an outbound frame goes, given the socket's state.
 *
 * `queue` is the case that matters: `startSession` returns as soon as
 * `new WebSocket()` is constructed, before the handshake completes, so a prompt
 * `sendTurn` arrives while CONNECTING. Discarding it there produced a turn that
 * never started and never failed — a thread stuck on "Working" forever.
 *
 * `drop` is deliberate for a CLOSING/CLOSED socket: it will never flush, so
 * queueing would leak the frame instead of losing it.
 */
export const outboundDisposition = (readyState: number): "send" | "queue" | "drop" =>
  readyState === WS_OPEN ? "send" : readyState === WS_CONNECTING ? "queue" : "drop";

/**
 * What to emit when the feed dies.
 *
 * Atlas cannot report this — the transport is precisely what broke — so the
 * adapter has to. Emitting only an error would leave the timeline running; the
 * `turn.aborted` is what returns it to a terminal state.
 */
export const socketLossEvents = (
  ctx: FrameContext & { readonly closing: boolean },
  detail: string,
  stamp: { readonly eventId: EventId; readonly createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> => {
  if (ctx.closing) return []; // a deliberate detach is not a failure
  const base = {
    ...stamp,
    provider: ATLAS_ADAPTER_KIND,
    providerInstanceId: ctx.instanceId,
    threadId: ctx.threadId,
    ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
  };
  const error = {
    type: "runtime.error" as const,
    ...base,
    payload: { message: detail, class: "transport_error" as const },
  };
  // Only when a turn was in flight — an idle disconnect must not invent an
  // aborted turn that never ran.
  return ctx.activeTurnId === undefined
    ? [error]
    : [error, { type: "turn.aborted" as const, ...base, payload: { reason: detail } }];
};

/** Everything the frame mapper needs, without a live session behind it. */
export interface FrameContext {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly activeTurnId: TurnId | undefined;
}

/**
 * Atlas frame → canonical runtime event.
 *
 * This function is the entire translation layer, and it is a `switch` rather
 * than a state machine because the feed already carries the state.
 */
export const eventsForFrame = (
  ctx: FrameContext,
  frame: AtlasFrame,
  stamp: { readonly eventId: EventId; readonly createdAt: string },
): ReadonlyArray<ProviderRuntimeEvent> => {
  const base = {
    ...stamp,
    provider: ATLAS_ADAPTER_KIND,
    providerInstanceId: ctx.instanceId,
    threadId: ctx.threadId,
    ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
  };
  const payload = frame.payload ?? {};
  const raw = { source: "atlas.feed", payload: frame as unknown } as const;

  switch (frame.kind) {
    case "turn": {
      const turnState = str(payload.state);
      if (turnState === "start") {
        return [{ type: "turn.started", ...base, payload: {}, raw }];
      }
      if (turnState === "error") {
        return [
          {
            type: "turn.aborted",
            ...base,
            payload: { reason: str(payload.text) ?? "Atlas run failed" },
            raw,
          },
        ];
      }
      return [{ type: "turn.completed", ...base, payload: { state: "completed" }, raw }];
    }

    // The assistant answer arrives whole rather than token-by-token: Atlas
    // publishes it once the drive completes. Emitting started/delta/completed
    // keeps the timeline's item contract intact without pretending to stream.
    case "assistant": {
      const text = str(payload.text) ?? "";
      const itemId = RuntimeItemId.make(`${ctx.runId}:${frame.seq ?? 0}`);
      return [
        { type: "item.started", ...base, itemId, payload: { itemType: "assistant_message" }, raw },
        {
          type: "content.delta",
          ...base,
          itemId,
          payload: { streamKind: "assistant_text", delta: text },
          raw,
        },
        {
          type: "item.completed",
          ...base,
          itemId,
          payload: { itemType: "assistant_message" },
          raw,
        },
      ];
    }

    case "thinking": {
      const itemId = RuntimeItemId.make(`${ctx.runId}:${frame.seq ?? 0}`);
      return [
        {
          type: "content.delta",
          ...base,
          itemId,
          payload: { streamKind: "reasoning_text", delta: str(payload.text) ?? "" },
          raw,
        },
      ];
    }

    case "tool_call": {
      const itemId = RuntimeItemId.make(`${ctx.runId}:tool:${str(payload.call_id) ?? frame.seq}`);
      return [
        {
          type: "item.started",
          ...base,
          itemId,
          payload: {
            itemType: "dynamic_tool_call",
            ...(str(payload.tool) ? { title: str(payload.tool) as string } : {}),
          },
          raw,
        },
      ];
    }

    case "tool_result": {
      const itemId = RuntimeItemId.make(`${ctx.runId}:tool:${str(payload.call_id) ?? frame.seq}`);
      const summaryText = str(payload.summary)?.trim();
      return [
        {
          type: "item.completed",
          ...base,
          itemId,
          payload: {
            itemType: "dynamic_tool_call",
            ...(str(payload.tool) ? { title: str(payload.tool) as string } : {}),
          },
          raw,
        },
        ...(summaryText
          ? [
              {
                type: "tool.summary" as const,
                ...base,
                itemId,
                payload: { summary: summaryText },
                raw,
              },
            ]
          : []),
      ];
    }

    // Atlas declares context pressure directly, so there is nothing to
    // normalize — contrast the ~150 lines Claude's adapter spends on this.
    case "ctx": {
      const used = num(payload.used);
      const window = num(payload.window);
      if (used === undefined || window === undefined) return [];
      return [
        {
          type: "thread.token-usage.updated",
          ...base,
          payload: { usage: { usedTokens: used, maxTokens: window } },
          raw,
        },
      ];
    }

    case "error":
      return [
        {
          type: "runtime.error",
          ...base,
          payload: {
            message: frame.error ?? str(payload.text) ?? "Atlas error",
            class: declaredErrorClass(frame),
          },
          raw,
        },
      ];

    // Carried by the protocol but not yet enforced on the Atlas side (GAP-006):
    // surfacing them as runtime events would put an approval in the UI that
    // nothing can actually resolve, which is worse than not showing it.
    case "approval":
    case "question":
    default:
      return [];
  }
};

export interface AtlasAdapterOptions {
  readonly instanceId: ProviderInstanceId;
}

export const makeAtlasAdapter = Effect.fn("makeAtlasAdapter")(function* (
  config: AtlasSettings,
  options: AtlasAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const sessions = new Map<ThreadId, AtlasSessionState>();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: ATLAS_ADAPTER_KIND,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Atlas runtime identifier.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () =>
    Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const eventsForFrameHere = (
    state: AtlasSessionState,
    frame: AtlasFrame,
    stamp: { readonly eventId: EventId; readonly createdAt: string },
  ) =>
    eventsForFrame(
      {
        runId: state.runId,
        threadId: state.threadId,
        instanceId: options.instanceId,
        activeTurnId: state.activeTurnId,
      },
      frame,
      stamp,
    );

  const handleFrameText = (state: AtlasSessionState, text: string) =>
    Effect.gen(function* () {
      const decoded = decodeUnknownJsonStringExit(text);
      if (!Exit.isSuccess(decoded)) return;
      const parsed = decoded.value as AtlasFrame;
      // Advance the delivered cursor before filtering: a console command echo still
      // moves the feed forward, and resuming behind it would replay it.
      const seq = num(parsed.seq);
      const epoch = num(parsed.epoch);
      if (seq !== undefined && epoch !== undefined) {
        state.cursor = { seq: Math.max(seq, state.cursor?.seq ?? 0), epoch };
      }
      // A console never echoes its own commands back into the timeline.
      if (parsed.role === "console") return;
      const stamp = yield* makeEventStamp();
      for (const event of eventsForFrameHere(state, parsed, stamp)) {
        yield* publish(event);
      }
    });

  const send = (state: AtlasSessionState, kind: string, payload: Record<string, unknown>) =>
    Effect.sync(() => {
      const encoded = encodeUnknownJsonStringExit({ kind, payload });
      if (!Exit.isSuccess(encoded)) return;
      // Queue rather than discard when the handshake has not finished. Dropping it
      // silently is how a turn ends up neither started nor failed.
      switch (outboundDisposition(state.socket.readyState)) {
        case "send":
          state.socket.send(encoded.value);
          break;
        case "queue":
          state.outbox.push(encoded.value);
          break;
        case "drop":
          break;
      }
    });

  const requireSession = (threadId: ThreadId) => {
    const state = sessions.get(threadId);
    return state === undefined
      ? Effect.fail(
          new ProviderAdapterRequestError({
            provider: ATLAS_ADAPTER_KIND,
            method: "session/lookup",
            detail: `No Atlas session for thread ${threadId}.`,
          }),
        )
      : Effect.succeed(state);
  };

  const startSession: AtlasAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const existing = sessions.get(input.threadId);
      if (existing) return existing.session;

      const runId = runIdForThread(input.threadId);
      const createdAt = yield* nowIso;
      // Resume where the last session stopped. The epoch travels with the cursor so
      // Atlas can discard it if the feed was recreated, rather than silently skipping
      // the run's history.
      const resume = parseResumeCursor(input.resumeCursor);
      const model = input.modelSelection?.model;
      const url = atlasFeedUrl({
        baseUrl: config.baseUrl,
        runId,
        plugin: config.plugin,
        token: config.wsToken,
        ...(resume ? { after: resume.seq, epoch: resume.epoch } : {}),
      });

      const socket = yield* Effect.try({
        try: () => new WebSocket(url),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: ATLAS_ADAPTER_KIND,
            method: "feed/connect",
            detail: `Failed to open the Atlas feed at ${config.baseUrl}.`,
            cause,
          }),
      });

      const session: ProviderSession = {
        provider: ATLAS_ADAPTER_KIND,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(model ? { model } : {}),
        ...(resume ? { resumeCursor: resume } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      const state: AtlasSessionState = {
        threadId: input.threadId,
        runId,
        socket,
        activeTurnId: undefined,
        model,
        cursor: resume,
        outbox: [],
        closing: false,
        session,
      };
      sessions.set(input.threadId, state);

      // The feed is the event source; frames are pumped into the same PubSub that
      // backs `streamEvents`. Nothing is awaited here — a socket that connects
      // slowly must not block the session from being usable.
      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);

      socket.onopen = () => {
        for (const frame of state.outbox.splice(0)) socket.send(frame);
      };

      socket.onmessage = (message: MessageEvent) => {
        if (typeof message.data !== "string") return;
        runFork(handleFrameText(state, message.data));
      };

      /**
       * A dead socket must END the turn, not leave it running.
       *
       * With only `onmessage` wired, a socket that failed to connect or dropped
       * mid-turn emitted nothing at all — no error, no turn boundary — and the
       * thread sat on "Working" indefinitely, because the timeline's only source
       * of turn state is the feed and the feed had gone silent. Atlas cannot
       * report this: the transport is precisely what broke. So the adapter must.
       */
      const reportSocketLoss = (detail: string) =>
        Effect.gen(function* () {
          const stamp = yield* makeEventStamp();
          const ctx = {
            runId: state.runId,
            threadId: state.threadId,
            instanceId: options.instanceId,
            activeTurnId: state.activeTurnId,
            closing: state.closing,
          };
          const events = socketLossEvents(ctx, detail, stamp);
          for (const event of events) yield* publish(event);
          if (events.some((e) => e.type === "turn.aborted")) state.activeTurnId = undefined;
        });

      socket.onerror = () => {
        runFork(reportSocketLoss(`Lost the Atlas feed for ${state.runId}.`));
      };
      socket.onclose = (event: CloseEvent) => {
        const why = event.reason !== "" ? event.reason : `closed with code ${event.code}`;
        runFork(reportSocketLoss(`The Atlas feed for ${state.runId} ${why}.`));
      };

      return session;
    },
  );

  const sendTurn: AtlasAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const state = yield* requireSession(input.threadId);
    const turnId = TurnId.make(yield* randomUUIDv4);
    state.activeTurnId = turnId;
    // A per-turn pick overrides the session's; absent leaves the node's own default.
    const model = input.modelSelection?.model ?? state.model;
    // Atlas publishes its own turn.started off the feed once the drive begins.
    // Sending the command is all this owes the caller.
    yield* send(state, "cmd", {
      text: input.input ?? "",
      ...(model ? { model } : {}),
    });
    return {
      threadId: input.threadId,
      turnId,
      // Everything delivered so far. Persisted by T3 and handed back to
      // `startSession` on reconnect.
      ...(state.cursor ? { resumeCursor: state.cursor } : {}),
    } satisfies ProviderTurnStartResult;
  });

  const interruptTurn: AtlasAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const state = yield* requireSession(threadId);
      yield* send(state, "interrupt", {});
    },
  );

  const respondToRequest: AtlasAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const state = yield* requireSession(threadId);
      yield* send(state, "approve", {
        request_id: requestId,
        approved: decision === "accept" || decision === "acceptForSession",
      });
    },
  );

  const respondToUserInput: AtlasAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const state = yield* requireSession(threadId);
    yield* send(state, "answer", { request_id: requestId, value: answers });
  });

  const stopSession: AtlasAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const state = sessions.get(threadId);
      if (state === undefined) return;
      sessions.delete(threadId);
      // Mark it BEFORE closing, so the close handler does not report a deliberate
      // detach as a transport failure.
      state.closing = true;
      // Closing the socket detaches the lens. The Atlas run is durable and keeps
      // going — there is no process here to kill, which is the whole difference
      // between this adapter and the CLI-backed ones.
      yield* Effect.sync(() => state.socket.close());
    },
  );

  const listSessions: AtlasAdapterShape["listSessions"] = () =>
    Effect.sync(() => [...sessions.values()].map((s) => s.session));

  const hasSession: AtlasAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: AtlasAdapterShape["readThread"] = (threadId) =>
    Effect.succeed({ threadId, turns: [] });

  // Honest refusal rather than a silent no-op: Atlas has no checkpoint surface, so
  // there is nothing to roll back to (GAP-009).
  const rollbackThread: AtlasAdapterShape["rollbackThread"] = (threadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: ATLAS_ADAPTER_KIND,
        method: "thread/rollback",
        detail: `Atlas has no checkpoint surface, so thread ${threadId} cannot be rolled back.`,
      }),
    );

  const stopAll: AtlasAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      for (const state of sessions.values()) state.socket.close();
      sessions.clear();
    });

  const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

  return {
    provider: ATLAS_ADAPTER_KIND,
    // A run's model is chosen per request on the Atlas side, so switching mid
    // session needs no session restart.
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents,
  } satisfies AtlasAdapterShape;
});
