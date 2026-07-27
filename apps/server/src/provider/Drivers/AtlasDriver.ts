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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

/** How often the fleet view re-checks a node without anyone asking. */
const SNAPSHOT_REFRESH_INTERVAL = Duration.seconds(30);

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
          // Re-asks the node on every read rather than replaying the boot-time
          // answer. An Atlas instance's health IS the node's health, and freezing
          // it at construction meant a node that was unreachable (or whose members
          // failed to decode) stayed `status: error` for the life of the process —
          // so the provider never became selectable again even after the cause was
          // fixed. One GET to /_members is cheap next to being permanently wrong.
          getSnapshot: snapshotNow,
          refresh: snapshotNow,
          // And push, so the UI recovers on its own instead of waiting for
          // something to call refresh. A node coming back is the common case.
          streamChanges: Stream.fromEffectSchedule(
            snapshotNow,
            Schedule.spaced(SNAPSHOT_REFRESH_INTERVAL),
          ),
        },
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
