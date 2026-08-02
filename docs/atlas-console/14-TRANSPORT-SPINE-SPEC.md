# 14 — The transport spine: what the rewrite must provide

**Scope:** slice 2 of the cutover plan — replacing the Effect-RPC transport inside
`packages/client-runtime/src/rpc/*` with an Atlas-native one. Slice 1 (generated contracts,
`packages/contracts/src/atlas/`) is done. Slice 3 (the projection store) consumes the seam
defined in §4; it is not this document.

Everything here was read from the code on 2026-08-02, not from earlier docs.

---

## 1. The boundary that must not move

The rewrite is contained entirely behind `RpcSessionFactory.connect`. These stay
byte-compatible:

| Surface                     | Where                              | Contract                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RpcSession`                | `session.ts:25-31`                 | `{ client: WsRpcProtocolClient, initialConfig: Effect<ServerConfig, ConnectionAttemptError>, ready, probe, closed }`                                                                                                                                                                                           |
| `RpcSessionFactory.connect` | `session.ts:33-40`                 | `(PreparedConnection) → Effect<RpcSession, ConnectionAttemptError, Scope>`                                                                                                                                                                                                                                     |
| The four helpers            | `client.ts`                        | `request` / `runStream` / `subscribe` / `subscribeDynamic` all dispatch `session.client[tag](input)` — **unchanged files**                                                                                                                                                                                     |
| Error vocabulary            | `connection/model.ts`, `client.ts` | `ConnectionBlockedError{reason:"permission"}`, `ConnectionTransientError{reason:"transport"\|"remote-unavailable"}`, `EnvironmentRpcUnavailableError`, and each method's contract error union (`EnvironmentAuthorizationError`, …). The state layer maps these; new error types are new UI states nobody built |
| `PreparedConnection`        | `connection/model.ts:116-123`      | `{environmentId, label, httpBaseUrl, socketUrl, httpAuthorization, target}` — resolver semantics unchanged. `httpBaseUrl` is the Atlas node base; the spine derives feed-socket URLs itself (`socketUrl` becomes vestigial for Atlas targets)                                                                  |
| Transport-failure tolerance | `client.ts` `subscribeDynamic`     | Its `RpcClientError`-detection arm treats transport loss as "wait for next session". The Atlas client must fail streams with an error that same arm recognises (keep failing with `RpcClientError`-shaped transport errors, or extend the guard in the same commit)                                            |

**Rule zero (docs 08/12):** the spine must never infer run termination from connection
state. Socket loss is a connection fact, not a run fact.

## 2. Session architecture: one session, N run sockets

The current spine holds ONE WebSocket per environment carrying all 70 methods. Atlas's
`/_feed` is **per run_id**. The spine therefore splits:

**Session lane (no standing socket):**

- `ready` — two authenticated exchanges, in order:
  1. `GET /console/v1/handshake` with Bearer `httpAuthorization` → decode generated
     `HandshakeFrame` → `ServerReady{fleet_id, granted_scopes, capabilities, heartbeat_interval_ms}`.
     No credential where one is required → `ConnectionBlockedError("permission")`; network →
     transient. (doc 08 D1: absence of a token is `setup-required`, a rejected token is
     `unauthorized` — the resolver's credential-presence knowledge feeds the distinction.)
  2. One readiness feed probe: open `/_feed?run_id=t3-readiness&access_token=…`, await the
     first `hb` (TransportFrame) or typed error frame, close. 5s budget. The feed socket is
     the _execution_ boundary and authenticates separately from HTTP (donor:
     `AtlasClient.ts:708-780`); a ready that skips it reports ready for a node whose socket
     auth is broken.
- `probe` — re-issue the handshake. Cheap, authenticated, no socket.
- `initialConfig` — a **synthesized** `ServerConfig`: handshake (scopes → auth surface,
  capabilities) + `GET /_members` manifest (node identity, `execution.{default_model,backend}`
  → model entries, `containment` when present). Enumerate the fields `apps/web` actually
  reads (`config.environment.capabilities.*` chiefly) and set the rest to their inert
  defaults; a capability not synthesized is `false`, which must agree with the §5 gate —
  the config may never advertise a capability the gate refuses.
- `closed` — fails only on genuine session teardown (scope close, credential revocation
  detected by probe). **Never** on a run-socket drop.

**Run lane (per thread, lazy):** `ThreadFeed` (§4) opens
`ws(s)://{base}/_feed?run_id=thr-{threadId}&plugin=&access_token=…[&after=&epoch=]` on
first subscription to that thread, closes on scope release, reconnects with exponential
backoff (500ms · ×1.5 · cap 5s · jitter) while subscribed. Concurrent sockets are capped
(default 8, LRU-close for background threads — the state layer resubscribes on focus via
its existing `resubscribe`/wakeup machinery).

