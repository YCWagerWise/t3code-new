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
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
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
const SCRATCH = mkdtempSync(join(tmpdir(), "t3e2e-toolloop-"));
const DENY_FILE = join(SCRATCH, "must-not-exist.txt");
const CANCEL_FILE = join(SCRATCH, "cancel-must-not-exist.txt");
const ALLOW_FILE = join(SCRATCH, "must-exist.txt");
const SESSION_FIRST_FILE = join(SCRATCH, "session-first.txt");
const SESSION_SECOND_FILE = join(SCRATCH, "session-second.txt");
const INTERRUPTED_FILE = join(SCRATCH, "interrupted-must-not-exist.txt");

const step = (n, m) => console.log(`\n=== ${n} :: ${m}`);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const shellPath = (path) => JSON.stringify(path);

const frames = [];
const frameWaiters = new Set();
const consoleErrors = [];

const browser = await launchBrowser();
const page = await browser.newPage();
page.on("websocket", (ws) => {
  const record = (dir, frame) => {
    frames.push({ dir, payload: String(frame.payload) });
    for (const notify of frameWaiters) notify();
  };
  ws.on("framesent", (f) => record("c2s", f));
  ws.on("framereceived", (f) => record("s2c", f));
});
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const composer = () => page.locator('[contenteditable="true"]').first();
const composerForm = () => page.locator('[data-chat-composer-form="true"]');

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

/** Wait for a WebSocket frame notification rather than polling or sleeping. */
async function waitForWire(pred, timeout, label) {
  if (pred()) return true;
  return new Promise((resolveWait) => {
    const finish = (value) => {
      clearTimeout(timer);
      frameWaiters.delete(onFrame);
      if (!value) console.log(`  (wire wait timed out: ${label})`);
      resolveWait(value);
    };
    const onFrame = () => {
      if (pred()) finish(true);
    };
    const timer = setTimeout(() => finish(pred()), timeout);
    frameWaiters.add(onFrame);
  });
}

/** Wait for the process side effect itself, using the filesystem notification. */
async function waitForFile(path, timeout = 120_000) {
  if (existsSync(path)) return true;
  return new Promise((resolveWait) => {
    const finish = (value) => {
      clearTimeout(timer);
      watcher.close();
      resolveWait(value);
    };
    const watcher = watch(SCRATCH, () => {
      if (existsSync(path)) finish(true);
    });
    const timer = setTimeout(() => finish(existsSync(path)), timeout);
  });
}

/** Type a prompt into the real Lexical composer and send it. */
async function send(text) {
  await composer().click();
  await page.keyboard.type(text, { delay: 6 });
  await page.getByRole("button", { name: /send message/i }).click();
}

