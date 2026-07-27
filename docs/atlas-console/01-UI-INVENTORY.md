# Atlas Console — donor UI inventory

Every non-test file under `apps/web/src` in this fork, with its area, component level, size, and
classification verdict. Generated from `git ls-files`, so completeness is checkable rather than
asserted: **432 files, 102,014 lines.**

This is the file-level index. Behavioural documentation — anatomy, states, focus, accessibility — lives
in [the component reference](../ui/component-reference.md); route and navigation structure lives in
[the information architecture](../ui/information-architecture.md). Verdicts are defined and argued in
[03-CLASSIFICATION.md](./03-CLASSIFICATION.md).

Component levels follow the taxonomy already set in [docs/ui/README.md](../ui/README.md): **route**, a
URL-addressable surface · **workspace**, a large persistent region · **feature**, a coherent
interaction · **primitive**, a reusable control · **internal**, state and wiring that carries no visible
contract of its own.

## By area

| Area                  | Files |  Lines |
| --------------------- | ----: | -----: |
| `components`          |    51 | 33,494 |
| `(root)`              |    65 | 16,210 |
| `components/settings` |    23 | 11,936 |
| `components/chat`     |    50 | 11,868 |
| `components/ui`       |    44 |  5,974 |
| `components/preview`  |    36 |  3,522 |
| `browser`             |    19 |  2,630 |
| `hooks`               |    12 |  2,245 |
| `lib`                 |    26 |  1,961 |
| `components/files`    |    11 |  1,797 |
| `state`               |    30 |  1,789 |
| `cloud`               |    12 |  1,581 |
| `connection`          |     7 |  1,482 |
| `routes`              |    17 |  1,253 |
| `environments`        |     8 |  1,135 |
| `components/cloud`    |     5 |  1,062 |
| `components/sidebar`  |     3 |    569 |
| `components/auth`     |     2 |    367 |
| `components/clerk`    |     4 |    283 |
| `components/diffs`    |     1 |    268 |
| `components/desktop`  |     1 |    221 |
| `rpc`                 |     3 |    153 |
| `observability`       |     1 |    146 |
| `assets`              |     1 |     68 |

## Files

### `components` — 51 files, 33,494 lines

| File                                                          | Level     | Lines | Verdict              | Waits on |
| ------------------------------------------------------------- | --------- | ----: | -------------------- | -------- |
| `components/ChatView.tsx`                                     | workspace | 6,053 | `rebind`             | GAP-002  |
| `components/Sidebar.tsx`                                      | workspace | 3,643 | `redesign`           | GAP-004  |
| `components/SidebarV2.tsx`                                    | workspace | 2,732 | `redesign`           | GAP-004  |
| `components/CommandPalette.tsx`                               | feature   | 2,094 | `rebind`             | GAP-004  |
| `components/GitActionsControl.tsx`                            | feature   | 2,035 | `rebind`             | GAP-009  |
| `components/ComposerPromptEditor.tsx`                         | workspace | 1,842 | `rebind`             | —        |
| `components/ChatMarkdown.tsx`                                 | feature   | 1,566 | `rebind`             | GAP-011  |
| `components/ThreadTerminalDrawer.tsx`                         | workspace | 1,549 | `rebind`             | GAP-007  |
| `components/DiffPanel.tsx`                                    | workspace |   941 | `rebind`             | GAP-009  |
| `components/BranchToolbarBranchSelector.tsx`                  | feature   |   835 | `rebind`             | GAP-009  |
| `components/ProviderUpdateLaunchNotification.logic.ts`        | feature   |   835 | `remove-unsupported` | —        |
| `components/Sidebar.logic.ts`                                 | workspace |   833 | `redesign`           | GAP-004  |
| `components/Icons.tsx`                                        | primitive |   720 | `reuse`              | —        |
| `components/ProjectScriptsControl.tsx`                        | feature   |   623 | `rebind`             | GAP-009  |
| `components/JetBrainsIcons.tsx`                               | primitive |   610 | `reuse`              | —        |
| `components/ChatView.logic.ts`                                | workspace |   544 | `rebind`             | GAP-002  |
| `components/RightPanelTabs.tsx`                               | workspace |   497 | `reuse`              | —        |
| `components/GitActionsControl.logic.ts`                       | feature   |   417 | `rebind`             | GAP-009  |
| `components/ProviderUpdateEnvironmentRows.tsx`                | feature   |   397 | `remove-unsupported` | —        |
| `components/CommandPalette.logic.ts`                          | feature   |   380 | `rebind`             | GAP-004  |
| `components/BranchToolbar.tsx`                                | feature   |   363 | `rebind`             | GAP-009  |
| `components/ThreadStatusIndicators.tsx`                       | workspace |   358 | `rebind`             | GAP-002  |
| `components/ProviderUpdatePrimaryNotification.tsx`            | feature   |   331 | `remove-unsupported` | —        |
| `components/SidebarStageBackdrop.tsx`                         | workspace |   330 | `redesign`           | GAP-004  |
| `components/PullRequestThreadDialog.tsx`                      | feature   |   304 | `rebind`             | GAP-009  |
| `components/PlanSidebar.tsx`                                  | feature   |   284 | `rebind`             | GAP-002  |
| `components/BranchToolbar.logic.ts`                           | feature   |   225 | `rebind`             | GAP-009  |
| `components/ServerUpdateAction.tsx`                           | feature   |   201 | `remove-unsupported` | —        |
| `components/ProviderUpdateLaunchNotification.tsx`             | feature   |   198 | `remove-unsupported` | —        |
| `components/AppSidebarLayout.tsx`                             | workspace |   188 | `redesign`           | GAP-004  |
| `components/CommandPaletteResults.tsx`                        | feature   |   146 | `rebind`             | GAP-004  |
| `components/Sidebar.snooze.ts`                                | workspace |   127 | `redesign`           | GAP-004  |
| `components/BranchToolbarEnvModeSelector.tsx`                 | feature   |   123 | `rebind`             | GAP-009  |
| `components/desktopUpdate.logic.ts`                           | feature   |   115 | `remove-unsupported` | —        |
| `components/composerInlineTokenPaste.ts`                      | workspace |   104 | `rebind`             | —        |
| `components/color-selector.tsx`                               | primitive |   101 | `restyle`            | —        |
| `components/ProviderUpdateLaunchNotification.environments.ts` | feature   |    97 | `remove-unsupported` | —        |
| `components/AnimatedHeight.tsx`                               | primitive |    91 | `reuse`              | —        |
| `components/BranchToolbarEnvironmentSelector.tsx`             | feature   |    91 | `rebind`             | GAP-009  |
| `components/DiffPanelShell.tsx`                               | workspace |    88 | `rebind`             | GAP-009  |
| `components/DiffWorkerPoolProvider.tsx`                       | workspace |    84 | `reuse`              | —        |
| `components/ProjectFavicon.tsx`                               | feature   |    76 | `rebind`             | GAP-001  |
| `components/SlowRpcRequestToastCoordinator.tsx`               | feature   |    73 | `rebind`             | GAP-001  |
| `components/ConnectionStatusDot.tsx`                          | feature   |    56 | `rebind`             | GAP-001  |
| `components/KeybindingsUpdateToast.logic.ts`                  | feature   |    45 | `remove-unsupported` | —        |
| `components/NoActiveThreadState.tsx`                          | feature   |    44 | `rebind`             | GAP-001  |
| `components/RightPanelSheet.tsx`                              | workspace |    30 | `reuse`              | —        |
| `components/composerFooterLayout.ts`                          | workspace |    24 | `rebind`             | —        |
| `components/threadSidebarWidth.ts`                            | workspace |    22 | `redesign`           | GAP-004  |
| `components/composerInlineChip.ts`                            | workspace |    20 | `rebind`             | —        |
| `components/SplashScreen.tsx`                                 | primitive |     9 | `reuse`              | —        |

