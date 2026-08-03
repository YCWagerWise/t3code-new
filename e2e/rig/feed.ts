/**
 * Direct reads of the node's authoritative surfaces, used to check that what
 * the browser SHOWED is what the node actually DID. The feed is the wire
 * truth; the workspace is the disk truth; specs assert all three agree.
 */
import { DEV_TOKEN, NODE_BASE } from "./rig.ts";

export interface FeedFrame {
  kind: string;
  seq: number;
  payload?: Record<string, unknown>;
}

/** The console routes key a UI thread's feed by `thr-<threadId>` (session.ts). */
export const runIdForThread = (threadId: string): string => `thr-${threadId}`;

/** Full frame replay for a thread — `GET /console/v1/threads/{id}/feed?after=0`. */
export const replayFeed = async (threadId: string): Promise<FeedFrame[]> => {
  const frames: FeedFrame[] = [];
  let after = 0;
  for (;;) {
    const response = await fetch(
      `${NODE_BASE}/console/v1/threads/${encodeURIComponent(threadId)}/feed?after=${after}`,
      { headers: { authorization: `Bearer ${DEV_TOKEN}` } },
    );
    if (!response.ok) {
      throw new Error(`feed replay for ${threadId} failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      frames?: FeedFrame[];
      has_more?: boolean;
      head?: number;
    };
    const page = body.frames ?? [];
    frames.push(...page);
    if (page.length === 0 || !body.has_more) return frames;
    after = Number(page[page.length - 1]!.seq);
  }
};
