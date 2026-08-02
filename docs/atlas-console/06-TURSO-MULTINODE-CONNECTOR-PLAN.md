# Atlas Turso multi-node connector plan

## Purpose

Build one Atlas fleet connector in T3 that discovers and controls multiple Atlas
nodes through an Atlas-owned, do-rs-supervised, Turso-backed control plane.
Atlas/do-rs/Turso is the authoritative coordination, lifecycle, checkpoint, and
event substrate; Atlas nodes execute work; the shared T3 web UI and Electron
desktop shell render an authenticated projection and submit commands.

This replaces the current user experience of configuring one Atlas provider instance
per node. Direct-node instances remain available during migration and as a recovery
path.

## Current system

T3 already has the correct connector extension points:

1. `ServerSettings.providerInstances` stores a provider-instance envelope keyed by a
   stable `ProviderInstanceId`.
2. The `ProviderInstanceRegistry` watches settings and creates, replaces, or stops
   runtime provider instances.
3. `BUILT_IN_DRIVERS` maps `driver: "atlas"` to `AtlasDriver`.
4. `AtlasDriver.create` constructs health, model-catalog, text-generation, and runtime
   adapter services.
5. The web and desktop clients consume the same provider snapshots and orchestration
   contracts.

The current Atlas configuration points directly at one node:

```json
{
  "driver": "atlas",
  "displayName": "Atlas node",
  "config": {
    "baseUrl": "http://127.0.0.1:3010",
    "plugin": "coder",
    "wsToken": "..."
  }
}
```

Its limitations are:

- one manually configured instance per node;
- gossip, rather than a durable registry, is the fleet catalog;
- no authoritative workspace or historical-run catalog;
- no fenced run ownership or cross-node command routing;
- no Turso integration;
- credentials are shaped as direct-node configuration instead of a fleet credential;
- the direct-node health probe can report an instance as ready after calling the
  ungated `/_members` endpoint even when the authenticated `/_feed` endpoint will
  reject every turn;
- a feed failure before an active turn exists can leave the session in `starting`
  without a terminal event or visible error;
- schema defaults can hydrate a reachable, enabled, but unauthenticated direct-node
  connector instead of reporting `setup-required`;
- terminal, files, Git, assets, and preview remain node-local and unbound.

### Validated direct-node failure

A tokenless `/_feed` connection has been observed returning:

```json
{ "class": "permission_error", "error": "unauthenticated" }
```

and then closing immediately. At the same time, the ungated `/_members` probe
succeeds and can make the provider card appear ready, authenticated, and fully
capable. This creates a false-positive readiness state: the provider is selectable,
but no turn can start.

This case establishes three invariants for both direct-node and fleet connectors:

1. Readiness must exercise or validate the same authenticated capability required
   for execution.
2. A transport failure before `turn.started` must still terminate the session/start
   attempt and produce a visible structured error.
3. Missing required credentials must produce `setup-required`, never `available`.

Credential rollback must remove only the Atlas secret or provider-instance entry
through the settings service. Deleting the complete `settings.json` file is not an
acceptable rollback because it can remove unrelated user settings.

## Target architecture

```text
T3 web / Electron desktop
          |
          v
Atlas fleet connector in apps/server
          |
          +---- Atlas control API / event gateway
          |               |
          |               v
          |             Turso
          |       catalog, leases, events,
          |       commands, receipts, audit
          |
          +---- owning Atlas node
                  execution, tools, terminal,
                  files, Git, preview
```

T3 should not connect directly to Turso from the browser. The server-side connector
owns Turso/control-plane credentials and exposes typed T3 contracts to both clients.
It remains a lens: T3 caches derived projections for usability, but cannot originate,
repair, or settle fleet lifecycle state.

### Authority boundary and compatibility mode

Fleet mode and direct-node mode have deliberately different guarantees:

- **Fleet authority behavior:** Atlas control-plane supervisors are the only lifecycle
  writers. Turso contains durable commands, attempts, checkpoints, terminal outcomes,
  and epoch-plus-sequence events. T3 reconnects by snapshot and replay and never uses
  a local timeout or disconnect to settle an Atlas run.
