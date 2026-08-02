# Codex audit prompt — doc 12 verification

Read-only audit. Codex verifies each planned item against the code and returns what to change,
why it works, and why it is not a shim. It writes no code.

**Run one scope per invocation.** The plan is too large for a single pass and quality collapses.
Suggested split, in order:

| Run | `<scope>`                                                                       |
| --- | ------------------------------------------------------------------------------- |
| 1   | §5 corrections — the seven claims said to be false                              |
| 2   | §6 shim register — two retired, two outstanding, one rejected                   |
| 3   | §7 containment                                                                  |
| 4   | §4 + Phase 1 — identity, `run_id`/`thread_id`, `backend_id`                     |
| 5   | Phase 3 — command/snapshot/replay/errors                                        |
| 6   | Phase 4 — approvals and questions                                               |
| 7   | Phase 5 — catalogs                                                              |
| 8   | §8 cheap wins — delegation observations, HTTP feed replay, adapter fall-through |
| 9   | §12 verification matrix — which rows have a real test today                     |

Invoke with `task` (not `review` — this is not a diff review). For follow-ups on the same run use
`task --resume-last` and send only the delta.

---

```xml
<task>
Audit one scope of the Atlas backend capability plan against the actual code, and report what
needs to change. Do not write or edit any code, and do not run anything that mutates state.

Plan: git-forks/t3code/docs/atlas-console/12-ATLAS-BACKEND-CAPABILITY-PLAN.md
Primary code: ~/atlas/atlas-rs (crates: atlas-host, atlas-tools, atlas-agents, atlas-workspace)
Substrates, in dependency order: turso -> do-rs -> agent-sdk-rs -> atlas-rs -> atlas-deployments
Siblings worth reading: ~/atlas/hearth (PTY engine), ~/atlas/warden (a working lens)
Consumer: git-forks/t3code/apps/server/src/provider/Layers/AtlasAdapter.ts

SCOPE FOR THIS RUN: <<<fill in one row from the table above>>>

For every item in that scope, decide whether it is already done, partly done, missing, or whether
the plan itself is wrong — then say precisely what should be written to close it.
</task>

<grounding_rules>
Ground every claim in a file:line you actually opened, or a command you actually ran. Quote the
line when the claim turns on its exact wording.

The plan is not authoritative. It was written partly from other documents, and several of those
were stale. Module doc comments in this repository are known to assert gaps that are already
closed. Verify against code, not prose. If the plan is wrong, the finding is "PLAN-WRONG" and that
is a valuable result, not a failure.

Never report a capability as missing without searching for it first. State the search you ran.
Distinguish observed fact from inference. Label hypotheses as hypotheses.
</grounding_rules>

<anti_shim_contract>
This repository's rule (PRINCIPLES.md) is: fix it at the lowest level where the fix is genuinely
correct. A shim is an app-level workaround over a gap that has a real home lower down. A shim is
debt, never a resting state.

For each proposed change you MUST answer, explicitly:
  1. What is the lowest layer where this is actually wrong?
  2. What search did you run to confirm no existing primitive already covers it?
  3. If you are proposing new app-level code, why does no lower home exist?

Two failure modes to avoid, both observed in this codebase:

  a) Proposing a hand-rolled mechanism when the substrate already has the primitive, unsearched.
     Real example: an ack-then-repush retry counter was written in atlas-host on top of a durable
     queue that already accepted `max_attempts`. Correct fix was exposing the existing engine
     parameter in do-coord, which deleted the app-level code.

  b) Proposing a NEW mechanism when an EXISTING one is merely unfinished.
     Real example: a synthetic terminal observation was nearly added to settle a stuck cancel,
     when the real defect was that one state had no deadline in a watchdog built to prevent
     exactly that. Before proposing a mechanism, check whether a built-but-unwired one exists.

Duplication is not automatically a shim, and neither is app-level code. Say which it is and why.
</anti_shim_contract>

<completeness_contract>
Cover every item in the scope. Do not stop at the first interesting finding.

An item is only "DONE" if you can cite the code that does it AND the test or live evidence that
proves it. Tests that exercise an unwired module prove nothing; if a module has no real callers,
say so.

If an item cannot be settled by reading, mark it UNVERIFIABLE and name the single command or
observation that would settle it. Do not guess.
</completeness_contract>

<structured_output_contract>
Return a numbered list, highest-risk first. One entry per plan item. Each entry exactly:

  ITEM      plan section + short name
  VERDICT   DONE | PARTIAL | MISSING | PLAN-WRONG | UNVERIFIABLE
  EVIDENCE  file:line citations; quote the line when wording matters
  CHANGE    what to write, precisely enough to act on: which file, which function, the new
            signature or call site, what is deleted. Describe the code; do not paste it.
  WHY       why this fix is correct, and what breaks if it is not made
  NOT-A-SHIM  the layer it belongs in, the search that proved no primitive exists, and — if it is
            app-level — why no lower home exists
  RISK      blast radius, and anything it silently depends on
  PROOF     the test that would fail if this change were reverted

Then one final section, at most 10 lines:
  - items where the plan is wrong and should be edited
  - anything you found that the plan does not mention at all
  - what you could not verify and why

No preamble, no recap of the plan, no restating the task.
</structured_output_contract>

<action_safety>
Read-only. Do not edit, create, or delete files. Do not run builds, tests, migrations, or any
command that writes. Do not start or restart services. Do not touch any remote host.

Reading, grepping, and inspecting git history are all fine.
</action_safety>

<default_follow_through_policy>
Default to the most reasonable reading and keep going. Do not stop to ask routine questions.
Stop only if a missing fact would make the audit actively misleading, and say exactly what is
missing.
</default_follow_through_policy>

<tool_persistence_rules>
Keep reading until the verdict is defensible. Do not settle for a partial read when one more
targeted grep would change the answer — particularly when deciding whether something has real
callers, or whether a substrate primitive already exists.
</tool_persistence_rules>
```

