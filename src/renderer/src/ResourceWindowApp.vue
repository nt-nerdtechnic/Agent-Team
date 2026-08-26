<script setup lang="ts">
// Resource Manager window (?window=resources): every CLI this app is running,
// with what it is costing the machine right now.
//
// Machine-wide on purpose. The backend owns one TerminalService for the whole
// app, so a sweep here covers panes in every window — which is the scope the
// question has ("what is eating my laptop"), and the reason this is a window
// rather than a second popover.
//
// It holds no pane state of its own. The names come from the backend roster
// (agent_msg.list), the figures from terminal.resource_usage, and the two row
// actions are relayed through the main process to whichever window owns the
// pane, because focusing and reclaiming only exist there.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from './composables/useBackend'
import { initSettingsBackend, onSettingsChanged, settingsGet } from './lib/settings'
import { useTheme } from './composables/useTheme'
import { formatBytes } from './lib/formatBytes'
import { formatCpuPercent, machineCpuShare, machineMemoryShare } from './lib/resourceSampling'
import { useResourceUsage, type ResourceUsageWire } from './composables/useResourceUsage'

const backend = useBackend()
// Hook the settings cache to this window's own ws connection so a theme (or the
// auto-reclaim setting below) changed elsewhere arrives as a broadcast.
initSettingsBackend(backend)
const { loadTheme } = useTheme()
const { t } = useI18n()

// ── The roster: who exists ──────────────────────────────────────────────────
// Names live in the backend roster every window registers its panes with. It
// carries no live status — only a coarse `busy` the owning window reports —
// which is all a resource list needs.
interface RosterPane {
  pane_id?: string
  name?: string
  workspace_label?: string
  agent_key?: string
  busy?: boolean
  offline?: boolean
}
const roster = ref<RosterPane[]>([])
const ROSTER_POLL_MS = 5_000

async function refreshRoster(): Promise<void> {
  if (backend.status.value !== 'connected') return
  try {
    const resp = await backend.send<{ panes?: RosterPane[] }>('agent_msg.list', {})
    roster.value = (resp.payload?.panes ?? []).filter((p) => p.pane_id)
  } catch {
    // Keep the last list: a dropped request is not an empty machine.
  }
}
watch(() => backend.status.value, () => void refreshRoster(), { immediate: true })
const rosterTimer = setInterval(() => void refreshRoster(), ROSTER_POLL_MS)

// ── The figures: what each costs ────────────────────────────────────────────
const paneCount = computed(() => roster.value.length)
// This window is the panel, so it always samples at the fast cadence.
const panelOpen = ref(true)
const usage = useResourceUsage({
  request: async () => {
    if (backend.status.value !== 'connected') return null
    try {
      const resp = await backend.send<ResourceUsageWire>('terminal.resource_usage', {})
      return resp.payload ?? null
    } catch {
      return null
    }
  },
  paneCount,
  panelOpen,
})

// Recent CPU per pane, for the trend line. Kept only while this window is open:
// a sparkline is a "what just happened", and persisting it would mean sampling
// with nobody watching.
const TREND_POINTS = 30
const trends = ref(new Map<string, number[]>())
watch(usage.cpuPercentByPaneId, (current) => {
  const next = new Map<string, number[]>()
  for (const [paneId, percent] of current) {
    const prior = trends.value.get(paneId) ?? []
    const series = percent === null ? prior : [...prior, percent].slice(-TREND_POINTS)
    next.set(paneId, series)
  }
  trends.value = next
})

// ── Rows ────────────────────────────────────────────────────────────────────
type RowStatus = 'running' | 'idle' | 'disconnected'
interface ResourceWindowRow {
  paneId: string
  name: string
  vendor: string
  workspace: string
  status: RowStatus
  bytes: number
  cpuPercent: number | null
  trend: number[]
}

const rows = computed<ResourceWindowRow[]>(() =>
  roster.value.map((pane) => {
    const paneId = pane.pane_id as string
    return {
      paneId,
      name: pane.name || paneId,
      vendor: pane.agent_key ?? '',
      workspace: pane.workspace_label ?? '',
      // The roster knows three things about liveness, and no more: the window
      // that owns the pane is gone, the pane is mid-turn, or neither.
      status: pane.offline ? 'disconnected' : pane.busy ? 'running' : 'idle',
      bytes: usage.bytesByPaneId.value.get(paneId) ?? 0,
      cpuPercent: usage.cpuPercentByPaneId.value.get(paneId) ?? null,
      trend: trends.value.get(paneId) ?? [],
    }
  })
)

