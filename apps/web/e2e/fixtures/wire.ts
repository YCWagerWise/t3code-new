/**
 * ASSERT THE WIRE, NOT THE DOM (#435).
 *
 * The two false PASSes that produced #435 are the whole reason this file
 * exists: `'51'` matched the live "Working for 51s" timer, and a prompt token
 * matched the user's OWN prompt echoed back in the user bubble. Both reported
 * green while the turn was hung. `innerText` cannot distinguish
 *   - assistant output from the echo of the prompt that asked for it,
 *   - a spinner that settled from a spinner that stopped because the socket died.
 * The websocket frame can. So the frame is the assertion and the DOM is only
 * ever used to DRIVE the app, never to prove what it did.
 *
 * The protocol, read off backend/src/server_main.rs rather than assumed:
 *   sent      {_tag:"Request", id, tag:"<method>", payload}
 *   streaming {_tag:"Chunk", clientId, requestId, values:[...]}   (:58, :1600)
 *   ok        {_tag:"Exit", requestId, exit:{_tag:"Success", value}}   (:1862)
 *   declared  {_tag:"Exit", requestId, exit:{_tag:"Failure",
 *                cause:[{_tag:"Fail",  error}]}}                  (:1888)
 *   defect    {_tag:"Exit", requestId, exit:{_tag:"Failure",
 *                cause:[{_tag:"Die",   defect}]}}                 (:1872)
 *
 * That Die/Fail split is load-bearing and specs must not flatten it. `Fail`
 * carries a DECLARED error from the RPC's own error channel — a backend
 * correctly refusing. `Die` is an unrecoverable defect, and the backend uses it
 * deliberately for an UNIMPLEMENTED method so it cannot masquerade as
 * `Success(null)` (server_main.rs:1865-1868). An e2e that treats every Failure
 * the same reports "implemented" for a method that answered `Die: unimplemented`.
 */
import { waitFor, type Deadline } from "./stack.ts";

export type Frame = { readonly dir: "sent" | "recv"; readonly at: number; readonly json: any };

export type RpcOutcome =
  | { readonly kind: "success"; readonly value: unknown; readonly chunks: unknown[] }
  | { readonly kind: "fail"; readonly error: any; readonly chunks: unknown[] }
  | { readonly kind: "die"; readonly defect: string; readonly chunks: unknown[] };

/** A minimal shape of the playwright Page we actually use, so this file does not
 *  drag a type dependency in for two event names. */
