<script setup lang="ts">
// Editable keyboard shortcuts.
//
// Rows are generated from the command manifest joined with defaults.ts, so the
// list can never drift from the bindings the resolver actually runs, and it
// includes the commands that ship with no key at all — the ones a user most
// needs to reach. Keys the central rule table does not own (terminal control
// sequences, the Electron menu) are appended as read-only reference sections.
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildRows,
  classifyRow,
  conflictsByRow,
  resetRow,
  reviewImportedRules,
  serializeUserRules,
  setRowKeys,
  type BindingRow,
} from '../keybindings/customization'
import { commandI18nKey } from '../keybindings/commandCatalog'
import { formatKeySpec, keySpecToTokens } from '../keybindings/keyDisplay'
import {
  MENU_OWNED_SPECS,
  NATIVE_MENU_KEYS,
  TERMINAL_KEYS,
  splitKeyTokens,
  type ExternalKeyRow,
} from '../keybindings/externalKeys'
import { eventToKeyString, validateKeySpec } from '../keybindings/parseKey'
import {
  getUserRules,
  onUserRulesChanged,
  saveUserRules,
  setKeyCaptureActive,
} from '../keybindings/useKeybindings'
import type { KeybindingRule } from '../keybindings/types'

type FilterMode = 'all' | 'customized' | 'conflicts'

const { t, te } = useI18n()

/**
 * Translated command title, falling back to the label derived from the id.
 * A command added without an i18n entry then shows a readable English name
 * rather than a blank cell.
 */
function labelFor(row: BindingRow): string {
  const key = commandI18nKey(row.command)
  return te(key) ? t(key) : row.label
}

const userRules = ref<KeybindingRule[]>([...getUserRules()])
const query = ref('')
const filterMode = ref<FilterMode>('all')
const saveError = ref('')

const stopWatching = onUserRulesChanged(() => {
  userRules.value = [...getUserRules()]
})
onUnmounted(() => {
  stopWatching()
  if (recording.value) stopRecording()
})

const rows = computed(() => buildRows(userRules.value))
const conflicts = computed(() => conflictsByRow(rows.value))
const customizedCount = computed(() => rows.value.filter((r) => r.customized).length)

function searchText(row: BindingRow): string {
  // Both forms: the rule spelling ("cmd+shift+p") and what the caps show
  // ("⌘⇧P"), so typing either finds the row.
  const keys = row.keys.map((k) => `${k.key} ${formatKeySpec(k.key)}`).join(' ')
  // Both the translated title and the derived English one, so the list stays
  // searchable by either while the UI is in Chinese.
  return `${labelFor(row)} ${row.label} ${row.command} ${row.category} ${row.when ?? ''} ${keys}`
    .toLowerCase()
}

const visibleRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (filterMode.value === 'customized' && !row.customized) return false
    if (filterMode.value === 'conflicts' && !conflicts.value.has(row.id)) return false
    if (!q) return true
    return searchText(row).includes(q)
  })
})

// Rows are emitted in defaults.ts order; group headers keep that order readable
// without re-sorting the list out from under the user.
const groupedRows = computed(() => {
  const groups: { category: string; rows: BindingRow[] }[] = []
  for (const row of visibleRows.value) {
    const last = groups[groups.length - 1]
    if (last && last.category === row.category) last.rows.push(row)
    else groups.push({ category: row.category, rows: [row] })
  }
  return groups
})

function hardConflict(row: BindingRow): boolean {
  return (conflicts.value.get(row.id) ?? []).some((c) => c.hard)
}

function conflictTitle(row: BindingRow): string {
  const list = conflicts.value.get(row.id) ?? []
  return list
    .map((c) => {
      const others = c.rows.filter((r) => r.id !== row.id).map(labelFor)
      return `${c.key} → ${others.join(', ')}`
    })
    .join('\n')
}

