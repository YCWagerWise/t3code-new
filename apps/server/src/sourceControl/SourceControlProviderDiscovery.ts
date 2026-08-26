import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  VcsError,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: VcsProcess.VcsProcessOutput["exitCode"];
}

export interface SourceControlUnknownRemoteRefinementInput {
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
  readonly auth: SourceControlAuthProbeInput;
}

interface SourceControlDiscoverySpecBase {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly installHint: string;
}

export type SourceControlCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "cli";
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly authArgs: ReadonlyArray<string>;
  readonly probeTimeoutMs?: number;
  readonly parseAuth: (input: SourceControlAuthProbeInput) => SourceControlProviderAuth;
  readonly refineUnknownRemote?: (
    input: SourceControlUnknownRemoteRefinementInput,
  ) => SourceControlProviderInfo | null;
};

export type SourceControlApiDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "api";
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
};

export type SourceControlProviderDiscoverySpec =
  | SourceControlCliDiscoverySpec
  | SourceControlApiDiscoverySpec;

type SourceControlCliRemoteRefinementSpec = SourceControlCliDiscoverySpec & {
  readonly refineUnknownRemote: NonNullable<SourceControlCliDiscoverySpec["refineUnknownRemote"]>;
};

// Most provider CLIs answer `--version` in well under a second, so a short budget keeps
// discovery snappy. Specs whose CLI is known to be slower can raise it via probeTimeoutMs.
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

function probeTimeoutMs(spec: SourceControlCliDiscoverySpec): number {
  return spec.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
}

interface DiscoveryProbeResult {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly executable: string;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

/**
 * What a version probe answers about one executable, independent of which spec asked.
 *
 * This has exactly two success shapes, both ordinary answers to "is this CLI here?" — neither is
 * a failure:
 * - `available`: the binary exists and ran.
 * - `absent`: no such command on PATH (POSIX ENOENT, or the Windows shell's "not recognized"
 *   exit — see `commandNotFoundBehavior` on `VcsProcessInput`). This is the routine, expected
 *   answer for an optional CLI a user never installed, so it is classified *before* it can open
 *   any span as a Failure — see `probeCliPresenceUncached` below.
 *
 * A genuine operational fault (timeout, EACCES, ENOEXEC, or any other non-ENOENT spawn error) is
 * NOT one of these two shapes: it is left to fail the returned Effect for real, so it keeps its
 * Failure trace and is never cached as absence. Callers that need a single degraded-but-present
 * value (the two `probeCli`-family functions below) catch that failure themselves, after the
 * span has already correctly recorded it.
 */
export type CliPresenceResult =
  | { readonly status: "available"; readonly version: Option.Option<string> }
  | { readonly status: "absent" };

export interface CliPresenceProbeSpec {
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly probeTimeoutMs?: number;
}

// Whether `az`, `glab`, `jj`, and friends are on the server's PATH is a fact about the machine,
// not about any one request: every caller here always probes the same fixed `config.cwd`, and
// PATH itself is captured once when the server process starts. A CLI this process has already
// found absent stays absent until someone installs it *and* restarts the server to pick up the
// new PATH — there is no in-process event that would make a cached "absent" go stale sooner than
// that. An "available" result is cheaper to get wrong (worst case: one avoidable re-probe), so it
// keeps a short TTL in case the CLI is upgraded or removed mid-session; an "absent" result gets a
// deliberately long, sticky TTL so the routine case of an optional CLI nobody installed — the one
// that used to re-probe (and mis-report as a Failure trace) on every discovery call — now costs at
// most one probe per CLI per TTL window instead of one per call.
//
// A genuine operational error gets neither of these: see CLI_PRESENCE_OPERATIONAL_ERROR_TTL.
const CLI_PRESENCE_AVAILABLE_TTL = Duration.minutes(5);
const CLI_PRESENCE_ABSENT_TTL = Duration.hours(24);
// Matches the "never cache a failure" convention providerContextCache/providerRefinementCache
// already use in SourceControlProviderRegistry.ts: a timeout or EACCES is not evidence the CLI is
// unusable *later*, only that this one attempt didn't work, so the next caller gets a fresh try
// rather than an hours-old failure repeated back at it.
const CLI_PRESENCE_OPERATIONAL_ERROR_TTL = Duration.zero;
// One entry per distinct executable name ever probed (git, jj, gh, glab, az, ...) — small and
// fixed, never grows with request volume the way the per-repository caches do.
const CLI_PRESENCE_CACHE_CAPACITY = 64;

function probeCliPresenceUncached(input: {
  readonly spec: CliPresenceProbeSpec;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
}): Effect.Effect<CliPresenceResult, VcsError> {
  return input.process
    .run({
      operation: "source-control.discovery.probe",
      command: input.spec.executable,
      args: input.spec.versionArgs,
      cwd: input.cwd,
      timeoutMs: input.spec.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
      // A `--version` that spawns and runs but exits non-zero (some CLIs do this) has still
      // answered the only question this probe asks — the binary is there — so that is not treated
      // as a failure either; only a genuine spawn/timeout fault below is.
      allowNonZeroExit: true,
      // Classified by `processRunner.run` at the point the spawn error is first known, so ENOENT
      // (and the Windows shell's "not recognized" exit) never opens this call's `VcsProcess.run`
      // span as a Failure — it comes back as an ordinary `commandNotFound: true` result instead.
      commandNotFoundBehavior: "result",
    })
    .pipe(
      Effect.map(
        (result): CliPresenceResult =>
          result.commandNotFound
            ? { status: "absent" }
            : {
                status: "available",
                version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
                  firstNonEmptyLine(result.stderr),
                ),
              },
      ),
    );
}

