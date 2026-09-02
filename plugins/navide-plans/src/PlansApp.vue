<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SafeAiCliPanel } from '@navide/plugin-ui'
import { useNotify, useTheme } from '@navide/plugin-ui/foundation'
import {
  backendErrorMessage,
  callCapability,
  getWorkspacePreference,
  plansBackend,
  plansViewRuntime,
  setWorkspacePreference,
  createPlansAiCliController,
} from './backend'

interface TodoSummary {
  total: number
  by_status: Record<string, number>
}

interface PlanTodo {
  id: string
  content: string
  status: string
}

interface PlanMeta {
  schemaVersion?: number
  name: string
  overview?: string
  stage: string
  approvedAt?: string | null
  archivedAt?: string | null
  todos: PlanTodo[]
  reviewNotes: Array<{ id: string; author: string; text: string; resolved?: boolean }>
  [key: string]: unknown
}

interface PlanSummary {
  rel_path: string
  name: string
  stage?: string | null
  overview?: string
  todos?: TodoSummary
  mtime?: number | null
  kind?: 'plan' | 'document'
  meta?: PlanMeta | null
}

interface PlanDocument {
  rel_path: string
  meta: PlanMeta | null
  html?: string
  mtime?: number | null
}

interface PlanGroup {
  key: string
  label: string
  plans: PlanSummary[]
}

const PLAN_STAGES = ['draft', 'in-review', 'approved', 'in-progress', 'done', 'abandoned'] as const
type PlanStage = (typeof PLAN_STAGES)[number]
type StageFilter = 'all' | PlanStage
type SortMode = 'updated' | 'title' | 'progress'
type SortDirection = 'asc' | 'desc'
type GroupMode = 'flat' | 'stage'

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const initialRelPath = params.get('rel_path') ?? ''
function isLeftContribution(): boolean {
  return new URLSearchParams(window.location.search).get('contribution') === 'left'
}
const { loadTheme } = useTheme()
const { toast } = useNotify()
const { t } = useI18n()

const plans = ref<PlanSummary[]>([])
const selectedPath = ref(initialRelPath)
const selected = ref<PlanDocument | null>(null)
const searchQuery = ref('')
const stageFilter = ref<StageFilter>('all')
const sort = ref<SortMode>('updated')
const sortDirection = ref<SortDirection>('desc')
const groupMode = ref<GroupMode>('flat')
const collapsedSections = ref<Set<string>>(new Set(['archived']))
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const newName = ref('')
const newOverview = ref('')
const newTodos = ref('')
const noteText = ref('')
const stage = ref<PlanStage>('draft')
const todoStatus = ref('pending')
const selectedTodoId = ref('')
const recentPaths = ref<string[]>([])
const pinnedPaths = ref<string[]>([])
const sidebarCollapsed = ref(false)
const quickOpenActive = ref(false)
const quickOpenQuery = ref('')
const quickOpenIndex = ref(0)
const quickOpenInput = ref<HTMLInputElement | null>(null)
const contextMenu = ref<{ x: number; y: number; relPath: string } | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const renameTarget = ref<string | null>(null)
const renameValue = ref('')
let stopTarget: (() => void) | null = null
let plansSubscription: ReturnType<typeof plansBackend.subscribe> | null = null
const aiCliController = createPlansAiCliController()

function planTitle(plan: PlanSummary): string {
  return plan.meta?.name || plan.name || plan.rel_path.split('/').pop() || t('pane.plans.v2.untitled')
}

function planStage(plan: PlanSummary): string | null {
  return plan.meta?.stage ?? plan.stage ?? null
}

function planStageLabel(value: string | null | undefined): string {
  if (!value) return t('pane.plans.v2.document')
  return t(`pane.plans.stage-${value}`)
}

function todoStatusLabel(value: string): string {
  return t(`pane.plans.status-${value}`)
}

function planProgress(plan: PlanSummary): { done: number; total: number } {
  const todos = plan.meta?.todos
  if (todos) {
    return {
      done: todos.filter((todo) => todo.status === 'done').length,
      total: todos.length,
    }
  }
  return {
    done: plan.todos?.by_status.done ?? 0,
    total: plan.todos?.total ?? 0,
  }
}

function isArchived(plan: PlanSummary): boolean {
  return typeof plan.meta?.archivedAt === 'string' && plan.meta.archivedAt.length > 0
}

function matchesSearch(plan: PlanSummary): boolean {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return true
  return `${planTitle(plan)} ${plan.name} ${plan.rel_path} ${plan.meta?.overview ?? plan.overview ?? ''}`
    .toLowerCase()
    .includes(query)
}

function matchesStage(plan: PlanSummary): boolean {
  return stageFilter.value === 'all' || planStage(plan) === stageFilter.value
}

