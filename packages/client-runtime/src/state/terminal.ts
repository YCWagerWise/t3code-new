import { type TerminalSummary, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
} from "./terminalSession.ts";

/**
 * How a terminal command NAMES the pane it acts on (#149).
 *
 * A pane belongs to either a thread or a CHILD SESSION. A subagent runs in its
 * own session, usually its own worktree, and its PTY is owned by Hearth rather
 * than by the thread that spawned it — so `{threadId, terminalId}` cannot name
 * it. Several child sessions of one thread collapse onto one key, and with no
 * `threadId` at all they collapse onto `[environmentId, null]` — ONE key for
 * every subagent in the environment.
 *
 * That is not cosmetic, because these keys are the CONCURRENCY keys. Lifecycle
 * commands (open/clear/restart/close) run `serial` per key, and `resize` runs
 * `latest` per key. Collapsed keys therefore mean: one subagent's `open` queues
 * behind an unrelated subagent's `close`, and — worse, because `latest` DROPS
 * what it supersedes — one subagent's resize silently discards another's. The
 * bug is a lost command, not just a slow one.
 *
 * `sessionId` WINS over `threadId` when both are present. That is not a
 * preference: it mirrors how the runtime already resolves the same target in
 * `backend/src/terminal.rs` (:293-307), and a client that ordered these two
 * differently would serialize commands under one identity while the server
 * executed them under another.
 */
export const terminalOwnerKey = ({
  environmentId,
  input,
}: {
  readonly environmentId: string;
  readonly input: {
    readonly threadId?: string | undefined;
    readonly sessionId?: string | undefined;
  };
}) =>
  JSON.stringify(
    input.sessionId !== undefined
      ? [environmentId, "session", input.sessionId]
      : [environmentId, "thread", input.threadId ?? null],
  );

/** [`terminalOwnerKey`] narrowed to a single pane of that owner. */
export const terminalPaneKey = ({
  environmentId,
  input,
}: {
  readonly environmentId: string;
  readonly input: {
    readonly threadId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly terminalId?: string | undefined;
  };
}) => JSON.stringify([terminalOwnerKey({ environmentId, input }), input.terminalId ?? null]);

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalOwnerKey };
  return {
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) =>
        subscribe(WS_METHODS.terminalAttach, input).pipe(
          Stream.scan(EMPTY_TERMINAL_BUFFER_STATE, applyTerminalAttachStreamEvent),
        ),
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan([] as ReadonlyArray<TerminalSummary>, applyTerminalMetadataStreamEvent),
        ),
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalPaneKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
