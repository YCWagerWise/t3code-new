/**
 * E2E-C — TERMINAL + SHELL (task 3021). All eight methods, real Rust backend.
 *
 *   terminal.open  terminal.attach  terminal.write  terminal.resize
 *   terminal.clear terminal.close   terminal.restart  shell.openInEditor
 *
 * ON THE ONE HARNESS. This file was first written against `@playwright/test`
 * + `apps/web/playwright.config.ts` and RAN GREEN there, 6/6 on woodbine. It is
 * ported here because that rig is the loser of the harness decision
 * (apps/web/e2e/README.md, first line: "There is one harness. This is it.") and
 * a second boot path is the duplicate-authority defect this channel rejects.
 * The assertions are unchanged; only the runner and the fixtures moved.
 *
 * WHY THIS FILE TALKS TO THE SOCKET AND NOT ONLY TO THE GLASS
 *
 * The differentiating claims of this stack's terminal are hearth's, and hearth
 * is two layers below the drawer: ONE persistent PTY per pane (not a respawn per
 * command), a real tty (isatty true), clear that repaints without killing the
 * shell, restart that genuinely replaces it. A spec that only clicked the drawer
 * could not tell "the shell persisted" from "the renderer redrew", so every
 * persistence claim here is made on the wire, where the answer is a pid and an
 * environment variable rather than a screenshot. That is also the suite's own
 * rule — assert the WIRE, not the DOM (#435).
 *
 * The drawer still gets its own test, because "the RPC succeeded and the user
 * saw nothing" is the exact defect this task was filed for.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED HERE, AND WHERE IT LIVES INSTEAD
 *
 * The task lists three more hearth theses: budget expiry interrupting the
 * foreground without killing the shell, a background job being a setsid
 * process-group leader that dies by killpg, and honest head+tail output with an
 * exact hidden-line count and a working re-read handle. None of the three is
 * reachable from t3code-new's RPC surface at all — they live on
 * `hearth::Runner::run` / `run_full` / `read_job`, which the AGENT's run_bash
 * tool calls; `terminal.*` only ever reaches `send_keys`/`resize`/`clear`. They
 * are not gaps, and re-asserting them through a PTY screen would be a worse test
 * of the same thing. hearth owns them and already proves them:
 *
 *   hearth/src/session.rs:1292  budget_interrupts_foreground_not_shell
 *   hearth/src/session.rs:1316  retiring_a_session_kills_the_foreground_process_group
 *   hearth/src/session.rs:1387  budget_interrupt_uses_process_group_when_pty_ctrl_c_is_disabled
 *   hearth/tests/integration.rs:565   background_spawn_kills_process_group_when_pgid_publish_fails
 *   hearth/tests/integration.rs:1851  a_grandchild_that_escapes_the_process_group_cannot_repoison_a_sealed_spill_file
 *   hearth/src/output.rs:357/398      the recovery handle owed for hidden AND denoised lines
 *
 * If one of those regresses it is a hearth finding, per the task text.
 *
 * NO CWD OVERRIDE, deliberately. Every pane below omits `cwd` and takes the
 * backend's own workspace root. The first run of this file on the box passed the
 * two tests that never open a pane and failed all four that do, in ~100ms each:
 * `admit_pane_dir` puts every client-supplied cwd through
 * `vcs::resolve_cwd(p, self.cwd)` (server_main.rs), which ADMITS against the
 * server's root, and the dev-runner's root is not the directory the test process
 * happens to be running in. That refusal is the backend behaving correctly — a
 * pane must not open anywhere a caller names — so the spec should not be
 * asserting from outside it. A real client does not send a cwd it invented
 * either. `cd /tmp` inside the persistence test still proves what it needs to,
 * because it changes directory from wherever the pane legitimately started.
 *
 * NO SKIPS, per the README: nothing here is `test.skip` or `test.todo`. A
 * behaviour that does not work is a FAILING test plus a finding.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStack, openApp, waitFor, type StackHandle, type App } from "../fixtures/index.ts";

/* ------------------------------------------------------------------ *
 * The wire. One `_tag`-tagged JSON text frame per message, matching
 * `dispatch_ws_frame` (backend/src/server_main.rs:1876).
 *
 *   ->  { _tag: "Request", id, tag: <method>, payload }
 *   <-  { _tag: "Exit",  requestId, exit: { _tag: "Success", value } }
 *   <-  { _tag: "Exit",  requestId, exit: { _tag: "Failure", cause: [...] } }
 *   <-  { _tag: "Chunk", requestId, values: [...] }   (streams; no Exit)
 *
 * NOTE the request key is `tag`, not `method`. Sending `method` routes an empty
 * string to the unknown-method arm, which fails complaining the method is
 * unimplemented — a confusing way to learn you typo'd the envelope.
 *
 * This opens its OWN socket rather than reusing `Wire`. Wire records the frames
 * the APP sends; these tests must SEND terminal RPCs the app never dispatches
 * (an orphan target, a both-ids target, a second isolated pane), so they need a
 * client, not a recorder. Both point at the same `stack.serverPort`.
 * ------------------------------------------------------------------ */

