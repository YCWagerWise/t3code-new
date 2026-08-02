# 13 — UI component harvest

**What could be lifted out of this frontend into an unrelated project, and what would it cost.**

This document answers a different question from the rest of `docs/atlas-console/`. Documents
`01`–`12` ask _"what must Atlas feed this UI."_ This one asks _"if I were starting a different
app tomorrow — a dashboard, an admin console, a support tool — what could I take from here, and
what would I have to unpick first."_

It is written to survive without the codebase. Every claim below cites a path; claims that turn
on a specific line quote it. Where a judgement is inference rather than observation, it is
labelled **(inferred)**.

---

## 0. Provenance and verification note

| Fact                      | Value                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Repo                      | `/Users/sopuluaninweze/atlas/git-forks/t3code` — fork of `pingdotgg/t3code`                                 |
| Branch at time of writing | `docs/ui-ux-audit`                                                                                          |
| Licence                   | MIT, `LICENSE` line 1–3: `Copyright (c) 2026 T3 Tools Inc.` — **lifting is legally clean with attribution** |
| Dependencies              | installed; versions below were read from `node_modules`, not from `package.json` ranges                     |

**The working tree was dirty.** Analysis was performed against an uncommitted checkout. Files
under the surveyed area that were modified or untracked:

| Path                                                            | State                          |
| --------------------------------------------------------------- | ------------------------------ |
| `apps/web/src/components/chat/ModelListRow.tsx`                 | modified                       |
| `apps/web/src/components/chat/ModelPickerContent.tsx`           | modified                       |
| `apps/web/src/components/chat/providerIconUtils.ts`             | modified                       |
| `apps/web/src/components/settings/DiagnosticsSettings.tsx`      | modified                       |
| `apps/web/src/components/chat/AgentDiagnosticDrawer.tsx`        | untracked                      |
| `apps/web/src/components/chat/agentDiagnostics.ts` / `.test.ts` | untracked                      |
| `packages/contracts/src/model.ts`, `settings.ts`, `vcs.ts`      | modified                       |
| `apps/desktop/`                                                 | **entire directory untracked** |

None of these change a classification below, but a future reader comparing against `origin/main`
should expect drift in the model picker and diagnostics panel.

**Related documents.** `01-UI-INVENTORY.md` is the exhaustive file-level index (432 files,
102,014 lines) classified for the _Atlas port_. `03-CLASSIFICATION.md` argues those verdicts.
This document deliberately re-classifies against a different axis and does not inherit them —
a component that is "keep" for the Atlas port can be "not worth extracting" for reuse elsewhere,
and vice versa.

**Coverage.** `components/ui` (44 non-test files), `hooks` (12), `lib` (26), the root-level logic
modules (65), and — in a dedicated second pass — the whole terminal, preview/browser, diff and
files surface were read individually. `components/settings` (31), `components/cloud` (6),
`components/clerk` (4) and `state` (30) were sampled by category: entry points and the largest
file in each were opened, the rest characterised by import graph and file/line census.
`Sidebar.tsx` (3,643 lines), `SidebarV2.tsx` (2,732), `ChatView.tsx` (6,053) and
`ConnectionsSettings.tsx` (3,398) were read structurally — header, props interface and import
graph — not line by line. §8 lists exactly which files fall in which category.

**Reading order.** If you have five minutes: §2 (the coupling map) and §6.0 (the copy-paste tier).
If you have an hour: add §1, §3.2 and §5.

---

## 1. The stack, and what each choice forces on a receiving project

Verified from `node_modules` after install:

| Layer                | Choice                                                                                                                                            | Version           | Forces what on a receiver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime              | React                                                                                                                                             | **19.2.6**        | React 19 only. `ComposerPromptEditor.tsx` and `ComposerPendingUserInputPanel.tsx` use `useEffectEvent`, a React 19.2 API. Not back-portable to 18 without rewriting those call sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Compiler             | `babel-plugin-react-compiler` 1.0.0                                                                                                               | enabled           | `apps/web/vite.config.ts`: `presets: [reactCompilerPreset()]`. Components are written **assuming auto-memoisation**. Lifting them into a project without the compiler will work but will re-render more; several hot paths (`MessagesTimeline`, `ChatComposer`) additionally use explicit `memo()`, so the risk is performance, not correctness. **(inferred — not measured)**                                                                                                                                                                                                                                                                                                                                                                      |
| Component primitives | **`@base-ui/react` 1.5.0** (MUI team, MIT)                                                                                                        | stable v1         | **Not Radix.** Zero direct `@radix-ui` imports in `apps/web/src` (verified: `grep -rn '@radix-ui' apps/web/src` → 0 hits; Radix is present in the pnpm store only as a Clerk transitive). A receiver on Radix/shadcn cannot drop these files in — Base UI's part names differ (`Popup`/`Positioner`/`Viewport` vs Radix's `Content`), and `useRender` + `mergeProps` replace Radix's `asChild`.                                                                                                                                                                                                                                                                                                                                                     |
| Styling              | **Tailwind v4**, CSS-first                                                                                                                        | 4.3.0             | `apps/web/src/index.css` line 1 is `@import "tailwindcss";`. There is **no `tailwind.config.js`** anywhere. Theme lives in `@theme inline { … }` (line 117) and `:root { … }` (line 813). A receiver on Tailwind v3 cannot use these class strings — they rely on v4-only syntax: `--alpha()`, `--theme()`, `--spacing()`, `@custom-variant`, `mask-t-from-*`, `not-dark:`, `in-[…]:`, `pointer-coarse:`.                                                                                                                                                                                                                                                                                                                                           |
| Class merge          | `class-variance-authority` 0.7.1 + `tailwind-merge` 3.6.0                                                                                         | —                 | Standard shadcn convention. Cheap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Icons                | `lucide-react` 0.564.0                                                                                                                            | —                 | Used in **88 of 186** non-test `.tsx` files. Effectively mandatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Async/state (domain) | `effect` **4.0.0-beta.78** + `@effect/atom-react` **4.0.0-beta.78**                                                                               | **beta**          | This is the single biggest portability hazard. See §2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| State (UI)           | `zustand` 5.0.14                                                                                                                                  | —                 | 8 stores, all app-domain. Easy to replace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Router               | `@tanstack/react-router` 1.170.10 + file-route codegen                                                                                            | —                 | 33 `.tsx` files import it. `routeTree.gen.ts` is generated by `tanstackRouter()` in the Vite config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Virtualisation       | `@legendapp/list` 3.2.0 (**pnpm-patched**, 922-line patch)                                                                                        | —                 | Used in exactly 4 files. Patch is React-Native-facing (`keyboard.d.ts`), so the web use is likely patch-independent **(inferred)**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Rich text            | `lexical` + `@lexical/react` 0.41.0                                                                                                               | —                 | Used in exactly **1** file: `ComposerPromptEditor.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Terminal             | `@xterm/xterm` 6.0.0 + `addon-fit`                                                                                                                | —                 | Used in exactly **2** files: `main.tsx` (CSS import) and `ThreadTerminalDrawer.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Diff / code          | `@pierre/diffs` 1.3.0-beta.5 (**pnpm-patched**), `@pierre/trees` 1.0.0-beta.4                                                                     | **beta, patched** | Apache-2.0, **public on npm** — this is _not_ a T3 coupling; any app can install them. `@pierre/diffs` is a complete diff engine (~400 exports: web components, Shiki highlighter lifecycle, streaming tokenizer, patch parsing, merge-conflict resolution, worker pool) with runtime deps on `shiki`, `diff@8.0.3`, `hast-util-to-html`, `lru_map`. `@pierre/trees` **pulls in `preact@11.0.0-beta.0`** — it is a Preact-rendered web component wrapped for React. The 69-line patch in `patches/@pierre%2Fdiffs@1.3.0-beta.5.patch` disables gutter utility / line selection / line hover in `dist/editor/editor.js`. **A receiver must carry the patch or accept different diff behaviour, and accept two beta-tagged deps plus a beta Preact.** |
| Markdown             | `react-markdown` 10.1.0 + `remark-gfm`, `remark-breaks`, `rehype-raw`, `rehype-sanitize`                                                          | —                 | Conventional. Cheap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Auth                 | `@clerk/react` / `@clerk/electron`                                                                                                                | —                 | Mounted conditionally in `main.tsx` — see §5.9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Build                | **`vite-plus` 0.2.2** (VoidZero), with `vite` aliased: `pnpm-workspace.yaml` catalog says `vite: npm:@voidzero-dev/vite-plus-core@0.2.2`          | —                 | Not stock Vite. `vp` is the dev server, test runner (`vite-plus/test`), linter, and formatter. Test files import `describe/it/expect` from `"vite-plus/test"`, not `vitest`. **Every test file must be rewritten if a receiver uses plain Vitest.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Types                | TypeScript `~6.0.3` via `@typescript/native-preview` (`tsgo`)                                                                                     | —                 | `tsconfig.base.json` sets `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`. Component prop types are written to satisfy those. A looser receiver is fine; a stricter one is not an issue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lint                 | `@effect/language-service` with `globalDate`/`globalConsole`/`globalRandom`/`globalFetch`/`globalTimers` set to `"error"` in `tsconfig.base.json` | —                 | `apps/web/tsconfig.json` turns those five **off** for the web app, which is why UI code may call `Date.now()` and `setTimeout` freely. Harvested code will not import cleanly into a package that leaves them on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### What this list means in one sentence

The **presentation layer** (Tailwind v4 + Base UI + CVA + Lucide) is a coherent, MIT-licensed,
stable-version stack that transplants cleanly _as a unit_. The **data layer** (Effect 4 beta +
Effect Atom) does not transplant at all, and the boundary between them is the whole story of this
document.

---

## 2. The measured coupling map

Counts over `apps/web/src`, non-test files only.

| Measure                                     | Count               |
| ------------------------------------------- | ------------------- |
| Non-test `.tsx` files                       | 186                 |
| …importing `@t3tools/contracts`             | 74                  |
| …importing `~/state/*`                      | 43                  |
| …importing `@t3tools/client-runtime`        | 34                  |
| …importing `@tanstack/react-router`         | 33                  |
| …importing `@effect/atom-react`             | 19                  |
| …importing `@t3tools/shared`                | 19                  |
| …importing something from `effect/*`        | 17                  |
| …importing a zustand store                  | 32                  |
| …importing `lucide-react`                   | **88**              |
| …importing `@base-ui/react`                 | 33                  |
| …importing a `components/ui/*` primitive    | **107**             |
| **…importing _no_ T3 domain module at all** | **97 of 186 (52%)** |

Across `.ts` **and** `.tsx`: **193 non-test files import `@t3tools/contracts`, drawing on 234
distinct symbols.** The top ten, by number of importing files:

```
54  EnvironmentId      20  ProviderInstanceId
41  ScopedThreadRef    14  ServerProvider
29  ThreadId           14  ResolvedKeybindingsConfig
25  ProviderDriverKind  9  TurnId
                        9  DesktopBridge
```

Read that as: **the domain model is branded IDs and provider descriptors, not deep object
graphs.** `EnvironmentId`, `ScopedThreadRef` and `ThreadId` are opaque branded strings from
`packages/contracts`. A component whose only contracts dependency is `ThreadId` is one
`type ThreadId = string` away from portable. A component that consumes `ServerProvider` or
`OrchestrationThreadActivity` is genuinely bound to the domain.

`packages/contracts` itself declares exactly one dependency — `effect` — so it is a pure Effect
`Schema` definition package with three export subpaths (`.`, `./settings`, `./relay`). It is
therefore _possible_ to take contracts along without taking the server. Whether that is desirable
in an unrelated project is another matter: it drags Effect 4 beta with it.

### `@t3tools/client-runtime` — headless, and where the real weight lives

Declared dependencies are exactly three: `@t3tools/contracts`, `@t3tools/shared`, `effect`.
**Zero files in it import React** (verified). It exports 34 subpaths, of which 24 are `./state/*`
atom-factory modules. `apps/web` imports it from **108 non-test files**; the distribution is
lopsided:

```
46  @t3tools/client-runtime/state/runtime     ← isAtomCommandInterrupted / squashAtomCommandFailure / runAtomCommand
37  @t3tools/client-runtime/environment       ← scopedThreadKey / parseScopedThreadKey / scopeThreadRef
20  @t3tools/client-runtime/connection         9  …/errors        8  …/rpc        8  …/relay
 7  …/state/threads                            5  …/state/shell   3  …/state/vcs  3  …/state/projects
```

Two things follow. First, the `~/state/*.ts` files in `apps/web` are mostly **five-line factory
wrappers** — e.g. `state/terminal.ts` in its entirety is
`export const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);`. The
weight is in `client-runtime`, not in the app. Second, **the single most-imported symbol group in
the whole codebase is error-handling glue** (`state/runtime`, 46 files) — `isAtomCommandInterrupted`
and `squashAtomCommandFailure` appear in nearly every component that issues a command. Any port
must decide what replaces that pair before it can compile a single feature component.

`scopedThreadKey` / `parseScopedThreadKey` (37 files) are just a string encoder/decoder over
`{environmentId, threadId}` and are trivially replaceable — they are the cheapest 37-file
dependency in the repo.

### The two seams that matter most

**Seam 1 — `~/lib/utils` poisons the primitive layer.**
`apps/web/src/lib/utils.ts` is 43 lines and exports `cn`, three platform predicates, `randomHex`,
`randomUUID`, and five ID constructors. Its first line is:

```ts
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
```

and its last import is `import { DraftId } from "../composerDraftStore";` — a 3,574-line zustand
store. **38 of the 44 files in `components/ui` import `~/lib/utils`.** Splitting `cn` +
`isMacPlatform` + `isWindowsPlatform` + `isLinuxPlatform` into a standalone module is a
five-minute change that decouples the entire primitive layer from the domain.

**Seam 2 — only three files in `components/ui` touch T3 at all.** Verified by grepping every
import in that directory:

| File                               | Coupling                                                                                                                                                                                                      | Cost to break                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `components/ui/toast.tsx` (813)    | `@tanstack/react-router` `useParams`, `ScopedThreadRef`/`ThreadId`, `~/composerDraftStore`, `~/threadRoutes`                                                                                                  | **Real.** This is a thread-aware toast that can navigate. See §5.4.                    |
| `components/ui/sidebar.tsx` (1028) | `effect/Schema` — used only at two call sites as a localStorage validator: `setLocalStorageItem(resolvedResizable.storageKey, resizeState.width, Schema.Finite)` (line 395) and the matching read at line 567 | **Trivial.** Replace with `Number.isFinite`.                                           |
| `components/ui/qr-code.tsx` (81)   | `import { QrCode } from "@t3tools/shared/qrCode"`                                                                                                                                                             | **Trivial.** `qrCode.ts` is a pure encoder in `packages/shared`; move it or vendor it. |

