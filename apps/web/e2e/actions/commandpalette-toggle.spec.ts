/**
 * ACTION 015/153 — commandPalette.toggle.
 *
 * The palette is the second entry point for the command surface. This spec
 * opens it through the `!terminalFocus` keybinding, reads the keybound command
 * denominator from `server.getConfig`, and compares it with the commands the
 * palette renders.
 */
import { test, expect } from "../fixtures";
import type { Page } from "@playwright/test";

type Frame = { readonly dir: "sent" | "recv"; readonly json: any };

function recordFrames(page: Page): Frame[] {
  const frames: Frame[] = [];
  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => record("sent", frame.payload));
    ws.on("framereceived", (frame) => record("recv", frame.payload));
  });
  function record(dir: Frame["dir"], payload: string | Buffer) {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    try {
      frames.push({ dir, json: JSON.parse(text) });
    } catch {
      frames.push({ dir, json: { _tag: "NonJson" } });
    }
  }
  return frames;
}

async function latestConfig(frames: readonly Frame[]): Promise<any> {
  await expect
    .poll(
      () => frames.some((frame) => frame.dir === "sent" && frame.json?.tag === "server.getConfig"),
      { timeout: 60_000, message: "the app must request server.getConfig" },
    )
    .toBe(true);

  await expect
    .poll(
      () =>
        frames.some((frame) => {
          if (frame.dir !== "recv" || frame.json?._tag !== "Exit") return false;
          const exit = frame.json.exit;
          return exit?._tag === "Success" && Array.isArray(exit.value?.keybindings);
        }),
      { timeout: 60_000, message: "server.getConfig must return keybindings" },
    )
    .toBe(true);

  return frames
    .filter(
      (frame) =>
        frame.dir === "recv" &&
        frame.json?._tag === "Exit" &&
        frame.json.exit?._tag === "Success" &&
        Array.isArray(frame.json.exit.value?.keybindings),
    )
    .at(-1)!.json.exit.value;
}

function commandSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

test("commandPalette.toggle opens outside terminal focus and enumerates keybound commands", async ({
  gotoApp,
  page,
}) => {
  const frames = recordFrames(page);
  await gotoApp(page);

  const config = await latestConfig(frames);
  const keybound = commandSet(config.keybindings.map((binding: any) => String(binding.command)));

  const terminalFocused = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest("[data-terminal-owner]") !== null;
  });
  expect(terminalFocused, "precondition: commandPalette.toggle is guarded by !terminalFocus").toBe(
    false,
  );

  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.locator('[data-slot="command-dialog-popup"]')).toBeVisible();
  await expect(page.locator('[data-slot="command-item"]').first()).toBeVisible();

  const paletteCommands = commandSet(
    await page.locator("[data-command-palette-command]").evaluateAll((nodes) =>
      nodes
        .map((node) => (node as HTMLElement).dataset.commandPaletteCommand ?? "")
        .filter((command) => command.length > 0),
    ),
  );

  expect(paletteCommands, "palette command set must match server.getConfig keybound commands").toEqual(
    keybound,
  );
});
