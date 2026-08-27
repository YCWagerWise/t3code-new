/**
 * Atlas diagnostics proxy — a CONSTRAINED TRANSPORT, not a re-modeled RPC.
 *
 * Atlas (`atlas-rs-switch`) is the sole authority for fleet/node/run/provider/process
 * diagnostics; T3 is a lens. This module intentionally does NOT re-encode
 * `atlas-protocol`'s `DiagnosticsSnapshot`/`DiagnosticsHistoryPage`/`DiagnosticsCommand` shapes
 * as a parallel Effect Schema — doing that would make T3 a second place those types have to be
 * kept in sync, exactly the drift `atlas-protocol/src/diagnostics.rs`'s own module doc warns
 * against. Instead:
 *
 *   - HTTP: `server.callAtlasDiagnosticsHttp` proxies an ALLOWLIST of three Atlas routes
 *     (`handshake`, `diagnostics`, `diagnosticsHistory`) and returns the upstream status and
 *     body VERBATIM. A 401, a `diagnostics.read` capability absent from the handshake body, and
 *     the history endpoint's 409 `CURSOR_EPOCH_INVALID` all arrive as ordinary successful proxy
 *     calls — Atlas's own answer, unflattened. Only a T3-side proxy fault (unknown instance,
 *     wrong driver, an insecurely-stored credential, or a transport failure reaching the node)
 *     takes the `error` arm; see `AtlasDiagnosticsProxyError`.
 *   - Live: `server.openAtlasDiagnosticsFeed` opens Atlas's `/_feed?run_id=__diagnostics__`
 *     socket with the server-held credential and relays TEXT frames verbatim, both directions
 *     (`server.sendAtlasDiagnosticsCommand` is the browser->Atlas half). Neither RPC parses a
 *     frame's contents, tracks a cursor, or owns retry policy — the browser already speaks
 *     Atlas's wire format (it renders the same protocol against the same node) and keeps that
 *     authority for itself.
 *
 * The caller addresses a configured T3 `ProviderInstanceId`, never a URL: the stored `baseUrl`
 * and the `ATLAS_ACCESS_TOKEN` environment entry are resolved server-side, through the same
 * trusted seam `AtlasDriver.ts` already uses to build a turn-driving session. A browser can
 * never name an origin, a path outside the three above, or see the token — see
 * `apps/server/src/diagnostics/AtlasDiagnosticsProxy.ts`.
 *
 * @module atlasDiagnosticsProxy
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * The Atlas driver's kind slug. Shared by the server (which resolves a provider instance's
 * credential by it — see `AtlasDriver.ts`) and the web client (which locates the configured
 * Atlas instance to address). Defined once here rather than independently in both places.
 */
export const ATLAS_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("atlas");

// --- HTTP proxy -------------------------------------------------------------------------------

/**
 * The ONLY Atlas HTTP routes this proxy will ever call. A closed enum, not a caller-supplied
 * path: this is what makes "arbitrary URL/path attempt" categorically unrepresentable rather
 * than merely rejected at runtime.
 */
export const AtlasDiagnosticsHttpRoute = Schema.Literals([
  "handshake",
  "diagnostics",
  "diagnosticsHistory",
]);
export type AtlasDiagnosticsHttpRoute = typeof AtlasDiagnosticsHttpRoute.Type;

/** Mirrors `GET /diagnostics/history?epoch=&after=&limit=`'s params. Atlas clamps `limit`. */
export const AtlasDiagnosticsHistoryQuery = Schema.Struct({
  epoch: Schema.optional(NonNegativeInt),
  after: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
});
export type AtlasDiagnosticsHistoryQuery = typeof AtlasDiagnosticsHistoryQuery.Type;

export const AtlasDiagnosticsHttpInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  route: AtlasDiagnosticsHttpRoute,
  /** Only meaningful (and only sent upstream) when `route === "diagnosticsHistory"`. */
  history: Schema.optional(AtlasDiagnosticsHistoryQuery),
});
export type AtlasDiagnosticsHttpInput = typeof AtlasDiagnosticsHttpInput.Type;

