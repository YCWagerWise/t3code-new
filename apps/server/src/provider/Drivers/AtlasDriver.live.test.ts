/**
 * The Atlas driver against a REAL atlas-host, over real HTTP.
 *
 * Skipped unless `ATLAS_LIVE_URL` is set, so it never gates CI on a node being up:
 *
 *   cargo build -p atlas-host --bin atlas-host
 *   ATLAS_FLEET_TOKEN=t ATLAS_DATA_DIR=/tmp/atlas atlas-host serve --addr 127.0.0.1:3019
 *   ATLAS_LIVE_URL=http://127.0.0.1:3019 ATLAS_LIVE_TOKEN=t vp test run AtlasDriver.live
 *
 # Committed turns, without billing one
 *
 * The paid rows on this node are `anthropic/claude-opus-4-8` and `openai/codex`, and the
 * `gpt-oss:*-cloud` rows are Ollama CLOUD. `ollama/nomic-embed-text:latest` is served by a
 * LOCAL ollama (127.0.0.1:11434) and bills nothing, so the committed-start leg is driven with
 * that binding — a real `Start`, a real attempt, real durable lifecycle rows — and no paid
 * turn anywhere. The model is an embedding model, so the attempt stops almost immediately;
 * that is not a problem, because what is under test is the SUPERVISOR's durable record of the
 * turn, not what a model said.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";

import { makeAtlasDriver, probeAtlasHost } from "./AtlasDriver.ts";
import {
  readCatalog,
  readConsoleFrames,
  readEvents,
  readFeed,
  type AtlasEndpoint,
  type FetchLike,
} from "./AtlasConsole.ts";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const BASE_URL = process.env["ATLAS_LIVE_URL"];
const TOKEN = process.env["ATLAS_LIVE_TOKEN"];

const liveFetch: FetchLike = (url, init) =>
  fetch(url as string, init as RequestInit) as unknown as ReturnType<FetchLike>;

const endpoint = (): AtlasEndpoint => ({
  baseUrl: String(BASE_URL),
  accessToken: TOKEN,
  fetch: liveFetch,
});

/** Cursors the driver persists during a live run, so a test can assert what was stored. */
const persisted: Array<Record<string, unknown>> = [];

const instance = (config: Record<string, unknown>) =>
  Effect.runPromise(
    makeAtlasDriver({ fetch: liveFetch })
      .create({
        instanceId: "atlas-live" as never,
        displayName: "Atlas",
        enabled: true,
        config: { baseUrl: BASE_URL, accessToken: TOKEN, ...config } as never,
      } as never)
      .pipe(
        // The driver now REQUIRES the session directory — that requirement is what makes the
        // registry supply it in production instead of the cursor hook dangling unwired.
        Effect.provideService(ProviderSessionDirectory, {
          upsert: (binding: Record<string, unknown>) =>
            Effect.sync(() => {
              persisted.push(binding);
            }),
        } as never),
        Effect.provideService(Scope.Scope, Effect.runSync(Scope.make())),
      ),
  );

/** Wait for a specific event to reach the lens, on real time. */
const waitForEvent = async (
  sink: ReadonlyArray<Record<string, unknown>>,
  match: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const found = sink.find(match);
    if (found !== undefined) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the expected runtime event");
};

