<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { AGENT_SPECS } from '../lib/agentSpecs'
import {
  highlightSegments,
  parseAnsiSegments,
  stripAnsi,
  tailLines,
  type HighlightedPiece,
} from '../lib/ansiRender'
import {
  countHistoryCleanupEntries,
  filterHistoryEntries,
  groupHistoryByDay,
  historyCleanupCutoffIso,
  historyEntryLabel,
  type HistoryCleanupMode,
  type HistoryDayGroupKey,
  type HistoryDeletePreview,
  type HistoryDeleteTarget,
  type HistoryOriginFilter,
  type HistoryStatusFilter,
  type SpawnHistoryEntry,
} from '../lib/spawnHistory'

// Agent History modal, extracted from App.vue. Owns only presentation-local
// state (search query, filters, selection, kill-all confirmation). Flows that
// are coupled to App.vue (resume via onManualResume, kill-all, log-preview
// open state fed into the keybinding modalOpen context) stay in App.vue and
// are wired through props + emits.
const props = defineProps<{
  show: boolean
  sessionHistory: SpawnHistoryEntry[]
  paneCount: number
  revivingPaneId: string
  unavailablePaneIds: Set<string>
  previewOpen: boolean
  previewTitle: string
  previewContent: string
  historyHasMore?: boolean
  loadMoreHistory?: () => Promise<void>
  fetchHistoryLog?: (entry: SpawnHistoryEntry) => Promise<{ title: string; content: string } | null>
  searchHistoryLogContent?: (entries: SpawnHistoryEntry[], query: string) => Promise<Set<string>>
  previewDelete?: (target: HistoryDeleteTarget) => Promise<HistoryDeletePreview | null>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'kill-all'): void
  (e: 'resume', entry: SpawnHistoryEntry): void
  (e: 'preview', entry: SpawnHistoryEntry): void
  (e: 'close-preview'): void
  (e: 'rename', entry: SpawnHistoryEntry, name: string): void
  (e: 'delete', entry: SpawnHistoryEntry): void
  (e: 'cleanup', mode: HistoryCleanupMode, cutoffIso: string): void
  (e: 'toggle-star', entry: SpawnHistoryEntry, starred: boolean): void
}>()

const agentSpecs = AGENT_SPECS

const searchQuery = ref('')
// Log-content search (debounced): paneIds whose conversation log matched the
// current query, union'd into filteredSessionHistory alongside metadata
// matches. contentSearchSeq guards against a stale response from a query
// that's since changed (see runContentSearch).
const contentMatchedIds = ref<Set<string>>(new Set())
const contentSearchLoading = ref(false)
let contentSearchSeq = 0
let contentSearchDebounceTimer: number | undefined
const statusFilter = ref<HistoryStatusFilter>('all')
const originFilter = ref<HistoryOriginFilter>('all')
const starredOnly = ref(false)
const selectedPaneId = ref('')
const confirmKillAll = ref(false)
const loadingMore = ref(false)

// Phase E per-entry actions: inline rename, copy session id, single delete,
// and the bulk cleanup dropdown. All presentation-local; the persistence
// flows live in App.vue behind the rename/delete/cleanup emits.
const renameEditing = ref(false)
const renameDraft = ref('')
const sessionIdCopied = ref(false)
let copiedTimer: number | undefined
const confirmDelete = ref(false)
const cleanupMenuOpen = ref(false)
// Snapshotted when the menu opens so the displayed counts and the emitted
// cutoff agree exactly.
const cleanupCutoffIso = ref('')
const confirmCleanup = ref<{ mode: HistoryCleanupMode; count: number } | null>(null)
// Dry-run figures behind both confirmations: deleting a record also unlinks
// its CLI transcript log, so the user is told how many files and how much
// disk space go with it. null = the probe failed or is unavailable; the
// dialog then confirms without the figures rather than blocking the delete.
const deletePreview = ref<HistoryDeletePreview | null>(null)
const deletePreviewPending = ref(false)

// Autofocus + select the inline rename input the moment it mounts (same
// pattern as App.vue's pane-header inline rename).
const vFocus = {
  mounted(el: HTMLInputElement): void {
    el.focus()
    el.select()
  },
}

watch(() => props.show, (open) => {
  if (!open) {
    searchQuery.value = ''
    statusFilter.value = 'all'
    originFilter.value = 'all'
    starredOnly.value = false
    selectedPaneId.value = ''
    confirmDelete.value = false
    cleanupMenuOpen.value = false
    confirmCleanup.value = null
    deletePreview.value = null
    if (contentSearchDebounceTimer !== undefined) { window.clearTimeout(contentSearchDebounceTimer); contentSearchDebounceTimer = undefined }
    contentSearchSeq++
    contentMatchedIds.value = new Set()
    contentSearchLoading.value = false
  }
})

// Debounce the content search ~300ms after typing settles; an empty query
// (or no search API) cancels/skips it outright. contentSearchSeq is bumped on
// every query change so a slow search for an outdated query can never
// clobber the current results (stale-response guard). status/origin filter
// changes also re-trigger the search because only entries passing those
// gates are scanned (see runContentSearch) — broadening a filter must scan
// the newly eligible entries.
watch([searchQuery, statusFilter, originFilter, starredOnly], ([query]) => {
  if (contentSearchDebounceTimer !== undefined) { window.clearTimeout(contentSearchDebounceTimer); contentSearchDebounceTimer = undefined }
  contentSearchSeq++
  const trimmed = query.trim()
  if (!trimmed || !props.searchHistoryLogContent) {
    contentMatchedIds.value = new Set()
    contentSearchLoading.value = false
    return
  }
  const seq = contentSearchSeq
  contentSearchDebounceTimer = window.setTimeout(() => { void runContentSearch(trimmed, seq) }, 300)
})

