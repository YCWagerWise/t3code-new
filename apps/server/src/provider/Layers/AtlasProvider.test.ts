import { assert, describe, it } from "@effect/vitest";

import type { AtlasMember } from "./AtlasClient.ts";
import { modelsForMember } from "./AtlasProvider.ts";

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

  it("leads with the CLI-backed routes", () => {
    const slugs = modelsForMember(member).map((m) => m.slug);
    assert.deepStrictEqual(slugs.slice(0, 2), ["claude", "codex"]);
  });

  it("tags routing origin via subProvider so cloud and local do not blur", () => {
    const bySlug = new Map(modelsForMember(member).map((m) => [m.slug, m]));
    assert.strictEqual(bySlug.get("gpt-oss:120b-cloud")?.subProvider, "ollama-cloud");
    assert.strictEqual(bySlug.get("qwen2.5-coder:14b")?.subProvider, "ollama");
    assert.strictEqual(bySlug.get("claude")?.subProvider, "claude");
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
