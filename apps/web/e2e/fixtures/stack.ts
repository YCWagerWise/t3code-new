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
 * A probe failure that CANNOT become true by waiting longer.
 *
 * `waitFor` retries on a thrown probe, which is right for a transient error —
 * a port not listening yet, a fetch refused mid-boot. It is exactly wrong for a
 * condition that is now permanent, and the boot probe has one: if dev-runner
 * has EXITED, no amount of polling will produce its banner.
 *
 * That distinction was missing, and it cost a diagnosis. `startStack`'s probe
 * deliberately threw `dev-runner exited with N` to fail fast; `waitFor` caught
 * it, stored it as `last`, and kept polling for the full `bootMs` — which
 * defaults to 1_800_000, so a runner that died in a second produced a THIRTY
 * MINUTE hang whose eventual message was a timeout, not the exit. Observed on
 * woodbine, where dev-runner exits 0 immediately under node 22.14 (its
 * entrypoint is guarded by `import.meta.main`, which that version does not
 * support) and the spec sat with no children at 0% CPU until the harness
 * timeout fired.
 *
 * Throw this when the wait is already lost, and `waitFor` reports it now.
 */
export class Unrecoverable extends Error {
  override readonly name = "Unrecoverable";
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
      // A permanent failure is reported NOW. Retrying it only converts a
      // precise cause into a generic timeout, later.
      if (error instanceof Unrecoverable) throw error;
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
    // DETACHED so the runner LEADS ITS OWN PROCESS GROUP, which is what makes
    // `killTree`'s `process.kill(-pid)` mean anything.
    //
    // Without it the runner shares this process's group, `-pid` is not a valid
    // pgid, the group kill throws, and the fallback `child.kill()` reaps only
    // the runner — leaving `vite` and `t3code-server` alive and REPARENTED TO
    // PID 1. Measured on woodbine: after all five specs reported, the suite
    // would not exit, with an orphaned vite (ppid 1) and a live
    // target/release/t3code-server still holding the port. Six stray dev
    // servers were up across cells at the time, which is the same leak in
    // everyone else's runs.
    //
    // This is hearth's own rule one layer up: kill the process GROUP, do not
    // orphan the tree. The tradeoff is that a detached child outlives an
    // abrupt parent death, so `dispose()` is now mandatory rather than
    // best-effort — which it already was, via the `after` hook.
    detached: true,
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
        // Unrecoverable: the runner is gone, so the banner is never coming.
        // Waiting out the remaining bootMs would replace this exit code and its
        // output with "TIMED OUT waiting for the banner", which is the wrong
        // diagnosis and the expensive one.
        throw new Unrecoverable(
          `dev-runner exited with ${exited} before printing its banner.\n` +
            `Runner output:\n${out.slice(-2000)}\n` +
            `If the output is empty, check the node version: this repo declares ` +
            `engines.node ^24.13.1 and scripts/dev-runner.ts guards its entrypoint ` +
            `with \`import.meta.main\`, which is unsupported before 22.18 — there ` +
            `the CLI never runs and the process exits 0 silently.`,
        );
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
