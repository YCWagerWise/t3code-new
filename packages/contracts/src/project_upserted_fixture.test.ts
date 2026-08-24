import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationShellStreamItem } from "./orchestration.ts";
import projectUpserted from "../fixtures/project_upserted.json" with { type: "json" };

/**
 * #398 (follow-on): the Rust product-edge test at
 * `t3code-new/backend/src/server_main.rs::project_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes`
 * captures a real `project-upserted` frame from the shell stream (emitted
 * when `project.meta.update` succeeds) and writes it to
 * `packages/contracts/fixtures/project_upserted.json`.
 *
 * Regenerate with:
 *   T3_UPDATE_FIXTURES=1 cargo test --bin t3code-server \
 *     project_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes
 */
describe("project_upserted fixture", () => {
  it("decodes cleanly against OrchestrationShellStreamItem", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationShellStreamItem)(projectUpserted);
    assert.strictEqual(decoded.kind, "project-upserted");
    if (decoded.kind !== "project-upserted") return;
    assert.isNumber(decoded.sequence);
    assert.isAtLeast(decoded.sequence, 0);
    assert.isString(decoded.project.id);
    assert.isAtLeast(decoded.project.id.length, 1);
  });
});
