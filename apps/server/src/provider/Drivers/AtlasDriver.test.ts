import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";

import * as Scope from "effect/Scope";

import { ATLAS_ACCESS_TOKEN_ENV } from "@t3tools/contracts";

import { redactServerSettingsForClient } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ATLAS_DRIVER_KIND,
  type AtlasSocketFactory,
  atlasStartCommand,
  bindingFromSlug,
  bindingSlug,
  type FetchLike,
} from "./AtlasConsole.ts";
import {
  classifyHandshake,
  makeAtlasAdapter,
  makeAtlasDriver,
  probeAtlasHost,
  readAtlasAccessTokenForTest,
} from "./AtlasDriver.ts";

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
      // The remedy names the ENVIRONMENT variable, not a config field: the credential is a
      // sensitive instance environment value so it is redacted on the way to clients, and
      // telling a user to set a config key would point them at the leak this avoided.
      expect(probe.message).toContain("ATLAS_ACCESS_TOKEN");
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

  it("bootstraps with no settings at all", () => {
    const atlas = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === ATLAS_DRIVER_KIND);

    expect(atlas).toBeDefined();
    expect(atlas?.metadata.displayName).toBe("Atlas");
    // A default config must be usable with no settings at all, or the driver cannot be
    // bootstrapped before a user has configured it.
    expect(() => atlas?.defaultConfig()).not.toThrow();
  });

  /**
   * This used to be titled "needs no infrastructure services" — and it never actually checked
   * that, which is how the cursor hook shipped declared-but-unwired: the adapter accepted an
   * `onSessionCursor` that only tests ever supplied, so nothing a reader saw between turns
   * reached durable storage.
   *
   * The driver now requires `ProviderSessionDirectory`, which is exactly what `R` on
   * `ProviderDriver` is for, and asking for it in the type is what makes the registry supply
   * it in production rather than leaving the seam dangling.
   */
  it("persists a reader cursor through the real session directory", async () => {
    const node = makeFakeAtlas();
    const written: Array<Record<string, unknown>> = [];
    const scope = Effect.runSync(Scope.make());

    // The PRODUCTION construction path — `makeAtlasDriver().create()`, not a hand-built
    // adapter — so this fails if the hook is ever left dangling again.
    const instance = await Effect.runPromise(
      makeAtlasDriver({ fetch: node.fetch })
        .create({
          instanceId: "atlas-wired" as never,
          displayName: "Atlas",
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: { baseUrl: "http://127.0.0.1:3010" } as never,
        } as never)
        .pipe(
          Effect.provideService(ProviderSessionDirectory, {
            upsert: (binding: Record<string, unknown>) =>
              Effect.sync(() => {
                written.push(binding);
              }),
          } as never),
          Effect.provideService(Scope.Scope, scope),
        ),
    );

    const adapter = instance.adapter as unknown as ReturnType<typeof adapterFor>;
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await Effect.runPromise(
      adapter.startSession({ threadId: ThreadId.make("thr-1"), runtimeMode: "local" } as never),
    );
    // Something on each log, so both halves of the cursor have somewhere to move to.
    node.append("command.accepted", { command: { kind: "start" } });
    node.say("assistant", { text: "pong" });

    await waitFor(
      () =>
        written.some((binding) => {
          const cursor = binding["resumeCursor"] as
            | { after?: number; feed?: { after?: number } }
            | undefined;
          return (cursor?.after ?? 0) >= 1 && (cursor?.feed?.after ?? 0) >= 1;
        }),
      "the reader's position to reach the directory",
    );
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    await Effect.runPromise(Fiber.interrupt(fiber));

    const last = written[written.length - 1] as Record<string, unknown>;
    expect(last["threadId"]).toEqual("thr-1");
    expect(last["providerInstanceId"]).toEqual("atlas-wired");
    // Both logs, written mid-turn — not at a turn boundary, which is all the shipped path
    // managed before this was wired.
    expect(last["resumeCursor"]).toMatchObject({ epoch: 1, after: 1 });
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
  const consoleFrames: Array<Record<string, unknown>> = [];
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
      const params = new URL(href).searchParams;
      // A real node stores what the console wrote and serves it back under role=console. That
      // read-back is the receipt a decision is confirmed against.
      if (params.get("role") === "console") {
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ epoch: FEED_EPOCH, frames: consoleFrames })),
        });
      }
      const after = Number(params.get("after") ?? 0);
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

  /** What the console wrote, as the node would have durably stored it. */
  const recordConsole = (frame: { kind: string; payload: Record<string, unknown> }): void => {
    consoleFrames.push({
      epoch: FEED_EPOCH,
      seq: consoleFrames.length + 1,
      kind: frame.kind,
      role: "console",
      payload: frame.payload,
    });
  };

  return {
    fetch,
    commands,
    append,
    say,
    recordConsole,
    consoleFrames,
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

/**
 * A socket that connects and does nothing, for the tests that are not about approvals.
 *
 * Without it these adapters reach for a real WebSocket against a port nothing is listening on;
 * the failure re-dials on the adapter's injected clock, which these tests make instant, and the
 * resulting tight loop starves the event loop so nothing else makes progress.
 */
const silentSocket: AtlasSocketFactory = (_url, handlers) => {
  queueMicrotask(() => {
    handlers.onOpen();
    // A real node sends a heartbeat as soon as it has recorded presence; readiness waits on
    // that frame rather than on the upgrade.
    handlers.onMessage();
  });
  return { send: () => {}, close: () => {} };
};

const adapterFor = (node: ReturnType<typeof makeFakeAtlas>) =>
  makeAtlasAdapter({
    endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: undefined, fetch: node.fetch },
    fleetId: "default",
    instanceId: "atlas-1",
    sleep: instantSleep,
    idlePollMs: 0,
    connect: silentSocket,
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
const makeFakeSocket = (node?: ReturnType<typeof makeFakeAtlas>) => {
  const sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const urls: Array<string> = [];
  let live: { onOpen: () => void; onClose: () => void } | undefined;
  let openNow = true;

  const connect: AtlasSocketFactory = (url, handlers) => {
    urls.push(url);
    live = handlers;
    if (openNow)
      queueMicrotask(() => {
        handlers.onOpen();
        handlers.onMessage();
      });
    return {
      send: (data: string) => {
        const frame = JSON.parse(data) as { kind: string; payload: Record<string, unknown> };
        sent.push(frame);
        // The node durably records it, which is what the driver reads back to confirm.
        node?.recordConsole(frame);
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
    /**
     * A FAILED connection, as the browser factory reports one: `error` then `close`, both
     * routed to the same handler.
     */
    failWithErrorThenClose: () => {
      openNow = false;
      const handlers = live;
      handlers?.onClose();
      handlers?.onClose();
    },
    restore: () => {
      openNow = true;
      live?.onOpen();
      live?.onMessage();
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
    const socket = makeFakeSocket(node);
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

  it("waits for the node to confirm presence, not merely for the socket to open", async () => {
    const node = makeFakeAtlas();
    let announce: (() => void) | undefined;
    // A socket that completes its upgrade but has not yet been recorded by the node — the real
    // window between the client's `open` and the server's `enter_presence` write.
    const slowPresence: AtlasSocketFactory = (_url, handlers) => {
      queueMicrotask(handlers.onOpen);
      announce = handlers.onMessage;
      return { send: () => {}, close: () => {} };
    };
    const adapter = makeAtlasAdapter({
      endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: "tok", fetch: node.fetch },
      fleetId: "default",
      instanceId: "atlas-1",
      sleep: instantSleep,
      idlePollMs: 0,
      connect: slowPresence,
    });

    let ready = false;
    const session = Effect.runPromise(
      adapter.startSession({ threadId: ThreadId.make("thr-1"), runtimeMode: "local" } as never),
    ).then(() => {
      ready = true;
    });
    await settle();
    // Reporting ready here is what let a fast gated call be denied for "no console attached"
    // while the composer showed a live session.
    expect(ready).toBe(false);

    // The node speaks — `ws.rs` writes presence before its opening heartbeat, so the first
    // frame is a receipt for that write.
    announce?.();
    await session;
    expect(ready).toBe(true);
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
  });

  it("answers the id Atlas stated on the approval frame, and carries the decision", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket(node);
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
    const socket = makeFakeSocket(node);
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
    const socket = makeFakeSocket(node);
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

  it("re-dials once when a failed connection reports both error and close", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket(node);
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    const dialsAfterOpen = socket.urls.length;

    // `browserSocketFactory` sends BOTH events to the same callback, and a failed connect
    // fires them in sequence. Un-latched, each failure scheduled two re-dials, doubling every
    // retry until the backoff meant nothing.
    socket.failWithErrorThenClose();
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));

    expect(socket.urls.length - dialsAfterOpen).toEqual(1);
  });

  it("re-dials again after a socket that WAS working drops", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket(node);
    const adapter = socketAdapterFor(node, socket);
    await startSession(adapter);
    await settle();
    const dialsAfterOpen = socket.urls.length;

    // The other half of the latch, and the one my first attempt broke: latching on open as
    // well meant a healthy socket that later dropped never came back, so the console silently
    // stopped existing and every subsequent gated tool call was denied.
    socket.drop();
    await settle();
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));

    expect(socket.urls.length).toBeGreaterThan(dialsAfterOpen);
  });

  it("does not report a decision delivered until Atlas has stored it", async () => {
    const node = makeFakeAtlas();
    const socket = makeFakeSocket(node);
    // A real (tiny) clock here, unlike the other tests: this one is ABOUT the retry window, and
    // an instant sleep would burn every attempt before the socket could come back.
    const adapter = makeAtlasAdapter({
      endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: "tok", fetch: node.fetch },
      fleetId: "default",
      instanceId: "atlas-1",
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))),
      idlePollMs: 5,
      connect: socket.connect,
    });
    await startSession(adapter);
    socket.drop();

    // The user clicks while the connection is down. The decision must neither be lost nor
    // reported as delivered — a success here would tell them the tool was approved while the
    // turn quietly died on the gate's deadline.
    let settled = false;
    const decision = Effect.runPromise(
      adapter.respondToRequest(ThreadId.make("thr-1"), "run-1:call-1" as never, "accept" as never),
    ).then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(node.consoleFrames).toHaveLength(0);

    socket.restore();
    await decision;
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));

    // Held across the outage, then delivered and confirmed against the durable feed.
    expect(settled).toBe(true);
    expect(node.consoleFrames).toHaveLength(1);
    expect(node.consoleFrames[0]?.["payload"]).toEqual({
      request_id: "run-1:call-1",
      approved: true,
    });
  });

  it("reports a failure rather than a success when Atlas never records the decision", async () => {
    const node = makeFakeAtlas();
    // A socket that accepts writes and drops them: the shape of a half-open connection, and
    // the case where claiming success is most harmful.
    const blackhole: AtlasSocketFactory = (_url, handlers) => {
      queueMicrotask(() => {
        handlers.onOpen();
        handlers.onMessage();
      });
      return { send: () => {}, close: () => {} };
    };
    const adapter = makeAtlasAdapter({
      endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: "tok", fetch: node.fetch },
      fleetId: "default",
      instanceId: "atlas-1",
      sleep: instantSleep,
      idlePollMs: 0,
      connect: blackhole,
    });
    await startSession(adapter);
    const failure = await Effect.runPromise(
      Effect.flip(
        adapter.respondToRequest(
          ThreadId.make("thr-1"),
          "run-1:call-2" as never,
          "accept" as never,
        ),
      ),
    );
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    // The user is told it may not have applied, instead of being told it did.
    expect(String((failure as { detail: string }).detail)).toContain("did not record");
  });
});

