# Atlas Console — classification

Every file in [the inventory](./01-UI-INVENTORY.md), assigned one of six verdicts. The machine-readable
sidecar is [`03-classification.json`](./03-classification.json) — same rows, same keys
(`path`, `area`, `level`, `verdict`, `reason`, `atlasBinding`, `gapId`, `loc`) — so the
verdicts can drive a scripted strip later rather than being re-derived by hand.

Two rules keep the table auditable:

1. Every `remove-*` cites either the Atlas route that already owns the capability or the specific
   upstream product it belongs to.
2. Every `rebind` and `redesign` names an `atlasBinding` that exists today, or carries a `gapId`
   resolved in [05-GAPS.md](./05-GAPS.md) — never both absent.

## Verdicts

| Verdict              | Meaning                                                              | Files |  Lines |
| -------------------- | -------------------------------------------------------------------- | ----: | -----: |
| `remove-unsupported` | Delete: belongs to an upstream T3 product this fork does not ship.   |    49 |  7,246 |
| `remove-duplicate`   | Delete: Atlas already owns this capability.                          |    15 |  3,051 |
| `redesign`           | Shape must change because the Atlas concept differs from the T3 one. |    68 | 21,140 |
| `rebind`             | Same interface, data source swapped to Atlas.                        |   216 | 55,388 |
| `restyle`            | Visual and terminology only; behaviour unchanged.                    |     5 |  1,766 |
| `reuse`              | Take as-is. No Atlas concept, no data binding.                       |    79 | 13,423 |

The shape of the port, read off the table: **10,297 lines delete outright**, **15,189 lines survive untouched or nearly so**, and the remaining **76,528 lines are the actual work** — and almost none of it can start before Atlas grows the routes in [05-GAPS.md](./05-GAPS.md).

## Rows

Grouped by verdict, then by the rationale that produced them. Files are listed largest first.

## `remove-unsupported` — 49 files, 7,246 lines

Delete: belongs to an upstream T3 product this fork does not ship.

### Updating a locally installed provider CLI or the T3 server binary; Atlas backends are fleet nodes, updated by deploy, not by the console.

| File                                                          | Level   | Lines |
| ------------------------------------------------------------- | ------- | ----: |
| `components/ProviderUpdateLaunchNotification.logic.ts`        | feature |   835 |
| `components/ProviderUpdateEnvironmentRows.tsx`                | feature |   397 |
| `components/ProviderUpdatePrimaryNotification.tsx`            | feature |   331 |
| `components/sidebar/SidebarUpdatePill.tsx`                    | feature |   233 |
| `components/sidebar/SidebarProviderUpdatePill.tsx`            | feature |   208 |
| `components/ServerUpdateAction.tsx`                           | feature |   201 |
| `components/ProviderUpdateLaunchNotification.tsx`             | feature |   198 |
| `versionSkew.ts`                                              | feature |   147 |
| `components/ProviderUpdateLaunchNotification.environments.ts` | feature |    97 |
| `providerUpdateDismissal.ts`                                  | feature |    93 |

### T3 Connect cloud/relay client runtime; superseded by tailnet addressing.

| File                                | Level   | Lines |
| ----------------------------------- | ------- | ----: |
| `cloud/linkEnvironment.ts`          | feature |   485 |
| `cloud/dpop.ts`                     | feature |   185 |
| `cloud/useCloudLinkController.ts`   | feature |   163 |
| `cloud/relayClientInstallDialog.ts` | feature |   126 |
| `cloud/managedAuth.tsx`             | feature |   116 |
| `cloud/managedRelayState.ts`        | feature |   101 |
| `cloud/connectCliAuth.ts`           | feature |    91 |
| `cloud/primaryCloudLinkState.ts`    | feature |    85 |
| `cloud/publicConfig.ts`             | feature |    83 |
| `cloud/managedRelayLayer.ts`        | feature |    82 |
| `cloud/linkEnvironmentAtoms.ts`     | feature |    46 |
| `cloud/connectOnboarding.ts`        | feature |    18 |

### T3 Connect cloud onboarding and managed relay; Atlas reaches nodes over the tailnet.

| File                                                         | Level   | Lines |
| ------------------------------------------------------------ | ------- | ----: |
| `components/cloud/ConnectOnboardingDialog.tsx`               | feature |   433 |
| `components/cloud/CloudEnvironmentConnectList.tsx`           | feature |   260 |
| `components/cloud/ConnectCliAuthSurface.tsx`                 | feature |   188 |
| `components/cloud/RelayClientInstallDialog.tsx`              | feature |   123 |
| `components/cloud/cloudEnvironmentConnectionPresentation.ts` | feature |    58 |

### Desktop/WSL host integration; not shipped by this fork.

| File                                      | Level   | Lines |
| ----------------------------------------- | ------- | ----: |
| `wslPaths.ts`                             | feature |   159 |
| `components/desktopUpdate.logic.ts`       | feature |   115 |
| `connection/desktopLocal.ts`              | feature |   104 |
| `state/desktopNetworkAccess.ts`           | feature |    98 |
| `state/desktopUpdate.ts`                  | feature |    86 |
| `lib/windowControlsOverlay.ts`            | feature |    66 |
| `state/desktopWslState.ts`                | feature |    60 |
| `state/desktopSshHosts.ts`                | feature |    53 |
| `connection/useDesktopLocalBootstraps.ts` | feature |    28 |
| `environments/primary/desktopAuth.ts`     | feature |    21 |
| `workspaceTitlebar.ts`                    | feature |     2 |

