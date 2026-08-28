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
  .filter((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"))
  .filter((f) => filters.length === 0 || filters.some((needle) => f.includes(needle)))
  .map((f) => path.join(actionsDir, f))
  .sort();

if (specs.length === 0) {
  console.error(`no specs matched ${filters.join(" ") || "(everything)"} in ${actionsDir}`);
  process.exit(2);
}

console.log(`running ${specs.length} spec file(s):\n  ${specs.join("\n  ")}\n`);

/**
 * TypeScript specs need type-stripping, and the CHILD needs it too.
 *
 * Node strips types without a flag from 22.18; woodbine runs 22.14, where it is
 * behind `--experimental-strip-types`. Passing the flag on the command line
 * only fixes THIS process — `node --test` spawns one child per spec file, and
 * those children died with
 *   ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
 * while this runner sat above them reporting `fail 1` with no hint of why. The
 * flag has to reach the children, and `execArgv` is not inherited across the
 * `--test` runner, so it goes through NODE_OPTIONS.
 *
 * Passed UNCONDITIONALLY, and the first version of this was wrong for trying to
 * be clever about it: it only propagated the flag when
 * `process.features.typescript` was undefined. But this runner is itself
 * launched with the flag on 22.14, which SETS that feature — so the condition
 * read "stripping already works" and skipped the children, which is exactly the
 * case that needed it. The flag is still accepted on versions that strip by
 * default, so there is nothing to detect and nothing to gain by detecting it.
 */
const childOptions = [process.env.NODE_OPTIONS, "--experimental-strip-types"]
  .filter(Boolean)
  .join(" ")
  .trim();

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...specs],
  {
    stdio: "inherit",
    cwd: path.resolve(HERE, "..", "..", ".."),
    env: childOptions ? { ...process.env, NODE_OPTIONS: childOptions } : process.env,
  },
);
process.exit(result.status ?? 1);
