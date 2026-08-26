import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  AtlasRefusal,
  atlasStartCommand,
  decodeLifecycleEvent,
  projectFeedFrame,
  projectLifecycleEvent,
  readCatalog,
  readEvents,
  startTurn,
  type AtlasEndpoint,
  type AtlasFrame,
  type FetchLike,
} from "./AtlasConsole.ts";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";

/**
 * A stub host that records what it was asked and answers what it was told to.
 *
 * The point of recording is that a 202 does not prove a start REACHED the right route with the
 * right bytes — only reading the request does.
 */
const stubHost = (
  routes: ReadonlyArray<{
    readonly match: string;
    readonly status: number;
    readonly body: string;
  }>,
) => {
  const seen: Array<{ url: string; method: string; body: string | undefined }> = [];
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, method: init?.method ?? "GET", body: init?.body });
    const route = routes.find((candidate) => url.includes(candidate.match));
    return Promise.resolve({
      status: route?.status ?? 404,
      text: () => Promise.resolve(route?.body ?? "{}"),
    });
  };
  return { seen, endpoint: { baseUrl: "http://node", accessToken: "dev", fetch } as AtlasEndpoint };
};

const THREAD = "thr-1" as unknown as ThreadId;

describe("startTurn", () => {
  it("reaches the thread's command route with the binding intact", async () => {
    const host = stubHost([
      {
        match: "/console/v1/threads/thr-1/commands",
        status: 202,
        body: JSON.stringify({
          accepted: true,
          run: {
            run_id: "req-1",
            binding: { provider: "openai", model_id: "gpt-5.4" },
            state: "starting",
          },
        }),
      },
    ]);

    const run = await startTurn(
      host.endpoint,
      atlasStartCommand({
        fleetId: "default",
        threadId: "thr-1",
        runId: "req-1",
        requestId: "req-1",
        actor: "t3",
        text: "hello",
        binding: { provider: "openai", model_id: "gpt-5.4" },
        workspaceId: undefined,
      }),
    );

    // The REQUEST, not the response: this is what proves it went to the durable console API.
    expect(host.seen).toHaveLength(1);
    expect(host.seen[0]!.method).toBe("POST");
    expect(host.seen[0]!.url).toBe("http://node/console/v1/threads/thr-1/commands");
    const sent = JSON.parse(host.seen[0]!.body!) as Record<string, unknown>;
    expect((sent["command"] as Record<string, unknown>)["binding"]).toEqual({
      provider: "openai",
      model_id: "gpt-5.4",
    });

    // And the RECORD comes back, which is what the turn is driven from.
    expect(run["binding"]).toEqual({ provider: "openai", model_id: "gpt-5.4" });
  });

  it("surfaces Atlas's refusal verbatim instead of a generic failure", async () => {
    // Bytes shaped like atlas-host's StructuredError for an unserved model.
    const host = stubHost([
      {
        match: "/commands",
        status: 400,
        body: JSON.stringify({
          code: "invalid_request",
          message: 'openai does not serve model "gpt-9-nope" on this node',
          retryable: false,
          details: {},
        }),
      },
    ]);

    const failure = await startTurn(
      host.endpoint,
      atlasStartCommand({
        fleetId: "default",
        threadId: "thr-1",
        runId: "r",
        requestId: "r",
        actor: "t3",
        text: "hi",
        binding: { provider: "openai", model_id: "gpt-9-nope" },
        workspaceId: undefined,
      }),
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AtlasRefusal);
    const refusal = failure as AtlasRefusal;
    // The authority's sentence, not the lens's paraphrase. It names the provider AND the
    // model, which is the only version a user can act on.
    expect(refusal.message).toBe('openai does not serve model "gpt-9-nope" on this node');
    expect(refusal.code).toBe("invalid_request");
    expect(refusal.status).toBe(400);
  });

  it("does not treat an accepted-but-empty answer as a started turn", async () => {
    const host = stubHost([{ match: "/commands", status: 202, body: "{}" }]);
    const failure = await startTurn(
      host.endpoint,
      atlasStartCommand({
        fleetId: "default",
        threadId: "thr-1",
        runId: "r",
        requestId: "r",
        actor: "t3",
        text: "hi",
        binding: undefined,
        workspaceId: undefined,
      }),
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AtlasRefusal);
  });
});