### Electron/webview host path; this fork ships the browser client only.

| File                                   | Level   | Lines |
| -------------------------------------- | ------- | ----: |
| `browser/HostedBrowserWebview.tsx`     | feature |   261 |
| `browser/ElectronBrowserHost.tsx`      | feature |    92 |
| `browser/previewWebviewConfigState.ts` | feature |    76 |
| `browser/hostedBrowserWebviewStyle.ts` | feature |    49 |
| `browser/desktopTabLifetime.ts`        | feature |    44 |

### Clerk / T3 Connect account product; Atlas authenticates against the fleet, not a SaaS identity provider.

| File                                                     | Level   | Lines |
| -------------------------------------------------------- | ------- | ----: |
| `components/clerk/MobileClientsUserProfilePage.tsx`      | feature |   166 |
| `components/clerk/T3ConnectSidebarSignIn.tsx`            | feature |    69 |
| `components/clerk/MobileClientsUserProfilePage.logic.ts` | feature |    39 |
| `components/clerk/useT3ConnectAuthPrompt.tsx`            | feature |     9 |

### Desktop-only dialog; apps/desktop has zero tracked files in this fork.

| File                                             | Level   | Lines |
| ------------------------------------------------ | ------- | ----: |
| `components/desktop/SshPasswordPromptDialog.tsx` | feature |   221 |

### Tied to the T3 server-update notification family.

| File                                         | Level   | Lines |
| -------------------------------------------- | ------- | ----: |
| `components/KeybindingsUpdateToast.logic.ts` | feature |    45 |

## `remove-duplicate` — 15 files, 3,051 lines

Delete: Atlas already owns this capability.

### Provider-instance CRUD models 'a provider = a local CLI install you configure'. Atlas discovers backends and their models from gossip manifests and vitals; there is nothing for a lens to configure.

**Binds to:** `/_members`

| File                                                     | Level   | Lines |
| -------------------------------------------------------- | ------- | ----: |
| `components/settings/ProviderInstanceCard.tsx`           | feature |   806 |
| `components/settings/AddProviderInstanceDialog.tsx`      | feature |   437 |
| `components/settings/ProviderSettingsForm.tsx`           | feature |   304 |
| `components/settings/providerStatus.ts`                  | feature |   117 |
| `components/settings/providerDriverMeta.ts`              | feature |   108 |
| `components/settings/AddProviderInstanceWizardSteps.tsx` | feature |    73 |
| `components/settings/AddProviderInstanceDialog.logic.ts` | feature |    36 |

### Client-side provider/model catalogue; Atlas owns model availability per node.

**Binds to:** `/_members`

| File                           | Level   | Lines |
| ------------------------------ | ------- | ----: |
| `providerInstances.ts`         | feature |   362 |
| `providerSkillSearch.ts`       | feature |   105 |
| `providerModels.ts`            | feature |   101 |
| `modelOrdering.ts`             | feature |    86 |
| `providerSkillPresentation.ts` | feature |    53 |

### Client-side run recovery and history bootstrap; Atlas runs are durable isolates that resume on their own alarm.

**Binds to:** `/status`

| File                       | Level   | Lines |
| -------------------------- | ------- | ----: |
| `orchestrationRecovery.ts` | feature |   211 |
| `historyBootstrap.ts`      | feature |   139 |

### Local HTTP shim; Atlas is addressed directly.

| File          | Level   | Lines |
| ------------- | ------- | ----: |
| `localApi.ts` | feature |   113 |

## `redesign` — 68 files, 21,140 lines

Shape must change because the Atlas concept differs from the T3 one.

### Primary navigation gains a tier: fleet -> workspace -> run. T3 has project -> thread and no node concept.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-004](./05-GAPS.md)

| File                                   | Level     | Lines |
| -------------------------------------- | --------- | ----: |
| `components/Sidebar.tsx`               | workspace | 3,643 |
| `components/SidebarV2.tsx`             | workspace | 2,732 |
| `components/Sidebar.logic.ts`          | workspace |   833 |
| `components/SidebarStageBackdrop.tsx`  | workspace |   330 |
| `sidebarProjectGrouping.ts`            | workspace |   262 |
| `components/AppSidebarLayout.tsx`      | workspace |   188 |
| `components/sidebar/SidebarChrome.tsx` | workspace |   128 |
| `components/Sidebar.snooze.ts`         | workspace |   127 |
| `components/threadSidebarWidth.ts`     | workspace |    22 |

### Becomes the fleet page: nodes, their backends, models and capabilities. Most of the remote/relay connection machinery falls away with the tailnet.

**Binds to:** `/_members` · **Waits on:** [GAP-003](./05-GAPS.md)