- **Direct-node compatibility behavior:** T3 talks to one legacy node, normalizes its
  ephemeral feed, and may use the existing local startup cleanup/reaper. It provides
  no durable fleet ownership, cross-node routing, checkpoint recovery, or authoritative
  replay guarantee.

The adapter, diagnostics, and UI must carry the connection mode explicitly. No
direct-node fallback, observation, local cache, or T3 reaper may mutate a fleet run.
Losing T3's WebSocket or stopping T3 leaves the Atlas run active until the Atlas
supervisor records an authoritative terminal transition.

## Connector identity and configuration

Keep `driver: "atlas"` and add an explicit connection mode. Do not introduce a
parallel connector registry.

Proposed driver configuration:

```ts
type AtlasConnectorConfig =
  | {
      mode: "fleet";
      controlUrl: string;
      fleetId: string;
      defaultBody: string;
      requestTimeoutMs?: number;
    }
  | {
      mode: "direct-node";
      baseUrl: string;
      plugin: string;
    };
```

Secrets belong in the existing provider-instance environment/secret-store flow:

- `ATLAS_FLEET_TOKEN`
- `ATLAS_WS_TOKEN` for legacy direct-node mode
- `TURSO_DATABASE_URL` only if T3 must access Turso directly
- `TURSO_AUTH_TOKEN` only if T3 must access Turso directly

Preferred design: T3 authenticates to an Atlas control API using
`ATLAS_FLEET_TOKEN`; only Atlas control-plane services hold Turso credentials.

The persisted `settings.json` entry contains redacted secret metadata, never the
secret value. The server secret store contains the value. Client settings responses
remain redacted. Logs, diagnostics, URLs, WebSocket errors, and telemetry must not
include tokens.

Example persisted connector:

```json
{
  "providerInstances": {
    "atlas_fleet": {
      "driver": "atlas",
      "displayName": "Atlas Fleet",
      "enabled": true,
      "environment": [
        {
          "name": "ATLAS_FLEET_TOKEN",
          "value": "",
          "sensitive": true,
          "valueRedacted": true
        }
      ],
      "config": {
        "mode": "fleet",
        "controlUrl": "https://atlas.example.com",
        "fleetId": "primary",
        "defaultBody": "coder"
      }
    }
  }
}
```

## Connector creation flow

The Providers settings screen owns creation:

1. User selects **Add provider** and chooses **Atlas**.
2. User selects **Fleet** or **Direct node**. Fleet is the recommended default.
3. Fleet form requests display name, control URL, fleet ID, default body, and fleet
   token.
4. Client sends one typed settings patch; it never writes local storage as the
   source of truth.
5. Server validates the provider envelope and the Atlas driver-specific config.
6. Server moves sensitive values into `ServerSecretStore`.
7. Server atomically writes sparse `settings.json`.
8. `ProviderInstanceRegistry` observes the settings change.
9. Registry constructs the Atlas driver instance.
10. The instance performs a non-mutating handshake and publishes connecting,
    available, degraded, unauthorized, or unreachable status.
11. The UI reports the stored connector even while unavailable; configuration must
    not disappear because a fleet is offline.

Creation must be idempotent by `ProviderInstanceId`. Editing a connector replaces its
runtime instance only after the new configuration validates. Removing a connector
stops its streams and runtime resources, then removes its settings and associated
secrets without deleting Atlas or Turso fleet data.

For direct-node mode, creation is incomplete until the server validates feed
authentication. A successful `/_members` response alone is discovery, not
readiness.

## Connector startup and lifecycle

On T3 server startup:

1. Load and normalize `settings.json`.
2. Rehydrate secret values from `ServerSecretStore`.
3. Resolve `driver: "atlas"` through `BUILT_IN_DRIVERS`.
4. Decode fleet or direct-node configuration.
5. Create an `AtlasFleetClient`.
6. Call `GET /console/v1/handshake`.
7. Validate protocol version, fleet identity, authenticated subject, and supported
   capabilities.
