# Atlas Agent Run Authority

## Status

**Normative design decision.** This document resolves the lifecycle ownership
gap identified in [GAP-002](./05-GAPS.md) and refines the fleet control-plane
design in [the Turso multi-node connector plan](./06-TURSO-MULTINODE-CONNECTOR-PLAN.md).

Implementation belongs to Atlas/do-rs/Turso. T3 Code is an authenticated
projection and control lens over this contract; it is not a second run
supervisor, lifecycle authority, checkpoint store, or fallback event log.

## Decision

For each Atlas thread, one Atlas control-plane **Agent Run Supervisor** is the
sole authority for the active run's lifecycle. The supervisor is a durable
`do-rs` object keyed by `thread:<thread_id>` and stores its authoritative state
in its Turso isolate.

The supervisor owns one active `run_id` at a time. A thread may have historical
runs, but a new run cannot become active until the previous one is terminal.

```text
T3 lens ── command request ──> Atlas Run Supervisor ── execution command ──> Atlas node/body
   ^                                     |                                       |
   |                                     | durable state + event log              | observations
   └──────── replayed ordered events ────┴───────────────────────────────────────┘
```

`do-rs`/Turso is the supervisor's durable substrate, not an alternate client
API. An Atlas worker node holds a **fenced execution lease**, not authority to
change run lifecycle state directly.

## Non-negotiable invariants

1. Only the supervisor appends authoritative run lifecycle events or changes a
   run's state.
2. A worker may report observations and execute commands only for its current,
   unexpired lease generation.
3. T3, PostgREST-RS, and browser clients are read/propose surfaces. They do not
   write run-state tables or infer terminal state from local timers.
4. Every command and observation is idempotent.
5. A terminal transition is durable before any best-effort external side effect
   such as stopping a feed or process.
6. An open transport is not evidence of liveness. Only an accepted Atlas
   heartbeat refreshes a liveness deadline.
7. A parent run is not healthy merely because its transport is healthy: each
   required child run has independent liveness and progress deadlines.
8. Supervisor time is authoritative. Browser clocks and worker clocks are
   recorded as metadata only.
9. Provider-declared execution limits are durable terminal outcomes. T3 must not
   translate them into failure, cancellation, or a locally inferred completion.
10. Checkpoints and attempt history are append-only. Resuming never rewrites the
    attempt that produced a terminal outcome.

## Lifecycle model

```text
queued → starting → running → waiting_for_input ─┐
                    ↑                            │
                    └────────────────────────────┘

starting | running | waiting_for_input
  ├─ cancel requested → cancelling → cancelled
  ├─ execution limit reached → limited
  ├─ explicit provider failure → failed
  ├─ heartbeat/progress deadline → stalled
  └─ explicit completion → completed
```

Terminal run states are `completed`, `limited`, `failed`, `stalled`, and
`cancelled`. `limited` is an explicit non-error control-plane outcome: the provider
or harness stopped otherwise valid execution at a declared resource boundary. It
is distinct from `stalled` (a required signal missed a durable
deadline), `failed` (an explicit execution error), and `cancelled` (an authorized
actor requested termination).

`terminal_reason` is required for every terminal transition and uses this
closed, versioned vocabulary:

- completed: `turn_completed`, `provider_completed`;
- limited: `max_turn_requests`, `max_tokens`, `session_budget_exceeded`,
  `max_tool_calls`, `max_wall_time`;
- stalled: `startup_timeout`, `transport_heartbeat_timeout`,
  `progress_timeout`, `child_heartbeat_timeout`, `child_progress_timeout`,
  `delivery_timeout`;
- cancelled: `cancelled_by_user`, `cancelled_by_supervisor`,
  `parent_cancelled`;
- failed: `provider_error`, `harness_error`, `tool_error`,
  `checkpoint_invalid`, `protocol_violation`, `child_failed`.

Provider-specific detail belongs in `terminal_detail.code` and
`terminal_detail.message`, not as an unbounded top-level reason. In particular,
`max_wall_time` is a provider/harness-declared execution budget. A missed Atlas
supervision deadline remains `stalled(...)`.

