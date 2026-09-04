<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SafeAiCliPanel } from '@navide/plugin-ui'
import {
  preparePlanDocHtml,
  createSafeTodoClickHandler,
} from '@navide/plugin-ui/shared'
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
const { t, te } = useI18n()

function formatBackendError(cause: unknown): string {
  return backendErrorMessage(cause, { t, te })
}

const planDocFrame = ref<HTMLIFrameElement | null>(null)

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
const aiPanelOpen = ref(false)
const showCreateForm = ref(false)
const notesDrawerOpen = ref(false)
let stopTarget: (() => void) | null = null
let plansSubscription: ReturnType<typeof plansBackend.subscribe> | null = null
const aiCliController = createPlansAiCliController()

const selectedSummary = computed<PlanSummary | null>(() => {
  if (!selectedPath.value) return null
  return plans.value.find((p) => p.rel_path === selectedPath.value) ?? null
})

const selectedStage = computed(() => {
  if (selected.value?.meta?.stage) return selected.value.meta.stage
  if (selectedSummary.value) return planStage(selectedSummary.value)
  return null
})

const selectedProgress = computed(() => {
  if (selected.value?.meta?.todos) {
    const todos = selected.value.meta.todos
    return {
      done: todos.filter((t) => t.status === 'done').length,
      total: todos.length,
    }
  }
  if (selectedSummary.value) return planProgress(selectedSummary.value)
  return { done: 0, total: 0 }
})

const selectedProgressPercent = computed(() => {
  const { done, total } = selectedProgress.value
  if (total <= 0) return 0
  return Math.min(100, Math.round((done / total) * 100))
})

const currentDocumentToken = ref<string | null>(null)

const preparedDoc = computed(() => {
  if (!selected.value?.html) return null
  return preparePlanDocHtml(selected.value.html, {
    buildTrustedRuntimeScript: ({ documentToken }) => `(function() {
  document.addEventListener('click', function(e) {
    var li = e.target.closest('[data-todo-id]');
    if (li) {
      var todoId = li.getAttribute('data-todo-id');
      if (todoId) {
        window.parent.postMessage({ type: 'todo-clicked', todoId: todoId, documentToken: ${JSON.stringify(documentToken)} }, '*');
      }
    }
  });
})();`,
  })
})

watch(preparedDoc, (prepared) => {
  currentDocumentToken.value = prepared?.documentToken ?? null
}, { immediate: true })

const iframeSrcdoc = computed(() => preparedDoc.value?.html ?? '')

