// #27: drive the REAL T3Code UI against the REAL Rust backend and type a real
// prompt into the Lexical composer. reins' type_text cannot do this (dead end
// #9: Lexical builds its model from CDP Input events, not synthetic
// KeyboardEvents), so this uses playwright-core's keyboard, which produces real
// CDP Input.
const path = require("path");
const fs = require("fs");
const ROOT = "/Users/nathanaelaninweze/Desktop/workspace/t3code-new/.workshop-worktrees/clau-031c-ui";
const { chromium } = require(path.join(ROOT, "apps/desktop/node_modules/playwright-core"));

function resolveChrome() {
  const cache = path.join(require("os").homedir(), "Library/Caches/ms-playwright");
  for (const dir of fs.readdirSync(cache).filter(d => d.startsWith("chromium-")).sort().reverse()) {
    for (const tail of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ]) {
      const p = path.join(cache, dir, tail);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("no chromium in " + cache);
}

const WEB = process.env.WEB || "http://localhost:6015";
const PROMPT = process.env.PROMPT || "hey can you add a --json flag to the status command";
const out = [];
const say = s => { out.push(String(s)); console.log(String(s)); };

(async () => {
  const browser = await chromium.launch({ executablePath: resolveChrome(), headless: true });
  const page = await browser.newPage();

  // Record the WIRE, not the DOM. #435: innerText assertions produce false
  // passes because the UI echoes the user's own prompt in the user bubble and
  // renders a live "Working for Ns" timer.
  const frames = [];
  page.on("websocket", ws => {
    say("WS OPEN " + ws.url());
    ws.on("framereceived", d => { try { frames.push(JSON.parse(d.payload)); } catch {} });
  });
  page.on("console", m => { if (m.type() === "error") say("CONSOLE ERROR " + m.text().slice(0, 300)); });

  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  say("URL AFTER BOOT: " + page.url());

  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 30000 });
  await composer.click();
  await page.keyboard.type(PROMPT, { delay: 12 });
  await page.waitForTimeout(400);

  const typed = await composer.innerText();
  say("COMPOSER AFTER TYPING: " + JSON.stringify(typed));
  if (!typed.includes(PROMPT.slice(0, 20))) {
    say("FAIL: text never reached the composer");
    fs.writeFileSync("/tmp/t3drive/out.txt", out.join("\n"));
    await browser.close();
    process.exit(2);
  }

  await page.keyboard.press("Enter");
  say("SENT (Enter) at " + new Date().toISOString());

  // Wait on the WIRE for an assistant message that has finished streaming.
  const deadline = Date.now() + 180000;
  let done = null;
  while (Date.now() < deadline && !done) {
    await page.waitForTimeout(1000);
    for (const f of frames) {
      const vals = f?.values || [];
      for (const v of vals) {
        const ev = v?.event || v;
        const p = ev?.payload;
        if (p?.role === "assistant" && p?.streaming === false) { done = p; }
      }
    }
  }
  say("ASSISTANT COMPLETE FRAME: " + (done ? JSON.stringify(done).slice(0, 600) : "NONE in 180s"));
  say("TOTAL WS FRAMES: " + frames.length);
  const kinds = {};
  for (const f of frames) for (const v of (f?.values||[])) { const k=(v?.event||v)?.type||(v?.kind); if(k) kinds[k]=(kinds[k]||0)+1; }
  say("FRAME KINDS: " + JSON.stringify(kinds));
  say("FINAL URL: " + page.url());
  say("RENDERED:\n" + (await page.locator("body").innerText()).slice(0, 1500));

  fs.writeFileSync("/tmp/t3drive/out.txt", out.join("\n"));
  await browser.close();
})().catch(async e => {
  say("DRIVER ERROR: " + (e && e.stack || e));
  fs.writeFileSync("/tmp/t3drive/out.txt", out.join("\n"));
  process.exit(1);
});
