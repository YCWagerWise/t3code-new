/**
 * ACTION 006/153 — terminal.new.
 *
 * The shortcut is only valid while the terminal owns focus. The backend exports
 * `mod+n -> terminal.new` with `when: terminalFocus`; outside that guard the
 * same chord belongs to `chat.new`. The runtime assertion below therefore first
 * opens and focuses a terminal, then presses mod+n and asserts the actual
 * `terminal.open` request on the WebSocket.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

type SentRequest = {
  readonly tag: string;
  readonly payload: any;
};

function recordRequests(page: Page): SentRequest[] {
  const requests: SentRequest[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
      try {
        const parsed = JSON.parse(payload);
        if (parsed?._tag === "Request" && typeof parsed.tag === "string") {
          requests.push({ tag: parsed.tag, payload: parsed.payload });
        }
      } catch {
        // Keep the recorder honest without making non-JSON control frames fatal.
      }
    });
  });
  return requests;
}

function terminalOpenInputs(requests: readonly SentRequest[]): any[] {
  return requests
    .filter((request) => request.tag === "terminal.open")
    .map((request) => request.payload?.input ?? request.payload);
}

function assertExactlyOneTerminalOwner(input: any): void {
  const threadId = typeof input?.threadId === "string" ? input.threadId.trim() : "";
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
  expect(
    Number(threadId.length > 0) + Number(sessionId.length > 0),
    "TerminalTargetInput is a union: terminal.open must carry exactly one non-empty owner",
  ).toBe(1);
}

async function waitForNewTerminalOpen(
  requests: readonly SentRequest[],
  baselineCount: number,
): Promise<any> {
  await expect
    .poll(() => terminalOpenInputs(requests).length, {
      timeout: 60_000,
      message: "terminal.new must dispatch a second terminal.open request on the wire",
    })
    .toBeGreaterThan(baselineCount);
  return terminalOpenInputs(requests).at(-1);
}

test("terminal.new is gated on terminal focus and opens a new owned pane", async ({
  gotoApp,
  page,
}) => {
  const requests = recordRequests(page);
  await gotoApp(page);

  await page.keyboard.press("ControlOrMeta+J");
  const firstOpen = await waitForNewTerminalOpen(requests, 0);
  assertExactlyOneTerminalOwner(firstOpen);

  await page.locator('[data-terminal-owner="drawer"]').first().click();
  await page.keyboard.press("ControlOrMeta+N");
  const newOpen = await waitForNewTerminalOpen(requests, 1);

  expect(newOpen.terminalId, "terminal.new must choose a fresh terminalId client-side").toEqual(
    expect.any(String),
  );
  expect(newOpen.terminalId.trim().length).toBeGreaterThan(0);
  expect(newOpen.terminalId).not.toBe(firstOpen.terminalId);
  expect(newOpen.cwd, "terminal.open must carry a cwd; {terminalId,cwd} alone is refused").toEqual(
    expect.any(String),
  );
  expect(newOpen.cwd.trim().length).toBeGreaterThan(0);
  assertExactlyOneTerminalOwner(newOpen);
});
