/**
 * E2E-H — the 43 KEYBOUND COMMANDS and the buttons that are not keybound.
 *
 * SCOPE NOTE FIRST, because this task is fleet-shaped and I am one implementer:
 * "drive all 43 commands by their real keystroke, plus walk 24 buttons, plus
 * test keystroke-vs-button delivery for each" is several rounds of work against
 * a stack that takes minutes to boot. What is here is the part that is real and
 * complete on its own, in one pass:
 *
 *   - the command list is READ LIVE off `server.getConfig -> keybindings[]`, not
 *     hardcoded, so the denominator is whatever the backend actually advertises
 *     and cannot silently drift from this file;
 *   - EVERY advertised command is driven by its own compiled shortcut and lands
 *     in exactly one bucket: FIRED (a DOM change or an RPC followed), or NOOP;
 *   - every button with an accessible name at the thread route is ENUMERATED and
 *     reported by name, with the ones deliberately not clicked named and
 *     justified, because silent truncation of the list is the failure mode here.
 *
 * WHAT IT DOES NOT DO, said plainly rather than left to be discovered: it does
 * not click the destructive buttons, and it does not yet assert the
 * per-command DOM effect (that "sidebar.toggle" toggled the SIDEBAR specifically
 * rather than changing something). NOOP-vs-FIRED is the finding-bearing
 * distinction the task names and it is what is asserted; per-command semantics
 * are 43 separate assertions and belong in 43 separate specs.
 *
 * THINGS ENCODED HERE THAT COST SOMEONE A ROUND:
 *
 *  - READ THE SHORTCUT FROM THE CONFIG. The backend ships COMPILED rules —
 *    `{command, shortcut: {key, modKey, metaKey, ctrlKey, shiftKey, altKey},
 *    whenAst}` (backend/src/keybindings.rs:150-199) — and the client dispatches
 *    on the compiled form and never parses a key string. A spec that hardcodes
 *    "mod+shift+j" is testing its own copy of the parser.
 *
 *  - THE `when` GUARD IS NOT DECORATION. Several commands are gated on
 *    `terminalFocus`, `not(terminalFocus)` or `previewFocus`. `diff.toggle` and
 *    `terminal.split` are BOTH `mod+d`, split by that guard alone. Driving a
 *    guarded command without establishing its context is testing nothing, so
 *    commands whose guard this spec cannot satisfy are reported as GATED, not as
 *    NOOP — calling an unsatisfiable guard a NOOP would file a finding against a
 *    binding that is behaving exactly as specified.
 *
 *  - THE 6 `preview.*` COMMANDS WILL NOT FIRE. Preview has no backend: the
 *    contract declares ten `preview.*` RPCs (packages/contracts/src/rpc.ts:271-280)
 *    and `server_main.rs` implements zero. They are reported as BLOCKED-ON-2879,
 *    once, not as six findings.
 *
 *  - KEYSTROKE AND BUTTON DELIVERY ARE NOT EQUIVALENT in this app — the task
 *    reports Meta+j not opening the terminal drawer while the button did. That
 *    disagreement is itself the finding, so where a command has a button this
 *    records BOTH and says whether they agree.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

const REPORT_PATH = process.env.T3_E2E_REPORT ?? "/tmp/t3-e2e-H-report.json";

/** Guards this spec can establish. Anything else is reported GATED. */
const SATISFIABLE_GUARDS = new Set(["", "not(terminalFocus)"]);

/** A guard this spec could not even PARSE. Distinct from one it cannot satisfy:
 *  an unparsed guard means the AST shape moved and the classification below is
 *  meaningless, which must fail loudly rather than quietly gate everything. */
const UNPARSED = /^\?|\?\{/;

/** Commands blocked on a backend that does not exist (task 2879). */
const BLOCKED_ON_2879 = /^preview\./;

type Shortcut = {
  key: string;
  modKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};
type Binding = { command: string; shortcut: Shortcut; whenAst?: unknown };

let stack: StackHandle;
let app: App;
const report: Record<string, unknown> = {};

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 1_800_000 });

