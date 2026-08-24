//! The coding tool set: hearth's durable PTY shell and file tools, adapted
//! from their domain libraries into agent-sdk `Action`s. This is the product
//! wiring the substrate deliberately does NOT contain — a coding node hands
//! these to its agent (and any subagent it spawns) so it can do real work.

use std::path::PathBuf;
use std::sync::Arc;

use cairn::{Discovery, Stack};
use do_storage::DbPool;

use agent_sdk_core::{Action, ActionDesc, Ctx, EffectClass, Registry, StepType};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Discover the cairn checkpoint stack over `root` FAIL-CLOSED. A mutating tool
/// must not treat "git could not answer" the same as "there is no repo here":
/// the first means the checkpoint substrate is unavailable and the write must be
/// refused (no undoable history behind it), the second is an ordinary
/// un-versioned directory that may take the plain confined write. `Stack::open`
/// collapses those two into `None`; `Stack::discover` keeps them apart, which is
/// exactly the safety property the file tools need (#40).
pub async fn discover_stack(pool: &Arc<DbPool>, root: &std::path::Path) -> Discovery<Stack> {
    Stack::discover(pool, "t3code-files", root, cairn::Config::default()).await
}

/// The PTY a tool set is allowed to type into.
///
/// Two variants, and the distinction is deliberate:
///
/// * `Open` — a runner already in hand (the boot workspace, tests).
/// * `Deferred` — an SDK [`LazyShell`]: the durable session id + its root, with
///   the OPEN happening at call time inside `agent-sdk-exec`.
///
/// There used to be a third, `Missing { root }`, and it was the defect. The
/// registry factory is synchronous, so the product pre-opened runners into its
/// own `HashMap` and the factory looked them up; a root the product had not
/// pre-opened produced `Missing`, and every shell tool refused. That made a
/// process-local cache the AUTHORITY for whether a shell exists — so after a
/// restart, or on a resumed SDK path that builds a registry before the product
/// calls `ensure`, the durable `exec_session` row was right there and `run_bash`
/// refused anyway.
///
/// `Deferred` keeps what `Missing` was protecting (the #207 rule: a worktree
/// thread must never silently inherit the boot workspace runner — the root
/// travels with the handle and admission is re-checked on every resolve) while
/// removing the part that was wrong (the cache deciding existence).
#[derive(Clone)]
pub enum Shell {
    Open(Arc<hearth::Runner>),
    Deferred(agent_sdk_exec::LazyShell),
}

impl Shell {
    /// Resolve to a live runner, opening the durable session if needed.
    ///
    /// Async on purpose: making this the awaited call is what moves the "does a
    /// shell exist" question off a synchronously-built map and onto the store.
    async fn get(&self) -> agent_sdk_core::Result<Arc<hearth::Runner>> {
        match self {
            Shell::Open(r) => Ok(r.clone()),
            Shell::Deferred(lazy) => lazy.runner().await.map_err(|e| {
                agent_sdk_core::Error::action(format!(
                    "no shell for this thread's work root: {e}. Running in the workspace shell \
                     instead would execute in a different checkout than the one this thread edits"
                ))
            }),
        }
    }
}

// ── run_bash (hearth durable PTY) ────────────────────────────────────────────

/// Open the workspace's ONE Hearth runner: a persistent PTY plus the durable
/// background-job lane, over a do-rs isolate keyed by the workspace root.
///
/// The shell is a long-lived resource, not a per-call one. A fresh
/// `Session` per tool call throws away everything a PTY exists for — `cd`,
/// exported env, an activated venv, a running REPL, the foreground-only
/// interrupt, and the screen a human can look at — and hands the model a
/// clean-room shell that contradicts what it just did. Opening the runner
/// here, once, is also what makes the PTY joinable: the same session id is
/// what a frontend attaches to.
pub async fn open_workspace_shell(
    root: &std::path::Path,
    state_dir: PathBuf,
) -> Result<Arc<hearth::Runner>, String> {
    // stable across restarts: the same workspace re-opens the same isolate.
    let workspace_id = workspace_id(root);
    let cfg = hearth::Config::new(root.to_path_buf(), state_dir, workspace_id)
        .guard([".t3code-agent".to_string()]);
    hearth::Runner::open(cfg).await.map(Arc::new).map_err(|e| e.to_string())
}

/// The durable identity of a workspace's shell — stable across restarts, safe
/// as a filename, and the handle a client uses to attach to the PTY.
pub fn workspace_id(root: &std::path::Path) -> String {
    let s = root.to_string_lossy();
    let slug: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    // keep it bounded, keep it unique: tail of the path + a hash of the whole
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let tail: String = slug.chars().rev().take(48).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{tail}-{h:016x}")
}