describe("decodeLifecycleEvent", () => {
  it("parses payload_json, which arrives as a string", () => {
    // The column is TEXT. A reader that forgets this gets an object-shaped nothing and renders
    // an empty turn — the failure is silent, which is why it has its own test.
    const event = decodeLifecycleEvent({
      epoch: 1,
      seq: 4,
      event_id: "command:req-1",
      run_id: "run-1",
      attempt_id: "run-1:attempt:1",
      kind: "command.accepted",
      payload_json: JSON.stringify({ state: "starting" }),
    });

    expect(event).not.toBeNull();
    expect(event!.payload["state"]).toBe("starting");
    expect(event!.seq).toBe(4);
  });

  it("returns null for a row that is not a lifecycle event", () => {
    expect(decodeLifecycleEvent(null)).toBeNull();
    expect(decodeLifecycleEvent({ seq: "not-a-number", kind: "x" })).toBeNull();
    expect(decodeLifecycleEvent({ seq: 1 })).toBeNull();
  });
});

describe("readEvents", () => {
  const page = (rows: ReadonlyArray<Record<string, unknown>>) =>
    JSON.stringify({ epoch: 1, events: rows });

  const row = (seq: number, state: string) => ({
    epoch: 1,
    seq,
    event_id: `e-${seq}`,
    run_id: "run-1",
    attempt_id: "run-1:attempt:1",
    kind: "command.accepted",
    payload_json: JSON.stringify({ state }),
  });

  it("advances the cursor past what it read, so a resume does not repeat", async () => {
    const host = stubHost([
      { match: "/events", status: 200, body: page([row(1, "starting"), row(2, "running")]) },
    ]);

    const first = await readEvents(host.endpoint, "thr-1", { epoch: 1, after: 0 });
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.cursor).toEqual({ epoch: 1, after: 2 });
    expect(host.seen[0]!.url).toContain("epoch=1&after=0");

    // The RECONNECT: asking again from the returned cursor requests only what is newer.
    await readEvents(host.endpoint, "thr-1", first.cursor);
    expect(host.seen[1]!.url).toContain("epoch=1&after=2");
  });

  it("leaves the cursor alone on an empty page", async () => {
    // A cursor that reset to 0 on an idle poll would re-deliver the whole thread, forever.
    const host = stubHost([{ match: "/events", status: 200, body: page([]) }]);

    const result = await readEvents(host.endpoint, "thr-1", { epoch: 1, after: 7 });
    expect(result.events).toHaveLength(0);
    expect(result.cursor).toEqual({ epoch: 1, after: 7 });
  });
});

/**
 * The bytes a REAL atlas-host emitted, captured from a live node on 2026-08-25 by driving one
 * turn through the console API.
 *
 * These replace hand-written fixtures, and the replacement was not cosmetic: the first
 * projection assumed a lifecycle payload of {state, binding}. It is not — a row carries the
 * ENVELOPE that caused it, so a start's binding lives under `command` and a stop's outcome
 * under `observation.stop`. The invented fixtures agreed with the invented assumption, so the
 * tests passed while the projection emitted NOTHING against a live node. Captured bytes are
 * the only version of this test worth having.
 */