## 3. Cursor, replay, and decode rules

- **Cursor** is `{epoch, seq}`. Advance `seq = max(seq, frame.seq)` per received frame —
  including frames the projection drops (echoes, unknown kinds): delivery advances the
  cursor, rendering does not.
- **Resume** sends `after` and `epoch` **together or not at all** (donor rule,
  `AtlasClient.ts:385`). A cached `afterSequence` without its epoch is unusable — replay
  from 0 instead. Consequence for slice 3: the cached thread snapshot must carry the Atlas
  epoch so a page reload can resume; until it does, reload = full replay (correct, just
  slower).
- **Epoch change** (frame or `hb` carrying `epoch ≠` stored): drop accumulated state for
  that thread, emit `reset` (§4), replay from 0. The HTTP page route 409s on stale epoch
  (`cursor_epoch_invalid`); the socket silently replays — the spine treats both as the same
  reset event.
- **Echoes:** frames with `role: "console"` advance the cursor and are not forwarded.
- **Decode:** per frame, `Schema.decodeUnknown(FeedFrame)` from `@t3tools/contracts/atlas`.
  - Unknown `kind` → decode fails → skip + debug-log. This is what makes new kinds
    wire-additive (pinned in `atlas.test.ts`).
  - Known kind, bad payload (e.g. unknown turn state) → skip + **warn loudly**. Never
    rendered, never a stream failure. (The donor adapter's green-completed-turn bug.)
  - `hb`/`error` decode as `TransportFrame` — liveness + connection status only, never
    forwarded to the projection.
- **Duplicates** (`seq ≤` cursor) are dropped — replay overlap is the server's right.

## 4. The slice-3 seam: `ThreadFeed`

The spine's product is not `OrchestrationThreadStreamItem` (that is the projection's,
slice 3). The spine exposes one internal interface:

```ts
interface ThreadFeedEvent =
  | { kind: "frame"; frame: FeedFrame }                       // ordered, deduped, echo-free
  | { kind: "replay-complete"; head: number; epoch: number }  // caught up to live
  | { kind: "reset"; epoch: number }                          // epoch changed — discard state
  | { kind: "connection"; state: "connected" | "reconnecting" };

ThreadFeed.open(threadId, cursor?: { afterSequence: number; epoch: number })
  → Stream<ThreadFeedEvent>   // scoped: closing the stream closes the socket
```

`subscribeThread`/`subscribeShell` in the public client remain **capability-gated stubs
until slice 3** wires the projection onto this seam. Slice 2 is done when `ThreadFeed`
itself is proven (§7), not when the panels light up.

## 5. The client object: 70 tags, three fates

`makeWsRpcProtocolClient` is replaced by an Atlas-backed builder producing the same
`WsRpcProtocolClient` shape via a proxy. Every tag is explicitly one of:

**Bound now (slice 2):**

- `orchestration.dispatchCommand` → `POST /console/v1/threads/{thread_id}/commands` with a
  generated `CommandEnvelope`: `protocol_version: 1`, `fleet_id` (from handshake),
  `request_id` = the `commandId` already minted in `operations/commands.ts` (idempotent
  retry ⇒ same envelope), `actor: "t3-code"`. Intent mapping:
  `thread.turn.start → {kind:"start", text}` · `thread.turn.interrupt → {kind:"cancel"}` ·
  `approval.respond` / `user-input.respond → {kind:"resolve_input", request_ref, answer}`.
  Response `RunSnapshot` → `DispatchResult`.
