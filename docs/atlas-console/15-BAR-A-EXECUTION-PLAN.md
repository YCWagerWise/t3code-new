# 15 — Bar A execution plan: step → test → step

Bar A: T3 does real work with Atlas as sole provider. Every step ends in a named
verification; no step starts until the previous one's gate is green. Status boxes get
ticked as we go. Branches: `feat/console-feed-exposure` (atlas-rs),
`feat/atlas-console-integration` (t3code), `feat/cli-spawn-workdir` (agent-sdk-rs).

## Stage 1 — slice-2 live integration (closes doc 14 §7)

- [x] **1.1 Boot rig.** `atlas-host serve` on :3199 (ATLAS*BASH=1, WS token, temp workspace
      root), drive one real coding turn (the Phase-1 recipe). Keep node + thread for 1.2–1.4.
      \_Verify:* `/feed?after=0` returns the full transcript by curl.
- [x] **1.2 ThreadFeed live replay** (§7.10). Node test script (tsx) using client-runtime's
      `openThreadFeed` against :3199 with the real thread.
      _Verify:_ frames arrive in order; `replay-complete.head` == the curl `head`; kinds
      match the curl transcript exactly.
- [x] **1.3 Mid-replay kill → resume** (§7.11). Same script; kill the TCP socket after ~5
      frames; let it reconnect.
      _Verify:_ no duplicate seq across the whole received sequence; total set == 1.2's.
- [x] **1.4 Command idempotency observed client-side** (§7.12). `postCommand` start twice
      with one `request_id`; then `cancel`.
      _Verify:_ one `turn:start` on the feed; cancel produces one cancelled outcome.
- [x] **1.5 Commit** the rig script under `packages/client-runtime/integration/` +
      results in the commit message.

## Stage 2 — slice 3: the projection store

- [x] **2.1 Read map.** Enumerate exactly which `ProviderRuntimeIngestion` arms feed the
      M1 event set (messages, tools, turn lifecycle, approvals, questions, usage, diffs) —
      write the arm→frame table into this doc before porting.
- [x] **2.2 `projection.ts`:** pure function `(state, ThreadFeedEvent) → (state,
OrchestrationEvent[])` + snapshot builder. Port arm-by-arm; item ids per donor scheme
      (`{runId}:{seq}`, `{runId}:tool:{call_id}`).
      _Verify:_ unit tests replay the REAL 14-frame fixture → assert the exact
      OrchestrationEvent list (turn started/items/completed); unknown-frame no-op;
      reset → fresh-snapshot marker. Mutation-test the turn-close and tool-pairing arms.
- [x] **2.3 Un-gate `subscribeThread`:** ThreadFeed → projection → `OrchestrationThreadStreamItem`
      (snapshot → events → synchronized on replay-complete). Epoch rides the snapshot for
      reload-resume.
      _Verify:_ unit — fake socket: subscribe → snapshot+events match fixture; reconnect
      mid-stream → no duplicate sequence.
- [x] **2.4 Un-gate `subscribeShell`:** poll `/_runs` + `/_workspaces` (15s + wakeup),
      diff successive polls into upsert/remove events.
      _Verify:_ unit with stubbed HTTP: first poll → snapshot; changed poll → upserts.
- [x] **2.5** DESIGN NOTE (2026-08-02): align
      `checkpointTurnCount` with the NODE's checkpoint seq (projection currently mints its
      own counter — switch it to `payload.checkpoint`). Then `TurnCountRange` maps 1:1 to
      the diff route's `from`/`to` with no client-side join table. Substrate over shims:
      the node's AUTOINCREMENT seq IS the turn count. turn→checkpoint join from projection
      state (diff frames carry `checkpoint`); replayEvents pages `/feed` → projected events.
      _Verify:_ unit on fixture; getTurnDiff maps to `from/to` seqs correctly.
- [x] **2.6 Live check:** rig script subscribes via the full client (`session.client[subscribeThread]`)
      against :3199, drives a turn.
      _Verify:_ stream items arrive live; reload-equivalent (new subscribe with
      afterSequence+epoch) skips replayed items.
- [x] **2.7 Commit** per sub-step (2.2, 2.3, 2.4, 2.5 separately).

## Stage 3 — app wiring + Gate G1

- [x] **3.1 Layer swap:** provide `atlas/session.layer` in apps/web's environment wiring
      (flag-gated: env var or settings toggle so the old path stays one flip away).
      _Verify:_ typecheck + app boots against a dead node → honest `setup-required`.