const LIVE_EVENTS = [
  {
    attempt_id: "e2e-1:attempt:1",
    epoch: 1,
    event_id: "command:e2e-1",
    kind: "command.accepted",
    payload_json:
      '{"actor":"t3","command":{"binding":{"model_id":"claude-opus-4-8","provider":"anthropic"},"kind":"start","limits":{"max_tokens":null,"max_tool_calls":null,"max_turn_requests":null,"max_wall_time_ms":null,"session_budget_id":null},"text":"hello","workspace_id":null},"expected_lease_generation":null,"fleet_id":"default","protocol_version":1,"request_id":"e2e-1","run_id":"e2e-1","thread_id":"thr-e2e"}',
    recorded_at: 1787703483072,
    run_id: "e2e-1",
    seq: 1,
  },
  {
    attempt_id: "e2e-1:attempt:1",
    epoch: 1,
    event_id: "e2e-1:connected",
    kind: "provider.connected",
    payload_json:
      '{"attempt_id":"e2e-1:attempt:1","event_id":"e2e-1:connected","fleet_id":"default","lease_generation":1,"observation":{"type":"provider_connected"},"protocol_version":1,"provider_seq":1,"run_id":"e2e-1","thread_id":"thr-e2e"}',
    recorded_at: 1787703483178,
    run_id: "e2e-1",
    seq: 2,
  },
  {
    attempt_id: "e2e-1:attempt:1",
    epoch: 1,
    event_id: "e2e-1:attempt:1:provider-stopped",
    kind: "provider.stopped",
    payload_json:
      '{"attempt_id":"e2e-1:attempt:1","event_id":"e2e-1:attempt:1:provider-stopped","fleet_id":"default","lease_generation":1,"observation":{"stop":{"outcome":"completed","provider_code":"turn_completed"},"type":"provider_stopped"},"protocol_version":1,"provider_seq":2,"run_id":"e2e-1","thread_id":"thr-e2e"}',
    recorded_at: 1787703485589,
    run_id: "e2e-1",
    seq: 3,
  },
];

describe("projectLifecycleEvent against a real node's bytes", () => {
  const context = { threadId: THREAD, createdAt: "2026-08-25T00:00:00.000Z" };
  const decoded = LIVE_EVENTS.map((row) => decodeLifecycleEvent(row)!);

  it("decodes every captured row", () => {
    expect(decoded.every((event) => event !== null)).toBe(true);
    expect(decoded.map((event) => event.kind)).toEqual([
      "command.accepted",
      "provider.connected",
      "provider.stopped",
    ]);
  });

  it("renders the start with the provider AND model that answered", () => {
    const projected = projectLifecycleEvent(decoded[0]!, context);

    expect(projected).toHaveLength(1);
    expect(projected[0]!.type).toBe("turn.started");
    // Read off real bytes. A thread whose point is that consecutive turns can run on different
    // companies is unreadable if the transcript records only a model string.
    expect((projected[0]!.payload as Record<string, unknown>)["model"]).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("renders the stop from the observation's outcome", () => {
    const projected = projectLifecycleEvent(decoded[2]!, context);

    expect(projected).toHaveLength(1);
    expect(projected[0]!.type).toBe("turn.completed");
    expect((projected[0]!.payload as Record<string, unknown>)["state"]).toBe("completed");
    expect((projected[0]!.payload as Record<string, unknown>)["stopReason"]).toBe("turn_completed");
  });

  it("emits nothing for an event with no meaning here, rather than inventing one", () => {
    // provider.connected is real and carries no turn boundary. A synthetic event would put
    // something on screen that Atlas does not believe in.
    expect(projectLifecycleEvent(decoded[1]!, context)).toHaveLength(0);
  });

  it("maps each stop outcome to the turn state a lens renders", () => {
    const stopEvent = (outcome: string) => ({
      ...decoded[2]!,
      payload: {
        observation: { type: "provider_stopped", stop: { outcome, provider_code: "x" } },
      },
    });

    for (const [outcome, state] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      // Stalled means the supervisor stopped waiting: not a whole answer, and not the body's
      // fault either.
      ["stalled", "interrupted"],
    ] as const) {
      const projected = projectLifecycleEvent(stopEvent(outcome), context);
      expect(projected).toHaveLength(1);
      expect((projected[0]!.payload as Record<string, unknown>)["state"]).toBe(state);
    }

    // An outcome this build does not know yields nothing rather than a guessed turn state.
    expect(projectLifecycleEvent(stopEvent("teleported"), context)).toHaveLength(0);
  });

  it("ignores a non-start command, which is also a command.accepted", () => {
    const cancel = { ...decoded[0]!, payload: { command: { kind: "cancel" } } };
    expect(projectLifecycleEvent(cancel, context)).toHaveLength(0);
  });
});

describe("readCatalog", () => {
  it("offers only what the node says it can reach, and keeps the provider in the slug", async () => {
    const host = stubHost([
      {
        match: "/_models",
        status: 200,
        body: JSON.stringify({
          node_id: "local",
          providers: [
            {
              provider: "anthropic",
              available: true,
              models: [{ model_id: "claude-opus-4-8", capabilities: ["tools"] }],
              detail: null,
            },
            {
              provider: "ollama",
              available: true,
              models: [{ model_id: "qwen2.5-coder:7b", capabilities: ["tools"] }],
              detail: null,
            },
            // Unavailable: the node just said it cannot reach this. Offering it would produce
            // a refusal at send time — display-only readiness with extra steps.
            {
              provider: "openai",
              available: false,
              models: [],
              detail: "the codex CLI is not on PATH",
            },
          ],
        }),
      },
    ]);

    const models = await readCatalog(host.endpoint);

    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-opus-4-8",
      "ollama/qwen2.5-coder:7b",
    ]);
    expect(models.some((model) => model.provider === "openai")).toBe(false);
    // The company is in the name a user reads, not only in the slug the code parses.
    expect(models[0]!.name).toBe("anthropic · claude-opus-4-8");
    expect(models[0]!.capabilities).toEqual(["tools"]);
  });

  it("returns nothing rather than throwing when the catalog is unreachable", async () => {
    // A picker with no models is honest; a provider that fails to construct is not.
    const host = stubHost([{ match: "/_models", status: 401, body: "unauthenticated" }]);
    expect(await readCatalog(host.endpoint)).toEqual([]);
  });
});