8. Fetch an initial fleet/catalog snapshot.
9. Open the durable event channel, complete its authenticated `client.hello` /
   `server.hello` exchange, and use the returned epoch/cursor boundary.
10. Hydrate provider models, bodies, workspaces, runs, ownership, and health.
11. Publish a provider snapshot to the shared web/desktop clients.
12. Maintain heartbeat and reconnect loops inside the scoped provider instance.

The handshake must cover execution authentication. It may use an explicit
authenticated readiness endpoint or a side-effect-free authenticated feed handshake.
It must not infer execution readiness from an ungated catalog endpoint.

HTTP authentication and the WebSocket post-open protocol handshake are both required.
Before any events or command acknowledgements, `client.hello` declares protocol
version, fleet, session binding, scopes, subscriptions, and replay cursors;
`server.hello` returns authenticated subject, granted scopes, negotiated protocol and
capabilities, heartbeat policy, and snapshot/replay boundaries. Authentication,
fleet, scope, session-binding, or version rejection after upgrade sends a structured
`connection.rejected` when safe and then closes. An opened socket is not readiness.

Lifecycle states:

- `disabled`
- `connecting`
- `available`
- `degraded`
- `unauthorized`
- `setup-required`
- `incompatible`
- `unreachable`
- `stopped`

Reconnect uses bounded exponential backoff with jitter. Authentication and schema
errors do not retry aggressively. Network errors do. The connector preserves the
last confirmed snapshot while clearly marking it stale.

If a socket sends a structured error and closes before a turn becomes active, the
adapter must:

- decode and preserve the declared error class;
- fail the pending session/start request;
- emit a terminal canonical runtime error associated with the attempted thread;
- clear `starting`;
- retain the rejected user message with retry affordance;
- publish the error to the provider/session banner;
- avoid reconnecting indefinitely for `permission_error`.

Fleet-mode transport failure clears only T3's pending command/projection state. It
must not append an Atlas lifecycle event or settle a previously accepted Atlas run.

Stopping or replacing an instance must:

- stop reconnect and heartbeat fibers;
- close sockets and HTTP clients;
- stop accepting new commands;
- allow in-flight command receipts to settle within a bounded drain period;
- preserve durable Atlas runs;
- release only leases owned by T3, if T3 owns any;
- never delete fleet data.

## Turso control-plane schema

All tables include `fleet_id`. IDs are application-generated stable IDs. Timestamps
are server-generated. Mutable records carry a revision or generation.

### Fleet and nodes

`fleets`

- `fleet_id`
- `name`
- `created_at`
- `schema_version`

`fleet_nodes`

- `fleet_id`
- `node_id`
- `display_name`
- `endpoint`
- `version`
- `protocol_version`
- `state`
- `registered_at`
- `last_seen_at`
- `retired_at`
- `revision`

`node_capabilities`

- `fleet_id`
- `node_id`
- `capability`
- `version`
- `metadata_json`
- `observed_at`

`node_bodies`

- `fleet_id`
- `node_id`
- `body_id`
- `is_default`
- `manifest_json`
- `observed_at`

`node_models`

- `fleet_id`
- `node_id`
- `model_id`
- `backend`
- `capabilities_json`
- `health`
- `observed_at`

Nodes register idempotently and heartbeat periodically. Missing heartbeats transition
nodes through healthy, stale, offline, and retired states. Records are retained for
history instead of being hard-deleted.

### Workspaces and runs

`workspaces`

- `fleet_id`
- `workspace_id`
- `display_name`
- `repository_identity`
- `default_ref`
- `created_at`
- `archived_at`
- `metadata_json`

`workspace_nodes`

- `fleet_id`
- `workspace_id`
- `node_id`
- `local_root_ref`
- `access_mode`
- `last_verified_at`

`runs`

