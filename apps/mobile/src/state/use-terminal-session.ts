import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId, type EnvironmentId, type TerminalAttachInput } from "@t3tools/contracts";
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

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null) {
      return [];
    }
    return (
      (metadata.data ?? [])
        // A pane has exactly one owner: a thread OR a child session, so
        // `summary.threadId` is null for a subagent's PTY (#149,
        // backend/src/terminal.rs:352-357). This hook addresses panes as
        // `{threadId, terminalId}` and has no expression for a session-owned
        // pane; the session-addressed mounting path is the remaining half of
        // #149. Before `threadId` became nullable this called
        // `ThreadId.make(null)` on every such pane.
        .filter(
          (summary): summary is typeof summary & { readonly threadId: string } =>
            summary.threadId !== null,
        )
        .filter((summary) => input.threadId === null || summary.threadId === input.threadId)
        .map((summary) => ({
          target: {
            environmentId: input.environmentId!,
            threadId: ThreadId.make(summary.threadId),
            terminalId: summary.terminalId,
          },
          state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
        }))
        .sort((left, right) =>
          left.target.terminalId.localeCompare(right.target.terminalId, undefined, {
            numeric: true,
          }),
        )
    );
  }, [input.environmentId, input.threadId, metadata.data]);
}
