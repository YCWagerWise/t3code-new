//! `t3code-server` — the Rust backend that REPLACES t3code's Node/Effect server.
//!
//! The frontend (apps/web) talks over `/ws` using Effect's RPC protocol as JSON
//! (`RpcSerialization.layerJson`): each WS text frame is one `_tag`-tagged JSON
//! object. This binary answers that protocol and runs turns through
//! agent-sdk-rs IN PROCESS — no Node server, no stdio ACP hop.
//!
//! What works here: the boot handshake (`server.getConfig` + subscriptions), and
//! the turn path — `orchestration.dispatchCommand(thread.turn.start)` starts an
//! agent-sdk session for the thread, runs the turn, and streams the assistant's
//! text back as `thread.message.assistant.delta`/`complete` events on that
//! thread's `subscribeThread` stream.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    http::{Method, Uri},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use agent_sdk_shell::{
    emit_thread_event, AgentDefinition, Catalog, Lifecycle, ModelRef, SessionBinding,
    Projector, Shell, ThreadEventVocab, ThreadRuntime, TurnOutcome, VocabProjector,
};

use tokio::sync::RwLock;

use t3code_agent::{
    assets, diagnostics, keybindings, projects, providers, review, settings, sourcecontrol,
    terminal, tools, vcs,
};

/// One outbound websocket frame plus an OPTIONAL delivery-confirmation channel.
/// A sender that cares about delivery (the durable thread tail) passes a
/// `oneshot` and waits for the writer to fire it after the sink accepted the
/// frame; fire-and-forget senders (RPC exits, the shell stream) pass `None`.
/// This is what lets the tail ack the bus AFTER delivery, not after enqueue.
type OutFrame = (String, Option<tokio::sync::oneshot::Sender<bool>>);

struct WsThreadSink {
    tx: mpsc::UnboundedSender<OutFrame>,
    req: Value,
}

#[async_trait::async_trait]
impl agent_sdk_shell::ThreadSink for WsThreadSink {
    async fn deliver(&self, item: Value) -> Result<(), String> {
        let frame = json!({ "_tag": "Chunk", "clientId": 0, "requestId": self.req.clone(), "values": [item] }).to_string();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        self.tx
            .send((frame, Some(done_tx)))
            .map_err(|_| "websocket channel closed before thread event delivery".to_string())?;
        match done_rx.await {
            Ok(true) => Ok(()),
            Ok(false) => Err("websocket sink rejected thread event".to_string()),
            Err(_) => Err("websocket delivery confirmation dropped".to_string()),
        }
    }
}

async fn interrupt_foreground_terminal(runner: &terminal::Terminal) -> Result<String, String> {
    // hearth reports a PTY it could not write to as an Err; the legacy
    // "ERROR:"-prefixed string is still checked because the shim shapes some
    // failures that way.
    let out = runner.interrupt().await.map_err(|e| e.to_string())?;
    if let Some(err) = out.strip_prefix("ERROR:") {
        Err(err.trim().to_string())
    } else {
        Ok(out)
    }
}

/// Shared server state. The turn engine, thread↔session binding, stream cursor,
/// history and lifecycle projection all live in the SDK's [`ThreadRuntime`] —
/// the backend delegates to it and owns only the socket wiring.
/// Load the cached LiteLLM rate table from the data dir, if a host put one
/// there.
///
/// Deliberately best-effort and silent about absence: no rates is the NORMAL
/// state for this runtime, and it is reported honestly downstream as
/// `pricing.status = "unavailable"`. A missing optional cache must not be a
/// startup error, but a cache that exists and does not parse IS worth a line in
/// the log — otherwise a corrupt file looks exactly like no file, and every
/// cost silently reads as unpriced forever.
fn load_usage_rates(data_dir: &str) -> agent_sdk_usage::RateTable {
    let path = std::path::Path::new(data_dir).join("usage-model-rates.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Default::default();
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(doc) => {
            // The cache file wraps the document, matching what the Node server
            // writes; a bare document is accepted too.
            let document = doc.get("document").cloned().unwrap_or(doc);
            let table = agent_sdk_usage::parse_rate_table(&document);
            tracing::info!(models = table.len(), path = %path.display(), "usage rate table loaded");
            table
        }
        Err(e) => {
            tracing::warn!(%e, path = %path.display(), "usage rate cache does not parse — costs will report as unpriced");
            Default::default()
        }
    }
}

#[derive(Clone)]
struct AppState {
    /// The SDK-owned durable thread runtime: binding + cursor + write-through
    /// history + guaranteed terminal lifecycle. This is the authority the
    /// backend used to keep in memory (findings #5/#14/#15/#16/#17).
    rt: ThreadRuntime,
    /// The ONE provider catalog: what `server.getConfig` advertises and what a
    /// model selection resolves against. The picker and the router cannot drift
    /// because they are the same object (#35/#36).
    /// MUTABLE: `server.updateSettings`/`updateProvider`/`refreshProviders`
    /// reconcile new provider instances into this exact catalog, so the picker
    /// and the router both see the change without a restart (#47/#60).
    catalog: Arc<RwLock<Catalog>>,
    store: Arc<Mutex<Store>>,
    #[cfg(test)]
    _contract_test_fd_slot: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
    /// The ONE workspace Hearth PTY, shared by the agent's `run_bash` tools and
    /// the human-facing terminal RPCs — one shell, one screen (#33).
    terminal: terminal::Terminal,
    /// Every open pane, keyed by the (threadId, terminalId) the CLIENT chose.
    /// `terminal` above stays the AGENT's shell — the one `run_bash` types into
    /// and a human can watch — while other panes are their own PTYs (#82/#118).
    terminals: Arc<terminal::TerminalRegistry>,
    // Terminal event + metadata fanout is NOT here. Both run through the
    // SDK's generic named-topic seam (`ThreadRuntime::topic_publish` /
    // `topic_tail_after`) on `TERMINAL_EVENTS_TOPIC` and
    // `terminal_meta_topic(thread)`; the process-local `Vec<Sender>` fanouts
    // only reached this process and left every reconnect leaking a dead
    // subscriber. See broadcast_terminal_event / subscribeTerminalEvents /
    // subscribeTerminalMetadata for the current wiring.
    /// Fires when the set of working trees anyone is subscribed to changes, so
    /// the VCS watcher supervisor can wake on a subscribe/unsubscribe instead of
    /// re-reading the list on a timer. The value is a bare counter — the
    /// supervisor re-reads `state.rt.watch_marks("vcs")` on every wake, so
    /// nothing rides on it.
    vcs_watch_changed: Arc<tokio::sync::watch::Sender<u64>>,
    /// The cairn checkpoint store, so a FRONTEND file save takes the same
    /// checkpointed path an agent write does (#85) — confinement and edit
    /// safety are different properties and the UI needs both.
    checkpoints: Arc<do_storage::DbPool>,
    /// Where the SDK's TURN checkpoint stack lives (#376).
    ///
    /// A path, not a pool, because `agent_sdk_branch::Checkpoints` opens its own
    /// — the product does not hold a `cairn::Stack` for turn lifecycle any more.
    ///
    /// The same directory as `checkpoints` above, but a DIFFERENT stack id
    /// inside it: the coding tools checkpoint every file write under
    /// `t3code-files`, and turn checkpoints used to land in that same stack,
    /// interleaved. That is why `checkpoint_summaries` has to filter on a
    /// `turn:` label prefix at all — a rewind counting "turns" was really
    /// counting turns AND individual file writes.
    checkpoints_dir: std::path::PathBuf,
    /// Resource samples behind the Diagnostics panel (#67), in the DURABLE
    /// shared history (#336) — not a process-local ring.
    ///
    /// The ring made the panel empty after every restart (which a user reads as
    /// "nothing happened", not "this process is new"), gave two backends
    /// serving one UI two different histories, and expressed its retention
    /// policy as a `Vec` length in product code. Retention is now a delete in
    /// the store. A sample is still taken on each diagnostics read, so an idle
    /// server never forks `ps`.
    diag_history: Arc<agent_sdk_metrics::ResourceHistory>,
    /// The work roots this environment can hand an agent, and the one durable
    /// shell each gets. The turn path opens a worktree's shell here before the
    /// registry factory (which cannot await) looks it up.
    tool_roots: tools::ToolRoots,
    /// HMAC secret for signed asset URLs. Durable (it lives in the same store as
    /// settings), so a URL already rendered in an open tab survives a restart.
    assets_key: Arc<Vec<u8>>,
    /// LiteLLM model rates, loaded ONCE from a cache file in the data dir.
    ///
    /// This runtime never fetches them: a usage page must work offline, and a
    /// background HTTP call on an RPC path is a hang waiting to happen. An
    /// EMPTY table is a supported state — usage then reports tokens with
    /// `costSource: "unpriced"` rather than a confident $0.00 (#328).
    usage_rates: agent_sdk_usage::RateTable,
    /// The provider transcript homes the usage scan reads.
    ///
    /// Resolved ONCE at boot rather than from the environment on every RPC:
    /// an ambient `$HOME` read inside the handler makes the only provable
    /// version of that handler the one that scans the developer's real
    /// transcripts, so the test either asserts nothing or asserts whatever
    /// happens to be on the machine (#328).
    usage_sources: Arc<Vec<agent_sdk_usage::SourceSpec>>,
    env: Value,
    cwd: String,
    project_name: String,
}

/// Live socket wiring only — NOT durable authority. Threads, messages, the
/// (thread,model)→session binding, and stream cursors all live in the SDK's
/// do-rs `OrchStore`/`Shell`; this struct holds just the ephemeral fan-out
/// senders. It holds NO sequence of its own: every wire sequence — shell stream,
/// thread stream, dispatch ack, snapshot mark — comes from
/// `ThreadRuntime::next_sequence`, which is durable and continues across a
/// restart. A per-process counter rewinds to 1 when the process dies, and a
/// client reducer then sees an old number attached to a new event (#299).
#[derive(Default)]
struct Store {
    // Every field that used to live here has moved out:
    // - projects (#370): durable in `OrchStore` via
    //   `ThreadRuntime::save_project` / `projects`; a snapshot reads the
    //   same list threads read from, and two backends on the same isolate
    //   see the same rows.
    // Shell list/watch fanout is NOT here (#320). It runs through the SDK's
    // durable shell topic (`ThreadRuntime::shell_publish` /
    // `shell_tail_after`), so a second backend process attached to the same
    // isolate sees the same frames. And the "already announced?" set is
    // authoritative in the durable store — `state.rt.threads()` tells us —
    // so a process-local `known_threads` HashSet no longer exists either.
    // subscribeVcsStatus fanout is NOT here (packet DM). It runs through the
    // SDK's durable per-cwd broker topic (`ThreadRuntime::vcs_publish` /
    // `vcs_tail_after`); the durable watch registry (`state.rt.watch_marks`)
    // is what the supervisor polls; and release-on-last-watcher is a DURABLE
    // claim (`watch_claim`/`watch_unclaim`), counted in the store rather than
    // in this process, so two backends cannot disagree about whether a tree
    // still has readers.
    // `subscribeServerConfig` fanout is NOT here (packet DL). It runs through
    // the SDK's durable config topic (`ThreadRuntime::config_publish` /
    // `config_tail_after`), so a settings write made from a SECOND backend
    // process attached to the same isolate reaches every subscriber — the
    // process-local `config_subs` `Vec<Sender>` only reached this process,
    // and left every passive surface stale on cross-process mutations.
}

/// Map the UI's model selection (provider instance + model slug) to a ModelRef
/// by asking the SDK provider registry — the SAME registry the picker was
/// rendered from, so anything selectable is routable.
///
/// A selection that will not resolve is an ERROR, never the default. The
/// substitution is precisely the drift `agent-sdk-shell::catalog` exists to
/// forbid: the thread would keep showing the provider the user picked while a
/// billed turn ran Claude/Codex under a different durable session binding, and
/// nothing on screen would say so. A selection sent with no instance at all is
/// the one legitimate "use the default" case.
fn model_from_selection(
    catalog: &Catalog,
    sel: &Value,
    default: &Option<ModelRef>,
) -> Result<ModelRef, String> {
    let instance = sel
        .get("instanceId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let slug = sel
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if instance.is_empty() {
        // "use the default" is only answerable if a default exists; with no
        // routable provider this is a visible refusal, not a guessed slug.
        return default
            .clone()
            .ok_or_else(|| "no provider is configured — add one in Settings".to_string());
    }
    // #89 first pass: DECODE + VALIDATE the ModelSelection.options carried
    // on the wire. Unknown option ids are accepted (per SDK
    // `validate_selection` — a newer client's extra knobs are not erased
    // by an older build), but a value that violates the descriptor's
    // type/enum is REFUSED here rather than dropped: a silently-ignored
    // `reasoning: "ludicrous"` means the user is paying for a setting
    // that is not in effect and has nothing on screen telling them so.
    //
    // The values themselves are not yet stitched into the provider config
    // for the turn — that requires SDK-side session-binding plumbing —
    // but this closes the WORST failure mode the finding names: silent
    // acceptance of an invalid option. Full routing lands with the SDK
    // extension of SessionBinding.
    if let Some(raw_options) = sel.get("options").filter(|v| !v.is_null()) {
        use agent_sdk_provider::instance::{decode_option_selections, validate_selection};
        let snapshot = catalog
            .snapshot(instance)
            .ok_or_else(|| format!("unknown provider instance \"{instance}\""))?;
        for selection in decode_option_selections(raw_options) {
            validate_selection(&snapshot.options, &selection)
                .map_err(|e| format!("invalid model option: {e}"))?;
        }
    }
    catalog.resolve(instance, slug)
}

/// Turn the frontend's runtime/interaction modes into the SDK's ACTUAL policy.
///
/// This is an enforcement point, not a label. The UI's "approval required"
/// badge means nothing unless `ask_tools` is populated: the gate lives in
/// `AgentDefinition::gate()`, and a definition built with `ask_tools: vec![]`
/// is allow-all no matter what the badge says. Shipping the badge without the
/// gate is worse than having neither — the user believes they are supervising a
/// run that is in fact unsupervised (#79).
///
/// * `approval-required` — every mutating tool asks. Reads stay free, because
///   prompting for a file read trains people to click through prompts.
/// * `auto-accept-edits` — file edits run, the shell still asks: an edit is
///   checkpointed and revertable, an arbitrary command is not.
/// * `auto` / `full-access` — nothing asks.
///
/// `plan` interaction mode additionally instructs the agent not to act. That is
/// prose, so it is NOT relied on alone: plan mode also gates every mutating
/// tool, or a model that ignores the instruction edits the tree anyway.
fn policy_for(runtime_mode: &str, interaction_mode: &str) -> (Vec<String>, String) {
    const MUTATING: &[&str] = &[
        "run_bash",
        "write_file",
        "edit_file",
        "send_keys",
        "interrupt_shell",
    ];
    const EDITS: &[&str] = &["write_file", "edit_file"];
    const SHELL: &[&str] = &["run_bash", "send_keys", "interrupt_shell"];

    let planning = interaction_mode == "plan";
    let mut ask: Vec<String> = match runtime_mode {
        "approval-required" => MUTATING.iter().map(|s| s.to_string()).collect(),
        "auto-accept-edits" => SHELL.iter().map(|s| s.to_string()).collect(),
        _ => vec![],
    };
    if planning {
        // belt and braces: the instruction alone is unenforceable
        for t in MUTATING {
            if !ask.iter().any(|a| a == t) {
                ask.push(t.to_string());
            }
        }
    }
    let _ = EDITS;

    let mut instructions = String::from("You are a coding agent. Be concise and precise.");
    if planning {
        instructions.push_str(
            " You are in PLAN mode: investigate and propose a plan. Do not modify files or run \
             commands that change state — every such tool requires explicit approval.",
        );
    } else if runtime_mode == "approval-required" {
        instructions.push_str(" Mutating actions require the user's approval before they run.");
    }
    (ask, instructions)
}

/// Where the agent works, and where its durable state lives.
fn workspace_paths() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = std::env::var("T3CODE_WORKSPACE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let data = std::env::var("T3CODE_AGENT_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(".t3code-agent"));
    (root, data)
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    // NON-BLOCKING, and this is a liveness property of the server, not a
    // logging preference (#404).
    //
    // `fmt()` writes each line synchronously on the thread that emits it. Those
    // are tokio WORKER threads. When stdout is a pipe whose reader does not
    // drain it — which is exactly how a parent process (the dev launcher, an
    // Electron shell, `subprocess.PIPE`) spawns this binary — `write(2)` blocks
    // once the 64KB pipe buffer fills. Each worker thread that logs then parks
    // in the kernel, and when they are all parked the runtime stops running
    // ANYTHING: no handler, no WS upgrade, not even a 404 for a route that does
    // not exist. The listening socket keeps accepting the whole time, because
    // that is the kernel backlog rather than this process, so from outside the
    // server looks alive and simply never answers.
    //
    // Measured, one variable: with an undrained pipe the server wedged after
    // 404 requests over 101 sockets; with stdout to a file, and with the SAME
    // pipe drained by a reader, it served 1504 requests over 376 sockets and
    // stayed responsive.
    //
    // The writer thread owns the blocking write, and the queue in front of it
    // is bounded and LOSSY. Losing log lines under backpressure is the correct
    // failure mode for telemetry; deadlocking the server that produces it is
    // not. `_log_guard` must outlive every log call, so it is held for the
    // lifetime of `main`.
    let (log_writer, _log_guard) = tracing_appender::non_blocking(std::io::stdout());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "t3code_server=info".into()),
        )
        .with_writer(log_writer)
        .init();

    let data = std::env::var("T3CODE_AGENT_DATA").unwrap_or_else(|_| ".t3code-agent".into());
    let cwd = std::env::var("T3CODE_WORKSPACE").unwrap_or_else(|_| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into())
    });
    let project_name = std::path::Path::new(&cwd)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".into());
    // The model CLIs (claude/codex) and our tools inherit this process's cwd —
    // point it at the workspace so agent file edits land in the user's repo
    // (which is exactly what the vcs status/refs panel reads).
    let _ = std::env::set_current_dir(&cwd);
    let env = environment_descriptor();
    // Seed one project rooted at the workspace on FIRST OPEN only (#370):
    // the seed is a durable row in the SDK store, not a per-process boot
    // constant. Written after `ThreadRuntime::open` below when the durable
    // list is empty; skipped on every subsequent boot so `createdAt` does
    // not move under a client's feet.
    let now = now_iso();
    let seed_project = json!({
        "id": "p-workspace", "title": project_name, "workspaceRoot": cwd,
        "defaultModelSelection": null, "scripts": [], "createdAt": now, "updatedAt": now,
    });
    // The SDK-owned durable thread runtime (shell + orch + bus + binding/cursor
    // tables) — the substrate the backend delegates every turn to.
    // ONE Hearth PTY per workspace, opened before any session exists and shared
    // by every session and subagent: `cd`/env persist across tool calls, and the
    // session id in each run_bash result is what a client attaches to.
    let (ws_root, agent_data) = workspace_paths();
    // Open the ONE workspace PTY here so the SAME handle backs both the agent's
    // run_bash tools and the human-facing terminal RPCs (#33) — never two PTYs.
    let workspace_runner = tools::open_workspace_shell(&ws_root, agent_data.clone())
        .await
        .expect("open the workspace shell");
    let checkpoints_dir = agent_data.join("checkpoints");
    // The SAME pool the boot workspace's coding tools use. Two `DbPool::new`
    // calls over one directory is two isolate caches over one set of files —
    // double the descriptors for a store that was always meant to be one.
    let checkpoints = tools::checkpoint_pool(checkpoints_dir.clone());
    // The diagnostics history's own isolate (#336). Durable and shared, so the
    // panel survives a restart and two backends on this environment read one
    // history. 24h of retention, enforced by the store deleting rows rather
    // than by a Vec forgetting them.
    let diag_history = open_diag_history(&agent_data).await;
    // ONE ToolRoots, shared: the factory reads the runner map, the turn path
    // fills it. Building the factory standalone would give the turn path a
    // different map and every worktree turn would fall back to the boot shell.
    let tool_roots = tools::ToolRoots::new(ws_root, agent_data, workspace_runner.clone()).await;
    let shell = Arc::new(Shell::new(&data, tool_roots.registry_factory()));
    let rt = ThreadRuntime::open(shell, &data, "main")
        .await
        .expect("open thread runtime");
    // Seed the workspace project into the DURABLE store on first open (#370).
    // A second backend attached to the same isolate will read the same seed
    // rather than synthesizing its own; a subsequent boot skips the write
    // (the row is already there), so `createdAt` stamped once at first
    // install stays put across restarts. A store that cannot be read is
    // fatal here: it means the projects RPCs would report nothing while the
    // UI thinks a workspace project should exist.
    match rt.projects().await {
        Ok(existing) if existing.is_empty() => {
            if let Err(e) = rt.save_project(&seed_project).await {
                panic!("could not seed the workspace project: {e}");
            }
        }
        Ok(_) => {}
        Err(e) => panic!("project store unreadable at boot: {e}"),
    }
    let store = Store::default();
    // ONE catalog, built at boot from the DURABLE instance set (the user's saved
    // providers merged over the env defaults) so a custom/Ollama model added in
    // settings survives restart instead of falling back to the skinny boot env
    // catalog (#47). The picker renders its snapshots and every turn resolves
    // against it; settings writes reconcile it in place.
    let instances = settings::load_instances(rt.store(), providers::configured_instances())
        .await
        .expect("server settings unreadable at boot");
    // Ask every configured OpenAI-compatible endpoint what it serves before the
    // first picker render: an install pointed at a running Ollama should show
    // its models without the user hand-typing slugs (#180). Unreachable
    // endpoints are left exactly as configured, so the failure surfaces as the
    // driver's unavailable reason rather than as models vanishing.
    let instances = providers::with_discovered_models(instances).await;
    if let Err(e) = settings::save_instances(rt.store(), &instances).await {
        tracing::warn!(%e, "could not persist discovered models at boot");
    }
    let mut catalog = Catalog::new();
    catalog.reconcile(&instances);
    // No routable provider is a real state, not a reason to invent a slug: the
    // server still starts (so settings are reachable and the user can FIX it),
    // and turn admission refuses visibly (#110).
    if providers::default_model(&catalog).is_none() {
        tracing::warn!(
            "no routable provider configured — turns will be refused until one is added"
        );
    }
    let catalog = Arc::new(RwLock::new(catalog));
    // Minted once and persisted: asset URLs a client is already holding must
    // outlive a restart, so this key cannot be per-process.
    let assets_key = assets::signing_key(rt.store())
        .await
        .expect("asset signing key");
    let state = AppState {
        rt,
        catalog,
        checkpoints,
        checkpoints_dir,
        diag_history: Arc::new(diag_history),
        store: Arc::new(Mutex::new(store)),
        #[cfg(test)]
        _contract_test_fd_slot: None,
        vcs_watch_changed: Arc::new(tokio::sync::watch::channel(0u64).0),
        terminals: Arc::new(
            terminal::TerminalRegistry::new(
                workspace_runner.clone(),
                cwd.clone(),
                tool_roots.sessions(),
                tool_roots.session_db(),
            )
            .await
            .expect("open the durable pane registry"),
        ),
        terminal: workspace_runner,
        tool_roots,
        assets_key: Arc::new(assets_key),
        usage_rates: load_usage_rates(&data),
        usage_sources: Arc::new(agent_sdk_usage::default_sources()),
        env,
        cwd,
        project_name,
    };

    // external git edits move the panel too, not only our own commands
    spawn_vcs_watcher(state.clone());

    let app = build_app(state);

    let port: u16 = std::env::var("T3CODE_SERVER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(13774);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!(%addr, "t3code-server (rust) listening — Effect-RPC/WS on /ws, turns via agent-sdk");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

/// THE SERVED ROUTER — the real one, not a test replica.
///
/// Extracted from `main` for #404. The wedge that finding reports (the process
/// accepts on its listener and answers nothing, so the UI sits on
/// "Reconnecting to Local (Rust)" forever) lives ABOVE the request dispatcher:
/// driving `dispatch_ws_frame`/`handle_request` directly does not reproduce it.
/// While this router only existed as a local inside `main`, no test could bind
/// it, which is exactly how 87 green backend tests coexisted with a server that
/// stops serving. A test can now `axum::serve` THIS value on port 0 and make
/// real requests against the same stack the browser talks to.
///
/// Behaviour is unchanged — this is a move, not a rewrite.
pub(crate) fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade))
        // The redeem half of `assets.createUrl`. Registered BEFORE the fallback
        // so a signed URL is served, not swallowed by the catch-all.
        .route(
            &format!("{}/{{token}}/{{name}}", assets::ROUTE_PREFIX),
            get(asset_http),
        )
        .fallback(capture_http)
        .with_state(state)
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Subscriptions this backend answers with silence rather than data. Anything
/// NOT here and not explicitly handled is an unimplemented contract and fails
/// loudly — "no events yet" and "this runtime cannot serve you" are different
/// facts, and only one of them is worth waiting on.
const INTENTIONALLY_EMPTY_STREAMS: &[&str] = &[
    // no multi-environment presence on a local backend
    "subscribeEnvironments",
    "subscribeEnvironmentStatus",
    // notifications/toasts are frontend-local here
    "subscribeNotifications",
];

