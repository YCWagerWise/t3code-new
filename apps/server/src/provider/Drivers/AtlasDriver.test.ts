import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  ATLAS_DRIVER_KIND,
  type AtlasSocketFactory,
  atlasStartCommand,
  bindingFromSlug,
  bindingSlug,
  type FetchLike,
} from "./AtlasConsole.ts";
import { classifyHandshake, makeAtlasAdapter, probeAtlasHost } from "./AtlasDriver.ts";

/**
 * The Atlas provider exists because the ACP runtime the other two drivers spawn cannot be
 * built here at all (`cargo build --bin t3code-agent` fails at manifest resolution on missing
 * `agent-sdk-*` crates). So the thing worth pinning is that this driver never *claims* more
 * than the host actually gave it — #240 was a provider that hardcoded `installed: true,
 * status: "ready"`, and the user found out only after sending a turn.
 *
 * `probeAtlasHost` is the seam that decides `installed`/`status`/`auth`, so these drive it
 * directly rather than standing up the whole driver graph — the same shape as
 * `AgentSdkDriver.test.ts`.
 */
const respondWith = (status: number, body: string): FetchLike => {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
};

const HANDSHAKE = JSON.stringify({
  protocol_version: 1,
  fleet_id: "default",
  authenticated_subject: "atlas-machine",
  granted_scopes: [],
  capabilities: [],
  connection_id: "atlas-http-1",
  server_time_ms: 0,
  heartbeat_interval_ms: 15000,
  replay_boundaries: [],
});

describe("probeAtlasHost", () => {
  it.effect("reports ready only when the node answers with a real handshake", () =>
    Effect.gen(function* () {
      const probe = yield* probeAtlasHost({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "dev",
        fetch: respondWith(200, HANDSHAKE),
      });

      expect(probe.status).toBe("ready");
      expect(probe.installed).toBe(true);
      expect(probe.auth.status).toBe("authenticated");
      expect(probe.auth.label).toBe("atlas-machine");
      expect(probe.version).toBe("protocol 1");
    }),
  );

  it.effect("a 401 is present-but-unauthenticated, never ready", () =>
    Effect.gen(function* () {
      const probe = yield* probeAtlasHost({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "wrong",
        fetch: respondWith(401, "unauthenticated"),
      });

      // The node IS there — what needs fixing is the token, not the install — so `installed`
      // stays true and the reason has to reach the user.
      expect(probe.installed).toBe(true);
      expect(probe.status).toBe("error");
      expect(probe.auth.status).toBe("unauthenticated");
      expect(probe.message).toContain("accessToken");
    }),
  );

  it.effect("an unreachable node is not installed", () =>
    Effect.gen(function* () {
      const probe = yield* probeAtlasHost({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "dev",
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      });

      expect(probe.installed).toBe(false);
      expect(probe.status).toBe("error");
      expect(probe.message).toContain("unreachable");
    }),
  );

  it.effect("a 200 that is not a handshake is refused rather than trusted", () =>
    Effect.gen(function* () {
      // Something else is listening on that port. Reporting ready would send the user's next
      // turn to a service that cannot run it.
      const probe = yield* probeAtlasHost({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "dev",
        fetch: respondWith(200, "<html>hello</html>"),
      });

      expect(probe.status).toBe("error");
      expect(probe.message).toContain("not with an Atlas handshake");
    }),
  );

  it.effect("the probe never invents a ready state from a server error", () =>
    Effect.gen(function* () {
      const probe = yield* probeAtlasHost({
        baseUrl: "http://127.0.0.1:3010",
        accessToken: "dev",
        fetch: respondWith(500, "boom"),
      });

      expect(probe.status).toBe("error");
      expect(probe.auth.status).toBe("unknown");
      expect(probe.message).toContain("500");
    }),
  );
});

/**
 * The bytes a REAL atlas-host actually returned, captured from the node running on
 * 127.0.0.1:3010 on 2026-08-25 (only `connection_id`/`server_time_ms` are per-request). A
 * hand-written fixture proves the classifier is self-consistent; this proves it agrees with
 * the thing it will be pointed at.
 */
