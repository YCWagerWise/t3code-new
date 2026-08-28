/**
 * THE shared e2e fixtures. One harness, per the reviewers' standing order.
 *
 * What this boots is the REAL stack: the Rust `t3code-server` binary and the
 * real Vite-served web bundle, talking over the app's own WebSocket. Nothing is
 * mocked. A spec that mounts a component against a fake RPC layer is a unit test
 * with a `.spec.ts` extension, and this channel has already rejected that.
 *
 * THINGS THAT COST OTHER AGENTS A ROUND, ENCODED HERE SO THEY DO NOT AGAIN:
 *
 *  - `T3CODE_BACKEND` defaults to `node`. A harness that omits it goes green
 *    against the NODE server and proves nothing about the Rust one. This starts
 *    the Rust binary directly, so there is no default to get wrong.
 *  - The dev port is HASHED PER WORKTREE. Anything hardcoding 5733/13773
 *    attaches to a different cell's running app and screenshots that. Ports here
 *    are allocated from :0 and read back.
 *  - `domcontentloaded` never fires promptly in dev: the entry is a deferred
 *    module script, so the event waits for the whole module graph. Waiting on it
 *    reports "the app does not boot" for a cold cache. `gotoApp` commits and
 *    then waits for the composer.
 *  - `playwright-core`'s bundled browser does not resolve (the registry pins a
 *    chromium build that is not the one installed), and a hardcoded absolute
 *    `ms-playwright` cache path cannot run on the build box. `channel: "chrome"`
 *    is resolved by name.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO = resolve(WEB_DIR, "..", "..");

/** An OS-allocated free port. Never a constant — see the header. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "never attempted";
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the socket is serving. The Rust server 404s `/`
      // by design (it serves /ws and /api), so status is not the signal —
      // getting a response at all is.
      await fetch(url, { signal: AbortSignal.timeout(4000) });
      return;
    } catch (e) {
      last = String((e as Error).message);
    }
  }
  throw new Error(`nothing answered at ${url} within ${timeoutMs}ms (last: ${last})`);
}

/**
 * The Rust backend under test. `restart()` exists from the first commit even
 * though few specs call it yet: every durability claim needs it, and retrofitting
 * a restart fixture into thirty specs later is how it quietly never happens.
 */
