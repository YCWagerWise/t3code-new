import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import type { SourceControlProviderKind, VcsError } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  makeCliPresenceCache,
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type CliPresenceResult,
  type SourceControlCliDiscoverySpec,
  type SourceControlProviderDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

/**
 * Identifies a caller-supplied context for the refinement cache below. `refineUnknownRemoteProvider`
 * only shells out when `context.provider.kind === "unknown"`, and its answer depends solely on
 * `cwd` (where the CLI runs) and the remote it is asked to classify — not on anything else in the
 * request — so those fields are exactly what the key needs to stay correct while still
 * deduplicating repeat callers.
 */
function refinementCacheKey(input: {
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
}): string {
  const { provider, remoteName, remoteUrl } = input.context;
  return [input.cwd, provider.kind, provider.name, provider.baseUrl, remoteName, remoteUrl].join(
    "\0",
  );
}

function parseRefinementCacheKey(key: string): {
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
} {
  const [cwd = "", kind = "unknown", name = "", baseUrl = "", remoteName = "", remoteUrl = ""] =
    key.split("\0");
  return {
    cwd,
    context: {
      provider: { kind: kind as SourceControlProviderKind, name, baseUrl },
      remoteName,
      remoteUrl,
    },
  };
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  }
>()("t3/sourceControl/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider["Service"] {
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "listChangeRequests",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getDefaultBranch",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "checkoutChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  });
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = [];
  for (const remote of remotes) {
    const provider = detectSourceControlProviderFromRemoteUrl(remote.url);
    if (provider) {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    }
  }

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider["Service"] {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
  });
}

export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const process = yield* VcsProcess.VcsProcess;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);
    // Shared by every `discover` call so that once this process has learned `az`/`glab`/whichever
    // CLI is missing, it stops re-spawning that CLI on every command-palette open, settings visit,
    // or publish-dialog mount. See makeCliPresenceCache's own comment for the TTL rationale.
    const cliPresenceCache: Cache.Cache<string, CliPresenceResult, VcsError> =
      yield* makeCliPresenceCache(
        discoverySpecs.filter((spec): spec is SourceControlCliDiscoverySpec => spec.type === "cli"),
        { process, cwd: config.cwd },
      );

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const context = selectProviderContext(remotes.remotes);

        return yield* refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd,
          context,
        });
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    // Mirrors providerContextCache above, but for callers (PullRequestService's per-repository
    // unknown-remote refinement, in particular) that already know which remote they mean and pass
    // it as `context`. Before this cache existed, that branch called refineUnknownRemoteProvider
    // raw on every call, so every `pullRequestsList`/`listStats`/`detail` RPC re-shelled out to
    // `glab auth status` for every project on an unrecognized host — uncached, unlike the
    // auto-detect branch a few lines up. Same capacity and TTL as providerContextCache: the two
    // caches answer the same question (which host owns this remote?) for the same class of
    // "unknown" remotes, just keyed on what each caller already has in hand.
    const providerRefinementCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(
      (key) => {
        const { cwd, context } = parseRefinementCacheKey(key);
        return refineUnknownRemoteProvider({ specs: discoverySpecs, process, cwd, context });
      },
      {
        capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
      },
    );

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = (input) =>
      (input.context === undefined
        ? Cache.get(providerContextCache, input.cwd)
        : Cache.get(
            providerRefinementCache,
            refinementCacheKey({ cwd: input.cwd, context: input.context }),
          )
      ).pipe(
        Effect.map((context) => {
          const kind = context?.provider.kind ?? "unknown";
          const provider = providers.get(kind) ?? unsupportedProvider(kind);
          return {
            provider: bindProviderContext(provider, context),
            context,
          } satisfies SourceControlProviderHandle;
        }),
      );

    return SourceControlProviderRegistry.of({
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
            presenceCache: cliPresenceCache,
          }),
        ),
        { concurrency: "unbounded" },
      ),
    });
  },
);

export const make = Effect.gen(function* () {
  const github = yield* GitHubSourceControlProvider.make;
  const gitlab = yield* GitLabSourceControlProvider.make;
  const bitbucket = yield* BitbucketSourceControlProvider.make;
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery;
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make;
  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
      discovery: GitHubSourceControlProvider.discovery,
    },
    {
      kind: "gitlab",
      provider: gitlab,
      discovery: GitLabSourceControlProvider.discovery,
    },
    {
      kind: "azure-devops",
      provider: azureDevOps,
      discovery: AzureDevOpsSourceControlProvider.discovery,
    },
    {
      kind: "bitbucket",
      provider: bitbucket,
      discovery: bitbucketDiscovery,
    },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
