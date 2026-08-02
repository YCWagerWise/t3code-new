# Atlas Console — consolidated reference

**One document over the whole `docs/atlas-console/` set.** It folds the twelve numbered
files (`00`–`11`) into a single readable spine and states the _current, verified_ status of the
code, not the snapshot each file was written against. The numbered docs remain in place as
detailed backing material; where a section here summarises a dense normative spec, it cites the
original for the full text. The machine-readable disposition lives in
[`03-classification.json`](./03-classification.json) and is not reproduced here.

> **Status note (verified 2026-08-01).** Docs `10` and `11` predate a governance-kernel wiring
> pass and a shared-ingestion fix pass. This document reflects the working tree as audited:
> GAP-002 is closed; the `status`-drop and `runtime.error` MISROUTED bugs are fixed;
> `approval`/`deny`/`edge` are wired end to end and `interrupt`/`approve` are enforced. Individual
> sections flag what changed. Line-number citations from `10`/`11` had drifted 40–150 lines and
> are given here by symbol/behaviour rather than line.

## Source hierarchy

When this document disagrees with implementation, trust in this order:

1. Current Atlas, StudyOS, Warden, and T3 source
2. `atlas-rs/docs/ATLAS-ARCHITECTURE.md`
3. `atlas/docs/ATLAS-SYSTEM-REFERENCE.md`
4. This document, then the numbered docs it consolidates
5. Historical plans (`ATLAS-PORT-PLAN.md` is a delivery plan, not a protocol spec)

These documents are migration inputs. They do not claim the target protocol or the absent body
capabilities are implemented except where a section explicitly says "verified".

---

# 1 — What Atlas Console is _(from 00)_

Atlas Console is a **React lens over Atlas and its deployments**. It uses the T3 Code web client
as donor UI, but Atlas is the product, runtime, and source of truth.

```
T3 React interaction patterns  +  Atlas-owned capabilities and protocol  =  Atlas Console
```

It is **not** "T3 Code + Atlas as one more provider." The current fork still registers Atlas via
`ProviderDriverKind.make("atlas")` beside other T3 providers; that is a transitional
implementation detail, not the target product model.

## Body and lens

`atlas-rs/docs/ATLAS-ARCHITECTURE.md` gives the governing rule:

- Atlas plus its deployments are the **body**.
- A human-facing view is a **lens**. A lens renders, observes, and sends intent.
- A lens owns no capability another Atlas lens or deployment would need.

Telegram is lens one. Warden is lens two. Atlas Console is lens three — "Telegram with a much
better screen."

**The Telegram test.** For any proposed feature, ask whether a pure Telegram window could drive
the same body capability. If not, the capability is misplaced in the lens and must move into
Atlas.

| Belongs to the lens    | Belongs to Atlas                          |
| ---------------------- | ----------------------------------------- |
| Rendering a diff       | Computing and storing the diff            |
| Drawing a terminal     | Owning the PTY                            |
| Displaying an approval | Enforcing and suspending on that approval |

## One lens, many bodies

| Target        | Console interpretation     |
| ------------- | -------------------------- |
| `coder`       | Coding workspace           |
| `k8s-agent`   | Cluster operations console |
| `fliff-agent` | Betting desk               |
| Fleet         | Workforce and node console |

The body supplies the domain; the lens adapts navigation and controls to advertised
capabilities. It does not acquire those capabilities itself.

## Ownership split

**The React lens owns:** navigation and information hierarchy; layout and responsive behaviour;
display preferences; draft input before submission; rendering Atlas snapshots and events;
optimistic feedback reconciled against server events; search/filter/command discovery;
accessibility and keyboard behaviour; local panel arrangement. It does **not** own durable
runtime truth.

**Atlas owns:** durable runs and conversations; agent coordination and delegation; body/backend
execution; node and fleet discovery; body/backend/real-model availability; workspace and
repository operations; worktrees, Git state, diffs, checkpoints; shell and terminal sessions;
filesystem authorization; tool execution; policy, approvals, questions; ordered streaming events
and recovery; assets, traces, and lifecycle state.

Several of these have no Console-bindable Atlas surface yet — see §5, the gap registry.

## Product hierarchy

```
Fleet
└── Node
    ├── Body and backend capabilities
    └── Workspace
        └── Run
            └── Turn
                ├── Messages
                ├── Tool activity
                ├── Approvals and questions
                └── Resulting workspace state
```

Fleet and node exist partially today. Workspace catalogs, run catalogs, rich events, approvals,
and workspace panels are capability gaps.

## Current technical truth

Atlas currently exposes poll-oriented HTTP: `/start`, `/run`, `/say`; `/output`, `/since`,
`/transcript`, `/status`, `/spans`; `/_members` and `/_presence` (only with gossip enabled);
plus internal delivery/migration/trace/compat routes. A functional Console **WebSocket** protocol
now exists on the feed (`/_feed`, auth-gated) — see §8, verified live — but the broader
fleet control-plane WS (`/console/ws`, §6) remains design-only.

StudyOS supplies the preferred durable transport donor; Warden supplies the preferred initial
event/command vocabulary. Atlas must adopt and own the result, then publish its runtime lifecycle
into it.

---

# 2 — T3 → Atlas concept map _(from 02)_

T3 names remain useful when reading donor source. They are aliases, not the Atlas product model.

| T3 concept (evidence)                            | Atlas Console concept                  | Atlas status        | Binding / gap                                  |
| ------------------------------------------------ | -------------------------------------- | ------------------- | ---------------------------------------------- |
| Environment — `ExecutionEnvironmentDescriptor`   | Fleet connection + selected node       | Partial             | `/_members`, GAP-001, GAP-003                  |
| Project — orchestration project, `workspaceRoot` | Workspace/repository on a node         | Absent              | GAP-004                                        |
| Thread — orchestration thread                    | Durable run or warm conversation       | Partial             | `/status`, `/transcript`, GAP-002, GAP-004     |
| Turn — orchestration turn                        | One input-to-quiescence cycle          | Partial             | `/say`, `/run`, GAP-002                        |
| Provider                                         | Atlas execution backend                | Exists internally   | selection in `atlas-host`; enum is GAP-005     |
| Provider instance                                | Backend availability on one node       | Partial             | gossip manifest/vitals; GAP-005                |
| Model                                            | Model routable through a backend       | Partial             | `ATLAS_MODEL`; `/v1/models` synthetic; GAP-005 |
| Session                                          | Durable Agent isolate by run/thread ID | Exists              | `AgentDO`, `/start`, `/say`, `/status`         |
| Worktree                                         | Atlas-managed isolated workspace       | Absent              | GAP-009                                        |
| Activity                                         | Run/tool/edge/fleet event              | Partial internally  | rows exist; publication GAP-002                |
| Message                                          | Role/content row in an isolate         | Exists              | `/since`, `/transcript`                        |
| Checkpoint                                       | Atlas-owned recovery point             | Wrong layer         | Warden impl; GAP-009                           |
| Turn diff                                        | Atlas-owned per-turn changes           | Absent              | GAP-009                                        |
| Terminal                                         | Attach-capable shell on a node         | Partial substrate   | Hearth + bash tools; GAP-007                   |
| File browser                                     | Workspace filesystem projection        | Absent by design    | GAP-008                                        |
| Preview                                          | App running on a node                  | Absent              | GAP-010                                        |
| Provider settings                                | Bodies/backends/models/capabilities    | Partial             | `/_members`, manifests, GAP-005                |
| Connection settings                              | Fleet endpoint + browser auth          | Absent at app layer | GAP-001                                        |
| Sidebar hierarchy                                | Fleet → node → workspace → run         | Partial             | nodes via `/_members`; GAP-003, GAP-004        |

**Identity rules.** A **node** is a live Atlas host in gossip. A **body** is a deployment plugin
(`coder`, `k8s-agent`, `fliff-agent`). A **backend** executes model inference behind Atlas
(Claude, Codex, Ollama are backends, not peer products). A **run** is one durable Agent isolate.
A **warm conversation** reuses a stable run identity through `/say`. A **workspace** is the
repository/operational context a body acts upon (not yet a cataloged Atlas resource).

---

# 3 — Donor UI: inventory and disposition _(from 01 + 03)_

A reproducible index of **every non-test file under `apps/web/src`** in the fork, generated from
`git ls-files`, with a single disposition each. Full behavioural docs live under `docs/ui/`;
the authoritative per-row data (with `area`, `level`, `atlasBinding`, `gapId`) is
[`03-classification.json`](./03-classification.json).

**Total: 432 files, ~102,000 lines.**

## The six verdicts

| Verdict              | Meaning                                                           | Files |  Lines |
| -------------------- | ----------------------------------------------------------------- | ----: | -----: |
| `remove-unsupported` | Delete: belongs to an upstream T3 product this fork does not ship |    49 |  7,246 |
| `remove-duplicate`   | Delete: Atlas already owns the capability                         |    15 |  3,051 |
| `redesign`           | Shape must change — the Atlas concept differs                     |    68 | 21,140 |
| `rebind`             | Same interface, data source swapped to Atlas                      |   216 | 55,388 |
| `restyle`            | Visual/terminology only                                           |     5 |  1,766 |
| `reuse`              | Take as-is; no Atlas concept, no data binding                     |    79 | 13,423 |

