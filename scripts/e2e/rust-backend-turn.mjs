/**
 * #27 — the real T3 Code web bundle driven against the RUST backend.
 *
 * This is the "equivalent e2e harness that uses the actual app bundle and
 * WebSocket/RPC transport" the finding asks for. It is deliberately NOT a
 * reducer unit test: it launches real Chrome, loads the real Vite-served
 * bundle, types into the real Lexical composer with real CDP key events, and
 * reads the real Effect-RPC frames off the app's own socket.
 *
 * Why CDP input and not synthetic events: the composer is Lexical, which builds
 * its model from `beforeinput`. Synthetic KeyboardEvents and writes to
 * .value/.textContent do nothing — that is what blocked the reins-driven
 * attempt (channel attempt_id 9).
 *
 * Prereqs, single-origin per AGENTS.md rule 3 (never bake VITE_*_URL):
 *   t3code-server on :13774   (ssh -L if it runs on the build box)
 *   T3CODE_PORT=13774 T3CODE_SINGLE_ORIGIN_DEV=1 vp dev --port 5199
 *
 * Usage: node scripts/e2e/rust-backend-turn.mjs [appUrl]
 */
import { createRequire } from "node:module";

/**
 * playwright-core is a dependency of `apps/desktop`, not of this script's
 * package, so a bare `require("playwright-core")` from `scripts/e2e/` throws
 * MODULE_NOT_FOUND — the harness could not run from the directory it lives in.
 * Resolve it against the workspaces that actually declare it, and say WHERE it
 * was found so a wrong copy is visible rather than silent.
 */
const REPO_ROOT = new URL("../../", import.meta.url).pathname;
function loadPlaywright() {
  const roots = [
    import.meta.url,
    `file://${REPO_ROOT}apps/desktop/package.json`,
    `file://${REPO_ROOT}package.json`,
  ];
  const tried = [];
  for (const from of roots) {
    try {
      return createRequire(from)("playwright-core");
    } catch (e) {
      tried.push(`${from}: ${e.code ?? e.message}`);
    }
  }
  throw new Error(`playwright-core not resolvable. Tried:\n  ${tried.join("\n  ")}`);
}
const { chromium } = loadPlaywright();

/**
 * The bundled browser is NOT usable: playwright-core 1.60 asks its registry for
 * chromium-1223 while chromium-1228 is what is installed, so `launch()` with no
 * executable fails. Prefer the installed Chrome/Chromium; fall back to whatever
 * the registry does resolve. Never hardcode an absolute per-user cache path —
 * that is what made the previous rig physically unable to run on the build box.
 */
async function launchBrowser() {
  const attempts = [
    { channel: "chrome", headless: true },
    { channel: "chromium", headless: true },
    { headless: true },
  ];
  const tried = [];
  for (const opts of attempts) {
    try {
      const b = await chromium.launch(opts);
      console.log(`browser: ${JSON.stringify(opts)}`);
      return b;
    } catch (e) {
      tried.push(`${JSON.stringify(opts)}: ${e.message.split("\n")[0]}`);
    }
  }
  throw new Error(`no launchable browser. Tried:\n  ${tried.join("\n  ")}`);
}

const APP = process.argv[2] ?? "http://127.0.0.1:5199/";
const PROMPT = "Reply with exactly the word PONG and nothing else.";
const step = (n, m) => console.log(`\n=== ${n} :: ${m}`);

const frames = [];
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await launchBrowser();
const page = await browser.newPage();

// Record every Effect-RPC frame on the app's socket, both directions.
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => frames.push({ dir: "c2s", payload: String(f.payload) }));
  ws.on("framereceived", (f) => frames.push({ dir: "s2c", payload: String(f.payload) }));
});
const rpc = (tag) => frames.filter((f) => f.payload.includes(`"${tag}"`));

