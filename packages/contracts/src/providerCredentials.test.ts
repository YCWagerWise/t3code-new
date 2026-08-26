import { describe, expect, it } from "vite-plus/test";

import {
  isDeclaredCredentialName,
  isPreviouslyExposedCredentialRow,
  missingDeclaredCredentials,
  preparePublishedCredentialVariable,
  resolveEnvironmentRowSensitive,
  type ProviderCredentialName,
} from "./providerCredentials.ts";

// A fixture, not a real driver's declaration: these tests prove the
// mechanism works for any declared credential, not just the one provider
// that happens to use it today.
const FIXTURE_CREDENTIALS: ReadonlyArray<ProviderCredentialName> = [
  { name: "FIXTURE_BEARER_TOKEN" },
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

describe("preparePublishedCredentialVariable", () => {
  it("drops the value of a previously-exposed declared credential instead of republishing it", () => {
    expect(
      preparePublishedCredentialVariable(FIXTURE_CREDENTIALS, {
        name: "FIXTURE_BEARER_TOKEN",
        value: "leaked-value",
        sensitive: false,
      }),
    ).toEqual({ name: "FIXTURE_BEARER_TOKEN", value: "", sensitive: true });
  });

  it("does this even when the row was not the one the user just edited", () => {
    // The exact regression this function exists to close: publishing the
    // full row set after editing an unrelated variable must not carry an
    // untouched declared-credential row's old value forward.
    const untouchedLegacyRow = {
      name: "FIXTURE_BEARER_TOKEN",
      value: "leaked-value",
      sensitive: false,
    };
    const editedOtherRow = { name: "OTHER_VAR", value: "new-value", sensitive: false };

    const published = [untouchedLegacyRow, editedOtherRow].map((variable) =>
      preparePublishedCredentialVariable(FIXTURE_CREDENTIALS, variable),
    );

    expect(published).toEqual([
      { name: "FIXTURE_BEARER_TOKEN", value: "", sensitive: true },
      { name: "OTHER_VAR", value: "new-value", sensitive: false },
    ]);
  });

  it("passes a fresh, user-supplied value through once the row is marked sensitive", () => {
    // Once `sensitive` is true, the row is no longer "previously exposed" —
    // this is how a user's own replacement value survives publish.
    expect(
      preparePublishedCredentialVariable(FIXTURE_CREDENTIALS, {
        name: "FIXTURE_BEARER_TOKEN",
        value: "rotated-value",
        sensitive: true,
      }),
    ).toEqual({ name: "FIXTURE_BEARER_TOKEN", value: "rotated-value", sensitive: true });
  });

  it("leaves an ordinary, non-declared variable's value untouched regardless of sensitivity", () => {
    expect(
      preparePublishedCredentialVariable(FIXTURE_CREDENTIALS, {
        name: "SOME_OTHER_VAR",
        value: "plain-value",
        sensitive: false,
      }),
    ).toEqual({ name: "SOME_OTHER_VAR", value: "plain-value", sensitive: false });
  });

  it("preserves a genuine redacted-secret round trip untouched", () => {
    expect(
      preparePublishedCredentialVariable(FIXTURE_CREDENTIALS, {
        name: "FIXTURE_BEARER_TOKEN",
        value: "",
        sensitive: true,
        valueRedacted: true,
      }),
    ).toEqual({
      name: "FIXTURE_BEARER_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
    });
  });
});