### `(root)` — 65 files, 16,210 lines

| File                              | Level     | Lines | Verdict              | Waits on |
| --------------------------------- | --------- | ----: | -------------------- | -------- |
| `composerDraftStore.ts`           | workspace | 3,574 | `rebind`             | —        |
| `index.css`                       | primitive | 1,580 | `restyle`            | —        |
| `session-logic.ts`                | internal  | 1,401 | `rebind`             | GAP-002  |
| `terminalUiStateStore.ts`         | workspace |   781 | `rebind`             | GAP-007  |
| `rightPanelStore.ts`              | workspace |   560 | `reuse`              | —        |
| `keybindings.ts`                  | feature   |   529 | `reuse`              | —        |
| `reviewCommentContext.ts`         | workspace |   459 | `rebind`             | GAP-009  |
| `previewStateStore.ts`            | workspace |   428 | `rebind`             | GAP-010  |
| `uiStateStore.ts`                 | internal  |   421 | `reuse`              | —        |
| `routeTree.gen.ts`                | route     |   392 | `rebind`             | GAP-001  |
| `providerInstances.ts`            | feature   |   362 | `remove-duplicate`   | —        |
| `modelSelection.ts`               | feature   |   329 | `redesign`           | GAP-005  |
| `markdown-clipboard.ts`           | feature   |   311 | `rebind`             | GAP-011  |
| `contextMenuFallback.ts`          | feature   |   307 | `rebind`             | GAP-011  |
| `composer-logic.ts`               | workspace |   287 | `rebind`             | —        |
| `terminal-links.ts`               | workspace |   286 | `rebind`             | GAP-007  |
| `sidebarProjectGrouping.ts`       | workspace |   262 | `redesign`           | GAP-004  |
| `timestampFormat.ts`              | internal  |   225 | `reuse`              | —        |
| `composer-editor-mentions.ts`     | workspace |   223 | `rebind`             | —        |
| `markdown-links.ts`               | feature   |   213 | `rebind`             | GAP-011  |
| `orchestrationRecovery.ts`        | feature   |   211 | `remove-duplicate`   | —        |
| `pendingUserInput.ts`             | feature   |   172 | `rebind`             | GAP-006  |
| `wslPaths.ts`                     | feature   |   159 | `remove-unsupported` | —        |
| `versionSkew.ts`                  | feature   |   147 | `remove-unsupported` | —        |
| `diffPanelStore.ts`               | workspace |   144 | `rebind`             | GAP-009  |
| `markdown-list-indentation.ts`    | feature   |   143 | `rebind`             | GAP-011  |
| `historyBootstrap.ts`             | feature   |   139 | `remove-duplicate`   | —        |
| `proposedPlan.ts`                 | feature   |   122 | `rebind`             | GAP-002  |
| `threadSelectionStore.ts`         | internal  |   122 | `rebind`             | GAP-002  |
| `pierre-icons.ts`                 | primitive |   117 | `reuse`              | —        |
| `editorPreferences.ts`            | internal  |   115 | `reuse`              | —        |
| `localApi.ts`                     | feature   |   113 | `remove-duplicate`   | —        |
| `providerSkillSearch.ts`          | feature   |   105 | `remove-duplicate`   | —        |
| `threadRoutes.ts`                 | internal  |   103 | `rebind`             | GAP-002  |
| `providerModels.ts`               | feature   |   101 | `remove-duplicate`   | —        |
| `shortcutModifierState.ts`        | feature   |    96 | `reuse`              | —        |
| `orchestrationEventEffects.ts`    | internal  |    94 | `rebind`             | GAP-002  |
| `providerUpdateDismissal.ts`      | feature   |    93 | `remove-unsupported` | —        |
| `hostedPairing.ts`                | route     |    89 | `redesign`           | GAP-001  |
| `projectScripts.ts`               | feature   |    87 | `rebind`             | GAP-009  |
| `modelOrdering.ts`                | feature   |    86 | `remove-duplicate`   | —        |
| `sourceControlPresentation.ts`    | feature   |    62 | `rebind`             | GAP-009  |
| `pullRequestReference.ts`         | feature   |    59 | `rebind`             | GAP-009  |
| `filePathDisplay.ts`              | workspace |    57 | `rebind`             | GAP-008  |
| `types.ts`                        | internal  |    57 | `reuse`              | —        |
| `main.tsx`                        | route     |    54 | `rebind`             | GAP-001  |
| `providerSkillPresentation.ts`    | feature   |    53 | `remove-duplicate`   | —        |
| `portDiscoveryState.ts`           | workspace |    51 | `rebind`             | GAP-010  |
| `worktreeCleanup.ts`              | feature   |    45 | `redesign`           | GAP-004  |
| `branding.logic.ts`               | primitive |    38 | `restyle`            | —        |
| `clientPersistenceStorage.ts`     | internal  |    30 | `reuse`              | —        |
| `commandPaletteBus.ts`            | feature   |    30 | `rebind`             | GAP-004  |
| `vite-env.d.ts`                   | internal  |    28 | `reuse`              | —        |
| `branding.ts`                     | primitive |    27 | `restyle`            | —        |
| `diffFileActions.ts`              | workspace |    25 | `rebind`             | GAP-009  |
| `AppRoot.tsx`                     | route     |    21 | `rebind`             | GAP-001  |
| `router.ts`                       | route     |    19 | `rebind`             | GAP-001  |
| `logicalProject.ts`               | feature   |    14 | `redesign`           | GAP-004  |
| `modelPickerVisibility.ts`        | feature   |    13 | `redesign`           | GAP-005  |
| `vite-plus-browser-matchers.d.ts` | internal  |    11 | `reuse`              | —        |
| `composerHandleContext.ts`        | workspace |    10 | `rebind`             | —        |
| `env.ts`                          | internal  |     8 | `reuse`              | —        |
| `pairingUrl.ts`                   | route     |     5 | `redesign`           | GAP-001  |
| `rightPanelLayout.ts`             | workspace |     3 | `reuse`              | —        |
| `workspaceTitlebar.ts`            | feature   |     2 | `remove-unsupported` | —        |