#[derive(Deserialize, JsonSchema)]
pub struct BashIn {
    pub command: String,
    #[serde(default)]
    pub timeout_s: Option<u64>,
    /// Run detached in the durable job lane (survives restart) instead of in
    /// the foreground PTY.
    #[serde(default)]
    pub background: bool,
}
#[derive(Serialize, JsonSchema)]
pub struct BashOut {
    pub output: String,
    pub exit_code: i32,
    pub interrupted: bool,
    /// Set when `background` was requested: poll it with `read_job`.
    pub job_id: Option<String>,
    /// Lines hearth elided from the middle of the output — stated, never silent.
    pub hidden_lines: usize,
    /// The PTY this ran in. A client attaches to this id to watch the same
    /// screen the agent is typing into.
    pub session_id: String,
}

pub struct RunBash { runner: Shell, session_id: String, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for RunBash {
    type In = BashIn; type Out = BashOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: BashIn) -> agent_sdk_core::Result<BashOut> {
        // ONE persistent PTY for the workspace: `cd`/env/venv carry across calls.
        let r = self.runner.get().await?.run(&i.command, i.background, i.timeout_s, false).await;
        Ok(BashOut {
            output: r.output,
            exit_code: r.exit_code,
            interrupted: r.interrupted,
            job_id: r.job_id,
            hidden_lines: r.hidden_lines,
            session_id: self.session_id.clone(),
        })
    }
}

// ── read_screen (the PTY is inspectable, by the agent and by a human) ────────

#[derive(Deserialize, JsonSchema)]
pub struct ScreenIn {}
#[derive(Serialize, JsonSchema)]
pub struct ScreenOut {
    pub screen: String,
    pub session_id: String,
    /// The directory the PTY was OPENED in. Deliberately not called `cwd`: the
    /// live working directory lives in the shell, and a `cd` moves it without
    /// touching this. Read the screen for where the session actually is.
    pub workdir: String,
    /// `running` / `not_started` / `exited` / `error` — PTY liveness is
    /// visible, not silently empty.
    pub status: String,
    /// The shell's exit code, once it has exited. Without this a dead PTY is
    /// just a blank pane: the agent (and the human watching) cannot tell a
    /// clean `exit` from a crash, or read the code a script died on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Why the session is in `error` (it could not start, or died abnormally).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct ReadScreen { runner: Shell, session_id: String, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for ReadScreen {
    type In = ScreenIn; type Out = ScreenOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, _i: ScreenIn) -> agent_sdk_core::Result<ScreenOut> {
        let snap = self.runner.get().await?.snapshot().await;
        Ok(ScreenOut {
            // The screen comes from the SAME snapshot as the status: a second
            // read would respawn a dead shell and hand back an empty screen,
            // erasing the very output that explains the death.
            screen: snap.session.screen.clone(),
            session_id: self.session_id.clone(),
            workdir: snap.session.workdir.clone(),
            // Hearth owns the lifecycle fact; this only names it for the
            // contract. `exited`/`error` are distinct from `not_started` —
            // "your shell died" and "no shell yet" are different things to show.
            status: match snap.session.status {
                hearth::session::SessionStatus::Running => "running",
                hearth::session::SessionStatus::NotStarted => "not_started",
                hearth::session::SessionStatus::Exited => "exited",
                hearth::session::SessionStatus::Error => "error",
            }
            .to_string(),
            // Carried through, not re-derived: Hearth is the only layer that
            // saw the shell die.
            exit_code: snap.session.exit_code,
            error: snap.session.error.clone(),
        })
    }
}

// ── send_keys / interrupt (the interactive lane: vim, psql, a REPL) ──────────

#[derive(Deserialize, JsonSchema)]
pub struct KeysIn { pub keys: String }
#[derive(Serialize, JsonSchema)]
pub struct KeysOut { pub result: String, pub screen: String }

