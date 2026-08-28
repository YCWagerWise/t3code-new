#!/usr/bin/env node
/**
 * THE COVERAGE LEDGER (E2E-08). `node apps/web/e2e/coverage-ledger.ts`
 *
 * Enumerates every interactive handler in `apps/web/src` and maps each one to
 * the e2e spec that drives it. Anything unmapped is printed as a GAP with its
 * `file:line`. An unmapped handler is not allowed to be silent — that is the
 * whole point, and it is why this is a GENERATOR and not a hand-written list.
 *
 * A hand-written list is wrong the day after it is written and nobody can tell.
 * This one is regenerated from the source on every run, so the denominator is
 * whatever the code actually contains: add a button tomorrow and it shows up
 * here as an uncovered handler without anyone remembering to add it.
 *
 * `rg -a` IS LOAD-BEARING, and this comment is here because the mistake cost a
 * retracted finding on this channel. `apps/web/src/components/chat/ChatComposer.tsx`
 * contains NUL bytes in a template literal (`${image.mimeType}\0${image.sizeBytes}`),
 * so ripgrep treats it as binary and STOPS SEARCHING at offset 80,747 of 139,664.
 * Without `-a`, every handler in the back half of the largest interactive file in
 * the app is invisible, and this ledger would confidently report a smaller
 * denominator than the truth — the exact failure it exists to prevent.
 *
 * The mapping is deliberately CONSERVATIVE. A handler counts as covered only if
 * a spec drives the surface it lives on by name; "a spec touches this file" is
 * not coverage. Over-claiming here is worse than a large gap list, because a gap
 * list is work and a false green is a lie.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_SRC = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const E2E_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "actions");

type Handler = { readonly file: string; readonly line: number; readonly kind: string };

/**
 * Every interactive entry point, not just onClick. A ledger that counts only
 * clicks reports a keyboard-driven app as untested.
 */
const HANDLER_PATTERN =
  "on(Click|Submit|KeyDown|KeyUp|KeyPress|Change|Input|Focus|Blur|DoubleClick|ContextMenu|Drop|DragStart|DragOver|Paste)=";

function enumerateHandlers(): Handler[] {
  const out = execFileSync(
    "rg",
    [
      "-a", // SEE THE HEADER. Without this, ChatComposer.tsx is half-invisible.
      "--no-heading",
      "--line-number",
      "--only-matching",
      "--glob", "!*.test.*",
      "--glob", "!*.stories.*",
      "-e", HANDLER_PATTERN,
      WEB_SRC,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      // rg --only-matching --line-number => <path>:<line>:<match>
      const first = row.indexOf(":");
      const second = row.indexOf(":", first + 1);
      return {
        file: path.relative(path.resolve(WEB_SRC, "..", "..", ".."), row.slice(0, first)),
        line: Number(row.slice(first + 1, second)),
        kind: row.slice(second + 1).replace(/=$/, ""),
      };
    });
}

/**
 * Which surfaces each spec actually DRIVES, stated by the spec author rather
 * than inferred. Inference from imports would map every handler in a file a spec
 * merely touches, which is how a ledger reports coverage it does not have.
 *
 * Key = a path prefix under apps/web/src. Value = the spec that drives it.
 */
const DRIVEN_BY: ReadonlyArray<{ readonly prefix: string; readonly spec: string }> = [
  { prefix: "apps/web/src/components/Sidebar", spec: "keybindings-and-buttons.test.ts (sidebar.toggle, thread traversal)" },
  { prefix: "apps/web/src/components/AppSidebarLayout", spec: "keybindings-and-buttons.test.ts (sidebar.toggle)" },
  { prefix: "apps/web/src/components/CommandPalette", spec: "keybindings-and-buttons.test.ts (commandPalette/filePicker/projectSearch/themeEditor toggles)" },
  { prefix: "apps/web/src/components/chat/ChatComposer", spec: "keybindings-and-buttons.test.ts (composer.stash) + thread-nav-and-composer-stash.test.ts" },
  { prefix: "apps/web/src/components/ThreadTerminalDrawer", spec: "gated-keybindings.test.ts (terminal.* under terminalFocus)" },
  { prefix: "apps/web/src/routes/settings", spec: "settings-server-keybindings.test.ts" },
];

function specFor(file: string): string | null {
  for (const entry of DRIVEN_BY) {
    if (file.startsWith(entry.prefix)) return entry.spec;
  }
  return null;
}

function main(): void {
  const handlers = enumerateHandlers();
  const byFile = new Map<string, Handler[]>();
  for (const h of handlers) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }

  const covered: string[] = [];
  const gaps: string[] = [];
  for (const [file, list] of [...byFile.entries()].sort()) {
    const spec = specFor(file);
    const kinds = [...new Set(list.map((h) => h.kind))].sort().join(",");
    if (spec) {
      covered.push(`  ${file}  (${list.length} handlers: ${kinds})  <- ${spec}`);
    } else {
      // file:line for EVERY unmapped handler, not just the file. "This file is
      // uncovered" is not actionable; a line is.
      for (const h of list) gaps.push(`  ${file}:${h.line}  ${h.kind}`);
    }
  }

  const specs = execFileSync("ls", [E2E_DIR], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".test.ts"));

  console.log("# apps/web interactive-handler coverage ledger");
  console.log("");
  console.log(`handlers       ${handlers.length}`);
  console.log(`files          ${byFile.size}`);
  console.log(`covered files  ${byFile.size - new Set(gaps.map((g) => g.trim().split(":")[0])).size}`);
  console.log(`GAP handlers   ${gaps.length}`);
  console.log(`e2e specs      ${specs.length}  (${specs.join(", ")})`);
  console.log("");
  console.log("## COVERED (a spec drives this surface by name)");
  console.log(covered.join("\n") || "  (none)");
  console.log("");
  console.log("## GAPS (no spec drives this surface — file:line, none elided)");
  console.log(gaps.join("\n") || "  (none)");
}

main();
