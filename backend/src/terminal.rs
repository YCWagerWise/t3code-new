//! The terminal RPC adapter: a REGISTRY of panes over Hearth runners.
//!
//! Two things have to be true at once, and collapsing them was the bug:
//!
//! * the human must be able to watch the shell the AGENT is running in — that
//!   is the whole point of one durable PTY behind `run_bash` (#33/#28); and
//! * the frontend's terminal contract is per-`(threadId, terminalId)` with
//!   client-chosen ids, its own `cwd`/`worktreePath`/`env`, and panes that open,
//!   restart, clear and close independently (#55/#57/#82/#98/#99/#105/#118/#133).
//!
//! So one reserved id — [`AGENT_TERMINAL_ID`] — is the shared workspace runner
//! the agent types into, and every OTHER pane gets its own Hearth runner rooted
//! at the cwd/worktree it asked for, with the env it was launched with. A pane
//! is real state: it is listed in metadata, restarted with a fresh environment,
//! cleared without killing its shell, and closed without touching anyone else's.
//!
//! Hearth renders a vt100 SCREEN (not a raw byte stream), so a live attach emits
//! the initial `TerminalSessionSnapshot` (its `history` is the rendered screen)
//! and then, whenever the screen changes, a full-repaint `output` event
//! (`ESC[2J ESC[H` + screen) so an xterm pane stays a faithful mirror.

use std::sync::Arc;

use hearth::session::SessionStatus;
use hearth::Runner;
use serde_json::{json, Value};

/// Map hearth's lifecycle to the contract's `starting|running|exited|error`.
fn status_str(s: SessionStatus) -> &'static str {
    match s {
        // "no shell spawned yet" reads as "starting" to the pane; the shell
        // lazy-spawns on the first write/command.
        SessionStatus::NotStarted => "starting",
        SessionStatus::Running => "running",
        SessionStatus::Exited => "exited",
        SessionStatus::Error => "error",
    }
}

fn label(status: SessionStatus) -> String {
    match status {
        SessionStatus::Running => "shell".into(),
        SessionStatus::NotStarted => "starting".into(),
        SessionStatus::Exited => "exited".into(),
        SessionStatus::Error => "error".into(),
    }
}

/// The `TerminalSessionSnapshot` the contract expects, built from a live hearth
/// snapshot. `history` carries the rendered screen so a fresh pane paints what
/// is already there.
pub async fn session_snapshot(
    runner: &Runner,
    thread_id: &str,
    terminal_id: &str,
    cwd: &str,
    now: &str,
) -> Value {
    snapshot_of(runner, &TerminalOwner::thread(thread_id), terminal_id, cwd, None, now).await
}

/// The snapshot for a registered pane — reports the pane's real cwd and
/// worktree, not the request's echo.
pub async fn pane_snapshot(pane: &Pane, now: &str) -> Value {
    snapshot_of(
        &pane.runner,
        &pane.owner,
        &pane.terminal_id,
        &pane.cwd,
        pane.worktree_path.as_deref(),
        now,
    )
    .await
}

async fn snapshot_of(
    runner: &Runner,
    owner: &TerminalOwner,
    terminal_id: &str,
    cwd: &str,
    worktree_path: Option<&str>,
    now: &str,
) -> Value {
    let snap = runner.snapshot().await;
    let s = snap.session;
    let (thread_id, session_id) = owner.wire();
    json!({
        "threadId": thread_id,
        // The child-session address (#149). Absent for a thread pane, so an
        // existing client sees byte-identical output.
        "sessionId": session_id,
        "terminalId": terminal_id,
        "cwd": cwd,
        "worktreePath": worktree_path,
        "status": status_str(s.status),
        "pid": s.shell_pid.and_then(|p| if p > 0 { Some(p as i64) } else { None }),
        "history": s.screen,
        "exitCode": s.exit_code,
        "exitSignal": Value::Null,
        "label": label(s.status),
        "updatedAt": now,
    })
}