/// The directory a VCS request targets, ADMITTED.
///
/// The client names a path (a worktree panel operates on its own directory),
/// but naming is not authority: `vcs::resolve_cwd` admits only this
/// environment's workspace root, paths beneath it, and the worktrees git
/// reports for that repository. Anything else fails closed — a client for
/// project A must not be able to mutate project B's repository just by sending
/// its path.
async fn req_cwd(payload: &Value, state: &AppState) -> Result<String, String> {
    let requested = payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&state.cwd);
    vcs::resolve_cwd(requested, &state.cwd).await
}

/// The workspace root an asset resource is confined to.
///
/// A `workspace-file` belongs to its THREAD (which may run in a worktree, not
/// the environment root), a `project-favicon` names its own project cwd, and
/// both go through `vcs::resolve_cwd` first — naming a directory is not
/// authority to read from it.
async fn asset_root(resource: &Value, state: &AppState) -> Result<String, String> {
    let requested = match resource
        .get("_tag")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "workspace-file" => {
            let thread_id = resource
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "workspace-file asset requires threadId".to_string())?;
            let thread = state
                .rt
                .threads()
                .await
                .into_iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
                .ok_or_else(|| format!("workspace-file asset thread `{thread_id}` was not found"))?;
            let root = thread
                .get("worktreePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("workspace-file asset thread `{thread_id}` has no worktree root"))?;
            Some(root.to_string())
        }
        "project-favicon" => resource
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    };
    let requested = requested
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| state.cwd.clone());
    vcs::resolve_cwd(&requested, &state.cwd).await
}

/// Render one SDK provider snapshot in the shape the frontend contract
/// actually decodes.
///
/// This is a TRANSLATION, not a passthrough, and two details are load-bearing:
///
/// * `status` is `ready | warning | error | disabled` — there is no
///   `"unavailable"` literal. Inventing one does not just mis-render that row:
///   an unknown/misconfigured instance can fail the decode for the WHOLE
///   provider list. Unavailability is carried by `availability`
///   + `unavailableReason` + `installed:false`/`enabled:false` instead (#101).
/// * option descriptors use the contract's own shape — `options[{id,label}]`
///   and `currentValue`, not the SDK's internal `values`/`default` — or the
///   richer model controls the SDK already advertises cannot render at all
///   (#100).
fn provider_entry(s: &agent_sdk_provider::ProviderSnapshot) -> Value {
    use agent_sdk_provider::ProviderStatus;
    let unavailable = s.status == ProviderStatus::Unavailable;
    let ready = s.status == ProviderStatus::Ready;

    let mut entry = json!({
        "instanceId": s.instance_id,
        "driver": s.driver.as_str(),
        "displayName": s.display_name.clone().unwrap_or_else(|| s.instance_id.clone()),
        // an unavailable instance MUST report installed:false/enabled:false —
        // the contract says so, and the UI keys its fixable-row affordance on it
        "enabled": s.enabled && !unavailable,
        "installed": ready,
        "version": Value::Null,
        "status": match s.status {
            ProviderStatus::Ready => "ready",
            ProviderStatus::Disabled => "disabled",
            // a configured instance this build cannot run is an ERROR row the
            // user can fix, not a new status literal
            ProviderStatus::Unavailable => "error",
        },
        "auth": { "status": if ready { "authenticated" } else { "unknown" } },
        // Switching model/provider mid-thread is a FIRST-CLASS operation on this
        // runtime: the thread↔session binding is keyed by provider instance, and
        // a new binding refolds the durable transcript into the new session, so
        // the next provider sees the conversation the user sees. Declaring this
        // false (rather than leaving it undefined) is what makes the frontend's
        // "start a new chat to change models" block provably inert here (#139).
        "requiresNewThreadForModelChange": false,
        "checkedAt": now_iso(),
        "models": s.models.iter().map(|m| json!({
            "slug": m.slug,
            "name": m.name.clone().unwrap_or_else(|| m.slug.clone()),
            "isCustom": false,
            "isDefault": m.is_default,
            "capabilities": null,
        })).collect::<Vec<_>>(),
        "options": s.options.iter().filter_map(option_descriptor).collect::<Vec<_>>(),
        "slashCommands": [], "skills": [],
    });
    if unavailable {
        if let Some(o) = entry.as_object_mut() {
            o.insert("availability".into(), json!("unavailable"));
            if let Some(why) = &s.detail {
                o.insert("unavailableReason".into(), json!(why));
            }
        }
    }
    entry
}

/// Translate one SDK option descriptor into the contract's tagged union.
///
/// `None` for a kind the contract has no representation for (it only models
/// `select` and `boolean`) — emitting an untagged third shape would break the
/// union decode for every option on that provider.
fn option_descriptor(d: &agent_sdk_provider::ProviderOptionDescriptor) -> Option<Value> {
    use agent_sdk_provider::OptionType;
    let label = d.label.clone().unwrap_or_else(|| d.id.clone());
    match d.option_type {
        OptionType::Select => Some(json!({
            "id": d.id,
            "label": label,
            "type": "select",
            "options": d.values.iter().map(|v| json!({
                "id": v.value,
                "label": v.label.clone().unwrap_or_else(|| v.value.clone()),
                "isDefault": d.default.as_ref().and_then(Value::as_str) == Some(v.value.as_str()),
            })).collect::<Vec<_>>(),
            "currentValue": d.default.as_ref().and_then(Value::as_str),
        })),
        OptionType::Boolean => Some(json!({
            "id": d.id,
            "label": label,
            "type": "boolean",
            "currentValue": d.default.as_ref().and_then(Value::as_bool),
        })),
        // `text` has no contract counterpart; omit rather than emit a shape the
        // union cannot decode.
        OptionType::Text => None,
    }
}

fn environment_descriptor() -> Value {
    json!({ "environmentId": "local", "label": "Local (Rust)", "platform": { "os": "darwin", "arch": "arm64" }, "serverVersion": "0.0.0", "capabilities": {} })
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Announce a thread on the shell stream the first time a turn targets it, so
/// the UI promotes its draft to a real thread and subscribes to it.
async fn ensure_thread_on_shell(state: &AppState, command: &Value) {
    let thread_id = command
        .get("threadId")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if thread_id.is_empty() {
        return;
    }
    let sel = match command.get("modelSelection").cloned() {
        Some(s) if !s.is_null() => s,
        // derived from the catalog, so the announced thread names the provider
        // the turn will really use (#125)
        _ => default_model_selection(state).await,
    };
    // The FIRST turn carries the context the user chose in the composer:
    // `bootstrap.createThread` names the project, title, worktree and branch,
    // and the command names the runtime/interaction mode. Manufacturing
    // "first project + full-access + no worktree" instead threw all of that
    // away before the runtime ever started — the thread showed one project
    // while the work happened somewhere else (#137/#78/#79).
    let boot = command.pointer("/bootstrap/createThread");
    let str_of = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let title = str_of(command.get("titleSeed"))
        .or_else(|| str_of(boot.and_then(|b| b.get("title"))))
        .or_else(|| {
            command
                .pointer("/message/text")
                .and_then(|t| t.as_str())
                .map(|t| t.chars().take(48).collect::<String>())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "New thread".into());
    let now = now_iso();
    // FAIL CLOSED on a project-store read error (#374): a hard-coded
    // `"p-workspace"` fallback would attach the new thread to a project id
    // no durable row backs, which is exactly the "synthesize state in the
    // adapter when the SDK store is unreadable" pattern the finding names.
    // A read error aborts the bootstrap; the client sees no new thread and
    // can retry, instead of a phantom project id propagating through the
    // durable store.
    let project_id = match str_of(boot.and_then(|b| b.get("projectId"))) {
        Some(p) => p,
        None => match state.rt.projects().await {
            Ok(ps) => match ps
                .first()
                .and_then(|p| p.get("id"))
                .and_then(|v| v.as_str())
            {
                Some(id) => id.to_string(),
                None => {
                    tracing::error!("ensure_thread_on_shell: no seed project in store; refusing to invent an id");
                    return;
                }
            },
            Err(e) => {
                tracing::error!(%e, "ensure_thread_on_shell: project store unreadable");
                return;
            }
        },
    };
    // A worktree the client prepared (or asked us to prepare) is where this
    // thread's work belongs; the branch travels with it.
    let worktree_path = str_of(boot.and_then(|b| b.get("worktreePath")))
        .or_else(|| str_of(command.pointer("/bootstrap/prepareWorktree/projectCwd")));
    let branch = str_of(boot.and_then(|b| b.get("branch")))
        .or_else(|| str_of(command.pointer("/bootstrap/prepareWorktree/branch")));
    let runtime_mode = str_of(command.get("runtimeMode"))
        .or_else(|| str_of(boot.and_then(|b| b.get("runtimeMode"))))
        .unwrap_or_else(|| "full-access".into());
    // The durable row is built by the SDK record, not by hand (#2/#5): the
    // create path and the reconnect snapshot now agree by construction, because
    // both go through `ThreadRecord`. The keys below the record does not own are
    // t3's own shell vocabulary and stay here.
    let thread = agent_sdk_shell::ThreadRecord::new(
        thread_id.clone(),
        project_id.clone(),
        title.clone(),
        sel.clone(),
        agent_sdk_shell::RuntimeMode::parse(&runtime_mode),
        now.clone(),
    )
    .on_worktree(worktree_path.clone(), branch.clone())
    .project(json!({
        "latestUserMessageAt": now,
        "hasPendingApprovals": false,
        "hasPendingUserInput": false,
        "hasActionableProposedPlan": false,
        "session": null,
    }))
    .expect("thread projection uses only product-owned keys");
    // The user's message is NOT written here. `ThreadRuntime::run_turn_with_prompt_id`
    // owns the prompt write-through for the same reason it owns the cursor, and
    // it is the commit point: if history cannot be written the turn fails rather
    // than running against a transcript that does not exist. A second write here
    // — under an id the runtime cannot see — is what put every prompt in the
    // transcript twice, once bare and once bound to its turn.
    // "Is this thread already in the durable store?" — answered by asking
    // the store, not a process-local HashSet (#320). A second backend
    // process (or this one after restart) sees the same answer.
    let existing_row = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(thread_id.as_str()));
    // For an EXISTING thread, the turn may carry a SWITCHED model selection. That
    // switch must persist durably (#37): otherwise a reload shows the old model
    // and the next turn can silently drift back to it. Update the thread's
    // modelSelection + timestamps, re-save, and re-announce so the snapshot and
    // every subscriber reflect the switch — history is untouched.
    let thread = match existing_row {
        None => thread,
        Some(mut existing) => {
            if let Some(o) = existing.as_object_mut() {
                o.insert("modelSelection".into(), sel.clone());
                o.insert("latestUserMessageAt".into(), json!(now));
                o.insert("updatedAt".into(), json!(now));
            }
            existing
        }
    };
    // Durable commit BEFORE the thread becomes observable: if the thread row
    // fails to persist, do not announce it (it would vanish on reload). No
    // process-local rollback to do — the store IS the state.
    if let Err(e) = state.rt.save_thread(&thread).await {
        tracing::error!(%e, %thread_id, "persist thread failed — not announcing on shell");
        return;
    }
    upsert_thread_on_shell(state, thread).await;
}

/// Refresh the shell projection for one thread and announce it to every shell
/// subscriber. Shared by turn bootstrap and metadata updates, so a thread
/// renamed or re-modelled outside a turn moves in the list exactly as one
/// created by a turn does.
async fn upsert_thread_on_shell(state: &AppState, thread: Value) {
    let thread_id = thread
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // ONE EMISSION SEAM (packet L). The product supplies the frame's wire
    // vocabulary and nothing else: the SDK allocates the durable sequence,
    // stamps it in, RECORDS the frame in the shell replay log, and only then
    // publishes it to the durable shell topic.
    //
    // What this replaces is a product-side `next_sequence()` + `shell_publish()`
    // pair. That pair delivered the frame to whoever was connected and left NO
    // replay row behind, so a client reconnecting with `afterSequence` could
    // only ever be handed the broker's single retained frame — every earlier
    // upsert it missed was unobtainable, and the ordering/record decisions were
    // re-derived here where a second call site could get them wrong.
    let frame = json!({ "kind": "thread-upserted", "thread": thread });
    if let Err(e) = state.rt.emit_shell_event(frame).await {
        tracing::error!(%e, %thread_id, "shell emission failed — subscribers may miss this upsert");
    }
}

/// Apply a thread metadata patch DURABLY and announce it.
///
/// A model selection is validated against the live catalog before it is stored:
/// persisting a selection the runtime cannot route would leave the picker
/// showing a provider every future turn silently refuses (#73/#50).
async fn update_thread_meta(
    state: &AppState,
    thread_id: &str,
    patch: &Value,
) -> Result<(), String> {
    if thread_id.is_empty() {
        return Err("threadId is required".into());
    }
    let mut thread = state
        .rt
        .threads()
        .await
        .into_iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id))
        .ok_or_else(|| format!("unknown thread {thread_id}"))?;

    if let Some(sel) = patch.get("modelSelection") {
        model_from_selection(
            &*state.catalog.read().await,
            sel,
            &state.default_model().await,
        )
        .map_err(|e| format!("cannot select this model: {e}"))?;
    }
    if let (Some(o), Some(p)) = (thread.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            // identity is not patchable
            if k != "id" && k != "projectId" {
                o.insert(k.clone(), v.clone());
            }
        }
        o.insert("updatedAt".into(), json!(now_iso()));
    }
    state.rt.save_thread(&thread).await?;
    // the shell list and every thread subscriber both need to see it
    upsert_thread_on_shell(state, thread.clone()).await;
    // Recorded, not just published (#318): a rename or model switch that only
    // went out live is invisible to a client that reconnects with
    // `afterSequence` — it catches up over the gap and keeps showing the old
    // title until something else forces a full refresh.
    emit_thread_event(
        &state.rt,
        thread_id,
        "thread.meta-updated",
        json!({
            "threadId": thread_id, "thread": thread,
        }),
    )
    .await
}

/// The `ModelSelection` the runtime would ACTUALLY launch, as the frontend
/// serializes it.
///
/// Displayed metadata and the SDK session binding have to come from one place.
/// A hard-coded `claudeAgent`/Haiku literal here means an Ollama-first or
/// Codex-only install persists and announces a thread claiming Claude while the
/// turn runs the catalog default — and then model switching cannot be verified
/// from the UI at all, because the shown binding drifts from the real one
/// (#125). Deriving it from the catalog is also why there is no runtime Haiku
/// fallback left to restore: the catalog IS the seam.
async fn default_model_selection(state: &AppState) -> Value {
    let catalog = state.catalog.read().await;
    // the instance/model the default `ModelRef` corresponds to
    if let Some(default) = &state.default_model().await {
        for snap in catalog.snapshots() {
            if snap.status != agent_sdk_provider::ProviderStatus::Ready {
                continue;
            }
            for m in &snap.models {
                if catalog.resolve(&snap.instance_id, &m.slug).ok().as_ref() == Some(default) {
                    return json!({ "instanceId": snap.instance_id, "model": m.slug });
                }
            }
        }
        // the default resolved from an instance we cannot name (env-only spec):
        // still better to say nothing than to name the wrong provider.
    }
    // No routable provider: an EMPTY selection, which `model_from_selection`
    // reads as "use the default" and which turn admission refuses visibly. A
    // fabricated provider name would be a lie the UI renders as fact.
    catalog
        .snapshots()
        .iter()
        .find(|s| s.status == agent_sdk_provider::ProviderStatus::Ready)
        .map(|s| {
            let model = s
                .models
                .iter()
                .find(|m| m.is_default)
                .or_else(|| s.models.first());
            json!({
                "instanceId": s.instance_id,
                "model": model.map(|m| m.slug.clone()).unwrap_or_default(),
            })
        })
        .unwrap_or_else(|| json!({}))
}

