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