For compatibility, these older reason spellings are normalized on ingestion:

- `startup_timeout`
- `transport_heartbeat_timeout`
- `progress_timeout`
- `child_heartbeat_timeout`
- `child_progress_timeout`

Known human waits use `waiting_for_input`; they pause progress timeouts and
record their own request expiry. They must not look like a silent run.

### Retry and resume

`run.retry` always creates a new `run_id` and `attempt_id`, linked by
`retry_of_run_id`; it replays the original user intent from a clean provider
execution context. `run.resume` also creates a new attempt, linked by
`resume_of_attempt_id`, but starts from a supervisor-approved durable checkpoint.
Neither command changes the terminal state, events, usage, or reason of the prior
attempt.

`limited` is resumable only when the declared limit is renewable and the selected
checkpoint is compatible with the new effective limits. `max_turn_requests`,
`max_tokens`, `max_tool_calls`, and `max_wall_time` may be resumed with a new,
explicitly authorized budget. `session_budget_exceeded` requires replenishment or
replacement of the enclosing session budget before resume. Otherwise the control
API returns `precondition_failed`. Failed or stalled attempts may resume only from
a valid checkpoint; cancellation is retryable but is not implicitly resumable.

The thread timeline is an ordered union of immutable attempts. UIs may group
attempts, but must show the boundary, terminal state/reason, budget usage, chosen
checkpoint, and causal link between them.

## Durable checkpoints and resumability

The supervisor durably records a checkpoint only after the provider/harness
reports that all state needed to continue has been committed and identifies the
provider protocol/body/model versions that can restore it. A checkpoint contains
`checkpoint_id`, `run_id`, `attempt_id`, `turn_id`, `provider_seq`,
`lease_generation`, creation time, compatibility metadata, opaque encrypted
provider reference or authorized artifact reference, accumulated usage, and the
last authoritative event cursor.

Checkpoint publication and its `checkpoint.created` event commit atomically.
Uncommitted worker-local state is never advertised as resumable. Checkpoints are
immutable; revocation appends `checkpoint.invalidated` with a reason. Secret
material and raw environment values never enter event payloads.

Resume is a compare-and-commit operation. The supervisor verifies checkpoint
ownership, authorization, compatibility, integrity, retention, terminal state,
and the new budget; allocates a new attempt and lease generation; records the
causal link; and enqueues restoration in one durable transaction. Delivery can
repeat idempotently after restart. If restoration is rejected, the new attempt
ends `failed(checkpoint_invalid)` while the source attempt and checkpoint remain
in history.

At-least-once external tool effects before a checkpoint are not repeated.
Effects after the last checkpoint may be unknown; the resume acknowledgement must
surface that uncertainty and require explicit authorization when the body
manifest cannot prove replay safety.

## Atlas worker protocol

Workers report facts. They never send an imperative "set state to running" or
"set state to completed" request.

Every observation contains `fleet_id`, `thread_id`, `run_id`, `event_id`,
`lease_generation`, and monotonically increasing `provider_seq`. The supervisor
records its own `recorded_at` timestamp and assigns the ordered event sequence.
`provider_seq` starts at one for each attempt plus lease generation and is never
reused within that scope.

```ts
type AgentRunObservation =
  | { type: "provider.connected"; eventId: string; providerSeq: number }
  | { type: "heartbeat"; eventId: string; providerSeq: number }
  | { type: "progress"; eventId: string; providerSeq: number; phase: string; evidence: unknown }
  | { type: "checkpoint.committed"; eventId: string; providerSeq: number; checkpoint: unknown }
  | { type: "tool.started"; eventId: string; providerSeq: number; toolId: string }
  | { type: "tool.completed"; eventId: string; providerSeq: number; toolId: string }
  | { type: "child.started"; eventId: string; providerSeq: number; childRunId: string }
  | { type: "child.progress"; eventId: string; providerSeq: number; childRunId: string }
  | {
      type: "child.stopped";
      eventId: string;
      providerSeq: number;
      childRunId: string;
      stop: StopReason;
    }
  | { type: "provider.stopped"; eventId: string; providerSeq: number; stop: StopReason };

type StopReason =
  | { kind: "completed"; providerCode?: string }
  | {
      kind: "limited";
      reason:
        | "max_turn_requests"
        | "max_tokens"
        | "session_budget_exceeded"
        | "max_tool_calls"
        | "max_wall_time";
      observed: number;
      limit: number;
      unit: string;
    }
  | { kind: "failed"; providerCode: string; retryable: boolean }
  | { kind: "cancelled"; providerCode?: string };
```