// ── Persistence ───────────────────────────────────────────────────────────────
async function commit(next: KeybindingRule[]): Promise<void> {
  saveError.value = ''
  userRules.value = next
  const result = await saveUserRules(next)
  saveError.value = result.ok ? '' : (result.error ?? 'write failed')
}

function applyKeys(row: BindingRow, keys: string[]): Promise<void> {
  return commit(setRowKeys(userRules.value, row, keys))
}

function onReset(row: BindingRow): Promise<void> {
  return commit(resetRow(userRules.value, row))
}

function onResetAll(): Promise<void> {
  return commit([])
}

function onRemoveKey(row: BindingRow, key: string): Promise<void> {
  return applyKeys(row, row.keys.map((k) => k.key).filter((k) => k !== key))
}

// ── Recorder ──────────────────────────────────────────────────────────────────
interface Recording {
  rowId: string
  replacing: string | null // the chip being re-recorded, null when adding
  segments: string[]
}

const recording = ref<Recording | null>(null)

function isRecordingRow(row: BindingRow): boolean {
  return recording.value?.rowId === row.id
}

function isRecording(row: BindingRow, key: string): boolean {
  const r = recording.value
  return !!r && r.rowId === row.id && r.replacing === key
}

function onRecordKeydown(e: KeyboardEvent): void {
  // The recorder swallows the event outright rather than letting the dispatcher
  // see it, so nothing it captures can fire a command mid-recording.
  e.preventDefault()
  e.stopImmediatePropagation()
  if (e.isComposing) return
  // Bare Escape abandons the recording — the convention every editor follows.
  // Without it the recorder has no keyboard exit at all: Escape, Tab and Enter
  // are all swallowed, leaving keyboard-only users stuck until they reach for
  // the mouse. Modified Escape (⇧Esc and the like) stays recordable, and plain
  // Escape can still be bound by hand in keybindings.json if someone wants it.
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    stopRecording()
    return
  }
  const segment = eventToKeyString(e)
  if (!segment) return // modifiers alone: keep waiting
  const r = recording.value
  if (!r) return
  // Two segments is the resolver's chord limit; a third would parse but never
  // match, so cycle back to a fresh single key instead of silently dead-ending.
  r.segments = r.segments.length >= 2 ? [segment] : [...r.segments, segment]
}

function startRecording(row: BindingRow, replacing: string | null): void {
  if (recording.value) stopRecording()
  recording.value = { rowId: row.id, replacing, segments: [] }
  setKeyCaptureActive(true)
  window.addEventListener('keydown', onRecordKeydown, { capture: true })
}

function stopRecording(): void {
  window.removeEventListener('keydown', onRecordKeydown, { capture: true })
  setKeyCaptureActive(false)
  recording.value = null
}

const recordedSpec = computed(() => recording.value?.segments.join(' ') ?? '')

async function confirmRecording(row: BindingRow): Promise<void> {
  const r = recording.value
  if (!r || !r.segments.length) return
  const spec = r.segments.join(' ')
  const current = row.keys.map((k) => k.key)
  const next = r.replacing
    ? current.map((k) => (k === r.replacing ? spec : k))
    : [...current, spec]
  stopRecording()
  // setRowKeys drops anything validateKeySpec rejects, so without this the chip
  // would simply fail to appear with no reason given.
  if (!validateKeySpec(spec).ok) {
    saveError.value = t('settings.keybindings.invalid-key', { key: formatKeySpec(spec) })
    return
  }
  // Adding a key the row already has would silently collapse back to one chip.
  if (!r.replacing && current.includes(spec)) {
    saveError.value = t('settings.keybindings.already-bound', { key: formatKeySpec(spec) })
    return
  }
  await applyKeys(row, next)
}

function clearRecording(): void {
  if (recording.value) recording.value.segments = []
}

// ── Import / export ───────────────────────────────────────────────────────────
const ioBusy = ref(false)
const ioMessage = ref('')
const ioRejected = ref<string[]>([])

