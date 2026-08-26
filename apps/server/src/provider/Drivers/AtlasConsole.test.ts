import { describe, expect, it } from "@effect/vitest";

import {
  AtlasRefusal,
  atlasStartCommand,
  decodeLifecycleEvent,
  projectLifecycleEvent,
  readCatalog,
  readEvents,
  startTurn,
  type AtlasEndpoint,
  type FetchLike,
} from "./AtlasConsole.ts";
import type { ThreadId } from "@t3tools/contracts";

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