Atlas must emit a heartbeat at least every 15 seconds while a connection or
child execution is active. The exact phase names are Atlas-defined, but their
meaning must be documented as part of the body/plugin manifest.

Provider and harness stop reasons are observations, not direct state mutations.
The supervisor validates the observation against the lease, protocol vocabulary,
usage ledger, and current state, then appends the authoritative transition. An
unknown stop kind is rejected as `protocol_violation`; an unknown provider code
is retained only as structured detail beneath a known kind.

### Meaningful progress

A heartbeat proves liveness but never progress. Meaningful progress is a
durably accepted observation that advances user-visible or execution state:
committing assistant content, completing a tool call with a recorded result,
creating a checkpoint, entering/resolving a declared input wait, starting or
settling a required child, or advancing a body-manifest phase with evidence.
Socket traffic, repeated phase labels, token-stream keepalives, logs, retries,
and duplicate observations do not refresh `last_progress_at`.

The supervisor, not the worker, decides whether an observation qualifies.
Body manifests version their finite progress phases and evidence schema.
Progress counters are monotonic within an attempt; regressions or content-free
repeats are accepted as diagnostics at most and do not extend the deadline.

### Child runs

Each child is an independently supervised aggregate with states `queued`,
`starting`, `running`, `waiting_for_input`, `cancelling`, `completed`, `limited`,
`failed`, `stalled`, and `cancelled`. It has its own attempt, lease, checkpoints,
usage, deadlines, and terminal reason vocabulary identical to the parent.

The parent-child edge declares `required` and an explicit settlement policy.
A required child ending `failed` produces parent `failed(child_failed)`;
ending `stalled` produces the corresponding parent child-timeout reason when
caused by its deadline, otherwise `failed(child_failed)`; ending `limited`
propagates the child's limit reason to parent `limited`; and ending `cancelled`
produces `cancelled(parent_cancelled)` only when the parent initiated it,
otherwise `failed(child_failed)`. Optional child terminals are recorded but do
not settle the parent. Parent cancellation durably requests cancellation of all
nonterminal children and does not settle until the configured bounded child
settlement policy is satisfied.

## Commands and outbox

T3 submits commands to the supervisor with a caller-generated `request_id`.
Acceptance is idempotent; an acknowledgement says only that Atlas durably
accepted the request. Lifecycle events remain the source of truth.

```ts
type AgentRunCommand =
  | { kind: "run.start"; requestId: string; text: string }
  | { kind: "run.cancel"; requestId: string }
  | { kind: "run.retry"; requestId: string }
  | { kind: "run.resume"; requestId: string }
  | { kind: "input.resolve"; requestId: string; requestRef: string; answer: unknown };
```

The supervisor commits the state transition and an outbox item in one durable
operation. A delivery worker sends the execution command to the fenced Atlas
node and retries safely after a crash. A failure to deliver is a supervisor
observation; it cannot leave a run indefinitely in `starting`.

## Deadline policy

Initial values are deployment configuration, not client settings:

| Condition                                    |    Default | Result                                    |
| -------------------------------------------- | ---------: | ----------------------------------------- |
| Start accepted but no provider connection    | 30 seconds | `stalled(startup_timeout)`                |
| Running transport has no heartbeat           | 60 seconds | `stalled(transport_heartbeat_timeout)`    |
| Running execution has no meaningful progress | 10 minutes | `stalled(progress_timeout)`               |
| Required child has no heartbeat              | 60 seconds | parent `stalled(child_heartbeat_timeout)` |
| Required child has no progress               | 10 minutes | parent `stalled(child_progress_timeout)`  |

