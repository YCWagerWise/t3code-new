//! Frontend event-shape adaptation (#403).
//!
//! The T3 wire vocabulary and nothing else: how a typed SDK [`Lifecycle`] fact
//! becomes the `(event type, payload)` pairs this product's client reducer
//! speaks, plus the small summary/labelling helpers those payloads need.
//!
//! Deliberately holds NO runtime authority. Sequence allocation, durable
//! record-then-publish ordering, the terminal-event guarantee, and — since
//! #376/#403 — the turn-checkpoint TRIGGER all live in `agent-sdk-shell`.
//! `T3Vocab` supplies strings and JSON shapes; it cannot decide whether an
//! event happens or when a snapshot is taken. That is what makes this a
//! legitimate module under the five-repo charter rather than runtime
//! authority relocated into a new product file — the split codex warned about.
//!
//! The turn projector is assembled in `server_main` next to the checkpoint
//! substrate it needs. This module owns vocabulary only.

use super::*;

/// The terminal a running tool can be watched in, if any.
///
/// The agent's shell tools all run in the ONE shared workspace PTY, and
/// [`terminal::AGENT_TERMINAL_ID`] is the id a client attaches to for it. Naming
/// it on the activity row is what lets a UI open the live screen for a command
/// that is still running, instead of hard-coding the id or waiting for the tool
/// to finish (#182).
pub(super) fn attachable_terminal(tool: &str) -> Value {
    match tool {
        "run_bash" | "send_keys" | "interrupt_shell" | "read_screen" | "read_job" => json!({
            "terminalId": terminal::AGENT_TERMINAL_ID,
            "attachable": true,
        }),
        _ => Value::Null,
    }
}

/// A one-line summary of a tool call for the activity row.
///
/// The contract requires a NON-EMPTY summary, and a user reading "run_bash"
/// learns nothing — the command is the information, so it leads when there is
/// one. Truncated because this is a row label, not the output pane.
/// Classify a tool approval the way the frontend does.
///
/// `session-logic.ts` only builds a `PendingApproval` when the activity payload
/// carries a `requestKind` of `command` / `file-read` / `file-change` (or a
/// `requestType` it can map to one). An approval activity without it is
/// silently dropped by the UI, so this mapping is part of the contract, not a
/// nicety.
pub(super) fn approval_request_kind(tool: &str) -> &'static str {
    let t = tool.to_ascii_lowercase();
    if t.contains("write") || t.contains("edit") || t.contains("patch") || t.contains("apply") {
        "file-change"
    } else if t.contains("read") || t.contains("cat") || t.contains("view") {
        "file-read"
    } else {
        // bash/exec/anything else that runs: the conservative classification is
        // the one that shows the user a command prompt.
        "command"
    }
}

/// A one-line summary for a user-input prompt. `summary` is a
/// `TrimmedNonEmptyString` in the contract, so an empty prompt gets a real
/// sentence rather than failing the client's decode.
pub(super) fn prompt_summary(prompt: &str) -> String {
    let t = prompt.trim();
    if t.is_empty() {
        "The agent is waiting for your input".to_string()
    } else {
        truncate(t, 120)
    }
}

pub(super) fn tool_summary(tool: &str, args: &Value) -> String {
    let detail = args
        .get("command")
        .or_else(|| args.get("cmd"))
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str));
    match detail {
        Some(d) if !d.trim().is_empty() => format!("{tool}: {}", truncate(d.trim(), 120)),
        _ => tool.to_string(),
    }
}

