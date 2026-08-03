/**
 * The Atlas-backed `RpcSessionFactory` (doc 14 §2, §5) — same service tag as the Effect-RPC
 * factory in `../session.ts`, so which transport an app speaks is one Layer choice.
 *
 * One session, N run sockets: the session holds NO standing socket. `ready` is two
 * authenticated exchanges — the HTTP handshake, then one readiness feed probe (the feed is
 * the execution boundary and authenticates separately; a ready that skips it reports ready
 * for a node whose socket auth is broken). Run sockets are `ThreadFeed`'s business and
 * their loss never touches `closed` — rule zero, structurally.
 *
 * The client object gives all 70 tags an explicit fate (§5): bound tags dispatch to the
 * Atlas HTTP module; everything else fails typed with `EnvironmentRpcUnavailableError`.
 * An unlisted tag is a construction-time defect, not a silent fall-through.
 */

import {
  DEFAULT_SERVER_SETTINGS,
  ORCHESTRATION_WS_METHODS,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import type { CommandEnvelope } from "@t3tools/contracts/atlas";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as atlasHttp from "./http.ts";
import { mapCatalog, openShellStream } from "./shellStream.ts";
import { openThreadStream } from "./threadStream.ts";
import { openThreadFeed, ThreadFeedAuthError } from "./threadFeed.ts";
import { EnvironmentRpcUnavailableError } from "../client.ts";
import type { PreparedConnection } from "../../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as TransientError,
} from "../../connection/model.ts";
import { RpcSessionFactory, type RpcSession } from "../session.ts";
import type { WsRpcProtocolClient } from "../protocol.ts";

const LENS_LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "thread.create",
  "thread.meta.update",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
]);

const READINESS_RUN_ID = "t3-readiness";
const READINESS_TIMEOUT_MILLIS = 5_000;

/** Stream-shaped tags (from `client.ts`'s unions) — gated refusals must be `Stream.fail`,
 * not `Effect.fail`, or the caller's pipeline dies with a defect instead of an error. */
const STREAM_TAGS: ReadonlySet<string> = new Set([
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  WS_METHODS.subscribeAuthAccess,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalMetadata,
  WS_METHODS.subscribePreviewEvents,
  WS_METHODS.subscribeDiscoveredLocalServers,
  WS_METHODS.previewAutomationConnect,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.terminalAttach,
  WS_METHODS.cloudInstallRelayClient,
  WS_METHODS.gitRunStackedAction,
]);

const ALL_TAGS: ReadonlyArray<string> = [
  ...Object.values(WS_METHODS),
  ...Object.values(ORCHESTRATION_WS_METHODS),
];

/** The thread's feed/supervisor key. The console routes key their durable objects by this
 * string; today the node passes it to both `thread_id` and `run_id` (12b item 5). */
const runIdForThread = (threadId: string): string => `thr-${threadId}`;

