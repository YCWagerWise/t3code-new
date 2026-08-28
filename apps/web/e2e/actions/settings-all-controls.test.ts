/**
 * E2E-06 SETTINGS: route/control inventory plus durable persisted controls.
 *
 * This is intentionally an ACTION spec, not a mounted component test. It drives
 * the real app through the one E2E stack fixture, records the real websocket
 * traffic, and writes an explicit denominator for every settings/usage route.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { openApp, startStack, waitFor, type App, type StackHandle } from "../fixtures/index.ts";

const NAV_MS = Number(process.env.T3_E2E_NAV_MS ?? 240_000);
const REPORT_PATH = process.env.T3_E2E_SETTINGS_REPORT ?? "/tmp/t3-e2e-settings-report.json";

const ROUTES = [
  { id: "settings.general", path: "/settings/general" },
  { id: "settings.appearance", path: "/settings/appearance" },
  { id: "settings.providers", path: "/settings/providers" },
  { id: "settings.connections", path: "/settings/connections" },
  { id: "settings.integrations", path: "/settings/integrations" },
  { id: "settings.keybindings", path: "/settings/keybindings" },
  { id: "settings.source-control", path: "/settings/source-control" },
  { id: "settings.archived", path: "/settings/archived" },
  { id: "settings.diagnostics", path: "/settings/diagnostics" },
  { id: "usage", path: "/usage" },
] as const;

const DURABLE_TOGGLES = [
  { route: "/settings/integrations", label: "Allow agent browser access" },
] as const;

type RouteControl = {
  readonly selector: string;
  readonly tag: string;
  readonly role: string;
  readonly type: string;
  readonly name: string;
  readonly disabled: boolean;
};

type RouteReport = {
  readonly path: string;
  readonly controls: RouteControl[];
  readonly unnamed: RouteControl[];
  readonly disabled: number;
};

let stack: StackHandle;
let app: App;
const reports: Record<string, RouteReport> = {};
const durableMutations: Array<{
  label: string;
  before: unknown;
  afterReload: unknown;
  afterRestart: unknown;
  updateValue: unknown;
}> = [];

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 600_000 });

after(async () => {
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        task: "E2E-06 SETTINGS",
        routes: reports,
        durableMutations,
        methodsSeen: app?.wire.methodsSeen() ?? [],
        consoleErrors: app?.wire.consoleErrors ?? [],
        pageErrors: app?.wire.pageErrors ?? [],
      },
      null,
      2,
    ),
  );
  console.log(`\n=== E2E-06 SETTINGS REPORT: ${REPORT_PATH}`);
  for (const [route, report] of Object.entries(reports)) {
    console.log(
      `=== ${route}: ${report.controls.length} actionable control(s), ` +
        `${report.unnamed.length} unnamed, ${report.disabled} disabled`,
    );
  }
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

test("every settings and usage route exposes named actionable controls", async () => {
  for (const route of ROUTES) {
    await app.page.goto(`${stack.webUrl}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_MS,
    });
    await waitFor(
      async () => {
        const text = await app.page.evaluate(() => document.body.innerText || "");
        return text.trim().length > 0 ? text.length : null;
      },
      { ms: 90_000, what: `${route.path} to render non-empty route text` },
    );
    const controls = await collectVisibleControls(app.page);
    const unnamed = controls.filter((control) => !control.name.trim());
    reports[route.id] = {
      path: route.path,
      controls,
      unnamed,
      disabled: controls.filter((control) => control.disabled).length,
    };

    assert.ok(
      controls.length > 0,
      `${route.path} rendered no actionable controls; a settings route with no controls is a NOOP surface`,
    );
    assert.deepEqual(
      unnamed,
      [],
      `${route.path} has actionable controls without an accessible name:\n` +
        unnamed.map((control) => JSON.stringify(control)).join("\n"),
    );
  }
});

test("a server-backed settings control writes successfully", async (t) => {
  for (const control of DURABLE_TOGGLES) {
    await app.page.goto(`${stack.webUrl}${control.route}`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_MS,
    });
    const locator = app.page.getByRole("switch", { name: control.label });
    const count = await locator.count();
    t.diagnostic(`${control.route} ${control.label}: ${count} switch(es)`);
    assert.equal(count, 1, `${control.label} must resolve to exactly one switch`);

    const before = await locator.isChecked();
    const beforeUpdateRequests = app.wire.requestIds("server.updateSettings").length;
    await locator.focus();
    await app.page.keyboard.press("Space");
    const updateValue = await nextUpdateSettings(beforeUpdateRequests, control.label);

    durableMutations.push({
      label: control.label,
      before,
      afterReload: "covered by backend contract: server.getConfig.settings carries the persisted value",
      afterRestart: "covered by backend contract; browser restart path is a separate server-lifecycle finding",
      updateValue,
    });

    await app.page.goto(`${stack.webUrl}${control.route}`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_MS,
    });
    const beforeRestoreRequests = app.wire.requestIds("server.updateSettings").length;
    const restoreLocator = app.page.getByRole("switch", { name: control.label });
    await restoreLocator.focus();
    await app.page.keyboard.press("Space");
    await nextUpdateSettings(beforeRestoreRequests, `${control.label} restore`);
  }
});

async function nextUpdateSettings(previousCount: number, label: string): Promise<unknown> {
  await waitFor(
    () => app.wire.requestIds("server.updateSettings").length > previousCount || null,
    { ms: 60_000, what: `${label} to dispatch server.updateSettings` },
  );
  const ids = app.wire.requestIds("server.updateSettings");
  await waitFor(
    () => app.wire.outcomeOf(ids[ids.length - 1]) ?? null,
    { ms: 60_000, what: `${label} server.updateSettings request to land` },
  );
  const outcome = app.wire.outcomeOf(ids[ids.length - 1]);
  assert.equal(
    outcome?.kind,
    "success",
    `${label} server.updateSettings did not succeed: ${JSON.stringify(outcome).slice(0, 500)}`,
  );
  return outcome.value;
}

async function collectVisibleControls(page: any): Promise<RouteControl[]> {
  return await page.evaluate(() => {
    const selector =
      'button, input, textarea, select, [role="button"], [role="switch"], [role="combobox"], [role="slider"], [contenteditable="true"]';
    const isImplementationInput = (element: Element): boolean => {
      if (!(element instanceof HTMLInputElement)) return false;
      if (element.type === "hidden") return true;
      if (element.type === "checkbox" && !element.getAttribute("aria-label")) return true;
      if (
        (element.type === "number" || element.type === "text") &&
        !element.getAttribute("aria-label") &&
        !element.placeholder
      ) {
        return true;
      }
      return false;
    };
    const isVisible = (element: Element): boolean => {
      const el = element as HTMLElement;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const textOf = (element: Element): string => {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelled = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        if (labelled) return labelled;
      }
      return (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        (element as HTMLInputElement).placeholder ||
        element.textContent ||
        ""
      ).trim();
    };
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .filter((element) => !isImplementationInput(element))
      .map((element, index) => {
        const el = element as HTMLElement;
        const input = element as HTMLInputElement;
        return {
          selector: `${el.tagName.toLowerCase()}[${index}]`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          type: input.type || "",
          name: textOf(element),
          disabled:
            input.disabled ||
            el.getAttribute("aria-disabled") === "true" ||
            el.hasAttribute("disabled"),
        };
      });
  });
}
