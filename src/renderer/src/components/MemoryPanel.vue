<script setup lang="ts">
// Memory popover, anchored to the status-bar memory pill (same backdrop +
// fixed-card shape as ClockPanel).
//
// It answers the question you have at the moment the machine starts to feel
// slow — which panes are holding the memory, and can I have some back — in the
// place you are already looking when you notice. The measurement is taken when
// this opens, never on a timer: it shells out to `footprint`, whose cost scales
// with the pane count.
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatBytes } from '../lib/formatBytes'

export interface MemoryPaneRow {
  paneId: string
  title: string
  /** Measured bytes for the pane's whole process tree; 0 when unmeasured. */
  bytes: number
  /** Whether "reclaim now" would take this one. */
  reclaimable: boolean
}

const props = defineProps<{
  rows: MemoryPaneRow[]
  /** False while the sweep is in flight. */
  measured: boolean
  /** False when the platform cannot measure at all (non-macOS, or footprint
   *  missing) — then sizes are hidden rather than shown as zero. */
  available: boolean
}>()
const emit = defineEmits<{ close: []; reclaim: []; jump: [paneId: string] }>()

const { t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const totalBytes = computed(() => props.rows.reduce((sum, r) => sum + r.bytes, 0))
const reclaimableRows = computed(() => props.rows.filter((r) => r.reclaimable))
const reclaimableBytes = computed(() =>
  reclaimableRows.value.reduce((sum, r) => sum + r.bytes, 0)
)
// Biggest first: the list is a place to look for what to reclaim, and the
// order that serves is by what it would give back.
const sortedRows = computed(() =>
  [...props.rows].sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title))
)

function sizeText(bytes: number): string {
  if (!props.available) return '—'
  if (!props.measured) return '…'
  return formatBytes(bytes)
}
</script>

<template>
  <div class="mem-backdrop" @click="emit('close')" />
  <div class="mem-pop" @click.stop>
    <div class="mem-head">
      <span class="mem-head-title">{{ t('memory.title') }}</span>
      <button class="mem-btn" data-act="close" :title="t('memory.close')" @click="emit('close')">✕</button>
    </div>

    <div class="mem-summary">
      <div class="mem-row" data-row="total">
        <span class="mem-k">{{ t('memory.cli-count', { count: rows.length }) }}</span>
        <span class="mem-v">{{ sizeText(totalBytes) }}</span>
      </div>
      <div class="mem-row" data-row="reclaimable">
        <span class="mem-k">{{ t('memory.reclaimable') }}</span>
        <span class="mem-v">
          {{ t('memory.reclaimable-value', { count: reclaimableRows.length }) }}
          <template v-if="available && measured && reclaimableRows.length > 0">
            · {{ formatBytes(reclaimableBytes) }}
          </template>
        </span>
      </div>
    </div>

    <ul v-if="sortedRows.length > 0" class="mem-list">
      <li
        v-for="row in sortedRows"
        :key="row.paneId"
        :data-pane-id="row.paneId"
        :data-reclaimable="row.reclaimable ? 'true' : 'false'"
      >
        <button class="mem-jump" :title="t('memory.jump')" @click="emit('jump', row.paneId)">
          <span class="mem-name">{{ row.title }}</span>
          <span v-if="row.reclaimable" class="mem-tag">{{ t('memory.tag-idle') }}</span>
          <span class="mem-size">{{ sizeText(row.bytes) }}</span>
        </button>
      </li>
    </ul>
    <p v-else class="mem-empty">{{ t('memory.no-panes') }}</p>

    <div class="mem-foot">
      <button
        class="mem-reclaim"
        :disabled="reclaimableRows.length === 0"
        @click="emit('reclaim')"
      >
        {{ reclaimableRows.length > 0
          ? t('memory.reclaim-action', { count: reclaimableRows.length })
          : t('memory.reclaim-action-empty') }}
      </button>
      <p class="mem-note">
        {{ available ? t('memory.note') : t('memory.unavailable') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.mem-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.mem-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 320px;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  color: var(--text-secondary);
}
.mem-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.mem-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.mem-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
}
.mem-btn:hover { color: var(--text-bright); }
.mem-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.mem-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mem-k { flex: 1; min-width: 0; color: var(--text-muted); }
.mem-v { flex: none; color: var(--text-bright); font-weight: 600; }
.mem-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
}
.mem-jump {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.mem-jump:hover { background: var(--bg-hover); }
.mem-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-bright);
}
.mem-tag {
  flex: none;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-muted);
}
.mem-size {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}
.mem-empty {
  margin: 0;
  padding: 12px 10px;
  color: var(--text-muted);
}
.mem-foot {
  padding: 8px 10px;
  border-top: 1px solid var(--border-muted);
}
.mem-reclaim {
  width: 100%;
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.mem-reclaim:hover:not(:disabled) { background: var(--bg-hover); }
.mem-reclaim:disabled { opacity: 0.45; cursor: not-allowed; }
.mem-note {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}
</style>