| File                                                | Level | Lines |
| --------------------------------------------------- | ----- | ----: |
| `components/settings/ConnectionsSettings.tsx`       | route | 3,398 |
| `components/settings/ProviderModelsSection.tsx`     | route |   411 |
| `components/settings/ProviderAccentColorPicker.tsx` | route |   335 |
| `components/settings/ConnectionsSettings.logic.ts`  | route |    21 |

### Model choice becomes 'which body on which node', not 'which local CLI'. Backed by per-node manifests and the Ollama catalog in gossip vitals.

**Binds to:** `/_members` · **Waits on:** [GAP-005](./05-GAPS.md)

| File                                            | Level   | Lines |
| ----------------------------------------------- | ------- | ----: |
| `components/chat/ModelPickerContent.tsx`        | feature |   677 |
| `components/chat/TraitsPicker.tsx`              | feature |   523 |
| `modelSelection.ts`                             | feature |   329 |
| `components/chat/ModelPickerSidebar.tsx`        | feature |   250 |
| `components/chat/ProviderModelPicker.tsx`       | feature |   211 |
| `components/chat/ModelListRow.tsx`              | feature |   141 |
| `components/chat/composerProviderState.tsx`     | feature |   126 |
| `components/chat/modelPickerSearch.ts`          | feature |    87 |
| `components/chat/ProviderInstanceIcon.tsx`      | feature |    79 |
| `components/chat/ProviderStatusBanner.tsx`      | feature |    79 |
| `components/chat/providerIconUtils.ts`          | feature |    60 |
| `components/chat/modelPickerModelHighlights.ts` | feature |    13 |
| `modelPickerVisibility.ts`                      | feature |    13 |

### Settings hierarchy re-sections around Atlas: fleet, backends, workspaces, console preferences.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-003](./05-GAPS.md)

| File                                          | Level | Lines |
| --------------------------------------------- | ----- | ----: |
| `components/settings/SettingsPanels.tsx`      | route | 1,765 |
| `routes/settings.tsx`                         | route |   130 |
| `components/settings/settingsLayout.tsx`      | route |   129 |
| `components/settings/SettingsSidebarNav.tsx`  | route |   127 |
| `components/settings/SettingsPanels.logic.ts` | route |   125 |
| `components/settings/BetaSettingsPanel.tsx`   | route |   108 |
| `routes/settings.beta.tsx`                    | route |    11 |
| `routes/settings.general.tsx`                 | route |    11 |
| `routes/settings.providers.tsx`               | route |    11 |
| `routes/settings.archived.tsx`                | route |     7 |
| `routes/settings.connections.tsx`             | route |     7 |
| `routes/settings.diagnostics.tsx`             | route |     7 |
| `routes/settings.keybindings.tsx`             | route |     7 |
| `routes/settings.source-control.tsx`          | route |     7 |

### Environment connection model is replaced by fleet membership; a node is discovered, not configured.

**Binds to:** `/_members` · **Waits on:** [GAP-003](./05-GAPS.md)

| File                                   | Level   | Lines |
| -------------------------------------- | ------- | ----: |
| `connection/storage.ts`                | feature |   656 |
| `connection/platform.ts`               | feature |   622 |
| `environments/primary/target.ts`       | feature |   294 |
| `environments/primary/context.ts`      | feature |   106 |
| `environments/primary/httpLayer.ts`    | feature |    58 |
| `environments/primary/index.ts`        | feature |    54 |
| `connection/onboarding.ts`             | feature |    38 |
| `environments/primary/sessionState.ts` | feature |    37 |
| `connection/runtime.ts`                | feature |    29 |
| `environments/primary/httpClient.ts`   | feature |    17 |
| `connection/catalog.ts`                | feature |     5 |

### Atlas has no auth on :3010 at all. T3's one-time pairing-token flow is the closest donor, but the target is an Atlas-owned scheme.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-001](./05-GAPS.md)

| File                                      | Level | Lines |
| ----------------------------------------- | ----- | ----: |
| `environments/primary/auth.ts`            | route |   548 |
| `components/auth/PairingRouteSurface.tsx` | route |   323 |
| `hostedPairing.ts`                        | route |    89 |
| `routes/pair.tsx`                         | route |    54 |
| `components/auth/AuthSurfaceShell.tsx`    | route |    44 |
| `components/settings/pairingUrls.ts`      | route |    20 |
| `routes/connect_.callback.tsx`            | route |    13 |
| `routes/connect.tsx`                      | route |    13 |
| `pairingUrl.ts`                           | route |     5 |

### Route shape changes from /:environmentId/:threadId to fleet/workspace/run addressing.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-004](./05-GAPS.md)

| File                                        | Level | Lines |
| ------------------------------------------- | ----- | ----: |
| `routes/_chat.tsx`                          | route |   196 |
| `routes/_chat.index.tsx`                    | route |   185 |
| `routes/_chat.$environmentId.$threadId.tsx` | route |    88 |
| `routes/_chat.draft.$draftId.tsx`           | route |    88 |

### A workspace is not a modeled entity in Atlas today; it is only a shell workdir.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-004](./05-GAPS.md)

| File                  | Level   | Lines |
| --------------------- | ------- | ----: |
| `worktreeCleanup.ts`  | feature |    45 |
| `lib/projectPaths.ts` | feature |    17 |
| `logicalProject.ts`   | feature |    14 |
| `state/projects.ts`   | feature |    12 |

