<script setup lang="ts">
/**
 * The MCP page's unified half: every MCP server on this machine, whoever
 * configured it.
 *
 * Two sources, like the skills library: **Navide's own** servers (the list
 * above this pane, which Navide connects to as a client) and the **native**
 * servers each CLI keeps in its own config. Reflection is strictly read-only —
 * the backend module that scans has no write path — so a CLI's own MCP setup
 * keeps working exactly as it did, whether or not Navide is running.
 *
 * One filter bar drives two views over the same rows: cards to browse, a
 * matrix to compare where a server is set up. Clicking either opens the same
 * drawer.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'

type Backend = ReturnType<typeof useBackend>

/** One server in a CLI's own config, as the backend reflected it. */
interface NativeMcpServer {
  name: string
  /** Agent key whose config this came from. */
  agent: string
  transport: string
  /** The config file it was read from. */
  path: string
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
  enabled: boolean
  valid: boolean
  error: string
}

/** One of Navide's own servers, as `mcp.list_servers` returns it. */
interface NavideMcpServer {
  name: string
  transport: string
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
  status?: string
  tool_count?: number
}

/** One CLI vendor and what Navide can do with its MCP. */
interface McpAgent {
  key: string
  label: string
  state: 'wired' | 'planned' | 'unsupported'
  /** Whether the scan can read this CLI's own servers at all. */
  reflects: boolean
}

/** One row: a server name and everywhere on this machine it is configured. */
interface McpRow {
  key: string
  name: string
  navide: NavideMcpServer | null
  natives: NativeMcpServer[]
  /** Which group the row is filed under in the browse view. */
  source: string
}

/** The Navide column's key in the matrix; no vendor may use it. */
const NAVIDE = '__navide__'

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const navideServers = ref<NavideMcpServer[]>([])
const natives = ref<NativeMcpServer[]>([])
const agents = ref<McpAgent[]>([])
const loading = ref(false)
const error = ref('')
const query = ref('')
const view = ref<'browse' | 'compare'>('browse')
const sourceFilter = ref('all')
const selectedKey = ref<string | null>(null)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) out[key] = stringValue(raw)
  return out
}

function normalizeNative(value: unknown): NativeMcpServer | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  return {
    name: value.name,
    agent: stringValue(value.agent),
    transport: stringValue(value.transport, 'unknown'),
    path: stringValue(value.path),
    command: stringValue(value.command),
    args: stringList(value.args),
    url: stringValue(value.url),
    env: stringMap(value.env),
    headers: stringMap(value.headers),
    enabled: value.enabled !== false,
    valid: value.valid !== false,
    error: stringValue(value.error),
  }
}

function normalizeAgent(value: unknown): McpAgent | null {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key) return null
  const state = stringValue(value.state, 'unsupported')
  return {
    key: value.key,
    label: stringValue(value.label, value.key),
    state: state === 'wired' || state === 'planned' ? state : 'unsupported',
    reflects: value.reflects === true,
  }
}

/**
 * Reloads race: the parent refreshes this pane whenever it reloads its own
 * list, and the pane has its own Refresh. Without a sequence number a slow
 * earlier response overwrites a newer one and `loading` clears on whichever
 * finishes first, so the pane would claim to be settled on stale rows.
 */
let reloadSeq = 0

async function reload(): Promise<void> {
  const mine = ++reloadSeq
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{
      servers?: unknown
      native?: unknown
      agents?: unknown
    }>('mcp.list_servers', {})
    if (mine !== reloadSeq) return
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? t('settings.mcp.agent-error-load')
      return
    }
    navideServers.value = (Array.isArray(resp.payload.servers) ? resp.payload.servers : [])
      .filter(isRecord)
      .filter((server): server is Record<string, unknown> & { name: string } =>
        typeof server.name === 'string' && !!server.name,
      )
      .map((server) => ({
        name: server.name,
        transport: stringValue(server.transport, 'stdio'),
        command: stringValue(server.command),
        args: stringList(server.args),
        url: stringValue(server.url),
        enabled: server.enabled !== false,
        status: stringValue(server.status, 'unknown'),
        tool_count: typeof server.tool_count === 'number' ? server.tool_count : 0,
      }))
    natives.value = (Array.isArray(resp.payload.native) ? resp.payload.native : [])
      .map(normalizeNative)
      .filter((entry): entry is NativeMcpServer => entry !== null)
    agents.value = (Array.isArray(resp.payload.agents) ? resp.payload.agents : [])
      .map(normalizeAgent)
      .filter((entry): entry is McpAgent => entry !== null)
    if (selectedKey.value && !rows.value.some((row) => row.key === selectedKey.value)) {
      selectedKey.value = null
    }
  } catch (err) {
    if (mine === reloadSeq) error.value = String((err as Error).message ?? err)
  } finally {
    if (mine === reloadSeq) loading.value = false
  }
}

