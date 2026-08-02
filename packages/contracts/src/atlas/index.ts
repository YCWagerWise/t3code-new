/**
 * The Atlas wire contract — generated from `atlas-protocol`, the crate that owns it.
 *
 * Atlas is the semantic schema owner (doc 12 §9): everything under `_generated` is emitted
 * from the checked-in artifact `atlas-protocol.flat.json`, whose own drift guard lives in
 * the Rust crate (`schema.rs::the_checked_in_contract_matches_the_code`). Nothing here is
 * authored; changing the wire means changing the Rust types and regenerating.
 *
 * These replace the hand-written all-optional `AtlasFrame` interface in
 * `apps/server/src/provider/Layers/AtlasAdapter.ts` as the client's decoder vocabulary:
 *
 * - `FeedFrame` — every durable frame the `/_feed` socket streams and
 *   `/console/v1/threads/{id}/feed` pages (same envelope, byte-identical).
 * - `TransportFrame` — `hb`/`error`, transport-only, never stored or replayed.
 * - `RunSnapshot` — the supervisor's authoritative current-run state.
 * - `CommandEnvelope` — idempotent console commands (`request_id`-keyed receipts).
 * - `HandshakeFrame` — `GET /console/v1/handshake`.
 * - `StructuredError` — every typed refusal (`code`, `retryable`, `details`).
 */
export * from "./_generated/schema.gen.ts";
export { ATLAS_PROTOCOL_VERSION } from "./_generated/meta.gen.ts";
