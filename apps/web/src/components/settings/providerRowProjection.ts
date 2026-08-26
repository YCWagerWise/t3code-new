import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * Provider rows the SERVER knows about that settings has never heard of.
 *
 * The Providers panel builds its rows from persisted state: an explicit `providerInstances`
 * entry, or a legacy `settings.providers` mirror. A driver the runtime bootstraps for itself —
 * one that spawns nothing and whose default config is already usable — has neither, so it was
 * registered, probeable, and completely invisible in Settings while the composer reported "No
 * provider available" and the server held a live instance of it.
 *
 * These rows are read-only projections of runtime state. They are NOT written anywhere by
 * being displayed; the panel's normal edit path promotes one into a real `providerInstances`
 * entry the first time a user changes it, after which the persisted branches own it. That
 * ordering matters: opening a settings page must not mutate settings.
 */
export interface ProjectedProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
}

export interface ServerProviderLike {
  readonly instanceId: ProviderInstanceId;
  readonly driver?: ProviderDriverKind | undefined;
}

export const projectServerOnlyProviderRows = (input: {
  /** Instance ids already rendered from persisted settings. */
  readonly renderedInstanceIds: ReadonlySet<string>;
  /** What the server reports it actually has. */
  readonly serverProviders: ReadonlyArray<ServerProviderLike>;
  /** Ids that occupy a driver's default slot. */
  readonly defaultSlotIds: ReadonlySet<string>;
  readonly defaultInstanceIdForDriver: (driver: ProviderDriverKind) => ProviderInstanceId;
}): ReadonlyArray<ProjectedProviderRow> => {
  const seen = new Set(input.renderedInstanceIds);
  const rows: ProjectedProviderRow[] = [];
  for (const provider of input.serverProviders) {
    const id = String(provider.instanceId);
    if (seen.has(id)) continue;
    const driver = provider.driver;
    if (driver === undefined) continue;
    rows.push({
      instanceId: provider.instanceId,
      // Synthesized, never persisted: the envelope a later write starts from.
      instance: { driver, config: {} } as ProviderInstanceConfig,
      driver,
      isDefault:
        input.defaultSlotIds.has(id) || id === String(input.defaultInstanceIdForDriver(driver)),
    });
    seen.add(id);
  }
  return rows;
};