/// The result row's label. Never empty (the contract refuses that), and never
/// the whole output.
pub(super) fn tool_result_summary(output: &Value) -> String {
    let text = match output {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.is_empty() {
        "finished".to_string()
    } else {
        truncate(line, 120)
    }
}

pub(super) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

/// t3code's wire vocabulary (#308/#313). Owns ONLY the reducer-contract names
/// and payload shapes — the durable sequence, the event envelope, and the
/// record-then-publish ordering all live in the SDK's [`VocabProjector`]. A
/// second product on this SDK writes its own [`ThreadEventVocab`]; it cannot
/// re-derive the invariants incorrectly because they are not here.
pub(super) struct T3Vocab;

impl ThreadEventVocab for T3Vocab {
    fn project(&self, event: &Lifecycle, now: &str) -> (String, Vec<(String, Value)>) {
        project_items(event, now)
    }
}

/// The t3code projector: SDK's durable envelope + record-then-publish, plus
/// this product's wire vocabulary.
pub(super) type T3Projector = VocabProjector<T3Vocab>;

pub(super) fn t3_projector(rt: ThreadRuntime) -> T3Projector {
    VocabProjector::new(rt, T3Vocab)
}

/// The PURE half of the projection: one lifecycle event in, the wire events it
/// becomes out.
///
/// Split out from `project` so the event NAMES this backend puts on the wire can
/// be checked against `packages/contracts` directly (#305/#306). Those two
/// blockers were invented event types — `thread.approval-requested` and
/// `thread.user-input-requested` — that no reducer had a case for, so the
/// prompts never reached the UI and the turn merely looked hung. A backend-only
/// JSON assertion cannot catch that class of bug, because the backend agrees
/// with itself; only comparing against the contract can.
/// The ONE `OrchestrationThreadActivity` a parked approval becomes.
///
/// Used by the live projection AND by the `subscribeThread` reconnect snapshot,
/// because they must produce the identical row (#311). The snapshot used to
/// hand-roll a flat `{kind, threadId, requestId, toolName, input, createdAt}`
/// object: no `id`, no `tone`, no `summary`, no `turnId`, and the routing fields
/// at the top level instead of inside `payload`. That either fails the snapshot
/// decode or drops the approval on reload — the user reconnects to a parked turn
/// with nothing to answer, which is the exact defect hydrating from the durable
/// store was supposed to remove.
///
/// `turn_id` is `None` for a snapshot row: the reconnect knows which turn is
/// active from `session.activeTurnId`, and inventing one here would attach the
/// approval to a turn it did not belong to.
pub(super) fn approval_requested_activity(
    session_id: &str,
    turn: i64,
    call_id: &str,
    tool: &str,
    args: &Value,
    turn_id: Option<&str>,
    created_at: &str,
) -> Value {
    // The requestId encodes session/turn/callId so the answer — which arrives on
    // a different request, maybe after a reconnect — carries its own routing (#69).
    let request_id = format!("{session_id}|{turn}|{call_id}");
    json!({
        // Stable id: the answer replaces this row rather than appending a
        // second one beneath it.
        "id": format!("approval:{request_id}"),
        "tone": "approval",
        "kind": "approval.requested",
        "summary": format!("{tool} needs approval"),
        "payload": {
            "requestId": request_id,
            // `requestKind` is REQUIRED, not decoration: the web client only
            // builds a PendingApproval when it can classify the request
            // (`session-logic.ts` `pendingApprovalsFromActivities`), so an
            // activity without it renders as nothing at all.
            "requestKind": approval_request_kind(tool),
            "toolName": tool,
            "input": args,
        },
        "turnId": turn_id,
        "createdAt": created_at,
    })
}

pub(super) fn project_items(event: &Lifecycle, now: &str) -> (String, Vec<(String, Value)>) {
    let now = now.to_string();
    let now = now.as_str();
    {
        let (thread_id, items): (String, Vec<(&str, Value)>) = match event {
            Lifecycle::TurnStarted { thread_id, turn_id } => (
                thread_id.clone(),
                vec![("thread.session-set", json!({ "threadId": thread_id, "session": {
                    "threadId": thread_id, "status": "running", "providerName": null,
                    "activeTurnId": turn_id, "lastError": null, "updatedAt": now } }))],
            ),
            Lifecycle::Delta { thread_id, turn_id, message_id, text } => (
                thread_id.clone(),
                vec![("thread.message-sent", json!({ "threadId": thread_id, "messageId": message_id,
                    "role": "assistant", "text": text, "turnId": turn_id, "streaming": true,
                    "createdAt": now, "updatedAt": now }))],
            ),
            Lifecycle::MessageFinal { thread_id, turn_id, message_id, text } => (
                thread_id.clone(),
                vec![("thread.message-sent", json!({ "threadId": thread_id, "messageId": message_id,
                    "role": "assistant", "text": text, "turnId": turn_id, "streaming": false,
                    "createdAt": now, "updatedAt": now }))],
            ),
            // A parked approval becomes a visible activity AND flips the
            // thread's pending flag. The requestId encodes session/turn/callId
            // so the answer — which arrives on a different request, maybe after
            // a reconnect — carries its own routing (#69).
            // A parked approval reaches the client through the events the
            // CONTRACT defines (#305/#307), not invented ones.
            //
            // `thread.approval-requested` was not in `OrchestrationEventType` at
            // all, so the real reducer fell through its forward-compatible
            // default and returned `unchanged` — the prompt never appeared, and
            // the turn looked hung. `thread.approval-response-requested` is NOT
            // the same event in the other direction: its payload carries a
            // `decision`, i.e. a human ANSWERING. The agent ASKING is an
            // activity, and the contract has an `approval` tone for exactly
            // this. The pending flag lives on the THREAD SHELL
            // (`OrchestrationThreadShell.hasPendingApprovals`), never inside a
            // `thread.session-set` payload the reducer ignores.
            Lifecycle::ApprovalRequested {
                thread_id, turn_id, session_id, turn, call_id, tool, args,
            } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": approval_requested_activity(
                        session_id, *turn, call_id, tool, args, Some(turn_id), now,
                    ),
                }))],
            ),
            Lifecycle::UserInputRequested { thread_id, turn_id, session_id, prompt, questions } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("user-input:{session_id}"),
                        "tone": "approval",
                        "kind": "user-input.requested",
                        "summary": prompt_summary(prompt),
                        "payload": {
                            "requestId": session_id,
                            "prompt": prompt,
                            // Forwarded verbatim when the provider supplied
                            // structure: the answer widget needs the options,
                            // and prose alone would make a multiple-choice ask
                            // render as a free-text box. Absent stays absent —
                            // an invented single option would send its label
                            // back as the user's answer.
                            "questions": questions,
                        },
                        "turnId": turn_id,
                        "createdAt": now,
                    },
                }))],
            ),
            Lifecycle::ApprovalResolved { thread_id, request_id, decision, allowed } => {
                let decision =
                    if decision.is_empty() { if *allowed { "accept" } else { "decline" } } else { decision };
                (
                    thread_id.clone(),
                    vec![("thread.activity-appended", json!({
                        "threadId": thread_id,
                        "activity": {
                            "id": format!("approval:{request_id}"),
                            "tone": "approval",
                            "kind": "approval.resolved",
                            "summary": format!("Approval {decision}"),
                            "payload": { "requestId": request_id, "decision": decision },
                            "createdAt": now,
                        },
                    }))],
                )
            }
            Lifecycle::ApprovalFailed { thread_id, request_id, detail } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("approval:{request_id}"),
                        "tone": "error",
                        "kind": "approval.requested",
                        "summary": detail,
                        "payload": { "requestId": request_id, "error": detail },
                        "createdAt": now,
                    },
                }))],
            ),
            Lifecycle::UserInputResolved { thread_id, session_id } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("user-input:{session_id}"),
                        "tone": "approval",
                        "kind": "user-input.resolved",
                        "summary": "Answer sent",
                        "payload": { "requestId": session_id },
                        "createdAt": now,
                    },
                }))],
            ),
            Lifecycle::UserInputFailed { thread_id, session_id, detail } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("user-input:{session_id}"),
                        "tone": "error",
                        "kind": "user-input.requested",
                        "summary": detail,
                        "payload": { "requestId": session_id, "error": detail },
                        "createdAt": now,
                    },
                }))],
            ),
            // Tool work becomes a durable ACTIVITY row: the thing a user can
            // see running, click into, and pair with its result. `id` is the
            // ledger's call id, so the completion updates the same row instead
            // of appending a second one.
            // A shell command the MODEL ran, with where it ran (#261/#337).
            // The activity carries the terminal only when there is one to
            // carry: a `Session` command is mountable and cancellable, a
            // `ProviderInternal` one ran inside the provider's process and has
            // no pane — offering an attach button for it would open nothing.
            Lifecycle::ShellCommand { thread_id, turn_id, call } => {
                let terminal = match &call.site {
                    agent_sdk_shell::ShellSite::Session { session_id } => json!({
                        "terminalId": session_id, "attachable": true,
                    }),
                    agent_sdk_shell::ShellSite::ProviderInternal => Value::Null,
                };
                (
                    thread_id.clone(),
                    vec![("thread.activity-appended", json!({
                        "threadId": thread_id,
                        "activity": {
                            "id": format!("shell:{}", call.call_id.clone().unwrap_or_else(
                                || format!("{turn_id}:{}", call.command))),
                            "tone": "tool",
                            "kind": "shell.command",
                            "summary": call.trace_line(),
                            "payload": {
                                "command": call.command,
                                "callId": call.call_id,
                                "succeeded": call.succeeded,
                                "terminal": terminal,
                            },
                            "turnId": turn_id,
                            "createdAt": now,
                        },
                    }))],
                )
            }
            Lifecycle::ToolStarted { thread_id, turn_id, call_id, tool, args } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("tool:{call_id}"),
                        "tone": "tool",
                        "kind": "tool.started",
                        "summary": tool_summary(tool, args),
                        "payload": {
                            "callId": call_id,
                            "toolName": tool,
                            "input": args,
                            // A shell tool is WATCHABLE while it runs, so the row
                            // carries the pane to attach to. Waiting for
                            // completion to learn the handle is useless: the
                            // whole workflow is watching and cancelling a command
                            // mid-flight (#182).
                            "terminal": attachable_terminal(tool),
                        },
                        "turnId": turn_id,
                        "createdAt": now,
                    },
                }))],
            ),
            Lifecycle::ToolCompleted { thread_id, turn_id, call_id, output } => (
                thread_id.clone(),
                vec![("thread.activity-appended", json!({
                    "threadId": thread_id,
                    "activity": {
                        // The SAME row id as the start: the client reducer
                        // replaces an activity whose id it already has, so the
                        // running row becomes the finished row. A separate
                        // `:done` id appended a second row and left the first
                        // one spinning forever (#136).
                        "id": format!("tool:{call_id}"),
                        "tone": "tool",
                        "kind": "tool.completed",
                        "summary": tool_result_summary(output),
                        "payload": { "callId": call_id, "output": output },
                        "turnId": turn_id,
                        "createdAt": now,
                    },
                }))],
            ),
            Lifecycle::TurnEnded { thread_id, outcome, .. } => {
                let last_error = match outcome {
                    TurnOutcome::Failed { message } => json!(message),
                    _ => Value::Null,
                };
                (thread_id.clone(), vec![("thread.session-set", json!({ "threadId": thread_id, "session": {
                    "threadId": thread_id, "status": "idle", "providerName": null,
                    "activeTurnId": null, "lastError": last_error, "updatedAt": now } }))])
            }
        };
        (thread_id, items.into_iter().map(|(t, p)| (t.to_string(), p)).collect())
    }
}