- `orchestration.getTurnDiff` / `getFullThreadDiff` → `GET /console/v1/threads/{id}/diff`
  (`?from=&to=` from checkpoint seqs; bare = full thread) — `unified` → `unifiedDiff`.
- `orchestration.replayEvents` → `GET /console/v1/threads/{id}/feed` (paged; honour
  `has_more`).
- `orchestration.getArchivedShellSnapshot` → `GET /console/v1/threads/{id}` (RunSnapshot;
  the transcript half is feed replay — composed in slice 3).
- `server.getConfig` → the synthesized config (§2). `server.probe` → handshake.

**Bound in a later slice, gated until then:** `subscribeThread`, `subscribeShell` (slice 3);
`vcs.*`, `review.getDiffPreview`, `subscribeVcsStatus` (relocate `AtlasVcsDriver`'s
`/_vcs/*` — slice 4); `projects.*`, `filesystem.browse`, `terminal.*`,
`subscribeTerminal*`, `preview.*`, `assets.createUrl`, server diagnostics (Phase 4
capabilities).

**Removed from the Atlas product, gated forever:** `cloud.*`, `server.refreshProviders`,
`server.updateProvider`. Keybinding/settings methods are lens-local per doc 12 §10 and gate
until the lens-local store exists.

Gated = `Effect.fail` / `Stream.fail` with `EnvironmentRpcUnavailableError{environmentId,
message}` naming the capability — the error the command layer already carries in its
channel and the UI already tolerates. The gate table is data (one literal map covering all
70 names), so the §7 test can enumerate it and `requiredScopeForMethod`-style throw on an
unmapped tag.

## 6. HTTP module

`http.ts` keeps its existing exports and gains the Atlas calls the spine needs
(handshake, feed page, diff, commands, `_members`) — Bearer from
`PreparedConnection.httpAuthorization`, JSON decode through the generated schemas,
`StructuredError` bodies surfaced as typed failures. The WS token rides the query string
because a browser WebSocket cannot set headers; **the URL is a secret** — never logged
verbatim (donor: `AtlasClient.ts:373-377`).

## 7. Definition of done (slice 2)

Unit, each mutation-tested (revert the behavior → red):

1. Cursor advances by `max(seq)`; `seq ≤ cursor` dropped (mutation: `>` → `>=`).
2. `after` without `epoch` is never sent (mutation: send it → test fails).
3. Epoch change ⇒ `reset` + replay from 0, state discarded.
4. Console echoes advance the cursor and are not forwarded.
5. Unknown kind skipped without stream failure; known-kind bad payload skipped loudly.
6. Socket kill mid-stream ⇒ `connection: reconnecting` + backoff reopen with
   `after+epoch`; **no terminal event, `closed` untouched**.
7. Gate: table-driven over all 70 tags — every unbound tag fails typed; every bound tag
   dispatches; an unlisted tag throws at construction.
8. `dispatchCommand` retry reuses the same `request_id`.
9. Readiness: no credential → blocked(permission); rejected credential → blocked;
   handshake ok + feed probe ok → ready. (Fake-socket harness: `session.test.ts`'s
   `TestWebSocket` donor.)

Integrated, against a live node (`atlas-host serve` + the Phase-1 routes): 10. `ThreadFeed.open` on the Phase-1 proof thread replays the real 14-frame transcript in
order, `replay-complete` carries the true head. 11. Kill the socket mid-replay ⇒ resume without duplication (client-side twin of the
server-side proof). 12. `dispatchCommand` start → live frames arrive on the same ThreadFeed; repeat with the
same `request_id` ⇒ one actuation (server idempotency observed from the client).

## 8. Decisions taken (veto here, not in review)

- **Readiness includes the feed probe** (not handshake-only) — the socket is the execution
  boundary and authenticates separately.
- **Run-socket cap 8, LRU** — bounded fan-out; background threads resubscribe on focus.
- **Cursor persistence lives with the state layer's cached snapshots** (slice 3 adds epoch
  to the snapshot); the spine is stateless across page loads and full-replays when the
  pair is incomplete.
- **`server.getSettings`/keybindings stay gated** in slice 2 rather than half-ported.
- **`fleet_id`** comes from the handshake, cached on the session.
