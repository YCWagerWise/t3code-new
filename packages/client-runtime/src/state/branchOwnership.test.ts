import { describe, expect, it } from "@effect/vitest";

import {
  branchOwnershipBlock,
  branchOwnershipReason,
  branchOwnershipSubtitle,
  branchPickerRowBlock,
  foldOwnershipUnavailable,
  isBranchOwnershipBlocked,
} from "./branchOwnership.ts";

const ref = (over: Partial<Parameters<typeof branchOwnershipBlock>[0]> = {}) => ({
  worktreePath: null,
  current: false,
  ...over,
});

const known = (currentWorktreePath: string | null = "/repo") => ({
  ownershipUnavailable: false,
  currentWorktreePath,
});

/** Ownership listing failed: every worktreePath is null because it is UNKNOWN. */
const unknown = (currentWorktreePath: string | null = "/repo") => ({
  ownershipUnavailable: true,
  currentWorktreePath,
});

describe("branchOwnershipBlock", () => {
  it("allows a free branch when ownership is known", () => {
    expect(branchOwnershipBlock(ref(), known())).toBe(null);
  });

  it("blocks a branch held by another worktree", () => {
    expect(branchOwnershipBlock(ref({ worktreePath: "/other" }), known())).toBe(
      "held-by-other-worktree",
    );
  });

  it("allows a branch held by THIS worktree", () => {
    expect(branchOwnershipBlock(ref({ worktreePath: "/repo" }), known("/repo"))).toBe(null);
  });

  /**
   * THE DEFECT (#341). With the worktree listing failed the backend sends every
   * ref with `worktreePath: null`. A picker that only tests `worktreePath`
   * reads that as "free" and offers to switch to a branch another worktree may
   * hold open — which is exactly what ownership gating exists to prevent, and
   * it happens for EVERY branch at once rather than one.
   */
  it("blocks a null-worktreePath branch when ownership is UNAVAILABLE", () => {
    expect(branchOwnershipBlock(ref(), unknown())).toBe("ownership-unknown");
    expect(isBranchOwnershipBlocked(ref(), unknown())).toBe(true);
    // and the same ref is fine when ownership is merely absent-but-known
    expect(isBranchOwnershipBlocked(ref(), known())).toBe(false);
  });

  /**
   * The current branch stays usable even in the degraded case. Blocking it
   * would disable the row the user is standing on for no safety benefit — it is
   * held by THIS worktree, which is not a conflict.
   */
  it("never blocks the current branch, even with ownership unavailable", () => {
    expect(branchOwnershipBlock(ref({ current: true }), unknown())).toBe(null);
    expect(branchOwnershipBlock(ref({ current: true, worktreePath: "/other" }), unknown())).toBe(
      null,
    );
  });

  it("blocks every non-current branch when ownership is unavailable", () => {
    const refs = [ref(), ref(), ref({ current: true })];
    expect(refs.map((r) => isBranchOwnershipBlocked(r, unknown()))).toEqual([true, true, false]);
  });
});

describe("branchOwnershipReason", () => {
  it("names the other worktree case plainly", () => {
    expect(branchOwnershipReason("held-by-other-worktree")).toBe("Checked out in another worktree");
  });

  it("carries git's own reason for the unknown case", () => {
    expect(branchOwnershipReason("ownership-unknown", "fatal: not a git repository")).toContain(
      "fatal: not a git repository",
    );
  });

  it("still explains itself with no reason available", () => {
    const reason = branchOwnershipReason("ownership-unknown");
    expect(reason).toContain("could not be read");
    // an unexplained refusal is the thing that makes a user force-quit
    expect(reason.length).toBeGreaterThan(0);
  });

  it("ignores a blank refsError rather than rendering a dangling colon", () => {
    expect(branchOwnershipReason("ownership-unknown", "   ")).not.toContain(":");
  });
});

describe("branchOwnershipSubtitle", () => {
  it("distinguishes this worktree from another", () => {
    expect(branchOwnershipSubtitle(ref({ worktreePath: "/repo" }), known("/repo"))).toBe(
      "Checked out in this thread",
    );
    expect(branchOwnershipSubtitle(ref({ worktreePath: "/other" }), known("/repo"))).toBe(
      "Checked out in another worktree",
    );
  });

  /**
   * The label and the disabled state must come from ONE reading of ownership.
   * Rendering "Local branch" under a disabled row tells the user the refusal is
   * a bug.
   */
  it("says ownership is unknown instead of claiming a plain local branch", () => {
    expect(branchOwnershipSubtitle({ ...ref(), isDefault: false }, unknown())).toBe(
      "Ownership unknown",
    );
    expect(branchOwnershipSubtitle({ ...ref(), isDefault: true }, unknown())).toBe(
      "Ownership unknown",
    );
    expect(branchOwnershipSubtitle({ ...ref(), isDefault: true }, known())).toBe("Default branch");
  });
});

describe("foldOwnershipUnavailable", () => {
  /**
   * Pages share one backend owner map, so a failure on any page is a failure
   * for the set. Taking the last (or first) page's value would let a later
   * successful page silently re-enable every affordance the failed one
   * disabled.
   */
  it("is true when ANY page reports unknown ownership", () => {
    expect(foldOwnershipUnavailable([{}, { ownershipUnavailable: true }, {}])).toBe(true);
    expect(foldOwnershipUnavailable([{ ownershipUnavailable: true }, {}])).toBe(true);
  });

  it("is false only when no page reports it", () => {
    expect(foldOwnershipUnavailable([{}, { ownershipUnavailable: false }])).toBe(false);
    expect(foldOwnershipUnavailable([])).toBe(false);
  });
});

/**
 * THE PICKER REGRESSION (#341) — this is the decision both the web toolbar
 * (`BranchToolbarBranchSelector`) and the mobile sheet (`GitBranchesSheet`)
 * actually run for every row they render. They call this function; they no
 * longer test `worktreePath` themselves, which is what the finding says both of
 * them were doing wrong.
 */
describe("branchPickerRowBlock (web toolbar + mobile sheet)", () => {
  it("blocks a local branch when ownership is unknown", () => {
    expect(branchPickerRowBlock({ worktreePath: null, current: false }, unknown())).toBe(
      "ownership-unknown",
    );
  });

  it("does NOT gate a remote ref on worktree ownership", () => {
    // A remote ref has no local worktree that could hold it checked out, so a
    // failed ownership listing tells us nothing about it. Greying it out would
    // be a refusal with no safety behind it.
    expect(
      branchPickerRowBlock({ worktreePath: null, current: false, isRemote: true }, unknown()),
    ).toBe(null);
  });

  it("still blocks a local branch a known other worktree holds", () => {
    expect(branchPickerRowBlock({ worktreePath: "/other", current: false }, known())).toBe(
      "held-by-other-worktree",
    );
  });

  it("leaves an ordinary free local branch alone", () => {
    expect(branchPickerRowBlock({ worktreePath: null, current: false }, known())).toBe(null);
  });

  /**
   * The whole picker at once, in the degraded state: exactly the current row
   * and the remote refs stay usable, and every other local branch is refused.
   */
  it("degrades a whole picker correctly when ownership is unavailable", () => {
    const rows = [
      { name: "main", worktreePath: null, current: true },
      { name: "feature-a", worktreePath: null, current: false },
      { name: "feature-b", worktreePath: null, current: false },
      { name: "origin/main", worktreePath: null, current: false, isRemote: true },
    ];
    expect(rows.map((r) => branchPickerRowBlock(r, unknown()) !== null)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});