- [ ] **3.2 G1 demo (the gate):** dev node + `pnpm dev:web`; in ChatView: prompt → ack →
      streamed assistant/tool timeline → diff panel → interrupt mid-turn → page reload →
      timeline replays without duplication. Wrong token → `unauthorized`; no token →
      `setup-required`.
      _Verify:_ screen recording or step-by-step log; each of the 6 behaviors ticked.
- [ ] **3.3 Commit + tag** `m1-atlas-only-conversation`.

## Stage 4 — Phase 3: containment (parallelizable with 1–3)

- [ ] **4.1 `cordon` crate** (port sandbox.rs; `mechanism()`; writable-roots param; bwrap
      default-on-when-present; escape + writable-root tests migrated).
- [ ] **4.2 atlas-tools wiring:** fail-closed in `open_runner_at` (no hatch), `.shell(argv)`
      with `hearth-jobs` writable root; canonicalize ATLAS*DATA_DIR.
      \_Verify:* job-lane test — background job completes sandboxed (mutation: drop the
      writable root → wedges red).
- [ ] **4.3 Manifest field** + warden swap to cordon (delete its sandbox.rs).
      _Verify:_ manifest test; warden builds.
- [ ] **4.4 Gate G2:** live proofs — macOS: agent's own run_bash cannot write outside the
      workspace (escape file absent); metatron pre-bwrap: typed refusal; install bwrap;
      post-install: contained + Linux escape test green. Cross-build + deploy.

## Stage 5 — Phase 4: files + terminal (gated on Stage 4)

- [ ] **5.1 `files.rs`** (entries/file GET+PUT/search, two-realpath check, EXCLUDED reuse).
      _Verify:_ symlink-escape, traversal, roundtrip, truncation, archived-refusal tests +
      mutation on the prefix check.
- [ ] **5.2 hearth `Terminal`** (broadcast + history file ring + exit watcher) +
      `Runner::resize`.
      _Verify:_ attach-twice byte-identical replay; resize; `\x03` interrupt; exit both
      subscribers; cap-trim gap honest.
- [ ] **5.3 atlas-host `terminal.rs`** (registry `(thread,terminal)`, unary routes,
      `ATLAS_TERMINAL` gate, WS attach with offset/epoch resume).
      _Verify:_ doc-12 bar end-to-end via websocat against live node.
- [ ] **5.4 Un-gate client tags** (`projects.*` read/write, `terminal.*`) in the gate
      table; wire to routes.
      _Verify:_ gate test updated; file panel + terminal work in the app live.
- [ ] **5.5 Bar A declared:** conversation + files + terminal live on Atlas only; update
      docs 12/14/15 statuses; push all branches.

## Gaps found by the G1 live run (2026-08-03)

Seven browser-boundary blockers, none visible to unit or node-side integration tests —
every one a T3-server assumption in the boot path, or an Atlas surface a browser needs:

1. ticket exchange (`/api/auth/websocket-ticket`) — the credential IS the authorization
2. no browser credential — desktop bridge absent on web → `atlasDevToken()`
3. `/api/auth/session` 404 — Atlas's posture is known, not fetched
4. `/api/environment` 404 — the node describes itself
5. **CORS** — no headers at all, preflight 405; then a fixed header allow-list refused
   Effect's `traceparent` while letting curl through
6. `/_members` on a solo node (12b item 2, both halves) — mount + derive self_url
7. `providers: []` — the picker reads the node manifest

**Open gap recorded, not shimmed:** `RunCommand::Start` carries no `model` field, so a
per-thread model choice has no wire home. `thread.meta.update` is accepted lens-locally
(title + model preference are presentation state Atlas does not own yet); the node runs its
manifest default. Closing this means adding an optional `model` to Start — additive, small,
and it belongs with the thread-catalog work (M2), not M1.

**2026-08-03 browser bug hunt:** six confirmed bugs (draft send dead in the browser;
failed threads wedge forever with the lens showing stale success; CORS layer misses
unmatched routes; leaked T3-native RPCs; silent input drops) — evidence and repro in
doc 17. The e2e conversation suite stays red on the draft-send regression by design.

**Open gap (found by the e2e suite, 2026-08-03):** a WRONG token is invisible in the UI.
The transport is honest — 401/403 maps to `ConnectionBlockedError(permission)` — but the
index route renders a refused catalog as the "No projects yet" hero, indistinguishable
from a fresh node. `e2e/tests/boundary.spec.ts` carries the desired assertion under
`test.fail()`: fixing the lens flips it red and forces the assertion to become real.

## Standing rules

Every step: commit before mutation-testing; live-drive before "done"; fix stale docs
touched in passing; never push default branches.
