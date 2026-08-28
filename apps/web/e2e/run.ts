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

// TWO REPORTERS, ON PURPOSE. `spec` is readable, but it drops the error body
// when a failure originates in a `before` hook — which is where a real-stack
// suite fails most often, and a run that prints three red lines and no reason
// is worse than no run at all. `tap` carries the full diagnostic including the
// stack and the assertion message, so the reason always survives somewhere.
const tapPath = process.env.T3_E2E_TAP ?? "/tmp/t3-e2e.tap";
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`,
    ...specs,
  ],
  { stdio: "inherit", cwd: path.resolve(HERE, "..", "..", "..") },
);

// Echo the failures out of the TAP stream so a terminal reader never has to be
// told to go and open a file to find out what broke.
try {
  const tap = fs.readFileSync(tapPath, "utf8");
  const failures = tap
    .split(/\nnot ok /)
    .slice(1)
    .map((chunk) => "not ok " + chunk.split(/\n(?:ok|not ok|# )/)[0]);
  if (failures.length > 0) {
    console.log(`\n=== ${failures.length} FAILURE(S), full diagnostic ===\n`);
    for (const failure of failures) console.log(failure.slice(0, 4000) + "\n");
  }
  console.log(`=== full TAP: ${tapPath}`);
} catch {
  console.log(`(no TAP written at ${tapPath})`);
}

process.exit(result.status ?? 1);
