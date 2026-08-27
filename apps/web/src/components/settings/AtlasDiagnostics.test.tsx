/**
 * Rendered coverage for the Atlas diagnostics panel's six first-class states.
 *
 * `AtlasDiagnosticsView` (in the sibling `AtlasDiagnosticsView.tsx`) takes zero hooks — it is a
 * plain function of `{state, isRefreshing, onRetry}` — so it is called directly here and the
 * returned element tree is walked, the same "no DOM renderer" pattern
 * `PullRequestsUnavailableState.test.tsx` and `ProviderEnvironmentSection.test.tsx` use. The
 * hook-consuming wrapper, `AtlasDiagnosticsPanel` (`AtlasDiagnostics.tsx`), stays thin and
 * untested directly per that same convention.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import type { AtlasDiagnosticsViewState } from "./AtlasDiagnostics.logic";
import { AtlasDiagnosticsView } from "./AtlasDiagnosticsView";
import { T3LocalDiagnosticsBanner } from "./T3LocalDiagnosticsBanner";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function findByAriaLabel(
  root: ReactElement,
  label: string,
): ReactElement<Record<string, unknown>> | null {
  return visitElements(root, (element) => element.props["aria-label"] === label);
}

const CONNECTED_STATE: AtlasDiagnosticsViewState = {
  kind: "connected",
  handshakeBodyText: "{}",
  diagnosticsBodyText: JSON.stringify({
    protocol_version: 1,
    node_id: "seraphim",
    server_time_ms: 0,
    fleet: { self_id: "seraphim", members: [{ id: "seraphim" }] },
    providers: [
      { provider: "anthropic", model_id: "claude-opus-4-8", capabilities: [], available: true },
    ],
    runs: { total: 7, by_status: [], by_plugin: [], by_workspace: [], recent: [] },
    inflight: [],
  }),
};

describe("AtlasDiagnosticsView", () => {
  it("renders the unsupported state distinctly, with no refresh affordance", () => {
    const element = AtlasDiagnosticsView({
      state: { kind: "unsupported" },
      isRefreshing: false,
      onRetry: () => {},
    });
    const text = textOf(element);
    expect(text).toContain("does not implement the Atlas diagnostics proxy");
    expect(text).not.toContain("Checking Atlas");
    // No refresh button — a server that never offers the proxy has nothing to retry.
    expect(findByAriaLabel(element, "Refresh Atlas diagnostics")).toBeNull();
  });

  it("renders connected with Atlas's own reported facts, not this browser's", () => {
    const element = AtlasDiagnosticsView({
      state: CONNECTED_STATE,
      isRefreshing: false,
      onRetry: () => {},
    });
    const text = textOf(element);
    expect(text).toContain("seraphim");
    expect(text).toContain("7");
    expect(text).not.toContain("does not implement");
  });

  it("renders unavailable (unreachable) honestly, with the real proxy message and a retry", () => {
    const state: AtlasDiagnosticsViewState = {
      kind: "unreachable",
      message: "The Atlas node could not be reached: ECONNREFUSED",
    };
    const onRetry = vi.fn();
    const element = AtlasDiagnosticsView({ state, isRefreshing: false, onRetry });
    const text = textOf(element);
    expect(text).toContain("ECONNREFUSED");

    const retryButton = findByAriaLabel(element, "Retry Atlas diagnostics");
    expect(retryButton).not.toBeNull();
    (retryButton?.props["onClick"] as () => void)();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reconnects: an unreachable render followed by a connected render is a distinct state, not a stuck error", () => {
    const failing = AtlasDiagnosticsView({
      state: { kind: "unreachable", message: "The Atlas node could not be reached: ECONNRESET" },
      isRefreshing: false,
      onRetry: () => {},
    });
    expect(textOf(failing)).toContain("ECONNRESET");
    expect(textOf(failing)).not.toContain("seraphim");

    const recovered = AtlasDiagnosticsView({
      state: CONNECTED_STATE,
      isRefreshing: false,
      onRetry: () => {},
    });
    expect(textOf(recovered)).toContain("seraphim");
    expect(textOf(recovered)).not.toContain("could not be reached");
  });

  it("renders unauthorized, diagnostics-disabled, and credential-refused-insecure as distinct, honest states", () => {
    const unauthorized = textOf(
      AtlasDiagnosticsView({
        state: { kind: "unauthorized", message: "atlas-host refused the access token (401)." },
        isRefreshing: false,
        onRetry: () => {},
      }),
    );
    const disabled = textOf(
      AtlasDiagnosticsView({
        state: {
          kind: "diagnostics-disabled",
          message: "This Atlas node has not enabled its diagnostics surface.",
        },
        isRefreshing: false,
        onRetry: () => {},
      }),
    );
    const insecureCredential = textOf(
      AtlasDiagnosticsView({
        state: {
          kind: "credential-refused-insecure",
          message: "The Atlas access token on this instance is not marked sensitive.",
        },
        isRefreshing: false,
        onRetry: () => {},
      }),
    );

    expect(unauthorized).toContain("401");
    expect(disabled).toContain("diagnostics surface");
    expect(insecureCredential).toContain("not marked sensitive");
    // None of the three collapse into one another or into a generic "error".
    expect(new Set([unauthorized, disabled, insecureCredential]).size).toBe(3);
  });
});

describe("T3LocalDiagnosticsBanner", () => {
  it("labels the section lens-local and distinguishes it from Atlas's canonical view honestly", () => {
    const text = textOf(T3LocalDiagnosticsBanner());
    expect(text).toContain("T3 local");
    expect(text).toContain("not Atlas");
    expect(text).toContain("sidecar");
  });
});
