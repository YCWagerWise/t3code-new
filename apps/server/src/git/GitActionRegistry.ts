import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type { GitActionProgressEvent, GitStackedAction } from "@t3tools/contracts";

/**
 * Durable handle for one in-flight `git.runStackedAction` (#278).
 *
 * The action used to exist only as a transient `Stream.callback` in the ws
 * handler plus a React ref on the client. Nothing on the server knew an action
 * was running, so a route refresh or a dropped socket lost the only reference
 * to it: the work kept going, invisibly, and there was no way to look at it or
 * stop it. A commit/push that blocks on hooks or the network is exactly when a
 * user wants both.
 *
 * So the action is registered here for its whole life. Three things follow that
 * a live stream cannot give you:
 *
 *  - INSPECT — "is something running in this repo, and what phase is it in"
 *    survives the client that started it.
 *  - ATTACH — a reconnecting client replays from a CURSOR instead of missing
 *    everything that happened while it was gone.
 *  - CANCEL — reaches the server-side fiber, and through its scope, the git
 *    child process. Not a cleared toast, not an aborted client stream.
 */
export type GitActionRunStatus = "running" | "completed" | "failed" | "canceled";

export interface GitActionSnapshot {
  readonly actionId: string;
  readonly cwd: string;
  readonly action: GitStackedAction;
  readonly status: GitActionRunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Failure message for `failed`; the cancel reason for `canceled`. */
  readonly failure: string | null;
  /** Events retained and replayable right now. */
  readonly eventCount: number;
  /**
   * Events dropped because the retention cap was hit.
   *
   * Surfaced rather than swallowed: a replay that silently omits frames looks
   * exactly like an action that never emitted them, and a client folding the
   * stream would render a phase that never ended. A non-zero value here means
   * "this transcript has a hole", which a caller can say out loud.
   */
  readonly droppedEvents: number;
}

type Subscriber = {
  readonly onEvent: (event: GitActionProgressEvent) => void;
  readonly onEnd: (snapshot: GitActionSnapshot) => void;
};

interface ActionRecord {
  actionId: string;
  cwd: string;
  action: GitStackedAction;
  status: GitActionRunStatus;
  startedAt: string;
  endedAt: string | null;
  failure: string | null;
  events: Array<GitActionProgressEvent>;
  droppedEvents: number;
  fiber: Fiber.Fiber<unknown, unknown> | null;
  subscribers: Set<Subscriber>;
}

/**
 * Per-action event retention. A hook that prints a lot of output would
 * otherwise grow this without bound for the length of the action.
 */
export const MAX_RETAINED_EVENTS = 2_000;

/**
 * Finished actions kept for late inspection/attach. A client that reconnects
 * after the action completed still needs to learn how it ended; keeping every
 * action forever would be a leak for a long-lived server.
 */
export const MAX_FINISHED_RECORDS = 32;

const snapshotOf = (record: ActionRecord): GitActionSnapshot => ({
  actionId: record.actionId,
  cwd: record.cwd,
  action: record.action,
  status: record.status,
  startedAt: record.startedAt,
  endedAt: record.endedAt,
  failure: record.failure,
  eventCount: record.events.length,
  droppedEvents: record.droppedEvents,
});

export class GitActionRegistry extends Context.Service<
  GitActionRegistry,
  {
    readonly register: (input: {
      readonly actionId: string;
      readonly cwd: string;
      readonly action: GitStackedAction;
    }) => Effect.Effect<void>;
    readonly bindFiber: (
      actionId: string,
      fiber: Fiber.Fiber<unknown, unknown>,
    ) => Effect.Effect<void>;
    readonly publish: (actionId: string, event: GitActionProgressEvent) => Effect.Effect<void>;
    readonly finish: (
      actionId: string,
      outcome: { readonly status: GitActionRunStatus; readonly failure?: string | null },
    ) => Effect.Effect<void>;
    readonly inspect: (actionId: string) => Effect.Effect<GitActionSnapshot | null>;
    readonly list: () => Effect.Effect<ReadonlyArray<GitActionSnapshot>>;
    readonly eventsSince: (
      actionId: string,
      cursor: number,
    ) => Effect.Effect<ReadonlyArray<GitActionProgressEvent>>;
    readonly subscribe: (actionId: string, subscriber: Subscriber) => Effect.Effect<() => void>;
    readonly cancel: (actionId: string, reason?: string) => Effect.Effect<boolean>;
  }
>()("t3/git/GitActionRegistry") {}

