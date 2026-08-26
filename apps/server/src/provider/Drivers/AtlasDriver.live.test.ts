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
import { ThreadId } from "@t3tools/contracts";

import { makeAtlasDriver, probeAtlasHost } from "./AtlasDriver.ts";
import { readCatalog, readEvents, type AtlasEndpoint, type FetchLike } from "./AtlasConsole.ts";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

const BASE_URL = process.env["ATLAS_LIVE_URL"];
const TOKEN = process.env["ATLAS_LIVE_TOKEN"];

const liveFetch: FetchLike = (url, init) =>
  fetch(url as string, init as RequestInit) as unknown as ReturnType<FetchLike>;

const endpoint = (): AtlasEndpoint => ({
  baseUrl: String(BASE_URL),
  accessToken: TOKEN,
  fetch: liveFetch,
});

const instance = (config: Record<string, unknown>) =>
  Effect.runPromise(
    makeAtlasDriver({ fetch: liveFetch }).create({
      instanceId: "atlas-live" as never,
      displayName: "Atlas",
      enabled: true,
      config: { baseUrl: BASE_URL, accessToken: TOKEN, ...config } as never,
    } as never),
  );

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

  it("sends an approval to the authority and surfaces its refusal when no run is waiting", async () => {
    const created = await instance({});
    const threadId = ThreadId.make(`live-approval-${Date.now()}`);
    await Effect.runPromise(
      created.adapter.startSession({ threadId, runtimeMode: "local" } as never),
    );
    // The command reaches the host over the console seam — the path that used to be a typed
    // "unsupported" stub. With no run on the thread, Atlas refuses, and the user sees why.
    const refusal = await Effect.runPromise(
      Effect.flip(created.adapter.respondToRequest(threadId, "req-1" as never, "accept" as never)),
    );
    expect(String((refusal as { detail: string }).detail).length).toBeGreaterThan(0);
    await Effect.runPromise(created.adapter.stopSession(threadId));
  });

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
    expect(session.resumeCursor).toEqual({ epoch: 1, after: 0 });

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
    const resumed = await Effect.runPromise(
      restarted.adapter.startSession({
        threadId,
        runtimeMode: "local",
        resumeCursor: page.cursor,
      } as never),
    );
    expect(resumed.resumeCursor).toEqual({ epoch: 1, after: 3 });
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    expect(seenAfterRestart).toEqual([]);
    await Effect.runPromise(restarted.adapter.stopSession(threadId));
    await Effect.runPromise(Fiber.interrupt(fiber2));
  });

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