### `components/settings` — 23 files, 11,936 lines

| File                                                     | Level   | Lines | Verdict            | Waits on |
| -------------------------------------------------------- | ------- | ----: | ------------------ | -------- |
| `components/settings/ConnectionsSettings.tsx`            | route   | 3,398 | `redesign`         | GAP-003  |
| `components/settings/SettingsPanels.tsx`                 | route   | 1,765 | `redesign`         | GAP-003  |
| `components/settings/DiagnosticsSettings.tsx`            | route   | 1,355 | `rebind`           | GAP-012  |
| `components/settings/KeybindingsSettings.tsx`            | feature | 1,337 | `reuse`            | —        |
| `components/settings/ProviderInstanceCard.tsx`           | feature |   806 | `remove-duplicate` | —        |
| `components/settings/SourceControlSettings.tsx`          | feature |   518 | `rebind`           | GAP-009  |
| `components/settings/AddProviderInstanceDialog.tsx`      | feature |   437 | `remove-duplicate` | —        |
| `components/settings/ProviderModelsSection.tsx`          | route   |   411 | `redesign`         | GAP-003  |
| `components/settings/KeybindingsSettings.logic.ts`       | feature |   340 | `reuse`            | —        |
| `components/settings/ProviderAccentColorPicker.tsx`      | route   |   335 | `redesign`         | GAP-003  |
| `components/settings/ProviderSettingsForm.tsx`           | feature |   304 | `remove-duplicate` | —        |
| `components/settings/settingsLayout.tsx`                 | route   |   129 | `redesign`         | GAP-003  |
| `components/settings/SettingsSidebarNav.tsx`             | route   |   127 | `redesign`         | GAP-003  |
| `components/settings/SettingsPanels.logic.ts`            | route   |   125 | `redesign`         | GAP-003  |
| `components/settings/providerStatus.ts`                  | feature |   117 | `remove-duplicate` | —        |
| `components/settings/BetaSettingsPanel.tsx`              | route   |   108 | `redesign`         | GAP-003  |
| `components/settings/providerDriverMeta.ts`              | feature |   108 | `remove-duplicate` | —        |
| `components/settings/AddProviderInstanceWizardSteps.tsx` | feature |    73 | `remove-duplicate` | —        |
| `components/settings/RedactedSensitiveText.tsx`          | feature |    61 | `reuse`            | —        |
| `components/settings/AddProviderInstanceDialog.logic.ts` | feature |    36 | `remove-duplicate` | —        |
| `components/settings/ConnectionsSettings.logic.ts`       | route   |    21 | `redesign`         | GAP-003  |
| `components/settings/pairingUrls.ts`                     | route   |    20 | `redesign`         | GAP-001  |
| `components/settings/itemRows.ts`                        | feature |     5 | `reuse`            | —        |

### `components/chat` — 50 files, 11,868 lines