const LIVE_HANDSHAKE = {
  authenticated_subject: "atlas-machine",
  capabilities: [
    "run.commands",
    "run.events",
    "run.checkpoints",
    "run.children",
    "run.epoch_sequence",
  ],
  connection_id: "atlas-http-1787688330934",
  fleet_id: "default",
  granted_scopes: ["read", "execute", "supervise"],
  heartbeat_interval_ms: 15000,
  protocol_version: 1,
  replay_boundaries: [],
  server_time_ms: 1787688330934,
};

describe("classifyHandshake against a real node", () => {
  it("reads a live atlas-host handshake as ready", () => {
    const probe = classifyHandshake({
      baseUrl: "http://127.0.0.1:3010",
      status: 200,
      body: JSON.stringify(LIVE_HANDSHAKE),
    });

    expect(probe.status).toBe("ready");
    expect(probe.installed).toBe(true);
    expect(probe.auth).toEqual({ status: "authenticated", label: "atlas-machine" });
    expect(probe.version).toBe("protocol 1");
  });

  it("reads the same node's unauthenticated answer as not ready", () => {
    // The live node returns a bare 401 with no body when the bearer is missing.
    const probe = classifyHandshake({
      baseUrl: "http://127.0.0.1:3010",
      status: 401,
      body: "",
    });

    expect(probe.status).toBe("error");
    expect(probe.auth.status).toBe("unauthenticated");
  });
});

describe("atlasStartCommand", () => {
  const base = {
    fleetId: "default",
    threadId: "thr-1",
    runId: "run-1",
    requestId: "req-1",
    actor: "t3",
    text: "do the thing",
  };

  it("puts the provider AND the model on the wire, as two facts", () => {
    const command = atlasStartCommand({
      ...base,
      binding: { provider: "openai", model_id: "gpt-5.4" },
      workspaceId: "ws-alpha",
    });

    expect(command["protocol_version"]).toBe(1);
    expect(command["thread_id"]).toBe("thr-1");
    const inner = command["command"] as Record<string, unknown>;
    expect(inner["kind"]).toBe("start");
    const binding = inner["binding"] as Record<string, unknown>;
    // The company travels with the model. A bare "gpt-5.4" cannot say who serves it, and the
    // host no longer guesses.
    expect(binding["provider"]).toBe("openai");
    expect(binding["model_id"]).toBe("gpt-5.4");
    expect(inner["workspace_id"]).toBe("ws-alpha");
  });

  it("omits the binding entirely rather than sending an empty one", () => {
    // Atlas treats an ABSENT binding as the node default and REFUSES a malformed one, so an
    // empty object would turn "no preference" into a 400.
    const command = atlasStartCommand({ ...base, binding: undefined, workspaceId: undefined });
    const inner = command["command"] as Record<string, unknown>;

    expect("binding" in inner).toBe(false);
    expect("workspace_id" in inner).toBe(false);
  });
});

describe("the picker slug", () => {
  it("round-trips a provider and a model through one string", () => {
    const binding = { provider: "anthropic", model_id: "claude-opus-4-8" };
    expect(bindingSlug(binding)).toBe("anthropic/claude-opus-4-8");
    expect(bindingFromSlug("anthropic/claude-opus-4-8")).toEqual(binding);

    // An ollama id contains punctuation of its own; splitting greedily would corrupt it.
    expect(bindingFromSlug("ollama/qwen2.5-coder:7b")).toEqual({
      provider: "ollama",
      model_id: "qwen2.5-coder:7b",
    });
  });

  it("refuses a slug with no provider instead of guessing one", () => {
    // This is the lens-side half of the deleted unknown->Ollama inference. A model id alone is
    // exactly the ambiguous input the whole design removes.
    for (const bad of ["gpt-5.4", "", "/gpt-5.4", "openai/", " openai/gpt-5.4"]) {
      expect(bindingFromSlug(bad)).toBeNull();
    }
  });
});

describe("provider registration", () => {
  it("ships Atlas as a built-in driver", () => {
    // The composer's "no provider available" was honest: the only registered drivers spawn a
    // binary this checkout cannot build. This is the line that changes that.
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);

    expect(kinds).toContain(ATLAS_DRIVER_KIND);
  });

  it("needs no infrastructure services, because it spawns nothing", () => {
    const atlas = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === ATLAS_DRIVER_KIND);

    expect(atlas).toBeDefined();
    expect(atlas?.metadata.displayName).toBe("Atlas");
    // A default config must be usable with no settings at all, or the driver cannot be
    // bootstrapped before a user has configured it.
    expect(() => atlas?.defaultConfig()).not.toThrow();
  });
});

