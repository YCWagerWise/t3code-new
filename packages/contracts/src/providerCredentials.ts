/**
 * Provider credential declarations — the environment-variable-shaped
 * credentials a driver reads its auth from (e.g. Atlas's
 * `ATLAS_ACCESS_TOKEN`, see `ATLAS_ACCESS_TOKEN_ENV` in `settings.ts`).
 *
 * This lives at the contracts layer, not in the web app, because the
 * security-critical rule here — a declared credential loaded persisted
 * non-sensitive must never republish its old value — has to hold on BOTH
 * sides of the wire: the web settings UI decides what an edit publishes,
 * and the server decides what it will actually accept and persist.
 * Splitting either the rule OR the driver->credential-name mapping into two
 * hand-written copies is exactly how this class of bug recurs (finding #22
 * against b04afc2fa: the client sanitized, but the server accepted
 * whatever it was given, because nothing server-side even knew Atlas
 * declared a credential). One list, one set of decision functions, read by
 * both sides.
 *
 * @module providerCredentials
 */
import { ATLAS_ACCESS_TOKEN_ENV } from "./settings.ts";
import {
  ProviderDriverKind,
  type ProviderInstanceEnvironmentVariable,
} from "./providerInstance.ts";

/** The minimal shape callers need: a declared credential's environment variable name. */
export interface ProviderCredentialName {
  readonly name: string;
}

/**
 * The single driver -> declared-credentials map. Web's `providerDriverMeta.ts`
 * enriches these with presentation copy (label/description) for its own
 * driver definitions; it does not maintain a second list of names — it reads
 * this one. The server reads this same map to validate what it is asked to
 * persist, in `serverSettings.ts`.
 */
export const PROVIDER_DECLARED_CREDENTIALS: Partial<
  Record<ProviderDriverKind, ReadonlyArray<ProviderCredentialName>>
> = {
  [ProviderDriverKind.make("atlas")]: [{ name: ATLAS_ACCESS_TOKEN_ENV }],
};

/**
 * Declared credentials for a driver, or an empty list for a driver (or fork
 * driver kind) that declares none. Accepts a loose `string` too — the
 * server reads a persisted instance's `driver` field, which is typed as the
 * open `ProviderDriverKind` brand but may not have been re-validated yet at
 * the call site.
 */
export function declaredCredentialsForDriver(
  driver: ProviderDriverKind | string | undefined,
): ReadonlyArray<ProviderCredentialName> {
  if (driver === undefined) return [];
  return PROVIDER_DECLARED_CREDENTIALS[driver as ProviderDriverKind] ?? [];
}

/**
 * True when `name` matches a credential this driver declares. Callers use
 * this to force `sensitive: true` and disable the "sensitive" toggle for a
 * matching row: the server-side driver that reads a declared credential
 * refuses to use a matching entry that isn't marked sensitive (see e.g.
 * `AtlasDriver.readAtlasCredential`'s `refused-insecure` result), so
 * offering a free toggle on a declared-credential row is a footgun, not a
 * real choice.
 */
export function isDeclaredCredentialName(
  credentials: ReadonlyArray<ProviderCredentialName> | undefined,
  name: string,
): boolean {
  if (!credentials || credentials.length === 0) return false;
  return credentials.some((credential) => credential.name === name);
}

/**
 * The `sensitive` value a declared-credential row must present: forced
 * `true` regardless of its own stored value, otherwise the value untouched.
 */
export function resolveEnvironmentRowSensitive(
  credentials: ReadonlyArray<ProviderCredentialName> | undefined,
  name: string,
  sensitive: boolean,
): boolean {
  return isDeclaredCredentialName(credentials, name) || sensitive;
}

/**
 * True when a row is exactly the state this module exists to prevent: a
 * declared credential persisted `sensitive: false`. Provider settings only
 * redact SENSITIVE environment entries before returning them to a client
 * (see `redactServerSettingsForClient` in the server), so a matching
 * non-sensitive row's `value` has already reached a browser in clear text.
 */
export function isPreviouslyExposedCredentialRow(
  credentials: ReadonlyArray<ProviderCredentialName> | undefined,
  name: string,
  sensitive: boolean,
): boolean {
  return isDeclaredCredentialName(credentials, name) && !sensitive;
}

/**
 * Declared credentials with no matching row yet (by exact, trimmed name),
 * in declaration order. Generic over `T` so a caller with a richer
 * declaration (e.g. the web settings UI's `{ name, label, description }`)
 * gets that shape back, not just the bare name.
 */
export function missingDeclaredCredentials<T extends ProviderCredentialName>(
  credentials: ReadonlyArray<T> | undefined,
  rowNames: ReadonlyArray<string>,
): ReadonlyArray<T> {
  if (!credentials || credentials.length === 0) return [];
  const present = new Set(rowNames.map((name) => name.trim()));
  return credentials.filter((credential) => !present.has(credential.name));
}

/**
 * The security-critical seam: given a row a client is about to publish for
 * a declared credential, decide what is actually safe to send.
 *
 * A declared credential loaded `sensitive: false` already reached the
 * browser in clear text. Forcing `sensitive: true` on publish stops
 * *future* exposure of whatever ends up in this row, but if the OLD value
 * still rides along, an edit to a completely unrelated row still
 * republishes it — the server then writes that old, already-compromised
 * value into the secret store, and the driver accepts it as a live
 * credential. That is worse than the original bug: it turns a display
 * defect into a quiet promotion of a leaked secret into production use.
 *
 * So the value itself is dropped, not carried forward, for exactly this
 * state — fail closed. The consequence is intentional: the driver then
 * sees no usable value and reports "no credential" until the user supplies
 * a real replacement, which is the only path back to `sensitive: true`
 * with a non-empty value.
 */
export function preparePublishedCredentialVariable(
  credentials: ReadonlyArray<ProviderCredentialName> | undefined,
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  const mustDropValue = isPreviouslyExposedCredentialRow(
    credentials,
    variable.name,
    variable.sensitive,
  );
  return {
    ...variable,
    value: mustDropValue ? "" : variable.value,
    sensitive: resolveEnvironmentRowSensitive(credentials, variable.name, variable.sensitive),
  };
}

/**
 * Server-side counterpart to `preparePublishedCredentialVariable`: scans an
 * incoming environment for entries the server must refuse to persist or
 * broadcast — a declared credential submitted `sensitive: false`.
 *
 * This does not assume the caller ran `preparePublishedCredentialVariable`
 * first. It cannot: a stale client build, a hand-rolled RPC call, or any
 * future surface that writes provider settings can submit whatever shape
 * it wants, and the server is the only party positioned to say no before
 * that value is written to disk, moved into the secret store, or broadcast
 * to every other connected client.
 */
export function findInsecureDeclaredCredentials(
  driver: ProviderDriverKind | string | undefined,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const declared = declaredCredentialsForDriver(driver);
  if (declared.length === 0 || !environment || environment.length === 0) return [];
  return environment.filter(
    (variable) => isDeclaredCredentialName(declared, variable.name) && variable.sensitive !== true,
  );
}
