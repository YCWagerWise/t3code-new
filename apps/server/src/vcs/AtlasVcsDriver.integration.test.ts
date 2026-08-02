/**
 * The seam test: the real driver against a real Atlas node.
 *
 * Every other test on either side of this boundary uses a mock, which means both halves can be
 * green while disagreeing about field names, JSON shape, or the auth header — the failure mode
 * that mocks are structurally unable to catch. This is the only test that would notice.
 *
 * Skipped unless `ATLAS_VCS_TEST_URL` is set, so CI without a node stays green:
 *
 *   ATLAS_VCS_TEST_URL=http://127.0.0.1:3099 \
 *   ATLAS_VCS_TEST_CWD=/path/to/testbed \
 *   npx vitest run src/vcs/AtlasVcsDriver.integration.test.ts
 *
 * The workspace at `ATLAS_VCS_TEST_CWD` must be a git repo inside the node's `ATLAS_VCS_ROOTS`
 * and carry a `.t3code/vcs.json` naming the node — the driver resolves its node from that file
 * and from nothing else.
 */

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import * as AtlasVcsDriver from "./AtlasVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const NODE_URL = process.env.ATLAS_VCS_TEST_URL;
const CWD = process.env.ATLAS_VCS_TEST_CWD;
const REF = "refs/t3/checkpoints/seam-test/0";

// `VcsProjectConfig` reads `.t3code/vcs.json`, so it needs FileSystem PROVIDED to it, not
// merged beside it — merging leaves its requirement unsatisfied at construction.
const layer = Layer.mergeAll(
  FetchHttpClient.layer,
  VcsProjectConfig.layer.pipe(Layer.provide(NodeServices.layer)),
);

const driver = <A, E, R>(use: (d: VcsDriver.VcsDriver["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const d = yield* AtlasVcsDriver.makeVcsDriverShape();
    return yield* use(d);
  }).pipe(Effect.provide(layer));

describe.skipIf(NODE_URL === undefined || CWD === undefined)("AtlasVcsDriver ↔ a real node", () => {
  it.effect("detects the remote repository and reports it as explicitly remote", () =>
    driver((d) =>
      Effect.gen(function* () {
        const repo = yield* d.detectRepository(CWD!);
        assert.isNotNull(repo);
        assert.strictEqual(repo!.kind, "atlas");
        // The node canonicalises, so this proves the answer came from the node rather than
        // being echoed back from the request.
        assert.isTrue(repo!.rootPath.length > 0);
        assert.strictEqual(repo!.freshness.source, "explicit-remote");
        // The node's `.git` is on the node; naming a local path would invite a caller to stat
        // something that is not there.
        assert.isNull(repo!.metadataPath);
      }),
    ),
  );

  it.effect("captures, sees a shell-written file, and restores it away", () =>
    driver((d) =>
      Effect.gen(function* () {
        const ops = d.checkpoints!;
        yield* ops.captureCheckpoint({ cwd: CWD!, checkpointRef: REF });
        assert.isTrue(yield* ops.hasCheckpointRef({ cwd: CWD!, checkpointRef: REF }));

        // Written the way an agent writes on Atlas: a shell redirect, no file tool. If the
        // whole design is wrong, this is the assertion that says so.
        const { execSync } = yield* Effect.promise(() => import("node:child_process"));
        execSync("printf 'seam test\\n' > seam-proof.txt", { cwd: CWD! });

        const diff = yield* ops.diffCheckpoints({
          cwd: CWD!,
          fromCheckpointRef: REF,
          toCheckpointRef: "",
          ignoreWhitespace: false,
        });
        assert.include(diff, "seam-proof.txt");
        assert.include(diff, "+seam test");

        assert.isTrue(yield* ops.restoreCheckpoint({ cwd: CWD!, checkpointRef: REF }));
        const after = yield* ops.diffCheckpoints({
          cwd: CWD!,
          fromCheckpointRef: REF,
          toCheckpointRef: "",
          ignoreWhitespace: false,
        });
        assert.strictEqual(after, "", "restore should leave nothing to diff");

        yield* ops.deleteCheckpointRefs({ cwd: CWD!, checkpointRefs: [REF] });
        assert.isFalse(yield* ops.hasCheckpointRef({ cwd: CWD!, checkpointRef: REF }));
      }),
    ),
  );

  it.effect("reports a missing ref as a fact rather than an error", () =>
    driver((d) =>
      Effect.gen(function* () {
        // `false`, not a raised error — otherwise asking for a turn that predates
        // checkpointing reports a broken repository.
        const restored = yield* d.checkpoints!.restoreCheckpoint({
          cwd: CWD!,
          checkpointRef: "refs/t3/checkpoints/does-not-exist/9",
        });
        assert.isFalse(restored);
      }),
    ),
  );

  it.effect("treats a workspace with no configured node as not ours", () =>
    driver((d) =>
      Effect.gen(function* () {
        // `null`, not a failure: the registry must be free to keep looking.
        const repo = yield* d.detectRepository("/tmp");
        assert.isNull(repo);
      }),
    ),
  );
});
