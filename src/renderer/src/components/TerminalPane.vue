<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useTerminal } from '../composables/useTerminal'
import { useTheme } from '../composables/useTheme'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { extractDropPaths, escapeDraggedPath, stabilizeDroppedPaths } from '../lib/drop'
import { CLI_CONTEXT_MIME, PANE_ID_MIME, resolveCliDropSource, writeCliPaneDragPayload } from '../lib/cliContext'
import { PLAN_REF_MIME, isPlanDrag, parsePlanRefPayload, type PlanDragRef } from '../lib/planDrag'
import { formatLoopTime } from '../lib/loopPrompt'
import { isMacPlatform } from '../keybindings/parseKey'
import RebuildIcon from './RebuildIcon.vue'
import UsageBadge from './UsageBadge.vue'
import RestoredPanePlaceholder from './RestoredPanePlaceholder.vue'

interface Props {
  paneId: string
  title: string
  subtitle?: string
  /** CLI vendor key (e.g. 'claude', 'codex') carried in the cli-context drag payload. */
  agentKey?: string
  /** Vendor conversation id, distinct from useTerminal's backend PTY id. */
  cliSessionId?: string
  sessionHomeId?: string
  conversationLogPath?: string
  pipeTag?: string
  isCommander?: boolean
  isFocus?: boolean
  /** True when this pane is part of the multi-select set (Cmd/Ctrl/Shift-click
   *  on the header), so batch context-menu actions target it. */
  isSelected?: boolean
  /** True when this pane's agent is resume-capable — RENDERS the rebuild button
   *  (disabled until canRebuild), so the control is discoverable from spawn. */
  rebuildVisible?: boolean
  /** True when this pane has a resumable CLI session id on disk — ENABLES the
   *  rebuild button (re-spawns the pane via --resume to recover from render
   *  corruption). */
  canRebuild?: boolean
  /** True while App has a rebuild in flight for this pane's session — disables
   *  the rebuild button so a double-click cannot start a second kill/spawn. */
  rebuilding?: boolean
  isPreparing?: boolean
  preparingLabel?: string
  /** A cold-restored terminal is mounted but has not rendered its first PTY output yet. */
  restoring?: boolean
  /** Runtime-only LOOP badge state — lit after the loop prompt was injected. */
  loopActive?: boolean
  /** Epoch ms of the scheduled session-limit auto-resume; set while the loop
   *  is paused waiting for the CLI quota to reset. */
  loopWaitUntil?: number | null
  /** Epoch ms of the heuristic quota-reset estimate (loop start + 5h Claude
   *  session window) shown on the running badge as an approximate time. */
  loopEstimateResetAt?: number | null
  /** Runtime-only login-expired badge — lit when the pane's CLI reported an
   *  expired login; clicking it asks App.vue to re-send the login command. */
  loginExpired?: boolean
  backend: ReturnType<typeof useBackend>
  cliProfiles: ReturnType<typeof useCliProfiles>
  workspacePath?: string
  /** Messaging names of the OTHER CLI panes (self excluded), for the
   *  @-mention autocomplete menu inside this pane's terminal. */
  mentionCandidates?: string[]
  /** Whether the layout currently shows this pane. Paged-out panes stay mounted
   *  (their terminals must survive), so the terminal uses this to skip
   *  display-only upkeep instead of running it for an invisible pane. */
  onScreen?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'set-focus', ev?: MouseEvent): void
  (e: 'minimize'): void
  (e: 'rebuild'): void
  (e: 'rebuild-clean'): void
  (e: 'rename', name: string): void
  (e: 'context-menu', ev: MouseEvent): void
  (e: 'reorder-drop', draggedPaneId: string): void
  /** Another CLI pane was dropped onto this pane's terminal area — App.vue
   *  pastes that pane's recent output into this pane's input prompt. */
  (e: 'cli-context-drop', sourcePaneId: string): void
  /** A plan document was dropped onto this pane's terminal area — App.vue
   *  pastes the plan goal + execution instruction into this pane's input. */
  (e: 'plan-drop', ref: PlanDragRef): void
  /** Loop button clicked — App.vue injects the loop prompt or clears the badge. */
  (e: 'toggle-loop'): void
  /** Waiting badge clicked — App.vue injects the resume prompt immediately
   *  instead of waiting for the scheduled quota reset. */
  (e: 'loop-resume-now'): void
  /** Login-expired badge clicked — App.vue sends the CLI's login command into
   *  this pane and clears the badge. */
  (e: 'fix-login'): void
  /** The user typed into a STOPped pane (Enter/printable), taking over — App.vue
   *  clears + un-persists the STOP badge. */
  (e: 'user-resume'): void
  (e: 'first-output'): void
}>()
const containerRef = ref<HTMLElement | null>(null)
const isDragOver = ref(false)
/** Hovering a CLI pane over this terminal (context share), not files (path insert). */
const isCliDragOver = ref(false)
/** Hovering a plan document over this terminal (plan goal inject). */
const isPlanDragOver = ref(false)

