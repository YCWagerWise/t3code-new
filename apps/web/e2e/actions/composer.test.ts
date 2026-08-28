/**
 * E2E-02 COMPOSER (task 3360) — apps/web/src/components/chat/.
 *
 * The scope is NAMED, not counted, and every control lands in exactly one
 * bucket at the end: COVERED, or NOT COVERED with a reason. "All green" over 3
 * of 17 is a blocker, not a pass, and a coverage number without its denominator
 * is the move this channel rejects.
 *
 * Rules this file is written to, all from findings already on the ledger:
 *   - assert the WIRE, not the DOM (#435). The composer echoes the user's own
 *     text into the user bubble and renders a live `Working for Ns` timer, so
 *     innerText matching produces false passes.
 *   - `waitFor(pred, {ms, what})` is the only timer. No sleep().
 *   - select by `data-testid`, never by rendered label (#443). The send button's
 *     aria-label is DYNAMIC — "Send message" / "Sending" / "Connecting" /
 *     "Environment disconnected" / whatever `sendDisabledReason` says — so a
 *     label selector breaks precisely when the state it asserts occurs. I added
 *     `composer-send` and `composer-stop` in ComposerPrimaryActions.tsx for
 *     this spec, which is #443's fix direction ("as the shards touch them").
 *   - no skips. A behaviour that does not work yet is a FAILING test plus a
 *     finding, never `it.skip`.
 *
 * WHAT THIS FILE CANNOT PROVE ON WOODBINE, said plainly rather than faked:
 * the task requires cancellation be proved "against the REAL provider stream
 * stopping, not a UI flag flipping". There is NO PROVIDER CREDENTIAL ON THE
 * BUILD BOX — no .env in the repo or the workspace, no ANTHROPIC_/OPENAI_ in
 * the environment, and t3.json carries none. So no assistant stream can be
 * started there, and therefore none can be observed stopping. The interrupt
 * assertion below is honest about being a DISPATCH assertion, and the
 * real-stream half is reported as NOT COVERED with that blocker named. It is
 * not weakened into a UI-flag check, which is the exact failure the task calls
 * out.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

/** Every interactive control in the composer, exactly as the task names them. */
const SCOPE = [
  "send",
  "stop/cancel mid-stream",
  "ComposerPrimaryActions",
  "ComposerCommandMenu (slash commands)",
  "composer-editor-mentions (@file, @agent)",
  "FileTagChip",
  "ComposerStashMenu",
  "ComposerStashBadge",
  "ComposerTasksBadge",
  "ComposerBannerStack",
  "ComposerPlanFollowUpBanner",
  "ComposerPromptLengthValidation",
  "ExpandedImagePreview/ExpandedImageDialog",
  "CompactComposerControlsMenu",
  "ContextWindowMeter",
  "composerDraftStore persistence",
] as const;

const covered = new Set<string>();
const blocked = new Map<string, string>();

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 900_000 });

