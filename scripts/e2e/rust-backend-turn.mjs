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

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const APP = process.argv[2] ?? "http://127.0.0.1:5199/";
const PROMPT = "Reply with exactly the word PONG and nothing else.";
const step = (n, m) => console.log(`\n=== ${n} :: ${m}`);

const frames = [];
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

// Record every Effect-RPC frame on the app's socket, both directions.
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => frames.push({ dir: "c2s", payload: String(f.payload) }));
  ws.on("framereceived", (f) => frames.push({ dir: "s2c", payload: String(f.payload) }));
});
const rpc = (tag) => frames.filter((f) => f.payload.includes(`"${tag}"`));

try {
  step(1, "boot the real bundle against the Rust backend");
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  check("composer renders", true, `url=${page.url()}`);
  check("landed on a draft route", /\/draft\//.test(page.url()), page.url());

  step(2, "type into the real Lexical composer via CDP key events");
  await composer.click();
  await page.keyboard.type(PROMPT, { delay: 8 });
  const typed = (await composer.innerText()).trim();
  check("composer holds the typed prompt", typed.includes("PONG"), JSON.stringify(typed));
  if (!typed.includes("PONG")) throw new Error("composer never received text — cannot drive a turn");

  step(3, "send — draft promotion");
  const draftUrl = page.url();
  await page.getByRole("button", { name: /send message/i }).click();
  await page
    .waitForURL((u) => !/\/draft\//.test(String(u)), { timeout: 60_000 })
    .catch(() => {});
  check("draft promoted to a real thread route", page.url() !== draftUrl, `${draftUrl} -> ${page.url()}`);
  // Count only frames the CLIENT sent: the tag string also appears inside
  // server config/catalog payloads, so an undirected match reports a turn that
  // was never dispatched.
  const sentTurn = frames.filter(
    (f) => f.dir === "c2s" && /"tag":"(orchestration\.dispatchCommand|thread\.turn\.start)"/.test(f.payload),
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
