/**
 * Who currently holds a branch checked out — and, just as importantly, whether
 * we KNOW.
 *
 * `vcs.listRefs` reports ownership as `worktreePath` per ref: the linked
 * worktree that has that branch checked out, or `null`. Switching to, deleting,
 * or force-updating a ref another worktree holds is precisely what that map
 * exists to prevent.
 *
 * The trap this module exists to close (#258 / #341): when cairn cannot list
 * linked worktrees, EVERY ref comes back with `worktreePath: null`. Read
 * literally that says "every branch is free", which is the most dangerous
 * possible reading of "we could not find out" — it enables exactly the
 * operations ownership was meant to gate, across every branch at once. The
 * backend therefore distinguishes the two cases with `ownershipUnavailable`,
 * and this is where the client honours the distinction instead of flattening it
 * back into a null check.
 *
 * Both branch pickers (web toolbar, mobile sheet) decide through here rather
 * than testing `worktreePath` themselves, because two hand-rolled null checks
 * are two chances to get the unknown case wrong — and #341 was filed because
 * both of them already had.
 */

/** The reason a branch may not be acted on, or `null` when it is safe. */
export type BranchOwnershipBlock = "held-by-other-worktree" | "ownership-unknown";

export interface BranchOwnershipRef {
  /** The linked worktree holding this ref, or `null` for "none, or unknown". */
  readonly worktreePath: string | null;
  /** Whether this ref is the one checked out here. */
  readonly current: boolean;
}

export interface BranchOwnershipContext {
  /**
   * `true` when the worktree listing FAILED, so every `worktreePath` is
   * `null` because it is unknown rather than because the ref is free.
   */
  readonly ownershipUnavailable: boolean;
  /** The worktree this surface is acting from, if known. */
  readonly currentWorktreePath: string | null;
}

/**
 * Why `branch` cannot be switched to / acted on, or `null` if it can.
 *
 * Order matters and is the whole contract:
 *
 * 1. The branch we are already on is always fine. It is not "held by another
 *    worktree" — it is held by THIS one — and blocking it would disable the
 *    current row for no reason, including in the degraded case.
 * 2. A known foreign owner blocks. This is the ordinary, non-degraded rule.
 * 3. Unknown ownership blocks everything else. FAIL CLOSED: with the listing
 *    failed we cannot show that any given ref is free, and the cost of being
 *    wrong is a checkout against a branch another worktree has open.
 *
 * Rule 3 cannot be folded into rule 2, and that is the bug #341 names: when
 * ownership is unavailable every `worktreePath` is `null`, so rule 2 never
 * fires and a `worktreePath`-only test silently answers "safe" for every ref.
 */
export function branchOwnershipBlock(
  branch: BranchOwnershipRef,
  context: BranchOwnershipContext,
): BranchOwnershipBlock | null {
  if (branch.current) return null;
  if (branch.worktreePath !== null && branch.worktreePath !== context.currentWorktreePath) {
    return "held-by-other-worktree";
  }
  if (context.ownershipUnavailable) return "ownership-unknown";
  return null;
}

/**
 * The block for one row of a branch PICKER, which is what both the web toolbar
 * and the mobile sheet render.
 *
 * The one thing a picker knows that [`branchOwnershipBlock`] does not: a REMOTE
 * ref has no local worktree that could hold it checked out, so worktree
 * ownership cannot conflict with it and must not gate it. Without this, an
 * ownership-listing failure would grey out every remote branch too — a refusal
 * with no safety behind it, which teaches users the warning is noise.
 *
 * Both pickers decide through this single function rather than each re-deriving
 * it, because #341 was filed precisely because two hand-rolled copies of this
 * rule both got the unknown case wrong.
 */
export function branchPickerRowBlock(
  branch: BranchOwnershipRef & { readonly isRemote?: boolean | undefined },
  context: BranchOwnershipContext,
): BranchOwnershipBlock | null {
  if (branch.isRemote === true) return null;
  return branchOwnershipBlock(branch, context);
}

/** Whether a branch row should be disabled in a picker. */
export function isBranchOwnershipBlocked(
  branch: BranchOwnershipRef,
  context: BranchOwnershipContext,
): boolean {
  return branchOwnershipBlock(branch, context) !== null;
}

/**
 * What to tell the user, in the same words on both platforms.
 *
 * `refsError` carries git's own reason when there is one; an unknown-ownership
 * message without it reads as an arbitrary refusal, which is how a user ends up
 * force-quitting instead of fixing their repository.
 */
export function branchOwnershipReason(
  block: BranchOwnershipBlock,
  refsError?: string | undefined,
): string {
  if (block === "held-by-other-worktree") return "Checked out in another worktree";
  const detail = refsError?.trim();
  return detail !== undefined && detail.length > 0
    ? `Worktree ownership could not be read, so this branch may be checked out elsewhere: ${detail}`
    : "Worktree ownership could not be read, so this branch may be checked out elsewhere.";
}

/**
 * The subtitle for a branch row.
 *
 * Kept here beside the block decision on purpose: the label and the disabled
 * state have to be derived from the SAME reading of ownership, or the UI
 * disables a row while telling the user it is a plain "Local branch".
 */
export function branchOwnershipSubtitle(
  branch: BranchOwnershipRef & { readonly isDefault?: boolean | undefined },
  context: BranchOwnershipContext,
): string {
  if (branch.worktreePath !== null) {
    return branch.worktreePath === context.currentWorktreePath
      ? "Checked out in this thread"
      : "Checked out in another worktree";
  }
  if (context.ownershipUnavailable && !branch.current) {
    return "Ownership unknown";
  }
  return branch.isDefault === true ? "Default branch" : "Local branch";
}

/**
 * Fold the `ownershipUnavailable` flags of several `listRefs` pages into one.
 *
 * ANY page reporting unknown ownership makes the whole set unknown. The pages
 * share a single owner map on the backend, so a failure on one page is a
 * failure for all of them; taking the last page's value (or the first's) would
 * let a later successful page silently re-enable every affordance the failed
 * one disabled.
 */
export function foldOwnershipUnavailable(
  pages: ReadonlyArray<{ readonly ownershipUnavailable?: boolean | undefined }>,
): boolean {
  return pages.some((page) => page.ownershipUnavailable === true);
}
