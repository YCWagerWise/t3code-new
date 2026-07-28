# 10 — What T3 tracks that Atlas cannot yet feed

An inventory, not a plan. Every row is a T3 surface that already works for some provider and
is dark for Atlas — so the work is "make Atlas say it", never "build it in T3".

Found by opening the Diff panel's scope dropdown — `Working tree · Branch changes · Latest
turn · Turn ▸`. Scoping a diff to a _turn_ means T3 keeps per-turn git checkpoints, which
Atlas has no surface for at all.

---

## 1. What T3 persists per thread

```
projection_threads            branch, worktree_path, model_selection, runtime_mode
projection_turns              turn_id, state, requested/started/completed_at,
                              checkpoint_ref, checkpoint_status, checkpoint_files_json,
                              checkpoint_turn_count, source_proposed_plan_id
projection_thread_messages    assistant/user messages
projection_thread_activities  the activity rail
projection_thread_proposed_plans   plan-mode output awaiting acceptance
projection_pending_approvals  approvals awaiting an answer
checkpoint_diff_blobs         (thread, from_turn, to_turn) → diff text
projection_thread_sessions    status, activeTurnId, lastError
```

**Correction to `08`:** it says no projected turn entity exists and that turn state lives only
in `session.activeTurnId`. That is wrong — `projection_turns` is a real per-turn row with
`completed_at` and checkpoint columns. The reaper fix stands (it settles the session), but
"mark the projected turn complete" was a real requirement, not an inapplicable one.

---

## 2. Which provider feeds which surface

Measured, not assumed — from which adapters emit each event.

| capability            | event                             | Codex | Claude |         Others         |     **Atlas**      |
| --------------------- | --------------------------------- | :---: | :----: | :--------------------: | :----------------: |
| Per-turn diff         | `turn.diff.updated`               |  ✅   |   —    |           —            |         ❌         |
| Plan / todo list      | `turn.plan.updated`               |  ✅   |   ✅   |           —            |         ❌         |
| Plan-mode proposal    | `turn.proposed.delta`             |  ✅   |   —    |           —            |         ❌         |
| Subagents             | `task.started/progress/completed` |   —   |   ✅   |           —            |         ❌         |
| Approvals             | `request.opened/resolved`         |  ✅   |   ✅   |        OpenCode        |         ❌         |
| User questions        | `user-input.requested`            |  ✅   |   ✅   | Cursor, Grok, OpenCode |         ❌         |
| Files written         | `files.persisted`                 |   —   |   ✅   |           —            |         ❌         |
| Model reroute         | `model.rerouted`                  |  ✅   |   —    |           —            |         ❌         |
| Hooks                 | `hook.started/progress/completed` |   —   |   ✅   |           —            |         ❌         |
| Successful tool calls | `item.*` + `tool.summary`         |  ✅   |   ✅   |           ✅           | ❌ (failures only) |

Atlas is the only provider emitting **none** of these. It supplies turn boundaries, assistant
text, reasoning, context pressure, errors and liveness — the conversation, not the work.

---

## 3. The integrity consequence

Measured this session, two models given the same task:

```
qwen2.5-coder:14b   → "DONE"   file NOT created
gpt-oss:120b-cloud  → "DONE"   file created

feed for both:  user → turn:start → assistant "DONE" → turn:done
tool frames:    0            0
```

**One did the work, one lied, and the feed is identical.** Nothing in Atlas or T3 can tell them
apart; the only reason it was caught is that the filesystem was checked by hand.

So successful tool calls are not a timeline nicety. They are the difference between a record of
what an agent did and an unverifiable claim. This is the highest-value gap in the table, and it
also unblocks the progress deadline in `07`, which currently has no signal to time out.

---

## 4. Build order, by what each unlocks

1. **`tool_call` / `tool_result` on success** (GAP-002) — proof of work, progress signal,
   visible timeline. Blocks the most and costs the least: the frames already exist and the
   observer already fires, just only on `ok=false`.
2. **Approvals + questions** (GAP-006) — `approval`/`question` frames are already carried and
   dropped by the adapter; the missing half is enforcement, which is also what makes cancel work.
3. **Per-turn checkpoints** (GAP-009) — the Diff dropdown's "Latest turn" / "Turn ▸". Needs a
   git surface Atlas does not have; `warden/src/checkpoint.rs` is the closest existing code.
4. **Files persisted** — cheap once (1) lands; a write tool result already knows the path.
5. **Subagent tasks** — Atlas has `delegate`/`delegate_async` and publishes an `edge` frame that
   nothing maps. Closest to free of the remaining items.
6. **Plans, hooks, model reroute** — no Atlas concept yet; defer until something needs them.

---

## 5. Two things worth stating plainly

**Nothing here is a T3 change.** Every surface already renders for another provider. The work is
entirely "Atlas publishes what it knows", which is `09`'s rule.

**`body_manifests()` under-reports.** `registry()` merges an always-on cluster fabric into every
plugin, so `summarizer` advertises zero tools while its agent still receives `delegate` and
`host_probe`. Any consumer trusting the manifest to decide what a body can do is wrong today.
