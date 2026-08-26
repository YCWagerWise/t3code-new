//! The frontend's source-control surface, over CAIRN.
//!
//! The old path (and the `git_out` helpers this replaces) shelled out to `git`
//! directly with a fresh `std::process::Command` per question. That is the
//! TypeScript `GitVcsDriver` rebuilt outside the substrate, and it gives up
//! everything cairn exists to provide: the argument screen that refuses
//! `-c alias.x='!sh'`, `--exec-path`, `--git-dir` relocation and
//! `GIT_SSH_COMMAND`-style "run this program" config; the hooks split (cairn's
//! own reads run with hooks suppressed, the user's `commit`/`push` run theirs);
//! the sandbox seam; and one parse of git's output instead of a different
//! ad-hoc parse per call site.
//!
//! So every method here is a THIN mapping from cairn's porcelain vocabulary
//! into the existing `packages/contracts` shapes. There is no git parsing in
//! this file, and there must never be: a fact this module cannot get from
//! cairn is a gap to fill in cairn.

use agent_sdk_do::Control;
use cairn::{Repo, Status};
use serde_json::{json, Value};
use std::collections::HashMap;

const WORKING_TREE_FILE_LIMIT: usize = 200;
const WORKING_TREE_FILE_BYTES_LIMIT: usize = 64 * 1024;

/// Open the repository at `cwd`, or `None` when it is not one.
pub async fn open(cwd: &str) -> Option<Repo> {
    repo(cwd).await
}

/// Open the repository at `cwd`, or `None` when it is not one.
async fn repo(cwd: &str) -> Option<Repo> {
    Repo::detect(std::path::Path::new(cwd)).await
}

/// Decide whether a client-supplied `cwd` is a directory this environment may
/// operate on, returning the canonical path.
///
/// Cairn screens git ARGUMENTS; it does not decide which repositories a T3
/// environment is allowed to touch, and it cannot — that is a product
/// authority question. Without this check a client connected for project A can
/// send project B's path and `switchRef`/`runStackedAction` will happily mutate
/// a repository the user never opened here.
///
/// Admitted: the workspace root itself, anything beneath it, and the worktrees
/// GIT reports as linked to the workspace repository (a worktree normally lives
/// OUTSIDE the root, so it cannot be admitted by prefix). Git is asked rather
/// than a side list, because a side list drifts the moment someone runs
/// `git worktree add` outside the app. Everything else fails closed.
pub async fn resolve_cwd(requested: &str, workspace_root: &str) -> Result<String, String> {
    let root = std::path::Path::new(workspace_root)
        .canonicalize()
        .map_err(|e| format!("workspace root is unreadable: {e}"))?;
    // An unresolvable path is refused, not guessed at: `..` segments must be
    // collapsed against the real filesystem before any comparison.
    let want = std::path::Path::new(requested)
        .canonicalize()
        .map_err(|_| format!("no such directory: {requested}"))?;

    if want == root || want.starts_with(&root) {
        return Ok(want.to_string_lossy().into_owned());
    }
    if let Some(repo) = Repo::detect(&root).await {
        for wt in repo.worktrees().await.unwrap_or_default() {
            if std::path::Path::new(&wt.path).canonicalize().ok().as_deref() == Some(&want) {
                return Ok(want.to_string_lossy().into_owned());
            }
        }
    }
    Err(format!(
        "\"{requested}\" is not this environment's workspace or one of its worktrees"
    ))
}

/// The one directory this environment creates worktrees in.
///
/// A sibling of the workspace, never inside it: a linked worktree living under
/// the repository root shows up in that repository's own status as a pile of
/// untracked files.
pub fn worktree_base(workspace_root: &str) -> std::path::PathBuf {
    let root = std::path::Path::new(workspace_root);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".into());
    root.parent().unwrap_or(root).join(format!(".t3code-worktrees-{}", cairn::slugify(&name)))
}

/// Where a new worktree may be created.
///
/// `resolve_cwd` proves the SOURCE repository belongs to this environment; it
/// says nothing about the DESTINATION. Without this a client for project A can
/// pass `path=/anywhere/else` and the backend happily writes a checkout outside
/// the environment's authority. Cairn refuses option-shaped paths, but it does
/// not know where a T3 environment is allowed to put files — only T3 does.
///
/// The destination directory need not exist yet, so the check canonicalizes the
/// deepest existing ANCESTOR and requires it to be the worktree base (or inside
/// it). `None` means "pick the default", which is always admissible.
pub fn resolve_worktree_dest(
    requested: Option<&str>,
    branch: &str,
    workspace_root: &str,
) -> Result<String, String> {
    let base = worktree_base(workspace_root);
    let Some(requested) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(base.join(cairn::slugify(branch)).to_string_lossy().into_owned());
    };
    let want = std::path::Path::new(requested);
    if want.is_relative() {
        return Err(format!("worktree path must be absolute, got \"{requested}\""));
    }
    // canonicalize the deepest existing ancestor, then re-append the rest, so a
    // `..` cannot walk out of the base through a directory that does not exist.
    let mut existing = want.to_path_buf();
    let mut tail = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(n), Some(p)) => {
                tail.push(n.to_os_string());
                existing = p.to_path_buf();
            }
            _ => return Err(format!("\"{requested}\" is not under this environment's worktree area")),
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|_| format!("\"{requested}\" is not reachable"))?;
    for t in tail.iter().rev() {
        resolved.push(t);
    }
    // the base itself may not exist yet either
    let base_real = base.canonicalize().unwrap_or(base.clone());
    if resolved == base_real || resolved.starts_with(&base_real) {
        Ok(resolved.to_string_lossy().into_owned())
    } else {
        Err(format!(
            "\"{requested}\" is outside this environment's worktree area ({})",
            base_real.display()
        ))
    }
}

/// Where this environment may CREATE a new directory (a clone destination).
///
/// Same authority question as a worktree destination, different verb: the path
/// does not exist yet, so the deepest existing ANCESTOR is canonicalized and
/// must be the workspace, inside it, or inside this environment's worktree
/// area. Without this a client can ask the backend to clone anywhere the
/// backend user can write, and the checkout lands outside every boundary the
/// rest of the RPCs enforce (#178).
pub fn admit_new_directory(requested: &str, workspace_root: &str) -> Result<String, String> {
    let want = std::path::Path::new(requested);
    if want.is_relative() {
        return Err(format!("destination must be absolute, got \"{requested}\""));
    }
    let mut existing = want.to_path_buf();
    let mut tail = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(n), Some(p)) => {
                tail.push(n.to_os_string());
                existing = p.to_path_buf();
            }
            _ => return Err(format!("\"{requested}\" is not under this environment")),
        }
    }
    let mut resolved = existing
        .canonicalize()
        .map_err(|_| format!("\"{requested}\" is not reachable"))?;
    for t in tail.iter().rev() {
        resolved.push(t);
    }

    let root = std::path::Path::new(workspace_root)
        .canonicalize()
        .map_err(|e| format!("workspace root is unreadable: {e}"))?;
    let base = worktree_base(workspace_root);
    let base_real = base.canonicalize().unwrap_or(base);
    if resolved == root || resolved.starts_with(&root) || resolved.starts_with(&base_real) {
        Ok(resolved.to_string_lossy().into_owned())
    } else {
        Err(format!(
            "\"{requested}\" is outside this environment (workspace {} or its worktree area {})",
            root.display(),
            base_real.display()
        ))
    }
}

/// Which worktree may be REMOVED: one this environment created (inside the
/// base) that git still reports as linked to this repository.
///
/// `remove_worktree` is `git worktree remove --force`, which discards
/// uncommitted work. Proving both facts before running it is the difference
/// between "remove the checkout T3 made" and "force-delete any path git will
/// accept for this repo".
pub async fn resolve_worktree_target(
    requested: &str,
    workspace_root: &str,
) -> Result<String, String> {
    let base = worktree_base(workspace_root).canonicalize().map_err(|_| {
        format!("this environment has created no worktrees")
    })?;
    let want = std::path::Path::new(requested)
        .canonicalize()
        .map_err(|_| format!("no such worktree: {requested}"))?;
    if !want.starts_with(&base) {
        return Err(format!(
            "\"{requested}\" was not created by this environment"
        ));
    }
    let root = std::path::Path::new(workspace_root)
        .canonicalize()
        .map_err(|e| format!("workspace root is unreadable: {e}"))?;
    let repo = Repo::detect(&root).await.ok_or("not a git repository")?;
    let linked = repo.worktrees().await.map_err(|e| e.to_string())?;
    let known = linked
        .iter()
        .any(|w| std::path::Path::new(&w.path).canonicalize().ok().as_deref() == Some(&want));
    if !known {
        return Err(format!("\"{requested}\" is not a worktree of this repository"));
    }
    Ok(want.to_string_lossy().into_owned())
}

/// The "not a repository" answer, which is a legitimate state (a user opened a
/// plain directory) rather than an error.
fn not_a_repo() -> Value {
    json!({
        "isRepo": false, "hasPrimaryRemote": false, "isDefaultRef": false,
        "refName": null, "hasWorkingTreeChanges": false,
        "workingTree": { "files": [], "insertions": 0, "deletions": 0, "fileCount": 0, "filesTruncated": false },
    })
}

/// A repository we FOUND but could not inspect — a corrupt index, unreadable
/// git metadata, a blocked git binary.
///
/// This is deliberately not [`not_a_repo`]. Reporting `isRepo: false` here is a
/// lie with consequences: the git UI drops the dirty/error signal and can offer
/// to initialize a repository whose state it merely failed to read. `isRepo`
/// stays true, the working tree is reported as UNKNOWN rather than clean, and
/// `statusError` carries git's own reason so the UI can say so.
pub fn status_unavailable(why: &str) -> Value {
    json!({
        "isRepo": true, "hasPrimaryRemote": false, "isDefaultRef": false,
        "refName": null, "hasWorkingTreeChanges": false,
        "statusUnavailable": true, "statusError": why,
        "workingTree": { "files": [], "insertions": 0, "deletions": 0, "fileCount": 0, "filesTruncated": false },
    })
}

