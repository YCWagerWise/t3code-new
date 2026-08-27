/**
 * ACTIONS 010-014/153 — the five `previewFocus`-gated preview keybindings.
 *
 *   preview.refresh    mod+r
 *   preview.focusUrl   mod+l
 *   preview.zoomIn     mod+= / mod++
 *   preview.zoomOut    mod+-
 *   preview.resetZoom  mod+0
 *
 * ALL FIVE ARE **BLOCKED**, NOT FAILING, AND NOT NO-OPS. The distinction is the
 * whole point of this file, so it is asserted rather than asserted-around.
 *
 * All five are advertised by the backend with `when: previewFocus`
 * (backend/src/keybindings.rs:97-102). `previewFocus` can only become true once
 * a preview pane exists. A preview pane can only exist if the server implements
 * the preview surface. It does not:
 *
 *   packages/contracts/src/rpc.ts:271-280 declares TEN preview methods
 *     preview.open / navigate / resize / refresh / close / list / reportStatus
 *     previewAutomation.connect / respond / focusHost
 *
 *   backend/src/server_main.rs implements ZERO of them
 *     $ grep -rn "preview" backend/src/
 *     server_main.rs:2670  (a comment)
 *     server_main.rs:3812  (a comment)
 *     server_main.rs:3979  review::diff_preview   <- the DIFF preview, unrelated
 *     text.rs:11           (a comment)
 *     keybindings.rs:96    push("mod+shift+j", "preview.toggle", None)
 *
 * So the server hands the client keybindings for a command surface it has not
 * implemented. `preview.toggle` is worse than the five here: it carries NO
 * `when` guard at all, so it is reachable, and pressing mod+shift+j does
 * nothing, forever, with no error.
 *
 * These specs are written to GO GREEN THE DAY PREVIEW LANDS. They are not
 * stubbed, not `.skip`-ed, and must not be deleted: `test.fixme` marks a known
 * missing capability and is reported by the runner as such, which is exactly the
 * BLOCKED row this task asks for — a `skip` would hide it and a deleted spec
 * would buy green with a smaller suite.
 *
 * WHOEVER IMPLEMENTS PREVIEW: change `test.fixme(` back to `test(` for each of
 * the five. The bodies are the real assertions and are already written.
 *
 * `test.fixme` is used in its DECLARATIVE form deliberately: the in-body form
 * runs after fixtures are constructed, which boots a backend and a browser to
 * reach a line that says "do not run this". Declared, the runner reports the row
 * without paying for the stack.
 */
import { test, expect } from "../fixtures";

/** The precondition every one of these five shares, and that nothing can satisfy today. */
async function openPreviewAndFocusIt(page: import("@playwright/test").Page) {
  // `preview.toggle` is the only ungated entry point to `previewFocus`.
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await expect(
    page.locator('[data-preview-pane], iframe[title*="preview" i]').first(),
    "preview.toggle must open a preview pane — it is the only way previewFocus " +
      "can ever become true, and all five keybindings in this file are gated on it",
  ).toBeVisible();
}

