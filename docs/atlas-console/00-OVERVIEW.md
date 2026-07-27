# Atlas Console overview

## Definition

Atlas Console is a React lens over Atlas and its deployments. It uses the T3
Code web client as donor UI, but Atlas is the product, runtime, and source of
truth.

> Atlas Console is the visual command center for the Atlas fleet.

The donor relationship is:

```text
T3 React interaction patterns
              +
Atlas-owned capabilities and protocol
              =
Atlas Console
```

It is not:

```text
T3 Code + Atlas as one more provider
```

## Body and lens

`atlas-rs/docs/ATLAS-ARCHITECTURE.md` defines the governing rule:

- Atlas plus its deployments are the **body**.
- A human-facing view is a **lens**.
- A lens renders, observes, and sends intent.
- A lens owns no capability that another Atlas lens or deployment would need.

Telegram is lens one. Warden is lens two. Atlas Console is lens three:
Telegram with a much better screen.

### The Telegram test

For every proposed feature, ask whether a pure Telegram window could drive the
same body capability. If not, the capability is misplaced in the lens and must
move into Atlas.

Examples:

- Rendering a diff belongs to the lens.
- Computing and storing the diff belongs to Atlas.
- Drawing a terminal belongs to the lens.
- Owning the PTY belongs to Atlas.
- Displaying an approval belongs to the lens.
- Enforcing and suspending on that approval belongs to Atlas.

## One lens, many bodies

```text
Atlas Console → coder       = coding workspace
Atlas Console → k8s-agent   = cluster operations console
Atlas Console → fliff-agent = betting desk
Atlas Console → the fleet   = workforce console
```

The body supplies the domain. The lens adapts its navigation and available
controls to advertised capabilities.

## Console ownership

The React lens owns:

- Navigation and information hierarchy
- Layout and responsive behavior
- Display preferences
- Draft input before submission
- Rendering Atlas snapshots and events
- Optimistic feedback reconciled against server events
- Search, filtering, and command discovery
- Accessibility and keyboard behavior
- Local panel arrangement

It does not own durable runtime truth.

## Atlas ownership

Atlas owns:

- Durable runs and conversations
- Agent coordination and delegation
- Body and backend execution
- Node and fleet discovery
- Body, backend, and real-model availability
- Workspace and repository operations
- Worktrees, Git state, diffs, and checkpoints
- Shell and terminal sessions
- Filesystem authorization and access
- Tool execution
- Policy, approvals, and questions
- Ordered streaming events and recovery
- Assets, traces, and lifecycle state

Several responsibilities on this list do not yet have a Console-bindable Atlas
surface. They are recorded in [the gap registry](./05-GAPS.md).

## Donor code status

The current fork still registers Atlas through
`ProviderDriverKind.make("atlas")` and presents it beside other T3 providers.
That is a transitional implementation detail and does not define the target
product model.

The documentation classifies donor code before runtime stripping:

- Reuse generic React primitives.
- Restyle T3 terminology and marks.
- Rebind valuable UI to Atlas state.
- Redesign project/provider assumptions around fleet concepts.
- Remove duplicated body logic from the lens.
- Remove unsupported T3 product integrations.

See [the classification](./03-CLASSIFICATION.md).

## Current technical truth

Atlas currently exposes poll-oriented HTTP:

- `/start`, `/run`, `/say`
- `/output`, `/since`, `/transcript`, `/status`, `/spans`
- `/_members` and `/_presence` when gossip is enabled
- internal delivery, migration, trace, and compatibility routes

Atlas does not currently expose a functional Console WebSocket protocol.
do-host can upgrade a socket, but atlas-host registers no class that handles
WebSocket messages.

StudyOS supplies the preferred durable transport donor. Warden supplies the
preferred initial event and command vocabulary. Atlas must adopt and own the
result, then publish its runtime lifecycle into it.

## Product hierarchy

```text
Fleet
└── Node
    ├── Body and backend capabilities
    └── Workspace
        └── Run
            └── Turn
                ├── Messages
                ├── Tool activity
                ├── Approvals and questions
                └── Resulting workspace state
```

Fleet and node exist partially today. Workspace catalogs, run catalogs, rich
events, approvals, and workspace panels are capability gaps.

## Documentation outputs

- A reproducible 432-file donor inventory
- A machine-readable disposition for every inventoried file
- A T3-to-Atlas concept map
- A 73-method T3 RPC binding matrix
- A StudyOS/Warden-derived target protocol
- A numbered, layer-owned Atlas gap registry

These documents are migration inputs. They do not claim that the target
protocol or absent body capabilities have been implemented.