/// The thread a command targets.
fn thread_id_of(command: &Value) -> String {
    command
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Decode a `thread.approval.respond` into allow/deny (#69).
///
/// `decision` is the contract's ENUM (`accept` | `acceptForSession` | `decline`
/// | `cancel`), NOT a boolean. Reading a boolean `approved` and defaulting to
/// false turned every real acceptance into a denial — the user clicks Approve
/// and the tool is refused. A missing decision falls back to the legacy boolean
/// so an older client still works, but a present decision is authoritative.
fn approval_allow(command: &Value) -> bool {
    match command
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "accept" | "acceptForSession" => true,
        "decline" | "cancel" => false,
        _ => command
            .get("approved")
            .or_else(|| command.get("allow"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// Tell every thread subscriber the approval is settled.
///
/// Without this the banner stays up after the user answered: the client only
/// learned the request EXISTED, never that it resolved.
async fn publish_approval_resolved(
    state: &AppState,
    thread_id: &str,
    request_id: &str,
    decision: &str,
    allowed: bool,
) -> Result<(), String> {
    let decision =
        if decision.is_empty() { if allowed { "accept" } else { "decline" } } else { decision };
    // `thread.approval-resolved` was invented — not in `OrchestrationEventType`,
    // so the reducer fell through its forward-compatible default and the banner
    // stayed up after the user answered (#315/#316).
    //
    // What actually clears a pending approval is an ACTIVITY whose `kind` is
    // `approval.resolved` and whose `requestId` matches the request's
    // (`session-logic.ts` `pendingApprovalsFromActivities`: it deletes the open
    // entry keyed by that id). The activity `id` is the SAME stable id the
    // request used, so the reducer replaces that row instead of appending a
    // second one beneath it.
    event_adapter::t3_projector(state.rt.clone())
        .project(Lifecycle::ApprovalResolved {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            decision: decision.to_string(),
            allowed,
        })
        .await
}

/// Tell every thread subscriber the agent's question is answered.
///
/// The mirror of [`publish_approval_resolved`] (#317). Without it the composer's
/// pending-input state never closes: `session-logic.ts` clears it only on an
/// activity with `kind: "user-input.resolved"` carrying the request id, so after
/// submitting an answer the user is left with a blocked composer and no way to
/// tell that their answer landed.
async fn publish_user_input_resolved(
    state: &AppState,
    thread_id: &str,
    session_id: &str,
) -> Result<(), String> {
    event_adapter::t3_projector(state.rt.clone())
        .project(Lifecycle::UserInputResolved {
            thread_id: thread_id.to_string(),
            session_id: session_id.to_string(),
        })
        .await
}

/// The parked wait FAILED to settle (packet M).
///
/// The third state a pending approval has: not requested, not resolved, but
/// "your answer did not land". Without it a delivery failure was a log line —
/// the user pressed Approve, nothing moved, and the only honest alternative
/// (clearing the banner) would have been worse, because the run is still
/// parked waiting for an answer that never arrived.
///
/// The activity keeps the request's `kind` so the reducer does NOT clear the
/// pending entry; it carries the error for display and reuses the request's
/// stable id so the row is replaced rather than stacked.
async fn publish_approval_failed(
    state: &AppState,
    thread_id: &str,
    request_id: &str,
    detail: &str,
) -> Result<(), String> {
    event_adapter::t3_projector(state.rt.clone())
        .project(Lifecycle::ApprovalFailed {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            detail: detail.to_string(),
        })
        .await
}

/// The mirror for an answer to the agent's question that could not be
/// delivered. The composer stays blocked — which is the truth, the agent is
/// still waiting — and the user is told why instead of watching a submit
/// disappear.
async fn publish_user_input_failed(
    state: &AppState,
    thread_id: &str,
    session_id: &str,
    detail: &str,
) -> Result<(), String> {
    event_adapter::t3_projector(state.rt.clone())
        .project(Lifecycle::UserInputFailed {
            thread_id: thread_id.to_string(),
            session_id: session_id.to_string(),
            detail: detail.to_string(),
        })
        .await
}

/// Recompute source-control status for `cwd` and push it to every subscriber
/// watching that directory.
///
/// Called after each mutating VCS command and by cairn's status watch, so the
/// panel tracks the repository whether it moved because of us or because the
/// user ran git in their own terminal.
async fn publish_vcs_status(state: &AppState, cwd: &str) {
    let local = vcs::status(cwd).await;
    let snapshot = vcs::status_snapshot(cwd).await;
    let remote = snapshot.get("remote").cloned().unwrap_or(Value::Null);
    publish_vcs_status_parts(state, cwd, local, remote).await;
}

async fn publish_vcs_status_from_cairn(state: &AppState, cwd: &str, status: &cairn::Status) {
    let local = vcs::status_from(status);
    let snapshot = vcs::status_snapshot_from(status);
    let remote = snapshot.get("remote").cloned().unwrap_or(Value::Null);
    publish_vcs_status_parts(state, cwd, local, remote).await;
}

async fn publish_vcs_status_parts(state: &AppState, cwd: &str, local: Value, remote: Value) {
    // Publish through the SDK's per-cwd durable topic (#335 / packet DM):
    // a second backend process attached to this isolate delivers the frame
    // to every subscriber on this cwd. The old process-local `Vec<Sender>`
    // fanout only reached this process, so a VCS mutation issued by another
    // window left every other subscriber stale until reconnect.
    for item in [
        json!({"_tag": "localUpdated", "local": local}),
        json!({"_tag": "remoteUpdated", "remote": remote}),
    ] {
        if let Err(e) = state.rt.vcs_publish(cwd, &item).await {
            tracing::error!(%e, %cwd, "vcs publish failed — subscribers may miss this update");
        }
    }
    // No socket-prune / watch-release bookkeeping here anymore (packet DM).
    // Release-on-last-watcher is a DURABLE claim, dropped by the pump-close
    // callback in `spawn_thread_tail_with_cleanup` — which is where "this
    // subscriber went away" is actually observable. The old shape only
    // noticed on the NEXT publish, which never came for a repository that had
    // gone quiet, and it counted only THIS process's sockets.
}

/// Watch every subscribed working tree for changes nobody told us about.
///
/// A user committing or switching branches in their OWN terminal must move the
/// panel too, so post-mutation emission alone is not enough. This publishes
/// only when the status actually CHANGED — an unconditional periodic push would
/// make the client re-render on a timer and drown real transitions in noise.
fn spawn_vcs_watcher(state: AppState) {
    tokio::spawn(async move {
        // One task per watched working tree, parked on cairn's filesystem edge
        // rather than a shared timer. The panel now moves on the commit instead
        // of up to an interval after it, and a repository nobody is touching
        // costs nothing at all — the old loop ran `git status` on every watched
        // tree, forever, whether or not anything had happened.
        let mut running: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
        let mut subs = state.vcs_watch_changed.subscribe();
        loop {
            // Each watched tree, paired with the fingerprint its FIRST (oldest)
            // subscriber was given. Publishing against the oldest is the safe
            // direction: a newer subscriber has already seen everything the
            // oldest has, so it can receive a repeat, but nobody can miss one.
            let watched: Vec<(String, String)> = match state.rt.watch_marks("vcs").await {
                Ok(w) => w,
                // FAIL-CLOSED: a failed read is not "nothing is watched". Tearing
                // every watch down on a transient store error would leave every
                // panel frozen with no error anywhere — the failure mode this
                // whole finding is about. Keep what is running and retry on the
                // next wake.
                Err(e) => {
                    tracing::error!(%e, "vcs watch registry unreadable; keeping current watches");
                    if subs.changed().await.is_err() {
                        return;
                    }
                    continue;
                }
            };
            // Drop the watch for a tree nobody is subscribed to any more, and
            // for one whose task has ended (an unwatchable path); the next pass
            // re-creates the latter if a subscriber is still there.
            running.retain(|cwd, h| {
                let keep = watched.iter().any(|(c, _)| c == cwd) && !h.is_finished();
                if !keep {
                    h.abort();
                }
                keep
            });
            for (cwd, seen) in watched {
                if running.contains_key(&cwd) {
                    continue;
                }
                running.insert(
                    cwd.clone(),
                    tokio::spawn(watch_one_tree(state.clone(), cwd, seen, None)),
                );
            }
            // Wait for the subscriber set to move. This is the only thing this
            // task does now — the per-tree tasks own the actual change edges.
            if subs.changed().await.is_err() {
                return;
            }
        }
    });
}

/// Publish `cwd`'s source-control status whenever the repository actually moves.
///
/// Parks on cairn's status watch. Cairn owns both the low-level filesystem edge
/// and the status reconciliation that decides whether that edge matters, so the
/// product backend only publishes typed statuses it is handed.
async fn watch_one_tree(
    state: AppState,
    cwd: String,
    baseline: String,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) {
    let Some(repo) = cairn::Repo::detect(std::path::Path::new(&cwd)).await else {
        return;
    };
    let mut watch = match repo.watch_status_from(baseline).await {
        Ok(Some(start)) => {
            if let Some(status) = start.changed_since_baseline {
                publish_vcs_status_from_cairn(&state, &cwd, &status).await;
            }
            start.watch
        }
        Ok(None) => {
            tracing::warn!(%cwd, "no filesystem watch available; vcs panel will update on commands only");
            return;
        }
        Err(e) => {
            tracing::warn!(%cwd, %e, "could not place status watch; publishing unavailable status");
            publish_vcs_status(&state, &cwd).await;
            return;
        }
    };
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    while let Some(status) = watch.changed().await {
        match status {
            Ok(status) => publish_vcs_status_from_cairn(&state, &cwd, &status).await,
            Err(e) => {
                tracing::warn!(%cwd, %e, "vcs status watch could not read status");
                publish_vcs_status(&state, &cwd).await;
            }
        }
    }
}

/// Publish a `subscribeServerConfig` event to every live subscriber.
///
/// Called after any write that changes what `server.getConfig` would return.
/// The command's own return value is NOT the source of truth for the rest of
/// the UI — surfaces that never issued the command read the projection this
/// stream feeds.
/// Build one `ServerConfigStreamEvent`.
///
/// The client decodes this stream against a tagged union and switches on
/// `event.type`, reading the body from `event.payload`
/// (`packages/client-runtime/src/state/server.ts` — `applyServerConfigProjection`).
/// This used to emit `{"kind": …}` with the body inlined at the top level, which
/// matches NO arm of that union: every settings write and provider-status push
/// was dropped on decode, so passive surfaces kept rendering stale config until
/// the next full reconnect. The shape is the contract's, not ours.
fn config_event(kind: &str, payload: Value) -> Value {
    json!({ "version": 1, "type": kind, "payload": payload })
}

/// The snapshot arm carries `config` directly instead of `payload`.
fn config_snapshot_event(config: Value) -> Value {
    json!({ "version": 1, "type": "snapshot", "config": config })
}

async fn publish_config(state: &AppState, item: Value) {
    // Every settings/provider/keybindings mutation goes through the SDK's
    // durable config topic (packet DL). A second backend process attached to
    // the same isolate observes the frame; the old `Vec<Sender>` fanout only
    // reached this process, so cross-process mutations left every passive
    // surface stale until reconnect. Failure is loud: a broker publish that
    // cannot land is not a silent no-op — a subscriber that expected to see
    // this frame would otherwise be told nothing and act on stale config.
    if let Err(e) = state.rt.config_publish(&item).await {
        tracing::error!(%e, "config publish failed — subscribers may miss this update");
    }
}

impl AppState {
    /// The model a turn with NO explicit selection runs, derived from the LIVE
    /// catalog every time it is asked (#225).
    ///
    /// The catalog is reconciled while the server runs — a provider added or
    /// disabled in settings, Ollama appearing — and turn admission must agree
    /// with what the picker and the thread metadata show. A value frozen at boot
    /// drifts the moment settings change, and the drift is invisible: the UI
    /// names one provider while the turn runs another. `None` stays a real state
    /// (no routable provider), refused visibly rather than substituted.
    async fn default_model(&self) -> Option<ModelRef> {
        let catalog = self.catalog.read().await;
        // No fallback to the boot value on purpose: if the live catalog can no
        // longer route anything, the honest answer is "nothing", refused
        // visibly — not the model the server happened to see at startup.
        providers::default_model(&catalog)
    }

    /// Admit a pane's requested directory through the SAME authority seam file
    /// and git operations use.
    ///
    /// A terminal is a shell: handing it a client-supplied `cwd`/`worktreePath`
    /// unchecked gives the frontend a PTY anywhere the backend user can write,
    /// while every other RPC refuses paths outside the workspace and its
    /// worktrees. A live, cancellable PTY is only useful if it obeys the same
    /// boundary (#179). `None` on both means the workspace itself.
    async fn admit_pane_dir(
        &self,
        cwd: Option<&str>,
        worktree: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), String> {
        let admit = |p: &str| {
            let root = self.cwd.clone();
            let p = p.to_string();
            async move { vcs::resolve_cwd(&p, &root).await }
        };
        let worktree = match worktree.filter(|s| !s.is_empty()) {
            Some(w) => Some(admit(w).await?),
            None => None,
        };
        let cwd = match cwd.filter(|s| !s.is_empty()) {
            Some(c) => Some(admit(c).await?),
            None => None,
        };
        Ok((cwd, worktree))
    }

    /// The runner behind a pane. An id nobody opened resolves to the AGENT's
    /// shell rather than erroring: the frontend's default pane is the one the
    /// agent works in, and a write that silently went nowhere would be worse
    /// than one that went to the shared shell.
    /// The runner for a pane, addressed by its OWNER (#149).
    ///
    /// This took a bare `thread_id`, so `terminal.write` / `resize` / `clear`
    /// for a child session's PTY resolved against the PARENT thread and either
    /// typed into the wrong shell or silently fell through to the shared
    /// workspace terminal. Keying the lookup by owner is the difference between
    /// addressing a subagent's shell and addressing something that merely
    /// answers.
    async fn pane_runner(&self, owner: &terminal::TerminalOwner, terminal_id: &str) -> Result<terminal::Terminal, String> {
        match self.terminals.get(owner, terminal_id).await {
            Ok(Some(pane)) => Ok(pane.runner),
            Ok(None) => Ok(self.terminal.clone()),
            Err(e) => Err(e),
        }
    }
}

/// Broker topic every `subscribeTerminalEvents` frame lands on.
const TERMINAL_EVENTS_TOPIC: &str = "t3:terminals";

/// Broker topic every `subscribeTerminalMetadata` frame for `thread_id` lands on.
fn terminal_meta_topic(thread_id: &str) -> String {
    format!("t3:terminal-meta:{thread_id}")
}

/// Fan a terminal lifecycle event out through the SDK broker, and refresh the
/// metadata topic for the same thread. Every fanout now goes through
/// `ThreadRuntime::topic_publish` on a product-named topic — the process-local
/// `Vec<Sender>` used to leak a dead subscriber on every reconnect, and a
/// second backend process attached to the same isolate never saw the frame.
async fn broadcast_terminal_event(state: &AppState, event: Value) {
    if let Err(e) = state.rt.topic_publish(TERMINAL_EVENTS_TOPIC, &event).await {
        tracing::error!(%e, "terminal event publish failed");
    }

    let thread = event
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // Built ONCE for the thread rather than per subscriber: every watcher of a
    // thread receives the same rows, and each row costs a PTY session lock.
    let now = now_iso();
    let payload = match state.terminals.list(&terminal::TerminalOwner::thread(&thread)).await {
        Ok(panes) => {
            let mut rows = Vec::new();
            for pane in panes {
                rows.push(terminal::pane_summary(&pane, &now).await);
            }
            json!({ "type": "snapshot", "terminals": rows })
        }
        Err(e) => json!({
            "type": "store_unavailable",
            "threadId": thread,
            "terminals": Value::Null,
            "error": format!("terminal pane store unavailable: {e}"),
        }),
    };
    let topic = terminal_meta_topic(&thread);
    if let Err(e) = state.rt.topic_publish(&topic, &payload).await {
        tracing::error!(%e, %thread, "terminal metadata publish failed");
    }
}

/// Drive a thread's durable tail onto an open stream request.
///
/// One implementation for both entry points — the snapshot path and the
/// resume-from-sequence path — so the ack rule cannot drift between them: an
/// item is acked only after the WRITER confirms the websocket sink accepted the
/// frame, never on mere enqueue. A closed socket returns without acking, so the
/// item stays in the durable inbox for the next subscriber (#16).
fn spawn_thread_tail(
    tail: agent_sdk_shell::ThreadTail,
    tx: mpsc::UnboundedSender<OutFrame>,
    req: Value,
    thread_id: String,
) {
    spawn_thread_tail_with_cleanup(tail, tx, req, thread_id, async move {});
}

/// A tail pump that runs `on_close` (once) after it exits — used by VCS to
/// decrement a per-cwd refcount and release the durable watch when the last
/// subscriber for that tree has gone. Without a signal here, the product
/// would have to poll a `Vec<Sender>` for closed sockets on every publish
/// (the old shape); with it, cleanup is edge-driven off the pump task itself.
fn spawn_thread_tail_with_cleanup<F>(
    tail: agent_sdk_shell::ThreadTail,
    tx: mpsc::UnboundedSender<OutFrame>,
    req: Value,
    thread_id: String,
    on_close: F,
) where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let sink = WsThreadSink { tx: tx.clone(), req: req.clone() };
        loop {
            match tail.next(std::time::Duration::from_secs(25)).await {
                Ok(items) => {
                    let mut hi = -1_i64;
                    for (seq, item) in items {
                        let frame = json!({ "_tag": "Chunk", "clientId": 0, "requestId": req, "values": [item] }).to_string();
                        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                        if tx.send((frame, Some(done_tx))).is_err() {
                            tail.close().await;
                            on_close.await;
                            return;
                        }
                        match done_rx.await {
                            Ok(true) => hi = seq,
                            _ => {
                                tail.close().await;
                                on_close.await;
                                return;
                            }
                        }
                    }
                    if hi >= 0 {
                        // A DROPPED ACK IS A SILENT REPLAY (#96). The socket
                        // took the frames, the durable cursor did not move, and
                        // the next reconnect re-delivers everything already
                        // shown. Surface it and close, rather than continuing to
                        // stream against a cursor that is no longer advancing.
                        if let Err(e) = tail.ack(hi).await {
                            let frame = json!({
                                "_tag": "Chunk", "clientId": 0, "requestId": req,
                                "values": [{ "error": {
                                    "message": format!("thread subscription failed: {e}")
                                }}],
                            })
                            .to_string();
                            let _ = tx.send((frame, None));
                            tail.close().await;
                            on_close.await;
                            return;
                        }
                    }
                }
                Err(_) => {
                    tail.close().await;
                    on_close.await;
                    return;
                }
            }
        }
    });
}

/// The provider snapshots the UI renders, from the live catalog.
async fn provider_entries(state: &AppState) -> Vec<Value> {
    state
        .catalog
        .read()
        .await
        .snapshots()
        .iter()
        .map(provider_entry)
        .collect()
}

// Frontend event-shape adaptation lives in its own module (#403): the T3
// wire vocabulary, the projectors that carry it, and the summary helpers
// its payloads need. No runtime authority moved — see the module doc.
mod event_adapter;
use event_adapter::*;

async fn handle_socket(socket: WebSocket, state: AppState) {
    tracing::info!("ws: client connected");
    let (mut sink, mut stream) = socket.split();
    // Outbound frames funnel through this channel so turn tasks can push
    // events while the read loop is parked on `recv`.
    let (tx, mut rx) = mpsc::unbounded_channel::<OutFrame>();
    let writer = tokio::spawn(async move {
        while let Some((text, done)) = rx.recv().await {
            let ok = sink.send(Message::Text(text.into())).await.is_ok();
            // Confirm delivery ONLY after the sink accepted the frame — a
            // subscriber that requested confirmation acks on this signal, not on
            // mere enqueue, so an event is never acked before it left the server.
            if let Some(done) = done {
                let _ = done.send(ok);
            }
            if !ok {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let frame: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        // #385: a Text frame that is not JSON is a client bug,
                        // but silence is OUR bug — the caller's next request
                        // rides the same socket and will wait forever for a
                        // reply it will never get. Log it visibly AND emit a
                        // top-level `Error` frame so a client can render
                        // "protocol mismatch" instead of "still loading". We
                        // do not have a requestId to attach to an Exit, so
                        // the frame is a distinct `_tag:"Error"` — a client
                        // that does not understand it can safely ignore, but
                        // one that does can surface a diagnosable failure.
                        tracing::warn!(bytes = text.len(), %e, "ws: dropped a Text frame that is not JSON");
                        let _ = tx.send((
                            json!({
                                "_tag": "Error",
                                "kind": "malformed-json",
                                "message": format!("frame is not valid JSON: {e}"),
                            })
                            .to_string(),
                            None,
                        ));
                        continue;
                    }
                };
                dispatch_ws_frame(frame, &tx, &state).await;
            }
            Message::Close(_) => break,
            other => {
                // Ping/Pong/Binary — the ws stack handles Ping frames itself,
                // and this backend has no binary protocol. Logging the type
                // gives a debug seam for a client that starts sending Binary
                // where Text was expected.
                tracing::debug!(kind = ?std::mem::discriminant(&other), "ws: ignored a non-Text non-Close frame");
            }
        }
    }
    tracing::info!("ws: client closed");
    writer.abort();
}

/// Route one already-decoded WebSocket Text frame. Extracted so tests can
/// exercise every `_tag` arm (including #411's Ack + Interrupt) without
/// standing up the full axum serve loop.
pub(crate) async fn dispatch_ws_frame(
    frame: Value,
    tx: &mpsc::UnboundedSender<OutFrame>,
    state: &AppState,
) {
    match frame.get("_tag").and_then(|t| t.as_str()) {
        Some("Ping") => {
            let _ = tx.send((r#"{"_tag":"Pong"}"#.into(), None));
        }
        Some("Request") => {
            handle_request(&frame, tx, state).await;
        }
        Some("Ack") => {
            // #411: Effect RPC's stream-flow-control frame. The client
            // sends one per received chunk so a server can apply
            // backpressure. This runtime's chunk fanout is an unbounded
            // `mpsc` per WS connection: memory is bounded by the socket
            // writer's ability to drain (which is what the done-oneshot on
            // every chunk in `spawn_thread_tail` already couples ack-of-
            // delivery to), and there is no upstream slowdown-signal we
            // could apply back to the SDK's durable pubsub even if we
            // wanted to. So Ack is recognized + no-op rather than dropped-
            // with-a-warning.
            //
            // Recognizing it here is deliberate, not silencing (#385):
            // dropped, this frame emitted an "unknown _tag" WARN on every
            // stream chunk on the wire; now it emits nothing, which is
            // honest given the runtime has nothing to do with the
            // information. When durable-inbox flow-control lands, this
            // arm becomes the seam where the client's cursor feeds the
            // tail's `ack(seq)` call.
        }
        Some("Interrupt") => {
            // #411: cancel an in-flight request. The Effect RPC client
            // sends this when the user presses stop; a silent drop lets
            // the model burn tokens after the UI has already moved on.
            // The Effect frame carries `requestId`; for a turn request
            // the frame also repeats the `threadId` (Effect RPC embeds
            // the original payload for context) so we can route the
            // interrupt to `ThreadRuntime::interrupt` — the same path
            // `thread.turn.interrupt` uses. If no threadId is
            // discoverable, we log and drop with a named reason instead
            // of silently.
            let req_id = frame.get("requestId").cloned().unwrap_or(Value::Null);
            let thread_id = frame
                .pointer("/payload/input/threadId")
                .or_else(|| frame.pointer("/payload/threadId"))
                .or_else(|| frame.get("threadId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(thread_id) = thread_id {
                tracing::info!(%thread_id, ?req_id, "ws: Interrupt — routing to runtime");
                if let Err(e) = stop_thread_checked(state, &thread_id, "thread.turn.interrupt").await {
                    tracing::error!(%thread_id, ?req_id, %e, "ws interrupt failed");
                    if !req_id.is_null() {
                        exit_failure(tx, &req_id, &format!("interrupt failed: {e}"));
                    }
                }
            } else {
                tracing::warn!(
                    ?req_id,
                    "ws: Interrupt with no threadId — cannot route to a specific turn"
                );
            }
        }
        other => {
            // #385: an unknown `_tag` is either a client version
            // mismatch or a frame the server does not implement.
            // Log the tag so an operator can see the drift, and if
            // the frame carried a `requestId` (or `id`), refuse it
            // visibly so the caller is not wedged waiting for the
            // Exit that will never come.
            let tag = other.unwrap_or("<missing>");
            tracing::warn!(tag, "ws: dropped a Text frame with unknown _tag");
            let req_id = frame
                .get("requestId")
                .cloned()
                .filter(|v| !v.is_null())
                .or_else(|| frame.get("id").cloned().filter(|v| !v.is_null()));
            if let Some(req_id) = req_id {
                exit_failure(tx, &req_id, &format!("unknown WS frame _tag: {tag}"));
            } else {
                let _ = tx.send((json!({
                    "_tag": "Error",
                    "kind": "unknown-tag",
                    "message": format!(
                        "unknown frame _tag={tag:?}; expected \"Ping\" | \"Request\" | \"Ack\" | \"Interrupt\""
                    ),
                }).to_string(), None));
            }
        }
    }
}

async fn stop_thread_checked(
    state: &AppState,
    thread_id: &str,
    kind: &str,
) -> Result<Vec<String>, String> {
    // A stop has TWO legs — hearth's foreground interrupt and the SDK's durable
    // cancel — and they fail independently. Short-circuiting on the first one
    // let a dead PTY mask an unwritten durable cancel: the user saw "stop
    // failed" for the shell while the turn kept running with nothing recorded.
    // So attempt both, and report every leg that failed.
    let shell = terminal::interrupt(&state.terminal)
        .await
        .map_err(|e| format!("terminal interrupt failed: {e}"));
    let runtime = if kind == "thread.session.stop" {
        state.rt.stop(thread_id).await
    } else {
        state.rt.interrupt(thread_id).await
    }
    .map_err(|e| format!("runtime cancel failed: {e}"));

    let (shell_out, sessions) = match (shell, runtime) {
        (Ok(out), Ok(sessions)) => (out, sessions),
        (shell, runtime) => {
            let mut legs = Vec::new();
            if let Err(e) = shell {
                legs.push(e);
            }
            if let Err(e) = runtime {
                legs.push(e);
            }
            return Err(legs.join("; "));
        }
    };
    if shell_out.starts_with("ERROR:") {
        return Err(format!("terminal interrupt failed: {shell_out}"));
    }
    Ok(sessions)
}

/// Send the terminal Exit(Success{value}) for a non-stream RPC.
fn exit_success(tx: &mpsc::UnboundedSender<OutFrame>, request_id: &Value, value: Value) {
    let _ = tx.send((json!({ "_tag": "Exit", "requestId": request_id, "exit": { "_tag": "Success", "value": value } }).to_string(), None));
}

/// Send a terminal Exit(Failure) with a `Die` cause — the protocol's channel
/// for an unrecoverable defect. Used so an UNIMPLEMENTED RPC surfaces as a real
/// failure the client can see, instead of a masking `Success(null)` that lets
/// the reducer advance past behavior this backend never performed.
fn exit_failure(tx: &mpsc::UnboundedSender<OutFrame>, request_id: &Value, message: &str) {
    let _ = tx.send((
        json!({
            "_tag": "Exit", "requestId": request_id,
            "exit": { "_tag": "Failure", "cause": [{ "_tag": "Die", "defect": message }] }
        })
        .to_string(),
        None,
    ));
}

/// Fail a request with a DECLARED, tagged error from the RPC's error channel.
///
/// Distinct from [`exit_failure`], which reports a `Die` defect — an unexpected
/// crash the client has no branch for. A declared error is part of the
/// contract, so it travels as `Fail` carrying the tagged value intact.
fn exit_typed_failure(tx: &mpsc::UnboundedSender<OutFrame>, request_id: &Value, error: Value) {
    let _ = tx.send((
        json!({
            "_tag": "Exit", "requestId": request_id,
            "exit": { "_tag": "Failure", "cause": [{ "_tag": "Fail", "error": error }] }
        })
        .to_string(),
        None,
    ));
}

/// Push one stream value as a Chunk on an open stream request.
fn chunk(tx: &mpsc::UnboundedSender<OutFrame>, request_id: &Value, value: Value) {
    let _ = tx.send((
        json!({ "_tag": "Chunk", "clientId": 0, "requestId": request_id, "values": [value] })
            .to_string(),
        None,
    ));
}

/// A bounded excerpt around a search hit, with the match inside it.
///
/// The contract caps a snippet at 240 chars; taking the head of the message
/// instead would routinely return text that does not contain what the user
/// searched for.
fn snippet_around(text: &str, at: usize, len: usize) -> String {
    const WINDOW: usize = 240;
    let lead = 60usize;
    // char boundaries, not byte arithmetic: a snippet that splits a multi-byte
    // character is not a string.
    let start = text[..at]
        .char_indices()
        .rev()
        .take(lead)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(at);
    let mut out: String = text[start..].chars().take(WINDOW).collect();
    if start > 0 {
        out.insert(0, '\u{2026}');
    }
    let _ = len;
    out
}

/// The worktree a thread's turns edit — its own when it has one, else the
/// workspace. The diff has to be read from the tree the agent wrote to.
async fn thread_cwd(state: &AppState, thread_id: &str) -> Result<String, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId is required".into());
    }
    let Some(record) = state
        .rt
        .thread_record(thread_id)
        .await
        .map_err(|e| format!("thread mapping unreadable: {e}"))?
    else {
        return Err(format!("unknown thread: {thread_id}"));
    };
    Ok(record
        .worktree_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| state.cwd.clone()))
}

/// Turn checkpoints (#65/#376) — review and revert, on CAIRN.
///
/// The first version of this drove `agent_sdk_branch::Checkpoints` from here.
/// That was a second checkpoint substrate: `cairn::Stack` already owns
/// snapshot/list/diff/rewind over a screened, pinned git seam with retention
/// and gc, and the product was reimplementing the same thing one repo away
/// (#376). Everything below is now argument marshalling and wire shape. The
/// change-list and restore AUTHORITY is cairn's.
///
/// A checkpoint timestamp (epoch millis) as the contract's ISO string.
fn iso_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Open the cairn stack for a worktree, or say why not.
///
/// `Unavailable` is NOT folded into "no repository": a `.git` that git cannot
/// read is a repository whose checkpoints are broken, and treating it as an
/// unversioned directory is how a turn runs with no undo and nobody notices.
async fn checkpoint_stack(
    state: &AppState,
    cwd: &str,
) -> Result<Option<agent_sdk_branch::Checkpoints>, String> {
    // THROUGH THE SDK, not straight at cairn (#376). The product held a
    // `cairn::Stack` and drove snapshot/list/diff/rewind itself, which is
    // checkpoint LIFECYCLE AUTHORITY in the product layer — the same defect as
    // the hand-rolled git plumbing it replaced, one repo further down. cairn
    // still owns the mechanics; `agent_sdk_branch::Checkpoints` is the
    // product-neutral contract over it, and everything below this line is wire
    // shape.
    //
    // The exclusions are passed IN because the names are ours: `.t3code-agent`
    // and `data/` mean nothing to an SDK meant to serve any coding agent.
    let cp = agent_sdk_branch::Checkpoints::open_excluding(
        std::path::Path::new(cwd),
        state.checkpoints_dir.as_path(),
        &agent_data_excludes(),
    )
    .await;
    if cp.enabled() {
        return Ok(Some(cp));
    }
    // `Unavailable` is NOT folded into "no repository": a `.git` git cannot read
    // is a repository whose checkpoints are broken, and treating it as an
    // unversioned directory is how a turn runs with no undo and nobody notices.
    match cp.unavailable_reason() {
        Some(why) if !why.contains("git init") => Err(why.to_string()),
        _ => Ok(None),
    }
}

/// Add the runtime's own state directories to a cairn config's exclusions.
///
/// Pathspecs, not absolute paths: the same workspace can be opened at different
/// absolute roots (a worktree, a container mount) and the runtime data dir is
/// named relative to it either way.
fn agent_data_excludes() -> Vec<String> {
    let (_, agent_data) = workspace_paths();
    let name = agent_data
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".t3code-agent".to_string());
    vec![
        format!(":(glob){name}/**"),
        name,
        // The test/default layouts put the isolates under `data/`; excluding it
        // by name keeps a workspace-embedded data dir out of every review.
        ":(glob)data/**".to_string(),
        ":(glob)**/*.db-wal".to_string(),
        ":(glob)**/*.db-tshm".to_string(),
    ]
}