function comparePlans(left: PlanSummary, right: PlanSummary): number {
  let comparison: number
  if (sort.value === 'title') {
    comparison = planTitle(left).localeCompare(planTitle(right), undefined, { numeric: true })
  } else if (sort.value === 'progress') {
    const leftProgress = planProgress(left)
    const rightProgress = planProgress(right)
    const leftRatio = leftProgress.done / Math.max(leftProgress.total, 1)
    const rightRatio = rightProgress.done / Math.max(rightProgress.total, 1)
    comparison = rightRatio - leftRatio
  } else {
    comparison = (right.mtime ?? 0) - (left.mtime ?? 0)
  }
  return sortDirection.value === 'asc' ? -comparison : comparison
}

function sortedPlans(items: PlanSummary[]): PlanSummary[] {
  return [...items].sort(comparePlans)
}

const activePlans = computed(() =>
  sortedPlans(plans.value.filter((plan) => !isArchived(plan) && matchesStage(plan) && matchesSearch(plan))),
)

const archivedPlans = computed(() =>
  stageFilter.value === 'all'
    ? sortedPlans(plans.value.filter((plan) => isArchived(plan) && matchesSearch(plan)))
    : [],
)

const planGroups = computed<PlanGroup[]>(() => {
  if (groupMode.value === 'flat') {
    return activePlans.value.length
      ? [{ key: 'all', label: t('pane.plans.v2.all-documents'), plans: activePlans.value }]
      : []
  }

  const groups: PlanGroup[] = []
  const documents = activePlans.value.filter((plan) => !planStage(plan))
  if (stageFilter.value === 'all' && documents.length) {
    groups.push({ key: 'documents', label: t('pane.plans.v2.documents'), plans: documents })
  }
  for (const value of PLAN_STAGES) {
    const groupPlans = activePlans.value.filter((plan) => planStage(plan) === value)
    if (groupPlans.length) groups.push({ key: value, label: planStageLabel(value), plans: groupPlans })
  }
  return groups
})

const pinnedAndRecent = computed(() => {
  const byPath = new Map(plans.value.map((plan) => [plan.rel_path, plan]))
  const inScope = (relPath: string): PlanSummary | null => {
    const plan = byPath.get(relPath)
    if (!plan || !matchesSearch(plan) || !matchesStage(plan)) return null
    return plan
  }
  const pinned = pinnedPaths.value.map(inScope).filter((plan): plan is PlanSummary => plan !== null)
  const recent = recentPaths.value
    .filter((relPath) => !pinnedPaths.value.includes(relPath))
    .map(inScope)
    .filter((plan): plan is PlanSummary => plan !== null)
  return [...pinned, ...recent]
})

const archivableDone = computed(() =>
  plans.value.filter((plan) => planStage(plan) === 'done' && !isArchived(plan) && plan.meta),
)

const deletablePlans = computed(() =>
  plans.value.filter(
    (plan) => plan.meta && !isArchived(plan) && ['done', 'abandoned'].includes(planStage(plan) ?? ''),
  ),
)

const selectedTodos = computed(() => selected.value?.meta?.todos ?? [])

const quickOpenRows = computed(() => {
  const query = quickOpenQuery.value.trim().toLowerCase()
  const source = query
    ? plans.value.filter((plan) => matchesQuickOpen(plan, query))
    : pinnedAndRecent.value
  return sortedPlans(source).slice(0, 8)
})

function matchesQuickOpen(plan: PlanSummary, query: string): boolean {
  return `${planTitle(plan)} ${plan.name} ${plan.rel_path} ${plan.meta?.overview ?? ''}`
    .toLowerCase()
    .includes(query)
}

function preferenceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  return undefined
}

async function loadPreference(key: string, fallback: string): Promise<string> {
  try {
    const stored = preferenceString(await getWorkspacePreference(key))
    if (stored !== undefined) return stored
    await setWorkspacePreference(key, fallback)
    return fallback
  } catch {
    return fallback
  }
}

async function loadPreferences(): Promise<void> {
  const [filter, sortValue, direction, group, collapsed, recent, pinned] = await Promise.all([
    loadPreference('plans.filter', 'all'),
    loadPreference('plans.sort', 'updated'),
    loadPreference('plans.sortdir', 'desc'),
    loadPreference('plans.group', 'flat'),
    loadPreference('plans.collapsed', JSON.stringify(['archived'])),
    loadPreference('plans.recent', '[]'),
    loadPreference('plans.pinned', '[]'),
  ])
  if (filter === 'all' || PLAN_STAGES.includes(filter as PlanStage)) stageFilter.value = filter as StageFilter
  if (['updated', 'title', 'progress'].includes(sortValue)) sort.value = sortValue as SortMode
  if (direction === 'asc' || direction === 'desc') sortDirection.value = direction
  if (group === 'flat' || group === 'stage') groupMode.value = group
  try {
    const parsed = JSON.parse(collapsed) as unknown
    collapsedSections.value = new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : parsed === true
          ? ['all']
          : ['archived'],
    )
  } catch {
    collapsedSections.value = new Set(['archived'])
  }
  try {
    const parsed = JSON.parse(recent) as unknown
    if (Array.isArray(parsed)) recentPaths.value = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    recentPaths.value = []
  }
  try {
    const parsed = JSON.parse(pinned) as unknown
    if (Array.isArray(parsed)) pinnedPaths.value = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    pinnedPaths.value = []
  }
}