interface Frame {
  _tag?: string;
  requestId?: unknown;
  exit?: { _tag?: string; value?: unknown; cause?: unknown };
  values?: unknown[];
}

type Exit = { _tag?: string; value?: any; cause?: unknown };

class Rpc {
  private ws!: WebSocket;
  private nextId = 1;
  /** Every frame ever received, in order. Streams are read off this. */
  readonly frames: Frame[] = [];

  static async connect(port: number): Promise<Rpc> {
    const rpc = new Rpc();
    rpc.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    rpc.ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        rpc.frames.push(JSON.parse(String(ev.data)) as Frame);
      } catch {
        /* a non-JSON frame is not part of this protocol; ignore rather than
           throw inside an event handler, where the rejection is unattributable */
      }
    });
    await new Promise<void>((resolve, reject) => {
      rpc.ws.addEventListener("open", () => resolve());
      rpc.ws.addEventListener("error", () => reject(new Error("ws did not open")));
    });
    return rpc;
  }

  close(): void {
    this.ws.close();
  }

  /** Send a request and return its id, without waiting. Used for streams. */
  send(method: string, payload: unknown): number {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ _tag: "Request", id, tag: method, payload }));
    return id;
  }

  /**
   * Send and wait for the terminal Exit. Returns the whole exit, NOT the value:
   * a caller that asserts on the value alone cannot tell Success(null) from a
   * Failure, and Success(null) is exactly what several of these return.
   */
  async call(method: string, payload: unknown, ms = 30_000): Promise<Exit> {
    const id = this.send(method, payload);
    const frame = await waitFor(
      () => this.frames.find((f) => f._tag === "Exit" && f.requestId === id) ?? null,
      { ms, what: `the Exit frame for ${method}` },
    );
    return (frame.exit ?? {}) as Exit;
  }

  /** Same, but asserts Success and hands back the value. */
  async ok(method: string, payload: unknown, ms = 30_000): Promise<any> {
    const exit = await this.call(method, payload, ms);
    assert.equal(
      exit._tag,
      "Success",
      `${method} must succeed; got ${JSON.stringify(exit).slice(0, 400)}`,
    );
    return exit.value;
  }

  /** Every chunk value delivered so far for one streaming request. */
  chunks(id: number): any[] {
    return this.frames
      .filter((f) => f._tag === "Chunk" && f.requestId === id)
      .flatMap((f) => f.values ?? []);
  }

  /** Wait until a chunk value for `id` satisfies `pred`, then return it. */
  async waitForChunk(
    id: number,
    pred: (v: any) => boolean,
    ms: number,
    what: string,
  ): Promise<any> {
    return await waitFor(() => this.chunks(id).find(pred) ?? null, { ms, what });
  }
}

