# Web component reference

> **CORRECTION (2026-07-26):** This is a behavioral inventory of donor UI, not
> a statement that T3's project, provider, environment, or server model survives.
> Each source file receives its Atlas disposition in the
> [Atlas Console classification](../atlas-console/03-CLASSIFICATION.md).

## Purpose

This is the canonical inventory of the T3 Code web interface. It groups
components by product responsibility rather than mirroring the filesystem
alone. A component belongs here when it renders visible UI, provides layout for
visible UI, or coordinates an interaction that changes what the user sees.

All entries are **source-audited** until runtime validation is recorded.

## Application and route surfaces

| Component or module   | Responsibility                                                        | Source                                                     |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `AppRoot`             | Installs application-wide providers and renders the router.           | `apps/web/src/AppRoot.tsx`                                 |
| Root route            | Owns global loading, error, authentication, and overlay boundaries.   | `apps/web/src/routes/__root.tsx`                           |
| Chat layout route     | Loads the connected workspace shell and common chat-route state.      | `apps/web/src/routes/_chat.tsx`                            |
| Workspace index route | Resolves the initial selection or empty-workspace experience.         | `apps/web/src/routes/_chat.index.tsx`                      |
| Draft route           | Hosts task composition before durable thread creation.                | `apps/web/src/routes/_chat.draft.$draftId.tsx`             |
| Thread route          | Resolves an environment/thread identity into the active task surface. | `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`   |
| Pair route            | Hosts browser pairing and pairing-state feedback.                     | `apps/web/src/routes/pair.tsx`                             |
| Connect routes        | Host environment authorization and its callback.                      | `apps/web/src/routes/connect.tsx`, `connect_.callback.tsx` |
| Settings layout       | Provides settings navigation and a nested panel outlet.               | `apps/web/src/routes/settings.tsx`                         |
| Settings leaf routes  | Map settings URLs to their panel components.                          | `apps/web/src/routes/settings.*.tsx`                       |

## Workspace shell and navigation

| Component                       | Responsibility                                                         | Important states                                    | Source                                  |
| ------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `AppSidebarLayout`              | Composes the responsive sidebar and primary content region.            | Desktop, overlay/mobile, open, closed               | `components/AppSidebarLayout.tsx`       |
| `Sidebar`                       | Established project and thread navigation implementation.              | Loading, empty, grouped, filtered, active, archived | `components/Sidebar.tsx`                |
| `SidebarV2`                     | Experimental next-generation project/thread navigation.                | Enabled through beta settings                       | `components/SidebarV2.tsx`              |
| `SidebarThreadRow`              | One navigable thread summary within the established sidebar.           | Active, running, unread, waiting, complete, failed  | `components/Sidebar.tsx`                |
| `SidebarChromeHeader`           | Sidebar brand, collapse trigger, and stage presentation.               | Branded backdrop variants                           | `components/sidebar/SidebarChrome.tsx`  |
| `SidebarChromeFooter`           | Settings and update entry points at the bottom of navigation.          | Provider update, app update                         | `components/sidebar/SidebarChrome.tsx`  |
| `SidebarStageBackdrop`          | Decorative release-stage treatment behind sidebar chrome.              | Stage-specific variants                             | `components/SidebarStageBackdrop.tsx`   |
| `ConnectionStatusDot`           | Compact environment connectivity indicator.                            | Connected, connecting, disconnected, error          | `components/ConnectionStatusDot.tsx`    |
| `ProjectFavicon`                | Project/repository identity image with fallback.                       | Image, generated fallback                           | `components/ProjectFavicon.tsx`         |
| `ThreadStatusIndicators` family | Shared leading, trailing, worktree, and change-request thread signals. | Running, waiting, failed, worktree, PR states       | `components/ThreadStatusIndicators.tsx` |
| `NoActiveThreadState`           | Empty primary surface when no task is selected.                        | No active thread                                    | `components/NoActiveThreadState.tsx`    |
| `SplashScreen`                  | Application startup presentation.                                      | Booting                                             | `components/SplashScreen.tsx`           |