/**
 * The upstream's answer, passed through untouched. `status` and `bodyText` are exactly what
 * atlas-host sent — the browser decodes `bodyText` against `atlas-protocol`'s own schema.
 * Bounded server-side to a fixed byte ceiling; a response over that ceiling is a PROXY fault
 * (`AtlasProxyUpstreamTooLargeError`), not a truncated success.
 */
export const AtlasDiagnosticsHttpResult = Schema.Struct({
  status: Schema.Int,
  bodyText: Schema.String,
});
export type AtlasDiagnosticsHttpResult = typeof AtlasDiagnosticsHttpResult.Type;

// --- Proxy-side faults --------------------------------------------------------------------
//
// Every one of these is about the PROXY, never about what Atlas answered — Atlas's own
// refusals (401, a disabled diagnostics surface, a stale cursor) always ride the success arm
// above so the browser can render them as first-class, honest states instead of a T3 error.

export class AtlasProxyUnknownProviderInstanceError extends Schema.TaggedErrorClass<AtlasProxyUnknownProviderInstanceError>()(
  "AtlasProxyUnknownProviderInstanceError",
  { providerInstanceId: TrimmedNonEmptyString },
) {
  override get message(): string {
    // Names T3 explicitly. "this server" was read as ATLAS by the first operator to hit it,
    // which is the opposite of what it means — the Atlas node is fine, T3 has nothing saved.
    return (
      `T3 has no saved provider instance "${this.providerInstanceId}". ` +
      "Add it under Settings / Providers."
    );
  }
}

export class AtlasProxyNotAtlasDriverError extends Schema.TaggedErrorClass<AtlasProxyNotAtlasDriverError>()(
  "AtlasProxyNotAtlasDriverError",
  { providerInstanceId: TrimmedNonEmptyString, driver: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Provider instance "${this.providerInstanceId}" is a "${this.driver}" instance, not Atlas.`;
  }
}

export class AtlasProxyCredentialInsecureError extends Schema.TaggedErrorClass<AtlasProxyCredentialInsecureError>()(
  "AtlasProxyCredentialInsecureError",
  { providerInstanceId: TrimmedNonEmptyString },
) {
  override get message(): string {
    return (
      "The Atlas access token on this instance is not marked sensitive, so it would be stored " +
      "and sent to clients in clear text. It has NOT been used."
    );
  }
}

export class AtlasProxyUnreachableError extends Schema.TaggedErrorClass<AtlasProxyUnreachableError>()(
  "AtlasProxyUnreachableError",
  { providerInstanceId: TrimmedNonEmptyString, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `The Atlas node could not be reached: ${this.detail}`;
  }
}

export class AtlasProxyUpstreamTimeoutError extends Schema.TaggedErrorClass<AtlasProxyUpstreamTimeoutError>()(
  "AtlasProxyUpstreamTimeoutError",
  { providerInstanceId: TrimmedNonEmptyString },
) {
  override get message(): string {
    return "The Atlas node did not answer in time.";
  }
}

/**
 * The relay ended because it could not keep the browser in sync -- a frame past the byte
 * ceiling, or a consumer too slow to drain. It is an ERROR rather than a `closed` event on
 * purpose: a terminal event offered into a saturated queue can itself be refused, so the
 * browser would drain stale frames and stop with no explanation. Failing the stream cannot be
 * dropped by capacity.
 */
export class AtlasProxyRelayOverflowError extends Schema.TaggedErrorClass<AtlasProxyRelayOverflowError>()(
  "AtlasProxyRelayOverflowError",
  { providerInstanceId: TrimmedNonEmptyString, detail: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `The Atlas diagnostics relay ended: ${this.detail}`;
  }
}

export class AtlasProxyUpstreamTooLargeError extends Schema.TaggedErrorClass<AtlasProxyUpstreamTooLargeError>()(
  "AtlasProxyUpstreamTooLargeError",
  { providerInstanceId: TrimmedNonEmptyString, limitBytes: PositiveInt },
) {
  override get message(): string {
    return `The Atlas node's response exceeded the ${this.limitBytes}-byte proxy limit.`;
  }
}

