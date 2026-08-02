# Atlas-owned backend capability implementation plan

**Status:** implementation plan, with a verified record of what is already done
**Revised:** 2026-08-02, against the code and against a live node — not against the other docs
**Scope:** capabilities required to turn the T3 Code React client into an Atlas-only lens
**Governing rule:** the lens expresses intent and renders facts; Atlas owns execution, machine
access, authorization, lifecycle truth, and durable state.

This revision corrects the previous plan on four counts: Phase 1 is complete; the plan had **no
containment layer** and needs one; the identity split it assumes is not yet true in code; and
`backend_id` does not exist at all. It also records the shims found and the load-bearing comments
that assert things which are no longer true.

Every "done" below names its evidence. Anything unverified is marked as such.

This plan starts from the current T3 contract: 66 names in `WS_METHODS` plus seven names in
`ORCHESTRATION_WS_METHODS`, for 73 declared names. Only 70 are registered in `WsRpcGroup`;
`projects.list`, `projects.add`, and `projects.remove` are declarations without RPC definitions.
Atlas does **not** need to reproduce those names one-for-one. It must own the capabilities that
make the retained T3 interface truthful.

---

## 0. Current state — verified

Driven on a running node against real models. Not inferred from source.

| Capability                                         | Evidence                                                                                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed is a projection of supervisor state           | `project_to_feed` publishes after each commit; direct writes gated on `!supervised`. Live turn produced exactly one `turn start` and one `turn done`                 |
| Six previously unrenderable states                 | `queued`, `running`, `waiting_for_input`, `cancelling`, `limited`, `stalled` on `Kind::Lifecycle`                                                                    |
| Content precedes the boundary that closes its turn | Regression caught live — the answer was landing _after_ `turn:done`; fixed and pinned                                                                                |
| Outbox drained through one actuator                | `drain_outbox` at command-commit and in the alarm; `outbox_disposition` fences a stop to its lease generation                                                        |
| `Cancelling` is terminable                         | 30s `cancel_timeout`; live `cancelling → cancelled` at exactly 30s via the real alarm, thread then accepted a new turn                                               |
| Concurrent-turn refusal                            | `StartRefusal::Busy` → 409; the live attempt's snapshot is no longer overwritten with `None`                                                                         |
| Async delivery is honest                           | `/_inbox` reported success unconditionally, so the Outbox acked and **dropped** the answer to any async delegation whose push-back failed                            |
| Workspace catalog                                  | Stable ids from canonical root, allow-list re-checked on every resolve, repo-toplevel normalisation. Live: a subdirectory registered as its repo; `/etc` refused 403 |
| Run index projects supervisor truth                | `status` and `workspace_id` populate; both were permanently `active` / `null`                                                                                        |
| Cross-node delegation                              | Sync and async against live aarch64 metatron; the async result returned via its Outbox and woke a new turn unprompted                                                |
| Real coding turn                                   | `tool_call run_bash → tool_result → diff → assistant`, file on disk with correct contents                                                                            |

**Phase 1 (1A and 1B) of the previous plan is complete.** Its §17 is superseded by §17 here.

---

## 1. Target architecture

```text
Atlas Console (T3-derived React lens)
        |
        | authenticated commands, queries, subscriptions
        v
Atlas public protocol
        |
        v
atlas-host
  |- RunSupervisorDO: lifecycle authority
  |- Feed: durable client projection and replay
  |- catalogs: fleet, node, body, model, workspace, thread
  |- machine services: files, Git, PTY, preview, assets
  |- containment: OS write-boundary around every agent shell
  `- AgentDO / agent-sdk: model loop, tools, policy, execution
        |
        |- Claude backend
        |- Codex backend
        |- Ollama backend
        `- future model backends
```

Claude, Codex, Ollama, and future integrations are Atlas model backends. They are not selectable
T3 providers. Atlas is the only backend/body visible to the product.

## 2. Ownership boundaries

