import { expect, test } from "@effect/vitest";
import { getStartedThreadModelChangeBlockReason } from "./components/ChatView.logic.ts";
import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUpdatedPayload,
  ServerSettings,
} from "@t3tools/contracts";

// The exact shape the Rust settings::settings_wire emits.
test("getSettings/updateSettings wire decodes as ServerSettings", () => {
  Schema.decodeUnknownSync(ServerSettings)({
    providerInstances: {
      claudeAgent: {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude",
        enabled: true,
        config: {},
      },
      codex: {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        config: {},
      },
      ollama_local: {
        instanceId: "ollama_local",
        driver: "openaiCompat",
        displayName: "Ollama",
        enabled: true,
        config: { baseUrl: "http://localhost:11434", models: ["qwen2.5-coder"] },
      },
    },
  });
});

// The refreshProviders/updateProvider payload reuses the getConfig provider_entry
// shape; assert the wrapper decodes (provider_entry itself is already exercised
// by the getConfig decode elsewhere, so a minimal ForwardCompatible array holds).
test("refreshProviders/updateProvider payload decodes as ServerProviderUpdatedPayload", () => {
  Schema.decodeUnknownSync(ServerProviderUpdatedPayload)({ providers: [] });
});

// #150: Cursor and Grok were REMOVED from this build, so their settings
// schemas are gone and this no longer asserts they exist. What it still has to
// assert — and this is the half that matters more — is that an EXISTING user's
// persisted settings row naming those drivers still DECODES. Removing a
// provider must not brick the settings of someone who had one configured: the
// row has to survive, the provider just is not offered anymore. If this ever
// throws, the removal turned into data loss.
test("a persisted instance row for a removed driver still decodes", () => {
  Schema.decodeUnknownSync(ServerSettings)({
    providerInstances: {
      cursor: {
        instanceId: "cursor",
        driver: "cursor",
        displayName: "Cursor",
        enabled: true,
        config: { binaryPath: "cursor-agent" },
      },
      grok: {
        instanceId: "grok",
        driver: "grok",
        displayName: "Grok",
        enabled: true,
        config: { binaryPath: "grok", models: ["grok-build"] },
      },
    },
  });
});

// #139: a provider from this runtime must not trigger the frontend's
// "start a new chat to change models" block. The block only fires when a
// provider DECLARES requiresNewThreadForModelChange, so this pins the decl.
test("a runtime provider does not force a new thread to switch models", () => {
  const provider = {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    requiresNewThreadForModelChange: false,
    models: [],
    slashCommands: [],
    skills: [],
  };
  const decoded = Schema.decodeUnknownSync(ServerProvider)(provider);
  expect(decoded.requiresNewThreadForModelChange).toBe(false);

  // `ProviderInstanceId` is a BRANDED slug (contracts/src/providerInstance.ts:82), so a bare
  // string literal is not one. Decoding through the schema is what the app does at every real
  // boundary; writing the literal here would have been testing a shape the app cannot produce.
  const instanceId = (id: string) => Schema.decodeUnknownSync(ProviderInstanceId)(id);

  const blocked = getStartedThreadModelChangeBlockReason({
    providers: [decoded, { ...decoded, instanceId: instanceId("codex") }],
    hasStartedSession: true,
    currentModelSelection: { instanceId: instanceId("claudeAgent"), model: "a" },
    nextModelSelection: { instanceId: instanceId("codex"), model: "b" },
  });
  expect(blocked).toBeNull();
});