/**
 * Builds the shared version-probe cache for one set of CLI specs (a `SourceControlProviderRegistry`'s
 * `gh`/`glab`/`az`, or `SourceControlDiscovery`'s `git`/`jj`). Callers construct this once, at
 * service-startup time, and reuse it for the lifetime of the server process — the same idiom as
 * `providerContextCache`/`providerRefinementCache` in `SourceControlProviderRegistry.ts`, just
 * keyed on the executable's name instead of a repository's cwd.
 */
export function makeCliPresenceCache(
  specs: ReadonlyArray<CliPresenceProbeSpec>,
  input: { readonly process: VcsProcess.VcsProcess["Service"]; readonly cwd: string },
): Effect.Effect<Cache.Cache<string, CliPresenceResult, VcsError>> {
  const specsByExecutable = new Map(specs.map((spec) => [spec.executable, spec]));
  return Cache.makeWith<string, CliPresenceResult, VcsError>(
    (executable) => {
      const spec = specsByExecutable.get(executable);
      return spec === undefined
        ? Effect.succeed({ status: "absent" as const })
        : probeCliPresenceUncached({ spec, process: input.process, cwd: input.cwd });
    },
    {
      capacity: CLI_PRESENCE_CACHE_CAPACITY,
      timeToLive: (exit) => {
        if (!Exit.isSuccess(exit)) return CLI_PRESENCE_OPERATIONAL_ERROR_TTL;
        return exit.value.status === "available"
          ? CLI_PRESENCE_AVAILABLE_TTL
          : CLI_PRESENCE_ABSENT_TTL;
      },
    },
  );
}

export function firstNonEmptyLine(text: string): Option.Option<string> {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? Option.none() : Option.some(line);
}

export function detailFromCause(cause: unknown): Option.Option<string> {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return Option.some(cause.message.trim());
  }
  return Option.none();
}

