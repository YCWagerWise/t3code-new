//! The DiffPanel's data, over Cairn.
//!
//! Two RPCs the frontend review surface lives on:
//! * `review.getDiffPreview` — the diff sources a user can look at: what is
//!   uncommitted right now, and what this branch did relative to its base.
//! * `review.getDiffFileContents` — the old/new sides of ONE file, so the panel
//!   can render a side-by-side instead of re-parsing a unified patch.
//!
//! Both go through `cairn::Repo`, so the panel reads the same screened git the
//! agent's own edits are checkpointed through. A file's contents at a revision
//! come from `git show`, never from reading the worktree and hoping it still
//! matches the revision that was asked for.

use serde_json::{json, Value};

use crate::vcs;

/// A stable-enough identity for a diff body, so the client can tell "same diff"
/// from "changed" without holding the whole string. FNV-1a over the bytes.
fn diff_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// git's own cap. A diff past this is TRUNCATED and says so — a panel that
/// silently shows a partial patch invites a review of changes nobody saw.
const MAX_DIFF_BYTES: usize = 400_000;

fn source(
    id: &str,
    kind: &str,
    title: &str,
    base: Option<&str>,
    head: Option<&str>,
    diff: String,
) -> Value {
    let truncated = diff.len() > MAX_DIFF_BYTES;
    let diff = if truncated {
        // cut on a line boundary so the client never renders half a hunk header
        let cut = diff[..MAX_DIFF_BYTES].rfind('\n').unwrap_or(MAX_DIFF_BYTES);
        diff[..cut].to_string()
    } else {
        diff
    };
    json!({
        "id": id,
        "kind": kind,
        "title": title,
        "baseRef": base,
        "headRef": head,
        "diffHash": diff_hash(&diff),
        "diff": diff,
        "truncated": truncated,
    })
}

/// `review.getDiffPreview`.
///
/// "No changes" and "we could not work out what changed" MUST NOT render the
/// same (#154). This used to swallow every git failure into `sources: []` — a
/// panel that says "nothing to review" while the safe-diff seam was actually
/// broken, which is the one direction a review surface may never be wrong in.
/// A failure is now an RPC error, which the contract already has a channel for
/// (`ReviewDiffPreviewError = VcsError | GitCommandError`).
///
/// The one legitimate empty: a directory that is not a repository has no diff
/// sources, and that IS "nothing to review".
pub async fn diff_preview(
    cwd: &str,
    input: &Value,
    generated_at: &str,
) -> Result<Value, String> {
    let Some(repo) = vcs::open(cwd).await else {
        return Ok(json!({"cwd": cwd, "generatedAt": generated_at, "sources": []}));
    };
    let ignore_ws = input.get("ignoreWhitespace").and_then(Value::as_bool).unwrap_or(false);
    let status = repo
        .status()
        .await
        .map_err(|e| format!("could not read repository status in {cwd}: {e}"))?;
    let head = status.branch.clone();

    let mut sources = Vec::new();

    // 1. the working tree: HEAD vs what is on disk right now. An empty `to`
    //    means "the worktree" to cairn, which writes a temp tree — so this
    //    includes staged AND unstaged edits, which is what a reviewer means by
    //    "what has changed".
    // NOT `unwrap_or_default()`: an empty string here means "no uncommitted
    // changes", and a failed diff must never be able to claim that.
    let working = repo
        .diff("HEAD", "", ignore_ws)
        .await
        .map_err(|e| format!("could not diff the working tree against HEAD: {e}"))?;
    if !working.trim().is_empty() {
        sources.push(source(
            "working-tree",
            "working-tree",
            "Uncommitted changes",
            Some("HEAD"),
            head.as_deref(),
            working,
        ));
    }

    // 2. the branch range: what this branch did that its base does not have.
    //    Only when there IS a base and we are not standing on it — a range
    //    against yourself is an empty panel that looks like a bug.
    let base = input
        .get("baseRef")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| status.default_branch.clone());
    if let Some(base) = base {
        if !status.is_default_branch && head.as_deref() != Some(base.as_str()) {
            // A range that FAILS is reported, not skipped — a silently absent
            // branch-range source reads as "this branch changed nothing".
            let range = repo
                .range(&base)
                .await
                .map_err(|e| format!("could not diff {base}..HEAD: {e}"))?;
            {
                if !range.diff_patch.trim().is_empty() {
                    let mut s = source(
                        "branch-range",
                        "branch-range",
                        &format!("{base}..{}", head.clone().unwrap_or_else(|| "HEAD".into())),
                        Some(&base),
                        head.as_deref(),
                        range.diff_patch,
                    );
                    // cairn already capped the patch; carry ITS verdict rather
                    // than re-deriving one from a length we did not measure.
                    if range.truncated {
                        s["truncated"] = json!(true);
                    }
                    sources.push(s);
                }
            }
        }
    }

    Ok(json!({ "cwd": cwd, "generatedAt": generated_at, "sources": sources }))
}