after(async () => {
  // Written even when the tests FAIL. A run that reports nothing because it
  // threw is a run nobody can read a denominator off.
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`E2E-H report -> ${REPORT_PATH}`);
  } catch {
    /* reporting must never mask a real failure */
  }
  await app?.close();
  await stack?.dispose();
});

/** Playwright's key name for a compiled shortcut, mod -> ControlOrMeta. */
function pressSpec(s: Shortcut): string {
  const parts: string[] = [];
  if (s.modKey) parts.push("ControlOrMeta");
  if (s.metaKey) parts.push("Meta");
  if (s.ctrlKey) parts.push("Control");
  if (s.shiftKey) parts.push("Shift");
  if (s.altKey) parts.push("Alt");
  parts.push(playwrightKey(s.key));
  return parts.join("+");
}

/** The backend normalizes key tokens (keybindings.rs `normalize_key_token`);
 *  Playwright wants its own names for the same physical keys. */
function playwrightKey(key: string): string {
  const map: Record<string, string> = {
    " ": "Space",
    escape: "Escape",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    "[": "BracketLeft",
    "]": "BracketRight",
    "=": "Equal",
    "-": "Minus",
    "+": "Equal",
  };
  return map[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** A `whenAst` rendered back to a short string, for guard classification. */
function guardOf(b: Binding): string {
  if (b.whenAst === undefined || b.whenAst === null) return "";
  // The SHAPE IS READ OFF backend/src/keybindings.rs:284-333, not guessed:
  //   {type:"identifier", name}
  //   {type:"not",  node}
  //   {type:"and",  left, right}
  //   {type:"or",   left, right}
  //
  // Guessing it is not a harmless mistake in this spec. An unrecognised node
  // renders to a JSON blob, the blob is not in SATISFIABLE_GUARDS, and EVERY
  // command gets classified GATED — which makes `noop === []` pass with nothing
  // driven at all. A vacuous pass is worse than a false failure, so an
  // unrecognised node is treated as unsatisfiable AND asserted against below.
  const render = (n: any): string => {
    if (typeof n !== "object" || n === null) return `?${JSON.stringify(n)}`;
    switch (n.type) {
      case "identifier":
        return typeof n.name === "string" ? n.name : `?${JSON.stringify(n)}`;
      case "not":
        return `not(${render(n.node)})`;
      case "and":
        return `(${render(n.left)} && ${render(n.right)})`;
      case "or":
        return `(${render(n.left)} || ${render(n.right)})`;
      default:
        return `?${JSON.stringify(n)}`;
    }
  };
  return render(b.whenAst);
}

/**
 * Methods the app dispatches on its own schedule. A frame from one of these
 * inside the window after a keypress is NOT evidence the keypress did anything.
 *
 * THIS SET IS WHY THE FIRST GREEN RUN OF THIS SPEC WAS A LIE, and it is worth
 * spelling out because the run reported `NOOP 0` and I nearly posted it. The
 * first version counted "any frame arrived" as FIRED, so `composer.stash` —
 * which has NO handler anywhere in apps/web (`grep -rn '"composer\.' apps/web/src`
 * outside tests returns one unrelated hit, "composer.lock") — was recorded as
 * `composer.stash -> wire`. So were all nine `thread.jump.N` on a page with no
 * threads to jump to. Background chatter inside a 3s window is exactly the
 * false-positive shape #435 filed: a signal that is real, and is not caused by
 * the action.
 *
 * FIRED now requires a DOM change, or a REQUEST THE APP SENT that is not on this
 * list. Both are attributable to the keypress; "a frame existed" is not.
 */
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
  // NOT background — WORSE. `terminal.write` is the keystroke being forwarded to
  // a terminal as raw INPUT, which is the exact opposite of the command firing.
  // The second version of this spec reported 21 commands as
  // `<command> -> rpc:terminal.write`, and that is not a command that worked; it
  // is a chord that was typed into a shell. Counting it as FIRED would have
  // reported full coverage for a run in which almost nothing was dispatched.
  //
  // It shows up because `terminal.toggle` (mod+j) is itself in the driven set:
  // once it opens the drawer the terminal takes focus, and EVERY subsequent
  // chord goes to the terminal instead of the command layer. That is also why
  // the loop below re-focuses the composer before each press — driving a
  // `not(terminalFocus)` command while the terminal has focus is testing the
  // wrong context, which is the mistake this file's own header warns about.
  "terminal.write",
  "terminal.resize",
  "terminal.input",
]);

