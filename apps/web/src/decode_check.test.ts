import { test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationThreadStreamItem } from "@t3tools/contracts";
test("thread detail snapshot", () => {
  const now = new Date().toISOString();
  Schema.decodeUnknownSync(OrchestrationThreadStreamItem)({
    kind: "snapshot",
    snapshot: {
      snapshotSequence: 0,
      thread: {
        id: "th-1",
        projectId: "p-workspace",
        title: "hey",
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5-20251001" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        messages: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    },
  });
});
