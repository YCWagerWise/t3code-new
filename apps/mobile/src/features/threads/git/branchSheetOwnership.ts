import { canActOnRef, type RefOwnershipContext } from "@t3tools/contracts";

/** The subset of a branch row the sheet's disabled set needs. */
export interface SheetBranch {
  readonly name: string;
  readonly worktreePath?: string | null;
  readonly current?: boolean;
}

/**
 * Which existing branches the sheet must NOT offer (#341).
 *
 * Extracted from `GitBranchesSheet` so it can be asserted without rendering
 * React Native. It used to be an inline
 * `branch.worktreePath !== null && branch.worktreePath !== currentWorktreePath`,
 * which reads a nulled path as "free" — and a Cairn `worktrees()` failure nulls
 * EVERY path while setting `ownershipUnavailable`. The decision itself lives in
 * `@t3tools/contracts` so this sheet and the web selector cannot drift apart
 * again, which is how #258 came to be fixed on only one side.
 */
export function disabledExistingBranchNames(
  branches: readonly SheetBranch[],
  ctx: RefOwnershipContext,
): ReadonlySet<string> {
  const disabled = new Set<string>();
  for (const branch of branches) {
    if (!canActOnRef(branch, ctx)) disabled.add(branch.name);
  }
  return disabled;
}