const agentLabels = computed(() => {
  const map = new Map<string, string>()
  for (const agent of agents.value) map.set(agent.key, agent.label)
  return map
})

/** Every server on the machine, one row per name, deduped across sources. */
const rows = computed<McpRow[]>(() => {
  const byKey = new Map<string, McpRow>()
  const take = (name: string): McpRow => {
    const key = name.toLowerCase()
    let row = byKey.get(key)
    if (!row) {
      row = { key, name, navide: null, natives: [], source: '' }
      byKey.set(key, row)
    }
    return row
  }
  for (const server of navideServers.value) {
    const row = take(server.name)
    row.navide = server
    row.source = NAVIDE
  }
  for (const native of natives.value) {
    const row = take(native.name)
    row.natives.push(native)
    if (!row.source) row.source = native.agent
  }
  return [...byKey.values()]
})

const visibleRows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (sourceFilter.value === NAVIDE && !row.navide) return false
    if (sourceFilter.value !== 'all' && sourceFilter.value !== NAVIDE) {
      if (!row.natives.some((native) => native.agent === sourceFilter.value)) return false
    }
    if (!needle) return true
    const haystack = [
      row.name,
      row.navide?.command ?? '',
      ...(row.navide?.args ?? []),
      row.navide?.url ?? '',
      ...row.natives.map(
        (native) => `${native.command} ${native.args.join(' ')} ${native.url} ${native.path}`,
      ),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })
})

/** Browse groups, Navide first then each agent in the vendor order. */
const groupedRows = computed(() => {
  const order = [NAVIDE, ...agents.value.map((agent) => agent.key)]
  return order
    .map((source) => ({
      source,
      label: sourceLabel(source),
      rows: visibleRows.value.filter((row) => row.source === source),
    }))
    .filter((group) => group.rows.length > 0)
})

/** Chips carry counts so an empty source is visibly empty, not missing. */
const sourceChips = computed(() => {
  const chips = [
    { key: 'all', label: t('settings.mcp.filter-all'), count: rows.value.length },
    {
      key: NAVIDE,
      label: t('settings.mcp.source-navide'),
      count: rows.value.filter((row) => row.navide).length,
    },
  ]
  for (const agent of agents.value) {
    const count = natives.value.filter((native) => native.agent === agent.key).length
    if (count > 0) chips.push({ key: agent.key, label: agent.key, count })
  }
  return chips
})

const selectedRow = computed(
  () => visibleRows.value.find((row) => row.key === selectedKey.value) ?? null,
)

function sourceLabel(source: string): string {
  if (source === NAVIDE) return t('settings.mcp.source-navide')
  return agentLabels.value.get(source) ?? source
}

function rowTransport(row: McpRow): string {
  return row.navide?.transport ?? row.natives[0]?.transport ?? 'unknown'
}

/** Where the row is set up: one chip per place, Navide's first. */
function placeChips(row: McpRow): { key: string; label: string; off: boolean }[] {
  const chips: { key: string; label: string; off: boolean }[] = []
  if (row.navide) {
    chips.push({
      key: NAVIDE,
      label: t('settings.mcp.source-navide'),
      off: row.navide.enabled === false,
    })
  }
  for (const native of row.natives) {
    chips.push({ key: native.agent, label: native.agent, off: !native.enabled })
  }
  return chips
}

function nativeFor(row: McpRow, agentKey: string): NativeMcpServer | undefined {
  return row.natives.find((native) => native.agent === agentKey)
}

/** A matrix cell: what this column knows about this row. */
function cellState(row: McpRow, agent: McpAgent): string {
  const native = nativeFor(row, agent.key)
  if (native) return native.enabled ? 'here' : 'disabled'
  if (agent.state === 'unsupported') return 'unsupported'
  return 'off'
}