export const AtlasDiagnosticsProxyError = Schema.Union([
  AtlasProxyRelayOverflowError,
  AtlasProxyUnknownProviderInstanceError,
  AtlasProxyNotAtlasDriverError,
  AtlasProxyCredentialInsecureError,
  AtlasProxyUnreachableError,
  AtlasProxyUpstreamTimeoutError,
  AtlasProxyUpstreamTooLargeError,
]);
export type AtlasDiagnosticsProxyError = typeof AtlasDiagnosticsProxyError.Type;

// --- Live relay ---------------------------------------------------------------------------

export const AtlasDiagnosticsFeedInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
});
export type AtlasDiagnosticsFeedInput = typeof AtlasDiagnosticsFeedInput.Type;

export const AtlasDiagnosticsRelaySessionId = TrimmedNonEmptyString.pipe(
  Schema.brand("AtlasDiagnosticsRelaySessionId"),
);
export type AtlasDiagnosticsRelaySessionId = typeof AtlasDiagnosticsRelaySessionId.Type;

/**
 * One relay event. `message.raw` is the exact TEXT frame atlas-host sent on `/_feed` —
 * `TransportFrame::Diagnostics` JSON, unparsed and unvalidated by this server. `closed` carries
 * the upstream close code/reason (or a proxy-synthesized one on a refused/failed connect)
 * verbatim, never rewritten into a generic "disconnected".
 */
export const AtlasDiagnosticsRelayEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("open"),
    relaySessionId: AtlasDiagnosticsRelaySessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    raw: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("closed"),
    code: Schema.Number,
    reason: Schema.String,
  }),
]);
export type AtlasDiagnosticsRelayEvent = typeof AtlasDiagnosticsRelayEvent.Type;

/**
 * The only commands this lens may send upstream.
 *
 * `raw: Schema.String` made the relay a generic authenticated write tunnel into Atlas's
 * `/_feed` for anyone holding orchestration-read — the diagnostics surface is supposed to
 * expose two commands, not arbitrary frames. Validating the shape here is AUTHORIZATION; it
 * does not take cursor policy away from the browser, which still chooses `after` and `epoch`.
 */
/**
 * A cursor Atlas can actually hold. Upstream these are `i64`, so `Schema.Number` was wrong in
 * both directions: it accepted 1.5, NaN, Infinity and 1e308, and JSON then sent a fraction, an
 * out-of-range integer, or `null` — which Atlas rejects while T3 reported `{sent: true}`.
 *
 * Bounded to safe integers rather than the full i64 range because beyond 2^53-1 a JS number
 * cannot represent the value it would be claiming to send.
 */
const AtlasCursor = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const AtlasDiagnosticsCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("refresh") }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  Schema.Struct({
    kind: Schema.Literal("retry"),
    after: AtlasCursor,
    /** Optional upstream (`RetryPayload.epoch: Option<i64>`): omitted means trust `after`. */
    epoch: Schema.optional(AtlasCursor),
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type AtlasDiagnosticsCommand = typeof AtlasDiagnosticsCommand.Type;

export const AtlasDiagnosticsSendCommandInput = Schema.Struct({
  relaySessionId: AtlasDiagnosticsRelaySessionId,
  command: AtlasDiagnosticsCommand,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AtlasDiagnosticsSendCommandInput = typeof AtlasDiagnosticsSendCommandInput.Type;

/** `sent: false` is a recoverable outcome (the session already closed) — not a hard fault. */
export const AtlasDiagnosticsSendCommandResult = Schema.Struct({
  sent: Schema.Boolean,
});
export type AtlasDiagnosticsSendCommandResult = typeof AtlasDiagnosticsSendCommandResult.Type;