| File                                                  | Level     | Lines | Verdict    | Waits on |
| ----------------------------------------------------- | --------- | ----: | ---------- | -------- |
| `components/chat/ChatComposer.tsx`                    | workspace | 2,747 | `rebind`   | —        |
| `components/chat/MessagesTimeline.tsx`                | workspace | 2,081 | `rebind`   | GAP-002  |
| `components/chat/ModelPickerContent.tsx`              | feature   |   677 | `redesign` | GAP-005  |
| `components/chat/MessagesTimeline.logic.ts`           | workspace |   640 | `rebind`   | GAP-002  |
| `components/chat/TraitsPicker.tsx`                    | feature   |   523 | `redesign` | GAP-005  |
| `components/chat/ChangedFilesTree.tsx`                | workspace |   330 | `rebind`   | GAP-009  |
| `components/chat/OpenInPicker.tsx`                    | feature   |   312 | `rebind`   | GAP-011  |
| `components/chat/ComposerCommandMenu.tsx`             | workspace |   258 | `rebind`   | —        |
| `components/chat/ProposedPlanCard.tsx`                | feature   |   256 | `rebind`   | GAP-002  |
| `components/chat/ModelPickerSidebar.tsx`              | feature   |   250 | `redesign` | GAP-005  |
| `components/chat/ComposerPrimaryActions.tsx`          | workspace |   241 | `rebind`   | —        |
| `components/chat/ComposerPendingUserInputPanel.tsx`   | feature   |   227 | `rebind`   | GAP-006  |
| `components/chat/ProviderModelPicker.tsx`             | feature   |   211 | `redesign` | GAP-005  |
| `components/chat/ComposerBannerStack.tsx`             | workspace |   208 | `rebind`   | —        |
| `components/chat/ChatHeader.tsx`                      | workspace |   161 | `rebind`   | GAP-002  |
| `components/chat/DraftHeroHeadline.tsx`               | workspace |   158 | `rebind`   | —        |
| `components/chat/ComposerPreviewAnnotationCards.tsx`  | workspace |   144 | `rebind`   | GAP-010  |
| `components/chat/ModelListRow.tsx`                    | feature   |   141 | `redesign` | GAP-005  |
| `components/chat/ContextWindowMeter.tsx`              | feature   |   139 | `rebind`   | GAP-002  |
| `components/chat/composerProviderState.tsx`           | feature   |   126 | `redesign` | GAP-005  |
| `components/chat/PanelLayoutControls.tsx`             | workspace |   112 | `rebind`   | —        |
| `components/chat/ExpandedImageDialog.tsx`             | feature   |   110 | `rebind`   | GAP-011  |
| `components/chat/changedFilesPresentation.ts`         | workspace |   102 | `rebind`   | GAP-009  |
| `components/chat/composerMentionDrag.ts`              | workspace |    98 | `rebind`   | —        |
| `components/chat/ComposerPendingElementContexts.tsx`  | workspace |    95 | `rebind`   | GAP-010  |
| `components/chat/PierreEntryIcon.tsx`                 | workspace |    95 | `rebind`   | —        |
| `components/chat/SkillInlineText.tsx`                 | workspace |    92 | `rebind`   | GAP-002  |
| `components/chat/CompactComposerControlsMenu.tsx`     | workspace |    91 | `rebind`   | —        |
| `components/chat/modelPickerSearch.ts`                | feature   |    87 | `redesign` | GAP-005  |
| `components/chat/composerSlashCommandSearch.ts`       | workspace |    83 | `rebind`   | —        |
| `components/chat/draftHeroTransition.ts`              | workspace |    82 | `rebind`   | —        |
| `components/chat/MessageCopyButton.tsx`               | workspace |    82 | `rebind`   | GAP-002  |
| `components/chat/ProviderInstanceIcon.tsx`            | feature   |    79 | `redesign` | GAP-005  |
| `components/chat/ProviderStatusBanner.tsx`            | feature   |    79 | `redesign` | GAP-005  |
| `components/chat/externalLinkContextMenu.ts`          | feature   |    78 | `rebind`   | GAP-011  |
| `components/chat/timelineScrollAnchoring.ts`          | workspace |    78 | `rebind`   | GAP-002  |
| `components/chat/ComposerPendingReviewComments.tsx`   | workspace |    60 | `rebind`   | GAP-009  |
| `components/chat/providerIconUtils.ts`                | feature   |    60 | `redesign` | GAP-005  |
| `components/chat/userMessageTerminalContexts.ts`      | workspace |    58 | `rebind`   | GAP-007  |
| `components/chat/ComposerPendingApprovalActions.tsx`  | feature   |    55 | `rebind`   | GAP-006  |
| `components/chat/DiffStatLabel.tsx`                   | workspace |    53 | `rebind`   | GAP-009  |
| `components/chat/ComposerPendingApprovalPanel.tsx`    | feature   |    49 | `rebind`   | GAP-006  |
| `components/chat/TerminalContextInlineChip.tsx`       | workspace |    47 | `rebind`   | GAP-007  |
| `components/chat/ComposerPendingTerminalContexts.tsx` | workspace |    44 | `rebind`   | GAP-007  |
| `components/chat/FileTagChip.tsx`                     | workspace |    39 | `rebind`   | GAP-008  |
| `components/chat/ThreadErrorBanner.tsx`               | workspace |    37 | `rebind`   | GAP-002  |
| `components/chat/ExpandedImagePreview.tsx`            | feature   |    32 | `rebind`   | GAP-011  |
| `components/chat/ComposerPlanFollowUpBanner.tsx`      | feature   |    28 | `rebind`   | GAP-002  |
| `components/chat/composerMenuHighlight.ts`            | workspace |    20 | `rebind`   | —        |
| `components/chat/modelPickerModelHighlights.ts`       | feature   |    13 | `redesign` | GAP-005  |

### `components/ui` — 44 files, 5,974 lines

| File                             | Level     | Lines | Verdict | Waits on |
| -------------------------------- | --------- | ----: | ------- | -------- |
| `components/ui/sidebar.tsx`      | primitive | 1,028 | `reuse` | —        |
| `components/ui/toast.tsx`        | primitive |   813 | `reuse` | —        |
| `components/ui/combobox.tsx`     | primitive |   403 | `reuse` | —        |
| `components/ui/menu.tsx`         | primitive |   302 | `reuse` | —        |
| `components/ui/autocomplete.tsx` | primitive |   271 | `reuse` | —        |
| `components/ui/command.tsx`      | primitive |   240 | `reuse` | —        |
| `components/ui/select.tsx`       | primitive |   240 | `reuse` | —        |
| `components/ui/sheet.tsx`        | primitive |   200 | `reuse` | —        |
| `components/ui/card.tsx`         | primitive |   196 | `reuse` | —        |
| `components/ui/dialog.tsx`       | primitive |   183 | `reuse` | —        |
| `components/ui/number-field.tsx` | primitive |   156 | `reuse` | —        |
| `components/ui/alert-dialog.tsx` | primitive |   144 | `reuse` | —        |
| `components/ui/toast.logic.ts`   | primitive |   115 | `reuse` | —        |
| `components/ui/empty.tsx`        | primitive |   114 | `reuse` | —        |
| `components/ui/alert.tsx`        | primitive |   113 | `reuse` | —        |
| `components/ui/popover.tsx`      | primitive |   111 | `reuse` | —        |
| `components/ui/toggle-group.tsx` | primitive |    96 | `reuse` | —        |
| `components/ui/input-group.tsx`  | primitive |    95 | `reuse` | —        |
| `components/ui/group.tsx`        | primitive |    93 | `reuse` | —        |
| `components/ui/table.tsx`        | primitive |    87 | `reuse` | —        |
| `components/ui/qr-code.tsx`      | primitive |    81 | `reuse` | —        |
| `components/ui/button.tsx`       | primitive |    74 | `reuse` | —        |
| `components/ui/scroll-area.tsx`  | primitive |    74 | `reuse` | —        |
| `components/ui/input.tsx`        | primitive |    73 | `reuse` | —        |
| `components/ui/checkbox.tsx`     | primitive |    60 | `reuse` | —        |
| `components/ui/field.tsx`        | primitive |    59 | `reuse` | —        |
| `components/ui/tooltip.tsx`      | primitive |    59 | `reuse` | —        |
| `components/ui/toastHelpers.ts`  | primitive |    58 | `reuse` | —        |
| `components/ui/badge.tsx`        | primitive |    56 | `reuse` | —        |
| `components/ui/toggle.tsx`       | primitive |    48 | `reuse` | —        |
| `components/ui/textarea.tsx`     | primitive |    45 | `reuse` | —        |
| `components/ui/collapsible.tsx`  | primitive |    39 | `reuse` | —        |
| `components/ui/radio-group.tsx`  | primitive |    36 | `reuse` | —        |
| `components/ui/kbd.tsx`          | primitive |    28 | `reuse` | —        |
| `components/ui/switch.tsx`       | primitive |    27 | `reuse` | —        |
| `components/ui/fieldset.tsx`     | primitive |    26 | `reuse` | —        |
| `components/ui/label.tsx`        | primitive |    24 | `reuse` | —        |
| `components/ui/draft-input.tsx`  | primitive |    21 | `reuse` | —        |
| `components/ui/separator.tsx`    | primitive |    19 | `reuse` | —        |
| `components/ui/form.tsx`         | primitive |    17 | `reuse` | —        |
| `components/ui/skeleton.tsx`     | primitive |    16 | `reuse` | —        |
| `components/ui/spinner.tsx`      | primitive |    15 | `reuse` | —        |
| `components/ui/dialog-styles.ts` | primitive |    10 | `reuse` | —        |
| `components/ui/sidebarState.ts`  | primitive |     9 | `reuse` | —        |