/// This product's answer to "where does the change-set for `cwd` live" —
/// nothing more (#376/#403).
///
/// WHEN a snapshot is taken, what it is LABELLED with, whether "before or
/// after" the model runs, and what a failure costs are all turn lifecycle, and
/// they live in `agent_sdk_shell::CheckpointingProjector`. This type cannot
/// express any of them: `TurnCheckpointer` hands it a `turn_id` and asks for a
/// snapshot. That is the whole product surface.
struct WorkspaceCheckpointer {
    state: AppState,
    cwd: String,
}

#[async_trait::async_trait]
impl agent_sdk_shell::TurnCheckpointer for WorkspaceCheckpointer {
    async fn checkpoint_turn_start(&self, turn_id: &str) -> Result<(), String> {
        match checkpoint_stack(&self.state, &self.cwd).await {
            Ok(Some(cp)) => cp.snapshot_turn(turn_id).await.map_err(|e| e.to_string()),
            // A workspace with no repository is not an error — there is simply
            // nothing to snapshot. The SDK contract says so explicitly.
            Ok(None) => {
                tracing::debug!(%turn_id, "no repository — turn is not checkpointed");
                Ok(())
            }
            Err(why) => Err(format!("checkpoint substrate unavailable: {why}")),
        }
    }

    async fn revert_workspace(&self, turn_count: usize) -> Result<Vec<String>, String> {
        // "No repository" is an ERROR here where it is benign for a snapshot:
        // the user asked for their files back, and a silent Ok would tell them
        // it happened.
        let cp = match checkpoint_stack(&self.state, &self.cwd).await {
            Ok(Some(cp)) => cp,
            Ok(None) => {
                return Err(
                    "this workspace is not a git repository, so there is nothing to revert to"
                        .into(),
                )
            }
            Err(why) => return Err(format!("checkpoint substrate unavailable: {why}")),
        };
        // WHICH turns are about to go, read BEFORE the rewind — afterwards
        // their checkpoints no longer exist to be named. `turn_summaries` is
        // newest-first with 1-based counts, which is the same ordinal the wire
        // sent, so the first `turn_count` of them are exactly the ones
        // `revert_turns` is about to undo.
        let doomed: Vec<String> = cp
            .turn_summaries()
            .await
            .map_err(|e| format!("checkpoint history unreadable: {e}"))?
            .into_iter()
            .filter(|t| t.turn_count <= turn_count)
            .map(|t| t.turn_id)
            .collect();
        cp.revert_turns(turn_count).await?;
        Ok(doomed)
    }
}

/// The projector a turn runs under: this product's wire vocabulary, wrapped in
/// the SDK's checkpoint trigger.
///
/// Extracted so a test can exercise the SAME value `run_turn` uses (#350). A
/// test that reaches past this and snapshots directly proves only that the
/// substrate works — it stays green if the projector is unwired, runs late, or
/// is handed the wrong cwd, which are the three ways this boundary breaks.
fn turn_projector(
    state: &AppState,
    cwd: String,
) -> agent_sdk_shell::CheckpointingProjector<event_adapter::T3Projector, WorkspaceCheckpointer> {
    agent_sdk_shell::CheckpointingProjector::new(
        event_adapter::t3_projector(state.rt.clone()),
        WorkspaceCheckpointer {
            state: state.clone(),
            cwd,
        },
    )
}

/// The `OrchestrationCheckpointSummary` list a thread snapshot carries.
///
/// Everything about what a turn is — the label convention, newest-first 1-based
/// counting, which snapshots count as turns, and how the count round-trips a
/// revert — lives in `agent_sdk_branch::Checkpoints::turn_summaries` (#376).
/// This function is pure wire-shape marshalling onto the T3 contract.
async fn checkpoint_summaries(state: &AppState, cwd: &str) -> Result<Vec<Value>, String> {
    let checkpoints = match checkpoint_stack(state, cwd).await {
        Ok(Some(checkpoints)) => checkpoints,
        Ok(None) => return Ok(Vec::new()),
        Err(e) => return Err(format!("checkpoint substrate unavailable: {e}")),
    };
    Ok(checkpoints
        .turn_summaries()
        .await
        .map_err(|e| format!("checkpoint history unreadable: {e}"))?
        .into_iter()
        .map(|t| {
            let (status, files) = if t.readable {
                (
                    "ready",
                    t.files
                        .into_iter()
                        .map(|f| {
                            json!({
                                "path": f.path,
                                "kind": f.kind,
                                "additions": f.additions,
                                "deletions": f.deletions,
                            })
                        })
                        .collect::<Vec<_>>(),
                )
            } else {
                // `readable: false` is NOT "this turn changed nothing" — it is
                // "we could not read what it changed". A different claim, and
                // the UI renders it differently.
                ("error", Vec::new())
            };
            json!({
                "turnId": t.turn_id,
                "checkpointTurnCount": t.turn_count,
                // #396: the durable handle the caller can HOLD is the SDK's
                // `git_ref`, not a raw commit sha (which becomes unreachable
                // garbage as soon as retention deletes the ref).
                "checkpointRef": t.git_ref,
                "status": status,
                "files": files,
                "assistantMessageId": Value::Null,
                // The checkpoint's OWN timestamp, not `now`.
                "completedAt": iso_ms(t.ts),
            })
        })
        .collect())
}

/// Revert the worktree `turn_count` turns back and tell the thread.
///
/// The count → checkpoint mapping lives in the SDK (`revert_turns`, #376): the
/// same source of truth `turn_summaries` uses to advertise `checkpointTurnCount`,
/// so the round trip cannot drift. This function is thread-side notification.
async fn revert_checkpoint(
    state: &AppState,
    thread_id: &str,
    turn_count: i64,
) -> Result<(), String> {
    let cwd = match thread_cwd(state, thread_id).await {
        Ok(cwd) => cwd,
        Err(e) => {
            let reason = e.clone();
            let _ = emit_thread_event(
                &state.rt,
                thread_id,
                "thread.activity-appended",
                json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("revert:{thread_id}:{turn_count}"),
                        "tone": "error",
                        "kind": "checkpoint.revert-failed",
                        "summary": format!("Could not revert: {e}"),
                        "payload": { "turnCount": turn_count, "error": e },
                        "createdAt": now_iso(),
                    },
                }),
            )
            .await;
            // The activity event tells the THREAD what happened; the caller
            // still needs the failure so the command itself does not report
            // success to the client that asked for the revert.
            return Err(reason);
        }
    };
    // The MEANING of a revert — files, transcript, turn ordinals, in-flight
    // marker, and the order they must move in — belongs to the runtime, not to
    // this handler (#65/#376). This function's whole job is the T3 wire shape:
    // resolve the thread's cwd, hand the runtime a checkpointer that knows
    // where the change-set lives, and turn the result into events the client
    // speaks. Previously it called `revert_turns` on the checkpoint stack
    // directly, which reverted the FILES and nothing else.
    let outcome: Result<(), String> = async {
        if turn_count <= 0 {
            return Err(format!("no checkpoint covers {turn_count} turn(s) back"));
        }
        let checkpointer = WorkspaceCheckpointer {
            state: state.clone(),
            cwd: cwd.clone(),
        };
        state
            .rt
            .revert_thread_to_turn(thread_id, turn_count as usize, &checkpointer)
            .await
            .map(|_| ())
    }
    .await;

    match outcome {
        Ok(()) => {
            tracing::info!(%thread_id, turn_count, "reverted to checkpoint");
            emit_thread_event(
                &state.rt,
                thread_id,
                "thread.reverted",
                json!({ "threadId": thread_id, "turnCount": turn_count }),
            )
            .await
            .map_err(|e| format!("checkpoint revert completed but thread.reverted could not be recorded: {e}"))?;
            // The worktree moved under every source-control subscriber too.
            publish_vcs_status(state, &cwd).await;
            Ok(())
        }
        Err(e) => {
            // A revert the user asked for that did not happen must be VISIBLE.
            // Saying nothing leaves them believing their files were restored.
            tracing::error!(%thread_id, turn_count, %e, "revert failed");
            emit_thread_event(
                &state.rt,
                thread_id,
                "thread.activity-appended",
                json!({
                    "threadId": thread_id,
                    "activity": {
                        "id": format!("revert:{thread_id}:{turn_count}"),
                        "tone": "error",
                        "kind": "checkpoint.revert-failed",
                        "summary": format!("Could not revert: {e}"),
                        "payload": { "turnCount": turn_count, "error": e },
                        "createdAt": now_iso(),
                    },
                }),
            )
            .await
            .map_err(|emit| format!("checkpoint revert failed ({e}) and checkpoint.revert-failed could not be recorded: {emit}"))?;
            Err(e)
        }
    }
}

/// Open the durable resource-sample history (#336).
///
/// A history that cannot be opened is fatal at boot rather than silently
/// degraded to no history at all: the Diagnostics panel is the screen an
/// operator opens when something is already wrong, and a panel that renders
/// "nothing happened" because its store failed to open is worse than one that
/// is honestly absent.
async fn open_diag_history(agent_data: &std::path::Path) -> agent_sdk_metrics::ResourceHistory {
    const RETAIN_MS: i64 = 24 * 60 * 60 * 1000;
    // The SHARED product-state isolate, not a second one of its own. The
    // history is a table set, not a durability domain — and every extra isolate
    // is 5 descriptors an `AppState` pays before it does any work.
    let db = tools::product_state_db(agent_data).await;
    agent_sdk_metrics::ResourceHistory::open(db, RETAIN_MS)
        .await
        .expect("open the resource history")
}

