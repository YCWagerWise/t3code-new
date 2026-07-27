/**
 * AtlasDriver — one Atlas node as a provider instance.
 *
 * Every other driver in this directory resolves a binary, merges a process
 * environment and stands up a spawner. Atlas has none of that: an instance is a
 * URL and a body name. Availability is a property of the node, so the snapshot
 * asks the node (`/_members`) rather than probing this machine's PATH.
 *
 * One instance per node turns the Providers page into a fleet console — the
 * `plugin` field is the one-lens-many-bodies selector, so the same driver is a
 * coding workspace against `coder` and a cluster console against `k8s-agent`.
 *
 * @module provider/Drivers/AtlasDriver
 */
import { AtlasSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { makeAtlasTextGeneration } from "../../textGeneration/AtlasTextGeneration.ts";
import { makeAtlasAdapter } from "../Layers/AtlasAdapter.ts";
import { checkAtlasProviderStatus } from "../Layers/AtlasProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";

const decodeAtlasSettings = Schema.decodeSync(AtlasSettings);

const DRIVER_KIND = ProviderDriverKind.make("atlas");

export type AtlasDriverEnv = Crypto.Crypto | HttpClient.HttpClient;

export const AtlasDriver: ProviderDriver<AtlasSettings, AtlasDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Atlas",
    // One instance per fleet node.
    supportsMultipleInstances: true,
  },
  configSchema: AtlasSettings,
  defaultConfig: (): AtlasSettings => decodeAtlasSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies AtlasSettings;

      const adapter = yield* makeAtlasAdapter(effectiveConfig, { instanceId });
      const textGeneration = yield* makeAtlasTextGeneration(effectiveConfig);

      // No managed refresh loop and no update machinery: there is no local
      // binary to version or upgrade. The node is asked when the snapshot is
      // read, and a node that does not answer reports `error` rather than
      // empty-but-healthy.
      const snapshotNow: Effect.Effect<ServerProvider> = Effect.gen(function* () {
        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        const snapshot = yield* checkAtlasProviderStatus({
          instanceId,
          displayName,
          accentColor,
          config: effectiveConfig,
          enabled,
          checkedAt,
        });
        // Groups threads that may continue against this instance. Every other
        // driver stamps it; without it a thread cannot be resumed on the same node.
        return {
          ...snapshot,
          continuation: { groupKey: continuationIdentity.continuationKey },
        } satisfies ServerProvider;
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const initial = yield* snapshotNow;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Effect.succeed(initial),
          // Re-asks the node rather than replaying a cached answer: an Atlas
          // instance's health is the node's health, and that changes.
          refresh: snapshotNow,
          streamChanges: Stream.empty,
        },
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
