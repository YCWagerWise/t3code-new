import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "~/lib/utils";
import { deriveAgentDiagnostics, formatHeartbeatAge } from "./agentDiagnostics";

interface AgentDiagnosticDrawerProps {
  readonly threadId: ThreadId;
  readonly isWorking: boolean;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

/** A live, local view of the most recent persisted orchestration activity. */
export function AgentDiagnosticsPanel({
  threadId,
  isWorking,
  session,
  latestTurn,
  activities,
  messages,
}: AgentDiagnosticDrawerProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const diagnostics = useMemo(
    () =>
      deriveAgentDiagnostics({
        isWorking,
        session,
        latestTurn,
        activities,
        messages,
        now,
      }),
    [activities, isWorking, latestTurn, messages, now, session],
  );

  useEffect(() => {
    if (!isWorking) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isWorking]);

  useEffect(() => {
    if (diagnostics.status === "stalled") {
      setExpanded(true);
    }
  }, [diagnostics.status]);

  if (!isWorking) return null;

  const isStalled = diagnostics.status === "stalled";
  const statusLabel = isStalled ? "Stalled" : "Active";
  const eventTrail =
    diagnostics.eventTrail.length > 0 ? diagnostics.eventTrail.join(" → ") : "No events yet";

  return (
    <section
      aria-label="Agent diagnostics"
      className={cn(
        "overflow-hidden rounded-lg border bg-card text-xs shadow-sm",
        isStalled ? "border-destructive/50" : "border-border/70",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/45"
      >
        {isStalled ? (
          <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <span
            className="size-2 shrink-0 rounded-full bg-emerald-500 animate-status-pulse"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 font-medium text-foreground">Agent diagnostics</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide text-[10px]",
            isStalled
              ? "bg-destructive/15 text-destructive"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
          )}
        >
          {statusLabel}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <dl className="grid gap-2 border-border/60 border-t px-3 py-2.5 font-mono text-[11px] leading-relaxed sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Thread ID</dt>
          <dd className="min-w-0 break-all text-foreground">{threadId}</dd>
          <dt className="text-muted-foreground">Session</dt>
          <dd className="text-foreground">{session?.status ?? "unavailable"}</dd>
          <dt className="text-muted-foreground">Last heartbeat</dt>
          <dd className={cn("text-foreground", isStalled && "font-semibold text-destructive")}>
            {formatHeartbeatAge(diagnostics.lastHeartbeatAt, now)}
          </dd>
          <dt className="text-muted-foreground">Event trail</dt>
          <dd className="min-w-0 break-words text-foreground">{eventTrail}</dd>
        </dl>
      ) : null}
    </section>
  );
}