### Navigation requirements

- Every thread row must expose an accessible name containing its title.
- Status cannot be communicated only by color or animation.
- Collapsing navigation must preserve a discoverable way to reopen it.
- Context menus must be keyboard reachable and return focus to their trigger.
- Sidebar V1 and V2 must use the same user-facing names for equivalent states.

## Workspace toolbar and source-control controls

| Component                          | Responsibility                                                            | Source                                            |
| ---------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `BranchToolbar`                    | Composes environment mode, environment, branch, scripts, and Git actions. | `components/BranchToolbar.tsx`                    |
| `BranchToolbarEnvModeSelector`     | Selects main workspace, new worktree, or previous worktree behavior.      | `components/BranchToolbarEnvModeSelector.tsx`     |
| `BranchToolbarEnvironmentSelector` | Selects the execution environment.                                        | `components/BranchToolbarEnvironmentSelector.tsx` |
| `BranchToolbarBranchSelector`      | Selects or creates Git branch context.                                    | `components/BranchToolbarBranchSelector.tsx`      |
| `ProjectScriptsControl`            | Discovers and runs configured project scripts.                            | `components/ProjectScriptsControl.tsx`            |
| `GitActionsControl`                | Presents repository actions and their progress or confirmation states.    | `components/GitActionsControl.tsx`                |
| `PullRequestThreadDialog`          | Creates or configures a task from pull-request context.                   | `components/PullRequestThreadDialog.tsx`          |

Toolbar controls must distinguish selection from action, disclose destructive
effects before execution, and remain understandable when repository metadata is
loading or unavailable.

## Conversation workspace

| Component              | Responsibility                                                                 | Important states                                  | Source                                     |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| `ChatView`             | Main task coordinator: header, timeline, composer, panels, and thread actions. | Draft, idle, running, waiting, interrupted, error | `components/ChatView.tsx`                  |
| `ChatHeader`           | Thread identity and high-priority workspace controls.                          | Draft/thread, narrow/wide, panel state            | `components/chat/ChatHeader.tsx`           |
| `MessagesTimeline`     | Ordered messages and agent activity with scroll anchoring.                     | Initial load, streaming, history, follow mode     | `components/chat/MessagesTimeline.tsx`     |
| `ChatMarkdown`         | Renders assistant/user markdown, code, links, and inline semantic content.     | Streaming and complete content                    | `components/ChatMarkdown.tsx`              |
| `MessageCopyButton`    | Copies message content and reports completion.                                 | Idle, copied, failure                             | `components/chat/MessageCopyButton.tsx`    |
| `ProposedPlanCard`     | Separates a provider-proposed plan from ordinary prose.                        | Proposed, accepted/follow-up context              | `components/chat/ProposedPlanCard.tsx`     |
| `ChangedFilesCard`     | Summarizes changed files as a timeline card.                                   | Collapsed, expanded                               | `components/chat/ChangedFilesTree.tsx`     |
| `ChangedFilesTree`     | Navigable hierarchical changed-file list.                                      | Added, modified, deleted, renamed                 | `components/chat/ChangedFilesTree.tsx`     |
| `DiffStatLabel`        | Compact added/deleted line counts.                                             | Additions, deletions, zero values                 | `components/chat/DiffStatLabel.tsx`        |
| `ThreadErrorBanner`    | Persistent thread-level failure presentation.                                  | Provider/runtime error                            | `components/chat/ThreadErrorBanner.tsx`    |
| `ProviderStatusBanner` | Warns when the selected provider cannot serve the task normally.               | Missing, unauthenticated, unhealthy, disabled     | `components/chat/ProviderStatusBanner.tsx` |
| `ExpandedImagePreview` | Inline image inspection trigger and presentation.                              | Loading, loaded, error                            | `components/chat/ExpandedImagePreview.tsx` |
| `ExpandedImageDialog`  | Full-size modal image inspection.                                              | Open, closed                                      | `components/chat/ExpandedImageDialog.tsx`  |

