import { useAtomValue } from "@effect/atom-react";
import { ATLAS_PROVIDER_DRIVER_KIND } from "@t3tools/contracts";
import { useCallback } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  primaryServerConfigAtom,
  primaryServerProvidersAtom,
  serverEnvironment,
} from "../../state/server";
import {
  deriveAtlasDiagnosticsViewState,
  handshakeGrantsDiagnosticsRead,
} from "./AtlasDiagnostics.logic";
import { AtlasDiagnosticsView } from "./AtlasDiagnosticsView";

/**
 * Thin, hook-consuming wrapper: wires the capability flag, the configured Atlas provider
 * instance, and the two proxied HTTP reads (handshake, then — once it grants
 * `diagnostics.read` — the snapshot), and hands a plain state to `AtlasDiagnosticsView`. All
 * rendering decisions live there and in `AtlasDiagnostics.logic.ts`; this component stays thin
 * and is not tested directly (see those two for coverage).
 */
export function AtlasDiagnosticsPanel() {
  const config = useAtomValue(primaryServerConfigAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const serverSupportsProxy = config?.atlasDiagnosticsProxySupported === true;
  const atlasInstanceId =
    providers?.find((provider) => provider.driver === ATLAS_PROVIDER_DRIVER_KIND)?.instanceId ??
    null;

  const handshakeQuery = useEnvironmentQuery(
    environmentId === null || atlasInstanceId === null || !serverSupportsProxy
      ? null
      : serverEnvironment.atlasDiagnosticsHttp({
          environmentId,
          input: { providerInstanceId: atlasInstanceId, route: "handshake" },
        }),
  );
  const canFetchSnapshot = handshakeGrantsDiagnosticsRead(handshakeQuery.data);
  const diagnosticsQuery = useEnvironmentQuery(
    !canFetchSnapshot || environmentId === null || atlasInstanceId === null
      ? null
      : serverEnvironment.atlasDiagnosticsHttp({
          environmentId,
          input: { providerInstanceId: atlasInstanceId, route: "diagnostics" },
        }),
  );

  const state = deriveAtlasDiagnosticsViewState({
    serverSupportsProxy,
    atlasInstanceId,
    handshake: handshakeQuery,
    diagnostics: diagnosticsQuery,
  });

  const handshakeRefresh = handshakeQuery.refresh;
  const diagnosticsRefresh = diagnosticsQuery.refresh;
  const onRetry = useCallback(() => {
    handshakeRefresh();
    diagnosticsRefresh();
  }, [diagnosticsRefresh, handshakeRefresh]);

  return (
    <AtlasDiagnosticsView
      state={state}
      isRefreshing={handshakeQuery.isPending || diagnosticsQuery.isPending}
      onRetry={onRetry}
    />
  );
}
