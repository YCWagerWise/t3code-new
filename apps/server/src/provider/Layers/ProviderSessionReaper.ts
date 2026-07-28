import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How long a stopped runtime may still show an in-flight turn before it is treated
 * as stranded rather than mid-shutdown.
 *
 * A normal stop briefly holds both states while the terminal event is projected, so
 * repairing instantly would race that window. Deliberately far shorter than the
 * inactivity threshold: the contradiction is already terminal — the runtime that
 * owned the turn is gone — so there is nothing to wait thirty minutes for.
 */
const DEFAULT_STRANDED_GRACE_MS = 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly strandedGraceMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const strandedGraceMs = Math.max(0, options?.strandedGraceMs ?? DEFAULT_STRANDED_GRACE_MS);

    /**
     * Settle a thread whose runtime is gone but whose projection still shows a turn.
     *
     * Mirrors the session-stop command the delete flow already dispatches, so the
     * repair produces exactly the state an ordinary stop would have: no turn, a
     * terminal status, and whatever error the provider last reported preserved.
     * `lastError` is never overwritten — losing the reason a turn failed is worse
     * than leaving it unattributed.
     */
    const repairStrandedSession = (input: {
      readonly threadId: Parameters<typeof providerService.stopSession>[0]["threadId"];
      readonly session: {
        readonly providerName?: string | null;
        readonly providerInstanceId?: string | undefined;
        readonly runtimeMode?: string;
        readonly lastError?: string | null;
      };
      readonly activeTurnId: string;
      readonly nowMs: number;
    }) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs));
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`reaper-strand-repair-${input.threadId}-${input.nowMs}`),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status: "stopped",
            providerName: input.session.providerName ?? null,
            ...(input.session.providerInstanceId !== undefined
              ? { providerInstanceId: input.session.providerInstanceId }
              : {}),
            runtimeMode: input.session.runtimeMode ?? "full-access",
            activeTurnId: null,
            lastError: input.session.lastError ?? null,
            updatedAt: nowIso,
          },
          createdAt: nowIso,
        } as Parameters<typeof orchestrationEngine.dispatch>[0]);
        yield* Effect.logInfo("provider.session.reaper.repaired-stranded-turn", {
          threadId: input.threadId,
          activeTurnId: input.activeTurnId,
          reason: "runtime_stopped_with_active_turn",
        });
      });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        const lastSeenMsForBinding = Date.parse(binding.lastSeenAt);

        if (binding.status === "stopped") {
          // A stopped runtime with a turn still in flight is a contradiction that
          // NOTHING else repairs: shutdown records the runtime stopped without
          // emitting a terminal event, and both guards in this loop used to skip
          // the row — once for being stopped, once for having an active turn. The
          // thread then displays "Working" forever, and Stop cannot help because
          // there is no live session left to interrupt.
          //
          // The runtime that owned the turn is gone, so the turn is not running.
          // Settle it rather than skipping it.
          const strandedThread = yield* projectionSnapshotQuery
            .getThreadShellById(binding.threadId)
            .pipe(Effect.map(Option.getOrUndefined));
          const strandedTurnId = strandedThread?.session?.activeTurnId ?? null;
          if (strandedTurnId == null) {
            continue; // an ordinary stopped binding — unchanged
          }
          if (!Number.isNaN(lastSeenMsForBinding) && now - lastSeenMsForBinding < strandedGraceMs) {
            continue; // let a normal stop finish projecting its own terminal event
          }
          yield* repairStrandedSession({
            threadId: binding.threadId,
            session: strandedThread?.session ?? {},
            activeTurnId: strandedTurnId,
            nowMs: now,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.strand-repair-failed", {
                threadId: binding.threadId,
                cause,
              }),
            ),
          );
          continue;
        }

        const lastSeenMs = lastSeenMsForBinding;
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
