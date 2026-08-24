import {
  MODEL_CATALOG_BY_PROVIDER,
  modelCatalogGaps,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeDriver } from "./ClaudeDriver.ts";
import { CodexDriver } from "./CodexDriver.ts";

/**
 * PROOF (#221): the AgentSDK drivers and the contracts registry are ONE model
 * seam.
 *
 * Two registries drift. The drivers used to advertise three hard-coded rows
 * each while the contracts registry named defaults, preferred models and alias
 * targets that were never advertised — so a stored selection pointing at one of
 * them became silently unroutable while the picker showed a different list.
 */
describe("model catalog", () => {
  it("names every slug the rest of the registry refers to", () => {
    for (const kind of ["codex", "claudeAgent", "opencode"] as const) {
      const provider = ProviderDriverKind.make(kind);
      expect(modelCatalogGaps(provider), `${kind} registry names unlisted slugs`).toEqual([]);
    }
  });

  it("advertises the shared catalog from the drivers themselves", () => {
    const codexSlugs = new Set(CodexDriver.definition.models.map((m) => m.slug));
    for (const entry of MODEL_CATALOG_BY_PROVIDER[ProviderDriverKind.make("codex")] ?? []) {
      expect(codexSlugs.has(entry.slug), `codex driver is missing ${entry.slug}`).toBe(true);
    }
    const claudeSlugs = new Set(ClaudeDriver.definition.models.map((m) => m.slug));
    for (const entry of MODEL_CATALOG_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")] ?? []) {
      expect(claudeSlugs.has(entry.slug), `claude driver is missing ${entry.slug}`).toBe(true);
    }
  });

  it("keeps each driver's default among the models it advertises", () => {
    for (const driver of [CodexDriver, ClaudeDriver]) {
      const slugs = driver.definition.models.map((m) => m.slug);
      expect(slugs, `${driver.definition.driverKind} default is not advertised`).toContain(
        driver.definition.defaultModelSlug,
      );
    }
  });
});