async fn handle_request(frame: &Value, tx: &mpsc::UnboundedSender<OutFrame>, state: &AppState) {
    let method = frame.get("tag").and_then(|t| t.as_str()).unwrap_or("");
    let id = frame.get("id").cloned().unwrap_or(Value::Null);
    let payload = frame.get("payload").cloned().unwrap_or(json!({}));
    tracing::info!(method, %id, "ws: REQUEST");

    match method {
        "server.getConfig" => {
            // Read the stored rules BEFORE taking the catalog lock: the config
            // body needs both, and holding the lock across an await would let a
            // concurrent settings write stall every boot handshake.
            let custom = match keybindings::load_custom(state.rt.store()).await {
                Ok(custom) => custom,
                Err(e) => return exit_failure(tx, &id, &format!("keybindings unreadable: {e}")),
            };
            let cat = state.catalog.read().await;
            exit_success(tx, &id, server_config(&cat, &custom));
        }

        // Diagnostics (#67). The settings Diagnostics page is the one screen that
        // answers "is an agent subprocess wedged, and what is eating this box".
        // All of these used to be unsupported-method, so it rendered blank.
        //
        // A sample is taken on each read rather than on a timer: the panel polls
        // while it is open, so history accumulates exactly while someone is
        // looking, and an idle server never forks `ps`.
        "server.getProcessDiagnostics"
        | "server.getProcessResourceHistory"
        | "server.getResourceTelemetryHistory" => {
            let me = std::process::id() as i64;
            if let Ok(s) = diagnostics::sample(me).await {
                // A sample that cannot be RECORDED is reported, not swallowed:
                // the next read would otherwise show a gap the panel renders as
                // "the sampler was not running", which is a different fact.
                if let Err(e) = diagnostics::record_sample(&state.diag_history, &s).await {
                    tracing::error!(%e, "could not record a resource sample");
                }
            }
            if method == "server.getProcessDiagnostics" {
                exit_success(tx, &id, diagnostics::process_diagnostics(me).await);
            } else {
                // Defaults match what the panel asks for when it sends nothing:
                // a 5-minute window in 10s buckets.
                let window = payload
                    .pointer("/input/windowMs")
                    .or_else(|| payload.get("windowMs"))
                    .and_then(Value::as_i64)
                    .unwrap_or(300_000);
                let bucket = payload
                    .pointer("/input/bucketMs")
                    .or_else(|| payload.get("bucketMs"))
                    .and_then(Value::as_i64)
                    .unwrap_or(10_000);
                match diagnostics::history_wire_durable(&state.diag_history, window, bucket, 2_000)
                    .await
                {
                    Ok(wire) => exit_success(tx, &id, wire),
                    // A history read that failed is not an empty history. The
                    // panel must not render "no activity" over a storage fault.
                    Err(e) => exit_failure(tx, &id, &format!("resource history unreadable: {e}")),
                }
            }
        }
        "server.getTraceDiagnostics" => {
            // Reported against the path `server.getConfig` advertises, so the
            // panel's "trace file" line and this answer name the same file.
            exit_success(
                tx,
                &id,
                diagnostics::trace_diagnostics("/tmp/t3code-traces.jsonl"),
            );
        }
        "server.getUsageSummary" => {
            // REAL usage (#328), read from the provider CLIs' own transcripts
            // by `agent_sdk_usage`. This used to return empty buckets and
            // empty sources unconditionally, which decoded cleanly and made
            // every turn the user actually ran disappear.
            //
            // The scan is blocking file IO over a directory tree that can run
            // to gigabytes, so it goes on the blocking pool — running it on a
            // worker thread would stall every other socket on this runtime for
            // the length of a cold scan.
            let input = payload.get("input").cloned().unwrap_or(payload.clone());
            let rates = state.usage_rates.clone();
            let sources = state.usage_sources.clone();
            match tokio::task::spawn_blocking(move || {
                diagnostics::usage_summary_from(&input, rates, &sources)
            })
            .await
            {
                Ok(Ok(summary)) => exit_success(tx, &id, summary),
                // #332: a `UsageReadError` — invalid window, unreadable source
                // root — is the ERROR ARM of the RPC contract, not a Success
                // payload. It travels as a `Fail` cause carrying the TAGGED
                // error, so the client gets `reason` and `detail` and can
                // branch on them.
                //
                // Two weaker versions of this are both wrong: putting it in
                // Exit(Success) makes the client decode an error as a summary,
                // and flattening it to an `exit_failure` defect string throws
                // away the tag the contract declares and turns a handled case
                // into an unexplained crash. The `Result` is what stops either
                // from being reachable — the compiler no longer lets this arm
                // sniff a `_tag` out of a success value.
                Ok(Err(error)) => exit_typed_failure(tx, &id, error),
                // The blocking task itself died: NOT a declared error.
                Err(e) => exit_failure(tx, &id, &format!("usage scan did not finish: {e}")),
            }
        }
        "subscribeResourceTelemetry" => {
            // Streaming snapshots from the same `ps` walk `subscribeShell` /
            // history already use. `sampleIntervalMs` = 2000 matches the
            // cadence the panel expects; power/attribution/desktop-side
            // health come back as the contract's typed unavailable rather
            // than as fabricated healthy zeros.
            let me = std::process::id() as i64;
            let sample_interval_ms: i64 = 2000;
            let first = diagnostics::resource_telemetry_snapshot(me, sample_interval_ms).await;
            chunk(tx, &id, first);
            let tx_pump = tx.clone();
            let req_id = id.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_millis(
                    sample_interval_ms as u64,
                ));
                ticker.tick().await; // first tick fires immediately; we already sent the snapshot
                loop {
                    ticker.tick().await;
                    let snap =
                        diagnostics::resource_telemetry_snapshot(me, sample_interval_ms).await;
                    let frame = json!({ "_tag": "Chunk", "clientId": 0, "requestId": req_id, "values": [snap] }).to_string();
                    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
                    if tx_pump.send((frame, Some(done_tx))).is_err() {
                        return;
                    }
                    if !matches!(done_rx.await, Ok(true)) {
                        return;
                    }
                }
            });
        }

        // Keyboard customization (#71). The settings page saves every shortcut
        // through these two, and both answer with the FULL resolved set rather
        // than the one rule that changed — the page re-renders from the result,
        // and a partial answer would blank every other binding.
        "server.upsertKeybinding" | "server.removeKeybinding" => {
            let input = keybindings::input_of(&payload);
            let custom = match keybindings::load_custom(state.rt.store()).await {
                Ok(custom) => custom,
                Err(e) => return exit_failure(tx, &id, &format!("keybindings unreadable: {e}")),
            };
            let next = if method == "server.upsertKeybinding" {
                keybindings::upsert(&custom, &input)
            } else {
                keybindings::remove(&custom, &input)
            };
            let next = match next {
                Ok(n) => n,
                Err(e) => {
                    exit_failure(tx, &id, &e);
                    return;
                }
            };
            if let Err(e) = keybindings::save_custom(state.rt.store(), &next).await {
                exit_failure(tx, &id, &format!("persist keybindings failed: {e}"));
                return;
            }
            let wire = keybindings::result_wire(&next);
            exit_success(tx, &id, wire.clone());
            // Every other open surface (a second window, the command palette's
            // hint column) reads the projection this stream feeds, not this
            // command's return value.
            publish_config(&state, config_event("keybindingsUpdated", wire)).await;
        }

        // Provider management (#47/#60): the settings UI reads/writes provider
        // instances and expects the change to be durable AND to move what the
        // runtime routes. Each write persists to the do-rs store and reconciles
        // the SAME live catalog, then answers with the shape the UI decodes.
        "server.getSettings" => {
            let instances = match settings::load_instances(state.rt.store(), providers::configured_instances()).await {
                Ok(instances) => instances,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            let other = match settings::load_other(state.rt.store()).await {
                Ok(other) => other,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            exit_success(tx, &id, settings::settings_wire(&instances, &other));
        }
        "server.updateSettings" => {
            // Validate the patch's typed fields BEFORE touching the durable blob:
            // storing a mistyped field would make every later getSettings fail to
            // decode as ServerSettings and break the UI, so reject it and leave
            // settings unchanged (#121).
            if let Err(e) = settings::validate_other(&payload) {
                exit_failure(tx, &id, &e);
                return;
            }
            let current = match settings::load_instances(state.rt.store(), providers::configured_instances()).await {
                Ok(current) => current,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            let next = settings::apply_patch(&current, &payload);
            if let Err(e) = settings::save_instances(state.rt.store(), &next).await {
                exit_failure(tx, &id, &format!("persist settings failed: {e}"));
                return;
            }
            // Persist every OTHER settings field the patch carried, so a saved
            // writing style / model selection / observability config round-trips
            // instead of resetting to defaults on the next getSettings (#87).
            let existing_other = match settings::load_other(state.rt.store()).await {
                Ok(other) => other,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            let other = settings::merge_other(&existing_other, &payload);
            if let Err(e) = settings::save_other(state.rt.store(), &other).await {
                exit_failure(tx, &id, &format!("persist settings failed: {e}"));
                return;
            }
            // Reconcile + answer with the EFFECTIVE set (saved re-merged under the
            // boot defaults), so a whole-map replace that removed a custom
            // provider drops it from the catalog while stock providers survive.
            let effective = match settings::load_instances(state.rt.store(), providers::configured_instances()).await {
                Ok(effective) => effective,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            settings::reconcile(&mut *state.catalog.write().await, &effective);
            let wire = settings::settings_wire(&effective, &other);
            exit_success(tx, &id, wire.clone());
            publish_config(
                &state,
                config_event("settingsUpdated", json!({"settings": wire})),
            )
            .await;
            publish_config(
                &state,
                config_event(
                    "providerStatuses",
                    json!({"providers": provider_entries(&state).await}),
                ),
            )
            .await;
        }
        "server.refreshProviders" => {
            // re-reconcile from the durable set (re-probes availability), then
            // answer with the current provider snapshots the UI renders.
            let instances = match settings::load_instances(state.rt.store(), providers::configured_instances()).await {
                Ok(instances) => instances,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            // A refresh is exactly when to ASK each OpenAI-compatible endpoint
            // what it serves: the user pointed at an Ollama and expects its
            // models to appear without hand-typing slugs (#180).
            let instances = providers::with_discovered_models(instances).await;
            if let Err(e) = settings::save_instances(state.rt.store(), &instances).await {
                tracing::warn!(%e, "could not persist discovered models");
            }
            let providers = {
                let mut cat = state.catalog.write().await;
                settings::reconcile(&mut cat, &instances);
                cat.snapshots()
                    .iter()
                    .map(provider_entry)
                    .collect::<Vec<_>>()
            };
            exit_success(tx, &id, json!({ "providers": providers.clone() }));
            publish_config(
                &state,
                config_event("providerStatuses", json!({"providers": providers})),
            )
            .await;
        }
        "server.updateProvider" => {
            let current = match settings::load_instances(state.rt.store(), providers::configured_instances()).await {
                Ok(current) => current,
                Err(e) => return exit_failure(tx, &id, &format!("settings unreadable: {e}")),
            };
            let next = settings::apply_provider_update(&current, &payload);
            if let Err(e) = settings::save_instances(state.rt.store(), &next).await {
                exit_failure(tx, &id, &format!("persist provider failed: {e}"));
                return;
            }
            let providers = {
                let mut cat = state.catalog.write().await;
                settings::reconcile(&mut cat, &next);
                cat.snapshots()
                    .iter()
                    .map(provider_entry)
                    .collect::<Vec<_>>()
            };
            exit_success(tx, &id, json!({ "providers": providers.clone() }));
            publish_config(
                &state,
                config_event("providerStatuses", json!({"providers": providers})),
            )
            .await;
        }

        // The source-control settings/publish UI reads this to decide whether git
        // and hosting providers are actually available; it must reflect the
        // substrate this runtime really supports, honest `unavailable` rows and
        // all (#46) — never a hard-coded React default.
        "server.discoverSourceControl" => exit_success(tx, &id, sourcecontrol::discover().await),

        // Mint a signed, expiring URL for a file the UI wants to render as
        // BYTES (an image in chat, a PDF in the preview panel, a project
        // favicon). The RPC only signs; `asset_http` serves. Confinement
        // happens HERE, at mint time, against the workspace root this thread
        // actually works in — the redeem side never sees a client path.
        "assets.createUrl" => {
            let resource = payload.get("resource").cloned().unwrap_or(Value::Null);
            let root = match asset_root(&resource, state).await {
                Ok(r) => r,
                Err(e) => return exit_failure(tx, &id, &format!("assets.createUrl: {e}")),
            };
            match assets::resolve(&resource, &root) {
                Ok(resolved) => {
                    let (relative_url, expires_at) = assets::mint(
                        &resolved,
                        &state.assets_key,
                        chrono::Utc::now().timestamp_millis(),
                    );
                    let mut out = json!({ "relativeUrl": relative_url, "expiresAt": expires_at });
                    if let Some(src) = resolved.source_path {
                        out["sourcePath"] = json!(src);
                    }
                    exit_success(tx, &id, out);
                }
                Err(e) => exit_failure(tx, &id, &format!("assets.createUrl: {e}")),
            }
        }

        // A liveness/foreground ping the client sends on a timer. It carries no
        // authority and this backend keeps no background-activity policy, so the
        // honest answer is an ACK: failing it made every client log an error
        // every few seconds for a report that changes nothing.
        "server.reportClientActivity" => exit_success(tx, &id, Value::Null),

        // Stream subscriptions stay OPEN (no Exit). subscribeThread records the
        // requestId so turn events can be routed to it, and emits `synchronized`
        // so the client marks the subscription live.
        "orchestration.subscribeThread" => {
            if let Some(thread_id) = payload.get("threadId").and_then(|t| t.as_str()) {
                tracing::info!(%thread_id, "subscribeThread");
                // RESUME: a client that already holds a snapshot passes its
                // sequence and gets only what it missed. Re-sending the whole
                // thread on every reconnect is what this contract field exists
                // to avoid, and ignoring it made every reconnect a full reload
                // (#83). The replay is bounded: a client that has been away for
                // thousands of events is better served by a fresh snapshot, and
                // a full page of rows means "there may be more" so we fall back.
                const MAX_CATCHUP: i64 = 500;
                let after_sequence = payload.get("afterSequence").and_then(Value::as_i64);
                let wants_marker = payload
                    .get("requestCompletionMarker")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(after) = after_sequence {
                    // Gap-free replay+tail as ONE SDK call (#321/#323/#325/#327).
                    // The order is the fix and it lives in the SDK now: the
                    // tail attaches BEFORE the log is read. A publish after
                    // the attach lands in the durable inbox; a publish before
                    // it was recorded before the read (record precedes
                    // publish) and comes back in `events`. There is no third
                    // case, so nothing can fall between the halves.
                    //
                    // The old product-composed order read the log and THEN
                    // attached with `Retained::Skip`, which threw away the
                    // retained frame unconditionally — and in the window
                    // between the two calls that frame was the ONLY copy of a
                    // live event the client had never seen. The client was
                    // then told `synchronized` over the hole. The SDK now
                    // attaches with `Retained::Deliver` and suppresses by
                    // sequence `<= through`, which is exact: a duplicate is
                    // dropped, a genuinely new event never is.
                    match state
                        .rt
                        .replay_and_tail(thread_id, after, MAX_CATCHUP)
                        .await
                    {
                        // A tail is offered ONLY when the replay covered the
                        // gap; the SDK returns `None` otherwise, so there is no
                        // way to go live over a truncated catch-up by mistake.
                        Ok(replay) => match replay.tail {
                            Some(tail) => {
                                for item in replay.events {
                                    chunk(tx, &id, item);
                                }
                                chunk(tx, &id, json!({ "kind": "synchronized" }));
                                let _ = wants_marker;
                                spawn_thread_tail(
                                    tail,
                                    tx.clone(),
                                    id.clone(),
                                    thread_id.to_string(),
                                );
                                return;
                            }
                            // Replay hit MAX_CATCHUP — "there may be more", and
                            // no tail can bridge the older gap. Take the
                            // snapshot instead.
                            None => {
                                tracing::info!(%thread_id, after, "catch-up gap too large — full snapshot");
                            }
                        },
                        Err(e) => {
                            // A catch-up read that FAILS is not an empty
                            // catch-up: telling the client `synchronized`
                            // over a gap it cannot fill is the exact defect
                            // this branch exists to avoid.
                            tracing::warn!(%e, %thread_id, "catch-up read failed; falling back to a full snapshot");
                        }
                    }
                }
                // Gap-free snapshot+tail as ONE SDK call (#326). The hand-
                // rolled version read `current_sequence()`, built the
                // snapshot, then called `tail_after(Some(seq0))` — any event
                // published in that window was retained on the broker and
                // then skipped by the tail's `Retained::Skip`, so the client
                // was told `synchronized` over a gap. `snapshot_tail` attaches
                // FIRST (so live publishes land in the inbox) and returns
                // both the mark the snapshot must advertise and a tail
                // suppressing everything `<= mark`.
                let (seq0, snapshot_tail) = match state.rt.snapshot_tail(thread_id).await {
                    Ok(pair) => pair,
                    Err(e) => {
                        tracing::error!(%e, %thread_id, "subscribeThread: snapshot tail attach failed");
                        chunk(
                            tx,
                            &id,
                            json!({ "kind": "error",
                            "error": { "message": format!("subscribe failed: {e}") } }),
                        );
                        return;
                    }
                };
                // Snapshot derives from the DURABLE store: the thread row and
                // its message history come from `OrchStore`, not in-memory maps,
                // so a reload/restart renders the same history that persisted.
                let messages = state.rt.messages(thread_id).await;
                // The DURABLE record, TYPED (#2). A hand-built thread object beside
                // the row it was read from is how a worktree-backed read-only
                // thread reconnected as a default full-access shell: the shape was
                // schema-valid and lifecycle-invalid at once. `ThreadRecord` owns
                // the metadata keys and `project` refuses to let this file set
                // them, so that snapshot is no longer expressible.
                // FAIL CLOSED on an unreadable store: an absent record is not an
                // empty one.
                let record = match state.rt.thread_record(thread_id).await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::error!(%thread_id, %e, "subscribeThread: thread store unreadable");
                        snapshot_tail.close().await;
                        exit_failure(
                            tx,
                            &id,
                            &format!("subscribeThread: thread store unreadable: {e}"),
                        );
                        return;
                    }
                };
                let now = now_iso();
                // A thread the client subscribed to before its first turn has no
                // durable row yet (`ensure_thread_on_shell` writes it when the
                // turn runs). THAT is the only case where defaults are honest —
                // there is nothing to contradict. Everything below is used solely
                // to build that placeholder; when a row exists, the record wins
                // every field and none of this is consulted.
                // FAIL CLOSED on a project-store read error (#374): a
                // `p-workspace` fallback would ship a thread meta pointing at a
                // project id no durable row backs.
                let record = match record {
                    Some(r) => r,
                    None => {
                        let project0 = match state.rt.projects().await {
                            Ok(ps) => {
                                match ps.first().and_then(|p| p.get("id")).and_then(Value::as_str) {
                                    Some(v) => v.to_string(),
                                    None => {
                                        tracing::error!(%thread_id, "subscribeThread: no seed project in store; refusing snapshot");
                                        snapshot_tail.close().await;
                                        exit_failure(
                                            tx,
                                            &id,
                                            "subscribeThread: no seed project in store",
                                        );
                                        return;
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::error!(%thread_id, %e, "subscribeThread: project store unreadable");
                                snapshot_tail.close().await;
                                exit_failure(
                                    tx,
                                    &id,
                                    &format!("subscribeThread: project store unreadable: {e}"),
                                );
                                return;
                            }
                        };
                        agent_sdk_shell::ThreadRecord::new(
                            thread_id,
                            project0,
                            "Thread",
                            default_model_selection(&state).await,
                            agent_sdk_shell::RuntimeMode::default(),
                            now.clone(),
                        )
                    }
                };
                // Pending approvals come from the DURABLE store, so a client
                // that reconnects while a turn is parked rebuilds the request
                // instead of showing a spinner it can never answer (#69). The
                // requestId is the same session|turn|callId the live event
                // carries, so the answer routes identically either way.
                // FAIL-CLOSED (packet M): a pending set that cannot be read is
                // not an empty pending set. Handing the client a snapshot with
                // no approvals when the store is damaged hides a parked run
                // behind a UI that looks idle, so the subscription errors
                // instead of quietly rendering a lie.
                let pending = match state.rt.pending_approvals(thread_id).await {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::error!(%e, %thread_id, "pending approvals unreadable");
                        // The tail is ALREADY attached (it has to be, or the
                        // snapshot has a race). Returning without detaching
                        // leaves a durable subscriber row that nothing drains
                        // and nothing acks, so every later event for this
                        // thread piles up in an inbox with no reader.
                        snapshot_tail.close().await;
                        chunk(
                            tx,
                            &id,
                            json!({ "kind": "error",
                            "error": { "message": format!("pending approvals unreadable: {e}") } }),
                        );
                        return;
                    }
                };
                // The SAME constructor the live projection uses (#311): a
                // reconnect must rebuild the identical activity row, or the
                // snapshot fails to decode and the parked approval is lost.
                let mut activities: Vec<Value> = pending
                    .iter()
                    .map(|a| {
                        approval_requested_activity(
                            a["sessionId"].as_str().unwrap_or(""),
                            a["turn"].as_i64().unwrap_or(0),
                            a["call_id"]
                                .as_str()
                                .or_else(|| a["callId"].as_str())
                                .unwrap_or(""),
                            a["tool"].as_str().unwrap_or(""),
                            a.get("args").unwrap_or(&Value::Null),
                            None,
                            &now,
                        )
                    })
                    .collect();
                let has_pending = !activities.is_empty();
                // A question the agent asked is a parked wait too (packet M).
                // It had no durable row at all before, so a reconnect after a
                // restart found a blocked composer and nothing to answer — the
                // run stayed parked forever. The SDK records the ask; this
                // rebuilds it with the SAME activity shape the live event uses,
                // carrying the original timestamp so the row is identical.
                match state.rt.pending_user_inputs(thread_id).await {
                    Ok(asks) => {
                        for ask in asks {
                            let session_id = ask["sessionId"].as_str().unwrap_or("");
                            activities.push(json!({
                                "id": format!("user-input:{session_id}"),
                                "tone": "approval",
                                "kind": "user-input.requested",
                                "summary": ask["prompt"].as_str().unwrap_or("The agent has a question"),
                                "payload": {
                                    "requestId": session_id,
                                    "prompt": ask["prompt"].clone(),
                                    "questions": ask["questions"].clone(),
                                },
                                "createdAt": ask["requestedAt"].as_str().unwrap_or(now.as_str()),
                            }));
                        }
                    }
                    Err(e) => {
                        tracing::error!(%e, %thread_id, "pending user-input asks unreadable");
                        // The tail is ALREADY attached (it has to be, or the
                        // snapshot has a race). Returning without detaching
                        // leaves a durable subscriber row that nothing drains
                        // and nothing acks, so every later event for this
                        // thread piles up in an inbox with no reader.
                        snapshot_tail.close().await;
                        chunk(
                            tx,
                            &id,
                            json!({ "kind": "error",
                            "error": { "message": format!("pending questions unreadable: {e}") } }),
                        );
                        return;
                    }
                }
                // Hydrate the LIVE session state from the SDK read model so a
                // reconnect/reload while a turn is running or parked shows the
                // running/idle/error affordance — not a spinner inferred from
                // stale messages that the user could never clear (#92).
                let session = match state.rt.session_status(thread_id).await {
                    Ok(Some((_sid, st))) => {
                        use agent_sdk_shell::TurnState;
                        let live = matches!(st, TurnState::Running | TurnState::AwaitingApproval);
                        let status = match st {
                            TurnState::Running | TurnState::AwaitingApproval => "running",
                            TurnState::Failed => "error",
                            _ => "idle", // Idle / Done / Interrupted have settled
                        };
                        // A "running" session with a null activeTurnId hydrates NO
                        // stoppable latest turn in the client reducer, so the reload
                        // shows a spinner with no way out. The durable in-flight
                        // marker carries the SAME turn id the live session-set event
                        // used, so the running/stop affordance is fully restored (#92).
                        let active_turn = if live {
                            state
                                .rt
                                .active_turn_id(thread_id)
                                .await
                                .map(Value::String)
                                .unwrap_or(Value::Null)
                        } else {
                            Value::Null
                        };
                        json!({ "threadId": thread_id, "status": status, "providerName": null,
                            "activeTurnId": active_turn, "lastError": Value::Null, "updatedAt": now })
                    }
                    Ok(None) => Value::Null,
                    Err(e) => {
                        tracing::error!(%e, %thread_id, "session status unreadable");
                        snapshot_tail.close().await;
                        chunk(tx, &id, json!({ "kind": "error",
                            "error": { "message": format!("session status unreadable: {e}") } }));
                        return;
                    }
                };
                // `turnLimit` windows the fallback snapshot to the last N
                // user-anchored turns and SAYS it is a window; absent means the
                // full thread, which is what pre-pagination clients expect.
                let turn_limit = payload
                    .get("turnLimit")
                    .and_then(Value::as_u64)
                    .map(|v| v as usize);
                let (messages, page) = match turn_limit {
                    None => (messages, Value::Null),
                    Some(limit) => {
                        // count back `limit` USER messages: a window has to
                        // contain whole turns, or the client shows an answer
                        // whose question is off-screen.
                        let starts: Vec<usize> = messages
                            .iter()
                            .enumerate()
                            .filter(|(_, m)| m.get("role").and_then(Value::as_str) == Some("user"))
                            .map(|(i, _)| i)
                            .collect();
                        let from = if starts.len() > limit {
                            starts[starts.len() - limit]
                        } else {
                            0
                        };
                        let has_more = from > 0;
                        let before_cursor = if has_more {
                            messages[from].get("id").cloned().unwrap_or(Value::Null)
                        } else {
                            Value::Null
                        };
                        let thread_sequence = match state.rt.thread_sequence(thread_id).await {
                            Ok(seq) => seq,
                            Err(e) => {
                                exit_failure(tx, &id, &format!("thread sequence unreadable: {e}"));
                                return;
                            }
                        };
                        (
                            messages[from..].to_vec(),
                            json!({
                                "beforeCursor": before_cursor,
                                "hasMore": has_more,
                                "snapshotSequence": seq0,
                                "threadSequence": thread_sequence,
                            }),
                        )
                    }
                };
                let checkpoints = checkpoint_summaries(
                    &state,
                    record.worktree_path.as_deref().unwrap_or(&state.cwd),
                )
                .await;
                let checkpoints = match checkpoints {
                    Ok(checkpoints) => checkpoints,
                    Err(e) => {
                        exit_failure(tx, &id, &format!("checkpoint summaries unavailable: {e}"));
                        return;
                    }
                };
                // The product-owned parts only. Everything a reducer reads as
                // thread IDENTITY/LIFECYCLE comes from the record.
                let parts = json!({
                    "messages": messages,
                    "activities": activities,
                    "hasPendingApprovals": has_pending,
                    "checkpoints": checkpoints,
                    "session": session,
                });
                // A thread with no durable row cannot be snapshotted honestly:
                // every metadata field would be invented. Say so instead.
                let thread_obj = match record.project(parts) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(%thread_id, %e, "subscribeThread: invalid thread projection");
                        snapshot_tail.close().await;
                        exit_failure(
                            tx,
                            &id,
                            &format!("subscribeThread: invalid thread projection: {e}"),
                        );
                        return;
                    }
                };
                let mut snapshot = json!({ "snapshotSequence": seq0, "thread": thread_obj });
                if !page.is_null() {
                    snapshot["page"] = page;
                }
                chunk(tx, &id, json!({ "kind": "snapshot", "snapshot": snapshot }));
                // The tail was attached BEFORE the snapshot was built by
                // `snapshot_tail` above and already suppresses everything
                // `<= seq0`, so `synchronized` here is honest and the client
                // never applies the snapshot's own events twice. This is the
                // gap-free contract #326 asked for as ONE SDK call, not a
                // hand-rolled retained-slot trick with reducer-side dedup.
                spawn_thread_tail(snapshot_tail, tx.clone(), id.clone(), thread_id.to_string());
            }
            chunk(tx, &id, json!({ "kind": "synchronized" }));
        }
        "subscribeServerLifecycle" => {
            // The client waits for `ready` before advancing to the shell + UI.
            chunk(
                tx,
                &id,
                json!({ "version": 1, "sequence": 0, "type": "welcome",
                "payload": { "environment": state.env, "cwd": state.cwd, "projectName": state.project_name } }),
            );
            chunk(
                tx,
                &id,
                json!({ "version": 1, "sequence": 1, "type": "ready",
                "payload": { "at": now_iso(), "environment": state.env } }),
            );
        }
        "subscribeServerConfig" => {
            // an initial snapshot, so a late subscriber is not stuck with
            // whatever it cached before connecting
            let custom = match keybindings::load_custom(state.rt.store()).await {
                Ok(custom) => custom,
                Err(e) => return exit_failure(tx, &id, &format!("keybindings unreadable: {e}")),
            };
            chunk(
                tx,
                &id,
                config_snapshot_event(server_config(&*state.catalog.read().await, &custom)),
            );
            // Fanout attaches through the SDK's durable config topic (packet
            // DL). Retained::Skip so the caller does not re-receive the
            // frame we just handed it as a snapshot; every later mutation on
            // this or a second backend process reaches this subscriber via
            // the same broker.
            match state.rt.config_tail_after(Some(0)).await {
                Ok(tail) => {
                    spawn_thread_tail(tail, tx.clone(), id.clone(), "__config__".to_string())
                }
                Err(e) => {
                    tracing::error!(%e, "config tail attach failed — subscriber will not receive updates");
                    exit_failure(tx, &id, &format!("subscribeServerConfig: {e}"));
                }
            }
        }
        // ── orchestration read model (#74) ──────────────────────────────────
        //
        // Five query RPCs the contract declares and the client wires atoms for,
        // all of which used to fall through to `unsupported method`. They are
        // reads off substrate that already exists: turn checkpoints (#65) for
        // the diffs, the durable thread/message store for search and archive.
        //
        // None of them fabricates an empty success. An empty diff and an
        // unavailable diff are different answers, and the contract has a
        // declared error arm for exactly that difference.
        "orchestration.getTurnDiff" | "orchestration.getFullThreadDiff" => {
            let input = payload.get("input").cloned().unwrap_or(payload.clone());
            let thread_id = input
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let to = input
                .get("toTurnCount")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            // A FULL thread diff is the same read with the near boundary pinned
            // to the working tree, so both share one implementation and cannot
            // disagree about which end of the range is which.
            let from = if method == "orchestration.getFullThreadDiff" {
                0
            } else {
                input
                    .get("fromTurnCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            };
            let ws = input
                .get("ignoreWhitespace")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if from > to {
                exit_typed_failure(
                    tx,
                    &id,
                    json!({
                        "_tag": if method.ends_with("getTurnDiff") { "OrchestrationGetTurnDiffError" }
                                else { "OrchestrationGetFullThreadDiffError" },
                        "message": "fromTurnCount must be less than or equal to toTurnCount",
                    }),
                );
                return;
            }
            let cwd = match thread_cwd(&state, &thread_id).await {
                Ok(cwd) => cwd,
                Err(e) => {
                    exit_typed_failure(tx, &id, json!({
                        "_tag": if method.ends_with("getTurnDiff") { "OrchestrationGetTurnDiffError" }
                                else { "OrchestrationGetFullThreadDiffError" },
                        "message": format!("thread worktree unavailable: {e}"),
                    }));
                    return;
                }
            };
            // CAIRN owns the diff (#376). `to` is the older boundary (a larger
            // turn count is further back) and `from` is the newer one; `from ==
            // 0` means the working tree, which is what cairn's `None` end is.
            let patch: Result<Option<String>, String> = async {
                let Some(checkpoints) = checkpoint_stack(&state, &cwd).await? else {
                    return Ok(None);
                };
                // The SDK owns the count→boundary mapping (#376). `from == 0`
                // means the working tree, and `diff_turns` interprets 0 that way
                // — one source of truth for the count semantics.
                if to <= 0 {
                    return Ok(None);
                }
                checkpoints
                    .diff_turns(from.max(0) as usize, to as usize, ws)
                    .await
            }
            .await;
            match patch {
                Ok(Some(diff)) => exit_success(
                    tx,
                    &id,
                    json!({
                        "threadId": thread_id, "fromTurnCount": from, "toTurnCount": to, "diff": diff,
                    }),
                ),
                // No checkpoint at that distance, or not a git worktree. Saying
                // `diff: ""` here would tell the reviewer the turn changed
                // nothing, which is the one thing this must never claim.
                Ok(None) => exit_typed_failure(
                    tx,
                    &id,
                    json!({
                        "_tag": if method.ends_with("getTurnDiff") { "OrchestrationGetTurnDiffError" }
                                else { "OrchestrationGetFullThreadDiffError" },
                        "message": format!(
                            "no checkpoint covers turns {from}..{to} for this thread \
                             (the workspace may not be a git repository)"
                        ),
                    }),
                ),
                Err(e) => exit_typed_failure(
                    tx,
                    &id,
                    json!({
                        "_tag": if method.ends_with("getTurnDiff") { "OrchestrationGetTurnDiffError" }
                                else { "OrchestrationGetFullThreadDiffError" },
                        "message": format!("diff unavailable: {e}"),
                    }),
                ),
            }
        }
        "orchestration.searchThreads" => {
            let input = payload.get("input").cloned().unwrap_or(payload.clone());
            let query = input
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            // The contract bounds this (2..=200 chars, limit 1..=50) so a scan
            // cannot monopolize the store; the runtime enforces the same bounds
            // rather than trusting a client to have done it.
            if query.chars().count() < 2 {
                exit_typed_failure(
                    tx,
                    &id,
                    json!({
                        "_tag": "OrchestrationSearchThreadsError",
                        "message": "a search needs at least two characters",
                    }),
                );
                return;
            }
            let limit = input
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(20)
                .clamp(1, 50) as usize;
            let needle = query.to_lowercase();
            // The DURABLE store is the corpus — not an in-memory index that
            // would be empty after a restart and disagree with the thread list.
            let threads = match state.rt.try_threads().await {
                Ok(t) => t,
                Err(e) => {
                    exit_typed_failure(
                        tx,
                        &id,
                        json!({
                            "_tag": "OrchestrationSearchThreadsError",
                            "message": format!("the thread store is unreadable: {e}"),
                        }),
                    );
                    return;
                }
            };
            let mut matches = Vec::new();
            'threads: for th in &threads {
                let tid = th.get("id").and_then(Value::as_str).unwrap_or("");
                if tid.is_empty() {
                    continue;
                }
                let pid = th
                    .get("projectId")
                    .and_then(Value::as_str)
                    .unwrap_or("p-workspace")
                    .to_string();
                // A read that FAILS is not a thread with no matches: it would
                // silently narrow the result set and the user would conclude
                // their text is not there.
                let msgs = match state.rt.try_messages(tid).await {
                    Ok(m) => m,
                    Err(e) => {
                        exit_typed_failure(
                            tx,
                            &id,
                            json!({
                                "_tag": "OrchestrationSearchThreadsError",
                                "message": format!("thread {tid} is unreadable: {e}"),
                            }),
                        );
                        return;
                    }
                };
                for m in &msgs {
                    let text = m.get("text").and_then(Value::as_str).unwrap_or("");
                    let Some(at) = text.to_lowercase().find(&needle) else {
                        continue;
                    };
                    // The contract enumerates user | assistant on `source`; a
                    // system / tool message that happens to contain the query
                    // must NOT be smuggled out as an assistant hit — the
                    // client's decoder cannot classify anything else.
                    let role = m.get("role").and_then(Value::as_str).unwrap_or("");
                    let source = match role {
                        "user" => "user",
                        "assistant" => "assistant",
                        _ => continue,
                    };
                    matches.push(json!({
                        "threadId": tid,
                        "projectId": pid,
                        "source": source,
                        "snippet": snippet_around(text, at, needle.len()),
                        "messageCreatedAt": m.get("createdAt").cloned().unwrap_or(Value::Null),
                    }));
                    if matches.len() >= limit {
                        break 'threads;
                    }
                    // one hit per message: a snippet list that repeats the same
                    // message for every occurrence buries the other threads.
                    break;
                }
            }
            exit_success(tx, &id, json!({ "matches": matches }));
        }
        "orchestration.getWorkflowScript" => {
            let input = payload.get("input").cloned().unwrap_or(payload.clone());
            let script_path = input
                .get("scriptPath")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // Containment is re-derived here; the client value is a hint. This
            // runtime has no workflow-scripts root, so the honest answer is the
            // contract's own `root-unavailable`, NOT an empty script body that
            // the panel would render as a workflow with no steps.
            exit_typed_failure(
                tx,
                &id,
                json!({
                    "_tag": "OrchestrationGetWorkflowScriptError",
                    "reason": "root-unavailable",
                    "scriptPath": script_path,
                }),
            );
        }
        "orchestration.subscribeShell" => {
            // RESUME (packet L). The contract has had `afterSequence` on this
            // subscription all along; the runtime ignored it, so every shell
            // reconnect was a full projects+threads reload and any frame the
            // client missed while away was simply gone — the broker retains
            // exactly one.
            //
            // Now that the seam records every shell frame, the gap is
            // replayable. Same discipline as subscribeThread: a read that
            // FAILS is not an empty catch-up (that would announce
            // `synchronized` over a hole), and a full page means "there may be
            // more", so both fall back to the snapshot path.
            const MAX_SHELL_CATCHUP: i64 = 500;
            if let Some(after) = payload.get("afterSequence").and_then(Value::as_i64) {
                // ONE SDK call owns attach-then-replay for the shell topic too
                // (#325-#327). The product no longer orders the subscribe
                // against the log read, no longer decides retained-vs-skip,
                // and no longer has to remember to detach the tail it opened
                // when the replay half fails — every one of those was a way
                // to announce `synchronized` over a hole or leak a
                // subscription.
                match state
                    .rt
                    .shell_replay_and_tail(after, MAX_SHELL_CATCHUP)
                    .await
                {
                    Ok(replay) => match replay.tail {
                        Some(tail) => {
                            for item in replay.events {
                                chunk(tx, &id, item);
                            }
                            chunk(tx, &id, json!({ "kind": "synchronized" }));
                            spawn_thread_tail(
                                tail,
                                tx.clone(),
                                id.clone(),
                                "__shell__".to_string(),
                            );
                            return;
                        }
                        None => {
                            tracing::info!(after, "shell catch-up gap too large — full snapshot");
                        }
                    },
                    Err(e) => {
                        // A failed read is not an empty catch-up.
                        tracing::warn!(%e, after, "shell catch-up read failed; falling back to a full snapshot");
                    }
                }
            }
            // Attach BEFORE reading projects/threads, and take the mark from
            // what is RECORDED (#326). The previous version read the mark,
            // built the snapshot, then attached and leaned on the broker's
            // retained frame to cover the window — the broker retains exactly
            // ONE frame, so two publishes in that window lost the older one.
            // Attach-first puts every window publish in the durable inbox and
            // the tail suppresses only what the snapshot provably carries.
            let (mark, tail) = match state.rt.shell_snapshot_tail().await {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::error!(%e, "shell tail attach failed — subscriber will not receive updates");
                    exit_failure(tx, &id, &format!("subscribeShell: {e}"));
                    return;
                }
            };
            // The thread list comes from the DURABLE store, not a process-local
            // projection (#303) — one read per subscribe, and it cannot drift.
            let threads = state.rt.threads().await;
            // FAIL CLOSED on a project-store read error (#374). The
            // previous `unwrap_or_default` would ship `projects: []`
            // alongside durable threads on a store-read error, giving the
            // reducer a schema-valid but mixed-authority snapshot — the
            // exact defect #370 rejected, one step later. A refusal makes
            // the failure loud; the client can reconnect and retry.
            let projects = match state.rt.projects().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%e, "subscribeShell: project store unreadable");
                    exit_failure(
                        tx,
                        &id,
                        &format!("subscribeShell: project store unreadable: {e}"),
                    );
                    return;
                }
            };
            chunk(
                tx,
                &id,
                json!({ "kind": "snapshot", "snapshot": {
                "snapshotSequence": mark, "projects": projects, "threads": threads, "updatedAt": now_iso() } }),
            );
            spawn_thread_tail(tail, tx.clone(), id.clone(), "__shell__".to_string());
        }
        // ── source control, entirely over cairn (see `vcs.rs`) ──────────────
        // Every one of these used to be either a `git_out` shell-out or an
        // unsupported-method failure. `cwd` comes from the request when the
        // client sends one (a worktree panel operates on its own directory),
        // falling back to the server's workspace.
        m if m == "vcs.listRefs" => match req_cwd(&payload, &state).await {
            Ok(cwd) => exit_success(tx, &id, vcs::list_refs(&cwd, &payload).await),
            Err(e) => exit_failure(tx, &id, &e),
        },
        "subscribeVcsStatus" => match req_cwd(&payload, &state).await {
            Ok(cwd) => {
                // snapshot first, then stay registered: every later mutation and
                // every external git change publishes onto this stream (#117).
                let (snapshot, seen) = vcs::status_snapshot_and_fingerprint(&cwd).await;
                chunk(tx, &id, snapshot);
                // Register the DURABLE watch (#335). The fingerprint this
                // client was just handed is the baseline its watch reconciles
                // against, and it comes from the SAME cairn status read as the
                // snapshot. Re-reading after `chunk` creates a race where a
                // filesystem edit lands between the two reads, is recorded as
                // already seen, and is then suppressed by the cairn watcher.
                //
                // The mark belongs below the product: `watch_begin` is
                // first-writer-wins, so a second subscriber arriving later
                // cannot drag the mark past a change the first has not been
                // told about. A failed registration is reported — a socket
                // that silently never watches is worse than one that errors.
                if let Err(e) = state.rt.watch_begin("vcs", &cwd, &seen).await {
                    exit_failure(tx, &id, &format!("subscribeVcsStatus: {e}"));
                    return;
                }
                // Delivery goes through the SDK's durable per-cwd topic
                // (packet DM); a VCS mutation made from a SECOND backend
                // process attached to this isolate reaches this subscriber.
                match state.rt.vcs_tail_skip_retained(&cwd).await {
                    Ok(tail) => {
                        // CLAIM THE WATCH DURABLY (#335). This used to be a
                        // process-local `HashMap<cwd, u32>` refcount, which is
                        // the same defect as the `Vec` it replaced, just
                        // smaller: a count of THIS process's sockets cannot
                        // answer "does anyone anywhere still care". With two
                        // backends on one environment, whichever one's last
                        // socket closed first would drop the count to zero and
                        // release a watch the other's clients were still
                        // reading — and the panels on that side would silently
                        // stop updating with nothing in any log.
                        //
                        // The claim is keyed by the TAIL's subscriber id, the
                        // same identity the durable inbox uses, so a claim
                        // cannot outlive the subscription it belongs to.
                        // `watch_claim` returns whether this is the FIRST
                        // watcher anywhere — the question that decides whether
                        // a watch task needs starting.
                        let sub_id = tail.sub_id().to_string();
                        match state.rt.watch_claim("vcs", &cwd, &sub_id).await {
                            Ok(true) => state
                                .vcs_watch_changed
                                .send_modify(|v| *v = v.wrapping_add(1)),
                            Ok(false) => {}
                            Err(e) => {
                                // A subscription whose claim did not register
                                // is a socket the supervisor will never watch
                                // for. Refuse it visibly instead of leaving a
                                // panel that looks live and never moves.
                                tail.close().await;
                                exit_failure(tx, &id, &format!("subscribeVcsStatus: {e}"));
                                return;
                            }
                        }
                        let state_close = state.clone();
                        let cwd_close = cwd.clone();
                        spawn_thread_tail_with_cleanup(
                            tail,
                            tx.clone(),
                            id.clone(),
                            format!("vcs:{cwd}"),
                            async move {
                                // `watch_unclaim` drops THIS subscriber's claim
                                // and reports whether it was the last one
                                // anywhere; it releases the mark itself in that
                                // case, so the claim and the mark cannot drift.
                                match state_close
                                    .rt
                                    .watch_unclaim("vcs", &cwd_close, &sub_id)
                                    .await
                                {
                                    Ok(true) => state_close
                                        .vcs_watch_changed
                                        .send_modify(|v| *v = v.wrapping_add(1)),
                                    Ok(false) => {}
                                    Err(e) => tracing::warn!(
                                        %e, cwd = %cwd_close,
                                        "could not release the vcs watch claim"
                                    ),
                                }
                            },
                        );
                    }
                    Err(e) => {
                        exit_failure(tx, &id, &format!("subscribeVcsStatus tail attach: {e}"));
                        return;
                    }
                }
                // wake the watcher supervisor: a new tree may need a watch.
                state
                    .vcs_watch_changed
                    .send_modify(|v| *v = v.wrapping_add(1));
            }
            Err(e) => exit_failure(tx, &id, &e),
        },
        "vcs.refreshStatus" => match req_cwd(&payload, &state).await {
            Ok(cwd) => exit_success(tx, &id, vcs::status(&cwd).await),
            Err(e) => exit_failure(tx, &id, &e),
        },
        "vcs.pull" | "vcs.createRef" | "vcs.switchRef" | "vcs.createWorktree"
        | "vcs.removeWorktree" | "vcs.init" => {
            let cwd = match req_cwd(&payload, &state).await {
                Ok(c) => c,
                Err(e) => {
                    exit_failure(tx, &id, &e);
                    return;
                }
            };
            let out = match method {
                "vcs.pull" => vcs::pull(&cwd).await,
                "vcs.createRef" => vcs::create_ref(&cwd, &payload).await,
                "vcs.switchRef" => vcs::switch_ref(&cwd, &payload).await,
                "vcs.createWorktree" => vcs::create_worktree(&cwd, &payload, &state.cwd).await,
                "vcs.removeWorktree" => vcs::remove_worktree(&cwd, &payload, &state.cwd).await,
                _ => vcs::init(&cwd).await,
            };
            // A git refusal is REPORTED with git's own reason. Answering
            // Success to a failed checkout would leave the panel showing a
            // branch the worktree is not on.
            match out {
                Ok(v) => {
                    exit_success(tx, &id, v);
                    // the repo moved — the panel must not need a manual refresh
                    publish_vcs_status(&state, &cwd).await;
                }
                Err(e) => exit_failure(tx, &id, &e),
            }
        }
        "git.runStackedAction" => {
            // a PROGRESS stream: started → per-step → completed
            let cwd = match req_cwd(&payload, &state).await {
                Ok(c) => c,
                Err(e) => {
                    exit_failure(tx, &id, &e);
                    return;
                }
            };
            // #423: FORWARD EACH FRAME AS IT IS PRODUCED.
            //
            // This awaited `run_stacked_action` to completion and then replayed
            // the returned `Vec`. That is a transcript, not a stream: a push
            // blocking on the network showed the user nothing for its entire
            // duration and then flushed the complete history of something that
            // had already finished. The route called itself a PROGRESS stream
            // in a comment while being the opposite in code.
            //
            // The sink is called by vcs BEFORE each phase blocks —
            // `action_started` before any git runs, `phase_started` ahead of
            // each phase — so the frames reach the socket while the work is
            // still happening. No product-side action registry is introduced:
            // the frames go out on the same `tx` this task already holds, which
            // is what the finding's "do not replace this with a product-side
            // in-memory action registry" rules out and what would put stream
            // lifecycle authority back into the product edge.
            let mut emit = |f: Value| chunk(tx, &id, f);
            // THE EXIT MUST AGREE WITH THE FRAMES (fail-open fix).
            //
            // Every phase refusal in `vcs` emits an `action_failed` frame and
            // then returned `Ok(())`, and this arm answered `Ok(()) =>
            // exit_success`. So a commit_push into a repo with no remote, or a
            // PR request with no usable `gh`, reported the RPC as SUCCESSFUL:
            // nothing was pushed, no PR existed, and the caller was told it
            // worked. The failure was visible only to a client that parsed the
            // frame stream — but an Exit exists precisely so a caller does not
            // have to.
            //
            // `Ok(Some((phase, message)))` is now "it ran and the action
            // FAILED", and it exits FAILURE naming the phase that refused. The
            // frames are unaffected: they were already sunk before the verdict
            // travelled, so a client watching progress sees exactly what it saw
            // before and the Exit now matches it.
            // #278: the action is CANCELLABLE, through the same durable
            // `agent_control` row the turn loop uses — not a process-local
            // handle. Keyed by the client's `actionId`, so a cancel that
            // arrives on a different connection, or after a reconnect, still
            // reaches the action: the row is the rendezvous, not this task.
            let action_db = state.rt.store().db().clone();
            // The orchestration isolate never ran an agent's BOOT_DDL, so it has
            // no `agent_control` table until we say so. Idempotent.
            if let Err(e) = agent_sdk_do::Control::ensure_schema(&action_db).await {
                exit_failure(tx, &id, &format!("action control schema unavailable: {e}"));
                return;
            }
            let action_control = agent_sdk_do::Control::new(action_db);
            let action_id = match payload
                .get("actionId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(action_id) => action_id.to_string(),
                None => {
                    exit_failure(tx, &id, "runStackedAction requires an actionId");
                    return;
                }
            };
            // A new user action is a fresh control-row generation. `ensure`
            // preserves stale cancel bits by design; reusable action ids need
            // an explicit reset before phase boundaries start checking.
            if let Err(e) = action_control.start_fresh(&action_id).await {
                exit_failure(tx, &id, &format!("could not start action control: {e}"));
                return;
            }
            match vcs::run_stacked_action_streaming(&cwd, &payload, &mut emit, Some(&action_control))
                .await
            {
                Ok(None) => {
                    if let Err(e) = action_control.clear(&action_id).await {
                        exit_failure(tx, &id, &format!("action control cleanup unavailable: {e}"));
                        return;
                    }
                    exit_success(tx, &id, Value::Null);
                    publish_vcs_status(&state, &cwd).await;
                }
                Ok(Some((phase, message))) => {
                    if message.contains("cancelled") {
                        if let Err(e) = action_control
                            .finish(&action_id, agent_sdk_do::Checkpoint::Cancel)
                            .await
                        {
                            exit_failure(
                                tx,
                                &id,
                                &format!("action control finish unavailable: {e}"),
                            );
                            return;
                        }
                    }
                    if let Err(e) = action_control.clear(&action_id).await {
                        exit_failure(tx, &id, &format!("action control cleanup unavailable: {e}"));
                        return;
                    }
                    // A refused phase can still have mutated the repository —
                    // `commit` may have landed before `push` was refused — so
                    // the status is republished on this path too. Leaving it
                    // stale would show the user a tree that does not match disk.
                    publish_vcs_status(&state, &cwd).await;
                    let phase = phase.as_str().unwrap_or("action").to_string();
                    exit_failure(tx, &id, &format!("{phase}: {message}"));
                }
                Err(e) => {
                    if let Err(cleanup) = action_control.clear(&action_id).await {
                        exit_failure(
                            tx,
                            &id,
                            &format!("action failed ({e}); action control cleanup unavailable: {cleanup}"),
                        );
                        return;
                    }
                    exit_failure(tx, &id, &e);
                }
            }
        }
        // ── project files: browse / search / preview / write (#64) ─────────
        // Same cwd admission as VCS and review: a project RPC is a read (or a
        // WRITE) into a repository, so naming a path is not authority to touch
        // it. Paths inside the workspace are then confined again by cairn.
        // Directory completion for a path input. Deliberately NOT confined to
        // the workspace: its job is picking a folder that is not a project yet.
        // The repository ACTIONS discovery unlocks (#58). Each reports an
        // explicit, actionable error when its tool is missing rather than
        // pretending the environment can do something it cannot.
        // #278: STOP a running stacked action. Durable and connection-independent
        // — it flips the `agent_control` row the action polls at each phase
        // boundary, so it works from a different socket, and it works after the
        // requesting client has reconnected. There is no in-memory action
        // registry to consult and nothing to lose on restart.
        //
        // Idempotent and safe on an unknown id: `Control::cancel` ensures the row
        // first, so cancelling an action that has already finished, or one whose
        // id nobody recognises, is a no-op rather than an error. A cancel that
        // races the action's completion must not surface as a failure to the user.
        "git.cancelStackedAction" => {
            let action_id = payload
                .get("actionId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if action_id.is_empty() {
                exit_failure(tx, &id, "cancelStackedAction requires an actionId");
                return;
            }
            let cancel_db = state.rt.store().db().clone();
            if let Err(e) = agent_sdk_do::Control::ensure_schema(&cancel_db).await {
                exit_failure(tx, &id, &format!("action control schema unavailable: {e}"));
                return;
            }
            let control = agent_sdk_do::Control::new(cancel_db);
            // `canceled` is TRUE ONLY IF THERE WAS A RUNNING ACTION TO STOP.
            //
            // The contract (packages/contracts/src/git.ts:531-540) is explicit
            // that an unknown id, or one that had already finished, must report
            // `false` — "telling a caller we stopped work that had already ended
            // is the same class of lie as the fail-open exit this finding is
            // about". My first version returned `true` unconditionally and called
            // it idempotence. Idempotent it was; honest it was not.
            //
            // `Control::cancel` only moves running -> cancelling, so the state
            // BEFORE the call is what decides the answer.
            let was_running = match control.state_opt(action_id).await {
                Ok(state) => state.as_deref() == Some("running"),
                Err(e) => {
                    exit_failure(tx, &id, &format!("action control state unreadable: {e}"));
                    return;
                }
            };
            let cancel = if was_running {
                control.cancel(action_id).await
            } else {
                Ok(())
            };
            match cancel {
                // `action: null` — this backend has no snapshot registry to
                // report. Null is the contract's shape for "no record", and it is
                // the truth here; fabricating an idle snapshot would be worse.
                Ok(()) => exit_success(
                    tx,
                    &id,
                    json!({ "canceled": was_running, "action": Value::Null }),
                ),
                Err(e) => exit_failure(tx, &id, &e),
            }
        }
        "sourceControl.lookupRepository" => {
            match sourcecontrol::lookup_repository(&payload).await {
                Ok(v) => exit_success(tx, &id, v),
                Err(e) => exit_failure(tx, &id, &e),
            }
        }
        "sourceControl.cloneRepository" => {
            match sourcecontrol::clone_repository(&payload, &state.cwd).await {
                Ok(v) => exit_success(tx, &id, v),
                Err(e) => exit_failure(tx, &id, &e),
            }
        }
        "sourceControl.publishRepository" => {
            match sourcecontrol::publish_repository(&payload, &state.cwd).await {
                Ok(v) => exit_success(tx, &id, v),
                Err(e) => exit_failure(tx, &id, &e),
            }
        }

        "filesystem.browse" => match projects::browse(&payload, &state.cwd) {
            Ok(v) => exit_success(tx, &id, v),
            Err((failure, message)) => exit_failure(tx, &id, &format!("{message} ({failure})")),
        },
        // Launching an editor is a HOST process with a path argument, so it
        // takes the same admission as every other path-bearing RPC: without it a
        // client can ask the backend to open any directory the backend user can
        // read (#184).
        "shell.openInEditor" => {
            let cwd = match req_cwd(&payload, &state).await {
                Ok(c) => c,
                Err(e) => return exit_failure(tx, &id, &e),
            };
            let admitted = {
                let mut p = payload.clone();
                if let Some(o) = p.as_object_mut() {
                    o.insert("cwd".into(), json!(cwd));
                }
                p
            };
            match projects::open_in_editor(&admitted, &state.cwd, &state.terminal).await {
                Ok(job_id) => exit_success(tx, &id, json!({ "jobId": job_id })),
                Err(e) => exit_failure(tx, &id, &e),
            }
        }

        "projects.listEntries"
        | "projects.searchEntries"
        | "projects.readFile"
        | "projects.writeFile"
        | "projects.searchContents" => {
            let cwd = match req_cwd(&payload, &state).await {
                Ok(c) => c,
                Err(e) => {
                    exit_failure(tx, &id, &e);
                    return;
                }
            };
            match method {
                // These two carry their failure IN the payload
                // (`statusUnavailable` / `statusError`) rather than failing the
                // request: the file panel can then say it is unavailable instead
                // of rendering an empty tree that looks like an empty repo.
                "projects.listEntries" => exit_success(tx, &id, projects::list_entries(&cwd).await),
                "projects.searchEntries" => {
                    exit_success(tx, &id, projects::search_entries(&cwd, &payload).await)
                }
                "projects.searchContents" => match projects::search_contents(&cwd, &payload).await {
                    Ok(v) => exit_success(tx, &id, v),
                    Err(e) => exit_failure(tx, &id, &e),
                },
                "projects.searchEntries" => {
                    exit_success(tx, &id, projects::search_entries(&cwd, &payload).await)
                }
                "projects.searchContents" => {
                    match projects::search_contents(&cwd, &payload).await {
                        Ok(v) => exit_success(tx, &id, v),
                        Err(e) => exit_failure(tx, &id, &e),
                    }
                }
                m => {
                    let out = if m == "projects.readFile" {
                        projects::read_file(&cwd, &payload).await
                    } else {
                        projects::write_file(&state.checkpoints, &cwd, &payload).await
                    };
                    match out {
                        Ok(v) => exit_success(tx, &id, v),
                        Err(e) => exit_failure(tx, &id, &e),
                    }
                }
            }
        }

        // ── review diff panel over the Cairn seam (#66) ────────────────────
        "review.getDiffPreview" => {
            match req_cwd(&payload, &state).await {
                // a diff that could not be computed is an ERROR, never an
                // empty panel that reads as "nothing to review" (#154)
                Ok(cwd) => match review::diff_preview(&cwd, &payload, &now_iso()).await {
                    Ok(v) => exit_success(tx, &id, v),
                    Err(e) => exit_failure(tx, &id, &e),
                },
                Err(e) => exit_failure(tx, &id, &e),
            }
        }
        "review.getDiffFileContents" => match req_cwd(&payload, &state).await {
            Ok(cwd) => match review::diff_file_contents(&cwd, &payload).await {
                Ok(v) => exit_success(tx, &id, v),
                Err(e) => exit_failure(tx, &id, &e),
            },
            Err(e) => exit_failure(tx, &id, &e),
        },

        // ── terminal RPCs over the ONE shared workspace PTY (#33) ──────────
        // Every terminalId resolves to the same Hearth Runner the agent's
        // run_bash uses, so a human pane mirrors exactly what the agent types.
        // `open` joins (or creates) a pane; `restart` REPLACES its shell and its
        // environment. They are different verbs on purpose: aliasing restart to
        // open left a "fresh" pane carrying the previous launch's exports (#98).
        "terminal.open" | "terminal.restart" => {
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.open: {e}")),
            };
            let thread = owner.thread_id().unwrap_or("").to_string();
            let (cwd, worktree) = match state
                .admit_pane_dir(
                    payload.get("cwd").and_then(Value::as_str),
                    terminal::worktree_of(&payload).as_deref(),
                )
                .await
            {
                Ok(v) => v,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.open: {e}")),
            };
            let cwd = cwd.as_deref();
            let env = terminal::env_of(&payload);
            let restarting = method == "terminal.restart";
            let opened = if restarting {
                state
                    .terminals
                    .restart(&owner, &term, cwd, worktree.as_deref(), &env)
                    .await
            } else {
                state
                    .terminals
                    .open(&owner, &term, cwd, worktree.as_deref(), &env)
                    .await
            };
            let pane = match opened {
                Ok(p) => p,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.open: {e}")),
            };
            if let (Some(cols), Some(rows)) = (
                payload.get("cols").and_then(Value::as_u64),
                payload.get("rows").and_then(Value::as_u64),
            ) {
                if let Err(e) = terminal::resize(&pane.runner, rows as u16, cols as u16).await {
                    return exit_failure(tx, &id, &e);
                }
            }
            let snap = terminal::pane_snapshot(&pane, &now_iso()).await;
            if restarting {
                // the contract has a distinct `restarted` event; a pane that only
                // saw a new snapshot could not tell a restart from a repaint.
                broadcast_terminal_event(
                    &state,
                    json!({ "type": "restarted", "threadId": owner.thread_id(), "terminalId": term, "snapshot": snap }),
                )
                .await;
            }
            exit_success(tx, &id, snap);
        }
        "terminal.write" => {
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.write: {e}")),
            };
            let runner = match state.pane_runner(&owner, &term).await {
                Ok(runner) => runner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.write: {e}")),
            };
            if let Some(data) = payload.get("data").and_then(Value::as_str) {
                if let Err(e) = terminal::write(&runner, data).await {
                    return exit_failure(tx, &id, &e);
                }
            }
            exit_success(tx, &id, Value::Null);
        }
        "terminal.resize" => {
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.resize: {e}")),
            };
            let runner = match state.pane_runner(&owner, &term).await {
                Ok(runner) => runner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.resize: {e}")),
            };
            if let (Some(cols), Some(rows)) = (
                payload.get("cols").and_then(Value::as_u64),
                payload.get("rows").and_then(Value::as_u64),
            ) {
                // A refused resize is not a resize. Acking success here told the
                // client its terminal had been resized when hearth had rejected
                // the control outright.
                if let Err(e) = terminal::resize(&runner, rows as u16, cols as u16).await {
                    return exit_failure(tx, &id, &format!("terminal.resize: {e}"));
                }
            }
            exit_success(tx, &id, Value::Null);
        }
        // clear empties the pane's SCREEN (shell, cwd and env survive); close
        // ends that pane. Neither is a no-op ack any more, and neither kills the
        // agent's shared shell (#105).
        "terminal.clear" => {
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.clear: {e}")),
            };
            let runner = match state.pane_runner(&owner, &term).await {
                Ok(runner) => runner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.clear: {e}")),
            };
            terminal::clear(&runner).await;
            broadcast_terminal_event(
                &state,
                json!({ "type": "output", "threadId": owner.thread_id(), "terminalId": term,
                        "data": terminal::repaint("") }),
            )
            .await;
            exit_success(tx, &id, Value::Null);
        }
        "terminal.close" => {
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.close: {e}")),
            };
            let killed = match state.terminals.close(&owner, &term).await {
                Ok(killed) => killed,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.close: {e}")),
            };
            broadcast_terminal_event(
                &state,
                json!({ "type": "closed", "threadId": owner.thread_id(), "terminalId": term, "killedShell": killed }),
            )
            .await;
            exit_success(tx, &id, Value::Null);
        }
        "terminal.attach" => {
            // stream: initial snapshot, then a full-repaint output on every screen
            // change, until the socket closes or the shell dies.
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.attach: {e}")),
            };
            let thread = owner.thread_id().unwrap_or("").to_string();
            let (cwd, worktree) = match state
                .admit_pane_dir(
                    payload.get("cwd").and_then(Value::as_str),
                    terminal::worktree_of(&payload).as_deref(),
                )
                .await
            {
                Ok(v) => v,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.attach: {e}")),
            };
            let cwd = cwd.as_deref();
            let env = terminal::env_of(&payload);
            // `restartIfNotRunning`: a client joining a dead pane can ask for a
            // live one instead of attaching to a corpse (#99).
            let restart_if_dead = payload
                .get("restartIfNotRunning")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let pane = match state
                .terminals
                .open(&owner, &term, cwd, worktree.as_deref(), &env)
                .await
            {
                Ok(p) => p,
                Err(e) => return exit_failure(tx, &id, &format!("terminal.attach: {e}")),
            };
            let pane = if restart_if_dead && terminal::is_dead(&pane.runner).await.is_some() {
                match state
                    .terminals
                    .restart(&owner, &term, cwd, worktree.as_deref(), &env)
                    .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        return exit_failure(tx, &id, &format!("terminal.attach restart: {e}"))
                    }
                }
            } else {
                pane
            };
            let snap = terminal::pane_snapshot(&pane, &now_iso()).await;
            chunk(tx, &id, json!({ "type": "snapshot", "snapshot": snap }));
            spawn_terminal_tail(pane.runner.clone(), tx.clone(), id.clone(), thread, term);
        }
        "subscribeTerminalEvents" => {
            // A SUBSCRIPTION DOES NOT CREATE A PANE (#228). `open` returns an
            // existing pane unchanged, so a subscribe that races ahead of
            // `terminal.attach`/`terminal.open` would pin this id to the
            // workspace default cwd/env permanently — the UI believes it opened
            // a worktree or subagent shell while the backend already decided
            // otherwise. Identity belongs to whoever supplies cwd/worktree/env.
            let term = terminal::terminal_id(&payload);
            // WHO this pane belongs to (#149): a child session when the request
            // names one, otherwise the thread. Parsed per request so a subagent
            // addresses its own PTY instead of silently getting the parent's.
            let owner = match terminal::TerminalOwner::parse(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("subscribeTerminalEvents: {e}")),
            };
            let thread = owner.thread_id().unwrap_or("").to_string();
            // Terminal-events fanout is on the SDK's generic named-topic
            // seam; the pump below carries every lifecycle frame to this
            // subscriber. Attach BEFORE snapshotting so no frame published
            // between the snapshot and the attach is lost.
            let tail = match state
                .rt
                .topic_tail_skip_retained(TERMINAL_EVENTS_TOPIC)
                .await
            {
                Ok(tail) => tail,
                Err(e) => return exit_failure(tx, &id, &format!("subscribeTerminalEvents: {e}")),
            };
            spawn_thread_tail(
                tail,
                tx.clone(),
                id.clone(),
                TERMINAL_EVENTS_TOPIC.to_string(),
            );
            match state.terminals.get(&owner, &term).await {
                Ok(Some(pane)) => {
                    let started = terminal::pane_snapshot(&pane, &now_iso()).await;
                    chunk(tx, &id, json!({ "type": "started", "threadId": owner.thread_id(), "terminalId": term, "snapshot": started }));
                    spawn_terminal_tail(pane.runner.clone(), tx.clone(), id.clone(), thread, term);
                }
                Ok(None) => {
                    // Announce the subscription with no snapshot, then WAIT for
                    // the real open rather than manufacturing one.
                    chunk(tx, &id, json!({
                        "type": "started", "threadId": owner.thread_id(), "terminalId": term,
                        "snapshot": Value::Null, "pending": true,
                    }));
                    let terminals = state.terminals.clone();
                    let (tx2, id2) = (tx.clone(), id.clone());
                    let (owner2, thread2, term2) = (owner.clone(), thread.clone(), term.clone());
                    tokio::spawn(async move {
                        match terminals
                            .wait_for(&owner2, &term2, std::time::Duration::from_secs(300))
                            .await
                        {
                            Ok(Some(pane)) => {
                                let snap = terminal::pane_snapshot(&pane, &now_iso()).await;
                                chunk(&tx2, &id2, json!({
                                    "type": "started", "threadId": thread2.clone(), "terminalId": term2.clone(),
                                    "snapshot": snap,
                                }));
                                spawn_terminal_tail(pane.runner.clone(), tx2, id2, thread2, term2);
                            }
                            Ok(None) => {}
                            Err(e) => {
                                chunk(&tx2, &id2, json!({
                                    "type": "started",
                                    "threadId": thread2,
                                    "terminalId": term2,
                                    "snapshot": Value::Null,
                                    "terminalUnavailable": true,
                                    "terminalError": e,
                                }));
                            }
                        }
                    });
                }
                Err(e) => {
                    chunk(tx, &id, json!({
                        "type": "started",
                        "threadId": owner.thread_id(),
                        "terminalId": term,
                        "snapshot": Value::Null,
                        "terminalUnavailable": true,
                        "terminalError": e,
                    }));
                }
            }
        }
        "subscribeTerminalMetadata" => {
            // EVERY pane open for this thread, not a hard-coded single id: a
            // multi-pane UI lists what actually exists (#118).
            let thread_owner = match terminal::TerminalOwner::parse_thread(&payload) {
                Ok(owner) => owner,
                Err(e) => return exit_failure(tx, &id, &format!("subscribeTerminalMetadata: {e}")),
            };
            let thread = thread_owner.thread_id().unwrap_or("").to_string();
            // the agent's shell is always listed — it is the pane a human most
            // wants to find, and it exists whether or not anyone opened it.
            // This subscription is thread-scoped by contract: it projects the
            // panes of ONE thread. A child session's PTYs are a different
            // owner and are deliberately not folded in here (#149) — doing so
            // would put them in the parent's drawer, which is the ownership
            // boundary the finding is about.
            let thread_owner = terminal::TerminalOwner::thread(&thread);
            if let Err(e) = state
                .terminals
                .open(&thread_owner, terminal::AGENT_TERMINAL_ID, None, None, &[])
                .await
            {
                // The subscriber asked for pane METADATA. An unreadable pane
                // store is an answer to that question — "the store is
                // unavailable" — and it has to arrive on the stream, because a
                // bare RPC failure renders as no terminals rather than as a
                // fault the panel can show.
                chunk(
                    tx,
                    &id,
                    json!({
                        "type": "store_unavailable",
                        "threadId": thread,
                        "terminals": Value::Null,
                        "error": format!("terminal pane store unavailable: {e}"),
                    }),
                );
                return exit_failure(tx, &id, &format!("subscribeTerminalMetadata: {e}"));
            }
            // ATTACH THE TAIL BEFORE EMITTING ANYTHING. The merge left a
            // second snapshot here, ahead of the attach — so a subscription
            // whose durable tail then failed had already sent a live-looking
            // snapshot chunk, and the client rendered a stream that was never
            // going to receive an update.
            // Metadata fanout on the SDK's generic named-topic seam, scoped
            // per thread so a subscriber only wakes for its own panes.
            // Suppress the retained frame (the snapshot above already covered
            // it) then follow live pane events through the same pump the
            // shell/config tails use.
            let topic = terminal_meta_topic(&thread);
            let tail = match state.rt.topic_tail_skip_retained(&topic).await {
                Ok(tail) => tail,
                Err(e) => return exit_failure(tx, &id, &format!("subscribeTerminalMetadata: {e}")),
            };
            let _ = state
                .terminals
                .open(&thread_owner, terminal::AGENT_TERMINAL_ID, None, None, &[])
                .await;
            let now = now_iso();
            // An unreadable pane store is NOT an empty terminal list: the panel
            // would render "no terminals" for a workspace that has them.
            match state.terminals.list(&thread_owner).await {
                Ok(panes) => {
                    let mut rows = Vec::new();
                    for pane in panes {
                        rows.push(terminal::pane_summary(&pane, &now).await);
                    }
                    chunk(tx, &id, json!({ "type": "snapshot", "terminals": rows }));
                }
                Err(e) => chunk(
                    tx,
                    &id,
                    json!({
                        "type": "store_unavailable",
                        "terminals": Value::Null,
                        "error": format!("terminal pane store unavailable: {e}"),
                    }),
                ),
            }
            spawn_thread_tail(tail, tx.clone(), id.clone(), topic.clone());
            spawn_metadata_tail(state.terminals.clone(), tx.clone(), id.clone(), thread);
        }

        // Streams this runtime deliberately serves as EMPTY — they exist, they
        // are simply quiet on a local single-environment backend. This is an
        // allowlist on purpose: the old prefix catch-all parked EVERY unknown
        // `subscribe*`, so a stream the runtime had never implemented was
        // indistinguishable from one with nothing to say, and the UI hung on it
        // forever instead of being told the contract is missing (#49).
        m if INTENTIONALLY_EMPTY_STREAMS.contains(&m) => {}

        "orchestration.getArchivedShellSnapshot" => {
            // #74 (remaining): archived-thread view returns the same
            // OrchestrationShellSnapshot shape subscribeShell's initial
            // frame does, but filtered to threads with a non-null
            // `archivedAt` (per the contract's OrchestrationThreadShell
            // field). No `thread.archived` command lands today so the
            // archived list is genuinely empty — NOT a stub. When
            // archiving becomes a runtime concept, the same filter picks
            // up the new rows without a handler change.
            //
            // snapshotSequence is stamped from the DURABLE counter (same
            // rule the live shell snapshot follows, #299): a client that
            // resumes from this mark reads events at seq > mark, whether
            // this snapshot was taken from process A or process B.
            let mark = match state.rt.current_sequence().await {
                Ok(mark) => mark,
                Err(e) => {
                    exit_failure(tx, &id, &format!("getArchivedShellSnapshot: sequence unreadable: {e}"));
                    return;
                }
            };
            // Same durable source as the live shell snapshot (#370),
            // fail-closed on a read error (#374). Silent `projects: []`
            // in a schema-valid archived snapshot alongside durable
            // threads is the mixed-authority defect this arm existed to
            // avoid.
            let projects = match state.rt.projects().await {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!(%e, "getArchivedShellSnapshot: project store unreadable");
                    exit_failure(
                        tx,
                        &id,
                        &format!("getArchivedShellSnapshot: project store unreadable: {e}"),
                    );
                    return;
                }
            };
            let threads: Vec<Value> = state
                .rt
                .threads()
                .await
                .into_iter()
                .filter(|t| !t.get("archivedAt").map(Value::is_null).unwrap_or(true))
                .collect();
            exit_success(
                tx,
                &id,
                json!({
                    "snapshotSequence": mark,
                    "projects": projects,
                    "threads": threads,
                    "updatedAt": now_iso(),
                }),
            );
        }
        "orchestration.dispatchCommand" => {
            let command = payload.get("input").cloned().unwrap_or(payload.clone());
            tracing::info!(
                cmd = command.get("type").and_then(|t| t.as_str()).unwrap_or("?"),
                thread_id = command
                    .get("threadId")
                    .and_then(|t| t.as_str())
                    .unwrap_or("-"),
                "dispatch"
            );
            // A turn's model is resolved BEFORE the command is acked, because a
            // selection that cannot route must not become a turn at all: acking
            // and then substituting the default is how the thread ends up
            // showing one provider while another one ran (#50).
            let model = if command.get("type").and_then(|t| t.as_str()) == Some("thread.turn.start")
            {
                // #77 / packet EK: attachments in the command must not be
                // dropped silently. This runtime does not yet forward image
                // or file bytes to any provider — the ONLY current provider
                // shapes route text through ClaudeResume/CodexResume/
                // OpenAiCompat/AcpCli, and none of them consumes
                // `UploadChatAttachment[]`. Refuse the dispatch VISIBLY so
                // the prompt is not persisted under a UI that shows an
                // image the assistant never saw. Not fixed by "accept and
                // strip" — that is the exact defect the finding calls out.
                let attachments = command
                    .pointer("/message/attachments")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                if attachments > 0 {
                    exit_failure(
                        tx,
                        &id,
                        "attachments are not yet routable to this provider — remove the \
                         attached files or send them as a separate turn once support lands. \
                         (the runtime refuses to persist a prompt under a UI that shows \
                         attachments the model would never receive.)",
                    );
                    return;
                }
                // AN EMPTY PROMPT IS NOT A TURN. Refused HERE, before anything
                // mutates — the same place and for the same reason as the
                // attachment refusal above.
                //
                // #272 caught this in the TypeScript adapter, where a
                // whitespace-only send reached `setModel` and stamped an active
                // turn before the empty check ran. The Rust path had the same
                // hole and rather more to lose by it: `text` was read with
                // `unwrap_or("")` and never trimmed, so `"   "` would ack, take
                // a DURABLE turn claim, announce the thread on the shell,
                // emit `TurnStarted`, take a worktree CHECKPOINT (#65), and run
                // a model with an empty prompt. The user sees a turn they did
                // not send, and every accidental space bar burns a checkpoint.
                //
                // Whitespace-only with no attachments is the whole condition:
                // attachments are refused above, so there is no case here where
                // an empty text carries meaning.
                let empty_prompt = command
                    .pointer("/message/text")
                    .and_then(Value::as_str)
                    .map(|t| t.trim().is_empty())
                    .unwrap_or(true);
                if empty_prompt {
                    exit_failure(
                        tx,
                        &id,
                        "a turn needs a prompt — this message is empty or whitespace. \
                         (refused before anything changed: no turn claim, no thread \
                         announcement, no checkpoint.)",
                    );
                    return;
                }
                let sel = command.get("modelSelection").cloned().unwrap_or(json!({}));
                let resolved = model_from_selection(
                    &*state.catalog.read().await,
                    &sel,
                    &state.default_model().await,
                );
                match resolved {
                    Ok(m) => Some(m),
                    Err(e) => {
                        // Visible, terminal, and no turn started under a
                        // substituted binding.
                        exit_failure(tx, &id, &format!("cannot run this model selection: {e}"));
                        return;
                    }
                }
            } else {
                None
            };
            // DispatchResult is { sequence } — an ACK, not an event. It is
            // durable (a client that remembers the last dispatch number must
            // not see it rewind after a restart, #299) but it comes from the
            // COMMAND counter, not the event counter (packet L): nothing is
            // ever recorded under an ack's number, so taking one out of the
            // event space left a permanent hole there — a watermark no event
            // carried, which a catch-up cannot tell apart from a lost event.
            let seq = match state.rt.next_command_sequence().await {
                Ok(s) => s,
                Err(e) => {
                    exit_failure(
                        tx,
                        &id,
                        &format!("no durable sequence for this dispatch: {e}"),
                    );
                    return;
                }
            };
            // WHEN the ack goes out is the honesty question, and it differs by
            // command shape:
            //
            // * `thread.turn.start` starts a long-running turn on another task.
            //   Its ack means ACCEPTED and must go out now — waiting for the
            //   turn would hold the request open for the length of a model call.
            // * Everything else is applied synchronously right here. Acking
            //   those BEFORE running them is why a failed `thread.meta.update`
            //   could only be logged: the terminal frame had already left, so
            //   the client was told a setting landed that the runtime never
            //   received — the exact defect #73's own comment describes. And
            //   sending a second Exit afterwards is a protocol violation: one
            //   request, one terminal.
            //
            // So: accepted-ack for the async lane, applied-ack for the rest.
            let async_lane =
                command.get("type").and_then(|t| t.as_str()) == Some("thread.turn.start");
            if async_lane {
                exit_success(tx, &id, json!({ "sequence": seq }));
            }
            match command.get("type").and_then(|t| t.as_str()) {
                Some("thread.turn.start") => {
                    if let Some(model) = model {
                        ensure_thread_on_shell(&state, &command).await;
                        run_turn(command, model, state.clone());
                    }
                }
                // STOP MEANS STOP (#52). Acking a stop while the turn keeps
                // running is worse than having no stop button: the model burns
                // tokens and the user believes they stopped it. Two things have
                // to happen — the SDK's durable turn cancel, and Hearth's
                // foreground interrupt for a bash command already running in
                // the shared PTY.
                Some(kind @ ("thread.turn.interrupt" | "thread.session.stop")) => {
                    let thread_id =
                        command.get("threadId").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    match stop_thread_checked(&state, &thread_id, kind).await {
                        Ok(sessions) => tracing::info!(
                            %thread_id, %kind, sessions = sessions.len(), "stop dispatched"
                        ),
                        Err(e) => {
                            tracing::error!(%thread_id, %kind, %e, "stop failed");
                            exit_failure(tx, &id, &format!("{kind} failed: {e}"));
                            return;
                        }
                    };
                    let shell_out = match interrupt_foreground_terminal(&state.terminal).await {
                        Ok(out) => out,
                        Err(e) => {
                            tracing::error!(%thread_id, %kind, %e, "terminal interrupt failed");
                            exit_failure(tx, &id, &format!("{kind} terminal interrupt failed: {e}"));
                            return;
                        }
                    };
                    tracing::info!(%thread_id, %kind, %shell_out, "stop dispatched");
                }
                // #65: the destructive revert the diff panel offers. Acking it
                // and doing nothing was the worst available behaviour — the UI
                // reports the files restored while the worktree still holds
                // every edit the user just rejected.
                Some("thread.checkpoint.revert") => {
                    let thread_id = thread_id_of(&command);
                    let turn_count = command
                        .get("turnCount")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    // Tell the thread the revert was REQUESTED before doing it:
                    // restoring a worktree takes git time, and a panel with no
                    // acknowledgement invites a second click.
                    if let Err(e) = emit_thread_event(
                        &state.rt,
                        &thread_id,
                        "thread.checkpoint-revert-requested",
                        json!({ "threadId": thread_id, "turnCount": turn_count }),
                    )
                    .await
                    {
                        tracing::error!(%thread_id, turn_count, %e, "checkpoint revert request event failed");
                        exit_failure(
                            tx,
                            &id,
                            &format!(
                                "checkpoint revert refused before mutation: request event failed: {e}"
                            ),
                        );
                        return;
                    }
                    if let Err(e) = revert_checkpoint(&state, &thread_id, turn_count).await {
                        tracing::error!(%thread_id, turn_count, %e, "checkpoint revert failed");
                        // TYPED failure, not a defect: the client matches on
                        // the error tag to render a dispatch failure. A bare
                        // Die reaches it as an unhandled crash instead.
                        exit_typed_failure(
                            tx,
                            &id,
                            json!({
                                "_tag": "OrchestrationDispatchCommandError",
                                "message": format!("checkpoint revert failed: {e}"),
                            }),
                        );
                        return;
                    }
                }
                // #73: metadata the frontend changes OUTSIDE a turn — model
                // picker, runtime/interaction mode, title, branch. Acking these
                // and dropping them means the UI shows a setting the runtime
                // never received, and the next turn silently uses the old one.
                Some("thread.meta.update") => {
                    let thread_id = thread_id_of(&command);
                    let patch = command.get("patch").cloned().unwrap_or(command.clone());
                    // FAIL VISIBLY. This arm used to log the error and fall
                    // through to the generic Success ack, which is the exact
                    // defect its own comment above describes: the client is told
                    // the model/mode/title change landed, the runtime never
                    // received it, and the next turn silently uses the old one.
                    // Proven on the live socket — an update against an unknown
                    // thread returned `Exit(Success)` while the server logged
                    // `unknown thread`. The arm below (`project.meta.update`)
                    // already had this right; now they agree.
                    if let Err(e) = update_thread_meta(&state, &thread_id, &patch).await {
                        tracing::error!(%thread_id, %e, "thread.meta.update failed");
                        exit_failure(tx, &id, &format!("thread.meta.update failed: {e}"));
                        return;
                    }
                }
                Some("project.meta.update") => {
                    // Durable UPDATE (#370): the old in-memory patch mutated
                    // this process's Vec and evaporated on restart, so a
                    // renamed project reverted on the next boot and a second
                    // backend never saw the change at all. Read the current
                    // row from the SDK store, patch it, save it back.
                    let project_id = command
                        .get("projectId")
                        .and_then(Value::as_str)
                        .unwrap_or("p-workspace")
                        .to_string();
                    let patch = command.get("patch").cloned().unwrap_or(command.clone());
                    // FAIL CLOSED (#374): a store read error is NOT an
                    // empty project list — patching against an empty read
                    // would silently drop the update as "unknown project"
                    // when in fact we could not tell.
                    let current = match state.rt.projects().await {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::error!(%project_id, %e, "project.meta.update: project store unreadable; refusing patch");
                            exit_failure(tx, &id, &format!("project store unreadable: {e}"));
                            return;
                        }
                    };
                    let Some(existing) = current
                        .into_iter()
                        .find(|p| p.get("id").and_then(Value::as_str) == Some(project_id.as_str()))
                    else {
                        // #400: unknown projectId. Was falling through to the
                        // generic Exit(Success){sequence} — an ack for a
                        // mutation that did NOTHING. That's the same false-
                        // terminal defect the thread path already had fixed
                        // (a Success carrying a sequence for no state change
                        // is a lie the reducer folds as "applied").
                        tracing::warn!(%project_id, "project.meta.update: no such project — refusing");
                        exit_failure(
                            tx,
                            &id,
                            &format!("project.meta.update: no project with id {project_id:?}"),
                        );
                        return;
                    };
                    let mut updated = existing;
                    if let (Some(o), Some(patch)) = (updated.as_object_mut(), patch.as_object()) {
                        for (k, v) in patch {
                            if k != "id" && k != "createdAt" {
                                o.insert(k.clone(), v.clone());
                            }
                        }
                        o.insert("updatedAt".into(), json!(now_iso()));
                    }
                    if let Err(e) = state.rt.save_project(&updated).await {
                        tracing::error!(%project_id, %e, "project.meta.update failed to persist");
                        exit_failure(tx, &id, &format!("project.meta.update failed: {e}"));
                        return;
                    }
                    // ANNOUNCE IT (found on the live wire). The row was
                    // saved durably and nothing was emitted, so:
                    //   * a connected client got no frame — the sidebar kept
                    //     the old title until something forced a full
                    //     snapshot;
                    //   * a client reconnecting with `afterSequence` was
                    //     handed `{"kind":"synchronized"}` and nothing else,
                    //     because there was no sequenced frame to replay.
                    //     That is "synchronized" announced over a change it
                    //     can never learn about, which is the exact failure
                    //     the thread path already had fixed.
                    // Same seam as `upsert_thread_on_shell`: the SDK
                    // allocates the sequence, records the replay row, then
                    // publishes. The product only supplies the vocabulary.
                    //
                    // #400: emission failure now fails the RPC too. Saying
                    // Success while the replay row is missing lets the reducer
                    // advance past a change it can never learn about after
                    // reconnect. The durable row is already written; the
                    // client can retry, and the store side is idempotent.
                    let frame = json!({ "kind": "project-upserted", "project": updated });
                    if let Err(e) = state.rt.emit_shell_event(frame).await {
                        tracing::error!(%project_id, %e, "shell emission failed — refusing so reducer does not fold a lie");
                        exit_failure(
                            tx,
                            &id,
                            &format!(
                                "project.meta.update persisted but shell replay emission failed: {e}"
                            ),
                        );
                        return;
                    }
                }
                // #69/#90: the answers to a parked turn, in the CONTRACT's
                // vocabulary. The requestId carries session|turn|callId, so
                // nothing here has to remember which session asked — that map
                // is what the SDK seam removed.
                Some("thread.approval.respond") => {
                    let request_id = command
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // `decision` is an ENUM: accept | acceptForSession | decline
                    // | cancel. Reading a boolean `approved` and defaulting to
                    // false turned every real acceptance into a denial, which
                    // is worse than not implementing it — the user clicks
                    // Approve and the tool is refused.
                    let decision = command
                        .get("decision")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let allow = approval_allow(&command);
                    let parts: Vec<&str> = request_id.split('|').collect();
                    // The requestId IS the routing (packet M): session|turn|callId.
                    // A turn that will not parse must NOT become 0 — that
                    // answers a different turn than the one the user was
                    // looking at, and the turn they answered stays parked. Fail
                    // closed and tell the client, which keeps the banner up
                    // with an error instead of clearing it over a lost answer.
                    let routed = match (
                        parts.len(),
                        parts.get(1).and_then(|t| t.parse::<i64>().ok()),
                    ) {
                        (3, Some(turn)) => Some((parts[0].to_string(), turn, parts[2].to_string())),
                        _ => None,
                    };
                    match routed {
                        None => {
                            tracing::error!(%request_id, "malformed approval requestId — refusing to route");
                            let detail =
                                "this approval could not be routed (malformed request id)";
                            if let Err(e) = publish_approval_failed(
                                &state, &thread_id_of(&command), &request_id, detail,
                            )
                            .await
                            {
                                exit_failure(tx, &id, &format!("approval failure projection failed: {e}"));
                                return;
                            }
                            exit_failure(tx, &id, detail);
                            return;
                        }
                        Some((session, turn, call_id)) => {
                            match state
                                .rt
                                .respond_to_approval(&session, turn, &call_id, allow)
                                .await
                            {
                                Ok(_) => {
                                    // clear the pending UI state: a client that only
                                    // ever sees "requested" keeps the banner up.
                                    if let Err(e) = publish_approval_resolved(
                                        &state, &thread_id_of(&command), &request_id, &decision, allow,
                                    )
                                    .await
                                    {
                                        exit_failure(tx, &id, &format!("approval settlement projection failed: {e}"));
                                        return;
                                    }
                                }
                                Err(e) => {
                                    // The answer did not land. Saying nothing
                                    // left the user with a banner that looked
                                    // ignored; clearing it would be worse. The
                                    // request stays pending and carries why.
                                    tracing::error!(%request_id, %e, "approval response failed");
                                    let detail = format!("the approval could not be delivered: {e}");
                                    if let Err(projection) = publish_approval_failed(
                                        &state, &thread_id_of(&command), &request_id,
                                        &detail,
                                    )
                                    .await
                                    {
                                        exit_failure(tx, &id, &format!("approval failure projection failed: {projection}"));
                                        return;
                                    }
                                    exit_failure(tx, &id, &detail);
                                    return;
                                }
                            }
                        }
                    }
                }
                Some("thread.user-input.respond") => {
                    let request_id = command
                        .get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    // the contract sends an ANSWERS MAP, not a `text` field.
                    // Reading `text` meant every normal UI submission steered
                    // the run with an empty string.
                    let text = command
                        .get("answers")
                        .and_then(Value::as_object)
                        .map(|m| {
                            let mut keys: Vec<&String> = m.keys().collect();
                            keys.sort(); // stable, so a multi-answer form reads the same every time
                            keys.iter()
                                .map(|k| {
                                    let v = &m[*k];
                                    let text = v
                                        .as_str()
                                        .map(String::from)
                                        .unwrap_or_else(|| v.to_string());
                                    if keys.len() == 1 {
                                        text
                                    } else {
                                        format!("{k}: {text}")
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .or_else(|| {
                            command
                                .get("text")
                                .and_then(Value::as_str)
                                .map(String::from)
                        })
                        .or_else(|| {
                            command
                                .pointer("/message/text")
                                .and_then(Value::as_str)
                                .map(String::from)
                        })
                        .unwrap_or_default();
                    // The requestId for user input is the session id itself.
                    let session = request_id
                        .split('|')
                        .next()
                        .unwrap_or(&request_id)
                        .to_string();
                    match state.rt.respond_to_user_input(&session, &text).await {
                        Ok(()) => {
                            // Close the composer's pending state (#317). Only on
                            // success: telling the client the question is
                            // answered when the answer never reached the agent
                            // would unblock the composer over a lost answer.
                            if let Err(e) =
                                publish_user_input_resolved(&state, &thread_id_of(&command), &session)
                                    .await
                            {
                                exit_failure(tx, &id, &format!("user-input settlement projection failed: {e}"));
                                return;
                            }
                        }
                        Err(e) => {
                            // Same rule as an approval that could not be
                            // delivered: the composer stays pending, with a
                            // visible reason, rather than being unblocked over
                            // an answer the agent never received.
                            tracing::error!(%request_id, %e, "user-input response failed");
                            let detail = format!("your answer could not be delivered: {e}");
                            if let Err(projection) = publish_user_input_failed(
                                &state, &thread_id_of(&command), &session,
                                &detail,
                            )
                            .await
                            {
                                exit_failure(tx, &id, &format!("user-input failure projection failed: {projection}"));
                                return;
                            }
                            exit_failure(tx, &id, &detail);
                            return;
                        }
                    }
                }
                _ => {}
            }
            // The applied-ack. Any arm that failed has already sent its own
            // terminal and returned, so this cannot double-send.
            if !async_lane {
                exit_success(tx, &id, json!({ "sequence": seq }));
            }
        }

        // Pull-request surface (#111 / packet AB capability rule). This
        // runtime has no PR CLI wired (no gh/glab/az/bb, no host
        // credentials), so every PR RPC returns the CONTRACT'S typed
        // unavailable error rather than an untyped unsupported-method
        // failure or a masking `Success(null)`. `provider-unsupported`
        // tells the reducer to hide the PR panel / disable actions instead
        // of hanging on a call the backend cannot fulfil.
        //
        // Two shapes: `PullRequestUnavailableError` for READ paths (the
        // client folds it into hidden/disabled UI) and
        // `PullRequestOperationError` for MUTATIONS (the click-time
        // refusal, named with the operation the client requested).
        m if m.starts_with("pullRequests.") => {
            let unavailable = json!({
                "_tag": "PullRequestUnavailableError",
                "reason": "provider-unsupported",
            });
            let op_failure = |op: &str| {
                json!({
                    "_tag": "PullRequestOperationError",
                    "operation": op,
                    "detail": "This runtime does not have a pull-request provider configured.",
                })
            };
            match m {
                "pullRequests.list"
                | "pullRequests.listStats"
                | "pullRequests.detail"
                | "pullRequests.activity"
                | "pullRequests.threadComments"
                | "pullRequests.diffFileContents"
                | "pullRequests.reviewerCandidates" => exit_typed_failure(tx, &id, unavailable),
                op @ ("pullRequests.runAction"
                | "pullRequests.update"
                | "pullRequests.comment"
                | "pullRequests.updateComment"
                | "pullRequests.submitReview"
                | "pullRequests.replyToThread"
                | "pullRequests.setThreadResolution"
                | "pullRequests.setReaction"
                | "pullRequests.invalidate"
                | "pullRequests.requestReviewers") => {
                    exit_typed_failure(tx, &id, op_failure(op.trim_start_matches("pullRequests.")))
                }
                _ => exit_typed_failure(tx, &id, unavailable),
            }
        }

        // Genuinely unimplemented RPCs FAIL explicitly rather than returning a
        // masking Success(null): a missing mutation/subscription surfaces as a
        // visible defect instead of a silent reducer inconsistency later.
        other => {
            tracing::warn!(
                method = other,
                "ws: unsupported RPC — returning explicit failure"
            );
            exit_failure(tx, &id, &format!("unsupported method: {other}"));
        }
    }
}

/// Run one turn by DELEGATING to the SDK [`ThreadRuntime`]. The backend no
/// longer owns session binding, stream cursor, history write-through, or the
/// terminal-lifecycle guarantee — all of that is the runtime's job. This
/// function only: picks the model, builds the durable [`SessionBinding`], and
/// hands a [`T3Projector`] to `rt.run_turn`, which emits every lifecycle fact
/// (including a guaranteed `TurnEnded`) on the durable bus (#5/#14/#15/#16/#17).
fn run_turn(command: Value, model: ModelRef, state: AppState) {
    tokio::spawn(async move {
        let thread_id = command
            .get("threadId")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        // Turn admission is NOT held here. `ThreadRuntime::run_turn_*` takes a
        // durable per-thread claim, so a second dispatch is refused whether it
        // comes from this process, another process on the same data dir, or a
        // re-dispatch after this one crashed mid-turn (#300). A process-local
        // mutex map enforced none of those, and keeping one as a "fast path"
        // would just be a second admission mechanism to disagree with the first.
        let text = command
            .pointer("/message/text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        // The id the client already rendered optimistically. Handing it to the
        // runtime is what makes the durable prompt row RECONCILE with what the
        // UI is showing instead of appearing beside it as a second message.
        let prompt_id = command
            .pointer("/message/messageId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        // The model was resolved at dispatch (#50): by the time a turn runs,
        // the provider it will use is already known to be the one the user
        // picked, so there is no path here that silently swaps it.
        // The binding identity: thread + configured provider instance + model.
        // The runtime keys the durable session on all three, so switching the
        // instance never resumes a native provider thread under the wrong config.
        // the durable thread record: the source for anything the command did
        // not repeat (mode, model selection).
        let stored = state
            .rt
            .threads()
            .await
            .into_iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(thread_id.as_str()));
        // The binding identity is the CONFIGURED instance the user picked, not
        // one derived from the resolved backend. Two instances of the same
        // driver pointing at the same base url and model — different creds,
        // env, or display identity — would otherwise collapse onto one durable
        // provider session, defeating the isolation the binding exists for
        // (#103). Falls back to the derived id only when the command carried no
        // selection at all.
        let configured_instance = command
            .pointer("/modelSelection/instanceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|t| t.pointer("/modelSelection/instanceId"))
                    .and_then(Value::as_str)
                    .map(String::from)
            })
            .unwrap_or_else(|| agent_sdk_shell::provider_instance_id(&model));
        let binding = SessionBinding {
            thread_id: thread_id.clone(),
            provider_instance_id: configured_instance,
            model_key: format!("{model:?}"),
        };
        // The gate the user asked for. Read from the COMMAND when present, else
        // from the durable thread record — a mode set earlier by
        // `thread.meta.update` must still apply to a turn that does not repeat
        // it (#73/#79).
        let pick = |key: &str, fallback: &str| -> String {
            command
                .get(key)
                .and_then(Value::as_str)
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|t| t.get(key))
                        .and_then(Value::as_str)
                })
                .unwrap_or(fallback)
                .to_string()
        };
        let runtime_mode = pick("runtimeMode", "full-access");
        let interaction_mode = pick("interactionMode", "default");
        let (ask_tools, instructions) = policy_for(&runtime_mode, &interaction_mode);
        tracing::info!(%thread_id, %runtime_mode, %interaction_mode, gated = ask_tools.len(), "turn policy");
        // WHERE this turn works. A thread created against a worktree stored the
        // path on its record; without carrying it onto the definition the tool
        // registry was built over the boot-time workspace root and the agent
        // edited the MAIN checkout while the UI showed the worktree (#207).
        let worktree = stored
            .as_ref()
            .and_then(|t| t.get("worktreePath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);
        // #89 SECOND pass: the user's option choices now REACH the provider.
        // `model_from_selection` already validated them against the instance's
        // descriptors; carrying them onto the definition is what makes them
        // change the session that actually runs (the SDK applies them in
        // `build_model_with_options` / `CodexCli::with_options`). Falling back
        // to the stored thread's selection matters because a follow-up turn
        // often repeats only the text — dropping the options there would make
        // the knob apply to the first message of a thread and nothing after.
        let options = {
            use agent_sdk_provider::instance::decode_option_selections;
            command
                .pointer("/modelSelection/options")
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|t| t.pointer("/modelSelection/options"))
                })
                .filter(|v| !v.is_null())
                .map(decode_option_selections)
                .unwrap_or_default()
        };
        let def = AgentDefinition {
            name: "t3code".into(),
            instructions,
            model,
            tools: vec![],
            ask_tools,
            subagents: vec![],
            mcp_servers: vec![],
            labels: Default::default(),
            options,
            cwd: worktree,
        };
        // Open this thread's shell before the turn: the registry factory is
        // synchronous, so a root nobody ensured would silently fall back to the
        // workspace PTY — the agent shelling into the main checkout while the
        // UI shows the worktree (#207).
        if let Some(wt) = def.cwd.as_deref() {
            if let Err(e) = state.tool_roots.ensure(std::path::Path::new(wt)).await {
                tracing::error!(%thread_id, %wt, %e, "worktree shell unavailable");
                return;
            }
        }
        // The worktree the turn will actually edit — a per-thread worktree when
        // the thread has one, else the workspace. The checkpoint has to be taken
        // in the same tree the agent writes to, or it reviews the wrong repo.
        let turn_cwd = def.cwd.clone().unwrap_or_else(|| state.cwd.clone());
        let projector = turn_projector(&state, turn_cwd);
        // The runtime owns the whole turn lifecycle and guarantees a terminal
        // event on every path; the outcome is just logged here.
        let outcome = state
            .rt
            .run_turn_with_prompt_id(&binding, def, &text, prompt_id.as_deref(), &projector)
            .await;
        if let TurnOutcome::Failed { message } = &outcome {
            tracing::error!(%thread_id, %message, "turn failed");
        }
    });
}

