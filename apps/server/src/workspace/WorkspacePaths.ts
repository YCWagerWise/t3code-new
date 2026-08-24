/**
 * WorkspacePaths - Effect service contract for workspace path handling.
 *
 * Owns normalization and validation of workspace roots plus safe resolution of
 * workspace-root-relative paths.
 *
 * @module WorkspacePaths
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootStatFailedError extends Schema.TaggedErrorClass<WorkspaceRootStatFailedError>()(
  "WorkspaceRootStatFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
    phase: Schema.Literals(["validate-existing", "verify-created"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat workspace root '${this.normalizedWorkspaceRoot}' during '${this.phase}'.`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathNotAdmittedError extends Schema.TaggedErrorClass<WorkspacePathNotAdmittedError>()(
  "WorkspacePathNotAdmittedError",
  {
    candidate: Schema.String,
    canonicalCandidate: Schema.String,
    roots: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Path is outside every admitted root: ${this.canonicalCandidate}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootStatFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspacePathOutsideRootError,
  WorkspacePathNotAdmittedError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

/** Service tag for workspace path normalization and resolution. */
export class WorkspacePaths extends Context.Service<
  WorkspacePaths,
  {
    /** Normalize a user-provided workspace root and verify it exists as a directory. */
    readonly normalizeWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly createIfMissing?: boolean },
    ) => Effect.Effect<
      string,
      | WorkspaceRootNotExistsError
      | WorkspaceRootCreateFailedError
      | WorkspaceRootStatFailedError
      | WorkspaceRootNotDirectoryError
    >;
    /**
     * Resolve a relative path within a validated workspace root.
     *
     * Rejects absolute paths and traversal attempts outside the workspace root.
     */
    readonly resolveRelativePathWithinRoot: (input: {
      workspaceRoot: string;
      relativePath: string;
    }) => Effect.Effect<
      { absolutePath: string; relativePath: string },
      WorkspacePathOutsideRootError
    >;
    /**
     * Admit an ABSOLUTE, client-supplied path against the roots this environment
     * owns, returning its canonical form.
     *
     * `resolveRelativePathWithinRoot` cannot serve this: it rejects absolute
     * paths by design. But the paths that arrive on a terminal open, a
     * `vcs.init`, or a worktree removal ARE absolute, and admitting them by
     * `stat` alone only proves the directory exists — never that it is ours.
     *
     * Both sides are resolved through `realPath`, so a symlink pointing out of
     * an admitted root is refused rather than followed. A root that does not
     * resolve is skipped, not treated as a match: an environment whose worktree
     * directory is missing admits nothing, instead of admitting everything.
     */
    readonly admitPathWithinRoots: (input: {
      candidate: string;
      roots: ReadonlyArray<string>;
    }) => Effect.Effect<string, WorkspacePathNotAdmittedError>;
  }
>()("t3/workspace/WorkspacePaths") {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const statWorkspaceRoot = Effect.fn("WorkspacePaths.statWorkspaceRoot")(function* (
    workspaceRoot: string,
    normalizedWorkspaceRoot: string,
    phase: WorkspaceRootStatFailedError["phase"],
  ) {
    return yield* fileSystem.stat(normalizedWorkspaceRoot).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(
                new WorkspaceRootStatFailedError({
                  workspaceRoot,
                  normalizedWorkspaceRoot,
                  phase,
                  cause,
                }),
              ),
        onSuccess: Effect.succeed,
      }),
    );
  });

  const normalizeWorkspaceRoot: WorkspacePaths["Service"]["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* statWorkspaceRoot(
      workspaceRoot,
      normalizedWorkspaceRoot,
      "validate-existing",
    );
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
              cause,
            }),
        ),
      );
      workspaceStat = yield* statWorkspaceRoot(
        workspaceRoot,
        normalizedWorkspaceRoot,
        "verify-created",
      );
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePaths["Service"]["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toPosixRelativePath(path.relative(input.workspaceRoot, absolutePath));
      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot.startsWith("../") ||
        relativeToRoot === ".." ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  /** Canonical form, or `null` when the path cannot be resolved on this host. */
  const canonical = (candidate: string): Effect.Effect<string | null> =>
    fileSystem.realPath(candidate).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(null),
        onSuccess: (resolved: string) => Effect.succeed(resolved as string | null),
      }),
    );

  const admitPathWithinRoots: WorkspacePaths["Service"]["admitPathWithinRoots"] = Effect.fn(
    "WorkspacePaths.admitPathWithinRoots",
  )(function* (input) {
    const requested = path.resolve(expandHomePath(input.candidate.trim(), path));
    // An unresolvable candidate is reported by its lexical form; it cannot be
    // admitted, and saying so with the path the caller sent is more useful than
    // an empty string.
    const canonicalCandidate = (yield* canonical(requested)) ?? requested;

    for (const root of input.roots) {
      const resolvedRoot = yield* canonical(path.resolve(expandHomePath(root.trim(), path)));
      if (resolvedRoot === null) {
        continue;
      }
      const rel = toPosixRelativePath(path.relative(resolvedRoot, canonicalCandidate));
      // "" means the candidate IS the root, which is admitted. Anything starting
      // with ".." escapes it, and an absolute result means a different volume.
      if (rel === "" || (!rel.startsWith("../") && rel !== ".." && !path.isAbsolute(rel))) {
        return canonicalCandidate;
      }
    }
    return yield* new WorkspacePathNotAdmittedError({
      candidate: input.candidate,
      canonicalCandidate,
      roots: input.roots,
    });
  });

  return WorkspacePaths.of({
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
    admitPathWithinRoots,
  });
});

export const layer = Layer.effect(WorkspacePaths, make);