function cellGlyph(row: McpRow, agent: McpAgent): string {
  const state = cellState(row, agent)
  if (state === 'here') return '✓'
  if (state === 'disabled') return '·'
  if (state === 'unsupported') return '—'
  return ''
}

function cellHint(row: McpRow, agent: McpAgent): string {
  const state = cellState(row, agent)
  const key =
    state === 'here'
      ? 'matrix-hint-here'
      : state === 'disabled'
        ? 'matrix-hint-disabled'
        : state === 'unsupported'
          ? 'matrix-hint-unsupported'
          : 'matrix-hint-off'
  return t(`settings.mcp.${key}`, { name: row.name, agent: agent.label })
}

function navideCellState(row: McpRow): string {
  if (!row.navide) return 'off'
  return row.navide.enabled === false ? 'disabled' : 'here'
}

function navideCellGlyph(row: McpRow): string {
  const state = navideCellState(row)
  return state === 'here' ? '✓' : state === 'disabled' ? '·' : ''
}

function openRow(row: McpRow): void {
  selectedKey.value = selectedKey.value === row.key ? null : row.key
}

function closeDrawer(): void {
  selectedKey.value = null
}

async function openConfig(path: string): Promise<void> {
  if (path) await window.agentTeam?.openPath?.(path)
}

function entries(map: Record<string, string>): [string, string][] {
  return Object.entries(map)
}

onMounted(reload)

defineExpose({ reload })
</script>

