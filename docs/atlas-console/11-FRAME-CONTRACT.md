# 11 — The frame contract, field by field

`09` gives the rule for mapping a new capability and `10` gives the capability matrix. This is
the layer beneath both: **every field on the wire, with the line that writes it and the line that
reads it.**

It exists because a frame is easy to invent and hard to verify. A field can look plumbed —
declared in a schema, emitted by an adapter, mentioned in a doc — while nothing on the far side
ever reads it. Three fields in this table were exactly that, and one of them (`status`) is a
live bug for a provider that has been shipping it for months.

## How to read a row

| status         | meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `LIVE`         | published by Atlas, read by T3, verified end to end                                                                         |
| `NO READER`    | Atlas publishes it and nothing in T3 consumes it. **Do not add fields in this state** — send them only once a reader exists |
| `DEAD END`     | T3 has a consumer-shaped surface that no code path reaches                                                                  |
| `MISROUTED`    | both sides exist but write and read different field names                                                                   |
| `STARVED`      | T3's consumer chain is complete and Atlas publishes nothing                                                                 |
| `LENS-DEFINED` | T3 synthesises a value Atlas is authoritative for — `09`'s rule says the body should declare it                             |

**The rule this table enforces:** a field is implemented only when both the publisher line and
the consumer line can be cited. No exceptions, including "it obviously works".

---

## Tool lifecycle

| field                     | Atlas publisher                                        | T3 consumer                                                                                                                                                   | status                                        |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `tool_call.call_id`       | `atlas-host/src/lib.rs` observer, `ToolPhase::Started` | `AtlasAdapter.ts:333` — the `itemId` key that pairs start with end                                                                                            | `LIVE`                                        |
| `tool_call.tool`          | same                                                   | `AtlasAdapter.ts:341` → `title` → activity `summary` column (`ProviderRuntimeIngestion.ts:650`)                                                               | `LIVE`                                        |
| `tool_call.args`          | same                                                   | `AtlasAdapter.ts` → `item.started.data.args` → `payload_json`. **No web renderer** — `toolData` is surfaced only for `mcp_tool_call` (`session-logic.ts:745`) | `LIVE` to the database, `NO READER` on screen |
| `tool_result.ok`          | observer, `ToolPhase::Finished`                        | → `status: "failed"` → `ProviderRuntimeIngestion.ts` `item.completed` → `session-logic.ts:672` → the ✗ glyph                                                  | `LIVE`                                        |
| `tool_result.summary`     | same                                                   | → `item.completed.detail` → `truncateDetail` → the row's inline preview, and what makes it expandable (`MessagesTimeline.tsx:1848`)                           | `LIVE`                                        |
| `tool_result.duration_ms` | same                                                   | → `item.completed.data.durationMs`                                                                                                                            | `LIVE` to the database, `NO READER` on screen |

### `tool.summary` is a dead event repo-wide

Declared at `packages/contracts/src/providerRuntime.ts:542`, emitted by exactly two adapters
(`AtlasAdapter.ts:365`, `ClaudeAdapter.ts:2880`), and consumed by nothing —
`runtimeEventToActivities` has no `case "tool.summary"`, so it falls through to `default: break`
and returns `[]`.

The result is that **the richest field Atlas sends about a tool call is discarded.** The correct
carrier is `detail` on `item.completed`, which survives ingestion
(`ProviderRuntimeIngestion.ts:653`, truncated to 180 chars by `truncateDetail` at `:203`), renders
as the row's inline preview, and is what makes the row expandable at all
(`MessagesTimeline.tsx:1848` `buildToolCallExpandedBody` → `canExpand`).

### `status` is dropped on `item.completed` — and this is not an Atlas bug

`ItemLifecyclePayload` (`packages/contracts/src/providerRuntime.ts:427-433`) declares an optional
`status: "inProgress" | "completed" | "failed" | "declined"` (`:80`). Ingestion handles it
inconsistently:

- `item.updated` (`ProviderRuntimeIngestion.ts:628`) — **copies `status` into the payload**
- `item.completed` (`ProviderRuntimeIngestion.ts:648-655`) — copies `itemType`, `detail`, `data`,
  and **silently drops `status`**

The client reads `payload.status` (`session-logic.ts:672`, `extractWorkLogToolLifecycleStatus`)
and, when absent, **defaults to `"completed"`** (`:761-762`). That default drives the ✓/✗ glyph
(`workEntryIndicatesToolFailure` `:210`, `…Success` `:236`).