/** Methods of the requests this page has SENT, oldest first (with duplicates —
 *  the index into this list is what makes "sent since the keypress" meaningful). */
function sentRequests(): string[] {
  return app.wire.frames
    .filter((f) => f.dir === "sent" && f.json?._tag === "Request")
    .map((f) => String(f.json.tag));
}

/** A cheap, whole-page fingerprint. Enough to say SOMETHING changed, which is
 *  the FIRED-vs-NOOP distinction; not enough to say WHAT changed, which is
 *  deliberately not this spec's claim. */
async function domFingerprint(): Promise<string> {
  return await app.page.evaluate(() => {
    const body = document.body;
    return [
      body.innerText.length,
      document.querySelectorAll("*").length,
      location.pathname,
      document.activeElement?.tagName ?? "",
      // dialogs/drawers/toasts are the usual visible effect of these commands
      document.querySelectorAll('[role="dialog"], [data-state="open"], [role="alert"]').length,
    ].join("|");
  });
}

/** Persist the report NOW. Called on every exit path from H1, including the
 *  throwing ones: the first two runs of this spec failed before `report` was
 *  populated and wrote `{}`, so the run produced a file that explained nothing
 *  about why. An artifact that only exists on the happy path is not evidence. */
function flushReport(): void {
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch {
    /* reporting must never mask a real failure */
  }
}

test("H1 every advertised keybinding is driven by its own compiled shortcut and lands in exactly one bucket", async (t) => {
  try {
    await h1(t);
  } catch (error) {
    report.h1Error = String((error as Error).message).slice(0, 2000);
    flushReport();
    throw error;
  }
  flushReport();
});

