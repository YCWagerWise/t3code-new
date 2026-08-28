/**
 * ACTIONS 075-090/153 — VCS, sourceControl, and git workflow RPCs.
 *
 * Wire-level browser e2e against the real Rust backend. These controls are not
 * all DOM gestures yet; their product contract is the Effect RPC surface the
 * frontend calls from the source-control panels.
 */
import { test, expect } from "../fixtures";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type SuccessExit = { readonly _tag: "Success"; readonly value: any };
type FailureExit = { readonly _tag: "Failure"; readonly cause: any };

function websocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("backend websocket failed to open")), {
      once: true,
    });
  });
}

function request(
  ws: WebSocket,
  tag: string,
  payload: Record<string, unknown>,
): Promise<SuccessExit | FailureExit> {
  const id = `${tag}-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`${tag} did not produce an Exit frame`));
    }, 90_000);
    function onMessage(event: MessageEvent) {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      let frame: any;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame?._tag !== "Exit" || frame.requestId !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame.exit);
    }
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ _tag: "Request", tag, id, payload }));
  });
}

async function success(ws: WebSocket, tag: string, payload: Record<string, unknown>): Promise<any> {
  const exit = await request(ws, tag, payload);
  expect(exit._tag, `${tag} should succeed: ${JSON.stringify(exit)}`).toBe("Success");
  return (exit as SuccessExit).value;
}

async function failure(ws: WebSocket, tag: string, payload: Record<string, unknown>): Promise<any> {
  const exit = await request(ws, tag, payload);
  expect(exit._tag, `${tag} should fail loudly: ${JSON.stringify(exit)}`).toBe("Failure");
  return (exit as FailureExit).cause;
}

function git(cwd: string, args: readonly string[]): void {
  let last: ReturnType<typeof spawnSync> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const out = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t3code e2e",
        GIT_AUTHOR_EMAIL: "t3code-e2e@example.invalid",
        GIT_COMMITTER_NAME: "t3code e2e",
        GIT_COMMITTER_EMAIL: "t3code-e2e@example.invalid",
      },
    });
    if (out.status === 0) return;
    last = out;
    if (!String(out.stderr).includes("index.lock")) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error(
    `git ${args.join(" ")} failed\nstdout:\n${last?.stdout ?? ""}\nstderr:\n${last?.stderr ?? ""}`,
  );
}

test("vcs actions are real git operations and cairn sees out-of-band edits", async ({
  backend,
}) => {
  const ws = await websocket(backend.port);
  try {
    await mkdir(join(backend.workspace, "src"), { recursive: true });
    await writeFile(join(backend.workspace, "src/lib.rs"), "pub fn base() {}\n");

    const init = await success(ws, "vcs.init", { cwd: backend.workspace });
    expect(init).toMatchObject({ isRepo: true, created: true });
    git(backend.workspace, ["add", "-A"]);
    git(backend.workspace, ["commit", "-qm", "base"]);

    const refs = await success(ws, "vcs.listRefs", { cwd: backend.workspace, limit: 20 });
    expect(refs.isRepo).toBe(true);
    const defaultRef = refs.refs.find((ref: any) => ref.current)?.name;
    expect(defaultRef).toEqual(expect.any(String));

    const created = await success(ws, "vcs.createRef", {
      cwd: backend.workspace,
      refName: "feature/e2e",
      switchRef: true,
    });
    expect(created.refName).toBe("feature/e2e");

    const switched = await success(ws, "vcs.switchRef", {
      cwd: backend.workspace,
      refName: defaultRef,
    });
    expect(switched.refName).toBe(defaultRef);

    spawnSync("sh", ["-c", "printf 'changed outside app\\n' >> src/lib.rs"], {
      cwd: backend.workspace,
      encoding: "utf8",
    });
    const status = await success(ws, "vcs.refreshStatus", { cwd: backend.workspace });
    expect(status.hasWorkingTreeChanges).toBe(true);
    expect(status.workingTree.files.map((file: any) => file.path)).toContain("src/lib.rs");

    const worktree = await success(ws, "vcs.createWorktree", {
      cwd: backend.workspace,
      refName: "feature/worktree-e2e",
      baseRefName: defaultRef,
    });
    expect(worktree.worktree.path).toEqual(expect.any(String));
    expect(worktree.worktree.refName).toBe("feature/worktree-e2e");
    expect(worktree.worktree.path).not.toContain(backend.workspace);

    const alien = join(backend.home, "not-this-apps-worktree");
    await mkdir(alien, { recursive: true });
    const refusedRemove = await failure(ws, "vcs.removeWorktree", {
      cwd: backend.workspace,
      path: alien,
    });
    expect(JSON.stringify(refusedRemove)).toMatch(/not created by this environment|not a worktree/);

    const removed = await success(ws, "vcs.removeWorktree", {
      cwd: backend.workspace,
      path: worktree.worktree.path,
    });
    expect(removed.path).toBe(worktree.worktree.path);

    const pull = await failure(ws, "vcs.pull", { cwd: backend.workspace });
    expect(JSON.stringify(pull)).toMatch(/upstream|remote|repository/i);
  } finally {
    ws.close();
  }
});

test("sourceControl actions are wired and validate product arguments before tools", async ({
  backend,
}) => {
  const ws = await websocket(backend.port);
  try {
    const discovery = await success(ws, "server.discoverSourceControl", {});
    expect(discovery.versionControlSystems.map((item: any) => item.kind)).toContain("git");
    expect(discovery.sourceControlProviders.map((item: any) => item.kind)).toContain("github");

    const cloneRefusal = await failure(ws, "sourceControl.cloneRepository", {
      remoteUrl: "https://example.invalid/repo.git",
      destinationPath: backend.workspace,
    });
    expect(JSON.stringify(cloneRefusal)).toContain("already exists");

    const lookupRefusal = await failure(ws, "sourceControl.lookupRepository", {
      provider: "bitbucket",
      repository: "team/repo",
    });
    expect(JSON.stringify(lookupRefusal)).toContain("bitbucket");

    const publishRefusal = await failure(ws, "sourceControl.publishRepository", {
      cwd: backend.workspace,
      provider: "github",
      repository: "team/repo",
      visibility: "private",
    });
    expect(JSON.stringify(publishRefusal)).not.toContain("unsupported method");

    await success(ws, "vcs.init", { cwd: backend.workspace });
    const badRepo = await failure(ws, "sourceControl.publishRepository", {
      cwd: backend.workspace,
      provider: "github",
      repository: "--template",
      visibility: "private",
    });
    expect(JSON.stringify(badRepo)).toContain("repository");
    expect(JSON.stringify(badRepo)).not.toContain("gh repo create");

    const badVisibility = await failure(ws, "sourceControl.publishRepository", {
      cwd: backend.workspace,
      provider: "github",
      repository: "team/repo",
      visibility: "disable-issues",
    });
    expect(JSON.stringify(badVisibility)).toContain("visibility must be public");

    const badRemote = await failure(ws, "sourceControl.publishRepository", {
      cwd: backend.workspace,
      provider: "github",
      repository: "team/repo",
      visibility: "private",
      remoteName: "--force",
    });
    expect(JSON.stringify(badRemote)).toContain("remoteName");
  } finally {
    ws.close();
  }
});

test("git stacked-action RPCs stream, cancel honestly, and unknown controls fail loudly", async ({
  backend,
}) => {
  const ws = await websocket(backend.port);
  try {
    await mkdir(join(backend.workspace, "src"), { recursive: true });
    await writeFile(join(backend.workspace, "src/main.rs"), "fn main() {}\n");
    await success(ws, "vcs.init", { cwd: backend.workspace });

    const cancelUnknown = await success(ws, "git.cancelStackedAction", {
      actionId: "missing-action",
    });
    expect(cancelUnknown).toMatchObject({ canceled: false });

    const commit = await success(ws, "git.runStackedAction", {
      cwd: backend.workspace,
      actionId: "commit-only",
      action: "commit",
      commitMessage: "add main",
    });
    expect(commit).toBeNull();
    const log = spawnSync("git", ["log", "--oneline", "-1"], {
      cwd: backend.workspace,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("add main");

    await writeFile(join(backend.workspace, "src/later.rs"), "pub fn later() {}\n");
    const pushFailure = await failure(ws, "git.runStackedAction", {
      cwd: backend.workspace,
      actionId: "commit-push-no-remote",
      action: "commit_push",
      commitMessage: "try push",
    });
    expect(JSON.stringify(pushFailure)).toMatch(/push|remote/i);

    for (const tag of [
      "git.attachStackedAction",
      "git.inspectStackedAction",
      "git.preparePullRequestThread",
      "git.resolvePullRequest",
    ]) {
      const cause = await failure(ws, tag, {
        cwd: backend.workspace,
        actionId: "commit-only",
      });
      expect(JSON.stringify(cause), `${tag} should not silently succeed`).toContain(tag);
    }

    await expect(readFile(join(backend.workspace, "src/later.rs"), "utf8")).resolves.toContain(
      "later",
    );
  } finally {
    ws.close();
  }
});
