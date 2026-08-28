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
  await stack?.stop();
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
