/**
 * E2E-05 — diff / changed files / source control (task 3109).
 *
 * THE TIER-A ASSERTION, and the reason this file exists:
 *
 *   The changed-files panel must show an edit the product never saw happen.
 *
 * The spec makes an OUT-OF-BAND change — a `sed -i` and a heredoc, run through
 * a shell, with no edit tool and no RPC involved — and asserts the workspace
 * truth the client receives contains it. A change list assembled from the
 * agent's own tool calls CANNOT see that write. So this is not a UI test with a
 * filesystem flavour: it is the falsification of "the change list is derived
 * from what we did" versus "the change list is derived from what is there".
 * If it fails, the fix is `cairn::Repo`'s checkpoint diff, not the frontend, and
 * a frontend workaround would convert a layering defect into permanent green CI.
 *
 * Everything is read, never assumed:
 *   - the WATCHED REPO comes off the `subscribeVcsStatus` request payload. The
 *     backend watches a cwd the client chose; hardcoding a path tests a repo
 *     nobody is looking at.
 *   - the marker is unique per run, so a stale worktree from a previous run
 *     cannot make this pass.
 *
 * Cleanup is in `after` and runs even when the assertions fail, because a spec
 * that leaves `?? oob-*.txt` in a shared checkout poisons every other cell's
 * `git status` — and on this channel that is how a working tree gets blamed on
 * a product defect.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

const MARKER = `OOB-${process.pid}-${Math.floor(Date.now() / 1000)}`;
const NAV_MS = Number(process.env.T3_E2E_NAV_MS ?? 240_000);

let stack: StackHandle;
let app: App;
let watchedCwd = "";
let untrackedFile = "";
/** The tracked file this run edits, chosen at runtime from `git ls-files`. */
let trackedFile = "";

const sh = (script: string): string =>
  execFileSync("bash", ["-lc", script], { encoding: "utf8" });

const gitStatus = (): string =>
  execFileSync("git", ["-C", watchedCwd, "status", "--porcelain"], { encoding: "utf8" });

