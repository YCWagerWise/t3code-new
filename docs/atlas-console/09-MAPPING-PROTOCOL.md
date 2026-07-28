# 09 — Mapping protocol

How to connect anything new between Atlas and T3 — a tool, a connector, a capability, a
terminal reason — without inventing a bespoke path each time.

Written 2026-07-28 out of a session where every failure had the same shape: **something
knew, and didn't say.** Shutdown knew a turn was dying. The socket knew it was refused.
The supervisor knew it couldn't record. Atlas knows when a tool succeeds. Each dropped
the fact, and the symptom surfaced far away as a spinner.

---

## 1. Who owns what

Four layers. Confusing them is the root of most of the defects in `08`.

| layer                                            | owns                         | changes cost                                        |
| ------------------------------------------------ | ---------------------------- | --------------------------------------------------- |
| **Atlas feed** (`feed.rs` `Kind`)                | what happened in the run     | **versioned wire, mixed-version fleet** — expensive |
| **Atlas run state** (supervisor)                 | lifecycle, attempts, budgets | durable — name things once                          |
| **T3 canonical events** (`ProviderRuntimeEvent`) | provider-neutral vocabulary  | in-process types — free                             |
| **T3 projection + UI**                           | what the user sees           | free, but must not decide                           |

**Atlas is authoritative for the run. T3 projects it.** T3 may hold its own _connection_
state; it may never hold the run's terminal state.

---

## 2. The six questions

For anything new, in order. Each has a wrong answer that has already bitten us.

### Q1 — Does Atlas already know this fact?

If yes, **publish it**; never re-derive it in T3.

Re-deriving is how `isClaudeInterruptedMessage` happens — a lens substring-matching an
error to guess a semantic the provider knew exactly. Atlas declares its error `class`
precisely so the lens does not guess.

### Q2 — Is it about the RUN or about the CONNECTION?

- **Run** → a `Kind`, appended to the feed, replayable, carries `seq`/`epoch`/`role`.
- **Connection** → a transport frame, never persisted (`hb`, the auth-refusal `error`).

Persisting liveness would let a replay assert the run was alive when nobody was watching,
and would grow an idle thread's log without bound.

### Q3 — Can it end a turn?

Only three things may: `turn{done}`, `turn{error}`, and a real cancellation. Anything
else — heartbeats especially — must carry **no** `turnId`, so it cannot advance or close
a turn it merely observed.

### Q4 — Is it additive and ignorable?

The fleet is mixed-version; most nodes run older builds. So:

- An old node that never sends it must look **healthy-but-quiet**, never dead.
- An old lens that receives it must drop it silently.
- **Absence is not failure.** A watchdog arms only after it has SEEN the signal once.

One peer's `null` manifest once failed the whole `/_members` decode and made Atlas
unselectable. Optional means `NullOr`, not `optional`.

### Q5 — Which canonical event does it become?

Reuse an existing `ProviderRuntimeEvent` type if one fits — that is what makes Atlas a
peer of Claude and Codex rather than a special case. Add a type only when the semantic
genuinely does not exist (`session.heartbeat` did not).

### Q6 — Does anything downstream have to DECIDE?

If the UI or ingestion must infer, the mapping is incomplete — go back to Q1.

The diagnostics drawer computing `stalled` from React timestamps is the anti-pattern:
the client guessing a fact the substrate owns.

---

## 3. The mapping as it stands

```
Atlas Kind          T3 canonical event                              status
─────────────────────────────────────────────────────────────────────────────
turn{start}     →   turn.started                                    ✅
turn{done}      →   turn.completed                                  ✅
turn{error}     →   turn.completed{state:failed, errorMessage}      ✅
assistant       →   item.started + content.delta + item.completed   ✅
thinking        →   content.delta{reasoning_text}                   ✅
tool_call       →   item.started                                    ⚠️ never published (GAP-002)
tool_result     →   item.completed + tool.summary                   ⚠️ failures only
ctx             →   thread.token-usage.updated                      ✅
error           →   runtime.error{class}                            ✅
hb              →   session.heartbeat  (transport, no turnId)       ✅
approval        →   —                                               ⛔ dropped (GAP-006)
question        →   —                                               ⛔ dropped (GAP-006)
usage           →   —                                               ⬜ unmapped
edge            →   —                                               ⬜ unmapped (fleet delegation)
deny            →   —                                               ⬜ unmapped
user / cmd      →   —                                               n/a (echo of console input)

console → agent: cmd · interrupt · approve · answer   (`from_console()` gate)
```

`from_console()` is a **capability boundary**, not a list: a lens holding a valid token
still cannot forge a `tool_result` or raise its own `approval`.

---

## 4. Worked examples

**A new tool.** Nothing to add. Tools flow through `tool_call` / `tool_result` keyed by
`call_id`, which is why a result closes its own call. The gap is not per-tool — it is
that the observer only fires on failure. Fix once, every tool appears.

**A new connector / provider.** Q1: does it produce facts Atlas can publish? If it runs
under Atlas, it inherits the whole vocabulary and T3 needs **zero** changes. Only a
connector that produces a genuinely new _kind_ of fact touches the wire.

**A new terminal reason** (`max_tokens`, `session_budget_exceeded`, …). Q3 says it can
end a turn, so it must arrive as `turn{error}` with the reason, or a new terminal `Kind`.
It maps to `turn.completed{failed, errorMessage}` — the state already exists.

**A new liveness or progress signal.** Q2: connection → transport frame; run → `Kind`.
Progress is about the run, so it is durable; liveness is not. This is why the heartbeat
can back a transport deadline and must never back a progress deadline.

---

## 5. Invariants

1. **No layer swallows a fact it holds.**
2. **Bookkeeping never gates execution.** Recording a run must not be able to prevent
   one — `supervisor_start` blocked every turn by violating this.
3. **Atlas owns run state; T3 projects it.** The lens may hold connection state only.
4. **Wire changes are additive and ignorable; absence is not failure.**
5. **Verified means observed.** Tests around an unwired module prove nothing — drive a
   real turn.
6. **Extract the decision, then test it.** A choice buried in a callback cannot be
   tested; `outboundDisposition` correctly returned `"queue"` while the queue did not
   exist.

---

## 6. The short version

> For anything we ask of Atlas: does Atlas already know it? Then Atlas says it, once, on
> the feed — and T3 renders what it is told. If T3 has to work it out, the mapping is
> wrong.