- `fleet_id`
- `run_id`
- `workspace_id`
- `body_id`
- `title`
- `summary`
- `state`
- `active_attempt_id`
- `terminal_reason`
- `terminal_detail_json`
- `owner_node_id`
- `owner_generation`
- `created_at`
- `updated_at`
- `archived_at`

`turns`

- `fleet_id`
- `run_id`
- `turn_id`
- `state`
- `model_id`
- `started_at`
- `completed_at`
- `error_class`
- `error_message`

`run_attempts`

- `fleet_id`
- `run_id`
- `attempt_id`
- `attempt_number`
- `retry_of_run_id`
- `resume_of_attempt_id`
- `resumed_from_checkpoint_id`
- `state`
- `limits_json`
- `usage_json`
- `terminal_reason`
- `terminal_detail_json`
- `started_at`
- `terminal_at`

Terminal states are `completed`, `limited`, `failed`, `stalled`, and `cancelled`.
The `limited` reasons are exactly `max_turn_requests`, `max_tokens`,
`session_budget_exceeded`, `max_tool_calls`, and `max_wall_time`. They are durable
provider/harness-declared outcomes, not aliases for failure, stall, or cancellation.
Retry and resume allocate a new immutable attempt and retain the source attempt,
usage, events, and terminal reason. Resume additionally requires a compatible durable
checkpoint and renewed authorization/budget; session-budget exhaustion requires that
the enclosing budget be replenished or replaced.

`run_checkpoints`

- `fleet_id`
- `run_id`
- `attempt_id`
- `checkpoint_id`
- `turn_id`
- `provider_seq`
- `owner_generation`
- `compatibility_json`
- `artifact_ref`
- `usage_json`
- `event_epoch`
- `event_seq`
- `created_at`
- `invalidated_at`
- `invalidation_reason`

A checkpoint becomes resumable only when its durable record and
`checkpoint.created` event commit atomically. It is immutable and contains an opaque
encrypted provider/artifact reference, never secret material. Resume validates
authorization, integrity, retention, body/model/protocol compatibility, lease
generation, side-effect safety, and the new budget before atomically creating a new
attempt and restoration outbox item.

### Ownership and commands

`run_leases`

- `fleet_id`
- `run_id`
- `node_id`
- `generation`
- `lease_token_hash`
- `acquired_at`
- `renewed_at`
- `expires_at`

`run_commands`

- `fleet_id`
- `request_id`
- `run_id`
- `expected_generation`
- `kind`
- `payload_json`
- `created_by`
- `created_at`
- `state`

`command_receipts`

- `fleet_id`
- `request_id`
- `node_id`
- `generation`
- `state`
- `result_json`
- `error_json`
- `completed_at`

One generation has one authoritative owner. Every command names its expected
generation. Every event is accepted only from the fenced owner. Request IDs make
command submission idempotent.

Initial failure behavior is conservative: an expired owner marks a run orphaned.
Automatic live migration is out of scope. An explicit resume/reassign operation
creates a new generation and audit event.

`orphaned` is ownership/availability metadata, not a lifecycle terminal state. The
supervisor still determines whether the active attempt remains live, becomes
`stalled` at its durable deadline, or is explicitly resumed/reassigned. T3 must not
settle an orphaned run locally.

Provider and harness stop reports are fenced observations. The Atlas supervisor maps
only a closed stop vocabulary—`completed`, `limited`, `failed`, or `cancelled`—into
authoritative terminal state. Unknown stop kinds are protocol violations; provider
codes are retained as structured detail. Heartbeats prove liveness only. Meaningful
progress requires a durable advance such as committed assistant content, completed
tool result, checkpoint, input-wait transition, child transition, or manifest-declared
phase evidence. Traffic, logs, repeated phases, keepalives, and duplicates do not
refresh the progress deadline.