const mapHttpError = (error: atlasHttp.AtlasHttpError) =>
  error.status === 401 || error.status === 403
    ? new ConnectionBlockedError({ reason: "permission", detail: error.message })
    : new TransientError({
        reason: error.status === undefined ? "transport" : "remote-unavailable",
        detail: error.message,
      });

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const socketLayer = Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor);
  const httpLayer = FetchHttpClient.layer;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const bearerToken =
      connection.httpAuthorization?._tag === "Bearer" ? connection.httpAuthorization.token : null;
    const target: atlasHttp.AtlasHttpTarget = {
      baseUrl: connection.httpBaseUrl,
      bearerToken,
    };

    const handshake = atlasHttp
      .handshake(target)
      .pipe(Effect.provide(httpLayer), Effect.mapError(mapHttpError));
    const cachedHandshake = yield* Effect.cached(handshake);

    // The execution-boundary half of readiness: one feed socket must authenticate and
    // reach its replay boundary. First `replay-complete` = the node serves feeds to this
    // credential; `ThreadFeedAuthError` = it does not; silence = it is not healthy.
    const feedProbe = openThreadFeed({
      socketBaseUrl: connection.httpBaseUrl,
      runId: READINESS_RUN_ID,
      accessToken: bearerToken ?? "",
    }).pipe(
      Stream.filter((event) => event.kind === "replay-complete"),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeoutOrElse({
        duration: READINESS_TIMEOUT_MILLIS,
        orElse: () =>
          Effect.fail(
            new TransientError({
              reason: "transport",
              detail: `${connection.label} feed socket did not become ready.`,
            }),
          ),
      }),
      Effect.mapError((error) =>
        error instanceof ThreadFeedAuthError
          ? new ConnectionBlockedError({ reason: "permission", detail: error.message })
          : error,
      ),
      Effect.provide(socketLayer),
    );

    const ready = yield* Effect.cached(cachedHandshake.pipe(Effect.andThen(feedProbe)));

    const initialConfig = yield* Effect.cached(
      Effect.gen(function* () {
        const serverReady = yield* cachedHandshake;
        // Discovery only — a dead catalog must not block a working conversation.
        const membersJson = yield* atlasHttp.members(target).pipe(
          Effect.provide(httpLayer),
          Effect.orElseSucceed(() => undefined),
        );
        return synthesizeConfig(connection, serverReady.authenticated_subject, membersJson);
      }),
    );

    // Lens-local commands get their own receipt counter: they never reach the node, so
    // they cannot borrow a node sequence.
    let localSequence = 0;
    // Pending sends, keyed by thread: the command's messageId, consumed when the node's
    // user frame comes back so the echo carries the id the optimistic bubble reconciles
    // by. One entry per thread — a second send before the first echo overwrites, which is
    // also what the donor's pending-turn repository does.
    const pendingUserMessageIds = new Map<string, string>();

    const dispatch = Effect.fnUntraced(function* (input: {
      readonly type: string;
      readonly commandId: string;
      readonly threadId?: string;
      readonly message?: { readonly text: string };
      readonly bootstrap?: { readonly createThread?: { readonly projectId?: string } };
      readonly requestId?: string;
      readonly decision?: unknown;
      readonly answers?: unknown;
    }) {
      const threadId = input.threadId ?? "";
      // Thread META — title and model preference — is PRESENTATION state that Atlas does
      // not own yet: it has no thread catalog with titles, and `RunCommand::Start` carries
      // no model field, so a per-thread model choice has no wire home (recorded as a gap,
      // not papered over — the node runs its manifest default until Start grows one).
      // Accepting it lens-locally is not an empty-success shim: nothing was asked of the
      // node, so nothing is being falsely reported as done.
      // Presentation-state commands (archive/settle/snooze/meta) never reach the node —
      // nothing is asked of it, so a local receipt reports nothing falsely. And
      // `thread.create` is TRUE by construction, not a shim: an Atlas thread is its feed,
      // and the feed isolate is created lazily on first subscribe — the first Start makes
      // it real, the catalog poll picks it up after its first turn. Refusing create was
      // the actual lie: it told the user Atlas cannot do something it does implicitly.
      if (LENS_LOCAL_COMMANDS.has(input.type)) {
        localSequence += 1;
        return { sequence: localSequence };
      }
      // A T3 "project" IS an Atlas workspace, and the catalog has a real registration
      // route (allow-list gated, canonicalised to the repo toplevel). This is a true
      // binding, not a local receipt: the node decides, and a refused path is a refused
      // project. The sidebar reflects it on the next catalog poll under the node's own
      // ws-* id — the node, not the lens, is the authority on project identity.
      if (input.type === "project.create") {
        const root = (input as { workspaceRoot?: string }).workspaceRoot ?? "";
        yield* atlasHttp.registerWorkspace(target, root).pipe(
          Effect.provide(httpLayer),
          // The node's 403 is deliberately undifferentiated (path-probing learns
          // nothing), but the LENS knows what a 403 on this route means and owes the
          // user the reason — "HTTP 403" cost real debugging time on 2026-08-03.
          Effect.mapError((error) =>
            error.status === 403
              ? new EnvironmentRpcUnavailableError({
                  environmentId: connection.environmentId,
                  message: `"${root}" is outside this node's allowed workspace roots — projects must live under a directory the node was configured to serve.`,
                })
              : error,
          ),
        );
        localSequence += 1;
        return { sequence: localSequence };
      }
      // The first send carries its project via bootstrap.createThread; for catalog
      // projects the lens projectId IS the node's workspace id (ws-*), so the binding
      // crosses the wire as-is and the node's allow-list has the final word. A non-catalog
      // id (a draft against a project the node never registered) simply fails to resolve
      // and the turn REFUSES — wrong-tree-quietly is the outcome this exists to prevent.
      const workspaceId = input.bootstrap?.createThread?.projectId;
      const messageId = (input as { message?: { messageId?: string } }).message?.messageId;
      if (input.type === "thread.turn.start" && typeof messageId === "string" && threadId !== "") {
        pendingUserMessageIds.set(threadId, messageId);
      }
      const command =
        input.type === "thread.turn.start"
          ? {
              kind: "start" as const,
              text: input.message?.text ?? "",
              limits: {},
              ...(typeof workspaceId === "string" && workspaceId.startsWith("ws-")
                ? { workspace_id: workspaceId }
                : {}),
            }
          : input.type === "thread.turn.interrupt"
            ? { kind: "cancel" as const }
            : input.type === "thread.approval.respond"
              ? {
                  kind: "resolve_input" as const,
                  request_ref: input.requestId ?? "",
                  answer: input.decision ?? null,
                }
              : input.type === "thread.user-input.respond"
                ? {
                    kind: "resolve_input" as const,
                    request_ref: input.requestId ?? "",
                    answer: input.answers ?? null,
                  }
                : null;
      if (command === null || threadId === "") {
        // Everything else on the command union (project CRUD, snooze, meta…) is
        // projection/catalog territory — slice 3+. Refusing typed beats half-doing.
        return yield* Effect.fail(
          new EnvironmentRpcUnavailableError({
            environmentId: connection.environmentId,
            message: `Atlas does not yet accept the "${input.type}" command.`,
          }),
        );
      }
      // Only a command the node accepts pays for a handshake — a gated refusal must
      // work with no network at all (pinned by the session gate test).
      const serverReady = yield* cachedHandshake;
      const runId = runIdForThread(threadId);
      const envelope = {
        protocol_version: 1,
        fleet_id: serverReady.fleet_id,
        thread_id: runId,
        run_id: runId,
        // The commandId minted upstream IS the idempotency key: a retry reuses it, and
        // the node actuates once.
        request_id: input.commandId,
        actor: "t3-code",
        expected_lease_generation: null,
        command,
      } as unknown as CommandEnvelope;
      const snapshot = yield* atlasHttp
        .postCommand(target, envelope)
        .pipe(Effect.provide(httpLayer));
      return { sequence: Number(snapshot.event_head?.seq ?? 0) };
    });

    const turnDiff = Effect.fnUntraced(function* (input: {
      readonly threadId: string;
      readonly fromTurnCount?: number;
      readonly toTurnCount?: number;
    }) {
      // checkpointTurnCount ≡ the node's checkpoint seq (projection adopts it), so the
      // range maps straight onto the diff route — no join table, no second authority.
      const options: { from?: number; to?: number } = {};
      if (input.fromTurnCount !== undefined && input.fromTurnCount > 0) {
        options.from = input.fromTurnCount;
      }
      if (input.toTurnCount !== undefined && input.toTurnCount > 0) {
        options.to = input.toTurnCount;
      }
      const diff = yield* atlasHttp
        .threadDiff(target, runIdForThread(input.threadId), options)
        .pipe(Effect.provide(httpLayer));
      return {
        threadId: input.threadId,
        diff: diff.unified,
        fromTurnCount: input.fromTurnCount ?? 0,
        toTurnCount: input.toTurnCount ?? Math.max(input.fromTurnCount ?? 0, 0),
      };
    });

    // ── the 70-tag client: every tag has an explicit fate ──
    const unavailable = (tag: string) =>
      new EnvironmentRpcUnavailableError({
        environmentId: connection.environmentId,
        message: `${connection.label} (Atlas) does not provide "${tag}" yet.`,
      });
    const bound: Record<string, unknown> = {
      [WS_METHODS.serverGetConfig]: () => initialConfig,
      // The add-project picker's suggestions. The node owns the semantics AND the scope
      // (allow-list); the lens just carries the partial path across.
      [WS_METHODS.filesystemBrowse]: (input: { partialPath: string }) =>
        atlasHttp.fsBrowse(target, input.partialPath).pipe(Effect.provide(httpLayer)),
      // ThreadFeed → projection → stream items; threadReducer folds downstream. The
      // socket layer rides the stream so subscribers need no extra context.
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { threadId: string }) =>
        openThreadStream({
          socketBaseUrl: connection.httpBaseUrl,
          accessToken: bearerToken ?? "",
          threadId: input.threadId,
          runId: runIdForThread(input.threadId),
          takePendingUserMessageId: (threadId) => {
            const pending = pendingUserMessageIds.get(threadId) ?? null;
            pendingUserMessageIds.delete(threadId);
            return pending;
          },
        }).pipe(Stream.provide(socketLayer)),
      // Honest poll until Atlas grows a catalog stream — the fetch is the injected
      // substrate, so only it changes when that lands.
      [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
        openShellStream({
          fetchCatalog: Effect.zip(
            atlasHttp.listWorkspaces(target),
            atlasHttp.listThreads(target),
          ).pipe(
            Effect.map(([workspaces, threads]) => mapCatalog(workspaces, threads)),
            Effect.orElseSucceed(() => ({ projects: [], threads: [] })),
            Effect.provide(httpLayer),
          ),
          intervalMillis: 15_000,
          nowMillis: Clock.currentTimeMillis,
        }),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: turnDiff,
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: turnDiff,
    };
    const client: Record<string, unknown> = {};
    for (const tag of ALL_TAGS) {
      client[tag] =
        bound[tag] ??
        (STREAM_TAGS.has(tag)
          ? () => Stream.fail(unavailable(tag))
          : () => Effect.fail(unavailable(tag)));
    }

    const closed = yield* Deferred.make<never, TransientError>();

    return {
      // One deliberate cast: the object covers every declared tag (construction iterates
      // the same method tables the type is derived from), and gated tags fail with an
      // error the command layer already carries in its channel.
      client: client as unknown as WsRpcProtocolClient,
      initialConfig,
      ready,
      probe: handshake.pipe(Effect.asVoid),
      // Run-socket loss NEVER lands here; the session dies by scope or probe failure.
      closed: Deferred.await(closed),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

const synthesizeConfig = (
  connection: PreparedConnection,
  _subject: string,
  membersJson: unknown,
): ServerConfig => {
  const manifest = firstManifest(membersJson);
  const os = manifest?.machine?.os;
  const arch = manifest?.machine?.arch;
  return {
    environment: {
      environmentId: connection.environmentId,
      label: connection.label,
      platform: {
        os: os === "macos" ? "darwin" : os === "windows" ? "windows" : "linux",
        arch: arch === "aarch64" || arch === "arm64" ? "arm64" : "x64",
      },
      // Deliberately absent. T3's client and T3's server ship as a matched pair, so a
      // skew banner tells you to relaunch the server "to sync them" — an instruction
      // with no meaning here: Atlas versions independently and no command could ever
      // make the two strings match. `resolveVersionMismatch` already treats an unknown
      // server version as "nothing to compare", which is precisely the truth for a
      // non-T3 backend. The node's real version belongs in a fleet/node view, not in
      // T3's release-skew check.
      serverVersion: "",
      // A capability not synthesized is false — and must agree with the gate: the config
      // may never advertise what the client object refuses.
      capabilities: {
        repositoryIdentity: false,
        connectionProbe: false,
      },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "atlas-session",
    },
    cwd: manifest?.execution?.workspace ?? "/",
    keybindingsConfigPath: "atlas://keybindings",
    keybindings: [],
    issues: [],
    // Atlas advertises what it can run through the node manifest — bodies (personas)
    // and `execution.default_model`. The lens must not synthesize a model list of its
    // own (doc 11 records exactly that bug: a hardcoded "claude" slug reaching the CLI
    // as `claude --model claude`), so an empty manifest yields an empty picker rather
    // than an invented one.
    providers: atlasProviders(manifest),
    availableEditors: [],
    observability: {
      logsDirectoryPath: "atlas://logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    shellResumeCompletionMarker: false,
    threadResumeCompletionMarker: false,
  };
};

/** One provider instance: the node itself, offering the models it says it can run. */
const atlasProviders = (manifest: MemberManifest | undefined) => {
  const model = manifest?.execution?.default_model?.trim();
  if (model === undefined || model === "") {
    return [];
  }
  return [
    {
      instanceId: "atlas",
      driver: "atlas",
      displayName: "Atlas",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { state: "authenticated" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      models: [
        {
          slug: model,
          name: model,
          isCustom: false,
          isDefault: true,
          // `null` means "this provider exposes no option controls" — not "no tools".
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ] as unknown as ServerConfig["providers"];
};

interface MemberManifest {
  readonly machine?: { readonly os?: string; readonly arch?: string };
  readonly runtime?: { readonly version?: string };
  readonly execution?: { readonly workspace?: string; readonly default_model?: string };
}

const firstManifest = (membersJson: unknown): MemberManifest | undefined => {
  if (typeof membersJson !== "object" || membersJson === null) {
    return undefined;
  }
  const members = (membersJson as { members?: unknown }).members;
  if (!Array.isArray(members) || members.length === 0) {
    return undefined;
  }
  const manifest = (members[0] as { manifest?: unknown }).manifest;
  return typeof manifest === "object" && manifest !== null
    ? (manifest as MemberManifest)
    : undefined;
};

/** Provide this instead of `../session.ts`'s `layer` to point an app at Atlas. */
export const layer = Layer.effect(RpcSessionFactory, make);
