import {
  EventId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { atlasFeedUrl } from "./AtlasClient.ts";
import { eventsForFrame, type FrameContext } from "./AtlasAdapter.ts";

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
    expect(types({ kind: "turn", payload: { state: "error" } })).toEqual(["turn.aborted"]);
  });

  it("carries the Atlas failure reason onto the aborted turn", () => {
    // The whole point of Atlas declaring `state:"error"` is that the reason
    // survives instead of being recovered by substring-matching an error string.
    const [event] = map({ kind: "turn", payload: { state: "error", text: "backend down" } });
    expect(event).toMatchObject({ type: "turn.aborted", payload: { reason: "backend down" } });
  });

  it("falls back to a reason when Atlas reports an error with no text", () => {
    const [event] = map({ kind: "turn", payload: { state: "error" } });
    // TrimmedNonEmptyString would reject "", so a placeholder is required, not cosmetic.
    expect(event).toMatchObject({ payload: { reason: "Atlas run failed" } });
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

  it("omits the tool summary when Atlas reports an empty one", () => {
    // TrimmedNonEmptyString rejects "", so emitting it would produce an invalid event.
    const events = map({ kind: "tool_result", payload: { call_id: "c2", summary: "   " } });
    expect(events.map((e) => e.type)).toEqual(["item.completed"]);
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

  it("emits nothing for approvals and questions until Atlas can resolve them", () => {
    // Showing an approval the user cannot answer is worse than not showing it.
    // This test should be deleted when GAP-006 lands, and its absence is the signal.
    expect(map({ kind: "approval", payload: { request_id: "r1" } })).toEqual([]);
    expect(map({ kind: "question", payload: { request_id: "r2" } })).toEqual([]);
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
