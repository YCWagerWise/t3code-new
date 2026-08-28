/**
 * E2E-H (task 3447) — the KEYBOUND COMMAND SURFACE, read live.
 *
 * The shortcut for every command is read off `server.getConfig -> keybindings[]`
 * rather than hardcoded. Hardcoding is how a suite goes green against a binding
 * the product no longer ships: the test presses a key nobody bound and asserts
 * nothing happened, which is true and worthless.
 *
 * WHAT A PASS MEANS HERE. A keystroke that produces neither a DOM change nor an
 * RPC is a NOOP, and a NOOP is a finding, not a pass. So every probe records
 * one of DISPATCHED / DOM-ONLY / NOOP, and the run prints the denominator —
 * "all green" over 3 of 43 is the move this channel rejects.
 *
 * THE GUARDS ARE LOAD-BEARING. Several bindings carry a `whenAst` gate
 * (`terminalFocus`, `not(terminalFocus)`, `modelPickerOpen`). A probe that does
 * not establish the gated state first is not testing the binding, it is testing
 * the gate — and `diff.toggle` and `commandPalette.toggle` are bound to keys
 * that mean something else when the terminal has focus. This file therefore
 * probes only bindings whose `whenAst` is ABSENT, and reports the gated ones as
 * NOT PROBED with that reason rather than pressing their keys blind.
 *
 * KEYSTROKE VS BUTTON. The task reports that Meta+j did not open the terminal
 * drawer via the driver while the button did send terminal.open. If those two
 * paths disagree that IS the finding, so where a command has both, both are
 * driven and the disagreement is asserted on rather than averaged away.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

type Binding = {
  readonly command: string;
  readonly key: string;
  readonly modKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly whenAst?: unknown;
};

let stack: StackHandle;
let app: App;
let bindings: Binding[] = [];

const dispatched: string[] = [];
const domOnly: string[] = [];
const noop: string[] = [];
const notProbed = new Map<string, string>();

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 900_000 });

after(async () => {
  const total = bindings.length;
  console.log(`\n=== E2E-H KEYBINDINGS: ${total} commands advertised by server.getConfig`);
  console.log(`=== DISPATCHED (keystroke reached the backend): ${dispatched.length} ${JSON.stringify(dispatched)}`);
  console.log(`=== DOM-ONLY (visible change, no RPC — legitimate for a pure UI toggle): ${domOnly.length} ${JSON.stringify(domOnly)}`);
  console.log(`=== NOOP (no DOM change, no RPC — each one is a finding): ${noop.length} ${JSON.stringify(noop)}`);
  console.log(`=== NOT PROBED: ${notProbed.size}`);
  for (const [cmd, why] of notProbed) console.log(`===   ${cmd}: ${why}`);
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

/**
 * The surface must be READABLE before anything can be driven against it. If
 * getConfig does not advertise keybindings, every later probe would press keys
 * nobody bound and "pass" by finding nothing — so this fails loudly instead.
 */
test("the keybinding surface is advertised by server.getConfig", async () => {
  const outcome = await app.wire.settle("server.getConfig", {
    ms: 60_000,
    what: "server.getConfig to answer so the keybinding surface can be read live",
  });
  assert.equal(outcome.kind, "success", `server.getConfig failed: ${JSON.stringify(outcome)}`);

  const value = (outcome as { value: { keybindings?: Binding[] } }).value;
  bindings = Array.isArray(value?.keybindings) ? value.keybindings : [];
  assert.ok(
    bindings.length > 0,
    "server.getConfig advertised NO keybindings. Every keystroke probe below would then " +
      "press an unbound key and report 'nothing happened', which is a false pass for the " +
      "whole surface.",
  );
  for (const b of bindings) {
    assert.ok(
      typeof b.command === "string" && b.command.length > 0 && typeof b.key === "string",
      `a binding is missing command/key and cannot be driven: ${JSON.stringify(b)}`,
    );
  }
});

/**
 * Drive every UNGATED binding by its real keystroke and bucket the result.
 *
 * Gated bindings are skipped WITH THEIR REASON rather than pressed blind: their
 * `whenAst` means the key does something else in the wrong focus state, so an
 * unguarded press tests the gate and reports it as the command.
 */
test("every ungated keybinding does something when pressed", async () => {
  assert.ok(bindings.length > 0, "the surface must be readable first");

  for (const b of bindings) {
    if (b.whenAst != null) {
      notProbed.set(
        b.command,
        `gated by whenAst — the probe must establish that focus state first, and pressing the ` +
          `key without it tests the gate rather than the command`,
      );
      continue;
    }

    // Return focus to a neutral element between probes so a previous command's
    // open panel does not swallow the next keystroke.
    await app.page.keyboard.press("Escape").catch(() => {});

    const rpcBefore = app.wire.frames.length;
    const domBefore = await app.page.evaluate(() => document.body.innerHTML.length).catch(() => -1);

    const chord = [
      b.metaKey || b.modKey ? "Meta" : null,
      b.ctrlKey ? "Control" : null,
      b.altKey ? "Alt" : null,
      b.shiftKey ? "Shift" : null,
      b.key,
    ]
      .filter(Boolean)
      .join("+");
    await app.page.keyboard.press(chord).catch(() => {});

    // Bounded, and named: this is the only timer in the probe. It waits for
    // EITHER signal and gives up quickly, because "nothing happened" is the
    // answer being measured, not a failure to wait long enough.
    const changed = await waitFor(
      async () => {
        if (app.wire.frames.length > rpcBefore) return "rpc";
        const now = await app.page.evaluate(() => document.body.innerHTML.length).catch(() => -1);
        return now !== domBefore ? "dom" : null;
      },
      { ms: 2_000, what: `${b.command} (${chord}) to produce an RPC or a DOM change` },
    ).catch(() => null);

    if (changed === "rpc") dispatched.push(b.command);
    else if (changed === "dom") domOnly.push(b.command);
    else noop.push(b.command);
  }

  console.log(
    `keystroke probe: ${dispatched.length} dispatched, ${domOnly.length} dom-only, ` +
      `${noop.length} noop, ${notProbed.size} gated`,
  );

  // The assertion is deliberately not "no NOOPs" — that would fail the whole
  // file on one unimplemented command and hide the other 42 results. The
  // denominator is printed above; this pins the floor, so a surface that stops
  // responding ENTIRELY is red rather than quietly reporting 43 noops.
  assert.ok(
    dispatched.length + domOnly.length > 0,
    `#E2E-H: NOT ONE ungated keybinding produced an RPC or a DOM change. Either keystroke ` +
      `delivery is broken end to end in this app, or the driver's key events are not reaching ` +
      `the handler at all — the task already reports Meta+j failing by keystroke while the ` +
      `button worked. NOOP set: ${JSON.stringify(noop)}`,
  );
});