### Timeline semantics

The timeline must visually and semantically distinguish:

- User messages
- Assistant messages
- Reasoning or progress where exposed
- Tool and shell activity
- Approval requests
- User-input requests
- Plans
- Changed-file summaries
- Errors and interruptions

Provider response completion must not imply that checkpointing and diff
finalization have also completed.

## Composer and prompt context

| Component                         | Responsibility                                                                    | Source                                                |
| --------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `ChatComposer`                    | Composes prompt editor, context, provider controls, banners, and primary actions. | `components/chat/ChatComposer.tsx`                    |
| `ComposerPromptEditor`            | Rich prompt input with references, paste handling, and editor behavior.           | `components/ComposerPromptEditor.tsx`                 |
| `ComposerPrimaryActions`          | Submit, interrupt, and other dominant turn actions.                               | `components/chat/ComposerPrimaryActions.tsx`          |
| `CompactComposerControlsMenu`     | Moves secondary controls into a compact layout menu.                              | `components/chat/CompactComposerControlsMenu.tsx`     |
| `ComposerBannerStack`             | Orders non-blocking composer notices.                                             | `components/chat/ComposerBannerStack.tsx`             |
| `ComposerCommandMenu`             | Discovers and inserts provider slash commands.                                    | `components/chat/ComposerCommandMenu.tsx`             |
| `ComposerPendingApprovalPanel`    | Presents the active approval request beside the composer.                         | `components/chat/ComposerPendingApprovalPanel.tsx`    |
| `ComposerPendingApprovalActions`  | Renders the available approval decisions.                                         | `components/chat/ComposerPendingApprovalActions.tsx`  |
| `ComposerPendingUserInputPanel`   | Collects answers to a provider question.                                          | `components/chat/ComposerPendingUserInputPanel.tsx`   |
| `ComposerPlanFollowUpBanner`      | Guides the next action after a proposed plan.                                     | `components/chat/ComposerPlanFollowUpBanner.tsx`      |
| `ComposerPendingReviewComments`   | Lists local review comments queued for the next prompt.                           | `components/chat/ComposerPendingReviewComments.tsx`   |
| `ComposerPendingTerminalContexts` | Lists terminal selections attached to the next prompt.                            | `components/chat/ComposerPendingTerminalContexts.tsx` |
| `ComposerPendingElementContexts`  | Lists inspected page elements attached to the next prompt.                        | `components/chat/ComposerPendingElementContexts.tsx`  |
| `ComposerPreviewAnnotationCards`  | Lists visual preview annotations attached to the next prompt.                     | `components/chat/ComposerPreviewAnnotationCards.tsx`  |
| `FileTagChip`                     | Compact attached-file reference.                                                  | `components/chat/FileTagChip.tsx`                     |
| `TerminalContextInlineChip`       | Compact attached-terminal reference.                                              | `components/chat/TerminalContextInlineChip.tsx`       |
| `SkillInlineText`                 | Visually identifies recognized skill references in prompt text.                   | `components/chat/SkillInlineText.tsx`                 |
| `DraftHeroHeadline`               | Gives an unstarted draft a contextual headline.                                   | `components/chat/DraftHeroHeadline.tsx`               |

### Composer requirements

- Draft text must survive non-destructive navigation and control changes.
- Submit and interrupt must never be visually ambiguous.
- Pending approvals and questions take priority over ordinary prompt submission.
- Attached context must be individually removable and understandable without
  relying on an icon alone.
- Compact layouts must retain every consequential control.

## Provider and model selection

