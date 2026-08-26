import { describe, expect, it } from "vite-plus/test";

import { disabledExistingBranchNames, type SheetBranch } from "./branchSheetOwnership.ts";

/**
 * #341, mobile half. The web selector's gate is pinned in
 * `apps/web/src/components/BranchToolbar.logic.test.ts`; this is the same
 * property for the sheet, because the two consumers drifting apart is the
 * finding.
 */
describe("disabledExistingBranchNames (#341)", () => {
  const ACTIVE = "/repo/main";
  const branches: SheetBranch[] = [
    { name: "main", current: true, worktreePath: ACTIVE },
    { name: "feature/demo", worktreePath: null },
    { name: "feature/held", worktreePath: "/repo/wt-2" },
  ];

  it("disables only the branch another worktree holds while ownership is known", () => {
    const disabled = disabledExistingBranchNames(branches, {
      ownershipUnavailable: false,
      activeWorktreePath: ACTIVE,
    });
    expect([...disabled]).toEqual(["feature/held"]);
  });

  it("disables everything but the current branch once ownership is UNAVAILABLE", () => {
    // Cairn worktrees() failed, so every path is null because it is unknown.
    // The pre-fix loop produced an EMPTY disabled set here — every branch
    // tappable, including ones another worktree had checked out.
    const nulled = branches.map((b) => (b.current ? b : { ...b, worktreePath: null }));
    const disabled = disabledExistingBranchNames(nulled, {
      ownershipUnavailable: true,
      activeWorktreePath: ACTIVE,
    });
    expect([...disabled].sort()).toEqual(["feature/demo", "feature/held"]);
    expect(disabled.has("main")).toBe(false);
  });

  it("does not shorten the list — it only marks rows unavailable", () => {
    // The stated non-goal: do not answer this by hiding refs.
    const disabled = disabledExistingBranchNames(branches, {
      ownershipUnavailable: true,
      activeWorktreePath: ACTIVE,
    });
    expect(branches).toHaveLength(3);
    expect(disabled.size).toBe(2);
  });
});