function authAccount(account: string | undefined): Option.Option<string> {
  const trimmed = account?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authHost(host: string | undefined): Option.Option<string> {
  const trimmed = host?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authDetail(detail: string | undefined): Option.Option<string> {
  const trimmed = detail?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

export function providerAuth(input: {
  readonly status: SourceControlProviderAuth["status"];
  readonly account?: string | undefined;
  readonly host?: string | undefined;
  readonly detail?: string | undefined;
}): SourceControlProviderAuth {
  return {
    status: input.status,
    account: authAccount(input.account),
    host: authHost(input.host),
    detail: authDetail(input.detail),
  };
}

export function unknownAuth(detail?: string): SourceControlProviderAuth {
  return providerAuth({ status: "unknown", detail });
}

export function combinedAuthOutput(input: SourceControlAuthProbeInput): string {
  const parts: string[] = [];
  for (const entry of [input.stdout, input.stderr]) {
    if (entry.trim().length > 0) {
      parts.push(entry);
    }
  }
  return parts.join("\n");
}

function sanitizedAuthLines(text: string): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const entry of text.split(/\r?\n/)) {
    const line = entry.trim();
    if (line.length === 0) continue;
    if (/^[-\s]*token(?:\s+scopes?)?:/iu.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

export function firstSafeAuthLine(text: string): string | undefined {
  return sanitizedAuthLines(text)[0];
}

export function parseCliHost(text: string): string | undefined {
  return sanitizedAuthLines(text)
    .map((line) => line.replace(/^[^a-z0-9]+/iu, ""))
    .find((line) => /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/iu.test(line));
}

export function matchFirst(text: string, patterns: ReadonlyArray<RegExp>): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function isCliRemoteRefinementSpec(
  spec: SourceControlProviderDiscoverySpec,
): spec is SourceControlCliRemoteRefinementSpec {
  return spec.type === "cli" && spec.refineUnknownRemote !== undefined;
}

function probeCli(input: {
  readonly spec: SourceControlCliDiscoverySpec;
  readonly presenceCache: Cache.Cache<string, CliPresenceResult, VcsError>;
}): Effect.Effect<DiscoveryProbeResult> {
  return Cache.get(input.presenceCache, input.spec.executable).pipe(
    Effect.map(
      (presence): DiscoveryProbeResult =>
        presence.status === "available"
          ? {
              kind: input.spec.kind,
              label: input.spec.label,
              executable: input.spec.executable,
              status: "available",
              version: presence.version,
              installHint: input.spec.installHint,
              detail: Option.none<string>(),
            }
          : {
              kind: input.spec.kind,
              label: input.spec.label,
              executable: input.spec.executable,
              status: "missing",
              version: Option.none<string>(),
              installHint: input.spec.installHint,
              detail: Option.some("Command not found on the server PATH."),
            },
    ),
    // Reached only for a genuine operational error (see makeCliPresenceCache): the cache never
    // holds one, so this always means the attempt behind *this* call just failed. Its Failure
    // trace already stands — this only decides what the discovery panel shows for it.
    Effect.catch(
      (cause): Effect.Effect<DiscoveryProbeResult> =>
        Effect.succeed({
          kind: input.spec.kind,
          label: input.spec.label,
          executable: input.spec.executable,
          status: "missing" as const,
          version: Option.none<string>(),
          installHint: input.spec.installHint,
          detail: detailFromCause(cause),
        }),
    ),
  );
}

export function probeSourceControlProvider(input: {
  readonly spec: SourceControlProviderDiscoverySpec;
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
  readonly presenceCache: Cache.Cache<string, CliPresenceResult, VcsError>;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
  if (input.spec.type === "api") {
    return input.spec.probeAuth.pipe(
      Effect.map(
        (auth) =>
          ({
            kind: input.spec.kind,
            label: input.spec.label,
            status: "available" as const,
            version: Option.none<string>(),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
            auth,
          }) satisfies SourceControlProviderDiscoveryItem,
      ),
    );
  }

  const spec = input.spec;

  return probeCli({
    spec,
    presenceCache: input.presenceCache,
  }).pipe(
    Effect.flatMap((item) => {
      if (item.status !== "available") {
        return Effect.succeed({
          ...item,
          auth: unknownAuth("Hosting integration command was not found on the server PATH."),
        } satisfies SourceControlProviderDiscoveryItem);
      }

      return input.process
        .run({
          operation: "source-control.discovery.auth",
          command: spec.executable,
          args: spec.authArgs,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: probeTimeoutMs(spec),
          maxOutputBytes: 8_000,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map(
            (result) =>
              ({
                ...item,
                auth: spec.parseAuth(result),
              }) satisfies SourceControlProviderDiscoveryItem,
          ),
          Effect.catch((cause) =>
            Effect.succeed({
              ...item,
              auth: unknownAuth(Option.getOrUndefined(detailFromCause(cause))),
            } satisfies SourceControlProviderDiscoveryItem),
          ),
        );
    }),
  );
}

export const refineUnknownRemoteProvider = Effect.fn("refineUnknownRemoteProvider")(
  function* (input: {
    readonly specs: ReadonlyArray<SourceControlProviderDiscoverySpec>;
    readonly process: VcsProcess.VcsProcess["Service"];
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext | null;
  }): Effect.fn.Return<SourceControlProvider.SourceControlProviderContext | null> {
    if (input.context === null || input.context.provider.kind !== "unknown") {
      return input.context;
    }
    const context = input.context;

    const providers = yield* Effect.forEach(input.specs.filter(isCliRemoteRefinementSpec), (spec) =>
      input.process
        .run({
          operation: "source-control.discovery.refine-unknown-remote",
          command: spec.executable,
          args: spec.authArgs,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: probeTimeoutMs(spec),
          maxOutputBytes: 8_000,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map((auth) =>
            spec.refineUnknownRemote({
              cwd: input.cwd,
              context,
              auth,
            }),
          ),
          Effect.orElseSucceed(() => null),
        ),
    );
    const provider = providers.find((candidate) => candidate !== null);

    return provider ? { ...context, provider } : context;
  },
);
