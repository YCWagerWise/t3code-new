import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { OrchestrationEvent } from "@t3tools/contracts";

import { deriveOrchestrationBatchEffects } from "./orchestrationEventEffects";

/**
 * #468/#437 — the two ends of draft promotion, checked against each other.
 *
 * The client leaves `/draft/<id>` on exactly one event: `thread.created`. The
 * backend did not emit it, so every turn worked end to end — durable row,
 * sidebar, running/assistant/idle all delivered on the subscribed socket — and
 * the view sat on "Thinking" forever with the answer one route away.
 *
 * The Rust side now emits it and has its own contract test. That test proves the
 * event is emitted; it cannot prove the CLIENT can read it, and a payload that
 * decodes on neither side is the same bug wearing a different hat. So the JSON
 * below is not hand-written: it is the frame a real `ensure_thread_on_shell`
 * emission produced on the build box, pasted verbatim. It is decoded through the
 * shared contract schema first — if either end drifts, the decode fails here
 * before the reducer is ever reached.
 */
const EMITTED_BY_THE_RUST_BACKEND = {
  aggregateId: "t-created",
  aggregateKind: "thread",
  causationEventId: null,
  commandId: null,
  correlationId: null,
  eventId: "evt_01M12Q3AESJ1V6PDF4ZM1YHQVN",
  metadata: {},
  occurredAt: "2026-08-27T22:57:52.089Z",
  payload: {
    branch: null,
    createdAt: "2026-08-27T22:57:52.087Z",
    interactionMode: "default",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-haiku-4-5-20251001",
    },
    projectId: "p-workspace",
    runtimeMode: "full-access",
    threadId: "t-created",
    title: "promote me",
    updatedAt: "2026-08-27T22:57:52.087Z",
    worktreePath: null,
  },
  sequence: 1,
  type: "thread.created",
};

describe("draft promotion", () => {
  it("promotes the draft on the thread.created frame the backend actually emits", () => {
    const event = Schema.decodeUnknownSync(OrchestrationEvent)(
      EMITTED_BY_THE_RUST_BACKEND,
    );

    const effects = deriveOrchestrationBatchEffects([event]);

    expect(effects.promoteDraftThreadIds).toEqual(["t-created"]);
  });

  it("does not promote on thread-upserted, the shell frame that used to be all the backend sent", () => {
    // Deliberately not decoded: `thread-upserted` is not an OrchestrationEvent
    // at all, it is a shell frame. That is the whole finding — the backend was
    // answering a different question than the one the reducer asks.
    const effects = deriveOrchestrationBatchEffects([
      { ...EMITTED_BY_THE_RUST_BACKEND, type: "thread-upserted" } as never,
    ]);

    expect(effects.promoteDraftThreadIds).toEqual([]);
  });
});
