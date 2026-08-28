/**
 * THE E2E STACK FIXTURE — one real web app, one real Rust backend, one browser.
 *
 * There is exactly one of these for the whole suite, on purpose. Eight tasks
 * were pushed asking for a frontend e2e suite and the failure mode is eight
 * harnesses: `apps/web/e2e/fixtures` is the single authority, everything under
 * `apps/web/e2e/actions` imports it.
 *
 * WHAT THIS DELIBERATELY REFUSES TO DO:
 *   - no mocked RPC layer, no mocked WebSocket. A spec that mounts a component
 *     against a mock is a unit test with a .spec extension, and mocks cannot
 *     catch product-owned in-memory authority, which is the entire class of
 *     defect this suite exists for.
 *   - no `sleep(n)` as synchronization. Every wait is a predicate over observed
 *     state with a deadline, and the deadline failure message says what it was
 *     waiting for. `waitFor` below is the only timer in the harness.
 *   - no port assumptions. dev-runner HASHES a port offset per worktree so
 *     several cells run at once (dev-runner.ts:265-276); a hardcoded 5733/13773
 *     screenshots another cell's app. The ports are READ off the runner banner.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

export type Deadline = { readonly ms: number; readonly what: string };

/**
 * Poll `probe` until it returns something truthy, or fail with a message that
 * names what was being waited for. Every wait in this suite goes through here
 * so that a timeout is never reported as a product failure by accident.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  deadline: Deadline,
  intervalMs = 100,
): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < deadline.ms) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
      last = value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `TIMED OUT after ${deadline.ms}ms waiting for: ${deadline.what}` +
      (last === undefined ? "" : `\n  last observation: ${describe(last)}`),
  );
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value)?.slice(0, 400) ?? String(value);
  } catch {
    return String(value);
  }
}

export type StackHandle = {
  /** The web app origin, read off the runner, never assumed. */
  readonly webUrl: string;
  /** The pairing URL, when this deployment issues one. `null` on a
   *  single-origin localhost `pnpm dev`, which does not pair. */
  readonly pairingUrl: string | null;
  /** Where a fresh browser should land: the pairing URL if there is one, the
   *  web origin otherwise. */
  readonly entryUrl: string;
  /** The port the RUST backend bound. Needed to restart it. */
  readonly serverPort: number;
  /** Everything the runner printed, for failure messages. */
  output(): string;
  /**
   * Is the Rust backend still answering?
   *
   * Call it in a long `waitFor` predicate so a DEAD BACKEND fails immediately
   * and by name, instead of expiring the deadline and reporting whatever the
   * spec happened to be waiting for. A stream that stops arriving because the
   * server died is indistinguishable, from inside the assertion, from a stream
   * that is genuinely broken — and the second reading is a product finding that
   * would be false.
   */
  backendAlive(): Promise<boolean>;
  /**
   * Kill the backend process and wait until the backend answers again.
   *
   * THIS IS THE FIXTURE EVERY DURABILITY CLAIM NEEDS, and it exists from the
   * first commit even though only some specs call it today: retrofitting a
   * restart into thirty existing specs is how it quietly never happens. A test
   * that never restarts the process proves nothing about durability — it proves
   * the value is in memory, which is the defect, not the feature.
   */
  restartBackend(): Promise<void>;
  dispose(): Promise<void>;
};

/** Ask the OS which pids hold a TCP listener on `port`. */
async function listenersOn(port: number): Promise<number[]> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      (_error, stdout) => {
        resolve(
          String(stdout || "")
            .split("\n")
            .map((line) => Number(line.trim()))
            .filter((pid) => Number.isInteger(pid) && pid > 0),
        );
      },
    );
  });
}

async function backendAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    // Any HTTP answer means the listener is up and serving. A 404 is an answer.
    return response.status > 0;
  } catch {
    return false;
  }
}

