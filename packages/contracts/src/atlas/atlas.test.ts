import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import fixtures from "../../test/fixtures/atlas-feed-frames.json" with { type: "json" };
import { FeedFrame, StructuredError, TransportFrame } from "./index.ts";

const decodeFeedFrame = Schema.decodeUnknownEffect(FeedFrame);
const decodeTransportFrame = Schema.decodeUnknownEffect(TransportFrame);
const decodeStructuredError = Schema.decodeUnknownEffect(StructuredError);

// The fixtures are REAL frames captured from a live node's
// `/console/v1/threads/{id}/feed` during the Phase-1 proof turn (a run_bash edit with a
// checkpoint diff) — not hand-written examples. If the generated schemas cannot decode
// these, the generator or the artifact regressed, whatever the unit tests say.
it.effect("every captured live frame decodes as a FeedFrame", () =>
  Effect.gen(function* () {
    assert.isAtLeast(fixtures.length, 8, "the capture covers the M1 vocabulary");
    for (const frame of fixtures) {
      const decoded = yield* decodeFeedFrame(frame);
      assert.equal(decoded.kind, (frame as { kind: string }).kind);
      assert.equal(decoded.run_id, "thr-proof");
    }
  }),
);

it.effect("an unknown kind is refused, not absorbed", () =>
  Effect.gen(function* () {
    // The client-side rule (doc 04 / feed.rs): an unrecognised KIND fails decode and the
    // client ignores the frame — which is what makes new kinds wire-additive. A schema
    // that absorbed unknown kinds would render frames it cannot interpret.
    const base = fixtures[0] as Record<string, unknown>;
    const exit = yield* Effect.exit(
      decodeFeedFrame({ ...base, kind: "brand-new-kind", payload: {} }),
    );
    assert.isTrue(exit._tag === "Failure");
  }),
);

it.effect("an unknown turn state is refused instead of reading as success", () =>
  Effect.gen(function* () {
    // The donor adapter's bug this vocabulary exists to prevent: an unrecognised turn
    // STATE rendered as a completed (green) turn. The schema must refuse it.
    const turn = fixtures.find((f) => (f as { kind: string }).kind === "turn") as Record<
      string,
      unknown
    >;
    const exit = yield* Effect.exit(
      decodeFeedFrame({ ...turn, payload: { state: "definitely-not-a-state" } }),
    );
    assert.isTrue(exit._tag === "Failure");
  }),
);

it.effect("transport frames stay a separate family from feed frames", () =>
  Effect.gen(function* () {
    const hb = {
      version: 1,
      kind: "hb",
      run_id: "thr-proof",
      ts: 1785704325750,
      seq: 14,
      epoch: 1785704325750,
    };
    const decoded = yield* decodeTransportFrame(hb);
    assert.equal(decoded.kind, "hb");
    // A heartbeat must not decode as a durable feed frame — it has no role and is never
    // stored; a client that conflated the families would put heartbeats on the timeline.
    const exit = yield* Effect.exit(decodeFeedFrame(hb));
    assert.isTrue(exit._tag === "Failure");
  }),
);

it.effect("a live StructuredError decodes", () =>
  Effect.gen(function* () {
    // Shape captured from the live 409 (stale epoch) during the same proof.
    const decoded = yield* decodeStructuredError({
      code: "cursor_epoch_invalid",
      message: "cursor epoch does not match this feed; replay from after=0",
      retryable: false,
      request_id: null,
      trace_id: "atlas-feed-http-1785704325750",
      details: { expected_epoch: 1785704325750 },
    });
    assert.equal(decoded.code, "cursor_epoch_invalid");
    assert.isFalse(decoded.retryable);
  }),
);