async function persistPreference(key: string, value: string): Promise<void> {
  try {
    await setWorkspacePreference(key, value)
  } catch {
    // Preference persistence is best effort; document operations remain usable.
  }
}

function noteOpened(relPath: string): void {
  if (!relPath) return
  const next = [relPath, ...recentPaths.value.filter((path) => path !== relPath)].slice(0, 5)
  if (next.length === recentPaths.value.length && next.every((path, index) => path === recentPaths.value[index])) return
  recentPaths.value = next
  void persistPreference('plans.recent', JSON.stringify(recentPaths.value))
}

function togglePin(relPath: string): void {
  pinnedPaths.value = pinnedPaths.value.includes(relPath)
    ? pinnedPaths.value.filter((path) => path !== relPath)
    : [...pinnedPaths.value, relPath]
  void persistPreference('plans.pinned', JSON.stringify(pinnedPaths.value))
}

function isPinned(relPath: string): boolean {
  return pinnedPaths.value.includes(relPath)
}

function applySelected(document: PlanDocument, relPath: string): void {
  selected.value = { ...document, rel_path: document.rel_path || relPath }
  selectedPath.value = relPath
  stage.value = (document.meta?.stage as PlanStage | undefined) ?? 'draft'
  selectedTodoId.value = document.meta?.todos[0]?.id ?? ''
  todoStatus.value = document.meta?.todos[0]?.status ?? 'pending'
}

async function readPlan(relPath: string, openInEditor: boolean): Promise<void> {
  const document = await plansBackend.call('plans.read', { rel_path: relPath }) as unknown as PlanDocument
  applySelected(document, relPath)
  if (!openInEditor) return
  noteOpened(relPath)
  const result = await callCapability('ui', 'openInEditor', { path: relPath }) as { opened?: boolean }
  if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
}

async function openPlan(relPath: string): Promise<void> {
  if (isLeftContribution()) {
    noteOpened(relPath)
    try {
      const result = await callCapability('ui', 'openPlansWindow', { path: relPath }) as { opened?: boolean }
      if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
    } catch (cause) {
      toast(backendErrorMessage(cause), { type: 'error' })
    }
    return
  }
  try {
    await readPlan(relPath, true)
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  }
}

async function refreshSelected(): Promise<void> {
  if (!selectedPath.value) return
  try {
    await readPlan(selectedPath.value, false)
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  }
}

async function loadPlans(openSelected = true): Promise<void> {
  if (!workspacePath) {
    error.value = t('pane.plans.v2.workspace-required')
    return
  }
  loading.value = true
  error.value = ''
  try {
    const result = await plansBackend.call('plans.list', {}) as unknown as PlanSummary[]
    plans.value = Array.isArray(result) ? result : []
    if (openSelected && selectedPath.value && plans.value.some((plan) => plan.rel_path === selectedPath.value)) {
      await openPlan(selectedPath.value)
    }
  } catch (cause) {
    error.value = backendErrorMessage(cause)
  } finally {
    loading.value = false
  }
}