Timeout handling is conservative in the first release: mark the run `stalled`,
append the evidence, and issue a best-effort detach/stop command. Automatic retry
is a later explicit policy because repeating a tool-enabled turn may duplicate
external side effects.

Provider execution budgets are separate durable values on the attempt:
`max_turn_requests`, `max_tokens`, `max_tool_calls`, `max_wall_time`, and the
enclosing session budget reference. The supervisor stores declared limits and
observed usage, but the provider/harness remains responsible for emitting the
corresponding stop observation. Atlas may independently fence a worker that
exceeds a hard control-plane safety ceiling; that uses the same `limited` reason
and records `enforced_by: "supervisor"`.

## Durable records

The fleet plan's `runs`, `turns`, `run_leases`, `run_commands`,
`command_receipts`, and `run_events` remain the public projection. Add or make
explicit these supervisor fields:

```text
runs
  active_turn_id, active_attempt_id, state, state_version
  last_heartbeat_at, last_progress_at, deadline_at
  terminal_reason, terminal_detail_json, terminal_at

run_attempts
  attempt_id, run_id, attempt_number
  retry_of_run_id, resume_of_attempt_id, resumed_from_checkpoint_id
  state, limits_json, usage_json, terminal_reason, terminal_detail_json

run_checkpoints
  checkpoint_id, run_id, attempt_id, turn_id, provider_seq, lease_generation
  compatibility_json, artifact_ref, usage_json, event_epoch, event_seq
  created_at, invalidated_at, invalidation_reason

run_children
  parent_run_id, child_run_id, required
  settlement_policy, state, terminal_reason
  last_heartbeat_at, last_progress_at, deadline_at

run_outbox
  command_id, run_id, expected_generation, kind, payload_json
  delivery_state, attempt_count, next_attempt_at
```

The supervisor enforces uniqueness for `(run_id, event_id)` and rejects stale
lease generations or non-monotonic provider sequences.

## Epoch-plus-sequence replay

Every authoritative event has cursor `(epoch, seq)`. Sequence numbers are
contiguous and strictly increasing within an epoch. A normal supervisor restart
continues the existing epoch; it does not invalidate cursors. Atlas opens a new
epoch only when history is compacted, restored, administratively repaired, or
otherwise cannot preserve the prior contiguous sequence.

Subscription begins with an authenticated snapshot boundary
`{ snapshotVersion, epoch, throughSeq }`, replays `throughSeq + 1...N`, and only
then switches to live delivery. Consumers acknowledge only their highest
contiguous cursor. Duplicate delivery is expected and deduplicated by
`(fleet_id, run_id, epoch, seq)`.

If a requested epoch is no longer valid, Atlas returns
`cursor_epoch_invalid` with the current epoch and a snapshot URL/version. T3 must
discard only its derived projection for that run, hydrate the authoritative
snapshot, and continue from its boundary. It must not merge events across epochs
or use a locally cached terminal state to settle Atlas.

## Authenticated protocol and structured errors

HTTP handshake and WebSocket upgrade authentication are both mandatory. After
WebSocket open, the client must send `client.hello` containing protocol version,
fleet ID, authenticated session binding, requested scopes/subscriptions, and
optional replay cursors. Atlas replies with `server.hello` containing the
authenticated subject, granted scopes, fleet ID, negotiated protocol and
capabilities, server time, connection ID, heartbeat policy, and snapshot/replay
boundaries. No snapshot, event, command acknowledgement, or heartbeat acceptance
occurs before this exchange succeeds.

Token expiry, fleet/subject mismatch, insufficient scope, invalid session
binding, or incompatible protocol after upgrade produces a structured
`connection.rejected` frame when safe, followed by close. T3 treats the
connection as unauthorized/incompatible, clears local `starting`, and does not
change an Atlas run. Merely opening the socket never establishes readiness.

