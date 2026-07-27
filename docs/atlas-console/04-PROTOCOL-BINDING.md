# T3-to-Atlas protocol binding

This document maps the donor client's typed protocol to Atlas. It separates
what exists now from the target Console protocol. A target binding is not an
implementation claim.

## Donor protocol

T3 uses Effect RPC over one WebSocket plus a typed HTTP API for authentication,
snapshots, and command dispatch. The current contract contains **73**
named WebSocket/RPC methods in `packages/contracts/src/rpc.ts` and the
orchestration method group.

Status terms:

- **exists:** Atlas serves the required semantics now.
- **partial:** a route exists but omits required shape, lifecycle, or streaming.
- **absent:** Atlas has no bindable surface.
- **lens-local:** this is a Console preference and should not become Atlas body
  state.
- **unsupported:** belongs to an upstream T3 product being removed.

## Current Atlas REST surface

| Binding                        | Current behavior                             | Limitation                                     |
| ------------------------------ | -------------------------------------------- | ---------------------------------------------- |
| `POST /Agent/:id/start`        | Seeds and starts a durable run               | No structured live events                      |
| `POST /Agent/:id/run`          | Drives a one-shot run and returns final text | Blocks until completion                        |
| `POST /Agent/:id/say`          | Continues a warm conversation                | Final reply only                               |
| `POST /Agent/:id/output`       | Reads final output                           | No lifecycle or activity                       |
| `POST /Agent/:id/since`        | Returns assistant messages after a cursor    | Polling; assistant text only                   |
| `POST /Agent/:id/transcript`   | Returns messages and tool ledger             | Flat unstructured text                         |
| `POST /Agent/:id/status`       | Reads run status                             | Not a subscription                             |
| `POST /Agent/:id/spans`        | Reads run spans                              | Run-local diagnostic data                      |
| `GET /_members`                | Fleet members, manifests, tools, vitals      | Mounted only with `ATLAS_PEERS`                |
| `POST /_presence`              | Gossip presence exchange                     | Not browser authentication/presence            |
| `GET /_trace/:trace_id`        | Cross-agent causal trace                     | Diagnostic, not timeline feed                  |
| `GET /v1/models`               | OpenAI-compatible model list                 | One synthetic `atlas` model                    |
| OpenAI/Anthropic/Ollama routes | Compatibility completion APIs                | “Streaming” completes before one emitted chunk |

## RPC binding matrix

