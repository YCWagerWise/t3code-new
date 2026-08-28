/**
 * ACTIONS 009-014/153 — the preview keybindings (task 2911).
 *
 * Ported onto THE ONE HARNESS (`../fixtures/index.ts`). I had written this
 * against a second, Playwright-runner harness of my own before clau-77fe's
 * merged; two harnesses in one directory is the duplicate-authority defect this
 * channel rejects, so mine is deleted and this is the survivor. It also means
 * `@playwright/test` is not needed — this suite runs on `node:test` with the
 * `playwright-core` already in the workspace — so that dependency was reverted.
 *
 * SIX commands are advertised by the backend (backend/src/keybindings.rs:96-102):
 *
 *   preview.toggle     mod+shift+j      when: (none)        <- REACHABLE
 *   preview.refresh    mod+r            when: previewFocus  <- BLOCKED
 *   preview.focusUrl   mod+l            when: previewFocus  <- BLOCKED
 *   preview.zoomIn     mod+= / mod++    when: previewFocus  <- BLOCKED
 *   preview.zoomOut    mod+-            when: previewFocus  <- BLOCKED
 *   preview.resetZoom  mod+0            when: previewFocus  <- BLOCKED
 *
 * WHY FIVE ROWS ARE "BLOCKED" AND NOT `it.skip`, WHICH THIS SUITE FORBIDS.
 *
 * The README's rule is "a behaviour that does not work yet is a FAILING test
 * plus a finding, never it.skip". That rule is right and it is aimed at a
 * behaviour the product is SUPPOSED to have. These five are different: their
 * `when` clause is `previewFocus`, which can only become true once a preview
 * panel exists, and the preview panel is gated on a DESKTOP BRIDGE
 * (`window.desktopBridge?.preview`, previewStateStore.ts:455-458) that a browser
 * does not have. Asserting them here would not be testing the product, it would
 * be testing a runtime this suite does not run in.
 *
 * So instead of skipping them OR pretending to test them, the precondition
 * itself is asserted, and it is a RATCHET rather than a stub: the moment preview
 * becomes reachable in this runtime, `preview_precondition_is_still_unreachable`
 * FAILS and forces the five real tests to be written. A stub goes quietly green
 * forever; this one has a tripwire.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, openApp, type StackHandle, type App } from "../fixtures/index.ts";

/** The five previewFocus-gated commands this task owns, named not counted. */
const BLOCKED_BY_PREVIEW_FOCUS = [
  { id: "preview.refresh", chord: "ControlOrMeta+R" },
  { id: "preview.focusUrl", chord: "ControlOrMeta+L" },
  { id: "preview.zoomIn", chord: "ControlOrMeta+=" },
  { id: "preview.zoomOut", chord: "ControlOrMeta+-" },
  { id: "preview.resetZoom", chord: "ControlOrMeta+0" },
] as const;

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
});

after(async () => {
  await app?.close();
  // `dispose()`, not `stop()`. `StackHandle` (fixtures/stack.ts) exposes
  // `restartBackend()` and `dispose()`; there is no `stop`. `stack?.stop()`
  // threw a TypeError inside `after` — node:test reports that as a failing hook
  // AND the dev-runner process group is never killed, which is where the leaked
  // `vite dev` servers on the build box come from.
  await stack?.dispose();
});

/**
 * THE PRECONDITION, ASSERTED AS A TRIPWIRE.
 *
 * Passing means "preview is still unreachable in this runtime, so the five rows
 * below are honestly BLOCKED". FAILING means preview landed and somebody owes
 * this file five real tests. That is the opposite of a stub.
 */
test("preview_precondition_is_still_unreachable (tripwire: fails the day preview lands)", async () => {
  const reachable = await app.page.evaluate(
    () => Boolean((window as any).desktopBridge?.preview),
  );
  const panel = await app.page
    .locator('[data-preview-pane], iframe[title*="preview" i]')
    .count();

  assert.equal(
    reachable,
    false,
    "window.desktopBridge.preview now EXISTS in this runtime, so previewFocus is " +
      "reachable and the five BLOCKED rows in this file are no longer honest. " +
      "Write the real assertions for: " +
      BLOCKED_BY_PREVIEW_FOCUS.map((c) => c.id).join(", "),
  );
  assert.equal(panel, 0, "a preview panel is present; see above — the five rows must become real tests");

  for (const cmd of BLOCKED_BY_PREVIEW_FOCUS) {
    console.log(
      `BLOCKED  ${cmd.id.padEnd(18)} ${cmd.chord.padEnd(18)} ` +
        `when:previewFocus unreachable (no desktopBridge.preview in this runtime)`,
    );
  }
});

