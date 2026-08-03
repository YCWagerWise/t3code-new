/**
 * The automated G1 gate (doc 15 §3.2) plus the disk-truth proof: Atlas is the
 * sole provider, a real browser drives real turns, and the UI, the node's
 * /feed, and the workspace on disk must all agree.
 *
 * These specs run REAL model turns (the node's manifest default) — they are
 * slow by nature and serial by design.
 */
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { replayFeed } from "../rig/feed.ts";
import { readRigState, waitFor } from "../rig/rig.ts";
import {
  interruptTurn,
  openConnectedApp,
  sendPrompt,
  threadIdFromPage,
  timelineAssistantTexts,
  timelineItemCount,
  timelineToolCalls,
  waitForTurnEnd,
  waitForTurnStreaming,
} from "../rig/ui.ts";

test.describe("G1: real conversation through the browser", () => {
  test("prompt → ack → streamed assistant timeline", async ({ page }) => {
    await openConnectedApp(page);
    await sendPrompt(page, "Reply with exactly the word: pong");
    // Ack: the user message renders immediately, before the model answers.
    await expect(page.getByText("Reply with exactly the word: pong").first()).toBeVisible();
    await waitForTurnEnd(page);
    const texts = await timelineAssistantTexts(page);
    expect(texts.join("\n")).toContain("pong");

    // Wire truth: the node's feed saw the same turn.
    const threadId = await threadIdFromPage(page);
    const frames = await replayFeed(threadId);
    const kinds = frames.map((f) => f.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
  });

  test("run_bash writes a file: UI, feed, and disk agree", async ({ page }) => {
    const { workspaceRoot } = readRigState();
    await openConnectedApp(page);
    await sendPrompt(
      page,
      "Using run_bash, create a file called browser.txt containing exactly: hello from the browser — then reply with just: created",
    );
    await waitForTurnEnd(page, 150_000);

    // Disk truth — the whole point: the node actually did the work.
    let created = "";
    await waitFor(
      "browser.txt on disk",
      async () => {
        const matches = findFile(workspaceRoot, "browser.txt");
        if (matches.length === 0) return false;
        created = fs.readFileSync(matches[0]!, "utf8");
        return true;
      },
      30_000,
    );
    expect(created.trim()).toBe("hello from the browser");

    // Wire truth: a run_bash tool_call frame exists and mentions the file.
    const threadId = await threadIdFromPage(page);
    const frames = await replayFeed(threadId);
    const toolCalls = frames.filter((f) => f.kind === "tool_call");
    const bash = toolCalls.find(
      (f) =>
        (f.payload as { tool?: string })?.tool === "run_bash" &&
        JSON.stringify(f.payload).includes("browser.txt"),
    );
    expect(bash, "feed must record the run_bash tool_call").toBeTruthy();
    expect(frames.map((f) => f.kind)).toContain("tool_result");

    // UI truth: the timeline showed the tool call, not just the reply.
    const uiTools = await timelineToolCalls(page);
    expect(uiTools.length).toBeGreaterThanOrEqual(1);
  });

  test("interrupt mid-turn actually stops the turn", async ({ page }) => {
    await openConnectedApp(page);
    await sendPrompt(
      page,
      "Using run_bash, run: sleep 120 && echo done — do not do anything else.",
    );
    await waitForTurnStreaming(page);
    await interruptTurn(page);
    await waitForTurnEnd(page, 30_000);

    // The node must agree the turn ended now, not 120s from now.
    const threadId = await threadIdFromPage(page);
    await waitFor(
      "terminal turn frame after interrupt",
      async () => {
        const frames = await replayFeed(threadId);
        const turns = frames.filter((f) => f.kind === "turn" || f.kind === "lifecycle");
        return JSON.stringify(turns).match(/cancel|interrupt|stopped/i) !== null;
      },
      15_000,
    );
  });

  test("reload replays the timeline without duplication", async ({ page }) => {
    await openConnectedApp(page);
    await sendPrompt(page, "Reply with exactly the word: stable");
    await waitForTurnEnd(page);
    const before = await timelineItemCount(page);
    expect(before).toBeGreaterThanOrEqual(2); // user + assistant at minimum

    await page.reload();
    await waitFor(
      "timeline re-rendered after reload",
      async () => (await timelineItemCount(page)) >= 2,
      20_000,
    );
    const after = await timelineItemCount(page);
    expect(after).toBe(before);
  });
});

/** Recursive filename search under the rig workspace (turn workdirs nest). */
const findFile = (root: string, name: string): string[] => {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) hits.push(full);
    }
  };
  walk(root);
  return hits;
};