describe("cursor persistence", () => {
  const persistingAdapter = (
    node: ReturnType<typeof makeFakeAtlas>,
    onSessionCursor: (update: {
      threadId: string;
      providerInstanceId: string;
      cursor: { epoch: number; after: number; feed: { epoch: number; after: number } };
    }) => Promise<void>,
  ) =>
    makeAtlasAdapter({
      endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: undefined, fetch: node.fetch },
      fleetId: "default",
      instanceId: "atlas-1",
      sleep: instantSleep,
      idlePollMs: 0,
      connect: silentSocket,
      onSessionCursor,
    });

  it("stores the full dual cursor after projecting, naming the thread and instance", async () => {
    const node = makeFakeAtlas();
    const stored: Array<Record<string, unknown>> = [];
    const adapter = persistingAdapter(node, async (update) => {
      stored.push(update as unknown as Record<string, unknown>);
    });
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    node.append("command.accepted", { command: { kind: "start" } });
    node.say("assistant", { text: "pong" });
    await waitFor(
      () =>
        stored.some(
          (entry) =>
            (entry["cursor"] as { after: number; feed: { after: number } }).after >= 1 &&
            (entry["cursor"] as { after: number; feed: { after: number } }).feed.after >= 1,
        ),
      "a persisted cursor covering both logs",
    );
    await teardown(adapter, fiber);

    const last = stored[stored.length - 1] as unknown as {
      threadId: string;
      providerInstanceId: string;
      cursor: { epoch: number; after: number; feed: { epoch: number; after: number } };
    };
    expect(last.threadId).toEqual("thr-1");
    expect(last.providerInstanceId).toEqual("atlas-1");
    // BOTH logs, in one write — persisting only the lifecycle half is what made a restart
    // replay the entire frame feed.
    expect(last.cursor.epoch).toEqual(1);
    expect(last.cursor.after).toEqual(1);
    expect(last.cursor.feed.after).toEqual(1);
  });

  it("does not advance past events whose position was never stored", async () => {
    const node = makeFakeAtlas();
    let failing = true;
    const adapter = persistingAdapter(node, async () => {
      if (failing) throw new Error("disk full");
    });
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    node.append("command.accepted", { command: { kind: "start" } });

    // Persistence keeps failing, so the reader must keep re-reading the same page rather than
    // moving past it. Re-delivery is idempotent for the projection; skipping is not.
    await waitFor(() => seen.length >= 3, "the same page to be re-delivered while writes fail");
    expect(seen.every((type) => type === "turn.started")).toBe(true);

    // Once the write succeeds the cursor finally moves, and the thread stops repeating.
    failing = false;
    await settle();
    const settledCount = seen.length;
    await settle();
    expect(seen.length).toEqual(settledCount);
    await teardown(adapter, fiber);
  });

  it("refuses to move a bookmark backwards", async () => {
    const node = makeFakeAtlas();
    const stored: Array<{ after: number }> = [];
    const adapter = persistingAdapter(node, async (update) => {
      stored.push({ after: update.cursor.after });
    });
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    // Hydrated from a position AHEAD of what this stale node will report.
    await startSession(adapter, {
      epoch: 1,
      after: 5,
      feed: { epoch: 1_700_000_000_000, after: 9 },
    });
    node.append("command.accepted", { command: { kind: "start" } });
    await settle();
    await teardown(adapter, fiber);

    // A stale page must never rewind the cursor and re-show content the user has seen.
    expect(stored.every((entry) => entry.after >= 5)).toBe(true);
  });
});

