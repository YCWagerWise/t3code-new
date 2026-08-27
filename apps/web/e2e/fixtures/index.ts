/**
 * THE ONE HARNESS. Import from here; do not build a second one.
 *
 * `openApp()` returns a browser that has PAIRED and landed in the real app,
 * with a `Wire` recording every websocket frame from before the first
 * navigation — attaching the recorder after `goto` loses the handshake frames,
 * which are exactly the ones that explain a blank app.
 */
import { startStack, waitFor, REPO_ROOT, type StackHandle } from "./stack.ts";
import { resolveChrome } from "./chrome.ts";
import { Wire } from "./wire.ts";
import path from "node:path";
import { createRequire } from "node:module";

export { startStack, waitFor, Wire, REPO_ROOT };
export type { StackHandle };

const require_ = createRequire(import.meta.url);

/**
 * playwright-core is a real workspace dependency (apps/desktop/package.json), so
 * the suite adds NO new dependency and uses node:test as its runner. It runs
 * anywhere `node` does — including headless on the build box — and its
 * pass/fail/skipped counts come straight out of the runner for the ratchet.
 *
 * Resolved LAZILY and by NAME first. Lazily, because a spec that only uses the
 * stack fixture should not fail at import time for want of a browser. By name,
 * because whether pnpm hoists this package to the workspace root or leaves it
 * under apps/desktop is an install detail, and a hard path makes the suite fail
 * in a fresh cell for a reason that has nothing to do with the product.
 */
function loadChromium(): any {
  const candidates = [
    "playwright-core",
    path.join(REPO_ROOT, "node_modules/playwright-core"),
    path.join(REPO_ROOT, "apps/desktop/node_modules/playwright-core"),
  ];
  const tried: string[] = [];
  for (const candidate of candidates) {
    try {
      return require_(candidate).chromium;
    } catch (error) {
      tried.push(`${candidate}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    `playwright-core is not installed in this checkout. A cell is a separate ` +
      `checkout and needs its own \`pnpm install\`.\ntried:\n  ${tried.join("\n  ")}`,
  );
}

export type App = {
  readonly page: any;
  readonly wire: Wire;
  readonly stack: StackHandle;
  /** Re-open the app in a FRESH page against the same backend — this is what
   *  proves a value was persisted rather than held in the tab. */
  reload(): Promise<void>;
  close(): Promise<void>;
};

/**
 * How long a single navigation may take.
 *
 * This is NOT slack for a slow product. In `pnpm dev` the web app is served by
 * Vite, which transforms modules ON DEMAND, so the first request for a URL pays
 * a cold compile of everything it imports. Measured on this box: 73s for the
 * very first `index.html`, 41s warm — while `uptime` reported a load average of
 * 210 with four dev-runners, several rustc jobs and a 631%-CPU process on the
 * same machine. That is CONTENTION, not the product, and a suite that reports
 * "the app does not load" from a box in that state is filing a finding against
 * the wrong thing.
 *
 * Override with T3_E2E_NAV_MS. On an idle box, lower it — a nav budget is a
 * measurement of the machine and should be set like one.
 */
const NAV_MS = Number(process.env.T3_E2E_NAV_MS ?? 240_000);

export async function openApp(stack: StackHandle): Promise<App> {
  const chromium = loadChromium();
  const browser = await chromium.launch({
    executablePath: resolveChrome(chromium),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const wire = Wire.attach(page);

  // Pairing is the front door WHERE THERE IS ONE: a paired deployment gives an
  // unpaired browser an auth wall, not the app. A single-origin localhost
  // `pnpm dev` issues no pairing URL, so `entryUrl` is the web origin and the
  // browser lands straight in the app. Hard-requiring a pairing URL is what
  // made the previous rig time out against a backend that was listening.
  await page.goto(stack.entryUrl, { waitUntil: "domcontentloaded", timeout: NAV_MS });

  // Readiness is "the client has spoken to the backend and been answered",
  // observed on the wire. Not a fixed sleep, and not a CSS class.
  await waitFor(
    () => wire.frames.some((f) => f.dir === "recv" && f.json?._tag === "Exit"),
    {
      ms: 90_000,
      what:
        "the paired client to receive its first Exit frame from the backend " +
        "(i.e. the app is talking to the server, not just painted)",
    },
  );

  const app: App = {
    page,
    wire,
    stack,
    async reload() {
      await page.goto(stack.webUrl, { waitUntil: "domcontentloaded", timeout: NAV_MS });
      await waitFor(
        () => wire.frames.some((f) => f.dir === "recv" && f.json?._tag === "Exit"),
        { ms: 90_000, what: "the reloaded client to be answered by the backend" },
      );
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
  return app;
}