| Capability                       | Canonical home                                     | Notes                                                                                                   |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Run state, attempts, recovery    | `atlas-rs/crates/atlas-host`                       | One authoritative supervisor per thread                                                                 |
| Durable event/replay transport   | `atlas-host/src/feed.rs`, `ws.rs`                  | Projection of supervisor and runtime facts                                                              |
| Generic model/tool loop          | `agent-sdk-rs`                                     | No Atlas product semantics in the SDK                                                                   |
| Model backend integration        | `agent-sdk-provider`                               | Claude, Codex, Ollama, future backends                                                                  |
| Body prompts and tool policy     | `atlas-rs/crates/atlas-agents`                     | Per-body authority and behavior                                                                         |
| Shared Atlas tools               | `atlas-rs/crates/atlas-tools`                      | Generic node/fleet actions                                                                              |
| Deployment-specific tools        | `atlas-deployments`                                | Never put leaf-domain tools in the substrate                                                            |
| Repository/checkpoint primitives | `atlas-rs/crates/atlas-workspace`                  | Reusable Git/workspace mechanics                                                                        |
| PTY primitives                   | `hearth`                                           | Containment-agnostic by design; Atlas owns session identity, authorization, **and the sandbox wrapper** |
| **Shell containment**            | **one crate shared by `warden` and `atlas-tools`** | **Seatbelt / bubblewrap write-boundary; see §7**                                                        |
| Durable runtime primitives       | `do-rs` / Turso                                    | Only generic durability belongs here                                                                    |
| TypeScript client contract       | `t3code/packages/contracts`                        | Generated from or verified against Atlas-owned schemas                                                  |
| Client connection/projection     | `t3code/packages/client-runtime`                   | No execution or lifecycle decisions                                                                     |
| Visual experience                | `t3code/apps/web`                                  | Rendering, drafts, navigation, local preferences                                                        |
| Transitional compatibility       | `t3code/apps/server`                               | Do not add new Atlas-owned capability here                                                              |

## 3. Delivery rules

1. **One authority.** `RunSupervisorDO` declares lifecycle state. The feed and catalogs project it.
2. **Commands are intent.** A client never submits an executable, shell string, absolute host path,
   provider process environment, or raw network target as authority.
3. **Every command is acknowledged.** Acceptance, rejection, idempotent replay, and structured
   failure are keyed by `request_id`.
4. **Every fact is attributable.** Runtime events carry stable fleet, node, body, workspace,
   thread, turn, attempt, and request identities where applicable.
5. **Disconnect is not termination.** A lens losing transport changes connection state only.
6. **Fail closed.** Unknown tools, unresolved workspaces, missing scopes, stale attempts, path
   escapes, **and an unavailable containment boundary** are denied.
7. **Additive wire evolution.** Mixed-version nodes and old lenses ignore unknown fields. Absence
   of a new field is not silently interpreted as failure.
8. **No empty-success shims.** Unsupported operations return a typed capability error.
9. **Verified means end to end.** A feature is complete only when an Atlas publisher and a real
   consumer are both exercised, on a node, against a real model. Passing tests around an unwired
   module prove nothing — that rule caught two defects in this pass that every unit test missed.
10. **Comments are contracts.** A module doc that claims a gap the module has since closed is a
    defect. See §5.

## 4. Canonical public identities

| Identity       | Meaning                                             | Status in code                        |
| -------------- | --------------------------------------------------- | ------------------------------------- |
| `fleet_id`     | Administrative/routing domain                       | exists                                |
| `node_id`      | Stable Atlas host identity                          | exists                                |
| `body_id`      | Installed agent persona/capability package          | exists as plugin name                 |
| `backend_id`   | Inference transport (Claude CLI, Codex CLI, Ollama) | **does not exist** — see below        |
| `model_id`     | Real model routable through a backend               | free-form string                      |
| `workspace_id` | Atlas-authorized operational/repository root        | exists                                |
| `thread_id`    | Durable conversation and supervisory boundary       | **conflated with run — see below**    |
| `turn_id`      | One user-input-to-quiescence cycle                  | **does not exist**                    |
| `attempt_id`   | One fenced execution attempt for a turn             | exists, but counts turns not attempts |
| `request_id`   | Client command idempotency key                      | exists                                |
| `event_id`     | Durable fact identity                               | exists                                |
| `asset_id`     | Authorized large/binary payload identity            | does not exist                        |

Raw filesystem paths may appear in body-owned results, but the public lens addresses a workspace by
`workspace_id`. Atlas resolves and authorizes the path.

**`run_id` is deliberately absent from this table** — a run should _be_ a turn. Today it is not:

```rust
// lib.rs:2385
thread_id: run_id.into(),
run_id:    run_id.into(),
```

Thread and run are the same string, the supervisor DO is keyed by `run_id`, and `attempt_number`
increments **per turn** — so the fifth message on a thread is "attempt 5". That makes
`retry_of_run_id` and `resume_of_attempt_id` unable to mean what they say, and `is_terminal()` true
of something that is not over. Only `/say` has the conflation; `/run`, `/start` and `on_task` are
already one-turn-one-run.

> **Do not simply change `run_id`.** It is the durable-object id. Changing it spins a fresh
> supervisor isolate per turn — the churn that once produced 835k orphaned `.tmp` dirs
> (`lib.rs:3107`). Dispatch on `thread_id`; carry a per-turn `run_id` _inside_ the envelope. Both
> fields already exist on `CommandEnvelope`.

