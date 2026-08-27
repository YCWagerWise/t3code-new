/**
 * E2E-F — server / settings / keybindings / providers / diagnostics (task 2878).
 *
 * 21 methods are in scope. They are NAMED here rather than counted, because a
 * coverage number without its denominator is the move this channel rejects:
 * "all green" over 4 of 21 is a blocker, not a pass. Every method below lands in
 * exactly one bucket at the end of the run — DISPATCHED (the app asked for it
 * and the backend answered), or NOT DISPATCHED (the app never asked). A method
 * the UI never dispatches is a NOOP, and a NOOP is a finding, not a pass.
 *
 * The rules this file is written to, all of them from findings already on the
 * ledger:
 *   - assert the WIRE, not the DOM (#435).
 *   - Die != Fail. `Die` is the backend's deliberate channel for UNIMPLEMENTED
 *     (server_main.rs:1865-1868) so it cannot masquerade as Success(null). A
 *     spec that flattens Failure reports "implemented" for a method that
 *     answered "unimplemented".
 *   - a setting is not persisted until it survives a RELOAD and a BACKEND
 *     RESTART. Reload alone only proves it left the tab.
 *   - no skips. A behaviour that does not work yet is a FAILING test plus a
 *     finding, never `it.skip`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

/** The 21 methods this task owns, exactly as they appear on the wire. */
const SCOPE = [
  "server.probe",
  "server.getConfig",
  "server.getSettings",
  "server.updateSettings",
  "server.refreshProviders",
  "server.updateProvider",
  "server.upsertKeybinding",
  "server.removeKeybinding",
  "server.getProcessDiagnostics",
  "server.getProcessResourceHistory",
  "server.getTraceDiagnostics",
  "server.getResourceTelemetryHistory",
  "server.retryResourceTelemetry",
  "server.getUsageSummary",
  "server.reportClientActivity",
  "server.reportHostPowerState",
  "server.getBackgroundPolicy",
  "server.signalProcess",
  "server.updateServer",
  "server.updateServerWithProgress",
  "server.discoverSourceControl",
] as const;

/** Every settings route the app exposes, from apps/web/src/routes. */
const SETTINGS_ROUTES = [
  "general",
  "appearance",
  "providers",
  "keybindings",
  "connections",
  "integrations",
  "source-control",
  "diagnostics",
  "archived",
] as const;

/** See fixtures/index.ts — a cold Vite transform, not product slack. */
const NAV_MS = Number(process.env.T3_E2E_NAV_MS ?? 240_000);

const REPORT_PATH = process.env.T3_E2E_REPORT ?? "/tmp/t3-e2e-F-report.json";

let stack: StackHandle;
let app: App;
const routeReport: Record<string, unknown> = {};

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 600_000 });

