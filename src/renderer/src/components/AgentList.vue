<script setup lang="ts">
import ViewPanel, { type LayoutMode } from './ViewPanel.vue'
import HistoryIcon from './HistoryIcon.vue'
import type { ActivePaneView } from './ControlPane.vue'
import { paneStatusLabelKey } from '../lib/paneStatusLabel'

defineProps<{
  panes: ActivePaneView[]
  layoutMode: LayoutMode
  runningCount: number
  focusPaneId?: string
  selectedPaneIds?: Set<string>
}>()

const emit = defineEmits<{
  (e: 'update:layoutMode', v: LayoutMode): void
  (e: 'open-history'): void
  (e: 'focus-pane', paneId: string, ev?: MouseEvent): void
  (e: 'context-menu', paneId: string, ev: MouseEvent): void
  (e: 'kill', paneId: string): void
  (e: 'interrupt', paneId: string): void
  (e: 'restore', paneId: string): void
}>()

function injectionLabel(status: ActivePaneView['injectionStatus']): string {
  switch (status) {
    case 'pending':   return 'role: waiting'
    case 'scheduled': return 'role: injecting'
    case 'sent':      return 'role: injected'
    case 'failed':    return 'role: inject failed'
    case 'skipped':   return 'role: skipped'
  }
}

function preparationLabel(status: ActivePaneView['preparationStatus']): string {
  switch (status) {
    case 'starting':         return 'setup: starting CLI'
    case 'checking-dialog':  return 'setup: checking dialog'
    case 'settling':         return 'setup: waiting prompt'
    case 'injecting-role':   return 'setup: injecting role'
    case 'waiting-agent':    return 'setup: waiting agent'
    case 'ready':            return 'setup: ready'
    case 'failed':           return 'setup: failed'
    default:                 return ''
  }
}

function kickoffLabel(status?: ActivePaneView['kickoffStatus']): string {
  if (!status || status === 'none') return ''
  switch (status) {
    case 'pending': return '· kickoff: queued'
    case 'sent':    return '· kickoff: sent'
    case 'failed':  return '· kickoff: failed'
  }
}
</script>

<template>
  <section class="block panel-section">
    <div class="row between agent-list-hdr">
      <label class="lbl">{{ $t('label.active-agents', { running: runningCount, total: panes.length }) }}</label>
      <div class="agent-header-actions">
        <ViewPanel
          :model-value="layoutMode"
          @update:model-value="emit('update:layoutMode', $event)"
        />
        <button class="history-btn" :title="$t('label.history')" @click="emit('open-history')"><HistoryIcon /></button>
      </div>
    </div>
    <div v-if="panes.length === 0" class="empty">{{ $t('label.no-agents-running') }}</div>
    <ul v-else class="agent-list">
      <li
        v-for="p in panes"
        :key="p.id"
        class="agent-item"
        :class="{ pipeline: p.origin === 'pipeline', manager: p.isCommander, minimized: p.isMinimized, 'agent-item--focus': p.id === focusPaneId, 'agent-item--selected': selectedPaneIds?.has(p.id) }"
      >
        <div
          class="agent-line"
          role="button"
          title="Focus pane"
          @click="emit('focus-pane', p.id, $event)"
          @contextmenu.prevent="emit('context-menu', p.id, $event)"
        >
          <span v-if="p.origin === 'pipeline'" class="pipe-tag">P{{ p.stageId }}</span>
          <span class="badge">{{ p.agentLabel }}</span>
          <span v-if="p.isCommander" class="manager-inline" title="Stage manager — controls flow and decides ---STAGE-DONE---">🎯 Mgr</span>
          <span v-if="p.isMinimized" class="minimized-tag">▪ sidebar</span>
          <span v-else class="state" :data-state="p.status">{{ $t(paneStatusLabelKey(p.status)) }}</span>
          <span
            v-if="p.loopActive"
            class="loop-tag"
            :class="{ waiting: p.loopWaitUntil != null }"
          >∞ Loop</span>
          <button class="icon-btn agent-close-btn" :title="$t('action.remove')" @click.stop="emit('kill', p.id)">✕</button>
        </div>
        <div v-if="p.roleLabel" class="role-line">{{ p.roleLabel }}</div>
        <div v-if="!p.isMinimized && p.origin === 'pipeline'" class="stage-line">
          stage {{ p.stageId }} · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
        </div>
        <div v-else-if="!p.isMinimized" class="stage-line">
          manual · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
        </div>
        <div v-if="!p.isMinimized" class="agent-cmd"><code>{{ p.command }}</code></div>
        <div v-if="!p.isMinimized && p.sessionId" class="agent-session" title="CLI session id — used to resume this agent's memory on restart">
          🔖 session: <code>{{ p.sessionId }}</code>
        </div>
        <div v-if="p.error" class="err">{{ p.error }}</div>
        <div class="row tight">
          <template v-if="p.isMinimized">
            <button class="ghost" @click="emit('restore', p.id)">{{ $t('action.restore') }}</button>
            <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
          </template>
          <template v-else>
            <button class="ghost" @click="emit('interrupt', p.id)" :disabled="p.status !== 'running'">
              {{ $t('action.interrupt') }}
            </button>
            <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
          </template>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* ── Base styles (needed because this is a scoped child component) ── */
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-section {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 6px 0 10px;
  border-top: 1px solid var(--border-muted);
}
.lbl {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text-secondary);
  padding: 2px 0;
  display: block;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.row.between {
  justify-content: space-between;
}
.row.tight {
  gap: 4px;
  margin-top: 4px;
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.danger {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-bright);
}

