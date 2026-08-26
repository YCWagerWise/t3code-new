import {
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { detailFromCause, makeCliPresenceCache } from "./SourceControlProviderDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable?: string;
  readonly versionArgs?: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
};

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable?: string;
  readonly implemented: boolean;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  {
    kind: "jj",
    label: "Jujutsu",
    executable: "jj",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  },
];

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  {
    readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
  }
>()("t3/sourceControl/SourceControlDiscovery") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const process = yield* VcsProcess.VcsProcess;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  // Shared across every `discover` call for the lifetime of this process: see
  // SourceControlProviderDiscovery.makeCliPresenceCache for why "missing" gets a much longer TTL
  // than "available". Without this, opening the command palette re-spawned `git --version` and
  // `jj --version` on every open, forever.
  const cliPresenceCache = yield* makeCliPresenceCache(
    VCS_PROBES.map(({ executable, versionArgs }) => ({ executable, versionArgs })),
    { process, cwd: config.cwd },
  );

  const probe = <Kind extends VcsDriverKind>(
    input: DiscoveryProbe & { readonly kind: Kind },
  ): Effect.Effect<DiscoveryProbeResult<Kind>> => {
    const executable = input.executable;
    const versionArgs = input.versionArgs;

    if (!executable || !versionArgs) {
      return Effect.succeed({
        kind: input.kind,
        label: input.label,
        implemented: input.implemented,
        status: "missing" as const,
        version: Option.none<string>(),
        installHint: input.installHint,
        detail: Option.some(input.installHint),
      } satisfies DiscoveryProbeResult<Kind>);
    }

    return Cache.get(cliPresenceCache, executable).pipe(
      Effect.map(
        (presence): DiscoveryProbeResult<Kind> =>
          presence.status === "available"
            ? {
                kind: input.kind,
                label: input.label,
                executable,
                implemented: input.implemented,
                status: "available",
                version: presence.version,
                installHint: input.installHint,
                detail: Option.none<string>(),
              }
            : {
                kind: input.kind,
                label: input.label,
                executable,
                implemented: input.implemented,
                status: "missing",
                version: Option.none<string>(),
                installHint: input.installHint,
                detail: Option.some("Command not found on the server PATH."),
              },
      ),
      // Reached only for a genuine operational error (timeout, EACCES, ...): the cache never
      // holds one, so this is always this call's own failed attempt, whose Failure trace already
      // stands. This only decides what the discovery panel shows for it.
      Effect.catch(
        (cause): Effect.Effect<DiscoveryProbeResult<Kind>> =>
          Effect.succeed({
            kind: input.kind,
            label: input.label,
            executable,
            implemented: input.implemented,
            status: "missing" as const,
            version: Option.none<string>(),
            installHint: input.installHint,
            detail: detailFromCause(cause),
          }),
      ),
    );
  };

  return SourceControlDiscovery.of({
    discover: Effect.all({
      versionControlSystems: Effect.all(
        VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
        { concurrency: "unbounded" },
      ),
      sourceControlProviders: sourceControlProviders.discover,
    }),
  });
});

export const layer = Layer.effect(SourceControlDiscovery, make);
