<script setup lang="ts">
// Agent overview popover, anchored to the status-bar "N agents" counter (same
// backdrop + fixed-card shape as the clock popover).
//
// The counter told the user HOW MANY panes exist but not WHICH ones, so with
// several tabs / minimized panes the only way to find a specific agent was to
// hunt through the sidebar. This lists every pane in the window with its live
// status and jumps to the one that is clicked.
//
// Everything here is derived from props: App.vue owns the pane model and the
// jump, this component only renders rows and re-emits the click.
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { paneStatusLabelKey, type PaneStatusValue } from '../lib/paneStatusLabel'

/** Status values a pane row can carry: useTerminal's `displayStatus`, plus
 *  'waiting' for a cold-restore placeholder that was never realized and
 *  'disconnected' for a pane whose backend session was lost.
 *
 *  An alias of PaneStatusValue rather than a restatement of it. It used to be a
 *  hand-copied second list kept in sync by comment, so adding a badge value
 *  silently left this one behind — and a row whose status is not in the union
 *  renders a raw i18n key. */
export type AgentOverviewStatus = PaneStatusValue

export interface AgentOverviewRow {
  paneId: string
  /** Display name — the rename/auto name when set, else the agent label. */
  name: string
  /** CLI vendor label ("Claude Code", "Codex", …). Empty when it would merely
   *  repeat `name` — an unnamed pane's name already is the vendor label. */
  vendor: string
  status: AgentOverviewStatus
  /** Basename of the pane's workspace, set only when it differs from the
   *  window's current workspace (a session resumed from another folder).
   *  Empty otherwise, so the common case shows no redundant path. */
  foreignWorkspace: string
}

defineProps<{ rows: AgentOverviewRow[] }>()
const emit = defineEmits<{ close: []; jump: [paneId: string] }>()

const { t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function statusLabel(status: AgentOverviewStatus): string {
  return t(paneStatusLabelKey(status))
}
</script>

<template>
  <div class="ao-backdrop" @click="emit('close')" />
  <div class="ao-pop" @click.stop>
    <div class="ao-head">
      <span class="ao-head-title">{{ t('agentOverview.title') }}</span>
      <button class="ao-btn" data-act="close" :title="t('agentOverview.close')" @click="emit('close')">✕</button>
    </div>
    <div class="ao-rows">
      <button
        v-for="r in rows"
        :key="r.paneId"
        type="button"
        class="ao-row"
        data-row="pane"
        :data-pane="r.paneId"
        :data-status="r.status"
        :title="t('agentOverview.jump')"
        @click="emit('jump', r.paneId)"
      >
        <span class="ao-dot" />
        <span class="ao-name">{{ r.name }}</span>
        <span v-if="r.foreignWorkspace" class="ao-ws" data-part="workspace">{{ r.foreignWorkspace }}</span>
        <span v-if="r.vendor" class="ao-vendor" data-part="vendor">{{ r.vendor }}</span>
        <span class="ao-status" data-part="status">{{ statusLabel(r.status) }}</span>
      </button>
      <div v-if="rows.length === 0" class="ao-empty" data-row="empty">{{ t('agentOverview.empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.ao-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.ao-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 320px;
  max-height: 60vh;
  overflow-y: auto;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  color: var(--text-secondary);
}
.ao-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.ao-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.ao-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
}
.ao-btn:hover { color: var(--text-bright); }
.ao-rows {
  display: flex;
  flex-direction: column;
  padding: 4px;
}
.ao-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ao-row:hover { background: var(--bg-hover); }
.ao-dot {
  flex: none;
  align-self: center;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}
.ao-name {
  flex: 1;
  min-width: 0;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ao-ws {
  flex: none;
  max-width: 88px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ao-vendor {
  flex: none;
  color: var(--text-muted);
}
.ao-status {
  flex: none;
  min-width: 58px;
  text-align: right;
  /* Same casing as the pane badge and the sidebar pill, which both uppercase
     theirs — without it the shared label reads differently here in English. */
  text-transform: uppercase;
  color: var(--text-secondary);
}
.ao-row[data-status='running'] .ao-status { color: var(--success-fg); }
.ao-row[data-status='running'] .ao-dot { background: var(--success-fg); }
.ao-row[data-status='starting'] .ao-status { color: var(--status-starting-fg); }
.ao-row[data-status='starting'] .ao-dot { background: var(--status-starting-fg); }
.ao-row[data-status='error'] .ao-status,
.ao-row[data-status='exited'] .ao-status { color: var(--danger-fg); }
.ao-row[data-status='error'] .ao-dot,
.ao-row[data-status='exited'] .ao-dot { background: var(--danger-fg); }
.ao-row[data-status='disconnected'] .ao-status { color: var(--attention-fg); }
/* Hollow ring so a dropped connection never reads as the (also amber) idle dot. */
.ao-row[data-status='disconnected'] .ao-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--attention-fg);
}
.ao-row[data-status='waiting'] .ao-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-muted);
}
.ao-row[data-status='idle'] .ao-status { color: var(--attention-fg); }
.ao-row[data-status='idle'] .ao-dot { background: var(--attention-fg); }
.ao-row[data-status='awaiting'] .ao-status { color: var(--warning-fg); }
.ao-row[data-status='awaiting'] .ao-dot { background: var(--warning-fg); }
.ao-row[data-status='stopped'] .ao-status { color: var(--text-secondary); }
.ao-row[data-status='stopped'] .ao-dot { background: var(--text-disabled); }
.ao-row[data-status='waiting'] .ao-name { color: var(--text-secondary); }
.ao-empty {
  padding: 10px 8px;
  color: var(--text-muted);
  text-align: center;
}
</style>