---

## Repository facts worth pasting in, if the run needs them

Give Codex only what its scope needs. These are verified as of 2026-08-02.

- The supervisor durable-object id is `run_id`, not `thread_id`, despite `run_supervisor.rs:3`.
  `lib.rs:2385` passes the same string to both fields.
- `named_backend_kind` (`lib.rs:509`) routes by string prefix: `claude*` → Claude CLI,
  `gpt-*` / `o<digit>` → Codex CLI, else Ollama. There is no backend entity.
- `hearth` is containment-agnostic by design and takes a `shell_argv` wrapper (`session.rs:48`).
  `warden/src/sandbox.rs` supplies one. `atlas-tools/src/bash.rs` does not call it.
- `feed.rs`, `ws.rs` and `run_supervisor.rs` module docs each assert at least one thing that is no
  longer true. Treat all module docs as suspect.
- One test fails for unrelated reasons and is not a regression:
  `prompt_tests::claude_prompt_has_no_toolsearch_or_defer_text`.

## What a good finding looks like

> **ITEM** §6 — `stop_run`'s abort half
> **VERDICT** PARTIAL
> **EVIDENCE** `lib.rs:2939` `abort_console_turn` reads `inflight()`; the only insert is
> `lib.rs:2986` inside `spawn_console_turn`. An HTTP `/say` turn is never registered.
> **CHANGE** register every driven turn in `inflight()` at the drive site, not only the console
> path; key by `run_id`; prune on completion as `spawn_console_turn` already does.
> **WHY** the durable cancel flag only stops a loop at its next Action boundary; a single-round
> turn never reaches one, so today the abort silently no-ops on the most common path.
> **NOT-A-SHIM** belongs in `atlas-host` — the registry is Atlas's notion of "a turn this process
> is driving", which no substrate can own. Searched `agent-sdk-do` and `do-rs` for a task registry:
> none exists.
> **RISK** aborting a turn kills its reporter; the caller must publish the outcome, as
> `ws::cancel_run` already does.
> **PROOF** drive a turn over HTTP, cancel it, assert the child process is gone before the
> cancel deadline fires.
