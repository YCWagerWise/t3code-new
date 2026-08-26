//! Test scratch directories that actually go away.
//!
//! Every test in this crate wrote its state under `std::env::temp_dir()` and
//! handed back a plain `std::path::PathBuf`. A `PathBuf` has no `Drop` that
//! deletes anything, and the explicit `remove_dir_all` some tests ended with is
//! skipped by every early return and every panic — so the directories
//! accumulated. On the shared build box that reached **12,003 leaked `t3ct-*`
//! directories holding 22 GB**, filling a 31 GB tmpfs `/tmp` to 80%.
//!
//! That is not a tidiness problem. turso mmaps its `.tshm` cross-process
//! coordination segment out of the temp dir, and a tmpfs that cannot allocate a
//! page for an mmap'd write raises **SIGBUS** rather than returning ENOSPC. The
//! leak therefore surfaced as do-storage's `fd_capacity` / `fd_probe` crashing
//! or asserting — which was filed as a deterministically red base, investigated
//! as a descriptor-accounting bug, and became the stated prerequisite for
//! draining the merge queue. Both tests pass on a temp dir with room.
//!
//! Cleanup belongs in `Drop`, not at the end of a happy path.

/// A scratch directory removed when it goes out of scope.
///
/// Derefs to [`std::path::Path`] so it substitutes for the `PathBuf` these call
/// sites used to hold, without touching the body of every test.
pub struct TempRoot(std::path::PathBuf);

impl TempRoot {
    /// Wrap `path`, taking responsibility for removing it.
    pub fn new(path: std::path::PathBuf) -> Self {
        Self(path)
    }
    /// An owned copy, for the few callers that need to hand a `PathBuf` on.
    pub fn to_path_buf(&self) -> std::path::PathBuf {
        self.0.clone()
    }
}

impl std::ops::Deref for TempRoot {
    type Target = std::path::Path;
    fn deref(&self) -> &std::path::Path {
        &self.0
    }
}

impl AsRef<std::path::Path> for TempRoot {
    fn as_ref(&self) -> &std::path::Path {
        &self.0
    }
}

impl std::fmt::Debug for TempRoot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(&self.0, f)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        // Best-effort on purpose: a test that already failed must not be
        // reported as failing a second time, for an unrelated reason, while
        // unwinding.
        let _ = std::fs::remove_dir_all(&self.0);
        // The product puts a workspace's worktrees in a SIBLING directory
        // (`vcs::worktree_base`) — deliberately, so a linked worktree does not
        // show up as untracked files inside the repo it belongs to. That
        // sibling is outside this root, so removing the root alone leaks it.
        // Call the product's own function rather than rebuilding the name here,
        // so the two cannot drift apart.
        let _ = std::fs::remove_dir_all(crate::vcs::worktree_base(&self.0.to_string_lossy()));
    }
}

/// `std::env::temp_dir()/<name>`, removed when the returned guard drops.
pub fn temp_root(name: impl AsRef<str>) -> TempRoot {
    TempRoot::new(std::env::temp_dir().join(name.as_ref()))
}
