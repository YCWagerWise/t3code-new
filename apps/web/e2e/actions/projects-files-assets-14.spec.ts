/**
 * ACTIONS 091-104/153 — projects, filesystem, assets, attachments.
 *
 * This is a wire-level browser e2e against the real Rust backend. These actions
 * are not DOM gestures yet; the product contract is the Effect RPC action
 * surface the frontend calls from file pickers, preview panels and attachment
 * controls.
 */
import { test, expect } from "../fixtures";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type ExitFrame =
  | { readonly _tag: "Exit"; readonly requestId: string; readonly exit: SuccessExit }
  | { readonly _tag: "Exit"; readonly requestId: string; readonly exit: FailureExit };
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
  const requestId = `${tag}-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`${tag} did not produce an Exit frame`));
    }, 60_000);
    function onMessage(event: MessageEvent) {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      let frame: ExitFrame | undefined;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame?._tag !== "Exit" || frame.requestId !== requestId) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame.exit);
    }
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ _tag: "Request", tag, id: requestId, payload }));
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
  if (out.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`);
  }
}

test("projects/filesystem/assets action RPCs are implemented and confined", async ({ backend }) => {
  test.setTimeout(180_000);
  const ws = await websocket(backend.port);
  try {
    await mkdir(join(backend.workspace, "src"), { recursive: true });
    await writeFile(join(backend.workspace, "src/lib.rs"), "pub fn frobnicator() {}\n");
    await writeFile(join(backend.workspace, "README.md"), "needle project readme\n");
    await writeFile(join(backend.workspace, "logo.png"), "\x89PNG\n");
    git(backend.workspace, ["init", "-q"]);
    git(backend.workspace, ["add", "."]);
    git(backend.workspace, ["commit", "-qm", "seed"]);

    const listed = await success(ws, "projects.listEntries", { cwd: backend.workspace });
    expect(listed.entries.map((entry: any) => entry.path)).toContain("src/lib.rs");

    const entrySearch = await success(ws, "projects.searchEntries", {
      cwd: backend.workspace,
      query: "lib",
      limit: 10,
    });
    expect(entrySearch.entries.map((entry: any) => entry.path)).toContain("src/lib.rs");

    const contentSearch = await success(ws, "projects.searchContents", {
      cwd: backend.workspace,
      query: "needle",
      limit: 10,
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    expect(contentSearch.matches.map((match: any) => match.path)).toContain("README.md");

    const read = await success(ws, "projects.readFile", {
      cwd: backend.workspace,
      relativePath: "README.md",
    });
    expect(read.contents).toContain("needle project readme");

    const browse = await success(ws, "filesystem.browse", {
      cwd: backend.workspace,
      partialPath: `${backend.workspace}/s`,
    });
    expect(browse.entries.map((entry: any) => entry.name)).toContain("src");

    await success(ws, "projects.writeFile", {
      cwd: backend.workspace,
      relativePath: "src/generated.txt",
      contents: "generated through project action\n",
    });
    await expect(readFile(join(backend.workspace, "src/generated.txt"), "utf8")).resolves.toBe(
      "generated through project action\n",
    );

    const diff = await success(ws, "review.getDiffPreview", { cwd: backend.workspace });
    const workingTree = diff.sources.find((source: any) => source.kind === "working-tree");
    expect(workingTree?.diff).toContain("src/generated.txt");
    expect(workingTree?.diff).toContain("+generated through project action");

    const asset = await success(ws, "assets.createUrl", {
      resource: { _tag: "project-favicon", cwd: backend.workspace, path: "logo.png" },
    });
    expect(asset.relativeUrl).toMatch(/^\/api\/assets\//);
    expect(asset.expiresAt).toBeGreaterThan(Date.now());

    const okAsset = await fetch(`http://127.0.0.1:${backend.port}${asset.relativeUrl}`);
    expect(okAsset.status).toBe(200);
    expect(await okAsset.text()).toContain("PNG");

    const assetParts = String(asset.relativeUrl).split("/");
    const token = assetParts[3] ?? "";
    expect(token).toContain(".");
    const forgedToken = token.replace(/.$/, (last: string) => (last === "A" ? "B" : "A"));
    assetParts[3] = forgedToken;
    const forgedUrl = assetParts.join("/");
    const forged = await fetch(`http://127.0.0.1:${backend.port}${forgedUrl}`);
    expect(forged.status).toBe(403);

    const assetAttachmentFailure = await failure(ws, "assets.createUrl", {
      resource: { _tag: "attachment", attachmentId: "att-1" },
    });
    expect(JSON.stringify(assetAttachmentFailure)).toContain("attachments are not supported");
  } finally {
    ws.close();
  }
});

test("absent project and attachment actions fail loudly on the real backend", async ({
  backend,
}) => {
  const ws = await websocket(backend.port);
  try {
    for (const tag of [
      "projects.add",
      "projects.list",
      "projects.remove",
      "attachments.createUploadUrl",
      "attachments.delete",
    ]) {
      const cause = await failure(ws, tag, {});
      expect(JSON.stringify(cause), `${tag} should name the unsupported method`).toContain(tag);
    }

    const attachmentTurn = await failure(ws, "orchestration.dispatchCommand", {
      input: {
        type: "thread.turn.start",
        commandId: "cmd-attachments",
        threadId: "thread-attachments",
        runtimeMode: "full-access",
        interactionMode: "chat",
        message: {
          messageId: "msg-attachments",
          role: "user",
          text: "what is this?",
          attachments: [
            { kind: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
          ],
        },
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5-20251001" },
      },
    });
    expect(JSON.stringify(attachmentTurn)).toContain("attachments are not yet routable");
  } finally {
    ws.close();
  }
});

test("orchestration search and workflow-script actions use typed contract exits", async ({
  backend,
}) => {
  const ws = await websocket(backend.port);
  try {
    const search = await success(ws, "orchestration.searchThreads", {
      input: { query: "missing-thread-query", limit: 5 },
    });
    expect(Array.isArray(search.matches)).toBe(true);

    const workflow = await failure(ws, "orchestration.getWorkflowScript", {
      input: { threadId: "thread-1", scriptPath: "workflow.js" },
    });
    expect(JSON.stringify(workflow)).toContain("OrchestrationGetWorkflowScriptError");
    expect(JSON.stringify(workflow)).toContain("root-unavailable");
  } finally {
    ws.close();
  }
});
