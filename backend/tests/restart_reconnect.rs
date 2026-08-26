//! PROOF: a client that reconnects ACROSS a server restart resumes the same
//! durable thread — the backend keeps no stream state of its own.
//!
//! The SDK proves each piece in isolation (binding survives, cursor resumes,
//! sequence never rewinds, tail replays until acked). What is only provable
//! HERE is the composition the product actually ships in `server_main`: open
//! `ThreadRuntime` at the environment data dir under the id `"main"`, hand the
//! client a snapshot stamped with `current_sequence()`, and drive its live
//! stream off `tail()`. A reconnect is that same sequence of calls against the
//! same directory after the process died.
//!
//! The defect these pin down: any product-local memory of "where this client
//! was" — a per-process counter, an in-memory event buffer, a session map
//! rebuilt at boot. Each of those looks fine until the server restarts, and
//! then the client either re-renders events it already has or silently loses
//! the ones published while it was gone.

use agent_sdk_core::{ActionDesc, Message, Model, ModelOutput, ModelResp, Registry, Usage};
use agent_sdk_shell::{
    AgentDefinition, Lifecycle, ModelRef, SessionBinding, Shell, ThreadEventVocab, ThreadRuntime,
    TurnOutcome, VocabProjector,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

struct Talker;
#[async_trait::async_trait]
impl Model for Talker {
    async fn complete(
        &self,
        _m: &[Message],
        _t: &[ActionDesc],
        _i: Option<&str>,
    ) -> Result<ModelOutput, String> {
        Ok(ModelResp::Text { text: "hello there".into() }.into())
    }
    fn cost_usd(&self, _u: &Usage) -> f64 {
        0.0
    }
}

/// A private environment directory, removed when the test ends.
struct Env(std::path::PathBuf);
impl Env {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("t3-restart-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Env(dir)
    }
    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}
impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Boot the runtime exactly as `server_main` does: one shell over the
/// environment data dir, one `ThreadRuntime` under the id `"main"`.
async fn boot(data: &str) -> ThreadRuntime {
    let shell = Arc::new(
        Shell::new(std::path::Path::new(data), |_d| Registry::new())
            .with_model_factory(|| Box::new(Talker)),
    );
    ThreadRuntime::open(shell, data, "main").await.expect("open thread runtime")
}

fn definition() -> AgentDefinition {
    AgentDefinition {
        name: "t3".into(),
        instructions: "be brief".into(),
        model: ModelRef::ClaudeCli { model: "x".into() },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(), options: vec![], cwd: None,
    }
}

fn binding(thread: &str) -> SessionBinding {
    SessionBinding {
        thread_id: thread.into(),
        provider_instance_id: "claudeAgent".into(),
        model_key: "claude-haiku-4-5-20251001".into(),
    }
}

/// This suite's wire vocabulary — the ONE thing a product owns of the
/// projection path (#324).
///
/// The durable sequence, the envelope and the record-then-publish ordering are
/// the SDK's, in [`VocabProjector`], which is why this is a vocabulary and not
/// a projector. `T3Vocab` itself lives in the `t3code-server` binary's
/// `event_adapter` module and is not reachable from an integration test, so
/// this stands in for it; what is under test here is the SDK path both of them
/// run through, not the names.
struct RestartVocab;

impl ThreadEventVocab for RestartVocab {
    fn project(&self, event: &Lifecycle, _now: &str) -> (String, Vec<(String, Value)>) {
        let thread_id = match event {
            Lifecycle::TurnStarted { thread_id, .. }
            | Lifecycle::Delta { thread_id, .. }
            | Lifecycle::MessageFinal { thread_id, .. }
            | Lifecycle::ApprovalRequested { thread_id, .. }
            | Lifecycle::UserInputRequested { thread_id, .. }
            | Lifecycle::ApprovalResolved { thread_id, .. }
            | Lifecycle::ApprovalFailed { thread_id, .. }
            | Lifecycle::UserInputResolved { thread_id, .. }
            | Lifecycle::UserInputFailed { thread_id, .. }
            | Lifecycle::ToolStarted { thread_id, .. }
            | Lifecycle::ToolCompleted { thread_id, .. }
            | Lifecycle::ShellCommand { thread_id, .. }
            | Lifecycle::TurnEnded { thread_id, .. } => thread_id.clone(),
        };
        let items = match event {
            Lifecycle::Delta { text, .. } => {
                vec![("delta".to_string(), json!({"kind": "delta", "text": text}))]
            }
            Lifecycle::MessageFinal { message_id, text, .. } => vec![(
                "final".to_string(),
                json!({"kind": "final", "messageId": message_id, "text": text}),
            )],
            _ => vec![("lifecycle".to_string(), json!({"kind": "lifecycle"}))],
        };
        (thread_id, items)
    }
}

/// The projector the product runs a turn through.
///
/// This used to be a `BusProjector`, which published without recording and
/// without allocating a sequence — so every lifecycle fact this suite produced
/// was unreplayable, in the suite whose entire job is proving replay after
/// reconnect. It passed because the turn tests assert on the transcript and the
/// cursor and never asked whether a projected event could be replayed (#324).
fn projector(rt: &ThreadRuntime) -> VocabProjector<RestartVocab> {
    VocabProjector::new(rt.clone(), RestartVocab)
}

fn thread_row(id: &str) -> Value {
    json!({
        "id": id,
        "projectId": "p-workspace",
        "title": "restart",
        "modelSelection": null,
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    })
}

/// Emit one numbered thread event the way the product's projector does:
/// allocate a durable sequence, RECORD it (so a reconnect can catch up on it),
/// then publish it to live subscribers. Returns the sequence.
async fn emit(rt: &ThreadRuntime, thread_id: &str) -> i64 {
    let seq = rt.next_sequence().await.unwrap();
    let item = json!({ "kind": "event", "event": { "sequence": seq, "aggregateId": thread_id } });
    rt.record_event(thread_id, seq, &item).await.unwrap();
    rt.bus().publish(thread_id, &item).await.unwrap();
    seq
}

/// The backend's boot projection (`server_main`) rebuilds its thread LIST and
/// its known-set from `rt.threads()` — nothing else. So a thread created before
/// a restart must come back with its transcript, and the session bound to it
/// must be reused rather than replaced by a fresh one that has never seen the
/// conversation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restart_rehydrates_the_thread_list_history_and_session() {
    let env = Env::new("hydrate");
    let data = env.path();
    let b = binding("thread-1");

    let (session_before, seq_before) = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();
        rt.append_message("thread-1", &json!({"role": "user", "content": "hi"})).await.unwrap();
        let sid = rt.session_for(&b, definition()).await.unwrap();
        (sid, rt.current_sequence().await.unwrap())
    };

    // the process is gone; boot a new one over the same directory.
    let rt = boot(&data).await;

    let threads = rt.threads().await;
    assert_eq!(threads.len(), 1, "the thread list is rebuilt from the durable store: {threads:?}");
    assert_eq!(threads[0]["id"], "thread-1");

    let msgs = rt.messages("thread-1").await;
    assert_eq!(msgs.len(), 1, "the transcript survived the restart: {msgs:?}");
    assert_eq!(msgs[0]["content"], "hi");

    assert_eq!(
        rt.session_for(&b, definition()).await.unwrap(),
        session_before,
        "the binding resolved to the SAME durable session — a new id here means the \
         next turn talks to a provider session that has never seen this thread"
    );
    assert!(
        rt.current_sequence().await.unwrap() >= seq_before,
        "the event sequence did not rewind across the restart"
    );
}