/* ── Agent list header ── */
.agent-list-hdr {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-base);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-muted);
  margin-bottom: 4px;
}
.agent-header-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}
button.history-btn {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: 14px;
  padding: 0;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.history-btn :deep(svg) { width: 15px; height: 15px; }
button.history-btn:hover {
  color: var(--text-bright);
  border-color: var(--accent-fg);
  background: var(--bg-subtle);
}
button.icon-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
  opacity: 0.5;
}
button.icon-btn:hover {
  opacity: 1;
  background: var(--bg-muted);
}

/* ── Agent list ── */
.empty {
  color: var(--text-muted);
  font-style: italic;
  padding: 8px 0;
}
.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-item {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 8px 10px;
}
.agent-item.pipeline {
  border-color: var(--accent-muted);
  background: linear-gradient(180deg, var(--accent-subtle) 0%, var(--bg-subtle) 100%);
}
.agent-item.manager {
  border-color: var(--attention-muted);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--manager-fg) 15%, transparent) inset;
}
.agent-item--focus {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 8%, var(--bg-subtle));
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.agent-item--selected {
  border-color: var(--accent-focus);
  background: color-mix(in srgb, var(--accent-focus) 16%, var(--bg-subtle));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 55%, transparent);
}
.agent-item.minimized {
  opacity: 0.7;
}
.agent-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;
  margin-left: -4px;
  overflow: hidden;
}
.agent-line:hover {
  background: var(--bg-subtle);
}
.agent-close-btn {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  width: 18px;
}
.agent-close-btn:hover {
  color: var(--danger-fg);
  background: var(--danger-deep);
}
.role-line {
  font-size: 9px;
  color: var(--accent-bright);
  margin-bottom: 3px;
  padding-left: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stage-line {
  color: var(--text-secondary);
  font-size: 10px;
  margin-bottom: 4px;
}
.agent-cmd {
  margin-bottom: 4px;
  overflow: hidden;
}
.agent-cmd code {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
}
.agent-session {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  word-break: break-all;
}
.agent-session code {
  color: var(--accent-fg);
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
}
.err {
  color: var(--danger-fg);
  font-size: 10px;
  margin: 4px 0;
}
.pipe-tag {
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-muted);
  color: var(--accent-bright);
  padding: 1px 5px;
  border-radius: 3px;
}
.badge {
  font-weight: 600;
  font-size: 10px;
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-primary);
}
.manager-inline {
  font-size: 9px;
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid color-mix(in srgb, var(--manager-fg) 35%, transparent);
  border-radius: 999px;
  padding: 1px 6px;
  white-space: nowrap;
  flex-shrink: 0;
}
.state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.state[data-state='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.state[data-state='starting'] {
  background: var(--status-starting-muted);
  color: var(--status-starting-fg);
}
.state[data-state='idle'] {
  background: var(--attention-muted);
  color: var(--attention-fg);
}
.state[data-state='error'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.state[data-state='exited'] {
  background: var(--bg-muted);
}
.loop-tag {
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--success-subtle);
  color: var(--success-fg);
  border: 1px solid var(--success-emphasis);
  white-space: nowrap;
  flex-shrink: 0;
}
.loop-tag.waiting {
  opacity: 0.55;
}
.minimized-tag {
  margin-left: auto;
  font-size: 10px;
  color: var(--accent-fg);
  background: var(--accent-subtle);
  border: 1px solid color-mix(in srgb, var(--accent-emphasis) 33%, transparent);
  border-radius: 999px;
  padding: 2px 8px;
}
/* Override ViewPanel's absolute positioning when used inline in the sidebar */
.agent-header-actions :deep(.view-panel) {
  position: static;
}
</style>
