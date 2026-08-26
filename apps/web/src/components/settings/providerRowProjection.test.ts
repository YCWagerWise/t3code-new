import { describe, expect, it } from "vite-plus/test";

import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import { projectServerOnlyProviderRows } from "./providerRowProjection";

const defaultInstanceIdForDriver = (driver: string) => driver as never;

describe("a provider the server has but settings does not", () => {
  const serverProviders = [{ instanceId: "atlas" as never, driver: "atlas" as never }];

  /**
   * The regression this guards.
   *
   * Rows were built only from persisted settings, so a runtime-bootstrapped driver was
   * registered, probeable and invisible — Settings showed nothing and the composer said "No
   * provider available" while the server held a live instance.
   */
  it("still gets a row when nothing about it is persisted", () => {
    const rows = projectServerOnlyProviderRows({
      renderedInstanceIds: new Set(["codex", "claudeAgent", "opencode", "grok"]),
      serverProviders,
      defaultSlotIds: new Set(["codex", "claudeAgent", "opencode"]),
      defaultInstanceIdForDriver,
    });

    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.instanceId)).toEqual("atlas");
    expect(String(rows[0]?.driver)).toEqual("atlas");
    // It occupies the driver's default slot, so it renders as the default row rather than as
    // an anonymous extra instance.
    expect(rows[0]?.isDefault).toBe(true);
    // Synthesized, carrying no configuration of its own.
    expect(rows[0]?.instance.config).toEqual({});
  });

  it("does not duplicate a provider settings already renders", () => {
    // Once promoted, the persisted branches own the row; projecting it again would show the
    // same provider twice, with the stale synthesized copy able to overwrite real config.
    const rows = projectServerOnlyProviderRows({
      renderedInstanceIds: new Set(["atlas"]),
      serverProviders,
      defaultSlotIds: new Set(),
      defaultInstanceIdForDriver,
    });
    expect(rows).toEqual([]);
  });

  it("skips a server entry with no driver rather than inventing one", () => {
    const rows = projectServerOnlyProviderRows({
      renderedInstanceIds: new Set(),
      serverProviders: [{ instanceId: "mystery" as never, driver: undefined }],
      defaultSlotIds: new Set(),
      defaultInstanceIdForDriver,
    });
    expect(rows).toEqual([]);
  });

  it("promotes into persisted providerInstances when the user edits it", () => {
    const [row] = projectServerOnlyProviderRows({
      renderedInstanceIds: new Set(),
      serverProviders,
      defaultSlotIds: new Set(),
      defaultInstanceIdForDriver,
    });
    expect(row).toBeDefined();

    const settings = { providerInstances: {}, providers: {} } as never;
    const patch = buildProviderInstanceUpdatePatch({
      settings,
      instanceId: row!.instanceId,
      instance: {
        ...row!.instance,
        config: { baseUrl: "http://127.0.0.1:3019" },
      } as never,
      driver: row!.driver,
      isDefault: row!.isDefault,
    } as never);

    // Editing a projected row writes a REAL entry — the row stops being runtime-only and the
    // persisted branches own it from then on.
    const written = (patch as unknown as { providerInstances?: Record<string, unknown> })
      .providerInstances;
    expect(written).toBeDefined();
    expect(Object.keys(written ?? {})).toContain("atlas");
    // And the node URL the user typed is what got persisted.
    expect(JSON.stringify(written)).toContain("http://127.0.0.1:3019");
    // Nothing token-shaped is persisted by this path; auth lives in the sensitive environment.
    expect(JSON.stringify(written)).not.toContain("accessToken");
  });
});