/// The reconnect contract itself. A client holds the sequence its last snapshot
/// advertised; after the restart it must receive every event published while it
/// was away, each numbered ABOVE that mark, and no event it already had.
/// #324: a TURN's lifecycle events must be replayable after a reconnect.
///
/// This is the test the suite was missing, and its absence is why the suite
/// passed while running every turn through a projector that could not record.
/// The other tests here drive the durable path by hand through `emit()` — which
/// does record-then-publish correctly — and assert on the transcript and the
/// cursor. None of them ever asked whether an event the PROJECTOR produced
/// could be replayed, so the one path the product actually runs turns through
/// was the one path unexercised.
///
/// With the old `BusProjector` this cannot pass: it allocated no sequence and
/// called no `record_event`, so there is nothing above the mark to come back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turns_lifecycle_events_replay_after_a_reconnect() {
    let env = Env::new("turn-replay");
    let data = env.path();
    let b = binding("thread-1");

    let rt = boot(&data).await;
    rt.save_thread(&thread_row("thread-1")).await.unwrap();

    // The client's mark BEFORE the turn: everything the turn projects is owed
    // to a client reconnecting from here.
    let mark = rt.current_sequence().await.unwrap();

    let out = rt
        .run_turn_with_prompt_id(&b, definition(), "hello", Some("umsg-replay"), &projector(&rt))
        .await;
    assert!(
        matches!(out, TurnOutcome::Completed { .. }),
        "the turn must complete for its events to be worth replaying: {out:?}"
    );

    // THE POINT: reconnect below the turn and read the durable log. A projector
    // that publishes without recording leaves this empty while live delivery
    // looked perfect — which is precisely why it never reproduced.
    let replayed = rt.events_after("thread-1", mark, 1000).await.unwrap();
    assert!(
        !replayed.is_empty(),
        "the turn projected NOTHING replayable — a client reconnecting from \
         sequence {mark} catches up over a hole it can never fill"
    );

    // Every replayed event carries a sequence above the mark, in order. Without
    // a sequence there is no cursor and no replay, only live delivery.
    let seqs: Vec<i64> = replayed
        .iter()
        .map(|e| {
            agent_sdk_shell::event_sequence(e)
                .or_else(|| agent_sdk_shell::event_sequence(&e["event"]))
                .unwrap_or_else(|| panic!("a replayed event carries no sequence: {e}"))
        })
        .collect();
    assert!(
        seqs.iter().all(|s| *s > mark),
        "replayed events must sit above the client's mark {mark}: {seqs:?}"
    );
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "replay must be strictly ordered: {seqs:?}"
    );

    // And the turn's own content is in there — not merely some event.
    let text = serde_json::to_string(&replayed).unwrap();
    assert!(
        text.contains("delta") || text.contains("final"),
        "the replay carries none of the turn's own lifecycle facts: {text}"
    );

    // Survives the restart too, which is this suite's whole subject.
    drop(rt);
    let rt = boot(&data).await;
    let after_restart = rt.events_after("thread-1", mark, 1000).await.unwrap();
    assert_eq!(
        after_restart.len(),
        replayed.len(),
        "the turn's replayable events did not survive the restart"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reconnecting_client_resumes_above_its_snapshot_sequence() {
    let env = Env::new("resume");
    let data = env.path();

    // ── before the restart: the client is live and takes a snapshot ─────────
    let client_mark = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();

        let tail = rt.tail("thread-1").await.expect("subscription attached");
        let seq = emit(&rt, "thread-1").await;

        // the client received it and its stream acked — this is the frame the
        // snapshot mark covers.
        let items = tail.next(Duration::from_secs(5)).await.unwrap();
        assert_eq!(items.len(), 1, "the live frame arrived");
        assert_eq!(items[0].1["event"]["sequence"], seq);
        tail.ack(items[0].0).await.unwrap();
        tail.close().await;

        rt.current_sequence().await.unwrap()
    };

    // ── the server restarts; work continues while the client is disconnected ─
    let rt = boot(&data).await;
    assert_eq!(
        rt.current_sequence().await.unwrap(),
        client_mark,
        "reading the current sequence does not CONSUME one — a snapshot that \
         burned a number would leave a hole the client waits on forever"
    );

    // the reconnect attaches ABOVE what the client already holds — exactly what
    // `subscribeThread` does on both its resume paths.
    let tail =
        rt.tail_after("thread-1", Some(client_mark)).await.expect("the reconnect attached");
    let mut published = Vec::new();
    for _ in 0..3 {
        published.push(emit(&rt, "thread-1").await);
    }

    assert!(
        published.iter().all(|s| *s > client_mark),
        "post-restart events are numbered above the client's mark {client_mark}: {published:?}"
    );
    assert!(
        published.windows(2).all(|w| w[1] > w[0]),
        "and strictly monotonic: {published:?}"
    );

    // the reconnected tail drains all three, and nothing from before the mark.
    let mut got = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while got.len() < published.len() && std::time::Instant::now() < deadline {
        let items = tail.next(Duration::from_secs(2)).await.unwrap();
        let mut hi = -1;
        for (seq, item) in items {
            hi = seq;
            got.push(item["event"]["sequence"].as_i64().expect("numbered event"));
        }
        if hi >= 0 {
            tail.ack(hi).await.unwrap();
        }
    }
    got.sort_unstable();
    got.dedup();
    assert_eq!(got, published, "the reconnected stream delivered exactly the missed events");
    assert!(
        got.iter().all(|s| *s > client_mark),
        "no event at or below the snapshot mark was re-sent: {got:?}"
    );
    tail.close().await;
}

