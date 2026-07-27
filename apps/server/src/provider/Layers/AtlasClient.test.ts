/**
 * AtlasClient tests.
 *
 * These run against a *stubbed* HTTP client, not a live node — CI has no Atlas
 * ring, and a test that silently skips when the fleet is down is a test that
 * lies. The live-node check is a manual step recorded in ATLAS-PORT-PLAN.md.
 *
 * What is pinned here is the wire contract we verified by hand against a real
 * node: the URL shape, the JSON body keys, and that the plain-text response
 * comes back verbatim. Those are exactly the things a refactor could silently
 * break.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  type AtlasMember,
  AtlasMembers,
  atlasMembers,
  atlasRun,
  bodiesForMember,
  defaultBodyForMember,
  modelOptionsForMember,
} from "./AtlasClient.ts";

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

/**
 * Minimal HttpClient stub: records the outgoing request and replays a canned
 * response, so assertions are about the wire shape we send.
 */
const stubHttpClient = (respondWith: { status: number; body: string }) => {
  const captured: Array<CapturedRequest> = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const bodyText =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : request.body._tag === "Raw"
              ? String(request.body.body)
              : "";
        captured.push({ url: request.url, method: request.method, body: bodyText });
        return HttpClientResponse.fromWeb(
          request,
          new Response(respondWith.body, { status: respondWith.status }),
        );
      }),
    ),
  );
  return { captured, layer };
};