### `components/preview` — 36 files, 3,522 lines

| File                                                     | Level     | Lines | Verdict  | Waits on |
| -------------------------------------------------------- | --------- | ----: | -------- | -------- |
| `components/preview/PreviewView.tsx`                     | workspace |   666 | `rebind` | GAP-010  |
| `components/preview/PreviewAutomationHosts.tsx`          | workspace |   608 | `rebind` | GAP-010  |
| `components/preview/PreviewChromeRow.tsx`                | workspace |   291 | `rebind` | GAP-010  |
| `components/preview/previewAutomationErrors.ts`          | workspace |   235 | `rebind` | GAP-010  |
| `components/preview/PreviewMoreMenu.tsx`                 | workspace |   177 | `rebind` | GAP-010  |
| `components/preview/usePreviewBridge.ts`                 | workspace |   148 | `rebind` | GAP-010  |
| `components/preview/useDiscoveredLocalServers.ts`        | workspace |   138 | `rebind` | GAP-010  |
| `components/preview/previewAutomationRequestConsumer.ts` | workspace |   121 | `rebind` | GAP-010  |
| `components/preview/usePreviewSession.ts`                | workspace |   120 | `rebind` | GAP-010  |
| `components/preview/openTerminalLinkInPreview.ts`        | workspace |   109 | `rebind` | GAP-010  |
| `components/preview/PreviewUnreachable.tsx`              | workspace |    90 | `rebind` | GAP-010  |
| `components/preview/PreviewPanelShell.tsx`               | workspace |    88 | `rebind` | GAP-010  |
| `components/preview/AgentBrowserCursor.tsx`              | workspace |    78 | `rebind` | GAP-010  |
| `components/preview/PreviewEmptyState.tsx`               | workspace |    65 | `rebind` | GAP-010  |
| `components/preview/ZoomIndicator.tsx`                   | workspace |    54 | `rebind` | GAP-010  |
| `components/preview/PreviewLocalServerCard.tsx`          | workspace |    52 | `rebind` | GAP-010  |
| `components/preview/useLoadingProgress.ts`               | workspace |    45 | `rebind` | GAP-010  |
| `components/preview/openPreviewSession.ts`               | workspace |    42 | `rebind` | GAP-010  |
| `components/preview/PreviewPanel.tsx`                    | workspace |    41 | `rebind` | GAP-010  |
| `components/preview/closePreviewSession.ts`              | workspace |    37 | `rebind` | GAP-010  |
| `components/preview/previewAutomationTarget.ts`          | workspace |    37 | `rebind` | GAP-010  |
| `components/preview/previewViewportReadiness.ts`         | workspace |    37 | `rebind` | GAP-010  |
| `components/preview/RightPanelResizeHandle.tsx`          | workspace |    34 | `rebind` | GAP-010  |
| `components/preview/previewActionBus.ts`                 | workspace |    31 | `rebind` | GAP-010  |
| `components/preview/previewUrlPresentation.ts`           | workspace |    27 | `rebind` | GAP-010  |
| `components/preview/openDiscoveredPort.ts`               | workspace |    26 | `rebind` | GAP-010  |
| `components/preview/addBrowserSurface.ts`                | workspace |    24 | `rebind` | GAP-010  |
| `components/preview/BrowserMockup.tsx`                   | workspace |    24 | `rebind` | GAP-010  |
| `components/preview/previewConstants.ts`                 | workspace |    21 | `rebind` | GAP-010  |
| `components/preview/errorCodeMessages.ts`                | workspace |    12 | `rebind` | GAP-010  |
| `components/preview/previewEmptyStateLogic.ts`           | workspace |    11 | `rebind` | GAP-010  |
| `components/preview/previewBridge.ts`                    | workspace |     9 | `rebind` | GAP-010  |
| `components/preview/previewAutomationOpenReadiness.ts`   | workspace |     8 | `rebind` | GAP-010  |
| `components/preview/agentBrowserCursorLogic.ts`          | workspace |     6 | `rebind` | GAP-010  |
| `components/preview/fileExplorerLabel.ts`                | workspace |     6 | `rebind` | GAP-010  |
| `components/preview/previewAutomationClientId.ts`        | workspace |     4 | `rebind` | GAP-010  |

### `browser` — 19 files, 2,630 lines