/// A frame the socket never accepted is NOT acked, so it is still in the
/// durable inbox for the next attempt — that is what makes a mid-turn
/// disconnect lossless. `spawn_thread_tail` encodes exactly this rule (ack only
/// after the writer confirms the sink took the frame); this pins the substrate
/// it relies on, so a refactor that acks on enqueue fails here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unacked_frame_survives_the_disconnect_and_the_restart() {
    let env = Env::new("unacked");
    let data = env.path();

    let seq = {
        let rt = boot(&data).await;
        let tail = rt.tail("thread-1").await.unwrap();
        let seq = emit(&rt, "thread-1").await;

        let items = tail.next(Duration::from_secs(5)).await.unwrap();
        assert_eq!(items.len(), 1);
        // the socket died here: read, never acked, never closed cleanly.
        seq
    };

    // restart, reattach, and the frame is still owed to the client.
    let rt = boot(&data).await;
    let tail = rt.tail("thread-1").await.unwrap();
    let items = tail.next(Duration::from_secs(5)).await.unwrap();
    assert!(
        items.iter().any(|(_, v)| v["event"]["sequence"] == json!(seq)),
        "the frame the client never confirmed came back after the restart: {items:?}"
    );
    tail.close().await;
}

/// A turn run before the restart and a turn run after it land in ONE
/// transcript, on one session, with no replay of the first turn's frames.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turns_before_and_after_a_restart_are_one_conversation() {
    let env = Env::new("turns");
    let data = env.path();
    let b = binding("thread-1");

    let cursor_before = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();
        // The RUNTIME persists the user's message — that write is the commit
        // point that makes an in-flight prompt survive a crash, and it is the
        // only one. The product passes the id its client already rendered, so
        // the durable row reconciles with the optimistic one rather than
        // landing beside it.
        let out = rt
            .run_turn_with_prompt_id(&b, definition(), "first", Some("umsg-first"), &projector(&rt))
            .await;
        assert_eq!(out, TurnOutcome::Completed, "the pre-restart turn completed");
        rt.cursor(&b).await.unwrap()
    };
    assert!(cursor_before >= 0, "the first turn advanced the durable cursor");

    let rt = boot(&data).await;
    assert_eq!(rt.cursor(&b).await.unwrap(), cursor_before, "the cursor came back with the process");

    let out = rt
        .run_turn_with_prompt_id(&b, definition(), "second", Some("umsg-second"), &projector(&rt))
        .await;
    assert_eq!(out, TurnOutcome::Completed, "the post-restart turn completed");
    assert!(rt.cursor(&b).await.unwrap() > cursor_before, "and moved the cursor further");

    let msgs = rt.messages("thread-1").await;
    let assistants = msgs.iter().filter(|m| m["role"] == "assistant").count();
    let users = msgs.iter().filter(|m| m["role"] == "user").count();
    assert_eq!(users, 2, "both prompts are in the one transcript: {msgs:?}");
    assert_eq!(
        assistants, 2,
        "two turns, two replies — a duplicate here means the restart replayed the \
         first turn's frames into the second: {msgs:?}"
    );
    // Every prompt is bound to the turn that answered it. A row with a null or
    // absent turnId is the signature of a SECOND writer persisting the prompt
    // outside the runtime — which is how the transcript grew a bare copy of
    // every message alongside the real one.
    for m in msgs.iter().filter(|m| m["role"] == "user") {
        assert!(
            m["turnId"].as_str().is_some_and(|t| t.starts_with("turn-")),
            "the prompt is bound to its turn — an unbound copy means a second writer: {m:?}"
        );
    }
}