/** Wait for an approval prompt, returning the button names offered. */
async function waitForApproval(path, timeout = 120_000) {
  const detail = composerForm().locator('[data-approval-detail="complete"]').filter({
    hasText: path,
  });
  const approve = composerForm().getByRole("button", { name: /^Approve$/ });
  const decline = composerForm().getByRole("button", { name: /^Decline$/ });
  const cancel = composerForm().getByRole("button", { name: /^Cancel$/ });
  const always = composerForm().getByRole("button", { name: /^Always allow this session$/ });
  await detail.waitFor({ state: "visible", timeout });
  return { always, approve, cancel, decline, detail };
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
    `Use the shell tool exactly once to run: printf DENIED > ${shellPath(DENY_FILE)}. ` +
      `Do not create or modify that path by another mechanism.`,
  );

  let denyGated = null;
  try {
    const { decline } = await waitForApproval(DENY_FILE);
    const before = await transcriptText();
    check(
      "tool call renders its ARGUMENTS, not just a name",
      before.includes(DENY_FILE) || before.includes("must-not-exist.txt"),
      `looked for ${DENY_FILE} in the transcript`,
    );
    const settledBeforeDeny = turnSettled().length;
    await decline.first().click();
    const denySettled = await waitForWire(
      () => turnSettled().length > settledBeforeDeny,
      120_000,
      "declined turn settlement",
    );
    check("declined turn reached a durable terminal state", denySettled);
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

  // --------------------------------------------------------------- CANCEL gates
  step(4, "approval CANCEL must also block the tool on disk");
  rmSync(CANCEL_FILE, { force: true });
  await send(
    `Use the shell tool exactly once to run: printf CANCELLED > ${shellPath(CANCEL_FILE)}. ` +
      "Do not create or modify that path by another mechanism.",
  );
  try {
    const { cancel } = await waitForApproval(CANCEL_FILE);
    const settledBeforeCancel = turnSettled().length;
    await cancel.first().click();
    const cancelSettled = await waitForWire(
      () => turnSettled().length > settledBeforeCancel,
      120_000,
      "cancelled turn settlement",
    );
    check("cancelled turn reached a durable terminal state", cancelSettled);
    check(
      "CANCEL ACTUALLY BLOCKED THE TOOL (file absent on disk)",
      !existsSync(CANCEL_FILE),
      existsSync(CANCEL_FILE)
        ? `BLOCKER: ${CANCEL_FILE} EXISTS — the tool ran despite cancel`
        : `${CANCEL_FILE} correctly absent`,
    );
  } catch (e) {
    check("a cancel-capable approval prompt appeared", false, e.message);
    check("no cancel prompt AND no unapproved write", !existsSync(CANCEL_FILE));
  }

  // ---------------------------------------------------------------- APPROVE runs
  step(5, "next turn on the SAME thread + approval ALLOW must run the tool");
  const threadUrl = page.url();
  const transcriptBefore = (await transcriptText()).length;
  rmSync(ALLOW_FILE, { force: true });
  await send(
    `Use the shell tool exactly once to run: printf ALLOWED > ${shellPath(ALLOW_FILE)}. ` +
      `Do not create or modify that path by another mechanism.`,
  );
  check("second turn stayed on the same thread route", page.url() === threadUrl, page.url());

  try {
    const { approve } = await waitForApproval(ALLOW_FILE);
    const settledBeforeApprove = turnSettled().length;
    await approve.first().click();
    const appeared = await waitForFile(ALLOW_FILE);
    const approveSettled = await waitForWire(
      () => turnSettled().length > settledBeforeApprove,
      120_000,
      "approved turn settlement",
    );
    check("approved turn reached a durable terminal state", approveSettled);
    check(
      "APPROVE ran the tool (file present on disk)",
      appeared && existsSync(ALLOW_FILE),
      appeared && existsSync(ALLOW_FILE)
        ? `${ALLOW_FILE} written`
        : `${ALLOW_FILE} never appeared after approve`,
    );
    check(
      "APPROVE granted exactly the requested write",
      existsSync(ALLOW_FILE) && readFileSync(ALLOW_FILE, "utf8").trim() === "ALLOWED",
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

  // ------------------------------------------------------- session-wide approval
  step(6, "Always allow this session applies to a later tool call in the same turn");
  rmSync(SESSION_FIRST_FILE, { force: true });
  rmSync(SESSION_SECOND_FILE, { force: true });
  const settledBeforeSession = turnSettled().length;
  await send(
    `Use two separate shell tool calls in order. First run: printf FIRST > ${shellPath(
      SESSION_FIRST_FILE,
    )}. Only after that call completes, run: printf SECOND > ${shellPath(
      SESSION_SECOND_FILE,
    )}. ` +
      "Do not combine the commands or create either path by another mechanism.",
  );
  try {
    const { always, detail } = await waitForApproval(SESSION_FIRST_FILE);
    check(
      "the first approval contains only the first write",
      !(await detail.innerText()).includes(SESSION_SECOND_FILE),
    );
    await always.first().click();
    check("first session-approved write reached disk", await waitForFile(SESSION_FIRST_FILE));

    const secondApproval = waitForApproval(SESSION_SECOND_FILE)
      .then(() => "approval")
      .catch(() => "timeout");
    const secondWrite = waitForFile(SESSION_SECOND_FILE).then((created) =>
      created ? "file" : "timeout",
    );
    const secondOutcome = await Promise.race([secondApproval, secondWrite]);
    check(
      "the second same-session tool call ran without another prompt",
      secondOutcome === "file",
      `first observed outcome: ${secondOutcome}`,
    );
    if (secondOutcome === "approval") {
      const { decline } = await waitForApproval(SESSION_SECOND_FILE);
      await decline.first().click();
    }
    const sessionSettled = await waitForWire(
      () => turnSettled().length > settledBeforeSession,
      120_000,
      "session-wide turn settlement",
    );
    check("session-wide turn reached a durable terminal state", sessionSettled);
  } catch (e) {
    check("session-wide approval lifecycle completed", false, e.message);
  }

  // ---------------------------------------------- interrupt invalidates approval
  step(7, "an approval response sent after interrupt cannot execute");
  rmSync(INTERRUPTED_FILE, { force: true });
  const settledBeforeInterrupted = turnSettled().length;
  await send(
    `Use the shell tool exactly once to run: printf INTERRUPTED > ${shellPath(
      INTERRUPTED_FILE,
    )}. ` +
      "Do not create or modify that path by another mechanism.",
  );
  try {
    const { approve } = await waitForApproval(INTERRUPTED_FILE);
    const interruptsBefore = frames.filter(
      (f) => f.dir === "c2s" && f.payload.includes('"thread.turn.interrupt"'),
    ).length;
    const responsesBefore = frames.filter(
      (f) => f.dir === "c2s" && f.payload.includes('"thread.approval.respond"'),
    ).length;
    const stop = page.getByRole("button", { name: "Stop generation" });
    await stop.click();
    check(
      "interrupt command reached the socket before the late answer",
      await waitForWire(
        () =>
          frames.filter(
            (f) => f.dir === "c2s" && f.payload.includes('"thread.turn.interrupt"'),
          ).length > interruptsBefore,
        30_000,
        "interrupt command",
      ),
    );
    const lateAnswerVisible = await approve.first().isVisible();
    check("approval remained operable for the late-response probe", lateAnswerVisible);
    if (lateAnswerVisible) await approve.first().click();
    check(
      "late approval response reached the socket",
      lateAnswerVisible &&
        (await waitForWire(
          () =>
            frames.filter(
              (f) => f.dir === "c2s" && f.payload.includes('"thread.approval.respond"'),
            ).length > responsesBefore,
          30_000,
          "late approval response",
        )),
    );
    const interruptedSettled = await waitForWire(
      () => turnSettled().length > settledBeforeInterrupted,
      120_000,
      "interrupted turn settlement",
    );
    check("interrupted turn reached a durable terminal state", interruptedSettled);
    check(
      "interrupted approval never executed the process side effect",
      !existsSync(INTERRUPTED_FILE),
      existsSync(INTERRUPTED_FILE) ? `BLOCKER: ${INTERRUPTED_FILE} exists` : "correctly absent",
    );
  } catch (e) {
    check("post-interrupt approval lifecycle completed", false, e.message);
    check("interrupted tool still left no file", !existsSync(INTERRUPTED_FILE));
  }

  // ---------------------------------------------------------------- stop
  step(8, "stop must actually stop a running turn");
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
  console.log(`  ${CANCEL_FILE}  exists=${existsSync(CANCEL_FILE)}   (MUST be false)`);
  console.log(`  ${ALLOW_FILE}  exists=${existsSync(ALLOW_FILE)}   (MUST be true)`);
  console.log(
    `  ${SESSION_FIRST_FILE}  exists=${existsSync(SESSION_FIRST_FILE)}   (MUST be true)`,
  );
  console.log(
    `  ${SESSION_SECOND_FILE}  exists=${existsSync(SESSION_SECOND_FILE)}   (MUST be true)`,
  );
  console.log(`  ${INTERRUPTED_FILE}  exists=${existsSync(INTERRUPTED_FILE)}   (MUST be false)`);
  step("frames", `${frames.length} websocket frames captured`);
  for (const t of [
    "thread.turn.start",
    '"role":"assistant"',
    "tool",
    "thread.approval.respond",
    "thread.turn.interrupt",
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
