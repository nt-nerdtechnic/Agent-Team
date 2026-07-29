<script setup lang="ts">
// Storage usage + cleanup view. Asks the backend to scan the app data dir,
// the Electron caches, the per-agent CLI homes and the known workspaces, then
// lets the user delete the reclaimable parts.
//
// Two deletion paths exist and must not be mixed: items reported with
// `handledBy: 'backend'` go back over the WebSocket to `storage.cleanup`,
// while `handledBy: 'electron'` items can only be cleared by the main process
// (the Chromium cache is owned by the session, not the filesystem), so they
// are routed through the `window.agentTeam.storage` preload bridge.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import SettingsSection from './settings/SettingsSection.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'

type StorageRisk = 'safe' | 'caution' | 'danger'
type StorageGroupId = 'appData' | 'electron' | 'cliHomes' | 'workspaces'

interface StorageItem {
  id: string
  bytes: number
  fileCount: number
  paths: string[]
  risk: StorageRisk
  cleanable: boolean
  handledBy: 'backend' | 'electron'
  note: string | null
}
interface StorageGroup {
  id: StorageGroupId
  rootPath: string
  totalBytes: number
  items: StorageItem[]
}
interface StorageReport {
  generatedAt: string
  staleDays: number
  totalBytes: number
  disk: { totalBytes: number; freeBytes: number }
  groups: StorageGroup[]
  errors: Array<{ path: string; message: string }>
}
interface CleanupResult {
  itemId: string
  ok: boolean
  freedBytes: number
  removedCount: number
  error: string | null
}

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** Workspaces the app knows about — scanned for build artifacts / stale logs. */
  workspacePaths?: string[]
}>()

const { t, te } = useI18n()

// A full disk walk is far slower than the 10s default request timeout.
const SCAN_TIMEOUT_MS = 120_000
const STALE_DAY_OPTIONS = [7, 30, 90]

// The preload bridge takes booleans, not item ids, so the two Electron-owned
// items are recognised by their id.
const CHROMIUM_ID_RE = /chromium|chrome/i
const UPDATER_ID_RE = /updater/i

const report = ref<StorageReport | null>(null)
const scanning = ref(false)
const scanError = ref('')
const staleDays = ref(30)
const selected = ref<string[]>([])
const expanded = ref<string[]>([])
const cleaning = ref(false)
const cleanupError = ref('')
// Non-fatal problem from the Electron pass (e.g. the updater cache was skipped
// because an update is downloading) — bytes may still have been freed.
const cleanupWarning = ref('')
const cleanupFreed = ref<number | null>(null)
const cleanupFailures = ref<CleanupResult[]>([])
const pendingConfirm = ref<StorageItem[] | null>(null)
const homeDir = ref('')

const allItems = computed<StorageItem[]>(() => (report.value?.groups ?? []).flatMap((g) => g.items))

const safeCleanableItems = computed(() =>
  allItems.value.filter((i) => i.cleanable && i.risk === 'safe')
)
const selectedItems = computed(() => allItems.value.filter((i) => selected.value.includes(i.id)))
// "Clean selected" is the deliberate path for anything beyond the safe set —
// it only lights up once a non-safe item is checked.
const canCleanSelected = computed(() => selectedItems.value.some((i) => i.risk !== 'safe'))