## `rebind` — 216 files, 55,388 lines

Same interface, data source swapped to Atlas.

### Composer. Submit binds to /say for a warm thread and /start for a new run; draft state stays lens-local.

**Binds to:** `/say`

| File                                              | Level     | Lines |
| ------------------------------------------------- | --------- | ----: |
| `composerDraftStore.ts`                           | workspace | 3,574 |
| `components/chat/ChatComposer.tsx`                | workspace | 2,747 |
| `components/ComposerPromptEditor.tsx`             | workspace | 1,842 |
| `composer-logic.ts`                               | workspace |   287 |
| `components/chat/ComposerCommandMenu.tsx`         | workspace |   258 |
| `components/chat/ComposerPrimaryActions.tsx`      | workspace |   241 |
| `composer-editor-mentions.ts`                     | workspace |   223 |
| `components/chat/ComposerBannerStack.tsx`         | workspace |   208 |
| `components/chat/DraftHeroHeadline.tsx`           | workspace |   158 |
| `components/chat/PanelLayoutControls.tsx`         | workspace |   112 |
| `components/composerInlineTokenPaste.ts`          | workspace |   104 |
| `components/chat/composerMentionDrag.ts`          | workspace |    98 |
| `components/chat/PierreEntryIcon.tsx`             | workspace |    95 |
| `components/chat/CompactComposerControlsMenu.tsx` | workspace |    91 |
| `components/chat/composerSlashCommandSearch.ts`   | workspace |    83 |
| `components/chat/draftHeroTransition.ts`          | workspace |    82 |
| `components/composerFooterLayout.ts`              | workspace |    24 |
| `components/chat/composerMenuHighlight.ts`        | workspace |    20 |
| `components/composerInlineChip.ts`                | workspace |    20 |
| `composerHandleContext.ts`                        | workspace |    10 |

### The activity timeline. Atlas stores message and tool_call rows per run but publishes nothing; needs the feed publisher.

**Binds to:** `/since` · **Waits on:** [GAP-002](./05-GAPS.md)

| File                                         | Level     | Lines |
| -------------------------------------------- | --------- | ----: |
| `components/ChatView.tsx`                    | workspace | 6,053 |
| `components/chat/MessagesTimeline.tsx`       | workspace | 2,081 |
| `components/chat/MessagesTimeline.logic.ts`  | workspace |   640 |
| `components/ChatView.logic.ts`               | workspace |   544 |
| `components/ThreadStatusIndicators.tsx`      | workspace |   358 |
| `components/chat/ChatHeader.tsx`             | workspace |   161 |
| `components/chat/SkillInlineText.tsx`        | workspace |    92 |
| `components/chat/MessageCopyButton.tsx`      | workspace |    82 |
| `components/chat/timelineScrollAnchoring.ts` | workspace |    78 |
| `components/chat/ThreadErrorBanner.tsx`      | workspace |    37 |

### Application preview and the embedded browser. No Atlas equivalent for local-server discovery or preview hosting on a node.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-010](./05-GAPS.md)

