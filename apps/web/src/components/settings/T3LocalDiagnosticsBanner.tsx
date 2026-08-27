/**
 * Marks everything below it as LENS-LOCAL — this app's own view of the browser, desktop, and T3
 * server processes, never Atlas's canonical fleet/run/provider state (rendered by
 * `AtlasDiagnosticsPanel` above this banner on the diagnostics page). A standalone, hook-free
 * component so a rendered test can call it directly without pulling in the whole diagnostics
 * page's dependency graph — the "no DOM renderer" pattern this repo's component tests follow.
 */
export function T3LocalDiagnosticsBanner() {
  return (
    <div className="px-3 sm:px-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
        T3 local
      </div>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Browser, desktop, and this T3 server&#39;s own process health, as this app observes it
        locally — not Atlas&#39;s canonical fleet view above. The native resource-monitor sidecar
        below reflects only this process tree, on this machine.
      </p>
    </div>
  );
}