/**
 * Drive a command through the pane and wait for its output to reach the screen.
 *
 * A PTY is asynchronous by construction: `terminal.write` returns as soon as the
 * bytes are in the pty, long before the shell has run anything. Asserting on the
 * screen immediately after a write is the flakiest thing this file could do.
 * Every command therefore ends in a UNIQUE MARKER and we wait for the marker
 * rather than for a duration.
 *
 * The printf is written SPLIT (`M<n>` + `''` + `K`) so that the echoed COMMAND
 * LINE — which the pty paints back before the shell has run it — cannot satisfy
 * the wait: on screen the command shows `M<n> '' K` with spaces and quotes
 * between the pieces, and only the printf's OUTPUT is the contiguous marker.
 */
async function runAndWait(
  rpc: Rpc,
  target: Record<string, unknown>,
  command: string,
  ms = 60_000,
): Promise<string> {
  const n = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const marker = `M${n}K`;
  await rpc.ok("terminal.write", {
    ...target,
    data: `${command}; printf '%s%s%s\\n' M${n} '' K\n`,
  });
  return await waitFor(
    async () => {
      const snap = await rpc.ok("terminal.open", target);
      const screen = String(snap?.history ?? "");
      return screen.includes(marker) ? screen : null;
    },
    { ms, what: `the pane to finish \`${command}\` (marker ${marker} on screen)` },
    200,
  );
}

let stack: StackHandle;
let app: App;

before(async () => {
  stack = await startStack();
  app = await openApp(stack);
});

after(async () => {
  await app?.close();
  await stack?.dispose();
});

test("all eight methods are implemented, and none of them acks a lie", async () => {
  const rpc = await Rpc.connect(stack.serverPort);
  const target = { threadId: "e2e-c-thread", terminalId: "term-e2e-1" };
  const open = { ...target, cols: 200, rows: 50 };

  /* --- terminal.open -------------------------------------------------- */
  const snap = await rpc.ok("terminal.open", open);
  assert.equal(snap.threadId, "e2e-c-thread", "the snapshot is addressed to the owner that asked");
  assert.equal(snap.terminalId, "term-e2e-1");
  assert.equal(
    typeof snap.history,
    "string",
    "history carries the RENDERED SCREEN — that is what makes this a vt100 pane and not a byte pipe",
  );
  assert.ok(
    ["starting", "running", "exited", "error"].includes(snap.status),
    `status must be one of the contract's four, got ${snap.status}`,
  );
  // `sessionId` is the OTHER half of the union and must be ABSENT for a thread
  // pane, not present-and-null like a struct field.
  assert.equal(snap.sessionId ?? null, null, "a thread pane must not report a sessionId");

  /* --- terminal.write / terminal.resize -------------------------------- */
  assert.equal((await rpc.call("terminal.write", { ...target, data: "\n" }))._tag, "Success");
  assert.equal(
    (await rpc.call("terminal.resize", { ...target, cols: 100, rows: 40 }))._tag,
    "Success",
  );

  /* --- terminal.attach: a STREAM, and it stays open -------------------- */
  const attachId = rpc.send("terminal.attach", open);
  const first = await rpc.waitForChunk(
    attachId,
    (v) => v?.type === "snapshot",
    60_000,
    "attach's opening snapshot event",
  );
  // NOTE THE ASYMMETRY, since it cost this spec a run: the `snapshot` event
  // NESTS its payload (`{type:"snapshot", snapshot:{...}}`, server_main.rs:4313)
  // while `started` / `restarted` / `closed` carry threadId and terminalId at
  // the TOP level. Reading `first.terminalId` yields undefined, not a mismatch.
  assert.equal(first.snapshot?.terminalId, "term-e2e-1");
  assert.equal(
    rpc.frames.some((f) => f._tag === "Exit" && f.requestId === attachId),
    false,
    "attach is a long-lived stream; an Exit means it terminated instead of streaming",
  );

  /* --- the live stream actually carries NEW output --------------------- *
   * This is the half task 2865 (socket-owned request tasks) was blocking:
   * attach was starved because a long-lived handler held the read loop. If this
   * fails while the assertions above pass, the regression is in the TRANSPORT,
   * not in terminal.rs.                                                    */
  const echo = `LIVE${Date.now()}ECHO`;
  await rpc.ok("terminal.write", { ...target, data: `printf '%s\\n' ${echo}\n` });
  const painted = await rpc.waitForChunk(
    attachId,
    (v) => v?.type === "output" && String(v.data ?? "").includes(echo),
    60_000,
    `a live 'output' event carrying ${echo} on the ALREADY-OPEN attach stream`,
  );
  assert.equal(painted.type, "output");

  /* --- terminal.clear: repaints, does NOT kill the shell ---------------- */
  const beforeClear = await rpc.ok("terminal.open", target);
  assert.equal((await rpc.call("terminal.clear", target))._tag, "Success");
  const afterClear = await rpc.ok("terminal.open", target);
  assert.equal(
    afterClear.pid,
    beforeClear.pid,
    "clear repaints the screen; killing the shell would be a different command",
  );

  /* --- terminal.restart: a genuinely NEW shell -------------------------- */
  const restarted = await rpc.ok("terminal.restart", open);
  assert.equal(restarted.terminalId, "term-e2e-1");
  if (beforeClear.pid != null && restarted.pid != null) {
    assert.notEqual(
      restarted.pid,
      beforeClear.pid,
      "restart must REPLACE the shell — the same pid back means it restarted nothing",
    );
  }

  /* --- terminal.close --------------------------------------------------- */
  assert.equal((await rpc.call("terminal.close", target))._tag, "Success");

  /* --- shell.openInEditor: FAILS HONESTLY when the editor is absent ------ *
   * The interesting assertion is not "an editor opened" — no build box has one,
   * and a spec requiring one is a spec that only runs on a laptop. It is that an
   * unopenable editor is REFUSED rather than acked. Success here would let the
   * UI report "opened in Zed" having launched nothing, which is the
   * masking-success defect this backend refuses everywhere else.            */
  const editor = await rpc.call("shell.openInEditor", {
    editor: "definitely-not-an-editor",
  });
  assert.equal(
    editor._tag,
    "Failure",
    "an unknown or absent editor must FAIL, not ack a launch that never happened",
  );
  assert.match(JSON.stringify(editor.cause), /editor|not installed|unknown/i);

  rpc.close();
});

