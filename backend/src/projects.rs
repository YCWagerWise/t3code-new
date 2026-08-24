//! The project file surface: browse, search, preview, write.
//!
//! The file picker, markdown file-links, the file browser and ProposedPlanCard
//! writes all sit on these four RPCs, so without them the frontend can show a
//! workspace row and do nothing with it.
//!
//! Everything goes through cairn:
//! * listing/searching skips `.git` and honours the repository's ignore rules
//!   via `Repo::list_files`, so a picker does not offer 40k `node_modules`
//!   paths as if they were the user's code;
//! * reading and writing cross `cairn::{read_file, write_file_atomic}`, which
//!   confine the path to the workspace and make a write all-or-nothing.
//!
//! A raw `std::fs` shortcut here would bypass both the confinement and the
//! atomic write, which is the whole reason the agent's own file tools were
//! moved onto cairn.

use serde_json::{json, Value};

/// Listing/search caps. Truncation is REPORTED, never silent: a picker that
/// quietly shows the first N of a large tree looks like the file is missing.
const MAX_ENTRIES: usize = 20_000;
/// Preview cap. A file past this is truncated and says so.
const MAX_READ_BYTES: usize = 2_000_000;

/// Every path under the workspace, relative, directories included.
///
/// Prefers cairn's `list_files` (git's own view, so ignore rules apply); falls
/// back to a bounded walk when the workspace is not a repository yet, because a
/// user who has not run `git init` still needs a file picker.
async fn entries(root: &std::path::Path) -> Result<(Vec<(String, bool)>, bool), String> {
    if let Some(repo) = crate::vcs::open(&root.to_string_lossy()).await {
        let (files, truncated) = repo
            .list_files()
            .await
            .map_err(|e| format!("cairn workspace listing unavailable: {e}"))?;
        let mut out: Vec<(String, bool)> = Vec::new();
        let mut dirs: std::collections::BTreeSet<String> = Default::default();
        for f in files.iter().take(MAX_ENTRIES) {
            // every ancestor of a tracked file is a real directory
            let mut cur = std::path::Path::new(f);
            while let Some(p) = cur.parent() {
                if p.as_os_str().is_empty() {
                    break;
                }
                dirs.insert(p.to_string_lossy().into_owned());
                cur = p;
            }
            out.push((f.clone(), false));
        }
        out.extend(dirs.into_iter().map(|d| (d, true)));
        let over = files.len() > MAX_ENTRIES;
        return Ok((out, truncated || over));
    }
    Ok(walk(root))
}

/// Bounded walk for a workspace git does not know about. Skips `.git` and the
/// directories that make a picker useless.
fn walk(root: &std::path::Path) -> (Vec<(String, bool)>, bool) {
    const SKIP: &[&str] = &[".git", "node_modules", "target", "dist", ".next", ".venv"];
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_ENTRIES {
                truncated = true;
                return (out, truncated);
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            let path = e.path();
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            out.push((rel.to_string_lossy().into_owned(), is_dir));
            if is_dir {
                stack.push(path);
            }
        }
    }
    (out, truncated)
}

/// The extensions an image picker may offer. Deliberately a list, not a
/// content sniff: the picker runs over a whole tree and reading every file to
/// classify it would make browsing a large repo unusable.
const IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];

fn is_image(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
}

fn entry(path: &str, is_dir: bool) -> Value {
    json!({ "path": path, "kind": if is_dir { "directory" } else { "file" } })
}

/// `projects.listEntries`.
pub async fn list_entries(cwd: &str) -> Result<Value, String> {
    let (found, truncated) = entries(std::path::Path::new(cwd)).await?;
    let mut list: Vec<Value> = found.iter().map(|(p, d)| entry(p, *d)).collect();
    list.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({ "entries": list, "truncated": truncated }))
}