describe("AtlasClient", () => {
  describe("atlasRun", () => {
    it.effect("posts task and plugin to /Agent/{runId}/run and returns the body verbatim", () => {
      const stub = stubHttpClient({ status: 200, body: "SEAM-OK" });
      return atlasRun({
        baseUrl: "http://127.0.0.1:3010",
        runId: "run-42",
        plugin: "coder",
        task: "say hello",
      }).pipe(
        Effect.map((answer) => {
          assert.strictEqual(answer, "SEAM-OK");
          assert.strictEqual(stub.captured.length, 1);
          const [sent] = stub.captured;
          assert.strictEqual(sent?.url, "http://127.0.0.1:3010/Agent/run-42/run");
          assert.strictEqual(sent?.method, "POST");
          assert.deepStrictEqual(JSON.parse(sent?.body ?? "{}"), {
            task: "say hello",
            plugin: "coder",
          });
        }),
        Effect.provide(stub.layer),
      );
    });

    it.effect("strips a trailing slash so the path never doubles up", () => {
      const stub = stubHttpClient({ status: 200, body: "ok" });
      return atlasRun({
        baseUrl: "http://127.0.0.1:3010/",
        runId: "run-1",
        plugin: "coder",
        task: "t",
      }).pipe(
        Effect.map(() => {
          assert.strictEqual(stub.captured[0]?.url, "http://127.0.0.1:3010/Agent/run-1/run");
        }),
        Effect.provide(stub.layer),
      );
    });

    it.effect("encodes a run id that would otherwise break the path", () => {
      const stub = stubHttpClient({ status: 200, body: "ok" });
      return atlasRun({
        baseUrl: "http://127.0.0.1:3010",
        runId: "a/b c",
        plugin: "coder",
        task: "t",
      }).pipe(
        Effect.map(() => {
          assert.strictEqual(stub.captured[0]?.url, "http://127.0.0.1:3010/Agent/a%2Fb%20c/run");
        }),
        Effect.provide(stub.layer),
      );
    });

    it.effect("fails with a tagged AtlasClientError, not a bare Error", () => {
      const stub = stubHttpClient({ status: 500, body: "boom" });
      return atlasRun({
        baseUrl: "http://127.0.0.1:3010",
        runId: "run-err",
        plugin: "coder",
        task: "t",
      }).pipe(
        Effect.flip,
        Effect.map((error) => {
          assert.strictEqual(error._tag, "AtlasClientError");
          assert.strictEqual(error.operation, "run");
        }),
        Effect.provide(stub.layer),
      );
    });
  });

  describe("atlasMembers", () => {
    it.effect("decodes the gossip ring", () => {
      const stub = stubHttpClient({
        status: 200,
        body: JSON.stringify({
          members: [
            { id: "macbook", url: "http://100.72.96.53:3010", tools: ["/tool/nodes"], age_ms: 0 },
          ],
        }),
      });
      return atlasMembers("http://127.0.0.1:3010").pipe(
        Effect.map((members) => {
          assert.strictEqual(stub.captured[0]?.url, "http://127.0.0.1:3010/_members");
          assert.strictEqual(members.length, 1);
          assert.strictEqual(members[0]?.id, "macbook");
          assert.deepStrictEqual(members[0]?.tools, ["/tool/nodes"]);
        }),
        Effect.provide(stub.layer),
      );
    });

    it.effect("tolerates a member missing optional fields", () => {
      const stub = stubHttpClient({
        status: 200,
        body: JSON.stringify({ members: [{ id: "seraphim", url: "http://10.0.0.2:3010" }] }),
      });
      return atlasMembers("http://127.0.0.1:3010").pipe(
        Effect.map((members) => {
          assert.deepStrictEqual(members[0]?.tools, []);
          assert.strictEqual(members[0]?.age_ms, 0);
        }),
        Effect.provide(stub.layer),
      );
    });
  });

  describe("modelOptionsForMember", () => {
    /**
     * Captured verbatim from the live `macbook` node's `/_members` vitals, so
     * these assertions track the real wire shape rather than an invented one.
     */
    const liveMember = {
      id: "macbook",
      url: "http://100.72.96.53:3010",
      tools: [],
      age_ms: 0,
      vitals: {
        ollama: {
          loaded: ["nomic-embed-text:latest", "qwen2.5-coder:14b"],
          models: [
            {
              name: "nomic-embed-text:latest",
              family: "nomic-bert",
              params: "137M",
              quant: "F16",
              size: 274302450,
              tools: false,
            },
            {
              name: "deepseek-coder:6.7b",
              family: "llama",
              params: "7B",
              quant: "Q4_0",
              size: 3827834503,
              tools: false,
            },
            {
              name: "qwen2.5-coder:14b",
              family: "qwen2",
              params: "14.8B",
              quant: "Q4_K_M",
              size: 8988124298,
              tools: true,
            },
            {
              name: "gpt-oss:120b-cloud",
              family: "gptoss",
              params: "117B",
              quant: "MXFP4",
              size: 0,
              tools: true,
              cloud: true,
            },
          ],
        },
      },
    } as unknown as AtlasMember;

    it("never offers an embedding model as a chat model", () => {
      const ids = modelOptionsForMember(liveMember).map((option) => option.id);
      assert.ok(!ids.includes("nomic-embed-text:latest"));
    });

    it("reports tool support truthfully per model", () => {
      const options = modelOptionsForMember(liveMember);
      const byId = new Map(options.map((option) => [option.id, option]));
      // The node says deepseek cannot tool-call and qwen can. Reporting both as
      // equals is exactly the lie this function exists to prevent.
      assert.strictEqual(byId.get("deepseek-coder:6.7b")?.supportsTools, false);
      assert.strictEqual(byId.get("qwen2.5-coder:14b")?.supportsTools, true);
    });

    it("marks which ollama models are already resident", () => {
      const byId = new Map(modelOptionsForMember(liveMember).map((o) => [o.id, o]));
      assert.strictEqual(byId.get("qwen2.5-coder:14b")?.loaded, true);
      assert.strictEqual(byId.get("deepseek-coder:6.7b")?.loaded, false);
    });

    it("takes the CLI-backed model from what the node declares", () => {
      // Not a hardcoded `claude`/`codex` pair. That id reached the CLI verbatim as
      // `claude --model claude`, which is not a valid model, and it was offered on
      // nodes with neither CLI installed.
      const withManifest = {
        ...liveMember,
        manifest: {
          schema_version: 1,
          machine: { label: "mb", hostname: "mb", os: "macos", arch: "arm64", roles: [] },
          runtime: { name: "atlas-host", version: "0.1.0" },
          bodies: [{ id: "triage", tools: [] }],
          execution: {
            default_body: "triage",
            default_model: "claude-opus-4-8",
            backend: null,
            workspace: null,
          },
        },
      };
      const options = modelOptionsForMember(withManifest);
      const cli = options.find((o) => o.source === "claude");
      assert.strictEqual(cli?.id, "claude-opus-4-8");
      assert.ok(!options.some((o) => o.id === "claude"), "the bare slug must be gone");
      assert.ok(!options.some((o) => o.id === "codex"));
    });

    it("offers no CLI route when the node declares no model", () => {
      // An empty picker beats one listing models that cannot run.
      const options = modelOptionsForMember(liveMember);
      assert.ok(options.every((o) => o.source === "ollama" || o.source === "ollama-cloud"));
    });

    it("carries params and quantization as user-visible detail", () => {
      const byId = new Map(modelOptionsForMember(liveMember).map((o) => [o.id, o]));
      assert.strictEqual(byId.get("qwen2.5-coder:14b")?.detail, "14.8B · Q4_K_M");
    });

    it("distinguishes a cloud model from a local one", () => {
      const byId = new Map(modelOptionsForMember(liveMember).map((o) => [o.id, o]));
      const cloud = byId.get("gpt-oss:120b-cloud");
      assert.strictEqual(cloud?.source, "ollama-cloud");
      // Nothing loads locally, so a cloud model is never a cold start.
      assert.strictEqual(cloud?.loaded, true);
      assert.strictEqual(cloud?.detail, "117B · cloud");
      assert.strictEqual(byId.get("qwen2.5-coder:14b")?.source, "ollama");
    });

    it("yields nothing for a node that reports neither ollama nor a manifest", () => {
      const bare = { id: "seraphim", url: "http://10.0.0.2:3010", tools: [], age_ms: 0 };
      const options = modelOptionsForMember(bare as unknown as AtlasMember);
      assert.deepStrictEqual(options, [], "silence is honest; a fabricated catalogue is not");
    });
  });
});

