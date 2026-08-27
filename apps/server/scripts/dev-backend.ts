/**
 * Which backend `pnpm dev` starts.
 *
 * Until now there was no answer to that question, because there was only one:
 * `apps/server` dev was `node --watch src/bin.ts`, and NOTHING in the repo's dev
 * path built or ran `backend/` at all — no reference to it in
 * `scripts/dev-runner.ts` or `t3.json`, and no way to ask for it. So every
 * contributor driving the app in a browser was driving the Node server, and a
 * defect in the Rust backend was invisible to that loop by construction.
 *
 * The choice belongs HERE rather than in `scripts/dev-runner.ts`: the runner's
 * job is resolving ports, env and the T3 home, and it hands the same script name
 * to every filtered package. Putting the switch in the server package keeps
 * `dev`, `dev:server` and `dev:desktop` all working unchanged, and keeps the
 * backend decision next to the thing being decided.
 *
 *   pnpm dev                        # Node server (unchanged default)
 *   T3CODE_BACKEND=rust pnpm dev    # the Rust backend
 *
 * The port is not ours to invent. `dev-runner` allocates one server port and
 * tells the web client about it; both backends must bind THAT port or the web
 * client proxies `/api` and `/ws` at nothing. Node reads it from `T3CODE_PORT`,
 * the Rust server from `T3CODE_SERVER_PORT`, and dev-runner now exports both to
 * the same number.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";

type Backend = "node" | "rust";

class DevBackendRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DevBackendRefused";
  }
}

/**
 * A typo must not silently fall back to the other backend. Someone who meant
 * `rust` and typed `rustt` would otherwise get the Node server, screenshot it,
 * and file a finding about a backend they never ran.
 */
const selectBackend = (raw: string | undefined): Effect.Effect<Backend, DevBackendRefused> => {
  const value = (raw ?? "node").trim().toLowerCase();
  if (value === "rust" || value === "node") return Effect.succeed(value);
  return Effect.fail(
    new DevBackendRefused(
      `T3CODE_BACKEND=${JSON.stringify(value)} is not recognised. Use "node" or "rust".`,
    ),
  );
};

/**
 * `dev-runner` exports `T3CODE_SERVER_PORT` for exactly this. Started outside the
 * runner, fall back to the web-side `T3CODE_PORT`; with neither, REFUSE rather
 * than letting the Rust server take its own 13774 default while the browser
 * proxies at 13773 and the app looks broken for a reason nobody can see.
 */
const resolveRustPort = (
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<string, DevBackendRefused> => {
  const explicit = env.T3CODE_SERVER_PORT;
  if (explicit !== undefined) return Effect.succeed(explicit);
  const web = env.T3CODE_PORT;
  if (web !== undefined) return Effect.succeed(web);
  return Effect.fail(
    new DevBackendRefused(
      "neither T3CODE_SERVER_PORT nor T3CODE_PORT is set. Run this through `pnpm dev`, " +
        "which allocates the port, or set T3CODE_SERVER_PORT yourself.",
    ),
  );
};

const run = Effect.gen(function* () {
  const path = yield* Path.Path;
  // `new URL(".", import.meta.url)` already ends in `scripts/`, so dirname()
  // strips the trailing slash and lands on `apps/server` — not `scripts`. Going
  // one more `..` from there walked out to `apps/`, and the cargo manifest path
  // resolved to `<workspace>/backend/Cargo.toml`, which does not exist.
  const serverDir = path.dirname(new URL(".", import.meta.url).pathname);
  const repoRoot = path.resolve(serverDir, "..", "..");

  const backend = yield* selectBackend(process.env.T3CODE_BACKEND);
  const env: Record<string, string | undefined> = { ...process.env };

  let command: string;
  let args: ReadonlyArray<string>;
  if (backend === "node") {
    command = process.execPath;
    args = ["--watch", path.join(serverDir, "src", "bin.ts")];
  } else {
    const port = yield* resolveRustPort(env);
    env.T3CODE_SERVER_PORT = port;
    // `--release` because a debug build of the whole workspace is slow enough
    // that people stop running it, and an unrun backend is the state this file
    // exists to end. cargo prints its own progress, so a first run is visibly
    // compiling rather than silently hung.
    command = "cargo";
    args = [
      "run",
      "--release",
      "--manifest-path",
      path.join(repoRoot, "backend", "Cargo.toml"),
      "--bin",
      "t3code-server",
    ];
  }

  yield* Effect.logInfo(
    `[dev-backend] backend=${backend} port=${env.T3CODE_SERVER_PORT ?? env.T3CODE_PORT ?? "?"}`,
  );

  const child = yield* ChildProcess.make(command, [...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: serverDir,
    env,
    extendEnv: false,
    // Same reason dev-runner pins this: stay in the caller's process group so a
    // terminal Ctrl+C reaches the child directly. Effect defaults to detached on
    // non-Windows, and a detached cargo survives the runner and then holds the
    // build directory lock — the next run sits on "Blocking waiting for file
    // lock" with no output explaining why.
    detached: false,
    forceKillAfter: "1500 millis",
  });

  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    yield* Effect.logError(`[dev-backend] ${backend} backend exited with code ${exitCode}`);
  }
  return exitCode;
});

NodeRuntime.runMain(
  run.pipe(
    Effect.catchTag("DevBackendRefused", (error) =>
      Effect.logError(`[dev-backend] ${error.message}`).pipe(Effect.as(2)),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.sync(() => {
            process.exitCode = code;
          }),
    ),
  ),
);