| File                                       | Level     | Lines | Verdict              | Waits on |
| ------------------------------------------ | --------- | ----: | -------------------- | -------- |
| `browser/browserRecording.ts`              | workspace |   455 | `rebind`             | GAP-010  |
| `browser/BrowserDeviceToolbar.tsx`         | workspace |   340 | `rebind`             | GAP-010  |
| `browser/browserViewportLayout.ts`         | workspace |   286 | `rebind`             | GAP-010  |
| `browser/HostedBrowserWebview.tsx`         | feature   |   261 | `remove-unsupported` | —        |
| `browser/useBrowserViewportResize.ts`      | workspace |   260 | `rebind`             | GAP-010  |
| `browser/browserSurfaceStore.ts`           | workspace |   170 | `rebind`             | GAP-010  |
| `browser/BrowserViewportResizeHandles.tsx` | workspace |   169 | `rebind`             | GAP-010  |
| `browser/browserTargetResolver.ts`         | workspace |   141 | `rebind`             | GAP-010  |
| `browser/openFileInPreview.ts`             | workspace |    98 | `rebind`             | GAP-010  |
| `browser/ElectronBrowserHost.tsx`          | feature   |    92 | `remove-unsupported` | —        |
| `browser/previewWebviewConfigState.ts`     | feature   |    76 | `remove-unsupported` | —        |
| `browser/browserViewportActions.ts`        | workspace |    66 | `rebind`             | GAP-010  |
| `browser/hostedBrowserWebviewStyle.ts`     | feature   |    49 | `remove-unsupported` | —        |
| `browser/BrowserSurfaceSlot.tsx`           | workspace |    45 | `rebind`             | GAP-010  |
| `browser/desktopTabLifetime.ts`            | feature   |    44 | `remove-unsupported` | —        |
| `browser/annotationTheme.ts`               | workspace |    28 | `rebind`             | GAP-010  |
| `browser/browserPointerStore.ts`           | workspace |    25 | `rebind`             | GAP-010  |
| `browser/browserDeviceToolbarState.ts`     | workspace |    18 | `rebind`             | GAP-010  |
| `browser/browserRecordingScope.ts`         | workspace |     7 | `rebind`             | GAP-010  |

### `hooks` — 12 files, 2,245 lines

| File                               | Level     | Lines | Verdict  | Waits on |
| ---------------------------------- | --------- | ----: | -------- | -------- |
| `hooks/useThreadActions.ts`        | internal  |   580 | `rebind` | GAP-002  |
| `hooks/useHandleNewThread.ts`      | internal  |   325 | `rebind` | GAP-002  |
| `hooks/useTheme.ts`                | internal  |   324 | `reuse`  | —        |
| `hooks/useSettings.ts`             | internal  |   305 | `reuse`  | —        |
| `hooks/useLocalStorage.ts`         | internal  |   182 | `reuse`  | —        |
| `hooks/useResizableWidth.ts`       | internal  |   168 | `reuse`  | —        |
| `hooks/useCopyToClipboard.ts`      | internal  |   109 | `reuse`  | —        |
| `hooks/useMediaQuery.ts`           | internal  |    87 | `reuse`  | —        |
| `hooks/useNowMinute.ts`            | internal  |    69 | `reuse`  | —        |
| `hooks/useCommitOnBlur.ts`         | internal  |    43 | `reuse`  | —        |
| `hooks/useT3ProjectFileScripts.ts` | feature   |    34 | `rebind` | GAP-009  |
| `hooks/useTurnDiffSummaries.ts`    | workspace |    19 | `rebind` | GAP-009  |

### `lib` — 26 files, 1,961 lines

| File                              | Level     | Lines | Verdict              | Waits on |
| --------------------------------- | --------- | ----: | -------------------- | -------- |
| `lib/terminalContext.ts`          | workspace |   372 | `rebind`             | GAP-007  |
| `lib/elementContext.ts`           | workspace |   244 | `rebind`             | GAP-010  |
| `lib/turnDiffTree.ts`             | workspace |   172 | `rebind`             | GAP-009  |
| `lib/diffRendering.ts`            | workspace |   152 | `rebind`             | GAP-009  |
| `lib/contextWindow.ts`            | feature   |   112 | `rebind`             | GAP-002  |
| `lib/previewAnnotation.ts`        | workspace |   111 | `rebind`             | GAP-010  |
| `lib/openPullRequestLink.ts`      | feature   |    75 | `rebind`             | GAP-009  |
| `lib/runtime.ts`                  | internal  |    75 | `rebind`             | GAP-002  |
| `lib/lruCache.ts`                 | internal  |    68 | `reuse`              | —        |
| `lib/chatThreadActions.ts`        | internal  |    67 | `rebind`             | GAP-002  |
| `lib/storage.ts`                  | internal  |    67 | `reuse`              | —        |
| `lib/windowControlsOverlay.ts`    | feature   |    66 | `remove-unsupported` | —        |
| `lib/baseRefChoices.ts`           | feature   |    61 | `rebind`             | GAP-009  |
| `lib/projectScriptKeybindings.ts` | feature   |    61 | `rebind`             | GAP-009  |
| `lib/archivedThreadsState.ts`     | internal  |    50 | `rebind`             | GAP-002  |
| `lib/utils.ts`                    | internal  |    43 | `reuse`              | —        |
| `lib/terminalUiStateCleanup.ts`   | workspace |    33 | `rebind`             | GAP-007  |
| `lib/favicon.ts`                  | primitive |    20 | `restyle`            | —        |
| `lib/checkpointDiffState.ts`      | workspace |    18 | `rebind`             | GAP-009  |
| `lib/composerPathSearchState.ts`  | workspace |    18 | `rebind`             | GAP-008  |
| `lib/projectPaths.ts`             | feature   |    17 | `redesign`           | GAP-004  |
| `lib/previewFocus.ts`             | workspace |    15 | `rebind`             | GAP-010  |
| `lib/terminalFocus.ts`            | workspace |    14 | `rebind`             | GAP-007  |
| `lib/diffCollapse.ts`             | workspace |    13 | `rebind`             | GAP-009  |
| `lib/sourceControlActions.ts`     | feature   |    10 | `rebind`             | GAP-009  |
| `lib/threadSort.ts`               | internal  |     7 | `rebind`             | GAP-002  |

### `components/files` — 11 files, 1,797 lines