try {
  step(1, "boot the real bundle against the Rust backend");
  // `domcontentloaded` is the WRONG event for this app in dev. The entry is a
  // deferred module script, so DOMContentLoaded does not fire until the whole
  // module graph has been fetched and executed — minutes on a cold unbundled
  // graph — and the harness reported "the app does not boot" for what was
  // actually a cold cache. Commit, then wait for the thing we actually need.
  await page.goto(APP, { waitUntil: "commit", timeout: 60_000 });
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 180_000 });
  check("composer renders", true, `url=${page.url()}`);
  check("landed on a draft route", /\/draft\//.test(page.url()), page.url());

  step(2, "type into the real Lexical composer via CDP key events");
  await composer.click();
  await page.keyboard.type(PROMPT, { delay: 8 });
  const typed = (await composer.innerText()).trim();
  check("composer holds the typed prompt", typed.includes("PONG"), JSON.stringify(typed));
  if (!typed.includes("PONG"))
    throw new Error("composer never received text — cannot drive a turn");

  step(3, "send — draft promotion");
  const draftUrl = page.url();
  await page.getByRole("button", { name: /send message/i }).click();
  await page.waitForURL((u) => !/\/draft\//.test(String(u)), { timeout: 60_000 }).catch(() => {});
  check(
    "draft promoted to a real thread route",
    page.url() !== draftUrl,
    `${draftUrl} -> ${page.url()}`,
  );
  // Count only frames the CLIENT sent: the tag string also appears inside
  // server config/catalog payloads, so an undirected match reports a turn that
  // was never dispatched.
  const sentTurn = frames.filter(
    (f) =>
      f.dir === "c2s" &&
      /"tag":"(orchestration\.dispatchCommand|thread\.turn\.start)"/.test(f.payload),
  );
  check(
    "client actually dispatched a turn",
    sentTurn.length > 0,
    `${sentTurn.length} turn-dispatch request(s) sent by the client`,
  );

  step(4, "streaming reply + spinner settlement");
  // Scope the assertion to the transcript, NOT document.body: the prompt is
  // still sitting in the composer, so a body-wide /PONG/ match passes whether
  // or not the assistant ever answered. That earlier version was a tautology.
  const settled = await page
    .waitForFunction(
      () => {
        const composer = document.querySelector('[contenteditable="true"]');
        const composerText = composer ? composer.innerText : "";
        const body = document.body.innerText;
        const outside = composerText ? body.split(composerText).join(" ") : body;
        return /PONG/i.test(outside);
      },
      undefined,
      { timeout: 90_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("assistant text rendered OUTSIDE the composer", settled);
  check(
    "assistant delta/complete frames observed",
    rpc("thread.message.assistant.delta").length > 0 ||
      rpc("thread.message.assistant.complete").length > 0,
    `${rpc("thread.message.assistant.delta").length} delta, ${rpc("thread.message.assistant.complete").length} complete`,
  );

  step(5, "reload → reconnect → history replay");
  const threadUrl = page.url();
  const before = (await page.locator("body").innerText()).length;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  const composerBack = await page
    .locator('[contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  check("composer re-renders after reload", composerBack);
  const replayed = await page
    .waitForFunction(() => document.body.innerText.length > 200, undefined, { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  check("thread route survives reload", page.url() === threadUrl, page.url());
  check("history replayed after reconnect", replayed, `body was ${before} chars before reload`);
} catch (e) {
  console.log(`\nHARNESS ERROR: ${e.message}`);
  failures++;
} finally {
  step("frames", `${frames.length} websocket frames captured`);
  for (const t of [
    "server.getConfig",
    "dispatchCommand",
    "thread.turn.start",
    "thread.message.assistant.delta",
    "thread.message.assistant.complete",
    "subscribeThread",
  ]) {
    console.log(`  ${String(rpc(t).length).padStart(4)}  ${t}`);
  }
  console.log("\nFIRST 12 NON-KEEPALIVE FRAMES:");
  for (const f of frames.filter((x) => !/"(Ping|Pong)"/.test(x.payload)).slice(0, 12)) {
    console.log(`  ${f.dir} ${f.payload.slice(0, 260)}`);
  }
  await browser.close();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