<template>
  <section class="mcp-pane" :aria-label="t('settings.mcp.agent-title')">
    <header class="mcp-pane-head">
      <div>
        <h2>{{ t('settings.mcp.agent-title') }}</h2>
        <p>{{ t('settings.mcp.agent-intro') }}</p>
      </div>
      <button type="button" :disabled="loading" @click="reload">{{ t('action.refresh') }}</button>
    </header>

    <p v-if="error" class="mcp-pane-error" role="alert">{{ error }}</p>

    <div class="mcp-filterbar">
      <div class="mcp-chips" role="group" :aria-label="t('settings.mcp.filter-label')">
        <button
          v-for="chip in sourceChips"
          :key="chip.key"
          type="button"
          class="mcp-chip"
          :class="{ on: sourceFilter === chip.key }"
          :aria-pressed="sourceFilter === chip.key"
          @click="sourceFilter = chip.key"
        >{{ chip.label }}<span class="count">{{ chip.count }}</span></button>
      </div>
      <input
        v-model="query"
        class="mcp-pane-search"
        type="search"
        :placeholder="t('settings.mcp.agent-search')"
      />
      <div class="mcp-view-switch" role="group" :aria-label="t('settings.mcp.view-label')">
        <button
          type="button"
          :class="{ on: view === 'browse' }"
          :aria-pressed="view === 'browse'"
          @click="view = 'browse'"
        >{{ t('settings.mcp.view-browse') }}</button>
        <button
          type="button"
          :class="{ on: view === 'compare' }"
          :aria-pressed="view === 'compare'"
          @click="view = 'compare'"
        >{{ t('settings.mcp.view-compare') }}</button>
      </div>
    </div>

    <div class="mcp-pane-body" :class="{ 'drawer-open': selectedRow !== null }">
      <div class="mcp-pane-main">
        <div v-if="loading" class="mcp-pane-state nv-loading">{{ t('label.loading') }}</div>
        <div v-else-if="visibleRows.length === 0" class="mcp-pane-state nv-empty">
          <strong>{{ t('settings.mcp.agent-empty-title') }}</strong>
          <span>{{ t('settings.mcp.agent-empty-body') }}</span>
        </div>

        <!-- Browse: one card per server, grouped by where it came from. -->
        <template v-else-if="view === 'browse'">
          <section v-for="group in groupedRows" :key="group.source" class="mcp-group">
            <h3 class="mcp-group-title">
              {{ group.label }}<span class="count">{{ group.rows.length }}</span>
            </h3>
            <div class="mcp-cards">
              <button
                v-for="row in group.rows"
                :key="row.key"
                type="button"
                class="mcp-card"
                :class="{ active: selectedKey === row.key, native: !row.navide }"
                @click="openRow(row)"
              >
                <span class="mcp-card-head">
                  <strong>{{ row.name }}</strong>
                  <span class="mcp-tag">{{ rowTransport(row) }}</span>
                </span>
                <span class="mcp-card-detail">
                  {{ row.navide?.url || row.navide?.command || row.natives[0]?.url || row.natives[0]?.command || row.natives[0]?.error || '—' }}
                </span>
                <span class="mcp-card-places" aria-hidden="true">
                  <span
                    v-for="chip in placeChips(row)"
                    :key="chip.key"
                    class="pchip"
                    :class="{ off: chip.off }"
                  >{{ chip.label }}</span>
                </span>
              </button>
            </div>
          </section>
        </template>

        <!-- Compare: the same rows as a matrix, one column per place. -->
        <section v-else class="mcp-matrix">
          <div class="mcp-matrix-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col" class="corner">{{ t('settings.mcp.matrix-server') }}</th>
                  <th scope="col" class="navide">{{ t('settings.mcp.source-navide') }}</th>
                  <th
                    v-for="agent in agents"
                    :key="agent.key"
                    scope="col"
                    :class="agent.state"
                    :title="agent.label"
                  >{{ agent.key }}</th>
                </tr>
              </thead>
              <tbody v-for="group in groupedRows" :key="group.source">
                <tr class="group">
                  <th scope="rowgroup" :colspan="agents.length + 2">{{ group.label }}</th>
                </tr>
                <tr
                  v-for="row in group.rows"
                  :key="row.key"
                  :class="{ active: selectedKey === row.key }"
                >
                  <th scope="row">
                    <button type="button" class="matrix-name" @click="openRow(row)">{{ row.name }}</button>
                  </th>
                  <td :class="navideCellState(row)">
                    <span>{{ navideCellGlyph(row) }}</span>
                  </td>
                  <td
                    v-for="agent in agents"
                    :key="agent.key"
                    :class="cellState(row, agent)"
                    :title="cellHint(row, agent)"
                  >
                    <span>{{ cellGlyph(row, agent) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ul class="mcp-matrix-legend">
            <li><span class="swatch here">✓</span>{{ t('settings.mcp.matrix-legend-here') }}</li>
            <li><span class="swatch disabled">·</span>{{ t('settings.mcp.matrix-legend-disabled') }}</li>
            <li><span class="swatch off"></span>{{ t('settings.mcp.matrix-legend-off') }}</li>
            <li><span class="swatch unsupported">—</span>{{ t('settings.mcp.matrix-legend-unsupported') }}</li>
          </ul>
        </section>
      </div>

      <!-- Drawer: every place this server is configured, read-only. -->
      <aside v-if="selectedRow" class="mcp-drawer" :aria-label="selectedRow.name">
        <header class="mcp-drawer-head">
          <div class="mcp-drawer-title">
            <h3>{{ selectedRow.name }}</h3>
            <span class="mcp-tag">{{ rowTransport(selectedRow) }}</span>
          </div>
          <button
            type="button"
            class="mcp-drawer-close"
            :aria-label="t('action.close')"
            @click="closeDrawer"
          >✕</button>
        </header>

        <section v-if="selectedRow.navide" class="mcp-drawer-section">
          <h4>{{ t('settings.mcp.source-navide') }}</h4>
          <p class="mcp-drawer-hint">{{ t('settings.mcp.navide-scope-hint') }}</p>
          <code v-if="selectedRow.navide.url" class="mcp-drawer-path">{{ selectedRow.navide.url }}</code>
          <code v-else-if="selectedRow.navide.command" class="mcp-drawer-path">
            {{ [selectedRow.navide.command, ...(selectedRow.navide.args ?? [])].join(' ') }}
          </code>
          <span class="mcp-drawer-meta">
            {{ selectedRow.navide.enabled === false ? t('settings.mcp.state-off') : t('settings.mcp.status', { status: selectedRow.navide.status }) }}
          </span>
        </section>

        <section
          v-for="native in selectedRow.natives"
          :key="`${native.agent}:${native.path}`"
          class="mcp-drawer-section"
        >
          <h4>{{ agentLabels.get(native.agent) ?? native.agent }}</h4>
          <p v-if="!native.valid" class="mcp-drawer-hint danger">{{ native.error }}</p>
          <code v-if="native.url" class="mcp-drawer-path">{{ native.url }}</code>
          <code v-else-if="native.command" class="mcp-drawer-path">
            {{ [native.command, ...native.args].join(' ') }}
          </code>
          <span class="mcp-drawer-meta">
            {{ native.enabled ? t('settings.mcp.state-on') : t('settings.mcp.state-off') }} · {{ native.transport }}
          </span>
          <dl v-if="entries(native.env).length" class="mcp-drawer-kv">
            <template v-for="[key, value] in entries(native.env)" :key="`e-${key}`">
              <dt>{{ key }}</dt>
              <dd>{{ value || '—' }}</dd>
            </template>
          </dl>
          <dl v-if="entries(native.headers).length" class="mcp-drawer-kv">
            <template v-for="[key, value] in entries(native.headers)" :key="`h-${key}`">
              <dt>{{ key }}</dt>
              <dd>{{ value || '—' }}</dd>
            </template>
          </dl>
          <code class="mcp-drawer-path muted">{{ native.path }}</code>
          <div class="mcp-drawer-actions">
            <button type="button" @click="openConfig(native.path)">
              {{ t('settings.mcp.open-config-file') }}
            </button>
          </div>
        </section>

        <p class="mcp-drawer-hint">{{ t('settings.mcp.native-readonly-hint') }}</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.mcp-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  color: var(--text-primary);
}
.mcp-pane-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.mcp-pane-head h2 { margin: 0; font-size: 15px; color: var(--text-bright); }
.mcp-pane-head p { margin: 3px 0 0; color: var(--text-secondary); font-size: var(--font-2xs); }
button, input { font: inherit; }
button {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  padding: 5px 9px;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-bright); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent-emphasis); outline-offset: 2px; }
.mcp-pane-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default));
  border-radius: var(--radius-control);
  color: var(--danger-fg);
  background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle));
  font-size: var(--font-2xs);
}
input {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 7px 8px;
}
input:focus { border-color: var(--accent-emphasis); }