test("the pane is ONE persistent PTY: cd and export survive separate writes", async () => {
  /* hearth's central claim at the t3code-new boundary. A backend that spawned a
   * shell per command would pass every method assertion above and fail this
   * one, which is exactly why it is a separate test. */
  const rpc = await Rpc.connect(stack.serverPort);
  const target = { threadId: "e2e-c-persist", terminalId: "term-persist" };
  const open = { ...target, cols: 200, rows: 50 };

  const pid0 = (await rpc.ok("terminal.open", open)).pid;

  // WRITE ONE: change directory and export a variable.
  await runAndWait(rpc, target, `cd /tmp && export T3_E2E_PERSIST=kept`);

  // WRITE TWO: a completely separate RPC. If the shell were respawned in
  // between, both of these read empty.
  const screen = await runAndWait(
    rpc,
    target,
    `printf 'CWD=[%s] VAR=[%s]' "$(pwd)" "$T3_E2E_PERSIST"`,
  );
  assert.match(
    screen,
    /VAR=\[kept\]/,
    "the exported variable must survive into a LATER terminal.write — one durable PTY per pane is the thesis of the layer",
  );
  assert.match(screen, /CWD=\[\/(private\/)?tmp\]/, "cd must persist across writes too");

  // Same process throughout.
  const later = await rpc.ok("terminal.open", target);
  if (pid0 != null && later.pid != null) {
    assert.equal(later.pid, pid0, "same pane, same shell process");
  }

  // RESTART, then re-read: the variable must be GONE. This is the CONTROL for
  // the assertion above — without it, "VAR=[kept]" is also what you would see if
  // the backend echoed the request back instead of running anything.
  await rpc.ok("terminal.restart", open);
  const afterRestart = await runAndWait(rpc, target, `printf 'VAR=[%s]' "$T3_E2E_PERSIST"`);
  assert.match(
    afterRestart,
    /VAR=\[\]/,
    "restart must give a FRESH environment; a surviving export means restart reattached to the old shell",
  );

  rpc.close();
});