describe("a mixed-version fleet", () => {
  // Exactly the shape a rebuilt node broadcasts while its peers are still on an
  // older build: itself with a manifest, everyone else with an explicit null.
  const mixed = {
    members: [
      {
        id: "macbook",
        url: "http://127.0.0.1:3010",
        tools: ["/tool/nodes"],
        age_ms: 0,
        vitals: { ollama: { loaded: [], models: [] } },
        manifest: {
          schema_version: 1,
          machine: { label: "mb", hostname: "mb", os: "macos", arch: "arm64", roles: [] },
          runtime: { name: "atlas-host", version: "0.1.0" },
          bodies: [{ id: "triage", tools: [] }],
          execution: {
            default_body: "triage",
            default_model: "claude-opus-4-8",
            backend: null,
            workspace: null,
          },
        },
      },
      {
        id: "seraphim",
        url: "http://100.65.119.87:3010",
        tools: [],
        age_ms: 1142,
        vitals: null,
        manifest: null,
      },
      { id: "metatron", url: "http://100.117.113.5:3010", tools: [], age_ms: 900, manifest: null },
    ],
  };

  it("decodes when a peer reports null manifest and vitals", () => {
    // `Schema.optional` alone accepts absent-or-object but NOT null, so one stale
    // peer failed the decode of the ENTIRE member list — taking the whole provider
    // offline: installed:false, no models, no picker entry. Needs a MIXED fleet to
    // reproduce; all-old and all-new both decode cleanly, which is why it hid.
    const decoded = Schema.decodeUnknownSync(AtlasMembers)(mixed);
    assert.strictEqual(decoded.members.length, 3);
    assert.strictEqual(decoded.members[1]?.manifest ?? null, null);
    assert.strictEqual(decoded.members[2]?.vitals ?? null, null);
  });

  it("still reads the declared model off the node that does report one", () => {
    const decoded = Schema.decodeUnknownSync(AtlasMembers)(mixed);
    const self = decoded.members[0];
    assert.ok(self !== undefined);
    assert.deepStrictEqual(
      modelOptionsForMember(self).map((o) => o.id),
      ["claude-opus-4-8"],
    );
  });

  it("treats a null-manifest peer as declaring no bodies rather than throwing", () => {
    const decoded = Schema.decodeUnknownSync(AtlasMembers)(mixed);
    const stale = decoded.members[1];
    assert.ok(stale !== undefined);
    assert.deepStrictEqual(bodiesForMember(stale), []);
    assert.strictEqual(defaultBodyForMember(stale), undefined);
  });
});
