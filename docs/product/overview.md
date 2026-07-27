# Atlas Console product definition

## One-sentence definition

Atlas Console is a visual command center for observing and directing Atlas
bodies, nodes, workspaces, and durable runs.

## Product relationship

Atlas is the product and source of durable truth. The Console is a React lens
derived from the T3 Code web client.

The Console is not:

- Another agent runtime
- A provider registry with Atlas added beside Codex and Claude
- A second orchestration server
- The owner of Git, terminals, tools, approvals, or fleet state

Codex, Claude, Ollama, and other model runtimes are execution backends behind
Atlas. They may be selectable through Atlas, but they are not peer products in
the Console architecture.

## Product promise

> See the Atlas fleet, direct its work, intervene at consequential moments, and
> understand the resulting state from one responsive interface.

## Primary users

- An operator supervising several Atlas bodies and nodes
- A developer using the `coder` body against repositories
- A technical lead reviewing agent activity and changes
- A domain operator using bodies such as `k8s-agent` or `fliff-agent`
- A remote user reaching Atlas through an authenticated browser connection

## Product principles

### The body owns capability

If Telegram could not drive a feature without implementing it itself, that
feature belongs in Atlas rather than the Console.

### The Console renders truth

Status, models, tools, approvals, changes, and health come from Atlas snapshots
and ordered events. The browser does not infer body state from local processes.

### A run is larger than a chat

A durable run includes messages, turn lifecycle, tool effects, delegations,
policy decisions, workspace state, and recovery information.

### One lens addresses many bodies

The same Console becomes a coding workspace, cluster console, betting desk, or
fleet view based on the targeted Atlas body and its advertised capabilities.

### Interventions are first-class

Approvals, questions, interruption, policy, and errors must remain explicit and
durable. They cannot be hidden inside unstructured transcript text.

### Reconnection preserves meaning

A browser must resume from a durable cursor without duplicating or silently
losing events.

## Canonical objects

| Atlas object | Donor T3 alias          | Definition                                            |
| ------------ | ----------------------- | ----------------------------------------------------- |
| Fleet        | Environment collection  | Live Atlas nodes and their advertised capabilities    |
| Node         | Environment             | One atlas-host runtime participating in the fleet     |
| Body         | Provider-facing persona | A deployment plugin such as `coder` or `k8s-agent`    |
| Backend      | Provider                | A model execution implementation behind Atlas         |
| Model        | Model                   | A model actually routable through a backend on a node |
| Workspace    | Project                 | Repository or operational context a body acts upon    |
| Run          | Thread/session          | One durable Agent isolate and its history             |
| Turn         | Turn                    | One input-to-quiescence execution cycle               |
| Event        | Activity                | Ordered durable fact about a run or fleet             |
| Tool effect  | Tool activity           | Atlas-executed action and its result                  |
| Approval     | Approval request        | Durable policy gate awaiting an authorized decision   |

The mapping is expanded in
[the concept map](../atlas-console/02-CONCEPT-MAP.md).

## Current versus target

Atlas currently supports durable runs, tools, bodies, gossip, memory, traces,
and HTTP conversation routes. It does not yet expose every capability required
by the donor interface.

The Console documentation distinguishes:

- Current REST bindings
- Partial bindings
- Target WebSocket bindings
- Missing Atlas capabilities
- Unsupported donor products

See [protocol binding](../atlas-console/04-PROTOCOL-BINDING.md) and
[capability gaps](../atlas-console/05-GAPS.md).