export class Backend {
  proc: ChildProcess | null = null;
  constructor(
    readonly port: number,
    readonly home: string,
    readonly workspace: string,
    readonly bin: string,
    readonly agentBin: string,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.bin, [], {
      stdio: "ignore",
      env: {
        ...process.env,
        T3CODE_SERVER_PORT: String(this.port),
        T3CODE_WORKSPACE: this.workspace,
        T3CODE_AGENT_DATA: this.home,
        // Without this the driver resolves the bare name `t3code-agent` against
        // PATH, finds nothing, and every provider reports "No provider
        // available" — the symptom every UI-driving attempt here has hit.
        T3CODE_AGENT_BIN: this.agentBin,
      },
    });
    await waitForHttp(`http://127.0.0.1:${this.port}/`, 60_000);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise<void>((res) => {
      p.once("exit", () => res());
      p.kill("SIGTERM");
      setTimeout(() => p.kill("SIGKILL"), 5_000).unref();
    });
  }

  /** Kill and restart the backend. State that does not survive this was never durable. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

interface Fixtures {
  backend: Backend;
  appUrl: string;
  gotoApp: (page: Page) => Promise<void>;
}

export const test = base.extend<Record<string, never>, Fixtures>({
  backend: [
    async ({}, use) => {
      const bin =
        process.env.T3CODE_E2E_SERVER_BIN ??
        join(REPO, "backend", "target", "debug", "t3code-server");
      const agentBin =
        process.env.T3CODE_E2E_AGENT_BIN ??
        join(REPO, "backend", "target", "debug", "t3code-agent");
      if (!existsSync(bin) || !existsSync(agentBin)) {
        throw new Error(
          `the Rust backend is not built. Run:\n` +
            `  cd ${join(REPO, "backend")} && cargo build --bin t3code-server --bin t3code-agent\n` +
            `or set T3CODE_E2E_SERVER_BIN and T3CODE_E2E_AGENT_BIN to the built binaries.\n` +
            `Missing: ${!existsSync(bin) ? bin : ""} ${!existsSync(agentBin) ? agentBin : ""}`,
        );
      }
      const home = mkdtempSync(join(tmpdir(), "t3e2e-home-"));
      const workspace = mkdtempSync(join(tmpdir(), "t3e2e-ws-"));
      const backend = new Backend(await freePort(), home, workspace, bin, agentBin);
      await backend.start();
      await use(backend);
      await backend.stop();
    },
    { scope: "worker" },
  ],

  appUrl: [
    async ({ backend }, use) => {
      const webPort = await freePort();
      const vp = join(REPO, "node_modules", ".bin", "vp");
      // NOT `stdio: "ignore"`. When the web server fails to start, discarding its
      // output leaves only "nothing answered at <url>", which is the symptom and
      // never the cause. Its log is written where the failure message can point.
      const webLog = join(tmpdir(), `t3e2e-web-${webPort}.log`);
      const webOut = openSync(webLog, "a");
      const web = spawn(vp, ["dev", "--port", String(webPort)], {
        cwd: WEB_DIR,
        stdio: ["ignore", webOut, webOut],
        env: {
          ...process.env,
          // `vp` lives in the workspace bin dir; spawning dev-runner with an
          // unaugmented PATH is what made the previous rig die on ENOENT.
          PATH: `${join(REPO, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
          T3CODE_PORT: String(backend.port),
          T3CODE_SINGLE_ORIGIN_DEV: "1",
          // Bundled dev collapses a cold module graph from minutes to seconds.
          T3CODE_BUNDLED_DEV: "1",
        },
      });
      const url = `http://127.0.0.1:${webPort}/`;
      try {
        await waitForHttp(url, 180_000);
      } catch (e) {
        throw new Error(
          `${(e as Error).message}\n--- web dev server log (${webLog}) ---\n` +
            (existsSync(webLog) ? readFileSync(webLog, "utf8").slice(-4000) : "(no log)"),
        );
      }
      // WARM THE BUNDLE BEFORE ANY SPEC NAVIGATES. Vite answers the socket long
      // before it can serve a built graph, so the FIRST navigation pays the
      // whole bundle and blows a per-test timeout — which reads as "the app does
      // not boot" instead of "the cache was cold". Paying it once, here, keeps
      // that cost out of every spec's budget.
      const warmDeadline = Date.now() + 240_000;
      for (;;) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          await r.text();
          break;
        } catch {
          if (Date.now() > warmDeadline) throw new Error(`web bundle never warmed at ${url}`);
        }
      }
      await use(url);
      web.kill("SIGTERM");
    },
    { scope: "worker" },
  ],

  gotoApp: [
    async ({ appUrl }, use) => {
      await use(async (page: Page) => {
        // The app CLIENT-SIDE REDIRECTS to /draft/<id> as soon as it boots, which
        // races `waitUntil: "commit"` and surfaces as
        // `net::ERR_ABORTED; maybe frame was detached?`. That is the app working,
        // not the app failing, so an aborted navigation is tolerated here and the
        // real readiness signal — the composer — is awaited below. Anything else
        // still throws.
        try {
          await page.goto(appUrl, { waitUntil: "commit", timeout: 180_000 });
        } catch (e) {
          const msg = String((e as Error).message);
          if (!msg.includes("ERR_ABORTED")) throw e;
        }
        await page
          .locator('[contenteditable="true"]')
          .first()
          .waitFor({ state: "visible", timeout: 180_000 });
      });
    },
    { scope: "worker" },
  ],
});

export { expect };
