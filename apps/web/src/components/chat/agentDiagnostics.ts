import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

export const AGENT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
const EVENT_TRAIL_LIMIT = 6;

export type AgentDiagnosticStatus = "active" | "stalled";

export interface AgentDiagnostics {
  readonly status: AgentDiagnosticStatus;
  readonly lastHeartbeatAt: string | null;
  readonly eventTrail: ReadonlyArray<string>;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = parseTime(value);
    if (timestamp !== null && timestamp > latestTime) {
      latestTime = timestamp;
      latestValue = value ?? null;
    }
  }
  return latestValue;
}

/**
 * Converts persisted orchestration activity into the small, readable trail
 * shown in the active-turn diagnostics. It deliberately preserves provider
 * event names so an operator can correlate the UI with the event store.
 */
export function deriveAgentDiagnostics(input: {
  readonly isWorking: boolean;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly now: number;
  readonly stallThresholdMs?: number;
}): AgentDiagnostics {
  const lastHeartbeatAt = latestTimestamp([
    input.session?.updatedAt,
    input.latestTurn?.startedAt,
    ...input.activities.map((activity) => activity.createdAt),
    ...input.messages.map((message) => message.updatedAt),
  ]);
  const lastHeartbeatTime = parseTime(lastHeartbeatAt);
  const isStalled =
    input.isWorking &&
    lastHeartbeatTime !== null &&
    input.now - lastHeartbeatTime > (input.stallThresholdMs ?? AGENT_STALL_THRESHOLD_MS);

  const eventTrail = [...input.activities]
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-EVENT_TRAIL_LIMIT)
    .map((activity) => activity.kind);

  return {
    status: isStalled ? "stalled" : "active",
    lastHeartbeatAt,
    eventTrail,
  };
}

export function formatHeartbeatAge(lastHeartbeatAt: string | null, now: number): string {
  const heartbeatTime = parseTime(lastHeartbeatAt);
  if (heartbeatTime === null) return "No backend update received";
  const seconds = Math.max(0, Math.floor((now - heartbeatTime) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s ago`;
}
