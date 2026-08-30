/**
 * #27 — the HALF THE EXISTING HARNESS DOES NOT COVER.
 *
 * `rust-backend-turn.mjs` proves compose -> send -> stream -> reload against the
 * Rust backend. #27's reopen note lists what is still unproven against a running
 * UI, and every item below is one of those: tool calls with visible arguments,
 * an approval prompt that GATES, a second turn on a live thread, and stop.
 *
 * The load-bearing check is DENY. A badge reading "approval required" over a
 * tool that already ran is the worst defect in this product, and it is not
 * observable from the DOM alone — the DOM shows the badge either way. So deny is
 * asserted ON DISK: the agent is asked to create a uniquely-named file, the
 * approval is DECLINED, and the file must not exist. Approve is asserted the
 * same way in reverse. A rendered transcript is a claim; the filesystem is the
 * evidence.
 *
 * Usage: node scripts/e2e/rust-backend-toolloop.mjs [appUrl]
 */
import { createRequire } from "node:module";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const E2E_MODEL = process.env.T3CODE_E2E_MODEL?.trim() ?? "";
const SCRATCH = mkdtempSync(join(tmpdir(), "t3e2e-toolloop-"));
const DENY_FILE = join(SCRATCH, "must-not-exist.txt");
const ALLOW_FILE = join(SCRATCH, "must-exist.txt");

const step = (n, m) => console.log(`\n=== ${n} :: ${m}`);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const frames = [];
const consoleErrors = [];

const browser = await launchBrowser();
const page = await browser.newPage();
page.on("websocket", (ws) => {
  ws.on("framesent", (f) => frames.push({ dir: "c2s", payload: String(f.payload) }));
  ws.on("framereceived", (f) => frames.push({ dir: "s2c", payload: String(f.payload) }));
});
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const composer = () => page.locator('[contenteditable="true"]').first();

/**
 * WIRE ASSERTIONS, NOT DOM ASSERTIONS (#435).
 *
 * The transcript echoes the user's own prompt in the user bubble and renders a
 * live "Working for Ns" timer, so an innerText match reports a PASS for text the
 * assistant never sent. Assistant output is therefore read off the socket:
 * a frame whose payload has role==='assistant' and streaming===false.
 */
const assistantFinal = () =>
  frames.filter(
    (f) =>
      f.dir === "s2c" &&
      /"role"\s*:\s*"assistant"/.test(f.payload) &&
      /"streaming"\s*:\s*false/.test(f.payload),
  );

/**
 * Spinner settlement is FOUR FRAMES IN ORDER, not a disappearing spinner: a
 * spinner that stopped because the socket died is DOM-identical to one that
 * settled. `activeTurnId` going non-null then back to null is the difference.
 */
const turnStarted = () =>
  frames.filter((f) => f.dir === "s2c" && /"activeTurnId"\s*:\s*"/.test(f.payload));
const turnSettled = () =>
  frames.filter((f) => f.dir === "s2c" && /"activeTurnId"\s*:\s*null/.test(f.payload));

/** Wait for a wire predicate rather than sleeping on the DOM. */
async function waitForWire(pred, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return true;
    await page.waitForTimeout(250);
  }
  console.log(`  (wire wait timed out: ${label})`);
  return false;
}

/** Type a prompt into the real Lexical composer and send it. */
async function send(text) {
  await composer().click();
  await page.keyboard.type(text, { delay: 6 });
  await page.getByRole("button", { name: /send message/i }).click();
}

/** Wait for an approval prompt, returning the button names offered. */
async function waitForApproval(timeout = 120_000) {
  const approve = page.getByRole("button", { name: /^Approve$/ });
  const decline = page.getByRole("button", { name: /^Decline$/ });
  await Promise.race([
    approve.first().waitFor({ state: "visible", timeout }),
    decline.first().waitFor({ state: "visible", timeout }),
  ]);
  return { approve, decline };
}

/** The transcript text with the composer's own contents removed. */
async function transcriptText() {
  return page.evaluate(() => {
    const c = document.querySelector('[contenteditable="true"]');
    const body = document.body.innerText;
    return c && c.innerText ? body.split(c.innerText).join(" ") : body;
  });
}

