/**
 * Pure state derivation for the Atlas diagnostics panel — see `AtlasDiagnostics.tsx`.
 *
 * Atlas (`atlas-rs-switch`) is the sole authority for fleet/node/run/provider/process
 * diagnostics; this T3 server is a CONSTRAINED TRANSPORT PROXY over it (see
 * `packages/contracts/src/atlasDiagnosticsProxy.ts`), and this module decides which of six
 * first-class states the browser renders. It deliberately does NOT re-model Atlas's
 * `DiagnosticsSnapshot`/handshake bodies into typed T3 structures — `bodyText` is passed
 * through from the proxy and read here defensively, field by field, straight off
 * `atlas-protocol`'s own (snake_case) wire shape
 * (`crates/atlas-protocol/schema/atlas-protocol.flat.json` in `atlas-rs-switch`, read-only to
 * this repo). A field this build does not recognise is simply absent from the summary rather
 * than failing the render — the same tolerance Atlas's own `vitals`/`manifest` fields ask of
 * every reader.
 */

const DIAGNOSTICS_READ_CAPABILITY = "diagnostics.read";

export interface AtlasDiagnosticsRpcState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

export interface AtlasDiagnosticsHttpResponse {
  readonly status: number;
  readonly bodyText: string;
}

/**
 * The six first-class states. Every branch other than `connected` carries an honest, specific
 * message — none of Atlas's or the proxy's real answers collapse into a generic "error".
 */
export type AtlasDiagnosticsViewState =
  // This T3 server does not implement the Atlas diagnostics proxy at all — a capability the
  // client checks BEFORE calling the RPC, never inferred from a failed call.
  | { readonly kind: "unsupported" }
  | { readonly kind: "not-configured" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "connected";
      readonly handshakeBodyText: string;
      readonly diagnosticsBodyText: string;
    }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "unauthorized"; readonly message: string }
  | { readonly kind: "diagnostics-disabled"; readonly message: string }
  | { readonly kind: "credential-refused-insecure"; readonly message: string };

/**
 * `AtlasProxyCredentialInsecureError`'s message is distinctive and stable (see
 * `atlasDiagnosticsProxy.ts`). Matching on it is the same idiom this settings page already uses
 * for `isStaleProcessSignalMessage` — the RPC client flattens a tagged error to a message
 * string, so a specific, load-bearing substring is how a specific proxy fault is told apart
 * from a generic one without widening the shared `useEnvironmentQuery` error channel for every
 * caller.
 */
function isCredentialInsecureMessage(message: string): boolean {
  return message.includes("is not marked sensitive");
}

/**
 * "T3 has no saved instance" is a CONFIGURATION state, not a reachability one. Left in the
 * default `unreachable` bucket it accused the Atlas node of being down when the node was
 * healthy and T3 simply had nothing saved — the first operator to see it read the banner as
 * Atlas failing.
 */
function isUnknownInstanceMessage(message: string): boolean {
  return message.includes("has no saved provider instance");
}

