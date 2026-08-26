import type { ProviderClientDefinition } from "./providerDriverMeta";

export type ProviderCredentialDeclaration = NonNullable<
  ProviderClientDefinition["credentials"]
>[number];

/**
 * True when `name` (already trimmed) matches a credential this driver
 * declares in `ProviderClientDefinition.credentials`. Drives both the
 * forced-sensitive row state and the disabled toggle in
 * `ProviderEnvironmentSection` — see the field's doc comment in
 * `providerDriverMeta.ts` for why a declared credential can't be optionally
 * sensitive.
 */
export function isDeclaredCredentialName(
  credentials: ReadonlyArray<ProviderCredentialDeclaration> | undefined,
  name: string,
): boolean {
  if (!credentials || credentials.length === 0) return false;
  return credentials.some((credential) => credential.name === name);
}

/**
 * The `sensitive` value the environment editor should show and save for a
 * row named `name`: forced `true` for a declared credential regardless of
 * the row's own state, otherwise the row's own `sensitive` value untouched.
 * Applied both to the checkbox display and to the published environment
 * variable, so a declared credential can never round-trip as non-sensitive
 * even if its row started that way (e.g. an existing refused-insecure
 * entry someone hand-typed before this affordance existed).
 */
export function resolveEnvironmentRowSensitive(
  credentials: ReadonlyArray<ProviderCredentialDeclaration> | undefined,
  name: string,
  sensitive: boolean,
): boolean {
  return isDeclaredCredentialName(credentials, name) || sensitive;
}

/**
 * Declared credentials with no matching row yet (by exact, trimmed name),
 * in declaration order. Drives the "add this for me" affordance so a user
 * never has to type the exact environment variable name by hand.
 */
export function missingDeclaredCredentials(
  credentials: ReadonlyArray<ProviderCredentialDeclaration> | undefined,
  rowNames: ReadonlyArray<string>,
): ReadonlyArray<ProviderCredentialDeclaration> {
  if (!credentials || credentials.length === 0) return [];
  const present = new Set(rowNames.map((name) => name.trim()));
  return credentials.filter((credential) => !present.has(credential.name));
}