`OpenCodeAdapter.ts:908` sets `status: "failed"` on a `part.state.status === "error"` tool part,
and emits it as an `item.completed` (`:927-931`). So **OpenCode tool failures have been rendering
with a green check.** Atlas would inherit the same fate the moment it sets `status`.

The fix is one line in the `item.completed` arm, and it is strictly additive: the field is
optional, currently always absent for every provider but OpenCode, and the client already parses
it. It is shared-path code, so it is called out here rather than buried in an Atlas change.

---

## Turn and error

| field                                 | Atlas publisher                                               | T3 consumer                                                                                                                 | status                                                                |
| ------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `turn.state` (`start`/`done`/`error`) | `atlas-host/src/lib.rs:1255` (start), `:2278-2287` (terminal) | `AtlasAdapter.ts` `turn` arm                                                                                                | `LIVE`                                                                |
| `turn{state:"error"}.text`            | `lib.rs:2278`                                                 | `AtlasAdapter.ts:397` writes `payload.message`; client reads `payload.detail` (`session-logic.ts:1176` `extractToolDetail`) | `MISROUTED`                                                           |
| `assistant.text`                      | `lib.rs:2263`                                                 | `AtlasAdapter.ts` `assistant` arm                                                                                           | `LIVE`                                                                |
| `user.text`                           | `lib.rs:1254`                                                 | — no `case "user"`; falls to `default: return []` (`AtlasAdapter.ts:413`)                                                   | `NO READER` (believed correct — T3 already holds the message it sent) |
| `hb`                                  | `ws.rs:217`, `:314` (raw text frame, not a `Kind`)            | `AtlasAdapter.ts` `hb` arm → `session.heartbeat`                                                                            | `LIVE`                                                                |

`MISROUTED` is why every Atlas runtime failure renders as a bare **"Runtime error"** with the
actual message invisible. One field name.

---

## Context and usage