interface FileBridge {
  saveJson?: (a: { defaultName?: string; content: string; title?: string })
    => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  openJson?: (a?: { title?: string })
    => Promise<{ ok: boolean; content?: string; canceled?: boolean; error?: string }>
}
const fileBridge = (): FileBridge | undefined =>
  (window as Window & { agentTeam?: FileBridge }).agentTeam

async function onExport(): Promise<void> {
  const api = fileBridge()
  if (!api?.saveJson) return
  ioBusy.value = true
  ioMessage.value = ''
  ioRejected.value = []
  try {
    const result = await api.saveJson({
      title: t('settings.keybindings.export'),
      defaultName: 'navide-keybindings.json',
      content: serializeUserRules(userRules.value),
    })
    if (result.canceled) return
    ioMessage.value = result.ok
      ? t('settings.keybindings.export-done', { count: userRules.value.length })
      : `${t('settings.keybindings.export-failed')} — ${result.error ?? ''}`
  } finally {
    ioBusy.value = false
  }
}

async function onImport(): Promise<void> {
  const api = fileBridge()
  if (!api?.openJson) return
  ioBusy.value = true
  ioMessage.value = ''
  ioRejected.value = []
  try {
    const result = await api.openJson({ title: t('settings.keybindings.import') })
    if (result.canceled) return
    if (!result.ok || typeof result.content !== 'string') {
      ioMessage.value = `${t('settings.keybindings.import-failed')} — ${result.error ?? ''}`
      return
    }
    // Replaces the current set, so the file has to be reviewed first: anything
    // rejected is listed rather than quietly discarded.
    const review = reviewImportedRules(result.content)
    ioRejected.value = review.rejected
    if (!review.rules.length && review.rejected.length) {
      ioMessage.value = t('settings.keybindings.import-failed')
      return
    }
    // Importing replaces rather than merges, and there is no undo, so confirm
    // before discarding work. An empty-but-valid file is the sharpest edge: it
    // parses cleanly and would silently wipe every customisation.
    if (customizedCount.value > 0 && !window.confirm(
      t('settings.keybindings.import-confirm', {
        incoming: review.rules.length,
        current: customizedCount.value,
      }),
    )) return
    await commit(review.rules)
    ioMessage.value = t('settings.keybindings.import-done', {
      count: review.rules.length,
      rejected: review.rejected.length,
    })
  } finally {
    ioBusy.value = false
  }
}

// ── Read-only reference (keys the rule table does not own) ────────────────────
const referenceSections: { key: string; rows: ExternalKeyRow[] }[] = [
  { key: 'terminal', rows: TERMINAL_KEYS },
  { key: 'native', rows: NATIVE_MENU_KEYS },
]

// The reference honours the search box too, so looking up "⌘R" finds it here
// rather than appearing to be missing from the app entirely.
const visibleReference = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (filterMode.value !== 'all') return []
  if (!q) return referenceSections
  return referenceSections
    .map((section) => ({
      key: section.key,
      rows: section.rows.filter((row) => {
        const desc = t(`settings.keybindings.reference.desc.${row.desc}`)
        return `${row.keys} ${desc}`.toLowerCase().includes(q)
      }),
    }))
    .filter((section) => section.rows.length > 0)
})
</script>

