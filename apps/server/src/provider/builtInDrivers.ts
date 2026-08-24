/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships with.
 *
 * Every driver here is agent-sdk-rs over ACP: "Claude" and "Codex" are the same
 * runtime (`t3code-agent`) with a different model. There are no vendor-CLI
 * drivers anymore — the provider layer is one model-neutral ACP backend.
 *
 * @module provider/builtInDrivers
 */
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in driver.
 * (Both drivers share the same agent-sdk env.)
 */
export type BuiltInDriversEnv = ClaudeDriverEnv | CodexDriverEnv;

/**
 * Ordered list of built-in drivers. Order matters only for UI tie-breaking —
 * the registry is keyed by `driverKind`.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
];
