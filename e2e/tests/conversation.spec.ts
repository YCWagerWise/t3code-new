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
  timelineMessageIds,
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

    // Diff truth (G1 behavior 4): the turn's changed files surface inline and
    // open the diff panel tab.
    const openDiff = page.getByRole("button", { name: "Open diff" }).first();
    await expect(openDiff).toBeVisible({ timeout: 20_000 });
    await openDiff.click();
    await expect(page.locator("[data-right-panel-tabbar] [data-active-tab='true']")).toBeVisible();
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
    const before = await timelineMessageIds(page);
    expect(before.length).toBeGreaterThanOrEqual(2); // user + assistant at minimum
    expect(new Set(before).size).toBe(before.length);

    await page.reload();
    await waitFor(
      "timeline re-rendered after reload",
      async () => (await timelineMessageIds(page)).length >= 2,
      20_000,
    );
    const after = await timelineMessageIds(page);
    // Identity, not count: a duplicated replay repeats ids however it renders.
    expect(new Set(after).size).toBe(after.length);
    expect([...after].sort()).toEqual([...before].sort());
  });

  test("thread rename is accepted lens-locally (thread.meta.update, 2d811285)", async ({
    page,
  }) => {
    await openConnectedApp(page);
    await sendPrompt(page, "Reply with exactly the word: named");
    await waitForTurnEnd(page);
    const threadId = await threadIdFromPage(page);

    const row = page.getByTestId(`thread-row-${threadId}`);
    await row.dblclick();
    const input = row.locator("input");
    await input.fill("renamed by e2e");
    await input.press("Enter");
    await expect(page.getByTestId(`thread-title-${threadId}`)).toHaveText("renamed by e2e");
    // The old gate refused the command and surfaced an error banner.
    await expect(page.getByRole("button", { name: "Dismiss error" })).toHaveCount(0);
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
