import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationShellStreamItem } from "./orchestration.ts";
import threadUpserted from "../fixtures/thread_upserted.json" with { type: "json" };

/**
 * #398 (follow-on): the Rust product-edge test at
 * `t3code-new/backend/src/server_main.rs::thread_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes`
 * captures a real `thread-upserted` frame from the running shell stream
 * and writes it to `packages/contracts/fixtures/thread_upserted.json`.
 *
 * Regenerate with:
 *   T3_UPDATE_FIXTURES=1 cargo test --bin t3code-server \
 *     thread_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes
 */
describe("thread_upserted fixture", () => {
  it("decodes cleanly against OrchestrationShellStreamItem", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationShellStreamItem)(threadUpserted);
    assert.strictEqual(decoded.kind, "thread-upserted");
    if (decoded.kind !== "thread-upserted") return;
    assert.isNumber(decoded.sequence);
    assert.isAtLeast(decoded.sequence, 0);
    assert.isString(decoded.thread.id);
    assert.isAtLeast(decoded.thread.id.length, 1);
  });
});