`run_children` records an independently supervised child with the complete state set
`queued`, `starting`, `running`, `waiting_for_input`, `cancelling`, `completed`,
`limited`, `failed`, `stalled`, and `cancelled`; its own attempts, limits, usage,
checkpoints, deadlines, and terminal reason; whether it is required; and its explicit
parent settlement policy. Required child limits propagate as parent `limited`;
required failures and non-parent cancellations fail the parent; child deadline stalls
use the child timeout reason; optional child terminals remain visible without settling
the parent. Parent cancellation durably requests cancellation of nonterminal children.

### Durable events

`run_event_epochs`

- `fleet_id`
- `run_id`
- `epoch`
- `created_at`
- `closed_at`

`run_events`

- `fleet_id`
- `run_id`
- `epoch`
- `seq`
- `ts`
- `node_id`
- `owner_generation`
- `workspace_id`
- `turn_id`
- `kind`
- `payload_json`
- `asset_id`

Primary identity is `(fleet_id, run_id, epoch, seq)`.

`consumer_cursors`

- `fleet_id`
- `consumer_id`
- `run_id`
- `epoch`
- `contiguous_seq`
- `updated_at`

Required behavior:

- transactional sequence allocation;
- ordered replay after `epoch + seq`;
- deduplication by event identity;
- explicit replay boundary before live delivery;
- snapshot fallback after epoch invalidation or retention truncation;
- server-stamped timestamps;
- payload-size enforcement;
- no secrets in event payloads.

A normal supervisor restart continues the current epoch. A new epoch is created only
when compaction, restoration, or repair makes the former contiguous history
unavailable. Subscription starts from an authenticated snapshot boundary
`(epoch, through_seq)`, replays the contiguous suffix, and then switches to live
delivery. Consumers acknowledge only their highest contiguous `(epoch, seq)`.
`cursor_epoch_invalid` requires replacement from the supplied current snapshot;
clients never merge histories across epochs.

Initial event vocabulary:

- `fleet.snapshot`, `fleet.updated`
- `catalog.updated`
- `workspace.snapshot`, `workspace.updated`
- `run.snapshot`, `run.created`, `run.updated`
- `turn.started`, `turn.completed`, `turn.interrupted`
- `message.user`
- `message.assistant.delta`, `message.assistant.completed`
- `thinking.delta`
- `tool.started`, `tool.completed`
- `checkpoint.created`, `checkpoint.invalidated`
- `attempt.started`, `attempt.terminal`
- `child.started`, `child.updated`, `child.terminal`
- `run.error`
- `edge.created`

### Supervision and audit

`pending_requests`

- approvals and agent questions with stable IDs, owning run generation, expiry, and
  state.

`request_resolutions`

- idempotent approval, denial, and answer records.

`audit_events`

- actor, action, target, timestamp, generation, and non-secret structured details.

## Atlas control API

T3 should use an Atlas-owned control API instead of embedding Turso access in every
client.

Initial endpoints:

- `GET /console/v1/handshake`
- `GET /console/v1/fleet`
- `GET /console/v1/catalog`
- `GET /console/v1/workspaces`
- `GET /console/v1/runs`
- `GET /console/v1/runs/:runId`
- `POST /console/v1/runs`
- `POST /console/v1/runs/:runId/commands`
- `POST /console/v1/runs/:runId/reassign`
- `GET /console/v1/events`
- `GET /console/ws`

The WebSocket supports scoped fleet/run subscriptions, replay cursors, command
acknowledgements, heartbeat, slow-consumer handling, and bounded frames.

Authentication requirements:

- short-lived access token or signed session derived from the stored fleet
  credential;
- fleet and subject claims;
- explicit read, execute, supervise, and administration scopes;
- origin policy for browser-mediated paths;
- token redaction;
- rotation without recreating the connector;
- audit records for privileged commands.

All HTTP errors, post-open WebSocket rejections, and command-receipt failures use one
redacted structured envelope with `code`, safe `message`, `retryable`, optional
`requestId`, required `traceId`, and bounded `details`. The initial codes are
`unauthenticated`, `permission_denied`, `fleet_mismatch`,
`protocol_incompatible`, `invalid_request`, `not_found`, `conflict`,
`stale_generation`, `cursor_epoch_invalid`, `precondition_failed`, `rate_limited`,
`temporarily_unavailable`, and `internal`.