| File                                          | Level     | Lines | Verdict  | Waits on |
| --------------------------------------------- | --------- | ----: | -------- | -------- |
| `components/files/FilePreviewPanel.tsx`       | workspace |   951 | `rebind` | GAP-008  |
| `components/files/FileBrowserPanel.tsx`       | workspace |   268 | `rebind` | GAP-008  |
| `components/files/projectFilesQueryState.ts`  | workspace |   163 | `rebind` | GAP-008  |
| `components/files/fileTreeDragMention.ts`     | workspace |    95 | `rebind` | GAP-008  |
| `components/files/LocalCommentAnnotation.tsx` | workspace |    90 | `rebind` | GAP-008  |
| `components/files/fileSaveCoordinator.ts`     | workspace |    76 | `rebind` | GAP-008  |
| `components/files/fileCommentAnnotations.ts`  | workspace |    54 | `rebind` | GAP-008  |
| `components/files/fileEditorDismissal.ts`     | workspace |    53 | `rebind` | GAP-008  |
| `components/files/filePreviewMode.ts`         | workspace |    18 | `rebind` | GAP-008  |
| `components/files/filePath.ts`                | workspace |    17 | `rebind` | GAP-008  |
| `components/files/fileContentRevision.ts`     | workspace |    12 | `rebind` | GAP-008  |

### `state` — 30 files, 1,789 lines

| File                             | Level     | Lines | Verdict              | Waits on |
| -------------------------------- | --------- | ----: | -------------------- | -------- |
| `state/sourceControlActions.ts`  | feature   |   390 | `rebind`             | GAP-009  |
| `state/queries.ts`               | internal  |   257 | `rebind`             | GAP-002  |
| `state/entities.ts`              | internal  |   239 | `rebind`             | GAP-002  |
| `state/server.ts`                | internal  |   100 | `rebind`             | GAP-002  |
| `state/desktopNetworkAccess.ts`  | feature   |    98 | `remove-unsupported` | —        |
| `state/environments.ts`          | internal  |    91 | `rebind`             | GAP-002  |
| `state/terminalSessions.ts`      | workspace |    90 | `rebind`             | GAP-007  |
| `state/desktopUpdate.ts`         | feature   |    86 | `remove-unsupported` | —        |
| `state/desktopWslState.ts`       | feature   |    60 | `remove-unsupported` | —        |
| `state/desktopSshHosts.ts`       | feature   |    53 | `remove-unsupported` | —        |
| `state/shell.ts`                 | internal  |    48 | `rebind`             | GAP-002  |
| `state/threads.ts`               | internal  |    45 | `rebind`             | GAP-002  |
| `state/query.ts`                 | internal  |    36 | `rebind`             | GAP-002  |
| `state/presentation.ts`          | internal  |    31 | `rebind`             | GAP-002  |
| `state/use-atom-query-runner.ts` | internal  |    30 | `rebind`             | GAP-002  |
| `state/session.ts`               | internal  |    28 | `rebind`             | GAP-002  |
| `state/use-atom-command.ts`      | internal  |    23 | `rebind`             | GAP-002  |
| `state/primaryEnvironment.ts`    | internal  |    12 | `rebind`             | GAP-002  |
| `state/projects.ts`              | feature   |    12 | `redesign`           | GAP-004  |
| `state/vcs.ts`                   | feature   |     9 | `rebind`             | GAP-009  |
| `state/relay.ts`                 | internal  |     6 | `rebind`             | GAP-002  |
| `state/assets.ts`                | internal  |     5 | `rebind`             | GAP-002  |
| `state/auth.ts`                  | internal  |     5 | `rebind`             | GAP-002  |
| `state/filesystem.ts`            | workspace |     5 | `rebind`             | GAP-008  |
| `state/git.ts`                   | feature   |     5 | `rebind`             | GAP-009  |
| `state/orchestration.ts`         | internal  |     5 | `rebind`             | GAP-002  |
| `state/preview.ts`               | workspace |     5 | `rebind`             | GAP-010  |
| `state/review.ts`                | workspace |     5 | `rebind`             | GAP-009  |
| `state/sourceControl.ts`         | feature   |     5 | `rebind`             | GAP-009  |
| `state/terminal.ts`              | workspace |     5 | `rebind`             | GAP-007  |

### `cloud` — 12 files, 1,581 lines

| File                                | Level   | Lines | Verdict              | Waits on |
| ----------------------------------- | ------- | ----: | -------------------- | -------- |
| `cloud/linkEnvironment.ts`          | feature |   485 | `remove-unsupported` | —        |
| `cloud/dpop.ts`                     | feature |   185 | `remove-unsupported` | —        |
| `cloud/useCloudLinkController.ts`   | feature |   163 | `remove-unsupported` | —        |
| `cloud/relayClientInstallDialog.ts` | feature |   126 | `remove-unsupported` | —        |
| `cloud/managedAuth.tsx`             | feature |   116 | `remove-unsupported` | —        |
| `cloud/managedRelayState.ts`        | feature |   101 | `remove-unsupported` | —        |
| `cloud/connectCliAuth.ts`           | feature |    91 | `remove-unsupported` | —        |
| `cloud/primaryCloudLinkState.ts`    | feature |    85 | `remove-unsupported` | —        |
| `cloud/publicConfig.ts`             | feature |    83 | `remove-unsupported` | —        |
| `cloud/managedRelayLayer.ts`        | feature |    82 | `remove-unsupported` | —        |
| `cloud/linkEnvironmentAtoms.ts`     | feature |    46 | `remove-unsupported` | —        |
| `cloud/connectOnboarding.ts`        | feature |    18 | `remove-unsupported` | —        |

### `connection` — 7 files, 1,482 lines

| File                                      | Level   | Lines | Verdict              | Waits on |
| ----------------------------------------- | ------- | ----: | -------------------- | -------- |
| `connection/storage.ts`                   | feature |   656 | `redesign`           | GAP-003  |
| `connection/platform.ts`                  | feature |   622 | `redesign`           | GAP-003  |
| `connection/desktopLocal.ts`              | feature |   104 | `remove-unsupported` | —        |
| `connection/onboarding.ts`                | feature |    38 | `redesign`           | GAP-003  |
| `connection/runtime.ts`                   | feature |    29 | `redesign`           | GAP-003  |
| `connection/useDesktopLocalBootstraps.ts` | feature |    28 | `remove-unsupported` | —        |
| `connection/catalog.ts`                   | feature |     5 | `redesign`           | GAP-003  |

### `routes` — 17 files, 1,253 lines

