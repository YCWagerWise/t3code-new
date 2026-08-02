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
  type AtlasFeedReadinessInput,
  type AtlasMember,
  atlasFeedReadiness,
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

/**
 * `supportsTools` survives the mapping.
 *
 * It used to be consumed as a sort key and then dropped on the floor here, which
 * left a tool-less model indistinguishable from a tool-capable one on screen: the
 * node knows the answer (it probes each model), the picker offered it anyway, and
 * the user found out a turn later when the model narrated a tool call it never
 * made. Atlas warns at drive time; carrying the flag prevents the pick instead.
 */
const toServerProviderModel = (option: AtlasModelOption): ServerProviderModel => ({
  slug: option.id,
  name: option.label,
  shortName: option.label.split(":")[0] ?? option.label,
  subProvider: option.source,
  isCustom: false,
  capabilities: option.supportsTools === undefined ? null : { supportsTools: option.supportsTools },
});

/** Tool-capable first, unprobed next, known tool-less last. Unknown is not "no". */
const toolRank = (supportsTools: boolean | undefined): number =>
  supportsTools === true ? 0 : supportsTools === undefined ? 1 : 2;

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
    if (toolRank(a.supportsTools) !== toolRank(b.supportsTools)) {
      return toolRank(a.supportsTools) - toolRank(b.supportsTools);
    }
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
  /** Test seam for the authenticated execution-boundary probe. */
  readonly feedReadiness?: (
    input: AtlasFeedReadinessInput,
  ) => Effect.Effect<void, AtlasClientError>;
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
): Effect.Effect<ServerProvider, never, HttpClient.HttpClient> => {
  const base = {
    instanceId: input.instanceId,
    driver: ATLAS_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled,
    version: null,
    checkedAt: input.checkedAt,
    slashCommands: [],
    skills: [],
  } as const;

  // A disabled provider must be inert: do not keep probing a node the user
  // deliberately turned off. A missing feed credential is likewise a local
  // configuration outcome, not a misleading successful discovery request.
  if (!input.enabled) {
    return Effect.succeed({
      ...base,
      installed: false,
      status: "disabled",
      auth: { status: "unknown" },
      models: [],
    } satisfies ServerProvider);
  }
  if (input.config.wsToken.trim() === "") {
    return Effect.succeed({
      ...base,
      installed: false,
      status: "error",
      auth: { status: "unauthenticated", type: "node" },
      message: "Atlas feed token is required before this node can run turns.",
      models: [],
    } satisfies ServerProvider);
  }

  const readiness = input.feedReadiness ?? atlasFeedReadiness;
  return readiness({
    baseUrl: input.config.baseUrl,
    plugin: input.config.plugin,
    token: input.config.wsToken,
  }).pipe(
    Effect.andThen(atlasMembers(input.config.baseUrl)),
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
        ...base,
        installed: reachable,
        status: reachable ? "ready" : "warning",
        auth: {
          status: reachable ? "authenticated" : "unknown",
          type: "node",
          ...(authLabel ? { label: authLabel } : {}),
        },
        ...(reachable ? {} : { message: `No members reported by ${input.config.baseUrl}` }),
        models: self ? modelsForMember(self) : [],
      } satisfies ServerProvider;
    }),
    Effect.catch((error: AtlasClientError) =>
      Effect.succeed({
        ...base,
        installed: false,
        status: "error",
        auth: { status: "unauthenticated", type: "node" },
        message: error.message,
        models: [],
      } satisfies ServerProvider),
    ),
  );
};