test("the pane is a real tty: isatty() is true inside it", async () => {
  /* An interactive program only runs if the child is on a pty. A backend that
   * piped a subprocess's stdout would satisfy every other test in this file and
   * fail this one. `[ -t 0 ]` is the smallest honest probe. */
  const rpc = await Rpc.connect(stack.serverPort);
  const target = { threadId: "e2e-c-tty", terminalId: "term-tty" };
  await rpc.ok("terminal.open", { ...target, cols: 200, rows: 50 });

  const screen = await runAndWait(
    rpc,
    target,
    `if [ -t 0 ] && [ -t 1 ]; then printf 'TTY=[yes]'; else printf 'TTY=[no]'; fi`,
  );
  assert.match(
    screen,
    /TTY=\[yes\]/,
    "stdin and stdout must both be a tty — an interactive program cannot run otherwise",
  );

  // resize must reach the CHILD's winsize, not just the server's bookkeeping.
  await rpc.ok("terminal.resize", { ...target, cols: 111, rows: 37 });
  const size = await runAndWait(rpc, target, `printf 'COLS=[%s]' "$(tput cols 2>/dev/null)"`);
  assert.match(
    size,
    /COLS=\[111\]/,
    "resize must reach the child's window size; updating only the snapshot leaves every full-screen program drawing at the wrong width",
  );

  rpc.close();
});

test("TerminalTargetInput stays a union: neither-id and both-ids are refused", async () => {
  /* contracts/src/terminal.ts:72 forbids the other id in each variant with
   * Schema.optional(Schema.Never), so that the ambiguity is "resolved at the
   * type level instead of by a precedence rule every caller has to remember",
   * and terminal.test.ts:334 asserts a both-ids target is REJECTED. The backend
   * has to agree: a backend MORE permissive than the wire schema silently picks
   * which pane the caller gets, which is #149's ownership boundary reached from
   * the other direction. This test is what caught that divergence. */
  const rpc = await Rpc.connect(stack.serverPort);

  const orphan = await rpc.call("terminal.open", {
    terminalId: "term-orphan",
  });
  assert.equal(
    orphan._tag,
    "Failure",
    "a terminal target naming NEITHER threadId nor sessionId must be refused",
  );
  assert.match(JSON.stringify(orphan.cause), /sessionId|threadId/i);

  const both = await rpc.call("terminal.open", {
    threadId: "e2e-c-union",
    sessionId: "s-e2e-c-union",
    terminalId: "term-both",
  });
  assert.equal(
    both._tag,
    "Failure",
    "naming BOTH ids is the other half of the union violation and must also be refused",
  );

  rpc.close();
});

test("panes are independent: writing to one does not reach the other", async () => {
  const rpc = await Rpc.connect(stack.serverPort);
  const a = { threadId: "e2e-c-iso", terminalId: "term-a" };
  const b = { threadId: "e2e-c-iso", terminalId: "term-b" };
  await rpc.ok("terminal.open", { ...a, cols: 200, rows: 50 });
  await rpc.ok("terminal.open", { ...b, cols: 200, rows: 50 });

  await runAndWait(rpc, a, `export T3_ONLY_IN_A=1`);
  const inB = await runAndWait(rpc, b, `printf 'A=[%s]' "$T3_ONLY_IN_A"`);
  assert.match(
    inB,
    /A=\[\]/,
    "each pane is its own hearth runner; a variable leaking between them means the registry collapsed two panes onto one shell",
  );

  // Closing one must not disturb the other.
  await rpc.ok("terminal.close", a);
  const stillB = await rpc.ok("terminal.open", b);
  assert.equal(stillB.terminalId, "term-b");
  assert.ok(
    ["starting", "running"].includes(stillB.status),
    `closing pane A left pane B in ${stillB.status}`,
  );

  rpc.close();
});