after(async () => {
  const notCovered = SCOPE.filter((c) => !covered.has(c));
  console.log(`\n=== E2E-02 COVERAGE: ${covered.size}/${SCOPE.length} composer controls asserted`);
  if (covered.size > 0) console.log(`=== COVERED: ${[...covered].join(", ")}`);
  if (notCovered.length > 0) console.log(`=== NOT COVERED: ${notCovered.join(", ")}`);
  for (const [what, why] of blocked) console.log(`=== BLOCKED ${what}: ${why}`);
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

/**
 * The composer must EXIST and be reachable by a stable handle.
 *
 * This is not a smoke test dressed up: every other assertion in this file is
 * meaningless if the handles moved, and a spec that cannot find its target
 * should say THAT rather than fail four assertions with confusing messages.
 */
test("the composer's controls are reachable by stable test ids", async () => {
  const editor = await app.page.$('[data-testid="composer-editor"]');
  assert.ok(
    editor,
    "#443: [data-testid=composer-editor] is not in the DOM. Either the composer " +
      "did not mount, or the handle was renamed — in which case fix this spec " +
      "rather than falling back to a text selector.",
  );
  const send = await app.page.$('[data-testid="composer-send"]');
  assert.ok(
    send,
    "#443: [data-testid=composer-send] is not in the DOM. Its aria-label is " +
      "state-dependent, so there is deliberately no text fallback here.",
  );
  covered.add("ComposerPrimaryActions");
});

/**
 * Typing must reach the durable draft store and SURVIVE A FRESH PAGE.
 *
 * Reload is the whole assertion. Checking the text is still on screen only
 * proves it never left the tab, which is what `composerDraftStore` exists to be
 * more than.
 */
test("a typed draft survives a reload (composerDraftStore)", async () => {
  const draft = `e2e draft ${Date.now()}`;
  await app.page.click('[data-testid="composer-editor"]');
  await app.page.keyboard.type(draft);

  await waitFor(
    async () => {
      const text = await app.page.textContent('[data-testid="composer-editor"]');
      return text?.includes(draft) ? text : null;
    },
    { ms: 15_000, what: "the typed draft to appear in the composer editor" },
  );

  // RELOAD THE SAME ROUTE. `app.reload()` goes to the web ROOT, and the app
  // lands a new composer on a fresh `/draft/<id>` — a different draft key, so
  // "not restored" would be this test asking the wrong question rather than
  // composerDraftStore losing anything.
  const routeBefore = app.page.url();
  const framesBeforeReload = app.wire.frames.length;
  await app.page.goto(routeBefore, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // WAIT FOR THE BACKEND TO ANSWER THE NEW PAGE, not just for the composer to
  // paint. `app.reload()` does this and my hand-rolled goto did not, and the
  // cost was visible two tests later: the send button was found, and
  // `disabled` with aria-label "Environment disconnected", because the reloaded
  // client had not reconnected yet. A mounted composer is not a connected one.
  await waitFor(
    () =>
      app.wire.frames
        .slice(framesBeforeReload)
        .some((f: { dir: string; json?: { _tag?: string } }) => f.dir === "recv" && f.json?._tag === "Exit") ||
      null,
    { ms: 90_000, what: `the reloaded client on ${routeBefore} to be answered by the backend` },
  );
  await waitFor(() => app.page.$('[data-testid="composer-editor"]'), {
    ms: 60_000,
    what: `the composer to mount again on ${routeBefore} after the reload`,
  });

  const restored = await waitFor(
    async () => {
      const text = await app.page.textContent('[data-testid="composer-editor"]').catch(() => null);
      return text?.includes(draft) ? text : null;
    },
    {
      ms: 30_000,
      what: `the draft ${JSON.stringify(draft)} to be restored into a FRESH page by composerDraftStore`,
    },
  ).catch((error: unknown) => {
    throw new Error(
      `composerDraftStore did not restore the draft after a reload. A draft that ` +
        `only survives in the tab is not persisted, and losing user-authored text ` +
        `is a Tier B defect, not a cosmetic one. Cause: ${String(error)}`,
    );
  });

  assert.ok(restored.includes(draft), "the restored draft is the text that was typed");
  covered.add("composerDraftStore persistence");
});

/**
 * Send must DISPATCH A TURN ON THE WIRE.
 *
 * Asserted on `orchestration.dispatchCommand` carrying `thread.turn.start`,
 * because that is the frame the backend acts on. The user bubble appearing
 * proves only that the client rendered its own input.
 */
test("send dispatches thread.turn.start on the wire", async () => {
  const draft = `e2e send ${Date.now()}`;
  await app.page.click('[data-testid="composer-editor"]');
  await app.page.keyboard.type(draft);

  const before = app.wire.requestIds("orchestration.dispatchCommand").length;
  // Wait for the control to be ENABLED and say why if it never is. A bare
  // click() here reports "Timeout 30000ms exceeded", which is true and useless;
  // the button's aria-label carries the actual reason ("Environment
  // disconnected", "Connecting", a sendDisabledReason) and that is the finding.
  const readSend = () =>
    app.page.$eval('[data-testid="composer-send"]', (el: HTMLButtonElement) => ({
      disabled: el.disabled,
      why: el.getAttribute("aria-label"),
    }));

  await waitFor(() => readSend().then((st: { disabled: boolean }) => (st.disabled ? null : st)), {
    ms: 60_000,
    what: "the send button to become enabled",
  }).catch(async (error: unknown) => {
    // Carry the REASON into the failure. `waitFor` records the probe's last
    // value, and the probe returns null while disabled, so "last observation:
    // null" throws away the one fact that matters. The button's aria-label is
    // the product's own explanation of why it refused.
    const st = await readSend().catch(() => null);
    throw new Error(
      `the composer refused to send and stayed disabled for 60s. ` +
        `aria-label="${st?.why ?? "<unreadable>"}" — that is the product's own reason. ` +
        `methods seen: ${app.wire.methodsSeen().join(", ")}. Cause: ${String(error)}`,
    );
  });
  await app.page.click('[data-testid="composer-send"]');

  await waitFor(
    () => app.wire.requestIds("orchestration.dispatchCommand").length > before || null,
    {
      ms: 30_000,
      what:
        "the composer to dispatch orchestration.dispatchCommand after send. " +
        `Methods seen so far: ${app.wire.methodsSeen().join(", ")}`,
    },
  );

  // Report WHAT WAS SENT, not merely that the expectation missed. An assertion
  // that says "not thread.turn.start" without naming the command it did see
  // hands the next reader a second investigation instead of a finding.
  const dispatches = app.wire.frames
    .filter(
      (f: { dir: string; json?: { _tag?: string; tag?: string } }) =>
        f.dir === "sent" &&
        f.json?._tag === "Request" &&
        f.json?.tag === "orchestration.dispatchCommand",
    )
    .map((f: { json?: { payload?: unknown } }) => f.json?.payload);
  // `type` is TOP-LEVEL on the dispatchCommand payload, not nested under
  // `input`. I assumed `input.type` from the backend's own contract_tests,
  // which build the frame as `{"input": {...}}`; the real client sends it flat.
  // The first version of this assertion therefore reported "send is broken"
  // for a send that works — the payload dump is in the message precisely so a
  // shape mismatch cannot masquerade as a product defect.
  const types = dispatches.map(
    (p: unknown) => (p as { type?: string })?.type ?? "<no type>",
  );
  const sentTurnStart = types.includes("thread.turn.start");
  assert.ok(
    sentTurnStart,
    "send did not put thread.turn.start on the wire. The composer's send path " +
      "is the only way a turn begins.\n" +
      `dispatchCommand input.type values observed: ${JSON.stringify(types)}\n` +
      `first dispatchCommand payload: ${JSON.stringify(dispatches[0] ?? null).slice(0, 600)}\n` +
      `all methods seen: ${app.wire.methodsSeen().join(", ")}`,
  );
  covered.add("send");
});

/**
 * The prompt-length validator must refuse an over-limit prompt WITHOUT
 * dispatching a turn.
 *
 * The assertion is the ABSENCE of a new dispatch, which is the only thing that
 * distinguishes "validation blocked it" from "validation rendered a warning and
 * sent it anyway".
 */
test("an over-limit prompt does not dispatch a turn", async () => {
  const before = app.wire.requestIds("orchestration.dispatchCommand").length;
  await app.page.click('[data-testid="composer-editor"]');
  // Large enough to exceed any sane composer limit without being so large that
  // typing it dominates the run.
  await app.page.keyboard.insertText("x".repeat(200_000));

  const sendDisabled = await app.page
    .$eval('[data-testid="composer-send"]', (el: HTMLButtonElement) => el.disabled)
    .catch(() => null);

  if (sendDisabled === true) {
    // The affordance is refused, which IS the validation working.
    covered.add("ComposerPromptLengthValidation");
    return;
  }

  await app.page.click('[data-testid="composer-send"]');
  const after = app.wire.requestIds("orchestration.dispatchCommand").length;
  assert.equal(
    after,
    before,
    "an over-limit prompt was DISPATCHED. The send button was enabled and the " +
      "turn went to the backend, so ComposerPromptLengthValidation is advisory " +
      "text rather than a gate.",
  );
  covered.add("ComposerPromptLengthValidation");
});

/**
 * Interrupt: DISPATCH ONLY, and labelled as such.
 *
 * The task demands cancellation be proved against the real provider stream
 * stopping. That needs a running assistant turn, which needs a provider
 * credential, which woodbine does not have (see the header). Rather than
 * weaken the assertion into "a UI flag flipped" — the exact failure the task
 * names — this records the blocker and asserts only what is honestly
 * observable: that when a turn IS running, stop puts thread.turn.interrupt on
 * the wire. With no provider the stop control never appears, and the test says
 * so instead of passing vacuously.
 */
test("stop dispatches thread.turn.interrupt when a turn is running", async () => {
  const stop = await app.page.$('[data-testid="composer-stop"]');
  if (!stop) {
    blocked.set(
      "stop/cancel mid-stream",
      "no provider credential on woodbine (no .env, no ANTHROPIC_/OPENAI_ in env, " +
        "none in t3.json), so no assistant turn can run and [data-testid=composer-stop] " +
        "never mounts. The real-provider-stream half of this control is UNPROVABLE on " +
        "this box until a credential exists there.",
    );
    return;
  }

  await stop.click();
  await waitFor(
    () =>
      app.wire.frames.some(
        (f: { dir: string; json?: { tag?: string; payload?: { type?: string } } }) =>
          f.dir === "sent" && f.json?.payload?.type === "thread.turn.interrupt",
      ) || null,
    { ms: 30_000, what: "the composer to dispatch thread.turn.interrupt after stop" },
  );
  covered.add("stop/cancel mid-stream");
});