Everything else in `components/ui` — 41 files, ~4,000 lines — imports only React, Base UI,
Lucide, CVA and `cn`.

---

## 3. Component inventory and portability classification

Buckets, as specified:

- **PORTABLE** — pure presentation, no app-specific coupling. Lift as-is.
- **PORTABLE-WITH-SEAM** — reusable once one or two named dependencies become props/context.
- **COUPLED** — bound to T3's domain model or its Effect runtime. Decoupling judged separately.
- **APP-SPECIFIC** — not worth extracting.

### 3.1 Design tokens and global CSS — `apps/web/src/index.css`, 1,580 lines

Not a component, but it is the substrate everything else assumes.

| Region                                                                    | Lines       | What it is                                                                                                                                                                                                                                                                                                                                | Verdict                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tailwind import + `@custom-variant`                                       | 1–5         | `dark` variant is class-based: `@custom-variant dark (&:is(.dark, .dark *));`. `wco` variant targets Electron's Window Controls Overlay.                                                                                                                                                                                                  | PORTABLE (drop `wco`)                                                                                                                                                    |
| Mobile composer view-transitions                                          | 6–76        | `::view-transition-*` choreography that morphs the hero composer into the docked composer during a route change. Genuinely nice work; genuinely specific.                                                                                                                                                                                 | APP-SPECIFIC                                                                                                                                                             |
| `@theme inline`                                                           | 117–170     | Maps `--color-*` Tailwind tokens onto `--*` CSS vars, plus four named animations (`skeleton`, `status-pulse`, `status-ping`, `sidebar-working-text`) and the DM Sans / JetBrains Mono font stacks.                                                                                                                                        | **PORTABLE**                                                                                                                                                             |
| `:root` / `@variant dark` palette                                         | 813–895     | The full semantic palette: `background foreground card popover primary secondary muted accent destructive border input ring` plus `info success warning` and a nine-token `sidebar-*` sub-palette. Light is zinc-based; dark is `--color-neutral-950` with `color-mix`/`--alpha()` derived surfaces.                                      | **PORTABLE — this is the highest-value single artefact in the repo for a receiving project.**                                                                            |
| `[data-sidebar-version="v1"\|"v2"]` overrides                             | 900–950     | Re-declares the palette inside the sidebar so both sidebar implementations share one hierarchy.                                                                                                                                                                                                                                           | APP-SPECIFIC                                                                                                                                                             |
| `@layer components` glass surfaces                                        | 244–780     | `.chat-composer-glass`, `.chat-composer-glass-shell`, `.chat-composer-context-strip`, `.dialog-glass`, `.dropdown-glass`, `.alert-glass`, `.sidebar-stage-backdrop`, `.stage-blueprint`, `.workspace-topbar`, `.surface-subheader`, plus `prefers-reduced-transparency` fallbacks. `.dropdown-glass` is referenced from `ui/popover.tsx`. | PORTABLE-WITH-SEAM — `dropdown-glass` and `dialog-glass` must travel with `popover.tsx`/`dialog.tsx` or those components render unstyled backgrounds.                    |
| `@utility pt-safe / pb-safe / pl-safe / pr-safe`                          | 782–796     | `env(safe-area-inset-*)` helpers.                                                                                                                                                                                                                                                                                                         | PORTABLE                                                                                                                                                                 |
| `@utility surface-grain`                                                  | 798–812     | Inline SVG `feTurbulence` noise baked into a surface background. The comment explains why it is per-surface rather than a fixed overlay: _"a full-viewport overlay forces the compositor to re-blend every frame any animation produces, which multiplied idle GPU cost."_                                                                | PORTABLE, and worth stealing on its own                                                                                                                                  |
| `.chat-markdown` typography                                               | 1,092–1,440 | ~350 lines styling headings, lists, task lists, footnotes, blockquotes, tables, code fences, the code-block chrome header, favicon-decorated links, and file links. Pairs with `ChatMarkdown.tsx`.                                                                                                                                        | PORTABLE-WITH-SEAM — must travel with `ChatMarkdown.tsx`; a few selectors reference `.chat-markdown-file-link`, which only exists because the app rewrites `file:` URIs. |
| `.ultrathink-*`                                                           | 1,461–1,560 | Animated rainbow frame for Claude's "ultrathink" mode.                                                                                                                                                                                                                                                                                    | APP-SPECIFIC                                                                                                                                                             |
| Scrollbar theming, `.drag-region`, `.electron-windows`, `.no-transitions` | scattered   | `.drag-region` is Electron titlebar drag. `.no-transitions` is a global transition kill-switch.                                                                                                                                                                                                                                           | PORTABLE (`.no-transitions`) / APP-SPECIFIC (Electron bits)                                                                                                              |

### 3.2 `components/ui` — the primitive layer. 44 non-test files, 5,974 lines (47 with tests).

This is the harvest. Table verified file by file; "base-ui" column names the `@base-ui/react`
subpath imported.

| File               |  LOC | Wraps                           |       Used in N files | Verdict                                                          |
| ------------------ | ---: | ------------------------------- | --------------------: | ---------------------------------------------------------------- |
| `button.tsx`       |   74 | `merge-props`, `use-render`     |                **58** | PORTABLE                                                         |
| `tooltip.tsx`      |   59 | `tooltip`                       |                    44 | PORTABLE                                                         |
| `toast.tsx`        |  813 | `toast`                         |                    34 | **COUPLED** — see §5.4                                           |
| `input.tsx`        |   73 | `input`                         |                    19 | PORTABLE                                                         |
| `menu.tsx`         |  302 | `menu`                          |                    18 | PORTABLE                                                         |
| `scroll-area.tsx`  |   74 | `scroll-area`                   |                    14 | PORTABLE                                                         |
| `sidebar.tsx`      | 1028 | `merge-props`, `use-render`     |                    11 | PORTABLE-WITH-SEAM (`effect/Schema` → `Number.isFinite`)         |
| `dialog.tsx`       |  183 | `dialog`                        |                    11 | PORTABLE (needs `.dialog-glass` CSS)                             |
| `switch.tsx`       |   27 | `switch`                        |                    10 | PORTABLE                                                         |
| `popover.tsx`      |  111 | `popover`                       |                    10 | PORTABLE (needs `.dropdown-glass` CSS)                           |
| `select.tsx`       |  240 | `select`                        |                     9 | PORTABLE                                                         |
| `badge.tsx`        |   56 | `merge-props`, `use-render`     |                     8 | PORTABLE                                                         |
| `textarea.tsx`     |   45 | `field`, `merge-props`          |                     6 | PORTABLE                                                         |
| `spinner.tsx`      |   15 | — (Lucide `Loader2Icon`)        |                     6 | PORTABLE                                                         |
| `empty.tsx`        |  114 | —                               |                     6 | PORTABLE                                                         |
| `skeleton.tsx`     |   16 | —                               |                     5 | PORTABLE                                                         |
| `separator.tsx`    |   19 | `separator`                     |                     5 | PORTABLE                                                         |
| `kbd.tsx`          |   28 | —                               |                     5 | PORTABLE                                                         |
| `command.tsx`      |  240 | `dialog` + local `autocomplete` |                     5 | PORTABLE                                                         |
| `toggle.tsx`       |   48 | `toggle`                        |                     4 | PORTABLE                                                         |
| `group.tsx`        |   93 | `merge-props`, `use-render`     |                     4 | PORTABLE                                                         |
| `combobox.tsx`     |  403 | `combobox`                      |                     4 | PORTABLE                                                         |
| `checkbox.tsx`     |   60 | `checkbox`                      |                     4 | PORTABLE                                                         |
| `alert.tsx`        |  113 | —                               |                     4 | PORTABLE                                                         |
| `draft-input.tsx`  |   21 | — (`~/hooks/useCommitOnBlur`)   |                     3 | PORTABLE-WITH-SEAM (take the hook too)                           |
| `collapsible.tsx`  |   39 | `collapsible`                   |                     3 | PORTABLE                                                         |
| `alert-dialog.tsx` |  144 | `alert-dialog`                  |                     3 | PORTABLE                                                         |
| `sheet.tsx`        |  200 | `dialog`                        |                     2 | PORTABLE                                                         |
| `radio-group.tsx`  |   36 | `radio`, `radio-group`          |                     2 | PORTABLE                                                         |
| `number-field.tsx` |  156 | `number-field`                  |                     2 | PORTABLE                                                         |
| `label.tsx`        |   24 | `merge-props`, `use-render`     |                     2 | PORTABLE                                                         |
| `toggle-group.tsx` |   96 | `toggle`, `toggle-group`        |                     1 | PORTABLE                                                         |
| `table.tsx`        |   87 | —                               |                     1 | PORTABLE                                                         |
| `qr-code.tsx`      |   81 | — (`@t3tools/shared/qrCode`)    |                     1 | PORTABLE-WITH-SEAM                                               |
| `input-group.tsx`  |   95 | —                               |                     1 | PORTABLE                                                         |
| `autocomplete.tsx` |  271 | `autocomplete`                  | 1 (via `command.tsx`) | PORTABLE                                                         |
| `dialog-styles.ts` |   10 | —                               |                     3 | PORTABLE                                                         |
| `sidebarState.ts`  |    9 | —                               |                     1 | PORTABLE                                                         |
| `toastHelpers.ts`  |   58 | `toast` types                   |                     — | PORTABLE-WITH-SEAM                                               |
| `toast.logic.ts`   |  115 | — (`ScopedThreadRef`)           |                     — | COUPLED                                                          |
| **`card.tsx`**     |  196 | `merge-props`, `use-render`     |                 **0** | PORTABLE — **currently dead code**                               |
| **`field.tsx`**    |   59 | `field`                         |                 **0** | PORTABLE — **dead**                                              |
| **`fieldset.tsx`** |   26 | `fieldset`                      |                 **0** | PORTABLE — **dead**                                              |
| **`form.tsx`**     |   17 | `form`                          |                 **0** | PORTABLE — **dead**, and it is a bare pass-through with no logic |

**Four primitives are unreferenced** (`card`, `field`, `fieldset`, `form` — verified by grepping
`ui/<name>` across `apps/web/src` and finding no importer outside the file itself). Take them
anyway: `card.tsx` at 196 lines is a full Card/CardHeader/CardTitle/CardAction/CardContent/
CardFooter set, and `field.tsx` exports `Field`/`FieldLabel`/`FieldItem`/`FieldDescription`/
`FieldError`/`FieldControl`/`FieldValidity` over Base UI's validation-aware `Field` primitive —
the label+description+error scaffold that `components/settings` currently hand-rolls with
`SettingsRow`. `form.tsx` is genuinely trivial (`<FormPrimitive className="flex w-full flex-col gap-4">`)
and exists only so a form has a `data-slot="form"` to hang sibling selectors off.

**The one field-layer component that is _not_ trivial is `draft-input.tsx` (21 lines).** Its
docstring states the problem precisely: _"buffers keystrokes locally and invokes `onCommit` only
when the user finishes editing (blur or Enter). Prevents each keystroke from triggering a
settings-wide re-render or a server RPC round-trip, which otherwise makes fields backed by a
server-hydrated value feel laggy."_ Used in three settings surfaces. **This is the single most
under-sized-for-its-value file in the primitive layer** — take it and `useCommitOnBlur` together.

**Notable design decisions inside the primitive layer:**

1. **`useRender` replaces `asChild`.** `button.tsx` and seven others take a `render` prop and call
   `useRender({ defaultTagName: "button", props: mergeProps<"button">(defaultProps, props), render })`.
   Callers compose with `<DialogPrimitive.Close render={<Button size="icon" variant="ghost" />}>`
   rather than `asChild`. This is _better_ than Radix's `asChild` (no cloneElement, typed prop
   merging) but is a hard fork point.

2. **shadcn names are preserved as aliases.** `menu.tsx` exports every symbol twice —
   `MenuItem as DropdownMenuItem`, `MenuPopup as DropdownMenuContent`, and so on for 15 pairs.
   `dialog.tsx` exports `DialogBackdrop as DialogOverlay` and `DialogPopup as DialogContent`.
   **This is an explicit migration shim**: code written against shadcn/Radix compiles against
   these files. That materially lowers the cost of adopting the layer in a project that already
   has shadcn conventions.

3. **`ScrollArea` has a `scrollFade` prop** implemented purely in Tailwind v4 masks:
   `mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))]` and three
   siblings. It reads Base UI's `--scroll-area-overflow-*` custom properties, so the fade
   automatically disappears when you are at the edge. Also `scrollbarGutter`, `hideScrollbars`,
   `chainVerticalScroll`. Small file, high value.

4. **Every primitive stamps a `data-slot`.** `data-slot="button"`, `"dialog-popup"`,
   `"sidebar-wrapper"`, etc. Sibling styling relies on it — e.g. `button.tsx`'s
   `not-in-data-[slot=input-group]:` variant, and `dialog.tsx`'s
   `in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3`. If you take one file you
   must keep the convention.

5. **Nested dialogs stack visually.** `dialog-styles.ts` is ten lines and worth reading:
   `DIALOG_POPUP_CLASS` scales and translates by `--nested-dialogs`
   (`scale-[calc(1-0.1*var(--nested-dialogs))]`, `-translate-y-[calc(1.25rem*var(--nested-dialogs))]`,
   `opacity-[calc(1-0.1*var(--nested-dialogs))]`), so opening a dialog from inside a dialog pushes
   the parent back in a visible stack. Base UI supplies the counter; the three exported class
   strings are shared by `dialog.tsx`, `sheet.tsx` and `command.tsx`.

6. **Touch-target inflation is systematic.** Both `button.tsx` and `badge.tsx` carry
   `pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11` — a pseudo-element that expands
   the hit area to 44px on coarse pointers without changing layout. Free accessibility win.

### 3.3 Icons — 1,447 lines across three files