| field                                                         | Atlas publisher                           | T3 consumer                                                                                                                                                                                               | status                                                                               |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ctx.used`                                                    | usage observer in `atlas-host/src/lib.rs` | `AtlasAdapter.ts:381` → `thread.token-usage.updated` → `ProviderRuntimeIngestion.ts:596` → activity `context-window.updated` → `lib/contextWindow.ts:50` → `ContextWindowMeter` in `ChatComposer.tsx:188` | `LIVE`                                                                               |
| `ctx.window`                                                  | same, from `context_window_for_model`     | same chain                                                                                                                                                                                                | `LIVE`                                                                               |
| `usage.{model,input_tokens,output_tokens,cache_*,usd,cached}` | same observer                             | —                                                                                                                                                                                                         | `NO READER` — published because the ledger and analytics need it, not for the screen |

### `used` is not `input_tokens`

The obvious implementation is wrong and a probe caught it. Under prompt caching
`input_tokens` counts only the **uncached remainder**. A measured turn reported:

```
input_tokens: 2      cache_read_input_tokens: 18301      → used 18303 / 200000
```

Billing `input_tokens` as the context load would have drawn an empty gauge on a nearly full
window. What occupies the window is everything the model was given, so
`used = input + cache_read + cache_creation`.

It is a genuine pressure signal because the loop reloads the whole transcript every round
(`agent-sdk-runtime/src/lib.rs:301-307`, `load_messages`, no compaction) — verified growing
across rounds on one run: **18303 → 36872**. A flat value would mean it is wrong.

Note the ingestion gate at `ProviderRuntimeIngestion.ts:246`: `usedTokens <= 0` is discarded, so
publishing zeros is the same as publishing nothing.

### The window refuses to guess

`context_window_for_model` (`agent-sdk-provider/src/lib.rs`) returns `None` for an unrecognised
id, deliberately unlike `Pricing::for_model`, which falls back to a mid tier. A wrong price still
bills something plausible; a wrong **window** is the denominator of a gauge, and a made-up
denominator renders a meter that looks authoritative and is not. No window ⇒ no `ctx` frame.

### A decorator that forgets is silent

`model_id` and `context_window` have trait defaults, so a wrapper that fails to delegate them
inherits `None` instead of failing to compile. That shipped twice in one change — `Backend` and
`GatedModel` both dropped them — and the symptom was a `usage` frame with an empty model id and
**no `ctx` frame at all**, which reads like a model that cannot describe itself rather than a
missing line. Only the live probe found it. Pinned now by
`atlas-host/src/model_gate.rs` `the_gate_answers_for_its_backend_and_never_for_itself`.

---

## Silent kinds — nothing publishes them

Declared in `feed.rs` and never published. Ranked by how much of the machinery already exists.

| kind        | Atlas side                                                                                                                                                                   | T3 side                                                                                                                      | verdict                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| ~~`ctx`~~   | **done** — usage observer publishes it                                                                                                                                       | full chain to `ContextWindowMeter`                                                                                           | shipped                          |
| ~~`usage`~~ | **done** — observer + `record_spend` now writes `in_tok`/`out_tok`                                                                                                           | none                                                                                                                         | shipped                          |
| `approval`  | `atlas-agents/src/policy.rs:97-145` `Policy::decide` returns `Verdict::Confirm` + reason — literally the frame payload — with **zero non-test callers**                      | `ComposerPendingApprovalPanel` complete, mounted `ChatComposer.tsx:2248`                                                     | not wired, both ends built       |
| `question`  | none (only a comment at `policy.rs:147`)                                                                                                                                     | `ComposerPendingUserInputPanel` complete, mounted `ChatComposer.tsx:2255`                                                    | body must be built               |
| `deny`      | `BUILTIN_DENY` 10 rules with reasons (`policy.rs:42-53`), zero callers                                                                                                       | none                                                                                                                         | not wired                        |
| `error`     | rides `turn{state:"error"}` instead                                                                                                                                          | `runtime.error` arm exists                                                                                                   | vocabulary unused, path works    |
| `thinking`  | discarded in `agent-sdk-provider/src/lib.rs:225` (`_ => {}`); codex reasoning → `eprintln!` (`:1186`); ollama fallback-only (`:566`); `ModelResp` has no variant to carry it | **also none** — `reasoning_text` deltas are never persisted (`ProviderRuntimeIngestion.ts:1465` takes only `assistant_text`) | both ends unbuilt — lowest value |
| `edge`      | every field in scope at `atlas-tools/src/lib.rs:381-522`; only `dtrace()` to a debug file                                                                                    | none                                                                                                                         | not routed, no renderer          |

`policy.rs` names its own gap: its test is called
`ask_gates_like_read_only_until_approval_is_wired` (`:218`).

---

## `LENS-DEFINED` — values T3 invents that Atlas owns

**Status: closed.** All three suspected cases were checked against both sides. Two were not real,
which is itself the point of this document — they had been asserted in an earlier plan and carried
forward for weeks without either side being cited.

| suspected case                                                       | verdict                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| model slugs `"claude"` / `"codex"`                                   | **was real, now fixed.** `"claude"` is the CLI binary, not a model — the literal string reached the CLI as `claude --model claude`, which it rejects, and both entries were offered on nodes with neither CLI installed. `AtlasClient.ts` now reads `manifest.execution.{default_model, backend}`, and a node that declares nothing contributes no CLI entry — an empty picker beats one listing models that cannot run.  |
| the model list synthesised in `ProviderInstanceRegistryHydration.ts` | **not real.** That file derives a `ProviderInstanceConfigMap` from legacy `settings.providers.<kind>` blobs. It contains zero occurrences of "model".                                                                                                                                                                                                                                                                     |
| `AtlasProvider.ts` `capabilities: null` discarding `supportsTools`   | **not real, twice over.** `ModelCapabilities` is `{ optionDescriptors }` — select/boolean UI controls such as a reasoning-effort dropdown — and has nothing to do with tool support, so `null` is the correct value for a provider offering no such controls. And `supportsTools` is not discarded: it is the primary sort key in `modelsForMember` (`AtlasProvider.ts:89`), which floats tool-capable models to the top. |

### The one residual, stated honestly

`supportsTools` orders the picker but never reaches the screen. A model that cannot tool-call
sinks to the bottom of the list carrying no label, so choosing one silently yields an agent whose
tools do not work. Surfacing it needs a new field on `ServerProviderModel` — genuine T3 surface
work, not a value moving from lens to body, so it does not belong to this section.

---

## Inbound kinds (console → agent)

`cmd`, `interrupt`, `approve`, `answer` are `from_console()` (`feed.rs:204`) and correctly have no
Atlas publisher. Only `cmd` is enforced (`ws.rs:242`); the other three are recorded to the feed and
then ignored. `interrupt` in particular has a complete durable mechanism behind it —
`Control::cancel` (`agent-sdk-do/src/cancel.rs:80`), checked at every Action boundary
(`agent-sdk-runtime/src/lib.rs:447`) — with **zero callers anywhere in atlas-rs.**