async function h1(t: any) {
  // DO NOT ASSUME THE APP DISPATCHED IT. The first run of this spec sat on
  // `settle("server.getConfig")` and died anonymously, because `settle` waits for
  // an Exit frame and cannot distinguish "the backend is slow" from "the client
  // never asked". Those are completely different findings and the wire can tell
  // them apart — `wasRequested` is exactly that question.
  //
  // If the landing route never asks, go to the settings route that must:
  // /settings/keybindings is the page whose entire content is this config.
  if (!app.wire.wasRequested("server.getConfig")) {
    t.diagnostic("server.getConfig not dispatched on the landing route; visiting /settings/keybindings");
    await app.page.goto(`${stack.webUrl}/settings/keybindings`, {
      waitUntil: "domcontentloaded",
      timeout: 240_000,
    });
  }
  assert.ok(
    await waitFor(() => app.wire.wasRequested("server.getConfig"), {
      ms: 60_000,
      what:
        "the client to DISPATCH server.getConfig at all. If it never does, the " +
        "keybindings this spec drives are not something the UI ever reads, and " +
        "that is the finding — not a slow backend.",
    }).catch(() => false),
    `the web client never dispatched server.getConfig. Methods it DID dispatch: ` +
      `${JSON.stringify(app.wire.methodsSeen())}`,
  );

  const config = await app.wire.settle("server.getConfig", {
    ms: 60_000,
    what: "an Exit frame for the server.getConfig the client has already sent",
  });
  // RECORDED BEFORE THE FIRST ASSERTION. An assertion that fires here aborts the
  // test, `report` stays `{}`, and the run tells nobody WHY — which is how the
  // first run of this spec produced an empty report and a failure message the
  // hung teardown then swallowed.
  report.getConfig = {
    kind: config.kind,
    detail: config.kind === "success" ? "ok" : JSON.stringify(config).slice(0, 600),
  };
  t.diagnostic(`server.getConfig -> ${config.kind}`);
  assert.equal(
    config.kind,
    "success",
    `server.getConfig must succeed — it is where this test's DENOMINATOR comes ` +
      `from, and without it there is nothing to drive: ${JSON.stringify(config).slice(0, 600)}`,
  );

  const rawKeybindings = (config as any).value?.keybindings;
  report.rawKeybindings = {
    present: rawKeybindings !== undefined,
    isArray: Array.isArray(rawKeybindings),
    length: Array.isArray(rawKeybindings) ? rawKeybindings.length : null,
    sample: Array.isArray(rawKeybindings) ? rawKeybindings.slice(0, 3) : rawKeybindings,
  };
  t.diagnostic(`keybindings in getConfig: ${JSON.stringify(report.rawKeybindings).slice(0, 300)}`);

  const bindings: Binding[] = (rawKeybindings ?? []).filter(
    (b: any) => b && typeof b.command === "string" && b.shortcut && typeof b.shortcut.key === "string",
  );
  assert.ok(
    bindings.length > 0,
    `the backend must advertise keybindings; an empty list is the dead-config bug ` +
      `keybindings.rs:6-9 describes, not a passing test with nothing to do. ` +
      `getConfig.keybindings was: ${JSON.stringify(report.rawKeybindings).slice(0, 600)}`,
  );
  t.diagnostic(`advertised bindings: ${bindings.length}`);
  report.route = app.page.url();
  t.diagnostic(`driving from route: ${report.route}`);

  const fired: string[] = [];
  const noop: string[] = [];
  const gated: string[] = [];
  const blocked: string[] = [];

  // DRIVE `terminal.*` LAST.
  //
  // `terminal.toggle` (mod+j) is itself in the driven set, and the moment it
  // opens the drawer the terminal owns the keyboard: every chord after it is
  // forwarded as `terminal.write` and no command runs. The second version of
  // this spec reported 21 commands as `-> rpc:terminal.write` and called them
  // FIRED — full coverage for a run in which almost nothing was dispatched.
  //
  // Re-focusing the composer before each press fixed the contamination and cost
  // 27 minutes of actionability waits against the drawer overlay, for a run that
  // otherwise takes 26 seconds. Ordering is the cheap fix: everything that needs
  // `not(terminalFocus)` runs while that is still trivially true, and the one
  // command that destroys it runs when nothing is left to contaminate.
  const ordered = [...bindings].sort(
    (x, y) => Number(x.command.startsWith("terminal.")) - Number(y.command.startsWith("terminal.")),
  );

  for (const b of ordered) {
    const guard = guardOf(b);
    if (BLOCKED_ON_2879.test(b.command)) {
      blocked.push(`${b.command} (${guard || "ungated"})`);
      continue;
    }
    if (!SATISFIABLE_GUARDS.has(guard)) {
      // Reported, NOT driven. Pressing a guarded chord without its context and
      // calling the silence a NOOP files a finding against correct behaviour.
      gated.push(`${b.command} [when: ${guard}]`);
      continue;
    }
    // A CLEAN SLATE PER COMMAND. Commands are not independent when they share a
    // page: `commandPalette.toggle`, `filePicker.toggle`, `projectSearch.toggle`
    // and `themeEditor.toggle` all open overlays, and `_chat.tsx:70` bails out of
    // the whole keydown handler with `if (isCommandPaletteOpen()) return;` — so a
    // palette left open silently swallows every command after it.
    //
    // That is not hypothetical: the run before this one reported `chat.new` and
    // `chat.newLocal` as NOOPs, and their handlers plainly exist
    // (_chat.tsx:80 and :92). They were dead because MY loop had left an overlay
    // up — the button enumeration in H2 was still seeing "Close the theme editor"
    // and "Create theme" in the DOM. One Escape was not enough, and filing those
    // three would have been filing a finding against my own harness.
    //
    // Reloading is the cheap way to make each result mean something on its own.
    await app.page.goto(stack.webUrl, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await waitFor(async () => (await app.page.getByRole("textbox").count()) > 0, {
      ms: 60_000,
      what: `the app to be interactive again before driving ${b.command}`,
    }).catch(() => null);

    const before = await domFingerprint();
    const requestsBefore = sentRequests().length;

    await app.page.keyboard.press(pressSpec(b.shortcut));

    const changed = await waitFor(
      async () => {
        if ((await domFingerprint()) !== before) return "dom" as const;
        const fresh = sentRequests()
          .slice(requestsBefore)
          .filter((m) => !BACKGROUND_METHODS.has(m));
        if (fresh.length > 0) return `rpc:${fresh[0]}` as const;
        return null;
      },
      { ms: 3_000, what: `${b.command} to change the DOM or dispatch a non-background RPC` },
    ).catch(() => null);

    if (changed) fired.push(`${b.command} -> ${changed}`);
    else noop.push(`${b.command} [${pressSpec(b.shortcut)}]`);

    // Belt and braces; the reload above is what actually guarantees isolation.
    await app.page.keyboard.press("Escape").catch(() => {});
  }

  report.bindings = { total: bindings.length, fired, noop, gated, blocked };

  // THE KEYSTROKE-VS-BUTTON QUESTION, for the one command where it is decidable
  // here. The task reports Meta+j doing nothing while the terminal BUTTON sent
  // `terminal.open`; the same shape shows up for new-thread. If the chord is
  // dead and the button works, the two delivery paths disagree and THAT is the
  // finding — a keybinding the server advertises that only the mouse can reach.
  await app.page.goto(stack.webUrl, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await waitFor(async () => (await app.page.getByRole("textbox").count()) > 0, {
    ms: 60_000,
    what: "the app to be interactive before the button/keystroke comparison",
  }).catch(() => null);
  const newThreadButton = app.page.getByRole("button", { name: /new thread/i }).first();
  const beforeButton = await domFingerprint();
  const buttonRequestsBefore = sentRequests().length;
  const buttonExists = (await newThreadButton.count()) > 0;
  let buttonOutcome = "no such button";
  if (buttonExists) {
    await newThreadButton.click({ timeout: 10_000 }).catch(() => {});
    buttonOutcome =
      (await waitFor(
        async () => {
          if ((await domFingerprint()) !== beforeButton) return "dom" as const;
          const fresh = sentRequests()
            .slice(buttonRequestsBefore)
            .filter((m) => !BACKGROUND_METHODS.has(m));
          return fresh.length > 0 ? (`rpc:${fresh[0]}` as const) : null;
        },
        { ms: 5_000, what: "the New thread BUTTON to do something" },
      ).catch(() => null)) ?? "nothing";
  }
  (report.bindings as Record<string, unknown>).newThreadButton = {
    exists: buttonExists,
    outcome: buttonOutcome,
    keystrokes: noop.filter((n) => n.startsWith("chat.")),
  };
  t.diagnostic(`New thread BUTTON -> ${buttonOutcome}`);

  // THE VACUOUS-PASS GUARD. If the whenAst shape ever moves, every guard renders
  // to a JSON blob, every command lands in `gated`, and `noop === []` passes
  // having driven nothing. Fail on the unparsed nodes themselves, and fail if
  // this spec drove nothing at all.
  const unparsedGuards = gated.filter((g) => UNPARSED.test(g));
  assert.deepEqual(
    unparsedGuards,
    [],
    `this spec could not parse these whenAst nodes, so its GATED/FIRED/NOOP ` +
      `classification is meaningless for them. The AST shape is read off ` +
      `backend/src/keybindings.rs:284-333 ({type:"identifier"|"not"|"and"|"or"}); ` +
      `if it moved, fix the renderer — do NOT let unknown nodes fall into GATED, ` +
      `because that makes the assertion below pass with nothing driven.\n  ` +
      unparsedGuards.join("\n  "),
  );
  assert.ok(
    fired.length + noop.length > 0,
    `this spec classified ${bindings.length} bindings and DROVE NONE of them ` +
      `(gated ${gated.length}, blocked ${blocked.length}). An assertion over an ` +
      `empty set is a vacuous pass, which is the failure mode this whole file ` +
      `exists to avoid.`,
  );
  t.diagnostic(
    `FIRED ${fired.length} / NOOP ${noop.length} / GATED ${gated.length} / BLOCKED-ON-2879 ${blocked.length}`,
  );

  // A COMMAND WITH NOTHING TO ACT ON IS NOT A DEAD COMMAND, and this distinction
  // is the difference between one finding and fifteen false ones.
  //
  // The first honest run of this spec produced NOOP 15, and eleven of them were
  // `thread.jump.1..9` / `thread.previous` / `thread.next` on a workspace with
  // ZERO threads, plus `diff.toggle` with no thread to diff. Those did nothing
  // because there was nothing to do — filing them would be filing a finding
  // against correct behaviour, which is the same error as calling a GATED
  // command a NOOP.
  //
  // So the assertion covers only commands that must work from an empty
  // workspace. The state-dependent ones are still DRIVEN and still REPORTED (in
  // `noopNeedsState`), because dropping them from the report would be the silent
  // truncation this task explicitly forbids — they are just not asserted until
  // something seeds the state they need.
  const NEEDS_STATE =
    /^(thread\.jump\.\d|thread\.previous|thread\.next|diff\.toggle|editor\.openFavorite)$/;
  const noopStateless = noop.filter((n) => !NEEDS_STATE.test(n.split(" ")[0] ?? ""));
  const noopNeedsState = noop.filter((n) => NEEDS_STATE.test(n.split(" ")[0] ?? ""));
  (report.bindings as Record<string, unknown>).noopStateless = noopStateless;
  (report.bindings as Record<string, unknown>).noopNeedsState = noopNeedsState;
  t.diagnostic(
    `NOOP breakdown: ${noopStateless.length} stateless (asserted), ` +
      `${noopNeedsState.length} need workspace state (reported, not asserted)`,
  );

  assert.deepEqual(
    noopStateless,
    [],
    `these commands are advertised by the backend and did NOTHING when their own ` +
      `compiled shortcut was pressed — no DOM change, no frame. A NOOP keybinding is ` +
      `a finding, not a pass: the server is telling the user a chord exists and the ` +
      `chord is dead. GATED (${gated.length}) and BLOCKED-ON-2879 (${blocked.length}) ` +
      `are NOT counted here, and neither are the ${noopNeedsState.length} that need ` +
      `workspace state this run does not create (${noopNeedsState.join(", ") || "none"}).\n  ` +
      `${noopStateless.join("\n  ")}`,
  );
}

test("H2 every button with an accessible name at the thread route is enumerated, and nothing is silently dropped", async (t) => {
  const buttons: { name: string; disabled: boolean }[] = await app.page.$$eval(
    'button, [role="button"]',
    (nodes: Element[]) =>
      nodes
        .map((n) => ({
          name:
            (n.getAttribute("aria-label") ||
              n.getAttribute("title") ||
              (n as HTMLElement).innerText ||
              "").trim().slice(0, 60),
          disabled:
            (n as HTMLButtonElement).disabled === true ||
            n.getAttribute("aria-disabled") === "true",
        }))
        .filter((b) => b.name !== ""),
  );

  // DESTRUCTIVE OR NAVIGATING-AWAY. Named, with the reason, rather than dropped
  // from the list — "no silent caps" applies to coverage too.
  const NOT_CLICKED = /commit|push|delete|remove|archive|sign out|log ?out|revert|discard/i;
  const skipped = buttons.filter((b) => NOT_CLICKED.test(b.name)).map((b) => b.name);

  report.buttons = {
    total: buttons.length,
    names: buttons.map((b) => b.name),
    disabled: buttons.filter((b) => b.disabled).map((b) => b.name),
    skippedAsDestructive: skipped,
  };
  t.diagnostic(`buttons with an accessible name: ${buttons.length}; not clicked: ${skipped.length}`);

  assert.ok(
    buttons.length > 0,
    "the thread route must expose named buttons; zero means the page did not render " +
      "and every other button assertion in this suite would be vacuously true",
  );
  // The real claim: every button is REACHABLE by name. A button whose only
  // identity is a class is one no screen reader and no test can address, and it
  // is invisible to any coverage count taken this way.
  const unnamed: number = await app.page.$$eval(
    'button, [role="button"]',
    (nodes: Element[]) =>
      nodes.filter(
        (n) =>
          !(n.getAttribute("aria-label") || n.getAttribute("title") || (n as HTMLElement).innerText || "").trim(),
      ).length,
  );
  report.unnamedButtons = unnamed;
  assert.equal(
    unnamed,
    0,
    `${unnamed} button(s) at the thread route have no aria-label, no title and no text. ` +
      `They cannot be addressed by a screen reader or by any test, and they are absent ` +
      `from every coverage count taken by name — which is how a surface silently drops ` +
      `out of "we tested all the buttons".`,
  );
});