/// A prompt the client already rendered is written ONCE. Re-driving the same
/// prompt id — a retried dispatch, a reconnect that replays the command — must
/// reconcile with the durable row, not append beside it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_id_the_client_already_rendered_is_never_written_twice() {
    let env = Env::new("prompt-id");
    let data = env.path();
    let b = binding("thread-1");
    let rt = boot(&data).await;
    rt.save_thread(&thread_row("thread-1")).await.unwrap();

    for _ in 0..2 {
        let out = rt
            .run_turn_with_prompt_id(&b, definition(), "hello", Some("umsg-fixed"), &projector(&rt))
            .await;
        assert_eq!(out, TurnOutcome::Completed);
    }

    let msgs = rt.messages("thread-1").await;
    let mine = msgs.iter().filter(|m| m["id"] == json!("umsg-fixed")).count();
    assert_eq!(mine, 1, "the re-driven prompt reconciled instead of duplicating: {msgs:?}");
}

/// #300: turn admission is DURABLE, not a process-local mutex map.
///
/// The map died with the process while the durable store still marked the turn
/// active, so a re-dispatch after a crash took a fresh uncontended lock and ran
/// concurrently with whatever the dead turn had left behind — lifecycle going
/// running→running→idle and two provider sessions driving one thread. It also
/// never applied to a second process over the same data dir.
///
/// This drops the runtime mid-turn (the crash) and reopens it, which is exactly
/// the case a mutex map cannot survive.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_left_in_flight_by_a_crash_blocks_a_concurrent_redispatch() {
    let env = Env::new("admission");
    let data = env.path();
    let b = binding("thread-1");

    {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();
        // a turn claims the thread and the process dies before releasing it.
        assert!(
            rt.try_admit_turn("thread-1", "turn-crashed").await.unwrap(),
            "the first turn is admitted on an idle thread"
        );
    }

    // the process is gone; the durable claim is not.
    let rt = boot(&data).await;
    assert_eq!(
        rt.claimed_turn("thread-1").await.unwrap().as_deref(),
        Some("turn-crashed"),
        "the durable claim survived the restart"
    );
    assert!(
        !rt.try_admit_turn("thread-1", "turn-second").await.unwrap(),
        "a second turn was admitted while one is still marked in flight — \
         this is the concurrent-execution bug a process-local lock could not see"
    );

    // and a real dispatch is refused rather than running alongside it.
    let out = rt.run_turn(&b, definition(), "hello", &projector(&rt)).await;
    match out {
        TurnOutcome::Failed { ref message } => assert!(
            message.contains("in flight"),
            "refused for the wrong reason: {message}"
        ),
        other => panic!("a second turn RAN on a thread that already had one: {other:?}"),
    }

    // the same turn re-entering its own claim is fine (heartbeat, retry).
    assert!(
        rt.try_admit_turn("thread-1", "turn-crashed").await.unwrap(),
        "a turn must be able to refresh its OWN claim"
    );
}

