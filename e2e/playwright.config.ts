import { defineConfig } from "@playwright/test";
import { WEB_BASE } from "./rig/rig.ts";

export default defineConfig({
  testDir: "./tests",
  // One node, one web server, real model turns: the suite is serial by design.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Conversation specs drive real claude turns; give them room.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: "./rig/global-setup.ts",
  globalTeardown: "./rig/global-teardown.ts",
  reporter: [["list"], ["json", { outputFile: ".results/results.json" }]],
  use: {
    baseURL: WEB_BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
