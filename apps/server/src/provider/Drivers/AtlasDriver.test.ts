import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import {
  ATLAS_DRIVER_KIND,
  atlasStartCommand,
  classifyHandshake,
  probeAtlasHost,
  type FetchLike,
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

  it("puts the picker's model on the wire where Atlas reads it", () => {
    const command = atlasStartCommand({
      ...base,
      modelId: "gpt-5.4",
      workspaceId: "ws-alpha",
    });

    expect(command["protocol_version"]).toBe(1);
    expect(command["thread_id"]).toBe("thr-1");
    expect(command["run_id"]).toBe("run-1");
    expect(command["request_id"]).toBe("req-1");
    const inner = command["command"] as Record<string, unknown>;
    expect(inner["kind"]).toBe("start");
    expect(inner["text"]).toBe("do the thing");
    // Top-level keys, not nested: Atlas flattens the binding onto the Start command.
    expect(inner["model_id"]).toBe("gpt-5.4");
    expect(inner["workspace_id"]).toBe("ws-alpha");
  });

  it("omits a selection entirely rather than sending an empty one", () => {
    // Atlas refuses a present-but-blank `model_id` explicitly and treats an ABSENT one as the
    // node default. Sending `""` would turn "no preference" into a 400, so the key must not
    // appear at all.
    const command = atlasStartCommand({ ...base, modelId: undefined, workspaceId: undefined });
    const inner = command["command"] as Record<string, unknown>;

    expect("model_id" in inner).toBe(false);
    expect("workspace_id" in inner).toBe(false);
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
