import { describe, expect, it } from "vite-plus/test";

import {
  deriveAtlasDiagnosticsViewState,
  handshakeGrantsDiagnosticsRead,
  parseHandshakeCapabilities,
  summarizeAtlasDiagnosticsSnapshot,
  type AtlasDiagnosticsRpcState,
} from "./AtlasDiagnostics.logic";

const PENDING: AtlasDiagnosticsRpcState<never> = { data: null, error: null, isPending: true };

const HANDSHAKE_WITH_DIAGNOSTICS = JSON.stringify({
  protocol_version: 1,
  fleet_id: "default",
  authenticated_subject: "atlas-machine",
  granted_scopes: ["read"],
  capabilities: ["run.commands", "diagnostics.read"],
  connection_id: "atlas-http-1",
  server_time_ms: 0,
  heartbeat_interval_ms: 15000,
  replay_boundaries: [],
});

const HANDSHAKE_WITHOUT_DIAGNOSTICS = JSON.stringify({
  protocol_version: 1,
  fleet_id: "default",
  authenticated_subject: "atlas-machine",
  granted_scopes: ["read"],
  capabilities: ["run.commands"],
  connection_id: "atlas-http-1",
  server_time_ms: 0,
  heartbeat_interval_ms: 15000,
  replay_boundaries: [],
});

const DIAGNOSTICS_SNAPSHOT = JSON.stringify({
  protocol_version: 1,
  node_id: "seraphim",
  server_time_ms: 123,
  fleet: {
    self_id: "seraphim",
    members: [
      {
        id: "seraphim",
        url: "http://127.0.0.1:3010",
        tools: [],
        vitals: {},
        manifest: {},
        age_ms: 0,
      },
    ],
  },
  providers: [
    {
      provider: "anthropic",
      model_id: "claude-opus-4-8",
      capabilities: ["tools"],
      available: true,
    },
    {
      provider: "openai",
      model_id: "",
      capabilities: [],
      available: false,
      detail: "no credential",
    },
  ],
  runs: { total: 3, by_status: [], by_plugin: [], by_workspace: [], recent: [] },
  inflight: [{ run_id: "run-1", cancellable: true }],
});

function baseInput() {
  return {
    serverSupportsProxy: true,
    atlasInstanceId: "atlas",
    handshake: PENDING,
    diagnostics: PENDING,
  };
}

