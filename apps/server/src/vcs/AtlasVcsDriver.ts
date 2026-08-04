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
 * ## The whole driver
 *
 * This used to implement `checkpoints` and detection only, and refuse `execute`,
 * `initRepository`, `listWorkspaceFiles`, `listRemotes` and `filterIgnoredPaths` with
 * `VcsUnsupportedOperationError`. Refusing was the honest answer while the node served five
 * routes — implementing them as empty successes would have rendered a source-control panel
 * that silently showed an empty repository, which reads as "no changes" rather than "not
 * supported here".
 *
 * The node serves all of them now, so the refusals are gone. A remote workspace is a workspace:
 * the file picker lists it, the source-control panel sees its remotes, and `execute` runs git
 * in it. What that unlocks beyond the Diff panel is branch work — `git checkout -b`, `commit`,
 * `push` — against a repository on a machine the console has never had a path to.
 *
 * ## What still does not cross the wire
 *
 * `execute` accepts a `VcsProcessInput` shaped for a local spawn, and two of its fields cannot
 * mean the same thing remotely:
 *
 * - `spawnCwd` is where the *local* process would be spawned. The node spawns in the workspace
 *   root it resolved, so this is dropped rather than forwarded.
 * - `env` is filtered to commit identity (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) before it is sent.
 *   Callers build it by spreading `process.env`, so forwarding it whole would ship this
 *   server's entire environment — tokens included — to another machine. The node refuses
 *   anything outside that allow-list anyway; filtering here means a caller gets a working
 *   commit attribution instead of a rejection.
 */

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsProcessExitError,
  VcsRepositoryDetectionError,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const KIND = "atlas" as const;

const DetectResponse = Schema.Struct({ root: Schema.String });
const ExistsResponse = Schema.Struct({ exists: Schema.Boolean });
const RestoredResponse = Schema.Struct({ restored: Schema.Boolean });
const DiffResponse = Schema.Struct({ unifiedDiff: Schema.String });
const ExecResponse = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
const FilesResponse = Schema.Struct({
  paths: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
const RemotesResponse = Schema.Struct({
  remotes: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      pushUrl: Schema.NullOr(Schema.String),
      isPrimary: Schema.Boolean,
    }),
  ),
});
const IgnoredResponse = Schema.Struct({ ignored: Schema.Array(Schema.String) });

const decodeDetect = Schema.decodeUnknownEffect(DetectResponse);
const decodeExists = Schema.decodeUnknownEffect(ExistsResponse);
const decodeRestored = Schema.decodeUnknownEffect(RestoredResponse);
const decodeDiff = Schema.decodeUnknownEffect(DiffResponse);
const decodeExec = Schema.decodeUnknownEffect(ExecResponse);
const decodeFiles = Schema.decodeUnknownEffect(FilesResponse);
const decodeRemotes = Schema.decodeUnknownEffect(RemotesResponse);
const decodeIgnored = Schema.decodeUnknownEffect(IgnoredResponse);

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, "");

/** Matches the node's own env allow-list — see the module note on why this is filtered here. */
const COMMIT_IDENTITY_ENV = /^GIT_(AUTHOR|COMMITTER)_/;

const commitIdentityEnv = (env: NodeJS.ProcessEnv | undefined): Record<string, string> => {
  if (env === undefined) return {};
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && COMMIT_IDENTITY_ENV.test(key)) filtered[key] = value;
  }
  return filtered;
};

/** The marker `VcsProcess` appends locally, kept identical so a caller cannot tell them apart. */
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

