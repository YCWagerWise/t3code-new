/**
 * `subscribeShell` on the Atlas transport (doc 15 §2.4): the sidebar catalog.
 *
 * Atlas has no catalog stream yet — `/_runs` and `/_workspaces` are snapshots — so this
 * is an honest poll: snapshot, then diff successive polls into upsert/remove events.
 * Substrate over shims: the mapping and the diff are pure functions over the node's OWN
 * catalog rows (no invented state), and the fetch is injected as an Effect so the poll
 * cadence is the only thing this module owns. When Atlas grows a catalog stream, only
 * the injected fetch changes.
 */

import type {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface ShellCatalog {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

export type ShellStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: OrchestrationShellSnapshot }
  | { readonly kind: "synchronized" }
  | {
      readonly kind: "project-upserted";
      readonly sequence: number;
      readonly project: OrchestrationProjectShell;
    }
  | { readonly kind: "project-removed"; readonly sequence: number; readonly projectId: string }
  | {
      readonly kind: "thread-upserted";
      readonly sequence: number;
      readonly thread: OrchestrationThreadShell;
    }
  | { readonly kind: "thread-removed"; readonly sequence: number; readonly threadId: string };

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** `/_workspaces` + `/_runs` rows → shell shapes. One boundary cast; the test decodes
 * the assembled snapshot through the real contract schema. */
export const mapCatalog = (workspacesJson: unknown, runsJson: unknown): ShellCatalog => {
  const workspaceRows = Array.isArray((workspacesJson as { workspaces?: unknown })?.workspaces)
    ? (workspacesJson as { workspaces: Array<Record<string, unknown>> }).workspaces
    : [];
  const runRows = Array.isArray((runsJson as { runs?: unknown })?.runs)
    ? (runsJson as { runs: Array<Record<string, unknown>> }).runs
    : [];

  const projects = workspaceRows
    .filter((w) => w.archived !== 1)
    .map(
      (w) =>
        ({
          id: String(w.workspace_id ?? "ws-unknown"),
          title:
            typeof w.name === "string" && w.name.trim() !== "" ? w.name : String(w.workspace_id),
          workspaceRoot: String(w.root ?? "/"),
          defaultModelSelection: null,
          scripts: [],
          createdAt: iso(Number(w.created_at ?? 0)),
          updatedAt: iso(Number(w.updated_at ?? 0)),
        }) as unknown as OrchestrationProjectShell,
    );

  const threads = runRows
    .filter((r) => r.kind === "thread")
    .map((r) => {
      const runId = String(r.run_id ?? "");
      return {
        // The lens thread id is the run id minus the `thr-` marker the node keys by.
        id: runId.startsWith("thr-") ? runId.slice(4) : runId,
        projectId:
          typeof r.workspace_id === "string" && r.workspace_id !== "" ? r.workspace_id : "atlas",
        title: runId,
        modelSelection: { instanceId: "atlas", model: "atlas" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: iso(Number(r.created_at ?? 0)),
        updatedAt: iso(Number(r.updated_at ?? 0)),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      } as unknown as OrchestrationThreadShell;
    });

  return { projects, threads };
};

/** Pure diff: what changed between two polls, keyed by id, change detected by updatedAt. */
export const diffCatalog = (
  prev: ShellCatalog,
  next: ShellCatalog,
): Array<
  | { readonly kind: "project-upserted"; readonly project: OrchestrationProjectShell }
  | { readonly kind: "project-removed"; readonly projectId: string }
  | { readonly kind: "thread-upserted"; readonly thread: OrchestrationThreadShell }
  | { readonly kind: "thread-removed"; readonly threadId: string }
> => {
  const out: ReturnType<typeof diffCatalog> = [];
  const prevProjects = new Map(prev.projects.map((p) => [p.id as string, p]));
  const prevThreads = new Map(prev.threads.map((t) => [t.id as string, t]));
  for (const p of next.projects) {
    const old = prevProjects.get(p.id as string);
    if (old === undefined || old.updatedAt !== p.updatedAt) {
      out.push({ kind: "project-upserted", project: p });
    }
    prevProjects.delete(p.id as string);
  }
  for (const id of prevProjects.keys()) {
    out.push({ kind: "project-removed", projectId: id });
  }
  for (const t of next.threads) {
    const old = prevThreads.get(t.id as string);
    if (old === undefined || old.updatedAt !== t.updatedAt) {
      out.push({ kind: "thread-upserted", thread: t });
    }
    prevThreads.delete(t.id as string);
  }
  for (const id of prevThreads.keys()) {
    out.push({ kind: "thread-removed", threadId: id });
  }
  return out;
};

export interface ShellStreamOptions {
  /** The injected substrate: one poll of the node's catalogs. */
  readonly fetchCatalog: Effect.Effect<ShellCatalog>;
  readonly intervalMillis: number;
  readonly nowMillis: Effect.Effect<number>;
}

export const openShellStream = (options: ShellStreamOptions): Stream.Stream<ShellStreamItem> =>
  Stream.callback<ShellStreamItem>((queue) =>
    Effect.gen(function* () {
      let sequence = 0;
      let current = yield* options.fetchCatalog;
      const now = yield* options.nowMillis;
      yield* Queue.offer(queue, {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 0,
          projects: current.projects,
          threads: current.threads,
          updatedAt: iso(now),
        } as unknown as OrchestrationShellSnapshot,
      });
      yield* Queue.offer(queue, { kind: "synchronized" });
      while (true) {
        yield* Effect.sleep(options.intervalMillis);
        // A failed poll is a quiet cycle, not a dead sidebar — retry next tick.
        const next = yield* options.fetchCatalog.pipe(Effect.orElseSucceed(() => current));
        for (const change of diffCatalog(current, next)) {
          sequence += 1;
          yield* Queue.offer(queue, { ...change, sequence } as ShellStreamItem);
        }
        current = next;
      }
    }),
  );
