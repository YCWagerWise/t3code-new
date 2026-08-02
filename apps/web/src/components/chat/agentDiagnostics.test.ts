import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_STALL_THRESHOLD_MS,
  deriveAgentDiagnostics,
  formatHeartbeatAge,
} from "./agentDiagnostics";

const NOW = Date.parse("2026-07-28T01:00:00.000Z");

function activity(kind: string, createdAt: string): OrchestrationThreadActivity {
  return {
    id: `event-${kind}` as OrchestrationThreadActivity["id"],
    tone: "tool",
    kind,
    summary: kind,
    payload: {},
    turnId: null,
    createdAt,
  };
}

describe("deriveAgentDiagnostics", () => {
  it("uses the latest persisted activity as the heartbeat and retains its event trail", () => {
    const diagnostics = deriveAgentDiagnostics({
      isWorking: true,
      session: null,
      latestTurn: null,
      activities: [
        activity("tool.started", "2026-07-28T00:58:00.000Z"),
        activity("tool.completed", "2026-07-28T00:59:30.000Z"),
      ],
      messages: [],
      now: NOW,
    });

    expect(diagnostics).toMatchObject({
      status: "active",
      lastHeartbeatAt: "2026-07-28T00:59:30.000Z",
      eventTrail: ["tool.started", "tool.completed"],
    });
  });

  it("marks an active task stalled after five minutes without a backend update", () => {
    const heartbeatAt = new Date(NOW - AGENT_STALL_THRESHOLD_MS - 1).toISOString();
    const diagnostics = deriveAgentDiagnostics({
      isWorking: true,
      session: null,
      latestTurn: null,
      activities: [activity("tool.started", heartbeatAt)],
      messages: [],
      now: NOW,
    });

    expect(diagnostics.status).toBe("stalled");
    expect(formatHeartbeatAge(diagnostics.lastHeartbeatAt, NOW)).toBe("5m 0s ago");
  });

  it("does not mark a settled task stalled even when its last activity is old", () => {
    const diagnostics = deriveAgentDiagnostics({
      isWorking: false,
      session: null,
      latestTurn: null,
      activities: [activity("tool.completed", "2026-07-28T00:00:00.000Z")],
      messages: [],
      now: NOW,
    });

    expect(diagnostics.status).toBe("active");
  });
});
