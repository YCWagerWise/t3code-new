/**
 * Rendered-component coverage for the environment editor's credential
 * handling — specifically for the exact regression finding #18 reported
 * against #10 (commit e4665901c): a declared-credential row whose value had
 * already been persisted `sensitive: false` was displayed in a plaintext
 * input while the checkbox next to it claimed "always sensitive". The pure
 * `.logic.ts` tests cover the decision functions in isolation but, as the
 * reviewer noted, cannot see what actually gets rendered — the checkbox and
 * the value field are two separate JSX branches that each read their own
 * source of truth, and only mounting the component proves they agree.
 *
 * This repo has no DOM renderer for unit tests; the established pattern
 * (see `ProviderUpdateEnvironmentRows.test.tsx`,
 * `ProjectFaviconPickerDialog.test.tsx`) is to call the component as a plain
 * function under a `useState` shim and walk the returned element tree.
 */
import { isValidElement, type ReactElement } from "react";
import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import type { ProviderCredentialDeclaration } from "./ProviderInstanceCard.logic";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

// A fixture, not the real Atlas declaration: proves the mechanism generically
// rather than re-testing one provider's literal variable name.
const FIXTURE_CREDENTIALS: ReadonlyArray<ProviderCredentialDeclaration> = [
  {
    name: "FIXTURE_BEARER_TOKEN",
    label: "Bearer token",
    description: "A fixture credential used only by this test.",
  },
];

const LEAKED_VALUE = "leaked-plaintext-secret";

function legacyInsecureRow(): ProviderInstanceEnvironmentVariable {
  // The exact state finding #18 is about: a declared credential persisted
  // non-sensitive. Provider settings only redact SENSITIVE entries before
  // they reach a client, so this `value` already arrived in the browser
  // in clear text before this component ever rendered it.
  return {
    name: "FIXTURE_BEARER_TOKEN",
    value: LEAKED_VALUE,
    sensitive: false,
  };
}

function flattenText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (isValidElement<Record<string, unknown>>(node)) return flattenText(node.props.children);
  return "";
}

function renderSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
  readonly credentials?: ReadonlyArray<ProviderCredentialDeclaration> | undefined;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProviderEnvironmentSection(props) as ReactElement<Record<string, unknown>>;
}

function findValueInput(tree: ReactElement<Record<string, unknown>>) {
  return visitElements(
    tree,
    (element) => element.props["aria-label"] === "Environment variable value 1",
  );
}

function findAlert(tree: ReactElement<Record<string, unknown>>) {
  return visitElements(tree, (element) => element.props.role === "alert");
}

describe("ProviderEnvironmentSection credential rendering", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("never renders a previously-exposed declared credential's value in a plaintext input", () => {
    const tree = renderSection({
      environment: [legacyInsecureRow()],
      onChange: vi.fn(),
      credentials: FIXTURE_CREDENTIALS,
    });

    const valueInput = findValueInput(tree);
    expect(valueInput).not.toBeNull();
    // The concrete leak: the leaked value must never appear as the input's
    // displayed value, and the field must not render as a plaintext input.
    expect(valueInput?.props.value).toBe("");
    expect(valueInput?.props.value).not.toContain(LEAKED_VALUE);
    expect(valueInput?.props.type).toBe("password");
  });

  it("does not present the row as already-safe: the sensitive checkbox and the input type agree", () => {
    const tree = renderSection({
      environment: [legacyInsecureRow()],
      onChange: vi.fn(),
      credentials: FIXTURE_CREDENTIALS,
    });

    const valueInput = findValueInput(tree);
    const checkbox = visitElements(
      tree,
      (element) =>
        element.props["aria-label"] ===
        "Environment variable FIXTURE_BEARER_TOKEN is always sensitive",
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.props.checked).toBe(true);
    expect(checkbox?.props.disabled).toBe(true);
    // Both consumers must derive from the same invariant: if the checkbox
    // claims sensitive, the value field must render as sensitive too.
    expect(valueInput?.props.type).toBe("password");
  });

  it("surfaces the prior exposure outside of a hover-only tooltip", () => {
    const tree = renderSection({
      environment: [legacyInsecureRow()],
      onChange: vi.fn(),
      credentials: FIXTURE_CREDENTIALS,
    });

    const alert = findAlert(tree);
    expect(alert).not.toBeNull();
    const alertText = flattenText(alert);
    expect(alertText).toContain("FIXTURE_BEARER_TOKEN");
    expect(alertText.toLowerCase()).toMatch(/expos|compromised/);

    const valueInput = findValueInput(tree);
    expect(String(valueInput?.props.placeholder)).toMatch(/exposed|rotate/i);
  });

  it("clears the exposure warning once the user enters a new value, and publishes it sensitive", () => {
    const onChange = vi.fn();
    let tree = renderSection({
      environment: [legacyInsecureRow()],
      onChange,
      credentials: FIXTURE_CREDENTIALS,
    });

    const valueInput = findValueInput(tree);
    const onCommit = valueInput?.props.onCommit as ((value: string) => void) | undefined;
    expect(onCommit).toBeDefined();
    onCommit?.("rotated-secret");

    expect(onChange).toHaveBeenCalledWith([
      {
        name: "FIXTURE_BEARER_TOKEN",
        value: "rotated-secret",
        sensitive: true,
        valueRedacted: false,
      },
    ]);

    tree = renderSection({
      environment: [legacyInsecureRow()],
      onChange,
      credentials: FIXTURE_CREDENTIALS,
    });

    expect(findAlert(tree)).toBeNull();
    expect(findValueInput(tree)?.props.value).toBe("rotated-secret");
  });

  it("leaves an ordinary, non-declared variable's plaintext rendering untouched", () => {
    const tree = renderSection({
      environment: [{ name: "SOME_OTHER_VAR", value: "not-a-secret", sensitive: false }],
      onChange: vi.fn(),
      credentials: FIXTURE_CREDENTIALS,
    });

    const valueInput = findValueInput(tree);
    expect(valueInput?.props.value).toBe("not-a-secret");
    expect(valueInput?.props.type).toBeUndefined();
    expect(findAlert(tree)).toBeNull();
  });
});
