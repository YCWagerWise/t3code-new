/**
 * E2E-G — preview / previewAutomation / pullRequests / review (task 3203).
 *
 * WHAT THIS FILE CAN AND CANNOT ASSERT, said up front because the boundary
 * decided its whole shape.
 *
 * `Wire` is an OBSERVER: it records the frames the APP sends and receives. It
 * has no injection primitive, deliberately — every assertion in this suite is
 * about what the product does, not about what a test can poke at a socket. So
 * a method the UI never dispatches CANNOT be covered from here, and 27 of the
 * methods in this task's scope are exactly that: the app has no affordance
 * that dispatches them against a backend that refuses them.
 *
 * I probed all 27 on a raw socket against a live Rust backend and put the
 * matrix in the channel evidence rather than smuggling an injection helper
 * into the shared fixtures — `apps/web/e2e/fixtures` is one authority and a
 * second one added quietly is the defect this suite exists to avoid. If the
 * fixtures' owner wants a `Wire.call()`, several tasks would use it; that is
 * their call to make, not mine to make by committing it.
 *
 * So this file asserts the half that IS the product's behaviour: what the UI
 * does with a feature whose backend refuses it. That is also the half the task
 * says is the real finding — "assert the failure is VISIBLE, not a dead button
 * or a spinner".
 *
 * VERIFIED ON THE WIRE, and the reason each assertion below is worth making:
 *   preview.*, previewAutomation.*  10/10 -> Die "unsupported method: <name>"
 *   pullRequests.* reads             7/7  -> Fail(PullRequestUnavailableError,
 *                                            reason "provider-unsupported")
 *   pullRequests.* mutations        10/10 -> Fail(PullRequestOperationError,
 *                                            operation named)
 *   review.getDiffPreview                 -> Success
 *   review.getDiffFileContents            -> Success for a tracked file
 *
 * The pullRequests split is CORRECT and intentional; "pullRequests is
 * unimplemented" is not a finding. `provider-unsupported` is a PERMANENT
 * answer, which is what makes a spinner on that path wrong rather than slow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, openApp, type StackHandle, type App } from "../fixtures/index.ts";

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
});

after(async () => {
  await app?.close();
  await stack?.dispose();
});

/**
 * A permanent refusal must not leave the user watching a progress indicator.
 *
 * This is the task's own bar. `provider-unsupported` cannot become supported by
 * waiting, so anything still spinning after the app has settled is waiting for
 * something that will never arrive — a different defect from "slow", and one a
 * timing-based assertion would mistake for it.
 */
test("no surface is left spinning after the app has settled", async () => {
  const spinners = await app.page.locator('[role="progressbar"]').count();
  assert.equal(
    spinners,
    0,
    "a progress indicator is still present after the app settled. On the pull-request " +
      "surfaces the backend's answer is `provider-unsupported`, which is PERMANENT — " +
      "a spinner there can never resolve.\n" +
      app.wire.transcript(),
  );
});

/**
 * The boot path must not carry an unrecoverable defect.
 *
 * `Die` is this backend's channel for UNIMPLEMENTED (server_main.rs:1865-1868),
 * so a `Die` the user did not ask for means the client dispatched something the
 * server cannot do, on its own, before anyone clicked anything. That is a real
 * finding whichever method it names — and naming it is why this asserts on the
 * transcript rather than on a count.
 */
test("opening the app dispatches nothing the backend answers with a defect", async () => {
  const dies = app.wire.frames
    .filter((f) => f.dir === "recv" && f.json?._tag === "Exit")
    .filter((f) => f.json?.exit?.cause?.[0]?._tag === "Die")
    .map((f) => String(f.json.exit.cause[0].defect).split("\n")[0]);

  assert.deepEqual(
    dies,
    [],
    `the app asked for ${dies.length} thing(s) the backend answered with an unrecoverable ` +
      `defect, on the ordinary boot path:\n  ${dies.join("\n  ")}`,
  );
});

/**
 * The console is part of the product's honesty.
 *
 * A refusal the UI swallows into a console error is not a degraded feature, it
 * is a hidden one — and this suite's whole subject is whether an absent backend
 * degrades VISIBLY.
 */
test("boot is clean: no console errors and no uncaught page errors", async () => {
  assert.deepEqual(app.wire.pageErrors.map(String), [], "uncaught page errors on the boot path");
  assert.deepEqual(app.wire.consoleErrors, [], "console errors on the boot path");
});

/**
 * COVERAGE, reported with its denominator.
 *
 * Not an assertion about correctness — a statement of what this run actually
 * drove, so "all green" can never stand in for "we drove four of twenty-seven".
 * It fails only if the app dispatched NOTHING, which would mean the harness
 * attached after the traffic and every other assertion here is vacuous.
 */
test("this run drove real traffic, and reports what it drove", async () => {
  const seen = app.wire.methodsSeen();
  assert.ok(
    seen.length > 0,
    "the app dispatched no RPC at all — the recorder attached too late and every " +
      "assertion in this file would pass vacuously",
  );
  const inScope = seen.filter(
    (m) => m.startsWith("preview") || m.startsWith("pullRequests.") || m.startsWith("review."),
  );
  console.log(
    `E2E-G coverage: the app dispatched ${inScope.length} of the 27 scoped methods on this path` +
      (inScope.length ? `: ${inScope.join(", ")}` : "") +
      `\n  (${seen.length} methods dispatched overall)`,
  );
});