before(async () => {
  stack = await startStack();
  app = await openApp(stack);

  // The repo the client actually asked the backend to watch.
  const request = await waitFor(
    () =>
      app.wire.frames.find(
        (f) => f.dir === "sent" && f.json?._tag === "Request" && f.json?.tag === "subscribeVcsStatus",
      ) ?? null,
    { ms: 90_000, what: "the client to subscribe to vcs status, which is what names the repo under test" },
  );
  watchedCwd = String((request.json as any).payload?.cwd ?? "");
  assert.ok(watchedCwd, "subscribeVcsStatus carried no cwd, so there is no repo to assert against");
  untrackedFile = `oob-${MARKER}.txt`;

  // PICK A TRACKED FILE THE RUNNING APP DOES NOT LOAD, and pick it at runtime
  // rather than hardcoding one that may not exist in every checkout.
  //
  // My first version edited `package.json`, which was a genuine own-goal worth
  // recording: prepending to it makes it invalid JSON, the dev server reads it,
  // and the whole stack fell over MID-TEST. The run then reported "the vcs
  // stream never saw the edit" — which reads as a product defect and is not one.
  // The test killed the thing it was measuring. An out-of-band edit must be
  // out-of-band AND inert.
  const tracked = execFileSync("git", ["-C", watchedCwd, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.(ts|md|txt)$/.test(l))
    .filter((l) => /integration|fixtures|test|README/i.test(l))
    .filter((l) => !l.includes("node_modules"));
  assert.ok(
    tracked.length > 0,
    `no inert tracked file to edit under ${watchedCwd}; the spec will not edit a ` +
      `file the running app might load.`,
  );
  trackedFile = tracked[0]!;
}, { timeout: 1_800_000 });

after(async () => {
  if (watchedCwd) {
    // Restore whatever we touched. `git checkout --` is scoped to the one file
    // this spec edits; nothing here may discard another agent's work.
    try {
      sh(
        `cd ${JSON.stringify(watchedCwd)} && ` +
          (trackedFile ? `git checkout -- ${JSON.stringify(trackedFile)} 2>/dev/null; ` : "") +
          `rm -f ${JSON.stringify(untrackedFile)}`,
      );
    } catch {
      /* reported by the assertion below on the next run rather than swallowed here */
    }
  }
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

/** The workspace truth most recently pushed to this client, off the wire. */
function latestWorkspaceTruth(): any | null {
  const events = app.wire.frames
    .filter((f) => f.dir === "recv" && f.json?._tag === "Chunk")
    .flatMap((f) => (Array.isArray(f.json.values) ? f.json.values : []))
    .filter((v: any) => v?.local?.workingTree);
  return events.length ? events[events.length - 1].local : null;
}

test("the changed-files truth includes an edit the product never saw happen", async (t) => {
  // A DELTA, NOT AN ABSOLUTE. Demanding a globally clean tree is wrong here and
  // I got it wrong first: this spec lives INSIDE the repository it watches, so
  // its own uncommitted file makes the tree dirty and the precondition fails on
  // the spec's own existence. Worse, on a channel where a dozen cells share a
  // checkout, "must be clean" would report every colleague's in-flight work as a
  // failure of this test. The honest precondition is narrower and survives both:
  // MY markers must be absent before I create them.
  const before = gitStatus();
  assert.ok(
    !before.includes(MARKER),
    `a previous run left ${MARKER} behind, so this run cannot tell its own edit ` +
      `from the last one's:\n${before}`,
  );

  // A CONTROL FIRST, in the same delta shape. Without it, "the change list
  // contains my file" could pass on a stream that lists everything under the sun.
  const beforeTruth = await waitFor(() => latestWorkspaceTruth(), {
    ms: 90_000,
    what: "a vcs status snapshot to arrive before any edit is made (the control)",
  });
  const beforePaths: string[] = (beforeTruth.workingTree.files ?? []).map((f: any) => String(f.path));
  assert.ok(
    !beforePaths.some((p) => p.includes(MARKER)),
    `the control already lists this run's marker, which is impossible unless the ` +
      `marker is not unique: ${JSON.stringify(beforePaths)}`,
  );
  t.diagnostic(
    `control: ${beforePaths.length} pre-existing change(s) in the watched repo — ` +
      `not required to be zero, and this spec asserts only on its own two files`,
  );

  const frameCountBefore = app.wire.frames.length;

  // OUT OF BAND. A shell `sed -i` into a tracked file, and a heredoc creating an
  // untracked one. No edit tool, no RPC, nothing the backend could have learned
  // from a tool call it serviced.
  // BSD `sed -i` takes a mandatory (empty) backup suffix, and it refuses an
  // unescaped newline inside a substitute pattern — two spellings I paid for in
  // failed runs. So the edit appends a trailing comment to the FIRST line
  // instead of inserting a new one: no newline anywhere in the sed program, and
  // a trailing `//` comment is inert on any line of a .ts file.
  sh(
    `cd ${JSON.stringify(watchedCwd)} && ` +
      `sed -i '' '1s|$| // out-of-band ${MARKER}|' ${JSON.stringify(trackedFile)}`,
  );
  sh(`cd ${JSON.stringify(watchedCwd)} && cat > ${JSON.stringify(untrackedFile)} <<'EOF'\n${MARKER} heredoc\nEOF`);

  const onDisk = gitStatus();
  assert.ok(
    onDisk.includes(trackedFile.split("/").pop()!) || onDisk.includes(trackedFile),
    `the out-of-band edit to ${trackedFile} did not land on disk, so the spec never ` +
      `tested anything:\n${onDisk}`,
  );

  const truth = await waitFor(
    async () => {
      // FAIL FAST IF THE SERVER DIED. Otherwise this deadline expires and the
      // message says "the change list is not derived from the filesystem",
      // which would be a fabricated product finding. It already happened once
      // here, when the spec's own edit corrupted a file the app loads.
      if (!(await stack.backendAlive())) {
        throw new Error(
          `the backend stopped answering on ${stack.serverPort} DURING this test. ` +
            `Whatever this spec was waiting for, the reason it did not arrive is ` +
            `that the server is gone — do not read this as a change-list defect.`,
        );
      }
      const events = app.wire.frames
        .slice(frameCountBefore)
        .filter((f) => f.dir === "recv" && f.json?._tag === "Chunk")
        .flatMap((f) => (Array.isArray(f.json.values) ? f.json.values : []))
        .filter((v: any) => v?.local?.workingTree?.files?.length);
      return events.length ? events[events.length - 1].local : null;
    },
    {
      ms: 180_000,
      what:
        `the vcs status stream to report the out-of-band edit. If this times out the ` +
        `change list is NOT derived from the filesystem, and the fix is cairn::Repo's ` +
        `working-tree read — NOT a refresh button in the frontend.`,
    },
    500,
  );

  const paths: string[] = truth.workingTree.files.map((f: any) => String(f.path));
  assert.ok(
    paths.some((p) => p.endsWith(trackedFile.split("/").pop()!)),
    `the sed -i edit to the TRACKED file ${trackedFile} is missing from the change ` +
      `list: ${JSON.stringify(paths)}`,
  );
  assert.ok(
    paths.some((p) => p.includes(untrackedFile)),
    `the heredoc's UNTRACKED file is missing from the change list: ${JSON.stringify(paths)}. ` +
      `An untracked file is a real workspace change; omitting it renders a repo as ` +
      `cleaner than it is.`,
  );
  assert.equal(truth.hasWorkingTreeChanges, true);

  // Per-file line counts must be real, not the fabricated zeros #192 was about.
  const editedRow = truth.workingTree.files.find((f: any) =>
    String(f.path).endsWith(trackedFile.split("/").pop()!),
  );
  assert.ok(
    editedRow.insertions > 0,
    `the tracked file is listed with insertions=${editedRow?.insertions}. A change list ` +
      `with zero line counts is exactly the "plausible list with false counts" #192 ` +
      `filed against — assert the counts, not just the paths.`,
  );

  t.diagnostic(`workspace truth after the out-of-band edit: ${JSON.stringify(truth.workingTree)}`);
});

test("the out-of-band edit survives a BACKEND RESTART and is re-derived, not remembered", async (t) => {
  // The edit from the previous test is still on disk. A restart throws away
  // every in-memory watcher and cache the backend had, so what comes back can
  // only have been READ from the filesystem again. That is the difference
  // between workspace truth and a remembered list.
  await stack.restartBackend();
  // REPORT WHO BROUGHT IT BACK. "fixture" means dev-runner did not resupervise
  // the SIGKILLed backend, which is a real defect this durability test would
  // otherwise conceal by quietly repairing it.
  t.diagnostic(`backend restarted by: ${stack.restartedBy()}`);
  await app.reload();

  const truth = await waitFor(
    () => {
      const t = latestWorkspaceTruth();
      return t?.workingTree?.files?.length ? t : null;
    },
    {
      ms: 180_000,
      what:
        "the reconnected client to be told about the same on-disk change again. " +
        "If the list comes back EMPTY while the file is still modified on disk, the " +
        "change list was memory, not truth.",
    },
    500,
  );

  const paths: string[] = truth.workingTree.files.map((f: any) => String(f.path));
  assert.ok(
    paths.some((p) => p.endsWith(trackedFile.split("/").pop()!)) &&
      paths.some((p) => p.includes(untrackedFile)),
    `after a SIGKILL and reconnect the change list lost the on-disk edits: ` +
      `${JSON.stringify(paths)}\non disk:\n${gitStatus()}`,
  );
  t.diagnostic(`re-derived after restart: ${JSON.stringify(paths)}`);
});

test("the diff panel is reachable from the glass and the console stays clean", async (t) => {
  const errorsBefore = app.wire.consoleErrors.length;

  // diff.toggle is `mod+d`, gated `!terminalFocus` (backend/src/keybindings.rs:95).
  // Fire it as a REAL key event; a store poke would test the store.
  await app.page.keyboard.press(process.platform === "darwin" ? "Meta+d" : "Control+d");
  await new Promise((r) => setTimeout(r, 3_000));

  const text: string = await app.page.evaluate(() => document.body.innerText || "");
  t.diagnostic(`after diff.toggle the body is ${text.length} chars`);

  assert.deepEqual(
    app.wire.pageErrors,
    [],
    `diff.toggle threw in the page:\n${app.wire.pageErrors.join("\n")}`,
  );
  assert.equal(
    app.wire.consoleErrors.length,
    errorsBefore,
    `diff.toggle logged new console errors:\n${app.wire.consoleErrors.slice(errorsBefore).join("\n")}`,
  );

  // What the user can actually SEE is reported, and asserted only where the DOM
  // can honestly carry it. The authority for "the change exists" is the wire
  // assertion above; this records whether the panel surfaces it, and a miss here
  // is a rendering finding against apps/web, NOT evidence the change list is wrong.
  const visible = text.includes(untrackedFile) || text.includes(trackedFile.split("/").pop()!);
  t.diagnostic(
    visible
      ? "the changed files are visible in the rendered panel"
      : `NOT VISIBLE at the glass after diff.toggle, although the wire carries them. ` +
          `That is a frontend rendering gap, filed as such — the workspace truth is correct.`,
  );
});
