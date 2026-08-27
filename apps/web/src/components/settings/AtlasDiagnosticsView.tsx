import { AlertTriangleIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  summarizeAtlasDiagnosticsSnapshot,
  type AtlasDiagnosticsViewState,
} from "./AtlasDiagnostics.logic";
import { SettingsSection } from "./settingsLayout";

/**
 * Every helper below is called as a PLAIN FUNCTION (`{helper(...)}`), never referenced via a
 * `<Helper .../>` JSX tag. This repo has no DOM renderer for unit tests (see
 * `ProviderEnvironmentSection.test.tsx`'s module doc) — a rendered test calls a component
 * directly and walks its RETURNED element tree without invoking any nested component whose type
 * shows up in that tree. A helper whose output is a function of props OTHER than `children`
 * (which all of these are — they synthesize markup from `label`/`value`/`state`, not compose a
 * caller-supplied child) would therefore render as an inert, uninvoked element descriptor and
 * its content would be invisible to the test. Calling it directly embeds its ALREADY-COMPUTED
 * output instead, which is real, walkable JSX.
 */

function summaryStat(label: string, value: string | number): ReactElement {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2.5" key={label}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function alertBanner(input: {
  readonly tone: "destructive" | "warning";
  readonly icon: ReactNode;
  readonly message: string;
  readonly onRetry?: () => void;
}): ReactElement {
  return (
    <div
      className={cn(
        "mt-3 flex items-start justify-between gap-3 rounded-lg border px-4 py-3",
        input.tone === "destructive" && "border-destructive/25 bg-destructive/5 text-destructive",
        input.tone === "warning" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <div className="flex items-start gap-2">
        {input.icon}
        <span>{input.message}</span>
      </div>
      {input.onRetry ? (
        <Button
          size="xs"
          variant="outline"
          onClick={input.onRetry}
          aria-label="Retry Atlas diagnostics"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function atlasDiagnosticsBody(state: AtlasDiagnosticsViewState, onRetry: () => void): ReactElement {
  switch (state.kind) {
    case "unsupported":
      return (
        <div className="mt-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-muted-foreground">
          This T3 server does not implement the Atlas diagnostics proxy.
        </div>
      );
    case "not-configured":
      return (
        <div className="mt-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-muted-foreground">
          No Atlas provider instance is configured. Add one under Settings / Providers to see fleet
          diagnostics here.
        </div>
      );
    case "loading":
      return <div className="mt-3 text-muted-foreground">Checking Atlas...</div>;
    case "unreachable":
      return alertBanner({
        tone: "destructive",
        icon: <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />,
        message: state.message,
        onRetry,
      });
    case "unauthorized":
      return alertBanner({
        tone: "destructive",
        icon: <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />,
        message: state.message,
      });
    case "diagnostics-disabled":
      return alertBanner({
        tone: "warning",
        icon: <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />,
        message: state.message,
      });
    case "credential-refused-insecure":
      return alertBanner({
        tone: "destructive",
        icon: <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />,
        message: state.message,
      });
    case "connected": {
      const summary = summarizeAtlasDiagnosticsSnapshot(state.diagnosticsBodyText);
      return (
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          {summaryStat("Node", summary.nodeId ?? "...")}
          {summaryStat("Fleet members", summary.fleetMemberCount ?? "...")}
          {summaryStat(
            "Providers",
            summary.availableProviderCount === null || summary.providerCount === null
              ? "..."
              : `${summary.availableProviderCount}/${summary.providerCount}`,
          )}
          {summaryStat("Runs", summary.runTotal ?? "...")}
          {summaryStat("In flight", summary.inflightCount ?? "...")}
        </div>
      );
    }
  }
}

/**
 * Renders the six first-class states from a plain `AtlasDiagnosticsViewState` — no hooks, so it
 * can be called directly in tests. See `AtlasDiagnostics.test.tsx`.
 */
export function AtlasDiagnosticsView({
  state,
  isRefreshing,
  onRetry,
}: {
  readonly state: AtlasDiagnosticsViewState;
  readonly isRefreshing: boolean;
  readonly onRetry: () => void;
}) {
  const canRefresh = state.kind !== "unsupported" && state.kind !== "not-configured";
  return (
    <SettingsSection
      title="Atlas diagnostics"
      headerAction={
        canRefresh ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            disabled={isRefreshing}
            onClick={onRetry}
            aria-label="Refresh Atlas diagnostics"
          >
            <RefreshCwIcon className={cn("size-3", isRefreshing && "animate-spin")} />
          </Button>
        ) : null
      }
    >
      <div className="px-4 py-3 text-xs sm:px-5">
        <p className="text-muted-foreground">
          Canonical fleet, run, provider, and process state, reported directly by Atlas — not this
          browser&#39;s local view.
        </p>
        {atlasDiagnosticsBody(state, onRetry)}
      </div>
    </SettingsSection>
  );
}