describe("the Atlas credential never reaches a client", () => {
  /**
   * The defect this design avoids.
   *
   * `redactServerSettingsForClient` blanks SENSITIVE entries of
   * `providerInstances.<id>.environment` and returns `instance.config` verbatim. So a bearer
   * token stored in provider config is written to settings JSON and broadcast to every
   * settings-reading client in clear text — the existing OpenAI-compatible `apiKey` defect.
   * Keeping Atlas auth in the environment is what makes redaction apply to it.
   */
  it("redacts the token when it is an environment value, and config carries none", () => {
    const settings = {
      providerInstances: {
        atlas: {
          driver: "atlas",
          enabled: true,
          config: { baseUrl: "http://127.0.0.1:3019" },
          environment: [
            { name: ATLAS_ACCESS_TOKEN_ENV, value: "super-secret-value", sensitive: true },
            { name: "ATLAS_LABEL", value: "not-a-secret", sensitive: false },
          ],
        },
      },
    } as never;

    const redacted = redactServerSettingsForClient(settings);
    const wire = JSON.stringify(redacted);

    // The secret is gone from everything a client can see.
    expect(wire).not.toContain("super-secret-value");
    const instance = (redacted as unknown as Record<string, Record<string, never>>)
      .providerInstances["atlas"] as unknown as {
      config: Record<string, unknown>;
      environment: ReadonlyArray<Record<string, unknown>>;
    };
    const token = instance.environment.find((v) => v["name"] === ATLAS_ACCESS_TOKEN_ENV);
    expect(token?.["value"]).toEqual("");
    expect(token?.["valueRedacted"]).toBe(true);
    // Non-sensitive values still travel, so redaction is targeted rather than blanket.
    expect(instance.environment.find((v) => v["name"] === "ATLAS_LABEL")?.["value"]).toEqual(
      "not-a-secret",
    );
    // And nothing token-shaped was ever put in config, which redaction does NOT cover.
    expect(Object.keys(instance.config)).not.toContain("accessToken");
  });

  it("reads the token from the environment the registry hands the driver", () => {
    const environment = [
      { name: "UNRELATED", value: "x", sensitive: false },
      { name: ATLAS_ACCESS_TOKEN_ENV, value: "  tok-123  ", sensitive: true },
    ];
    // Trimmed, because a value pasted with whitespace must not become a different bearer.
    expect(readAtlasAccessTokenForTest(environment as never)).toEqual("tok-123");
    // Absent and blank are both "no credential" — a node with no auth is a valid setup, and
    // an empty string must not be sent as a Bearer header.
    expect(readAtlasAccessTokenForTest([] as never)).toBeUndefined();
    expect(
      readAtlasAccessTokenForTest([
        { name: ATLAS_ACCESS_TOKEN_ENV, value: "   ", sensitive: true },
      ] as never),
    ).toBeUndefined();
  });
});