async function createPlan(): Promise<void> {
  if (!newName.value.trim()) return
  busy.value = true
  try {
    const result = await plansBackend.call<{ rel_path: string }>('plans.create', {
      name: newName.value,
      overview: newOverview.value,
      todos: newTodos.value.split('\n').map((line) => line.trim()).filter(Boolean),
    })
    newName.value = ''
    newOverview.value = ''
    newTodos.value = ''
    await loadPlans(false)
    await openPlan(result.rel_path)
    toast(t('pane.plans.v2.plan-created'), { type: 'success' })
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function updateStage(): Promise<void> {
  if (!selectedPath.value || !selected.value?.meta) return
  busy.value = true
  try {
    await plansBackend.call('plans.update_stage', { rel_path: selectedPath.value, stage: stage.value })
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function updateTodo(): Promise<void> {
  if (!selectedPath.value || !selectedTodoId.value) return
  busy.value = true
  try {
    await plansBackend.call('plans.update_todo', {
      rel_path: selectedPath.value,
      todo_id: selectedTodoId.value,
      status: todoStatus.value,
    })
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function addNote(): Promise<void> {
  if (!selectedPath.value || !noteText.value.trim()) return
  busy.value = true
  try {
    await plansBackend.call('plans.add_note', {
      rel_path: selectedPath.value,
      text: noteText.value,
      author: 'user',
    })
    noteText.value = ''
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function setArchived(relPath: string, archivedAt: string | null): Promise<void> {
  busy.value = true
  try {
    await plansBackend.call('plans.update_archive', { rel_path: relPath, archived_at: archivedAt })
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function toggleArchive(): Promise<void> {
  if (!selectedPath.value || !selected.value?.meta) return
  const plan = plans.value.find((item) => item.rel_path === selectedPath.value)
  const title = plan ? planTitle(plan) : selectedPath.value
  if (!selected.value.meta.archivedAt && !window.confirm(t('pane.plans.archive-confirm', { name: title }))) return
  await setArchived(selectedPath.value, selected.value.meta.archivedAt ? null : new Date().toISOString())
}

async function archiveAllDone(): Promise<void> {
  if (!archivableDone.value.length || !window.confirm(t('pane.plans.archive-all-confirm', { count: archivableDone.value.length }))) return
  busy.value = true
  try {
    for (const plan of archivableDone.value) {
      await plansBackend.call('plans.update_archive', {
        rel_path: plan.rel_path,
        archived_at: new Date().toISOString(),
      })
    }
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function deletePath(relPath: string): Promise<void> {
  const plan = plans.value.find((item) => item.rel_path === relPath)
  if (!plan || !window.confirm(t('pane.plans.delete-confirm', { name: planTitle(plan) }))) return
  busy.value = true
  try {
    await plansBackend.call('plans.delete', { rel_path: relPath })
    recentPaths.value = recentPaths.value.filter((path) => path !== relPath)
    pinnedPaths.value = pinnedPaths.value.filter((path) => path !== relPath)
    void persistPreference('plans.recent', JSON.stringify(recentPaths.value))
    void persistPreference('plans.pinned', JSON.stringify(pinnedPaths.value))
    if (selectedPath.value === relPath) {
      selectedPath.value = ''
      selected.value = null
    }
    await loadPlans(false)
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function deleteCompleted(): Promise<void> {
  if (!deletablePlans.value.length || !window.confirm(t('pane.plans.delete-completed-confirm', { count: deletablePlans.value.length }))) return
  busy.value = true
  try {
    for (const plan of deletablePlans.value) {
      await plansBackend.call('plans.delete', { rel_path: plan.rel_path })
    }
    await loadPlans(false)
    if (selectedPath.value && !plans.value.some((plan) => plan.rel_path === selectedPath.value)) {
      selectedPath.value = ''
      selected.value = null
    }
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function promoteSelected(): Promise<void> {
  if (!selectedPath.value || selected.value?.meta) return
  busy.value = true
  try {
    await plansBackend.call('plans.promote', { rel_path: selectedPath.value })
    await loadPlans(false)
    await refreshSelected()
    toast(t('pane.plans.upgrade-success'), { type: 'success' })
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

function isHtmlPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.html')
}

async function renamePlan(): Promise<void> {
  if (!selectedPath.value || !isHtmlPath(selectedPath.value)) return
  const currentName = selectedPath.value.split('/').pop() ?? ''
  const nextName = window.prompt(t('pane.plans.rename-placeholder'), currentName)?.trim()
  if (!nextName || nextName === currentName) return
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*_[0-9a-f]{6}\.html$/.test(nextName)) {
    toast(t('pane.plans.rename-invalid'), { type: 'error' })
    return
  }
  busy.value = true
  try {
    const result = await plansBackend.call<{ to: string }>('plans.rename', {
      from: selectedPath.value,
      to: `.agent-team/plans/${nextName}`,
    })
    selectedPath.value = result.to
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function copyPath(relPath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(relPath)
    toast(t('pane.plans.copy-path-success'), { type: 'success' })
  } catch {
    toast(relPath, { type: 'error' })
  }
}

function toggleSection(key: string): void {
  const next = new Set(collapsedSections.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSections.value = next
  void persistPreference('plans.collapsed', JSON.stringify([...next]))
}

function isSectionCollapsed(key: string): boolean {
  return collapsedSections.value.has(key)
}

function toggleSortDirection(): void {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  void persistPreference('plans.sortdir', sortDirection.value)
}

function changeSort(): void {
  sortDirection.value = sort.value === 'title' ? 'asc' : 'desc'
  void persistPreference('plans.sort', sort.value)
  void persistPreference('plans.sortdir', sortDirection.value)
}

function openContextMenu(event: MouseEvent, relPath: string): void {
  contextMenu.value = {
    x: Math.min(event.clientX, Math.max(8, window.innerWidth - 220)),
    y: Math.min(event.clientY, Math.max(8, window.innerHeight - 180)),
    relPath,
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

function openQuickOpen(): void {
  quickOpenActive.value = true
  quickOpenQuery.value = ''
  quickOpenIndex.value = 0
  void nextTick(() => quickOpenInput.value?.focus())
}

function closeQuickOpen(): void {
  quickOpenActive.value = false
  quickOpenQuery.value = ''
}

function moveQuickOpen(delta: number): void {
  const count = quickOpenRows.value.length
  if (count) quickOpenIndex.value = (quickOpenIndex.value + delta + count) % count
}

function confirmQuickOpen(): void {
  const plan = quickOpenRows.value[quickOpenIndex.value]
  if (!plan) return
  closeQuickOpen()
  void openPlan(plan.rel_path)
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openQuickOpen()
  } else if (event.key === 'Escape' && quickOpenActive.value) {
    closeQuickOpen()
  }
}

function receiveTarget(target: Record<string, string>): void {
  if (target.rel_path) void openPlan(target.rel_path)
}

async function beginRename(): Promise<void> {
  closeContextMenu()
  if (!selectedPath.value || !isHtmlPath(selectedPath.value)) return
  renameTarget.value = selectedPath.value
  renameValue.value = selectedPath.value.split('/').pop() ?? ''
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename(): void {
  renameTarget.value = null
  renameValue.value = ''
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value
  if (!target) return
  const nextName = renameValue.value.trim()
  cancelRename()
  if (!nextName || nextName === target.split('/').pop()) return
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*_[0-9a-f]{6}\.html$/.test(nextName)) {
    toast(t('pane.plans.rename-invalid'), { type: 'error' })
    return
  }
  busy.value = true
  try {
    const result = await plansBackend.call<{ to: string }>('plans.rename', {
      from: target,
      to: `.agent-team/plans/${nextName}`,
    })
    if (selectedPath.value === target) selectedPath.value = result.to
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

watch(quickOpenQuery, () => {
  quickOpenIndex.value = 0
})

onMounted(() => {
  loadTheme()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('click', closeContextMenu)
  try {
    plansSubscription = plansBackend.subscribe('plans.changed', () => void loadPlans(false))
    void plansSubscription.ready.catch((cause: unknown) => toast(backendErrorMessage(cause), { type: 'error' }))
    void plansSubscription.settled.catch((cause: unknown) => {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined
      if (code !== 'USER_CANCELLED' && code !== 'PLUGIN_STOPPING') toast(backendErrorMessage(cause), { type: 'error' })
    })
  } catch (cause) {
    toast(backendErrorMessage(cause), { type: 'error' })
  }
  const targetSubscription = plansViewRuntime.onOpenTarget(receiveTarget)
  stopTarget = () => targetSubscription.dispose()
  void loadPreferences().then(() => loadPlans())
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('click', closeContextMenu)
  plansSubscription?.dispose()
  plansSubscription = null
  stopTarget?.()
  aiCliController.dispose()
})
</script>

<template>
  <div class="plans-surface" :class="{ 'plans-left-surface': isLeftContribution() }">
    <header class="plans-toolbar">
      <div>
        <p class="eyebrow">{{ t('pane.plans.v2.workspace-plans') }}</p>
        <h1>{{ t('pane.plans.title') }}</h1>
        <p class="workspace-path">{{ workspacePath || t('pane.plans.v2.no-workspace') }}</p>
      </div>
      <div v-if="!isLeftContribution()" class="toolbar-actions">
        <button type="button" @click="openQuickOpen">{{ t('pane.plans.v2.quick-open') }}</button>
        <button type="button" @click="sidebarCollapsed = !sidebarCollapsed">
          {{ sidebarCollapsed ? t('pane.plans.v2.show-list') : t('pane.plans.v2.hide-list') }}
        </button>
        <button type="button" @click="void loadPlans(false)">{{ t('pane.plans.refresh') }}</button>
      </div>
    </header>

    <div class="plans-layout" :class="{ 'is-collapsed': sidebarCollapsed, 'is-left-contribution': isLeftContribution() }">
      <aside v-if="!sidebarCollapsed" class="plans-sidebar">
        <div class="sidebar-controls">
          <input v-model="searchQuery" type="search" :placeholder="t('pane.plans.search-placeholder')" />
          <select v-model="stageFilter" @change="void persistPreference('plans.filter', stageFilter)">
            <option value="all">{{ t('pane.plans.filter-all-stages') }}</option>
            <option v-for="value in PLAN_STAGES" :key="value" :value="value">{{ planStageLabel(value) }}</option>
          </select>
          <div class="sort-controls">
            <select v-model="sort" @change="changeSort">
              <option value="updated">{{ t('pane.plans.sort-updated') }}</option>
              <option value="title">{{ t('pane.plans.sort-title') }}</option>
              <option value="progress">{{ t('pane.plans.sort-progress') }}</option>
            </select>
            <button type="button" :aria-label="t(sortDirection === 'asc' ? 'pane.plans.sort-desc' : 'pane.plans.sort-asc')" @click="toggleSortDirection">
              {{ sortDirection === 'asc' ? '↑' : '↓' }}
            </button>
            <button type="button" :aria-pressed="groupMode === 'stage'" @click="groupMode = groupMode === 'flat' ? 'stage' : 'flat'; void persistPreference('plans.group', groupMode)">
              {{ groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat') }}
            </button>
          </div>
        </div>

        <p v-if="loading" class="muted">{{ t('pane.plans.file-loading') }}</p>
        <p v-else-if="error" class="error">{{ error }}</p>

        <section v-if="pinnedAndRecent.length" class="plan-section">
          <button type="button" class="section-toggle" @click="toggleSection('recent')">
            <span>{{ t('pane.plans.v2.recent-pinned') }}</span>
            <span>{{ isSectionCollapsed('recent') ? '▸' : '▾' }} {{ pinnedAndRecent.length }}</span>
          </button>
          <template v-if="!isSectionCollapsed('recent')">
            <div v-for="plan in pinnedAndRecent" :key="`recent:${plan.rel_path}`" class="plan-row compact" :class="{ selected: selectedPath === plan.rel_path }" role="button" tabindex="0" @click="void openPlan(plan.rel_path)" @keydown.enter.prevent="void openPlan(plan.rel_path)">
              <span class="plan-row-title">{{ planTitle(plan) }}</span>
              <span class="plan-row-meta">{{ planStageLabel(planStage(plan)) }}</span>
              <button type="button" class="pin-button" :aria-pressed="isPinned(plan.rel_path)" @click.stop="togglePin(plan.rel_path)">{{ isPinned(plan.rel_path) ? '📌' : '◇' }}</button>
            </div>
          </template>
        </section>

        <section v-for="group in planGroups" :key="group.key" class="plan-section">
          <button type="button" class="section-toggle" @click="toggleSection(group.key)">
            <span>{{ group.label }}</span>
            <span>{{ isSectionCollapsed(group.key) ? '▸' : '▾' }} {{ group.plans.length }}</span>
          </button>
          <template v-if="!isSectionCollapsed(group.key)">
            <button v-for="plan in group.plans" :key="plan.rel_path" type="button" class="plan-row" :class="{ selected: selectedPath === plan.rel_path, done: planStage(plan) === 'done' || planStage(plan) === 'abandoned' }" @click="void openPlan(plan.rel_path)" @contextmenu.prevent="openContextMenu($event, plan.rel_path)">
              <span class="plan-row-title">{{ planTitle(plan) }}</span>
              <span class="plan-row-overview">{{ plan.meta?.overview || plan.overview || plan.rel_path }}</span>
              <span class="plan-row-meta">
                <span v-if="planStage(plan)" class="chip">{{ planStageLabel(planStage(plan)) }}</span>
                <span v-else class="chip">{{ t('pane.plans.v2.document') }}</span>
                <span v-if="planProgress(plan).total">{{ planProgress(plan).done }}/{{ planProgress(plan).total }}</span>
                <span v-else>{{ isHtmlPath(plan.rel_path) ? t('pane.plans.v2.html') : t('pane.plans.v2.markdown') }}</span>
              </span>
            </button>
          </template>
        </section>

        <section v-if="archivedPlans.length" class="plan-section">
          <button type="button" class="section-toggle" @click="toggleSection('archived')">
            <span>{{ t('pane.plans.archived') }}</span>
            <span>{{ isSectionCollapsed('archived') ? '▸' : '▾' }} {{ archivedPlans.length }}</span>
          </button>
          <template v-if="!isSectionCollapsed('archived')">
            <button v-for="plan in archivedPlans" :key="plan.rel_path" type="button" class="plan-row done" :class="{ selected: selectedPath === plan.rel_path }" @click="void openPlan(plan.rel_path)" @contextmenu.prevent="openContextMenu($event, plan.rel_path)">
              <span class="plan-row-title">{{ planTitle(plan) }}</span>
              <span class="plan-row-overview">{{ plan.meta?.overview || plan.overview || plan.rel_path }}</span>
              <span class="plan-row-meta"><span class="chip">{{ planStageLabel(planStage(plan)) }}</span><span class="chip archived">{{ t('pane.plans.archived') }}</span></span>
            </button>
          </template>
        </section>

        <p v-if="!loading && !error && !planGroups.length && !archivedPlans.length" class="muted">{{ t('pane.plans.v2.no-documents') }}</p>
        <section v-if="archivableDone.length || deletablePlans.length" class="completed-actions">
          <button type="button" :disabled="busy || !archivableDone.length" @click="void archiveAllDone()">{{ t('pane.plans.archive-all-done') }}</button>
          <button type="button" :disabled="busy || !deletablePlans.length" @click="void deleteCompleted()">{{ t('pane.plans.delete-all') }}</button>
        </section>

        <form v-if="!isLeftContribution()" class="create-form" @submit.prevent="void createPlan()">
          <h2>{{ t('pane.plans.v2.new-plan') }}</h2>
          <input v-model="newName" required :placeholder="t('pane.plans.v2.plan-name')" />
          <input v-model="newOverview" :placeholder="t('pane.plans.v2.overview-placeholder')" />
          <textarea v-model="newTodos" rows="3" :placeholder="t('pane.plans.v2.todo-placeholder')" />
          <button type="submit" :disabled="busy">{{ t('action.create') }}</button>
        </form>
      </aside>

      <main v-if="!isLeftContribution()" class="plan-content">
        <div v-if="selected" class="selected-document">
          <div class="content-toolbar">
            <div>
              <p class="eyebrow">{{ selected.rel_path }}</p>
              <h2>{{ selected.meta?.name ?? selected.rel_path.split('/').pop() }}</h2>
            </div>
            <div class="toolbar-actions">
              <button type="button" @click="void readPlan(selectedPath, true)">{{ t('action.open-in-editor') }}</button>
              <button v-if="selected.meta" type="button" @click="void toggleArchive()">{{ selected.meta.archivedAt ? t('pane.plans.unarchive') : t('pane.plans.archive') }}</button>
              <button v-if="!selected.meta" type="button" @click="void promoteSelected()">{{ t('pane.plans.menu-upgrade') }}</button>
              <button v-if="isHtmlPath(selectedPath)" type="button" @click="void renamePlan()">{{ t('action.rename') }}</button>
              <button type="button" class="danger" @click="void deletePath(selectedPath)">{{ t('action.delete') }}</button>
            </div>
          </div>

          <div class="document-status">
                <span>{{ selected.meta ? t('pane.plans.v2.plan-metadata') : t('pane.plans.v2.plain-document') }}</span>
            <button type="button" @click="void copyPath(selected.rel_path)">{{ t('action.copy-path') }}</button>
          </div>

          <template v-if="selected.meta">
            <div class="review-controls">
              <label>{{ t('pane.plans.v2.stage') }} <select v-model="stage" @change="void updateStage()"><option v-for="value in PLAN_STAGES" :key="value" :value="value">{{ planStageLabel(value) }}</option></select></label>
              <label v-if="selectedTodos.length">{{ t('pane.plans.v2.todo') }} <select v-model="selectedTodoId"><option v-for="todo in selectedTodos" :key="todo.id" :value="todo.id">{{ todo.content }}</option></select></label>
              <select v-if="selectedTodos.length" v-model="todoStatus" @change="void updateTodo()"><option v-for="value in ['pending', 'in-progress', 'done', 'skipped']" :key="value" :value="value">{{ todoStatusLabel(value) }}</option></select>
            </div>
            <article class="plan-summary">
              <p v-if="selected.meta.overview">{{ selected.meta.overview }}</p>
              <h3>{{ t('pane.plans.todos') }}</h3>
              <ul><li v-for="todo in selectedTodos" :key="todo.id" :class="{ complete: todo.status === 'done' }">{{ todoStatusLabel(todo.status) }} — {{ todo.content }}</li><li v-if="!selectedTodos.length" class="muted">{{ t('pane.plans.todos-empty') }}</li></ul>
              <h3>{{ t('pane.plans.review-notes') }}</h3>
              <ul><li v-for="note in selected.meta.reviewNotes" :key="note.id">{{ note.author }} — {{ note.text }}</li><li v-if="!selected.meta.reviewNotes.length" class="muted">{{ t('pane.plans.review-empty') }}</li></ul>
            </article>
            <form class="note-form" @submit.prevent="void addNote()"><input v-model="noteText" :placeholder="t('pane.plans.review-add-placeholder')" /><button type="submit" :disabled="busy">{{ t('pane.plans.review-send') }}</button></form>
          </template>
          <div v-else class="document-summary"><p>{{ t('pane.plans.v2.promote-description') }}</p><p class="muted">{{ t('pane.plans.v2.editor-description') }}</p></div>
        </div>
        <div v-else class="empty-state"><h2>{{ t('pane.plans.v2.empty-title') }}</h2><p>{{ t('pane.plans.v2.empty-description') }}</p></div>
      </main>

      <aside v-if="!isLeftContribution()" class="ai-sidebar"><SafeAiCliPanel :controller="aiCliController" /></aside>
    </div>

    <div v-if="contextMenu" class="context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
      <button type="button" @click="void openPlan(contextMenu.relPath); closeContextMenu()">{{ t('action.open-in-editor') }}</button>
      <button type="button" @click="void copyPath(contextMenu.relPath); closeContextMenu()">{{ t('action.copy-path') }}</button>
      <button type="button" @click="selectedPath = contextMenu.relPath; void readPlan(selectedPath, false); closeContextMenu()">{{ t('pane.plans.v2.select') }}</button>
      <button v-if="isHtmlPath(contextMenu.relPath)" type="button" @click="selectedPath = contextMenu!.relPath; void beginRename()">{{ t('action.rename') }}</button>
      <button type="button" class="danger" @click="void deletePath(contextMenu!.relPath); closeContextMenu()">{{ t('action.delete') }}</button>
    </div>

    <div v-if="quickOpenActive" class="overlay" @click.self="closeQuickOpen">
      <div class="quick-open" role="dialog" :aria-label="t('pane.plans.v2.quick-open')">
        <input ref="quickOpenInput" v-model="quickOpenQuery" :placeholder="t('pane.plans.v2.search-plans')" @keydown.down.prevent="moveQuickOpen(1)" @keydown.up.prevent="moveQuickOpen(-1)" @keydown.enter.prevent="confirmQuickOpen" @keydown.escape="closeQuickOpen" />
        <button v-for="(plan, index) in quickOpenRows" :key="plan.rel_path" type="button" :class="{ active: index === quickOpenIndex }" @mousemove="quickOpenIndex = index" @click="confirmQuickOpen"><span>{{ planTitle(plan) }}</span><span class="muted">{{ planStageLabel(planStage(plan)) }}</span></button>
        <p v-if="!quickOpenRows.length" class="muted">{{ t('pane.plans.v2.no-matching') }}</p>
      </div>
    </div>

    <div v-if="renameTarget" class="overlay" @click.self="cancelRename">
      <form class="rename-dialog" @submit.prevent="void submitRename()"><h2>{{ t('pane.plans.v2.rename-plan') }}</h2><input ref="renameInput" v-model="renameValue" @keydown.escape="cancelRename" /><div class="toolbar-actions"><button type="button" @click="cancelRename">{{ t('action.cancel') }}</button><button type="submit">{{ t('action.rename') }}</button></div></form>
    </div>
  </div>
</template>

<style scoped>
.plans-surface { min-height: 100vh; background: var(--bg-base); color: var(--text-primary); }
.plans-left-surface { min-height: 100%; }
.plans-toolbar, .content-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); }
.plans-toolbar h1, .content-toolbar h2, .create-form h2 { margin: 0; }
.eyebrow { margin: 0; color: var(--text-muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.workspace-path { margin: 3px 0 0; color: var(--text-muted); font: 12px var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60vw; }
.toolbar-actions, .sort-controls, .review-controls, .document-status { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button, input, select, textarea { border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-subtle); color: inherit; padding: 7px 9px; font: inherit; }
button { cursor: pointer; }
button:hover, .plan-row.selected, .quick-open button.active { background: var(--bg-hover); }
button.danger { color: var(--text-danger, #d45b5b); }
.plans-layout { display: grid; grid-template-columns: 320px minmax(0, 1fr) 320px; min-height: calc(100vh - 96px); }
.plans-layout.is-collapsed { grid-template-columns: minmax(0, 1fr) 320px; }
.plans-layout.is-left-contribution { display: block; min-height: 100%; }
.plans-layout.is-left-contribution .plans-sidebar { border-right: 0; min-height: 100%; }
.plans-sidebar, .ai-sidebar { padding: 16px; border-right: 1px solid var(--border-subtle); overflow: auto; }
.ai-sidebar { border-left: 1px solid var(--border-subtle); border-right: 0; }
.sidebar-controls, .create-form { display: grid; gap: 8px; }
.sidebar-controls { margin-bottom: 12px; }
.plan-section { margin-bottom: 10px; }
.section-toggle { display: flex; justify-content: space-between; width: 100%; margin-bottom: 5px; background: transparent; color: var(--text-muted); font-size: 12px; text-align: left; }
.plan-row { display: grid; gap: 3px; width: 100%; margin-bottom: 5px; text-align: left; position: relative; }
.plan-row.compact { display: flex; align-items: center; padding-right: 36px; }
.plan-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row-overview, .plan-row-meta, .muted { color: var(--text-muted); font-size: 12px; }
.plan-row-overview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row.done { opacity: .78; }
.pin-button { margin-left: auto; padding: 3px 6px; border: 0; background: transparent; }
.chip { padding: 1px 6px; border-radius: 999px; background: var(--attention-subtle); color: var(--attention-bright); font-size: 10px; text-transform: uppercase; }
.chip.archived { background: var(--bg-muted); color: var(--text-muted); }
.error { color: var(--text-danger, #d45b5b); font-size: 12px; }
.create-form { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-subtle); }
.create-form h2 { font-size: 14px; }
.completed-actions { display: flex; gap: 8px; padding: 12px 0; border-top: 1px solid var(--border-subtle); }
.plan-content { min-width: 0; display: flex; flex-direction: column; }
.document-status, .review-controls { padding: 12px 24px; border-bottom: 1px solid var(--border-subtle); color: var(--text-muted); font-size: 12px; }
.document-status button { margin-left: auto; }
.review-controls label { display: flex; align-items: center; gap: 6px; }
.plan-summary, .document-summary { padding: 24px; line-height: 1.55; }
.plan-summary h3 { margin: 22px 0 6px; font-size: 14px; }
.plan-summary ul { padding-left: 20px; }
.plan-summary li.complete { color: var(--success-fg, #5aba75); }
.note-form { display: flex; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--border-subtle); }
.note-form input { flex: 1; }
.empty-state { margin: auto; padding: 40px; color: var(--text-muted); text-align: center; }
.context-menu { position: fixed; z-index: 20; display: grid; min-width: 180px; padding: 5px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-subtle); box-shadow: 0 8px 30px rgb(0 0 0 / 25%); }
.context-menu button { border: 0; background: transparent; text-align: left; }
.overlay { position: fixed; inset: 0; z-index: 30; display: grid; place-items: start center; padding-top: 15vh; background: rgb(0 0 0 / 35%); }
.quick-open, .rename-dialog { display: grid; gap: 6px; width: min(520px, calc(100vw - 32px)); padding: 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); box-shadow: 0 14px 40px rgb(0 0 0 / 35%); }
.quick-open button { display: flex; justify-content: space-between; border: 0; text-align: left; }
.rename-dialog h2 { margin: 0 0 8px; font-size: 15px; }
@media (max-width: 900px) { .plans-layout, .plans-layout.is-collapsed { grid-template-columns: 260px minmax(0, 1fr); } .ai-sidebar { display: none; } }
</style>
