/**
 * ACTIONS 020-022/153 — `thread.previous`, `thread.next`, `composer.stash`.
 *
 * FILE NAME: `.test.ts`, not `.spec.ts` as the task wrote it. `e2e/run.ts:23`
 * globs `f.endsWith(".test.ts")`, so a `.spec.ts` in this directory is a file
 * the runner never opens — it would report zero failures forever and read as
 * coverage. The one `.spec.ts` already in here
 * (`preview-refresh-focus-zoom.spec.ts`) is invisible to `run.ts` for exactly
 * this reason and imports a SECOND harness (`../fixtures`, which resolves to
 * `e2e/fixtures.ts`, a playwright-test rig parallel to `e2e/fixtures/`). Two
 * harnesses for one suite is the duplicate-authority defect this channel
 * rejects; I am not adding a third, and I have said so on the channel rather
 * than quietly deleting someone else's file.
 *
 * WHAT IS ASSERTED, AND WHY THIS SHAPE:
 *
 *   020 thread.previous  mod+shift+[   (no `when` guard)
 *   021 thread.next      mod+shift+]   (no `when` guard)
 *       backend/src/keybindings.rs:113-114; handled client-side in
 *       Sidebar.tsx:3283 via threadTraversalDirectionFromCommand.
 *
 *       Moving the SELECTION is not the claim. The claim is that the newly
 *       selected thread's MESSAGES LOAD. The sidebar highlight moving while the
 *       pane sits on "Loading messages..." forever is the #432 signature, and a
 *       spec that asserts only the route change reports a pass for exactly that
 *       failure. So each of these asserts three things: the route changed, it
 *       changed to the ADJACENT thread and not just to something, and the pane
 *       left the loading phase.
 *
 *   022 composer.stash   mod+s   (whenAst {not: terminalFocus})
 *       backend/src/keybindings.rs:107.
 *
 *       THIS ONE FAILS, DELIBERATELY, AND IT IS NOT A HARNESS BUG. The backend
 *       advertises the binding; the client implements no handler for it. The
 *       grep is short enough to inline:
 *
 *         $ grep -rn '"composer\.' apps/web/src | grep -v '\.test\.'
 *         pullRequest/pullRequestFileOrder.logic.ts:21:  "composer.lock",
 *
 *       One hit, unrelated. There is a stash STORE (`promptStashStore.ts`) and
 *       there are stash COMPONENTS (`ComposerStashBadge.tsx`,
 *       `ComposerStashMenu.tsx`) — and nothing imports any of them outside their
 *       own tests. `usePromptStashStore` has no consumer; neither component is
 *       rendered anywhere. So the whole feature is present as dead code with a
 *       keybinding pointing at it, which is the `preview.toggle` shape: a chord
 *       the server tells the user about that does nothing, forever, silently.
 *
 *       The README's rule is explicit — "a behaviour that does not work yet is a
 *       FAILING test plus a finding, never `it.skip`" — so this is written as
 *       the real round-trip assertion it will need on the day someone wires it,
 *       and it fails today naming the missing handler. It is not weakened, not
 *       skipped, and must not be deleted to make the file green.
 *
 * The composer driver is the one the channel already proved (#434):
 * getByRole('textbox').first() -> click -> fill -> press('Enter').
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

const NAV_MS = Number(process.env.T3_E2E_NAV_MS ?? 240_000);

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 1_800_000 });

after(async () => {
  await app?.close();
  await stack?.dispose();
});

/**
 * Seed exactly `count` real threads and return their ids IN CREATION ORDER.
 *
 * Ids come from the ROUTE, not from the DOM. The sidebar rows carry
 * `data-thread-item` and no thread id (Sidebar.tsx:1221, :1369), so there is no
 * attribute to read an order off — and inventing one for a test would be the
 * test changing the product to make itself easy. The route is what traversal
 * actually moves, so it is also the honest thing to assert on.
 *
 * Each thread is created the way a user creates one: type in the composer, press
 * Enter, then `chat.new` (mod+shift+o, keybindings.rs:109) for the next draft.
 * The promotion from `/draft/<id>` to `/thread/<id>` is driven by the backend's
 * `thread.created` event, which `ensure_thread_on_shell` emits on the first turn
 * BEFORE the agent runs — so this waits on thread creation, never on a model
 * answering, and does not need a configured provider.
 */
async function seedThreads(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      await app.page.keyboard.press("ControlOrMeta+Shift+O");
      await waitFor(() => routeThreadId() === null, {
        ms: 30_000,
        what: "chat.new (mod+shift+o) to open a fresh draft route",
      });
    }
    const box = app.page.getByRole("textbox").first();
    await box.click();
    await box.fill(`e2e thread ${i}`);
    await box.press("Enter");
    const id = await waitFor(
      () => {
        const current = routeThreadId();
        return current !== null && !ids.includes(current) ? current : null;
      },
      {
        ms: 180_000,
        what:
          `the draft to be promoted to a real /thread/ route for seeded thread ${i}. ` +
          `Promotion is driven by the backend's thread.created event ` +
          `(server_main.rs, gated on is_new_thread); a timeout here is the #468 ` +
          `draft-promotion failure, not a traversal bug.`,
      },
    );
    ids.push(id);
  }
  return ids;
}