function parseJsonRecord(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseHandshakeCapabilities(bodyText: string): ReadonlyArray<string> | null {
  const record = parseJsonRecord(bodyText);
  if (record === null) return null;
  const capabilities = record["capabilities"];
  if (!Array.isArray(capabilities)) return null;
  return capabilities.filter((capability): capability is string => typeof capability === "string");
}

/** Whether a handshake response grants `diagnostics.read` — the gate on fetching the snapshot. */
export function handshakeGrantsDiagnosticsRead(
  handshake: AtlasDiagnosticsHttpResponse | null,
): boolean {
  if (handshake === null) return false;
  if (handshake.status < 200 || handshake.status >= 300) return false;
  const capabilities = parseHandshakeCapabilities(handshake.bodyText);
  return capabilities !== null && capabilities.includes(DIAGNOSTICS_READ_CAPABILITY);
}

function classifyProxyFailure(message: string): AtlasDiagnosticsViewState {
  if (isUnknownInstanceMessage(message)) return { kind: "not-configured" };
  return isCredentialInsecureMessage(message)
    ? { kind: "credential-refused-insecure", message }
    : { kind: "unreachable", message };
}

function classifyHttpResponse(
  response: AtlasDiagnosticsHttpResponse,
  context: string,
  onOk: () => AtlasDiagnosticsViewState,
): AtlasDiagnosticsViewState {
  if (response.status === 401 || response.status === 403) {
    return {
      kind: "unauthorized",
      message: `atlas-host refused the access token (${response.status}) on ${context}.`,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      kind: "unreachable",
      message: `atlas-host answered ${response.status} on ${context}.`,
    };
  }
  return onOk();
}

export function deriveAtlasDiagnosticsViewState(input: {
  readonly serverSupportsProxy: boolean;
  readonly atlasInstanceId: string | null;
  readonly handshake: AtlasDiagnosticsRpcState<AtlasDiagnosticsHttpResponse>;
  readonly diagnostics: AtlasDiagnosticsRpcState<AtlasDiagnosticsHttpResponse>;
}): AtlasDiagnosticsViewState {
  if (!input.serverSupportsProxy) return { kind: "unsupported" };
  if (input.atlasInstanceId === null) return { kind: "not-configured" };

  if (input.handshake.error !== null) return classifyProxyFailure(input.handshake.error);
  const handshake = input.handshake.data;
  if (handshake === null) return { kind: "loading" };

  return classifyHttpResponse(handshake, "the diagnostics handshake", () => {
    const capabilities = parseHandshakeCapabilities(handshake.bodyText);
    if (capabilities === null) {
      return {
        kind: "unreachable",
        message: "atlas-host answered 200 but not with a valid diagnostics handshake.",
      };
    }
    if (!capabilities.includes(DIAGNOSTICS_READ_CAPABILITY)) {
      return {
        kind: "diagnostics-disabled",
        message:
          "This Atlas node has not enabled its diagnostics surface " +
          "(ATLAS_DIAGNOSTICS is unset on that node).",
      };
    }

    if (input.diagnostics.error !== null) return classifyProxyFailure(input.diagnostics.error);
    const diagnostics = input.diagnostics.data;
    if (diagnostics === null) return { kind: "loading" };

    return classifyHttpResponse(diagnostics, "the diagnostics snapshot", () => ({
      kind: "connected",
      handshakeBodyText: handshake.bodyText,
      diagnosticsBodyText: diagnostics.bodyText,
    }));
  });
}

// --- Honest, minimal reads off Atlas's own wire shape ----------------------------------------

export interface AtlasDiagnosticsSnapshotSummary {
  readonly nodeId: string | null;
  readonly protocolVersion: number | null;
  readonly fleetSelfId: string | null;
  readonly fleetMemberCount: number | null;
  readonly providerCount: number | null;
  readonly availableProviderCount: number | null;
  readonly runTotal: number | null;
  readonly inflightCount: number | null;
}

const EMPTY_SNAPSHOT_SUMMARY: AtlasDiagnosticsSnapshotSummary = {
  nodeId: null,
  protocolVersion: null,
  fleetSelfId: null,
  fleetMemberCount: null,
  providerCount: null,
  availableProviderCount: null,
  runTotal: null,
  inflightCount: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): ReadonlyArray<unknown> | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Reads exactly the fields the panel renders — `protocol_version`, `node_id`,
 * `fleet.{self_id,members}`, `providers`, `runs.total`, `inflight` — off
 * `atlas-protocol::diagnostics::DiagnosticsSnapshot`'s wire JSON. Never throws: a body that
 * does not match becomes an all-`null` summary, not a crashed render.
 */
export function summarizeAtlasDiagnosticsSnapshot(
  bodyText: string,
): AtlasDiagnosticsSnapshotSummary {
  const record = parseJsonRecord(bodyText);
  if (record === null) return EMPTY_SNAPSHOT_SUMMARY;

  const fleet = asRecord(record["fleet"]);
  const members = fleet === null ? null : asArray(fleet["members"]);
  const providers = asArray(record["providers"]);
  const runs = asRecord(record["runs"]);
  const inflight = asArray(record["inflight"]);

  return {
    nodeId: typeof record["node_id"] === "string" ? record["node_id"] : null,
    protocolVersion:
      typeof record["protocol_version"] === "number" ? record["protocol_version"] : null,
    fleetSelfId: fleet !== null && typeof fleet["self_id"] === "string" ? fleet["self_id"] : null,
    fleetMemberCount: members?.length ?? null,
    providerCount: providers?.length ?? null,
    availableProviderCount:
      providers === null
        ? null
        : providers.filter((entry) => asRecord(entry)?.["available"] === true).length,
    runTotal: typeof runs?.["total"] === "number" ? runs["total"] : null,
    inflightCount: inflight?.length ?? null,
  };
}
