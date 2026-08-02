# Build prompt — doc 12, small items

Implementation prompt for a fresh session. Works for Codex, a subagent, or Atlas driving itself.

**One item per run.** Every item below is scoped to be completable and provable in a single pass.
Do not batch them; the verification is what makes them real, and batching dissolves it.

## Item ladder

Ordered by risk, not by phase. Items 1–4 are safe to delegate to an agent. Item 5 changes the hot
path. Item 0 must land before Atlas is pointed at its own repo.

| #   | Item                                                          | Size | Delegate to an agent?       |
| --- | ------------------------------------------------------------- | ---- | --------------------------- |
| 0   | **Containment** — wire the hearth `shell_argv` seam           | M    | No — do this first, by hand |
| 1   | **Comment corrections** — four module docs assert closed gaps | S    | Yes, ideal first dogfood    |
| 2   | **`/_members` on a solo node** — two independent bugs         | S    | Yes                         |
| 3   | **Delegation observations** — built vocabulary, zero callers  | S    | Yes                         |
| 4   | **HTTP feed replay** — `Feed::since` already exists           | S    | Yes                         |
| 5   | **Identity split** — turn ≠ attempt, DO keyed on thread       | L    | No                          |

Item 0 is the unblocker: until a write-boundary exists, an agent pointed at `atlas-rs` can write
anywhere its user can reach. That is not hypothetical — it happened on 2026-08-02.

---

```xml
<task>
Implement exactly one item from docs/atlas-console/12b-BUILD-PROMPT.md against the Atlas backend.

Plan and rationale: git-forks/t3code/docs/atlas-console/12-ATLAS-BACKEND-CAPABILITY-PLAN.md
Code: ~/atlas/atlas-rs on branch feat/supervisor-lifecycle-authority
Substrates, in dependency order: turso -> do-rs -> agent-sdk-rs -> atlas-rs -> atlas-deployments
Siblings: ~/atlas/hearth (PTY engine), ~/atlas/warden (a working lens that already solves item 0)

ITEM FOR THIS RUN: <<<one row from the ladder>>>

Done means: the change is written, it compiles, it has a test that fails when the change is
reverted, and — where the item is observable at runtime — it has been driven on a real node.
</task>

<substrate_contract>
This repository's rule (PRINCIPLES.md): fix it at the lowest level where the fix is genuinely
correct. An app-level workaround over a gap with a real home lower down is debt, not a resting
state.

Before writing any new mechanism, answer for yourself:
  1. What is the lowest layer where this is actually wrong?
  2. What search proves no existing primitive already covers it?
  3. Is there a built-but-unwired mechanism here that should be finished instead of replaced?

Question 3 is not rhetorical. This codebase has repeatedly turned out to contain the right
mechanism, unfinished:
  - a durable queue that already accepted `max_attempts`, under a hand-rolled retry counter
  - a watchdog with a deadline for every state but one, under a run that could hang forever
  - a containment seam in hearth, unused, while a sibling repo already fills it

If your fix adds a mechanism beside an existing one rather than completing it, stop and
reconsider. Say so explicitly in your summary either way.
</substrate_contract>

<verification_loop>
Write the test before claiming the item is done, then MUTATE IT: revert your change, confirm the
test fails, restore. Report the failure message you saw. A test that passes both ways proves
nothing.

Tests around an unwired module also prove nothing. If the code you changed has no real callers,
say so rather than reporting green.

Where the item is observable at runtime, drive it on a node:

  ATLAS_DATA_DIR=$(mktemp -d) ATLAS_WS_TOKEN=live ATLAS_BASH=1 \
  ATLAS_WORKSPACE_ROOTS=<a scratch dir> ATLAS_SELF_URL=http://127.0.0.1:3200 \
    ./target/debug/atlas-host serve --addr 127.0.0.1:3200

Reading the feed needs a WebSocket client until item 4 lands: connect to
ws://127.0.0.1:3200/_feed?run_id=<id>&after=0&access_token=live

Two defects on 2026-08-02 passed every unit test and were only found by running it: an answer
published after the turn that produced it was closed, and an agent writing outside its workspace.
</verification_loop>

<action_safety>
Stay on branch feat/supervisor-lifecycle-authority. Do not push. Do not commit unless asked.
Keep the change scoped to the one item — no unrelated refactors, renames, or cleanup.

Do not touch any remote host. metatron and the rest of the fleet are live production.
Do not restart any systemd unit.

If a change would alter behaviour on nodes you cannot test, say so before making it.
</action_safety>

<compact_output_contract>
Report, in this order and nothing else:
  1. what you changed — file:line, one line each
  2. why it is not a shim — the layer it belongs in, and what you searched to confirm
  3. the mutation test — what you reverted and the exact failure you saw
  4. live evidence, if the item is observable at runtime
  5. anything you found that the plan does not mention

No recap of the task or the plan.
</compact_output_contract>

<missing_context_gating>
Do not guess repository facts. Module doc comments in this codebase are known to assert gaps that
are already closed — verify against code, not prose. If required context is missing, retrieve it
or state exactly what remains unknown.
</missing_context_gating>
```

---

## Per-item briefs

Paste only the brief for the item being run.

### 0 — Containment