## T3 server implementation

### Contracts

Add schema-only contracts for:

- Atlas connector modes;
- fleet/node/catalog snapshots;
- workspace and run summaries;
- ownership generation;
- event cursor and envelopes;
- command request, acknowledgement, and structured errors;
- supervision requests and resolutions.

Do not place runtime logic in `packages/contracts`.

### Runtime client

Create explicit runtime modules:

- `AtlasFleetClient`
- `AtlasFleetAuth`
- `AtlasFleetCatalog`
- `AtlasFleetEventStream`
- `AtlasFleetCommandRouter`
- `AtlasFleetProjection`

Runtime responsibilities:

- handshake and version negotiation;
- authenticated HTTP/WebSocket calls;
- cursor persistence;
- snapshot plus replay reconciliation;
- reconnect and backpressure;
- command acknowledgement;
- error classification and redaction.

### Driver evolution

Split Atlas driver creation by mode:

- direct-node mode retains the current `/_members`, Agent route, and feed behavior;
- fleet mode builds the new fleet client and exposes one provider instance for the
  whole fleet.

The provider snapshot should contain fleet-level availability and the union of
routable models, while model entries retain node/body routing metadata. A selected
model is not considered available unless an eligible healthy node can execute it.

### Projection and orchestration

Map Atlas durable events into the existing canonical provider-runtime event stream.
Persist stable Atlas run IDs, owner generations, and cursors with T3 thread/session
state. Do not create a second UI-specific event model.

Commands flow:

```text
T3 command
  -> AtlasFleetCommandRouter
  -> durable request_id + expected owner generation
  -> owning node
  -> command receipt
  -> durable runtime events
  -> existing T3 projections
```

The command receipt confirms acceptance; runtime events remain authoritative for
timeline and lifecycle state.

## Web and desktop UI

The shared `apps/web` UI automatically serves both the browser and Electron desktop.
Add:

- fleet connector creation/edit form;
- connection and authentication status;
- fleet node list and health;
- workspace catalog;
- historical and active runs;
- owning-node and generation display;
- stale/orphaned/incompatible warnings;
- explicit resume/reassign action;
- body/model availability derived from eligible nodes;
- approval and question surfaces when their backend phase lands.

Electron-only work is required only for native capabilities:

- local filesystem and dialogs;
- embedded preview webviews;
- desktop credential integration if chosen;
- OS menus and updates.

Fleet catalog, runs, timelines, settings, and supervision remain shared web UI.

## Node-local capabilities

After durable ownership and routing are proven, bind these through the owning node:

1. terminal list/open/attach/write/resize/interrupt/close/replay;
2. authorized workspace filesystem projection;
3. repository, Git, worktree, diff, and checkpoint operations;
4. application-server discovery and preview lifecycle;
5. browser navigation, viewport, annotation, and automation;
6. assets and authorized large-payload retrieval;
7. node lifecycle, diagnostics, traces, and update status.

Turso stores coordination and metadata. It does not carry PTY byte streams, file
contents, Git execution, or live browser frames.

## Delivery phases

### Phase 0 — freeze the authority contract

- Confirm Atlas owns the control API and only Atlas services receive Turso
  credentials.
- Finalize IDs, attempt/child state machines, limit and terminal-reason vocabulary,
  lease and checkpoint semantics, retention, scopes, structured errors, handshake,
  epoch rules, and protocol versioning.
- Publish body-manifest rules for meaningful progress, checkpoints, and stop reasons.

Exit: the normative Atlas contract and schemas are reviewed with no T3 lifecycle
authority.

### Phase 1 — Atlas-owned vertical substrate slice

Complete this phase in Atlas/do-rs/Turso before building the typed T3 fleet client:

- Add fleet/node/workspace/run/attempt/child/checkpoint/lease/command/outbox/event,
  cursor, pending-request, and audit schema plus migrations.
