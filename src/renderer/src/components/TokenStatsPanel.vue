<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { settingsGet, settingsSet } from '@navide/shared'
import { useTokens, type TokenBucket, type ResetScope } from '../composables/useTokens'
import { useNotify } from '@navide/ui-foundation'
import type { useBackend } from '../composables/useBackend'
import HistoryPanel from './HistoryPanel.vue'
import TaskerPanel from './TaskerPanel.vue'
import AgentMessagesPanel from './AgentMessagesPanel.vue'
import type { PipelineStatusView } from './ControlPane.vue'

interface Stage {
  id: string
  shortTitle?: string
  title?: string
}

interface ActivePane {
  id: string
  agentLabel: string
  roleLabel: string
  stageId?: string
  slotLabel?: string
}

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  stages: Stage[]
  panes: ActivePane[]
  pipeline: PipelineStatusView
  /** Owned by the parent: this panel renders it and asks for changes. */
  expanded: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:expanded', v: boolean): void }>()

// We expose the workspace path as a ref so useTokens can watch() it.
const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { snapshot, loading, reset } = useTokens(props.backend, workspacePathRef)

// ─────────────────────── Sticky panel state ───────────────────────────────

// Controlled, not mirrored. This used to be a local ref seeded from the same
// settings key the parent reads, with `update:expanded` emitted one way — so
// `v-model:expanded` looked two-way but was not: the parent could never open or
// close the panel, and both sides persisted the key independently. The parent
// owns the value and the write; this component only asks.
const expanded = computed(() => props.expanded)
function setExpanded(v: boolean): void {
  emit('update:expanded', v)
}

// Active right-panel tab — the pipeline History timeline (default), token stats,
// Tasker (machine-level crontab / LaunchAgents), or the inter-CLI message log.
// Unknown or legacy persisted values fall back to the default.
const tab = ref<'history' | 'tokens' | 'tasker' | 'messages'>('history')
{
  const t = settingsGet<string | null>('agentTeam.rightPanel.tab', null)
  if (t === 'history' || t === 'tokens' || t === 'tasker' || t === 'messages') tab.value = t
}
watch(tab, (v) => {
  settingsSet('agentTeam.rightPanel.tab', v)
})

// ─────────────────────── Derived view models ──────────────────────────────

const EMPTY: TokenBucket = { input: 0, output: 0, calls: 0 }

const currentRun = computed(() => snapshot.value?.workspace?.current_run ?? null)
const runTotals = computed<TokenBucket>(() => currentRun.value?.totals ?? EMPTY)
const cumulative = computed<TokenBucket>(() =>
  snapshot.value?.workspace?.cumulative?.totals ?? EMPTY
)
const allTime = computed<TokenBucket>(() => snapshot.value?.global?.all_time ?? EMPTY)

// Names come from the specs, which already carry each vendor's display label
// — a second table here drifted from them silently. The analyzer is the one
// pseudo-vendor with no spec: it exists in token accounting only, and is not
// a spawnable CLI. (Cursor CLI stores no token data locally, so its row shows
// a label with empty stats.)
const ANALYZER = 'analyzer'
const VENDOR_LABELS: Record<string, string> = {
  ...Object.fromEntries(CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])),
  [ANALYZER]: 'Local analyzer'
}
const KNOWN_VENDORS = [...CLI_AGENT_SPECS.map((s) => s.agentKey), ANALYZER]

// Vendor / Stage breakdowns come from workspace CUMULATIVE (not just current run)
// so they remain visible even when no pipeline is actively running. The current
// run's contribution is already surfaced in its own "Current run" section above.
const cumulativeByVendor = computed(
  () => snapshot.value?.workspace?.cumulative?.by_vendor ?? {}
)
const cumulativeByStage = computed(
  () => snapshot.value?.workspace?.cumulative?.by_stage ?? {}
)

const vendorRows = computed(() => {
  const map = cumulativeByVendor.value
  return KNOWN_VENDORS.map((v) => ({
    key: v,
    label: VENDOR_LABELS[v] ?? v,
    bucket: map[v] ?? EMPTY
  }))
})

const stageRows = computed(() => {
  const map = cumulativeByStage.value
  return (props.stages ?? []).map((s) => ({
    id: s.id,
    label: s.shortTitle ?? s.title ?? s.id,
    bucket: map[s.id] ?? EMPTY
  }))
})

