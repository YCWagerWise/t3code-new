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

/**
 * The dev credential for an Atlas primary environment. In a browser the primary bearer
 * token normally comes from the desktop bridge (absent on web), so without this an Atlas
 * node gets no credential and refuses every call. Dev/demo only — a real deployment issues
 * a JWT through the node's own auth.
 */
export const atlasDevToken = (): string | null => {
  const injected = (globalThis as { __ATLAS_TOKEN__?: string }).__ATLAS_TOKEN__;
  if (typeof injected === "string" && injected !== "") {
    return injected;
  }
  try {
    const fromEnv = (import.meta as { env?: { VITE_ATLAS_TOKEN?: string } }).env?.VITE_ATLAS_TOKEN;
    return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
  } catch {
    return null;
  }
};