/// #299: the SHELL stream's sequence must survive a restart too.
///
/// The backend used to number `thread-upserted`, the dispatch ack and the shell
/// `snapshotSequence` off a per-process `Store::seq` that started at 1. A client
/// holding snapshotSequence 47 would, after a restart, receive an upsert
/// numbered 2 — the reducer either discards it as stale or re-applies a number
/// it already folded to a different event.
///
/// This drives the same sequence source `upsert_thread_on_shell` and the
/// dispatch ack now use, across a process boundary.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shell_sequence_continues_across_a_restart_instead_of_rewinding() {
    let env = Env::new("shellseq");
    let data = env.path();

    // a client subscribes and records the mark its snapshot advertised, after
    // some shell traffic has already been numbered.
    let client_mark = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();
        for _ in 0..5 {
            rt.next_sequence().await.unwrap();
        }
        let mark = rt.current_sequence().await.unwrap();
        assert!(mark >= 5, "the pre-restart stream really did advance: {mark}");
        mark
    };

    // the process dies and comes back over the same data dir.
    let rt = boot(&data).await;
    assert_eq!(
        rt.current_sequence().await.unwrap(),
        client_mark,
        "the snapshot mark a reconnecting client is handed did not rewind"
    );

    // the next shell event — what upsert_thread_on_shell publishes — is numbered
    // ABOVE the mark the client is still holding.
    let after_restart = rt.next_sequence().await.unwrap();
    assert!(
        after_restart > client_mark,
        "the first post-restart shell sequence ({after_restart}) must exceed the \
         client's mark ({client_mark}) — a process counter would have said 1"
    );
}

/// PACKET L, across a real process boundary: a shell frame published while the
/// client was DISCONNECTED is recoverable after a restart.
///
/// Before the emission seam, `upsert_thread_on_shell` allocated a sequence and
/// published — no replay row. The broker retains exactly one frame, so a client
/// that reconnected holding a mark could obtain the last upsert and nothing
/// else; every earlier one was unobtainable at any layer. The snapshot hid the
/// worst of it (the thread LIST is rebuilt durably), but the stream itself was
/// lossy, and `afterSequence` — a field the contract has always had — could
/// never be honoured.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_frames_published_while_a_client_was_away_replay_after_a_restart() {
    let env = Env::new("shellcatchup");
    let data = env.path();

    let client_mark = {
        let rt = boot(&data).await;
        rt.emit_shell_event(serde_json::json!({ "kind": "thread-upserted", "thread": thread_row("thread-0") }))
            .await
            .unwrap();
        // what the client's snapshot advertised before it went away
        let mark = rt.current_sequence().await.unwrap();
        // three upserts it never saw
        for i in 1..=3 {
            rt.emit_shell_event(serde_json::json!({
                "kind": "thread-upserted",
                "thread": thread_row(&format!("thread-{i}")),
            }))
            .await
            .unwrap();
        }
        mark
    };

    // the process dies and comes back over the same data dir
    let rt = boot(&data).await;
    let missed = rt.shell_events_after(client_mark, 500).await.unwrap();
    let ids: Vec<String> = missed
        .iter()
        .filter_map(|f| f.pointer("/thread/id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    assert_eq!(
        ids,
        vec!["thread-1", "thread-2", "thread-3"],
        "every frame published while the client was away must replay after a restart: {missed:?}"
    );
    // and the frames the client already holds are NOT re-sent
    assert!(
        missed.iter().all(|f| f.get("sequence").and_then(|s| s.as_i64()).unwrap_or(0) > client_mark),
        "catch-up must start strictly above the client's mark: {missed:?}"
    );

    // a post-restart emission continues above the same mark
    let next = rt
        .emit_shell_event(serde_json::json!({ "kind": "thread-upserted", "thread": thread_row("thread-4") }))
        .await
        .unwrap();
    assert!(next > client_mark, "the sequence did not rewind across the restart");
}

