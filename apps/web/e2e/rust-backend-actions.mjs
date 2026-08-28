import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const appUrl = process.env.T3_E2E_APP_URL ?? "http://127.0.0.1:5733/";
const outPath = process.env.T3_E2E_ACTION_TABLE ?? join(root, "apps/web/e2e/.last-rust-actions.json");
const inventoryOnly = process.argv.includes("--inventory-only");

function source(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function literalValues(block) {
  return [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
}

function constBlock(src, name) {
  const start = src.indexOf(`export const ${name} = {`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = src.indexOf("} as const", start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return src.slice(start, end);
}

function unique(values) {
  return [...new Set(values)].sort();
}

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) ?? null;
}

function playwrightCacheDirs() {
  const home = process.env.HOME;
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    home ? join(home, ".cache/ms-playwright") : null,
    home ? join(home, "Library/Caches/ms-playwright") : null,
  ].filter(Boolean);
}

function cachedChromiumExecutable() {
  if (process.env.T3_E2E_CHROME) return process.env.T3_E2E_CHROME;
  for (const cacheDir of playwrightCacheDirs()) {
    if (!existsSync(cacheDir)) continue;
    for (const entry of readdirSync(cacheDir)) {
      const root = join(cacheDir, entry);
      const candidate = firstExisting([
        join(root, "chrome-linux64/chrome"),
        join(root, "chrome-linux/chrome"),
        join(root, "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
        join(root, "chrome-win/chrome.exe"),
        join(root, "headless_shell"),
        join(root, "chrome-linux/headless_shell"),
      ]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function inventoryContracts() {
  const rpc = source("packages/contracts/src/rpc.ts");
  const orchestration = source("packages/contracts/src/orchestration.ts");
  const wsMethods = unique(literalValues(constBlock(rpc, "WS_METHODS")));
  const orchestrationMethods = unique(literalValues(constBlock(orchestration, "ORCHESTRATION_WS_METHODS")));
  const commands = unique([
    ...orchestration.matchAll(/type:\s*Schema\.Literal\("([^"]+)"\)/g),
  ].map((m) => m[1]));
  return { wsMethods, orchestrationMethods, commands };
}

function chromeLaunchOptions() {
  const executablePath = cachedChromiumExecutable();
  return executablePath ? { executablePath } : { channel: "chrome" };
}

function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch (webError) {
    try {
      return require(join(root, "apps/desktop/node_modules/playwright-core")).chromium;
    } catch {
      throw webError;
    }
  }
}

function rpcPayload(frame) {
  try {
    return JSON.parse(frame.payload);
  } catch {
    return null;
  }
}

function frameContainsFinalAssistant(frame) {
  const parsed = rpcPayload(frame);
  const values = parsed?.values;
  if (!Array.isArray(values)) return false;
  return values.some((v) => {
    const payload = v?.event?.payload ?? v?.payload;
    return payload?.role === "assistant" && payload?.streaming === false;
  });
}

const rows = [];
const record = (area, action, status, detail = "") => {
  rows.push({ area, action, status, detail });
  console.log(`${status.padEnd(5)} ${area} ${action}${detail ? ` :: ${detail}` : ""}`);
};

const launchOptions = chromeLaunchOptions();
const chromiumPath = launchOptions.executablePath ?? "channel:chrome";
console.log(`PROVENANCE node=${process.version}`);
console.log(`PROVENANCE chromium=${chromiumPath}`);
console.log(`PROVENANCE playwrightCache=${playwrightCacheDirs().join(":") || "(none)"}`);

const contracts = inventoryContracts();
if (contracts.wsMethods.length < 80) {
  throw new Error(`WS_METHODS inventory collapsed: ${contracts.wsMethods.length}`);
}
if (contracts.orchestrationMethods.length < 8) {
  throw new Error(`ORCHESTRATION_WS_METHODS inventory collapsed: ${contracts.orchestrationMethods.length}`);
}
if (contracts.commands.length < 20) {
  throw new Error(`orchestration command inventory collapsed: ${contracts.commands.length}`);
}

for (const method of contracts.wsMethods) record("ws-method", method, "NOOP", "inventoried from packages/contracts/src/rpc.ts");
for (const method of contracts.orchestrationMethods) {
  record("orchestration-method", method, "NOOP", "inventoried from packages/contracts/src/orchestration.ts");
}
for (const command of contracts.commands) {
  record("orchestration-command", command, "NOOP", "inventoried from DispatchableClientOrchestrationCommand literals");
}

if (inventoryOnly) {
  writeFileSync(outPath, JSON.stringify({ appUrl, inventoryOnly, rows, framesCaptured: 0 }, null, 2));
  console.log(`\nACTION_TABLE ${outPath}`);
  console.log(`SUMMARY pass=0 fail=0 noop=${rows.length}`);
  process.exit(0);
}

const chromium = loadChromium();
const browser = await chromium.launch({ ...launchOptions, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const frames = [];
page.on("websocket", (ws) => {
  ws.on("framesent", (frame) => frames.push({ dir: "c2s", payload: String(frame.payload) }));
  ws.on("framereceived", (frame) => frames.push({ dir: "s2c", payload: String(frame.payload) }));
});

try {
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('[contenteditable="true"], [role="textbox"], textarea').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  await composer.click();
  await composer.fill("Reply with exactly the word PONG and nothing else.");
  await page.keyboard.press("Enter");
  const finalAssistant = await page
    .waitForFunction(() => false, undefined, { timeout: 250 })
    .catch(() => frames.some((frame) => frame.dir === "s2c" && frameContainsFinalAssistant(frame)));
  record(
    "ui-action",
    "composer.fill+Enter",
    finalAssistant ? "PASS" : "FAIL",
    finalAssistant ? "wire saw assistant streaming=false" : "no final assistant frame observed",
  );

  const controls = await page
    .locator("button[aria-label], [role=button][aria-label], button[title], [role=menuitem], a[aria-label]")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || "")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const uniqueControls = unique(controls);
  if (uniqueControls.length === 0) {
    record("rendered-control", "aria/title inventory", "FAIL", "no labeled controls found in rendered DOM");
  } else {
    for (const label of uniqueControls) {
      record("rendered-control", label, "NOOP", "visible labeled control inventoried from rendered DOM");
    }
  }

  const keybindingsFrame = frames
    .filter((frame) => frame.dir === "s2c")
    .map(rpcPayload)
    .find((msg) => JSON.stringify(msg).includes('"keybindings"'));
  const keybindings = JSON.stringify(keybindingsFrame ?? "").match(/"command":"([^"]+)"/g) ?? [];
  for (const command of unique(keybindings.map((s) => s.slice(11, -1)))) {
    record("keybinding", command, "NOOP", "reported by server.getConfig/config snapshot");
  }
} finally {
  await browser.close();
}

const failed = rows.filter((row) => row.status === "FAIL");
writeFileSync(outPath, JSON.stringify({ appUrl, rows, framesCaptured: frames.length }, null, 2));
console.log(`\nACTION_TABLE ${outPath}`);
console.log(`SUMMARY pass=${rows.filter((r) => r.status === "PASS").length} fail=${failed.length} noop=${rows.filter((r) => r.status === "NOOP").length}`);
process.exit(failed.length === 0 ? 0 : 1);