- Implement node registration, heartbeat/expiry, catalog, and eligible routing.
- Implement one durable run supervisor with fenced command delivery, observation
  validation, complete terminal outcomes including all five limit reasons, meaningful
  progress, child settlement, checkpoints, resume/retry history, and deadline recovery.
- Implement authenticated HTTP and post-open WebSocket handshakes, structured errors,
  snapshots, epoch-plus-sequence replay, backpressure, and cursor invalidation.
- Exercise the vertical slice directly against the Atlas control API with a
  deterministic two-node harness.

Exit: without T3, one authenticated client can create and run a turn, exhaust a
budget, restart the supervisor, recover a passed deadline, resume from a checkpoint,
replay identical history, reject stale generations, and observe complete child states.

### Phase 2 — typed T3 server lens

- Add connector-mode, snapshot, run/attempt/child/checkpoint, cursor, command,
  acknowledgement, and structured-error schemas.
- Add fleet-mode settings and secret storage through `ServerSecretStore`.
- Implement the typed fleet client, authenticated handshake, projection, cursor
  persistence, reconnect, replacement, and shutdown.
- Map Atlas snapshots/events into canonical T3 runtime events without adding lifecycle
  authority.
- Keep direct-node compatibility behavior explicitly separate; require authenticated
  feed readiness, visible pre-turn rejection, and existing local cleanup only there.

Exit: T3 can disconnect during an active turn without settling it, then reconnect,
replace its projection from snapshot/replay, and render Atlas's exact outcome.

### Phase 3 — shared T3 UI

- Add connector creation/edit/remove and secret rotation.
- Add fleet, workspace, historical run, attempt, child, checkpoint, budget, ownership,
  deadline, and terminal-reason projections.
- Label direct-node compatibility guarantees separately from fleet authority.
- Add explicit retry, resume, reassign, approval, and question surfaces as their
  Atlas endpoints become available.

Exit: the shared web/desktop UI reconstructs entirely from Atlas after a clean client
restart and never presents cached T3 state as authoritative.

### Phase 4 — node-local tools

- Terminal
- Files
- Git/diffs/checkpoints
- Preview/browser automation
- Assets
- Diagnostics

Each capability gets its own authorization, routing, protocol, tests, and rollout
flag.

## First end-to-end milestone

The first shippable multi-node proof must demonstrate:

1. Create one Atlas fleet connector in T3.
2. Restart T3 and recover it with secrets intact and redacted.
3. Register two Atlas nodes in the same Turso fleet.
4. Observe both heartbeats and capability catalogs.
5. Register one workspace.
6. Create one run through the Atlas control API, then render it in T3.
7. Select an eligible owner and acquire a fenced lease.
8. Submit one idempotent turn command.
9. Persist ordered user, assistant, tool, and completion events.
10. Disconnect and reconnect T3.
11. Replay the identical timeline without duplicates.
12. Stop the owner node.
13. Let the Atlas supervisor record the owner-loss outcome; T3 only renders it.
14. Reject stale events and commands from the old generation.
15. Explicitly reassign or resume the run on the second node.

Before that milestone, the direct-node regression proof must demonstrate:

1. No token produces `setup-required` and the provider cannot be selected.
2. A rejected token produces `unauthorized`, not `available`.
3. A successful `/_members` response cannot override failed feed authentication.
4. A feed `permission_error` before `turn.started` visibly terminates startup.
5. The failed message remains retryable after credentials are corrected.
6. Correcting or rotating the secret hot-reloads the instance without editing other
   settings.

## Verification strategy

Focused tests are required at each boundary:

- contract decode/encode and backward compatibility;
- authentication or scope rejection after WebSocket open, before replay or command
  acceptance, with a structured rejection and no run-state change;