/// PACKET M, across a real process boundary: a question the agent asked
/// survives the process that asked it, so the reconnect snapshot can rebuild
/// an ANSWERABLE row.
///
/// Restarting mid-question used to leave the client with a blocked composer
/// and nothing to answer: the ask existed only as a frame on a socket that no
/// longer exists, and the run stayed parked forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_question_is_answerable_again_after_a_restart() {
    let env = Env::new("parkedask");
    let data = env.path();

    {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-1")).await.unwrap();
        rt.record_user_input_request(
            "thread-1",
            "sess-1",
            "turn-1",
            "Which branch should I push to?",
            Some(&serde_json::json!([{ "id": "q1", "options": ["main", "dev"] }])),
            "2026-01-01T00:00:00.000Z",
        )
        .await
        .unwrap();
    }

    let rt = boot(&data).await;
    let asks = rt.pending_user_inputs("thread-1").await.unwrap();
    assert_eq!(asks.len(), 1, "the ask must survive the restart: {asks:?}");
    assert_eq!(
        asks[0]["sessionId"], "sess-1",
        "the routing needed to answer it comes from the durable request, not a process map"
    );
    assert_eq!(asks[0]["questions"][0]["options"][1], "dev", "the options survive, so the answer is a choice");
    assert_eq!(
        asks[0]["requestedAt"], "2026-01-01T00:00:00.000Z",
        "the rebuilt row carries the original timestamp, so it replaces the live row instead of stacking"
    );
}

// ---------------------------------------------------------------------------
// PROOF (#321/#322/#325/#326): both `subscribeThread` resume paths survive an
// event published in the window that used to swallow it — ACROSS A RESTART.
//
// The SDK proves the bridge in isolation. What is only provable HERE is that
// the two calls `server_main::subscribeThread` actually makes — `replay_and_tail`
// on the resume path, `snapshot_tail` on the fallback path — reopen a durable
// stream at the same data dir after the process died, and that an event racing
// the reattach reaches the client instead of disappearing behind
// `synchronized`.
// ---------------------------------------------------------------------------

/// Every sequence the two halves of a resume handed the client, in order.
fn delivered(events: &[Value], live: &[Value]) -> Vec<i64> {
    events
        .iter()
        .chain(live.iter())
        .filter_map(agent_sdk_shell::event_sequence)
        .collect()
}

/// Drain a tail within a bounded window, acking what it hands over.
async fn drain_tail(tail: &agent_sdk_shell::ThreadTail) -> Vec<Value> {
    let mut out = Vec::new();
    for _ in 0..3 {
        let items = tail.next(Duration::from_millis(500)).await.unwrap();
        if items.is_empty() {
            break;
        }
        let mut hi = -1;
        for (seq, item) in items {
            hi = seq;
            out.push(item);
        }
        if hi >= 0 {
            tail.ack(hi).await.unwrap();
        }
    }
    out
}

/// RESUME PATH (#325): the client reconnects after a restart with the sequence
/// it holds, and an event is published WHILE the resume is running.
///
/// The old handler read the log and then attached, so an event landing between
/// those two calls was in neither half and the client was told `synchronized`
/// over the hole. `replay_and_tail` attaches first, so the event is in the
/// replay, on the tail, or both — and exactly once either way.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reconnect_resume_does_not_lose_an_event_published_in_its_window() {
    let env = Env::new("resume-window");
    let data = env.path();

    // ── before the restart ─────────────────────────────────────────────────
    let client_mark = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-resume-window")).await.unwrap();
        let seq = emit(&rt, "thread-resume-window").await;
        seq
    };

    // ── the process died; work continues while the client is away ──────────
    let rt = boot(&data).await;
    let missed = emit(&rt, "thread-resume-window").await;
    assert!(missed > client_mark, "the missed event is above the client's mark");

    // ── the reconnect, RACED by a live publish ─────────────────────────────
    let racer = {
        let rt2 = rt.clone();
        async move { emit(&rt2, "thread-resume-window").await }
    };
    let (resumed, raced) = tokio::join!(rt.replay_and_tail("thread-resume-window", client_mark, 500), racer);
    let resumed = resumed.expect("the resume attached and replayed");
    assert!(!resumed.more, "two events is not a full catch-up page");

    // `!more` above is what guarantees this tail exists: a truncated replay
    // hands back `None` precisely so a caller cannot pump a stream that covers
    // only part of the gap.
    let tail = resumed.tail.as_ref().expect("a covered gap comes with a live tail");
    let live = drain_tail(tail).await;
    let got = delivered(&resumed.events, &live);
    tail.close().await;

    assert!(
        got.contains(&missed),
        "the event published while the client was away must be replayed; got {got:?}"
    );
    assert!(
        got.contains(&raced),
        "the event published INSIDE the resume window must arrive too — this is \
         the sequence the old replay-then-attach order dropped; got {got:?}"
    );
    assert!(
        !got.contains(&client_mark),
        "the event the client already held must not be re-sent; got {got:?}"
    );
    let mut once = got.clone();
    once.sort_unstable();
    once.dedup();
    assert_eq!(once.len(), got.len(), "each event delivered exactly once: {got:?}");
}