`hearth` is containment-agnostic by design and accepts a shell wrapper (`runner.rs:81`
`pub fn shell(argv: Vec<String>)`). `warden/src/sandbox.rs` supplies one — Seatbelt on macOS,
bubblewrap on Linux, inherited by child processes, canonicalised before the rule is emitted, with a
test asserting an escape file is not created.

`atlas-tools/src/bash.rs:92` builds `hearth::Config::new(...).guard(...).with_secrets(...)` and
never calls `.shell()`. That is the entire gap.

Three requirements beyond lifting warden's version:

- **Fail closed.** warden returns plain `["bash"]` when no sandbox exists, and its Linux path is
  opt-in. `bwrap` is not installed on metatron. Refusing `run_bash` is correct; silently running
  unbounded is not.
- **Advertise it** in `node_manifest` so `/_members` answers which nodes are contained.
- **Do not copy the file.** One crate, both consumers. Choosing its home is a design decision —
  raise it rather than deciding silently.

_Proof:_ an agent's own shell cannot write outside its workspace — assert the escape file does not
exist. Plus: a node with no boundary available refuses `run_bash`.

### 1 — Comment corrections

Four module docs assert gaps that are closed. Each is trusted by readers and by agents.

- `feed.rs` module doc — _"What this module is NOT: a publisher. Nothing in atlas-host writes agent
  frames yet."_ It publishes nine kinds.
- `ws.rs:14-17` — claims GAP-002 unpublished and GAP-006 unenforced. Both false.
- `run_supervisor.rs:3` — _"The durable object id is the Atlas `thread_id`."_ It is `run_id`
  (`lib.rs:2385` passes the same string to both fields).
- Any remaining "GAP-00N" reference that no longer describes reality.

_Proof:_ a test asserting no module doc in `atlas-host` contains a GAP marker that the module has
closed. Mechanical, low-risk — the best first item to hand an agent.

### 2 — `/_members` on a solo node

Two independent bugs; fixing either alone leaves a solo node unable to report itself.

- The gossip router only mounts inside `if let Ok(peers) = std::env::var("ATLAS_PEERS")`
  (`lib.rs:3375`), so a node without peers serves no `/_members` at all — returns 404.
- `self_url` is only ever set by finding your own `ATLAS_NODE_ID` inside your own `ATLAS_PEERS`
  list. `Gossip::record_aged` drops any member with an empty URL, so a node that omits itself is
  invisible even to itself. Derive it from `ATLAS_SELF_URL`, which deployments already set.

_Proof:_ a node with no `ATLAS_PEERS` answers `/_members` with itself, including tools and manifest.

### 3 — Delegation observations

`ChildStarted` / `ChildStopped` / `ChildProgress` / `ChildHeartbeat` / `ChildWaitingForInput` /
`ChildInputResolved` exist in `control_plane.rs` with **zero callers** outside their own module and
`run_supervisor.rs`. A real delegation never tells the parent's supervisor a child exists, so
`ChildRunSnapshot`, the required-child logic and the child-aware terminal guards are exercised only
by tests.

Atlas already publishes `edge` frames from the delegate path — that is where the observations belong.

_Proof:_ a real `delegate` produces a child in the parent's supervisor snapshot, and a required
child's failure is visible to the parent's terminal logic.

### 4 — HTTP feed replay

`/console/v1/threads/{id}/events` returns lifecycle only (`command.accepted`, `provider.connected`,
`provider.stopped`). Reading what a run _said or did_ requires a WebSocket, which blocks using Atlas
as a scriptable tool and blocks judging an agent's work with `curl`.

`Feed::since(cursor, role)` already exists. `/_runs` shows the auth pattern to copy.

_Proof:_ `curl` retrieves the assistant text, tool calls and diff for a completed run.

### 5 — Identity split

Not for an agent. `CommandEnvelope` already carries both `thread_id` and `run_id`; `lib.rs:2385`
passes the same string to both. Dispatch the supervisor DO on `thread_id`, carry a per-turn `run_id`
inside the envelope, reset `attempt_number` per run so it increments only on retry/resume.

> Do **not** simply change `run_id`. It is the durable-object id — changing it spins a fresh
> supervisor isolate per turn, the churn that once produced 835k orphaned `.tmp` dirs
> (`lib.rs:3107`).

_Proof:_ a warm thread's tenth message is turn 10 attempt 1, not attempt 10; a genuine retry is
distinguishable from the next message.

---

## Using Atlas to build Atlas

Viable **after item 0**, and well-suited: every turn is git-checkpointed, the diff is published as a
frame, and `/_vcs/restore` rolls a turn back.

```bash
curl -X POST http://<node>:3200/Agent/thr-build-1/say \
  -H 'Content-Type: application/json' \
  -d '{"run_id":"thr-build-1","plugin":"triage","model":"claude-opus-4-8",
       "cwd":"/path/to/atlas-rs",
       "task":"<the task block above, with one item selected>"}'
```

Before doing this, know:

- Only `triage` and `summarizer` are installed locally; there is no `coder` body. `triage` will work
  with a generalist prompt.
- Until item 4 lands, judging the result needs a WebSocket client — the `tool_call` / `tool_result`
  frames are what distinguish real work from a confident claim of it.
- Work on a scratch clone until containment is proven, not on the tree you care about.
