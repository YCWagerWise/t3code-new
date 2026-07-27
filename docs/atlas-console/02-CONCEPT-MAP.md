# T3-to-Atlas concept map

T3 names remain useful when reading donor source. They are aliases, not the
Atlas product model.

| T3 concept and evidence                             | Atlas Console concept                                   | Atlas status                | Binding or gap                                                       |
| --------------------------------------------------- | ------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Environment — `ExecutionEnvironmentDescriptor`      | Fleet connection and selected Atlas node                | Partial                     | `/_members`, GAP-001, GAP-003                                        |
| Project — orchestration project and `workspaceRoot` | Workspace or repository known to a node                 | Absent                      | GAP-004                                                              |
| Thread — orchestration thread                       | Durable Atlas run or warm conversation                  | Partial                     | `/Agent/:id/status`, `/transcript`, GAP-002, GAP-004                 |
| Turn — orchestration turn                           | One input-to-quiescence cycle in an Atlas run           | Partial                     | `/say`, `/run`, GAP-002                                              |
| Provider                                            | Atlas execution backend                                 | Exists internally           | Backend selection exists inside `atlas-host`; enumeration is GAP-005 |
| Provider instance                                   | Backend availability on one node                        | Partial                     | Gossip manifest/vitals; GAP-005                                      |
| Model                                               | Model routable through an Atlas backend                 | Partial                     | `ATLAS_MODEL`; `/v1/models` is synthetic; GAP-005                    |
| Session                                             | Durable Agent isolate addressed by run/thread ID        | Exists                      | `AgentDO`, `/start`, `/say`, `/status`                               |
| Worktree                                            | Atlas-managed isolated workspace                        | Absent                      | GAP-009                                                              |
| Activity                                            | Atlas run event, tool event, agent edge, or fleet event | Partial internally          | Durable rows exist; publication is GAP-002                           |
| Message                                             | Role/content row in an Agent isolate                    | Exists                      | `/since`, `/transcript`                                              |
| Checkpoint                                          | Atlas-owned repository recovery point                   | Wrong layer                 | Warden checkpoint implementation; GAP-009                            |
| Turn diff                                           | Atlas-owned workspace changes for one turn              | Absent                      | GAP-009                                                              |
| Terminal                                            | Attach-capable shell session on an Atlas node           | Partial substrate           | Hearth and bash tools exist; GAP-007                                 |
| File browser                                        | Workspace filesystem projection                         | Absent by design            | GAP-008                                                              |
| Preview                                             | Application running on an Atlas node                    | Absent                      | GAP-010                                                              |
| Provider settings                                   | Bodies, backends, models, and node capabilities         | Partial                     | `/_members`, manifests, GAP-005                                      |
| Connection settings                                 | Atlas fleet endpoint and browser authorization          | Absent at application layer | GAP-001                                                              |
| Sidebar hierarchy                                   | Fleet → node → workspace → run                          | Partial                     | Nodes only through `/_members`; GAP-003, GAP-004                     |

## Identity rules

- A **node** is a live Atlas host participating in gossip.
- A **body** is a deployment plugin such as `coder`, `k8s-agent`, or
  `fliff-agent`.
- A **backend** executes model inference behind Atlas. Claude, Codex, and
  Ollama are backends, not peer products beside Atlas.
- A **run** is one durable Agent isolate.
- A **warm conversation** reuses a stable run/thread identity through `/say`.
- A **workspace** is the repository or operational context a body acts upon.
  Atlas does not currently expose it as a cataloged resource.

## One lens, many bodies

| Target        | Console interpretation     |
| ------------- | -------------------------- |
| `coder`       | Coding workspace           |
| `k8s-agent`   | Cluster operations console |
| `fliff-agent` | Betting desk               |
| Fleet         | Workforce and node console |

The lens changes its presentation and available actions based on body
capabilities. It does not acquire those capabilities itself.
