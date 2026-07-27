# UI and UX documentation

This section documents the web client as a product interface and as a component
system.

> **CORRECTION (2026-07-26):** Atlas is the product and the T3 web client is
> donor UI. Product dispositions live in the
> [Atlas Console classification](../atlas-console/03-CLASSIFICATION.md).

## Documents

- [Information architecture](./information-architecture.md) defines routes,
  navigation regions, workspace panels, and major state transitions.
- [Component reference](./component-reference.md) defines component families,
  contracts, variants, states, interactions, accessibility expectations, and
  source ownership.

## Scope

The inventory includes every user-facing React surface tracked under
`apps/web/src`, not only modules inside `components/ui`.

Components are documented at four levels:

1. **Route:** a URL-addressable product surface.
2. **Workspace:** a large persistent region such as the sidebar or chat view.
3. **Feature:** a coherent interaction such as the model picker or diff review.
4. **Primitive:** a reusable control such as a button, dialog, or field.

Tests, providers, hooks, and state-only modules are excluded unless they define
a visible state or interaction contract.

## Component documentation contract

Every component family should eventually define:

- Purpose
- Placement and ownership
- Inputs and outputs
- Anatomy
- Variants
- Loading, empty, error, disabled, and success states
- Pointer and keyboard behavior
- Focus management
- Responsive behavior
- Accessibility name and semantics
- Provider or environment dependencies
- Related source and tests

## Status labels

- **Defined:** purpose and behavior are documented and validated.
- **Source-audited:** behavior is derived from source but not yet visually
  exercised.
- **Runtime-validated:** behavior was exercised in the running web client.
- **Compatibility:** retained for an upstream surface not shipped by this fork.
- **Internal:** supports composition but is not a standalone product component.