| T3 method                                | Status      | Atlas binding today                     | Gap              |
| ---------------------------------------- | ----------- | --------------------------------------- | ---------------- |
| `projects.list`                          | absent      | —                                       | GAP-004          |
| `projects.add`                           | absent      | —                                       | GAP-004          |
| `projects.remove`                        | absent      | —                                       | GAP-004          |
| `projects.listEntries`                   | absent      | —                                       | GAP-008          |
| `projects.readFile`                      | absent      | —                                       | GAP-008          |
| `projects.searchEntries`                 | absent      | —                                       | GAP-008          |
| `projects.writeFile`                     | absent      | —                                       | GAP-008          |
| `shell.openInEditor`                     | absent      | —                                       | GAP-008          |
| `filesystem.browse`                      | absent      | —                                       | GAP-008          |
| `assets.createUrl`                       | absent      | —                                       | GAP-011          |
| `vcs.pull`                               | absent      | —                                       | GAP-009          |
| `vcs.refreshStatus`                      | absent      | —                                       | GAP-009          |
| `vcs.listRefs`                           | absent      | —                                       | GAP-009          |
| `vcs.createWorktree`                     | absent      | —                                       | GAP-009          |
| `vcs.removeWorktree`                     | absent      | —                                       | GAP-009          |
| `vcs.createRef`                          | absent      | —                                       | GAP-009          |
| `vcs.switchRef`                          | absent      | —                                       | GAP-009          |
| `vcs.init`                               | absent      | —                                       | GAP-009          |
| `git.runStackedAction`                   | absent      | —                                       | GAP-009          |
| `git.resolvePullRequest`                 | absent      | —                                       | GAP-009          |
| `git.preparePullRequestThread`           | absent      | —                                       | GAP-009          |
| `review.getDiffPreview`                  | absent      | —                                       | GAP-009          |
| `terminal.open`                          | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.attach`                        | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.write`                         | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.resize`                        | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.clear`                         | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.restart`                       | absent      | Hearth/tool-only substrate              | GAP-007          |
| `terminal.close`                         | absent      | Hearth/tool-only substrate              | GAP-007          |
| `preview.open`                           | absent      | —                                       | GAP-010          |
| `preview.navigate`                       | absent      | —                                       | GAP-010          |
| `preview.resize`                         | absent      | —                                       | GAP-010          |
| `preview.refresh`                        | absent      | —                                       | GAP-010          |
| `preview.close`                          | absent      | —                                       | GAP-010          |
| `preview.list`                           | absent      | —                                       | GAP-010          |
| `preview.reportStatus`                   | absent      | —                                       | GAP-010          |
| `previewAutomation.connect`              | absent      | —                                       | GAP-010          |
| `previewAutomation.respond`              | absent      | —                                       | GAP-010          |
| `previewAutomation.focusHost`            | absent      | —                                       | GAP-010          |
| `server.probe`                           | partial     | `GET /_members` when gossip enabled     | GAP-003          |
| `server.getConfig`                       | absent      | —                                       | GAP-012          |
| `server.refreshProviders`                | absent      | —                                       | GAP-012          |
| `server.updateProvider`                  | absent      | —                                       | GAP-012          |
| `server.updateServer`                    | absent      | —                                       | GAP-012          |
| `server.upsertKeybinding`                | absent      | —                                       | GAP-012          |
| `server.removeKeybinding`                | absent      | —                                       | GAP-012          |
| `server.getSettings`                     | absent      | —                                       | GAP-012          |
| `server.updateSettings`                  | absent      | —                                       | GAP-012          |
| `server.discoverSourceControl`           | absent      | —                                       | GAP-009          |
| `server.getTraceDiagnostics`             | absent      | —                                       | GAP-012          |
| `server.getProcessDiagnostics`           | absent      | —                                       | GAP-012          |
| `server.getProcessResourceHistory`       | absent      | —                                       | GAP-012          |
| `server.signalProcess`                   | absent      | —                                       | GAP-012          |
| `cloud.getRelayClientStatus`             | unsupported | T3 Connect product                      | —                |
| `cloud.installRelayClient`               | unsupported | T3 Connect product                      | —                |
| `sourceControl.lookupRepository`         | absent      | —                                       | GAP-009          |
| `sourceControl.cloneRepository`          | absent      | —                                       | GAP-009          |
| `sourceControl.publishRepository`        | absent      | —                                       | GAP-009          |
| `subscribeVcsStatus`                     | absent      | —                                       | GAP-009          |
| `subscribeTerminalEvents`                | absent      | Hearth/tool-only substrate              | GAP-007          |
| `subscribeTerminalMetadata`              | absent      | Hearth/tool-only substrate              | GAP-007          |
| `subscribePreviewEvents`                 | absent      | —                                       | GAP-010          |
| `subscribeDiscoveredLocalServers`        | absent      | —                                       | GAP-010          |
| `subscribeServerConfig`                  | partial     | gossip manifest snapshot; no stream     | GAP-003, GAP-005 |
| `subscribeServerLifecycle`               | partial     | gossip polling; no stream               | GAP-003, GAP-012 |
| `subscribeAuthAccess`                    | absent      | —                                       | GAP-001          |
| `orchestration.dispatchCommand`          | partial     | `POST /Agent/:id/start`, `/say`, `/run` | GAP-002, GAP-006 |
| `orchestration.getTurnDiff`              | absent      | —                                       | GAP-009          |
| `orchestration.getFullThreadDiff`        | absent      | —                                       | GAP-009          |
| `orchestration.replayEvents`             | partial     | `/since`, `/transcript`                 | GAP-002          |
| `orchestration.getArchivedShellSnapshot` | partial     | `/status`, `/transcript`                | GAP-002, GAP-004 |
| `orchestration.subscribeShell`           | partial     | `/status`, `/transcript`                | GAP-002, GAP-004 |
| `orchestration.subscribeThread`          | partial     | `POST /Agent/:id/since`                 | GAP-002          |

## Target Console transport

> **STATUS: DESIGN ONLY — NOT IMPLEMENTED IN ATLAS.**

### Donor decision

Use the StudyOS durable channel as the transport donor:

- Axum WebSocket route
- verified JWT subject and owner check
- one do-rs isolate per channel
- append-only event log
- reconnect catch-up from `after`
- LISTEN/NOTIFY live wake-up
- separate read and write handles
- durable presence
- heartbeat

Use Warden as the initial domain-vocabulary donor:

- user, thinking, assistant
- tool call and result
- deny, approval, question
- turn lifecycle
- context and usage
- agent/fleet edge
- client commands for interrupt, approve, answer, mode, rewind, model, fork,
  resume, and compact

Atlas owns the resulting contract. The Console must not connect through Warden.

### Endpoint

Proposed namespace:

```text
GET /console/ws?access_token=<short-lived-token>&after=<seq>&epoch=<epoch>
```

The path is intentionally Atlas-owned and separate from do-host's currently
unused generic upgrade behavior.

### Server event envelope

```json
{
  "version": 1,
  "epoch": "feed-lifetime-id",
  "seq": 42,
  "ts": 1785100000000,
  "node_id": "seraphim",
  "body_id": "coder",
  "workspace_id": "atlas-rs",
  "run_id": "thr-123",
  "turn_id": "turn-9",
  "kind": "tool.started",
  "payload": {}
}
```

Required properties:

- `version` supports schema evolution.
- `epoch + seq` form the resume and deduplication cursor.
- `ts` is stamped when Atlas persists the event, never at browser receipt.
- Scope IDs permit one connection to multiplex fleet and run subscriptions.
- Large payloads use asset references rather than unbounded inline JSON.

### Client command envelope

```json
{
  "version": 1,
  "request_id": "req-123",
  "kind": "turn.start",
  "target": {
    "node_id": "seraphim",
    "body_id": "coder",
    "workspace_id": "atlas-rs",
    "run_id": "thr-123"
  },
  "payload": {
    "text": "Implement the change"
  }
}
```

Commands require an acknowledgement or structured error keyed by
`request_id`.

### Required event vocabulary

| Atlas event                                              | Donor UI consumer                               |
| -------------------------------------------------------- | ----------------------------------------------- |
| `connection.ready`                                       | Connection gate and status dot                  |
| `fleet.snapshot`, `fleet.updated`                        | Sidebar and node views                          |
| `catalog.updated`                                        | Bodies, backends, model picker                  |
| `workspace.snapshot`                                     | Project/workspace navigation                    |
| `run.snapshot`, `run.updated`                            | Thread/run rows and header                      |
| `turn.started`, `turn.completed`, `turn.interrupted`     | Composer busy/stop state                        |
| `message.user`                                           | User timeline row and optimistic reconciliation |
| `message.assistant.delta`, `message.assistant.completed` | Streaming assistant row                         |
| `thinking.delta`                                         | Progress/reasoning activity                     |
| `tool.started`, `tool.completed`                         | Tool activity cards                             |
| `approval.requested`, `approval.resolved`                | Approval panel                                  |
| `question.requested`, `question.resolved`                | User-input panel                                |
| `context.updated`, `usage.updated`                       | Context and cost meters                         |
| `edge.created`                                           | Agent delegation/fleet activity                 |
| `run.error`                                              | Thread error banner                             |
| `asset.created`                                          | Images, artifacts, and large outputs            |

### Required client commands

- `fleet.subscribe`
- `workspace.subscribe`
- `run.subscribe`
- `run.create`
- `turn.start`
- `turn.interrupt`
- `approval.respond`
- `question.respond`
- `model.select`
- `mode.select`
- `history.request`
- `cursor.ack`
- `ping`

### Resume behavior

1. Cache only server-stamped events.
2. Reconnect with `epoch` and the highest contiguous `seq`.
3. Replay events after that cursor.
4. Send an explicit replay boundary before live delivery.
5. If the epoch changed or the backlog no longer covers the cursor, send a
   fresh scoped snapshot.
6. Deduplicate by `epoch + seq`.
7. Preserve old visible history as local history when an epoch is invalidated,
   matching Warden's proven behavior.

## Unbindable families

Until their gaps close, these surfaces cannot be honestly marked implemented:

- Fleet/workspace/run navigation
- Rich tool timeline
- Approvals and questions
- Real model selection
- Terminal
- Files and assets
- Git, worktrees, diffs, and checkpoints
- Preview and browser automation
- Atlas lifecycle and diagnostics
