import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const spec = readFileSync(join(here, "diff-source-control-right-panel.spec.ts"), "utf8");

const sourceFiles = [
  "apps/web/src/diffFileActions.ts",
  "apps/web/src/diffPanelStore.ts",
  "apps/web/src/rightPanelStore.ts",
  "packages/shared/src/keybindings.ts",
  "backend/src/contract_tests.rs",
].map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);

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
  if (!spec.includes(`action: "${action}"`)) throw new Error(`missing E2E-4 action ${action}`);
}

for (const [rel, needle] of [
  ["packages/shared/src/keybindings.ts", 'command: "diff.toggle"'],
  ["packages/shared/src/keybindings.ts", 'command: "rightPanel.toggle"'],
  ["apps/web/src/diffFileActions.ts", "openDiffFilePrimaryAction"],
  ["apps/web/src/diffPanelStore.ts", "selectGitScope"],
  ["apps/web/src/rightPanelStore.ts", "toggleVisibility"],
  ["backend/src/contract_tests.rs", "review_diff_preview_sees_out_of_band_edit_and_new_file"],
]) {
  const source = sourceFiles.find(([file]) => file === rel)?.[1] ?? "";
  if (!source.includes(needle)) throw new Error(`${rel} no longer contains ${needle}`);
}

for (const required of [
  "sed -i",
  "heredoc-created",
  "cairn tree diff",
  "restart keeps",
  "workspace bytes restore",
  "review.getDiffPreview",
]) {
  if (!spec.includes(required)) throw new Error(`E2E-4 spec missing ${required}`);
}

console.log("diff-source-control-right-panel.spec.ts covers 12 E2E-4 action cases");
