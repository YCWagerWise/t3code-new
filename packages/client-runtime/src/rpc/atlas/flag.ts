/**
 * The one place that answers "is this lens speaking Atlas?" — read by the transport Layer
 * choice (connection/layer.ts) and by the resolver's authorization branch, which must
 * agree or an environment authorizes one way and connects another.
 */
export const atlasTransportEnabled = (): boolean => {
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
