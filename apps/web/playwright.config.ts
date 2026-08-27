import { defineConfig } from "@playwright/test";

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
    // USE THE INSTALLED CHROME, NOT PLAYWRIGHT'S BUNDLED BUILD.
    //
    // `@playwright/test` 1.60 asks its registry for chromium-1223; what is
    // installed here is 1228, so a default launch dies with "Executable doesn't
    // exist at .../chromium_headless_shell-1223/...". Resolving by CHANNEL asks
    // the OS for the browser it actually has, which is also the only form that
    // works on the build box — pinning an absolute per-user ms-playwright cache
    // path is what made the previous rig physically unable to run there.
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