| Component              | Responsibility                                           | Source                                     |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `ProviderModelPicker`  | Entry control for provider-instance and model selection. | `components/chat/ProviderModelPicker.tsx`  |
| `ModelPickerContent`   | Search, grouping, and model-selection content.           | `components/chat/ModelPickerContent.tsx`   |
| `ModelPickerSidebar`   | Provider-instance navigation within the picker.          | `components/chat/ModelPickerSidebar.tsx`   |
| `ModelListRow`         | One selectable model with capability metadata.           | `components/chat/ModelListRow.tsx`         |
| `ProviderInstanceIcon` | Provider identity using provider and configured accent.  | `components/chat/ProviderInstanceIcon.tsx` |
| `TraitsPicker`         | Provider-supported reasoning, mode, or trait selection.  | `components/chat/TraitsPicker.tsx`         |
| `ContextWindowMeter`   | Shows reported context use and remaining capacity.       | `components/chat/ContextWindowMeter.tsx`   |

The picker must distinguish provider, configured instance, and model. These are
three different concepts and must not be collapsed into one unlabeled value.

## Right-side workspace and panels

| Component                   | Responsibility                                                              | Source                                          |
| --------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `RightPanelTabs`            | Selects changes, files, preview, terminal, and related right-panel content. | `components/RightPanelTabs.tsx`                 |
| `RightPanelSheet`           | Presents right-panel content as an overlay at constrained widths.           | `components/RightPanelSheet.tsx`                |
| `PanelLayoutControls`       | Changes right-panel visibility and layout.                                  | `components/chat/PanelLayoutControls.tsx`       |
| `RightPanelMaximizeControl` | Toggles focused/maximized panel presentation.                               | `components/chat/PanelLayoutControls.tsx`       |
| `RightPanelResizeHandle`    | Pointer/keyboard affordance for resizing the right panel.                   | `components/preview/RightPanelResizeHandle.tsx` |
| `PlanSidebar`               | Persistent plan navigation and progress surface.                            | `components/PlanSidebar.tsx`                    |

## Diff and review

| Component                | Responsibility                                                        | Source                                        |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `DiffWorkerPoolProvider` | Coordinates background diff parsing/render work and visible failures. | `components/DiffWorkerPoolProvider.tsx`       |
| `DiffPanel`              | Fetches, navigates, and renders thread or turn changes.               | `components/DiffPanel.tsx`                    |
| `DiffPanelShell`         | Shared diff header, loading, and content framing.                     | `components/DiffPanelShell.tsx`               |
| `AnnotatableCodeView`    | Code/diff rendering with selectable local annotations.                | `components/diffs/AnnotatableCodeView.tsx`    |
| `LocalCommentAnnotation` | Renders and edits a local review comment anchored to code.            | `components/files/LocalCommentAnnotation.tsx` |

Diff status must not rely only on red/green. File status, line markers, text
labels, and accessible descriptions must provide redundant meaning.

## Files

| Component          | Responsibility                                         | Source                                  |
| ------------------ | ------------------------------------------------------ | --------------------------------------- |
| `FileBrowserPanel` | Navigable project file tree.                           | `components/files/FileBrowserPanel.tsx` |
| `FilePreviewPanel` | Renders supported file content and file-level actions. | `components/files/FilePreviewPanel.tsx` |
| `PierreEntryIcon`  | File/folder icon chosen from entry type and extension. | `components/chat/PierreEntryIcon.tsx`   |

## Terminal

| Component              | Responsibility                                                     | Source                                |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `ThreadTerminalDrawer` | Manages terminal tabs, drawer state, and thread terminal sessions. | `components/ThreadTerminalDrawer.tsx` |
| `TerminalViewport`     | Mounts and sizes the interactive terminal rendering surface.       | `components/ThreadTerminalDrawer.tsx` |

Terminal documentation must cover keyboard capture, copy/paste, focus escape,
session persistence, exit state, reconnection, and attaching selected output to
the composer.

## Application preview and browser