| File                                                     | Level     | Lines |
| -------------------------------------------------------- | --------- | ----: |
| `components/preview/PreviewView.tsx`                     | workspace |   666 |
| `components/preview/PreviewAutomationHosts.tsx`          | workspace |   608 |
| `browser/browserRecording.ts`                            | workspace |   455 |
| `previewStateStore.ts`                                   | workspace |   428 |
| `browser/BrowserDeviceToolbar.tsx`                       | workspace |   340 |
| `components/preview/PreviewChromeRow.tsx`                | workspace |   291 |
| `browser/browserViewportLayout.ts`                       | workspace |   286 |
| `browser/useBrowserViewportResize.ts`                    | workspace |   260 |
| `lib/elementContext.ts`                                  | workspace |   244 |
| `components/preview/previewAutomationErrors.ts`          | workspace |   235 |
| `components/preview/PreviewMoreMenu.tsx`                 | workspace |   177 |
| `browser/browserSurfaceStore.ts`                         | workspace |   170 |
| `browser/BrowserViewportResizeHandles.tsx`               | workspace |   169 |
| `components/preview/usePreviewBridge.ts`                 | workspace |   148 |
| `components/chat/ComposerPreviewAnnotationCards.tsx`     | workspace |   144 |
| `browser/browserTargetResolver.ts`                       | workspace |   141 |
| `components/preview/useDiscoveredLocalServers.ts`        | workspace |   138 |
| `components/preview/previewAutomationRequestConsumer.ts` | workspace |   121 |
| `components/preview/usePreviewSession.ts`                | workspace |   120 |
| `lib/previewAnnotation.ts`                               | workspace |   111 |
| `components/preview/openTerminalLinkInPreview.ts`        | workspace |   109 |
| `browser/openFileInPreview.ts`                           | workspace |    98 |
| `components/chat/ComposerPendingElementContexts.tsx`     | workspace |    95 |
| `components/preview/PreviewUnreachable.tsx`              | workspace |    90 |
| `components/preview/PreviewPanelShell.tsx`               | workspace |    88 |
| `components/preview/AgentBrowserCursor.tsx`              | workspace |    78 |
| `browser/browserViewportActions.ts`                      | workspace |    66 |
| `components/preview/PreviewEmptyState.tsx`               | workspace |    65 |
| `components/preview/ZoomIndicator.tsx`                   | workspace |    54 |
| `components/preview/PreviewLocalServerCard.tsx`          | workspace |    52 |
| `portDiscoveryState.ts`                                  | workspace |    51 |
| `browser/BrowserSurfaceSlot.tsx`                         | workspace |    45 |
| `components/preview/useLoadingProgress.ts`               | workspace |    45 |
| `components/preview/openPreviewSession.ts`               | workspace |    42 |
| `components/preview/PreviewPanel.tsx`                    | workspace |    41 |
| `components/preview/closePreviewSession.ts`              | workspace |    37 |
| `components/preview/previewAutomationTarget.ts`          | workspace |    37 |
| `components/preview/previewViewportReadiness.ts`         | workspace |    37 |
| `components/preview/RightPanelResizeHandle.tsx`          | workspace |    34 |
| `components/preview/previewActionBus.ts`                 | workspace |    31 |
| `browser/annotationTheme.ts`                             | workspace |    28 |
| `components/preview/previewUrlPresentation.ts`           | workspace |    27 |
| `components/preview/openDiscoveredPort.ts`               | workspace |    26 |
| `browser/browserPointerStore.ts`                         | workspace |    25 |
| `components/preview/addBrowserSurface.ts`                | workspace |    24 |
| `components/preview/BrowserMockup.tsx`                   | workspace |    24 |
| `components/preview/previewConstants.ts`                 | workspace |    21 |
| `browser/browserDeviceToolbarState.ts`                   | workspace |    18 |
| `lib/previewFocus.ts`                                    | workspace |    15 |
| `components/preview/errorCodeMessages.ts`                | workspace |    12 |
| `components/preview/previewEmptyStateLogic.ts`           | workspace |    11 |
| `components/preview/previewBridge.ts`                    | workspace |     9 |
| `components/preview/previewAutomationOpenReadiness.ts`   | workspace |     8 |
| `browser/browserRecordingScope.ts`                       | workspace |     7 |
| `components/preview/agentBrowserCursorLogic.ts`          | workspace |     6 |
| `components/preview/fileExplorerLabel.ts`                | workspace |     6 |
| `state/preview.ts`                                       | workspace |     5 |
| `components/preview/previewAutomationClientId.ts`        | workspace |     4 |

### Source control. Needs an Atlas git/worktree surface; execution belongs on the node, the console only renders.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-009](./05-GAPS.md)

| File                                              | Level   | Lines |
| ------------------------------------------------- | ------- | ----: |
| `components/GitActionsControl.tsx`                | feature | 2,035 |
| `components/BranchToolbarBranchSelector.tsx`      | feature |   835 |
| `components/ProjectScriptsControl.tsx`            | feature |   623 |
| `components/settings/SourceControlSettings.tsx`   | feature |   518 |
| `components/GitActionsControl.logic.ts`           | feature |   417 |
| `state/sourceControlActions.ts`                   | feature |   390 |
| `components/BranchToolbar.tsx`                    | feature |   363 |
| `components/PullRequestThreadDialog.tsx`          | feature |   304 |
| `components/BranchToolbar.logic.ts`               | feature |   225 |
| `components/BranchToolbarEnvModeSelector.tsx`     | feature |   123 |
| `components/BranchToolbarEnvironmentSelector.tsx` | feature |    91 |
| `projectScripts.ts`                               | feature |    87 |
| `lib/openPullRequestLink.ts`                      | feature |    75 |
| `sourceControlPresentation.ts`                    | feature |    62 |
| `lib/baseRefChoices.ts`                           | feature |    61 |
| `lib/projectScriptKeybindings.ts`                 | feature |    61 |
| `pullRequestReference.ts`                         | feature |    59 |
| `hooks/useT3ProjectFileScripts.ts`                | feature |    34 |
| `lib/sourceControlActions.ts`                     | feature |    10 |
| `state/vcs.ts`                                    | feature |     9 |
| `state/git.ts`                                    | feature |     5 |
| `state/sourceControl.ts`                          | feature |     5 |

### Atom wiring and thread actions over the RPC client; the shape survives, the transport and payloads change.

**Binds to:** `/since` · **Waits on:** [GAP-002](./05-GAPS.md)

