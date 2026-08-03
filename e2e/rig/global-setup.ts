/**
 * Boots the whole stack from nothing:
 *   1. atlas-host (debug build; compiled first if absent) on :3197 with a fresh
 *      temp workspace root, ATLAS_BASH=1, and a WS token — same shape as the
 *      doc-15 §1.1 boot rig, but owned by the suite.
 *   2. The real apps/web Vite server on :5735 with the Atlas transport flag.
 *
 * No VITE_ATLAS_TOKEN is baked in: specs inject __ATLAS_TOKEN__ per test, so
 * the same server exercises setup-required, unauthorized, and connected.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ATLAS_RS_DIR,
  DEV_TOKEN,
  E2E_DIR,
  NODE_BASE,
  NODE_PORT,
  WEB_APP_DIR,
  WEB_BASE,
  WEB_PORT,
  waitFor,
  writeRigState,
} from "./rig.ts";

const LOG_DIR = path.join(E2E_DIR, ".logs");

const ensureNodeBinary = (): string => {
  const binary = path.join(ATLAS_RS_DIR, "target", "debug", "atlas-host");
  if (!fs.existsSync(binary)) {
    console.log(`[rig] atlas-host binary missing — building (${ATLAS_RS_DIR})`);
    execFileSync("cargo", ["build", "-p", "atlas-host"], {
      cwd: ATLAS_RS_DIR,
      stdio: "inherit",
      timeout: 15 * 60 * 1000,
    });
  }
  return binary;
};

const openLog = (name: string): { fd: number; file: string } => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, name);
  return { fd: fs.openSync(file, "w"), file };
};

export default async function globalSetup(): Promise<void> {
  const binary = ensureNodeBinary();

  const rigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-e2e-"));
  const workspaceRoot = path.join(rigRoot, "workspace");
  const dataDir = path.join(rigRoot, "data");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const nodeLog = openLog("node.log");
  const node = spawn(binary, ["serve", "--addr", `127.0.0.1:${NODE_PORT}`], {
    env: {
      ...process.env,
      ATLAS_DATA_DIR: dataDir,
      ATLAS_WS_TOKEN: DEV_TOKEN,
      ATLAS_WORKSPACE_ROOTS: workspaceRoot,
      ATLAS_BASH: "1",
      ATLAS_NODE_ID: "e2e",
      ATLAS_CORS_ORIGINS: `${WEB_BASE},http://127.0.0.1:${WEB_PORT}`,
      ATLAS_MODEL: "claude-opus-4-8",
    },
    stdio: ["ignore", nodeLog.fd, nodeLog.fd],
    detached: false,
  });
  await waitFor(
    `atlas-host on :${NODE_PORT}`,
    async () => {
      const response = await fetch(`${NODE_BASE}/_members`, {
        headers: { authorization: `Bearer ${DEV_TOKEN}` },
      });
      return response.status < 500;
    },
    30_000,
  );

  // The lens's project list is the node's /_workspaces catalog; a fresh node
  // has none and the app would sit on the no-projects hero. Seed one repo.
  const repoDir = path.join(workspaceRoot, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# e2e rig\n");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repoDir, "-c", "user.name=e2e-rig", "-c", "user.email=e2e@rig.local", ...args],
      { stdio: "pipe" },
    );
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "rig seed", "--no-gpg-sign");
  const registered = await fetch(`${NODE_BASE}/_workspaces`, {
    method: "POST",
    headers: { authorization: `Bearer ${DEV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ path: repoDir }),
  });
  if (!registered.ok) {
    throw new Error(`workspace registration failed: ${registered.status}`);
  }

  const viteLog = openLog("vite.log");
  const vite = spawn("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], {
    cwd: WEB_APP_DIR,
    env: {
      ...process.env,
      VITE_ATLAS_TRANSPORT: "1",
      VITE_HTTP_URL: NODE_BASE,
      VITE_WS_URL: `ws://127.0.0.1:${NODE_PORT}`,
    },
    stdio: ["ignore", viteLog.fd, viteLog.fd],
    detached: false,
  });
  await waitFor(`vite on :${WEB_PORT}`, async () => (await fetch(WEB_BASE)).ok, 60_000);

  writeRigState({
    workspaceRoot,
    dataDir,
    nodePid: node.pid!,
    vitePid: vite.pid!,
    nodeLog: nodeLog.file,
    viteLog: viteLog.file,
  });
  console.log(`[rig] node pid=${node.pid} web pid=${vite.pid} workspace=${workspaceRoot}`);
}