- settings persistence, secret extraction, redaction, rotation, and deletion;
- provider-registry create/replace/stop behavior;
- handshake and protocol negotiation;
- missing, rejected, rotated, and redacted Atlas credentials;
- authenticated readiness disagreement with an ungated `/_members` response;
- feed errors and closes before `turn.started`;
- heartbeat expiry and mixed-version nodes;
- Turso migrations and transactional lease fencing;
- idempotent command requests and receipts;
- each execution budget (`max_turn_requests`, `max_tokens`,
  `session_budget_exceeded`, `max_tool_calls`, and `max_wall_time`) producing the
  matching durable `limited` outcome and immutable retry/resume history;
- checkpoint commit, compatibility rejection, idempotent restore, and side-effect
  uncertainty authorization;
- all child states, terminal reasons, required/optional propagation, and parent
  cancellation;
- event ordering, epoch-plus-sequence replay, deduplication, truncation, epoch
  invalidation, and snapshot replacement;
- supervisor restart with state, outbox, checkpoint, budget, and cursor recovery;
- deadline expiry during supervisor downtime, settled on recovery before later
  observations;
- meaningful-progress rejection for heartbeats, keepalives, logs, duplicates, and
  repeated phase labels;
- stale-owner rejection;
- authorization and log-redaction tests;
- adapter-to-canonical-event mapping;
- T3 WebSocket loss during execution without any Atlas terminal transition, followed
  by authoritative replay on reconnect;
- strict fleet/direct-node behavior separation, including proof that the direct-node
  reaper cannot settle a fleet run;
- shared web settings/fleet/run UI tests;
- Electron integrated verification for any native behavior changed.

Use a deterministic two-node integration harness with disposable Turso/libSQL state.
Fault injection must cover socket loss, delayed events, duplicate delivery, node
death, lease expiry, token rotation, post-open authentication rejection, schema
mismatch, epoch invalidation, supervisor restart during a turn, and restart across a
deadline.

## Migration and rollout

1. Ship fleet mode behind a feature flag.
2. Keep existing direct-node instances readable and runnable.
3. Offer an explicit migration action that creates one fleet connector; do not
   silently combine node credentials.
4. Match existing direct nodes to fleet nodes by stable node identity, not URL text.
5. Preserve persisted thread bindings until their runs are imported or intentionally
   left on the direct-node connector.
6. Run both paths during the observation period.
7. Make fleet mode the default for new Atlas connectors only after replay, leases,
   and restart recovery are proven.
8. Deprecate direct-node mode separately; retain an administrative recovery route.

## Non-goals for the foundation

- transparent live migration of an executing turn;
- multiple authoritative writers for a run;
- direct browser-to-Turso credentials;
- terminal or browser streams through Turso;
- file contents or Git repositories stored in Turso;
- automatic deletion of fleet history when removing a T3 connector;
- removal of Atlas gossip before the durable registry is operational;
- rewriting the current T3 provider registry.

## Remaining design decisions

These choices do not alter the authority or lifecycle decisions above, but must be
closed in Phase 0:

1. Atlas control API deployment topology and the exact do-rs object/isolate placement
   strategy.
2. Retention durations for events, epochs, attempts, checkpoints, command receipts,
   and audit records, including the minimum snapshot availability after compaction.
3. Checkpoint artifact storage/encryption, maximum size, and body/model/protocol
   compatibility policy.
4. Canonical token accounting across providers, including whether cached, reasoning,
   input, and output tokens share one `max_tokens` ledger or use declared sublimits.
5. Default numeric execution budgets, supervisor safety ceilings, child-settlement
   grace periods, and which roles may renew each budget.
6. Concrete authentication mechanism, token/session lifetime, rotation overlap,
   signing-key distribution, browser origin policy, and scope-to-role mapping.
7. Whether desktop secrets remain in `ServerSecretStore` or gain OS credential-store
   integration; this cannot change the redaction or Atlas authority boundary.

## Completion definition

The foundation is complete when one securely persisted Atlas fleet connector can
start in web or desktop mode, discover multiple nodes, list workspaces and historical
runs, route a turn through a fenced owner, rebuild its timeline from durable ordered
events after restart, surface node loss honestly, and reject stale writers without
manual repair of T3 settings.