| Component                      | Responsibility                                                      | Source                                          |
| ------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- |
| `PreviewPanel`                 | Selects and frames the preview mode for a thread.                   | `components/preview/PreviewPanel.tsx`           |
| `PreviewPanelShell`            | Shared preview header and content frame.                            | `components/preview/PreviewPanelShell.tsx`      |
| `PreviewView`                  | Coordinates URL state, browser host, loading, and failure surfaces. | `components/preview/PreviewView.tsx`            |
| `PreviewChromeRow`             | Address/navigation/refresh controls.                                | `components/preview/PreviewChromeRow.tsx`       |
| `PreviewMoreMenu`              | Secondary preview actions and settings.                             | `components/preview/PreviewMoreMenu.tsx`        |
| `PreviewEmptyState`            | Explains how to start or select a preview.                          | `components/preview/PreviewEmptyState.tsx`      |
| `PreviewUnreachable`           | Reports a failed preview URL and offers recovery.                   | `components/preview/PreviewUnreachable.tsx`     |
| `PreviewLocalServerCard`       | Selectable detected development server.                             | `components/preview/PreviewLocalServerCard.tsx` |
| `PreviewAutomationHosts`       | Mounts the automation-visible browser surfaces.                     | `components/preview/PreviewAutomationHosts.tsx` |
| `AgentBrowserCursor`           | Shows an agent-controlled pointer in the preview.                   | `components/preview/AgentBrowserCursor.tsx`     |
| `BrowserMockup`                | Decorative browser illustration for preview guidance.               | `components/preview/BrowserMockup.tsx`          |
| `ZoomIndicator`                | Temporary feedback for preview zoom.                                | `components/preview/ZoomIndicator.tsx`          |
| `BrowserSurfaceSlot`           | Registers a browser surface into the workspace layout.              | `browser/BrowserSurfaceSlot.tsx`                |
| `HostedBrowserWebview`         | Browser-hosted preview implementation.                              | `browser/HostedBrowserWebview.tsx`              |
| `ElectronBrowserHost`          | Compatibility host for the upstream desktop client.                 | `browser/ElectronBrowserHost.tsx`               |
| `BrowserDeviceToolbar`         | Viewport preset and device-emulation controls.                      | `browser/BrowserDeviceToolbar.tsx`              |
| `BrowserViewportResizeHandles` | Direct manipulation of emulated viewport size.                      | `browser/BrowserViewportResizeHandles.tsx`      |

## Authentication, connection, and cloud

| Component                      | Responsibility                                                 | Source                                              |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| `AuthSurfaceShell`             | Shared framing for authentication and pairing pages.           | `components/auth/AuthSurfaceShell.tsx`              |
| `PairingRouteSurface`          | Handles pairing token exchange and outcome states.             | `components/auth/PairingRouteSurface.tsx`           |
| `PairingPendingSurface`        | Shows pairing progress.                                        | `components/auth/PairingRouteSurface.tsx`           |
| `HostedPairingRouteSurface`    | Pairing behavior for hosted deployment context.                | `components/auth/PairingRouteSurface.tsx`           |
| `ManagedRelayAuthProvider`     | Supplies managed relay authentication state.                   | `cloud/managedAuth.tsx`                             |
| `CloudEnvironmentConnectRows`  | Lists remote cloud environments available to connect.          | `components/cloud/CloudEnvironmentConnectList.tsx`  |
| `ConnectCliAuthorizeSurface`   | Authorizes a CLI-originated connection request.                | `components/cloud/ConnectCliAuthSurface.tsx`        |
| `ConnectCliCallbackSurface`    | Shows completion/failure after authorization.                  | `components/cloud/ConnectCliAuthSurface.tsx`        |
| `ConnectOnboardingDialog`      | Guides initial remote connection setup.                        | `components/cloud/ConnectOnboardingDialog.tsx`      |
| `RelayClientInstallDialog`     | Explains and initiates relay client installation.              | `components/cloud/RelayClientInstallDialog.tsx`     |
| `T3ConnectSidebarSignIn`       | Sidebar sign-in entry point for managed connection features.   | `components/clerk/T3ConnectSidebarSignIn.tsx`       |
| `T3ConnectSidebarAvatar`       | Signed-in account entry point.                                 | `components/clerk/T3ConnectSidebarSignIn.tsx`       |
| `MobileClientsUserProfilePage` | Compatibility account page for upstream mobile connections.    | `components/clerk/MobileClientsUserProfilePage.tsx` |
| `SshPasswordPromptDialog`      | Collects an SSH password for a pending environment connection. | `components/desktop/SshPasswordPromptDialog.tsx`    |

