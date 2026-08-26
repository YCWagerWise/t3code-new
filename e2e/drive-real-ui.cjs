const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const ROOT = process.cwd();
const { chromium } = require(path.join(ROOT, "apps/desktop/node_modules/playwright-core"));
const CHROME = "/Users/nathanaelaninweze/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const log = [];
const say = (s) => { log.push(String(s)); console.log(String(s)); };

function startServer() {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["scripts/dev-runner.ts", "dev"], { cwd: ROOT, env: process.env });
    let out = "";
    let url = null, pair = null;
    const maybe = () => { if (url && pair) { clearTimeout(t); resolve({ proc: p, url, pair, out }); } };
    const t = setTimeout(() => reject(new Error("no url/pair in 240s:\n" + out.slice(-1500))), 240000);
    const scan = (d) => {
      out += d;
      const u = out.match(/Local:\s+(http:\/\/localhost:\d+)/); if (u) url = u[1];
      const pr = out.match(/pairingUrl:\s*(http:\/\/localhost:\d+\/pair#token=\S+)/); if (pr) pair = pr[1];
      maybe();
    };
    p.stdout.on("data", scan); p.stderr.on("data", scan);
    p.on("exit", c => { clearTimeout(t); reject(new Error("server exited " + c + "\n" + out.slice(-1500))); });
  });
}

(async () => {
  let server, browser;
  try {
    server = await startServer();
    say("SERVER:  " + server.url);
    say("PAIRING: " + server.pair.replace(/token=.*/, "token=<redacted>"));

    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [], ws = [];
    page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
    page.on("websocket", s => s.on("framereceived", f => { if (ws.length < 60) ws.push(String(f.payload).slice(0, 200)); }));

    // PAIR, then land in the app.
    await page.goto(server.pair, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000);
    say("AFTER PAIR url: " + page.url());
    say("AFTER PAIR title: " + (await page.title()));
    await page.screenshot({ path: "/tmp/t3e2e/01-after-pair.png" });
    const txt = (await page.evaluate(() => document.body.innerText || "")).replace(/\n{2,}/g, "\n").slice(0, 900);
    say("BODY:\n" + txt);

    // THE COMPOSER — the thing reins could not drive.
    const cands = ['[contenteditable="true"]', 'textarea', '[role="textbox"]'];
    let found = null;
    for (const c of cands) { const n = await page.locator(c).count(); say("locator " + c + " -> " + n); if (n && !found) found = c; }
    if (found) {
      const box = page.locator(found).first();
      await box.click();
      await page.keyboard.type("say the word BANANA and nothing else", { delay: 20 });
      await page.waitForTimeout(1200);
      const got = (await box.innerText().catch(() => "")) || (await box.inputValue().catch(() => ""));
      say("COMPOSER AFTER keyboard.type: " + JSON.stringify(String(got).slice(0, 120)));
      await page.screenshot({ path: "/tmp/t3e2e/02-typed.png" });

      // SEND THE TURN — new thread / draft promotion / streaming reply.
      await page.keyboard.press("Enter");
      say("PRESSED ENTER at " + new Date().toISOString());
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(5000);
        const t = (await page.evaluate(() => document.body.innerText || "")).replace(/\n{2,}/g, "\n");
        if (/BANANA/i.test(t) && !/say the word BANANA/i.test(t.replace(/say the word BANANA and nothing else/i,""))) { say("REPLY SEEN at tick " + i); break; }
        if (i % 3 === 0) say("tick " + i + " url=" + page.url() + " tail=" + t.slice(-160).replace(/\n/g," "));
      }
      await page.screenshot({ path: "/tmp/t3e2e/03-after-send.png", fullPage: true });
      const after = (await page.evaluate(() => document.body.innerText || "")).replace(/\n{2,}/g, "\n");
      say("URL AFTER SEND: " + page.url());
      say("BODY AFTER SEND (1200):\n" + after.slice(0, 1200));
    } else {
      say("NO COMPOSER FOUND");
    }
    say("CONSOLE ERRORS (" + errs.length + "): " + errs.slice(0, 4).join(" | "));
    say("WS FRAMES RECEIVED (" + ws.length + "):");
    ws.slice(0, 10).forEach(f => say("  " + f));
  } catch (e) {
    say("FAILED: " + (e && e.message ? e.message : String(e)));
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
    if (server && server.proc) { try { server.proc.kill("SIGKILL"); } catch (e) {} }
    fs.writeFileSync("/tmp/t3e2e/run.log", log.join("\n"));
    process.exit(0);
  }
})();
