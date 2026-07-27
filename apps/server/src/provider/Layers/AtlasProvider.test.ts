import { assert, describe, it } from "@effect/vitest";

import type { AtlasMember } from "./AtlasClient.ts";
import { modelsForMember, selfMember } from "./AtlasProvider.ts";

/** Captured from the live `macbook` node, including its cloud entries. */
const member = {
  id: "macbook",
  url: "http://100.72.96.53:3010",
  tools: ["/tool/nodes"],
  age_ms: 0,
  vitals: {
    ollama: {
      loaded: ["qwen2.5-coder:14b"],
      models: [
        { name: "nomic-embed-text:latest", family: "nomic-bert", tools: false },
        { name: "deepseek-coder:6.7b", family: "llama", params: "7B", tools: false },
        { name: "qwen2.5-coder:14b", family: "qwen2", params: "14.8B", tools: true },
        { name: "gpt-oss:120b-cloud", family: "gptoss", params: "117B", tools: true, cloud: true },
      ],
    },
  },
} as unknown as AtlasMember;

describe("modelsForMember", () => {
  it("puts tool-capable models ahead of ones that cannot tool-call", () => {
    const models = modelsForMember(member);
    const deepseekIndex = models.findIndex((m) => m.slug === "deepseek-coder:6.7b");
    // deepseek reports tools:false, so it must not outrank anything tool-capable.
    assert.strictEqual(deepseekIndex, models.length - 1);
  });

  it("never offers an embedding model", () => {
    const slugs = modelsForMember(member).map((m) => m.slug);
    assert.ok(!slugs.includes("nomic-embed-text:latest"));
  });

  it("shortens a tagged id for compact display", () => {
    const bySlug = new Map(modelsForMember(member).map((m) => [m.slug, m]));
    assert.strictEqual(bySlug.get("qwen2.5-coder:14b")?.shortName, "qwen2.5-coder");
  });
});

describe("modelsForMember ordering", () => {
  const withCli = {
    ...member,
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
  } as unknown as AtlasMember;

  it("leads with the node's declared model, not a hardcoded slug", () => {
    const models = modelsForMember(withCli);
    assert.strictEqual(models[0]?.slug, "claude-opus-4-8");
  });

  it("sinks models that cannot tool-call rather than hiding them", () => {
    // A user may still want one for a plain prompt, but it must not outrank a
    // model that can drive a tool-enabled body.
    const slugs = modelsForMember(withCli).map((m) => m.slug);
    const cannotToolCall = slugs.indexOf("deepseek-coder:6.7b");
    const canToolCall = slugs.indexOf("qwen2.5-coder:14b");
    assert.ok(cannotToolCall > canToolCall, `expected ${slugs} to rank the tool-capable one first`);
  });

  it("keeps cloud and local routing origins distinct", () => {
    const byId = new Map(modelsForMember(withCli).map((m) => [m.slug, m]));
    assert.strictEqual(byId.get("gpt-oss:120b-cloud")?.subProvider, "ollama-cloud");
    assert.strictEqual(byId.get("qwen2.5-coder:14b")?.subProvider, "ollama");
    assert.strictEqual(byId.get("claude-opus-4-8")?.subProvider, "claude");
  });
});

describe("selfMember", () => {
  const ring = [
    { id: "seraphim", url: "http://100.65.119.87:3010", age_ms: 1142 },
    { id: "macbook", url: "http://100.72.96.53:3010", age_ms: 0 },
  ] as unknown as ReadonlyArray<AtlasMember>;

  it("trusts the node's own claim over any URL guess", () => {
    // `members_json` stamps age_ms 0 on self and a real age on gossiped peers,
    // so this is a declaration. It holds even when the console addressed the node
    // by loopback and the node advertises a tailnet address.
    assert.strictEqual(selfMember(ring, "http://127.0.0.1:3010")?.id, "macbook");
    assert.strictEqual(selfMember(ring, "http://anything.invalid:1")?.id, "macbook");
  });

  it("falls back to the advertised authority when no node claims itself", () => {
    const ageless = ring.map((m) => ({ ...m, age_ms: 5 })) as unknown as ReadonlyArray<AtlasMember>;
    assert.strictEqual(selfMember(ageless, "http://100.65.119.87:3010/")?.id, "seraphim");
  });

  it("refuses to choose when two members both claim to be self", () => {
    // A ring that disagrees about who is local is a real condition, and guessing
    // between them is how you end up reporting the wrong box's model catalogue.
    const confused = ring.map((m) => ({
      ...m,
      age_ms: 0,
    })) as unknown as ReadonlyArray<AtlasMember>;
    assert.strictEqual(selfMember(confused, "http://example.invalid:9999"), undefined);
  });

  it("returns undefined rather than guessing when nothing matches", () => {
    const ageless = ring.map((m) => ({ ...m, age_ms: 5 })) as unknown as ReadonlyArray<AtlasMember>;
    assert.strictEqual(selfMember(ageless, "http://example.invalid:9999"), undefined);
    assert.strictEqual(selfMember(ageless, "not a url"), undefined);
  });
});