**Port shape, read off the table:** ~10,300 lines delete outright; ~15,200 survive
untouched/nearly so; **~76,500 lines are the actual work** (rebind + redesign) — and almost none
can start before Atlas grows the routes in §5.

**Two auditability rules** hold across all rows: every `remove-*` cites the Atlas route that
already owns the capability or the specific upstream product it belongs to; every
`rebind`/`redesign` names an `atlasBinding` that exists **or** a `gapId` — never both absent
(69 rows carry both). Only five bindings are in use today: `/_members`, `/_trace`, `/say`,
`/since`, `/status`.

**Component levels:** `route` (URL surface) · `workspace` (large persistent region) · `feature`
(coherent interaction) · `primitive` (reusable control) · `internal` (state/wiring). Distribution:
route 38, feature 148, primitive 54, workspace 144, internal 48.

## Where each verdict concentrates

- **`reuse` → primitives.** All 44 `components/ui/*` (shadcn-style set: `sidebar`, `toast`,
  `combobox`, `menu`, `command`, `select`, `dialog`, …), most `hooks` (`useTheme`, `useSettings`,
  `useLocalStorage`, …), framework utilities (`uiStateStore`, `lruCache`, `storage`, `utils`),
  presentational (`Icons`, `JetBrainsIcons`), and right-panel tabbing. Keybindings/local prefs
  are correctly lens-owned.
- **`rebind` → the functional workspaces** (the bulk). Composer (`ChatComposer`,
  `composerDraftStore`, `ComposerPromptEditor` → `/say`); activity timeline (`ChatView` at 6,053
  lines — the largest file — `MessagesTimeline`, `session-logic` → `/since`, GAP-002); all of
  `components/preview` (36 files, GAP-010) and `components/files` (11 files, GAP-008); source
  control / diff / review (GAP-009); terminal (GAP-007); markdown/assets (GAP-011); atom wiring
  and thread actions (GAP-002); diagnostics (`/_trace`, GAP-012).
- **`redesign` → structural concept changes.** Sidebar family (adds fleet→workspace→run tier,
  GAP-004); Connections→fleet page (GAP-003); model picker ("which body on which node", GAP-005);
  settings hierarchy (GAP-003); environment→fleet membership (GAP-003); auth/pairing (GAP-001);
  route shape `/:environmentId/:threadId` → fleet/workspace/run (GAP-004).
- **`remove-unsupported` → donor-only platform features.** All `cloud/*` and `components/cloud/*`
  (T3 Connect relay, superseded by tailnet addressing); `components/clerk/*` (SaaS identity);
  desktop/WSL/SSH state and dialogs; Electron/hosted-webview browser path; the provider-update
  notification cluster (Atlas nodes update by deploy, not by console).
- **`remove-duplicate` → capability Atlas already owns.** Provider-instance CRUD and client-side
  provider/model catalogue (Atlas discovers backends/models from gossip); client-side run
  recovery/history (Atlas runs are durable isolates); the local HTTP shim.
- **`restyle` → tiny.** `index.css`, branding modules, color-selector, favicon.

## Notable rulings (design weight)

- Atlas has **no auth on `:3010`** at all; T3's one-time pairing-token flow is the closest donor,
  but the target is an Atlas-owned scheme (GAP-001).
- **Git awareness is in the wrong layer** — absent from `atlas-host`; `warden/src/checkpoint.rs`
  has it (GAP-009). _(Update: a new `AtlasVcsDriver` + `/_vcs` mount is now emerging — see §8/§10.)_
- **Filesystem access is deliberately disallowed** (`NATIVE_DISALLOWED_TOOLS`); GAP-008 is a
  product/security decision, not just missing routing.
- **Approvals are kernel-without-round-trip in the donor's view** — Atlas had `policy.rs`
  `Verdict::Confirm`/`Trust` but no HTTP human round-trip. _(Update: now wired — §7/§10.)_
- A **`ctx` frame existed in Warden** (`pane.rs`) but not Atlas when this was written.
  _(Update: Atlas now publishes `ctx` — §10.)_

---

# 4 — Protocol binding _(from 04)_

T3 uses Effect RPC over one WebSocket plus a typed HTTP API. The contract contains **73** named
WebSocket/RPC methods (`packages/contracts/src/rpc.ts` + the orchestration group).

**Status terms:** _exists_ (Atlas serves the semantics now) · _partial_ (a route exists but omits
shape/lifecycle/streaming) · _absent_ (no bindable surface) · _lens-local_ (a Console preference,
must not become body state) · _unsupported_ (belongs to a removed upstream product).

## Current Atlas REST surface

| Binding                        | Behaviour                               | Limitation                             |
| ------------------------------ | --------------------------------------- | -------------------------------------- |
| `POST /Agent/:id/start`        | Seeds and starts a durable run          | No structured live events              |
| `POST /Agent/:id/run`          | One-shot run, returns final text        | Blocks until completion                |
| `POST /Agent/:id/say`          | Continues a warm conversation           | Final reply only                       |
| `POST /Agent/:id/output`       | Reads final output                      | No lifecycle/activity                  |
| `POST /Agent/:id/since`        | Assistant messages after a cursor       | Polling; assistant text only           |
| `POST /Agent/:id/transcript`   | Messages + tool ledger                  | Flat unstructured text                 |
| `POST /Agent/:id/status`       | Run status                              | Not a subscription                     |
| `POST /Agent/:id/spans`        | Run spans                               | Run-local diagnostics                  |
| `GET /_members`                | Fleet members, manifests, tools, vitals | Mounted only with `ATLAS_PEERS`        |
| `POST /_presence`              | Gossip presence exchange                | Not browser auth/presence              |
| `GET /_trace/:trace_id`        | Cross-agent causal trace                | Diagnostic, not a feed                 |
| `GET /v1/models`               | OpenAI-compatible model list            | One synthetic `atlas` model            |
| OpenAI/Anthropic/Ollama routes | Compatibility completion APIs           | "Streaming" completes before one chunk |

## RPC binding matrix (73 methods)

All rows are `absent` unless noted; the Gap column names the blocker.

| Family         | Methods                                                                                                                                                                                                                                                                    | Status                         | Gap              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------- |
| Projects       | `projects.list/add/remove`                                                                                                                                                                                                                                                 | absent                         | GAP-004          |
| Files          | `projects.{listEntries,readFile,searchEntries,writeFile}`, `shell.openInEditor`, `filesystem.browse`                                                                                                                                                                       | absent                         | GAP-008          |
| Assets         | `assets.createUrl`                                                                                                                                                                                                                                                         | absent                         | GAP-011          |
| VCS            | `vcs.{pull,refreshStatus,listRefs,createWorktree,removeWorktree,createRef,switchRef,init}`                                                                                                                                                                                 | absent                         | GAP-009          |
| Git            | `git.{runStackedAction,resolvePullRequest,preparePullRequestThread}`, `review.getDiffPreview`                                                                                                                                                                              | absent                         | GAP-009          |
| Terminal       | `terminal.{open,attach,write,resize,clear,restart,close}`                                                                                                                                                                                                                  | absent (Hearth/tool substrate) | GAP-007          |
| Preview        | `preview.{open,navigate,resize,refresh,close,list,reportStatus}`, `previewAutomation.{connect,respond,focusHost}`                                                                                                                                                          | absent                         | GAP-010          |
| Server         | `server.probe` (partial via `/_members`), `server.{getConfig,refreshProviders,updateProvider,updateServer,upsertKeybinding,removeKeybinding,getSettings,updateSettings,getTraceDiagnostics,getProcessDiagnostics,getProcessResourceHistory,signalProcess}`                 | partial / absent               | GAP-003, GAP-012 |
| Source control | `server.discoverSourceControl`, `sourceControl.{lookupRepository,cloneRepository,publishRepository}`, `subscribeVcsStatus`                                                                                                                                                 | absent                         | GAP-009          |
| Cloud          | `cloud.{getRelayClientStatus,installRelayClient}`                                                                                                                                                                                                                          | unsupported (T3 Connect)       | —                |
| Subscriptions  | `subscribe{TerminalEvents,TerminalMetadata}` (GAP-007), `subscribePreviewEvents`/`subscribeDiscoveredLocalServers` (GAP-010), `subscribeServerConfig` (partial, GAP-003/005), `subscribeServerLifecycle` (partial, GAP-003/012), `subscribeAuthAccess` (GAP-001)           | absent/partial                 | see cells        |
| Orchestration  | `dispatchCommand` (partial via `/start`,`/say`,`/run`; GAP-002/006), `getTurnDiff`/`getFullThreadDiff` (GAP-009), `replayEvents` (partial, GAP-002), `getArchivedShellSnapshot`/`subscribeShell` (partial, GAP-002/004), `subscribeThread` (partial via `/since`, GAP-002) | partial/absent                 | see cells        |

