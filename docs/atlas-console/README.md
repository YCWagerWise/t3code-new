# Atlas Console documentation

Atlas Console is the Atlas product lens built from the T3 Code web client.
Atlas and its deployments are the body; this React application renders and
drives that body without owning fleet capability.

## Documents

1. [Overview](./00-OVERVIEW.md)
2. [Donor UI inventory](./01-UI-INVENTORY.md)
3. [Concept map](./02-CONCEPT-MAP.md)
4. [Classification](./03-CLASSIFICATION.md)
5. [Machine-readable classification](./03-classification.json)
6. [Protocol binding](./04-PROTOCOL-BINDING.md)
7. [Atlas capability gaps](./05-GAPS.md)
8. [Agent run authority](./07-AGENT-RUN-AUTHORITY.md)
9. [Atlas-owned backend capability implementation plan](./12-ATLAS-BACKEND-CAPABILITY-PLAN.md)

## Source hierarchy

When these documents disagree with implementation, use this order:

1. Current Atlas, StudyOS, Warden, and T3 source
2. `atlas-rs/docs/ATLAS-ARCHITECTURE.md`
3. `atlas/docs/ATLAS-SYSTEM-REFERENCE.md`
4. This documentation set
5. Historical plans

`ATLAS-PORT-PLAN.md` is a delivery plan, not a protocol specification.
