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
- [ ] **2.2 `projection.ts`:** pure function `(state, ThreadFeedEvent) → (state,
OrchestrationEvent[])` + snapshot builder. Port arm-by-arm; item ids per donor scheme
      (`{runId}:{seq}`, `{runId}:tool:{call_id}`).
      _Verify:_ unit tests replay the REAL 14-frame fixture → assert the exact
      OrchestrationEvent list (turn started/items/completed); unknown-frame no-op;
      reset → fresh-snapshot marker. Mutation-test the turn-close and tool-pairing arms.
- [ ] **2.3 Un-gate `subscribeThread`:** ThreadFeed → projection → `OrchestrationThreadStreamItem`
      (snapshot → events → synchronized on replay-complete). Epoch rides the snapshot for
      reload-resume.
      _Verify:_ unit — fake socket: subscribe → snapshot+events match fixture; reconnect
      mid-stream → no duplicate sequence.
- [ ] **2.4 Un-gate `subscribeShell`:** poll `/_runs` + `/_workspaces` (15s + wakeup),
      diff successive polls into upsert/remove events.
      _Verify:_ unit with stubbed HTTP: first poll → snapshot; changed poll → upserts.
- [ ] **2.5 Un-gate `getTurnDiff` + `replayEvents`:** turn→checkpoint join from projection
      state (diff frames carry `checkpoint`); replayEvents pages `/feed` → projected events.
      _Verify:_ unit on fixture; getTurnDiff maps to `from/to` seqs correctly.
- [ ] **2.6 Live check:** rig script subscribes via the full client (`session.client[subscribeThread]`)
      against :3199, drives a turn.
      _Verify:_ stream items arrive live; reload-equivalent (new subscribe with
      afterSequence+epoch) skips replayed items.
- [ ] **2.7 Commit** per sub-step (2.2, 2.3, 2.4, 2.5 separately).

## Stage 3 — app wiring + Gate G1

- [ ] **3.1 Layer swap:** provide `atlas/session.layer` in apps/web's environment wiring
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

## Standing rules

Every step: commit before mutation-testing; live-drive before "done"; fix stale docs
touched in passing; never push default branches.