describe.skipIf(!BASE_URL)("the Atlas driver against a live node", () => {
  it("reports readiness from what the node actually said, in both directions", async () => {
    const ready = await Effect.runPromise(
      probeAtlasHost({ baseUrl: String(BASE_URL), accessToken: TOKEN, fetch: liveFetch }),
    );
    expect(ready.status).toEqual("ready");

    // The same node, wrong token. Present-but-unauthorised is a DIFFERENT answer from absent:
    // the thing to fix is the token, so it stays installed and is never reported ready.
    const unauthorised = await Effect.runPromise(
      probeAtlasHost({ baseUrl: String(BASE_URL), accessToken: "not-the-token", fetch: liveFetch }),
    );
    expect(unauthorised.installed).toEqual(true);
    expect(unauthorised.status).not.toEqual("ready");
  });

  it("draws the picker from the node's own catalog, with a company on every row", async () => {
    const models = await readCatalog(endpoint());
    // Every slug names a provider AND a model — the property that stops `gpt-5.4` meaning
    // OpenAI on one node and Ollama on another.
    for (const model of models) expect(model.slug).toMatch(/^[^/]+\/.+/);
    const providers = new Set(models.map((model) => model.slug.split("/")[0]));
    // Distinct upstream companies/runtimes, not one collapsed "Atlas model".
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);

    // Atlas itself is not a model vendor. This build says so out loud rather than serving a
    // fake in-process model, so it must not appear as a selectable row.
    expect(providers.has("atlas")).toBe(false);
  });

  it("refuses an unsupported selection before any attempt exists, in the node's own words", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-refusal-${Date.now()}`);
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));

    const refusalFor = async (slug: string) => {
      const error = await Effect.runPromise(
        Effect.flip(
          adapter.sendTurn({
            threadId,
            input: "should never run",
            modelSelection: { model: slug },
          } as never),
        ),
      );
      return String((error as { detail: string }).detail);
    };

    // A model no provider serves. The old code inferred a backend from the string's prefix and
    // sent every unknown id to Ollama; this must refuse instead.
    const unknownModel = await refusalFor("openai/gpt-9-does-not-exist");
    expect(unknownModel.toLowerCase()).toContain("gpt-9-does-not-exist");

    // A provider this node does not serve at all.
    const unknownProvider = await refusalFor("acme-ai/whatever-1");
    expect(unknownProvider.length).toBeGreaterThan(0);

    // Atlas is the orchestrator, not a model company: selecting it is refused, not resolved to
    // whatever this node happens to run.
    const atlasAsModel = await refusalFor("atlas/atlas-1");
    expect(atlasAsModel.length).toBeGreaterThan(0);

    // A slug with no provider is refused rather than guessed at.
    const bareModel = await refusalFor("claude-opus-4-8");
    expect(bareModel).toContain("does not name a provider");

    // Nothing above committed anything: the thread's durable log is still empty, so no attempt
    // was created and no provider was contacted. This is the "before attempt creation" half of
    // the acceptance criterion, measured rather than asserted.
    const page = await readEvents(endpoint(), String(threadId), { epoch: 1, after: 0 });
    expect(page.events).toEqual([]);
    expect(page.cursor).toEqual({ epoch: 1, after: 0 });

    await Effect.runPromise(adapter.stopSession(threadId));
  });

  it("leaves the cursor alone on an empty read, so an idle poll cannot re-deliver a thread", async () => {
    const threadId = `live-cursor-${Date.now()}`;
    const first = await readEvents(endpoint(), threadId, { epoch: 1, after: 0 });
    const second = await readEvents(endpoint(), threadId, first.cursor);
    expect(first.cursor).toEqual({ epoch: 1, after: 0 });
    expect(second.cursor).toEqual(first.cursor);
    expect(second.events).toEqual([]);
  });

  it("delivers a decision to Atlas durably, over a console it attached at session start", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-approval-${Date.now()}`);

    // `startSession` resolves only once the console is ATTACHED. That ordering is the fix for
    // the readiness race: atlas-host denies a gated tool when presence is zero, so a session
    // that reported ready while still dialling could have a fast tool call refused before the
    // user was ever asked.
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));

    const requestId = `${String(threadId)}:call-7`;
    await Effect.runPromise(
      adapter.respondToRequest(threadId, requestId as never, "acceptForSession" as never),
    );
    await Effect.runPromise(
      adapter.respondToUserInput(
        threadId,
        `${String(threadId)}:ask-1` as never,
        {
          branch: "main",
        } as never,
      ),
    );

    // `respondTo*` resolving means Atlas RECORDED it, not merely that bytes left the process.
    // Read the console role back to show the receipt the driver waited on is really there.
    const recorded = await readConsoleFrames(endpoint(), String(threadId));
    const approve = recorded.find((frame) => frame.kind === "approve");
    expect(approve?.payload).toEqual({ request_id: requestId, approved: true });
    const answer = recorded.find((frame) => frame.kind === "answer");
    expect(answer?.payload).toEqual({
      request_id: `${String(threadId)}:ask-1`,
      value: { branch: "main" },
    });

    await Effect.runPromise(adapter.stopSession(threadId));
  }, 60_000);

  /** Poll a condition against a live node, on real time rather than event-loop ticks. */
  const waitForLive = async (condition: () => boolean, what: string): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it("runs a real turn end to end: start commits, the feed streams it, the cursor advances", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-turn-${Date.now()}`);
    const seen: Array<string> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) => Effect.sync(() => seen.push(event.type))),
    );

    const session = await Effect.runPromise(
      adapter.startSession({ threadId, runtimeMode: "local" } as never),
    );
    // The lifecycle half starts at the top of epoch 1; the feed half is carried alongside it.
    expect(session.resumeCursor).toMatchObject({ epoch: 1, after: 0 });

    // A real Start, on a local model that bills nothing.
    const turn = await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "say ok",
        modelSelection: { model: "ollama/nomic-embed-text:latest" },
      } as never),
    );
    expect(String(turn.turnId).length).toBeGreaterThan(0);

    // The reader — not a one-shot poll — delivers what the supervisor recorded after the send.
    await waitForLive(() => seen.includes("turn.completed"), "the live feed to report the turn");
    expect(seen[0]).toEqual("turn.started");

    // The durable log is Atlas's, and the cursor has moved past what was consumed.
    const page = await readEvents(endpoint(), String(threadId), { epoch: 1, after: 0 });
    expect(page.events.map((event) => event.kind)).toEqual([
      "command.accepted",
      "provider.connected",
      "provider.stopped",
    ]);
    expect(page.cursor.after).toEqual(3);

    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber));

    // A second process, hydrated from the persisted cursor, must NOT re-render the thread.
    const restarted = await instance({});
    const seenAfterRestart: Array<string> = [];
    const fiber2 = Effect.runFork(
      Stream.runForEach(restarted.adapter.streamEvents, (event) =>
        Effect.sync(() => seenAfterRestart.push(event.type)),
      ),
    );
    // Both halves, as ProviderService persists them — a cursor carrying only the lifecycle
    // position would leave the frame log to replay from its top, which is precisely what
    // happened the first time this test was written and is worth pinning.
    const framePage = await readFeed(endpoint(), String(threadId), { epoch: 0, after: 0 });
    const resumed = await Effect.runPromise(
      restarted.adapter.startSession({
        threadId,
        runtimeMode: "local",
        resumeCursor: { ...page.cursor, feed: framePage.cursor },
      } as never),
    );
    expect(resumed.resumeCursor).toMatchObject({ epoch: 1, after: 3 });
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(seenAfterRestart).toEqual([]);
    await Effect.runPromise(restarted.adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber2));
  });

  /**
   * The whole approval path, continuously, against a live node.
   *
   * Everything here is real except the decision to call a tool: the feed, the `await_approval`
   * gate, the WebSocket, the `ToolGate` outcome. Only the tool call itself is scripted, via the
   * node's `/_test/gate` fixture — because whether a model emits a tool call is its own
   * stochastic choice and has nothing to do with the transport under test. A local 7B asked
   * twice to call a tool answered in prose instead, and the models that would comply are
   * exactly the paid ones this work may not spend.
   */
  it("runs the whole approval path: gate opens, T3 is asked, answers, and the gate releases", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-gate-${Date.now()}`);
    const seen: Array<Record<string, unknown>> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => seen.push(event as unknown as Record<string, unknown>)),
      ),
    );

    // 1. Readiness means ATTACHED. Without a console present the node denies the call outright
    //    — verified against this same fixture: "and no console is attached to approve it".
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));

    // 2. A real gate opens on the node and BLOCKS. Not awaited yet: it does not return until a
    //    decision arrives, which is the point.
    const gate = fetch(`${BASE_URL}/_test/gate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: String(threadId),
        call_id: "call-7",
        tool: "mcp__triage__nodes",
      }),
    });

    // 3. T3 is asked — the request reaches the lens through the feed it is already reading.
    const opened = await waitForEvent(seen, (event) => event["type"] === "request.opened");
    const requestId = String(opened["requestId"]);
    // Atlas's own `{run_id}:{call_id}`, carried intact rather than re-minted by the lens.
    expect(requestId).toEqual(`${String(threadId)}:call-7`);

    // 4/5. The decision goes back over the console socket, and `respondToRequest` resolves only
    //      once Atlas has durably recorded it.
    await Effect.runPromise(
      adapter.respondToRequest(threadId, requestId as never, "accept" as never),
    );
    const recorded = await readConsoleFrames(endpoint(), String(threadId));
    expect(
      recorded.some(
        (frame) => frame.kind === "approve" && frame.payload["request_id"] === requestId,
      ),
    ).toBe(true);

    // 6. The REAL gate releases on the strength of that frame.
    const outcome = (await (await gate).json()) as { outcome: string; detail: unknown };
    expect(outcome.outcome).toEqual("allow");

    // 7. The resulting tool lifecycle reaches the lens and correlates: one item id, start to end.
    const completed = await waitForEvent(seen, (event) => event["type"] === "item.completed");
    const started = seen.find((event) => event["type"] === "item.started");
    expect(started?.["itemId"]).toBeDefined();
    expect(completed["itemId"]).toEqual(started?.["itemId"]);

    // And every event the lens emitted survives T3's own decoder.
    const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
    for (const event of seen) expect(() => decode(event)).not.toThrow();

    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber));
  }, 120_000);

  it("refuses the call when the lens declines, rather than letting it run", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-deny-${Date.now()}`);
    const seen: Array<Record<string, unknown>> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => seen.push(event as unknown as Record<string, unknown>)),
      ),
    );
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));
    const gate = fetch(`${BASE_URL}/_test/gate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: String(threadId), call_id: "call-9" }),
    });
    const opened = await waitForEvent(seen, (event) => event["type"] === "request.opened");
    await Effect.runPromise(
      adapter.respondToRequest(threadId, String(opened["requestId"]) as never, "decline" as never),
    );
    const outcome = (await (await gate).json()) as { outcome: string };
    // A decline must stop the tool, not merely fail to start it by timing out.
    expect(outcome.outcome).toEqual("deny");
    // And no result frame was produced, so nothing ran.
    expect(seen.some((event) => event["type"] === "item.completed")).toBe(false);
    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber));
  }, 120_000);

  it("renders what a real model actually said, not just that a turn ended", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-content-${Date.now()}`);
    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() =>
          seen.push({
            type: event.type,
            payload: (event as unknown as { payload: Record<string, unknown> }).payload,
          }),
        ),
      ),
    );
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "Reply with exactly the word: pong",
        // Local, tools-capable, and unbilled.
        modelSelection: { model: "ollama/qwen2.5-coder:7b" },
      } as never),
    );

    // Wait for the ANSWER, not merely for the turn to close — the whole point of the finding.
    for (let attempt = 0; attempt < 900; attempt += 1) {
      if (seen.some((event) => event.type === "content.delta")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber));

    // What the model chose to say is its business — a local 7B may answer, or may recite the
    // tool list it was handed. What is under test is that its words REACH the lens at all,
    // which before this change they never did: the turn closed with nothing in between.
    const answer = seen.find((event) => event.type === "content.delta");
    expect(answer).toBeDefined();
    expect(answer?.payload["streamKind"]).toEqual("assistant_text");
    expect(String(answer?.payload["delta"]).length).toBeGreaterThan(0);
    // And the boundary still arrives, from the supervisor rather than from a frame.
    expect(seen.some((event) => event.type === "turn.completed")).toBe(true);
  }, 120_000);

  /**
   * Cancellation, against an attempt that CANNOT finish on its own.
   *
   * The previous version of this test raced a model: it started an ollama turn, waited for
   * `turn.started` and cancelled. Whether work remained when the cancel landed depended on how
   * fast the model happened to be, so it passed on a slow one and failed on a fast one — and a
   * lost race read as a green tick, which is worse than having no test.
   *
   * `/_test/hold` commits a real run through the supervisor's own seams AND registers a real
   * cancellable future behind it, in the same switch table a live drive uses. So an accepted
   * cancel reaches this attempt exactly as it reaches a turn and resolves it as
   * `Driven::Cancelled`; the fixture then reports `provider.stopped`, which is what terminalizes
   * it. The body pends forever, so `completed` is unreachable by construction.
   *
   * That distinction is the point of the finding. An attempt with NOTHING behind it would also
   * end up cancelled — but only after CANCEL_TIMEOUT_MS swept it, which proves the supervisor's
   * bookkeeping rather than that cancellation stopped active work. The window below is 15s
   * against a 30s deadline precisely so a sweep cannot pass this test.
   */
  it("cancels an attempt that cannot finish on its own, and the lens sees it end", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-held-cancel-${Date.now()}`);
    const seen: Array<Record<string, unknown>> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => seen.push(event as unknown as Record<string, unknown>)),
      ),
    );
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));

    const held = (await (
      await fetch(`${BASE_URL}/_test/hold`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: String(threadId) }),
      })
    ).json()) as { run_id: string; attempt_id: string; state: string };

    // The attempt is in flight before the cancel is issued — stated by the authority, not
    // inferred from timing.
    expect(held.state).toEqual("running");
    expect(held.attempt_id.length).toBeGreaterThan(0);

    // The lens is watching that same run.
    await waitForEvent(seen, (event) => event["type"] === "turn.started");

    await Effect.runPromise(adapter.interruptTurn(threadId));

    const readRun = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(`${BASE_URL}/console/v1/threads/${String(threadId)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      return ((await response.json()) as { run?: Record<string, unknown> }).run ?? {};
    };

    // Deliberately far under CANCEL_TIMEOUT_MS (30s). If the cancel had merely been accepted
    // and left to the supervisor's deadline to sweep, this window would expire and the test
    // would fail — which is the difference between proving actuation and proving bookkeeping.
    // Measured against this fixture, actuation lands in ~90ms even when the cancel is issued
    // with no delay at all, so 5s is generous without being able to hide a sweep.
    const deadline = Date.now() + 5_000;
    let run: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      run = await readRun();
      if (String(run["state"]) === "cancelled") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    // Strict: the intended attempt stopped, and it stopped BECAUSE the cancel reached the work.
    expect(String(run["state"])).toEqual("cancelled");
    expect(String((run["attempt"] as Record<string, unknown>)?.["attempt_id"])).toEqual(
      held.attempt_id,
    );
    // The PROVIDER reported the cancellation. `cancel_timeout` here would mean the signal never
    // arrived and the deadline cleaned up after it.
    const terminal = run["terminal"] as Record<string, unknown> | undefined;
    expect(String(terminal?.["reason"])).toEqual("cancelled_by_fixture");
    expect(String(terminal?.["state"])).toEqual("cancelled");

    // And the lens is told the turn ended — the projection gap that made a cancelled turn spin
    // in the composer forever.
    const completed = await waitForEvent(seen, (event) => event["type"] === "turn.completed");
    const payload = completed["payload"] as Record<string, unknown>;
    expect(["cancelled", "interrupted"]).toContain(String(payload["state"]));

    await Effect.runPromise(adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber));
  }, 180_000);

  it("cancels a real turn through the authority, and a repeated cancel commits once", async () => {
    const created = await instance({});
    const adapter = created.adapter;
    const threadId = ThreadId.make(`live-cancel-real-${Date.now()}`);
    await Effect.runPromise(adapter.startSession({ threadId, runtimeMode: "local" } as never));
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "say ok",
        modelSelection: { model: "ollama/nomic-embed-text:latest" },
      } as never),
    );

    // The driver's own cancel, twice — as a lost response would produce.
    await Effect.runPromise(adapter.interruptTurn(threadId));
    await Effect.runPromise(adapter.interruptTurn(threadId));

    const page = await readEvents(endpoint(), String(threadId), { epoch: 1, after: 0 });
    const cancels = page.events.filter(
      (event) =>
        event.kind === "command.accepted" &&
        (event.payload["command"] as Record<string, unknown> | undefined)?.["kind"] === "cancel",
    );
    // Atlas dedupes the second on its receipt table, so the repeat did not commit a second
    // cancel — the identity is stable rather than clock-derived.
    expect(cancels).toHaveLength(1);
    await Effect.runPromise(adapter.stopSession(threadId));
  });

  it("reports the authority's refusal when there is nothing to cancel", async () => {
    const created = await instance({});
    const threadId = ThreadId.make(`live-cancel-${Date.now()}`);
    await Effect.runPromise(
      created.adapter.startSession({ threadId, runtimeMode: "local" } as never),
    );
    // No live attempt to stop: Atlas refuses, and the driver reports the node's reason instead
    // of pretending the cancel worked.
    const refusal = await Effect.runPromise(Effect.flip(created.adapter.interruptTurn(threadId)));
    expect(String((refusal as { detail: string }).detail).length).toBeGreaterThan(0);
    await Effect.runPromise(created.adapter.stopSession(threadId));
  });
});
