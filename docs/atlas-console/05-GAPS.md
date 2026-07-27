# Atlas capability gaps

These gaps are capabilities Atlas must own before the corresponding donor
surfaces can be faithfully rebound. The ordering is architectural dependency
order, not a delivery estimate.

## GAP-001 — Browser authentication and transport adoption

**Owner:** Atlas substrate, using a do-rs durable primitive.

Atlas `:3010` currently relies on Tailscale/WireGuard as its normal security
boundary and has no browser application authentication. StudyOS provides the
preferred donor:

- Axum `GET /session/ws`
- JWT verification and owner checks
- Durable do-rs event isolate
- `after` replay cursor
- duplex read/write handles
- LISTEN/NOTIFY wake-up
- presence and heartbeat

Atlas must adopt this pattern with a versioned envelope, origin policy, token
lifecycle, bounded replay, slow-consumer behavior, and fleet/run authorization.
Query-string bearer tokens are a workable browser bootstrap but require log
redaction and short lifetimes.

## GAP-002 — Atlas runtime event publisher

**Owner:** Atlas substrate.

AgentDO persists messages and tool calls, but the console cannot observe the
full lifecycle. `/since` returns assistant messages only and `/transcript`
flattens tools into text.

Atlas must publish durable, ordered events for:

- run and turn lifecycle
- user and assistant content
- thinking/progress when available
- tool start and completion
- errors and interruption
- context and usage
- agent/fleet edges

Use StudyOS for append/replay/wait mechanics and Warden for the initial
`UiEvent` vocabulary. The Atlas envelope must add `version`, `epoch`, `seq`,
`ts`, `node_id`, `body_id`, `workspace_id`, `run_id`, and `turn_id`.

## GAP-003 — Fleet and node catalog

**Owner:** Atlas substrate.

`/_members` contains live nodes, tools, manifests, and vitals only when
`ATLAS_PEERS` is configured. A solo node has no equivalent fleet snapshot.

The canonical API must always return at least self, publish membership changes,
and expose stable node identity, health, capabilities, bodies, and endpoints.

## GAP-004 — Workspace and run catalogs

**Owner:** Atlas substrate for runs; the relevant body for workspace metadata.

Atlas has addressed run isolates but no list API. It cannot currently enumerate:

- workspaces and repositories
- active and historical runs
- warm conversations
- run titles or summaries
- run-to-workspace relationships
- archive or retention state

The sidebar cannot be rebound until these resources are cataloged.

## GAP-005 — Bodies, backends, agents, and real models

**Owner:** Atlas substrate and deployment manifests.

`GET /v1/models` returns one synthetic `atlas` entry. Gossip exposes some
Ollama vitals and body manifests but not a complete executable catalog.

Atlas needs list/snapshot contracts for:

- compiled bodies/plugins
- agent specifications
- backends available per node
- real routable models
- model capabilities and tool support
- defaults and health

The console renders this knowledge; it does not probe local CLIs.

## GAP-006 — Approval and question round-trip

**Owner:** Atlas substrate.

`atlas-agents` has `Verdict::{Allow,Deny,Confirm}` and
`Trust::{ReadOnly,Ask,Auto}`, but the HTTP execution path does not implement a
durable human round-trip.

A complete gate requires:

1. Enforcement on the actual tool execution path
2. A durable pending request with stable ID
3. Publication to authorized lenses
4. Approve, deny, and answer commands
5. Idempotent resolution
6. Timeout and disconnect behavior
7. Resumption of suspended execution
8. An audit record

Without this gap, Atlas Console is a log viewer rather than a supervisory
console.

## GAP-007 — Attach-capable terminal

**Owner:** Atlas substrate because it is execution on a node.

Hearth is a real PTY and Atlas exposes bash tools, but there is no list, open,
attach, write, resize, interrupt, close, or replay API for a human terminal.
The terminal surface needs a dedicated high-volume stream rather than ordinary
timeline frames.

## GAP-008 — Workspace filesystem projection

**Owner:** Atlas substrate or the `coder` body, depending on the final workspace
model.

Filesystem browsing is absent by design. Atlas hides native
Read/Write/Edit/Glob/Grep tools and currently expects tool-mediated work.
Before adding endpoints, decide:

- Whether humans may browse files independently of the agent
- Which workspace roots are authorized
- Read versus mutation capability
- Symlink and traversal rules
- Binary and large-file handling
- Audit and redaction requirements

This is a product and security decision, not just missing routing.

## GAP-009 — Repository, Git, worktree, diff, and checkpoints

**Owner:** Atlas substrate for shared node execution, with coder-specific policy
in the deployment.

T3 owns these operations today. Warden contains checkpoint logic in the wrong
layer. Atlas has no canonical repository catalog, Git status, worktree,
checkpoint, diff, branch, commit, or pull-request surface.

Move the durable capability into Atlas and rebind the donor review UI. Do not
port Git execution into the React lens.

## GAP-010 — Application preview and automation

**Owner:** Atlas substrate for node execution; lens for rendering.

Atlas has no development-server discovery, preview lifecycle, browser host, URL
navigation, viewport control, annotation, or automation channel. Define the
node-side preview capability before preserving T3 preview orchestration.

## GAP-011 — Assets and large payloads

**Owner:** Atlas substrate.

Images, attachments, artifacts, large tool output, diffs, and terminal history
should not be forced through an unbounded JSON event feed. Atlas needs durable
asset identity, authorized retrieval, size limits, retention, and event
references.

## GAP-012 — Lifecycle, diagnostics, and observability

**Owner:** Atlas substrate; lens renders.

T3 exposes server lifecycle, process diagnostics, resource history, updates,
and trace diagnostics. Atlas has gossip vitals, `/_trace`, watchdogs, and
process-local logs but no unified browser contract. Define snapshots and events
without recreating T3 server management inside the lens.

## Dependency order

```text
GAP-001 transport/auth
    ↓
GAP-002 runtime publisher
    ↓
GAP-003 fleet catalog + GAP-004 run/workspace catalogs
    ↓
GAP-006 approvals
    ↓
GAP-007 terminal / GAP-008 files / GAP-009 Git / GAP-010 preview
```

GAP-005, GAP-011, and GAP-012 support multiple stages.
