# 08 — Execution plan

One plan, superseding the loose prompt sequence. Docs 06/07 remain the design; this is
the order of work and the bar each step has to clear.

Written 2026-07-28, after a session that drove real turns end to end. Every "verified"
claim below was observed against the running node or a real test run, not inferred.

---

## 1. Ground truth — what already works

This matters because three of the queued prompts re-specify things that exist.

| capability                      | where                         | evidence                                       |
| ------------------------------- | ----------------------------- | ---------------------------------------------- |
| Epoch+sequence durable replay   | `feed.rs:369,374,403,422`     | 4 cursor cases driven live (below)             |
| Auth fails closed on the feed   | `auth.rs`, `ws.rs:126`        | tokenless connect → `permission_error` + close |
| Transport heartbeat, observable | `ws.rs`                       | live at +23ms, +20.0s, +40.0s                  |
| Atlas → canonical event mapping | `AtlasAdapter.ts`             | 34 tests; drives real turns                    |
| Turn lifecycle in T3            | `ProviderRuntimeIngestion.ts` | 7 tests, 4 mutations                           |
| Model routing                   | `lib.rs` `named_backend_kind` | `gpt-oss:120b-cloud` answers in 6s             |

Replay, driven against the live node:

```
after=0            → 1:cmd 2:user 3:turn 4:assistant 5:turn   full history
after=3            → 4:assistant 5:turn                       exactly the gap
after=5            → (none)                                   idempotent reattach
after=3, bad epoch → full replay                              fails safe
```

End-to-end, live: `cmd → user → turn:start → assistant → turn:done` in 6s on
`gpt-oss:120b-cloud`, and the same rendered in a browser.

**Consequence:** Prompt 6 (durable events/cursors) and most of Prompt 5 (auth) describe
`feed.rs` and `auth.rs`. Prompt 7 describes `AtlasAdapter.ts`. Extend those; a second
event log or a second auth boundary is strictly worse than one of each.

---

## 2. Not load-bearing yet

`run_supervisor.rs` (2,183 lines) and `control_plane.rs` (681 lines) are mounted —
router merged, DO registered — but **no real run reports into them**:

```
REAL:       spawn_console_turn → feed::publish(Kind::Turn) → publish_outcome
SUPERVISOR: apply_observation()  ← 0 callers outside its own module
```

Their tests pass because they drive the supervisor directly. That establishes internal
consistency, not supervision. `RunState` is a third lifecycle vocabulary alongside
`Kind::Turn{state}` and `runs.status`, with nothing translating between them.

The state design is right — `Limited` with the five limit reasons, distinct from
`failed`/`stalled`/`cancelled`, is a genuine gap in Atlas. It just isn't connected.

---

## 3. Known defects, with evidence

| #   | defect                                              | evidence                                                                                                 |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Readiness lies: `/_members` ungated, `/_feed` gated | desktop app showed `ready · 19 tools`; every turn died at handshake                                      |
| D2  | Cancel is a no-op                                   | `ws.rs:214` — "interrupt/approve/answer are carried but not enforced"; 8 interrupt events, none answered |
| D3  | Errors arrive as answers                            | `Driven::Done` publishes CLI error text as assistant + `turn:done`                                       |
| D4  | Lens decides Atlas terminal state                   | `socketLossEvents` emits `turn.aborted` on socket close                                                  |
| D5  | No boot reconciliation                              | restart mid-turn strands `running` forever; nothing reconciles                                           |
| D6  | Successful tool calls never published               | observer fires only on `ok=false` (GAP-002)                                                              |
| D7  | Stale-thread retry loop                             | untyped `OrchestrationGetSnapshotError` retried every 250ms forever                                      |

D1–D5 were each hit in real use, not found by reading.

---

## 4. Order of work

Sequencing rule: **nothing is built on a signal that does not yet exist.**

### Phase 1 — Make readiness honest (D1)

Fixes a bug already hit. No new subsystem.

- `wsToken` absent → `setup-required`, not `ready`. Schema defaults currently produce a
  reachable-but-unauthenticated instance that reports healthy.
- Readiness must exercise the **authenticated** path. A successful `/_members` cannot
  override a failed feed handshake.
- Rejection after socket open fails readiness. `onopen` is not authentication.
- Probing creates no durable run.

