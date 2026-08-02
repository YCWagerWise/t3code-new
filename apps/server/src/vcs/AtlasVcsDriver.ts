/**
 * AtlasVcsDriver — a git worktree that lives on another machine.
 *
 * The Diff panel is entirely `cwd` + `checkpointRef` based: `CheckpointDiffQuery` resolves a
 * thread's workspace path and asks a driver to capture, restore and diff refs inside it. For a
 * co-located repository the git driver runs those as local processes. For an Atlas node on
 * another box that path does not exist here, so every checkpoint operation fails and the panel
 * is dark — not because the diff cannot be computed, but because nobody can reach the machine
 * holding the files.
 *
 * This driver is that reach. It implements the same interface and forwards the five checkpoint
 * operations to `/_vcs/*` on the node, which executes them with `atlas_workspace::Repo`. The
 * panel, ingestion, and the projection are untouched: `VcsDriverRegistry` already selects a
 * driver by kind, so this is a registration rather than a new data path.
 *
 * ## What it deliberately does not do
 *
 * Only `checkpoints` and repository detection are implemented. `execute` (raw process),
 * `initRepository`, `listWorkspaceFiles`, `listRemotes` and `filterIgnoredPaths` all refuse
 * with `VcsUnsupportedOperationError`. Those surfaces mean "run a command in the user's
 * working copy" and are used by panels — source control, file pickers — that have no remote
 * story yet. Refusing is the honest answer: implementing them as empty successes would render
 * a source-control panel that silently shows an empty repository, which reads as "no changes"
 * rather than "not supported here".
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const KIND = "atlas" as const;

const DetectResponse = Schema.Struct({ root: Schema.String });
const ExistsResponse = Schema.Struct({ exists: Schema.Boolean });
const RestoredResponse = Schema.Struct({ restored: Schema.Boolean });
const DiffResponse = Schema.Struct({ unifiedDiff: Schema.String });

const decodeDetect = Schema.decodeUnknownEffect(DetectResponse);
const decodeExists = Schema.decodeUnknownEffect(ExistsResponse);
const decodeRestored = Schema.decodeUnknownEffect(RestoredResponse);
const decodeDiff = Schema.decodeUnknownEffect(DiffResponse);

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, "");

const unsupported = (operation: string, detail: string) =>
  Effect.fail(new VcsUnsupportedOperationError({ operation, kind: KIND, detail }));

export const makeVcsDriverShape = Effect.fn("makeAtlasVcsDriverShape")(function* () {
  const client = yield* HttpClient.HttpClient;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;

  const capabilities = {
    kind: KIND,
    supportsWorktrees: true,
    supportsBookmarks: false,
    // The node captures through a throwaway index rather than locking the worktree, so a
    // snapshot is not atomic with respect to a concurrently running turn.
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: false,
    ignoreClassifier: "native" as const,
  };

  /**
   * POST `body` to `path` on the node owning `cwd`, and decode the reply.
   *
   * Every failure — no configured node, transport, non-2xx, undecodable body — surfaces as
   * `VcsRepositoryDetectionError`, because from the panel's point of view they are the same
   * fact: this workspace could not be reached. The `detail` carries which one it was.
   */
  const call = Effect.fn("AtlasVcsDriver.call")(function* <A>(
    operation: string,
    cwd: string,
    path: string,
    body: Record<string, unknown>,
    decode: (u: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) {
    const config = yield* projectConfig.resolveAtlas(cwd);
    if (Option.isNone(config)) {
      return yield* new VcsRepositoryDetectionError({
        operation,
        cwd,
        detail: "no Atlas node is configured for this workspace (.t3code/vcs.json → vcs.atlas)",
      });
    }
    const { baseUrl, token } = config.value;

    const request = HttpClientRequest.post(`${normalizeBaseUrl(baseUrl)}${path}`, {
      body: HttpBody.jsonUnsafe({ cwd, ...body }),
      ...(token === undefined || token === ""
        ? {}
        : { headers: { authorization: `Bearer ${token}` } }),
    });

    const response = yield* client.execute(request).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `Atlas node '${baseUrl}' is unreachable`,
            cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new VcsRepositoryDetectionError({
        operation,
        cwd,
        detail: `Atlas node '${baseUrl}' answered ${response.status}`,
      });
    }
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `Atlas node '${baseUrl}' returned a body that is not JSON`,
            cause,
          }),
      ),
    );
    return yield* decode(json).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation,
            cwd,
            detail: `Atlas node '${baseUrl}' returned an unexpected shape`,
            cause,
          }),
      ),
    );
  });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "AtlasVcsDriver.detectRepository",
  )(function* (cwd: string) {
    // A workspace with no `vcs.atlas` block is simply not ours — `null` lets the registry keep
    // looking rather than failing the whole resolution.
    const config = yield* projectConfig.resolveAtlas(cwd);
    if (Option.isNone(config)) {
      return null;
    }
    const detected = yield* call(
      "AtlasVcsDriver.detectRepository",
      cwd,
      "/_vcs/detect",
      {},
      decodeDetect,
    );
    const observedAt = yield* DateTime.now;
    return {
      kind: KIND,
      rootPath: detected.root.trim(),
      // The node's `.git` is on the node. Naming a local path here would invite a caller to
      // stat something that is not there.
      metadataPath: null,
      // Not `live-local`: the answer came off another machine, and the freshness field is how
      // a consumer learns not to treat it as a local filesystem read.
      freshness: { source: "explicit-remote", observedAt, expiresAt: Option.none() },
    } satisfies VcsRepositoryIdentity;
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("AtlasVcsDriver.captureCheckpoint")(function* (input) {
      yield* call(
        "AtlasVcsDriver.captureCheckpoint",
        input.cwd,
        "/_vcs/capture",
        { checkpointRef: input.checkpointRef },
        Effect.succeed,
      );
    }),

    hasCheckpointRef: Effect.fn("AtlasVcsDriver.hasCheckpointRef")(function* (input) {
      const result = yield* call(
        "AtlasVcsDriver.hasCheckpointRef",
        input.cwd,
        "/_vcs/has",
        { checkpointRef: input.checkpointRef },
        decodeExists,
      );
      return result.exists;
    }),

    restoreCheckpoint: Effect.fn("AtlasVcsDriver.restoreCheckpoint")(function* (input) {
      const result = yield* call(
        "AtlasVcsDriver.restoreCheckpoint",
        input.cwd,
        "/_vcs/restore",
        {
          checkpointRef: input.checkpointRef,
          fallbackToHead: input.fallbackToHead ?? false,
        },
        decodeRestored,
      );
      // `false` means the ref did not exist — a fact the caller acts on, not an error. A driver
      // that raised here would report a broken repository every time someone asked for a turn
      // that predates checkpointing.
      return result.restored;
    }),

    diffCheckpoints: Effect.fn("AtlasVcsDriver.diffCheckpoints")(function* (input) {
      const result = yield* call(
        "AtlasVcsDriver.diffCheckpoints",
        input.cwd,
        "/_vcs/diff",
        {
          fromCheckpointRef: input.fromCheckpointRef,
          toCheckpointRef: input.toCheckpointRef,
          ignoreWhitespace: input.ignoreWhitespace,
        },
        decodeDiff,
      );
      return result.unifiedDiff;
    }),

    deleteCheckpointRefs: Effect.fn("AtlasVcsDriver.deleteCheckpointRefs")(function* (input) {
      yield* call(
        "AtlasVcsDriver.deleteCheckpointRefs",
        input.cwd,
        "/_vcs/delete",
        { checkpointRefs: input.checkpointRefs },
        Effect.succeed,
      );
    }),
  };

  return {
    capabilities,
    execute: () =>
      unsupported(
        "AtlasVcsDriver.execute",
        "raw VCS processes do not run against a remote Atlas workspace",
      ),
    checkpoints,
    detectRepository,
    isInsideWorkTree: (cwd: string) =>
      detectRepository(cwd).pipe(Effect.map((repository) => repository !== null)),
    listWorkspaceFiles: () =>
      unsupported(
        "AtlasVcsDriver.listWorkspaceFiles",
        "listing a remote Atlas workspace is not implemented",
      ),
    listRemotes: () =>
      unsupported("AtlasVcsDriver.listRemotes", "remotes are not exposed by an Atlas node"),
    filterIgnoredPaths: () =>
      unsupported(
        "AtlasVcsDriver.filterIgnoredPaths",
        "ignore classification for a remote Atlas workspace is not implemented",
      ),
    initRepository: () =>
      unsupported(
        "AtlasVcsDriver.initRepository",
        "an Atlas workspace is created on the node, not from the console",
      ),
  } satisfies VcsDriver.VcsDriver["Service"];
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});
