/** Kills the rig the suite booted and removes its temp tree. Logs are kept. */
import * as fs from "node:fs";
import * as path from "node:path";
import { clearRigState, readRigState } from "./rig.ts";

const kill = (pid: number): void => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
};

export default async function globalTeardown(): Promise<void> {
  let state;
  try {
    state = readRigState();
  } catch {
    return;
  }
  kill(state.vitePid);
  kill(state.nodePid);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const pid of [state.vitePid, state.nodePid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* exited on SIGTERM */
    }
  }
  fs.rmSync(path.dirname(state.workspaceRoot), { recursive: true, force: true });
  clearRigState();
}