/// The `TerminalSummary` for the metadata stream.
pub async fn summary(
    runner: &Runner,
    thread_id: &str,
    terminal_id: &str,
    cwd: &str,
    now: &str,
) -> Value {
    summary_of(runner, &TerminalOwner::thread(thread_id), terminal_id, cwd, None, now).await
}

/// The metadata row for a registered pane.
pub async fn pane_summary(pane: &Pane, now: &str) -> Value {
    summary_of(
        &pane.runner,
        &pane.owner,
        &pane.terminal_id,
        &pane.cwd,
        pane.worktree_path.as_deref(),
        now,
    )
    .await
}

async fn summary_of(
    runner: &Runner,
    owner: &TerminalOwner,
    terminal_id: &str,
    cwd: &str,
    worktree_path: Option<&str>,
    now: &str,
) -> Value {
    let snap = runner.snapshot().await;
    let s = snap.session;
    let (thread_id, session_id) = owner.wire();
    json!({
        "threadId": thread_id,
        // The child-session address (#149), absent for a thread pane.
        "sessionId": session_id,
        "terminalId": terminal_id,
        "cwd": cwd,
        "worktreePath": worktree_path,
        "status": status_str(s.status),
        "pid": s.shell_pid.and_then(|p| if p > 0 { Some(p as i64) } else { None }),
        "exitCode": s.exit_code,
        "exitSignal": Value::Null,
        "hasRunningSubprocess": matches!(s.status, SessionStatus::Running),
        "label": label(s.status),
        "updatedAt": now,
    })
}

/// A full-screen repaint payload for a `TerminalOutputEvent.data`: clear + home +
/// the current rendered screen, so an xterm pane exactly mirrors hearth's vt100
/// buffer regardless of what changed.
pub fn repaint(screen: &str) -> String {
    format!("\u{1b}[2J\u{1b}[3J\u{1b}[H{screen}")
}

/// A `TerminalEvent`/`TerminalAttachStreamEvent` of type `output`.
pub fn output_event(thread_id: &str, terminal_id: &str, data: String) -> Value {
    json!({ "type": "output", "threadId": thread_id, "terminalId": terminal_id, "data": data })
}

/// `terminal.write` → drive the shared PTY's foreground.
pub async fn write(runner: &Runner, data: &str) {
    let _ = runner.send_keys(data).await;
}

/// `terminal.resize` → resize the real PTY so wrapped output re-flows.
pub async fn resize(runner: &Runner, rows: u16, cols: u16) {
    let _ = runner.resize(rows, cols).await;
}

/// Interrupt the shared PTY's FOREGROUND process — a human "stop" while the
/// agent has a bash command running (Ctrl-C to the foreground, never the harness
/// itself, since hearth owns the process group). This is what a stop control
/// reaches (#52), distinct from `terminal.close` which only closes a pane.
pub async fn interrupt(runner: &Runner) -> Result<String, String> {
    runner.interrupt().await.map_err(|e| e.to_string())
}

/// `terminal.clear` → empty the pane's screen, keeping its shell (cwd, env and
/// any running program all survive).
pub async fn clear(runner: &Runner) {
    let _ = runner.clear_screen().await;
}