Authentication errors must state whether retrying is safe. Pairing tokens must
never be rendered into durable logs, screenshots, or documentation.

## Settings

| Component                        | Responsibility                                                   | Source                                                   |
| -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `SettingsSidebarNav`             | Navigates settings sections.                                     | `components/settings/SettingsSidebarNav.tsx`             |
| `SettingsPageContainer`          | Applies readable width and spacing to a settings panel.          | `components/settings/settingsLayout.tsx`                 |
| `SettingsSection`                | Groups related settings under a heading.                         | `components/settings/settingsLayout.tsx`                 |
| `SettingsRow`                    | Aligns a setting description with its control.                   | `components/settings/settingsLayout.tsx`                 |
| `SettingResetButton`             | Restores one setting to its default.                             | `components/settings/settingsLayout.tsx`                 |
| `GeneralSettingsPanel`           | Appearance, grouping, diff, plan, and general preferences.       | `components/settings/SettingsPanels.tsx`                 |
| `ProviderSettingsPanel`          | Provider-instance overview and management.                       | `components/settings/SettingsPanels.tsx`                 |
| `ArchivedThreadsPanel`           | Lists and restores archived threads.                             | `components/settings/SettingsPanels.tsx`                 |
| `AddProviderInstanceDialog`      | Multi-step provider instance creation workflow.                  | `components/settings/AddProviderInstanceDialog.tsx`      |
| `AddProviderInstanceWizardSteps` | Accessible step indicator for provider setup.                    | `components/settings/AddProviderInstanceWizardSteps.tsx` |
| `ProviderInstanceCard`           | Provider health, configuration, models, and maintenance actions. | `components/settings/ProviderInstanceCard.tsx`           |
| `ProviderSettingsForm`           | Schema-derived provider-specific controls.                       | `components/settings/ProviderSettingsForm.tsx`           |
| `ProviderModelsSection`          | Provider model discovery and visibility.                         | `components/settings/ProviderModelsSection.tsx`          |
| `ProviderAccentColorPicker`      | Selects provider-instance visual identity.                       | `components/settings/ProviderAccentColorPicker.tsx`      |
| `RedactedSensitiveText`          | Displays a secret-bearing value without exposing it.             | `components/settings/RedactedSensitiveText.tsx`          |
| `ConnectionsSettings`            | Manages local and remote environment connections.                | `components/settings/ConnectionsSettings.tsx`            |
| `SourceControlSettingsPanel`     | Configures source-control hosts and credentials.                 | `components/settings/SourceControlSettings.tsx`          |
| `KeybindingsSettingsPanel`       | Searches, edits, and resets keyboard shortcuts.                  | `components/settings/KeybindingsSettings.tsx`            |
| `DiagnosticsSettingsPanel`       | Displays diagnostics, tracing, and support information.          | `components/settings/DiagnosticsSettings.tsx`            |
| `BetaSettingsPanel`              | Controls opt-in experimental behavior.                           | `components/settings/BetaSettingsPanel.tsx`              |

## Command and selection interfaces

| Component               | Responsibility                                           | Source                                 |
| ----------------------- | -------------------------------------------------------- | -------------------------------------- |
| `CommandPalette`        | Global searchable action launcher and keyboard boundary. | `components/CommandPalette.tsx`        |
| `CommandPaletteResults` | Groups and renders palette results and empty states.     | `components/CommandPaletteResults.tsx` |
| `OpenInPicker`          | Selects an external editor or application for a path.    | `components/chat/OpenInPicker.tsx`     |
| `ColorSelector`         | Reusable color selection control.                        | `components/color-selector.tsx`        |

