import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { restartBackend, root, startBackend, startWeb } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const selfCheck = process.argv.includes("--self-check");

function assertNoSleepSync() {
  const offenders = [];
  for (const rel of ["e2e/run.mjs", "e2e/fixtures.mjs"]) {
    const src = readFileSync(join(root, rel), "utf8");
    if (/\.waitForTimeout\s*\(/.test(src)) offenders.push(rel);
  }
  if (offenders.length) throw new Error(`e2e harness uses page.waitForTimeout: ${offenders.join(", ")}`);
}

async function assertActionSpecs() {
  await import("../apps/web/e2e/actions/chat-new-draft-promotion.spec.ts").catch(async () => {
    await import("../apps/web/e2e/actions/verify-chat-new-draft-promotion.mjs");
  });
  await import("../apps/web/e2e/actions/noop-commands-16.spec.ts").catch(async () => {
    await import("../apps/web/e2e/actions/verify-noop-commands-16.mjs");
  });
  await import("../apps/web/e2e/actions/diff-source-control-right-panel.spec.ts").catch(async () => {
    await import("../apps/web/e2e/actions/verify-diff-source-control-right-panel.mjs");
  });
}

async function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch (rootError) {
    try {
      return require(join(root, "apps/desktop/node_modules/playwright-core")).chromium;
    } catch {
      throw rootError;
    }
  }
}

async function runSelfCheck() {
  assertNoSleepSync();
  if (existsSync(join(here, "drive-real-ui.cjs"))) {
    throw new Error("legacy e2e/drive-real-ui.cjs still exists");
  }
  if (typeof restartBackend !== "function") {
    throw new Error("restartBackend fixture is not exported");
  }
  await assertActionSpecs();
  console.log("E2E_SELF_CHECK ok restartBackend fixture, action specs, no waitForTimeout, no drive-real-ui.cjs");
}

async function runRealUi() {
  const backend = await startBackend();
  let web;
  let browser;
  try {
    web = await startWeb({ backendPort: backend.port });
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(web.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const composer = page.locator('[contenteditable="true"], [role="textbox"], textarea').first();
    try {
      await composer.waitFor({ state: "visible", timeout: 60_000 });
    } catch (error) {
      const body = await page.evaluate(() => document.body.innerText).catch(() => "");
      throw new Error(
        `composer did not become visible at ${page.url()}: ${error.message}\n${body.slice(0, 1200)}`,
      );
    }
    const restarted = await restartBackend(backend);
    await restarted.stop();
    console.log(`E2E_REAL_UI ok web=${web.url} backend=${backend.url}`);
  } finally {
    if (browser) await browser.close();
    if (web) await web.stop();
    await backend.stop();
  }
}

if (selfCheck) {
  await runSelfCheck();
} else {
  await runRealUi();
}
