import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * Which browser to launch, decided at config load instead of asserted (#483).
 *
 * `channel: "chrome"` asks the OS for BRANDED Google Chrome. On a dev laptop
 * that is right, and it is the only thing that works there: @playwright/test
 * 1.60 asks its registry for chromium-1223 while 1228 is what is installed, so
 * a default launch dies with "Executable doesn't exist at
 * .../chromium_headless_shell-1223/...".
 *
 * On woodbine there is no branded Chrome at all. `channel: "chrome"` resolves
 * to /opt/google/chrome/chrome, which does not exist, and every spec fails
 * before it starts — proven A/B in evidence build-log-ad0706cbf38bb320, where
 * the managed chromium LAUNCHED and channel:"chrome" FAILED in the same run of
 * the same script. A hardcoded channel therefore cannot be right in both
 * places, and the CI box is the one that matters for the coverage gate.
 *
 * So: use the channel only when a branded Chrome actually resolves, and
 * otherwise fall back to Playwright's managed chromium. Neither environment
 * needs to be special-cased by hand, and adding a Chrome to the box later
 * silently upgrades it rather than breaking it.
 *
 * `T3CODE_E2E_BROWSER_CHANNEL` overrides both ways: set it to a channel name to
 * force one, or to "chromium" to force the managed build.
 */
const CHROME_CANDIDATES = [
  "/opt/google/chrome/chrome",
  "/opt/google/chrome/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const brandedChromeExists = (): boolean => {
  if (CHROME_CANDIDATES.some((p) => existsSync(p))) return true;
  // Also honour PATH, so a box with Chrome installed somewhere unusual works
  // without this list growing forever.
  const path = process.env.PATH ?? "";
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) =>
      ["google-chrome", "google-chrome-stable", "chrome"].some((bin) =>
        existsSync(join(dir, bin)),
      ),
    );
};

const forced = process.env.T3CODE_E2E_BROWSER_CHANNEL?.trim();
const channel =
  forced === "chromium" ? undefined : forced ? forced : brandedChromeExists() ? "chrome" : undefined;

/**
 * THE e2e CONFIG. Singular, deliberately.
 *
 * Seven separate E2E intakes were filed on this channel within about twenty
 * minutes, each enumerating the same surfaces under different task ids, and two
 * reviewers independently warned that they would fork into seven harnesses.
 * This is the one. If you are about to add a second config, absorb this instead.
 *
 * There is no `webServer` block on purpose. The app is TWO processes (the Rust
 * backend and the web dev server) and the port is hashed per worktree, so a
 * config-level `webServer` would either hardcode a port — and then attach to a
 * DIFFERENT CELL'S APP, which is worse than failing — or silently start a
 * second stack. `e2e/fixtures.ts` owns the lifecycle and reads the port off the
 * process it started.
 */
export default defineConfig({
  testDir: "./e2e",
  // These drive a real backend and a real agent; they are not unit tests.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  // One worker: the specs share one backend and one T3 home. Parallel workers
  // would race on the same durable state and produce failures that belong to
  // the harness rather than the product.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    // Browser selection: see the note on `channel` above. Never pin an absolute
    // per-user ms-playwright cache path — that is what made the previous rig
    // physically unable to run on the build box.
    // Resolved above (#483): the branded channel where it exists, Playwright's
    // managed chromium where it does not. `undefined` is the managed build.
    ...(channel === undefined ? {} : { channel }),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
