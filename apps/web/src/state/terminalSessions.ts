import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  ownerSessionId,
  ownerThreadId,
  sameTerminalOwner,
  terminalOwnerOfSummary,
  terminalTargetKey,
  type KnownTerminalSession,
  type KnownTerminalSessionOwner,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import type { EnvironmentId, TerminalAttachInput, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): TerminalSessionState {
  const attach = useEnvironmentQuery(
    input.environmentId !== null && input.terminal !== null
      ? terminalEnvironment.attach({
          environmentId: input.environmentId,
          input: input.terminal,
        })
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
    return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
  }, [attach.data, attach.error, input.environmentId, input.terminal, metadata.data]);
}

/**
 * Every pane the environment knows, addressed by its OWNER (#149).
 *
 * `owner: null` means "both kinds" — the mount list uses this to render thread
 * drawers and subagent PTYs from one source instead of two.
 *
 * This used to drop child-session panes on the floor, because the target type
 * could not name them. It can now, so they are returned.
 */
export function useOwnedTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly owner: KnownTerminalSessionOwner | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  const environmentId = input.environmentId;
  const owner = input.owner;
  return useMemo(() => {
    if (environmentId === null) {
      return [];
    }
    return (metadata.data ?? [])
      .flatMap((summary): ReadonlyArray<KnownTerminalSession> => {
        // A pane has exactly ONE owner, so this reads the wire the same way
        // `TerminalOwner::wire` writes it: `threadId` set means a thread pane,
        // `sessionId` set means a child session. A summary carrying neither is
        // not addressable and is skipped rather than guessed at.
        const paneOwner = terminalOwnerOfSummary(summary);
        if (paneOwner === null) {
          return [];
        }
        if (owner !== null && !sameTerminalOwner(paneOwner, owner)) {
          return [];
        }
        return [
          {
            target: { environmentId, owner: paneOwner, terminalId: summary.terminalId },
            state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
          },
        ];
      })
      .sort((left, right) =>
        left.target.terminalId.localeCompare(right.target.terminalId, undefined, {
          numeric: true,
        }),
      );
  }, [environmentId, owner, metadata.data]);
}

/**
 * Thread-addressed panes. Unchanged behaviour for every existing caller — it is
 * now expressed as the thread case of the owner-addressed hook rather than as
 * the only addressing mode that exists.
 */
export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const owner = useMemo<KnownTerminalSessionOwner | null>(
    () => (input.threadId === null ? null : { kind: "thread", threadId: input.threadId }),
    [input.threadId],
  );
  const all = useOwnedTerminalSessions({ environmentId: input.environmentId, owner });
  // `owner: null` means BOTH kinds, but this hook promises thread panes only,
  // so an unfiltered call still has to exclude child sessions here.
  return useMemo(
    () => (input.threadId === null ? all.filter((s) => s.target.owner.kind === "thread") : all),
    [all, input.threadId],
  );
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  return selectRunningSubprocessTerminalIds(useKnownTerminalSessions(input));
}

// Re-exported so a component addresses a pane through ONE module instead of
// reaching past this layer into client-runtime for the accessors (#149).
export { ownerSessionId, ownerThreadId, terminalTargetKey };
export type { KnownTerminalSessionOwner };