/// SNAPSHOT PATH (#326): the fallback resume, with an event published while the
/// handler is building its snapshot.
///
/// `snapshot_tail` returns the mark the snapshot advertises together with a
/// tail attached BEFORE that mark was read. Everything at or below the mark is
/// in the snapshot the caller then builds; everything above it is on the tail.
/// The old order stamped the mark, built the snapshot, and attached last, so an
/// event in between belonged to neither.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_snapshot_resume_does_not_lose_an_event_published_in_its_window() {
    let env = Env::new("snapshot-window");
    let data = env.path();

    let before = {
        let rt = boot(&data).await;
        rt.save_thread(&thread_row("thread-snapshot-window")).await.unwrap();
        emit(&rt, "thread-snapshot-window").await
    };

    // ── restart, then take the snapshot resume RACED by a live publish ─────
    let rt = boot(&data).await;
    let racer = {
        let rt2 = rt.clone();
        async move { emit(&rt2, "thread-snapshot-window").await }
    };
    let (bridged, raced) = tokio::join!(rt.snapshot_tail("thread-snapshot-window"), racer);
    let (mark, tail) = bridged.expect("the snapshot tail attached");

    // What the handler's snapshot would carry: everything RECORDED through the
    // mark, read from the durable store after the attach — same order as
    // `server_main`.
    let snapshot: Vec<i64> = rt
        .events_after("thread-snapshot-window", 0, 500)
        .await
        .unwrap()
        .iter()
        .filter_map(agent_sdk_shell::event_sequence)
        .filter(|s| *s <= mark)
        .collect();
    let live: Vec<i64> = drain_tail(&tail).await.iter().filter_map(agent_sdk_shell::event_sequence).collect();
    tail.close().await;

    assert!(
        snapshot.contains(&before),
        "the pre-restart event is in the snapshot the client rebuilds; got {snapshot:?}"
    );
    assert!(
        !live.contains(&before),
        "and is NOT re-sent on the tail — the mark suppresses it; got {live:?}"
    );

    let covered = snapshot.contains(&raced) || live.contains(&raced);
    assert!(
        covered,
        "the event racing the snapshot must be in the snapshot (<= mark {mark}) or \
         on the tail (> mark) — never in neither. snapshot {snapshot:?}, live {live:?}, raced {raced}"
    );
    assert!(
        !(snapshot.contains(&raced) && live.contains(&raced)),
        "and never in both: snapshot {snapshot:?}, live {live:?}, raced {raced}"
    );
}

// ---------------------------------------------------------------------------
// PROOF (packet W: cross-runtime is the durability test): a second
// `ThreadRuntime` opened over the SAME data dir observes frames published on
// the SDK broker's SHELL/CONFIG/topic seams. This is the property that made
// #320 / packet DL / packet R architectural (rather than just cleanup) — a
// second backend process attached to the same isolate has to see the same
// frames, and the product no longer has any Vec<Sender> fanout that could
// substitute for it.
// ---------------------------------------------------------------------------

/// SHELL topic reaches a second runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_frame_published_on_runtime_a_reaches_runtime_b_on_the_same_data_dir() {
    let env = Env::new("crossrt-shell");
    let data = env.path();

    let rt_a = boot(&data).await;
    let rt_b = boot(&data).await;

    // B attaches BEFORE A publishes, so this exercises live cross-runtime
    // delivery rather than the retained-latest replay.
    let tail_b = rt_b.shell_tail_after(None).await.expect("attach shell tail on runtime B");

    let frame = serde_json::json!({
        "kind": "thread-upserted",
        "sequence": 1,
        "thread": thread_row("thread-x")
    });
    rt_a.shell_publish(&frame).await.expect("publish on runtime A");

    // Poll for a bounded window; broker NOTIFY across process-local isolates
    // on the same data dir is event-driven, not a shared in-process channel.
    let mut received: Vec<Value> = Vec::new();
    for _ in 0..20 {
        let items = tail_b.next(std::time::Duration::from_millis(150)).await.unwrap();
        received.extend(items.into_iter().map(|(_seq, v)| v));
        if received.iter().any(|f| f.pointer("/thread/id").and_then(Value::as_str) == Some("thread-x")) {
            break;
        }
    }
    assert!(
        received.iter().any(|f| f.pointer("/thread/id").and_then(Value::as_str) == Some("thread-x")),
        "runtime B must observe the shell frame runtime A published: got {received:?}"
    );
}