// Inline title rename — double-click the header title to edit, Enter/blur to
// commit, Escape to cancel. The committed name bubbles up as a 'rename' event.
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
let _cancelledTitle = false

async function startTitleEdit(): Promise<void> {
  _cancelledTitle = false
  titleDraft.value = props.title
  editingTitle.value = true
  await nextTick()
  titleInput.value?.select()
}

function commitTitleEdit(): void {
  if (_cancelledTitle) return
  editingTitle.value = false
  emit('rename', titleDraft.value.trim())
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit() }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledTitle = true; editingTitle.value = false }
}

const terminal = useTerminal(props.paneId, props.backend, {
  workspacePath: props.workspacePath,
  onClear: () => emit('rebuild-clean'),
  onUserResume: () => emit('user-resume'),
  mentionCandidates: () => props.mentionCandidates ?? [],
  onScreen: () => props.onScreen ?? true,
  onFirstOutput: () => emit('first-output'),
})
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

watch(() => props.isPreparing, (isPrep) => {
  if (terminal.setDisableStdin) {
    terminal.setDisableStdin(!!isPrep)
  }
}, { immediate: true })

// RUNNING vs IDLE is derived inside useTerminal from the pane's own clean
// output, with hysteresis: a sustained burst enters RUNNING, and only a long
// clean silence leaves it. The CLI's turn_complete (routed here by App.vue via
// markTurnComplete) is the one authoritative signal, used to drop to idle early.
const displayStatus = terminal.displayStatus

defineExpose({
  spawn: terminal.spawn,
  interrupt: terminal.interrupt,
  kill: terminal.kill,
  focus: terminal.focus,
  status: terminal.status,
  displayStatus,
  startingStartedAt: terminal.startingStartedAt,
  startingAgeMs: terminal.startingAgeMs,
  cancelPendingCreate: terminal.cancelPendingCreate,
  sessionId: terminal.sessionId,
  error: terminal.error,
  lastCommand: terminal.lastCommand,
  cleanBuffer: terminal.cleanBuffer,
  cleanBytesSeen: terminal.cleanBytesSeen,
  lastActivityAt: terminal.lastActivityAt,
  lastRawActivityAt: terminal.lastRawActivityAt,
  markTurnComplete: terminal.markTurnComplete,
  markBufferPosition: terminal.markBufferPosition,
  recleanBuffer: terminal.recleanBuffer,
  readRenderedText: terminal.readRenderedText,
  readLineBeforeCursor: terminal.readLineBeforeCursor,
  fitTerminal: terminal.fitTerminal,
  redraw: terminal.redraw,
  // STOP badge: App.vue owns persistence; it reflects stored/broadcast truth
  // into this pane's composable ref via setStopped (no persist side-effect).
  setStopped: (v: boolean) => { terminal.isStopped.value = v }
})

/** True when the drag carries a CLI pane's identity (pane→pane context share)
 *  rather than files/text (path insert). Readable during dragover: the TYPES
 *  are visible in protected mode even though the data is not. */
function isCliPaneDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && (types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME))
}

function onTerminalDragOver(e: DragEvent): void {
  e.preventDefault()
  if (isPlanDrag(e.dataTransfer?.types)) {
    isPlanDragOver.value = true
    isCliDragOver.value = false
    isDragOver.value = false
    return
  }
  const cli = isCliPaneDrag(e)
  // Dragging this pane's own header over its own terminal is a no-op — don't
  // advertise a drop target for it.
  isCliDragOver.value = cli && !draggingSelf
  isDragOver.value = !cli
}

function onTerminalDragLeave(): void {
  isDragOver.value = false
  isCliDragOver.value = false
  isPlanDragOver.value = false
}

// Modifier that forces text selection while a CLI has mouse reporting on.
// xterm binds it to Option on macOS (macOptionClickForcesSelection) and to
// Shift everywhere else.
const selectModifierLabel = isMacPlatform() ? '⌥ Option' : 'Shift'

// xterm's selection lives outside the DOM, so main cannot read it from the
// context-menu params — pass it along with the request.
function onTerminalContextMenu(): void {
  window.agentTeam?.showTerminalContextMenu?.(terminal.getSelection())
}

async function onTerminalDrop(e: DragEvent): Promise<void> {
  isDragOver.value = false
  isCliDragOver.value = false
  isPlanDragOver.value = false
  if (terminal.displayStatus.value === 'exited' || terminal.displayStatus.value === 'error') return
  // Plan document dropped onto this terminal: App.vue owns pane state, so it
  // pastes the plan goal + execution instruction into this pane's input.
  if (isPlanDrag(e.dataTransfer?.types)) {
    const ref = parsePlanRefPayload(e.dataTransfer?.getData(PLAN_REF_MIME) || '')
    if (ref) emit('plan-drop', ref)
    return
  }
  // CLI pane dropped onto this terminal: share its recent output with this pane.
  // App.vue owns pane state, so it resolves the buffer and does the paste.
  if (isCliPaneDrag(e)) {
    const sourcePaneId = resolveCliDropSource(
      e.dataTransfer?.getData(CLI_CONTEXT_MIME) || '',
      e.dataTransfer?.getData(PANE_ID_MIME) || '',
      props.paneId
    )
    if (sourcePaneId) emit('cli-context-drop', sourcePaneId)
    return
  }
  const dropped = extractDropPaths(e)
  if (!dropped.length) return
  const paths = await stabilizeDroppedPaths(dropped)
  terminal.pasteFromClipboard(paths.map(escapeDraggedPath).join(' '))
}

// Drag the pane (by its header) onto a tab to move it into that run group,
// or onto another pane's header to reorder (see the drop handlers below).
function onHeaderDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  // Carry a fast local snapshot; AI Chat still fetches authoritative live
  // metadata and rendered output on drop through the pane-buffer IPC relay.
  writeCliPaneDragPayload(e.dataTransfer, {
    paneId: props.paneId,
    agentKey: props.agentKey ?? '',
    label: props.title,
    sessionId: props.cliSessionId || null,
    sessionHomeId: props.sessionHomeId ?? '',
    workspacePath: props.workspacePath ?? '',
    conversationLogPath: props.conversationLogPath ?? ''
  })
  e.dataTransfer.effectAllowed = 'move'
  draggingSelf = true
}

// Drop target for pane reordering: another pane's header dropped onto this
// header emits 'reorder-drop' with the dragged pane's id; App.vue moves that
// pane into this pane's slot. During dragover the payload is unreadable
// (dataTransfer protected mode), so hovering is gated on the data TYPE plus a
// local "this pane is the drag source" flag — the id check happens on drop.
const isReorderDragOver = ref(false)
let draggingSelf = false