/// The launch environment a client asked for, as pairs. Absent/blank values are
/// dropped rather than exported as empty strings.
pub fn env_of(input: &Value) -> Vec<(String, String)> {
    input
        .get("env")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let v = v.as_str()?;
                    (!k.is_empty()).then(|| (k.clone(), v.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The worktree a pane was opened for, if any.
pub fn worktree_of(input: &Value) -> Option<String> {
    input
        .get("worktreePath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The current rendered screen, read after the tail wakes on a change edge.
pub async fn screen(runner: &Runner) -> String {
    runner.read_screen().await
}

/// Subscribe to the shared PTY's change edges. A tail parks on this instead of
/// sampling: hearth publishes an edge whenever bytes reach its vt100 parser or
/// the shell's lifecycle moves, so a pane repaints on the byte rather than up to
/// an interval late, and an idle shell costs nothing.
pub fn watch(runner: &Runner) -> hearth::ScreenWatch {
    runner.watch_screen()
}

/// True once the shell has reached a terminal state (exited/error) — the tail
/// loop stops emitting output and sends the terminal `exited` event.
pub async fn is_dead(runner: &Runner) -> Option<Value> {
    let snap = runner.snapshot().await;
    match snap.session.status {
        SessionStatus::Exited | SessionStatus::Error => Some(json!(snap.session.exit_code)),
        _ => None,
    }
}

/// Wrap a terminal id or fall back to the contract's primary shell id.
pub fn terminal_id(input: &Value) -> String {
    input
        .get("terminalId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("term-1")
        .to_string()
}

/// The cwd a pane opened in, echoed back into snapshots (the shared shell's real
/// cwd lives in the screen; this is the requested pane root).
pub fn cwd_of(input: &Value, default_cwd: &str) -> String {
    input
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(default_cwd)
        .to_string()
}

/// One live pane.
pub type Terminal = Arc<Runner>;

/// The pane that IS the agent's shell. A client attaching to this id watches
/// exactly what `run_bash` types; closing it does not kill the agent's shell.
pub const AGENT_TERMINAL_ID: &str = "agent";

/// WHO owns a PTY (#149).
///
/// The registry used to key panes by `(thread_id, terminal_id)` — "the ids the
/// CLIENT chose" — which made a thread the only thing a terminal could belong
/// to. A subagent running bash in its own git worktree had no address at all,
/// so the frontend could only ever mount the parent thread's drawer and the
/// user could not attach to, watch, or cancel the child's actual shell.
///
/// This is that missing address. It is an ENUM rather than an optional
/// `session_id` field because the two cases are mutually exclusive and a pane
/// with both, or neither, is not a thing — an `Option` would push that check
/// out to every call site and it would be forgotten in one of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalOwner {
    /// A thread's own pane. Addressed exactly as it always was.
    Thread { thread_id: String },
    /// A PTY owned by an agent/fleet CHILD session, in its own worktree.
    ChildSession { session_id: String, worktree_path: Option<String> },
}

impl TerminalOwner {
    /// Read the owner out of a request.
    ///
    /// `sessionId` WINS over `threadId`. A client attaching to a child session
    /// naturally also knows the parent thread and will send both; treating the
    /// thread as authoritative there would silently hand it the parent's pane —
    /// the exact "wrong ownership boundary" #149 describes, and it would look
    /// like it worked.
    pub fn parse(input: &Value) -> TerminalOwner {
        let session = input.get("sessionId").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        match session {
            Some(session_id) => TerminalOwner::ChildSession {
                session_id: session_id.to_string(),
                worktree_path: worktree_of(input),
            },
            None => TerminalOwner::Thread {
                thread_id: input
                    .get("threadId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
        }
    }

    pub fn thread(thread_id: &str) -> TerminalOwner {
        TerminalOwner::Thread { thread_id: thread_id.to_string() }
    }

    /// The registry's namespace for this owner.
    ///
    /// PREFIXED, so a child session whose id happens to equal a thread id
    /// cannot land on that thread's pane. Both are caller-supplied strings from
    /// different id spaces, and nothing stops them colliding. This value is
    /// in-process only — it is never sent over the wire — so namespacing it
    /// costs nothing and removes the collision entirely.
    pub fn scope(&self) -> String {
        match self {
            TerminalOwner::Thread { thread_id } => format!("thread:{thread_id}"),
            TerminalOwner::ChildSession { session_id, .. } => format!("session:{session_id}"),
        }
    }

    pub fn thread_id(&self) -> Option<&str> {
        match self {
            TerminalOwner::Thread { thread_id } => Some(thread_id),
            TerminalOwner::ChildSession { .. } => None,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            TerminalOwner::Thread { .. } => None,
            TerminalOwner::ChildSession { session_id, .. } => Some(session_id),
        }
    }

    /// The identity fields for a snapshot / metadata row.
    ///
    /// A thread pane serialises EXACTLY as before — `threadId` set, `sessionId`
    /// absent — so every existing client keeps working untouched. Only a child
    /// session pane carries the new shape.
    fn wire(&self) -> (Value, Value) {
        match self {
            TerminalOwner::Thread { thread_id } => (json!(thread_id), Value::Null),
            TerminalOwner::ChildSession { session_id, .. } => (Value::Null, json!(session_id)),
        }
    }
}

/// A registered pane and the identity it was opened with.
#[derive(Clone)]
pub struct Pane {
    pub runner: Terminal,
    pub owner: TerminalOwner,
    pub terminal_id: String,
    pub cwd: String,
    pub worktree_path: Option<String>,
    /// True for the shared agent shell — never torn down by a pane close.
    pub shared: bool,
}

/// Every open pane for this environment.
///
/// A THIN ADAPTER now (codex-t3 #3). This used to be the authority: a
/// `Mutex<HashMap<(String, String), Pane>>` here owned pane identity, cwd, the
/// worktree a pane belongs to, shell creation, restart, close, and the
/// membership signal a projection waits on — all process-local, so a restart
/// forgot the panes EXISTED and the UI's drawer came back empty.
///
/// That whole concern is `agent_sdk_exec::Panes` now: durable rows, runners
/// resolved from `ExecSessions` on access, admission on every cwd, and the
/// membership `Notify` living beside the state it signals about. What is left
/// here is the product's own: the `TerminalOwner` vocabulary (translated to a
/// scope string), which terminal id means the shared agent shell, and the
/// `Pane` shape the wire handlers already speak.
pub struct TerminalRegistry {
    /// The agent's shell, always present.
    workspace: Terminal,
    workspace_cwd: String,
    panes: agent_sdk_exec::Panes,
}

impl TerminalRegistry {
    /// `sessions` is the SAME `ExecSessions` the tool shells use, so a pane and
    /// a `run_bash` shell are admitted by one boundary rather than two — panes
    /// previously had NO admission check at all and a client-supplied cwd could
    /// open a PTY anywhere on the box.
    pub async fn new(
        workspace: Terminal,
        workspace_cwd: String,
        sessions: Arc<agent_sdk_exec::ExecSessions>,
        db: Arc<dyn agent_sdk_do::ObjectDb>,
    ) -> Result<Self, String> {
        let panes = agent_sdk_exec::Panes::new(sessions, db);
        panes.migrate().await?;
        Ok(TerminalRegistry { workspace, workspace_cwd, panes })
    }

    /// The agent's own shell — what `run_bash` uses.
    pub fn workspace(&self) -> Terminal {
        self.workspace.clone()
    }

    /// Register interest in the NEXT membership change, before reading the
    /// current membership. Delegated; see `Panes::membership` for the ordering
    /// contract callers have to honour.
    pub fn membership(&self) -> tokio::sync::futures::Notified<'_> {
        self.panes.membership()
    }

    fn to_pane(&self, p: agent_sdk_exec::Pane, owner: &TerminalOwner) -> Pane {
        Pane {
            runner: p.runner,
            owner: owner.clone(),
            terminal_id: p.record.terminal_id,
            cwd: p.record.cwd.to_string_lossy().into_owned(),
            worktree_path: p.record.worktree_path,
            shared: p.record.shared,
        }
    }

    /// An already-open pane, if any.
    ///
    /// A store read error is NOT `None`. "There is no such pane" and "I could
    /// not find out" are different answers, and collapsing them is how a UI
    /// silently drops a live terminal — so the error is logged and surfaced as
    /// absent only after it has been said out loud.
    pub async fn get(&self, owner: &TerminalOwner, terminal_id: &str) -> Option<Pane> {
        match self.panes.get(&owner.scope(), terminal_id).await {
            Ok(Some(p)) => Some(self.to_pane(p, owner)),
            Ok(None) => None,
            Err(e) => {
                tracing::error!(%e, scope = %owner.scope(), terminal_id, "pane store unreadable");
                None
            }
        }
    }

    /// Open (or return) a pane.
    ///
    /// `worktree_path` wins over `cwd` when both are given: a pane opened for a
    /// worktree must land IN that worktree, or the human is typing in one tree
    /// while looking at another's diff.
    ///
    /// The agent pane is the shared workspace shell; every other pane gets its
    /// own durable session so two panes cannot fight over one cursor.
    pub async fn open(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
        cwd: Option<&str>,
        worktree_path: Option<&str>,
        env: &[(String, String)],
    ) -> Result<Pane, String> {
        let scope = owner.scope();
        let dir = worktree_path
            .filter(|p| !p.is_empty())
            .or(cwd.filter(|p| !p.is_empty()))
            .unwrap_or(&self.workspace_cwd)
            .to_string();
        let path = std::path::PathBuf::from(&dir);
        let pane = if terminal_id == AGENT_TERMINAL_ID {
            self.panes
                .attach_shared(&scope, terminal_id, &path, self.workspace.clone())
                .await?
        } else {
            self.panes
                .open(&scope, terminal_id, &path, worktree_path.filter(|p| !p.is_empty()), env)
                .await?
        };
        Ok(self.to_pane(pane, owner))
    }

    /// Wait until `(owner, terminal_id)` EXISTS, without creating it.
    ///
    /// `None` means the wait timed out and nobody ever opened it — or the store
    /// could not be read, which is logged rather than swallowed silently.
    pub async fn wait_for(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
        timeout: std::time::Duration,
    ) -> Option<Pane> {
        match self.panes.wait_for(&owner.scope(), terminal_id, timeout).await {
            Ok(Some(p)) => Some(self.to_pane(p, owner)),
            Ok(None) => None,
            Err(e) => {
                tracing::error!(%e, scope = %owner.scope(), terminal_id, "pane store unreadable while waiting");
                None
            }
        }
    }

    /// Restart a pane's shell with the cwd/env it is (re)launched with.
    ///
    /// Distinct from `open`: a restart REPLACES the environment rather than
    /// reusing whatever the last launch left behind.
    pub async fn restart(
        &self,
        owner: &TerminalOwner,
        terminal_id: &str,
        cwd: Option<&str>,
        worktree_path: Option<&str>,
        env: &[(String, String)],
    ) -> Result<Pane, String> {
        // Open first so a restart of a pane this process has never seen still
        // works — the durable row is enough.
        self.open(owner, terminal_id, cwd, worktree_path, env).await?;
        let dir = worktree_path
            .filter(|p| !p.is_empty())
            .or(cwd.filter(|p| !p.is_empty()))
            .map(std::path::PathBuf::from);
        let pane = self
            .panes
            .restart(&owner.scope(), terminal_id, dir.as_deref(), env)
            .await?;
        Ok(self.to_pane(pane, owner))
    }

    /// Close a pane.
    ///
    /// For an own-PTY pane this STOPS THE SHELL: removing it from the registry
    /// only detached the view, leaving a shell — and whatever it was running —
    /// alive with nothing attached to it and no way to reach it again. The
    /// agent's shared shell is never killed and never de-registered; a refused
    /// close changes nothing at all.
    pub async fn close(&self, owner: &TerminalOwner, terminal_id: &str) -> bool {
        match self.panes.close(&owner.scope(), terminal_id).await {
            Ok(v) => v,
            Err(e) => {
                tracing::error!(%e, scope = %owner.scope(), terminal_id, "pane close failed");
                false
            }
        }
    }

    /// Every pane open for one OWNER, oldest id first (stable for a UI list).
    ///
    /// Takes the owner, not a thread id, so a subagent's panes list
    /// independently of its parent thread's — listing by thread would either
    /// hide the child's PTYs or fold them into the parent's drawer.
    pub async fn list(&self, owner: &TerminalOwner) -> Vec<Pane> {
        let scope = owner.scope();
        let records = match self.panes.list(&scope).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(%e, %scope, "pane store unreadable while listing");
                return vec![];
            }
        };
        let mut out = Vec::with_capacity(records.len());
        for r in records {
            // A row whose shell cannot be resolved is omitted rather than
            // failing the whole drawer, and it says so — one broken pane must
            // not blank the list.
            match self.panes.get(&scope, &r.terminal_id).await {
                Ok(Some(p)) => out.push(self.to_pane(p, owner)),
                Ok(None) => {}
                Err(e) => tracing::error!(%e, %scope, terminal_id = %r.terminal_id, "pane unresolvable"),
            }
        }
        out
    }
}

#[cfg(test)]
mod wait_tests {
    use super::*;

    async fn registry() -> Arc<TerminalRegistry> {
        let dir = std::env::temp_dir().join(format!("t3term-{}", uuid::Uuid::new_v4()));
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let cfg = hearth::Config::new(dir.clone(), data.clone(), "ws");
        let runner = Arc::new(hearth::Runner::open(cfg).await.unwrap());
        let pool = do_storage::DbPool::new(data.join("exec"));
        let db = pool.object_db("exec", "main").await.unwrap();
        let sessions = Arc::new(agent_sdk_exec::ExecSessions::new(
            db.clone(),
            data.join("roots"),
            Arc::new(agent_sdk_exec::RootedAdmission::new([dir.clone()])),
        ));
        sessions.migrate().await.unwrap();
        Arc::new(
            TerminalRegistry::new(runner, dir.to_string_lossy().into(), sessions, db)
                .await
                .unwrap(),
        )
    }

    /// `wait_for` must be woken BY the open, not rescued by its own timeout.
    ///
    /// The distinction is invisible when the timeout is short and fatal when it
    /// is real: the live caller waits 300 SECONDS, so a dropped wakeup is a pane
    /// that shows nothing for five minutes and then works. Here the timeout is
    /// deliberately generous relative to the assertion — anything that has to
    /// wait it out fails the elapsed check rather than passing slowly.
    ///
    /// Repeated, because this is a race between the waiter registering interest
    /// and the opener firing: one pass proves nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn wait_for_is_woken_by_the_open_not_by_its_own_timeout() {
        const ROUNDS: usize = 300;
        const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

        let reg = registry().await;
        let mut worst = std::time::Duration::ZERO;
        for i in 0..ROUNDS {
            let round_start = std::time::Instant::now();
            let (thread_id, term) = (format!("t{i}"), AGENT_TERMINAL_ID.to_string());

            let waiter = {
                let (reg, t, k) = (reg.clone(), thread_id.clone(), term.clone());
                tokio::spawn(async move { reg.wait_for(&TerminalOwner::thread(&t), &k, TIMEOUT).await })
            };

            // Hand the waiter a moment to reach its check, so the open lands in
            // the window between that check and the wait — the only interleaving
            // that can drop an edge.
            tokio::task::yield_now().await;

            reg.open(&TerminalOwner::thread(&thread_id), &term, None, None, &[]).await.expect("open");
            assert!(waiter.await.unwrap().is_some(), "round {i}: the waiter saw the pane");
            worst = worst.max(round_start.elapsed());
        }

        // Assert the THING, not a proxy for it. This used to check total elapsed
        // against one round's timeout, which worked only while an open was
        // effectively free. Pane opens are durable now — the row is written and
        // read back through `agent_sdk_exec::Panes` — so 300 of them legitimately
        // cost seconds in aggregate, and the old total-time check started failing
        // under parallel suite load while every individual round was woken
        // instantly. That is the proxy breaking, not the wakeup.
        //
        // A dropped wakeup has one signature and it is per-round: that round
        // waits out the full TIMEOUT. Measuring the worst ROUND catches it
        // exactly, and is strictly sharper than the old sum — a single 2s round
        // hidden inside a fast total used to pass and now cannot.
        assert!(
            worst < TIMEOUT,
            "the slowest round took {worst:?} against a {TIMEOUT:?} timeout: a round that \
             reaches its deadline means an open's wakeup was dropped and only the timeout \
             saved it"
        );
    }

    /// Two concurrent opens of the SAME pane id must yield ONE shell.
    ///
    /// `open` checks the registry, releases the lock, and only then spawns a
    /// PTY — and spawning is slow. Two opens racing (which is the normal path:
    /// `terminal.attach` and `terminal.open` arrive together, which is the whole
    /// reason `wait_for` exists) can both miss the check, both spawn a shell,
    /// and the second insert silently replaces the first.
    ///
    /// The replaced shell is then unreachable AND alive: not in the registry, so
    /// `close` can never shut it down (#210), still holding its PTY and whatever
    /// was running in it. A client that attached to it tails a terminal nobody
    /// can ever reach again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_opens_of_one_pane_id_share_a_single_shell() {
        let reg = registry().await;

        let racers: Vec<_> = (0..4)
            .map(|_| {
                let reg = reg.clone();
                tokio::spawn(async move { reg.open(&TerminalOwner::thread("t-race"), "term-1", None, None, &[]).await })
            })
            .collect();

        let mut panes = Vec::new();
        for r in racers {
            panes.push(r.await.unwrap().expect("open succeeded"));
        }

        // The registry can only ever hold one of them, so every caller must have
        // been handed THAT one — any other Arc is a shell the registry has lost.
        let registered = reg.get(&TerminalOwner::thread("t-race"), "term-1").await.expect("pane registered");
        for (i, p) in panes.iter().enumerate() {
            assert!(
                Arc::ptr_eq(&p.runner, &registered.runner),
                "opener {i} was handed a shell the registry does not hold — it is orphaned"
            );
        }
    }

    /// Closing the AGENT pane must not de-register it.
    ///
    /// `close` deliberately refuses to kill the shared shell — ending the
    /// agent's work because a human shut a view would be the wrong trade. But it
    /// removes the entry first and only then decides, so the shell survives
    /// while the registry forgets it: `list` stops returning the agent terminal
    /// and `get` reports it missing, even though `run_bash` is still typing into
    /// it. The UI drops the row for a terminal that is very much alive — the
    /// lying-label failure, not a leak.
    #[tokio::test]
    async fn closing_the_agent_pane_leaves_it_registered_and_listed() {
        let reg = registry().await;
        let opened = reg
            .open(&TerminalOwner::thread("t-agent"), AGENT_TERMINAL_ID, None, None, &[])
            .await
            .expect("agent pane opens");

        assert!(!reg.close(&TerminalOwner::thread("t-agent"), AGENT_TERMINAL_ID).await, "the shared shell is not killed");

        let still = reg
            .get(&TerminalOwner::thread("t-agent"), AGENT_TERMINAL_ID)
            .await
            .expect("the agent pane is still registered after a refused close");
        assert!(
            Arc::ptr_eq(&still.runner, &opened.runner),
            "and it is the same shell, not a re-created one"
        );
        assert!(
            reg.list(&TerminalOwner::thread("t-agent")).await.iter().any(|p| p.terminal_id == AGENT_TERMINAL_ID),
            "the UI still sees a row for the terminal the agent is working in"
        );
    }

    /// A pane launched with env is still a USABLE shell.
    ///
    /// hearth's `relaunch` deliberately keeps nothing from the previous
    /// *session* environment — that is what makes "open a fresh terminal here"
    /// honest in the substrate — and the adapter hands it only the two or three
    /// variables the client asked for. What keeps that from producing a shell
    /// with no PATH is that the spawned command still inherits the SERVER
    /// process's environment; the requested vars are layered on top.
    ///
    /// That inheritance is load-bearing and easy to remove by accident (an
    /// `env_clear()`, or a hearth that starts composing a clean env), and the
    /// failure is total: a pane where nothing the user types can be found.
    #[tokio::test]
    async fn a_pane_launched_with_env_still_has_a_usable_environment() {
        let reg = registry().await;
        let pane = reg
            .open(&TerminalOwner::thread("t-env"), "pane-env", None, None, &[("FOO".into(), "bar".into())])
            .await
            .expect("pane opens");

        let out = pane
            .runner
            .run("printf 'FOO=[%s] PATH=[%s]\\n' \"$FOO\" \"$PATH\"", false, Some(20), false)
            .await;

        assert!(out.output.contains("FOO=[bar]"), "the requested var is set: {:?}", out.output);
        assert!(
            !out.output.contains("PATH=[]"),
            "and it did not cost the shell its PATH — a pane with no PATH cannot run \
             anything the user types: {:?}",
            out.output
        );
    }
}
