/**
 * AgentSdkTextGeneration — auxiliary text generation through the SELECTED model.
 *
 * Commit messages, PR bodies, branch names and thread titles are model work:
 * they read a diff and say what it does. This runs them through a short-lived
 * agent-sdk ACP session on the model the caller selected — the same binary and
 * the same model spec a coding turn uses — with the rich git context the caller
 * assembled (staged summary, patch, policy).
 *
 * Every operation degrades to a deterministic local result when the model is
 * unreachable, refuses, or takes too long: a commit must never be blocked by a
 * text nicety. The fallback is a fallback, not the product — a generated
 * subject with an empty body is what a placeholder looks like, and #216 is
 * exactly that placeholder being mistaken for an implementation.
 *
 * @module textGeneration/AgentSdkTextGeneration
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Crypto from "effect/Crypto";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeAgentSdkAcpRuntime } from "../provider/acp/AgentSdkAcpSupport.ts";
import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import type * as ChildProcessSpawnerNs from "effect/unstable/process/ChildProcessSpawner";
import type { TextGeneration } from "./TextGeneration.ts";

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";

const firstLine = (input: string, max: number): string => {
  const line =
    input
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** Split a model answer into `subject` (first line) and `body` (the rest). */
export function splitSubjectAndBody(answer: string): { subject: string; body: string } {
  const lines = answer.replace(/\r\n/g, "\n").split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx < 0) {
    return { subject: "", body: "" };
  }
  const subject = lines[firstIdx]!.trim().replace(/^["'`]|["'`]$/g, "");
  const body = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();
  return { subject, body };
}

/** Trim a model answer down to a usable branch name. */
export function branchNameFromAnswer(answer: string, fallback: string): string {
  const line = firstLine(answer, 80);
  const slug = slugify(line);
  return slug === "change" ? slugify(fallback) : slug;
}

/** Cap the context handed to the model so an enormous diff is not the prompt. */
export function clampContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

export interface AgentSdkTextGenerationDeps {
  readonly childProcessSpawner: ChildProcessSpawnerNs.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  /** Maps a UI model slug to the agent-sdk spec (`claude-resume:<slug>`). */
  readonly resolveAgentModel: (slug: string | undefined) => string;
  readonly binaryPath?: string | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Overridable for tests: run `prompt` on `model` and return the answer. */
  readonly ask?: (input: {
    readonly cwd: string;
    readonly model: string | undefined;
    readonly prompt: string;
  }) => Effect.Effect<string, unknown>;
}

const PROMPT_TIMEOUT = Duration.seconds(60);
const MAX_PATCH_CHARS = 24_000;

/**
 * One prompt on a fresh session, answered as plain text.
 *
 * The session is scoped: the child process dies with the effect, so an
 * auxiliary generation never leaves a shell behind.
 */
const askModel =
  (deps: AgentSdkTextGenerationDeps) =>
  (input: { readonly cwd: string; readonly model: string | undefined; readonly prompt: string }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime: AcpSessionRuntime.AcpSessionRuntime["Service"] =
          yield* makeAgentSdkAcpRuntime({
            childProcessSpawner: deps.childProcessSpawner,
            cwd: input.cwd,
            clientInfo: { name: "t3code-text-generation", version: "1" },
            spawnConfig: {
              model: deps.resolveAgentModel(input.model),
              ...(deps.binaryPath ? { binaryPath: deps.binaryPath } : {}),
            },
            ...(deps.environment ? { environment: deps.environment } : {}),
          });
        yield* runtime.start();
        // Collect the assistant's text WHILE the prompt runs — the answer
        // arrives as content deltas, so folding after the prompt returns would
        // read an already-drained stream.
        const collected = yield* Effect.forkScoped(
          runtime.getEvents().pipe(
            Stream.runFold(
              (): string => "",
              (acc: string, event) => (event._tag === "ContentDelta" ? acc + event.text : acc),
            ),
          ),
        );
        yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
        yield* runtime.drainEvents;
        yield* Fiber.interrupt(collected);
        const exit = yield* Fiber.await(collected);
        return Exit.isSuccess(exit) ? exit.value : "";
      }),
    ).pipe(Effect.provideService(Crypto.Crypto, deps.crypto), Effect.timeout(PROMPT_TIMEOUT));