| File                            | LOC | Contents                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                  |
| ------------------------------- | --: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `components/Icons.tsx`          | 720 | 23 hand-inlined brand SVGs: GitHub, Git, Jujutsu, GitLab, Azure DevOps, Bitbucket, Cursor, Grok, Trae, Kiro, VS Code, VS Code Insiders, VSCodium, Zed, OpenAI, ClaudeAI, Gemini, Antigravity, Atlas, OpenCode, GitHub Copilot, ACP Registry, Pi Agent. Exports `type Icon = React.FC<SVGProps<SVGSVGElement>>`. Gradient-bearing icons use `useId()` to avoid `<defs>` collisions. | **PORTABLE** — zero domain imports                                                       |
| `components/JetBrainsIcons.tsx` | 610 | 12 JetBrains IDE icons (Aqua, CLion, DataGrip, DataSpell, GoLand, IntelliJ, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm) with a shared `useSvgGradientIds` helper.                                                                                                                                                                                                     | PORTABLE                                                                                 |
| `pierre-icons.ts`               | 117 | Wraps `@pierre/trees`' `createFileTreeIconResolver` + `getBuiltInSpriteSheet`, and injects a 6-symbol T3 override sprite (package.json, tsconfig, AGENTS, Claude, README, pnpm). Exports `basenameOfPath`, `hasSpecificPierreIconForFileName`, `syntheticFileNameForLanguageId`.                                                                                                   | PORTABLE-WITH-SEAM — drops the T3-specific `AGENTS`/`Claude` symbols, keeps the resolver |

The `useId()`-per-gradient pattern in both icon files is the correct fix for the classic
duplicate-SVG-gradient-ID bug and is worth copying regardless of whether you take the icons.

### 3.4 Hooks — `apps/web/src/hooks`, 12 non-test files

| Hook                         | LOC | Does                                                                                                                                                   | Deps                                                                    | Verdict                                                                                                                            |
| ---------------------------- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `useCommitOnBlur.ts`         |  43 | Local draft value that only commits upstream on blur/Enter.                                                                                            | `react`                                                                 | **PORTABLE**                                                                                                                       |
| `useMediaQuery.ts`           |  87 | `useMediaQuery` + `useIsMobile`.                                                                                                                       | `react`                                                                 | **PORTABLE**                                                                                                                       |
| `useNowMinute.ts`            |  69 | Ticks a `Date` once per minute, aligned to the minute boundary — for relative timestamps that must update without a per-second interval.               | `react`                                                                 | **PORTABLE**                                                                                                                       |
| `useCopyToClipboard.ts`      | 109 | `writeTextToClipboard` + a hook with copied-state timeout.                                                                                             | `react`, `effect/Schema`                                                | PORTABLE-WITH-SEAM (drop Schema)                                                                                                   |
| `useLocalStorage.ts`         | 182 | Schema-validated localStorage get/set/hook. Validation is why `sidebar.tsx` imports Effect.                                                            | `react`, `effect/Schema`, `effect/Record`                               | PORTABLE-WITH-SEAM — **swap Effect Schema for Zod/Valibot/none; this one change removes Effect from the primitive layer entirely** |
| `useResizableWidth.ts`       | 168 | Pointer-drag resize with min/max clamping and localStorage persistence. Powers the sidebar and the right panel.                                        | `react`, `useLocalStorage`, `effect/Schema`                             | PORTABLE-WITH-SEAM                                                                                                                 |
| `useTheme.ts`                | 324 | light/dark/system resolution, `syncBrowserChromeTheme`, `<meta name="theme-color">` sync.                                                              | `effect/Schema`, `@t3tools/contracts`, `@t3tools/client-runtime/errors` | PORTABLE-WITH-SEAM — the contracts import is the `Theme` union type                                                                |
| `useSettings.ts`             | 305 | The settings read/write surface: `useClientSettings(selector)`, `useUpdateClientSettings`, `getClientSettings`. Backed by Effect atoms + `~/localApi`. | atoms, contracts, client-runtime                                        | COUPLED                                                                                                                            |
| `useTurnDiffSummaries.ts`    |  19 | Memoises a `Map<MessageId, TurnDiffSummary>`.                                                                                                          | `session-logic`, `types`                                                | APP-SPECIFIC                                                                                                                       |
| `useT3ProjectFileScripts.ts` |  34 | Reads `t3.json` project scripts.                                                                                                                       | contracts, shared                                                       | APP-SPECIFIC                                                                                                                       |
| `useHandleNewThread.ts`      | 325 | Creates a thread/draft and routes to it.                                                                                                               | 15 imports incl. router, atoms, 2 zustand stores                        | APP-SPECIFIC                                                                                                                       |
| `useThreadActions.ts`        | 580 | Archive/unarchive/delete/rename/snooze/worktree-cleanup for threads, with toasts and undo.                                                             | 24 imports                                                              | APP-SPECIFIC                                                                                                                       |

**Six of twelve hooks are harvestable**, and they are the six you would otherwise write yourself.

### 3.5 Headless logic — `apps/web/src/lib` (26 files) and root-level modules (65 files)

These are not components, but several are the _reason_ the components are good, and they port
more cheaply than anything else here.

| Module                                                                                                    |       LOC | What it does                                                                                                                                                                                                                                                                                                                                                         | Verdict                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/lruCache.ts`                                                                                         |        68 | LRU with both an entry-count cap **and** a byte-budget cap. Used by `ChatMarkdown` for highlighted-code caching (500 entries / 50 MB).                                                                                                                                                                                                                               | **PORTABLE**                                                                                                    |
| `lib/utils.ts`                                                                                            |        43 | `cn`, platform predicates, `randomUUID` (v4 from `crypto.getRandomValues`, hand-assembled), ID constructors.                                                                                                                                                                                                                                                         | SPLIT — see §2 seam 1                                                                                           |
| `lib/storage.ts`                                                                                          |        67 | Debounced (`@tanstack/react-pacer`) localStorage writer.                                                                                                                                                                                                                                                                                                             | PORTABLE                                                                                                        |
| `lib/diffCollapse.ts`                                                                                     |        13 | `areAllDiffFilesCollapsed`, `toggleAllDiffFiles`.                                                                                                                                                                                                                                                                                                                    | PORTABLE                                                                                                        |
| `lib/diffRendering.ts`                                                                                    |       152 | `getRenderablePatch`, `resolveDiffThemeName`, `resolveFileDiffPath`, `buildFileDiffRenderKey`, `fnv1a32`. Bridges to `@pierre/diffs`.                                                                                                                                                                                                                                | PORTABLE-WITH-SEAM (Pierre)                                                                                     |
| `lib/turnDiffTree.ts`                                                                                     |       172 | Folds a flat file list into a collapsed directory tree (single-child dirs merged into `a/b/c`).                                                                                                                                                                                                                                                                      | **PORTABLE**                                                                                                    |
| `lib/windowControlsOverlay.ts`                                                                            |        66 | Syncs `.wco` / `.electron-windows` classes from `navigator.windowControlsOverlay`.                                                                                                                                                                                                                                                                                   | PORTABLE (Electron apps only)                                                                                   |
| `lib/favicon.ts`                                                                                          |        20 | `faviconUrlForOrigin`.                                                                                                                                                                                                                                                                                                                                               | PORTABLE                                                                                                        |
| `lib/terminalFocus.ts`, `lib/previewFocus.ts`                                                             |     14/15 | Module-level "is X focused" flags used to gate global shortcuts. Crude but effective.                                                                                                                                                                                                                                                                                | PORTABLE (pattern)                                                                                              |
| `composer-logic.ts`                                                                                       |       287 | **The composer's brain.** `shouldSubmitComposerOnEnter`, `detectComposerTrigger` (`@`-path / `/`-command / skill), `expandCollapsedComposerCursor` ⇄ `collapseExpandedComposerCursor` (maps between the text the user sees and the text with inline tokens expanded), `replaceTextRange`, `parseStandaloneComposerSlashCommand`. **No imports at all beyond types.** | **PORTABLE — highest-value logic module in the repo**                                                           |
| `composer-editor-mentions.ts`                                                                             |       223 | `splitPromptIntoComposerSegments`, `selectionTouchesMentionBoundary`. Turns a prompt string into text/mention/skill/terminal-context segments for Lexical.                                                                                                                                                                                                           | PORTABLE                                                                                                        |
| `markdown-clipboard.ts`                                                                                   |       311 | Serialises a rendered markdown DOM fragment back to markdown; tables to markdown **and** CSV; builds a dual `text/plain` + `text/html` clipboard payload.                                                                                                                                                                                                            | **PORTABLE**                                                                                                    |
| `markdown-list-indentation.ts`                                                                            |       143 | A remark plugin that normalises LLM-emitted list indentation (models routinely emit 3-space nesting that CommonMark reads as a code block).                                                                                                                                                                                                                          | **PORTABLE — steal this if you render any LLM markdown**                                                        |
| `markdown-links.ts`                                                                                       |       213 | `normalizeMarkdownLinkDestination`, `resolveMarkdownFileLinkMeta`, `rewriteMarkdownFileUriHref`.                                                                                                                                                                                                                                                                     | PORTABLE-WITH-SEAM                                                                                              |
| `terminal-links.ts`                                                                                       |       286 | URL and file-path link detection across **wrapped** xterm buffer lines, with `file:line:col` parsing. Pure functions over a `TerminalBufferLineLike` interface — deliberately not coupled to xterm's types.                                                                                                                                                          | **PORTABLE**                                                                                                    |
| `timestampFormat.ts`                                                                                      |       225 | Absolute/relative/short/tooltip timestamp formatting with a `TimestampFormat` setting, plus `formatElapsedDurationLabel`.                                                                                                                                                                                                                                            | PORTABLE-WITH-SEAM (the `TimestampFormat` type comes from contracts)                                            |
| `contextMenuFallback.ts`                                                                                  |       307 | **Renders a native-looking context menu in the DOM when Electron's native menu is unavailable**, including inlined Lucide icon paths so it needs no React.                                                                                                                                                                                                           | PORTABLE-WITH-SEAM — the `ContextMenuItem` type is from contracts, but the type is a simple discriminated union |
| `pendingUserInput.ts`                                                                                     |       172 | Multi-question prompt progress state: `derivePendingUserInputProgress`, `togglePendingUserInputOptionSelection`, `buildPendingUserInputAnswers`.                                                                                                                                                                                                                     | PORTABLE-WITH-SEAM                                                                                              |
| `keybindings.ts`                                                                                          |       529 | `resolveShortcutCommand(event, config, context)`, `formatShortcutLabel`, `shortcutLabelForCommand`, plus ~20 `isXShortcut` predicates and thread-jump/model-picker index helpers.                                                                                                                                                                                    | PORTABLE-WITH-SEAM — see §4.7                                                                                   |
| `shortcutModifierState.ts`                                                                                |        96 | Tracks held modifiers so the UI can show jump-number hints while ⌘ is down.                                                                                                                                                                                                                                                                                          | PORTABLE                                                                                                        |
| `session-logic.ts`                                                                                        |     1,401 | `deriveTimelineEntries`, `deriveWorkLogEntries`, `derivePendingApprovals`, `derivePendingUserInputs`, `deriveActivePlanState`, `derivePhase`, `formatDuration`, `formatElapsed`. **This is the projection from raw orchestration messages to renderable timeline rows.**                                                                                             | COUPLED — worth reading as a reference design even if not lifted                                                |
| `composerDraftStore.ts`                                                                                   |     3,574 | zustand store for per-thread drafts: text, cursor, model selection, images, terminal contexts, element contexts, review comments. Persisted.                                                                                                                                                                                                                         | COUPLED                                                                                                         |
| `sidebarProjectGrouping.ts`                                                                               |       262 | Groups threads into project snapshots (logical vs physical projects).                                                                                                                                                                                                                                                                                                | APP-SPECIFIC                                                                                                    |
| `providerInstances.ts`, `modelSelection.ts`, `modelOrdering.ts`, `providerModels.ts`, `providerSkill*.ts` | 950 total | Provider/model catalogue logic.                                                                                                                                                                                                                                                                                                                                      | APP-SPECIFIC                                                                                                    |

`packages/shared` (8,207 lines) is the cross-tier utility package. It exports **raw `.ts` source
via subpath exports** (`"./model": { "import": "./src/model.ts" }`) with no build step — a
consumer must have a bundler that transpiles workspace TypeScript. Its genuinely generic members
are `String.ts`, `Struct.ts`, `path.ts`, `semver.ts`, `searchRanking.ts`, `qrCode.ts`,
`KeyedCoalescingWorker.ts`, `DrainableWorker.ts`; the rest (`model.ts`, `sourceControl.ts`,
`toolActivity.ts`, `agentAwareness.ts`, `chatList.ts`, `previewViewport.ts`, `relay*.ts`,
`dpop*.ts`) are T3-domain or transport-specific.

### 3.6 Feature components by area

Full per-file detail for the largest areas is in `01-UI-INVENTORY.md`. What follows is the
classification, with the blocking dependency named.

#### Chat & composer — `components/chat` (50 files, 12,098 lines) + 3 root files

| Component                                                                                        |    LOC | Verdict                                 | Blocking dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | -----: | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatView.tsx`                                                                                   |  6,053 | APP-SPECIFIC                            | It _is_ the app. Orchestrates ~40 child components, 4 atom reads, 5 zustand stores, router, terminal, diff, preview.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ChatComposer.tsx`                                                                               |  2,747 | **COUPLED, but structurally excellent** | Takes **~60 props and reaches into zero global state except `useComposerDraftStore`**. Every piece of domain data arrives as a prop (`activePendingApproval`, `providerStatuses`, `runtimeMode`, `keybindings`…). Decoupling is mechanical, not architectural — see §4.1.                                                                                                                                                                                                                                                                                      |
| `ComposerPromptEditor.tsx`                                                                       |  1,842 | **PORTABLE-WITH-SEAM**                  | A Lexical plain-text editor with three custom `DecoratorNode` types (mention chip, skill chip, terminal-context chip), bracket auto-surround, and cursor mapping between collapsed and expanded token forms. Its props are `{value, cursor, terminalContexts, skills, disabled, placeholder, onChange, onCommandKeyDown, onPaste, editorRef}` — the only domain type is `ServerProviderSkill`, used for the skill chip label. **Replace that one type and this is a general-purpose mention-and-chip composer.**                                               |
| `MessagesTimeline.tsx`                                                                           |  2,081 | COUPLED                                 | 30 props, all domain-shaped (`timelineEntries: ReturnType<typeof deriveTimelineEntries>`). Contains the virtualised list (`@legendapp/list`), the scroll minimap, tool-call rows with success/failure/neutral state, inline `FileDiff` rendering, and revert-to-checkpoint affordances. The _patterns_ are the value; the file is not liftable.                                                                                                                                                                                                                |
| `ChatMarkdown.tsx`                                                                               |  1,566 | **COUPLED, decoupling worth it**        | Streaming-safe markdown with Shiki highlighting (worker-backed, LRU-cached), copy/wrap/expand code-block chrome, table→CSV/markdown copy, favicon-decorated external links, `file:` link rewriting that opens the in-app editor, task-list checkbox write-back, and an error boundary around highlighting. Blocking deps: `~/state/{entities,server,assets,session,preview}`, `~/rightPanelStore`, `~/browser/openFileInPreview`. **All five are "what happens when you click a link" — a single `onOpenFile`/`onOpenUrl` context would free the whole file.** |
| `ComposerPendingApprovalPanel.tsx`                                                               |     49 | **PORTABLE-WITH-SEAM**                  | Imports only `react` and `PendingApproval` from `session-logic`. Renders the approval header + a `<pre>` of the command/file detail.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ComposerPendingApprovalActions.tsx`                                                             |     55 | **PORTABLE-WITH-SEAM**                  | Four buttons — _Cancel turn_ / _Decline_ / _Always allow this session_ / _Approve once_ — over `(requestId, decision) => Promise`. Only `ApprovalRequestId` and `ProviderApprovalDecision` (a string union) from contracts. **This is the entire approval UX and it is 55 lines.**                                                                                                                                                                                                                                                                             |
| `ComposerPendingUserInputPanel.tsx`                                                              |    227 | **PORTABLE-WITH-SEAM**                  | Multi-question prompt card: single/multi-select, per-option description, number-key shortcuts 1–9 (skipped when focus is in an input or `[contenteditable]`), optimistic single-select with a 200 ms auto-advance, progress `1/3` pill. Genuinely good interaction design in a small file.                                                                                                                                                                                                                                                                     |
| `ComposerBannerStack.tsx`                                                                        |    208 | **PORTABLE**                            | A stacked, dismissible banner deck with staggered exit transforms (`translate3d(0,4rem,0)` for the front card, `7rem` for the ones behind). Props are `{items: {id, variant, icon, title, description, actions, onDismiss}[]}`. Zero domain imports.                                                                                                                                                                                                                                                                                                           |
| `ComposerPrimaryActions.tsx`                                                                     |    241 | **PORTABLE-WITH-SEAM**                  | The send/stop/next button cluster with compact and full layouts. Zero domain imports; only depends on `SidebarStageBackdrop` for the button art.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ContextWindowMeter.tsx`                                                                         |    139 | **PORTABLE-WITH-SEAM**                  | SVG ring gauge with a hover popover showing token counts; turns red above 90%. Only depends on `~/lib/contextWindow`'s `ContextWindowSnapshot` type.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ProposedPlanCard.tsx`                                                                           |    256 | COUPLED                                 | Collapsible plan card with rename dialog, markdown export, download-as-file, copy. Blocked by `~/state/projects` + `useAtomCommand`.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PlanSidebar.tsx`                                                                                |    284 | COUPLED                                 | Same, plus `ActivePlanState` from `session-logic`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ModelPickerContent.tsx`                                                                         |    679 | COUPLED                                 | Virtualised searchable model list with per-instance sidebar, ⌘1–9 jump shortcuts, fuzzy scoring. Bound to `ProviderInstanceId`/`ProviderDriverKind`. The _search + virtualised combobox_ pattern is generic; the data model is not.                                                                                                                                                                                                                                                                                                                            |
| `TraitsPicker.tsx`                                                                               |    523 | APP-SPECIFIC                            | Provider option descriptors (reasoning effort, ultrathink).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ChangedFilesTree.tsx`                                                                           |    330 | PORTABLE-WITH-SEAM                      | Renders `lib/turnDiffTree.ts`'s collapsed tree with per-file add/delete counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DiffStatLabel.tsx`                                                                              |     53 | **PORTABLE**                            | `+12 −4` with colour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MessageCopyButton.tsx`                                                                          |     82 | **PORTABLE**                            | Copy with checkmark feedback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `FileTagChip.tsx`                                                                                |     39 | **PORTABLE**                            | The `@file` chip; also exported as a class name + content pair so Lexical can render it into a `DecoratorNode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ExpandedImageDialog.tsx` / `ExpandedImagePreview.tsx`                                           | 110/32 | **PORTABLE**                            | Lightbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ThreadErrorBanner.tsx`                                                                          |     37 | **PORTABLE**                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SkillInlineText.tsx`, `PierreEntryIcon.tsx`, `ProviderInstanceIcon.tsx`, `providerIconUtils.ts` |   ~270 | APP-SPECIFIC                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ComposerCommandMenu.tsx`                                                                        |    258 | PORTABLE-WITH-SEAM                      | The `/`-command and `@`-path menu that floats above the composer. Positioning is done by a small `ComposerCommandMenuLayer` inside `ChatComposer.tsx` that measures the anchor rect and portals.                                                                                                                                                                                                                                                                                                                                                               |
| `AgentDiagnosticDrawer.tsx`                                                                      |    116 | APP-SPECIFIC                            | **Untracked file** — new work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