const confirmBytes = computed(() =>
  (pendingConfirm.value ?? []).reduce((sum, i) => sum + i.bytes, 0)
)
const confirmHasDanger = computed(() =>
  (pendingConfirm.value ?? []).some((i) => i.risk === 'danger')
)

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function collapseHome(p: string): string {
  const h = homeDir.value.replace(/\/+$/, '')
  if (!h) return p
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

/** Item copy is keyed by backend id; unknown ids degrade to the raw id. */
function itemLabel(id: string): string {
  const key = `settings.storage.item.${id}.label`
  return te(key) ? t(key) : id
}
function itemDesc(id: string): string {
  const key = `settings.storage.item.${id}.desc`
  return te(key) ? t(key) : ''
}

function sortedItems(group: StorageGroup): StorageItem[] {
  return [...group.items].sort((a, b) => b.bytes - a.bytes)
}

function groupLabel(group: StorageGroup): string {
  return `${t(`settings.storage.group.${group.id}`)} · ${formatBytes(group.totalBytes)}`
}

function isExpanded(id: string): boolean {
  return expanded.value.includes(id)
}
function toggleExpanded(id: string): void {
  expanded.value = isExpanded(id)
    ? expanded.value.filter((x) => x !== id)
    : [...expanded.value, id]
}

function isSelected(id: string): boolean {
  return selected.value.includes(id)
}
function toggleSelected(id: string): void {
  selected.value = isSelected(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id]
}

async function scan(): Promise<void> {
  scanning.value = true
  scanError.value = ''
  try {
    const resp = await props.backend.send<StorageReport>(
      'storage.usage',
      { workspacePaths: props.workspacePaths ?? [], staleDays: staleDays.value },
      SCAN_TIMEOUT_MS
    )
    if (!resp.ok || !resp.payload) {
      scanError.value = resp.error?.message ?? 'storage scan failed'
      return
    }
    report.value = resp.payload
    // Drop selections for items the rescan no longer reports.
    const live = new Set(resp.payload.groups.flatMap((g) => g.items.map((i) => i.id)))
    selected.value = selected.value.filter((id) => live.has(id))
  } catch (err) {
    scanError.value = err instanceof Error ? err.message : String(err)
  } finally {
    scanning.value = false
  }
}

function onStaleDaysChange(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  staleDays.value = n
  void scan()
}

function requestCleanSafe(): void {
  if (!safeCleanableItems.value.length) return
  pendingConfirm.value = safeCleanableItems.value
}
function requestCleanSelected(): void {
  if (!canCleanSelected.value) return
  pendingConfirm.value = selectedItems.value.filter((i) => i.cleanable)
}
function cancelConfirm(): void {
  pendingConfirm.value = null
}

/** Electron-side clearing is partial-success capable: a non-ok result still
 *  reports the bytes the passes that did run freed, so `freed` and `error` are
 *  independent. The bridge itself may be absent on an older main process. */
async function clearElectronCaches(items: StorageItem[]): Promise<{
  freed: number
  error: string
}> {
  const bridge = window.agentTeam?.storage?.clearElectronCaches
  if (typeof bridge !== 'function') return { freed: 0, error: t('settings.storage.bridge-missing') }
  const chromium = items.some((i) => CHROMIUM_ID_RE.test(i.id))
  const updater = items.some((i) => UPDATER_ID_RE.test(i.id))
  try {
    const res = await bridge({ chromium, updater })
    return { freed: res?.freedBytes ?? 0, error: res?.ok ? '' : (res?.error ?? '') }
  } catch (err) {
    return { freed: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

async function confirmCleanup(): Promise<void> {
  const items = pendingConfirm.value ?? []
  pendingConfirm.value = null
  if (!items.length) return
  cleaning.value = true
  cleanupError.value = ''
  cleanupWarning.value = ''
  cleanupFreed.value = null
  cleanupFailures.value = []
  let freed = 0
  const failures: CleanupResult[] = []
  try {
    const backendIds = items.filter((i) => i.handledBy === 'backend').map((i) => i.id)
    if (backendIds.length) {
      const resp = await props.backend.send<{
        totalFreedBytes: number
        results: CleanupResult[]
      }>(
        'storage.cleanup',
        {
          itemIds: backendIds,
          workspacePaths: props.workspacePaths ?? [],
          staleDays: staleDays.value,
        },
        SCAN_TIMEOUT_MS
      )
      if (!resp.ok || !resp.payload) {
        cleanupError.value = resp.error?.message ?? 'storage cleanup failed'
      } else {
        freed += resp.payload.totalFreedBytes
        failures.push(...resp.payload.results.filter((r) => !r.ok))
      }
    }
    const electronItems = items.filter((i) => i.handledBy === 'electron')
    if (electronItems.length) {
      const res = await clearElectronCaches(electronItems)
      // Always counted: a non-ok result can still have freed real bytes.
      freed += res.freed
      if (res.error) cleanupWarning.value = res.error
    }
    cleanupFreed.value = freed
    cleanupFailures.value = failures
    selected.value = []
  } catch (err) {
    cleanupError.value = err instanceof Error ? err.message : String(err)
  } finally {
    cleaning.value = false
    await scan()
  }
}

onMounted(async () => {
  try {
    homeDir.value = (await window.agentTeam?.getHomeDir?.()) || ''
  } catch {
    /* '~' collapsing is cosmetic — fall back to absolute paths */
  }
  await scan()
})
</script>

<template>
  <div class="su-pane">
    <div class="su-toolbar">
      <p class="su-intro">{{ $t('settings.storage.intro') }}</p>
      <button class="su-rescan" :disabled="scanning || cleaning" @click="scan">
        {{ scanning ? $t('settings.storage.scanning') : $t('settings.storage.rescan') }}
      </button>
    </div>

    <p v-if="scanError" class="su-error" role="alert">
      {{ $t('settings.storage.scan-failed', { message: scanError }) }}
    </p>

    <SettingsCard>
      <SettingRow :title="$t('settings.storage.total-used')">
        <template #control>
          <span class="su-metric">{{ report ? formatBytes(report.totalBytes) : '—' }}</span>
        </template>
      </SettingRow>
      <SettingRow :title="$t('settings.storage.disk')">
        <template #control>
          <span class="su-metric su-metric-dim">
            {{
              report
                ? $t('settings.storage.disk-value', {
                    free: formatBytes(report.disk.freeBytes),
                    total: formatBytes(report.disk.totalBytes),
                  })
                : '—'
            }}
          </span>
        </template>
      </SettingRow>
      <SettingRow
        :title="$t('settings.storage.stale-days')"
        :description="$t('settings.storage.stale-days-desc')"
      >
        <template #control>
          <select
            class="su-stale-select"
            :value="staleDays"
            :disabled="scanning || cleaning"
            @change="onStaleDaysChange(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="d in STALE_DAY_OPTIONS" :key="d" :value="d">
              {{ $t('settings.storage.stale-days-option', { days: d }) }}
            </option>
          </select>
        </template>
      </SettingRow>
    </SettingsCard>

    <div class="su-actions">
      <button
        class="su-clean-safe"
        :disabled="cleaning || scanning || !safeCleanableItems.length"
        @click="requestCleanSafe"
      >
        {{ cleaning ? $t('settings.storage.cleaning') : $t('settings.storage.clean-safe') }}
      </button>
      <button
        class="su-clean-selected"
        :disabled="cleaning || scanning || !canCleanSelected"
        @click="requestCleanSelected"
      >
        {{ $t('settings.storage.clean-selected') }}
      </button>
    </div>

    <p v-if="cleanupFreed !== null" class="su-result">
      {{ $t('settings.storage.freed', { size: formatBytes(cleanupFreed) }) }}
      <span v-if="cleanupFailures.length" class="su-result-failed">
        {{ $t('settings.storage.failed-items', { count: cleanupFailures.length }) }}
      </span>
    </p>
    <ul v-if="cleanupFailures.length" class="su-failures">
      <li v-for="f in cleanupFailures" :key="f.itemId">
        {{ itemLabel(f.itemId) }} — {{ f.error }}
      </li>
    </ul>
    <p v-if="cleanupWarning" class="su-cleanup-warning">{{ cleanupWarning }}</p>
    <p v-if="cleanupError" class="su-error" role="alert">{{ cleanupError }}</p>

    <div v-if="scanning && !report" class="su-skeleton" aria-hidden="true">
      <div class="su-skeleton-row"></div>
      <div class="su-skeleton-row"></div>
      <div class="su-skeleton-row"></div>
    </div>

    <SettingsSection v-for="group in report?.groups ?? []" :key="group.id" :label="groupLabel(group)">
      <SettingsCard>
        <div
          v-for="item in sortedItems(group)"
          :key="item.id"
          class="su-item"
          :class="{ 'su-item-locked': !item.cleanable, 'su-item-danger': item.risk === 'danger' }"
          :data-item-id="item.id"
        >
          <div class="su-item-main">
            <input
              v-if="item.cleanable"
              class="su-check"
              type="checkbox"
              :checked="isSelected(item.id)"
              :disabled="cleaning || scanning"
              :aria-label="itemLabel(item.id)"
              @change="toggleSelected(item.id)"
            />
            <span v-else class="su-check-spacer" aria-hidden="true"></span>
            <div class="su-item-text">
              <div class="su-item-title">
                <span class="su-item-label">{{ itemLabel(item.id) }}</span>
                <span class="su-risk" :class="`su-risk-${item.risk}`">
                  {{ $t(`settings.storage.risk.${item.risk}`) }}
                </span>
                <span v-if="!item.cleanable" class="su-locked">
                  {{ $t('settings.storage.not-cleanable') }}
                </span>
              </div>
              <div v-if="itemDesc(item.id)" class="su-item-desc">{{ itemDesc(item.id) }}</div>
              <div v-if="item.note" class="su-item-note">{{ item.note }}</div>
            </div>
            <div class="su-item-meta">
              <span class="su-size">{{ formatBytes(item.bytes) }}</span>
              <span class="su-count">
                {{ $t('settings.storage.files', { count: item.fileCount }) }}
              </span>
            </div>
            <button
              v-if="item.paths.length"
              class="su-paths-toggle"
              @click="toggleExpanded(item.id)"
            >
              {{
                isExpanded(item.id)
                  ? $t('settings.storage.hide-paths')
                  : $t('settings.storage.show-paths')
              }}
            </button>
          </div>
          <ul v-if="isExpanded(item.id)" class="su-paths">
            <li v-for="p in item.paths" :key="p">{{ collapseHome(p) }}</li>
          </ul>
        </div>
      </SettingsCard>
    </SettingsSection>

    <div v-if="report && report.errors.length" class="su-warnings">
      <div class="su-warnings-title">{{ $t('settings.storage.errors-title') }}</div>
      <ul>
        <li v-for="e in report.errors" :key="e.path">
          <span class="su-warn-path">{{ collapseHome(e.path) }}</span>
          <span class="su-warn-msg">{{ e.message }}</span>
        </li>
      </ul>
    </div>

    <div v-if="pendingConfirm" class="su-confirm" role="dialog" aria-modal="true">
      <div class="su-confirm-card">
        <h3>{{ $t('settings.storage.confirm-title') }}</h3>
        <p>{{ $t('settings.storage.confirm-body', { size: formatBytes(confirmBytes) }) }}</p>
        <p v-if="confirmHasDanger" class="su-confirm-danger">
          {{ $t('settings.storage.confirm-danger') }}
        </p>
        <ul class="su-confirm-list">
          <li v-for="item in pendingConfirm" :key="item.id" :data-confirm-id="item.id">
            <span>{{ itemLabel(item.id) }}</span>
            <span class="su-size">{{ formatBytes(item.bytes) }}</span>
          </li>
        </ul>
        <div class="su-confirm-actions">
          <button class="su-confirm-cancel" @click="cancelConfirm">
            {{ $t('settings.storage.confirm-cancel') }}
          </button>
          <button class="su-confirm-ok" @click="confirmCleanup">
            {{ $t('settings.storage.confirm-ok') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.su-pane {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.su-toolbar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}
.su-intro {
  flex: 1;
  margin: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.su-rescan,
.su-paths-toggle,
.su-clean-safe,
.su-clean-selected,
.su-confirm-cancel,
.su-confirm-ok {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  font-size: var(--font-row-desc);
  padding: 5px 12px;
  cursor: pointer;
}
.su-rescan:hover:not(:disabled),
.su-clean-safe:hover:not(:disabled),
.su-clean-selected:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
.su-rescan:disabled,
.su-clean-safe:disabled,
.su-clean-selected:disabled {
  opacity: 0.5;
  cursor: default;
}
.su-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.su-clean-selected {
  border-color: var(--danger-muted);
  color: var(--danger-fg);
}
.su-metric {
  font-size: var(--font-row-title);
  font-weight: 600;
  color: var(--text-bright);
}
.su-metric-dim {
  font-weight: 400;
  color: var(--text-secondary);
}
.su-stale-select {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  padding: 4px 8px;
  font-size: var(--font-row-desc);
}
.su-error {
  margin: 8px 0 0;
  font-size: var(--font-row-desc);
  color: var(--danger-fg);
}
.su-result {
  margin: 12px 0 0;
  font-size: var(--font-row-desc);
  color: var(--success-fg);
}
.su-result-failed {
  margin-left: 8px;
  color: var(--attention-fg);
}
.su-failures {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: var(--font-row-desc);
  color: var(--attention-fg);
}
.su-cleanup-warning {
  margin: 4px 0 0;
  font-size: var(--font-row-desc);
  color: var(--attention-fg);
}
.su-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: var(--space-group);
}
.su-skeleton-row {
  height: 44px;
  border-radius: var(--radius-card);
  background: var(--bg-muted);
  opacity: 0.6;
  animation: su-pulse 1.2s ease-in-out infinite;
}
@keyframes su-pulse {
  50% {
    opacity: 0.25;
  }
}
.su-item {
  padding: var(--space-row-y) var(--space-row-x);
}
.su-item-locked {
  opacity: 0.55;
}
.su-item-danger .su-item-label {
  color: var(--danger-fg);
}
.su-item-main {
  display: flex;
  align-items: center;
  gap: 12px;
}
.su-check-spacer {
  display: inline-block;
  width: 13px;
  flex-shrink: 0;
}
.su-item-text {
  flex: 1;
  min-width: 0;
}
.su-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.su-item-label {
  font-size: var(--font-row-title);
  font-weight: 600;
  color: var(--text-bright);
}
.su-item-desc,
.su-item-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin-top: 2px;
}
.su-item-note {
  color: var(--text-muted);
}
.su-item-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}
.su-size {
  font-size: var(--font-row-title);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.su-count {
  font-size: var(--font-row-desc);
  color: var(--text-muted);
}
.su-risk,
.su-locked {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
}
.su-risk-safe {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.su-risk-caution {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.su-risk-danger {
  color: var(--danger-fg);
  background: var(--danger-subtle);
}
.su-locked {
  color: var(--text-muted);
  background: var(--bg-muted);
}
.su-paths {
  margin: 8px 0 0 25px;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}
.su-warnings {
  margin-top: var(--space-group);
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-card);
  background: var(--attention-subtle);
  padding: 10px 14px;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.su-warnings-title {
  font-weight: 600;
  color: var(--attention-fg);
  margin-bottom: 4px;
}
.su-warnings ul {
  margin: 0;
  padding-left: 18px;
}
.su-warn-path {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  margin-right: 8px;
  word-break: break-all;
}
.su-confirm {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--shadow-scrim);
  z-index: 40;
}
.su-confirm-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  padding: 20px 24px;
  max-width: 460px;
  width: 100%;
  color: var(--text-primary);
  font-size: var(--font-row-desc);
}
.su-confirm-card h3 {
  margin: 0 0 8px;
  font-size: var(--font-row-title);
  color: var(--text-bright);
}
.su-confirm-danger {
  color: var(--danger-fg);
  font-weight: 600;
}
.su-confirm-list {
  list-style: none;
  margin: 12px 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.su-confirm-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-top: 1px solid var(--border-muted);
}
.su-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.su-confirm-ok {
  border-color: var(--danger-muted);
  background: var(--danger-deep);
  color: var(--text-on-emphasis);
}
</style>