| File                                        | Level | Lines | Verdict    | Waits on |
| ------------------------------------------- | ----- | ----: | ---------- | -------- |
| `routes/__root.tsx`                         | route |   418 | `rebind`   | GAP-001  |
| `routes/_chat.tsx`                          | route |   196 | `redesign` | GAP-004  |
| `routes/_chat.index.tsx`                    | route |   185 | `redesign` | GAP-004  |
| `routes/settings.tsx`                       | route |   130 | `redesign` | GAP-003  |
| `routes/_chat.$environmentId.$threadId.tsx` | route |    88 | `redesign` | GAP-004  |
| `routes/_chat.draft.$draftId.tsx`           | route |    88 | `redesign` | GAP-004  |
| `routes/pair.tsx`                           | route |    54 | `redesign` | GAP-001  |
| `routes/connect_.callback.tsx`              | route |    13 | `redesign` | GAP-001  |
| `routes/connect.tsx`                        | route |    13 | `redesign` | GAP-001  |
| `routes/settings.beta.tsx`                  | route |    11 | `redesign` | GAP-003  |
| `routes/settings.general.tsx`               | route |    11 | `redesign` | GAP-003  |
| `routes/settings.providers.tsx`             | route |    11 | `redesign` | GAP-003  |
| `routes/settings.archived.tsx`              | route |     7 | `redesign` | GAP-003  |
| `routes/settings.connections.tsx`           | route |     7 | `redesign` | GAP-003  |
| `routes/settings.diagnostics.tsx`           | route |     7 | `redesign` | GAP-003  |
| `routes/settings.keybindings.tsx`           | route |     7 | `redesign` | GAP-003  |
| `routes/settings.source-control.tsx`        | route |     7 | `redesign` | GAP-003  |

### `environments` — 8 files, 1,135 lines

| File                                   | Level   | Lines | Verdict              | Waits on |
| -------------------------------------- | ------- | ----: | -------------------- | -------- |
| `environments/primary/auth.ts`         | route   |   548 | `redesign`           | GAP-001  |
| `environments/primary/target.ts`       | feature |   294 | `redesign`           | GAP-003  |
| `environments/primary/context.ts`      | feature |   106 | `redesign`           | GAP-003  |
| `environments/primary/httpLayer.ts`    | feature |    58 | `redesign`           | GAP-003  |
| `environments/primary/index.ts`        | feature |    54 | `redesign`           | GAP-003  |
| `environments/primary/sessionState.ts` | feature |    37 | `redesign`           | GAP-003  |
| `environments/primary/desktopAuth.ts`  | feature |    21 | `remove-unsupported` | —        |
| `environments/primary/httpClient.ts`   | feature |    17 | `redesign`           | GAP-003  |

### `components/cloud` — 5 files, 1,062 lines

| File                                                         | Level   | Lines | Verdict              | Waits on |
| ------------------------------------------------------------ | ------- | ----: | -------------------- | -------- |
| `components/cloud/ConnectOnboardingDialog.tsx`               | feature |   433 | `remove-unsupported` | —        |
| `components/cloud/CloudEnvironmentConnectList.tsx`           | feature |   260 | `remove-unsupported` | —        |
| `components/cloud/ConnectCliAuthSurface.tsx`                 | feature |   188 | `remove-unsupported` | —        |
| `components/cloud/RelayClientInstallDialog.tsx`              | feature |   123 | `remove-unsupported` | —        |
| `components/cloud/cloudEnvironmentConnectionPresentation.ts` | feature |    58 | `remove-unsupported` | —        |

### `components/sidebar` — 3 files, 569 lines

| File                                               | Level     | Lines | Verdict              | Waits on |
| -------------------------------------------------- | --------- | ----: | -------------------- | -------- |
| `components/sidebar/SidebarUpdatePill.tsx`         | feature   |   233 | `remove-unsupported` | —        |
| `components/sidebar/SidebarProviderUpdatePill.tsx` | feature   |   208 | `remove-unsupported` | —        |
| `components/sidebar/SidebarChrome.tsx`             | workspace |   128 | `redesign`           | GAP-004  |

### `components/auth` — 2 files, 367 lines

| File                                      | Level | Lines | Verdict    | Waits on |
| ----------------------------------------- | ----- | ----: | ---------- | -------- |
| `components/auth/PairingRouteSurface.tsx` | route |   323 | `redesign` | GAP-001  |
| `components/auth/AuthSurfaceShell.tsx`    | route |    44 | `redesign` | GAP-001  |

### `components/clerk` — 4 files, 283 lines

| File                                                     | Level   | Lines | Verdict              | Waits on |
| -------------------------------------------------------- | ------- | ----: | -------------------- | -------- |
| `components/clerk/MobileClientsUserProfilePage.tsx`      | feature |   166 | `remove-unsupported` | —        |
| `components/clerk/T3ConnectSidebarSignIn.tsx`            | feature |    69 | `remove-unsupported` | —        |
| `components/clerk/MobileClientsUserProfilePage.logic.ts` | feature |    39 | `remove-unsupported` | —        |
| `components/clerk/useT3ConnectAuthPrompt.tsx`            | feature |     9 | `remove-unsupported` | —        |

### `components/diffs` — 1 files, 268 lines

| File                                       | Level     | Lines | Verdict  | Waits on |
| ------------------------------------------ | --------- | ----: | -------- | -------- |
| `components/diffs/AnnotatableCodeView.tsx` | workspace |   268 | `rebind` | GAP-009  |

### `components/desktop` — 1 files, 221 lines

| File                                             | Level   | Lines | Verdict              | Waits on |
| ------------------------------------------------ | ------- | ----: | -------------------- | -------- |
| `components/desktop/SshPasswordPromptDialog.tsx` | feature |   221 | `remove-unsupported` | —        |

### `rpc` — 3 files, 153 lines

| File                         | Level    | Lines | Verdict  | Waits on |
| ---------------------------- | -------- | ----: | -------- | -------- |
| `rpc/requestLatencyState.ts` | internal |   135 | `rebind` | GAP-002  |
| `rpc/atomRegistry.ts`        | internal |    14 | `rebind` | GAP-002  |
| `rpc/transportError.ts`      | internal |     4 | `rebind` | GAP-002  |

### `observability` — 1 files, 146 lines

| File                             | Level | Lines | Verdict  | Waits on |
| -------------------------------- | ----- | ----: | -------- | -------- |
| `observability/clientTracing.ts` | route |   146 | `rebind` | GAP-012  |

### `assets` — 1 files, 68 lines

| File                  | Level   | Lines | Verdict  | Waits on |
| --------------------- | ------- | ----: | -------- | -------- |
| `assets/assetUrls.ts` | feature |    68 | `rebind` | GAP-011  |
