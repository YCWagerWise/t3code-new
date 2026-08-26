import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  ATLAS_DRIVER_KIND,
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

  return {
    fetch,
    commands,
    append,
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
    expect(turn.resumeCursor).toEqual({ epoch: 1, after: 1 });

    // A new process, same durable log, hydrated from what was persisted.
    const adapterB = adapterFor(node);
    const seenB: Array<string> = [];
    const fiberB = collect(adapterB, seenB);
    const session = await startSession(adapterB, turn.resumeCursor);
    expect(session.resumeCursor).toEqual({ epoch: 1, after: 1 });
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
    expect(session.resumeCursor).toEqual({ epoch: 1, after: 0 });
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

describe("approvals", () => {
  it("answers the request_ref the host stated, over the console command path", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    // The authority says it is waiting, and names the ref.
    node.append("waiting_for_input", {
      observation: { type: "waiting_for_input", request_ref: "req-from-atlas" },
    });
    await waitFor(() => node.consumedUpTo() >= 1, "the reader to consume the waiting event");
    await Effect.runPromise(
      adapter.respondToRequest(
        ThreadId.make("thr-1"),
        "t3-local-id" as never,
        "acceptForSession" as never,
      ),
    );
    await teardown(adapter, fiber);

    const command = node.resolveCommand()?.["command"] as Record<string, unknown>;
    // The ref is Atlas's, not T3's local id — a ref invented here matches nothing.
    expect(command["request_ref"]).toEqual("req-from-atlas");
    // The decision travels whole rather than collapsing into a boolean.
    expect(command["answer"]).toEqual({ kind: "approval", decision: "acceptForSession" });
  });

  it("carries a structured answer through the same seam", async () => {
    const node = makeFakeAtlas();
    const adapter = adapterFor(node);
    const seen: Array<string> = [];
    const fiber = collect(adapter, seen);
    await startSession(adapter);
    node.append("waiting_for_input", {
      observation: { type: "waiting_for_input", request_ref: "ask-1" },
    });
    await waitFor(() => node.consumedUpTo() >= 1, "the reader to consume the waiting event");
    await Effect.runPromise(
      adapter.respondToUserInput(
        ThreadId.make("thr-1"),
        "ask-1" as never,
        { branch: "main" } as never,
      ),
    );
    await teardown(adapter, fiber);

    expect((node.resolveCommand()?.["command"] as Record<string, unknown>)["answer"]).toEqual({
      kind: "answer",
      answers: { branch: "main" },
    });
  });

  it("surfaces the host's refusal verbatim when the run is not waiting", async () => {
    const node = makeFakeAtlas();
    const refusing: FetchLike = (url, init) =>
      String(url).includes("/events")
        ? node.fetch(url, init)
        : Promise.resolve({
            status: 409,
            text: () =>
              Promise.resolve(
                JSON.stringify({ code: "conflict", message: "run is not waiting for input" }),
              ),
          });
    const adapter = makeAtlasAdapter({
      endpoint: { baseUrl: "http://127.0.0.1:3010", accessToken: undefined, fetch: refusing },
      fleetId: "default",
      instanceId: "atlas-1",
      sleep: instantSleep,
      idlePollMs: 0,
    });
    await startSession(adapter);
    // `flip` turns the expected failure into the success channel: the refusal IS the result
    // under test, so a passing turn here would be the bug.
    const refusal = await Effect.runPromise(
      Effect.flip(
        adapter.respondToRequest(ThreadId.make("thr-1"), "req-1" as never, "accept" as never),
      ),
    );
    await Effect.runPromise(adapter.stopSession(ThreadId.make("thr-1")));
    // Atlas's own sentence, not "approval failed" — it is the only actionable part.
    expect(String((refusal as { detail: string }).detail)).toContain(
      "run is not waiting for input",
    );
  });
});