**`backend_id` is construction, not exposure.** Routing today is string-prefix matching in
`named_backend_kind`: `claude*` → Claude CLI, `gpt-*` / `o<digit>` → Codex CLI, else Ollama. There
is no backend entity, no health, no enumeration.

---

## 5. Corrections — claims that are no longer true

Load-bearing prose a reader or an agent will act on. Fix each in the same pass as the next change
to that file.

| Location               | Claim                                                                                                                | Reality                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `feed.rs` module doc   | _"What this module is NOT: a publisher. Nothing in atlas-host writes agent frames yet … That is GAP-002."_           | It publishes user, assistant, tool_call, tool_result, diff, usage, ctx, lifecycle, edge                   |
| `ws.rs:14-17`          | _"Atlas does not publish agent frames yet (GAP-002)… Approvals and answers are carried but not enforced (GAP-006)."_ | Both false — frames publish, `await_approval` enforces                                                    |
| `run_supervisor.rs:3`  | _"The durable object id is the Atlas `thread_id`."_                                                                  | It is `run_id` — the thread only on `/say`; a one-shot id on `/run`/`/start`; `self-{nonce}` in `on_task` |
| doc `08` §2            | _"`run_supervisor.rs` … no real run reports into them … 0 callers"_                                                  | Wired into every turn via `supervisor_start`/`supervisor_stop`                                            |
| doc `08` §6 decision 1 | "which of feed / `runs.status` / `RunState` is canonical" — open                                                     | **Resolved:** `RunState` is canonical; feed and `runs.status` project it                                  |
| doc `10` §5            | _"`body_manifests()` under-reports"_                                                                                 | Fixed — it reads through `registry()`, which merges the fabric and applies the allowlist                  |
| doc `05-GAPS.md`       | whole document                                                                                                       | Predates `control_plane.rs`, `run_supervisor.rs`, approvals. History only                                 |

`publish_outcome_frames` previously declared itself _"deliberately independent of the supervisor"_,
directly contradicting `run_supervisor.rs`'s claim to be _"the sole lifecycle authority"_. That is
now narrowed to **one author per run** — the supervisor when there is one, the direct path when
there is not — which keeps the guarantee the original comment protected without a second author.

---

## 6. Shim register

`PRINCIPLES.md`: fix at the lowest level where the fix is genuinely correct; a shim is a TODO with
a cost, never a resting state.

### Retired

| Shim                                                                                                                        | Substrate it papered over                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox deferral — `DEFER_SECS` / `DEFER_MAX`, a `deferrals` counter in the job payload, ack-then-repush with a crash window | The queue's own retry budget. The engine always accepted `max_attempts`; only `queue_push_idem` exposed it. Added `queue_push_bounded` to `do-coord` |
| Private `git_line` / `normalise` in `workspaces.rs` duplicating `rev-parse --show-toplevel`                                 | `atlas_workspace::Repo::detect`. Added `Repo::remote()` / `Repo::branch()` there instead                                                             |

### Outstanding

| Shim                                                                                        | Correct home                                                                                                             | Cost of leaving it                                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `publish_outcome_frames(supervised: bool)` — a conditional author                           | Remove the unsupervised path. The supervisor is a **local durable object**; "unreachable" should not be a normal outcome | "One authority" is really "one authority per run", and the weaker rule gets built on                      |
| `stop_run`'s abort half reaches only `inflight()`, populated solely by `spawn_console_turn` | Every driven turn should be abortable                                                                                    | An HTTP `/say` turn is flagged but never killed; the cancel deadline makes that survivable, not immediate |

### Rejected, recorded so it is not re-proposed

Committing a synthetic `ProviderStopped` from the drain to settle a cancel — a second way to settle
a run beside a watchdog built to do exactly that. The real defect was that `Cancelling` had no
deadline.

**Atlas speaking Effect RPC** — implementing the `WsRpcGroup` wire protocol and `HttpApi`
conventions in Rust so `apps/web` and `packages/client-runtime` need no change. The appeal is real:
it is the only option where no lens call site moves at once. It is rejected because the thing it
asks Atlas to implement is not a specification.

- **There is no stable target.** `pnpm-workspace.yaml:47` pins `effect: 4.0.0-beta.78`, and
  `packages/contracts/src/rpc.ts:2-3` imports from `effect/unstable/rpc/*`. A pre-1.0 beta, in a
  namespace its own authors mark unstable, would become the definition of Atlas's public wire.
