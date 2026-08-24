/**
 * AgentSdkAdapter — shape type for the agent-sdk-rs provider adapter.
 *
 * agent-sdk-rs is the single model-neutral runtime t3code drives over ACP.
 * Both the "Claude" and "Codex" provider instances are this one adapter with
 * a different model string, so they share this shape and render identically.
 *
 * @module AgentSdkAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/** Per-instance agent-sdk adapter contract. */
export interface AgentSdkAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