fn bounded_working_tree_files(s: &Status) -> (Vec<Value>, bool) {
    let mut files = Vec::new();
    let mut bytes = 2usize; // JSON array brackets.
    for c in &s.working_tree.changes {
        if files.len() >= WORKING_TREE_FILE_LIMIT {
            return (files, true);
        }
        let item = json!({ "path": c.path, "insertions": c.insertions, "deletions": c.deletions });
        let item_bytes = serde_json::to_vec(&item).map(|v| v.len()).unwrap_or(usize::MAX);
        let next_bytes = bytes.saturating_add(item_bytes).saturating_add(1);
        if !files.is_empty() && next_bytes > WORKING_TREE_FILE_BYTES_LIMIT {
            return (files, true);
        }
        bytes = next_bytes;
        files.push(item);
    }
    (files, false)
}

fn local_status(s: &Status) -> Value {
    let (files, files_truncated) = bounded_working_tree_files(s);
    json!({
        "isRepo": true,
        "hasPrimaryRemote": s.has_origin,
        "isDefaultRef": s.is_default_branch,
        "refName": s.branch,
        "hasWorkingTreeChanges": s.is_dirty(),
        "workingTree": {
            // Retained VCS frames are copied into do-pubsub subscriber inboxes,
            // so carry a bounded preview plus an explicit total/truncation flag.
            "files": files,
            "fileCount": s.working_tree.changes.len(),
            "filesTruncated": files_truncated,
            "insertions": s.working_tree.insertions,
            "deletions": s.working_tree.deletions,
        },
    })
}

/// The remote half. `None` when there is no upstream — which is NOT the same as
/// "level with upstream", and rendering it as 0/0 would show an unpushed branch
/// as fully synced.
fn remote_status(s: &Status) -> Value {
    match s.upstream_ref {
        None => Value::Null,
        Some(_) => json!({
            "hasUpstream": true,
            "aheadCount": s.ahead.unwrap_or(0),
            "behindCount": s.behind.unwrap_or(0),
            "aheadOfDefaultCount": s.ahead_of_default,
            "pr": null,
        }),
    }
}

/// Canonical cursor for "the status this subscriber has already seen".
pub async fn status_fingerprint(cwd: &str) -> Option<String> {
    let repo = repo(cwd).await?;
    repo.status().await.ok().map(|s| s.fingerprint())
}

/// Map cairn's typed status into the local update payload.
pub fn status_from(s: &Status) -> Value {
    let mut out = local_status(s);
    if let (Some(o), Some(r)) = (out.as_object_mut(), remote_status(s).as_object()) {
        for (k, v) in r {
            o.insert(k.clone(), v.clone());
        }
    } else if let Some(o) = out.as_object_mut() {
        o.insert("hasUpstream".into(), json!(false));
        o.insert("aheadCount".into(), json!(0));
        o.insert("behindCount".into(), json!(0));
        o.insert("pr".into(), Value::Null);
    }
    out
}

/// Map cairn's typed status into the subscription snapshot payload.
pub fn status_snapshot_from(s: &Status) -> Value {
    json!({"_tag": "snapshot", "local": local_status(s), "remote": remote_status(s)})
}

/// `vcs.refreshStatus` — the whole status, local + remote.
pub async fn status(cwd: &str) -> Value {
    let Some(repo) = repo(cwd).await else { return not_a_repo() };
    let s = match repo.status().await {
        Ok(s) => s,
        Err(e) => return status_unavailable(&e.to_string()),
    };
    status_from(&s)
}

/// `subscribeVcsStatus` — the initial snapshot frame.
pub async fn status_snapshot(cwd: &str) -> Value {
    status_snapshot_and_fingerprint(cwd).await.0
}

/// `subscribeVcsStatus` — the initial snapshot frame and the exact baseline it
/// carries. These must come from one status read: reading the snapshot, then
/// re-reading for the watch cursor lets a filesystem change land between them
/// and be suppressed as already seen.
pub async fn status_snapshot_and_fingerprint(cwd: &str) -> (Value, String) {
    let Some(repo) = repo(cwd).await else {
        let snapshot = json!({"_tag": "snapshot", "local": not_a_repo(), "remote": null});
        return (snapshot.clone(), snapshot["local"].to_string());
    };
    let s = match repo.status().await {
        Ok(s) => s,
        Err(e) => {
            let snapshot = json!({
                "_tag": "snapshot", "local": status_unavailable(&e.to_string()), "remote": null
            });
            return (snapshot.clone(), snapshot["local"].to_string());
        }
    };
    (status_snapshot_from(&s), s.fingerprint())
}

/// `vcs.listRefs`.
pub async fn list_refs(cwd: &str, input: &Value) -> Value {
    let Some(repo) = repo(cwd).await else {
        return json!({"refs": [], "isRepo": false, "hasPrimaryRemote": false,
                      "nextCursor": null, "totalCount": 0});
    };
    let query = input.get("query").and_then(Value::as_str);
    let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize;
    let refs = repo
        .list_refs(query, Some(limit))
        .await
        .map_err(|e| format!("ref list unavailable: {e}"));
    let default = repo.default_branch().await;
    let has_remote = repo.remote().await.is_some();
    let worktrees = repo
        .worktrees()
        .await
        .map_err(|e| format!("worktree ownership unavailable: {e}"));
    list_refs_payload(refs, worktrees, default, has_remote)
}

fn refs_unavailable(why: String) -> Value {
    json!({
        "refs": [],
        "isRepo": true,
        "hasPrimaryRemote": false,
        "nextCursor": null,
        "totalCount": 0,
        "statusUnavailable": true,
        "statusError": why,
    })
}

fn list_refs_payload(
    refs: Result<Vec<cairn::Ref>, String>,
    worktrees: Result<Vec<cairn::Worktree>, String>,
    default: Option<String>,
    has_remote: bool,
) -> Value {
    let refs = match refs {
        Ok(refs) => refs,
        Err(e) => return refs_unavailable(e),
    };
    // Which branch is checked out in which linked worktree. The backend owns
    // this truth: without it the UI cannot disable unsafe operations on a ref
    // another worktree already holds, and cannot route a click to the pane that
    // owns it.
    //
    // When cairn cannot list linked worktrees, an EMPTY owner map is the one
    // answer that must not be given (#258): every ref then reports
    // `worktreePath: null`, which the UI reads as "free", and it will happily
    // offer to delete or switch to a branch another worktree currently holds
    // checked out. The refs themselves are still real, so blanking them would
    // be a second fabrication in the other direction. Return them, and say
    // ownership is UNKNOWN — `ownershipUnavailable` is what disables the
    // affordances that depend on it.
    let (owners, ownership_error): (HashMap<String, String>, Option<String>) = match worktrees {
        Ok(worktrees) => (worktrees.into_iter().map(|w| (w.branch, w.path)).collect(), None),
        Err(e) => (HashMap::new(), Some(e)),
    };
    let total = refs.len() as i64;
    let mut out = json!({
        "refs": refs.iter().map(|r| json!({
            "name": r.name,
            "current": r.is_current,
            "isDefault": Some(&r.name) == default.as_ref(),
            "worktreePath": owners.get(&r.name),
        })).collect::<Vec<_>>(),
        "isRepo": true,
        "hasPrimaryRemote": has_remote,
        "nextCursor": null,
        "totalCount": total,
    });
    if let (Some(e), Some(o)) = (ownership_error, out.as_object_mut()) {
        o.insert("ownershipUnavailable".into(), json!(true));
        o.insert("refsError".into(), json!(e));
    }
    out
}

/// The shape every mutating VCS method answers with on failure. The frontend
/// contract has typed errors; what matters here is that a refusal is REPORTED
/// (with git's own reason) rather than swallowed into a success.
pub type VcsResult = Result<Value, String>;

/// `vcs.pull` → `VcsPullResult { status, refName, upstreamRef }`.
///
/// The frontend decodes this against a schema, so cairn's `RemoteResult` is
/// TRANSLATED here rather than forwarded: a success frame the client cannot
/// decode is indistinguishable from a broken button.
pub async fn pull(cwd: &str) -> VcsResult {
    let repo = repo(cwd).await.ok_or("not a git repository")?;
    let before = repo.status().await.map_err(|e| e.to_string())?;
    let r = repo.pull(None).await.map_err(|e| e.to_string())?;
    let after = repo.status().await.map_err(|e| e.to_string())?;
    // "already up to date" is a distinct outcome the UI renders differently, so
    // it is derived from whether HEAD actually moved rather than from parsing
    // git's English.
    let moved = before.head_commit != after.head_commit;
    Ok(json!({
        "status": if moved { "pulled" } else { "skipped_up_to_date" },
        "refName": after.branch.clone().unwrap_or_else(|| r.branch.clone()),
        "upstreamRef": after.upstream_ref,
    }))
}

/// `vcs.createRef` — a branch, optionally switched to.
pub async fn create_ref(cwd: &str, input: &Value) -> VcsResult {
    let repo = repo(cwd).await.ok_or("not a git repository")?;
    let name = input.get("refName").and_then(Value::as_str).ok_or("refName is required")?;
    repo.create_branch(name, None).await.map_err(|e| e.to_string())?;
    if input.get("switchRef").and_then(Value::as_bool).unwrap_or(false) {
        repo.switch_to(name).await.map_err(|e| e.to_string())?;
    }
    Ok(json!({ "refName": name }))
}

/// `vcs.switchRef`.
pub async fn switch_ref(cwd: &str, input: &Value) -> VcsResult {
    let repo = repo(cwd).await.ok_or("not a git repository")?;
    let name = input.get("refName").and_then(Value::as_str).ok_or("refName is required")?;
    repo.switch_to(name).await.map_err(|e| e.to_string())?;
    Ok(json!({ "refName": name }))
}

/// `vcs.createWorktree`.
pub async fn create_worktree(cwd: &str, input: &Value, workspace_root: &str) -> VcsResult {
    let repo = repo(cwd).await.ok_or("not a git repository")?;
    let branch = input
        .get("newRefName")
        .and_then(Value::as_str)
        .or_else(|| input.get("refName").and_then(Value::as_str))
        .ok_or("refName is required")?;
    // ADMIT the destination before git runs: a refused path must not leave a
    // checkout on disk that we then have to reason about.
    let path = resolve_worktree_dest(
        input.get("path").and_then(Value::as_str),
        branch,
        workspace_root,
    )?;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("worktree area: {e}"))?;
    }
    // `baseRefName` is the safety half of the worktree flow: a new agent
    // worktree asked to start from origin/main must NOT inherit whatever the
    // current checkout is on (#104).
    let base = input.get("baseRefName").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let wt = repo.add_worktree_from(&path, branch, base).await.map_err(|e| e.to_string())?;
    // VcsCreateWorktreeResult wraps the worktree; a bare {path, refName} does
    // not decode.
    Ok(json!({ "worktree": { "path": wt.path, "refName": wt.branch } }))
}