- **It is not even stock Effect.** `patches/effect@4.0.0-beta.78.patch` patches
  `dist/unstable/rpc/RpcClient.js`, including `makeProtocolSocket` and `makePinger` — the exact
  functions that own WS framing, ping cadence, pong handling and ping-timeout behavior. Atlas
  would be chasing a local patch file on top of an unstable module. Two moving targets.
- **The envelope is cheap; the payloads are the trap.** The frame tags are few and stable-looking
  (`Request`/`Ack`/`Interrupt`/`Chunk`/`Exit`/`Defect`/`Eof`/`ClientEnd`/`Ping`/`Pong` in
  `RpcMessage.d.ts`). But every payload, success and error is Effect **Schema**-encoded, and `Exit`
  carries `ExitEncoded` with Cause serialization through `Schema.Defect()`. The real cost is
  reimplementing Effect Schema's JSON encoding in Rust across 70 methods and staying
  bug-compatible with it through beta bumps. `apps/server/src/ws.ts:289+` adds a per-method
  auth-scope map via `RpcMiddleware` to mirror as well.
- **Fidelity to the donor means implementing its defects.** Per the preamble: 73 declared names, 70
  registered. Doc `11` documents `status` dropped on `item.completed` and `turn{state:"error"}.text`
  `MISROUTED`. Under this option those stop being T3 bugs and become Atlas wire contract.
- **It buys less than it claims.** What gets deleted is `apps/server`, but the semantic translation
  lives in `AtlasAdapter.ts`, not in the framing — Atlas already publishes native frames the adapter
  consumes (doc `11`). The option does not remove that translation; it moves it into Rust and puts a
  foreign encoder underneath it.
- **It inverts §2.** This document already places `packages/contracts` at _generated from or verified
  against Atlas-owned schemas_. Option A makes Atlas the schema-follower to a beta TypeScript
  library, at the one layer where a shim is hardest to retire.

**What is kept from it.** The migration cost it was trying to avoid is avoided instead by freezing
the Effect RPC surface rather than reproducing it: methods slated for deletion anyway
(`server.refreshProviders`, `server.updateProvider`, `cloud.*`) stay on the transitional transport
until they are removed, and every Atlas-owned capability lands on the Atlas-owned channel from the
first one. **The rule is that the Effect RPC surface only ever shrinks** — a new method added to
`WsRpcGroup` for an Atlas capability is this option arriving one name at a time.

---

## 7. Containment — the layer the previous plan omitted

**The most important correction in this document.**

The previous plan's path controls (§10 "canonicalize before authorization and reject symlink /
traversal escape"; §16 "Path safety") govern **what a lens may name**. Nothing governed **where the
body may go**.

Demonstrated live. An agent scoped to a scratch workspace ran:

```
cd /Users/sopuluaninweze/atlas/atlas-rs && printf 'reviewed\n' >> README.md && printf 'draft' > notes.txt
```

`exit=0`. It wrote into a different repository. Every path control in the plan would have passed,
because none were consulted — the shell simply walked out. `cwd` sets where hearth's persistent PTY
_starts_; a shell in which `cd` survives is hearth's headline feature.

