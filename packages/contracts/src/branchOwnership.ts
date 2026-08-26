/**
 * Who may act on a ref when ownership is UNKNOWN (#258 / #341).
 *
 * `VcsListRefsResult.worktreePath` is `string | null`, and `null` has always
 * meant "no linked worktree holds this branch, so it is free to switch to,
 * delete or force-update". That reading stopped being safe when the backend
 * gained `ownershipUnavailable`: a Cairn `worktrees()` failure now returns real
 * refs with EVERY `worktreePath: null`, because ownership is unknown — not
 * because every branch is free.
 *
 * The producer half distinguishes those two states. The consumers did not: the
 * web selector computed availability from `worktreePath` alone and always wired
 * `onClick={() => selectBranch(ref)}`, and the mobile sheet built its disabled
 * set with `branch.worktreePath !== null && ...`. So with ownership unavailable,
 * every ref rendered as free and the user could switch to one another worktree
 * had checked out — the exact thing the ownership map exists to prevent.
 *
 * This lives beside the schema, in one place, deliberately: two consumers each
 * re-deriving "is this ref safe to act on" from raw fields is how the two halves
 * drifted apart in the first place.
 */

/** The subset of a listRefs result this decision needs. */
export interface RefOwnershipContext {
  /** From `VcsListRefsResult`. `true` = which worktree holds which ref is UNKNOWN. */
  readonly ownershipUnavailable?: boolean;
  /** The worktree the user is acting from, if known. */
  readonly activeWorktreePath?: string | null;
}

/** The subset of a ref this decision needs. */
export interface RefOwnershipSubject {
  readonly worktreePath?: string | null;
  readonly current?: boolean;
}

export type RefAvailability =
  /** No other worktree holds it; destructive actions are safe to offer. */
  | { readonly kind: "free" }
  /** Another linked worktree holds it; actions are refused, as before. */
  | { readonly kind: "heldByOtherWorktree"; readonly worktreePath: string }
  /** Ownership could not be read. Actions must be DISABLED, not enabled. */
  | { readonly kind: "unknown" };

/**
 * Classify one ref.
 *
 * Order matters: `unknown` is checked FIRST, because when ownership is
 * unavailable every `worktreePath` is `null` and would otherwise classify as
 * `free` — which is precisely the bug.
 *
 * The ref the user is already on is exempt: it is held by THIS worktree, that
 * fact does not come from the ownership map, and disabling it would make a
 * failed `worktrees()` call look like the current branch had vanished.
 */
export function refAvailability(
  ref: RefOwnershipSubject,
  ctx: RefOwnershipContext,
): RefAvailability {
  if (ref.current) return { kind: "free" };
  if (ctx.ownershipUnavailable) return { kind: "unknown" };
  const held = ref.worktreePath;
  if (held && ctx.activeWorktreePath && held !== ctx.activeWorktreePath) {
    return { kind: "heldByOtherWorktree", worktreePath: held };
  }
  return { kind: "free" };
}

/**
 * May a switch / delete / force-update be OFFERED for this ref?
 *
 * `false` for both "held by someone else" and "we do not know" — the second is
 * the whole point. A UI that only checks `heldByOtherWorktree` re-introduces
 * #341.
 */
export function canActOnRef(ref: RefOwnershipSubject, ctx: RefOwnershipContext): boolean {
  return refAvailability(ref, ctx).kind === "free";
}

/**
 * Why an affordance is disabled, for a tooltip / helper line. `null` when it is
 * not disabled.
 *
 * Says ownership is UNKNOWN rather than claiming the branch is busy: telling a
 * user "another worktree has this" when we could not read the worktree list is
 * a second, quieter lie.
 */
export function refDisabledReason(
  ref: RefOwnershipSubject,
  ctx: RefOwnershipContext,
  refsError?: string,
): string | null {
  const availability = refAvailability(ref, ctx);
  switch (availability.kind) {
    case "free":
      return null;
    case "heldByOtherWorktree":
      return `Checked out in another worktree (${availability.worktreePath})`;
    case "unknown":
      return refsError
        ? `Branch ownership is unavailable, so this cannot be offered safely: ${refsError}`
        : "Branch ownership is unavailable, so this cannot be offered safely";
  }
}
