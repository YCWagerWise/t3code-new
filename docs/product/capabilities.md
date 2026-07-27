# Atlas Console capabilities

Every capability is split between what Atlas owns and what the Console renders.
An absent Atlas owner-side surface is a gap, not permission to implement the
capability in React.

## Fleet and nodes

Atlas owns membership, health, vitals, manifests, tools, bodies, and routing.
The Console renders fleet navigation, node status, capability filters, and
drill-in views.

Current binding: `/_members`, partial because it is gossip-gated and has no live
Console subscription.

## Bodies, backends, and models

Atlas owns body registration, backend execution, real model availability,
defaults, and capability truth. The Console renders body selection, backend and
model controls, health, and explanatory metadata.

Current state is partial; `/v1/models` is synthetic.

## Workspaces and runs

Atlas owns repository/operational workspaces, durable Agent isolates, warm
conversations, run history, and retention. The Console renders the
fleet-to-workspace-to-run hierarchy and run creation.

Atlas has addressed runs but no run or workspace list endpoints.

## Conversation and activity

Atlas owns turn execution, message persistence, tools, delegation, lifecycle,
and event ordering. The Console renders the timeline, streaming content,
activity cards, errors, and status.

Current `/since` and `/transcript` bindings are partial. The target durable feed
is specified in the protocol document.

## Policy, approvals, and questions

Atlas owns trust, policy evaluation, execution suspension, durable requests,
resolution, resumption, and audit. The Console renders decisions and submits
authorized responses.

The policy kernel exists, but the browser round-trip does not.

## Repository and change review

Atlas owns repository registration, branches, worktrees, Git operations,
checkpoints, diffs, and pull-request integration. The Console renders change
navigation, annotations, confirmation, and progress.

These operations currently exist in T3 or Warden, not in the Atlas substrate.

## Terminal

Atlas owns PTYs, processes, session identity, replay, input, resize, signals,
and termination. The Console renders terminal tabs and the interactive
viewport.

Hearth exists, but Atlas has no attach-capable human terminal API.

## Files and assets

Atlas owns authorized workspace access, path safety, content retrieval,
mutation policy, large objects, and retention. The Console renders trees,
previews, attachments, and annotations.

Filesystem browsing is currently absent by design and requires a security
decision.

## Application preview

Atlas owns development-server discovery and node-side browser/preview
execution. The Console renders navigation, viewport controls, annotations, and
automation visibility.

No Atlas preview surface exists today.

## Authentication and recovery

Atlas owns browser authorization, subscription scope, durable events, cursor
replay, epoch invalidation, and snapshots. The Console owns credential
bootstrap presentation, reconnect behavior, caching of server-stamped events,
and recovery feedback.

StudyOS is the preferred transport donor; Atlas has not adopted it yet.

## Display and productivity

Console-only responsibilities include:

- Layout and themes
- Keyboard shortcuts
- Panel arrangement
- Draft text
- Search and filters
- Accessible names and focus behavior
- Responsive presentation

These preferences should not become Atlas body capability.