| File                             | Level    | Lines |
| -------------------------------- | -------- | ----: |
| `session-logic.ts`               | internal | 1,401 |
| `hooks/useThreadActions.ts`      | internal |   580 |
| `hooks/useHandleNewThread.ts`    | internal |   325 |
| `state/queries.ts`               | internal |   257 |
| `state/entities.ts`              | internal |   239 |
| `rpc/requestLatencyState.ts`     | internal |   135 |
| `threadSelectionStore.ts`        | internal |   122 |
| `threadRoutes.ts`                | internal |   103 |
| `state/server.ts`                | internal |   100 |
| `orchestrationEventEffects.ts`   | internal |    94 |
| `state/environments.ts`          | internal |    91 |
| `lib/runtime.ts`                 | internal |    75 |
| `lib/chatThreadActions.ts`       | internal |    67 |
| `lib/archivedThreadsState.ts`    | internal |    50 |
| `state/shell.ts`                 | internal |    48 |
| `state/threads.ts`               | internal |    45 |
| `state/query.ts`                 | internal |    36 |
| `state/presentation.ts`          | internal |    31 |
| `state/use-atom-query-runner.ts` | internal |    30 |
| `state/session.ts`               | internal |    28 |
| `state/use-atom-command.ts`      | internal |    23 |
| `rpc/atomRegistry.ts`            | internal |    14 |
| `state/primaryEnvironment.ts`    | internal |    12 |
| `lib/threadSort.ts`              | internal |     7 |
| `state/relay.ts`                 | internal |     6 |
| `state/assets.ts`                | internal |     5 |
| `state/auth.ts`                  | internal |     5 |
| `state/orchestration.ts`         | internal |     5 |
| `rpc/transportError.ts`          | internal |     4 |

### Terminal. hearth is a real PTY behind the run_bash tool but has no attach/list/keys HTTP surface.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-007](./05-GAPS.md)

| File                                                  | Level     | Lines |
| ----------------------------------------------------- | --------- | ----: |
| `components/ThreadTerminalDrawer.tsx`                 | workspace | 1,549 |
| `terminalUiStateStore.ts`                             | workspace |   781 |
| `lib/terminalContext.ts`                              | workspace |   372 |
| `terminal-links.ts`                                   | workspace |   286 |
| `state/terminalSessions.ts`                           | workspace |    90 |
| `components/chat/userMessageTerminalContexts.ts`      | workspace |    58 |
| `components/chat/TerminalContextInlineChip.tsx`       | workspace |    47 |
| `components/chat/ComposerPendingTerminalContexts.tsx` | workspace |    44 |
| `lib/terminalUiStateCleanup.ts`                       | workspace |    33 |
| `lib/terminalFocus.ts`                                | workspace |    14 |
| `state/terminal.ts`                                   | workspace |     5 |

### Content rendering; reusable, but attachment and asset URLs resolve through Atlas.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-011](./05-GAPS.md)

| File                                         | Level   | Lines |
| -------------------------------------------- | ------- | ----: |
| `components/ChatMarkdown.tsx`                | feature | 1,566 |
| `components/chat/OpenInPicker.tsx`           | feature |   312 |
| `markdown-clipboard.ts`                      | feature |   311 |
| `contextMenuFallback.ts`                     | feature |   307 |
| `markdown-links.ts`                          | feature |   213 |
| `markdown-list-indentation.ts`               | feature |   143 |
| `components/chat/ExpandedImageDialog.tsx`    | feature |   110 |
| `components/chat/externalLinkContextMenu.ts` | feature |    78 |
| `assets/assetUrls.ts`                        | feature |    68 |
| `components/chat/ExpandedImagePreview.tsx`   | feature |    32 |

### Diff and review. Git awareness does not exist in atlas-host; warden/src/checkpoint.rs has it in the wrong layer.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-009](./05-GAPS.md)

| File                                                | Level     | Lines |
| --------------------------------------------------- | --------- | ----: |
| `components/DiffPanel.tsx`                          | workspace |   941 |
| `reviewCommentContext.ts`                           | workspace |   459 |
| `components/chat/ChangedFilesTree.tsx`              | workspace |   330 |
| `components/diffs/AnnotatableCodeView.tsx`          | workspace |   268 |
| `lib/turnDiffTree.ts`                               | workspace |   172 |
| `lib/diffRendering.ts`                              | workspace |   152 |
| `diffPanelStore.ts`                                 | workspace |   144 |
| `components/chat/changedFilesPresentation.ts`       | workspace |   102 |
| `components/DiffPanelShell.tsx`                     | workspace |    88 |
| `components/chat/ComposerPendingReviewComments.tsx` | workspace |    60 |
| `components/chat/DiffStatLabel.tsx`                 | workspace |    53 |
| `diffFileActions.ts`                                | workspace |    25 |
| `hooks/useTurnDiffSummaries.ts`                     | workspace |    19 |
| `lib/checkpointDiffState.ts`                        | workspace |    18 |
| `lib/diffCollapse.ts`                               | workspace |    13 |
| `state/review.ts`                                   | workspace |     5 |

### Command palette structure is reusable; its result sources become Atlas nouns and need list endpoints.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-004](./05-GAPS.md)

| File                                   | Level   | Lines |
| -------------------------------------- | ------- | ----: |
| `components/CommandPalette.tsx`        | feature | 2,094 |
| `components/CommandPalette.logic.ts`   | feature |   380 |
| `components/CommandPaletteResults.tsx` | feature |   146 |
| `commandPaletteBus.ts`                 | feature |    30 |

### File browser and editor. Filesystem access is deliberately absent from Atlas (NATIVE_DISALLOWED_TOOLS); this needs a decision, not just an endpoint.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-008](./05-GAPS.md)

