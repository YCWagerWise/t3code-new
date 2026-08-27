# apps/web/e2e — the frontend action suite

**There is one harness. This is it.** Eight overlapping bench tasks asked for a
frontend e2e suite; the failure mode is eight harnesses, which is the
duplicate-authority defect this channel rejects, spelled in TypeScript. Import
`fixtures/index.ts`. Do not write a second boot path.

## Run it

```
node apps/web/e2e/run.ts                 # everything
node apps/web/e2e/run.ts settings        # one spec file
```

Environment:

| var | meaning |
| --- | --- |
| `T3CODE_BACKEND` | defaults to `rust`. The point of the suite is the Rust backend. |
| `T3_E2E_CHROME` | explicit chromium binary. Otherwise resolved via playwright-core's registry, then the local browser cache. Never hardcode a path — that is #437. |
| `T3_E2E_REPORT` | where the coverage report JSON is written. |

On the build box: `CARGO_TARGET_DIR=~/builds/<cell>/target`, one per cell. An
ad-hoc per-run target dir is itself a finding — that habit is what put 799G on
the box.

## What this suite refuses to do

- **No mocked RPC or WebSocket.** A spec that mounts a component against a mock
  is a unit test with a `.spec` extension. Mocks cannot catch product-owned
  in-memory authority, which is the class of defect the suite exists for.
- **No `innerText` assertion on assistant output** (#435). The UI echoes the
  user's own prompt in the user bubble and renders a live `Working for Ns`
  timer, so text matching produces false passes — two were filed as passes
  before that finding. Assistant output is asserted on the frame:
  `Chunk -> values[].event.payload` with `role === "assistant"` and
  `streaming === false`.
- **No spinner assertion by CSS.** A spinner that stopped because the socket
  died is DOM-identical to one that settled. Settlement is `session-set running`
  **with** `activeTurnId`, then `session-set idle` **with** `activeTurnId: null`.
- **No `sleep()` as synchronization.** `waitFor(predicate, {ms, what})` is the
  only timer, and its `what` names the thing being waited for so a timeout is
  never silently reported as a product failure.
- **No hardcoded ports.** `dev-runner` hashes a port offset per worktree so
  several cells run at once. The ports are read off the runner banner. A
  screenshot of another cell's app is worse than no screenshot.
- **No skips.** No `it.skip`, no `todo()`, no assertion weakened until it cannot
  fail. A behaviour that does not work yet is a FAILING test plus a finding.

## Die is not Fail

`backend/src/server_main.rs` uses three terminal shapes and specs must keep them
apart:

| frame | meaning |
| --- | --- |
| `Exit.Success` | it worked |
| `Exit.Failure` / `cause[0]._tag === "Fail"` | a **declared** error from the RPC's own error channel — the backend correctly refusing |
| `Exit.Failure` / `cause[0]._tag === "Die"` | an unrecoverable defect. The backend uses this deliberately for an UNIMPLEMENTED method so it cannot masquerade as `Success(null)` (`server_main.rs:1865-1868`) |

A spec that flattens `Failure` reports "implemented" for a method that answered
"unimplemented". `Wire.outcomeOf` returns these as three distinct kinds on
purpose.

## Concurrency is asserted by ORDERING, never by a timeout

`Wire.answeredFirst(trivial, slow)`. Use it for anything about the socket.

Every outcome-with-a-generous-timeout spec on this bench goes **green** on a
socket that is head-of-line blocked, because with a long enough budget the reply
does arrive. Measured on a live backend: three requests sent 30 seconds apart,
all answered in the same millisecond at 33.89s. One of them failed pure argument
validation — no I/O, no worktree, no provider, nothing it could legitimately
wait for — and it still waited 3.2s behind an unrelated handler. A 60s timeout
calls that a pass.

The property that catches it has no milliseconds in it:

1. issue a request known to be slow, and **do not await it**;
2. issue a trivial one — one that fails argument validation is ideal, because it
   cannot be slow for any honest reason;
3. assert the trivial one's `Exit` arrives **first**.

Serialized that is impossible; concurrent it is guaranteed. So it cannot flake
on a box at load average 400 — which is the state this laptop is actually in —
and it fails for the right reason on a fast machine and a wrecked one alike.

Never assert "it responded within N seconds." That is the assertion that let the
defect ship.

## Settlement is measured against the EVENT'S clock, never wall-clock patience

`Wire.threadEvents()` and `Wire.deliveryLagMs(event)`.

A turn was measured starting and failing **88ms apart** — `updatedAt` 48.499 and
48.587 in its own two payloads — while the settling `thread.session-set idle`
did not reach the client until **25.00s**, because the tail parked, was never
woken by the publication, and returned on its own `Duration::from_secs(25)`
timeout (`server_main.rs:1658`). The UI spun for twenty-five seconds on a turn
that finished in a tenth of a second.

A spec asserting *"the spinner eventually stops"* **passes** that. A spec
asserting *"the spinner stopped within 2s of the turn's own `updatedAt`"*
catches it, and needs no magic threshold, because the payload carries the
server's own timestamp and the lag can simply be computed.

This is also what retires the "is it slow, or is it hung" argument the channel
spent rounds on. It is neither: it is a timer. **A delivery lag that keeps
landing on a round number equal to a timeout constant is a lost wake-up, not
latency** — report it as one.

## Coverage is reported with its denominator

Every spec ends by naming what it drove **and what it did not**. A method the UI
never dispatched is a NOOP, and a NOOP is a finding, not a pass. "All green"
over 4 of 21 is a blocker. Silent truncation of the action list reads as full
coverage.

## `restartBackend()` exists from the first commit

Even though only some specs call it today. Every durability claim needs it, and
retrofitting a restart fixture into thirty existing specs later is how it
quietly never happens. A test that does not restart the process proves the value
is in memory — which is the defect, not the feature.

## Superseding `e2e/drive-real-ui.cjs`

That file is a 121-line one-off, not a suite. It should be deleted once its two
useful facts live here — they already do: the `Local:` / `pairingUrl:` banner
parse (`fixtures/stack.ts`) and registry-based chromium resolution
(`fixtures/chrome.ts`). Two e2e entry points is the same defect one directory up.
