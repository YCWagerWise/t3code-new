/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships with.
 *
 * "Claude" and "Codex" are one runtime: agent-sdk-rs over ACP (`t3code-agent`) with a
 * different model. There are no vendor-CLI drivers.
 *
 * "Atlas" is not that. It spawns nothing and talks to a running atlas-host over its console
 * API, with Atlas as the authority for runs, turns and workspaces. It is here because the ACP
 * runtime the other two need cannot currently be built at all — `cargo build --bin
 * t3code-agent` fails at manifest resolution on missing `agent-sdk-*` crates — so a host that
 * already serves a durable contract is the seam that actually works.
 *
 * @module provider/builtInDrivers
 */
import { AtlasDriver } from "./Drivers/AtlasDriver.ts";
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
  // Atlas is not a fourth flavour of the ACP runtime — it is a running host this server talks
  // to over `/console/v1`, with Atlas as the authority for runs and turns. It spawns nothing,
  // so it needs none of the agent-sdk env the other two require.
  AtlasDriver,
];