test("the drawer actually renders when the terminal toggle is pressed", async () => {
  /* THE DEFECT THIS TASK WAS FILED FOR: the toggle sends terminal.open, gets
   * Success, no RPC failure — and no drawer appears. The backend half is proven
   * by every test above, so a failure HERE is apps/web/src/terminal (the Canvas
   * / ghostty-vt WASM adapter, docs/architecture/terminal-renderers.md) or
   * ChatView's render gate, and NOT backend/src/terminal.rs. Say which in the
   * finding; they are different layers with different owners. */
  const page = app.page;

  const toggle = page.getByRole("button", { name: "Toggle terminal drawer" });
  await waitFor(
    async () => ((await toggle.count()) > 0 ? true : null),
    {
      ms: 60_000,
      what:
        "the terminal toggle to exist — PanelLayoutControls renders it whenever " +
        "showTerminalControl is set (apps/web/src/components/chat/PanelLayoutControls.tsx:47)",
    },
  );

  // Asserting ENABLED before clicking separates two different bugs: the toggle
  // is gated on `terminalAvailable={activeProject !== null}` (ChatView.tsx:6458),
  // so a disabled toggle means the app never resolved a project — which is NOT
  // the drawer failing to render, and must not be reported as it.
  await waitFor(
    async () => ((await toggle.first().isEnabled()) ? true : null),
    {
      ms: 60_000,
      what:
        "the terminal toggle to become ENABLED (activeProject !== null). Still disabled " +
        "means no project resolved — a different defect from the drawer not rendering",
    },
  );

  await toggle.first().click();

  // The store flips `terminalOpen` via `ensureTerminal(..., {open:true})`
  // (terminalUiStateStore.ts:658), and PersistentThreadTerminalDrawer returns
  // null unless project && terminalOpen && cwd (ChatView.tsx:1017). Checking
  // aria-pressed FIRST separates "the state never flipped" from "the state
  // flipped and nothing painted" — again two owners.
  await waitFor(
    async () => ((await toggle.first().getAttribute("aria-pressed")) === "true" ? true : null),
    {
      ms: 60_000,
      what:
        "aria-pressed=true on the toggle: terminalOpen is what the render gate reads, so if " +
        "this never flips the bug is in toggleTerminalVisibility (ChatView.tsx:2938), which " +
        "returns early on the first-open path",
    },
  );

  // THE DRAWER ITSELF, not a state flag. `[data-terminal-open]` lives on the
  // composer context strip (ChatView.tsx:6902) and merely MIRRORS the store, so
  // asserting on it goes green while nothing painted — the exact false positive
  // this task exists to avoid. The drawer's own root is the <aside> at
  // ThreadTerminalDrawer.tsx:1421, and data-terminal-owner="drawer"
  // distinguishes it from the same component rendered into the right panel.
  const drawer = page.locator('aside[data-terminal-owner="drawer"]');
  await waitFor(
    async () => ((await drawer.count()) > 0 && (await drawer.first().isVisible()) ? true : null),
    {
      ms: 60_000,
      what:
        "the drawer <aside> to be visible once terminalOpen is true. If aria-pressed is true " +
        "and this times out, the store flipped and the drawer did not render: ChatView's " +
        "render gate (project/cwd null at :1017) or apps/web/src/terminal — NOT terminal.rs",
    },
  );

  // Mounted is not painted. A drawer that mounts with a dead ghostty-vt WASM
  // renderer has no canvas, and a mount-only assertion cannot tell that from a
  // working pane — a distinct failure mode named in
  // docs/architecture/terminal-renderers.md.
  await waitFor(
    async () => ((await drawer.locator("canvas").count()) > 0 ? true : null),
    {
      ms: 60_000,
      what:
        "a <canvas> inside the drawer — the pane's rendering surface. A mounted drawer with " +
        "no canvas is the WASM renderer failing to boot, a different defect from not mounting",
    },
  );
});
