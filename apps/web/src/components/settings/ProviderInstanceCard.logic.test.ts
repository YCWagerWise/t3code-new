import { describe, expect, it } from "vite-plus/test";

import {
  isDeclaredCredentialName,
  isPreviouslyExposedCredentialRow,
  missingDeclaredCredentials,
  resolveEnvironmentRowSensitive,
  type ProviderCredentialDeclaration,
} from "./ProviderInstanceCard.logic";

// A fixture, not the real Atlas declaration: these tests prove the generic
// mechanism works for any declared credential, not just the one provider
// that happens to use it today.
const FIXTURE_CREDENTIALS: ReadonlyArray<ProviderCredentialDeclaration> = [
  {
    name: "FIXTURE_BEARER_TOKEN",
    label: "Bearer token",
    description: "A fixture credential used only by this test.",
  },
];

describe("isDeclaredCredentialName", () => {
  it("recognises a declared credential name", () => {
    expect(isDeclaredCredentialName(FIXTURE_CREDENTIALS, "FIXTURE_BEARER_TOKEN")).toBe(true);
  });

  it("leaves an ordinary variable name unrecognised", () => {
    expect(isDeclaredCredentialName(FIXTURE_CREDENTIALS, "SOME_OTHER_VAR")).toBe(false);
  });

  it("treats a driver with no declared credentials as matching nothing", () => {
    expect(isDeclaredCredentialName(undefined, "FIXTURE_BEARER_TOKEN")).toBe(false);
    expect(isDeclaredCredentialName([], "FIXTURE_BEARER_TOKEN")).toBe(false);
  });
});

describe("resolveEnvironmentRowSensitive", () => {
  it("forces a declared credential row sensitive even if its stored value is false", () => {
    expect(resolveEnvironmentRowSensitive(FIXTURE_CREDENTIALS, "FIXTURE_BEARER_TOKEN", false)).toBe(
      true,
    );
  });

  it("keeps a declared credential row sensitive when already true", () => {
    expect(resolveEnvironmentRowSensitive(FIXTURE_CREDENTIALS, "FIXTURE_BEARER_TOKEN", true)).toBe(
      true,
    );
  });

  it("leaves a normal variable's sensitive flag exactly as given, in both directions", () => {
    expect(resolveEnvironmentRowSensitive(FIXTURE_CREDENTIALS, "SOME_OTHER_VAR", false)).toBe(
      false,
    );
    expect(resolveEnvironmentRowSensitive(FIXTURE_CREDENTIALS, "SOME_OTHER_VAR", true)).toBe(true);
  });
});

describe("isPreviouslyExposedCredentialRow", () => {
  it("flags a declared credential persisted non-sensitive as previously exposed", () => {
    expect(
      isPreviouslyExposedCredentialRow(FIXTURE_CREDENTIALS, "FIXTURE_BEARER_TOKEN", false),
    ).toBe(true);
  });

  it("does not flag a declared credential that is already sensitive", () => {
    expect(
      isPreviouslyExposedCredentialRow(FIXTURE_CREDENTIALS, "FIXTURE_BEARER_TOKEN", true),
    ).toBe(false);
  });

  it("does not flag a non-sensitive ordinary variable, which was never asserted safe", () => {
    expect(isPreviouslyExposedCredentialRow(FIXTURE_CREDENTIALS, "SOME_OTHER_VAR", false)).toBe(
      false,
    );
  });
});

describe("missingDeclaredCredentials", () => {
  it("lists a declared credential that has no matching row yet", () => {
    expect(missingDeclaredCredentials(FIXTURE_CREDENTIALS, ["SOME_OTHER_VAR"])).toEqual(
      FIXTURE_CREDENTIALS,
    );
  });

  it("is empty once a row with the exact declared name exists", () => {
    expect(
      missingDeclaredCredentials(FIXTURE_CREDENTIALS, ["SOME_OTHER_VAR", "FIXTURE_BEARER_TOKEN"]),
    ).toEqual([]);
  });

  it("trims row names before matching, since names are committed trimmed", () => {
    expect(missingDeclaredCredentials(FIXTURE_CREDENTIALS, ["  FIXTURE_BEARER_TOKEN  "])).toEqual(
      [],
    );
  });

  it("is empty for a driver that declares no credentials", () => {
    expect(missingDeclaredCredentials(undefined, [])).toEqual([]);
    expect(missingDeclaredCredentials([], [])).toEqual([]);
  });
});