#### Diff & files — `components/diffs`, `components/files`, `DiffPanel*` (≈3,100 lines)

| Component                                                                          |  LOC | Verdict                     | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---: | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiffWorkerPoolProvider.tsx`                                                       |   84 | **PORTABLE-WITH-SEAM**      | Sizes the `@pierre/diffs` worker pool as `clamp(2, floor(hardwareConcurrency/2), 6)` with `totalASTLRUCacheSize: 240` and `tokenizeMaxLineLength: 1_000`, and re-syncs the Shiki theme on theme change. Two soft seams: the Vite-specific `import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"`, and an `effect/Schema` tagged error you would replace with a plain `Error`.                                                                                                                                                                                                                                                                                                                                               |
| `DiffPanelShell.tsx`                                                               |   88 | **PORTABLE-WITH-SEAM**      | Three exports: the shell (four layout modes `inline`/`sheet`/`sidebar`/`embedded`), `DiffPanelHeaderSkeleton`, and `DiffPanelLoadingState` (with `role="status" aria-live="polite"`). The only non-generic bit is the Electron branch: `const shouldUseDragRegion = isElectron && mode !== "sheet" && mode !== "embedded"`. Make it a prop. **~30 min.**                                                                                                                                                                                                                                                                                                                                                                               |
| `DiffPanel.tsx`                                                                    |  941 | COUPLED                     | Takes **three** props (`mode`, `composerDraftTarget`, `initialGitScope`); everything else comes from `useDiffPanelStore`, four atoms, `useClientSettings` — and, decisively, from the router: `const routeThreadRef = useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) })`. **The component derives its own identity from the host app's route table, so it cannot be mounted anywhere else without a route of the same shape.** Features: branch-vs-base-ref / unstaged / per-turn scopes with an `AUTOMATIC_BASE_REF` combobox, split vs stacked, wrap, whitespace-ignore, collapse-all, file search, open-in-editor. **The inverse of `ChatComposer`: same quality of UX, opposite wiring discipline.** |
| `diffs/AnnotatableCodeView.tsx`                                                    |  268 | **COUPLED — one seam**      | Wraps Pierre's `CodeView` to add inline review comments: restores persisted comment line-ranges against the current `FileDiffMetadata` (dropping any that no longer resolve), merges a live draft, and hashes `collapsed + entry ids/labels/text` through `fnv1a32` into a `version` so `CodeView` only re-renders on real change. Eight well-shaped props. **Single blocker: two reads of `useComposerDraftStore` (a 3,574-line persisted store). Replace with `reviewComments` + `onRemoveComment` props → clean generic annotatable diff. ~half a day.**                                                                                                                                                                            |
| `diffPanelStore.ts` (root)                                                         |  144 | PORTABLE-WITH-SEAM          | Persisted zustand map of thread → `{kind:"branch"}` \| `{kind:"unstaged"}` \| `{kind:"turn"}` variants (with `baseRef`, `turnId`, `filePath`, `revealRequestId`). Two nice details: a parallel `branchBaseRefByThreadKey` so branch→unstaged→branch restores the base ref, and `revealRequestId` incrementing so re-selecting the _same_ file re-triggers scroll-to-file. Only seam is `scopedThreadKey`. **~1 h.**                                                                                                                                                                                                                                                                                                                    |
| `files/FilePreviewPanel.tsx`                                                       |  951 | COUPLED                     | File viewer/editor: Pierre `VirtualizedFile`/`Editor`, debounced autosave (`FILE_SAVE_DEBOUNCE_MS = 500`), an auto-scrolling breadcrumb bar, signed-URL image branch, a Markdown preview/source toggle **with task-list checkboxes that write back to the file**, and line-reveal highlighting via injected CSS on `[data-file-link-reveal][data-line]`. Twelve props — more decoupled than its size suggests. **Blocker: `projectEnvironment.writeFile` plus the optimistic project-file query cache. The read/write path _is_ the component.**                                                                                                                                                                                       |
| `files/FileBrowserPanel.tsx`                                                       |  268 | COUPLED — two soft seams    | Wraps `@pierre/trees`' `FileTree`. Two removable blockers: `useProjectEntriesQuery` (→ an `entries` prop) and `useComposerHandleContext` (the drag-to-mention feature; deletable). **Its `TREE_UNSAFE_CSS` block — overriding `--trees-bg-override`, `--trees-selected-bg-override`, `--trees-hover-bg-override`, `--trees-font-family-override` etc. into the web component's shadow DOM — is reusable IP for anyone adopting `@pierre/trees`.**                                                                                                                                                                                                                                                                                      |
| `files/LocalCommentAnnotation.tsx`                                                 |   90 | **PORTABLE**                | Draft/saved comment card, six controlled props, zero domain imports. Both wrappers set `contentEditable={false}` and stop pointer-down propagation — necessary because it is injected into a Pierre editor's DOM.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `files/fileSaveCoordinator.ts`, `fileContentRevision.ts`, `fileEditorDismissal.ts` | ~400 | PORTABLE-WITH-SEAM          | Dirty-buffer / unsaved-changes coordination. Generic problem, decent solution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lib/diffRendering.ts`                                                             |  152 | **PORTABLE** (given Pierre) | Zero `@t3tools/*`, zero React. `buildPatchCacheKey` double-hashes plus length into `scope:len:primary:secondary`. `compactPartialHunkOffsets` carries a documented Pierre workaround — _"Pierre's partial-patch parser keeps hunk render starts in source-file coordinates. Its virtualizer iterates partial patches as compact rows…"_ — which is worth knowing before you adopt the library.                                                                                                                                                                                                                                                                                                                                         |

#### Terminal — `ThreadTerminalDrawer.tsx` (1,549) + support

**This is the best-isolated subsystem in the repo, and the isolation looks deliberate.** The
entire xterm footprint is **five files**: `main.tsx` (the CSS import), `ThreadTerminalDrawer.tsx`
(the only code importer), three CSS rules in `index.css` scoped to `.thread-terminal-drawer .xterm`,
and two test files.

`ThreadTerminalDrawer.tsx` contains two components and three exported pure helpers:

- **`TerminalViewport`** (line 295) — owns one xterm instance: `new Terminal()` + `new FitAddon()`,
  full-repaint on reattach (`terminal.write("\u001bc")`), keystroke forwarding, `FitAddon`-computed
  cols/rows over a resize RPC, hyperlink detection, click-to-open (editor or preview), and a
  selection-action popover with multi-click debounce.
- **`ThreadTerminalDrawer`** (line 894) — the chrome: tab strip, horizontal/vertical split groups,
  pointer-drag height resize (`MIN_DRAWER_HEIGHT = 180`, `MAX_DRAWER_HEIGHT_RATIO = 0.75`),
  shortcut dispatch. Its props interface is **26 fields wide and fully controlled**, and it
  **never reads the terminal zustand store** — the route owns that and pushes state down.
- Exported pure helpers: `resolveTerminalSelectionActionPosition`,
  `terminalSelectionActionDelayForClickCount`, `shouldHandleTerminalSelectionMouseUp`.

**The seam is not structural, it is the transport.** `TerminalViewport` is welded to four atom
commands:

```ts
const runTerminalWrite = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
const runTerminalResize = useAtomCommand(terminalEnvironment.resize, { reportFailure: false });
const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
```

plus `useAttachedTerminalSession(...)`. **Make `TerminalViewport` take `{ attach, write, resize }`
as a prop and the whole file ports** — the only remaining dependency is `~/components/ui/popover`.
Estimate 1–2 days.

Supporting modules:

