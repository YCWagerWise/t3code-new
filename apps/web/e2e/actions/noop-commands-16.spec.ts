import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after, before, describe, test } from "node:test";

type JsonObject = Record<string, unknown>;

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const PROJECT_ID = process.env.T3_E2E_PROJECT_ID ?? "p-workspace";
const THREAD_ID = process.env.T3_E2E_THREAD_ID ?? `thread-noop-${Date.now()}`;
let baseUrl = process.env.T3_E2E_BASE_URL ?? "";
let server: ChildProcessWithoutNullStreams | undefined;
let rpcSocket: WebSocket | undefined;

const MODEL_SELECTION = {
  instanceId: process.env.T3_E2E_INSTANCE_ID ?? "codex",
  model: process.env.T3_E2E_MODEL ?? "gpt-5",
};

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function commandId(label: string): string {
  return `cmd-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function matchesObject(actual: unknown, expected: JsonObject): void {
  assert.equal(typeof actual, "object");
  assert.notEqual(actual, null);
  for (const [key, value] of Object.entries(expected)) {
    const received = (actual as JsonObject)[key];
    if (value === String) {
      assert.equal(typeof received, "string", `${key} should be a string`);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      matchesObject(received, value as JsonObject);
    } else {
      assert.deepEqual(received, value, `${key} mismatch`);
    }
  }
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return text.length > 0 ? (JSON.parse(text) as JsonObject) : {};
}

function wsUrl(): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

async function socket(): Promise<WebSocket> {
  if (rpcSocket !== undefined && rpcSocket.readyState === WebSocket.OPEN) return rpcSocket;

  rpcSocket = new WebSocket(wsUrl());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket did not open: ${wsUrl()}`)), 30_000);
    rpcSocket!.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    rpcSocket!.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`websocket failed to open: ${wsUrl()}`));
      },
      { once: true },
    );
  });
  return rpcSocket;
}