All control-plane errors use:

```ts
type ControlPlaneError = {
  code:
    | "unauthenticated"
    | "permission_denied"
    | "fleet_mismatch"
    | "protocol_incompatible"
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "stale_generation"
    | "cursor_epoch_invalid"
    | "precondition_failed"
    | "rate_limited"
    | "temporarily_unavailable"
    | "internal";
  message: string;
  retryable: boolean;
  requestId?: string;
  traceId: string;
  details?: Record<string, unknown>;
};
```

Errors never carry credentials or raw provider payloads. Retry hints are bounded
and explicit. HTTP status, WebSocket rejection, and command-receipt errors map
to the same vocabulary.

## T3 integration boundary

T3's Atlas fleet adapter must:

1. create/attach a stable Atlas `run_id` for a T3 thread;
2. forward user commands using the Atlas command API;
3. persist the Atlas run ID, event cursor, and displayed projection mapping;
4. map replayed Atlas events into T3's existing provider-runtime events;
5. render the supervisor's state, deadline, last heartbeat/progress, child state,
   and terminal reason.

T3 must not:

- directly update `provider_session_runtime` to settle an Atlas fleet run;
- decide `stalled` in React or a Node timer;
- create a second ownership lease;
- convert a lost local WebSocket into a terminal Atlas failure without Atlas
  confirming the durable transition.

The existing T3 `ProviderSessionReaper` remains local cleanup for direct-node
providers. It is not the active-run watchdog in fleet mode.

Direct-node mode is explicitly compatibility behavior: T3 talks to one worker,
may apply local startup cleanup and legacy event normalization, and cannot claim
durable fleet ownership, replay, checkpoint recovery, or cross-node authority.
Fleet mode exclusively follows the Atlas supervisor and its Turso history.
No direct-node observation, T3 timer, cached projection, or compatibility
fallback may mutate or settle a fleet run. UI and diagnostics must label the
mode so degraded direct-node guarantees are never presented as fleet guarantees.

## Recovery and observability

On supervisor restart, do-rs reloads the run aggregate and retries due outbox
items. It also recomputes the next deadline from durable timestamps. If a
deadline passed while the supervisor was unavailable, recovery atomically
appends the same terminal transition that an on-time timer would have produced
before processing later worker observations. No in-memory timer is required for
correctness, and restart does not grant extra execution time.

Required metrics and structured fields:

- active runs by state and body;
- heartbeat and progress age;
- deadline expiration count by reason;
- outbox retry count and age;
- child-run count and oldest child age;
- rejected stale-generation observations;
- command receipt latency;
- `fleet_id`, `run_id`, `turn_id`, `node_id`, `lease_generation`, and trace ID.

## Acceptance proof

The contract is not complete until these tests pass end to end:

1. Authentication or scope rejection after WebSocket open emits a structured
   rejection, starts no replay, and does not create or settle a run.
2. Each of `max_turn_requests`, `max_tokens`, `session_budget_exceeded`,
   `max_tool_calls`, and `max_wall_time` produces durable `limited(reason)`,
   records usage/checkpoint data, and preserves the prior attempt after retry or
   authorized resume.
3. A valid long-running child emits heartbeats and remains `running`.
4. Every child terminal state and propagation policy is exercised, including
   optional children and parent cancellation.
5. A silent child stalls its parent with the child timeout reason.
6. An open but silent worker connection stalls the run after its heartbeat
   deadline.
7. Duplicate, delayed, or non-meaningful observations cannot extend progress
   deadlines or produce duplicate transitions.
8. A restarted supervisor recovers state, checkpoints, budgets, outbox work, and
   the same epoch-plus-sequence history.
9. A deadline that expires during supervisor downtime is settled immediately on
   recovery using the durable deadline, before later observations.
10. A stale worker generation cannot append events after reassignment.
11. Epoch invalidation forces snapshot replacement and never merges histories.
12. T3 disconnects during execution without settling the Atlas run; on reconnect
    it renders the same Atlas-owned terminal reason and event
    trail without relying on a browser timer.
