import { describe, expect, it } from "vite-plus/test";
import { canActOnRef, refAvailability, refDisabledReason } from "./branchOwnership.ts";

describe("refAvailability", () => {
  const active = "/repo/main";

  it("treats a null worktreePath as free ONLY when ownership is known", () => {
    // The pre-#341 reading, which stays correct while ownership IS known.
    expect(refAvailability({ worktreePath: null }, { activeWorktreePath: active })).toEqual({
      kind: "free",
    });
    expect(canActOnRef({ worktreePath: null }, { activeWorktreePath: active })).toBe(true);
  });

  it("refuses to read a null worktreePath as free when ownership is UNAVAILABLE", () => {
    // This is #341. A Cairn worktrees() failure nulls EVERY worktreePath, so the
    // old check saw a repo full of free branches.
    const ctx = { ownershipUnavailable: true, activeWorktreePath: active };
    expect(refAvailability({ worktreePath: null }, ctx)).toEqual({ kind: "unknown" });
    expect(canActOnRef({ worktreePath: null }, ctx)).toBe(false);
  });

  it("still reports a ref held by another worktree, with the path", () => {
    expect(refAvailability({ worktreePath: "/repo/wt-2" }, { activeWorktreePath: active })).toEqual(
      { kind: "heldByOtherWorktree", worktreePath: "/repo/wt-2" },
    );
  });

  it("does not treat the ref held by THIS worktree as held elsewhere", () => {
    expect(refAvailability({ worktreePath: active }, { activeWorktreePath: active })).toEqual({
      kind: "free",
    });
  });

  it("exempts the CURRENT ref even when ownership is unavailable", () => {
    // The current branch is held by this worktree, and that fact does not come
    // from the ownership map. Disabling it would make a failed worktrees() call
    // look like the branch had vanished.
    const ctx = { ownershipUnavailable: true, activeWorktreePath: active };
    expect(refAvailability({ worktreePath: null, current: true }, ctx)).toEqual({ kind: "free" });
    expect(canActOnRef({ worktreePath: null, current: true }, ctx)).toBe(true);
  });

  it("checks unknown BEFORE the worktreePath comparison", () => {
    // Ordering is the fix: with ownership unavailable every path is null, so a
    // free-first implementation classifies everything as free.
    const ctx = { ownershipUnavailable: true, activeWorktreePath: active };
    for (const worktreePath of [null, active, "/repo/wt-2"]) {
      expect(refAvailability({ worktreePath }, ctx).kind).toBe("unknown");
    }
    // and the property-absent case, which is distinct under
    // exactOptionalPropertyTypes
    expect(refAvailability({}, ctx).kind).toBe("unknown");
  });
});

describe("refDisabledReason", () => {
  const active = "/repo/main";

  it("is null when the ref is actionable", () => {
    expect(refDisabledReason({ worktreePath: null }, { activeWorktreePath: active })).toBeNull();
  });

  it("names the holding worktree when one is known", () => {
    expect(
      refDisabledReason({ worktreePath: "/repo/wt-2" }, { activeWorktreePath: active }),
    ).toContain("/repo/wt-2");
  });

  it("says ownership is UNAVAILABLE rather than claiming the branch is busy", () => {
    const reason = refDisabledReason(
      { worktreePath: null },
      { ownershipUnavailable: true, activeWorktreePath: active },
    );
    expect(reason).toContain("unavailable");
    // Telling a user "another worktree has this" when we could not read the
    // worktree list is a second, quieter lie.
    expect(reason).not.toContain("another worktree");
  });

  it("includes git's own words when the backend supplied them", () => {
    expect(
      refDisabledReason(
        { worktreePath: null },
        { ownershipUnavailable: true, activeWorktreePath: active },
        "fatal: not a git repository",
      ),
    ).toContain("fatal: not a git repository");
  });
});
