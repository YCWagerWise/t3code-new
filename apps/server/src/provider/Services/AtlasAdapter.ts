/**
 * AtlasAdapter — shape type for the Atlas provider adapter.
 *
 * Mirrors the other driver-bundled adapters: the instance owns its adapter as a
 * captured closure, so this module only anchors the shape.
 *
 * @module AtlasAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AtlasAdapterShape — per-instance Atlas adapter contract.
 */
export interface AtlasAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
