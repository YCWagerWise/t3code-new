import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  branchNameFromAnswer,
  clampContext,
  makeAgentSdkTextGeneration,
  splitSubjectAndBody,
} from "./AgentSdkTextGeneration.ts";

/**
 * PROOF (#216): auxiliary generation is MODEL work on the SELECTED model, with
 * the caller's git context in the prompt — not a deterministic placeholder that
 * returns an empty body no matter what was staged.
 */
const asked: Array<{ model: string | undefined; prompt: string; cwd: string }> = [];

const service = (answer: string | (() => never)) =>
  makeAgentSdkTextGeneration({
    // unused by the fake ask below, but the shape must stay honest
    childProcessSpawner: {} as never,
    crypto: {} as never,
    resolveAgentModel: (slug) => `claude-resume:${slug ?? "default"}`,
    ask: (input) => {
      asked.push(input);
      return typeof answer === "string" ? Effect.succeed(answer) : Effect.sync(answer);
    },
  });

describe("AgentSdkTextGeneration", () => {
  it("sends the staged context to the selected model and uses its answer", async () => {
    asked.length = 0;
    const out = await Effect.runPromise(
      service(
        "Add retry to the uploader\n\nUploads failed on transient 503s.",
      ).generateCommitMessage({
        cwd: "/repo",
        branch: "feat/retry",
        stagedSummary: "M uploader.ts",
        stagedPatch: "@@ -1 +1 @@\n-fetch(url)\n+retry(() => fetch(url))",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } as never,
      }),
    );

    expect(out.subject).toBe("Add retry to the uploader");
    expect(out.body).toBe("Uploads failed on transient 503s.");
    expect(asked).toHaveLength(1);
    // the SELECTED model, and the rich context the caller assembled
    expect(asked[0]!.model).toBe("claude-opus-5");
    expect(asked[0]!.prompt).toContain("uploader.ts");
    expect(asked[0]!.prompt).toContain("retry(() => fetch(url))");
    expect(asked[0]!.prompt).toContain("feat/retry");
  });

  it("falls back to a local result when the model fails — a commit is never blocked", async () => {
    asked.length = 0;
    const out = await Effect.runPromise(
      service(() => {
        throw new Error("agent unreachable");
      }).generateCommitMessage({
        cwd: "/repo",
        branch: null,
        stagedSummary: "Tidy the parser",
        stagedPatch: "",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" } as never,
      }),
    );
    expect(out.subject).toBe("Tidy the parser");
  });

  it("asks for a PR title and body over the diff", async () => {
    asked.length = 0;
    const out = await Effect.runPromise(
      service("Speed up indexing\n\n- batches writes\n- drops a redundant scan").generatePrContent({
        cwd: "/repo",
        baseBranch: "main",
        headBranch: "perf/index",
        commitSummary: "3 commits",
        diffSummary: "indexer.ts | 40 ++--",
        diffPatch: "@@ batching @@",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } as never,
      }),
    );
    expect(out.title).toBe("Speed up indexing");
    expect(out.body).toContain("batches writes");
    expect(asked[0]!.model).toBe("gpt-5.6-sol");
    expect(asked[0]!.prompt).toContain("perf/index");
    expect(asked[0]!.prompt).toContain("@@ batching @@");
  });

  it("parses answers and clamps oversized context", () => {
    expect(splitSubjectAndBody('"Quoted subject"\n\nbody here')).toEqual({
      subject: "Quoted subject",
      body: "body here",
    });
    expect(branchNameFromAnswer("Add Retry To Uploader", "x")).toBe("add-retry-to-uploader");
    const clamped = clampContext("x".repeat(100), 10);
    expect(clamped.startsWith("x".repeat(10))).toBe(true);
    expect(clamped).toContain("truncated");
  });
});
