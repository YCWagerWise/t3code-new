import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export type SubscriptionUsageSnapshot = {
  readonly usedPercentage: number;
  readonly remainingPercentage: number;
  readonly resetsAt: string | null;
  readonly windowDurationMinutes: number | null;
  readonly label: string;
  readonly updatedAt: string;
};

function findRateLimitSnapshot(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (asRecord(record.primary) || asRecord(record.secondary)) return record;
  return findRateLimitSnapshot(record.rateLimits);
}

/** Return the longest provider-reported window, which is normally the weekly allowance. */
export function deriveLatestSubscriptionUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubscriptionUsageSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "subscription-usage.updated") continue;

    const snapshot = findRateLimitSnapshot(activity.payload);
    if (!snapshot) continue;
    const candidates = [asRecord(snapshot.primary), asRecord(snapshot.secondary)].filter(
      (entry): entry is Record<string, unknown> => entry !== null,
    );
    const window = candidates
      .map((entry) => ({
        entry,
        duration: asFiniteNumber(entry.windowDurationMins),
      }))
      .filter(({ entry }) => asFiniteNumber(entry.usedPercent) !== null)
      .sort((left, right) => (right.duration ?? 0) - (left.duration ?? 0))[0];
    if (!window) continue;

    const used = Math.max(0, Math.min(100, asFiniteNumber(window.entry.usedPercent) ?? 0));
    const resetSeconds = asFiniteNumber(window.entry.resetsAt);
    const label =
      typeof snapshot.limitName === "string" && snapshot.limitName.trim().length > 0
        ? snapshot.limitName.trim()
        : window.duration !== null && window.duration >= 6 * 24 * 60
          ? "Weekly usage"
          : "Subscription usage";
    return {
      usedPercentage: used,
      remainingPercentage: Math.max(0, 100 - used),
      resetsAt: resetSeconds !== null ? new Date(resetSeconds * 1000).toISOString() : null,
      windowDurationMinutes: window.duration,
      label,
      updatedAt: activity.createdAt,
    };
  }
  return null;
}

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
