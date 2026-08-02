import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsDriverKind, type VcsDriverKind as VcsDriverKindType } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

/**
 * Where an `atlas` workspace lives. Carried in the SAME file that already selects the driver
 * kind, because the registry hands a driver nothing but a `cwd` — so the only thing that can
 * tell a driver which node owns a path is something sitting at that path.
 */
const AtlasWorkspaceConfig = Schema.Struct({
  baseUrl: Schema.String,
  token: Schema.optional(Schema.String),
});

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
      atlas: Schema.optional(AtlasWorkspaceConfig),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
});

export type AtlasWorkspaceConfig = typeof AtlasWorkspaceConfig.Type;
const ProjectVcsConfigJson = fromLenientJson(ProjectVcsConfig);
const decodeProjectVcsConfigJson = Schema.decodeUnknownEffect(ProjectVcsConfigJson);

type ProjectVcsConfigFile = typeof ProjectVcsConfig.Type;

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export class VcsProjectConfigError extends Schema.TaggedErrorClass<VcsProjectConfigError>()(
  "VcsProjectConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode"]),
    cwd: Schema.String,
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} VCS project config at ${this.configPath}.`;
  }
}

export class VcsProjectConfig extends Context.Service<
  VcsProjectConfig,
  {
    readonly resolveKind: (
      input: VcsProjectConfigResolveInput,
    ) => Effect.Effect<VcsDriverKindType | "auto">;
    readonly resolveAtlas: (cwd: string) => Effect.Effect<Option.Option<AtlasWorkspaceConfig>>;
  }
>()("t3/vcs/VcsProjectConfig") {}

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

const logVcsProjectConfigError = (error: VcsProjectConfigError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      cwd: error.cwd,
      configPath: error.configPath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "vcs.json");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "inspect",
              cwd,
              configPath: candidate,
              cause,
            }),
        ),
        Effect.catchTags({
          VcsProjectConfigError: (error) => logVcsProjectConfigError(error).pipe(Effect.as(false)),
        }),
      );
      if (exists) {
        return Option.some(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readConfig = Effect.fn("VcsProjectConfig.readConfig")(function* (
    cwd: string,
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "read",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeProjectVcsConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "decode",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    return parsed;
  });

  const resolveKind: VcsProjectConfig["Service"]["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    return yield* findConfigPath(input.cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed("auto" as const),
          onSome: (configPath) =>
            readConfig(input.cwd, configPath).pipe(Effect.map(configuredKind)),
        }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) =>
          logVcsProjectConfigError(error).pipe(Effect.as("auto" as const)),
      }),
    );
  });

  /**
   * The Atlas node owning `cwd`, if the project declares one.
   *
   * `None` on a missing, unreadable or malformed config — the same degradation `resolveKind`
   * uses. A driver that cannot find its node reports an unreachable workspace, which is a
   * better failure than a server that will not start because a config file has a typo.
   */
  const resolveAtlas: VcsProjectConfig["Service"]["resolveAtlas"] = Effect.fn(
    "VcsProjectConfig.resolveAtlas",
  )(function* (cwd: string) {
    return yield* findConfigPath(cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (configPath) =>
            readConfig(cwd, configPath).pipe(
              Effect.map((config) => Option.fromNullishOr(config.vcs?.atlas)),
            ),
        }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) =>
          logVcsProjectConfigError(error).pipe(Effect.as(Option.none<AtlasWorkspaceConfig>())),
      }),
    );
  });

  return VcsProjectConfig.of({
    resolveKind,
    resolveAtlas,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make);
