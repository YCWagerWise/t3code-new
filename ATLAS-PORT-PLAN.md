# Atlas Terminal × T3 Code — port plan

Fork: `~/atlas/git-forks/t3code` @ `5719e8a` (2026-07-24), MIT, upstream `pingdotgg/t3code`.
Upstream is not accepting contributions → this is fork-and-diverge, not contribute-back.

## Goal

T3 Code is the chassis (web GUI, project model, remote environments). Atlas is the heart
(LLM provider + fleet). Warden's terminal wins get ported in. Warden becomes `atlas-terminal`.

Not: a Rust rewrite of T3 on day one. See "Rust path" below for why that's staged.

## Oracle (definition of DONE, chased in this order)

1. `pnpm typecheck` clean in the fork — errors are the work queue.
2. Atlas appears as a selectable provider in the UI; `providers.startSession` returns a session.
3. A real turn round-trips: prompt → Atlas → streamed tokens rendered in the browser.
4. Provider adapter tests pass alongside the existing Codex/Grok ones.

Oracle 3 is the honest one. 1 and 2 can be green while the thing does nothing.

## CORRECTION (2026-07-25): T3 Code is lens #3, not warden's replacement

Per `~/atlas/atlas-rs/docs/ATLAS-ARCHITECTURE.md` (verified against the code this session:
`/run` `/start` `/output` `/transcript` `/_members` all present in `crates/`, capability
manifests in `gossip.rs` + `probe.rs`).

Atlas + deployments are the **BODY**. A view is a **LENS**, and a lens holds NO logic.
Telegram is lens #1. warden is lens #2. **T3 Code is lens #3 — Telegram with a much better screen.**

One lens addresses N bodies:

```
T3 Code → coder       = a coding GUI
T3 Code → k8s-agent   = a cluster-ops console
T3 Code → fliff-agent = a betting desk
T3 Code → the fleet   = a workforce console
```

**Therefore the ACP seam terminates at the Atlas Agent DO, NOT at warden.** An earlier draft of
this plan said "T3 → warden over ACP" — that is lens→lens and violates the layer rule. The
AtlasAdapter talks to the same body Telegram and warden already address.

### Placement table — Telegram test applied

"Could a pure window do this?" No → body. Yes → lens.

| Capability                                                 | Today                                  | Belongs                                             | Why                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Project/thread tiers, sidebar, ⌘K search, settings         | T3                                     | **LENS (T3)**                                       | Pure render/navigate                                                                                   |
| Workspace tier, sub-chat nesting                           | nowhere                                | **LENS (T3)**                                       | Organizational view over body-owned threads                                                            |
| Provider auth/health screen                                | T3, probes **local CLIs only**         | **BODY** (`atlas-tools/probe.rs`, gossip manifests) | "Which providers exist on which node" is _knowledge about a node_. Should list the fleet, not this Mac |
| `--nodes` / `--on` / `--fan`                               | warden CLI one-shots                   | **BODY** (already: gossip ring + Agent DO)          | Telegram could trivially do "run on all nodes"                                                         |
| `coord.rs` (1111), `subagent.rs` (941), `mailbox.rs` (316) | **warden**                             | **BODY (atlas-rs)**                                 | Fleet capability in a lens — the exact misread the doc names                                           |
| `watchdog.rs` (751)                                        | **warden** AND `crates/atlas-watchdog` | **BODY** — delete warden's copy                     | Forked capability; violates rule #4 "one canonical home"                                               |
| `--remember` / `--recall`                                  | warden CLI flags                       | **BODY**                                            | Telegram should recall too. Capability in a lens                                                       |
| Git worktree per thread (`branch`, `worktreePath`)         | T3 contracts                           | **BODY** executes, **LENS** renders                 | Execution on a node                                                                                    |
| `/model`, `/mode`                                          | warden                                 | **LENS**                                            | Doc: a lens "drives its own model backend"                                                             |
| `/diff`, `/pr`, `/plan`                                    | warden                                 | **BODY**                                            | Real work on a repo                                                                                    |

Net: warden shrinks. Most of what makes it feel powerful is misplaced body capability that
every lens should inherit. Porting it "into T3" would repeat the original mistake one layer over.

### Blocked on

`atlas-rs` is on branch `feat/lesson-efficacy-rigor`, diverged from `origin/main`
(`c4bd52c` vs `982bf3b`), with uncommitted edits to `crates/atlas-host/Cargo.toml` and
`crates/atlas-host/src/lib.rs` — the `full_system_prompt` seam. Discipline rule #2: do not
edit on a stale base. Resolve before any substrate work.

## P1 CORRECTION (2026-07-25): no ACP — direct HTTP

Evidence, gathered before writing code:

- `apps/server/src/provider/acp/AcpSessionRuntime.ts` **hard-requires a spawned child process**:
  `readonly spawn: AcpSpawnInput` (:61), `ChildProcessSpawner` (:274),
  `spawner.spawn(ChildProcess.make(...))` (:337). The transport is not pluggable.
- Atlas is HTTP. `crates/atlas-host/src/lib.rs` handles `/start` (:839), `/run` (:888),
  `/output` (:1039), `/transcript` (:1089).
