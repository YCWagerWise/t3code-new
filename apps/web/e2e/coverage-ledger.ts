#!/usr/bin/env node
/**
 * The closed action-surface ledger for the frontend E2E suite.
 *
 * The contracts are the authority. This file deliberately derives both sets on
 * every run so a newly-added action becomes an uncovered row without somebody
 * remembering to update a second list.
 *
 * Only `actions/*.test.ts` can claim coverage because that is exactly what
 * `run.ts` executes. A `.spec.ts` file may contain useful work, but counting a
 * file the runner never loads would turn dead code into a green coverage row.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const ACTIONS_DIR = path.join(HERE, "actions");
const KEYBINDINGS = path.join(ROOT, "packages/contracts/src/keybindings.ts");
const ORCHESTRATION = path.join(ROOT, "packages/contracts/src/orchestration.ts");

type Surface = "keybinding" | "orchestration";
type CoverageRow = Readonly<{
  action: string;
  surface: Surface;
  specs: readonly string[];
}>;

export type CoverageReport = Readonly<{
  actions: readonly CoverageRow[];
  covered: number;
  uncovered: number;
  specFiles: readonly string[];
}>;

function arrayBodies(source: string): Map<string, string> {
  const arrays = new Map<string, string>();
  const declaration = /(?:export\s+)?const\s+(\w+)\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/g;
  for (const match of source.matchAll(declaration)) arrays.set(match[1], match[2]);
  return arrays;
}

function resolveStringArray(
  name: string,
  arrays: ReadonlyMap<string, string>,
  resolving = new Set<string>(),
): string[] {
  if (resolving.has(name)) throw new Error(`recursive contract array: ${[...resolving, name].join(" -> ")}`);
  const body = arrays.get(name);
  if (body == null) throw new Error(`contract array ${name} was referenced but not declared`);

  const next = new Set(resolving).add(name);
  const values: string[] = [];
  const token = /\.\.\.(\w+)|["']([^"']+)["']/g;
  for (const match of body.matchAll(token)) {
    if (match[1]) values.push(...resolveStringArray(match[1], arrays, next));
    else if (match[2]) values.push(match[2]);
  }
  if (values.length === 0) {
    throw new Error(
      `${name} resolved to zero actions. A zero denominator reports everything covered; update the parser instead.`,
    );
  }
  return values;
}

export function keybindingActions(source: string): string[] {
  return resolveStringArray("STATIC_KEYBINDING_COMMANDS", arrayBodies(source));
}

export function orchestrationActions(source: string): string[] {
  const union = source.match(
    /const\s+DispatchableClientOrchestrationCommand\s*=\s*Schema\.Union\(\[([\s\S]*?)\]\s*\)\s*;/,
  );
  if (!union) throw new Error("DispatchableClientOrchestrationCommand union was not found");

  const members = [...union[1].matchAll(/\b(\w+Command)\b/g)].map((match) => match[1]);
  if (members.length === 0) throw new Error("DispatchableClientOrchestrationCommand has zero members");
  return members.map((member) => {
    const start = source.indexOf(`const ${member} =`);
    if (start < 0) throw new Error(`${member} is in the dispatchable union but has no declaration`);
    const next = source.indexOf("\nconst ", start + 1);
    const declaration = source.slice(start, next < 0 ? source.length : next);
    const literal = declaration.match(/\btype\s*:\s*Schema\.Literal\(["']([^"']+)["']\)/)?.[1];
    if (!literal) throw new Error(`${member} has no literal type and cannot be represented in the ledger`);
    return literal;
  });
}

/** Remove comments without removing quoted strings; comments cannot claim coverage. */
function withoutComments(source: string): string {
  let out = "";
  let quote: "\"" | "'" | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        out += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
    } else {
      out += char;
      if (char === "\"" || char === "'" || char === "`") quote = char;
    }
  }
  return out;
}

function mentionsAction(source: string, action: string): boolean {
  return [`"${action}"`, `'${action}'`, `\`${action}\``].some((literal) => source.includes(literal));
}

export function buildCoverageReport(): CoverageReport {
  const keybindings = keybindingActions(fs.readFileSync(KEYBINDINGS, "utf8"));
  const orchestration = orchestrationActions(fs.readFileSync(ORCHESTRATION, "utf8"));
  const specFiles = fs
    .readdirSync(ACTIONS_DIR)
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
  if (specFiles.length === 0) throw new Error("run.ts would execute zero action specs");

  const sources = new Map(
    specFiles.map((file) => [file, withoutComments(fs.readFileSync(path.join(ACTIONS_DIR, file), "utf8"))]),
  );
  const surfaces = new Map<string, Surface>();
  for (const action of keybindings) surfaces.set(action, "keybinding");
  for (const action of orchestration) surfaces.set(action, "orchestration");

  const actions = [...surfaces]
    .map(([action, surface]) => ({
      action,
      surface,
      specs: [...sources]
        .filter(([, source]) => mentionsAction(source, action))
        .map(([file]) => file),
    }))
    .sort((a, b) => a.action.localeCompare(b.action));
  if (actions.length === 0) throw new Error("the combined action denominator is zero");

  const covered = actions.filter((row) => row.specs.length > 0).length;
  return { actions, covered, uncovered: actions.length - covered, specFiles };
}

export function printCoverageReport(report: CoverageReport): void {
  console.log("# apps/web E2E action coverage");
  console.log(`ACTIONS ${report.actions.length} (${report.covered} covered, ${report.uncovered} UNCOVERED)`);
  console.log(`RUNNABLE SPECS ${report.specFiles.length} (${report.specFiles.join(", ")})`);
  for (const row of report.actions) {
    console.log(`${row.specs.length ? "COVERED  " : "UNCOVERED"} ${row.surface.padEnd(13)} ${row.action}${row.specs.length ? ` <- ${row.specs.join(", ")}` : ""}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = buildCoverageReport();
  printCoverageReport(report);
  if (report.uncovered > 0 && !process.argv.includes("--allow-incomplete")) {
    console.error(
      `INCOMPLETE: ${report.uncovered} of ${report.actions.length} actions have no runnable spec. ` +
        "Do not report a green run as coverage of the full action surface.",
    );
    process.exitCode = 1;
  }
}
