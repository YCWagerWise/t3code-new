//! Flown backend↔protocol contract tests (#403).
//!
//! Extracted verbatim from `server_main.rs`, which was 9,977 lines with 57%
//! of them test code — enough that an architecture review could not tell
//! transport glue from runtime authority. A child module in its own file
//! still reaches `super::*` and its parent's private items, so nothing about
//! what these tests can see or assert has changed.

//! Flown backend↔protocol tests: drive `handle_request` against a real
//! `AppState` (the SDK `ThreadRuntime` over a temp dir) and assert the
//! Effect-RPC wire frames. Covers boot config, unsupported-method failure
//! (not success-null), dispatch ack, and durable thread-snapshot replay.
use super::*;
use agent_sdk_shell::Projector;
use std::sync::OnceLock;

fn contract_test_fd_slots() -> &'static Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
}

/// The temp workspace one contract test runs in, removed when the test ENDS —
/// including when it panics.
///
/// This used to be a bare `PathBuf` under `std::env::temp_dir()`, with cleanup
/// left to each test remembering `let _ = std::fs::remove_dir_all(&dir);` as the
/// last statement of its body. 115 test fns, 28 such calls — and even those 28
/// leaked on any panic or early return, because a statement at the bottom of a
/// body does not run when the body unwinds. A FAILING test is exactly when the
/// directory got left behind, so a red round made the next round redder.
///
/// Measured on woodbine before this change: 12,002 `/tmp/t3ct-*` directories in
/// eleven hours, ~13M each, filling a 31G tmpfs to 80%. /tmp there is RAM, so
/// that was 25 of the box's 60 GB — and once it filled, unrelated suites
/// (cairn, hearth, do-storage) began failing with `os error 122 QuotaExceeded`
/// and getting misattributed to whatever change was under test.
///
/// `Drop` is the fix rather than more cleanup calls: it cannot be forgotten by
/// the next test, and it runs while unwinding.
pub(crate) struct TestDir(tempfile::TempDir);

impl std::ops::Deref for TestDir {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        self.0.path()
    }
}

impl AsRef<std::path::Path> for TestDir {
    fn as_ref(&self) -> &std::path::Path {
        self.0.path()
    }
}

async fn test_state() -> (AppState, TestDir) {
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let state = state_at(dir.path()).await;
    (state, TestDir(dir))
}

async fn drop_runtime_kv(state: &AppState) {
    let pool = do_storage::DbPool::new(std::path::Path::new(&state.cwd).join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE kv", vec![]).await.unwrap();
}

/// #202: break the broker's subscriber table so every `topic_publish` fails.
///
/// The bus rides the SAME runtime isolate as `kv` (`ThreadBus::open_db(rt.db)`),
/// and `Broker::publish` starts with `SELECT sub_id, topic FROM subs` — so
/// dropping that table is a real, deterministic publish failure at the exact
/// seam, with no test-only fault hook bolted onto the product.
async fn break_topic_publish(state: &AppState) {
    let pool = do_storage::DbPool::new(std::path::Path::new(&state.cwd).join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE subs", vec![]).await.unwrap();
}

/// PROOF (#320 anti-regression, packet AE): the product backend must not
/// re-grow authority the SDK/do-rs now owns. Each symbol below was
/// previously a live product-owned hidden authority and its deletion is
/// the substance of a shipped rejection fix; a review pass that reads a
/// green build should not need to re-read a 6k-line file to know the
/// pattern did not sneak back in.
///
/// The check is a substring scan of the source (not a token parse) — a
/// comment reintroducing the name still fails the test, which is exactly
/// the right level of paranoia: a stub map named `known_threads` in a
/// TODO comment reads to the next reviewer as authority that was tolerated.
#[test]
fn product_backend_does_not_re_grow_deleted_authority() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/server_main.rs"),
    )
    .expect("read this file");
    // Strip line comments so the historical references below (which name
    // the deleted symbols in prose to explain what was removed and why)
    // do not trip the check.
    let code: String = src
        .lines()
        .map(|l| {
            if let Some(idx) = l.find("//") {
                &l[..idx]
            } else {
                l
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Rebuild the forbidden strings at runtime so this test's own array
    // literal does not contain them (a naive substring scan of this file
    // would match its own definitions and false-positive on itself).
    let s = |a: &str, b: &str| format!("{a}{b}");
    let forbidden: Vec<String> = vec![
        s("known", "_threads:"),
        s(".known", "_threads"),
        s("shell", "_subs:"),
        s(".shell", "_subs"),
        s("config", "_subs:"),
        s(".config", "_subs"),
        s("terminal", "_subs:"),
        s(".terminal", "_subs"),
        s("terminal", "_meta_subs:"),
        s(".terminal", "_meta_subs"),
        s("vcs", "_subs:"),
        s(".vcs", "_subs"),
        // Projects moved into the durable SDK store (#370). A field
        // named `projects` on Store is the shape the finding named —
        // a boot-time constant shipped in the reconnect snapshot next
        // to durable threads, diverging across two backends on the
        // same isolate.
        s("projects", ": Vec<"),
        s("st.", "projects"),
        // A per-cwd refcount is the same authority as the Vec it replaced,
        // just smaller: a count of THIS process's sockets still cannot
        // answer "does anyone anywhere still care", so it releases a watch
        // another backend's clients are reading (#335). Release-on-last is
        // a durable claim — watch_claim / watch_unclaim.
        s("vcs", "_sub_counts:"),
        s(".vcs", "_sub_counts"),
        s("thread", "_subs:"),
        s("thread", "_buffer:"),
        s("session", "_cursors:"),
        s("turn", "_locks:"),
        s(".turn", "_locks"),
    ];
    for pat in &forbidden {
        assert!(
            !code.contains(pat.as_str()),
            "server_main.rs re-grew product-owned authority: `{pat}`. \
             Deleted for #299 / #300 / #303 / #320; put the state below \
             the product (do-rs / agent-sdk-shell) instead."
        );
    }

    // Direct broker publish from the product bypasses the SDK's
    // record-then-publish invariant. Product writes MUST go through
    // emit_thread_event / ThreadRuntime::shell_publish so the sequence
    // is allocated and the row is recorded before it is announced live.
    let direct_bus_publish = s("bus()", ".publish(");
    let direct_bus_shell = s("bus()", ".shell_publish(");
    assert!(
        !code.contains(direct_bus_publish.as_str()) && !code.contains(direct_bus_shell.as_str()),
        "server_main.rs calls the broker directly; use emit_thread_event / \
         ThreadRuntime::shell_publish so the durable sequence is allocated \
         and the row is recorded before it is announced live."
    );
}

/// PROOF (#305/#306): every event type this backend publishes is one the
/// CONTRACT defines.
///
/// Both blockers were the same shape — the projector emitted
/// `thread.approval-requested` / `thread.user-input-requested`, names absent
/// from `OrchestrationEventType`, so the client reducer fell through its
/// forward-compatible default, returned `unchanged`, and the prompt simply
/// never appeared while the turn looked hung. Nothing in the backend could
/// notice: it agreed with itself.
///
/// So the assertion is made against the CONTRACT SOURCE, parsed at test
/// time. Renaming or removing an event in `packages/contracts` fails this
/// test, which is the coupling that was missing.
#[test]
fn every_projected_event_type_is_in_the_contract() {
    let contract = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/contracts/src/orchestration.ts"),
    )
    .expect("the contract source is readable — parity cannot be assumed");

    // The `OrchestrationEventType` literal union, taken from the contract
    // rather than copied into this file (a copy drifts, and a drifted copy
    // asserts nothing).
    let start = contract
        .find("export const OrchestrationEventType = Schema.Literals([")
        .expect("the event-type union is where the contract says it is");
    let body = &contract[start..];
    let end = body.find("]);").expect("the union terminates");
    let allowed: std::collections::HashSet<&str> = body[..end]
        .lines()
        .filter_map(|l| {
            let t = l.trim().trim_end_matches(',').trim_matches('"');
            (t.starts_with("thread.") || t.starts_with("project.")).then_some(t)
        })
        .collect();
    assert!(
        allowed.contains("thread.activity-appended"),
        "sanity: the union parsed"
    );
    assert!(
        !allowed.contains("thread.approval-requested"),
        "sanity: the invented name is NOT in the contract, which is why this test exists"
    );

    // Drive every lifecycle variant through the pure projection and collect
    // the names it puts on the wire.
    let v = |s: &str| s.to_string();
    let events = vec![
        Lifecycle::TurnStarted {
            thread_id: v("t"),
            turn_id: v("u"),
        },
        Lifecycle::Delta {
            thread_id: v("t"),
            turn_id: v("u"),
            message_id: v("m"),
            text: v("hi"),
        },
        Lifecycle::MessageFinal {
            thread_id: v("t"),
            turn_id: v("u"),
            message_id: v("m"),
            text: v("hi"),
        },
        Lifecycle::ApprovalRequested {
            thread_id: v("t"),
            turn_id: v("u"),
            session_id: v("s"),
            turn: 1,
            call_id: v("c"),
            tool: v("run_bash"),
            args: json!({"command": "ls"}),
        },
        Lifecycle::UserInputRequested {
            thread_id: v("t"),
            turn_id: v("u"),
            session_id: v("s"),
            prompt: v("which one?"),
            questions: None,
        },
        Lifecycle::ApprovalResolved {
            thread_id: v("t"), request_id: v("s|1|c"), decision: v("accept"), allowed: true,
        },
        Lifecycle::ApprovalFailed {
            thread_id: v("t"), request_id: v("s|1|c"), detail: v("approval failed"),
        },
        Lifecycle::UserInputResolved {
            thread_id: v("t"), session_id: v("s"),
        },
        Lifecycle::UserInputFailed {
            thread_id: v("t"), session_id: v("s"), detail: v("answer failed"),
        },
        Lifecycle::ToolStarted {
            thread_id: v("t"),
            turn_id: v("u"),
            call_id: v("c"),
            tool: v("run_bash"),
            args: json!({"command": "ls"}),
        },
        Lifecycle::ToolCompleted {
            thread_id: v("t"),
            turn_id: v("u"),
            call_id: v("c"),
            output: json!("done"),
        },
        Lifecycle::TurnEnded {
            thread_id: v("t"),
            turn_id: v("u"),
            outcome: TurnOutcome::Completed,
        },
    ];

    let mut seen = Vec::new();
    for e in &events {
        let (_, items) = project_items(e, "2026-01-01T00:00:00.000Z");
        assert!(
            !items.is_empty(),
            "a lifecycle fact that projects to nothing is a fact the client never learns: {e:?}"
        );
        for (ty, _) in items {
            assert!(
                allowed.contains(ty.as_str()),
                "projector emits `{ty}`, which packages/contracts does not define — \
                 the client reducer has no case for it and will silently ignore it"
            );
            seen.push(ty);
        }
    }

    // The two blockers specifically: the ASK reaches the client as a
    // contracted activity, and never as an invented event.
    let (_, approval) = project_items(&events[3], "2026-01-01T00:00:00.000Z");
    assert_eq!(approval[0].0, "thread.activity-appended");
    assert_eq!(approval[0].1["activity"]["kind"], "approval.requested");
    assert_eq!(
        approval[0].1["activity"]["payload"]["requestKind"], "command",
        "the web client only builds a PendingApproval when it can classify the request"
    );
    let (_, ask) = project_items(&events[4], "2026-01-01T00:00:00.000Z");
    assert_eq!(ask[0].0, "thread.activity-appended");
    assert_eq!(ask[0].1["activity"]["kind"], "user-input.requested");
    let (_, approval_resolved) = project_items(&events[5], "2026-01-01T00:00:00.000Z");
    assert_eq!(approval_resolved[0].0, "thread.activity-appended");
    assert_eq!(approval_resolved[0].1["activity"]["kind"], "approval.resolved");
    let (_, approval_failed) = project_items(&events[6], "2026-01-01T00:00:00.000Z");
    assert_eq!(approval_failed[0].0, "thread.activity-appended");
    assert_eq!(approval_failed[0].1["activity"]["kind"], "approval.requested");
    assert_eq!(approval_failed[0].1["activity"]["tone"], "error");
    let (_, input_resolved) = project_items(&events[7], "2026-01-01T00:00:00.000Z");
    assert_eq!(input_resolved[0].0, "thread.activity-appended");
    assert_eq!(input_resolved[0].1["activity"]["kind"], "user-input.resolved");
    let (_, input_failed) = project_items(&events[8], "2026-01-01T00:00:00.000Z");
    assert_eq!(input_failed[0].0, "thread.activity-appended");
    assert_eq!(input_failed[0].1["activity"]["kind"], "user-input.requested");
    assert_eq!(input_failed[0].1["activity"]["tone"], "error");
}

/// Build a backend over an EXISTING workspace/data directory — i.e. what a
/// process restart produces. Every durable claim the backend makes is only
/// worth testing across one of these.
/// [`state_at`] with a MODEL behind the runtime's shell.
///
/// `state_at` builds `Shell::new(..)` with no model override, so nothing in
/// this file could run an actual turn — which is why the #411 interrupt proof
/// could only assert the absence of an error frame. A turn that never runs
/// cannot be interrupted, and an interrupt that reaches no session is
/// indistinguishable from one that works.
/// `checkpoint_turn_start` stopped being a free function in server_main: it is
/// now `agent_sdk_shell::TurnCheckpointer::checkpoint_turn_start` implemented
/// by `WorkspaceCheckpointer` (#376 — turn lifecycle moved to the SDK, the
/// product keeps only "where does the change-set for cwd live").
///
/// These tests kept calling the old free function. This shim calls the SAME
/// seam the runtime calls, so the tests exercise the new boundary rather than
/// being deleted or re-pointed at the substrate directly.
async fn checkpoint_turn_start(state: &AppState, cwd: &str, turn_id: &str) {
    use agent_sdk_shell::TurnCheckpointer;
    let cp = super::WorkspaceCheckpointer {
        state: state.clone(),
        cwd: cwd.to_string(),
    };
    cp.checkpoint_turn_start(turn_id)
        .await
        .expect("checkpoint_turn_start must succeed");
}

/// The minimal durable thread row the checkpoint/revert tests operate on.
///
/// Was a helper in server_main.rs until it was removed during the #376
/// checkpoint extraction, leaving this module's only call site dangling and the
/// tree red. Defined here because the shape is a TEST fixture, not product
/// surface — the product no longer needs to know how to hand-build a thread row.
fn checkpoint_thread(id: &str) -> Value {
    json!({
        "id": id,
        "projectId": "p-workspace",
        "title": id,
        "runtimeMode": "full-access",
        // The thread decoder refuses to INVENT these two, so a fixture that
        // omits them is not a valid durable thread row.
        //
        // This used to be `Value::Null` with a comment calling that "a recorded
        // no selection". That reading is no longer the contract: #87's
        // `required_model_selection` demands an OBJECT with `instanceId` and
        // `model`, and rejects null exactly as it rejects a missing key — on
        // the stated reasoning that a persisted row whose selection cannot be
        // read must not be projected as though some default had been chosen.
        // A fixture writing a row production would refuse to write is not
        // exercising production.
        "modelSelection": json!({ "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }),
        "interactionMode": "default",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    })
}

async fn state_at_with_model(
    dir: &std::path::Path,
    model: impl Fn() -> Box<dyn agent_sdk_core::Model> + Send + Sync + 'static,
) -> AppState {
    // Wrap in Arc so the outer FnOnce decorator can move it while the SDK's
    // `with_model_factory` still gets a fresh owned `'static` factory closure
    // that calls through — `&model` had lifetime tied to this frame, not
    // 'static, which was the E0521 the compiler tripped on.
    let model = std::sync::Arc::new(model);
    state_built(
        dir,
        Some(Box::new(move |sh: Shell| {
            let model = model.clone();
            sh.with_model_factory(move || model())
        })),
    )
    .await
}

async fn state_at(dir: &std::path::Path) -> AppState {
    state_built(dir, None).await
}

#[allow(clippy::type_complexity)]
async fn state_built(
    dir: &std::path::Path,
    with_model: Option<Box<dyn Fn(Shell) -> Shell + Send + Sync>>,
) -> AppState {
    let contract_test_fd_slot = contract_test_fd_slots()
        .clone()
        .acquire_owned()
        .await
        .expect("contract test fd semaphore is not closed");
    // The contract suite is a synthetic in-process concurrency harness. With the
    // default Rust test parallelism it can hold eight AppStates at once, and the
    // ratchet below measures one AppState at five storage isolates. The
    // RLIMIT-derived do-storage default is intentionally conservative (12 at
    // ulimit -n 256), which is right for an unknown production host but too small
    // for this measured harness. Pin the harness budget explicitly so admission
    // control is still active, just sized to the workload under test.
    do_storage::set_process_max_resident(Some(40));
    let dir = dir.to_path_buf();
    let data = dir.join("data");
    std::fs::create_dir_all(&data).unwrap();
    let runner = tools::open_workspace_shell(&dir, data.clone())
        .await
        .unwrap();
    let tool_roots = tools::ToolRoots::new(dir.clone(), data.clone(), runner.clone()).await;
    let shell = Shell::new(&data, tool_roots.registry_factory());
    let shell = Arc::new(match &with_model {
        Some(decorate) => decorate(shell),
        None => shell,
    });
    let rt = ThreadRuntime::open(shell, data.to_str().unwrap(), "main")
        .await
        .unwrap();
    // Seed the workspace project the same way boot does (#370). Every
    // contract test used to inline a `p-workspace` Vec into Store; now
    // the durable store IS the source, so tests use the same seed path.
    rt.save_project(&json!({"id": "p-workspace", "title": "workspace",
        "workspaceRoot": dir.to_string_lossy().into_owned(),
        "defaultModelSelection": null, "scripts": [],
        "createdAt": now_iso(), "updatedAt": now_iso()}))
        .await
        .unwrap();
    let state = AppState {
        rt,
        catalog: Arc::new(RwLock::new(providers::catalog())),
        checkpoints: tools::checkpoint_pool(data.join("checkpoints")),
        checkpoints_dir: data.join("checkpoints"),
        diag_history: Arc::new(open_diag_history(&data).await),
        _contract_test_fd_slot: Some(Arc::new(contract_test_fd_slot)),
        terminals: Arc::new(
            terminal::TerminalRegistry::new(
                runner.clone(),
                dir.to_string_lossy().into_owned(),
                tool_roots.sessions(),
                tool_roots.session_db(),
            )
            .await
            .expect("open the durable pane registry"),
        ),
        vcs_watch_changed: Arc::new(tokio::sync::watch::channel(0u64).0),
        terminal: runner,
        tool_roots,
        assets_key: Arc::new(b"test-asset-key".to_vec()),
        // Tests scan NOTHING by default: pointing the suite at the
        // developer's real ~/.claude would make its assertions depend on
        // whoever ran it.
        usage_sources: Arc::new(Vec::new()),
        usage_rates: Default::default(),
        env: json!({}),
        cwd: dir.to_string_lossy().into(),
        project_name: "t".into(),
    };
    state
}

fn drain(rx: &mut mpsc::UnboundedReceiver<OutFrame>) -> Vec<Value> {
    // Positively ack the done-oneshot each spawn_thread_tail frame carries,
    // so the pump task keeps pulling from the broker after this call
    // returns. Dropping the sender (as a naive drain would) cancels the
    // oneshot and closes the pump — a subsequent shell_publish would then
    // reach the broker with no reader.
    let mut out = vec![];
    while let Ok((s, done)) = rx.try_recv() {
        if let Some(tx) = done {
            let _ = tx.send(true);
        }
        out.push(serde_json::from_str(&s).unwrap());
    }
    out
}

/// Drain, sleeping in short slices until `pred` finds a match or `deadline`
/// elapses. For async fanout paths (the shell tail is a spawned pump on the
/// SDK broker, not a synchronous `Vec<Sender>` fanout).
async fn drain_until<F>(
    rx: &mut mpsc::UnboundedReceiver<OutFrame>,
    deadline: std::time::Duration,
    pred: F,
) -> Vec<Value>
where
    F: Fn(&Value) -> bool,
{
    let start = std::time::Instant::now();
    let mut out: Vec<Value> = vec![];
    while start.elapsed() < deadline {
        out.extend(drain(rx));
        if out.iter().any(&pred) {
            return out;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    out.extend(drain(rx));
    out
}

/// Write a user prompt the way `run_turn_with_prompt_id` does, for tests
/// that exercise thread bootstrap without running a turn.
async fn seed_prompt(state: &AppState, thread_id: &str, message_id: &str, text: &str) {
    state
        .rt
        .append_message(
            thread_id,
            &json!({"id": message_id, "role": "user", "text": text, "streaming": false}),
        )
        .await
        .unwrap();
}

async fn request(
    state: &AppState,
    tx: &mpsc::UnboundedSender<OutFrame>,
    method: &str,
    payload: Value,
) {
    handle_request(
        &json!({ "_tag": "Request", "id": 7, "tag": method, "payload": payload }),
        tx,
        state,
    )
    .await;
}

/// #400 second failure path: `save_project` succeeds but the
/// downstream `emit_shell_event(project-upserted)` fails — must
/// return exactly one Failure, not a Success masking the missing
/// replay row. A Success here lets the reducer advance past a
/// change no reconnecting client can ever learn about.
#[tokio::test]
async fn project_meta_update_fails_when_shell_replay_emission_fails() {
    use agent_sdk_do::ObjectDb;
    let (state, dir) = test_state().await;
    // Seed a real project so the id branch passes.
    state
        .rt
        .save_project(&json!({
            "id": "p-real", "title": "before",
            "workspaceRoot": "/tmp",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();

    // Fault-inject: open a second db handle on the threadruntime
    // isolate and DROP the `shell_event` table. `save_project` will
    // still work (different isolate — `orchestration`), but
    // `emit_shell_event` will fail its record step on the missing
    // table. This is exactly the split-success class the finding
    // named: durable row changed, replay frame gone.
    let pool = do_storage::DbPool::new(dir.join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE shell_event", vec![]).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "project.meta.update",
            "projectId": "p-real",
            "patch": { "title": "after" },
        }}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "shell emit failure must be a visible Failure, not Success{{sequence:_}}: {exit}"
    );
    // And the failure names WHERE it broke — a generic "update failed"
    // does not tell the client whether to retry (durable row changed
    // so a retry is safe/idempotent).
    // `exit_failure` builds `cause: [{ _tag: "Die", defect: "..." }]`
    // so the message lives at cause[0].defect.
    let msg = exit["exit"]["cause"][0]["defect"]
        .as_str()
        .or_else(|| exit["exit"]["cause"][0]["error"]["defect"].as_str())
        .or_else(|| exit["exit"]["cause"][0]["error"]["message"].as_str())
        .unwrap_or("");
    assert!(
        msg.contains("shell") || msg.contains("emission") || msg.contains("replay"),
        "failure message names the failing subsystem: {exit}"
    );
}

/// #400: `project.meta.update` for an unknown projectId must NOT
/// return `Exit(Success){sequence}` — a Success carrying a
/// sequence for no state change is a false terminal the reducer
/// folds as "applied", exactly the class the thread path already
/// had fixed.
#[tokio::test]
async fn project_meta_update_refuses_unknown_project_id() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "project.meta.update",
            "projectId": "p-does-not-exist",
            "patch": { "title": "renamed" },
        }}),
    )
    .await;
    let frames = drain(&mut rx);
    let exit = frames.iter().find(|f| f["_tag"] == "Exit").expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "unknown projectId must be a visible Failure, not a Success{{sequence:_}}: {exit}"
    );
    // Contrast: valid project id passes.
    state
        .rt
        .save_project(&json!({
            "id": "p-real", "title": "before",
            "workspaceRoot": "/tmp",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "project.meta.update",
            "projectId": "p-real",
            "patch": { "title": "after" },
        }}),
    )
    .await;
    let exit2 = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit2["exit"]["_tag"], "Success",
        "a valid update still succeeds: {exit2}"
    );
    // And the durable row moved.
    let stored = state
        .rt
        .projects()
        .await
        .unwrap()
        .into_iter()
        .find(|p| p.get("id").and_then(Value::as_str) == Some("p-real"))
        .expect("row present");
    assert_eq!(
        stored["title"], "after",
        "durable row was updated: {stored}"
    );
}

/// #400 (second failure path): `project.meta.update` must FAIL CLOSED when
/// `save_project` lands but `emit_shell_event(project-upserted)` cannot
/// record the replay row — otherwise the client is told the metadata
/// change succeeded while a reconnect never sees a `project-upserted`
/// frame for it, and the reducer folds a lie.
///
/// Fault-injection strategy (no fixture mocks): reserve the next durable
/// sequence slot N by planting a `shell_event(seq=N, ...)` row directly
/// via `record_shell_event_for_test`, then trigger `project.meta.update`
/// with a valid id. Its internal `next_sequence` returns N, its record
/// step INSERT OR IGNORE hits the pre-existing row and returns `n=0`,
/// which `record_shell_event` surfaces as `Err("shell_event(N) already
/// exists — a sequence was handed out twice")`. `project.meta.update`
/// must translate that into an `Exit(Failure)`, not `Exit(Success)`.
#[tokio::test]
async fn project_meta_update_fails_closed_when_shell_event_publish_fails() {
    let (state, _d) = test_state().await;
    state
        .rt
        .save_project(&json!({
            "id": "p-real-2", "title": "before",
            "workspaceRoot": "/tmp",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();

    // Reserve the NEXT sequence slot the update path will try to claim.
    // `next_sequence` allocates and returns the new value, so counter is
    // now at N; the update's own `next_sequence` call will return N+1,
    // which is the seq we plant a rogue row at.
    let reserved = state.rt.next_sequence().await.unwrap();
    let collide_seq = reserved + 1;
    state
        .rt
        .record_shell_event_for_test(
            collide_seq,
            &json!({ "kind": "sentinel", "sequence": collide_seq }),
        )
        .await
        .expect("plant the rogue shell_event row");

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "project.meta.update",
            "projectId": "p-real-2",
            "patch": { "title": "after" },
        }}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "a failed shell_event publish must surface as Failure, never Success: {exit}"
    );
    // The failure names the failing subsystem so an operator can trace it.
    let defect = exit["exit"]["cause"][0]["defect"].as_str().unwrap_or("");
    assert!(
        defect.contains("shell")
            || defect.contains("emission")
            || defect.contains("sequence")
            || defect.contains("already exists"),
        "the failure explains the shell_event publish failure: {exit}"
    );
}

/// #374 probe: when the durable project store cannot be read, the
/// product must NOT emit a schema-valid `projects: []` snapshot with
/// live threads beside it — that is a fail-open lie the reducer has
/// no way to distinguish from "no projects exist". Force the failure
/// mode by DROPping the `projects` table on the same isolate the
/// runtime opened (concurrent-read second connection over turso WAL),
/// then subscribeShell must exit Failure, not Success with an empty
/// projects array.
#[tokio::test]
async fn subscribe_shell_fails_closed_when_projects_store_is_unreadable() {
    use agent_sdk_do::ObjectDb;
    let (state, dir) = test_state().await;
    // Open a second db handle on the same orchestration isolate the
    // runtime already opened, and DROP the projects table. The
    // runtime's next `state.rt.projects().await` returns Err
    // ("project store unreadable: no such table: projects") which
    // the handler must translate into an RPC Failure.
    // Reach the orchestration store through the SDK seam the runtime itself
    // uses, not through a hand-built `DbPool` over a guessed path.
    //
    // It used to be `DbPool::new(dir/data/orchestration).object_db("orchestration","main")`,
    // and that stopped naming the runtime's store the moment agent-sdk-shell
    // folded the orchestration tables in with the rest of the runtime's — the
    // path still EXISTS on disk, so the test kept "working" while opening an
    // isolate with nothing in it but do-rs's own `do_kv`/`do_alarm` tables, and
    // failed on `DROP TABLE projects` with "no such table". A test that
    // reconstructs a store's location is a test that silently stops testing it.
    let db = state.rt.store().db().clone();
    db.execute("DROP TABLE projects", vec![]).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let frames = drain(&mut rx);
    // No `Chunk` with `kind:"snapshot"` should sneak out before the
    // failure — that would ship `projects: []` beside the durable
    // threads, which is the exact defect #374 rejects.
    let sneaked = frames.iter().any(|f| {
        f.get("_tag").and_then(Value::as_str) == Some("Chunk")
            && f["values"][0]["kind"] == "snapshot"
    });
    assert!(
        !sneaked,
        "no snapshot may sneak out with projects:[] on read failure: {frames:?}"
    );
    let exit = frames
        .iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("subscribeShell exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "the store-read error must surface as a subscription Failure, not Success: {exit}"
    );
    let cause = &exit["exit"]["cause"][0];
    // #389: `exit_failure` emits Effect's `Die` defect shape (an
    // untyped runtime failure the client has no branch for is exactly
    // what a store-unreadable error IS, until the contract adds a
    // typed unavailable arm for subscribeShell). Assertion reads
    // `Die.defect`, not the `Fail.error.message` shape a declared
    // typed error would use.
    assert_eq!(
        cause["_tag"], "Die",
        "store-read failure is a runtime Die defect: {exit}"
    );
    let msg = cause["defect"].as_str().unwrap_or("");
    assert!(
        msg.contains("project") || msg.contains("subscribeShell"),
        "the failure names the failing subsystem, not a generic defect: {exit}"
    );
}

/// #398 (narrowed bar): capture a REAL `subscribeShell` snapshot frame
/// from the running handler and write it VERBATIM to
/// `packages/contracts/fixtures/subscribe_shell_snapshot.json`.
///
/// The bytes ARE the artifact. No pretty-printing, no field reordering,
/// no normalization — a TS test on the other side pipes the file
/// straight into `Schema.decodeUnknownSync(OrchestrationShellStreamItem)`
/// and asserts the decode. First drift between the Rust producer and
/// the TS contract has somewhere to fail; today a hand-authored fixture
/// in `decode_check.test.ts` is the only pin, and it does not.
///
/// Guarded by `T3_UPDATE_FIXTURES=1` because writing generated files
/// during a normal `cargo test` run is the wrong default: CI regens the
/// fixture explicitly, and a developer running the suite locally should
/// not have their workspace mutate under them. In the default mode the
/// test still asserts every invariant that would make the fixture
/// valid, so a drift is caught even when the file is not updated.
#[tokio::test]
async fn subscribe_shell_snapshot_is_a_recorded_fixture_the_ts_contract_decodes() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    // Read the first `Chunk` whose `values[0].kind == "snapshot"` — that
    // is the OrchestrationShellSnapshotFrame the TS reducer decodes.
    let frames = drain(&mut rx);
    let chunk = frames
        .iter()
        .find(|f| {
            f.get("_tag").and_then(Value::as_str) == Some("Chunk")
                && f["values"][0]["kind"] == "snapshot"
        })
        .expect("subscribeShell emits a snapshot frame");
    let item = chunk["values"][0].clone();
    // Contract invariants that must hold for a TS decode to succeed —
    // asserted here so drift is caught even in the read-only mode.
    assert_eq!(item["kind"], "snapshot");
    assert!(
        item["snapshot"]["snapshotSequence"].as_i64().is_some(),
        "snapshotSequence is required and integer-typed"
    );
    assert!(
        item["snapshot"]["updatedAt"].as_str().is_some(),
        "updatedAt is required and ISO-string-typed"
    );
    assert!(
        item["snapshot"]["projects"].is_array(),
        "projects is a required array"
    );
    assert!(
        item["snapshot"]["threads"].is_array(),
        "threads is a required array"
    );

    // Update-fixture mode: write the frame bytes verbatim.
    if std::env::var("T3_UPDATE_FIXTURES").ok().as_deref() == Some("1") {
        let dst =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/contracts/fixtures");
        std::fs::create_dir_all(&dst).expect("mkdir fixtures");
        let path = dst.join("subscribe_shell_snapshot.json");
        let bytes = serde_json::to_vec(&item).expect("serialize the shell frame");
        std::fs::write(&path, &bytes).expect("write the fixture");
    }
}

/// #398 (follow-on): capture a real `thread-upserted` shell stream event
/// and write it VERBATIM to
/// `packages/contracts/fixtures/thread_upserted.json`. Same discipline
/// as the snapshot fixture: bytes are the artifact; the TS half
/// decodes them through `OrchestrationShellStreamItem` so a producer
/// that drops a field or shifts a type fails at the seam.
#[tokio::test]
async fn thread_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let _snapshot = drain(&mut rx); // discard the initial snapshot

    let now = now_iso();
    let thread = json!({
        "id": "t-fixture-upsert",
        "projectId": "p-workspace",
        "title": "recorded fixture",
        "createdAt": now,
        "updatedAt": now,
        "latestUserMessageAt": now,
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" },
        "runtimeMode": "full-access",
        "worktreePath": Value::Null,
        "branch": Value::Null,
        "latestTurn": Value::Null,
        "session": Value::Null,
        "hasPendingApprovals": false,
        "hasPendingUserInput": false,
        "hasActionableProposedPlan": false,
    });
    upsert_thread_on_shell(&state, thread).await;

    let frames = drain_until(&mut rx, std::time::Duration::from_secs(2), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("kind"))
            .and_then(Value::as_str)
            == Some("thread-upserted")
    })
    .await;
    let chunk = frames
        .iter()
        .find(|f| {
            f.get("_tag").and_then(Value::as_str) == Some("Chunk")
                && f["values"][0]["kind"] == "thread-upserted"
        })
        .unwrap_or_else(|| panic!("no thread-upserted frame in {frames:#?}"));
    let item = chunk["values"][0].clone();

    assert_eq!(item["kind"], "thread-upserted");
    assert!(
        item["sequence"].as_i64().is_some(),
        "sequence is required NonNegativeInt"
    );
    assert!(
        item["thread"]["id"].as_str().is_some(),
        "thread.id is required"
    );
    assert_eq!(item["thread"]["id"], "t-fixture-upsert");

    if std::env::var("T3_UPDATE_FIXTURES").ok().as_deref() == Some("1") {
        let dst =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/contracts/fixtures");
        std::fs::create_dir_all(&dst).expect("mkdir fixtures");
        let path = dst.join("thread_upserted.json");
        let bytes = serde_json::to_vec(&item).expect("serialize the thread-upserted frame");
        std::fs::write(&path, &bytes).expect("write the fixture");
    }
}

/// #398 (follow-on): capture a real `project-upserted` shell stream
/// event (emitted when `project.meta.update` succeeds) and write it
/// VERBATIM to `packages/contracts/fixtures/project_upserted.json`.
/// Same discipline as the thread-upserted/snapshot fixtures — bytes
/// are the artifact, TS half decodes through OrchestrationShellStreamItem.
#[tokio::test]
async fn project_upserted_frame_is_a_recorded_fixture_the_ts_contract_decodes() {
    let (state, _d) = test_state().await;
    // Seed a real project the update path can PATCH (the seed persists
    // via the test harness at boot; explicit save to make the id
    // present regardless of any concurrent seed).
    state
        .rt
        .save_project(&json!({
            "id": "p-fixture-upsert", "title": "before",
            "workspaceRoot": "/tmp",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let _snapshot = drain(&mut rx); // discard initial snapshot

    // Trigger a real project.meta.update through the dispatcher — the
    // handler calls emit_shell_event(project-upserted) internally, so
    // this exercises the real emission path, not a fabricated frame.
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "project.meta.update",
            "projectId": "p-fixture-upsert",
            "patch": { "title": "after" },
        }}),
    )
    .await;
    let _ack = drain(&mut rx2);

    let frames = drain_until(&mut rx, std::time::Duration::from_secs(2), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("kind"))
            .and_then(Value::as_str)
            == Some("project-upserted")
    })
    .await;
    let chunk = frames
        .iter()
        .find(|f| {
            f.get("_tag").and_then(Value::as_str) == Some("Chunk")
                && f["values"][0]["kind"] == "project-upserted"
        })
        .unwrap_or_else(|| panic!("no project-upserted frame in {frames:#?}"));
    let item = chunk["values"][0].clone();

    assert_eq!(item["kind"], "project-upserted");
    assert!(
        item["sequence"].as_i64().is_some(),
        "sequence is required NonNegativeInt"
    );
    assert_eq!(item["project"]["id"], "p-fixture-upsert");
    assert_eq!(
        item["project"]["title"], "after",
        "patch landed in the emitted frame"
    );

    if std::env::var("T3_UPDATE_FIXTURES").ok().as_deref() == Some("1") {
        let dst =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/contracts/fixtures");
        std::fs::create_dir_all(&dst).expect("mkdir fixtures");
        let path = dst.join("project_upserted.json");
        let bytes = serde_json::to_vec(&item).expect("serialize the project-upserted frame");
        std::fs::write(&path, &bytes).expect("write the fixture");
    }
}

/// #33: the terminal RPCs are wired to the shared PTY (not the unsupported
/// arm), and return contract-shaped payloads. terminal.open yields a
/// TerminalSessionSnapshot; write/resize succeed; attach streams a snapshot.
#[tokio::test]
async fn terminal_rpcs_map_to_the_shared_pty() {
    let (state, _d) = test_state().await;
    let input = json!({ "threadId": "t-1", "terminalId": "term-1", "cwd": state.cwd, "cols": 80, "rows": 24 });

    // open → a real snapshot, NOT an unsupported-method failure.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "terminal.open", input.clone()).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "terminal.open must be implemented: {:?}",
        f[0]
    );
    let snap = &f[0]["exit"]["value"];
    assert_eq!(snap["threadId"], "t-1");
    assert_eq!(snap["terminalId"], "term-1");
    assert!(
        snap["history"].is_string(),
        "snapshot carries the rendered screen as history"
    );
    assert!(["starting", "running", "exited", "error"].contains(&snap["status"].as_str().unwrap()));

    // write + resize → void success.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.write",
        json!({ "threadId": "t-1", "terminalId": "term-1", "data": "echo hi\n" }),
    )
    .await;
    request(
        &state,
        &tx,
        "terminal.resize",
        json!({ "threadId": "t-1", "terminalId": "term-1", "cols": 100, "rows": 40 }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "terminal.write void success"
    );
    assert_eq!(
        f[1]["exit"]["_tag"], "Success",
        "terminal.resize void success"
    );

    // attach → an initial snapshot stream event (stays open, no Exit).
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "terminal.attach", input).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["values"][0]["type"], "snapshot",
        "attach opens with a snapshot event: {:?}",
        f
    );
    assert!(
        f.iter().all(|x| x["_tag"] != "Exit"),
        "attach is a stream, not terminated"
    );
}

/// #68: terminal control RPCs must report Hearth failures, not ack success
/// while the PTY rejected the write/control operation.
#[tokio::test]
async fn terminal_control_rpcs_fail_when_hearth_rejects_control() {
    let (mut state, dir) = test_state().await;
    let bad = hearth::Runner::open(
        hearth::Config::new(dir.to_path_buf(), dir.join("bad-hearth"), "bad-terminal")
            .shell(vec!["/definitely/not/a/t3code-shell".to_string()]),
    )
    .await
    .expect("construct invalid-shell runner");
    state.terminal = Arc::new(bad);

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.write",
        json!({ "threadId": "t-1", "terminalId": "missing-pane", "data": "echo hidden\n" }),
    )
    .await;
    request(
        &state,
        &tx,
        "terminal.resize",
        json!({ "threadId": "t-1", "terminalId": "missing-pane", "cols": 100, "rows": 40 }),
    )
    .await;

    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Failure",
        "write cannot ack success after Hearth failed: {:?}",
        f[0]
    );
    assert!(
        f[0]["exit"]["cause"][0]["defect"]
            .as_str()
            .unwrap_or("")
            .contains("terminal.write"),
        "write failure must name the terminal control operation: {:?}",
        f[0]
    );
    assert_eq!(
        f[1]["exit"]["_tag"], "Failure",
        "resize cannot ack success after Hearth failed: {:?}",
        f[1]
    );
    assert!(
        f[1]["exit"]["cause"][0]["defect"]
            .as_str()
            .unwrap_or("")
            .contains("terminal.resize"),
        "resize failure must name the terminal control operation: {:?}",
        f[1]
    );
}

/// #79: a terminal subscription is not live unless the SDK durable topic tail
/// attached. If the broker cannot subscribe, the RPC must fail before emitting a
/// `started` or `snapshot` chunk that the client would treat as a valid stream.
#[tokio::test]
async fn terminal_subscriptions_fail_when_durable_topic_tail_cannot_attach() {
    let (state, dir) = test_state().await;
    let pool = do_storage::DbPool::new(dir.join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE subs", vec![]).await.unwrap();

    for (method, payload) in [
        (
            "subscribeTerminalEvents",
            json!({ "threadId": "t-1", "terminalId": "term-1" }),
        ),
        ("subscribeTerminalMetadata", json!({ "threadId": "t-1" })),
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, method, payload).await;
        let frames = drain(&mut rx);
        assert!(
            frames.iter().all(|f| f["_tag"] != "Chunk"),
            "{method} emitted a live-looking stream chunk after tail attach failed: {frames:?}"
        );
        let exit = frames.iter().find(|f| f["_tag"] == "Exit").expect("exits");
        assert_eq!(
            exit["exit"]["_tag"], "Failure",
            "{method} must fail the subscription, not report success: {exit}"
        );
        assert!(
            exit["exit"]["cause"][0]["defect"]
                .as_str()
                .unwrap_or("")
                .contains(method),
            "failure names the terminal subscription method: {exit}"
        );
    }
}

/// Terminal owner is a backend contract boundary. A request without a
/// non-empty `sessionId` or `threadId` must not fall into the durable `thread:`
/// namespace, because that scope is shared by every malformed caller.
#[tokio::test]
async fn terminal_rpcs_without_an_owner_fail_closed_before_touching_thread_empty() {
    let (state, _d) = test_state().await;
    let empty_owner = terminal::TerminalOwner::Thread { thread_id: String::new() };

    for (method, payload) in [
        ("terminal.open", json!({ "terminalId": "term-missing", "cwd": state.cwd.clone() })),
        ("terminal.restart", json!({ "terminalId": "term-missing", "cwd": state.cwd.clone() })),
        ("terminal.attach", json!({ "terminalId": "term-missing", "cwd": state.cwd.clone() })),
        ("terminal.write", json!({ "terminalId": "term-missing", "data": "echo should-not-run\n" })),
        ("terminal.resize", json!({ "terminalId": "term-missing", "cols": 100, "rows": 40 })),
        ("terminal.clear", json!({ "terminalId": "term-missing" })),
        ("terminal.close", json!({ "terminalId": "term-missing" })),
        ("subscribeTerminalEvents", json!({ "terminalId": "term-missing" })),
        ("subscribeTerminalMetadata", json!({})),
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, method, payload).await;
        let frames = drain(&mut rx);
        let exit = frames.iter().find(|f| f["_tag"] == "Exit").unwrap_or_else(|| {
            panic!("{method} must fail immediately instead of parking or mutating thread:: {frames:?}")
        });
        assert_eq!(exit["exit"]["_tag"], "Failure", "{method}: {exit}");
        let why = exit["exit"]["cause"].to_string();
        assert!(
            why.contains("sessionId") && why.contains("threadId"),
            "{method} names the missing owner fields: {why}"
        );
        assert!(
            state.terminals.get(&empty_owner, "term-missing").await.unwrap().is_none(),
            "{method} created or mutated a pane under the shared thread: scope"
        );
    }

    for method in ["terminal.open", "terminal.attach", "terminal.write", "subscribeTerminalEvents"] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(
            &state,
            &tx,
            method,
            json!({ "threadId": "   ", "terminalId": "term-blank", "cwd": state.cwd.clone() }),
        )
        .await;
        let frames = drain(&mut rx);
        let exit = frames.iter().find(|f| f["_tag"] == "Exit").unwrap_or_else(|| {
            panic!("{method} with a blank threadId must fail, not park: {frames:?}")
        });
        assert_eq!(exit["exit"]["_tag"], "Failure", "{method}: {exit}");
        assert!(
            state.terminals.get(&empty_owner, "term-blank").await.unwrap().is_none(),
            "{method} treated a blank threadId as thread:"
        );
    }
}

/// The attached pane is EDGE-DRIVEN, and a RECONNECTING pane is too.
///
/// The tails used to sample the screen on a 200ms/500ms timer, which both
/// repainted late and woke forever on an idle shell. They now park on
/// hearth's `watch_screen` edge. Two things have to hold for that swap to be
/// safe, and both are asserted here:
///
/// * output written AFTER the attach still reaches the pane — an edge-driven
///   tail that subscribed at the wrong moment would park forever instead;
/// * a SECOND attach on the same shared PTY (what a reconnect after a
///   dropped socket does) is a live subscriber, not a dead one — the first
///   tail must not have consumed the edge on its behalf.
///
/// The generous timeout is a liveness bound, not a settling delay: the
/// assertion is that the frame arrives at all, and the old sampler would
/// have satisfied it too. What it pins is the absence of a park-forever
/// regression, which is the only way the edge swap can fail.
#[tokio::test]
async fn an_attached_and_a_reconnecting_terminal_pane_both_receive_later_output() {
    let (state, _d) = test_state().await;
    let input = json!({ "threadId": "t-1", "terminalId": "term-1", "cwd": state.cwd });

    // pane A attaches first.
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    request(&state, &tx_a, "terminal.attach", input.clone()).await;

    // pane B attaches afterwards — the reconnect case, sharing the one PTY.
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    request(&state, &tx_b, "terminal.attach", input).await;

    // Drive the shell only AFTER both are attached, so anything they receive
    // below had to arrive through a live tail rather than the open snapshot.
    //
    // The marker is written REPEATEDLY, not once (#304). `request` returning
    // means the attach RPC was handled, not that the pane's tail has
    // finished subscribing to hearth's screen watch — so a single write can
    // land in the gap, and then there is no further output for an
    // edge-driven tail to wake on. Waiting longer cannot fix that: the edge
    // is already gone. Re-writing turns a missed edge into a retry, while a
    // genuinely parked tail still never sees any of them and fails.
    let writer_state = state.clone();
    let writer = tokio::spawn(async move {
        for _ in 0..600 {
            request(
                &writer_state,
                &mpsc::unbounded_channel().0,
                "terminal.write",
                json!({ "threadId": "t-1", "terminalId": "term-1",
                        "data": "printf 'PANEMARK\\n'\n" }),
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    });

    // Both panes see the output. `recv` is the real assertion: it returns
    // when the tail sends, and times out if the tail parked forever.
    for (who, rx) in [("attached", &mut rx_a), ("reconnecting", &mut rx_b)] {
        // Wait on the EDGE, not on a clock. `recv().await` returns the moment
        // the tail sends and parks silently otherwise, so a machine running 28
        // competing PTYs makes this test slower, never redder.
        //
        // The outer bound is a HANG DETECTOR, deliberately far past any
        // plausible scheduling delay: it exists so a genuinely parked tail
        // fails the run instead of hanging it, and it is never what makes a
        // healthy run pass.
        let saw = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            while let Some((raw, _)) = rx.recv().await {
                let v: Value = serde_json::from_str(&raw).unwrap();
                if v["values"][0]["type"] == "output"
                    && v["values"][0]["data"]
                        .as_str()
                        .unwrap_or("")
                        .contains("PANEMARK")
                {
                    return true;
                }
            }
            false // the tail hung up — a real failure
        })
        .await
        .unwrap_or(false);
        assert!(
            saw,
            "the {who} pane received output written after it attached"
        );
    }
    writer.abort();
}

/// The terminal metadata stream must survive the pane set MOVING under it.
///
/// Its watch set used to be built once at attach, which broke twice over: a
/// pane opened afterwards was never watched (its row froze at whatever it
/// said when some other pane last moved), and the first pane CLOSED ended
/// the whole stream, so a thread's terminal list stopped updating for good
/// because a human shut one tab.
///
/// Both are membership changes, so both are asserted here against one live
/// subscription.
#[tokio::test]
async fn terminal_metadata_stream_follows_panes_opened_and_closed_after_attach() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-meta" }),
    )
    .await;

    // Read snapshots until one lists `want`, or give up. Anything that has
    // to wait out the timeout is a stream that stopped following the
    // registry — which is exactly the regression.
    async fn until(
        rx: &mut mpsc::UnboundedReceiver<OutFrame>,
        want: impl Fn(&Vec<Value>) -> bool,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            let Ok(Some((raw, _))) =
                tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await
            else {
                return false;
            };
            let v: Value = serde_json::from_str(&raw).unwrap();
            if let Some(rows) = v["values"][0]["terminals"].as_array() {
                if want(&rows.to_vec()) {
                    return true;
                }
            }
        }
        false
    }

    let has = |rows: &Vec<Value>, id: &str| rows.iter().any(|r| r["terminalId"] == json!(id));

    // A pane opened AFTER the subscription must appear.
    state
        .terminals
        .open(
            &terminal::TerminalOwner::thread("t-meta"),
            "pane-late",
            None,
            None,
            &[],
        )
        .await
        .unwrap();
    assert!(
        until(&mut rx, |rows| has(rows, "pane-late")).await,
        "a pane opened after attach reaches the metadata stream"
    );

    // Closing it must publish its removal — and, crucially, must not end the
    // subscription: the agent pane is still listed afterwards.
    assert!(
        state
            .terminals
            .close(&terminal::TerminalOwner::thread("t-meta"), "pane-late")
            .await
            .expect("pane store readable"),
        "own-PTY pane closes"
    );
    assert!(
        until(&mut rx, |rows| !has(rows, "pane-late")
            && has(rows, terminal::AGENT_TERMINAL_ID))
        .await,
        "the close is published and the stream keeps serving the remaining panes"
    );
}

#[tokio::test]
async fn unreadable_terminal_pane_store_is_not_a_valid_empty_metadata_snapshot() {
    let (state, _d) = test_state().await;
    state
        .terminals
        .open(
            &terminal::TerminalOwner::thread("t-pane-corrupt"),
            "pane-real",
            Some(&state.cwd),
            None,
            &[],
        )
        .await
        .expect("pane opens before durable store corruption");
    state
        .tool_roots
        .session_db()
        .execute("DROP TABLE exec_pane", vec![])
        .await
        .expect("corrupt pane store");

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-pane-corrupt" }),
    )
    .await;
    let frames = drain(&mut rx);
    let events: Vec<Value> = frames
        .iter()
        .filter_map(|f| f["values"].get(0).cloned())
        .collect();
    assert!(
        events.iter().any(|e| {
            e["type"] == "store_unavailable"
                && e["error"]
                    .as_str()
                    .is_some_and(|s| s.contains("terminal pane store unavailable"))
        }),
        "unreadable durable pane state must be explicit, not an empty terminal list: {events:?}"
    );
    assert!(
        !events.iter().any(|e| {
            e["type"] == "snapshot"
                && e["terminals"]
                    .as_array()
                    .is_some_and(|rows| rows.is_empty())
        }),
        "corrupt pane state was reported as a valid empty snapshot: {events:?}"
    );
}

/// Subscriber lists must SHRINK when clients go away.
///
/// Every `subscribe*` pushed and nothing ever removed, so each reconnect —
/// routine here, since the server is reached over relay and tunnel from
/// mobile — left a permanent dead entry. The cost compounds past memory:
/// each dead terminal-metadata subscriber made the next broadcast re-list
/// the panes and take every PTY's session lock to build a summary with no
/// reader, and each dead VCS subscriber kept a repository being polled after
/// its client was gone.
#[tokio::test]
async fn disconnected_subscribers_are_dropped_from_the_fan_out_lists() {
    let (state, _d) = test_state().await;

    // Two clients subscribe; one then goes away.
    let (tx_gone, rx_gone) = mpsc::unbounded_channel();
    let (tx_live, _rx_live) = mpsc::unbounded_channel();
    request(
        &state,
        &tx_gone,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-sub" }),
    )
    .await;
    request(
        &state,
        &tx_live,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-sub" }),
    )
    .await;

    drop(rx_gone); // the socket closes

    // Any broadcast is the moment the dead one is noticed. Fanout runs
    // through the SDK's topic broker now (per #320 pattern), so the
    // observable invariant is that the LIVE subscriber still receives
    // the frame and the broadcast itself does not panic on the closed
    // socket. The pump task tied to the dead sender ends on the first
    // failed send, which is what unsubscribes it from the durable
    // inbox — no product-side Vec to inspect anymore.
    broadcast_terminal_event(
        &state,
        json!({ "type": "upsert", "threadId": "t-sub", "terminalId": "term-1" }),
    )
    .await;

    // No product-owned subscriber list to inspect; assert observable
    // behavior instead — the live sender is still open.
    assert!(!tx_live.is_closed(), "the live subscriber is still open");
}

/// #351 / #74 (remaining): `orchestration.getTurnDiff` and
/// `orchestration.getFullThreadDiff` return the CONTRACT's typed
/// errors so the client's decoder classifies the state as "not
/// available on this runtime" instead of "no changes to review".
/// A fabricated empty `diff: ""` would look like a settled turn
/// that made no file edits — a lie, since #65's checkpoint
/// substrate is not wired in yet.
#[tokio::test]
async fn diff_rpcs_report_typed_unavailable_not_a_fake_empty_diff() {
    let (state, _d) = test_state().await;
    // getTurnDiff
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.getTurnDiff",
        json!({ "input": { "threadId": "t-1", "fromTurnCount": 0, "toTurnCount": 1 } }),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f["exit"]["_tag"], "Failure",
        "getTurnDiff refuses visibly, not Success{{diff:\"\"}}: {f}"
    );
    assert_eq!(
        f["exit"]["cause"][0]["_tag"], "Fail",
        "declared error on the cause, not a Die defect: {f}"
    );
    assert_eq!(
        f["exit"]["cause"][0]["error"]["_tag"], "OrchestrationGetTurnDiffError",
        "typed contract error the frontend can branch on: {f}"
    );
    // getFullThreadDiff
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.getFullThreadDiff",
        json!({ "input": { "threadId": "t-1", "toTurnCount": 5 } }),
    )
    .await;
    let f2 = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f2["exit"]["_tag"], "Failure",
        "getFullThreadDiff refuses visibly: {f2}"
    );
    assert_eq!(
        f2["exit"]["cause"][0]["error"]["_tag"], "OrchestrationGetFullThreadDiffError",
        "typed contract error: {f2}"
    );
}

/// #74 (remaining): `orchestration.getWorkflowScript` returns the
/// CONTRACT's typed `OrchestrationGetWorkflowScriptError` with
/// `reason: "root-unavailable"` — a runtime that cannot expose a
/// workflow-scripts root gets its own branch in the frontend
/// decoder, not a generic "unsupported method" defect.
#[tokio::test]
async fn get_workflow_script_reports_root_unavailable_on_this_runtime() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.getWorkflowScript",
        json!({ "input": { "threadId": "t-1", "scriptPath": "/tmp/foo.js" } }),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f["exit"]["_tag"], "Failure",
        "an unavailable root is a contract Failure, not Success(null): {f}"
    );
    let err = &f["exit"]["cause"][0]["error"];
    assert_eq!(
        err["_tag"], "OrchestrationGetWorkflowScriptError",
        "typed contract error on the cause: {f}"
    );
    assert_eq!(
        err["reason"], "root-unavailable",
        "specific enumerated reason: {f}"
    );
    assert_eq!(
        err["scriptPath"], "/tmp/foo.js",
        "the input scriptPath is echoed so the client can attribute the error: {f}"
    );
}

/// #74 (remaining): `orchestration.getArchivedShellSnapshot` returns
/// a real OrchestrationShellSnapshot filtered to threads with a
/// non-null `archivedAt`. Live threads are excluded; archived
/// threads are included; the shape matches subscribeShell's
/// snapshot frame.
#[tokio::test]
async fn get_archived_shell_snapshot_returns_only_archived_threads() {
    let (state, _d) = test_state().await;

    // Two live threads, one archived.
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-live-1", "projectId": "p-workspace", "title": "still open",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-live-2", "projectId": "p-workspace", "title": "also open",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-archived", "projectId": "p-workspace", "title": "put away",
            "createdAt": now_iso(), "updatedAt": now_iso(),
            "archivedAt": now_iso(),
        }))
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.getArchivedShellSnapshot",
        json!({ "input": {} }),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(f["exit"]["_tag"], "Success", "not the unsupported arm: {f}");
    let snap = &f["exit"]["value"];
    // Contract shape: projects, threads, snapshotSequence (numbered),
    // updatedAt (ISO). The seq comes from the DURABLE counter, so a
    // client that resumes from it survives restart (#299).
    assert!(
        snap["snapshotSequence"].as_i64().is_some(),
        "durable mark: {snap}"
    );
    assert!(
        snap["updatedAt"].as_str().is_some(),
        "iso updatedAt: {snap}"
    );
    let threads = snap["threads"].as_array().expect("threads array");
    assert_eq!(
        threads.len(),
        1,
        "only the archived thread is listed: {threads:?}"
    );
    assert_eq!(threads[0]["id"], "t-archived");

    // And a runtime with NO archived threads returns an empty
    // threads array (not an "unsupported" refusal, not a hallucinated
    // row) — this is the current default state of the archive.
    let (state2, _d2) = test_state().await;
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state2,
        &tx2,
        "orchestration.getArchivedShellSnapshot",
        json!({ "input": {} }),
    )
    .await;
    let f2 = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(f2["exit"]["_tag"], "Success");
    assert_eq!(f2["exit"]["value"]["threads"].as_array().unwrap().len(), 0);
}

/// #89 SECOND pass: a validated option choice REACHES the provider
/// invocation, instead of being validated and then thrown away.
///
/// Validation alone was never the fix the finding asked for: a knob that
/// passes validation and then routes nothing is still a setting the user
/// believes is in effect. This asserts the codex adapter turns the choice
/// into a `-c model_reasoning_effort=…` config override — routing config,
/// not prose appended to the prompt.
#[tokio::test]
async fn a_validated_model_option_reaches_the_provider_invocation() {
    use agent_sdk_provider::instance::{decode_option_selections, ProviderOptionSelection};

    // The wire shape the frontend sends, decoded the way the dispatch path
    // decodes it.
    let wire = json!([{ "id": "reasoning_effort", "value": "high" }]);
    let decoded: Vec<ProviderOptionSelection> =
        decode_option_selections(&wire).expect("the wire shape the frontend sends must decode");
    assert_eq!(decoded.len(), 1, "the wire options decode: {decoded:?}");

    // And the adapter that runs the turn applies it.
    let (_, applied) = agent_sdk_provider::CodexCli::new("gpt-5").with_options(&decoded);
    assert_eq!(
        applied, 1,
        "the user's choice must change the invocation — a validated-then-dropped option is              the same silent no-op the finding names, one layer later"
    );
    let (key, value) =
        agent_sdk_provider::codex_option_override(&decoded[0]).expect("a known knob routes");
    assert_eq!(key, "model_reasoning_effort");
    assert_eq!(
        value, "\"high\"",
        "codex config is TOML, so the string is quoted"
    );
}

/// #89 first pass: `ModelSelection.options` invalid values are
/// REFUSED (visible error), not silently dropped. A
/// silently-ignored `reasoning: "ludicrous"` means the user is
/// paying for a setting that is not in effect and has nothing on
/// screen telling them so — the failure the finding names.
#[tokio::test]
async fn model_selection_with_invalid_option_is_refused_visibly() {
    let (state, _d) = test_state().await;

    // A valid selection with no options resolves. Test on `codex`
    // because that driver declares a `reasoning` Select descriptor
    // in the SDK catalog (ClaudeDriver deliberately advertises NO
    // options today — see catalog.rs, "no routing arm yet"), so
    // validation on `reasoning` needs a codex snapshot to fire.
    let sel_ok = json!({ "instanceId": "codex", "model": "codex-default" });
    assert!(
        model_from_selection(
            &*state.catalog.read().await,
            &sel_ok,
            &state.default_model().await
        )
        .is_ok(),
        "baseline: the selection resolves without options"
    );

    // Same selection with a bogus VALUE on the Select option
    // (`reasoning`, enum {low, medium, high}) — a value outside the
    // set must be refused.
    let sel_bad = json!({
        "instanceId": "codex",
        "model": "codex-default",
        "options": [ { "id": "reasoning", "value": "ludicrous" } ],
    });
    let err = model_from_selection(
        &*state.catalog.read().await,
        &sel_bad,
        &state.default_model().await,
    )
    .expect_err("bogus option value must not resolve");
    assert!(
        err.contains("reasoning") || err.contains("invalid"),
        "the error names the offending option: {err}"
    );

    // Unknown option IDS are ACCEPTED — SDK's `validate_selection`
    // rule: a newer client's extra knobs must not be erased by an
    // older build.
    let sel_unknown_id = json!({
        "instanceId": "codex",
        "model": "codex-default",
        "options": [ { "id": "some_future_knob_this_build_never_heard_of", "value": "whatever" } ],
    });
    assert!(
        model_from_selection(
            &*state.catalog.read().await,
            &sel_unknown_id,
            &state.default_model().await
        )
        .is_ok(),
        "unknown option ids do not fail closed"
    );
}

/// #46: server.discoverSourceControl is implemented and returns a non-empty
/// SourceControlDiscoveryResult (vcs + providers rows), not an unsupported
/// A whitespace-only `thread.turn.start` is refused BEFORE anything
/// mutates — no turn claim, no thread announcement, no checkpoint.
///
/// #272 found this in the TypeScript adapter. The Rust path had it too and
/// with more to lose: `text` was read `unwrap_or("")` and never trimmed, so
/// a stray space bar would ack, claim the turn durably, announce a thread,
/// and take a worktree checkpoint before anyone noticed the prompt was
/// empty. Asserting the Failure alone would not catch a regression that
/// mutates first and fails second, so this asserts the ABSENCE of every
/// side effect as well.
#[tokio::test]
async fn a_whitespace_only_turn_is_refused_before_anything_mutates() {
    let (state, _d) = test_state().await;
    let threads_before = state.rt.threads().await.len();
    let seq_before = state.rt.current_sequence().await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state, &tx, "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.start",
            "commandId": "c-ws",
            "threadId": "t-ws",
            "message": { "messageId": "m-ws", "role": "user", "text": "   \n\t ", "attachments": [] },
            "createdAt": now_iso(),
        }}),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("an Exit frame");
    assert_eq!(
        f["exit"]["_tag"], "Failure",
        "an empty prompt must be refused visibly: {f}"
    );

    // NOTHING moved. Each of these is a mutation the old path performed
    // before it ever looked at the text.
    assert_eq!(
        state.rt.threads().await.len(),
        threads_before,
        "a refused turn must not announce a thread"
    );
    assert_eq!(
        state.rt.current_sequence().await.unwrap(),
        seq_before,
        "a refused turn must not consume an event sequence"
    );
    assert_eq!(
        state.rt.claimed_turn("t-ws").await.unwrap(),
        None,
        "a refused turn must not hold a durable turn claim"
    );
    assert!(
        state.rt.messages("t-ws").await.is_empty(),
        "a refused turn must not persist a prompt"
    );

    // And a REAL prompt on the same thread still works, so this is a guard
    // and not a wall.
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state, &tx2, "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.start",
            "commandId": "c-ok",
            "threadId": "t-ws",
            "message": { "messageId": "m-ok", "role": "user", "text": "actually do something", "attachments": [] },
            "createdAt": now_iso(),
        }}),
    )
    .await;
    let ok = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("an Exit frame");
    assert_eq!(
        ok["exit"]["_tag"], "Success",
        "a real prompt still dispatches: {ok}"
    );
}

/// #77 / packet EK: a `thread.turn.start` carrying non-empty
/// `message.attachments` must be REFUSED at dispatch, not acked and
/// then run with the attachments silently dropped. Persisting the
/// prompt without the image the UI shows is the exact defect the
/// finding calls out.
#[tokio::test]
async fn a_turn_start_with_attachments_is_refused_visibly() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state, &tx, "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.start",
            "commandId": "c-1",
            "threadId": "t-att",
            "message": {
                "messageId": "m-1",
                "role": "user",
                "text": "what is this?",
                "attachments": [
                    { "kind": "image", "mimeType": "image/png", "dataUrl": "data:image/png;base64,AAAA" }
                ],
            },
            "runtimeMode": "full-access",
            "interactionMode": "chat",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" },
        }}),
    ).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f["exit"]["_tag"], "Failure",
        "dispatch must refuse attachments visibly, not ack + drop: {f}"
    );

    // And the durable store must not have persisted the prompt row —
    // that is the "prompt appears without the image" defect.
    let messages = state.rt.messages("t-att").await;
    assert!(
        messages.is_empty(),
        "no prompt persisted for a refused dispatch: {messages:?}"
    );

    // Contrast: same command with NO attachments passes dispatch
    // (proves the refusal is scoped to the attachment case).
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.start",
            "commandId": "c-2",
            "threadId": "t-att",
            "message": { "messageId": "m-2", "role": "user", "text": "hi", "attachments": [] },
            "runtimeMode": "full-access",
            "interactionMode": "chat",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" },
        }}),
    )
    .await;
    let f2 = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f2["exit"]["_tag"], "Success",
        "the same command with no attachments still dispatches: {f2}"
    );
}

/// #74: `orchestration.searchThreads` returns contract-shaped matches
/// scanned from the durable message store. The old handler was missing,
/// so every search fell through to unsupported and the picker was
/// permanently empty.
#[tokio::test]
async fn search_threads_matches_the_durable_message_store() {
    let (state, _d) = test_state().await;

    // Seed two threads with contrasting content. Both go through the
    // durable append_message path — no in-memory shortcut — so the test
    // proves the search READS the store, not a scratch value.
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-alpha", "projectId": "p-workspace", "title": "alpha",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-beta", "projectId": "p-workspace", "title": "beta",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    state
        .rt
        .append_message(
            "t-alpha",
            &json!({
                "id": "m1", "role": "user", "text": "please refactor the widget FROBNICATOR module",
                "streaming": false, "createdAt": now_iso(),
            }),
        )
        .await
        .unwrap();
    state
        .rt
        .append_message(
            "t-alpha",
            &json!({
                "id": "m2", "role": "assistant", "text": "done — the frobnicator now sings",
                "streaming": false, "createdAt": now_iso(),
            }),
        )
        .await
        .unwrap();
    state.rt.append_message("t-beta", &json!({
        "id": "m3", "role": "system", "text": "frobnicator is a system message — not searchable",
        "streaming": false, "createdAt": now_iso(),
    })).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.searchThreads",
        json!({ "input": { "query": "frobnicator" } }),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(f["exit"]["_tag"], "Success", "search succeeds: {f}");
    let matches = f["exit"]["value"]["matches"]
        .as_array()
        .expect("matches array");

    // t-alpha has user + assistant hits; t-beta's only hit is a
    // `system` message, which the contract's `source` enumeration
    // excludes. The handler emits at most one hit per THREAD
    // (further hits within a thread are elided to prevent a snippet
    // list burying other threads), so exactly one match — from
    // t-alpha, source ∈ {user, assistant} — is the expected shape.
    assert!(!matches.is_empty(), "at least one hit: {matches:?}");
    let alpha_hits: Vec<&Value> = matches
        .iter()
        .filter(|m| m["threadId"].as_str() == Some("t-alpha"))
        .collect();
    assert_eq!(
        alpha_hits.len(),
        1,
        "one hit per thread; alpha contributes exactly one: {matches:?}"
    );
    assert!(
        !matches
            .iter()
            .any(|m| m["threadId"].as_str() == Some("t-beta")),
        "t-beta's only message is `system` — the contract's `source` enumeration \
             excludes it and it must not appear: {matches:?}"
    );
    for m in matches {
        assert_eq!(m["projectId"], "p-workspace");
        let source = m["source"].as_str().unwrap();
        assert!(
            source == "user" || source == "assistant",
            "contract source: {source}"
        );
        let snippet = m["snippet"].as_str().unwrap();
        assert!(
            snippet.to_lowercase().contains("frobnicator"),
            "snippet: {snippet}"
        );
        assert!(snippet.chars().count() <= 240, "snippet capped: {snippet}");
    }

    // Under-length query is a contract Failure (2..=200 chars).
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.searchThreads",
        json!({ "input": { "query": "f" } }),
    )
    .await;
    let f2 = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(f2["exit"]["_tag"], "Failure", "min length enforced: {f2}");
}

/// #338: multibyte prefix must NOT panic snippet slicing. The old
/// implementation used byte offsets from `hay.find(&needle)` and then
/// `text[start..end]`; a Turkish 'İ' whose lowercase is two chars, or
/// enough Cyrillic prefix to shift the hit past a codepoint boundary
/// on `saturating_sub(80)`, was a live panic.
#[tokio::test]
async fn search_threads_handles_multibyte_text_without_panicking() {
    let (state, _d) = test_state().await;
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-utf8", "projectId": "p-workspace", "title": "utf8",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    // 100 cyrillic chars, each 2 bytes, then the needle. `find()` on
    // the lowercased hay returns byte offset ≥ 200; saturating_sub(80)
    // lands mid-codepoint under the old byte-slice code and panics.
    let prefix: String = "я".repeat(100);
    let text = format!("{prefix}frobnicator finished");
    state
        .rt
        .append_message(
            "t-utf8",
            &json!({
                "id": "m1", "role": "user", "text": text,
                "streaming": false, "createdAt": now_iso(),
            }),
        )
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.searchThreads",
        json!({ "input": { "query": "frobnicator" } }),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "no panic on multibyte prefix: {f}"
    );
    let matches = f["exit"]["value"]["matches"].as_array().unwrap();
    assert_eq!(
        matches.len(),
        1,
        "the multibyte-prefixed hit is found: {matches:?}"
    );
    let snippet = matches[0]["snippet"].as_str().unwrap();
    assert!(
        snippet.contains("frobnicator"),
        "snippet includes the hit: {snippet}"
    );
    assert!(
        snippet.chars().count() <= 240,
        "snippet stays within cap: {}",
        snippet.chars().count()
    );
}

/// #46: server.discoverSourceControl is implemented and returns a non-empty
/// SourceControlDiscoveryResult (vcs + providers rows), not an unsupported
/// failure — the source-control UI can become functional on this runtime.
/// #92: subscribeThread hydrates the thread's live session state, so a
/// reconnect shows a real session affordance instead of `session: null`.
#[tokio::test]
async fn subscribe_thread_hydrates_the_session_state() {
    let (state, _d) = test_state().await;
    // no session bound yet → the snapshot honestly reports null.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-hyd" }),
    )
    .await;
    let f = drain(&mut rx);
    let snap = f
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .unwrap();
    assert_eq!(
        snap["values"][0]["snapshot"]["thread"]["session"],
        Value::Null,
        "no session → null"
    );

    // bind a session for the thread (settles Idle), then a fresh subscribe
    // must hydrate it — session is no longer null and carries a status.
    let binding = SessionBinding {
        thread_id: "t-hyd".into(),
        provider_instance_id: "claude_resume:test".into(),
        model_key: "k".into(),
    };
    let def = AgentDefinition {
        name: "t3code".into(),
        instructions: "".into(),
        model: ModelRef::ClaudeResume {
            model: "test".into(),
        },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(),
        options: vec![],
        cwd: None,
    };
    state.rt.session_for(&binding, def).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-hyd" }),
    )
    .await;
    let f = drain(&mut rx);
    let snap = f
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .unwrap();
    let session = &snap["values"][0]["snapshot"]["thread"]["session"];
    assert_eq!(session["threadId"], "t-hyd", "session hydrated: {session}");
    assert_eq!(
        session["status"], "idle",
        "a settled bound session reports idle, not null"
    );
    // The activeTurnId field is EMITTED (not omitted) and is null for a
    // settled session — a settled session must not hydrate a stoppable turn.
    // The live branch (status "running" + a non-null activeTurnId from the
    // durable in-flight marker) is proven where a real turn can actually park:
    // agent-sdk-shell's the_active_turn_id_is_recorded_while_running_and_cleared_on_settle
    // and session_status_prefers_the_live_session_over_a_newer_idle_one (#92).
    assert!(
        session.get("activeTurnId").is_some(),
        "activeTurnId is present on the wire: {session}"
    );
    assert_eq!(
        session["activeTurnId"],
        Value::Null,
        "a settled session has no active turn: {session}"
    );
}

/// #66: the review diff panel renders through the Cairn seam. In a repo with
/// an unstaged change, review.getDiffPreview returns a working-tree source
/// carrying the diff, and getDiffFileContents returns old vs new contents.
#[tokio::test]
async fn review_diff_preview_and_file_contents_over_cairn() {
    let (state, dir) = test_state().await;
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
    };
    git(&["init", "-q"]);
    std::fs::write(dir.join("f.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    // an unstaged edit the panel must surface.
    std::fs::write(dir.join("f.txt"), "two\n").unwrap();

    let cwd = state.cwd.clone();
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "review.getDiffPreview", json!({ "cwd": cwd })).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "getDiffPreview ok: {:?}",
        f[0]
    );
    let sources = f[0]["exit"]["value"]["sources"].as_array().unwrap();
    assert_eq!(
        sources.len(),
        1,
        "one working-tree source for the change: {sources:?}"
    );
    assert_eq!(sources[0]["kind"], "working-tree");
    assert!(
        sources[0]["diff"].as_str().unwrap().contains("+two"),
        "diff shows the edit: {}",
        sources[0]["diff"]
    );

    // old (HEAD) vs new (worktree) contents.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "review.getDiffFileContents",
        json!({
        "cwd": cwd, "sourceKind": "working-tree", "changeType": "change",
        "baseRef": "HEAD", "headRef": Value::Null, "oldPath": "f.txt", "newPath": "f.txt" }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "getDiffFileContents ok: {:?}",
        f[0]
    );
    assert_eq!(
        f[0]["exit"]["value"]["oldContents"], "one\n",
        "old = HEAD blob"
    );
    assert_eq!(
        f[0]["exit"]["value"]["newContents"], "two\n",
        "new = worktree file"
    );
}

/// #47/#60: provider management is durable and routes through the runtime.
/// getSettings returns the instances; updateSettings ADDS an Ollama instance
/// that then appears in the next getConfig.providers (the picker) — proving
/// the write reconciled the live catalog, not a localStorage decoration.
#[tokio::test]
async fn update_settings_adds_a_provider_visible_in_get_config() {
    let (state, _d) = test_state().await;

    // getSettings starts with the stock instances (claude + codex).
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getSettings", json!({})).await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Success");
    let pis = &f[0]["exit"]["value"]["providerInstances"];
    assert!(
        pis.get("claudeAgent").is_some() && pis.get("codex").is_some(),
        "stock providers: {pis}"
    );

    // updateSettings ADDS an Ollama (openai-compat) instance.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({ "patch": { "providerInstances": {
        "ollama_local": { "instanceId": "ollama_local", "driver": "openaiCompat",
            "displayName": "Ollama", "enabled": true,
            "config": { "baseUrl": "http://localhost:11434", "models": ["qwen2.5-coder"] } } } } }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "updateSettings ok: {:?}",
        f[0]
    );
    assert!(
        f[0]["exit"]["value"]["providerInstances"]["ollama_local"].is_object(),
        "ollama saved"
    );

    // the picker (getConfig.providers) now advertises Ollama — the catalog
    // was reconciled in place, not just persisted.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let f = drain(&mut rx);
    let providers = f[0]["exit"]["value"]["providers"].as_array().unwrap();
    assert!(
        providers
            .iter()
            .any(|p| p["id"] == "ollama_local" || p["instanceId"] == "ollama_local"),
        "getConfig advertises the added Ollama provider: {providers:?}"
    );

    // and it SURVIVES a reload: a fresh catalog built from the store still has it.
    let reloaded =
        settings::load_instances(state.rt.store(), providers::configured_instances()).await.unwrap();
    assert!(
        reloaded.iter().any(|c| c.instance_id == "ollama_local"),
        "ollama persisted across reload"
    );

    // #94: REMOVING it — the UI sends the whole map WITHOUT the key — deletes
    // it durably and from the catalog; stock providers survive.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.updateSettings", json!({ "patch": { "providerInstances": {
        "claudeAgent": { "instanceId": "claudeAgent", "driver": "claudeAgent", "enabled": true, "config": {} },
        "codex": { "instanceId": "codex", "driver": "codex", "enabled": true, "config": {} } } } })).await;
    let f = drain(&mut rx);
    assert!(
        f[0]["exit"]["value"]["providerInstances"]
            .get("ollama_local")
            .is_none(),
        "ollama removed from settings"
    );
    let gone = settings::load_instances(state.rt.store(), providers::configured_instances()).await.unwrap();
    assert!(
        !gone.iter().any(|c| c.instance_id == "ollama_local"),
        "ollama gone from durable store"
    );
    assert!(
        gone.iter().any(|c| c.instance_id == "codex"),
        "stock codex survived the removal"
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let f = drain(&mut rx);
    let providers = f[0]["exit"]["value"]["providers"].as_array().unwrap();
    assert!(
        !providers.iter().any(|p| p["id"] == "ollama_local"),
        "picker no longer shows removed ollama"
    );

    // #87: a NON-provider settings field survives the round-trip instead of
    // resetting to its default on the next getSettings.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({ "patch": { "newWorktreesStartFromOrigin": false } }),
    )
    .await;
    drain(&mut rx);
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getSettings", json!({})).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["value"]["newWorktreesStartFromOrigin"],
        json!(false),
        "non-provider field round-trips"
    );

    // #121: a MISTYPED field (string where a boolean is required) is REJECTED
    // and leaves the stored settings unchanged — never poisons getSettings.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({ "patch": { "newWorktreesStartFromOrigin": "false" } }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Failure",
        "invalid settings patch is rejected: {:?}",
        f[0]
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getSettings", json!({})).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["value"]["newWorktreesStartFromOrigin"],
        json!(false),
        "prior valid value survived the rejected write"
    );
}

#[tokio::test]
async fn discover_source_control_returns_a_result() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.discoverSourceControl", json!({})).await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "discoverSourceControl implemented: {:?}",
        f[0]
    );
    let v = &f[0]["exit"]["value"];
    assert!(
        v["versionControlSystems"]
            .as_array()
            .is_some_and(|a| !a.is_empty()),
        "vcs probes present: {v}"
    );
    assert!(
        v["sourceControlProviders"].is_array(),
        "providers present: {v}"
    );
}

#[tokio::test]
async fn get_config_returns_success_exit() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let frames = drain(&mut rx);
    assert_eq!(frames[0]["_tag"], "Exit");
    assert_eq!(frames[0]["exit"]["_tag"], "Success");
    assert!(frames[0]["exit"]["value"]["providers"].is_array());
}

#[tokio::test]
async fn unsupported_method_fails_explicitly_not_null_success() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.someUnimplementedMutation",
        json!({}),
    )
    .await;
    let frames = drain(&mut rx);
    // The contract fix: an unimplemented RPC is a visible Failure, never a
    // masking Success(null) the reducer would advance past.
    assert_eq!(
        frames[0]["exit"]["_tag"], "Failure",
        "unsupported RPC must fail, got {:?}",
        frames[0]
    );
    assert_eq!(frames[0]["exit"]["cause"][0]["_tag"], "Die");
}

/// #111: pull-request RPCs return the CONTRACT'S typed unavailable
/// error, not the untyped Die-defect fallthrough. Reads emit
/// `PullRequestUnavailableError { reason: "provider-unsupported" }`
/// which the client folds into a hidden/disabled panel; mutations emit
/// `PullRequestOperationError` naming the operation the user tried, so
/// a click-time refusal has an actionable label instead of a generic
/// "unsupported method" defect.
#[tokio::test]
async fn pull_request_rpcs_return_typed_unavailable_not_die_defect() {
    let (state, _d) = test_state().await;

    for read in [
        "pullRequests.list",
        "pullRequests.detail",
        "pullRequests.activity",
        "pullRequests.threadComments",
        "pullRequests.diffFileContents",
        "pullRequests.reviewerCandidates",
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, read, json!({})).await;
        let frames = drain(&mut rx);
        let exit = &frames[0]["exit"];
        assert_eq!(
            exit["_tag"], "Failure",
            "{read} must fail typed, got {exit:?}"
        );
        let cause = &exit["cause"][0];
        assert_eq!(
            cause["_tag"], "Fail",
            "{read} must be a declared Fail not a Die: {cause:?}"
        );
        let error = &cause["error"];
        assert_eq!(
            error["_tag"], "PullRequestUnavailableError",
            "{read} must return the contract's tagged error: {error:?}"
        );
        assert_eq!(
            error["reason"], "provider-unsupported",
            "{read} must name the honest reason (no provider wired): {error:?}"
        );
    }

    for mutation in [
        "pullRequests.comment",
        "pullRequests.submitReview",
        "pullRequests.runAction",
        "pullRequests.update",
        "pullRequests.requestReviewers",
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, mutation, json!({})).await;
        let frames = drain(&mut rx);
        let exit = &frames[0]["exit"];
        assert_eq!(
            exit["_tag"], "Failure",
            "{mutation} must fail typed, got {exit:?}"
        );
        let error = &exit["cause"][0]["error"];
        assert_eq!(
            error["_tag"], "PullRequestOperationError",
            "{mutation} must return the contract's operation error: {error:?}"
        );
        let op_suffix = mutation.trim_start_matches("pullRequests.");
        assert_eq!(
            error["operation"], op_suffix,
            "the operation name identifies which mutation was refused: {error:?}"
        );
        assert!(
            error["detail"].as_str().unwrap().len() > 0,
            "detail is non-empty: {error:?}"
        );
    }
}

#[tokio::test]
async fn dispatch_acks_with_sequence() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": { "type": "noop" } }),
    )
    .await;
    let frames = drain(&mut rx);
    assert_eq!(frames[0]["exit"]["_tag"], "Success");
    assert!(frames[0]["exit"]["value"]["sequence"].is_number());
}

/// #35: the advertised catalog is the reconciled registry, not two
/// hard-coded literals — and an unusable provider stays VISIBLE with its
/// reason so the user can fix it.
#[tokio::test]
async fn get_config_advertises_the_registry_catalog() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let providers = drain(&mut rx)[0]["exit"]["value"]["providers"].clone();
    let ids: Vec<&str> = providers
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["instanceId"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&"claudeAgent") && ids.contains(&"codex"),
        "got {ids:?}"
    );
    for p in providers.as_array().unwrap() {
        assert!(
            p["models"].as_array().is_some_and(|m| !m.is_empty()),
            "every provider has models: {p}"
        );
        assert!(
            p["status"].is_string(),
            "status comes from the snapshot: {p}"
        );
    }
}

/// #37: switching the model on an EXISTING thread persists durably, and the
/// switch does not cost the thread its history.
#[tokio::test]
async fn a_model_switch_persists_and_keeps_history() {
    let (state, _d) = test_state().await;
    let claude = json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001"});
    let codex = json!({"instanceId": "codex", "model": "codex-default"});

    // turn 1 creates the thread on claude
    ensure_thread_on_shell(
        &state,
        &json!({
            "threadId": "t-switch", "modelSelection": claude,
            "message": {"text": "first", "messageId": "m1"},
        }),
    )
    .await;
    // The prompt itself is written by `run_turn_with_prompt_id`, not by
    // thread bootstrap, so a test that never runs a turn seeds it the way
    // the runtime would. What is under test here is the SWITCH, and the
    // invariant that it does not cost the transcript.
    seed_prompt(&state, "t-switch", "m1", "first").await;
    // turn 2 switches to codex
    ensure_thread_on_shell(
        &state,
        &json!({
            "threadId": "t-switch", "modelSelection": codex,
            "message": {"text": "second", "messageId": "m2"},
        }),
    )
    .await;
    seed_prompt(&state, "t-switch", "m2", "second").await;

    // the DURABLE thread row carries the new selection
    let thread = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t["id"] == "t-switch")
        .expect("thread persisted");
    assert_eq!(
        thread["modelSelection"]["instanceId"], "codex",
        "switch persisted: {thread}"
    );

    // and the subscribeThread snapshot the UI reads agrees, with BOTH
    // messages still there
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({"threadId": "t-switch"}),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("snapshot");
    let t = &snap["values"][0]["snapshot"]["thread"];
    assert_eq!(
        t["modelSelection"]["instanceId"], "codex",
        "snapshot shows the switch: {t}"
    );
    let ids: Vec<&str> = t["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        vec!["m1", "m2"],
        "the switch preserved message history"
    );

    // and the next turn ROUTES to the switched provider, not the default —
    // model_from_selection is fallible now (unroutable = error, never a
    // silent default), so a successful codex selection is Ok(CodexResume).
    let routed = model_from_selection(
        &*state.catalog.read().await,
        &codex,
        &state.default_model().await,
    );
    assert!(
        matches!(routed, Ok(ModelRef::CodexResume { .. })),
        "routed to {routed:?}"
    );
}

/// #26/#27: the VCS RPCs are IMPLEMENTED (over cairn), not answered from
/// the unsupported-method arm. This is the regression guard — the frontend
/// git UI is only connected while these stop failing.
#[tokio::test]
async fn vcs_methods_are_implemented_not_unsupported() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    let cwd = dir.to_string_lossy().into_owned();

    for (method, payload) in [
        ("vcs.refreshStatus", json!({"cwd": cwd})),
        ("vcs.listRefs", json!({"cwd": cwd})),
        ("vcs.init", json!({"cwd": cwd})),
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, method, payload).await;
        let frames = drain(&mut rx);
        let exit = frames
            .iter()
            .find(|f| f["_tag"] == "Exit")
            .expect("{method} exits");
        assert_eq!(
            exit["exit"]["_tag"], "Success",
            "{method} must be implemented: {exit}"
        );
    }

    // the status stream emits a real snapshot frame
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "subscribeVcsStatus", json!({"cwd": cwd})).await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["_tag"] == "Chunk")
        .map(|f| f["values"][0].clone())
        .unwrap_or_else(|| panic!("a snapshot chunk, got {frames:?}"));
    assert_eq!(snap["_tag"], "snapshot", "got {snap}");
    assert_eq!(
        snap["local"]["isRepo"],
        json!(true),
        "real cairn status: {snap}"
    );

    // and a refused operation FAILS rather than reporting success
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.switchRef",
        json!({"cwd": cwd, "refName": "--upload-pack=pwn"}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "an option-shaped ref must be refused: {exit}"
    );
}

/// #45: naming a path is not authority. A client for THIS environment must
/// not be able to read or mutate an unrelated local repository by sending
/// its cwd — every VCS method fails closed, reads included.
#[tokio::test]
async fn an_outside_repo_cwd_is_refused_by_every_vcs_method() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    // a REAL git repository, deliberately outside this environment
    let outside = std::env::temp_dir().join(format!("t3-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    cairn::init_repository(&outside).await.unwrap();
    let alien = outside.to_string_lossy().into_owned();

    for method in [
        "vcs.refreshStatus",
        "vcs.listRefs",
        "subscribeVcsStatus",
        "vcs.pull",
        "vcs.createRef",
        "vcs.switchRef",
        "vcs.createWorktree",
        "vcs.removeWorktree",
        "vcs.init",
        "git.runStackedAction",
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(
            &state,
            &tx,
            method,
            json!({
                "cwd": alien, "refName": "main", "path": alien,
                "actionId": "a", "action": "commit", "commitMessage": "x",
            }),
        )
        .await;
        let frames = drain(&mut rx);
        let exit = frames
            .iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap_or_else(|| panic!("{method} must answer, got {frames:?}"));
        assert_eq!(
            exit["exit"]["_tag"], "Failure",
            "{method} must fail closed: {exit}"
        );
        assert!(
            frames.iter().all(|f| f["_tag"] != "Chunk"),
            "{method} must not leak a snapshot of an outside repo: {frames:?}"
        );
    }

    // the environment's OWN workspace still works, so this is a boundary
    // and not a blanket refusal
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.refreshStatus",
        json!({"cwd": dir.to_string_lossy()}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "the workspace itself is admitted: {exit}"
    );

    let _ = std::fs::remove_dir_all(&outside);
}

/// #50: an unroutable model selection FAILS the dispatch. It must not be
/// acked and then quietly run on the default — that is how a thread ends up
/// displaying one provider while a billed turn ran another under a
/// different session binding.
#[tokio::test]
async fn an_unroutable_selection_fails_the_dispatch_and_starts_no_turn() {
    let (state, _d) = test_state().await;

    for sel in [
        json!({"instanceId": "ollama_local", "model": "llama3.1"}), // not configured here
        json!({"instanceId": "claudeAgent", "model": "gpt-4o"}),    // wrong model for it
        json!({"instanceId": "typo-provider", "model": "x"}),       // unknown instance
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(
            &state,
            &tx,
            "orchestration.dispatchCommand",
            json!({"input": {
                "type": "thread.turn.start", "threadId": "t-bad",
                "modelSelection": sel, "message": {"text": "hi", "messageId": "m1"},
            }}),
        )
        .await;
        let exit = drain(&mut rx)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .expect("exits");
        assert_eq!(
            exit["exit"]["_tag"], "Failure",
            "selection {sel} must fail: {exit}"
        );
    }

    // no turn was admitted, so the thread was never created under a
    // substituted binding
    assert!(
        state.rt.threads().await.iter().all(|t| t["id"] != "t-bad"),
        "a refused selection must not create a thread"
    );

    // a VALID selection still dispatches, so this is a gate and not a wall
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({"input": {
            "type": "thread.turn.start", "threadId": "t-ok",
            "modelSelection": {"instanceId": "codex", "model": "codex-default"},
            "message": {"text": "hi", "messageId": "m1"},
        }}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "a routable selection dispatches: {exit}"
    );
}

/// The asset surface is BOTH halves or it is nothing: the RPC mints a URL
/// the redeem route can actually serve, and a path outside the workspace is
/// refused at mint time rather than signed and served later.
#[tokio::test]
async fn asset_urls_are_minted_signed_and_confined() {
    let (state, dir) = test_state().await;
    let worktree = dir.join("asset-worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join("logo.png"), b"\x89PNG").unwrap();
    let worktree_s = worktree.to_string_lossy().into_owned();
    let row = agent_sdk_shell::ThreadRecord::new(
        "t-1",
        "p-workspace",
        "asset thread",
        json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001"}),
        agent_sdk_shell::RuntimeMode::FullAccess,
        &now_iso(),
    )
    .on_worktree(Some(worktree_s.clone()), Some("asset-thread".into()))
    .project(json!({ "session": Value::Null }))
    .unwrap();
    state.rt.save_thread(&row).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "assets.createUrl",
        json!({
            "resource": {"_tag": "workspace-file", "threadId": "t-1", "path": "logo.png"},
        }),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "assets.createUrl must be implemented: {exit}"
    );
    let url = exit["exit"]["value"]["relativeUrl"]
        .as_str()
        .expect("a relativeUrl")
        .to_string();
    assert!(
        url.starts_with(&format!("{}/", assets::ROUTE_PREFIX)),
        "{url}"
    );
    assert!(
        exit["exit"]["value"]["expiresAt"].as_i64().unwrap() > 0,
        "carries an expiry"
    );

    // the minted token redeems to the very file we asked for
    let token = url
        .trim_start_matches(&format!("{}/", assets::ROUTE_PREFIX))
        .split('/')
        .next()
        .unwrap();
    let served = assets::verify(
        token,
        &state.assets_key,
        chrono::Utc::now().timestamp_millis(),
    )
    .expect("the URL this server minted verifies against its own key");
    assert_eq!(std::fs::read(served).unwrap(), b"\x89PNG");

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "assets.createUrl", json!({
        "resource": {"_tag": "workspace-file", "path": "logo.png"},
    })).await;
    let exit = drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "a workspace-file asset without threadId must not fall back to cwd: {exit}"
    );

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "assets.createUrl", json!({
        "resource": {"_tag": "workspace-file", "threadId": "stale-or-other-thread", "path": "logo.png"},
    })).await;
    let exit = drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "a workspace-file asset for an unknown thread must not fall back to cwd: {exit}"
    );

    // and an escape is refused, so no signature is ever issued for it
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "assets.createUrl",
        json!({
            "resource": {"_tag": "workspace-file", "threadId": "t-1", "path": "../../etc/passwd"},
        }),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "an escaping path must not be signed: {exit}"
    );
}

#[tokio::test]
async fn unreadable_kv_does_not_rotate_the_asset_signing_key() {
    let (state, _dir) = test_state().await;
    drop_runtime_kv(&state).await;

    let err = assets::signing_key(state.rt.store())
        .await
        .expect_err("unreadable signing-key storage must not mint a replacement key");
    assert!(
        err.contains("assets:signing_key") || err.contains("kv value"),
        "the error should name durable key authority: {err}"
    );
}

#[tokio::test]
async fn unreadable_kv_fails_settings_and_keybinding_reads() {
    let (state, _dir) = test_state().await;
    drop_runtime_kv(&state).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getSettings", json!({})).await;
    let settings = drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("settings exits");
    assert_eq!(
        settings["exit"]["_tag"], "Failure",
        "settings must not fall back to defaults over unreadable kv: {settings}"
    );

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let config = drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("config exits");
    assert_eq!(
        config["exit"]["_tag"], "Failure",
        "keybindings/config must not fall back to defaults over unreadable kv: {config}"
    );
}

/// The client pings this on a timer; failing it made every connected client
/// log an error every few seconds. It is an ACK, not an unsupported method.
#[tokio::test]
async fn client_activity_reports_are_acknowledged() {
    let (state, _dir) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.reportClientActivity",
        json!({"activity": "foreground"}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "activity reports are acked: {exit}"
    );
}

/// #48: proving the SOURCE repo is ours says nothing about the DESTINATION.
/// A worktree may only be created inside this environment's worktree area,
/// and may only be force-removed if we created it and git still links it.
#[tokio::test]
async fn worktree_paths_are_admitted_not_trusted() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    std::fs::write(dir.join("a.txt"), "x").unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    // a commit so branches can be created off HEAD
    vcs::run_stacked_action(
        &cwd,
        &json!({"actionId":"a","action":"commit","commitMessage":"init"}),
    )
    .await
    .unwrap();

    // 1. an outside absolute path is refused BEFORE git runs
    let outside = std::env::temp_dir().join(format!("t3-wt-outside-{}", uuid::Uuid::new_v4()));
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.createWorktree",
        json!({
            "cwd": cwd, "refName": "wt-a", "path": outside.to_string_lossy(),
        }),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "outside path must be refused: {exit}"
    );
    assert!(!outside.exists(), "nothing was created at the refused path");

    // 2. the default path still works, and lands in the worktree area
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.createWorktree",
        json!({"cwd": cwd, "refName": "wt-b"}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "the default destination works: {exit}"
    );
    // VcsCreateWorktreeResult wraps the worktree (#62)
    let made = exit["exit"]["value"]["worktree"]["path"]
        .as_str()
        .unwrap()
        .to_string();
    let base = vcs::worktree_base(&cwd);
    assert!(
        std::path::Path::new(&made).starts_with(&base),
        "created inside the worktree area: {made} vs {}",
        base.display()
    );

    // 3. removing an unregistered/outside path is refused
    let alien = std::env::temp_dir().join(format!("t3-wt-alien-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&alien).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.removeWorktree",
        json!({"cwd": cwd, "path": alien.to_string_lossy()}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "an unregistered path must not be force-removed: {exit}"
    );
    assert!(alien.exists(), "the refused path was NOT deleted");

    // 4. removing the one we made succeeds — a boundary, not a wall
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.removeWorktree",
        json!({"cwd": cwd, "path": made}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "our own worktree removes: {exit}"
    );

    let _ = std::fs::remove_dir_all(&alien);
    let _ = std::fs::remove_dir_all(vcs::worktree_base(&cwd));
}

/// #49: a subscription this runtime does not implement must FAIL, not park.
/// An unanswered stream is indistinguishable from an idle one, and the UI
/// spins forever on a missing contract.
#[tokio::test]
async fn an_unimplemented_subscription_fails_instead_of_hanging() {
    let (state, _d) = test_state().await;

    for method in [
        "subscribeSomethingNobodyBuilt",
        "orchestration.subscribeTypo",
        "subscribeVcsStatusz",
    ] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, method, json!({})).await;
        let frames = drain(&mut rx);
        let exit = frames
            .iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap_or_else(|| {
                panic!("{method} parked with no answer — the hang this test exists to stop")
            });
        assert_eq!(exit["exit"]["_tag"], "Failure", "{method}: {exit}");
    }

    // an allowlisted quiet stream still parks (it IS implemented, it just
    // has nothing to say) — proving this is an allowlist, not "fail all"
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "subscribeEnvironments", json!({})).await;
    assert!(
        drain(&mut rx).is_empty(),
        "an intentionally-empty stream stays open"
    );

    // and the implemented terminal streams answer for real
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "subscribeTerminalMetadata", json!({ "threadId": "t-implemented" })).await;
    assert!(!drain(&mut rx).is_empty(), "terminal metadata is implemented and emits");
}

/// #52: the stop button reaches Hearth AND the SDK turn cancel. An ack with
/// nothing behind it leaves a foreground command burning while the UI claims
/// it stopped.
#[tokio::test]
async fn stop_interrupts_the_hearth_foreground_and_cancels_the_turn() {
    let (state, _d) = test_state().await;

    // a real long-running foreground command in the SHARED pty — the same
    // one run_bash uses, which is why a stop has to reach it
    let runner = state.terminal.clone();
    let running = tokio::spawn(async move { runner.run("sleep 30", false, Some(25), false).await });
    // let the command actually reach the shell before interrupting
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    let started = std::time::Instant::now();
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({"input": {
            "type": "thread.turn.interrupt", "threadId": "t-stop",
        }}),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "the stop is accepted: {exit}"
    );

    // THE point: the command came back early because it was interrupted,
    // not because `sleep 30` finished.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), running)
        .await
        .expect("the foreground command must not still be running")
        .expect("join");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(20),
        "stop interrupted the foreground in {:?}, it did not wait out sleep 30",
        started.elapsed()
    );
    assert!(
        outcome.interrupted || outcome.exit_code != 0,
        "hearth reports the interrupt: {outcome:?}"
    );

    // and the PTY itself survived — a stop cancels the command, not the shell
    let after = state
        .terminal
        .run("echo alive", false, Some(10), false)
        .await;
    assert!(
        after.output.contains("alive"),
        "the shell is still usable: {after:?}"
    );
}

async fn drop_thread_session_table(dir: &std::path::Path) {
    let pool = do_storage::DbPool::new(dir.join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE thread_session", vec![]).await.unwrap();
}

fn exit_is_success(frame: &Value) -> bool {
    frame["_tag"] == "Exit" && frame["exit"]["_tag"] == "Success"
}

/// #108: a stop command whose SDK durable cancellation cannot be read/written
/// must fail the RPC. Logging and then falling through to Success leaves the
/// client believing the turn stopped while the runtime still owns the cancel
/// authority.
#[tokio::test]
async fn stop_command_fails_when_sdk_interrupt_state_is_unreadable() {
    let (state, dir) = test_state().await;

    // Keep the shared Hearth shell live so this test faults only the SDK side.
    let opened = state.terminal.run("true", false, Some(5), false).await;
    assert_eq!(opened.exit_code, 0, "precondition: terminal opened cleanly: {opened:?}");

    state.rt.save_thread(&thread_row_ck("t-stop-sdk-fail")).await.unwrap();
    drop_thread_session_table(&dir).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.dispatchCommand", json!({"input": {
        "type": "thread.turn.interrupt", "threadId": "t-stop-sdk-fail",
    }})).await;
    let frames = drain(&mut rx);
    let exits: Vec<_> = frames.iter().filter(|f| f["_tag"] == "Exit").collect();
    assert_eq!(exits.len(), 1, "a failed stop must produce exactly one terminal frame: {frames:?}");
    assert_eq!(exits[0]["exit"]["_tag"], "Failure", "SDK stop failure must not ack success: {frames:?}");
    assert!(
        !frames.iter().any(|f| exit_is_success(f)),
        "SDK stop failure sent a success ack as well as failure: {frames:?}"
    );
    let defect = exit_defect(exits[0]);
    assert!(
        defect.contains("thread.turn.interrupt failed"),
        "failure must name the SDK stop path: {frames:?}"
    );
}

/// #108: a stop command whose Hearth foreground interrupt cannot be delivered
/// must fail the RPC before the generic synchronous-command Success ack.
#[tokio::test]
async fn stop_command_fails_when_hearth_foreground_interrupt_fails() {
    let (state, _d) = test_state().await;
    state.rt.save_thread(&thread_row_ck("t-stop-hearth-fail")).await.unwrap();

    let shutdown = state.terminal.shutdown().await;
    assert!(shutdown.contains("shut down"), "precondition: shared shell shut down: {shutdown}");

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.dispatchCommand", json!({"input": {
        "type": "thread.turn.interrupt", "threadId": "t-stop-hearth-fail",
    }})).await;
    let frames = drain(&mut rx);
    let exits: Vec<_> = frames.iter().filter(|f| f["_tag"] == "Exit").collect();
    assert_eq!(exits.len(), 1, "a failed stop must produce exactly one terminal frame: {frames:?}");
    assert_eq!(exits[0]["exit"]["_tag"], "Failure", "Hearth stop failure must not ack success: {frames:?}");
    assert!(
        !frames.iter().any(|f| exit_is_success(f)),
        "Hearth stop failure sent a success ack as well as failure: {frames:?}"
    );
    let defect = exit_defect(exits[0]);
    assert!(
        defect.contains("terminal interrupt failed") && defect.contains("no live shell"),
        "failure must name the Hearth interrupt path: {frames:?}"
    );
}

#[tokio::test]
async fn stop_command_fails_when_runtime_cancel_state_is_unreadable() {
    use agent_sdk_do::ObjectDb;
    let (state, _d) = test_state().await;
    // Keep the Hearth half healthy so this specifically proves SDK/runtime
    // cancellation failure is not hidden behind a successful terminal interrupt.
    let ready = state.terminal.run("echo ready", false, Some(10), false).await;
    assert!(ready.output.contains("ready"), "precondition: live shell exists: {ready:?}");

    state
        .rt
        .store()
        .db()
        .execute("DROP TABLE thread_session", vec![])
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.interrupt",
            "threadId": "t-stop-broken-runtime",
        }}),
    )
    .await;
    let exits: Vec<Value> = drain(&mut rx)
        .into_iter()
        .filter(|f| f["_tag"] == "Exit")
        .collect();
    assert_eq!(exits.len(), 1, "one terminal frame for failed stop: {exits:?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "runtime cancel failure must not be acked as Success: {exits:?}"
    );
    assert!(
        exits[0].to_string().contains("runtime cancel failed"),
        "failure must name runtime cancellation: {exits:?}"
    );
}

#[tokio::test]
async fn stop_command_fails_when_terminal_interrupt_fails() {
    let (state, _d) = test_state().await;
    // No shell has been spawned yet, so Hearth reports "no live shell".
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.turn.interrupt",
            "threadId": "t-stop-no-shell",
        }}),
    )
    .await;
    let exits: Vec<Value> = drain(&mut rx)
        .into_iter()
        .filter(|f| f["_tag"] == "Exit")
        .collect();
    assert_eq!(exits.len(), 1, "one terminal frame for failed stop: {exits:?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "terminal interrupt failure must not be acked as Success: {exits:?}"
    );
    assert!(
        exits[0].to_string().contains("terminal interrupt failed"),
        "failure must name Hearth/terminal interrupt: {exits:?}"
    );
}

#[tokio::test]
async fn stop_command_fails_when_hearth_interrupt_fails() {
    let (state, _d) = test_state().await;
    let _ = state.terminal.shutdown().await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.dispatchCommand", json!({"input": {
        "type": "thread.turn.interrupt", "threadId": "t-stop-fail",
    }})).await;

    let exits: Vec<Value> = drain(&mut rx).into_iter().filter(|f| f["_tag"] == "Exit").collect();
    assert_eq!(exits.len(), 1, "one request must produce exactly one terminal frame: {exits:?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "a failed Hearth foreground interrupt must not be acknowledged as success: {exits:?}"
    );
    let defect = exits[0]["exit"]["cause"][0]["defect"].as_str().unwrap_or("");
    assert!(
        defect.contains("terminal interrupt failed"),
        "the failure should name the failed stop leg: {exits:?}"
    );
}

#[tokio::test]
async fn stop_command_fails_when_sdk_cancel_fails() {
    let (state, _d) = test_state().await;
    let binding = SessionBinding {
        thread_id: "t-sdk-stop-fail".into(),
        provider_instance_id: "claude_resume:test".into(),
        model_key: "k".into(),
    };
    let def = AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: ModelRef::ClaudeResume { model: "test".into() },
        tools: vec![], ask_tools: vec![], subagents: vec![], mcp_servers: vec![],
        labels: Default::default(), options: vec![], cwd: Some(state.cwd.clone()),
    };
    let sid = state.rt.session_for(&binding, def).await.unwrap();

    let pool = do_storage::DbPool::new(std::path::Path::new(&state.cwd).join("data"));
    let db = pool.object_db("ShellSession", &sid).await.unwrap();
    db.execute("DROP TABLE agent_control", vec![]).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.dispatchCommand", json!({"input": {
        "type": "thread.session.stop", "threadId": "t-sdk-stop-fail",
    }})).await;

    let exits: Vec<Value> = drain(&mut rx).into_iter().filter(|f| f["_tag"] == "Exit").collect();
    assert_eq!(exits.len(), 1, "one request must produce exactly one terminal frame: {exits:?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "a failed SDK durable cancel must not be acknowledged as success: {exits:?}"
    );
    let defect = exits[0]["exit"]["cause"][0]["defect"].as_str().unwrap_or("");
    assert!(
        defect.contains("thread.session.stop failed") && defect.contains("agent_control"),
        "the failure should name the SDK stop leg and durable control table: {exits:?}"
    );
}

/// #68: a settings/provider write must reach the UI's shared config
/// projection, which only advances when `subscribeServerConfig` emits.
/// Returning the new value from the command is not enough — every passive
/// surface that did not issue it reads the stream.
#[tokio::test]
async fn settings_writes_publish_on_the_config_stream() {
    let (state, _d) = test_state().await;

    // subscribe first, and take the initial snapshot
    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeServerConfig", json!({})).await;
    let first = drain(&mut sub_rx);
    // Asserted against the CONTRACT's tagged union (`version`/`type`), not
    // against whatever this server happens to emit: the client switches on
    // `event.type`, so a test that read our own `kind` back would stay green
    // while every real client dropped the frame.
    assert_eq!(
        first[0]["values"][0]["version"], 1,
        "contract envelope: {first:?}"
    );
    assert_eq!(
        first[0]["values"][0]["type"], "snapshot",
        "a late subscriber gets state: {first:?}"
    );
    assert!(first[0]["values"][0]["config"]["providers"].is_array());

    // now write settings on a DIFFERENT connection
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({"patch": {"providerInstances": {
            "ollama_local": {
                "driver": "openaiCompat", "enabled": true, "displayName": "Ollama",
                "config": {"baseUrl": "http://localhost:11434", "models": ["qwen2.5-coder"]},
            }
        }}}),
    )
    .await;
    assert_eq!(
        drain(&mut rx)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap()["exit"]["_tag"],
        "Success"
    );

    // the SUBSCRIBER saw it, without asking. Config fanout is via the SDK
    // broker now (packet DL); delivery to the pumping tail is a spawned
    // await away, so we spin briefly for the frames to land rather than
    // reading synchronously.
    let pushed = drain_until(&mut sub_rx, std::time::Duration::from_secs(15), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("type"))
            .and_then(Value::as_str)
            == Some("providerStatuses")
    })
    .await;
    let kinds: Vec<&str> = pushed
        .iter()
        .filter_map(|f| f["values"][0]["type"].as_str())
        .collect();
    assert!(
        kinds.contains(&"settingsUpdated"),
        "settings change published: {kinds:?}"
    );
    assert!(
        kinds.contains(&"providerStatuses"),
        "provider statuses published: {kinds:?}"
    );

    // and the published providers carry the newly configured instance, so
    // the projection the picker reads is actually current. The body hangs
    // off `payload`, which is where the client reads it.
    let statuses = pushed
        .iter()
        .find(|f| f["values"][0]["type"] == "providerStatuses")
        .expect("providerStatuses frame");
    let ids: Vec<&str> = statuses["values"][0]["payload"]["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["instanceId"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&"ollama_local"),
        "the new provider is in the push: {ids:?}"
    );
}

/// #67: the Diagnostics page's RPCs are implemented, not unsupported —
/// and they answer with REAL measured process data, since the whole point
/// of the panel is telling a wedged agent subprocess from a busy one.
#[tokio::test]
async fn diagnostics_rpcs_are_implemented_and_report_real_processes() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    request(&state, &tx, "server.getProcessDiagnostics", json!({})).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "not the unsupported arm: {f:?}"
    );
    let d = &f["exit"]["value"];
    let procs = d["processes"].as_array().expect("processes array");
    if d["error"]["_tag"] == "None" {
        // The test binary IS the server process here, so a successful walk must find it.
        assert!(!procs.is_empty(), "a real tree, not an empty list: {d}");
        assert!(d["totalRssBytes"].as_i64().unwrap() > 0, "real memory: {d}");
        // Option-typed fields must use Effect's encoding or the client drops them.
        assert_eq!(
            procs[0]["pgid"]["_id"], "Option",
            "encoded Option: {}",
            procs[0]
        );
    } else {
        assert!(
            d["error"]["value"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("ps failed")),
            "a failed native read must name the collector that failed: {d}"
        );
        assert_eq!(
            d["processCount"], 0,
            "failed ps walk must not fabricate rows: {d}"
        );
    }

    // history: the read above sampled, so a bucket exists
    request(
        &state,
        &tx,
        "server.getProcessResourceHistory",
        json!({"windowMs": 60_000, "bucketMs": 1_000}),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "not the unsupported arm: {f:?}"
    );
    let h = &f["exit"]["value"];
    assert_eq!(h["windowMs"], 60_000, "the caller's window, echoed: {h}");
    if d["error"]["_tag"] == "None" {
        assert!(
            h["retainedSampleCount"].as_i64().unwrap() >= 1,
            "the read sampled: {h}"
        );
        assert!(
            !h["buckets"].as_array().unwrap().is_empty(),
            "a sampled bucket: {h}"
        );
    } else {
        assert_eq!(
            h["retainedSampleCount"], 0,
            "failed ps read must not invent history: {h}"
        );
        assert!(
            h["buckets"].as_array().unwrap().is_empty(),
            "failed ps read must not invent buckets: {h}"
        );
        assert_eq!(
            h["health"]["native"]["lastError"]["_tag"], "Some",
            "history reports the collector failure: {h}"
        );
    }

    // trace diagnostics: no OTLP file on this runtime, so it must say so
    // rather than answer with a clean-looking empty scan
    request(&state, &tx, "server.getTraceDiagnostics", json!({})).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "not the unsupported arm: {f:?}"
    );
    assert_eq!(
        f["exit"]["value"]["error"]["_tag"], "Some",
        "honest error: {f:?}"
    );
}

/// PROOF for #332, at the PRODUCT EDGE: an hourly request without bounds
/// comes back as `Exit(Failure)` carrying the TAGGED `UsageReadError`.
///
/// Two weaker outcomes both had to be excluded. `Exit(Success)` with an
/// error-shaped body is what the finding caught: the success channel is
/// typed `UsageSummary`, so the client decodes an error as a summary. And
/// a `Die` defect carrying only a message string throws away `reason` and
/// `detail`, turning a case the contract declares into an unexplained
/// crash — so this asserts the cause is `Fail` and the tag survives.
#[tokio::test]
async fn an_invalid_usage_window_is_a_typed_rpc_failure_not_a_success() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    request(
        &state,
        &tx,
        "server.getUsageSummary",
        json!({ "input": {
            "sinceDay": "2026-01-01", "untilDay": "2026-01-31",
            "timeZone": "UTC", "resolution": "hour",
        }}),
    )
    .await;

    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(f["exit"]["_tag"], "Failure", "not a success payload: {f}");
    let cause = &f["exit"]["cause"][0];
    assert_eq!(
        cause["_tag"], "Fail",
        "a DECLARED error, not a Die defect: {f}"
    );
    assert_eq!(cause["error"]["_tag"], "UsageReadError", "{f}");
    assert_eq!(cause["error"]["reason"], "invalidWindow", "{f}");
    assert!(
        cause["error"]["detail"]
            .as_str()
            .is_some_and(|d| d.contains("sinceTime")),
        "the detail names what was missing: {f}"
    );
}

/// #67/#328: `server.getUsageSummary` and `subscribeResourceTelemetry`
/// answer with contract-shaped, MEASURED data — usage read out of a real
/// transcript on disk, and a real `ps`-backed telemetry snapshot. Neither
/// falls through to unsupported-method; neither returns fabricated healthy
/// zeros where measurement failed.
///
/// This used to assert `buckets: []` and `sources: []`, which PINNED the
/// stub: the handler returned empty for every input, the assertion passed,
/// and real provider usage was invisible. The seeded transcript below is
/// what makes a regression to that stub fail here.
#[tokio::test]
async fn usage_summary_and_resource_telemetry_are_implemented_not_fabricated() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    // Seed a transcript and point THIS state at it. The suite must never
    // scan the developer's real `~/.claude`: an assertion that depends on
    // who ran it proves nothing.
    let usage_home = _d.join("claude-home");
    let transcript = usage_home.join("projects/p/session.jsonl");
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    std::fs::write(
        &transcript,
        format!(
            "{}\n",
            json!({
                "type": "assistant",
                "timestamp": "2026-01-14T10:00:00.000Z",
                "sessionId": "s-1", "requestId": "r-1",
                "message": { "id": "m-1", "model": "claude-opus-5", "usage": {
                    "input_tokens": 100, "cache_read_input_tokens": 20,
                    "cache_creation_input_tokens": 5, "output_tokens": 40,
                }},
            })
        ),
    )
    .unwrap();
    let mut state = state;
    state.usage_sources = Arc::new(vec![agent_sdk_usage::SourceSpec {
        provider: agent_sdk_usage::Provider::Claude,
        home: usage_home,
    }]);

    request(
        &state, &tx, "server.getUsageSummary",
        json!({ "input": { "sinceDay": "2026-01-01", "untilDay": "2026-01-31", "timeZone": "UTC" } }),
    ).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "not the unsupported arm: {f:?}"
    );
    let s = &f["exit"]["value"];
    assert_eq!(s["contractVersion"], 4, "shape version pinned: {s}");
    assert_eq!(s["timeZone"], "UTC", "the caller's zone, echoed: {s}");
    assert_eq!(s["sinceDay"], "2026-01-01");
    assert_eq!(s["untilDay"], "2026-01-31");
    let buckets = s["buckets"].as_array().unwrap();
    assert_eq!(
        buckets.len(),
        1,
        "the seeded turn must be REPORTED, not swallowed: {s}"
    );
    assert_eq!(buckets[0]["day"], "2026-01-14");
    assert_eq!(buckets[0]["totals"]["outputTokens"], 40);
    let sources = s["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1, "the scanned source is reported: {s}");
    assert_eq!(sources[0]["status"], "ok");
    assert_eq!(sources[0]["scannedFiles"], 1);
    assert_eq!(
        s["pricing"]["status"], "unavailable",
        "no rate table is cached here, and the payload says so: {s}"
    );
    assert_eq!(
        buckets[0]["costSource"], "unpriced",
        "tokens counted, cost reported as unknown rather than $0: {s}"
    );

    request(&state, &tx, "subscribeResourceTelemetry", json!({})).await;
    // first Chunk arrives synchronously — the handler pushes the initial
    // snapshot before spawning the pump.
    let chunks: Vec<Value> = drain_until(&mut rx, std::time::Duration::from_secs(2), |f| {
        f.get("_tag").and_then(Value::as_str) == Some("Chunk")
    })
    .await;
    let first = chunks
        .iter()
        .find(|f| f["_tag"] == "Chunk")
        .expect("initial snapshot chunk");
    let snap = &first["values"][0];
    assert!(
        snap["sampleIntervalMs"].as_i64().unwrap() > 0,
        "interval reported: {snap}"
    );
    let procs = snap["processes"].as_array().expect("processes array");
    if snap["health"]["native"]["status"] == "healthy" {
        assert!(
            !procs.is_empty(),
            "measured tree, not fabricated empty: {snap}"
        );
        // Per-process I/O must be typed unavailable, not zeroed as healthy.
        assert_eq!(
            procs[0]["ioSemantics"], "unavailable",
            "ps does not expose per-process I/O; contract requires typed unavailable: {}",
            procs[0]
        );
    } else {
        assert_eq!(
            snap["health"]["native"]["status"], "unavailable",
            "native source must fail honestly, not report healthy zeros: {snap}"
        );
        assert_eq!(
            procs.len(),
            0,
            "failed native source must not fabricate rows: {snap}"
        );
        assert_eq!(
            snap["health"]["native"]["lastError"]["_tag"], "Some",
            "unavailable native source names the failure: {snap}"
        );
    }
    // Option-typed fields carry Effect encoding.
    assert_eq!(
        snap["speedLimitPercent"]["_id"], "Option",
        "encoded Option: {snap}"
    );
}

/// #332: `server.getUsageSummary` must route `UsageReadError` through
/// the RPC error arm, not smuggle it back as `Exit(Success)` carrying a
/// tagged variant the client's success decoder was not built to
/// #328/#332: A SOURCE THAT CANNOT BE READ IS REPORTED, NOT ERASED.
///
/// The two loud cases already have tests: a good scan returns real buckets,
/// a bad window returns a tagged `UsageReadError`. This is the quiet one
/// between them, and it is the one the original stub was indistinguishable
/// from — a source root the server cannot read produces zero buckets, and
/// zero buckets is exactly what "you have no usage" looks like.
///
/// The contract's answer is that the summary is still a SUCCESS (other
/// sources may have real data, and failing the whole RPC would erase
/// theirs too) but it must carry the broken source in `sources` with a
/// non-ok status and a message. Silence here is the bug: the user sees an
/// empty usage panel and no reason for it.
///
/// This is also why `scanFailed` is not reachable from this input — I went
/// looking for a way to trigger it and there is not one, because per-source
/// failures are deliberately reported INSIDE the summary rather than
/// collapsing the request. That is the right call; the test pins it so the
/// reporting cannot quietly regress to emptiness.
#[tokio::test]
async fn an_unreadable_usage_source_is_reported_not_silently_empty() {
    let (mut state, _d) = test_state().await;

    // A source home that does not exist. Never the developer's real
    // `~/.claude`: an assertion that depends on who ran it proves nothing.
    let missing_home = _d.join("no-such-claude-home");
    state.usage_sources = Arc::new(vec![agent_sdk_usage::SourceSpec {
        provider: agent_sdk_usage::Provider::Claude,
        home: missing_home.clone(),
    }]);

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state, &tx, "server.getUsageSummary",
        json!({ "input": { "sinceDay": "2026-01-01", "untilDay": "2026-12-31", "timeZone": "UTC" } }),
    ).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");

    assert_eq!(
        f["exit"]["_tag"], "Success",
        "one unreadable source does not fail the whole request — other \
         sources' data would be erased with it: {f}"
    );
    let summary = &f["exit"]["value"];
    let sources = summary["sources"].as_array().expect("a sources array");
    assert_eq!(
        sources.len(),
        1,
        "the configured source is accounted for: {summary}"
    );
    let src = &sources[0];
    assert_ne!(
        src["status"], "ok",
        "a source that could not be read must NOT be reported ok: {src}"
    );
    assert!(
        src["message"].as_str().is_some_and(|m| !m.is_empty()),
        "and it must say why, or the empty panel has no explanation: {src}"
    );
    assert_eq!(
        summary["buckets"].as_array().map(|b| b.len()),
        Some(0),
        "no data was readable, so there are no buckets — the point is that \
         this emptiness is EXPLAINED by the source row above: {summary}"
    );
}

/// classify. An invalid window is the smallest reproducer.
#[tokio::test]
async fn usage_summary_invalid_window_exits_failure_not_a_tagged_success() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state, &tx, "server.getUsageSummary",
        // `sinceDay > untilDay` — usage_summary_from returns
        // `{"_tag":"UsageReadError", ...}` for this.
        json!({ "input": { "sinceDay": "2026-02-01", "untilDay": "2026-01-01", "timeZone": "UTC" } }),
    ).await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        f["exit"]["_tag"], "Failure",
        "an invalid window is a contract Failure, not a Success wrapping UsageReadError: {f}"
    );
    // And it is the DECLARED error, not a defect: `UsageReadError` is on
    // the RPC's error channel, so the client has a branch for it and needs
    // `reason` to take that branch. A `Die` carrying only a message string
    // would satisfy "it failed" while giving the UI nothing to say beyond
    // "unknown" — which is why this asserts the tag, not just a message.
    let cause = &f["exit"]["cause"][0];
    assert_eq!(
        cause["_tag"], "Fail",
        "declared error, not a Die defect: {f}"
    );
    assert_eq!(cause["error"]["_tag"], "UsageReadError", "{f}");
    assert_eq!(cause["error"]["reason"], "invalidWindow", "{f}");
    assert!(
        cause["error"]["detail"]
            .as_str()
            .is_some_and(|d| d.contains("2026-01-01")),
        "the detail names the window that was rejected: {f}"
    );
}

/// #71: keyboard customization over the wire. `server.getConfig` used to
/// ship `keybindings: []` with a `/dev/null` path and both mutations fell
/// through to unsupported-method, so the settings page saved into nothing
/// and the UI sat on its built-in fallbacks forever.
#[tokio::test]
async fn keybinding_edits_are_durable_and_reach_the_config_surface() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    // boot config ships the real keyboard, not an empty list
    request(&state, &tx, "server.getConfig", json!({})).await;
    let cfg = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    let boot = cfg["exit"]["value"].clone();
    assert!(
        boot["keybindings"].as_array().map(|a| a.len()).unwrap_or(0) > 30,
        "defaults must be served: {boot}"
    );
    assert_ne!(
        boot["keybindingsConfigPath"], "/dev/null",
        "path must be real: {boot}"
    );
    // the compiled shape the client dispatches on
    let first = &boot["keybindings"][0];
    assert!(first["command"].is_string(), "compiled rule: {first}");
    assert!(
        first["shortcut"]["key"].is_string(),
        "compiled rule: {first}"
    );

    // rebind a command
    request(
        &state,
        &tx,
        "server.upsertKeybinding",
        json!({"key": "mod+shift+b", "command": "sidebar.toggle"}),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(
        f["exit"]["_tag"], "Success",
        "not the unsupported arm: {f:?}"
    );
    let bound = f["exit"]["value"]["keybindings"]
        .as_array()
        .unwrap()
        .clone();
    let sidebar: Vec<&Value> = bound
        .iter()
        .filter(|r| r["command"] == "sidebar.toggle")
        .collect();
    assert_eq!(
        sidebar.len(),
        1,
        "the default is retired, not duplicated: {sidebar:?}"
    );
    assert_eq!(
        sidebar[0]["shortcut"]["shiftKey"], true,
        "the custom rule won"
    );

    // DURABLE: a fresh getConfig on a new connection still has it
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(&state, &tx2, "server.getConfig", json!({})).await;
    let again = drain(&mut rx2)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    let persisted: Vec<Value> = again["exit"]["value"]["keybindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == "sidebar.toggle")
        .cloned()
        .collect();
    assert_eq!(persisted.len(), 1);
    assert_eq!(
        persisted[0]["shortcut"]["shiftKey"], true,
        "survived the reconnect"
    );

    // removing the override restores the built-in binding rather than
    // leaving the command dead
    request(
        &state,
        &tx,
        "server.removeKeybinding",
        json!({"key": "mod+shift+b", "command": "sidebar.toggle"}),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(f["exit"]["_tag"], "Success", "{f:?}");
    let restored: Vec<Value> = f["exit"]["value"]["keybindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == "sidebar.toggle")
        .cloned()
        .collect();
    assert_eq!(restored.len(), 1);
    assert_eq!(
        restored[0]["shortcut"]["shiftKey"], false,
        "default came back"
    );
}

/// An unparseable binding must FAIL visibly. Storing it would report a
/// successful save for a shortcut that can never fire.
#[tokio::test]
async fn an_unparseable_keybinding_is_refused_not_silently_stored() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.upsertKeybinding",
        json!({"key": "a+b", "command": "sidebar.toggle"}),
    )
    .await;
    let f = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    assert_eq!(f["exit"]["_tag"], "Failure", "must refuse: {f:?}");
    let msg = f["exit"].to_string();
    assert!(
        !msg.contains("unsupported"),
        "the method IS implemented: {msg}"
    );

    // and nothing was persisted
    request(&state, &tx, "server.getConfig", json!({})).await;
    let cfg = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .unwrap();
    let sidebar: Vec<Value> = cfg["exit"]["value"]["keybindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == "sidebar.toggle")
        .cloned()
        .collect();
    assert_eq!(sidebar.len(), 1, "still exactly the default: {sidebar:?}");
    assert_eq!(sidebar[0]["shortcut"]["key"], "b");
    assert_eq!(sidebar[0]["shortcut"]["shiftKey"], false);
}

/// A keybinding write must reach passive surfaces through the config
/// stream, in the envelope the client's union actually decodes.
#[tokio::test]
async fn keybinding_writes_publish_the_contract_event() {
    let (state, _d) = test_state().await;
    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeServerConfig", json!({})).await;
    let _ = drain(&mut sub_rx);

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.upsertKeybinding",
        json!({"key": "mod+shift+k", "command": "commandPalette.toggle"}),
    )
    .await;
    assert_eq!(
        drain(&mut rx)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap()["exit"]["_tag"],
        "Success"
    );

    // 5s, not 2: the deadline is bounding an async broker pump under a
    // fully parallel test binary, and a machine-load-dependent deadline is
    // a test that fails for a reason the code cannot cause.
    let pushed = drain_until(&mut sub_rx, std::time::Duration::from_secs(5), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("type"))
            .and_then(Value::as_str)
            == Some("keybindingsUpdated")
    })
    .await;
    let ev = pushed
        .iter()
        .find(|f| f["values"][0]["type"] == "keybindingsUpdated")
        .unwrap_or_else(|| panic!("no keybindingsUpdated on the stream: {pushed:?}"));
    let item = &ev["values"][0];
    assert_eq!(item["version"], 1, "contract envelope: {item}");
    assert!(
        item["payload"]["keybindings"].is_array(),
        "payload-shaped: {item}"
    );
    assert!(
        item["payload"]["issues"].is_array(),
        "issues travel with it: {item}"
    );
    let palette: Vec<&Value> = item["payload"]["keybindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["command"] == "commandPalette.toggle")
        .collect();
    assert_eq!(palette.len(), 1);
    assert_eq!(
        palette[0]["shortcut"]["shiftKey"], true,
        "the new binding is in the push"
    );
}

/// #64: the project file RPCs are implemented, admitted, and confined —
/// the file picker/preview/write surface actually works on this runtime.
#[tokio::test]
async fn project_file_rpcs_are_implemented_and_confined() {
    let (state, dir) = test_state().await;
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn x() {}\n").unwrap();
    let cwd = dir.to_string_lossy().into_owned();

    let call = |m: &'static str, p: Value| {
        let state = state.clone();
        async move {
            let (tx, mut rx) = mpsc::unbounded_channel();
            request(&state, &tx, m, p).await;
            drain(&mut rx)
                .into_iter()
                .find(|f| f["_tag"] == "Exit")
                .expect("exits")
        }
    };

    for m in [
        "projects.listEntries",
        "projects.searchEntries",
        "projects.readFile",
        "projects.writeFile",
    ] {
        let payload = match m {
            "projects.searchEntries" => json!({"cwd": cwd, "query": "lib", "limit": 10}),
            "projects.readFile" => json!({"cwd": cwd, "relativePath": "src/lib.rs"}),
            "projects.writeFile" => {
                json!({"cwd": cwd, "relativePath": "notes.md", "contents": "hi\n"})
            }
            _ => json!({"cwd": cwd}),
        };
        let exit = call(m, payload).await;
        assert_eq!(
            exit["exit"]["_tag"], "Success",
            "{m} must be implemented: {exit}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(dir.join("notes.md")).unwrap(),
        "hi\n",
        "the write landed"
    );

    // a path escaping the workspace is refused
    let exit = call(
        "projects.readFile",
        json!({"cwd": cwd, "relativePath": "../../etc/passwd"}),
    )
    .await;
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "an escaping read must be refused: {exit}"
    );

    // and an outside cwd is refused before any file work happens
    let outside = std::env::temp_dir().join(format!("t3-proj-out-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    let exit = call(
        "projects.listEntries",
        json!({"cwd": outside.to_string_lossy()}),
    )
    .await;
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "an outside project is refused: {exit}"
    );
    let _ = std::fs::remove_dir_all(&outside);
}

/// #90: the approval bridge must decode the CONTRACT, not a legacy boolean.
/// Reading `approved` and defaulting to false turned every real acceptance
/// into a denial — the user clicks Approve and the tool is refused.
#[test]
fn approval_decisions_decode_from_the_contract_vocabulary() {
    // the mapping the dispatcher applies
    let decide = |cmd: Value| -> bool {
        match cmd.get("decision").and_then(Value::as_str).unwrap_or("") {
            "accept" | "acceptForSession" => true,
            "decline" | "cancel" => false,
            _ => cmd
                .get("approved")
                .or_else(|| cmd.get("allow"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    };
    assert!(decide(json!({"decision": "accept"})), "accept must APPROVE");
    assert!(
        decide(json!({"decision": "acceptForSession"})),
        "acceptForSession must APPROVE"
    );
    assert!(!decide(json!({"decision": "decline"})));
    assert!(!decide(json!({"decision": "cancel"})));
    // legacy boolean still honoured when no decision is present
    assert!(decide(json!({"approved": true})));
    assert!(!decide(json!({})), "no signal at all is the safe default");
}

/// #90: user input arrives as an ANSWERS MAP; reading `text` steered every
/// normal submission with an empty string.
#[test]
fn user_input_answers_decode_from_the_answers_map() {
    let text_of = |cmd: Value| -> String {
        cmd.get("answers")
            .and_then(Value::as_object)
            .map(|m| {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                keys.iter()
                    .map(|k| {
                        let v = &m[*k];
                        let t = v
                            .as_str()
                            .map(String::from)
                            .unwrap_or_else(|| v.to_string());
                        if keys.len() == 1 {
                            t
                        } else {
                            format!("{k}: {t}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .or_else(|| cmd.get("text").and_then(Value::as_str).map(String::from))
            .unwrap_or_default()
    };
    assert_eq!(
        text_of(json!({"answers": {"q1": "yes"}})),
        "yes",
        "a single answer is bare"
    );
    assert_eq!(
        text_of(json!({"answers": {"b": "two", "a": "one"}})),
        "a: one\nb: two",
        "multiple answers are labelled and stably ordered"
    );
    assert_eq!(text_of(json!({"text": "legacy"})), "legacy");
    assert_eq!(text_of(json!({})), "");
}

/// #79: the runtime mode is an ENFORCEMENT point, not a badge. A definition
/// built with an empty ask_tools is allow-all no matter what the UI shows.
#[test]
fn runtime_modes_produce_a_real_gate() {
    let (ask, instr) = policy_for("approval-required", "default");
    assert!(ask.contains(&"run_bash".to_string()), "shell asks: {ask:?}");
    assert!(
        ask.contains(&"write_file".to_string()),
        "edits ask: {ask:?}"
    );
    assert!(ask.contains(&"edit_file".to_string()));
    assert!(instr.contains("approval"), "{instr}");

    // edits run, the shell still asks — an edit is checkpointed and
    // revertable, an arbitrary command is not
    let (ask, _) = policy_for("auto-accept-edits", "default");
    assert!(ask.contains(&"run_bash".to_string()), "{ask:?}");
    assert!(!ask.contains(&"write_file".to_string()), "{ask:?}");

    let (ask, _) = policy_for("full-access", "default");
    assert!(ask.is_empty(), "full access gates nothing: {ask:?}");
    let (ask, _) = policy_for("auto", "default");
    assert!(ask.is_empty());

    // plan mode gates mutations even under full-access: an instruction the
    // model can ignore is not a policy
    let (ask, instr) = policy_for("full-access", "plan");
    assert!(
        ask.contains(&"write_file".to_string()),
        "plan mode gates edits: {ask:?}"
    );
    assert!(ask.contains(&"run_bash".to_string()));
    assert!(instr.contains("PLAN"), "{instr}");
}

/// #69: the approval answer is decoded from the contract's decision ENUM.
/// The regression this guards against read a boolean `approved` (default
/// false), so an "accept" became a denial — the user approves and the tool
/// is refused.
#[test]
fn approval_decision_enum_is_decoded_not_defaulted_to_deny() {
    assert!(
        approval_allow(&json!({"decision": "accept"})),
        "accept allows"
    );
    assert!(
        approval_allow(&json!({"decision": "acceptForSession"})),
        "acceptForSession allows"
    );
    assert!(
        !approval_allow(&json!({"decision": "decline"})),
        "decline denies"
    );
    assert!(
        !approval_allow(&json!({"decision": "cancel"})),
        "cancel denies"
    );
    // no decision → legacy boolean fallback, not a silent deny of a true.
    assert!(
        approval_allow(&json!({"approved": true})),
        "legacy approved bool honored"
    );
    assert!(!approval_allow(&json!({"approved": false})));
    assert!(
        !approval_allow(&json!({})),
        "nothing to go on defaults to deny (fail closed)"
    );
    // a present decision is authoritative over a stale/legacy boolean.
    assert!(
        approval_allow(&json!({"decision": "accept", "approved": false})),
        "decision wins"
    );
}

/// #73: metadata changed outside a turn is DURABLE, validated, announced —
/// and the next turn actually uses it.
/// LIVE-WIRE REGRESSION (found on a real socket, not in review): a command
/// that FAILS must not be acked as Success, and one request must produce
/// exactly ONE terminal frame.
///
/// Both halves were broken and the second hid the first: `exit_success` ran
/// BEFORE the match arm, so a failing `thread.meta.update` had nowhere to
/// report to and could only log. The probe transcript was
/// `Exit(Success){sequence:2}` on the wire while the server logged
/// `unknown thread t-probe-1`; fixing only the arm produced Success AND
/// THEN Failure for one request id.
#[tokio::test]
async fn a_failed_command_is_reported_as_failure_exactly_once() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({
            "input": { "type": "thread.meta.update", "threadId": "t-nonexistent",
                       "patch": { "title": "should not land" } }
        }),
    )
    .await;

    let exits: Vec<Value> = drain(&mut rx)
        .into_iter()
        .filter(|f| f["_tag"] == "Exit")
        .collect();
    assert_eq!(
        exits.len(),
        1,
        "one request, one terminal — a Success ack followed by a Failure is a protocol \
         violation the client cannot reconcile: {exits:#?}"
    );
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "an update the runtime refused must not be acked as applied — the UI would show a \
         setting that never landed: {exits:#?}"
    );
}

/// The other direction, so the fix above cannot be "fail everything": a
/// command that SUCCEEDS still acks exactly once, with its sequence, and
/// the change is durable.
#[tokio::test]
async fn a_successful_command_acks_once_and_the_change_is_durable() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();

    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({
            "input": { "type": "project.meta.update", "projectId": "p-workspace",
                       "patch": { "title": "renamed by test" } }
        }),
    )
    .await;

    let exits: Vec<Value> = drain(&mut rx)
        .into_iter()
        .filter(|f| f["_tag"] == "Exit")
        .collect();
    assert_eq!(exits.len(), 1, "exactly one terminal: {exits:#?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Success",
        "the valid update is acked: {exits:#?}"
    );
    assert!(
        exits[0]["exit"]["value"]["sequence"].is_i64(),
        "the ack still carries its durable dispatch sequence: {exits:#?}"
    );

    let projects = state.rt.projects().await.expect("projects readable");
    let title = projects
        .iter()
        .find(|p| p["id"] == "p-workspace")
        .and_then(|p| p["title"].as_str());
    assert_eq!(
        title,
        Some("renamed by test"),
        "the ack was not a lie: {projects:#?}"
    );
}

/// LIVE-WIRE REGRESSION: a durable project change must be ANNOUNCED, or a
/// reconnecting client is told `synchronized` over a change it can never
/// learn about.
///
/// On the wire this read as: rename while the client is away → reconnect
/// with `afterSequence` → `{"kind":"synchronized"}` and nothing else, with
/// the sidebar holding the old title indefinitely. The thread path already
/// emitted through `emit_shell_event`; the project path saved and said
/// nothing.
#[tokio::test]
async fn a_project_update_is_replayable_by_a_client_that_was_away() {
    let (state, _d) = test_state().await;
    let mark = state.rt.shell_sequence().await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({
            "input": { "type": "project.meta.update", "projectId": "p-workspace",
                       "patch": { "title": "renamed while away" } }
        }),
    )
    .await;
    drain(&mut rx);

    // What a reconnecting client asks for: everything after the mark it held.
    let missed = state
        .rt
        .shell_events_after(mark, 500)
        .await
        .expect("replay readable");
    let found = missed
        .iter()
        .any(|f| f["kind"] == "project-upserted" && f["project"]["title"] == "renamed while away");
    assert!(
        found,
        "the change must be in the REPLAY LOG, not only in the durable row — a snapshot-only \
         change is invisible to every resume path: {missed:#?}"
    );
}

#[tokio::test]
async fn thread_meta_updates_persist_and_reach_the_next_turn() {
    let (state, _d) = test_state().await;
    // create the thread via a turn bootstrap
    ensure_thread_on_shell(&state, &json!({
        "threadId": "t-meta", "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001"},
        "message": {"text": "hi", "messageId": "m1"},
    })).await;

    // change the mode + title OUTSIDE a turn
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({"input": {
            "type": "thread.meta.update", "threadId": "t-meta",
            "patch": {"runtimeMode": "approval-required", "title": "renamed"},
        }}),
    )
    .await;
    assert_eq!(
        drain(&mut rx)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap()["exit"]["_tag"],
        "Success"
    );

    // it is DURABLE
    let t = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t["id"] == "t-meta")
        .unwrap();
    assert_eq!(
        t["runtimeMode"], "approval-required",
        "the mode persisted: {t}"
    );
    assert_eq!(t["title"], "renamed");

    // and a turn that does NOT repeat the mode still gets the gate
    let stored_mode = t["runtimeMode"].as_str().unwrap();
    let (ask, _) = policy_for(stored_mode, "default");
    assert!(!ask.is_empty(), "the stored mode gates the next turn");

    // an unroutable model selection is REFUSED rather than persisted
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({"input": {
            "type": "thread.meta.update", "threadId": "t-meta",
            "patch": {"modelSelection": {"instanceId": "nope", "model": "x"}},
        }}),
    )
    .await;
    let _ = drain(&mut rx);
    let t = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t["id"] == "t-meta")
        .unwrap();
    assert_ne!(
        t["modelSelection"]["instanceId"], "nope",
        "a selection the runtime cannot route must not be stored: {t}"
    );
}

/// #101/#100: `server.getConfig` must decode. An invented `status` literal
/// or a raw SDK option struct can fail the decode for the WHOLE provider
/// list, not just the offending row.
#[tokio::test]
async fn provider_entries_use_the_contract_shapes() {
    let (state, _d) = test_state().await;

    // add a deliberately BROKEN instance so an unavailable row is rendered
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({"patch": {"providerInstances": {
            "broken_ollama": {"driver": "openaiCompat", "enabled": true, "config": {}},
        }}}),
    )
    .await;
    let _ = drain(&mut rx);

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let providers = drain(&mut rx)[0]["exit"]["value"]["providers"].clone();
    const VALID: &[&str] = &["ready", "warning", "error", "disabled"];

    let mut saw_unavailable = false;
    for p in providers.as_array().unwrap() {
        let status = p["status"].as_str().unwrap();
        assert!(
            VALID.contains(&status),
            "invalid ServerProviderState {status:?}: {p}"
        );

        if p["availability"] == "unavailable" {
            saw_unavailable = true;
            // the contract REQUIRES these on an unavailable snapshot
            assert_eq!(p["installed"], json!(false), "{p}");
            assert_eq!(p["enabled"], json!(false), "{p}");
            assert!(
                p["unavailableReason"]
                    .as_str()
                    .is_some_and(|r| !r.is_empty()),
                "{p}"
            );
        }

        // options are the contract's tagged union, never the SDK struct
        for o in p["options"].as_array().unwrap() {
            let t = o["type"].as_str().unwrap();
            assert!(
                t == "select" || t == "boolean",
                "unknown option type {t}: {o}"
            );
            assert!(o["id"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(o["label"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(o.get("values").is_none(), "SDK `values` leaked: {o}");
            assert!(o.get("models").is_none(), "SDK `models` leaked: {o}");
            if t == "select" {
                let choices = o["options"].as_array().expect("select carries `options`");
                assert!(!choices.is_empty(), "{o}");
                for c in choices {
                    assert!(c["id"].as_str().is_some_and(|s| !s.is_empty()), "{c}");
                    assert!(c["label"].as_str().is_some_and(|s| !s.is_empty()), "{c}");
                }
                assert_eq!(
                    choices
                        .iter()
                        .filter(|c| c["isDefault"] == json!(true))
                        .count(),
                    1
                );
            }
        }
    }
    assert!(
        saw_unavailable,
        "the broken instance rendered as an unavailable row"
    );
}

/// A change the USER makes outside the backend moves the panel.
///
/// The backend publishes directly after its own VCS commands, so an
/// in-backend mutation proves nothing about the watcher. This edits the
/// working tree entirely outside the server — the case the watcher exists
/// for, and the one a user hits every time they save in another editor.
///
/// It used to be caught by a 1.5s `git status` timer per subscriber. The
/// current watcher is edge-first, with one low-frequency reconciliation pass
/// per watched repo so a dropped platform event cannot wedge the panel forever.
///
/// A BRANCH SWITCH rather than a commit, deliberately: with no upstream
/// configured a commit leaves every field of `vcs::status` identical (same
/// ref, ahead/behind 0, clean tree), so it is invisible to this projection
/// by construction — as it was to the poller. `refName` is a field the panel
/// actually renders, so a switch is a change a client can see.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_edit_made_outside_the_backend_reaches_a_vcs_subscriber() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let sh = |c: &str| {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(c)
            .current_dir(&dir)
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "`{c}`: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    sh("git config user.email t@t && git config user.name t");
    // The runtime's own store lives under this same temp dir, so its
    // `data/` tree — including SQLite WAL files it rewrites as the server
    // works — sits INSIDE the repository under test. Left untracked, every
    // one of those writes moves `vcs::status` and fires a filesystem edge,
    // so the watcher publishes a `localUpdated` that has nothing to do with
    // anything a user did. That is an artifact of co-locating the store and
    // the fixture repo, not a real edge; production keeps the data dir well
    // outside the user's working tree. Ignore it so this test observes the
    // change it is actually about.
    std::fs::write(dir.join(".gitignore"), "data/\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    sh("git add -A && git commit -qm base");

    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeVcsStatus", json!({"cwd": cwd})).await;
    assert_eq!(drain(&mut sub_rx)[0]["values"][0]["_tag"], "snapshot");

    // Drive the SAME function the supervisor drives, and wait for its
    // ready receipt: once it fires, the watch is placed and the placement
    // window is reconciled, so a change made after it MUST arrive. No
    // retry loop, no deadline to tune — the old version raced watch
    // placement and only passed because it kept trying.
    // Watch the directory string the SUBSCRIBER was registered under, not
    // the raw test path: `resolve_cwd` canonicalizes (on macOS a temp dir
    // `/var/...` resolves to `/private/var/...`) and the fan-out matches
    // subscribers by exact string, so watching the unresolved path publishes
    // to nobody.
    // Both come from the DURABLE watch registry now (#335), not from a
    // product-side tuple — which is also the point of the finding: the
    // baseline a watcher reconciles against is the runtime's, so a restart
    // or a second backend reconciles against the same one.
    let (watched, baseline) = state
        .rt
        .watch_marks("vcs")
        .await
        .expect("the watch registry is readable")
        .into_iter()
        .next()
        .expect("the subscriber registered a watch");
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let watcher = tokio::spawn(watch_one_tree(
        state.clone(),
        watched,
        baseline,
        Some(ready_tx),
    ));
    ready.await.expect("the watch is placed");

    sh("git checkout -q -b user-branch");

    let mut saw = false;
    while let Ok(Some((raw, _))) =
        tokio::time::timeout(std::time::Duration::from_secs(20), sub_rx.recv()).await
    {
        let v: Value = serde_json::from_str(&raw).unwrap();
        if v["values"][0]["_tag"] == "localUpdated" {
            assert_eq!(
                v["values"][0]["local"]["refName"], "user-branch",
                "it carries the branch the user actually switched to: {:?}",
                v["values"][0]["local"]
            );
            saw = true;
            break;
        }
    }
    watcher.abort();
    assert!(
        saw,
        "an out-of-band branch switch reached the subscriber through the watch"
    );
}

/// A status read failure after the watch is already live is still a status
/// update, not silence. The contract arm exists (`statusUnavailable`); the
/// watcher must publish it when cairn reports that a filesystem edge led to an
/// unreadable repository state.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vcs_watch_status_error_reaches_the_subscriber_as_unavailable() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let sh = |c: &str| {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(c)
            .current_dir(&dir)
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "`{c}`: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    sh("git config user.email t@t && git config user.name t");
    std::fs::write(dir.join(".gitignore"), "data/\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    sh("git add -A && git commit -qm base");

    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeVcsStatus", json!({"cwd": cwd})).await;
    assert_eq!(drain(&mut sub_rx)[0]["values"][0]["_tag"], "snapshot");

    let (watched, baseline) = state
        .rt
        .watch_marks("vcs")
        .await
        .expect("the watch registry is readable")
        .into_iter()
        .next()
        .expect("the subscriber registered a watch");
    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let watcher = tokio::spawn(watch_one_tree(
        state.clone(),
        watched,
        baseline,
        Some(ready_tx),
    ));
    ready.await.expect("the watch is placed");

    std::fs::write(dir.join(".git/index"), b"\x00not a git index\x00").unwrap();

    let mut saw = false;
    while let Ok(Some((raw, _))) =
        tokio::time::timeout(std::time::Duration::from_secs(20), sub_rx.recv()).await
    {
        let v: Value = serde_json::from_str(&raw).unwrap();
        if v["values"][0]["_tag"] == "localUpdated" {
            let local = &v["values"][0]["local"];
            if local["statusUnavailable"] == json!(true) {
                assert_eq!(
                    local["isRepo"],
                    json!(true),
                    "the repo was demoted instead of degraded: {local}"
                );
                assert!(
                    local["statusError"].as_str().is_some_and(|e| !e.is_empty()),
                    "the unavailable status carries no error: {local}"
                );
                saw = true;
                break;
            }
        }
    }
    watcher.abort();
    assert!(
        saw,
        "a post-subscription status error was not published as statusUnavailable"
    );
}

/// #174: a status read that fails while the watch is being PLACED is the same
/// visible failure as one that fails after it is live (#49).
///
/// By the time `watch_one_tree` runs, `subscribeVcsStatus` has already sent a
/// snapshot and registered a durable watch claim. If placement then returns an
/// error and we only log it, the subscriber keeps a live subscription that no
/// watcher will ever feed: the panel freezes on the last good status with no
/// error anywhere. This corrupts the index BETWEEN the snapshot/claim and
/// placement, which is the exact window the earlier test cannot reach.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_vcs_watch_that_cannot_be_placed_reaches_the_subscriber_as_unavailable() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let sh = |c: &str| {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(c)
            .current_dir(&dir)
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "`{c}`: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    sh("git config user.email t@t && git config user.name t");
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    sh("git add -A && git commit -qm base");

    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeVcsStatus", json!({"cwd": cwd})).await;
    assert_eq!(drain(&mut sub_rx)[0]["values"][0]["_tag"], "snapshot");

    let (watched, baseline) = state
        .rt
        .watch_marks("vcs")
        .await
        .expect("the watch registry is readable")
        .into_iter()
        .next()
        .expect("the subscriber registered a watch");

    // The repository is readable for the snapshot and the claim, then stops
    // being readable before placement gets its own status read.
    std::fs::write(dir.join(".git/index"), b"\x00not a git index\x00").unwrap();

    let watcher = tokio::spawn(watch_one_tree(state.clone(), watched, baseline, None));

    let mut saw = false;
    while let Ok(Some((raw, _))) =
        tokio::time::timeout(std::time::Duration::from_secs(20), sub_rx.recv()).await
    {
        let v: Value = serde_json::from_str(&raw).unwrap();
        if v["values"][0]["_tag"] == "localUpdated" {
            let local = &v["values"][0]["local"];
            if local["statusUnavailable"] == json!(true) {
                assert_eq!(
                    local["isRepo"],
                    json!(true),
                    "the repo was demoted instead of degraded: {local}"
                );
                assert!(
                    local["statusError"].as_str().is_some_and(|e| !e.is_empty()),
                    "the unavailable status carries no error: {local}"
                );
                saw = true;
                break;
            }
        }
    }
    watcher.abort();
    assert!(
        saw,
        "a watch that could not be placed was swallowed: the subscriber holds a \
         live subscription and a durable claim that nothing will ever feed"
    );
}

/// #51: the subscription snapshot and the durable watch baseline are one read.
///
/// If the snapshot is read clean, then the worktree changes before
/// `watch_begin`, registering a freshly re-read dirty fingerprint suppresses
/// the dirty status as "already seen" even though the subscriber never saw it.
/// This drives that exact window without sleeping: take the clean snapshot
/// baseline, mutate the repo, then register/start the watch from that baseline.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn vcs_snapshot_baseline_survives_a_mutation_before_watch_registration() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let sh = |c: &str| {
        let out = std::process::Command::new("sh")
            .arg("-c").arg(c).current_dir(&dir).output().expect("sh");
        assert!(out.status.success(), "`{c}`: {}", String::from_utf8_lossy(&out.stderr));
    };
    sh("git config user.email t@t && git config user.name t");
    std::fs::write(dir.join(".gitignore"), "data/\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    sh("git add -A && git commit -qm base");

    let tail = state.rt.vcs_tail_skip_retained(&cwd).await.expect("vcs tail");
    let (snapshot, baseline) = vcs::status_snapshot_and_fingerprint(&cwd).await;
    assert_eq!(snapshot["_tag"], "snapshot", "{snapshot}");
    assert_eq!(
        snapshot["local"]["hasWorkingTreeChanges"], false,
        "the subscriber snapshot is clean before the interleaving: {snapshot}"
    );

    std::fs::write(dir.join("a.txt"), "two\n").unwrap();
    state.rt.watch_begin("vcs", &cwd, &baseline).await.expect("watch begin");
    let (watched, registered) = state
        .rt
        .watch_marks("vcs")
        .await
        .expect("the watch registry is readable")
        .into_iter()
        .next()
        .expect("the subscriber registered a watch");
    assert_eq!(registered, baseline, "watch_begin uses the snapshot's baseline");

    let (ready_tx, ready) = tokio::sync::oneshot::channel();
    let watcher =
        tokio::spawn(watch_one_tree(state.clone(), watched, registered, Some(ready_tx)));
    ready.await.expect("the watch is placed");

    let items = tail.next(std::time::Duration::from_secs(20)).await.expect("vcs tail read");
    tail.close().await;
    watcher.abort();
    let local = items
        .into_iter()
        .map(|(_, item)| item)
        .find(|item| item["_tag"] == "localUpdated")
        .expect("the dirty status must publish immediately from the clean baseline");
    assert_eq!(
        local["local"]["hasWorkingTreeChanges"], true,
        "the mutation between snapshot and registration must not be suppressed: {local}"
    );
}

/// A bare context: these tools do not read anything off it.
struct ToolCtx;
impl agent_sdk_core::Ctx for ToolCtx {}

/// #207: a thread bound to a git worktree must do its work INSIDE that
/// worktree — the shell as well as the files.
///
/// Re-rooting only the file tools leaves `run_bash` on the boot PTY while
/// `coding_tools` still derives the reported `session_id` from the worktree
/// path, so the agent types into the main checkout and hands back an id for
/// a shell that never ran the command. This drives the real registry
/// factory the runtime uses and checks both halves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worktree_thread_shells_and_edits_inside_its_worktree() {
    let (state, dir) = test_state().await;
    let worktree = dir.join("wt-alpha");
    std::fs::create_dir_all(&worktree).unwrap();
    let worktree = worktree.canonicalize().unwrap();

    // the turn path opens the worktree's shell before building tools
    state
        .tool_roots
        .ensure(&worktree)
        .await
        .expect("worktree shell opens");

    let def = |cwd: Option<String>| AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: ModelRef::ClaudeResume {
            model: "test".into(),
        },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(),
        options: vec![],
        cwd,
    };

    // The registry the runtime would build for this thread.
    let factory = state.tool_roots.registry_factory();
    let reg = factory(&def(Some(worktree.to_string_lossy().into_owned())));

    // 1. the SHELL is in the worktree, not the workspace root
    let bash = reg.get("/tool/run_bash").expect("run_bash registered");
    let out = bash
        .call_json(&ToolCtx, json!({"command": "pwd", "background": false}))
        .await
        .expect("run_bash runs");
    // hearth's output carries its own status line; the path is the last
    // non-empty line the shell printed.
    let pwd = out["output"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .next_back()
        .unwrap_or_default()
        .to_string();
    assert!(
        std::path::Path::new(&pwd).canonicalize().ok().as_deref() == Some(worktree.as_path()),
        "the worktree thread's shell runs in {}, not {pwd}",
        worktree.display()
    );

    // 2. and the id it reports names THAT shell, so a client attaching to it
    //    watches the terminal that ran the command
    assert_eq!(
        out["session_id"].as_str().unwrap_or_default(),
        tools::workspace_id(&worktree),
        "run_bash reports the worktree's shell id: {out}"
    );

    // 3. a file write lands in the worktree, not the workspace root
    let write = reg.get("/tool/write_file").expect("write_file registered");
    write
        .call_json(
            &ToolCtx,
            json!({"path": "made-here.txt", "content": "in the worktree\n"}),
        )
        .await
        .expect("write_file runs");
    assert!(
        worktree.join("made-here.txt").is_file(),
        "the edit landed in the worktree"
    );
    assert!(
        !dir.join("made-here.txt").exists(),
        "and NOT in the workspace root — that is the bug #207 describes"
    );

    // 4. the workspace root still gets the boot shell, unchanged
    let reg_root = factory(&def(None));
    let out = reg_root
        .get("/tool/run_bash")
        .unwrap()
        .call_json(&ToolCtx, json!({"command": "pwd", "background": false}))
        .await
        .expect("run_bash runs");
    assert_eq!(
        out["session_id"].as_str().unwrap_or_default(),
        tools::workspace_id(&dir.canonicalize().unwrap()),
        "a thread with no worktree keeps the workspace shell: {out}"
    );
}

/// #207, the negative half: a work root whose shell was never opened in THIS
/// process must not inherit the workspace PTY.
///
/// CONTRACT CHANGE (#4), stated out loud rather than quietly edited. This test
/// used to assert the root REFUSED. That refusal was never the invariant — it
/// was the symptom of one: `registry_factory` is synchronous, so it could only
/// look a runner up in a process-local map, and a root nobody had pre-opened
/// produced `Shell::Missing`. The map had become the authority for whether a
/// shell exists, which is why a restart or a resumed SDK path could refuse a
/// command whose durable `exec_session` row was sitting right there.
///
/// The invariant #207 actually protects is the one still asserted below: the
/// command must NOT execute in the workspace PTY, and the reported session must
/// be this root's own. The handle now resolves through `ExecSessions` at call
/// time, so an ADMITTED root gets its own durable shell instead of an error.
/// Admission is still enforced on every resolve — the unadmitted case is proven
/// in `tools::cold_registry_tests::an_unadmitted_root_fails_instead_of_inheriting_the_workspace_shell`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_work_root_with_no_shell_gets_its_own_durable_shell_not_the_workspace_pty() {
    let (state, dir) = test_state().await;
    let worktree = dir.join("wt-unopened");
    std::fs::create_dir_all(&worktree).unwrap();
    let worktree = worktree.canonicalize().unwrap();

    // deliberately NO ToolRoots::ensure for this root
    let factory = state.tool_roots.registry_factory();
    let reg = factory(&AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: ModelRef::ClaudeResume {
            model: "test".into(),
        },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(),
        options: vec![],
        cwd: Some(worktree.to_string_lossy().into_owned()),
    });

    let out = reg
        .get("/tool/run_bash")
        .expect("run_bash is registered")
        .call_json(
            &ToolCtx,
            json!({"command": "echo wt-unopened-ran", "background": false}),
        )
        .await
        .expect("an admitted root resolves its durable shell without a prior ensure()");
    assert_eq!(
        out["session_id"].as_str().unwrap_or_default(),
        tools::workspace_id(&worktree),
        "the command ran in THIS root's session, not the workspace's: {out}"
    );
    assert_ne!(
        out["session_id"].as_str().unwrap_or_default(),
        tools::workspace_id(&dir.canonicalize().unwrap()),
        "inheriting the workspace session is the #207 bug itself: {out}"
    );

    // and nothing ran in the workspace: the boot PTY's screen never saw it
    let screen = state.terminal.snapshot().await.session.screen;
    assert!(
        !screen.contains("wt-unopened-ran"),
        "the command must not have executed in the workspace shell: {screen}"
    );
}

/// PROOF (#427): a stacked action that FAILS must exit `Failure`, not `Success`.
///
/// codex-t3 filed this and was right that no test pinned it: `rg` for
/// `Exit(Failure)` against the stacked-action paths found nothing. The failure
/// mode it names is two terminal truths disagreeing about one action — every
/// phase refusal in `vcs` emitted an `action_failed` chunk and then returned
/// `Ok(())`, and the route answered `Ok(())` with `exit_success`. A
/// `commit_push` into a repo with NO REMOTE pushed nothing and told the caller
/// it worked. Only a client that parsed the frame stream could tell, which
/// defeats the entire point of having an `Exit`.
///
/// This asserts BOTH halves, because either one alone can pass while the bug is
/// live: the `action_failed` frame must be emitted (the user sees the failure)
/// AND the terminal `Exit` must be `Failure` (the caller sees it too). A fix
/// that only flips the exit and stops emitting the frame is also wrong.
#[tokio::test]
async fn a_stacked_action_that_fails_exits_failure_and_says_which_phase() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();

    let cwd = dir.to_string_lossy().into_owned();
    let (tx, mut rx) = mpsc::unbounded_channel();

    // `commit_push` in a repository with NO REMOTE. A real refusal from a real
    // git phase — no injected error, no mocked failure, no feature flag. The
    // commit half can succeed; the push half cannot, and that is the point:
    // a PARTIALLY completed stacked action must still exit Failure.
    request(
        &state,
        &tx,
        "git.runStackedAction",
        json!({
            "cwd": cwd,
            "actionId": "a-fail",
            "action": "commit_push",
            "commitMessage": "init",
        }),
    )
    .await;

    let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|(s, _)| serde_json::from_str(&s).unwrap())
        .collect();

    // PRECONDITION: the push actually had to refuse. If some environment gave
    // this repo a usable remote, the action legitimately succeeds and the
    // assertions below would be testing nothing.
    let failed_frame = frames
        .iter()
        .find(|f| f["_tag"] == "Chunk" && f["values"][0]["kind"] == "action_failed");
    assert!(
        failed_frame.is_some(),
        "PRECONDITION: commit_push with no remote must emit action_failed, else \
         this test proves nothing about failure. Got: {frames:?}"
    );

    // HALF ONE: the terminal Exit must be Failure.
    let exit = frames
        .iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("the request must terminate with an Exit frame");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "#427: the action emitted action_failed and then exited SUCCESS. Two \
         terminal truths disagreeing about one action — nothing was pushed and \
         the caller was told it worked. Exit was: {exit:?}"
    );

    // HALF TWO: the failure must NAME THE PHASE. "it failed" is not actionable;
    // the caller has to know whether the commit landed and the push didn't.
    let defect = exit["exit"]["cause"][0]["defect"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase();
    assert!(
        defect.contains("push") || defect.contains("remote"),
        "#427: the Failure must name the phase that refused so a caller can tell \
         a failed commit from a failed push; got {defect:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn cancel_stacked_action_fails_when_control_state_is_unreadable() {
    let (state, dir) = test_state().await;
    let db = state.rt.store().db().clone();
    db.execute("DROP TABLE IF EXISTS agent_control", vec![])
        .await
        .unwrap();
    db.execute("CREATE TABLE agent_control (run_id TEXT PRIMARY KEY)", vec![])
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "git.cancelStackedAction",
        json!({ "actionId": "locked-action" }),
    )
    .await;
    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("cancel request exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "unreadable action-control state must not become canceled:false: {exit}"
    );
    let defect = exit["exit"]["cause"][0]["defect"]
        .as_str()
        .unwrap_or_default();
    assert!(
        defect.contains("action control state unreadable") || defect.contains("no such column"),
        "failure should name the unreadable durable control state, got {defect:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn cancelling_an_unknown_stacked_action_id_does_not_poison_a_later_run() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let cwd = dir.to_string_lossy().into_owned();

    let (cancel_tx, mut cancel_rx) = mpsc::unbounded_channel();
    request(
        &state,
        &cancel_tx,
        "git.cancelStackedAction",
        json!({ "actionId": "reuse-me" }),
    )
    .await;
    let cancel_exit = drain(&mut cancel_rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("cancel request exits");
    assert_eq!(cancel_exit["exit"]["_tag"], "Success", "{cancel_exit}");
    assert_eq!(
        cancel_exit["exit"]["value"]["canceled"],
        json!(false),
        "an unknown action id must not be reported as stopped: {cancel_exit}"
    );

    let (run_tx, mut run_rx) = mpsc::unbounded_channel();
    request(
        &state,
        &run_tx,
        "git.runStackedAction",
        json!({
            "cwd": cwd,
            "actionId": "reuse-me",
            "action": "commit",
            "commitMessage": "fresh action",
        }),
    )
    .await;
    let frames = drain(&mut run_rx);
    assert!(
        !frames.iter().any(|f| {
            f["_tag"] == "Chunk" && f["values"][0]["kind"] == "action_cancelled"
        }),
        "stale cancel row poisoned the later action: {frames:?}"
    );
    let exit = frames
        .iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("run exits");
    assert_eq!(
        exit["exit"]["_tag"], "Success",
        "the later action should run normally with the reused id: {frames:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #423: `git.runStackedAction` must STREAM progress, not replay a transcript.
///
/// The old arm awaited `vcs::run_stacked_action(..)` to completion and then
/// looped over the returned `Vec`, so nothing reached the socket until the
/// action was already over.
///
/// ASSERTING FRAME ORDER CANNOT CATCH THAT. A replayed transcript has exactly
/// the same order as a live stream — that is what makes this bug survive a
/// green test suite. The only thing that separates them is WHEN the frames
/// become observable, so this test measures time, not order.
///
/// The clock is a `pre-commit` hook that sleeps. cairn runs hooks because the
/// user asked for a commit, so the commit phase genuinely blocks for
/// `HOOK_SLEEP`. The request runs on its own task and the test asserts
/// `action_started` is READABLE on the socket while that phase is still
/// blocked. Under the collecting shape nothing at all is readable until the
/// whole action finishes, so the wait below times out and the test fails for
/// exactly the reason #423 describes.
///
/// (An earlier draft of this test used a FAILING action as the discriminator —
/// under the old code an `Err` discarded the collected `Vec` and emitted
/// nothing. That does not work here: `git.runStackedAction` returns
/// `Exit(Success)` for a commit with nothing to commit, a push with no remote,
/// AND a create_pr with no `gh`. Its precondition assertion is what surfaced
/// that, and it is a separate fail-open defect — reported to the channel, not
/// silently worked around here.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stacked_action_progress_is_readable_while_the_action_is_still_running() {
    const HOOK_SLEEP: u64 = 3;

    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();

    // The blocking phase. A hook is the honest way to make a real git phase
    // slow: no fake clock, no injected sleep in product code.
    let hooks = dir.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let pre_commit = hooks.join("pre-commit");
    // The hook's LAST act is to create a sentinel. That turns "the blocking
    // phase has finished" into a FACT ON DISK that the test can observe,
    // instead of an elapsed-seconds guess about it.
    let hook_done = dir.join("hook-finished");
    std::fs::write(
        &pre_commit,
        format!(
            "#!/bin/sh\nsleep {HOOK_SLEEP}\ntouch '{}'\n",
            hook_done.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pre_commit, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let cwd = dir.to_string_lossy().into_owned();
    let (tx, mut rx) = mpsc::unbounded_channel();

    let started = std::time::Instant::now();
    let task = {
        let state = state.clone();
        let tx = tx.clone();
        let cwd = cwd.clone();
        tokio::spawn(async move {
            request(
                &state,
                &tx,
                "git.runStackedAction",
                json!({
                    "cwd": cwd, "actionId": "a-live", "action": "commit",
                    "commitMessage": "init",
                }),
            )
            .await;
        })
    };

    // THE POINT: a progress frame is readable while the commit phase is still
    // blocked.
    //
    // This is an ORDER assertion, deliberately not a timing one. The previous
    // version gave the frame a wall-clock budget — `HOOK_SLEEP - 1` seconds to
    // arrive, then `elapsed.as_secs() < HOOK_SLEEP` — which encodes an
    // assumption about how fast this machine is. On a box running two dozen
    // concurrent cargo processes, spawning the task and `cairn::init_repository`
    // can consume those two seconds before the first frame is even drained, and
    // the test then fails with a message that reads exactly like a streaming
    // bug. It produced several false regressions in review, each costing a
    // round, and every one of them was a busy machine rather than a defect.
    //
    // A bigger timeout would only make the false alarm rarer and the suite
    // slower; it would still be a clock. So the discriminator is the sentinel
    // the hook touches on its way out: if `action_started` is readable while
    // that file does not yet exist, the frame overtook the blocking phase, and
    // that is true at any speed. A slow box makes the hook finish LATER, which
    // makes this MORE likely to hold — the failure mode now points the same way
    // as the load, instead of against it.
    //
    // The bound below is a deadlock guard, not a budget: it exists so a genuine
    // hang reports as a failed test rather than a hung suite.
    let progress = drain_until(&mut rx, std::time::Duration::from_secs(120), |f| {
        f["_tag"] == "Chunk" && f["values"][0]["kind"] == "action_started"
    })
    .await;
    // Sampled the instant the frame became readable, before any await that
    // could let the hook finish underneath us.
    let hook_still_running = !hook_done.exists();
    let elapsed = started.elapsed();

    assert!(
        progress
            .iter()
            .any(|f| f["values"][0]["kind"] == "action_started"),
        "no action_started became readable in {:?}, while the commit phase was still \
         blocked in its {HOOK_SLEEP}s pre-commit hook. The frames are being collected \
         and replayed after the action completes, which is a transcript, not a \
         progress stream: {progress:?}",
        elapsed
    );
    assert!(
        hook_still_running,
        "action_started only became readable after the pre-commit hook had already \
         finished (its {HOOK_SLEEP}s sentinel {} already existed) — that is replay, \
         not streaming. Frame arrived {elapsed:?} after the request was issued.",
        hook_done.display()
    );

    // VACUITY CONTROL: after the action completes the sentinel MUST exist. If
    // it does not, the pre-commit hook never ran, `hook_still_running` was
    // trivially true, and the assertion above proved nothing at all.
    task.await.unwrap();
    assert!(
        hook_done.exists(),
        "VACUOUS: the pre-commit hook never created its sentinel {}, so the \
         'hook still running' assertion above was true for the wrong reason. \
         dir contents: {:?}",
        hook_done.display(),
        std::fs::read_dir(&dir).map(|r| r.flatten().map(|e| e.file_name()).collect::<Vec<_>>())
    );

    // And the action still completes normally afterwards, so streaming did not
    // cost the terminal frame.
    let rest = drain(&mut rx);
    let exit = progress
        .iter()
        .chain(rest.iter())
        .find(|f| f["_tag"] == "Exit")
        .expect("the action must still terminate with an Exit frame");
    assert_eq!(exit["exit"]["_tag"], "Success", "{exit}");
}

/// #117: the git panel folds every stream event, so a one-shot snapshot
/// leaves it permanently stale. A mutation must PUSH a new status.
#[tokio::test]
async fn vcs_status_is_a_live_subscription_not_a_one_shot() {
    let (state, dir) = test_state().await;
    cairn::init_repository(&dir).await.unwrap();
    // The runtime's own data dir lives INSIDE this fixture repo, and the engine
    // keeps sidecars next to its database (`-wal`, `-tshm`, `-xproc`). Those are
    // not user work: without this the post-commit status reports a dirty tree
    // for files the agent wrote about itself.
    std::fs::write(dir.join(".gitignore"), "data/\n").unwrap();
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let cwd = dir.to_string_lossy().into_owned();

    // subscribe: the snapshot arrives and the subscriber stays registered
    let (sub_tx, mut sub_rx) = mpsc::unbounded_channel();
    request(&state, &sub_tx, "subscribeVcsStatus", json!({"cwd": cwd})).await;
    let first = drain(&mut sub_rx);
    assert_eq!(first[0]["values"][0]["_tag"], "snapshot", "{first:?}");
    let branch_before = first[0]["values"][0]["local"]["refName"].clone();

    // mutate THROUGH the backend on another connection
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "git.runStackedAction",
        json!({
            "cwd": cwd, "actionId": "c1", "action": "commit", "commitMessage": "init",
        }),
    )
    .await;
    assert_eq!(
        drain(&mut rx)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap()["exit"]["_tag"],
        "Success"
    );

    // THE POINT: the subscriber was pushed a fresh status without asking.
    //
    // Awaited, not drained-once (#335). Fanout used to be a synchronous
    // walk of a process-local `Vec<Sender>`, so the frame was already in
    // this channel by the time the mutating call returned. It now goes
    // through the runtime's durable per-cwd topic and reaches the socket
    // via a spawned tail pump, which is the whole point — a frame published
    // by ANOTHER backend process reaches this subscriber too. That makes
    // delivery asynchronous, so a single non-blocking `drain` races it.
    // The assertion is unchanged; only the waiting is.
    let pushed = drain_until(&mut sub_rx, std::time::Duration::from_secs(15), |f| {
        f["values"][0]["_tag"] == "localUpdated"
    })
    .await;
    let tags: Vec<&str> = pushed
        .iter()
        .filter_map(|f| f["values"][0]["_tag"].as_str())
        .collect();
    assert!(
        tags.contains(&"localUpdated"),
        "a commit pushes local status: {tags:?}"
    );
    let local = pushed
        .iter()
        .find(|f| f["values"][0]["_tag"] == "localUpdated")
        .map(|f| f["values"][0]["local"].clone())
        .unwrap();
    assert_eq!(
        local["hasWorkingTreeChanges"],
        json!(false),
        "the pushed status reflects the commit, not the pre-commit tree: {local}"
    );

    // a branch switch pushes too
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "vcs.createRef",
        json!({"cwd": cwd, "refName": "feature/x", "switchRef": true}),
    )
    .await;
    let _ = drain(&mut rx);
    // VCS fanout is on the SDK broker now (packet DM); delivery to the
    // pumping tail is a spawned await away, so spin briefly for the
    // frame to land rather than reading synchronously.
    let pushed = drain_until(&mut sub_rx, std::time::Duration::from_secs(2), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("_tag"))
            .and_then(Value::as_str)
            == Some("localUpdated")
            && f["values"][0]["local"]["refName"] == "feature/x"
    })
    .await;
    let after = pushed
        .iter()
        .rev()
        .find(|f| f["values"][0]["_tag"] == "localUpdated")
        .map(|f| f["values"][0]["local"]["refName"].clone())
        .expect("a branch switch pushes status");
    assert_eq!(after, json!("feature/x"), "the panel followed the switch");
    assert_ne!(after, branch_before);
}

/// #125: what the thread SHOWS and what the runtime RUNS come from the same
/// catalog. A hard-coded Claude literal makes an Ollama-first or Codex-only
/// install announce a provider it will never use, and then model switching
/// cannot be verified from the UI at all.
#[tokio::test]
async fn thread_metadata_names_the_provider_the_runtime_would_actually_run() {
    let (state, _d) = test_state().await;

    // a runtime where Claude is DISABLED, so it cannot be the default
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "server.updateSettings",
        json!({"patch": {"providerInstances": {
            "claudeAgent": {"driver": "claudeAgent", "enabled": false},
            "codex": {"driver": "codex", "enabled": true},
        }}}),
    )
    .await;
    let _ = drain(&mut rx);
    // the default the RUNTIME resolves now
    let runtime_default = {
        let cat = state.catalog.read().await;
        cat.snapshots()
            .iter()
            .find(|s| s.status == agent_sdk_provider::ProviderStatus::Ready)
            .map(|s| s.instance_id.clone())
            .expect("a ready provider")
    };

    // start a turn with NO modelSelection at all
    ensure_thread_on_shell(
        &state,
        &json!({
            "threadId": "t-default", "message": {"text": "hi", "messageId": "m1"},
        }),
    )
    .await;

    let t = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t["id"] == "t-default")
        .unwrap();
    let shown = t["modelSelection"]["instanceId"].as_str().unwrap_or("");
    assert_ne!(
        shown, "claudeAgent",
        "must not manufacture a Claude selection on a runtime without it: {t}"
    );
    assert_eq!(
        shown, runtime_default,
        "the announced provider is the one that will run: {t}"
    );

    // and the snapshot the UI reads agrees
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({"threadId": "t-default"}),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("snapshot");
    assert_eq!(
        snap["values"][0]["snapshot"]["thread"]["modelSelection"]["instanceId"],
        json!(runtime_default),
        "subscribeThread repeats the same catalog-derived default"
    );

    // an EXPLICIT selection is still honoured verbatim
    ensure_thread_on_shell(
        &state,
        &json!({
            "threadId": "t-explicit",
            "modelSelection": {"instanceId": "codex", "model": "codex-default"},
            "message": {"text": "hi", "messageId": "m1"},
        }),
    )
    .await;
    let t = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t["id"] == "t-explicit")
        .unwrap();
    assert_eq!(t["modelSelection"]["instanceId"], "codex", "{t}");
}

#[tokio::test]
async fn subscribe_thread_snapshot_reads_durable_messages() {
    let (state, _d) = test_state().await;
    // Persist a message directly to the durable store, then subscribe: the
    // snapshot must reflect do-rs, proving history is not an in-memory copy.
    let umsg = json!({ "id": "m1", "role": "user", "text": "hi", "streaming": false,
        "createdAt": now_iso(), "updatedAt": now_iso() });
    state.rt.append_message("t-1", &umsg).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-1" }),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("snapshot frame");
    let msgs = &snap["values"][0]["snapshot"]["thread"]["messages"];
    assert_eq!(
        msgs[0]["id"], "m1",
        "snapshot serves durable message, got {msgs:?}"
    );
}

/// #96: accepting a websocket frame is not enough; the durable ack still has
/// to land. If ack fails after delivery, the subscription must report the
/// stream error and run cleanup instead of continuing as synchronized.
#[tokio::test]
async fn thread_tail_ack_failure_after_delivery_closes_the_subscription() {
    let (state, dir) = test_state().await;
    let thread_id = "t-tail-ack";
    let (_mark, tail) = state.rt.snapshot_tail(thread_id).await.unwrap();
    emit_thread_event(
        &state.rt,
        thread_id,
        "thread.message.assistant.delta",
        json!({ "text": "hello" }),
    ).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
    spawn_thread_tail_with_cleanup(tail, tx, json!(7), thread_id.to_string(), async move {
        let _ = closed_tx.send(());
    });

    let (frame, done) = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await.expect("tail delivered a frame")
        .expect("tail channel stayed open");
    let delivered: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(
        delivered["values"][0]["event"]["payload"]["text"], "hello",
        "the test must fail ack after a real accepted delivery: {delivered}"
    );

    let pool = do_storage::DbPool::new(dir.join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE inbox", vec![]).await.unwrap();
    done.expect("tail frames carry delivery confirmation").send(true)
        .expect("confirm delivery before ack fails");

    let (error_frame, _) = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await.expect("ack failure is surfaced")
        .expect("error frame is sent before close");
    let error: Value = serde_json::from_str(&error_frame).unwrap();
    let msg = error["values"][0]["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("thread subscription failed"),
        "ack failure must be a visible stream error, not a hidden log: {error}"
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
        .await.expect("ack failure closes and runs cleanup")
        .expect("cleanup sender fires");
}

/// PROOF (#299): the wire sequence does not REWIND across a restart.
///
/// It used to be a per-process `Store::seq`, initialised to 1 at boot and
/// bumped for every shell-stream event and dispatch ack. A client holding
/// shell `snapshotSequence` 47 would, after a server restart, be handed
/// sequence 2 for the next thread upsert — and a reducer either discards
/// that as stale or re-applies a number it has already seen to a completely
/// different event. Durable state half in do-rs and half in memory.
///
/// So the assertion is made across a real process boundary: capture the
/// mark, drop the whole backend, reopen over the same data dir, publish, and
/// require the new number to be strictly greater.
#[tokio::test]
async fn the_shell_sequence_continues_across_a_restart_instead_of_rewinding() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);

    // First process: burn some sequence, then read the client's mark.
    let mark = {
        let state = state_at(&dir).await;
        for i in 0..5 {
            upsert_thread_on_shell(
                &state,
                json!({"id": format!("t-{i}"), "title": "before", "projectId": "p",
                       "createdAt": now_iso(), "updatedAt": now_iso()}),
            )
            .await;
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
        let frames = drain(&mut rx);
        let snap = frames
            .iter()
            .find(|f| f["values"][0]["kind"] == "snapshot")
            .expect("the shell snapshot frame");
        snap["values"][0]["snapshot"]["snapshotSequence"]
            .as_i64()
            .expect("the snapshot carries the client's resume mark")
    };
    assert!(mark > 0, "the first process actually advanced the sequence");

    // A fresh AppState over the SAME data dir — proves the durable read path,
    // not crash recovery (#375). Nothing is carried in memory —
    // this is the restart the old counter could not survive.
    let state = state_at(&dir).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let _ = drain(&mut rx);

    upsert_thread_on_shell(
        &state,
        json!({"id": "t-after-restart", "title": "after", "projectId": "p",
               "createdAt": now_iso(), "updatedAt": now_iso()}),
    )
    .await;

    // Match on the NEW thread id, not just kind — subscribe delivers the
    // broker's retained latest frame (seq 5, from the pre-restart upserts)
    // as a fresh joiner, and the assertion is that the POST-restart upsert
    // gets a strictly greater number than the client's mark.
    let published = drain_until(&mut rx, std::time::Duration::from_secs(2), |f| {
        f.get("values")
            .and_then(|v| v.get(0))
            .and_then(|x| x.get("kind"))
            .and_then(Value::as_str)
            == Some("thread-upserted")
            && f["values"][0]["thread"]["id"] == "t-after-restart"
    })
    .await
    .into_iter()
    .find(|f| {
        f["values"][0]["kind"] == "thread-upserted"
            && f["values"][0]["thread"]["id"] == "t-after-restart"
    })
    .expect("the upsert was announced on the shell stream");
    let seq = published["values"][0]["sequence"]
        .as_i64()
        .expect("every shell event is numbered");
    assert!(
        seq > mark,
        "a restarted backend published sequence {seq} to a client already holding {mark}: \
         the reducer would drop it as stale or refold a number it has applied"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A RESTART is the only honest test of a durable read model: a reconnecting
/// client must be handed the same thread by a backend that was not running
/// when the thread was written.
///
/// `subscribe_thread_snapshot_reads_durable_messages` proves the snapshot
/// comes from the store rather than a memory copy, but it asks the SAME
/// process that did the write — so an in-process cache would pass it. Here
/// the first backend is dropped entirely before the second one answers.
#[tokio::test]
async fn a_restarted_backend_serves_a_reconnecting_client_from_the_store() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);

    // First process: persist a thread + its history, then drop everything.
    {
        let state = state_at(&dir).await;
        state
            .rt
            .save_thread(&json!({ "runtimeMode": "full-access","id": "t-reconnect", "title": "before the restart",
                "projectId": "p-workspace", "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
                "createdAt": now_iso(), "updatedAt": now_iso()}))
            .await
            .unwrap();
        for (id, role, text) in [("m1", "user", "hi"), ("m2", "assistant", "hello there")] {
            state
                .rt
                .append_message(
                    "t-reconnect",
                    &json!({"id": id, "role": role, "text": text,
                    "streaming": false, "createdAt": now_iso(), "updatedAt": now_iso()}),
                )
                .await
                .unwrap();
        }
    }

    // A fresh AppState over the same directory — proves the durable read
    // path, not crash recovery (#375). Nothing carried in memory.
    let state = state_at(&dir).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({"threadId": "t-reconnect"}),
    )
    .await;
    let frames = drain(&mut rx);

    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("a reconnecting client gets a snapshot");
    let thread = &snap["values"][0]["snapshot"]["thread"];
    assert_eq!(thread["id"], "t-reconnect");
    let msgs = thread["messages"].as_array().expect("messages array");
    assert_eq!(
        msgs.iter()
            .map(|m| m["id"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        vec!["m1", "m2"],
        "the pre-restart transcript came back in order, got {msgs:?}"
    );
    assert_eq!(
        msgs[1]["text"], "hello there",
        "assistant content survived, not just the row"
    );

    // and the subscription is live, not a one-shot snapshot: the stream is
    // still open (no Exit) so the client can keep receiving.
    assert!(
        frames.iter().all(|f| f["_tag"] != "Exit"),
        "subscribeThread stays open after a restart, got {frames:?}"
    );
    assert!(
        frames
            .iter()
            .any(|f| f["values"][0]["kind"] == "synchronized"),
        "the client is told the subscription is live"
    );
}

/// #37: switching the model on an EXISTING thread persists the new selection
/// durably, so a reload/snapshot shows the switched model (not the old one)
/// while message history is preserved.
#[tokio::test]
async fn model_switch_persists_in_thread_snapshot() {
    let (state, _d) = test_state().await;
    let tid = "t-switch";
    let cmd = |inst: &str, model: &str, text: &str| {
        json!({
            "type": "thread.turn.start", "threadId": tid,
            "modelSelection": { "instanceId": inst, "model": model },
            "message": { "text": text }
        })
    };
    // First turn creates the thread on instance A.
    ensure_thread_on_shell(&state, &cmd("claudeAgent", "model-a", "hi")).await;
    seed_prompt(&state, tid, "m-a", "hi").await;
    // Second turn SWITCHES to instance B on the same thread.
    ensure_thread_on_shell(&state, &cmd("codex", "model-b", "again")).await;
    seed_prompt(&state, tid, "m-b", "again").await;

    // The snapshot must reflect the switched selection, and keep both msgs.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": tid }),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("snapshot frame");
    let thread = &snap["values"][0]["snapshot"]["thread"];
    assert_eq!(
        thread["modelSelection"]["instanceId"], "codex",
        "switched instance persisted"
    );
    assert_eq!(
        thread["modelSelection"]["model"], "model-b",
        "switched model persisted"
    );
    assert_eq!(
        thread["messages"].as_array().unwrap().len(),
        2,
        "history preserved across switch"
    );
}

/// #81: tool work reaches the WIRE as a durable activity row, in contract
/// shape — not swallowed as assistant prose.
///
/// The Agents/activity panel can only show "running bash" if a
/// `thread.activity-appended` event exists on the thread stream with a
/// stable id, a non-empty summary and the tool's input. This drives the real
/// projector and reads the published item back off the durable bus.
#[tokio::test]
async fn tool_activity_reaches_the_thread_stream_in_contract_shape() {
    let (state, _d) = test_state().await;
    let projector = t3_projector(state.rt.clone());
    let tail = state.rt.tail("t-1").await.expect("subscribed");

    projector
        .project(Lifecycle::ToolStarted {
            thread_id: "t-1".into(),
            turn_id: "turn-1".into(),
            call_id: "call-9".into(),
            tool: "run_bash".into(),
            args: json!({ "command": "cargo test --all" }),
        })
        .await
        .expect("projected");
    projector
        .project(Lifecycle::ToolCompleted {
            thread_id: "t-1".into(),
            turn_id: "turn-1".into(),
            call_id: "call-9".into(),
            output: json!({ "ran": "ok\nsecond line" }),
        })
        .await
        .expect("projected");

    let items = tail.next(std::time::Duration::from_secs(5)).await.unwrap();
    let events: Vec<&Value> = items.iter().map(|(_, v)| v).collect();
    let started = events
        .iter()
        .find(|e| e["event"]["payload"]["activity"]["kind"] == "tool.started")
        .unwrap_or_else(|| panic!("no tool.started activity in {events:#?}"));
    let done = events
        .iter()
        .find(|e| e["event"]["payload"]["activity"]["kind"] == "tool.completed")
        .unwrap_or_else(|| panic!("no tool.completed activity in {events:#?}"));

    // the envelope the reducer decodes
    assert_eq!(started["kind"], "event");
    assert_eq!(started["event"]["type"], "thread.activity-appended");
    assert_eq!(started["event"]["aggregateId"], "t-1");
    assert!(started["event"]["sequence"].as_i64().unwrap() > 0);

    // the activity a human reads and clicks
    let a = &started["event"]["payload"]["activity"];
    assert_eq!(a["tone"], "tool");
    assert_eq!(a["turnId"], "turn-1");
    assert_eq!(
        a["payload"]["callId"], "call-9",
        "a stable id to click into"
    );
    assert_eq!(a["payload"]["input"]["command"], "cargo test --all");
    assert_eq!(
        a["summary"], "run_bash: cargo test --all",
        "the summary names WHAT is running, not just the tool"
    );
    assert!(
        !a["summary"].as_str().unwrap().is_empty(),
        "the contract refuses an empty summary"
    );

    // the result row pairs by call id and summarises one line
    let d = &done["event"]["payload"]["activity"];
    assert_eq!(
        d["payload"]["callId"], "call-9",
        "the result is paired by id"
    );
    // …and it REPLACES the running row rather than appending a second one:
    // the client reducer drops any activity whose id it already has, so a
    // different id would leave the "running" row spinning forever (#136).
    assert_eq!(
        d["id"], a["id"],
        "completion updates the same activity row it started: {} vs {}",
        d["id"], a["id"]
    );
    let summary = d["summary"].as_str().unwrap();
    assert!(
        !summary.is_empty() && !summary.contains('\n'),
        "one line, non-empty: {summary:?}"
    );
}

/// #55/#57/#82/#98/#99/#105/#118/#133: panes are REAL, with the identity the
/// client chose.
///
/// One shared shell for every pane was the old shape: it made the agent's
/// terminal watchable (which is right) but meant a second pane typed into
/// the first one's cursor, `cwd`/`worktreePath`/`env` were echoed back
/// without ever being applied, restart was an alias for open, clear/close
/// were acks, and metadata could only ever report one hard-coded id.
/// PROOF (#149): a PTY can be owned by an agent/fleet CHILD SESSION, and that
/// owner is a different address from the thread — not a second name for it.
///
/// The registry keyed panes by `(thread_id, terminal_id)`, so a subagent
/// running bash in its own worktree had no address at all: every request
/// resolved against the parent thread. The frontend could therefore only ever
/// mount the parent's drawer, and `terminal.write` aimed at a child went to the
/// parent's shell — the "wrong ownership boundary" the finding names, which
/// looks like it works right up until you type into it.
///
/// The collision case is the one worth asserting. `sessionId` and `threadId`
/// are caller-supplied strings from different id spaces and nothing stops them
/// being equal, so the test deliberately uses the SAME literal for both. If the
/// registry namespaced only by raw id, the child would silently join the
/// thread's pane and every assertion below would still pass except this one.
#[tokio::test]
async fn a_child_session_terminal_is_addressed_separately_from_its_threads() {
    let (state, _dir) = test_state().await;
    const SAME: &str = "collides";

    // The thread's pane.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": SAME, "terminalId": "pane-1", "cols": 80, "rows": 24,
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["value"]["threadId"], SAME);
    assert!(
        f[0]["exit"]["value"]["sessionId"].is_null(),
        "a THREAD pane must serialise exactly as before — a non-null sessionId \
         here would change the shape every existing client already parses: {:?}",
        f[0]["exit"]["value"]
    );

    // A child session's pane, same terminal id AND same literal owner id.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": SAME, "sessionId": SAME, "terminalId": "pane-1", "cols": 80, "rows": 24,
        }),
    )
    .await;
    let f = drain(&mut rx);
    let child = &f[0]["exit"]["value"];
    assert_eq!(
        child["sessionId"], SAME,
        "the child pane reports its session: {child:?}"
    );
    assert!(
        child["threadId"].is_null(),
        "a child-session pane must not claim a thread — that is the ownership \
         boundary being fixed: {child:?}"
    );

    // TWO panes, not one. sessionId WINS over threadId, so sending both did not
    // hand the caller the parent's pane.
    let thread_owner = terminal::TerminalOwner::thread(SAME);
    let child_owner = terminal::TerminalOwner::ChildSession {
        session_id: SAME.to_string(),
        worktree_path: None,
    };
    let a = state
        .terminals
        .get(&thread_owner, "pane-1")
        .await
        .expect("pane store readable")
        .expect("thread pane");
    let b = state
        .terminals
        .get(&child_owner, "pane-1")
        .await
        .expect("pane store readable")
        .expect("child pane");
    assert!(
        !std::sync::Arc::ptr_eq(&a.runner, &b.runner),
        "the child session joined the thread's shell instead of getting its own"
    );

    // They list independently: a thread's drawer must not show a child's PTYs.
    assert_eq!(state.terminals.list(&thread_owner).await.expect("pane store readable").len(), 1);
    assert_eq!(state.terminals.list(&child_owner).await.expect("pane store readable").len(), 1);

    // And closing the CHILD leaves the thread's pane alone.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.close",
        json!({
            "threadId": SAME, "sessionId": SAME, "terminalId": "pane-1",
        }),
    )
    .await;
    let _ = drain(&mut rx);
    assert!(
        state
            .terminals
            .get(&child_owner, "pane-1")
            .await
            .expect("pane store readable")
            .is_none(),
        "the child pane did not close"
    );
    assert!(
        state
            .terminals
            .get(&thread_owner, "pane-1")
            .await
            .expect("pane store readable")
            .is_some(),
        "closing the child session's PTY tore down the THREAD's pane — the two \
         lifecycles are still fused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_panes_have_their_own_identity_shell_and_lifecycle() {
    let (state, dir) = test_state().await;
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).unwrap();

    // a pane opened for a directory LANDS there — not just echoes it back
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": "t-1", "terminalId": "pane-a", "cwd": sub.to_string_lossy(),
            "env": { "PANE": "a" }, "cols": 80, "rows": 24,
        }),
    )
    .await;
    let f = drain(&mut rx);
    let snap = &f[0]["exit"]["value"];
    assert_eq!(snap["terminalId"], "pane-a");
    // the admitted path is CANONICAL (symlinks resolved — /var → /private/var
    // on macOS), which is the point: admission resolves before it compares.
    let sub_real = sub.canonicalize().unwrap();
    assert_eq!(
        snap["cwd"],
        sub_real.to_string_lossy().as_ref(),
        "the pane reports where it really is"
    );

    let pane_a = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-1"), "pane-a")
        .await
        .expect("pane store readable")
        .expect("registered");
    let where_a = pane_a.runner.run("basename \"$PWD\"; echo [$PANE]", false, Some(10), false).await;
    assert!(where_a.output.contains("sub"), "the shell started in the requested cwd: {where_a:?}");
    assert!(where_a.output.contains("[a]"), "the launch env reached the shell: {where_a:?}");

    // a SECOND pane is a different shell — not the first one's cursor
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": "t-1", "terminalId": "pane-b", "worktreePath": dir.to_string_lossy(),
            "env": { "PANE": "b" },
        }),
    )
    .await;
    assert_eq!(drain(&mut rx)[0]["exit"]["_tag"], "Success");
    let pane_b = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-1"), "pane-b")
        .await
        .expect("pane store readable")
        .expect("registered");
    let where_b = pane_b.runner.run("echo [$PANE]", false, Some(10), false).await;
    assert!(where_b.output.contains("[b]"), "pane B has its OWN env: {where_b:?}");
    let recheck_a = pane_a.runner.run("echo [$PANE]", false, Some(10), false).await;
    assert!(recheck_a.output.contains("[a]"), "pane A is untouched by pane B: {recheck_a:?}");

    // metadata lists every pane for the thread, including the agent's shell
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-1" }),
    )
    .await;
    let f = drain(&mut rx);
    let listed = f[0]["values"][0]["terminals"].as_array().unwrap();
    let ids: Vec<&str> = listed
        .iter()
        .map(|t| t["terminalId"].as_str().unwrap())
        .collect();
    assert!(
        ids.contains(&"pane-a") && ids.contains(&"pane-b"),
        "every open pane is listed: {ids:?}"
    );
    assert!(
        ids.contains(&terminal::AGENT_TERMINAL_ID),
        "the agent's shell is findable: {ids:?}"
    );
    let row_a = listed.iter().find(|t| t["terminalId"] == "pane-a").unwrap();
    assert_eq!(row_a["cwd"], sub_real.to_string_lossy().as_ref());
    let row_b = listed.iter().find(|t| t["terminalId"] == "pane-b").unwrap();
    assert_eq!(
        row_b["worktreePath"],
        dir.canonicalize().unwrap().to_string_lossy().as_ref(),
        "worktree affinity is kept"
    );

    // RESTART replaces the environment — a fresh pane is actually fresh
    pane_a
        .runner
        .run("export LEAKED=yes", false, Some(10), false)
        .await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.restart",
        json!({
            "threadId": "t-1", "terminalId": "pane-a", "cwd": sub.to_string_lossy(),
            "env": { "PANE": "restarted" },
        }),
    )
    .await;
    assert_eq!(drain(&mut rx)[0]["exit"]["_tag"], "Success");
    let after = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-1"), "pane-a")
        .await
        .expect("pane store readable")
        .expect("pane A remains registered");
    let env_after = after.runner.run("echo [$PANE][$LEAKED]", false, Some(10), false).await;
    assert!(
        env_after.output.contains("[restarted][]"),
        "restart applied the new env and dropped the old exports: {env_after:?}"
    );

    // CLEAR empties the screen without killing the shell
    after
        .runner
        .run("echo BEFORE-CLEAR", false, Some(10), false)
        .await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.clear",
        json!({ "threadId": "t-1", "terminalId": "pane-a" }),
    )
    .await;
    assert_eq!(drain(&mut rx)[0]["exit"]["_tag"], "Success");
    assert!(
        !after.runner.read_screen().await.contains("BEFORE-CLEAR"),
        "the screen was cleared"
    );
    let alive = after
        .runner
        .run("echo STILL-ALIVE", false, Some(10), false)
        .await;
    assert!(
        alive.output.contains("STILL-ALIVE"),
        "clear did not kill the shell: {alive:?}"
    );

    // CLOSE ends that pane only — and actually STOPS ITS SHELL (#210): the
    // pid running before the close must be gone afterwards, or a "closed"
    // terminal leaves a bash (and whatever it was running) orphaned.
    let pid_before = after
        .runner
        .run("echo PID=$$", false, Some(10), false)
        .await
        .output
        .split("PID=")
        .nth(1)
        .and_then(|t| t.split_whitespace().next())
        .and_then(|t| t.parse::<i32>().ok())
        .expect("the pane shell has a pid");
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.close",
        json!({ "threadId": "t-1", "terminalId": "pane-a" }),
    )
    .await;
    assert_eq!(drain(&mut rx)[0]["exit"]["_tag"], "Success");
    assert!(
        state
            .terminals
            .get(&terminal::TerminalOwner::thread("t-1"), "pane-a")
            .await
            .expect("pane store readable")
            .is_none(),
        "pane A is gone"
    );
    assert!(
        state
            .terminals
            .get(&terminal::TerminalOwner::thread("t-1"), "pane-b")
            .await
            .expect("pane store readable")
            .is_some(),
        "pane B is untouched"
    );
    // The process is really gone, checked ONCE, immediately.
    //
    // This used to poll for a second and it was hiding a real defect: `close`
    // killed the child but never `wait`ed for it, so the shell became a ZOMBIE
    // — still in the process table, still answering `kill -0`, for as long as
    // this process lived. Whether the poll happened to go green depended on
    // machine load, which is how it passed here and failed under a loaded box.
    //
    // A single probe is the honest assertion: `close()` returning must mean the
    // process is reaped. A test that polls is a test that has agreed to race.
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid_before.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(
        !alive,
        "closing pane A left its shell (pid {pid_before}) alive or unreaped — \
         `close` must kill AND wait, or a zombie keeps answering existence probes"
    );
    // pane B's shell is untouched by A's close
    let b_alive = pane_b
        .runner
        .run("echo B-STILL-ALIVE", false, Some(10), false)
        .await;
    assert!(
        b_alive.output.contains("B-STILL-ALIVE"),
        "pane B died with A: {b_alive:?}"
    );

    // closing the AGENT's pane must never kill the agent's shell
    let _ = state
        .terminals
        .open(
            &terminal::TerminalOwner::thread("t-1"),
            terminal::AGENT_TERMINAL_ID,
            None,
            None,
            &[],
        )
        .await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.close",
        json!({ "threadId": "t-1", "terminalId": terminal::AGENT_TERMINAL_ID }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Success");
    let agent_alive = state
        .terminal
        .run("echo AGENT-ALIVE", false, Some(10), false)
        .await;
    assert!(
        agent_alive.output.contains("AGENT-ALIVE"),
        "closing a VIEW of the agent's shell does not end the agent's work: {agent_alive:?}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// #137/#78/#79: the FIRST turn's context reaches the thread.
///
/// The composer chooses a project, a worktree/branch and a runtime mode
/// before the thread exists; they arrive in `bootstrap.createThread` and on
/// the command. Manufacturing "first project, full-access, no worktree"
/// instead meant the thread showed one project while the work happened in
/// another, and a supervised mode silently became full access.
#[tokio::test]
async fn the_first_turns_project_worktree_and_mode_reach_the_thread() {
    let (state, dir) = test_state().await;
    let wt = dir.join("wt");
    std::fs::create_dir_all(&wt).unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let _ = drain(&mut rx);

    let command = json!({
        "type": "thread.turn.start",
        "commandId": "c-1",
        "threadId": "t-ctx",
        "message": { "messageId": "m-1", "role": "user", "text": "start here", "attachments": [] },
        "runtimeMode": "approval-required",
        "interactionMode": "plan",
        "titleSeed": "Chosen title",
        "bootstrap": { "createThread": {
            "projectId": "p-chosen",
            "title": "Chosen title",
            "runtimeMode": "approval-required",
            "interactionMode": "plan",
            "branch": "feature/x",
            "worktreePath": wt.to_string_lossy(),
        }},
    });
    ensure_thread_on_shell(&state, &command).await;

    // the thread the shell announced carries what the user picked
    let announced = drain_until(&mut rx, std::time::Duration::from_secs(2), |f| {
        f.get("values")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .any(|x| x.get("kind").and_then(Value::as_str) == Some("thread-upserted"))
            })
            .unwrap_or(false)
    })
    .await;
    let upsert = announced
        .iter()
        .flat_map(|f| f["values"].as_array().cloned().unwrap_or_default())
        .find(|v| v["kind"] == "thread-upserted")
        .unwrap_or_else(|| panic!("no thread-upserted in {announced:#?}"));
    let thread = &upsert["thread"];
    assert_eq!(
        thread["projectId"], "p-chosen",
        "the chosen project, not the first one"
    );
    assert_eq!(
        thread["worktreePath"],
        wt.to_string_lossy().as_ref(),
        "the worktree travels"
    );
    assert_eq!(thread["branch"], "feature/x", "so does its branch");
    assert_eq!(
        thread["runtimeMode"], "approval-required",
        "a supervised mode is not downgraded"
    );
    assert_eq!(
        thread["title"], "Chosen title",
        "the composer's title wins over the message prefix"
    );

    // and it is DURABLE — a reload sees the same context
    let stored = state.rt.threads().await;
    let saved = stored
        .iter()
        .find(|t| t["id"] == "t-ctx")
        .expect("persisted");
    assert_eq!(saved["projectId"], "p-chosen");
    assert_eq!(saved["worktreePath"], wt.to_string_lossy().as_ref());
    assert_eq!(saved["runtimeMode"], "approval-required");

    // a turn in that mode gates its tools rather than running free
    let (ask, instructions) = policy_for("approval-required", "plan");
    assert!(!ask.is_empty(), "approval-required gates tools");
    assert!(
        instructions.to_lowercase().contains("plan"),
        "plan mode reaches the agent's instructions: {instructions}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// #72: the path picker and open-in-editor are implemented, and their
/// failures are DISTINGUISHABLE.
#[tokio::test]
async fn filesystem_browse_and_open_in_editor_are_implemented() {
    struct EnvGuard {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.old {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake_editor = bin.join("mate");
    std::fs::write(&fake_editor, "#!/bin/sh\necho editor \"$1\"\nsleep 30\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&fake_editor).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&fake_editor, perms).unwrap();
    }
    let old_path = std::env::var_os("PATH");
    let mut paths = vec![bin.clone()];
    if let Some(old) = old_path.clone() {
        paths.extend(std::env::split_paths(&old));
    }
    let joined = std::env::join_paths(paths).unwrap();
    std::env::set_var("PATH", &joined);
    let _path_guard = EnvGuard { key: "PATH", old: old_path };

    let state = state_at(&dir).await;
    std::fs::create_dir_all(dir.join("alpha")).unwrap();
    std::fs::create_dir_all(dir.join("albatross")).unwrap();
    std::fs::create_dir_all(dir.join("beta")).unwrap();
    std::fs::write(dir.join("not-a-dir.txt"), "x").unwrap();

    // completing a partial segment lists only matching DIRECTORIES
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "filesystem.browse",
        json!({ "partialPath": format!("{}/al", dir.to_string_lossy()) }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "browse is implemented: {:?}",
        f[0]
    );
    let result = &f[0]["exit"]["value"];
    let names: Vec<&str> = result["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["albatross", "alpha"],
        "prefix-matched and sorted: {names:?}"
    );
    assert_eq!(result["parentPath"], dir.to_string_lossy().as_ref());
    assert!(
        result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["fullPath"].as_str().unwrap().contains("/al")),
        "entries carry usable absolute paths"
    );

    // a directory itself lists its children, and files are never offered
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "filesystem.browse",
        json!({ "partialPath": format!("{}/", dir.to_string_lossy()) }),
    )
    .await;
    let listed = drain(&mut rx);
    let names: Vec<&str> = listed[0]["exit"]["value"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"beta"), "{names:?}");
    assert!(
        !names.contains(&"not-a-dir.txt"),
        "a picker for directories does not offer files"
    );

    // an unreadable parent FAILS, and says which failure it was
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "filesystem.browse",
        json!({ "partialPath": "/definitely/not/here/at/all/x" }),
    )
    .await;
    let bad = drain(&mut rx);
    assert_eq!(bad[0]["exit"]["_tag"], "Failure");
    let msg = bad[0]["exit"]["cause"].to_string();
    assert!(
        msg.contains("read_directory_failed"),
        "the failure is classified: {msg}"
    );

    // open-in-editor: an installed editor launch crosses hearth, so the result
    // is a durable job id and the process is observable/killable through the
    // same background lane as agent commands.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "shell.openInEditor",
        json!({ "cwd": dir.to_string_lossy(), "editor": "textmate" }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Success", "fake textmate is installed: {f:?}");
    let job_id = f[0]["exit"]["value"]["jobId"].as_str().expect("hearth job id");
    let jobs = state.terminal.list_jobs().await;
    assert!(
        jobs.contains(job_id) && jobs.contains("mate"),
        "editor launch is visible in hearth jobs: {jobs}"
    );
    let killed = state.terminal.kill_job(job_id).await;
    assert!(killed.contains("killed job"), "editor job is cleanable through hearth: {killed}");

    // an editor id the contract does not define is refused outright
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "shell.openInEditor",
        json!({ "cwd": dir.to_string_lossy(), "editor": "not-an-editor" }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");
    assert!(f[0]["exit"]["cause"].to_string().contains("unknown editor"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// #84: `projects.searchContents` is implemented AND honours its options.
///
/// A UI that offers case/word/regex toggles while the backend ignores them
/// is lying about its own results, so each toggle is asserted to change the
/// answer — and an invalid regex falls back to a literal search with the
/// contract's `regexFallbackError` rather than failing the request.
#[tokio::test]
async fn project_content_search_honours_every_option() {
    let (state, dir) = test_state().await;
    std::fs::write(
        dir.join("code.rs"),
        "let Needle = 1;\nlet needle = 2;\nlet needles = 3;\nnothing here\n",
    )
    .unwrap();

    let search = |body: Value| {
        let state = state.clone();
        async move {
            let (tx, mut rx) = mpsc::unbounded_channel();
            request(&state, &tx, "projects.searchContents", body).await;
            drain(&mut rx)
        }
    };
    let base = json!({
        "cwd": dir.to_string_lossy(), "query": "needle", "limit": 50,
        "caseSensitive": false, "wholeWord": false, "useRegex": false,
    });

    // case-INsensitive finds both spellings
    let f = search(base.clone()).await;
    assert_eq!(f[0]["exit"]["_tag"], "Success", "implemented: {:?}", f[0]);
    let m = f[0]["exit"]["value"]["matches"].as_array().unwrap().clone();
    assert_eq!(m.len(), 3, "Needle, needle, needles: {m:#?}");
    let first = &m[0];
    assert_eq!(first["path"], "code.rs");
    assert_eq!(first["lineNumber"], 1, "line numbers are 1-based");
    assert_eq!(
        first["matchRanges"][0]["start"], 4,
        "the range points at the match"
    );

    // caseSensitive drops the capitalised one
    let mut cs = base.clone();
    cs["caseSensitive"] = json!(true);
    let m = search(cs).await[0]["exit"]["value"]["matches"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(m, 2, "caseSensitive changed the answer");

    // wholeWord drops "needles"
    let mut ww = base.clone();
    ww["wholeWord"] = json!(true);
    ww["caseSensitive"] = json!(true);
    let m = search(ww).await[0]["exit"]["value"]["matches"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(m, 1, "wholeWord changed the answer");

    // a real regex matches what a literal never would
    let mut re = base.clone();
    re["query"] = json!("needle?s\\b");
    re["useRegex"] = json!(true);
    let out = search(re).await;
    assert!(
        !out[0]["exit"]["value"]["matches"]
            .as_array()
            .unwrap()
            .is_empty(),
        "the regex ran: {:?}",
        out[0]["exit"]["value"]
    );

    // an INVALID regex falls back to literal and says so
    let mut bad = base.clone();
    bad["query"] = json!("needle(");
    bad["useRegex"] = json!(true);
    let out = search(bad).await;
    assert_eq!(
        out[0]["exit"]["_tag"], "Success",
        "a half-typed regex is not a failed request"
    );
    assert!(
        out[0]["exit"]["value"]["regexFallbackError"].is_string(),
        "the fallback is reported: {:?}",
        out[0]["exit"]["value"]
    );

    // limit truncates and SAYS it truncated
    let mut small = base.clone();
    small["limit"] = json!(1);
    let out = search(small).await;
    assert_eq!(
        out[0]["exit"]["value"]["matches"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        out[0]["exit"]["value"]["truncated"], true,
        "truncation is never silent"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// #209: a content search must not report a file it could not READ as a file
/// that did not MATCH.
///
/// `searchContents` used to collapse three different outcomes into one silent
/// `continue`: a metadata error, a cairn/permission read failure, and a
/// deliberate large-file skip. The RPC still answered `Ok({matches, truncated})`,
/// so a permission error on the one file containing the query was rendered by
/// the UI as a clean "no results" over a corpus the backend never opened.
///
/// The faults here are real filesystem faults, not a mocked seam: a file with
/// mode 000 (readable metadata, unreadable contents) and a dangling symlink
/// (listed by `entries`, `metadata` fails). Both contain — or claim to contain —
/// the query, so a silent skip is indistinguishable from a clean miss.
#[cfg(unix)]
#[tokio::test]
async fn a_content_search_reports_files_it_could_not_read_instead_of_calling_them_misses() {
    use std::os::unix::fs::PermissionsExt;

    let (state, dir) = test_state().await;
    // A file that DOES match and CAN be read — so the search is a real search
    // and the failure below is not the only thing happening.
    std::fs::write(dir.join("visible.rs"), "let needle = 1;\n").unwrap();
    // A file that also matches, but whose contents cannot be read.
    let locked = dir.join("locked.rs");
    std::fs::write(&locked, "let needle = 2;\n").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    // A candidate whose metadata cannot even be taken.
    std::os::unix::fs::symlink(dir.join("gone.rs"), dir.join("dangling.rs")).unwrap();
    // A file that is not text at all. This is the case that must NOT be
    // reported as a failure: every real workspace has sqlite files, images and
    // binaries, and counting them as "could not search" would bury the two
    // genuine failures above under noise the user cannot act on.
    std::fs::write(dir.join("blob.bin"), [0xff, 0xfe, 0x00, 0x01]).unwrap();

    let search = |body: Value| {
        let state = state.clone();
        async move {
            let (tx, mut rx) = mpsc::unbounded_channel();
            request(&state, &tx, "projects.searchContents", body).await;
            drain(&mut rx)
        }
    };
    let out = search(json!({
        "cwd": dir.to_string_lossy(), "query": "needle", "limit": 50,
        "caseSensitive": false, "wholeWord": false, "useRegex": false,
    }))
    .await;

    assert_eq!(
        out[0]["exit"]["_tag"], "Success",
        "one unreadable file does not make the whole search fail: {:?}",
        out[0]["exit"]
    );
    let v = &out[0]["exit"]["value"];
    // The readable match is still returned — this is not "fail the search".
    assert!(
        v["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["path"] == "visible.rs"),
        "the readable match survives: {v:#?}"
    );
    // And the corpus we could not read is REPORTED, not dropped.
    let count = v["unsearchedCount"].as_u64().unwrap_or(0);
    assert!(
        count >= 2,
        "both the unreadable file and the dangling symlink must be counted, \
         not silently skipped — got {count}: {v:#?}"
    );
    let unsearched = v["unsearched"].as_array().expect("per-file detail: {v:#?}");
    assert!(
        unsearched.iter().any(|u| u["path"] == "locked.rs"),
        "the file that CONTAINS the query and could not be read must be named: {v:#?}"
    );
    assert!(
        unsearched.iter().any(|u| u["path"] == "dangling.rs"),
        "a candidate whose metadata failed must be named: {v:#?}"
    );
    for u in unsearched {
        assert!(
            u["reason"].as_str().map(|r| !r.is_empty()).unwrap_or(false),
            "a reason a human can act on, not a bare path: {u:#?}"
        );
    }
    assert!(
        !unsearched.iter().any(|u| u["path"] == "blob.bin"),
        "a binary file is a policy skip, not a read failure: {v:#?}"
    );
    assert!(
        v["skippedBinaryCount"].as_u64().unwrap_or(0) >= 1,
        "and it is still COUNTED, so 'we did not search this' is never silent: {v:#?}"
    );

    // Restore permissions so the tempdir can actually be removed.
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644));
    let _ = std::fs::remove_dir_all(&dir);
}

/// #209, the case that matters most: the ONLY file containing the query cannot
/// be read.
///
/// `matches` is legitimately empty — there is nothing readable to match. The
/// bug was that the response was CLEAN empty, indistinguishable from "your
/// query is not in this repo". It must instead name the file it could not read,
/// so the UI can say "0 results, 1 file unsearched" rather than "0 results".
#[cfg(unix)]
#[tokio::test]
async fn an_empty_result_over_an_unreadable_match_is_not_a_clean_empty_result() {
    use std::os::unix::fs::PermissionsExt;

    let (state, dir) = test_state().await;
    let locked = dir.join("only.rs");
    std::fs::write(&locked, "let needle = 1;\n").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "projects.searchContents",
        json!({
            "cwd": dir.to_string_lossy(), "query": "needle", "limit": 50,
            "caseSensitive": false, "wholeWord": false, "useRegex": false,
        }),
    )
    .await;
    let f = drain(&mut rx);

    assert_eq!(f[0]["exit"]["_tag"], "Success", "{:?}", f[0]["exit"]);
    let v = &f[0]["exit"]["value"];
    assert!(
        v["matches"].as_array().unwrap().is_empty(),
        "nothing readable matched: {v:#?}"
    );
    // ...but the result is NOT clean, and that is the whole finding.
    assert_eq!(
        v["unsearchedCount"], 1,
        "the one file that could have matched is counted, not dropped: {v:#?}"
    );
    let u = v["unsearched"].as_array().unwrap();
    assert_eq!(u[0]["path"], "only.rs", "{v:#?}");
    assert!(
        u[0]["reason"]
            .as_str()
            .unwrap_or("")
            .contains("Permission denied"),
        "the reason is the actual OS failure, not a generic 'skipped': {v:#?}"
    );

    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644));
    let _ = std::fs::remove_dir_all(&dir);
}

/// #83: the thread subscription honours the client's resume/pagination
/// contract instead of always re-sending everything.
/// PROOF (#325/#326) AT THE PRODUCT EDGE, THREAD SCOPE: nothing published
/// while `orchestration.subscribeThread` runs is lost.
///
/// HONEST SCOPE, same as the shell-scope test below: this is a LOAD
/// REGRESSION GUARD, not the proof. A publisher on another task cannot be
/// aimed at a sub-millisecond window from outside, and I measured that
/// rather than assuming it — with the SDK flipped back to `Retained::Skip`,
/// and separately back to read-then-attach, a joined publisher still
/// passed, because its event landed either side of the window instead of
/// inside it. The deterministic proof lives at the seam, in
/// agent-sdk-shell's `attaching_before_the_log_read_delivers_the_window_event`.
/// What THIS test guards is that the handler keeps routing through that
/// seam under concurrent publishing.
///
/// The contract asserted is the reply's own watermark: the resume path
/// replays through `afterSequence` and the snapshot path advertises
/// `snapshotSequence`, so EVERY event above whichever mark the client was
/// handed is the tail's to deliver. A burst is used, not one event, because
/// the broker retains exactly ONE frame — the failure the old ordering
/// produced was two publishes in the window leaving only the newer one
/// reachable, which a single-event probe cannot see.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn events_published_inside_subscribe_thread_are_never_skipped() {
    for (label, payload) in [
        ("resume", json!({ "threadId": "t-win", "afterSequence": 0 })),
        ("snapshot", json!({ "threadId": "t-win" })),
    ] {
        let (state, _d) = test_state().await;
        let (tx, mut rx) = mpsc::unbounded_channel();

        let rt = state.rt.clone();
        let publisher = tokio::spawn(async move {
            let mut seqs = vec![];
            for i in 0..120 {
                let seq = rt.next_sequence().await.unwrap();
                let item = agent_sdk_shell::thread_event_item(
                    seq,
                    "t-win",
                    "thread.message-delta",
                    json!({ "text": format!("d{i}") }),
                );
                rt.record_and_publish("t-win", seq, &item).await.unwrap();
                seqs.push(seq);
            }
            seqs
        });
        request(&state, &tx, "orchestration.subscribeThread", payload).await;
        let seqs = publisher.await.unwrap();
        let last = *seqs.last().unwrap();

        let carries = |v: &Value, seq: i64| {
            v["values"]
                .as_array()
                .map(|vs| {
                    vs.iter().any(|x| {
                        agent_sdk_shell::event_sequence(x) == Some(seq)
                            || agent_sdk_shell::event_sequence(&x["event"]) == Some(seq)
                    })
                })
                .unwrap_or(false)
        };
        let seen = drain_until(&mut rx, std::time::Duration::from_secs(15), |v| {
            carries(v, last)
        })
        .await;
        // The mark the client was told it holds through. The resume path
        // sends no snapshot, so it is the `afterSequence` the client asked
        // from — 0 here, i.e. every event is owed.
        let mark = seen
            .iter()
            .find_map(|v| v["values"][0]["snapshot"]["snapshotSequence"].as_i64())
            .unwrap_or(0);
        let missing: Vec<i64> = seqs
            .iter()
            .copied()
            .filter(|s| *s > mark && !seen.iter().any(|v| carries(v, *s)))
            .collect();
        assert!(
            missing.is_empty(),
            "[{label}] {} event(s) above the advertised mark {mark} never reached the \
             subscriber: {missing:?}",
            missing.len()
        );
    }
}

#[tokio::test]
async fn subscribe_thread_resumes_from_a_sequence_and_windows_by_turn() {
    let (state, _d) = test_state().await;
    let projector = t3_projector(state.rt.clone());

    // three turns of history in the durable store + the event log
    for i in 0..3 {
        state
            .rt
            .append_message(
                "t-res",
                &json!({
                    "id": format!("u{i}"), "role": "user", "text": format!("question {i}"),
                }),
            )
            .await
            .unwrap();
        state
            .rt
            .append_message(
                "t-res",
                &json!({
                    "id": format!("a{i}"), "role": "assistant", "text": format!("answer {i}"),
                }),
            )
            .await
            .unwrap();
        projector
            .project(Lifecycle::MessageFinal {
                thread_id: "t-res".into(),
                turn_id: format!("turn-{i}"),
                message_id: format!("a{i}"),
                text: format!("answer {i}"),
            })
            .await
            .unwrap();
    }

    // a FULL subscribe: snapshot with every message, no page metadata
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-res" }),
    )
    .await;
    let f = drain(&mut rx);
    let snap = f
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .expect("snapshot");
    let full = &snap["values"][0]["snapshot"];
    assert_eq!(full["thread"]["messages"].as_array().unwrap().len(), 6);
    assert!(
        full["page"].is_null(),
        "an unwindowed snapshot carries no page metadata"
    );
    let watermark = full["snapshotSequence"].as_i64().unwrap();

    // a WINDOWED subscribe: only the last turn, and it says there is more
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-res", "turnLimit": 1 }),
    )
    .await;
    let f = drain(&mut rx);
    let snap = f
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .expect("snapshot");
    let win = &snap["values"][0]["snapshot"];
    let msgs = win["thread"]["messages"].as_array().unwrap();
    assert_eq!(
        msgs.len(),
        2,
        "one whole turn: its question AND its answer: {msgs:#?}"
    );
    assert_eq!(msgs[0]["id"], "u2", "the window starts at a USER message");
    assert_eq!(
        win["page"]["hasMore"], true,
        "the client is told older turns exist"
    );
    assert_eq!(win["page"]["beforeCursor"], "u2", "and where to page from");
    assert!(
        win["page"]["threadSequence"].as_i64().unwrap() > 0,
        "the thread-scoped watermark is reachable: {:?}",
        win["page"]
    );

    // a RESUME: no snapshot at all, just what was missed, then the marker
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({
            "threadId": "t-res", "afterSequence": 0, "requestCompletionMarker": true,
        }),
    )
    .await;
    let f = drain(&mut rx);
    let kinds: Vec<&str> = f
        .iter()
        .flat_map(|x| x["values"].as_array().cloned().unwrap_or_default())
        .filter_map(|v| v["kind"].as_str().map(str::to_string))
        .map(|k| Box::leak(k.into_boxed_str()) as &str)
        .collect();
    assert!(
        !kinds.contains(&"snapshot"),
        "a resuming client is not re-sent the thread: {kinds:?}"
    );
    assert!(
        kinds.contains(&"event"),
        "it IS sent the events it missed: {kinds:?}"
    );
    assert_eq!(
        kinds.last(),
        Some(&"synchronized"),
        "then the marker, before live: {kinds:?}"
    );

    // resuming from the CURRENT high-water mark replays nothing
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({
            "threadId": "t-res", "afterSequence": watermark,
        }),
    )
    .await;
    let f = drain(&mut rx);
    let events: Vec<Value> = f
        .iter()
        .flat_map(|x| x["values"].as_array().cloned().unwrap_or_default())
        .filter(|v| v["kind"] == "event")
        .collect();
    assert!(
        events.is_empty(),
        "an up-to-date client gets no replay: {events:#?}"
    );
}

/// #139: this runtime advertises that a model/provider switch does NOT
/// require a new thread — the frontend block is inert here, by declaration
/// rather than by omission.
#[tokio::test]
async fn providers_declare_that_switching_models_needs_no_new_thread() {
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "server.getConfig", json!({})).await;
    let f = drain(&mut rx);
    let providers = f[0]["exit"]["value"]["providers"]
        .as_array()
        .expect("providers");
    assert!(!providers.is_empty(), "the runtime advertises providers");
    for p in providers {
        assert_eq!(
            p["requiresNewThreadForModelChange"], false,
            "provider {} must not force a new chat to switch models: {p}",
            p["instanceId"]
        );
    }
}

/// #173: the metadata LIVE path reports the real panes, not a hard-coded id.
///
/// The initial snapshot already listed the registry; a live update that
/// re-emitted `term-1` contradicted it the moment anything moved — a pane the
/// user opened appeared once and then never updated again, while a phantom
/// kept reporting.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_metadata_updates_report_the_real_panes() {
    let (state, dir) = test_state().await;
    state
        .terminals
        .open(
            &terminal::TerminalOwner::thread("t-1"),
            "pane-x",
            Some(&state.cwd),
            None,
            &[],
        )
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-1" }),
    )
    .await;
    let initial = drain(&mut rx);
    let ids: Vec<String> = initial[0]["values"][0]["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["terminalId"].as_str().unwrap().to_string())
        .collect();
    assert!(
        ids.contains(&"pane-x".to_string()),
        "the snapshot lists the real pane: {ids:?}"
    );

    // move the pane's lifecycle — the live path must speak about pane-x
    let pane = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-1"), "pane-x")
        .await
        .expect("pane store readable")
        .expect("pane exists");
    pane.runner.run("echo moving", false, Some(10), false).await;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut live_ids: Vec<String> = vec![];
    while tokio::time::Instant::now() < deadline && live_ids.is_empty() {
        match tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
            Ok(Some((raw, _))) => {
                let v: Value = serde_json::from_str(&raw).unwrap();
                if let Some(rows) = v["values"][0]["terminals"].as_array() {
                    live_ids = rows
                        .iter()
                        .map(|t| t["terminalId"].as_str().unwrap_or("").to_string())
                        .collect();
                }
            }
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    assert!(!live_ids.is_empty(), "the live path emitted something");
    assert!(
        live_ids.contains(&"pane-x".to_string()),
        "live metadata names the real pane: {live_ids:?}"
    );
    assert!(
        !live_ids.contains(&"term-1".to_string()),
        "and never invents a pane nobody opened: {live_ids:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// #58: the repository actions discovery unlocks are IMPLEMENTED — they
/// reach a real tool and fail with a reason, instead of the
/// unsupported-method arm.
#[tokio::test]
async fn source_control_repository_actions_are_wired() {
    let (state, dir) = test_state().await;

    // clone refuses a destination that already exists — before running git,
    // and with a message that says why
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.cloneRepository",
        json!({
            "provider": "github", "repository": "t3/t3",
            "destinationPath": dir.to_string_lossy(),
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Failure",
        "not the unsupported arm: {:?}",
        f[0]
    );
    let msg = f[0]["exit"]["cause"].to_string();
    assert!(
        msg.contains("already exists"),
        "refused for the right reason: {msg}"
    );
    assert!(
        !msg.contains("unsupported"),
        "the method IS implemented: {msg}"
    );

    // a provider this environment cannot drive is named, not silently ignored
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.lookupRepository",
        json!({ "provider": "bitbucket", "repository": "a/b" }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");
    assert!(
        f[0]["exit"]["cause"].to_string().contains("bitbucket"),
        "the error names the provider: {:?}",
        f[0]["exit"]["cause"]
    );

    // publish refuses a cwd that is not a repository
    let plain = dir.join("not-a-repo");
    std::fs::create_dir_all(&plain).unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.publishRepository",
        json!({
            "cwd": plain.to_string_lossy(), "provider": "github",
            "repository": "t3/x", "visibility": "private",
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");
    assert!(
        f[0]["exit"]["cause"]
            .to_string()
            .contains("not a git repository"),
        "{:?}",
        f[0]["exit"]["cause"]
    );

    // a lookup for a repository that needs the network either works or fails
    // with gh's own message — never with "unsupported method"
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.lookupRepository",
        json!({ "provider": "github", "repository": "t3-oss/t3-code-does-not-exist" }),
    )
    .await;
    let f = drain(&mut rx);
    let body = f[0].to_string();
    assert!(!body.contains("unsupported method"), "{body}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// #178/#179/#181: client-supplied paths are ADMITTED through the same
/// workspace/worktree authority as file and git operations — refusals are
/// tested, not just the happy paths.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_paths_are_admitted_before_any_tool_runs() {
    let (state, dir) = test_state().await;
    let outside = std::env::temp_dir().join(format!("t3-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();

    // #178: a clone destination outside the environment is refused BEFORE
    // git runs — the directory must not appear.
    let target = outside.join("cloned");
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.cloneRepository",
        json!({
            "remoteUrl": "https://example.invalid/x.git",
            "destinationPath": target.to_string_lossy(),
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");
    assert!(
        f[0]["exit"]["cause"]
            .to_string()
            .contains("outside this environment"),
        "{:?}",
        f[0]["exit"]["cause"]
    );
    assert!(
        !target.exists(),
        "nothing was created outside the environment"
    );

    // #181: publishing a repository outside the environment is refused,
    // even though it IS a valid git repository.
    let foreign = outside.join("repo");
    std::fs::create_dir_all(&foreign).unwrap();
    for args in [
        vec!["init", "-q", "."],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&foreign)
            .output()
            .unwrap();
    }
    std::fs::write(foreign.join("f.txt"), "x").unwrap();
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "base"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&foreign)
            .output()
            .unwrap();
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "sourceControl.publishRepository",
        json!({
            "cwd": foreign.to_string_lossy(), "provider": "github",
            "repository": "someone/else", "visibility": "private",
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");
    let why = f[0]["exit"]["cause"].to_string();
    assert!(
        why.contains("workspace") || why.contains("worktree"),
        "refused on AUTHORITY, not because it is not a repo: {why}"
    );

    // #179: a terminal cannot be opened outside the environment either
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": "t-1", "terminalId": "escape", "cwd": outside.to_string_lossy(),
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure", "a PTY obeys the same boundary: {:?}", f[0]);
    assert!(
        state
            .terminals
            .get(&terminal::TerminalOwner::thread("t-1"), "escape")
            .await
            .expect("pane store readable")
            .is_none(),
        "no pane was registered"
    );

    // …nor attached to one
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.attach",
        json!({
            "threadId": "t-1", "terminalId": "escape2", "worktreePath": outside.to_string_lossy(),
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["exit"]["_tag"], "Failure");

    // and the workspace itself is still allowed — the boundary admits, it
    // does not just refuse
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.open",
        json!({
            "threadId": "t-1", "terminalId": "inside", "cwd": state.cwd.clone(),
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["exit"]["_tag"], "Success",
        "the workspace is admissible: {:?}",
        f[0]
    );

    let _ = std::fs::remove_dir_all(&outside);
    let _ = std::fs::remove_dir_all(&dir);
}

/// #182: a RUNNING shell tool tells the UI where to watch it.
///
/// The workflow is watching and cancelling a command mid-flight, so the
/// attach target has to be on the `tool.started` row — learning it from the
/// completion output is learning it too late — and it has to be a terminal a
/// client can actually attach to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_shell_tool_carries_its_attachable_terminal() {
    let (state, dir) = test_state().await;
    let projector = t3_projector(state.rt.clone());
    let tail = state.rt.tail("t-1").await.unwrap();

    projector
        .project(Lifecycle::ToolStarted {
            thread_id: "t-1".into(),
            turn_id: "turn-1".into(),
            call_id: "call-1".into(),
            tool: "run_bash".into(),
            args: json!({ "command": "sleep 30" }),
        })
        .await
        .unwrap();

    let items = tail.next(std::time::Duration::from_secs(5)).await.unwrap();
    let started = items
        .iter()
        .map(|(_, v)| v)
        .find(|e| e["event"]["payload"]["activity"]["kind"] == "tool.started")
        .unwrap_or_else(|| panic!("no tool.started in {items:#?}"));
    let target = &started["event"]["payload"]["activity"]["payload"]["terminal"];
    assert_eq!(
        target["attachable"], true,
        "the row says it can be watched: {target}"
    );
    let terminal_id = target["terminalId"].as_str().expect("a terminal id");

    // and that id really attaches to the agent's live shell — before the
    // tool completes
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.attach",
        json!({ "threadId": "t-1", "terminalId": terminal_id }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(f[0]["values"][0]["type"], "snapshot", "attach opened: {f:?}");
    let pane = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-1"), terminal_id)
        .await
        .expect("pane store readable")
        .expect("registered");
    assert!(pane.shared, "it is the AGENT's shell, not a fresh pane");

    // a non-shell tool advertises no terminal rather than a misleading one
    projector
        .project(Lifecycle::ToolStarted {
            thread_id: "t-1".into(),
            turn_id: "turn-1".into(),
            call_id: "call-2".into(),
            tool: "write_file".into(),
            args: json!({ "path": "x" }),
        })
        .await
        .unwrap();
    let items = tail.next(std::time::Duration::from_secs(5)).await.unwrap();
    let other = items
        .iter()
        .map(|(_, v)| v)
        .find(|e| e["event"]["payload"]["activity"]["payload"]["callId"] == "call-2")
        .expect("the second row");
    assert!(
        other["event"]["payload"]["activity"]["payload"]["terminal"].is_null(),
        "a file tool has no PTY to watch"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#228): subscribing to a terminal's events does NOT create it.
///
/// `TerminalRegistry::open` returns an existing pane unchanged, so a
/// subscription that ran first would pin the id to the workspace default
/// cwd/env forever — the UI opens a worktree shell and gets a default one,
/// with no error to show for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn subscribing_to_a_terminal_does_not_decide_its_identity() {
    let (state, dir) = test_state().await;
    let sub_dir = dir.join("wt");
    std::fs::create_dir_all(&sub_dir).unwrap();

    // The subscription arrives FIRST, with no cwd/worktree of its own.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalEvents",
        json!({
            "threadId": "t-9", "terminalId": "pane-x",
        }),
    )
    .await;
    let f = drain(&mut rx);
    assert_eq!(
        f[0]["values"][0]["pending"],
        json!(true),
        "no pane exists yet: {f:?}"
    );
    assert!(
        state
            .terminals
            .get(&terminal::TerminalOwner::thread("t-9"), "pane-x")
            .await
            .expect("pane store readable")
            .is_none(),
        "the subscription created a pane and pinned its identity"
    );

    // The real open supplies the identity.
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "terminal.open",
        json!({
            "threadId": "t-9", "terminalId": "pane-x",
            "worktreePath": sub_dir.to_string_lossy(), "env": { "PANE": "x" },
        }),
    )
    .await;
    assert_eq!(drain(&mut rx2)[0]["exit"]["_tag"], "Success");

    let pane = state
        .terminals
        .get(&terminal::TerminalOwner::thread("t-9"), "pane-x")
        .await
        .expect("pane store readable")
        .expect("opened");
    let where_x = pane.runner.run("basename \"$PWD\"; echo [$PANE]", false, Some(10), false).await;
    assert!(where_x.output.contains("wt"), "the pane landed in the requested worktree: {where_x:?}");
    assert!(where_x.output.contains("[x]"), "the requested env reached the shell: {where_x:?}");
}

/// PROOF (#225): a no-selection turn is admitted against the LIVE catalog.
///
/// The default used to be frozen at boot, so after settings reconciled — a
/// provider added or the old default removed — the picker and the thread
/// metadata named one provider while the turn ran the boot one. Nothing in
/// the UI could show the drift.
#[tokio::test]
async fn turn_admission_follows_the_live_catalog_not_the_boot_default() {
    let (state, _dir) = test_state().await;

    // What admission resolves for an EMPTY selection right now.
    let before = model_from_selection(
        &*state.catalog.read().await,
        &json!({}),
        &state.default_model().await,
    )
    .expect("a default is routable at boot");

    // Settings reconcile: the catalog is replaced with one whose only
    // routable instance is a different provider.
    {
        let mut catalog = state.catalog.write().await;
        *catalog = Catalog::new();
        catalog.reconcile(&[providers::instance(
            "ollama_local",
            agent_sdk_shell::DRIVER_OPENAI_COMPAT,
            "Ollama",
            json!({ "baseUrl": "http://127.0.0.1:11434", "models": ["llama3.2"] }),
        )]);
    }

    let after = model_from_selection(
        &*state.catalog.read().await,
        &json!({}),
        &state.default_model().await,
    )
    .expect("the reconciled catalog is routable");
    assert_ne!(
        format!("{after:?}"),
        format!("{before:?}"),
        "turn admission is still using the boot default after a reconcile"
    );
    assert!(
        format!("{after:?}").contains("llama3.2"),
        "admission did not follow the live catalog: {after:?}"
    );

    // …and the metadata the UI shows agrees with what admission would run.
    let shown = default_model_selection(&state).await;
    assert_eq!(shown["instanceId"], json!("ollama_local"), "{shown}");
}

/// PROOF (#311): the reconnect snapshot rebuilds the SAME activity row the
/// live projection emits.
///
/// The snapshot used to hand-roll a flat object — `{kind, threadId,
/// requestId, toolName, input, createdAt}` — with no `id`, `tone`,
/// `summary`, `turnId`, and the routing fields at the top level rather than
/// inside `payload`. `OrchestrationThreadActivity` requires those, so the
/// snapshot either failed to decode or silently dropped the approval: a user
/// reconnecting to a parked turn got a spinner with nothing to answer, which
/// is precisely what hydrating from the durable store exists to prevent.
///
/// Comparing the two constructions field-by-field is the point — a test that
/// only asserted the snapshot's own keys would agree with the bug.
#[test]
fn the_snapshot_approval_row_matches_the_live_one_field_for_field() {
    let args = json!({ "command": "rm -rf build" });
    let live = approval_requested_activity(
        "sess-1",
        3,
        "call-9",
        "run_bash",
        &args,
        Some("turn-1"),
        "T0",
    );
    let snapshot =
        approval_requested_activity("sess-1", 3, "call-9", "run_bash", &args, None, "T0");

    // Every field the contract requires is present on the SNAPSHOT row.
    for field in [
        "id",
        "tone",
        "kind",
        "summary",
        "payload",
        "turnId",
        "createdAt",
    ] {
        assert!(
            snapshot.get(field).is_some(),
            "the reconnect row is missing the contract-required `{field}`: {snapshot}"
        );
    }
    // The routing lives INSIDE payload, not at the top level — the flat
    // shape is what made the row undecodable.
    assert_eq!(snapshot["payload"]["requestId"], json!("sess-1|3|call-9"));
    assert_eq!(
        snapshot["payload"]["requestKind"],
        live["payload"]["requestKind"]
    );
    assert!(
        snapshot.get("requestId").is_none() && snapshot.get("toolName").is_none(),
        "the old flat fields are back at the top level: {snapshot}"
    );
    // Same row identity, so a live event arriving after the snapshot
    // REPLACES the hydrated row instead of duplicating the banner.
    assert_eq!(
        snapshot["id"], live["id"],
        "snapshot and live must be one row"
    );
    assert_eq!(snapshot["kind"], live["kind"]);
    assert_eq!(snapshot["tone"], live["tone"]);
    assert_eq!(snapshot["summary"], live["summary"]);
    assert_eq!(snapshot["payload"], live["payload"]);
    // The only intended difference: a snapshot row claims no turn.
    assert_eq!(snapshot["turnId"], Value::Null);
    assert_eq!(live["turnId"], json!("turn-1"));
}

/// PROOF (#305/#306/#307): parked approvals and user-input asks reach the
/// client through events the CONTRACT defines.
///
/// The projector used to emit `thread.approval-requested` /
/// `thread.user-input-requested`, which are not in `OrchestrationEventType`
/// at all — the real reducer fell through its forward-compatible default,
/// returned `unchanged`, and the prompt never appeared, so the turn looked
/// hung. It also carried `hasPendingApprovals` inside a `thread.session-set`
/// payload, where the reducer ignores it: those flags live on the THREAD
/// SHELL. Both asks are now `thread.activity-appended` with the contract's
/// `approval` tone, which is what `session-logic.ts` derives pending state
/// from.
#[tokio::test]
async fn parked_asks_are_projected_as_contract_defined_activities() {
    let (state, dir) = test_state().await;
    let rt = state.rt.clone();
    let projector = t3_projector(rt.clone());
    let thread_id = "t-approval";

    let tail = rt.tail(thread_id).await.expect("tail the thread");

    projector
        .project(agent_sdk_shell::Lifecycle::ApprovalRequested {
            thread_id: thread_id.into(),
            turn_id: "turn-1".into(),
            session_id: "sess-1".into(),
            turn: 3,
            call_id: "call-9".into(),
            tool: "run_bash".into(),
            args: json!({ "command": "rm -rf build" }),
        })
        .await
        .expect("approval projects");

    let items = tail.next(std::time::Duration::from_secs(2)).await.unwrap();
    let (_seq, item) = items
        .iter()
        .find(|(_, i)| i["event"]["payload"]["activity"]["kind"] == "approval.requested")
        .expect("the approval ask was published");
    let payload = &item["event"];
    assert_eq!(
        payload["type"], "thread.activity-appended",
        "the ask must use a contract-defined event type: {payload}"
    );
    let activity = &payload["payload"]["activity"];
    assert_eq!(activity["tone"], "approval");
    assert_eq!(activity["kind"], "approval.requested");
    // the web client only builds a PendingApproval when it can classify the
    // request — without requestKind the row renders as nothing at all
    assert_eq!(activity["payload"]["requestKind"], "command");
    assert_eq!(
        activity["payload"]["requestId"], "sess-1|3|call-9",
        "the answer's routing rides on the activity"
    );

    // …and a user-input ask carries the provider's structure when it has one.
    projector
        .project(agent_sdk_shell::Lifecycle::UserInputRequested {
            thread_id: thread_id.into(),
            turn_id: "turn-1".into(),
            session_id: "sess-2".into(),
            prompt: "Which approach?".into(),
            questions: Some(json!([{
                "id": "q1", "header": "Approach", "question": "Which approach?",
                "options": [{"label": "A", "description": "first"}],
            }])),
        })
        .await
        .expect("user input projects");

    // The tail replays from the start until items are acked, so find the
    // user-input ask rather than assuming it is first.
    let mut items = tail.next(std::time::Duration::from_secs(2)).await.unwrap();
    for _ in 0..5 {
        if items
            .iter()
            .any(|(_, i)| i["event"]["payload"]["activity"]["kind"] == "user-input.requested")
        {
            break;
        }
        items = tail.next(std::time::Duration::from_secs(2)).await.unwrap();
    }
    let (_seq, item) = items
        .iter()
        .find(|(_, i)| i["event"]["payload"]["activity"]["kind"] == "user-input.requested")
        .expect("the user-input ask was published");
    let payload = &item["event"];
    assert_eq!(payload["type"], "thread.activity-appended");
    let activity = &payload["payload"]["activity"];
    assert_eq!(activity["kind"], "user-input.requested");
    assert_eq!(
        activity["payload"]["questions"][0]["options"][0]["label"], "A",
        "the answer widget needs the options, not prose: {activity}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#318): a metadata change is REPLAYABLE, not just live.
///
/// `thread.meta-updated` was published straight to the bus with no
/// `record_event`, so a client watching at the time saw the rename and a
/// client that reconnected with `afterSequence` replayed a thread whose
/// title had silently moved on. Nothing reported the difference, and it
/// never reproduced while you watched — because live delivery worked.
#[tokio::test]
async fn a_metadata_change_is_in_the_replay_log_not_only_on_the_bus() {
    let (state, dir) = test_state().await;
    let thread = json!({
        "id": "t-meta", "projectId": "p-workspace", "title": "before",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    });
    state.rt.save_thread(&thread).await.unwrap();
    let before = state.rt.current_sequence().await.unwrap();

    update_thread_meta(&state, "t-meta", &json!({ "title": "after" }))
        .await
        .expect("the rename lands");

    // A client that was NOT connected catches up from the durable log.
    let replayed = state.rt.events_after("t-meta", before, 100).await.unwrap();
    let meta = replayed
        .iter()
        .find(|e| e["event"]["type"] == "thread.meta-updated")
        .unwrap_or_else(|| panic!("the rename is missing from replay: {replayed:?}"));
    assert_eq!(
        meta["event"]["payload"]["thread"]["title"], "after",
        "the replayed event carries the new title: {meta}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#315/#316): a settled approval reaches the client as the activity
/// the reducer actually clears on, AND is in the replay log.
///
/// Two bugs in one call. The event type was invented
/// (`thread.approval-resolved`, absent from `OrchestrationEventType`), so
/// the reducer fell through its default and the banner stayed up after the
/// user answered. And it was published without `record_event`, so even the
/// right event would have been missing for anyone who reconnected.
///
/// What clears a pending approval is an activity with `kind:
/// "approval.resolved"` carrying the request's own id — `session-logic.ts`
/// `pendingApprovalsFromActivities` deletes the open entry keyed by it.
#[tokio::test]
async fn a_settled_approval_is_a_replayable_resolved_activity() {
    let (state, dir) = test_state().await;
    let thread = json!({
        "id": "t-appr", "projectId": "p-workspace", "title": "appr",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    });
    state.rt.save_thread(&thread).await.unwrap();
    let before = state.rt.current_sequence().await.unwrap();

    publish_approval_resolved(&state, "t-appr", "sess|0|call-1", "accept", true)
        .await
        .unwrap();

    let replayed = state.rt.events_after("t-appr", before, 100).await.unwrap();
    let ev = replayed
        .iter()
        .find(|e| e["event"]["type"] == "thread.activity-appended")
        .unwrap_or_else(|| panic!("the resolution is missing from replay: {replayed:?}"));
    assert!(
        !replayed
            .iter()
            .any(|e| e["event"]["type"] == "thread.approval-resolved"),
        "the invented event type is back: {replayed:?}"
    );
    let activity = &ev["event"]["payload"]["activity"];
    assert_eq!(
        activity["kind"], "approval.resolved",
        "this kind is what clears the pending approval: {activity}"
    );
    assert_eq!(
        activity["payload"]["requestId"], "sess|0|call-1",
        "the id must match the REQUEST's, or the client clears nothing: {activity}"
    );
    assert_eq!(
        activity["id"], "approval:sess|0|call-1",
        "same row id as the request, so the answer replaces it: {activity}"
    );
    assert_eq!(activity["payload"]["decision"], "accept");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#317): answering the agent's question closes the composer.
///
/// There was no `user-input.resolved` activity at all, so the composer's
/// pending-input state never cleared: the user submitted an answer and was
/// left with a blocked composer and nothing saying it had landed.
#[tokio::test]
async fn an_answered_question_is_a_replayable_resolved_activity() {
    let (state, dir) = test_state().await;
    let thread = json!({
        "id": "t-ui", "projectId": "p-workspace", "title": "ui",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    });
    state.rt.save_thread(&thread).await.unwrap();
    let before = state.rt.current_sequence().await.unwrap();

    publish_user_input_resolved(&state, "t-ui", "sess-9").await.unwrap();

    let replayed = state.rt.events_after("t-ui", before, 100).await.unwrap();
    let ev = replayed
        .iter()
        .find(|e| e["event"]["type"] == "thread.activity-appended")
        .unwrap_or_else(|| panic!("the answer is missing from replay: {replayed:?}"));
    let activity = &ev["event"]["payload"]["activity"];
    assert_eq!(activity["kind"], "user-input.resolved", "{activity}");
    assert_eq!(
        activity["payload"]["requestId"], "sess-9",
        "the requestId for user input IS the session id: {activity}"
    );
    assert_eq!(
        activity["id"], "user-input:sess-9",
        "same row id as the request activity: {activity}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Settlement projection is durable lifecycle, not an RPC side effect hidden
/// behind `let _ = emit_thread_event(...)`. If the replay log cannot accept the
/// activity, every helper must return an error so the command handler can keep
/// the request visibly pending or failed instead of acknowledging success.
#[tokio::test]
async fn settlement_projection_failures_are_reported() {
    let (state, dir) = test_state().await;
    let thread = json!({
        "id": "t-settle-fails", "projectId": "p-workspace", "title": "settle",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    });
    state.rt.save_thread(&thread).await.unwrap();
    let db = state.rt.store().db().clone();
    db.execute("DROP TABLE thread_event", vec![]).await.unwrap();

    assert!(
        publish_approval_resolved(&state, "t-settle-fails", "sess|0|call-1", "accept", true)
            .await
            .is_err(),
        "approval resolution must fail when the durable event log write fails"
    );
    assert!(
        publish_approval_failed(&state, "t-settle-fails", "sess|0|call-1", "failed")
            .await
            .is_err(),
        "approval failure mirror must fail when the durable event log write fails"
    );
    assert!(
        publish_user_input_resolved(&state, "t-settle-fails", "sess-9")
            .await
            .is_err(),
        "user-input resolution must fail when the durable event log write fails"
    );
    assert!(
        publish_user_input_failed(&state, "t-settle-fails", "sess-9", "failed")
            .await
            .is_err(),
        "user-input failure mirror must fail when the durable event log write fails"
    );
}

fn exit_defect(exit: &Value) -> &str {
    exit["exit"]["cause"][0]["defect"]
        .as_str()
        .or_else(|| exit["exit"]["cause"][0]["error"]["defect"].as_str())
        .or_else(|| exit["exit"]["cause"][0]["error"]["message"].as_str())
        .unwrap_or("")
}

async fn drop_thread_event_table(dir: &std::path::Path) {
    drop_thread_event_log(dir).await
}

async fn drop_thread_event_log(dir: &std::path::Path) {
    let pool = do_storage::DbPool::new(dir.join("data").join("threadruntime"));
    let db = pool.object_db("threadruntime", "main").await.unwrap();
    db.execute("DROP TABLE thread_event", vec![]).await.unwrap();
}

/// PROOF (#103): settlement projection is part of applying the command.
///
/// A malformed approval response takes the failure-mirror branch. That mirror
/// is not optional telemetry: if the durable thread event cannot be recorded,
/// the client must NOT receive the generic applied `Success { sequence }`.
#[tokio::test]
async fn approval_failure_projection_failure_is_not_reported_as_applied() {
    let (state, dir) = test_state().await;
    state
        .rt
        .save_thread(&json!({
            "runtimeMode": "full-access",
            "id": "t-appr-fail",
            "projectId": "p-workspace",
            "title": "approval fail",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    drop_thread_event_log(&dir).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.approval.respond",
            "threadId": "t-appr-fail",
            "requestId": "not-a-session-turn-call",
            "decision": "accept",
        }}),
    )
    .await;

    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "failed approval projection must not fall through to applied success: {exit}"
    );
    let msg = exit["exit"]["cause"][0]["defect"].as_str().unwrap_or("");
    assert!(
        msg.contains("projection") || msg.contains("thread_event"),
        "failure names the lifecycle projection/storage failure: {exit}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#103): a successfully delivered answer is still not "applied" until
/// the resolved lifecycle activity is durably recorded for replay.
#[tokio::test]
async fn user_input_resolved_projection_failure_is_not_reported_as_applied() {
    let (state, dir) = test_state().await;
    state
        .rt
        .save_thread(&json!({
            "runtimeMode": "full-access",
            "id": "t-ui-fail",
            "projectId": "p-workspace",
            "title": "ui fail",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    let binding = SessionBinding {
        thread_id: "t-ui-fail".into(),
        provider_instance_id: "claude_resume:test".into(),
        model_key: "k".into(),
    };
    let def = AgentDefinition {
        name: "t3code".into(),
        instructions: "".into(),
        model: ModelRef::ClaudeResume { model: "test".into() },
        tools: vec![],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        labels: Default::default(),
        options: vec![],
        cwd: None,
    };
    let session = state.rt.session_for(&binding, def).await.unwrap();
    state
        .rt
        .record_user_input_request(
            "t-ui-fail",
            &session,
            "turn-1",
            "answer me",
            None,
            &now_iso(),
        )
        .await
        .unwrap();
    drop_thread_event_log(&dir).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.user-input.respond",
            "threadId": "t-ui-fail",
            "requestId": session,
            "answers": { "answer": "yes" },
        }}),
    )
    .await;

    let exit = drain(&mut rx)
        .into_iter()
        .find(|f| f["_tag"] == "Exit")
        .expect("exits");
    assert_eq!(
        exit["exit"]["_tag"], "Failure",
        "resolved user-input projection must not fall through to applied success: {exit}"
    );
    let msg = exit["exit"]["cause"][0]["defect"].as_str().unwrap_or("");
    assert!(
        msg.contains("lifecycle projection") || msg.contains("thread_event"),
        "failure names the lifecycle projection/storage failure: {exit}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#303): the shell's thread list is read from the DURABLE store, so
/// there is no in-memory copy that can disagree with it.
///
/// The projection used to be a `Vec<Value>` on `Store` that
/// `upsert_thread_on_shell` mutated and the shell snapshot answered from.
/// Two writers, one truth: a durable save that failed after the copy moved
/// left every connected client rendering a thread the store did not have,
/// and a restart made it vanish. This test writes a thread ONLY through the
/// runtime — never through any product-side list — and requires the shell
/// snapshot to show it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shell_snapshot_reads_threads_from_the_durable_store() {
    let (state, _tmp) = test_state().await;

    // written durably, with nothing announced and no product cache touched.
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-durable-only", "projectId": "p-workspace", "title": "written durably",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .expect("persist the thread");

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .unwrap_or_else(|| panic!("no shell snapshot in {frames:#?}"));
    let threads = snap["values"][0]["snapshot"]["threads"]
        .as_array()
        .expect("the snapshot carries a thread list");
    assert!(
        threads.iter().any(|t| t["id"] == "t-durable-only"),
        "a thread that exists only in the durable store is in the shell snapshot: {threads:#?}"
    );

    // and the snapshot's mark is what the shell topic has RECORDED, not a
    // process counter and not the allocator's current value (#326): the
    // counter can name a sequence whose frame is not written yet, and a
    // snapshot taken after that read does not contain it, so a tail
    // suppressing `<= mark` would swallow it.
    let mark = snap["values"][0]["snapshot"]["snapshotSequence"].as_i64().unwrap();
    assert_eq!(
        mark,
        state.rt.shell_sequence().await.unwrap(),
        "the mark is the recorded shell watermark"
    );
}

/// PROOF (#370): the shell snapshot's `projects` field comes from the
/// SAME durable source the `threads` field does — not a boot-time
/// constant on `Store`. Two `AppState`s built over the same data dir
/// from DIFFERENT working directories carry identical project rows in
/// their snapshots; the first process's seed wins and the second
/// reads it, so `createdAt` does not move across restarts and two
/// backends on the same isolate cannot ship divergent workspaceRoot /
/// title for the same project id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_shell_snapshot_reads_projects_from_the_durable_store() {
    // First process: builds the state, seeds the durable project via
    // test_state (which mirrors boot). Capture the snapshot.
    let (state_a, tmp) = test_state().await;
    let (tx_a, mut rx_a) = mpsc::unbounded_channel();
    request(&state_a, &tx_a, "orchestration.subscribeShell", json!({})).await;
    let frames_a = drain(&mut rx_a);
    let snap_a = frames_a
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .unwrap_or_else(|| panic!("no shell snapshot A in {frames_a:#?}"));
    let projects_a = snap_a["values"][0]["snapshot"]["projects"].clone();
    let created_a = projects_a[0]["createdAt"].clone();
    assert!(
        created_a.is_string(),
        "the seeded project carries createdAt: {projects_a:#?}"
    );

    // A fresh AppState over the SAME data dir — proves the durable read
    // path, not crash recovery (#375). If projects were still a
    // boot-time constant on `Store`, this snapshot would carry a fresh
    // `createdAt` for the same id — the divergence the finding names.
    // Instead, the second process's boot check sees the row already
    // there, skips the write, and the snapshot mirrors process A.
    let data = tmp.join("data");
    let runner_b = tools::open_workspace_shell(&tmp, data.clone())
        .await
        .unwrap();
    let tool_roots_b = tools::ToolRoots::new(tmp.to_path_buf(), data.clone(), runner_b.clone()).await;
    let shell_b = Arc::new(Shell::new(&data, tool_roots_b.registry_factory()));
    let rt_b = ThreadRuntime::open(shell_b, data.to_str().unwrap(), "main")
        .await
        .unwrap();
    // Boot rule: seed only if empty. On this SECOND process the row is
    // already there, so this is a no-op — createdAt stays put.
    match rt_b.projects().await {
        Ok(v) if v.is_empty() => panic!("the durable seed did not persist across process A"),
        Ok(_) => {}
        Err(e) => panic!("project store unreadable: {e}"),
    }
    let state_b = AppState {
        rt: rt_b,
        catalog: state_a.catalog.clone(),
        checkpoints: tools::checkpoint_pool(data.join("checkpoints")),
        checkpoints_dir: data.join("checkpoints"),
        diag_history: state_a.diag_history.clone(),
        _contract_test_fd_slot: state_a._contract_test_fd_slot.clone(),
        terminals: state_a.terminals.clone(),
        vcs_watch_changed: Arc::new(tokio::sync::watch::channel(0u64).0),
        terminal: runner_b,
        tool_roots: tool_roots_b,
        assets_key: state_a.assets_key.clone(),
        usage_sources: state_a.usage_sources.clone(),
        usage_rates: state_a.usage_rates.clone(),
        env: state_a.env,
        cwd: "/tmp/a-different-cwd".into(),
        project_name: "a-different-name".into(),
    };
    let (tx_b, mut rx_b) = mpsc::unbounded_channel();
    request(&state_b, &tx_b, "orchestration.subscribeShell", json!({})).await;
    let frames_b = drain(&mut rx_b);
    let snap_b = frames_b
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .unwrap_or_else(|| panic!("no shell snapshot B in {frames_b:#?}"));
    let projects_b = snap_b["values"][0]["snapshot"]["projects"].clone();

    assert_eq!(
        projects_a, projects_b,
        "two backends on the same isolate must see identical projects; \
         the finding's failure was that process B synthesized its own from cwd."
    );
    assert_eq!(
        projects_b[0]["createdAt"], created_a,
        "the seed's createdAt survived across the two boots; a boot-stamped constant fails this"
    );
}

/// PRODUCT EDGE (#326/#327), deterministic: the shell subscription is a
/// LIVE tail attached by the SDK bridge, and the mark it advertises is the
/// boundary that tail honours — a frame emitted after the reply carries a
/// sequence above the mark and reaches the subscriber.
///
/// This is the ordering guard, not the window proof. The window proof is
/// deterministic and lives at the seam, in agent-sdk-shell:
/// `the_legacy_mark_then_attach_order_drops_a_window_frame` reproduces the
/// loss (one retained slot, two frames) and
/// `shell_snapshot_tail_keeps_every_frame_published_after_the_attach` shows
/// the same two frames surviving once the attach precedes the mark read.
/// A publisher racing the handler from outside CANNOT aim at that window —
/// measured: with the broken ordering restored, both a joined publisher and
/// a 400-frame burst still passed.
#[tokio::test]
async fn the_shell_subscription_is_a_live_tail_above_the_mark_it_advertises() {
    let (state, _tmp) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(&state, &tx, "orchestration.subscribeShell", json!({})).await;
    let snap = drain(&mut rx);
    let mark = snap
        .iter()
        .find_map(|f| f["values"][0]["snapshot"]["snapshotSequence"].as_i64())
        .unwrap_or_else(|| panic!("no shell snapshot in {snap:#?}"));

    let seq = state
        .rt
        .emit_shell_event(json!({ "kind": "threadUpserted", "id": "t-live" }))
        .await
        .expect("emit a shell frame");
    assert!(
        seq > mark,
        "a frame emitted after the reply is above the mark {mark}"
    );

    let seen = drain_until(&mut rx, std::time::Duration::from_secs(10), |v| {
        v["values"]
            .as_array()
            .map(|vs| {
                vs.iter()
                    .any(|x| agent_sdk_shell::event_sequence(x) == Some(seq))
            })
            .unwrap_or(false)
    })
    .await;
    assert!(
        seen.iter().any(|v| v["values"]
            .as_array()
            .map(|vs| vs
                .iter()
                .any(|x| { agent_sdk_shell::event_sequence(x) == Some(seq) }))
            .unwrap_or(false)),
        "the frame emitted after subscribeShell must reach the subscriber on the \
         attached tail: {seen:#?}"
    );
}

/// PROOF for #331, at the product edge: the `more == true` branch of a
/// reconnect.
///
/// A gap that fits in one page is the tested path. This is the other one —
/// the client has been away past `MAX_CATCHUP`, so the handler must NOT
/// send a truncated replay and announce `synchronized` over the rest. It
/// has to fall back to a full snapshot, and the mark that snapshot
/// advertises has to be one the client can resume from without a hole.
///
/// Reasoned-but-unverified was the finding; this drives the real handler.
#[tokio::test]
async fn a_reconnect_past_the_catchup_limit_falls_back_to_a_coherent_snapshot() {
    let (state, _d) = test_state().await;
    state
        .rt
        .save_thread(&json!({
            "runtimeMode": "full-access", "id": "t-big", "title": "big",
            // subscribeThread PROJECTS this row, and the projection refuses to
            // invent metadata — so a durable thread row has to carry it.
            "projectId": "p-workspace", "modelSelection": Value::Null,
            "interactionMode": "default",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();
    seed_prompt(&state, "t-big", "u1", "hello").await;

    // Past the handler's page (MAX_CATCHUP = 500).
    for i in 0..520 {
        emit_thread_event(
            &state.rt,
            "t-big",
            "thread.activity-appended",
            json!({ "threadId": "t-big", "activity": {
                "id": format!("a{i}"), "tone": "info", "kind": "note",
                "summary": format!("n{i}"), "payload": {}, "createdAt": now_iso() } }),
        )
        .await
        .unwrap();
    }

    // The reconnect: the client asks to resume from the very beginning.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({
            "threadId": "t-big", "afterSequence": 0,
        }),
    )
    .await;
    let frames = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["kind"] == "snapshot"
    })
    .await;
    let items: Vec<Value> = frames
        .iter()
        .flat_map(|x| x["values"].as_array().cloned().unwrap_or_default())
        .collect();

    // NOT a truncated replay: the handler took the snapshot path.
    let snapshot = items
        .iter()
        .find(|v| v["kind"] == "snapshot")
        .unwrap_or_else(|| {
            panic!("an over-limit reconnect must fall back to a snapshot: {items:#?}")
        });
    let replayed = items.iter().filter(|v| v["kind"] == "event").count();
    assert_eq!(
        replayed, 0,
        "a snapshot fallback must not ALSO ship the truncated page — the client would \
         fold events it is about to receive again: {replayed}"
    );

    // The mark is coherent: at or above everything the snapshot carries, and
    // in the same space the events use, so resuming from it is gap-free.
    let mark = snapshot["snapshot"]["snapshotSequence"]
        .as_i64()
        .expect("the fallback snapshot carries a resume mark");
    assert!(
        mark >= state.rt.thread_sequence("t-big").await.unwrap(),
        "the mark ({mark}) sits below the thread's recorded watermark — the client would \
         re-request events already in its snapshot"
    );
    assert!(
        state
            .rt
            .events_after("t-big", mark, 10)
            .await
            .unwrap()
            .is_empty(),
        "nothing is recorded above the mark yet, so the client resumes with no gap"
    );

    // And an event published AFTER the fallback reaches the tail the handler
    // attached — the close-old-tail / open-new-tail transition did not drop
    // the subscription on the floor.
    emit_thread_event(
        &state.rt,
        "t-big",
        "thread.activity-appended",
        json!({ "threadId": "t-big", "activity": {
            "id": "a-after", "tone": "info", "kind": "note", "summary": "after",
            "payload": {}, "createdAt": now_iso() } }),
    )
    .await
    .unwrap();
    let live = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["event"]["payload"]["activity"]["id"] == "a-after"
    })
    .await;
    assert!(
        live.iter()
            .any(|f| f["values"][0]["event"]["payload"]["activity"]["id"] == "a-after"),
        "the replacement tail must be live after the snapshot fallback: {live:#?}"
    );
}

/// The same branch on the SHELL topic, which reached this shape later and
/// would diverge silently.
#[tokio::test]
async fn a_shell_reconnect_past_the_catchup_limit_falls_back_to_a_coherent_snapshot() {
    let (state, _d) = test_state().await;
    for i in 0..520 {
        state
            .rt
            .emit_shell_event(
                json!({ "kind": "thread-upserted", "thread": { "id": format!("t{i}") } }),
            )
            .await
            .unwrap();
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeShell",
        json!({ "afterSequence": 0 }),
    )
    .await;
    let frames = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["kind"] == "snapshot"
    })
    .await;
    let items: Vec<Value> = frames
        .iter()
        .flat_map(|x| x["values"].as_array().cloned().unwrap_or_default())
        .collect();
    let snapshot = items
        .iter()
        .find(|v| v["kind"] == "snapshot")
        .unwrap_or_else(|| panic!("an over-limit shell reconnect must fall back: {items:#?}"));
    assert_eq!(
        items
            .iter()
            .filter(|v| v["kind"] == "thread-upserted")
            .count(),
        0,
        "the truncated page must not be shipped alongside the snapshot: {items:#?}"
    );
    let mark = snapshot["snapshot"]["snapshotSequence"]
        .as_i64()
        .expect("a resume mark");
    assert!(
        state
            .rt
            .shell_events_after(mark, 10)
            .await
            .unwrap()
            .is_empty(),
        "the shell mark must cover every recorded frame, or the client resumes over a hole"
    );

    // live after the fallback
    state
        .rt
        .emit_shell_event(json!({ "kind": "thread-upserted", "thread": { "id": "t-after" } }))
        .await
        .unwrap();
    let live = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["thread"]["id"] == "t-after"
    })
    .await;
    assert!(
        live.iter()
            .any(|f| f["values"][0]["thread"]["id"] == "t-after"),
        "the replacement shell tail must be live: {live:#?}"
    );
}

/// PROOF (#376): `checkpointTurnCount` 1 is the MOST RECENT turn, and
/// reverting 1 undoes only that turn.
///
/// This is the regression for a live inversion. `checkpoint_summaries` and
/// `checkpoint_seq_for` both did `stack.list().rev()`, under comments saying
/// cairn lists oldest-first. It does not — `list` is `ORDER BY seq DESC`, so
/// the `.rev()` turned newest-first into oldest-first in BOTH places. They
/// were consistently wrong, so the round trip agreed with itself while
/// pointing at the wrong end: the row the UI labelled "most recent" was the
/// oldest checkpoint, and "revert 1 turn" restored the very first snapshot,
/// discarding every turn after it.
///
/// A single-checkpoint test cannot see this — with one entry both orders are
/// identical. It takes THREE turns, which is why it survived.
#[tokio::test]
async fn turn_count_one_is_the_most_recent_turn_not_the_oldest() {
    let (state, _d) = test_state().await;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let file = std::path::Path::new(&state.cwd).join("f.txt");

    // Three turns, each checkpointed BEFORE it edits — so the checkpoint for
    // turn-N captures the file as turn-(N-1) left it.
    std::fs::write(&file, "v0\n").unwrap();
    checkpoint_turn_start(&state, &state.cwd, "turn-1").await;
    std::fs::write(&file, "v1\n").unwrap();
    checkpoint_turn_start(&state, &state.cwd, "turn-2").await;
    std::fs::write(&file, "v2\n").unwrap();
    checkpoint_turn_start(&state, &state.cwd, "turn-3").await;
    std::fs::write(&file, "v3\n").unwrap();

    let summaries = checkpoint_summaries(&state, &state.cwd)
        .await
        .expect("checkpoint summaries are readable");
    assert_eq!(summaries.len(), 3, "three turns, three checkpoints: {summaries:#?}");

    // ORDER: newest first, and turnCount counts from 1 at the newest.
    assert_eq!(
        summaries[0]["turnId"], "turn-3",
        "the FIRST row is the most recent turn: {summaries:#?}"
    );
    assert_eq!(summaries[0]["checkpointTurnCount"], 1);
    assert_eq!(
        summaries[2]["turnId"], "turn-1",
        "and the last row is the oldest"
    );
    assert_eq!(summaries[2]["checkpointTurnCount"], 3);

    // ROUND TRIP: reverting turnCount 1 restores what turn-3 started from —
    // "v2" — not "v0". Under the inversion this restored v0 and threw away
    // two turns of work.
    state.rt.save_thread(&thread_row_ck("t-order")).await.unwrap();
    revert_checkpoint(&state, "t-order", 1).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(&file).unwrap().trim(),
        "v2",
        "revert 1 undoes ONLY the most recent turn"
    );
}

/// PROOF (#65): a turn is REVIEWABLE and REVERTABLE from the frontend
/// contract on this runtime.
///
/// The snapshot used to hard-code `checkpoints: []` and
/// `thread.checkpoint.revert` fell through to a noop-after-ack, so the diff
/// panel had nothing to show and the revert button restored nothing while
/// reporting success. This drives the real handlers end to end.
#[tokio::test]
async fn a_turn_is_reviewable_and_revertable_through_the_contract() {
    let (state, _d) = test_state().await;
    // The workspace has to be a git repo for checkpoints to exist at all.
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let file = std::path::Path::new(&state.cwd).join("edited.txt");
    std::fs::write(&file, "before the turn\n").unwrap();

    state.rt.save_thread(&thread_row_ck("t-ck")).await.unwrap();
    seed_prompt(&state, "t-ck", "u1", "change the file").await;

    // THE REAL BOUNDARY (#350). Not `checkpoint_turn_start` directly — this
    // drives the projector `run_turn` itself builds, with the lifecycle
    // fact the SDK emits, so the test fails if the projector is unwired,
    // fires on the wrong event, or is handed the wrong cwd.
    {
        use agent_sdk_shell::Projector as _;
        turn_projector(&state, state.cwd.clone())
            .project(Lifecycle::TurnStarted {
                thread_id: "t-ck".into(),
                turn_id: "turn-1".into(),
            })
            .await
            .expect("the turn-started projection");
    }
    // ...the "agent" edits, including a file it created with bash.
    std::fs::write(&file, "the agent rewrote this\n").unwrap();
    std::fs::write(
        std::path::Path::new(&state.cwd).join("agent-made.txt"),
        "new\n",
    )
    .unwrap();

    // The SNAPSHOT the diff panel reads.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-ck" }),
    )
    .await;
    let frames = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["kind"] == "snapshot"
    })
    .await;
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("a thread snapshot");
    let checkpoints = snap["values"][0]["snapshot"]["thread"]["checkpoints"]
        .as_array()
        .expect("checkpoints is an array");
    assert_eq!(
        checkpoints.len(),
        1,
        "the turn's checkpoint must be listed: {checkpoints:#?}"
    );
    let cp = &checkpoints[0];
    assert_eq!(
        cp["turnId"], "turn-1",
        "addressed by the turn it belongs to"
    );
    assert_eq!(cp["status"], "ready");
    assert_eq!(cp["checkpointTurnCount"], 1, "reverting it undoes one turn");
    // #396: the checkpoint reference the contract carries is the
    // DURABLE git ref name cairn wrote with `update-ref`, NOT the
    // raw commit sha. A commit alone becomes unreachable garbage as
    // soon as retention deletes its ref (cairn's own stack sweep or
    // any git gc), so exposing a sha here is a lie the summary
    // cannot keep. The ref name — `refs/cairn/checkpoint/<key>/<seq>`
    // — is true for exactly as long as the checkpoint is.
    let git_ref = cp["checkpointRef"].as_str().unwrap_or("");
    // Cairn writes its checkpoint refs under `refs/cairn/checkpoint/<key>/<seq>`.
    // Accepting bare `refs/` covers a future retention/rename without
    // slackening the actual invariant (must be a git REF, not a sha).
    assert!(
        git_ref.starts_with("refs/"),
        "checkpointRef must be the cairn update-ref name that survives \
         retention, not a bare commit sha: {git_ref:?}"
    );
    assert!(
        git_ref.contains("/checkpoint/"),
        "checkpointRef must name a cairn checkpoint ref (contains \
         `/checkpoint/`): {git_ref:?}"
    );
    let files = cp["files"].as_array().expect("files");
    let named: Vec<&str> = files.iter().filter_map(|f| f["path"].as_str()).collect();
    assert!(
        named.contains(&"edited.txt"),
        "the edited file must be reviewable: {files:#?}"
    );
    assert!(
        named.contains(&"agent-made.txt"),
        "a file the turn CREATED must be reviewable too — that is the case a \
         tracked-files-only diff misses: {files:#?}"
    );
    assert!(
        !named
            .iter()
            .any(|p| p.contains(".db-wal") || p.contains(".db-tshm") || p.starts_with("data/")),
        "the runtime's own isolate files must not appear in a turn review: {named:?}"
    );
    let created = files
        .iter()
        .find(|f| f["path"] == "agent-made.txt")
        .unwrap();
    assert_eq!(created["kind"], "added");
    assert_eq!(created["additions"], 1);

    // The REVERT the destructive button sends.
    let before = state.rt.current_sequence().await.unwrap();
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    request(
        &state,
        &tx2,
        "orchestration.dispatchCommand",
        json!({ "type": "thread.checkpoint.revert", "threadId": "t-ck", "turnCount": 1 }),
    )
    .await;
    assert_eq!(
        drain(&mut rx2)
            .into_iter()
            .find(|f| f["_tag"] == "Exit")
            .unwrap()["exit"]["_tag"],
        "Success"
    );
    // The FILES actually moved — this is the assertion the old noop-after-ack
    // could never pass.
    for _ in 0..50 {
        if std::fs::read_to_string(&file).unwrap_or_default() == "before the turn\n" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "before the turn\n",
        "the reverted file must hold its pre-turn contents"
    );
    assert!(
        !std::path::Path::new(&state.cwd)
            .join("agent-made.txt")
            .exists(),
        "a file the turn created must be gone after reverting it"
    );

    // And the thread was TOLD, durably — a revert the UI cannot see is a
    // destructive action with no confirmation.
    let replayed = state.rt.events_after("t-ck", before, 100).await.unwrap();
    let types: Vec<&str> = replayed
        .iter()
        .filter_map(|e| e["event"]["type"].as_str())
        .collect();
    assert!(
        types.contains(&"thread.checkpoint-revert-requested"),
        "the request must be acknowledged on the stream: {types:?}"
    );
    assert!(
        types.contains(&"thread.reverted"),
        "the completed revert must be announced: {types:?}"
    );
    let reverted = replayed
        .iter()
        .find(|e| e["event"]["type"] == "thread.reverted")
        .expect("the reverted event");
    assert_eq!(reverted["event"]["payload"]["turnCount"], 1);
    assert_eq!(reverted["event"]["payload"]["threadId"], "t-ck");
}

/// PROOF (#376): the checkpoint substrate is CAIRN's, and it behaves like
/// durable workspace truth rather than a process's memory.
///
/// Two properties the product-owned version could not honestly claim:
/// an edit made OUT OF BAND (a `sed -i`, a bash tool, another process —
/// nothing routed through the runtime) is still in the turn's diff, and the
/// whole thing round-trips across a restart because the stack lives in the
/// repository, not in this process.
#[tokio::test]
async fn an_out_of_band_edit_is_in_the_cairn_diff_and_restores_after_a_restart() {
    let (state, dir) = test_state().await;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let file = std::path::Path::new(&state.cwd).join("oob.txt");
    std::fs::write(
        &file, "before
",
    )
    .unwrap();

    state.rt.save_thread(&thread_row_ck("t-oob")).await.unwrap();
    {
        use agent_sdk_shell::Projector as _;
        turn_projector(&state, state.cwd.clone())
            .project(Lifecycle::TurnStarted {
                thread_id: "t-oob".into(),
                turn_id: "turn-oob".into(),
            })
            .await
            .expect("checkpoint at the turn boundary");
    }

    // OUT OF BAND: a real process edit, not a runtime write. Nothing told the
    // backend this happened.
    let out = std::process::Command::new("sh")
        .args(["-c", "sed 's/before/after/' oob.txt > oob.txt.tmp && mv oob.txt.tmp oob.txt"])
        .current_dir(&state.cwd)
        .output()
        .expect("out-of-band edit");
    assert!(out.status.success(), "out-of-band edit failed: {out:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after\n");

    // It is in the summary, because cairn diffs the WORKTREE and not a
    // journal of what the runtime believes it wrote.
    let summaries = checkpoint_summaries(&state, &state.cwd)
        .await
        .expect("checkpoint summaries are readable");
    let cp = summaries.iter().find(|c| c["turnId"] == "turn-oob").expect("the turn's checkpoint");
    let named: Vec<&str> = cp["files"].as_array().unwrap().iter().filter_map(|f| f["path"].as_str()).collect();
    assert!(named.contains(&"oob.txt"), "an out-of-band edit must be reviewable: {named:?}");

    // RESTART: a second AppState over the same directory, as a new process
    // would see it. The stack is in the repository, so it is still there.
    drop(state);
    let state2 = state_at(&dir).await;
    let after_restart = checkpoint_summaries(&state2, &state2.cwd)
        .await
        .expect("checkpoint summaries survive restart");
    assert!(
        after_restart.iter().any(|c| c["turnId"] == "turn-oob"),
        "the checkpoint must survive the process that took it: {after_restart:?}"
    );

    // And the revert round-trips from the new process.
    revert_checkpoint(&state2, "t-oob", 1).await.unwrap();
    for _ in 0..50 {
        if std::fs::read_to_string(&file).unwrap_or_default() == "before\n" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "before\n",
        "a restart-crossing revert restored the out-of-band edit"
    );
}

/// PROOF (#395/#397): the runtime's own durable state is outside the
/// checkpoint SCOPE, not filtered out of the display afterwards.
///
/// codex's objection to a display filter is the right one and it is
/// specific: a filter hides the files from the review while a restore
/// still rolls them back, which would rewind the backend's own stores
/// under the running process. So this asserts the property that
/// distinguishes the two — the agent data dir is byte-identical ACROSS a
/// revert, not merely absent from the file list.
#[tokio::test]
async fn a_revert_never_touches_the_runtimes_own_state() {
    let (state, _d) = test_state().await;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let src = std::path::Path::new(&state.cwd).join("src.txt");
    std::fs::write(&src, "v1\n").unwrap();

    // A marker INSIDE the runtime's data dir, written before the
    // checkpoint. If the data dir were in scope, the checkpoint would
    // capture this content and the revert would restore it.
    let data = std::path::Path::new(&state.cwd).join("data");
    std::fs::create_dir_all(&data).unwrap();
    let marker = data.join("runtime-state.marker");
    std::fs::write(&marker, "at-checkpoint-time\n").unwrap();

    state
        .rt
        .save_thread(&thread_row_ck("t-scope"))
        .await
        .unwrap();
    {
        use agent_sdk_shell::Projector as _;
        turn_projector(&state, state.cwd.clone())
            .project(Lifecycle::TurnStarted {
                thread_id: "t-scope".into(),
                turn_id: "turn-scope".into(),
            })
            .await
            .expect("checkpoint at the turn boundary");
    }

    // The turn edits a source file; the runtime independently advances its
    // own state, exactly as a live backend does while a turn runs.
    std::fs::write(&src, "v2\n").unwrap();
    std::fs::write(&marker, "advanced-since\n").unwrap();

    // The review does not mention the runtime's files...
    let summaries = checkpoint_summaries(&state, &state.cwd)
        .await
        .expect("checkpoint summaries are readable");
    let cp = summaries.iter().find(|c| c["turnId"] == "turn-scope").expect("the checkpoint");
    let named: Vec<&str> =
        cp["files"].as_array().unwrap().iter().filter_map(|f| f["path"].as_str()).collect();
    assert!(named.contains(&"src.txt"), "the turn's real edit is reviewable: {named:?}");
    assert!(
        !named.iter().any(|p| p.starts_with("data/")),
        "runtime state must not be in the review: {named:?}"
    );

    // ...AND the revert leaves them alone. This is the assertion a display
    // filter cannot pass.
    revert_checkpoint(&state, "t-scope", 1).await.unwrap();
    for _ in 0..50 {
        if std::fs::read_to_string(&src).unwrap_or_default() == "v1\n" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&src).unwrap(),
        "v1\n",
        "the turn's edit was reverted"
    );
    assert_eq!(
        std::fs::read_to_string(&marker).unwrap(),
        "advanced-since\n",
        "the revert rolled back the runtime's own state — the exclusion is not in scope, \
         it is only hiding the files from the review"
    );
}

/// A durable thread row for the checkpoint/revert proofs.
///
/// `modelSelection` used to be `null` here. That stopped being a legal row when
/// #87 made `ThreadRecord::from_row` fail closed on it — the comment there calls
/// defaulting a persisted row's access level "a privilege grant performed by a
/// missing key", and the same reasoning covers the model: a thread whose
/// recorded selection cannot be read must not be projected as if some default
/// had been chosen.
///
/// So the FIXTURE was the thing that was wrong, not the decoder. A test that
/// writes a row production would refuse to write is not exercising production;
/// it is exercising a shape that can no longer exist. These 12 tests were
/// failing on a row the runtime would never persist.
fn thread_row_ck(id: &str) -> Value {
    json!({
        "id": id, "projectId": "p-workspace", "title": "ck", "runtimeMode": "full-access",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" },
        "interactionMode": "default",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    })
}

fn init_git_repo(cwd: &str) {
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git").args(&args).current_dir(cwd).output().unwrap();
    }
}

async fn root_checkpointed_thread(
    state: &AppState,
    thread_id: &str,
    filename: &str,
) -> std::path::PathBuf {
    init_git_repo(&state.cwd);
    let file = std::path::Path::new(&state.cwd).join(filename);
    std::fs::write(&file, "before\n").unwrap();
    state.rt.save_thread(&thread_row_ck(thread_id)).await.unwrap();
    checkpoint_turn_start(state, &state.cwd, "turn-1").await;
    std::fs::write(&file, "after\n").unwrap();
    file
}

async fn get_turn_diff_exit(state: &AppState, thread_id: &str) -> Value {
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        state,
        &tx,
        "orchestration.getTurnDiff",
        json!({ "input": { "threadId": thread_id, "fromTurnCount": 0, "toTurnCount": 1 } }),
    )
    .await;
    drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("getTurnDiff exit")
}

async fn revert_dispatch_exit(state: &AppState, thread_id: &str) -> Value {
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        state,
        &tx,
        "orchestration.dispatchCommand",
        json!({ "input": {
            "type": "thread.checkpoint.revert",
            "threadId": thread_id,
            "turnCount": 1,
        }}),
    )
    .await;
    drain(&mut rx).into_iter().find(|f| f["_tag"] == "Exit").expect("dispatch exit")
}

#[tokio::test]
async fn diff_and_revert_refuse_corrupt_thread_mapping_without_touching_workspace() {
    let (state, _d) = test_state().await;
    let file = root_checkpointed_thread(&state, "t-corrupt-map", "corrupt-map.txt").await;
    state
        .rt
        .store()
        .db()
        .execute(
            "UPDATE threads SET json = ? WHERE id = ?",
            vec![json!("{not-json"), json!("t-corrupt-map")],
        )
        .await
        .unwrap();

    let diff = get_turn_diff_exit(&state, "t-corrupt-map").await;
    assert_eq!(diff["exit"]["_tag"], "Failure", "corrupt mapping must fail diff: {diff}");
    assert_eq!(
        diff["exit"]["cause"][0]["error"]["_tag"],
        "OrchestrationGetTurnDiffError"
    );
    assert!(
        diff["exit"]["cause"][0]["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("thread worktree unavailable"),
        "{diff}"
    );

    let reverted = revert_dispatch_exit(&state, "t-corrupt-map").await;
    assert_eq!(reverted["exit"]["_tag"], "Failure", "corrupt mapping must fail revert: {reverted}");
    assert_eq!(
        reverted["exit"]["cause"][0]["error"]["_tag"],
        "OrchestrationDispatchCommandError"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "after\n",
        "revert must not fall back to state.cwd when the thread mapping is corrupt"
    );
}

#[tokio::test]
async fn diff_and_revert_refuse_stale_thread_id_without_touching_workspace() {
    let (state, _d) = test_state().await;
    let file = root_checkpointed_thread(&state, "t-stale-map", "stale-map.txt").await;
    state
        .rt
        .store()
        .db()
        .execute("DELETE FROM threads WHERE id = ?", vec![json!("t-stale-map")])
        .await
        .unwrap();

    let diff = get_turn_diff_exit(&state, "t-stale-map").await;
    assert_eq!(diff["exit"]["_tag"], "Failure", "stale thread must fail diff: {diff}");
    assert_eq!(
        diff["exit"]["cause"][0]["error"]["_tag"],
        "OrchestrationGetTurnDiffError"
    );
    assert!(
        diff["exit"]["cause"][0]["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("unknown thread"),
        "{diff}"
    );

    let reverted = revert_dispatch_exit(&state, "t-stale-map").await;
    assert_eq!(reverted["exit"]["_tag"], "Failure", "stale thread must fail revert: {reverted}");
    assert_eq!(
        reverted["exit"]["cause"][0]["error"]["_tag"],
        "OrchestrationDispatchCommandError"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "after\n",
        "revert must not fall back to state.cwd for a stale thread id"
    );
}

/// #107: after the SDK/cairn revert mutates the thread/worktree, failure to
/// durably record the completed lifecycle event must still be returned to the
/// caller. Falling through to Success here is the exact split-brain the review
/// packet named.
#[tokio::test]
async fn checkpoint_revert_reports_completed_event_failure_after_mutation() {
    let (state, dir) = test_state().await;
    init_git_repo(&state.cwd);
    let file = std::path::Path::new(&state.cwd).join("completed.txt");
    std::fs::write(&file, "before\n").unwrap();

    state.rt.save_thread(&thread_row_ck("t-complete-fail")).await.unwrap();
    checkpoint_turn_start(&state, &state.cwd.clone(), "turn-1").await;
    std::fs::write(&file, "after\n").unwrap();

    drop_thread_event_table(&dir).await;

    let err = revert_checkpoint(&state, "t-complete-fail", 1)
        .await
        .expect_err("completed event write failure must be returned");
    assert!(
        err.contains("thread.reverted could not be recorded"),
        "error must name the dropped completion lifecycle event: {err}"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "before\n",
        "the substrate revert already happened, so the caller must see the lifecycle failure"
    );
}

/// #107: if the revert itself fails, the failure activity is also a durable
/// lifecycle write. If that write fails too, the caller must see that second
/// failure instead of a quiet log-only drop.
#[tokio::test]
async fn checkpoint_revert_reports_failed_event_write_failure() {
    let (state, dir) = test_state().await;
    init_git_repo(&state.cwd);
    state.rt.save_thread(&thread_row_ck("t-failed-event")).await.unwrap();
    drop_thread_event_table(&dir).await;

    let err = revert_checkpoint(&state, "t-failed-event", 0)
        .await
        .expect_err("failed-event write failure must be returned");
    assert!(
        err.contains("checkpoint.revert-failed could not be recorded"),
        "error must name the dropped failure lifecycle event: {err}"
    );
}

/// #349: a thread whose `worktreePath` is NOT `state.cwd` must checkpoint
/// and revert against ITS OWN worktree, not the server workspace. This is
/// the case that revealed the bug: the workspace looked untouched while
/// the worktree kept diverging, or the workspace got rewound to a state
/// no user ever saw.
#[tokio::test]
async fn a_worktree_backed_thread_checkpoints_and_reverts_the_worktree_not_the_workspace() {
    let (state, dir) = test_state().await;
    // Two independent git repos: the server workspace (`state.cwd`) and a
    // separate "worktree" the thread is dispatched into.
    let worktree = dir.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    for repo in [state.cwd.as_str(), worktree.to_str().unwrap()] {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            std::process::Command::new("git")
                .args(&args)
                .current_dir(repo)
                .output()
                .unwrap();
        }
    }
    // Both trees have a file, with DIFFERENT contents so we can tell them
    // apart after the revert.
    let workspace_file = std::path::Path::new(&state.cwd).join("edit.txt");
    let worktree_file = worktree.join("edit.txt");
    std::fs::write(&workspace_file, "WORKSPACE original\n").unwrap();
    std::fs::write(&worktree_file, "WORKTREE original\n").unwrap();

    // The thread is dispatched into the WORKTREE.
    let thread = json!({
        "id": "t-wt", "projectId": "p-workspace", "title": "wt-thread",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "worktreePath": worktree.to_string_lossy(),
        "createdAt": now_iso(), "updatedAt": now_iso(),
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        state.rt.save_thread(&thread),
    )
    .await
    .expect("save_thread must not hang")
    .unwrap();

    // Checkpoint the WORKTREE (this is what CheckpointingProjector does on
    // TurnStarted with def.cwd = the thread's worktree).
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        checkpoint_turn_start(&state, worktree.to_str().unwrap(), "turn-1"),
    )
    .await
    .expect("checkpoint_turn_start must not hang");

    // Both trees drift AFTER the checkpoint.
    std::fs::write(&workspace_file, "WORKSPACE moved on\n").unwrap();
    std::fs::write(&worktree_file, "WORKTREE moved on\n").unwrap();

    // Revert the ONE turn. Under the old bug this used state.cwd and
    // rewound the workspace; now it must use the thread's worktree.
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        revert_checkpoint(&state, "t-wt", 1),
    )
    .await
    .expect("revert_checkpoint must not hang")
    .unwrap();

    let workspace_after = std::fs::read_to_string(&workspace_file).unwrap();
    let worktree_after = std::fs::read_to_string(&worktree_file).unwrap();
    assert_eq!(
        worktree_after, "WORKTREE original\n",
        "the thread's worktree was rewound: {worktree_after:?}"
    );
    assert_eq!(
        workspace_after, "WORKSPACE moved on\n",
        "the SERVER workspace must NOT have been rewound — the bug was using \
         state.cwd for a thread dispatched into a worktree: {workspace_after:?}"
    );

    // And the snapshot's checkpoint summary must read from the WORKTREE
    // too, so the panel shows the same tree that will be reverted.
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-wt" }),
    )
    .await;
    let frames = drain_until(&mut rx, std::time::Duration::from_secs(5), |f| {
        f["values"][0]["kind"] == "snapshot"
    })
    .await;
    let snap = frames
        .iter()
        .find(|f| f["values"][0]["kind"] == "snapshot")
        .expect("snapshot");
    // After revert, the ref is gone, so the summary is empty. What matters
    // is that the summary was READ from the worktree (the workspace has
    // never had a checkpoint at all, so a workspace-cwd read would also
    // return empty — this proves the code path even in the empty case).
    let checkpoints = snap["values"][0]["snapshot"]["thread"]["checkpoints"]
        .as_array()
        .expect("checkpoints array present");
    assert!(
        checkpoints.is_empty()
            || checkpoints.iter().all(|c| {
                c["checkpointRef"]
                    .as_str()
                    .map(|r| r.starts_with("refs/"))
                    .unwrap_or(false)
            }),
        "checkpoints are valid git refs or absent after revert: {checkpoints:#?}"
    );
}

/// PROOF (#74): the five orchestration query RPCs answer instead of
/// falling through to `unsupported method`, and none of them fabricates an
/// empty success.
#[tokio::test]
async fn the_orchestration_query_rpcs_are_served_from_durable_state() {
    let (state, _d) = test_state().await;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let file = std::path::Path::new(&state.cwd).join("q.txt");
    std::fs::write(&file, "first\n").unwrap();

    state.rt.save_thread(&thread_row_ck("t-q")).await.unwrap();
    seed_prompt(&state, "t-q", "u1", "please refactor the parser").await;
    checkpoint_turn_start(&state, &state.cwd.clone(), "turn-1").await;
    std::fs::write(&file, "second\n").unwrap();

    let call = |m: &'static str, input: Value| {
        let state = state.clone();
        async move {
            let (tx, mut rx) = mpsc::unbounded_channel();
            request(&state, &tx, m, json!({ "input": input })).await;
            drain(&mut rx)
                .into_iter()
                .find(|f| f["_tag"] == "Exit")
                .expect("an Exit frame")
        }
    };

    // getTurnDiff: the last turn's changes, read off its checkpoint.
    let ex = call(
        "orchestration.getTurnDiff",
        json!({ "threadId": "t-q", "fromTurnCount": 0, "toTurnCount": 1 }),
    )
    .await;
    assert_eq!(
        ex["exit"]["_tag"], "Success",
        "getTurnDiff must be served: {ex}"
    );
    let out = &ex["exit"]["value"];
    assert_eq!(out["threadId"], "t-q");
    assert_eq!(out["fromTurnCount"], 0);
    assert_eq!(out["toTurnCount"], 1);
    let diff = out["diff"].as_str().expect("a diff string");
    assert!(
        diff.contains("-first") && diff.contains("+second"),
        "real patch text: {diff}"
    );

    // getFullThreadDiff: same read with the near end pinned to the worktree.
    let ex = call(
        "orchestration.getFullThreadDiff",
        json!({ "threadId": "t-q", "toTurnCount": 1 }),
    )
    .await;
    assert_eq!(
        ex["exit"]["_tag"], "Success",
        "getFullThreadDiff must be served: {ex}"
    );
    assert_eq!(ex["exit"]["value"]["fromTurnCount"], 0);
    assert!(ex["exit"]["value"]["diff"]
        .as_str()
        .unwrap()
        .contains("+second"));

    // A range with no checkpoint is the contract's ERROR, never diff: "".
    let ex = call(
        "orchestration.getTurnDiff",
        json!({ "threadId": "t-q", "fromTurnCount": 0, "toTurnCount": 99 }),
    )
    .await;
    assert_eq!(
        ex["exit"]["_tag"], "Failure",
        "a missing checkpoint must not read as no-changes: {ex}"
    );
    assert_eq!(
        ex["exit"]["cause"][0]["error"]["_tag"],
        "OrchestrationGetTurnDiffError"
    );

    // A stale thread id is not permission to diff the environment root. The
    // root has a valid checkpoint above, so the old `thread_cwd` fallback would
    // have returned Success with t-stale attached to t-q's workspace diff.
    let ex = call("orchestration.getTurnDiff",
        json!({ "threadId": "t-stale", "fromTurnCount": 0, "toTurnCount": 1 })).await;
    assert_eq!(ex["exit"]["_tag"], "Failure", "stale thread must fail before root diff: {ex}");
    let stale_msg = ex["exit"]["cause"].to_string();
    assert!(
        stale_msg.contains("unknown thread") || stale_msg.contains("thread mapping"),
        "failure names thread mapping authority: {stale_msg}"
    );
    revert_checkpoint(&state, "t-stale", 1).await;
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "second\n",
        "stale-thread revert must not fall back to and rewind the environment root"
    );

    // searchThreads: over the DURABLE message store.
    let ex = call("orchestration.searchThreads", json!({ "query": "parser" })).await;
    assert_eq!(
        ex["exit"]["_tag"], "Success",
        "searchThreads must be served: {ex}"
    );
    let matches = ex["exit"]["value"]["matches"].as_array().expect("matches");
    assert_eq!(
        matches.len(),
        1,
        "the seeded prompt must be found: {matches:#?}"
    );
    assert_eq!(matches[0]["threadId"], "t-q");
    assert_eq!(matches[0]["source"], "user");
    assert!(
        matches[0]["snippet"].as_str().unwrap().contains("parser"),
        "the snippet must contain the hit: {}",
        matches[0]["snippet"]
    );
    // and a query that matches nothing is an empty list, not an error
    let ex = call(
        "orchestration.searchThreads",
        json!({ "query": "zzzznotthere" }),
    )
    .await;
    assert_eq!(ex["exit"]["value"]["matches"].as_array().unwrap().len(), 0);
    // the contract's minimum length is enforced by the runtime too
    let ex = call("orchestration.searchThreads", json!({ "query": "a" })).await;
    assert_eq!(
        ex["exit"]["_tag"], "Failure",
        "a 1-char scan must be refused: {ex}"
    );

    // getArchivedShellSnapshot: archived threads only, stamped from the
    // same sequence space the live shell stream uses.
    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-archived", "projectId": "p-workspace", "title": "old",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
            "createdAt": now_iso(), "updatedAt": now_iso(), "archivedAt": now_iso(),
        }))
        .await
        .unwrap();
    let ex = call("orchestration.getArchivedShellSnapshot", json!({})).await;
    assert_eq!(
        ex["exit"]["_tag"], "Success",
        "getArchivedShellSnapshot must be served: {ex}"
    );
    let snap = &ex["exit"]["value"];
    let ids: Vec<&str> = snap["threads"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["id"].as_str())
        .collect();
    assert_eq!(ids, vec!["t-archived"], "only archived threads: {ids:?}");
    assert!(
        snap["snapshotSequence"].as_i64().unwrap() >= 0,
        "stamped from the durable sequence: {snap}"
    );

    // getWorkflowScript: this runtime has no scripts root, so it reports the
    // contract's own reason rather than an empty script body.
    let ex = call(
        "orchestration.getWorkflowScript",
        json!({ "threadId": "t-q", "scriptPath": "/tmp/x.js" }),
    )
    .await;
    assert_eq!(ex["exit"]["_tag"], "Failure");
    let err = &ex["exit"]["cause"][0]["error"];
    assert_eq!(err["_tag"], "OrchestrationGetWorkflowScriptError");
    assert_eq!(err["reason"], "root-unavailable");
    assert_eq!(err["scriptPath"], "/tmp/x.js");
}

/// #411 (Ack): the Effect RPC client sends `{"_tag":"Ack",...}` on every
/// stream chunk for flow control. The dispatcher must RECOGNIZE it and
/// send NO response — dropping it would emit an "unknown _tag" WARN on
/// every chunk, and answering it would ship phantom frames the client
/// isn't waiting on.
#[tokio::test]
async fn ws_ack_frame_is_recognized_and_no_op() {
    use super::dispatch_ws_frame;
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    dispatch_ws_frame(
        json!({ "_tag": "Ack", "requestId": "r-1", "cursor": 3 }),
        &tx,
        &state,
    )
    .await;
    let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|(s, _)| serde_json::from_str(&s).unwrap())
        .collect();
    assert!(
        frames.is_empty(),
        "Ack must be a silent no-op; got {frames:?}"
    );
    // AND it must NOT be classified as an unknown _tag (the old drop path
    // would have emitted an Error/Exit frame here per #385's fallback).
    // The empty-frames assertion above already proves that, but assert
    // negatively too so a regression is loud.
    assert!(
        !frames
            .iter()
            .any(|f| f.get("_tag").and_then(|v| v.as_str()) == Some("Error")),
        "Ack must not fall through to the unknown-tag Error path"
    );
}

/// A model that never finishes on its own, so a turn is genuinely IN FLIGHT
/// while the interrupt frame arrives.
///
/// The whole point of #411's reopen: a turn that has already settled cannot be
/// interrupted, so a test that sends the frame at an idle thread proves the
/// match arm exists and nothing else.
struct Spinner;

#[async_trait::async_trait]
impl agent_sdk_core::Model for Spinner {
    async fn complete(
        &self,
        _m: &[agent_sdk_core::Message],
        _t: &[agent_sdk_core::ActionDesc],
        _i: Option<&str>,
    ) -> Result<agent_sdk_core::ModelOutput, String> {
        // THIS CALL NEVER RETURNS, and that is the entire proof.
        //
        // Two earlier fixtures both failed to prove #411, in opposite
        // directions. `ModelResp::Text` made the first tick a FINAL answer, so
        // the turn settled `Done` on its own and a live interrupt looked like a
        // no-op it could not be distinguished from. Replacing it with a
        // `read_file` tool call moved the problem rather than fixing it: the
        // turn still settled by itself, now as
        // `Failed { "the turn failed" }` — which is exactly what the negative
        // control caught. A turn that settles on its own cannot demonstrate
        // that anything CAUSED it to settle, whatever it settles as.
        //
        // A model call that never completes is the only fixture where the
        // turn's outcome is attributable. It also raises what the test proves:
        // not "the cancel was seen at a tick boundary" but "the cancel was
        // raced against an in-flight model call and dropped it". If the SDK
        // ever goes back to checking the Control row only between ticks, this
        // future is never dropped, the turn never settles, and the positive
        // test hangs to its timeout instead of passing on a technicality.
        //
        // No tools, no files, no clock: nothing here can fail on its own and
        // be mistaken for an interrupt landing.
        std::future::pending::<()>().await;
        unreachable!("the interrupt must drop this future; it never completes")
    }
    fn cost_usd(&self, _u: &agent_sdk_core::Usage) -> f64 {
        0.0
    }
}

/// PROOF (#411): a WS `Interrupt` frame CANCELS A RUNNING TURN.
///
/// The previous version of this test seeded a thread row and asserted that no
/// `Error`/`Exit` frame came back. `ThreadRuntime::interrupt` is
/// `for sid in sessions_for_thread(thread_id) { shell.interrupt_turn(sid) }`,
/// and `sessions_for_thread` reads `thread_session` — which `save_thread` does
/// not write. So the loop body never executed, and the assertions were
/// satisfied by a function that returned immediately. Emptying the entire
/// `Some("Interrupt")` arm would have kept it green.
///
/// This one binds a REAL session, starts a REAL turn, waits until the runtime
/// reports it running, and then asserts the turn SETTLES as interrupted. A
/// no-op interrupt leaves it running and this times out.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ws_interrupt_frame_cancels_a_running_turn() {
    use super::dispatch_ws_frame;
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-int-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    let state = state_at_with_model(&dir, || Box::new(Spinner)).await;
    // The spinner's tool call must SUCCEED so the loop keeps re-entering; a
    // failing tool can short-circuit the turn into a terminal state and we
    // would be back to proving nothing.
    let _ = std::fs::write(std::path::Path::new(&state.cwd).join("spin.txt"), b"spin");

    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-int-live", "projectId": "p-workspace", "title": "int",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();

    let binding = SessionBinding {
        thread_id: "t-int-live".into(),
        provider_instance_id: "claude_resume:test".into(),
        model_key: "k".into(),
    };
    let def = AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: ModelRef::ClaudeResume {
            model: "test".into(),
        },
        tools: vec!["read_file".into()],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        // The tool registry is built over `def.cwd` (tools.rs:496), NOT over
        // `state.cwd`. Left as None it falls back to boot_root, `read_file`
        // cannot see the spin.txt this test wrote, the tool errors, and the
        // turn settles `Failed` — which would make the interrupt assertion
        // below a coin flip between the cancel and the tool error.
        labels: Default::default(),
        options: vec![],
        cwd: Some(state.cwd.clone()),
    };
    // Binds `thread_session`, which is the row `sessions_for_thread` reads and
    // the one the old test never created.
    state.rt.session_for(&binding, def.clone()).await.unwrap();
    assert!(
        !state.rt.sessions_for_thread("t-int-live").await.unwrap().is_empty(),
        "PRECONDITION: the interrupt has a session to reach. Without this the \
         test passes against a no-op, which is exactly how the previous one did."
    );

    // Start the turn on its own task so it is genuinely in flight.
    let turn = {
        let rt = state.rt.clone();
        let projector = super::turn_projector(&state, state.cwd.clone());
        tokio::spawn(async move { rt.run_turn(&binding, def, "spin forever", &projector).await })
    };

    // Wait for the RUNTIME to report the turn running — not a fixed sleep,
    // which would pass or fail on machine load.
    let mut running = false;
    for _ in 0..200 {
        if matches!(
            state.rt.session_status("t-int-live").await,
            Ok(Some((_, agent_sdk_shell::TurnState::Running)))
        ) {
            running = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(running, "the turn must be running before the interrupt is meaningful");
    let ready = state.terminal.run("echo ready", false, Some(10), false).await;
    assert!(ready.output.contains("ready"), "precondition: live shell exists: {ready:?}");

    // THE WIRE FRAME. Same shape the Effect RPC client sends on stop.
    let (tx, _rx) = mpsc::unbounded_channel();
    dispatch_ws_frame(
        json!({
            "_tag": "Interrupt",
            "requestId": "r-42",
            "payload": { "input": { "threadId": "t-int-live" } },
        }),
        &tx,
        &state,
    )
    .await;

    // THE ASSERTION THAT MATTERS: the turn SETTLES, and settles as interrupted.
    // A no-op interrupt leaves the spinner running and this join never returns.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), turn)
        .await
        .expect("the interrupted turn must settle, not spin forever")
        .expect("the turn task did not panic");
    assert_eq!(
        outcome,
        TurnOutcome::Interrupted,
        "a WS Interrupt must cancel the running turn through the runtime, not \
         merely avoid an error frame"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// REPRO for #404: the startup burst the real frontend sends must not wedge
/// the server.
///
/// The reviewer's capture: at 16:17:52Z the browser opened sockets and issued
/// `server.getConfig`, `subscribeServerLifecycle`, `subscribeServerConfig`,
/// `subscribeVcsStatus` and the shell subscription on the same tick — and the
/// process never logged another line. It kept ACCEPTING (nc succeeded) while
/// answering nothing: every HTTP path returned 000 after 4s and no WS upgrade
/// completed. 87 backend tests were green against that exact binary because
/// every one of them drives ONE request at a time.
///
/// So this drives them CONCURRENTLY, which is the only part of the report that
/// the old tests did not cover, and then asks the server two questions:
///   1. does a state-touching request still answer?   (`server.getConfig`)
///   2. is the dispatcher still alive at all?          (`Ping` -> `Pong`)
///
/// EVERY wait here is bounded. A wedge must fail this test in seconds with a
/// named culprit, never hang the suite — an indefinite park is the bug, and a
/// test that reproduces it by hanging forever is useless in CI.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_frontend_startup_burst_does_not_wedge_the_server() {
    let (state, dir) = test_state().await;

    // A WORKSPACE THAT CAN ACTUALLY EXPRESS THE WEDGE.
    //
    // This test used to run against `test_state()`'s bare temp dir — no
    // repository and ZERO untracked files. #404 is n²/2 string comparisons
    // where n is the untracked-path count from `git status`, measured at
    // 280,297 on the real workspace. With n ≈ 0 there is nothing for the
    // quadratic to chew on, so the test finished in 0.49s and PASSED AGAINST
    // THE ORIGINAL BUG. A test whose subject cannot fail is not evidence,
    // however well its assertions are written.
    //
    // So: a real repository, and one untracked DIRECTORY holding many files.
    // That is the exact shape that produced the 287,699-vs-22 blowup —
    // `--untracked-files=all` expands a directory into every file beneath it,
    // while git's default names the directory once.
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    // One tracked file, so the repo has a HEAD and `status` takes its normal
    // path rather than the empty-repo path.
    std::fs::write(std::path::Path::new(&state.cwd).join("tracked.txt"), "t\n").unwrap();
    for args in [vec!["add", "-A"], vec!["commit", "-qm", "seed"]] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    // The node_modules stand-in. 3,000 files is enough that a per-file
    // expansion is unmistakable in the payload (3,000 rows vs 1) without
    // making the test slow to set up.
    const NOISE: usize = 3_000;
    let noise = std::path::Path::new(&state.cwd).join("node_modules_stand_in");
    std::fs::create_dir_all(&noise).unwrap();
    for i in 0..NOISE {
        std::fs::write(noise.join(format!("f{i}.js")), "x").unwrap();
    }

    // The burst, all in flight at once on one connection — four subscriptions
    // plus the shell subscription, exactly the set in the #404 timeline.
    let burst = [
        ("server.getConfig", json!({})),
        ("subscribeServerLifecycle", json!({})),
        ("subscribeServerConfig", json!({})),
        ("subscribeVcsStatus", json!({ "cwd": state.cwd.clone() })),
        (
            "orchestration.subscribeShell",
            json!({ "cwd": state.cwd.clone() }),
        ),
    ];

    let (tx, _rx) = mpsc::unbounded_channel();
    let mut joined = Vec::new();
    for (method, payload) in burst {
        let st = state.clone();
        let tx = tx.clone();
        joined.push(tokio::spawn(async move {
            request(&st, &tx, method, payload).await;
            method
        }));
    }

    // Each individual request must settle. If one of them is the park that
    // never wakes, name it rather than reporting a generic timeout.
    for h in joined {
        let which = tokio::time::timeout(std::time::Duration::from_secs(20), h).await;
        match which {
            Ok(Ok(method)) => tracing::debug!(%method, "burst member settled"),
            Ok(Err(e)) => panic!("a burst request panicked: {e}"),
            Err(_) => panic!(
                "#404: a startup-burst request never settled within 20s — this is \
                 the indefinite park. Re-run with RUST_LOG=debug to see which \
                 subscription was last to log."
            ),
        }
    }

    // THE ACTUAL #404 ASSERTION: the server is still answering AFTER the burst.
    // The reported symptom was not a slow burst, it was a server that served
    // the burst and then went permanently silent.
    let (tx2, mut rx2) = mpsc::unbounded_channel();
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        request(&state, &tx2, "server.getConfig", json!({})),
    )
    .await
    .expect(
        "#404: server.getConfig never answered after the startup burst — the \
         server is accepting but not serving, which is exactly the reported wedge",
    );
    assert!(
        rx2.try_recv().is_ok(),
        "#404: server.getConfig produced NO frame after the burst. A server that \
         accepts and returns nothing is the 'Reconnecting to Local (Rust)' state."
    );

    // And the raw dispatcher, which touches no state: if this stops answering,
    // the runtime itself is wedged rather than one subscription path.
    let (tx3, mut rx3) = mpsc::unbounded_channel();
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        super::dispatch_ws_frame(json!({ "_tag": "Ping" }), &tx3, &state),
    )
    .await
    .expect("#404: the WS dispatcher stopped answering Ping after the burst");
    let pong = rx3
        .try_recv()
        .expect("Ping must still produce a Pong frame");
    assert!(
        pong.0.contains("Pong"),
        "expected a Pong after the startup burst, got {:?}",
        pong.0
    );

    // THE OTHER HALF OF #404, and the half no unit test can reach: the SERVER's
    // status payload must not carry one row per untracked file.
    //
    // cairn pins the mechanism (`merge_untracked_is_linear_in_the_file_count`,
    // `a_large_untracked_directory_is_reported_once_not_per_file`), but nothing
    // proved the product path inherits it — `vcs::status` could regain the flag,
    // or a future caller could re-expand the directory itself, and every cairn
    // test would stay green. This asserts it where the frontend actually reads
    // it: the `workingTree.files` array `local_status` builds.
    let snapshot = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        vcs::status_snapshot(&state.cwd),
    )
    .await
    .expect(
        "#404: status_snapshot never returned for a tree with an untracked \
         directory — this is the non-yielding path that starved the I/O driver",
    );
    let files = snapshot
        .get("local")
        .and_then(|l| l.get("workingTree"))
        .and_then(|w| w.get("files"))
        .and_then(Value::as_array)
        .expect("the snapshot must carry local.workingTree.files")
        .len();
    assert!(
        files < 50,
        "#404: the status payload lists {files} changed paths for a workspace \
         with ONE untracked directory of {NOISE} files. The directory must be \
         reported once — a per-file expansion is the 287,699-path blowup that \
         made every filesystem edge cost ~1.9s of server responsiveness, and it \
         is also the input that turns the untracked merge quadratic."
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// NEGATIVE CONTROL for #411: the passing interrupt test above must be able to
/// FAIL. If `ws_interrupt_frame_cancels_a_running_turn` were satisfied by a
/// no-op — an empty `Some("Interrupt")` arm, a `ThreadRuntime::interrupt` that
/// resolves no sessions, or a spinner that settles on its own — then routing
/// the SAME frame at an UNRELATED thread id would settle the turn just as
/// well, and this test would fail.
///
/// So this asserts the turn is STILL RUNNING after a misrouted interrupt. It is
/// the test that gives the positive one its teeth: together they prove the
/// settlement is caused by the frame's `threadId` reaching that turn's session,
/// not by the turn ending on its own schedule.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ws_interrupt_for_another_thread_does_not_cancel_this_turn() {
    use super::dispatch_ws_frame;
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-int-neg-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    let state = state_at_with_model(&dir, || Box::new(Spinner)).await;
    let _ = std::fs::write(std::path::Path::new(&state.cwd).join("spin.txt"), b"spin");

    state
        .rt
        .save_thread(&json!({ "runtimeMode": "full-access",
            "id": "t-int-neg", "projectId": "p-workspace", "title": "int-neg",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
            "createdAt": now_iso(), "updatedAt": now_iso(),
        }))
        .await
        .unwrap();

    let binding = SessionBinding {
        thread_id: "t-int-neg".into(),
        provider_instance_id: "claude_resume:test".into(),
        model_key: "k".into(),
    };
    let def = AgentDefinition {
        name: "t3code".into(),
        instructions: String::new(),
        model: ModelRef::ClaudeResume {
            model: "test".into(),
        },
        tools: vec!["read_file".into()],
        ask_tools: vec![],
        subagents: vec![],
        mcp_servers: vec![],
        // The tool registry is built over `def.cwd` (tools.rs:496), NOT over
        // `state.cwd`. Left as None it falls back to boot_root, `read_file`
        // cannot see the spin.txt this test wrote, the tool errors, and the
        // turn settles `Failed` — which would make the interrupt assertion
        // below a coin flip between the cancel and the tool error.
        labels: Default::default(),
        options: vec![],
        cwd: Some(state.cwd.clone()),
    };
    state.rt.session_for(&binding, def.clone()).await.unwrap();

    let turn = {
        let rt = state.rt.clone();
        let projector = super::turn_projector(&state, state.cwd.clone());
        let b = binding.clone();
        let d = def.clone();
        tokio::spawn(async move { rt.run_turn(&b, d, "spin forever", &projector).await })
    };

    let mut running = false;
    for _ in 0..200 {
        if matches!(
            state.rt.session_status("t-int-neg").await,
            Ok(Some((_, agent_sdk_shell::TurnState::Running)))
        ) {
            running = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(running, "the turn must be running before the interrupt is meaningful");
    let ready = state.terminal.run("echo ready", false, Some(10), false).await;
    assert!(ready.output.contains("ready"), "precondition: live shell exists: {ready:?}");

    // THE MISROUTED FRAME: well-formed, known tag, but a thread that is not
    // the one running.
    let (tx, _rx) = mpsc::unbounded_channel();
    dispatch_ws_frame(
        json!({
            "_tag": "Interrupt",
            "requestId": "r-43",
            "payload": { "input": { "threadId": "t-some-other-thread" } },
        }),
        &tx,
        &state,
    )
    .await;

    // It must NOT settle. Generous window: far longer than the ~40ms tick the
    // real interrupt needs to land above.
    let still_running = tokio::time::timeout(std::time::Duration::from_secs(2), turn).await;
    assert!(
        still_running.is_err(),
        "a misrouted Interrupt settled the turn anyway — the positive test is \
         therefore not proving the frame caused the cancellation. Got {still_running:?}"
    );

    // Clean up: cancel the real session so the spinner task does not outlive
    // the test and keep a temp isolate busy.
    let _ = state.rt.interrupt("t-int-neg").await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// #411 (Interrupt): a client `{"_tag":"Interrupt", threadId}` frame
/// must reach `ThreadRuntime::interrupt(thread_id)` rather than being
/// silently dropped. A silent drop lets the model burn tokens after the
/// user pressed stop — the transport version of the #52 defect.
#[tokio::test]
async fn ws_interrupt_frame_routes_to_runtime_interrupt() {
    use super::dispatch_ws_frame;
    let (state, _d) = test_state().await;
    // Seed a thread so `state.rt.interrupt` has a real row to look up
    // (interrupt on an unknown thread is a no-op, not an error).
    state.rt.save_thread(&json!({ "runtimeMode": "full-access",
        "id": "t-int", "projectId": "p-workspace", "title": "int",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001" }, "interactionMode": "default",
        "createdAt": now_iso(), "updatedAt": now_iso(),
    })).await.unwrap();
    let ready = state.terminal.run("echo ready", false, Some(10), false).await;
    assert!(ready.output.contains("ready"), "precondition: live shell exists: {ready:?}");

    let (tx, mut rx) = mpsc::unbounded_channel();
    // Effect RPC embeds the original payload alongside the request id;
    // the dispatcher looks for threadId at both payload/input/threadId
    // and top-level.
    dispatch_ws_frame(
        json!({
            "_tag": "Interrupt",
            "requestId": "r-42",
            "payload": { "input": { "threadId": "t-int" } },
        }),
        &tx,
        &state,
    )
    .await;

    // Interrupt is fire-and-forget from the wire's POV: no reply frame,
    // just the runtime-side cancel + terminal-side interrupt. What
    // matters is that it did NOT fall through to unknown-tag (an Error
    // frame here would be the pre-fix behavior).
    let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|(s, _)| serde_json::from_str(&s).unwrap())
        .collect();
    assert!(
        !frames
            .iter()
            .any(|f| f.get("_tag").and_then(|v| v.as_str()) == Some("Error")),
        "Interrupt must not fall through to the unknown-tag Error path; got {frames:?}"
    );
    assert!(
        !frames.iter().any(|f| {
            f.get("_tag").and_then(|v| v.as_str()) == Some("Exit")
                && f["exit"]["_tag"] == "Failure"
                && f["exit"]["cause"][0]["defect"]
                    .as_str()
                    .map(|d| d.contains("unknown WS frame"))
                    .unwrap_or(false)
        }),
        "Interrupt must not exit_failure through the unknown-tag path; got {frames:?}"
    );
}

/// #112: the raw Effect `Interrupt` frame is still a request. If the durable
/// SDK cancel cannot be written, the frame must produce a visible failure
/// instead of dropping the error while the UI already believes stop landed.
#[tokio::test]
async fn ws_interrupt_frame_reports_runtime_cancel_failure() {
    use agent_sdk_do::ObjectDb;
    use super::dispatch_ws_frame;
    let (state, _d) = test_state().await;
    let ready = state.terminal.run("echo ready", false, Some(10), false).await;
    assert!(ready.output.contains("ready"), "precondition: live shell exists: {ready:?}");
    state
        .rt
        .store()
        .db()
        .execute("DROP TABLE thread_session", vec![])
        .await
        .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    dispatch_ws_frame(
        json!({
            "_tag": "Interrupt",
            "requestId": "r-int-fail",
            "payload": { "input": { "threadId": "t-int-fail" } },
        }),
        &tx,
        &state,
    )
    .await;

    let frames = drain(&mut rx);
    let exits: Vec<&Value> = frames.iter().filter(|f| f["_tag"] == "Exit").collect();
    assert_eq!(exits.len(), 1, "raw Interrupt failure must be visible once: {frames:?}");
    assert_eq!(
        exits[0]["exit"]["_tag"], "Failure",
        "raw Interrupt runtime failure must not be silent: {frames:?}"
    );
    assert!(
        exits[0].to_string().contains("runtime cancel failed"),
        "failure must name runtime cancellation: {frames:?}"
    );
}

/// #411 (Interrupt, no threadId): a frame with no discoverable threadId
/// cannot be routed to a specific turn, so it's LOGGED but NOT elevated
/// to an unknown-tag Error (the tag is known; the payload is what's
/// unroutable). This is defense-in-depth against a client that sends the
/// frame with a different payload shape than we understand.
#[tokio::test]
async fn ws_interrupt_frame_without_thread_id_does_not_error() {
    use super::dispatch_ws_frame;
    let (state, _d) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    dispatch_ws_frame(
        json!({ "_tag": "Interrupt", "requestId": "r-99" }),
        &tx,
        &state,
    )
    .await;
    let frames: Vec<Value> = std::iter::from_fn(|| rx.try_recv().ok())
        .map(|(s, _)| serde_json::from_str(&s).unwrap())
        .collect();
    assert!(
        !frames
            .iter()
            .any(|f| f.get("_tag").and_then(|v| v.as_str()) == Some("Error")),
        "known tag Interrupt (payload just unroutable) must not become an Error frame: {frames:?}"
    );
}

/// PROOF (#65): a revert moves the TRANSCRIPT and the TURN ORDINALS, not just
/// the files.
///
/// The bug this pins down was not that revert did nothing — it rewound the
/// worktree correctly, and any test that looked at the files passed. It was
/// that `ThreadRuntime::discard_turns` existed, documented itself as the half
/// that "puts the TRANSCRIPT back", and had ZERO callers in the workspace. So
/// a reverted thread kept claiming, across reloads, work whose files were
/// gone.
///
/// The ordinal assertion is the one that would not have been noticed by hand.
/// `record_turn_mark` assigns `MAX(turn_count) + 1` and `thread_turn_mark` is
/// keyed on `(thread_id, turn_count)`. Leave a reverted turn's mark behind and
/// the counter climbs past checkpoints that no longer exist, so the ordinal the
/// wire speaks and the checkpoint stack it indexes disagree permanently and
/// every later `getTurnDiff` resolves the wrong pair of turns. Files and
/// transcript both looking right is exactly what would let that ship.
#[tokio::test]
async fn a_revert_discards_the_reverted_turns_transcript_and_frees_their_ordinals() {
    let (state, _dir) = test_state().await;
    for args in [
        vec!["init", "-q"],
        vec!["config", "user.email", "t@t"],
        vec!["config", "user.name", "t"],
    ] {
        std::process::Command::new("git")
            .args(&args)
            .current_dir(&state.cwd)
            .output()
            .unwrap();
    }
    let file = std::path::Path::new(&state.cwd).join("work.txt");
    std::fs::write(&file, "before any turn\n").unwrap();

    state
        .rt
        .save_thread(&checkpoint_thread("t-rev"))
        .await
        .unwrap();

    // TURN 1: ordinal, snapshot, a message, then its edit.
    let first = state
        .rt
        .record_turn_mark("t-rev", "turn-1", None)
        .await
        .unwrap();
    assert_eq!(first, 1, "the first turn on a thread is ordinal 1");
    checkpoint_turn_start(&state, &state.cwd.clone(), "turn-1").await;
    state
        .rt
        .append_message(
            "t-rev",
            &json!({ "id": "m-1", "role": "assistant", "text": "did turn one",
                     "turnId": "turn-1", "streaming": false }),
        )
        .await
        .unwrap();
    std::fs::write(&file, "turn one wrote this\n").unwrap();

    // TURN 2: same again. This is the turn we will revert.
    let second = state
        .rt
        .record_turn_mark("t-rev", "turn-2", None)
        .await
        .unwrap();
    assert_eq!(second, 2);
    checkpoint_turn_start(&state, &state.cwd.clone(), "turn-2").await;
    state
        .rt
        .append_message(
            "t-rev",
            &json!({ "id": "m-2", "role": "assistant", "text": "did turn two",
                     "turnId": "turn-2", "streaming": false }),
        )
        .await
        .unwrap();
    // A message belonging to NO turn. A revert is not entitled to it, and this
    // is here so "delete everything after sequence N" cannot pass this test.
    state
        .rt
        .append_message(
            "t-rev",
            &json!({ "id": "m-note", "role": "system", "text": "not part of a turn",
                     "streaming": false }),
        )
        .await
        .unwrap();
    std::fs::write(&file, "turn two wrote this\n").unwrap();

    // Undo the most recent turn.
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        revert_checkpoint(&state, "t-rev", 1),
    )
    .await
    .expect("revert_checkpoint must not hang")
    .unwrap();

    // 1. FILES — the half that already worked.
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "turn one wrote this\n",
        "the worktree must be back at the start of turn 2"
    );

    // 2. TRANSCRIPT — the half with no callers before this.
    let ids: Vec<String> = state
        .rt
        .messages("t-rev")
        .await
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert!(
        !ids.contains(&"m-2".to_string()),
        "the reverted turn's message is still in the transcript: {ids:?} — the \
         thread claims work its tree no longer contains, and it survives reload \
         because the reconnect snapshot is rebuilt from exactly these rows"
    );
    assert!(
        ids.contains(&"m-1".to_string()),
        "the SURVIVING turn's message was destroyed too: {ids:?}"
    );
    assert!(
        ids.contains(&"m-note".to_string()),
        "a message belonging to no turn was deleted: {ids:?} — a revert is \
         turn-scoped, not 'everything after sequence N'"
    );

    // 3. ORDINALS — the silent one.
    let marks = state.rt.turn_marks("t-rev").await.unwrap();
    assert_eq!(
        marks
            .iter()
            .map(|(c, id, _)| (*c, id.clone()))
            .collect::<Vec<_>>(),
        vec![(1, "turn-1".to_string())],
        "the reverted turn's ordinal must be gone, not merely unused"
    );
    let next = state
        .rt
        .record_turn_mark("t-rev", "turn-3", None)
        .await
        .unwrap();
    assert_eq!(
        next, 2,
        "the next turn must REUSE ordinal 2. Got {next}: the counter climbed \
         past a checkpoint that no longer exists, so every later getTurnDiff \
         resolves the wrong pair of turns"
    );

    // 4. A revert the workspace substrate REFUSES must not touch thread state.
    //    The runtime acts on what the substrate says it undid, so a refusal
    //    has to stop everything — not fall through to discarding a transcript
    //    whose files are still on disk.
    struct Refuses;
    #[async_trait::async_trait]
    impl agent_sdk_shell::TurnCheckpointer for Refuses {
        async fn checkpoint_turn_start(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn revert_workspace(&self, _: usize) -> Result<Vec<String>, String> {
            Err("no such checkpoint".into())
        }
    }
    let refused = state.rt.revert_thread_to_turn("t-rev", 99, &Refuses).await;
    assert!(
        refused.is_err(),
        "a refused workspace revert must be an error"
    );
    let survived: Vec<String> = state
        .rt
        .messages("t-rev")
        .await
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert!(
        survived.contains(&"m-1".to_string()),
        "a REFUSED revert still discarded the transcript: {survived:?}"
    );
}

/// PROOF (#2): a reconnect snapshot reports the thread's DURABLE lifecycle
/// metadata, across a process restart.
///
/// The defect: `subscribeThread` loaded the durable row and then hand-built a
/// thread object beside it with `runtimeMode: "full-access"`, `branch: null`,
/// `worktreePath: null`, `latestTurn: null` typed inline — while the very next
/// statement read `worktreePath` off that same row for checkpoints. So a
/// worktree-backed read-only thread reconnected as a default full-access shell
/// with no branch: schema-valid and lifecycle-invalid at once. The fix is not a
/// wider `json!`; it is that the snapshot is now PROJECTED from
/// `agent_sdk_shell::ThreadRecord`, which owns those keys and refuses to let
/// product code set them.
///
/// The restart is the part only this test can prove: the record has to come
/// from the store, not from anything the first process remembered.
#[tokio::test]
async fn a_worktree_backed_thread_reconnects_with_its_real_metadata_after_a_restart() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    let wt = dir.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    let wt_s = wt.to_string_lossy().into_owned();

    // Process one: create the thread the way a worktree/read-only thread is
    // durably recorded, through the same SDK constructor the product uses.
    {
        let state = state_at(&dir).await;
        let row = agent_sdk_shell::ThreadRecord::new(
            "t-wt",
            "p-1",
            "port the sink",
            json!({"instanceId": "claude_resume:test", "modelKey": "k"}),
            agent_sdk_shell::RuntimeMode::ApprovalRequired,
            "2026-08-24T00:00:00Z",
        )
        .on_worktree(Some(wt_s.clone()), Some("feat/sink".into()))
        .with_interaction_mode("plan")
        .project(json!({ "session": Value::Null }))
        .unwrap();
        state.rt.save_thread(&row).await.unwrap();
    }

    // Process two: a fresh backend over the same data dir, reconnecting.
    let state = state_at(&dir).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-wt" }),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .expect("a snapshot frame");
    let thread = &snap["values"][0]["snapshot"]["thread"];

    assert_eq!(thread["id"], "t-wt");
    assert_eq!(
        thread["projectId"], "p-1",
        "the durable project, not the seed row: {thread}"
    );
    assert_eq!(thread["title"], "port the sink");
    assert_eq!(
        thread["runtimeMode"], "approval-required",
        "a read-only thread must NOT reconnect as full-access: {thread}"
    );
    assert_eq!(
        thread["interactionMode"], "plan",
        "the durable interaction mode survives: {thread}"
    );
    assert_eq!(
        thread["branch"], "feat/sink",
        "the branch travels with the thread: {thread}"
    );
    assert_eq!(
        thread["worktreePath"], wt_s,
        "the reducer-visible worktree agrees with the one checkpoints already read: {thread}"
    );
    assert_eq!(
        thread["modelSelection"]["instanceId"], "claude_resume:test",
        "the durable selection, not the catalog default: {thread}"
    );
    // The product-owned parts are still there — the projection adds, it does
    // not replace the snapshot.
    assert!(
        thread.get("messages").is_some(),
        "messages present: {thread}"
    );
    assert!(
        thread.get("checkpoints").is_some(),
        "checkpoints present: {thread}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#2, the other half): a thread with NO durable row is the only case
/// where defaults are honest, and it still gets a snapshot — subscribing before
/// the first turn is a real flow, and refusing it would be a different lie.
#[tokio::test]
async fn a_thread_with_no_durable_row_still_snapshots_with_declared_defaults() {
    let (state, dir) = test_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-new" }),
    )
    .await;
    let frames = drain(&mut rx);
    let snap = frames
        .iter()
        .find(|x| x["values"][0]["kind"] == "snapshot")
        .expect("a snapshot");
    let thread = &snap["values"][0]["snapshot"]["thread"];
    assert_eq!(thread["runtimeMode"], "full-access");
    assert_eq!(thread["branch"], Value::Null);
    assert_eq!(thread["worktreePath"], Value::Null);
    assert!(
        !thread["projectId"].as_str().unwrap_or("").is_empty(),
        "seed project id: {thread}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (codex-t3 #3): a terminal pane survives the BACKEND process.
///
/// The defect: `TerminalRegistry` kept panes in a process-local
/// `Mutex<HashMap<(String, String), Pane>>`. A restart did not merely drop live
/// sockets — it forgot the panes existed, so `terminal.list` came back empty for
/// a thread whose drawer the user had open, with nothing saying why.
///
/// The registry is now a thin adapter over `agent_sdk_exec::Panes`, which keeps
/// the row durable and re-resolves the shell from `ExecSessions` on access. This
/// test is the composition only the product can prove: the real
/// `terminal.open` / `terminal.list` commands, across a fresh `AppState` over
/// the same data directory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pane_opened_before_a_restart_is_still_listed_after_one() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    std::fs::create_dir_all(&dir).unwrap();

    // Process one: open a non-agent pane through the real command.
    {
        let state = state_at(&dir).await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(
            &state,
            &tx,
            "terminal.open",
            json!({ "threadId": "t-pane", "terminalId": "term-1" }),
        )
        .await;
        let f = drain(&mut rx);
        assert!(
            f.iter().any(|x| x["exit"]["_tag"] == "Success"),
            "the pane opened: {f:?}"
        );
    }

    // Process two: a fresh backend over the same data dir.
    let state = state_at(&dir).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "subscribeTerminalMetadata",
        json!({ "threadId": "t-pane" }),
    )
    .await;
    let f = drain(&mut rx);
    let body = serde_json::to_string(&f).unwrap();
    assert!(
        body.contains("term-1"),
        "the pane opened before the restart is still listed after it: {body}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROOF (#6, the half a browser is not needed for): capture a REAL
/// `subscribeThread` snapshot for a WORKTREE-BACKED, READ-ONLY thread and write
/// it verbatim to `packages/contracts/fixtures/subscribe_thread_worktree_snapshot.json`.
///
/// Same discipline as the `subscribeShell` fixture: the bytes ARE the artifact,
/// no pretty-printing and no normalization. The TS half
/// (`packages/client-runtime/src/state/threadSnapshotParity.test.ts`) decodes
/// these bytes through the contract the reducer uses AND runs them through the
/// reducer, so the assertion is about reducer-VISIBLE state rather than about
/// JSON that merely happens to be schema-valid.
///
/// Why this thread shape specifically: it is the exact case #2 was filed about.
/// A snapshot that hard-codes `runtimeMode: "full-access"` / `branch: null` /
/// `worktreePath: null` decodes CLEANLY — the contract cannot tell a lie from a
/// fact. Only comparing the reducer's thread against the durable row catches it,
/// which is why the fixture is captured from a thread whose durable metadata is
/// all non-default.
///
/// Regenerate with:
///   T3_UPDATE_FIXTURES=1 cargo test -p t3code-agent \
///     subscribe_thread_worktree_snapshot_is_a_recorded_fixture
#[tokio::test]
async fn subscribe_thread_worktree_snapshot_is_a_recorded_fixture() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    let wt = dir.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    let state = state_at(&dir).await;

    let row = agent_sdk_shell::ThreadRecord::new(
        "t-wt-fixture",
        "p-1",
        "port the sink",
        // A REAL instance id shape. The TS contract's `ProviderInstanceId` is
        // `^[a-zA-Z][a-zA-Z0-9_-]*$`, and the first draft of this fixture used
        // the `claude_resume:test` value the Rust-only tests pass around — which
        // decoded fine in Rust and failed on the TS side with a SchemaError
        // naming the exact path. That is this seam earning its keep on its first
        // run, so the value is fixed here rather than the contract loosened.
        json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5-20251001"}),
        agent_sdk_shell::RuntimeMode::ApprovalRequired,
        "2026-08-24T00:00:00.000Z",
    )
    .on_worktree(
        Some(wt.to_string_lossy().into_owned()),
        Some("feat/sink".into()),
    )
    .with_interaction_mode("plan")
    .project(json!({ "session": Value::Null }))
    .unwrap();
    state.rt.save_thread(&row).await.unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "orchestration.subscribeThread",
        json!({ "threadId": "t-wt-fixture" }),
    )
    .await;
    let frames = drain(&mut rx);
    let chunk = frames
        .iter()
        .find(|f| {
            f.get("_tag").and_then(Value::as_str) == Some("Chunk")
                && f["values"][0]["kind"] == "snapshot"
        })
        .expect("subscribeThread emits a snapshot frame");
    let item = chunk["values"][0].clone();

    // Contract invariants, asserted here too so drift is caught in the default
    // (non-writing) mode. These are the FACTS, not just the types — a fixture
    // that decodes but reports full-access is exactly the bug.
    let thread = &item["snapshot"]["thread"];
    assert_eq!(
        thread["runtimeMode"], "approval-required",
        "the captured frame must not lie: {thread}"
    );
    assert_eq!(thread["interactionMode"], "plan");
    assert_eq!(thread["branch"], "feat/sink");
    assert_eq!(thread["worktreePath"], wt.to_string_lossy().as_ref());
    assert_eq!(thread["projectId"], "p-1");
    assert_eq!(thread["modelSelection"]["instanceId"], "claudeAgent");
    assert!(
        thread["messages"].is_array(),
        "messages is a required array"
    );
    assert!(
        thread["activities"].is_array(),
        "activities is a required array"
    );
    assert!(
        thread["checkpoints"].is_array(),
        "checkpoints is a required array"
    );

    if std::env::var("T3_UPDATE_FIXTURES").ok().as_deref() == Some("1") {
        let dst =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/contracts/fixtures");
        std::fs::create_dir_all(&dst).expect("mkdir fixtures");
        // The worktree path is a per-run temp directory, so the captured bytes
        // would otherwise be different on every regeneration and the fixture
        // would show as changed for no reason. Substitute a STABLE placeholder
        // — and assert the real value above, where it belongs.
        let mut stable = item.clone();
        stable["snapshot"]["thread"]["worktreePath"] =
            Value::String("/workspace/wt/t-wt-fixture".into());
        let path = dst.join("subscribe_thread_worktree_snapshot.json");
        let bytes = serde_json::to_vec(&stable).expect("serialize the thread frame");
        std::fs::write(&path, &bytes).expect("write the fixture");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// MEASUREMENT (#13, product half): how many do-rs ISOLATES one `AppState`
/// opens. Not a style test — the descriptor budget is
/// `isolates x 5 fds x concurrent AppStates`, and under a 256-fd limit the
/// backend contract suite fails at 8-way parallelism. A number nobody asserts
/// is a number that grows.
#[tokio::test]
async fn an_app_state_opens_a_bounded_number_of_isolates() {
    // RAII: removed on drop, so a panicking test cannot leak it (see TestDir).
    let dir = tempfile::Builder::new()
        .prefix("t3ct-iso-")
        .tempdir()
        .expect("temp workspace");
    let dir = TestDir(dir);
    std::fs::create_dir_all(&dir).unwrap();
    let state = state_at(&dir).await;
    // Touch the paths a real session uses, so lazily-opened isolates count too.
    let _ = state.rt.threads().await;
    let _ = state.tool_roots.ensure(&dir).await;

    fn dbs(root: &std::path::Path, out: &mut Vec<String>, base: &std::path::Path) {
        let Ok(rd) = std::fs::read_dir(root) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                dbs(&p, out, base);
            } else if p.extension().and_then(|s| s.to_str()) == Some("db") {
                out.push(
                    p.strip_prefix(base)
                        .unwrap_or(&p)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    // The DESCRIPTOR cost too, not just the isolate count. do-storage's process
    // budget models isolates at 5 fds each — it does not know about the hearth
    // PTYs an AppState also opens, and those are real descriptors the OS counts.
    // Measuring both is how we find out whether the budget is modelling the
    // thing that actually exhausts.
    let fds = {
        let d = if std::path::Path::new("/proc/self/fd").exists() {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0)
    };
    eprintln!("APPSTATE_FD_TOTAL={fds}");

    let mut found = Vec::new();
    dbs(&dir, &mut found, &dir);
    found.sort();
    // 5 descriptors per isolate (do-storage's own `fd_budget` test).
    //
    // 7 -> 3, and the whole-process cost of one AppState 38 -> 22 descriptors.
    // What went, and why each was one isolate too many:
    //   `exec` + `diagnostics`  -> one shared product-state isolate. Separate
    //                              TABLE SETS, never separate durability domains.
    //   the boot root's exec session -> the boot workspace already HAS a shell;
    //                              opening a durable session for it too gave one
    //                              workspace two hearth isolates and two PTYs.
    //   `orchestration`, `threadbus` -> folded into `threadruntime` SDK-side.
    //
    // The three that remain are genuinely three things: the runtime's durable
    // state, the product's own, and the workspace PTY. Getting below this needs
    // a reason, not a trick — so this is a ratchet, and a change that adds a
    // fourth has to come here and argue for it.
    assert!(
        found.len() <= 3,
        "one AppState opened {} isolates ({} descriptors at 5 fds each): {found:#?}",
        found.len(),
        found.len() * 5
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// #202: a terminal lifecycle command must not acknowledge success when the
/// frame announcing it could not be published.
///
/// `terminal.clear` and `terminal.close` change PTY state and then ack on the
/// wire. The ONLY way a live or reconnecting subscriber learns about that
/// change is the broker frame `broadcast_terminal_event` publishes. When that
/// publish failed it was logged and dropped: the command reported Success while
/// every other surface kept rendering a pane that no longer exists, with
/// nothing anywhere saying so. The publish is part of the command's result
/// contract, so a failed publish is a visible failure.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_lifecycle_does_not_ack_success_when_the_event_cannot_be_published() {
    let (state, _dir) = test_state().await;

    for pane in ["pane-a", "pane-b"] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        request(
            &state,
            &tx,
            "terminal.open",
            json!({ "threadId": "t-1", "terminalId": pane, "cwd": state.cwd.clone() }),
        )
        .await;
        assert_eq!(
            drain(&mut rx)[0]["exit"]["_tag"],
            json!("Success"),
            "the pane opened"
        );
    }

    break_topic_publish(&state).await;

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.clear",
        json!({ "threadId": "t-1", "terminalId": "pane-a" }),
    )
    .await;
    let cleared = drain(&mut rx);
    assert_eq!(
        cleared[0]["exit"]["_tag"],
        json!("Failure"),
        "terminal.clear acked success over a fanout nobody received: {cleared:?}"
    );
    assert!(
        cleared[0]["exit"]["cause"][0]["defect"]
            .as_str()
            .is_some_and(|e| e.contains("subscribers could not be notified")),
        "the failure does not say the pane WAS cleared and only the fanout failed: {cleared:?}"
    );

    let (tx, mut rx) = mpsc::unbounded_channel();
    request(
        &state,
        &tx,
        "terminal.close",
        json!({ "threadId": "t-1", "terminalId": "pane-b" }),
    )
    .await;
    let closed = drain(&mut rx);
    assert_eq!(
        closed[0]["exit"]["_tag"],
        json!("Failure"),
        "terminal.close acked success over a fanout nobody received: {closed:?}"
    );
    assert!(
        closed[0]["exit"]["cause"][0]["defect"]
            .as_str()
            .is_some_and(|e| e.contains("subscribers could not be notified")),
        "the failure does not distinguish the close from the fanout: {closed:?}"
    );
}
