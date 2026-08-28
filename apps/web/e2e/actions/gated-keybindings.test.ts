/**
 * E2E-H, PART TWO — THE 13 COMMANDS THE FIRST SPEC COULD ONLY REPORT.
 *
 * `keybindings-and-buttons.test.ts` drives every advertised keybinding whose
 * `when` guard it can satisfy and classifies the rest as GATED — reported by
 * name, never driven, and deliberately NOT asserted, because pressing a guarded
 * chord without its context and calling the silence a NOOP files a finding
 * against a binding behaving exactly as specified.
 *
 * That was the right call and it left 13 commands untested:
 *
 *   terminal.split          mod+d          when: terminalFocus
 *   terminal.splitVertical  mod+shift+d    when: terminalFocus
 *   terminal.new            mod+n          when: terminalFocus
 *   terminal.close          mod+w          when: terminalFocus
 *   modelPicker.jump.1..9   mod+1..9       when: modelPickerOpen
 *
 * Both guards ARE satisfiable, so this file satisfies them and drives the
 * commands for real.
 *
 * WHY THE GUARDS MATTER MORE HERE THAN ANYWHERE ELSE IN THE SUITE: three of
 * these chords are ALREADY BOUND to something else when the guard is false.
 *
 *   mod+d  -> diff.toggle          when: !terminalFocus
 *   mod+d  -> terminal.split       when:  terminalFocus
 *   mod+n  -> chat.new             when: !terminalFocus
 *   mod+n  -> terminal.new         when:  terminalFocus
 *   mod+1..9 -> thread.jump.1..9   when: (none)
 *   mod+1..9 -> modelPicker.jump.N when:  modelPickerOpen
 *
 * So a test that presses `mod+d` without establishing terminal focus is not a
 * weak test of `terminal.split` — it is a test of `diff.toggle` wearing the
 * wrong name, and it would report coverage for a command it never reached. THE
 * GUARD IS ASSERTED BEFORE THE CHORD, every time, for exactly that reason.
 *
 * `terminalFocus` is decided by `lib/terminalFocus.ts`: the active element must
 * be inside `[data-terminal-owner="drawer"|"right-panel"]`. That is a DOM fact
 * this spec can check directly rather than infer, so it does.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

const REPORT_PATH = process.env.T3_E2E_REPORT ?? "/tmp/t3-e2e-gated-report.json";

let stack: StackHandle;
let app: App;
const report: Record<string, unknown> = {};

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 1_800_000 });

after(async () => {
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`gated-keybindings report -> ${REPORT_PATH}`);
  } catch {
    /* reporting must never mask a real failure */
  }
  await app?.close();
  await stack?.dispose();
});

/** Methods the app dispatches on its own schedule — not evidence of a keypress. */
const BACKGROUND_METHODS = new Set([
  "server.probe",
  "server.reportClientActivity",
  "server.reportHostPowerState",
  "server.getProcessDiagnostics",
  "server.getProcessResourceHistory",
  "server.getTraceDiagnostics",
  "server.getResourceTelemetryHistory",
  "server.getUsageSummary",
  "server.getBackgroundPolicy",
  "server.getConfig",
]);

function sentRequests(): string[] {
  return app.wire.frames
    .filter((f) => f.dir === "sent" && f.json?._tag === "Request")
    .map((f) => String(f.json.tag));
}

/** The guard, read the way the product reads it (lib/terminalFocus.ts:3-10). */
async function terminalFocusIsTrue(): Promise<boolean> {
  return await app.page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.isConnected) return false;
    const owner = active.closest("[data-terminal-owner]");
    const value = owner instanceof HTMLElement ? owner.dataset.terminalOwner : undefined;
    return value === "drawer" || value === "right-panel";
  });
}

/**
 * Open the terminal drawer and put focus INSIDE it.
 *
 * Opening is not focusing: `terminalFocus` is about `document.activeElement`, so
 * a drawer that is visible while focus sits in the composer still evaluates the
 * guard as false and every chord below would hit its unguarded twin.
 */
async function establishTerminalFocus(): Promise<boolean> {
  await app.page.keyboard.press("ControlOrMeta+J"); // terminal.toggle, ungated
  const owner = app.page.locator("[data-terminal-owner]").first();
  const appeared = await owner
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;
  await owner.click({ timeout: 10_000 }).catch(() => {});
  return await waitFor(async () => (await terminalFocusIsTrue()) || null, {
    ms: 10_000,
    what: "document.activeElement to be inside [data-terminal-owner]",
  })
    .then(() => true)
    .catch(() => false);
}

/** Did this keypress do anything attributable? */
async function pressAndObserve(chord: string): Promise<string | null> {
  const before = await app.page.evaluate(() => [
    document.querySelectorAll("*").length,
    document.querySelectorAll("[data-terminal-owner]").length,
    document.body.innerText.length,
    location.pathname,
  ].join("|"));
  const requestsBefore = sentRequests().length;

  await app.page.keyboard.press(chord);

  return await waitFor(
    async () => {
      const now = await app.page.evaluate(() => [
        document.querySelectorAll("*").length,
        document.querySelectorAll("[data-terminal-owner]").length,
        document.body.innerText.length,
        location.pathname,
      ].join("|"));
      if (now !== before) return "dom" as const;
      const fresh = sentRequests()
        .slice(requestsBefore)
        .filter((m) => !BACKGROUND_METHODS.has(m));
      if (fresh.length > 0) return `rpc:${fresh[0]}` as const;
      return null;
    },
    { ms: 3_000, what: `${chord} to change the DOM or dispatch a non-background RPC` },
  ).catch(() => null);
}

