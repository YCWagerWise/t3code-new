# 17 — Browser bug hunt, 2026-08-03 (hands-on, live rig :5734 → node :3199)

Method: a real browser driven click-by-click against the dev rig (lens working tree via
Vite :5734, node = debug binary restarted 10:04 with 8087ecf + c69b53b), verifying every
UI claim against the node's `/console/v1` feed, the supervisor event log, `agent_control`
rows in the Agent isolate DB, and the workspace on disk. Every finding below has wire or
disk evidence, not just a screenshot.

## Confirmed bugs

### B1 — Draft send is dead in the browser (critical, regression)

With the send button **visible, enabled, labelled "Send message"**, pressing Enter (or
clicking) in a `/draft/…` composer fires **zero network requests**: no command POST, no
user frame on the feed, text stays in the composer, no error anywhere. Existing threads
still send. Client-runtime's flow oracle (5001b3d0, 11/11) passes because the break is in
the apps/web layer — the browser boundary again. Regressed somewhere in the
9:48–10:05 batch (prime suspect: 7a675f4b lazy-create rewiring the draft submit
contract). The e2e conversation suite (`e2e/tests/conversation.spec.ts`) fails 5/5 on
exactly this and is the regression harness for the fix.

### B2 — A failed thread stays wedged forever, and the lens never says so (critical)

Chain of evidence on `thr-rig`:

1. attempt:2 (the user's browser.txt prompt, 9:38) → `run.stalled: startup_timeout`;
   supervisor recovery wrote `agent_control = cancel_requested=1, state='cancelled'`
   (durable row, Agent/thr-rig.db).
2. attempt:3 (10:15, fixed binary): provider connects, then dies in 200ms —
   `"cancelled — graceful stop at the Action boundary (C3)"`, `outcome: failed,
retryable: false`. The stale durable cancel kills every new attempt at its first
   Action boundary. **Start never clears/re-scopes the C3 control row.**
3. Even after deleting the row by hand, attempt:4 (direct POST, accepted) emitted
   `turn start` and then nothing — no provider spawn, no `run.stalled` on the feed.
   A second durable wedge beyond agent_control (likely CLI session resume state in the
   Workspace isolate).
   Lens side: the C3 failure surfaced as **stale success** — previous turn's "changed /
   1 changed file" still on screen, no error banner (the `runtime.error` activity appears to
   be swallowed/folded), working spinner persists, and follow-up sends are accepted into a
   void (optimistic user row renders, nothing on the wire). Doc-12-rule-8 class violation.

### B3 — Node: CORS middleware does not cover unmatched routes

`OPTIONS /api/orchestration/shell` → **404 with no CORS headers**. `cors::layer` is
attached to the `extra` router (lib.rs:3792); paths matching no route fall through to the
host router's fallback OUTSIDE the middleware, so preflights to unknown paths are never
answered. Fix: apply the layer on the outermost merged router (or give `extra` a
fallback). Found because of B4's leaked calls.

### B4 — Lens still calls T3-native RPCs against an Atlas node

Every shell poll fires `GET /api/orchestration/shell`
(`state/shellSnapshotHttp.ts:32`), and draft promotion fires
`GET /api/orchestration/threads/{id}` — both T3-server routes the node does not serve,
CORS-blocked console spam on every cycle. T3-server assumptions that doc 15's swap
missed; whatever consumes them degrades silently.

### B5 — Wrong token is indistinguishable from an empty node (recorded in doc 15)

401/403 maps to `ConnectionBlockedError(permission)` in the transport, but the index
route renders the refused catalog as the "No projects yet" hero. Desired assertion is
pinned under `test.fail()` in `e2e/tests/boundary.spec.ts`.

### B6 — Enter while connecting silently drops input

Before the session is ready, Enter in the composer does nothing and queues nothing — no
feedback, text just sits. (Distinct from B1: this one resolves once ready; B1 never does.)
`e2e/rig/ui.ts` sendPrompt now waits for send-enabled and asserts the composer drains.

## Observations (not code bugs, worth knowing)

- **O1** The dev node now runs with workspace roots widened to `$HOME` (home dir,
  `~/Workspace`, repos are registered workspaces). `/etc` correctly refused. Fine for a
  token-gated dev rig; combined with B5's silence it would be a bad day in prod.
- **O2** Node stdout logs nothing when turns fail (`startup_timeout`, C3 kills are
  feed/event-log-only). Root-causing required sqlite spelunking; a `[turn]` stderr line
  per terminal state would have made tonight 10× faster.
- **O3** Draft header shows the raw UUID ("Thread a1445d3a-…"); directory picker offers
  "Create & Add" for nonexistent paths with an empty listing and no "no such directory"
  feedback.
- **O4** Sidebar inline rename (dblclick) did not open its editor under automation;
  unconfirmed whether human dblclick works — needs a look.
- **O5** Reins (browser MCP) corrupted its response pipeline mid-hunt (responses crossed
  between calls after a ~1.3MB screenshot payload; eval channel then returned empty
  forever). Hunt completed via CDP on the Playwright chromium instead. Extension needs a
  reload; saved to fleet memory.

## What provably works through the browser (same session, same rig)

Boot → connected composer; catalog/project list from `/_workspaces`; feed replay renders
an old thread's timeline; sends into an existing healthy thread reach the node (user
frame on the wire at seq 20); model picker offers exactly the manifest model
(`claude-opus-4-8` / Atlas); CORS for matched routes incl. `traceparent` echo; solo-node
`/_members`; auth gate (no token → `/pair`).

## Harness

`e2e/` (Playwright): boots its own node + Vite from nothing; `boundary.spec.ts` 7/8 green
(8th = B5 under `test.fail()`); `conversation.spec.ts` red 5/5 on B1 — it stays red until
B1 is fixed, which is the point. Run: `pnpm e2e` at the repo root.
