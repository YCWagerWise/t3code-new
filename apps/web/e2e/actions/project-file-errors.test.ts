/**
 * A DECLARED project-file error must reach the client as `Fail` with its tag
 * intact — never as a `Die` defect.
 *
 * This is a regression guard for a defect the app hit on EVERY boot. The client
 * probes for an OPTIONAL `t3.json`; when it is absent the backend used to answer
 *
 *   Exit / Failure / Die  "read t3.json: No such file or directory (os error 2)"
 *
 * `Die` is the protocol's word for an unrecoverable defect the client has no
 * branch for, and `server_main.rs:1865-1868` reserves it deliberately so an
 * unimplemented method cannot masquerade as `Success(null)`. Sending "that file
 * is not there" down it means the declared `ProjectReadFileError`
 * (rpc.ts:667-671, project.ts:269-283) — with its whole `failure`/`operation`
 * vocabulary — was unreachable dead code, and no client could distinguish
 * "absent" from "the backend broke".
 *
 * WHY THIS IS A WIRE TEST AND NOT A UNIT TEST. Nothing is visible at the glass:
 * the console is clean and the app renders. The only place the difference exists
 * is the frame. A DOM assertion here would pass in both directions, which is the
 * #435 failure — a test that cannot fail reporting a pass.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, openApp, type StackHandle, type App } from "../fixtures/index.ts";

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
}, { timeout: 1_800_000 });

after(async () => {
  await app?.close();
  await stack?.dispose();
}, { timeout: 120_000 });

test("a missing optional file is a declared error, not a Die defect", () => {
  const ids = app.wire.requestIds("projects.readFile");
  assert.ok(
    ids.length > 0,
    "the app did not probe for a project file on this boot, so this guard proved " +
      "nothing. Do not treat that as a pass — find out why the probe stopped, " +
      `because the guard is now vacuous.\n${app.wire.transcript(30)}`,
  );

  for (const id of ids) {
    const outcome = app.wire.outcomeOf(id);
    if (outcome === null || outcome.kind === "success") continue;

    assert.notEqual(
      outcome.kind,
      "die",
      `projects.readFile answered with a Die defect: ` +
        `${outcome.kind === "die" ? outcome.defect : ""}\n` +
        `A file that is simply absent is a DECLARED condition. It must travel as ` +
        `Fail carrying ProjectReadFileError, so the client can branch on it.`,
    );

    const error = outcome.kind === "fail" ? (outcome.error as any) : null;
    assert.equal(
      error?._tag,
      "ProjectReadFileError",
      `the failure is not the tagged error the RPC declares: ${JSON.stringify(error)}`,
    );
    // The closed literal sets from the contract. An undeclared value here fails
    // the client's decoder, which would turn a handled error back into a crash
    // by a different route — so asserting the tag alone is not enough.
    assert.ok(
      ["workspace_path_outside_root", "resolved_path_outside_root", "path_not_file",
       "binary_file", "operation_failed"].includes(error.failure),
      `\`failure\` is not one of ProjectFileFailure's literals: ${error.failure}`,
    );
    assert.ok(
      ["realpath-workspace-root", "realpath-target", "open", "stat", "read", "close",
       "make-directory", "write-file"].includes(error.operation),
      `\`operation\` is not one of ProjectFileOperation's literals: ${error.operation}`,
    );
    assert.ok(
      typeof error.message === "string" && error.message.trim().length > 0,
      "`message` is TrimmedNonEmptyString in the contract and must carry the detail",
    );
    // `relativePath` is TrimmedNonEmptyString too, so it must be OMITTED rather
    // than sent empty — an empty string fails the decoder.
    if ("relativePath" in error) {
      assert.ok(
        typeof error.relativePath === "string" && error.relativePath.trim().length > 0,
        "`relativePath` was sent empty; it must be omitted when there is none",
      );
    }
  }
});