async function dispatch(command: JsonObject): Promise<JsonObject> {
  const ws = await socket();
  const id = commandId(String(command.type));
  ws.send(
    JSON.stringify({
      _tag: "Request",
      id,
      tag: "orchestration.dispatchCommand",
      payload: {
        input: { ...command, commandId: command.commandId ?? id },
      },
    }),
  );
  const exit = await new Promise<JsonObject>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no Exit for ${command.type}`)), 30_000);
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as JsonObject;
      if (frame._tag !== "Exit" || frame.requestId !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage);
  });
  matchesObject(exit, { exit: { _tag: "Success" } });
  const value = (exit.exit as JsonObject).value as JsonObject;
  assert.equal(typeof value.sequence, "number");
  return value;
}

async function shellSnapshot(): Promise<JsonObject> {
  return readJson(await fetch(`${baseUrl}/api/orchestration/shell`));
}

function threads(snapshot: JsonObject): JsonObject[] {
  return Array.isArray(snapshot.threads) ? (snapshot.threads as JsonObject[]) : [];
}

function projects(snapshot: JsonObject): JsonObject[] {
  return Array.isArray(snapshot.projects) ? (snapshot.projects as JsonObject[]) : [];
}

function findThread(snapshot: JsonObject, threadId = THREAD_ID): JsonObject | undefined {
  return threads(snapshot).find((thread) => thread.id === threadId);
}

function findProject(snapshot: JsonObject, projectId = PROJECT_ID): JsonObject | undefined {
  return projects(snapshot).find((project) => project.id === projectId);
}

function activities(thread: JsonObject | undefined): JsonObject[] {
  return thread !== undefined && Array.isArray(thread.activities)
    ? (thread.activities as JsonObject[])
    : [];
}

async function ensureThread(): Promise<void> {
  if (findThread(await shellSnapshot()) !== undefined) return;

  await dispatch({
    type: "thread.create",
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "No-op command persistence probe",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: iso(),
  });
}

describe("ACTIONS 051-066 do not acknowledge non-persistent commands", () => {
  before(async () => {
    if (baseUrl !== "") return;

    const binDir = path.join(ROOT, "node_modules", ".bin");
    const port = 17_000 + (process.pid % 10_000);
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}/home/nala/.cargo/bin${path.delimiter}${process.env.PATH ?? ""}`,
      T3CODE_SERVER_PORT: String(port),
    };
    server = spawn(
      process.env.CARGO ?? "cargo",
      ["run", "--release", "--manifest-path", "backend/Cargo.toml", "--bin", "t3code-server"],
      {
        cwd: ROOT,
        env,
      },
    );
    let output = "";
    baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`t3code-server did not listen in 240s:\n${output.slice(-2000)}`));
      }, 240_000);
      const scan = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/listening.*127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]!}`);
        }
      };
      server!.stdout.on("data", scan);
      server!.stderr.on("data", scan);
      server!.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server!.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`t3code-server exited ${code} before listening:\n${output}`));
      });
    });
  });

  after(() => {
    rpcSocket?.close();
    server?.kill("SIGKILL");
  });

  test("051 thread.create ACK persists a reload-visible thread", async () => {
    await dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Created by action 051",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: iso(),
    });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      title: "Created by action 051",
    });
  });

  test("052 thread.delete ACK persists deletion across reload", async () => {
    await ensureThread();
    matchesObject(findThread(await shellSnapshot()), { id: THREAD_ID });
    await dispatch({ type: "thread.delete", threadId: THREAD_ID });

    assert.equal(findThread(await shellSnapshot()), undefined);
  });

  test("053 thread.archive ACK persists archivedAt across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.archive", threadId: THREAD_ID });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      archivedAt: String,
    });
  });

  test("054 thread.unarchive ACK clears archivedAt across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.archive", threadId: THREAD_ID });
    await dispatch({ type: "thread.unarchive", threadId: THREAD_ID });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      archivedAt: null,
    });
  });

  test("055 thread.settle ACK persists settled override across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.settle", threadId: THREAD_ID });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      settledOverride: "settled",
      settledAt: String,
    });
  });

  test("056 thread.unsettle ACK clears settled override across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.settle", threadId: THREAD_ID });
    await dispatch({ type: "thread.unsettle", threadId: THREAD_ID, reason: "user" });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      settledOverride: "active",
      settledAt: null,
    });
  });

  test("057 thread.snooze ACK persists snooze fields across reload", async () => {
    await ensureThread();
    const snoozedUntil = iso(60 * 60 * 1000);
    await dispatch({ type: "thread.snooze", threadId: THREAD_ID, snoozedUntil });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      snoozedUntil,
      snoozedAt: String,
    });
  });

  test("058 thread.unsnooze ACK clears snooze fields across reload", async () => {
    await ensureThread();
    await dispatch({
      type: "thread.snooze",
      threadId: THREAD_ID,
      snoozedUntil: iso(60 * 60 * 1000),
    });
    await dispatch({ type: "thread.unsnooze", threadId: THREAD_ID, reason: "user" });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      snoozedUntil: null,
      snoozedAt: null,
    });
  });

  test("059 thread.pin ACK persists pinnedAt across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.pin", threadId: THREAD_ID, orderKey: "m" });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      pinnedAt: String,
      pinOrderKey: "m",
    });
  });

  test("060 thread.unpin ACK clears pin state across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.pin", threadId: THREAD_ID, orderKey: "m" });
    await dispatch({ type: "thread.unpin", threadId: THREAD_ID });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      pinnedAt: null,
      pinOrderKey: null,
    });
  });

  test("061 thread.pin.reorder ACK persists pin order across reload", async () => {
    await ensureThread();
    await dispatch({ type: "thread.pin", threadId: THREAD_ID, orderKey: "m" });
    await dispatch({ type: "thread.pin.reorder", threadId: THREAD_ID, orderKey: "t" });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      pinnedAt: String,
      pinOrderKey: "t",
    });
  });

  test("062 thread.runtime-mode.set ACK persists runtime mode across reload", async () => {
    await ensureThread();
    await dispatch({
      type: "thread.runtime-mode.set",
      threadId: THREAD_ID,
      runtimeMode: "approval-required",
      createdAt: iso(),
    });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      runtimeMode: "approval-required",
    });
  });

  test("063 thread.interaction-mode.set ACK persists interaction mode across reload", async () => {
    await ensureThread();
    await dispatch({
      type: "thread.interaction-mode.set",
      threadId: THREAD_ID,
      interactionMode: "plan",
      createdAt: iso(),
    });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      interactionMode: "plan",
    });
  });

  test("064 thread.session.set ACK persists the session projection across reload", async () => {
    await ensureThread();
    await dispatch({
      type: "thread.session.set",
      threadId: THREAD_ID,
      session: {
        id: "session-noop-064",
        provider: "codex",
        model: "gpt-5",
        state: "running",
        startedAt: iso(),
        completedAt: null,
      },
      createdAt: iso(),
    });

    matchesObject(findThread(await shellSnapshot()), {
      id: THREAD_ID,
      session: { id: "session-noop-064" },
    });
  });

  test("065 thread.activity.append ACK persists activity across reload", async () => {
    await ensureThread();
    await dispatch({
      type: "thread.activity.append",
      threadId: THREAD_ID,
      activity: {
        id: "activity-noop-065",
        kind: "system",
        summary: "noop persistence probe",
        payload: {},
        createdAt: iso(),
        sequence: 65,
      },
      createdAt: iso(),
    });

    assert.ok(
      activities(findThread(await shellSnapshot())).some(
        (activity) => activity.id === "activity-noop-065",
      ),
    );
  });

  test("066 project.create ACK persists a reload-visible project", async () => {
    const projectId = `project-noop-${Date.now()}`;
    await dispatch({
      type: "project.create",
      projectId,
      title: "Created by action 066",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt: iso(),
    });

    matchesObject(findProject(await shellSnapshot(), projectId), {
      id: projectId,
      title: "Created by action 066",
    });
  });

  test("066b project.delete ACK removes the project across reload", async () => {
    const projectId = `project-delete-noop-${Date.now()}`;
    await dispatch({
      type: "project.create",
      projectId,
      title: "Deleted by action 066b",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt: iso(),
    });
    matchesObject(findProject(await shellSnapshot(), projectId), { id: projectId });
    await dispatch({ type: "project.delete", projectId, force: true });

    assert.equal(findProject(await shellSnapshot(), projectId), undefined);
  });
});