async function runContentSearch(query: string, seq: number): Promise<void> {
  contentSearchLoading.value = true
  // Scan only entries the status/origin/starred gates would display —
  // filterHistoryEntries drops the rest regardless of a content match, so
  // scanning them would be wasted file reads.
  const candidates = filterHistoryEntries(props.sessionHistory, {
    query: '',
    status: statusFilter.value,
    origin: originFilter.value,
    starredOnly: starredOnly.value,
  })
  const result = await props.searchHistoryLogContent!(candidates, query).catch(() => new Set<string>())
  if (seq !== contentSearchSeq) return // stale: query/filters changed since this search was scheduled
  contentSearchLoading.value = false
  contentMatchedIds.value = result
}

// Selection changed → any in-progress entry action belongs to the old entry.
watch(selectedPaneId, () => {
  renameEditing.value = false
  sessionIdCopied.value = false
  confirmDelete.value = false
})

const filteredSessionHistory = computed(() =>
  filterHistoryEntries(props.sessionHistory, {
    query: searchQuery.value,
    status: statusFilter.value,
    origin: originFilter.value,
    starredOnly: starredOnly.value,
    contentMatchedIds: contentMatchedIds.value,
  })
)

const groupedHistory = computed(() => groupHistoryByDay(filteredSessionHistory.value, new Date()))

const selectedEntry = computed(() =>
  filteredSessionHistory.value.find((entry) => entry.paneId === selectedPaneId.value) ?? null
)

// Default-select the first (newest) entry when the modal opens, and re-select
// the first entry whenever filtering drops the current selection.
watch([() => props.show, filteredSessionHistory], ([open, entries]) => {
  if (!open) return
  if (!entries.some((entry) => entry.paneId === selectedPaneId.value)) {
    selectedPaneId.value = entries[0]?.paneId ?? ''
  }
}, { immediate: true })

function agentLabelFor(entry: SpawnHistoryEntry): string {
  if (!entry.agentKey) return ''
  return agentSpecs.find((s) => s.agentKey === entry.agentKey)?.label ?? entry.agentKey
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function listTime(entry: SpawnHistoryEntry, groupKey: HistoryDayGroupKey): string {
  if (!entry.spawnedAt) return '—'
  const d = new Date(entry.spawnedAt)
  if (Number.isNaN(d.getTime())) return '—'
  return groupKey === 'earlier' ? d.toLocaleDateString() : d.toLocaleTimeString()
}

async function onLoadMore(): Promise<void> {
  if (loadingMore.value || !props.loadMoreHistory) return
  loadingMore.value = true
  try {
    await props.loadMoreHistory()
  } finally {
    loadingMore.value = false
  }
}

function startRename(): void {
  if (!selectedEntry.value) return
  renameDraft.value = historyEntryLabel(selectedEntry.value)
  renameEditing.value = true
}

function commitRename(): void {
  if (!renameEditing.value || !selectedEntry.value) return
  renameEditing.value = false
  emit('rename', selectedEntry.value, renameDraft.value)
}

function onRenameKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renameEditing.value = false }
}

async function copySessionId(sessionId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sessionId)
  } catch {
    return
  }
  sessionIdCopied.value = true
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => { sessionIdCopied.value = false }, 1500)
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** Ask the backend what this delete would cost. Never throws: a failed probe
 *  degrades to a confirmation without figures, it must not block the delete. */
async function runDeletePreview(target: HistoryDeleteTarget): Promise<HistoryDeletePreview | null> {
  if (!props.previewDelete) return null
  deletePreviewPending.value = true
  try {
    return await props.previewDelete(target)
  } catch {
    return null
  } finally {
    deletePreviewPending.value = false
  }
}

async function openDeleteConfirm(): Promise<void> {
  const entry = selectedEntry.value
  if (!entry || deletePreviewPending.value) return
  const preview = await runDeletePreview({ mode: 'ids', paneIds: [entry.paneId] })
  // Nothing left to destroy backend-side — there is nothing to warn about,
  // so skip the dialog but still let the record leave the loaded list.
  if (preview && preview.entries === 0) {
    emit('delete', entry)
    return
  }
  deletePreview.value = preview
  confirmDelete.value = true
}

function onDeleteConfirmed(): void {
  const entry = selectedEntry.value
  confirmDelete.value = false
  deletePreview.value = null
  if (entry) emit('delete', entry)
}

function toggleCleanupMenu(): void {
  cleanupMenuOpen.value = !cleanupMenuOpen.value
  if (cleanupMenuOpen.value) cleanupCutoffIso.value = historyCleanupCutoffIso(new Date())
}

// Counts over the loaded (unfiltered) entries; the backend processes the
// full store, so the real deleted count can exceed these for old entries
// that were never paged in.
const cleanupRemovedCount = computed(() =>
  countHistoryCleanupEntries(props.sessionHistory, 'removed')
)
const cleanupOlderCount = computed(() =>
  countHistoryCleanupEntries(props.sessionHistory, 'older_than', cleanupCutoffIso.value)
)