/// CONFIG topic reaches a second runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_config_frame_published_on_runtime_a_reaches_runtime_b_on_the_same_data_dir() {
    let env = Env::new("crossrt-config");
    let data = env.path();

    let rt_a = boot(&data).await;
    let rt_b = boot(&data).await;

    let tail_b = rt_b.config_tail_after(None).await.expect("attach config tail on runtime B");
    let frame = serde_json::json!({ "version": 1, "type": "settingsUpdated", "payload": { "ok": true } });
    rt_a.config_publish(&frame).await.expect("publish on runtime A");

    let mut received: Vec<Value> = Vec::new();
    for _ in 0..20 {
        let items = tail_b.next(std::time::Duration::from_millis(150)).await.unwrap();
        received.extend(items.into_iter().map(|(_seq, v)| v));
        if received.iter().any(|f| f.get("type").and_then(Value::as_str) == Some("settingsUpdated")) {
            break;
        }
    }
    assert!(
        received.iter().any(|f| f.get("type").and_then(Value::as_str) == Some("settingsUpdated")),
        "runtime B must observe the config frame runtime A published: got {received:?}"
    );
}

/// Product-named topic (terminal fanout, per-thread meta, per-cwd VCS)
/// reaches a second runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_topic_frame_published_on_runtime_a_reaches_runtime_b_on_the_same_data_dir() {
    let env = Env::new("crossrt-topic");
    let data = env.path();

    let rt_a = boot(&data).await;
    let rt_b = boot(&data).await;

    let topic = "t3:terminals";
    let tail_b = rt_b.topic_tail_after(topic, None).await.expect("attach topic tail on runtime B");
    let frame = serde_json::json!({ "type": "upsert", "threadId": "t-x", "terminalId": "term-1" });
    rt_a.topic_publish(topic, &frame).await.expect("publish on runtime A");

    let mut received: Vec<Value> = Vec::new();
    for _ in 0..20 {
        let items = tail_b.next(std::time::Duration::from_millis(150)).await.unwrap();
        received.extend(items.into_iter().map(|(_seq, v)| v));
        if received.iter().any(|f| f.get("terminalId").and_then(Value::as_str) == Some("term-1")) {
            break;
        }
    }
    assert!(
        received.iter().any(|f| f.get("terminalId").and_then(Value::as_str) == Some("term-1")),
        "runtime B must observe the topic frame runtime A published: got {received:?}"
    );
}

/// PROOF (#341): `topic_tail_skip_retained` actually skips the broker's
/// retained-latest replay, so a subscriber that just handed its client a
/// product snapshot does not then receive a byte-identical duplicate.
///
/// The bug the finding named: `topic_tail_after(topic, Some(0))` was misused
/// as a "skip retained" flag, but the pump's suppression is keyed on the
/// `sequence` field in the JSON payload — VCS/terminal frames carry no
/// sequence, so the retained duplicate was delivered anyway. The fix
/// suppresses IN THE BROKER, before the frame ever enters the inbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn topic_tail_skip_retained_does_not_deliver_the_retained_frame() {
    let env = Env::new("topic-skip-retained");
    let data = env.path();
    let rt = boot(&data).await;

    // Plant a retained frame (product snapshot handed the client already).
    let topic = "t3:demo";
    let retained_frame = serde_json::json!({ "type": "snapshot", "terminals": [] });
    rt.topic_publish(topic, &retained_frame).await.expect("publish retained");

    // Attach with retained-skip AFTER the publish, so the broker holds one.
    let tail = rt.topic_tail_skip_retained(topic).await.expect("attach");

    // First read must NOT surface the retained frame.
    let items = tail.next(std::time::Duration::from_millis(300)).await.unwrap();
    assert!(
        items.is_empty(),
        "retained-skip must suppress the retained-latest replay at subscribe time, got: {items:?}"
    );

    // A LIVE publish AFTER attach must still be delivered.
    let live = serde_json::json!({ "type": "upsert", "terminalId": "term-live" });
    rt.topic_publish(topic, &live).await.expect("publish live");

    let mut received: Vec<Value> = Vec::new();
    for _ in 0..20 {
        let items = tail.next(std::time::Duration::from_millis(150)).await.unwrap();
        received.extend(items.into_iter().map(|(_, v)| v));
        if received.iter().any(|f| f.get("terminalId").and_then(Value::as_str) == Some("term-live")) {
            break;
        }
    }
    assert!(
        received.iter().any(|f| f.get("terminalId").and_then(Value::as_str) == Some("term-live")),
        "retained-skip must not suppress live frames published after attach: got {received:?}"
    );
    assert!(
        !received.iter().any(|f| f.get("type").and_then(Value::as_str) == Some("snapshot")),
        "the retained snapshot must never appear at all: got {received:?}"
    );
}
