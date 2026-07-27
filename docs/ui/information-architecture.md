# Atlas Console information architecture

> **CORRECTION (2026-07-26):** Atlas is the product and the T3 web client is
> donor UI. Project/thread/provider terminology below is replaced by
> fleet/node/workspace/run/body terminology.

## Target hierarchy

```text
Fleet
├── Fleet health and activity
└── Node
    ├── Vitals and capabilities
    ├── Bodies, backends, and models
    └── Workspace
        └── Run
            ├── Header and lifecycle
            ├── Message and activity timeline
            ├── Composer and interventions
            └── Context panels
                ├── Changes
                ├── Files
                ├── Terminal
                └── Preview
```

The node tier has no direct T3 equivalent. It is required because capability
and execution availability are node knowledge in Atlas.

## Donor route map

| Donor route                 | Atlas Console disposition                                   |
| --------------------------- | ----------------------------------------------------------- |
| `/pair`                     | Redesign for Atlas browser authorization                    |
| `/connect` and callback     | Redesign for fleet connection                               |
| `/`                         | Fleet/workspace/run landing surface                         |
| `/draft/:draftId`           | Rebind to an unstarted Atlas run draft                      |
| `/:environmentId/:threadId` | Replace with node/workspace/run identity                    |
| `/settings/general`         | Restyle as Console display preferences                      |
| `/settings/providers`       | Redesign as bodies, backends, models, and node capabilities |
| `/settings/connections`     | Redesign as fleet endpoints and authorization               |
| `/settings/source-control`  | Rebind after Atlas owns repository integrations             |
| `/settings/keybindings`     | Reuse                                                       |
| `/settings/diagnostics`     | Redesign around Atlas traces, vitals, and lifecycle         |
| `/settings/beta`            | Retain only Console experiments                             |
| `/settings/archived`        | Rebind after Atlas exposes run retention/catalogs           |

Routes remain donor implementation until the Atlas resource model and list
contracts exist.

## Primary navigation

The target sidebar answers:

- Which fleet am I viewing?
- Which nodes are online, stale, or degraded?
- Which bodies and capabilities are available where?
- Which workspaces exist?
- Which runs are active, waiting, failed, or complete?
- Which approvals or questions require attention?

Sidebar V1 and V2 are donor implementations. The target is one Atlas-native
navigation model, not two permanently maintained sidebars.

## Run workspace

The stable visual regions remain useful:

1. Header: node, body, workspace, run identity, lifecycle, and panels
2. Timeline: messages, tools, delegation, approvals, questions, and errors
3. Composer: next intent, pending context, body/model/mode controls, submit or
   interrupt
4. Context panels: changes, files, terminal, and preview when the body advertises
   them

Unavailable capabilities must hide or explain their absence based on Atlas
manifests; the Console must not fabricate readiness.

## Run lifecycle

```text
draft
  → command acknowledged
  → turn started
  → streaming/activity
  → waiting for approval or answer
  → resumed
  → turn completed or interrupted
  → durable follow-up settled
```

The target protocol must distinguish response completion from full run
quiescence.

## Responsive behavior

Wide layouts may show navigation, timeline, and a context panel together.
Constrained layouts move navigation and context into sheets or exclusive tabs.
Consequential controls remain available in compact menus with accessible names.

## Runtime dependency

This information architecture is a target. The exact blockers and binding
contracts are maintained in:

- [Classification](../atlas-console/03-CLASSIFICATION.md)
- [Protocol binding](../atlas-console/04-PROTOCOL-BINDING.md)
- [Capability gaps](../atlas-console/05-GAPS.md)