/// Tail the shared PTY's rendered screen and forward it as terminal `output`
/// events on an open stream. Hearth renders a vt100 SCREEN rather than a raw
/// byte stream, so it publishes a change EDGE (`Runner::watch_screen`) that this
/// parks on; each wake emits a full repaint, and the shell's death emits a
/// terminal `exited` event. Stops when the socket closes.
fn spawn_terminal_tail(
    runner: terminal::Terminal,
    tx: mpsc::UnboundedSender<OutFrame>,
    req: Value,
    thread_id: String,
    term: String,
) {
    tokio::spawn(async move {
        let send = |v: Value| {
            tx.send((
                json!({ "_tag": "Chunk", "clientId": 0, "requestId": req, "values": [v] })
                    .to_string(),
                None,
            ))
        };
        // Subscribe BEFORE the first read, so an edge landing between the two is
        // still pending on the watch and wakes the first `changed()` instead of
        // being dropped.
        let mut edges = terminal::watch(&runner);
        let mut last = terminal::screen(&runner).await;
        while edges.changed().await.is_some() {
            let cur = terminal::screen(&runner).await;
            // The screen can be byte-identical across an edge (a repaint that
            // lands on the same glyphs), and a pane must not be spammed with
            // repaints it cannot see.
            if cur != last {
                last = cur.clone();
                if send(terminal::output_event(
                    &thread_id,
                    &term,
                    terminal::repaint(&cur),
                ))
                .is_err()
                {
                    return;
                }
            }
            if let Some(code) = terminal::is_dead(&runner).await {
                let _ = send(
                    json!({ "type": "exited", "threadId": thread_id, "terminalId": term,
                    "exitCode": code, "exitSignal": Value::Null }),
                );
                return;
            }
        }
    });
}

