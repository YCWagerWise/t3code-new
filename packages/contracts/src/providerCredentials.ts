/**
 * Provider credential declarations — the environment-variable-shaped
 * credentials a driver reads its auth from (e.g. Atlas's
 * `ATLAS_ACCESS_TOKEN`, see `ATLAS_ACCESS_TOKEN_ENV` in `settings.ts`).
 *
 * This lives at the contracts layer, not in the web app, because the
 * security-critical rule here — a declared credential loaded persisted
 * non-sensitive must never republish its old value — has to hold on BOTH
 * sides of the wire: the web settings UI decides what an edit publishes,
 * and the server's driver decides what counts as a usable token. Splitting
 * that rule into two hand-written copies is exactly how it drifts; one pure
 * implementation, imported by both, cannot.
 *
 * @module providerCredentials
 */
import type { ProviderInstanceEnvironmentVariable } from "./providerInstance.ts";

/** The minimal shape callers need: a declared credential's environment variable name. */
export interface ProviderCredentialName {
  readonly name: string;
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