type PageLike = {
  on(event: "websocket", handler: (ws: WebSocketLike) => void): void;
  on(event: "console", handler: (message: ConsoleLike) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
};
type WebSocketLike = {
  on(event: "framesent" | "framereceived", handler: (frame: { payload: string | Buffer }) => void): void;
};
type ConsoleLike = { type(): string; text(): string };

export class Wire {
  readonly frames: Frame[] = [];
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  static attach(page: PageLike): Wire {
    const wire = new Wire();
    page.on("websocket", (ws) => {
      ws.on("framesent", (f) => wire.#record("sent", f.payload));
      ws.on("framereceived", (f) => wire.#record("recv", f.payload));
    });
    // Console state is read EVERY round, not as decoration: a React error or a
    // rejected frame shows up here long before it becomes a visible symptom,
    // and "the console was clean" is itself worth asserting.
    page.on("console", (message) => {
      if (message.type() === "error") wire.consoleErrors.push(message.text().slice(0, 400));
    });
    page.on("pageerror", (error) => wire.pageErrors.push(String(error).slice(0, 400)));
    return wire;
  }

  #record(dir: "sent" | "recv", payload: string | Buffer): void {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON frames are real traffic (ping/pong keepalives). Keep the raw
      // text so a failure message can show it; do not silently drop it.
      json = { _tag: "NonJson", raw: text.slice(0, 200) };
    }
    this.frames.push({ dir, at: Date.now(), json });
  }

  /** Request ids this page issued for `method`, oldest first. */
  requestIds(method: string): unknown[] {
    return this.frames
      .filter((f) => f.dir === "sent" && f.json?._tag === "Request" && f.json?.tag === method)
      .map((f) => f.json.id);
  }

  /** Did the client ever ask for this method at all? Distinguishes "the backend
   *  refused" from "the UI never dispatched it", which look identical downstream. */
  wasRequested(method: string): boolean {
    return this.requestIds(method).length > 0;
  }

  chunksFor(requestId: unknown): unknown[] {
    const key = JSON.stringify(requestId);
    return this.frames
      .filter(
        (f) =>
          f.dir === "recv" &&
          f.json?._tag === "Chunk" &&
          JSON.stringify(f.json?.requestId) === key,
      )
      .flatMap((f) => (Array.isArray(f.json.values) ? f.json.values : []));
  }

  /** The terminal outcome of one request id, or null if it has not landed yet. */
  outcomeOf(requestId: unknown): RpcOutcome | null {
    const key = JSON.stringify(requestId);
    const exit = this.frames.find(
      (f) =>
        f.dir === "recv" && f.json?._tag === "Exit" && JSON.stringify(f.json?.requestId) === key,
    );
    if (!exit) return null;
    const chunks = this.chunksFor(requestId);
    const e = exit.json.exit;
    if (e?._tag === "Success") return { kind: "success", value: e.value, chunks };
    const cause = Array.isArray(e?.cause) ? e.cause[0] : undefined;
    if (cause?._tag === "Die") {
      return { kind: "die", defect: String(cause.defect ?? "").slice(0, 400), chunks };
    }
    return { kind: "fail", error: cause?.error ?? cause, chunks };
  }

  /** Wait for the LAST request of `method` to land, and return how it landed. */
  async settle(method: string, deadline?: Partial<Deadline>): Promise<RpcOutcome> {
    return await waitFor(
      () => {
        const ids = this.requestIds(method);
        if (ids.length === 0) return null;
        return this.outcomeOf(ids[ids.length - 1]);
      },
      {
        ms: deadline?.ms ?? 30_000,
        what: deadline?.what ?? `an Exit frame for ${method} (requested: ${this.wasRequested(method)})`,
      },
    );
  }

  /** Every distinct method this page dispatched. The COVERAGE NUMERATOR — a
   *  spec reports what it actually drove, not what it meant to drive. */
  /**
   * COMPLETED assistant replies, off the wire (#435).
   *
   * The only honest way to read what the agent said. The DOM cannot answer this
   * question: the UI echoes the user's own prompt into the user bubble and
   * renders a live `Working for Ns` string, so `innerText` matching finds the
   * wrong thing and reports a PASS. Two false passes were written and filed
   * before that was caught — asserting "51" for "what is 17 times 3" matched
   * "Working for 51s", and asserting a nonsense token matched the PROMPT that
   * contained it, both while the turn was still Thinking and the socket was
   * mid-reconnect.
   *
   * This existed only as a snippet in the finding and as a prose rule in the
   * e2e README, which meant every spec hand-rolled the frame parsing and could
   * hand-roll it wrong. It is a method now.
   *
   * `streaming === false` is the whole point: a partial chunk is not a reply,
   * and asserting on one races the rest of the sentence.
   */
  assistantReplies(): string[] {
    const out: string[] = [];
    for (const f of this.frames) {
      if (f.dir !== "recv" || f.json?._tag !== "Chunk") continue;
      for (const v of f.json?.values ?? []) {
        const p = v?.event?.payload;
        if (p?.role === "assistant" && p?.streaming === false && typeof p?.text === "string") {
          out.push(p.text);
        }
      }
    }
    return out;
  }

  /**
   * Whether the turn SETTLED, as opposed to the spinner merely stopping (#435).
   *
   * A spinner that stopped because the socket died is DOM-identical to one that
   * settled, so settlement is a wire fact: `session-set` to `running` WITH an
   * `activeTurnId`, then `session-set` to `idle` WITH `activeTurnId: null`.
   * Both halves are required — an idle with a live turn id is the #92/#210
   * state that hydrates a spinner with no way out.
   */
  turnSettled(): boolean {
    let ranWithTurn = false;
    for (const f of this.frames) {
      if (f.dir !== "recv" || f.json?._tag !== "Chunk") continue;
      for (const v of f.json?.values ?? []) {
        const kind = v?.kind ?? v?.event?.kind;
        if (kind !== "session-set" && v?.event?.payload?.status === undefined) continue;
        const p = v?.session ?? v?.event?.payload ?? v;
        if (p?.status === "running" && p?.activeTurnId) ranWithTurn = true;
        if (ranWithTurn && p?.status === "idle" && p?.activeTurnId === null) return true;
      }
    }
    return false;
  }

  methodsSeen(): string[] {
    return [
      ...new Set(
        this.frames
          .filter((f) => f.dir === "sent" && f.json?._tag === "Request")
          .map((f) => String(f.json.tag)),
      ),
    ].sort();
  }

  /**
   * THE ORDERING ASSERTION. Use this, not a timeout, for anything about
   * concurrency.
   *
   * Every outcome-with-a-generous-timeout spec on this bench would go GREEN on
   * a socket that is head-of-line blocked, because with a long enough budget
   * the reply DOES arrive — measured at 33.89s on a live backend, with three
   * requests sent 30 seconds apart all answered in the same millisecond. One of
   * them (`q1`) failed pure argument validation: no I/O, no worktree, no
   * provider, nothing to wait for. It waited 3.2s behind an unrelated handler
   * anyway. A 60s timeout calls that a pass.
   *
   * The property that catches it has no milliseconds in it at all:
   *
   *   1. issue a request known to be slow, and DO NOT await it;
   *   2. issue a trivial one — one that fails argument validation is ideal,
   *      because it cannot be slow for any legitimate reason;
   *   3. assert the trivial one's Exit arrives FIRST.
   *
   * Serialized, that is impossible. Concurrent, it is guaranteed. So it cannot
   * flake on a box at load average 400, which is the state this laptop is
   * actually in — and it means the spec fails for the right reason on a fast
   * machine and a wrecked one alike.
   *
   * Returns the two Exit timestamps and the verdict, so a failure message can
   * quote the real gap rather than assert a bare boolean.
   */
  async answeredFirst(
    trivial: { readonly method: string; readonly requestId: unknown },
    slow: { readonly method: string; readonly requestId: unknown },
    deadline?: Partial<Deadline>,
  ): Promise<{ readonly ok: boolean; readonly detail: string }> {
    const exitAt = (requestId: unknown): number | null => {
      const key = JSON.stringify(requestId);
      const frame = this.frames.find(
        (f) =>
          f.dir === "recv" &&
          f.json?._tag === "Exit" &&
          JSON.stringify(f.json?.requestId) === key,
      );
      return frame ? frame.at : null;
    };

    await waitFor(() => exitAt(trivial.requestId), {
      ms: deadline?.ms ?? 60_000,
      what:
        deadline?.what ??
        `an Exit for the trivial request ${trivial.method}. If this times out the ` +
          `socket is not merely slow, it is not reading at all.`,
    });

    const fast = exitAt(trivial.requestId)!;
    const blocked = exitAt(slow.requestId);
    if (blocked === null) {
      return {
        ok: true,
        detail:
          `${trivial.method} answered while ${slow.method} was still in flight — ` +
          `the socket kept reading. This is the pass.`,
      };
    }
    const gap = fast - blocked;
    return {
      ok: fast < blocked,
      detail:
        fast < blocked
          ? `${trivial.method} answered ${-gap}ms BEFORE ${slow.method}. Concurrent.`
          : `${trivial.method} answered ${gap}ms AFTER ${slow.method}, and both landed ` +
            `after ${slow.method} finished. That is head-of-line blocking: the trivial ` +
            `request waited on a handler it has nothing to do with. Do NOT report this ` +
            `as slowness — the fix is that the read loop must not await dispatch inline.` +
            `\ntranscript:\n${this.transcript(20)}`,
    };
  }

  /**
   * Every thread event this page received, newest last, as
   * `{type, payload, occurredAt, sequence, at}` where `at` is the wall-clock
   * millisecond THIS BROWSER saw the frame.
   *
   * Thread events arrive nested — `Chunk -> values[] -> {kind:"event", event:{...}}`
   * (agent-sdk-shell/src/thread.rs:794-807) — and a reader that forgets the
   * nesting silently sees nothing rather than failing, which is the quietest
   * possible way for a spec to pass over an empty set.
   */
  threadEvents(): Array<{
    readonly type: string;
    readonly payload: any;
    readonly occurredAt: string | null;
    readonly sequence: number | null;
    readonly at: number;
  }> {
    const out: Array<any> = [];
    for (const frame of this.frames) {
      if (frame.dir !== "recv" || frame.json?._tag !== "Chunk") continue;
      const values = Array.isArray(frame.json.values) ? frame.json.values : [];
      for (const value of values) {
        const event = value?.event ?? (value?.type ? value : null);
        if (!event?.type) continue;
        out.push({
          type: String(event.type),
          payload: event.payload ?? {},
          occurredAt: typeof event.occurredAt === "string" ? event.occurredAt : null,
          sequence: typeof event.sequence === "number" ? event.sequence : null,
          at: frame.at,
        });
      }
    }
    return out;
  }

  /**
   * HOW LATE WAS THIS EVENT? Milliseconds between the timestamp the SERVER
   * stamped on the event and the moment this browser received the frame.
   *
   * MEASURE SETTLEMENT AGAINST THE EVENT'S OWN CLOCK, NEVER AGAINST WALL-CLOCK
   * PATIENCE. A turn was measured starting and failing 88ms apart — `updatedAt`
   * 48.499 and 48.587 in its own two payloads — while the settling
   * `thread.session-set idle` did not reach the client until 25.00s, because the
   * tail parked, was never woken by the publication, and returned on its own
   * `Duration::from_secs(25)` timeout (server_main.rs:1658). The UI spun for
   * twenty-five seconds on a turn that finished in a tenth of a second.
   *
   * A spec asserting "the spinner eventually stops" PASSES that. A spec
   * asserting "the spinner stopped within 2s of the turn's own updatedAt"
   * catches it, and needs no magic threshold, because the payload carries the
   * server's timestamp and the lag can simply be computed.
   *
   * This is also what retires the "is it slow, or is it hung" argument: it is
   * neither — it is a timer, and a delivery lag that keeps landing on a round
   * number equal to a timeout constant is the signature. Report a lag that
   * matches a timeout as a LOST WAKE-UP, not as latency.
   */
  deliveryLagMs(event: { readonly payload: any; readonly occurredAt: string | null; readonly at: number }): number | null {
    // `updatedAt` on the payload is the fact the event is ABOUT; `occurredAt` is
    // when the event was recorded. Prefer the former — it is the one that shows
    // a turn having already finished long before anyone was told.
    const stamped = event.payload?.updatedAt ?? event.occurredAt;
    if (typeof stamped !== "string") return null;
    const t = Date.parse(stamped);
    return Number.isNaN(t) ? null : event.at - t;
  }

  /** A short, quotable transcript for a failure message or an evidence blob. */
  transcript(limit = 40): string {
    return this.frames
      .slice(-limit)
      .map((f) => {
        const j = f.json;
        if (j?._tag === "Request") return `-> Request ${j.tag} id=${JSON.stringify(j.id)}`;
        if (j?._tag === "Exit") {
          const e = j.exit;
          const how =
            e?._tag === "Success"
              ? "Success"
              : `Failure/${Array.isArray(e?.cause) ? e.cause[0]?._tag : "?"}`;
          return `<- Exit id=${JSON.stringify(j.requestId)} ${how}`;
        }
        if (j?._tag === "Chunk") {
          return `<- Chunk id=${JSON.stringify(j.requestId)} n=${Array.isArray(j.values) ? j.values.length : 0}`;
        }
        return `${f.dir === "sent" ? "->" : "<-"} ${j?._tag ?? "?"}`;
      })
      .join("\n");
  }
}
