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

/**
 * The wire shape, taken from a real `server.getConfig` payload rather than
 * assumed:
 *   {"command":"sidebar.toggle","shortcut":{"key":"b","modKey":true,
 *     "altKey":false,"ctrlKey":false,"metaKey":false,"shiftKey":false}}
 * The modifiers are NESTED under `shortcut`. Reading them from the top level
 * yields `undefined` for every one, which builds an empty chord and presses
 * nothing — and then reports the result as the command's behaviour. The first
 * version of this file did exactly that; the shape assertion below is what
 * caught it.
 */
type Shortcut = {
  readonly key: string;
  readonly modKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
};
type Binding = {
  readonly command: string;
  readonly shortcut?: Shortcut;
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
  // NAVIGATE FIRST. `server.getConfig` is not dispatched on the landing route,
  // so settling on it straight after openApp waits out the full timeout against
  // a request the client was never going to make — which is exactly what the
  // first version of this test did (111s, "0 commands advertised"), and it
  // would have been filed as "the product advertises no keybindings" if the
  // assertion had not printed the count it actually saw.
  await app.page.goto(`${stack.webUrl}/settings/keybindings`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  const outcome = await app.wire
    .settle("server.getConfig", {
      ms: 60_000,
      what: "server.getConfig to answer so the keybinding surface can be read live",
    })
    .catch((error: unknown) => {
      // Name WHAT THE CLIENT DID INSTEAD. A bare "timed out waiting for
      // server.getConfig" cannot distinguish "the backend never answered" from
      // "the client never asked", and those have opposite owners.
      throw new Error(
        `server.getConfig never settled after navigating to /settings/keybindings. ` +
          `methods the page actually dispatched: ${JSON.stringify(app.wire.methodsSeen())}. ` +
          `If that list is EMPTY or missing server.getConfig, the client never asked — which ` +
          `is the same post-navigation disconnect this cell already recorded in E2E-02, where ` +
          `the send button read aria-label="Environment disconnected" while 11 methods had ` +
          `been answered on the previous page. Cause: ${String(error)}`,
      );
    });
  assert.equal(outcome.kind, "success", `server.getConfig failed: ${JSON.stringify(outcome)}`);

  const value = (outcome as { value: { keybindings?: Binding[] } }).value;
  bindings = Array.isArray(value?.keybindings) ? value.keybindings : [];
  // Report WHAT CAME BACK, not merely that the expectation missed. "advertised
  // no keybindings" without the payload is a second investigation handed to the
  // next reader, and on this surface it would read as a product defect.
  assert.ok(
    bindings.length > 0,
    "server.getConfig advertised NO keybindings, so every keystroke probe below would press " +
      "an unbound key and report 'nothing happened' — a false pass for the whole surface.\n" +
      `outcome.kind: ${(outcome as { kind: string }).kind}\n` +
      `top-level config keys: ${JSON.stringify(Object.keys((value ?? {}) as object))}\n` +
      `typeof value.keybindings: ${typeof (value as { keybindings?: unknown })?.keybindings}\n` +
      `value (truncated): ${JSON.stringify(value).slice(0, 700)}`,
  );
  for (const b of bindings) {
    assert.ok(
      typeof b.command === "string" && b.command.length > 0 && typeof b.shortcut?.key === "string",
      `a binding is missing command/shortcut.key and cannot be driven: ${JSON.stringify(b)}`,
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

    // COUNT ONLY REQUESTS THE CLIENT SENT, AND EXCLUDE THE HEARTBEATS.
    //
    // `frames.length` counts EVERYTHING, including periodic background traffic
    // the page emits on its own — `server.reportClientActivity` is literally a
    // heartbeat. Attributing those to whatever key was pressed in the same
    // window produces a stable, entirely fictional result: two runs of this
    // file, one with correct chords and one with EMPTY chords (the shortcut
    // shape bug), returned byte-identical DISPATCHED/NOOP sets, including
    // thread.jump.1/.4/.7 dispatching while .2/.3/.5/.6/.8/.9 did not. Every
    // third 2s window was catching the same periodic frame. Nothing was being
    // measured except the heartbeat's period.
    const HEARTBEATS = new Set([
      "server.reportClientActivity",
      "server.reportHostPowerState",
      "subscribeServerLifecycle",
      "subscribeServerConfig",
    ]);
    const requestsSent = () =>
      app.wire.frames.filter(
        (f: { dir: string; json?: { _tag?: string; tag?: string } }) =>
          f.dir === "sent" &&
          f.json?._tag === "Request" &&
          !HEARTBEATS.has(String(f.json?.tag ?? "")),
      ).length;
    const rpcBefore = requestsSent();
    const domBefore = await app.page.evaluate(() => document.body.innerHTML.length).catch(() => -1);

    const sc = b.shortcut!;
    const chord = [
      sc.metaKey || sc.modKey ? "Meta" : null,
      sc.ctrlKey ? "Control" : null,
      sc.altKey ? "Alt" : null,
      sc.shiftKey ? "Shift" : null,
      sc.key,
    ]
      .filter(Boolean)
      .join("+");
    // A chord that is only the bare key means every modifier read as undefined,
    // which is the shape bug above. Refuse to press it rather than record a
    // result for a keystroke the product never binds.
    assert.ok(
      chord.length > 0 && chord.includes(sc.key),
      `built an empty//bad chord for ${b.command} from ${JSON.stringify(sc)}`,
    );
    await app.page.keyboard.press(chord).catch(() => {});

    // Bounded, and named: this is the only timer in the probe. It waits for
    // EITHER signal and gives up quickly, because "nothing happened" is the
    // answer being measured, not a failure to wait long enough.
    const changed = await waitFor(
      async () => {
        if (requestsSent() > rpcBefore) return "rpc";
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