function onHeaderDragEnd(e: DragEvent): void {
  draggingSelf = false
  isReorderDragOver.value = false
  // Cross-window handoff. Chromium DOES deliver same-app cross-window drops
  // to another window's drop targets (verified 2026-07-24) — a consumed drop,
  // local or cross-window, reports dropEffect 'move' here and needs no
  // follow-up. A release over a NON-accepting area consumes nothing, so
  // dropEffect stays 'none' — only then ask main to route the pane to the
  // window under the pointer. (Esc-cancel also reports 'none' —
  // indistinguishable in Chromium, which suppresses keyboard events during a
  // drag; main drops the release when it lands inside this window's own
  // bounds, which covers the common cancel-in-place case.)
  if (e.dataTransfer?.dropEffect !== 'none') return
  window.agentTeam?.cliPaneDragEnd?.(props.paneId, e.screenX, e.screenY)
}

function onHeaderDragOver(e: DragEvent): void {
  if (draggingSelf || !e.dataTransfer?.types.includes('application/x-pane-id')) return
  e.preventDefault()
  isReorderDragOver.value = true
}

function onHeaderDragLeave(): void {
  isReorderDragOver.value = false
}

function onHeaderDrop(e: DragEvent): void {
  isReorderDragOver.value = false
  const draggedId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (!draggedId || draggedId === props.paneId) return
  emit('reorder-drop', draggedId)
}

/** Single source for the loop badge's 3-way state machine (waiting /
 *  estimate / plain): which i18n keys to render and the formatted time they
 *  interpolate — the template's text and tooltip both read from here. */
const loopBadge = computed(() => {
  if (props.loopWaitUntil != null) {
    return {
      textKey: 'pane.terminal.loop-badge-resume' as string | null,
      titleKey: 'pane.terminal.loop-waiting-tooltip',
      time: formatLoopTime(props.loopWaitUntil)
    }
  }
  if (props.loopEstimateResetAt != null) {
    return {
      textKey: 'pane.terminal.loop-badge-estimate' as string | null,
      titleKey: 'pane.terminal.loop-estimate-tooltip',
      time: formatLoopTime(props.loopEstimateResetAt)
    }
  }
  return { textKey: null as string | null, titleKey: 'pane.terminal.loop-badge-tooltip', time: '' }
})

/** The badge is the off-switch while the loop runs (the ∞ start button is
 *  hidden then); while waiting it is a click-to-resume-now affordance. */
function onLoopBadgeClick(e: MouseEvent): void {
  e.stopPropagation()
  if (props.loopWaitUntil != null) emit('loop-resume-now')
  else emit('toggle-loop')
}

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})
</script>