/// Tail the shared PTY's lifecycle and forward `upsert` metadata events when its
/// status/subprocess state changes. Parks on the same change edge as the screen
/// tail; hearth publishes one for a spawn, a death, and a relaunch, which is
/// exactly the set this projects.
/// Tail the metadata of EVERY pane a thread has open.
///
/// The initial snapshot lists the real registry, so a live-update path that
/// re-emitted a hard-coded `term-1` contradicted it the moment anything moved:
/// a pane the user opened would appear once and then never update, while a
/// phantom id kept reporting (#173/#118). The tail watches the panes that exist
/// and re-lists them whenever any of their lifecycles change.
fn spawn_metadata_tail(
    terminals: Arc<terminal::TerminalRegistry>,
    tx: mpsc::UnboundedSender<OutFrame>,
    req: Value,
    thread_id: String,
) {
    tokio::spawn(async move {
        let mut last: Option<Value> = None;
        loop {
            // Register interest in a membership change BEFORE reading the pane
            // list, so a pane opening or closing while this iteration builds and
            // sends its view wakes the wait below instead of being missed.
            let membership = terminals.membership();

            // The watch set is rebuilt EVERY pass, and that is the whole point:
            // built once, it silently excludes every pane opened later (their
            // status changes would never wake this tail, so the UI would show a
            // terminal frozen at whatever it was when some other pane last
            // moved) and it dies with the first pane closed, taking the entire
            // thread's terminal list down with it.
            //
            // Holding `panes` for the length of the iteration also keeps each
            // runner alive across the wait, so a watch cannot end underneath us
            // and turn one closed pane into a terminated stream.
            let panes = match terminals.list(&terminal::TerminalOwner::thread(&thread_id)).await {
                Ok(panes) => panes,
                Err(e) => {
                    let ev = json!({
                        "type": "store_unavailable",
                        "threadId": thread_id,
                        "terminals": Value::Null,
                        "error": format!("terminal pane store unavailable: {e}"),
                    });
                    let _ = tx.send((json!({ "_tag": "Chunk", "clientId": 0, "requestId": req, "values": [ev] }).to_string(), None));
                    return;
                }
            };
            let mut watches: Vec<hearth::ScreenWatch> =
                panes.iter().map(|p| terminal::watch(&p.runner)).collect();

            // Send what we just read, THEN wait. Emitting after the wait would
            // publish the membership we observed before it changed — always one
            // change behind. This also gives the client its opening snapshot
            // without needing a shell to move first.
            let now = now_iso();
            let mut rows = Vec::new();
            for pane in &panes {
                rows.push(terminal::pane_summary(pane, &now).await);
            }
            // only emit when something a client renders actually moved.
            let key: Value = rows
                .iter()
                .map(|s| {
                    json!({ "id": s["terminalId"], "status": s["status"],
                    "sub": s["hasRunningSubprocess"], "label": s["label"], "exit": s["exitCode"] })
                })
                .collect();
            if last.as_ref() != Some(&key) {
                last = Some(key);
                let ev = json!({ "type": "snapshot", "terminals": rows });
                if tx
                    .send((
                        json!({ "_tag": "Chunk", "clientId": 0, "requestId": req, "values": [ev] })
                            .to_string(),
                        None,
                    ))
                    .is_err()
                {
                    return;
                }
            }

            if watches.is_empty() {
                // No pane to watch is not the end of the subscription — the
                // client is still attached and a pane may yet open.
                membership.await;
            } else {
                let edges =
                    futures::future::select_all(watches.iter_mut().map(|w| Box::pin(w.changed())));
                tokio::select! {
                    _ = membership => {}
                    _ = edges => {}
                }
            }
        }
    });
}

