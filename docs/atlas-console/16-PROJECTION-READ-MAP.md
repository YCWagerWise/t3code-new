# 16 — Projection read map (doc 15 §2.1 deliverable)

The port fuses THREE hops into one pure fold. There is **no `turn.started`/`item.*` in
`OrchestrationEvent`** — those are adapter vocabulary. Six domain members cover M1:

| `type`                        | covers                                                        | key payload                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `thread.message-sent`         | user + assistant text                                         | `{threadId, messageId, role, text, turnId, streaming, createdAt, updatedAt}` — reducer APPENDS text when `streaming:true`, finalizes on `false`  |
| `thread.session-set`          | ALL turn lifecycle                                            | `{threadId, session}`; `latestTurn` is DERIVED by the reducer from session status transitions                                                    |
| `thread.activity-appended`    | tools, approvals, questions, usage/ctx, errors, deny, warning | `{threadId, activity:{id, tone, kind, summary, payload, turnId, sequence?, createdAt}}` — client renders `payload.detail`; ALWAYS write `detail` |
| `thread.turn-diff-completed`  | diffs                                                         | `{threadId, turnId, checkpointTurnCount, checkpointRef, status, files, assistantMessageId, completedAt}`                                         |
| `thread.turn-start-requested` | client-originated start                                       | paired with the user message-sent                                                                                                                |
| `thread.meta-updated`         | title (optional M1)                                           |                                                                                                                                                  |

Every event carries required `EventBaseFields`: `{sequence, eventId, aggregateKind:"thread",
aggregateId, occurredAt, commandId:null, causationEventId:null, correlationId:null, metadata:{}}`.

## Invariants to port (each gets a mutation test)

1. **Sequence discipline** — ONE monotonic counter; snapshot's `snapshotSequence` == last
   emitted `sequence`, or the client drops everything (threads.ts:196-204 drops `<=`).
2. **Strict lifecycle guard** (ingestion :1377-1403) — a `turn done/cancelled` whose turnId ≠
   tracked activeTurnId is DROPPED; only defence against a stale frame closing a live turn.
3. **Turn-end finalize sweep** (:1687-1723) — every assistant messageId remembered for the
   turn flips `streaming:false` at turn end, else `latestTurn` never settles.
4. **Activity ids must be unique per activity** — the donor shares one eventId per frame;
   a diff frame's N file activities collide and N−1 vanish. Use `${frameId}:${index}`.
5. **tool_result carries `status`** — client defaults absent → "completed" (green check on
   failures). `ok:false → "failed"` must reach the activity payload.
6. **`ctx` gate** — `usedTokens <= 0` emits nothing.
7. **hb carries no turnId** — heartbeats must never gain the power to close turns.

## Frame → events (the fused arm table)

| frame            | emit                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`           | message-sent{role:user, streaming:false} (adapter had NO arm — synthesized new)                                                                                            |
| `assistant`      | message-sent{role:assistant, text, streaming:true} then finalize at turn end; messageId `assistant:${runId}:${seq}`                                                        |
| `thinking`       | activity{kind:"thinking", detail:text} (donor DROPPED thinking — new arm)                                                                                                  |
| `turn start`     | session-set{status:running, activeTurnId}                                                                                                                                  |
| `turn done`      | finalize sweep + session-set{status:ready, activeTurnId:null}                                                                                                              |
| `turn cancelled` | sweep + session-set{status:ready→interrupted derivation via lastError rules}                                                                                               |
| `turn error`     | activity{runtime.error} + sweep + session-set{status:error, lastError}                                                                                                     |
| `lifecycle`      | session-set only for states the turn arms don't already cover (else ignore)                                                                                                |
| `tool_call`      | activity{kind:tool.started, tone:tool, id `${frameId}`, payload.detail=tool name, data.args}                                                                               |
| `tool_result`    | activity{kind:tool.completed, status ok?completed:failed, detail=summary}                                                                                                  |
| `diff`           | turn-diff-completed{status:"ready", files mapped, checkpointRef `atlas:${checkpoint}`} + per-file activity ids `${frameId}:${i}`; carry `unified` in payload for the panel |
| `ctx`            | activity{kind:context-window.updated, payload {usedTokens, maxTokens}} (gate #6)                                                                                           |
| `usage`          | skip for M1 (no screen consumer; ledger later)                                                                                                                             |
| `approval`       | activity{kind:approval.requested, requestId, detail=reason}                                                                                                                |
| `question`       | activity{kind:user-input.requested, questions} (donor dropped — new arm)                                                                                                   |
| `deny`           | activity{kind:tool.denied, tone:error, detail=reason}                                                                                                                      |
| `warning`        | activity{kind:runtime.warning, detail}                                                                                                                                     |
| `error`          | activity{kind:runtime.error, detail} + (if turn active) session-set error                                                                                                  |
| `edge`, `hb`     | out of scope M1 / transport                                                                                                                                                |

## Explicitly OUT for M1

Plan mode/proposed plans, todos, git checkpoint reactor (client has no git — diff frames
become `ready` checkpoints directly), model.rerouted, buffered-assistant mode (ship
streaming-only; Atlas delivers whole answers), delegation task._ arms, compaction,
project._ + thread CRUD events, shell projection (separate surface, doc 15 §2.4).

## Minimal legal snapshot

`{snapshotSequence, thread: {id, projectId, title, modelSelection, runtimeMode:"full-access",
interactionMode:"default", branch:null, worktreePath:null, latestTurn:null, createdAt,
updatedAt, archivedAt:null, settledOverride:null, settledAt:null, deletedAt:null,
messages:[], proposedPlans:[], activities:[], checkpoints:[], session:null}}`.
Reuse `threadReducer.applyThreadDetailEvent` (already pure) — the port emits events; the
reducer folds. Substrate over shims: ONE folding authority, not two.