const paneRows = computed(() => {
  const map = currentRun.value?.by_pane ?? {}
  return (props.panes ?? []).map((p) => {
    // Prefer stable key (stageId:slotLabel) so data survives frontend restarts.
    // Fall back to UUID for manual panes that have no stage/slot.
    const stableKey = p.stageId && p.slotLabel ? `${p.stageId}:${p.slotLabel}`
                    : p.stageId || p.id
    return {
      id: p.id,
      label: p.agentLabel,
      sub: p.roleLabel,
      bucket: map[stableKey] ?? map[p.id] ?? EMPTY
    }
  })
})

const collapsedTotal = computed(() => fmt(runTotals.value.input + runTotals.value.output))

// ─────────────────────── Formatting helpers ───────────────────────────────

function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

// ─────────────────────── Reset confirmations ──────────────────────────────

const { confirm: notifyConfirm } = useNotify()

async function confirmReset(scope: ResetScope): Promise<void> {
  const msg = {
    run: 'Reset the current pipeline run’s token counters? Workspace cumulative and global totals stay intact.',
    workspace: 'Wipe all token data for this workspace (current run + runs history + cumulative)? Global totals stay intact.',
    global: 'Wipe global all-time token totals? This affects every workspace.'
  }[scope]
  if (!(await notifyConfirm(msg, { title: 'Reset tokens', confirmText: 'Reset' }))) return
  await reset(scope)
}
</script>