describe("deriveAtlasDiagnosticsViewState", () => {
  it("renders unsupported when this T3 server has no Atlas diagnostics proxy", () => {
    const state = deriveAtlasDiagnosticsViewState({ ...baseInput(), serverSupportsProxy: false });
    expect(state.kind).toBe("unsupported");
  });

  it("renders not-configured when no Atlas provider instance is set up", () => {
    const state = deriveAtlasDiagnosticsViewState({ ...baseInput(), atlasInstanceId: null });
    expect(state.kind).toBe("not-configured");
  });

  it("renders loading while the handshake is still in flight", () => {
    const state = deriveAtlasDiagnosticsViewState(baseInput());
    expect(state.kind).toBe("loading");
  });

  it("renders unauthorized on a 401 handshake", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: { status: 401, bodyText: "unauthenticated" },
        error: null,
        isPending: false,
      },
    });
    expect(state.kind).toBe("unauthorized");
    expect(state.kind === "unauthorized" && state.message).toContain("401");
  });

  it("renders diagnostics-disabled when the handshake omits diagnostics.read", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: { status: 200, bodyText: HANDSHAKE_WITHOUT_DIAGNOSTICS },
        error: null,
        isPending: false,
      },
    });
    expect(state.kind).toBe("diagnostics-disabled");
    expect(state.kind === "diagnostics-disabled" && state.message).toContain("ATLAS_DIAGNOSTICS");
  });

  it("renders credential-refused-insecure from a proxy credential fault", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: null,
        error:
          "The Atlas access token on this instance is not marked sensitive, so it would be " +
          "stored and sent to clients in clear text. It has NOT been used.",
        isPending: false,
      },
    });
    expect(state.kind).toBe("credential-refused-insecure");
  });

  it("renders unreachable for a network-level proxy fault", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: null,
        error: "The Atlas node could not be reached: ECONNREFUSED",
        isPending: false,
      },
    });
    expect(state.kind).toBe("unreachable");
  });

  it("renders unreachable for a non-2xx, non-401/403 handshake status", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: { data: { status: 502, bodyText: "bad gateway" }, error: null, isPending: false },
    });
    expect(state.kind).toBe("unreachable");
  });

  it("stays loading for the diagnostics snapshot once the handshake grants the capability", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: { status: 200, bodyText: HANDSHAKE_WITH_DIAGNOSTICS },
        error: null,
        isPending: false,
      },
    });
    expect(state.kind).toBe("loading");
  });

  it("renders connected once both the handshake and the snapshot succeed", () => {
    const state = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: { status: 200, bodyText: HANDSHAKE_WITH_DIAGNOSTICS },
        error: null,
        isPending: false,
      },
      diagnostics: {
        data: { status: 200, bodyText: DIAGNOSTICS_SNAPSHOT },
        error: null,
        isPending: false,
      },
    });
    expect(state.kind).toBe("connected");
  });

  it("a reconnect: an unreachable handshake followed by a fresh success renders connected", () => {
    const failing = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: null,
        error: "The Atlas node could not be reached: ECONNRESET",
        isPending: false,
      },
    });
    expect(failing.kind).toBe("unreachable");

    const recovered = deriveAtlasDiagnosticsViewState({
      ...baseInput(),
      handshake: {
        data: { status: 200, bodyText: HANDSHAKE_WITH_DIAGNOSTICS },
        error: null,
        isPending: false,
      },
      diagnostics: {
        data: { status: 200, bodyText: DIAGNOSTICS_SNAPSHOT },
        error: null,
        isPending: false,
      },
    });
    expect(recovered.kind).toBe("connected");
  });
});

describe("handshakeGrantsDiagnosticsRead", () => {
  it("is false before a handshake has arrived", () => {
    expect(handshakeGrantsDiagnosticsRead(null)).toBe(false);
  });

  it("is false on a non-2xx handshake", () => {
    expect(handshakeGrantsDiagnosticsRead({ status: 401, bodyText: "" })).toBe(false);
  });

  it("is false when the capability is absent", () => {
    expect(
      handshakeGrantsDiagnosticsRead({ status: 200, bodyText: HANDSHAKE_WITHOUT_DIAGNOSTICS }),
    ).toBe(false);
  });

  it("is true when diagnostics.read is advertised", () => {
    expect(
      handshakeGrantsDiagnosticsRead({ status: 200, bodyText: HANDSHAKE_WITH_DIAGNOSTICS }),
    ).toBe(true);
  });
});

describe("parseHandshakeCapabilities", () => {
  it("returns null for a body that is not a handshake", () => {
    expect(parseHandshakeCapabilities("<html>not json</html>")).toBeNull();
    expect(parseHandshakeCapabilities(JSON.stringify({ ok: true }))).toBeNull();
  });
});

describe("summarizeAtlasDiagnosticsSnapshot", () => {
  it("reads the fields the panel renders off Atlas's own wire shape", () => {
    const summary = summarizeAtlasDiagnosticsSnapshot(DIAGNOSTICS_SNAPSHOT);
    expect(summary).toEqual({
      nodeId: "seraphim",
      protocolVersion: 1,
      fleetSelfId: "seraphim",
      fleetMemberCount: 1,
      providerCount: 2,
      availableProviderCount: 1,
      runTotal: 3,
      inflightCount: 1,
    });
  });

  it("degrades to an all-null summary instead of throwing on a malformed body", () => {
    const summary = summarizeAtlasDiagnosticsSnapshot("not json at all");
    expect(summary.nodeId).toBeNull();
    expect(summary.runTotal).toBeNull();
  });
});