// DESCRIBE-LEVEL, NOT PER-TEST. `test.fixme(true, ...)` inside a test body is
// evaluated AFTER beforeEach, so the shared `openPreviewAndFocusIt` precondition
// ran first and the test reported a 180s TIMEOUT instead of BLOCKED. A blocked
// capability must not burn a timeout to say so.
test.describe
  .fixme("preview keybindings (previewFocus-gated) — BLOCKED: backend implements none of the 10 preview.* RPCs", () => {
  test.beforeEach(async ({ gotoApp, page }) => {
    await gotoApp(page);
  });

  test.fixme("010 preview.refresh (mod+r) reloads the preview without navigating the app", async ({
    page,
  }) => {
    await openPreviewAndFocusIt(page);
    const appUrl = page.url();
    await page.keyboard.press("ControlOrMeta+R");
    // The app must not be the thing that reloaded — that is the browser default
    // this binding has to preventDefault.
    expect(page.url()).toBe(appUrl);
  });

  test.fixme("011 preview.focusUrl (mod+l) moves focus to the preview URL bar", async ({
    page,
  }) => {
    await openPreviewAndFocusIt(page);
    await page.keyboard.press("ControlOrMeta+L");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAttribute("data-preview-url", /.*/);
  });

  test.fixme("012 preview.zoomIn (mod+= and mod++) increases preview zoom", async ({ page }) => {
    await openPreviewAndFocusIt(page);
    const pane = page.locator("[data-preview-pane]").first();
    const before = await pane.getAttribute("data-preview-zoom");
    await page.keyboard.press("ControlOrMeta+=");
    await expect(pane).not.toHaveAttribute("data-preview-zoom", before ?? "");
    // BOTH chords are advertised (mod+= and mod++); a spec that exercises only
    // one reports coverage it does not have.
    const afterFirst = await pane.getAttribute("data-preview-zoom");
    await page.keyboard.press("ControlOrMeta++");
    await expect(pane).not.toHaveAttribute("data-preview-zoom", afterFirst ?? "");
  });

  test.fixme("013 preview.zoomOut (mod+-) decreases preview zoom", async ({ page }) => {
    await openPreviewAndFocusIt(page);
    const pane = page.locator("[data-preview-pane]").first();
    const before = await pane.getAttribute("data-preview-zoom");
    await page.keyboard.press("ControlOrMeta+-");
    await expect(pane).not.toHaveAttribute("data-preview-zoom", before ?? "");
  });

  test.fixme("014 preview.resetZoom (mod+0) returns preview zoom to its default", async ({
    page,
  }) => {
    await openPreviewAndFocusIt(page);
    const pane = page.locator("[data-preview-pane]").first();
    const baseline = await pane.getAttribute("data-preview-zoom");
    await page.keyboard.press("ControlOrMeta+=");
    await expect(pane).not.toHaveAttribute("data-preview-zoom", baseline ?? "");
    await page.keyboard.press("ControlOrMeta+0");
    await expect(pane).toHaveAttribute("data-preview-zoom", baseline ?? "");
  });
});

test.describe("preview.toggle (ungated, reachable today)", () => {
  test.beforeEach(async ({ gotoApp, page }) => {
    await gotoApp(page);
  });

  /**
   * THIS ONE IS NOT BLOCKED AND IT IS THE REASON THIS FILE FOUND A DEFECT.
   *
   * `preview.toggle` is advertised with NO `when` guard, so unlike the five
   * above a user can actually reach it. It is the precondition for all of them,
   * so if it silently does nothing they are unreachable by construction. That is
   * a live product claim, testable today, and it runs.
   */
  test("009b preview.toggle is advertised to the client and must not silently do nothing", async ({
    page,
  }) => {
    const advertised = await page.evaluate(async () => {
      // Read what the SERVER advertises, not what the client hardcodes.
      const res = await fetch("/api/keybindings").catch(() => null);
      return res && res.ok ? await res.json().catch(() => null) : null;
    });
    // The binding's existence is asserted from the backend source regardless of
    // whether this route exists; see the header. What must hold at the glass is
    // that pressing it either opens something or reports why it cannot.
    const before = await page.locator("body").innerText();
    await page.keyboard.press("ControlOrMeta+Shift+J");
    const after = await page.locator("body").innerText();
    expect(
      after !== before,
      "pressing the advertised, UNGATED preview.toggle (mod+shift+j) changed nothing " +
        "in the UI. The backend advertises this keybinding (keybindings.rs:96) while " +
        "implementing none of the ten preview.* RPCs the contract declares " +
        "(rpc.ts:271-280), so the command is dead on arrival: no pane, no error, no " +
        "feedback. Either implement the preview surface or stop advertising the " +
        `binding. (advertised payload: ${JSON.stringify(advertised)?.slice(0, 200)})`,
    ).toBe(true);
  });
});