// ─────────────── projections must survive T3's own decoder ───────────────

/**
 * Frames captured from a real atlas-host, not invented here.
 *
 * Every row below was read off `GET /console/v1/threads/{id}/feed` on a live node during a
 * local-model turn. Hand-written fixtures are what let the previous round ship a projection
 * that agreed with its author and nothing else.
 */
const CAPTURED_FRAMES: ReadonlyArray<AtlasFrame> = [
  {
    seq: 7,
    epoch: 1787713415759,
    kind: "assistant",
    role: "agent",
    payload: { text: "pong" },
  },
  {
    seq: 4,
    epoch: 1787713415759,
    kind: "user",
    role: "agent",
    payload: { text: "Reply with exactly the word: pong" },
  },
  {
    seq: 5,
    epoch: 1787713415759,
    kind: "usage",
    role: "agent",
    payload: { input_tokens: 17168, output_tokens: 2, model: "qwen2.5-coder:7b" },
  },
  {
    seq: 6,
    epoch: 1787713415759,
    kind: "ctx",
    role: "agent",
    payload: { used: 17168, window: 32768 },
  },
  {
    seq: 8,
    epoch: 1787713415759,
    kind: "lifecycle",
    role: "agent",
    payload: { state: "completed", run_id: "r1" },
  },
  { seq: 9, epoch: 1787713415759, kind: "turn", role: "agent", payload: { state: "done" } },
  {
    seq: 10,
    epoch: 1787713415759,
    kind: "approval",
    role: "agent",
    payload: {
      request_id: "r1:call-7",
      request_type: "command_execution_approval",
      tool: "mcp__triage__nodes",
      args: {},
      reason: "`triage` needs approval on this node",
    },
  },
  {
    seq: 11,
    epoch: 1787713415759,
    kind: "tool_call",
    role: "agent",
    payload: { call_id: "call-7", tool: "mcp__triage__nodes", args: {} },
  },
  {
    seq: 12,
    epoch: 1787713415759,
    kind: "tool_result",
    role: "agent",
    payload: { call_id: "call-7", result_ref: "res-1" },
  },
  {
    seq: 13,
    epoch: 1787713415759,
    kind: "thinking",
    role: "agent",
    payload: { text: "considering" },
  },
  { seq: 14, epoch: 1787713415759, kind: "error", role: "agent", payload: { message: "boom" } },
  {
    seq: 15,
    epoch: 1787713415759,
    kind: "warning",
    role: "agent",
    payload: { message: "model cannot call tools" },
  },
];

