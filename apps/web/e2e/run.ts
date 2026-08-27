#!/usr/bin/env node
/**
 * The E2E entry point. `node apps/web/e2e/run.ts [pattern...]`
 *
 * Deliberately node:test and nothing else. The runner is already in the
 * platform, so the suite adds no dependency, runs headless wherever `node`
 * runs, and prints `# pass / # fail / # skipped` — the exact numbers the
 * ratchet reads. A suite that shrank or skipped more is a FAILED run at exit 0,
 * and those three counters are how anyone can see that without trusting a
 * summary.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const actionsDir = path.join(HERE, "actions");

const specs = fs
  .readdirSync(actionsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .map((f) => path.join(actionsDir, f))
  .sort();

if (specs.length === 0) {
  console.error(`no specs matched ${filters.join(" ") || "(everything)"} in ${actionsDir}`);
  process.exit(2);
}

console.log(`running ${specs.length} spec file(s):\n  ${specs.join("\n  ")}\n`);
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...specs],
  { stdio: "inherit", cwd: path.resolve(HERE, "..", "..", "..") },
);
process.exit(result.status ?? 1);