## Updates, progress, and global feedback

| Component                           | Responsibility                                         | Source                                             |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `SidebarUpdatePill`                 | Compact application/server update notice.              | `components/sidebar/SidebarUpdatePill.tsx`         |
| `SidebarProviderUpdatePill`         | Compact provider-runtime update notice.                | `components/sidebar/SidebarProviderUpdatePill.tsx` |
| `ProviderUpdateEnvironmentRows`     | Environment-by-environment provider update status.     | `components/ProviderUpdateEnvironmentRows.tsx`     |
| `ProviderUpdatePrimaryNotification` | Update notification for the primary environment.       | `components/ProviderUpdatePrimaryNotification.tsx` |
| `ProviderUpdateLaunchNotification`  | Reports provider maintenance started at launch.        | `components/ProviderUpdateLaunchNotification.tsx`  |
| `ServerUpdateAction`                | Selects and executes the supported server update path. | `components/ServerUpdateAction.tsx`                |
| `SlowRpcRequestToastCoordinator`    | Presents delayed feedback for unusually slow requests. | `components/SlowRpcRequestToastCoordinator.tsx`    |
| `AnimatedHeight`                    | Smoothly transitions dynamic content height.           | `components/AnimatedHeight.tsx`                    |

## Design-system primitives

These modules are reusable interaction contracts. Product components should use
them instead of creating new local equivalents without a documented reason.

| Family             | Modules                                                                   | Contract                                                               |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Actions            | `button`, `toggle`, `toggle-group`                                        | Invocable or selectable actions with visible focus and disabled state. |
| Text entry         | `input`, `textarea`, `draft-input`, `input-group`, `number-field`         | Labeled editable values with validation and commit behavior.           |
| Choice             | `checkbox`, `radio-group`, `switch`, `select`, `combobox`, `autocomplete` | Single, multiple, or boolean selection with keyboard support.          |
| Menus and commands | `menu`, `command`                                                         | Keyboard-navigable collections of actions or results.                  |
| Overlays           | `dialog`, `alert-dialog`, `sheet`, `popover`, `tooltip`                   | Layered content with explicit focus and dismissal contracts.           |
| Form structure     | `form`, `field`, `fieldset`, `label`, `group`                             | Accessible naming, descriptions, validation, and control grouping.     |
| Content            | `card`, `table`, `badge`, `alert`, `empty`, `separator`, `kbd`            | Structured information and semantic status.                            |
| Viewport           | `scroll-area`, `collapsible`, `sidebar`                                   | Overflow, disclosure, and responsive navigation behavior.              |
| Feedback           | `toast`, `spinner`, `skeleton`                                            | Transient outcomes and loading placeholders.                           |
| Utility            | `qr-code`                                                                 | Encodes pairing or connection information as an SVG QR code.           |

All primitives live in `apps/web/src/components/ui`.

## Icon families

`Icons.tsx` contains product, provider, source-control, and editor marks.
`JetBrainsIcons.tsx` contains JetBrains product marks. Icons are not independent
controls: an interactive icon requires an accessible name supplied by its
button, link, menu item, or tooltip-trigger contract.

## Cross-component state checklist

Every interactive component must explicitly decide whether it supports:

- Initial loading
- Background refresh
- Empty data
- Partial data
- Offline or disconnected environment
- Provider unavailable or unauthenticated
- Disabled action
- In-progress action
- Successful completion
- Recoverable error
- Terminal error
- Narrow layout
- Reduced motion
- Keyboard-only use
- Screen-reader naming and status announcements

An unsupported state should be documented as such rather than left implicit.

## Inventory maintenance

When adding a user-facing `.tsx` module under `apps/web/src`:

1. Add it to the appropriate family in this document.
2. Define its purpose and visible states.
3. Link or add focused interaction tests when behavior is consequential.
4. Runtime-validate new user-visible behavior using the repository's
   `test-t3-app` workflow.