// ───────────────────── the adapter, driven against a node ─────────────────────

/**
 * A stand-in atlas-host that behaves like the real one on the things that matter here: it
 * dedupes commands on `request_id` against a receipt table, serves `/events` as pages keyed by
 * a cursor, and only reveals an event once it has actually been appended.
 *
 * The point of testing against this rather than a canned fetch is that the reviewer's finding
 * was about BEHAVIOUR OVER TIME — events that arrive after the send, a cursor that survives a
 * restart, a retry that must not open a second run. A one-shot `respondWith` cannot express any
 * of those, which is why the earlier round shipped a driver whose feed was dead.
 *
 * The command semantics this fake asserts are pinned against the real supervisor separately, by
 * `a_lens_resolves_a_waiting_run_with_the_json_it_actually_sends` in
 * `atlas-host/src/run_supervisor.rs` — so this is not a fake agreeing with its own author.
 */
const makeFakeAtlas = () => {
  const commands: Array<Record<string, unknown>> = [];
  const receipts = new Map<string, unknown>();
  const log: Array<Record<string, unknown>> = [];
  const frames: Array<Record<string, unknown>> = [];
  const FEED_EPOCH = 1_700_000_000_000;
  let failReads = 0;
  let reads = 0;
  let consumedUpTo = 0;

  const append = (kind: string, payload: Record<string, unknown>): void => {
    log.push({
      epoch: 1,
      seq: log.length + 1,
      event_id: `ev-${log.length + 1}`,
      run_id: "run-1",
      attempt_id: "att-1",
      kind,
      payload_json: JSON.stringify(payload),
    });
  };

  const fetch: FetchLike = (url, init) => {
    const href = String(url);
    if (href.includes("/feed")) {
      const after = Number(new URL(href).searchParams.get("after") ?? 0);
      const visible = frames.filter((frame) => Number(frame["seq"]) > after);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ epoch: FEED_EPOCH, frames: visible })),
      });
    }
    if (href.includes("/events")) {
      reads += 1;
      if (failReads > 0) {
        failReads -= 1;
        return Promise.resolve({ status: 503, text: () => Promise.resolve("node unavailable") });
      }
      const after = Number(new URL(href).searchParams.get("after") ?? 0);
      // The reader asking from `after` is proof it has consumed everything up to it — which is
      // how a test waits for the reader to catch up without reaching into its internals.
      consumedUpTo = Math.max(consumedUpTo, after);
      const events = log.filter((entry) => Number(entry["seq"]) > after);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ events })),
      });
    }
    const body = JSON.parse(
      String((init as { body?: string } | undefined)?.body ?? "{}"),
    ) as Record<string, unknown>;
    const requestId = String(body["request_id"]);
    // The real host's dedupe: a repeated request_id returns the ORIGINAL receipt and commits
    // nothing new (`load_receipt` in atlas-host/src/run_supervisor.rs).
    if (receipts.has(requestId)) {
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(receipts.get(requestId))),
      });
    }
    commands.push(body);
    const receipt = { accepted: true, duplicate: false, run: { run_id: "run-1" } };
    receipts.set(requestId, { ...receipt, duplicate: true });
    return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(receipt)) });
  };

  /** Publish an agent frame — what the turn SAID, on the other log. */
  const say = (kind: string, payload: Record<string, unknown>): void => {
    frames.push({ epoch: FEED_EPOCH, seq: frames.length + 1, kind, role: "agent", payload });
  };

  return {
    fetch,
    commands,
    append,
    say,
    reads: () => reads,
    consumedUpTo: () => consumedUpTo,
    failNextReads: (count: number) => {
      failReads = count;
    },
    resolveCommand: () =>
      commands.find((c) => (c["command"] as Record<string, unknown>)?.["kind"] === "resolve_input"),
    starts: () =>
      commands.filter((c) => (c["command"] as Record<string, unknown>)?.["kind"] === "start"),
  };
};