/** Build a `TextGeneration` service that runs on the caller's selected model. */
export const makeAgentSdkTextGeneration = (
  deps?: AgentSdkTextGenerationDeps,
): TextGeneration["Service"] => {
  const ask = deps?.ask ?? (deps === undefined ? undefined : askModel(deps));

  /** Run the model, or fall back to the deterministic local answer. */
  const generate = (
    input: { readonly cwd: string; readonly model: string | undefined; readonly prompt: string },
    fallback: () => string,
  ): Effect.Effect<string> =>
    ask === undefined
      ? Effect.succeed(fallback())
      : ask(input).pipe(
          Effect.map((answer) => (answer.trim().length > 0 ? answer : fallback())),
          Effect.catchCause(() => Effect.succeed(fallback())),
        );

  return {
    generateCommitMessage: (input) =>
      generate(
        {
          cwd: input.cwd,
          model: input.modelSelection.model,
          prompt: [
            "Write a git commit message for the staged changes below.",
            "First line: a concise imperative subject, at most 72 characters.",
            "Then a blank line and a short body explaining WHY, if there is anything worth saying.",
            "Answer with the message only — no preamble, no code fences.",
            input.policy ? `Style guidance: ${JSON.stringify(input.policy)}` : "",
            `Branch: ${input.branch ?? "(detached)"}`,
            `Summary:\n${clampContext(input.stagedSummary, 4_000)}`,
            `Patch:\n${clampContext(input.stagedPatch, MAX_PATCH_CHARS)}`,
          ]
            .filter((s) => s.length > 0)
            .join("\n\n"),
        },
        () => firstLine(input.stagedSummary, 72) || "Update",
      ).pipe(
        Effect.map((answer) => {
          const { subject, body } = splitSubjectAndBody(answer);
          const finalSubject = subject || firstLine(input.stagedSummary, 72) || "Update";
          return {
            subject: finalSubject,
            body,
            ...(input.includeBranch
              ? { branch: branchNameFromAnswer(finalSubject, input.stagedSummary || "change") }
              : {}),
          };
        }),
      ),
    generatePrContent: (input) =>
      generate(
        {
          cwd: input.cwd,
          model: input.modelSelection.model,
          prompt: [
            `Write a pull request title and description for merging ${input.headBranch} into ${input.baseBranch}.`,
            "First line: the title. Then a blank line, then the description in markdown.",
            "Answer with the content only — no preamble, no code fences.",
            input.changeRequestTemplate
              ? `Follow this template:\n${clampContext(input.changeRequestTemplate, 4_000)}`
              : "",
            `Commits:\n${clampContext(input.commitSummary, 4_000)}`,
            `Changed files:\n${clampContext(input.diffSummary, 4_000)}`,
            `Diff:\n${clampContext(input.diffPatch, MAX_PATCH_CHARS)}`,
          ]
            .filter((s) => s.length > 0)
            .join("\n\n"),
        },
        () => firstLine(input.commitSummary, 72) || input.headBranch,
      ).pipe(
        Effect.map((answer) => {
          const { subject, body } = splitSubjectAndBody(answer);
          return {
            title: subject || firstLine(input.commitSummary, 72) || input.headBranch,
            body,
          };
        }),
      ),
    generateBranchName: (input) =>
      generate(
        {
          cwd: input.cwd,
          model: input.modelSelection.model,
          prompt: [
            "Suggest a short kebab-case git branch name for this request.",
            "Answer with the branch name only.",
            input.message,
          ].join("\n\n"),
        },
        () => input.message,
      ).pipe(Effect.map((answer) => ({ branch: branchNameFromAnswer(answer, input.message) }))),
    generateThreadTitle: (input) =>
      generate(
        {
          cwd: input.cwd,
          model: input.modelSelection.model,
          prompt: [
            "Write a short title (at most 60 characters) for a coding conversation that starts with this message.",
            "Answer with the title only — no quotes, no preamble.",
            input.message,
          ].join("\n\n"),
        },
        () => firstLine(input.message, 60) || "New thread",
      ).pipe(
        Effect.map((answer) => ({
          title: firstLine(answer, 60) || firstLine(input.message, 60) || "New thread",
        })),
      ),
  };
};