_Exit:_ a node with no token reads `setup-required`; a node with a bad token reads
`unauthorized`; neither reads `ready`. Regression tests for both.

_Note:_ in-flight in `AtlasClient.ts` (~83 uncommitted lines, currently failing
typecheck on a raw `setTimeout` — needs `Effect.sleep`/`Schedule`).

### Phase 2 — Connect the supervisor (unblocks everything in 06/07)

`publish_outcome` (`lib.rs:1895`) already receives the authoritative outcome —
`Driven::Done` / `Failed` / `Cancelled` / `Err`. Report it to the supervisor.

_Exit:_ one real driven turn produces a supervisor state transition. Until this passes,
the deadline, child-supervision, and epoch work in 06/07 is verified only against
observations that tests generate.

### Phase 3 — Terminal outcomes Atlas can actually declare (D3)

Only meaningful once Phase 2 lands.

- Distinguish "the CLI exited 0 with error text" from "the model answered". Today both
  are `Driven::Done`, so `API Error: 400 …` renders as a successful reply.
- Emit `Limited` with the five reasons from 07 as durable terminal outcomes.

_Exit:_ a tool-unsupported model and a capacity limit both settle as terminal failures
carrying their exact reason, not as assistant text.

### Phase 4 — Cancellation (D2)

`interrupt` is recorded and ignored. Make it enforced, and emit a terminal event.

_Exit:_ Stop on a running Atlas turn settles it, with a durable reason. This also
retires the only reason D4's workaround exists.

### Phase 5 — Lens stops deciding terminal state (D4)

Replace `turn.aborted`-on-socket-loss with a lens-local "disconnected / reconnecting"
state that never touches turn lifecycle. The Atlas run is durable and keeps going; a
browser losing its socket is not evidence the run died.

_Exit:_ dropping the socket mid-turn shows disconnected in the UI and leaves Atlas
lifecycle untouched; reconnect resumes from cursor.

### Phase 6 — Watchdog (D5)

Two thresholds, per 07. Transport heartbeat exists; progress does not.

- Transport: no heartbeat for 60s (3 missed intervals) → terminal.
- **Arm only after the first heartbeat is seen.** A node that never sends one means
  "cannot be supervised", never "dead" — six of seven fleet nodes are on a build with
  no `hb`.
- Progress deadline is **blocked on D6**: with no successful-tool events, there is no
  progress signal to time out. Do not implement it against events that do not exist.
- Boot reconciliation for sessions orphaned by restart.

_Exit:_ a killed node settles its threads within 60s; an old node's threads are never
reaped; a healthy long turn is never reaped.

### Phase 7 — Stale-thread loop (D7)

Independent of Atlas; can run in parallel.

Typed `thread_not_found` / `snapshot_failed` / `replay_failed` + bounded retry. The
250ms retry is **correct** for a thread still materializing — the bug is one untyped
error covering four causes. Client cleanup only; never delete server data.

_Exit:_ a stale route makes a bounded number of requests and redirects.

### Phase 8 — Integrated authority proof

Prompt 9's eleven steps. Passable only after 2, 4 and 6.

---

## 5. Standing rules

1. **Extend, don't duplicate.** `feed.rs` owns durable events; `auth.rs` owns identity;
   `AtlasAdapter.ts` owns event mapping. One of each.
2. **Atlas is authoritative for run state; T3 projects it.** The lens may hold its own
   _connection_ state, never the run's terminal state.
3. **Additive on the wire.** The fleet is mixed-version — one peer's `null` manifest
   once broke the whole `/_members` decode and made Atlas unselectable. A new frame must
   be ignorable by old lenses, and its absence must not be read as failure.
4. **Verified means observed.** Passing tests around an unwired module prove nothing.
   Every phase exits on a real driven turn.
5. **Mutation-test new suites.** Revert the fix; the test must fail.

---

## 6. Open decisions

Recorded, not resolved:

- Which of `feed.rs`, `runs.status`, `RunState` is canonical once the supervisor is
  connected, and who maps between them.
- Retention/truncation policy for the feed (currently unbounded).
- Whether `waiting_for_input` becomes a first-class session status or stays a
  suspension of the progress deadline only.
- Scope vocabulary (read/execute/supervise/admin) and rotation — real gaps in `auth.rs`,
  but they belong there, not in a second boundary.
- Token accounting across providers, for `max_tokens`.
- Whether desktop secrets move to OS credential storage.