const filter = ref<'all' | 'running' | 'idle'>('all')
const sortBy = ref<'cpu' | 'memory' | 'name'>('memory')

const runningCount = computed(() => rows.value.filter((r) => r.status === 'running').length)
const idleCount = computed(() => rows.value.filter((r) => r.status !== 'running').length)

const visibleRows = computed(() => {
  const filtered = rows.value.filter((r) =>
    filter.value === 'all' ? true : filter.value === 'running' ? r.status === 'running' : r.status !== 'running'
  )
  return filtered.sort((a, b) => {
    if (sortBy.value === 'name') return a.name.localeCompare(b.name)
    if (sortBy.value === 'cpu') return (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.bytes - a.bytes
    return b.bytes - a.bytes || a.name.localeCompare(b.name)
  })
})

// Totals over what is listed, so the headline and the table always agree.
const totals = computed(() => {
  let bytes = 0
  let cpu = 0
  let cpuKnown = false
  for (const row of rows.value) {
    bytes += row.bytes
    if (row.cpuPercent !== null) {
      cpu += row.cpuPercent
      cpuKnown = true
    }
  }
  return { bytes, cpu: cpuKnown ? cpu : null }
})
const cpuShare = computed(() => machineCpuShare(totals.value.cpu, usage.cpuCount.value))
const memoryShare = computed(() =>
  machineMemoryShare(totals.value.bytes, usage.machineMemoryBytes.value)
)

function cpuText(percent: number | null): string {
  if (!usage.cpuAvailable.value) return '—'
  return formatCpuPercent(percent)
}
function sizeText(bytes: number): string {
  if (!usage.available.value) return '—'
  if (!usage.measured.value) return '…'
  return formatBytes(bytes)
}
function shareText(share: number | null): string {
  if (share === null) return t('resource.machine-share-unknown')
  return t('resource.machine-share', {
    percent: `${share < 10 ? share.toFixed(1) : Math.round(share)}%`,
  })
}

/** The trend line, scaled to its own maximum: the shape of the last minute is
 *  the point, not the absolute height, which the CPU column already gives. */
function sparkPoints(values: number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values, 1)
  const step = 60 / (values.length - 1)
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(15 - (Math.max(0, v) / max) * 13).toFixed(1)}`)
    .join(' ')
}

// ── Row actions ─────────────────────────────────────────────────────────────
// Both are relayed to the window that owns the pane; this one owns none.
const rowNotice = ref<{ paneId: string; kind: 'blocked' | 'gone' } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function flashNotice(paneId: string, kind: 'blocked' | 'gone'): void {
  rowNotice.value = { paneId, kind }
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    rowNotice.value = null
  }, 4_000)
}

async function paneAction(paneId: string, action: 'focus' | 'reclaim'): Promise<void> {
  const res = await window.agentTeam?.requestPaneAction?.({ paneId, action })
  if (res?.ok) {
    // A reclaimed pane keeps its roster entry (it becomes a placeholder), so
    // the figures are what change — re-measure rather than waiting a tick.
    if (action === 'reclaim') void usage.refresh()
    return
  }
  flashNotice(paneId, res?.error === 'blocked' ? 'blocked' : 'gone')
}

// ── Disk, on request ────────────────────────────────────────────────────────
// `storage.usage` walks several large trees (app data, every CLI profile home,
// every open workspace), so it is a button, not part of the sampling loop —
// the same reason the Storage settings page makes you ask for it.
const disk = ref<{ totalBytes: number; freeBytes: number } | null>(null)
const diskState = ref<'idle' | 'scanning' | 'failed'>('idle')

async function scanDisk(): Promise<void> {
  if (diskState.value === 'scanning' || backend.status.value !== 'connected') return
  diskState.value = 'scanning'
  try {
    const resp = await backend.send<{ disk?: { totalBytes?: number; freeBytes?: number } }>(
      'storage.usage',
      {}
    )
    const d = resp.payload?.disk
    if (d && typeof d.totalBytes === 'number' && typeof d.freeBytes === 'number') {
      disk.value = { totalBytes: d.totalBytes, freeBytes: d.freeBytes }
      diskState.value = 'idle'
      return
    }
    diskState.value = 'failed'
  } catch {
    diskState.value = 'failed'
  }
}

// ── Auto-reclaim, read-only ─────────────────────────────────────────────────
// Shown because it explains what will happen to the idle rows on its own. It is
// changed in Settings, in the main window; this window only reports it.
const autoReclaimOn = ref(settingsGet<string | null>('agentTeam.idleReclaim', null) !== '0')
const autoReclaimMinutes = ref(settingsGet<string>('agentTeam.idleReclaimMinutes', '30'))
let offSettings: (() => void) | null = null

onMounted(() => {
  document.title = 'Resource Manager'
  loadTheme()
  offSettings = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) loadTheme()
    if (keys.includes('agentTeam.idleReclaim')) {
      autoReclaimOn.value = settingsGet<string | null>('agentTeam.idleReclaim', null) !== '0'
    }
    if (keys.includes('agentTeam.idleReclaimMinutes')) {
      autoReclaimMinutes.value = settingsGet<string>('agentTeam.idleReclaimMinutes', '30')
    }
  })
})
onUnmounted(() => {
  clearInterval(rosterTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
  offSettings?.()
})
</script>

<template>
  <div class="rw">
    <div class="rw-summary">
      <div class="rw-metric" data-metric="cpu">
        <span class="rw-k">{{ t('resource.cpu') }}</span>
        <span class="rw-v" data-part="value">{{ cpuText(totals.cpu) }}</span>
        <span class="rw-sub">{{ shareText(cpuShare) }}</span>
      </div>
      <div class="rw-metric" data-metric="memory">
        <span class="rw-k">{{ t('resource.memory') }}</span>
        <span class="rw-v" data-part="value">{{ sizeText(totals.bytes) }}</span>
        <span class="rw-sub">{{ shareText(memoryShare) }}</span>
      </div>
      <span class="rw-spacer" />
      <button class="rw-ghost" data-act="refresh" @click="void usage.refresh()">
        {{ t('resource.refresh') }}
      </button>
    </div>

    <div class="rw-toolbar">
      <button
        v-for="f in (['all', 'running', 'idle'] as const)"
        :key="f"
        type="button"
        class="rw-tab"
        :class="{ on: filter === f }"
        :data-filter="f"
        @click="filter = f"
      >
        {{ f === 'all'
          ? t('resource.filter-all', { count: rows.length })
          : f === 'running'
            ? t('resource.filter-busy', { count: runningCount })
            : t('resource.filter-idle', { count: idleCount }) }}
      </button>
      <span class="rw-spacer" />
      <label class="rw-sort">
        <span>{{ t('resource.sort-label') }}</span>
        <select v-model="sortBy" data-act="sort">
          <option value="memory">{{ t('resource.sort-memory') }}</option>
          <option value="cpu">{{ t('resource.sort-cpu') }}</option>
          <option value="name">{{ t('resource.sort-name') }}</option>
        </select>
      </label>
    </div>

    <div class="rw-head">
      <span class="c-name">{{ t('resource.col-name') }}</span>
      <span class="c-trend">{{ t('resource.col-trend') }}</span>
      <span class="c-cpu">{{ t('resource.col-cpu') }}</span>
      <span class="c-mem">{{ t('resource.col-memory') }}</span>
      <span class="c-act" />
    </div>

    <div class="rw-rows">
      <div
        v-for="row in visibleRows"
        :key="row.paneId"
        class="rw-row"
        data-row="pane"
        :data-pane="row.paneId"
        :data-status="row.status"
      >
        <button class="c-name rw-jump" :title="t('resource.jump')" @click="void paneAction(row.paneId, 'focus')">
          <span class="rw-dot" />
          <span class="rw-name">{{ row.name }}</span>
          <span v-if="row.workspace || row.vendor" class="rw-meta">
            {{ [row.workspace, row.vendor].filter(Boolean).join(' · ') }}
          </span>
        </button>
        <span class="c-trend">
          <svg v-if="sparkPoints(row.trend)" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
            <polyline :points="sparkPoints(row.trend)" />
          </svg>
        </span>
        <span class="c-cpu" data-part="cpu">{{ cpuText(row.cpuPercent) }}</span>
        <span class="c-mem" data-part="memory">{{ sizeText(row.bytes) }}</span>
        <span class="c-act">
          <button class="rw-mini" data-act="reclaim" @click="void paneAction(row.paneId, 'reclaim')">
            {{ t('resource.reclaim-row') }}
          </button>
        </span>
        <span v-if="rowNotice?.paneId === row.paneId" class="rw-notice" data-part="notice">
          {{ rowNotice.kind === 'blocked' ? t('resource.reclaim-blocked') : t('resource.pane-gone') }}
        </span>
      </div>
      <p v-if="visibleRows.length === 0" class="rw-empty" data-row="empty">
        {{ t('resource.window-empty') }}
      </p>
    </div>

    <div class="rw-disk">
      <span class="rw-disk-k">{{ t('resource.disk') }}</span>
      <span class="rw-disk-v" data-part="disk">
        {{ diskState === 'scanning'
          ? t('resource.disk-scanning')
          : diskState === 'failed'
            ? t('resource.disk-failed')
            : disk
              ? t('resource.disk-free', {
                  free: formatBytes(disk.freeBytes),
                  total: formatBytes(disk.totalBytes),
                })
              : t('resource.disk-unscanned') }}
      </span>
      <span class="rw-spacer" />
      <button
        class="rw-ghost"
        data-act="scan-disk"
        :disabled="diskState === 'scanning'"
        @click="void scanDisk()"
      >
        {{ t('resource.disk-scan') }}
      </button>
    </div>

    <div class="rw-foot">
      <span class="rw-foot-text">
        {{ t('resource.auto-reclaim', {
          state: autoReclaimOn ? t('resource.auto-reclaim-on') : t('resource.auto-reclaim-off'),
          minutes: autoReclaimMinutes,
        }) }}
      </span>
      <span class="rw-spacer" />
      <span class="rw-foot-note">{{ usage.available.value ? t('resource.note') : t('resource.unavailable') }}</span>
    </div>
  </div>
</template>

<style scoped>
.rw {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: var(--font-xs);
}
.rw-spacer { flex: 1; }

.rw-summary {
  display: flex;
  align-items: flex-end;
  gap: 28px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.rw-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rw-k { color: var(--text-muted); font-size: var(--font-3xs); }
.rw-v {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-xl);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.rw-sub { color: var(--text-muted); font-size: var(--font-3xs); }

.rw-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.rw-tab {
  padding: 3px 10px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rw-tab.on {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-weight: 600;
}
.rw-sort {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-2xs);
}
.rw-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rw-ghost:hover { color: var(--text-bright); }

.rw-head,
.rw-row {
  display: grid;
  grid-template-columns: 1fr 68px 62px 76px 60px;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
}
.rw-head {
  padding-top: 7px;
  padding-bottom: 7px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  border-bottom: 1px solid var(--border-muted);
}
.rw-head .c-cpu,
.rw-head .c-mem { text-align: right; }

.rw-rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: 8px;
}
.rw-row {
  position: relative;
  border-bottom: 1px solid var(--border-muted);
  min-height: 34px;
}
.rw-row:hover { background: var(--bg-hover-faint); }

.rw-jump {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.rw-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--attention-fg);
  align-self: center;
}
.rw-row[data-status='running'] .rw-dot { background: var(--success-fg); }
.rw-row[data-status='disconnected'] .rw-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--attention-fg);
}
.rw-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.rw-meta {
  flex: none;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-trend svg {
  width: 60px;
  height: 15px;
  display: block;
}
.c-trend polyline {
  fill: none;
  stroke: var(--accent-fg);
  stroke-width: 1.2;
  opacity: 0.8;
}
.c-cpu,
.c-mem {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.c-mem { color: var(--text-bright); font-weight: 600; }
.c-act { text-align: right; }
.rw-mini {
  padding: 2px 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  cursor: pointer;
}
.rw-mini:hover { color: var(--text-bright); border-color: var(--border-default); }
.rw-notice {
  grid-column: 1 / -1;
  padding: 0 0 6px 13px;
  color: var(--attention-fg);
  font-size: var(--font-3xs);
}
.rw-empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}

.rw-disk {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  font-size: var(--font-2xs);
}
.rw-disk-k { color: var(--text-muted); }
.rw-disk-v { color: var(--text-secondary); }
.rw-ghost:disabled { color: var(--text-disabled); cursor: default; }

.rw-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.rw-foot-note {
  max-width: 46ch;
  text-align: right;
  line-height: 1.45;
}
</style>