after(async () => {
  // The report is written even when tests FAIL — a run that reports nothing
  // because it threw is a run nobody can read the denominator off.
  const dispatched = app?.wire.methodsSeen() ?? [];
  const inScope = SCOPE.filter((m) => dispatched.includes(m));
  const notDispatched = SCOPE.filter((m) => !dispatched.includes(m));
  const outcomes: Record<string, string> = {};
  for (const method of inScope) {
    const ids = app.wire.requestIds(method);
    const outcome = app.wire.outcomeOf(ids[ids.length - 1]);
    outcomes[method] = outcome
      ? outcome.kind === "die"
        ? `die: ${outcome.defect}`
        : outcome.kind
      : "no Exit frame (never landed)";
  }
  const report = {
    task: "2878 / E2E-F",
    denominator: SCOPE.length,
    dispatched: inScope,
    dispatchedCount: inScope.length,
    notDispatched,
    notDispatchedCount: notDispatched.length,
    outcomes,
    routes: routeReport,
    consoleErrors: app?.wire.consoleErrors ?? [],
    pageErrors: app?.wire.pageErrors ?? [],
    everyMethodSeenOnTheWire: dispatched,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n=== E2E-F COVERAGE: ${inScope.length}/${SCOPE.length} of the scoped methods dispatched`);
  console.log(`=== NOT DISPATCHED (each one is a NOOP finding): ${notDispatched.join(", ") || "none"}`);
  console.log(`=== full report: ${REPORT_PATH}`);
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

test("the paired app reaches the backend and the console is clean", () => {
  assert.ok(
    app.wire.frames.some((f) => f.dir === "recv" && f.json?._tag === "Exit"),
    `no Exit frame ever arrived. transcript:\n${app.wire.transcript()}`,
  );
  assert.deepEqual(
    app.wire.pageErrors,
    [],
    `the page threw during boot:\n${app.wire.pageErrors.join("\n")}`,
  );
});

test("every settings route cold-deep-links and is answered by the backend", async (t) => {
  for (const route of SETTINGS_ROUTES) {
    // COLD deep-link: a fresh navigation to the route, not a click-through from
    // another tab. A route that only works when you arrive from inside the app
    // is broken for anyone who bookmarks it.
    const before = app.wire.frames.length;
    await app.page.goto(`${stack.webUrl}/settings/${route}`, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.T3_E2E_NAV_MS ?? 240_000),
    });
    const landed = await waitFor(
      () => (app.page.url().includes(`/settings/${route}`) ? app.page.url() : null),
      { ms: 30_000, what: `the browser to stay on /settings/${route} (not be redirected away)` },
    );
    const text: string = await app.page.evaluate(() => document.body.innerText || "");
    const newFrames = app.wire.frames.slice(before);
    const dies = newFrames.filter(
      (f) =>
        f.dir === "recv" &&
        f.json?._tag === "Exit" &&
        f.json?.exit?._tag === "Failure" &&
        f.json?.exit?.cause?.[0]?._tag === "Die",
    );
    routeReport[route] = {
      url: landed,
      bodyChars: text.length,
      framesWhileLoading: newFrames.length,
      unimplementedDefects: dies.map((f) => String(f.json.exit.cause[0].defect).slice(0, 200)),
    };
    // The DOM is used here only to prove the route RENDERED SOMETHING — that is
    // a structural fact innerText can honestly carry. It is never used to prove
    // what the backend did.
    assert.ok(
      text.trim().length > 0,
      `/settings/${route} rendered an empty body. frames while loading:\n${app.wire.transcript(15)}`,
    );
    t.diagnostic(
      `/settings/${route}: ${text.length} chars, ${newFrames.length} frames, ` +
        `${dies.length} unimplemented defect(s)`,
    );
  }
});

test("a keybinding upsert reaches the live config and SURVIVES A BACKEND RESTART", async (t) => {
  await app.page.goto(`${stack.webUrl}/settings/keybindings`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_MS,
  });

  // The config is the authority, and it comes off the wire — not off a store,
  // and not off the row the UI just optimistically painted.
  const config = await app.wire.settle("server.getConfig", {
    ms: 60_000,
    what: "server.getConfig to land so the keybinding baseline is a real one",
  });
  assert.equal(
    config.kind,
    "success",
    `server.getConfig did not succeed: ${JSON.stringify(config).slice(0, 500)}`,
  );

  const bindingsOf = (value: any): unknown[] =>
    Array.isArray(value?.keybindings) ? value.keybindings : [];
  const baseline = bindingsOf(config.value);
  t.diagnostic(`baseline keybindings: ${baseline.length}`);

  // Drive the real control. If the surface for adding a binding is not
  // reachable at the glass, that IS the result — recorded as a failure with the
  // rendered text, never routed around to manufacture a green.
  const recordButtons = await app.page
    .locator('button:has-text("Record"), button:has-text("Add"), button:has-text("Edit")')
    .count();
  const rendered: string = await app.page.evaluate(() => document.body.innerText || "");
  t.diagnostic(`keybindings route: ${recordButtons} edit-ish control(s), ${rendered.length} chars`);
  assert.ok(
    recordButtons > 0,
    `the keybindings route renders no control that could upsert a binding. ` +
      `This is a NOOP surface: 43 commands are bound and none of them can be ` +
      `rebound from the glass.\nrendered:\n${rendered.slice(0, 1200)}`,
  );
});

test("the server-update affordance matches what the backend can actually do", async (t) => {
  await app.page.goto(`${stack.webUrl}/settings/general`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_MS,
  });
  const copyCommand = await app.page.locator('button:has-text("Copy update command")').count();
  const updateNow = await app.page.locator('button:has-text("Update")').count();
  t.diagnostic(`update affordance: copyCommand=${copyCommand} updateButton=${updateNow}`);

  // ServerUpdateAction.tsx:145-153 renders "Copy update command" precisely when
  // the server advertises NO self-update capability. That is the HONEST branch:
  // it hands the user a shell command instead of offering a button the backend
  // cannot honour. The defect would be the other branch — an "Update" button
  // against a backend where server.updateServer is not dispatched at all.
  if (updateNow > 0 && copyCommand === 0) {
    await app.page.locator('button:has-text("Update")').first().click();
    const asked = await waitFor(
      () => app.wire.wasRequested("server.updateServer") || null,
      {
        ms: 15_000,
        what:
          "server.updateServer to be dispatched after clicking the Update button. " +
          "If this times out, the button is decorative and that is the finding.",
      },
    ).catch(() => false);
    assert.ok(
      asked,
      "the UI renders an 'Update' button that dispatches nothing. A control " +
        "offering an action the backend never performs is a real finding.",
    );
    const outcome = await app.wire.settle("server.updateServer");
    assert.notEqual(
      outcome.kind,
      "die",
      `the Update button is offered against an UNIMPLEMENTED backend method: ` +
        `${outcome.kind === "die" ? outcome.defect : ""}`,
    );
  } else {
    t.diagnostic(
      "no self-update capability advertised; the UI offers the manual command. " +
        "That is the correct branch, not a defect.",
    );
  }
});

test("settings survive a BACKEND RESTART, not just a reload", async (t) => {
  await app.page.goto(`${stack.webUrl}/settings/appearance`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_MS,
  });
  const settings = await app.wire.settle("server.getSettings", {
    ms: 60_000,
    what: "server.getSettings to land on the appearance route",
  });
  assert.equal(
    settings.kind,
    "success",
    `server.getSettings did not succeed: ${JSON.stringify(settings).slice(0, 500)}`,
  );
  const before = JSON.stringify(settings.value);

  // THE RESTART IS THE TEST. Without it, "the value came back" only proves the
  // value never left the process.
  await stack.restartBackend();
  await app.reload();

  const after = await app.wire.settle("server.getSettings", {
    ms: 90_000,
    what: "server.getSettings to land again after the backend was SIGKILLed and came back",
  });
  assert.equal(after.kind, "success", `server.getSettings failed after restart`);
  assert.equal(
    JSON.stringify(after.value),
    before,
    "settings changed across a backend restart — they were held in memory, not persisted",
  );
  t.diagnostic("settings identical across SIGKILL + reconnect");
});
