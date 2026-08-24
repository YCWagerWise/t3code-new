import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_DISPLAY_NAMES } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("PROVIDER_DISPLAY_NAMES", () => {
  it("names the drivers this build actually ships", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("codex")]).toBe("Codex");
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("claudeAgent")]).toBe("Claude");
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("opencode")]).toBe("OpenCode");
  });

  // #150 REVERSES #113. That finding required Cursor and Grok to keep their
  // labels; they have since been removed from the build on the human's explicit
  // instruction, and their drivers no longer exist in the server registry. A
  // label without a driver is worse than a missing label: it lets the picker
  // offer a provider nothing can instantiate, so the failure moves from "not
  // offered" to "offered, configured, then broken".
  //
  // This asserts the ABSENCE, so re-adding a label without re-adding a driver
  // fails loudly here instead of shipping.
  it("does not name a provider this build cannot run", () => {
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("cursor")]).toBeUndefined();
    expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("grok")]).toBeUndefined();
  });
});
