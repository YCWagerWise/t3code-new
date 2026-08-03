import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as AtlasSession from "../rpc/atlas/session.ts";
import * as RpcSession from "../rpc/session.ts";

/**
 * The transport swap (doc 15 §3.1). Both factories provide the SAME service tag; which
 * one an app speaks is this single Layer choice. Flag-gated so the Effect-RPC path stays
 * one flip away during the cutover: set `VITE_ATLAS_TRANSPORT=1` (web build) or
 * `globalThis.__ATLAS_TRANSPORT__ = true` (tests/manual) to point the lens at Atlas.
 */
const atlasTransportEnabled = (): boolean => {
  const flagged = (globalThis as { __ATLAS_TRANSPORT__?: boolean }).__ATLAS_TRANSPORT__;
  if (flagged !== undefined) {
    return flagged;
  }
  try {
    return (
      (import.meta as { env?: { VITE_ATLAS_TRANSPORT?: string } }).env?.VITE_ATLAS_TRANSPORT === "1"
    );
  } catch {
    return false;
  }
};
const sessionFactoryLayer = atlasTransportEnabled() ? AtlasSession.layer : RpcSession.layer;

const resolverLayer = ConnectionResolver.layer.pipe(
  Layer.provide(RemoteEnvironmentAuthorization.layer),
);

const driverLayer = ConnectionDriver.layer.pipe(
  Layer.provide(Layer.mergeAll(resolverLayer, sessionFactoryLayer)),
);

const registryLayer = EnvironmentRegistry.layer.pipe(Layer.provide(driverLayer));

const onboardingLayer = ConnectionOnboarding.layer.pipe(Layer.provide(registryLayer));

const connectionServicesLayer = Layer.mergeAll(
  registryLayer,
  RelayEnvironmentDiscovery.layer,
  onboardingLayer,
);

const connectionStartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
    yield* registry.start;
    yield* platformSource.registrations.pipe(
      Stream.runForEach(registry.reconcilePlatform),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
);

export const layer = connectionStartupLayer.pipe(Layer.provideMerge(connectionServicesLayer));