/* ── Filter bar: one bar, both views ───────────────────────────────────── */
.mcp-filterbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mcp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.mcp-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
}
.mcp-chip.on { background: var(--bg-elevated); color: var(--text-bright); font-weight: 600; }
.mcp-chip .count { font-size: var(--font-3xs); opacity: 0.6; font-variant-numeric: tabular-nums; }
.mcp-pane-search { flex: 1; min-width: 140px; max-width: 260px; }
.mcp-view-switch {
  margin-left: auto;
  display: inline-flex;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  overflow: hidden;
}
.mcp-view-switch button { border: 0; border-radius: 0; background: transparent; padding: 5px 11px; font-size: var(--font-2xs); }
.mcp-view-switch button.on { background: var(--bg-elevated); color: var(--text-bright); font-weight: 600; }

/* ── Body: main region + optional drawer ───────────────────────────────── */
.mcp-pane-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-height: 0; }
.mcp-pane-body.drawer-open { grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); }
.mcp-pane-main { min-width: 0; }
.mcp-pane-state { display: flex; flex-direction: column; gap: 4px; padding: 18px 8px; color: var(--text-secondary); font-size: var(--font-2xs); text-align: center; }
.mcp-pane-state strong { color: var(--text-bright); }

/* ── Browse ────────────────────────────────────────────────────────────── */
.mcp-group { margin-bottom: 14px; }
.mcp-group-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 10px 4px 6px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.mcp-group-title .count { font-weight: 500; opacity: 0.6; font-variant-numeric: tabular-nums; }
.mcp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
.mcp-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 9px 11px;
  text-align: left;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  min-width: 0;
}
.mcp-card:hover:not(:disabled) { background: var(--bg-muted); border-color: var(--border-default); }
.mcp-card.active { border-color: var(--accent-fg, var(--border-emphasis)); background: var(--bg-muted); }
.mcp-card.native { border-style: dashed; }
.mcp-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.mcp-card-head strong { font-size: var(--font-xs); color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-card-detail {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  font-family: Menlo, Monaco, monospace;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
.mcp-card-places { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
.pchip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-3xs);
  font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--success-fg) 40%, transparent);
  color: var(--success-fg);
  white-space: nowrap;
  line-height: var(--lh-base);
}
.pchip.off { color: var(--text-secondary); border-color: var(--border-muted); opacity: 0.75; }
.mcp-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  flex: none;
  text-transform: uppercase;
}