/// `projects.searchEntries` — the file picker's filter.
///
/// An EMPTY query is a bounded browse, not "no results": the picker opens with
/// it and would otherwise look broken. Matching is a case-insensitive subsequence
/// over the path, and a match earlier in the basename ranks higher, which is
/// what makes typing `srvmn` find `src/server_main.rs`.
pub async fn search_entries(cwd: &str, input: &Value) -> Result<Value, String> {
    let query = input.get("query").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
    let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
    let want_kind = input.get("kind").and_then(Value::as_str);
    // The favicon/image pickers ask for images ONLY. Ignoring the filter lets
    // them offer README/source/binary paths as if they were pictures, and the
    // downstream preview or artwork write then fails on a path that was never
    // an image (#93).
    let image_only = input.get("imageOnly").and_then(Value::as_bool).unwrap_or(false);

    let (found, mut truncated) = entries(std::path::Path::new(cwd)).await?;
    let mut scored: Vec<(i64, String, bool)> = Vec::new();
    for (path, is_dir) in found {
        if let Some(k) = want_kind {
            if (k == "directory") != is_dir {
                continue;
            }
        }
        if image_only && (is_dir || !is_image(&path)) {
            continue;
        }
        let score = if query.is_empty() {
            // browse order: shallow paths first, so the picker opens on the
            // top of the tree rather than the alphabetically-first deep file
            -(path.matches('/').count() as i64)
        } else {
            match subsequence_score(&path.to_lowercase(), &query) {
                Some(s) => s,
                None => continue,
            }
        };
        scored.push((score, path, is_dir));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
    if scored.len() > limit {
        truncated = true;
        scored.truncate(limit);
    }
    Ok(json!({
        "entries": scored.iter().map(|(_, p, d)| entry(p, *d)).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

/// Subsequence match with a bonus for contiguous runs and for matching inside
/// the basename. `None` when the query is not a subsequence at all.
fn subsequence_score(haystack: &str, needle: &str) -> Option<i64> {
    let base_at = haystack.rfind('/').map(|i| i + 1).unwrap_or(0);
    let hay: Vec<char> = haystack.chars().collect();
    let mut score = 0i64;
    let mut hi = 0usize;
    let mut last_hit: Option<usize> = None;
    for nc in needle.chars() {
        loop {
            if hi >= hay.len() {
                return None;
            }
            if hay[hi] == nc {
                break;
            }
            hi += 1;
        }
        if Some(hi) == last_hit.map(|l| l + 1) {
            score += 5; // contiguous
        }
        if hi >= base_at {
            score += 3; // in the basename
        }
        score += 1;
        last_hit = Some(hi);
        hi += 1;
    }
    Some(score)
}

/// `projects.readFile` — file preview.
pub async fn read_file(cwd: &str, input: &Value) -> Result<Value, String> {
    let rel = input.get("relativePath").and_then(Value::as_str).ok_or("relativePath is required")?;
    let root = std::path::Path::new(cwd);
    // cairn confines the path; an escape is refused rather than read
    let contents = cairn::read_file(root, rel).map_err(|e| e.to_string())?;
    let byte_length = contents.len();
    let truncated = byte_length > MAX_READ_BYTES;
    let contents = if truncated {
        // Slice on a CHAR boundary, not a byte count (#229). `MAX_READ_BYTES`
        // can land in the middle of a multibyte codepoint, and slicing a
        // `String` there panics — a valid large file (any non-ASCII source,
        // any CJK text) took the backend down instead of returning a preview.
        let mut cap = MAX_READ_BYTES.min(contents.len());
        while cap > 0 && !contents.is_char_boundary(cap) {
            cap -= 1;
        }
        // Prefer a whole final line, but only if that boundary is itself valid.
        let cut = contents[..cap].rfind('\n').unwrap_or(cap);
        contents[..cut].to_string()
    } else {
        contents
    };
    Ok(json!({
        "relativePath": rel,
        "contents": contents,
        // the ORIGINAL length, so a client can tell how much it is not seeing
        "byteLength": byte_length,
        "truncated": truncated,
    }))
}

/// `projects.writeFile`.
///
/// Takes the SAME checkpointed path the agent's `write_file` tool takes, via
/// the same fail-closed discovery:
/// * a git-backed workspace gets `cairn::write_file`, so the save is a
///   checkpoint and participates in turn diff / revert / review history;
/// * a genuine non-repository gets the confined atomic write;
/// * "git could not answer" REFUSES rather than downgrading — a save that
///   silently produces no undoable history, in a UI that promises edits are
///   Cairn-backed, is the failure that discovery exists to prevent.
///
/// Confinement and edit safety are different properties and the frontend needs
/// both: an atomic write into the right directory is still an unreviewable
/// change.
pub async fn write_file(
    pool: &std::sync::Arc<do_storage::DbPool>,
    cwd: &str,
    input: &Value,
) -> Result<Value, String> {
    let rel = input.get("relativePath").and_then(Value::as_str).ok_or("relativePath is required")?;
    let contents = input.get("contents").and_then(Value::as_str).unwrap_or("");
    let root = std::path::Path::new(cwd);
    match crate::tools::discover_stack(pool, root).await {
        cairn::Discovery::Repo(stack) => {
            cairn::write_file(&stack, rel, contents).await.map_err(|e| e.to_string())?;
        }
        cairn::Discovery::NotRepository => cairn::write_file_atomic(root, rel, contents)?,
        cairn::Discovery::Unavailable(why) => {
            return Err(format!(
                "cairn checkpoint substrate unavailable ({why}); refusing unversioned write to {rel}"
            ))
        }
    }
    Ok(json!({ "relativePath": rel }))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t3-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/junk")).unwrap();
        std::fs::write(dir.join("src/server_main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join("README.md"), "# hi\n").unwrap();
        std::fs::write(dir.join("node_modules/junk/big.js"), "noise\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn listing_skips_the_noise_and_reports_kinds() {
        let dir = workspace().await;
        let out = list_entries(dir.to_str().unwrap()).await.unwrap();
        let paths: Vec<&str> =
            out["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
        assert!(paths.contains(&"README.md"), "{paths:?}");
        assert!(paths.contains(&"src/server_main.rs"), "{paths:?}");
        assert!(
            !paths.iter().any(|p| p.starts_with("node_modules")),
            "node_modules is not the user's code: {paths:?}"
        );
        let src = out["entries"].as_array().unwrap().iter().find(|e| e["path"] == "src").unwrap();
        assert_eq!(src["kind"], "directory");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The picker's two modes: an empty query browses, a fuzzy query finds.
    #[tokio::test]
    async fn search_browses_on_empty_and_fuzzy_matches_otherwise() {
        let dir = workspace().await;
        let cwd = dir.to_str().unwrap();

        let browse = search_entries(cwd, &json!({"query": "", "limit": 50}))
            .await
            .unwrap();
        assert!(
            !browse["entries"].as_array().unwrap().is_empty(),
            "an empty query browses rather than returning nothing"
        );

        let hit = search_entries(cwd, &json!({"query": "srvmain", "limit": 10}))
            .await
            .unwrap();
        let paths: Vec<&str> =
            hit["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
        assert_eq!(paths.first(), Some(&"src/server_main.rs"), "fuzzy subsequence: {paths:?}");

        let none = search_entries(cwd, &json!({"query": "zzzznope", "limit": 10}))
            .await
            .unwrap();
        assert!(none["entries"].as_array().unwrap().is_empty());

        // limit truncates AND says so
        let capped = search_entries(cwd, &json!({"query": "", "limit": 1}))
            .await
            .unwrap();
        assert_eq!(capped["entries"].as_array().unwrap().len(), 1);
        assert_eq!(capped["truncated"], json!(true), "truncation is reported");

        // kind filter
        let dirs = search_entries(cwd, &json!({"query": "", "limit": 50, "kind": "directory"}))
            .await
            .unwrap();
        assert!(dirs["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["kind"] == "directory"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #93: an image picker gets images, not README/source paths.
    #[tokio::test]
    async fn image_only_search_returns_only_images() {
        let dir = workspace().await;
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/logo.PNG"), "x").unwrap();
        std::fs::write(dir.join("assets/icon.svg"), "x").unwrap();
        std::fs::write(dir.join("assets/notes.txt"), "x").unwrap();
        let cwd = dir.to_str().unwrap();

        let out = search_entries(cwd, &json!({"query": "", "limit": 50, "imageOnly": true}))
            .await
            .unwrap();
        let paths: Vec<&str> =
            out["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
        assert!(paths.contains(&"assets/logo.PNG"), "case-insensitive extension: {paths:?}");
        assert!(paths.contains(&"assets/icon.svg"), "{paths:?}");
        assert!(!paths.iter().any(|p| p.ends_with(".txt")), "no text files: {paths:?}");
        assert!(!paths.contains(&"README.md"), "{paths:?}");
        assert!(!paths.contains(&"assets"), "no directories in an image picker: {paths:?}");
        for e in out["entries"].as_array().unwrap() {
            assert_eq!(e["kind"], "file");
        }

        // without the flag the same search still returns everything
        let all = search_entries(cwd, &json!({"query": "", "limit": 50}))
            .await
            .unwrap();
        let all_paths: Vec<&str> =
            all["entries"].as_array().unwrap().iter().map(|e| e["path"].as_str().unwrap()).collect();
        assert!(all_paths.contains(&"README.md"), "{all_paths:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Read and write are confined and honest about size.
    #[tokio::test]
    async fn read_and_write_are_confined_to_the_workspace() {
        let dir = workspace().await;
        let cwd = dir.to_str().unwrap();

        let r = read_file(cwd, &json!({"relativePath": "README.md"})).await.unwrap();
        assert_eq!(r["contents"], "# hi\n");
        assert_eq!(r["byteLength"], json!(5));
        assert_eq!(r["truncated"], json!(false));

        // a path escaping the workspace is REFUSED, both ways
        assert!(read_file(cwd, &json!({"relativePath": "../../../etc/passwd"})).await.is_err());
        let pool = do_storage::DbPool::new(dir.join(".t3code-agent"));
        assert!(write_file(&pool, cwd, &json!({"relativePath": "../escape.txt", "contents": "x"}))
            .await
            .is_err());

        // writing creates directories and lands atomically
        write_file(&pool, cwd, &json!({"relativePath": "docs/new/note.md", "contents": "body\n"}))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("docs/new/note.md")).unwrap(), "body\n");
        let strays: Vec<_> = std::fs::read_dir(dir.join("docs/new"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("cairn-"))
            .collect();
        assert!(strays.is_empty(), "no temp file survived: {strays:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #85: a save into a REPO-backed workspace is checkpointed, exactly like an
    /// agent write. Confinement alone is not edit safety — an atomic write into
    /// the right directory is still an unreviewable, unrevertable change.
    #[tokio::test]
    async fn a_repo_backed_save_creates_a_cairn_checkpoint() {
        let dir = std::env::temp_dir().join(format!("t3-proj-cp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        cairn::init_repository(&dir).await.unwrap();
        let cwd = dir.to_str().unwrap();
        let pool = do_storage::DbPool::new(dir.join(".t3code-agent"));

        write_file(&pool, cwd, &json!({"relativePath": "edited.md", "contents": "from the UI\n"}))
            .await
            .expect("save succeeds");
        assert_eq!(std::fs::read_to_string(dir.join("edited.md")).unwrap(), "from the UI\n");

        // the checkpoint stack recorded it, so the save can be diffed/reverted
        let stack = match crate::tools::discover_stack(&pool, &dir).await {
            cairn::Discovery::Repo(s) => s,
            other => panic!("expected a repo-backed stack, got {other:?}"),
        };
        let history = stack.list().await.unwrap();
        assert!(!history.is_empty(), "the UI save left a checkpoint behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #111: a git-backed workspace whose cairn/git listing fails must fail
    /// closed. Falling back to the raw filesystem walk re-owns workspace truth
    /// in product code and leaks ignored/generated paths as if cairn had
    /// approved them.
    #[tokio::test]
    async fn git_backed_listing_failure_does_not_raw_walk() {
        let dir = std::env::temp_dir().join(format!("t3-proj-bad-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("node_modules/junk")).unwrap();
        std::fs::write(dir.join("node_modules/junk/generated.js"), "noise\n").unwrap();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&dir)
            .status()
            .unwrap();
        std::fs::remove_file(dir.join(".git/index")).ok();
        std::fs::create_dir_all(dir.join(".git/index")).unwrap();

        let err = list_entries(dir.to_str().unwrap())
            .await
            .expect_err("git-backed list failure must not raw-walk around cairn");
        assert!(
            err.contains("cairn workspace listing unavailable"),
            "error names the failing substrate: {err}"
        );
        let err = search_entries(dir.to_str().unwrap(), &json!({"query": "generated", "limit": 50}))
            .await
            .expect_err("git-backed search failure must not raw-walk around cairn");
        assert!(
            err.contains("cairn workspace listing unavailable"),
            "search error names the failing substrate: {err}"
        );
        let err = search_contents(dir.to_str().unwrap(), &json!({"query": "noise", "limit": 50}))
            .await
            .expect_err("content search must not raw-walk around cairn");
        assert!(
            err.contains("cairn workspace listing unavailable"),
            "content search error names the failing substrate: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PROOF (#229): a large VALID file whose byte cap falls inside a multibyte
    /// codepoint returns a truncated preview instead of panicking the backend.
    #[tokio::test]
    async fn a_large_multibyte_file_previews_instead_of_panicking() {
        let dir = workspace().await;
        let cwd = dir.to_str().unwrap();

        // "。" is 3 bytes, so the 2,000,000-byte cap cannot land on a boundary.
        let unit = "。";
        let repeats = (MAX_READ_BYTES / unit.len()) + 1000;
        let body: String = unit.repeat(repeats);
        assert!(body.len() > MAX_READ_BYTES);
        assert!(!body.is_char_boundary(MAX_READ_BYTES), "the cap must split a codepoint");
        std::fs::write(dir.join("big.txt"), &body).unwrap();

        let r = read_file(cwd, &json!({"relativePath": "big.txt"})).await.unwrap();
        assert_eq!(r["truncated"], json!(true));
        assert_eq!(r["byteLength"], json!(body.len()), "the ORIGINAL length is reported");
        let preview = r["contents"].as_str().unwrap();
        assert!(!preview.is_empty(), "a truncated preview is still a preview");
        assert!(preview.len() <= MAX_READ_BYTES);
        assert!(body.starts_with(preview), "the preview is a prefix of the file");
    }
}

// ── filesystem.browse ────────────────────────────────────────────────────────

/// Directory completion for a path input (the "where should this project live"
/// picker), NOT a project file listing.
///
/// This one deliberately reaches outside the workspace: its whole job is
/// choosing a directory that is not a project yet, so confining it to the
/// current root would make "add an existing folder" impossible. What it will
/// not do is read files or follow a partial path into somewhere unreadable —
/// it lists DIRECTORIES under an existing parent, and says which failure it
/// hit so the UI can explain itself (#72).
pub fn browse(input: &Value, default_cwd: &str) -> Result<Value, (String, String)> {
    let partial = input.get("partialPath").and_then(Value::as_str).unwrap_or("");
    let cwd = input.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(default_cwd);
    if partial.contains('\\') || partial.chars().nth(1) == Some(':') {
        return Err((
            "windows_path_unsupported".into(),
            "Windows-style paths are not supported by this environment.".into(),
        ));
    }

    // `~` and relative inputs resolve the way a shell would, so what the user
    // types means what they expect.
    let expanded = if let Some(rest) = partial.strip_prefix('~') {
        match std::env::var("HOME") {
            Ok(home) => format!("{home}{rest}"),
            Err(_) => partial.to_string(),
        }
    } else {
        partial.to_string()
    };
    let candidate = if expanded.starts_with('/') {
        std::path::PathBuf::from(&expanded)
    } else {
        std::path::Path::new(cwd).join(&expanded)
    };

    // A trailing separator means "inside this directory"; anything else means
    // "complete this last segment within its parent".
    let (parent, prefix) = if expanded.ends_with('/') || candidate.is_dir() {
        (candidate.clone(), String::new())
    } else {
        (
            candidate.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| candidate.clone()),
            candidate
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
    };

    let read = std::fs::read_dir(&parent).map_err(|e| {
        ("read_directory_failed".to_string(), format!("Cannot read {}: {e}", parent.display()))
    })?;
    let mut entries: Vec<Value> = Vec::new();
    for dirent in read.flatten() {
        let name = dirent.file_name().to_string_lossy().into_owned();
        // Directories only: this picker chooses a place, not a file. Hidden
        // entries appear only once the user types the dot, the way a shell does.
        if !dirent.path().is_dir() || (name.starts_with('.') && !prefix.starts_with('.')) {
            continue;
        }
        if !prefix.is_empty() && !name.starts_with(&prefix) {
            continue;
        }
        entries.push(json!({ "name": name, "fullPath": dirent.path().to_string_lossy() }));
    }
    entries.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    entries.truncate(500);
    Ok(json!({ "parentPath": parent.to_string_lossy(), "entries": entries }))
}

// ── shell.openInEditor ───────────────────────────────────────────────────────

/// The editor commands this runtime knows, in the contract's `EditorId`
/// vocabulary. Kept in the same order the contract lists them, and the FIRST
/// command that exists on PATH wins.
fn editor_commands(editor: &str) -> &'static [&'static str] {
    match editor {
        "cursor" => &["cursor"],
        "trae" => &["trae"],
        "kiro" => &["kiro"],
        "vscode" => &["code"],
        "vscode-insiders" => &["code-insiders"],
        "vscodium" => &["codium"],
        "zed" => &["zed", "zeditor"],
        "antigravity" => &["agy"],
        "idea" => &["idea"],
        "aqua" => &["aqua"],
        "clion" => &["clion"],
        "datagrip" => &["datagrip"],
        "dataspell" => &["dataspell"],
        "goland" => &["goland"],
        "phpstorm" => &["phpstorm"],
        "pycharm" => &["pycharm"],
        "rider" => &["rider"],
        "rubymine" => &["rubymine"],
        "rustrover" => &["rustrover"],
        "webstorm" => &["webstorm"],
        "windsurf" => &["windsurf"],
        "xcode" => &["xed"],
        "sublime" => &["subl"],
        "textmate" => &["mate"],
        "emacs" => &["emacs"],
        "vim" => &["vim"],
        "neovim" => &["nvim"],
        _ => &[],
    }
}

fn on_path(binary: &str) -> bool {
    if binary.contains('/') {
        return std::path::Path::new(binary).exists();
    }
    std::env::var("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|d| d.join(binary).exists()))
        .unwrap_or(false)
}

/// Launch an editor on a directory.
///
/// The error distinguishes "this environment has no such editor installed" from
/// "the launch itself failed" — a user who is told only "could not open" cannot
/// tell whether to install something or to look at their config.
pub fn open_in_editor(input: &Value, default_cwd: &str) -> Result<(), String> {
    let cwd = input.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(default_cwd);
    let editor = input.get("editor").and_then(Value::as_str).unwrap_or("");
    let candidates = editor_commands(editor);
    if candidates.is_empty() {
        return Err(format!("unknown editor \"{editor}\""));
    }
    let Some(binary) = candidates.iter().find(|c| on_path(c)) else {
        return Err(format!(
            "{editor} is not installed in this environment (tried: {})",
            candidates.join(", ")
        ));
    };
    std::process::Command::new(binary)
        .arg(cwd)
        // Detached: the editor outlives this request, and its output is not ours.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch {binary}: {e}"))
}

// ── projects.searchContents ──────────────────────────────────────────────────

/// Cap on files opened for one content search. Truncation is REPORTED.
const MAX_SEARCH_FILES: usize = 5_000;
/// Skip anything bigger than this: a match inside a 10MB minified bundle is not
/// what a code search is for, and reading them makes the search unusable.
const MAX_SEARCH_FILE_BYTES: u64 = 1_500_000;

/// Content search across the project, honouring the contract's options.
///
/// The options are not decoration: `caseSensitive`, `wholeWord` and `useRegex`
/// each change which lines match, and a UI that offers the toggles while the
/// backend ignores them is lying about its own results. An INVALID regex does
/// not fail the request — it falls back to a literal search and reports
/// `regexFallbackError`, which is what the contract's optional field is for.
pub async fn search_contents(cwd: &str, input: &Value) -> Result<Value, String> {
    let query = input.get("query").and_then(Value::as_str).unwrap_or("");
    if query.is_empty() {
        return Err("query is required".into());
    }
    let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(100).min(1_000) as usize;
    let case_sensitive = input.get("caseSensitive").and_then(Value::as_bool).unwrap_or(false);
    let whole_word = input.get("wholeWord").and_then(Value::as_bool).unwrap_or(false);
    let use_regex = input.get("useRegex").and_then(Value::as_bool).unwrap_or(false);

    // A regex the user is still typing is normal; refusing the whole search for
    // it would make the toggle unusable. Fall back to literal and SAY so.
    let (matcher, regex_fallback_error) = if use_regex {
        match Matcher::regex(query, case_sensitive, whole_word) {
            Ok(m) => (m, None),
            Err(e) => (Matcher::literal(query, case_sensitive, whole_word), Some(e)),
        }
    } else {
        (Matcher::literal(query, case_sensitive, whole_word), None)
    };

    let root = std::path::Path::new(cwd);
    let (all, mut truncated) = entries(root).await?;
    let mut matches: Vec<Value> = Vec::new();
    let mut opened = 0usize;
    for (rel, is_dir) in all {
        if is_dir {
            continue;
        }
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        if opened >= MAX_SEARCH_FILES {
            truncated = true;
            break;
        }
        let full = root.join(&rel);
        if std::fs::metadata(&full).map(|m| m.len() > MAX_SEARCH_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        // cairn confines the read to the workspace; a path that escapes is
        // skipped rather than followed.
        let Ok(contents) = cairn::read_file(root, &rel) else { continue };
        opened += 1;
        for (i, line) in contents.lines().enumerate() {
            let ranges = matcher.ranges(line);
            if ranges.is_empty() {
                continue;
            }
            matches.push(json!({
                "path": rel,
                "lineNumber": i + 1,
                "lineContent": line,
                "matchRanges": ranges
                    .iter()
                    .map(|(s, e)| json!({ "start": s, "end": e }))
                    .collect::<Vec<_>>(),
            }));
            if matches.len() >= limit {
                truncated = true;
                break;
            }
        }
    }

    let mut out = json!({ "matches": matches, "truncated": truncated });
    if let Some(e) = regex_fallback_error {
        out["regexFallbackError"] = json!(e);
    }
    Ok(out)
}

/// How one line is tested. Deliberately tiny: a hand-rolled literal scan plus a
/// minimal regex over the standard library would be worse than either honest
/// option, so `useRegex` compiles a real regex and everything else is a literal
/// scan with explicit case and word-boundary rules.
enum Matcher {
    Literal { needle: String, case_sensitive: bool, whole_word: bool },
    Regex(regex::Regex),
}

impl Matcher {
    fn literal(query: &str, case_sensitive: bool, whole_word: bool) -> Self {
        Matcher::Literal {
            needle: if case_sensitive { query.to_string() } else { query.to_lowercase() },
            case_sensitive,
            whole_word,
        }
    }

    fn regex(query: &str, case_sensitive: bool, whole_word: bool) -> Result<Self, String> {
        let pattern = if whole_word { format!(r"\b(?:{query})\b") } else { query.to_string() };
        regex::RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .build()
            .map(Matcher::Regex)
            .map_err(|e| e.to_string())
    }

    /// Byte ranges of every match on this line.
    fn ranges(&self, line: &str) -> Vec<(usize, usize)> {
        match self {
            Matcher::Regex(re) => re.find_iter(line).map(|m| (m.start(), m.end())).collect(),
            Matcher::Literal { needle, case_sensitive, whole_word } => {
                let hay = if *case_sensitive { line.to_string() } else { line.to_lowercase() };
                let mut out = Vec::new();
                let mut from = 0usize;
                while let Some(rel) = hay[from..].find(needle.as_str()) {
                    let start = from + rel;
                    let end = start + needle.len();
                    let boundary_ok = !*whole_word || {
                        let before = hay[..start].chars().next_back();
                        let after = hay[end..].chars().next();
                        let wordish = |c: char| c.is_alphanumeric() || c == '_';
                        !before.map(wordish).unwrap_or(false) && !after.map(wordish).unwrap_or(false)
                    };
                    if boundary_ok {
                        out.push((start, end));
                    }
                    from = end.max(start + 1);
                    if from >= hay.len() {
                        break;
                    }
                }
                out
            }
        }
    }

}
