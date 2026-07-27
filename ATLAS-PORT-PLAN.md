# Atlas Console port plan

Fork: `git-forks/t3code`, donor upstream `pingdotgg/t3code`.

## Goal

Build Atlas Console as a visual lens over Atlas and its deployments, using the
T3 React application as donor UI.

Atlas is the body. The Console owns presentation only.

```text
Atlas Console
      ↕ authenticated Atlas snapshots, commands, and durable events
Atlas substrate and deployments
      ↕
nodes, bodies, backends, tools, workspaces, and runs
```

The target is not T3 Code with Atlas registered as another provider.

## Architectural rule

Run the Telegram test on every feature:

> If Telegram could not drive the same capability without implementing it,
> that capability belongs in Atlas rather than the lens.

| Capability                                      | Owner                      |
| ----------------------------------------------- | -------------------------- |
| Navigation, layout, search, display preferences | Console lens               |
| Event and snapshot rendering                    | Console lens               |
| Fleet and node knowledge                        | Atlas substrate            |
| Body, backend, and model availability           | Atlas substrate/deployment |
| Durable runs and turn execution                 | Atlas substrate            |
| Tool execution and policy                       | Atlas substrate            |
| Repository, Git, worktree, and checkpoints      | Atlas substrate            |
| Terminal and filesystem execution               | Atlas substrate            |
| Approval suspension, response, and audit        | Atlas substrate            |

## Current seam

Atlas currently exposes HTTP:

- `/start`, `/run`, `/say`
- `/output`, `/since`, `/transcript`, `/status`, `/spans`
- `/_members` and `/_presence` when gossip is enabled
- delivery, inbox, migration, trace, and compatibility routes

Verified useful path:

```text
POST /Agent/{run_id}/run
{"task":"...","plugin":"coder"}
→ final plain-text response
```

`plugin` is the one-lens-many-bodies selector.

This seam is suitable for one-shot commands and early integration. It is not a
complete interactive Console protocol: `/since` is poll-based assistant text,
tools flatten through `/transcript`, and Atlas publishes no structured live
run feed.

## Transport decision

Do not use ACP. Atlas is a networked body, and routing through a spawned
stdio proxy would place a shim over the real seam.

Use StudyOS as the transport donor:

- authenticated Axum WebSocket
- durable do-rs event channel
- append-only sequence
- replay from a cursor
- LISTEN/NOTIFY wake-up
- duplex read/write handles
- presence and heartbeat

Use Warden as the initial event and command vocabulary donor:

- user, thinking, assistant
- tool call/result
- approval, question, deny
- turn, context, usage, edge
- interrupt, approve, answer, mode, rewind, model, fork, resume, compact

Atlas adopts and owns the resulting versioned protocol. The Console does not
connect through Warden.

## Delivery oracle

Chase these outcomes in order:

1. Atlas can authenticate a browser and open a durable Console channel.
2. A Console command starts or continues a real Atlas run.
3. AgentDO publishes ordered run, message, and tool events with replay.
4. The React timeline renders those events without polling or duplication.
5. An approval suspends execution, appears in the Console, accepts one
   idempotent response, and resumes.
6. Fleet, workspace, and run catalogs populate Atlas-native navigation.
7. Terminal, files, Git/diff, and preview bind only after their Atlas
   capabilities exist.

The honest first vertical slice is:

```text
prompt
→ Atlas command acknowledgement
→ turn.started
→ assistant/tool events
→ turn.completed
→ reconnect and replay without duplicates
```

## Phases

### P0 — Documentation and donor classification

- Inventory every tracked non-test file in `apps/web/src`.
- Map T3 concepts and RPC methods to Atlas.
- Classify each donor file.
- Record every absent Atlas capability.

Output: `docs/atlas-console/`.

### P1 — Atlas Console protocol

- Port the StudyOS durable channel pattern into Atlas.
- Add `version`, `epoch`, `seq`, and server timestamp.
- Add fleet/node/body/workspace/run scope.
- Define structured commands, acknowledgements, and errors.
- Define replay boundary, stale-cursor snapshot fallback, payload limits, and
  slow-consumer behavior.
- Add focused transport and recovery tests.

### P2 — AgentDO publisher

- Publish turn lifecycle and message events.
- Publish tool calls and results from the existing ledger.
- Publish errors, context, usage, and delegation edges.
- Preserve REST snapshots and one-shot `/run`.
- Prove reconnect replay against a real run.

### P3 — Catalogs and navigation

- Make the fleet snapshot available for a solo node.
- Add bodies, backends, and real-model catalogs.
- Add workspace and run catalogs.
- Rebuild the sidebar around fleet → node → workspace → run.

### P4 — Supervision

- Enforce Atlas policy on the execution path.
- Persist pending approvals/questions.
- Publish requests to authorized lenses.
- Accept idempotent responses.
- Resume suspended execution and record the outcome.

### P5 — Workspace capabilities

In body-owned dependency order:

1. Hearth terminal attach surface
2. Repository, Git, worktree, diff, and checkpoint substrate
3. Filesystem product/security decision and API
4. Preview and browser-automation substrate
5. Asset handling for large output

Rebind donor panels only when their owner-side capability is real.

### P6 — Donor strip

Drive removal and migration from `03-classification.json`:

- Remove unsupported desktop/mobile/Clerk/T3 Connect paths.
- Remove non-Atlas provider orchestration.
- Remove duplicated T3 server capability after Atlas replacements pass.
- Consolidate Sidebar V1/V2.
- Retain reusable primitives and rendering components.

## Staged Rust path

Do not rewrite the T3 server wholesale before the Atlas contracts exist.

The transition is:

1. Prove Atlas protocol and publisher.
2. Bind the existing React client through a thin typed adapter.
3. Move body capability into Atlas one domain at a time.
4. Delete T3 server domains only after their Atlas oracle passes.
5. Reduce the final web-serving layer to static delivery, browser auth
   bootstrap, and lens concerns if those cannot be served directly by Atlas.

## Warden rename risk

Warden contains live paths, scripts, skills, and memory references. Renaming it
to `atlas-terminal` is independent of the Console protocol and must follow:

1. Rename crate and binary.
2. Preserve the old executable path with a temporary compatibility link.
3. Migrate live references.
4. Verify memory recall and fleet workflows.
5. Remove the compatibility link last.

Do not copy Warden capability into the Console while renaming it. Use Warden as
donor evidence and move shared capability into Atlas.

## Risks

- Treating working WebSocket transport as a working Atlas publisher
- Rebuilding body capability in the lens to make a panel appear functional
- Calling `/since` streaming even though it is cursor polling
- Presenting synthetic `/v1/models` output as real model availability
- Depending on `/_members` without handling a solo node
- Exposing filesystem or terminal access before browser authorization exists
- Stripping donor code before its Atlas replacement has an executable oracle
- Allowing historical ACP/provider language to re-enter the architecture

## Reference documents

- `docs/atlas-console/00-OVERVIEW.md`
- `docs/atlas-console/03-CLASSIFICATION.md`
- `docs/atlas-console/04-PROTOCOL-BINDING.md`
- `docs/atlas-console/05-GAPS.md`
- `atlas-rs/docs/ATLAS-ARCHITECTURE.md`
- `atlas/docs/ATLAS-SYSTEM-REFERENCE.md`
- `studyos-mcp/src/ws.rs`
- `studyos-mcp/src/session.rs`
- `warden/src/events.rs`
- `warden/src/runtime.rs`
