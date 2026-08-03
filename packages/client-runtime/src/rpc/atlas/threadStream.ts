/**
 * `subscribeThread` on the Atlas transport (doc 15 §2.3): ThreadFeed → projection →
 * `OrchestrationThreadStreamItem`. Substrate over shims: this module composes the two
 * substrates that already exist — `openThreadFeed` (ordered/deduped frames) and
 * `applyFeedEvent` (the pure fold) — and adds ONLY the stream-item envelope. The thread
 * itself is built downstream by `threadReducer`, the client's single folding authority.
 *
 * Contract (state/threads.ts): snapshot first, then events with strictly increasing
 * `sequence` (the client drops `<=` its cursor), `synchronized` at the replay boundary.
 * On `reset` (feed recreated) a FRESH snapshot re-bases the client before more events.
 */

import type { OrchestrationThreadDetailSnapshot } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/unstable/socket/Socket";

import { applyFeedEvent, initialProjectionState, type ProjectionState } from "./projection.ts";
import { openThreadFeed, type ThreadFeedAuthError } from "./threadFeed.ts";

export type ThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: OrchestrationThreadDetailSnapshot }
  | { readonly kind: "event"; readonly event: unknown }
  | { readonly kind: "synchronized" };

/** The minimal legal thread (doc 16 §"Minimal legal snapshot"), sequence-stamped. One
 * boundary cast — the test decodes it through the real snapshot schema. */
const snapshotAt = (state: ProjectionState): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: state.sequence,
    thread: {
      id: state.threadId,
      projectId: "atlas",
      title: `Thread ${state.threadId}`,
      modelSelection: { instanceId: "atlas", model: "atlas" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

export interface ThreadStreamOptions {
  readonly socketBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: string;
  readonly runId: string;
  readonly plugin?: string | undefined;
}

export const openThreadStream = (
  options: ThreadStreamOptions,
): Stream.Stream<ThreadStreamItem, ThreadFeedAuthError, Socket.WebSocketConstructor> => {
  const initial = initialProjectionState(options.threadId, options.runId);
  const live = openThreadFeed({
    socketBaseUrl: options.socketBaseUrl,
    runId: options.runId,
    accessToken: options.accessToken,
    plugin: options.plugin,
  }).pipe(
    Stream.mapAccum(
      () => initial,
      (state: ProjectionState, feedEvent) => {
        const r = applyFeedEvent(state, feedEvent);
        const items: Array<ThreadStreamItem> = [];
        if (r.reset === true) {
          // The feed was recreated: every accumulated fact is stale. Re-base the client
          // with a fresh snapshot BEFORE any replayed-from-zero events reach it.
          items.push({ kind: "snapshot", snapshot: snapshotAt(r.state) });
        }
        for (const event of r.events) {
          items.push({ kind: "event", event });
        }
        if (feedEvent.kind === "replay-complete") {
          items.push({ kind: "synchronized" });
        }
        return [r.state, items] as const;
      },
    ),
  );
  // Snapshot first, always — a client cannot fold events onto a thread it does not have.
  return Stream.concat(
    Stream.make({ kind: "snapshot", snapshot: snapshotAt(initial) } as ThreadStreamItem),
    live,
  );
};
