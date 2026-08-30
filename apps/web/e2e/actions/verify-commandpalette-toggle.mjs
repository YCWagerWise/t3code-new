#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

function assertIncludes(name, haystack, needle) {
  if (!haystack.includes(needle)) {
    throw new Error(`${name} does not contain ${JSON.stringify(needle)}`);
  }
}

const spec = read("apps/web/e2e/actions/commandpalette-toggle.spec.ts");
const keybindings = read("backend/src/keybindings.rs");
const results = read("apps/web/src/components/CommandPaletteResults.tsx");

assertIncludes("commandpalette spec", spec, "commandPalette.toggle");
assertIncludes("commandpalette spec", spec, "ControlOrMeta+K");
assertIncludes("commandpalette spec", spec, "server.getConfig");
assertIncludes("commandpalette spec", spec, "config.keybindings.map");
assertIncludes("commandpalette spec", spec, "data-command-palette-command");
assertIncludes("commandpalette spec", spec, "toEqual(");
assertIncludes("commandpalette spec", spec, "!terminalFocus");
assertIncludes(
  "backend keybindings",
  keybindings,
  'push("mod+k", "commandPalette.toggle", Some("!terminalFocus"))',
);
assertIncludes("palette results", results, "data-command-palette-command");
assertIncludes("palette results", results, "props.item.shortcutCommand");

console.log("commandPalette.toggle committed action spec covers:");
console.log("  guard: mod+k commandPalette.toggle requires !terminalFocus");
console.log("  source: denominator is server.getConfig keybindings");
console.log("  enumeration: palette rows expose data-command-palette-command");
console.log("  assertion: palette command set equals keybound command set");