const stopObservation = () => ({
  observation: { type: "provider_stopped", stop: { outcome: "completed" } },
});

/** A sleep the reader can be driven by without waiting on wall time. */
const instantSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Wait for a CONDITION, never for a fixed number of ticks.
 *
 * Counting event-loop turns passes on an idle machine and fails on a busy one — this test file
 * had exactly that flake when the whole server suite ran in parallel. Polling the condition is
 * deterministic under any load; the cap only exists so a genuine hang fails loudly instead of
 * hanging the suite.
 */
const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    if (condition()) return;
    await instantSleep();
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Let pending work run when the assertion is that NOTHING happened. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 25; index += 1) await instantSleep();
};

const adapterFor = (node: ReturnType<typeof makeFakeAtlas>) =>
  makeAtlasAdapter({
    endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: undefined, fetch: node.fetch },
    fleetId: "default",
    instanceId: "atlas-1",
    sleep: instantSleep,
    idlePollMs: 0,
  });

const startSession = (adapter: ReturnType<typeof adapterFor>, resumeCursor?: unknown) =>
  Effect.runPromise(
    adapter.startSession({
      threadId: ThreadId.make("thr-1"),
      runtimeMode: "local",
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
    } as never),
  );

const collect = (adapter: ReturnType<typeof adapterFor>, sink: Array<string>) =>
  Effect.runFork(
    Stream.runForEach(adapter.streamEvents, (event) => Effect.sync(() => sink.push(event.type))),
  );

const teardown = async (
  adapter: ReturnType<typeof adapterFor>,
  fiber: Fiber.Fiber<unknown, unknown>,
) => {
  await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
  await Effect.runPromise(Fiber.interrupt(fiber));
};

describe("the Atlas feed, once a session is open", () => {
  it("delivers events that arrive long after the send, not just the ones already there", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    await Effect.runPromise(
      adapter.sendTurn({ threadId: ThreadId.make("thr-1"), input: "hello" } as never),
    );
    await settle();
    // The node has said nothing yet, so neither has the stream.
    expect(seen).toEqual([]);

    // Now it speaks — well after `sendTurn` returned. A fire-and-forget read taken at send time
    // cannot see either of these; a live reader must.
    node.append("command.accepted", { command: { kind: "start" } });
    node.append("provider.stopped", stopObservation());
    await waitFor(() => seen.length === 2, "the late events to be delivered");
    await teardown(adapter, fiber);

    expect(seen).toEqual(["turn.started", "turn.completed"]);
  });

  it("keeps reading after a failed read instead of dying with it", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    node.failNextReads(3);
    node.append("command.accepted", { command: { kind: "start" } });
    // The reads failed, the reader backed off, and the event still lands — the cursor was never
    // advanced past something that was not delivered.
    await waitFor(() => seen.length === 1, "the event to survive three failed reads");
    await teardown(adapter, fiber);

    expect(node.reads()).toBeGreaterThan(3);
    expect(seen).toEqual(["turn.started"]);
  });
});

describe("what the turn said", () => {
  it("delivers the answer, not just the fact that a turn ended", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<{ type: string; payload: unknown }> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() =>
          seen.push({ type: event.type, payload: (event as { payload: unknown }).payload }),
        ),
      ),
    );
    await startSession(adapter);
    await Effect.runPromise(
      adapter.sendTurn({ threadId: ThreadId.make("thr-1"), input: "ping" } as never),
    );
    // The boundary log and the frame log both speak, as a real node's do.
    node.append("command.accepted", { command: { kind: "start" } });
    node.say("assistant", { text: "pong" });
    node.append("provider.stopped", stopObservation());
    await waitFor(() => seen.some((event) => event.type === "content.delta"), "the answer");
    await teardown(adapter, fiber);

    // The regression this closes: a turn that starts and completes with nothing in between.
    const answer = seen.find((event) => event.type === "content.delta");
    expect(answer?.payload).toEqual({ streamKind: "assistant_text", delta: "pong" });
    expect(seen.map((event) => event.type)).toContain("turn.completed");
  });

  it("opens a request a user can act on when a tool call is held", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<Record<string, unknown>> = [];
    const fiber = Effect.runFork(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => seen.push(event as unknown as Record<string, unknown>)),
      ),
    );
    await startSession(adapter);
    node.say("approval", {
      request_id: "run-1:call-7",
      request_type: "command_execution_approval",
      reason: "wants to run rm",
      args: { cmd: "rm -rf /" },
    });
    await waitFor(() => seen.some((event) => event["type"] === "request.opened"), "the request");
    await teardown(adapter, fiber);

    const opened = seen.find((event) => event["type"] === "request.opened");
    // Atlas's `{run_id}:{call_id}` travels intact — it is the only string an approval may quote
    // back, and `await_approval` matches it exactly.
    expect(opened?.["requestId"]).toEqual("run-1:call-7");
  });

  it("stays silent on frames it does not understand rather than guessing a turn state", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    node.say("usage", { tokens: 12 });
    node.say("ctx", { used: 1, window: 2 });
    // The console's own commands must never echo back as content.
    node.say("turn", { state: "done" });
    await settle();
    await teardown(adapter, fiber);
    // A `turn` frame projected here would make the lens a second boundary author.
    expect(seen).toEqual([]);
  });
});

