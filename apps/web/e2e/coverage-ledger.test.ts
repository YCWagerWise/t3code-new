import assert from "node:assert/strict";
import test from "node:test";

import { keybindingActions, orchestrationActions } from "./coverage-ledger.ts";

test("keybinding denominator follows nested contract spreads", () => {
  const source = `
    export const JUMPS = ["jump.1", "jump.2"] as const;
    export const PICKER = ["picker.toggle", ...JUMPS] as const;
    export const STATIC_KEYBINDING_COMMANDS = ["sidebar.toggle", ...PICKER] as const;
  `;
  assert.deepEqual(keybindingActions(source), [
    "sidebar.toggle",
    "picker.toggle",
    "jump.1",
    "jump.2",
  ]);
});

test("dispatch denominator follows the union to each literal type", () => {
  const source = `
    const CreateCommand = Schema.Struct({ type: Schema.Literal("item.create") });
    const DeleteCommand = Schema.Struct({ type: Schema.Literal("item.delete") });
    const DispatchableClientOrchestrationCommand = Schema.Union([
      CreateCommand,
      DeleteCommand,
    ]);
  `;
  assert.deepEqual(orchestrationActions(source), ["item.create", "item.delete"]);
});

test("an empty keybinding denominator is rejected instead of reporting full coverage", () => {
  assert.throws(
    () => keybindingActions("export const STATIC_KEYBINDING_COMMANDS = [] as const;"),
    /resolved to zero actions/,
  );
});
