import {
  AtlasSettings,
  EventId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { atlasFeedUrl } from "./AtlasClient.ts";
import {
  eventsForFrame,
  type FrameContext,
  makeAtlasAdapter,
  outboundDisposition,
  socketLossEvents,
} from "./AtlasAdapter.ts";

const CTX: FrameContext = {
  runId: "thr-abc",
  threadId: ThreadId.make("abc"),
  instanceId: ProviderInstanceId.make("atlas"),
  activeTurnId: TurnId.make("11111111-1111-4111-8111-111111111111"),
};
const STAMP = {
  eventId: EventId.make("22222222-2222-4222-8222-222222222222"),
  createdAt: "2026-07-26T00:00:00.000Z",
};

const map = (frame: unknown): ReadonlyArray<ProviderRuntimeEvent> =>
  eventsForFrame(CTX, frame as Parameters<typeof eventsForFrame>[1], STAMP);
const types = (frame: unknown) => map(frame).map((e) => e.type);

describe("eventsForFrame", () => {
  it("maps a turn boundary to the matching lifecycle event", () => {
    expect(types({ kind: "turn", payload: { state: "start" } })).toEqual(["turn.started"]);
    expect(types({ kind: "turn", payload: { state: "done" } })).toEqual(["turn.completed"]);
    // An error turn now reports the CLASS Atlas declared as well as closing the lifecycle.
    // `runtime.error` is the only event carrying a class, and it is already consumed.
    expect(types({ kind: "turn", payload: { state: "error" } })).toEqual([
      "runtime.error",
      "turn.completed",
    ]);
  });

  it("reports a cancelled turn as aborted, not as a completed one", () => {
    // The failure this replaces: `cancelled` fell through to the `turn.completed{completed}`
    // default, so a turn the user stopped rendered as a green successful one. `turn.aborted`
    // is the event ingestion already maps to status "ready" with no `lastError`.
    expect(types({ kind: "turn", payload: { state: "cancelled" } })).toEqual(["turn.aborted"]);
    const [event] = map({ kind: "turn", payload: { state: "cancelled", text: "stopped by user" } });
    expect(event).toMatchObject({ type: "turn.aborted", payload: { reason: "stopped by user" } });
  });

  it("gives a cancelled turn a reason even when Atlas sends none", () => {
    const [event] = map({ kind: "turn", payload: { state: "cancelled" } });
    expect(event).toMatchObject({ payload: { reason: "Cancelled" } });
  });

  it("surfaces a policy refusal as a denied tool", () => {
    // `Policy::decide`'s Deny verdict. Nothing to resolve — the point is that the user sees
    // WHY, instead of a tool that silently did nothing.
    const [event] = map({
      kind: "deny",
      payload: { tool: "run_bash", reason: "catastrophic delete of filesystem root" },
    });
    expect(event).toMatchObject({
      type: "tool.denied",
      payload: { toolName: "run_bash", reason: "catastrophic delete of filesystem root" },
    });
  });

  it("names something on a denial that arrives without a tool", () => {
    // `toolName` is required by the contract; dropping the frame would hide the refusal.
    const [event] = map({ kind: "deny", payload: { reason: "blocked" } });
    expect(event).toMatchObject({ payload: { toolName: "tool" } });
  });

  it("opens a resolvable request when Atlas holds a tool call", () => {
    const [event] = map({
      kind: "approval",
      payload: {
        request_id: "thr-1:call-7",
        tool: "run_bash",
        args: { cmd: "git push" },
        reason: "`git push` needs approval on this node",
      },
    });
    expect(event).toMatchObject({
      type: "request.opened",
      requestId: "thr-1:call-7",
      payload: {
        requestType: "command_execution_approval",
        detail: "`git push` needs approval on this node",
        args: { toolName: "run_bash", input: { cmd: "git push" } },
      },
    });
  });

  it("ignores an approval with no request id, which nothing could resolve", () => {
    expect(types({ kind: "approval", payload: { tool: "run_bash" } })).toEqual([]);
  });

  it("carries the Atlas failure reason onto a failed completed turn", () => {
    // The whole point of Atlas declaring `state:"error"` is that the reason
    // survives instead of being recovered by substring-matching an error string.
    const events = map({ kind: "turn", payload: { state: "error", text: "backend down" } });
    expect(events[1]).toMatchObject({
      type: "turn.completed",
      payload: { state: "failed", errorMessage: "backend down" },
    });
    // The class rides with it, taken from Atlas rather than recovered from the message.
    expect(events[0]).toMatchObject({
      type: "runtime.error",
      payload: { message: "backend down", class: "unknown" },
    });
  });

  it("falls back to a reason when Atlas reports an error with no text", () => {
    const events = map({ kind: "turn", payload: { state: "error" } });
    // TrimmedNonEmptyString would reject "", so a placeholder is required, not cosmetic.
    expect(events[1]).toMatchObject({
      payload: { state: "failed", errorMessage: "Atlas run failed" },
    });
  });

  it("carries the failure class Atlas declared instead of guessing from the message", () => {
    // The whole reason `ErrorClass` exists: the body knows at the point of failure whether it
    // was the provider or the transport, so no lens has to pattern-match an error string.
    const [err] = map({
      kind: "turn",
      payload: { state: "error", text: "dispatch 503", class: "transport_error" },
    });
    expect(err).toMatchObject({ type: "runtime.error", payload: { class: "transport_error" } });
  });

  it("stays honestly unknown when Atlas declares no class", () => {
    const [err] = map({ kind: "turn", payload: { state: "error", text: "boom" } });
    expect(err).toMatchObject({ payload: { class: "unknown" } });
  });

  it("surfaces a delegated turn as a task running on another node", () => {
    // Delegation is the one Atlas capability with no provider analogue, and it used to render
    // as an unexplained pause in the caller's timeline.
    const started = map({
      kind: "edge",
      payload: {
        edge: "delegate",
        to: "http://metatron:3010",
        run_id: "deleg-9",
        state: "start",
        task: "check disk",
      },
    });
    expect(started[0]).toMatchObject({
      type: "task.started",
      // taskId is the CHILD run, so a lens can follow the work to the other feed.
      payload: {
        taskId: "deleg-9",
        description: "→ http://metatron:3010: check disk",
        taskType: "delegate",
      },
    });

    const done = map({
      kind: "edge",
      payload: { to: "http://metatron:3010", run_id: "deleg-9", state: "done", detail: "42% used" },
    });
    expect(done[0]).toMatchObject({
      type: "task.completed",
      payload: { taskId: "deleg-9", status: "completed", summary: "42% used" },
    });
  });

  it("reports a failed delegation as a failed task, not a completed one", () => {
    const [event] = map({
      kind: "edge",
      payload: {
        to: "http://seraphim:3010",
        run_id: "deleg-x",
        state: "error",
        detail: "connection refused",
      },
    });
    expect(event).toMatchObject({ payload: { status: "failed", summary: "connection refused" } });
  });

  it("drops an edge with no child run, which nothing could follow", () => {
    expect(types({ kind: "edge", payload: { to: "somewhere", state: "start" } })).toEqual([]);
  });

  it("expands an assistant answer into a complete item lifecycle", () => {
    const events = map({ kind: "assistant", seq: 7, payload: { text: "hello" } });
    expect(events.map((e) => e.type)).toEqual(["item.started", "content.delta", "item.completed"]);
    expect(events[1]).toMatchObject({ payload: { streamKind: "assistant_text", delta: "hello" } });
    // One stable item id across the three events, or the UI renders three items.
    const ids = new Set(events.map((e) => e.itemId));
    expect(ids.size).toBe(1);
  });

  it("keys tool events by call_id so a result closes its own call", () => {
    const started = map({ kind: "tool_call", payload: { call_id: "c1", tool: "run_bash" } });
    const finished = map({
      kind: "tool_result",
      payload: { call_id: "c1", tool: "run_bash", ok: true, summary: "exit 0" },
    });
    expect(started[0]?.itemId).toBe(finished[0]?.itemId);
    expect(finished.map((e) => e.type)).toEqual(["item.completed", "tool.summary"]);
    expect(finished[1]).toMatchObject({ payload: { summary: "exit 0" } });
  });

  // A tool result must arrive as a VERDICT, not just a row. Absent `status` the client
  // assumes "completed", so a failed call renders with a success check — the exact
  // ambiguity GAP-002 exists to remove.
  it("marks a failed tool call failed rather than letting it default to success", () => {
    const [completed] = map({
      kind: "tool_result",
      payload: { call_id: "c3", tool: "run_bash", ok: false, summary: "no such file" },
    });
    expect(completed).toMatchObject({
      payload: { itemType: "dynamic_tool_call", status: "failed", detail: "no such file" },
    });
  });

  it("treats a result with no ok flag as successful, so an older node is unchanged", () => {
    const [completed] = map({ kind: "tool_result", payload: { call_id: "c4", tool: "x" } });
    expect(completed).toMatchObject({ payload: { status: "completed" } });
  });

  // `tool.summary` reaches no consumer in T3 (`runtimeEventToActivities` has no case for it),
  // so `detail` is the only path Atlas's result text has to the screen — and it is also what
  // makes the row expandable.
  it("carries the result onto detail, not only onto the unconsumed summary event", () => {
    const [completed] = map({
      kind: "tool_result",
      payload: { call_id: "c5", tool: "run_bash", ok: true, summary: "exit=0\nhello" },
    });
    expect(completed).toMatchObject({ payload: { detail: "exit=0\nhello" } });
  });

  it("carries args and duration as structured data on both edges", () => {
    const [started] = map({
      kind: "tool_call",
      payload: { call_id: "c6", tool: "run_bash", args: { command: "echo hi" } },
    });
    const [completed] = map({
      kind: "tool_result",
      payload: {
        call_id: "c6",
        tool: "run_bash",
        ok: true,
        duration_ms: 65,
        args: { command: "echo hi" },
      },
    });
    expect(started).toMatchObject({
      payload: { status: "inProgress", data: { args: { command: "echo hi" } } },
    });
    expect(completed).toMatchObject({ payload: { data: { durationMs: 65 } } });
  });

  it("omits data entirely when Atlas sends neither args nor duration", () => {
    const [completed] = map({ kind: "tool_result", payload: { call_id: "c7", ok: true } });
    expect(completed?.payload).not.toHaveProperty("data");
  });

  it("omits the tool summary when Atlas reports an empty one", () => {
    // TrimmedNonEmptyString rejects "", so emitting it would produce an invalid event.
    const events = map({ kind: "tool_result", payload: { call_id: "c2", summary: "   " } });
    expect(events.map((e) => e.type)).toEqual(["item.completed"]);
  });

  // Atlas derives a diff from a git checkpoint at the turn boundary rather than from tool
  // calls, which is why it can report a file `sed` wrote inside `run_bash` — an edit no tool
  // lifecycle event ever saw. Each changed path becomes a `file_change` row, a canonical
  // lifecycle item type that renders with machinery T3 already has.
  it("expands a diff into the panel event and one file_change row per path", () => {
    const events = map({
      kind: "diff",
      seq: 7,
      payload: {
        unified: "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n",
        files: [
          { path: "src/lib.rs", status: "M" },
          { path: "made-by-bash.txt", status: "A" },
        ],
        checkpoint: 3,
      },
    });
    expect(events.map((e) => e.type)).toEqual([
      "turn.diff.updated",
      "item.completed",
      "item.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "turn.diff.updated",
      payload: { unifiedDiff: "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new" },
    });
    expect(events[1]).toMatchObject({
      payload: { itemType: "file_change", title: "src/lib.rs", detail: "modified" },
    });
    expect(events[2]).toMatchObject({
      payload: { itemType: "file_change", title: "made-by-bash.txt", detail: "added" },
    });
  });

  it("gives each file_change row its own item id so one does not overwrite the next", () => {
    // Keyed on seq alone, both rows would share an id and the timeline would show one file.
    const events = map({
      kind: "diff",
      seq: 7,
      payload: {
        unified: "diff --git a/x b/x\n",
        files: [
          { path: "x", status: "M" },
          { path: "y", status: "A" },
        ],
      },
    });
    const ids = events.filter((e) => e.type === "item.completed").map((e) => e.itemId);
    expect(new Set(ids).size).toBe(2);
  });

  it("says nothing when a turn changed no files", () => {
    // Atlas does not publish an empty diff, but a frame that arrives with nothing to show
    // must not produce a diff panel event promising content that is not there.
    expect(types({ kind: "diff", payload: { unified: "", files: [] } })).toEqual([]);
    expect(types({ kind: "diff", payload: {} })).toEqual([]);
  });

  it("drops a file entry with no path rather than rendering a nameless row", () => {
    const events = map({
      kind: "diff",
      payload: { unified: "diff --git a/x b/x\n", files: [{ status: "M" }, { path: "x" }] },
    });
    expect(events.map((e) => e.type)).toEqual(["turn.diff.updated", "item.completed"]);
    // A file entry with no status is still a real change; git's default classification is a
    // modification, and dropping the row would lose the path.
    expect(events[1]).toMatchObject({ payload: { title: "x", detail: "modified" } });
  });

  // A warning is not an error: the turn is still running, and an error row would report a
  // failure that did not happen. Atlas raises this when it cannot honour a request as stated.
  it("maps a warning to runtime.warning, never to runtime.error", () => {
    const events = map({
      kind: "warning",
      payload: { message: "'deepseek-coder:6.7b' cannot call tools" },
    });
    expect(events.map((e) => e.type)).toEqual(["runtime.warning"]);
    expect(events[0]).toMatchObject({
      payload: { message: "'deepseek-coder:6.7b' cannot call tools" },
    });
  });

  it("drops an empty warning rather than emitting an invalid event", () => {
    // TrimmedNonEmptyString rejects "", so emitting it would produce an unparseable event.
    expect(map({ kind: "warning", payload: { message: "   " } })).toEqual([]);
  });

  it("passes context pressure through without normalization", () => {
    const [event] = map({ kind: "ctx", payload: { used: 1200, window: 200000 } });
    expect(event).toMatchObject({
      type: "thread.token-usage.updated",
      payload: { usage: { usedTokens: 1200, maxTokens: 200000 } },
    });
  });

  it("drops a context frame that is missing either number", () => {
    expect(map({ kind: "ctx", payload: { used: 10 } })).toEqual([]);
    expect(map({ kind: "ctx", payload: {} })).toEqual([]);
  });

  it("maps reasoning to a reasoning stream, not assistant text", () => {
    const [event] = map({ kind: "thinking", payload: { text: "considering" } });
    expect(event).toMatchObject({ payload: { streamKind: "reasoning_text" } });
  });

  it("surfaces an Atlas error frame as a runtime error", () => {
    const [event] = map({ kind: "error", error: "unauthenticated" });
    expect(event).toMatchObject({ type: "runtime.error", payload: { message: "unauthenticated" } });
  });

  it("passes through the error class Atlas declared", () => {
    for (const declared of [
      "permission_error",
      "transport_error",
      "validation_error",
      "provider_error",
    ]) {
      const [event] = map({ kind: "error", error: "boom", class: declared });
      expect(event).toMatchObject({ payload: { class: declared } });
    }
  });

  it("reports unknown rather than guessing when Atlas declares no class", () => {
    // The alternative — recovering the class by matching the message — is the
    // `isClaudeInterruptedMessage` anti-pattern. An honest `unknown` beats a
    // confident guess.
    const [noClass] = map({ kind: "error", error: "unauthenticated" });
    expect(noClass).toMatchObject({ payload: { class: "unknown" } });

    const [bogus] = map({ kind: "error", error: "boom", class: "not_a_real_class" });
    expect(bogus).toMatchObject({ payload: { class: "unknown" } });
  });

  it("emits nothing for a question, which Atlas still cannot resolve", () => {
    // Approvals used to be listed here too, with a note saying this assertion should be
    // deleted when Atlas could actually resolve one. It can now — the tool gate holds the
    // call open and `respondToRequest` releases it — so `approval` moved to its own test
    // above. `question` stays: Atlas has no interactive-input mechanism, so a prompt on
    // screen would still be one nothing can answer.
    expect(map({ kind: "question", payload: { request_id: "r2" } })).toEqual([]);
  });

  it("maps a heartbeat to a liveness event, not to timeline activity", () => {
    const events = map({ kind: "hb", run_id: "thr-abc", seq: 4, ts: 1785206752998 });
    expect(events.map((e) => e.type)).toEqual(["session.heartbeat"]);
    expect(events[0]).toMatchObject({
      payload: { observedAt: "2026-07-28T02:45:52.998Z", sequence: 4 },
    });
  });

  it("never attaches the active turn to a heartbeat", () => {
    // A heartbeat speaks for the connection, not the work running over it. Carrying a
    // turnId would let a liveness frame advance or close a turn — and Atlas emits these
    // on an idle window, so they keep arriving from a run that has silently died.
    const [event] = map({ kind: "hb", ts: 1785206752998 });
    expect(event).not.toHaveProperty("turnId");
    expect(CTX.activeTurnId).toBeDefined(); // the context DOES have one; it must be ignored
  });

  it("accepts a heartbeat that carries neither timestamp nor cursor", () => {
    // An older node may send a barer frame; liveness is the arrival itself.
    const [event] = map({ kind: "hb" });
    expect(event).toMatchObject({ type: "session.heartbeat", payload: {} });
  });

  it("ignores frames it does not recognise instead of throwing", () => {
    expect(map({ kind: "some_future_frame", payload: {} })).toEqual([]);
    expect(map({})).toEqual([]);
  });

  it("stamps every event with the thread, instance and active turn", () => {
    const [event] = map({ kind: "turn", payload: { state: "start" } });
    expect(event).toMatchObject({
      provider: "atlas",
      threadId: CTX.threadId,
      providerInstanceId: CTX.instanceId,
      turnId: CTX.activeTurnId,
      eventId: STAMP.eventId,
      createdAt: STAMP.createdAt,
    });
  });

  it("omits turnId when no turn is active rather than inventing one", () => {
    const [event] = eventsForFrame(
      { ...CTX, activeTurnId: undefined },
      { kind: "turn", payload: { state: "start" } },
      STAMP,
    );
    expect(event).not.toHaveProperty("turnId");
  });

  it("tags raw payloads as atlas.feed so a frame is traceable to its source", () => {
    const [event] = map({ kind: "assistant", payload: { text: "x" } });
    expect(event).toMatchObject({ raw: { source: "atlas.feed" } });
  });
});

describe("atlasFeedUrl", () => {
  it("switches the scheme to ws and carries run, plugin and token", () => {
    const url = new URL(
      atlasFeedUrl({
        baseUrl: "http://127.0.0.1:3010",
        runId: "thr-abc",
        plugin: "coder",
        token: "s3cret",
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/_feed");
    expect(url.searchParams.get("run_id")).toBe("thr-abc");
    expect(url.searchParams.get("plugin")).toBe("coder");
    expect(url.searchParams.get("access_token")).toBe("s3cret");
  });

  it("upgrades an https node to wss", () => {
    const url = atlasFeedUrl({
      baseUrl: "https://node.example",
      runId: "r",
      plugin: "coder",
      token: "t",
    });
    expect(url.startsWith("wss://")).toBe(true);
  });

  it("omits the token entirely when none is configured", () => {
    // Atlas fails closed, so a tokenless URL must not send an empty credential
    // that reads as an attempt to authenticate.
    const url = atlasFeedUrl({ baseUrl: "http://n:3010", runId: "r", plugin: "coder", token: "" });
    expect(url).not.toContain("access_token");
  });

  it("carries a resume cursor only when both seq and epoch are known", () => {
    const withCursor = atlasFeedUrl({
      baseUrl: "http://n:3010",
      runId: "r",
      plugin: "coder",
      token: "t",
      after: 42,
      epoch: 7,
    });
    expect(withCursor).toContain("after=42");
    expect(withCursor).toContain("epoch=7");

    // A cursor without its epoch is unsafe to honour: `seq` restarts when the feed
    // isolate is recreated, so an epoch-less cursor names a different event.
    const seqOnly = atlasFeedUrl({
      baseUrl: "http://n:3010",
      runId: "r",
      plugin: "coder",
      token: "t",
      after: 42,
    });
    expect(seqOnly).not.toContain("after=");
  });

  it("omits the cursor entirely on a fresh session", () => {
    const url = atlasFeedUrl({ baseUrl: "http://n:3010", runId: "r", plugin: "coder", token: "t" });
    expect(url).not.toContain("after=");
    expect(url).not.toContain("epoch=");
  });

  it("tolerates a trailing slash on the node URL", () => {
    const url = atlasFeedUrl({
      baseUrl: "http://127.0.0.1:3010/",
      runId: "r",
      plugin: "coder",
      token: "t",
    });
    expect(url).toContain("//127.0.0.1:3010/_feed?");
  });
});

describe("socket lifecycle", () => {
  // The bug this guards: with only `onmessage` wired, a socket that failed or
  // dropped emitted nothing — no error, no turn boundary — so a thread sat on
  // "Working" indefinitely. Atlas cannot report it; the transport is what broke.
  const loss = (over: { activeTurnId: TurnId | undefined; closing: boolean }) =>
    socketLossEvents({ ...CTX, ...over }, "the feed died", STAMP);

  it("ends the turn when the feed dies mid-run", () => {
    const events = loss({ activeTurnId: CTX.activeTurnId, closing: false });
    expect(events.map((e) => e.type)).toEqual(["runtime.error", "turn.aborted"]);
    expect(events[0]).toMatchObject({ payload: { class: "transport_error" } });
    // Without turn.aborted the timeline never leaves the running state, which is
    // worse than an error: it reads as work still in progress.
    expect(events[1]).toMatchObject({ turnId: CTX.activeTurnId });
  });

  it("reports an idle disconnect without inventing a turn", () => {
    expect(loss({ activeTurnId: undefined, closing: false }).map((e) => e.type)).toEqual([
      "runtime.error",
    ]);
  });

  it("says nothing when the close was deliberate", () => {
    // stopSession detaching the lens is not a failure — the Atlas run continues.
    expect(loss({ activeTurnId: CTX.activeTurnId, closing: true })).toEqual([]);
  });
});

describe("outboundDisposition", () => {
  it("queues a frame written before the handshake completes", () => {
    // startSession returns as soon as `new WebSocket()` is constructed, so a
    // prompt sendTurn arrives while CONNECTING. Discarding it there produced a
    // turn that never started and never failed.
    expect(outboundDisposition(0)).toBe("queue");
  });

  it("sends straight through once open", () => {
    expect(outboundDisposition(1)).toBe("send");
  });

  it("drops rather than buffering into a socket that will never flush", () => {
    expect(outboundDisposition(2)).toBe("drop"); // CLOSING
    expect(outboundDisposition(3)).toBe("drop"); // CLOSED
  });
});

/**
 * A socket the test drives by hand, parked in CONNECTING until `open()` is called.
 *
 * The adapter only ever touches `readyState`, `send`, and the four handlers, so this
 * stands in for the browser type without pulling in a real server.
 */
class FakeSocket {
  static last: FakeSocket | undefined;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  /** Complete the handshake, as the runtime would. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

const withFakeSocket = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = globalThis.WebSocket;
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
      return original;
    }),
    () => body,
    (original) =>
      Effect.sync(() => {
        (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
      }),
  );

const SETTINGS = Schema.decodeUnknownSync(AtlasSettings)({});
const decodeFrame = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const sentFrame = (socket: FakeSocket | undefined, index: number): unknown =>
  decodeFrame(socket?.sent[index] ?? "{}");

/**
 * The pure-function tests above cover the *decisions*; these cover the *wiring*.
 *
 * That distinction is not academic. `outboundDisposition` correctly returned "queue"
 * while the queue it named was never initialized, so `send` threw
 * `Cannot read properties of undefined (reading 'push')` on the first prompt — with
 * every decision test passing. Nothing here constructed the adapter, so nothing saw it.
 */
describe("session wiring", () => {
  it.effect("queues a turn sent before the handshake, then flushes it on open", () =>
    withFakeSocket(
      Effect.gen(function* () {
        const adapter = yield* makeAtlasAdapter(SETTINGS, {
          instanceId: ProviderInstanceId.make("atlas"),
        });
        const threadId = ThreadId.make("wiring-queue");

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const socket = FakeSocket.last;
        expect(socket?.readyState).toBe(0);

        // The real crash site: startSession returns before the handshake, so this
        // lands while CONNECTING and must be buffered rather than thrown on.
        yield* adapter.sendTurn({ threadId, input: "hello" });
        expect(socket?.sent).toEqual([]);

        socket?.open();
        expect(socket?.sent).toHaveLength(1);
        expect(sentFrame(socket, 0)).toMatchObject({
          kind: "cmd",
          payload: { text: "hello" },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends the thread's workspace with the command", () =>
    withFakeSocket(
      Effect.gen(function* () {
        const adapter = yield* makeAtlasAdapter(SETTINGS, {
          instanceId: ProviderInstanceId.make("atlas"),
        });
        const threadId = ThreadId.make("wiring-cwd");

        // Without this the node runs every thread in one shared shell, so two agents
        // working at once edit the same tree — and per-thread worktrees do nothing.
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          cwd: "/tmp/workspace-a",
        });
        FakeSocket.last?.open();
        yield* adapter.sendTurn({ threadId, input: "go" });

        expect(sentFrame(FakeSocket.last, 0)).toMatchObject({
          kind: "cmd",
          payload: { text: "go", cwd: "/tmp/workspace-a" },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("omits the workspace when the thread has none", () =>
    withFakeSocket(
      Effect.gen(function* () {
        const adapter = yield* makeAtlasAdapter(SETTINGS, {
          instanceId: ProviderInstanceId.make("atlas"),
        });
        const threadId = ThreadId.make("wiring-no-cwd");

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        FakeSocket.last?.open();
        yield* adapter.sendTurn({ threadId, input: "go" });

        // Sending an empty cwd would be a claim about the workspace; saying nothing
        // leaves the node's own default, which is what an older lens did.
        expect(sentFrame(FakeSocket.last, 0)).not.toHaveProperty("payload.cwd");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends straight through once the socket is open", () =>
    withFakeSocket(
      Effect.gen(function* () {
        const adapter = yield* makeAtlasAdapter(SETTINGS, {
          instanceId: ProviderInstanceId.make("atlas"),
        });
        const threadId = ThreadId.make("wiring-open");

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        FakeSocket.last?.open();
        yield* adapter.sendTurn({ threadId, input: "second" });

        // Flushed on open, not queued a second time.
        expect(FakeSocket.last?.sent).toHaveLength(1);
        expect(sentFrame(FakeSocket.last, 0)).toMatchObject({
          payload: { text: "second" },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
