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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as atlasHttp from "./http.ts";
import { openThreadFeed, ThreadFeedAuthError } from "./threadFeed.ts";
import { EnvironmentRpcUnavailableError } from "../client.ts";
import type { PreparedConnection } from "../../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as TransientError,
} from "../../connection/model.ts";
import { RpcSessionFactory, type RpcSession } from "../session.ts";
import type { WsRpcProtocolClient } from "../protocol.ts";

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

    const dispatch = Effect.fnUntraced(function* (input: {
      readonly type: string;
      readonly commandId: string;
      readonly threadId?: string;
      readonly message?: { readonly text: string };
      readonly requestId?: string;
      readonly decision?: unknown;
      readonly answers?: unknown;
    }) {
      const threadId = input.threadId ?? "";
      const command =
        input.type === "thread.turn.start"
          ? { kind: "start" as const, text: input.message?.text ?? "", limits: null }
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

    const fullThreadDiff = Effect.fnUntraced(function* (input: { readonly threadId: string }) {
      const diff = yield* atlasHttp
        .threadDiff(target, runIdForThread(input.threadId))
        .pipe(Effect.provide(httpLayer));
      return { unifiedDiff: diff.unified };
    });

    // ── the 70-tag client: every tag has an explicit fate ──
    const unavailable = (tag: string) =>
      new EnvironmentRpcUnavailableError({
        environmentId: connection.environmentId,
        message: `${connection.label} (Atlas) does not provide "${tag}" yet.`,
      });
    const bound: Record<string, unknown> = {
      [WS_METHODS.serverGetConfig]: () => initialConfig,
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: fullThreadDiff,
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
      serverVersion: manifest?.runtime?.version ?? "atlas",
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
    providers: [],
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

interface MemberManifest {
  readonly machine?: { readonly os?: string; readonly arch?: string };
  readonly runtime?: { readonly version?: string };
  readonly execution?: { readonly workspace?: string };
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