## Target Console transport _(design only — not implemented in Atlas beyond the `/_feed` slice)_

**Donor decision.** Transport = StudyOS durable channel (Axum WS route; verified JWT subject +
owner check; one do-rs isolate per channel; append-only log; reconnect catch-up from `after`;
LISTEN/NOTIFY wake; separate read/write handles; durable presence; heartbeat). Vocabulary =
Warden (user/thinking/assistant; tool call+result; deny/approval/question; turn lifecycle;
context/usage; agent-fleet edge; client commands interrupt/approve/answer/mode/rewind/model/
fork/resume/compact). **Atlas owns the resulting contract; the Console must not connect through
Warden.**

**Endpoint:** `GET /console/ws?access_token=<short-lived>&after=<seq>&epoch=<epoch>` — Atlas-owned,
separate from do-host's generic upgrade.

**Server event envelope** — `version`, `epoch`, `seq`, `ts` (stamped at Atlas persist, never at
browser receipt), `node_id`, `body_id`, `workspace_id`, `run_id`, `turn_id`, `kind`, `payload`.
`epoch + seq` is the resume/dedup cursor; large payloads use asset references.

**Client command envelope** — `version`, `request_id`, `kind`, `target{node/body/workspace/run}`,
`payload`. Commands require an ack or structured error keyed by `request_id`.

**Required event vocabulary → donor consumer:** `connection.ready` (gate/status dot);
`fleet.snapshot`/`fleet.updated` (sidebar/nodes); `catalog.updated` (bodies/backends/model
picker); `workspace.snapshot` (nav); `run.snapshot`/`run.updated` (rows/header);
`turn.started`/`completed`/`interrupted` (composer busy/stop); `message.user`;
`message.assistant.delta`/`completed`; `thinking.delta`; `tool.started`/`completed`;
`approval.requested`/`resolved`; `question.requested`/`resolved`; `context.updated`/`usage.updated`;
`edge.created`; `run.error`; `asset.created`.

**Required client commands:** `fleet.subscribe`, `workspace.subscribe`, `run.subscribe`,
`run.create`, `turn.start`, `turn.interrupt`, `approval.respond`, `question.respond`,
`model.select`, `mode.select`, `history.request`, `cursor.ack`, `ping`.

