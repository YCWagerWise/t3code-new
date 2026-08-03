/**
 * The E2E rig contract. Global setup boots a REAL atlas-host (fresh temp
 * workspace, its own port) and the REAL apps/web Vite server, then writes
 * this state file; specs read it to assert against all three layers —
 * the UI, the node's /feed wire, and the workspace on disk.
 *
 * Nothing here reuses a developer's running rig: the suite owns its node,
 * so a green run proves the stack boots from nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const T3CODE_ROOT = path.dirname(E2E_DIR);
export const WEB_APP_DIR = path.join(T3CODE_ROOT, "apps", "web");
/** atlas-rs sits two levels up from t3code (atlas/git-forks/t3code → atlas/atlas-rs). */
export const ATLAS_RS_DIR =
  process.env.ATLAS_RS_DIR ?? path.join(path.dirname(path.dirname(T3CODE_ROOT)), "atlas-rs");

export const NODE_PORT = 3197;
export const WEB_PORT = 5735;
export const NODE_BASE = `http://127.0.0.1:${NODE_PORT}`;
export const WEB_BASE = `http://localhost:${WEB_PORT}`;
export const DEV_TOKEN = "e2e-dev";

const STATE_FILE = path.join(E2E_DIR, ".rig-state.json");

export interface RigState {
  /** Workspace root the node was booted with — where run_bash effects land. */
  workspaceRoot: string;
  dataDir: string;
  nodePid: number;
  vitePid: number;
  nodeLog: string;
  viteLog: string;
}

export const writeRigState = (state: RigState): void => {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

export const readRigState = (): RigState => {
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as RigState;
};

export const clearRigState = (): void => {
  fs.rmSync(STATE_FILE, { force: true });
};

/** Poll until `check` resolves truthy or the deadline passes. */
export const waitFor = async (
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}: ${String(lastError ?? "check never passed")}`);
};