| File                                          | Level     | Lines |
| --------------------------------------------- | --------- | ----: |
| `components/files/FilePreviewPanel.tsx`       | workspace |   951 |
| `components/files/FileBrowserPanel.tsx`       | workspace |   268 |
| `components/files/projectFilesQueryState.ts`  | workspace |   163 |
| `components/files/fileTreeDragMention.ts`     | workspace |    95 |
| `components/files/LocalCommentAnnotation.tsx` | workspace |    90 |
| `components/files/fileSaveCoordinator.ts`     | workspace |    76 |
| `filePathDisplay.ts`                          | workspace |    57 |
| `components/files/fileCommentAnnotations.ts`  | workspace |    54 |
| `components/files/fileEditorDismissal.ts`     | workspace |    53 |
| `components/chat/FileTagChip.tsx`             | workspace |    39 |
| `components/files/filePreviewMode.ts`         | workspace |    18 |
| `lib/composerPathSearchState.ts`              | workspace |    18 |
| `components/files/filePath.ts`                | workspace |    17 |
| `components/files/fileContentRevision.ts`     | workspace |    12 |
| `state/filesystem.ts`                         | workspace |     5 |

### Diagnostics. Atlas exposes causal spans at /\_trace and node vitals in gossip beats.

**Binds to:** `/_trace` · **Waits on:** [GAP-012](./05-GAPS.md)

| File                                          | Level | Lines |
| --------------------------------------------- | ----- | ----: |
| `components/settings/DiagnosticsSettings.tsx` | route | 1,355 |
| `observability/clientTracing.ts`              | route |   146 |

### App shell; overlay set changes with the removed products.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-001](./05-GAPS.md)

| File                | Level | Lines |
| ------------------- | ----- | ----: |
| `routes/__root.tsx` | route |   418 |
| `routeTree.gen.ts`  | route |   392 |
| `main.tsx`          | route |    54 |
| `AppRoot.tsx`       | route |    21 |
| `router.ts`         | route |    19 |

### Plan surface; needs a plan frame in the normalized vocabulary.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-002](./05-GAPS.md)

| File                                             | Level   | Lines |
| ------------------------------------------------ | ------- | ----: |
| `components/PlanSidebar.tsx`                     | feature |   284 |
| `components/chat/ProposedPlanCard.tsx`           | feature |   256 |
| `proposedPlan.ts`                                | feature |   122 |
| `components/chat/ComposerPlanFollowUpBanner.tsx` | feature |    28 |

### Approvals and questions. Atlas has the kernel (policy.rs Verdict::Confirm, Trust) but no round-trip; warden's Approval/Question frames and Cmd::Approve/Answer are the donor.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-006](./05-GAPS.md)

| File                                                 | Level   | Lines |
| ---------------------------------------------------- | ------- | ----: |
| `components/chat/ComposerPendingUserInputPanel.tsx`  | feature |   227 |
| `pendingUserInput.ts`                                | feature |   172 |
| `components/chat/ComposerPendingApprovalActions.tsx` | feature |    55 |
| `components/chat/ComposerPendingApprovalPanel.tsx`   | feature |    49 |

### Context-pressure meter; warden already emits a ctx frame (pane.rs:605), Atlas does not.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-002](./05-GAPS.md)

| File                                     | Level   | Lines |
| ---------------------------------------- | ------- | ----: |
| `components/chat/ContextWindowMeter.tsx` | feature |   139 |
| `lib/contextWindow.ts`                   | feature |   112 |

### Connection and request feedback bound to the Atlas socket.

**Binds to:** _nothing that exists today_ · **Waits on:** [GAP-001](./05-GAPS.md)

| File                                            | Level   | Lines |
| ----------------------------------------------- | ------- | ----: |
| `components/ProjectFavicon.tsx`                 | feature |    76 |
| `components/SlowRpcRequestToastCoordinator.tsx` | feature |    73 |
| `components/ConnectionStatusDot.tsx`            | feature |    56 |
| `components/NoActiveThreadState.tsx`            | feature |    44 |

## `restyle` — 5 files, 1,766 lines

Visual and terminology only; behaviour unchanged.

### Theme tokens and branding; Atlas identity replaces T3's.

| File                            | Level     | Lines |
| ------------------------------- | --------- | ----: |
| `index.css`                     | primitive | 1,580 |
| `components/color-selector.tsx` | primitive |   101 |
| `branding.logic.ts`             | primitive |    38 |
| `branding.ts`                   | primitive |    27 |
| `lib/favicon.ts`                | primitive |    20 |

## `reuse` — 79 files, 13,423 lines

Take as-is. No Atlas concept, no data binding.

### Design-system primitive; no data binding, no product concept.