pub struct SendKeys { runner: Shell, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for SendKeys {
    type In = KeysIn; type Out = KeysOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: KeysIn) -> agent_sdk_core::Result<KeysOut> {
        let runner = self.runner.get().await?;
        let result = runner.send_keys(&i.keys).await;
        Ok(KeysOut { result, screen: runner.read_screen().await })
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct InterruptIn {}
#[derive(Serialize, JsonSchema)]
pub struct InterruptOut { pub result: String }

pub struct InterruptShell { runner: Shell, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for InterruptShell {
    type In = InterruptIn; type Out = InterruptOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, _i: InterruptIn) -> agent_sdk_core::Result<InterruptOut> {
        // foreground only — never the harness's own process (that is the whole
        // point of hearth owning the process group).
        Ok(InterruptOut { result: self.runner.get().await?.interrupt().await })
    }
}

// ── read_job (the durable background lane) ───────────────────────────────────

#[derive(Deserialize, JsonSchema)]
pub struct JobIn { pub job: String, #[serde(default)] pub grep: Option<String> }
#[derive(Serialize, JsonSchema)]
pub struct JobOut { pub output: String, pub exit_code: i32, pub hidden_lines: usize }

pub struct ReadJob { runner: Shell, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for ReadJob {
    type In = JobIn; type Out = JobOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: JobIn) -> agent_sdk_core::Result<JobOut> {
        let r = self.runner.get().await?.read_job(&i.job, i.grep.as_deref()).await;
        Ok(JobOut { output: r.output, exit_code: r.exit_code, hidden_lines: r.hidden_lines })
    }
}

// ── file tools ───────────────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
pub struct ReadIn { pub path: String }
#[derive(Serialize, JsonSchema)]
pub struct ReadOut { pub content: String }
pub struct ReadFile { root: PathBuf, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for ReadFile {
    type In = ReadIn; type Out = ReadOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: ReadIn) -> agent_sdk_core::Result<ReadOut> {
        let content = cairn::read_file(&self.root, &i.path).map_err(agent_sdk_core::Error::action)?;
        Ok(ReadOut { content })
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct WriteIn { pub path: String, pub content: String }
#[derive(Serialize, JsonSchema)]
pub struct WriteOut { pub bytes: u64 }
pub struct WriteFile { root: PathBuf, pool: Arc<DbPool>, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for WriteFile {
    type In = WriteIn; type Out = WriteOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: WriteIn) -> agent_sdk_core::Result<WriteOut> {
        let bytes = i.content.len() as u64;
        match discover_stack(&self.pool, &self.root).await {
            // git-backed: cairn writes the file AND checkpoints it (a commit).
            Discovery::Repo(stack) => { cairn::write_file(&stack, &i.path, &i.content).await.map_err(agent_sdk_core::Error::action)?; }
            // not a repo: no checkpoint to take, but the SAME confined,
            // all-or-nothing write cairn uses — the tool is only idempotent if
            // a retry can never find a half-written file.
            Discovery::NotRepository => cairn::write_file_atomic(&self.root, &i.path, &i.content)
                .map_err(agent_sdk_core::Error::action)?,
            // git could not answer inside what may be a real repo: FAIL CLOSED.
            // A write here would land with no checkpoint behind it while the UI
            // believes edits are cairn-backed — refuse it, don't downgrade (#40).
            Discovery::Unavailable(why) => return Err(agent_sdk_core::Error::action(
                format!("cairn checkpoint substrate unavailable ({why}); refusing unversioned write to {}", i.path))),
        }
        Ok(WriteOut { bytes })
    }
}

#[derive(Deserialize, JsonSchema)]
pub struct EditIn { pub path: String, pub old: String, pub new: String }
#[derive(Serialize, JsonSchema)]
pub struct EditOut { pub replaced: bool }
pub struct EditFile { root: PathBuf, pool: Arc<DbPool>, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for EditFile {
    type In = EditIn; type Out = EditOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: EditIn) -> agent_sdk_core::Result<EditOut> {
        match discover_stack(&self.pool, &self.root).await {
            Discovery::Repo(stack) => { cairn::edit_file(&stack, &i.path, &i.old, &i.new).await.map_err(agent_sdk_core::Error::action)?; }
            Discovery::NotRepository => cairn::edit_file_atomic(&self.root, &i.path, &i.old, &i.new)
                .map_err(agent_sdk_core::Error::action)?,
            // fail closed when the checkpoint substrate can't answer (#40).
            Discovery::Unavailable(why) => return Err(agent_sdk_core::Error::action(
                format!("cairn checkpoint substrate unavailable ({why}); refusing unversioned edit to {}", i.path))),
        }
        Ok(EditOut { replaced: true })
    }
}

// ── grep_files (content search over the workspace) ───────────────────────────

#[derive(Deserialize, JsonSchema)]
pub struct GrepIn { pub needle: String, #[serde(default)] pub max: Option<usize> }
#[derive(Serialize, JsonSchema)]
pub struct GrepHit { pub path: String, pub line: usize, pub text: String }
#[derive(Serialize, JsonSchema)]
pub struct GrepOut { pub matches: Vec<GrepHit> }
pub struct GrepFiles { root: PathBuf, desc: ActionDesc }
#[async_trait::async_trait]
impl Action for GrepFiles {
    type In = GrepIn; type Out = GrepOut;
    fn desc(&self) -> &ActionDesc { &self.desc }
    async fn call(&self, _c: &dyn Ctx, i: GrepIn) -> agent_sdk_core::Result<GrepOut> {
        let hits = cairn::grep(&self.root, &i.needle, i.max.unwrap_or(200))
            .map_err(agent_sdk_core::Error::action)?;
        Ok(GrepOut { matches: hits.into_iter().map(|m| GrepHit { path: m.path, line: m.line, text: m.text }).collect() })
    }
}

/// The registry factory `Shell::new` takes, with the workspace's PTY opened
/// ONCE and shared by every session it builds. This is the whole wiring point:
/// a caller that builds tools per session still gets one shell.
pub async fn coding_registry(
    root: PathBuf,
    agent_data: PathBuf,
) -> Result<impl Fn(&agent_sdk_shell::AgentDefinition) -> Registry + Send + Sync + Clone + 'static, String>
{
    let runner = open_workspace_shell(&root, agent_data.clone()).await?;
    Ok(coding_registry_with_runner(root, agent_data, runner).await)
}

/// Build the coding registry over an ALREADY-OPEN workspace `Runner`, so the
/// backend can hand the SAME PTY to both the agent's `run_bash` and the
/// human-facing terminal RPCs — one shell, one screen, no split PTYs (#33).
pub async fn coding_registry_with_runner(
    root: PathBuf,
    agent_data: PathBuf,
    runner: Arc<hearth::Runner>,
) -> impl Fn(&agent_sdk_shell::AgentDefinition) -> Registry + Send + Sync + Clone + 'static {
    ToolRoots::new(root, agent_data, runner).await.registry_factory()
}

/// Every work root this environment can hand an agent, and the ONE Hearth
/// runner each of them gets.
///
/// A thread running in a git worktree must read, write AND shell out inside
/// that worktree. Re-rooting only the file tools is half the fix: `RunBash`
/// forwards its command to whatever runner it was handed, with no `cd` of its
/// own, so a worktree thread sharing the boot PTY types into the main checkout
/// — and because `coding_tools` derives the reported `session_id` from the
/// re-rooted path, it hands back an id for a shell that did not run the
/// command. A client attaching to it watches the wrong terminal.
///
/// So the runner is keyed by work root, exactly like the file tools: one
/// durable PTY per worktree, its own `cd`/env, its own attachable id.
/// One directory, one identity. A path reaches this module spelled several ways
/// — the boot root as the user typed it, a worktree path canonicalized by the
/// VCS layer, `/var` vs `/private/var` on macOS — and keying the runner map by
/// the raw string would mint a SECOND shell for a directory that already has
/// one, splitting `cd`/env between two PTYs for the same worktree.
fn norm(p: &std::path::Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

#[derive(Clone)]
pub struct ToolRoots {
    boot_root: PathBuf,
    agent_data: PathBuf,
    boot_runner: Arc<hearth::Runner>,
    /// The SDK's durable shell registry (#261).
    ///
    /// This used to be a product-local `HashMap<workspace_id, Runner>`: shells
    /// with no durable identity, no admitted-cwd check, and no existence
    /// outside this process — a second, weaker copy of a substrate concern
    /// living in product code. `ExecSessions` is the same seam done once, in
    /// `agent-sdk-exec`, where the ACP/CLI/stdio paths can reach it too.
    ///
    /// There is NO product runner map beside it any more (#4). `ExecSessions`
    /// already keeps the live-runner cache next to the durable row it belongs
    /// to; a second copy here was a cache that had quietly become the authority
    /// for whether a shell exists at all.
    sessions: Arc<agent_sdk_exec::ExecSessions>,
    /// The isolate `sessions` (and now the pane registry) write into. Held so a
    /// host can build a second SDK registry on the SAME store rather than
    /// opening a second one that would disagree with it.
    session_db: Arc<dyn agent_sdk_do::ObjectDb>,
}

impl ToolRoots {
    /// Build the roots over `agent_data`, admitting the boot workspace and the
    /// environment's worktree area — the same boundary `vcs` enforces when it
    /// CREATES a worktree. A shell may only be rooted where a worktree may
    /// legally exist; otherwise a thread carrying an arbitrary `cwd` would open
    /// a shell anywhere on the box.
    pub async fn new(
        boot_root: PathBuf,
        agent_data: PathBuf,
        boot_runner: Arc<hearth::Runner>,
    ) -> Self {
        let boot_root = norm(&boot_root);
        let worktrees = crate::vcs::worktree_base(&boot_root.to_string_lossy());
        // The worktree area is created lazily by `vcs`; admission canonicalizes,
        // so the root has to exist for it to be admitted at all.
        let _ = std::fs::create_dir_all(&worktrees);
        // ONE product-state isolate, not one per store (#13, product half).
        // Every extra isolate is 5 descriptors (do-storage's own `fd_budget`
        // measurement), and an `AppState` was opening seven — 35 descriptors
        // before a single PTY. `exec_session`/`exec_pane` and the diagnostics
        // history are separate TABLE SETS, not separate durability domains, and
        // nothing ever needed them in different files.
        let db = product_state_db(&agent_data).await;
        let sessions = Arc::new(agent_sdk_exec::ExecSessions::new(
            db.clone(),
            agent_data.join("roots"),
            Arc::new(agent_sdk_exec::RootedAdmission::new([
                boot_root.clone(),
                worktrees,
            ])),
        ));
        sessions.migrate().await.expect("exec_session schema");
        let session_db = db;

        Self { boot_root, agent_data, boot_runner, sessions, session_db }
    }

    /// The durable shell registry, for hosts that need the SAME admission
    /// boundary for something other than tool shells — the terminal panes use
    /// it so a pane and a `run_bash` shell cannot be admitted by two different
    /// rules (codex-t3 #3).
    pub fn sessions(&self) -> Arc<agent_sdk_exec::ExecSessions> {
        self.sessions.clone()
    }

    /// The isolate the session/pane rows live in.
    pub fn session_db(&self) -> Arc<dyn agent_sdk_do::ObjectDb> {
        self.session_db.clone()
    }

    /// Open (or reuse) the durable shell for `root`.
    ///
    /// Called from the async turn path BEFORE the registry is built, because
    /// the factory cannot await. Reusing is the point: the same worktree must
    /// resolve to the same shell across turns, or `cd` and env stop carrying.
    ///
    /// The root is ADMITTED by the SDK session registry before any PTY exists,
    /// so a thread pointed at a path outside this environment fails here rather
    /// than getting a working shell somewhere it should not have one.
    pub async fn ensure(&self, root: &std::path::Path) -> Result<Arc<hearth::Runner>, String> {
        let root = &norm(root);
        // The BOOT workspace already has its shell — the one `open_workspace_shell`
        // opened and the one the terminal RPCs are attached to. Opening a durable
        // exec session for it as well gave the boot root TWO hearth isolates and
        // TWO PTYs for one workspace: `run_bash` typing into one while the human
        // watched the other, which is exactly what #33 says must never happen.
        // It also cost a whole extra isolate (5 descriptors) per AppState for
        // nothing. The boot runner IS this root's shell; hand it back.
        if root == &self.boot_root {
            return Ok(self.boot_runner.clone());
        }
        // Straight through to the SDK. `ExecSessions::open` is idempotent and
        // holds the live-runner map itself, so re-opening an id returns the SAME
        // PTY — the "keep whichever landed first" dance this used to do around a
        // second map is a property of the seam now, not of this function.
        //
        // `ensure` is no longer REQUIRED before a turn: the registry resolves
        // lazily. It stays because failing admission early, on the turn path
        // where the error can be reported against the thread, beats failing at
        // the model's first `run_bash`.
        Ok(self.sessions.open(&workspace_id(root), root).await?.runner())
    }

    /// Per-root state, so two worktrees never share a PTY isolate.
    fn state_dir(&self, root: &std::path::Path) -> PathBuf {
        self.agent_data.join("roots").join(workspace_id(root))
    }

    /// The boot workspace keeps the checkpoint path it has always used, so
    /// history recorded before this change stays addressable; a worktree gets
    /// its own, beside its shell.
    fn checkpoints(&self, root: &std::path::Path) -> PathBuf {
        if root == self.boot_root {
            self.agent_data.join("checkpoints")
        } else {
            self.state_dir(root).join("checkpoints")
        }
    }

    pub fn registry_factory(
        &self,
    ) -> impl Fn(&agent_sdk_shell::AgentDefinition) -> Registry + Send + Sync + Clone + 'static {
        let this = self.clone();
        move |def: &agent_sdk_shell::AgentDefinition| {
            // The definition carries the directory (durable, per session), so
            // the registry is built over it rather than over the boot root —
            // what made a worktree thread quietly edit the main checkout while
            // the UI showed the worktree (#207).
            let root = match def.cwd.as_deref().filter(|s| !s.is_empty()) {
                Some(dir) => norm(std::path::Path::new(dir)),
                None => this.boot_root.clone(),
            };
            // A root nobody opened still does NOT inherit the workspace shell —
            // that fallback is the #207 bug: the file tools and the reported
            // session id would name this root while commands ran in the boot
            // checkout. What changed (#4) is WHERE the answer comes from. The
            // handle carries this root's own session id and root, and the SDK
            // opens or re-attaches the durable session at call time. So a
            // restart, or a resumed path that builds this registry before any
            // product code called `ensure`, gets the shell the durable row says
            // exists instead of a refusal from a cold process map. Admission is
            // re-checked inside `ExecSessions` on every resolve, so a root that
            // is not legal still fails — loudly, at the command.
            // Same rule as `ensure`: the boot workspace's shell is the runner the
            // host already opened and the terminal RPCs are attached to, not a
            // second durable session over the same root.
            if root == this.boot_root {
                return coding_tools_with_shell(
                    root.clone(),
                    this.checkpoints(&root),
                    Shell::Open(this.boot_runner.clone()),
                );
            }
            let runner = Shell::Deferred(agent_sdk_exec::LazyShell::new(
                this.sessions.clone(),
                workspace_id(&root),
                root.clone(),
            ));
            coding_tools_with_shell(root.clone(), this.checkpoints(&root), runner)
        }
    }
}

/// The coding registry over one workspace root: the shell tools over a SHARED
/// Hearth PTY + read/write/edit/grep. Writes and edits go through cairn, so
/// each one is a git checkpoint on disk (pushable to a remote when
/// configured); `checkpoint_data` roots the cairn checkpoint store.
///
/// `runner` is opened ONCE per workspace by [`open_workspace_shell`] and shared
/// by every session and subagent — that shared handle is what makes `cd` stick
/// and what a client attaches to.
pub fn coding_tools(root: PathBuf, checkpoint_data: PathBuf, runner: Arc<hearth::Runner>) -> Registry {
    coding_tools_with_shell(root, checkpoint_data, Shell::Open(runner))
}

/// [`coding_tools`] over a shell that may not exist yet — see [`Shell`].
/// The ONE isolate the product's own durable state lives in.
///
/// Shared by `ExecSessions` (`exec_session`, `exec_pane`) and the diagnostics
/// history. Process-wide and keyed by the agent-data directory, so two
/// `AppState`s over one directory — a backend and its own tests, or two
/// components of the same boot — get the same handle rather than two isolates
/// over two files.
pub async fn product_state_db(agent_data: &std::path::Path) -> Arc<dyn agent_sdk_do::ObjectDb> {
    use std::sync::Weak;
    use tokio::sync::Mutex as AsyncMutex;
    // WEAK, not strong. A strong map here is a descriptor leak with a lookup
    // table in front of it: every distinct agent-data directory would be held
    // open for the life of the PROCESS, so a host (or a test binary) that walks
    // through many directories accumulates isolates it can never release. Weak
    // gives the sharing — same directory, same isolate — without the map being
    // the reason anything stays alive.
    static DBS: std::sync::OnceLock<
        AsyncMutex<std::collections::HashMap<PathBuf, Weak<dyn agent_sdk_do::ObjectDb>>>,
    > = std::sync::OnceLock::new();
    let dir = agent_data.to_path_buf();
    let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let mut dbs = DBS
        .get_or_init(|| AsyncMutex::new(std::collections::HashMap::new()))
        .lock()
        .await;
    if let Some(db) = dbs.get(&key).and_then(Weak::upgrade) {
        return db;
    }
    let pool = checkpoint_pool(dir.join("state"));
    let db = pool
        .object_db("state", "main")
        .await
        .expect("open the product-state isolate");
    dbs.insert(key, Arc::downgrade(&db));
    // Drop tombstones of entries nobody holds. On insert rather than on a
    // timer: the map only grows when a NEW directory is opened, so that is the
    // only moment it can need trimming.
    dbs.retain(|_, w| w.strong_count() > 0);
    db
}

/// ONE checkpoint pool per checkpoint directory, for the whole process.
///
/// `DbPool::new` mints a pool with its OWN isolate cache, so calling it per
/// registry build reopened the same checkpoint files every time. The registry is
/// built on every turn, every subagent, and every resumed path — so descriptors
/// grew with TURN COUNT rather than with workspace count. On a box with a large
/// `ulimit -n` that is invisible indefinitely; under a 256-fd budget it is most
/// of the backend contract suite failing with `storage: I/O error (open)`.
///
/// Keyed by the CANONICALIZED path: `./x` and `/abs/x` are one directory, and
/// handing them two pools would put two isolate caches over one set of files —
/// which is the bug with extra steps.
pub fn checkpoint_pool(dir: PathBuf) -> Arc<DbPool> {
    use std::sync::{Mutex, OnceLock, Weak};
    // WEAK for the same reason as `product_state_db`: sharing, not ownership. A
    // strong map would keep every checkpoint pool this process ever touched
    // resident forever, which converts a fix for descriptor growth into a
    // different, quieter source of it.
    static POOLS: OnceLock<Mutex<std::collections::HashMap<PathBuf, Weak<DbPool>>>> =
        OnceLock::new();
    // `canonicalize` needs the directory to exist; a checkpoint dir is created
    // lazily by cairn, so fall back to the path as given rather than refusing.
    // Worst case that is the previous behaviour for one directory, not for all.
    let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let mut pools = POOLS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(pool) = pools.get(&key).and_then(Weak::upgrade) {
        return pool;
    }
    let pool = DbPool::new(dir);
    pools.insert(key, Arc::downgrade(&pool));
    pools.retain(|_, w| w.strong_count() > 0);
    pool
}

pub fn coding_tools_with_shell(root: PathBuf, checkpoint_data: PathBuf, runner: Shell) -> Registry {
    let pool = checkpoint_pool(checkpoint_data);
    let sid = workspace_id(&root);
    let mut reg = Registry::new();
    reg.register(Arc::new(RunBash { runner: runner.clone(), session_id: sid.clone(), desc: ActionDesc::new::<BashIn, BashOut>(StepType::Tool, "run_bash").with_effect_class(EffectClass::KeylessBilled) }));
    reg.register(Arc::new(ReadScreen { runner: runner.clone(), session_id: sid, desc: ActionDesc::new::<ScreenIn, ScreenOut>(StepType::Tool, "read_screen").with_effect_class(EffectClass::Pure) }));
    reg.register(Arc::new(SendKeys { runner: runner.clone(), desc: ActionDesc::new::<KeysIn, KeysOut>(StepType::Tool, "send_keys").with_effect_class(EffectClass::KeylessBilled) }));
    reg.register(Arc::new(InterruptShell { runner: runner.clone(), desc: ActionDesc::new::<InterruptIn, InterruptOut>(StepType::Tool, "interrupt_shell").with_effect_class(EffectClass::KeylessBilled) }));
    reg.register(Arc::new(ReadJob { runner, desc: ActionDesc::new::<JobIn, JobOut>(StepType::Tool, "read_job").with_effect_class(EffectClass::Pure) }));
    reg.register(Arc::new(ReadFile { root: root.clone(), desc: ActionDesc::new::<ReadIn, ReadOut>(StepType::Tool, "read_file").with_effect_class(EffectClass::Pure) }));
    reg.register(Arc::new(GrepFiles { root: root.clone(), desc: ActionDesc::new::<GrepIn, GrepOut>(StepType::Tool, "grep_files").with_effect_class(EffectClass::Pure) }));
    reg.register(Arc::new(WriteFile { root: root.clone(), pool: pool.clone(), desc: ActionDesc::new::<WriteIn, WriteOut>(StepType::Tool, "write_file").with_effect_class(EffectClass::Idempotent) }));
    reg.register(Arc::new(EditFile { root, pool, desc: ActionDesc::new::<EditIn, EditOut>(StepType::Tool, "edit_file").with_effect_class(EffectClass::Idempotent) }));
    reg
}

#[cfg(test)]
mod fail_closed_tests {
    //! #40: a mutating file tool must FAIL CLOSED when cairn cannot tell whether
    //! it is in a repository — never downgrade to an unversioned write behind a
    //! UI that believes edits are checkpointed.
    use super::*;
    use agent_sdk_core::Ctx;

    struct TestCtx;
    impl Ctx for TestCtx {}

    /// A directory whose `.git` git cannot read → `Discovery::Unavailable`.
    fn broken_repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t3-failclosed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // a `.git` entry that exists but points nowhere git can resolve: git
        // reports "not a repository", but the `.git` above proves one is meant to
        // be here — cairn's discover returns Unavailable, not NotRepository.
        std::fs::write(dir.join(".git"), "gitdir: /nonexistent-broken-cairn-target\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn write_file_fails_closed_and_leaves_the_file_unchanged() {
        let dir = broken_repo();
        let pool = DbPool::new(dir.join(".checkpoints"));
        let wf = WriteFile { root: dir.clone(), pool,
            desc: ActionDesc::new::<WriteIn, WriteOut>(StepType::Tool, "write_file") };
        let res = wf.call(&TestCtx, WriteIn { path: "hello.txt".into(), content: "hi".into() }).await;
        assert!(res.is_err(), "write must be refused when the checkpoint substrate is unavailable");
        assert!(!dir.join("hello.txt").exists(), "the worktree must be untouched by a refused write");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn edit_file_fails_closed_and_leaves_the_file_unchanged() {
        let dir = broken_repo();
        // a pre-existing file the edit would have mutated
        std::fs::write(dir.join("a.txt"), "before").unwrap();
        let pool = DbPool::new(dir.join(".checkpoints"));
        let ef = EditFile { root: dir.clone(), pool,
            desc: ActionDesc::new::<EditIn, EditOut>(StepType::Tool, "edit_file") };
        let res = ef.call(&TestCtx, EditIn { path: "a.txt".into(), old: "before".into(), new: "after".into() }).await;
        assert!(res.is_err(), "edit must be refused when the checkpoint substrate is unavailable");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "before", "file must be unchanged");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod cold_registry_tests {
    //! PROOF (#4): the durable exec session — not a process-local map — decides
    //! whether a shell tool works.
    //!
    //! The defect, exactly as filed: `ToolRoots` held a
    //! `Mutex<HashMap<String, Arc<hearth::Runner>>>` beside `ExecSessions`.
    //! `ensure` populated it; the SYNCHRONOUS `registry_factory` consulted only
    //! it and produced `Shell::Missing` on a miss. So after a restart, or on any
    //! resumed SDK path that builds a registry before product code has called
    //! `ensure`, the durable `exec_session` row existed and `run_bash` refused
    //! anyway.
    //!
    //! The test below is that scenario and nothing else: process one opens the
    //! session, process two builds a registry over the SAME agent-data directory
    //! and runs a command WITHOUT calling `ensure` first. Against the old code
    //! this is `Shell::Missing` and an error; against the seam it is a shell.
    use super::*;
    use agent_sdk_core::Ctx;

    struct TestCtx;
    impl Ctx for TestCtx {}

    fn dirs(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("t3-cold-{tag}-{}", uuid::Uuid::new_v4()));
        let work = base.join("work");
        let data = base.join("data");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (work, data)
    }

    async fn roots(work: &std::path::Path, data: &std::path::Path) -> ToolRoots {
        let boot = open_workspace_shell(work, data.join("bootshell"))
            .await
            .expect("boot shell");
        ToolRoots::new(work.to_path_buf(), data.to_path_buf(), boot).await
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_registry_built_before_ensure_still_gets_the_durable_shell() {
        let (work, data) = dirs("resume");
        // A WORKTREE root, not the boot root. This is the discriminating detail:
        // the old code seeded its map with the boot workspace, so a test that
        // used the boot root would have passed against the bug. Only a root the
        // process never pre-opened distinguishes "the store knows" from "the map
        // happened to be warm".
        let wt = crate::vcs::worktree_base(&work.to_string_lossy()).join("t-1");
        std::fs::create_dir_all(&wt).unwrap();

        // Process one: the durable exec session for the WORKTREE is recorded,
        // and the PTY is given state only IT has — an exported variable. That
        // marker is what makes the assertion below about session IDENTITY and
        // not merely about "some shell opened": any fresh PTY would run the
        // command fine and print nothing.
        {
            let r = roots(&work, &data).await;
            r.ensure(&wt).await.expect("open the worktree session");
        }

        // Process two: fresh ToolRoots over the same data dir. Build the
        // registry FIRST — nobody has called `ensure` in this process.
        let r = roots(&work, &data).await;
        let def = agent_sdk_shell::AgentDefinition {
            name: "t".into(),
            instructions: String::new(),
            model: agent_sdk_shell::ModelRef::ClaudeResume { model: "test".into() },
            tools: vec![],
            ask_tools: vec![],
            subagents: vec![],
            mcp_servers: vec![],
            labels: Default::default(),
            options: vec![],
            cwd: Some(wt.to_string_lossy().into_owned()),
        };
        let reg = (r.registry_factory())(&def);
        let out = reg
            .get("/tool/run_bash")
            .expect("run_bash registered")
            .call_json(&TestCtx, serde_json::json!({ "command": "echo cold-ok" }))
            .await
            .expect("run_bash resolves the durable shell without a prior ensure()");
        let text = out.to_string();
        assert!(text.contains("cold-ok"), "the command ran: {text}");
        // The discriminator. Against the old code this call returned an ERROR
        // (`Shell::Missing`) because the process map was cold. And the reported
        // session id has to be the WORKTREE's durable id — if a future "fix"
        // made this fall through to the boot workspace runner, the command
        // would still succeed and this assertion is what would catch it.
        let sid = out["session_id"].as_str().unwrap_or_default();
        assert_eq!(
            sid,
            workspace_id(&norm(&wt)),
            "the tool reports the worktree's durable session, not the boot workspace's: {text}"
        );
        let _ = std::fs::remove_dir_all(crate::vcs::worktree_base(&work.to_string_lossy()));
        let _ = std::fs::remove_dir_all(work.parent().unwrap());
    }

    /// The #207 rule the deleted `Missing` variant was protecting is still in
    /// force: a work root OUTSIDE the admitted boundary does not quietly get the
    /// boot workspace shell — it fails, and the error names the root.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unadmitted_root_fails_instead_of_inheriting_the_workspace_shell() {
        let (work, data) = dirs("admit");
        let outside = std::env::temp_dir().join(format!("t3-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();

        let r = roots(&work, &data).await;
        let def = agent_sdk_shell::AgentDefinition {
            name: "t".into(),
            instructions: String::new(),
            model: agent_sdk_shell::ModelRef::ClaudeResume { model: "test".into() },
            tools: vec![],
            ask_tools: vec![],
            subagents: vec![],
            mcp_servers: vec![],
            labels: Default::default(),
            options: vec![],
            cwd: Some(outside.to_string_lossy().into_owned()),
        };
        let reg = (r.registry_factory())(&def);
        let err = reg
            .get("/tool/run_bash")
            .expect("run_bash registered")
            .call_json(&TestCtx, serde_json::json!({ "command": "echo leak" }))
            .await
            .expect_err("an unadmitted root must not get a shell");
        let msg = err.to_string();
        assert!(
            msg.contains("different checkout") || msg.to_lowercase().contains("admit"),
            "the refusal explains itself rather than silently using the boot shell: {msg}"
        );
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(work.parent().unwrap());
    }
}