<template>
  <aside class="token-panel" :class="{ 'is-expanded': expanded, 'is-collapsed': !expanded }">
    <!-- Collapsed rail: one icon per tab — click to expand + switch tab -->
    <div v-if="!expanded" class="rail">
      <button class="rail-btn" :class="{ active: tab === 'history' }" title="Expand pipeline history" @click="tab = 'history'; setExpanded(true)">
        <span class="rail-icon">📜</span>
        <span class="rail-label">{{ $t('label.history') }}</span>
      </button>
      <button class="rail-btn" :class="{ active: tab === 'tokens' }" :title="`Expand token stats · ${collapsedTotal} so far`" @click="tab = 'tokens'; setExpanded(true)">
        <span class="rail-icon">📊</span>
        <span class="rail-label">{{ $t('label.tokens') }}</span>
        <span v-if="runTotals.calls > 0" class="rail-badge">{{ collapsedTotal }}</span>
      </button>
      <button class="rail-btn" :class="{ active: tab === 'tasker' }" title="Expand scheduled tasks" @click="tab = 'tasker'; setExpanded(true)">
        <span class="rail-icon">🗓</span>
        <span class="rail-label">{{ $t('label.tasker') }}</span>
      </button>
      <button class="rail-btn" :class="{ active: tab === 'messages' }" :title="$t('msg.expand-rail')" @click="tab = 'messages'; setExpanded(true)">
        <span class="rail-icon">✉</span>
        <span class="rail-label">{{ $t('label.messages') }}</span>
      </button>
    </div>

    <!-- Expanded panel -->
    <template v-else>
      <header class="hdr">
        <button class="collapse" :title="$t('action.collapse')" @click="setExpanded(false)">‹</button>
        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'history' }" @click="tab = 'history'">📜 {{ $t('label.history') }}</button>
          <button class="tab" :class="{ active: tab === 'tokens' }" @click="tab = 'tokens'">📊 {{ $t('label.tokens') }}</button>
          <button class="tab" :class="{ active: tab === 'tasker' }" @click="tab = 'tasker'">🗓 {{ $t('label.tasker') }}</button>
          <button class="tab" :class="{ active: tab === 'messages' }" @click="tab = 'messages'">✉ {{ $t('label.messages') }}</button>
        </div>
      </header>

      <HistoryPanel v-if="tab === 'history'" :backend="backend" :workspace-path="workspacePath" :pipeline="pipeline" />
      <TaskerPanel v-else-if="tab === 'tasker'" :backend="backend" />
      <AgentMessagesPanel v-else-if="tab === 'messages'" />

      <template v-else>
      <div v-if="loading && !snapshot" class="msg">{{ $t('label.loading') }}</div>

      <div class="body">
        <!-- Current run total -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ $t('label.current-run') }}</span>
            <button class="reset-btn" title="Reset run counter" @click="confirmReset('run')">⟲</button>
          </div>
          <div v-if="currentRun" class="run-meta" :title="currentRun.task">
            <span class="run-id">{{ currentRun.run_id || '—' }}</span>
          </div>
          <div v-else class="muted">{{ $t('label.no-active-run') }}</div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(runTotals.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(runTotals.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(runTotals.input + runTotals.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big">{{ runTotals.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- Cumulative (workspace lifetime) -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ $t('label.workspace-cumulative') }}</span>
            <button class="reset-btn" title="Wipe workspace history" @click="confirmReset('workspace')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(cumulative.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(cumulative.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(cumulative.input + cumulative.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big">{{ cumulative.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- Global all-time -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ $t('label.all-time-global') }}</span>
            <button class="reset-btn" title="Wipe global tally" @click="confirmReset('global')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big">{{ fmt(allTime.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(allTime.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big">{{ fmt(allTime.input + allTime.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big">{{ allTime.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- By Vendor -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-vendor') }}</span></div>
          <table class="grid">
            <tr v-for="row in vendorRows" :key="row.key">
              <th>{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
            <tr class="head">
              <th></th><td>{{ $t('label.in') }}</td><td>{{ $t('label.out') }}</td><td class="dim">{{ $t('label.calls') }}</td>
            </tr>
          </table>
        </section>

        <!-- By Stage -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-stage') }}</span></div>
          <div v-if="!stageRows.length" class="muted">{{ $t('label.no-stages') }}</div>
          <table v-else class="grid">
            <tr v-for="row in stageRows" :key="row.id">
              <th>{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
          </table>
        </section>

        <!-- By Pane -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-pane') }}</span></div>
          <div v-if="!paneRows.length" class="muted">{{ $t('label.no-active-panes') }}</div>
          <table v-else class="grid">
            <tr v-for="row in paneRows" :key="row.id">
              <th :title="row.sub">{{ row.label }}</th>
              <td>{{ fmt(row.bucket.input) }}</td>
              <td>{{ fmt(row.bucket.output) }}</td>
              <td class="dim">{{ row.bucket.calls }}</td>
            </tr>
          </table>
        </section>
      </div>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.token-panel {
  height: 100%;
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 12px;
  min-height: 0;
  overflow: hidden;
}

/* ─────── collapsed rail ─────── */
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  height: 100%;
  /* The vertical tab labels are tall and there are four of them; a short window
     would otherwise clip the last tab out of reach (.token-panel hides its
     overflow). Scrolling here keeps every tab reachable — the reasoning is
     unchanged by the extra button, only the height at which it starts to bite. */
  overflow-y: auto;
}
.rail-btn {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 4px;
  width: 100%;
}
.rail-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.rail-btn.active {
  color: var(--accent-fg);
}
.rail-icon { font-size: 16px; }
.rail-label {
  /* No rotate(180deg) here: that bottom-up "book spine" trick flips CJK
     glyphs upside down. Plain vertical-rl keeps CJK upright (top-to-bottom)
     and rotates Latin text 90° clockwise — both readable. */
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  font-size: 10px;
  text-transform: uppercase;
}
.rail-badge {
  font-size: 10px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  padding: 2px 6px;
  border-radius: 999px;
  margin-top: auto;
}

/* ─────── expanded panel ─────── */
.hdr {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.collapse {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 14px;
  line-height: 1;
}
.collapse:hover { color: var(--text-bright); }
.title {
  font-weight: 600;
  flex: 1;
}
.tabs {
  display: flex;
  gap: 4px;
  flex: 1;
  /* Four tabs no longer fit on one line at the panel's 180px minimum width, so
     the header grows to a second (or third) row rather than clipping a tab. The
     header is `flex-shrink: 0` and `.body` owns its own scrolling, so wrapping
     shortens the body instead of pushing it out of the panel. */
  flex-wrap: wrap;
  min-width: 0;
}
.tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 600;
}
.tab:hover { color: var(--text-bright); }
.tab.active {
  color: var(--text-bright);
  background: var(--bg-base);
  border-color: var(--border-default);
}
.body {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  padding: 8px 0;
  min-height: 0;
}
.msg { padding: 12px; color: var(--text-secondary); }

.block {
  padding: 8px 12px;
  border-bottom: 1px solid var(--bg-subtle);
}
.block-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.block-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  flex: 1;
}
.reset-btn {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  line-height: 1.7;
}
.reset-btn:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.run-meta {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-id {
  font-family: Menlo, Monaco, monospace;
}
.muted { color: var(--text-secondary); font-size: 11px; margin: 4px 0; }

.totals {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.cell {
  text-align: center;
  background: var(--bg-subtle);
  border-radius: 3px;
  padding: 6px 2px;
  overflow: hidden;
}
.big {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lbl {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  table-layout: fixed;
}
.grid tr.head td, .grid tr.head th {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  border-top: 1px solid var(--border-muted);
  padding-top: 4px;
}
.grid th {
  text-align: left;
  font-weight: 500;
  color: var(--text-primary);
  padding: 3px 4px 3px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grid td {
  text-align: right;
  padding: 3px 4px;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid td.dim { color: var(--text-secondary); }
</style>