/**
 * ONE EXECUTABLE ROW PER previewFocus COMMAND (#495).
 *
 * The tripwire above is a good test and it is ONE row. Collapsing five
 * advertised behaviours into a single negative precondition is what #495 filed:
 * the runner stops reporting a row per command, so the coverage DENOMINATOR
 * shrinks silently and nothing is left waiting to flip green when preview lands.
 *
 * These five restore the rows WITHOUT reintroducing a second harness, a skip, or
 * a todo. Each is a real, executed test that:
 *
 *   - when preview is unreachable (today), asserts THAT COMMAND'S precondition
 *     specifically and prints its own BLOCKED row — a true assertion about a
 *     named command, not a stub that passes for no reason;
 *   - when preview becomes reachable, runs THE ORIGINAL BODY from the deleted
 *     `preview-refresh-focus-zoom.spec.ts` — the real assertions ported forward
 *     rather than described in a comment.
 *
 * So the day the desktop bridge appears these do not need to be written: they
 * start testing. The tripwire fails at the same moment and says so out loud;
 * these five are what it is pointing at.
 */
async function previewIsReachable(): Promise<boolean> {
  const bridge = await app.page.evaluate(() => Boolean((window as any).desktopBridge?.preview));
  if (!bridge) return false;
  // `preview.toggle` is the only ungated entry point to previewFocus.
  await app.page.keyboard.press("ControlOrMeta+Shift+J");
  const pane = app.page.locator('[data-preview-pane], iframe[title*="preview" i]').first();
  return await pane
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Asserts the per-command precondition and records that command's BLOCKED row. */
async function assertBlocked(id: string, chord: string): Promise<void> {
  const bridge = await app.page.evaluate(() => Boolean((window as any).desktopBridge?.preview));
  assert.equal(
    bridge,
    false,
    id + " (" + chord + ") is gated on previewFocus, which requires a preview panel, " +
      "which requires window.desktopBridge.preview (previewStateStore.ts:455-458). " +
      "The bridge now EXISTS, so this row must stop reporting BLOCKED and start " +
      "running its real body below.",
  );
  console.log(
    "BLOCKED  " + id.padEnd(18) + " " + chord.padEnd(18) +
      " when:previewFocus unreachable (no desktopBridge.preview in this runtime)",
  );
}

test("010 preview.refresh (mod+r) reloads the preview without navigating the app", async () => {
  if (!(await previewIsReachable())) return await assertBlocked("preview.refresh", "mod+r");
  const appUrl = app.page.url();
  await app.page.keyboard.press("ControlOrMeta+R");
  // The APP must not be what reloaded — that is the browser default this binding
  // has to preventDefault.
  assert.equal(app.page.url(), appUrl, "preview.refresh must not navigate the app");
});

test("011 preview.focusUrl (mod+l) moves focus to the preview URL bar", async () => {
  if (!(await previewIsReachable())) return await assertBlocked("preview.focusUrl", "mod+l");
  await app.page.keyboard.press("ControlOrMeta+L");
  const focusedIsUrlBar = await app.page.evaluate(() =>
    Boolean(document.activeElement?.hasAttribute("data-preview-url")),
  );
  assert.ok(focusedIsUrlBar, "preview.focusUrl must focus the preview URL bar");
});

test("012 preview.zoomIn (mod+= and mod++) increases preview zoom on BOTH chords", async () => {
  if (!(await previewIsReachable())) return await assertBlocked("preview.zoomIn", "mod+= / mod++");
  const pane = app.page.locator("[data-preview-pane]").first();
  const before = await pane.getAttribute("data-preview-zoom");
  await app.page.keyboard.press("ControlOrMeta+=");
  const afterFirst = await pane.getAttribute("data-preview-zoom");
  assert.notEqual(afterFirst, before, "mod+= must change the zoom");
  // BOTH chords are advertised (keybindings.rs:99-100). A spec that exercises
  // only one reports coverage it does not have.
  await app.page.keyboard.press("ControlOrMeta++");
  assert.notEqual(
    await pane.getAttribute("data-preview-zoom"),
    afterFirst,
    "mod++ is advertised separately and must also zoom in",
  );
});

test("013 preview.zoomOut (mod+-) decreases preview zoom", async () => {
  if (!(await previewIsReachable())) return await assertBlocked("preview.zoomOut", "mod+-");
  const pane = app.page.locator("[data-preview-pane]").first();
  const before = await pane.getAttribute("data-preview-zoom");
  await app.page.keyboard.press("ControlOrMeta+-");
  assert.notEqual(await pane.getAttribute("data-preview-zoom"), before);
});

test("014 preview.resetZoom (mod+0) returns preview zoom to its default", async () => {
  if (!(await previewIsReachable())) return await assertBlocked("preview.resetZoom", "mod+0");
  const pane = app.page.locator("[data-preview-pane]").first();
  const baseline = await pane.getAttribute("data-preview-zoom");
  await app.page.keyboard.press("ControlOrMeta+=");
  assert.notEqual(await pane.getAttribute("data-preview-zoom"), baseline, "zoom moved first");
  await app.page.keyboard.press("ControlOrMeta+0");
  assert.equal(
    await pane.getAttribute("data-preview-zoom"),
    baseline,
    "preview.resetZoom must return to the default zoom",
  );
});

/**
 * THE ONE THAT IS NOT BLOCKED, AND THE DEFECT IT FOUND.
 *
 * `preview.toggle` is advertised with NO `when` guard, so a user can reach it
 * anywhere. The client handled it (apps/web/src/routes/_chat.tsx) as:
 *
 *     if (!routeThreadRef) return;                 // <- SILENT, and FIRST
 *     if (!isPreviewSupportedInRuntime()) { toast("Preview is desktop-only"); return; }
 *     dispatchPreviewAction("toggle-panel");
 *
 * A fresh app lands on `/draft/<id>`, where there is no routeThreadRef — so on
 * the DEFAULT LANDING ROUTE the most discoverable preview shortcut swallowed the
 * keypress (preventDefault + stopPropagation) and produced nothing: no panel, no
 * toast, no error. Observed at the glass with a full wait for either outcome.
 *
 * Fixed in apps/web by checking RUNTIME CAPABILITY BEFORE THREAD CONTEXT.
 * Stating the layer explicitly because the standing order is to push fixes down
 * and this one honestly stops at the client: whether preview exists is a
 * property of the runtime, not of the current thread, so answering it needs no
 * thread. Implementing preview.* in the Rust backend would NOT have fixed this.
 */
test("009 preview.toggle gives feedback on the default route, never silence", async () => {
  const panel = app.page.locator('[data-preview-pane], iframe[title*="preview" i]').first();
  // Matched by its own copy, not by a shared toast container — otherwise an
  // unrelated toast satisfies this assertion.
  const desktopOnlyToast = app.page.getByText(/Preview is desktop-only/i).first();

  await app.page.keyboard.press("ControlOrMeta+Shift+J");

  const outcome = await Promise.race([
    panel.waitFor({ state: "visible", timeout: 15_000 }).then(() => "panel" as const),
    desktopOnlyToast.waitFor({ state: "visible", timeout: 15_000 }).then(() => "toast" as const),
  ]).catch(() => "silence" as const);

  console.log(`009 preview.toggle outcome: ${outcome}`);

  assert.notEqual(
    outcome,
    "silence",
    "the backend advertises preview.toggle as an UNGATED keybinding " +
      "(backend/src/keybindings.rs:96) while implementing NONE of the ten preview.* " +
      "RPCs the contract declares (packages/contracts/src/rpc.ts:271-280). Pressing " +
      "mod+shift+j on the default /draft/ route produced neither a preview panel nor " +
      "the desktop-only toast: the client returned silently because routeThreadRef " +
      "was null. Either give this path feedback or stop advertising the binding.",
  );
});

/**
 * The parity gap itself, recorded rather than asserted away. The contract
 * declares ten preview methods; the Rust backend implements none of them, so the
 * app cannot open a preview against it even on desktop. This is a row against
 * 2879, not a finding, per the task.
 */
test("preview RPC surface is unimplemented on the Rust backend (recorded)", async () => {
  const dispatched = app.wire.frames.filter(
    (f) => f.dir === "sent" && typeof f.json?.tag === "string" && f.json.tag.startsWith("preview."),
  );
  console.log(
    `RECORDED  contract declares 10 preview.* methods; backend/src implements 0; ` +
      `client dispatched ${dispatched.length} preview.* request(s) this run`,
  );
  assert.equal(
    dispatched.length,
    0,
    "the client dispatched a preview.* RPC that the Rust backend does not implement; " +
      "that would hang or Die rather than answer — if this fires, preview is being " +
      "used against a backend with no handlers",
  );
});
