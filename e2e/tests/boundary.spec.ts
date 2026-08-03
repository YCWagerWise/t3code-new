/**
 * Regressions for the browser-boundary blockers (doc 15 "Gaps found by the G1
 * live run"). Every one of these was invisible to unit tests and node-side
 * integration runs — they only exist where a real browser meets the node.
 *
 * Wire-level half: asserted with raw fetches against the rig node.
 * UI half (posture screens, picker, rename): asserted in the browser.
 */
import { expect, test } from "@playwright/test";
import { DEV_TOKEN, NODE_BASE, WEB_BASE } from "../rig/rig.ts";
import { openConnectedApp } from "../rig/ui.ts";

test.describe("CORS — blocker 5", () => {
  test("preflight from the lens origin is answered 204 and echoes the asked-for headers", async ({
    request,
  }) => {
    const response = await request.fetch(`${NODE_BASE}/_members`, {
      method: "OPTIONS",
      headers: {
        origin: WEB_BASE,
        "access-control-request-method": "GET",
        // The exact header that broke the fixed allow-list on 2026-08-03:
        // Effect's fetch client sends traceparent, curl never did.
        "access-control-request-headers": "authorization,content-type,traceparent",
      },
    });
    expect(response.status()).toBe(204);
    expect(response.headers()["access-control-allow-origin"]).toBe(WEB_BASE);
    const allowed = response.headers()["access-control-allow-headers"] ?? "";
    expect(allowed).toContain("traceparent");
    expect(allowed).toContain("authorization");
  });

  test("preflight from an unlisted origin is refused, not reflected", async ({ request }) => {
    const response = await request.fetch(`${NODE_BASE}/_members`, {
      method: "OPTIONS",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "GET",
      },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("plain responses to the lens origin carry the allow-origin stamp", async ({ request }) => {
    const response = await request.get(`${NODE_BASE}/_members`, {
      headers: { origin: WEB_BASE, authorization: `Bearer ${DEV_TOKEN}` },
    });
    expect(response.headers()["access-control-allow-origin"]).toBe(WEB_BASE);
  });
});

test.describe("solo node self-description — blockers 4, 6, 7", () => {
  test("/_members on a solo node reports the node itself with a manifest", async ({ request }) => {
    const response = await request.get(`${NODE_BASE}/_members`, {
      headers: { authorization: `Bearer ${DEV_TOKEN}` },
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as {
      members?: Array<{ id?: string; url?: string; manifest?: unknown }>;
    };
    const members = Array.isArray(body) ? body : (body.members ?? []);
    expect(members.length).toBeGreaterThanOrEqual(1);
    const self = JSON.stringify(members);
    // The picker reads execution.default_model from this manifest (blocker 7):
    // an empty manifest means "No provider available" in the composer.
    expect(self).toContain("default_model");
  });
});

test.describe("auth posture in the browser — blockers 1, 2, 3", () => {
  test("no token: the app answers setup-required as the pairing gate", async ({ page }) => {
    // No __ATLAS_TOKEN__ injected and the rig's Vite bakes none in.
    await page.goto("/");
    await expect(page).toHaveURL(/\/pair$/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Pair with this environment" })).toBeVisible();
  });

  test("wrong token: the node refuses and the lens reports it honestly", async ({ page }) => {
    // A non-empty token passes the local gate (the credential IS the
    // authorization — blocker 1); the refusal must come from the NODE.
    await page.addInitScript(() => {
      (globalThis as { __ATLAS_TOKEN__?: string }).__ATLAS_TOKEN__ = "wrong-token";
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Environment disconnected" })).toBeVisible({
      timeout: 45_000,
    });
  });

  test("dev token: connected — composer ready, no provider gap", async ({ page }) => {
    await openConnectedApp(page);
    await expect(page.locator('[data-chat-provider-unavailable="true"]')).toHaveCount(0);
  });
});

test.describe("model picker reads the node manifest — blocker 7", () => {
  test("the picker offers exactly the node's advertised model", async ({ page }) => {
    await openConnectedApp(page);
    await page.locator('[data-chat-provider-model-picker="true"]').click();
    await expect(page.locator('[data-model-picker-content="true"]')).toBeVisible();
    // The rig node advertises ATLAS_MODEL=claude-opus-4-8 via /_members.
    await expect(page.getByRole("option", { name: /claude-opus-4-8/ }).first()).toBeVisible();
  });
});