/// `vcs.removeWorktree`.
pub async fn remove_worktree(cwd: &str, input: &Value, workspace_root: &str) -> VcsResult {
    let repo = repo(cwd).await.ok_or("not a git repository")?;
    let requested = input.get("path").and_then(Value::as_str).ok_or("path is required")?;
    // `--force` discards uncommitted work, so prove it is ours AND still linked.
    let path = resolve_worktree_target(requested, workspace_root).await?;
    repo.remove_worktree(&path).await.map_err(|e| e.to_string())?;
    Ok(json!({ "path": path }))
}

/// `vcs.init`.
pub async fn init(cwd: &str) -> VcsResult {
    if repo(cwd).await.is_some() {
        return Ok(json!({ "isRepo": true, "created": false }));
    }
    cairn::init_repository(std::path::Path::new(cwd)).await.map_err(|e| e.to_string())?;
    Ok(json!({ "isRepo": true, "created": true }))
}

/// The source-control provider seam a PR phase runs through (#138).
///
/// Two methods and not one, because the ORDER is the finding. Opening a pull
/// request is the last phase of `commit_push_pr`, so discovering there that no
/// provider can do it leaves the user's branch committed and pushed, the PR
/// unopened, and the UI reporting a failed action — a half-completed command
/// they now have to finish by hand while the frontend says it did not work.
/// [`available`](PullRequestOpener::available) is asked BEFORE any git
/// mutation so that case fails clean, having changed nothing.
#[async_trait::async_trait]
pub trait PullRequestOpener: Send + Sync {
    /// Can this environment open a PR for `cwd` right now? `Err` carries the
    /// actionable reason (no CLI, not authenticated, no remote).
    ///
    /// Asked before the action mutates anything.
    async fn available(&self, cwd: &str) -> Result<(), String>;

    /// Open it, and return the contract's `pr` result object.
    async fn open(&self, cwd: &str, head: &str, title: &str, body: &str) -> Result<Value, String>;
}

/// GitHub, via the same `gh` CLI `sourcecontrol::discover` probes and
/// `publish_repository` already drives — so the PR phase is available exactly
/// when the settings panel says GitHub is.
pub struct GhPullRequests;

#[async_trait::async_trait]
impl PullRequestOpener for GhPullRequests {
    async fn available(&self, cwd: &str) -> Result<(), String> {
        let out = gh(cwd, &["auth", "status"]).await.map_err(|e| {
            format!(
                "opening a pull request needs the GitHub CLI (`gh`), which is not available \
                 in this environment: {e}"
            )
        })?;
        if out.exit_code != 0 {
            return Err(format!(
                "the GitHub CLI (`gh`) is installed but not authenticated — run `gh auth login`: {}",
                out.stderr.trim()
            ));
        }
        Ok(())
    }

    async fn open(&self, cwd: &str, head: &str, title: &str, body: &str) -> Result<Value, String> {
        let out = gh(cwd, &["pr", "create", "--head", head, "--title", title, "--body", body])
            .await
            .map_err(|e| format!("gh is not available in this environment: {e}"))?;
        if out.exit_code == 0 {
            return Ok(json!({ "status": "created", "url": out.stdout.trim() }));
        }
        let stderr = out.stderr.trim().to_string();
        // An existing PR for this branch is NOT a failure of the user's intent
        // — they asked for their work to be up for review and it is. Report it
        // as already-open with the URL rather than failing an action whose
        // commit and push both succeeded.
        if stderr.contains("already exists") {
            let view = gh(cwd, &["pr", "view", head, "--json", "url", "-q", ".url"])
                .await
                .map_err(|e| format!("gh pr view: {e}"))?;
            return Ok(json!({ "status": "already_open", "url": view.stdout.trim() }));
        }
        Err(format!("gh pr create: {stderr}"))
    }
}

/// Run one `gh` invocation through CAIRN's screened exec seam (#375).
///
/// Not `tokio::process::Command::new("gh")`. The five-repo charter puts git/gh
/// execution policy in cairn, and the reason is not tidiness: cairn's screen is
/// what refuses the argument shapes that turn an allow-listed program into an
/// arbitrary one, and it applies that screen to every consumer that reaches
/// `Repo::exec` — including ones that do not know the screen exists. A product
/// subprocess inherits none of it, so source-control safety goes back to
/// depending on each call site remembering to be careful.
///
/// The product still owns WHICH arguments to marshal and what the RPC result
/// looks like. It just no longer owns whether the process may run.
async fn gh(cwd: &str, args: &[&str]) -> Result<cairn::exec::Output, String> {
    let repo = repo(cwd).await.ok_or_else(|| format!("{cwd} is not a git repository"))?;
    let owned: Vec<String> = args.iter().map(|a| (*a).to_string()).collect();
    repo.exec(&cairn::exec::Exec {
        command: "gh",
        args: &owned,
        stdin: None,
        env: &[],
        timeout_ms: 60_000,
        // A PR URL and an auth-status line; a `gh` that decides to stream is
        // not something this seam should buffer without a ceiling.
        max_output_bytes: 256 * 1024,
    })
    .await
    .map_err(|e| e.to_string())
}

/// `git.runStackedAction` — the frontend's commit/push/PR pipeline.
///
/// Speaks the CONTRACT vocabulary, not a private one: the action literals are
/// `commit | push | create_pr | commit_push | commit_push_pr`, and every frame
/// is a `GitActionProgressEvent` carrying `actionId`, `cwd` and `action` —
/// the client filters on `actionId` AND `cwd`, and a run with no terminal
/// `action_finished`/`action_failed` fails in the UI with
/// `VcsActionMissingTerminalEventError`. A parallel `started/progress/completed`
/// protocol looks fine in a Rust test and is invisible to the product.
///
/// Hooks run (`pre-commit`, `commit-msg`, `pre-push`) because the user asked
/// for a commit — cairn owns that split.
/// Run a stacked action, DELIVERING EACH PROGRESS FRAME AS IT HAPPENS (#423).
///
/// `sink` is called the moment a frame is produced — `action_started` before
/// any git runs, each `phase_started` before the phase blocks. This is the
/// difference between a progress stream and a transcript: the previous shape
/// accumulated every frame into a `Vec` and returned it, so the caller could
/// only emit them once the whole action had already finished. A push that
/// blocks on the network showed the user nothing for its entire duration and
/// then flushed a complete history of something that was already over.
///
/// It is also the prerequisite for #278: you cannot attach to, inspect, or
/// cancel a stream that never streamed.
/// A stacked action's VERDICT: `None` if every requested phase completed,
/// `Some((phase, message))` if one refused.
///
/// Separate from the `Result` because they answer different questions. `Err` is
/// "the pipeline could not run" (an unsupported action string). `Ok(Some(..))`
/// is "it ran and the action FAILED" — a fact the caller must be able to act on
/// without parsing the frame stream, which is exactly what the fail-open bug
/// forced it to do.
pub type ActionVerdict = Option<(Value, String)>;

pub async fn run_stacked_action_streaming(
    cwd: &str,
    input: &Value,
    sink: &mut (dyn FnMut(Value) + Send),
    cancel: Option<&Control>,
) -> Result<ActionVerdict, String> {
    // The caller's sink goes STRAIGHT through. Nothing between this function
    // and `_streaming_with` is allowed to hold a frame, because the only thing
    // that distinguishes a progress stream from a transcript is WHEN the
    // caller can read it.
    //
    // The previous body here buffered into a `Vec` and flushed after the action
    // returned, under a `FALSIFICATION` marker — deliberately, to prove
    // `stacked_action_progress_is_readable_while_the_action_is_still_running`
    // actually fails against the buffered shape. It does: that test reports
    // "no action_started became readable in 2.01s ... The frames are being
    // collected and replayed after the action completes, which is a transcript,
    // not a progress stream". The falsification did its job; this is the real
    // body.
    //
    // Note this is the PUBLIC entry point `server_main.rs` calls. Streaming
    // only in `_streaming_with` proved nothing about the product path, which is
    // exactly what #423 was reopened for.
    run_stacked_action_streaming_with(cwd, input, &GhPullRequests, sink, cancel).await
}

/// Collecting form: runs the same streaming pipeline and gathers the frames.
///
/// This is NOT a compatibility shim around a changed API — it is the shape a
/// test wants (assert over the whole frame sequence), and it runs the identical
/// code path, so a frame-order assertion here is an assertion about what the
/// streaming caller actually receives.
pub async fn run_stacked_action(cwd: &str, input: &Value) -> Result<Vec<Value>, String> {
    run_stacked_action_with(cwd, input, &GhPullRequests).await
}

/// [`run_stacked_action`] with the PR provider injected, so the pipeline can be
/// tested against a fake opener without a `gh` binary, a network, or a GitHub
/// account. The provider is the ONLY part of this pipeline that cannot run in a
/// test otherwise — everything else is a real git repository in a temp dir.
pub async fn run_stacked_action_with(
    cwd: &str,
    input: &Value,
    prs: &dyn PullRequestOpener,
) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    // The VERDICT is deliberately dropped here and the FRAMES are kept. This
    // form exists so a test can assert over the whole frame sequence, including
    // the `action_failed` frame a refusal emits — returning `Err` on a refusal
    // would throw those frames away, which is the opposite of this function's
    // job. Callers that need the verdict use the streaming form.
    let _verdict =
        // No cancel: this form runs to completion by construction — it exists so a
        // test can assert over a whole frame sequence, and a half-collected
        // sequence is not one.
        run_stacked_action_streaming_with(cwd, input, prs, &mut |v| out.push(v), None).await?;
    Ok(out)
}