const withMarker = (text: string, truncated: boolean, append: boolean | undefined): string =>
  truncated && append === true ? `${text}${OUTPUT_TRUNCATED_MARKER}` : text;

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
    // True now that the node serves `remotes` and `exec`: pushing to the default remote is git
    // on the node, which is exactly what the co-located driver does. It was false while those
    // were refusals, and leaving it false would advertise a limit that no longer exists.
    supportsPushDefaultRemote: true,
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

  /** The node answered, so the reading is off another machine — never `live-local`. */
  const remoteFreshness = Effect.gen(function* () {
    const observedAt = yield* DateTime.now;
    return { source: "explicit-remote" as const, observedAt, expiresAt: Option.none() };
  });

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = Effect.fn("AtlasVcsDriver.execute")(
    function* (input) {
      const result = yield* call(
        "AtlasVcsDriver.execute",
        input.cwd,
        "/_vcs/exec",
        {
          command: "git",
          args: [...input.args],
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          env: commitIdentityEnv(input.env),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
        },
        decodeExec,
      );

      // A non-zero exit is data the node reports in a 200, so the decision about whether it is
      // an *error* belongs here, exactly where the local driver makes it. `check-ignore`
      // returning 1 and `git push` returning 1 are the same HTTP status and different events.
      if (result.exitCode !== 0 && input.allowNonZeroExit !== true) {
        return yield* new VcsProcessExitError({
          operation: input.operation,
          command: "git",
          cwd: input.cwd,
          argumentCount: input.args.length,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || `git exited ${result.exitCode}`,
          stderrLength: result.stderr.length,
          stderrTruncated: result.stderrTruncated,
        });
      }

      return {
        // The wire carries a plain number; `ExitCode` is the branded form the local spawner
        // hands back, and a caller must not be able to tell which driver produced it.
        exitCode: ChildProcessSpawner.ExitCode(result.exitCode),
        stdout: withMarker(result.stdout, result.stdoutTruncated, input.appendTruncationMarker),
        stderr: withMarker(result.stderr, result.stderrTruncated, input.appendTruncationMarker),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      };
    },
  );

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "AtlasVcsDriver.listWorkspaceFiles",
  )(function* (cwd: string) {
    const result = yield* call(
      "AtlasVcsDriver.listWorkspaceFiles",
      cwd,
      "/_vcs/files",
      {},
      decodeFiles,
    );
    // `truncated` is carried through rather than dropped: a picker showing a prefix without
    // saying so reads as a complete repository.
    return {
      paths: result.paths,
      truncated: result.truncated,
      freshness: yield* remoteFreshness,
    };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "AtlasVcsDriver.listRemotes",
  )(function* (cwd: string) {
    const result = yield* call(
      "AtlasVcsDriver.listRemotes",
      cwd,
      "/_vcs/remotes",
      {},
      decodeRemotes,
    );
    return {
      remotes: result.remotes.map((remote) => ({
        name: remote.name,
        url: remote.url,
        pushUrl: remote.pushUrl === null ? Option.none() : Option.some(remote.pushUrl),
        isPrimary: remote.isPrimary,
      })),
      freshness: yield* remoteFreshness,
    };
  });

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "AtlasVcsDriver.filterIgnoredPaths",
  )(function* (cwd: string, relativePaths: ReadonlyArray<string>) {
    if (relativePaths.length === 0) return relativePaths;
    // The node answers with the *ignored* subset — the primitive — and the complement is this
    // function's own contract. One round trip either way; the node keeps the reusable half.
    const result = yield* call(
      "AtlasVcsDriver.filterIgnoredPaths",
      cwd,
      "/_vcs/ignored",
      { paths: [...relativePaths] },
      decodeIgnored,
    );
    if (result.ignored.length === 0) return relativePaths;
    const ignored = new Set(result.ignored);
    return relativePaths.filter((relativePath) => !ignored.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = Effect.fn(
    "AtlasVcsDriver.initRepository",
  )(function* (input) {
    yield* call("AtlasVcsDriver.initRepository", input.cwd, "/_vcs/init", {}, Effect.succeed);
  });

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree: (cwd: string) =>
      detectRepository(cwd).pipe(Effect.map((repository) => repository !== null)),
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  } satisfies VcsDriver.VcsDriver["Service"];
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});