async function toggleDocTodo(todoId: string): Promise<void> {
  const doc = selected.value
  const targetPath = doc?.rel_path
  if (!doc || !targetPath) return
  const currentTodo = doc.meta?.todos?.find((t) => t.id === todoId)
  const nextStatus = currentTodo?.status === 'done' ? 'pending' : 'done'
  try {
    busy.value = true
    await plansBackend.call('plans.update_todo', {
      rel_path: targetPath,
      todo_id: todoId,
      status: nextStatus,
    })
    if (selectedPath.value === targetPath && selected.value?.rel_path === targetPath) {
      await readPlan(targetPath)
    }
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

const onWindowMessage = createSafeTodoClickHandler({
  getSourceWindow: () => planDocFrame.value?.contentWindow,
  getValidTodoIds: () => selected.value?.meta?.todos?.map((t) => t.id) ?? [],
  getDocumentToken: () => currentDocumentToken.value ?? '',
  onTodoClicked: (todoId) => {
    void toggleDocTodo(todoId)
  },
})

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

function progressRatio(plan: PlanSummary): number {
  const { done, total } = planProgress(plan)
  return total > 0 ? Math.round((done / total) * 100) : 0
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
      ? [{
          key: 'all',
          label: isLeftContribution() ? t('pane.plans.section-all') : t('pane.plans.v2.all-documents'),
          plans: activePlans.value,
        }]
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

let activeReadGeneration = 0

function applySelected(document: PlanDocument, relPath: string): void {
  selected.value = { ...document, rel_path: document.rel_path || relPath }
  selectedPath.value = relPath
  stage.value = (document.meta?.stage as PlanStage | undefined) ?? 'draft'
  selectedTodoId.value = document.meta?.todos[0]?.id ?? ''
  todoStatus.value = document.meta?.todos[0]?.status ?? 'pending'
}

async function readPlan(relPath: string): Promise<void> {
  const currentGeneration = ++activeReadGeneration
  selectedPath.value = relPath
  const document = await plansBackend.call('plans.read', { rel_path: relPath }) as unknown as PlanDocument
  if (currentGeneration !== activeReadGeneration || selectedPath.value !== relPath) {
    return
  }
  applySelected(document, relPath)
}

async function openInEditor(relPath: string): Promise<void> {
  noteOpened(relPath)
  try {
    const result = await callCapability('ui', 'openInEditor', { path: relPath }) as { opened?: boolean }
    if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

async function openPlan(relPath: string): Promise<void> {
  selectedPath.value = relPath
  if (isLeftContribution()) {
    noteOpened(relPath)
    try {
      const result = await callCapability('ui', 'openPlansWindow', { path: relPath }) as { opened?: boolean }
      if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
    } catch (cause) {
      toast(formatBackendError(cause), { type: 'error' })
    }
    return
  }
  try {
    await readPlan(relPath)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

async function refreshSelected(): Promise<void> {
  if (!selectedPath.value) return
  try {
    await readPlan(selectedPath.value)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

async function loadPlans(openSelected = true): Promise<void> {
  if (!workspacePath) {
    error.value = t('pane.plans.v2.workspace-required')
    return
  }
  const isFirstLoad = plans.value.length === 0
  loading.value = isFirstLoad
  error.value = ''
  try {
    const result = await plansBackend.call('plans.list', {}) as unknown as PlanSummary[]
    plans.value = Array.isArray(result) ? result : []
    if (openSelected && selectedPath.value && plans.value.some((plan) => plan.rel_path === selectedPath.value)) {
      if (!selected.value || selected.value.rel_path !== selectedPath.value) {
        await openPlan(selectedPath.value)
      }
    }
  } catch (cause) {
    error.value = formatBackendError(cause)
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
    toast(formatBackendError(cause), { type: 'error' })
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
  window.addEventListener('message', onWindowMessage)
  try {
    plansSubscription = plansBackend.subscribe('plans.changed', () => void loadPlans(false))
    void plansSubscription.ready.catch((cause: unknown) => toast(formatBackendError(cause), { type: 'error' }))
    void plansSubscription.settled.catch((cause: unknown) => {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined
      if (code !== 'USER_CANCELLED' && code !== 'PLUGIN_STOPPING') toast(formatBackendError(cause), { type: 'error' })
    })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
  const targetSubscription = plansViewRuntime.onOpenTarget(receiveTarget)
  stopTarget = () => targetSubscription.dispose()
  void Promise.all([loadPreferences(), loadPlans()])
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('click', closeContextMenu)
  window.removeEventListener('message', onWindowMessage)
  plansSubscription?.dispose()
  plansSubscription = null
  stopTarget?.()
  aiCliController.dispose()
})
</script>

<template>
  <div class="plans-surface" :class="{ 'plans-left-surface': isLeftContribution() }">
    <div class="plans-layout" :class="{ 'is-collapsed': sidebarCollapsed, 'is-left-contribution': isLeftContribution() }">
      <aside v-if="!sidebarCollapsed" class="plans-sidebar">
        <header class="plans-head">
          <div>
            <div class="plans-title">{{ t('pane.plans.title') }}</div>
          </div>
          <div class="plans-head-actions">
            <button
              v-if="!isLeftContribution()"
              class="plans-icon-btn"
              type="button"
              :title="t('pane.plans.v2.quick-open')"
              :aria-label="t('pane.plans.v2.quick-open')"
              @click="openQuickOpen"
            >⌘K</button>
            <button
              class="plans-icon-btn"
              type="button"
              :title="t('pane.plans.refresh')"
              :aria-label="t('pane.plans.refresh')"
              @click="void loadPlans(false)"
            >↻</button>
          </div>
        </header>

        <div class="sidebar-controls">
          <div class="plans-search">
            <input
              v-model="searchQuery"
              class="plans-search-input"
              type="search"
              :placeholder="t('pane.plans.search-placeholder')"
              :aria-label="t('pane.plans.search-placeholder')"
            />
            <button
              v-if="searchQuery"
              class="plans-search-clear"
              type="button"
              :title="t('pane.plans.search-clear')"
              :aria-label="t('pane.plans.search-clear')"
              @click="searchQuery = ''"
            >✕</button>
          </div>
          <div class="plans-toolbar-row">
            <select
              v-model="stageFilter"
              class="plans-select plans-stage-select"
              :title="t('pane.plans.filter-stage')"
              :aria-label="t('pane.plans.filter-stage')"
              @change="void persistPreference('plans.filter', stageFilter)"
            >
              <option value="all">{{ t('pane.plans.filter-all-stages') }}</option>
              <option v-for="value in PLAN_STAGES" :key="value" :value="value">{{ planStageLabel(value) }}</option>
            </select>
            <select
              v-model="sort"
              class="plans-select plans-sort-select"
              :title="t('pane.plans.sort-by')"
              :aria-label="t('pane.plans.sort-by')"
              @change="changeSort"
            >
              <option value="updated">{{ t('pane.plans.sort-updated') }}</option>
              <option value="title">{{ t('pane.plans.sort-title') }}</option>
              <option value="progress">{{ t('pane.plans.sort-progress') }}</option>
            </select>
            <button
              class="plans-toggle-btn plans-sort-dir"
              type="button"
              :title="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
              :aria-label="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
              @click="toggleSortDirection"
            >
              {{ sortDirection === 'asc' ? '↑' : '↓' }}
            </button>
            <button
              class="plans-toggle-btn plans-group-toggle"
              :class="{ 'plans-toggle-btn--on': groupMode === 'stage' }"
              type="button"
              :aria-pressed="groupMode === 'stage'"
              :title="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
              :aria-label="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
              @click="groupMode = groupMode === 'flat' ? 'stage' : 'flat'; void persistPreference('plans.group', groupMode)"
            >
              ☰
            </button>
          </div>
        </div>

        <div class="plans-sidebar-list">
          <p v-if="loading" class="muted plans-muted">{{ t('pane.plans.file-loading') }}</p>
          <p v-else-if="error" class="error plans-error">{{ error }}</p>
          <div v-else-if="searchQuery && !planGroups.length && !pinnedAndRecent.length && !archivedPlans.length" class="plans-empty">
            {{ t('pane.plans.search-no-results') }}
          </div>

          <section v-if="pinnedAndRecent.length" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection('recent')"
              @keydown.enter.prevent="toggleSection('recent')"
              @keydown.space.prevent="toggleSection('recent')"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('recent') }">▾</span>
                {{ t('pane.plans.section-recent') }}
              </span>
              <span>{{ pinnedAndRecent.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed('recent')">
              <div
                v-for="plan in pinnedAndRecent"
                :key="`recent:${plan.rel_path}`"
                class="plan-row plan-row--compact"
                :class="{ selected: selectedPath === plan.rel_path }"
                role="button"
                tabindex="0"
                @click="void openPlan(plan.rel_path)"
                @keydown.enter.prevent="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name">{{ planTitle(plan) }}</span>
                <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                  {{ planStageLabel(planStage(plan)) }}
                </span>
                <span v-else class="plan-chip">{{ t('pane.plans.v2.document') }}</span>
                <button
                  type="button"
                  class="plan-row-pin"
                  :class="{ 'plan-row-pin--on': isPinned(plan.rel_path) }"
                  :aria-pressed="isPinned(plan.rel_path)"
                  :title="isPinned(plan.rel_path) ? t('pane.plans.unpin') : t('pane.plans.pin')"
                  @click.stop="togglePin(plan.rel_path)"
                >
                  📌
                </button>
              </div>
            </template>
          </section>

          <section v-for="group in planGroups" :key="group.key" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection(group.key)"
              @keydown.enter.prevent="toggleSection(group.key)"
              @keydown.space.prevent="toggleSection(group.key)"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed(group.key) }">▾</span>
                {{ group.label }}
              </span>
              <span>{{ group.plans.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed(group.key)">
              <button
                v-for="plan in group.plans"
                :key="plan.rel_path"
                type="button"
                class="plan-row"
                :class="{ selected: selectedPath === plan.rel_path, 'plan-row--done': planStage(plan) === 'done' }"
                @click="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name">{{ planTitle(plan) }}</span>
                <span v-if="plan.meta?.overview || plan.overview" class="plan-row-overview">
                  {{ plan.meta?.overview || plan.overview }}
                </span>
                <span class="plan-row-path" :title="plan.rel_path">{{ plan.rel_path }}</span>
                <span class="plan-row-meta">
                  <span class="plan-row-progress">
                    <span class="plan-progress-bar" :class="`plan-progress-bar--${planStage(plan) ?? 'draft'}`">
                      <span class="plan-progress-fill" :style="{ width: `${progressRatio(plan)}%` }" />
                    </span>
                    <span>{{ t('pane.plans.progress-done', { done: planProgress(plan).done, total: planProgress(plan).total }) }}</span>
                  </span>
                  <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                    {{ planStageLabel(planStage(plan)) }}
                  </span>
                  <span v-else class="plan-chip">{{ t('pane.plans.v2.document') }}</span>
                  <span class="plan-row-type">
                    {{ isHtmlPath(plan.rel_path) ? t('pane.plans.v2.html') : t('pane.plans.v2.markdown') }}
                  </span>
                </span>
                <span
                  role="button"
                  tabindex="0"
                  class="plan-row-pin"
                  :class="{ 'plan-row-pin--on': isPinned(plan.rel_path) }"
                  :aria-pressed="isPinned(plan.rel_path)"
                  :title="isPinned(plan.rel_path) ? t('pane.plans.unpin') : t('pane.plans.pin')"
                  @click.stop="togglePin(plan.rel_path)"
                  @keydown.enter.stop.prevent="togglePin(plan.rel_path)"
                >
                  📌
                </span>
                <span
                  class="plan-row-delete"
                  role="button"
                  tabindex="0"
                  :title="t('action.delete')"
                  :aria-label="t('action.delete')"
                  @click.stop="void deletePath(plan.rel_path)"
                  @keydown.enter.stop.prevent="void deletePath(plan.rel_path)"
                >✕</span>
              </button>
            </template>
          </section>

          <section v-if="archivedPlans.length" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection('archived')"
              @keydown.enter.prevent="toggleSection('archived')"
              @keydown.space.prevent="toggleSection('archived')"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('archived') }">▾</span>
                {{ t('pane.plans.archived') }}
              </span>
              <span>{{ archivedPlans.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed('archived')">
              <button
                v-for="plan in archivedPlans"
                :key="plan.rel_path"
                type="button"
                class="plan-row plan-row--done"
                :class="{ selected: selectedPath === plan.rel_path }"
                @click="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name">{{ planTitle(plan) }}</span>
                <span v-if="plan.meta?.overview || plan.overview" class="plan-row-overview">
                  {{ plan.meta?.overview || plan.overview }}
                </span>
                <span class="plan-row-path" :title="plan.rel_path">{{ plan.rel_path }}</span>
                <span class="plan-row-meta">
                  <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                    {{ planStageLabel(planStage(plan)) }}
                  </span>
                  <span class="plan-chip archived">{{ t('pane.plans.archived') }}</span>
                </span>
                <span
                  class="plan-row-delete"
                  role="button"
                  tabindex="0"
                  :title="t('action.delete')"
                  :aria-label="t('action.delete')"
                  @click.stop="void deletePath(plan.rel_path)"
                  @keydown.enter.stop.prevent="void deletePath(plan.rel_path)"
                >✕</span>
              </button>
            </template>
          </section>

          <p v-if="!loading && !error && !planGroups.length && !archivedPlans.length" class="muted plans-muted">{{ t('pane.plans.v2.no-documents') }}</p>
          <section v-if="archivableDone.length || deletablePlans.length" class="completed-actions">
            <button type="button" :disabled="busy || !archivableDone.length" @click="void archiveAllDone()">{{ t('pane.plans.archive-all-done') }}</button>
            <button type="button" :disabled="busy || !deletablePlans.length" @click="void deleteCompleted()">{{ t('pane.plans.delete-all') }}</button>
          </section>
        </div>

        <div v-if="!isLeftContribution()" class="sidebar-create-section">
          <button type="button" class="sidebar-create-toggle" @click="showCreateForm = !showCreateForm">
            <span class="create-toggle-icon">{{ showCreateForm ? '▾' : '▸' }}</span>
            <span class="create-toggle-label">{{ t('pane.plans.v2.new-plan') }}</span>
          </button>
          <form v-show="showCreateForm" class="create-form" @submit.prevent="void createPlan()">
            <h2>{{ t('pane.plans.v2.new-plan') }}</h2>
            <input v-model="newName" required :placeholder="t('pane.plans.v2.plan-name')" />
            <input v-model="newOverview" :placeholder="t('pane.plans.v2.overview-placeholder')" />
            <textarea v-model="newTodos" rows="3" :placeholder="t('pane.plans.v2.todo-placeholder')" />
            <button type="submit" :disabled="busy">{{ t('action.create') }}</button>
          </form>
        </div>
      </aside>

      <main v-if="!isLeftContribution()" class="plan-content">
        <div v-if="selected" class="selected-document">
          <div class="content-toolbar">
            <div class="toolbar-left">
              <select
                v-if="selected.meta"
                v-model="stage"
                class="plan-chip-select"
                :class="`plan-chip-select--stage-${stage}`"
                @change="void updateStage()"
              >
                <option v-for="value in PLAN_STAGES" :key="value" :value="value">{{ planStageLabel(value) }}</option>
              </select>
              <span v-else-if="selectedStage" class="plan-chip" :class="`plan-chip--stage-${selectedStage}`">
                {{ planStageLabel(selectedStage) }}
              </span>
              <span class="plan-toolbar-progress">
                {{ t('pane.plans.progress-done', { done: selectedProgress.done, total: selectedProgress.total }) }}
              </span>
              <span class="plan-progress-bar" :class="`plan-progress-bar--${stage || selectedStage || 'draft'}`">
                <span class="plan-progress-fill" :style="{ width: `${selectedProgressPercent}%` }" />
              </span>
              <h2 class="document-title">{{ selected.meta?.name ?? selected.rel_path.split('/').pop() }}</h2>
            </div>
            <div class="toolbar-actions">
              <button type="button" :title="t('action.open-in-editor')" @click="void openInEditor(selectedPath)">{{ t('action.open-in-editor') }}</button>
              <button v-if="selected.meta" type="button" :title="selected.meta.archivedAt ? t('pane.plans.unarchive') : t('pane.plans.archive')" @click="void toggleArchive()">{{ selected.meta.archivedAt ? t('pane.plans.unarchive') : t('pane.plans.archive') }}</button>
              <button v-if="!selected.meta" type="button" :title="t('pane.plans.menu-upgrade')" @click="void promoteSelected()">{{ t('pane.plans.menu-upgrade') }}</button>
              <button v-if="isHtmlPath(selectedPath)" type="button" :title="t('action.rename')" @click="void renamePlan()">{{ t('action.rename') }}</button>
              <button type="button" class="danger" :title="t('action.delete')" @click="void deletePath(selectedPath)">{{ t('action.delete') }}</button>
              <button
                type="button"
                class="ai-toggle-btn"
                :class="{ 'ai-toggle-btn--active': aiPanelOpen }"
                title="AI CLI"
                @click="aiPanelOpen = !aiPanelOpen"
              >✦</button>
            </div>
          </div>

          <div class="plan-main-body">
            <!-- HTML preview iframe -->
            <div v-if="selected.html && isHtmlPath(selected.rel_path)" class="plan-preview-container">
              <iframe
                ref="planDocFrame"
                class="plan-doc-frame"
                sandbox="allow-scripts"
                :key="currentDocumentToken ?? selected?.rel_path ?? ''"
                :srcdoc="iframeSrcdoc"
              />
            </div>

            <!-- Plain document / fallback view -->
            <div v-else class="plan-fallback-container">
              <div class="document-status">
                <span>{{ selected.meta ? t('pane.plans.v2.plan-metadata') : t('pane.plans.v2.plain-document') }}</span>
                <button type="button" @click="void copyPath(selected.rel_path)">{{ t('action.copy-path') }}</button>
              </div>
              <article v-if="selected.meta" class="plan-summary">
                <p v-if="selected.meta.overview">{{ selected.meta.overview }}</p>
                <h3>{{ t('pane.plans.todos') }}</h3>
                <ul>
                  <li v-for="todo in selectedTodos" :key="todo.id" :class="{ complete: todo.status === 'done' }">
                    {{ todoStatusLabel(todo.status) }} — {{ todo.content }}
                  </li>
                  <li v-if="!selectedTodos.length" class="muted">{{ t('pane.plans.todos-empty') }}</li>
                </ul>
              </article>
              <div v-else class="document-summary">
                <p>{{ t('pane.plans.v2.promote-description') }}</p>
                <p class="muted">{{ t('pane.plans.v2.editor-description') }}</p>
              </div>
            </div>

            <!-- Collapsible Review Notes Drawer at bottom -->
            <div v-if="selected.meta" class="plan-notes-drawer" :class="{ 'is-open': notesDrawerOpen }">
              <div class="notes-drawer-bar" @click="notesDrawerOpen = !notesDrawerOpen">
                <span class="notes-drawer-title">
                  <span class="notes-chevron">{{ notesDrawerOpen ? '▾' : '▴' }}</span>
                  {{ t('pane.plans.review-notes') }}
                  <span class="notes-count">({{ selected.meta.reviewNotes?.length ?? 0 }})</span>
                </span>
              </div>
              <div v-show="notesDrawerOpen" class="notes-drawer-body">
                <article class="plan-summary">
                  <ul class="notes-list">
                    <li v-for="note in selected.meta.reviewNotes" :key="note.id" class="note-item">
                      <strong class="note-author">{{ note.author }}:</strong>
                      <span class="note-text">{{ note.text }}</span>
                    </li>
                    <li v-if="!selected.meta.reviewNotes?.length" class="muted">
                      {{ t('pane.plans.review-empty') }}
                    </li>
                  </ul>
                </article>
                <form class="note-form" @submit.prevent="void addNote()">
                  <input v-model="noteText" :placeholder="t('pane.plans.review-add-placeholder')" />
                  <button type="submit" :disabled="busy">{{ t('pane.plans.review-send') }}</button>
                </form>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <h2>{{ t('pane.plans.v2.empty-title') }}</h2>
          <p>{{ t('pane.plans.v2.empty-description') }}</p>
        </div>
      </main>

      <aside v-if="!isLeftContribution() && aiPanelOpen" class="ai-sidebar">
        <SafeAiCliPanel :controller="aiCliController" />
      </aside>
    </div>

    <div v-if="contextMenu" class="context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
      <button type="button" @click="void openInEditor(contextMenu.relPath); closeContextMenu()">{{ t('action.open-in-editor') }}</button>
      <button type="button" @click="void copyPath(contextMenu.relPath); closeContextMenu()">{{ t('action.copy-path') }}</button>
      <button type="button" @click="void openPlan(contextMenu.relPath); closeContextMenu()">{{ t('pane.plans.v2.select') }}</button>
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
.plans-surface {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  box-sizing: border-box;
}
.plans-surface.plans-left-surface {
  width: 100%;
  max-width: 100%;
  height: 100%;
}
.plans-head {
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 8px 12px;
  flex: 0 0 auto;
  box-sizing: border-box;
}
.plans-title {
  font-size: var(--font-xs, 12px);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.plans-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.plans-icon-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs, 12px);
  padding: 3px 7px;
}
.plans-icon-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

.plans-layout {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.plans-layout.is-left-contribution {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}
.plans-layout.is-left-contribution .plans-sidebar {
  border-right: 0;
  flex: 1 1 0;
  width: 100%;
  max-width: none;
  height: 100%;
  padding: 0;
  overflow: hidden;
}

.plans-sidebar {
  width: 300px;
  min-width: 260px;
  max-width: 340px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-base);
  overflow: hidden;
  padding: 0;
  box-sizing: border-box;
}
.plans-sidebar-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0;
}
.sidebar-controls {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 12px;
  display: grid;
  gap: 6px;
}
.plans-search { position: relative; }
.plans-search-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-sizing: border-box;
  color: var(--text-primary);
  font-size: var(--font-xs, 12px);
  padding: 4px 24px 4px 8px;
  width: 100%;
}
.plans-search-input:focus { border-color: var(--accent-focus, #388bfd); outline: none; }
.plans-search-clear {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  height: 18px;
  justify-content: center;
  padding: 0;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
}
.plans-search-clear:hover { color: var(--text-primary); }
.plans-toolbar-row { display: flex; gap: 6px; }
.plans-select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-secondary);
  flex: 1;
  font-size: var(--font-2xs, 11px);
  min-width: 0;
  padding: 3px 4px;
}
.plans-toggle-btn {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  flex: 0 0 auto;
  font-size: var(--font-2xs, 11px);
  line-height: 1;
  padding: 3px 7px;
}
.plans-toggle-btn:hover { color: var(--text-primary); }
.plans-toggle-btn--on { border-color: var(--accent-focus, #388bfd); color: var(--text-primary); }

.plans-section { padding: 8px 8px 4px; }
.plans-section-head {
  align-items: center;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  font-weight: 700;
  justify-content: space-between;
  letter-spacing: 0.05em;
  padding: 0 4px 6px;
  text-transform: uppercase;
  user-select: none;
}
.plans-section-title { align-items: center; display: flex; gap: 5px; }
.plans-section-chevron { display: inline-block; font-size: 9px; transition: transform 0.12s ease; margin-right: 2px; }
.plans-section-chevron.collapsed { transform: rotate(-90deg); }
.plan-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  box-sizing: border-box;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  position: relative;
  text-align: left;
  width: 100%;
}
.plan-row:hover { background: var(--bg-hover); border-color: var(--border-subtle); }
.plan-row.selected { background: var(--bg-hover); border-color: var(--border-subtle); }
.plan-row--done { opacity: .78; }
.plan-row-name { font-size: var(--font-xs, 12px); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row-overview {
  color: var(--text-muted);
  font-size: var(--font-2xs, 11px);
  line-height: 1.35;
  max-height: 2.7em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.plan-row-path {
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-3xs, 10px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-2xs, 11px);
  color: var(--text-muted);
  flex-wrap: wrap;
  margin-top: 2px;
}
.plan-row-progress { display: inline-flex; align-items: center; gap: 6px; }
.plan-progress-bar {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 999px;
  height: 4px;
  overflow: hidden;
  width: 48px;
  display: inline-block;
  vertical-align: middle;
}
.plan-progress-fill {
  background: var(--accent-color, #f0883e);
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.15s ease;
}
.plan-progress-bar--draft > .plan-progress-fill { background: var(--text-muted); }
.plan-progress-bar--in-review > .plan-progress-fill { background: #e3b341; }
.plan-progress-bar--approved > .plan-progress-fill { background: #58a6ff; }
.plan-progress-bar--in-progress > .plan-progress-fill { background: #f0883e; }
.plan-progress-bar--done > .plan-progress-fill { background: #3fb950; }
.plan-progress-bar--abandoned > .plan-progress-fill { background: #8b949e; }
.plan-chip {
  border-radius: 4px;
  font-size: var(--font-3xs, 10px);
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  text-transform: uppercase;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.plan-chip--stage-draft { background: rgba(139, 148, 158, 0.2); color: #8b949e; }
.plan-chip--stage-in-review { background: rgba(227, 179, 65, 0.2); color: #e3b341; }
.plan-chip--stage-approved { background: rgba(88, 166, 255, 0.2); color: #58a6ff; }
.plan-chip--stage-in-progress { background: rgba(240, 136, 62, 0.2); color: #f0883e; }
.plan-chip--stage-done { background: rgba(63, 185, 80, 0.2); color: #3fb950; }
.plan-chip--stage-abandoned { background: rgba(139, 148, 158, 0.15); color: #6e7681; }
.plan-chip.archived { background: var(--bg-muted); color: var(--text-muted); }

.plan-row-delete {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-xs, 12px);
  height: 20px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 6px;
  width: 20px;
}
.plan-row:hover .plan-row-delete,
.plan-row:focus-within .plan-row-delete {
  opacity: 1;
}
.plan-row-delete:hover { background: var(--bg-hover-strong); color: var(--danger-fg, #f85149); }
.plan-row--compact { align-items: center; display: flex; gap: 8px; padding-right: 28px; }
.plan-row--compact .plan-row-name { flex: 1; min-width: 0; }
.plan-row-pin {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  height: 20px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
}
.plan-row-pin--on, .plan-row:hover .plan-row-pin { opacity: 1; }
.plans-muted, .plans-error, .plans-empty { color: var(--text-muted); padding: 12px; font-size: var(--font-xs, 12px); }
.plans-error { color: var(--text-danger, #d45b5b); }
.completed-actions { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border-subtle); }

.sidebar-create-section {
  flex: 0 0 auto;
  border-top: 1px solid var(--border-subtle);
  padding: 8px 12px;
  background: var(--bg-base);
}
.sidebar-create-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: 1px dashed var(--border-subtle);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: var(--font-2xs, 11px);
  padding: 4px 8px;
  cursor: pointer;
  text-align: left;
}
.sidebar-create-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.sidebar-create-section .create-form {
  margin-top: 8px;
  display: grid;
  gap: 6px;
}
.sidebar-create-section .create-form h2 {
  margin: 0;
  font-size: var(--font-xs, 12px);
  color: var(--text-secondary);
}
.sidebar-create-section .create-form input,
.sidebar-create-section .create-form textarea {
  font-size: var(--font-2xs, 11px);
  padding: 4px 6px;
  width: 100%;
  box-sizing: border-box;
}
.sidebar-create-section .create-form button {
  font-size: var(--font-2xs, 11px);
  padding: 4px 8px;
}

.plan-content {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}
.selected-document {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}
.content-toolbar {
  flex: 0 0 auto;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  box-sizing: border-box;
}
.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
}
.document-title {
  font-size: var(--font-xs, 12px);
  font-weight: 600;
  margin: 0 0 0 4px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-toolbar-progress {
  font-size: var(--font-2xs, 11px);
  color: var(--text-muted);
  white-space: nowrap;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.toolbar-actions button {
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs, 11px);
  padding: 3px 8px;
  cursor: pointer;
  line-height: 1.2;
}
.toolbar-actions button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.toolbar-actions button.danger {
  color: var(--text-danger, #d45b5b);
}
.toolbar-actions button.danger:hover {
  background: rgba(212, 91, 91, 0.15);
  border-color: rgba(212, 91, 91, 0.3);
}
.ai-toggle-btn {
  background: transparent !important;
  border: 1px solid var(--border-subtle) !important;
  border-radius: 4px;
  color: var(--accent-color, #58a6ff) !important;
  font-size: 13px !important;
  padding: 2px 7px !important;
  cursor: pointer;
  line-height: 1.2 !important;
}
.ai-toggle-btn:hover, .ai-toggle-btn--active {
  background: rgba(88, 166, 255, 0.15) !important;
  border-color: var(--accent-color, #58a6ff) !important;
  color: #fff !important;
}

.plan-chip-select {
  appearance: none;
  -webkit-appearance: none;
  border-radius: 4px;
  font-size: var(--font-3xs, 10px);
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  text-transform: uppercase;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
}
.plan-chip-select--stage-draft { background: rgba(139, 148, 158, 0.2); color: #8b949e; border-color: rgba(139, 148, 158, 0.3); }
.plan-chip-select--stage-in-review { background: rgba(227, 179, 65, 0.2); color: #e3b341; border-color: rgba(227, 179, 65, 0.3); }
.plan-chip-select--stage-approved { background: rgba(88, 166, 255, 0.2); color: #58a6ff; border-color: rgba(88, 166, 255, 0.3); }
.plan-chip-select--stage-in-progress { background: rgba(240, 136, 62, 0.2); color: #f0883e; border-color: rgba(240, 136, 62, 0.3); }
.plan-chip-select--stage-done { background: rgba(63, 185, 80, 0.2); color: #3fb950; border-color: rgba(63, 185, 80, 0.3); }
.plan-chip-select--stage-abandoned { background: rgba(139, 148, 158, 0.15); color: #6e7681; border-color: rgba(139, 148, 158, 0.2); }

.plan-main-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.plan-preview-container {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  position: relative;
  overflow: hidden;
  background: var(--bg-base);
}
.plan-doc-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  background: #fff;
}
.plan-fallback-container {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.plan-notes-drawer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-subtle);
  display: flex;
  flex-direction: column;
  max-height: 40%;
}
.notes-drawer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  cursor: pointer;
  user-select: none;
  font-size: var(--font-2xs, 11px);
  color: var(--text-muted);
}
.notes-drawer-bar:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.notes-drawer-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}
.notes-chevron {
  font-size: 9px;
}
.notes-drawer-body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 8px 16px;
  border-top: 1px solid var(--border-subtle);
}
.notes-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.note-item {
  font-size: var(--font-2xs, 11px);
  display: flex;
  gap: 6px;
}
.note-author {
  color: var(--text-secondary);
}
.note-text {
  color: var(--text-primary);
}

.document-status {
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.plan-summary, .document-summary { padding: 24px; line-height: 1.55; }
.plan-summary h3 { margin: 22px 0 6px; font-size: 14px; }
.plan-summary ul { padding-left: 20px; }
.plan-summary li.complete { color: var(--success-fg, #5aba75); }
.note-form { display: flex; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border-subtle); margin-top: 8px; }
.note-form input { flex: 1; font-size: var(--font-2xs, 11px); }
.note-form button { font-size: var(--font-2xs, 11px); }

.empty-state { margin: auto; padding: 40px; color: var(--text-muted); text-align: center; }

.ai-sidebar {
  flex: 0 0 auto;
  width: 360px;
  height: 100%;
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  background: var(--bg-base);
  box-sizing: border-box;
}

button, input, select, textarea {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-subtle);
  color: inherit;
  padding: 6px 8px;
  font: inherit;
}
button { cursor: pointer; }
button:hover, .quick-open button.active { background: var(--bg-hover); }

.context-menu { position: fixed; z-index: 20; display: grid; min-width: 180px; padding: 5px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-subtle); box-shadow: 0 8px 30px rgb(0 0 0 / 25%); }
.context-menu button { border: 0; background: transparent; text-align: left; }
.overlay { position: fixed; inset: 0; z-index: 30; display: grid; place-items: start center; padding-top: 15vh; background: rgb(0 0 0 / 35%); }
.quick-open, .rename-dialog { display: grid; gap: 6px; width: min(520px, calc(100vw - 32px)); padding: 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); box-shadow: 0 14px 40px rgb(0 0 0 / 35%); }
.quick-open button { display: flex; justify-content: space-between; border: 0; text-align: left; }
.rename-dialog h2 { margin: 0 0 8px; font-size: 15px; }

@media (max-width: 900px) {
  .plans-sidebar { width: 240px; min-width: 200px; }
  .ai-sidebar { width: 280px; }
}
</style>
