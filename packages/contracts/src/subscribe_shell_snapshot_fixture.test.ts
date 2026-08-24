import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationShellStreamItem } from "./orchestration.ts";
// JSON module import — resolveJsonModule is on in tsconfig.base, no node:fs
// needed. Vitest resolves the path from this file's location, and the bytes
// are the same the Rust producer wrote (JSON.stringify equivalence in the
// object shape, not literal byte-order — the wire contract is the decode).
import subscribeShellSnapshot from "../fixtures/subscribe_shell_snapshot.json" with { type: "json" };

/**
 * #398 (narrowed bar): the Rust product-edge test at
 * `t3code-new/backend/src/server_main.rs::subscribe_shell_snapshot_is_a_recorded_fixture_the_ts_contract_decodes`
 * captures a real `subscribeShell` snapshot Chunk from the running handler
 * and writes it to `packages/contracts/fixtures/subscribe_shell_snapshot.json`.
 *
 * This test decodes those bytes through the TS contract union — the same
 * one the reducer uses. A Rust producer that drops a field or shifts a
 * type fails HERE with an Effect ParseError naming the offending path.
 *
 * Regenerate the fixture with:
 *   T3_UPDATE_FIXTURES=1 cargo test --bin t3code-server \
 *     subscribe_shell_snapshot_is_a_recorded_fixture_the_ts_contract_decodes
 */
describe("subscribe_shell_snapshot fixture", () => {
  it("decodes cleanly against OrchestrationShellStreamItem", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationShellStreamItem)(subscribeShellSnapshot);
    assert.strictEqual(decoded.kind, "snapshot");
    if (decoded.kind !== "snapshot") return;
    assert.isArray(decoded.snapshot.projects);
    assert.isArray(decoded.snapshot.threads);
    assert.isNumber(decoded.snapshot.snapshotSequence);
    assert.isString(decoded.snapshot.updatedAt);
  });
});
