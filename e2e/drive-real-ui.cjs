const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const ROOT = process.cwd();
// Resolve playwright-core BY NAME first. Whether pnpm hoists it to the workspace
// root or leaves it under apps/desktop is an install detail, and a hardcoded
// path makes this rig fail in a fresh checkout for a reason that has nothing to
// do with the app — which is the entire class of bug #437 is about.
const { chromium } = (() => {
  const tried = [];
  for (const cand of [
    "playwright-core",
    path.join(ROOT, "node_modules/playwright-core"),
    path.join(ROOT, "apps/desktop/node_modules/playwright-core"),
  ]) {
    try {
      return require(cand);
    } catch (e) {
      tried.push(cand + ": " + String(e.message).split("\n")[0]);
    }
  }
  throw new Error("playwright-core is not installed in this checkout.\ntried:\n  " + tried.join("\n  "));
})();
// Resolve the browser through playwright-core's own registry. A hardcoded
// absolute path pins the rig to one user's home and one chromium build, which is
// why it cannot run on the build box.
function resolveChrome() {
  if (process.env.T3_E2E_CHROME) return process.env.T3_E2E_CHROME;
  const registry = (() => {
    try {
      return chromium.executablePath();
    } catch {
      return null;
    }
  })();
  if (registry && fs.existsSync(registry)) return registry;
  // playwright-core's pinned revision is not always the one actually downloaded.
  // Fall back to any installed chromium build in the local cache.
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(
      require("os").homedir(),
      process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
    );
  if (!fs.existsSync(cache)) throw new Error("no playwright browser cache at " + cache);
  const tails = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux/chrome",
  ];
  for (const dir of fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()) {
    for (const tail of tails) {
      const p = path.join(cache, dir, tail);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("no chromium build found under " + cache);
}
const CHROME = resolveChrome();

const log = [];
const say = (s) => {
  log.push(String(s));
  console.log(String(s));
};

function startServer() {
  return new Promise((resolve, reject) => {
    // The workspace bin dir must be on PATH or dev-runner dies with `spawn vp ENOENT`.
    const binDir = path.join(ROOT, "node_modules", ".bin");
    // ...and cargo's, for the same reason: dev-backend spawns
    // `cargo run --release`, and on the build box cargo is not on the login PATH
    // (it lives in ~/.cargo/bin). Without this the runner dies with
    // `spawn cargo ENOENT` — the same defect as `spawn vp ENOENT`, one process
    // further down.
    const cargoBin = path.join(
      process.env.CARGO_HOME || path.join(require("os").homedir(), ".cargo"),
      "bin",
    );
    const env = {
      ...process.env,
      PATH: binDir + path.delimiter + cargoBin + path.delimiter + process.env.PATH,
    };
    if (!env.T3CODE_BACKEND) env.T3CODE_BACKEND = "rust";
    const p = spawn("node", ["scripts/dev-runner.ts", "dev"], { cwd: ROOT, env });
    let out = "";
    let url = null,
      pair = null;
    // PAIRING IS OPTIONAL AND MUST NOT BE A BOOT PRECONDITION.
    //
    // This used to resolve only when BOTH `url` and `pair` had been seen. A
    // single-origin localhost `pnpm dev` in browser mode prints NO `pairingUrl:`
    // line at all — its entire output is the runner banner plus Vite's `Local:`
    // line — so the rig waited out its full 240s and reported "no url/pair",
    // which reads as "the app did not start" for an app that started fine and is
    // listening. That misreading is exactly what #437 is about: the rig failing
    // for a reason unrelated to the app, and the failure being attributed to the
    // app (or to the driver's capabilities).
    //
    // Boot on the line that always exists. Give pairing a short grace period
    // after the URL appears, since when a deployment DOES pair, the pairing line
    // follows the Vite banner rather than preceding it.
    const PAIR_GRACE_MS = 5000;
    let settled = false;
    let graceTimer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      clearTimeout(graceTimer);
      resolve({ proc: p, url, pair, out });
    };
    const maybe = () => {
      if (!url) return;
      if (pair) return done();
      if (graceTimer === null) graceTimer = setTimeout(done, PAIR_GRACE_MS);
    };
    const t = setTimeout(
      () =>
        reject(
          new Error(
            "dev-runner never printed Vite's `Local:` line in 240s. This is the app " +
              "failing to boot, not a missing pairing URL — pairing is optional.\n" +
              out.slice(-1500),
          ),
        ),
      240000,
    );
    const scan = (d) => {
      out += d;
      const u = out.match(/Local:\s+(http:\/\/localhost:\d+)/);
      if (u) url = u[1];
      const pr = out.match(/pairingUrl:\s*(http:\/\/localhost:\d+\/pair#token=\S+)/);
      if (pr) pair = pr[1];
      maybe();
    };
    p.stdout.on("data", scan);
    p.stderr.on("data", scan);
    p.on("exit", (c) => {
      clearTimeout(t);
      reject(new Error("server exited " + c + "\n" + out.slice(-1500)));
    });
  });
}

(async () => {
  let server, browser;
  try {
    server = await startServer();
    say("SERVER:  " + server.url);
    say(
      server.pair
        ? "PAIRING: " + server.pair.replace(/token=.*/, "token=<redacted>")
        : "PAIRING: none (single-origin localhost dev does not pair — this is normal)",
    );

    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [],
      ws = [];
    page.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text().slice(0, 160));
    });
    page.on("websocket", (s) =>
      s.on("framereceived", (f) => {
        if (ws.length < 60) ws.push(String(f.payload).slice(0, 200));
      }),
    );

    // Pair WHERE THERE IS PAIRING; otherwise the web origin IS the front door.
    // Hard-requiring the pairing URL is what made this rig unable to reach an
    // app that was up and serving.
    await page.goto(server.pair || server.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(12000);
    say("AFTER PAIR url: " + page.url());
    say("AFTER PAIR title: " + (await page.title()));
    await page.screenshot({ path: "/tmp/t3e2e/01-after-pair.png" });
    const txt = (await page.evaluate(() => document.body.innerText || ""))
      .replace(/\n{2,}/g, "\n")
      .slice(0, 900);
    say("BODY:\n" + txt);

    // THE COMPOSER — the thing reins could not drive.
    const cands = ['[contenteditable="true"]', "textarea", '[role="textbox"]'];
    let found = null;
    for (const c of cands) {
      const n = await page.locator(c).count();
      say("locator " + c + " -> " + n);
      if (n && !found) found = c;
    }
    if (found) {
      const box = page.locator(found).first();
      await box.click();
      await page.keyboard.type("say the word BANANA and nothing else", { delay: 20 });
      await page.waitForTimeout(1200);
      const got =
        (await box.innerText().catch(() => "")) || (await box.inputValue().catch(() => ""));
      say("COMPOSER AFTER keyboard.type: " + JSON.stringify(String(got).slice(0, 120)));
      await page.screenshot({ path: "/tmp/t3e2e/02-typed.png" });

      // SEND THE TURN — new thread / draft promotion / streaming reply.
      await page.keyboard.press("Enter");
      say("PRESSED ENTER at " + new Date().toISOString());
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(5000);
        const t = (await page.evaluate(() => document.body.innerText || "")).replace(
          /\n{2,}/g,
          "\n",
        );
        if (
          /BANANA/i.test(t) &&
          !/say the word BANANA/i.test(t.replace(/say the word BANANA and nothing else/i, ""))
        ) {
          say("REPLY SEEN at tick " + i);
          break;
        }
        if (i % 3 === 0)
          say("tick " + i + " url=" + page.url() + " tail=" + t.slice(-160).replace(/\n/g, " "));
      }
      await page.screenshot({ path: "/tmp/t3e2e/03-after-send.png", fullPage: true });
      const after = (await page.evaluate(() => document.body.innerText || "")).replace(
        /\n{2,}/g,
        "\n",
      );
      say("URL AFTER SEND: " + page.url());
      say("BODY AFTER SEND (1200):\n" + after.slice(0, 1200));
    } else {
      say("NO COMPOSER FOUND");
    }
    say("CONSOLE ERRORS (" + errs.length + "): " + errs.slice(0, 4).join(" | "));
    say("WS FRAMES RECEIVED (" + ws.length + "):");
    ws.slice(0, 10).forEach((f) => say("  " + f));
  } catch (e) {
    say("FAILED: " + (e && e.message ? e.message : String(e)));
  } finally {
    try {
      if (browser) await browser.close();
    } catch (e) {}
    if (server && server.proc) {
      try {
        server.proc.kill("SIGKILL");
      } catch (e) {}
    }
    fs.writeFileSync("/tmp/t3e2e/run.log", log.join("\n"));
    process.exit(0);
  }
})();