async function openCleanupConfirm(mode: HistoryCleanupMode): Promise<void> {
  cleanupMenuOpen.value = false
  if (deletePreviewPending.value) return
  const count = mode === 'removed' ? cleanupRemovedCount.value : cleanupOlderCount.value
  if (count === 0) return
  const preview = await runDeletePreview({ mode, cutoffIso: cleanupCutoffIso.value })
  if (preview && preview.entries === 0) return
  deletePreview.value = preview
  // The dry-run counted the full store, the local count only the loaded
  // window — prefer it when we have it.
  confirmCleanup.value = { mode, count: preview?.entries ?? count }
}

function onCleanupConfirmed(): void {
  const pending = confirmCleanup.value
  confirmCleanup.value = null
  deletePreview.value = null
  if (pending) emit('cleanup', pending.mode, cleanupCutoffIso.value)
}

// ── Phase F: inline log preview ──────────────────────────────────────────────
// Lazy-loaded per selection via the fetchHistoryLog prop. The pop-out
// full-log flow (previewOpen/previewTitle/previewContent + the 'preview'
// emit) stays untouched in App.vue.
const MAX_PREVIEW_LINES = 2000
const MAX_PREVIEW_CHARS = 512 * 1024

const logLoading = ref(false)
// null = no log available for this entry (or not loaded yet).
const logContent = ref<string | null>(null)
const logSearchQuery = ref('')
const activeMatchIdx = ref(0)
const logCopied = ref(false)
let logCopiedTimer: number | undefined
// Sequence guard: bump on every selection change so a slow fetch for a
// previously selected entry can never clobber the current one.
let logFetchSeq = 0
const logBodyEl = ref<HTMLElement | null>(null)

watch(selectedPaneId, () => { void loadSelectedLog() })

async function loadSelectedLog(): Promise<void> {
  const seq = ++logFetchSeq
  logContent.value = null
  logSearchQuery.value = ''
  activeMatchIdx.value = 0
  logCopied.value = false
  const entry = selectedEntry.value
  if (!entry || !props.fetchHistoryLog) {
    logLoading.value = false
    return
  }
  logLoading.value = true
  const result = await props.fetchHistoryLog(entry).catch(() => null)
  if (seq !== logFetchSeq) return // stale: selection changed while loading
  logLoading.value = false
  logContent.value = result?.content ?? null
}

// Tail-truncate before parsing so huge logs never hit the ANSI parser; the
// parse itself lives in computeds so it runs once per content/query change.
const truncatedLog = computed(() => {
  const content = logContent.value
  if (content === null) return null
  let text = content
  let truncated = false
  if (text.length > MAX_PREVIEW_CHARS) {
    text = text.slice(-MAX_PREVIEW_CHARS)
    truncated = true
  }
  const byLines = tailLines(text, MAX_PREVIEW_LINES)
  const shownLines = byLines.text.length === 0 ? 0 : byLines.text.split('\n').length
  return { text: byLines.text, truncated: truncated || byLines.truncated, shownLines }
})

const logSegments = computed(() =>
  truncatedLog.value ? parseAnsiSegments(truncatedLog.value.text) : []
)

const logHighlight = computed(() =>
  highlightSegments(logSegments.value, logSearchQuery.value.trim())
)

const logMatchCount = computed(() => logHighlight.value.matchCount)

watch(logSearchQuery, () => {
  activeMatchIdx.value = 0
  if (logMatchCount.value > 0) scrollToActiveMatch()
})

watch(logMatchCount, (count) => {
  if (activeMatchIdx.value >= count) activeMatchIdx.value = 0
})

function gotoMatch(delta: number): void {
  const count = logMatchCount.value
  if (count === 0) return
  activeMatchIdx.value = (activeMatchIdx.value + delta + count) % count
  scrollToActiveMatch()
}

function scrollToActiveMatch(): void {
  void nextTick(() => {
    logBodyEl.value
      ?.querySelector(`[data-mi="${activeMatchIdx.value}"]`)
      ?.scrollIntoView({ block: 'center' })
  })
}

function onLogSearchKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    gotoMatch(e.shiftKey ? -1 : 1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    gotoMatch(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    gotoMatch(-1)
  } else if (e.key === 'Escape') {
    // Only clear/blur here — never let Escape bubble into any modal-close
    // handling while the search field is focused.
    e.preventDefault()
    e.stopPropagation()
    if (logSearchQuery.value) logSearchQuery.value = ''
    else (e.target as HTMLInputElement).blur()
  }
}

function pieceClass(piece: HighlightedPiece): string[] {
  const cls: string[] = []
  if (piece.fg) cls.push(`ansi-fg-${piece.fg}`)
  if (piece.bg) cls.push(`ansi-bg-${piece.bg}`)
  if (piece.bold) cls.push('ansi-bold')
  if (piece.matchIndex !== undefined) {
    cls.push('ah-log-match')
    if (piece.matchIndex === activeMatchIdx.value) cls.push('ah-log-match-active')
  }
  return cls
}

async function copyLogText(): Promise<void> {
  if (logContent.value === null) return
  try {
    // Raw text minus ANSI escapes (full content, not the truncated tail).
    await navigator.clipboard.writeText(stripAnsi(logContent.value))
  } catch {
    return
  }
  logCopied.value = true
  if (logCopiedTimer !== undefined) window.clearTimeout(logCopiedTimer)
  logCopiedTimer = window.setTimeout(() => { logCopied.value = false }, 1500)
}
</script>