| Module                                  | LOC | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal-links.ts`                     | 286 | **PORTABLE — best-in-class file in the repo.** _One_ import in the whole file: `isMacPlatform` from `./lib/utils`. Zero third-party. It decouples from xterm by declaring its own structural type — `interface TerminalBufferLineLike { readonly isWrapped?: boolean; translateToString(trimRight?: boolean): string }`. Handles `~/`, `./`, `/`, `C:\`, UNC `\\`, bare `a/b/c.ts:12:5`, balanced trailing `)]}`, and reassembly across wrapped buffer rows.                                                                             |
| `terminalUiStateStore.ts`               | 781 | **PORTABLE-WITH-SEAM (~2 h).** Persisted zustand (`"t3code:terminal-state:v1"`) of per-thread `{terminalOpen, terminalHeight, terminalIds, activeTerminalId, terminalGroups, activeTerminalGroupId}`. Most of the file is _unexported_ pure transitions (`splitThreadTerminal`, `normalizeTerminalGroups`, `reconcileThreadTerminalSessionIds`…). Note the second map, `suppressedTerminalIdsByThreadKey` — closed ids hidden from stale server metadata until explicitly reopened. Only seam: `scopedThreadKey`/`parseScopedThreadKey`. |
| `packages/shared/src/terminalLabels.ts` |  40 | **PORTABLE.** `getTerminalLabel`, `resolveTerminalSessionLabel`, `nextTerminalId`. Type-only contracts import. Documents that terminal ids are **always client-allocated**.                                                                                                                                                                                                                                                                                                                                                              |
| `lib/terminalUiStateCleanup.ts`         |  33 | PORTABLE-WITH-SEAM. GC of persisted UI state for deleted/archived threads.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `state/terminal.ts`                     |   5 | **Not liftable — it _is_ the coupling.** The whole file is `createTerminalEnvironmentAtoms(connectionAtomRuntime)`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `state/terminalSessions.ts`             |  90 | Not liftable. Pure adapter over `terminalEnvironment` atoms; nothing remains once they go.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

#### Preview & embedded browser — `components/preview` (44 files) + `browser` (25 files), 8,641 lines with tests

**Correct the mental model first: this is not a component tree with an iframe in it. It is an
Electron host.** The embedded browser is a native `<webview>` element positioned by the DOM, and
the entire subsystem gates on a nine-line module:

```ts
// apps/web/src/components/preview/previewBridge.ts — the whole file
export const previewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);
```

`PreviewPanel.tsx` (41 lines) exists only to check `isPreviewSupportedInRuntime()` and render
_"Preview is only available in the T3 Code desktop app."_ **No amount of prop-lifting changes
this.** Anything downstream of `previewBridge` or the `<webview>` tag is a host reimplementation,
not a component port.

What _is_ worth taking:

| Component                                                                               | LOC | Verdict                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | --: | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`browser/BrowserSurfaceSlot.tsx`**                                                    |  45 | **PORTABLE — take this regardless** | The clever bit of the whole architecture: an empty `<div data-browser-surface-slot={tabId}>` that measures itself via `ResizeObserver` + window `resize` + capture-phase `scroll` and publishes its rect to a lease, so an out-of-tree native surface can be positioned _as if_ it were in the React tree. Imports `react` + one local zustand store (170 lines). **Reusable for any out-of-tree overlay — native video, canvas, map, WebGL.** |
| **`preview/PreviewChromeRow.tsx`**                                                      | 291 | **PORTABLE**                        | Back/forward/reload, URL `InputGroup` with a loading progress bar, screenshot/record, element-picker toggle, open-in-browser, plus a `trailingActions: ReactNode` slot. **Zero `@t3tools/*`, zero `~/state/*`.** 20 fully controlled props. Only cost is the `ui/` kit.                                                                                                                                                                        |
| **`preview/useLoadingProgress.ts`**                                                     |  45 | **PORTABLE**                        | Indeterminate progress simulator — seeds at 4%, approaches 90% asymptotically (`increment = max(0.5, remaining * 0.08)` per 120 ms), snaps to 100% on release, resets after 220 ms. **Zero imports except React.**                                                                                                                                                                                                                             |
| `preview/ZoomIndicator.tsx`                                                             |  54 | **PORTABLE**                        | Transient "X%" pill; suppresses the first render so it does not flash 100% on mount.                                                                                                                                                                                                                                                                                                                                                           |
| `preview/BrowserMockup.tsx`                                                             |  24 | **PORTABLE**                        | Decorative browser-window glyph. One import: `cn`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `preview/RightPanelResizeHandle.tsx`                                                    |  34 | **PORTABLE**                        | `role="separator"` drag rail, 2px hit area over a 1px line.                                                                                                                                                                                                                                                                                                                                                                                    |
| `preview/PreviewUnreachable.tsx`, `PreviewPanelShell.tsx`, `PreviewLocalServerCard.tsx` | 230 | PORTABLE                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `preview/PreviewEmptyState.tsx`                                                         |  65 | PORTABLE-WITH-SEAM                  | Presentational shell is clean; blocker is `useDiscoveredLocalServers` (138 lines, server port discovery). Pass `servers` as a prop → fully portable.                                                                                                                                                                                                                                                                                           |
| `preview/AgentBrowserCursor.tsx`                                                        |  78 | PORTABLE-WITH-SEAM (~1 h)           | Remote-agent cursor with a click ping ring, auto-fading after `CURSOR_ACTIVE_MS = 700`. Its transform composes zoom × content scale × content origin − scroll offset. Only seam: two zustand reads → props. **Genuinely reusable for any collaborative or agentic UI.**                                                                                                                                                                        |
| `browser/browserViewportLayout.ts`                                                      | 286 | PORTABLE (~30 min)                  | Pure geometry: fit-to-panel scaling where `viewportScale` is presentation-only (the guest keeps its requested CSS viewport). Inline three numeric constants from contracts and it moves.                                                                                                                                                                                                                                                       |
| `browser/BrowserViewportResizeHandles.tsx`                                              | 169 | PORTABLE (~1 h)                     | Eight keyboard-accessible resize rails with corner mirroring.                                                                                                                                                                                                                                                                                                                                                                                  |
| `browser/useBrowserViewportResize.ts`                                                   | 260 | PORTABLE-WITH-SEAM                  | Drag + keyboard resize state machine; versions drags to discard stale pointer streams; `KEYBOARD_RESIZE_COMMIT_DELAY_MS = 150`.                                                                                                                                                                                                                                                                                                                |
| `browser/BrowserDeviceToolbar.tsx`                                                      | 340 | PORTABLE-WITH-SEAM (~half a day)    | Device presets, editable W/H, aspect-ratio lock, inline rotation SVG. Soft blocker: `PREVIEW_VIEWPORT_MAX_AREA` / `_MAX_DIMENSION` / `_MIN_DIMENSION` and `PREVIEW_VIEWPORT_PRESETS` are runtime values from contracts/shared — inline them.                                                                                                                                                                                                   |
| **`browser/annotationTheme.ts`**                                                        |  28 | **PORTABLE as a pattern**           | Reads 17 CSS custom properties off `documentElement` with hardcoded fallbacks and ships them across the IPC boundary. **The "serialise my CSS-variable theme for a foreign document" trick is generic** — same problem as theming an iframe or a shadow root.                                                                                                                                                                                  |

**Not liftable, blocker named:** `PreviewView.tsx` (666 — `previewBridge`),
`PreviewAutomationHosts.tsx` (608 — zero props, 100% global reach-in; it is protocol, not a
component; declares six tagged error classes and polls `previewBridge.automation.status` on a
50 ms deadline loop), `HostedBrowserWebview.tsx` (261 — the Electron `<webview>` tag itself, which
it declares into `HTMLElementTagNameMap`), `ElectronBrowserHost.tsx` (92 —
`window.desktopBridge.preview`; notable for re-syncing guest theme on a `MutationObserver` over
both `documentElement` and `document.head`), `browserRecording.ts` (455 — canvas frame recorder
over IPC, five Effect tagged errors).

#### Sidebar & navigation

| Component                                                                             |   LOC | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/sidebar.tsx`                                                                      | 1,028 | **PORTABLE-WITH-SEAM** — the generic shadcn-lineage sidebar primitive: `SidebarProvider` (context with `state`/`open`/`openMobile`/`isMobile`/`toggleSidebar`), cookie persistence (`sidebar_state`, 7-day max-age), mobile `Sheet` fallback, `SidebarRail` drag-resize via `useResizableWidth`, icon-collapsed mode, `SidebarMenu`/`SidebarMenuButton`/`SidebarMenuSkeleton`. Only seam is `effect/Schema` at two lines.                                                                            |
| `Sidebar.tsx`                                                                         | 3,643 | APP-SPECIFIC — v1 thread list. **The only file in the repo using `@dnd-kit`** (all four packages: `core`, `modifiers`, `sortable`, `utilities`) for drag-reorder, and one of two using `@formkit/auto-animate`. Also uniquely carries desktop-local bootstrap, port discovery, desktop-update and preview/terminal-session reads.                                                                                                                                                                    |
| `SidebarV2.tsx`                                                                       | 2,732 | APP-SPECIFIC — v2 thread list, selected by the `sidebarV2Enabled` client setting and the `[data-sidebar-version]` attribute that re-scopes the palette (§3.1). **Not a refactor of v1 — a different feature set.** It drops all four `@dnd-kit` packages, drops desktop-local/port-discovery/desktop-update, and adds provider-instance icons, `BranchToolbar.logic`, snooze, `useNowMinute`, `useCopyToClipboard` and `client-runtime/state/models`. Two thread lists coexist in the shipped build. |
| `AppSidebarLayout.tsx`                                                                |   188 | APP-SPECIFIC — chooses v1/v2, wires the resizable width, hosts the titlebar inset logic.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SidebarStageBackdrop.tsx`                                                            |   330 | PORTABLE-WITH-SEAM — decorative "stage" artwork behind the sidebar header, with a variant hook (`useSidebarStageBackdropVariant`) also consumed by `ComposerPrimaryActions`.                                                                                                                                                                                                                                                                                                                         |
| `sidebar/SidebarChrome.tsx`, `SidebarUpdatePill.tsx`, `SidebarProviderUpdatePill.tsx` |   569 | APP-SPECIFIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `threadSidebarWidth.ts`, `lib/threadSort.ts`, `Sidebar.logic.ts`, `Sidebar.snooze.ts` |  ~700 | APP-SPECIFIC (but `threadSidebarWidth.ts` is a clean min/max clamp worth copying)                                                                                                                                                                                                                                                                                                                                                                                                                    |

#### Command palette

`CommandPalette.tsx` (2,094) + `CommandPalette.logic.ts` + `CommandPaletteResults.tsx` (146),
built on `ui/command.tsx` (240) which itself wraps `ui/autocomplete.tsx` (271) in a
`Base UI Dialog`. Opened via `commandPaletteBus.ts` — a tiny module-level event bus
(`openCommandPalette()` / `isCommandPaletteOpen()`) rather than a store, which is why any file can
trigger it without a prop chain.

- `ui/command.tsx` + `ui/autocomplete.tsx`: **PORTABLE**. This is the reusable half.
  `command.tsx` shares `DIALOG_BACKDROP_CLASS`/`DIALOG_POPUP_CLASS` with `dialog.tsx`, so the
  palette inherits the nested-dialog stacking described in §3.2.
- `CommandPalette.tsx`: **COUPLED**. Its only prop is `{ children }`; its open/closed state is a
  `useReducer` over `{ open, openIntent }` with actions `SetOpen | Toggle | OpenAddProject |
OpenNewThreadIn | ClearOpenIntent` — a clean pattern worth copying. Its command _sources_ are
  threads, projects, providers, models, settings routes, project scripts, filesystem browse
  results and source-control discovery, and it reads `useParams`.
- `packages/shared/src/searchRanking.ts`: **PORTABLE** — the fuzzy scorer.

#### Settings — `components/settings` (31 files, 11,978 lines)

There **is** a shared scaffold and it is better than its size suggests. `settingsLayout.tsx`
(129 lines, **zero domain imports**) exports five things that together are a complete settings
framework:

| Export                                   | What it is                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SettingsPageContainer`                  | Scrolling page frame — `max-w-4xl`, `gap-12`, `settings-page-scroll-fade`, `scrollbar-gutter-both`                                                                                 |
| `SettingsSection`                        | `<section>` with an icon + title header and a `headerAction` slot                                                                                                                  |
| `SettingsRow`                            | The workhorse: `{title, description, status?, resetAction?, control?, children?}` on a `sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)]` label/control grid that stacks below `sm` |
| `SettingResetButton`                     | The tooltip'd `Undo2Icon` "reset to default" affordance that appears next to an overridden setting                                                                                 |
| `useRelativeTimeTick(intervalMs = 1000)` | Re-render tick returning a stable `nowMs` for render-time relative labels                                                                                                          |

Plus `itemRows.ts` — two exported class-name constants (`ITEM_ROW_CLASSNAME`,
`ITEM_ROW_INNER_CLASSNAME`) so non-`SettingsRow` rows stay on the same rhythm. The convention
comment is explicit: _"Whitespace, rather than rules, separates peers."_

**All of this is PORTABLE and is the right thing to harvest from `components/settings`.**
Also portable from that directory:

- `SettingsSidebarNav.tsx` (127) — nav rail; zero domain imports.
- `RedactedSensitiveText.tsx` (61) — masked secret with reveal toggle.
- `ProviderAccentColorPicker.tsx` (335) and `color-selector.tsx` (101) — zero domain imports.
- `AddProviderInstanceWizardSteps.tsx` (73) — a generic step indicator.

Everything else — `ConnectionsSettings.tsx` (3,398), `SettingsPanels.tsx` (1,765),
`DiagnosticsSettings.tsx` (1,397), `KeybindingsSettings.tsx` (1,337), `ProviderInstanceCard.tsx`
(806), `SourceControlSettings.tsx` (518), `ProviderModelsSection.tsx` (411),
`AddProviderInstanceDialog.tsx` (437), `ProviderSettingsForm.tsx` (304) — is **APP-SPECIFIC**.
Each panel is bespoke against `UnifiedSettings`/`ServerSettings` from contracts, composed out of
`SettingsSection` + `SettingsRow`. There is **no schema-driven settings generator** to harvest;
there is a _scaffold plus a convention_, and that is genuinely most of the value.

Note the pervasive `X.tsx` / `X.logic.ts` / `X.logic.test.ts` split (`ConnectionsSettings`,
`SettingsPanels`, `KeybindingsSettings`, `AddProviderInstanceDialog`, `ProviderSettingsForm`,
`Sidebar`, `ChatView`, `BranchToolbar`, `GitActionsControl`, `CommandPalette`,
`MessagesTimeline`…). **This convention is the single most valuable thing to copy from the repo
even if you take no code**: every non-trivial component has its decision logic in a sibling pure
module with its own test file, which is why so much of the logic layer above is classified
PORTABLE while the components are not.

#### Git / VCS surface

| Component                                 |   LOC | Verdict                                                                                                                                                     |
| ----------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitActionsControl.tsx`                   | 2,035 | APP-SPECIFIC — commit/push/PR/stacked-action orchestration with progress stages. `GitActionsControl.logic.ts` holds the state machine and is worth reading. |
| `BranchToolbar.tsx` + 3 selectors         | 1,412 | APP-SPECIFIC                                                                                                                                                |
| `PullRequestThreadDialog.tsx`             |   304 | APP-SPECIFIC                                                                                                                                                |
| `ProjectScriptsControl.tsx`               |   623 | APP-SPECIFIC — but contains an inline "press a key combination to bind" capture (`keybindingFromKeyboardEvent`) worth extracting                            |
| `components/Icons.tsx` git provider icons |     — | PORTABLE (see §3.3)                                                                                                                                         |

#### Auth, cloud, onboarding, notifications

| Component                                                                                                                                         |   LOC | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/AuthSurfaceShell.tsx`                                                                                                                       |    44 | **PORTABLE** — centred card shell for auth screens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `auth/PairingRouteSurface.tsx`                                                                                                                    |   323 | APP-SPECIFIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `clerk/*` (4 files, 283)                                                                                                                          |     — | APP-SPECIFIC — Clerk-bound. **The Clerk blast radius is small: exactly 7 non-test files import `@clerk/*`** — `main.tsx`, `cloud/managedAuth.tsx`, `cloud/useCloudLinkController.ts`, `clerk/T3ConnectSidebarSignIn.tsx`, `clerk/useT3ConnectAuthPrompt.tsx`, `cloud/ConnectCliAuthSurface.tsx`, `cloud/ConnectOnboardingDialog.tsx`. And it is **conditionally mounted**: `main.tsx` wraps the app in `ClerkProvider` only when `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY` is set _and_ `hasCloudPublicConfig()`; otherwise it renders the bare app. Auth is genuinely optional in this frontend. |
| `cloud/*` (6 files, 1,062)                                                                                                                        |     — | APP-SPECIFIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `desktop/SshPasswordPromptDialog.tsx`                                                                                                             |   221 | PORTABLE-WITH-SEAM — a decent modal password prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ProviderUpdateLaunchNotification.tsx` / `ProviderUpdatePrimaryNotification.tsx` / `ProviderUpdateEnvironmentRows.tsx` / `ServerUpdateAction.tsx` | 1,127 | APP-SPECIFIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SlowRpcRequestToastCoordinator.tsx`                                                                                                              |    73 | PORTABLE-WITH-SEAM — **the pattern is worth stealing**: it watches request latency (`rpc/requestLatencyState.ts`, 135 lines, threshold-based) and raises a toast when a request has not been acknowledged in time. Generic to any RPC client.                                                                                                                                                                                                                                                                                                                                                        |
| `ConnectionStatusDot.tsx`                                                                                                                         |    56 | **PORTABLE**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SplashScreen.tsx`                                                                                                                                |     9 | PORTABLE (trivial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NoActiveThreadState.tsx`                                                                                                                         |    44 | PORTABLE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AnimatedHeight.tsx`                                                                                                                              |    91 | **PORTABLE** — measures `scrollHeight` across two rAFs, animates the height, and clears the clip after a 250 ms fallback timeout so content is never permanently clipped if the transition event is missed. Zero imports beyond React.                                                                                                                                                                                                                                                                                                                                                               |
| `RightPanelTabs.tsx`                                                                                                                              |   497 | PORTABLE-WITH-SEAM — a closable, reorderable tab strip with per-tab favicon and context menu. Its only domain deps are `PreviewSessionSnapshot` and `RightPanelSurface`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RightPanelSheet.tsx`                                                                                                                             |    30 | PORTABLE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ProjectFavicon.tsx`                                                                                                                              |    76 | PORTABLE-WITH-SEAM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ThreadStatusIndicators.tsx`                                                                                                                      |   358 | APP-SPECIFIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

### 3.7 The provider stack a port must recreate

Worth stating explicitly, because it is shorter than you would expect and it tells you exactly
what a harvested component assumes is above it.

`main.tsx` (54 lines):

```
React.StrictMode
└─ ClerkProvider | ElectronClerkProvider        ← only if VITE_CLERK_PUBLISHABLE_KEY && hasCloudPublicConfig()
   └─ ManagedRelayAuthProvider                  ← same condition
      └─ AppRoot
```

`AppRoot.tsx` (the entire component body):

```tsx
<AppAtomRegistryProvider>
  {" "}
  {/* RegistryContext.Provider from @effect/atom-react */}
  <RouterProvider router={router} />
  <PreviewAutomationHosts /> {/* headless */}
  <ElectronBrowserHost /> {/* headless, returns null when !isElectron */}