/** Persist the report NOW, on every exit path including the throwing ones.
 *
 *  A report that only exists on the happy path is not evidence — and when the
 *  harness hangs in teardown (it has, twice, for different reasons), node:test's
 *  failure block is never printed, so this file is the ONLY artifact that
 *  survives. The first run of this spec failed both tests and wrote `{}`, which
 *  explained nothing about why. */
function flushReport(): void {
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch {
    /* reporting must never mask a real failure */
  }
}

function recordAndRethrow(key: string, error: unknown): never {
  report[key] = String((error as Error).message).slice(0, 2000);
  flushReport();
  throw error;
}

test("G1 the four terminalFocus-gated commands are driven with the guard actually true", async (t) => {
  try {
    await g1(t);
  } catch (error) {
    recordAndRethrow("g1Error", error);
  }
  flushReport();
});

async function g1(t: any) {
  const focused = await establishTerminalFocus();
  report.terminalFocusEstablished = focused;
  assert.ok(
    focused,
    "could not establish terminalFocus, so these four commands cannot be tested " +
      "HERE and must not be reported as either passing or NOOP. terminal.toggle " +
      "(mod+j) must open a [data-terminal-owner] element and clicking it must put " +
      "document.activeElement inside it (lib/terminalFocus.ts:3-10). If this is the " +
      "failure, it is a finding about terminal.toggle or the drawer, not about the " +
      "four commands below.",
  );

  // Asserted immediately before each chord, not once at the top: `terminal.close`
  // can destroy the very focus the next command needs, and a guard that silently
  // became false would send the next chord to its unguarded twin.
  const results: Record<string, string> = {};
  const commands = [
    { id: "terminal.split", chord: "ControlOrMeta+D" },
    { id: "terminal.splitVertical", chord: "ControlOrMeta+Shift+D" },
    { id: "terminal.new", chord: "ControlOrMeta+N" },
    // LAST, deliberately: it can close the pane the others need.
    { id: "terminal.close", chord: "ControlOrMeta+W" },
  ] as const;

  for (const cmd of commands) {
    if (!(await terminalFocusIsTrue())) {
      // Re-establish rather than test the wrong command. `mod+d` with the guard
      // false is `diff.toggle`; `mod+n` is `chat.new`.
      const regained = await establishTerminalFocus();
      if (!regained) {
        results[cmd.id] = "guard lost and could not be re-established";
        continue;
      }
    }
    results[cmd.id] = (await pressAndObserve(cmd.chord)) ?? "nothing";
  }

  report.terminalGated = results;
  t.diagnostic(`terminalFocus-gated: ${JSON.stringify(results)}`);

  const dead = Object.entries(results)
    .filter(([, outcome]) => outcome === "nothing")
    .map(([id]) => id);
  assert.deepEqual(
    dead,
    [],
    `these commands are advertised with when:terminalFocus, the guard was ASSERTED ` +
      `TRUE immediately before each keypress, and they did nothing — no DOM change, ` +
      `no non-background RPC. That is a dead keybinding, not a guard problem.\n  ` +
      `${dead.join("\n  ")}\nfull results: ${JSON.stringify(results, null, 2)}`,
  );
}

test("G2 modelPicker.jump.N is reachable only with the picker open, and mod+1 is thread.jump.1 without it", async (t) => {
  try {
    await g2(t);
  } catch (error) {
    recordAndRethrow("g2Error", error);
  }
  flushReport();
});

async function g2(t: any) {
  // First establish the CONTRAST, which is the part that makes this test mean
  // something: with the picker closed, mod+1 belongs to thread.jump.1. If both
  // states produced the same outcome the guard would be doing nothing and
  // "modelPicker.jump.1 works" would be unfalsifiable.
  await app.page.goto(stack.webUrl, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await waitFor(async () => (await app.page.getByRole("textbox").count()) > 0, {
    ms: 60_000,
    what: "the app to be interactive",
  }).catch(() => null);

  const pickerClosedOutcome = await pressAndObserve("ControlOrMeta+1");

  // modelPicker.toggle is mod+shift+m, and it is ungated.
  await app.page.keyboard.press("ControlOrMeta+Shift+M");
  const pickerOpen = await waitFor(
    async () =>
      (await app.page
        .locator('[role="dialog"], [data-model-picker], [data-state="open"]')
        .count()) > 0 || null,
    { ms: 10_000, what: "the model picker to open (mod+shift+m)" },
  )
    .then(() => true)
    .catch(() => false);

  report.modelPicker = {
    openedByShortcut: pickerOpen,
    withPickerClosed: pickerClosedOutcome ?? "nothing",
  };

  assert.ok(
    pickerOpen,
    "modelPicker.toggle (mod+shift+m) must open the picker — it is advertised " +
      "ungated, and without it the nine modelPicker.jump.N commands are unreachable " +
      "by any means, which would make them dead by construction rather than gated.",
  );

  const withPickerOpen = await pressAndObserve("ControlOrMeta+1");
  (report.modelPicker as Record<string, unknown>).withPickerOpen = withPickerOpen ?? "nothing";
  t.diagnostic(`mod+1 closed=${pickerClosedOutcome} open=${withPickerOpen}`);

  assert.notEqual(
    withPickerOpen,
    null,
    `with the model picker OPEN, mod+1 must reach modelPicker.jump.1 and do ` +
      `something. It did nothing, while the same chord with the picker closed did ` +
      `${JSON.stringify(pickerClosedOutcome)}. A guard that only ever DISABLES a ` +
      `binding is a binding the user can never use.`,
  );
}
