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
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

export type Deadline = { readonly ms: number; readonly what: string };

/**
 * Poll `probe` until it returns something truthy, or fail with a message that
 * names what was being waited for. Every wait in this suite goes through here
 * so that a timeout is never reported as a product failure by accident.
 */
/**
 * Thrown by a `waitFor` probe to say "stop waiting, this can never succeed".
 *
 * `waitFor` swallows an ordinary throw into `last` and keeps polling, which is
 * right for a probe that is merely not ready yet — but WRONG for one that has
 * observed the thing it is waiting for die. `startStack`'s probe throws
 * `dev-runner exited with 1` the instant the runner dies; that message was being
 * buried and the run sat for the FULL boot budget (default 1,800,000ms) on a
 * process that had been dead for 400ms, then reported a TIMEOUT.
 *
 * That is the #481 shape reproduced in the harness: a failure that presents as a
 * hang, emits no result, and is indistinguishable from a slow build — which is
 * exactly how a dead run goes unnoticed for hours.
 */
export class FatalWait extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalWait";
  }
}

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
      // A probe that says the wait is unsatisfiable must not be polled again.
      if (error instanceof FatalWait) throw error;
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
  // CARGO MUST BE ON PATH TOO, and this is not hypothetical: on the build box
  // `cargo` is NOT on the login PATH (it lives in ~/.cargo/bin, which nothing
  // adds), so `dev-backend.ts` — which spawns
  // `cargo run --release --manifest-path backend/Cargo.toml` — died instantly
  // with `spawn cargo ENOENT` and took dev-runner down with it. Every e2e spec
  // in this suite then failed to boot the app on the one machine the review
  // protocol requires the evidence to come from.
  //
  // Same class as #437's `spawn vp ENOENT` one layer up, and the same fix. The
  // cargo bin dir is derived from CARGO_HOME when it is set, because a rustup
  // install that honours CARGO_HOME puts it somewhere else entirely.
  const cargoBin = path.join(
    process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"),
    "bin",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${cargoBin}${path.delimiter}${process.env.PATH ?? ""}`,
    T3CODE_BACKEND: process.env.T3CODE_BACKEND ?? "rust",
    // Never let a dev-runner open a browser window on the build box.
    T3CODE_NO_BROWSER: "1",
  };

  // `detached: true` MAKES dev-runner A PROCESS-GROUP LEADER, and without it
  // teardown cannot work at all.
  //
  // `killTree` does `process.kill(-child.pid, ...)`, which targets the group
  // WHOSE ID IS child.pid. That group only exists if the child leads one. Not
  // detached, the call fails and falls back to killing dev-runner alone —
  // leaving `vp dev`, `vite` and `cargo run --release` orphaned. Measured on the
  // build box: FOUR leaked `vite dev` servers from one cell (ports 44211, 33681,
  // 34527, 44281), still holding ports and memory long after their runs.
  //
  // The second, worse consequence is that THE RUN NEVER ENDS. The orphans
  // inherit dev-runner's stdout/stderr pipes, so those handles never EOF, node's
  // event loop stays alive, and the suite sits in `after()` forever: no summary,
  // no pass/fail/skip counts, nothing for the ratchet to read. Observed here —
  // the test itself finished in 44s and the runner was still parked in `ep_poll`
  // fifteen minutes later. A suite that cannot terminate reports nothing, which
  // is the same "answers never instead of no" failure as #481.
  const child = spawn("node", ["scripts/dev-runner.ts", "dev"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let out = "";
  let exited: number | null = null;
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
        // FATAL, not "not ready yet". Without this the boot waits out its full
        // budget on a corpse and reports a timeout instead of the exit code and
        // the runner's own error text.
        throw new FatalWait(`dev-runner exited with ${exited}\n${out.slice(-2000)}`);
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

  const handle: StackHandle = {
    webUrl: banner.webUrl,
    pairingUrl: banner.pairingUrl,
    entryUrl: banner.pairingUrl ?? banner.webUrl,
    serverPort: banner.serverPort,
    output: () => out,

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
      await waitFor(async () => await backendAnswers(banner.serverPort), {
        ms: 180_000,
        what:
          `the backend to come back on ${banner.serverPort}. If this times out, the ` +
          `runner does not resupervise a SIGKILLed backend — that is a finding ` +
          `against dev-runner, not against the spec that called restartBackend().`,
      });
    },

    async dispose() {
      await killTree(child);
    },
  };

  return handle;
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      // Negative pid targets the GROUP, so vp/vite/cargo/t3code-server go with
      // the runner. This only works because the child was spawned `detached`.
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
      return false;
    }
  };

  if (child.exitCode === null) signalGroup("SIGTERM");

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signalGroup("SIGKILL");
      resolve(undefined);
    }, 8000);
    if (child.exitCode !== null) {
      clearTimeout(timer);
      resolve(undefined);
      return;
    }
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });

  // SIGKILL the group unconditionally on the way out. SIGTERM is polite and a
  // vite dev server can decline it; a leaked one holds a port that the NEXT
  // cell's hashed-port allocation may collide with.
  signalGroup("SIGKILL");

  // AND LET THE EVENT LOOP DIE. Even after the group is gone, the inherited
  // stdio pipes are live handles; leaving them referenced is what kept the
  // runner alive in `after()` with the tests long finished and no summary
  // printed. Destroying and unref-ing them is the difference between a suite
  // that reports a result and one that reports nothing.
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream?.removeAllListeners();
      stream?.destroy();
    } catch {
      /* nothing to close */
    }
  }
  try {
    child.unref();
  } catch {
    /* already gone */
  }
}
