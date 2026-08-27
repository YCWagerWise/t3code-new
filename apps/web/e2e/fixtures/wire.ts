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
  methodsSeen(): string[] {
    return [
      ...new Set(
        this.frames
          .filter((f) => f.dir === "sent" && f.json?._tag === "Request")
          .map((f) => String(f.json.tag)),
      ),
    ].sort();
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
