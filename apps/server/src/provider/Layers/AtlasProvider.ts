/**
 * AtlasProvider — health and model catalog for one Atlas node.
 *
 * The other providers answer "am I available?" by looking for a CLI on this
 * machine's PATH. Atlas answers it by asking the node, because availability is a
 * property of the node, not of this laptop: the ring reports which boxes are up,
 * what tools they carry, and which models they can actually run.
 *
 * The model list is derived from that same report and never hardcoded. Atlas
 * accepts any model string and only rejects a bad one mid-run ("There's an issue
 * with the selected model (...)"), so a static catalogue would let a user pick
 * something the node cannot run and only find out a turn later.
 *
 * @module provider/Layers/AtlasProvider
 */
import type { AtlasSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";

import {
  type AtlasClientError,
  type AtlasMember,
  atlasMembers,
  type AtlasModelOption,
  modelOptionsForMember,
} from "./AtlasClient.ts";

export const ATLAS_DRIVER_KIND = ProviderDriverKind.make("atlas");

/** Host and port, ignoring scheme and trailing slash, so two spellings of one node match. */
const authorityOf = (raw: string): string | undefined => {
  try {
    return new URL(raw).host;
  } catch {
    return undefined;
  }
};

/**
 * The member that IS the node we asked.
 *
 * The node tells us directly: `members_json` stamps `age_ms: 0` on its own entry
 * and a real age on every peer it learned by gossip, so self-identification is a
 * declaration rather than something to infer. That is the primary signal.
 *
 * The URL comparison is only a fallback for a node that reports no ages. Matching
 * on the advertised authority beats the previous `baseUrl.includes(member.id)`,
 * which could never match an id like `macbook` against `http://127.0.0.1:3010` and
 * so always fell through to `members[0]` — harmless with one member, and silently
 * describing the wrong box's models once the ring repopulated.
 */
export const selfMember = (
  members: ReadonlyArray<AtlasMember>,
  baseUrl: string,
): AtlasMember | undefined => {
  const declared = members.filter((m) => m.age_ms === 0);
  // Exactly one claimant is the normal case. Two would mean the ring disagrees
  // about who is local, and guessing between them is how you end up describing
  // the wrong node's models.
  if (declared.length === 1) return declared[0];

  const want = authorityOf(baseUrl);
  if (want === undefined) return undefined;
  return members.find((m) => authorityOf(m.url) === want);
};

const toServerProviderModel = (option: AtlasModelOption): ServerProviderModel => ({
  slug: option.id,
  name: option.label,
  shortName: option.label.split(":")[0] ?? option.label,
  subProvider: option.source,
  isCustom: false,
  capabilities: null,
});

/**
 * Models a node can actually run, ordered so the dependable ones lead.
 *
 * CLI-backed routes come first because they hold up on tool-enabled plugins;
 * local models that cannot tool-call sink to the bottom rather than being
 * hidden, since a user may still want one for a plain prompt.
 */
export const modelsForMember = (member: AtlasMember): ReadonlyArray<ServerProviderModel> => {
  const options = [...modelOptionsForMember(member)];
  options.sort((a, b) => {
    if (a.supportsTools !== b.supportsTools) return a.supportsTools ? -1 : 1;
    const rank = { claude: 0, codex: 1, "ollama-cloud": 2, ollama: 3 } as const;
    return rank[a.source] - rank[b.source];
  });
  return options.map(toServerProviderModel);
};

export interface AtlasSnapshotInput {
  readonly instanceId: ServerProvider["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly config: AtlasSettings;
  readonly enabled: boolean;
  readonly checkedAt: string;
}

/**
 * Ask the node how it is and what it can run.
 *
 * A node that does not answer is reported as `error` with the reason attached,
 * rather than as an empty-but-healthy provider — an Atlas instance whose node is
 * unreachable is broken, not idle.
 */
export const checkAtlasProviderStatus = (
  input: AtlasSnapshotInput,
): Effect.Effect<ServerProvider, never, HttpClient.HttpClient> =>
  atlasMembers(input.config.baseUrl).pipe(
    Effect.map((members): ServerProvider => {
      // A node reports the whole ring it can see, and the FIRST entry is not
      // reliably the one we asked. Match on the URL the member advertises rather
      // than on its id: an id like `macbook` never appears inside
      // `http://127.0.0.1:3010`, so the old id-substring check always fell
      // through to members[0] — harmless with one member, wrong the moment the
      // ring repopulates, and it would describe the wrong box's models.
      const self = selfMember(members, input.config.baseUrl) ?? members[0];
      const reachable = members.length > 0;
      const bodyCount = self?.manifest?.bodies.length ?? 0;
      const authLabel = self
        ? [
            self.manifest?.machine.label ?? self.id,
            ...(bodyCount > 0 ? [`${bodyCount} bodies`] : []),
            `${self.tools.length} tools`,
          ].join(" · ")
        : undefined;
      return {
        instanceId: input.instanceId,
        driver: ATLAS_DRIVER_KIND,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: input.enabled,
        installed: reachable,
        version: null,
        status: input.enabled ? (reachable ? "ready" : "warning") : "disabled",
        auth: {
          status: reachable ? "authenticated" : "unknown",
          type: "node",
          ...(authLabel ? { label: authLabel } : {}),
        },
        checkedAt: input.checkedAt,
        ...(reachable ? {} : { message: `No members reported by ${input.config.baseUrl}` }),
        models: self ? modelsForMember(self) : [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
    }),
    Effect.catch((error: AtlasClientError) =>
      Effect.succeed({
        instanceId: input.instanceId,
        driver: ATLAS_DRIVER_KIND,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        enabled: input.enabled,
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: input.checkedAt,
        message: error.message,
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider),
    ),
  );
