import {
  AtlasSettings,
  ClaudeSettings,
  CodexSettings,
  OpenCodeSettings,
  OpenaiCompatSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import { ClaudeAI, type Icon, OpenAI, OpenCodeIcon } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    settingsSchema: CodexSettings,
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodeSettings,
    // The Rust runtime has no OpenCode backend: it drives ACP CLIs and
    // OpenAI-compatible endpoints, and OpenCode is neither. An instance still
    // SAVES (settings are open, and a fork or a later build may run it), but the
    // badge says so up front instead of letting a live-looking provider fail at
    // the first turn (#96).
    badgeLabel: "Not on this runtime",
  },
  // #70: OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, any hosted
  // proxy speaking Chat Completions). The Rust runtime has driven the
  // `openaiCompat` driver for months and probes model lists via
  // `GET /v1/models`, but without an entry here the UI's Add Provider flow
  // could not create the instance, so Ollama was invisible from the app.
  {
    value: ProviderDriverKind.make("openaiCompat"),
    label: "OpenAI-compatible (Ollama, LM Studio, …)",
    icon: OpenAI,
    settingsSchema: OpenaiCompatSettings,
  },
  // Atlas: a running host, not a local binary. It spawns nothing and addresses a node over
  // `/console/v1`, with Atlas as the authority for runs, turns and workspaces.
  //
  // Without an entry HERE the driver is invisible to the app no matter how well it works
  // server-side: this list drives both the Providers panel and the Add Provider flow, so a
  // registered, buildable, probeable driver still renders as "No provider available". That is
  // exactly what the `openaiCompat` note above records happening to Ollama (#70), and Atlas
  // reached it the same way.
  {
    value: ProviderDriverKind.make("atlas"),
    label: "Atlas",
    icon: OpenAI,
    // `AtlasSettings` carries the node URL only. The bearer credential is an instance
    // ENVIRONMENT variable (`ATLAS_ACCESS_TOKEN`, marked sensitive), because provider config
    // is returned to clients verbatim while sensitive environment values are redacted and
    // secret-store backed. Putting it in this form would have shipped the credential in
    // settings JSON and in every client snapshot.
    settingsSchema: AtlasSettings,
  },
  // Cursor and Grok were removed from this build (#150). Their entries stayed
  // here after the drivers were deleted, so Add Provider still offered Grok
  // with a "Binary path" field placeholdered `grok` for a CLI nothing could
  // instantiate. Offering a provider the runtime cannot run is worse than not
  // offering it: the user configures it and finds out later.
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