<template>
  <div :class="['pane', { 'pane-focus': isFocus, 'pane-selected': isSelected }]">
    <button
      v-if="rebuildVisible"
      class="rebuild-btn"
      :disabled="rebuilding || !canRebuild"
      @click.stop="emit('rebuild')"
      :title="canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
      :aria-label="canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
    ><RebuildIcon /></button>
    <button class="minimize-btn" @click.stop="emit('minimize')" :title="$t('pane.terminal.minimize-tooltip')">⊟</button>
    <header
      :class="['pane-header', { 'drag-over': isReorderDragOver }]"
      :draggable="!editingTitle"
      :title="$t('pane.terminal.drag-to-tab-tooltip')"
      @click="emit('set-focus', $event)"
      @dragstart="onHeaderDragStart"
      @dragend="onHeaderDragEnd"
      @dragover="onHeaderDragOver"
      @dragenter="onHeaderDragOver"
      @dragleave="onHeaderDragLeave"
      @drop.prevent="onHeaderDrop"
      @contextmenu.prevent="emit('context-menu', $event)"
    >
      <div class="header-main">
        <span v-if="pipeTag" class="pipe-tag">{{ pipeTag }}</span>
        <input
          v-if="editingTitle"
          ref="titleInput"
          class="title-edit"
          v-model="titleDraft"
          @keydown="onTitleKeydown"
          @blur="commitTitleEdit"
          @click.stop
          @dblclick.stop
        />
        <span
          v-else
          class="title"
          :title="$t('pane.terminal.rename-title-tooltip')"
          @dblclick.stop="startTitleEdit"
        >{{ title }}</span>
        <span v-if="isCommander" class="commander-inline" :title="$t('pane.terminal.commander-tooltip')">🎯 Mgr</span>
        <span
          v-if="loopActive"
          class="loop-inline"
          :class="{ waiting: loopWaitUntil != null }"
          role="button"
          :title="$t(loopBadge.titleKey, { time: loopBadge.time })"
          @click="onLoopBadgeClick"
        >{{ loopBadge.textKey ? $t(loopBadge.textKey, { time: loopBadge.time }) : '∞ Loop' }}</span>
        <button
          v-if="!loopActive && displayStatus !== 'exited' && displayStatus !== 'error'"
          class="loop-btn"
          @click.stop="emit('toggle-loop')"
          :title="$t('pane.terminal.loop-tooltip')"
          :aria-label="$t('pane.terminal.loop-tooltip')"
        >∞</button>
        <span
          v-if="loginExpired"
          class="login-expired-inline"
          role="button"
          :title="$t('pane.terminal.login-expired-tooltip')"
          @click.stop="emit('fix-login')"
        >{{ $t('pane.terminal.login-expired-badge') }}</span>
        <span
          class="status"
          :data-status="displayStatus"
          :title="displayStatus === 'idle' ? $t('pane.terminal.idle-status-tooltip') : ''"
        >{{ displayStatus === 'stopped' ? 'STOP' : displayStatus }}</span>
        <UsageBadge v-if="agentKey" :agent-key="agentKey" :cli-profiles="cliProfiles" />
      </div>
      <div v-if="subtitle" class="header-sub">{{ subtitle }}</div>
    </header>
    <div
      ref="containerRef"
      class="xterm-host"
      :class="{ 'drag-over': isDragOver, 'cli-drag-over': isCliDragOver, 'plan-drag-over': isPlanDragOver, 'alt-buffer': terminal.isAltBuffer.value }"
      :data-pane-id="paneId"
      @mousedown.left="emit('set-focus')"
      @contextmenu.prevent="onTerminalContextMenu"
      @dragover.prevent="onTerminalDragOver"
      @dragenter.prevent="onTerminalDragOver"
      @dragleave="onTerminalDragLeave"
      @drop.prevent="onTerminalDrop"
    ></div>
    <!-- Optional-chained: the pane's tests stub useTerminal with partial objects. -->
    <div v-if="terminal.optionSelectHint?.value" class="select-hint" aria-live="polite">
      {{ $t('pane.terminal.option-select-hint', { key: selectModifierLabel }) }}
    </div>
    <div v-if="isPreparing" class="prep-overlay" aria-live="polite">
      <div class="prep-panel">
        <div class="prep-spinner" />
        <div class="prep-text">{{ preparingLabel || 'Preparing CLI' }}</div>
      </div>
    </div>
    <RestoredPanePlaceholder
      v-if="restoring && displayStatus !== 'exited' && displayStatus !== 'error'"
      class="restoring-overlay"
      :pane-id="paneId"
      :title="title"
      :subtitle="subtitle"
      :pipe-tag="pipeTag"
      :is-focus="isFocus"
      realizing
      @minimize="emit('minimize')"
      @context-menu="emit('context-menu', $event)"
    />
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.pane:focus-within {
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
}
.pane.pane-focus {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.pane.pane-focus .pane-header {
  background: var(--bg-elevated);
}
.pane.pane-selected {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 45%, transparent);
}
.pane.pane-selected .pane-header {
  background: color-mix(in srgb, var(--accent-focus) 18%, var(--bg-elevated));
}
.minimize-btn,
.rebuild-btn {
  position: absolute;
  top: 5px;
  z-index: 10;
  background: none;
  border: none;
  color: var(--text-disabled);
  font-size: 14px;
  cursor: pointer;
  padding: 0 3px;
  line-height: 1;
  border-radius: 3px;
  opacity: 1;
  transition: color 0.15s, background-color 0.15s;
}
.minimize-btn {
  right: 6px;
}
.rebuild-btn {
  right: 26px;
}
.rebuild-btn svg {
  width: 14px;
  height: 14px;
}
.minimize-btn:hover,
.rebuild-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-muted);
}
.rebuild-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.pane-header {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 5px 52px 5px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-size: 12px;
  color: var(--text-primary);
}
/* Reorder drop target feedback, matching .tab-btn.drag-over in StageTabBar.vue. */
.pane-header.drag-over {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-sub {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  font-weight: 600;
}
.title-edit {
  font: inherit;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-default);
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  padding: 1px 5px;
  min-width: 0;
  outline: none;
}
.commander-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
}
.loop-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid var(--success-emphasis);
  border-radius: 4px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.loop-inline:hover {
  border-color: var(--success-fg);
}
.loop-inline.waiting {
  opacity: 0.55;
  cursor: pointer;
}
.loop-inline.waiting:hover {
  opacity: 1;
  border-color: var(--success-fg);
}
.login-expired-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 4px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.login-expired-inline:hover {
  border-color: var(--attention-fg);
}
.loop-btn {
  font-size: 9px;
  line-height: 1.4;
  background: transparent;
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  color: var(--text-secondary);
  padding: 1px 6px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0.7;
}
.loop-btn:hover {
  opacity: 1;
  color: var(--success-fg);
  border-color: var(--success-emphasis);
}
.status {
  margin-left: auto;
  font-size: 10px;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.status[data-status='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.status[data-status='starting'] {
  background: var(--status-starting-muted);
  color: var(--status-starting-fg);
}
.status[data-status='error'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.status[data-status='exited'] {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.status[data-status='idle'] {
  background: var(--attention-muted);
  color: var(--attention-fg);
}
.status[data-status='stopped'] {
  background: #000000;
  color: #ffffff;
  border: 1px solid #3f3f46;
}
.xterm-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  position: relative;
  transition: box-shadow 0.1s;
}
.xterm-host.drag-over,
.xterm-host.cli-drag-over,
.xterm-host.plan-drag-over {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.xterm-host.drag-over::after,
.xterm-host.cli-drag-over::after,
.xterm-host.plan-drag-over::after {
  content: 'Drop to insert path';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-size: 13px;
  font-family: inherit;
  pointer-events: none;
}
.xterm-host.cli-drag-over::after {
  content: 'Drop to paste this pane context';
}
.xterm-host.plan-drag-over::after {
  content: 'Drop to inject plan goal';
}
/* Transient teaching hint; must never eat clicks meant for the terminal. */
.select-hint {
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 9;
  padding: 4px 9px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
  pointer-events: none;
}
.prep-overlay {
  position: absolute;
  inset: 31px 0 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-base) 78%, transparent);
  backdrop-filter: blur(1px);
  pointer-events: auto;
}
.restoring-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
}
.prep-panel {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: min(78%, 360px);
  padding: 8px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  color: var(--text-primary);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--bg-inverse) 10%, transparent);
}
.prep-spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  animation: prep-spin 0.8s linear infinite;
  flex: 0 0 auto;
}
.prep-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
@keyframes prep-spin {
  to { transform: rotate(360deg); }
}
/* xterm.js Monaco scrollbar: show track vs thumb contrast in main buffer.
   xterm injects --vscode-scrollbarSlider-background from ITheme but the track
   has no background — add a dim track so the thumb position is distinguishable. */
/* xterm Monaco scrollbar: keep thumb (slider) always visible without a track
   background. Track stays transparent so only the thumb shows as a colored
   strip — white on dark themes, dark on light theme. Avoids the "all gray"
   appearance caused by track + thumb blending to the same shade. */
.xterm-host:not(.alt-buffer) :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.7 !important;
}
/* Alt buffer (TUI): thumb fills 100% = no useful position info. Hide it. */
.xterm-host.alt-buffer :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.08 !important;
}
</style>