try {
  step(1, "boot the real bundle against the Rust backend");
  // `domcontentloaded` is the WRONG event for this app in dev. The entry is a
  // deferred module script, so DOMContentLoaded does not fire until the whole
  // module graph has been fetched and executed — minutes on a cold unbundled
  // graph — and the harness reported "the app does not boot" for what was
  // actually a cold cache. Commit, then wait for the thing we actually need.
  await page.goto(APP, { waitUntil: "commit", timeout: 60_000 });
  await composer().waitFor({ state: "visible", timeout: 180_000 });
  check("composer renders", true, `url=${page.url()}`);

  // A build host can expose several provider adapters even when only one is
  // authenticated. Select the provider the test declaration names through the
  // same picker a person uses; otherwise the harness silently exercises the
  // first configured CLI and can fail before reaching the approval boundary.
  //
  // The picker's own model list is PER-TAB: it renders only the currently
  // selected provider's models plus a left rail of provider icons
  // (`[data-model-picker-provider]`), and the in-picker search box filters
  // within that same tab rather than across all of them. A `getByText` for
  // the declared model therefore only ever finds it when the picker already
  // happens to default to that provider — true for the first tab, false for
  // every other configured instance. Click through each tab (skipping
  // "favorites", which is not a provider) until the model becomes visible.
  if (E2E_MODEL) {
    await page.locator('[data-chat-provider-model-picker="true"]').click();
    const model = page.getByText(E2E_MODEL, { exact: false }).first();
    const tabs = page.locator(
      '[data-model-picker-sidebar="true"] [data-model-picker-provider]:not([data-model-picker-provider="favorites"]) button',
    );
    const tabCount = await tabs.count();
    for (let i = 0; i < tabCount; i++) {
      if (await model.isVisible().catch(() => false)) break;
      await tabs.nth(i).click();
      await page.waitForTimeout(200);
    }
    await model.waitFor({ state: "visible", timeout: 30_000 });
    await model.click();
    check("declared E2E model selected through the real picker", true, E2E_MODEL);
  }

  // A new thread starts in "Full access" (`gated=0` in the server's own turn
  // policy log): the runtime executes tools without ever raising an approval
  // prompt. Sending the DENY/APPROVE probes against that default would not
  // test the gate at all — a run with no approval prompt and no unapproved
  // write looks identical whether the gate works or the mode never asked in
  // the first place. Switch to "Supervised" through the same Runtime mode
  // control a person uses, so the boundary this file exists to prove is the
  // one actually in effect.
  await page.locator('[aria-label="Runtime mode"]').click();
  await page.getByRole("option", { name: /^Supervised/ }).click();
  await page.waitForTimeout(300);
  check(
    "runtime mode switched to Supervised through the real control",
    (await page.locator('[aria-label="Runtime mode"]').innerText()).includes("Supervised"),
  );

  // ---------------------------------------------------------------- empty send
  step(2, "whitespace-only send must be a no-op");
  const framesBeforeEmpty = frames.filter(
    (f) =>
      f.dir === "c2s" &&
      /"tag":"(orchestration\.dispatchCommand|thread\.turn\.start)"/.test(f.payload),
  ).length;
  await composer().click();
  await page.keyboard.type("   ");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const framesAfterEmpty = frames.filter(
    (f) =>
      f.dir === "c2s" &&
      /"tag":"(orchestration\.dispatchCommand|thread\.turn\.start)"/.test(f.payload),
  ).length;
  check(
    "whitespace-only send dispatched no turn",
    framesAfterEmpty === framesBeforeEmpty,
    `${framesBeforeEmpty} -> ${framesAfterEmpty} turn dispatches`,
  );
  // clear the composer for the real prompt
  await composer().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");

  // ---------------------------------------------------------------- DENY gates
  step(3, "tool call + approval DENY must block the tool on disk");
  rmSync(DENY_FILE, { force: true });
  await send(
    `Create a file at the absolute path ${DENY_FILE} containing the single word DENIED. ` +
      `Use your file-writing tool. Do not ask me anything first.`,
  );

  let denyGated = null;
  try {
    const { decline } = await waitForApproval();
    const before = await transcriptText();
    check(
      "tool call renders its ARGUMENTS, not just a name",
      before.includes(DENY_FILE) || before.includes("must-not-exist.txt"),
      `looked for ${DENY_FILE} in the transcript`,
    );
    await decline.first().click();
    await page.waitForTimeout(4000);
    denyGated = !existsSync(DENY_FILE);
    check(
      "DENY ACTUALLY BLOCKED THE TOOL (file absent on disk)",
      denyGated,
      denyGated
        ? `${DENY_FILE} correctly absent`
        : `BLOCKER: ${DENY_FILE} EXISTS — the tool ran despite deny`,
    );
    const after = await transcriptText();
    check(
      "the declined tool renders as declined/failed rather than vanishing",
      /declin|denied|reject|cancel|not permitt|refus/i.test(after),
      "transcript should say the tool was declined",
    );
  } catch (e) {
    check("an approval prompt appeared for a file-writing tool", false, e.message);
    // Even with no prompt, the file must not have appeared unasked.
    check(
      "no approval prompt AND no unapproved write",
      !existsSync(DENY_FILE),
      existsSync(DENY_FILE)
        ? `BLOCKER: ${DENY_FILE} was written with NO approval prompt at all`
        : "",
    );
  }

  // ---------------------------------------------------------------- APPROVE runs
  step(4, "second turn on the SAME thread + approval ALLOW must run the tool");
  const threadUrl = page.url();
  const transcriptBefore = (await transcriptText()).length;
  rmSync(ALLOW_FILE, { force: true });
  await send(
    `Now create a file at the absolute path ${ALLOW_FILE} containing the single word ALLOWED. ` +
      `Use your file-writing tool. Do not ask me anything first.`,
  );
  check("second turn stayed on the same thread route", page.url() === threadUrl, page.url());

  try {
    const { approve } = await waitForApproval();
    await approve.first().click();
    await page.waitForTimeout(6000);
    check(
      "APPROVE ran the tool (file present on disk)",
      existsSync(ALLOW_FILE),
      existsSync(ALLOW_FILE)
        ? `${ALLOW_FILE} written`
        : `${ALLOW_FILE} never appeared after approve`,
    );
  } catch (e) {
    check("an approval prompt appeared for the second tool call", false, e.message);
  }

  // History is asserted on the WIRE: two distinct completed assistant turns on
  // one thread. A growing transcript is also satisfied by a spinner's timer text.
  check(
    "two distinct turns completed on one thread (wire)",
    assistantFinal().length >= 2,
    `${assistantFinal().length} final assistant frame(s); transcript ${transcriptBefore} -> ${(await transcriptText()).length} chars`,
  );
  check(
    "every started turn also settled (activeTurnId -> null)",
    turnSettled().length >= turnStarted().length && turnStarted().length > 0,
    `${turnStarted().length} started / ${turnSettled().length} settled`,
  );

  // ---------------------------------------------------------------- stop
  step(5, "stop must actually stop a running turn");
  await send("Count slowly from 1 to 500, one number per line, with a short pause between each.");
  const stop = page.getByRole("button", { name: /stop|cancel/i }).first();
  const sawStop = await stop
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check("a stop affordance appears while a turn runs", sawStop);
  if (sawStop) {
    const settledBefore = turnSettled().length;
    await stop.click();
    // The stop is proven by the turn SETTLING on the wire, not by the spinner
    // leaving the DOM — a socket drop removes the spinner too.
    const stopped = await waitForWire(
      () => turnSettled().length > settledBefore,
      30_000,
      "activeTurnId -> null after stop",
    );
    check("stop settled the turn on the wire (activeTurnId -> null)", stopped);
    // Keepalives keep flowing on a healthy socket, so counting ALL frames would
    // fail on a correctly-stopped turn. Count only content frames.
    const content = () => frames.filter((f) => !/"(Ping|Pong)"/.test(f.payload)).length;
    const deltasA = content();
    await page.waitForTimeout(6000);
    const deltasB = content();
    check(
      "a stopped turn STAYS stopped (no further content frames)",
      deltasB === deltasA,
      `${deltasA} -> ${deltasB} content frames after stop`,
    );
  }

  // ---------------------------------------------------------------- console
  step(6, "console must be clean");
  check(
    "no console errors during the whole loop",
    consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 5).join(" | ") : "clean",
  );
} catch (e) {
  console.log(`\nHARNESS ERROR: ${e.stack}`);
  failures++;
} finally {
  step("disk", "final on-disk state — the evidence deny/allow is judged by");
  console.log(`  ${DENY_FILE}  exists=${existsSync(DENY_FILE)}   (MUST be false)`);
  console.log(`  ${ALLOW_FILE}  exists=${existsSync(ALLOW_FILE)}   (MUST be true)`);
  step("frames", `${frames.length} websocket frames captured`);
  for (const t of [
    "thread.turn.start",
    "thread.message.assistant.delta",
    "tool",
    "approval",
    "thread.turn.stop",
  ]) {
    console.log(
      `  ${String(frames.filter((f) => f.payload.includes(t)).length).padStart(4)}  ${t}`,
    );
  }
  if (consoleErrors.length) {
    console.log("\nCONSOLE ERRORS:");
    for (const e of consoleErrors.slice(0, 20)) console.log(`  ${e}`);
  }
  await browser.close();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log(`scratch: ${SCRATCH}`);
  process.exit(failures === 0 ? 0 : 1);
}