export async function startStack(
  options: { readonly bootMs?: number } = {},
): Promise<StackHandle> {
  // dev-runner shells out to `vp`, which lives in the workspace bin dir. Spawning
  // with an unaugmented PATH is `spawn vp ENOENT` — the rig failing to start the
  // app it exists to drive (#437).
  const binDir = path.join(REPO_ROOT, "node_modules", ".bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    T3CODE_BACKEND: process.env.T3CODE_BACKEND ?? "rust",
    // Never let a dev-runner open a browser window on the build box.
    T3CODE_NO_BROWSER: "1",
  };

  const child = spawn("node", ["scripts/dev-runner.ts", "dev"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let exited: number | null = null;
  /** Backends this fixture started itself, so dispose() can take them down. */
  const respawned: ChildProcess[] = [];
  /** Who brought the backend back on the last restartBackend(): the runner, or us. */
  let restartedBy: "runner" | "fixture" | null = null;
  const absorb = (chunk: unknown) => {
    out += String(chunk);
  };
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);
  child.on("exit", (code) => {
    exited = code ?? -1;
  });

  // A COLD RELEASE BUILD OF THE RUST BACKEND IS INSIDE THIS WAIT. dev-runner
  // shells out to `cargo run --release`, and on a fresh cell that is a
  // from-scratch build of the whole workspace (turso at opt-level 3 alone is
  // tens of minutes). A default that assumes a warm target dir reports "the app
  // does not boot" for a machine that is compiling correctly — which is exactly
  // the wrong conclusion, and one this channel has already drawn once.
  const bootMs = options.bootMs ?? Number(process.env.T3_E2E_BOOT_MS ?? 1_800_000);
  const banner = await waitFor(
    () => {
      if (exited !== null) {
        throw new Error(`dev-runner exited with ${exited}\n${out.slice(-2000)}`);
      }
      const web = out.match(/Local:\s+(http:\/\/[^\s]+)/);
      // The runner prints `serverPort=NNNNN` in its own banner (dev-runner.ts:723).
      // Reading it is how a spec knows which backend to restart; guessing it is
      // how a spec restarts a different cell's backend.
      const port = out.match(/serverPort=(\d+)/);
      // PAIRING IS OPTIONAL AND MUST NOT BE A BOOT PRECONDITION. `pnpm dev` in
      // browser mode is single-origin on localhost and prints NO `pairingUrl:`
      // line at all — verified against a live runner, whose entire output is the
      // banner plus Vite's `Local:` line. Requiring it is why the previous rig
      // (e2e/drive-real-ui.cjs:64-76) waits 240s and then reports "no url/pair",
      // which reads as "the app did not start" for an app that started fine and
      // is listening. Boot on the two lines that always exist; use the pairing
      // URL only if this deployment actually offers one.
      const pair = out.match(/pairingUrl:\s*(http:\/\/\S+\/pair#token=\S+)/);
      if (web && port) {
        return {
          webUrl: web[1]!.replace(/\/$/, ""),
          pairingUrl: pair ? pair[1]! : null,
          serverPort: Number(port[1]),
        };
      }
      return null;
    },
    {
      ms: bootMs,
      what:
        "dev-runner to print its `serverPort=` banner and Vite's `Local:` line. " +
        "Runner output so far:\n" + out.slice(-2000),
    },
    250,
  );

  // THE BACKEND MUST ACTUALLY BE LISTENING BEFORE ANY SPEC RUNS.
  //
  // dev-runner prints its banner and Vite's `Local:` line as soon as the WEB
  // server is up, which says nothing about the Rust server. Those two states are
  // indistinguishable from the browser — the page loads, the app paints, and no
  // frame ever answers — so without this check the failure surfaces seven
  // minutes later as "the app is not talking to the server", which is the wrong
  // conclusion and the expensive one. I paid for it twice.
  //
  // The usual cause is not a product defect at all: an ORPHANED dev server from
  // an earlier run still holding this worktree's hashed port. A run killed by an
  // outer timeout leaves its process group behind, the next run's vite loses the
  // bind, and the corpse serves HTML to a backend that is not there.
  // The SAME budget as the boot, not a smaller one. `dev-backend.ts` runs
  // `cargo run --release`, so this wait can contain a full rebuild of the
  // workspace — which on a shared checkout happens whenever another cell touches
  // a path dependency. A separate, tighter budget here just reports "the backend
  // is not up" for a machine that is compiling correctly, which is the same
  // wrong conclusion one layer down.
  await waitFor(async () => await backendAnswers(banner.serverPort), {
    ms: bootMs,
    what:
      `the RUST backend to answer on ${banner.serverPort}. The web server is up ` +
      `(${banner.webUrl}) but the backend is not, which a browser cannot tell ` +
      `apart from a broken app. Check for an orphaned dev server on this ` +
      `worktree's ports: \`lsof -nP -iTCP:${banner.serverPort} -sTCP:LISTEN\`.\n` +
      `  --- dev-runner tail ---\n${out.slice(-1500)}`,
  });

  /**
   * Start one backend on the stack's port.
   *
   * Prefers the ALREADY-BUILT binary over `node scripts/dev-backend.ts`, which
   * shells out to `cargo run --release`. That matters here and not in theory:
   * cargo takes an exclusive lock on the target directory, several cells build
   * against overlapping path dependencies, and a restart that has to win that
   * lock took longer than a fifteen-minute deadline on this box — reported as
   * "the backend never came back", which is a statement about build contention
   * and not about the product. It is the same executable either way; the runner
   * log says so itself (`Running .../release/t3code-server`).
   */
  const spawnBackend = (): ChildProcess => {
    const targetDir = process.env.CARGO_TARGET_DIR || path.join(REPO_ROOT, "backend", "target");
    const prebuilt = path.join(targetDir, "release", "t3code-server");
    const backendEnv = { ...env, T3CODE_SERVER_PORT: String(banner.serverPort) };
    const child = fs.existsSync(prebuilt)
      ? spawn(prebuilt, [], { cwd: REPO_ROOT, env: backendEnv, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("node", ["scripts/dev-backend.ts"], {
          cwd: path.join(REPO_ROOT, "apps", "server"),
          env: backendEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
    child.stdout?.on("data", absorb);
    child.stderr?.on("data", absorb);
    return child;
  };

  /** Is the web origin serving? */
  const webAnswers = async (): Promise<boolean> => {
    try {
      const response = await fetch(banner.webUrl, { signal: AbortSignal.timeout(5000) });
      return response.status > 0;
    } catch {
      return false;
    }
  };

  /** Bring the web server back if the runner took it down, then wait for it. */
  const ensureWebUp = async (): Promise<void> => {
    if (await webAnswers()) return;
    restartedBy = "fixture";
    exited = null;
    const revived = spawn("node", ["scripts/dev-runner.ts", "dev"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    revived.stdout?.on("data", absorb);
    revived.stderr?.on("data", absorb);
    revived.on("exit", (code) => {
      exited = code ?? -1;
    });
    respawned.push(revived);
    await waitFor(webAnswers, {
      ms: bootMs,
      what:
        `the web server to answer on ${banner.webUrl} again. dev-runner exits when ` +
        `its backend is killed, so the stack was restarted.\n` +
        `  --- runner tail ---\n${out.slice(-1200)}`,
    });
    await waitFor(async () => await backendAnswers(banner.serverPort), {
      ms: bootMs,
      what: `the backend to answer on ${banner.serverPort} after the stack restart`,
    });
  };

  const handle: StackHandle = {
    webUrl: banner.webUrl,
    pairingUrl: banner.pairingUrl,
    entryUrl: banner.pairingUrl ?? banner.webUrl,
    serverPort: banner.serverPort,
    output: () => out,
    backendAlive: () => backendAnswers(banner.serverPort),
    restartedBy: () => restartedBy,

    async restartBackend() {
      const before = await listenersOn(banner.serverPort);
      if (before.length === 0) {
        throw new Error(
          `restartBackend: nothing is listening on ${banner.serverPort}; ` +
            `the backend was already down, so a restart would prove nothing.`,
        );
      }
      for (const pid of before) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone between lsof and kill. Fine.
        }
      }
      await waitFor(async () => !(await backendAnswers(banner.serverPort)), {
        ms: 20_000,
        what: `the backend on ${banner.serverPort} to actually stop answering after SIGKILL`,
      });
      // MEASURED: dev-runner does NOT resupervise a SIGKILLed backend. It spawns
      // `node scripts/dev-backend.ts` once and does not restart it, so after a
      // kill the port stays closed indefinitely — 180s of waiting produced
      // nothing. That is worth its own finding against dev-runner, and it is
      // reported rather than papered over.
      //
      // But it must not make `restartBackend()` unusable, because every
      // durability assertion in this suite depends on it. So the fixture gives
      // the runner a fair chance to bring the backend back on its own, and then
      // starts one itself, recording WHICH path it took. A fixture that cannot
      // restart the process would silently delete the restart from every spec
      // that calls it — and a durability suite that never restarts anything is
      // the exact hole this harness exists to close.
      const resupervised = await waitFor(
        async () => ((await backendAnswers(banner.serverPort)) ? "runner" : null),
        { ms: 20_000, what: "dev-runner to resupervise the backend on its own" },
      ).catch(() => null);

      if (resupervised === null) {
        restartedBy = "fixture";
        respawned.push(spawnBackend());
      } else {
        restartedBy = "runner";
      }

      await waitFor(async () => await backendAnswers(banner.serverPort), {
        ms: bootMs,
        what:
          `the backend to answer on ${banner.serverPort} again after SIGKILL ` +
          `(restarted by: ${restartedBy}).\n  --- runner tail ---\n${out.slice(-1200)}`,
      });

      // AND THE WEB SERVER, ALWAYS — checked unconditionally rather than only
      // when `exited` happens to have been observed. dev-runner treats its
      // backend child exiting as fatal and takes Vite down with it, but it does
      // that ASYNCHRONOUSLY, so a restart path that branches on "has the runner
      // exited yet" races the runner's own teardown and wins about half the
      // time. It cost a run: the backend came back, the web origin did not, and
      // the spec's next `page.goto` failed ERR_CONNECTION_REFUSED — which reads
      // as "the app died" and is a conclusion about the product drawn entirely
      // from the fixture's own kill. Restarting the stack is idempotent here
      // because the ports are hashed from the worktree path
      // (dev-runner.ts:265-276) and come back identical.
      await ensureWebUp();
    },

    async dispose() {
      for (const extra of respawned) await killTree(extra);
      await killTree(child);
    },
  };

  return handle;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    // Negative pid targets the group, so cargo and vite go with the runner.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve(undefined);
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