describe("the cursor across a restart", () => {
  it("resumes from the persisted cursor instead of replaying the thread from zero", async () => {
    const node = makeFakeAtlas();
    const adapterA = adapterFor(node);
    const seenA: Array<string> = [];
    const fiberA = collect(adapterA, seenA);
    await startSession(adapterA);
    node.append("command.accepted", { command: { kind: "start" } });
    await waitFor(() => seenA.length === 1, "the first event to be consumed");
    const turn = await Effect.runPromise(
      adapterA.sendTurn({ threadId: ThreadId.make("thr-1"), input: "hi" } as never),
    );
    await teardown(adapterA, fiberA);

    // This is the value ProviderService persists onto the session binding
    // (`directory.upsert({ resumeCursor })` in ProviderService.ts).
    // The feed half carries the stream's real epoch once the reader has seen it, so a restart
    // resumes that log too instead of re-reading it from the top.
    expect(turn.resumeCursor).toEqual({
      epoch: 1,
      after: 1,
      feed: { epoch: 1_700_000_000_000, after: 0 },
    });

    // A new process, same durable log, hydrated from what was persisted.
    const adapterB = adapterFor(node);
    const seenB: Array<string> = [];
    const fiberB = collect(adapterB, seenB);
    const session = await startSession(adapterB, turn.resumeCursor);
    expect(session.resumeCursor).toEqual({
      epoch: 1,
      after: 1,
      feed: { epoch: 1_700_000_000_000, after: 0 },
    });
    await settle();
    // The already-consumed event is NOT re-delivered...
    expect(seenB).toEqual([]);
    // ...but anything after it still is.
    node.append("provider.stopped", stopObservation());
    await waitFor(() => seenB.length === 1, "the post-restart event");
    await teardown(adapterB, fiberB);
    expect(seenB).toEqual(["turn.completed"]);
  });

  it("replays rather than skips when the persisted cursor is unreadable", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const session = await startSession(adapter, { nonsense: true });
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    // Replaying costs a re-render; guessing a position would silently drop events.
    expect(session.resumeCursor).toEqual({ epoch: 1, after: 0, feed: { epoch: 0, after: 0 } });
  });
});

describe("turn identity", () => {
  it("commits one run when the same logical send is retried after a lost response", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    await startSession(adapter);
    const send = () =>
      Effect.runPromise(
        adapter.sendTurn({ threadId: ThreadId.make("thr-1"), input: "same turn" } as never),
      );
    const first = await send();
    // The caller never saw the receipt and sends the identical turn again.
    const second = await send();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));

    expect(node.starts()).toHaveLength(1);
    expect(first.turnId).toEqual(second.turnId);
    // No wall-clock millisecond anywhere in the identity.
    expect(node.commands[0]?.["request_id"]).not.toMatch(/\d{13}/);
  });

  it("gives a genuinely new turn its own identity", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    await Effect.runPromise(
      adapter.sendTurn({ threadId: ThreadId.make("thr-1"), input: "first" } as never),
    );
    node.append("command.accepted", { command: { kind: "start" } });
    node.append("provider.stopped", stopObservation());
    await waitFor(() => seen.length === 2, "the first turn to settle");
    await Effect.runPromise(
      adapter.sendTurn({ threadId: ThreadId.make("thr-1"), input: "second" } as never),
    );
    await teardown(adapter, fiber);

    expect(node.starts()).toHaveLength(2);
    expect(node.commands[0]?.["request_id"]).not.toEqual(node.commands[1]?.["request_id"]);
  });
});

