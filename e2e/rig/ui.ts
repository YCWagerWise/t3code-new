/**
 * The UI vocabulary of the T3 lens, grounded in apps/web source (selector map
 * 2026-08-03). Everything is click-driven: under the Atlas transport the node
 * synthesizes `keybindings: []`, so keyboard shortcuts are dead by design.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { DEV_TOKEN } from "./rig.ts";

/**
 * Boot the app as a connected Atlas lens. The token must be injected BEFORE
 * app boot (the auth gate memoizes), which is exactly why the rig's Vite bakes
 * no VITE_ATLAS_TOKEN in: each test picks its own credential.
 */
export const openConnectedApp = async (page: Page, token: string = DEV_TOKEN): Promise<void> => {
  await page.addInitScript((t) => {
    (globalThis as { __ATLAS_TOKEN__?: string }).__ATLAS_TOKEN__ = t;
  }, token);
  // "/" auto-creates a draft and lands on /draft/<id> with the composer ready.
  await page.goto("/");
  await expect(page.getByTestId("composer-editor")).toBeVisible({ timeout: 30_000 });
};

/**
 * Lexical contenteditable composer; plain Enter submits on desktop.
 *
 * Enter is a silent no-op until the session is ready (the send button gates on
 * isConnecting/isSendBusy and nothing is queued — found live 2026-08-03), so
 * sending waits for the button to be enabled and verifies the composer drained.
 */
export const sendPrompt = async (page: Page, text: string): Promise<void> => {
  const composer = page.getByTestId("composer-editor");
  await composer.click();
  await composer.fill(text);
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
  await expect.poll(async () => (await composer.innerText()).trim(), { timeout: 10_000 }).toBe("");
};

/** Rendered only while session.status === "running" — the streaming signal. */
export const stopButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Stop generation" });

export const waitForTurnStreaming = async (page: Page): Promise<void> => {
  await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
};

/** Settled = the stop button is gone (after having been given a chance to appear). */
export const waitForTurnEnd = async (page: Page, timeoutMs = 120_000): Promise<void> => {
  await stopButton(page)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      /* turn may settle faster than the button renders */
    });
  await expect(stopButton(page)).toBeHidden({ timeout: timeoutMs });
};

export const interruptTurn = async (page: Page): Promise<void> => {
  await stopButton(page).click();
};

/**
 * The server thread id, read from the URL after the draft promotes to
 * /$environmentId/$threadId on first turn start.
 */
export const threadIdFromPage = async (page: Page): Promise<string> => {
  await page.waitForURL(
    (url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.length === 2 && parts[0] !== "draft" && parts[0] !== "settings";
    },
    { timeout: 30_000 },
  );
  const parts = new URL(page.url()).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[1]!);
};

export const timelineAssistantTexts = (page: Page): Promise<string[]> =>
  page.locator('[data-timeline-row-kind="message"][data-message-role="assistant"]').allInnerTexts();

/** Tool-call surfaces: expanded work groups and collapsed work toggles both count. */
export const timelineToolCalls = (page: Page): Promise<string[]> =>
  page
    .locator('[data-timeline-row-kind="work"], [data-timeline-row-kind="work-toggle"]')
    .allInnerTexts();

/**
 * Identity of every rendered message row. Reload-without-duplication is an
 * assertion on this SET, not on counts: duplicated replay shows up as a
 * repeated id (or a doubled list) no matter how the list virtualizes.
 */
export const timelineMessageIds = (page: Page): Promise<(string | null)[]> =>
  page.$$eval("[data-message-id]", (rows) => rows.map((r) => r.getAttribute("data-message-id")));