<template>
  <Teleport v-if="show" to="body">
    <div class="history-overlay" @click.self="emit('close')">
      <div class="history-modal">
        <div class="history-modal-header">
          <div class="history-header-left">
            <span>{{ $t('label.agent-history') }}</span>
            <button
              v-if="paneCount > 0"
              class="history-killall"
              @click="confirmKillAll = true"
              :title="$t('action.kill-all-agents')"
            >🗑 {{ $t('action.kill-all') }}</button>
            <div class="ah-cleanup-wrap">
              <button class="ah-cleanup-btn" @click="toggleCleanupMenu">🧹 {{ $t('action.cleanup') }} ▾</button>
              <template v-if="cleanupMenuOpen">
                <div class="ah-menu-backdrop" @click="cleanupMenuOpen = false"></div>
                <div class="ah-cleanup-menu">
                  <button
                    class="ah-cleanup-item"
                    :disabled="cleanupRemovedCount === 0"
                    @click="openCleanupConfirm('removed')"
                  >{{ $t('label.history-cleanup-removed') }} ({{ cleanupRemovedCount }})</button>
                  <button
                    class="ah-cleanup-item"
                    :disabled="cleanupOlderCount === 0"
                    @click="openCleanupConfirm('older_than')"
                  >{{ $t('label.history-cleanup-older') }} ({{ cleanupOlderCount }})</button>
                </div>
              </template>
            </div>
          </div>
          <button class="history-close" @click="emit('close')">✕</button>
        </div>
        <div class="history-body">
          <div class="history-list-col">
            <div class="history-filters">
              <div class="agent-history-search">
                <input
                  v-model="searchQuery"
                  class="agent-history-search-input"
                  :placeholder="$t('label.search-history')"
                />
                <button
                  v-if="searchQuery"
                  class="agent-history-search-clear"
                  @click="searchQuery = ''"
                >✕</button>
              </div>
              <div v-if="contentSearchLoading" class="agent-history-search-status">
                {{ $t('label.history-search-loading') }}
              </div>
              <div class="history-filter-row">
                <select v-model="statusFilter" class="history-filter-select">
                  <option value="all">{{ $t('label.history-filter-status-all') }}</option>
                  <option value="active">{{ $t('label.history-filter-active') }}</option>
                  <option value="removed">{{ $t('label.history-filter-removed') }}</option>
                </select>
                <select v-model="originFilter" class="history-filter-select">
                  <option value="all">{{ $t('label.history-filter-origin-all') }}</option>
                  <option value="manual">{{ $t('label.history-filter-manual') }}</option>
                  <option value="pipeline">{{ $t('label.history-filter-pipeline') }}</option>
                </select>
                <button
                  class="ah-star-filter"
                  :class="{ active: starredOnly }"
                  :title="$t('label.history-filter-starred')"
                  :aria-pressed="starredOnly"
                  @click="starredOnly = !starredOnly"
                >{{ starredOnly ? '★' : '☆' }}</button>
              </div>
            </div>
            <div class="agent-history-list">
              <div v-if="sessionHistory.length === 0" class="agent-history-empty">{{ $t('label.no-history-yet') }}</div>
              <div v-else-if="filteredSessionHistory.length === 0" class="agent-history-empty">
                {{ $t('label.no-matching-history') }}
              </div>
              <template v-for="group in groupedHistory" :key="group.key">
                <div class="ah-group-title">{{ $t(`label.history-group-${group.key}`) }}</div>
                <button
                  v-for="entry in group.entries"
                  :key="entry.paneId"
                  class="agent-history-row"
                  :class="{ selected: entry.paneId === selectedPaneId }"
                  @click="selectedPaneId = entry.paneId"
                >
                  <span class="ah-dot" :class="entry.removedAt ? 'removed' : 'active'"></span>
                  <span class="ah-badge">{{ historyEntryLabel(entry) }}</span>
                  <span class="ah-time">{{ listTime(entry, group.key) }}</span>
                  <!-- span, not button: rows are <button> and nesting
                       interactive elements is invalid HTML. -->
                  <span
                    class="ah-row-star"
                    :class="{ starred: entry.starred }"
                    role="button"
                    tabindex="0"
                    :title="entry.starred ? $t('action.unstar') : $t('action.star')"
                    @click.stop="emit('toggle-star', entry, !entry.starred)"
                    @keydown.enter.prevent.stop="emit('toggle-star', entry, !entry.starred)"
                    @keydown.space.prevent.stop="emit('toggle-star', entry, !entry.starred)"
                  >{{ entry.starred ? '★' : '☆' }}</span>
                </button>
              </template>
              <button
                v-if="historyHasMore && filteredSessionHistory.length > 0"
                class="ah-load-more"
                :disabled="loadingMore"
                @click="onLoadMore"
              >{{ loadingMore ? $t('label.loading') : $t('label.load-more') }}</button>
            </div>
          </div>
          <div class="history-detail-col">
            <div v-if="!selectedEntry" class="agent-history-empty">{{ $t('label.history-no-selection') }}</div>
            <div v-else class="history-detail">
              <div class="detail-title-row">
                <template v-if="!renameEditing">
                  <span class="ah-badge detail-name">{{ historyEntryLabel(selectedEntry) }}</span>
                  <button
                    class="ah-icon-btn"
                    :title="$t('action.rename')"
                    @click="startRename"
                  >✎</button>
                  <button
                    class="ah-icon-btn ah-star-btn"
                    :class="{ starred: selectedEntry.starred }"
                    :title="selectedEntry.starred ? $t('action.unstar') : $t('action.star')"
                    @click="emit('toggle-star', selectedEntry, !selectedEntry.starred)"
                  >{{ selectedEntry.starred ? '★' : '☆' }}</button>
                </template>
                <input
                  v-else
                  v-model="renameDraft"
                  v-focus
                  class="ah-rename-input"
                  @keydown="onRenameKeydown"
                  @blur="renameEditing = false"
                />
                <span class="ah-status" :class="selectedEntry.removedAt ? 'removed' : 'active'">
                  {{ selectedEntry.removedAt ? $t('label.history-filter-removed') : $t('label.history-filter-active') }}
                </span>
              </div>
              <div class="detail-grid">
                <template v-if="agentLabelFor(selectedEntry)">
                  <span class="detail-label">{{ $t('label.history-detail-agent') }}</span>
                  <span class="detail-value">{{ agentLabelFor(selectedEntry) }}</span>
                </template>
                <span class="detail-label">{{ $t('label.history-detail-role') }}</span>
                <span class="detail-value">{{ selectedEntry.roleLabel || '—' }}</span>
                <span class="detail-label">{{ $t('label.history-detail-origin') }}</span>
                <span class="detail-value">{{ selectedEntry.origin === 'pipeline' ? $t('label.history-filter-pipeline') : $t('label.history-filter-manual') }}</span>
                <span class="detail-label">{{ $t('label.history-detail-spawned') }}</span>
                <span class="detail-value">{{ formatTimestamp(selectedEntry.spawnedAt) }}</span>
                <template v-if="selectedEntry.removedAt">
                  <span class="detail-label">{{ $t('label.history-detail-removed') }}</span>
                  <span class="detail-value">{{ formatTimestamp(selectedEntry.removedAt) }}</span>
                </template>
                <template v-if="selectedEntry.sessionId">
                  <span class="detail-label">{{ $t('label.history-detail-session') }}</span>
                  <span class="detail-value detail-session">
                    {{ selectedEntry.sessionId }}
                    <button
                      class="ah-icon-btn"
                      :title="$t('action.copy')"
                      @click="copySessionId(selectedEntry.sessionId)"
                    >{{ sessionIdCopied ? '✓' : '⧉' }}</button>
                    <span v-if="sessionIdCopied" class="ah-copied">{{ $t('label.copied') }}</span>
                  </span>
                </template>
                <span class="detail-label">{{ $t('label.history-detail-workspace') }}</span>
                <span class="detail-value detail-path">{{ selectedEntry.workspacePath || '—' }}</span>
                <template v-if="selectedEntry.restoreMode">
                  <span class="detail-label">{{ $t('label.history-detail-restore') }}</span>
                  <span class="detail-value">
                    <span
                      v-if="selectedEntry.restoreMode === 'memory-resume'"
                      class="ah-restore-badge ah-resume"
                      :title="$t('label.history-memory-resume-title')"
                    >{{ $t('label.history-memory-resume') }}</span>
                    <span v-else class="ah-restore-badge ah-fresh">{{ $t('label.history-restore-fresh') }}</span>
                  </span>
                </template>
              </div>
              <div v-if="selectedEntry.removedAt" class="agent-history-actions">
                <span
                  v-if="unavailablePaneIds.has(selectedEntry.paneId)"
                  class="ah-session-unavailable"
                >{{ $t('label.history-session-unavailable') }}</span>
                <button
                  v-if="selectedEntry.sessionId && !unavailablePaneIds.has(selectedEntry.paneId)"
                  class="ah-revive"
                  :disabled="!!revivingPaneId"
                  @click="emit('resume', selectedEntry)"
                >{{ revivingPaneId === selectedEntry.paneId ? '…' : $t('action.resume-session') }}</button>
                <button
                  class="ah-revive ah-preview"
                  @click="emit('preview', selectedEntry)"
                >{{ $t('action.open-full-log') }}</button>
                <!-- Deletes the record *and* its CLI transcript log; active
                     entries never show it (their pane keeps running, so
                     deleting the record is ambiguous). -->
                <button
                  class="ah-revive ah-delete"
                  :disabled="deletePreviewPending"
                  @click="openDeleteConfirm"
                >{{ $t('action.delete') }}</button>
              </div>
              <!-- Phase F: inline log preview (independent scroll region) -->
              <div class="ah-log-preview">
                <div class="ah-log-toolbar">
                  <div class="ah-log-search">
                    <input
                      v-model="logSearchQuery"
                      class="ah-log-search-input"
                      :placeholder="$t('label.log-search-placeholder')"
                      :disabled="logContent === null"
                      @keydown="onLogSearchKeydown"
                    />
                    <span v-if="logSearchQuery" class="ah-log-search-count">
                      {{ $t('label.log-search-count', { current: logMatchCount === 0 ? 0 : activeMatchIdx + 1, total: logMatchCount }) }}
                    </span>
                    <button
                      class="ah-icon-btn"
                      :disabled="logMatchCount === 0"
                      :title="$t('action.prev-match')"
                      @click="gotoMatch(-1)"
                    >↑</button>
                    <button
                      class="ah-icon-btn"
                      :disabled="logMatchCount === 0"
                      :title="$t('action.next-match')"
                      @click="gotoMatch(1)"
                    >↓</button>
                  </div>
                  <button
                    class="ah-icon-btn ah-log-copy"
                    :disabled="logContent === null"
                    @click="copyLogText"
                  >{{ logCopied ? $t('label.copied') : $t('action.copy-log') }}</button>
                </div>
                <div v-if="truncatedLog?.truncated" class="ah-log-truncated">
                  {{ $t('label.log-truncated', { lines: truncatedLog.shownLines }) }}
                </div>
                <div ref="logBodyEl" class="ah-log-body">
                  <div v-if="logLoading" class="ah-log-empty">{{ $t('label.loading') }}</div>
                  <div v-else-if="logContent === null" class="ah-log-empty">{{ $t('label.history-log-none') }}</div>
                  <!-- Rendered as v-for spans (Vue interpolation escapes text);
                       never v-html. Keep the <pre> content on one line so no
                       stray whitespace is introduced. -->
                  <pre v-else class="ah-log-pre"><span v-for="(piece, i) in logHighlight.pieces" :key="i" :class="pieceClass(piece)" :data-mi="piece.matchIndex">{{ piece.text }}</span></pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
  <Teleport v-if="confirmKillAll" to="body">
    <div class="history-overlay" @click.self="confirmKillAll = false">
      <div class="history-modal" style="height: auto; max-width: 400px;">
        <div class="history-modal-header">
          <span>🗑 Kill all agents?</span>
          <button class="history-close" @click="confirmKillAll = false">✕</button>
        </div>
        <div style="padding: 16px 14px; font-size: 13px; color: var(--text-primary);">
          {{ $t('label.kill-all-confirm-prefix') }}<strong>{{ $t('label.kill-all-confirm-count', { count: paneCount }) }}</strong>{{ $t('label.kill-all-confirm-suffix') }}
        </div>
        <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
          <button class="history-close" style="border: 1px solid var(--border-default); padding: 4px 12px; border-radius: 6px;" @click="confirmKillAll = false">{{ $t('action.cancel') }}</button>
          <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="() => { emit('kill-all'); confirmKillAll = false }">{{ $t('action.kill-all') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
  <Teleport v-if="confirmDelete && selectedEntry" to="body">
    <div class="history-overlay" @click.self="confirmDelete = false">
      <div class="history-modal" style="height: auto; max-width: 400px;">
        <div class="history-modal-header">
          <span>{{ $t('action.delete') }}</span>
          <button class="history-close" @click="confirmDelete = false">✕</button>
        </div>
        <div style="padding: 16px 14px; font-size: 13px; color: var(--text-primary);">
          {{ $t('label.history-delete-confirm', { name: historyEntryLabel(selectedEntry) }) }}
          <div
            v-if="deletePreview && deletePreview.logFiles > 0"
            class="ah-delete-logs"
            data-testid="history-delete-logs"
          >
            {{ $t('label.history-delete-logs', { files: deletePreview.logFiles, size: formatBytes(deletePreview.freedBytes) }) }}
          </div>
        </div>
        <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
          <button class="history-close" style="border: 1px solid var(--border-default); padding: 4px 12px; border-radius: 6px;" @click="confirmDelete = false">{{ $t('action.cancel') }}</button>
          <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="onDeleteConfirmed">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
  <Teleport v-if="confirmCleanup" to="body">
    <div class="history-overlay" @click.self="confirmCleanup = null">
      <div class="history-modal" style="height: auto; max-width: 400px;">
        <div class="history-modal-header">
          <span>🧹 {{ $t('action.cleanup') }}</span>
          <button class="history-close" @click="confirmCleanup = null">✕</button>
        </div>
        <div style="padding: 16px 14px; font-size: 13px; color: var(--text-primary);">
          {{ $t('label.history-cleanup-confirm-count', { count: confirmCleanup.count }) }}
          <div
            v-if="deletePreview && deletePreview.logFiles > 0"
            class="ah-delete-logs"
            data-testid="history-cleanup-logs"
          >
            {{ $t('label.history-delete-logs', { files: deletePreview.logFiles, size: formatBytes(deletePreview.freedBytes) }) }}
          </div>
          <div style="margin-top: 6px; font-size: 12px; color: var(--text-secondary);">
            {{ $t('label.history-cleanup-starred-kept') }}
          </div>
        </div>
        <div style="display: flex; gap: 8px; padding: 0 14px 14px; justify-content: flex-end;">
          <button class="history-close" style="border: 1px solid var(--border-default); padding: 4px 12px; border-radius: 6px;" @click="confirmCleanup = null">{{ $t('action.cancel') }}</button>
          <button class="danger" style="padding: 4px 14px; border-radius: 6px; font-size: 12px;" @click="onCleanupConfirmed">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Log Preview Modal -->
  <div v-if="previewOpen" class="log-preview-overlay" @click.self="emit('close-preview')">
    <div class="log-preview-modal">
      <div class="log-preview-header">
        <h3>{{ previewTitle }}</h3>
        <button class="log-preview-close" @click="emit('close-preview')">✕</button>
      </div>
      <div class="log-preview-body">
        <pre>{{ previewContent }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  -webkit-app-region: no-drag;
}
.history-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: min(880px, 92vw);
  height: 72vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 48px var(--shadow-overlay);
  animation: ah-modal-in 0.14s ease-out;
}
@keyframes ah-modal-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: none; }
}
/* Shared focus ring for keyboard navigation across all modal controls. */
.agent-history-row:focus-visible,
.ah-icon-btn:focus-visible,
.ah-revive:focus-visible,
.ah-load-more:focus-visible,
.ah-cleanup-btn:focus-visible,
.ah-cleanup-item:focus-visible,
.history-killall:focus-visible,
.history-close:focus-visible,
.agent-history-search-clear:focus-visible,
.ah-star-filter:focus-visible,
.ah-row-star:focus-visible {
  outline: 1px solid var(--accent-focus);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .history-modal,
  .ah-cleanup-menu {
    animation: none;
  }
}
.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-muted);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
}
.history-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.history-killall {
  background: transparent;
  border: 1px solid var(--danger-muted);
  color: var(--danger-fg);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
  transition: background-color 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}