**Resume:** cache only server-stamped events; reconnect with `epoch` + highest contiguous `seq`;
replay after that cursor; send an explicit replay boundary before live delivery; on epoch change
or backlog gap, send a fresh scoped snapshot; dedup by `epoch + seq`; preserve invalidated
history as local history (Warden's proven behaviour).

**Unbindable families** (cannot be honestly marked implemented until their gaps close): fleet/
workspace/run navigation; rich tool timeline; approvals/questions; real model selection;
terminal; files/assets; Git/worktrees/diffs/checkpoints; preview/browser automation; Atlas
lifecycle/diagnostics.

---

# 5 — Capability gaps _(from 05)_

Capabilities Atlas must own before the matching donor surfaces can be faithfully rebound.
Ordering is architectural dependency order, not a delivery estimate.

| Gap         | Title                               | Owner                                    | Essence                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GAP-001** | Browser auth + transport adoption   | Atlas substrate (do-rs primitive)        | `:3010` relies on Tailscale/WireGuard; no browser app auth. Adopt StudyOS pattern (JWT, do-rs event isolate, `after` replay, duplex handles, LISTEN/NOTIFY, presence/heartbeat) with versioned envelope, origin policy, token lifecycle, bounded replay, slow-consumer behaviour, fleet/run authz.                                                                                             |
| **GAP-002** | Runtime event publisher             | Atlas substrate                          | AgentDO persists messages/tools but can't publish full lifecycle. Publish durable ordered events (run/turn lifecycle, user/assistant, thinking, tool start/complete, errors/interruption, context/usage, agent-fleet edges) using StudyOS append/replay + Warden `UiEvent` vocab; envelope adds `version/epoch/seq/ts/node/body/workspace/run/turn`. **✅ Substantially delivered — see §10.** |
| **GAP-003** | Fleet + node catalog                | Atlas substrate                          | `/_members` only with `ATLAS_PEERS`; solo node has no snapshot. Canonical API must always return ≥ self, publish membership changes, expose stable identity/health/capabilities/bodies/endpoints.                                                                                                                                                                                              |
| **GAP-004** | Workspace + run catalogs            | Atlas (runs) / body (workspace metadata) | Run isolates exist but no list API: can't enumerate workspaces, active/historical runs, warm conversations, titles/summaries, run↔workspace links, archive state. Sidebar can't rebind until cataloged.                                                                                                                                                                                        |
| **GAP-005** | Bodies/backends/agents/real models  | Atlas substrate + manifests              | `/v1/models` = one synthetic `atlas`. Need list/snapshot contracts for compiled bodies, agent specs, per-node backends, real routable models, capabilities/tool support, defaults/health. Console renders; never probes local CLIs.                                                                                                                                                            |
| **GAP-006** | Approval + question round-trip      | Atlas substrate                          | Kernel exists (`Verdict::{Allow,Deny,Confirm}`, `Trust::{ReadOnly,Ask,Auto}`) but needs enforcement on the tool path, durable pending request, publication, approve/deny/answer commands, idempotent resolution, timeout/disconnect behaviour, resumption, audit. **Approval side ✅ wired — question still open; see §7/§10.**                                                                |
| **GAP-007** | Attach-capable terminal             | Atlas substrate                          | Hearth is a real PTY + bash tools exist, but no list/open/attach/write/resize/interrupt/close/replay API. Needs a dedicated high-volume stream, not timeline frames.                                                                                                                                                                                                                           |
| **GAP-008** | Workspace filesystem projection     | Atlas or `coder` body                    | Absent by design (`NATIVE_DISALLOWED_TOOLS`). Decide browsing independent of the agent, authorized roots, read vs mutate, symlink/traversal rules, binary/large-file handling, audit/redaction — a product+security decision.                                                                                                                                                                  |
| **GAP-009** | Repo/Git/worktree/diff/checkpoints  | Atlas substrate + coder policy           | T3 owns these today; Warden has checkpoint logic in the wrong layer. Atlas has no canonical repo catalog, status, worktree, checkpoint, diff, branch, commit, or PR surface. Move durable capability into Atlas; rebind the review UI; don't port Git into React.                                                                                                                              |
| **GAP-010** | Application preview + automation    | Atlas (node exec) + lens (render)        | No dev-server discovery, preview lifecycle, browser host, navigation, viewport, annotation, or automation. Define the node-side capability first.                                                                                                                                                                                                                                              |
| **GAP-011** | Assets + large payloads             | Atlas substrate                          | Images/attachments/artifacts/large tool output/diffs/terminal history must not go through an unbounded JSON feed. Need durable asset identity, authorized retrieval, size limits, retention, event references.                                                                                                                                                                                 |
| **GAP-012** | Lifecycle/diagnostics/observability | Atlas substrate (lens renders)           | T3 exposes lifecycle/process diagnostics/resource history/updates/traces. Atlas has gossip vitals, `/_trace`, watchdogs, process-local logs but no unified browser contract. Define snapshots/events without recreating T3 server management in the lens.                                                                                                                                      |

**Dependency order:**

```
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

GAP-005, GAP-011, GAP-012 support multiple stages.

---

# 6 — Fleet control plane: the Turso multi-node connector _(from 06)_

> **Design spec. Not implemented beyond the `/_feed` slice.** Full DDL and endpoint detail are in
> [`06-TURSO-MULTINODE-CONNECTOR-PLAN.md`](./06-TURSO-MULTINODE-CONNECTOR-PLAN.md); this is the
> structure.

## Purpose and shape

Build **one Atlas fleet connector in T3** that discovers and controls multiple Atlas nodes
through an Atlas-owned, do-rs-supervised, Turso-backed control plane. Atlas/do-rs/Turso is the
authoritative coordination, lifecycle, checkpoint, and event substrate; nodes execute; the shared
web + Electron desktop shell render an authenticated projection and submit commands. This
replaces "one Atlas provider instance per node." Direct-node instances stay available during
migration and as a recovery path.

```
T3 web / Electron desktop
        │
Atlas fleet connector (apps/server)
        ├── Atlas control API / event gateway ──► Turso (catalog, leases, events, commands, receipts, audit)
        └── owning Atlas node (execution, tools, terminal, files, Git, preview)
```

T3 must **not** connect the browser directly to Turso. The server-side connector holds
control-plane credentials and exposes typed contracts. It stays a lens: it caches derived
projections but cannot originate, repair, or settle fleet lifecycle state.

## Authority boundary and compatibility mode

- **Fleet mode:** Atlas control-plane supervisors are the _only_ lifecycle writers. Turso holds
  durable commands, attempts, checkpoints, terminal outcomes, and epoch+seq events. T3 reconnects
  by snapshot+replay and never uses a local timeout or disconnect to settle a run. Losing T3's
  socket or stopping T3 leaves the Atlas run active until the supervisor records a terminal
  transition.
- **Direct-node mode:** T3 talks to one legacy node, normalizes its ephemeral feed, may use the
  existing local reaper. No durable fleet ownership, cross-node routing, checkpoint recovery, or
  authoritative replay. The mode must be carried explicitly in adapter, diagnostics, and UI. No
  direct-node fallback or T3 reaper may mutate a fleet run.

### Validated direct-node failure (the invariants that follow from it)

A tokenless `/_feed` connection returns `{ "class": "permission_error", "error": "unauthenticated" }`
and closes, while the ungated `/_members` probe succeeds and makes the provider card appear ready
— a false-positive readiness. Hence: (1) readiness must exercise the same authenticated
capability execution needs; (2) a transport failure before `turn.started` must still terminate
the start attempt with a visible structured error; (3) missing credentials → `setup-required`,
never `available`. Credential rollback removes only the Atlas secret/instance via the settings
service — never by deleting `settings.json`.

## Connector identity and config

Keep `driver: "atlas"`; add an explicit mode. No parallel connector registry.

```ts
type AtlasConnectorConfig =
  | {
      mode: "fleet";
      controlUrl: string;
      fleetId: string;
      defaultBody: string;
      requestTimeoutMs?: number;
    }
  | { mode: "direct-node"; baseUrl: string; plugin: string };
```

Secrets go through the existing provider-instance secret store: `ATLAS_FLEET_TOKEN`,
`ATLAS_WS_TOKEN` (legacy direct-node), optionally `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` only if
T3 must reach Turso directly. **Preferred:** T3 authenticates to an Atlas control API with
`ATLAS_FLEET_TOKEN`; only Atlas services hold Turso credentials. Persisted `settings.json` carries
redacted secret metadata only; logs/URLs/WS errors/telemetry never include tokens.

## Lifecycle states

`disabled` · `connecting` · `available` · `degraded` · `unauthorized` · `setup-required` ·
`incompatible` · `unreachable` · `stopped`. Reconnect: bounded exponential backoff with jitter;
auth/schema errors don't retry aggressively, network errors do; last confirmed snapshot preserved
and marked stale.

Startup handshake covers **execution** auth (authenticated readiness endpoint or a side-effect-free
authenticated feed handshake) — never inferred from an ungated catalog. Both an HTTP handshake and
a post-open WS `client.hello`/`server.hello` are required before any events/acks. An opened socket
is not readiness.

## Turso control-plane schema (all tables carry `fleet_id`)

- **Fleet/nodes:** `fleets`, `fleet_nodes`, `node_capabilities`, `node_bodies`, `node_models`.
  Nodes register idempotently and heartbeat; missing heartbeats move them healthy→stale→offline→
  retired; records retained, not hard-deleted.
- **Workspaces/runs:** `workspaces`, `workspace_nodes`, `runs`, `turns`, `run_attempts`,
  `run_checkpoints`. Terminal states: `completed`, `limited`, `failed`, `stalled`, `cancelled`.
  The five `limited` reasons are exactly `max_turn_requests`, `max_tokens`,
  `session_budget_exceeded`, `max_tool_calls`, `max_wall_time` — durable declared outcomes, not
  aliases for failure. Retry/resume allocate a new immutable attempt and retain the source.
  A checkpoint is resumable only when its record and `checkpoint.created` event commit atomically;
  it's immutable and carries an opaque encrypted reference, never secrets.
- **Ownership/commands:** `run_leases`, `run_commands`, `command_receipts`. One generation → one
  authoritative owner; every command names its expected generation; events accepted only from the
  fenced owner; request IDs make submission idempotent. An expired owner marks a run `orphaned`
  (ownership metadata, not a terminal state); live migration is out of scope; explicit
  resume/reassign creates a new generation + audit event. `run_children` records independently
  supervised children with the full state set and explicit parent-settlement policy.
- **Durable events:** `run_event_epochs`, `run_events` (identity `(fleet_id,run_id,epoch,seq)`),
  `consumer_cursors`. Transactional seq allocation; ordered replay after `epoch+seq`; dedup by
  identity; explicit replay boundary before live; snapshot fallback after invalidation/truncation;
  server-stamped timestamps; payload-size enforcement; no secrets in payloads. A normal restart
  continues the epoch; a new epoch only on compaction/restoration/repair. Initial event vocab:
  `fleet.*`, `catalog.updated`, `workspace.*`, `run.*`, `turn.*`, `message.*`, `thinking.delta`,
  `tool.*`, `checkpoint.*`, `attempt.*`, `child.*`, `run.error`, `edge.created`.
- **Supervision/audit:** `pending_requests`, `request_resolutions`, `audit_events`.

## Atlas control API (initial)

`GET /console/v1/handshake` · `/fleet` · `/catalog` · `/workspaces` · `/runs` · `/runs/:id` ·
`POST /console/v1/runs` · `/runs/:id/commands` · `/runs/:id/reassign` · `GET /console/v1/events` ·
`GET /console/ws`. Auth: short-lived token/signed session from the fleet credential; fleet+subject
claims; explicit read/execute/supervise/admin scopes; origin policy; redaction; rotation without
recreating the connector; audit for privileged commands. One redacted structured error envelope
(`code`, safe `message`, `retryable`, optional `requestId`, required `traceId`, bounded `details`)
with codes `unauthenticated`, `permission_denied`, `fleet_mismatch`, `protocol_incompatible`,
`invalid_request`, `not_found`, `conflict`, `stale_generation`, `cursor_epoch_invalid`,
`precondition_failed`, `rate_limited`, `temporarily_unavailable`, `internal`.

## T3 server implementation

Schema-only contracts (connector modes; fleet/node/catalog snapshots; workspace/run summaries;
ownership generation; cursor/envelopes; command/ack/errors; supervision requests/resolutions) —
no runtime logic in `packages/contracts`. Runtime modules: `AtlasFleetClient`, `AtlasFleetAuth`,
`AtlasFleetCatalog`, `AtlasFleetEventStream`, `AtlasFleetCommandRouter`, `AtlasFleetProjection`.
Split the driver by mode (direct-node retains `/_members`+Agent route+feed; fleet builds the fleet
client and exposes one instance for the whole fleet). Map Atlas events into the **existing**
canonical provider-runtime stream — no second UI event model. A selected model is not "available"
unless an eligible healthy node can execute it.

## Node-local capabilities (bind through the owning node, after ownership+routing prove out)

Terminal; authorized filesystem projection; repo/Git/worktree/diff/checkpoint; dev-server
discovery + preview lifecycle; browser navigation/viewport/annotation/automation; assets/large
payloads; node lifecycle/diagnostics/traces/updates. **Turso stores coordination/metadata only —
never PTY bytes, file contents, Git execution, or live browser frames.**

## Delivery phases

- **Phase 0 — freeze the authority contract.** Confirm Atlas owns the control API and only Atlas
  services get Turso credentials; finalize IDs, state machines, vocab, lease/checkpoint semantics,
  retention, scopes, errors, handshake, epoch rules, versioning; publish body-manifest rules for
  progress/checkpoints/stop reasons.
- **Phase 1 — Atlas-owned vertical slice** (before the typed T3 client). Schema+migrations;
  node registration/heartbeat/routing; one durable run supervisor (fenced delivery, observation
  validation, all five limit reasons, meaningful progress, child settlement, checkpoints,
  resume/retry history, deadline recovery); authenticated HTTP+post-open WS handshakes, structured
  errors, snapshots, epoch+seq replay, backpressure, cursor invalidation. **Exit:** without T3, one
  client can create/run a turn, exhaust a budget, restart the supervisor, recover a passed
  deadline, resume from a checkpoint, replay identical history, reject stale generations, observe
  child states.
- **Phase 2 — typed T3 server lens.** Connector-mode/snapshot/cursor/command/error schemas;
  fleet-mode settings + secret storage; typed client, handshake, projection, cursor persistence,
  reconnect/replace/shutdown; map events into canonical T3 without lifecycle authority; keep
  direct-node behaviour explicitly separate. **Exit:** T3 disconnects mid-turn without settling it,
  reconnects, rebuilds from snapshot/replay, renders Atlas's exact outcome.
- **Phase 3 — shared T3 UI.** Connector CRUD + secret rotation; fleet/workspace/run/attempt/
  child/checkpoint/budget/ownership/deadline/terminal projections; label direct-node guarantees
  separately; retry/resume/reassign/approval/question surfaces as endpoints land. **Exit:** the UI
  reconstructs entirely from Atlas after a clean restart and never presents cached T3 state as
  authoritative.
- **Phase 4 — node-local tools:** terminal, files, Git/diffs/checkpoints, preview/automation,
  assets, diagnostics — each with its own authz, routing, protocol, tests, rollout flag.

**First end-to-end milestone (15 steps):** create a fleet connector; restart T3 with secrets
intact/redacted; register two nodes in one Turso fleet; observe both heartbeats+catalogs;
register a workspace; create a run via the control API and render it; select an eligible owner and
acquire a fenced lease; submit an idempotent turn command; persist ordered user/assistant/tool/
completion events; disconnect+reconnect; replay identically without duplicates; stop the owner;
let the supervisor record owner-loss (T3 only renders); reject stale-generation events/commands;
explicitly reassign/resume on the second node. **Direct-node regression proof (6 steps):** no
token→`setup-required` (unselectable); rejected token→`unauthorized`; `/_members` success can't
override failed feed auth; feed `permission_error` before `turn.started` visibly terminates
startup; failed message stays retryable; secret correction/rotation hot-reloads without editing
other settings.

**Non-goals:** live migration of an executing turn; multiple authoritative writers; direct
browser→Turso credentials; terminal/browser streams or file/Git contents through Turso; auto-delete
of fleet history when removing a T3 connector; removing gossip before the durable registry works;
rewriting the T3 provider registry.

**Open Phase-0 decisions:** control-API topology + do-rs placement; retention durations + minimum
snapshot availability after compaction; checkpoint storage/encryption/size/compat policy; canonical
token accounting across providers; default budgets + safety ceilings + child grace + who may renew;
concrete auth mechanism + token lifetimes + rotation overlap + signing-key distribution + origin
policy + scope→role map; whether desktop secrets stay in `ServerSecretStore` or gain OS
credential-store integration.

---

# 7 — Run authority: the Agent Run Supervisor _(from 07)_

> **Normative design.** Resolves the lifecycle-ownership half of GAP-002 and refines §6. Full
> acceptance tests are in [`07-AGENT-RUN-AUTHORITY.md`](./07-AGENT-RUN-AUTHORITY.md).

**Decision.** For each Atlas thread, one control-plane **Agent Run Supervisor** is the sole
authority for the active run's lifecycle — a durable do-rs object keyed by `thread:<id>` storing
authoritative state in its Turso isolate. It owns one active `run_id` at a time; a new run can't
become active until the previous is terminal. A worker node holds a **fenced execution lease**,
not authority to change lifecycle state. T3 is an authenticated projection/control lens — not a
second supervisor, checkpoint store, or fallback log.

## Non-negotiable invariants

1. Only the supervisor appends authoritative lifecycle events / changes run state.
2. A worker reports observations and executes commands only for its current, unexpired lease
   generation.
3. T3/PostgREST/browser clients are read/propose surfaces — they never write run-state tables or
   infer terminal state from local timers.
4. Every command and observation is idempotent.
5. A terminal transition is durable before any best-effort side effect (stopping a feed/process).
6. An open transport is not liveness; only an accepted heartbeat refreshes a liveness deadline.
7. A parent isn't healthy because its transport is — each required child has independent liveness
   and progress deadlines.
8. Supervisor time is authoritative; browser/worker clocks are metadata.
9. Provider-declared execution limits are durable terminal outcomes; T3 must not translate them
   into failure/cancellation/inferred completion.
10. Checkpoints and attempt history are append-only; resume never rewrites a terminal attempt.

## Lifecycle and terminal vocabulary

```
queued → starting → running → waiting_for_input ⇄ running
  from {starting|running|waiting_for_input}:
    cancel → cancelling → cancelled
    limit reached → limited
    provider failure → failed
    heartbeat/progress deadline → stalled
    completion → completed
```

Terminal = `completed` · `limited` · `failed` · `stalled` · `cancelled`. `limited` is an explicit
non-error control-plane outcome (execution stopped at a declared resource boundary), distinct from
`stalled` (missed a durable deadline), `failed` (explicit error), `cancelled` (authorized
termination). Required closed `terminal_reason` vocab:

- **completed:** `turn_completed`, `provider_completed`
- **limited:** `max_turn_requests`, `max_tokens`, `session_budget_exceeded`, `max_tool_calls`,
  `max_wall_time`
- **stalled:** `startup_timeout`, `transport_heartbeat_timeout`, `progress_timeout`,
  `child_heartbeat_timeout`, `child_progress_timeout`, `delivery_timeout`
- **cancelled:** `cancelled_by_user`, `cancelled_by_supervisor`, `parent_cancelled`
- **failed:** `provider_error`, `harness_error`, `tool_error`, `checkpoint_invalid`,
  `protocol_violation`, `child_failed`

Provider detail goes in `terminal_detail.{code,message}`. `max_wall_time` is a
provider/harness-declared budget; a missed _supervision_ deadline stays `stalled(...)`.
`waiting_for_input` pauses progress timeouts and records its own request expiry — it must not look
like a silent run.

## Retry / resume / checkpoints

`run.retry` → new `run_id`+`attempt_id` (`retry_of_run_id`), replays the original intent from a
clean context. `run.resume` → new attempt (`resume_of_attempt_id`) from a supervisor-approved
durable checkpoint. Neither changes the prior attempt's state/events/usage/reason. `limited` is
resumable only when the limit is renewable and the checkpoint is compatible;
`session_budget_exceeded` needs the enclosing budget replenished/replaced or the API returns
`precondition_failed`. The thread timeline is an ordered union of immutable attempts; UIs may
group them but must show the boundary, terminal state/reason, budget usage, chosen checkpoint, and
causal link.

A checkpoint is recorded only after the provider reports all continuation state committed and names
the protocol/body/model versions that can restore it; publication + `checkpoint.created` commit
atomically; checkpoints are immutable (revocation appends `checkpoint.invalidated`); secrets never
enter payloads. Resume is compare-and-commit (verify ownership/authz/compat/integrity/retention/
terminal-state/budget; allocate new attempt+generation; record causal link; enqueue restoration in
one transaction). Effects after the last checkpoint may be unknown — the resume ack must surface
that and require explicit authorization when the manifest can't prove replay safety.

## Worker protocol (observations, never imperatives)

Workers report facts; they never send "set state to running/completed". Every observation carries
`fleet_id`, `thread_id`, `run_id`, `event_id`, `lease_generation`, monotonic `provider_seq`; the
supervisor stamps `recorded_at` and assigns the ordered sequence.

```ts
type AgentRunObservation =
  | { type: "provider.connected" }
  | { type: "heartbeat" }
  | { type: "progress"; phase: string; evidence: unknown }
  | { type: "checkpoint.committed"; checkpoint: unknown }
  | { type: "tool.started" | "tool.completed"; toolId: string }
  | {
      type: "child.started" | "child.progress" | "child.stopped";
      childRunId: string;
      stop?: StopReason;
    }
  | { type: "provider.stopped"; stop: StopReason };
// StopReason.kind ∈ completed | limited(reason,observed,limit,unit) | failed(providerCode,retryable) | cancelled
```

Atlas emits a heartbeat ≥ every 15s while a connection/child is active. Stop reasons are
observations, not mutations — the supervisor validates against lease/vocab/usage/state then appends
the authoritative transition. Unknown stop kind → `protocol_violation`; unknown provider code →
retained as detail under a known kind.

**Meaningful progress:** a heartbeat proves liveness, never progress. Progress = a durably accepted
observation advancing user-visible or execution state (committed assistant content, completed tool
result, checkpoint, entering/resolving a declared input wait, starting/settling a required child,
advancing a manifest phase with evidence). Socket traffic, repeated phase labels, keepalives, logs,
retries, duplicates do **not** refresh `last_progress_at`. The supervisor, not the worker, decides
whether an observation qualifies.

**Child runs:** each is independently supervised with the full state set + its own attempt/lease/
checkpoints/usage/deadlines/reason vocab. Required child `failed`→parent `failed(child_failed)`;
`stalled`→parent child-timeout reason (or `child_failed`); `limited`→parent `limited` with the
child's reason; `cancelled`→`cancelled(parent_cancelled)` only if the parent initiated it.
Optional child terminals are recorded but don't settle the parent. Parent cancellation durably
requests cancellation of nonterminal children and waits for the bounded settlement policy.

## Commands, deadlines, records

Commands: `run.start` · `run.cancel` · `run.retry` · `run.resume` · `input.resolve` — each with a
caller `request_id`; acceptance is idempotent; lifecycle events remain the source of truth. The
supervisor commits the transition + an outbox item in one operation; a delivery worker sends the
execution command to the fenced node and retries after a crash; a delivery failure is a supervisor
observation — it can't leave a run stuck in `starting`.

Deadline defaults (deployment config, not client settings):

| Condition                              | Default | Result                                    |
| -------------------------------------- | ------: | ----------------------------------------- |
| Start accepted, no provider connection |     30s | `stalled(startup_timeout)`                |
| Running, no heartbeat                  |     60s | `stalled(transport_heartbeat_timeout)`    |
| Running, no meaningful progress        |     10m | `stalled(progress_timeout)`               |
| Required child, no heartbeat           |     60s | parent `stalled(child_heartbeat_timeout)` |
| Required child, no progress            |     10m | parent `stalled(child_progress_timeout)`  |

Timeout handling is conservative: mark `stalled`, append evidence, issue best-effort detach/stop;
auto-retry is a later explicit policy (a tool-enabled turn may duplicate side effects). Provider
budgets are separate durable attempt values; Atlas may fence a worker exceeding a hard safety
ceiling using the same `limited` reason with `enforced_by: "supervisor"`.

Supervisor fields extend the §6 tables: `runs` gains `active_turn_id/active_attempt_id/state/
state_version/last_heartbeat_at/last_progress_at/deadline_at/terminal_*`; plus `run_attempts`,
`run_checkpoints`, `run_children`, `run_outbox`. Uniqueness enforced on `(run_id, event_id)`;
stale generations and non-monotonic sequences rejected.

**Epoch+seq replay:** every event has `(epoch, seq)`, contiguous+increasing within an epoch; a
normal restart continues the epoch; a new epoch only on compaction/restore/repair. Subscription =
authenticated snapshot boundary `{snapshotVersion, epoch, throughSeq}` → replay `throughSeq+1..N` →
live. Consumers ack only their highest contiguous cursor; dedup by `(fleet_id,run_id,epoch,seq)`.
`cursor_epoch_invalid` → discard the derived projection, hydrate the snapshot, continue from its
boundary; never merge across epochs.

**Auth protocol** mirrors §6 (HTTP handshake + post-open `client.hello`/`server.hello`; no
snapshot/event/ack/heartbeat before it succeeds; rejection → structured `connection.rejected` then
close; opening the socket is never readiness). Same `ControlPlaneError` code set as §6.

## T3 integration boundary

T3's Atlas fleet adapter **must**: create/attach a stable `run_id` per thread; forward commands via
the command API; persist run ID + event cursor + projection mapping; map replayed events into T3's
existing runtime events; render supervisor state/deadline/heartbeat/progress/child/terminal reason.
T3 **must not**: settle a fleet run via `provider_session_runtime`; decide `stalled` in React or a
Node timer; create a second lease; convert a lost local socket into a terminal Atlas failure
without Atlas confirming it. The existing `ProviderSessionReaper` stays local cleanup for
direct-node only — never the fleet watchdog.

**Recovery:** on restart, do-rs reloads the aggregate, retries due outbox items, recomputes the
next deadline from durable timestamps; a deadline passed during downtime is settled atomically on
recovery before later observations; no in-memory timer is needed and restart grants no extra time.

---

# 8 — Ground truth and order of work _(from 08, updated 2026-08-01)_

Written after sessions that drove real turns end to end. "Verified" = observed against a running
node or a real test run, not inferred.

## What already works (verified)

| Capability                      | Where                         | Evidence                                       |
| ------------------------------- | ----------------------------- | ---------------------------------------------- |
| Epoch+seq durable replay        | `feed.rs`                     | 4 cursor cases driven live (below)             |
| Auth fails closed on the feed   | `auth.rs`, `ws.rs`            | tokenless connect → `permission_error` + close |
| Transport heartbeat, observable | `ws.rs`                       | live at +23ms, +20s, +40s                      |
| Atlas → canonical event mapping | `AtlasAdapter.ts`             | large test suite; drives real turns            |
| Turn lifecycle in T3            | `ProviderRuntimeIngestion.ts` | tests + mutations                              |
| Model routing                   | `lib.rs` `named_backend_kind` | `gpt-oss:120b-cloud` answers in 6s             |

```
after=0            → 1:cmd 2:user 3:turn 4:assistant 5:turn   full history
after=3            → 4:assistant 5:turn                       exactly the gap
after=5            → (none)                                   idempotent reattach
after=3, bad epoch → full replay                              fails safe
```

End-to-end live: `cmd → user → turn:start → assistant → turn:done` in ~6s, rendered in a browser.
**Consequence:** durable events/cursors already live in `feed.rs`; auth in `auth.rs`; event mapping
in `AtlasAdapter.ts`. Extend those — a second event log or auth boundary is strictly worse.

## Not load-bearing yet

`run_supervisor.rs` and `control_plane.rs` are mounted (router merged, DO registered) but no real
run reports into them — `apply_observation()` has zero callers outside its own module. Tests pass
by driving the supervisor directly, which proves internal consistency, not supervision. `RunState`
is a third lifecycle vocabulary alongside `Kind::Turn{state}` and `runs.status` with nothing
translating between them. The state _design_ is right (`Limited` + five reasons, distinct from
`failed`/`stalled`/`cancelled`); it just isn't connected.

## Known defects (evidence)

| #   | Defect                                                                                                      | Status                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D1  | Readiness lies: `/_members` ungated, `/_feed` gated → "ready · 19 tools" while every turn dies at handshake | Phase 1 target                                                                                             |
| D2  | Cancel is a no-op — `interrupt` carried but not enforced                                                    | **✅ fixed** — `interrupt`→`cancel_run`→`Control::cancel`; `approve` consumed by `await_approval` (§7/§10) |
| D3  | Errors arrive as answers — `Driven::Done` publishes CLI error text as assistant + `turn:done`               | Phase 3 target                                                                                             |
| D4  | Lens decides Atlas terminal state — `socketLossEvents` emits `turn.aborted` on socket close                 | Phase 5 target                                                                                             |
| D5  | No boot reconciliation — restart mid-turn strands `running` forever                                         | addressed by boot-settle (recent commits)                                                                  |
| D6  | Successful tool calls never published (observer fires only on `ok=false`)                                   | **✅ fixed** — GAP-002 closed (§10)                                                                        |
| D7  | Stale-thread retry loop — untyped error retried every 250ms forever                                         | Phase 7 target                                                                                             |

## Order of work (rule: never build on a signal that doesn't exist yet)

1. **Make readiness honest (D1).** `wsToken` absent → `setup-required` not `ready`; readiness must
   exercise the authenticated path; rejection after socket open fails readiness; probing creates no
   durable run. _Exit:_ no-token → `setup-required`, bad-token → `unauthorized`, neither → `ready`.
2. **Connect the supervisor** (unblocks 06/07). `publish_outcome` already receives the
   authoritative outcome — report it to the supervisor. _Exit:_ one real driven turn produces a
   supervisor state transition.
3. **Terminal outcomes Atlas can declare (D3).** Distinguish "CLI exited 0 with error text" from
   "the model answered"; emit `Limited` with the five reasons as durable terminals.
4. **Cancellation (D2).** _(Now largely landed — enforced on the Atlas side.)_
5. **Lens stops deciding terminal state (D4).** Replace `turn.aborted`-on-socket-loss with a
   lens-local "disconnected/reconnecting" that never touches turn lifecycle.
6. **Watchdog (D5).** Transport deadline 60s (3 missed intervals), **armed only after the first
   heartbeat is seen** (six of seven fleet nodes run a build with no `hb` — a silent node means
   "cannot be supervised", never "dead"). Progress deadline was blocked on D6; **D6 is now done**,
   so the progress signal exists. Plus boot reconciliation.
7. **Stale-thread loop (D7).** Typed `thread_not_found`/`snapshot_failed`/`replay_failed` +
   bounded retry (250ms is correct for a materializing thread; the bug was one untyped error over
   four causes). Client cleanup only; never delete server data.
8. **Integrated authority proof** — the eleven-step acceptance run; passable only after 2, 4, 6.

**Standing rules:** extend, don't duplicate (`feed.rs` events, `auth.rs` identity,
`AtlasAdapter.ts` mapping — one of each); Atlas is authoritative for run state, T3 projects it
(lens may hold _connection_ state, never terminal state); wire changes are additive and ignorable
(the fleet is mixed-version — one peer's `null` manifest once broke the whole `/_members` decode);
verified means observed (passing tests around an unwired module prove nothing); mutation-test new
suites (revert the fix, the test must fail).

**Open decisions:** which of `feed.rs`/`runs.status`/`RunState` is canonical once the supervisor is
connected (and who maps between them); feed retention/truncation policy; whether
`waiting_for_input` becomes a first-class status; scope vocabulary + rotation in `auth.rs`;
cross-provider token accounting for `max_tokens`; whether desktop secrets move to OS credential
storage.

---

# 9 — Mapping protocol: how to connect anything new _(from 09, mapping table updated)_

Written because every failure had the same shape: **something knew, and didn't say.** Shutdown
knew a turn was dying; the socket knew it was refused; the supervisor knew it couldn't record;
Atlas knows when a tool succeeds. Each dropped the fact and the symptom surfaced far away as a
spinner.

## Who owns what (four layers)

| Layer                                            | Owns                         | Change cost                                     |
| ------------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| **Atlas feed** (`feed.rs` `Kind`)                | what happened in the run     | versioned wire, mixed-version fleet — expensive |
| **Atlas run state** (supervisor)                 | lifecycle, attempts, budgets | durable — name things once                      |
| **T3 canonical events** (`ProviderRuntimeEvent`) | provider-neutral vocabulary  | in-process types — free                         |
| **T3 projection + UI**                           | what the user sees           | free, but must not decide                       |

**Atlas is authoritative for the run; T3 projects it.** T3 may hold _connection_ state; never the
run's terminal state.

## The six questions (each has a wrong answer that already bit us)

1. **Does Atlas already know this fact?** If yes, **publish it** — never re-derive in T3.
   (`isClaudeInterruptedMessage` substring-matched an error to guess a semantic the provider knew
   exactly.)
2. **Is it about the RUN or the CONNECTION?** Run → a `Kind`, appended, replayable, carries
   `seq`/`epoch`/`role`. Connection → a transport frame, never persisted (`hb`, the auth-refusal
   `error`). Persisting liveness would let a replay assert the run was alive when nobody watched.
3. **Can it end a turn?** Only `turn{done}`, `turn{error}`, and a real cancellation may. Everything
   else — heartbeats especially — carries **no** `turnId`.
4. **Is it additive and ignorable?** An old node that never sends it looks healthy-but-quiet, never
   dead; an old lens drops it silently; **absence is not failure** (a watchdog arms only after
   seeing the signal once). Optional means `NullOr`, not `optional`.
5. **Which canonical event does it become?** Reuse an existing `ProviderRuntimeEvent` if one fits —
   that's what makes Atlas a peer of Claude/Codex, not a special case. Add a type only when the
   semantic genuinely doesn't exist (`session.heartbeat` didn't).
6. **Does anything downstream have to DECIDE?** If the UI or ingestion must infer, the mapping is
   incomplete — go back to Q1. (The diagnostics drawer computing `stalled` from React timestamps is
   the anti-pattern.)

## The mapping as it stands (verified 2026-08-01)

```
Atlas Kind        T3 canonical event                              status
──────────────────────────────────────────────────────────────────────────────
turn{start}   →   turn.started                                    ✅
turn{done}    →   turn.completed                                  ✅
turn{error}   →   turn.completed{state:failed, errorMessage}      ✅  (detail now backfilled from message)
assistant     →   item.started + content.delta + item.completed   ✅
thinking      →   content.delta{reasoning_text}                   ✅
tool_call     →   item.started                                    ✅  (GAP-002 — now published on success)
tool_result   →   item.completed (+ dead tool.summary)            ✅  (both edges; ok→status now mapped)
diff          →   turn.diff.updated (+ file_change rows)          ✅  (now mapped)
edge          →   task.started / task.completed                   ✅  (now mapped; fleet delegation)
approval      →   request.opened  (+ approve command back)        ✅  (now mapped + enforced, gated on ATLAS_CONFIRM)
deny          →   tool.denied                                     ✅  (now mapped)
ctx           →   thread.token-usage.updated                      ✅
error         →   runtime.error{class}                            ✅
hb            →   session.heartbeat  (transport, no turnId)       ✅
question      →   —                                               ⛔ still dropped (frame never emitted; UI panel exists)
usage         →   —                                               ⬜ unmapped (ledger/analytics only)
user / cmd    →   —                                               n/a (echo of console input)

console → agent: cmd · interrupt · approve · answer   (from_console() capability gate)
```

`from_console()` is a **capability boundary**, not a list: a lens with a valid token still cannot
forge a `tool_result` or raise its own `approval`.

## Worked examples

- **A new tool** — nothing to add; tools flow through `tool_call`/`tool_result` keyed by `call_id`.
- **A new connector/provider** — if it runs under Atlas it inherits the whole vocabulary and T3
  needs zero changes; only a genuinely new _kind_ of fact touches the wire.
- **A new terminal reason** (`max_tokens`, …) — Q3 says it can end a turn, so it arrives as
  `turn{error}` with the reason, mapping to `turn.completed{failed, errorMessage}`.
- **A new liveness/progress signal** — Q2: connection→transport frame; run→`Kind`. Progress is
  durable; liveness is not — which is why the heartbeat can back a transport deadline and must
  never back a progress deadline.

## Invariants

1. No layer swallows a fact it holds.
2. Bookkeeping never gates execution (a `supervisor_start` that blocked every turn violated this).
3. Atlas owns run state; T3 projects it — the lens holds connection state only.
4. Wire changes are additive and ignorable; absence is not failure.
5. Verified means observed — drive a real turn.
6. Extract the decision, then test it (`outboundDisposition` returned `"queue"` while the queue
   did not exist).

> **Short version:** does Atlas already know it? Then Atlas says it, once, on the feed — and T3
> renders what it's told. If T3 has to work it out, the mapping is wrong.

---

# 10 — Frame contract and capability inventory _(from 10 + 11, verified 2026-08-01)_

An inventory of T3 surfaces vs. what Atlas feeds, then a field-by-field wire contract. The rule the
contract enforces: **a field is implemented only when both its publisher line and its consumer line
can be cited.** A field can look plumbed (in a schema, emitted by an adapter, named in a doc) while
nothing on the far side reads it.

## What T3 persists per thread

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

`projection_turns` is a real per-turn row with `completed_at` + checkpoint columns — so "mark the
projected turn complete" was a genuine requirement (correcting an earlier claim in 08 that turn
state lived only in `session.activeTurnId`).

## Which provider feeds which surface (verified)

| Capability            | Event                             | Codex | Claude |         Others         | **Atlas**                                         |
| --------------------- | --------------------------------- | :---: | :----: | :--------------------: | :------------------------------------------------ |
| Successful tool calls | `item.*`                          |  ✅   |   ✅   |           ✅           | ✅ (GAP-002 done)                                 |
| Per-turn diff         | `turn.diff.updated`               |  ✅   |   —    |           —            | ✅ (mapped from `diff`)                           |
| Subagents             | `task.started/progress/completed` |   —   |   ✅   |           —            | ✅ (mapped from `edge`)                           |
| Approvals             | `request.opened/resolved`         |  ✅   |   ✅   |        OpenCode        | ✅ (mapped + enforced, `ATLAS_CONFIRM`)           |
| Tool denials          | `tool.denied`                     |   —   |   —    |           —            | ✅ (mapped from `deny`)                           |
| User questions        | `user-input.requested`            |  ✅   |   ✅   | Cursor, Grok, OpenCode | ❌ (`question` frame never emitted)               |
| Plan / todo list      | `turn.plan.updated`               |  ✅   |   ✅   |           —            | ❌                                                |
| Plan-mode proposal    | `turn.proposed.delta`             |  ✅   |   —    |           —            | ❌                                                |
| Files written         | `files.persisted`                 |   —   |   ✅   |           —            | ❌ (Atlas feeds `file_change` via `diff` instead) |
| Model reroute         | `model.rerouted`                  |  ✅   |   —    |           —            | ❌                                                |
| Hooks                 | `hook.started/progress/completed` |   —   |   ✅   |           —            | ❌                                                |

Atlas supplies turn boundaries, assistant text, reasoning, context pressure, errors, liveness — and
now the work itself, per-turn diffs, subagent edges, approvals, and denials. Still dark: user
questions, plans, plan-mode proposals, files-persisted, model reroute, hooks.

## The integrity consequence (why GAP-002 mattered)

Two models, same task:

```
qwen2.5-coder:14b   → "DONE"   file NOT created
gpt-oss:120b-cloud  → "DONE"   file created
feed for both:  user → turn:start → assistant "DONE" → turn:done     tool frames: 0 / 0
```

One did the work, one lied, and the feed was identical. Successful tool calls are the difference
between a record of what an agent did and an unverifiable claim.

**Closed.** The SDK observer now fires at both edges of every call, carrying `call_id` and `args`,
and atlas-host maps them to `tool_call`/`tool_result`:

```
tool_call    {tool:"run_bash", call_id:"toolu_01HRno…", args:{command:"echo gap002-proof"}}
tool_result  {call_id:"toolu_01HRno…", ok:true, duration_ms:98, summary:"…exit=0\ngap002-proof…"}
```

A model that answers "DONE" having run nothing now emits zero `tool_call` frames, and the two cases
are finally distinguishable. Cost less than expected: widen the observer to a `ToolEvent` and wrap
the one place a tool can run.

## Field-by-field wire contract

Statuses: `LIVE` (published, read, verified end to end) · `NO READER` (Atlas publishes, nothing in
T3 consumes) · `DEAD END` (a T3 consumer-shaped surface no path reaches) · `UNMAPPED` (Atlas
publishes nothing).

### Tool lifecycle

| Field                     | Atlas → T3 path                                                                                                                                        | Status                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `tool_call.call_id`       | observer `ToolPhase::Started` → the `itemId` key pairing start with end (`AtlasAdapter.ts` `tool_call`/`tool_result` arms, keyed on `payload.call_id`) | LIVE                                                                                                |
| `tool_call.tool`          | → `title` → activity `summary` column (`ProviderRuntimeIngestion.ts` `item.started`)                                                                   | LIVE                                                                                                |
| `tool_call.args`          | → `item.started.data.args` → `payload_json`                                                                                                            | LIVE to DB, **NO READER on screen** (no web renderer; `toolData` surfaced only for `mcp_tool_call`) |
| `tool_result.ok`          | `ToolPhase::Finished` → `status:"failed"` → the ✗ glyph                                                                                                | LIVE (now that `ok`→`status` is mapped)                                                             |
| `tool_result.summary`     | → `item.completed.detail` → `truncateDetail` (180) → inline preview, makes the row expandable                                                          | LIVE                                                                                                |
| `tool_result.duration_ms` | → `item.completed.data.durationMs`                                                                                                                     | LIVE to DB, **NO READER on screen**                                                                 |

**`tool.summary` is a dead event repo-wide.** Declared in `providerRuntime.ts`, emitted by exactly
two adapters (`AtlasAdapter.ts`, `ClaudeAdapter.ts`), consumed by nothing —
`runtimeEventToActivities` has no `case "tool.summary"`, so it falls to `default: break` → `[]`. The
richest field Atlas sends about a tool call is discarded; the correct carrier is `detail` on
`item.completed` (which does survive and render).

**`status` on `item.completed` — fixed.** `item.completed` ingestion now copies `status` (it used
to silently drop it while `item.updated` copied it), and `AtlasAdapter.ts` sets
`status: ok ? "completed" : "failed"`. The client's default-to-`"completed"`-when-absent path still
exists, so a provider that omits `status` still renders a check — but Atlas and OpenCode now set it,
so a failed call renders ✗. _(This was a live shared-path bug that made OpenCode tool failures show
a green check; the one-line additive fix has been applied.)_

### Turn and error

| Field                           | Path                                                                                                             | Status                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `turn.state` (start/done/error) | `atlas-host/src/lib.rs` → `AtlasAdapter.ts` `turn` arm                                                           | LIVE                                                                                  |
| `turn{state:"error"}.text`      | adapter writes `payload.message`; ingestion now backfills `detail` from `message`, and the client reads `detail` | LIVE (was **MISROUTED** — runtime failures rendered as a bare "Runtime error"; fixed) |
| `assistant.text`                | `lib.rs` → `assistant` arm                                                                                       | LIVE                                                                                  |
| `user.text`                     | no `case "user"` → `default: []`                                                                                 | NO READER (believed correct — T3 already holds the message it sent)                   |
| `hb`                            | `ws.rs` raw text frame → `hb` arm → `session.heartbeat`                                                          | LIVE                                                                                  |

### Context and usage

| Field                                           | Path                                                                                            | Status                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ctx.used`                                      | usage observer → `thread.token-usage.updated` → `context-window.updated` → `ContextWindowMeter` | LIVE                                                           |
| `ctx.window`                                    | same, from `context_window_for_model`                                                           | LIVE                                                           |
| `usage.{model,input,output,cache_*,usd,cached}` | usage observer → `record_spend` (`in_tok`/`out_tok`)                                            | NO READER (published for the ledger/analytics, not the screen) |

- **`used` is not `input_tokens`.** Under prompt caching `input_tokens` counts only the uncached
  remainder (`input_tokens: 2, cache_read: 18301 → used 18303/200000`). What occupies the window is
  everything the model was given, so `used = input + cache_read + cache_creation`. It grows across
  rounds because the loop reloads the whole transcript with no compaction (verified 18303→36872).
  Ingestion discards `usedTokens <= 0`, so publishing zeros == publishing nothing.
- **The window refuses to guess.** `context_window_for_model` returns `None` for an unknown id
  (unlike `Pricing::for_model`, which falls back to a mid tier) — a made-up denominator renders an
  authoritative-looking meter that's wrong. No window ⇒ no `ctx` frame. A decorator that fails to
  delegate `model_id`/`context_window` inherits `None` silently (shipped twice — `Backend` and
  `GatedModel`); pinned by `model_gate.rs` `the_gate_answers_for_its_backend_and_never_for_itself`.

### Governance kinds — now wired (was the load-bearing error in 11)

An earlier draft listed `approval`/`deny`/`edge`/`interrupt` as declared-but-unwired with "zero
callers". A governance-kernel pass changed that:

| Kind        | Atlas side                                                                                                                                                                      | T3 side                                                                                   | status                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------- |
| `approval`  | `Policy::decide` → `Verdict::Confirm` → `await_approval` **publishes `Kind::Approval`** and blocks on an `Approve` frame; wired into the tool gate (opt-in via `ATLAS_CONFIRM`) | `request.opened`; `ComposerPendingApprovalPanel`; `respondToRequest` sends `approve` back | **LIVE** (gated)              |
| `deny`      | `BUILTIN_DENY` (10 rules) via `Policy::new`; `Verdict::Deny` **publishes `Kind::Deny`**                                                                                         | `tool.denied`                                                                             | **LIVE**                      |
| `edge`      | `observe_edge` alongside `dtrace()`; `set_edge_observer` **publishes `Kind::Edge`**                                                                                             | `task.started`/`task.completed`                                                           | **LIVE**                      |
| `interrupt` | `Control::cancel` (`cancel.rs`) now has a caller (`ws.rs cancel_run`); checked at every Action boundary                                                                         | —                                                                                         | **enforced**                  |
| `question`  | never published (only an `AskUserQuestion` comment in `policy.rs`; claude.rs handles it inline)                                                                                 | `ComposerPendingUserInputPanel` complete                                                  | **body must be built**        |
| `thinking`  | discarded in the provider content loop (`_ => {}`); codex reasoning now surfaced as a `reasoning` stream item; `ModelResp` has no variant to carry it                           | `reasoning_text` deltas never persisted                                                   | both ends thin — lowest value |

Inbound `cmd`/`interrupt`/`approve`/`answer` are `from_console()` and correctly have no Atlas
publisher. `cmd`, `interrupt`, and `approve` are now enforced; only `answer` remains recorded and
ignored (it's the `question` round-trip's missing half).

### `supportsTools` — shipped into the contract

`ModelCapabilities` is now `{ optionDescriptors, supportsTools }` (`supportsTools` was added to
`packages/contracts/src/model.ts` as an optional three-valued boolean). `AtlasProvider` populates
it (`capabilities` is no longer unconditionally `null`) and still uses it as the primary sort key in
`modelsForMember` (tool-capable models float to the top). The earlier "residual" — that surfacing
tool-capability needed a new field on `ServerProviderModel` — is done at the contract + provider
layer.

## Build order, by what each unlocks

1. ~~`tool_call`/`tool_result` on success (GAP-002)~~ — **done.**
2. ~~Approvals (GAP-006)~~ — **approval side done and enforced.** Remaining: the `question`
   round-trip (`answer` inbound is still ignored; the Atlas `question` frame must be built).
3. **Per-turn checkpoints (GAP-009)** — the Diff dropdown's "Latest turn"/"Turn ▸". Needs a git
   surface Atlas lacked; `warden/src/checkpoint.rs` is the closest code. _(A new `AtlasVcsDriver` +
   `/_vcs` mount is now emerging — see §8; the runtime feed still carries no per-turn checkpoint
   scoping.)_
4. **Files persisted** — cheap once tool results land; a write tool result already knows the path.
5. ~~Subagent tasks~~ — **done** (`edge` → `task.*`).
6. **Plans, hooks, model reroute** — no Atlas concept yet; defer until something needs them.

## Two things worth stating plainly

- **Mostly this is not a T3 change** — but not entirely. Every surface here already renders for
  another provider, so the capability lives in Atlas. The GAP-002 pass found that a _mapped_ frame
  is not a _rendered_ one: three fields Atlas sent reached no reader, and two of those dead ends
  (`status` drop, `runtime.error` misroute) were shared-path bugs affecting every provider, not
  Atlas gaps. This section exists so the next capability can't repeat that — cite both the publisher
  and the consumer line.
- **`body_manifests()` under-reports.** `registry()` merges an always-on cluster fabric into every
  plugin, so `summarizer` advertises zero tools (its `has_tools()` gate reads the raw build) while
  its agent still receives `delegate`/`host_probe`. Any consumer trusting the manifest to decide
  what a body can do is wrong today.

---

## Appendix — where each numbered doc landed

| Doc                                 | Consolidated into                                |
| ----------------------------------- | ------------------------------------------------ |
| `00-OVERVIEW`                       | §1                                               |
| `01-UI-INVENTORY`                   | §3 (+ `03-classification.json` for per-row data) |
| `02-CONCEPT-MAP`                    | §2                                               |
| `03-CLASSIFICATION`                 | §3                                               |
| `04-PROTOCOL-BINDING`               | §4                                               |
| `05-GAPS`                           | §5                                               |
| `06-TURSO-MULTINODE-CONNECTOR-PLAN` | §6 (full DDL in the original)                    |
| `07-AGENT-RUN-AUTHORITY`            | §7 (full acceptance tests in the original)       |
| `08-EXECUTION-PLAN`                 | §8                                               |
| `09-MAPPING-PROTOCOL`               | §9                                               |
| `10-CAPABILITY-GAP`                 | §10                                              |
| `11-FRAME-CONTRACT`                 | §10                                              |
