<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch, type Ref } from 'vue'
import ViewPanel, { type LayoutMode } from './components/ViewPanel.vue'
import TerminalPane from './components/TerminalPane.vue'
import RestoredPanePlaceholder from './components/RestoredPanePlaceholder.vue'
import { buildWorkspaceGroups, workspaceParentPath } from './lib/workspaceGroups'
import { buildPaneLineage } from './lib/paneLineage'
import { panesOfActiveTab, panesOfViewedWorkspace } from './lib/paneVisibility'
import { buildStageTabs } from './lib/stageTabs'
import { flattenSidebarOrder, resolveFocusedPane } from './lib/paneFocus'
import { formatBytes } from './lib/formatBytes'
import { formatCpuPercent, machineCpuShare, machineMemoryShare } from './lib/resourceSampling'
import { useResourceUsage, type ResourceUsageWire } from './composables/useResourceUsage'
import ResourceSummaryPanel, { type ResourceSummaryRow } from './components/ResourceSummaryPanel.vue'
import ResourceManagerModal from './components/ResourceManagerModal.vue'
import AgentHistoryModal from './components/AgentHistoryModal.vue'
import ReconnectSessionModal, { type OrphanSession } from './components/ReconnectSessionModal.vue'
import ControlPane, {
  type AgentSpec,
  type ActivePaneView,
  type PaneLineageRow,
  type InjectionStatus,
  type KickoffStatus,
  type PreparationStatus,
  type SpawnPayload,
  type ResumePayload,
  type PipelineState,
  type PipelineStatusView,
  type ExistingProjectInfo,
  type AnalyzerStatusView,
  type WorkspaceMode
} from './components/ControlPane.vue'
import PluginRegionHost, { type PluginRegionContribution } from './components/PluginRegionHost.vue'
import QuestionAlert from './components/QuestionAlert.vue'
import TokenStatsPanel from './components/TokenStatsPanel.vue'
import { asAgentPush, normalizePreviewTarget } from './preview/previewTarget'
import { usePreview } from './preview/usePreview'
import { usePreviewLog } from './preview/usePreviewLog'
import NotificationHost from './components/NotificationHost.vue'
import Welcome from './components/Welcome.vue'
import { agentUsesBracketedPaste } from '@navide/plugin-shell'
import { useNotify, useTheme } from '@navide/plugin-ui/foundation'
import { collapseHomePath, migrateTerminalPtyKey, saveAllScrollSnapshots, type DisplayStatus } from '@navide/terminal'
import { useAgentMessaging, encodeReason, isBroadcastTarget, NOTICE_SENDER } from './composables/useAgentMessaging'
import type { PushOutcome, RouteResult } from './composables/useAgentMessaging'
import { createMessageLogPersistence } from './composables/useMessageLogPersistence'
import type { ParsedAgentMessage } from './lib/agentMessaging'
import { VENDORS_WITHOUT_TURN_END, hasUnparsedMessageAttempt, isInjectedMessageText, isTurnInFlight, normalizeMessagingName, parseMessages, parseSpawns, pushCooldownMs, renderFallbackReport, renderFormatNotice, renderSpawnKickoff, renderSpawnNotice } from './lib/agentMessaging'
import {
  evaluateTurnSpawns,
  evaluateSpawnRequest,
  computeSpawnDepth,
  spawnAdvisoriesFor,
} from './lib/agentSpawnGate'
import StageTabBar, { type TabItem } from './components/StageTabBar.vue'
import { rollupTabStatus, sameRenderedTabs } from './lib/tabStatus'
import { paneStatusLabelKey } from './lib/paneStatusLabel'
import { useBackend } from './composables/useBackend'
import { createHostGitSettingsPort, createHostKeybindingsPort, createHostTerminalDockPort } from './composables/hostSurfacePorts'
import { useSettings } from './composables/useSettings'
import { useRoles } from './composables/useRoles'
import {
  cliAccountSwitchKey,
  createCliAccountSwitchHandler,
  forcedRestartAgentKey,
  paneNeedsAccountRestart,
  runAccountRestartBatch,
  useCliProfiles
} from './composables/useCliProfiles'
import { useStages } from './composables/useStages'
import { usePipelines } from './composables/usePipelines'
import { useRecentWorkspaces } from './composables/useRecentWorkspaces'
import { useAnalyzer, type ClassifyResult } from './composables/useAnalyzer'
import { useSystemNotify } from './composables/useSystemNotify'
import { useUpdater } from './composables/useUpdater'
import { usePaneReorderDrag } from './composables/usePaneReorderDrag'
import { cliHealthGuideForLaunch, type CliHealthStatus, type OnboardStatus } from './composables/useOnboarding'
import { playDoneSound, playAttentionSound } from './composables/useSoundNotify'
import { formatIssueForDispatch, buildIssueKickoff, type IssueDetail, type Issue, type IssueProvider, type IssueHandlerMode } from './composables/useIssues'
import { normalizeGitContributionAction, type GitContributionAction } from './ports/gitContribution'
import type { RoleKey } from './data/roles'
import {
  renderSlotKickoff,
  MANAGER_READY_SENTINEL,
  MANAGER_STAGE_DONE_SENTINEL,
  ASK_START,
  ASK_END,
  REPORT_START,
  REPORT_END,
  DISPATCH_START,
  DISPATCH_END,
  type AgentKey,
  type StageId,
  type StageSlot
} from './data/stages'
import { i18n } from '@navide/plugin-ui/foundation'
import { deriveAutoName } from './lib/autoName'
import { bootWorkspaceToRecord } from './lib/bootWorkspace'
import { diagLog } from '@navide/terminal'
import { reclaimBlockedBy, idleReclaimThresholdMs, RECLAIM_NOW_THRESHOLD_MS, type ReclaimCandidate } from './lib/idleReclaim'
import { findConsecutiveQuestionBlocks, findSentinel } from '@navide/terminal'
import {
  buildCliPaneBufferReply,
  buildExternalPaneContextPaste,
  buildMentionInsert,
  rankMentionCandidates,
  recordMentionRecents,
  MENTION_BROADCAST_ADDRESS,
  type MentionCandidate,
  buildPaneContextPaste,
  shouldMentionOnDrop,
  buildPaneStatusReply,
  injectionChunks,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  screenToClientPoint,
  CLI_CHIP_LINE_CAP,
  CLI_PASTE_LINE_CAP
} from '@navide/terminal'
import { planDropPrompt, type PlanDragRef } from './lib/planDrag'
import { activityMeansWorking, allSlotsFinished, applyLoopWait, applyTurnProgress, detailMeansToolUse, loopWaitBackoffMs, loopWaitHonoured, isReplayedTurnComplete, loopBackoffMs, loopContinueReady, loopStallVerdict, loopWaitingOnSubagents, LOOP_STALL_LIMIT, turnCompleteDone, turnEndsWithSentinel, type SlotSignal, type LoopWaitState } from './lib/completion'
import { reorderByIds, reorderStrings, sortByIdOrder } from './lib/paneOrder'
import { computeRangeSelection } from './lib/paneSelection'
import { resolveDragBatch, reorderBatchByIds } from './lib/paneBatchDrag'
import { AGENT_SPECS, type PaneArgContext } from '@navide/plugin-shell'
import {
  orderedAgentKeys,
  isAgentEnabled,
  useCliAgentPrefs,
  loadCliAgentPrefsFromProject
} from './composables/useCliAgentPrefs'
import { pickReusablePane, runReportedDispatch, validatePlanDispatch, type PlanDispatchOutcome, type PlanDispatchPayload } from './lib/planDispatch'
import { planExecutionPrompt } from './lib/planExecutePrompt'
import {
  echoLanded, echoTimeoutFor, normalizeForMatch, submitLanded,
  SUBMIT_CONFIRM_MS, SUBMIT_SCREEN_LINES, TAIL_MATCH_LEN
} from './lib/injectEcho'
import { recordDiagnostic, readDiagnostics, currentDiagnosticSeq } from './lib/uiDiagnostics'
import { injectStandaloneTask, type StandaloneTaskInjectionDeps } from './lib/standalonePaneTask'
import { quickClassify } from './lib/quick-classify'
import type { DirLister } from '@navide/plugin-shell'
import {
  buildResumeCommand,
  acquirePaneRebuildLock,
  cancelStalePendingCreate,
  dedupeRestorablePanes,
  normalizeResumeSessionId,
  sessionHomeIdFor,
  paneBusyForRebuild,
  paneCanRebuild,
  paneRebuildVisible,
  RESTORE_PIN_AGENTS,
  shouldPreserveMissingSessionOnRestore,
  shouldWarnMissingResume,
} from '@navide/plugin-shell'
import {
  claimFreshSessionId,
  classifyAttributedSession,
  classifySessionExistsResponse,
  confirmGhostAdoption,
  createGhostHealGate,
  createUiStateSeqGuard,
  mapOrphanSession,
  pinFreshSessionAtLaunch,
  pinsSessionAtLaunch,
  supportsGhostReconnect,
  reconnectCandidateSessionIds,
  resolveDeterministicReconnect,
  sendWithUiStateRetry,
  shouldAttemptResume,
  type RawOrphanSession,
} from './lib/sessionHeal'
import {
  gridPageCount,
  gridPageOf,
  gridPageSlice,
  gridPresetDims,
  parseGridPreset,
  type GridPreset,
} from './lib/gridLayout'
import { planPaneCycle, type CycleDirection } from './lib/paneCycle'
import {
  parseLegacyRunGroups,
  resolveActiveTab,
  resolveManualSpawnGroupId,
  runGroupCreatedAt,
  groupPeers,
} from './lib/runGroups'
import {
  ALL_SCOPE_RESTORE_CONCURRENCY,
  AUTO_RESUME_ON_RECONNECT_SETTING_KEY,
  RESUME_BEHAVIOR_SETTING_KEY,
  RESTORE_SCOPE_SETTING_KEY,
  createWorkspaceRestoreSession,
  normalizeAutoResumeOnReconnect,
  pendingRestorePaneIds,
  resolveWorkspaceRestoreSession,
  restoreScopeTargetIds,
  runWithConcurrency,
  stripPinnedSessionId,
  stripDeadOpencodeAutoFlag,
  type RestoreScope,
  type RestoreSessionDecision,
  type RestoreSessionTrigger,
  type WorkspaceRestoreSession,
} from './lib/resumeBehavior'
import { initSettingsBackend, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { cliPermissionKey, parseCliPermissionMode, skipPermissionFlagFor } from '@navide/plugin-shell'
import { useLayoutStore } from './layout/useLayoutStore'
import { RAIL_SIZE } from './layout/slots'
import SlotContainer from './layout/SlotContainer.vue'
// Bodies for the horizontal slots. Async because a slot that holds none of them
// — the shipped default — should not pay for their code.
//
// Only three, because only three views may live here: the rest are pinned to
// the host that knows how to reveal them (see viewRegistry). A slot that
// cannot be asked to draw a view needs no import for it.
const SlotHistory = defineAsyncComponent(() => import('./components/HistoryPanel.vue'))
const SlotTasker = defineAsyncComponent(() => import('./components/TaskerPanel.vue'))
const SlotMessages = defineAsyncComponent(() => import('./components/AgentMessagesPanel.vue'))
import { pickWhatsNew, type WhatsNewEntry } from './lib/whatsNew'
import { initUsage } from './composables/useUsage'
import {
  LOOP_PROMPT_SETTING_KEY,
  DEFAULT_LOOP_PROMPT,
  LOOP_RESUME_SETTING_KEY,
  DEFAULT_LOOP_RESUME,
  LOOP_ESTIMATE_WINDOW_MS,
  LOOP_DONE_MARKER,
  LOOP_WAIT_MARKER,
  withLoopDoneInstruction,
  parseLimitReset,
  matchSessionLimit,
  unseenTail,
  formatLoopTime,
} from './lib/loopPrompt'
import { resolvePromptSkill } from './lib/promptSkills'
import { usePromptSkills } from './composables/usePromptSkills'
import { loginCommandFor, matchLoginExpired } from './lib/cliLoginExpired'
import {
  awaitingClearsOnMiss,
  hasAwaitingPattern,
  matchAwaitingInput,
  notificationEndsAwaiting,
  notificationMeansAwaiting,
  questionActionFor,
} from './lib/cliAwaitingInput'
import { markerTurnActionFor } from './lib/sessionMarkerTurn'
import { entryBelongsToWorkspace, filterWorkspaceEntries, historyEntryLabel, legacyHistoryLogPath, manualLogFileName, updateHistoryCustomName, type HistoryCleanupMode, type HistoryDeletePreview, type HistoryDeleteTarget, type SpawnHistoryEntry, type WorkspaceIdentity } from './lib/spawnHistory'
import { executeCommand, initKeybindingsPort, useKeybindings, registerCommand, setContext } from '@navide/plugin-ui/shared'
import { useUiActionBus } from './composables/useUiActionBus'
import { releaseAnnouncementId, useAnnouncements } from './composables/useAnnouncements'
import { useStatusBarPopover } from './composables/useStatusBarPopover'
import navideMark from './assets/navide-mark.png'

// Modals/wizard that only render behind a v-if (settings opened, run completed,
// first-run onboarding) — defer them off the main shell's first-paint bundle.
const CompletionModal = defineAsyncComponent(() => import('./components/CompletionModal.vue'))
const SettingsModal = defineAsyncComponent(() => import('./components/SettingsModal.vue'))
const AccountModal = defineAsyncComponent(() => import('./components/AccountModal.vue'))
const OnboardingWizard = defineAsyncComponent(() => import('./components/OnboardingWizard.vue'))
const WhatsNewModal = defineAsyncComponent(() => import('./components/WhatsNewModal.vue'))
const CliHealthGuide = defineAsyncComponent(() => import('./components/CliHealthGuide.vue'))
const CliInstallDialog = defineAsyncComponent(() => import('./components/CliInstallDialog.vue'))
const DebugModal = defineAsyncComponent(() => import('./components/DebugModal.vue'))
const RestoreScopeModal = defineAsyncComponent(() => import('./components/RestoreScopeModal.vue'))
const PipelineManagerModal = defineAsyncComponent(() => import('./components/PipelineManagerModal.vue'))
const AnnouncementsPanel = defineAsyncComponent(() => import('./components/AnnouncementsPanel.vue'))
const ClockPanel = defineAsyncComponent(() => import('./components/ClockPanel.vue'))

const backend = useBackend()
const terminalPort = createHostTerminalDockPort(backend)
// Hook the settings cache to the ws: reconciles + flushes queued writes once
// connected, and applies ui.settings_changed broadcasts from other windows.
initSettingsBackend(createHostGitSettingsPort(backend))
initKeybindingsPort(createHostKeybindingsPort())
// Per-CLI quota badges: configure the backend poller and mirror its
// usage.changed broadcasts (read by TerminalPane's UsageBadge).
initUsage(backend)
const rolesApi = useRoles(backend)
const cliProfilesApi = useCliProfiles(backend)
const pipelinesApi = usePipelines(backend)
const stagesApi = useStages(backend, () => pipelinesApi.activePipelineId.value)
const analyzerApi = useAnalyzer(backend)
const { recent: recentWorkspaces, touch: touchRecentWorkspace } = useRecentWorkspaces(backend)
const themeApi = useTheme()
const settingsApi = useSettings()

// Apply the theme and language as early as possible (settings store → default).
// The backend backup is adopted later inside onWorkspaceCheck.
onMounted(() => {
  themeApi.loadTheme()
  settingsApi.loadLanguage()
  void settingsApi.loadHealthCheckTimeoutSec()
  window.agentTeam?.onLanguageChanged?.((locale) => {
    settingsApi.setLanguage(locale)
    pushQuitConfirmConfig()
  })
  // Native application menu actions (Settings…, Check for Updates…, Open
  // Workspace…) routed here from main.
  window.agentTeam?.onMenuAction?.((action) => { void onMenuAction(action) })
  // Seed main with the current confirm-before-quit config, and react to the
  // user disabling it from the native quit dialog's "don't show again".
  pushQuitConfirmConfig()
  window.agentTeam?.onQuitConfirmDisabled?.(() => { confirmBeforeClose.value = false })
  // Clicking a system notification focuses the originating pane.
  window.agentTeam?.onFocusPane?.((paneId) => {
    void focusPaneFromNotification(paneId)
  })
  // Native application menu entry (menu:open-resource-manager).
  window.agentTeam?.onOpenResourceManager?.(() => openResourceManager())
  // Plan window "execute" dispatch routed to this workspace's window.
  window.agentTeam?.onPlanExecutionDispatch?.((payload) => { void onPlanExecutionDispatch(payload) })
  // Resource Manager row actions (jump / reclaim). That window is machine-wide
  // and main asks every window, so a pane this one does not own is disowned
  // with not-found rather than answered.
  window.agentTeam?.onPaneActionRequest?.(async (paneId, action) => {
    if (!panes.value.some((p) => p.id === paneId)) return { error: 'not-found' }
    if (action === 'focus') {
      onResourceJump(paneId)
      // `focused` asks main to bring this window forward — a renderer cannot.
      return { ok: true, focused: true }
    }
    // Reclaim runs the same guards the status-bar reclaim does, so a pane that
    // is busy, focused or holding a draft refuses instead of dying.
    const reclaimed = await reclaimPanesNow([paneId])
    return reclaimed > 0 ? { ok: true } : { error: 'blocked' }
  })
  // Editor-window AI Chat fetches a CLI pane's scrollback through the main
  // process (cli:get-pane-buffer); answer from this window's paneRefs.
  window.agentTeam?.onCliPaneBufferRequest?.((paneId) => {
    const ref = paneRefs[paneId]
    return buildCliPaneBufferReply(
      panes.value.find((p) => p.id === paneId),
      ref
        ? {
            buffer: readPaneShareText(ref, CLI_CHIP_LINE_CAP)
          }
        : null
    )
  })
  // Cross-window pane drop fallback: a drag from another window that lands on
  // an accepting drop target arrives as a normal drop event (Chromium delivers
  // same-app cross-window drops) and is handled by that target directly. This
  // IPC covers the remaining case — a release main's hit-test routed here —
  // and injects only when the point lands on a terminal area.
  window.agentTeam?.onExternalPaneDrop?.(({ paneId, paneIds, screenX, screenY }) => {
    if (!paneId) return
    const { x, y } = screenToClientPoint(
      { screenX, screenY },
      { screenX: window.screenX, screenY: window.screenY }
    )
    const host = document.elementFromPoint(x, y)?.closest('[data-pane-id]')
    const targetPaneId = host instanceof HTMLElement ? host.dataset.paneId : undefined
    if (!targetPaneId || targetPaneId === paneId) return
    // Same entry point as a drop the target consumed itself, so the mention
    // gesture behaves identically whether the release landed on the terminal
    // area or was routed here by main's hit-test — and a multi-select drag
    // shares every pane it carried, exactly like a locally consumed drop.
    void injectPaneContextSources(paneIds?.length ? paneIds : [paneId], targetPaneId)
  })
  window.addEventListener('resize', onWindowResize)
  // Warm the heaviest deferred panel (Settings) during idle: it stays lazy to
  // keep off first paint, but it's commonly opened, so pre-fetching once the
  // shell is interactive makes its first open instant at no visible cost.
  const warmSettings = (): void => { void import('./components/SettingsModal.vue') }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warmSettings, { timeout: 4000 })
  } else {
    window.setTimeout(warmSettings, 2500)
  }
})

// ── First-run onboarding gate ────────────────────────────────────────────────
// `null` = not yet checked. When the backend connects we ask whether the
// environment setup is complete; if not, OnboardingWizard hard-blocks the shell.
const onboardingComplete = ref<boolean | null>(null)
const cliHealthGuide = ref<CliHealthStatus | null>(null)
// "What's New" announcement to show once after updating to a version that has
// an entry (see lib/whatsNew.ts). Null = nothing to show.
const whatsNewEntry = ref<WhatsNewEntry | null>(null)
// Probing 18 deps fans out over 8 workers with an 8s ceiling each, and the
// backend serialises these on one executor — on a cold or loaded machine the
// default 10s deadline expires, and the fail-open below then hides the wizard
// from exactly the first-run user who needs it.
const ONBOARDING_STATUS_TIMEOUT_MS = 45_000

async function checkOnboarding(): Promise<void> {
  try {
    const resp = await backend.send<OnboardStatus>(
      'onboarding.status',
      {},
      ONBOARDING_STATUS_TIMEOUT_MS
    )
    onboardingComplete.value = resp.payload?.complete ?? true
    cliInstallPromptDismissed.value = new Set(resp.payload?.install_prompt_dismissed ?? [])
    const health = resp.payload?.cli_health
    // One-time migration for selections made by renderer versions that stored
    // only UI settings. Persist the same path + fingerprint in the backend so
    // startup probing and reminder suppression survive every kind of restart.
    // Only findings the repair guide can act on: a failed vendor update raises
    // needs_attention too, but it is handled in CLI management and must not be
    // silently dismissed here.
    const repairable = health?.findings.some((finding) => finding.type !== 'update_failed') ?? false
    if (repairable && health?.needs_attention && health.fingerprint) {
      for (const entry of health.entries) {
        const selectedPath = settingsGet(`agentTeam.cliBinary.${entry.agent_key}`, '').trim()
        if (!selectedPath || !entry.candidates.some((candidate) => candidate.path === selectedPath)) continue
        const persisted = await backend.send<{ ok: boolean }>('onboarding.cli_health.select_binary', {
          agent_key: entry.agent_key,
          path: selectedPath,
          fingerprint: health.fingerprint,
        }).catch(() => null)
        if (persisted?.ok && persisted.payload?.ok !== false) {
          health.dismissed = true
          health.needs_attention = false
          break
        }
      }
    }
    cliHealthGuide.value = cliHealthGuideForLaunch(resp.payload)
  } catch {
    // If the check fails, don't lock the user out — fail open.
    onboardingComplete.value = true
  }
}

// Show the "What's New" announcement once, the first time onboarding resolves.
// Gate on onboarding so it never overlaps the first-run wizard, and so a fresh
// install (wizard shown) is only baselined — never told about changes, like the
// rename, that it never lived through. Existing users (wizard already done) see
// the current version's announcement once.
let whatsNewChecked = false
function evaluateWhatsNew(complete: boolean): void {
  const current = window.agentTeam?.version ?? ''
  if (!current) return
  const seen = settingsGet('agentTeam.whatsNew.lastSeenVersion', '')
  if (!complete) {
    if (seen !== current) settingsSet('agentTeam.whatsNew.lastSeenVersion', current)
    return
  }
  const entry = pickWhatsNew(current, seen)
  if (entry) whatsNewEntry.value = entry
  else if (seen !== current) settingsSet('agentTeam.whatsNew.lastSeenVersion', current)
}
function dismissWhatsNew(): void {
  const current = window.agentTeam?.version ?? ''
  // The modal shows the newest AUTHORED entry at or below the running version,
  // which is often not `current` itself (v0.1.63 running, note written for
  // v0.1.62). Mark the entry the user actually read — capture it before the
  // `= null` below, or the announcements badge keeps that note unread forever.
  const shownVersion = whatsNewEntry.value?.version ?? ''
  if (current) settingsSet('agentTeam.whatsNew.lastSeenVersion', current)
  // The same release is also an item in the announcements feed — reading it
  // in the modal counts, so the user isn't told about it twice.
  if (shownVersion) announcements.markRead(releaseAnnouncementId(shownVersion))
  whatsNewEntry.value = null
}
// Announcements centre: the status-bar feed of release notes + updater news.
const announcements = useAnnouncements()
// Status-bar popovers (backend / announcements / clock) share one open id, so
// opening any of them closes whichever was showing.
const { openPopover, toggle: togglePopover, close: closePopover } = useStatusBarPopover()
watch(
  onboardingComplete,
  (value) => {
    if (whatsNewChecked || value === null) return
    whatsNewChecked = true
    evaluateWhatsNew(value)
  },
  { immediate: true },
)
// First-boot loading overlay: shown until the backend first settles, then
// dismissed for good (later reconnects use the status-bar indicator, not this).
const booting = ref(true)
const bootError = ref(false)
// Reflect the real boot phase in the splash status instead of a flat "loading".
const bootStatusKey = computed(() => {
  switch (backend.status.value) {
    case 'starting': return 'label.boot-starting'
    case 'connecting':
    case 'disconnected': return 'label.boot-connecting'
    default: return 'label.loading'
  }
})
const dismissBoot = (): void => { booting.value = false }
let _bootTimer: number | undefined
function armBootTimeout(): void {
  if (_bootTimer) clearTimeout(_bootTimer)
  // Safety net: dismiss a stuck spinner so the user is never trapped — but never
  // override an error state, which stays put with a Retry button. Kept just past
  // useBackend's 50s init deadline: on a slow cold start (e.g. macOS Gatekeeper
  // scanning an unsigned packaged binary on first launch) the backend may take
  // up to 50s to report ready (then connect) or to give up and set status='error'.
  // Firing earlier would tear the overlay down mid-startup, revealing a bare
  // unconnected shell and pre-empting the error+Retry the backend failure path
  // is meant to show.
  _bootTimer = window.setTimeout(() => { if (!bootError.value) dismissBoot() }, 52_000)
}
armBootTimeout()
function retryBackend(): void {
  bootError.value = false
  booting.value = true
  armBootTimeout()
  void backend.restart()
}
// Countdown display for the boot overlay, driven by the configured health-check
// timeout (Settings → Appearance). Purely cosmetic — it doesn't change when the
// overlay actually gets dismissed (see armBootTimeout's own 52s safety net above).
const bootCountdown = ref<number>(settingsApi.healthCheckTimeoutSec.value)
let _bootCountdownTimer: number | undefined
function startBootCountdown(): void {
  if (_bootCountdownTimer) clearInterval(_bootCountdownTimer)
  bootCountdown.value = settingsApi.healthCheckTimeoutSec.value
  _bootCountdownTimer = window.setInterval(() => {
    if (bootCountdown.value > 0) bootCountdown.value -= 1
  }, 1000)
}
watch(booting, (b) => {
  if (b) startBootCountdown()
  else if (_bootCountdownTimer) { clearInterval(_bootCountdownTimer); _bootCountdownTimer = undefined }
}, { immediate: true })
watch(
  () => backend.status.value,
  (s) => {
    if (s === 'connected' && onboardingComplete.value === null) void checkOnboarding()
    if (s === 'connected') { booting.value = false; bootError.value = false; void refreshOrphanCount() }
    // On a hard failure, keep the overlay and show an error + Retry (the app is
    // non-functional without a backend anyway). 'disconnected' is transient
    // during reconnect backoff, so it's left alone.
    else if (s === 'error') bootError.value = true
  },
  { immediate: true },
)
function reopenOnboarding(): void {
  onboardingComplete.value = false
}
function completeOnboarding(): void {
  onboardingComplete.value = true
  void checkOnboarding()
}

// --- Workspace-first entry gate (phase-4) ------------------------------------
// The Welcome screen is shown until a workspace is chosen. Selection is kept in
// sessionStorage so a reload (Vite HMR / refresh) stays in the workspace, but a
// full app restart returns to Welcome.
const WS_SELECTED_KEY = 'agentTeam.workspaceSelected'
const WS_PATH_KEY = 'agentTeam.currentWorkspace'
// A window opened with a workspace URL param boots straight into it (the param
// seeds per-window sessionStorage, which would otherwise send it to Welcome).
// Pane restore is suppressed only for duplicate=1 windows — ones cloned from a
// live window whose CLI sessions are still running (restoring would
// double-resume them). All other param-carrying boots (Finder "Open With",
// Quick Action, CLI path args, crash-restore) come from dead sessions and MUST
// restore — see onWorkspaceCheck.
const _bootWorkspace = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
const _bootIsDuplicate = new URLSearchParams(window.location.search).get('duplicate') === '1'
const legacyGitRecovery = ref(new URLSearchParams(window.location.search).get('legacy_git_recovery') === '1')
// Set by main when this window is reopened from the saved session snapshot
// (index.ts passes restore: '1'). Distinguishes "the app restored this
// workspace for you" from "the user deliberately opened it" — an empty
// workspace is a normal thing to open on purpose, but being restored INTO an
// empty one leaves nothing to act on, so that case returns to the picker.
const _bootIsRestore = new URLSearchParams(window.location.search).get('restore') === '1'
// The check runs once, on the restore that opened this window. Later emptiness
// is the user's own doing (they closed the last pane) and must not eject them.
let restoreEmptyCheckPending = _bootIsRestore
let suppressPaneRestoreOnce = _bootWorkspace !== '' && _bootIsDuplicate
// Detached child window: shows only one run group of its workspace. When set,
// this window renders just that group's tab/panes and never persists the shared
// runGroups/activeTab/layout state to project.json (the main window owns those).
const detachedGroupId = new URLSearchParams(window.location.search).get('detached_group') ?? ''
const isDetachedWindow = detachedGroupId !== ''
// Groups that THIS (main) window has handed off to a detached child window —
// filtered out of the tab bar and pane view until the child closes.
const detachedGroupIds = ref<Set<string>>(new Set())
/** Resolves once main has told this window which groups are currently
 *  detached. An ordinary restore awaits it, so the filter that skips those
 *  groups is never consulted before the answer has arrived — otherwise the
 *  race decides whether the main window resurrects panes the child owns. */
let detachedGroupsKnown: Promise<void> = Promise.resolve()
if (_bootWorkspace) {
  try {
    sessionStorage.setItem(WS_PATH_KEY, _bootWorkspace)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}
const currentWorkspace = ref<string>(
  _bootWorkspace ||
  (() => {
    try {
      return sessionStorage.getItem(WS_PATH_KEY) ?? ''
    } catch {
      return ''
    }
  })()
)
const pluginContributions = ref<PluginRegionContribution[]>([])
const gitChangesCount = ref(0)

type PluginRegionLocation = PluginRegionContribution['location']

const pluginContributionsByLocation = computed(() => {
  const grouped: Record<PluginRegionLocation, PluginRegionContribution[]> = {
    top: [],
    bottom: [],
    right: [],
    left: [],
    main: [],
    window: [],
  }
  for (const contribution of pluginContributions.value) {
    grouped[contribution.location].push(contribution)
  }
  return grouped
})

function pluginContributionsAt(location: Exclude<PluginRegionLocation, 'left' | 'window'>): PluginRegionContribution[] {
  return pluginContributionsByLocation.value[location]
}

const windowPluginContributions = computed(() => pluginContributionsByLocation.value.window)

// The titlebar shows these as icons, matching the gear beside them. A plugin
// whose icon file is missing or unreadable falls back to a glyph rather than
// to its title: a word-shaped button next to icon-shaped ones reads as a
// different kind of control, which is what made the Git one look bolted on.
const failedPluginIcons = ref<Set<string>>(new Set())
const pluginIconFailureKey = (entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): string =>
  `${entry.contributionKey} ${entry.icon ?? ''}`
const hasPluginIcon = (entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): boolean =>
  Boolean(entry.icon) && !failedPluginIcons.value.has(pluginIconFailureKey(entry))
function markPluginIconFailed(entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): void {
  const failures = new Set(failedPluginIcons.value)
  failures.add(pluginIconFailureKey(entry))
  failedPluginIcons.value = failures
}

async function openPluginContributionWindow(contribution: PluginRegionContribution): Promise<void> {
  const workspacePath = currentWorkspace.value.trim()
  if (!workspacePath) return
  const result = await window.agentTeam?.plugins?.openContributionWindow?.({
    contributionKey: contribution.contributionKey,
    workspace_path: workspacePath,
  })
  if (!result?.ok) {
    console.warn(`[renderer] plugin window '${contribution.contributionKey}' could not be opened: ${result?.error ?? 'unknown error'}`)
  }
}

async function refreshPluginContributions(): Promise<void> {
  try {
    const list = await window.agentTeam?.plugins?.listContributions?.()
    pluginContributions.value = Array.isArray(list) ? list : []
  } catch {
    pluginContributions.value = []
  }
}
const workspaceSelected = ref<boolean>(
  _bootWorkspace !== '' ||
  (() => {
    try {
      return sessionStorage.getItem(WS_SELECTED_KEY) === '1'
    } catch {
      return false
    }
  })()
)

// Crash-restore: keep main's open-windows registry in sync with this window's
// workspace (Welcome picks/switches happen without a reload, so main can't see
// them), and ask once whether the previous run exited uncleanly — only the
// first window to ask gets the list and shows the restore prompt.
watch(currentWorkspace, (v, previous) => {
  window.agentTeam?.reportWorkspace?.(v)
  if (previous !== undefined && previous !== v) gitChangesCount.value = 0
}, { immediate: true })

// Record an externally opened folder in Recent once the backend accepts
// requests — see bootWorkspaceToRecord for which boots qualify.
const _bootRecordWorkspace = bootWorkspaceToRecord(window.location.search)
if (_bootRecordWorkspace) {
  let bootTouched = false
  const touchBootWorkspace = (): void => {
    if (bootTouched || backend.status.value !== 'connected') return
    bootTouched = true
    void touchRecentWorkspace(_bootRecordWorkspace)
  }
  touchBootWorkspace()
  watch(() => backend.status.value, touchBootWorkspace)
}

// Feed the native File > Open Recent submenu: push a slim list to main whenever
// the recent-workspaces cache changes.
watch(recentWorkspaces, (list) => {
  window.agentTeam?.setRecentWorkspaces?.(
    (list ?? []).map((r) => ({ path: r.path, name: r.name, exists: r.exists }))
  )
}, { immediate: true })
const notifyRestore = useNotify()
void window.agentTeam?.restore?.getPending().then((list) => {
  if (!list?.length) return
  const show = async (): Promise<void> => {
    const ok = await notifyRestore.confirm(
      `${i18n.global.t('restore.dialog-message', { count: list.length })}\n\n${list.join('\n')}`,
      {
        title: i18n.global.t('restore.dialog-title'),
        confirmText: i18n.global.t('restore.apply'),
        cancelText: i18n.global.t('restore.dismiss'),
      }
    )
    if (ok) void window.agentTeam?.restore?.apply()
    else void window.agentTeam?.restore?.dismiss()
  }
  // The boot overlay (z-9000) covers the confirm dialog (z-2100) — wait it out.
  if (!booting.value) { void show(); return }
  const stop = watch(booting, (b) => { if (!b) { stop(); void show() } })
})

// Workspaces the restore failure breaker left closed this launch (issue #24).
// Informational only — there is nothing to apply, so it's an alert, not a
// confirm. Uses the same notify surface and the same boot-overlay wait as the
// crash prompt above.
//
// Main claims the list on first read, so only one window ever receives it.
// This guard covers a repeat ask inside THIS window.
let skippedNoticeShown = false
void window.agentTeam?.restore?.getSkipped?.().then((list) => {
  if (!list?.length || skippedNoticeShown) return
  skippedNoticeShown = true
  const show = async (): Promise<void> => {
    await notifyRestore.alert(
      `${i18n.global.t('restore.skipped-message', { count: list.length })}\n\n${list.join('\n')}`,
      {
        title: i18n.global.t('restore.skipped-title'),
        confirmText: i18n.global.t('restore.skipped-ack'),
      }
    )
  }
  if (!booting.value) { void show(); return }
  const stop = watch(booting, (b) => { if (!b) { stop(); void show() } })
})

function onWorkspaceSelected(path: string): void {
  currentWorkspace.value = path
  workspaceSelected.value = true
  try {
    sessionStorage.setItem(WS_PATH_KEY, path)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* sessionStorage unavailable — non-fatal, just won't survive reload */
  }
}

// Best-effort backup of language pref to the workspace JSON.
watch(settingsApi.language, () => {
  if (currentWorkspace.value) {
    void settingsApi.syncToBackend(backend.send, currentWorkspace.value)
  }
})

function roleLabel(key: string): string {
  if (!key) return i18n.global.t('label.no-role')
  return rolesApi.find(key)?.label ?? key
}

// Full canonical list — used for agentKey → spec/label lookups everywhere, so a
// disabled agent's existing panes still resolve their label.
const agentSpecs: AgentSpec[] = AGENT_SPECS

// The subset (+order) the user chose in Settings → CLI Agents, fed to the manual
// spawn UI. Only non-terminal specs are filtered/ordered; terminal is kept as-is
// (ControlPane filters it out of the dropdown itself). Reactive via
// useCliAgentPrefs so a Settings edit updates the dropdown live.
const { order: cliAgentOrder, disabled: cliAgentDisabled } = useCliAgentPrefs()
const enabledAgentSpecs = computed<AgentSpec[]>(() => {
  const byKey = new Map(agentSpecs.map((s) => [s.agentKey, s]))
  const cliKeys = agentSpecs.filter((s) => s.agentKey !== 'terminal').map((s) => s.agentKey)
  const cli = orderedAgentKeys(cliKeys)
    .filter((k) => isAgentEnabled(k))
    .map((k) => byKey.get(k))
    .filter((s): s is AgentSpec => !!s)
  const terminal = agentSpecs.filter((s) => s.agentKey === 'terminal')
  return [...cli, ...terminal]
})

// Sticky toggles — defaults ON. Saved to the settings store so they survive reloads.
function makeStickyBool(key: string, fallback: boolean) {
  const r = ref<boolean>(
    (() => {
      const stored = settingsGet<string | null>(key, null)
      return stored === null ? fallback : stored === '1'
    })()
  )
  watch(r, (v) => {
    settingsSet(key, v ? '1' : '0')
  })
  return r
}

const yoloEnabled = makeStickyBool('agentTeam.yolo', true)

/** The permission-bypass flag a fresh spawn of `agentKey` should carry, or ''.
 *  Every spawn / resume / restore path calls this instead of reading
 *  yoloEnabled directly, so the per-vendor override cannot apply to some
 *  paths and miss others. */
function skipFlagFor(agentKey: string, spec?: AgentSpec): string {
  return skipPermissionFlagFor({
    spec,
    globalYolo: yoloEnabled.value,
    mode: parseCliPermissionMode(settingsGet<string | null>(cliPermissionKey(agentKey), null))
  })
}

const autoAnswerEnabled = makeStickyBool('agentTeam.autoAnswer', false)
// Confirm before closing a workspace or quitting the app. Default ON.
const confirmBeforeClose = makeStickyBool('agentTeam.confirmClose', true)
const dontConfirmCloseAgain = ref<boolean>(false)
// Confirm before ⌘W closes an idle CLI pane. Default ON: the key is one-handed
// and sits next to keys you press while typing into the very pane it kills.
// Only the ⌘W path reads this — the ✕ button is a deliberate mouse click and
// still closes outright. A running pane always asks, setting or not.
const confirmBeforeClosePane = makeStickyBool('agentTeam.confirmClosePane', true)
// Hand a long-idle CLI's memory back to the machine. Each idle claude holds
// ~230-330MB it never releases (GPU slabs the process allocates and keeps, see
// the memory diagnosis) — with a dozen panes open that is most of a 32GB
// machine, and the pane sitting on it has not been touched in hours. Reclaiming
// returns it to the same cold-restore placeholder a restart would show, so the
// conversation is one click away rather than gone.
const idleReclaimEnabled = makeStickyBool('agentTeam.idleReclaim', true)
const idleReclaimMinutes = makeStickyStr('agentTeam.idleReclaimMinutes', '30')
// Push the "confirm before quit" config to main so the native dialog stays in
// sync with the shared setting and the current locale.
function pushQuitConfirmConfig(): void {
  window.agentTeam?.setQuitConfirm?.({
    enabled: confirmBeforeClose.value,
    message: i18n.global.t('confirm-close.quit-title'),
    detail: i18n.global.t('confirm-close.quit-body'),
    quitLabel: i18n.global.t('confirm-close.quit'),
    cancelLabel: i18n.global.t('action.cancel'),
    dontShowLabel: i18n.global.t('confirm-close.dont-show-again'),
  })
}
watch(confirmBeforeClose, pushQuitConfirmConfig)
// Strict completion: when ON, idle/cap timeouts do NOT auto-advance — instead they
// prompt the user (or, if Full auto is also on, an LLM-styled 5-sec auto-advance).
// Shell geometry now lives in the layout store: one object, one write path, and
// the same source Settings will edit later. These stay as computeds so the rest
// of this file — handles, refits, the panel props — keeps reading what it always
// read; only the storage underneath moved.
//
// The store also carries `up` and `down`. Both start empty, an empty slot
// resolves to a 0px track, so the shell renders exactly as the three-column
// version did until a view is put there.
const { layout: shellLayout, slotTracks, setSlotSize, setSlotCollapsed, setActiveView, canCollapse } = useLayoutStore()

const leftPanelWidth = computed(() => shellLayout.value.slots.left.size)
const rightPanelWidth = computed(() => shellLayout.value.slots.right.size)
const leftPanelCollapsed = computed(() => shellLayout.value.slots.left.collapsed)
/** Kept for the panel prop and every `v-if` that already reads it. */
const tokenPanelExpanded = computed<boolean>({
  get: () => !shellLayout.value.slots.right.collapsed,
  set: (v) => { setSlotCollapsed('right', !v); refitAllTerminals() },
})
const tokenPanelWidth = computed(() => slotTracks.value.right)
const leftTrackWidth = computed(() => slotTracks.value.left)

// Collapsing either side slot resizes the main column by hundreds of pixels.
// Per-pane ResizeObservers coalesce that away often enough to leave terminals
// at a stale width, so drive the refit from the toggle itself.
function setLeftCollapsed(v: boolean): void {
  if (v && !canCollapse('left')) return
  setSlotCollapsed('left', v)
  refitAllTerminals()
}

// The horizontal slots take height off the stage rather than width, but the
// terminals care either way, so they refit on the same terms as the side ones.
function setSlotCollapsedAndRefit(id: 'up' | 'down', v: boolean): void {
  if (v && !canCollapse(id)) return
  setSlotCollapsed(id, v)
  refitAllTerminals()
}

// A handle needs a track to drag. A collapsed slot is a 36px rail and an empty
// one is 0px wide — in both cases the handle would sit against the window edge
// writing a size nothing displays.
const leftHandleVisible = computed(
  () => !shellLayout.value.slots.left.collapsed && shellLayout.value.slots.left.views.length > 0
)
const rightHandleVisible = computed(
  () => !shellLayout.value.slots.right.collapsed && shellLayout.value.slots.right.views.length > 0
)

const upTrackHeight = computed(() => slotTracks.value.up)
const downTrackHeight = computed(() => slotTracks.value.down)

// Safety net for every other way the stage can change size: a view moved in
// Settings, a size typed there, or another window editing the shared layout.
// The toggles above refit immediately because a delayed one would show a
// stale-width flash; this covers the paths that have no single call site.
// Debounced because dragging a handle rewrites the track on every mousemove.
let _slotTrackTimer: number | null = null
watch(slotTracks, () => {
  if (_slotTrackTimer !== null) clearTimeout(_slotTrackTimer)
  _slotTrackTimer = window.setTimeout(() => { _slotTrackTimer = null; refitAllTerminals() }, 120)
}, { deep: true })

type DragTarget = 'left' | 'right'
let _dragTarget: DragTarget | null = null
let _dragStartX = 0
let _dragStartW = 0
// One flag per handle family. They used to share a single `isDragging`, so
// dragging a grid splitter also lit up the shell handles at the window edges
// and vice versa — the highlight told you the wrong thing was moving.
const isShellDragging = ref(false)
const isGridDragging = ref(false)

function onResizeStart(e: MouseEvent, target: DragTarget): void {
  if (target === 'right' && !tokenPanelExpanded.value) return
  _dragTarget = target
  _dragStartX = e.clientX
  _dragStartW = target === 'left' ? leftPanelWidth.value : rightPanelWidth.value
  isShellDragging.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  e.preventDefault()
}

function onResizeMove(e: MouseEvent): void {
  if (!_dragTarget) return
  const dx = e.clientX - _dragStartX
  // The store clamps to each slot's own range, so the limits live with the slot
  // definition instead of being repeated at every call site that moves one.
  setSlotSize(_dragTarget, _dragTarget === 'left' ? _dragStartW + dx : _dragStartW - dx)
}

function refitAllTerminals(): void {
  void nextTick(() => requestAnimationFrame(() => {
    for (const ref of Object.values(paneRefs)) {
      (ref as unknown as { fitTerminal?: (opts: { redrawAfterSettle: boolean }) => void })?.fitTerminal?.({ redrawAfterSettle: true })
    }
  }))
}

// Window-level resize safety net. Per-pane ResizeObservers can miss the macOS
// fullscreen / maximize transition (the renderer is occluded mid-animation, so
// the observer callback is coalesced away), leaving panes at a stale width with
// empty space on the right. A debounced window 'resize' listener guarantees a
// refit on any OS-window size change regardless of the observers.
let _winResizeTimer: number | null = null
function onWindowResize(): void {
  if (_winResizeTimer !== null) clearTimeout(_winResizeTimer)
  _winResizeTimer = window.setTimeout(() => { _winResizeTimer = null; refitAllTerminals() }, 150)
}

function onResizeEnd(): void {
  _dragTarget = null
  isShellDragging.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  refitAllTerminals()
}

function makeStickyStr(key: string, fallback: string) {
  const r = ref<string>(settingsGet(key, fallback))
  watch(r, (v) => {
    settingsSet(key, v)
  })
  return r
}
const analyzerModel = makeStickyStr('agentTeam.analyzerModel', '')
const CLI_BINARY_SETTING_PREFIX = 'agentTeam.cliBinary.'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function commandWithSelectedBinary(agentKey: string, command: string): string {
  const binary = settingsGet(`${CLI_BINARY_SETTING_PREFIX}${agentKey}`, '').trim()
  const defaultCommand = agentSpecs.find((spec) => spec.agentKey === agentKey)?.defaultCommand ?? ''
  if (!binary || !defaultCommand) return command
  const escapedCommand = defaultCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return command.replace(new RegExp(`^${escapedCommand}(?=\\s|$)`), shellQuote(binary))
}

function selectCliBinary(payload: { agentKey: string; path: string; version: string }): void {
  settingsSet(`${CLI_BINARY_SETTING_PREFIX}${payload.agentKey}`, payload.path)
  cliHealthGuide.value = null
}

// When models first load (or after a refresh), if no model has been explicitly
// chosen yet, pin the sticky to the backend's default so the selector is stable
// across restarts rather than showing whichever model comes first in the list.
watch(
  () => analyzerApi.defaultModel.value,
  (def) => {
    if (def && !analyzerModel.value) {
      analyzerModel.value = def
    }
  },
  { immediate: true }
)

const listPaneDir: DirLister = async (dir) => {
  const resp = await sendQuiet<{ entries?: { name: string }[] }>('fs.list_dir', {
    workspace_path: dir,
    rel_path: '',
    show_hidden: true,
  })
  return resp?.entries?.map((entry) => entry.name) ?? null
}

/** Where a pane's per-pane files live, for the vendors that write them; '' for
 *  the rest. The resolution (and its memoization) belongs to the vendor — see
 *  `paneHistoryRoot` in agents/types.ts. */
async function paneHistoryRootFor(agentKey: string, cwd: string): Promise<string> {
  const resolve = agentSpecs.find((s) => s.agentKey === agentKey)?.paneHistoryRoot
  return resolve ? resolve(cwd, listPaneDir) : ''
}

/** The history file a pane must RESUME from, for a vendor whose resume reads
 *  one back. '' for every other agent, and when the pane has no cwd. */
async function savedHistoryFile(
  agent: string,
  workspacePath: string,
  paneId: string
): Promise<string> {
  const resolve = agentSpecs.find((s) => s.agentKey === agent)?.resumeHistoryFile
  if (!resolve || !workspacePath) return ''
  return resolve(workspacePath, paneId, listPaneDir)
}

function resolveCommand(agentKey: string, override: string, paneArgCtx?: PaneArgContext): string {
  const spec = agentSpecs.find((s) => s.agentKey === agentKey)
  const trimmed = override.trim()
  // If user supplied an override, trust it verbatim.
  if (trimmed) return commandWithSelectedBinary(agentKey, trimmed)
  const parts = [spec?.defaultCommand ?? agentKey]
  const paneArg = paneArgCtx && spec?.paneArg ? spec.paneArg(paneArgCtx) : ''
  if (paneArg) parts.push(paneArg)
  const skipFlag = skipFlagFor(agentKey, spec)
  if (skipFlag) parts.push(skipFlag)
  return commandWithSelectedBinary(agentKey, parts.join(' '))
}

interface RunGroup {
  id: string
  name: string
  createdAt: number
}

interface ActivePane {
  id: string
  /** False while a persisted pane is represented by a cold-restore placeholder. */
  realized: boolean
  /** Runtime-only restore marker cleared after the first live output. */
  restoring?: boolean
  agentKey: string
  agentLabel: string
  /** User-set display name from the rename action. Overrides agentLabel in all
   *  pane surfaces when non-empty; persisted to project.json (PaneRecord.custom_name). */
  customName?: string
  /** The user named this pane at least once, so no auto-namer writes to it
   *  again. Separate from customName because clearing the name is still an act
   *  of naming, and because a title typed to match agentLabel resolves to no
   *  customName at all. It blocks NEW auto-names only — an autoName already
   *  stored keeps showing. One-way; persisted (PaneRecord.name_locked). */
  nameLocked?: boolean
  /** Auto-derived display name (from the pane's task material).
   *  customName always wins; persisted to project.json (PaneRecord.auto_name). */
  autoName?: string
  /** Which namer produced autoName. The string heuristic titles the pane
   *  instantly; the model's answer may replace that once, and never the
   *  reverse — see setPaneAutoName. */
  autoNameSource?: 'heuristic' | 'llm'
  /** Inter-CLI messaging address from the messaging registry. Absent for plain
   *  terminal panes. Persisted to localStorage keyed by pane id so names
   *  survive restart (see persistMessagingName). */
  messagingName?: string
  /** Pane ids this pane's CLI process was reached under before the pane was
   *  rebuilt around it (restore that reattached a live PTY, detach, group
   *  reattach). Mirrored to the backend so the /plan-mcp URL that process was
   *  spawned with — which carries the id of that moment forever — still
   *  resolves to this pane. */
  formerPaneIds?: string[]
  /** Pane id of the parent that spawned this pane via a SPAWN block.
   *  Persisted (PaneRecord.spawned_by) and re-keyed by the backend whenever a
   *  pane_id is regenerated, so lineage survives a restart. */
  spawnedBy?: string
  /** Messaging handle of the parent this pane owes a report to, and whether
   *  that report is still outstanding. Set together when a spawn kickoff lands
   *  and cleared by the first turn that ends — by the pane's own report if it
   *  wrote one, by a fallback report if it did not. Runtime only — unlike
   *  spawnedBy this is deliberately NOT persisted: the turn that owed the
   *  report ended when the app closed, so a restored pane owes nothing. */
  spawnedByName?: string
  spawnReportPending?: boolean
  roleKey: RoleKey
  stageId: StageId
  /** Human-readable slot label, e.g. "Architecture" or "UI/UX".
   *  Empty string for single-agent stages or manually-spawned panes. */
  slotLabel: string
  command: string
  workspacePath: string
  origin: 'manual' | 'pipeline' | 'mcp'
  /** Which pipeline run group this pane belongs to. Undefined = unassigned (manual). */
  runGroupId?: string
  injectionStatus: InjectionStatus
  preparationStatus: PreparationStatus
  injectionTimer: number | null
  kickoffStatus: KickoffStatus
  kickoffPrompt: string
  /** When true, scheduleInjection skips role injection and sets injectionStatus='skipped'.
   *  activateStage will inject role + kickoff together at stage activation time. */
  skipRoleInjection?: boolean
  /** Absolute path to this pane's output log file (pipeline panes only). Lets
   *  downstream stages point agents at prior outputs via file path instead of
   *  inlining the whole terminal buffer into the kickoff. */
  outputLogFile?: string
  /** CLI session id used to resume this pane on restart. Known immediately for
   *  Claude (the --session-id we pinned); filled in later for Codex/Antigravity once
   *  their CLI-generated id is detected from the session file. */
  pinnedSessionId?: string
  /** True once the CLI transcript for pinnedSessionId is known to exist on
   *  disk (resume spawn, restore whose probe confirmed the saved transcript
   *  even though the pane spawned fresh, first Claude turn event, or
   *  session.detected). Gates the Rebuild (resume) buttons for Claude, whose
   *  pinnedSessionId is minted at spawn — before any transcript is written.
   *  Runtime-only. */
  sessionOnDisk?: boolean
  /** True when pinnedSessionId was pre-filled from a SAVED session during a
   *  fresh (non-resume) restore: the pin is NOT the pane's launch identity and
   *  must be replaced (flag cleared) once the pane's real session is
   *  attributed/detected. Runtime-only. */
  pinnedFromRestore?: boolean
  /** Stable Codex CODEX_HOME id. It can differ from the live pane id after restore. */
  sessionHomeId?: string
  /** CLI account pin this pane was spawned on ('__default__' = real home);
   *  carried so an in-session rebuild resumes on the same account. */
  profileId?: string
  /** Unique marker embedded in this pane's kickoff (Codex/Antigravity only) so the
   *  backend can match the right session file to this pane when several
   *  same-vendor panes share a workspace. */
  sessionMarker?: string
  /** Runtime-only: the marker was typed into this pane as a standalone prompt
   *  and the CLI's answer to it has not been seen yet. See sessionMarkerTurn.ts
   *  — that answer is a turn the user never started, so it must not name the
   *  pane, chime "done", or be scanned for MSG blocks. */
  markerReplyPending?: boolean
  /** True once the session-detect overlay's grace window has elapsed. Session
   *  detection itself keeps running (subtitle still says "detecting"); only the
   *  BLOCKING overlay is dropped — detection has preconditions the user may
   *  need the terminal for (e.g. a first-run API-key prompt). */
  sessionOverlayExpired?: boolean
  /** Runtime-only LOOP badge — lit after the loop prompt was injected via the
   *  pane's loop button. Not persisted to PaneRecord. */
  loopActive?: boolean
  /** Epoch ms of the scheduled session-limit auto-resume (runtime-only). Set
   *  while the loop is paused waiting for the CLI quota to reset; an app
   *  restart during the window drops the pending resume (accepted). */
  loopWaitUntil?: number | null
  /** Epoch ms of the heuristic quota-reset estimate (runtime-only): loop start
   *  + 5h Claude session window, shown on the running badge as approximate. */
  loopEstimateResetAt?: number | null
  /** Prompt skill this loop was cast with (runtime-only). Null / absent means
   *  the default skill, i.e. what a plain ∞ click sends. */
  loopSkillId?: string | null
  /** Turns already continued in this loop, and the skill's cap (0 = no cap).
   *  Counted on the continue path so the cap means "how many more turns after
   *  the start injection", which is what the picker's ×N label promises. */
  loopTurnCount?: number
  loopMaxTurns?: number
  /** Runtime-only login-expired badge — lit when the pane's CLI printed its
   *  expired-login message (see lib/cliLoginExpired); cleared once the login
   *  command is re-sent via the badge click. Not persisted to PaneRecord. */
  loginExpired?: boolean
  /** Runtime-only continue affordance — lit when this pane was brought back with
   *  `--resume`. The CLI reloads its transcript but parks at the prompt, so an
   *  interrupted task is never picked up on its own and nothing in the restore
   *  path may inject on the user's behalf. Cleared by the first injection or by
   *  agent activity. Not persisted: a restart re-derives it from the restore. */
  resumeContinueAvailable?: boolean
  /** Cold-restore metadata retained until the placeholder is explicitly opened. */
  deferredRestore?: DeferredRestoreMetadata
}

const panes = ref<ActivePane[]>([])
const paneRefs = reactive<Record<string, InstanceType<typeof TerminalPane> | null>>({})
const persistedPaneSessions = new Set<string>()
// Bounded retry for persistPaneSession. The backend noops when the manual-pane
// record doesn't exist yet (persist racing manual_pane.spawn) — normally
// transient. But a permanently-missing record would otherwise re-send
// manual_pane.session on every activity event forever, a ~60/sec flood that
// saturates the backend event loop and times out terminal.create. Cap attempts
// per key, then give up (treat as persisted so callers stop re-sending).
const persistPaneAttempts = new Map<string, number>()
const MAX_PERSIST_PANE_ATTEMPTS = 8

// Tracks which issues have been dispatched/handled and to which pane.
// key: issue.url  value: { paneId, mode, state }
const issueHandoffs = ref<Map<string, { paneId: string; mode: string; state: 'handling' | 'pane-gone' }>>(new Map())
const SPAWN_HISTORY_KEY = 'agentTeam.spawnHistory'
const MAX_SPAWN_HISTORY = 100

function parseSpawnHistory(raw: string, workspace: WorkspaceIdentity): SpawnHistoryEntry[] {
  try {
    return (JSON.parse(raw) as SpawnHistoryEntry[])
      .filter((entry) => entryBelongsToWorkspace(entry, workspace))
      .slice(-MAX_SPAWN_HISTORY)
      .map((entry) => ({
        ...entry,
        sessionId: entry.sessionId
          ? normalizeResumeSessionId(entry.agentKey, entry.sessionId)
          : entry.sessionId,
      }))
  } catch {
    return []
  }
}

/** One-time source for projects created before history moved into project.json. */
function loadLegacySpawnHistory(workspacePath: string): SpawnHistoryEntry[] {
  const raw = settingsGet<string | null>(SPAWN_HISTORY_KEY, null)
  return raw ? parseSpawnHistory(raw, spawnHistoryWorkspaceIdentity(workspacePath)) : []
}

const spawnHistory = ref<SpawnHistoryEntry[]>([])
// Backend-resolved realpath of the hydrated workspace (from
// project.get_spawn_history). Lets entries recorded under a symlinked
// workspace's canonical spelling still count as ours.
const spawnHistoryCanonicalWorkspace = ref('')

function spawnHistoryWorkspaceIdentity(workspacePath: string): WorkspaceIdentity {
  return {
    workspacePath,
    canonicalWorkspacePath: spawnHistoryCanonicalWorkspace.value || undefined,
  }
}

/** Newest first, one row per session (pane id as the fallback key), filtered
 *  to one workspace. Shared by the viewed workspace's live list and another
 *  workspace's read-only copy so the two cannot dedupe differently. */
function historyEntriesFor(
  entries: readonly SpawnHistoryEntry[],
  workspace: WorkspaceIdentity,
): SpawnHistoryEntry[] {
  const result: SpawnHistoryEntry[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    // Display-layer guard: never show another workspace's entries, even if
    // one slipped into the buffer at runtime.
    if (!entryBelongsToWorkspace(entry, workspace)) continue
    const key = entry.sessionId ? `session:${entry.sessionId}` : `pane:${entry.paneId}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(entry)
    }
  }
  return result
}

const sessionHistory = computed(() =>
  historyEntriesFor(spawnHistory.value, spawnHistoryWorkspaceIdentity(currentWorkspace.value))
)

let spawnHistoryWorkspace = ''
let spawnHistoryHydrated = false
let spawnHistoryPersistTimer: number | undefined

// Paged reads from the backend's full store (spawn-history.json). Counts are
// from the newest end: `fetched` = how many entries we already pulled.
interface SpawnHistoryPage {
  entries: SpawnHistoryEntry[]
  total: number
  offset: number
  canonical_workspace_path?: string
}
const spawnHistoryTotal = ref(0)
const spawnHistoryFetched = ref(0)
const spawnHistoryHasMore = computed(() => spawnHistoryFetched.value < spawnHistoryTotal.value)
let spawnHistoryLoadingMore = false

/** Liveness reconciliation: `removedAt` is only ever stamped by an explicit
 *  per-pane kill (onKill), so entries still open when the app quits — updater
 *  relaunch, crash, force quit — reload as "active" forever. A loaded entry
 *  whose paneId has no live pane is dead by definition (every spawn, including
 *  a restore, generates a fresh paneId), so stamp it removed on load. */
function reconcileSpawnHistoryLiveness(entries: SpawnHistoryEntry[]): void {
  if (isDetachedWindow) return
  const livePaneIds = new Set(panes.value.map((p) => p.id))
  const reconciledAt = new Date().toISOString()
  for (const e of entries) {
    if (!e.removedAt && !livePaneIds.has(e.paneId)) e.removedAt = reconciledAt
  }
}

async function hydrateSpawnHistory(
  workspacePath: string,
  persisted: SpawnHistoryEntry[] | null | undefined,
  isStale?: () => boolean,
): Promise<void> {
  if (isStale?.() || currentWorkspace.value !== workspacePath) return
  if (spawnHistoryPersistTimer !== undefined) {
    window.clearTimeout(spawnHistoryPersistTimer)
    spawnHistoryPersistTimer = undefined
  }
  spawnHistoryHydrated = false
  spawnHistoryWorkspace = workspacePath
  spawnHistoryCanonicalWorkspace.value = ''
  spawnHistoryTotal.value = 0
  spawnHistoryFetched.value = 0
  const baselineLength = spawnHistory.value.length

  // The full history lives in .agent-team/spawn-history.json; ask the backend
  // for the newest page. The project.json mirror (`persisted`) stays as the
  // fallback for backends without the paginated API.
  let source: SpawnHistoryEntry[]
  const page = await sendQuiet<SpawnHistoryPage>('project.get_spawn_history', {
    workspace_path: workspacePath,
    offset: 0,
    limit: MAX_SPAWN_HISTORY,
  })
  if (isStale?.() || currentWorkspace.value !== workspacePath || spawnHistoryWorkspace !== workspacePath) return
  if (page && typeof page.canonical_workspace_path === 'string') {
    spawnHistoryCanonicalWorkspace.value = page.canonical_workspace_path
  }
  if (page && Array.isArray(page.entries) && (page.entries.length > 0 || persisted != null)) {
    source = [...page.entries].reverse() // newest→oldest page → stored oldest→newest
    spawnHistoryTotal.value = typeof page.total === 'number' ? page.total : page.entries.length
    spawnHistoryFetched.value = page.entries.length
  } else {
    // API missing/failed, or an old project whose history never reached the
    // backend: keep the pre-pagination path (mirror, then legacy settings).
    source = Array.isArray(persisted) ? persisted : loadLegacySpawnHistory(workspacePath)
  }
  // Reuse the parser for normalization and workspace filtering.
  const hydrated = parseSpawnHistory(JSON.stringify(source), spawnHistoryWorkspaceIdentity(workspacePath))
  reconcileSpawnHistoryLiveness(hydrated)
  // Keep entries pushed while the page was in flight (e.g. restore backfill).
  const hydratedIds = new Set(hydrated.map((e) => e.paneId))
  const inFlight = spawnHistory.value
    .slice(baselineLength)
    .filter((e) => e.workspacePath === workspacePath && !hydratedIds.has(e.paneId))
  spawnHistory.value = [...hydrated, ...inFlight]
  spawnHistoryHydrated = true

  // Missing (not empty) means an old project: migrate its matching slice once.
  if (persisted == null && spawnHistory.value.length > 0 && !isDetachedWindow) {
    void sendQuiet('project.set_ui_state', {
      workspace_path: workspacePath,
      spawn_history: spawnHistory.value,
    })
  }
}

/** Fetch the next (older) page of the full spawn history and prepend it,
 *  deduped by paneId. Data layer only — the UI trigger ships in Phase D;
 *  exposed to AgentHistoryModal via props. */
async function loadMoreSpawnHistory(): Promise<void> {
  const workspacePath = spawnHistoryWorkspace
  if (!workspacePath || !spawnHistoryHydrated || spawnHistoryLoadingMore) return
  if (!spawnHistoryHasMore.value) return
  spawnHistoryLoadingMore = true
  try {
    const page = await sendQuiet<SpawnHistoryPage>('project.get_spawn_history', {
      workspace_path: workspacePath,
      offset: spawnHistoryFetched.value,
      limit: MAX_SPAWN_HISTORY,
    })
    if (!page || !Array.isArray(page.entries)) return
    if (spawnHistoryWorkspace !== workspacePath) return // workspace switched mid-fetch
    if (typeof page.total === 'number') spawnHistoryTotal.value = page.total
    spawnHistoryFetched.value += page.entries.length
    if (page.entries.length === 0) {
      // Past the end (e.g. the store shrank): stop advertising more.
      spawnHistoryTotal.value = spawnHistoryFetched.value
      return
    }
    const existing = new Set(spawnHistory.value.map((e) => e.paneId))
    const workspace = spawnHistoryWorkspaceIdentity(workspacePath)
    const older = page.entries
      .filter((entry) => entryBelongsToWorkspace(entry, workspace) && !!entry.paneId && !existing.has(entry.paneId))
      .map((entry) => ({
        ...entry,
        sessionId: entry.sessionId
          ? normalizeResumeSessionId(entry.agentKey, entry.sessionId)
          : entry.sessionId,
      }))
      .reverse() // newest→oldest page → oldest→newest for storage order
    reconcileSpawnHistoryLiveness(older)
    if (older.length > 0) spawnHistory.value = [...older, ...spawnHistory.value]
  } finally {
    spawnHistoryLoadingMore = false
  }
}

// ── Another workspace's history ─────────────────────────────────────────
// Every workspace heading carries a history button, so the modal is not
// always looking at the workspace on screen.

/** The workspace the modal is showing; '' means the one on screen. */
const historyWorkspace = ref<string>('')

/** That workspace's entries.
 *
 *  Deliberately NOT spawnHistory. That ref drives the persist watcher, which
 *  writes whatever it holds back into spawnHistoryWorkspace's record — so
 *  loading another project's entries into it would file them under the
 *  workspace on screen. Nothing is ever persisted from this buffer: writes go
 *  to the backend keyed by the entry's own workspace, and are mirrored here
 *  only so the list reflects them. Liveness, paging and hydration state are
 *  kept separate for the same reason. */
const foreignHistory = ref<SpawnHistoryEntry[]>([])
const foreignHistoryCanonical = ref('')
const foreignHistoryTotal = ref(0)
const foreignHistoryFetched = ref(0)
let foreignHistoryLoading = false

/** True while the modal shows a workspace other than the one on screen. */
const historyIsForeign = computed(
  () =>
    !!historyWorkspace.value &&
    normWs(historyWorkspace.value) !== normWs(currentWorkspace.value)
)

/** The workspace every history WRITE must name. Reading currentWorkspace
 *  instead is how a delete run from another project's history would have hit
 *  the one on screen — and history has no undo. */
const historyViewWorkspace = computed(() =>
  historyIsForeign.value ? historyWorkspace.value : currentWorkspace.value
)

const historyIdentity = computed<WorkspaceIdentity>(() =>
  historyIsForeign.value
    ? {
        workspacePath: historyWorkspace.value,
        canonicalWorkspacePath: foreignHistoryCanonical.value || undefined,
      }
    : spawnHistoryWorkspaceIdentity(currentWorkspace.value)
)

/** The buffer the modal's own actions patch. */
const historyBuffer = (): SpawnHistoryEntry[] =>
  historyIsForeign.value ? foreignHistory.value : spawnHistory.value

/** What the modal renders. */
const historyEntries = computed(() =>
  historyIsForeign.value
    ? historyEntriesFor(foreignHistory.value, historyIdentity.value)
    : sessionHistory.value
)

/** Names the project when it is not the one on screen. The modal no longer
 *  switches to it, so it has to say whose history this is. */
const historyWorkspaceLabel = computed(() =>
  historyIsForeign.value
    ? (normWs(historyWorkspace.value).split('/').filter(Boolean).pop() ?? '')
    : ''
)

function resetForeignHistory(): void {
  historyWorkspace.value = ''
  foreignHistory.value = []
  foreignHistoryCanonical.value = ''
  foreignHistoryTotal.value = 0
  foreignHistoryFetched.value = 0
}

/** Page 0 of another workspace's history. */
async function loadForeignHistory(path: string): Promise<void> {
  foreignHistory.value = []
  foreignHistoryCanonical.value = ''
  foreignHistoryTotal.value = 0
  foreignHistoryFetched.value = 0
  const page = await sendQuiet<SpawnHistoryPage>('project.get_spawn_history', {
    workspace_path: path,
    offset: 0,
    limit: MAX_SPAWN_HISTORY,
  })
  // The modal can be closed, or pointed at a different heading, mid-flight.
  if (normWs(historyWorkspace.value) !== normWs(path)) return
  if (!page || !Array.isArray(page.entries)) return
  if (typeof page.canonical_workspace_path === 'string') {
    foreignHistoryCanonical.value = page.canonical_workspace_path
  }
  // Same parser the viewed workspace goes through, for the same normalization.
  const hydrated = parseSpawnHistory(
    JSON.stringify([...page.entries].reverse()), // newest→oldest page → storage order
    {
      workspacePath: path,
      canonicalWorkspacePath: foreignHistoryCanonical.value || undefined,
    },
  )
  // Its panes live in this window like any other held workspace's, so the
  // same liveness rule applies.
  reconcileSpawnHistoryLiveness(hydrated)
  foreignHistory.value = hydrated
  foreignHistoryTotal.value = typeof page.total === 'number' ? page.total : page.entries.length
  foreignHistoryFetched.value = page.entries.length
}

async function loadMoreForeignHistory(): Promise<void> {
  const path = historyWorkspace.value
  if (!path || foreignHistoryLoading) return
  if (foreignHistoryFetched.value >= foreignHistoryTotal.value) return
  foreignHistoryLoading = true
  try {
    const page = await sendQuiet<SpawnHistoryPage>('project.get_spawn_history', {
      workspace_path: path,
      offset: foreignHistoryFetched.value,
      limit: MAX_SPAWN_HISTORY,
    })
    if (!page || !Array.isArray(page.entries)) return
    if (normWs(historyWorkspace.value) !== normWs(path)) return
    if (typeof page.total === 'number') foreignHistoryTotal.value = page.total
    foreignHistoryFetched.value += page.entries.length
    if (page.entries.length === 0) {
      // Past the end (the store shrank): stop advertising more.
      foreignHistoryTotal.value = foreignHistoryFetched.value
      return
    }
    const existing = new Set(foreignHistory.value.map((e) => e.paneId))
    const older = parseSpawnHistory(
      JSON.stringify([...page.entries].reverse()),
      historyIdentity.value,
    ).filter((entry) => !!entry.paneId && !existing.has(entry.paneId))
    reconcileSpawnHistoryLiveness(older)
    if (older.length > 0) foreignHistory.value = [...older, ...foreignHistory.value]
  } finally {
    foreignHistoryLoading = false
  }
}

const historyHasMore = computed(() =>
  historyIsForeign.value
    ? foreignHistoryFetched.value < foreignHistoryTotal.value
    : spawnHistoryHasMore.value
)

async function loadMoreHistory(): Promise<void> {
  if (historyIsForeign.value) await loadMoreForeignHistory()
  else await loadMoreSpawnHistory()
}

/** Inline rename from the Agent History detail pane. A live pane goes through
 *  the normal pane rename flow (project.rename_pane, pane title included);
 *  removed entries patch the persisted history directly, full store + mirror
 *  (project.rename_spawn_history). */
function onRenameHistoryEntry(entry: SpawnHistoryEntry, rawName: string): void {
  if (!entry.removedAt && panes.value.some((p) => p.id === entry.paneId)) {
    setPaneCustomName(entry.paneId, rawName)
    return
  }
  const name = rawName.trim()
  // Same reset rule as setPaneCustomName: empty or default label clears it.
  const nameToSet = name && name !== entry.agentLabel ? name : undefined
  updateHistoryCustomName(historyBuffer(), {
    paneId: entry.paneId,
    agentKey: entry.agentKey,
    sessionId: entry.sessionId,
    sessionHomeId: entry.sessionHomeId,
  }, nameToSet)
  const ws = entry.workspacePath || historyViewWorkspace.value
  if (!ws) return
  backend.send('project.rename_spawn_history', {
    workspace_path: ws,
    pane_id: entry.paneId,
    custom_name: nameToSet ?? '',
  })
}

/** Stars/unstars a history entry: local update for instant UI, plus an
 *  explicit backend patch of the full store + mirror (same dual-track model
 *  as onRenameHistoryEntry — the debounced set_ui_state snapshot alone could
 *  be lost on quit). Unstarring deletes the key backend-side. */
function onToggleStarHistoryEntry(entry: SpawnHistoryEntry, starred: boolean): void {
  const target = historyBuffer().find((e) => e.paneId === entry.paneId)
  if (target) {
    if (starred) target.starred = true
    else delete target.starred
  }
  const ws = entry.workspacePath || historyViewWorkspace.value
  if (!ws) return
  backend.send('project.star_spawn_history', {
    workspace_path: ws,
    pane_id: entry.paneId,
    starred,
  })
}

/** Dry-run of a history delete: what the backend *would* remove for this
 *  target, including the CLI transcript logs it would unlink. Feeds the
 *  modal's delete confirmation. `null` means the probe failed — the modal
 *  then confirms without the figures instead of blocking the delete. */
async function previewHistoryDelete(target: HistoryDeleteTarget): Promise<HistoryDeletePreview | null> {
  // The workspace the modal is SHOWING, which need not be the one on screen.
  const ws = historyViewWorkspace.value
  if (!ws) return null
  const payload: Record<string, unknown> = {
    workspace_path: ws,
    mode: target.mode,
    dry_run: true,
  }
  if (target.paneIds) payload.pane_ids = target.paneIds
  if (target.cutoffIso) payload.cutoff_iso = target.cutoffIso
  const resp = await sendQuiet<{
    deleted: number
    freed_bytes?: number
    removed_log_files?: number
  }>('project.delete_spawn_history', payload)
  if (!resp) return null
  return {
    entries: resp.deleted,
    logFiles: resp.removed_log_files ?? 0,
    freedBytes: resp.freed_bytes ?? 0,
  }
}

/** Deletes one history record (never kills a pane — the modal only offers
 *  delete on removed entries). Backend removes it from the full store and
 *  the project.json mirror — and unlinks its CLI transcript log — while
 *  locally we drop it and fix the paging counters. */
async function onDeleteHistoryEntry(entry: SpawnHistoryEntry): Promise<void> {
  const ws = historyViewWorkspace.value
  if (!ws) return
  const resp = await sendQuiet<{ deleted: number; total: number }>('project.delete_spawn_history', {
    workspace_path: ws,
    mode: 'ids',
    pane_ids: [entry.paneId],
  })
  if (!resp) return
  // Patch whichever buffer is on screen; the other one's counters are not
  // about this store and must not move.
  if (historyIsForeign.value) {
    foreignHistory.value = foreignHistory.value.filter((e) => e.paneId !== entry.paneId)
    foreignHistoryTotal.value = resp.total
    foreignHistoryFetched.value = Math.max(0, foreignHistoryFetched.value - resp.deleted)
    return
  }
  spawnHistory.value = spawnHistory.value.filter((e) => e.paneId !== entry.paneId)
  spawnHistoryTotal.value = resp.total
  spawnHistoryFetched.value = Math.max(0, spawnHistoryFetched.value - resp.deleted)
}

/** Bulk cleanup ("clear all removed" / "clear older than 7 days"). Runs over
 *  the FULL store on the backend — including entries never paged in — so the
 *  loaded window is re-synced from page 0 afterwards instead of patched
 *  locally. `[]` (not null) skips hydrate's legacy-localStorage fallback and
 *  its one-time migration write. */
async function onCleanupHistory(mode: HistoryCleanupMode, cutoffIso: string): Promise<void> {
  const ws = historyViewWorkspace.value
  if (!ws) return
  const payload: Record<string, unknown> = { workspace_path: ws, mode }
  if (mode === 'older_than') payload.cutoff_iso = cutoffIso
  const resp = await sendQuiet<{ deleted: number; total: number }>('project.delete_spawn_history', payload)
  if (!resp) return
  // Re-read page 0 of whichever store was cleaned. hydrateSpawnHistory is for
  // the viewed workspace only — it moves spawnHistoryWorkspace and arms the
  // persist watcher, which must never point at another project.
  if (historyIsForeign.value) {
    await loadForeignHistory(ws)
    return
  }
  await hydrateSpawnHistory(ws, [])
}

watch(currentWorkspace, (workspacePath) => {
  if (workspacePath === spawnHistoryWorkspace) return
  if (spawnHistoryPersistTimer !== undefined) {
    window.clearTimeout(spawnHistoryPersistTimer)
    spawnHistoryPersistTimer = undefined
  }
  spawnHistoryHydrated = false
  spawnHistoryWorkspace = workspacePath
  spawnHistoryCanonicalWorkspace.value = ''
  spawnHistory.value = []
})

watch(spawnHistory, (v) => {
  if (!spawnHistoryHydrated || !spawnHistoryWorkspace || isDetachedWindow) return
  if (spawnHistoryPersistTimer !== undefined) window.clearTimeout(spawnHistoryPersistTimer)
  const workspacePath = spawnHistoryWorkspace
  // Write-layer guard: never persist entries that belong to another workspace.
  const snapshot = filterWorkspaceEntries(v, spawnHistoryWorkspaceIdentity(workspacePath)).slice(-MAX_SPAWN_HISTORY)
  spawnHistoryPersistTimer = window.setTimeout(() => {
    void sendQuiet('project.set_ui_state', {
      workspace_path: workspacePath,
      spawn_history: snapshot,
    })
  }, 200)
}, { deep: true })

function setPaneRef(id: string, el: unknown): void {
  paneRefs[id] = (el as InstanceType<typeof TerminalPane> | null) ?? null
}

const paneViews = ref<ActivePaneView[]>([])

// ── Per-pane turn-complete signal (CLI lifecycle, not a buffer guess) ────────
// The backend broadcasts `agent.activity` with event_type "turn_complete" when
// a CLI ends its turn (Claude Stop hook = 100% reliable, or a conversation-log
// turn-end parsed for codex/copilot/aider/kimi/qwen/pi/grok — the other vendors
// whose reader emits it). We record the wall-clock time per pane. A pane only counts as
// "turn complete for the current stage" when this timestamp is AFTER the
// watcher armed (see slotFinished), so a stale signal from a prior stage/turn
// is never reused — no explicit reset needed.
const paneTurnCompleteAt = new Map<string, number>()

// Per-pane wall-clock of the latest `agent_active` (CLI is producing output or
// running a tool). Compared against turnCompleteAt to tell whether the CLI's
// MOST RECENT signal was "working" vs "turn ended" — the core of the CLI-state
// model that replaces buffer-guessing.
const paneLastActiveAt = new Map<string, number>()

// Per-pane count of background subagents the CLI is still waiting on, as last
// reported by a hook event, with the wall-clock time of that report. The
// unattended loop reads it to tell a turn that ended DONE from one that ended
// to WAIT — the one distinction none of its other signals can make, because a
// CLI parked on a background agent really does end its turn (see the backend's
// subagent_tracker and loopWaitingOnSubagents). Vendors without hooks never
// send the field, so their panes never gate on it.
// The unattended loop's own activity clock. Same stamps as paneLastActiveAt
// except for `subagent_stop`, which is a SUBAGENT acting, not this pane's
// agent. Kept separate rather than narrowing paneLastActiveAt so the three
// other readers of that clock — delivery gating, the done notification and the
// pipeline's stage verdict — keep behaving exactly as before.
const paneLastWorkingAt = new Map<string, number>()

const panePendingSubagents = new Map<string, { pending: number; observedAt: number }>()

// ── Inter-CLI messaging (name registry + delivery queue wiring) ─────────────
const messaging = useAgentMessaging()

// messagingNames survive restart via localStorage (pane records in project.json
// are backend-owned). Keyed by pane id — project.json stores the live pane id,
// so a restored pane finds its old name under saved.pane_id and re-keys it.
const MESSAGING_NAMES_KEY = 'agentTeam.messagingNames'
const MESSAGING_NAMES_CAP = 200

function loadMessagingNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MESSAGING_NAMES_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function saveMessagingNames(map: Record<string, string>): void {
  const keys = Object.keys(map)
  if (keys.length > MESSAGING_NAMES_CAP) {
    for (const k of keys.slice(0, keys.length - MESSAGING_NAMES_CAP)) delete map[k]
  }
  try { localStorage.setItem(MESSAGING_NAMES_KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

function persistMessagingName(paneId: string, name: string): void {
  const map = loadMessagingNames()
  map[paneId] = name
  saveMessagingNames(map)
}

function persistedMessagingName(paneId: string): string | undefined {
  return loadMessagingNames()[paneId]
}

function dropPersistedMessagingName(paneId: string): void {
  const map = loadMessagingNames()
  if (paneId in map) {
    delete map[paneId]
    saveMessagingNames(map)
  }
}

/** Register a CLI pane in the messaging name registry (no-op for plain
 *  terminals). preferredName: persisted name on restore; falls back to the
 *  pipeline slot label, then to the `<agentKey>-<n>` default. */
function registerPaneMessaging(pane: ActivePane, preferredName?: string): void {
  if (pane.agentKey === 'terminal') return
  // The handle IS the pane's displayed name: persisted (restore) → your title
  // (customName) → auto-title → pipeline slot label → the vendor label. A
  // duplicate gets a `-N` suffix, which shows in the title too — so there is
  // only ever ONE name per pane, no separate address to track.
  const preferred =
    preferredName || pane.customName || pane.autoName || pane.slotLabel || pane.agentLabel
  pane.messagingName = messaging.registerPane(pane.id, pane.agentKey, preferred)
  persistMessagingName(pane.id, pane.messagingName)
  mirrorMessagingHandle(pane)
}

/** Tell the registry whether a pane can take work right now, so cli_list_targets
 *  can report it. Derived from the same judgement that gates delivery, so "busy"
 *  always means "a message sent now would wait" — a flag that disagreed with
 *  that would be worse than none. Deduped: only changes cross the wire. */
const paneBusyReported = new Map<string, boolean>()
function reportPaneBusy(paneId: string, busy: boolean): void {
  if (paneBusyReported.get(paneId) === busy) return
  paneBusyReported.set(paneId, busy)
  backend
    .send('agent_msg.set_busy', { pane_id: paneId, busy })
    .catch(() => { /* advisory only */ })
}

/** Re-derive every registered pane's busy state. Polled rather than driven off
 *  turn events: idleness also depends on elapsed silence, which no event
 *  announces. */
function syncPaneBusy(): void {
  for (const pane of panes.value) {
    if (!pane.messagingName) continue
    reportPaneBusy(pane.id, !isPaneIdleForMessaging(pane.id))
  }
}

/** Mirror a pane's handle into the backend registry, which is the only place
 *  that sees every workspace at once — that is what makes `<folder>/<pane>`
 *  addressable from another workspace window. Fire-and-forget: if it fails, only
 *  cross-workspace addressing is lost, never local messaging. */
function mirrorMessagingHandle(pane: ActivePane): void {
  if (!pane.messagingName || !pane.workspacePath) return
  backend
    .send('agent_msg.register', {
      pane_id: pane.id,
      name: pane.messagingName,
      workspace_path: pane.workspacePath,
      agent_key: pane.agentKey,
      // A cold-restore placeholder is mirrored on purpose (see the register
      // call in restoreWorkspacePanes) so it stays addressable, but it has no
      // CLI yet. Without this the registry can only see the busy flag, which
      // every placeholder sets, and the network view calls it "Running".
      realized: pane.realized === true,
      // Re-sent on every mirror (rename, reconnect), not only the first: the
      // backend forgets a pane whose window stayed away too long, and with it
      // the aliases that pane owned.
      former_pane_ids: pane.formerPaneIds ?? [],
    })
    .catch(() => { /* local messaging is unaffected */ })
}

/** keepPersisted: pane handed off to another window (detach) — it re-registers
 *  there under the same persisted name. */
function unregisterPaneMessaging(paneId: string, opts: { keepPersisted?: boolean } = {}): void {
  messaging.unregisterPane(paneId)
  paneBusyReported.delete(paneId)
  pushReadyPanes.delete(paneId)
  pushCooldownUntil.delete(paneId)
  backend.send('agent_msg.unregister', { pane_id: paneId }).catch(() => { /* best effort */ })
  if (!opts.keepPersisted) dropPersistedMessagingName(paneId)
}

/** deliver() dep: inject the envelope via the same primitive as all other pane
 *  injections (bracketed paste + verified submit), then push the target's
 *  stage-watcher scan window past the injected text so sentinel/analyzer
 *  scanning never reads the envelope as the pane's own output (mirrors the
 *  handoff advance in onStageSlotCompleted). */
async function deliverAgentMessage(paneId: string, text: string): Promise<boolean> {
  const ok = await injectPane(paneId, text, 'agent-msg', true)
  if (!ok) return false
  await sleep(1500)
  const sw = watchers.get(paneId)
  if (sw && !sw.cancelled) {
    const len = ((paneRefs[paneId]?.cleanBuffer as unknown as string) || '').length
    if (len > sw.scanFrom) sw.scanFrom = len
    sw.lastAnalyzedBufferLen = len
  }
  return true
}

/** How long after the last keystroke a pane still counts as being typed at.
 *
 *  An injection is a paste plus Enter, so it submits whatever the composer
 *  holds — including a line the user is still writing. `hasDraft` covers a
 *  line with text in it; this covers the gaps around it, where the composer is
 *  momentarily empty but the person is plainly still there (they just cleared
 *  it, or are pausing between words). Long enough to bridge a normal typing
 *  pause, short enough that a pane someone glanced at is not parked. */
const TYPING_HOLD_MS = 4000

/** idleHoldKey() dep: why a message cannot be injected into this pane right
 *  now, as an i18n key suffix under `msg.hold-*`, or null when it can be.
 *  Gate: PTY alive and past startup, nobody typing into it, not mid role/kickoff
 *  injection, latest CLI signal is "turn ended" (not agent_active), and no
 *  activity in the last 2s.
 *
 *  isPaneIdleForMessaging() is derived from this rather than duplicating it, so
 *  the reason shown in the Messages panel cannot drift from the real gate. */
function messagingHoldKey(
  paneId: string,
  opts: { ignoreTyping?: boolean } = {},
): string | null {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return 'gone'
  const status = paneRefs[paneId]?.displayStatus as string | undefined
  // A question passes deliberately. Those panes were already reaching this gate
  // as 'idle' (a turn ending on a question, or an AskUserQuestion box the badge
  // used to show as running-then-idle), so holding them back would newly park
  // them out of inter-CLI dispatch — a behaviour change the state was never
  // meant to make. A permission prompt stays out: it was already excluded.
  //
  // The badge merged the two into 'awaiting', so the split is read from
  // awaitingKind instead. This gate is exactly why that accessor exists —
  // do not simplify it back to the badge value.
  const awaitingKind = paneRefs[paneId]?.awaitingKind as string | null | undefined
  const parkedOnQuestion = status === 'awaiting' && awaitingKind === 'question'
  if (status !== 'running' && status !== 'idle' && !parkedOnQuestion) return 'not-ready'
  if (pane.injectionStatus === 'scheduled' || pane.kickoffStatus === 'pending') return 'starting'
  const now = Date.now()
  // Ahead of the CLI-side reasons on purpose: those describe what the agent is
  // doing, this one describes the person at the keyboard, and a half-typed line
  // is lost the same way whether the agent is mid-turn or idle.
  // `ignoreTyping` is for a push channel whose text never reaches the composer:
  // there is no Enter to submit a half-written line with, so the person at the
  // keyboard has nothing to lose by a message arriving now.
  if (!opts.ignoreTyping) {
    const typist = paneRefs[paneId]
    const hasDraft = typist?.hasDraft as boolean | undefined
    const lastKey = (typist?.lastUserKeyAt as number | undefined) ?? 0
    if (hasDraft || (lastKey > 0 && now - lastKey < TYPING_HOLD_MS)) return 'typing'
  }
  const lastActive = paneLastActiveAt.get(paneId) ?? 0
  const inFlight = isTurnInFlight(lastActive, paneTurnCompleteAt.get(paneId) ?? 0, now, {
    inferEndFromSilence: VENDORS_WITHOUT_TURN_END.has(pane.agentKey),
  })
  if (inFlight) return 'mid-turn'
  if (now - lastActive < 2000) return 'settling'
  return null
}

/** Whether this pane reports itself busy to the backend registry, and whether
 *  an unsolicited injection may be typed into it. See messagingHoldKey() for
 *  the gate itself. Deliberately NOT the delivery gate — see deliveryHoldKey.
 */
function isPaneIdleForMessaging(paneId: string): boolean {
  return messagingHoldKey(paneId) === null
}

/** The gate a *message* passes, which is messagingHoldKey() minus the two
 *  turn-boundary holds for a CLI that queues input mid-turn.
 *
 *  Kept apart from messagingHoldKey() because that answer has two other
 *  consumers who need the unexempted one: the busy state mirrored into the
 *  backend registry (a mid-turn pane is busy, whatever it will accept — that is
 *  what cli_wait_idle and cli_list_targets report), and the continue button
 *  (which types into the composer, so it must never land mid-turn).
 *
 *  `typing` is never lifted here: it protects the person at the keyboard, and a
 *  half-written line is lost the same way whatever the CLI does with queued
 *  input. */
function deliveryHoldKey(paneId: string, opts: { ignoreTyping?: boolean } = {}): string | null {
  const key = messagingHoldKey(paneId, opts)
  if (key !== 'mid-turn' && key !== 'settling') return key
  const agentKey = panes.value.find((p) => p.id === paneId)?.agentKey
  const spec = agentSpecs.find((s) => s.agentKey === agentKey)
  return spec?.acceptsMidTurnInput === true ? null : key
}

/** Panes whose CLI currently has a push channel, by the backend's kind label.
 *  Announced by the backend because only it knows whether a channel is really
 *  there: a spawn can fail to wire one, and a hook channel exists only while
 *  the CLI has a waiter parked. */
const pushReadyPanes = new Map<string, string>()
const pushCooldownUntil = new Map<string, number>()

/** pushTarget() dep: the channel that could take a message for this pane right
 *  now, or null. Applies the gates that channel still answers to — every
 *  CLI-side one, and the typing hold only for a channel that writes the
 *  composer — so the composable can treat a non-null answer as "go". */
function pushTargetForMessaging(paneId: string): { kind: string } | null {
  const kind = pushReadyPanes.get(paneId)
  if (!kind) return null
  const pane = panes.value.find((p) => p.id === paneId)
  const channel = pane
    ? agentSpecs.find((s) => s.agentKey === pane.agentKey)?.pushChannel
    : undefined
  if (!channel) return null
  if ((pushCooldownUntil.get(paneId) ?? 0) > Date.now()) return null
  // messagingHoldKey, not deliveryHoldKey: a push channel is not the typed
  // path and does not inherit its mid-turn exemption. claude's rewake hook is
  // the idle half of Stop-hook delivery — mid-turn belongs to the Stop hook,
  // which fires at the turn boundary anyway. Handing an envelope to a waiter
  // parked for some other event would mark it delivered to a CLI that never
  // acted on it; a mid-turn message is typed in instead.
  if (messagingHoldKey(paneId, { ignoreTyping: !channel.holdsInputBox }) !== null) return null
  return { kind }
}

/** pushDeliver() dep: hand the envelope to the backend, which owns every push
 *  transport. A refusal is not a failed message — the composable still gets it
 *  out, by typing — so it only costs this pane a cooldown.
 *
 *  `unclear` is the backend saying the CLI may still be holding our text: the
 *  message must go back in the queue rather than be typed in on top of itself.
 */
async function pushDeliverAgentMessage(paneId: string, text: string): Promise<PushOutcome> {
  let reason = 'push-request-failed'
  let unclear = false
  try {
    const resp = await backend.send<{ ok?: boolean; reason?: string; unclear?: boolean }>(
      'agent_msg.push',
      { pane_id: paneId, text },
    )
    if (resp.ok && resp.payload?.ok) return 'landed'
    reason = resp.payload?.reason || resp.error?.message || reason
    unclear = !!resp.payload?.unclear
  } catch {
    /* the backend never answered — treat it as an ordinary refusal */
  }
  pushCooldownUntil.set(paneId, Date.now() + pushCooldownMs(reason))
  return unclear ? 'unclear' : 'declined'
}

// Per-pane timestamp of the last turn_complete whose text was scanned for MSG
// blocks — the hook and the watcher can deliver the same turn twice.
const paneMsgProcessedAt = new Map<string, number>()

/** Close out the report a spawned pane owes its parent, on the first turn that
 *  ends after its task went in.
 *
 *  cli_open_agent tells the caller the new pane will report back. Nothing
 *  enforced that: the report is the child's own output, so a missed marker made
 *  it vanish and left the parent waiting on something that would never arrive.
 *  One turn, one outcome — the child's own report if it addressed the parent,
 *  otherwise that turn's output forwarded under a fallback label. Either way
 *  the debt is settled once and never fires again, so a child that keeps
 *  working cannot turn into a stream of reports.
 */
function settleSpawnReport(
  paneId: string,
  senderName: string,
  text: string,
  parsed: ParsedAgentMessage[],
): void {
  const pane = panes.value.find((p) => p.id === paneId)
  const parentName = pane?.spawnedByName
  if (!pane?.spawnReportPending || !parentName) return
  pane.spawnReportPending = false
  // It reported itself — nothing to stand in for. Broadcasts count: the parent
  // is one of the panes a broadcast reaches.
  if (parsed.some((m) => isBroadcastTarget(m.target) || m.target === parentName)) return
  // The parent may have closed while the child worked; there is nowhere to send
  // and no failure worth reporting to a pane that did not ask for this.
  if (!panes.value.some((p) => p.messagingName === parentName)) return
  const report = renderFallbackReport(text)
  if (!report) return
  messaging.sendMessage(senderName, parentName, report, { kind: 'fallback' })
}

function onTurnCompleteForMessaging(paneId: string, text: string, timestamp: string): void {
  const senderName = panes.value.find((p) => p.id === paneId)?.messagingName
  if (senderName && text && !isReplayedTurnComplete(timestamp, Date.now(), TURN_TEXT_REPLAY_TOLERANCE_MS)) {
    const eventMs = Date.parse(timestamp)
    const fresh = Number.isNaN(eventMs) || eventMs > (paneMsgProcessedAt.get(paneId) ?? 0)
    if (fresh) {
      if (!Number.isNaN(eventMs)) paneMsgProcessedAt.set(paneId, eventMs)
      const parsed = parseMessages(text)
      // A turn that opened a block and produced none is the protocol's one
      // invisible failure: nothing queued, so no log row and no failure notice
      // would otherwise exist. Told to the writing pane, which is the only one
      // that knows what it meant to send. Injected text is excluded — a reader
      // echoing our own notice back must not answer itself.
      if (parsed.length === 0 && !isInjectedMessageText(text) && hasUnparsedMessageAttempt(text)) {
        messaging.sendMessage(NOTICE_SENDER, senderName, renderFormatNotice(), { kind: 'notice' })
      }
      for (const msg of parsed) {
        // `replyTo` is the correlation id this agent echoed back from the
        // envelope it is answering; absent for a message that starts a thread.
        if (isBroadcastTarget(msg.target)) {
          // `all` means the sender's own workspace. The menu stops offering
          // the keyword once a window holds more than one, but the bare-line
          // protocol is typed by the agent and cannot be gated that way — so
          // the scope is applied here, where the sender's workspace is known.
          const from = panes.value.find((pn) => pn.id === paneId)?.workspacePath ?? ''
          messaging.sendBroadcast(senderName, msg.content, {
            replyTo: msg.replyTo,
            only: (targetPaneId) => {
              if (!from) return true
              const to = panes.value.find((pn) => pn.id === targetPaneId)?.workspacePath ?? ''
              return !to || normWs(to) === normWs(from)
            },
          })
        } else {
          messaging.sendMessage(senderName, msg.target, msg.content, { replyTo: msg.replyTo })
        }
      }
      settleSpawnReport(paneId, senderName, text, parsed)
      // Same turn-complete path handles SPAWN blocks (freshness-deduped above,
      // so a turn replayed by both the hook and the watcher spawns only once).
      // Caught rather than left to `void`: every outcome inside is reported to
      // the requester as a notice, so a rejection escaping to the window would
      // be the one path that says nothing at all — and it would do it as an
      // unhandled rejection.
      void handleSpawnRequestsForTurn(paneId, senderName, text).catch((err) => {
        recordDiagnostic({
          level: 'error',
          code: 'spawn.turn-failed',
          message: err instanceof Error ? err.message : String(err),
          paneId,
        })
      })
    }
  }
  // A turn ending is exactly when this pane's queue can flush.
  messaging.pump()
}

// ── Agent-initiated pane spawning (SPAWN blocks) ────────────────────────────
/** Feedback to the requesting pane, as a system notice: the ordinary messaging
 *  queue (idle gate, delivery log, Navide's own rate-limit pair) carrying text
 *  that is injected verbatim. Identical treatment to a delivery-failure notice,
 *  and for the same reason — an envelope would announce a sender named Navide
 *  and ask for a reply to a handle nothing can address. */
function sendSpawnFeedback(
  parentName: string,
  outcome: 'failed' | 'partial',
  detail: string,
): void {
  messaging.sendMessage(NOTICE_SENDER, parentName, renderSpawnNotice(outcome, detail), {
    kind: 'notice',
  })
}

async function handleSpawnRequestsForTurn(
  parentPaneId: string,
  parentName: string,
  text: string,
): Promise<void> {
  const requests = parseSpawns(text)
  if (requests.length === 0) return
  const parent = panes.value.find((p) => p.id === parentPaneId)
  if (!parent) return
  const results = evaluateTurnSpawns(requests, spawnGateContextFor(parentPaneId))
  for (const result of results) {
    if (!result.ok) {
      sendSpawnFeedback(parentName, 'failed', result.reason)
      continue
    }
    for (const advisory of result.advisories ?? []) {
      recordDiagnostic({ level: 'warn', code: 'spawn.advisory', message: advisory, paneId: parentPaneId })
    }
    // `failed` and `partial` ask for opposite responses (see renderSpawnNotice),
    // so which one this is matters: reporting a pane that exists as `failed`
    // invites the same request again, and the retry collides with the pane
    // sitting right there.
    const spawned = await spawnRequestedPane(parent, parentName, result)
    if (spawned.outcome === 'failed') {
      sendSpawnFeedback(parentName, 'failed', `pane「${result.name}」啟動失敗`)
    } else if (spawned.outcome === 'partial' && spawned.error) {
      sendSpawnFeedback(
        parentName,
        'partial',
        `pane「${spawned.name}」已開啟，但任務注入出錯：${spawned.error}`,
      )
    } else if (spawned.outcome === 'partial') {
      sendSpawnFeedback(
        parentName,
        'partial',
        `pane「${spawned.name}」已開啟，但任務注入失敗，請自行確認`,
      )
    }
  }
}

/** Create the pane a spawn request asked for, and return its id once it exists
 *  and holds its messaging handle. Split from the kickoff because this part is
 *  quick and settles the pane's real identity, while the kickoff waits on the
 *  CLI to boot — a caller that needs to be told what it got should be told
 *  here, not tens of seconds later. */
async function createRequestedPane(
  parent: ActivePane,
  req: { agentKey: string; name: string },
): Promise<string | null> {
  const paneId = await spawnPane({
    agentKey: req.agentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    customName: req.name,
    commandOverride: '',
    workspacePath: parent.workspacePath,
    origin: 'mcp',
    runGroupId: parent.runGroupId,
    preferredMessagingName: req.name,
    spawnedBy: parent.id,
  })
  if (!paneId) return null
  // Persistence only — the pane is already usable, and both responses are
  // ignored. Awaiting them would put two 10s deadlines between the caller and
  // an answer it needs promptly.
  void sendQuiet<ProjectPayload>('manual_pane.spawn', {
    workspace_path: parent.workspacePath,
    pane_id: paneId,
    agent: req.agentKey,
    role: '',
    command: '',
    session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
    session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
    run_group_id: parent.runGroupId ?? '',
    output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    origin: 'mcp',
    spawned_by: parent.id,
  })
  void sendQuiet('project.rename_pane', {
    workspace_path: parent.workspacePath,
    pane_id: paneId,
    custom_name: req.name,
  })
  // spawnPane returns the id even when terminal.create failed — the pane object
  // is in the list either way, with no PTY behind it. Report that as a failure
  // rather than handing back a pane whose CLI never started.
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || pane.preparationStatus === 'failed') return null
  return paneId
}

/** Wires App.vue's pane-settling primitives into injectStandaloneTask's
 *  injectable-dependency shape. Shared by createStandaloneRequestedPane and
 *  ui.pane.create — the two standalone (no report-back parent) spawn paths
 *  that create a roleless manual pane and must inject its task themselves. */
function standaloneTaskDeps(): StandaloneTaskInjectionDeps {
  return {
    selectPane: (id, opts) => selectPane(id, opts),
    sendSessionMarkerBootstrap: (id, tag) => {
      const pane = panes.value.find((p) => p.id === id)
      return pane ? sendSessionMarkerBootstrap(pane, tag) : Promise.resolve(false)
    },
    dismissStartupDialog: (id) => dismissStartupDialog(id, DISMISS_TIMEOUT_MS),
    waitForStartupActivity: (id) => waitForStartupActivity(id),
    waitForQuiet: (id, quietMs, timeoutMs) => waitForQuiet(id, quietMs, timeoutMs),
    paneAlive: (id) => paneAlive(id),
    injectPane: (id, text, label, preserveNewlines) => injectPane(id, text, label, preserveNewlines),
    onKill: (id) => onKill(id),
  }
}

/** Standalone counterpart to createRequestedPane for an external MCP spawn
 *  request addressed by target_workspace instead of a requesting pane (no
 *  report-back parent). Mirrors ui.pane.create's independent-pane path: the
 *  pane is created roleless, then the task is injected directly via
 *  injectStandaloneTask — scheduleInjection early-returns for a roleless
 *  pane before its kickoff step, so a kickoffPrompt handed to spawnPane here
 *  would never actually be injected. */
async function createStandaloneRequestedPane(
  workspacePath: string,
  req: { agentKey: string; name: string; task: string },
): Promise<string | null> {
  const runGroupId = resolveManualSpawnGroupId(runGroups.value, activeTab.value)
  const paneId = await spawnPane({
    agentKey: req.agentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    customName: req.name,
    commandOverride: '',
    workspacePath,
    origin: 'mcp',
    runGroupId: runGroupId || undefined,
    preferredMessagingName: req.name,
  })
  if (!paneId) return null
  void sendQuiet<ProjectPayload>('manual_pane.spawn', {
    workspace_path: workspacePath,
    pane_id: paneId,
    agent: req.agentKey,
    role: '',
    command: '',
    session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
    session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
    run_group_id: runGroupId,
    output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    origin: 'mcp',
  })
  void sendQuiet('project.rename_pane', {
    workspace_path: workspacePath,
    pane_id: paneId,
    custom_name: req.name,
  })
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || pane.preparationStatus === 'failed') return null
  const injected = await injectStandaloneTask(paneId, req.task, 'mcp-task', standaloneTaskDeps())
  if (!injected) return null
  return paneId
}

/** Gate context for a target_workspace spawn: no requesting pane exists, so
 *  depth/child-count are root-level (0) — only the workspace-wide CLI pane
 *  cap still applies. */
function standaloneSpawnGateContext() {
  return {
    validAgentKeys: agentSpecs.filter((s) => s.agentKey !== 'terminal').map((s) => s.agentKey),
    isNameTaken: (name: string) => messaging.paneIdOf(name) !== null,
    parentDepth: 0,
    parentChildCount: 0,
    cliPaneCount: panes.value.filter((p) => p.agentKey !== 'terminal').length,
  }
}

/** Wait for a freshly created pane's CLI to settle, then inject its task. Slow
 *  by nature: a cold CLI can take tens of seconds to print its first byte. */
async function kickoffRequestedPane(
  paneId: string,
  parentName: string,
  task: string,
): Promise<boolean> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return false
  // The pane's own task has to land before anything else may type into it: a
  // CLI still booting can be sitting on a trust dialog, where an injected
  // message plus its newline would answer the prompt. The messaging idle gate
  // already refuses a pane whose kickoff is pending, so say so until this is
  // done — the caller may already know this pane's name and be messaging it.
  pane.kickoffStatus = 'pending'
  try {
    const bootstrapped = await sendSessionMarkerBootstrap(pane, `[pane ${paneId.slice(0, 8)}]`)
    if (!bootstrapped) {
      await dismissStartupDialog(paneId, DISMISS_TIMEOUT_MS)
      await waitForStartupActivity(paneId)
    }
    await waitForQuiet(paneId, 1000, 8000)
    if (!paneAlive(paneId)) return false
    const kicked = await injectPane(paneId, renderSpawnKickoff(task, parentName), 'agent-spawn', true)
    // Arm the fallback report only once the task is really in: a kickoff that
    // never landed leaves a pane with nothing to report on. `parentName` is
    // only a messaging handle when a live pane answers to it — the MCP path
    // falls back to a pane id, and a standalone caller passes a workspace path,
    // neither of which anything can be delivered to.
    if (kicked && panes.value.some((p) => p.messagingName === parentName)) {
      const live = panes.value.find((p) => p.id === paneId)
      if (live) {
        live.spawnedByName = parentName
        live.spawnReportPending = true
      }
    }
    return kicked
  } finally {
    const live = panes.value.find((p) => p.id === paneId)
    if (live?.kickoffStatus === 'pending') live.kickoffStatus = 'none'
  }
}

/** Spawn + kick off a pane requested by a SPAWN block. Mirrors
 *  dispatchPlanToPane's create path: the kickoff is injected directly because
 *  scheduleInjection never injects a roleless manual pane's kickoffPrompt.
 *
 *  Reports which half failed, not just that something did: once the pane
 *  exists, a kickoff that never lands is `partial` — the same verdict the MCP
 *  spawn path reports — and `name` is the handle the pane actually took, which
 *  a concurrent spawn may have pushed to a suffix.
 *
 *  A kickoff that THROWS is the same verdict as one that returns false: the
 *  pane is open either way. kickoffRequestedPane runs a long chain of awaits
 *  (bootstrap, dialog dismissal, quiet wait, injection) with only a `finally`
 *  of its own, so letting a rejection escape here would leave the requester
 *  with no notice at all — the one outcome that tells it nothing. */
async function spawnRequestedPane(
  parent: ActivePane,
  parentName: string,
  req: { agentKey: string; name: string; task: string },
): Promise<{ outcome: 'ok' | 'failed' | 'partial'; name: string; error?: string }> {
  const paneId = await createRequestedPane(parent, req)
  if (!paneId) return { outcome: 'failed', name: req.name }
  const pane = panes.value.find((p) => p.id === paneId)
  const childName = pane?.messagingName ?? req.name
  notifyRestore.toast(
    i18n.global.t('msg.spawn-toast', { parent: parentName, child: childName }),
  )
  try {
    const kicked = await kickoffRequestedPane(paneId, parentName, req.task)
    return { outcome: kicked ? 'ok' : 'partial', name: childName }
  } catch (err) {
    return {
      outcome: 'partial',
      name: childName,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The spawn-gate context for a pane in this window. Shared by the SPAWN block
 *  path and the cli_open_agent MCP tool so both are held to the same limits. */
function spawnGateContextFor(parentPaneId: string) {
  return {
    validAgentKeys: agentSpecs.filter((s) => s.agentKey !== 'terminal').map((s) => s.agentKey),
    isNameTaken: (name: string) => messaging.paneIdOf(name) !== null,
    parentDepth: computeSpawnDepth(
      parentPaneId,
      (id) => panes.value.find((p) => p.id === id)?.spawnedBy ?? null,
    ),
    parentChildCount: panes.value.filter((p) => p.spawnedBy === parentPaneId).length,
    cliPaneCount: panes.value.filter((p) => p.agentKey !== 'terminal').length,
  }
}

/** cli_open_agent asked this window to open a pane. Ownership is normally by
 *  requesting pane (only the window owning it answers); an external caller
 *  with no requesting pane instead sends target_workspace, and ownership is
 *  by open workspace — mirrors handleUiInvokeRequest's ownership check. The
 *  gate runs here because only this window knows the pane counts, chain depth
 *  and name collisions it needs. */
async function handleMcpSpawnRequest(ev: {
  request_id: string
  requester_pane_id: string
  agent_key: string
  name: string
  task: string
  target_workspace?: string
}): Promise<void> {
  const standalone = !!ev.target_workspace
  let parent: ActivePane | undefined
  let parentName: string
  if (standalone) {
    // Any workspace this window holds. Exactly one window holds a given
    // workspace — findMainWindowForWorkspace covers adopted ones now, so a
    // second window is sent to this one rather than opening it too — which is
    // what keeps this from being answered twice.
    if (!isLocalWorkspace(ev.target_workspace ?? '')) return // not ours — another window will answer
    parentName = ev.target_workspace as string
  } else {
    parent = panes.value.find((p) => p.id === ev.requester_pane_id)
    if (!parent) return // not our pane — another window will answer
    parentName = parent.messagingName ?? ev.requester_pane_id
  }

  const report = (verdict: {
    ok: boolean
    error?: string
    paneId?: string
    name?: string
    advisories?: string[]
  }): void => {
    const payload: Record<string, unknown> = {
      request_id: ev.request_id,
      ok: verdict.ok,
      error: verdict.error ?? '',
      pane_id: verdict.paneId ?? '',
      name: verdict.name ?? '',
    }
    // Only present when the gate actually raised a note — the tool's return
    // dict should not gain an empty `advisories: []` key on every ordinary
    // spawn (cli_open_agent's docstring documents "present only when non-empty").
    if (verdict.advisories && verdict.advisories.length > 0) payload.advisories = verdict.advisories
    backend
      .send('agent_spawn.result', payload)
      .catch(() => { /* the tool call times out and says so */ })
  }

  const gate = evaluateSpawnRequest(
    { agent: ev.agent_key, name: ev.name, task: ev.task },
    parent ? spawnGateContextFor(parent.id) : standaloneSpawnGateContext(),
  )
  if (!gate.ok) {
    report({
      ok: false,
      error: parent ? describeSpawnRefusal(gate.reason, ev.name, ev.requester_pane_id) : gate.reason,
    })
    return
  }
  for (const advisory of gate.advisories ?? []) {
    recordDiagnostic({
      level: 'warn',
      code: 'spawn.advisory',
      message: advisory,
      paneId: parent ? parent.id : undefined,
    })
  }
  let paneId: string | null = null
  try {
    paneId = parent
      ? await createRequestedPane(parent, gate)
      : await createStandaloneRequestedPane(ev.target_workspace as string, gate)
  } catch (err) {
    report({ ok: false, error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!paneId) {
    report({ ok: false, error: `pane「${gate.name}」建立失敗` })
    return
  }
  // The pane exists and owns its handle, so answer now with its real identity
  // rather than the requested name — a concurrent spawn may have taken that
  // name and pushed this one to a suffix. Booting the CLI and injecting the
  // task takes far longer and would blow the caller's deadline, so it runs on
  // after this and reports a failure by message instead.
  const child = panes.value.find((p) => p.id === paneId)
  const childName = child?.messagingName ?? gate.name
  if (!parent) {
    // Standalone spawn: createStandaloneRequestedPane already settled the CLI
    // and injected the task (or left the pane empty if there was none) before
    // returning paneId above. There is no parent pane to report back to, so
    // no kickoffRequestedPane / report-back marker either.
    report({ ok: true, paneId, name: childName, advisories: gate.advisories })
    return
  }
  // Shut the injection window before the caller learns this pane's name, not
  // after: the moment it knows, it may message it, and the pane has not had its
  // own task yet.
  if (child) child.kickoffStatus = 'pending'
  notifyRestore.toast(i18n.global.t('msg.spawn-toast', { parent: parentName, child: childName }))
  report({ ok: true, paneId, name: childName, advisories: gate.advisories })

  void kickoffRequestedPane(paneId, parentName, gate.task)
    .then((ok) => {
      if (!ok) {
        sendSpawnFeedback(parentName, 'partial', `pane「${childName}」已開啟，但任務注入失敗，請自行確認`)
      }
    })
    .catch((err) => {
      sendSpawnFeedback(
        parentName,
        'partial',
        `pane「${childName}」已開啟，但任務注入出錯：${err instanceof Error ? err.message : String(err)}`,
      )
    })
}

/** Make a gate refusal actionable. A name collision with a pane the requester
 *  itself spawned almost always means an earlier request succeeded but its
 *  verdict never got back — telling that agent to "pick another name" would
 *  have it open a second pane doing the same work. */
function describeSpawnRefusal(reason: string, requestedName: string, requesterPaneId: string): string {
  // Only rewrite an actual name collision. The gate checks the agent key first,
  // so a bad key on a retry would otherwise be reported as "you already have
  // that pane" and the real mistake would never surface.
  if (!reason.includes('已被其他 pane 使用')) return reason
  const holder = messaging.paneIdOf(requestedName)
  if (!holder) return reason
  const pane = panes.value.find((p) => p.id === holder)
  if (pane?.spawnedBy !== requesterPaneId) return reason
  return `你已經開了一個叫「${requestedName}」的 pane，它正在執行中 — 不需要重開`
}

/** Resolve a manual handle rename against collisions. Returns the handle to
 *  apply (free / this pane's own), or null when the user cancels. On collision
 *  with ANOTHER pane it opens a prompt pre-filled with a unique suggestion the
 *  user can accept or edit; cancel abandons the rename. Empty input → null. */
async function resolveManualHandle(paneId: string, desired: string): Promise<string | null> {
  const norm = desired.trim()
  if (!norm) return null
  const owner = messaging.paneIdOf(norm)
  if (owner === null || owner === paneId) return norm // free, or already ours
  const answer = await notifyRestore.prompt(
    i18n.global.t('msg.rename-collision-body', { name: norm }),
    {
      title: i18n.global.t('msg.rename-collision-title'),
      defaultValue: messaging.suggestName(norm),
      confirmText: i18n.global.t('msg.rename-collision-confirm'),
      cancelText: i18n.global.t('msg.rename-collision-cancel'),
    },
  )
  if (answer === null) return null // cancelled → abandon
  return resolveManualHandle(paneId, answer) // re-validate the entered name
}

/** routeRemote() dep: a `<folder>/<pane>` target no pane in THIS window answers
 *  to. The backend registry resolves it across every open workspace window and
 *  broadcasts the delivery; this window only learns the outcome later, via the
 *  agent_msg.delivery_result event. */
async function routeRemoteMessage(args: {
  fromPaneId: string
  fromName: string
  to: string
  content: string
  msgKey: string
  replyTo?: string
}): Promise<RouteResult> {
  const resp = await backend.send<{
    ok?: boolean
    error?: string
    code?: string
    params?: Record<string, string>
    target_display?: string
    target_workspace_path?: string
    target_agent_key?: string
  }>(
    'agent_msg.route',
    {
      from_pane_id: args.fromPaneId,
      from_name: args.fromName,
      to: args.to,
      content: args.content,
      msg_key: args.msgKey,
      // Only for a reply: the backend passes it through to the deliver event so
      // the window that handed out the id can link the two rows.
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    },
    // Generous: the handler broadcasts the delivery BEFORE it replies, so a
    // timeout here would report failure for a message the target already got.
    30_000,
  )
  const p = resp.payload
  if (!resp.ok || !p?.ok) {
    // Backend code first (localizable), then whatever text we got (a transport
    // failure has no code), and only then a generic "it didn't route".
    const text = p?.error || resp.error?.message
    return {
      ok: false,
      error: text,
      errorCode: p?.code || (text ? undefined : 'route-unavailable'),
      errorParams: p?.params,
    }
  }
  return {
    ok: true,
    targetDisplay: p.target_display,
    targetWorkspacePath: p.target_workspace_path,
    targetAgentKey: p.target_agent_key,
  }
}

// ── Message-log persistence (agent_msg.log_*) ──────────────────────────────
// Batching, serialization and the connect-time retry live in the composable.
const msgLog = createMessageLogPersistence({
  send: sendQuiet,
  isConnected: () => backend.status.value === 'connected',
  hydrate: (rows) => messaging.hydrateLog(rows),
})
// A cold-start snapshot can time out before the backend even accepts the socket,
// which used to leave the persisted log unloaded for the whole session. Retry on
// the connected transition, exactly as the settings cache reconciles.
watch(
  () => backend.status.value,
  (s) => { if (s === 'connected') msgLog.onConnected() }
)

let _msgPumpTimer = 0
let _remoteTargetsTimer = 0
onMounted(() => {
  messaging.configureMessaging({
    now: () => Date.now(),
    deliver: deliverAgentMessage,
    isPaneIdle: (paneId: string) => deliveryHoldKey(paneId) === null,
    idleHoldKey: deliveryHoldKey,
    pushTarget: pushTargetForMessaging,
    pushDeliver: pushDeliverAgentMessage,
    routeRemote: routeRemoteMessage,
    reportDelivery: (msgKey, ok, reason) => {
      backend
        .send('agent_msg.delivered', {
          msg_key: msgKey,
          ok,
          // The wire field is text; the sending window decodes it back.
          reason: reason ? encodeReason(reason) : '',
        })
        .catch(() => { /* the sender's log entry just stays queued */ })
    },
    // Not caught here: a rejection is how the composable learns the request
    // never left, and puts the row back to plain waiting.
    requestRemoteCancel: (msgKey) => backend.send('agent_msg.cancel', { msg_key: msgKey }),
    reportHold: (msgKey, hold) => {
      backend
        .send('agent_msg.hold_update', { msg_key: msgKey, hold: hold ?? null })
        .catch(() => { /* an MCP caller just sees the message as queued */ })
    },
    persistAppend: msgLog.persistAppend,
    persistUpdate: msgLog.persistUpdate,
    persistClear: msgLog.persistClear,
  })
  void msgLog.hydrate()
  void previewLog.refresh()
  // pollAwaitingPanes runs BEFORE syncPaneBusy: it can flip a pane to AWAITING,
  // and the busy report that follows must carry that same tick's status.
  _msgPumpTimer = window.setInterval(() => {
    messaging.pump()
    pollAwaitingPanes()
    syncPaneBusy()
  }, 1000)
  void refreshRemoteMessagingTargets()
  _remoteTargetsTimer = window.setInterval(() => void refreshRemoteMessagingTargets(), 10_000)
  window.addEventListener('beforeunload', msgLog.flushOnExit)
  // A hard teardown (⌘R's `role: 'reload'`, app quit) never runs a pane's
  // onScopeDispose, so this is the last chance to catch the ≤60s of scrollback
  // the panes' own periodic save has not written yet. Like flushOnExit it
  // cannot await, so it only stores what xterm has already parsed — the
  // periodic save is what makes the snapshot faithful.
  window.addEventListener('beforeunload', saveAllScrollSnapshots)
})
onUnmounted(() => {
  window.clearInterval(_msgPumpTimer)
  window.clearInterval(_remoteTargetsTimer)
  window.removeEventListener('beforeunload', msgLog.flushOnExit)
  window.removeEventListener('beforeunload', saveAllScrollSnapshots)
  void msgLog.flush()
})

// ── AWAITING watcher (vendors with no notification hook) ────────────────────
// Claude reports "parked on the user" out of band, through its Notification
// hook. Every other CLI only shows it on screen, so the prompt is recognized
// from the pane's RENDERED text: a TUI repaints its box in place, so an
// answered prompt stops matching on its own, while the raw clean buffer would
// keep every frame it ever painted and match forever.
//
// Polled rather than checked inside useTerminal's appendClean, which runs once
// per PTY chunk (macOS splits a read at 1KB — ~20 chunks per keystroke); a
// regex there would dominate the output path. Unlike the login-expired watcher
// this consumes nothing it matched: the prompt is a STATE, re-asserted every
// tick while it is on screen and cleared the moment it is not. Panes whose
// vendor has no pattern are skipped entirely.
//
// Clearing is per vendor (awaitingClearsOnMiss). For a pattern-only vendor the
// match IS the state, so a miss ends it. claude also has a Notification hook
// and its pattern is additive — it catches the AskUserQuestion box the hook
// never reports — so a miss there is not evidence the wait ended and must not
// clear what the hook raised.
const AWAITING_SCREEN_LINES = 25

function pollAwaitingPanes(): void {
  for (const pane of panes.value) {
    if (!pane.realized || !hasAwaitingPattern(pane.agentKey)) continue
    const ref = paneRefs[pane.id]
    if (!ref?.readScreenTail) continue
    // Contained per pane: this shares a tick with messaging.pump and
    // syncPaneBusy, and a throw here would be deterministic (the same pane
    // every second), permanently starving the busy reporting that follows.
    // A badge must never take messaging down with it.
    try {
      const screen = ref.readScreenTail(AWAITING_SCREEN_LINES) as unknown as string
      if (matchAwaitingInput(pane.agentKey, screen)) ref.markNeedsInput?.()
      else if (awaitingClearsOnMiss(pane.agentKey)) ref.clearNeedsInput?.()
    } catch {
      /* leave this pane's badge as-is and carry on with the rest */
    }
  }
}

function syncViews(): void {
  paneViews.value = panes.value.map((p) => {
    const ref = paneRefs[p.id]
    return {
      id: p.id,
      agentKey: p.agentKey,
      agentLabel: p.customName || p.autoName || p.agentLabel,
      autoNamed: paneIsAutoNamed(p),
      roleKey: p.roleKey,
      roleLabel: roleLabel(p.roleKey),
      stageId: p.stageId,
      command: p.command,
      status: p.realized
        ? (ref?.displayStatus as DisplayStatus | undefined) ??
          (ref?.status as DisplayStatus | undefined) ??
          'starting'
        : 'waiting',
      error: ref?.error as string | undefined,
      injectionStatus: p.injectionStatus,
      preparationStatus: p.preparationStatus,
      kickoffStatus: p.kickoffStatus,
      origin: p.origin,
      spawnedBy: p.spawnedBy,
      collapsed: collapsedPanes.value.has(p.id),
      isCommander: paneIsCommander(p),
      sessionId: p.pinnedSessionId,
      slotLabel: p.slotLabel,
      isMinimized: minimizedPanes.value.has(p.id),
      loopActive: p.loopActive,
      loopWaitUntil: p.loopWaitUntil,
      rebuildVisible: p.realized && paneRebuildVisible(p),
      canRebuild: p.realized && paneCanRebuild(p),
      rebuilding: p.realized && paneRebuilding(p)
    }
  })
}

function onPaneFirstOutput(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.restoring) return
  pane.restoring = false
  syncViews()
}

let _syncViewsTimer: number | null = null
onMounted(() => { _syncViewsTimer = window.setInterval(syncViews, 400) })

// Cross-workspace roster: refresh on the events that can change it rather than
// on a timer. Regaining focus is when another window's spawns become worth
// showing; this window's own spawns and kills are handled where they happen.
onUnmounted(() => {
  if (_syncViewsTimer !== null) clearInterval(_syncViewsTimer)
  window.removeEventListener('resize', onWindowResize)
  if (_winResizeTimer !== null) clearTimeout(_winResizeTimer)
})
watch(panes, syncViews, { deep: true, immediate: true })

// Flatten multi-line prompts so they survive any CLI input mode (raw / cooked
// / bracketed-paste-off-during-init). Embedded newlines would otherwise hit
// the agent's Enter handler and submit fragments. We preserve paragraph
// structure with " — " separators so the model still gets visual hints.
function flattenForInjection(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, ' — ')
    .replace(/\n/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim()
}

// Whitespace-stripped form used to match our injected text against the echoed
// input box. The TUI word-wraps and re-indents the echo, so we drop ALL
// whitespace — and its frame characters — on both sides before comparing.
// See lib/injectEcho.ts for why the frame matters.

async function injectText(
  sessionId: string,
  text: string,
  logLabel?: string,
  preserveNewlines = false,
  // Loop callers pass a generation check so a manual cancel / restart aborts an
  // already-running injection mid-flight instead of letting a stray prompt land
  // in the CLI. Returns false on abort (treated as a failed inject).
  shouldAbort?: () => boolean
): Promise<boolean> {
  // Log the full injection text to the session's output log file BEFORE
  // chunking so the log file shows one readable block per send.
  if (logLabel) {
    // fire-and-forget — we don't need to await this for correctness
    backend.send('terminal.log_sent', {
      terminal_session_id: sessionId,
      label: logLabel,
      text
    }).catch(() => {/* ignore */})
  }

  // Resolve sessionId → paneId up front so we can watch the pane's cleaned
  // buffer while injecting. No observable pane (manual pane / no ref) → fall
  // back to a fixed gap and fire once.
  const paneId = Object.keys(paneRefs).find((id) => paneRefs[id]?.sessionId === sessionId)
  const cleanBuf = (): string =>
    paneId ? ((paneRefs[paneId]?.cleanBuffer as unknown as string) ?? '') : ''
  // Growth must come from the monotonic counter, not cleanBuffer.length: the
  // buffer is trimmed once it passes its cap, so a length delta can read as
  // zero — or negative — while output is streaming, which made the echo look
  // absent and resent the whole prompt.
  const cleanBytes = (): number => (paneId ? paneCleanBytes(paneId) : -1)

  // Send in modest chunks to avoid hitting any tty input-buffer limits and to
  // give the CLI's render loop a chance to keep up.
  const CHUNK = 512
  const body = preserveNewlines ? text : flattenForInjection(text)
  // Bracketed paste for every injection the vendor can take it, not just the
  // multi-line ones: it is what makes the write land as a paste the TUI inserts
  // whole, instead of a stream of keypresses interleaved with whatever the user
  // is typing at the same moment. Multi-line text is wrapped regardless — there
  // the guards are what stop embedded newlines from submitting fragments, which
  // is worse than a vendor showing a literal "[200~".
  //
  // The vendor key alone is not enough for the single-line case: it says which
  // CLI the pane was started with, not what is reading the PTY right now. A
  // claude pane dropped into `!` shell mode, fallen back to bash, or sitting on
  // a raw login prompt has mode 2004 off, and a login-fix or nudge written into
  // that would arrive as a literal "[200~". So ask xterm what the program on the
  // other end last declared — the same source pasteFromClipboard trusts.
  const bracketed = preserveNewlines
    || (agentUsesBracketedPaste(panes.value.find((p) => p.id === paneId)?.agentKey)
        && paneId !== undefined
        && paneRefs[paneId]?.isBracketedPasteActive?.() === true)
  const chunks = injectionChunks(body, CHUNK, bracketed)
  const sendChunks = async (): Promise<boolean> => {
    for (let i = 0; i < chunks.length; i++) {
      try {
        await backend.send('terminal.input', {
          terminal_session_id: sessionId,
          data: chunks[i]
        })
      } catch (err) {
        console.error(`[injectText] content send failed at chunk ${i + 1}/${chunks.length}:`, err)
        return false
      }
    }
    return true
  }

  // Tail of OUR text (whitespace-stripped) — the "input box received it" signal.
  const normalized = normalizeForMatch(text)
  const normalizedLen = normalized.length
  const tail = normalized.slice(-TAIL_MATCH_LEN)

  // Send content, then WAIT for the input box to be ready rather than betting on
  // a fixed gap: poll until the tail shows up in the echo (strong) OR the buffer
  // grows appreciably (covers TUIs that collapse a big paste into a placeholder
  // so the tail never echoes verbatim). Neither within the window ⇒ the bytes
  // never landed (e.g. dropped under back-pressure) ⇒ resend the whole content
  // instead of pressing Enter on an empty box.
  const MAX_CONTENT_SENDS = 3
  const readyTimeout = echoTimeoutFor(text.length)
  let ready = false
  for (let send = 1; send <= MAX_CONTENT_SENDS && !ready; send++) {
    if (shouldAbort?.()) return false
    // A previous attempt can land after we gave up waiting — a CLI still
    // painting its startup screen accepts the bytes but echoes them late.
    // Sending again then puts the instruction on screen twice, so look before
    // repeating ourselves.
    if (send > 1 && tail && normalizeForMatch(cleanBuf()).includes(tail)) {
      ready = true
      break
    }
    const preBytes = cleanBytes()
    if (!(await sendChunks())) return false
    if (paneId === undefined || preBytes < 0) {
      // Nothing observable — keep the old fixed-gap fallback and fire once.
      await sleep(Math.min(4_000, Math.max(1_500, Math.floor(text.length / 8))))
      ready = true
      break
    }
    const deadline = Date.now() + readyTimeout
    while (Date.now() < deadline) {
      await sleep(200)
      if (shouldAbort?.()) return false
      const buf = cleanBuf()
      if (echoLanded(buf, tail, cleanBytes() - preBytes, normalizedLen)) {
        ready = true
        break
      }
    }
    if (!ready && send < MAX_CONTENT_SENDS) {
      console.warn(
        `[injectText] content not echoed within ${readyTimeout}ms ` +
        `(send ${send}/${MAX_CONTENT_SENDS}) — resending content`
      )
      recordDiagnostic({
        level: 'warn',
        code: 'inject.resend',
        message: `content not echoed within ${readyTimeout}ms (send ${send}/${MAX_CONTENT_SENDS}) — resending`,
        paneId
      })
    }
  }
  if (!ready) {
    // Content never reached the input box after retries — report honestly so
    // the caller logs a truthful failure instead of a misleading "✓ sent".
    console.error('[injectText] content never appeared in the input box after retries')
    recordDiagnostic({
      level: 'error',
      code: 'inject.failed',
      message: 'content never appeared in the input box after retries',
      paneId
    })
    return false
  }

  // Submit. Baseline captured AFTER the box is ready. What counts as "it went"
  // is judged from the input box rather than from raw output — see
  // submitLanded(): a repainting TUI grows the buffer whether or not Enter took.
  const before = cleanBytes()
  const readScreen = paneId !== undefined
    ? (paneRefs[paneId]?.readScreenTail as ((n: number) => string) | undefined)
    : undefined
  const screenTail = (): string => (readScreen ? readScreen(SUBMIT_SCREEN_LINES) : '')
  // Whether the composer is holding our tail RIGHT NOW decides which signal we
  // can trust below, so sample it before pressing Enter.
  const tailWasOnScreen = !!tail && normalizeForMatch(screenTail()).includes(tail)
  const MAX_SUBMITS = 3
  for (let attempt = 1; attempt <= MAX_SUBMITS; attempt++) {
    if (shouldAbort?.()) return false
    try {
      await backend.send('terminal.input', { terminal_session_id: sessionId, data: '\r' })
    } catch (err) {
      console.error(`[injectText] submit Enter failed (attempt ${attempt}/${MAX_SUBMITS}):`, err)
      return false
    }
    if (paneId === undefined || before < 0) return true
    // Poll instead of one flat sleep: a fast agent clears the composer in a few
    // hundred ms, and waiting the full gap on every attempt costs seconds.
    const deadline = Date.now() + SUBMIT_CONFIRM_MS
    let landed = false
    while (Date.now() < deadline && !landed) {
      await sleep(200)
      if (shouldAbort?.()) return false
      landed = submitLanded({
        tailWasOnScreen,
        tail,
        screen: screenTail(),
        grownBy: cleanBytes() - before
      })
    }
    if (landed) return true
    if (attempt < MAX_SUBMITS) {
      console.warn(
        `[injectText] input box still holds the text ${SUBMIT_CONFIRM_MS}ms after Enter ` +
        `(attempt ${attempt}/${MAX_SUBMITS}) — resending Enter`
      )
    }
  }
  // Content was confirmed in the box and Enter was re-sent 3× but the box never
  // let go of it. Report honestly; the caller still arms the stage watcher.
  console.error('[injectText] text still in the input box after 3 Enters — never submitted')
  return false
}

async function injectPane(
  paneId: string,
  text: string,
  logLabel?: string,
  preserveNewlines = false,
  shouldAbort?: () => boolean
): Promise<boolean> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return false
  const ref = paneRefs[paneId]
  if (!ref?.sessionId) return false
  // Anything reaching the prompt ends the parked-after-resume state the continue
  // button exists for — including this button's own injection.
  pane.resumeContinueAvailable = false
  return injectText(ref.sessionId, text, logLabel, preserveNewlines, shouldAbort)
}

// Text of a pane worth SHARING with another pane / the AI Chat: the rendered
// xterm scrollback, not cleanBuffer. cleanBuffer accumulates the raw PTY stream,
// so for a repainting TUI (Claude/Codex status footer) its tail is fragments of
// the last repainted frames rather than the conversation. Falls back to
// cleanBuffer if the ref predates readRenderedText (defensive: refs can be null).
function readPaneShareText(ref: NonNullable<(typeof paneRefs)[string]>, maxLines: number): string {
  const read = ref.readRenderedText as ((n: number) => string) | undefined
  const rendered = read ? read(maxLines) : ''
  return rendered.trim() ? rendered : ((ref.cleanBuffer as unknown as string) ?? '')
}

// Panes in OTHER workspace windows, as `<folder>/<pane>` addresses. Polled
// rather than pushed: the list only feeds autocomplete, so a slightly stale
// snapshot costs nothing (routing itself always re-resolves in the backend).
const remoteMessagingTargets = ref<string[]>([])
/** paneId → `<folder>/<pane>`, so a pane dragged in from another window can be
 *  turned into an address without a second round trip. */
const remoteTargetByPane = new Map<string, string>()

async function refreshRemoteMessagingTargets(timeoutMs?: number): Promise<void> {
  try {
    const resp = await backend.send<{
      panes?: Array<{ pane_id?: string; qualified_name?: string }>
    }>('agent_msg.list', {}, timeoutMs)
    const localIds = new Set(panes.value.map((p) => p.id))
    const remote = (resp.payload?.panes ?? []).filter(
      (p) => p.pane_id && p.qualified_name && !localIds.has(p.pane_id),
    )
    remoteTargetByPane.clear()
    for (const p of remote) remoteTargetByPane.set(p.pane_id as string, p.qualified_name as string)
    remoteMessagingTargets.value = remote.map((p) => p.qualified_name as string)
  } catch {
    remoteMessagingTargets.value = []
    remoteTargetByPane.clear()
  }
}

/** The cross-workspace address of a pane living in another window. Refreshes
 *  once on a miss — a pane opened since the last poll is the common case.
 *
 *  Bounded on purpose: this sits in front of a drag-and-drop gesture whose
 *  fallback (the buffer relay) runs over IPC and needs no backend at all, so a
 *  reconnecting socket must never hold the gesture for the default 10s deadline. */
async function remoteAddressOf(paneId: string): Promise<string | null> {
  const cached = remoteTargetByPane.get(paneId)
  if (cached) return cached
  if (backend.status.value !== 'connected') return null
  await refreshRemoteMessagingTargets(2_000)
  return remoteTargetByPane.get(paneId) ?? null
}

// Addresses recently completed through the @-mention menu, newest first. Local
// like the messagingNames map above and for the same reason it is not in
// ui_settings: losing it costs an ordering, not a capability, so it is not
// worth a SQLite write and a cross-window broadcast on every mention.
const MENTION_RECENTS_KEY = 'agentTeam.mentionRecents'
const MENTION_RECENTS_CAP = 12

function loadMentionRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(MENTION_RECENTS_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rememberMentionPick(addresses: string[]): void {
  const next = recordMentionRecents(loadMentionRecents(), addresses, MENTION_RECENTS_CAP)
  try { localStorage.setItem(MENTION_RECENTS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
}

// Addresses offered by pane `paneId`'s @-mention autocomplete menu: every OTHER
// pane that has a messaging name (self excluded), then the qualified addresses
// of panes open in other workspace windows, with the recently used hoisted.
//
// The group and status words are resolved HERE because useTerminal owns no i18n
// scope, and the ordering is decided here because recency is remembered here.
function mentionCandidatesFor(paneId: string): MentionCandidate[] {
  const localGroup = i18n.global.t('mention.group-local')
  const others: MentionCandidate[] = panes.value
    .filter((x) => x.id !== paneId && x.messagingName)
    .map((x) => {
      // Only a realized pane in THIS window can report a status; a cold-restore
      // placeholder has no terminal to ask yet, and the menu shows a hollow dot
      // rather than guessing one.
      const status = paneRefs[x.id]?.displayStatus
      return {
        address: x.messagingName as string,
        group: localGroup,
        status,
        statusLabel: status ? i18n.global.t(paneStatusLabelKey(status)) : undefined,
      }
    })
  // Offer the broadcast keyword first once there are ≥2 recipients — picking it
  // sends to every other pane at once (see isBroadcastTarget / sendBroadcast).
  // `all` stays workspace-local; cross-workspace sends are always explicit.
  //
  // sendBroadcast reaches every pane THIS WINDOW registers, which is one
  // workspace's worth until the sidebar adopts another. Rather than reach into
  // the messaging registry to teach it about workspaces, the menu simply stops
  // offering `all` once the window holds more than one: a keyword that means
  // "everyone here" is not worth keeping when "here" became ambiguous. Typing
  // it by hand still broadcasts window-wide.
  const canBroadcast = others.length >= 2 && extraWorkspaces.value.length === 0
  const broadcast: MentionCandidate[] = canBroadcast
    ? [{
        address: MENTION_BROADCAST_ADDRESS,
        group: localGroup,
        statusLabel: i18n.global.t('mention.broadcast-hint'),
      }]
    : []
  const remoteGroup = i18n.global.t('mention.group-remote')
  const remote: MentionCandidate[] = remoteMessagingTargets.value.map((address) => ({
    address,
    group: remoteGroup,
  }))
  return rankMentionCandidates(
    [...broadcast, ...others, ...remote],
    loadMentionRecents(),
    i18n.global.t('mention.group-recent')
  )
}

/** Mention mode for a pane drop: an "@" typed immediately before the drop means
 *  "insert just this pane's address", completing e.g. "傳給 @" + drop →
 *  "傳給 @codex-1 ". The typed "@" is what selects this gesture — without it the
 *  drop falls through to the full context share below, so the two never compete
 *  for the same drop and neither can silently swallow the other. Returns true
 *  when the drop belonged to mention mode — including when it was abandoned
 *  because the prompt moved — and false to fall through. */
async function tryMentionOnDrop(
  targetPaneId: string,
  resolveAddress: () => string | null | Promise<string | null>,
): Promise<boolean> {
  const lineBeforeCursor = paneRefs[targetPaneId]?.readLineBeforeCursor?.()
  if (!shouldMentionOnDrop(lineBeforeCursor)) return false
  const address = await resolveAddress()
  if (!address) return false
  // Resolving a remote address awaits a round trip, so the prompt may have moved
  // on — the user kept typing, or the CLI redrew. Abandon the gesture rather
  // than splicing an address into the middle of what they wrote; falling through
  // to the scrollback share would be an even bigger surprise.
  if (paneRefs[targetPaneId]?.readLineBeforeCursor?.() !== lineBeforeCursor) return true
  await pastePaneContext(targetPaneId, buildMentionInsert(lineBeforeCursor, address))
  return true
}

// Cross-pane context share: pane A dragged onto pane B's terminal area pastes a
// tail excerpt of A's rendered scrollback into B's input prompt (TerminalPane's
// 'cli-context-drop'). A drop onto a typed "@" means the address instead — see
// tryMentionOnDrop. Deliberately NOT injectText: no Enter is sent — the text
// waits in B's prompt for the user to add their question and submit. Bracketed
// paste keeps the excerpt's newlines literal instead of submitting each line.
async function injectPaneContext(sourcePaneId: string, targetPaneId: string): Promise<void> {
  const sourcePane = panes.value.find((p) => p.id === sourcePaneId)
  const sourceRef = paneRefs[sourcePaneId]
  const targetSessionId = paneRefs[targetPaneId]?.sessionId as string | undefined
  // Preserve the established relay fallback for an absent source or a live
  // source whose local ref was torn down. A local placeholder has no buffer to
  // share, however, so never ask another window to provide stale context for it.
  if (!sourcePane || !sourceRef) {
    if (!sourcePane || sourcePane.realized) {
      // A source in another window used to have no address, so mention mode
      // skipped it and always pulled its scrollback over. Now that it can be
      // reached at `<folder>/<pane>`, an "@" before the drop means the same
      // thing here as it does locally. Same target liveness rule as the relay
      // path below — a dead pane is not a drop target.
      const targetStatus = paneRefs[targetPaneId]?.displayStatus as string | undefined
      // A pane of THIS window that merely lost its ref still has its local
      // handle — asking the registry for it would always miss, since the listing
      // filters out this window's own panes.
      const resolveAddress = sourcePane
        ? () => sourcePane.messagingName ?? null
        : () => remoteAddressOf(sourcePaneId)
      if (
        targetStatus !== 'exited' &&
        targetStatus !== 'error' &&
        (await tryMentionOnDrop(targetPaneId, resolveAddress))
      ) {
        return
      }
      await injectExternalPaneContext(sourcePaneId, targetPaneId)
    }
    return
  }
  // Placeholders have no live PTY/buffer. A target placeholder cannot accept a
  // paste either.
  if (!sourcePane.realized || !panes.value.find((p) => p.id === targetPaneId)?.realized || !targetSessionId) return
  if (await tryMentionOnDrop(targetPaneId, () => sourcePane.messagingName ?? null)) return

  const text = buildPaneContextPaste({
    paneId: sourcePane.id,
    label: sourcePane.customName || sourcePane.autoName || sourcePane.agentLabel,
    agentKey: sourcePane.agentKey,
    sessionId: sourcePane.pinnedSessionId || null,
    sessionHomeId: sourcePane.sessionHomeId,
    workspacePath: sourcePane.workspacePath,
    conversationLogPath: sourcePane.outputLogFile
  }, readPaneShareText(sourceRef, CLI_PASTE_LINE_CAP))
  if (!text) return // no session reference or buffer worth sharing

  await pastePaneContext(targetPaneId, text)
}

/** A multi-selection dropped onto a terminal shares every dragged pane's context
 *  with that terminal. Strictly sequential: each share is a bracketed paste into
 *  the same PTY, and interleaving two of them would splice one pane's scrollback
 *  into the middle of another's. A target inside the batch is skipped — a pane
 *  cannot share context with itself. */
async function injectPaneContextSources(
  sourcePaneIds: string[],
  targetPaneId: string
): Promise<void> {
  for (const id of sourcePaneIds) {
    if (id === targetPaneId) continue
    await injectPaneContext(id, targetPaneId)
  }
}

// Shared delivery tail for both context-share paths (same-window and
// cross-window): bracketed paste into the target pane's PTY, chunked so no
// surrogate pair is split across sends.
async function pastePaneContext(targetPaneId: string, text: string): Promise<void> {
  const targetSessionId = paneRefs[targetPaneId]?.sessionId as string | undefined
  if (!targetSessionId) return // target has no live PTY
  // Guards as their own writes (see injectionChunks): chunking the wrapped
  // string splits one of them as soon as the text is long enough.
  for (const chunk of injectionChunks(text, 512, true)) {
    try {
      await backend.send('terminal.input', { terminal_session_id: targetSessionId, data: chunk })
    } catch (err) {
      console.error(`[pastePaneContext] send failed for pane ${targetPaneId}:`, err)
      return
    }
  }
}

// A plan dropped from PlansPane onto a CLI pane: paste the plan document's
// path into that pane's input prompt. No Enter is sent — the text waits for
// the user to review and submit, matching injectPaneContext.
async function injectPlanToPane(ref: PlanDragRef, targetPaneId: string): Promise<void> {
  await pastePaneContext(targetPaneId, planDropPrompt(ref))
}

// Cross-WINDOW variant of injectPaneContext: the source pane lives in another
// window (another workspace, or a detached group window), so its metadata and
// scrollback come from the cli:get-pane-buffer relay instead of local paneRefs.
async function injectExternalPaneContext(sourcePaneId: string, targetPaneId: string): Promise<void> {
  const getBuf = window.agentTeam?.getCliPaneBuffer
  if (!getBuf || !paneRefs[targetPaneId]) return
  // Parity with the in-window terminal drop: a dead pane is not a drop target.
  const targetStatus = paneRefs[targetPaneId]?.displayStatus as string | undefined
  if (targetStatus === 'exited' || targetStatus === 'error') return
  let reply: Parameters<typeof buildExternalPaneContextPaste>[1]
  try {
    reply = await getBuf(sourcePaneId)
  } catch {
    reply = { error: 'unavailable' }
  }
  if (reply.error) {
    notifyRestore.toast(
      i18n.global.t(reply.error === 'not-found' ? 'cliDrop.source-closed' : 'cliDrop.fetch-failed'),
      { type: 'error' }
    )
    return
  }
  const text = buildExternalPaneContextPaste(sourcePaneId, reply)
  if (!text) {
    notifyRestore.toast(i18n.global.t('cliDrop.empty'))
    return
  }
  await pastePaneContext(targetPaneId, text)
}

// Loop launch button: first click injects the configurable loop prompt and
// lights the LOOP badge; second click only clears the badge (the app cannot
// stop the CLI-internal loop) and cancels any pending auto-resume.
// Monotonic per-pane loop generation. Bumped on every start AND every cancel,
// so an already-running/queued loop injection can tell whether the loop it
// belongs to is still the current one. Without it a stale injection keys off the
// boolean loopActive, which a re-click flips back to true — letting a cancelled
// loop's in-flight inject land a stray prompt and corrupt the fresh loop's state.
const { skills: promptSkills } = usePromptSkills()

/** Resume text for a pane's running loop: the cast skill's own resume prompt,
 *  falling back to the global setting when the skill doesn't override it. */
function loopResumeTextFor(paneId: string): string {
  const pane = panes.value.find((p) => p.id === paneId)
  const skill = resolvePromptSkill(promptSkills.value, pane?.loopSkillId)
  return skill.resumePrompt.trim() || settingsGet(LOOP_RESUME_SETTING_KEY, DEFAULT_LOOP_RESUME)
}

const loopGen = new Map<string, number>()
function bumpLoopGen(paneId: string): number {
  const next = (loopGen.get(paneId) ?? 0) + 1
  loopGen.set(paneId, next)
  return next
}

async function togglePaneLoop(paneId: string, skillId?: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return
  if (pane.loopActive) {
    pane.loopActive = false
    pane.loopWaitUntil = null
    pane.loopEstimateResetAt = null
    pane.loopSkillId = null
    pane.loopTurnCount = 0
    pane.loopMaxTurns = 0
    // Invalidate any in-flight/queued injection so it aborts instead of landing
    // a stray prompt (and never re-arms a loop the user just turned off).
    bumpLoopGen(paneId)
    stopLoopLimitWatcher(paneId)
    return
  }
  // Which skill is being cast: the picker's choice, else the default one.
  // resolvePromptSkill falls back to the default for an id whose skill the
  // user has since deleted.
  const skill = resolvePromptSkill(promptSkills.value, skillId)
  // Optimistic UI: badge + watcher arm immediately; rolled back below if the
  // start injection doesn't land (e.g. pane still 'starting', no session yet).
  pane.loopActive = true
  pane.loopSkillId = skill.id
  pane.loopTurnCount = 0
  pane.loopMaxTurns = skill.maxTurns
  pane.loopEstimateResetAt = Date.now() + LOOP_ESTIMATE_WINDOW_MS
  const gen = bumpLoopGen(paneId)
  startLoopLimitWatcher(paneId)
  // Global injection semaphore: synchronized multi-pane loop starts must not
  // flood the WS (same failure mode the role-injection path guards against).
  await acquireInjectionSlot()
  let ok = false
  try {
    // Superseded while queued on the semaphore (cancel / re-toggle)? Abort — the
    // newer toggle owns the loop state now.
    if (loopGen.get(paneId) !== gen) return
    ok = await injectPane(
      paneId,
      withLoopDoneInstruction(skill.prompt),
      'loop-start',
      true,
      () => loopGen.get(paneId) !== gen
    )
  } finally {
    releaseInjectionSlot()
  }
  // A newer toggle superseded this start while it injected — don't touch state.
  if (loopGen.get(paneId) !== gen) return
  if (!ok) {
    console.warn(`[loop] pane ${paneId}: loop-start injection failed — loop disarmed`)
    pane.loopActive = false
    pane.loopSkillId = null
    pane.loopEstimateResetAt = null
    pane.loopWaitUntil = null
    stopLoopLimitWatcher(paneId)
    return
  }
  // Arm turn-complete auto-continue: only a turn_complete AFTER this instant
  // counts, so a stale signal from before loop-start can't trigger an instant
  // resend (mirrors the pipeline's armedAt discipline).
  armLoopTurn(paneId)
}

/** Shared resume path for the scheduled (watcher expiry) and manual
 *  (badge click) routes. Clears loopWaitUntil synchronously BEFORE injecting so
 *  the poll loop returns to matching mode and neither route can double-inject.
 *  Injection failure re-arms loopWaitUntil 60s out so the watcher's existing
 *  due-check retries instead of silently dropping the resume. */
async function fireLoopResume(paneId: string, logLabel: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !pane.loopActive || pane.loopWaitUntil == null) return
  const gen = loopGen.get(paneId)
  pane.loopWaitUntil = null
  // Consume everything the pane emitted during the wait — TUI repaints keep
  // the old limit banner in the buffer, and re-matching it right after the
  // resume would schedule a bogus next-day wait.
  const watcher = loopLimitWatchers.get(paneId)
  if (watcher) watcher.baseline = paneCleanBytes(paneId)
  // Same global injection semaphore as loop-start: synchronized multi-pane
  // resumes (shared quota window) must not flood the WS.
  await acquireInjectionSlot()
  let ok = false
  try {
    if (loopGen.get(paneId) !== gen || !pane.loopActive) return
    ok = await injectPane(
      paneId,
      withLoopDoneInstruction(loopResumeTextFor(paneId)),
      logLabel,
      true,
      () => loopGen.get(paneId) !== gen
    )
  } finally {
    releaseInjectionSlot()
  }
  // Loop turned off / restarted while the injection was in flight — don't touch state.
  if (loopGen.get(paneId) !== gen || !pane.loopActive) return
  if (!ok) {
    console.warn(`[loop] pane ${paneId}: resume injection failed — retrying in 60s`)
    pane.loopWaitUntil = Date.now() + 60_000
    return
  }
  // Resume landed: a fresh quota window starts now, so refresh the badge's
  // pre-limit estimate (otherwise it reverts to the already-elapsed one).
  pane.loopEstimateResetAt = Date.now() + LOOP_ESTIMATE_WINDOW_MS
  // Re-arm turn-complete: the pre-limit turn's signal must not trigger an
  // instant continue right after the quota resumes.
  armLoopTurn(paneId)
  // Drop the stall bookkeeping: an exhausted CLI answers short and repetitively
  // ("you've hit your limit"), so the turns leading into the pause look stalled
  // when the quota — not the agent — was the problem. Carrying that count over
  // would stop the loop moments after it resumes on a fresh window.
  const resumed = loopLimitWatchers.get(paneId)
  if (resumed) {
    resumed.stalledRuns = 0
    resumed.lastTurnText = ''
    resumed.nextContinueAt = 0
  }
}

/** Auto-continue path for turn-complete (unattended loop). Sends the resume
 *  prompt (with the done-marker instruction) once the CLI's turn has genuinely
 *  ended, then re-arms so the NEXT turn is what's judged. Guarded by
 *  watcher.continuing so overlapping polls can't double-inject. */
async function fireLoopContinue(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  const watcher = loopLimitWatchers.get(paneId)
  if (!pane || !pane.loopActive || !watcher || watcher.continuing) return
  // The cast skill's turn cap. Checked here rather than on a counter of its
  // own so it shares the existing continue gate — one place decides whether a
  // turn happens at all.
  const cap = pane.loopMaxTurns ?? 0
  if (cap > 0 && (pane.loopTurnCount ?? 0) >= cap) {
    console.info(`[loop] pane ${paneId}: turn cap reached (${cap}) — loop stopped`)
    stopLoopComplete(paneId, 'turn-cap')
    return
  }
  const gen = loopGen.get(paneId)
  watcher.continuing = true
  await acquireInjectionSlot()
  let ok = false
  try {
    // Cancelled / restarted while queued on the semaphore? Abort before the
    // inject so no stray "繼續" lands in a CLI whose loop was just turned off.
    if (loopGen.get(paneId) !== gen || !pane.loopActive) return
    ok = await injectPane(
      paneId,
      withLoopDoneInstruction(loopResumeTextFor(paneId)),
      'loop-continue',
      true,
      () => loopGen.get(paneId) !== gen
    )
  } finally {
    releaseInjectionSlot()
    watcher.continuing = false
  }
  // Loop turned off / restarted while the injection was in flight — don't arm.
  if (loopGen.get(paneId) !== gen || !pane.loopActive) return
  if (!ok) {
    console.warn(`[loop] pane ${paneId}: continue injection failed — will retry next turn`)
    return
  }
  pane.loopTurnCount = (pane.loopTurnCount ?? 0) + 1
  // Fresh turn started: re-arm and refresh the pre-limit estimate window.
  armLoopTurn(paneId)
  // Hold the next continue for the current stall tier (0 while productive), and
  // count this one against the hard cap.
  watcher.continues += 1
  watcher.nextContinueAt = Date.now() + loopBackoffMs(watcher.stalledRuns)
  pane.loopEstimateResetAt = Date.now() + LOOP_ESTIMATE_WINDOW_MS
}

/** A completed turn's text decides whether the loop is getting anywhere. A
 *  stalled run (repeat of the previous answer, or too short to be work) backs
 *  the next continue off; a productive one clears the counter. Stale replayed
 *  turns are ignored on the same timestamp test as the done-marker path, so a
 *  log re-parse can't inflate the count. */
function noteLoopTurnProgress(paneId: string, text: string, timestamp: string): void {
  const watcher = loopLimitWatchers.get(paneId)
  if (!watcher) return
  const eventMs = timestamp ? Date.parse(timestamp) : NaN
  if (!Number.isNaN(eventMs) && eventMs < watcher.armedAt - TURN_TEXT_REPLAY_TOLERANCE_MS) return
  const next = applyTurnProgress(watcher, text, {
    toolUsesThisTurn: watcher.toolUsesThisTurn,
    toolSignalsSeen: watcher.toolSignalsSeen,
  })
  if (next.stalledRuns > watcher.stalledRuns) {
    console.warn(
      `[loop] pane ${paneId}: turn showed no progress (${next.stalledRuns}/${LOOP_STALL_LIMIT}, ${watcher.toolUsesThisTurn} tool uses) — next continue backs off ${loopBackoffMs(next.stalledRuns) / 1000}s`
    )
  }
  watcher.stalledRuns = next.stalledRuns
  watcher.lastTurnText = next.lastTurnText
  watcher.recentTurns = next.recentTurns ?? []
}

/** A completed turn ended with LOOP_WAIT_MARKER: the CLI says it did nothing
 *  but wait on something the loop cannot see. Hold the next continue instead of
 *  poking it again, and report whether the turn was handled as a wait.
 *
 *  Returns false — meaning "judge this turn normally" — when the turn carried no
 *  marker, OR when the run has spent its whole waiting budget. That second case
 *  is the fail-OPEN bound: an agent emitting the marker every turn would
 *  otherwise park the loop for good, silently. Once the budget is gone the
 *  marker stops being honoured, ordinary continues resume, and the stall
 *  detector finally gets to see those turns and end the run. */
function noteLoopWait(paneId: string, text: string, timestamp: string): boolean {
  const watcher = loopLimitWatchers.get(paneId)
  if (!watcher) return false
  if (!text || !turnEndsWithSentinel(text, LOOP_WAIT_MARKER)) {
    // Any other turn ends the streak; the spent budget deliberately stays.
    const cleared = applyLoopWait(watcher, false)
    watcher.consecutive = cleared.consecutive
    watcher.totalWaitedMs = cleared.totalWaitedMs
    return false
  }
  // Same replay guard as the done-marker path: a re-parsed historical turn
  // must not schedule a wait for a loop that has since moved on.
  const eventMs = timestamp ? Date.parse(timestamp) : NaN
  if (!Number.isNaN(eventMs) && eventMs < watcher.armedAt - TURN_TEXT_REPLAY_TOLERANCE_MS) return false
  if (!loopWaitHonoured(watcher)) {
    console.warn(`[loop] pane ${paneId}: LOOP_WAIT budget spent — ignoring the marker from here on`)
    return false
  }
  const next = applyLoopWait(watcher, true)
  watcher.consecutive = next.consecutive
  watcher.totalWaitedMs = next.totalWaitedMs
  const holdMs = loopWaitBackoffMs(next.consecutive)
  watcher.nextContinueAt = Date.now() + holdMs
  console.info(`[loop] pane ${paneId}: agent reported it is waiting — holding ${holdMs / 1000}s (${next.consecutive} in a row)`)
  return true
}

/** The loop is spinning without finishing — it repeated itself past the stall
 *  limit, or burned through the continue cap. Stop it (same teardown as the
 *  done path) and ask for attention instead of injecting another continue. */
function stopLoopSpinning(paneId: string, reason: 'stalled' | 'capped'): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !pane.loopActive) return
  console.warn(`[loop] pane ${paneId}: loop stopped — ${reason}`)
  pane.loopActive = false
  pane.loopWaitUntil = null
  pane.loopEstimateResetAt = null
  pane.loopSkillId = null
  pane.loopTurnCount = 0
  pane.loopMaxTurns = 0
  bumpLoopGen(paneId)
  stopLoopLimitWatcher(paneId)
  sysNotify.notifyPaneState(
    paneId,
    'attention',
    i18n.global.t(`pane.terminal.loop-${reason}-notify-title`),
    i18n.global.t(`pane.terminal.loop-${reason}-notify-body`)
  )
}

/** The CLI reported LOOP_DONE_MARKER as its turn's final line — the task is
 *  complete. Clear all loop state and notify (same background-gated path as the
 *  paused/limit notifications). */
function stopLoopComplete(paneId: string, reason: 'done-marker' | 'turn-cap' = 'done-marker'): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !pane.loopActive) return
  console.info(`[loop] pane ${paneId}: loop complete — ${reason}`)
  pane.loopActive = false
  pane.loopWaitUntil = null
  pane.loopEstimateResetAt = null
  pane.loopSkillId = null
  pane.loopTurnCount = 0
  pane.loopMaxTurns = 0
  // Invalidate any in-flight/queued continue so it can't re-arm after done.
  bumpLoopGen(paneId)
  stopLoopLimitWatcher(paneId)
  sysNotify.notifyPaneState(
    paneId,
    'done',
    i18n.global.t('pane.terminal.loop-complete-notify-title'),
    i18n.global.t('pane.terminal.loop-complete-notify-body')
  )
}

/** Set the turn-complete arm time on a pane's loop watcher (no-op if the
 *  watcher is gone). Only a turn_complete after this instant is judged. */
function armLoopTurn(paneId: string): void {
  const watcher = loopLimitWatchers.get(paneId)
  if (!watcher) return
  watcher.armedAt = Date.now()
  // Per-TURN counter: what the next turn does with tools says nothing about
  // what the last one did. toolSignalsSeen is per-PANE and deliberately kept.
  watcher.toolUsesThisTurn = 0
}

/** turn_complete carried LOOP_DONE_MARKER as its final line: stop the loop if
 *  the event is fresh (not a replayed historical turn from before this loop
 *  armed — MAX_SAFE_INTEGER armedAt before the first injection lands also
 *  rejects, so a marker can never stop a loop that hasn't started yet). */
function stopLoopOnDoneMarker(paneId: string, timestamp: string): void {
  const watcher = loopLimitWatchers.get(paneId)
  if (!watcher) return
  const eventMs = timestamp ? Date.parse(timestamp) : NaN
  if (!Number.isNaN(eventMs) && eventMs < watcher.armedAt - TURN_TEXT_REPLAY_TOLERANCE_MS) return
  stopLoopComplete(paneId)
}

/** Waiting badge clicked: the user wants the loop resumed immediately. */
function resumeLoopNow(paneId: string): void {
  void fireLoopResume(paneId, 'loop-resume-now')
}

// While a pane's loop is active, watch its raw PTY buffer for the CLI
// session-limit message and auto-resume once the quota resets. The interval
// self-cleans when the pane is gone, the loop was turned off, or the terminal
// exited, so no hook into the pane-removal paths is needed. Interval-based
// (rather than one long setTimeout) to survive background timer throttling.
interface LoopLimitWatcher {
  timer: number
  /** Consumed-position baseline in monotonic cleanBytesSeen units: only text
   *  appended after it is matched. Starts at the buffer end when the watcher
   *  arms (a pre-existing limit message can never schedule a wait) and
   *  advances whenever a match is consumed — scheduled, unparseable, or
   *  resumed. cleanBytesSeen survives the 128KB cleanBuffer cap (the stage
   *  watchers' scanFrom overflow problem), at worst over-scanning slightly
   *  after a recleanBuffer() shrink. */
  baseline: number
  /** Last unparseable matched message — dedupes the warn/notify when TUI
   *  repaints re-surface the same text. */
  lastUnparseable: string | null
  /** Wall-clock ms when the current turn was armed (loop-start / after each
   *  resume/continue). Only a turn_complete AFTER this counts for auto-continue
   *  — mirrors the pipeline's paneArmedAt. MAX_SAFE_INTEGER until the first
   *  injection lands, so a stale pre-start turn_complete can't fire a resend. */
  armedAt: number
  /** A continue injection is in flight — blocks overlapping polls from
   *  double-sending the resume prompt for the same turn. */
  continuing: boolean
  /** Continues injected since this loop started — checked against
   *  LOOP_MAX_CONTINUES so a spin the stall detector can't see still ends. */
  continues: number
  /** Consecutive completed turns that showed no forward motion (see
   *  turnMadeProgress). Drives the backoff and the stall stop. */
  stalledRuns: number
  /** Earliest wall-clock ms the next continue may fire — the stall backoff.
   *  0 while the loop is productive. */
  nextContinueAt: number
  /** Normalized text of the last completed turn, for the repeat comparison. */
  lastTurnText: string
  /** Normalized text of the last LOOP_RECENT_TURNS turns, newest first, so a
   *  CLI alternating between two phrasings of "still waiting" is not read as
   *  progress on every turn. */
  recentTurns: string[]
  /** Tool-use signals attributed to this pane since the turn was armed. A turn
   *  that ends having touched no tool did no work — see turnUsedNoTools. */
  toolUsesThisTurn: number
  /** This pane has reported tool use at least once, so a zero above means
   *  "used none" rather than "this vendor never says". Self-calibrating: only
   *  vendors whose reader or hook names tools ever set it. */
  toolSignalsSeen: boolean
  /** Consecutive turns that ended with LOOP_WAIT_MARKER (0 after any other). */
  consecutive: number
  /** Time this run has already granted to LOOP_WAIT holds, bounded by
   *  LOOP_WAIT_TOTAL_MAX_MS so the marker can never park a loop for good. */
  totalWaitedMs: number
}
const loopLimitWatchers = new Map<string, LoopLimitWatcher>()
const LOOP_LIMIT_POLL_MS = 5000
// Tail-only matching: repainted TUI frames keep the limit message near the
// buffer tail, and slicing avoids rescanning the capped 128KB cleanBuffer.
const LOOP_LIMIT_TAIL_CHARS = 2000

function stopLoopLimitWatcher(paneId: string): void {
  const watcher = loopLimitWatchers.get(paneId)
  if (watcher !== undefined) {
    clearInterval(watcher.timer)
    loopLimitWatchers.delete(paneId)
  }
  // Drop the subagent count with the watcher that reads it. A count left above
  // zero — the pane's CLI exited while a subagent was running, so its
  // SubagentStop never arrived — would otherwise gate the NEXT loop started on
  // this pane for the whole staleness window.
  panePendingSubagents.delete(paneId)
}

function startLoopLimitWatcher(paneId: string): void {
  stopLoopLimitWatcher(paneId)
  const watcher: LoopLimitWatcher = {
    timer: 0,
    baseline: paneCleanBytes(paneId),
    lastUnparseable: null,
    armedAt: Number.MAX_SAFE_INTEGER,
    continuing: false,
    continues: 0,
    stalledRuns: 0,
    nextContinueAt: 0,
    lastTurnText: '',
    recentTurns: [],
    toolUsesThisTurn: 0,
    toolSignalsSeen: false,
    consecutive: 0,
    totalWaitedMs: 0,
  }
  watcher.timer = window.setInterval(() => {
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane || !pane.loopActive) {
      stopLoopLimitWatcher(paneId)
      return
    }
    const ref = paneRefs[paneId]
    if (!ref) return
    const status = ref.displayStatus as string | undefined
    if (status === 'exited' || status === 'error') {
      // Dead pane: clear ALL loop state, not just the wait — a lingering
      // loopActive keeps a stale green badge up while hiding the start
      // button, so the user couldn't even clear it (same cleanup as onKill
      // and terminal.exit).
      pane.loopActive = false
      pane.loopWaitUntil = null
      pane.loopEstimateResetAt = null
      stopLoopLimitWatcher(paneId)
      return
    }
    if (pane.loopWaitUntil != null) {
      // Waiting mode: matching is suspended so TUI redraws of the same limit
      // message cannot double-schedule. Resume once the quota window is due.
      if (Date.now() >= pane.loopWaitUntil) void fireLoopResume(paneId, 'loop-resume')
      return
    }
    const buf = ((ref.cleanBuffer as unknown as string) ?? '')
    const tail = unseenTail(buf, paneCleanBytes(paneId), watcher.baseline, LOOP_LIMIT_TAIL_CHARS)
    const matched = matchSessionLimit(tail)
    // Session limit takes priority over auto-continue: when the CLI hit the
    // quota its turn also "ends" (turn_complete), but resending now would just
    // burn against the still-exhausted quota — schedule the timed resume instead.
    if (matched != null) {
      // Consume the matched region either way so the same text can't re-match
      // on a later poll (a stale re-match would roll the wait a full day out).
      watcher.baseline = paneCleanBytes(paneId)
      const resumeAt = parseLimitReset(matched)
      if (resumeAt == null) {
        // Fail open: badge stays lit, no auto-resume — but KEEP watching so a
        // future parseable limit message still schedules. Warn/notify once per
        // distinct unparseable message.
        if (matched !== watcher.lastUnparseable) {
          watcher.lastUnparseable = matched
          console.warn(`[loop] pane ${paneId}: session-limit message matched but reset time was unparseable; auto-resume not scheduled`)
          sysNotify.notifyPaneState(
            paneId,
            'attention',
            i18n.global.t('pane.terminal.loop-unparseable-notify-title'),
            i18n.global.t('pane.terminal.loop-unparseable-notify-body')
          )
        }
        return
      }
      pane.loopWaitUntil = resumeAt
      // Make the pause visible even when the pane is unfocused — same
      // background-gated native notification path as done/attention.
      sysNotify.notifyPaneState(
        paneId,
        'attention',
        i18n.global.t('pane.terminal.loop-paused-notify-title'),
        i18n.global.t('pane.terminal.loop-paused-notify-body', { time: formatLoopTime(resumeAt) })
      )
      return
    }
    // No session limit — unattended auto-continue. Use loopContinueReady (not
    // plain turnCompleteDone): on top of a settled, post-arm, latest
    // turn_complete it also requires that the LAST continue actually woke the
    // CLI (an agent_active landed after arm). Without that guard an empty-text
    // turn_complete with no intervening agent_active — Claude's Stop hook, a
    // thinking-only record — re-satisfies the verdict every poll and the loop
    // resends "繼續" forever. Task COMPLETION is handled separately in the
    // agent.activity handler: LOOP_DONE_MARKER stops the loop (loopActive=false)
    // before this poll can fire another continue.
    //
    // loopContinueReady cannot see a CLI that is stuck: a turn that ends with
    // "waiting for a background agent" is a genuine, post-arm, woken-up turn
    // end, so every condition holds and the loop would resend forever. The
    // stall detector (noteLoopTurnProgress) judges the turn's TEXT instead and
    // stops the spin here; the continue cap is the vendor-agnostic backstop.
    const verdict = loopStallVerdict(watcher)
    if (verdict === 'stop-capped') {
      stopLoopSpinning(paneId, 'capped')
      return
    }
    if (verdict === 'stop-stalled') {
      stopLoopSpinning(paneId, 'stalled')
      return
    }
    // Parked on background subagents: the turn ended to WAIT, not because the
    // work is done. loopContinueReady cannot see this — every one of its
    // conditions holds — so the hook-reported count is checked separately, and
    // ahead of it. Holding here costs nothing: the count drops to zero the
    // moment the last SubagentStop lands and the next poll continues normally.
    const subagents = panePendingSubagents.get(paneId)
    if (
      subagents !== undefined &&
      loopWaitingOnSubagents({
        pending: subagents.pending,
        observedAt: subagents.observedAt,
        now: Date.now(),
      })
    ) {
      return
    }
    if (
      !watcher.continuing &&
      Date.now() >= watcher.nextContinueAt &&
      loopContinueReady({
        turnCompleteAt: paneTurnCompleteAt.get(paneId) ?? 0,
        lastActiveAt: paneLastWorkingAt.get(paneId) ?? 0,
        armedAt: watcher.armedAt,
        now: Date.now(),
        settleMs: TURN_COMPLETE_SETTLE_MS,
      })
    ) {
      void fireLoopContinue(paneId)
    }
  }, LOOP_LIMIT_POLL_MS)
  loopLimitWatchers.set(paneId, watcher)
}

// Always-on watcher for CLIs with a login-expired spec (lib/cliLoginExpired):
// polls the pane's clean buffer tail for the CLI's expired-login message and
// lights the pane's re-login badge on match. Same consumed-position baseline
// discipline as the loop-limit watcher, so TUI repaints can't re-match. The
// interval self-cleans when the pane is gone or its terminal exited.
interface LoginExpiredWatcher {
  timer: number
  /** Consumed-position baseline in monotonic cleanBytesSeen units — only text
   *  appended after it is matched (see LoopLimitWatcher.baseline). */
  baseline: number
  /** False until the initial output (spawn banner / reattach scrollback replay)
   *  has settled; matching is suppressed while false so stale historical text
   *  can't spuriously light the badge. */
  warmedUp: boolean
}
const loginExpiredWatchers = new Map<string, LoginExpiredWatcher>()
// Panes with an in-flight fix-login injection, so a second badge click can't
// start a concurrent second "/login" injection during the multi-second await.
const loginFixInFlight = new Set<string>()
const LOGIN_EXPIRED_POLL_MS = 5000
const LOGIN_EXPIRED_TAIL_CHARS = 2000

function stopLoginExpiredWatcher(paneId: string): void {
  const watcher = loginExpiredWatchers.get(paneId)
  if (watcher !== undefined) {
    clearInterval(watcher.timer)
    loginExpiredWatchers.delete(paneId)
  }
}

function startLoginExpiredWatcher(paneId: string): void {
  stopLoginExpiredWatcher(paneId)
  const watcher: LoginExpiredWatcher = {
    timer: 0,
    baseline: paneCleanBytes(paneId),
    warmedUp: false,
  }
  watcher.timer = window.setInterval(() => {
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane) {
      stopLoginExpiredWatcher(paneId)
      return
    }
    const ref = paneRefs[paneId]
    if (!ref) return
    const status = ref.displayStatus as string | undefined
    if (status === 'exited' || status === 'error') {
      // Dead pane: clear the flag so a lit badge whose click does nothing
      // doesn't linger, then stop the watcher.
      pane.loginExpired = false
      stopLoginExpiredWatcher(paneId)
      return
    }
    const bytes = paneCleanBytes(paneId)
    if (!watcher.warmedUp) {
      // Consume spawn banner / reattach scrollback replay without matching so
      // stale historical "login expired" text can't spuriously light the badge;
      // start matching once output settles for one interval.
      if (bytes > watcher.baseline) { watcher.baseline = bytes; return }
      watcher.warmedUp = true
    }
    if (pane.loginExpired) {
      // Badge already lit: keep consuming output so the same (repainted) error
      // text can't instantly re-light the badge after a fix-login clears it.
      watcher.baseline = bytes
      return
    }
    const buf = ((ref.cleanBuffer as unknown as string) ?? '')
    const tail = unseenTail(buf, bytes, watcher.baseline, LOGIN_EXPIRED_TAIL_CHARS)
    if (!matchLoginExpired(pane.agentKey, tail)) return
    // Consume the matched region so a later poll can't re-match the same text.
    watcher.baseline = bytes
    pane.loginExpired = true
    sysNotify.notifyPaneState(
      paneId,
      'attention',
      i18n.global.t('pane.terminal.login-expired-notify-title'),
      i18n.global.t('pane.terminal.login-expired-notify-body')
    )
  }, LOGIN_EXPIRED_POLL_MS)
  loginExpiredWatchers.set(paneId, watcher)
}

/** Login-expired badge clicked: send the CLI's login command into the pane.
 *  The badge clears only when the injection lands; on failure it stays lit so
 *  the user can click again. */
async function fixPaneLogin(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !pane.loginExpired) return
  // Guard the multi-second injectPane await: pane.loginExpired stays true until
  // success, so without this a second badge click would start a concurrent
  // second "/login" injection into the just-opened login dialog.
  if (loginFixInFlight.has(paneId)) return
  const command = loginCommandFor(pane.agentKey)
  if (command == null) return
  loginFixInFlight.add(paneId)
  try {
    const ok = await injectPane(paneId, command, 'login-fix')
    if (ok) {
      // Advance the watcher's consumed baseline so error text repainted between
      // the last lit-tick and this clear can't re-match on the next poll and
      // re-light the badge. Failure keeps the badge lit for retry.
      const w = loginExpiredWatchers.get(paneId)
      if (w) w.baseline = paneCleanBytes(paneId)
      pane.loginExpired = false
    }
  } finally {
    loginFixInFlight.delete(paneId)
  }
}

// Panes with an in-flight continue injection, so a second click during the
// multi-second injectPane await cannot send the prompt twice.
const continueInFlight = new Set<string>()

/** Continue button clicked on a pane restored via `--resume`. Sends the same
 *  resume text the loop uses (honouring the user's setting) exactly once — no
 *  watcher, no re-arm, no done-marker instruction: this is a manual nudge, not
 *  an unattended loop. injectPane clears the flag, which hides the button; a
 *  failed injection restores it so the click can be retried. */
async function continueRestoredPane(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.resumeContinueAvailable) return
  if (continueInFlight.has(paneId)) return
  // Same gate every other unsolicited injection passes: never type over a draft
  // or into a turn that is still running.
  if (messagingHoldKey(paneId) !== null) return
  continueInFlight.add(paneId)
  await acquireInjectionSlot()
  try {
    const ok = await injectPane(
      paneId,
      settingsGet(LOOP_RESUME_SETTING_KEY, DEFAULT_LOOP_RESUME),
      'continue-button',
      true
    )
    if (!ok) {
      console.warn(`[continue] pane ${paneId}: injection failed`)
      pane.resumeContinueAvailable = true
    }
  } finally {
    releaseInjectionSlot()
    continueInFlight.delete(paneId)
  }
}


// Dispatch a cloud issue into a running agent pane as a task (one-way: no
// write-back to the issue). Reuses the pipeline-kickoff injection path.
async function onDispatchIssue(payload: { paneId: string; issue: IssueDetail }): Promise<void> {
  const ok = await injectPane(payload.paneId, formatIssueForDispatch(payload.issue), 'issue-dispatch', true)
  if (!ok) console.warn(`[dispatch-issue] injection failed for pane ${payload.paneId}`)
  if (ok) issueHandoffs.value.set(payload.issue.url, { paneId: payload.paneId, mode: 'dispatch', state: 'handling' })
}

// Spawn a new dedicated agent pane for an issue with a pre-generated kickoff
// prompt. Mirrors onManualSpawn but injects the kickoff directly so the agent
// starts working on the issue immediately (skipRoleInjection=true).
async function onHandleIssue(payload: {
  agentKey: string
  mode: IssueHandlerMode
  issue: Issue
  provider: IssueProvider
}): Promise<void> {
  const { agentKey, mode, issue, provider } = payload
  const kickoff = buildIssueKickoff(issue, provider, mode)
  const spawnGroupId = resolveManualSpawnGroupId(runGroups.value, activeTab.value)
  const paneId = await spawnPane({
    agentKey: agentKey as AgentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    commandOverride: '',
    workspacePath: currentWorkspace.value,
    origin: 'manual',
    runGroupId: spawnGroupId || undefined,
    kickoffPrompt: kickoff,
    skipRoleInjection: true,
  })
  if (paneId) {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: currentWorkspace.value,
      pane_id: paneId,
      agent: agentKey,
      role: '',
      command: '',
      session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
      session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
      run_group_id: spawnGroupId,
      output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    })
    issueHandoffs.value.set(issue.url, { paneId, mode, state: 'handling' })
  }
}

/** Host-only action receiver for the package-owned Git left contribution. The
 *  package never receives App callbacks or a generic renderer event channel;
 *  the main process validates the fixed operation and forwards this typed
 *  envelope to the active main window. */
function onGitContributionAction(envelope: {
  operation: string
  payload?: Record<string, unknown>
}): void {
  const typedAction = normalizeGitContributionAction(envelope)
  switch (typedAction.operation) {
    case 'open_path':
      void window.agentTeam?.openPath?.(typedAction.path)
      return
    case 'open_temp_file':
      void window.agentTeam?.openTempFile?.(typedAction.name, typedAction.content)
      return
    case 'open_main_window':
      void window.agentTeam?.openMainWindow?.({ workspace_path: typedAction.workspace_path })
      return
    case 'open_branch_diff_window':
      void window.agentTeam?.openBranchDiffWindow?.({ workspace_path: typedAction.workspace_path, base: typedAction.base })
      return
    case 'open_git_window':
      void window.agentTeam?.openGitWindow?.({
        workspace_path: typedAction.workspace_path,
        ...(typedAction.filepath === undefined ? {} : { filepath: typedAction.filepath }),
        ...(typedAction.staged === undefined ? {} : { staged: typedAction.staged }),
        ...(typedAction.commit === undefined ? {} : { commit: typedAction.commit }),
        ...(typedAction.base === undefined ? {} : { base: typedAction.base }),
        ...(typedAction.compare === undefined ? {} : { compare: typedAction.compare }),
      })
      return
    case 'open_git_history_window':
      void window.agentTeam?.openGitHistoryWindow?.({ workspace_path: typedAction.workspace_path })
      return
    case 'open_workspace':
      void window.agentTeam?.openMainWindow?.({ workspace_path: typedAction.path })
      return
    case 'open_file':
      void window.agentTeam?.openEditorWindow?.({
        workspace_path: typedAction.payload.workspace_path,
        filepath: typedAction.payload.filepath,
        name: typedAction.payload.name,
      })
      return
    case 'open_conflict':
      void window.agentTeam?.openGitWindow?.({
        workspace_path: typedAction.payload.workspace_path,
        filepath: typedAction.payload.filepath,
      })
      return
    case 'open_diff':
      void window.agentTeam?.openGitWindow?.({
        workspace_path: typedAction.payload.workspace_path,
        filepath: typedAction.payload.filepath,
        staged: typedAction.payload.staged,
        commit: typedAction.payload.commit,
      })
      return
    case 'open_branch_diff':
      void window.agentTeam?.openBranchDiffWindow?.({
        workspace_path: typedAction.payload.workspace_path,
        base: typedAction.payload.base,
      })
      return
    case 'dispatch_issue':
      void onDispatchIssue(typedAction.payload)
      return
    case 'spawn_for_issue':
      void onHandleIssue(typedAction.payload)
      return
    case 'focus_pane':
      onSidebarFocusPane(typedAction.paneId)
      return
    case 'open_git_accounts':
      openSettingsAccounts()
      return
    case 'changes_count':
      gitChangesCount.value = typedAction.count
      return
    case 'execute_host_command':
      executeCommand(typedAction.command)
      return
  }
}

let stopGitContributionActions: (() => void) | null = null
let stopPluginContributionChanges: (() => void) | null = null
let stopGitRecoveryChanged: (() => void) | null = null
onMounted(() => {
  stopGitContributionActions = window.agentTeam?.onGitContributionAction?.(onGitContributionAction) ?? null
  stopGitRecoveryChanged = window.agentTeam?.onGitRecoveryChanged?.((change) => {
    // Both directions: the Host also reports recovery being *left* (Extensions
    // restores the bundled v2 package). Latching on true left an open window
    // showing the "Legacy recovery" panel for the rest of its life.
    legacyGitRecovery.value = change.legacy
  }) ?? null
  void refreshPluginContributions()
  stopPluginContributionChanges = window.agentTeam?.plugins?.onContributionsChanged?.(() => {
    void refreshPluginContributions()
  }) ?? null
})
onUnmounted(() => {
  stopGitContributionActions?.()
  stopGitContributionActions = null
  stopGitRecoveryChanged?.()
  stopGitRecoveryChanged = null
  stopPluginContributionChanges?.()
  stopPluginContributionChanges = null
})

// Default delay if no startup trust dialog is observed.
const ROLE_PROMPT_DELAY_MS = 4000
// Minimum time between the start of dialog-watching and role injection.
// Quiet-based settling can pass while the CLI is still silently loading
// (MCP servers etc. attach stdin late without repainting) — this floor keeps
// a small guaranteed lead without restoring the old fixed 12s wait.
const MIN_INJECTION_LEAD_MS = 2500

// Appended to every role prompt at injection time so agents stay silent
// after receiving the role and wait for the actual task kickoff.
const ROLE_STANDBY_SUFFIX = `

---
【等待任務指令】
收到以上角色設定後，請立即停止，不要做任何事。
在收到正式任務 kickoff 之前：
- 禁止執行任何工具或指令
- 禁止讀取任何檔案
- 禁止產生任何工作成果或輸出
只需回覆「準備就緒，等待任務」，然後保持靜默。`
const KICKOFF_DELAY_MS = 3000
// How long to watch for a startup trust dialog before giving up.
const DISMISS_TIMEOUT_MS = 8000
// A trust dialog is always part of the CLI's first screen. Once output has
// appeared and stayed quiet this long without matching a dialog pattern, no
// dialog is coming — bail out early instead of waiting out the full deadline
// (trusted workspaces would otherwise dead-wait all 8s on every spawn).
const NO_DIALOG_QUIET_MS = 1500

// Patterns surfacing on first launch of Codex / Claude / Antigravity when the CLI
// asks the user to trust the workspace. Matching one means we should send a
// single \r to accept the default option (which is always "yes" / "continue").
// How long the "detecting session ID" overlay may BLOCK a marker-bound pane
// (codex/antigravity/grok) after spawn. Long enough for the normal
// prep → marker bootstrap → first-write round trip; short enough that a CLI
// stuck on its own onboarding never bricks the pane.
const SESSION_OVERLAY_GRACE_MS = 30_000

const TRUST_DIALOG_PATTERNS: RegExp[] = [
  /Press enter to continue/i,
  /Do you trust the contents/i,
  /Trust the contents of this/i,
  /Yes,\s*continue/i,
  /Trust this folder/i,
  /Allow Claude Code to/i
]

function paneAlive(paneId: string): boolean {
  return panes.value.some((p) => p.id === paneId)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Monotonic count of clean output bytes for a pane. Unlike
 *  cleanBuffer.length — which pins constant once the 128KB buffer cap is
 *  reached even while output streams — this keeps growing, so it is the only
 *  safe "did new output arrive" signal during large session replays. */
function paneCleanBytes(paneId: string): number {
  const r = paneRefs[paneId]
  return Number((r?.cleanBytesSeen as unknown as number | undefined) ?? 0)
}

/**
 * Wait for the agent to:
 *   1. start producing new output (it's processing our injection), then
 *   2. go quiet for `settleMs` (it's finished its current response).
 *
 * Returns 'settled' on success, 'no-activity' if the agent never produced
 * new output within `maxWaitMs`, or 'timeout' if it kept streaming past the
 * deadline. Callers can decide whether to proceed regardless.
 */
async function waitForActivityThenSettle(
  paneId: string,
  settleMs = 2000,
  maxWaitMs = 30_000
): Promise<'settled' | 'no-activity' | 'timeout'> {
  const ref = paneRefs[paneId]
  if (!ref) return 'no-activity'
  const startSize = paneCleanBytes(paneId)
  const deadline = Date.now() + maxWaitMs
  // Phase 1: wait for activity
  let activeSize = startSize
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return 'no-activity'
    await sleep(300)
    if (!paneRefs[paneId]) return 'no-activity'
    const size = paneCleanBytes(paneId)
    if (size > startSize) {
      activeSize = size
      break
    }
  }
  if (activeSize === startSize) return 'no-activity'

  // Phase 2: wait for the stream to settle.
  let lastSize = activeSize
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return 'settled'
    await sleep(300)
    if (!paneRefs[paneId]) return 'settled'
    const size = paneCleanBytes(paneId)
    if (size === lastSize) {
      if (Date.now() - stableSince >= settleMs) return 'settled'
    } else {
      lastSize = size
      stableSince = Date.now()
    }
  }
  return 'timeout'
}

async function dismissStartupDialog(paneId: string, timeoutMs = DISMISS_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let lastSize = -1
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return false
    const ref = paneRefs[paneId]
    if (!ref) return false
    const buf = (ref.cleanBuffer as unknown as string) ?? ''
    if (TRUST_DIALOG_PATTERNS.some((re) => re.test(buf))) {
      if (ref.sessionId) {
        await backend.send('terminal.input', {
          terminal_session_id: ref.sessionId as string,
          data: '\r'
        })
      }
      pipelineLog(`✓ dismissed startup dialog (pane ${paneId.slice(0, 8)})`)
      return true
    }
    const bytes = paneCleanBytes(paneId)
    if (bytes !== lastSize) {
      lastSize = bytes
      stableSince = Date.now()
    } else if (bytes > 0 && Date.now() - stableSince >= NO_DIALOG_QUIET_MS) {
      return false
    }
    await sleep(250)
  }
  return false
}

/**
 * Block until the pane has produced no new output for `requiredQuietMs`.
 * Bounded by `timeoutMs` so we proceed even if the CLI never stops streaming.
 *
 * Used as a more robust "is the CLI ready to accept input?" check than a
 * fixed sleep — different CLIs / first-vs-subsequent-runs take wildly
 * different amounts of time to render their initial UI.
 */
async function waitForQuiet(
  paneId: string,
  requiredQuietMs = 2000,
  timeoutMs = 12000
): Promise<void> {
  const ref = paneRefs[paneId]
  if (!ref) return
  const deadline = Date.now() + timeoutMs
  let lastSize = paneCleanBytes(paneId)
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return
    await sleep(250)
    if (!paneRefs[paneId]) return
    const size = paneCleanBytes(paneId)
    if (size === lastSize) {
      if (Date.now() - stableSince >= requiredQuietMs) return
    } else {
      lastSize = size
      stableSince = Date.now()
    }
  }
}

async function waitForStartupActivity(paneId: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!paneAlive(paneId)) return false
    const ref = paneRefs[paneId]
    if (!ref) return false
    const status = ref.status as unknown as string
    if (status === 'error' || status === 'exited') return false
    const cleanSize = ((ref.cleanBuffer as unknown as string) ?? '').length
    const rawAt = Number((ref.lastRawActivityAt as unknown as number | undefined) ?? 0)
    if (cleanSize > 0 || rawAt > 0) return true
    await sleep(250)
  }
  return false
}

// Global injection semaphore — at most 2 panes may inject simultaneously.
// Without this, all 6+ pre-spawned panes send role prompts at the same moment,
// flooding the WS connection and causing some 512-byte chunks to timeout/drop.
// The agent then receives a truncated role and asks for clarification instead
// of staying in standby, which breaks the Q&A flow and kickoff delivery.
const MAX_CONCURRENT_INJECTIONS = 2
let _activeInjections = 0
const _injectionQueue: Array<() => void> = []

async function acquireInjectionSlot(): Promise<void> {
  if (_activeInjections < MAX_CONCURRENT_INJECTIONS) {
    _activeInjections++
    return
  }
  await new Promise<void>((resolve) => _injectionQueue.push(resolve))
  _activeInjections++
}

function releaseInjectionSlot(): void {
  _activeInjections--
  _injectionQueue.shift()?.()
}

async function persistPaneSession(pane: ActivePane, sessionId: string): Promise<void> {
  const id = normalizeResumeSessionId(pane.agentKey, sessionId)
  if (!id) return
  const key = `${pane.id}:${id}`
  if (persistedPaneSessions.has(key)) return
  let saved: unknown = null
  if (pane.origin !== 'pipeline') {
    const resp = await sendQuiet<ProjectPayload>('manual_pane.session', {
      workspace_path: pane.workspacePath,
      pane_id: pane.id,
      session_id: id,
    })
    // The backend silently noops when the manual pane record doesn't exist
    // yet (persist can race manual_pane.spawn) — only cache a write the
    // response confirms, so a later event can retry.
    saved = resp?.project?.panes?.some(
      (p) => p.pane_id === pane.id && p.session_id === id
    ) ? resp : null
  } else if (pane.slotLabel && pane.origin === 'pipeline') {
    const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
    if (stageIndex < 0) return
    saved = await sendQuiet('pipeline.slot_session', {
      workspace_path: pane.workspacePath,
      stage_index: stageIndex,
      slot_label: pane.slotLabel,
      session_id: id,
    })
  }
  if (saved) {
    persistedPaneSessions.add(key)
    persistPaneAttempts.delete(key)
  } else {
    // Unconfirmed (pane record missing). Retry a bounded number of times for the
    // transient spawn race, then stop so a permanently-missing pane can't flood
    // manual_pane.session on every activity event.
    const attempts = (persistPaneAttempts.get(key) ?? 0) + 1
    persistPaneAttempts.set(key, attempts)
    if (attempts >= MAX_PERSIST_PANE_ATTEMPTS) persistedPaneSessions.add(key)
  }
}

// A pane refuses keystrokes for as long as preparationStatus is neither 'ready'
// nor 'failed', and the steps in between are unbounded waits (an 8s dialog
// watch, a quiet-settle, a role injection). That whole window was invisible
// after the fact, so "the pane ignored my first few characters" could not be
// attributed to a step. Each transition now records how long the step it is
// leaving actually took.
const prepStageEnteredAt = new Map<string, number>()
function setPrepStatus(pane: ActivePane, next: ActivePane['preparationStatus']): void {
  const prev = pane.preparationStatus
  pane.preparationStatus = next
  if (prev === next) return
  const now = Date.now()
  const enteredAt = prepStageEnteredAt.get(pane.id)
  const spent = enteredAt === undefined ? '' : ` after=${now - enteredAt}ms`
  if (next === 'ready' || next === 'failed') prepStageEnteredAt.delete(pane.id)
  else prepStageEnteredAt.set(pane.id, now)
  diagLog(
    terminalPort,
    'pane-prep',
    `pane=${pane.id.slice(0, 8)} agent=${pane.agentKey} ${prev}->${next}${spent}`
  )
}

function scheduleInjection(pane: ActivePane): void {
  pane.injectionStatus = 'scheduled'
  setPrepStatus(pane, 'checking-dialog')
  syncViews()
  const tag = `[pane ${pane.id.slice(0, 8)}]`
  const startedAt = Date.now()
  ;(async () => {
    // 1. Try to dismiss a startup trust dialog (best-effort, up to 8s).
    pipelineLog(`${tag} watching for startup dialog (up to ${DISMISS_TIMEOUT_MS / 1000}s)`)
    const dismissed = await dismissStartupDialog(pane.id, DISMISS_TIMEOUT_MS)
    if (!paneAlive(pane.id)) return
    if (!dismissed) {
      pipelineLog(`${tag} no dialog detected — proceeding`)
      // Dump the buffer head so we can diagnose unrecognised CLI startup
      // screens. Trim to ~300 chars and replace whitespace runs for one-line
      // legibility in the log.
      const r = paneRefs[pane.id]
      const buf = ((r?.cleanBuffer as unknown as string) ?? '').slice(0, 300)
      if (buf) {
        pipelineLog(`${tag} buffer head: ${buf.replace(/\s+/g, ' ').trim().slice(0, 280)}`)
      }
    }

    // 2. Quiet-based settle — proceed as soon as the first screen stops
    //    rendering, with the previous fixed delays kept as upper bounds. After
    //    a dismiss the CLI repaints, so require a fresh quiet window; without
    //    one the buffer is already quiet (dismissStartupDialog proved it), so
    //    a short confirmation suffices.
    setPrepStatus(pane, 'settling')
    syncViews()
    await waitForQuiet(pane.id, dismissed ? 2000 : 1000, dismissed ? 2500 : ROLE_PROMPT_DELAY_MS)
    if (!paneAlive(pane.id)) return

    // 3. Inject role system prompt — unless this is a pre-spawn pane that
    //    will receive role + kickoff together at activation time.
    if (!pane.roleKey) {
      pane.injectionStatus = 'skipped'
      setPrepStatus(pane, 'ready')
      syncViews()
      pipelineLog(`${tag} ⏸ no role selected — skipping role injection`)
      if (pane.origin !== 'pipeline' && pinsSessionAtLaunch(pane.agentKey) && pane.pinnedSessionId) {
        void persistPaneSession(pane, pane.pinnedSessionId)
      }
      return
    }
    if (pane.skipRoleInjection) {
      pane.injectionStatus = 'skipped'
      setPrepStatus(pane, 'ready')
      syncViews()
      pipelineLog(`${tag} ⏸ role deferred (pre-spawn — will inject at stage activation)`)
      return
    }
    // Injection guards. Floor: hold until MIN_INJECTION_LEAD_MS has passed
    // since dialog-watching began, so a fast first paint + silent load can't
    // land the prompt before the CLI reads stdin. Late dialog: a CLI that
    // pauses longer than NO_DIALOG_QUIET_MS between banner and trust dialog
    // slips past the watcher — re-check once and dismiss before typing a
    // multi-line prompt into the dialog.
    const lead = Date.now() - startedAt
    if (lead < MIN_INJECTION_LEAD_MS) {
      await sleep(MIN_INJECTION_LEAD_MS - lead)
      if (!paneAlive(pane.id)) return
    }
    if (!dismissed) {
      const lateBuf = ((paneRefs[pane.id]?.cleanBuffer as unknown as string) ?? '')
      if (TRUST_DIALOG_PATTERNS.some((re) => re.test(lateBuf))) {
        pipelineLog(`${tag} late startup dialog detected — dismissing`)
        const r = paneRefs[pane.id]
        if (r?.sessionId) {
          await backend.send('terminal.input', {
            terminal_session_id: r.sessionId as string,
            data: '\r'
          })
        }
        await waitForQuiet(pane.id, 2000, 2500)
        if (!paneAlive(pane.id)) return
      }
    }
    const role = rolesApi.find(pane.roleKey)
    if (!role) {
      pane.injectionStatus = 'failed'
      setPrepStatus(pane, 'failed')
      syncViews()
      pipelineLog(`${tag} ✕ role '${pane.roleKey}' not found in registry`)
      return
    }
    // Embed the session marker in the role prompt too (Codex/Antigravity), not just
    // the kickoff — the role is injected at pre-spawn, so the marker lands in
    // the session file (and gets detected) within seconds, instead of waiting
    // for this slot's stage to activate (which for late stages is much later).
    const roleContent = role.system_prompt + ROLE_STANDBY_SUFFIX + sessionMarkerLine(pane.sessionMarker)
    pipelineLog(`${tag} ➜ injecting role '${role.label}' (${roleContent.length} chars)`)
    setPrepStatus(pane, 'injecting-role')
    syncViews()
    await acquireInjectionSlot()
    let ok: boolean
    try {
      // bracketed paste (preserveNewlines) — same as kickoff — so the multi-line
      // role prompt isn't sent as a raw keystroke burst that floods the PTY
      // input buffer (EAGAIN drops) and re-renders on every embedded newline.
      ok = await injectPane(pane.id, roleContent, `role:${role.label}`, true)
    } finally {
      releaseInjectionSlot()
    }
    pane.injectionStatus = ok ? 'sent' : 'failed'
    setPrepStatus(pane, ok ? 'ready' : 'failed')
    syncViews()
    if (ok && pane.origin !== 'pipeline' && pinsSessionAtLaunch(pane.agentKey) && pane.pinnedSessionId) {
      void persistPaneSession(pane, pane.pinnedSessionId)
    }
    if (!ok) {
      // Honest record: role injection didn't land (e.g. truncated mid-text).
      // Continue to the kickoff anyway — the agent may still recover, and the
      // watcher backstop covers a genuine no-start.
      pipelineLog(`${tag} ✕ role injection failed (agent didn't react) — continuing to kickoff anyway`)
    } else {
      pipelineLog(`${tag} ✓ role prompt sent`)
    }

    // 4. Inject kickoff prompt (pipeline panes only) — but only AFTER the
    //    agent has acknowledged the role prompt (started responding, then
    //    settled). This prevents the kickoff from being interleaved into
    //    the agent's role-acknowledgement output.
    if (pane.kickoffStatus === 'pending') {
      pipelineLog(`${tag} waiting for agent to acknowledge role (up to 30s)`)
      setPrepStatus(pane, 'waiting-agent')
      syncViews()
      const result = await waitForActivityThenSettle(pane.id, 2500, 30_000)
      if (!paneAlive(pane.id)) return
      if (result === 'no-activity') {
        pipelineLog(`${tag} ⚠ agent silent after role — sending kickoff anyway`)
      } else if (result === 'timeout') {
        pipelineLog(`${tag} ⚠ agent still streaming — sending kickoff anyway`)
      } else {
        pipelineLog(`${tag} ✓ agent settled — proceeding`)
      }
      pipelineLog(`${tag} ➜ injecting kickoff (${pane.kickoffPrompt.length} chars)`)
      // Use bracketed-paste so newlines in the context header (prior-stage
      // documents) are preserved — without it they become Enter keypresses
      // and fragment the prompt into multiple partial submissions.
      const MAX_KICKOFF_ATTEMPTS = 3
      let ok2 = false
      for (let attempt = 1; attempt <= MAX_KICKOFF_ATTEMPTS; attempt++) {
        ok2 = await injectPane(pane.id, pane.kickoffPrompt, `kickoff:stage-${pane.stageId}`, true)
        if (ok2) break
        if (attempt < MAX_KICKOFF_ATTEMPTS) {
          pipelineLog(`${tag} ✕ kickoff injection failed (attempt ${attempt}/${MAX_KICKOFF_ATTEMPTS}) — retrying in 3s`)
          await sleep(3_000)
          if (!paneAlive(pane.id)) return
        }
      }
      pane.kickoffStatus = ok2 ? 'sent' : 'failed'
      setPrepStatus(pane, ok2 ? 'ready' : 'failed')
      syncViews()
      if (!ok2) {
        pipelineLog(`${tag} ✕ kickoff injection failed after ${MAX_KICKOFF_ATTEMPTS} attempts — arming watcher anyway`)
      } else {
        pipelineLog(`${tag} ✓ kickoff sent`)
      }

      // 5. Arm watcher. For question-interactive stages (P01) capture scanFrom
      //    after kickoff confirmation; for other stages pass undefined so the
      //    watcher uses markBufferPosition() and agentGenerating handles pacing.
      if (pane.origin === 'pipeline') {
        const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
        if (stageIndex >= 0) {
          const stageAllowsQ = stagesApi.stages.value[stageIndex]?.allowQuestions ?? false
          const kickoffScanFrom2 = stageAllowsQ
            ? (paneRefs[pane.id]?.markBufferPosition as () => number | undefined)?.()
            : undefined
          startStageWatcher(stageIndex, pane.id, kickoffScanFrom2)
        }
      }
    }
  })()
}

interface SpawnInternal {
  agentKey: string
  roleKey: RoleKey
  stageId: StageId
  /** User-set pane title. Runtime replacements such as rebuild must carry it
   *  forward because they receive a new pane id. */
  customName?: string
  /** Whether the user has ever named this pane. Carried forward on
   *  rebuild/restore, or the new pane id would look never-named and the
   *  auto-namer would title a pane the user already claimed. */
  nameLocked?: boolean
  /** Auto-derived pane title, carried forward on rebuild/restore for the same reason. */
  autoName?: string
  /** Which namer produced autoName. Carried forward so a restored pane whose
   *  title the model already wrote is not sent for naming a second time. */
  autoNameSource?: 'heuristic' | 'llm'
  /** Human-readable slot label — set for parallel-stage slots so the context
   *  header for downstream stages can identify which agent produced which output. */
  slotLabel?: string
  commandOverride: string
  workspacePath: string
  origin: 'manual' | 'pipeline' | 'mcp'
  runGroupId?: string
  previousPaneId?: string
  kickoffPrompt?: string
  skipRoleInjection?: boolean
  /** True when commandOverride is a `--resume`/`resume` command restoring a
   *  prior session. Suppresses the fresh Claude --session-id and the
   *  Codex/Antigravity detection marker — the session id is already known. */
  isResume?: boolean
  /** Pipeline stage index. */
  stageIndex?: number
  /** Restore mode label for the agent history badge. */
  restoreMode?: 'memory-resume' | 'fresh'
  sessionHomeId?: string
  /** CLI account pin carried through a restore: the profile_id this pane was
   *  spawned on ("__default__" = unmanaged real home). Sent to the backend so
   *  the pane re-spawns on the SAME account regardless of the current active
   *  default. Undefined for a fresh spawn (backend binds+records the active
   *  default). */
  profileId?: string
  resumeSessionId?: string
  /** True when the caller PROBED the saved session (canResumeSession === true)
   *  and confirmed its transcript exists on disk, but this spawn is NOT a
   *  resume (restore where the user chose "start fresh"). Pins resumeSessionId
   *  on the pane with sessionOnDisk so the Rebuild (resume) button stays
   *  enabled. Never set for brand-new (non-restored) panes. */
  sessionKnownOnDisk?: boolean
  /** Explicit --session-id for a FRESH (non-resume) Claude spawn. The restore
   *  fallback for a not-resumable session passes the saved id here so a
   *  cold-start rebuild reuses the SAME id instead of minting a new ghost id
   *  on every restart. Ignored when isResume or for other agents. */
  freshSessionId?: string
  /** Instructs spawnPane to atomically replace an existing pane's position in the UI array. */
  replacePaneId?: string
  /** Persisted messaging name carried through a restore so inter-CLI messaging
   *  addresses survive restart. */
  preferredMessagingName?: string
  /** Pane ids the CLI this pane may reattach to was reachable under before.
   *  Only ever the immediate predecessor is needed — the backend flattens the
   *  chain, so A→B→C leaves both A and B pointing at C. */
  formerPaneIds?: string[]
  /** Parent pane id for an agent-requested spawn (SPAWN block). Runtime-only
   *  lineage for the spawn-depth/quota gate; never persisted. */
  spawnedBy?: string
  /** CLI account profile id for an isolated LOGIN pane: the backend spawns the
   *  CLI inside that profile's login home so signing in never touches the live
   *  credentials or running panes. Never persisted — a restored pane respawns
   *  as a normal (live-home) pane. */
  loginProfileId?: string
  /** True for a LOGIN pane (Settings → CLI accounts sign-in, isolated or
   *  live). Suppresses the Codex/Grok/Kimi session marker — and with it the
   *  marker bootstrap, whose dismissStartupDialog + pasted marker + Enter
   *  would inject input into the CLI's interactive sign-in wizard. */
  isLogin?: boolean
  /** Runtime-only restore marker kept on replacement panes until first output. */
  restoring?: boolean
}

// Vendors whose fresh panes get an `at-pane:` session marker (declared per
// spec via needsSessionMarker), and the subset that then WAITS for a session
// id to be detected from it — aider carries the marker for attribution but has
// no session ids at all (no resumeArgs), so nothing ever arrives to wait for.
const SESSION_MARKER_AGENTS = new Set(
  agentSpecs.filter((s) => s.needsSessionMarker).map((s) => s.agentKey)
)
const SESSION_ID_WAIT_AGENTS = new Set(
  agentSpecs.filter((s) => s.needsSessionMarker && s.resumeArgs).map((s) => s.agentKey)
)

/** Trailing line embedded in a Codex/Antigravity kickoff so the backend can match
 *  the resulting CLI session file back to this pane (those CLIs can't pin a
 *  session id at launch). Innocuous to the agent; only the marker text matters.
 *  Empty marker (Claude / manual panes) → no line added. */
function sessionMarkerLine(marker?: string): string {
  return marker ? `\n\n<!-- agent-team-session: ${marker} -->` : ''
}

async function sendSessionMarkerBootstrap(pane: ActivePane, tag: string): Promise<boolean> {
  const markerText = sessionMarkerLine(pane.sessionMarker).trim()
  if (!markerText) return false
  try {
    await dismissStartupDialog(pane.id, DISMISS_TIMEOUT_MS)
    if (!(await waitForStartupActivity(pane.id))) {
      pipelineLog(`${tag} ⚠ no startup activity detected — session marker not sent`)
      return false
    }
    await waitForQuiet(pane.id, 1000, 8000)
    if (!paneAlive(pane.id)) return false
    const ref = paneRefs[pane.id]
    if (!ref?.sessionId) return false
    backend.send('terminal.log_sent', {
      terminal_session_id: ref.sessionId as string,
      label: `session-marker:${pane.agentKey}`,
      text: markerText
    }).catch(() => {/* ignore */})
    await backend.send('terminal.input', {
      terminal_session_id: ref.sessionId as string,
      data: BRACKETED_PASTE_START + markerText + BRACKETED_PASTE_END
    })
    await sleep(250)
    await backend.send('terminal.input', {
      terminal_session_id: ref.sessionId as string,
      data: '\r'
    })
    // The marker is a real prompt, so the CLI will answer it. Arm the gate that
    // keeps that answer from being treated as a turn the user asked for.
    pane.markerReplyPending = true
    pipelineLog(`${tag} ✓ session marker sent for resume capture`)
    return true
  } catch (err) {
    console.error('[sendSessionMarkerBootstrap] failed:', err)
    pipelineLog(`${tag} ⚠ session marker send failed — resume id may stay unknown`)
    return false
  }
}

async function spawnPane(opts: SpawnInternal): Promise<string | null> {
  const spec = agentSpecs.find((s) => s.agentKey === opts.agentKey)
  if (!spec) return null
  const id = crypto.randomUUID()
  // Specs with a per-pane argument (aider's private chat-history file) need the
  // pane id AND the directory the backend log reader watches. Without a cwd
  // there is nothing to resolve, so the spec falls back to its shared default.
  const paneArgCtx: PaneArgContext | undefined = spec.paneArg && opts.workspacePath
    ? { paneId: id, historyRoot: await paneHistoryRootFor(opts.agentKey, opts.workspacePath) }
    : undefined
  let command = resolveCommand(opts.agentKey, opts.commandOverride, paneArgCtx)
  const userShell = backend.shell.value || 'bash'

  if (opts.agentKey === 'terminal' && !command) {
    command = userShell
  }

  // For Claude, pin a unique --session-id so backend attribution maps THIS
  // pane's CLI events (turn_complete / agent_active / JSONL) precisely. Without
  // it, panes sharing one workspace are matched by a first-come-claim heuristic
  // that mis-routed a pane's turn_complete to a sibling (the Stage 01 bug).
  // freshSessionId (restore fallback of a not-resumable session) reuses the
  // saved id instead of minting a new one — see pinFreshSessionAtLaunch.
  const pinned = pinFreshSessionAtLaunch(
    opts.agentKey, opts.isResume ?? false, command, opts.freshSessionId,
    () => crypto.randomUUID()
  )
  command = pinned.command
  const explicitSessionId = pinned.explicitSessionId
  const sessionHomeId = sessionHomeIdFor(opts.agentKey, id, opts.sessionHomeId)
  const pinnedSessionId = opts.isResume
    ? (opts.resumeSessionId?.trim() || undefined)
    : (explicitSessionId || undefined)
  // Restore-with-confirmed-transcript: the caller probed the saved session and
  // its transcript exists on disk, but this spawn is fresh (user chose "start
  // fresh"). Pin the saved id on the PANE (any agent) so the Rebuild (resume)
  // button stays enabled after restart. The backend metadata/resumeKey below
  // keep using pinnedSessionId — the LAUNCH identity — so attribution still
  // binds the CLI's actual session, not the saved one.
  const restoredPinnedId = !opts.isResume && opts.sessionKnownOnDisk
    ? (opts.resumeSessionId?.trim() || undefined)
    : undefined
  // Codex keeps a marker fallback during rollout. Antigravity can't pin an id
  // at launch (`agy --conversation` only resumes existing ids), so the marker
  // is its ONLY session-binding path. Grok likewise can't pin an id (`grok -s`
  // only resumes existing ids) — marker-based binding via ~/.grok/grok.db.
  // Kimi likewise can't pin an id (`kimi --session` only resumes existing ids);
  // its session id is captured from the wire.jsonl containing the marker.
  // OpenCode likewise can't pin an id (`opencode --session` only resumes
  // existing ids) — marker-based binding.
  // Qwen Code joins the marker camp too (launch-time id pinning is not relied
  // on; `qwen --resume` only resumes existing ids).
  // Kilo Code likewise can't pin an id (`kilo --session` only resumes existing
  // ids) — marker-based binding.
  // Pi COULD pin an id at launch (`pi --session-id` creates the session when
  // the id doesn't exist) but joins the marker camp for now; launch-time
  // pinning is a later unified refactor.
  // Copilot COULD pin an id at launch too, but via `copilot --session-id <id>`
  // ("Resume an existing session or task by ID, or set the UUID for a new
  // session" — 1.0.78 --help), NOT via the `--resume=<id>` this app spawns:
  // 1.0.78 scopes --resume to an id that already exists. It joins the marker
  // camp for now; launch-time pinning is a later unified refactor.
  // Cursor joins the marker camp: its create-chat pin path has a known hang
  // bug, so launch-time id pinning is not used.
  // Aider joins the marker camp: it has no session ids, but the typed marker
  // is written verbatim (`#### at-pane:<id>`) into the project's
  // .aider.chat.history.md, so a future backend reader can bind the pane.
  // No "detecting session" overlay for aider (see paneWaitingForSessionId):
  // with no id to detect, session.detected never fires and the overlay would
  // only ever expire via its grace timeout.
  // Login panes get NO marker: they sit at an interactive sign-in wizard, and
  // the marker bootstrap (dismissStartupDialog + pasted marker + Enter) would
  // inject input into it. No marker also means no session overlay for them.
  const sessionMarker =
    !opts.isResume && !opts.isLogin && SESSION_MARKER_AGENTS.has(opts.agentKey)
      ? `at-pane:${id}`
      : ''
  const pane: ActivePane = {
    id,
    realized: true,
    restoring: opts.restoring,
    agentKey: opts.agentKey,
    agentLabel: spec.label,
    customName: opts.customName,
    nameLocked: opts.nameLocked,
    autoName: opts.autoName,
    autoNameSource: opts.autoNameSource,
    roleKey: opts.roleKey,
    stageId: opts.stageId,
    slotLabel: opts.slotLabel ?? '',
    command,
    workspacePath: opts.workspacePath,
    origin: opts.origin,
    runGroupId: opts.runGroupId,
    injectionStatus: 'pending',
    preparationStatus: 'starting',
    injectionTimer: null,
    kickoffStatus: opts.kickoffPrompt ? 'pending' : 'none',
    kickoffPrompt: opts.kickoffPrompt ?? '',
    skipRoleInjection: opts.skipRoleInjection ?? false,
    pinnedSessionId: restoredPinnedId ?? pinnedSessionId,
    sessionOnDisk: opts.isResume || restoredPinnedId ? true : undefined,
    pinnedFromRestore: restoredPinnedId ? true : undefined,
    sessionHomeId: sessionHomeId || undefined,
    profileId: opts.profileId || undefined,
    sessionMarker: sessionMarker || undefined,
    spawnedBy: opts.spawnedBy,
    formerPaneIds: opts.formerPaneIds?.length ? [...opts.formerPaneIds] : undefined,
  }
  // If this spawn carries its kickoff directly (fallback path), embed the
  // marker now. Pre-spawned panes get it at activateStage injection time.
  if (sessionMarker && pane.kickoffPrompt) {
    pane.kickoffPrompt += sessionMarkerLine(sessionMarker)
  }

  if (opts.replacePaneId) {
    const wasFocused = focusPaneId.value === opts.replacePaneId
    // A replacement takes over the pane's identity, messaging handle included,
    // and gets a fresh runtime id to do it. Release the old id's registration
    // first: leave it and the handle is still taken when the new pane asks for
    // it, so it comes back suffixed (`name-2`) and a pane the user addresses by
    // name is silently renamed under them. The persisted name stays — it is
    // exactly what the replacement is about to claim.
    if (opts.replacePaneId !== id) {
      unregisterPaneMessaging(opts.replacePaneId, { keepPersisted: true })
    }
    const idx = panes.value.findIndex(p => p.id === opts.replacePaneId)
    if (idx >= 0) panes.value.splice(idx, 1, pane)
    else panes.value.push(pane)
    if (wasFocused) selectPane(id, { userInitiated: false })
  } else {
    panes.value.push(pane)
  }

  // Inter-CLI messaging: give every CLI pane an addressable name (restored
  // panes carry their previous name via preferredMessagingName).
  registerPaneMessaging(pane, opts.preferredMessagingName)

  // Auto-name from the kickoff task material. The heuristic titles the pane
  // now; the model upgrades that title if it can. Write ordering lives in
  // setPaneAutoName: no-op when a customName or autoName was carried in.
  if (opts.kickoffPrompt) {
    setPaneAutoName(id, deriveAutoName(opts.kickoffPrompt))
    requestLlmPaneName(id, opts.kickoffPrompt)
  }

  // Session detection can legitimately take forever (a fresh CLI sits at its
  // own setup dialog until the user acts), so the blocking overlay gets a hard
  // grace window; after it the pane is usable while detection continues.
  if (sessionMarker) {
    window.setTimeout(() => {
      if (pane.sessionMarker && !pane.pinnedSessionId) {
        pane.sessionOverlayExpired = true
        syncViews()
      }
    }, SESSION_OVERLAY_GRACE_MS)
  }
  if (entryBelongsToWorkspace({ workspacePath: pane.workspacePath }, spawnHistoryWorkspaceIdentity(currentWorkspace.value))) {
    spawnHistory.value.push({
      paneId: id,
      agentKey: pane.agentKey,
      agentLabel: pane.agentLabel,
      customName: pane.customName,
      autoName: pane.autoName,
      roleKey: pane.roleKey,
      roleLabel: roleLabel(pane.roleKey),
      command: pane.command,
      sessionId: pane.pinnedSessionId,
      origin: pane.origin,
      stageId: pane.stageId,
      workspacePath: pane.workspacePath,
      spawnedAt: new Date().toISOString(),
      restoreMode: opts.restoreMode,
      sessionHomeId: pane.sessionHomeId,
      runGroupId: pane.runGroupId,
    })
  } else {
    console.warn(
      `[spawn-history] skipped entry for foreign workspace "${pane.workspacePath}" (current: "${currentWorkspace.value}")`,
    )
  }
  await nextTick()
  const ref = paneRefs[id]
  if (!ref) return id
  try {
    // Always write the agent conversation to a dedicated log file. Pipeline
    // panes land inside the run sub-folder (runs/YYYYMMDD-HHmmss-task/) so
    // each run is self-contained; manual panes land under a flat manual/
    // folder grouped by date so they're still recoverable.
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const outputLogFile = opts.workspacePath
      ? opts.origin === 'pipeline'
        ? pipeline.runDir
          ? `${opts.workspacePath}/.agent-team/${pipeline.runDir}/stage-${opts.stageId}-${id.slice(0, 8)}.log`
          : `${opts.workspacePath}/.agent-team/stage-${opts.stageId}-${id.slice(0, 8)}.log`
        : `${opts.workspacePath}/.agent-team/manual/${ymd}/${opts.agentKey}-${id.slice(0, 8)}.log`
      : undefined
    pane.outputLogFile = outputLogFile

    await ref.spawn({
      // zsh reads ~/.zshrc (where installers add PATH, e.g. Claude Code's
      // ~/.local/bin) only in interactive mode — plain -lc misses it.
      command: [userShell, userShell.endsWith('zsh') ? '-ilc' : '-lc', command],
      cwd: opts.workspacePath,
      agentKey: opts.agentKey,
      metadata: {
        roleKey: opts.roleKey,
        stageId: opts.stageId,
        stage_id: opts.stageId,                 // snake_case alias for backend token sink
        origin: opts.origin,
        workspace_path: opts.workspacePath ?? '',
        explicit_session_id: pinnedSessionId || explicitSessionId,  // Claude/Antigravity --session-id → precise pane attribution
        session_marker: sessionMarker,           // Codex → marker fallback session detection
        session_home_id: sessionHomeId,           // Codex per-pane CODEX_HOME id
        slot_label: opts.slotLabel ?? '',         // stable by_pane key survives frontend restarts
        profile_id: opts.profileId ?? '',        // CLI account pin (restore) → per-pane isolated home
      },
      outputLogFile,
      // Stable reattach key: the pinned CLI session id is identical on first
      // spawn and on restore (claude --session-id), so a reload reattaches to
      // the live PTY instead of starting a second `--resume` that collides.
      resumeKey: pinnedSessionId,
      // Resume panes must create at the real width (reprint); fresh panes may
      // create immediately even while hidden (empty CLI) so a pipeline stage
      // spawned into a non-active tab still starts.
      isResume: opts.isResume,
      restoreMode: opts.restoreMode,
      skipReattach: opts.restoreMode === 'fresh',
      loginProfileId: opts.loginProfileId,
    })

    // The path above is derived from THIS pane's id, but a spawn that
    // reattached to a surviving PTY never reached terminal.create, so nothing
    // opened that file — the conversation is in the log the PTY opened under
    // its original id, which the reattach reports back. Prefer it: recording
    // the derived name would point Agent History at a file that never exists,
    // which is exactly the "Failed to read log file … ENOENT" it used to show
    // for every restored pane.
    const effectiveLogFile = ref.attachedOutputLogFile || outputLogFile
    if (effectiveLogFile !== outputLogFile) pane.outputLogFile = effectiveLogFile

    // The history entry was pushed before this path was known — back-fill it
    // now so Agent History preview can read the real file. This must happen
    // after spawn(): the backend creates the log file when it opens the PTY,
    // and Agent History auto-selects the newest entry during the nextTick
    // above, so back-filling any earlier points the preview at a file that
    // does not exist yet and the failed read sticks.
    const historyEntry = spawnHistory.value.find((e) => e.paneId === id)
    if (historyEntry) historyEntry.outputLogFile = effectiveLogFile

    // Arm the always-on login-expired watcher for CLIs with a detection spec
    // (the interval self-cleans once the pane is gone or its terminal exited).
    if (loginCommandFor(opts.agentKey) != null) startLoginExpiredWatcher(id)

    if ((ref.status as unknown as string) === 'running') {
      if (pane.origin !== 'pipeline' && !pane.roleKey && !pane.kickoffPrompt) {
        pane.injectionStatus = 'skipped'
        setPrepStatus(pane, 'ready')
        syncViews()
        // No persistPaneSession here: every manual/snap/saved caller sends
        // manual_pane.spawn with this same pinned session_id right after we
        // return, and that call is what creates the PaneRecord. Persisting
        // from inside spawnPane always lost that race and made the backend
        // log 'pane ... not found — session not persisted' once per pane.
        return id
      }
      scheduleInjection(pane)
    } else if ((ref.status as unknown as string) === 'starting') {
      // A resume parked on a hidden tab returns 'starting' — its PTY (and the
      // --resume) is created when the tab is shown. Resume reloads memory, so
      // nothing is injected; this is a ready pane, NOT a spawn failure.
      pane.injectionStatus = 'skipped'
      setPrepStatus(pane, 'ready')
    } else {
      pane.injectionStatus = 'skipped'
      setPrepStatus(pane, 'failed')
    }
  } finally {
    syncViews()
  }
  return id
}

async function onManualSpawn(payload: SpawnPayload): Promise<string | null> {
  // The synthetic manual tab deliberately has no run-group id; a real tab
  // keeps its own id instead of falling back to a background pipeline group.
  //
  // Only when spawning into the workspace on screen, though. Run groups are
  // per-workspace and only the viewed one's are loaded, so stamping a pane
  // bound for another workspace with an id from THIS one's set gives it a
  // group no tab over there lists — the pane lands in the sidebar and on no
  // tab at all, which is indistinguishable from the spawn having failed.
  const target = payload.workspacePath || currentWorkspace.value
  const onScreen = normWs(target) === normWs(currentWorkspace.value)
  const spawnGroupId = onScreen
    ? resolveManualSpawnGroupId(runGroups.value, activeTab.value)
    : ''
  const paneId = await spawnPane({
    agentKey: payload.agentKey,
    roleKey: payload.roleKey,
    stageId: payload.stageId,
    customName: payload.customName,
    commandOverride: '',
    workspacePath: payload.workspacePath,
    origin: 'manual',
    runGroupId: spawnGroupId || undefined,
    loginProfileId: payload.loginProfileId,
    isLogin: payload.isLogin,
  })
  if (paneId) {
    const resp = await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: payload.workspacePath,
      pane_id: paneId,
      agent: payload.agentKey,
      role: payload.roleKey,
      command: '',
      // Claude's pinned --session-id is known at spawn: pass it here so the
      // record is created with it atomically (a separate manual_pane.session
      // call would race this spawn and silently noop on the backend).
      session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
      session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
      run_group_id: spawnGroupId,
      output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    })
    // The backend resolved+recorded the active default account for this fresh
    // spawn; read it back onto the local pane so an in-session rebuild resumes
    // on the same account even if the active default is switched meanwhile.
    const recordedPin = resp?.project?.panes?.find((p) => p.pane_id === paneId)?.profile_id
    const spawnedPane = panes.value.find((p) => p.id === paneId)
    if (spawnedPane && recordedPin) spawnedPane.profileId = recordedPin
    if (payload.customName) {
      await sendQuiet('project.rename_pane', {
        workspace_path: payload.workspacePath,
        pane_id: paneId,
        custom_name: payload.customName,
      })
    }
    const pane = panes.value.find((p) => p.id === paneId)
    if (
      pane && pane.agentKey !== 'terminal' &&
      pane.sessionMarker &&
      !pane.roleKey && !pane.kickoffPrompt
    ) {
      void sendSessionMarkerBootstrap(pane, `[pane ${pane.id.slice(0, 8)}]`)
    }
  }
  return paneId
}

// Settings → CLI accounts "login": spawn a manual pane whose CLI runs its
// direct sign-in flow (the backend rewrites the command, e.g. `claude auth
// login`). With `loginProfileId`, the pane runs in that profile's isolated
// login home (sign-in lands in the profile's slot; the active account and
// running panes are untouched). Settings closes only after the pane actually
// spawned — a failed spawn keeps the modal open and surfaces the error.
// Login panes pending browser authorization, keyed by profile id. Only THIS
// window (the one that spawned the pane) holds an entry, so exactly one
// window closes the pane and toasts when the harvest broadcast arrives.
const pendingLoginPanes = new Map<string, { paneId: string; agentKey: string }>()

async function onCliLoginSpawn(agentKey: string, loginProfileId?: string): Promise<void> {
  if (!currentWorkspace.value) {
    notifyRestore.toast(i18n.global.t('settings.accounts.cli.login-no-workspace'), { type: 'error' })
    return
  }
  const paneId = await onManualSpawn({
    agentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    workspacePath: currentWorkspace.value,
    loginProfileId,
    isLogin: true,
  })
  const ref = paneId ? paneRefs[paneId] : null
  if (!paneId || (ref?.status as unknown as string) === 'error') {
    const reason = (ref?.error as unknown as string) || ''
    notifyRestore.toast(
      i18n.global.t('settings.accounts.cli.login-spawn-failed') + (reason ? ` (${reason})` : ''),
      { type: 'error' }
    )
    if (paneId) void onKill(paneId)
    return
  }
  showSettings.value = false
  if (loginProfileId) pendingLoginPanes.set(loginProfileId, { paneId, agentKey })
  // The user must see the pane that is waiting for the browser authorization.
  onFocusPane(paneId)
}

// Plan window "execute" dispatch: inject the plan-execution prompt into an
// idle same-agent pane, or spawn a fresh manual pane for the chosen agent.
// Every outcome past validation is reported back via plans:execution-result
// so the plan window can confirm the dispatch or roll back its execution
// record (validation failures stay silent — wrong window, not a failure).
async function onPlanExecutionDispatch(payload: PlanDispatchPayload): Promise<void> {
  const valid = validatePlanDispatch(payload, currentWorkspace.value)
  if (!valid) return // wrong window / malformed payload — safe ignore
  const { relPath, agentKey } = valid
  const workspacePath = payload.workspace_path as string // validated non-empty string
  await runReportedDispatch(
    () => dispatchPlanToPane(relPath, agentKey),
    (ok, reason) =>
      window.agentTeam?.reportPlanExecutionResult?.({
        workspace_path: workspacePath,
        rel_path: relPath,
        ok,
        ...(reason ? { reason } : {}),
      })
  )
}

async function dispatchPlanToPane(relPath: string, agentKey: string): Promise<PlanDispatchOutcome> {
  const prompt = planExecutionPrompt(relPath)

  const reusable = pickReusablePane(
    panes.value.map((p) => ({
      id: p.id,
      agentKey: p.agentKey,
      workspacePath: p.workspacePath,
      status: (paneRefs[p.id]?.displayStatus as string | undefined) ?? 'starting',
      sessionId: (paneRefs[p.id]?.sessionId as string | undefined) ?? undefined,
    })),
    agentKey,
    currentWorkspace.value
  )
  if (reusable) {
    selectPane(reusable.id, { userInitiated: false })
    const injected = await injectPane(reusable.id, prompt, 'plan-execute', true)
    return injected ? { ok: true } : { ok: false, reason: 'inject-failed' }
  }

  // Create path. The prompt is deliberately NOT passed as spawnPane's
  // kickoffPrompt: scheduleInjection early-returns for roleless panes
  // (`if (!pane.roleKey)`) before its kickoff step, so a roleless manual
  // pane's kickoffPrompt is never injected. Instead mirror onManualSpawn
  // (same spawn + manual_pane.spawn persistence; YOLO flag applied inside
  // spawnPane via resolveCommand), then AWAIT the session-marker bootstrap
  // (onManualSpawn fires it void) so the marker protocol lands before —
  // never interleaved with — the plan prompt, and finally inject the prompt.
  const spawnGroupId = resolveManualSpawnGroupId(runGroups.value, activeTab.value)
  const paneId = await spawnPane({
    agentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    commandOverride: '',
    workspacePath: currentWorkspace.value,
    origin: 'manual',
    runGroupId: spawnGroupId || undefined,
  })
  if (!paneId) return { ok: false, reason: 'pane-spawn-failed' }
  await sendQuiet<ProjectPayload>('manual_pane.spawn', {
    workspace_path: currentWorkspace.value,
    pane_id: paneId,
    agent: agentKey,
    role: '',
    command: '',
    session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
    session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
    run_group_id: spawnGroupId,
    output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
  })
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return { ok: false, reason: 'pane-spawn-failed' }
  selectPane(paneId, { userInitiated: false })
  const bootstrapped = await sendSessionMarkerBootstrap(pane, `[pane ${paneId.slice(0, 8)}]`)
  if (!bootstrapped) {
    // No marker/hint text to send (or the send failed): settle CLI startup
    // ourselves with the same waits the bootstrap path uses before injecting.
    await dismissStartupDialog(paneId, DISMISS_TIMEOUT_MS)
    await waitForStartupActivity(paneId)
  }
  await waitForQuiet(paneId, 1000, 8000)
  // Failed dispatch rolls the spawn back (kill PTY + undo manual_pane.spawn)
  // — mirrors the backend's terminal.create rollback; without it the pane and
  // its CLI linger with nothing to do.
  if (!paneAlive(paneId)) {
    await onKill(paneId)
    return { ok: false, reason: 'pane-exited' }
  }
  const injected = await injectPane(paneId, prompt, 'plan-execute', true)
  if (!injected) {
    await onKill(paneId)
    return { ok: false, reason: 'inject-failed' }
  }
  return { ok: true }
}

// Resume an existing agent session by id (Manual Spawn → Resume button). Reuses
// the same resume path as boot-restore: validate → buildResumeCommand → spawnPane
// with isResume/skipRoleInjection. No role is injected (the session already
// carries its own context).
// `historyPaneId`: the id of the pane whose per-pane files this resume belongs
// to (Agent History knows it; the ad-hoc Resume field does not). Without it an
// aider resume falls back to whatever the history root already holds.
async function onManualResume(payload: { agentKey: string, workspacePath: string, sessionId: string, customName?: string, nameLocked?: boolean, autoName?: string, runGroupId?: string, historyPaneId?: string }): Promise<boolean> {
  const { agentKey, workspacePath, runGroupId } = payload
  const sessionId = normalizeResumeSessionId(agentKey, payload.sessionId)
  if (!sessionId) return false
  // Authoritative existence check: the datalist may list a since-deleted id, or
  // the user may have pasted a bad one. Never fall through to a fresh spawn —
  // that would silently start a brand-new agent and confuse the user. A failed
  // probe (null) is refused like false: the user can simply retry the button.
  const exists = await canResumeSession(agentKey, workspacePath, sessionId)
  if (!exists) {
    controlPaneRef.value?.showResumeError(i18n.global.t('label.resume-session-not-found'))
    return false
  }
  const spec = agentSpecs.find((s) => s.agentKey === agentKey)
  const skipFlag = skipFlagFor(agentKey, spec)
  const chatHistoryFile = payload.historyPaneId
    ? await savedHistoryFile(agentKey, workspacePath, payload.historyPaneId)
    : ''
  // Custom-binary override applies to resume too — the spec guarantees the
  // command starts with defaultCommand, which this replaces when overridden.
  const commandOverride = commandWithSelectedBinary(
    agentKey,
    buildResumeCommand(agentKey, sessionId, skipFlag, chatHistoryFile)
  )
  const spawnGroupId = resolveManualSpawnGroupId(runGroups.value, activeTab.value)
  const paneId = await spawnPane({
    agentKey: agentKey as AgentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    customName: payload.customName,
    nameLocked: payload.nameLocked,
    autoName: payload.autoName,
    commandOverride,
    workspacePath,
    origin: 'manual',
    runGroupId: runGroupId || spawnGroupId || undefined,
    isResume: true,
    skipRoleInjection: true,
    restoreMode: 'memory-resume',
    resumeSessionId: sessionId,
  })
  if (paneId) {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: workspacePath,
      pane_id: paneId,
      agent: agentKey,
      role: '',
      command: commandOverride,
      session_id: sessionId,
      session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
      run_group_id: runGroupId || spawnGroupId || undefined,
      output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    })
    // The auto-title is the displayed name whenever there is no custom one, so
    // it has to survive the resume the same way custom names do — spawnPane
    // only put it in memory, this persists it into the new pane's record.
    // Written before the rename because set_pane_auto_name is set-once and
    // refuses a record that already carries a custom name.
    if (payload.autoName) {
      await sendQuiet('project.set_pane_auto_name', {
        workspace_path: workspacePath,
        pane_id: paneId,
        auto_name: payload.autoName,
      })
    }
    // A resume gets a fresh pane id, so the lock has to be re-asserted on the
    // new record — including when the user's name is empty, which is exactly
    // the case a customName-only condition would drop.
    if (payload.customName || payload.nameLocked) {
      await sendQuiet('project.rename_pane', {
        workspace_path: workspacePath,
        pane_id: paneId,
        custom_name: payload.customName ?? '',
      })
    }
    return true
  }
  return false
}


/**
 * User-triggered analysis: ignore cooldown / idle / chars-grown requirements
 * and ask the model right now. Useful when the user can see the agent is
 * asking something but the watcher hasn't fired the analyzer yet (agent
 * still mid-stream / cooldown blocking / buffer too small).
 */
async function onAnalyzeNow(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return
  const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const ref = paneRefs[paneId]
  if (!ref) return
  ;(ref.recleanBuffer as (() => void) | undefined)?.()
  const watcher = watchers.get(paneId)
  const fromPos = watcher?.scanFrom ?? 0
  const slice = ((ref.cleanBuffer as unknown as string) || '').slice(fromPos)
  if (!slice.trim()) {
    pipelineLog(`Stage ${stage.id} 🧠 nothing to analyze yet`)
    return
  }
  pipelineLog(`Stage ${stage.id} 🧠 manual analyze (${slice.length} chars)`)
  const result = await analyzerApi.classify(slice, analyzerModel.value || undefined, {
    workspacePath: pipeline.workspacePath,
    stageId: stage.id,
    paneId
  })
  if (!result) {
    pipelineLog(`Stage ${stage.id} 🧠 analyzer error`)
    return
  }
  pipelineLog(
    `Stage ${stage.id} 🧠 intent=${result.intent} (${result.total_duration_ms ?? '?'}ms)${
      result.summary ? ` — ${result.summary}` : ''
    }`
  )
  if (watcher) {
    watcher.lastAnalyzedBufferLen = ((ref.cleanBuffer as unknown as string) || '').length
    watcher.analyzerCooldownUntil = Date.now() + 5_000
  }
  handleAnalyzerResult(stageIndex, paneId, stage, result)
}

async function onReinject(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return
  if (pane.injectionTimer !== null) {
    window.clearTimeout(pane.injectionTimer)
    pane.injectionTimer = null
  }
  const role = rolesApi.find(pane.roleKey)
  if (!role) {
    pane.injectionStatus = pane.roleKey ? 'failed' : 'skipped'
    syncViews()
    return
  }
  pane.injectionStatus = 'scheduled'
  syncViews()
  const ok = await injectPane(paneId, role.system_prompt, `role:${role.label}`)
  pane.injectionStatus = ok ? 'sent' : 'failed'
  if (ok && pane.kickoffPrompt) {
    window.setTimeout(async () => {
      const ok2 = await injectPane(paneId, pane.kickoffPrompt, `kickoff:stage-${pane.stageId}`, true)
      pane.kickoffStatus = ok2 ? 'sent' : 'failed'
      syncViews()
    }, KICKOFF_DELAY_MS)
  }
  syncViews()
}

/**
 * ⌘W's close: kill the focused pane, asking first.
 *
 * The ✕ button calls onKill outright, which is right for a deliberate mouse
 * click but not for a key you can hit one-handed while typing into the very CLI
 * it would kill. `force: true` gives no second chance, so ⌘W confirms on both
 * paths — but they are not the same prompt:
 *
 * - Running: destroying work in progress. Always asks, no opt-out.
 * - Idle: nothing is lost but the pane and its scrollback. Asks by default,
 *   with a "don't ask again" the user can tick (or restore under Settings →
 *   General). `confirmBeforeClosePane` holds that choice.
 */
async function closeFocusedPane(paneId: string): Promise<void> {
  const paneRef = paneRefs[paneId]
  const busy = paneBusyForRebuild(
    paneRef?.displayStatus as string | undefined,
    paneRef?.status as string | undefined,
    paneRef?.startingAgeMs as number | null | undefined
  )
  if (busy === 'running') {
    const ok = await notifyRestore.confirm(
      i18n.global.t('pane.terminal.close-running-confirm-body'),
      {
        title: i18n.global.t('pane.terminal.close-running-confirm-title'),
        confirmText: i18n.global.t('pane.terminal.close-running-confirm-confirm'),
        cancelText: i18n.global.t('pane.terminal.rebuild-running-confirm-cancel')
      }
    )
    if (!ok) return
  } else if (confirmBeforeClosePane.value) {
    const ok = await notifyRestore.confirm(
      i18n.global.t('pane.terminal.close-idle-confirm-body'),
      {
        title: i18n.global.t('pane.terminal.close-idle-confirm-title'),
        confirmText: i18n.global.t('pane.terminal.close-running-confirm-confirm'),
        cancelText: i18n.global.t('pane.terminal.rebuild-running-confirm-cancel'),
        checkboxLabel: i18n.global.t('confirm-close.dont-show-again')
      }
    )
    if (!ok) return
    // Only a confirmed close records the opt-out, matching the workspace-close
    // dialog: cancelling means "not this pane", which says nothing about the
    // next one.
    if (notifyRestore.dialogCheckbox.value) confirmBeforeClosePane.value = false
  }
  await onKill(paneId)
}

async function onKill(paneId: string, opts: { markRemoved?: boolean, force?: boolean, keepInList?: boolean } = {}): Promise<void> {
  const markRemoved = opts.markRemoved ?? true
  const force = opts.force ?? true
  const keepInList = opts.keepInList ?? false
  const pane = panes.value.find((p) => p.id === paneId)
  if (pane?.injectionTimer !== null && pane?.injectionTimer !== undefined) {
    window.clearTimeout(pane.injectionTimer)
  }
  let stageIndex = -1
  if (pane) {
    const savedStageIndex = pane.deferredRestore?.saved.stage_index
    stageIndex = typeof savedStageIndex === 'number' && savedStageIndex >= 0
      ? savedStageIndex
      : stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
    if (stageIndex >= 0) cancelWatcher(paneId)
  }
  if (activeQuestion.value?.paneId === paneId) activeQuestion.value = null
  const ref = paneRefs[paneId]
  if (ref?.sessionId) {
    try {
      await ref.kill({ force: force })
    } catch {
      /* ignore */
    }
  }
  if (markRemoved && pane?.origin === 'pipeline' && pane.slotLabel && stageIndex >= 0) {
    await sendQuiet<ProjectPayload>('pipeline.slot_unspawn', {
      workspace_path: pane.workspacePath,
      stage_index: stageIndex,
      slot_label: pane.slotLabel,
    })
  }
  // Mirrors the manual_pane.spawn side, which persists every non-pipeline pane:
  // mcp-spawned panes are recorded on spawn, so they must be cleared on close too.
  // Gating this on origin === 'manual' left them at spawn_status 'spawned', and a
  // workspace switch resurrected them as placeholders.
  if (opts.markRemoved !== false && pane != null && pane.origin !== 'pipeline') {
    await sendQuiet<ProjectPayload>('manual_pane.unspawn', {
      workspace_path: pane.workspacePath,
      pane_id: pane.id,
      // session_id is stable across restarts (pane_id is regenerated each launch);
      // sending it lets the backend remove the right record even if the id drifted,
      // so a removed CLI can't resurrect on the next restart.
      session_id: pane.pinnedSessionId ?? '',
    })
  }
  const histEntry = spawnHistory.value.find((e) => e.paneId === paneId)
  if (histEntry && !histEntry.removedAt) {
    histEntry.sessionId = pane?.pinnedSessionId ?? histEntry.sessionId
    histEntry.removedAt = new Date().toISOString()
  }
  if (!keepInList) {
    panes.value = panes.value.filter((p) => p.id !== paneId)
  }
  issueHandoffs.value.forEach((v, k) => {
    if (v.paneId === paneId) issueHandoffs.value.set(k, { ...v, state: 'pane-gone' })
  })
  delete paneRefs[paneId]
  unregisterPaneMessaging(paneId)
  paneMsgProcessedAt.delete(paneId)
  // A pane closed mid-preparation never reaches ready/failed, which is where
  // setPrepStatus would otherwise have dropped its timing entry.
  prepStageEnteredAt.delete(paneId)
  clearDoneNotifyTimer(paneId)
  stopLoopLimitWatcher(paneId)
  stopLoginExpiredWatcher(paneId)
  if (pane) {
    pane.loopActive = false
    pane.loopWaitUntil = null
    pane.loopEstimateResetAt = null
    pane.loopSkillId = null
    pane.loopTurnCount = 0
    pane.loopMaxTurns = 0
  }
  sysNotify.forgetPane(paneId)
  syncViews()
}

/** Recover a render-corrupted pane: kill it and re-spawn the same CLI session
 *  via --resume at the current size. */
const rebuildingPanes = reactive(new Set<string>())
const rebuildingTabPanes = ref(false)

/** Canonical pane → resume-session-id derivation, shared by the rebuild lock
 *  and its UI state. */
function paneResumeSessionId(pane: ActivePane): string {
  return normalizeResumeSessionId(pane.agentKey, pane.pinnedSessionId ?? '')
}

/** True while a rebuild is in flight for this pane — matched by pane id or by
 *  session id, so the replacement pane (new id, same session) that spawnPane
 *  swaps in mid-rebuild is covered too. Drives the rebuild buttons' disabled
 *  state. */
function paneRebuilding(pane: ActivePane): boolean {
  if (rebuildingPanes.size === 0) return false
  if (rebuildingPanes.has(pane.id)) return true
  const sessionId = paneResumeSessionId(pane)
  return !!sessionId && rebuildingPanes.has(sessionId)
}

/** Rebuildable panes in the active tab only — drives the tab bar's rebuild button. */
const rebuildablePaneCount = computed(
  () => panes.value.filter((p) => p.realized && tabFilteredPaneIds.value.has(p.id) && paneCanRebuild(p)).length
)

/** Rebuildable panes across all tabs — drives the sidebar's rebuild-all button. */
// "All" means the workspace on screen. The button for it sits on that
// workspace's heading, and restarting another project's CLIs from there would
// be a surprise — those panes are not even visible. Identical to the old
// behaviour whenever this window holds a single workspace.
const rebuildableAllPaneCount = computed(
  () => panesInView.value.filter((p) => p.realized && paneCanRebuild(p)).length
)

/** The same answer, per workspace, for the ↻ on every sidebar heading.
 *
 *  One window-wide count left every heading's button enabled or disabled by
 *  whichever workspace was on screen — a project with nothing to rebuild
 *  offering the button, and one with panes to rebuild refusing it. */
const rebuildableByWorkspace = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const p of panes.value) {
    if (!p.realized || !paneCanRebuild(p)) continue
    const key = normWs(p.workspacePath)
    out[key] = (out[key] ?? 0) + 1
  }
  return out
})

// Panes report a lost PTY one at a time, as each one's reattach probe answers.
// Batching turns N toasts into one and lets a single concurrency limit apply to
// the whole wave instead of every pane racing to spawn at once.
const PTY_LOST_BATCH_MS = 1200
const pendingPtyLostPanes = new Set<string>()
let ptyLostFlushTimer: number | null = null

/**
 * A pane's PTY did not survive a backend outage (TerminalPane `pty-lost`).
 *
 * The PTY itself is unrecoverable — a backend restart kills every one of them —
 * but the CLI's own session is a file on disk that usually outlives it, so the
 * conversation can be picked up with the vendor's resume command. That is
 * exactly what the Rebuild button already does, so this reuses
 * rebuildPaneViaResume rather than growing a second resume path.
 */
function onPanePtyLost(paneId: string): void {
  if (!normalizeAutoResumeOnReconnect(settingsGet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, true))) return
  // Decide visibility now rather than at flush time. The debounce window is
  // exactly when someone staring at a frozen app clicks around, and in the
  // sidebar/spotlight layouts onScreenPaneIds is only the focused pane — read
  // 1.2 s later it would resume whichever pane they had landed on instead of
  // the ones that actually lost their PTY.
  if (!onScreenPaneIds.value.has(paneId)) return
  pendingPtyLostPanes.add(paneId)
  if (ptyLostFlushTimer !== null) window.clearTimeout(ptyLostFlushTimer)
  ptyLostFlushTimer = window.setTimeout(() => { void flushPtyLostResumes() }, PTY_LOST_BATCH_MS)
}

/**
 * Resume the batch of panes that lost their PTY.
 *
 * Scope is deliberately the panes the user can currently see. Respawning every
 * restorable pane would spend real memory (and, on metered plans, real quota)
 * continuing work nobody is looking at; the rest keep their dead pane and
 * resume on the next explicit Rebuild, which is the same deal cold restore
 * already offers. `forceWhenRunning` is safe here precisely because the PTY is
 * already gone — there is no in-flight turn left to interrupt, and no user
 * standing by to answer a confirm.
 */
async function flushPtyLostResumes(): Promise<void> {
  ptyLostFlushTimer = null
  // Visibility was already decided when each pane reported in (see
  // onPanePtyLost); panes closed or rebuilt since then fall out in
  // rebuildPaneViaResume's own 'missing-pane' check.
  const ids = [...pendingPtyLostPanes]
  pendingPtyLostPanes.clear()
  if (!ids.length) return
  let resumed = 0
  let failed = 0
  await runWithConcurrency(ids, ALL_SCOPE_RESTORE_CONCURRENCY, async (paneId) => {
    const failure = await rebuildPaneViaResume(paneId, {
      suppressBusyToast: true,
      forceWhenRunning: true,
      // Nobody asked for this rebuild — the backend went away mid-work. The CLI
      // returns with its transcript but no instruction to carry on.
      offerContinue: true,
    })
    if (failure) failed++
    else resumed++
  })
  if (resumed > 0) {
    notifyRestore.toast(
      i18n.global.t('pane.terminal.session-resumed', { count: resumed }),
      { type: 'success' }
    )
  }
  if (failed > 0) {
    notifyRestore.toast(
      i18n.global.t('pane.terminal.session-resume-failed', { count: failed }),
      { type: 'error', duration: 8000 }
    )
  }
}

/** Failure outcomes of `rebuildPaneViaResume` — success resolves undefined.
 *  Existing batch callers only compare `=== 'busy'`; the other tokens let
 *  the account-switch restart aggregate silent failures into one toast. */
type RebuildFailure =
  | 'busy' // running/starting CLI skipped in a batch
  | 'declined' // user declined the running-pane confirm
  | 'missing-pane' // pane gone or never realized
  | 'no-session' // no resumable session id / no resume command
  | 'locked' // another rebuild of this pane/session is in flight
  | 'probe-failed' // stale-create rollback or resumability probe failed
  | 'not-resumable' // session definitively not resumable
  | 'missing-session' // session file absent on disk
  | 'spawn-failed' // replacement pane spawn failed

async function rebuildPaneViaResume(
  paneId: string,
  opts?: {
    suppressBusyToast?: boolean
    forceWhenRunning?: boolean
    /** The rebuild was forced on the pane rather than asked for — the CLI comes
     *  back parked at its prompt with work nobody resumed. Offers the continue
     *  button. Off for a user-invoked rebuild: that one is already an action,
     *  and its pane does not need a second one on top. */
    offerContinue?: boolean
  }
): Promise<RebuildFailure | undefined> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return 'missing-pane'
  // If the CLI is actively working, skip rebuild so we don't kill in-flight work.
  // The PTY is alive and the pane is already bound — nothing to reattach, just leave it.
  // displayStatus detects active work from CLEANED output bursts. Raw status
  // distinguishes an in-flight terminal create from a running PTY that has not
  // emitted its first byte and therefore still displays as starting.
  const paneRef = paneRefs[paneId]
  const paneStatus = paneRef?.displayStatus as string | undefined
  const terminalStatus = paneRef?.status as string | undefined
  const startingAgeMs = paneRef?.startingAgeMs as number | null | undefined
  const busy = paneBusyForRebuild(paneStatus, terminalStatus, startingAgeMs)
  if (busy === 'running' && !opts?.forceWhenRunning) {
    // Batch callers pre-confirm running panes themselves (forceWhenRunning);
    // reaching here in a batch means the user declined — keep the skip.
    if (opts?.suppressBusyToast) return 'busy'
    // Single-pane path: ask before killing an in-flight turn.
    const ok = await notifyRestore.confirm(
      i18n.global.t('pane.terminal.rebuild-running-confirm-body'),
      {
        title: i18n.global.t('pane.terminal.rebuild-running-confirm-title'),
        confirmText: i18n.global.t('pane.terminal.rebuild-running-confirm-confirm'),
        cancelText: i18n.global.t('pane.terminal.rebuild-running-confirm-cancel')
      }
    )
    if (!ok) return 'declined'
  } else if (busy === 'starting') {
    // An in-flight terminal create is never rebuilt over — skip unconditionally.
    // In a batch (rebuild-all) the caller aggregates one toast; here just report.
    if (!opts?.suppressBusyToast) {
      notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-busy-skipped'), { type: 'info' })
    }
    return 'busy'
  }
  const sessionId = paneResumeSessionId(pane)
  if (!sessionId) {
    if (!opts?.suppressBusyToast) {
      notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-no-session'), { type: 'error' })
    }
    return 'no-session'
  }
  // Lock synchronously, before any await: a concurrent call (double-click, or
  // overlap with the rebuild-all batch) would otherwise pass the has() check
  // during canResumeSession/has_session and double kill/spawn the same pane.
  // The session id is locked alongside the pane id because spawnPane swaps the
  // replacement pane in (new pane id, same session) before the backend spawn
  // resolves — a second click landing on the replacement must be blocked too.
  const lockKeys = [paneId, sessionId]
  const releaseRebuildLock = acquirePaneRebuildLock(rebuildingPanes, lockKeys)
  if (!releaseRebuildLock) {
    if (!opts?.suppressBusyToast) {
      notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-in-progress'), { type: 'info' })
    }
    return 'locked'
  }
  try {
    // A stale STARTING pane may still have terminal.create queued or in flight.
    // Wait for generation-scoped backend rollback before probing/killing and
    // spawning its replacement, so a late ACK cannot leave an orphan PTY.
    try {
      await cancelStalePendingCreate(
        terminalStatus,
        startingAgeMs,
        paneRef?.cancelPendingCreate as (() => Promise<void>) | undefined,
      )
    } catch (error) {
      pipelineLog(`⚠ rebuild ${pane.agentLabel}: stale terminal create rollback failed`)
      if (!opts?.suppressBusyToast) {
        notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-probe-failed'), { type: 'error' })
      }
      return 'probe-failed'
    }
    const ws = pane.workspacePath
    // Fail-safe: abort on false AND on null (probe failed) — never kill a
    // live pane on an unverified resumability answer. The toast distinguishes
    // them: false = the session is definitively absent, null = the probe
    // itself failed (the session may well exist — the user should retry).
    const resumable = await canResumeSession(pane.agentKey, ws, sessionId)
    if (resumable !== true) {
      pipelineLog(`⚠ rebuild ${pane.agentLabel}: session ${sessionId} not resumable`)
      if (!opts?.suppressBusyToast) {
        notifyRestore.toast(
          i18n.global.t(resumable === false
            ? 'pane.terminal.rebuild-not-resumable'
            : 'pane.terminal.rebuild-probe-failed'),
          { type: 'error' }
        )
      }
      return resumable === false ? 'not-resumable' : 'probe-failed'
    }
    const spec = agentSpecs.find((s) => s.agentKey === pane.agentKey)
    const skipFlag = skipFlagFor(pane.agentKey, spec)
    const resumeCmd = commandWithSelectedBinary(
      pane.agentKey,
      buildResumeCommand(pane.agentKey, sessionId, skipFlag)
    )
    if (!resumeCmd) {
      if (!opts?.suppressBusyToast) {
        notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-no-session'), { type: 'error' })
      }
      return 'no-session'
    }

    // Safety: Ensure the requested session actually exists on disk.
    const hasSession = await backend.send('terminals.has_session', {
      workspace_path: ws,
      session_id: sessionId,
    })
    if (!hasSession) {
      pipelineLog(`⚠ rebuild session ${sessionId.slice(0, 8)} not found`)
      if (!opts?.suppressBusyToast) {
        notifyRestore.toast(i18n.global.t('pane.terminal.rebuild-not-resumable'), { type: 'error' })
      }
      return 'missing-session'
    }
    // Snapshot identity before onKill removes the pane from the list.
    const snap = {
      agentKey: pane.agentKey,
      customName: pane.customName,
      nameLocked: pane.nameLocked,
      autoName: pane.autoName,
      roleKey: pane.roleKey,
      stageId: pane.stageId,
      stageIndex: stagesApi.stages.value.findIndex((stage) => stage.id === pane.stageId),
      slotLabel: pane.slotLabel,
      workspacePath: ws,
      origin: pane.origin,
      spawnedBy: pane.spawnedBy,
      runGroupId: pane.runGroupId,
      sessionHomeId: pane.sessionHomeId,
      profileId: pane.profileId,
    }
    try { localStorage.removeItem(`terminal-scroll:${sessionId}`) } catch {}
    // Preserve layout order: keep the old pane as a dummy to avoid layout
    // reflow, then swap the replacement pane into its slot.
    await onKill(paneId, { markRemoved: false, force: true, keepInList: true })
    const newId = await spawnPane({
      agentKey: snap.agentKey,
      customName: snap.customName,
      nameLocked: snap.nameLocked,
      autoName: snap.autoName,
      roleKey: snap.roleKey,
      stageId: snap.stageId,
      slotLabel: snap.slotLabel,
      commandOverride: resumeCmd,
      workspacePath: snap.workspacePath,
      origin: snap.origin,
      spawnedBy: snap.spawnedBy,
      runGroupId: snap.runGroupId || undefined,
      isResume: true,
      skipRoleInjection: true,
      restoreMode: 'fresh',
      sessionHomeId: snap.sessionHomeId,
      profileId: snap.profileId,
      resumeSessionId: sessionId,
      replacePaneId: paneId, // Atomic swap to prevent layout shift
    })
    if (newId) {
      // A rebuild retires the old pane id exactly like a restore does, so the
      // in-memory lineage has to follow. The backend does its own re-key off
      // previous_pane_id in the manual_pane.spawn below.
      rekeyLineage(paneId, newId)
      if (opts?.offerContinue) {
        const revived = panes.value.find((p) => p.id === newId)
        if (revived) revived.resumeContinueAvailable = true
      }
      if (snap.origin !== 'pipeline') {
        await sendQuiet<ProjectPayload>('manual_pane.spawn', {
          workspace_path: snap.workspacePath,
          pane_id: newId,
          previous_pane_id: paneId,
          agent: snap.agentKey,
          role: snap.roleKey || '',
          command: resumeCmd,
          session_id: sessionId,
          session_home_id: snap.sessionHomeId || '',
          run_group_id: snap.runGroupId || '',
          output_log_file: panes.value.find((p) => p.id === newId)?.outputLogFile ?? '',
        })
      } else if (snap.stageIndex >= 0 && snap.slotLabel) {
        // Rebuild replaces the runtime pane id. Keep the stable pipeline slot
        // record pointed at the replacement so later renames update the
        // existing record (and its custom_name) instead of creating a manual
        // pending stub for an unknown id.
        await sendQuiet<ProjectPayload>('pipeline.slot_spawn', {
          workspace_path: snap.workspacePath,
          stage_index: snap.stageIndex,
          slot_label: snap.slotLabel,
          pane_id: newId,
          agent: snap.agentKey,
          role: snap.roleKey,
          session_id: sessionId,
          session_home_id: snap.sessionHomeId || '',
          run_group_id: snap.runGroupId || '',
        })
      }
    } else {
      panes.value = panes.value.filter((p) => p.id !== paneId)
      return 'spawn-failed'
    }
  } finally {
    releaseRebuildLock()
  }
}

/** Batch pre-scan: ask once before rebuilding over running CLIs. Returns
 *  whether running panes should be force-rebuilt (false = keep skipping them). */
/** Panes in a batch that are mid-turn, so a rebuild would interrupt them. */
function countPanesBusyForRebuild(ids: string[]): number {
  return ids.filter((id) => {
    const paneRef = paneRefs[id]
    return paneBusyForRebuild(
      paneRef?.displayStatus as string | undefined,
      paneRef?.status as string | undefined,
      paneRef?.startingAgeMs as number | null | undefined,
    ) === 'running'
  }).length
}

async function confirmBatchRebuildOverRunning(ids: string[]): Promise<boolean> {
  const runningCount = countPanesBusyForRebuild(ids)
  if (runningCount === 0) return false
  return notifyRestore.confirm(
    i18n.global.t('pane.terminal.rebuild-running-confirm-body-batch', { count: runningCount }),
    {
      title: i18n.global.t('pane.terminal.rebuild-running-confirm-title'),
      confirmText: i18n.global.t('pane.terminal.rebuild-running-confirm-confirm'),
      cancelText: i18n.global.t('pane.terminal.rebuild-running-confirm-cancel')
    }
  )
}

/** Batch rebuild with nothing mid-turn: still destructive to what is on
 *  screen, so the batch buttons ask before rebuilding several panes at once. */
async function confirmBatchRebuild(count: number): Promise<boolean> {
  return notifyRestore.confirm(
    i18n.global.t('pane.terminal.rebuild-batch-confirm-body', { count }),
    {
      title: i18n.global.t('pane.terminal.rebuild-batch-confirm-title'),
      confirmText: i18n.global.t('pane.terminal.rebuild-running-confirm-confirm'),
      cancelText: i18n.global.t('pane.terminal.rebuild-running-confirm-cancel')
    }
  )
}

// CLI account switch (UsageBadge popover / Settings › Accounts): when the
// backend refuses to swap credentials under live panes (PANES_RUNNING), this
// handler confirms with the user and forces the switch. The pane restart is
// broadcast-driven: the backend announces the forced switch through
// `cli_profiles.changed`, and every main window — this one included —
// restarts its own panes via restartAgentPanes below. Provided (not
// prop-threaded) so any descendant switch surface picks it up; windows
// without it fall back to a plain setDefault inside the components.
provide(
  cliAccountSwitchKey,
  createCliAccountSwitchHandler(cliProfilesApi, {
    confirm: (message, opts) => notifyRestore.confirm(message, opts),
    agentLabel: (agentKey) => agentSpecs.find((s) => s.agentKey === agentKey)?.label ?? agentKey,
    // The account we just switched to cannot authenticate. It is the active
    // account now, so this is a live login — the poller harvests it back into
    // the slot. The toast says why a login pane appeared on its own, and an
    // aged-out token is told apart from a lost login: the first is what
    // parking an account normally does to it, and calling that "signed out"
    // reads as the switch having broken something.
    startLogin: (agentKey, reason) => {
      notifyRestore.toast(
        i18n.global.t(
          reason === 'expired' ? 'cli-account.needs-login-expired' : 'cli-account.needs-login'
        ),
        { type: 'info' }
      )
      void onCliLoginSpawn(agentKey)
    }
  })
)

/** Restart this window's live panes of one agent after a forced account
 *  switch, so they pick up the new credentials. Login panes and dead
 *  terminals are excluded; panes whose terminal ref has not mounted yet stay
 *  in (they may be starting on the old credentials). Failures aggregate into
 *  one summary toast. */
async function restartAgentPanes(agentKey: string): Promise<void> {
  // Rebuild replaces pane ids — capture the batch up front.
  const batch = panes.value.filter((p) => {
    const paneRef = paneRefs[p.id]
    const status = (paneRef?.displayStatus ?? paneRef?.status) as string | undefined
    return paneNeedsAccountRestart(p, agentKey, status)
  })
  const ids = batch.map((p) => p.id)
  // Diagnostics: one line per selected pane, so a partial-restart toast can be
  // traced back to which panes were eligible and what state they were in.
  pipelineLog(`⟳ account-switch restart (${agentKey}): ${ids.length} pane(s) selected`)
  for (const p of batch) {
    const paneRef = paneRefs[p.id]
    const status = (paneRef?.displayStatus ?? paneRef?.status) as string | undefined
    const session = paneResumeSessionId(p)
    pipelineLog(
      `   · ${p.id.slice(0, 8)} ${p.customName || p.agentLabel}` +
        ` status=${status ?? 'unmounted'}` +
        ` session=${session ? session.slice(0, 8) : 'none'}` +
        ` onDisk=${p.sessionOnDisk ? 'y' : 'n'}`
    )
  }
  await runAccountRestartBatch(
    ids,
    (id) => rebuildPaneViaResume(id, { suppressBusyToast: true, forceWhenRunning: true }),
    pipelineLog,
    (failed, total) =>
      notifyRestore.toast(
        i18n.global.t('cli-account.switch-restart-partial', { failed, total }),
        { type: 'error' }
      )
  )
}

async function rebuildPanesViaResume(scope: 'tab' | 'all', workspacePath?: string): Promise<void> {
  if (rebuildingTabPanes.value) return
  // A sidebar heading's ↻ names its own workspace; the toolbar's and the tab
  // strip's name none, meaning the workspace on screen. Rebuild reads each
  // pane's own workspacePath, so another project's panes rebuild in place —
  // no switch, and nothing on screen changes under the user.
  const pool = workspacePath
    ? panes.value.filter((p) => normWs(p.workspacePath) === normWs(workspacePath))
    : panesInView.value
  // Rebuild replaces pane ids, so capture the batch up front.
  const ids = pool
    .filter((p) => p.realized && (scope === 'all' || tabFilteredPaneIds.value.has(p.id)) && paneCanRebuild(p))
    .map((pane) => pane.id)
  if (!ids.length) return
  // The rebuild-all buttons hit every pane at once, so they always confirm:
  // the running-pane dialog when some are mid-turn (its cancel means "skip the
  // busy ones", not "abort"), a plain one otherwise — even idle panes lose
  // their rendered scrollback and get reprinted from the resumed session.
  const runningCount = countPanesBusyForRebuild(ids)
  let forceWhenRunning = false
  if (runningCount > 0) {
    forceWhenRunning = await confirmBatchRebuildOverRunning(ids)
  } else if (!(await confirmBatchRebuild(ids.length))) {
    return
  }

  rebuildingTabPanes.value = true
  pipelineLog(
    `↻ rebuilding ${ids.length} CLI pane(s) in ${scope === 'all' ? 'all tabs' : 'the active tab'}`
  )
  let busyCount = 0
  try {
    for (const id of ids) {
      try {
        if ((await rebuildPaneViaResume(id, { suppressBusyToast: true, forceWhenRunning })) === 'busy') busyCount++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pipelineLog(`⚠ rebuild pane ${id.slice(0, 8)} failed: ${message}`)
      }
    }
  } finally {
    rebuildingTabPanes.value = false
  }
  if (busyCount > 0) {
    notifyRestore.toast(
      i18n.global.t('pane.terminal.rebuild-busy-skipped-batch', { count: busyCount }),
      { type: 'info' }
    )
  }
}

async function rebuildPaneClean(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane?.realized) return
  // Same session-aware lock as rebuildPaneViaResume: mid-resume the
  // replacement pane (new id, same session) is already live, and its clear
  // shortcut routes here — without the session key a clean
  // spawn could run concurrently and clobber the in-flight resume.
  const sessionId = paneResumeSessionId(pane)
  const lockKeys = sessionId ? [paneId, sessionId] : [paneId]
  if (lockKeys.some((key) => rebuildingPanes.has(key))) return
  const snap = {
    agentKey: pane.agentKey,
    customName: pane.customName,
    nameLocked: pane.nameLocked,
    autoName: pane.autoName,
    roleKey: pane.roleKey,
    stageId: pane.stageId,
    stageIndex: stagesApi.stages.value.findIndex((stage) => stage.id === pane.stageId),
    slotLabel: pane.slotLabel,
    workspacePath: pane.workspacePath,
    origin: pane.origin,
    spawnedBy: pane.spawnedBy,
    runGroupId: pane.runGroupId,
  }
  for (const key of lockKeys) rebuildingPanes.add(key)
  try {
    await onKill(paneId, { markRemoved: false, force: true, keepInList: true })
    const newId = await spawnPane({
      agentKey: snap.agentKey,
      customName: snap.customName,
      nameLocked: snap.nameLocked,
      autoName: snap.autoName,
      roleKey: snap.roleKey,
      stageId: snap.stageId,
      slotLabel: snap.slotLabel,
      commandOverride: '',
      workspacePath: snap.workspacePath,
      origin: snap.origin,
      spawnedBy: snap.spawnedBy,
      runGroupId: snap.runGroupId || undefined,
      isResume: false,
      replacePaneId: paneId, // Atomic swap to prevent layout shift
    })
    if (newId) {
      // Same reason as the resume rebuild above: the old id is retired here.
      rekeyLineage(paneId, newId)
      if (snap.origin !== 'pipeline') {
        await sendQuiet<ProjectPayload>('manual_pane.spawn', {
          workspace_path: snap.workspacePath,
          pane_id: newId,
          previous_pane_id: paneId,
          agent: snap.agentKey,
          role: snap.roleKey || '',
          // A fresh rebuild pins a NEW session; carry it here or the record
          // keeps pointing at the replaced pane's session id.
          session_id: panes.value.find((p) => p.id === newId)?.pinnedSessionId ?? '',
          run_group_id: snap.runGroupId || '',
          output_log_file: panes.value.find((p) => p.id === newId)?.outputLogFile ?? '',
        })
      } else if (snap.stageIndex >= 0 && snap.slotLabel) {
        const replacement = panes.value.find((p) => p.id === newId)
        await sendQuiet<ProjectPayload>('pipeline.slot_spawn', {
          workspace_path: snap.workspacePath,
          stage_index: snap.stageIndex,
          slot_label: snap.slotLabel,
          pane_id: newId,
          agent: snap.agentKey,
          role: snap.roleKey,
          session_id: replacement?.pinnedSessionId ?? '',
          session_home_id: replacement?.sessionHomeId ?? '',
          run_group_id: snap.runGroupId || '',
        })
      }
      const pane = panes.value.find((p) => p.id === newId)
      if (
        pane && pane.agentKey !== 'terminal' &&
        pane.sessionMarker &&
        !pane.roleKey && !pane.kickoffPrompt
      ) {
        void sendSessionMarkerBootstrap(pane, `[pane ${pane.id.slice(0, 8)}]`)
      }
    } else {
      panes.value = panes.value.filter((p) => p.id !== paneId)
    }
  } finally {
    for (const key of lockKeys) rebuildingPanes.delete(key)
  }
}

async function onInterrupt(paneId: string): Promise<void> {
  if (!panes.value.find((p) => p.id === paneId)?.realized) return
  const ref = paneRefs[paneId]
  if (!ref?.sessionId) return
  try {
    await ref.interrupt()
    persistPaneStopped(paneId, true)
  } catch {
    /* ignore */
  }
}

async function onKillAll(paneIds?: readonly string[]): Promise<void> {
  // The workspace on screen only. Killing another project's agents from a
  // button attached to this one's list would be unrecoverable and unasked for.
  //
  // `paneIds` exists for callers that must clear the workspace state BEFORE the
  // teardown runs: panesInView is derived from extraWorkspaces ("every
  // workspace this window holds except the current one"), so once
  // currentWorkspace is blank every workspace counts as extra, the view empties
  // and this kills nothing at all. Such a caller captures the list first and
  // passes it in. See doCloseWorkspace.
  const ids = paneIds ?? panesInView.value.map((p) => p.id)
  for (const id of [...ids]) await onKill(id, { markRemoved: false })
}

// ── Batch actions on the multi-select set (right-click a selected pane) ───────
async function batchInterrupt(ids: string[]): Promise<void> {
  for (const id of ids) await onInterrupt(id)
}

function batchMinimize(ids: string[]): void {
  for (const id of ids) minimizePane(id)
}

function batchRestore(ids: string[]): void {
  for (const id of ids) restorePane(id)
}

async function batchKill(ids: string[]): Promise<void> {
  for (const id of [...ids]) await onKill(id)
  selectedPaneIds.value = new Set()
}

async function batchRebuild(ids: string[]): Promise<void> {
  // Rebuild replaces pane ids, so capture the resumable subset up front.
  const targets = panes.value.filter((p) => ids.includes(p.id) && paneCanRebuild(p)).map((p) => p.id)
  if (!targets.length) return
  const forceWhenRunning = await confirmBatchRebuildOverRunning(targets)
  let busyCount = 0
  for (const id of targets) {
    try {
      if ((await rebuildPaneViaResume(id, { suppressBusyToast: true, forceWhenRunning })) === 'busy') busyCount++
    } catch {
      /* ignore — individual rebuild failures are logged in rebuildPaneViaResume */
    }
  }
  selectedPaneIds.value = new Set()
  if (busyCount > 0) {
    notifyRestore.toast(
      i18n.global.t('pane.terminal.rebuild-busy-skipped-batch', { count: busyCount }),
      { type: 'info' }
    )
  }
}

// ────────────────────────── Pipeline ──────────────────────────

interface GlobalManagerRef {
  /** stage id (e.g. "02") that contains the Manager slot. */
  stageId: string
  /** slot label within that stage (e.g. "Planning"). */
  slotLabel: string
}

interface PipelineRun {
  task: string
  workspacePath: string
  stageIndex: number
  state: PipelineState
  log: string[]
  projectId: string
  projectFile: string
  pipelineLogFile: string
  backendLogFile: string
  /** Relative path from .agent-team/ to current run folder, e.g. "runs/20260528-020041-task" */
  runDir: string
  /** Global pipeline Manager: one slot that stays alive across all stages to
   *  coordinate Workers. null = no global Manager for this run. */
  globalManager: GlobalManagerRef | null
}

const pipeline = reactive<PipelineRun>({
  task: '',
  workspacePath: '',
  stageIndex: -1,
  state: 'idle',
  log: [],
  projectId: '',
  projectFile: '',
  pipelineLogFile: '',
  backendLogFile: '',
  runDir: '',
  globalManager: null
})

const showCompletionModal = ref(false)
const showSettings = ref(false)

// Account modal (titlebar "Sign in"). The titlebar mirrors the link status so
// a signed-in user sees who they are without opening anything; it is polled
// cheaply (5 s, only while this window is focused) because the backend has no
// link-state broadcast, and refreshed at once when the modal reports a change.
const showAccount = ref(false)
const accountModalEverOpened = ref(false)
interface P2pAccountView {
  state: 'unconfigured' | 'connecting' | 'connected' | 'unreachable' | 'unauthorized'
  hasToken: boolean
  accountEmail?: string
  displayName?: string
}
const p2pAccount = ref<P2pAccountView | null>(null)
const p2pAccountLabel = computed(() => {
  const a = p2pAccount.value
  if (!a) return ''
  return a.accountEmail || a.displayName || (a.hasToken ? i18n.global.t('account.token-linked') : '')
})
const p2pAccountDotClass = computed(() => {
  const state = p2pAccount.value?.state
  if (state === 'connected') return 'ok'
  if (state === 'unauthorized') return 'err'
  if (state === 'unreachable') return 'warn'
  return 'idle'
})
async function loadP2pAccount(): Promise<void> {
  try {
    const resp = await backend.send<{ status: P2pAccountView }>('p2p.link.status', {})
    if (resp.ok && resp.payload?.status) p2pAccount.value = resp.payload.status
  } catch { /* non-fatal: the titlebar keeps its last value */ }
}
function openAccountModal(): void {
  accountModalEverOpened.value = true
  showAccount.value = true
}
onMounted(() => {
  void loadP2pAccount()
  const timer = window.setInterval(() => { if (document.hasFocus()) void loadP2pAccount() }, 5000)
  onUnmounted(() => window.clearInterval(timer))
})
// Pipeline Manager modal. Unlike the other modals it is mounted lazily but never
// unmounted again (v-if on pmEverOpened + v-show on showPipelineManager): its
// embedded AiCliDock must keep owning its PTY, and unmounting would let the
// backend janitor reap a CLI the user is still running.
const showPipelineManager = ref(false)
const pmRef = ref<{ closeTopLayer?: () => boolean } | null>(null)
const pmEverOpened = ref(false)
const pmInitialPipelineId = ref('')
function openPipelineManager(pipelineId?: string): void {
  pmInitialPipelineId.value = pipelineId ?? ''
  pmEverOpened.value = true
  showPipelineManager.value = true
}
// Debug modal (cmd+shift+L). Same lazy-mount-then-keep pattern as the Pipeline
// Manager, and for the same reason: its Shell and Ask AI tabs embed terminals.
const showDebug = ref(false)
const debugEverOpened = ref(false)
function openDebugModal(): void {
  debugEverOpened.value = true
  showDebug.value = true
}
// Native application menu entry (menu:open-pipeline-manager). Cast locally so
// this compiles whether or not the preload bridge exposes it yet.
let offOpenPipelineManager: (() => void) | null = null
onMounted(() => {
  const api = (window as Window & {
    agentTeam?: {
      onOpenPipelineManager?: (h: (payload: { pipelineId?: string }) => void) => (() => void) | void
    }
  }).agentTeam
  offOpenPipelineManager =
    api?.onOpenPipelineManager?.((payload) => { openPipelineManager(payload?.pipelineId) }) ?? null
})
onUnmounted(() => {
  offOpenPipelineManager?.()
  offOpenPipelineManager = null
})
type RestoreScopeSelection = RestoreScope | 'fresh' | null

interface RestoreScopePrompt {
  workspacePath: string
  count: number
  resolvers: Array<(selection: RestoreScopeSelection) => void>
}
const restoreScopePrompt = ref<RestoreScopePrompt | null>(null)
const showRestoreScopeModal = computed(() => restoreScopePrompt.value !== null)

function askRestoreScope(workspacePath: string, count: number): Promise<RestoreScopeSelection> {
  if (!isLocalWorkspace(workspacePath)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const current = restoreScopePrompt.value
    if (current?.workspacePath === workspacePath) {
      current.resolvers.push(resolve)
      return
    }
    if (current) {
      for (const settle of current.resolvers) settle(null)
    }
    restoreScopePrompt.value = { workspacePath, count, resolvers: [resolve] }
  })
}

function settleRestoreScope(selection: RestoreScopeSelection): void {
  const current = restoreScopePrompt.value
  if (!current) return
  restoreScopePrompt.value = null
  for (const resolve of current.resolvers) resolve(selection)
}

watch(currentWorkspace, (workspacePath) => {
  if (restoreScopePrompt.value && restoreScopePrompt.value.workspacePath !== workspacePath) {
    settleRestoreScope(null)
  }
})

// Bumped on every request to open Settings at a specific tab. The tab name
// alone is not enough: asking for the tab you are already on leaves the prop
// unchanged, so the modal's watcher never fires and the request is dropped.
const settingsTabRequest = ref(0)
const settingsInitialTab = ref<'general' | 'mcp' | 'analyzer' | 'updates' | 'appearance' | 'accounts' | 'storage' | 'keybindings' | 'prompts'>('general')
// Needed to retarget an already-open modal: initialTab is only honoured on mount
// and by its own watcher, so re-issuing the same tab is a no-op without this.
const settingsModalRef = ref<{ setTab: (tab: string) => void } | null>(null)
function openSettingsAt(tab: typeof settingsInitialTab.value): void {
  settingsInitialTab.value = tab
  if (showSettings.value) settingsModalRef.value?.setTab(tab)
  else showSettings.value = true
}
// Workspaces the Storage tab scans: the open one first, then the recents that
// still exist on disk.
const knownWorkspacePaths = computed<string[]>(() => {
  const paths = [currentWorkspace.value, ...recentWorkspaces.value.filter((w) => w.exists).map((w) => w.path)]
  return [...new Set(paths.filter(Boolean))]
})
function openSettingsAccounts(): void {
  settingsInitialTab.value = 'accounts'
  showSettings.value = true
}
// Status-bar update indicator: shares the updater state machine with ControlPane.
// settings comes along for the check-failure threshold; whether a downloaded
// update will be applied on quit is read from the STATE (quitInstallArmed),
// not the setting — the handoff to the OS updater is one-way.
const {
  state: updateState, settings: updaterSettings,
  startDownload: startUpdateDownload, installUpdate,
} = useUpdater()
// Feed the announcements centre from this one instance — useUpdater is not a
// singleton, so calling it again there would add another IPC subscription.
announcements.setUpdateSource(updateState)
// A run of failed background checks is not an update status of its own — it
// rides alongside whatever the status is. Surface it in the status bar only
// once it clears the user's threshold, and only if they asked to be told.
const showUpdateCheckFailure = computed(() => {
  if (!updaterSettings.value.notifyOnCheckFailure) return false
  const failure = updateState.value.lastCheckFailure
  return !!failure && failure.count >= updaterSettings.value.checkFailureThreshold
})
// Drive the whole update flow from the status-bar badge instead of only opening
// Settings: available → start the download; downloaded → confirm then restart to
// install; downloading/error → open the Updates tab for progress or details.
async function onUpdateBadgeClick(): Promise<void> {
  const status = updateState.value.status
  if (status === 'available') {
    await startUpdateDownload()
    return
  }
  if (status === 'downloaded') {
    const ok = await notifyRestore.confirm(
      i18n.global.t('updater.restart-confirm-body', { version: updateState.value.availableVersion ?? '' }),
      {
        title: i18n.global.t('updater.restart-confirm-title'),
        confirmText: i18n.global.t('updater.install'),
        cancelText: i18n.global.t('updater.later'),
      }
    )
    if (!ok) return
    await installUpdate()
    return
  }
  settingsInitialTab.value = 'updates'
  showSettings.value = true
}
// Native application menu actions routed from main (menu:action). Existing
// bridge listeners in this file never unsubscribe — App.vue lives for the
// window's lifetime, so follow suit.
async function onMenuAction(action: string): Promise<void> {
  if (action === 'open-settings') {
    showSettings.value = true
    return
  }
  if (action === 'open-account') {
    openAccountModal()
    return
  }
  if (action === 'show-shortcuts') {
    // Same destination as Cmd+K Cmd+S: two entry points labelled "Keyboard
    // Shortcuts" must not show two different lists.
    openSettingsAt('keybindings')
    return
  }
  if (action === 'check-updates') {
    settingsInitialTab.value = 'updates'
    showSettings.value = true
    // Refresh the tab's status in the background; failures surface in the tab.
    void window.agentTeam?.updater?.check?.()
    return
  }
  if (action === 'open-workspace') {
    const picked = await window.agentTeam?.pickWorkspace?.()
    if (!picked) return
    // Same folder already open in another window → focus it instead of
    // duplicating (two windows on one folder means conflicting PTY/git ops).
    if (await window.agentTeam?.focusWorkspaceWindow?.(picked)) return
    void touchRecentWorkspace(picked) // bump to front of recents
    if (!currentWorkspace.value) {
      // Welcome is showing — open in place via Welcome's @select handler.
      onWorkspaceSelected(picked)
      return
    }
    await window.agentTeam?.openMainWindow?.({ workspace_path: picked })
    return
  }
  if (action.startsWith('open-recent:')) {
    const picked = action.slice('open-recent:'.length)
    if (!picked) return
    if (await window.agentTeam?.focusWorkspaceWindow?.(picked)) return
    void touchRecentWorkspace(picked) // bump to front of recents
    if (!currentWorkspace.value) {
      onWorkspaceSelected(picked)
      return
    }
    await window.agentTeam?.openMainWindow?.({ workspace_path: picked })
    return
  }
}
const showHistory = ref(false)

/** Open the history modal for the workspace whose heading was clicked.
 *
 *  It answers for that workspace without switching to it: the modal reads its
 *  own copy of that project's entries, and every write it can perform names
 *  historyViewWorkspace rather than currentWorkspace. Opening the workspace on
 *  screen is the ordinary path and touches none of it. */
async function onOpenWorkspaceHistory(workspacePath?: string): Promise<void> {
  const foreign =
    workspacePath && normWs(workspacePath) !== normWs(currentWorkspace.value) ? workspacePath : ''
  historyWorkspace.value = foreign
  showHistory.value = true
  if (foreign) await loadForeignHistory(foreign)
}

// Closed from the button, from Esc, or by an action that leaves the modal —
// dropping the copy once here covers every one of them. Keeping it would show
// a stale snapshot on the next open, before its own load lands.
watch(showHistory, (open) => {
  if (!open) resetForeignHistory()
})
const historyModalRef = ref<{ closeTopLayer?: () => boolean } | null>(null)
const revivingHistoryPaneId = ref('')
const unavailableHistoryPaneIds = ref<Set<string>>(new Set())

// ── Titlebar & Status Bar ─────────────────────────────────────────────────────
const workspaceBaseName = computed(() => {
  if (!currentWorkspace.value) return 'Navide'
  const parts = currentWorkspace.value.replace(/\\/g, '/').split('/')
  return parts.filter(Boolean).at(-1) || 'Navide'
})

/** The workspace's path for the titlebar, home collapsed to ~. Empty until
 *  the home directory arrives, which only means it renders in full a moment
 *  later — never a bare path where a shortened one was expected. */
const workspaceDisplayPath = computed(() =>
  currentWorkspace.value ? collapseHomePath(currentWorkspace.value, homeDir.value) : ''
)

// Reflect the open workspace in the real window title (document.title) so each
// main window is distinguishable in macOS Mission Control / the Dock. Without
// this every main window shows the static index.html <title>. Follows the
// shared `<context> — <feature>` window naming (docs/en-US/plugin-development.md);
// the plugin windows set their own title the same way.
watch(
  workspaceBaseName,
  (name) => {
    document.title = currentWorkspace.value ? `${name} — Navide` : 'Navide'
  },
  { immediate: true },
)

interface StatusBarGit {
  branch: string
  ahead: number
  behind: number
  dirty: boolean
}
const statusBarGit = ref<StatusBarGit>({ branch: '', ahead: 0, behind: 0, dirty: false })

async function refreshStatusBarGit(): Promise<void> {
  if (!currentWorkspace.value || !workspaceSelected.value) return
  if (backend.status.value !== 'connected') return
  const resp = await sendQuiet<{
    branch: string; ahead: number; behind: number
    staged: unknown[]; unstaged: unknown[]
  }>('git.status', { workspace_path: currentWorkspace.value })
  if (resp) {
    statusBarGit.value = {
      branch: resp.branch || '',
      ahead: resp.ahead ?? 0,
      behind: resp.behind ?? 0,
      dirty: (resp.staged?.length ?? 0) + (resp.unstaged?.length ?? 0) > 0
    }
  }
}

let _gitPollTimer: number | null = null
// Skip the poll while the window is hidden (minimized / other desktop) — each
// tick spawns git subprocesses in the backend, and hidden windows kept polling
// forever. Catch up once when the window becomes visible again.
// Main reports this over IPC rather than the Page Visibility API: terminal panes
// need backgroundThrottling disabled, which pins document.hidden to false.
let _windowVisible = true
const _offWindowVisibility = window.agentTeam?.onWindowVisibility?.((visible: boolean) => {
  _windowVisible = visible
  if (visible && _gitPollTimer !== null) void refreshStatusBarGit()
})
onUnmounted(() => _offWindowVisibility?.())
watch(workspaceSelected, (v) => {
  if (v) {
    void refreshStatusBarGit()
    _gitPollTimer = window.setInterval(() => {
      if (_windowVisible) void refreshStatusBarGit()
    }, 5000)
  } else {
    if (_gitPollTimer !== null) { clearInterval(_gitPollTimer); _gitPollTimer = null }
    statusBarGit.value = { branch: '', ahead: 0, behind: 0, dirty: false }
  }
}, { immediate: true })

// Switching between two workspaces this window holds never flips
// workspaceSelected, so the watch above does not fire and the bar kept showing
// the branch of the workspace being left until the 5s poll caught up. Wrong is
// worse than absent here: a branch name next to a project you just switched to
// reads as that project's branch. Cleared first, then refetched.
watch(currentWorkspace, () => {
  statusBarGit.value = { branch: '', ahead: 0, behind: 0, dirty: false }
  void refreshStatusBarGit()
})
// ── Keybinding system ─────────────────────────────────────────────────────────
useKeybindings()
registerCommand('workbench.action.newWindow', async () => {
  const api = (window as Window & {
    agentTeam?: { openMainWindow?: (args?: { workspace_path?: string }) => Promise<{ ok: boolean }> }
  }).agentTeam
  // Always open a fresh Welcome window — do not inherit the current workspace.
  await api?.openMainWindow?.({})
})
// ⌘⇧W. Goes through window.close() rather than any shortcut of its own, so the
// window's existing close handling (confirm-before-quit, PTY teardown) runs
// exactly as it does when the traffic lights are used.
registerCommand('workbench.action.closeWindow', () => { window.close() })
// ⌘W. The pane-level counterpart, so this window has the same two tiers the
// Mini IDE does (⌘W a unit, ⌘⇧W the container). ⌘W was an empty key here
// before: closeActiveEditor guards on `editorOpen`, which this window never
// sets. Declines when nothing is focused so the keystroke is left alone.
registerCommand('workbench.action.closeActivePane', () => {
  const paneId = focusPaneId.value
  if (!paneId) return false
  return closeFocusedPane(paneId)
})
registerCommand('workbench.action.openSettings', () => { showSettings.value = true })
registerCommand('workbench.action.openSettingsAccounts', () => openSettingsAccounts())
registerCommand('workbench.action.openPipelineManager', () => { openPipelineManager() })
registerCommand('workbench.action.openDebug', () => { openDebugModal() })
registerCommand('workbench.action.closeModal', () => {
  if (previewLogOpen.value) previewLogOpen.value = false
  else if (cliInstallRequest.value) closeCliInstall()
  else if (reconnectPickerOpen.value) reconnectPickerOpen.value = false
  else if (whatsNewEntry.value) dismissWhatsNew()
  // Dismissing the restore prompt IS a decision (persists 'cancelled') — but
  // it is the same one the component's own footer Cancel and Esc handler make.
  else if (showRestoreScopeModal.value) settleRestoreScope(null)
  else if (showSettings.value) showSettings.value = false
  else if (showAccount.value) showAccount.value = false
  else if (showDebug.value) showDebug.value = false
  else if (showPipelineManager.value) {
    // The modal owns nested confirm dialogs — let it close its own top layer first.
    if (!pmRef.value?.closeTopLayer?.()) showPipelineManager.value = false
  }
  else if (showHistory.value) {
    // Same as the pipeline manager: nested confirms/dropdown close first.
    if (!historyModalRef.value?.closeTopLayer?.()) showHistory.value = false
  }
  else if (showCompletionModal.value) showCompletionModal.value = false
})
// Cmd+K Cmd+S opens the editable Shortcuts settings, matching VS Code. The Help
// menu's "show-shortcuts" lands here too — there is exactly one shortcuts
// surface now, generated from the rule table rather than hand-maintained.
registerCommand('workbench.action.openKeyboardShortcuts', () => {
  openSettingsAt('keybindings')
})
registerCommand('workbench.action.findInFiles', async () => {
  const api = (window as Window & { agentTeam?: { openEditorWindow?: (args: { workspace_path: string; sidebar: 'search' }) => Promise<{ ok: boolean }> } }).agentTeam
  if (currentWorkspace.value && api?.openEditorWindow) {
    await api.openEditorWindow({ workspace_path: currentWorkspace.value, sidebar: 'search' })
  }
})
registerCommand('workbench.action.openMiniIDE', async () => {
  if (currentWorkspace.value) {
    await window.agentTeam?.openEditorWindow({ workspace_path: currentWorkspace.value })
  }
})
registerCommand('workbench.action.openGitWindow', async () => {
  if (currentWorkspace.value) {
    await window.agentTeam?.openGitWindow?.({ workspace_path: currentWorkspace.value })
  }
})
registerCommand('workbench.action.openPlans', async () => {
  await openPlansWindow()
})
registerCommand('workbench.action.rebuildFocusedPane', async () => {
  if (effectiveFocusPaneId.value) await rebuildPaneViaResume(effectiveFocusPaneId.value)
})
// ⇧⌘R. No prompt: every CLI lives in a backend PTY that outlives the renderer,
// so a reload here reconnects and restores the panes rather than losing them.
// The Mini IDE, whose unsaved buffers only exist in the renderer, guards its own.
registerCommand('workbench.action.reloadWindow', () => { location.reload() })
// Ctrl+Tab / Ctrl+Shift+Tab — see cycleFocusedPane near the grid pagination
// state. 'paneStage' marks this as the window that owns the CLI pane grid; the
// keybinding rules gate on it so plugin windows keep their editor-tab behavior.
setContext('paneStage', true)
registerCommand('workbench.action.focusNextPane', () => { cycleFocusedPane(1) })
registerCommand('workbench.action.focusPreviousPane', () => { cycleFocusedPane(-1) })

// ── External UI action bus (MCP-driven) ─────────────────────────────────────
// Actions a UI-control MCP client can invoke via ui.invoke.request. See
// useUiActionBus for the request/reply plumbing and ownership check.
const UI_SETTINGS_TABS = ['general', 'mcp', 'analyzer', 'updates', 'appearance', 'accounts', 'storage', 'keybindings'] as const
registerCommand('ui.settings.open', (args) => {
  const tab = (args as { tab?: string } | undefined)?.tab
  if (tab && (UI_SETTINGS_TABS as readonly string[]).includes(tab)) {
    openSettingsAt(tab as typeof settingsInitialTab.value)
  } else {
    showSettings.value = true
  }
})
registerCommand('ui.settings.close', () => { showSettings.value = false })
registerCommand('ui.pane.create', async (args) => {
  const a = (args as { agent?: string; name?: string; task?: string } | undefined) ?? {}
  if (!a.agent || !currentWorkspace.value) {
    throw new Error('ui.pane.create requires an agent and an open workspace')
  }
  // Held to the same gate as the SPAWN-block and cli_open_agent paths: a
  // taken name is rejected rather than silently suffixed, and volume
  // advisories are recorded so they reach the caller via ui.invoke.result's
  // warnings channel (see useUiActionBus).
  const gateCtx = standaloneSpawnGateContext()
  if (a.name) {
    const name = normalizeMessagingName(a.name)
    if (name && gateCtx.isNameTaken(name)) {
      throw new Error(`名稱「${name}」已被其他 pane 使用，請換一個名稱`)
    }
  }
  const runGroupId = resolveManualSpawnGroupId(runGroups.value, activeTab.value)
  const paneId = await spawnPane({
    agentKey: a.agent as AgentKey,
    roleKey: '' as RoleKey,
    stageId: '' as StageId,
    customName: a.name,
    commandOverride: '',
    workspacePath: currentWorkspace.value,
    origin: 'manual',
    runGroupId: runGroupId || undefined,
    preferredMessagingName: a.name,
  })
  if (!paneId) throw new Error(`ui.pane.create failed to spawn agent "${a.agent}"`)
  for (const advisory of spawnAdvisoriesFor(gateCtx)) {
    recordDiagnostic({ level: 'warn', code: 'spawn.advisory', message: advisory, paneId })
  }
  void sendQuiet<ProjectPayload>('manual_pane.spawn', {
    workspace_path: currentWorkspace.value,
    pane_id: paneId,
    agent: a.agent,
    role: '',
    command: '',
    session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
    session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
    run_group_id: runGroupId,
    output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
  })
  if (a.name) {
    void sendQuiet('project.rename_pane', {
      workspace_path: currentWorkspace.value,
      pane_id: paneId,
      custom_name: a.name,
    })
  }
  // Roleless manual pane: scheduleInjection early-returns for it before its
  // kickoff step, so the task must be injected here rather than via
  // spawnPane's kickoffPrompt (see createStandaloneRequestedPane above).
  const injected = await injectStandaloneTask(paneId, a.task ?? '', 'mcp-task', standaloneTaskDeps())
  if (!injected) throw new Error(`ui.pane.create failed to inject task into pane "${paneId}"`)
  return paneId
})
// These actions key on the pane id and reject a pane name, which is the only
// handle a caller reading the messaging roster starts with — so saying what is
// missing is not enough, the message has to say where the id comes from.
const PANE_ID_HINT = 'a pane id, not a pane name: cli_list_targets reports it as pane_id, and ui_snapshot lists panes[].id'
registerCommand('ui.pane.close', async (args) => {
  const paneId = (args as { paneId?: string } | undefined)?.paneId
  if (!paneId) throw new Error(`ui.pane.close requires ${PANE_ID_HINT}`)
  await onKill(paneId)
})
registerCommand('ui.pane.focus', (args) => {
  const paneId = (args as { paneId?: string } | undefined)?.paneId
  if (!paneId) throw new Error(`ui.pane.focus requires ${PANE_ID_HINT}`)
  onFocusPane(paneId)
})
registerCommand('ui.groupPeers', (args) => {
  const paneId = (args as { paneId?: string } | undefined)?.paneId
  if (!paneId) throw new Error(`ui.groupPeers requires ${PANE_ID_HINT}`)
  const sender = panes.value.find((p) => p.id === paneId)
  if (!sender) throw new Error(`ui.groupPeers: pane "${paneId}" not found`)
  // Group membership is UI state the backend never learns (agent_msg.register
  // carries no group), so a group-scoped broadcast has to ask the window that
  // owns the sender. Unassigned panes share the synthetic 'manual' group, so
  // they broadcast to each other rather than to nobody.
  const peers = groupPeers(panes.value, paneId) ?? []
  return {
    group_id: sender.runGroupId ?? '',
    peers: peers.map((p) => ({ pane_id: p.id, name: p.messagingName as string })),
  }
})

registerCommand('ui.pane.getStatus', (args) => {
  const paneId = (args as { paneId?: string } | undefined)?.paneId
  if (!paneId) throw new Error(`ui.pane.getStatus requires ${PANE_ID_HINT}`)
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) throw new Error(`ui.pane.getStatus: pane "${paneId}" not found`)
  const ref = paneRefs[paneId]
  return buildPaneStatusReply(
    pane,
    ref
      ? {
          displayStatus: ref.displayStatus as string | undefined,
          awaitingKind: ref.awaitingKind as string | null | undefined,
          buffer: readPaneShareText(ref, CLI_CHIP_LINE_CAP),
        }
      : null,
  )
})
// Diagnostics recorded by uiDiagnostics (e.g. injectText resends) — lets an
// external MCP client see an in-window anomaly a "ok: true" reply hid. See
// plan_mcp.ui_diagnostics for the MCP-facing tool that calls this action.
const preview = usePreview()
// The record track next to the live target. Wired here rather than in
// PreviewPanel so it hydrates at startup instead of waiting for the rail to be
// opened; the composable itself re-snapshots on reconnect and project switch.
const previewLog = usePreviewLog(backend, currentWorkspace)
// A preview target names a workspace path. After switching project that path
// may not even be open any more, and showing it against the new workspace
// would be wrong rather than merely stale. Watching the ref covers all four
// assignment sites at once (select / inspect / close / open).
watch(currentWorkspace, (_next, prev) => {
  if (prev) preview.clearWorkspace(prev)
})
registerCommand('ui.diagnostics.read', (args) => {
  const a = (args as { sinceSeq?: number; paneId?: string; limit?: number } | undefined) ?? {}
  const entries = readDiagnostics({ sinceSeq: a.sinceSeq, paneId: a.paneId || undefined, limit: a.limit })
  return { entries, nextSeq: currentDiagnosticSeq() }
})
registerCommand('ui.tab.switch', (args) => {
  const tabId = (args as { tabId?: string } | undefined)?.tabId
  if (!tabId) throw new Error('ui.tab.switch requires tabId')
  activeTab.value = tabId
})
// Push something into the right rail's preview panel. Reached by MCP
// (ui_invoke), so the payload is untrusted and goes through
// normalizePreviewTarget first. Plugins cannot reach this: their ui.* calls go
// through the main process capability broker, whose host-action table does not
// list preview.
registerCommand('ui.preview.show', (args) => {
  const target = normalizePreviewTarget(args)
  if (!target) throw new Error('ui.preview.show requires a valid preview target')
  // Attribution is applied at the boundary, not taken from the payload — see
  // asAgentPush.
  preview.show(asAgentPush(target))
})
registerCommand('workbench.action.focusPreview', () => {
  preview.focus()
})
registerCommand('ui.window.openPlans', () => { openPlansWindow() })
registerCommand('ui.window.openGit', async () => {
  if (!currentWorkspace.value) return
  await window.agentTeam?.openGitWindow?.({ workspace_path: currentWorkspace.value })
})
registerCommand('ui.window.openPipeline', (args) => {
  const pipelineId = (args as { pipelineId?: string } | undefined)?.pipelineId
  openPipelineManager(pipelineId)
})
registerCommand('ui.workspace.open', async (args) => {
  const path = (args as { path?: string } | undefined)?.path
  if (!path) throw new Error('ui.workspace.open requires path')
  await window.agentTeam?.openMainWindow?.({ workspace_path: path })
})
registerCommand('ui.layout.setMode', (args) => {
  const mode = (args as { mode?: LayoutMode } | undefined)?.mode
  if (!mode) throw new Error('ui.layout.setMode requires mode')
  onUserChangeLayoutMode(mode)
})

interface UiActionSnapshotPane {
  id: string
  name?: string
  agentKey: string
  workspacePath: string
  status?: PreparationStatus
}

async function buildUiActionSnapshot(): Promise<{
  workspace: string
  panes: UiActionSnapshotPane[]
  activeTab: string
  settingsOpen: boolean
  openWorkspaces: string[]
}> {
  return {
    workspace: currentWorkspace.value,
    panes: panes.value.map((p) => ({
      id: p.id,
      name: p.customName || p.autoName || p.messagingName || undefined,
      agentKey: p.agentKey,
      workspacePath: p.workspacePath,
      status: p.preparationStatus,
    })),
    activeTab: activeTab.value,
    settingsOpen: showSettings.value,
    openWorkspaces: (await window.agentTeam?.listOpenWorkspaces?.()) ?? [],
  }
}
// ownsWorkspace, not currentWorkspace: this window may hold several workspaces
// with only one of them showing, and agent_spawn.request already claims by the
// same test (handleMcpSpawnRequest) — the UI bus answering on a narrower rule
// left requests for a held-but-not-active workspace unanswered.
useUiActionBus({
  backend,
  currentWorkspace,
  buildSnapshot: buildUiActionSnapshot,
  ownsWorkspace: isLocalWorkspace,
})

// Single source of truth for the 'modalOpen' keybinding context. Hoisted so
// the watches below can share it; only ever CALLED after setup completes, so
// referencing refs declared later in the file is safe.
function mainModalOpen(): boolean {
  return showSettings.value || showCompletionModal.value || showRestoreScopeModal.value ||
    showPipelineManager.value || showDebug.value || showHistory.value || previewLogOpen.value ||
    reconnectPickerOpen.value || !!cliInstallRequest.value || !!whatsNewEntry.value ||
    showAccount.value
}
watch([showSettings, showAccount, showCompletionModal, showRestoreScopeModal, showPipelineManager, showDebug, showHistory], () => setContext('modalOpen', mainModalOpen()))

/** The sidebar agent list shows panes from every tab; focusing one that lives
 *  in another tab must also activate that tab, or the pane stays v-show-hidden. */
function revealPaneTab(paneId: string): void {
  if (tabFilteredPaneIds.value.has(paneId)) return
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const key = pane.runGroupId || 'manual'
  if (stageTabs.value.some((t) => t.key === key)) {
    activeTab.value = key
    return
  }
  // buildStageTabs raises a tab for every group its panes name, so there is
  // normally one to switch to. Getting here means the pane sits on no tab and
  // the click cannot open it — the failure that used to pass in total silence.
  recordDiagnostic({
    level: 'warn',
    code: 'pane.noTab',
    message: `pane names run group "${key}", which no tab holds`,
    paneId,
  })
}

/** Bring the pane's grid page on screen too.
 *
 *  Switching the tab is not enough under a fixed grid preset: the pane can sit
 *  on another page, and focus then lands on something the stage never draws —
 *  clicking it in the sidebar looks like it did nothing. Ctrl+Tab already did
 *  this for its own landing; every other jump went without it. */
function revealPaneGridPage(paneId: string): void {
  if (effectiveLayoutMode.value !== 'grid') return
  const index = tabVisiblePanes.value.findIndex((p) => p.id === paneId)
  if (index < 0) return
  const page = gridPageOf(index, gridPreset.value)
  if (page !== gridPage.value) onUserChangeGridPage(page)
}

interface PaneSelectionOptions {
  userInitiated: boolean
  scrollIntoView?: boolean
}

function selectPane(paneId: string | null, options: PaneSelectionOptions): void {
  focusPaneId.value = paneId
  if (paneId && options.userInitiated) void realizeRestoredPane(paneId)
  if (paneId && options.scrollIntoView) {
    void nextTick(() => {
      const el = document.querySelector(`[data-pane-id="${paneId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }
}

function onFocusPane(paneId: string): void {
  revealPaneTab(paneId)
  selectPane(paneId, { userInitiated: true, scrollIntoView: true })
  revealPaneGridPage(paneId)
}

async function focusPaneFromNotification(paneId: string): Promise<void> {
  // A message from an agent in another of this window's workspaces is the
  // ordinary case, not an edge one. revealPaneTab only knows how to change
  // tabs, and a tab id never matches across workspaces.
  if (!(await ensurePaneWorkspaceOnScreen(paneId))) return
  revealPaneTab(paneId)
  selectPane(paneId, { userInitiated: false, scrollIntoView: true })
}

const previewLogContent = ref<string>('')
const previewLogTitle = ref<string>('')
const previewLogOpen = ref<boolean>(false)
watch(previewLogOpen, (open) => {
  setContext('modalOpen', mainModalOpen())
  if (!open) {
    // Drop the (possibly multi-MB) log text once the preview closes so it
    // doesn't linger in memory and doesn't flash stale content on reopen.
    previewLogContent.value = ''
    previewLogTitle.value = ''
  }
})

// Resolves a history entry's conversation log path, shared by fetchHistoryLog
// (reads content) and searchHistoryLogsContent (scans content across many
// entries). Legacy entries predate outputLogFile persistence. Manual
// sessions: search by filename (unique — includes paneId) since spawnedAt can
// drift from the log's actual date folder after restore/re-record. Pipeline
// entries (and manual entries the search doesn't find) fall back to the
// existing best-effort date reconstruction (see legacyHistoryLogPath).
async function resolveHistoryLogPath(
  entry: SpawnHistoryEntry,
  api?: { findManualLog?: (workspacePath: string, filename: string) => Promise<{ ok: boolean; path: string | null }> }
): Promise<string | undefined> {
  // The workspace the modal is SHOWING, not the one on screen: the two differ
  // whenever the history was opened from another project's heading, and
  // searching the viewed workspace for its files would find nothing.
  const ws = entry.workspacePath || historyViewWorkspace.value
  if (!ws) return undefined
  let logPath = entry.outputLogFile
  if (!logPath && entry.origin !== 'pipeline' && api?.findManualLog) {
    const found = await api.findManualLog(ws, manualLogFileName(entry.agentKey, entry.paneId))
    logPath = found.ok ? found.path ?? undefined : undefined
  }
  if (!logPath) logPath = legacyHistoryLogPath(entry, ws)
  return logPath
}

// Reads a history entry's log content. Shared by the inline preview in
// AgentHistoryModal (passed down as a prop) and the pop-out full-log modal
// below. Returns null when no log path could be resolved; rejects with a
// localized message when the log exists but reading fails.
async function fetchHistoryLog(
  entry: SpawnHistoryEntry
): Promise<{ title: string; content: string } | null> {
  const api = (window as Window & { agentTeam?: {
    readFileFrom?: (path: string, offset: number) => Promise<{ ok: boolean; content: string; error?: string }>
    findManualLog?: (workspacePath: string, filename: string) => Promise<{ ok: boolean; path: string | null }>
  } }).agentTeam
  const logPath = await resolveHistoryLogPath(entry, api)
  if (!api?.readFileFrom || !logPath) return null
  let res: { ok: boolean; content: string; error?: string }
  try {
    res = await api.readFileFrom(logPath, 0)
  } catch (e) {
    throw new Error(i18n.global.t('label.history-log-read-error', { error: String(e) }))
  }
  if (!res.ok) {
    throw new Error(i18n.global.t('label.history-log-read-failed', { path: logPath, error: res.error || '' }))
  }
  return { title: historyEntryLabel(entry), content: res.content }
}

// Searches each entry's resolved log path for `query` (content search, not
// metadata). Entries whose log path can't be resolved are skipped. Returns
// the paneIds of entries whose log matched, for AgentHistoryModal to union
// with its metadata-based filter.
async function searchHistoryLogsContent(
  entries: SpawnHistoryEntry[],
  query: string
): Promise<Set<string>> {
  const api = (window as Window & { agentTeam?: {
    findManualLog?: (workspacePath: string, filename: string) => Promise<{ ok: boolean; path: string | null }>
    searchHistoryLogs?: (args: { query: string; files: Array<{ id: string; path: string }> }) => Promise<{ matchedIds: string[] }>
  } }).agentTeam
  if (!api?.searchHistoryLogs) return new Set()
  // Resolve paths with bounded parallelism: legacy entries without
  // outputLogFile each cost a findManualLog IPC round-trip, so strictly
  // serial resolution stacks up latency over large histories.
  const RESOLVE_CONCURRENCY = 16
  const paths = new Array<string | undefined>(entries.length)
  let nextIndex = 0
  async function resolveWorker(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= entries.length) return
      paths[i] = await resolveHistoryLogPath(entries[i], api)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, entries.length) }, () => resolveWorker())
  )
  const files: Array<{ id: string; path: string }> = []
  entries.forEach((entry, i) => {
    const path = paths[i]
    if (path) files.push({ id: entry.paneId, path })
  })
  if (files.length === 0) return new Set()
  const result = await api.searchHistoryLogs({ query, files })
  return new Set(result.matchedIds)
}

async function onPreviewHistoryAgent(entry: SpawnHistoryEntry): Promise<void> {
  try {
    const log = await fetchHistoryLog(entry)
    if (!log) return
    previewLogTitle.value = log.title
    previewLogContent.value = log.content
    previewLogOpen.value = true
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

/** Agent History → jump to the still-running pane behind an active entry.
 *  Mirrors cycleFocusedPane's placeholder handling: a cold-restored pane has no
 *  TerminalPane ref yet, so focus has to be re-claimed once it realizes. */
async function onFocusHistoryPane(entry: SpawnHistoryEntry): Promise<void> {
  // The record can outlive its pane (killed while the modal was open), and
  // reconciliation only stamps removedAt on hydrate — re-check against panes.
  const pane = panes.value.find((p) => p.id === entry.paneId)
  if (!pane) {
    unavailableHistoryPaneIds.value = new Set([
      ...unavailableHistoryPaneIds.value,
      entry.paneId,
    ])
    return
  }
  showHistory.value = false
  // History follows the primary workspace and a switch reloads it, but the
  // modal can outlive that.
  if (!(await ensurePaneWorkspaceOnScreen(entry.paneId))) return
  // A minimized pane is skipped by effectiveFocusPaneId, so focusing it alone
  // would silently land on a different pane.
  if (minimizedPanes.value.has(entry.paneId)) restorePane(entry.paneId)
  const wasRealized = pane.realized
  onFocusPane(entry.paneId)
  if (!wasRealized) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    void realizeRestoredPane(entry.paneId).then(() => {
      if (focusPaneId.value !== entry.paneId) return
      void nextTick(() => { paneRefs[entry.paneId]?.focus?.() })
    })
  }
}

async function onResumeHistoryAgent(entry: SpawnHistoryEntry): Promise<void> {
  if (revivingHistoryPaneId.value) return
  const sessionId = entry.sessionId?.trim()
  if (!sessionId) return
  revivingHistoryPaneId.value = entry.paneId
  try {
    const resumed = await onManualResume({
      agentKey: entry.agentKey,
      workspacePath: entry.workspacePath || historyViewWorkspace.value,
      sessionId,
      customName: entry.customName,
      autoName: entry.autoName,
      runGroupId: entry.runGroupId,
      historyPaneId: entry.paneId,
    })
    if (resumed) {
      return
    }
    unavailableHistoryPaneIds.value = new Set([
      ...unavailableHistoryPaneIds.value,
      entry.paneId,
    ])
  } finally {
    revivingHistoryPaneId.value = ''
  }
}


watch(() => pipeline.state, (newState, oldState) => {
  if (newState === 'completed' && oldState === 'running') {
    showCompletionModal.value = true
  }
})

const issueHandoffView = computed<Record<string, { paneId: string; mode: string; state: string }>>(() => {
  const result: Record<string, { paneId: string; mode: string; state: string }> = {}
  issueHandoffs.value.forEach((v, k) => { result[k] = { paneId: v.paneId, mode: v.mode, state: v.state } })
  return result
})

const pipelineView = computed<PipelineStatusView>(() => ({
  state: pipeline.state,
  stageIndex: Math.max(0, pipeline.stageIndex),
  totalStages: stagesApi.stages.value.length || pipeline.stageIndex + 1,
  task: pipeline.task,
  workspacePath: pipeline.workspacePath,
  log: pipeline.log,
  projectId: pipeline.projectId,
  projectFile: pipeline.projectFile,
  pipelineLogFile: pipeline.pipelineLogFile,
  backendLogFile: pipeline.backendLogFile
}))

interface ProjectSlot {
  label: string
  agent: string
  role: string
  pane_id?: string | null
  spawn_status: string   // 'pending' | 'spawned' | 'removed'
  kickoff_status: string // 'none' | 'sent' | 'failed'
  session_id?: string    // CLI session id for resume-on-restart ('' if unknown)
  session_home_id?: string
  run_group_id?: string  // frontend tab this pane belongs to
}

interface ProjectStage {
  stage_id: string
  status: string
  pane_id?: string | null
  slots?: ProjectSlot[]
}

interface ProjectManualPane {
  pane_id: string
  agent: string
  role: string
  command: string
  spawn_status: string
  session_id?: string
  session_home_id?: string
  run_group_id?: string
}

// Unified restore record — covers both pipeline slots and manual panes.
interface ProjectPane {
  pane_id: string
  agent: string
  role: string
  command?: string
  session_id?: string
  session_home_id?: string
  profile_id?: string
  spawn_status: string   // 'pending' | 'spawned' | 'removed'
  run_group_id?: string
  origin: 'pipeline' | 'manual' | 'mcp'
  spawned_by?: string
  stage_id?: string
  stage_index?: number
  slot_label?: string
  kickoff_status?: string
  custom_name?: string
  name_locked?: boolean
  auto_name?: string
  auto_name_source?: string
  is_minimized?: boolean
  collapsed?: boolean
  output_log_file?: string
  stopped?: boolean
}

interface ProjectPayload {
  project: {
    id: string
    name: string
    workspace_path: string
    state?: string
    current_stage_index?: number
    total_stages?: number
    task_description?: string
    stages?: ProjectStage[]
    panes?: ProjectPane[]          // unified restore source (pipeline + manual)
    manual_panes?: ProjectManualPane[]  // legacy; kept for migration fallback
    created_at?: string
    updated_at?: string
    layout_mode?: string
    pipeline_id?: string
    tab_order?: string[]  // run-group tab order (ids); empty/absent = insertion order
    // Run-group tab records in display order; null/absent = never persisted
    // (legacy localStorage migration / default group applies), [] = user
    // deleted all groups.
    ui_run_groups?: RunGroup[] | null
    ui_active_tab?: string  // last active run-group tab id ('' = frontend default)
    ui_spawn_history?: SpawnHistoryEntry[] | null
    cli_agent_order?: string[] | null  // Settings → CLI Agents order; null = never persisted (frontend falls back to legacy default)
    cli_agent_disabled?: string[] | null  // Settings → CLI Agents disabled list; null = never persisted
    run_count?: number
    theme?: string
    theme_custom?: Record<string, string>
  } | null
  paths: { dir: string; project_file: string; pipeline_log: string; backend_log: string } | null
  resume_index?: number
}

interface ColdRestoreBatch {
  workspacePath: string
  records: ProjectPane[]
  savedClaims: ProjectPane[]
  usedFreshSessionIds: Set<string>
}

interface RestoreSession extends WorkspaceRestoreSession {
  decisionPromise?: Promise<RestoreSessionDecision>
  /** A workspace may receive several project.peek replies during cold boot. */
  coldRestoreStarted?: boolean
}

interface DeferredRestoreMetadata {
  saved: ProjectPane
  workspacePath: string
  batch: ColdRestoreBatch
}

interface RestoredPaneSpawnOptions {
  saved: ProjectPane
  /** The placeholder's live parent, when realizing one.
   *
   *  `saved` is a snapshot taken when the workspace loaded. Realizing the
   *  PARENT gives it a new id and rekeyLineage repoints its children in
   *  memory — but the snapshot still names the retired id. Realizing a child
   *  from `saved` alone would write that dead pointer back over the live one,
   *  and a child with no resolvable parent is a root: it leaves the subtree
   *  and sorts to the end of the list. */
  spawnedBy?: string
  workspacePath: string
  runGroupId?: string
  sessionHomeId?: string
  /** Persisted CLI account pin; restores must stay on the same isolated home. */
  profileId?: string
  commandOverride: string
  fallbackCommand: string
  isResume: boolean
  resumeSessionId: string
  sessionKnownOnDisk: boolean
  freshSessionId?: string
  freshPipelineFallbackSessionId: string
  /** Keep a saved session pointer when a fresh CLI follows an unknown probe. */
  preserveSessionPointer?: boolean
  replacePaneId?: string
  restoring?: boolean
  /** Check replacement ownership before its new record is persisted. */
  shouldPersist?: (paneId: string) => boolean
}

interface RestoredPaneSpawnResult {
  paneId: string
}

/** Spawn an already-decided restore and persist its new pane record. Restore
 * policy (probe, resume/fresh choice, reconnect, and stale checks) stays with
 * the eager/lazy callers; this only keeps their spawn metadata in sync. */
/** Point every in-memory child of `oldId` at `newId`.
 *
 *  Mirrors the backend's _rekey_spawned_by. Any path that gives a pane a new
 *  id — restore, rebuild — must call this, because a child still holding the
 *  retired id is a dead pointer, and spawn-depth checks read the lineage.
 *  Restore order is not guaranteed (a child can land before its parent), so
 *  this runs per re-key rather than once at the end. A self-reference is
 *  dropped: a pane that became its own parent would make the walk loop. */
function rekeyLineage(oldId: string, newId: string): void {
  if (!oldId || oldId === newId) return
  for (const p of panes.value) {
    if (p.spawnedBy === oldId) p.spawnedBy = p.id === newId ? undefined : newId
  }
}

async function spawnRestoredPane(opts: RestoredPaneSpawnOptions): Promise<RestoredPaneSpawnResult | null> {
  const { saved } = opts
  const paneId = await spawnPane({
    agentKey: saved.agent as AgentKey,
    roleKey: saved.role,
    stageId: (saved.stage_id ?? '') as StageId,
    slotLabel: saved.slot_label,
    customName: saved.custom_name || undefined,
    nameLocked: saved.name_locked || undefined,
    autoName: saved.auto_name || undefined,
    autoNameSource: autoNameSourceOf(saved.auto_name_source),
    commandOverride: opts.commandOverride,
    workspacePath: opts.workspacePath,
    origin: saved.origin,
    // Live value first — see RestoredPaneSpawnOptions.spawnedBy.
    spawnedBy: opts.spawnedBy || saved.spawned_by || undefined,
    runGroupId: opts.runGroupId,
    isResume: opts.isResume,
    skipRoleInjection: opts.isResume,
    stageIndex: saved.stage_index ?? -1,
    restoreMode: opts.isResume ? 'memory-resume' : 'fresh',
    sessionHomeId: opts.sessionHomeId,
    profileId: opts.profileId,
    resumeSessionId: opts.resumeSessionId,
    sessionKnownOnDisk: opts.sessionKnownOnDisk,
    freshSessionId: opts.freshSessionId,
    preferredMessagingName: persistedMessagingName(saved.pane_id),
    // Every restore path lands here, and any of them may reattach a PTY that
    // never stopped running — its CLI still quotes the pane id it was spawned
    // with. Passed whether or not the reattach takes: a pane that respawned
    // instead has a CLI holding the NEW id, so the alias names nothing and
    // costs nothing.
    formerPaneIds: [saved.pane_id],
    replacePaneId: opts.replacePaneId,
    restoring: opts.restoring,
  })
  if (!paneId) return null
  if (opts.shouldPersist && !opts.shouldPersist(paneId)) {
    await onKill(paneId, { markRemoved: false })
    return null
  }
  if (saved.pane_id !== paneId) {
    dropPersistedMessagingName(saved.pane_id)
    rekeyLineage(saved.pane_id, paneId)
  }

  const pinnedSessionId = panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? ''
  if (saved.origin === 'pipeline') {
    await sendQuiet('pipeline.slot_spawn', {
      workspace_path: opts.workspacePath,
      stage_index: saved.stage_index,
      slot_label: saved.slot_label,
      pane_id: paneId,
      agent: saved.agent,
      role: saved.role,
      session_id: opts.isResume || opts.preserveSessionPointer
        ? opts.resumeSessionId
        : (pinnedSessionId || opts.freshPipelineFallbackSessionId),
      session_home_id: opts.sessionHomeId ?? '',
      profile_id: opts.profileId ?? '',
      run_group_id: opts.runGroupId ?? '',
    })
  } else {
    await sendQuiet<ProjectPayload>('manual_pane.spawn', {
      workspace_path: opts.workspacePath,
      pane_id: paneId,
      previous_pane_id: saved.pane_id,
      agent: saved.agent,
      role: saved.role,
      command: opts.fallbackCommand,
      session_id: opts.isResume || opts.preserveSessionPointer ? opts.resumeSessionId : pinnedSessionId,
      session_home_id: opts.sessionHomeId ?? '',
      profile_id: opts.profileId ?? '',
      run_group_id: opts.runGroupId,
      output_log_file: panes.value.find((p) => p.id === paneId)?.outputLogFile ?? '',
    })
    if (opts.resumeSessionId && !opts.isResume && !pinnedSessionId && !opts.preserveSessionPointer) {
      await sendQuiet('manual_pane.session', {
        workspace_path: opts.workspacePath,
        pane_id: paneId,
        session_id: '',
      })
    }
  }
  return { paneId }
}

interface SessionExistsPayload {
  exists: boolean
}

function looksLikeResumeCommand(agentKey: string, command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  const pattern = agentSpecs.find((spec) => spec.agentKey === agentKey)?.resumeCommandPattern
  if (pattern) return pattern.test(cmd)
  return new RegExp(`^${agentKey}\\s+--resume\\s+\\S+`).test(cmd)
}

/** Tri-state: true = transcript exists, false = definitively absent, null =
 *  the probe itself failed (sendQuiet returns null on any RPC error/timeout)
 *  — unknown, NOT absent. Callers that need fail-safe behavior must
 *  distinguish false from null (see classifySessionExistsResponse). */
async function canResumeSession(
  agentKey: string,
  workspacePath: string,
  sessionId: string,
  opts?: { timeoutMs?: number }
): Promise<boolean | null> {
  const normalizedId = normalizeResumeSessionId(agentKey, sessionId)
  if (!normalizedId) return false
  const resp = await sendQuiet<SessionExistsPayload>('agent.session_exists', {
    agent: agentKey,
    workspace_path: workspacePath,
    session_id: normalizedId,
  }, opts?.timeoutMs)
  return classifySessionExistsResponse(resp)
}

function applyProjectPaths(p: ProjectPayload | undefined): void {
  if (!p) return
  pipeline.projectId = p.project?.id ?? ''
  pipeline.projectFile = p.paths?.project_file ?? ''
  pipeline.pipelineLogFile = p.paths?.pipeline_log ?? ''
  pipeline.backendLogFile = p.paths?.backend_log ?? ''
  pipeline.runDir = (p.paths as Record<string, string> | null)?.run_dir ?? ''
}

// ─────────── Existing-project peek for Resume banner ───────────

const existingProject = ref<ExistingProjectInfo | null>(null)
const controlPaneRef = ref<InstanceType<typeof ControlPane> | null>(null)

// ─────────── Workspace mode detection (phase-5) ───────────
// Derived from project.peek: drives which ControlPane sections lead (phase-6).
//   no project        → spawn      (fresh / empty folder)
//   state completed   → completed  (pipeline finished — show history / start over)
//   running or has task→ pipeline  (configured pipeline workspace)
//   otherwise         → spawn
const currentMode = ref<WorkspaceMode>('spawn')
let workspaceCheckSeq = 0
// One session per workspace this window holds. Re-entrant checks reuse a
// workspace's fixed settings snapshot and decision.
//
// This was a single variable, which two workspaces restoring at once stole
// from each other: realizing any pane reassigns the session to THAT pane's
// workspace, so the other session's next await saw a different object and
// abandoned its whole batch. Nothing failed loudly — the remaining panes just
// stayed placeholders, and the workspace looked like it had lost its agents.
const restoreSessions = new Map<string, RestoreSession>()

function workspaceRestoreSession(workspacePath: string): RestoreSession {
  const existing = restoreSessions.get(workspacePath)
  if (existing) return existing
  const created = createWorkspaceRestoreSession({
    workspacePath,
    behavior: settingsGet(RESUME_BEHAVIOR_SETTING_KEY, 'always'),
    scope: settingsGet(RESTORE_SCOPE_SETTING_KEY, 'single'),
  })
  restoreSessions.set(workspacePath, created)
  return created
}
// Cold-boot race guard: a workspace window mounts (firing workspace-check ~400ms
// in) seconds before the backend WS connects — and with several windows
// restoring panes at once, an established backend can still be too busy to
// answer project.peek within its timeout. Either way sendQuiet returns null and
// pane restore would be silently skipped forever. Track the failure and retry:
// on connect if we weren't connected, after a delay if we were.
let workspaceCheckRetries = 0
let recheckWorkspaceOnConnect = ''
const WORKSPACE_CHECK_MAX_RETRIES = 4
const WORKSPACE_CHECK_RETRY_DELAY_MS = 2500

function detectMode(payload: ProjectPayload | null): WorkspaceMode {
  const proj = payload?.project
  if (!proj) return 'spawn'
  if (proj.state === 'completed') return 'completed'
  if (proj.state === 'running' || (proj.task_description ?? '').trim()) return 'pipeline'
  return 'spawn'
}

function buildExistingProjectInfo(payload: ProjectPayload | null): ExistingProjectInfo | null {
  if (!payload?.project || !payload.paths) return null
  const proj = payload.project
  const stages = proj.stages ?? []
  const completed = stages.filter((s) => s.status === 'completed').length
  let nextIdx = -1
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].status !== 'completed') {
      nextIdx = i
      break
    }
  }
  if (stages.length === 0) return null
  const validState = (['idle', 'running', 'completed', 'aborted'] as const).includes(
    (proj.state as never) ?? 'idle'
  )
    ? (proj.state as ExistingProjectInfo['state'])
    : 'idle'
  return {
    projectId: proj.id,
    name: proj.name,
    state: validState,
    taskDescription: proj.task_description ?? '',
    currentStageIndex: proj.current_stage_index ?? -1,
    totalStages: proj.total_stages ?? stages.length,
    stagesCompleted: completed,
    nextStageIndex: nextIdx,
    updatedAt: proj.updated_at ?? '',
    projectFile: payload.paths.project_file,
    pipelineId: (proj.pipeline_id as string | undefined) ?? '',
    runCount: (proj.run_count as number | undefined) ?? 0
  }
}

/** Guards against the same workspace being checked twice in quick succession.
 *
 *  ControlPane reaches here through a 400ms debounce on its workspace field,
 *  and a switch calls it directly so the window does not spend those 400ms
 *  pairing the new workspace with the old run groups. Both fire for one
 *  switch — and the second bumps workspaceCheckSeq, which is exactly the
 *  condition the first one's restore bails on. It gave up midway and the
 *  workspace came up with none of its panes. */
let lastWorkspaceCheck = { path: '', at: 0 }
const WORKSPACE_RECHECK_MS = 1500

async function onWorkspaceCheck(path: string): Promise<void> {
  if (!path && currentWorkspace.value) return
  if (path) {
    const now = Date.now()
    if (path === lastWorkspaceCheck.path && now - lastWorkspaceCheck.at < WORKSPACE_RECHECK_MS) return
    lastWorkspaceCheck = { path, at: now }
  }
  const seq = ++workspaceCheckSeq
  if (!path) {
    existingProject.value = null
    currentMode.value = 'spawn'
    pipeline.workspacePath = ''
    restoreSessions.clear()
    return
  }
  // Only sessions for workspaces this window no longer holds. Dropping "every
  // session but this one" is what made two workspaces cancel each other.
  for (const key of [...restoreSessions.keys()]) {
    if (key !== path && !isLocalWorkspace(key)) restoreSessions.delete(key)
  }
  const resp = await sendQuiet<ProjectPayload>('project.peek', { workspace_path: path })
  if (seq !== workspaceCheckSeq) return
  if (resp === null) {
    // Comm failure (ws not open, or a busy backend timed out) — NOT an empty
    // workspace, which still returns a payload. Schedule a retry so pane
    // restore isn't silently skipped; give up after the retry budget.
    if (workspaceCheckRetries < WORKSPACE_CHECK_MAX_RETRIES) {
      workspaceCheckRetries++
      if (backend.status.value === 'connected') {
        window.setTimeout(() => {
          if (currentWorkspace.value === path) void onWorkspaceCheck(path)
        }, WORKSPACE_CHECK_RETRY_DELAY_MS)
      } else {
        recheckWorkspaceOnConnect = path
      }
      return
    }
  } else {
    workspaceCheckRetries = 0
  }
  if (pipeline.state !== 'running') pipeline.workspacePath = path
  // Keep currentWorkspace in sync with the workspace being inspected so that
  // run-group workspace paths match: _saveRunGroups() keys off currentWorkspace
  // while _loadRunGroups() keys off `path`. If they diverge, a pipeline tab saved
  // under one workspace is unreadable under the other and silently vanishes on
  // reload.
  currentWorkspace.value = path
  // Apply this workspace's persisted CLI Agents order/disabled list right away,
  // before any await below — otherwise `currentWorkspace` already points at the
  // new workspace while `order`/`disabled` still hold the previous workspace's
  // values, and a Settings edit or peer-window broadcast landing in that gap
  // would persist stale/blended prefs into the new workspace's project.json.
  // Guarded by applyingRemoteCliPrefs so adopting the loaded value doesn't
  // immediately echo straight back through the save watcher below.
  applyingRemoteCliPrefs.value = true
  loadCliAgentPrefsFromProject(resp?.project?.cli_agent_order, resp?.project?.cli_agent_disabled)
  void nextTick(() => { applyingRemoteCliPrefs.value = false })
  existingProject.value = resp ? buildExistingProjectInfo(resp) : null
  projectCreatedAt.value = resp?.project?.created_at ?? ''
  currentMode.value = detectMode(resp)
  applyProjectPaths(resp ?? undefined)
  if (resp?.project) {
    // Agent History is owned by this workspace. The full store is paged from
    // the backend; old projects have no field and migrate only the matching
    // entries from the former global settings key.
    await hydrateSpawnHistory(path, resp.project.ui_spawn_history, () => seq !== workspaceCheckSeq)
    if (seq !== workspaceCheckSeq || currentWorkspace.value !== path) return
    // Adopt the backend theme backup only if the settings store held nothing
    // (load order: settings store → backend → default). loadTheme() is a no-op
    // for theme when the store already wins, so this is safe to call here.
    themeApi.loadTheme({ theme: resp.project.theme, theme_custom: resp.project.theme_custom })
    settingsApi.loadLanguage({ language: (resp.project as { language?: string }).language })
    const savedMode = resp.project.layout_mode
    if (savedMode === 'auto' || savedMode === 'grid' || savedMode === 'spotlight' || savedMode === 'fullscreen') {
      layoutMode.value = savedMode
    } else {
      layoutMode.value = 'grid'
    }
    // Decision 8: project.pipeline_id takes priority — sync global active pipeline.
    const savedPipelineId = resp.project.pipeline_id as string | undefined
    if (savedPipelineId && pipelinesApi.pipelines.value.some((p) => p.id === savedPipelineId)) {
      if (savedPipelineId !== pipelinesApi.activePipelineId.value) {
        await pipelinesApi.setActivePipeline(savedPipelineId)
        await stagesApi.refresh()
      }
    }
    // The two awaits above can span a workspace switch, and runGroups is one
    // ref for whichever workspace is on screen: loading a superseded check's
    // groups here would pair the entered workspace with the left one's tabs,
    // and every pane would match none of them.
    if (seq !== workspaceCheckSeq || currentWorkspace.value !== path) return
    _loadRunGroups(path, resp.project)
    // Apply the persisted tab order from project.json. Groups not listed (or
    // an absent field) keep their stored order.
    const savedTabOrder = resp.project.tab_order
    if (Array.isArray(savedTabOrder) && savedTabOrder.length > 0) {
      if (sortByIdOrder(runGroups.value, savedTabOrder.filter((t) => typeof t === 'string'))) {
        currentRunGroupId.value = runGroups.value[runGroups.value.length - 1]?.id ?? ''
      }
    }
    // Set the active tab BEFORE restoring panes. Without it, tab filtering is
    // inactive (tabFilteredPaneIds falls back to "all panes"), so every tab's
    // panes share one grid (e.g. 7 panes → 3 cols → ~282px). Each agent then
    // resumes hard-wrapped at that narrow width (~34 cols) and the frame stays
    // stuck in scrollback even after the later resize — visible as a pane whose
    // text is much narrower than the cell. Filtering first makes each pane spawn
    // into its final-width grid cell.
    // The backend field wins; the legacy per-workspace localStorage key is
    // migrated once (legacy copy deleted only after the backend ack).
    const legacyTabKey = `agentTeam.activeTab.${path}`
    let savedTab = typeof resp.project.ui_active_tab === 'string' ? resp.project.ui_active_tab : ''
    let legacyTab: string | null = null
    try { legacyTab = localStorage.getItem(legacyTabKey) } catch { legacyTab = null }
    if (savedTab) {
      // Backend already owns the value — clear any leftover legacy copy.
      if (legacyTab !== null) { try { localStorage.removeItem(legacyTabKey) } catch { /* ignore */ } }
    } else if (legacyTab) {
      savedTab = legacyTab
      if (!isDetachedWindow) {
        void sendQuiet<{ ok: boolean }>('project.set_ui_state', {
          workspace_path: path,
          active_tab: legacyTab,
        }).then((ack) => {
          if (ack?.ok) { try { localStorage.removeItem(legacyTabKey) } catch { /* ignore */ } }
        })
      }
    }
    // Keep a saved tab selected through cold hydration. Manual is synthetic,
    // and a saved run group can be recreated only while placeholders are built.
    activeTab.value = savedTab
      ? savedTab
      : (stageTabs.value[0]?.key ?? '')
    let coldRestoreBatch: ColdRestoreBatch | null = null
    if (suppressPaneRestoreOnce) {
      // First load of a duplicated window: open the same workspace as a clean
      // view without re-resuming the source window's live agent sessions.
      suppressPaneRestoreOnce = false
    } else {
      // isStale lets restore bail if a newer workspace-check superseded this one
      // before or during restore (the await can span a user pause).
      coldRestoreBatch = await restoreWorkspacePanes(resp, path, undefined, () => seq !== workspaceCheckSeq)
    }
    // Only now that the panes are back: an orphaned id is only visible once
    // the restore has had its say, and restore already puts back the record
    // for the panes it brings in (ensureSavedGroup). This covers the rest —
    // panes kept across a switch, whose records the entered workspace lost.
    adoptOrphanRunGroups(path)
    activeTab.value = resolveActiveTab(runGroups.value, activeTab.value)
    // If the active tab has no panes (e.g. old project.json panes landed in a
    // different group via fallback), switch to the first tab that has panes so
    // the user is not greeted with an empty grid.
    if (activeTab.value && stageTabs.value.length > 0) {
      const paneCountByGroup: Record<string, number> = {}
      for (const p of panes.value) {
        const groupKey = p.runGroupId || 'manual'
        paneCountByGroup[groupKey] = (paneCountByGroup[groupKey] ?? 0) + 1
      }
      const activeHasPanes = (paneCountByGroup[activeTab.value] ?? 0) > 0
      if (!activeHasPanes) {
        const firstFull = stageTabs.value.find((t) => (paneCountByGroup[t.key] ?? 0) > 0)
        if (firstFull) activeTab.value = firstFull.key
      }
    }
    // A restore that produced nothing goes back to the workspace picker.
    //
    // The block above rescues an empty ACTIVE TAB by switching to a tab that
    // has panes; this is the case it cannot rescue — no tab has any. That
    // happens when the snapshot named a workspace whose project.json is gone,
    // empty, or failed to load, and the result is a window with a sidebar
    // reading "No agents running." and no way forward that looks like anything
    // but a broken app. Welcome is the screen that offers a way forward, and it
    // doubles as the switcher, so the restored workspace is still one click
    // away rather than lost.
    //
    // Guarded to the restoring boot only: opening an empty workspace on purpose
    // is legitimate, and so is closing your last pane.
    if (restoreEmptyCheckPending) {
      restoreEmptyCheckPending = false
      if (panes.value.length === 0) {
        workspaceSelected.value = false
        // The boot wrote these when it took the workspace_path param; leaving
        // them set would send the next reload straight back into the same empty
        // workspace, past the picker. Mirrors doCloseWorkspace's cleanup.
        try {
          sessionStorage.removeItem(WS_SELECTED_KEY)
          sessionStorage.removeItem(WS_PATH_KEY)
        } catch { /* sessionStorage unavailable — non-fatal */ }
        return
      }
    }
    // Let tab-derived visibility and Grid page state settle after the final
    // active-tab fallback before selecting focus or an automatic restore scope.
    await nextTick()
    // Cold load seeds a focus so a placeholder is on screen in sidebar/spotlight.
    // onWorkspaceCheck also runs on a pipeline abort and on WS reconnect, so only
    // seed when the current focus is gone — never steal a focus the user set.
    if (!focusPaneId.value || !tabVisiblePanes.value.some((p) => p.id === focusPaneId.value)) {
      focusPaneId.value = tabVisiblePanes.value[0]?.id ?? null
    }
    // Scope selection depends on the settled active tab and focus. Start only
    // after placeholders exist and the empty-tab fallback above has run.
    const restoreSession = workspaceRestoreSession(path)
    if (
      coldRestoreBatch &&
      seq === workspaceCheckSeq &&
      currentWorkspace.value === path &&
      !restoreSession.coldRestoreStarted
    ) {
      // Set this before awaiting the restore decision: a reconnect-triggered
      // workspace check must not start a second cold transition while the
      // first one is waiting for the user or a session probe.
      restoreSession.coldRestoreStarted = true
      await advanceRestoreSession('cold', coldRestoreBatch)
    }
  }
}

// Fire the deferred workspace re-check as soon as the backend WS connects.
watch(
  () => backend.status.value,
  (s) => {
    if (s !== 'connected') return
    // The messaging registry lives in the backend process and is dropped when a
    // connection goes away — including the transient drops the ws client heals
    // by itself. Without re-mirroring, this window's panes would silently stop
    // being addressable from other workspaces until they were renamed or
    // recreated.
    // The disconnect dropped this window's registry entries, so re-registering
    // starts every pane at not-busy. Drop the local dedup cache to match, or a
    // pane that was busy across the reconnect would never report it again.
    paneBusyReported.clear()
    for (const pane of panes.value) mirrorMessagingHandle(pane)
    void refreshRemoteMessagingTargets()
    if (!recheckWorkspaceOnConnect) return
    const p = recheckWorkspaceOnConnect
    recheckWorkspaceOnConnect = ''
    if (currentWorkspace.value === p) void onWorkspaceCheck(p)
  }
)

/** Restore panes recorded in project.json.
 *  Full cold loads create placeholders; explicit activation realizes and
 *  resumes (or fresh-spawns) one record at a time. Detached/group reattachments
 *  remain eager so their live PTYs reconnect immediately. */
async function restoreWorkspacePanes(payload: ProjectPayload, workspacePath: string, onlyGroupId?: string, isStale?: () => boolean): Promise<ColdRestoreBatch | null> {
  // Don't restore if pipeline is active or paused — panes are already alive.
  if (pipeline.state === 'running' || pipeline.state === 'aborted') return null
  if (isStale?.() || !isLocalWorkspace(workspacePath)) return null

  // Build unified pane list. Prefer project.panes[] (new format); fall back to
  // migrating stages[].slots[] + manual_panes[] for old project.json files that
  // predate the unified schema.
  let allProjectPanes: ProjectPane[] = payload.project?.panes ?? []
  if (allProjectPanes.length === 0) {
    const stages = payload.project?.stages ?? []
    const fromSlots: ProjectPane[] = stages.flatMap((stage, i) =>
      (stage.slots ?? [])
        .filter((sl) => sl.spawn_status === 'spawned' || sl.spawn_status === 'removed')
        .map((sl) => ({
          pane_id: sl.pane_id ?? '',
          agent: sl.agent,
          role: sl.role,
          session_id: sl.session_id,
          session_home_id: sl.session_home_id,
          spawn_status: sl.spawn_status,
          run_group_id: sl.run_group_id,
          origin: 'pipeline' as const,
          stage_id: stage.stage_id,
          stage_index: i,
          slot_label: sl.label,
          kickoff_status: sl.kickoff_status,
        }))
        .filter((p) => p.pane_id)
    )
    const fromManual: ProjectPane[] = (payload.project?.manual_panes ?? []).map((mp) => ({
      pane_id: mp.pane_id,
      agent: mp.agent,
      role: mp.role,
      command: mp.command,
      session_id: mp.session_id,
      session_home_id: mp.session_home_id,
      spawn_status: mp.spawn_status,
      run_group_id: mp.run_group_id,
      origin: 'manual' as const,
    }))
    allProjectPanes = [...fromSlots, ...fromManual]
  }

  // Enrich legacy local History entries created before custom titles were
  // stored there. project.json is authoritative when it still has the pane.
  for (const saved of allProjectPanes) {
    if (saved.custom_name) {
      updateHistoryCustomName(spawnHistory.value, {
        paneId: saved.pane_id,
        agentKey: saved.agent,
        sessionId: saved.session_id,
        sessionHomeId: saved.session_home_id,
      }, saved.custom_name)
    }
  }

  // An ordinary main-window restore must know which groups are detached before
  // it decides what to resume; the answer arrives asynchronously from main.
  if (!isDetachedWindow && onlyGroupId === undefined) await detachedGroupsKnown

  let toRestore = allProjectPanes.filter((p) => p.spawn_status === 'spawned')
  // Detached child window restores only the panes of its scoped run group; the
  // live PTYs are kept alive by the main window's hand-off, so these reattach.
  if (isDetachedWindow) toRestore = toRestore.filter((p) => (p.run_group_id ?? '') === detachedGroupId)
  // Main-window reattach after a child closes: restore just the returning group.
  else if (onlyGroupId !== undefined) toRestore = toRestore.filter((p) => (p.run_group_id ?? '') === onlyGroupId)
  // Ordinary main-window restore: skip groups that are currently detached —
  // the child window owns those panes and restores them itself. Without this
  // both windows resume the same records: the main window shows panes it does
  // not own, and closing the child adds a second copy of each.
  else if (detachedGroupIds.value.size > 0) {
    toRestore = toRestore.filter((p) => !detachedGroupIds.value.has(p.run_group_id ?? ''))
  }
  // Collapse duplicate records that resume the SAME conversation: spawning
  // several `--resume <same id>` concurrently makes the CLI fork/conflict and
  // leak processes (a source of the leftover-agent pileup).
  const beforeDedupe = toRestore.length
  toRestore = dedupeRestorablePanes(toRestore)
  if (toRestore.length < beforeDedupe) {
    pipelineLog(`↩ Skipped ${beforeDedupe - toRestore.length} duplicate resume record(s)`)
  }
  if (toRestore.length > 0) pipelineLog(`↩ Restoring ${toRestore.length} pane(s)`)
  pipeline.workspacePath = workspacePath

  // Ghost/reconnect detection applies only to a full cold restore — a group
  // reattach or detached child window hands back panes whose PTYs are alive.
  const fullRestore = onlyGroupId === undefined && !isDetachedWindow

  // Lazily create one group to house restored pipeline panes whose saved
  // run_group_id no longer maps to an existing tab (e.g. localStorage cleared
  // while project.json survived, or records predating run_group_id). Created
  // once on first need so we don't spawn an empty tab for manual-only restores.
  // Restored pipeline panes use the saved Pipeline name for the recreated
  // RunGroup tab; task_description stays task content, not a grouping label.
  let _restoreGroupId = ''
  const ensureRestoreGroup = (): string => {
    if (_restoreGroupId) return _restoreGroupId
    _restoreGroupId = runGroups.value[0]?.id
      ?? createRunGroup(pipelineRunGroupName(payload.project?.pipeline_id as string | undefined)).id
    return _restoreGroupId
  }

  // A saved run_group_id with no matching tab means the tab list was lost, not
  // the pane's assignment. Recreate the tab under the SAME id so the pane keeps
  // its stored group — routing it to another group would be written back by the
  // spawn upsert below and permanently overwrite the saved assignment.
  const ensureSavedGroup = (gid: string): string => {
    if (!runGroups.value.some((g) => g.id === gid)) {
      runGroups.value = [...runGroups.value, { id: gid, name: `Run ${runGroups.value.length + 1}`, createdAt: Date.now() }]
      _saveRunGroups()
    }
    return gid
  }

  // New pane ids per toRestore slot — spawnPane assigns fresh ids, so the
  // post-restore re-sort below maps the saved order onto the new ids.
  const restoredPaneIds: (string | undefined)[] = new Array(toRestore.length)

  // Session ids already claimed for --session-id reuse in THIS restore batch.
  // dedupeRestorablePanes collapses same-(agent,id) records, but a saved id can
  // still surface twice (e.g. cross-agent duplicates); only the first spawn may
  // reuse it — a second `--session-id <same>` would collide.
  const usedFreshSessionIds = new Set<string>()

  const coldBatch: ColdRestoreBatch | null = fullRestore
    ? {
        workspacePath,
        records: toRestore,
        savedClaims: allProjectPanes.map((pane) => ({ ...pane })),
        usedFreshSessionIds,
      }
    : null
  if (fullRestore) {
    reconnectedCount.value = 0
    disconnectedPaneIds.value = []
    reconnectBannerDismissed.value = false

    // Cold restore is deliberately split: persisted records become inert UI
    // rows now, while probes/decision/spawn happen only from explicit activation.
    for (const saved of toRestore) {
      const existing = panes.value.find((p) => p.id === saved.pane_id)
      if (existing?.realized) continue
      // A later project.peek for the same workspace must not replace an
      // existing placeholder. An activation may already be awaiting a decision
      // or probe, and its deferred metadata is its identity/race guard.
      if (existing) continue
      const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
      const rawSessionId = (saved.session_id ?? '').trim()
      const sessionId = normalizeResumeSessionId(saved.agent, rawSessionId)
      const sessionHomeId = sessionHomeIdFor(
        saved.agent, saved.pane_id, saved.session_home_id,
      )
      const savedGid = saved.run_group_id || ''
      const runGroupId = savedGid
        ? ensureSavedGroup(savedGid)
        : (saved.origin === 'pipeline' ? ensureRestoreGroup() : '')
      const placeholder: ActivePane = {
        id: saved.pane_id,
        realized: false,
        agentKey: saved.agent,
        agentLabel: spec?.label ?? saved.agent,
        customName: saved.custom_name || undefined,
        nameLocked: saved.name_locked || undefined,
        autoName: saved.auto_name || undefined,
        autoNameSource: autoNameSourceOf(saved.auto_name_source),
        roleKey: saved.role as RoleKey,
        stageId: (saved.stage_id ?? '') as StageId,
        slotLabel: saved.slot_label ?? '',
        command: saved.command ?? '',
        workspacePath,
        origin: saved.origin,
        // Without this a placeholder has no parent, so buildPaneLineage cannot
        // link it: an agent-spawned pane came back flat and in spawn order
        // until it was realized, which is when the tree finally appeared. The
        // backend persists and re-keys spawned_by precisely so the shape
        // survives a restart — dropping it here threw that away.
        spawnedBy: saved.spawned_by || undefined,
        outputLogFile: saved.output_log_file || undefined,
        runGroupId: runGroupId || undefined,
        injectionStatus: 'pending',
        preparationStatus: 'starting',
        injectionTimer: null,
        kickoffStatus: saved.kickoff_status === 'sent' || saved.kickoff_status === 'failed'
          ? saved.kickoff_status
          : 'none',
        kickoffPrompt: '',
        skipRoleInjection: true,
        pinnedSessionId: sessionId || undefined,
        sessionHomeId: sessionHomeId || undefined,
        deferredRestore: { saved, workspacePath, batch: coldBatch! },
      }
      // Register the handle now rather than on realize. `messagingName` is what
      // the @-mention menu filters on and what mirrors the pane into the
      // cross-workspace registry, so a restored-but-not-yet-opened pane was
      // addressable by neither: it did not exist to the messaging system until
      // it was clicked. The menu already expects placeholders — it draws a
      // hollow dot for a pane whose status it cannot read — so only the
      // registration was ever missing. Delivery is unaffected: injectPane still
      // refuses an unrealized pane, which is what makes listing one safe.
      registerPaneMessaging(placeholder, persistedMessagingName(saved.pane_id))
      panes.value.push(placeholder)
      if (saved.is_minimized) {
        minimizedPanes.value = new Set([...minimizedPanes.value, saved.pane_id])
      }
      if (saved.collapsed) {
        collapsedPanes.value = new Set([...collapsedPanes.value, saved.pane_id])
      }
    }
    syncViews()
    if (isStale?.() || !isLocalWorkspace(workspacePath)) return null
  }

  // Detached/only-group restores keep the existing eager behaviour. Cold
  // placeholders return through the history backfill below without probing or
  // creating any PTY.
  if (!fullRestore) {
    await Promise.all(toRestore.map(async (saved, restoreIdx) => {
      const rawSessionId = (saved.session_id ?? '').trim()
      const sessionId = normalizeResumeSessionId(saved.agent, rawSessionId)
      const sessionHomeId = sessionHomeIdFor(
        saved.agent, saved.pane_id, saved.session_home_id,
      )
      const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
      const skipFlag = skipFlagFor(saved.agent, spec)
      // A pane with a saved group keeps it, recreating the tab if it is missing
      // (ensureSavedGroup). Only panes that never had a group fall back: pipeline
      // panes collapse into one restore group, manual panes go to the first tab.
      const savedGid = saved.run_group_id || ''
      const runGroupId = savedGid
        ? ensureSavedGroup(savedGid)
        : (saved.origin === 'pipeline' ? ensureRestoreGroup() : '')

      const canResume = await canResumeSession(saved.agent, workspacePath, sessionId)
      if (isStale?.() || !isLocalWorkspace(workspacePath)) return
      if (shouldPreserveMissingSessionOnRestore(saved.agent, sessionId, canResume === true)) return
      const attemptResume = shouldAttemptResume(canResume)
      const chatHistoryFile = await savedHistoryFile(saved.agent, workspacePath, saved.pane_id)
      if (isStale?.() || !isLocalWorkspace(workspacePath)) return
      const resumeCmd = attemptResume
        ? commandWithSelectedBinary(
            saved.agent,
            buildResumeCommand(saved.agent, sessionId, skipFlag, chatHistoryFile)
          )
        : ''
      const isResume = !!resumeCmd
      const effectiveResumeId = sessionId
      const savedFallbackCommand = saved.command && !looksLikeResumeCommand(saved.agent, saved.command)
        ? stripDeadOpencodeAutoFlag(saved.agent, saved.command) : ''
      const fallbackCommand = savedFallbackCommand
      const commandOverride = resumeCmd || fallbackCommand || ''
      const restored = await spawnRestoredPane({
        saved,
        workspacePath,
        runGroupId: runGroupId || undefined,
        sessionHomeId,
        profileId: saved.profile_id,
        commandOverride,
        fallbackCommand,
        isResume,
        resumeSessionId: effectiveResumeId,
        sessionKnownOnDisk: !isResume && canResume === true && RESTORE_PIN_AGENTS.includes(saved.agent),
        freshSessionId: isResume ? undefined : claimFreshSessionId(usedFreshSessionIds, sessionId),
        freshPipelineFallbackSessionId: isResume ? sessionId : '',
      })
      if (!restored) return
      const { paneId } = restored
      restoredPaneIds[restoreIdx] = paneId

      // Re-apply the persisted collapsed-to-sidebar state to the new pane id.
      if (saved.is_minimized) {
        minimizedPanes.value = new Set([...minimizedPanes.value, paneId])
      }
      if (saved.collapsed) {
        collapsedPanes.value = new Set([...collapsedPanes.value, paneId])
      }

      // Reflect the persisted STOP badge onto the freshly-spawned pane. spawnPane
      // above already awaited ref.spawn() (which resets isStopped=false), so this
      // sets the composable AFTER that reset. No persist here — reading stored
      // truth, not issuing a new stop action (see loop-avoidance invariants).
      if (saved.stopped) paneRefs[paneId]?.setStopped(true)
    }))

    // The parallel spawns above push into panes.value in completion order, which
    // is nondeterministic — re-sort the restored panes back to the saved
    // project.panes order (toRestore mirrors it). Panes outside this restore
    // (e.g. already-live ones on a group reattach) keep their positions.
    sortByIdOrder(panes.value, restoredPaneIds.filter((id): id is string => !!id))
  }

  // Backfill removed manual panes into spawnHistory so Agent History shows past sessions.
  const removedManual = allProjectPanes.filter(
    (p) => p.origin !== 'pipeline' && p.spawn_status === 'removed'
  )
  const existingPaneIds = new Set(spawnHistory.value.map((e) => e.paneId))
  const fallbackTs = payload.project?.updated_at ?? new Date().toISOString()
  const backfilledIds = new Set<string>()
  for (const saved of removedManual) {
    if (existingPaneIds.has(saved.pane_id)) continue
    const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
    spawnHistory.value.push({
      paneId: saved.pane_id,
      agentKey: saved.agent,
      agentLabel: spec?.label ?? saved.agent,
      customName: saved.custom_name || undefined,
      autoName: saved.auto_name || undefined,
      roleKey: saved.role as RoleKey,
      roleLabel: roleLabel(saved.role),
      command: saved.command ?? '',
      sessionId: (saved.session_id ?? '').trim() || undefined,
      origin: 'manual',
      stageId: '' as StageId,
      workspacePath,
      spawnedAt: fallbackTs,
      removedAt: fallbackTs,
      outputLogFile: saved.output_log_file || undefined,
    })
    backfilledIds.add(saved.pane_id)
  }

  // Enrich backfilled entries with real timestamps from history.jsonl.
  // history.snapshot logs every pane event as "[pane <id-prefix>] ..." in summary;
  // we take the first/last ts per prefix to get accurate spawnedAt / removedAt.
  if (backfilledIds.size > 0) {
    void (async () => {
      try {
        type HistSnap = { events: Array<{ ts: string; summary: string }> }
        const histResp = await sendQuiet<HistSnap>('history.snapshot', { workspace_path: workspacePath })
        if (isStale?.() || !isLocalWorkspace(workspacePath)) return
        const events = histResp?.events
        if (Array.isArray(events)) {
          const paneRe = /\[pane ([a-f0-9]{8})\]/
          const paneTs = new Map<string, { first: string; last: string }>()
          for (const ev of events) {
            const m = paneRe.exec(ev.summary ?? '')
            if (!m) continue
            const prefix = m[1]
            const cur = paneTs.get(prefix)
            if (!cur) paneTs.set(prefix, { first: ev.ts, last: ev.ts })
            else {
              if (ev.ts < cur.first) cur.first = ev.ts
              if (ev.ts > cur.last) cur.last = ev.ts
            }
          }
          for (const entry of spawnHistory.value) {
            if (!backfilledIds.has(entry.paneId)) continue
            const ts = paneTs.get(entry.paneId.slice(0, 8))
            if (!ts) continue
            entry.spawnedAt = ts.first
            entry.removedAt = ts.last
          }
        }
      } catch {
        // non-fatal — fallback timestamps remain
      }
    })()
  }

  return coldBatch
}

function deferredPaneStillCurrent(
  paneId: string,
  deferred: DeferredRestoreMetadata,
): ActivePane | null {
  const { workspacePath } = deferred
  if (!isLocalWorkspace(workspacePath)) return null
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || pane.realized || pane.workspacePath !== workspacePath) return null
  return pane.deferredRestore === deferred ? pane : null
}

// A placeholder can receive activation from both a click and a pipeline resume
// path in the same tick. Keep one completion promise per pane so every caller
// waits for the same restore attempt instead of treating an in-flight restore as
// an immediate no-op.
const restoringPanePromises = new Map<string, Promise<void>>()

async function restoreSessionDecision(
  session: RestoreSession,
  batch: ColdRestoreBatch,
  retryCancelled = false,
): Promise<RestoreSessionDecision> {
  if (!session.decisionPromise) {
    session.decisionPromise = resolveWorkspaceRestoreSession({
      session,
      restorableCount: batch.records.length,
      retryCancelled,
      ask: () => askRestoreScope(batch.workspacePath, batch.records.length),
    })
  }
  try {
    return await session.decisionPromise
  } finally {
    session.decisionPromise = undefined
  }
}

function restoreSessionScopeTargets(session: RestoreSession, trigger: RestoreSessionTrigger): string[] {
  // The active tab and the Grid page describe the workspace on screen. For any
  // other workspace this window holds they list someone else's panes, which
  // mixed two workspaces together: 'single'/'page'/'tab' intersected to nothing,
  // while 'all' — the one scope that ignores visibility — added a background
  // workspace's entire pending list on top of the foreground one, so the CLIs a
  // window could start at once became the sum of every workspace it held.
  const onScreen = normWs(session.workspacePath) === normWs(currentWorkspace.value)
  return restoreScopeTargetIds({
    scope: session.scope,
    pendingPaneIds: pendingRestorePaneIds(panes.value, session.workspacePath),
    activeTabPaneIds: onScreen ? tabVisiblePanes.value.map((pane) => pane.id) : [],
    gridPagePaneIds: onScreen ? gridPagePanes.value.map((pane) => pane.id) : [],
    minimizedPaneIds: minimizedPanes.value,
    focusedPaneId: onScreen ? focusPaneId.value : null,
    trigger,
  })
}

async function advanceRestoreSession(trigger: RestoreSessionTrigger, coldBatch?: ColdRestoreBatch): Promise<void> {
  // A UI trigger means the workspace on screen — an active tab and a Grid page
  // are properties of what is being looked at. A cold trigger names its own.
  const path = coldBatch?.workspacePath ?? currentWorkspace.value
  const session = restoreSessions.get(path)
  if (!session || !isLocalWorkspace(session.workspacePath)) return
  const batch = coldBatch ?? panes.value.find(
    (pane) => !pane.realized && pane.deferredRestore?.workspacePath === session.workspacePath,
  )?.deferredRestore?.batch
  if (!batch) return
  const decision = await restoreSessionDecision(session, batch)
  if (
    decision === 'cancelled' ||
    restoreSessions.get(session.workspacePath) !== session ||
    !isLocalWorkspace(session.workspacePath)
  ) return
  const ids = decision === 'fresh'
    ? (trigger === 'cold'
      ? pendingRestorePaneIds(panes.value, session.workspacePath)
      : [])
    : restoreSessionScopeTargets(session, trigger)
  const reconnectStart = reconnectedCount.value
  // Starting a workspace fresh is the one batch nothing caps. Fresh spawns are
  // deliberately exempt from the resume semaphore — throttling them would stall
  // a pipeline stage spawned into a background tab — but that reasoning is about
  // ONE spawn. Starting a whole workspace fresh still costs the backend a
  // login-shell PATH refresh, a CLI probe and a PTY fork per pane, serially on
  // one event-loop thread, and isResume is false there, so the semaphore never
  // sees it: a twenty-pane workspace sent twenty terminal.create at once and the
  // later acks landed past the request deadline.
  //
  // Only this batch. A resume under 'single'/'page'/'tab' is already capped by
  // the semaphore at whatever the user set (default 3), so adding a second
  // ceiling of 2 would just make their own setting slower.
  const unthrottledBatch = decision === 'fresh' && trigger === 'cold'
  if (unthrottledBatch || (decision === 'resume' && session.scope === 'all')) {
    await runWithConcurrency(ids, ALL_SCOPE_RESTORE_CONCURRENCY, (paneId) => realizeRestoredPane(paneId, true))
  } else {
    await Promise.all(ids.map((paneId) => realizeRestoredPane(paneId, true)))
  }
  const reconnected = reconnectedCount.value - reconnectStart
  if (reconnected > 0) {
    notifyRestore.toast(i18n.global.t('reconnect.auto-toast', { count: reconnected }), { type: 'success' })
  }
}

/** Realize one cold-restore record after explicit user activation. */
async function realizeRestoredPane(paneId: string, aggregateReconnect = false): Promise<void> {
  const pending = restoringPanePromises.get(paneId)
  if (pending) return pending
  const promise = performRealizeRestoredPane(paneId, aggregateReconnect)
  restoringPanePromises.set(paneId, promise)
  void promise.then(
    () => {
      if (restoringPanePromises.get(paneId) === promise) restoringPanePromises.delete(paneId)
    },
    () => {
      if (restoringPanePromises.get(paneId) === promise) restoringPanePromises.delete(paneId)
    },
  )
  return promise
}

async function performRealizeRestoredPane(paneId: string, aggregateReconnect = false): Promise<void> {
  const placeholder = panes.value.find((p) => p.id === paneId)
  const deferred = placeholder?.deferredRestore
  if (!placeholder || placeholder.realized || placeholder.restoring) return
  if (!deferred) {
    // A placeholder is only ever written together with its deferredRestore, so
    // this cannot happen — but if some third writer ever sets realized = false
    // without one, the placeholder can never be opened and says nothing about
    // why. Leave a trace rather than another silent dead end.
    recordDiagnostic({
      level: 'warn',
      code: 'restore.noDeferred',
      message: 'restore placeholder has no deferred restore; it cannot be opened',
      paneId,
    })
    return
  }

  const saved = deferred.saved
  const batch = deferred.batch
  if (!isLocalWorkspace(deferred.workspacePath)) {
    // The window is running a pane in a workspace it no longer claims (detach
    // leaves them behind). The sidebar now lists it, so it can be clicked —
    // and clicking it would otherwise do nothing at all, forever.
    recordDiagnostic({
      level: 'warn',
      code: 'restore.foreignWorkspace',
      message: `restore needs workspace ${deferred.workspacePath}, which this window no longer holds`,
      paneId,
    })
    return
  }
  const session = workspaceRestoreSession(batch.workspacePath)
  const sessionId = normalizeResumeSessionId(saved.agent, (saved.session_id ?? '').trim())
  placeholder.restoring = true
  syncViews()

  try {
    const decision = await restoreSessionDecision(session, batch, true)
    if (decision === 'cancelled') return
    if (!deferredPaneStillCurrent(paneId, deferred)) return
    const forceFresh = decision === 'fresh'
    const spec = agentSpecs.find((s) => s.agentKey === saved.agent)
    const skipFlag = skipFlagFor(saved.agent, spec)
    const canResume = await canResumeSession(saved.agent, batch.workspacePath, sessionId, { timeoutMs: 2500 })
    if (!deferredPaneStillCurrent(paneId, deferred)) return
    if (!forceFresh && shouldPreserveMissingSessionOnRestore(saved.agent, sessionId, canResume === true)) {
      const unavailable = canResume === false ? 'restore.session-unavailable' : 'restore.session-unknown'
      pipelineLog(`⚠ ${saved.agent} session ${sessionId} is ${canResume === false ? 'unavailable' : 'unknown'}; preserving saved pane`)
      notifyRestore.toast(
        i18n.global.t(unavailable, { agent: spec?.label ?? saved.agent }),
        { type: 'error', duration: 8000 },
      )
      return
    }

    const attemptResume = !forceFresh && shouldAttemptResume(canResume)
    const chatHistoryFile = await savedHistoryFile(saved.agent, batch.workspacePath, saved.pane_id)
    if (!deferredPaneStillCurrent(paneId, deferred)) return
    let resumeCmd = attemptResume
      ? commandWithSelectedBinary(
          saved.agent,
          buildResumeCommand(saved.agent, sessionId, skipFlag, chatHistoryFile)
        )
      : ''
    const ghostConfirmed = !forceFresh && shouldWarnMissingResume(
      saved.agent, sessionId, canResume, looksLikeResumeCommand(saved.agent, saved.command || ''),
    )
    let reconnectId = ''
    if (ghostConfirmed && supportsGhostReconnect(saved.agent)) {
      reconnectId = await resolveReconnectForPane(saved, batch.workspacePath, batch.savedClaims)
      if (!deferredPaneStillCurrent(paneId, deferred)) return
    }
    let wasDisconnected = false
    if (reconnectId) {
      const repointed = await sendQuiet('pane.reconnect_session', {
        workspace_path: batch.workspacePath,
        pane_id: saved.pane_id,
        session_id: reconnectId,
      })
      if (!deferredPaneStillCurrent(paneId, deferred)) return
      if (repointed) {
        resumeCmd = commandWithSelectedBinary(
          saved.agent,
          buildResumeCommand(saved.agent, reconnectId, skipFlag)
        )
        reconnectedCount.value++
        pipelineLog(`↩ ${saved.agent}: auto-reconnected ${saved.pane_id} → ${reconnectId}`)
        if (!aggregateReconnect) {
          notifyRestore.toast(i18n.global.t('reconnect.auto-toast', { count: 1 }), { type: 'success' })
        }
      } else {
        reconnectId = ''
      }
    }
    if (ghostConfirmed && !reconnectId) {
      wasDisconnected = supportsGhostReconnect(saved.agent)
      pipelineLog(`⚠ ${saved.agent}: previous conversation ${sessionId} not found at ${batch.workspacePath}; opened a fresh one`)
      notifyRestore.toast(i18n.global.t('restore.session-not-found', { agent: saved.agent }), { type: 'error', duration: 8000 })
    }
    const isResume = !!resumeCmd
    const effectiveResumeId = reconnectId || sessionId
    const savedFallbackCommand = saved.command && !looksLikeResumeCommand(saved.agent, saved.command)
      ? stripDeadOpencodeAutoFlag(saved.agent, saved.command)
      : ''
    const fallbackCommand = isResume ? savedFallbackCommand : stripPinnedSessionId(savedFallbackCommand)
    const commandOverride = resumeCmd || fallbackCommand || ''
    const wasMinimized = minimizedPanes.value.has(paneId)
    const restored = await spawnRestoredPane({
      saved,
      workspacePath: batch.workspacePath,
      runGroupId: placeholder.runGroupId || undefined,
      spawnedBy: placeholder.spawnedBy,
      sessionHomeId: placeholder.sessionHomeId,
      profileId: saved.profile_id,
      commandOverride,
      fallbackCommand,
      isResume,
      resumeSessionId: effectiveResumeId,
      sessionKnownOnDisk: !isResume && canResume === true && RESTORE_PIN_AGENTS.includes(saved.agent),
      freshSessionId: !forceFresh && !isResume
        ? claimFreshSessionId(batch.usedFreshSessionIds, sessionId)
        : undefined,
      freshPipelineFallbackSessionId: isResume ? sessionId : '',
      preserveSessionPointer: forceFresh && canResume !== false,
      replacePaneId: paneId,
      restoring: true,
      shouldPersist: (newPaneId) =>
        isLocalWorkspace(batch.workspacePath) && panes.value.some((p) => p.id === newPaneId),
    })
    if (!restored) return
    const { paneId: newId } = restored
    // A resumed CLI has its transcript back but is parked at the prompt, and the
    // restore path deliberately injects nothing. Offer the one-click continue.
    if (isResume) {
      const revived = panes.value.find((p) => p.id === newId)
      if (revived) revived.resumeContinueAvailable = true
    }
    if (wasDisconnected) disconnectedPaneIds.value = [...disconnectedPaneIds.value, newId]
    // First output normally clears this state. A restored CLI can be silent
    // indefinitely, so leave the terminal usable after a bounded grace period.
    window.setTimeout(() => onPaneFirstOutput(newId), 15_000)

    // Replacement panes get a fresh runtime id; carry the user's layout state
    // across the atomic swap and persist it against the new id.
    const minimized = new Set(minimizedPanes.value)
    minimized.delete(paneId)
    if (wasMinimized) minimized.add(newId)
    minimizedPanes.value = minimized
    if (wasMinimized) persistPaneMinimized(newId, true)

    if (saved.stopped) paneRefs[newId]?.setStopped(true)

  } finally {
    const current = panes.value.find((p) => p.id === paneId)
    if (current && !current.realized && current.deferredRestore === deferred) {
      current.restoring = false
    }
    syncViews()
  }
}

async function onRefreshAnalyzer(): Promise<void> {
  pipelineLog('🧠 refreshing analyzer health + model list')
  const h = await analyzerApi.refreshHealth()
  if (h?.ok) {
    await analyzerApi.refreshModels()
    pipelineLog(
      `🧠 ${analyzerApi.models.value.length} model(s) · Ollama ${h.version}`
    )
  } else {
    pipelineLog(`🧠 Ollama unreachable: ${h?.error ?? 'unknown'}`)
  }
}


async function onPipelineRestart(payload: { task: string; workspacePath: string }): Promise<void> {
  // Cancel any running watchers / questions left from a previous attempt
  // before we overwrite project state.
  cancelAllWatchers()
  activeQuestion.value = null
  // Kill any pipeline-origin panes still hanging around so we get a clean grid.
  for (const p of [...panes.value]) {
    if (p.origin === 'pipeline') await onKill(p.id, { markRemoved: false })
  }
  pipelineLog('↺ Start over — wiping previous stages and re-running from 01')
  await onPipelineStart(payload)
}

async function onPipelineResume(): Promise<void> {
  const info = existingProject.value
  if (!info) return
  if (info.nextStageIndex < 0) return
  // Wire the local pipeline state from the existing project, then call the
  // backend's resume endpoint and spawn the resume stage.
  pipeline.task = info.taskDescription
  pipeline.workspacePath = info.projectFile.replace(/\/\.agent-team\/project\.json$/, '')
  pipeline.stageIndex = info.nextStageIndex
  pipeline.state = 'running'
  pipeline.log = []
  pipelineLog(`Resuming pipeline · jumping to Stage ${stagesApi.stages.value[info.nextStageIndex]?.id}`)
  const resp = await sendQuiet<ProjectPayload>('pipeline.resume', {
    workspace_path: pipeline.workspacePath
  })
  applyProjectPaths(resp ?? undefined)
  // Refresh the peek so the banner disappears now that we're running.
  existingProject.value = null
  // Cold restore keeps pipeline panes as placeholders; an explicit pipeline
  // resume realizes those records before activateStage injects any kickoff.
  const pendingPipeline = panes.value
    .filter((p) => !p.realized && p.origin === 'pipeline')
    .map((p) => p.id)
  await Promise.all(pendingPipeline.map((id) => realizeRestoredPane(id)))
  if (pipeline.state !== 'running') return
  // activateStage builds context from prior stages and injects kickoffs.
  await activateStage(info.nextStageIndex)
}

// Orders every project.set_ui_state write per (workspace, state-field) key so
// a delayed retry never overwrites a newer snapshot (see sendWithUiStateRetry).
const uiStateSeqGuard = createUiStateSeqGuard()

async function sendQuiet<T = unknown>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs?: number
): Promise<T | null> {
  try {
    // project.set_ui_state gets exactly one retry on timeout: it carries
    // freshly computed spawn-history/run-group state that a single cold-start
    // storm timeout would otherwise lose permanently (see sessionHeal.ts).
    // The seq guard drops the retry if a NEWER send for the same UI-state
    // field(s) was issued during the delay — the retry's stale snapshot must
    // not win a last-writer-wins race against fresher state.
    const resp = await sendWithUiStateRetry(
      (t, p) => backend.send<T>(t, p, timeoutMs),
      type,
      payload,
      500,
      uiStateSeqGuard
    )
    if (!resp.ok) {
      pipelineLog(`${type} failed: ${resp.error?.message ?? 'unknown'}`)
      return null
    }
    return resp.payload
  } catch (err) {
    pipelineLog(`${type} threw: ${String((err as Error).message ?? err)}`)
    return null
  }
}

// ── Leftover CLI process cleanup (status-bar indicator) ─────────────────────
// A previous backend run that died without its shutdown sweep can leave PTY
// children (claude/codex) alive; enough of them exhausts RAM (observed: dozens
// of leftover `claude` eating swap, making every new CLI unlaunchable). Surface
// the count in the status bar so it's visible BEFORE it degrades the machine;
// click to clean up. Main window only — child windows share the same backend.
const orphanCount = ref(0)
// Background historic-log backfill status for the status bar (so a big token
// history being tidied reads as "working", not "frozen at startup").
const backfill = reactive({ active: false, count: 0 })
// Clear the indicator when the workspace changes/closes: backfill.changed is
// filtered by currentWorkspace, so the old workspace's remaining progress/done
// events would otherwise never arrive and the pill would stick on. Switching
// back to a still-backfilling workspace re-lights it on the next broadcast.
watch(currentWorkspace, () => { backfill.active = false; backfill.count = 0 })

async function refreshOrphanCount(): Promise<void> {
  if (isDetachedWindow) return
  const resp = await sendQuiet<{ count: number }>('agent.orphan_scan', {})
  orphanCount.value = resp?.count ?? 0
}

async function reapOrphans(): Promise<void> {
  if (orphanCount.value <= 0) return
  const ok = await notifyRestore.confirm(
    i18n.global.t('orphans.confirm', { count: orphanCount.value }),
    {
      title: i18n.global.t('orphans.title'),
      confirmText: i18n.global.t('orphans.clean'),
      cancelText: i18n.global.t('restore.dismiss'),
    },
  )
  if (!ok) return
  const resp = await sendQuiet<{ count: number }>('agent.reap_orphans', {})
  if (resp) {
    notifyRestore.toast(i18n.global.t('orphans.cleaned', { count: resp.count ?? 0 }), { type: 'success' })
  } else {
    notifyRestore.toast(i18n.global.t('orphans.failed'), { type: 'error' })
  }
  await refreshOrphanCount()
}

// ── Lost-conversation reconnect (ghost panes) ───────────────────────────────
// On workspace restore a pane whose saved session id has no transcript is a
// "ghost". It is surfaced in a dismissible status-bar banner that opens a
// manual picker.
const reconnectedCount = ref(0)
const disconnectedPaneIds = ref<string[]>([])
const disconnectedCount = computed(() => disconnectedPaneIds.value.length)
const reconnectBannerDismissed = ref(false)
const reconnectPickerOpen = ref(false)
const reconnectPickerPaneId = ref('')
const reconnectOrphans = ref<OrphanSession[]>([])
const reconnectLoading = ref(false)

async function resolveReconnectForPane(
  saved: ProjectPane,
  workspacePath: string,
  savedClaims: ProjectPane[],
): Promise<string> {
  const paneInfo = {
    paneId: saved.pane_id,
    customName: saved.custom_name || '',
    sessionId: (saved.session_id ?? '').trim(),
  }
  const candidateIds = reconnectCandidateSessionIds(paneInfo, spawnHistory.value)
  if (candidateIds.length === 0) return ''
  const existing = new Set<string>()
  await Promise.all(candidateIds.map(async (id) => {
    if ((await canResumeSession(saved.agent, workspacePath, id)) === true) existing.add(id)
  }))
  const inWindowPanes = panes.value.map((pane) => ({ paneId: pane.id, sessionId: (pane.pinnedSessionId ?? '').trim() }))
  const savedExclusion = savedClaims.map((pane) => ({ paneId: pane.pane_id, sessionId: (pane.session_id ?? '').trim() }))
  return resolveDeterministicReconnect(paneInfo, spawnHistory.value, (id) => existing.has(id), [...inWindowPanes, ...savedExclusion]) ?? ''
}

/** Ghost gating for the pane context menu: a Claude pane flagged disconnected
 *  during the last restore (its saved id had no transcript). */
function isGhostPane(view: ActivePaneView | null): boolean {
  return !!view && supportsGhostReconnect(view.agentKey) && disconnectedPaneIds.value.includes(view.id)
}

function dismissReconnectBanner(): void {
  reconnectBannerDismissed.value = true
}

/** Open the manual reconnect picker for a pane, loading the workspace's orphan
 *  transcripts. */
async function openReconnectPicker(paneId: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  reconnectPickerPaneId.value = paneId
  reconnectOrphans.value = []
  reconnectLoading.value = true
  reconnectPickerOpen.value = true
  const resp = await sendQuiet<{ orphans: RawOrphanSession[] }>('workspace.list_orphan_sessions', {
    workspace_path: pane.workspacePath,
  })
  if (reconnectPickerPaneId.value !== paneId) return // superseded by another open
  reconnectLoading.value = false
  // Backend rows carry `custom_name`; the picker reads `.name`. Map explicitly
  // (checked) instead of casting — the bare cast left every row "(unnamed)".
  reconnectOrphans.value = (resp?.orphans ?? []).map(mapOrphanSession)
}

/** Confirm a manual reconnect: point the pane's saved record at the chosen
 *  session (with a project.json backup), re-resume it, then retire the ghost
 *  pane so the workspace holds one live pane per conversation. */
async function onConfirmReconnect(sessionId: string): Promise<void> {
  const paneId = reconnectPickerPaneId.value
  reconnectPickerOpen.value = false
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  // A failed re-point (e.g. NO_TRANSCRIPT — the transcript vanished between the
  // picker load and confirm) returns null from sendQuiet. Surface it and keep
  // the ghost pane instead of killing it against a resume that never happened.
  const repointed = await sendQuiet('pane.reconnect_session', {
    workspace_path: pane.workspacePath,
    pane_id: paneId,
    session_id: sessionId,
  })
  if (!repointed) {
    notifyRestore.toast(i18n.global.t('reconnect.failed'), { type: 'error', duration: 8000 })
    return
  }
  const ok = await onManualResume({
    agentKey: pane.agentKey,
    workspacePath: pane.workspacePath,
    sessionId,
    customName: pane.customName,
    nameLocked: pane.nameLocked,
    autoName: pane.autoName,
    runGroupId: pane.runGroupId,
  })
  if (ok) {
    await onKill(paneId)
    disconnectedPaneIds.value = disconnectedPaneIds.value.filter((id) => id !== paneId)
  }
}

/** Status-bar "close all": kill every session pane and close this window's
 *  run-group tabs, freeing the project's resources. Spawn history is kept
 *  (onKill only stamps removedAt); groups handed off to detached windows are
 *  left untouched. Always confirms before acting. */
async function closeAllSessions(): Promise<void> {
  const count = panes.value.length
  if (count === 0) return
  const ok = await notifyRestore.confirm(
    i18n.global.t('closeAll.confirm', { count }),
    {
      title: i18n.global.t('closeAll.confirmTitle'),
      confirmText: i18n.global.t('closeAll.confirmBtn'),
      cancelText: i18n.global.t('restore.dismiss'),
    },
  )
  if (!ok) return
  if (pipeline.state === 'running') await onPipelineAbort()
  for (const p of [...panes.value]) await onKill(p.id)
  runGroups.value = runGroups.value.filter((g) => detachedGroupIds.value.has(g.id))
  if (!runGroups.value.some((g) => g.id === currentRunGroupId.value)) currentRunGroupId.value = ''
  activeTab.value = ''
  notifyRestore.toast(i18n.global.t('closeAll.done', { count }), { type: 'success' })
}

/** Fetch framework docs from Context7 via MCP. Returns "" on failure (best-effort). */
async function fetchDocPrefix(stageDocQuery: string): Promise<string> {
  if (!pipeline.task) return ''
  try {
    const resp = await backend.send<{ doc_prefix: string }>(
      'pipeline.fetch_docs',
      {
        task: pipeline.task,
        doc_query: stageDocQuery,
        workspace_path: pipeline.workspacePath ?? '',
        analyzer_model: analyzerModel.value,
      },
      90_000   // 90 s — LLM detect + Context7 cold-start + relevance pass
    )
    if (resp.ok && resp.payload?.doc_prefix) {
      pipelineLog(`📚 injected ${resp.payload.doc_prefix.length} chars (LLM-enhanced)`)
      return resp.payload.doc_prefix
    }
  } catch {
    // silent — kickoff still works without docs
  }
  return ''
}

function pipelineLog(line: string): void {
  const ts = new Date().toLocaleTimeString()
  const entry = `[${ts}] ${line}`
  pipeline.log.push(entry)
  if (pipeline.log.length > 200) pipeline.log.splice(0, pipeline.log.length - 200)
  // Persist to the run-specific pipeline log when a workspace is active.
  if (pipeline.workspacePath) {
    backend.send('project.log_event', {
      workspace_path: pipeline.workspacePath,
      event_type: 'orchestrator_log',
      pane_id: '',
      details: { line: entry }
    }).catch(() => { /* ignore */ })
  }
}

/** Spawn all slots for one stage WITHOUT injecting kickoffs.
 *  Each slot gets its role prompt (via watchPaneStartup) then waits at the
 *  interactive prompt. Call activateStage() later to inject the kickoff. */
async function preSpawnStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })
  pipelineLog(`Stage ${stage.id} ⚡ pre-spawn ${stage.slots.length} slot(s) (role only)`)
  await Promise.all(stage.slots.map(async (slot) => {
    pipelineLog(`Stage ${stage.id}/${slot.label} → pre-spawn ${slot.agentKey} as ${slot.roleKey}`)
    const paneId = await spawnPane({
      agentKey: slot.agentKey as AgentKey,
      roleKey: slot.roleKey,
      stageId: stage.id,
      slotLabel: slot.label,
      commandOverride: '',
      workspacePath: pipeline.workspacePath,
      origin: 'pipeline',
      runGroupId: currentRunGroupId.value,
      // No kickoffPrompt → kickoffStatus='none' → scheduleInjection stops after role
    })
    if (paneId) {
      await sendQuiet<ProjectPayload>('pipeline.slot_spawn', {
        workspace_path: pipeline.workspacePath,
        stage_index: index,
        slot_label: slot.label,
        pane_id: paneId,
        agent: slot.agentKey,
        role: slot.roleKey,
        // Claude's pinned id is known now; Codex/Antigravity stay "" until detected.
        session_id: panes.value.find((p) => p.id === paneId)?.pinnedSessionId ?? '',
        session_home_id: panes.value.find((p) => p.id === paneId)?.sessionHomeId ?? '',
        run_group_id: currentRunGroupId.value,
      })
    }
  }))
}

/** Build cross-stage context for ONE slot's kickoff — doc-driven, not inlined.
 *
 *  Replaces the old "paste up to 60KB of prior terminal buffers into every
 *  kickoff" approach (which produced ~68KB kickoffs that broke bracketed-paste
 *  submission and stalled stage hand-off). Now:
 *    • Workers get a short tail-summary (final output is usually at the end) plus
 *      the relative path to each prior output log — kickoff stays small; the
 *      agent reads the file on demand for detail.
 *    • The Manager gets the full roster of every prior output file with an
 *      instruction to read them all — it coordinates, so it needs the whole
 *      history, not just summaries.
 *  Paths are relative to the workspace (the agent's cwd), so the CLI can open
 *  them directly. Uses prevPane.outputLogFile + the live cleanBuffer. */
function buildStageContext(index: number, forManager: boolean): string {
  const WORKER_SUMMARY = 1200
  const blocks: string[] = []
  for (let i = 0; i < index; i++) {
    const prevStage = stagesApi.stages.value[i]
    if (!prevStage) continue
    const prevPanes = panes.value.filter(
      (p) => p.stageId === prevStage.id && p.origin === 'pipeline'
    )
    for (const prevPane of prevPanes) {
      const label = prevPane.slotLabel
        ? `${prevStage.title} · ${prevPane.slotLabel}`
        : prevStage.title
      const relPath =
        prevPane.outputLogFile && pipeline.workspacePath
          ? prevPane.outputLogFile.replace(`${pipeline.workspacePath}/`, '')
          : (prevPane.outputLogFile ?? '')
      if (forManager) {
        blocks.push(`- [${label}] 📄 ${relPath || '(無 log 檔)'}`)
      } else {
        const ref = paneRefs[prevPane.id]
        const buf = ((ref?.cleanBuffer as unknown as string) ?? '').trim()
        if (!buf && !relPath) continue
        const summary =
          buf.length > WORKER_SUMMARY ? `…${buf.slice(-WORKER_SUMMARY)}` : buf || '(無輸出)'
        blocks.push(`- [${label}]\n  摘要：${summary}\n  📄 完整內容：${relPath || '(無 log 檔)'}`)
      }
    }
  }
  if (blocks.length === 0) return ''
  return forManager
    ? `[完整前置歷程 — 你是 Manager，負責協調，請逐一完整讀取下列檔案]\n${'='.repeat(60)}\n${blocks.join('\n')}\n${'='.repeat(60)}\n\n`
    : `[前置階段產出 — 下為摘要，需要細節請讀對應檔案]\n${'='.repeat(60)}\n${blocks.join(`\n${'─'.repeat(60)}\n`)}\n${'='.repeat(60)}\n（開始前請先讀取與你任務相關的檔案）\n\n`
}

/** Inject kickoffs into pre-spawned panes for one stage, then arm watchers.
 *  Builds cross-stage context from prior stages (which now have real output).
 *  Safe to call on a freshly-spawned stage too (same as old spawnPipelineStage). */
async function activateStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return

  // Cross-stage context is now built per-slot inside the loop below (doc-driven:
  // summaries + file paths for workers, full file roster for the Manager).
  const docPrefix = await fetchDocPrefix(stage.docQuery ?? '')

  const managerSlot: StageSlot | null = stageCommanderSlot(stage)
  const otherSlotsRoster = managerSlot
    ? stage.slots
        .filter((s) => s !== managerSlot)
        .map((s) => ({
          label: s.label,
          agentLabel: agentSpecs.find((a) => a.agentKey === s.agentKey)?.label ?? s.agentKey,
          roleLabel: roleLabel(s.roleKey),
        }))
    : []

  pipelineLog(
    `Stage ${stage.id} ▶ activate ${stage.slots.length} slot(s)` +
    (managerSlot ? ` · 🎯 Manager: ${managerSlot.label}` : '')
  )

  // A cold placeholder has no PTY to receive this stage's kickoff. Drop only
  // the local restored record; the normal per-slot fallback below then creates
  // one fresh pane and updates the backend through pipeline.stage_spawn.
  const unrealizedPaneIds = panes.value
    .filter((pane) => !pane.realized && pane.stageId === stage.id && pane.origin === 'pipeline')
    .map((pane) => pane.id)
  if (unrealizedPaneIds.length > 0) {
    await Promise.all(unrealizedPaneIds.map((paneId) => onKill(paneId, { markRemoved: false })))
  }

  // Reset completion tracker in case it was partially consumed
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })

  await Promise.all(stage.slots.map(async (slot) => {
    // Per-slot cross-stage context: workers get summaries + paths, the Manager
    // gets the full prior-output file roster (it coordinates, needs everything).
    const contextHeader = buildStageContext(index, slot === managerSlot)
    // Find the pre-spawned pane for this slot
    const pane = panes.value.find(
      (p) => p.stageId === stage.id && p.slotLabel === slot.label && p.origin === 'pipeline'
    )

    // Unrealized panes were ruled out above, so this is the genuine
    // never-pre-spawned case.
    if (!pane) {
      // Fallback: slot was never pre-spawned — spawn it now with kickoff
      pipelineLog(`Stage ${stage.id}/${slot.label} → not pre-spawned, spawning now`)
      const kickoff =
        docPrefix + contextHeader +
        renderSlotKickoff(slot, pipeline.task, {
          allowQuestions: stage.allowQuestions,
          isCommander: slot === managerSlot,
          hasCommander: !!managerSlot && slot !== managerSlot,
          commanderLabel: managerSlot?.label,
          slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
        })
      const paneId = await spawnPane({
        agentKey: slot.agentKey as AgentKey,
        roleKey: slot.roleKey,
        stageId: stage.id,
        slotLabel: slot.label,
        commandOverride: '',
        workspacePath: pipeline.workspacePath,
        origin: 'pipeline',
        runGroupId: currentRunGroupId.value,
        kickoffPrompt: kickoff
      })
      if (paneId) {
        await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
          workspace_path: pipeline.workspacePath,
          stage_index: index,
          pane_id: paneId,
          agent: slot.agentKey,
          role: slot.roleKey
        })
        if (managerSlot) {
          const router = ensureStageRouter(index)
          if (slot === managerSlot) router.managerPaneId = paneId
          else router.workerPaneIds.set(slot.label, paneId)
        }
      }
      return
    }

    const tag = `[${stage.id}/${slot.label}]`

    // Wait for scheduleInjection to finish role injection before sending kickoff.
    // Must wait for 'sent'/'failed'/'skipped' — 'scheduled' means scheduleInjection
    // has started but the role bytes haven't hit the agent yet. Injecting kickoff
    // while status is still 'scheduled' causes the agent to receive the task before
    // its role context, so it has no instructions and does nothing.
    const ROLE_WAIT_MS = 60_000
    const t0 = Date.now()
    while (
      (pane.injectionStatus === 'pending' || pane.injectionStatus === 'scheduled') &&
      Date.now() - t0 < ROLE_WAIT_MS
    ) {
      await sleep(500)
    }
    if (!paneAlive(pane.id)) return

    // If role was deferred (skipRoleInjection), inject it now before kickoff
    if (pane.injectionStatus === 'skipped') {
      const role = rolesApi.find(pane.roleKey)
      if (!role) {
        pipelineLog(`${tag} ✕ role '${pane.roleKey}' not found`)
        return
      }
      const roleContent = role.system_prompt + ROLE_STANDBY_SUFFIX + sessionMarkerLine(pane.sessionMarker)
      pipelineLog(`${tag} ➜ injecting role '${role.label}' (deferred, ${roleContent.length} chars)`)
      // bracketed paste (preserveNewlines) — same as kickoff — to avoid a raw
      // keystroke burst flooding the PTY input buffer.
      const roleOk = await injectPane(pane.id, roleContent, `role:${role.label}`, true)
      pane.injectionStatus = roleOk ? 'sent' : 'failed'
      syncViews()
      if (!roleOk) {
        // Honest record: role didn't land. Continue to kickoff anyway (agent
        // may recover; watcher backstop covers a genuine no-start).
        pipelineLog(`${tag} ✕ deferred role injection failed (agent didn't react) — continuing anyway`)
      } else {
        pipelineLog(`${tag} ✓ role injected`)
      }
      // Wait for agent to acknowledge the role before injecting kickoff
      const settleResult = await waitForActivityThenSettle(pane.id, 2500, 30_000)
      if (!paneAlive(pane.id)) return
      if (settleResult === 'no-activity') {
        pipelineLog(`${tag} ⚠ agent silent after role — sending kickoff anyway`)
      }
    }

    const kickoff =
      docPrefix + contextHeader +
      renderSlotKickoff(slot, pipeline.task, {
        allowQuestions: stage.allowQuestions,
        isCommander: slot === managerSlot,
        hasCommander: !!managerSlot && slot !== managerSlot,
        commanderLabel: managerSlot?.label,
        slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
      }) +
      sessionMarkerLine(pane.sessionMarker)
    pipelineLog(`${tag} ➜ injecting kickoff (${kickoff.length} chars)`)
    const MAX_KICKOFF_ATTEMPTS = 3
    let ok = false
    for (let attempt = 1; attempt <= MAX_KICKOFF_ATTEMPTS; attempt++) {
      ok = await injectPane(pane.id, kickoff, `kickoff:stage-${stage.id}`, true)
      if (ok) break
      if (attempt < MAX_KICKOFF_ATTEMPTS) {
        pipelineLog(`${tag} ✕ kickoff injection failed (attempt ${attempt}/${MAX_KICKOFF_ATTEMPTS}) — retrying in 3s`)
        await sleep(3_000)
        if (!paneAlive(pane.id)) return
      }
    }
    pane.kickoffStatus = ok ? 'sent' : 'failed'
    syncViews()
    await sendQuiet('pipeline.slot_kickoff', {
      workspace_path: pipeline.workspacePath,
      stage_index: index,
      slot_label: slot.label,
      kickoff_status: ok ? 'sent' : 'failed',
    })
    if (!ok) {
      pipelineLog(`${tag} ✕ kickoff injection failed after ${MAX_KICKOFF_ATTEMPTS} attempts — arming watcher anyway`)
    } else {
      pipelineLog(`${tag} ✓ kickoff sent`)
    }

    // For question-interactive stages (P01): capture scanFrom AFTER kickoff is
    // confirmed so the watcher only scans content produced after the kickoff.
    // For other stages: pass undefined — startStageWatcher uses markBufferPosition()
    // at arm time, and the agentGenerating guard handles the stabilisation wait.
    const kickoffScanFrom = stage.allowQuestions
      ? (paneRefs[pane.id]?.markBufferPosition as () => number | undefined)?.()
      : undefined

    // Notify backend: mark this stage running (and previous completed).
    // Same role as pipeline.stage_spawn in the old spawnPipelineStage flow.
    const stageResp = await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
      workspace_path: pipeline.workspacePath,
      stage_index: index,
      pane_id: pane.id,
      agent: slot.agentKey,
      role: slot.roleKey,
    })
    applyProjectPaths(stageResp ?? undefined)

    // Wire Manager router
    if (managerSlot) {
      const router = ensureStageRouter(index)
      if (slot === managerSlot) router.managerPaneId = pane.id
      else router.workerPaneIds.set(slot.label, pane.id)
    }

    startStageWatcher(index, pane.id, kickoffScanFrom)
  }))

  if (managerSlot) {
    startRouterPoll(index)
    pipelineLog(`Stage ${stage.id} 🎯 Manager router poll started`)
  }
}

async function spawnPipelineStage(index: number): Promise<void> {
  const stage = stagesApi.stages.value[index]
  if (!stage) return

  // Cross-stage context is built per-slot inside the loop below (doc-driven:
  // summaries + file paths for workers, full file roster for the Manager) —
  // no more inlining up to 60KB of prior buffers into every kickoff.

  // Fetch framework docs from Context7 — best-effort, non-blocking on failure
  const docPrefix = await fetchDocPrefix(stage.docQuery ?? '')

  // Detect Manager designation (at most one per stage; ignored for lone slots).
  const managerSlot: StageSlot | null = stageCommanderSlot(stage)
  stageCompletions.set(index, { expected: stage.slots.length, done: new Set() })
  pipelineLog(
    `Stage ${stage.id} → ${stage.slots.length} agent(s)` +
    (managerSlot ? ` · 🎯 Manager: ${managerSlot.label}` : '')
  )

  // For Manager-mode kickoff rendering: prepare slot roster for Manager,
  // and labels of other slots for Workers.
  const otherSlotsRoster = managerSlot
    ? stage.slots
        .filter((s) => s !== managerSlot)
        .map((s) => ({
          label: s.label,
          agentLabel:
            agentSpecs.find((a) => a.agentKey === s.agentKey)?.label ?? s.agentKey,
          roleLabel: roleLabel(s.roleKey),
        }))
    : []

  await Promise.all(stage.slots.map(async (slot) => {
    const contextHeader = buildStageContext(index, slot === managerSlot)
    const kickoff =
      docPrefix +
      contextHeader +
      renderSlotKickoff(slot, pipeline.task, {
        allowQuestions: stage.allowQuestions,
        isCommander: slot === managerSlot,
        hasCommander: !!managerSlot && slot !== managerSlot,
        commanderLabel: managerSlot?.label,
        slotRoster: slot === managerSlot ? otherSlotsRoster : undefined,
      })
    pipelineLog(
      `Stage ${stage.id}/${slot.label} → spawn ${slot.agentKey} as ${slot.roleKey}` +
      (slot === managerSlot ? ' 🎯' : managerSlot ? ' (worker)' : '')
    )
    const paneId = await spawnPane({
      agentKey: slot.agentKey as AgentKey,
      roleKey: slot.roleKey,
      stageId: stage.id,
      slotLabel: slot.label,
      commandOverride: '',
      workspacePath: pipeline.workspacePath,
      origin: 'pipeline',
      runGroupId: currentRunGroupId.value,
      kickoffPrompt: kickoff
    })
    if (paneId) {
      const resp = await sendQuiet<ProjectPayload>('pipeline.stage_spawn', {
        workspace_path: pipeline.workspacePath,
        stage_index: index,
        pane_id: paneId,
        agent: slot.agentKey,
        role: slot.roleKey
      })
      applyProjectPaths(resp ?? undefined)
      // Wire Manager-mode router: track this pane's role.
      if (managerSlot) {
        const router = ensureStageRouter(index)
        if (slot === managerSlot) {
          router.managerPaneId = paneId
        } else {
          router.workerPaneIds.set(slot.label, paneId)
        }
      }
    }
  }))

  // Manager-mode: start the per-stage router poll loop (scans buffers,
  // routes ASK/REPORT/DISPATCH/MANAGER-READY/STAGE-DONE).
  if (managerSlot) {
    startRouterPoll(index)
    pipelineLog(`Stage ${stage.id} 🎯 Manager router poll started (${ROUTER_POLL_MS / 1000}s)`)
  }
}

async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string }): Promise<void> {
  // If a specific pipeline was requested and it's not currently active, switch first.
  if (payload.pipelineId && payload.pipelineId !== pipelinesApi.activePipelineId.value) {
    await pipelinesApi.setActivePipeline(payload.pipelineId, payload.workspacePath)
    // Reload stages for the newly-active pipeline before running.
    await stagesApi.refresh()
  }
  if (!stagesApi.isLoaded.value || stagesApi.stages.value.length === 0) {
    pipelineLog('Pipeline start skipped: stages not loaded yet. Please wait and try again.')
    return
  }
  pipeline.task = payload.task
  pipeline.workspacePath = payload.workspacePath
  pipeline.stageIndex = 0
  pipeline.state = 'running'
  // Pipeline-created panes are grouped under a RunGroup tab named after the
  // Pipeline itself. Keep this separate from pipeline.task, which is the user's
  // task prompt and should not become a tab/group label.
  createRunGroup(pipelineRunGroupName(payload.pipelineId))
  // Derive global commander from stage config (slot with isCommander=true).
  let globalManager: GlobalManagerRef | null = null
  for (const s of stagesApi.stages.value) {
    const cmdSlot = s.slots.find((sl) => sl.isCommander)
    if (cmdSlot) {
      globalManager = { stageId: s.id, slotLabel: cmdSlot.label }
      break
    }
  }
  pipeline.globalManager = globalManager
  pipeline.log = []
  pipelineLog(`Pipeline started · ${stagesApi.stages.value.length} stages · cwd=${payload.workspacePath}`)
  const stageBlueprint = stagesApi.stages.value.map((s) => ({
    stage_id: s.id,
    title: s.title,
    sentinel: s.sentinel ?? '',
    slots: s.slots.map((sl) => ({ agent: sl.agentKey, role: sl.roleKey, label: sl.label }))
  }))
  const resp = await sendQuiet<ProjectPayload>('pipeline.start', {
    workspace_path: payload.workspacePath,
    task_description: payload.task,
    total_stages: stagesApi.stages.value.length,
    stage_blueprint: stageBlueprint,
    pipeline_id: pipelinesApi.activePipelineId.value,
  })
  applyProjectPaths(resp ?? undefined)
  if (resp?.paths) {
    pipelineLog(`project.json → ${resp.paths.project_file}`)
    pipelineLog(`pipeline.log → ${resp.paths.pipeline_log}`)
  }
  // Clear any stale Resume banner since we just overwrote project state.
  existingProject.value = null
  // Pre-spawn all stage slots simultaneously (role prompt only, no kickoff).
  await Promise.all(stagesApi.stages.value.map((_, i) => preSpawnStage(i)))
  // Activate stage 0: build context + inject kickoffs + arm watchers.
  await activateStage(0)
  // Start the global Manager cross-stage router (if configured).
  if (pipeline.globalManager) startGlobalManagerRouter()
}

/** Before firing 🎉 on the final stage, wait until every pipeline pane has
 *  stopped producing output (raw PTY quiet for `quietMs`) so we don't claim
 *  "done" while a worker is still flushing files / writing a final commit.
 *  Gives up after `hardCapMs` so a chatty TUI can't block the UI forever. */
async function waitForStagePanesSettled(
  stageIndex: number,
  options: { quietMs?: number; hardCapMs?: number } = {}
): Promise<void> {
  const quietMs = options.quietMs ?? 5_000
  const hardCapMs = options.hardCapMs ?? 120_000

  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const stagePanes = panes.value.filter(
    (p) => p.stageId === stage.id && p.origin === 'pipeline'
  )
  if (stagePanes.length === 0) return

  const startedAt = Date.now()
  while (Date.now() - startedAt < hardCapMs) {
    if (pipeline.state !== 'running') return
    const now = Date.now()
    const stillBusy: string[] = []
    for (const pane of stagePanes) {
      const ref = paneRefs[pane.id]
      const lastRaw = (ref?.lastRawActivityAt as unknown as number) ?? 0
      const quietFor = lastRaw === 0 ? Infinity : now - lastRaw
      if (quietFor < quietMs) {
        const label = pane.slotLabel || pane.id.slice(0, 8)
        stillBusy.push(`${label}(busy ${Math.round(quietFor / 1000)}s)`)
      }
    }

    if (stillBusy.length === 0) {
      pipelineLog(`Stage ${stage.id} ✓ all ${stagePanes.length} pane(s) quiet`)
      return
    }
    pipelineLog(`Stage ${stage.id} ⏳ waiting on: ${stillBusy.join(', ')}`)
    await sleep(3_000)
  }
  pipelineLog(
    `Stage ${stage.id} ⏰ settle cap ${Math.round(hardCapMs / 1000)}s — firing completion anyway`
  )
}

/** Resolve the live pane id for the global Manager (null if not configured or
 *  not yet spawned). Used by the cross-stage router to inject messages. */
function globalManagerPaneId(): string | null {
  const gm = pipeline.globalManager
  if (!gm) return null
  const pane = panes.value.find(
    (p) => p.realized && p.stageId === gm.stageId && p.slotLabel === gm.slotLabel && p.origin === 'pipeline'
  )
  return pane?.id ?? null
}

async function onPipelineNext(): Promise<void> {
  if (pipeline.state !== 'running') return
  const currentIndex = pipeline.stageIndex
  // Tear down the current stage's Manager router (if any) before advancing.
  // BUT: if this stage contains the global Manager pane, do NOT cancel its
  // watcher — it stays alive and keeps listening across all future stages.
  const gm = pipeline.globalManager
  const currentStage = stagesApi.stages.value[currentIndex]
  const isGlobalManagerStage = gm && currentStage?.id === gm.stageId
  if (isGlobalManagerStage) {
    // Cancel all watchers EXCEPT the global Manager pane itself.
    const managerPaneId = globalManagerPaneId()
    for (const [pid, w] of [...watchers.entries()]) {
      if (pid !== managerPaneId) cancelWatcher(pid)
    }
    pipelineLog(`Stage ${currentStage?.id} 🎯 Global Manager pane stays alive across stages`)
  }
  disposeStageRouter(currentIndex)
  const nextIndex = currentIndex + 1
  if (nextIndex >= stagesApi.stages.value.length) {
    // Final stage finished. Wait for every pane in this stage to be raw-PTY
    // quiet before firing 🎉 so we don't claim "done" while a worker is
    // still flushing files / writing a final commit.
    await waitForStagePanesSettled(currentIndex)
    if (pipeline.state !== 'running') return // abort fired during settle
    stopGlobalManagerRouter()
    pipeline.state = 'completed'
    currentMode.value = 'completed'
    pipelineLog('🎉 Pipeline completed all stages')
    const resp = await sendQuiet<ProjectPayload>('pipeline.complete', {
      workspace_path: pipeline.workspacePath
    })
    applyProjectPaths(resp ?? undefined)
    return
  }
  pipeline.stageIndex = nextIndex
  await activateStage(nextIndex)
}

async function onPipelineAbort(): Promise<void> {
  if (pipeline.state !== 'running') return
  pipeline.state = 'aborted'
  pipelineLog('Pipeline aborted by user')
  stopGlobalManagerRouter()
  cancelAllWatchers()
  stageCompletions.clear()
  for (const k of Array.from(stageRouters.keys())) disposeStageRouter(k)
  questionQueue.length = 0
  if (activeQuestion.value) activeQuestion.value = null
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  // Abort = PAUSE, not kill: stop the orchestration (watchers/routers/questions)
  // but leave the spawned agents and their panes alive so the run can be
  // resumed later via the Resume banner. (Reset is the destructive one.)
  const resp = await sendQuiet<ProjectPayload>('pipeline.abort', {
    workspace_path: pipeline.workspacePath,
    reason: 'user'
  })
  applyProjectPaths(resp ?? undefined)
  // Refresh existingProject so the Resume banner appears immediately in the
  // same session without requiring the user to switch workspaces and back.
  if (pipeline.workspacePath) await onWorkspaceCheck(pipeline.workspacePath)
}

async function onPipelineReset(paneIds?: readonly string[]): Promise<void> {
  cancelAllWatchers()
  stageCompletions.clear()
  for (const k of Array.from(stageRouters.keys())) disposeStageRouter(k)
  questionQueue.length = 0
  activeQuestion.value = null
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  // Reset is the destructive action: tear down ALL panes (pipeline + manual) so
  // the workspace returns to a clean slate. onKill handles each pane's
  // watcher/timer/session teardown and removes it from the view.
  await onKillAll(paneIds)
  pipeline.task = ''
  pipeline.stageIndex = -1
  pipeline.state = 'idle'
  pipeline.log = []
  pipeline.projectId = ''
  pipeline.projectFile = ''
  pipeline.pipelineLogFile = ''
  pipeline.backendLogFile = ''
  pipeline.runDir = ''
}

// ─────────── Switch / close workspace (phase-7) ───────────
// Returns to the Welcome picker. The Welcome screen doubles as the switcher
// (recent + browse). A running pipeline triggers a confirm first; on confirm we
// abort it (record kept on disk → resumable) and kill all panes. Idle /
// completed / aborted close immediately.
const confirmCloseWorkspace = ref<boolean>(false)

function onSwitchWorkspace(): void {
  if (confirmBeforeClose.value || pipeline.state === 'running') {
    dontConfirmCloseAgain.value = false
    confirmCloseWorkspace.value = true
    return
  }
  void doCloseWorkspace()
}

function onConfirmCloseWorkspace(): void {
  if (dontConfirmCloseAgain.value) confirmBeforeClose.value = false
  void doCloseWorkspace() // doCloseWorkspace sets confirmCloseWorkspace = false
}

async function doCloseWorkspace(): Promise<void> {
  confirmCloseWorkspace.value = false
  // Capture the panes BEFORE any state is cleared. panesInView is derived from
  // extraWorkspaces, which is every workspace this window holds EXCEPT the
  // current one — so the moment currentWorkspace goes blank below, every
  // workspace becomes "extra", panesInView empties, and the onKillAll at the
  // end of this function iterates nothing. The dialog says the workspace is
  // being closed while its agents keep running in the background.
  const paneIdsToKill = panesInView.value.map((p) => p.id)
  // Let go of it. Clearing currentWorkspace alone left the workspace in
  // workspaceOrder, so the window still claimed to hold it: main kept
  // reporting it open — the Recent list showed the badge on a project that had
  // just been closed — and the sidebar listed it as a workspace this window
  // holds, alongside the panes that had just been killed.
  const closing = currentWorkspace.value
  const remaining = workspaceOrder.value.filter((w) => normWs(w) !== normWs(closing))
  workspaceOrder.value = remaining
  persistExtraWorkspaces()
  _forgetRunGroups(closing)
  // Show Welcome screen immediately so the button feels responsive.
  // The async cleanup (abort / kill panes) runs after the gate is lifted.
  workspaceSelected.value = false
  currentWorkspace.value = ''
  existingProject.value = null
  currentMode.value = 'spawn'
  // Save path before clearing — the abort API needs it.
  // We don't call onPipelineAbort() here because its trailing onWorkspaceCheck()
  // would re-set currentWorkspace/existingProject that we just cleared.
  const wsPathForAbort = pipeline.workspacePath
  pipeline.workspacePath = ''
  runGroups.value = []
  currentRunGroupId.value = ''
  activeTab.value = ''
  try {
    sessionStorage.removeItem(WS_SELECTED_KEY)
    sessionStorage.removeItem(WS_PATH_KEY)
  } catch {
    /* ignore */
  }
  if (pipeline.state === 'running' && wsPathForAbort) {
    cancelAllWatchers()
    stopGlobalManagerRouter()
    await sendQuiet('pipeline.abort', { workspace_path: wsPathForAbort, reason: 'user' })
  }
  await onPipelineReset(paneIdsToKill)
  // Closing one of several is not "back to the picker": the others are still
  // held and their agents are still running, so a Welcome screen over them
  // says the window is empty when it is not. Land on one of them instead.
  const next = remaining[0]
  if (next) await switchToWorkspace(next)
}

// Titlebar 📁 button: open the current workspace folder in Finder.
async function titlebarRevealWorkspace(): Promise<void> {
  if (!currentWorkspace.value || !window.agentTeam?.openPath) return
  await window.agentTeam.openPath(currentWorkspace.value)
}

// Titlebar 📋 button: reveal the current workspace's plans. Plans now live in
// the main-window left sidebar as their own tab (embedded PlanPane), not a
// detached window — so this just switches ControlPane's sidebar tab to 'plans'
// (ControlPane owns sidebarTab). The legacy openPlansWindow IPC bridge stays in
// preload/main but is no longer wired here.
function openPlansWindow(): void {
  if (!currentWorkspace.value) return
  controlPaneRef.value?.selectSidebarTab('plans')
}

/** @param opts.keepPanes  Leave the panes of the workspace being left alone.
 *
 *  Browsing to a workspace has always meant LEAVING this one, so it resets the
 *  pipeline — and onPipelineReset tears down every pane to return the
 *  workspace to a clean slate. Switching between workspaces the window already
 *  holds is not that: the sidebar goes on listing the one being left and its
 *  agents go on running, so tearing them down would silently destroy the work
 *  the switch was supposed to leave running. */
async function onWorkspaceBrowse(path: string, opts?: { keepPanes?: boolean }): Promise<void> {
  if (path === currentWorkspace.value) return
  // Already open in another window → focus that window, keep this one as-is
  // (a duplicate open would run two sets of PTY/git operations on one folder).
  if (await window.agentTeam?.focusWorkspaceWindow?.(path)) return
  // The pipeline still stops either way: it is one per window, so entering
  // another workspace overwrites the state tracking this one's run.
  if (pipeline.state === 'running') await onPipelineAbort()
  pipeline.workspacePath = ''
  if (!opts?.keepPanes) await onPipelineReset()
  existingProject.value = null
  currentMode.value = 'spawn'
  pipeline.workspacePath = path
  currentWorkspace.value = path
  try {
    sessionStorage.setItem(WS_PATH_KEY, path)
    sessionStorage.setItem(WS_SELECTED_KEY, '1')
  } catch {
    /* ignore */
  }
}

// ──────────────── Continuous-mode watcher + question alerts ────────────────

// Question placeholder-stub filter (e.g. "<your question>"), shared by every
// question detector so all paths classify a stub identically.
const QUESTION_PLACEHOLDER_RE = /^<[^>]{1,40}>$/

// Vendors whose log reader delivers VALIDATED assistant turn text. For their
// panes the strict turn-text sentinel path (judgeTurnText) is authoritative,
// so the loose in-buffer sentinel scan is skipped — it can false-complete on a
// TUI redraw that re-echoes the kickoff's sentinel examples. Each vendor
// declares this itself; see `verifiedTurnText` in agents/types.ts for why the
// set is deliberately conservative.
const TURN_TEXT_VENDORS = new Set(
  agentSpecs.filter((s) => s.verifiedTurnText).map((s) => s.agentKey)
)

// A turn_complete whose CLI timestamp predates the watcher arming by more than
// this is a replayed historical event (backend restart re-parses whole logs and
// re-emits old turn_complete events), not a live completion — don't judge it.
// The window tolerates same-machine clock skew between the CLI and the app.
const TURN_TEXT_REPLAY_TOLERANCE_MS = 60_000

// Absolute ceiling on a single stage so a wedged agent can't block the
// pipeline forever. The agent's own sentinel (or the analyzer reading its
// output) ends a stage long before this — the cap is just a backstop, so it
// should sit well past how long real work runs. Fifteen minutes did not: a
// full test suite, a broad refactor or a deep review routinely runs longer,
// and the cap then fired on an agent that was working fine.
const STAGE_MAX_DURATION_MS = 60 * 60_000

// turn_complete must remain the LATEST signal this long before it counts as
// completion — lets the buffer's QUESTION text (which can lag the hook/JSONL
// event) render and be caught by question detection first. See turnCompleteDone.
const TURN_COMPLETE_SETTLE_MS = 1500

// Multi-slot analyzer-completion FALLBACK: the buffer must be quiet at least
// this long before we trust the analyzer's "completion" on a multi-slot stage.
// Single-slot has no handoff pollution so it doesn't need this; multi-slot does
// — a sibling churns right after a handoff injection, and a short post-handoff
// pause must NOT be mistaken for completion (the Stage 04 early-advance bug).
// This quiet window is the PTY buffer's lastActivityAt (frontend-local, NOT the
// attribution-routed agent_active), so it's immune to pane mis-attribution.
const MULTISLOT_ANALYZER_CONFIRM_MS = 20_000

interface StageWatcher {
  paneId: string
  stageIndex: number
  scanFrom: number
  pollHandle: number | null
  cancelled: boolean
  waitingForAnswer: boolean
  /** Wall-clock ms when the last answer was injected (0 = no pending answer).
   *  Used to detect "CLI stuck at ❯ after answer" — if lastActivityAt stops
   *  updating (spinner gone) N seconds after injection, Claude needs a nudge. */
  answeredAt: number
  armedAt: number
  analyzerBusy: boolean
  analyzerCooldownUntil: number
  lastAnalyzedBufferLen: number
  /** Buffer length recorded at the END of the previous poll tick.
   *  Used to detect "agent still generating" — if buf.length > lastPollBufLen
   *  the buffer is growing and question detection is deferred one tick. */
  lastPollBufLen: number
  /** Minimum safe scanFrom: set in startStageWatcher by scanning for any
   *  pre-existing sentinel in the buffer (e.g. old session history replayed
   *  via `claude resume`). Buffer-cap resets use this instead of 0 to avoid
   *  re-detecting the sentinel from a previous run. */
  minScanFrom: number
}

// Keyed by paneId so multiple parallel agents in the same stage each get
// their own watcher without clobbering each other.
const watchers = new Map<string, StageWatcher>()

// Tracks how many parallel agent slots each stage has and how many have
// already completed, so we only advance the pipeline when ALL are done.
const stageCompletions = new Map<number, { expected: number; done: Set<string> }>()

// When each pane's watcher armed (start of its current stage). Kept in its own
// Map — NOT on the watcher — so it survives cancelWatcher(), letting the stall
// path (whose watcher is already cancelled) still judge slotFinished correctly.
const paneArmedAt = new Map<string, number>()

// ── Background system notifications (CLI done / needs input) ─────────────────
// Native OS notification when a pane's turn completes or it needs the user's
// input — fired ONLY when the app is backgrounded (see useSystemNotify). This is
// purely additive: it reads the same agent.activity signals as the pipeline
// logic without altering paneTurnCompleteAt / paneLastActiveAt handling.
const sysNotify = useSystemNotify()

// Dock badge (macOS Terminal.app-style): reflect the count of panes with unseen
// done/attention activity. Clearing on view happens via the focusPaneId watcher
// below (once it's declared).
watch(sysNotify.pendingCount, (count) => { window.agentTeam?.setBadgeCount(count) })

// Per-pane timer that fires a 'done' notification once turn_complete has stayed
// the latest signal for TURN_COMPLETE_SETTLE_MS — mirroring turnCompleteDone so
// a turn that ended to ask a QUESTION isn't mis-notified as completion.
const paneDoneNotifyTimers = new Map<string, number>()

// Same order the UI titles a pane with — a notification naming the pane
// differently from its own tab reads as a different pane.
function paneNotifyLabel(pane: { customName?: string; slotLabel?: string; autoName?: string; agentLabel?: string }): string {
  return pane.customName || pane.autoName || pane.slotLabel || pane.agentLabel || ''
}

function clearDoneNotifyTimer(paneId: string): void {
  const h = paneDoneNotifyTimers.get(paneId)
  if (h != null) { window.clearTimeout(h); paneDoneNotifyTimers.delete(paneId) }
}

function scheduleDoneNotify(paneId: string, timestamp: string): void {
  clearDoneNotifyTimer(paneId)
  // Replay guard (all vendors): a turn_complete replayed when the backend
  // re-parses the whole log on restart carries its original, old CLI timestamp.
  // Reject it here so a historical turn — or any vendor's weak/stale signal —
  // can never bubble straight to a desktop notification.
  if (isReplayedTurnComplete(timestamp, Date.now(), TURN_TEXT_REPLAY_TOLERANCE_MS)) return
  const h = window.setTimeout(() => {
    paneDoneNotifyTimers.delete(paneId)
    // Arm-time + latest + settle, judged by the SAME vetted verdict the pipeline
    // uses (turnCompleteDone): the turn_complete must have landed after this
    // pane armed, be the latest signal (no agent_active after it), and have held
    // for settleMs. armedAt defaults to 0 for a plain interactive pane, so the
    // arm-time clause is a no-op there while still rejecting a pre-arm stale one.
    if (!turnCompleteDone({
      turnCompleteAt: paneTurnCompleteAt.get(paneId) ?? 0,
      lastActiveAt: paneLastActiveAt.get(paneId) ?? 0,
      armedAt: paneArmedAt.get(paneId) ?? watchers.get(paneId)?.armedAt ?? 0,
      now: Date.now(),
      settleMs: TURN_COMPLETE_SETTLE_MS
    })) return
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane) return
    playDoneSound()
    sysNotify.notifyPaneState(
      paneId,
      'done',
      i18n.global.t('notify.done-title'),
      i18n.global.t('notify.done-body', { label: paneNotifyLabel(pane) })
    )
  }, TURN_COMPLETE_SETTLE_MS)
  paneDoneNotifyTimers.set(paneId, h)
}

function notifyAttention(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  playAttentionSound()
  sysNotify.notifyPaneState(
    paneId,
    'attention',
    i18n.global.t('notify.attention-title'),
    i18n.global.t('notify.attention-body', { label: paneNotifyLabel(pane) })
  )
}

// Ghost-heal gate for the attribution handler below: probes whether a pane's
// pinned id has a real transcript (agent.session_exists). A missing pane is
// reported as "has transcript" so adoption is refused rather than racing a
// teardown. The probe is tri-state: null (probe failed — unknown) also
// refuses adoption inside the gate; only a DEFINITIVE ghost (false) adopts.
const sessionGhostHealGate = createGhostHealGate(async (paneId, pinnedSessionId) => {
  const p = panes.value.find((x) => x.id === paneId)
  if (!p) return true
  return canResumeSession(p.agentKey, p.workspacePath, pinnedSessionId)
})

// CLI lifecycle events (the reliable, non-buffer signal). agent_active = the CLI
// is working; turn_complete = its turn ended. We timestamp both per pane; the
// completion logic reads these instead of guessing from the TUI buffer.
backend.on('agent.activity', (raw) => {
  const ev = raw as { event_type?: string; pane_id?: string; vendor?: string; session_id?: string; detail?: string; text?: string; timestamp?: string; notification_type?: string; superseded?: boolean; pending_subagents?: number }
  if (!ev?.pane_id) return
  // QUESTION badge: "the agent asked you something and is waiting". Decided in
  // one place for both event types because both carry a half of it — the turn
  // text on turn_complete, and the AskUserQuestion box (which pauses the turn
  // mid-flight and so produces no turn_complete at all) on agent_active. The
  // rules live in questionActionFor so they can be executed by the suite;
  // App.vue is an SFC the tests cannot mount.
  // Background-subagent count, carried by every hook event that has one. Read
  // before the event-type branches because both kinds carry it: the count goes
  // UP on an agent_active (Task PreToolUse) and is read on the turn_complete
  // that follows.
  if (typeof ev.pending_subagents === 'number') {
    panePendingSubagents.set(ev.pane_id, {
      pending: ev.pending_subagents,
      observedAt: Date.now(),
    })
  }
  const questionAction = questionActionFor(ev)
  if (questionAction === 'raise') paneRefs[ev.pane_id]?.markQuestion?.()
  else if (questionAction === 'clear') paneRefs[ev.pane_id]?.clearQuestion?.()
  // Session-marker gate: sendSessionMarkerBootstrap typed Navide's own marker
  // into this pane as a standalone prompt, so the CLI answers it with an
  // ordinary assistant message that every marker-camp reader reports as a full
  // turn_complete. Drop that turn's user-visible effects — it is not work the
  // user asked for. Bookkeeping (badge, timestamps, queue pump) still runs:
  // the pane really did go idle. See sessionMarkerTurn.ts for why this needs
  // no time window and cannot swallow a genuine first turn.
  let markerReply = false
  const markerPane = panes.value.find((p) => p.id === ev.pane_id)
  if (markerPane?.markerReplyPending) {
    const action = markerTurnActionFor(ev)
    if (action) markerPane.markerReplyPending = undefined
    markerReply = action === 'suppress'
  }
  if (ev.event_type === 'turn_complete') {
    // `superseded`: the CLI's log describes a turn its Stop hook blocked, so
    // the agent took a queued message instead of stopping and is working on it
    // now (see the backend's hook_drain). The turn's text below is real and
    // still wanted — only "the pane is free" is not, so only the two things
    // that say so are skipped: the idle timestamp the delivery queue and the
    // unattended loop both read, and the finished notification.
    if (!ev.superseded) paneTurnCompleteAt.set(ev.pane_id, Date.now())
    // Badge: authoritative turn end → drop the RUNNING hysteresis latch now.
    paneRefs[ev.pane_id]?.markTurnComplete?.()
    if (!markerReply && !ev.superseded) scheduleDoneNotify(ev.pane_id, ev.timestamp ?? '')
    // Judge THIS turn's own text (not a retained map): an empty-text
    // turn_complete (Claude Stop hook, thinking-only record, Codex cross-batch)
    // must never be judged against a previous turn's text.
    judgeTurnText(ev.pane_id, ev.text ?? '', ev.timestamp ?? '')
    // Unattended loop: the CLI printed LOOP_DONE_MARKER as this turn's final
    // line → the whole task is done. Stop the loop so the poll never resends
    // the resume prompt again (runs before the poll's turn-complete continue).
    if (ev.text && turnEndsWithSentinel(ev.text, LOOP_DONE_MARKER)) {
      stopLoopOnDoneMarker(ev.pane_id, ev.timestamp ?? '')
    }
    // Unattended loop: judge whether this turn actually moved the task forward.
    // A CLI parked on something the loop can't observe (a background agent)
    // ends its turn for real every time, so only the TEXT reveals the spin.
    // LOOP_WAIT: the CLI says this turn only waited. Hold the next continue and
    // skip the stall judgement — an honest "still waiting" is not a spin, and
    // the wait has its own budget (see noteLoopWait). A turn that is NOT a
    // honoured wait falls through to the ordinary judgement unchanged.
    if (!noteLoopWait(ev.pane_id, ev.text ?? '', ev.timestamp ?? '')) {
      noteLoopTurnProgress(ev.pane_id, ev.text ?? '', ev.timestamp ?? '')
    }
    // Inter-CLI messaging: scan this turn's text for MSG blocks, then pump.
    // A marker reply is scanned as empty text — nothing in it was addressed to
    // anyone — but the pump still runs, since the pane is now idle.
    onTurnCompleteForMessaging(ev.pane_id, markerReply ? '' : (ev.text ?? ''), ev.timestamp ?? '')
    // Auto-name fallback: for vendors whose readers can't surface the user's
    // prompt text, name a still-unnamed pane from its first completed turn's
    // text. Set-once via setPaneAutoName; deliberately independent of
    // judgeTurnText and the sentinel paths — it only reads ev.text.
    // Envelope guard mirrors the agent_active path: a reader that echoes the
    // injected inter-CLI message back as turn text must not title the pane.
    if (ev.text && !markerReply && !isInjectedMessageText(ev.text)) {
      const pane = panes.value.find((p) => p.id === ev.pane_id)
      if (pane && !pane.customName && !pane.nameLocked && !pane.autoName) {
        setPaneAutoName(ev.pane_id, deriveAutoName(ev.text))
        requestLlmPaneName(ev.pane_id, ev.text)
      }
    }
  } else if (ev.event_type === 'agent_active') {
    paneLastActiveAt.set(ev.pane_id, Date.now())
    // The loop reads a stricter clock; see activityMeansWorking for why.
    if (activityMeansWorking(ev.detail ?? '')) paneLastWorkingAt.set(ev.pane_id, Date.now())
    // The pane is working again, so it is no longer parked where a restore left
    // it — retire the continue affordance even if the user never clicked it.
    const activePane = panes.value.find((p) => p.id === ev.pane_id)
    if (activePane?.resumeContinueAvailable) activePane.resumeContinueAvailable = false
    // Tool use is the sharpest "this turn did work" signal there is, and its
    // absence is what a CLI parked on a background agent looks like: it talks,
    // it never touches a tool. Counted per armed turn by the loop watcher.
    if (detailMeansToolUse(ev.detail ?? '')) {
      const toolWatcher = loopLimitWatchers.get(ev.pane_id)
      if (toolWatcher) {
        toolWatcher.toolUsesThisTurn += 1
        toolWatcher.toolSignalsSeen = true
      }
    }
    // Auto-name from the user's own prompt (readers attach it as text on
    // user-record events; detail is 'user' for most vendors, 'prompt' for
    // kimi/aider, 'user_message' for codex). Arrives before the assistant's
    // turn_complete, so the user's command wins over the reply-text fallback.
    // Injected inter-CLI envelopes land in the CLI log as user records too —
    // never title a pane with one. Set-once lives inside setPaneAutoName.
    if (
      (ev.detail === 'user' || ev.detail === 'prompt' || ev.detail === 'user_message') &&
      ev.text &&
      !isInjectedMessageText(ev.text)
    ) {
      setPaneAutoName(ev.pane_id, deriveAutoName(ev.text))
      requestLlmPaneName(ev.pane_id, ev.text)
    }
    // A new turn re-arms 'done' notifications for this pane.
    sysNotify.markActive(ev.pane_id)
    // Claude's Notification hook (user attention requested) arrives as
    // agent_active with detail 'hook:notification'. It is also the only signal
    // that separates "parked on the user" from "done": the prompt paints once
    // and then goes quiet, so the pane's own PTY stream settles to idle
    // exactly like a finished turn would. Only SOME notification types mean
    // the user has to act, though — idle_prompt fires after every turn, and
    // raising AWAITING there would both misreport a free pane and stop it
    // receiving dispatched work.
    if (ev.detail === 'hook:notification') {
      const awaiting = notificationMeansAwaiting(ev.notification_type)
      // Sound the attention chime only when the user actually has to act.
      // Notification also fires for "turn ended, waiting for your next
      // instruction", which every turn produces — chiming there would ring
      // once per turn on top of the existing done notification. Builds that
      // send no type at all keep the old always-notify behaviour rather than
      // silently losing a signal the user may already rely on.
      if (awaiting || !ev.notification_type) notifyAttention(ev.pane_id)
      if (awaiting) {
        paneRefs[ev.pane_id]?.markNeedsInput?.()
      } else if (notificationEndsAwaiting(ev.notification_type)) {
        // A hook fires once, so waits that end without the CLI producing any
        // output need this explicit release or the pane stays AWAITING — and
        // stays excluded from messaging and dispatch — indefinitely.
        paneRefs[ev.pane_id]?.clearNeedsInput?.()
      }
    }
    // Clear the restore-mode badge once the user interacts with the pane.
    const histEntry = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
    if (histEntry?.restoreMode) histEntry.restoreMode = undefined
  }
  if (pinsSessionAtLaunch(ev.vendor) && ev.session_id) {
    const pane = panes.value.find((p) => p.id === ev.pane_id)
    if (pane) {
      // A claude turn event means the CLI is writing its transcript — the
      // pane's session is now resumable, so unlock the Rebuild buttons.
      pane.sessionOnDisk = true
      const attributedId = ev.session_id
      const adopt = (): void => {
        pane.pinnedSessionId = attributedId
        syncViews()
        void persistPaneSession(pane, attributedId)
        const h = spawnHistory.value.find((e) => e.paneId === pane.id)
        if (h) h.sessionId = attributedId
      }
      // A restore-pinned id (pinnedFromRestore) is NOT the pane's launch
      // identity — it points at the SAVED conversation, kept only so the
      // Rebuild button stays enabled until the pane's real session shows up.
      // Its transcript exists by construction, so the ghost-heal gate below
      // would refuse adoption forever; adopt the attributed id directly and
      // clear the flag (the pin now matches reality either way).
      if (pane.pinnedFromRestore) {
        pane.pinnedFromRestore = undefined
        if (pane.pinnedSessionId !== attributedId) adopt()
      }
      // Attribution can mis-route an unowned session to a sibling pane in the
      // same cwd — never let that overwrite a HEALTHY pinned id. But a pinned
      // id with NO transcript (ghost — e.g. /clear re-rolled the CLI's real
      // id) must stay replaceable, or the pane can never learn its real id:
      // verify the pinned id first and adopt only when it is a ghost. The
      // gate serializes concurrent events; first confirmed adoption wins.
      else if (classifyAttributedSession(pane.pinnedSessionId, attributedId) === 'adopt') {
        adopt()
      } else {
        const pinnedId = pane.pinnedSessionId!
        void sessionGhostHealGate.shouldAdopt(pane.id, pinnedId).then((won) => {
          // Re-check after the async probe: the pane must STILL be mounted
          // (not killed/removed while the probe was in flight — adopting a
          // torn-down pane would persist a session for a dead pane_id) and
          // must still pin the exact id we just verified as a ghost.
          if (confirmGhostAdoption({
            gateWon: won,
            paneStillMounted: panes.value.some((p) => p.id === pane.id),
            currentPinnedId: pane.pinnedSessionId,
            verifiedPinnedId: pinnedId,
            attributedId,
          })) {
            pipelineLog(
              `[pane ${pane.id.slice(0, 8)}] pinned session ${pinnedId.slice(0, 8)} has no ` +
              `transcript — adopting attributed session ${attributedId.slice(0, 8)}`
            )
            adopt()
          }
        })
      }
    }
  }
})

// Turn-text sentinel detection: judged on the completed turn's OWN assistant
// text from the CLI conversation log (never the terminal buffer, never echoed
// input). The sentinel counts only as the turn's final non-empty line, so
// mentions inside the text never trigger. Questions are NOT surfaced here — the
// buffer question pre-check owns that (it advances scanFrom and dedups); we only
// DEFER completion when the turn also asked a real question, preserving
// "question wins over sentinel" without a second enqueue path.
function judgeTurnText(paneId: string, text: string, timestamp: string): void {
  const watcher = watchers.get(paneId)
  if (!watcher || watcher.cancelled) return
  // Empty text: a Stop-hook / thinking-only / cross-batch turn_complete carries
  // none. Judging would fall back to stale content, so never proceed.
  if (!text) return
  const stage = stagesApi.stages.value[watcher.stageIndex]
  if (!stage || !stage.sentinel) return
  // Freshness: a replayed historical turn_complete (backend restart re-parses
  // the whole log) carries its original, older CLI timestamp. Reject it so a
  // prior turn's sentinel can't complete a freshly armed stage at kickoff.
  const armedAt = paneArmedAt.get(paneId) ?? watcher.armedAt
  const eventMs = timestamp ? Date.parse(timestamp) : NaN
  if (!Number.isNaN(eventMs) && eventMs < armedAt - TURN_TEXT_REPLAY_TOLERANCE_MS) return
  // Question wins: if this turn also asked a real question, defer to the buffer
  // question path instead of completing the stage.
  if (stage.allowQuestions) {
    const blocks = findConsecutiveQuestionBlocks(text, 0)
    if (blocks.some((b) => !QUESTION_PLACEHOLDER_RE.test(b.prompt.trim()))) return
  }
  if (turnEndsWithSentinel(text, stage.sentinel)) {
    cancelWatcher(paneId)
    pipelineLog(`Stage ${stage.id} ✓ sentinel detected (turn text)`)
    onStageSlotCompleted(watcher.stageIndex, paneId, 'sentinel')
  }
}

// Codex/Antigravity sessions are persisted after the backend observes their
// session files: Codex announces the resume id from its per-pane CODEX_HOME
// path, while Antigravity relies on marker matching (it has no identity path
// at launch). Marker matching remains a fallback for older sessions.
backend.on('backfill.changed', (raw) => {
  const ev = raw as { workspace_path?: string; active?: boolean; count?: number }
  // Only reflect this window's own workspace (the broadcast fans out to all).
  if ((ev?.workspace_path || '') !== (currentWorkspace.value || '')) return
  backfill.active = !!ev?.active
  backfill.count = ev?.count ?? 0
})

// STOP badge broadcast from the backend (another window issued/cleared a stop,
// or this window's own persist echoed back). Reflect stored truth into the
// pane's composable ONLY — never persist here (would loop: broadcast → set →
// persist → broadcast).
backend.on('pane.stopped', (raw) => {
  const ev = raw as { pane_id?: string; stopped?: boolean }
  if (!ev?.pane_id) return
  paneRefs[ev.pane_id]?.setStopped(!!ev.stopped)
})

// Cross-workspace message routed by the backend registry. Every window receives
// the broadcast; only the one owning the target pane accepts it, and delivery
// then runs through the ordinary queue (idle gate, FIFO, injection verified).
backend.on('agent_msg.deliver', (raw) => {
  const ev = raw as {
    msg_key?: string
    target_pane_id?: string
    target_name?: string
    target_workspace_path?: string
    target_agent_key?: string
    from_pane_id?: string
    from_display?: string
    from_workspace_path?: string
    from_agent_key?: string
    content?: string
    cross_workspace?: boolean
    rate_limit?: boolean
    reply_to?: string
  }
  if (!ev?.msg_key || !ev.target_pane_id || !ev.content) return
  // The broadcast reaches the sending window too. When the sender is one of our
  // panes, log the outbound side here — a message sent through the MCP cli_send
  // tool never passed through sendMessage(), so nothing else would record it.
  if (ev.from_pane_id) {
    messaging.noteOutboundMessage({
      msgKey: ev.msg_key,
      fromPaneId: ev.from_pane_id,
      targetPaneId: ev.target_pane_id,
      toDisplay: ev.target_name || '',
      toAgent: ev.target_agent_key,
      content: ev.content,
      crossWorkspace: !!ev.cross_workspace,
      remoteWorkspace: ev.target_workspace_path,
    })
  }
  const accepted = messaging.acceptRemoteMessage({
    msgKey: ev.msg_key,
    targetPaneId: ev.target_pane_id,
    fromDisplay: ev.from_display || 'unknown',
    fromAgent: ev.from_agent_key,
    content: ev.content,
    remoteWorkspace: ev.from_workspace_path,
    // Senders that bypassed sendMessage (the MCP tools) carry no rate-limit
    // accounting of their own.
    rateLimit: !!ev.rate_limit,
    // Set when this message answers one this window sent; an id we never handed
    // out (or an older backend that drops the field) leaves the row unlinked.
    replyTo: ev.reply_to,
  })
  if (!accepted || !ev.cross_workspace) return
  // The instruction came from another project — say so, since nothing else in
  // this window would show where it originated.
  const target = panes.value.find((p) => p.id === ev.target_pane_id)
  notifyRestore.toast(
    i18n.global.t('msg.cross-workspace-toast', {
      from: ev.from_display || 'unknown',
      target: target?.messagingName ?? '',
    }),
  )
})

// cli_open_agent wants a pane opened. Every window sees this; only the one
// owning the requesting pane answers (handleMcpSpawnRequest bails otherwise).
backend.on('agent_spawn.request', (raw) => {
  const ev = raw as {
    request_id?: string
    requester_pane_id?: string
    agent_key?: string
    name?: string
    task?: string
    target_workspace?: string
  }
  // An external caller (no requesting pane) addresses this by target_workspace
  // instead — accept the event as long as one of the two identifies an owner.
  if (!ev?.request_id || (!ev.requester_pane_id && !ev.target_workspace)) return
  void handleMcpSpawnRequest({
    request_id: ev.request_id,
    requester_pane_id: ev.requester_pane_id ?? '',
    agent_key: ev.agent_key ?? '',
    name: ev.name ?? '',
    task: ev.task ?? '',
    target_workspace: ev.target_workspace,
  })
})

// A claude pane's Stop hook is holding its agent open while the backend asks
// whether anything is queued for it. Answering with an envelope hands that text
// to the agent as its next instruction — no injection, so no input box, no
// typing hold, and no idle gate. Answering with '' lets the turn end normally.
// Sent to this window alone (the backend knows who owns the pane), and the hook
// gives up quickly, so reply on the spot rather than awaiting anything.
backend.on('agent_msg.hook_drain', (raw) => {
  const ev = raw as { request_id?: string; pane_id?: string }
  if (!ev?.request_id) return
  const paneId = ev.pane_id ?? ''
  const envelope = (paneId && panes.value.some((p) => p.id === paneId))
    ? messaging.drainForHook(paneId)
    : null
  // The message is only reserved until the backend confirms the hook was still
  // waiting for it. `delivered: false` means it gave up first and Claude has
  // already stopped, so the reservation is released and the message goes back
  // to waiting for the ordinary typed delivery — the alternative is a row
  // marked delivered that no agent ever saw.
  backend
    .send<{ delivered?: boolean }>(
      'agent_msg.hook_drain_result',
      { request_id: ev.request_id, envelope: envelope ?? '' },
      // Answered as soon as the socket carries it; a bound here only stops a
      // dropped reply from holding the reservation for the default timeout.
      5000,
    )
    .then((resp) => {
      if (envelope) messaging.settleHookDrain(paneId, !!resp.ok && !!resp.payload?.delivered)
    })
    .catch(() => { if (envelope) messaging.settleHookDrain(paneId, false) })
})

// A pane's CLI gained or lost the way in that does not go through its PTY.
// Broadcast to every window; only the one that owns the pane has anything to
// record, and a pane that closes drops its entry with the rest of its state.
backend.on('agent_msg.push_state', (raw) => {
  const ev = raw as { pane_id?: string; kind?: string; ready?: boolean }
  if (!ev?.pane_id) return
  if (ev.ready && ev.kind) {
    pushReadyPanes.set(ev.pane_id, ev.kind)
    pushCooldownUntil.delete(ev.pane_id)
  } else {
    pushReadyPanes.delete(ev.pane_id)
  }
})

// A sending window withdrew a message before it went in. Every window sees the
// request; only the one holding that message in a queue has anything to drop,
// and it reports the cancellation back over the ordinary delivery-report path.
backend.on('agent_msg.cancel', (raw) => {
  const ev = raw as { msg_key?: string }
  if (!ev?.msg_key) return
  messaging.cancelRemoteInbound(ev.msg_key)
})

backend.on('agent_msg.delivery_result', (raw) => {
  const ev = raw as { msg_key?: string; ok?: boolean; reason?: string }
  if (!ev?.msg_key) return
  messaging.resolveRemoteDelivery(ev.msg_key, !!ev.ok, ev.reason || '')
})

// This backend started at a different version than the one before it, so any
// MCP client still connected from then is holding that backend's tool list.
backend.on('app.version_changed', (raw) => {
  const ev = raw as { from?: string; to?: string }
  if (!ev?.from || !ev.to) return
  announcements.noteBackendUpgrade(ev.from, ev.to)
})

backend.on('session.detected', (raw) => {
  const ev = raw as { pane_id?: string; session_id?: string }
  if (!ev?.pane_id || !ev.session_id) return
  const pane = panes.value.find((p) => p.id === ev.pane_id)
  if (!pane) return
  const sessionId = normalizeResumeSessionId(pane.agentKey, ev.session_id)
  if (!sessionId) return
  // The CLI rotated its session id (e.g. claude --resume records a NEW id).
  // The reattach key follows pinnedSessionId — carry the live PTY id to the
  // new key so the next restore reattaches instead of spawning a second CLI
  // beside the still-running one. Falling back to the pane id covers the
  // FIRST binding: a pane that has not detected a session yet is keyed by
  // pane.id, so passing '' here would no-op and strand both the PTY entry
  // and the scrollback snapshot under a key nothing reads again.
  migrateTerminalPtyKey(pane.pinnedSessionId || pane.id, sessionId)
  pane.pinnedSessionId = sessionId
  pane.sessionOnDisk = true
  // The detected id IS the pane's real session — a restore-pinned placeholder
  // (pinnedFromRestore) was just overwritten, so drop the stale flag.
  pane.pinnedFromRestore = undefined
  syncViews()
  const histSd = spawnHistory.value.find((e) => e.paneId === ev.pane_id)
  if (histSd) histSd.sessionId = sessionId
  if (pane.origin !== 'pipeline') {
    pipelineLog(`Manual ${pane.agentKey} 🔖 session 已綁定`)
    void persistPaneSession(pane, sessionId)
    return
  }
  if (!pane.slotLabel || pane.origin !== 'pipeline') return
  const stageIndex = stagesApi.stages.value.findIndex((s) => s.id === pane.stageId)
  if (stageIndex < 0) return
  pipelineLog(`Stage ${pane.stageId}/${pane.slotLabel} 🔖 session 已綁定 (${pane.agentKey})`)
  void persistPaneSession(pane, sessionId)
})

// A dead PTY can never produce a session id — drop the marker so the pane's
// "detecting session ID" spinner stops instead of spinning forever (the exit
// event otherwise dead-ends inside useTerminal and never reaches pane state).
// exit=127 means the shell could not find the agent command: the CLI is not
// installed, so offer guided install via the onboarding dep registry (dep ids
// match agentKeys).
backend.on('terminal.exit', (raw) => {
  const ev = raw as { pane_id?: string; exit_code?: number | null }
  if (!ev?.pane_id) return
  const pane = panes.value.find((p) => p.id === ev.pane_id)
  if (!pane) return
  // A dead PTY can't loop: stop the limit watcher and drop the loop badge state.
  if (pane.loopActive || pane.loopWaitUntil != null || pane.loopEstimateResetAt != null) {
    stopLoopLimitWatcher(ev.pane_id)
    pane.loopActive = false
    pane.loopWaitUntil = null
    pane.loopEstimateResetAt = null
    pane.loopSkillId = null
    pane.loopTurnCount = 0
    pane.loopMaxTurns = 0
  }
  if (pane.sessionMarker && !pane.pinnedSessionId) {
    pane.sessionMarker = undefined
    if (pane.preparationStatus !== 'ready') setPrepStatus(pane, 'failed')
    syncViews()
  }
  if (ev.exit_code === 127 && pane.agentKey !== 'terminal') {
    promptCliInstall(pane.agentKey, pane.agentLabel, pane.id)
  }
})

// The backend's pre-spawn probe found no executable at all. This fires BEFORE
// a PTY exists, so it catches every way a pane gets opened (Open Agent, Resume,
// Handle Issue, a pipeline stage) — not just the ones that reach exit 127.
backend.on('cli.missing', (raw) => {
  const ev = raw as { agent_key?: string; label?: string; pane_id?: string }
  if (!ev?.agent_key || ev.agent_key === 'terminal') return
  const pane = ev.pane_id ? panes.value.find((p) => p.id === ev.pane_id) : undefined
  // Pass the event's pane id, not the matched pane's: embedded CLI docks (e.g.
  // the Pipeline Manager) share this window's session but own no pane entry, and
  // dropping their id would bypass the "don't ask again" opt-out.
  promptCliInstall(ev.agent_key, pane?.agentLabel || ev.label || ev.agent_key, ev.pane_id)
})

// CLI account login: the backend harvested a profile's isolated login home
// the moment the browser sign-in completed. Close the disposable login pane
// and confirm with the signed-in identity. Only the window that spawned the
// pane holds a pendingLoginPanes entry, so exactly one window reacts.
backend.on('cli_profiles.changed', (raw) => {
  const ev = raw as {
    reason?: string
    agent_key?: string
    forced?: boolean
    harvestedProfileIds?: string[]
    identities?: Record<string, Record<string, { email?: string | null }>>
  }
  // Forced account switch: credentials were swapped under live panes. Every
  // main window receives this broadcast and restarts its own panes for the
  // agent — including the initiating window, whose switch handler no longer
  // restarts directly (so nothing runs twice). A quiet (non-forced) switch
  // never touches panes.
  const restartKey = forcedRestartAgentKey(ev)
  if (restartKey) {
    void restartAgentPanes(restartKey)
    return
  }
  if (ev?.reason !== 'login-harvest') return
  for (const profileId of ev.harvestedProfileIds ?? []) {
    const pending = pendingLoginPanes.get(profileId)
    if (!pending) continue
    pendingLoginPanes.delete(profileId)
    if (panes.value.some((p) => p.id === pending.paneId)) void onKill(pending.paneId)
    const email = ev.identities?.[pending.agentKey]?.[profileId]?.email || ''
    notifyRestore.toast(
      email
        ? i18n.global.t('settings.accounts.cli.login-complete', { email })
        : i18n.global.t('settings.accounts.cli.login-complete-no-email'),
      { type: 'success' }
    )
  }
})

// Guided install request currently on screen (null = none). One dialog at a
// time: several panes of the same CLI exiting 127 together (e.g. a pipeline
// stage) must not stack identical prompts.
const cliInstallRequest = ref<{
  depId: string
  label: string
  origin: 'pane' | 'spawn'
  paneId?: string
} | null>(null)
/** Dep ids the user switched the prompt off for, mirrored from the backend. */
const cliInstallPromptDismissed = ref<Set<string>>(new Set())

// These three dialogs count as modals for the keybinding context too (⌘W/Esc
// close them; pane shortcuts stay off behind them). Declared down here because
// the watch's SOURCES must already exist — the callback itself shares
// mainModalOpen with the sibling watches above.
watch([reconnectPickerOpen, cliInstallRequest, whatsNewEntry], () => setContext('modalOpen', mainModalOpen()))

function promptCliInstall(agentKey: string, agentLabel: string, paneId?: string): void {
  if (cliInstallRequest.value) return
  // The opt-out only silences the AUTOMATIC prompt (a pane dying with 127).
  // Picking the CLI in the spawn dropdown is the user asking for it, so that
  // path always opens — declining once is not the same as opting out.
  if (paneId && cliInstallPromptDismissed.value.has(agentKey)) return
  cliInstallRequest.value = {
    depId: agentKey,
    label: agentLabel,
    origin: paneId ? 'pane' : 'spawn',
    paneId,
  }
}

function closeCliInstall(): void {
  cliInstallRequest.value = null
}

/** Mirror the dialog's opt-out locally; a full status re-probe (18 deps) would
 *  be a heavy way to learn one boolean. */
function onCliInstallDismissChanged(payload: { depId: string; dismissed: boolean }): void {
  const next = new Set(cliInstallPromptDismissed.value)
  if (payload.dismissed) next.add(payload.depId)
  else next.delete(payload.depId)
  cliInstallPromptDismissed.value = next
}

/** Re-run the CLI in the pane that died with 127, now that it is installed. */
function relaunchAfterInstall(depId: string): void {
  const paneId = cliInstallRequest.value?.paneId
  const pane = paneId ? panes.value.find((p) => p.id === paneId) : undefined
  if (!pane || pane.agentKey !== depId) return
  void rebuildPaneViaResume(pane.id, { suppressBusyToast: true, forceWhenRunning: true })
}

// ── Exception tracking → supervision log ────────────────────────────────────
// Surface uncaught frontend errors into the pipeline log so a silent exception
// during stage supervision is visible HERE (rendered red), not just buried in
// devtools. The `❌` prefix is what ControlPane's classifier matches to colour
// the line. These are window-level nets; targeted try/catch still logs its own.
window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''
  pipelineLog(`❌ exception: ${e.message}${where}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason)
  pipelineLog(`❌ unhandled rejection: ${reason}`)
})

// How a slot was judged finished — recorded for history.jsonl auditing so a
// stage_advance can be traced to N/N reliable signals (vs a forced advance).
type SlotFinishReason = 'sentinel' | 'turn_complete' | 'analyzer' | 'cap-auto' | 'force'

// Build a SlotSignal per pipeline slot of a stage, for allSlotsFinished(). A
// slot already counted as done is finished by definition; otherwise we read its
// live signals (sentinel in buffer, turn_complete after armed). Used by the
// stall path to refuse a blind advance.
function computeStageSlotSignals(stageIndex: number): SlotSignal[] {
  const stage = stagesApi.stages.value[stageIndex]
  const tracker = stageCompletions.get(stageIndex)
  if (!stage || !tracker) return []
  const stagePanes = panes.value.filter(
    (p) => p.stageId === stage.id && p.origin === 'pipeline'
  )
  // Fewer live panes than slots → some slot never spawned; never "all finished".
  if (stagePanes.length < tracker.expected) return []
  return stagePanes.map((p) => {
    // A slot already counted as done is finished by definition. A slot that
    // printed its sentinel was added to `done` by the watcher, so we do NOT
    // re-scan the buffer here — scanning from 0 risks matching a sentinel
    // echoed inside the kickoff. `done` IS the reliable sentinel record.
    if (tracker.done.has(p.id)) {
      return { sentinelSeen: true, turnCompleteAt: 0, armedAt: 0 }
    }
    // Not yet done → rely on the turn_complete lifecycle signal only.
    return {
      sentinelSeen: false,
      turnCompleteAt: paneTurnCompleteAt.get(p.id) ?? 0,
      // No recorded arm time → treat turn_complete as unusable (stay cautious).
      armedAt: paneArmedAt.get(p.id) ?? Number.MAX_SAFE_INTEGER
    }
  })
}

// ── Manager-mode router (event-driven, per-stage) ───────────────────────────
// Set when stage.slots contains an entry with isCommander=true. The router
// scans pane buffers for sentinel blocks (ASK/REPORT/DISPATCH/MANAGER-READY/
// STAGE-DONE) and routes messages between Manager and Worker panes.
interface PendingMessage {
  fromLabel: string   // worker slot label
  kind: 'ASK' | 'REPORT'
  content: string
}
interface StageRouter {
  managerPaneId: string                  // empty until manager pane spawned
  /** Worker slot label → pane id (for routing DISPATCH targets). */
  workerPaneIds: Map<string, string>
  /** True once Manager printed ---MANAGER-READY---. Before that, all ASK /
   *  REPORT messages from workers are buffered here. */
  managerReady: boolean
  /** Queue of worker messages awaiting Manager-ready. */
  preReadyQueue: PendingMessage[]
  /** Per-pane scan cursor (Manager pane and each worker pane). */
  cursors: Map<string, number>
  /** True once STAGE-DONE has fired so we don't double-fire. */
  finished: boolean
  /** setInterval handle for the router scan loop. */
  pollHandle: number | null
}
const stageRouters = new Map<number, StageRouter>()

const ROUTER_POLL_MS = 4_000
const _managerScanRunning = new Set<number>()

function ensureStageRouter(stageIndex: number): StageRouter {
  let r = stageRouters.get(stageIndex)
  if (!r) {
    r = {
      managerPaneId: '',
      workerPaneIds: new Map(),
      managerReady: false,
      preReadyQueue: [],
      cursors: new Map(),
      finished: false,
      pollHandle: null,
    }
    stageRouters.set(stageIndex, r)
  }
  return r
}

function startRouterPoll(stageIndex: number): void {
  const router = stageRouters.get(stageIndex)
  if (!router || router.pollHandle !== null) return
  router.pollHandle = window.setInterval(() => {
    void managerRouterScan(stageIndex)
  }, ROUTER_POLL_MS)
}

function disposeStageRouter(stageIndex: number): void {
  const r = stageRouters.get(stageIndex)
  if (r?.pollHandle !== null && r?.pollHandle !== undefined) {
    window.clearInterval(r.pollHandle)
  }
  stageRouters.delete(stageIndex)
}

interface ActiveQuestionItem {
  prompt: string
  type: 'text' | 'choice'
  options: string[]
}
interface ActiveQuestion {
  paneId: string
  stageIndex: number
  questions: ActiveQuestionItem[]
  agentLabel: string
  stageTitle: string
  /** Slot label, e.g. "Architecture" or "UI/UX" for parallel-stage panes. */
  slotLabel: string
}
const activeQuestion = ref<ActiveQuestion | null>(null)
// A buffer-detected question (Codex/Antigravity, or any stage pane with allowQuestions)
// surfaces here — fire an 'attention' notification so a backgrounded user is
// pulled back. Claude's questions arrive earlier via the hook:notification path;
// markActive (new turn) re-arms the pane so this isn't suppressed as a dup.
watch(() => activeQuestion.value?.paneId, (paneId) => {
  if (paneId) notifyAttention(paneId)
})
// FIFO queue: when a second (parallel) agent asks a question while the user
// is still answering the first, we buffer it here and show it next.
const questionQueue: ActiveQuestion[] = []
// Reactive count so the template can show "N more waiting"
const questionQueueLen = ref(0)

// ── Stage-stall confirmation state (strict mode) ────────────────────────────
interface StageStallPrompt {
  paneId: string
  stageIndex: number
  stageId: string
  stageTitle: string
  slotLabel: string
  reason: 'idle' | 'cap'
  detail: string                 // e.g. "no output for 92s"
  autoAdvanceAt: number | null   // wall-clock ms when Full auto will fire (null = manual only)
}
const stageStallPrompt = ref<StageStallPrompt | null>(null)
let stageStallAutoTimer: number | null = null

// ── Auto-answer state ───────────────────────────────────────────────────────
/** true while waiting for LLM to return an auto-answer */
const autoAnswerPending = ref(false)
/** The LLM-generated answer text (shown in the QuestionAlert before auto-submit) */
const autoAnswerText = ref('')

/**
 * Called whenever autoAnswerEnabled is on and a question is shown.
 * Sends the questions to the backend LLM, shows the result in the alert for
 * 1.5 s, then auto-submits identical to the user pressing "Send answer".
 */
async function triggerAutoAnswer(q: ActiveQuestion): Promise<void> {
  const stage = stagesApi.stages.value[q.stageIndex]
  autoAnswerPending.value = true
  autoAnswerText.value = ''
  pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answering ${q.questions.length} question(s)…`)
  // Track whether we handed off to a re-trigger so the finally block doesn't
  // clear autoAnswerPending that was just set by the new call.
  let reTriggered = false
  try {
    // Local LLM inference takes 30-60 s on typical hardware. The default
    // backend.send timeout is 10 s — far too short, causing every auto-answer
    // call to time-out, drop back to manual mode, and leave the user waiting.
    // Use 120 s (matching the llama-cli hard timeout in analyzer.py).
    const AUTO_ANSWER_TIMEOUT_MS = 120_000
    let resp: Awaited<ReturnType<typeof backend.send<{ ok: boolean; answer: string; answers: string[] }>>>
    try {
      resp = await backend.send<{ ok: boolean; answer: string; answers: string[] }>(
        'pipeline.auto_answer',
        {
          questions: q.questions,
          task: pipeline.task,
          stage_title: stage?.title ?? '',
          model: analyzerModel.value || undefined,
          workspace_path: pipeline.workspacePath || undefined,
          stage_id: stage?.id ?? undefined,
          pane_id: q.paneId
        },
        AUTO_ANSWER_TIMEOUT_MS
      )
    } catch (sendErr) {
      // WebSocket send timeout or network error — log and fall through to manual.
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer error: ${(sendErr as Error).message ?? sendErr} — 請手動回答`)
      return
    }
    if (!resp.ok || !resp.payload?.ok || !resp.payload.answer) {
      // Log the raw error so users can diagnose "思考後沒有答案" cases.
      // Common causes: LLM format unrecognized, empty output, model unavailable.
      const detail = resp.error?.message ?? (resp.payload ? `payload.ok=${resp.payload.ok} answer="${resp.payload.answer}"` : 'null payload')
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer failed (${detail}) — 請手動回答`)
      return
    }
    autoAnswerText.value = resp.payload.answer
    pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer ready: ${resp.payload.answer.slice(0, 80)}`)
    // Display for 1.5 s so user can see what was auto-answered before it submits.
    await sleep(1500)
    if (activeQuestion.value?.paneId === q.paneId) {
      const currentQ = activeQuestion.value
      // Detect if the question was upgraded from text → choice while the LLM
      // was running (PTY-noise recovery path: block parser defaulted to text,
      // then the analyzer found options and called enqueueQuestion with
      // upgradeInPlace=true).  If so, re-trigger with the choice version so the
      // LLM can pick from the actual options rather than sending free text.
      const wasUpgradedToChoice =
        q.questions.every((oq) => oq.type === 'text') &&
        currentQ.questions.some((cq) => cq.type === 'choice' && cq.options.length > 0)
      // Reset pending flag BEFORE calling onAnswerQuestion / triggerAutoAnswer so
      // that the synchronous dequeueNextQuestion() inside onAnswerQuestion sees
      // autoAnswerPending = false and correctly triggers auto-answer for the next
      // queued question.  Without this, queued questions are permanently stranded.
      autoAnswerPending.value = false
      autoAnswerText.value = ''
      if (wasUpgradedToChoice) {
        pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 question upgraded to choice — re-running auto-answer`)
        reTriggered = true  // prevent finally from clearing the new call's flag
        void triggerAutoAnswer(currentQ)
      } else {
        await onAnswerQuestion(resp.payload.answer, resp.payload.answers ?? [resp.payload.answer])
      }
    } else {
      // Active question changed while LLM was running (user dismissed / stage advanced).
      pipelineLog(`Stage ${stage?.id ?? '?'} 🤖 auto-answer discarded — question no longer active`)
      autoAnswerPending.value = false
      autoAnswerText.value = ''
    }
  } finally {
    // Safety net for error/early-return paths.
    // Skip the reset when we've already handed off to a re-trigger call that is
    // now running and holds its own autoAnswerPending=true.
    if (!reTriggered) {
      autoAnswerPending.value = false
      autoAnswerText.value = ''
    }
  }
}

/**
 * Set the displayed question or, if one is already active, push to the queue.
 * When `upgradeInPlace` is true, replace activeQuestion directly (text→choice
 * upgrade from the analyzer for the same pane already showing a question).
 */
function enqueueQuestion(q: ActiveQuestion, upgradeInPlace = false): void {
  if (upgradeInPlace && activeQuestion.value?.paneId === q.paneId) {
    activeQuestion.value = q
    // If auto-answer had already finished (or failed) for the text version,
    // autoAnswerPending is false and no auto-answer is running for the newly
    // upgraded choice question — trigger it now.
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(q)
    }
    return
  }
  if (!activeQuestion.value) {
    activeQuestion.value = q
    // Auto-answer: trigger immediately when this becomes the active question
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(q)
    }
  } else {
    // Replace any existing queued entry for the same pane (avoids duplicates)
    const idx = questionQueue.findIndex((qi) => qi.paneId === q.paneId)
    if (idx >= 0) {
      questionQueue[idx] = q
    } else {
      questionQueue.push(q)
      questionQueueLen.value = questionQueue.length
      pipelineLog(
        `Stage ${stagesApi.stages.value[q.stageIndex]?.id} ⏳ "${q.slotLabel || q.paneId.slice(0, 8)}" question queued (${questionQueue.length} waiting)`
      )
    }
  }
}

/** Show the next queued question after the user answers / dismisses the current one. */
function dequeueNextQuestion(): void {
  const next = questionQueue.shift() ?? null
  questionQueueLen.value = questionQueue.length
  activeQuestion.value = next
  if (next) {
    pipelineLog(
      `Stage ${stagesApi.stages.value[next.stageIndex]?.id} ❓ now showing "${next.slotLabel || next.paneId.slice(0, 8)}" question (${questionQueue.length} still waiting)`
    )
    if (autoAnswerEnabled.value && !autoAnswerPending.value) {
      void triggerAutoAnswer(next)
    }
  }
}

// ── Stage-stall handlers ────────────────────────────────────────────────────
function clearStageStallAutoTimer(): void {
  if (stageStallAutoTimer !== null) {
    window.clearTimeout(stageStallAutoTimer)
    stageStallAutoTimer = null
  }
}

/** Raise the stall prompt — called when idle/cap fires in strict mode. */
function promptStageStall(
  stageIndex: number,
  paneId: string,
  reason: 'idle' | 'cap',
  detail: string
): void {
  // Don't stack prompts: if one is already showing, just log and let it resolve
  if (stageStallPrompt.value) {
    pipelineLog(`Stage stall (${reason}) suppressed — another prompt already showing`)
    return
  }
  const stage = stagesApi.stages.value[stageIndex]
  const paneMeta = panes.value.find((p) => p.id === paneId)
  const FULL_AUTO_GRACE_MS = 5000
  stageStallPrompt.value = {
    paneId,
    stageIndex,
    stageId: stage?.id ?? '?',
    stageTitle: stage?.title ?? '',
    slotLabel: paneMeta?.slotLabel ?? '',
    reason,
    detail,
    autoAdvanceAt: autoAnswerEnabled.value ? Date.now() + FULL_AUTO_GRACE_MS : null
  }
  // Full auto: after the grace period, advance ONLY when every slot has a
  // reliable finish signal (sentinel / turn_complete). Otherwise keep waiting —
  // never the old blind 5s push. We restart the watcher so a signal arriving
  // later still completes the slot promptly. The user can always click 強制推進
  // to override manually (forceAdvanceStall has no such gate).
  if (autoAnswerEnabled.value) {
    clearStageStallAutoTimer()
    const multiSlot = (stage?.slots.length ?? 1) > 1
    stageStallAutoTimer = window.setTimeout(() => {
      const p = stageStallPrompt.value
      if (!p || p.paneId !== paneId) return
      // Single-slot stages keep the original blind force-advance (acceptance:
      // single-slot behaviour unchanged). Only multi-slot stages get the
      // allSlotsFinished gate, so a real N/N is required before advancing.
      if (!multiSlot) {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto force-advanced after ${FULL_AUTO_GRACE_MS / 1000}s`)
        forceAdvanceStall()
        return
      }
      if (allSlotsFinished(computeStageSlotSignals(p.stageIndex))) {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto advanced after ${FULL_AUTO_GRACE_MS / 1000}s — all slots finished`)
        forceAdvanceStall()
      } else {
        pipelineLog(`Stage ${p.stageId} 🤖 Full auto held — not all slots finished, keep waiting`)
        continueWaitingStall()
      }
    }, FULL_AUTO_GRACE_MS)
  }
}

/** User clicked "繼續等待" — restart the watcher with fresh timers. */
function continueWaitingStall(): void {
  const p = stageStallPrompt.value
  if (!p) return
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  if (p.stageIndex !== pipeline.stageIndex) return  // stage already moved on
  pipelineLog(`Stage ${p.stageId} ⏯ continue waiting on "${p.slotLabel || p.paneId.slice(0, 8)}"`)
  // Restart the watcher: armedAt = now resets BOTH idle and cap counters
  startStageWatcher(p.stageIndex, p.paneId)
}

/** User clicked "強制推進" (or Full auto fired) — mark slot done. */
function forceAdvanceStall(): void {
  const p = stageStallPrompt.value
  if (!p) return
  clearStageStallAutoTimer()
  stageStallPrompt.value = null
  pipelineLog(`Stage ${p.stageId} ⏭ force-advanced after ${p.reason}: ${p.detail}`)
  onStageSlotCompleted(p.stageIndex, p.paneId, 'force')
}

/** Cancel the watcher for a single pane. */
function cancelWatcher(paneId: string): void {
  const w = watchers.get(paneId)
  if (!w) return
  w.cancelled = true
  if (w.pollHandle !== null) window.clearInterval(w.pollHandle)
  watchers.delete(paneId)
}

/** Cancel all watchers whose stageIndex matches — used when aborting/resetting. */
function cancelStageWatchers(stageIndex: number): void {
  for (const [paneId, w] of [...watchers.entries()]) {
    if (w.stageIndex === stageIndex) cancelWatcher(paneId)
  }
}

function cancelAllWatchers(): void {
  for (const paneId of [...watchers.keys()]) cancelWatcher(paneId)
  // Full reset (pipeline abort/complete): drop per-pane lifecycle signals so a
  // new run never inherits a prior pane's arm time / turn_complete and the maps
  // don't grow across runs. (The armedAt comparison already guards correctness;
  // this is hygiene.) cancelWatcher (single pane) intentionally does NOT clear
  // these — the stall path needs paneArmedAt after its watcher is cancelled.
  paneArmedAt.clear()
  paneTurnCompleteAt.clear()
  paneLastActiveAt.clear()
  paneLastWorkingAt.clear()
}

// ── Manager-mode router: parsers + scan + route ─────────────────────────────

const DISPATCH_RE = /---DISPATCH-START---([\s\S]*?)---DISPATCH-END---/g
const ASK_RE = /---ASK-START---([\s\S]*?)---ASK-END---/g
const REPORT_RE = /---REPORT-START---([\s\S]*?)---REPORT-END---/g

interface ParsedDispatch { to: string; message: string }

/** Parse content-bearing message blocks (ASK / REPORT) from a worker buffer
 *  region. Each block's `content:` field captures everything until the END
 *  marker (multi-line OK). Returns blocks + new cursor advanced past the
 *  last consumed block. */
function parseContentBlocks(
  buf: string,
  fromCursor: number,
  re: RegExp
): { items: string[]; newCursor: number } {
  const region = buf.slice(fromCursor)
  const items: string[] = []
  let lastEnd = 0
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(region)) !== null) {
    const inner = m[1]
    // `content:` consumes everything to end of inner block.
    const cm = inner.match(/(?:^|\n)\s*content:\s*([\s\S]*)$/)
    if (cm) {
      items.push(cm[1].trim())
    } else {
      // Tolerant fallback: take inner trimmed if no `content:` prefix.
      const trimmed = inner.trim()
      if (trimmed) items.push(trimmed)
    }
    lastEnd = m.index + m[0].length
  }
  return { items, newCursor: fromCursor + lastEnd }
}

/** Parse DISPATCH blocks from a Manager buffer region. */
function parseDispatchBlocks(
  buf: string,
  fromCursor: number
): { items: ParsedDispatch[]; newCursor: number } {
  const region = buf.slice(fromCursor)
  const items: ParsedDispatch[] = []
  let lastEnd = 0
  DISPATCH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DISPATCH_RE.exec(region)) !== null) {
    const inner = m[1]
    const toMatch = inner.match(/^\s*to:\s*(.+?)\s*$/m)
    const msgMatch = inner.match(/(?:^|\n)\s*message:\s*([\s\S]*)$/)
    if (toMatch && msgMatch) {
      const to = toMatch[1].trim()
      // Ignore the placeholder block when the Manager echoes the prompt
      // template verbatim (e.g. `to: <slot label>`) — `<...>` is never a real
      // slot label, so it would only log a spurious "找不到 slot" skip.
      if (!/^<.*>$/.test(to)) {
        items.push({ to, message: msgMatch[1].trim() })
      }
    }
    lastEnd = m.index + m[0].length
  }
  return { items, newCursor: fromCursor + lastEnd }
}

/** Find the worker pane whose label best matches `to`. Exact (case-insensitive)
 *  → substring either direction → null. */
function matchWorkerByLabel(router: StageRouter, to: string): { paneId: string; label: string } | null {
  const needle = to.trim().toLowerCase()
  if (!needle) return null
  for (const [label, paneId] of router.workerPaneIds) {
    if (label.toLowerCase() === needle) return { paneId, label }
  }
  for (const [label, paneId] of router.workerPaneIds) {
    const lbl = label.toLowerCase()
    if (lbl && (lbl.includes(needle) || needle.includes(lbl))) return { paneId, label }
  }
  return null
}

/** Scan all Manager-mode panes in the current stage for sentinel blocks +
 *  route messages. Called by startStageWatcher on each poll tick. */
async function managerRouterScan(stageIndex: number): Promise<void> {
  if (_managerScanRunning.has(stageIndex)) return
  if (stageIndex !== pipeline.stageIndex || pipeline.state !== 'running') return
  const router = stageRouters.get(stageIndex)
  const stage = stagesApi.stages.value[stageIndex]
  if (!router || !stage || router.finished) return
  _managerScanRunning.add(stageIndex)
  try {

  // ── Worker panes: scan for ASK / REPORT ───────────────────────────────────
  for (const [label, paneId] of router.workerPaneIds) {
    const ref = paneRefs[paneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    if (!buf) continue
    const cursor = router.cursors.get(paneId) ?? 0
    const askRes = parseContentBlocks(buf, cursor, ASK_RE)
    const reportRes = parseContentBlocks(buf, cursor, REPORT_RE)
    const newCursor = Math.max(askRes.newCursor, reportRes.newCursor, cursor)
    router.cursors.set(paneId, newCursor)
    for (const content of askRes.items) {
      queueOrRouteWorkerMsg(router, stage.id, { fromLabel: label, kind: 'ASK', content })
    }
    for (const content of reportRes.items) {
      queueOrRouteWorkerMsg(router, stage.id, { fromLabel: label, kind: 'REPORT', content })
    }
  }

  // ── Manager pane: detect MANAGER-READY → drain queue ──────────────────────
  if (router.managerPaneId && !router.managerReady) {
    const ref = paneRefs[router.managerPaneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    const cursor = router.cursors.get(router.managerPaneId) ?? 0
    if (findSentinel(buf, MANAGER_READY_SENTINEL, cursor) >= 0) {
      router.managerReady = true
      pipelineLog(`Stage ${stage.id} 🎯 Manager READY — 開始控場（drain ${router.preReadyQueue.length} 則訊息）`)
      const drain = router.preReadyQueue.splice(0)
      for (const msg of drain) {
        await injectManagerPane(router, msg)
      }
    }
  }

  // ── Manager pane: scan for DISPATCH + STAGE-DONE ──────────────────────────
  if (router.managerPaneId) {
    const ref = paneRefs[router.managerPaneId]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    const cursor = router.cursors.get(router.managerPaneId) ?? 0
    const { items: dispatches, newCursor } = parseDispatchBlocks(buf, cursor)
    router.cursors.set(router.managerPaneId, newCursor)
    for (const d of dispatches) {
      const target = matchWorkerByLabel(router, d.to)
      if (!target) {
        pipelineLog(`Stage ${stage.id} 🎯 dispatch 找不到 slot "${d.to}" — skip`)
        continue
      }
      const preview = d.message.slice(0, 50).replace(/\s+/g, ' ')
      pipelineLog(`Stage ${stage.id} 🎯 → ${target.label}: ${preview}${d.message.length > 50 ? '…' : ''}`)
      await injectPane(
        target.paneId,
        `[→ DISPATCH FROM Manager]\n${d.message}`,
        `manager-dispatch:${target.label}`,
        true
      )
    }
    if (!router.finished && findSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, 0) >= 0) {
      router.finished = true
      pipelineLog(`Stage ${stage.id} 🎯 Manager 印 ${MANAGER_STAGE_DONE_SENTINEL} — 收尾`)
      stageCompletions.delete(stageIndex)
      void onPipelineNext()
    }
  }
  } finally {
    _managerScanRunning.delete(stageIndex)
  }
}

function queueOrRouteWorkerMsg(router: StageRouter, stageId: string, msg: PendingMessage): void {
  if (!router.managerReady) {
    router.preReadyQueue.push(msg)
    pipelineLog(`Stage ${stageId} 🎯 ${msg.kind} from ${msg.fromLabel} 暫存（Manager 還沒 READY，已存 ${router.preReadyQueue.length} 則）`)
    return
  }
  void injectManagerPane(router, msg)
  pipelineLog(`Stage ${stageId} 🎯 → Manager: [${msg.kind} from ${msg.fromLabel}]`)
}

async function injectManagerPane(router: StageRouter, msg: PendingMessage): Promise<void> {
  if (!router.managerPaneId) return
  const text = `[→ ${msg.kind} FROM ${msg.fromLabel}]\n${msg.content}`
  await injectPane(router.managerPaneId, text, `${msg.kind.toLowerCase()}:${msg.fromLabel}`, true)
}

// ── Global Manager cross-stage router ────────────────────────────────────────
// When a global Manager is configured, scan every currently-active Worker pane
// (any stage) for ASK/REPORT blocks and route them to the global Manager pane.
// Also scans the global Manager's buffer for DISPATCH blocks and injects them
// into the target Worker. Runs on the same cadence as the stage router (2s).

let globalRouterHandle: number | null = null
const globalRouterCursors = new Map<string, number>()
let _globalScanRunning = false

function startGlobalManagerRouter(): void {
  if (globalRouterHandle !== null) return
  if (!pipeline.globalManager) return
  pipelineLog(`🎯 Global Manager router started (${pipeline.globalManager.stageId}/${pipeline.globalManager.slotLabel})`)
  globalRouterHandle = window.setInterval(() => { void globalManagerRouterScan() }, 2000)
}

function stopGlobalManagerRouter(): void {
  if (globalRouterHandle !== null) {
    window.clearInterval(globalRouterHandle)
    globalRouterHandle = null
    globalRouterCursors.clear()
    pipelineLog('🎯 Global Manager router stopped')
  }
}

async function globalManagerRouterScan(): Promise<void> {
  if (_globalScanRunning) return
  if (pipeline.state !== 'running') return
  _globalScanRunning = true
  try {
  const managerPaneId = globalManagerPaneId()
  if (!managerPaneId) return
  const gm = pipeline.globalManager!

  // Scan all active Worker panes (any stage, not the Manager itself) for ASK/REPORT
  const workerPanes = panes.value.filter(
    (p) => p.realized && p.origin === 'pipeline' && p.id !== managerPaneId &&
           !(p.stageId === gm.stageId && p.slotLabel === gm.slotLabel)
  )
  for (const wp of workerPanes) {
    const ref = paneRefs[wp.id]
    const buf: string = (ref?.cleanBuffer as unknown as string) ?? ''
    if (!buf) continue
    const cursor = globalRouterCursors.get(wp.id) ?? 0
    const askRes = parseContentBlocks(buf, cursor, ASK_RE)
    const reportRes = parseContentBlocks(buf, cursor, REPORT_RE)
    const newCursor = Math.max(askRes.newCursor, reportRes.newCursor, cursor)
    if (newCursor > cursor) globalRouterCursors.set(wp.id, newCursor)
    const fromLabel = wp.slotLabel || wp.stageId
    for (const content of askRes.items) {
      pipelineLog(`🎯 Global → Manager: [ASK from ${fromLabel}]`)
      await injectPane(managerPaneId, `[→ ASK FROM ${fromLabel} (Stage ${wp.stageId})]\n${content}`, `ask:${fromLabel}`, true)
    }
    for (const content of reportRes.items) {
      pipelineLog(`🎯 Global → Manager: [REPORT from ${fromLabel}]`)
      await injectPane(managerPaneId, `[→ REPORT FROM ${fromLabel} (Stage ${wp.stageId})]\n${content}`, `report:${fromLabel}`, true)
    }
  }

  // Scan Manager pane for DISPATCH → route to target Worker by label
  const mRef = paneRefs[managerPaneId]
  const mBuf: string = (mRef?.cleanBuffer as unknown as string) ?? ''
  const mCursor = globalRouterCursors.get(managerPaneId) ?? 0
  const { items: dispatches, newCursor: mNew } = parseDispatchBlocks(mBuf, mCursor)
  if (mNew > mCursor) globalRouterCursors.set(managerPaneId, mNew)
  for (const d of dispatches) {
    const target = panes.value.find(
      (p) => p.realized && p.origin === 'pipeline' && p.id !== managerPaneId &&
             p.slotLabel.toLowerCase() === d.to.toLowerCase()
    )
    if (!target) {
      pipelineLog(`🎯 Global DISPATCH 找不到 slot "${d.to}" — skip`)
      continue
    }
    pipelineLog(`🎯 Global → ${target.slotLabel} (Stage ${target.stageId}): ${d.message.slice(0, 50).replace(/\s+/g, ' ')}`)
    await injectPane(target.id, `[→ DISPATCH FROM Manager]\n${d.message}`, `manager-dispatch:${target.slotLabel}`, true)
  }
  } finally {
    _globalScanRunning = false
  }
}

/**
 * Called whenever one parallel slot in a stage finishes.
 * Advances the pipeline only after ALL expected slots are done.
 *
 * Cross-agent handoff: when a slot finishes early, its tail output is
 * injected into still-running sibling panes as a brief context update so
 * they can incorporate the completed work without waiting for a full restart.
 */
function onStageSlotCompleted(
  stageIndex: number,
  paneId: string,
  reason: SlotFinishReason = 'sentinel'
): void {
  if (stageIndex !== pipeline.stageIndex) return  // stale
  const tracker = stageCompletions.get(stageIndex)
  if (!tracker) { void onPipelineNext(); return }
  if (tracker.done.has(paneId)) return  // guard against double-fire
  tracker.done.add(paneId)
  const remaining = tracker.expected - tracker.done.size
  const stage = stagesApi.stages.value[stageIndex]
  const completedPane = panes.value.find((p) => p.id === paneId)
  const slotName = completedPane?.slotLabel || paneId.slice(0, 8)
  // Audit trail (→ history.jsonl): every slot finish records its reason so a
  // stage advance can be verified as N/N reliable signals, not a blind push.
  pipelineLog(
    `Stage ${stage?.id} ✓ slot "${slotName}" finished via ${reason}` +
    ` (${tracker.done.size}/${tracker.expected})`
  )
  if (remaining > 0) {
    pipelineLog(`Stage ${stage?.id} ⏳ waiting for ${remaining} more slot(s)`)

    // ── Cross-agent handoff ────────────────────────────────────────────────
    // Inject the completed slot's tail output into still-running siblings so
    // they can reference each other's work. Wait briefly for siblings to
    // settle between thoughts before sending the handoff message.
    const completedRef = paneRefs[paneId]
    const completedBuf: string = (completedRef?.cleanBuffer as unknown as string) ?? ''
    if (completedPane && completedBuf.trim() && stage) {
      const MAX_HANDOFF = 3000
      const rawSnippet = completedBuf.length > MAX_HANDOFF
        ? completedBuf.slice(completedBuf.length - MAX_HANDOFF)
        : completedBuf
      // Strip the completed slot's sentinel from the handoff text. Otherwise the
      // still-running sibling's watcher detects this sentinel echoed into its OWN
      // buffer and falsely marks itself done — firing pipeline-complete while the
      // sibling is still working (the "fireworks mid-development" bug). The
      // sentinel is a completion marker, not content, so dropping it is lossless.
      const snippet = stage.sentinel
        ? rawSnippet.split(stage.sentinel).join('〈完成標記〉')
        : rawSnippet
      const fromLabel = completedPane.slotLabel || stage.id
      // Find sibling panes that are still running (not in done set)
      const siblingPanes = panes.value.filter(
        (p) =>
          p.realized &&
          p.stageId === stage.id &&
          p.origin === 'pipeline' &&
          p.id !== paneId &&
          !tracker.done.has(p.id)
      )
      for (const sibling of siblingPanes) {
        const toLabel = sibling.slotLabel || sibling.id.slice(0, 8)
        ;(async () => {
          // Give the sibling a moment to settle before injecting context
          await sleep(3000)
          if (!paneAlive(sibling.id)) return
          pipelineLog(`Stage ${stage.id} 🔀 handoff: ${fromLabel} → ${toLabel}`)
          const handoffMsg =
            `[跨代理人 Handoff — ${fromLabel} 已完成]\n` +
            `以下是 ${fromLabel} 的最終輸出（請參考後繼續你的工作）：\n\n` +
            snippet.trim()
          await injectPane(sibling.id, handoffMsg, `handoff:${fromLabel}→${toLabel}`, true)
          // Push the sibling watcher's scan window PAST the injected handoff so
          // the sentinel / analyzer scanners don't read this injected text as
          // the sibling's OWN output — that pollution was tripping early
          // completion (the Stage 04 bug). Wait for the echo to land, then
          // advance to the buffer tail (mirrors onAnswerQuestion's scanFrom
          // advance). The completed slot's sentinel is already stripped above,
          // but the handoff body can still false-trigger the analyzer.
          await sleep(1500)
          const sw = watchers.get(sibling.id)
          if (sw && !sw.cancelled) {
            const len = ((paneRefs[sibling.id]?.cleanBuffer as unknown as string) || '').length
            if (len > sw.scanFrom) sw.scanFrom = len
            sw.lastAnalyzedBufferLen = len
            pipelineLog(`Stage ${stage.id} 🔀 handoff scan window advanced for ${toLabel} → ${len}`)
          }
        })()
      }
    }
  } else {
    stageCompletions.delete(stageIndex)
    void onPipelineNext()
  }
}

function startStageWatcher(stageIndex: number, paneId: string, kickoffScanFrom?: number): void {
  cancelWatcher(paneId)   // cancel only THIS pane's previous watcher
  const stage = stagesApi.stages.value[stageIndex]
  if (!stage) return
  const pane = paneRefs[paneId]
  if (!pane) return

  // Manager mode: when a slot is designated Manager for this stage, sentinel
  // watchers are skipped for ALL panes (Manager + workers). Stage completion
  // is decided by the Manager printing ---STAGE-DONE--- via the router poll.
  const hasManager = !!stageCommanderSlot(stage)
  if (hasManager) {
    const label = panes.value.find((p) => p.id === paneId)?.slotLabel || paneId.slice(0, 8)
    pipelineLog(`Stage ${stage.id} ⏸ slot watcher 跳過 ${label}（Manager 模式）`)
    return
  }

  // When kickoffScanFrom is provided (position captured just before kickoff
  // injection), use it directly — the kickoff content is collapsed to
  // "[Pasted text +N lines]" in the TUI so its INTERACTION_PROTOCOL examples
  // never appear as raw text in cleanBuffer, eliminating false detections.
  // When not provided (e.g. continueWaitingStall), fall back to the current
  // buffer end after re-applying the TUI noise filter.
  let scanFrom: number
  if (kickoffScanFrom !== undefined) {
    scanFrom = kickoffScanFrom
  } else {
    ;(pane.recleanBuffer as (() => void) | undefined)?.()
    scanFrom = (pane.markBufferPosition as () => number)()
  }

  // Guard against pre-existing sentinel in the buffer from a previous session
  // replayed via `claude resume`. Find the last occurrence before scanFrom and
  // record it as minScanFrom so buffer-cap resets never scan past it backwards.
  let minScanFrom = 0
  if (stage.sentinel && scanFrom > 0) {
    const existingBuf = (pane.cleanBuffer as unknown as string) ?? ''
    const lastPre = existingBuf.lastIndexOf('\n' + stage.sentinel, scanFrom)
    if (lastPre >= 0) {
      minScanFrom = lastPre + 1 + stage.sentinel.length
      pipelineLog(`Stage ${stage.id} ↩ pre-existing sentinel at ${lastPre} (resume history) — minScanFrom=${minScanFrom}`)
    }
  }

  const watcher: StageWatcher = {
    paneId,
    stageIndex,
    scanFrom,
    pollHandle: null,
    cancelled: false,
    waitingForAnswer: false,
    answeredAt: 0,
    armedAt: Date.now(),
    analyzerBusy: false,
    analyzerCooldownUntil: 0,
    lastAnalyzedBufferLen: 0,
    lastPollBufLen: 0,
    minScanFrom
  }
  watchers.set(paneId, watcher)
  paneArmedAt.set(paneId, watcher.armedAt)
  pipelineLog(
    `Stage ${stage.id} watcher armed · sentinel / turn_complete / question / analyzer`
  )

  watcher.pollHandle = window.setInterval(() => {
    if (watcher.cancelled) return
    const ref = paneRefs[paneId]
    if (!ref) {
      cancelWatcher(paneId)
      return
    }
    const buf = (ref.cleanBuffer as unknown as string) ?? ''

    // ── Generating check ─────────────────────────────────────────────────
    // Compare current buffer length with the length recorded at the end of
    // the previous poll tick (600 ms ago). If the buffer is still growing,
    // the agent is mid-generation — defer question detection to the next tick
    // so we never parse an incomplete QUESTION block or a partial answer echo.
    // Sentinel detection below is NOT gated (we still want to catch ---DONE---
    // even while the agent is streaming the last few lines).
    const prevPollBufLen = watcher.lastPollBufLen
    watcher.lastPollBufLen = buf.length
    const agentGenerating = buf.length > prevPollBufLen && prevPollBufLen > 0

    // ── Buffer-cap trim correction ────────────────────────────────────────
    // useTerminal caps cleanBuffer at 128 KB via bufferTail(). When the
    // kickoff is larger than 128 KB (Stage 05 with 240 KB of prior context),
    // the buffer is trimmed to exactly 128 KB and watcher.scanFrom is set to
    // 128 * 1024 by markBufferPosition() — which is PAST the end of the (now
    // trimmed) buffer. Every subsequent write keeps the buffer at 128 KB, so
    // scanFrom always equals buf.length and buf.slice(scanFrom) is always "".
    // This means the sentinel and question scanners search from past the end
    // and miss all agent output.
    //
    // Fix: when scanFrom is at/past the buffer end AND the buffer has been
    // filled to cap (evidenced by buf.length === 128 KB), the trim race has
    // occurred. For non-question stages it is safe to reset scanFrom to 0
    // because (a) each stage has a unique sentinel so scanning from 0 won't
    // trigger a false-positive match, and (b) allowQuestions=false means the
    // question scanner is skipped.  We don't reset for question-aware stages
    // (01/02) because their kickoff text contains example QUESTION blocks
    // with real-looking prompts that would be falsely detected (though in
    // practice Stages 01/02 kickoffs are small enough to avoid the cap).
    const CLEAN_BUF_CAP = 128 * 1024  // must match useTerminal.ts BUFFER_CAP
    if (!stage.allowQuestions && buf.length >= CLEAN_BUF_CAP && watcher.scanFrom >= buf.length) {
      pipelineLog(`Stage ${stage.id} 🔄 buffer-cap trim detected — resetting scanFrom to ${watcher.minScanFrom}`)
      watcher.scanFrom = watcher.minScanFrom
      watcher.lastAnalyzedBufferLen = 0
    }

    // Question pre-check for interactive stages — runs BEFORE sentinel so that
    // when an agent emits both a QUESTION block and the sentinel in the same
    // turn, the question is surfaced instead of silently advancing the stage.
    // Only applies to allowQuestions stages (currently Stage 01); other stages
    // have no question detection and the sentinel remains fully unconditional.
    if (stage.allowQuestions && !watcher.waitingForAnswer && buf.length > watcher.scanFrom && !agentGenerating) {
      const preBlocks = findConsecutiveQuestionBlocks(buf, watcher.scanFrom)
      const realPreBlocks = preBlocks.filter((b) => !QUESTION_PLACEHOLDER_RE.test(b.prompt.trim()))
      if (realPreBlocks.length > 0) {
        watcher.waitingForAnswer = true
        watcher.scanFrom = preBlocks[preBlocks.length - 1].endIndex
        const paneMeta = panes.value.find((p) => p.id === paneId)
        enqueueQuestion({
          paneId,
          stageIndex,
          questions: realPreBlocks.map((b) => ({ prompt: b.prompt, type: b.type, options: b.options })),
          agentLabel: paneMeta?.agentLabel ?? 'Agent',
          stageTitle: stage.title,
          slotLabel: paneMeta?.slotLabel ?? ''
        })
        pipelineLog(`Stage ${stage.id} ❓ (pre-sentinel) agent asked ${realPreBlocks.length} question(s)`)
        return  // skip sentinel detection this tick
      }
    }

    // Sentinel detection — UNCONDITIONAL (outside the waitingForAnswer guard).
    // The agent printing its done-sentinel means "stage complete", even if the
    // watcher currently thinks it's mid-Q&A. Without this, a genuine completion
    // gets hidden whenever the analyzer mis-reads the agent's "Open Questions"
    // section as real questions and flips waitingForAnswer on. Agent decision wins.
    // Exception: the question pre-check above returns early for allowQuestions
    // stages when a real question precedes the sentinel.
    //
    // Primary sentinel detection is turn-text (judgeTurnText, fed by the CLI's
    // own conversation log via agent.activity). This in-buffer scan is the
    // fallback ONLY for vendors whose log reader carries no turn text
    // (grok/antigravity/kimi); for claude/codex the strict turn-text path is
    // authoritative and this loose scan is skipped, because a TUI redraw that
    // re-echoes the kickoff's sentinel examples past scanFrom can false-complete
    // here — the exact class the outputLogFile supplement was removed for.
    const paneVendor = panes.value.find((p) => p.id === paneId)?.agentKey ?? ''
    if (stage.sentinel && !TURN_TEXT_VENDORS.has(paneVendor)) {
      let detected = false
      if (buf.length > watcher.scanFrom) {
        detected = buf.indexOf('\n' + stage.sentinel, watcher.scanFrom) >= 0
        if (!detected) detected = findSentinel(buf, stage.sentinel, watcher.scanFrom) >= 0
      }

      if (detected) {
        cancelWatcher(paneId)
        pipelineLog(`Stage ${stage.id} ✓ sentinel detected`)
        onStageSlotCompleted(stageIndex, paneId, 'sentinel')
        return
      }
    }

    if (!watcher.waitingForAnswer) {
      // 0. Post-answer stuck detection — spinner gone after answer injection.
      //    When Claude receives an answer but doesn't continue (sits at ❯ idle),
      //    the spinner stops → lastActivityAt goes stale. We detect this and
      //    send a minimal nudge so it resumes work. Only fires once per answer.
      const ANSWER_STALL_MS = 8_000
      if (watcher.answeredAt > 0) {
        const lastAct = (ref.lastActivityAt as unknown as number) ?? 0
        const idleSinceAnswer = Date.now() - Math.max(lastAct, watcher.answeredAt)
        if (idleSinceAnswer > ANSWER_STALL_MS) {
          // Before nudging, check whether there is an unanswered QUESTION block
          // in the buffer from scanFrom. This happens when the agent outputs a
          // QUESTION and then keeps running (tool use / Crunching), so
          // agentGenerating blocked question detection, but answeredAt from a
          // prior answer makes the stall check think the agent is stuck.
          // In that case, reset answeredAt and let question detection surface it
          // on the next stable tick instead of erroneously nudging.
          const hasPendingQuestion =
            stage.allowQuestions &&
            buf.indexOf('---QUESTION-START---', watcher.scanFrom) >= 0 &&
            buf.indexOf('---QUESTION-END---', watcher.scanFrom) >= 0
          if (hasPendingQuestion) {
            watcher.answeredAt = 0  // prevent re-firing
            return  // question detection will surface it on next stable tick
          }
          watcher.answeredAt = 0  // reset so we don't fire again
          pipelineLog(`Stage ${stage.id} ⚡ CLI idle after answer — nudging agent to continue`)
          ;(async () => {
            const sessionId = (ref.sessionId as string | undefined)
            if (sessionId) await injectText(sessionId, '請繼續', `nudge:${stage.id}`)
          })()
        }
      }

      // 1. Question detection — only for stages that allow user interaction
      //    (stage.allowQuestions === true, currently only Stage 01).
      //    Later stages run autonomously and must not pause for user input.
      //    Skipped when agentGenerating so we never parse a partial block.
      if (stage.allowQuestions && buf.length > watcher.scanFrom && !agentGenerating) {
        const blocks = findConsecutiveQuestionBlocks(buf, watcher.scanFrom)
        // Drop any block whose prompt is still a template placeholder (e.g.
        // "<你的問題>", "<your question>"). The agent copied the INTERACTION_PROTOCOL
        // example verbatim instead of filling in real content.
        const realBlocks = blocks.filter((b) => !QUESTION_PLACEHOLDER_RE.test(b.prompt.trim()))
        if (realBlocks.length < blocks.length) {
          pipelineLog(`Stage ${stage.id} ⚠ dropped ${blocks.length - realBlocks.length} placeholder question(s) — agent echoed the template`)
        }
        if (realBlocks.length > 0) {
          watcher.waitingForAnswer = true
          watcher.scanFrom = blocks[blocks.length - 1].endIndex
          const paneMeta = panes.value.find((p) => p.id === paneId)
          enqueueQuestion({
            paneId,
            stageIndex,
            questions: realBlocks.map((b) => ({ prompt: b.prompt, type: b.type, options: b.options })),
            agentLabel: paneMeta?.agentLabel ?? 'Agent',
            stageTitle: stage.title,
            slotLabel: paneMeta?.slotLabel ?? ''
          })
          const choiceCount = realBlocks.filter((b) => b.type === 'choice').length
          pipelineLog(
            `Stage ${stage.id} ❓ agent asked ${realBlocks.length} question(s)` +
              (choiceCount > 0 ? ` (${choiceCount} choice)` : '')
          )
          // Surface diagnostic when a block declared choice but we found 0 options
          for (const b of realBlocks) {
            const diag = (b as typeof b & { _diag?: string })._diag
            if (diag) {
              pipelineLog(`Stage ${stage.id} ⚠ choice parse missed — options raw: ${diag}`)
            }
          }
          return
        }
      }

      // 2. turn_complete — PRIMARY completion path (after sentinel). The CLI
      //    reported its turn ended and, having passed question detection above
      //    with no pending/new question, it's back at the prompt. Ordered AFTER
      //    question detection so an interactive QUESTION (whose turn also ends)
      //    is caught as a question first, never as completion. turnCompleteDone
      //    requires: post-arm, the LATEST signal (no agent_active after = not
      //    revived by an injected handoff/answer), and settled SETTLE_MS so the
      //    buffer's question text can catch up before we advance.
      if (
        !stage.allowQuestions &&
        turnCompleteDone({
          turnCompleteAt: paneTurnCompleteAt.get(paneId) ?? 0,
          lastActiveAt: paneLastActiveAt.get(paneId) ?? 0,
          armedAt: watcher.armedAt,
          now: Date.now(),
          settleMs: TURN_COMPLETE_SETTLE_MS
        })
      ) {
        cancelWatcher(paneId)
        pipelineLog(`Stage ${stage.id} ✓ turn_complete reported by CLI`)
        onStageSlotCompleted(stageIndex, paneId, 'turn_complete')
        return
      }

      // 3. Analyzer — now ONLY detects questions. Completion judgement moved to
      //    the CLI-state signals above (sentinel / turn_complete); the analyzer
      //    no longer advances stages. It reads the SAME buffer the agent printed
      //    and, if there's a question the buffer scanner missed, surfaces it.
      const now = Date.now()
      const lastActivityAt = (ref.lastActivityAt as unknown as number) ?? 0
      const idleMs = now - Math.max(lastActivityAt, watcher.armedAt)
      const bufferLen = (ref.cleanBuffer as unknown as string).length
      const newChars = bufferLen - watcher.lastAnalyzedBufferLen
      const hasResponded = lastActivityAt > watcher.armedAt
      const ANALYZER_QUIET_MS = 4_000
      const ANALYZER_COOLDOWN_MS = 5_000
      const ANALYZER_MIN_NEW_CHARS = 120
      const ANALYZER_FORCE_IDLE_MS = 12_000
      // Primary: agent produced new output then went quiet — read it.
      const primaryTrigger =
        hasResponded && idleMs > ANALYZER_QUIET_MS && newChars > ANALYZER_MIN_NEW_CHARS
      // Force re-ask (interactive stages only): the agent may have printed a
      // QUESTION and is now sitting silently waiting for an answer, so newChars
      // stops growing. Without this, a TUI-mangled question block or a transient
      // malformed-JSON from the analyzer would leave the stage stuck with no
      // Q&A popup forever. The 5s cooldown throttles it; the whole block is
      // skipped once a question pops (waitingForAnswer guard above), so it can't
      // loop after the dialog appears.
      const forceTrigger =
        stage.allowQuestions && hasResponded &&
        idleMs > ANALYZER_FORCE_IDLE_MS && bufferLen > watcher.scanFrom + 50
      if (
        analyzerApi.health.value?.ok &&
        !watcher.analyzerBusy &&
        now > watcher.analyzerCooldownUntil &&
        (primaryTrigger || forceTrigger)
      ) {
        watcher.analyzerBusy = true
        watcher.lastAnalyzedBufferLen = bufferLen
        const slice = ((ref.cleanBuffer as unknown as string) || '').slice(watcher.scanFrom)
        const trigger = primaryTrigger
          ? `quiet ${Math.round(idleMs / 1000)}s+${newChars}c`
          : `force ${Math.round(idleMs / 1000)}s`
        ;(async () => {
          // Quick regex pre-filter — skip LLM on obvious completions.
          // Only on primaryTrigger (agent went quiet after new output), NOT
          // forceTrigger (interactive re-ask for missed questions) — we don't
          // want regex to swallow a QUESTION the buffer scanner missed.
          if (primaryTrigger && !stage.allowQuestions && quickClassify(slice) === 'completion') {
            watcher.analyzerBusy = false
            if (watcher.cancelled) return
            pipelineLog(`Stage ${stage.id} ⚡ regex detected completion (skipped LLM)`)
            cancelWatcher(paneId)
            onStageSlotCompleted(stageIndex, paneId, 'analyzer')
            return
          }
          pipelineLog(`Stage ${stage.id} 🧠 asking analyzer (${slice.length} chars · ${trigger})`)
          const result = await analyzerApi.classify(slice, analyzerModel.value || undefined, {
            workspacePath: pipeline.workspacePath,
            stageId: stage.id,
            paneId
          })
          watcher.analyzerBusy = false
          watcher.analyzerCooldownUntil = Date.now() + ANALYZER_COOLDOWN_MS
          if (watcher.cancelled) return
          if (!result) {
            pipelineLog(`Stage ${stage.id} 🧠 analyzer error`)
            return
          }
          pipelineLog(
            `Stage ${stage.id} 🧠 intent=${result.intent} (${result.total_duration_ms ?? '?'}ms)${
              result.summary ? ` — ${result.summary}` : ''
            }`
          )
          handleAnalyzerResult(stageIndex, paneId, stage, result)
        })()
      }

      // 4. Hard-cap backstop — never let one wedged agent block the pipeline
      //    forever. The sentinel / analyzer above end the stage well before this.
      if (now - watcher.armedAt > STAGE_MAX_DURATION_MS) {
        cancelWatcher(paneId)
        const detail = `hit ${Math.round(STAGE_MAX_DURATION_MS / 60_000)}min cap`
        pipelineLog(`Stage ${stage.id} ⚠ ${detail}`)
        promptStageStall(stageIndex, paneId, 'cap', detail)
      }
    } // end !waitingForAnswer guard
  }, 600)
}

function handleAnalyzerResult(
  stageIndex: number,
  paneId: string,
  stage: { id: string; title: string; allowQuestions?: boolean },
  result: ClassifyResult
): void {
  const watcher = watchers.get(paneId)
  if (!watcher || watcher.cancelled) return

  // Completion —
  //   • Multi-slot: IGNORED. The analyzer's buffer guess mis-fires under handoff
  //     pollution → early advances (the Stage 04 bug). Multi-slot completes only
  //     via factual signals (sentinel / turn_complete).
  //   • Single-slot: FALLBACK advance. No siblings, no handoff pollution, so the
  //     analyzer's read of the agent's own output is safe to trust. This is the
  //     safety net for when the agent finished but printed NO sentinel AND
  //     turn_complete didn't land (e.g. mis-attributed to a sibling pane) —
  //     without it the stage stalls and the analyzer just spins (Stage 01/02).
  if (result.intent === 'completion') {
    const slotCount = stagesApi.stages.value[stageIndex]?.slots.length ?? 1
    if (slotCount > 1) {
      // Multi-slot FALLBACK: trust analyzer completion ONLY once the buffer has
      // been truly quiet — a sibling churns right after a handoff injection, so
      // a short post-handoff pause must not be read as completion (Stage 04
      // early-advance). lastActivityAt is the PTY buffer's own quiet clock
      // (frontend-local), immune to pane mis-attribution.
      const ref = paneRefs[paneId]
      const lastAct = (ref?.lastActivityAt as unknown as number) ?? 0
      const quietMs = Date.now() - lastAct
      if (quietMs < MULTISLOT_ANALYZER_CONFIRM_MS) {
        pipelineLog(`Stage ${stage.id} 🧠 analyzer completion held — buffer quiet ${Math.round(quietMs / 1000)}s < ${MULTISLOT_ANALYZER_CONFIRM_MS / 1000}s (multi-slot)`)
        return
      }
      cancelWatcher(paneId)
      pipelineLog(`Stage ${stage.id} ✓ analyzer detected completion (multi-slot fallback, quiet ${Math.round(quietMs / 1000)}s)`)
      onStageSlotCompleted(stageIndex, paneId, 'analyzer')
      return
    }
    cancelWatcher(paneId)
    pipelineLog(`Stage ${stage.id} ✓ analyzer detected completion (fallback)`)
    onStageSlotCompleted(stageIndex, paneId, 'analyzer')
    return
  }

  // Question — only pause for stages that allow it, and only if this pane
  // doesn't already have a question pending.
  const qs = result.questions ?? (result.question ? [result.question] : [])
  const alreadyPending =
    activeQuestion.value?.paneId === paneId ||
    questionQueue.some((qi) => qi.paneId === paneId)
  if (stage.allowQuestions && result.intent === 'question' && qs.length > 0 && !alreadyPending) {
    watcher.waitingForAnswer = true
    // Advance scan window to current buffer end so that after the user answers,
    // the next analysis pass doesn't re-read and re-detect the same questions.
    const ref = paneRefs[paneId]
    const currentLen = ((ref?.cleanBuffer as unknown as string) || '').length
    if (currentLen > watcher.scanFrom) watcher.scanFrom = currentLen
    watcher.lastAnalyzedBufferLen = currentLen
    const paneMeta = panes.value.find((p) => p.id === paneId)
    enqueueQuestion({
      paneId,
      stageIndex,
      questions: qs.map((q) => ({ prompt: q.prompt, type: q.type, options: q.options })),
      agentLabel: paneMeta?.agentLabel ?? 'Agent',
      stageTitle: `${stage.title} · 🧠 analyzer`,
      slotLabel: paneMeta?.slotLabel ?? ''
    })
    const choiceCount = qs.filter((q) => q.type === 'choice').length
    pipelineLog(
      `Stage ${stage.id} ❓ analyzer detected ${qs.length} question(s)` +
        (choiceCount > 0 ? ` (${choiceCount} choice)` : '')
    )
  }
}

async function onAnswerQuestion(combined: string, _answers: string[]): Promise<void> {
  const q = activeQuestion.value
  if (!q) return
  dequeueNextQuestion()
  pipelineLog(
    `↩ answered ${q.questions.length} question(s) for stage ${stagesApi.stages.value[q.stageIndex]?.id}: ${truncate(combined, 80)}`
  )
  const ref = paneRefs[q.paneId]
  if (ref?.sessionId) {
    await injectText(ref.sessionId as string, combined, `user-answer:stage-${stagesApi.stages.value[q.stageIndex]?.id}`)
  }
  ref?.focus?.()
  const w = watchers.get(q.paneId)
  if (w) {
    w.waitingForAnswer = false
    w.answeredAt = Date.now()  // track injection time for stuck detection
    // Do NOT advance scanFrom here. scanFrom already sits at Q1's endIndex
    // (set when Q1 was first detected). Pushing it to currentLen would skip
    // over any Q2 the agent generates quickly while the answer is being typed.
    // The agentGenerating guard in the poll loop prevents premature detection
    // of partial blocks, so Q2 is found correctly on the next stable tick.
    const currentLen = ((ref?.cleanBuffer as unknown as string) || '').length
    w.lastAnalyzedBufferLen = currentLen
    // Give the agent a few seconds to process the answer before re-analyzing.
    w.analyzerCooldownUntil = Date.now() + 5_000
  }
}

function onCancelQuestion(): void {
  const q = activeQuestion.value
  if (!q) return
  dequeueNextQuestion()
  pipelineLog(`✕ dismissed question for stage ${stagesApi.stages.value[q.stageIndex]?.id} (watcher resumed)`)
  const ref = paneRefs[q.paneId]
  ref?.focus?.()
  const w = watchers.get(q.paneId)
  if (w) w.waitingForAnswer = false
}

function truncate(s: string, n: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim()
  return oneline.length > n ? oneline.slice(0, n - 1) + '…' : oneline
}

// ── Layout mode (F-A) + Minimize to sidebar (F-B) ────────────────────────────
const layoutMode = ref<LayoutMode>('grid')
const focusPaneId = ref<string | null>(null)
const minimizedPanes = ref(new Set<string>())
/** Panes whose lineage subtree is folded in the agent lists. Persisted per
 *  pane (PaneRecord.collapsed) rather than as a Project-level id set, because
 *  pane_id is regenerated on every restart — such a set would silently empty
 *  itself and the tree would always come back fully expanded. */
const collapsedPanes = ref(new Set<string>())

// ── Idle CLI reclaim ─────────────────────────────────────────────────────────
// A CLI that has been idle for hours still holds every byte it ever allocated.
// The ownerless-PTY janitor in the backend cannot help here: these panes have a
// window, so they have an owner. This is the other half — an owned pane whose
// owner stopped using it.
//
// Reclaiming is deliberately NOT closing. The pane keeps its place, its name and
// its saved record, and drops back to the cold-restore placeholder the app shows
// for every pane after a restart. Clicking it runs the same realize path, which
// resumes the conversation from the CLI's own transcript.

/** How often the sweep runs. Well under any sensible threshold. */
const IDLE_RECLAIM_SWEEP_MS = 60_000

/** The live pane, flattened into what the reclaim decision reads.
 *
 *  Agent output and user keystrokes are both folded into lastTouchedAt because
 *  either one alone is wrong: a pane the user is reading (scrolling a long
 *  answer, never typing) has old keystrokes, and a pane the user just typed
 *  into has no output of its own yet. */
function reclaimCandidate(pane: ActivePane): ReclaimCandidate {
  const ref = paneRefs[pane.id]
  const activity = (ref?.lastActivityAt as unknown as number) ?? 0
  const key = (ref?.lastUserKeyAt as unknown as number) ?? 0
  return {
    realized: pane.realized,
    restoring: !!pane.restoring,
    focused: focusPaneId.value === pane.id,
    resumeSessionId: paneResumeSessionId(pane),
    rebuilding: paneRebuilding(pane),
    loopActive: !!pane.loopActive,
    preparationStatus: pane.preparationStatus as unknown as string,
    injectionStatus: pane.injectionStatus as unknown as string,
    spawnReportPending: !!pane.spawnReportPending,
    hasRef: !!ref,
    displayStatus: (ref?.displayStatus as unknown as string) ?? '',
    hasDraft: !!(ref?.hasDraft as unknown as boolean),
    lastTouchedAt: Math.max(activity, key),
  }
}

function paneReclaimable(pane: ActivePane, now: number): boolean {
  return reclaimBlockedBy(
    reclaimCandidate(pane), idleReclaimThresholdMs(idleReclaimMinutes.value), now
  ) === null
}

/** The saved record a placeholder needs, rebuilt from the live pane.
 *
 *  Mirrors the shape cold restore reads back from the backend (see the
 *  placeholder built in the restore path) so the realize path cannot tell the
 *  two apart. */
function projectPaneFromActive(pane: ActivePane): ProjectPane {
  const stageIndex = stagesApi.stages.value.findIndex((st) => st.id === pane.stageId)
  return {
    pane_id: pane.id,
    agent: pane.agentKey,
    role: pane.roleKey as string,
    command: pane.command || undefined,
    session_id: paneResumeSessionId(pane),
    session_home_id: pane.sessionHomeId,
    profile_id: pane.profileId,
    spawn_status: 'spawned',
    run_group_id: pane.runGroupId,
    origin: pane.origin,
    stage_id: pane.stageId as string,
    stage_index: stageIndex >= 0 ? stageIndex : undefined,
    slot_label: pane.slotLabel,
    kickoff_status: pane.kickoffStatus,
    custom_name: pane.customName,
    name_locked: pane.nameLocked,
    auto_name: pane.autoName,
    auto_name_source: pane.autoNameSource,
    is_minimized: minimizedPanes.value.has(pane.id),
    output_log_file: pane.outputLogFile,
  }
}

/** Kill one idle pane's CLI and leave the placeholder in its seat. */
async function reclaimIdlePane(paneId: string): Promise<boolean> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return false
  const saved = projectPaneFromActive(pane)
  // Spawn history records a pane's removal unconditionally, and this is not a
  // removal — the pane is still there, still resumable. Restored after the kill
  // rather than by teaching onKill a new flag, so no other caller's history
  // behaviour changes.
  const histEntry = spawnHistory.value.find((e) => e.paneId === paneId)
  const alreadyRemoved = !!histEntry?.removedAt
  // markRemoved: false — the backend record is what the placeholder resumes
  // from; unspawning it would make this a real close on the next restart.
  // keepInList: true — the pane keeps its seat, name and group.
  // force: false — a graceful signal lets the CLI finish writing its transcript,
  // which is the thing the resume depends on.
  await onKill(paneId, { markRemoved: false, keepInList: true, force: false })
  if (histEntry && !alreadyRemoved) histEntry.removedAt = undefined
  // onKill leaves the pane object in place; turn it back into the placeholder
  // the cold-restore path builds.
  const stillThere = panes.value.find((p) => p.id === paneId)
  if (!stillThere) return false
  stillThere.realized = false
  stillThere.restoring = false
  stillThere.preparationStatus = 'starting'
  stillThere.injectionStatus = 'pending'
  stillThere.skipRoleInjection = true
  stillThere.resumeContinueAvailable = undefined
  stillThere.deferredRestore = {
    saved,
    workspacePath: pane.workspacePath,
    batch: {
      workspacePath: pane.workspacePath,
      records: [saved],
      savedClaims: [saved],
      usedFreshSessionIds: new Set<string>(),
    },
  }
  syncViews()
  return true
}

let _idleReclaimTimer: number | null = null

async function sweepIdlePanes(): Promise<void> {
  if (!idleReclaimEnabled.value) return
  const now = Date.now()
  const due = panes.value.filter((p) => paneReclaimable(p, now)).map((p) => p.id)
  if (due.length === 0) return
  let reclaimed = 0
  for (const paneId of due) {
    // Re-checked per pane: the sweep awaits a kill between candidates, and the
    // user can focus or type into the next one while it runs.
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane || !paneReclaimable(pane, Date.now())) continue
    if (await reclaimIdlePane(paneId)) reclaimed++
  }
  if (reclaimed === 0) return
  // Logged, not announced: the sweep runs on a timer the user did not ask for,
  // so a toast interrupts work to report housekeeping. The reclaimed pane still
  // shows as a placeholder they can click to resume.
  pipelineLog(`♻ reclaimed ${reclaimed} idle CLI pane(s) — click to resume`)
}

/** Panes the user could reclaim right now, ignoring how long they have been
 *  idle. Drives the count on every "reclaim now" control, so the button can
 *  say what it is about to do before it is pressed. */
const reclaimableNowIds = computed<string[]>(() => {
  const now = Date.now()
  return panes.value
    .filter((p) => reclaimBlockedBy(reclaimCandidate(p), RECLAIM_NOW_THRESHOLD_MS, now) === null)
    .map((p) => p.id)
})

/** Rough bytes a reclaim would return, for a control that has no measurement.
 *
 *  Deliberately a round per-CLI figure rather than a real reading: the settings
 *  row has no reason to shell out for a sweep, and the honest presentation of
 *  an estimate is "about", which is what its copy says. The memory panel, which
 *  does measure, never uses this. */
const RECLAIM_ESTIMATE_BYTES_PER_CLI = 250 * 1024 * 1024

/** Reclaim now, by explicit request. Returns how many actually went. */
async function reclaimPanesNow(paneIds?: string[]): Promise<number> {
  const targets = paneIds ?? reclaimableNowIds.value
  let reclaimed = 0
  for (const paneId of targets) {
    // Re-checked per pane for the same reason the sweep does it: this awaits a
    // kill between candidates, and the user can focus or type into the next one
    // while it runs.
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane) continue
    if (reclaimBlockedBy(reclaimCandidate(pane), RECLAIM_NOW_THRESHOLD_MS, Date.now()) !== null) continue
    if (await reclaimIdlePane(paneId)) reclaimed++
  }
  if (reclaimed > 0) {
    pipelineLog(`♻ reclaimed ${reclaimed} CLI pane(s) on request — click to resume`)
    notifyRestore.toast(
      i18n.global.t('pane.terminal.idle-reclaimed', { count: reclaimed }),
      { type: 'info' }
    )
  }
  return reclaimed
}

onMounted(() => {
  _idleReclaimTimer = window.setInterval(() => { void sweepIdlePanes() }, IDLE_RECLAIM_SWEEP_MS)
})
onUnmounted(() => {
  if (_idleReclaimTimer !== null) clearInterval(_idleReclaimTimer)
})
// Multi-select set for batch context-menu actions (Cmd/Ctrl/Shift-click a pane
// header). Pruned to live pane ids by the panes watcher; a plain click clears it.
const selectedPaneIds = ref(new Set<string>())
// The multi-selection as an ordered id list, or empty below two panes. Drag
// sources need the batch as a payload they can hand to another window, and one
// shared array keeps every pane's prop identity stable across re-renders.
const selectionBatchIds = computed<string[]>(() =>
  selectedPaneIds.value.size < 2
    ? []
    : panes.value.map((p) => p.id).filter((id) => selectedPaneIds.value.has(id))
)
// Anchor for Shift-click range selection (same semantics as GitPane's
// lastClickKey): set by plain and Cmd/Ctrl clicks, left untouched by Shift
// clicks, nulled by the panes watcher when the pane disappears.
const lastClickPaneId = ref<string | null>(null)

// Focusing a pane while the app is in the foreground means the user is now
// looking at it — clear its Dock badge pending state. markSeen itself gates on
// app focus, so programmatic focus changes while backgrounded (tab bookkeeping,
// pane add/remove) don't silently eat the badge.
watch(focusPaneId, (id) => {
  if (id) {
    sysNotify.markSeen(id)
    void nextTick(() => {
      paneRefs[id]?.focus?.()
    })
  }
})
// Regaining app focus with a pending pane already focused must also count as
// seen — focusPaneId didn't change, so the watcher above won't fire.
watch(sysNotify.appFocused, (focused) => {
  if (focused && focusPaneId.value) sysNotify.markSeen(focusPaneId.value)
})

// ── Agent Run Group Tab Bar ───────────────────────────────────────────────────
// Naming guide for this area:
//   Pipeline = the configured workflow template/run selected in the left panel.
//   Pane     = one live terminal session running Claude Code / Codex / Antigravity.
//   RunGroup = a frontend grouping bucket for panes; rendered to the user as a tab.
//   Tab      = the visible UI affordance for selecting one RunGroup.
//
// Rule: when panes are created by a Pipeline run, their RunGroup tab name should
// be the Pipeline name. Ad-hoc groups created by the + button may use "Run N".
// Manual panes without any group appear in the special "手動" tab.

const runGroups = ref<RunGroup[]>([])
const currentRunGroupId = ref<string>('')  // ID assigned to newly spawned pipeline panes
const activeTab = ref<string>('')

// True while applying a runGroups change received from another window via the
// `project.ui_state_changed` broadcast. Guards _saveRunGroups so a
// remote-applied value is not written straight back, which would ping-pong
// between the two windows.
const applyingRemote = ref(false)

// The workspace runGroups holds the groups OF. A switch sets currentWorkspace
// first and loads the entered workspace's groups several awaits later, so in
// between the pair disagrees: runGroups still belongs to the workspace being
// left while currentWorkspace already names the one being entered. Any save
// landing in that window wrote the leaving workspace's list over the entered
// one's — [] for a project that never made a group, which is not a no-op but
// a wipe. Its panes keep their run_group_id, so they match no tab and cannot
// be reached from any of them: present in the sidebar, on screen nowhere.
// Restore alone fires enough saves (ensureSavedGroup per restored pane) to hit
// the window every time.
const runGroupsOwner = ref<string>('')

/** Every held workspace's run groups, keyed by normWs(path).
 *
 *  runGroups only ever describes the workspace on screen. The sidebar lists
 *  every workspace this window holds, so it had nothing to group the others'
 *  panes by and listed them flat: switching away made a project's Run sections
 *  disappear from the sidebar while its records sat intact on disk. This is
 *  the window's copy of what each held workspace has persisted. The viewed
 *  workspace still renders from runGroups — that one is live, and can be ahead
 *  of the last save.
 */
const runGroupsByWorkspace = ref<Record<string, readonly RunGroup[]>>({})

function _cacheRunGroups(path: string, groups: readonly RunGroup[]): void {
  const key = normWs(path)
  if (!key) return
  runGroupsByWorkspace.value = { ...runGroupsByWorkspace.value, [key]: [...groups] }
}

/** Forget a workspace the window no longer holds, so taking it on again loads
 *  its records rather than showing the list it had when it was let go. */
function _forgetRunGroups(path: string): void {
  const key = normWs(path)
  if (!(key in runGroupsByWorkspace.value)) return
  const next = { ...runGroupsByWorkspace.value }
  delete next[key]
  runGroupsByWorkspace.value = next
}

function _saveRunGroups(): void {
  if (applyingRemote.value || isDetachedWindow) return
  const ws = currentWorkspace.value
  if (!ws) return
  // Never write one workspace's groups into another's record.
  if (normWs(runGroupsOwner.value) !== normWs(ws)) return
  // Every group edit funnels through here, so mirroring the write is what
  // keeps the sidebar's copy of this workspace true after you switch away.
  _cacheRunGroups(ws, runGroups.value)
  void sendQuiet('project.set_ui_state', {
    workspace_path: ws,
    run_groups: runGroups.value,
  })
}

// True while adopting a workspace-load or peer-window CLI Agents prefs value,
// so that adoption doesn't immediately echo back through the watcher below.
const applyingRemoteCliPrefs = ref(false)

function _saveCliAgentPrefs(): void {
  if (applyingRemoteCliPrefs.value || isDetachedWindow) return
  const ws = currentWorkspace.value
  if (!ws) return
  void sendQuiet('project.set_ui_state', {
    workspace_path: ws,
    cli_agent_order: cliAgentOrder.value,
    cli_agent_disabled: cliAgentDisabled.value,
  })
}
watch([cliAgentOrder, cliAgentDisabled], _saveCliAgentPrefs, { deep: true })

/** Cross-window sync: when another window persists this workspace's runGroups
 *  (project.set_ui_state), the backend broadcasts project.ui_state_changed to
 *  the peer windows (the sender is excluded), so both stay consistent (fixes
 *  the last-write-wins race where one window silently overwrote the other).
 *  Only run_groups is synced — activeTab and layout are per-window view state
 *  and are intentionally left independent. applyingRemote prevents the adopted
 *  value from being written straight back. */
function onRunGroupsRemoteSync(raw: unknown): void {
  const d = raw as {
    workspace_path?: string
    run_groups?: RunGroup[]
    spawn_history?: SpawnHistoryEntry[]
    renamed_pane?: { pane_id?: string; custom_name?: string }
    auto_named_pane?: { pane_id?: string; auto_name?: string; source?: string }
    cli_agent_order?: string[]
    cli_agent_disabled?: string[]
  } | null
  const ws = currentWorkspace.value
  if (!ws || !d || d.workspace_path !== ws) return
  // A peer window renamed a pane. spawn_history below only patches the
  // resume/history mirror — the live pane state must be patched too, or this
  // window's pane title and lists keep showing the old name.
  if (d.renamed_pane?.pane_id) {
    const pane = panes.value.find((p) => p.id === d.renamed_pane!.pane_id)
    if (pane) {
      // Manual renames only. Auto-names travel under auto_named_pane below, so
      // this branch can never clear one.
      if (d.renamed_pane.custom_name !== undefined) {
        pane.customName = d.renamed_pane.custom_name.trim() || undefined
      }
      // The peer's rename locks the pane here too, or this window would keep
      // auto-naming a pane the user has already claimed in another window.
      pane.nameLocked = true
    }
  }
  // A peer window auto-named a pane (backend broadcasts this under its own
  // key so it can never be mistaken for a manual rename). customName still
  // wins in the display chain, so applying it unconditionally is safe.
  if (d.auto_named_pane?.pane_id && d.auto_named_pane.auto_name) {
    const autoName = d.auto_named_pane.auto_name.trim() || undefined
    const pane = panes.value.find((p) => p.id === d.auto_named_pane!.pane_id)
    if (pane) {
      pane.autoName = autoName
      // Adopt the source too: without it this window would read the peer's
      // model-written title as still-upgradable and ask for a second one.
      pane.autoNameSource = autoNameSourceOf(d.auto_named_pane.source)
    }
    // This broadcast carries no spawn_history, so patch our history mirror the
    // same way the local setPaneAutoName path does — otherwise our next
    // snapshot would write the name back out of the backend's mirror.
    const histEntry = spawnHistory.value.find((e) => e.paneId === d.auto_named_pane!.pane_id)
    if (histEntry) {
      histEntry.autoName = autoName
      spawnHistory.value = [...spawnHistory.value] // trigger save
    }
  }
  if (Array.isArray(d.cli_agent_order) || Array.isArray(d.cli_agent_disabled)) {
    applyingRemoteCliPrefs.value = true
    if (Array.isArray(d.cli_agent_order)) cliAgentOrder.value = d.cli_agent_order
    if (Array.isArray(d.cli_agent_disabled)) cliAgentDisabled.value = d.cli_agent_disabled
    void nextTick(() => { applyingRemoteCliPrefs.value = false })
  }
  if (Array.isArray(d.spawn_history)) {
    // Apply the peer window's persisted workspace history without echoing it
    // straight back through our deep watcher.
    spawnHistoryHydrated = false
    spawnHistoryWorkspace = ws
    spawnHistory.value = parseSpawnHistory(JSON.stringify(d.spawn_history), spawnHistoryWorkspaceIdentity(ws))
    void nextTick(() => { spawnHistoryHydrated = true })
  }
  if (!Array.isArray(d.run_groups)) return
  // Union merge instead of wholesale adoption: keep local groups that live
  // panes still reference but the remote list lacks (e.g. a tab recreated
  // mid-restore by ensureSavedGroup racing another window's save) — dropping
  // them would leave those panes assigned to a tab that no longer exists.
  // The union is persisted below so both windows converge on it.
  const incomingIds = new Set(d.run_groups.map((g) => g.id))
  const referenced = new Set(panes.value.map((p) => p.runGroupId).filter(Boolean))
  const missing = runGroups.value.filter((g) => !incomingIds.has(g.id) && referenced.has(g.id))
  const merged = missing.length ? [...d.run_groups, ...missing] : d.run_groups
  applyingRemote.value = true
  // The guard above already pinned this to the viewed workspace, and the
  // merged list is now what this window holds for it.
  runGroupsOwner.value = ws
  runGroups.value = merged
  // applyingRemote suppresses _saveRunGroups below, and with it the mirror.
  _cacheRunGroups(ws, merged)
  activeTab.value = resolveActiveTab(merged, activeTab.value)
  currentRunGroupId.value = merged[merged.length - 1]?.id ?? ''
  void nextTick(() => {
    applyingRemote.value = false
    if (missing.length) _saveRunGroups()
  })
}

let _offUiStateChanged: (() => void) | null = null
onMounted(() => { _offUiStateChanged = backend.on('project.ui_state_changed', onRunGroupsRemoteSync) })
onUnmounted(() => { _offUiStateChanged?.(); _offUiStateChanged = null })

// ── Detached run-group windows (main-window side) ────────────────────────────
/** Drag-out gesture from the tab bar → ask main to open the group in its own
 *  window. The resulting group:detached broadcast (which reaches this window too)
 *  drives handleGroupDetached, so the hand-off has a single source of truth. */
function onDetachGroup(groupId: string, x: number, y: number): void {
  if (isDetachedWindow || !groupId || groupId === 'manual') return
  const path = currentWorkspace.value
  if (!path) return
  const bounds = { x: Math.round(x), y: Math.round(y), width: 900, height: 700 }
  void window.agentTeam?.detachGroup?.({ groupId, workspacePath: path, bounds })
}

/** Merge this detached window's group back into the window it came from.
 *
 *  Main closes this window, which runs the same 'closed' path a manual close
 *  already used — so reattach has one implementation whichever way it starts.
 *  The PTYs stay alive in the backend either way; the origin window restores
 *  the group when it receives group:reattached. */
function reattachThisWindow(): void {
  if (!isDetachedWindow) return
  void window.agentTeam?.reattachGroup?.({ groupId: detachedGroupId })
}

/** Hand a run group off to a detached child window: drop its panes from THIS
 *  window WITHOUT killing them — onScopeDispose keeps the backend PTYs alive so
 *  the child reattaches — and hide its tab. */
function handleGroupDetached(groupId: string): void {
  if (isDetachedWindow || !groupId) return
  const next = new Set(detachedGroupIds.value)
  next.add(groupId)
  detachedGroupIds.value = next
  for (const p of panes.value) {
    if ((p.runGroupId ?? '') === groupId) {
      delete paneRefs[p.id]
      // Keep the persisted name: the pane re-registers in the child window.
      unregisterPaneMessaging(p.id, { keepPersisted: true })
    }
  }
  panes.value = panes.value.filter((p) => (p.runGroupId ?? '') !== groupId)
  if (activeTab.value === groupId) {
    activeTab.value = resolveActiveTab(runGroups.value.filter((g) => !next.has(g.id)), '')
  }
  syncViews()
}

/** Take a run group back when its detached child window closes: reattach only
 *  that group's panes here (they resume against the PTYs the child released). */
async function handleGroupReattached(groupId: string): Promise<void> {
  if (isDetachedWindow || !groupId) return
  const path = currentWorkspace.value
  if (!path) return
  // Drop any of this group's panes still listed here BEFORE restoring, or the
  // restore adds a second copy of each and the list doubles on every cycle.
  //
  // They should not be here at all — the group is detached, so the child window
  // owns those panes — but a main window that launched while the group was
  // already detached restores them from the project record before it learns
  // which groups are detached. Removing them costs nothing when the list is
  // already clean, and it is the same non-killing removal the detach path uses:
  // the backend PTYs stay alive and the restore below reattaches to them.
  for (const p of panes.value) {
    if ((p.runGroupId ?? '') === groupId) {
      delete paneRefs[p.id]
      unregisterPaneMessaging(p.id, { keepPersisted: true })
    }
  }
  panes.value = panes.value.filter((p) => (p.runGroupId ?? '') !== groupId)

  const next = new Set(detachedGroupIds.value)
  next.delete(groupId)
  detachedGroupIds.value = next
  const resp = await sendQuiet<ProjectPayload>('project.peek', { workspace_path: path })
  if (resp) await restoreWorkspacePanes(resp, path, groupId)
}

onMounted(() => {
  if (isDetachedWindow) return // child windows don't coordinate hand-offs
  window.agentTeam?.onGroupDetached?.(handleGroupDetached)
  window.agentTeam?.onGroupReattached?.((gid) => void handleGroupReattached(gid))
  // A main window that (re)loaded while a child is already open must hide the
  // groups that are currently detached. Best-effort: no-op if the main process
  // doesn't yet know this window's workspace.
  detachedGroupsKnown = (window.agentTeam?.getDetachedGroups?.() ?? Promise.resolve([]))
    .then((ids) => {
      for (const gid of ids ?? []) handleGroupDetached(gid)
    })
    // Best-effort: a failed lookup must not stall restore for ever.
    .catch(() => {})
})

/** Fixed id for the always-present default tab. Using a constant id (rather than
 *  a timestamp) makes "預設" idempotent: it can exist at most once per workspace,
 *  so reloads/re-checks never spawn a duplicate. */
const DEFAULT_RUN_GROUP_ID = 'rg-default'

function _loadRunGroups(path: string, project: NonNullable<ProjectPayload['project']>): void {
  runGroupsOwner.value = path
  const legacyKey = `agentTeam.runGroups.${path}`
  const stored = project.ui_run_groups
  if (Array.isArray(stored)) {
    // project.json owns the records ([] = the user deleted every group — do
    // not recreate the default). A leftover legacy localStorage copy is stale
    // (its ack-gated migration already completed) — clear it.
    runGroups.value = stored
    try { localStorage.removeItem(legacyKey) } catch { /* ignore */ }
  } else {
    // Never persisted → one-time migration from the legacy localStorage key.
    // Open with exactly one default tab when nothing was stored at all, with a
    // fixed id → never duplicated. Each pipeline run still adds its own tab via
    // createRunGroup; the default acts as the catch-all / landing tab. If the
    // legacy key explicitly contains [], the user deleted the default RunGroup,
    // so do not recreate it.
    let legacyRaw: string | null = null
    try { legacyRaw = localStorage.getItem(legacyKey) } catch { legacyRaw = null }
    const parsed = parseLegacyRunGroups(legacyRaw)
    runGroups.value = parsed ?? [{ id: DEFAULT_RUN_GROUP_ID, name: '預設', createdAt: Date.now() }]
    if (!isDetachedWindow) {
      void sendQuiet<{ ok: boolean }>('project.set_ui_state', {
        workspace_path: path,
        run_groups: runGroups.value,
      }).then((ack) => {
        // Ack-gated delete: keep the legacy copy (retried next load) on failure.
        if (ack?.ok && legacyRaw !== null) {
          try { localStorage.removeItem(legacyKey) } catch { /* ignore */ }
        }
      })
    }
  }
  currentRunGroupId.value = runGroups.value[runGroups.value.length - 1]?.id ?? ''
  _cacheRunGroups(path, runGroups.value)
}

function createRunGroup(name?: string): RunGroup {
  const id = `rg-${Date.now()}`
  const group: RunGroup = {
    id,
    name: name ?? `Run ${runGroups.value.length + 1}`,
    createdAt: Date.now(),
  }
  runGroups.value = [...runGroups.value, group]
  currentRunGroupId.value = id
  activeTab.value = id
  _saveRunGroups()
  return group
}

function renameRunGroup(id: string, name: string): void {
  runGroups.value = runGroups.value.map((g) => (g.id === id ? { ...g, name } : g))
  _saveRunGroups()
}

function pipelineRunGroupName(pipelineId?: string): string {
  const id = pipelineId || pipelinesApi.activePipelineId.value
  const byId = pipelinesApi.pipelines.value.find((p) => p.id === id)?.name.trim()
  const active = pipelinesApi.activePipeline.value?.name.trim()
  return byId || active || 'Pipeline'
}

/** Persist a pane's run-group reassignment to project.json (survives restart). */
async function persistPaneRunGroup(pane: ActivePane, runGroupId: string): Promise<boolean> {
  const ws = pane.workspacePath || currentWorkspace.value
  if (!ws) return false
  const resp = await sendQuiet('pane.set_run_group', {
    workspace_path: ws,
    pane_id: pane.id,
    run_group_id: runGroupId,
  })
  if (resp !== null) {
    const histEntry = spawnHistory.value.find((e) => e.paneId === pane.id)
    if (histEntry) {
      histEntry.runGroupId = runGroupId
      spawnHistory.value = [...spawnHistory.value] // trigger save
    }
  }
  return resp !== null
}

/** Persist the current pane order to project.json (survives restart). */
async function persistPaneOrder(): Promise<void> {
  const ws = currentWorkspace.value
  if (!ws) return
  // This workspace's panes only. `panes` holds every workspace the window
  // runs, so sending all of them would file another project's pane ids under
  // this one — and leave that project's own order unwritten, since nothing
  // else writes it. Identical to sending them all when the window holds one
  // workspace.
  await sendQuiet('project.set_pane_order', {
    workspace_path: ws,
    pane_ids: panesInView.value.map((p) => p.id),
  })
}

/** Persist the run-group tab order to project.json (survives restart). */
async function persistTabOrder(): Promise<void> {
  const ws = currentWorkspace.value
  if (!ws) return
  await sendQuiet('project.set_tab_order', {
    workspace_path: ws,
    tab_order: runGroups.value.map((g) => g.id),
  })
}

/** Reorder run-group tabs (tab dragged onto another tab in the StageTabBar).
 *  The synthetic "manual" tab is not a RunGroup, so drops involving it are
 *  no-ops (reorderByIds finds no matching id). */
function reorderRunGroupTab(fromKey: string, toKey: string): void {
  if (!reorderByIds(runGroups.value, fromKey, toKey)) return
  _saveRunGroups()
  void persistTabOrder()
}

/** Put back a group record that this workspace's panes still point at.
 *
 *  A pane whose run_group_id matches no record is on no tab of its own, and
 *  the pane's id is the only surviving evidence of where it belonged. The
 *  earlier repair cleared that id instead — which reached the same "the pane
 *  is on a tab again" end state by destroying the grouping on the way, and
 *  did it to the whole workspace at once whenever a record went missing.
 *  Recovery afterwards was impossible: nothing else records the assignment.
 *
 *  So rebuild the record under the SAME id and leave every pane's id alone.
 *  Nothing here can lose data — worst case a group from another workspace's
 *  set gains a tab in this one, which the user can delete, whereas a cleared
 *  id is gone for good.
 */
function adoptOrphanRunGroups(path: string): void {
  const known = new Set(runGroups.value.map((g) => g.id))
  const orphans: string[] = []
  for (const pane of panes.value) {
    const gid = pane.runGroupId
    if (!gid || known.has(gid) || orphans.includes(gid)) continue
    if (normWs(pane.workspacePath) !== normWs(path)) continue
    orphans.push(gid)
  }
  if (!orphans.length) return
  const base = runGroups.value.length
  runGroups.value = [
    ...runGroups.value,
    ...orphans.map((id, i) => ({
      id,
      name: `Run ${base + i + 1}`,
      createdAt: runGroupCreatedAt(id),
    })),
  ]
  _saveRunGroups()
  syncViews()
}

/** Move a pane — and the rest of its multi-selection, if it is part of one —
 *  into another tab (drag-and-drop target). The "manual" tab maps to an empty
 *  run group (ungrouped). Panes already in the target group are skipped, so a
 *  batch spanning several tabs only writes the ones that actually move. */
async function movePaneToGroup(paneId: string, targetKey: string): Promise<void> {
  const targetGroupId = targetKey === 'manual' ? '' : targetKey
  for (const id of paneDragBatch(paneId)) {
    const pane = panes.value.find((p) => p.id === id)
    if (!pane || (pane.runGroupId ?? '') === targetGroupId) continue
    const previous = pane.runGroupId
    pane.runGroupId = targetGroupId || undefined
    // Put it back when the write did not land. Showing the pane under the tab
    // it was dropped on while the record still names the old one is a move
    // that did not happen, and the next restore takes it back without a word.
    if (!(await persistPaneRunGroup(pane, targetGroupId))) pane.runGroupId = previous
  }
}

/** Delete a RunGroup tab.
 *
 *  Important: "手動" is not a persisted RunGroup. It is a synthetic tab for
 *  panes whose runGroupId is empty. Therefore deleting the last real RunGroup is
 *  valid when there is, or will be, a manual/ungrouped tab to show those panes.
 */
async function closeRunGroup(id: string): Promise<void> {
  const affected = id === 'manual'
    ? panes.value.filter((p) => !p.runGroupId)
    : panes.value.filter((p) => p.runGroupId === id)
  for (const p of [...affected]) await onKill(p.id)
  if (id !== 'manual') {
    runGroups.value = runGroups.value.filter((g) => g.id !== id)
    if (currentRunGroupId.value === id) currentRunGroupId.value = ''
    if (activeTab.value === id) activeTab.value = runGroups.value[0]?.id ?? 'manual'
    _saveRunGroups()
  }
}

async function deleteRunGroup(id: string): Promise<void> {
  // Persist pane reassignments BEFORE mutating local state or saving the
  // group list, and abort when any write fails: deleting the tab while a
  // pane still references it on disk would resurrect the tab on the next
  // restore (ensureSavedGroup) — or orphan the pane.
  // 刪除「手動」tab：把未指派 pane 移到第一個 stage group
  if (id === 'manual') {
    if (stageTabs.value.length <= 1) return  // only the manual tab left — nothing to do
    const target = runGroups.value[0]
    if (!target) return
    const affected = panes.value.filter((p) => !p.runGroupId)
    const saved = await Promise.all(affected.map((p) => persistPaneRunGroup(p, target.id)))
    if (!saved.every(Boolean)) {
      pipelineLog(`✕ delete tab aborted — pane reassignment did not persist`)
      return
    }
    affected.forEach((p) => { p.runGroupId = target.id })
    if (activeTab.value === 'manual') activeTab.value = target.id
    return
  }
  const target = runGroups.value.find((g) => g.id !== id)
  const affected = panes.value.filter((p) => p.runGroupId === id)

  if (!target) {
    const saved = await Promise.all(affected.map((p) => persistPaneRunGroup(p, '')))
    if (!saved.every(Boolean)) {
      pipelineLog(`✕ delete tab aborted — pane reassignment did not persist`)
      return
    }
    affected.forEach((p) => { p.runGroupId = undefined })
    runGroups.value = runGroups.value.filter((g) => g.id !== id)
    if (currentRunGroupId.value === id) currentRunGroupId.value = ''
    if (activeTab.value === id) activeTab.value = 'manual'
    _saveRunGroups()
    return
  }

  const saved = await Promise.all(affected.map((p) => persistPaneRunGroup(p, target.id)))
  if (!saved.every(Boolean)) {
    pipelineLog(`✕ delete tab aborted — pane reassignment did not persist`)
    return
  }
  affected.forEach((p) => { p.runGroupId = target.id })
  runGroups.value = runGroups.value.filter((g) => g.id !== id)
  if (currentRunGroupId.value === id) currentRunGroupId.value = target.id
  if (activeTab.value === id) activeTab.value = target.id
  _saveRunGroups()
}

/** A tab's structure, without the status dot: the pane ids are carried so the
 *  dot can be rolled up in a second, cheaper computed.
 *
 *  The split is deliberate. Tab STRUCTURE changes only when panes or run groups
 *  change; the status dot changes every 400 ms with paneViews. Consumers that
 *  drive layout — tabFilteredPaneIds and everything downstream of it — depend on
 *  the structure alone, so a ticking status never re-runs pane filtering or grid
 *  sizing. Merging the two would make a quiet window recompute its whole grid
 *  2.5 times a second. */
type StageTabShape = Omit<TabItem, 'status'> & { paneIds: string[] }

/** The panes of the workspace currently on screen.
 *
 *  STRUCTURE LAYER — ids and paths only, never paneViews, so the 400ms status
 *  sync does not rebuild it. Both the tab shapes and the grid filter read this:
 *  counting a pane on a tab that will not show it is worse than either alone.
 *
 *  Only the OTHER adopted workspaces are held back. A pane whose workspace is
 *  in neither list — a manual resume can pull a session in from any folder —
 *  stays visible exactly as it did before workspaces were a layer. */
const panesInView = computed<readonly ActivePane[]>(() =>
  panesOfViewedWorkspace(panes.value, extraWorkspaces.value)
)

const stageTabShapes = computed<StageTabShape[]>(() =>
  // Structure, not stageTabs: no live status is read, so a status dot ticking
  // does not rebuild the strip.
  buildStageTabs({
    panes: panesInView.value,
    groups: runGroups.value,
    isDetached: isDetachedWindow,
    detachedGroupId,
    detachedGroupIds: detachedGroupIds.value,
    // Was hard-coded, so an English UI showed a Chinese tab. The key has
    // existed all along.
    manualLabel: i18n.global.t('label.manual'),
    orphanLabel: i18n.global.t('label.orphan-group'),
  })
)

// Previous stageTabs result, returned unchanged when a status tick produced an
// identical tab bar. See sameRenderedTabs.
let _lastStageTabs: TabItem[] = []

const stageTabs = computed<TabItem[]>(() => {
  // Status is read the way the agent overview reads it: paneViews (a 400 ms
  // snapshot of each pane's live displayStatus) with disconnectedPaneIds
  // winning over it, because a pane whose backend session is gone can still be
  // sitting on a stale 'running'.
  const disconnected = new Set(disconnectedPaneIds.value)
  const statusById = new Map(paneViews.value.map((v) => [v.id, v.status as string]))
  const realizedById = new Map(panes.value.map((p) => [p.id, p.realized]))
  const next = stageTabShapes.value.map(({ paneIds, ...tab }) => ({
    ...tab,
    status: rollupTabStatus(
      paneIds.map((id) =>
        disconnected.has(id)
          ? 'disconnected'
          : (statusById.get(id) ?? (realizedById.get(id) ? 'starting' : 'waiting'))
      )
    )
  }))
  if (sameRenderedTabs(_lastStageTabs, next)) return _lastStageTabs
  _lastStageTabs = next
  return next
})

const tabFilteredPaneIds = computed<Set<string>>(() =>
  // Structure, not stageTabs: this drives pane visibility and grid sizing, and
  // must not re-run when a status dot ticks.
  panesOfActiveTab(panesInView.value, {
    hasTabs: stageTabShapes.value.length > 0,
    activeTab: activeTab.value,
    groupIds: runGroups.value.map((g) => g.id),
  })
)

// Panes visible under both tab filter and minimize filter — drives grid sizing
const tabVisiblePanes = computed(() =>
  panes.value.filter((p) => tabFilteredPaneIds.value.has(p.id) && !minimizedPanes.value.has(p.id))
)

async function onUserSelectTab(tabId: string): Promise<void> {
  activeTab.value = tabId
  await nextTick()
  const visible = tabVisiblePanes.value
  const target = visible.find((p) => p.id === focusPaneId.value)?.id ?? visible[0]?.id
  if (target) selectPane(target, { userInitiated: false })
  await nextTick()
  void advanceRestoreSession('tab')
}

// Persist activeTab to project.json keyed by workspace path
watch(activeTab, (v) => {
  // Detached child windows never own the shared activeTab state; a
  // remote-applied runGroups change must not echo its tab fallback back.
  if (!isDetachedWindow && !applyingRemote.value && v && currentWorkspace.value) {
    void sendQuiet('project.set_ui_state', {
      workspace_path: currentWorkspace.value,
      active_tab: v,
    })
  }
  // Keep currentRunGroupId in sync with the active tab so that "+ Add to grid"
  // always spawns into whichever tab the user is currently viewing.
  if (v && v !== 'manual' && runGroups.value.some((g) => g.id === v)) {
    currentRunGroupId.value = v
  }
})

function minimizePane(id: string): void {
  minimizedPanes.value = new Set([...minimizedPanes.value, id])
  if (focusPaneId.value === id) {
    const fallback = panes.value.find((p) => p.id !== id && !minimizedPanes.value.has(p.id))?.id ?? null
    selectPane(fallback, { userInitiated: false })
  }
  persistPaneMinimized(id, true)
  syncViews()
}

function restorePane(id: string): void {
  const next = new Set(minimizedPanes.value)
  next.delete(id)
  minimizedPanes.value = next
  if (layoutMode.value !== 'grid') selectPane(id, { userInitiated: true })
  else void realizeRestoredPane(id)
  persistPaneMinimized(id, false)
  syncViews()
}

/** The panes a drag started on `paneId` carries: the whole multi-selection when
 *  that pane belongs to one (same rule as the context menu's ctxTargetIds), the
 *  single pane otherwise. Ordered by `panes.value` so a batch keeps its relative
 *  arrangement wherever it lands. */
function paneDragBatch(paneId: string): string[] {
  return resolveDragBatch(paneId, selectedPaneIds.value, panes.value.map((p) => p.id))
}

/** Drag-reorder: move the pane `fromId` — and the rest of its multi-selection,
 *  if it is part of one — to the slot currently occupied by `toId`.
 *  `panes.value` is the single source of truth for pane order, so the Grid and
 *  the Active Agents list both update from this one splice. No-op for identical
 *  or unknown ids, or when the target is itself part of the dragged batch; the
 *  new order is persisted only when it changed. */
function reorderPane(fromId: string, toId: string): void {
  if (!reorderBatchByIds(panes.value, paneDragBatch(fromId), toId)) return
  syncViews() // reflect the new order in the Active Agents list immediately
  void persistPaneOrder()
}

// The non-grid layouts render lightweight representations of panes outside
// TerminalPane (Auto meeting cards, Spotlight thumbnails, Fullscreen PiP rows).
// Give all three the same drag contract as a TerminalPane header so they can
// reorder each other and still be dropped onto tabs, terminals, or AI Chat.
const {
  dragOverPaneId: auxiliaryDragOverPaneId,
  draggingBatchIds: auxiliaryDraggingBatchIds,
  onDragStart: onAuxiliaryPaneDragStart,
  onDragEnd: onAuxiliaryPaneDragEnd,
  onDragOver: onAuxiliaryPaneDragOver,
  onDragLeave: onAuxiliaryPaneDragLeave,
  onDrop: onAuxiliaryPaneDrop,
} = usePaneReorderDrag({
  payloadFor(paneId) {
    const pane = panes.value.find((p) => p.id === paneId)
    if (!pane) return null
    return {
      paneId: pane.id,
      agentKey: pane.agentKey,
      label: pane.customName || pane.autoName || pane.agentLabel,
      sessionId: pane.pinnedSessionId || null,
      sessionHomeId: pane.sessionHomeId,
      workspacePath: pane.workspacePath,
      conversationLogPath: pane.outputLogFile,
    }
  },
  batchFor: paneDragBatch,
  reorder: reorderPane,
  handOff: (paneId, screenX, screenY) => {
    window.agentTeam?.cliPaneDragEnd?.(paneId, screenX, screenY, paneDragBatch(paneId))
  },
})

/** One row of the lineage tree: which pane, how deep, and whether it folds.
 *
 *  STRUCTURE LAYER — deliberately derived from `panes` (id / spawnedBy /
 *  collapsed only), never from `paneViews`. syncViews() rebuilds paneViews
 *  every 400ms, so a structure computed reading it would rebuild the whole
 *  tree at that rate; status and badges stay in paneViews and are looked up
 *  per row by the consumer. Same split as StageTabBar's structure/status
 *  computeds, and for the same reason. */
/** Home directory, for shortening the paths shown under each workspace name.
 *  Fetched once; an empty value just means paths render in full. */
const homeDir = ref('')
onMounted(async () => {
  try {
    homeDir.value = (await window.agentTeam?.getHomeDir?.()) || ''
  } catch { /* paths stay absolute */ }
})

const paneLineage = computed<PaneLineageRow[]>(() =>
  buildPaneLineage(panes.value, collapsedPanes.value)
)

/** Workspaces that have been folded shut in the sidebar. Per window and not
 *  persisted: which projects you want out of the way is a property of the view
 *  you are looking at, not of the project. */
const collapsedWorkspaces = ref<Set<string>>(new Set())

const EXTRA_WS_KEY = 'agentTeam.extraWorkspaces'

/** Workspaces this window has taken on beyond the one it was opened with.
 *
 *  Picking one from the sidebar adds it here rather than opening a window for
 *  it: the sidebar is a list of projects, so "open" means "also show me that
 *  one". Panes can start in any of them — a pane carries its own
 *  workspacePath — while the IDE surfaces (git, explorer, plans, the terminal
 *  cwd) stay with currentWorkspace, which is this window's primary. */
/** Every workspace this window holds, in the order it took them on — the
 *  order the sidebar lists them in.
 *
 *  Which one is on screen is currentWorkspace and nothing more. Deriving the
 *  order from it instead (viewed one first) made the list reshuffle on every
 *  switch: two rows swapping places under the cursor, so the next click lands
 *  on the wrong project. */
const workspaceOrder = ref<string[]>(readExtraWorkspaces())

/** The ones that are not on screen. Everything that holds panes back or asks
 *  "is this ours?" reads this or workspaceOrder; nothing derives order. */
const extraWorkspaces = computed<string[]>(() =>
  workspaceOrder.value.filter((w) => normWs(w) !== normWs(currentWorkspace.value))
)

function readExtraWorkspaces(): string[] {
  try {
    const raw = sessionStorage.getItem(EXTRA_WS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

const normWs = (p: string): string => p.replace(/\/+$/, '')

/** Does this window run panes in that workspace? Its primary, or one it has
 *  adopted. Restore and the other per-workspace operations ask this rather
 *  than comparing against currentWorkspace alone. */
function isLocalWorkspace(path: string): boolean {
  if (!path) return false
  const target = normWs(path)
  return (
    target === normWs(currentWorkspace.value) ||
    workspaceOrder.value.some((w) => normWs(w) === target)
  )
}

// The workspace the window was opened with belongs in the list too, and it was
// there first — otherwise it sorts after everything adopted later, which reads
// as the sidebar putting the newcomer above the project you started in. A
// switch finds it already present and changes nothing.
watch(
  currentWorkspace,
  (ws) => {
    if (!ws || isDetachedWindow) return
    if (workspaceOrder.value.some((w) => normWs(w) === normWs(ws))) return
    workspaceOrder.value = [ws, ...workspaceOrder.value]
    persistExtraWorkspaces()
  },
  { immediate: true },
)

function adoptWorkspace(path: string): void {
  // A detached window is one run group's view of ONE workspace. Taking on
  // another would give it a workspace its own registry entry does not name,
  // and its report to main is suppressed, so nothing else would know.
  if (isDetachedWindow) return
  if (!path || isLocalWorkspace(path)) return
  workspaceOrder.value = [...workspaceOrder.value, path]
  persistExtraWorkspaces()
}

function persistExtraWorkspaces(): void {
  try {
    sessionStorage.setItem(EXTRA_WS_KEY, JSON.stringify(workspaceOrder.value))
  } catch {
    /* a lost list costs a re-pick, not work */
  }
  // Main answers "is this folder already open?" for every other window's
  // picker; without this it would only know about primaries and a second
  // window could open a folder this one is already running.
  if (!isDetachedWindow) window.agentTeam?.reportAdoptedWorkspaces?.([...workspaceOrder.value])
}

/** Load the run groups of held workspaces this window has not viewed.
 *
 *  Switching to a workspace loads its groups, so the store fills itself for
 *  everything the session has looked at. What it misses is what a restart or a
 *  reload brings back: those are held from the first frame but never viewed,
 *  and their panes would sit ungrouped in the sidebar until you switched to
 *  them once. Serial and best-effort — cold boot already contends for the
 *  backend's workers, and a workspace whose peek fails just keeps the flat
 *  listing it has now. */
async function prefetchHeldRunGroups(): Promise<void> {
  if (isDetachedWindow) return
  for (const path of [...workspaceOrder.value]) {
    if (!path || normWs(path) === normWs(currentWorkspace.value)) continue
    if (normWs(path) in runGroupsByWorkspace.value) continue
    const resp = await sendQuiet<ProjectPayload>('project.peek', { workspace_path: path })
    const stored = resp?.project?.ui_run_groups
    if (Array.isArray(stored)) _cacheRunGroups(path, stored)
  }
}

onMounted(() => {
  if (isDetachedWindow) return
  // Two ways this window can already hold workspaces before anyone clicks:
  //  · a reload — sessionStorage kept the list, but main has not heard it;
  //  · a relaunch — sessionStorage is empty and the registry has the list.
  // sessionStorage wins when both exist: it is this window's live state, while
  // the registry's copy is from before the restart.
  if (workspaceOrder.value.length) {
    window.agentTeam?.reportAdoptedWorkspaces?.([...workspaceOrder.value])
    void prefetchHeldRunGroups()
  } else {
    void (async () => {
      const restored = (await window.agentTeam?.takeRestoredAdoptedWorkspaces?.()) ?? []
      for (const path of restored) adoptWorkspace(path)
      // Their agents come back the same way a picked workspace's do.
      for (const path of extraWorkspaces.value) {
        const resp = await sendQuiet<ProjectPayload>('project.peek', { workspace_path: path })
        if (!resp) continue
        // The reply already carries the records, so grouping a restored
        // workspace's panes costs no extra round trip.
        const stored = resp.project?.ui_run_groups
        if (Array.isArray(stored)) _cacheRunGroups(path, stored)
        await restoreWorkspacePanes(resp, path)
      }
      // Anything the loop could not reach (a peek that timed out) gets one
      // more try; everything it did reach is already cached and skipped.
      await prefetchHeldRunGroups()
    })()
  }
})

/** The ＋ on the sidebar's Workspace heading: the Welcome picker, reopened
 *  over a window that already has a workspace. */
const workspacePickerOpen = ref(false)

/** Open a workspace picked from that picker — in THIS window's sidebar.
 *
 *  A workspace already open in another window is focused there instead: two
 *  windows on one folder would run two sets of PTY and git operations on it,
 *  and its panes live in the window that owns them. */
async function openWorkspaceFromPicker(path: string): Promise<void> {
  workspacePickerOpen.value = false
  if (!path) return
  // Already one of ours: picking it from the list means "show me that one",
  // which is the same thing clicking its heading does.
  if (isLocalWorkspace(path)) {
    await switchToWorkspace(path)
    return
  }
  if (await window.agentTeam?.focusWorkspaceWindow?.(path)) return
  adoptWorkspace(path)
  // And look at it. Picking a project from a list that says "Open Workspace"
  // means "show me that one" — adding a row to the sidebar and leaving the
  // window on the previous project reads as nothing having happened. The
  // switch also loads it, which brings its persisted agents back: a project
  // with work in it must not come up empty.
  await switchToWorkspace(path)
}

/** Look at another of this window's workspaces.
 *
 *  The one being left stays in the window — its agents keep running and its
 *  heading stays in the sidebar — so this is a change of view, not a close.
 *  Everything that follows currentWorkspace (the tab row, the grid, git,
 *  explorer, plans, the terminal cwd) moves with it. */
/** Bring the workspace that owns `paneId` on screen, if this window holds it.
 *
 *  Returns false only when a switch was needed and did not happen, so callers
 *  stop instead of focusing a pane the grid filters out — sidebar and
 *  spotlight render the focused pane and nothing else, so that draws an empty
 *  main area next to a full agent list.
 *
 *  Four places jump to a pane by id (the sidebar list, the status-bar
 *  overview, the history modal, a message notification) and every one of them
 *  can name a pane in a workspace that is not on screen. */
async function ensurePaneWorkspaceOnScreen(paneId: string): Promise<boolean> {
  const target = panes.value.find((p) => p.id === paneId)?.workspacePath ?? ''
  if (!target || !isLocalWorkspace(target)) return true
  if (normWs(target) === normWs(currentWorkspace.value)) return true
  await switchToWorkspace(target)
  return normWs(currentWorkspace.value) === normWs(target)
}

/** True while a switch is in flight, with the name being entered.
 *
 *  Drives the stage's cover: see switchToWorkspace for why the area would
 *  otherwise sit blank rather than empty. */
const switchingWorkspace = ref(false)
const switchingWorkspaceName = ref('')
/** Which switch owns the cover. The sidebar stays clickable while one runs —
 *  the cover is over the stage, not the list — so a second workspace can be
 *  picked mid-switch. Without this the first run to finish uncovers a stage
 *  the second is still rebuilding, and the blank it was added to fill is back. */
let switchCoverSeq = 0
/** How long a switch may run before the cover appears.
 *
 *  A switch with nothing to restore is a project.peek round trip and a tick.
 *  Showing a spinner for that — and then fading it out — is a flash, which
 *  reads as a glitch rather than as loading. Past this the stage would
 *  otherwise sit blank, which is what the cover is for. */
const SWITCH_COVER_DELAY_MS = 180

async function switchToWorkspace(path: string): Promise<void> {
  if (isDetachedWindow) return // see adoptWorkspace
  if (!path || normWs(path) === normWs(currentWorkspace.value)) return
  if (!isLocalWorkspace(path)) return
  // Panes survive a switch; a pipeline cannot. `pipeline` is one per window,
  // so entering another project overwrites the state tracking this one's run
  // and onWorkspaceBrowse aborts it rather than lose track of it. That is the
  // right call, but it must not happen silently — everything else about a
  // switch keeps running, so nobody would expect this one thing to stop.
  if (pipeline.state === 'running') {
    const ok = await notifyRestore.confirm(i18n.global.t('switchWorkspace.confirm'), {
      title: i18n.global.t('switchWorkspace.confirmTitle'),
      confirmText: i18n.global.t('switchWorkspace.confirmBtn'),
      cancelText: i18n.global.t('restore.dismiss'),
    })
    if (!ok) return
  }
  // The window holds the same set either way — only which one is on screen
  // changes — so the list is untouched and the sidebar does not reshuffle.
  // Both are already in it: the one being left through the watch above, the
  // one being entered through adoptWorkspace.
  // Cover the stage for the rest of this. Everything below is awaited, and the
  // panes on screen belong to the workspace being left — a switch filters them
  // out rather than tearing them down — so without this the area goes blank
  // and stays blank while the entered workspace's panes are restored, one CLI
  // probe each. Blank reads as "the click did nothing".
  const coverSeq = ++switchCoverSeq
  switchingWorkspaceName.value = path.split('/').filter(Boolean).pop() ?? path
  const coverTimer = setTimeout(() => {
    if (coverSeq === switchCoverSeq) switchingWorkspace.value = true
  }, SWITCH_COVER_DELAY_MS)
  try {
    await onWorkspaceBrowse(path, { keepPanes: true })
    // onWorkspaceBrowse has its own reasons to decline — chiefly finding the
    // workspace open in some other window — and it declines by returning, which
    // from here is indistinguishable from having worked. A switch that quietly
    // does nothing is the worst outcome: the sidebar still says one thing and
    // the screen another. Undo the list swap and say so.
    if (normWs(currentWorkspace.value) !== normWs(path)) {
      notifyRestore.toast(
        i18n.global.t('switchWorkspace.failed', {
          name: path.split('/').filter(Boolean).pop() ?? path,
        }),
        { type: 'error' },
      )
      return
    }
    // Load the entered workspace NOW. ControlPane reaches onWorkspaceCheck
    // through a 400ms debounce on its workspace field — right for someone typing
    // a path, wrong for a click: for those 400ms the window pairs the new
    // workspace with the old run groups, so every tab filter misses and the list
    // and grid blink empty on the way through. The debounced call still arrives
    // and is a no-op by then.
    await onWorkspaceCheck(path)
    // The focused pane is very likely one this window just stopped showing. In
    // grid mode that is harmless, but sidebar and spotlight render the focused
    // pane and nothing else, so they would come up blank. Same landing as
    // onUserSelectTab: keep the focus if it survived the filter, else take the
    // first pane that did.
    await nextTick()
    const visible = tabVisiblePanes.value
    if (!visible.some((p) => p.id === focusPaneId.value)) {
      const first = visible[0]?.id
      if (first) selectPane(first, { userInitiated: false })
    }
  } finally {
    // finally, not after the last await: every path out of here — the decline
    // above, a throw from restore — must uncover the stage, or the window is
    // left showing a spinner over panes that are already there.
    //
    // Only if this is still the newest switch: an older one finishing must not
    // uncover a stage a newer one is still rebuilding. Clearing the timer is
    // unconditional though — an older switch's pending timer must never raise
    // the cover after that switch is over.
    clearTimeout(coverTimer)
    if (coverSeq === switchCoverSeq) switchingWorkspace.value = false
  }
}

/** Take a workspace back out of this window.
 *
 *  Its panes go with it — they were started in it and belong to it, and
 *  leaving them behind would put panes in the list with no heading to sit
 *  under. Any workspace this window holds, including the one on screen: what
 *  a window is opened with stops mattering once it holds several, and being
 *  unable to close the project you are looking at only leaves you switching
 *  away first to do the same thing. The one thing it needs is somewhere to
 *  land — see below. */
async function closeWorkspace(path: string): Promise<void> {
  if (!path) return
  if (!workspaceOrder.value.some((w) => normWs(w) === normWs(path))) return
  // Closing the one on screen means landing somewhere first. Switching before
  // letting go — rather than after — is what puts the panes and the focus
  // somewhere valid: switchToWorkspace already keeps the focused pane if it
  // survives the filter and otherwise takes the first that did, which is the
  // next project's first CLI. It can also decline (the target turned out to be
  // open in another window), and then nothing is closed, rather than leaving
  // this window on a project it no longer holds.
  if (normWs(path) === normWs(currentWorkspace.value)) {
    const land = workspaceOrder.value.find((w) => normWs(w) !== normWs(path))
    // Nothing to land on. Going back to the Welcome picker is the titlebar's
    // ↺ button — a different thing to want, and it asks first.
    if (!land) return
    await switchToWorkspace(land)
    if (normWs(currentWorkspace.value) !== normWs(land)) return
  }
  const doomed = panes.value.filter((p) => normWs(p.workspacePath) === normWs(path))
  for (const pane of doomed) await onKill(pane.id)
  workspaceOrder.value = workspaceOrder.value.filter((w) => normWs(w) !== normWs(path))
  persistExtraWorkspaces()
  _forgetRunGroups(path)
  const next = new Set(collapsedWorkspaces.value)
  next.delete(path)
  collapsedWorkspaces.value = next
}

/** Drag one workspace heading onto another → put it there in the list.
 *
 *  The order is the order the window took each workspace on, which is a fact
 *  about history rather than a preference — this is what makes it a preference.
 *  Persisted with the list itself, so a reload keeps it; per window, because
 *  which project you want at the top is a property of the window you are
 *  looking at, the same way the sidebar's collapse state is. */
function reorderWorkspace(fromPath: string, toPath: string): void {
  if (isDetachedWindow) return
  const next = [...workspaceOrder.value]
  if (!reorderStrings(next, fromPath, toPath)) return
  workspaceOrder.value = next
  persistExtraWorkspaces()
}

/** Drag a workspace heading out of the window → give it its own window.
 *
 *  The inverse of adopting one, and deliberately not closeWorkspace: that kills
 *  the panes because closing says the user is finished with them, while this
 *  hands them over. Panes are keyed by workspace in the backend and belong to
 *  it rather than to a window, so dropping the workspace here and opening a
 *  window on it lets the ordinary restore pick the same panes up — nothing is
 *  killed and no PTY restarts.
 */
async function detachWorkspace(path: string, x: number, y: number): Promise<void> {
  if (isDetachedWindow || !path) return
  // Pulling out the only workspace would empty this window to fill a new one.
  if (workspaceOrder.value.length < 2) return
  // Detaching the one on screen would leave this window viewing a workspace it
  // no longer holds, so step off it first — onto one it keeps.
  if (normWs(path) === normWs(currentWorkspace.value)) {
    const fallback = workspaceOrder.value.find((w) => normWs(w) !== normWs(path))
    if (!fallback) return
    await switchToWorkspace(fallback)
    if (normWs(currentWorkspace.value) === normWs(path)) return
  }
  workspaceOrder.value = workspaceOrder.value.filter((w) => normWs(w) !== normWs(path))
  _forgetRunGroups(path)
  const next = new Set(collapsedWorkspaces.value)
  next.delete(path)
  collapsedWorkspaces.value = next
  // Also reports the shortened adopted list to main, which is how the new
  // window avoids being answered with a focus of this one.
  persistExtraWorkspaces()
  const bounds = { x: Math.round(x), y: Math.round(y), width: 1200, height: 800 }
  await window.agentTeam?.detachWorkspace?.({ workspacePath: path, bounds })
}

/** Reveal a workspace's folder — the titlebar button that used to do this is
 *  gone, and a project row is where it belongs anyway. */
function revealWorkspaceFolder(path: string): void {
  if (path) void window.agentTeam?.openPath?.(path)
}

function toggleWorkspaceCollapsed(path: string): void {
  const next = new Set(collapsedWorkspaces.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsedWorkspaces.value = next
}

/** The sidebar's outer layer: one row per workspace, this window's first.
 *
 *  STRUCTURE LAYER, like paneLineage — it reads ids, paths and the roster, not
 *  paneViews, so the 400ms status sync does not rebuild it. The list renders
 *  these rows and looks each pane's status up separately.
 *
 *  Every row is a workspace this window holds, carrying lineage rows: it owns
 *  those terminals and knows everything about them. What other windows are
 *  running is theirs to show — a window is its own space. */
interface WorkspaceGroupRow {
  path: string
  label: string
  displayPath: string
  isCurrent: boolean
  collapsed: boolean
  count: number
  lineage: PaneLineageRow[]
  groups: { id: string; name: string; rows: PaneLineageRow[] }[]
}

const workspaceGroups = computed<WorkspaceGroupRow[]>(() =>
  buildWorkspaceGroups({
    here: currentWorkspace.value,
    order: workspaceOrder.value,
    panes: panes.value,
    lineage: paneLineage.value,
    runGroups: runGroups.value,
    runGroupsByWorkspace: runGroupsByWorkspace.value,
    collapsed: collapsedWorkspaces.value,
    homeDir: homeDir.value,
  })
)

function togglePaneCollapsed(id: string): void {
  const next = new Set(collapsedPanes.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedPanes.value = next
  const pane = panes.value.find((p) => p.id === id)
  if (pane) {
    backend.send('project.set_pane_collapsed', {
      workspace_path: pane.workspacePath,
      pane_id: id,
      collapsed: next.has(id),
    })
  }
  syncViews()
}

// Persist the pane's collapsed-to-sidebar state to project.json so it survives
// a restart (mirrors project.rename_pane / custom_name).
function persistPaneMinimized(id: string, isMinimized: boolean): void {
  const pane = panes.value.find((p) => p.id === id)
  if (!pane) return
  backend.send('project.set_pane_minimized', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    is_minimized: isMinimized,
  })
}

function persistPaneStopped(id: string, stopped: boolean): void {
  const pane = panes.value.find((p) => p.id === id)
  if (!pane) return
  backend.send('project.set_pane_stopped', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    stopped,
  })
}

// Keep focusPaneId valid as panes are added/removed
watch(panes, (newPanes, oldPanes) => {
  const ids = new Set(newPanes.map((p) => p.id))
  if (focusPaneId.value && !ids.has(focusPaneId.value)) {
    selectPane(newPanes[0]?.id ?? null, { userInitiated: false })
  }
  // Drop selected ids for panes that were removed or had their id replaced by a
  // rebuild, so batch actions never reference stale panes.
  if (selectedPaneIds.value.size > 0) {
    const pruned = new Set([...selectedPaneIds.value].filter((id) => ids.has(id)))
    if (pruned.size !== selectedPaneIds.value.size) selectedPaneIds.value = pruned
  }
  if (lastClickPaneId.value && !ids.has(lastClickPaneId.value)) lastClickPaneId.value = null
  if (layoutMode.value !== 'grid' && newPanes.length > (oldPanes?.length ?? 0)) {
    selectPane(newPanes[newPanes.length - 1].id, { userInitiated: false })
  }
  // If the current tab's run group was removed, fall back to first available group
  if (activeTab.value && stageTabs.value.length > 0) {
    const tabStillExists = stageTabs.value.some((t) => t.key === activeTab.value)
    if (!tabStillExists) activeTab.value = stageTabs.value[0]?.key ?? ''
  }
})

// When switching tabs, ensure focusPaneId is within the new tab's visible panes
watch(activeTab, () => {
  const visible = tabVisiblePanes.value
  if (focusPaneId.value && !visible.some((p) => p.id === focusPaneId.value)) {
    selectPane(visible[0]?.id ?? null, { userInitiated: false })
  }
  void nextTick(() => refitAllTerminals())
})

function onSetFocus(paneId: string, ev?: MouseEvent, orderedIds?: string[]): void {
  // Shift-click selects the range between the anchor and this pane (same
  // semantics as GitPane's file rows); Cmd/Ctrl-click toggles the pane in the
  // multi-select set instead of replacing focus, so the right-click menu can
  // act on the whole batch. orderedIds is the clicked surface's render order —
  // a range must never sweep in panes that surface does not show.
  if (ev && ev.shiftKey) {
    rangeSelectPanes(paneId, orderedIds)
    revealPaneTab(paneId)
    // Adding a pane to a batch selection is not "open this pane" — a modifier
    // click must never spawn the CLI behind a cold-restore placeholder.
    selectPane(paneId, { userInitiated: false })
    return
  }
  if (ev && (ev.metaKey || ev.ctrlKey)) {
    const next = new Set(selectedPaneIds.value)
    // Seed with the pane the user was already focused on, so the first
    // modifier-click extends from the current single selection.
    if (next.size === 0 && focusPaneId.value && focusPaneId.value !== paneId) {
      next.add(focusPaneId.value)
    }
    if (next.has(paneId)) next.delete(paneId)
    else next.add(paneId)
    selectedPaneIds.value = next
    lastClickPaneId.value = paneId
    revealPaneTab(paneId)
    selectPane(paneId, { userInitiated: false })
    return
  }
  selectedPaneIds.value = new Set()
  lastClickPaneId.value = paneId
  revealPaneTab(paneId)
  selectPane(paneId, { userInitiated: true })
}

function rangeSelectPanes(toId: string, orderedIds?: string[]): void {
  const ordered = orderedIds ?? panes.value.map((p) => p.id)
  // No explicit anchor yet → extend from the focused pane, mirroring the
  // Cmd/Ctrl branch's seeding from the current single selection.
  const anchor = lastClickPaneId.value ?? focusPaneId.value
  selectedPaneIds.value = computeRangeSelection(ordered, anchor, toId)
}

// Sidebar agent-list clicks: a modifier click joins the same multi-select as
// the pane surfaces (ranging over the sidebar's full list order); a plain
// click keeps the original focus + scroll behavior.
/** The order the sidebar actually renders panes in: each workspace section in
 *  turn, each one's lineage flattened depth-first. Shift-range selection walks
 *  this, so it has to be what the eye sees — paneViews is the flat spawn order,
 *  which stopped matching the moment the list gained indentation, and stopped
 *  matching further once it gained workspace sections.
 *
 *  STRUCTURE LAYER: workspaceGroups and its lineages, never paneViews. */
const sidebarOrderedPaneIds = computed<string[]>(() =>
  flattenSidebarOrder(workspaceGroups.value)
)

async function onSidebarFocusPane(paneId: string, ev?: MouseEvent): Promise<void> {
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
    onSetFocus(paneId, ev, sidebarOrderedPaneIds.value)
    return
  }
  selectedPaneIds.value = new Set()
  lastClickPaneId.value = paneId
  // The sidebar lists every workspace this window holds, so a click can land
  // on a pane the grid is currently filtering out.
  if (!(await ensurePaneWorkspaceOnScreen(paneId))) return
  // The other two ways to jump to a pane — agent history and the resource
  // list — restore it first. Without this the sidebar sets focus on a pane the
  // stage filters out, and the focus resolver hands the screen to a different
  // one: the click appears to open somebody else. Minimized state persists, so
  // the inconsistency came back on every restart.
  if (minimizedPanes.value.has(paneId)) restorePane(paneId)
  onFocusPane(paneId)
}

// ── Resource popover + Resource Manager (status-bar CPU + memory) ───────────
// One list where there used to be two popovers: the agent overview answered
// "which panes exist and what are they doing", the memory panel answered "who
// is holding the machine". You ask both at the same moment — when the fan
// spins up — so they are one row now, and the status-bar pill carries the
// headline figures instead of a bare count.
//
// Status comes from paneViews, which syncViews refreshes every 400 ms from each
// pane's live displayStatus — the only app-wide readable copy of that per-pane
// state (displayStatus itself lives inside TerminalPane). A lost backend
// session is not visible there, so disconnectedPaneIds wins over it.
const showResourceManager = ref(false)
// Mount the modal only once it has been asked for, like the other heavy modals.
const resourceManagerEverOpened = ref(false)
/** Either surface being visible is what picks the fast sampling cadence. */
const resourcePanelOpen = computed(
  () => openPopover.value === 'resource' || showResourceManager.value
)

/** Panes with a live CLI. The pill counts these, not placeholders: a
 *  placeholder holds no process, so no CPU and no memory. */
const realizedPaneCount = computed(() => panes.value.filter((p) => p.realized).length)

const resourceUsage = useResourceUsage({
  request: () => sendQuiet<ResourceUsageWire>('terminal.resource_usage', {}),
  paneCount: realizedPaneCount,
  panelOpen: resourcePanelOpen,
})

const resourceRows = computed<ResourceSummaryRow[]>(() => {
  const statusById = new Map(paneViews.value.map((v) => [v.id, v.status]))
  const reclaimable = new Set(reclaimableNowIds.value)
  const bytesByKey = resourceUsage.bytesByKey.value
  const cpuByKey = resourceUsage.cpuPercentByKey.value
  const bytesByPane = resourceUsage.bytesByPaneId.value
  const cpuByPane = resourceUsage.cpuPercentByPaneId.value
  const paneIdByKey = resourceUsage.paneIdByKey.value
  return panes.value.map((p) => {
    const name = p.customName || p.autoName || p.agentLabel
    const vendor = agentSpecs.find((s) => s.agentKey === p.agentKey)?.label ?? p.agentKey
    // Keyed by terminal session first: that id is the one this window holds for
    // its own PTY, so it cannot drift the way a pane id can when a pane is
    // rebuilt around a new one. The pane-id index is the fallback for a pane
    // whose ref is not mounted at this moment — the session-keyed map never
    // holds a bare pane id, so looking one up there would always miss.
    const sessionKey = (paneRefs[p.id]?.sessionId as unknown as string) ?? ''
    const known = bytesByKey.has(sessionKey) || cpuByKey.has(sessionKey)
    return {
      paneId: p.id,
      // The id the measurement row itself carries, which after a rebuild is the
      // pane id the PTY was created under — not this pane's current one. The
      // Resource Manager needs it to know that row is already accounted for.
      measuredKey: (known ? paneIdByKey.get(sessionKey) : undefined) ?? p.id,
      name,
      // An unnamed pane's display name already IS the vendor label (agentLabel is
      // assigned spec.label at creation), so emitting both would print it twice
      // on the default path. Suppressed the same way foreignWorkspace is.
      vendor: vendor === name ? '' : vendor,
      status: disconnectedPaneIds.value.includes(p.id)
        ? 'disconnected'
        : (statusById.get(p.id) ?? (p.realized ? 'starting' : 'waiting')),
      // A manual resume can pull a session in from another folder, so a pane's
      // workspace is not always the window's. Shown only when it differs.
      foreignWorkspace:
        p.workspacePath && p.workspacePath !== currentWorkspace.value
          ? (p.workspacePath.split('/').filter(Boolean).pop() ?? p.workspacePath)
          : '',
      bytes: (known ? bytesByKey.get(sessionKey) : bytesByPane.get(p.id)) ?? 0,
      cpuPercent: (known ? cpuByKey.get(sessionKey) : cpuByPane.get(p.id)) ?? null,
      reclaimable: reclaimable.has(p.id),
    }
  })
})

// The backend measures every PTY it owns, which is every window's — the right
// scope for the Resource Manager, and the wrong one for a card that lists this
// window's panes. Totalled from the rows so the headline and the list agree.
const resourceTotals = computed(() => {
  let bytes = 0
  let cpu = 0
  let cpuKnown = false
  for (const row of resourceRows.value) {
    bytes += row.bytes
    if (row.cpuPercent !== null) {
      cpu += row.cpuPercent
      cpuKnown = true
    }
  }
  return { bytes, cpu: cpuKnown ? cpu : null }
})
const resourceCpuShare = computed(() =>
  machineCpuShare(resourceTotals.value.cpu, resourceUsage.cpuCount.value)
)
const resourceMemoryShare = computed(() =>
  machineMemoryShare(resourceTotals.value.bytes, resourceUsage.machineMemoryBytes.value)
)

/** The pill's own text: pane count, this machine's share of CPU, total memory.
 *  Each figure appears only once it is knowable — CPU needs two samples, and a
 *  sweep that failed shows nothing rather than a zero that reads as "idle". */
const resourcePillText = computed(() => {
  // The pane count, not the realized subset: idle reclaim downgrades panes to
  // placeholders rather than closing them, and a pill reading "▤ 0" beside a
  // panel listing thirteen panes is a contradiction. The resource figures below
  // still come only from the panes that actually hold a process.
  const parts = [`▤ ${panes.value.length}`]
  const share = resourceCpuShare.value
  if (share !== null && resourceUsage.cpuAvailable.value) parts.push(formatCpuPercent(share))
  if (resourceUsage.measured.value && resourceUsage.available.value && resourceTotals.value.bytes > 0) {
    parts.push(formatBytes(resourceTotals.value.bytes))
  }
  return parts.join(' · ')
})

/** The hover text keeps what the merged pill has no room for — how many panes
 *  "reclaim now" would take, which the old memory pill showed inline. */
const resourcePillTitle = computed(() => {
  const base = i18n.global.t('resource.statusbar-title')
  const count = reclaimableNowIds.value.length
  return count > 0
    ? `${base} · ${i18n.global.t('resource.reclaimable-hint', { count })}`
    : base
})

// The pill is hidden once the last pane exits, but the popover is not — without
// this it would stay mounted with a full-viewport backdrop swallowing every
// click on a status bar that no longer offers a way to dismiss it.
watch(
  () => panes.value.length,
  (count) => {
    if (count === 0 && openPopover.value === 'resource') closePopover()
  },
)

/** Jump from the panel to a pane. Mirrors the sidebar agent list's plain
 *  click: reveal the pane's tab, then select it as user-initiated so a
 *  cold-restore placeholder is realized instead of silently focusing nothing.
 *  A minimized pane is restored first — effectiveFocusPaneId skips minimized
 *  panes, so focusing one without restoring would show a different pane. */
function onResourceJump(paneId: string): void {
  closePopover()
  if (minimizedPanes.value.has(paneId)) restorePane(paneId)
  onSidebarFocusPane(paneId)
}

async function onResourceReclaim(): Promise<void> {
  const reclaimed = await reclaimPanesNow()
  // Re-measured rather than closed: the point of the panel is to show the
  // machine getting its resources back, and the rows that are left are the
  // answer to "what is still holding them".
  if (reclaimed > 0) void resourceUsage.refresh()
}

function openResourceManager(): void {
  closePopover()
  resourceManagerEverOpened.value = true
  showResourceManager.value = true
}

// Pane right-click context menu, shared by the agent list, spotlight thumbnails,
// and pane headers. The menu is rendered once in this component; each surface only
// raises an open request with the pane id and pointer coords.
const paneCtxMenu = ref<{ paneId: string; x: number; y: number } | null>(null)
const paneCtxMenuEl = ref<HTMLElement | null>(null)

const paneCtxView = computed<ActivePaneView | null>(() =>
  paneCtxMenu.value ? paneViews.value.find((v) => v.id === paneCtxMenu.value!.paneId) ?? null : null
)

// When the right-clicked pane is part of a multi-select of >1, the menu targets
// the whole (still-live) selection; otherwise it targets just that one pane.
const ctxTargetIds = computed<string[]>(() => {
  const m = paneCtxMenu.value
  if (!m) return []
  if (selectedPaneIds.value.has(m.paneId) && selectedPaneIds.value.size > 1) {
    return panes.value.map((p) => p.id).filter((id) => selectedPaneIds.value.has(id))
  }
  return [m.paneId]
})
const ctxIsBatch = computed(() => ctxTargetIds.value.length > 1)

function openPaneCtxMenu(e: MouseEvent, paneId: string): void {
  e.preventDefault()
  paneCtxMenu.value = { paneId, x: e.clientX, y: e.clientY }
  // Flip/clamp into the viewport once the menu has rendered, so items near the
  // bottom/right edge aren't clipped by the window.
  void nextTick(() => {
    const el = paneCtxMenuEl.value
    const m = paneCtxMenu.value
    if (!el || !m) return
    const r = el.getBoundingClientRect()
    const margin = 8
    if (m.y + r.height > window.innerHeight) {
      m.y = Math.max(margin, window.innerHeight - r.height - margin)
    }
    if (m.x + r.width > window.innerWidth) {
      m.x = Math.max(margin, window.innerWidth - r.width - margin)
    }
  })
}

function closePaneCtxMenu(): void {
  paneCtxMenu.value = null
}

// Rename dialog state. Opened from the context menu; on confirm it overrides the
// pane's display label and persists it to project.json via project.rename_pane.
const renamingPane = ref<{ paneId: string; value: string } | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)

function startRenamePane(paneId: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  renamingPane.value = { paneId, value: pane.customName || pane.autoName || pane.agentLabel }
  closePaneCtxMenu()
  void nextTick(() => { renameInput.value?.focus(); renameInput.value?.select() })
}

const inlineRenamingId = ref<string | null>(null)
const inlineRenameDraft = ref('')
// Autofocus + select the inline rename input the moment it mounts. Replaces a
// shared array template ref whose `.find()` could resolve to a stale (already
// unmounted) input on the second edit, leaving the real input unfocused so
// keystrokes were silently dropped ("rename works once, then does nothing").
const vFocus = {
  mounted(el: HTMLInputElement): void {
    el.focus()
    el.select()
  },
}

function startInlineRename(p: { id: string; customName?: string; autoName?: string; agentLabel?: string }): void {
  inlineRenameDraft.value = p.customName || p.autoName || p.agentLabel || ''
  inlineRenamingId.value = p.id
}

function commitInlineRename(): void {
  if (!inlineRenamingId.value) return
  setPaneCustomName(inlineRenamingId.value, inlineRenameDraft.value)
  inlineRenamingId.value = null
}

function onInlineRenameKeydown(e: KeyboardEvent): void {
  // Ignore the Enter/Escape an IME (e.g. Chinese) sends while composing —
  // that keystroke confirms candidate selection, not the rename.
  if (e.isComposing) return
  if (e.key === 'Enter') { e.preventDefault(); commitInlineRename() }
  if (e.key === 'Escape') { e.preventDefault(); inlineRenamingId.value = null }
}

// Applies a custom display name to a pane and persists it. Shared by the
// context-menu rename dialog and the inline (double-click) header edit.
async function setPaneCustomName(paneId: string, rawName: string): Promise<void> {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane) return
  const name = rawName.trim()
  const nextCustomName = name && name !== pane.agentLabel ? name : undefined
  // Keep the messaging handle in sync with the title — the name you see IS the
  // address CLIs use. A non-empty title that collides with another pane's
  // handle prompts for a unique name (cancel abandons the whole rename);
  // clearing the title reverts the handle to the auto-title or vendor label.
  if (pane.agentKey !== 'terminal') {
    if (nextCustomName) {
      const resolved = await resolveManualHandle(paneId, nextCustomName)
      if (resolved === null) return // cancelled → abandon (title unchanged too)
      const applied = messaging.setDerivedName(pane.id, resolved, pane.agentKey)
      if (applied) {
        pane.messagingName = applied
        persistMessagingName(pane.id, applied)
        mirrorMessagingHandle(pane)
      }
    } else {
      const reverted = messaging.setDerivedName(pane.id, pane.autoName || pane.agentLabel, pane.agentKey)
      if (reverted) {
        pane.messagingName = reverted
        persistMessagingName(pane.id, reverted)
        mirrorMessagingHandle(pane)
      }
    }
  }
  pane.customName = nextCustomName
  // Naming the pane — including clearing the name, and including typing the
  // vendor label itself (which resolves to no customName) — permanently opts it
  // out of auto-naming. Without this the auto-namer would take a pane back the
  // moment its custom name resolves to nothing.
  pane.nameLocked = true
  updateHistoryCustomName(spawnHistory.value, {
    paneId,
    agentKey: pane.agentKey,
    sessionId: pane.pinnedSessionId,
    sessionHomeId: pane.sessionHomeId,
  }, pane.customName)
  syncViews()
  // No workspace → the backend has no project.json to persist into and would
  // silently drop the rename; keep it as in-memory state only.
  if (!pane.workspacePath) return
  backend.send('project.rename_pane', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    custom_name: pane.customName ?? '',
  })
}

/** Whether the title a pane surface is showing is one the user never chose.
 *
 *  Derived from the pane rather than the rendered string, because the string
 *  can't tell you: messagingName leads the display chain and gets synced TO the
 *  auto-title, so a pane whose handle equals its auto-name looks user-named.
 *
 *  nameLocked is checked as well as customName: a title the user typed to match
 *  the vendor label resolves to no customName at all, and the pane would then
 *  be marked auto-named despite them having named it. The mark means "you have
 *  not touched this name", so any rename clears it for good. */
function paneIsAutoNamed(p: { customName?: string; nameLocked?: boolean; autoName?: string }): boolean {
  return !p.customName && !p.nameLocked && !!p.autoName
}

/** Narrow a persisted auto_name_source to the union, or undefined.
 *  Records written before this field existed report undefined, which reads as
 *  "not the model's" — so such a pane gets one upgrade attempt, the same as a
 *  pane whose earlier attempt found no model running. Only a stored 'llm'
 *  suppresses further attempts. */
function autoNameSourceOf(raw: string | undefined): 'heuristic' | 'llm' | undefined {
  return raw === 'llm' || raw === 'heuristic' ? raw : undefined
}

// Applies an auto-derived display name to a pane and persists it. A pane is
// titled at most twice and only in one direction: the string heuristic names
// it instantly, and the model's answer may replace that once. A customName
// always wins and permanently silences auto-naming, so the pane is never
// renamed turn after turn.
function setPaneAutoName(paneId: string, name: string, source: 'heuristic' | 'llm' = 'heuristic'): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !name) return
  if (pane.customName || pane.nameLocked) return
  if (pane.autoName && !(source === 'llm' && pane.autoNameSource !== 'llm')) return
  pane.autoName = name
  pane.autoNameSource = source
  // Mirror into the local history list so Agent History keeps the name after
  // the pane is closed (the backend patches its own copy; this keeps our next
  // snapshot from writing the name back out).
  const histEntry = spawnHistory.value.find((e) => e.paneId === paneId)
  if (histEntry) {
    histEntry.autoName = name
    spawnHistory.value = [...spawnHistory.value] // trigger save
  }
  // The auto-title becomes the pane's name, so sync the messaging handle to it
  // (silently — auto-naming is not a manual rename, so no collision prompt;
  // duplicates just take a -N suffix).
  if (pane.agentKey !== 'terminal') {
    const derived = messaging.setDerivedName(pane.id, name, pane.agentKey)
    if (derived) {
      pane.messagingName = derived
      persistMessagingName(pane.id, derived)
      mirrorMessagingHandle(pane)
    }
  }
  syncViews()
  // No workspace → the backend has no project.json to persist into; keep it
  // as in-memory state only (mirrors setPaneCustomName).
  if (!pane.workspacePath) return
  backend.send('project.set_pane_auto_name', {
    workspace_path: pane.workspacePath,
    pane_id: pane.id,
    auto_name: name,
    source,
  })
}

// Panes whose model-generated title is already in flight or settled. Naming
// material arrives repeatedly (every turn produces a turn_complete), and the
// point of the upgrade is that it happens once.
const llmNameRequested = new Set<string>()

/** Ask the backend for a model-written title, upgrading the heuristic one.
 *
 * Fire-and-forget on purpose: the pane is already titled, so nothing here is
 * awaited by a caller and every failure — no Ollama, no model, a timeout, a
 * refusal — simply leaves the heuristic title in place. Passes the raw
 * material rather than the heuristic title so the model sees the full request
 * instead of its own truncation.
 */
function requestLlmPaneName(paneId: string, material: string): void {
  const pane = panes.value.find((p) => p.id === paneId)
  if (!pane || !pane.workspacePath || !material.trim()) return
  if (pane.customName || pane.nameLocked || pane.autoNameSource === 'llm') return
  if (llmNameRequested.has(paneId)) return
  llmNameRequested.add(paneId)
  void (async () => {
    try {
      const resp = await backend.send<{ ok: boolean; name: string; changed?: boolean; error?: string }>(
        'pane.generate_auto_name',
        {
          workspace_path: pane.workspacePath,
          pane_id: paneId,
          material,
          model: analyzerModel.value || undefined,
        },
        // Backend budget is 20s (_BUDGET_S in pane_name_service.py); stay above
        // it so this never fires while the backend is still within its own.
        30_000,
      )
      // 'changed' is the backend arbiter's verdict, not just "a name came
      // back". It refuses a write the store already settled — a pane restored
      // with a model-written title, or one the user renamed while the model
      // was thinking. Applying the name anyway would show a title the backend
      // never stored, and the next restart would silently revert it.
      if (resp.ok && resp.payload?.ok && resp.payload.name && resp.payload.changed) {
        setPaneAutoName(paneId, resp.payload.name, 'llm')
      }
    } catch {
      // Heuristic title stands. Naming is cosmetic — never surface this.
    }
  })()
}

function confirmRenamePane(): void {
  const r = renamingPane.value
  if (!r) return
  setPaneCustomName(r.paneId, r.value)
  renamingPane.value = null
}

watch(layoutMode, (mode) => {
  const wp = pipeline.workspacePath
  if (wp) {
    backend.send('project.set_layout_mode', { workspace_path: wp, layout_mode: mode })
  }
}, { immediate: true })

const effectiveLayoutMode = computed<'grid' | 'spotlight' | 'sidebar' | 'fullscreen'>(() => {
  const m = layoutMode.value
  // auto → sidebar layout (focus pane left, others stacked in right column)
  if (m === 'auto') return 'sidebar'
  // spotlight → focus pane top, others in bottom strip
  if (m === 'spotlight') return 'spotlight'
  // fullscreen → focus pane 100%, others as floating overlays
  if (m === 'fullscreen') return 'fullscreen'
  return 'grid'
})

// After any layout mode change, refit all terminals once the browser has
// finished laying out the new grid — ResizeObserver alone is unreliable when
// panes transition from display:none (sidebar) to visible (spotlight/grid).
watch(effectiveLayoutMode, () => {
  void nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const ref of Object.values(paneRefs)) {
          (ref as unknown as { fitTerminal?: (opts: { redrawAfterSettle: boolean }) => void })?.fitTerminal?.({ redrawAfterSettle: true })
        }
      })
    })
  })
})

// Tab switches and minimize/restore move panes through display:none the same
// way layout mode changes do — refit so a pane that spawned or resized while
// hidden doesn't keep rendering at a stale width (corrupted TUI layout).
watch([activeTab, minimizedPanes], () => refitAllTerminals())

// In fullscreen mode non-focus panes are hidden (alive but not rendered);
// they appear in the collapsible PiP list instead.
function floatPaneStyle(paneId: string): Record<string, string> {
  if (effectiveLayoutMode.value !== 'fullscreen') return {}
  if (paneId === effectiveFocusPaneId.value) return {}
  if (dualFocusActive.value && paneId === dualFocusSecondaryId.value) return {}
  return { display: 'none' }
}

// ── Fullscreen PiP floating list ──────────────────────────────────────────────
const floatPipExpanded = ref(true)
const floatPipPos = ref<{ top: number; left: number }>(
  (() => { try { const v = JSON.parse(settingsGet('agentTeam.floatPipPos', '')); if (typeof v?.top === 'number') return v as { top: number; left: number } } catch {} return { top: 0, left: 0 } })()
)
const floatPipWidth = ref<number>(
  parseInt(settingsGet('agentTeam.floatPipWidth', '220')) || 220
)
watch(floatPipPos, (v) => { settingsSet('agentTeam.floatPipPos', JSON.stringify(v)) }, { deep: true })
watch(floatPipWidth, (v) => { settingsSet('agentTeam.floatPipWidth', String(v)) })
// Fixed list height — the PiP window never grows with pane count; overflowing
// panes are picked by scrolling. The corner handle resizes this fixed height.
const floatPipListHeight = ref(320)

// Template refs rather than querySelector: the old lookup fell back to a
// hardcoded 800x600 when it missed, so renaming or wrapping .stage would clamp
// the PiP to a bogus box with no error, no warning and nothing in the console —
// only a panel that drifts to the wrong place. A ref cannot silently miss.
const stageRef = ref<HTMLElement | null>(null)
const floatPipRef = ref<HTMLElement | null>(null)

function _pipStageSize(): { sw: number; sh: number } {
  const el = stageRef.value
  if (!el) return { sw: 0, sh: 0 } // pre-mount only; clamping to 0 is a no-op
  return { sw: el.clientWidth, sh: el.clientHeight }
}

function clampPipPos(): void {
  nextTick(() => {
    const pip = floatPipRef.value
    if (!pip) return
    const { sw, sh } = _pipStageSize()
    floatPipPos.value = {
      left: Math.max(8, Math.min(sw - floatPipWidth.value - 8, floatPipPos.value.left)),
      top: Math.max(0, Math.min(sh - 32, floatPipPos.value.top)),
    }
  })
}

watch(effectiveLayoutMode, (mode) => {
  if (mode === 'fullscreen') {
    floatPipWidth.value = 220
    floatPipListHeight.value = 320
    floatPipExpanded.value = true
    nextTick(() => {
      const pip = floatPipRef.value
      const { sw, sh } = _pipStageSize()
      const pipH = pip?.offsetHeight ?? 360
      floatPipPos.value = {
        left: sw - floatPipWidth.value - 16,
        top: Math.max(0, sh - pipH - 16),
      }
    })
  }
})

let _pipStartX = 0, _pipStartY = 0, _pipStartL = 0, _pipStartT = 0

function onPipDragStart(e: MouseEvent): void {
  _pipStartX = e.clientX
  _pipStartY = e.clientY
  _pipStartL = floatPipPos.value.left
  _pipStartT = floatPipPos.value.top
  document.addEventListener('mousemove', onPipDragMove)
  document.addEventListener('mouseup', onPipDragEnd)
  e.preventDefault()
}

function onPipDragMove(e: MouseEvent): void {
  const dx = e.clientX - _pipStartX
  const dy = e.clientY - _pipStartY
  const { sw, sh } = _pipStageSize()
  floatPipPos.value = {
    left: Math.max(8, Math.min(sw - floatPipWidth.value - 8, _pipStartL + dx)),
    top: Math.max(0, Math.min(sh - 32, _pipStartT + dy)),
  }
}

function onPipDragEnd(): void {
  document.removeEventListener('mousemove', onPipDragMove)
  document.removeEventListener('mouseup', onPipDragEnd)
}

let _resStartX = 0, _resStartY = 0, _resStartW = 0, _resStartH = 0

function onPipResizeStart(e: MouseEvent): void {
  _resStartX = e.clientX
  _resStartY = e.clientY
  _resStartW = floatPipWidth.value
  _resStartH = floatPipListHeight.value
  document.addEventListener('mousemove', onPipResizeMove)
  document.addEventListener('mouseup', onPipResizeEnd)
  e.preventDefault()
  e.stopPropagation()
}

function onPipResizeMove(e: MouseEvent): void {
  const dx = e.clientX - _resStartX
  const dy = e.clientY - _resStartY
  const { sw } = _pipStageSize()
  floatPipWidth.value = Math.max(160, Math.min(sw - 32, _resStartW + dx))
  floatPipListHeight.value = Math.max(80, Math.min(600, _resStartH + dy))
}

function onPipResizeEnd(): void {
  document.removeEventListener('mousemove', onPipResizeMove)
  document.removeEventListener('mouseup', onPipResizeEnd)
}

// Number of non-focus visible panes — drives explicit grid-template-rows so
// that grid-row: 1 / -1 works correctly on the focus pane.
const sidebarRowCount = computed(() => {
  return Math.max(1, tabVisiblePanes.value.length - 1)
})

// ── Grid pane splitters ───────────────────────────────────────────────────────
const gridRef = ref<HTMLElement | null>(null)
const colWidths = ref<number[]>(
  (() => { try { const v = JSON.parse(settingsGet('agentTeam.colWidths', '')); if (Array.isArray(v)) return v as number[] } catch {} return [1] })()
)
const rowHeights = ref<number[]>(
  (() => { try { const v = JSON.parse(settingsGet('agentTeam.rowHeights', '')); if (Array.isArray(v)) return v as number[] } catch {} return [1] })()
)
/** The Active agents list's natural width in Sidebar mode, and the width below
 *  which it stops being readable. `.auto-meeting-list`'s own `min-width` is the
 *  same number — the track reserves the space so the item never has to overflow
 *  to keep it. */
const MEETING_LIST_WIDTH_PX = 220
const MEETING_LIST_MIN_PX = 140
const MEETING_LIST_TRACK = `minmax(${MEETING_LIST_MIN_PX}px, ${MEETING_LIST_WIDTH_PX}px)`

// Sidebar left column width in pixels (0 = default: fill remaining space)
const sidebarLeftPx = ref<number>(
  parseInt(settingsGet('agentTeam.sidebarLeftPx', '0')) || 0
)
const dualFocusSplitPx = ref<number>(
  parseInt(settingsGet('agentTeam.dualFocusSplitPx', '0')) || 0
)
watch(colWidths, (v) => { settingsSet('agentTeam.colWidths', JSON.stringify(v)) }, { deep: true })
watch(rowHeights, (v) => { settingsSet('agentTeam.rowHeights', JSON.stringify(v)) }, { deep: true })
watch(sidebarLeftPx, (v) => { settingsSet('agentTeam.sidebarLeftPx', String(v)) })
watch(dualFocusSplitPx, (v) => { settingsSet('agentTeam.dualFocusSplitPx', String(v)) })

// ── Grid layout preset + paging ──────────────────────────────────────────────
// 'auto' shows every visible pane at once; fixed CxR presets (2x1/2x2/3x3 or a
// custom typed size) cap the panes per page and page through the rest.
// Paged-out panes are only hidden (v-show) so their terminals stay alive.
const gridPreset = ref<GridPreset>(parseGridPreset(settingsGet('agentTeam.gridPreset', 'auto')))
const gridPage = ref(0)
watch(gridPreset, (v) => { settingsSet('agentTeam.gridPreset', v); gridPage.value = 0 })
const gridPageTotal = computed(() => gridPageCount(tabVisiblePanes.value.length, gridPreset.value))
watch(gridPageTotal, (n) => { if (gridPage.value > n - 1) gridPage.value = Math.max(0, n - 1) })
const gridPagePanes = computed(() => gridPageSlice(tabVisiblePanes.value, gridPreset.value, gridPage.value))
const gridPagePaneIds = computed(() => new Set(gridPagePanes.value.map((p) => p.id)))
const gridPresetOptions: { key: GridPreset; label: string; title: string }[] = [
  { key: 'auto', label: '∞', title: 'Auto — fit all panes' },
  { key: '2x1', label: '2×1', title: '2×1 layout — pages of 2 panes' },
  { key: '2x2', label: '2×2', title: '2×2 layout — pages of 4 panes' },
  { key: '3x3', label: '3×3', title: '3×3 layout — pages of 9 panes' },
]
// Custom CxR entry — any cols × rows (1–9 each) typed by the user.
const _customSeed = gridPresetDims(gridPreset.value)
const gridCustomCols = ref<number>(_customSeed?.cols ?? 3)
const gridCustomRows = ref<number>(_customSeed?.rows ?? 3)
const gridCustomActive = computed(() =>
  gridPreset.value !== 'auto' && !gridPresetOptions.some((o) => o.key === gridPreset.value)
)
function applyGridCustom(): void {
  const clamp = (v: number): number => Math.max(1, Math.min(9, Math.floor(v) || 1))
  gridCustomCols.value = clamp(gridCustomCols.value)
  gridCustomRows.value = clamp(gridCustomRows.value)
  gridPreset.value = `${gridCustomCols.value}x${gridCustomRows.value}`
  void nextTick().then(() => advanceRestoreSession('grid-page'))
}

// Fixed presets keep their exact frame (empty cells stay blank when the page
// is not full); 'auto' derives the shape from the visible pane count.
const numCols = computed(() => {
  const d = gridPresetDims(gridPreset.value)
  if (d) return d.cols
  const n = tabVisiblePanes.value.length
  if (n <= 1) return 1
  if (n <= 4) return 2
  return 3
})
const numRows = computed(() => {
  const d = gridPresetDims(gridPreset.value)
  if (d) return d.rows
  return Math.max(1, Math.ceil(gridPagePanes.value.length / numCols.value))
})

// Reset the tracks to equal shares when the grid changes shape — but not on the
// very first run, or the sizes just restored from settings are overwritten with
// an even split and written straight back, which is why dragged column widths
// have never survived a restart. A stored array of the right length is by
// definition still valid for this shape, so keep it; anything else (a different
// preset, a stale value) falls through to the even split as before.
function resetTracks(track: Ref<number[]>, n: number, first: boolean): void {
  if (first && track.value.length === n) return
  track.value = Array(n).fill(1)
}
watch(numCols, (n, prev) => { resetTracks(colWidths, n, prev === undefined) }, { immediate: true })
watch(numRows, (n, prev) => { resetTracks(rowHeights, n, prev === undefined) }, { immediate: true })

const gridTemplateColumns = computed(() => {
  switch (effectiveLayoutMode.value) {
    case 'spotlight':
    case 'fullscreen': {
      if (dualFocusActive.value) {
        const l = dualFocusSplitPx.value > 0 ? `${dualFocusSplitPx.value}px` : '1fr'
        return `${l} 1fr`
      }
      return '1fr'
    }
    case 'sidebar': {
      // Every fixed track is a minmax with a zero floor, and the agents list
      // carries its own.
      //
      // `sidebarLeftPx` is an absolute width the user dragged once, clamped
      // against the stage width *at that moment* and never re-checked. Anything
      // that later narrows the stage — expanding the right panel, opening the
      // left one, resizing the window — leaves the pane column at its old px
      // while the list is squeezed to its `min-width`, so the row is wider than
      // the stage. `.stage` hides its overflow, so the list is not shrunk but
      // *cut off* at the stage's right edge, which reads as the right panel
      // covering it. minmax makes the pane column give ground instead, and the
      // stored width is untouched so it comes back when there is room again.
      if (dualFocusActive.value) {
        const l = dualFocusSplitPx.value > 0 ? `minmax(0, ${dualFocusSplitPx.value}px)` : '1fr'
        return `${l} minmax(0, 1fr) ${MEETING_LIST_TRACK}`
      }
      return sidebarLeftPx.value > 0
        ? `minmax(0, ${sidebarLeftPx.value}px) minmax(${MEETING_LIST_MIN_PX}px, 1fr)`
        : `minmax(0, 1fr) ${MEETING_LIST_TRACK}`
    }
    default: {
      const ws = colWidths.value.length === numCols.value ? colWidths.value : Array(numCols.value).fill(1)
      return ws.map(w => `${w}fr`).join(' ')
    }
  }
})

const gridTemplateRows = computed(() => {
  switch (effectiveLayoutMode.value) {
    case 'spotlight': return '1fr'
    case 'sidebar':   return '1fr'
    case 'fullscreen': return '1fr'
    default: {
      const hs = rowHeights.value.length === numRows.value ? rowHeights.value : Array(numRows.value).fill(1)
      return hs.map(h => `${h}fr`).join(' ')
    }
  }
})

const gridStyle = computed(() => ({
  gridTemplateColumns: gridTemplateColumns.value,
  gridTemplateRows: gridTemplateRows.value,
}))

// Handle positions as percentage strings (grid mode: between columns/rows)
const colHandlePositions = computed<string[]>(() => {
  if (effectiveLayoutMode.value !== 'grid') return []
  const ws = colWidths.value.length === numCols.value ? colWidths.value : Array(numCols.value).fill(1)
  if (ws.length <= 1) return []
  const total = ws.reduce((a, b) => a + b, 0)
  let cum = 0
  return ws.slice(0, -1).map(w => { cum += w; return `${(cum / total) * 100}%` })
})

const rowHandlePositions = computed<string[]>(() => {
  if (effectiveLayoutMode.value !== 'grid') return []
  const hs = rowHeights.value.length === numRows.value ? rowHeights.value : Array(numRows.value).fill(1)
  if (hs.length <= 1) return []
  const total = hs.reduce((a, b) => a + b, 0)
  let cum = 0
  return hs.slice(0, -1).map(h => { cum += h; return `${(cum / total) * 100}%` })
})

// Sidebar handle: matches the grid template split exactly — no clientWidth needed.
const sidebarHandlePos = computed(() => {
  // Mirrors the clamp in the track above. Without the min() the handle would be
  // drawn at the stored width while the real boundary sat further left — the
  // same "position duplicated from a track definition" hazard the shell's own
  // handles used to have.
  return sidebarLeftPx.value > 0
    ? `min(${sidebarLeftPx.value}px, calc(100% - ${MEETING_LIST_MIN_PX}px))`
    : `calc(100% - ${MEETING_LIST_WIDTH_PX}px)`
})

type GridHandleAxis = 'col' | 'row' | 'sidebar' | 'dual-focus'
let _gAxis: GridHandleAxis | null = null
let _gIdx = 0
let _gStartX = 0
let _gStartY = 0
let _gA = 0
let _gB = 0
let _gSize = 0

function onGridHandleStart(e: MouseEvent, axis: GridHandleAxis, index: number): void {
  _gAxis = axis
  _gIdx = index
  _gStartX = e.clientX
  _gStartY = e.clientY
  const el = gridRef.value
  if (axis === 'col') {
    _gA = colWidths.value[index] ?? 1
    _gB = colWidths.value[index + 1] ?? 1
    _gSize = el?.clientWidth ?? 800
  } else if (axis === 'row') {
    _gA = rowHeights.value[index] ?? 1
    _gB = rowHeights.value[index + 1] ?? 1
    _gSize = el?.clientHeight ?? 600
  } else if (axis === 'sidebar') {
    _gA = sidebarLeftPx.value > 0 ? sidebarLeftPx.value : (el?.clientWidth ?? 800) - 220
    _gSize = el?.clientWidth ?? 800
  } else {
    const meetingW = effectiveLayoutMode.value === 'sidebar' ? MEETING_LIST_WIDTH_PX : 0
    _gSize = (el?.clientWidth ?? 800) - meetingW
    _gA = dualFocusSplitPx.value > 0 ? dualFocusSplitPx.value : _gSize / 2
    _gB = 0
  }
  isGridDragging.value = true
  document.body.style.cursor = axis === 'row' ? 'row-resize' : 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onGridHandleMove)
  document.addEventListener('mouseup', onGridHandleEnd)
  e.preventDefault()
}

function onGridHandleMove(e: MouseEvent): void {
  if (!_gAxis) return
  if (_gAxis === 'col') {
    const dx = e.clientX - _gStartX
    const sum = _gA + _gB
    const newA = Math.max(0.1, Math.min(sum - 0.1, _gA + dx * sum / _gSize))
    const next = [...colWidths.value]
    next[_gIdx] = newA
    next[_gIdx + 1] = sum - newA
    colWidths.value = next
  } else if (_gAxis === 'row') {
    const dy = e.clientY - _gStartY
    const sum = _gA + _gB
    const newA = Math.max(0.1, Math.min(sum - 0.1, _gA + dy * sum / _gSize))
    const next = [...rowHeights.value]
    next[_gIdx] = newA
    next[_gIdx + 1] = sum - newA
    rowHeights.value = next
  } else if (_gAxis === 'sidebar') {
    const dx = e.clientX - _gStartX
    // Same floor the track reserves, so the drag cannot write a width the
    // rendered layout will then clamp away underneath it.
    sidebarLeftPx.value = Math.max(200, Math.min(_gSize - MEETING_LIST_MIN_PX, _gA + dx))
  } else if (_gAxis === 'dual-focus') {
    const dx = e.clientX - _gStartX
    dualFocusSplitPx.value = Math.max(150, Math.min(_gSize - 150, _gA + dx))
  }
}

function onGridHandleEnd(): void {
  _gAxis = null
  isGridDragging.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onGridHandleMove)
  document.removeEventListener('mouseup', onGridHandleEnd)
  refitAllTerminals()
}

// Resolved focus pane: skips minimized panes, falls back to first visible
const effectiveFocusPaneId = computed(() =>
  // Of the workspace on screen — naming a pane from another one renders
  // nothing at all, since sidebar and spotlight draw this pane and no other.
  resolveFocusedPane(focusPaneId.value, panesInView.value, minimizedPanes.value)
)

// ── Dual-focus: show 2 running panes side-by-side in non-grid modes ───────────
const runningPaneIds = computed(() => {
  // Only consider pipeline panes that belong to the CURRENT active stage.
  // Restored panes from completed stages (via claude resume) also show as
  // 'running' during session replay and must not activate dual-focus.
  const activeStageId = stagesApi.stages.value[pipeline.stageIndex]?.id ?? ''
  const running = paneViews.value.filter(
    (p) =>
      (p.status === 'running' || p.status === 'starting') &&
      !minimizedPanes.value.has(p.id) &&
      p.origin === 'pipeline' &&
      p.stageId === activeStageId &&
      pipeline.state === 'running'
  )
  if (running.length < 2) return []
  // Keep focus pane first so it stays in col 1
  const focusIdx = running.findIndex((p) => p.id === effectiveFocusPaneId.value)
  if (focusIdx > 0) {
    const arr = [...running]
    const [fp] = arr.splice(focusIdx, 1)
    arr.unshift(fp)
    return arr.slice(0, 2).map((p) => p.id)
  }
  return running.slice(0, 2).map((p) => p.id)
})
const dualFocusActive = computed(
  () => runningPaneIds.value.length >= 2 && effectiveLayoutMode.value !== 'grid'
)
const dualFocusSecondaryId = computed<string | null>(
  () => (dualFocusActive.value ? runningPaneIds.value[1] : null)
)

// Single source of truth for panes currently rendered in the stage. Fullscreen
// deliberately keeps its existing v-show behavior; floatPaneStyle handles its
// visual hiding separately.
const onScreenPaneIds = computed<Set<string>>(() => {
  const visibleIds = new Set(tabVisiblePanes.value.map((p) => p.id))
  if (effectiveLayoutMode.value === 'grid') {
    return new Set([...gridPagePaneIds.value].filter((id) => visibleIds.has(id)))
  }
  if (effectiveLayoutMode.value === 'sidebar' || effectiveLayoutMode.value === 'spotlight') {
    const ids = new Set<string>()
    if (effectiveFocusPaneId.value && visibleIds.has(effectiveFocusPaneId.value)) ids.add(effectiveFocusPaneId.value)
    if (dualFocusSecondaryId.value && visibleIds.has(dualFocusSecondaryId.value)) ids.add(dualFocusSecondaryId.value)
    return ids
  }
  return visibleIds
})

// Render order of each click surface, consumed by Shift-click range selection
// so a range only spans panes the user can actually see on that surface.
// Stage = the TerminalPane v-for (panes gated by onScreenPaneIds); auxiliary =
// the meeting sidebar / spotlight strip / float PIP lists, which all share the
// same v-for filter over paneViews.
const stageSurfaceOrderedIds = computed<string[]>(() =>
  panes.value.filter((p) => onScreenPaneIds.value.has(p.id)).map((p) => p.id)
)
// Shift-range selection walks this list, so it has to be the order the user
// actually sees: the lineage tree flattened depth-first, not the flat pane
// order. It is also collapse-aware for free — a folded subtree's children are
// absent from paneLineage, so a range spanning a collapsed parent skips the
// children the user cannot see.
const auxiliaryListOrderedIds = computed<string[]>(() => {
  const visible = new Set(
    paneViews.value
      .filter((v) => !v.isMinimized && tabFilteredPaneIds.value.has(v.id))
      .map((v) => v.id)
  )
  return paneLineage.value.filter((r) => visible.has(r.id)).map((r) => r.id)
})

function onUserChangeLayoutMode(mode: LayoutMode): void {
  layoutMode.value = mode
  void nextTick().then(() => advanceRestoreSession('layout'))
}

function onUserChangeGridPreset(preset: GridPreset): void {
  gridPreset.value = preset
  void nextTick().then(() => advanceRestoreSession('grid-page'))
}

function onUserChangeGridPage(page: number): void {
  gridPage.value = page
  void nextTick().then(() => advanceRestoreSession('grid-page'))
}

/** Ctrl+Tab / Ctrl+Shift+Tab: walk the panes visible under the current tab,
 *  wrapping at both ends. A fixed grid preset hides off-page panes behind
 *  v-show, so landing on one has to turn the page as well — otherwise focus
 *  would move to a pane the user cannot see. Non-grid layouts derive the stage
 *  from focusPaneId alone and need no such fixup. */
function cycleFocusedPane(direction: CycleDirection): void {
  const plan = planPaneCycle({
    orderedIds: tabVisiblePanes.value.map((p) => p.id),
    currentId: effectiveFocusPaneId.value,
    direction,
    gridDims: effectiveLayoutMode.value === 'grid' ? gridPresetDims(gridPreset.value) : null,
    currentPage: gridPage.value,
  })
  if (!plan) return
  if (plan.page !== null) onUserChangeGridPage(plan.page)
  const targetRealized = panes.value.find((p) => p.id === plan.targetId)?.realized
  selectPane(plan.targetId, { userInitiated: true, scrollIntoView: true })
  // A pane still showing its restore placeholder has no TerminalPane ref, so
  // the focusPaneId watcher's focus() is a silent no-op and the outgoing
  // terminal would keep the DOM focus — every keystroke would land in the pane
  // the user just left. Drop focus now, then claim it once the pane realizes
  // (selectPane already kicked that off; realizeRestoredPane dedupes in-flight
  // calls, so awaiting it here does not start a second resume).
  if (!targetRealized) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    void realizeRestoredPane(plan.targetId).then(() => {
      if (focusPaneId.value !== plan.targetId) return
      void nextTick(() => { paneRefs[plan.targetId]?.focus?.() })
    })
  }
}

const dualFocusHandlePos = computed(() => {
  if (dualFocusSplitPx.value > 0) return `${dualFocusSplitPx.value}px`
  const meetingW = effectiveLayoutMode.value === 'sidebar' ? MEETING_LIST_WIDTH_PX : 0
  return meetingW > 0 ? `calc((100% - ${meetingW}px) / 2)` : '50%'
})
watch(dualFocusActive, (active) => { if (!active) dualFocusSplitPx.value = 0 })

function dualFocusStyle(paneId: string): Record<string, string> {
  if (!dualFocusActive.value || paneId !== dualFocusSecondaryId.value) return {}
  return { gridColumn: '2', gridRow: '1' }
}

const backendUrl = computed(() => backend.httpUrl.value)
/** Status-bar label for the backend pill.
 *
 *  It used to read "connecting…" for every non-connected state, which made a
 *  backend that had died and given up look identical to one that was a second
 *  away — the pill is the only always-visible indicator once the boot overlay
 *  is gone, so that difference is the whole point of showing it. */
const backendPillLabel = computed(() => {
  if (backend.status.value === 'connected') return 'backend'
  const auto = backend.autoRestart.value
  if (auto) return `restarting ${auto.attempt}/${auto.max}…`
  if (backend.status.value === 'error') return 'backend down'
  return 'connecting…'
})
// Frozen at bundle time. Shown as the build-time row of the clock popover, so a
// stale dev build is still identifiable — it is deliberately NOT a clock.
const buildTag = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev'
const appVersion = window.agentTeam?.version ?? ''

// Status-bar clock. Reassigning an identical string is a no-op for Vue's
// reactivity, so a 1s tick costs nothing between minute boundaries.
const clockLabel = ref('')
// Same tick, exposed as epoch ms for the clock popover's seconds display and
// uptime counter — nothing reads it while the popover is closed, so this stays
// the app's only always-on timer.
const clockNow = ref(Date.now())
function tickClock(): void {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  clockLabel.value = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  clockNow.value = d.getTime()
}
tickClock()
/** When this renderer booted — uptime is per window, not cumulative. */
const sessionStartedAt = Date.now()
/** Project `created_at` as sent by project.peek; '' until a project is open. */
const projectCreatedAt = ref('')
let clockTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clockTimer = setInterval(tickClock, 1000)
})
onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
  clockTimer = null
})

// Backend supervisor popover (status bar pill → manage/restart/stop the backend).
const backendBusy = ref(false)
async function onRestartBackend(): Promise<void> {
  if (backendBusy.value) return
  backendBusy.value = true
  try { await backend.restart() } finally { backendBusy.value = false }
}
async function onStopBackend(): Promise<void> {
  if (backendBusy.value) return
  backendBusy.value = true
  try { await backend.stop() } finally { backendBusy.value = false }
}

// Log a one-line "queued" notice the moment a pane's analyzer call starts
// waiting behind another (already-running) llama-cli call, so the user sees
// why it's taking a while instead of assuming the connection is stuck.
watch(analyzerApi.queuedPaneIds, (ids, prevIds) => {
  for (const paneId of ids) {
    if (prevIds?.has(paneId)) continue
    const pane = panes.value.find((p) => p.id === paneId)
    const stage = pane ? stagesApi.stages.value.find((s) => s.id === pane.stageId) : undefined
    const tag = stage ? `Stage ${stage.id}` : `Pane ${paneId.slice(0, 8)}`
    pipelineLog(`${tag} 🧠 queued — waiting for another analyzer call to finish`)
  }
})

const analyzerStatus = computed<AnalyzerStatusView>(() => ({
  available: !!analyzerApi.health.value?.ok,
  version: analyzerApi.health.value?.version ?? '',
  defaultModel: analyzerApi.defaultModel.value,
  models: analyzerApi.models.value.map((m) => ({
    name: m.name,
    parameter_size: m.parameter_size,
    size: m.size
  })),
  benchmarkResults: analyzerApi.benchmarkResults.value,
}))

/** Latest pipeline-log entry, surfaced as live status text in the empty-area
 *  spinner so the user sees what the orchestrator is doing during the 10-30s
 *  startup window (Context7 docs → spawn → settle → inject). */
const latestPipelineLog = computed<string>(() => {
  const log = pipeline.log
  if (!log.length) return '正在啟動…'
  // pipelineLog() prefixes "[HH:MM:SS] " — strip it for the spinner display.
  return log[log.length - 1].replace(/^\[[\d:]+\]\s*/, '')
})

function paneSubtitle(p: ActivePane): string {
  const preparationLabel = panePreparationLabel(p)
  const agentType = agentSpecs.find((s) => s.agentKey === p.agentKey)?.label ?? p.agentKey
  if (p.origin !== 'pipeline' && !p.stageId) return `${agentType} · ${roleLabel(p.roleKey)} · ${i18n.global.t('label.manual')} · ${preparationLabel}`
  const stage = stagesApi.stageById.value[p.stageId] ?? { shortTitle: p.stageId }
  const prefix = p.origin === 'pipeline' ? `P${p.stageId} · ` : ''
  const stageLabel = stage.shortTitle || i18n.global.t('label.manual')
  return `${prefix}${agentType} · ${roleLabel(p.roleKey)} · ${stageLabel} · ${preparationLabel}`
}

function panePreparationLabel(p: ActivePane): string {
  // A cold-restore placeholder carries preparationStatus 'starting' as a seed for
  // the pane it will become — nothing is starting yet, so report the real state.
  if (!p.realized) {
    return i18n.global.t(p.restoring ? 'pane.terminal.resuming' : 'pane.terminal.click-to-resume')
  }
  if (paneWaitingForSessionId(p)) {
    return i18n.global.t('pane.prep.detecting-session')
  }
  switch (p.preparationStatus) {
    case 'starting':
      return i18n.global.t('pane.prep.starting')
    case 'checking-dialog':
      return i18n.global.t('pane.prep.checking-dialog')
    case 'settling':
      return i18n.global.t('pane.prep.settling')
    case 'injecting-role':
      return i18n.global.t('pane.prep.injecting-role')
    case 'waiting-agent':
      return i18n.global.t('pane.prep.waiting-agent')
    case 'ready':
      return i18n.global.t('pane.prep.ready')
    case 'failed':
      return i18n.global.t('pane.prep.failed')
  }
}

function paneWaitingForSessionId(p: ActivePane): boolean {
  return !!p.sessionMarker && !p.pinnedSessionId && SESSION_ID_WAIT_AGENTS.has(p.agentKey)
}

// Session detection has PRECONDITIONS the user may have to satisfy in the
// terminal itself: a fresh CLI sits at its own setup dialog (API key entry,
// trust prompt, login) and writes no session until the user acts. Blocking the
// pane while waiting for a session would deadlock exactly that flow — so the
// overlay yields when the visible buffer tail looks like a setup dialog.
const SETUP_DIALOG_RE = /(api key|paste your|enter .{0,20}key|log ?in|sign in|authenticate|press enter to continue|do you trust|trust th(e|is))/i
function paneAwaitsUserSetup(p: ActivePane): boolean {
  const buf = (paneRefs[p.id]?.cleanBuffer as unknown as string) ?? ''
  return SETUP_DIALOG_RE.test(buf.slice(-2000))
}

function paneShowsPrepOverlay(p: ActivePane): boolean {
  return (
    (p.preparationStatus !== 'ready' && p.preparationStatus !== 'failed') ||
    (paneWaitingForSessionId(p) && !p.sessionOverlayExpired && !paneAwaitsUserSetup(p))
  )
}

/** The effective Commander slot for a stage, or null. Commander mode only applies
 *  when a stage has more than one slot — a lone slot has nobody to coordinate,
 *  and entering Commander mode would disable the reliable slot watcher (sentinel
 *  / analyzer / cap), leaving the easily-missed ---STAGE-DONE--- sentinel as
 *  the only way to advance. */
function stageCommanderSlot(stage: { slots: StageSlot[] }): StageSlot | null {
  if (stage.slots.length <= 1) return null
  return stage.slots.find((s) => s.isCommander) ?? null
}

/** True when this pane is the Commander slot (renders 🎯 badge).
 *  Uses the raw slot.isCommander flag, not stageCommanderSlot(), so the badge
 *  shows even for single-slot stages. */
function paneIsCommander(p: ActivePane): boolean {
  if (p.origin !== 'pipeline') return false
  const stage = stagesApi.stageById.value[p.stageId]
  if (!stage) return false
  const slot = stage.slots.find((s) => s.label === p.slotLabel)
  return !!slot?.isCommander
}
</script>

<template>
  <!-- First-run environment wizard: hard-blocks the shell until complete. -->
  <OnboardingWizard
    v-if="onboardingComplete === false"
    :backend="backend"
    @complete="completeOnboarding"
    @close="completeOnboarding"
  />
  <CliHealthGuide
    v-if="onboardingComplete === true && cliHealthGuide"
    :backend="backend"
    :initial-health="cliHealthGuide"
    @close="cliHealthGuide = null"
    @resolved="cliHealthGuide = null"
    @use-binary="selectCliBinary"
  />
  <!-- Guided install for a CLI that is missing (pane exited 127, or picked
       from the spawn dropdown while not installed). -->
  <CliInstallDialog
    v-if="cliInstallRequest"
    :backend="backend"
    :dep-id="cliInstallRequest.depId"
    :fallback-label="cliInstallRequest.label"
    :origin="cliInstallRequest.origin"
    @close="closeCliInstall"
    @relaunch="relaunchAfterInstall"
    @dismiss-changed="onCliInstallDismissChanged"
  />
  <RestoreScopeModal
    v-if="showRestoreScopeModal"
    :open="showRestoreScopeModal"
    :count="restoreScopePrompt?.count ?? 0"
    @select="settleRestoreScope"
    @fresh="settleRestoreScope('fresh')"
    @cancel="settleRestoreScope(null)"
  />
  <!-- First-boot loading overlay: covers the shell until the backend settles,
       then fades out. Brand mark only, so no i18n keys are needed. -->
  <Transition name="boot-fade">
    <div v-if="booting" class="boot-overlay">
      <div class="boot-card">
        <img class="boot-logo" :src="navideMark" alt="Navide" />
        <template v-if="bootError">
          <div class="boot-status boot-status-error">{{ $t('error.backend-start-failed') }}</div>
          <button class="boot-retry" @click="retryBackend">{{ $t('action.retry') }}</button>
        </template>
        <template v-else>
          <div class="boot-spinner" aria-label="loading" />
          <div class="boot-status">
            <span>{{ $t(bootStatusKey) }}</span>
            <span class="boot-elapsed">{{ $t('label.boot-countdown', { seconds: bootCountdown }) }}</span>
          </div>
        </template>
      </div>
    </div>
  </Transition>
  <div class="app" :style="{ '--token-panel-width': tokenPanelWidth, '--left-width': leftTrackWidth, '--up-height': upTrackHeight, '--down-height': downTrackHeight, '--rail-size': RAIL_SIZE + 'px', '--chrome-bottom': shellLayout.chrome.statusbar ? '24px' : '0px' }" :class="{ 'is-resizing-shell': isShellDragging, 'is-resizing-grid': isGridDragging }">
    <!-- Custom titlebar: traffic lights on left (via hiddenInset), name centre, gear right -->
    <div class="titlebar">
      <!-- The path and the workspace switcher both used to live here; the
           sidebar's Workspace section carries them now (the path under each
           project name, ＋ to open another one). Reveal-in-Finder went with
           them — Welcome's recent list still has it on its context menu. -->
      <template v-if="workspaceSelected">
        <span class="titlebar-spacer"></span>
        <!-- Which project the window is looking at. document.title already
             carries it for Mission Control, but the bar itself said nothing —
             and with several workspaces in one window, switching between them
             changed everything below and nothing up here. -->
        <!-- Two projects can share a folder name, so the name alone does not
             say which one this is — but the path is long and only wanted when
             asked for, so hovering swaps one for the other rather than showing
             both at once. Home is collapsed to ~, the same shortening the
             sidebar's paths use. -->
        <span class="titlebar-id">
          <span class="titlebar-name titlebar-name--ws">{{ workspaceBaseName }}</span>
          <span v-if="workspaceDisplayPath" class="titlebar-path">{{ workspaceDisplayPath }}</span>
          <!-- Rides with the path rather than the name: it acts on the folder,
               and the folder is what is on screen while hovering. -->
          <button
            v-if="workspaceDisplayPath"
            class="titlebar-reveal"
            :title="$t('action.open-in-finder')"
            :aria-label="$t('action.open-in-finder')"
            @click="revealWorkspaceFolder(currentWorkspace)"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 19a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3" />
              <path d="M2 13h10" />
              <path d="m9 16 3-3-3-3" />
            </svg>
          </button>
        </span>
        <span class="titlebar-spacer"></span>
      </template>
      <span v-else class="titlebar-name">{{ workspaceBaseName }}</span>
      <!-- Plugin buttons lead the cluster, so they grow LEFTWARD.
           .titlebar-spacer is flex:1, which pins this cluster to the right
           edge: anything appended after the gear widens the cluster and shoves
           ↻ and the gear left, moving two built-in controls every time a
           plugin is installed or removed. Ahead of them, the built-ins keep
           the position they have with no plugins at all. -->
      <div v-if="workspaceSelected && windowPluginContributions.length" class="titlebar-plugin-actions">
        <button
          v-for="contribution in windowPluginContributions"
          :key="contribution.contributionKey"
          class="titlebar-plugin-action"
          type="button"
          :title="contribution.title"
          :aria-label="contribution.title"
          @mousedown.stop
          @click="openPluginContributionWindow(contribution)"
        >
          <img
            v-if="hasPluginIcon(contribution)"
            class="titlebar-plugin-icon"
            :src="contribution.icon ?? ''"
            width="12"
            height="12"
            alt=""
            @error="markPluginIconFailed(contribution)"
          />
          <span v-else class="titlebar-plugin-fallback" aria-hidden="true">◇</span>
        </button>
      </div>
      <!-- Detached windows could only be merged back by closing them, which is
           indistinguishable from "done with these panes". -->
      <button
        v-if="isDetachedWindow"
        class="titlebar-ws-btn"
        @mousedown.stop
        @click="reattachThisWindow"
        :title="$t('action.reattach-group')"
      >⇲</button>
      <!-- Back to the Welcome picker, which doubles as the workspace switcher.
           Removed by accident in 2a53718c: only the button went, while
           onSwitchWorkspace, the @switch-workspace binding and the i18n string
           all stayed, leaving the feature reachable by nothing. Restored here
           rather than in ControlPane's old spot because the workspace identity
           now lives in the titlebar, next to the detach button it pairs with. -->
      <button
        v-if="!isDetachedWindow && workspaceSelected"
        class="titlebar-ws-btn"
        @mousedown.stop
        @click="onSwitchWorkspace"
        :title="$t('action.switch-workspace')"
      >↺</button>
      <!-- Account: sits immediately before the gear so the gear keeps its
           edge position (see the plugin-cluster note above). -->
      <button
        class="titlebar-account"
        type="button"
        @mousedown.stop
        @click="openAccountModal"
        :title="p2pAccountLabel || $t('action.sign-in')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <span v-if="p2pAccountLabel" class="titlebar-account-dot" :class="p2pAccountDotClass"></span>
      </button>
      <button class="titlebar-gear" @mousedown.stop @click="showSettings = true" title="Settings (⌘,)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
    <!-- Manifest-driven top workbench contributions. The Host keeps opaque
         instance handles in main; this renderer only supplies layout bounds. -->
    <div
      v-if="pluginContributionsAt('top').length"
      class="plugin-region-layer plugin-region-layer--top"
      data-plugin-region="top"
    >
      <PluginRegionHost
        v-for="contribution in pluginContributionsAt('top')"
        :key="contribution.contributionKey"
        :contribution="contribution"
        :workspace-path="currentWorkspace"
        :visible="true"
      />
    </div>
    <ControlPane
      ref="controlPaneRef"
      :backend-status="backend.status.value"
      :backend-url="backendUrl"
      :agent-specs="enabledAgentSpecs"
      :roles="rolesApi.roles.value"
      :stages="stagesApi.stages.value"
      :panes="paneViews"
      :lineage="paneLineage"
      :workspaces="workspaceGroups"
      :pipeline="pipelineView"
      :existing-project="existingProject"
      :workspace="currentWorkspace"
      :mode="currentMode"
      :analyzer-status="analyzerStatus"
      :pipelines="pipelinesApi.pipelines.value"
      :active-pipeline-id="pipelinesApi.activePipelineId.value"
      :backend="backend"
      :plugin-contributions="pluginContributions"
      :legacy-git-recovery="legacyGitRecovery"
      :git-changes-count="gitChangesCount"
      v-model:yolo-enabled="yoloEnabled"
      v-model:analyzer-model="analyzerModel"
      v-model:auto-answer-enabled="autoAnswerEnabled"
      :spawn-history="spawnHistory"
      :focus-pane-id="effectiveFocusPaneId ?? undefined"
      :selected-pane-ids="selectedPaneIds"
      :can-rebuild-all="rebuildableAllPaneCount > 0"
      :rebuildable-by-workspace="rebuildableByWorkspace"
      :rebuilding-all="rebuildingTabPanes"
      :detached-window="isDetachedWindow"
      @spawn="onManualSpawn"
      @spawn-resume="onManualResume"
      @kill="onKill"
      @minimize="minimizePane"
      @toggle-collapsed="togglePaneCollapsed"
      @toggle-workspace="toggleWorkspaceCollapsed"
      @open-workspace-picker="workspacePickerOpen = true"
      @switch-to-workspace="switchToWorkspace"
      @close-workspace="closeWorkspace"
      @detach-workspace="detachWorkspace"
      @reorder-workspace="reorderWorkspace"
      @reveal-workspace-folder="revealWorkspaceFolder"
      @interrupt="onInterrupt"
      @kill-all="onKillAll"
      @rebuild="rebuildPaneViaResume"
      @rebuild-all="rebuildPanesViaResume('all', $event)"
      @restore="restorePane"
      @context-menu="(id, ev) => openPaneCtxMenu(ev, id)"
      @pipeline-start="onPipelineStart"
      @pipeline-next="onPipelineNext"
      @pipeline-abort="onPipelineAbort"
      @pipeline-reset="onPipelineReset"
      @workspace-check="onWorkspaceCheck"
      @pipeline-resume="onPipelineResume"
      @pipeline-restart="onPipelineRestart"
      @refresh-analyzer="onRefreshAnalyzer"
      @focus-pane="onSidebarFocusPane"
      @changes-count="gitChangesCount = $event"
      @reorder-pane="reorderPane"
      @open-settings="showSettings = true"
      @open-pipeline-manager="openPipelineManager"
      @open-git-accounts="openSettingsAccounts"
      @open-history="onOpenWorkspaceHistory"
      @switch-workspace="onSwitchWorkspace"
      @workspace-browse="onWorkspaceBrowse"
      :issue-handoffs="issueHandoffView"
      @dispatch-issue="onDispatchIssue"
      @spawn-for-issue="onHandleIssue"
      @rename-pane="setPaneCustomName"
      @install-cli="(p) => promptCliInstall(p.agentKey, p.label)"
      :collapsed="leftPanelCollapsed"
      :views="shellLayout.slots.left.views"
      @update:collapsed="setLeftCollapsed"
    />
    <QuestionAlert
      :visible="!!activeQuestion"
      :questions="activeQuestion?.questions ?? []"
      :agent-label="activeQuestion?.agentLabel"
      :stage-title="activeQuestion?.stageTitle"
      :slot-label="activeQuestion?.slotLabel"
      :queue-len="questionQueueLen"
      :pane-id="activeQuestion?.paneId"
      :auto-mode="autoAnswerEnabled && autoAnswerPending"
      :auto-text="autoAnswerText"
      @answer="onAnswerQuestion"
      @cancel="onCancelQuestion"
    />
    <!-- Stage-stall confirmation: shown when strict mode + idle/cap fires -->
    <Teleport v-if="stageStallPrompt" to="body">
      <div class="stall-overlay" @click.self="continueWaitingStall">
        <div class="stall-card">
          <header>
            <span class="stall-dot"></span>
            <strong>Stage {{ stageStallPrompt.stageId }} 似乎停滯了</strong>
            <span v-if="stageStallPrompt.slotLabel" class="stall-slot">· {{ stageStallPrompt.slotLabel }}</span>
          </header>
          <div class="stall-body">
            <div class="stall-title">{{ stageStallPrompt.stageTitle }}</div>
            <div class="stall-reason">
              {{ stageStallPrompt.reason === 'idle' ? '⏸ 偵測到無輸出' : '⏱ 已達時間上限' }}
              — {{ stageStallPrompt.detail }}
            </div>
            <p class="stall-hint">
              嚴格模式：未偵測到 sentinel 或完成意圖。
              選擇<strong>繼續等待</strong>會重置 idle 計時器；<strong>強制推進</strong>會把此 slot 標為完成。
            </p>
            <div v-if="stageStallPrompt.autoAdvanceAt !== null" class="stall-auto">
              🤖 Full auto: 5 秒後自動強制推進…
            </div>
          </div>
          <footer>
            <button class="stall-btn primary" @click="continueWaitingStall">⏯ 繼續等待</button>
            <button class="stall-btn danger" @click="forceAdvanceStall">⏭ 強制推進</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <CompletionModal
      v-if="showCompletionModal"
      :total-stages="stagesApi.stages.value.length"
      @close="showCompletionModal = false"
    />
    <SettingsModal
      ref="settingsModalRef"
      v-if="showSettings"
      :backend="backend"
      :roles-api="rolesApi"
      :stages-api="stagesApi"
      :analyzer-api="analyzerApi"
      :pipelines-api="pipelinesApi"
      :cli-profiles-api="cliProfilesApi"
      :workspace-open="!!currentWorkspace"
      :workspace-path="currentWorkspace"
      :workspace-paths="knownWorkspacePaths"
      :initial-tab="settingsInitialTab"
      :tab-request="settingsTabRequest"
      v-model:confirm-before-close="confirmBeforeClose"
      v-model:confirm-before-close-pane="confirmBeforeClosePane"
      v-model:yolo-enabled="yoloEnabled"
      v-model:idle-reclaim-enabled="idleReclaimEnabled"
      v-model:idle-reclaim-minutes="idleReclaimMinutes"
      :reclaimable-now-count="reclaimableNowIds.length"
      :reclaimable-now-bytes="reclaimableNowIds.length * RECLAIM_ESTIMATE_BYTES_PER_CLI"
      @reclaim-now="() => void reclaimPanesNow()"
      @close="showSettings = false; settingsInitialTab = 'general'"
      @reopen-onboarding="() => { showSettings = false; reopenOnboarding() }"
      @cli-login="onCliLoginSpawn"
    />
    <AccountModal
      v-if="accountModalEverOpened"
      :open="showAccount"
      :backend="backend"
      @close="showAccount = false"
      @changed="() => void loadP2pAccount()"
    />
    <ResourceManagerModal
      v-if="resourceManagerEverOpened"
      :open="showResourceManager"
      :backend="backend"
      :usage="resourceUsage"
      :local-rows="resourceRows"
      :auto-reclaim-on="idleReclaimEnabled"
      :auto-reclaim-minutes="idleReclaimMinutes"
      @close="showResourceManager = false"
    />
    <PipelineManagerModal
      v-if="pmEverOpened"
      ref="pmRef"
      :open="showPipelineManager"
      :backend="backend"
      :terminal-port="terminalPort"
      :roles-api="rolesApi"
      :pipelines-api="pipelinesApi"
      :workspace-path="currentWorkspace"
      :initial-pipeline-id="pmInitialPipelineId"
      @close="showPipelineManager = false"
    />
    <DebugModal
      v-if="debugEverOpened"
      :open="showDebug"
      :backend="backend"
      :terminal-port="terminalPort"
      :workspace-path="currentWorkspace"
      @close="showDebug = false"
    />
    <AgentHistoryModal
      ref="historyModalRef"
      :show="showHistory"
      :session-history="historyEntries"
      :viewing-workspace="historyWorkspaceLabel"
      :pane-count="panes.length"
      :reviving-pane-id="revivingHistoryPaneId"
      :unavailable-pane-ids="unavailableHistoryPaneIds"
      :preview-open="previewLogOpen"
      :preview-title="previewLogTitle"
      :preview-content="previewLogContent"
      :history-has-more="historyHasMore"
      :load-more-history="loadMoreHistory"
      :fetch-history-log="fetchHistoryLog"
      :search-history-log-content="searchHistoryLogsContent"
      :preview-delete="previewHistoryDelete"
      @close="showHistory = false"
      @kill-all="onKillAll"
      @resume="onResumeHistoryAgent"
      @focus-pane="onFocusHistoryPane"
      @preview="onPreviewHistoryAgent"
      @close-preview="previewLogOpen = false"
      @rename="onRenameHistoryEntry"
      @delete="onDeleteHistoryEntry"
      @cleanup="onCleanupHistory"
      @toggle-star="onToggleStarHistoryEntry"
    />
    <ReconnectSessionModal
      :show="reconnectPickerOpen"
      :orphans="reconnectOrphans"
      :loading="reconnectLoading"
      @close="reconnectPickerOpen = false"
      @select="onConfirmReconnect"
    />
    <!-- Horizontal slots. Both ship empty; SlotContainer renders nothing and
         the grid row resolves to 0px, so the default shell is unchanged. -->
    <SlotContainer
      slot-id="up"
      :views="shellLayout.slots.up.views"
      :active="shellLayout.slots.up.active"
      :collapsed="shellLayout.slots.up.collapsed"
      @update:active="(v) => setActiveView('up', v)"
      @update:collapsed="(v) => setSlotCollapsedAndRefit('up', v)"
    >
      <template #default="{ viewId }">
        <!-- pipeline.workspacePath, not currentWorkspace: that is what the
             right panel hands HistoryPanel, and it stays pinned to the running
             pipeline's workspace. A view must not change behaviour because it
             was moved. -->
        <SlotHistory v-if="viewId === 'history'" :backend="backend" :workspace-path="pipeline.workspacePath" :pipeline="pipelineView" />
        <SlotTasker v-else-if="viewId === 'tasker'" :backend="backend" />
        <SlotMessages v-else-if="viewId === 'messages'" />
      </template>
    </SlotContainer>
    <main
      ref="stageRef"
      class="stage"
      :class="{ 'stage--tabbed': stageTabs.length > 0 }"
      :data-layout="effectiveLayoutMode"
    >
      <div
        v-if="pluginContributionsAt('main').length"
        class="plugin-region-layer plugin-region-layer--main"
        data-plugin-region="main"
      >
        <PluginRegionHost
          v-for="contribution in pluginContributionsAt('main')"
          :key="contribution.contributionKey"
          :contribution="contribution"
          :workspace-path="currentWorkspace"
          :visible="true"
        />
      </div>
      <StageTabBar
        v-if="stageTabs.length > 0"
        :tabs="stageTabs"
        :model-value="activeTab"
        :can-rebuild-all="rebuildablePaneCount > 0"
        :rebuilding-all="rebuildingTabPanes"
        :rebuild-all-title="$t('action.rebuild-tab-cli-panes')"
        @add="createRunGroup()"
        @rebuild-all="rebuildPanesViaResume('tab')"
        @rename="(key, name) => renameRunGroup(key, name)"
        @delete="(key) => deleteRunGroup(key)"
        @close-group="(key) => closeRunGroup(key)"
        @move-pane="(paneId, targetKey) => movePaneToGroup(paneId, targetKey)"
        @reorder-tab="(fromKey, toKey) => reorderRunGroupTab(fromKey, toKey)"
        @detach="(key, x, y) => onDetachGroup(key, x, y)"
        @update:model-value="onUserSelectTab"
      >
        <template #actions>
          <ViewPanel :model-value="layoutMode" @update:model-value="onUserChangeLayoutMode" />
        </template>
      </StageTabBar>
      <div v-if="panes.length === 0" class="empty">
        <!-- Pipeline is starting but the first pane hasn't appeared yet.
             The orchestrator typically takes 10-30s for the first stage:
             Context7 doc fetch → CLI spawn → settle → role + kickoff inject. -->
        <div v-if="pipeline.state === 'running'" class="empty-card loading-card">
          <div class="spinner"></div>
          <h2>啟動 Pipeline 中…</h2>
          <p class="status">{{ latestPipelineLog }}</p>
          <p class="muted small">
            首個 agent 可能要 10–30 秒（Context7 文件下載 + CLI 啟動 + role/kickoff 注入）。
            <br />進度可在左下 pipeline log 觀察。
          </p>
        </div>
        <div v-else class="empty-card">
          <h2>{{ $t('label.two-ways-title') }}</h2>
          <p>
            <strong>▶ {{ $t('action.run-pipeline') }}</strong> {{ $t('label.two-ways-pipeline', { count: stagesApi.stages.value.length }) }}
          </p>
          <p>
            <strong>{{ $t('action.add-to-grid') }}</strong> {{ $t('label.two-ways-grid') }}
          </p>
          <p class="muted">{{ $t('label.set-workspace-pipeline') }}</p>
        </div>
      </div>
      <div v-else class="grid" ref="gridRef" :style="gridStyle">
        <!-- Column splitter handles (grid mode only) -->
        <div
          v-for="(pos, i) in colHandlePositions"
          :key="`ch-${i}`"
          class="grid-handle grid-handle-v"
          :style="{ left: pos }"
          @mousedown.prevent="onGridHandleStart($event, 'col', i)"
        />
        <!-- Row splitter handles (grid mode only) -->
        <div
          v-for="(pos, i) in rowHandlePositions"
          :key="`rh-${i}`"
          class="grid-handle grid-handle-h"
          :style="{ top: pos }"
          @mousedown.prevent="onGridHandleStart($event, 'row', i)"
        />
        <!-- Grid layout preset picker + pager (grid mode only) -->
        <div v-if="effectiveLayoutMode === 'grid' && tabVisiblePanes.length > 1" class="grid-layout-bar" role="toolbar" aria-label="Grid layout">
          <button
            v-for="opt in gridPresetOptions"
            :key="opt.key"
            :class="['grid-preset-btn', { active: gridPreset === opt.key }]"
            :title="opt.title"
            :aria-pressed="gridPreset === opt.key"
            @click="onUserChangeGridPreset(opt.key)"
          >{{ opt.label }}</button>
          <span class="grid-page-sep" />
          <input
            v-model.number="gridCustomCols"
            :class="['grid-custom-input', { active: gridCustomActive }]"
            type="number"
            min="1"
            max="9"
            title="Custom columns"
            @change="applyGridCustom"
            @keydown.enter="applyGridCustom"
          />
          <span class="grid-custom-x">×</span>
          <input
            v-model.number="gridCustomRows"
            :class="['grid-custom-input', { active: gridCustomActive }]"
            type="number"
            min="1"
            max="9"
            title="Custom rows"
            @change="applyGridCustom"
            @keydown.enter="applyGridCustom"
          />
          <template v-if="gridPageTotal > 1">
            <span class="grid-page-sep" />
            <button class="grid-page-btn" :disabled="gridPage <= 0" title="Previous page" @click="onUserChangeGridPage(gridPage - 1)">‹</button>
            <span class="grid-page-label">{{ gridPage + 1 }}/{{ gridPageTotal }}</span>
            <button class="grid-page-btn" :disabled="gridPage >= gridPageTotal - 1" title="Next page" @click="onUserChangeGridPage(gridPage + 1)">›</button>
          </template>
        </div>
        <!-- Sidebar/auto mode vertical handle -->
        <div
          v-if="effectiveLayoutMode === 'sidebar'"
          class="grid-handle grid-handle-v"
          :style="{ left: sidebarHandlePos }"
          @mousedown.prevent="onGridHandleStart($event, 'sidebar', 0)"
        />
        <!-- Dual-focus split handle (non-grid modes, 2 running panes) -->
        <div
          v-if="dualFocusActive"
          class="grid-handle grid-handle-v"
          :style="{ left: dualFocusHandlePos }"
          @mousedown.prevent="onGridHandleStart($event, 'dual-focus', 0)"
        />
        <template v-for="p in panes" :key="p.id">
        <TerminalPane
          v-if="p.realized"
          v-show="onScreenPaneIds.has(p.id)"
          :on-screen="onScreenPaneIds.has(p.id)"
          :style="{ ...floatPaneStyle(p.id), ...dualFocusStyle(p.id) }"
          :ref="(el) => setPaneRef(p.id, el)"
          :data-pane-id="p.id"
          :pane-id="p.id"
          :title="p.messagingName || p.customName || p.autoName || p.agentLabel"
          :auto-named="paneIsAutoNamed(p)"
          :agent-key="p.agentKey"
          :cli-session-id="p.pinnedSessionId"
          :session-home-id="p.sessionHomeId"
          :conversation-log-path="p.outputLogFile"
          :subtitle="paneSubtitle(p)"
          :pipe-tag="p.origin === 'pipeline' && p.stageId ? `P${p.stageId}` : undefined"
          :is-commander="paneIsCommander(p)"
          :is-focus="p.id === effectiveFocusPaneId"
          :is-selected="selectedPaneIds.has(p.id)"
          :selection-batch-ids="selectionBatchIds"
          :rebuild-visible="paneRebuildVisible(p)"
          :can-rebuild="paneCanRebuild(p)"
          :rebuilding="paneRebuilding(p)"
          :is-preparing="paneShowsPrepOverlay(p)"
          :preparing-label="panePreparationLabel(p)"
          :terminal-port="terminalPort"
          :cli-profiles="cliProfilesApi"
          :workspace-path="p.workspacePath"
          :mention-candidates="mentionCandidatesFor"
          @mention-pick="rememberMentionPick"
          :loop-active="p.loopActive"
          :loop-wait-until="p.loopWaitUntil"
          :loop-estimate-reset-at="p.loopEstimateResetAt"
          :login-expired="p.loginExpired"
          :continue-available="p.resumeContinueAvailable"
          :restoring="p.restoring"
          @set-focus="(ev) => onSetFocus(p.id, ev, stageSurfaceOrderedIds)"
          @first-output="onPaneFirstOutput(p.id)"
          @minimize="minimizePane(p.id)"
          @rebuild="rebuildPaneViaResume(p.id)"
          @rebuild-clean="rebuildPaneClean(p.id)"
          @rename="(name) => setPaneCustomName(p.id, name)"
          @context-menu="(ev) => openPaneCtxMenu(ev, p.id)"
          @reorder-drop="(draggedId) => reorderPane(draggedId, p.id)"
          @cli-context-drop="(sourceIds) => injectPaneContextSources(sourceIds, p.id)"
          @plan-drop="(ref) => injectPlanToPane(ref, p.id)"
          @toggle-loop="(skillId?: string) => togglePaneLoop(p.id, skillId)"
          @loop-resume-now="resumeLoopNow(p.id)"
          @fix-login="fixPaneLogin(p.id)"
          @continue-resume="continueRestoredPane(p.id)"
          @user-resume="persistPaneStopped(p.id, false)"
          @pty-lost="onPanePtyLost(p.id)"
        />
        <RestoredPanePlaceholder
          v-else
          v-show="onScreenPaneIds.has(p.id)"
          :style="{ ...floatPaneStyle(p.id), ...dualFocusStyle(p.id) }"
          :data-pane-id="p.id"
          :pane-id="p.id"
          :title="p.customName || p.autoName || p.agentLabel"
          :auto-named="paneIsAutoNamed(p)"
          :subtitle="paneSubtitle(p)"
          :pipe-tag="p.origin === 'pipeline' && p.stageId ? `P${p.stageId}` : undefined"
          :is-focus="p.id === effectiveFocusPaneId"
          :realizing="p.restoring"
          @activate="selectPane(p.id, { userInitiated: true })"
          @minimize="minimizePane(p.id)"
          @context-menu="(ev) => openPaneCtxMenu(ev, p.id)"
        />
        </template>
        <!-- Auto/sidebar mode: meeting-style agent list on the right -->
        <div v-if="effectiveLayoutMode === 'sidebar'" class="auto-meeting-list" :style="dualFocusActive ? { gridColumn: '3' } : {}">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId, 'meeting-item--selected': selectedPaneIds.has(p.id), 'pane-drag-over': auxiliaryDragOverPaneId === p.id, 'pane-dragging': auxiliaryDraggingBatchIds.includes(p.id) }"
            draggable="true"
            title="Drag to reorder or click to focus"
            @dragstart="onAuxiliaryPaneDragStart($event, p.id)"
            @dragend="onAuxiliaryPaneDragEnd"
            @dragover="onAuxiliaryPaneDragOver($event, p.id)"
            @dragenter="onAuxiliaryPaneDragOver($event, p.id)"
            @dragleave="onAuxiliaryPaneDragLeave($event, p.id)"
            @drop.prevent="onAuxiliaryPaneDrop($event, p.id)"
            @click="(ev) => onSetFocus(p.id, ev, auxiliaryListOrderedIds)"
            @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
          >
            <div class="meeting-info">
              <div class="meeting-name-row">
                <span v-if="p.origin === 'pipeline' && p.stageId" class="meeting-pipe-tag">P{{ p.stageId }}</span>
                <input
                  v-if="inlineRenamingId === p.id"
                  v-focus
                  v-model="inlineRenameDraft"
                  class="inline-rename-input"
                  @keydown="onInlineRenameKeydown"
                  @blur="commitInlineRename"
                  @click.stop
                  @mousedown.stop
                />
                <span
                  v-else
                  class="meeting-name"
                  :title="$t('action.rename')"
                  @dblclick.stop="startInlineRename(p)"
                >{{ p.agentLabel }}</span>
                <span
                  v-if="p.autoNamed && inlineRenamingId !== p.id"
                  class="auto-name-mark"
                  :title="$t('pane.terminal.auto-named-tooltip')"
                >◦</span>
              </div>
              <span class="meeting-sub">
                {{ agentSpecs.find(s => s.agentKey === p.agentKey)?.label ?? p.agentKey }}<span v-if="p.roleLabel"> · {{ p.roleLabel }}</span>
              </span>
            </div>
            <span
              v-if="p.loopActive"
              class="meeting-loop"
              :class="{ waiting: p.loopWaitUntil != null }"
            >∞ Loop</span>
            <span class="meeting-badge" :data-status="p.status">{{ $t(paneStatusLabelKey(p.status)) }}</span>
          </div>
          <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="meeting-empty">
            {{ $t('label.no-agents-yet') }}
          </div>
        </div>
      </div>
      <!-- Spotlight mode: horizontal scrollable bottom strip -->
      <div v-if="effectiveLayoutMode === 'spotlight'" class="spotlight-strip">
        <div
          v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
          :key="p.id"
          class="spotlight-thumb"
          :class="{ 'spotlight-thumb--active': p.id === effectiveFocusPaneId, 'spotlight-thumb--selected': selectedPaneIds.has(p.id), 'pane-drag-over': auxiliaryDragOverPaneId === p.id, 'pane-dragging': auxiliaryDraggingBatchIds.includes(p.id) }"
          draggable="true"
          title="Drag to reorder or click to focus"
          @dragstart="onAuxiliaryPaneDragStart($event, p.id)"
          @dragend="onAuxiliaryPaneDragEnd"
          @dragover="onAuxiliaryPaneDragOver($event, p.id)"
          @dragenter="onAuxiliaryPaneDragOver($event, p.id)"
          @dragleave="onAuxiliaryPaneDragLeave($event, p.id)"
          @drop.prevent="onAuxiliaryPaneDrop($event, p.id)"
          @click="(ev) => onSetFocus(p.id, ev, auxiliaryListOrderedIds)"
          @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
        >
          <div class="spotlight-thumb-info">
            <div class="spotlight-thumb-name-row">
              <span v-if="p.origin === 'pipeline' && p.stageId" class="spotlight-thumb-pipe-tag">P{{ p.stageId }}</span>
              <input
                v-if="inlineRenamingId === p.id"
                v-focus
                v-model="inlineRenameDraft"
                class="inline-rename-input"
                @keydown="onInlineRenameKeydown"
                @blur="commitInlineRename"
                @click.stop
                @mousedown.stop
              />
              <span
                v-else
                class="spotlight-thumb-name"
                :title="$t('action.rename')"
                @dblclick.stop="startInlineRename(p)"
              >{{ p.agentLabel }}</span>
              <span
                v-if="p.autoNamed && inlineRenamingId !== p.id"
                class="auto-name-mark"
                :title="$t('pane.terminal.auto-named-tooltip')"
              >◦</span>
            </div>
            <span class="spotlight-thumb-role">
              {{ agentSpecs.find(s => s.agentKey === p.agentKey)?.label ?? p.agentKey }}<span v-if="p.roleLabel"> · {{ p.roleLabel }}</span>
            </span>
          </div>
          <div class="spotlight-thumb-badges">
            <span
              v-if="p.loopActive"
              class="spotlight-thumb-loop"
              :class="{ waiting: p.loopWaitUntil != null }"
            >∞ Loop</span>
            <span class="spotlight-thumb-badge" :data-status="p.status">{{ $t(paneStatusLabelKey(p.status)) }}</span>
          </div>
        </div>
        <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="spotlight-strip-empty">
          {{ $t('label.no-agents-yet') }}
        </div>
      </div>
      <!-- Fullscreen mode: collapsible PiP agent list (draggable) -->
      <div
        v-if="effectiveLayoutMode === 'fullscreen'"
        ref="floatPipRef"
        class="float-pip"
        :style="{ top: floatPipPos.top + 'px', left: floatPipPos.left + 'px', width: floatPipWidth + 'px' }"
      >
        <div class="float-pip-header" @mousedown.prevent="onPipDragStart">
          <span class="float-pip-title">
            Agents ({{ paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length }})
          </span>
          <button class="float-pip-toggle" @mousedown.stop @click="floatPipExpanded = !floatPipExpanded; clampPipPos()">
            {{ floatPipExpanded ? '▾' : '▸' }}
          </button>
        </div>
        <div v-if="floatPipExpanded" class="float-pip-list" :style="{ height: floatPipListHeight + 'px' }">
          <div
            v-for="p in paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id))"
            :key="p.id"
            class="meeting-item"
            :class="{ 'meeting-item--active': p.id === effectiveFocusPaneId, 'meeting-item--selected': selectedPaneIds.has(p.id), 'pane-drag-over': auxiliaryDragOverPaneId === p.id, 'pane-dragging': auxiliaryDraggingBatchIds.includes(p.id) }"
            draggable="true"
            title="Drag to reorder or click to focus"
            @dragstart="onAuxiliaryPaneDragStart($event, p.id)"
            @dragend="onAuxiliaryPaneDragEnd"
            @dragover="onAuxiliaryPaneDragOver($event, p.id)"
            @dragenter="onAuxiliaryPaneDragOver($event, p.id)"
            @dragleave="onAuxiliaryPaneDragLeave($event, p.id)"
            @drop.prevent="onAuxiliaryPaneDrop($event, p.id)"
            @click="(ev) => onSetFocus(p.id, ev, auxiliaryListOrderedIds)"
            @contextmenu.prevent="openPaneCtxMenu($event, p.id)"
          >
            <div class="meeting-info">
              <div class="meeting-name-row">
                <span v-if="p.origin === 'pipeline' && p.stageId" class="meeting-pipe-tag">P{{ p.stageId }}</span>
                <input
                  v-if="inlineRenamingId === p.id"
                  v-focus
                  v-model="inlineRenameDraft"
                  class="inline-rename-input"
                  @keydown="onInlineRenameKeydown"
                  @blur="commitInlineRename"
                  @click.stop
                  @mousedown.stop
                />
                <span
                  v-else
                  class="meeting-name"
                  :title="$t('action.rename')"
                  @dblclick.stop="startInlineRename(p)"
                >{{ p.agentLabel }}</span>
                <span
                  v-if="p.autoNamed && inlineRenamingId !== p.id"
                  class="auto-name-mark"
                  :title="$t('pane.terminal.auto-named-tooltip')"
                >◦</span>
              </div>
              <span class="meeting-sub">
                {{ agentSpecs.find(s => s.agentKey === p.agentKey)?.label ?? p.agentKey }}<span v-if="p.roleLabel"> · {{ p.roleLabel }}</span>
              </span>
            </div>
            <span
              v-if="p.loopActive"
              class="meeting-loop"
              :class="{ waiting: p.loopWaitUntil != null }"
            >∞ Loop</span>
            <span class="meeting-badge" :data-status="p.status">{{ $t(paneStatusLabelKey(p.status)) }}</span>
          </div>
          <div v-if="paneViews.filter(v => !v.isMinimized && tabFilteredPaneIds.has(v.id)).length === 0" class="meeting-empty">
            {{ $t('label.no-agents-yet') }}
          </div>
        </div>
        <div v-if="floatPipExpanded" class="float-pip-resize" @mousedown="onPipResizeStart" />
      </div>
      <!-- Covers the stage while a workspace switch runs. Last child of the
           stage, so it paints over the grid without the grid having to know
           about it, and absolute rather than replacing the grid: tearing the
           panes out of the DOM would dispose their terminals. -->
      <Transition name="ws-switch">
        <div v-if="switchingWorkspace" class="stage-switching" role="status" aria-live="polite">
          <div class="empty-card loading-card">
            <div class="spinner"></div>
            <h2>{{ $t('switchWorkspace.loading', { name: switchingWorkspaceName }) }}</h2>
          </div>
        </div>
      </Transition>
    </main>
    <SlotContainer
      slot-id="down"
      :views="shellLayout.slots.down.views"
      :active="shellLayout.slots.down.active"
      :collapsed="shellLayout.slots.down.collapsed"
      @update:active="(v) => setActiveView('down', v)"
      @update:collapsed="(v) => setSlotCollapsedAndRefit('down', v)"
    >
      <template #default="{ viewId }">
        <!-- pipeline.workspacePath, not currentWorkspace: that is what the
             right panel hands HistoryPanel, and it stays pinned to the running
             pipeline's workspace. A view must not change behaviour because it
             was moved. -->
        <SlotHistory v-if="viewId === 'history'" :backend="backend" :workspace-path="pipeline.workspacePath" :pipeline="pipelineView" />
        <SlotTasker v-else-if="viewId === 'tasker'" :backend="backend" />
        <SlotMessages v-else-if="viewId === 'messages'" />
      </template>
    </SlotContainer>
    <TokenStatsPanel
      :backend="backend"
      :workspace-path="pipeline.workspacePath"
      :stages="stagesApi.stages.value"
      :panes="paneViews"
      :active-pane-id="effectiveFocusPaneId"
      :pipeline="pipelineView"
      :expanded="tokenPanelExpanded"
      :views="shellLayout.slots.right.views"
      @update:expanded="tokenPanelExpanded = $event"
    />
    <Welcome
      v-if="!workspaceSelected"
      :backend="backend"
      @select="onWorkspaceSelected"
      @open-settings="showSettings = true"
    />
    <!-- Same picker, reopened from the sidebar over a working window. -->
    <Welcome
      v-else-if="workspacePickerOpen"
      :backend="backend"
      dismissible
      @select="openWorkspaceFromPicker"
      @open-settings="showSettings = true"
      @close="workspacePickerOpen = false"
    />
    <Teleport v-if="confirmCloseWorkspace" to="body">
      <div class="stall-overlay" @click.self="confirmCloseWorkspace = false">
        <div class="stall-card">
          <header>
            <span class="stall-dot"></span>
            <strong>{{ $t('confirm-close.ws-title') }}</strong>
          </header>
          <div class="stall-body">
            <p class="stall-hint">
              {{ $t('confirm-close.ws-body') }}
              <template v-if="pipeline.state === 'running'"> {{ $t('confirm-close.ws-running-extra') }}</template>
            </p>
            <label class="check-row confirm-dont-show">
              <input type="checkbox" v-model="dontConfirmCloseAgain" />
              <span>{{ $t('confirm-close.dont-show-again') }}</span>
            </label>
          </div>
          <footer>
            <button class="stall-btn primary" @click="confirmCloseWorkspace = false">{{ $t('action.cancel') }}</button>
            <button class="stall-btn danger" @click="onConfirmCloseWorkspace">{{ $t('confirm-close.confirm') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <!-- Pane right-click context menu (shared by agent list, spotlight thumbs, pane headers) -->
    <Teleport v-if="paneCtxMenu" to="body">
      <div class="pane-ctx-backdrop" @mousedown="closePaneCtxMenu" @contextmenu.prevent="closePaneCtxMenu" />
      <div ref="paneCtxMenuEl" class="pane-ctx" :style="{ left: paneCtxMenu.x + 'px', top: paneCtxMenu.y + 'px' }" @click.stop @mousedown.stop>
        <template v-if="ctxIsBatch">
          <div class="pane-ctx-header">{{ $t('action.selected-count', { count: ctxTargetIds.length }) }}</div>
          <div class="pane-ctx-item" @click="batchInterrupt(ctxTargetIds); closePaneCtxMenu()">{{ $t('action.interrupt-selected') }}</div>
          <div class="pane-ctx-item" @click="batchRebuild(ctxTargetIds); closePaneCtxMenu()">{{ $t('action.rebuild-selected') }}</div>
          <div class="pane-ctx-item" @click="batchMinimize(ctxTargetIds); closePaneCtxMenu()">{{ $t('action.minimize-selected') }}</div>
          <div class="pane-ctx-item" @click="batchRestore(ctxTargetIds); closePaneCtxMenu()">{{ $t('action.restore-selected') }}</div>
          <div class="pane-ctx-sep"></div>
          <div class="pane-ctx-item danger" @click="batchKill(ctxTargetIds); closePaneCtxMenu()">{{ $t('action.remove-selected') }}</div>
        </template>
        <template v-else>
        <div class="pane-ctx-item" @click="onSetFocus(paneCtxMenu!.paneId); closePaneCtxMenu()">{{ $t('action.focus') }}</div>
        <div
          v-if="paneCtxView?.isMinimized"
          class="pane-ctx-item"
          @click="restorePane(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.restore') }}</div>
        <div class="pane-ctx-item" @click="startRenamePane(paneCtxMenu!.paneId)">{{ $t('action.rename') }}</div>
        <div
          v-if="isGhostPane(paneCtxView)"
          class="pane-ctx-item"
          @click="openReconnectPicker(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('reconnect.menu-item') }}</div>
        <div class="pane-ctx-sep"></div>
        <div
          class="pane-ctx-item"
          :class="{ disabled: paneCtxView?.status !== 'running' }"
          @click="onInterrupt(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.interrupt') }}</div>
        <div
          class="pane-ctx-item"
          :class="{ disabled: paneCtxView?.status !== 'running' || !paneCtxView?.roleKey }"
          @click="onReinject(paneCtxMenu!.paneId); closePaneCtxMenu()"
        >{{ $t('action.reapply-role') }}</div>
        <div class="pane-ctx-sep"></div>
        <div class="pane-ctx-item danger" @click="onKill(paneCtxMenu!.paneId); closePaneCtxMenu()">{{ $t('action.remove') }}</div>
        </template>
      </div>
    </Teleport>
    <!-- Pane rename dialog -->
    <Teleport v-if="renamingPane" to="body">
      <div class="stall-overlay" @click.self="renamingPane = null">
        <div class="stall-card pane-rename-card">
          <header>
            <strong>{{ $t('action.rename') }}</strong>
          </header>
          <div class="stall-body">
            <input
              ref="renameInput"
              v-model="renamingPane.value"
              class="pane-rename-input"
              type="text"
              @keydown.enter="confirmRenamePane"
              @keydown.esc="renamingPane = null"
            />
          </div>
          <footer>
            <button class="stall-btn" @click="renamingPane = null">{{ $t('action.cancel') }}</button>
            <button class="stall-btn primary" @click="confirmRenamePane">{{ $t('action.rename') }}</button>
          </footer>
        </div>
      </div>
    </Teleport>
    <div v-if="leftHandleVisible" class="resize-handle resize-handle-left" @mousedown="onResizeStart($event, 'left')" />
    <div v-if="rightHandleVisible" class="resize-handle resize-handle-right" @mousedown="onResizeStart($event, 'right')" />
    <div
      v-if="pluginContributionsAt('right').length"
      class="plugin-region-layer plugin-region-layer--right"
      data-plugin-region="right"
    >
      <PluginRegionHost
        v-for="contribution in pluginContributionsAt('right')"
        :key="contribution.contributionKey"
        :contribution="contribution"
        :workspace-path="currentWorkspace"
        :visible="true"
      />
    </div>
    <NotificationHost />
    <WhatsNewModal v-if="whatsNewEntry" :entry="whatsNewEntry" @close="dismissWhatsNew" />
    <!-- Status bar -->
    <div v-if="shellLayout.chrome.statusbar" class="statusbar">
      <div
        v-if="pluginContributionsAt('bottom').length"
        class="plugin-region-layer plugin-region-layer--bottom"
        data-plugin-region="bottom"
      >
        <PluginRegionHost
          v-for="contribution in pluginContributionsAt('bottom')"
          :key="contribution.contributionKey"
          :contribution="contribution"
          :workspace-path="currentWorkspace"
          :visible="true"
        />
      </div>
      <div class="statusbar-left">
        <span v-if="statusBarGit.branch" class="sb-item sb-git">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
          </svg>
          {{ statusBarGit.branch }}{{ statusBarGit.dirty ? '*' : '' }}
        </span>
        <span v-if="statusBarGit.behind > 0 || statusBarGit.ahead > 0" class="sb-item sb-sync">
          <span v-if="statusBarGit.behind > 0">{{ statusBarGit.behind }}↓</span>
          <span v-if="statusBarGit.ahead > 0"> {{ statusBarGit.ahead }}↑</span>
        </span>
        <span
          class="sb-item sb-backend sb-clickable"
          :class="'sb-' + backend.status.value"
          role="button"
          tabindex="0"
          @click="togglePopover('backend')"
          @keydown.enter="togglePopover('backend')"
        >
          <span class="sb-dot" />
          {{ backendPillLabel }}
          <span v-if="backendUrl" class="sb-url">· {{ backendUrl }}</span>
        </span>
        <span
          v-if="panes.length > 0"
          class="sb-item sb-resource sb-clickable"
          role="button"
          tabindex="0"
          :title="resourcePillTitle"
          @click="togglePopover('resource')"
          @keydown.enter="togglePopover('resource')"
        >
          {{ resourcePillText }}
        </span>
        <span
          v-if="['available', 'downloading', 'downloaded', 'error'].includes(updateState.status)"
          class="sb-item sb-update sb-clickable"
          :class="'sb-update-' + updateState.status"
          role="button"
          tabindex="0"
          :title="updateState.status === 'error'
            ? updateState.message
            : updateState.status === 'downloaded'
              ? (updateState.availableVersion ? `v${updateState.availableVersion} — ${$t('updater.install')}` : $t('updater.install'))
              : updateState.status === 'available'
                ? (updateState.availableVersion ? `v${updateState.availableVersion} — ${$t('updater.download')}` : $t('updater.download'))
                : (updateState.availableVersion ? `v${updateState.availableVersion}` : undefined)"
          @click="onUpdateBadgeClick"
          @keydown.enter="onUpdateBadgeClick"
        >
          <span class="sb-dot" />
          <template v-if="updateState.status === 'downloading'">↓{{ updateState.percent ?? 0 }}%</template>
          <template v-else-if="updateState.status === 'downloaded'">
            {{ updateState.quitInstallArmed ? $t('updater.restart-on-quit') : $t('updater.restart') }}
          </template>
          <template v-else-if="updateState.status === 'error'">{{ $t('updater.badge-error') }}</template>
          <template v-else>↑{{ updateState.availableVersion }}</template>
        </span>
        <span
          v-else-if="showUpdateCheckFailure"
          class="sb-item sb-update sb-update-check-failed sb-clickable"
          role="button"
          tabindex="0"
          :title="updateState.lastCheckFailure?.message"
          @click="onUpdateBadgeClick"
          @keydown.enter="onUpdateBadgeClick"
        >
          <span class="sb-dot" />
          {{ $t('updater.badge-check-failed') }}
        </span>
      </div>
      <div class="statusbar-right">
        <span v-if="pipeline.state !== 'idle'" class="sb-item sb-pipeline" :class="'sb-' + pipeline.state">
          {{ pipeline.state === 'running'
            ? `Stage ${pipeline.stageIndex + 1} / ${stagesApi.stages.value.length || '?'}`
            : pipeline.state }}
        </span>
        <span
          v-if="backfill.active"
          class="sb-item sb-backfill"
          :title="$t('backfill.title')"
        >↻ {{ $t('backfill.tidying', { count: backfill.count }) }}</span>
        <span
          v-if="orphanCount > 0"
          class="sb-item sb-orphans"
          :title="$t('orphans.title')"
          @click="reapOrphans"
        >⚠ {{ orphanCount }} {{ $t('orphans.leftover') }}</span>
        <span
          v-if="!isDetachedWindow && disconnectedCount > 0 && !reconnectBannerDismissed"
          class="sb-item sb-reconnect"
        >
          <span
            class="sb-reconnect-text"
            :title="$t('reconnect.banner-title')"
            @click="openReconnectPicker(disconnectedPaneIds[0])"
          >⚡ {{ $t('reconnect.banner', { count: disconnectedCount }) }}</span>
          <span class="sb-reconnect-dismiss" :title="$t('restore.dismiss')" @click="dismissReconnectBanner">✕</span>
        </span>
        <span
          class="sb-item sb-clickable sb-announce"
          :class="{ 'sb-announce-unread': announcements.unreadCount.value > 0 }"
          role="button"
          tabindex="0"
          :title="$t('announce.title')"
          @click="togglePopover('announcements')"
          @keydown.enter="togglePopover('announcements')"
        >
          📢<span v-if="appVersion" class="sb-version">v{{ appVersion }}</span
          ><template v-if="announcements.unreadCount.value > 0"> {{ announcements.unreadCount.value }}</template>
        </span>
        <span
          class="sb-item sb-clickable sb-clock"
          role="button"
          tabindex="0"
          :title="$t('clock.title')"
          @click="togglePopover('clock')"
          @keydown.enter="togglePopover('clock')"
        >{{ clockLabel }}</span>
        <span
          v-if="!isDetachedWindow && panes.length > 0"
          class="sb-item sb-clickable sb-close-all"
          :title="$t('closeAll.title')"
          @click="closeAllSessions"
        >✕</span>
      </div>
    </div>

    <!-- Backend supervisor popover -->
    <div v-if="openPopover === 'backend'" class="bp-backdrop" @click="closePopover()" />
    <div v-if="openPopover === 'backend'" class="bp-pop" @click.stop>
      <div class="bp-head">
        <span class="bp-dot sb-backend" :class="'sb-' + backend.status.value" />
        <span class="bp-title">Backend</span>
        <span class="bp-state" :class="'sb-' + backend.status.value">{{ backend.status.value }}</span>
      </div>
      <div class="bp-rows">
        <div class="bp-row"><span class="bp-k">URL</span><span class="bp-v">{{ backendUrl || '—' }}</span></div>
        <div class="bp-row"><span class="bp-k">PID</span><span class="bp-v">{{ backend.pid.value || '—' }}</span></div>
      </div>
      <div class="bp-actions">
        <button class="bp-btn bp-restart" :disabled="backendBusy" @click="onRestartBackend">
          {{ backendBusy ? 'working…' : (backend.status.value === 'connected' ? 'Restart' : 'Start') }}
        </button>
        <button
          class="bp-btn bp-stop"
          :disabled="backendBusy || backend.status.value !== 'connected'"
          @click="onStopBackend"
        >Stop</button>
      </div>
    </div>

    <!-- Announcements centre popover -->
    <AnnouncementsPanel
      v-if="openPopover === 'announcements'"
      :items="announcements.items.value"
      @close="closePopover()"
      @mark-all-read="announcements.markAllRead()"
      @read="announcements.markRead($event)"
      @download="startUpdateDownload()"
      @install="onUpdateBadgeClick()"
    />

    <!-- Clock popover -->
    <ClockPanel
      v-if="openPopover === 'clock'"
      :now="clockNow"
      :started-at="sessionStartedAt"
      :project-created-at="projectCreatedAt"
      :build-tag="buildTag"
      @close="closePopover()"
    />

    <!-- Resource summary popover (CPU + memory + reclaim) -->
    <ResourceSummaryPanel
      v-if="openPopover === 'resource'"
      :rows="resourceRows"
      :measured="resourceUsage.measured.value"
      :available="resourceUsage.available.value"
      :cpu-available="resourceUsage.cpuAvailable.value"
      :cpu-share="resourceCpuShare"
      :memory-share="resourceMemoryShare"
      :total-bytes="resourceTotals.bytes"
      :total-cpu-percent="resourceTotals.cpu"
      @close="closePopover()"
      @reclaim="() => void onResourceReclaim()"
      @jump="onResourceJump"
      @open-window="openResourceManager"
    />
  </div>
</template>

<style scoped>
/* First-boot loading overlay */
.boot-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  /* The shell's font-family lives on `.app`, and this overlay is its sibling,
     not its child — without this the status line falls back to the browser
     default and renders in a serif face. */
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
}
.boot-card {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.boot-logo {
  width: 72px;
  height: 72px;
  display: block;
  animation: boot-breathe 2.6s ease-in-out infinite;
}
.boot-spinner {
  margin-top: 30px;
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--accent-bright);
  border-radius: 50%;
  animation: boot-spin 0.8s linear infinite;
}
.boot-status {
  margin-top: 18px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}
.boot-elapsed {
  /* Ticks once a second, so keep the digits from shifting the line around. */
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
}
.boot-status-error {
  color: var(--danger-fg);
}
.boot-retry {
  margin-top: 16px;
  font-size: var(--font-xs);
  padding: 6px 16px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
}
.boot-retry:hover {
  background: var(--bg-elevated);
}
@keyframes boot-spin {
  to { transform: rotate(360deg); }
}
@keyframes boot-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.78; transform: scale(0.965); }
}
@media (prefers-reduced-motion: reduce) {
  .boot-logo { animation: none; }
  .boot-spinner { animation-duration: 2.4s; }
}
/* Fade the overlay out (no enter transition — it's there from first paint). */
.boot-fade-leave-active { transition: opacity 0.3s ease; }
.boot-fade-leave-to { opacity: 0; }

.app {
  display: grid;
  /* Three columns: controls · terminal grid · token stats panel, with both
     side widths driven by CSS vars set inline.

     minmax, not bare lengths. A bare `360px` track keeps its full width even
     when the window is narrower than the panels put together: the `1fr` stage
     collapses to zero, the grid overflows, and `overflow: hidden` clips the
     right column off-screen — along with the drag handle that would have let
     the user shrink the panel again. With minmax the side panels give ground
     instead, so nothing is ever pushed out of reach.

     The stage keeps a floor so the terminal never disappears outright; the
     side panels are what yield. Their stored widths are untouched — only what
     is rendered shrinks, so the layout returns to normal when the window
     widens again. */
  grid-template-columns:
    minmax(0, var(--left-width, 360px))
    minmax(var(--stage-min-width, 220px), 1fr)
    minmax(0, var(--token-panel-width, 36px));
  /* Three rows: the up slot, the stage, the down slot. Both horizontal slots
     ship empty, and an empty slot resolves to 0px — so the default shell is
     the same single-row layout it has always been, to the pixel.

     Every in-flow child must now declare its own grid-row. Auto-placement with
     explicit rows would drop the sidebar into the `up` strip; with no explicit
     rows it used to open an implicit second row instead, which is the failure
     that put the handles off-screen. Both are silent, so the placements below
     are load-bearing rather than tidy. */
  grid-template-rows:
    minmax(0, var(--up-height, 0px))
    minmax(var(--stage-min-height, 140px), 1fr)
    minmax(0, var(--down-height, 0px));
  position: relative;
  height: 100vh;
  background: var(--bg-inset);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  overflow: hidden;
  box-sizing: border-box;
  padding-top: 38px;
  /* The status bar is an absolute overlay, so the shell reserves its height as
     padding rather than as a grid row. Hiding it therefore means zeroing this,
     not removing a track. */
  padding-bottom: var(--chrome-bottom, 24px);
}

/* Native plugin views are positioned from these DOM anchors. Empty locations
   render no anchor, so an app with no installed contribution has no plugin
   slot, button, or prompt. */
.plugin-region-layer {
  position: absolute;
  min-width: 0;
  min-height: 0;
  pointer-events: none;
  z-index: 120;
}
.plugin-region-layer :deep(.plugin-region-host) {
  pointer-events: none;
}
.plugin-region-layer--top {
  top: 38px;
  left: var(--left-width, 360px);
  right: var(--token-panel-width, 36px);
  height: 32px;
}
.plugin-region-layer--main {
  inset: 0;
  z-index: 110;
}
.plugin-region-layer--right {
  top: 38px;
  right: var(--token-panel-width, 36px);
  bottom: 24px;
  width: min(320px, 28vw);
}
.plugin-region-layer--bottom {
  top: 0;
  left: var(--left-width, 360px);
  right: var(--token-panel-width, 36px);
  height: 24px;
}

/* ── Custom Titlebar ─────────────────────────────────────────────────────────── */
.titlebar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  z-index: 200;
  user-select: none;
  /* leave 80px on the left for macOS traffic lights */
  padding-left: 80px;
  padding-right: 8px;
}
.titlebar-name {
  flex: 1;
  text-align: center;
  min-width: 0;
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Sized to its text, with the two spacers either side doing the centring —
   `flex: 1` would let it take a third of the bar and drift as they change. */
.titlebar-name--ws {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  padding: 0 8px;
  color: var(--text-primary);
}
/* Name normally, path while the pointer is on it. The bar is a drag region,
   and a drag region swallows hover — so this one patch of it opts out. Sized
   to a fixed share of the bar rather than to its text, and stretched to the
   full bar height: hovering it swaps the name for a longer path, and a hot
   zone that hugged the short name would slip out from under the pointer the
   moment it did. The spacers either side keep their drag region so the window
   can still be moved by its titlebar. */
.titlebar-id {
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  flex: 0 0 70%;
  min-width: 0;
  -webkit-app-region: no-drag;
}
.titlebar-path {
  display: none;
  min-width: 0;
  padding: 0 8px;
  font-size: var(--font-2xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.titlebar-id:hover .titlebar-name--ws { display: none; }
.titlebar-id:hover .titlebar-path { display: block; }
/* Appears with the path and only with it: a button on a bar that otherwise
   shows a project name would read as acting on the project, not the folder. */
.titlebar-reveal {
  display: none;
  align-items: center;
  flex: none;
  padding: 0 4px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
.titlebar-id:hover .titlebar-reveal { display: flex; }
.titlebar-reveal:hover { color: var(--text-bright); }
/* Fills the bar between the traffic lights and the gear, and stays draggable
   so the empty stretch still moves the window. */
.titlebar-spacer {
  flex: 1;
  min-width: 0;
  -webkit-app-region: drag;
}
.titlebar-ws-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  font-size: var(--font-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
  cursor: default;
}
.titlebar-ws-btn {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  width: 26px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 0;
}
.titlebar-ws-btn:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.titlebar-gear {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.titlebar-gear:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.titlebar-plugin-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
  flex-shrink: 0;
}
/* Same shape as .titlebar-gear: these sit in the same row and open the same
   kind of thing, so they read as one set of icon buttons rather than a
   bordered pill wedged between two bare glyphs. */
.titlebar-plugin-action {
  -webkit-app-region: no-drag;
  flex-shrink: 0;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.titlebar-plugin-action:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
/* Sign-in / account button: the gear's shape, widened by a short label so a
   signed-in user sees who they are without opening anything. */
/* Icon-only, same box as .titlebar-gear so the cluster reads as one row of
   equal icons; the link state is a small badge on the icon's corner and the
   account text lives in the tooltip. */
.titlebar-account {
  -webkit-app-region: no-drag;
  position: relative;
  flex-shrink: 0;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.titlebar-account:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.titlebar-account-dot {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-secondary);
  box-shadow: 0 0 0 1.5px var(--bg-base);
}
.titlebar-account-dot.ok { background: var(--success-fg); }
.titlebar-account-dot.err { background: var(--danger-fg); }
.titlebar-account-dot.warn { background: var(--attention-fg); }
/* Same reasoning as .plugin-tab-icon in ControlPane: the gear beside this is
   a 14px SVG with padding inside its viewBox, while plugin artwork fills its
   bitmap edge to edge, so an equal box makes the plugin icon look bigger than
   everything around it. */
.titlebar-plugin-icon {
  display: block;
  width: 12px;
  height: 12px;
  object-fit: contain;
  border-radius: 3px;
}
.titlebar-plugin-fallback {
  font-size: 12px;
  line-height: 1;
}

/* ── Status Bar ──────────────────────────────────────────────────────────────── */
.statusbar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 200;
  user-select: none;
  padding: 0 8px;
  font-size: var(--font-2xs);
}
.statusbar-left,
.statusbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sb-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  height: 22px;
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: default;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.sb-item:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.sb-git { gap: 5px; }
.sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.sb-backend.sb-connected .sb-dot { background: var(--success-fg); }
.sb-backend:not(.sb-connected) .sb-dot { background: var(--danger-fg); }
.sb-pipeline.sb-running { color: var(--accent-fg); }
.sb-pipeline.sb-completed { color: var(--success-fg); }
.sb-pipeline.sb-aborted { color: var(--danger-fg); }

/* Same weight as the agent count beside it — this is an ambient reading, not
   an alert, even when it is offering something to reclaim. */
.sb-resource { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.sb-backfill { color: var(--text-secondary); opacity: 0.85; }
.sb-update-available .sb-dot { background: var(--accent-fg); }
.sb-update-downloading .sb-dot { background: var(--attention-fg); }
.sb-update-downloaded .sb-dot { background: var(--success-fg); }
.sb-update-error .sb-dot { background: var(--danger-fg); }
.sb-update-check-failed { color: var(--text-muted); }
.sb-update-check-failed .sb-dot { background: var(--text-muted); }
.sb-announce-unread { color: var(--accent-fg); }
.sb-clickable { cursor: pointer; }

/* ── Backend supervisor popover ──────────────────────────────────────────── */
.bp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.bp-pop {
  position: fixed;
  left: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 280px;
  padding: 10px;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  color: var(--text-secondary);
  user-select: none;
}
.bp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.bp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.bp-dot.sb-connected { background: var(--success-fg); }
.bp-dot:not(.sb-connected) { background: var(--danger-fg); }
.bp-title {
  font-weight: 600;
  color: var(--text-bright);
}
.bp-state {
  margin-left: auto;
  text-transform: capitalize;
}
.bp-state.sb-connected { color: var(--success-fg); }
.bp-state:not(.sb-connected) { color: var(--danger-fg); }
.bp-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.bp-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bp-k {
  width: 36px;
  flex-shrink: 0;
  color: var(--text-muted);
}
.bp-v {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-bright);
  word-break: break-all;
}
.bp-actions {
  display: flex;
  gap: 8px;
}
.bp-btn {
  flex: 1;
  height: 28px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-hover);
  color: var(--text-bright);
  cursor: pointer;
  font-size: var(--font-xs);
  transition: background 0.12s, opacity 0.12s;
}
.bp-btn:hover:not(:disabled) { background: var(--bg-active, var(--bg-hover)); }
.bp-btn:disabled { opacity: 0.45; cursor: default; }
.bp-restart { border-color: var(--accent-focus); color: var(--accent-fg); }
.bp-stop { border-color: var(--danger-fg); color: var(--danger-fg); }
.resize-handle {
  position: relative;
  align-self: stretch;
  width: 8px;
  cursor: col-resize;
  z-index: 50;
}
.resize-handle::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle:hover::after {
  background: color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.is-resizing-shell .resize-handle::after {
  background: color-mix(in srgb, var(--accent-focus) 40%, transparent);
}
/* Reads the same vars grid-template-columns does. That duplication is a real
   hazard for the layout rewrite — change the track definition and these still
   drag correctly while being drawn in the old place — but it is the shipped
   behaviour, and Phase 0 is not the place to change behaviour. The slot shell
   replaces both together. */
/* The side panels live in ControlPane / TokenStatsPanel, but a child
   component's root element carries the parent's scope id too, so the shell
   places them from here rather than telling each component which cell it is
   in — the arrangement is the shell's business, not theirs. */
.sidebar {
  grid-column: 1;
  grid-row: 1 / 4;
}
.token-panel {
  grid-column: 3;
  grid-row: 1 / 4;
}

/* Grid items sharing their panel's cell and hugging the edge that faces the
   stage. The previous form positioned them from --left-width /
   --token-panel-width — the same vars grid-template-columns reads — so a track
   definition and a handle position had to be kept in step by hand, and a slot
   that collapses to a rail broke the arithmetic outright.

   grid-row is mandatory. Without it auto-placement cannot fit a handle beside a
   row whose columns are all taken, so it opens a second row: the shell stretches
   past the window and the handles land off-screen. */
.resize-handle-left {
  grid-row: 1 / 4;
  grid-column: 1;
  justify-self: end;
  transform: translateX(50%);
}
.resize-handle-right {
  grid-row: 1 / 4;
  grid-column: 3;
  justify-self: start;
  transform: translateX(-50%);
}
/* Column 2, rows 1 and 3 — the horizontal slots. `spanMode: 'inner'` (the
   shipped default) is what keeps them between the side panels rather than
   spanning the window. */
.slot--up {
  grid-column: 2;
  grid-row: 1;
}
.slot--down {
  grid-column: 2;
  grid-row: 3;
}

/* Column 2, middle row. The side panels span all three rows so the horizontal
   slots sit between them (`spanMode: 'inner'`, the shipped default). */
.stage {
  grid-column: 2;
  grid-row: 2;
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 8px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.stage--tabbed {
  padding-top: 0;
}
.stage--tabbed .empty,
.stage--tabbed .grid {
  margin-top: 8px;
}
.grid {
  display: grid;
  /* grid-template-columns/rows are driven by gridStyle computed (JS) */
  gap: 8px;
  flex: 1;
  min-height: 0;
  position: relative;
}
/* Grid pane splitter handles */
.grid-handle {
  position: absolute;
  z-index: 20;
}
.grid-handle::after {
  content: '';
  position: absolute;
  background: transparent;
  transition: background 0.15s;
}
.grid-handle:hover::after,
.is-resizing-grid .grid-handle::after {
  background: color-mix(in srgb, var(--accent-focus) 33%, transparent);
}
.grid-handle-v {
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  transform: translateX(-50%);
}
.grid-handle-v::after {
  inset: 0 3px;
}
.grid-handle-h {
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  transform: translateY(-50%);
}
.grid-handle-h::after {
  inset: 3px 0;
}
/* Grid layout preset picker + pager */
.grid-layout-bar {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  backdrop-filter: blur(4px);
}
.grid-preset-btn,
.grid-page-btn {
  min-width: 26px;
  height: 22px;
  padding: 0 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.grid-preset-btn:hover,
.grid-page-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.grid-preset-btn.active {
  background: color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
  color: var(--accent-bright);
}
.grid-page-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.grid-page-sep {
  width: 1px;
  height: 14px;
  background: var(--border-default);
  margin: 0 3px;
}
.grid-custom-input {
  width: 30px;
  height: 22px;
  padding: 0 2px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  text-align: center;
  -moz-appearance: textfield;
  appearance: textfield;
}
.grid-custom-input::-webkit-inner-spin-button,
.grid-custom-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.grid-custom-input:focus {
  outline: none;
  border-color: var(--accent-focus);
  color: var(--text-primary);
}
.grid-custom-input.active {
  border-color: var(--accent-emphasis);
  color: var(--accent-bright);
  background: color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
}
.grid-custom-x {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.grid-page-label {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  padding: 0 2px;
}
/* Spotlight: stage as flex column — grid on top, scroll strip on bottom */
.stage[data-layout="spotlight"] {
  display: flex;
  flex-direction: column;
  padding: 0;
}
.stage[data-layout="spotlight"] .grid {
  flex: 1;
  min-height: 0;
  margin: 8px 8px 0;
}
/* Spotlight horizontal scrollable bottom strip */
.spotlight-strip {
  flex-shrink: 0;
  height: 104px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 10px;
  background: var(--bg-base);
  border-top: 1px solid var(--border-muted);
  scrollbar-width: thin;
  scrollbar-color: var(--border-default) transparent;
}
.spotlight-strip::-webkit-scrollbar { height: 4px; }
.spotlight-strip::-webkit-scrollbar-track { background: transparent; }
.spotlight-strip::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 2px; }
.spotlight-thumb {
  flex-shrink: 0;
  width: 160px;
  height: 84px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  padding: 9px 12px;
  cursor: grab;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  transition: border-color 0.12s, box-shadow 0.12s;
  overflow: hidden;
}
.spotlight-thumb:active,
.spotlight-thumb.pane-dragging {
  cursor: grabbing;
}
.spotlight-thumb:hover {
  border-color: var(--accent-muted);
  box-shadow: 0 2px 12px color-mix(in srgb, var(--accent-focus) 15%, transparent);
  background: var(--bg-elevated);
}
.spotlight-thumb--active {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 8%, var(--bg-elevated));
}
.spotlight-thumb--selected {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 55%, transparent);
  background: color-mix(in srgb, var(--accent-focus) 16%, var(--bg-elevated));
}
.spotlight-thumb-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.spotlight-thumb-name-row {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.spotlight-thumb-pipe-tag {
  font-size: 8px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.inline-rename-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  color: var(--text-bright);
  font-size: var(--font-2xs);
  padding: 1px 3px;
  min-width: 0;
}
.inline-rename-input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.spotlight-thumb-name {
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotlight-thumb-role {
  font-size: 9px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.spotlight-thumb-badges {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
}
.spotlight-thumb-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
}
.spotlight-thumb-badge[data-status="running"]  { background: var(--success-subtle); color: var(--success-fg); border: 1px solid var(--success-emphasis); }
.spotlight-thumb-badge[data-status="idle"]     { background: var(--attention-subtle); color: var(--attention-bright); border: 1px solid var(--attention-emphasis); }
.spotlight-thumb-badge[data-status="starting"] { background: var(--status-starting-subtle); color: var(--status-starting-fg); border: 1px solid var(--status-starting-emphasis); }
.spotlight-thumb-badge[data-status="error"]    { background: var(--danger-subtle); color: var(--danger-fg); border: 1px solid var(--danger-emphasis); }
.spotlight-thumb-badge[data-status="stopped"]  { background: #000000; color: #ffffff; border: 1px solid #3f3f46; }
.spotlight-thumb-badge[data-status="awaiting"] { background: color-mix(in srgb, var(--warning-fg) 20%, transparent); color: var(--warning-fg); border: 1px solid color-mix(in srgb, var(--warning-fg) 45%, transparent); }
.spotlight-thumb-badge[data-status="exited"]   { background: var(--bg-muted); color: var(--text-primary); border: 1px solid var(--border-default); }
.spotlight-thumb-loop {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--success-subtle);
  color: var(--success-fg);
  border: 1px solid var(--success-emphasis);
  white-space: nowrap;
}
.spotlight-thumb-loop.waiting {
  opacity: 0.55;
}
.spotlight-strip-empty {
  color: var(--text-disabled);
  font-size: var(--font-2xs);
  padding: 0 8px;
}
/* Sidebar (Auto): focus pane fills left column; meeting list in right column */
.stage[data-layout="sidebar"] .grid :deep(.pane-focus) {
  grid-column: 1;
  grid-row: 1;
}
/* Meeting-style agent list */
.auto-meeting-list {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  padding: 8px 6px;
  background: var(--bg-base);
  /* Same number as MEETING_LIST_MIN_PX. The track reserves at least this much,
     so this floor is a backstop rather than a source of overflow. */
  min-width: 140px;
}
.meeting-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-muted);
  cursor: grab;
  user-select: none;
  transition: background 0.12s, border-color 0.12s;
  min-width: 0;
}
.meeting-item:active,
.meeting-item.pane-dragging {
  cursor: grabbing;
}
.meeting-item:hover {
  background: var(--bg-subtle);
  border-color: var(--accent-muted);
}
.meeting-item--active {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 8%, var(--bg-elevated));
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.meeting-item--selected {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 16%, var(--bg-elevated));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 55%, transparent);
}
.meeting-item.pane-drag-over,
.spotlight-thumb.pane-drag-over {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 13%, var(--bg-elevated));
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.meeting-item.pane-dragging,
.spotlight-thumb.pane-dragging {
  opacity: 0.55;
}
.meeting-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meeting-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.meeting-pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.meeting-name {
  font-size: var(--font-xs);
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
/* Auto-name marker, shared by the sidebar/stack lists and the spotlight strip.
   Same weight as TerminalPane's so one pane reads identically everywhere. */
.auto-name-mark {
  flex-shrink: 0;
  font-size: 0.75em;
  line-height: 1;
  opacity: 0.45;
  margin-left: -2px; /* pulls back the row gap so the mark hugs the name */
  user-select: none;
}
.meeting-sub {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meeting-badge {
  font-size: var(--font-3xs);
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.meeting-badge[data-status="running"]  { background: var(--success-subtle); color: var(--success-fg); border: 1px solid var(--success-emphasis); }
.meeting-badge[data-status="idle"]     { background: var(--attention-subtle); color: var(--attention-bright); border: 1px solid var(--attention-emphasis); }
.meeting-badge[data-status="stopped"]  { background: #000000; color: #ffffff; border: 1px solid #3f3f46; }
.meeting-badge[data-status="starting"] { background: var(--status-starting-subtle); color: var(--status-starting-fg); border: 1px solid var(--status-starting-emphasis); }
.meeting-badge[data-status="error"]    { background: var(--danger-subtle); color: var(--danger-bright); border: 1px solid var(--danger-emphasis); }
.meeting-badge[data-status="awaiting"] { background: color-mix(in srgb, var(--warning-fg) 20%, transparent); color: var(--warning-fg); border: 1px solid color-mix(in srgb, var(--warning-fg) 45%, transparent); }
.meeting-badge[data-status="exited"]   { background: var(--bg-muted); color: var(--text-primary); border: 1px solid var(--border-default); }
.meeting-loop {
  font-size: var(--font-3xs);
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
  background: var(--success-subtle);
  color: var(--success-fg);
  border: 1px solid var(--success-emphasis);
  white-space: nowrap;
}
.meeting-loop.waiting {
  opacity: 0.55;
}
.meeting-empty {
  color: var(--text-disabled);
  font-size: var(--font-2xs);
  text-align: center;
  padding: 16px 8px;
}
/* Fullscreen: focus pane fills entire grid */
.stage[data-layout="fullscreen"] .grid :deep(.pane-focus) {
  grid-column: 1;
  grid-row: 1;
}
/* Fullscreen PiP collapsible list */
.float-pip {
  position: absolute;
  z-index: 30;
  min-width: 160px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 32px var(--shadow-overlay);
  backdrop-filter: blur(8px);
}
.float-pip-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 40%, var(--border-default) 40%, var(--border-default) 60%, transparent 60%),
              linear-gradient(135deg, transparent 60%, var(--border-default) 60%, var(--border-default) 80%, transparent 80%);
  opacity: 0.5;
  border-radius: 0 0 8px 0;
}
.float-pip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  cursor: move;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  user-select: none;
}
.float-pip-title {
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-secondary);
}
.float-pip-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 0 2px;
  line-height: 1;
}
.float-pip-toggle:hover { color: var(--text-bright); }
.float-pip-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  height: 320px;
  overflow-y: auto;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.empty-card {
  text-align: center;
  max-width: 520px;
  padding: 28px 32px;
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  background: var(--bg-base);
}
.empty-card h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.empty-card p {
  margin: 8px 0;
  font-size: var(--font-sm);
  color: var(--text-primary);
  text-align: left;
}
.empty-card .muted {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.empty-card.loading-card {
  border-style: solid;
  border-color: var(--accent-muted);
  background: linear-gradient(180deg, var(--bg-base) 0%, var(--accent-subtle) 100%);
}
.empty-card.loading-card h2 {
  text-align: center;
  margin-top: 16px;
}
.empty-card .status {
  text-align: center;
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-xs);
  color: var(--accent-bright);
  background: var(--accent-subtle);
  border: 1px solid var(--accent-muted);
  border-radius: 4px;
  padding: 8px 12px;
  margin: 12px 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.empty-card .small {
  text-align: center;
  font-size: var(--font-2xs);
  line-height: 1.7;
}
/* The stage keeps its panes through a switch, so this covers them rather than
   replacing them. Opaque: a translucent wash over another project's terminals
   reads as a glitch, not as loading. */
.stage-switching {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
}
/* Fades out only. A switch should feel immediate on the way in — a fade-in
   would just add delay to the thing that is already making them wait. */
.ws-switch-leave-active { transition: opacity 160ms ease-out; }
.ws-switch-leave-to { opacity: 0; }

.spinner {
  width: 38px;
  height: 38px;
  margin: 0 auto;
  border: 3px solid var(--accent-muted);
  border-top-color: var(--accent-fg);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Stage-stall confirmation modal ──────────────────────────────────────── */
.stall-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}
.stall-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--warning-fg);
  border-radius: 8px;
  width: min(520px, 92vw);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: var(--font-sm);
  box-shadow: 0 12px 48px var(--shadow-overlay);
  overflow: hidden;
}
.stall-card header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
.stall-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--warning-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning-fg) 20%, transparent);
}
.stall-slot {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.stall-body {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stall-title {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-primary);
}
.stall-reason {
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-xs);
  color: var(--warning-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 4px;
  padding: 8px 10px;
}
.stall-hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  line-height: 1.6;
}
.stall-hint strong {
  color: var(--text-bright);
}
.check-row { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); cursor: pointer; user-select: none; }
.check-row input[type='checkbox'] { width: 14px; height: 14px; accent-color: var(--accent-fg); }
.confirm-dont-show { margin-top: 10px; }
.stall-auto {
  font-size: var(--font-xs);
  color: var(--accent-bright);
  font-weight: 500;
}
.stall-card footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 18px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-base);
}
.stall-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.stall-btn.primary {
  background: var(--success-emphasis);
  border-color: var(--success-emphasis);
  color: var(--text-on-emphasis);
}
.stall-btn.primary:hover {
  background: var(--success-emphasis);
}
.stall-btn.danger {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
.stall-btn.danger:hover {
  background: var(--danger-bright);
}
.sb-url { color: var(--text-muted); font-size: var(--font-3xs); }
.sb-clock { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.sb-version { color: var(--text-muted); margin-left: 4px; }
.sb-announce-unread .sb-version { color: inherit; }
.sb-orphans { color: var(--danger, #C0392B); cursor: pointer; font-weight: 600; }
.sb-orphans:hover { text-decoration: underline; }
.sb-reconnect { display: inline-flex; align-items: center; gap: 6px; color: var(--accent-bright, #3B5BDB); font-weight: 600; }
.sb-reconnect-text { cursor: pointer; }
.sb-reconnect-text:hover { text-decoration: underline; }
.sb-reconnect-dismiss { cursor: pointer; opacity: 0.7; }
.sb-reconnect-dismiss:hover { opacity: 1; }
.sb-close-all { color: var(--danger, #C0392B); font-weight: 600; margin-left: 12px; }
.sb-close-all:hover { text-decoration: underline; }

/* Pane right-click context menu */
.pane-ctx-backdrop { position: fixed; inset: 0; z-index: 999; }
.pane-ctx {
  position: fixed;
  z-index: 1000;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  min-width: 170px;
  user-select: none;
}
.pane-ctx-header {
  padding: 5px 14px 6px;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-muted);
  white-space: nowrap;
  border-bottom: 1px solid var(--border-default);
  margin-bottom: 4px;
}
.pane-ctx-item {
  padding: 6px 14px;
  font-size: var(--font-xs);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.pane-ctx-item:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.pane-ctx-item.danger { color: var(--danger-bright); }
.pane-ctx-item.danger:hover { background: var(--danger-emphasis); color: var(--text-on-emphasis); }
.pane-ctx-item.disabled { opacity: 0.4; pointer-events: none; }
.pane-ctx-sep { height: 1px; background: var(--border-default); margin: 4px 0; }
.pane-rename-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: var(--font-sm);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-bright);
}
.pane-rename-input:focus { outline: none; border-color: var(--accent-emphasis); }
</style>
<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
  background: var(--bg-inset);
}

</style>