| File                             | Level     | Lines |
| -------------------------------- | --------- | ----: |
| `components/ui/sidebar.tsx`      | primitive | 1,028 |
| `components/ui/toast.tsx`        | primitive |   813 |
| `components/ui/combobox.tsx`     | primitive |   403 |
| `components/ui/menu.tsx`         | primitive |   302 |
| `components/ui/autocomplete.tsx` | primitive |   271 |
| `components/ui/command.tsx`      | primitive |   240 |
| `components/ui/select.tsx`       | primitive |   240 |
| `components/ui/sheet.tsx`        | primitive |   200 |
| `components/ui/card.tsx`         | primitive |   196 |
| `components/ui/dialog.tsx`       | primitive |   183 |
| `components/ui/number-field.tsx` | primitive |   156 |
| `components/ui/alert-dialog.tsx` | primitive |   144 |
| `components/ui/toast.logic.ts`   | primitive |   115 |
| `components/ui/empty.tsx`        | primitive |   114 |
| `components/ui/alert.tsx`        | primitive |   113 |
| `components/ui/popover.tsx`      | primitive |   111 |
| `components/ui/toggle-group.tsx` | primitive |    96 |
| `components/ui/input-group.tsx`  | primitive |    95 |
| `components/ui/group.tsx`        | primitive |    93 |
| `components/ui/table.tsx`        | primitive |    87 |
| `components/ui/qr-code.tsx`      | primitive |    81 |
| `components/ui/button.tsx`       | primitive |    74 |
| `components/ui/scroll-area.tsx`  | primitive |    74 |
| `components/ui/input.tsx`        | primitive |    73 |
| `components/ui/checkbox.tsx`     | primitive |    60 |
| `components/ui/field.tsx`        | primitive |    59 |
| `components/ui/tooltip.tsx`      | primitive |    59 |
| `components/ui/toastHelpers.ts`  | primitive |    58 |
| `components/ui/badge.tsx`        | primitive |    56 |
| `components/ui/toggle.tsx`       | primitive |    48 |
| `components/ui/textarea.tsx`     | primitive |    45 |
| `components/ui/collapsible.tsx`  | primitive |    39 |
| `components/ui/radio-group.tsx`  | primitive |    36 |
| `components/ui/kbd.tsx`          | primitive |    28 |
| `components/ui/switch.tsx`       | primitive |    27 |
| `components/ui/fieldset.tsx`     | primitive |    26 |
| `components/ui/label.tsx`        | primitive |    24 |
| `components/ui/draft-input.tsx`  | primitive |    21 |
| `components/ui/separator.tsx`    | primitive |    19 |
| `components/ui/form.tsx`         | primitive |    17 |
| `components/ui/skeleton.tsx`     | primitive |    16 |
| `components/ui/spinner.tsx`      | primitive |    15 |
| `components/ui/dialog-styles.ts` | primitive |    10 |
| `components/ui/sidebarState.ts`  | primitive |     9 |

### Local display and input preference; correctly lens-owned.

| File                                               | Level   | Lines |
| -------------------------------------------------- | ------- | ----: |
| `components/settings/KeybindingsSettings.tsx`      | feature | 1,337 |
| `keybindings.ts`                                   | feature |   529 |
| `components/settings/KeybindingsSettings.logic.ts` | feature |   340 |
| `shortcutModifierState.ts`                         | feature |    96 |
| `components/settings/RedactedSensitiveText.tsx`    | feature |    61 |
| `components/settings/itemRows.ts`                  | feature |     5 |

### Framework-level utility with no Atlas concept.

| File                              | Level    | Lines |
| --------------------------------- | -------- | ----: |
| `uiStateStore.ts`                 | internal |   421 |
| `hooks/useTheme.ts`               | internal |   324 |
| `hooks/useSettings.ts`            | internal |   305 |
| `timestampFormat.ts`              | internal |   225 |
| `hooks/useLocalStorage.ts`        | internal |   182 |
| `hooks/useResizableWidth.ts`      | internal |   168 |
| `editorPreferences.ts`            | internal |   115 |
| `hooks/useCopyToClipboard.ts`     | internal |   109 |
| `hooks/useMediaQuery.ts`          | internal |    87 |
| `hooks/useNowMinute.ts`           | internal |    69 |
| `lib/lruCache.ts`                 | internal |    68 |
| `lib/storage.ts`                  | internal |    67 |
| `types.ts`                        | internal |    57 |
| `hooks/useCommitOnBlur.ts`        | internal |    43 |
| `lib/utils.ts`                    | internal |    43 |
| `clientPersistenceStorage.ts`     | internal |    30 |
| `vite-env.d.ts`                   | internal |    28 |
| `vite-plus-browser-matchers.d.ts` | internal |    11 |
| `env.ts`                          | internal |     8 |

### Presentational; no product concept.

| File                            | Level     | Lines |
| ------------------------------- | --------- | ----: |
| `components/Icons.tsx`          | primitive |   720 |
| `components/JetBrainsIcons.tsx` | primitive |   610 |
| `pierre-icons.ts`               | primitive |   117 |
| `components/AnimatedHeight.tsx` | primitive |    91 |
| `components/SplashScreen.tsx`   | primitive |     9 |

### Panel tabbing is lens-local layout; the content of each tab is classified separately.

| File                                    | Level     | Lines |
| --------------------------------------- | --------- | ----: |
| `rightPanelStore.ts`                    | workspace |   560 |
| `components/RightPanelTabs.tsx`         | workspace |   497 |
| `components/DiffWorkerPoolProvider.tsx` | workspace |    84 |
| `components/RightPanelSheet.tsx`        | workspace |    30 |
| `rightPanelLayout.ts`                   | workspace |     3 |