/// `review.getDiffFileContents` — the two sides of one file.
///
/// Two rules this has to get right, and both are ways to LIE to a reviewer:
///
/// 1. A branch-range source reads BOTH sides from refs. Reading the new side
///    from the live worktree while the panel labels it "the feature branch"
///    shows the reviewer their uncommitted local edits as if they were the
///    branch's content.
/// 2. An empty string is not an error sentinel. A file that genuinely IS empty
///    and a file that could not be read (missing at that rev, outside the
///    workspace, denied) must not render identically — the second one silently
///    shows a whole file as added or deleted.
pub async fn diff_file_contents(cwd: &str, input: &Value) -> Result<Value, String> {
    let repo = vcs::open(cwd).await.ok_or("not a git repository")?;
    let change = input.get("changeType").and_then(Value::as_str).unwrap_or("change");
    let old_path = input.get("oldPath").and_then(Value::as_str).unwrap_or("");
    let new_path = input.get("newPath").and_then(Value::as_str).unwrap_or("");
    let source_kind = input.get("sourceKind").and_then(Value::as_str).unwrap_or("working-tree");

    let base_ref = input
        .get("baseRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    let head_ref = input
        .get("headRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // Read a blob at a revision. `None` = the path does not exist there, which
    // is only legitimate for the side an add/delete does not have.
    let at_rev = |rev: String, path: String| {
        let repo = &repo;
        async move {
            repo.show(&rev, &path).await.map_err(|e| format!("read {path}@{rev}: {e}"))
        }
    };

    let old_contents = if change == "new" {
        // an added file has no old side, by definition
        String::new()
    } else {
        at_rev(base_ref.to_string(), old_path.to_string())
            .await?
            .ok_or_else(|| format!("\"{old_path}\" does not exist at {base_ref}"))?
    };

    let new_contents = if change == "deleted" {
        String::new()
    } else if source_kind == "branch-range" {
        // BOTH sides come from refs here — never the worktree.
        let head = head_ref.ok_or("a branch-range diff needs headRef")?;
        at_rev(head.to_string(), new_path.to_string())
            .await?
            .ok_or_else(|| format!("\"{new_path}\" does not exist at {head}"))?
    } else {
        // working tree: the file on disk, through cairn's confined reader so a
        // path escaping the workspace is REFUSED rather than read as empty.
        cairn::read_file(repo.root(), new_path).map_err(|e| format!("read {new_path}: {e}"))?
    };

    Ok(json!({ "oldContents": old_contents, "newContents": new_contents }))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn repo_with_a_commit() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t3-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        cairn::init_repository(&dir).await.unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        vcs::run_stacked_action(
            &cwd,
            &json!({"actionId": "i", "cwd": cwd, "action": "commit", "commitMessage": "init"}),
        )
        .await
        .unwrap();
        dir
    }

    /// Every file under `root`, recursively — used to empty the object database
    /// without removing the directory that marks the place as a repository.
    fn walkdir(root: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    /// PROOF (#154): a repository we cannot read is an ERROR, not "no changes".
    ///
    /// The distinction is the whole point of a review panel: "nothing changed"
    /// and "the safe-diff seam could not tell you what changed" must never
    /// render the same, and only one of them is safe to act on. Here HEAD is
    /// destroyed after the repo is built, so `status`/`diff` fail on a directory
    /// that still looks like a repository.
    #[tokio::test]
    async fn an_unreadable_repository_errors_instead_of_reporting_no_changes() {
        let dir = repo_with_a_commit().await;
        // Empty the object database but KEEP the directory. Removing
        // `.git/objects` outright makes git stop recognising the directory as a
        // repository at all — which lands on the legitimate "nothing to review"
        // path, not on a failure. Deleting only the object FILES leaves
        // `rev-parse --is-inside-work-tree` true while every command that needs
        // HEAD dies with `fatal: bad object HEAD`. That is the shape of a real
        // broken repo, and it is the one this test needs.
        for entry in walkdir(&dir.join(".git").join("objects")) {
            let _ = std::fs::remove_file(entry);
        }

        let out = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z").await;
        match out {
            Err(e) => assert!(!e.is_empty(), "the failure names what went wrong"),
            Ok(v) => panic!("a broken repo must not report a clean preview: {v}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory that is not a repository at all is the ONE legitimate empty:
    /// there is genuinely nothing to review, and that is a state, not a failure.
    #[tokio::test]
    async fn a_plain_directory_is_an_empty_preview_not_an_error() {
        let dir = std::env::temp_dir().join(format!("review-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z")
            .await
            .expect("not-a-repo is a state, not an error");
        assert_eq!(out["sources"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A clean tree has no sources — an EMPTY list, not a fake empty diff.
    #[tokio::test]
    async fn a_clean_tree_reports_no_sources() {
        let dir = repo_with_a_commit().await;
        let out = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z")
            .await
            .expect("a readable repo previews");
        assert_eq!(out["sources"].as_array().unwrap().len(), 0, "{out}");
        assert_eq!(out["cwd"], dir.to_string_lossy().as_ref());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An edit shows up as a working-tree source with a real patch.
    #[tokio::test]
    async fn an_uncommitted_edit_is_a_working_tree_source() {
        let dir = repo_with_a_commit().await;
        std::fs::write(dir.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        let out = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z")
            .await
            .expect("a readable repo previews");

        let sources = out["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 1, "one source: {out}");
        let s = &sources[0];
        assert_eq!(s["kind"], "working-tree");
        assert_eq!(s["baseRef"], "HEAD");
        assert_eq!(s["truncated"], json!(false));
        let diff = s["diff"].as_str().unwrap();
        assert!(diff.contains("a.txt") && diff.contains("+TWO"), "a real patch: {diff}");
        assert!(!s["diffHash"].as_str().unwrap().is_empty());

        // the hash tracks the content
        let again = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z")
            .await
            .expect("previews");
        assert_eq!(again["sources"][0]["diffHash"], s["diffHash"], "stable for the same diff");
        std::fs::write(dir.join("a.txt"), "one\nTHREE\n").unwrap();
        let changed = diff_preview(dir.to_str().unwrap(), &json!({}), "2026-08-19T00:00:00.000Z")
            .await
            .expect("previews");
        assert_ne!(changed["sources"][0]["diffHash"], s["diffHash"], "moves when the diff does");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Both sides of a file, with the missing side of an add/delete EMPTY
    /// rather than the other side's text.
    #[tokio::test]
    async fn file_contents_give_both_sides_and_respect_the_change_type() {
        let dir = repo_with_a_commit().await;
        std::fs::write(dir.join("a.txt"), "one\nTWO\n").unwrap();
        let cwd = dir.to_str().unwrap();

        let c = diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "change",
            "baseRef": "HEAD", "headRef": null, "oldPath": "a.txt", "newPath": "a.txt",
        })).await.unwrap();
        assert_eq!(c["oldContents"], "one\ntwo\n", "old side comes from the revision");
        assert_eq!(c["newContents"], "one\nTWO\n", "new side is the worktree file");

        // a NEW file has no old side
        std::fs::write(dir.join("b.txt"), "fresh\n").unwrap();
        let c = diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "new",
            "baseRef": "HEAD", "headRef": null, "oldPath": "b.txt", "newPath": "b.txt",
        })).await.unwrap();
        assert_eq!(c["oldContents"], "", "a new file has no old side");
        assert_eq!(c["newContents"], "fresh\n");

        // a DELETED file has no new side
        let c = diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "deleted",
            "baseRef": "HEAD", "headRef": null, "oldPath": "a.txt", "newPath": "a.txt",
        })).await.unwrap();
        assert_eq!(c["oldContents"], "one\ntwo\n");
        assert_eq!(c["newContents"], "", "a deleted file has no new side");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #75: a branch-range source reads BOTH sides from refs. Showing the local
    /// worktree as "the feature branch" is a lie a reviewer cannot detect.
    #[tokio::test]
    async fn a_branch_range_reads_both_sides_from_refs_not_the_worktree() {
        let dir = repo_with_a_commit().await;
        let cwd = dir.to_string_lossy().into_owned();

        // a feature branch with its own committed content
        let repo = vcs::open(&cwd).await.unwrap();
        repo.create_branch("feature", None).await.unwrap();
        repo.switch_to("feature").await.unwrap();
        std::fs::write(dir.join("a.txt"), "one\nFEATURE\n").unwrap();
        vcs::run_stacked_action(&cwd, &json!({
            "actionId": "f", "cwd": cwd, "action": "commit", "commitMessage": "feature work",
        })).await.unwrap();

        // now dirty the WORKTREE with something neither ref contains
        std::fs::write(dir.join("a.txt"), "one\nLOCAL-UNCOMMITTED\n").unwrap();

        let c = diff_file_contents(&cwd, &json!({
            "cwd": cwd, "sourceKind": "branch-range", "changeType": "change",
            "baseRef": "master", "headRef": "feature", "oldPath": "a.txt", "newPath": "a.txt",
        })).await;
        // master may be named main; try the other name if the first failed
        let c = match c {
            Ok(v) => v,
            Err(_) => diff_file_contents(&cwd, &json!({
                "cwd": cwd, "sourceKind": "branch-range", "changeType": "change",
                "baseRef": "main", "headRef": "feature", "oldPath": "a.txt", "newPath": "a.txt",
            })).await.expect("branch-range resolves"),
        };
        assert_eq!(c["oldContents"], "one\ntwo\n", "old side is the BASE ref");
        assert_eq!(
            c["newContents"], "one\nFEATURE\n",
            "new side is the HEAD REF, not the dirty worktree: {c}"
        );
        assert!(
            !c["newContents"].as_str().unwrap().contains("LOCAL-UNCOMMITTED"),
            "the worktree must not masquerade as the branch"
        );

        // a branch-range request with no headRef is an ERROR, not a worktree read
        assert!(diff_file_contents(&cwd, &json!({
            "cwd": cwd, "sourceKind": "branch-range", "changeType": "change",
            "baseRef": "HEAD", "headRef": null, "oldPath": "a.txt", "newPath": "a.txt",
        })).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #75: an unreadable side is an ERROR. Empty string as an error sentinel
    /// renders a missing file as a whole-file add/delete.
    #[tokio::test]
    async fn an_unreadable_side_errors_instead_of_returning_empty() {
        let dir = repo_with_a_commit().await;
        let cwd = dir.to_str().unwrap();

        // a path that does not exist at the base revision
        let e = diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "change",
            "baseRef": "HEAD", "headRef": null, "oldPath": "never.txt", "newPath": "never.txt",
        })).await.unwrap_err();
        assert!(e.contains("never.txt"), "the error names the file: {e}");

        // a path escaping the workspace is refused, not read as ""
        std::fs::write(dir.join("c.txt"), "").unwrap();
        assert!(diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "new",
            "baseRef": "HEAD", "headRef": null, "oldPath": "x", "newPath": "../../../etc/passwd",
        })).await.is_err(), "an escaping path must be refused");

        // and a genuinely EMPTY file is a success with empty contents — the
        // case an error sentinel would have made indistinguishable
        let ok = diff_file_contents(cwd, &json!({
            "cwd": cwd, "sourceKind": "working-tree", "changeType": "new",
            "baseRef": "HEAD", "headRef": null, "oldPath": "c.txt", "newPath": "c.txt",
        })).await.expect("an empty file reads fine");
        assert_eq!(ok["newContents"], "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