.history-killall:hover {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
  opacity: 1;
}
.history-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.history-list-col {
  width: 320px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.history-filters {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.history-filter-row {
  display: flex;
  gap: 6px;
}
.history-filter-select {
  flex: 1;
  min-width: 0;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 2px 4px;
  outline: none;
}
.history-filter-select:focus {
  border-color: var(--accent-focus);
}
.agent-history-search {
  position: relative;
  display: flex;
  align-items: center;
}
.agent-history-search-input {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 400;
  padding: 3px 20px 3px 8px;
  width: 100%;
  outline: none;
}
.agent-history-search-input:focus {
  border-color: var(--accent-focus);
}
.agent-history-search-clear {
  position: absolute;
  right: 2px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  padding: 1px 4px;
  transition: color 0.12s ease;
}
.agent-history-search-clear:hover {
  color: var(--text-bright);
}
.agent-history-search-status {
  font-size: 10px;
  color: var(--text-secondary);
  padding: 0 2px;
}
.history-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.history-close:hover {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.agent-history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0 8px;
}
.agent-history-empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.ah-group-title {
  position: sticky;
  top: 0;
  background: var(--bg-base);
  padding: 6px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--text-muted);
}
.agent-history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  transition: background-color 0.12s ease;
}
.agent-history-row:hover {
  background: var(--bg-subtle);
}
.agent-history-row.selected {
  background: var(--bg-selected);
  box-shadow: inset 2px 0 0 var(--accent-fg);
}
.ah-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ah-dot.active {
  background: var(--success-fg);
  box-shadow: 0 0 0 2px var(--success-subtle);
}
.ah-dot.removed { background: var(--text-muted); }
.ah-badge {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-history-row .ah-badge {
  flex: 1;
  min-width: 0;
}
.ah-time {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}
.ah-row-star {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
  opacity: 0;
  padding: 0 2px;
  border-radius: 3px;
  transition: color 0.12s ease, opacity 0.12s ease;
}
.agent-history-row:hover .ah-row-star,
.agent-history-row.selected .ah-row-star,
.ah-row-star:focus-visible {
  opacity: 0.7;
}
.ah-row-star.starred {
  color: var(--warning-fg);
  opacity: 1;
}
.ah-row-star:hover {
  color: var(--warning-fg);
  opacity: 1;
}
.ah-star-filter {
  flex-shrink: 0;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 6px;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.ah-star-filter:hover {
  color: var(--text-bright);
}
.ah-star-filter.active {
  color: var(--warning-fg);
  border-color: var(--warning-fg);
}
.ah-star-btn.starred {
  color: var(--warning-fg);
}
.ah-load-more {
  display: block;
  margin: 8px auto 4px;
  padding: 3px 14px;
  font-size: 11px;
  border-radius: 20px;
  border: 1px solid var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.ah-load-more:hover:not(:disabled) {
  color: var(--text-bright);
  border-color: var(--accent-muted);
}
.ah-load-more:disabled {
  cursor: wait;
  opacity: 0.55;
}
.history-detail-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.history-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  flex: 1;
  min-height: 0;
}
.detail-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-name {
  font-size: 13px;
  padding: 2px 8px;
}
/* Status pill mirrors the list's ah-dot colors so both columns read the
   same state language (dot before the label via ::before). */
.ah-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
  letter-spacing: 0.2px;
  margin-left: auto;
  flex-shrink: 0;
}
.ah-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.ah-status.active {
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid var(--success-muted);
}
.ah-status.removed {
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
}
.detail-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  font-size: 12px;
  align-items: baseline;
}
.detail-label {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.detail-value {
  color: var(--text-primary);
  min-width: 0;
}
.detail-session {
  font-family: monospace;
  font-size: 11px;
  word-break: break-all;
}
.detail-path {
  word-break: break-all;
}
.ah-restore-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  letter-spacing: 0.2px;
}
.ah-restore-badge.ah-resume {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  border: 1px solid var(--accent-muted);
}
.ah-restore-badge.ah-fresh {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}
.agent-history-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.ah-session-unavailable {
  width: 100%;
  color: var(--warning-fg);
  font-size: 11px;
}
.ah-revive {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 20px;
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-bright);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.ah-revive:hover {
  background: var(--bg-selected);
  border-color: var(--accent-bright);
  color: var(--accent-bright);
}
.ah-revive.ah-preview {
  border-color: var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.ah-revive:disabled {
  cursor: wait;
  opacity: 0.55;
}
.ah-revive.ah-delete {
  border-color: var(--danger-muted);
  background: transparent;
  color: var(--danger-fg);
}
.ah-revive.ah-delete:hover {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
}
.ah-delete-logs {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger-fg);
}
.ah-icon-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.ah-icon-btn:hover {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.ah-rename-input {
  background: var(--bg-muted);
  border: 1px solid var(--accent-muted);
  border-radius: 4px;
  color: var(--text-bright);
  font-size: 13px;
  padding: 2px 8px;
  min-width: 0;
  flex: 1;
  outline: none;
}
.ah-copied {
  color: var(--success-fg);
  font-size: 10px;
  font-weight: 600;
}
.ah-cleanup-wrap {
  position: relative;
}
.ah-cleanup-btn {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.ah-cleanup-btn:hover {
  color: var(--text-bright);
  border-color: var(--accent-muted);
}
.ah-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1;
}
.ah-cleanup-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 24px var(--shadow-overlay);
  padding: 4px;
  animation: ah-modal-in 0.12s ease-out;
}
.ah-cleanup-item {
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 400;
  text-align: left;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.ah-cleanup-item:hover:not(:disabled) {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ah-cleanup-item:disabled {
  color: var(--text-muted);
  cursor: default;
}

/* Phase F: inline log preview */
.ah-log-preview {
  flex: 1;
  min-height: 140px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border-muted);
  padding-top: 10px;
}
.ah-log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ah-log-search {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.ah-log-search-input {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 2px 8px;
  width: 160px;
  min-width: 0;
  outline: none;
}
.ah-log-search-input:focus {
  border-color: var(--accent-focus);
}
.ah-log-search-count {
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.ah-log-copy {
  font-size: 11px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 2px 8px;
  white-space: nowrap;
}
.ah-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ah-icon-btn:disabled:hover {
  color: var(--text-secondary);
  background: transparent;
}
.ah-log-truncated {
  font-size: 10px;
  color: var(--warning-fg);
}
.ah-log-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--bg-inset);
  padding: 8px 10px;
}
.ah-log-empty {
  color: var(--text-secondary);
  font-size: 11px;
  padding: 12px;
  text-align: center;
}
.ah-log-pre {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ah-log-match {
  background: var(--bg-selected);
  border-radius: 2px;
}
.ah-log-pre .ah-log-match-active {
  background: var(--accent-bright);
  color: var(--bg-inset);
  outline: 1px solid var(--accent-bright);
}
.ansi-bold { font-weight: 700; }
.ansi-fg-black { color: var(--ansi-black); }
.ansi-fg-red { color: var(--ansi-red); }
.ansi-fg-green { color: var(--ansi-green); }
.ansi-fg-yellow { color: var(--ansi-yellow); }
.ansi-fg-blue { color: var(--ansi-blue); }
.ansi-fg-magenta { color: var(--ansi-magenta); }
.ansi-fg-cyan { color: var(--ansi-cyan); }
.ansi-fg-white { color: var(--ansi-white); }
.ansi-fg-bright-black { color: var(--ansi-bright-black); }
.ansi-fg-bright-red { color: var(--ansi-bright-red); }
.ansi-fg-bright-green { color: var(--ansi-bright-green); }
.ansi-fg-bright-yellow { color: var(--ansi-bright-yellow); }
.ansi-fg-bright-blue { color: var(--ansi-bright-blue); }
.ansi-fg-bright-magenta { color: var(--ansi-bright-magenta); }
.ansi-fg-bright-cyan { color: var(--ansi-bright-cyan); }
.ansi-fg-bright-white { color: var(--ansi-bright-white); }
.ansi-bg-black { background-color: var(--ansi-black); }
.ansi-bg-red { background-color: var(--ansi-red); }
.ansi-bg-green { background-color: var(--ansi-green); }
.ansi-bg-yellow { background-color: var(--ansi-yellow); }
.ansi-bg-blue { background-color: var(--ansi-blue); }
.ansi-bg-magenta { background-color: var(--ansi-magenta); }
.ansi-bg-cyan { background-color: var(--ansi-cyan); }
.ansi-bg-white { background-color: var(--ansi-white); }
.ansi-bg-bright-black { background-color: var(--ansi-bright-black); }
.ansi-bg-bright-red { background-color: var(--ansi-bright-red); }
.ansi-bg-bright-green { background-color: var(--ansi-bright-green); }
.ansi-bg-bright-yellow { background-color: var(--ansi-bright-yellow); }
.ansi-bg-bright-blue { background-color: var(--ansi-bright-blue); }
.ansi-bg-bright-magenta { background-color: var(--ansi-bright-magenta); }
.ansi-bg-bright-cyan { background-color: var(--ansi-bright-cyan); }
.ansi-bg-bright-white { background-color: var(--ansi-bright-white); }

/* Log Preview Modal */
.log-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}
.log-preview-modal {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: 80vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.log-preview-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-subtle);
}
.log-preview-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.log-preview-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
}
.log-preview-close:hover {
  color: var(--text-primary);
}
.log-preview-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  background: var(--bg-base);
}
.log-preview-body pre {
  margin: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
