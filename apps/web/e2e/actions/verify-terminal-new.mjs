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

const spec = read("apps/web/e2e/actions/terminal-new.spec.ts");
const keybindings = read("backend/src/keybindings.rs");
const chatView = read("apps/web/src/components/ChatView.tsx");
const terminalContract = read("packages/contracts/src/terminal.ts");

assertIncludes("terminal-new spec", spec, "terminal.new");
assertIncludes("terminal-new spec", spec, "terminal.open");
assertIncludes("terminal-new spec", spec, "recordRequests");
assertIncludes("terminal-new spec", spec, "ControlOrMeta+N");
assertIncludes("terminal-new spec", spec, "ControlOrMeta+J");
assertIncludes("terminal-new spec", spec, "assertExactlyOneTerminalOwner");
assertIncludes("terminal-new spec", spec, "not.toBe(firstOpen.terminalId)");
assertIncludes("terminal-new spec", spec, "toBeGreaterThan(baselineCount)");
assertIncludes("backend keybindings", keybindings, 'push("mod+n", "terminal.new", Some("terminalFocus"))');
assertIncludes("backend keybindings", keybindings, 'push("mod+n", "chat.new", Some("!terminalFocus"))');
assertIncludes("ChatView terminal.new handler", chatView, 'if (command === "terminal.new")');
assertIncludes("ChatView terminal.open input", chatView, "threadId: activeThreadId");
assertIncludes("ChatView terminal.open input", chatView, "terminalId");
assertIncludes("ChatView terminal.open input", chatView, "cwd: cwdForOpen");
assertIncludes("terminal contract", terminalContract, "TerminalTargetInput = Schema.Union");
assertIncludes("terminal contract", terminalContract, "sessionId: Schema.optional(Schema.Never)");
assertIncludes("terminal contract", terminalContract, "threadId: Schema.optional(Schema.Never)");

console.log("terminal.new committed action spec covers:");
console.log("  guard: mod+n terminal.new requires terminalFocus");
console.log("  conflict: mod+n chat.new requires !terminalFocus");
console.log("  wire: spec records terminal.open frames after ControlOrMeta+N");
console.log("  owner: spec asserts exactly one of threadId/sessionId");
console.log("  identity: spec asserts a fresh non-empty terminalId");