/* ── Compare: the matrix ───────────────────────────────────────────────── */
.mcp-matrix { display: flex; flex-direction: column; gap: 9px; min-height: 0; }
/* One column per place: reflowing it would lose the comparison it exists for. */
.mcp-matrix-scroll {
  overflow: auto;
  /* Bounded: the matrix grows a row per server, and an unbounded one would
     push the blocks above and below it off the settings page. */
  max-height: 46vh;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
}
.mcp-matrix table { border-collapse: separate; border-spacing: 0; font-size: var(--font-2xs); width: 100%; }
.mcp-matrix th, .mcp-matrix td { border-bottom: 1px solid var(--border-muted); padding: 0; white-space: nowrap; }
.mcp-matrix thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-weight: 600;
  padding: 6px 7px;
  text-align: center;
}
.mcp-matrix thead th.planned, .mcp-matrix thead th.unsupported { opacity: 0.55; }
.mcp-matrix thead th.corner, .mcp-matrix tbody th {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-muted);
  text-align: left;
  padding: 4px 9px 4px 7px;
  min-width: 150px;
}
.mcp-matrix thead th.corner { z-index: 3; }
.mcp-matrix tbody th { background: var(--bg-base); }
.mcp-matrix .matrix-name { border: 0; background: transparent; padding: 2px 0; font-size: var(--font-2xs); color: inherit; text-align: left; }
.mcp-matrix .matrix-name:hover { text-decoration: underline; background: transparent; }
.mcp-matrix tbody tr.active th { color: var(--text-bright); }
.mcp-matrix td > span { display: block; padding: 5px 7px; min-width: 34px; text-align: center; line-height: 1.4; }
.mcp-matrix td.here > span { color: var(--accent-success, #6BC77F); font-weight: 700; }
.mcp-matrix td.disabled > span { color: var(--text-secondary); opacity: 0.7; }
.mcp-matrix td.unsupported { background: var(--bg-muted); }
.mcp-matrix td.unsupported > span { color: var(--text-secondary); opacity: 0.6; }
.mcp-matrix tbody tr.group th {
  background: var(--bg-muted);
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  padding: 5px 9px 4px 7px;
}
.mcp-matrix-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font-size: 10.5px;
}
.mcp-matrix-legend li { display: flex; align-items: center; gap: 5px; }
.mcp-matrix-legend .swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
}
.mcp-matrix-legend .swatch.here { color: var(--accent-success, #6BC77F); font-weight: 700; }
.mcp-matrix-legend .swatch.unsupported { background: var(--bg-muted); }

/* ── Drawer ────────────────────────────────────────────────────────────── */
.mcp-drawer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 12px;
  padding: 12px 14px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.mcp-drawer-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.mcp-drawer-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.mcp-drawer-title h3 { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.mcp-drawer-close { padding: 2px 7px; font-size: var(--font-xs); line-height: 1; }
.mcp-drawer-section { display: flex; flex-direction: column; gap: 6px; }
.mcp-drawer-section h4 { margin: 0; font-size: var(--font-3xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
.mcp-drawer-hint { margin: 0; font-size: 10.5px; color: var(--text-secondary); line-height: 1.4; }
.mcp-drawer-hint.danger { color: var(--danger-fg); }
.mcp-drawer-meta { font-size: 10.5px; color: var(--text-secondary); }
.mcp-drawer-path {
  display: block;
  font-size: 10.5px;
  padding: 5px 8px;
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  word-break: break-all;
}
.mcp-drawer-path.muted { color: var(--text-secondary); }
.mcp-drawer-kv { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 2px 10px; margin: 0; font-size: 10.5px; }
.mcp-drawer-kv dt { color: var(--text-secondary); }
.mcp-drawer-kv dd { margin: 0; word-break: break-all; }
.mcp-drawer-actions { display: flex; justify-content: flex-start; gap: 8px; }

@media (max-width: 900px) {
  .mcp-pane-body, .mcp-pane-body.drawer-open { grid-template-columns: 1fr; }
}
</style>