const projectionContext = {
  threadId: ThreadId.make("thr-decode"),
  createdAt: "2026-08-26T00:00:00.000Z",
  turnId: "run-1",
};

describe("frame projection against the real contract", () => {
  /**
   * The guard that would have caught #8.
   *
   * `projectFeedFrame` returns values cast to `ProviderRuntimeEvent`, so the typecheck cannot
   * see a wrong `itemType` — `"tool_call"` is not a `CanonicalItemType` and every tool event
   * failed T3's decoder while the build stayed green. Decoding here is what makes the cast
   * honest: a bad shape fails this test instead of reaching the runtime.
   */
  it("emits only events T3 can actually decode", () => {
    const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
    for (const frame of CAPTURED_FRAMES) {
      for (const event of projectFeedFrame(frame, projectionContext)) {
        expect(
          () => decode(event),
          `frame kind "${frame.kind}" produced an undecodable event`,
        ).not.toThrow();
      }
    }
  });

  /**
   * Decoding alone passes vacuously when a projection returns NOTHING — which is how a
   * deleted `case "approval"` slipped past the check above once already. So the kinds that
   * must produce an event are named, and silence on any of them is a failure.
   */
  it("actually produces an event for every frame kind that carries one", () => {
    const mustProject: Record<string, string> = {
      assistant: "content.delta",
      thinking: "content.delta",
      approval: "request.opened",
      tool_call: "item.started",
      tool_result: "item.completed",
      error: "runtime.error",
      warning: "runtime.warning",
    };
    for (const [kind, expected] of Object.entries(mustProject)) {
      const frame = CAPTURED_FRAMES.find((candidate) => candidate.kind === kind);
      expect(frame, `no captured frame for kind "${kind}"`).toBeDefined();
      const projected = projectFeedFrame(frame as AtlasFrame, projectionContext);
      expect(projected.length, `kind "${kind}" projected nothing`).toBeGreaterThan(0);
      expect(projected.map((event) => event.type)).toContain(expected);
    }
  });

  it("joins a tool call to its result under one item id", () => {
    const started = projectFeedFrame(CAPTURED_FRAMES[7] as AtlasFrame, projectionContext);
    const completed = projectFeedFrame(CAPTURED_FRAMES[8] as AtlasFrame, projectionContext);
    const startedId = (started[0] as unknown as Record<string, unknown>)["itemId"];
    const completedId = (completed[0] as unknown as Record<string, unknown>)["itemId"];
    expect(startedId).toBeDefined();
    // One tool call is one item. Without a shared id the pair renders as two orphans.
    expect(completedId).toEqual(startedId);
    expect(
      (started[0] as unknown as { payload: Record<string, unknown> }).payload["itemType"],
    ).toEqual("mcp_tool_call");
  });

  it("stays silent on the frames the supervisor owns, so the lens is not a second author", () => {
    for (const kind of ["turn", "lifecycle", "user", "usage", "ctx"]) {
      const frame = CAPTURED_FRAMES.find((candidate) => candidate.kind === kind);
      expect(projectFeedFrame(frame as AtlasFrame, projectionContext)).toEqual([]);
    }
  });

  it("ignores a console echo of our own approval", () => {
    const echoed: AtlasFrame = {
      seq: 1,
      epoch: 1,
      kind: "approve",
      role: "console",
      payload: { request_id: "r1:call-7", approved: true },
    };
    expect(projectFeedFrame(echoed, projectionContext)).toEqual([]);
  });
});