**The primitive exists and is proven.** `hearth` is deliberately containment-agnostic and accepts a
`shell_argv` wrapper (`session.rs:48`; `RESEARCH.md:170` — _"hearth is not a sandbox and doesn't
pretend to be (that's the host's containment layer)"_). `warden/src/sandbox.rs` supplies one:
Seatbelt on macOS, bubblewrap on Linux, **inherited by child processes**, canonicalised before the
rule is emitted, with a test asserting an escape file is not created.
`atlas-tools/src/bash.rs` never calls it.

**Three requirements Atlas adds beyond warden's version:**

1. **Fail closed.** warden returns plain `["bash"]` when no sandbox is available, and its Linux path
   is opt-in. `bwrap` is **not installed on metatron**. Wiring it in as-is contains the Mac and
   silently contains nothing on the fleet — the inversion of rule 6.
2. **Advertise it.** Whether a boundary is active belongs in the node manifest, so `/_members`
   answers "which nodes are contained".
3. **Scope it honestly.** It is a _write_ boundary. Reads and network stay open by design. Nobody
   should read "sandboxed" as "cannot exfiltrate".

**Placement:** one crate both hosts depend on. Copying `sandbox.rs` into `atlas-tools` would be the
same duplication retired in §6.

**This gates M3.** Workspace-scoped file, Git and terminal services are decorative while the shell
beneath them is unbounded.

---

## 8. Phase order

### Phase 0 — freeze the _current_ boundary

The previous Phase 0 assumed the pre-projection shape. Capture fixtures against what exists **now**,
or the two-author behaviour just removed gets enshrined. Fix the §5 comments while here.

- Record current `/_feed`, supervisor, run index, and AgentDO schemas.
- Add protocol fixtures shared between Rust and TypeScript.
- Capture live examples for completion, failure, cancellation, approval, tool success/failure,
  diff publication, reconnection, and stale epoch replay.
- Mark `AtlasDriver`, `AtlasAdapter`, `AtlasClient`, `AtlasVcsDriver` as transitional.

_Exit:_ a checked-in fixture describes every consumed frame; Rust and TypeScript reject incompatible
required fields; no client behavior parses human error text.

### Phase 1 — identity

Blocked on nothing; three later phases assume it. See §4 for the warning.

- Dispatch the supervisor DO on `thread_id`; carry a per-turn `run_id` in the envelope.
- `attempt_number` resets per run, increments only on retry/resume.
- Introduce `turn_id` as a first-class identity.

_Exit:_ a warm thread's tenth message is turn 10 attempt 1, not attempt 10; a genuine retry is
distinguishable from the next message.

### Phase 2 — containment

§7. Fail closed, advertised in the manifest, one shared crate. Install `bwrap` on the Linux nodes so
that path stops being theoretical.

_Exit:_ an agent's shell cannot write outside its workspace; a node without a boundary refuses
`run_bash` rather than running unbounded.

### Phase 3 — command, snapshot, replay, errors

Unchanged from the previous plan and still correct.

```json
{
  "version": 1,
  "request_id": "req-123",
  "kind": "turn.start",
  "target": {
    "node_id": "seraphim",
    "body_id": "coder",
    "workspace_id": "atlas-rs",
    "thread_id": "thr-123"
  },
  "payload": { "text": "Implement the change" }
}
```

Commands: `fleet.subscribe`, `catalog.subscribe`, `workspace.subscribe`, `thread.subscribe`,
`thread.create`, `thread.archive`, `turn.start`, `turn.interrupt`, `turn.retry`, `turn.resume`,
`approval.respond`, `question.respond`, `history.request`, `cursor.ack`, `ping`.

Transport: acknowledge or structured-error every command; `epoch + seq` as replay/dedup cursor;
scoped authoritative snapshot before replay; explicit replay boundary; expired or wrong-epoch cursor
replaced with a snapshot; bounded replay with defined slow-consumer closure; heartbeat and presence
independent of run terminal state.

Error classes: authn/authz; unsupported capability; invalid command or target; workspace not
found/allowed; thread/turn/attempt conflict; stale lease or generation; backend/model unavailable;
policy denied or approval expired; execution failed/limited/stalled/cancelled; transport/replay
unavailable.

_Exit:_ a second device reconstructs the thread from snapshot plus replay; a duplicate `request_id`
returns the original receipt without executing twice; cursor loss yields a snapshot, never silent
omission.

### Phase 4 — approvals and structured questions

**Approvals** — bind policy evaluation to the tool execution boundary; persist a stable request
against thread/turn/attempt/tool-call; publish requested/resolved/expired/cancelled; resolve
idempotently; define multiple-lens races and audit the winner; suspend and resume the same attempt.

**Questions** — `Kind::Question` is declared with **no producers**; approvals are enforced,
questions are vocabulary only. Add a generic suspension primitive to `agent-sdk-rs` if reusable;
persist id, prompt, choices/schema, deadline, resolution; resume model context with the answer;
cancel pending questions when the owning attempt terminates.

_Exit:_ both flows survive browser disconnect and Atlas restart; a second response is an idempotent
ack or typed conflict; Claude and Codex paths pass the same suite.

### Phase 5 — catalogs

**Fleet/node** (`gossip.rs` plus a public catalog module). `/_members` is **two bugs**: the gossip
router only mounts inside `if ATLAS_PEERS`, **and** `self_url` is only ever set by finding your own
`ATLAS_NODE_ID` in your own peer list. Fixing either alone leaves a solo node unable to report
itself — derive `self_url` from `ATLAS_SELF_URL`. Publish join/update/degrade/leave. Node roles are
display metadata, never authorization.

**Body/backend/model.** Advertise effective body tools after fabric merging (done). Backends and
models are new construction (§4): enumerate installed backends and health; real routable models,
context window, tool support, loaded/cold state, defaults; typed unavailability reasons.

**Workspace.** Largely done. Remaining: default body, worktree/branch state, thread associations,
retention.

**Thread/run.** Largely done — `status` and `workspace_id` now project supervisor truth. Remaining:
title, body, model/backend, active attempt, attention state, archive state, last-message preview.

_Exit:_ the sidebar populates without local provider discovery or remembered raw paths; a body
manifest equals the effective registry the model receives; an unavailable model cannot be selected
as if healthy.

### Phase 6 — coding workspace services · **gated on Phase 2**

**Filesystem projection** (`atlas-host/src/files.rs`) — list, read with MIME/binary/size handling,
search; writes only with explicit capability and audit; canonicalize before authorization; reject
traversal and symlink escape; never an unrestricted host browser.

**Repository/Git/worktrees/review** (`vcs.rs`, `atlas-workspace`) — preserve
detect/capture/has/restore/diff/delete; add status and status subscription, refs, branch
create/switch, worktree create/remove, pull/remotes, init; associate checkpoint identity explicitly
with turn and attempt; expose latest-turn, selected-turn, full-thread, branch and working-tree diff
scopes; clone/publish/PR only after credential policy is explicit.

**Human terminal** (`hearth` primitives; `atlas-host/src/terminal.rs` authority) — list, open,
attach, replay, write, resize, interrupt, restart, close; bound to authorized workspace and subject;
persisted metadata and bounded replay; a dedicated high-volume stream, not ordinary timeline frames.

_Exit:_ T3 file, Git, diff and terminal panels operate against an Atlas node with no machine access
in the lens or T3 server; every path and PTY operation is authorized by workspace identity.

### Phase 7 — assets, preview, automation, diagnostics

**Assets** (`assets.rs`; a `do-rs` blob primitive only if generic durability is missing) — stable id,
owner/scope, MIME, size, hash, retention, authorized retrieval, range/streaming. Timeline events
carry references, never unbounded payloads.

**Preview** (`preview.rs`, `preview_automation.rs`) — discover dev servers, own session and port
authorization, proxy approved endpoints, publish lifecycle, route automation, store screenshots as
assets. The lens owns viewport, focus and rendering.

**Diagnostics** — node/gossip/storage/queue/backend health; run-owned process and resource
information; causal traces; model availability and usage; watchdog and reconciliation outcomes;
version/update state where remote administration is authorized. Process signaling is limited to
descendants of an authorized Atlas run.

### Cheap wins — unblocked, do whenever

- **Delegation observations.** `ChildStarted` / `ChildStopped` / `ChildProgress` have **zero callers**
  outside their own module, so a real delegation never tells the parent's supervisor a child exists.
  The vocabulary is fully built; Atlas already publishes `edge` frames. Misfiled under M4.
- **HTTP feed replay.** `/console/v1/threads/{id}/events` returns lifecycle only. Reading what a run
  _said or did_ requires a WebSocket client, which blocks using Atlas as a scriptable tool.
  `Feed::since` already exists.
- **`AtlasAdapter.ts` fall-through.** Its `turn` case ends unguarded, rendering **any** unrecognised
  state as a _completed_ turn — a live bug for every provider. This is why the six new states had to
  be a new _kind_ (`default: return []` ignores those) rather than new `Turn.state` values.

---

## 9. T3 contract migration

### TypeScript contract

An Atlas namespace under `packages/contracts`, with Atlas as the semantic schema owner:

```text
packages/contracts/src/atlas/
  commands.ts  events.ts  snapshots.ts  catalogs.ts  workspace.ts
  terminal.ts  vcs.ts     assets.ts     errors.ts    protocol.ts
```

**Settled: generated from Rust, not hand-written and fixture-checked.** This was the open question
left by rejecting Option A — if Atlas owns the schema, what makes the TypeScript follow it? Golden
fixtures are the weaker answer: they prove the shapes agreed _on the examples someone thought to
write_, and a field added on one side with no fixture covering it passes. Generation makes the
question unaskable.

It is chosen partly because **both halves already exist and have never been connected**:

| Half         | Where                                                 | State                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust emitter | `atlas-rs/crates/atlas-protocol/src/schema.rs`        | Emits draft-2020-12 JSON Schema for eight roots — `FeedFrame`, `TransportFrame`, `RunSnapshot`, `CommandEnvelope`, `ObservationEnvelope`, `EventEnvelope`, `HandshakeFrame`, `StructuredError` — via `schemars`. Artifact checked in at `crates/atlas-protocol/schema/atlas-protocol.json` (71KB), regenerated by `cargo run -p atlas-protocol --bin emit-schema` |
| Drift guard  | same file, `the_checked_in_contract_matches_the_code` | A contract change fails at `cargo test` in the crate that owns the contract, with a diff. `every_root_carries_a_real_schema` and `the_artifact_keeps_the_two_frame_families_apart` pin the rest                                                                                                                                                                   |
| TS generator | `packages/effect-acp/scripts/generate.ts`             | Working precedent: `@effect/openapi-generator/JsonSchemaGenerator` turns an upstream JSON Schema into Effect `Schema` at `src/_generated/schema.gen.ts`, checked in                                                                                                                                                                                               |

`schema.rs`'s own module doc already names the failure this closes: _"A lens written in another
language cannot `use atlas_protocol`. Until now its only options were to hand-copy the shapes —
which the T3 lens did, and drifted."_

So `packages/contracts/src/atlas/` is generated output, not authored source, and the wire change a
lens sees is the diff on `atlas-protocol.json`.

**The one adaptation needed, and it belongs on the Atlas side.** The ACP generator consumes a
document shaped `{ $defs }`; `atlas-protocol.json` is shaped `{ protocolVersion, roots: { Name:
<schema-with-$defs> } }`. The fix is **not** to teach the generator to iterate `roots` and merge
`$defs`. It is to have `emit-schema` produce a _second, flattened_ artifact — one top-level `$defs`
map with every root and every nested definition — shaped exactly as a JSON-Schema generator expects.
The `roots`-keyed file stays as the human-reviewable contract (its diff is still the wire change);
the flat file is the machine feed. The producer normalises once, and the consumer — ACP's generator
today, any future lens generator in another language tomorrow — needs no per-repo teaching. Fixing
it in the generator would solve it for exactly one consumer and re-pose the same question to the
next one.

This keeps the drift guard honest: the new emitter path is covered by the same
`the_checked_in_contract_matches_the_code` mechanism, so the flat artifact cannot silently diverge
from the roots artifact either.

`StructuredError` emitting no `$defs` is not an edge case to tolerate — it is the correct output for
a type with no nested definitions, and after flattening it simply contributes its own entry to the
single `$defs` map. Whatever consumes the artifact handles it the same way as any other root.

**Scope boundary.** These roots cover the Atlas envelope and frame families. They are deliberately
not a translation of the 70 `WsRpcGroup` methods; per §10 most of those are rebound, split, or
removed rather than reproduced. A capability is on the wire when it is reachable from one of the
roots — a type reachable from none of them is, by construction, not on the wire.

### Client runtime

In `packages/client-runtime`: authenticated connection bootstrap; snapshot/replay/live state
machine; cursor persistence and dedup; scoped subscriptions; command acknowledgements;
reconnect/backoff; Atlas projection store. **The runtime must never infer run termination from
connection loss.**

### React lens

Rebind in `apps/web`: provider picker → node/body/model selector; projects → Atlas workspaces;
threads → Atlas durable threads; provider timeline → Atlas events; approvals/questions → Atlas
pending requests; diff/terminal/files/preview → Atlas services; provider settings → catalogs.
Keep keybindings, display preferences, drafts, accessibility and panel layout lens-local.

### Transitional server removal

Keep `AtlasDriver`, `AtlasAdapter`, `AtlasClient`, `AtlasVcsDriver` only while migration needs the
bridge. **Do not add missing Atlas capability to `apps/server`.** Remove or bypass: direct
Codex/Claude/Cursor/Grok/OpenCode execution; the provider registry and update flows; T3 orchestration
authority for Atlas threads; T3-owned machine access for Atlas workspaces; T3 checkpoint authority
for Atlas turns; T3 Connect relay UI unless intentionally adopted.

## 10. Disposition of the 73 T3 method names

**Rebind as Atlas core** — `projects.list/add/remove`, `projects.listEntries/readFile/searchEntries`,
`assets.createUrl`, `vcs.refreshStatus/listRefs/createWorktree/removeWorktree/createRef/switchRef`,
`review.getDiffPreview`, `subscribeVcsStatus`,
`terminal.open/attach/write/resize/restart/close`, `subscribeTerminalEvents`,
`subscribeTerminalMetadata`, `server.probe`, `subscribeServerConfig`, `subscribeServerLifecycle`,
`subscribeAuthAccess`, `sourceControl.cloneRepository`, and all seven `orchestration.*` re-expressed
as Atlas commands, snapshots, replay, diffs and scoped subscriptions.

**Rebind after the core milestone** — `projects.writeFile`, `shell.openInEditor`,
`filesystem.browse`, `vcs.pull`, `vcs.init`, `git.runStackedAction`, `git.resolvePullRequest`,
`git.preparePullRequestThread`, all `preview.*` / `previewAutomation.*` and discovery subscriptions,
`server.updateServer`, `server.discoverSourceControl`, server trace/process/resource diagnostics,
`sourceControl.lookupRepository`, `sourceControl.publishRepository`.

**Split between lens and Atlas** — `terminal.clear` (display clear may be local; history deletion is
Atlas), `preview.navigate/resize/refresh`, `previewAutomation.focusHost`,
`server.getSettings/updateSettings`, `server.getConfig` (replace with catalogs plus lens config).

**Lens-local** — `server.upsertKeybinding`, `server.removeKeybinding`.

**Remove from the Atlas-only product** — `server.refreshProviders`, `server.updateProvider`,
`cloud.getRelayClientStatus`, `cloud.installRelayClient`.

## 11. Milestones

**M1 — trustworthy conversation.** Single lifecycle authority ✅; command receipts; snapshot/replay/
live transport; messages, tools, approvals, questions, usage, diffs, terminal outcomes;
interruption ✅ and restart recovery. The first point at which Atlas can honestly be the only
backend for the conversation UI.

**M2 — navigable Atlas product.** Fleet/node/body/backend/model catalogs; workspace ✅ and thread
catalogs; Atlas-native routes and sidebar; provider UI removed.

**M3 — complete coding workspace.** **Gated on containment (Phase 2).** File projection;
Git/worktrees/checkpoints/review; human terminal; clone and optional publishing.

**M4 — rich execution surface.** Assets; preview and automation; delegation visualization (cheaper
than it looks — see §8); Atlas diagnostics.

## 12. Verification matrix

Every phase requires focused unit tests at its owning layer plus one integrated proof.

| Capability                  | Required proof                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Command idempotency         | Repeat one `request_id`; observe one actuation                                                      |
| Lifecycle authority         | All terminal frames originate from committed supervisor events                                      |
| Cancellation                | Stop a live CLI child; observe one cancelled terminal outcome                                       |
| Restart recovery            | Restart mid-turn; reconcile or resume without duplicate effects                                     |
| Replay                      | Reconnect at exact, stale, wrong-epoch and truncated cursors                                        |
| Approval/question           | Disconnect while pending; reconnect, resolve once, resume                                           |
| Authorization               | Cross-owner thread/workspace reads and writes fail closed                                           |
| Path safety                 | Traversal and symlink escape fail after canonicalization                                            |
| **Containment**             | **An agent's own shell cannot write outside its workspace — assert the escape file does not exist** |
| **Fail-closed containment** | **A node with no sandbox available refuses `run_bash` rather than running unbounded**               |
| **Containment advertised**  | **`/_members` reports whether each node has an active boundary**                                    |
| **Solo node self-report**   | **A node with no `ATLAS_PEERS` still answers `/_members` with itself**                              |
| **No empty-success**        | **Every unsupported operation returns a typed capability error, asserted per surface**              |
| **Comment truth**           | **No module doc asserts a gap the module has since closed**                                         |
| Catalog honesty             | Advertised body tools equal the effective registry                                                  |
| Terminal                    | Attach twice, replay, resize, interrupt, observe exit                                               |
| Git/checkpoint              | Turn diff and restore occur on the node owning the workspace                                        |
| Mixed versions              | Unknown fields ignored; missing additive fields do not imply failure                                |

For user-visible web changes, run the repository-required integrated `test-t3-app` verification
(`.agents/skills/test-t3-app/SKILL.md`) after the Atlas capability and client binding are both
integrated.

## 13. Immediate next work

**Phase 1 (identity) first.** It is blocked on nothing and three phases assume it. Heed the
durable-object-id warning in §4.

**Then Phase 2 (containment).** It gates M3 and is the only item on this list with a demonstrated
exploit.

Then Phase 3. Do not begin terminal, filesystem, preview or broad UI migration until lifecycle
authority, identity, acknowledgements, replay semantics **and containment** are stable — those
services all depend on the same trust and ownership foundation.

The cheap wins in §8 are unblocked and can be picked up at any time by anyone.

## 14. Operational notes

- **seraphim is unreachable** as of 2026-08-02 — metatron's ring shows 7 nodes and seraphim does not
  answer `:3010`. Fleet-wide verification will be partial until it returns.
- **No node advertises a manifest.** Every live member reports `manifest: null`; deployed binaries
  predate `node_manifest`. This is the mixed-version case rule 7 warns about, live right now.
- **The live binary on metatron is `/opt/atlas/bin/atlas-host`** (dated Jul 7), not `~/atlas-host`,
  which is a Jun 30 leftover. The unit is a user systemd service with
  `EnvironmentFile=/opt/atlas/secrets/atlas-host.env`.
- **Deploys must be cross-built.** metatron is aarch64;
  `cargo zigbuild --release --target aarch64-unknown-linux-gnu.2.36 -p atlas-host` works from the
  Mac in ~3 minutes.
- **Query the ring, not a remembered map.** `FLEET.md` is explicit, and it earned that this session:
  a stored fleet fact from 2026-07-07 listed six nodes including a live seraphim; the ring showed
  seven with seraphim down.
