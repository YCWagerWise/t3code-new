import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..");

function cargoBin() {
  if (process.env.CARGO) return process.env.CARGO;
  const homeCargo = join(process.env.HOME ?? "", ".cargo/bin/cargo");
  return existsSync(homeCargo) ? homeCargo : "cargo";
}

export async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
  });
}

function waitForLine(proc, pattern, label, timeoutMs = 180_000) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not become ready:\n${output.slice(-2000)}`));
    }, timeoutMs);
    const scan = (chunk) => {
      output += String(chunk);
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolvePromise(output);
      }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} failed to spawn: ${error.message}`));
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited before readiness (${code ?? signal}):\n${output.slice(-2000)}`));
    });
  });
}

function stopProcessGroup(proc) {
  if (proc.killed || proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

async function waitForExit(proc, timeoutMs = 5_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }
      resolvePromise();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

export async function startBackend(options = {}) {
  const workspace = options.workspace ?? (await mkdtemp(join(tmpdir(), "t3code-e2e-workspace-")));
  const data = options.data ?? (await mkdtemp(join(tmpdir(), "t3code-e2e-data-")));
  const port = options.port ?? (await freePort());
  const proc = spawn(
    cargoBin(),
    ["run", "--release", "--manifest-path", "backend/Cargo.toml", "--bin", "t3code-server"],
    {
      cwd: root,
      env: {
        ...process.env,
        T3CODE_WORKSPACE: workspace,
        T3CODE_AGENT_DATA: data,
        T3CODE_SERVER_PORT: String(port),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForLine(proc, /t3code-server .* listening|listening.*\/ws/, "Rust backend");
  return {
    proc,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    workspace,
    data,
    async stop() {
      stopProcessGroup(proc);
      await waitForExit(proc);
    },
  };
}

export async function startWeb(options = {}) {
  const port = options.port ?? (await freePort());
  const proc = spawn("pnpm", ["--dir", "apps/web", "dev", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env: {
      ...process.env,
      T3CODE_BACKEND: "rust",
      T3CODE_PORT: String(options.backendPort),
      T3CODE_SERVER_PORT: String(options.backendPort),
      T3CODE_SINGLE_ORIGIN_DEV: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForLine(proc, /Local:\s+http:\/\/127\.0\.0\.1:\d+|ready in|localhost:\d+/, "web dev server");
  return {
    proc,
    port,
    url: `http://127.0.0.1:${port}/`,
    async stop() {
      stopProcessGroup(proc);
      await waitForExit(proc);
    },
  };
}

export async function restartBackend(current) {
  const { workspace, data } = current;
  await current.stop();
  return await startBackend({ workspace, data });
}