- Going through ACP would mean spawning a local proxy process purely to relay into Atlas HTTP —
  a shim over the real seam. Forbidden by "substrates over shims."

**Verified live seam** (macbook node, `127.0.0.1:3010`):

```
POST /Agent/{run_id}/run   {"task": "...", "plugin": "coder"}
→ 200, plain-text answer inline, 12.4s
```

`/run` is documented in-source as "rpc-style one-shot: seed, DRIVE THE RUN TO COMPLETION INLINE,
and RETURN the answer in this one call — no caller poll."

**`plugin` is the one-lens-N-bodies switch.** `coder` → coding GUI, `k8s-agent` → cluster console,
`fliff-agent` → betting desk. Same driver, different body.

So P1 is not "teach Atlas ACP." P1 is: `AtlasDriver` speaks HTTP to the Agent DO directly.
`effect-acp` and `AcpSessionRuntime` stay in the tree for Cursor/Grok but Atlas does not use them.

## The finding that sets the approach: ACP

T3's provider layer is a clean 13-method interface — `ProviderAdapterShape` in
`apps/server/src/provider/Services/ProviderAdapter.ts`: startSession, sendTurn, interruptTurn,
respondToRequest, respondToUserInput, stopSession, listSessions, hasSession, readThread,
rollbackThread, stopAll, streamEvents, capabilities.

Five providers ship today (docs claim one — docs are stale, code is truth):
Codex, Claude, Cursor, Grok, OpenCode.

`ProviderDriverKind` is a **branded slug**, not an enum (`packages/contracts/src/providerInstance.ts:70`).
`ProviderDriverKind.make("atlas")` is the entire contract change. No schema surgery.

Cost comparison, measured:

| Path           | Files                                                               | Lines                              |
| -------------- | ------------------------------------------------------------------- | ---------------------------------- |
| **ACP** (Grok) | `GrokAdapter.ts` 16 + `GrokDriver.ts` 164 + `GrokAcpSupport.ts` 108 | **288**                            |
| Native (Codex) | `CodexAdapter.ts` 19 + `CodexDriver.ts` 214                         | 233 + bespoke JSON-RPC schema work |

`apps/server/src/provider/acp/AcpSessionRuntime.ts` (1005 lines) is the shared engine both
Cursor and Grok ride on. Take the ACP path and you inherit it free.

**Decision: Atlas speaks ACP over stdio.** Warden already runs a JSON-RPC-over-stdio server
(`--mcp`, `--mcp-tools`, `src/mcp_server.rs`). ACP is JSON-RPC over stdio with a different
schema. Same plumbing, new message set — a substrate change, not a shim.

## Phases (each ends deployable)

**P0 — Rename warden → atlas-terminal.** Mechanical, but the blast radius is live:
1,188 files mention `warden`; most are inert transcripts, but these are load-bearing —
`~/.claude/CLAUDE.md`, the `/remember` and `/recall` skills, `atlas/warden-launch.sh`.
The binary path is hardcoded in all of them. Renaming it blind **breaks fleet memory recall**.
Sequence: rename crate + binary → symlink old path → migrate live refs → verify `--recall`
returns hits → drop symlink last.

**P1 — ACP server in atlas-terminal.** Add `--acp` to the Rust binary. Reuse the stdio
transport from `mcp_server.rs`. Oracle: T3's own `AcpJsonRpcConnection.test.ts` harness
plus `effect-acp`'s `protocol.test.ts` as the conformance check — their tests, unchanged,
are the spec.

**P2 — AtlasAdapter in T3.** ~290 lines against the Grok template. Register in
`ProviderAdapterRegistry.ts`. Oracle 1→3 above.

**P3 — Port the terminal wins.** Warden has fleet machinery T3 has no equivalent for:
`coord.rs` 1111, `subagent.rs` 941, `watchdog.rs` 751, `mailbox.rs` 316, plus `--nodes`,
`--on <box>`, `--fan`. T3 has the surface (environments, relay, ssh, tailscale) with a
thinner engine; Atlas has the engine with no surface. **This gap is the product.**
NOT YET INVENTORIED — P3 scope is unknown until warden's TUI is read properly.

## Rust path — staged, not big-bang

T3's server is Node (~1,965 TS files). A Rust rewrite is real but must be faithful-first and
never leave a window where nothing runs:

- Atlas-terminal already _is_ the Rust engine. P1/P2 make it the brain behind T3's Node server.
- Rewrite the server only after the ACP boundary is proven — that boundary is exactly the seam
  a rewrite needs, because it lets Rust replace Node one service at a time with the existing
  TS test suite as the unchanged oracle.
- Do not start the rewrite before P2 is green. There is no oracle before then.

## Risks

- **Rename breaks memory.** Highest-probability failure. Mitigated by symlink-then-migrate.
- **ACP may not cover Atlas's fleet verbs.** `--fan`/`--on` have no ACP equivalent; they'll need
  an extension (T3 has precedent: `XAiAcpExtension.ts`, `CursorAcpExtension.ts`).
- **Effect-TS learning curve.** The whole server is Effect. Adapters return `Effect.Effect<_, E>`
  and `Stream.Stream<_>`. Non-negotiable to learn; it's the house style.
- **Fork drift.** Upstream is active (HEAD is yesterday). Decide rebase cadence early.
