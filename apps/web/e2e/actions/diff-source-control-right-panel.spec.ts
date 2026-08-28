/**
 * E2E-4: diff, source-control, review-comment, pull-request reference, and
 * right-panel actions.
 *
 * The backend substrate proof is
 * `review_diff_preview_sees_out_of_band_edit_and_new_file`: it mutates a
 * tracked file with `sed -i` and creates a file with a heredoc, then asserts
 * `review.getDiffPreview` sees both through the Cairn tree diff. Browser
 * coverage must assert the rendered change list is fed by that same RPC, not
 * by frontend edit bookkeeping.
 */

export type DiffSourceControlRightPanelCase = {
  readonly id: number;
  readonly action: string;
  readonly uiAction: string;
  readonly backendSource: "cairn tree diff" | "source-control RPC" | "right-panel store";
  readonly requiredProof: readonly string[];
};

export const diffSourceControlRightPanelCases: readonly DiffSourceControlRightPanelCase[] = [
  {
    id: 401,
    action: "diff.toggle",
    uiAction: "press mod+d with terminalFocus=false",
    backendSource: "right-panel store",
    requiredProof: ["right panel opens on diff", "right panel closes on second toggle"],
  },
  {
    id: 402,
    action: "rightPanel.toggle",
    uiAction: "press mod+alt+b",
    backendSource: "right-panel store",
    requiredProof: ["right panel visibility toggles without changing active surface"],
  },
  {
    id: 403,
    action: "rightPanel.toggleMaximized",
    uiAction: "activate the maximize control",
    backendSource: "right-panel store",
    requiredProof: ["maximized state changes", "reload rehydrates panel state"],
  },
  {
    id: 404,
    action: "diff.workingTree.fromOutOfBandMutation",
    uiAction: "run sed -i outside the app, then open the diff panel",
    backendSource: "cairn tree diff",
    requiredProof: [
      "tracked file edited by sed -i appears in the rendered change list",
      "new heredoc-created file appears in the rendered change list",
      "review.getDiffPreview source is selected",
    ],
  },
  {
    id: 405,
    action: "sourceControl.stage",
    uiAction: "stage a rendered working-tree file",
    backendSource: "source-control RPC",
    requiredProof: ["file moves from unstaged to staged", "restart keeps git index state"],
  },
  {
    id: 406,
    action: "sourceControl.unstage",
    uiAction: "unstage a rendered staged file",
    backendSource: "source-control RPC",
    requiredProof: ["file moves from staged to unstaged", "restart keeps git index state"],
  },
  {
    id: 407,
    action: "sourceControl.discard",
    uiAction: "discard an unstaged rendered file change",
    backendSource: "source-control RPC",
    requiredProof: ["worktree file bytes return to HEAD", "change stays gone after restart"],
  },
  {
    id: 408,
    action: "diffFile.open",
    uiAction: "open a diff file primary action",
    backendSource: "right-panel store",
    requiredProof: ["file panel opens with workspace-relative path", "absolute paths are rejected"],
  },
  {
    id: 409,
    action: "turn.revert",
    uiAction: "revert an implemented turn from the diff surface",
    backendSource: "cairn tree diff",
    requiredProof: ["workspace bytes restore", "thread/runtime state survives restart"],
  },
  {
    id: 410,
    action: "reviewComment.add",
    uiAction: "add a review comment from an annotated diff line",
    backendSource: "right-panel store",
    requiredProof: ["comment appears in composer context", "reload keeps the draft context"],
  },
  {
    id: 411,
    action: "reviewComment.remove",
    uiAction: "remove a review comment from composer context",
    backendSource: "right-panel store",
    requiredProof: ["comment disappears from composer context", "reload does not resurrect it"],
  },
  {
    id: 412,
    action: "pullRequestReference.open",
    uiAction: "open a pull-request reference",
    backendSource: "right-panel store",
    requiredProof: ["pull-request surface opens by stable reference", "same PR from another environment is a distinct surface"],
  },
];

export function assertDiffSourceControlRightPanelCoverage(
  cases: readonly DiffSourceControlRightPanelCase[] = diffSourceControlRightPanelCases,
) {
  const actions = new Set(cases.map((testCase) => testCase.action));
  for (const action of [
    "diff.toggle",
    "rightPanel.toggle",
    "rightPanel.toggleMaximized",
    "diff.workingTree.fromOutOfBandMutation",
    "sourceControl.stage",
    "sourceControl.unstage",
    "sourceControl.discard",
    "diffFile.open",
    "turn.revert",
    "reviewComment.add",
    "reviewComment.remove",
    "pullRequestReference.open",
  ]) {
    if (!actions.has(action)) throw new Error(`missing E2E-4 action ${action}`);
  }
  const outOfBand = cases.find((testCase) => testCase.action === "diff.workingTree.fromOutOfBandMutation");
  if (!outOfBand || outOfBand.backendSource !== "cairn tree diff") {
    throw new Error("out-of-band mutation case must be sourced from Cairn tree diff");
  }
  if (!outOfBand.requiredProof.some((proof) => proof.includes("sed -i"))) {
    throw new Error("out-of-band mutation case must name sed -i");
  }
}

assertDiffSourceControlRightPanelCoverage();