fn stacked_action_id(input: &Value) -> Result<String, String> {
    input
        .get("actionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "runStackedAction requires an actionId".to_string())
}

/// Is a durable cancel pending for this action? (#278)
///
/// The flag lives in `agent_control`, the SAME row `agent_sdk_do::Control`
/// owns for turn cancellation — deliberately not a bespoke key in the orch
/// store's kv, which would be a second cancellation mechanism sitting next to
/// the real one with none of its terminate/deadline semantics.
///
/// A read error is a refusal, not "not cancelled". This gate is checked only
/// at phase boundaries, so refusing on unreadable control state does not
/// interrupt an in-flight git operation; it prevents the next irreversible
/// phase from starting under unknown cancellation authority.
async fn action_cancelled(cancel: Option<&Control>, action_id: &str) -> Result<bool, String> {
    let Some(control) = cancel else { return Ok(false) };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(!matches!(
        control
            .check(action_id, now)
            .await
            .map_err(|e| format!("cancel state unreadable for {action_id}: {e}"))?,
        agent_sdk_do::Checkpoint::Continue
    ))
}

/// [`run_stacked_action_streaming`] with the PR provider injected.
///
/// `cancel` is checked at every PHASE BOUNDARY. Unlike the turn loop (#411),
/// this does not race the cancel against in-flight work: git phases ARE the
/// action boundaries `Control`'s contract is written around, and there is no
/// safe way to abort a `git push` mid-flight. A phase already running finishes.
pub async fn run_stacked_action_streaming_with(
    cwd: &str,
    input: &Value,
    prs: &dyn PullRequestOpener,
    sink: &mut (dyn FnMut(Value) + Send),
    cancel: Option<&Control>,
) -> Result<ActionVerdict, String> {
    let action = input.get("action").and_then(Value::as_str).unwrap_or("").to_string();
    let action_id = stacked_action_id(input)?;
    let message = input.get("commitMessage").and_then(Value::as_str).unwrap_or("");

    let (do_commit, do_push, do_pr) = match action.as_str() {
        "commit" => (true, false, false),
        "push" => (false, true, false),
        "create_pr" => (false, false, true),
        "commit_push" => (true, true, false),
        "commit_push_pr" => (true, true, true),
        other => return Err(format!("unsupported stacked action \"{other}\"")),
    };

    let base = json!({ "actionId": action_id, "cwd": cwd, "action": action });
    let frame = |extra: Value| -> Value {
        let mut f = base.clone();
        if let (Some(o), Some(e)) = (f.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                o.insert(k.clone(), v.clone());
            }
        }
        f
    };
    let failed = |phase: Value, message: String| -> Vec<Value> {
        vec![frame(json!({"kind": "action_failed", "phase": phase, "message": message}))]
    };
    macro_rules! gate_cancel {
        ($phase:literal) => {
            match action_cancelled(cancel, &action_id).await {
                Ok(true) => {
                    sink(frame(json!({"kind": "action_cancelled", "phase": $phase})));
                    return Ok(Some((
                        json!($phase),
                        "cancelled before this phase started".to_string(),
                    )));
                }
                Ok(false) => {}
                Err(e) => {
                    let (p, m): (Value, String) = (
                        json!($phase),
                        format!("could not read cancellation state: {e}"),
                    );
                    for f in failed(p.clone(), m.clone()) {
                        sink(f);
                    }
                    return Ok(Some((p, m)));
                }
            }
        };
    }
    // THE ACTION'S VERDICT, separate from "did the pipeline run" (fail-open fix).
    //
    // Every failure path below emits an `action_failed` FRAME and then returned
    // `Ok(())`, so `server_main`'s `Ok(()) => exit_success` reported the RPC as
    // SUCCESSFUL for an action that failed. The failure existed only in the
    // frame stream, and a caller that trusts the Exit — which is what an Exit is
    // for — was told a commit/push/PR worked when nothing was pushed and no PR
    // existed. Same fail-open family as #418 and #374.
    //
    // This is NOT fixed by returning `Err` from the failure paths: the
    // COLLECTING form (`run_stacked_action`) returns `Result<Vec<Value>, String>`,
    // so an `Err` would discard the very `action_failed` frames that
    // `a_failing_stacked_action_still_delivers_the_progress_that_already_happened`
    // exists to assert. `Err` stays reserved for "the pipeline could not run"
    // (an unsupported action string); a phase REFUSAL is a verdict the caller
    // must see ALONGSIDE its frames. So the outcome rides out separately and
    // both consumers get the whole truth.

    // `featureBranch` is a SAFETY flag, not decoration: the UI uses it to skip
    // its own default-branch confirmation because it believes the backend will
    // move the work onto a feature ref first. Ignoring it means a commit the
    // user was told is safe lands on main.
    let feature_branch = input.get("featureBranch").and_then(Value::as_bool).unwrap_or(false);

    let mut phases: Vec<&str> = Vec::new();
    if feature_branch {
        phases.push("branch");
    }
    if do_commit {
        phases.push("commit");
    }
    if do_push {
        phases.push("push");
    }
    if do_pr {
        phases.push("pr");
    }
    // Emitted BEFORE any git process starts, which is the whole point of #423.
    sink(frame(json!({"kind": "action_started", "phases": phases})));

    let Some(repo) = repo(cwd).await else {
        { let (p, m): (Value, String) = (Value::Null, "not a git repository".into()); for f in failed(p.clone(), m.clone()) { sink(f); }
        return Ok(Some((p, m))); }
    };

    // THE PR PRECHECK, AND ITS POSITION IS THE POINT (#138).
    //
    // `commit_push_pr` is one command to the user. Discovering at the LAST
    // phase that nothing here can open a pull request used to leave them with
    // a committed, pushed branch, no PR, and an `action_failed` — the work
    // half done, in a state they now have to finish by hand while the UI says
    // it failed. Asking the provider first means that case changes NOTHING:
    // no branch, no commit, no push, and one honest error naming what to
    // install. This runs before the branch phase for exactly that reason;
    // moving it later re-creates the bug.
    if do_pr {
        if let Err(why) = prs.available(cwd).await {
            { let (p, m): (Value, String) = (json!("pr"), why); for f in failed(p.clone(), m.clone()) { sink(f); }
            return Ok(Some((p, m))); }
        }
    }

    let mut branch_step = json!({"status": "skipped_not_requested"});
    if feature_branch {
        // #278 cancel gate, BEFORE the phase starts. Emitting
        // `phase_started` first would tell the UI a phase began that never ran.
        gate_cancel!("branch");
        sink(frame(json!({"kind": "phase_started", "phase": "branch", "label": "Preparing feature ref"})));
        let status = repo.status().await.map_err(|e| e.to_string());
        let Ok(status) = status else {
            { let (p, m): (Value, String) = (json!("branch"), "could not read repository status".into()); for f in failed(p.clone(), m.clone()) { sink(f); }
            return Ok(Some((p, m))); }
        };
        // A derived, SCREENED name. `slugify` keeps it a valid ref, and cairn
        // refuses an option-shaped one outright.
        let stem = input
            .get("featureBranchName")
            .and_then(Value::as_str)
            .map(String::from)
            .unwrap_or_else(|| {
                let subject = message.lines().next().unwrap_or("work");
                format!("t3/{}", cairn::slugify(subject))
            });
        // Already standing on a non-default ref that is not the base? Then the
        // safe ref exists; creating another would fragment the work.
        if status.is_default_branch || status.branch.is_none() {
            match repo.create_branch(&stem, None).await {
                Ok(_) => {}
                Err(e) => {
                    { let (p, m): (Value, String) = (json!("branch"), e.to_string()); for f in failed(p.clone(), m.clone()) { sink(f); }
                    return Ok(Some((p, m))); }
                }
            }
            if let Err(e) = repo.switch_to(&stem).await {
                { let (p, m): (Value, String) = (json!("branch"), e.to_string()); for f in failed(p.clone(), m.clone()) { sink(f); }
                return Ok(Some((p, m))); }
            }
            branch_step = json!({"status": "created", "name": stem});
        } else {
            // honest: we did not create one because we are already off default
            branch_step =
                json!({"status": "skipped_not_requested", "name": status.branch.clone()});
        }
    }

    let mut commit_step = json!({"status": "skipped_not_requested"});
    if do_commit {
        // #278 cancel gate, BEFORE the phase starts. Emitting
        // `phase_started` first would tell the UI a phase began that never ran.
        gate_cancel!("commit");
        sink(frame(json!({"kind": "phase_started", "phase": "commit", "label": "Committing"})));
        let (subject, body) = message.split_once("\n\n").unwrap_or((message, ""));
        if subject.trim().is_empty() {
            { let (p, m): (Value, String) = (json!("commit"), "a commit needs a message".into()); for f in failed(p.clone(), m.clone()) { sink(f); }
            return Ok(Some((p, m))); }
        }
        let paths: Vec<String> = input
            .get("filePaths")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // stage first: `commit --all` never picks up untracked files
        if let Err(e) = repo.stage(&paths).await {
            { let (p, m): (Value, String) = (json!("commit"), e.to_string()); for f in failed(p.clone(), m.clone()) { sink(f); }
            return Ok(Some((p, m))); }
        }
        // nothing staged is "skipped_no_changes", a real outcome the UI shows —
        // not an error and not a fake commit.
        let staged = repo.staged().await.ok().flatten();
        if staged.is_none() {
            commit_step = json!({"status": "skipped_no_changes"});
        } else {
            // SCOPE IS AUTHORITY (#212). `--all` re-stages every tracked
            // modification just before committing, so a caller that selected
            // `a.txt` would also commit a dirty `b.txt` and the selected-file UI
            // would be decoration. When a file list was supplied, commit the
            // index we just staged; only an empty selection means "everything".
            let commit_all = paths.is_empty();
            match repo.commit(subject, body, commit_all).await {
                Ok(sha) => {
                    commit_step = json!({"status": "created", "commitSha": sha, "subject": subject})
                }
                Err(e) => {
                    { let (p, m): (Value, String) = (json!("commit"), e.to_string()); for f in failed(p.clone(), m.clone()) { sink(f); }
                    return Ok(Some((p, m))); }
                }
            }
        }
    }

    let mut push_step = json!({"status": "skipped_not_requested"});
    if do_push {
        // #278 cancel gate, BEFORE the phase starts. Emitting
        // `phase_started` first would tell the UI a phase began that never ran.
        gate_cancel!("push");
        sink(frame(json!({"kind": "phase_started", "phase": "push", "label": "Pushing"})));
        match repo.push(None).await {
            Ok(r) => push_step = json!({"status": "pushed", "branch": r.branch, "setUpstream": true}),
            Err(e) => {
                // #427. RE-APPLIED after a whole-file revert clobbered it.
                // Was `return Ok(None)` — the last of eleven refusal sites still
                // reporting "ran, nothing failed", so `server_main` answered
                // `exit_success` for a commit_push whose commit landed and whose
                // push was rejected. Pinned by
                // `a_stacked_action_that_fails_exits_failure_and_says_which_phase`.
                { let (p, m): (Value, String) = (json!("push"), e.to_string()); for f in failed(p.clone(), m.clone()) { sink(f); }
                return Ok(Some((p, m))); }
            }
        }
    }

    let mut pr_step = json!({"status": "skipped_not_requested"});
    if do_pr {
        // #278 cancel gate, BEFORE the phase starts. Emitting
        // `phase_started` first would tell the UI a phase began that never ran.
        gate_cancel!("pr");
        sink(frame(json!({"kind": "phase_started", "phase": "pr", "label": "Opening pull request"})));
        // The head ref is read from the repository rather than taken from the
        // request: after the branch phase this is the ref the work is actually
        // on, and a caller-supplied name could disagree with it.
        let Some(head) = repo.branch().await else {
            { let (p, m): (Value, String) = (json!("pr"), "the repository is on a detached HEAD — there is no branch to open a pull request from".into()); for f in failed(p.clone(), m.clone()) { sink(f); }
            return Ok(Some((p, m))); }
        };
        let (subject, body) = message.split_once("\n\n").unwrap_or((message, ""));
        let title = if subject.trim().is_empty() { head.as_str() } else { subject };
        match prs.open(cwd, &head, title, body).await {
            Ok(pr) => pr_step = pr,
            Err(e) => {
                { let (p, m): (Value, String) = (json!("pr"), e); for f in failed(p.clone(), m.clone()) { sink(f); }
                return Ok(Some((p, m))); }
            }
        }
    }

    // A PR that was opened is the thing the user wanted to reach — give them
    // the link rather than a bare "Done".
    let toast = match pr_step.get("url").and_then(Value::as_str) {
        Some(url) if !url.is_empty() => json!({
            "title": if pr_step["status"] == "already_open" { "Pull request already open" } else { "Pull request opened" },
            "cta": {"kind": "open_url", "url": url},
        }),
        _ => json!({"title": "Done", "cta": {"kind": "none"}}),
    };
    let result = json!({
        "action": action,
        "branch": branch_step,
        "commit": commit_step,
        "push": push_step,
        "pr": pr_step,
        "toast": toast,
    });
    sink(frame(json!({"kind": "action_finished", "result": result})));
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_sdk_do::do_rs::{Error as DoError, Param, Result as DoResult};
    use agent_sdk_do::ObjectDb;
    use std::sync::Arc;

    struct FailsControlCheck {
        inner: Arc<dyn ObjectDb>,
    }

    #[async_trait::async_trait]
    impl ObjectDb for FailsControlCheck {
        async fn execute(&self, sql: &str, params: Vec<Value>) -> DoResult<u64> {
            self.inner.execute(sql, params).await
        }

        async fn execute_typed(&self, sql: &str, params: Vec<Param>) -> DoResult<u64> {
            self.inner.execute_typed(sql, params).await
        }

        async fn query_blob(&self, sql: &str, params: Vec<Param>) -> DoResult<Option<Vec<u8>>> {
            self.inner.query_blob(sql, params).await
        }

        async fn query(&self, sql: &str, params: Vec<Value>) -> DoResult<Vec<Value>> {
            if sql.contains(
                "SELECT cancel_requested, terminated, deadline_ms FROM agent_control",
            ) {
                return Err(DoError::Backend("agent_control read failed".into()));
            }
            self.inner.query(sql, params).await
        }

        async fn execute_batch(&self, sql: &str) -> DoResult<()> {
            self.inner.execute_batch(sql).await
        }

        fn query_stream<'a>(
            &'a self,
            sql: &'a str,
            params: Vec<Value>,
        ) -> std::pin::Pin<Box<dyn futures::Stream<Item = DoResult<Value>> + Send + 'a>>
        {
            self.inner.query_stream(sql, params)
        }
    }

    /// A `Control` over a throwaway isolate, so the cancel flag under test is a
    /// REAL durable row and not a bool the test made up.
    async fn scratch_control(tag: &str) -> agent_sdk_do::Control {
        let dir = std::env::temp_dir().join(format!("t3-cancel-{tag}-{}", uuid::Uuid::new_v4()));
        let store = agent_sdk_shell::OrchStore::open_at(dir.to_str().unwrap(), "test")
            .await
            .expect("open a scratch orchestration store");
        let db = store.db().clone();
        agent_sdk_do::Control::ensure_schema(&db).await.expect("control schema");
        agent_sdk_do::Control::new(db)
    }

    async fn scratch_control_db(tag: &str) -> (agent_sdk_do::Control, Arc<dyn ObjectDb>) {
        let dir = std::env::temp_dir().join(format!("t3-cancel-{tag}-{}", uuid::Uuid::new_v4()));
        let store = agent_sdk_shell::OrchStore::open_at(dir.to_str().unwrap(), "test")
            .await
            .expect("open a scratch orchestration store");
        let db = store.db().clone();
        agent_sdk_do::Control::ensure_schema(&db).await.expect("control schema");
        (agent_sdk_do::Control::new(db.clone()), db)
    }

    /// PROOF (#278, cancel half): a cancel requested for an action's id STOPS it
    /// at the next phase boundary, and says so in the stream and in the verdict.
    ///
    /// The cancel is issued through the durable row BEFORE the run, which is the
    /// honest shape for this contract: the row is the rendezvous, so it does not
    /// matter whether the cancel arrives before, during, or from another
    /// connection entirely. A test that cancelled via an in-process handle would
    /// prove the opposite of what #278 asks for.
    #[tokio::test]
    async fn a_cancelled_stacked_action_stops_at_the_next_phase_boundary() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        let control = scratch_control("stop").await;
        control.cancel("a-cancel").await.unwrap();

        let mut frames = Vec::new();
        let verdict = run_stacked_action_streaming(
            cwd,
            &json!({
                "actionId": "a-cancel", "cwd": cwd,
                "action": "commit", "commitMessage": "should never land",
            }),
            &mut |f| frames.push(f),
            Some(&control),
        )
        .await
        .unwrap();

        // THE VERDICT: cancelled is a REFUSAL, not a success. A cancel that
        // exits Success is the #427 fail-open wearing a different hat.
        let (phase, message) = verdict.expect("a cancelled action must report a verdict, not None");
        assert_eq!(phase, json!("commit"), "the verdict must name the phase that was stopped");
        assert!(message.contains("cancelled"), "verdict message: {message}");

        // THE STREAM: the client is told, and is NOT told a phase began.
        let kinds: Vec<&str> = frames.iter().filter_map(|f| f["kind"].as_str()).collect();
        assert!(kinds.contains(&"action_cancelled"), "frames: {frames:?}");
        assert!(
            !kinds.contains(&"phase_started"),
            "the gate runs BEFORE phase_started, so a cancelled action must never \
             announce a phase it did not run: {frames:?}"
        );

        // THE REPOSITORY: nothing was committed. This is the assertion that
        // makes the test about behaviour rather than about frames.
        let repo = repo(cwd).await.unwrap();
        let status = repo.status().await.unwrap();
        assert!(
            status.is_dirty(),
            "a cancelled commit must leave the tree dirty — the work must NOT have landed: {status:?}"
        );
        assert!(
            status.head_commit.is_none(),
            "a cancelled commit must leave NO commit behind, not merely a dirty tree: {status:?}"
        );
    }

    /// The negative control. Same pipeline, same wiring, a `Control` with NO
    /// cancel on it — so the test above cannot be passing because the gate
    /// rejects everything.
    #[tokio::test]
    async fn an_uncancelled_action_runs_normally_with_a_control_attached() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        let control = scratch_control("go").await;

        let mut frames = Vec::new();
        let verdict = run_stacked_action_streaming(
            cwd,
            &json!({
                "actionId": "a-go", "cwd": cwd,
                "action": "commit", "commitMessage": "this one lands",
            }),
            &mut |f| frames.push(f),
            Some(&control),
        )
        .await
        .unwrap();

        assert!(verdict.is_none(), "an uncancelled commit must not report a refusal: {verdict:?}");
        let kinds: Vec<&str> = frames.iter().filter_map(|f| f["kind"].as_str()).collect();
        assert!(kinds.contains(&"phase_started"), "frames: {frames:?}");
        assert!(!kinds.contains(&"action_cancelled"), "frames: {frames:?}");
    }

    /// If the durable cancel row cannot be read at a phase boundary, the action
    /// refuses that phase. Treating the read failure as `Continue` starts work
    /// after the user has already requested cancellation.
    #[tokio::test]
    async fn an_unreadable_cancel_state_fails_closed_before_the_next_phase() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        let (control, db) = scratch_control_db("read-fails").await;
        control.cancel("a-unreadable").await.unwrap();
        let broken = agent_sdk_do::Control::new(Arc::new(FailsControlCheck { inner: db }));

        let mut frames = Vec::new();
        let verdict = run_stacked_action_streaming(
            cwd,
            &json!({
                "actionId": "a-unreadable", "cwd": cwd,
                "action": "commit", "commitMessage": "must not land",
            }),
            &mut |f| frames.push(f),
            Some(&broken),
        )
        .await
        .unwrap();

        let (phase, message) =
            verdict.expect("unreadable cancel state must be a terminal refusal");
        assert_eq!(phase, json!("commit"));
        assert!(
            message.contains("cancellation state") && message.contains("agent_control"),
            "verdict reports the unreadable control row: {message}"
        );
        let kinds: Vec<&str> = frames.iter().filter_map(|f| f["kind"].as_str()).collect();
        assert!(kinds.contains(&"action_failed"), "frames: {frames:?}");
        assert!(
            !kinds.contains(&"phase_started"),
            "the commit phase must not start after the cancel-state read failed: {frames:?}"
        );

        let repo = repo(cwd).await.unwrap();
        let status = repo.status().await.unwrap();
        assert!(status.is_dirty(), "the dirty work was not committed: {status:?}");
        assert!(status.head_commit.is_none(), "no commit was created: {status:?}");
    }

    #[tokio::test]
    async fn a_fresh_generation_reuses_a_cancelled_action_id_without_poison() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        let control = scratch_control("reuse").await;

        control.cancel("reuse-me").await.unwrap();
        assert!(action_cancelled(Some(&control), "reuse-me").await.unwrap());
        control.start_fresh("reuse-me").await.unwrap();

        let mut frames = Vec::new();
        let verdict = run_stacked_action_streaming(
            cwd,
            &json!({
                "actionId": "reuse-me", "cwd": cwd,
                "action": "commit", "commitMessage": "fresh generation lands",
            }),
            &mut |f| frames.push(f),
            Some(&control),
        )
        .await
        .unwrap();

        assert!(verdict.is_none(), "fresh action id generation must run: {verdict:?}");
        let kinds: Vec<&str> = frames.iter().filter_map(|f| f["kind"].as_str()).collect();
        assert!(!kinds.contains(&"action_cancelled"), "stale cancel poisoned fresh run: {frames:?}");
        assert!(kinds.contains(&"action_finished"), "fresh action finished: {frames:?}");
    }

    #[tokio::test]
    async fn a_stacked_action_requires_an_action_id() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();

        let err = run_stacked_action(
            cwd,
            &json!({"cwd": cwd, "action": "commit", "commitMessage": "no id"}),
        )
        .await
        .expect_err("missing actionId must not silently share the durable `action` row");

        assert!(err.contains("actionId"), "error should name the missing action id: {err}");
    }

    async fn scratch_repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t3-vcs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        cairn::init_repository(&dir).await.unwrap();
        for args in [
            ["config", "user.email", "t@t"],
            ["config", "user.name", "t"],
        ] {
            let out = std::process::Command::new("git")
                .current_dir(&dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        dir
    }

    /// A plain directory is reported as "not a repo" — a state, not an error.
    #[tokio::test]
    async fn a_non_repo_directory_is_reported_not_crashed() {
        let dir = std::env::temp_dir().join(format!("t3-vcs-plain-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(dir.to_str().unwrap()).await;
        assert_eq!(s["isRepo"], json!(false));
        assert_eq!(s["workingTree"]["files"].as_array().unwrap().len(), 0);
        let refs = list_refs(dir.to_str().unwrap(), &json!({})).await;
        assert_eq!(refs["isRepo"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Status comes from cairn: the untracked file shows up with honest zeros,
    /// and no upstream means `remote` is null rather than a synced-looking 0/0.
    #[tokio::test]
    async fn status_reports_the_working_tree_and_a_missing_upstream_honestly() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();

        let snap = status_snapshot(cwd).await;
        assert_eq!(snap["_tag"], "snapshot");
        assert_eq!(snap["local"]["isRepo"], json!(true));
        assert_eq!(snap["remote"], Value::Null, "no upstream is null, not 0/0");

        let s = status(cwd).await;
        assert_eq!(s["hasWorkingTreeChanges"], json!(true), "the untracked file counts: {s}");
        let files = s["workingTree"]["files"].as_array().unwrap();
        assert!(files.iter().any(|f| f["path"] == "a.txt"), "untracked file listed: {files:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_payload_bounds_working_tree_files_for_retained_vcs_frames() {
        let changes: Vec<cairn::FileLines> = (0..5_000)
            .map(|i| cairn::FileLines {
                path: format!("generated/{i:04}/really-long-generated-file-name-{i:04}.txt"),
                insertions: 1,
                deletions: 0,
                binary: false,
            })
            .collect();
        let status = Status {
            branch: Some("main".into()),
            has_origin: true,
            working_tree: cairn::WorkingTree {
                files: changes.iter().map(|c| c.path.clone()).collect(),
                changes,
                insertions: 5_000,
                deletions: 0,
            },
            ..Status::default()
        };

        let local = status_from(&status);
        let files = local["workingTree"]["files"].as_array().unwrap();
        assert!(files.len() <= WORKING_TREE_FILE_LIMIT, "retained VCS frame carried {} per-file rows", files.len());
        assert_eq!(local["workingTree"]["fileCount"], json!(5_000));
        assert_eq!(local["workingTree"]["filesTruncated"], json!(true));
        let retained = json!({"_tag": "localUpdated", "local": local});
        let bytes = serde_json::to_vec(&retained).unwrap().len();
        assert!(bytes < WORKING_TREE_FILE_BYTES_LIMIT + 16 * 1024, "retained localUpdated payload grew to {bytes} bytes");
    }

    /// Branch create/switch and ref listing all cross cairn's screened seam.
    #[tokio::test]
    async fn refs_are_created_switched_and_listed_through_cairn() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        // a commit so HEAD exists and branches can be made
        run_stacked_action(cwd, &json!({"actionId": "a1", "action": "commit", "commitMessage": "init"}))
            .await
            .expect("commit");

        create_ref(cwd, &json!({"refName": "feature/x", "switchRef": true})).await.expect("create");
        let refs = list_refs(cwd, &json!({})).await;
        let names: Vec<&str> =
            refs["refs"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"feature/x"), "created ref is listed: {names:?}");
        let current = refs["refs"].as_array().unwrap().iter().find(|r| r["current"] == json!(true));
        assert_eq!(current.unwrap()["name"], "feature/x", "switched to it");

        // and an injection-shaped ref name is REFUSED by cairn, not executed
        let bad = create_ref(cwd, &json!({"refName": "--upload-pack=touch /tmp/pwn"})).await;
        assert!(bad.is_err(), "an option-shaped branch name must be refused");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #60: a cairn ref enumeration failure is not a valid empty refs list.
    #[test]
    fn list_refs_surfaces_ref_list_failure_instead_of_empty_success() {
        let out = list_refs_payload(
            Err("ref list unavailable: git for-each-ref exploded".into()),
            Ok(Vec::new()),
            None,
            true,
        );
        assert_eq!(out["isRepo"], json!(true), "the repo was detected: {out}");
        assert_eq!(out["statusUnavailable"], json!(true), "the failure must be explicit: {out}");
        assert!(
            out["statusError"].as_str().unwrap_or("").contains("git for-each-ref exploded"),
            "the cairn failure reason must survive: {out}"
        );
        assert!(
            out["refs"].as_array().unwrap().is_empty(),
            "empty refs are only acceptable with the unavailable marker: {out}"
        );
    }

    /// #60: branch ownership is part of the refs contract. If git cannot list
    /// worktrees, returning refs with every `worktreePath` cleared lies to the UI.
    #[test]
    fn list_refs_surfaces_worktree_ownership_failure_instead_of_clearing_paths() {
        let out = list_refs_payload(
            Ok(vec![cairn::Ref {
                name: "feature-x".into(),
                is_current: false,
                commit: "abc123".into(),
            }]),
            Err("worktree ownership unavailable: git worktree list exploded".into()),
            None,
            true,
        );
        assert_eq!(out["isRepo"], json!(true), "the repo was detected: {out}");
        // #258 SHARPENS this test rather than relaxing it. Blanking the refs
        // satisfied "must not be emitted as SAFE refs" only by telling the
        // other lie — a repository with no branches — and it could not say why,
        // because `VcsListRefsResult` had no field for it. It does now, so the
        // real refs are served and the UNSAFETY is stated: ownership unknown,
        // every `worktreePath` null because it is unknown rather than free.
        assert_eq!(
            out["ownershipUnavailable"], json!(true),
            "a failed worktrees() must be reported, not flattened into an empty owner map: {out}"
        );
        assert!(
            out["refsError"].as_str().unwrap_or("").contains("git worktree list exploded"),
            "the worktree failure reason must survive: {out}"
        );
        assert_eq!(
            out["refs"].as_array().unwrap().len(), 1,
            "the refs are real and are still served: {out}"
        );
        for r in out["refs"].as_array().unwrap() {
            assert!(
                r["worktreePath"].is_null(),
                "ownership is unknown, so no ref may claim an owner: {r}"
            );
        }
        assert!(
            out.get("statusUnavailable").is_none(),
            "the marker must live on a field the refs schema carries: {out}"
        );
    }

    /// THE STACKED-ACTION RPC MUST BE ABLE TO FAIL.
    ///
    /// Every phase refusal emitted an `action_failed` FRAME and then returned
    /// `Ok(())`, and `server_main`'s arm answered `Ok(()) => exit_success`. So
    /// `commit_push` into a repo with no remote reported the RPC as SUCCESSFUL:
    /// nothing was pushed and the caller was told it worked. The failure was
    /// visible only to a client that parsed the frame stream — but an Exit
    /// exists precisely so a caller does not have to. Same fail-open family as
    /// #418 (`diff_between` returning an empty diff it could not compute).
    ///
    /// Note what this does NOT change, and why the frames are asserted here
    /// too: `a_stacked_action_speaks_the_contract_progress_protocol` already
    /// proved the `action_failed` frame was correct. The frames were never the
    /// bug. Fixing this by returning `Err` would have DELETED them from the
    /// collecting form, trading a fail-open for a silent loss of the progress a
    /// user already saw — so the verdict travels beside the frames, and this
    /// test pins both at once.
    #[tokio::test]
    async fn a_refused_phase_is_reported_as_a_verdict_not_just_a_frame() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();

        // Commit succeeds, THEN push is refused: there is no remote. This is
        // the case that fails open most dangerously — real work landed, so the
        // repository changed, and the user is told the whole action worked.
        let mut frames = Vec::new();
        let verdict = run_stacked_action_streaming(
            cwd,
            &json!({
                "actionId": "v1", "cwd": cwd,
                "action": "commit_push", "commitMessage": "work that never left the machine",
            }),
            &mut |f| frames.push(f),
            None,
        )
        .await
        .expect("the pipeline RAN — a refused phase is not a pipeline error");

        let (phase, message) = verdict.expect(
            "a refused push MUST come back as a verdict. Ok(None) here is the              fail-open: the RPC exits success and the user is told a push that              never happened worked.",
        );
        assert_eq!(phase, json!("push"), "the verdict must name the phase that refused");
        assert!(!message.is_empty(), "the verdict must carry git's reason");

        // The frames are UNCHANGED by the verdict travelling — same terminal
        // action_failed a progress client already relied on.
        let last = frames.last().expect("frames were still delivered");
        assert_eq!(last["kind"], "action_failed", "{frames:?}");
        assert_eq!(last["phase"], "push");

        // And the commit that DID land is still in the stream, so the verdict
        // did not cost the caller the progress it already earned.
        assert!(
            frames.iter().any(|f| f["kind"] == "phase_started" && f["phase"] == "commit"),
            "the commit phase must still be visible: {frames:?}"
        );

        // CONTROL: a fully successful action still reports NO verdict, or the
        // assertion above would pass for any action at all.
        let mut ok_frames = Vec::new();
        let clean = run_stacked_action_streaming(
            cwd,
            &json!({"actionId": "v2", "cwd": cwd, "action": "commit", "commitMessage": "second"}),
            &mut |f| ok_frames.push(f),
            None,
        )
        .await
        .expect("commit-only runs");
        assert!(clean.is_none(), "a successful action must report no verdict: {clean:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #63: the progress stream speaks the FRONTEND contract — the client
    /// filters on actionId+cwd and errors out if no terminal event arrives.
    #[tokio::test]
    async fn a_stacked_action_speaks_the_contract_progress_protocol() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();

        let frames = run_stacked_action(cwd, &json!({
            "actionId": "c1", "cwd": cwd, "action": "commit", "commitMessage": "first",
        })).await.expect("commit runs");

        let kinds: Vec<&str> = frames.iter().map(|f| f["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["action_started", "phase_started", "action_finished"], "{frames:?}");
        for f in &frames {
            // the client drops any frame missing these
            assert_eq!(f["actionId"], "c1", "every frame carries actionId: {f}");
            assert_eq!(f["cwd"], cwd, "every frame carries cwd: {f}");
            assert_eq!(f["action"], "commit", "every frame carries action: {f}");
        }
        let result = &frames.last().unwrap()["result"];
        assert_eq!(result["commit"]["status"], "created", "{result}");
        assert!(result["commit"]["commitSha"].as_str().is_some_and(|s| !s.is_empty()));
        assert_eq!(result["push"]["status"], "skipped_not_requested");
        assert_eq!(result["toast"]["cta"]["kind"], "none");

        // committing again with nothing to commit is a real STATUS, not an error
        let frames = run_stacked_action(cwd, &json!({
            "actionId": "c2", "cwd": cwd, "action": "commit", "commitMessage": "again",
        })).await.unwrap();
        assert_eq!(frames.last().unwrap()["result"]["commit"]["status"], "skipped_no_changes");

        // a failure is a TERMINAL action_failed frame, never a missing terminal
        let frames = run_stacked_action(cwd, &json!({
            "actionId": "p1", "cwd": cwd, "action": "push",
        })).await.unwrap();
        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_failed", "no remote must fail terminally: {frames:?}");
        assert_eq!(last["phase"], "push");
        assert!(last["message"].as_str().is_some_and(|m| !m.is_empty()));

        // PR with no usable provider is a terminal failure, not a silent skip.
        // (What it must NOT do — fail AFTER committing and pushing — is
        // `a_pr_action_with_no_provider_changes_nothing` below.)
        let frames = run_stacked_action(cwd, &json!({
            "actionId": "r1", "cwd": cwd, "action": "create_pr",
        })).await.unwrap();
        assert_eq!(frames.last().unwrap()["kind"], "action_failed");

        // an action outside the contract vocabulary is refused
        assert!(run_stacked_action(cwd, &json!({"actionId": "x", "action": "teleport"}))
            .await
            .unwrap_err()
            .contains("unsupported"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── #138: the PR phase, against a fake provider ─────────────────────────
    //
    // The provider is the one part of this pipeline that cannot run in a test
    // otherwise; everything else here is a real git repository in a temp dir,
    // so these exercise the actual commit/push/PR ordering rather than a mock
    // of it.

    /// Records what it was asked, and answers however the test says.
    struct FakePrs {
        available: Result<(), String>,
        result: std::sync::Mutex<Result<Value, String>>,
        /// Every `open` call: (head, title, body). Empty = never reached.
        opened: std::sync::Mutex<Vec<(String, String, String)>>,
    }

    impl FakePrs {
        fn ready(result: Result<Value, String>) -> Self {
            Self {
                available: Ok(()),
                result: std::sync::Mutex::new(result),
                opened: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn absent(why: &str) -> Self {
            Self {
                available: Err(why.to_string()),
                result: std::sync::Mutex::new(Err("must not be called".into())),
                opened: std::sync::Mutex::new(Vec::new()),
            }
        }
        fn opens(&self) -> Vec<(String, String, String)> {
            self.opened.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl PullRequestOpener for FakePrs {
        async fn available(&self, _cwd: &str) -> Result<(), String> {
            self.available.clone()
        }
        async fn open(&self, _cwd: &str, head: &str, title: &str, body: &str) -> Result<Value, String> {
            self.opened.lock().unwrap().push((head.into(), title.into(), body.into()));
            self.result.lock().unwrap().clone()
        }
    }

    /// A provider that PARKS inside `available`, so the action is provably
    /// still running while the test inspects what has already been delivered.
    struct BlockingPrs {
        /// Closed by the test to release the action.
        gate: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        /// Set the instant `available` is entered, so the test knows the action
        /// has reached the blocking point rather than merely been spawned.
        entered: std::sync::Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl PullRequestOpener for BlockingPrs {
        async fn available(&self, _cwd: &str) -> Result<(), String> {
            self.entered.notify_waiters();
            if let Some(rx) = self.gate.lock().await.take() {
                let _ = rx.await;
            }
            Ok(())
        }
        async fn open(&self, _cwd: &str, _h: &str, _t: &str, _b: &str) -> Result<Value, String> {
            Ok(json!({ "url": "https://example.invalid/pr/1" }))
        }
    }

    /// PROOF (#423): progress frames are delivered DURING the action.
    ///
    /// The weak version of this test asserts `action_started` arrives "before
    /// the action completes", which a fast action can satisfy by luck even if
    /// every frame is buffered and flushed at the end. This asserts the strong
    /// version: the frame is observed while the action is STILL BLOCKED, and
    /// the test proves the block by checking the action's task has not
    /// finished. Under the old `Vec`-returning shape nothing could be observed
    /// until the whole action was over, so this deadlocks-then-times-out rather
    /// than passing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn progress_frames_arrive_while_the_action_is_still_running() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap().to_string();
        // A committed base so the PR phase is reachable.
        run_stacked_action(&cwd, &json!({
            "actionId": "seed", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();

        let (tx, rx) = tokio::sync::oneshot::channel();
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let prs = std::sync::Arc::new(BlockingPrs {
            gate: tokio::sync::Mutex::new(Some(rx)),
            entered: entered.clone(),
        });

        let seen: std::sync::Arc<std::sync::Mutex<Vec<Value>>> = Default::default();
        let action = {
            let (cwd, prs, seen) = (cwd.clone(), prs.clone(), seen.clone());
            tokio::spawn(async move {
                let mut sink = |f: Value| seen.lock().unwrap().push(f);
                run_stacked_action_streaming_with(
                    &cwd,
                    &json!({ "actionId": "live", "cwd": cwd, "action": "create_pr" }),
                    prs.as_ref(),
                    &mut sink,
                    None,
                )
                .await
            })
        };

        // Wait for the action to REACH the blocking point, rather than sleeping
        // a guessed amount and hoping.
        tokio::time::timeout(std::time::Duration::from_secs(10), entered.notified())
            .await
            .expect("the action never reached the PR precheck");

        // THE ASSERTION. `action_started` must already be in hand even though
        // the action cannot possibly have finished — it is parked in `available`.
        let started = seen
            .lock()
            .unwrap()
            .iter()
            .any(|f| f["kind"] == json!("action_started"));
        assert!(
            started,
            "action_started was not delivered while the action was still blocked —              frames are being buffered until completion, which is exactly #423. Saw: {:?}",
            seen.lock().unwrap()
        );
        assert!(
            !action.is_finished(),
            "the action finished before the assertion, so this proves nothing about              streaming; the gate did not hold it"
        );

        // Release and let it settle, so the test does not leave a task parked.
        let _ = tx.send(());
        let out = tokio::time::timeout(std::time::Duration::from_secs(20), action)
            .await
            .expect("the released action must finish")
            .expect("the action task must not panic");
        out.expect("the action itself must succeed");
        assert!(
            seen.lock().unwrap().iter().any(|f| f["kind"] == json!("action_finished")),
            "the completed action must still emit action_finished"
        );
    }

    /// THE FINDING'S CORE CASE: no provider must change NOTHING.
    ///
    /// `commit_push_pr` is one command to the user. The old code ran the
    /// commit, ran the push, and only then said pull requests were
    /// unsupported — leaving a branch committed and pushed, no PR, and an
    /// `action_failed` on screen. The work was half done in a state they had
    /// to finish by hand while the UI told them it had not worked.
    ///
    /// So this asserts on the REPOSITORY, not just the frames: HEAD must not
    /// have moved and the tree must still be dirty.
    #[tokio::test]
    async fn a_pr_action_with_no_provider_changes_nothing() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        run_stacked_action(cwd, &json!({
            "actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();
        std::fs::write(dir.join("b.txt"), "two\n").unwrap();

        let repo = repo(cwd).await.unwrap();
        let head_before = repo.status().await.unwrap().branch;
        let dirty_before = repo.status().await.unwrap();

        let prs = FakePrs::absent("the GitHub CLI (`gh`) is not installed");
        let frames = run_stacked_action_with(cwd, &json!({
            "actionId": "r", "cwd": cwd, "action": "commit_push_pr", "commitMessage": "feature",
        }), &prs).await.unwrap();

        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_failed", "{frames:?}");
        assert_eq!(last["phase"], "pr", "the phase named is the one that cannot run");
        assert!(
            last["message"].as_str().is_some_and(|m| m.contains("gh")),
            "the message must name what to install: {last}"
        );

        // Nothing ran. No commit phase, no push phase — the failure came first.
        let phases: Vec<&str> = frames
            .iter()
            .filter(|f| f["kind"] == "phase_started")
            .filter_map(|f| f["phase"].as_str())
            .collect();
        assert!(
            phases.is_empty(),
            "no phase may start when the action cannot possibly finish: {phases:?}"
        );
        assert!(prs.opens().is_empty(), "and the provider was never asked to open one");

        // The repository is untouched: same branch, still dirty.
        let after = repo.status().await.unwrap();
        assert_eq!(after.branch, head_before, "the ref must not have moved");
        assert_eq!(
            after.is_default_branch, dirty_before.is_default_branch,
            "no feature branch was created"
        );
        assert!(
            repo.staged().await.ok().flatten().is_none(),
            "nothing was staged, so nothing was committed behind the failure"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `create_pr` alone, with a provider that works: the PR result reaches the
    /// contract's `action_finished`, and the toast carries the link.
    #[tokio::test]
    async fn a_create_pr_action_opens_one_and_returns_its_url() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        run_stacked_action(cwd, &json!({
            "actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();

        let prs = FakePrs::ready(Ok(json!({"status": "created", "url": "https://example.test/pr/1"})));
        let frames = run_stacked_action_with(cwd, &json!({
            "actionId": "r", "cwd": cwd, "action": "create_pr", "commitMessage": "add the thing",
        }), &prs).await.unwrap();

        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_finished", "{frames:?}");
        let result = &last["result"];
        assert_eq!(result["pr"]["status"], "created");
        assert_eq!(result["pr"]["url"], "https://example.test/pr/1");
        // `create_pr` alone must not have committed or pushed anything.
        assert_eq!(result["commit"]["status"], "skipped_not_requested");
        assert_eq!(result["push"]["status"], "skipped_not_requested");
        // The user asked to get their work up for review; hand them the link.
        assert_eq!(result["toast"]["cta"]["kind"], "open_url");
        assert_eq!(result["toast"]["cta"]["url"], "https://example.test/pr/1");

        // The head passed to the provider is the ref the repo is ACTUALLY on,
        // read from the repository rather than taken from the request.
        let opens = prs.opens();
        assert_eq!(opens.len(), 1, "opened exactly once");
        let branch = repo(cwd).await.unwrap().status().await.unwrap().branch.unwrap();
        assert_eq!(opens[0].0, branch, "head is the real current ref");
        assert_eq!(opens[0].1, "add the thing", "the commit subject becomes the title");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A PR that is already open is the user's intent already satisfied, not a
    /// failed action — especially since the commit and push before it worked.
    #[tokio::test]
    async fn an_already_open_pull_request_finishes_rather_than_failing() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        run_stacked_action(cwd, &json!({
            "actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();

        let prs = FakePrs::ready(Ok(json!({"status": "already_open", "url": "https://example.test/pr/9"})));
        let frames = run_stacked_action_with(cwd, &json!({
            "actionId": "r", "cwd": cwd, "action": "create_pr", "commitMessage": "again",
        }), &prs).await.unwrap();

        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_finished", "already-open is not a failure: {frames:?}");
        assert_eq!(last["result"]["pr"]["status"], "already_open");
        assert_eq!(last["result"]["toast"]["title"], "Pull request already open");
        assert_eq!(last["result"]["toast"]["cta"]["url"], "https://example.test/pr/9");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A provider that IS available and then fails is a terminal `action_failed`
    /// naming the pr phase — not a missing terminal frame, which the UI reports
    /// as `VcsActionMissingTerminalEventError`.
    #[tokio::test]
    async fn a_provider_failure_is_a_terminal_failed_frame_naming_the_pr_phase() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        run_stacked_action(cwd, &json!({
            "actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();

        let prs = FakePrs::ready(Err("gh pr create: no upstream configured".into()));
        let frames = run_stacked_action_with(cwd, &json!({
            "actionId": "r", "cwd": cwd, "action": "create_pr", "commitMessage": "x",
        }), &prs).await.unwrap();

        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_failed");
        assert_eq!(last["phase"], "pr");
        assert!(last["message"].as_str().is_some_and(|m| m.contains("upstream")));
        // the pr phase DID start — the provider was reachable, the attempt failed
        assert!(
            frames.iter().any(|f| f["kind"] == "phase_started" && f["phase"] == "pr"),
            "an attempted-and-failed PR is not the same as one that never started: {frames:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #91: `featureBranch` is honoured, so a commit the UI promised was safe
    /// does not land on the default branch.
    #[tokio::test]
    async fn a_feature_branch_action_moves_off_the_default_ref() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        // an initial commit so HEAD exists on the default branch
        run_stacked_action(cwd, &json!({
            "actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init",
        })).await.unwrap();
        let repo = open(cwd).await.unwrap();
        let default_ref = repo.status().await.unwrap().branch.unwrap();

        std::fs::write(dir.join("work.txt"), "new work\n").unwrap();
        let frames = run_stacked_action(cwd, &json!({
            "actionId": "f1", "cwd": cwd, "action": "commit",
            "commitMessage": "risky change", "featureBranch": true,
        })).await.unwrap();

        // the branch phase is announced and the result reports it
        let kinds: Vec<&str> = frames.iter().map(|f| f["kind"].as_str().unwrap()).collect();
        assert!(kinds.contains(&"phase_started"), "{frames:?}");
        let last = frames.last().unwrap();
        assert_eq!(last["kind"], "action_finished", "{frames:?}");
        assert_eq!(last["result"]["branch"]["status"], "created", "a feature ref was made: {last}");

        // the commit is NOT on the default branch
        let now_on = repo.status().await.unwrap().branch.unwrap();
        assert_ne!(now_on, default_ref, "the work moved off {default_ref}");
        assert_eq!(last["result"]["commit"]["status"], "created");

        // and the default branch does not have the file
        repo.switch_to(&default_ref).await.unwrap();
        assert!(!dir.join("work.txt").exists(), "the default branch is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #62: pull and createWorktree answer in the exact contract envelopes.
    #[tokio::test]
    async fn pull_and_create_worktree_match_the_contract_envelopes() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        run_stacked_action(cwd, &json!({"actionId":"a","cwd":cwd,"action":"commit","commitMessage":"init"}))
            .await
            .unwrap();

        // VcsCreateWorktreeResult wraps its worktree
        let base = worktree_base(cwd);
        let made = create_worktree(cwd, &json!({"refName": "wt-x"}), cwd).await.expect("worktree");
        assert!(made.get("worktree").is_some(), "wrapped in `worktree`: {made}");
        assert!(made["worktree"]["path"].as_str().is_some_and(|p| !p.is_empty()));
        assert_eq!(made["worktree"]["refName"], "wt-x");

        // VcsPullResult: no remote here, so pull errors rather than returning a
        // shape the client cannot decode
        assert!(pull(cwd).await.is_err(), "a pull with no remote must not fake a result");

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PROOF (#212): a scoped commit commits ONLY the selected files.
    ///
    /// `--all` re-stages every tracked modification at commit time, so the
    /// frontend's file selection would be advisory: pick `a.txt`, get `b.txt`
    /// too, with nothing in the UI to say so.
    #[tokio::test]
    async fn a_scoped_commit_leaves_unselected_changes_dirty() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        // Two TRACKED files, both dirty.
        std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        run_stacked_action(cwd, &json!({
            "actionId": "base", "cwd": cwd, "action": "commit", "commitMessage": "base",
        })).await.unwrap();
        std::fs::write(dir.join("a.txt"), "one changed\n").unwrap();
        std::fs::write(dir.join("b.txt"), "two changed\n").unwrap();

        let frames = run_stacked_action(cwd, &json!({
            "actionId": "scoped", "cwd": cwd, "action": "commit",
            "commitMessage": "only a", "filePaths": ["a.txt"],
        })).await.expect("scoped commit runs");
        let result = &frames.last().unwrap()["result"];
        assert_eq!(result["commit"]["status"], "created", "{result}");

        // The commit touched a.txt and nothing else…
        let named = std::process::Command::new("git")
            .current_dir(&dir)
            .args(["show", "--name-only", "--format=", "HEAD"])
            .output()
            .unwrap();
        let named = String::from_utf8_lossy(&named.stdout);
        let files: Vec<&str> = named.split_whitespace().collect();
        assert_eq!(files, vec!["a.txt"], "the commit swept in unselected files: {named}");

        // …and b.txt is still dirty, waiting for its own commit.
        let st = status(cwd).await;
        let dirty: Vec<String> = st["workingTree"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["path"].as_str().map(String::from))
            .collect();
        assert!(dirty.iter().any(|p| p.ends_with("b.txt")), "b.txt lost its changes: {dirty:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Commit what is on disk, so a worktree can be branched off a real HEAD.
    async fn commit_all(dir: &std::path::Path, msg: &str) {
        for args in [
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
            vec!["add", "-A"],
            vec!["commit", "-m", msg],
        ] {
            let out = std::process::Command::new("git")
                .current_dir(dir)
                .args(&args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        }
    }

    /// #147: a branch checked out in a linked worktree comes back from
    /// `listRefs` carrying that worktree's real path. `null` for every ref told
    /// the UI nothing owned the branch, so it could not disable unsafe
    /// operations on a ref another pane already held.
    #[tokio::test]
    async fn list_refs_annotates_a_branch_with_the_worktree_that_owns_it() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        commit_all(&dir, "one").await;

        let wt_path = dir.parent().unwrap().join(format!("t3-vcs-wt-{}", uuid::Uuid::new_v4()));
        let repo = crate::vcs::open(cwd).await.unwrap();
        repo.add_worktree(wt_path.to_str().unwrap(), "feature-x").await.unwrap();

        let refs = list_refs(cwd, &json!({})).await;
        let rows = refs["refs"].as_array().unwrap();
        let feature = rows
            .iter()
            .find(|r| r["name"] == json!("feature-x"))
            .unwrap_or_else(|| panic!("feature-x is missing from listRefs: {rows:?}"));
        let owned = feature["worktreePath"].as_str().unwrap_or_else(|| {
            panic!("the worktree branch came back unowned — the UI cannot guard it: {feature:?}")
        });
        assert!(
            std::path::Path::new(owned).ends_with(wt_path.file_name().unwrap()),
            "listRefs reported the wrong worktree for feature-x: {owned}"
        );
        // and the branch nobody checked out elsewhere stays unowned.
        let main = rows.iter().find(|r| r["current"] == json!(true)).unwrap();
        assert_ne!(main["worktreePath"], feature["worktreePath"]);

        let _ = std::fs::remove_dir_all(&wt_path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #230: a repository we found but could not INSPECT must not be reported
    /// as "not a repository". That downgrade hid the dirty/error signal and let
    /// the UI offer to initialize a repo whose state it had merely failed to
    /// read.
    #[tokio::test]
    async fn a_repo_whose_status_fails_is_degraded_not_demoted_to_non_repo() {
        let dir = scratch_repo().await;
        let cwd = dir.to_str().unwrap();
        commit_all(&dir, "one").await;
        // The repo is still DETECTABLE — `rev-parse --show-toplevel` answers, so
        // `Repo::detect` hands back a handle — but the index is corrupt, so the
        // porcelain read of its state fails. That is exactly the shape #230 is
        // about: found, not inspectable.
        std::fs::write(dir.join(".git/index"), b"\x00not a git index\x00").unwrap();

        let s = status(cwd).await;
        assert_eq!(
            s["isRepo"],
            json!(true),
            "an unreadable repository was reported as not a repository: {s}"
        );
        assert_eq!(s["statusUnavailable"], json!(true), "the failure was not surfaced: {s}");
        assert!(
            s["statusError"].as_str().is_some_and(|e| !e.is_empty()),
            "the degraded status carries no reason: {s}"
        );

        let snap = status_snapshot(cwd).await;
        assert_eq!(
            snap["local"]["isRepo"],
            json!(true),
            "the subscribe snapshot still demotes it: {snap}"
        );
        assert_eq!(snap["local"]["statusUnavailable"], json!(true), "{snap}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