export const make = () =>
  Effect.sync(() => {
    const records = new Map<string, ActionRecord>();
    /** Completion order, so retention evicts the oldest finished action first. */
    const finishedOrder: Array<string> = [];

    const evictFinished = () => {
      while (finishedOrder.length > MAX_FINISHED_RECORDS) {
        const oldest = finishedOrder.shift();
        if (oldest !== undefined) records.delete(oldest);
      }
    };

    const register: GitActionRegistry["Service"]["register"] = (input) =>
      Effect.sync(() => {
        // Re-registering an id replaces a FINISHED record and is refused for a
        // running one: two live actions under one id would interleave their
        // events into a single transcript and make cancel ambiguous.
        const existing = records.get(input.actionId);
        if (existing !== undefined && existing.status === "running") return;
        records.set(input.actionId, {
          actionId: input.actionId,
          cwd: input.cwd,
          action: input.action,
          status: "running",
          startedAt: new Date().toISOString(),
          endedAt: null,
          failure: null,
          events: [],
          droppedEvents: 0,
          fiber: null,
          subscribers: new Set(),
        });
      });

    const bindFiber: GitActionRegistry["Service"]["bindFiber"] = (actionId, fiber) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        if (record !== undefined) record.fiber = fiber;
      });

    const publish: GitActionRegistry["Service"]["publish"] = (actionId, event) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        if (record === undefined) return;
        record.events.push(event);
        if (record.events.length > MAX_RETAINED_EVENTS) {
          // Drop from the FRONT: the tail is what a reattaching client needs to
          // know where the action is now. The count makes the hole visible.
          const overflow = record.events.length - MAX_RETAINED_EVENTS;
          record.events.splice(0, overflow);
          record.droppedEvents += overflow;
        }
        for (const subscriber of record.subscribers) subscriber.onEvent(event);
      });

    const finish: GitActionRegistry["Service"]["finish"] = (actionId, outcome) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        if (record === undefined || record.status !== "running") return;
        record.status = outcome.status;
        record.failure = outcome.failure ?? null;
        record.endedAt = new Date().toISOString();
        record.fiber = null;
        const snapshot = snapshotOf(record);
        for (const subscriber of record.subscribers) subscriber.onEnd(snapshot);
        record.subscribers.clear();
        finishedOrder.push(actionId);
        evictFinished();
      });

    const inspect: GitActionRegistry["Service"]["inspect"] = (actionId) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        return record === undefined ? null : snapshotOf(record);
      });

    const list: GitActionRegistry["Service"]["list"] = () =>
      Effect.sync(() => Array.from(records.values(), snapshotOf));

    const eventsSince: GitActionRegistry["Service"]["eventsSince"] = (actionId, cursor) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        if (record === undefined) return [];
        const from = cursor < 0 ? 0 : cursor;
        return record.events.slice(from);
      });

    const subscribe: GitActionRegistry["Service"]["subscribe"] = (actionId, subscriber) =>
      Effect.sync(() => {
        const record = records.get(actionId);
        if (record === undefined) return () => {};
        // An already-finished action gets the terminal callback immediately
        // rather than a subscription that will never fire — otherwise a client
        // attaching one tick late waits forever for an end that already happened.
        if (record.status !== "running") {
          subscriber.onEnd(snapshotOf(record));
          return () => {};
        }
        record.subscribers.add(subscriber);
        return () => {
          record.subscribers.delete(subscriber);
        };
      });

    const cancel: GitActionRegistry["Service"]["cancel"] = (actionId, reason) =>
      Effect.gen(function* () {
        const record = records.get(actionId);
        if (record === undefined || record.status !== "running") return false;
        const fiber = record.fiber;
        if (fiber !== null) {
          // THIS IS THE PART THAT MATTERS. Interrupting the fiber closes the
          // scope the git child was spawned in (processRunner spawns under
          // `Effect.scoped`), so the process is killed rather than left running
          // behind a UI that stopped listening.
          //
          // AND THEN WE WAIT FOR IT. `Fiber.interrupt` only SIGNALS — it returns
          // before the fiber's finalizers have run, which for us means before the
          // child process is actually dead. Reporting `true` at that point would
          // be the same lie in miniature that this finding is about: the caller
          // is told the work stopped while git is still mid-push. `Fiber.await`
          // resolves once the fiber is really finished, so a `true` from here
          // means the process is gone, not merely asked to leave.
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          yield* Fiber.await(fiber).pipe(Effect.ignore);
        }
        const message = reason ?? "canceled";
        // Terminal frame in the CONTRACT's vocabulary. `action_failed` is a shape
        // the client reducer already folds; inventing a `action_canceled` kind
        // would be an event no reducer has a case for, which is silence with
        // extra steps.
        const last = record.events.at(-1);
        yield* publish(actionId, {
          actionId,
          cwd: record.cwd,
          action: record.action,
          kind: "action_failed",
          phase:
            last !== undefined && "phase" in last && typeof last.phase === "string"
              ? last.phase
              : null,
          message,
        } as GitActionProgressEvent);
        yield* finish(actionId, { status: "canceled", failure: message });
        return true;
      });

    return GitActionRegistry.of({
      register,
      bindFiber,
      publish,
      finish,
      inspect,
      list,
      eventsSince,
      subscribe,
      cancel,
    });
  });

export const layer = Layer.effect(GitActionRegistry, make());