<template>
  <div class="kse">
    <p class="kse-intro">{{ $t('settings.keybindings.intro') }}</p>

    <div class="kse-toolbar">
      <input
        v-model="query"
        class="kse-search"
        type="search"
        :placeholder="$t('settings.keybindings.search-placeholder')"
      />
      <div class="kse-filters">
        <button
          v-for="mode in (['all', 'customized', 'conflicts'] as FilterMode[])"
          :key="mode"
          type="button"
          class="kse-filter"
          :class="{ active: filterMode === mode }"
          @click="filterMode = mode"
        >{{ $t('settings.keybindings.filter.' + mode) }}</button>
      </div>
      <button
        type="button"
        class="kse-reset-all"
        :disabled="!customizedCount"
        @click="onResetAll()"
      >{{ $t('settings.keybindings.reset-all') }}</button>
      <button type="button" class="kse-filter" :disabled="ioBusy" @click="onExport()">
        {{ $t('settings.keybindings.export') }}
      </button>
      <button type="button" class="kse-filter" :disabled="ioBusy" @click="onImport()">
        {{ $t('settings.keybindings.import') }}
      </button>
    </div>

    <p v-if="customizedCount" class="kse-status">
      {{ $t('settings.keybindings.customized-count', { count: customizedCount }) }}
    </p>
    <p v-if="ioMessage" class="kse-status">{{ ioMessage }}</p>
    <div v-if="ioRejected.length" class="kse-rejected">
      <p>{{ $t('settings.keybindings.import-rejected', { count: ioRejected.length }) }}</p>
      <ul><li v-for="(r, i) in ioRejected" :key="i">{{ r }}</li></ul>
    </div>
    <p v-if="saveError" class="kse-error">
      {{ $t('settings.keybindings.save-failed') }} — {{ saveError }}
    </p>

    <div v-for="group in groupedRows" :key="group.category" class="kse-group">
      <h3 class="kse-group-title">{{ group.category }}</h3>
      <div class="kse-table-scroll">
        <table class="kse-table">
          <thead>
            <tr>
              <th>{{ $t('settings.keybindings.col.command') }}</th>
              <th class="kse-th-keys">{{ $t('settings.keybindings.col.keys') }}</th>
              <th class="kse-th-when">{{ $t('settings.keybindings.col.when') }}</th>
              <th class="kse-th-source">{{ $t('settings.keybindings.col.source') }}</th>
              <th class="kse-th-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in group.rows" :key="row.id" :class="{ customized: row.customized }">
              <td class="kse-td-command">
                <span class="kse-label">{{ labelFor(row) }}</span>
                <span class="kse-id">{{ row.command }}</span>
              </td>

              <td class="kse-td-keys">
                <div class="kse-chips">
                  <!-- The cap being re-recorded is replaced by the recorder,
                       which is rendered once per row at the end of the chips. -->
                  <template v-for="chip in row.keys" :key="chip.key">
                    <span
                      v-if="!isRecording(row, chip.key)"
                      class="kse-chip"
                      :class="{ user: chip.source === 'user' }"
                    >
                      <button
                        type="button"
                        class="kse-chip-keys"
                        :title="$t('settings.keybindings.click-to-rebind')"
                        @click="startRecording(row, chip.key)"
                      >
                        <template v-for="(seg, si) in keySpecToTokens(chip.key)" :key="si">
                          <span v-if="si" class="kse-chord-sep">→</span>
                          <kbd v-for="(tok, ti) in seg" :key="ti">{{ tok }}</kbd>
                        </template>
                      </button>
                      <button
                        v-if="!(row.protected && row.keys.length === 1)"
                        type="button"
                        class="kse-chip-remove"
                        :title="$t('settings.keybindings.remove-binding')"
                        @click="onRemoveKey(row, chip.key)"
                      >✕</button>
                      <span
                        v-else
                        class="kse-locked"
                        :title="$t('settings.keybindings.protected-hint')"
                      >🔒</span>
                      <span
                        v-if="MENU_OWNED_SPECS.has(chip.key)"
                        class="kse-menu-owned"
                        :title="$t('settings.keybindings.menu-owned-hint')"
                      >⚠</span>
                    </span>
                  </template>

                  <span v-if="isRecordingRow(row)" class="kse-recorder">
                    <span class="kse-recorder-preview">
                      <template v-if="recordedSpec">
                        <template v-for="(seg, si) in keySpecToTokens(recordedSpec)" :key="si">
                          <span v-if="si" class="kse-chord-sep">→</span>
                          <kbd v-for="(tok, ti) in seg" :key="ti">{{ tok }}</kbd>
                        </template>
                      </template>
                      <em v-else>{{ $t('settings.keybindings.press-keys') }}</em>
                    </span>
                    <button type="button" class="kse-mini" :disabled="!recordedSpec" @click="confirmRecording(row)">✓</button>
                    <button type="button" class="kse-mini" @click="clearRecording()">↺</button>
                    <button type="button" class="kse-mini" @click="stopRecording()">✕</button>
                  </span>
                  <button
                    v-else
                    type="button"
                    class="kse-add"
                    :title="$t('settings.keybindings.add-binding')"
                    @click="startRecording(row, null)"
                  >+</button>

                  <span v-if="!row.keys.length && !isRecordingRow(row)" class="kse-unbound">
                    {{ $t('settings.keybindings.unbound') }}
                  </span>

                  <span
                    v-if="conflicts.has(row.id)"
                    class="kse-conflict"
                    :class="{ hard: hardConflict(row) }"
                    :title="conflictTitle(row)"
                  >{{ hardConflict(row)
                    ? $t('settings.keybindings.conflict-hard')
                    : $t('settings.keybindings.conflict-soft') }}</span>
                </div>
              </td>

              <td class="kse-td-when">
                <code v-if="row.when">{{ row.when }}</code>
                <span v-else class="kse-when-any">{{ $t('settings.keybindings.when-any') }}</span>
              </td>

              <td class="kse-td-source">
                <span class="kse-source" :class="classifyRow(row)">
                  {{ $t('settings.keybindings.source.' + classifyRow(row)) }}
                </span>
              </td>

              <td class="kse-td-actions">
                <button
                  v-if="row.customized"
                  type="button"
                  class="kse-mini"
                  :title="$t('settings.keybindings.reset-row')"
                  @click="onReset(row)"
                >↺</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="!groupedRows.length && !visibleReference.length" class="kse-empty">
      {{ $t('settings.keybindings.no-results') }}
    </p>

    <!-- Keys the rule table does not own: listed, never editable. -->
    <div v-if="visibleReference.length" class="kse-reference">
      <p class="kse-reference-intro">{{ $t('settings.keybindings.reference.intro') }}</p>
      <section v-for="section in visibleReference" :key="section.key" class="kse-group">
        <h3 class="kse-group-title">
          {{ $t('settings.keybindings.reference.' + section.key + '.title') }}
          <span class="kse-readonly">{{ $t('settings.keybindings.reference.readonly') }}</span>
        </h3>
        <p class="kse-group-note">{{ $t('settings.keybindings.reference.' + section.key + '.note') }}</p>
        <div class="kse-table-scroll">
          <table class="kse-table">
            <tbody>
              <tr v-for="row in section.rows" :key="row.keys">
                <td class="kse-td-keys">
                  <span class="kse-chips">
                    <template v-for="(p, i) in splitKeyTokens(row.keys)" :key="i">
                      <span v-if="p.type === 'sep'" class="kse-chord-sep">{{ p.value }}</span>
                      <template v-else>
                        <span v-if="p.plus" class="kse-chord-sep">+</span><kbd>{{ p.value }}</kbd>
                      </template>
                    </template>
                  </span>
                </td>
                <td class="kse-td-desc">
                  {{ $t('settings.keybindings.reference.desc.' + row.desc) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <p class="kse-footnote">{{ $t('settings.keybindings.footnote') }}</p>
  </div>
</template>

<style scoped>
.kse {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.kse-intro,
.kse-footnote {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 74ch;
  line-height: 1.55;
}
.kse-footnote {
  font-size: 12px;
  border-top: 1px solid var(--border-muted);
  padding-top: 12px;
}

/* ── toolbar ── */
.kse-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 4px 0;
  background: var(--bg-default, var(--bg-subtle));
}
.kse-search {
  flex: 1 1 220px;
  min-width: 180px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}
.kse-search:focus {
  outline: none;
  border-color: var(--accent-fg);
}
.kse-filters {
  display: flex;
  gap: 4px;
}
.kse-filter,
.kse-reset-all {
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  cursor: pointer;
}
.kse-filter.active {
  color: var(--accent-fg);
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.kse-reset-all:disabled {
  opacity: 0.45;
  cursor: default;
}

.kse-status {
  margin: 0;
  font-size: 12px;
  color: var(--accent-fg);
}
.kse-rejected {
  border: 1px solid var(--danger-fg, #f85149);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
.kse-rejected p {
  margin: 0 0 4px;
  color: var(--danger-fg, #f85149);
  font-weight: 600;
}
.kse-rejected ul {
  margin: 0;
  padding-left: 1.2em;
  font-family: monospace;
  font-size: 11px;
}

.kse-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger-fg, #f85149);
}

/* ── groups & table ── */
.kse-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kse-group-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.kse-table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.kse-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.kse-table th {
  text-align: left;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  white-space: nowrap;
}
.kse-table td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-muted);
  vertical-align: top;
}
.kse-table tr:last-child td {
  border-bottom: none;
}
.kse-table tr.customized td:first-child {
  box-shadow: inset 2px 0 0 var(--accent-fg);
}
.kse-th-when {
  width: 20%;
}
.kse-th-source,
.kse-th-actions {
  width: 1%;
}

/* ── source badge ── */
.kse-source {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid var(--border-muted);
  color: var(--text-muted);
}
.kse-source.modified {
  color: var(--attention-fg, #d29922);
  border-color: var(--attention-fg, #d29922);
}
.kse-source.custom {
  color: var(--accent-fg);
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.kse-source.unbound {
  color: var(--danger-fg, #f85149);
  border-color: var(--danger-fg, #f85149);
}

.kse-td-command {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 190px;
}
.kse-label {
  color: var(--text-primary);
}
.kse-id {
  font-family: monospace;
  font-size: 10.5px;
  color: var(--text-muted);
}

.kse-td-when code {
  font-family: monospace;
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-word;
}
.kse-when-any {
  font-size: 11px;
  color: var(--text-muted);
}

/* ── key chips ── */
.kse-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.kse-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--bg-inset);
}
.kse-chip.user {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.kse-chip-keys {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 2px 6px;
  background: none;
  border: none;
  cursor: pointer;
}
.kse-chip-remove,
.kse-add,
.kse-mini {
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
}
.kse-add {
  border: 1px dashed var(--border-default);
  border-radius: 6px;
}
.kse-chip-remove:hover,
.kse-add:hover,
.kse-mini:hover {
  color: var(--text-bright);
}
.kse-mini:disabled {
  opacity: 0.35;
  cursor: default;
}

.kse-chips kbd,
.kse-recorder kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 11.5px;
  font-weight: 600;
  font-family: monospace;
  line-height: 1.4;
  white-space: nowrap;
}
.kse-chord-sep {
  color: var(--text-muted);
  font-size: 11px;
  padding: 0 2px;
}

.kse-recorder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 1px solid var(--accent-fg);
  border-radius: 6px;
  background: var(--accent-subtle);
}
.kse-recorder-preview {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  min-width: 96px;
}
.kse-recorder-preview em {
  font-style: normal;
  font-size: 11px;
  color: var(--accent-fg);
}

.kse-locked {
  padding: 2px 6px;
  font-size: 10px;
  cursor: help;
  opacity: 0.7;
}

/* Sits next to the cap, not in place of the remove button: the binding is still
   editable, it just cannot be cleared by unbinding it here. */
.kse-menu-owned {
  padding: 2px 4px;
  font-size: 10px;
  cursor: help;
  color: var(--warn, #d29922);
}

.kse-unbound {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.kse-conflict {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  cursor: help;
}
.kse-conflict.hard {
  color: var(--danger-fg, #f85149);
  border-color: var(--danger-fg, #f85149);
}

.kse-empty {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