/// The `server.getConfig` body.
///
/// `custom` is the user's stored keybinding rules; the resolved set the client
/// dispatches on is the defaults with those merged over (#71). It is passed in
/// rather than read here because this is called while the catalog lock is held
/// and the store read is `async`.
fn server_config(catalog: &Catalog, custom: &[keybindings::Rule]) -> Value {
    let cwd = std::env::var("T3CODE_WORKSPACE").unwrap_or_else(|_| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into())
    });
    json!({
        "environment": { "environmentId": "local", "label": "Local (Rust)", "platform": { "os": "darwin", "arch": "arm64" }, "serverVersion": "0.0.0", "capabilities": {} },
        "auth": { "policy": "unsafe-no-auth", "bootstrapMethods": [], "sessionMethods": [], "sessionCookieName": "t3_session" },
        "cwd": cwd,
        "keybindingsConfigPath": keybindings::config_path(),
        "keybindings": keybindings::resolved(custom),
        "issues": [], "availableEditors": [],
        // enumerated from the catalog — a configured provider is in the picker
        // by virtue of being configured, and an unusable one stays visible with
        // its reason instead of vanishing (#35).
        "providers": catalog.snapshots().iter().map(provider_entry).collect::<Vec<_>>(),
        "observability": { "logsDirectoryPath": "/tmp", "localTracingEnabled": false, "otlpTracesEnabled": false, "otlpMetricsEnabled": false },
        "settings": {},
    })
}

/// Redeem a signed asset URL: `GET /api/assets/{token}/{name}`.
///
/// The token — not the request path — names the file. `{name}` is decoration
/// for the browser's Save-As dialog and is never joined onto anything, so a
/// caller cannot walk out of the workspace by editing the last segment.
async fn asset_http(
    State(state): State<AppState>,
    axum::extract::Path((token, _name)): axum::extract::Path<(String, String)>,
) -> impl IntoResponse {
    let path = match assets::verify(
        &token,
        &state.assets_key,
        chrono::Utc::now().timestamp_millis(),
    ) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(%e, "asset: refused");
            return (
                axum::http::StatusCode::FORBIDDEN,
                [(axum::http::header::CONTENT_TYPE, "text/plain")],
                Vec::from(e),
            )
                .into_response();
        }
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            axum::http::StatusCode::OK,
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    assets::content_type(&path),
                ),
                // The URL is already single-use-ish (it expires); caching it for
                // its own lifetime is what keeps a scrolling chat from refetching
                // every image on every repaint.
                (axum::http::header::CACHE_CONTROL, "private, max-age=3600"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => {
            tracing::warn!(%e, ?path, "asset: read failed");
            (
                axum::http::StatusCode::NOT_FOUND,
                [(axum::http::header::CONTENT_TYPE, "text/plain")],
                Vec::from("asset not found"),
            )
                .into_response()
        }
    }
}

async fn capture_http(method: Method, uri: Uri, body: Bytes) -> impl IntoResponse {
    let path = uri.path().to_string();
    tracing::info!(%method, %path, "http");
    let auth = json!({ "policy": "unsafe-no-auth", "bootstrapMethods": [], "sessionMethods": [], "sessionCookieName": "t3_session" });
    let json: Value = match path.as_str() {
        // client identifies the environment from this — must be a valid descriptor
        "/.well-known/t3/environment" => environment_descriptor(),
        "/api/auth/session" => json!({ "authenticated": true, "auth": auth,
            "scopes": ["orchestration:read","orchestration:operate","terminal:operate","review:write","access:read","access:write"] }),
        "/api/auth/websocket-ticket" => json!({ "ticket": "dev-ticket" }),
        p if p.contains("pairing-links") || p.contains("clients") => json!([]),
        _ => json!({}),
    };
    Json(json)
}

// Tests live in their own files (#403). `server_main.rs` was 9,977 lines,
// 5,720 of them test code — which is what made it impossible to review the
// boundary between transport glue and runtime authority.
#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod usage_contract_tests;
