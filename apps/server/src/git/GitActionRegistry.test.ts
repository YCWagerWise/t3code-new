import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { GitActionProgressEvent } from "@t3tools/contracts";
import * as GitActionRegistry from "./GitActionRegistry.ts";

const started = (actionId: string): GitActionProgressEvent =>
  ({
    actionId,
    cwd: "/repo",
    action: "commit_push",
    kind: "action_started",
    phases: ["commit", "push"],
  }) as GitActionProgressEvent;

const phase = (actionId: string, phase: "commit" | "push"): GitActionProgressEvent =>
  ({
    actionId,
    cwd: "/repo",
    action: "commit_push",
    kind: "phase_started",
    phase,
    label: phase === "commit" ? "Committing" : "Pushing",
  }) as GitActionProgressEvent;

const withRegistry = <A, E>(
  f: (registry: GitActionRegistry.GitActionRegistry["Service"]) => Effect.Effect<A, E>,
) => GitActionRegistry.make().pipe(Effect.flatMap(f));

const register = (registry: GitActionRegistry.GitActionRegistry["Service"], actionId: string) =>
  registry.register({ actionId, cwd: "/repo", action: "commit_push" });

describe("GitActionRegistry", () => {
  /**
   * The reason #278 exists: the only reference to a running action was the live
   * stream. A client that reconnects must be able to learn what it missed.
   */
  it.effect("a reconnecting client replays from its cursor instead of losing the gap", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a1");
        yield* registry.publish("a1", started("a1"));
        yield* registry.publish("a1", phase("a1", "commit"));
        yield* registry.publish("a1", phase("a1", "push"));

        // A client that saw the first frame and then dropped its socket.
        const missed = yield* registry.eventsSince("a1", 1);
        expect(missed.map((e) => e.kind)).toEqual(["phase_started", "phase_started"]);
        expect(missed.map((e) => ("phase" in e ? e.phase : null))).toEqual(["commit", "push"]);

        // A fresh client with no cursor gets the whole transcript.
        const all = yield* registry.eventsSince("a1", 0);
        expect(all.length).toBe(3);
      }),
    ),
  );

  it.effect("an action is inspectable after the client that started it is gone", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a2");
        yield* registry.publish("a2", started("a2"));

        const running = yield* registry.inspect("a2");
        expect(running?.status).toBe("running");
        expect(running?.cwd).toBe("/repo");

        yield* registry.finish("a2", { status: "completed" });
        const done = yield* registry.inspect("a2");
        expect(done?.status).toBe("completed");
        expect(done?.endedAt).not.toBeNull();
        // Still inspectable AFTER completion — a client reconnecting late has
        // to be able to learn how it ended.
        expect(done?.eventCount).toBe(1);
      }),
    ),
  );

  /**
   * THE ONE THAT MATTERS. #278: "cancellation has to reach the server-side
   * process, not clear the toast." So this does not assert a status flag — it
   * asserts that a fiber which was really running really stopped, by proving
   * its cleanup ran and its body never reached the line after the park.
   */
  it.effect("cancel interrupts the running fiber, so its scope finalizer fires", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        // `finalized` is the observable proxy for "the git child was killed":
        // processRunner spawns under `Effect.scoped`, so the thing that kills
        // the process is exactly the thing that runs this finalizer.
        // Synchronous, not a Deferred awaited from another fiber —
        // `Fiber.interrupt` does not return until finalizers have run, so by
        // the time `cancel` resolves this array is already the answer.
        const finalized: Array<string> = [];
        const reachedEnd: Array<string> = [];
        const neverEnds = yield* Deferred.make<void>();

        yield* register(registry, "a3");
        const entered: Array<string> = [];
        const fiber = yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => finalized.push("scope-closed")));
          entered.push("running");
          // Stands in for a git child blocked on hooks or the network.
          yield* Deferred.await(neverEnds);
          reachedEnd.push("body-completed");
        }).pipe(Effect.scoped, Effect.forkChild);

        yield* registry.bindFiber("a3", fiber);
        // PRECONDITION: the fiber must actually be RUNNING and parked before we
        // cancel it. Cancelling a fiber that has not started yet runs no
        // finalizer and would let this test pass against a cancel that does
        // nothing — the same "asserted a path that never ran" trap that has
        // burned two other findings in this channel today.
        yield* Effect.yieldNow;
        expect(entered).toEqual(["running"]);
        const canceled = yield* registry.cancel("a3", "user stopped it");
        expect(canceled).toBe(true);

        // The scope holding the child closed.
        expect(finalized).toEqual(["scope-closed"]);
        // And the body never got past the park — it was stopped, not awaited.
        expect(reachedEnd).toEqual([]);

        const snapshot = yield* registry.inspect("a3");
        expect(snapshot?.status).toBe("canceled");
        expect(snapshot?.failure).toBe("user stopped it");
      }),
    ),
  );

  it.effect("cancel emits a terminal frame in the contract's own vocabulary", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a4");
        yield* registry.publish("a4", started("a4"));
        yield* registry.publish("a4", phase("a4", "push"));
        yield* registry.cancel("a4", "user stopped it");

        const events = yield* registry.eventsSince("a4", 0);
        const last = events.at(-1);
        // `action_failed`, NOT an invented `action_canceled`: a kind no reducer
        // has a case for is silence with extra steps.
        expect(last?.kind).toBe("action_failed");
        expect(last !== undefined && "message" in last ? last.message : null).toBe(
          "user stopped it",
        );
        // It names the phase that was in flight, so the UI can say WHERE it stopped.
        expect(last !== undefined && "phase" in last ? last.phase : null).toBe("push");
      }),
    ),
  );

  it.effect("cancelling an unknown or already-finished action reports false", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        expect(yield* registry.cancel("nope")).toBe(false);

        yield* register(registry, "a5");
        yield* registry.finish("a5", { status: "completed" });
        // Not `true` — cancelling something that already ended would tell the
        // caller it stopped work that had already finished.
        expect(yield* registry.cancel("a5")).toBe(false);
      }),
    ),
  );

  it.effect("a live subscriber sees events as they happen and one terminal callback", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        let ended = 0;
        yield* register(registry, "a6");
        const unsubscribe = yield* registry.subscribe("a6", {
          onEvent: (event) => seen.push(event.kind),
          onEnd: () => {
            ended += 1;
          },
        });

        yield* registry.publish("a6", started("a6"));
        yield* registry.publish("a6", phase("a6", "commit"));
        yield* registry.finish("a6", { status: "completed" });
        unsubscribe();

        expect(seen).toEqual(["action_started", "phase_started"]);
        expect(ended).toBe(1);
      }),
    ),
  );

  /**
   * A client attaching one tick after completion must not wait for an end that
   * already happened.
   */
  it.effect("subscribing to a finished action ends immediately instead of hanging", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a7");
        yield* registry.finish("a7", { status: "failed", failure: "push refused" });

        let endedWith: string | null = null;
        yield* registry.subscribe("a7", {
          onEvent: () => {},
          onEnd: (snapshot) => {
            endedWith = snapshot.status;
          },
        });
        expect(endedWith).toBe("failed");
      }),
    ),
  );

  /** Retention must be visible, not silent. */
  it.effect("dropping events past the retention cap is reported, not hidden", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a8");
        const overshoot = 5;
        for (let i = 0; i < GitActionRegistry.MAX_RETAINED_EVENTS + overshoot; i += 1) {
          yield* registry.publish("a8", phase("a8", "commit"));
        }
        const snapshot = yield* registry.inspect("a8");
        expect(snapshot?.eventCount).toBe(GitActionRegistry.MAX_RETAINED_EVENTS);
        expect(snapshot?.droppedEvents).toBe(overshoot);
      }),
    ),
  );

  it.effect("finished actions are evicted so a long-lived server does not leak", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const total = GitActionRegistry.MAX_FINISHED_RECORDS + 4;
        for (let i = 0; i < total; i += 1) {
          yield* register(registry, `bulk-${i}`);
          yield* registry.finish(`bulk-${i}`, { status: "completed" });
        }
        const all = yield* registry.list();
        expect(all.length).toBe(GitActionRegistry.MAX_FINISHED_RECORDS);
        // The OLDEST went first; the most recent are the ones a user might
        // still be looking at.
        expect(yield* registry.inspect("bulk-0")).toBeNull();
        expect((yield* registry.inspect(`bulk-${total - 1}`))?.status).toBe("completed");
      }),
    ),
  );

  it.effect("a second register under a live id does not fork the transcript", () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        yield* register(registry, "a9");
        yield* registry.publish("a9", started("a9"));
        // Same id while still running: refused, so the existing transcript and
        // its cancel target stay intact.
        yield* register(registry, "a9");
        const snapshot = yield* registry.inspect("a9");
        expect(snapshot?.eventCount).toBe(1);
        expect(snapshot?.status).toBe("running");
      }),
    ),
  );
});