</AppAtomRegistryProvider>
```

`routes/__root.tsx` then adds, inside the router:

```
<ToastProvider>
  <AnchoredToastProvider>
    … AppSidebarLayout · CommandPalette · ConnectOnboardingDialog ·
      RelayClientInstallDialog · SshPasswordPromptDialog ·
      ProviderUpdateLaunchNotification · SlowRpcRequestToastCoordinator
  </AnchoredToastProvider>
</ToastProvider>
```

**There is no theme provider and no tooltip provider at the root.** Theming is CSS-class-based
(`useTheme` syncs a `.dark` class and `<meta name="theme-color">`), and `TooltipProvider` is
mounted locally where needed — e.g. inside `ModelPickerContent.tsx`. `DiffWorkerPoolProvider` is
likewise mounted per-surface, not globally.

Practical consequence: **a harvested component's only hard ambient requirement is the toast
provider** (34 files call `toastManager`) and, for anything domain-facing, the atom registry.
Everything else is local.

---

## 4. The interaction flows worth stealing

Ranked by (value × portability). For each: composing components, required state, and what a port
costs.

### 4.1 The composer — ★ the crown jewel

**Composes:** `ChatComposer.tsx` (2,747) → `ComposerPromptEditor.tsx` (1,842, Lexical) +
`ComposerCommandMenu.tsx` + `ComposerPrimaryActions.tsx` + `ComposerBannerStack.tsx` +
`ComposerPendingApprovalPanel/Actions` + `ComposerPendingUserInputPanel` +
`ComposerPendingElementContexts/ReviewComments/TerminalContexts/PreviewAnnotationCards` +
`ProviderModelPicker` + `ContextWindowMeter` + `CompactComposerControlsMenu`.
Logic: `composer-logic.ts`, `composer-editor-mentions.ts`, `composerFooterLayout.ts`,
`composerMenuHighlight.ts`, `composerSlashCommandSearch.ts`, `composerMentionDrag.ts`,
`composerInlineTokenPaste.ts`, `composerInlineChip.ts`.

**State it needs:** the prompt text, a cursor offset, an attachment list, a list of "contexts"
(files, terminal selections, DOM elements, review comments), a model selection, and a
send-enabled predicate. `ChatComposer` receives **all of it as props** — its `ChatComposerProps`
interface is ~60 fields and the only global store it touches is `useComposerDraftStore`.

**What makes it worth stealing, specifically:**

- **Dual cursor representation.** The user sees `@utils.ts`; the model sees
  `[file](file:///abs/path/utils.ts)`. `expandCollapsedComposerCursor` /
  `collapseExpandedComposerCursor` in `composer-logic.ts` map an offset between the two so that
  arrow keys, selection and paste all behave. This is the hard part of a chip-based composer and
  it is 130 lines of pure, tested function.
- **Chips as Lexical `DecoratorNode`s**, not as string markers, so backspace deletes a whole chip
  and the cursor cannot land inside one (`isCollapsedCursorAdjacentToInlineToken`).
- **Trigger detection** (`detectComposerTrigger`) that distinguishes `@path`, `/command` and
  skill triggers from the same cursor position.
- **Approval and question panels rendered _inside_ the composer**, not as modals — the composer
  becomes the single place the user answers anything. `ComposerPendingApprovalActions` is 55
  lines for a four-way approval decision.
- **Drag-and-drop of file mentions** (`composerMentionDrag.ts` + `dataTransferHasComposerMention`)
  from the file tree straight into the prompt.

**Port cost:** Medium. Replace `ServerProviderSkill` with a generic `{name, displayName}` (already
what the prop type narrows to in `ChatMarkdown`), replace `useComposerDraftStore` with a
caller-supplied controlled value, and drop the provider/model/traits row. Estimate: the editor +
logic modules port in a day; the full `ChatComposer` shell is a rewrite that _uses_ them.

### 4.2 Streaming message rendering

**Composes:** `MessagesTimeline.tsx` (2,081) + `MessagesTimeline.logic.ts` +
`timelineScrollAnchoring.ts` + `ChatMarkdown.tsx` (1,566) + `.chat-markdown` CSS (~350 lines) +
`session-logic.ts`'s `deriveTimelineEntries` / `deriveWorkLogEntries`.

**State it needs:** an ordered list of entries (user message / assistant message / work-log tool
call / plan / diff summary), a "which turn is running" id, and a scroll anchor.

**What to steal:**

- `remarkNormalizeListItemIndentation` — fixes LLM list indentation. 143 lines, zero deps,
  immediately useful in any LLM UI.
- The **highlight cache**: `LRUCache<string>(500, 50 MB)` keyed on content+language, plus a
  `Map<string, Promise<DiffsHighlighter>>` so concurrent renders share one highlighter boot, plus
  a `CodeHighlightErrorBoundary` class component that falls back to plain `<pre>` if Shiki throws.
- **`isStreaming` as a first-class prop** on `ChatMarkdown` — rendering behaviour differs while
  tokens are still arriving.
- The **scroll minimap** in `MessagesTimeline` (`resolveTimelineMinimapIndexFromPointer`,
  `…TopPercent`, `…HitStripWidth` — all pure and tested) — a hover-expanding gutter strip that
  jumps to a message.
- **Anchored scrolling**: `resolveChatListAnchoredEndSpace` from `@t3tools/shared/chatList` +
  `getAnchoredTurnMetrics`, which keeps a newly-sent user message pinned to the top of the
  viewport while the response streams in below it.
- The **table copy affordance**: `serializeTableElementToMarkdown` / `…ToCsv`.

**Port cost:** High for the timeline (30 domain-shaped props), **low for `ChatMarkdown` once the
five state imports become an `onOpenFile` / `onOpenUrl` context**, low for the CSS.

### 4.3 Approvals and permission prompts

**Composes:** `derivePendingApprovals` / `derivePendingUserInputs` (`session-logic.ts`) →
`ComposerPendingApprovalPanel` (49) + `ComposerPendingApprovalActions` (55) +
`ComposerPendingUserInputPanel` (227) + `pendingUserInput.ts` (172).

**State it needs:** `PendingApproval { requestId, requestKind: "command"|"file-read"|"file-change", detail }`
and `PendingUserInput { requestId, questions: {id, header, question, multiSelect, options}[] }`.
Both are declared in `session-logic.ts` and are plain structural types.

**Port cost: Low — this is the cheapest high-value flow in the repo.** ~500 lines total including
logic and tests. Any app that needs "the backend is asking the user something, inline, without a
modal" can take this nearly verbatim.

### 4.4 Toasts

`ui/toast.tsx` (813) + `toast.logic.ts` (115) + `toastHelpers.ts` (58), on `@base-ui/react/toast`.
Used in **34 files** — the most-used non-Button primitive.

Two providers exist and are **nested** in `routes/__root.tsx` — `<ToastProvider>` (default
`position="top-right"`) wrapping `<AnchoredToastProvider>` (lines 127–141) — so a toast can be
raised either globally or anchored to a surface. Both share one
`Toast.createToastManager<ThreadToastData>()` at line 77. The helper API is `toastManager.add(stackedThreadToast({ type, title,
description, timeout, priority, actionProps, actionVariant, data }))`, where `actionLayout` is
forced to `"stacked-end"` by the helper regardless of caller data — the comment is explicit:
_"Helper-owned `actionLayout` must win over any caller-provided `data`."_

**Why it is COUPLED and not merely seamed:** `toast.tsx` imports `useParams` from
`@tanstack/react-router`, `ScopedThreadRef`/`ThreadId` from contracts, `useComposerDraftStore`,
and `resolveThreadRouteTarget` from `~/threadRoutes`. The reason is a real product feature:
a toast raised on thread A while you are looking at thread B renders a "go to thread" action and
suppresses itself when you are already there.

**Port cost:** Medium. Either strip the thread-awareness (≈40 lines) and keep a plain
Base-UI-backed toast system, or generalise it as `{ contextId, currentContextId, onNavigate }`.
The second is better and is a ~2-hour change. **(inferred)**

### 4.5 Diff review

**Composes:** `DiffWorkerPoolProvider` → `DiffPanel` (941) → `DiffPanelShell` (88) →
`@pierre/diffs`' `FileDiff` + `AnnotatableCodeView` (268), with `diffRendering.ts`,
`diffCollapse.ts`, `turnDiffTree.ts`, `checkpointDiffState.ts`, `diffPanelStore.ts` (zustand),
`ChangedFilesTree.tsx`, `DiffStatLabel.tsx`, and `reviewCommentContext.ts` (459).

**State it needs:** a patch list, a per-file collapsed set, a view mode (split/unified), wrap and
whitespace flags, and a selection→comment buffer.

**Port cost:** Medium-high, and **the cost is mostly the dependency, not the code**.
`@pierre/diffs` is a 1.3.0-**beta** package that is **pnpm-patched** in this repo to disable
gutter utility, line selection and line-hover highlighting; `@pierre/trees` is 1.0.0-beta.4 and
drags in `preact@11.0.0-beta.0`. Both are public and Apache-2.0, so this is a _risk_ decision, not
an access problem. `DiffPanel.tsx` itself is a rewrite — three props and a `useParams` call that
binds it to the host route table. The liftable parts are `DiffPanelShell` (~30 min),
`DiffWorkerPoolProvider` (~1 h), `diffPanelStore.ts` (~1 h), `lib/turnDiffTree.ts` +
`lib/diffCollapse.ts` + `lib/diffRendering.ts` (copy-paste), `ChangedFilesTree` (~2 h),
`LocalCommentAnnotation` (copy-paste), and `AnnotatableCodeView` once its two
`useComposerDraftStore` reads become props (~half a day).

### 4.6 Terminal panes

**Composes:** `ThreadTerminalDrawer.tsx` (1,549 — `TerminalViewport` + the drawer shell) +
`terminalUiStateStore.ts` (781, zustand, persisted) + `terminal-links.ts` (286) +
`@t3tools/shared/terminalLabels` (40) + `state/terminalSessions.ts` (90).

**Features:** tabbed terminals, horizontal and vertical split groups, pointer-drag height resize
clamped to `[180px, 0.75 × viewport]`, xterm theme derived from the app theme, selection →
"add to composer as context" popover with multi-click debounce, clickable URLs _and_
`file:line:col` paths reassembled across wrapped buffer rows, open-link-in-preview, and ~9
keyboard shortcuts.

**Port cost:** Medium (1–2 days). Everything except the byte stream is generic, and the drawer is
already 26-prop-controlled with no store reads of its own. The one required seam is
`useAttachedTerminalSession` + the three `terminalEnvironment`/`previewEnvironment` atom commands
→ a single `{ attach, write, resize }` transport prop. `terminal-links.ts` and `terminalLabels.ts`
port with zero changes. **This is the flow with the best effort-to-value ratio in the repo after
the design system itself.**

### 4.7 Keyboard shortcut system

**Composes:** `packages/shared/src/keybindings.ts` (parse/compile/`DEFAULT_KEYBINDINGS`) →
`apps/web/src/keybindings.ts` (529, resolve/format/predicates) → `shortcutModifierState.ts` (96) →
`components/settings/KeybindingsSettings.tsx` (1,337) + `.logic.ts` →
`lib/projectScriptKeybindings.ts`.

**Architecture:** VS Code-shaped. A rule is `{ key, command, when }`; `parseKeybindingShortcut`
turns `"cmd+shift+p"` into a structured shortcut; `parseKeybindingWhenExpression` compiles a
`when` clause into a small AST; `compileResolvedKeybindingsConfig` produces a
`ResolvedKeybindingsConfig`. At runtime, `resolveShortcutCommand(event, config, context)` returns
the matching command name.

**Dispatch is deliberately not centralised — and it is the weakest part of the design.**
There are **16 separate `addEventListener("keydown", …)` registrations** across
`apps/web/src`, and `resolveShortcutCommand(` is called from **7 files** outside
`keybindings.ts`: `routes/_chat.tsx`, `ChatView.tsx`, `Sidebar.tsx`, `SidebarV2.tsx`,
`AppSidebarLayout.tsx`, `CommandPalette.tsx`, `chat/ModelPickerContent.tsx`. Other surfaces
(terminal drawer, diff panel) call the `isXShortcut` predicates directly instead. Focus
arbitration is done with **module-level boolean flags** — `isTerminalFocused()` and
`isPreviewFocused()` in `lib/terminalFocus.ts` (14 lines) and `lib/previewFocus.ts` (15 lines).

It is crude, and it works, and it avoids a context provider that every component would have to be
inside. **Copy the config/resolution half; design your own dispatch.** A receiving project that
adopts the 16-listener pattern will regret it. _(inference — no bug was observed, this is a
judgement about maintainability)_

**Port cost:** Low-medium. `packages/shared/src/keybindings.ts` and `shortcutModifierState.ts`
port as-is. `apps/web/src/keybindings.ts` needs its ~20 app-specific `isXShortcut` predicates
replaced with your own command names, but `resolveShortcutCommand` / `formatShortcutLabel` /
`shortcutLabelForCommand` are generic. The settings editor (`keybindingFromKeyboardEvent` capture

- conflict detection) is 1,337 lines of genuinely tedious work you would otherwise redo.

### 4.8 Command palette

**Composes:** `commandPaletteBus.ts` → `CommandPalette.tsx` (2,094) + `CommandPalette.logic.ts` +
`CommandPaletteResults.tsx` → `ui/command.tsx` (240) → `ui/autocomplete.tsx` (271) →
`@base-ui/react/autocomplete` + `dialog`. Ranking by `packages/shared/src/searchRanking.ts`.

**Port cost:** Low for the shell (`ui/command.tsx` + `ui/autocomplete.tsx` + `searchRanking.ts` are
all portable), high for the palette itself (its sources are threads/projects/providers/models).
The right harvest is the shell plus the _shape_: a bus for opening, a logic module for building
the item list, a results component for rendering.

### 4.9 Session / thread switching

**Composes:** `threadSelectionStore.ts` (122, zustand — multi-select), `threadRoutes.ts` (103),
`lib/threadSort.ts`, `sidebarProjectGrouping.ts` (262), `Sidebar.tsx`/`SidebarV2.tsx`,
`hooks/useThreadActions.ts` (580), `hooks/useHandleNewThread.ts` (325),
`lib/archivedThreadsState.ts`, `Sidebar.snooze.ts`, `historyBootstrap.ts`.

**Notable:** multi-select with shift-range and ⌘-click, drag-reorder via `@dnd-kit` (the only
place it is used), list transitions via `@formkit/auto-animate`, snooze, archive with undo toast,
worktree cleanup on delete, and ⌘1–9 thread jump with hint numbers that appear while ⌘ is held
(`shortcutModifierState.ts` + `shouldShowThreadJumpHints`).

**Port cost:** High. This is where the domain lives. **The ⌘-held-shows-jump-hints pattern is
worth stealing on its own** — it is ~100 lines across `shortcutModifierState.ts` and four helpers
in `keybindings.ts`.

### 4.10 File tree

`components/files/FileBrowserPanel.tsx` (268) over `@pierre/trees`, with `pierre-icons.ts` (117)
resolving per-file icons from a built-in sprite sheet plus a T3 override sprite, and
`fileTreeDragMention.ts` letting a dragged file become a composer mention.
`lib/turnDiffTree.ts` (172) is the separate, **fully portable** path→tree folder with
single-child-directory collapsing.

**Port cost:** Low if you accept `@pierre/trees` (beta); low anyway for `turnDiffTree.ts`.

### 4.11 Right-panel / workspace layout

`AppSidebarLayout.tsx` (188) + `ui/sidebar.tsx` (1,028) + `rightPanelStore.ts` (560, zustand,
persisted per thread) + `RightPanelTabs.tsx` (497) + `RightPanelSheet.tsx` +
`rightPanelLayout.ts` + `hooks/useResizableWidth.ts` + `PanelLayoutControls.tsx` (112).

Three-column workspace (sidebar / chat / right panel), each independently resizable and
persisted, with the right panel hosting a **tabbed** stack of surfaces (diff, preview, terminal,
files, plan) rather than a fixed pane. On mobile the right panel becomes a `Sheet`.

**Port cost:** Medium. `ui/sidebar.tsx`, `useResizableWidth`, `RightPanelTabs` and
`PanelLayoutControls` are all portable or nearly so; the store that decides _which surface is
active for which thread_ is domain.

---

## 5. Proposed library structure

Five packages. Dependencies point **strictly downward** — no package may import from one below it
in this list.

```
┌───────────────────────────────────────────────────────────────┐
│ 5. @x/agent-chat        chat-shaped features (opinionated)    │
│    depends on 1,2,3,4                                          │
├───────────────────────────────────────────────────────────────┤
│ 4. @x/panels            workspace layout & surfaces            │
│    depends on 1,2,3                                            │
├───────────────────────────────────────────────────────────────┤
│ 3. @x/ui-hooks          headless React hooks                   │
│    depends on nothing but react                                │
├───────────────────────────────────────────────────────────────┤
│ 2. @x/ui                Base UI primitives + cn                │
│    depends on 1, 3                                             │
├───────────────────────────────────────────────────────────────┤
│ 1. @x/theme             CSS tokens, fonts, utilities           │
│    depends on nothing                                          │
└───────────────────────────────────────────────────────────────┘
        ┌──────────────────────────────────────────┐
        │ 0. @x/text-logic   framework-free logic  │  (no react)
        │    depended on by 2,4,5                  │
        └──────────────────────────────────────────┘
```

### `@x/theme` — CSS only, no JS

| Contents                                                                                                                  | From                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `tokens.css` — `@theme inline` block + `:root`/`@variant dark` palette                                                    | `index.css` 117–170, 813–895    |
| `surfaces.css` — `.dialog-glass`, `.dropdown-glass`, `.alert-glass`, `.surface-subheader`, reduced-transparency fallbacks | `index.css` `@layer components` |
| `utilities.css` — `pt-safe`/`pb-safe`/`pl-safe`/`pr-safe`, `surface-grain`, `.no-transitions`                             | `index.css` 782–812             |
| `animations.css` — `skeleton`, `status-pulse`, `status-ping` keyframes                                                    | `index.css` 171–222             |
| `markdown.css` — the `.chat-markdown` block                                                                               | `index.css` 1,092–1,440         |
| `scrollbars.css`                                                                                                          | `index.css` 1,030–1,055         |

Requires Tailwind v4. Ships fonts as peer deps (`@fontsource-variable/dm-sans`,
`@fontsource/jetbrains-mono`).

### `@x/ui` — 41 files, ~4,000 lines, ~zero changes

Everything in `components/ui` **except** `toast.tsx` / `toast.logic.ts` / `toastHelpers.ts`
(→ `@x/panels`), plus a new `cn.ts` holding only:

```ts
export function cn(...inputs: CxOptions) { return twMerge(cx(inputs)); }
export function isMacPlatform(p: string) { … }
export function isWindowsPlatform(p: string) { … }
export function isLinuxPlatform(p: string) { … }
```

Two edits required, both named in §2: `sidebar.tsx`'s two `Schema.Finite` call sites, and
`qr-code.tsx`'s `@t3tools/shared/qrCode` import (vendor the file). Peers: `react@^19`,
`@base-ui/react@^1`, `lucide-react`, `class-variance-authority`, `tailwind-merge`, `@x/theme`.

Keep the shadcn aliases — they are the migration path for anyone already on shadcn.

### `@x/ui-hooks` — 6 hooks, ~660 lines

`useCommitOnBlur`, `useMediaQuery` (+`useIsMobile`), `useNowMinute`, `useCopyToClipboard`
(+`writeTextToClipboard`), `useLocalStorage`, `useResizableWidth`.

**Drop `effect/Schema` here.** Replace the validator parameter with a
`(value: unknown) => T | undefined` callback. That single decision removes Effect from every layer
below `@x/panels`.

### `@x/text-logic` — framework-free, no React

| Module           | From                                                                                                                             |  LOC |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---: |
| `composer`       | `composer-logic.ts`, `composer-editor-mentions.ts`, `composerSlashCommandSearch.ts`, `composerMenuHighlight.ts`                  | ~600 |
| `markdown`       | `markdown-list-indentation.ts`, `markdown-clipboard.ts`, `markdown-links.ts`                                                     | ~670 |
| `terminal-links` | `terminal-links.ts`                                                                                                              |  286 |
| `keybindings`    | `packages/shared/src/keybindings.ts`, `apps/web/src/shortcutModifierState.ts`, the generic half of `apps/web/src/keybindings.ts` | ~700 |
| `tree`           | `lib/turnDiffTree.ts`, `lib/diffCollapse.ts`                                                                                     |  185 |
| `diff-render`    | `lib/diffRendering.ts` (incl. `fnv1a32`, `buildPatchCacheKey`) — only if you take `@pierre/diffs`                                |  152 |
| `viewport`       | `browser/browserViewportLayout.ts` (inline the three contracts constants)                                                        |  286 |
| `lru`            | `lib/lruCache.ts`                                                                                                                |   68 |
| `search`         | `packages/shared/src/searchRanking.ts`                                                                                           |    — |
| `time`           | `timestampFormat.ts` (with `TimestampFormat` inlined as a local union)                                                           |  225 |
| `strings`        | `packages/shared/src/String.ts`, `Struct.ts`, `path.ts`, `semver.ts`                                                             |    — |

**This package is the highest-confidence, lowest-cost harvest in the whole document.** Every
module here already has a sibling `.test.ts` and no React import.

### `@x/panels` — layout, chrome, and the surfaces that are generic

| Contents                                                                                                                                                           | From                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Toast system (thread-awareness generalised to `contextId`)                                                                                                         | `ui/toast*.tsx`                                                     |
| `AnimatedHeight`                                                                                                                                                   | `components/AnimatedHeight.tsx`                                     |
| `ScrollFadeArea` re-export                                                                                                                                         | already in `@x/ui`                                                  |
| `RightPanelTabs` (generalised over a `Surface` type param)                                                                                                         | `components/RightPanelTabs.tsx`                                     |
| `RightPanelSheet`, `PanelLayoutControls`, `RightPanelResizeHandle`                                                                                                 | as named                                                            |
| `DiffPanelShell` (drop `isElectron`, take a `chromeVariant` prop)                                                                                                  | `components/DiffPanelShell.tsx`                                     |
| `PreviewPanelShell`, `BrowserMockup`, `PreviewChromeRow`, `BrowserDeviceToolbar`, `ZoomIndicator`, `PreviewEmptyState`, `PreviewUnreachable`, `AgentBrowserCursor` | `components/preview/*`, `browser/*`                                 |
| **`SurfaceSlot`** — the measure-a-DOM-hole-and-publish-its-rect primitive, generalised off `tabId`                                                                 | `browser/BrowserSurfaceSlot.tsx` + `browserSurfaceStore.ts`         |
| `useLoadingProgress`, `BrowserViewportResizeHandles`, `useBrowserViewportResize`                                                                                   | `preview/*`, `browser/*`                                            |
| `serializeCssVariableTheme` — for theming iframes, shadow roots or foreign documents                                                                               | `browser/annotationTheme.ts`                                        |
| **Settings kit** — `SettingsPageContainer`, `SettingsSection`, `SettingsRow`, `SettingResetButton`, `useRelativeTimeTick`, `ITEM_ROW_CLASSNAME`                    | `components/settings/settingsLayout.tsx`, `itemRows.ts`             |
| `SettingsSidebarNav`, `RedactedSensitiveText`, `ColorSelector`, `WizardSteps`                                                                                      | `components/settings/*`, `components/color-selector.tsx`            |
| `AuthSurfaceShell`, `ConnectionStatusDot`, `Empty`-states                                                                                                          | as named                                                            |
| Latency-toast coordinator (generalised)                                                                                                                            | `SlowRpcRequestToastCoordinator.tsx` + `rpc/requestLatencyState.ts` |

### `@x/agent-chat` — opinionated, the part that needs adaptation

| Contents                                                                                                                                 | Notes                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PromptEditor`                                                                                                                           | `ComposerPromptEditor.tsx` with `ServerProviderSkill` → `{name, displayName}`                                      |
| `ComposerShell`                                                                                                                          | a **rewrite** of `ChatComposer.tsx`'s layout, taking a controlled value                                            |
| `ComposerCommandMenu`, `ComposerBannerStack`, `ComposerPrimaryActions`, `ContextWindowMeter`, `FileTagChip`, `TerminalContextInlineChip` | near-verbatim                                                                                                      |
| `ApprovalPanel`, `ApprovalActions`, `UserInputPanel` + `pendingUserInput.ts`                                                             | near-verbatim; ~500 lines                                                                                          |
| `Markdown`                                                                                                                               | `ChatMarkdown.tsx` with the five `~/state` imports replaced by an `onOpenFile`/`onOpenUrl`/`onOpenPreview` context |
| `MessageCopyButton`, `DiffStatLabel`, `ExpandedImageDialog`, `ChangedFilesTree`, `ThreadErrorBanner`                                     | near-verbatim                                                                                                      |
| `Terminal`                                                                                                                               | `ThreadTerminalDrawer.tsx` with `useAttachedTerminalSession` → a transport prop                                    |
| `DiffWorkerPoolProvider`                                                                                                                 | verbatim minus the Effect error class                                                                              |

Peers: `lexical`, `@xterm/xterm`, `@legendapp/list`, `@pierre/diffs`, `react-markdown` + the four
remark/rehype plugins. **All optional per-entry-point** — a receiver that only wants the markdown
renderer should not be forced to install xterm.

### `apps/desktop` — nothing to harvest, stated so it is not re-investigated

19,766 non-test lines and **zero `.tsx` files** (verified:
`find apps/desktop -name '*.tsx' ! -path '*/node_modules/*' | wc -l` → 0). It is entirely Electron
main-process TypeScript: `app/`, `backend/`, `ipc/`, `settings/`, `shell/`, `wsl/`. The only part
that touches the UI is the preload bridge, `src/preload.ts` (244 lines), which
`contextBridge.exposeInMainWorld("desktopBridge", …)` with **41 methods** —
`getAppBranding`, `pickFolder`, `confirm`, `openExternal`, `showContextMenu`, `setTheme`,
`getClientSettings`/`setClientSettings`, `getConnectionCatalog`/`setConnectionCatalog`/`clearConnectionCatalog`,
the six `*Ssh*` methods, the five WSL methods, the five update methods, `preview` (the object that
`previewBridge.ts` reaches for), and the three `on*` event subscriptions.

`apps/web` consumes it through two files: `env.ts` (`isElectron` = `window.desktopBridge !== undefined
|| window.nativeApi !== undefined`) and `localApi.ts` (113 lines), which wraps every bridge call in
a browser fallback — `window.confirm` for `confirm`, `window.open` for `openExternal`, and
`showContextMenuFallback` (a 307-line DOM-rendered menu with inlined Lucide paths) for
`showContextMenu`. **That fallback layer is the reusable idea**: a single `LocalApi` interface with
a native implementation and a browser implementation, resolved once at module load.

### What is deliberately **not** in any package

`ChatView`, `Sidebar`, `SidebarV2`, `AppSidebarLayout`, `CommandPalette`, `DiffPanel`,
`FilePreviewPanel`, `PreviewView`, every `components/settings/*Settings.tsx`, all of
`components/cloud`, `components/clerk`, `components/auth/PairingRouteSurface`,
`GitActionsControl`, `BranchToolbar*`, `ProjectScriptsControl`, all `ProviderUpdate*`,
`state/*`, `rpc/*`, `connection/*`, `environments/*`, `cloud/*`, `browser/previewAutomation*`.

That is roughly **60,000 of the ~102,000 lines** — and it is the correct 60,000 to leave behind.

---

## 6. Cost and order of operations

### 6.0 The copy-paste tier — take these first, they cost nothing

Files with **zero or type-only** domain imports, no atoms, no store reads. Verified individually.

| File                                          | LOC | What you get                                                    |
| --------------------------------------------- | --: | --------------------------------------------------------------- |
| `terminal-links.ts`                           | 286 | URL + `file:line:col` detection across wrapped terminal buffers |
| `composer-logic.ts`                           | 287 | Composer trigger detection and dual-cursor mapping              |
| `markdown-clipboard.ts`                       | 311 | Rendered-markdown → markdown/CSV clipboard payloads             |
| `browser/browserViewportLayout.ts`            | 286 | Fit-to-panel viewport geometry                                  |
| `composer-editor-mentions.ts`                 | 223 | Prompt → typed segment splitting                                |
| `components/Icons.tsx`                        | 720 | 23 brand SVGs with `useId` gradient isolation                   |
| `components/JetBrainsIcons.tsx`               | 610 | 12 IDE icons                                                    |
| `lib/turnDiffTree.ts`                         | 172 | Path list → collapsed directory tree                            |
| `lib/diffRendering.ts`                        | 152 | `fnv1a32`, patch cache keys, Pierre patch parsing               |
| `markdown-list-indentation.ts`                | 143 | Remark plugin fixing LLM list indentation                       |
| `components/ui/card.tsx`                      | 196 | A complete, currently-unused Card set                           |
| `components/AnimatedHeight.tsx`               |  91 | Height auto-animation with a clip-clear fallback                |
| `components/files/LocalCommentAnnotation.tsx` |  90 | Draft/saved inline comment card                                 |
| `components/ui/empty.tsx`                     | 114 | Empty-state scaffold                                            |
| `lib/lruCache.ts`                             |  68 | LRU with both count and byte budgets                            |
| `hooks/useNowMinute.ts`                       |  69 | Minute-aligned clock tick                                       |
| `hooks/useMediaQuery.ts`                      |  87 | `useMediaQuery` + `useIsMobile`                                 |
| `preview/useLoadingProgress.ts`               |  45 | Indeterminate progress simulator                                |
| `browser/BrowserSurfaceSlot.tsx`              |  45 | Measure a DOM hole, publish its rect                            |
| `hooks/useCommitOnBlur.ts`                    |  43 | Commit-on-blur draft value                                      |
| `packages/shared/src/terminalLabels.ts`       |  40 | Terminal id/label allocation                                    |
| `preview/ZoomIndicator.tsx`                   |  54 | Transient zoom-percentage pill                                  |
| `preview/RightPanelResizeHandle.tsx`          |  34 | Separator drag rail                                             |
| `browser/annotationTheme.ts`                  |  28 | CSS-variable theme serialisation                                |
| `components/ui/kbd.tsx`                       |  28 | `Kbd` + `KbdGroup`                                              |
| `preview/BrowserMockup.tsx`                   |  24 | Browser-window glyph                                            |
| `components/ui/draft-input.tsx`               |  21 | Buffer keystrokes, commit on blur/Enter                         |
| `lib/diffCollapse.ts`                         |  13 | Collapse-all helpers                                            |

≈ **4,300 lines**, no decisions required.

### 6.1 Sequenced plan

If the goal is "get something reusable out of this in the least time," do it in this order.

| #   | Move                                                               | Effort      | Yield                                                                                                                  |
| --- | ------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Split `cn` + platform predicates out of `lib/utils.ts`             | **minutes** | Decouples 38 of 44 `ui/` files from the domain                                                                         |
| 2   | Swap `effect/Schema` for a callback validator in `useLocalStorage` | ~1 h        | Removes Effect from `ui/sidebar.tsx`, `useResizableWidth`, `useCopyToClipboard` — i.e. from the entire primitive layer |
| 3   | Extract `@x/theme` (CSS)                                           | ~2 h        | The palette + glass surfaces + markdown typography, immediately usable                                                 |
| 4   | Extract `@x/ui` (41 files, ~zero edits)                            | ~half a day | A complete Base UI design system                                                                                       |
| 5   | Extract `@x/text-logic`                                            | ~half a day | ~2,700 lines of tested, dependency-free logic                                                                          |
| 6   | Extract `@x/ui-hooks`                                              | ~2 h        | The six hooks you would otherwise rewrite                                                                              |
| 7   | Generalise the toast (`ScopedThreadRef` → `contextId`)             | ~2 h        | Unblocks 34 call sites' worth of pattern                                                                               |
| 8   | Generalise `ChatMarkdown`'s link handling into a context           | ~half a day | The single highest-value feature component becomes portable                                                            |
| 9   | Extract the approval / user-input panels                           | ~2 h        | ~500 lines, near-verbatim                                                                                              |
| 10  | Extract `ComposerPromptEditor` + composer logic                    | ~1–2 days   | The crown jewel                                                                                                        |
| 11  | Seam the terminal drawer's session hook                            | ~1 day      | A reusable multi-pane web terminal                                                                                     |

Steps 1–6 are almost entirely mechanical and yield the whole design system plus the logic layer.
Everything after 7 requires design decisions.

---

## 7. Things that are a bigger deal than the brief implies

1. **The `.tsx` / `.logic.ts` / `.logic.test.ts` convention is the reason this codebase is
   harvestable at all.** Roughly a dozen major components have their decision logic in a sibling
   pure module: `ChatView.logic.ts`, `Sidebar.logic.ts`, `CommandPalette.logic.ts`,
   `MessagesTimeline.logic.ts`, `BranchToolbar.logic.ts`, `GitActionsControl.logic.ts`,
   `ConnectionsSettings.logic.ts`, `SettingsPanels.logic.ts`, `KeybindingsSettings.logic.ts`,
   `ProviderUpdateLaunchNotification.logic.ts`, `desktopUpdate.logic.ts`,
   `MobileClientsUserProfilePage.logic.ts`. Even where the _component_ is hopelessly coupled, the
   logic module usually is not. **Copy the convention even if you copy nothing else.**

2. **Effect 4 is at `4.0.0-beta.78` and is pnpm-patched** (`patches/effect@4.0.0-beta.78.patch`,
   322 lines — though the patch content is server-side `McpServer` routing and does not affect the
   UI). Committing a receiving project to Effect 4 beta because of a UI harvest would be a serious
   architectural decision made for the wrong reason. **The whole point of the package split in §5
   is that no layer below `@x/panels` needs Effect at all** — and after step 2 in §6, none does.

3. **Two beta, patched rendering dependencies — and one of them ships Preact.**
   `@pierre/diffs@1.3.0-beta.5` carries a repo-local 69-line patch disabling gutter utility, line
   selection and line-hover highlighting in its editor. `@pierre/trees@1.0.0-beta.4` is a
   **Preact-rendered web component wrapped for React**, with a runtime dependency on
   `preact@11.0.0-beta.0`. Both are public Apache-2.0 npm packages, so this is a stability
   judgement rather than an access problem — but a receiving project that takes the file tree
   ships two React-ish renderers.

4. **The preview subsystem is an Electron host, not a component tree.** It is 8,641 lines across
   69 files, and the load-bearing part is a **nine-line** module returning
   `window.desktopBridge?.preview`. The browser is a native `<webview>`, positioned from the DOM.
   Nothing downstream of that ports to a web app at any price. The three genuinely reusable ideas
   in there are small and unrelated to Electron: `BrowserSurfaceSlot.tsx` (measure a DOM hole,
   publish the rect), `annotationTheme.ts` (serialise CSS variables across a document boundary),
   and `PreviewChromeRow.tsx` (a zero-dependency browser chrome bar).

5. **The terminal's isolation looks intentional and is worth imitating.** xterm touches exactly
   one component file, one CSS import and three CSS rules. `terminal-links.ts` types against a
   structural `TerminalBufferLineLike` rather than importing xterm. The drawer takes 26 props and
   never reads its own store. Whoever wrote it was thinking about exactly the question this
   document asks.

6. **`vite-plus` is not Vite.** The catalog aliases `vite` itself to
   `npm:@voidzero-dev/vite-plus-core@0.2.2`, and every test file imports from `"vite-plus/test"`.
   Tests do not run under plain Vitest without a find-and-replace. If you harvest a module and
   want its tests, budget for that.

7. **Four `components/ui` primitives are dead** (`card.tsx` 196, `field.tsx` 59, `fieldset.tsx` 26,
   `form.tsx` 17). They are fine code with zero importers. Take them; they cost nothing and
   `card.tsx` in particular is a complete, well-built set.

8. **`ChatComposer` and `DiffPanel` are the same quality of UX with opposite wiring discipline** —
   60 props versus 3. If you want a rule of thumb for what will port, it is this: _count the
   props_. Components in this repo that were written as controlled take a large, ugly, explicit
   props interface, and those are exactly the ones that lift.

9. **`apps/marketing` and `apps/mobile` are empty directories** (only `node_modules`). There is
   **no existing evidence of cross-app component reuse in this monorepo** — `apps/web`'s
   components have never been consumed by a second application. Whatever seams look obvious on
   paper have not been exercised. Treat every "PORTABLE" verdict below the `ui/` layer as
   _analytically_ portable, not _demonstrated_ portable.

---

## 8. Sampling disclosure

**Read in full:** all 44 files in `components/ui`; all 12 files in `hooks`; `lib/utils.ts`,
`lib/lruCache.ts`, `lib/diffRendering.ts` (exports), `lib/turnDiffTree.ts` (exports),
`components/AnimatedHeight.tsx`, `components/chat/ComposerPendingApprovalPanel.tsx`,
`ComposerPendingApprovalActions.tsx`, `ComposerPendingUserInputPanel.tsx`,
`ComposerBannerStack.tsx` (head), `ComposerPrimaryActions.tsx` (props),
`ContextWindowMeter.tsx`, `components/DiffPanelShell.tsx`, `components/DiffWorkerPoolProvider.tsx`,
`components/ui/sidebarState.ts`, `apps/web/src/main.tsx`, `AppRoot.tsx`, `env.ts`,
`localApi.ts` (head), `rpc/atomRegistry.ts`, `state/query.ts`, `state/use-atom-command.ts`,
`state/entities.ts` (head), `connection/runtime.ts`, `pierre-icons.ts` (head),
`apps/web/vite.config.ts`, `apps/web/tsconfig.json`, `tsconfig.base.json`, `pnpm-workspace.yaml`,
`apps/web/package.json`, `packages/{shared,client-runtime,contracts}/package.json`,
and `index.css` (structure map + the token, `@theme`, and `@layer components` regions).

**Read by header, props interface, and import graph** (not line by line):
`ChatView.tsx`, `ChatComposer.tsx`, `ComposerPromptEditor.tsx`, `MessagesTimeline.tsx`,
`ChatMarkdown.tsx`, `ThreadTerminalDrawer.tsx`, `DiffPanel.tsx`, `PlanSidebar.tsx`,
`ProposedPlanCard.tsx`, `ModelPickerContent.tsx`, `TraitsPicker.tsx`, `GitActionsControl.tsx`,
`BranchToolbar.tsx`, `ProjectScriptsControl.tsx`, `AppSidebarLayout.tsx`, `RightPanelTabs.tsx`,
`ThreadStatusIndicators.tsx`, `routes/__root.tsx`, `routes/_chat.tsx`, `session-logic.ts`,
`keybindings.ts`, `composer-logic.ts`, `terminal-links.ts`, `markdown-clipboard.ts`,
`contextMenuFallback.ts`, `timestampFormat.ts`.

**Read in full in a dedicated second pass** (terminal / preview / browser / diff / files):
`ThreadTerminalDrawer.tsx`, `terminalUiStateStore.ts`, `state/terminal.ts`,
`state/terminalSessions.ts`, `terminal-links.ts`, `lib/terminalUiStateCleanup.ts`,
`packages/shared/src/terminalLabels.ts`; `preview/PreviewView.tsx`, `PreviewPanel.tsx`,
`PreviewChromeRow.tsx`, `BrowserMockup.tsx`, `PreviewAutomationHosts.tsx`,
`AgentBrowserCursor.tsx`, `ZoomIndicator.tsx`, `PreviewEmptyState.tsx`,
`RightPanelResizeHandle.tsx`, `useLoadingProgress.ts`, `previewBridge.ts`;
`browser/BrowserDeviceToolbar.tsx`, `HostedBrowserWebview.tsx`, `ElectronBrowserHost.tsx`,
`BrowserSurfaceSlot.tsx`, `BrowserViewportResizeHandles.tsx`, `useBrowserViewportResize.ts`,
`browserViewportLayout.ts`, `annotationTheme.ts`, `browserRecording.ts`;
`DiffPanel.tsx`, `DiffPanelShell.tsx`, `DiffWorkerPoolProvider.tsx`,
`diffs/AnnotatableCodeView.tsx`, `files/FilePreviewPanel.tsx`, `files/FileBrowserPanel.tsx`,
`files/LocalCommentAnnotation.tsx`, `chat/ChangedFilesTree.tsx`, `lib/diffRendering.ts`,
`lib/turnDiffTree.ts`, `lib/diffCollapse.ts`, `lib/checkpointDiffState.ts`, `diffPanelStore.ts`;
plus the `@pierre/diffs` and `@pierre/trees` `package.json` and `.d.ts` export surfaces.

**Characterised by import graph and file/line census only** (individual files not opened):
`components/settings` beyond the six named as portable; the `previewAutomation*` support modules;
`components/cloud`, `components/clerk`, `cloud/`, `connection/`, `environments/`;
`Sidebar.tsx` and `SidebarV2.tsx` internals; `packages/client-runtime` internals;
`apps/desktop` internals.

**Not examined:** `apps/server` (being deleted), `apps/mobile` and `apps/marketing` (empty),
`packages/{effect-acp,effect-codex-app-server,ssh,tailscale}`, `oxlint-plugin-t3code`,
`infra/`, `scripts/`.