/** A console socket a test can open, drop and inspect, with no server involved. */
const makeFakeSocket = () => {
  const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const urls: Array<string> = [];
  let live: { onOpen: () => void; onClose: () => void } | undefined;
  let openNow = true;

  const connect: AtlasSocketFactory = (url, handlers) => {
    urls.push(url);
    live = handlers;
    if (openNow) queueMicrotask(handlers.onOpen);
    return {
      send: (data: string) => {
        const frame = JSON.parse(data) as { kind: string; payload: Record<string, unknown> };
        sent.push(frame);
      },
      close: () => {},
    };
  };

  return {
    connect,
    sent,
    urls,
    /** Simulate the socket dropping, so queued decisions can be observed. */
    drop: () => {
      openNow = false;
      live?.onClose();
    },
    restore: () => {
      openNow = true;
      live?.onOpen();
    },
  };
};

const socketAdapterFor = (
  node: ReturnType<typeof makeFakeAtlas>,
  socket: ReturnType<typeof makeFakeSocket>,
) =>
  makeAtlasAdapter({
    endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: "tok", fetch: node.fetch },
    fleetId: "default",
    instanceId: "atlas-1",
    sleep: instantSleep,
    idlePollMs: 0,
    connect: socket.connect,
  });

describe("approvals", () => {
  it("attaches a console the moment the session opens, because an unattached one auto-denies", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket();
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();

    // atlas-host's `await_approval` refuses a gated tool outright when nobody is listening:
    // "and no console is attached to approve it". Connecting only once a decision existed
    // would arrive after that denial, so presence is part of opening a session.
    expect(socket.urls).toHaveLength(1);
    expect(socket.urls[0]).toContain("/_feed?run_id=thr-1");
    // No replay: the frames are already read over HTTP, and replaying here would double them.
    expect(socket.urls[0]).toContain("after=-1");
    expect(socket.urls[0]).toContain("access_token=tok");
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
  });

  it("answers the id Atlas stated on the approval frame, and carries the decision", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket();
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    await Effect.runPromise(
      adapter.respondToRequest(
        ThreadId.make("thr-1"),
        "run-1:call-7" as never,
        "acceptForSession" as never,
      ),
    );
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.kind).toEqual("approve");
    // `{run_id}:{call_id}` intact — `await_approval` matches it exactly and a stale answer for
    // another held call must not release this one.
    expect(socket.sent[0]?.payload).toEqual({ request_id: "run-1:call-7", approved: true });
  });

  it("declines as a decision, not as silence", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket();
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    await Effect.runPromise(
      adapter.respondToRequest(ThreadId.make("thr-1"), "run-1:call-9" as never, "decline" as never),
    );
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    expect(socket.sent[0]?.payload).toEqual({ request_id: "run-1:call-9", approved: false });
  });

  it("carries a structured answer over the same presence", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket();
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    await Effect.runPromise(
      adapter.respondToUserInput(
        ThreadId.make("thr-1"),
        "run-1:ask-1" as never,
        { branch: "main" } as never,
      ),
    );
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    expect(socket.sent[0]).toEqual({
      kind: "answer",
      payload: { request_id: "run-1:ask-1", value: { branch: "main" } },
    });
  });

  it("holds a decision made while the socket is down instead of dropping it", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket();
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    socket.drop();

    await Effect.runPromise(
      adapter.respondToRequest(ThreadId.make("thr-1"), "run-1:call-1" as never, "accept" as never),
    );
    await settle();
    // Nothing sent yet — but the user's click is not lost either.
    expect(socket.sent).toHaveLength(0);

    socket.restore();
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    // A dropped decision would strand the turn until Atlas's gate deadline expired.
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.payload).toEqual({ request_id: "run-1:call-1", approved: true });
  });
});