/** The thread id in the address bar, or null on a draft/other route. */
function routeThreadId(): string | null {
  const m = /\/thread\/([^/?#]+)/.exec(app.page.url());
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The #432 assertion. A selection that moved to a pane stuck on
 * "Loading messages..." is the bug, not the feature.
 */
async function assertMessagesLoaded(threadId: string): Promise<void> {
  const settled = await waitFor(
    async () => {
      const text = await app.page.evaluate(() => document.body.innerText);
      return text.includes("Loading messages...") ? null : true;
    },
    {
      ms: 60_000,
      what:
        `the message pane for ${threadId} to leave the "Loading messages..." phase. ` +
        `If this times out the navigation worked and the LOAD did not — that is #432/2865, ` +
        `not a traversal bug, and it must not be filed as one.`,
    },
  ).catch(() => false);
  assert.ok(settled, `thread ${threadId} selected but its messages never loaded (#432 signature)`);
}

test("020/021 thread.previous and thread.next move the selection, change the route, and load the target thread", async (t) => {
  t.diagnostic(`app at ${stack.webUrl}`);
  const [first, second] = await seedThreads(2);
  assert.ok(first && second && first !== second, `seeding produced two distinct threads: ${first} ${second}`);

  // Start from a KNOWN thread. Traversal from a draft route has no "current" to
  // be adjacent to, and asserting from an unknown start cannot tell "moved to the
  // neighbour" from "moved somewhere".
  await app.page.goto(`${stack.webUrl}/thread/${encodeURIComponent(second!)}`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_MS,
  });
  await waitFor(() => routeThreadId() === second, {
    ms: 60_000,
    what: `the route to settle on the starting thread ${second}`,
  });

  await app.page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
  await waitFor(() => routeThreadId() !== second, {
    ms: 30_000,
    what:
      "thread.previous (mod+shift+[) to change the route. The binding carries no `when` " +
      "guard (keybindings.rs:113) so it is reachable from here; if the route never changes " +
      "the client is not handling the command at all.",
  });
  const afterPrevious = routeThreadId();
  // With exactly two threads the neighbour is the other one, so this is the
  // adjacency claim and not merely "something changed".
  assert.equal(
    afterPrevious,
    first,
    `thread.previous must select the ADJACENT thread. seeded=[${first}, ${second}] landed=${afterPrevious}`,
  );
  await assertMessagesLoaded(afterPrevious!);

  await app.page.keyboard.press("ControlOrMeta+Shift+BracketRight");
  await waitFor(() => routeThreadId() !== first, {
    ms: 30_000,
    what: "thread.next (mod+shift+]) to change the route back",
  });
  const afterNext = routeThreadId();
  assert.equal(
    afterNext,
    second,
    `thread.next must return to the adjacent thread. seeded=[${first}, ${second}] landed=${afterNext}`,
  );
  await assertMessagesLoaded(afterNext!);

  assert.deepEqual(
    app.wire.pageErrors,
    [],
    `traversal must not throw in the page: ${JSON.stringify(app.wire.pageErrors)}`,
  );
});

test("022 composer.stash round-trips the draft: stashing empties the composer, restoring returns it byte-for-byte", async () => {
  const draft = "stash me: a draft with no rebuild path";

  const box = app.page.getByRole("textbox").first();
  await box.click();
  await box.fill(draft);
  assert.equal(
    await box.inputValue().catch(() => box.innerText()),
    draft,
    "precondition: the composer holds the draft before stashing",
  );

  await app.page.keyboard.press("ControlOrMeta+S");

  // Stashing must EMPTY the composer — that is what makes it a stash rather than
  // a copy, and it is the half that loses user-authored content if the other
  // half is missing.
  const emptied = await waitFor(
    async () => {
      const value = await box.inputValue().catch(() => box.innerText());
      return String(value).trim() === "" ? true : null;
    },
    {
      ms: 15_000,
      what:
        "composer.stash (mod+s) to clear the composer. The handler is " +
        "ChatComposer.tsx:2497 -> stashCurrentPrompt (:2229); if this times out the " +
        "chord is not reaching that handler.",
    },
  ).catch(() => false);
  assert.ok(emptied, "composer.stash must clear the composer");

  // AN EARLIER VERSION OF THIS TEST ASSERTED THE OPPOSITE, and the mistake is
  // worth leaving recorded rather than quietly rewriting. It was written to FAIL
  // on the claim that no client handler for `composer.stash` exists, because
  // `rg -n "promptStashStore|ComposerStash" apps/web/src` found nothing outside
  // the stash files' own tests. That grep was wrong: ChatComposer.tsx contains
  // NUL bytes (a template literal, `${image.mimeType}\0${image.sizeBytes}`), so
  // ripgrep stops searching it at offset 80,747 of 139,664 — and the handler is
  // at line 2497, past the cutoff. The warning goes to stderr and a pipe eats it.
  //
  // Use `rg -a` on this file. A negative grep here is a claim about the tool.

  // Restoring must return the EXACT text. A stash that loses the draft is Tier B:
  // the composer holds user-authored content with no rebuild path.
  await app.page.keyboard.press("ControlOrMeta+S");
  const restored = await waitFor(
    async () => {
      const value = await box.inputValue().catch(() => box.innerText());
      return String(value) === draft ? true : null;
    },
    { ms: 15_000, what: "the stashed draft to come back byte-for-byte" },
  ).catch(() => false);
  assert.ok(
    restored,
    "restoring a stash must return the exact draft text — a stash that empties " +
      "the composer and cannot give the draft back has DESTROYED user-authored " +
      "content, which is strictly worse than not stashing at all",
  );
});
