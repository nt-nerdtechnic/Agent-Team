<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onUnmounted, ref, watch } from 'vue'
import type { PaneArgContext } from '@navide/plugin-shell'
import { extractDropPaths, stabilizeDroppedPaths } from '../lib/drop'
import { PANE_BATCH_MIME } from '@navide/terminal'
import { resolveDragBatch } from '../lib/paneBatchDrag'
import { setBatchDragImage } from '../lib/batchDragImage'
import { paneStatusLabelText, type PaneStatusValue } from '../lib/paneStatusLabel'
import { rollupPaneStatus } from '../lib/paneStatusRollup'
import { statusBadgeStyle } from '../composables/useStatusBadgePrefs'
import { rollupTabStatus, runGroupStateLabelKey } from '../lib/tabStatus'
import {
  ALL_RAIL_ID,
  assignToRail,
  buildRailCells,
  createRail,
  deleteRail,
  filterRowsByRail,
  nextRailColor,
  parseRails,
  railIdOf,
  RAIL_PALETTE,
  renameRail,
  serializeRails,
  setRailColor,
  type RailCell,
  type WorkspaceRail,
} from '../lib/workspaceRails'
import type { TabRunState } from '../lib/tabStatus'
import RebuildIcon from './RebuildIcon.vue'
import AddPaneIcon from './AddPaneIcon.vue'
import HistoryIcon from './HistoryIcon.vue'
import FolderIcon from './FolderIcon.vue'
import ExplorerPane from './ExplorerPane.vue'
import GitPluginHostSlot from './GitPluginHostSlot.vue'
import PluginRegionHost, { type PluginRegionContribution } from './PluginRegionHost.vue'
import { readLegacyPlansPreferenceProjection } from '../editor/plansPreferences'
import type { BackendStatus, useBackend } from '../composables/useBackend'
import type { DisplayStatus } from '@navide/terminal'
import type { Role, RoleKey } from '../data/roles'
import type { Stage, StageId } from '../data/stages'
import type { Issue, IssueDetail, IssueProvider, IssueHandlerMode } from '../composables/useIssues'
import { onSettingsChanged, registerCommand, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { useUpdater } from '../composables/useUpdater'
import { i18n } from '@navide/plugin-ui/foundation'
import { useNotify } from '@navide/plugin-ui/foundation'

// The legacy pane is a recovery adapter only. Normal Plans composition is the
// Manifest v2 contribution below, so one active package version owns both
// left and window surfaces.
const PlanPane = defineAsyncComponent(() => import('../editor/PlanPane.vue'))

// Re-exported from the canonical per-vendor specs — this was a hand-kept
// structural mirror before stage 2 of the one-file-per-vendor refactor.
import type { AgentSpec } from '@navide/plugin-shell'
export type { AgentSpec } from '@navide/plugin-shell'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

/** CLIs YOLO mode actually affects: the ones declaring a bypass flag. Derived,
 *  because the hand-written hint here listed three while eight qualified. */
const yoloVendors = CLI_AGENT_SPECS
  .filter((s) => s.skipPermissionFlag)
  .map((s) => s.agentKey)
  .join(' / ')

// The three small state machines a pane runs through while it is being made
// ready. Declared here, next to the view they travel in, and imported by
// App.vue (which owns the pane model) rather than restated there — they used
// to be written out twice, inline in ActivePaneView and again as aliases in
// App.vue, with nothing tying the two copies together.
/** Whether the pane's role prompt has been handed to the CLI yet. */
export type InjectionStatus = 'pending' | 'scheduled' | 'sent' | 'failed' | 'skipped'
/** Whether the pipeline's opening instruction has been sent. */
//: 'unverified' is a real outcome, not a shade of 'sent': the bytes were written
//: and the echo check passed, but only on buffer growth — which a CLI painting
//: its first screen satisfies whatever happened to our text. Reporting that as
//: 'sent' is what let a spawned pane sit idle with an empty prompt while its
//: caller believed the task had been delivered.
export type KickoffStatus = 'none' | 'pending' | 'sent' | 'unverified' | 'failed'
/** How far the spawn-to-ready sequence has got; shown in the pane subtitle. */
export type PreparationStatus =
  | 'starting'
  | 'checking-dialog'
  | 'settling'
  | 'injecting-role'
  | 'waiting-agent'
  | 'ready'
  | 'failed'

/** One row of the lineage tree, in display order.
 *
 *  Built in App (paneLineage) from pane ids alone so it does not rebuild with
 *  every 400ms status sync. The list renders these rows and looks the matching
 *  ActivePaneView up for status — structure and status stay separate. */
export interface PaneLineageRow {
  id: string
  depth: number
  hasChildren: boolean
  collapsed: boolean
  /** The panes this one hangs under, outermost first; empty for a root. Ids,
   *  not names — the row is structure, and the name lives on ActivePaneView. */
  ancestors: readonly string[]
  /** How many panes descend from this one, at any depth, counted even when
   *  they are folded away — a folded row shows this instead of its children. */
  descendantCount: number
}

/** One workspace section of the sidebar — one this window holds, with real
 *  panes, live status, lineage and every per-pane control.
 *
 *  `isCurrent` is true for all of them now. It used to separate these from
 *  read-only rows describing what OTHER windows were running; those are gone,
 *  because a window is its own space. The field stays as the answer to "does
 *  this window have terminals for these panes", which is what the consumers
 *  actually ask. */
export interface WorkspaceGroupRow {
  path: string
  label: string
  /** Same path with the home directory collapsed to `~`. Shown under the name
   *  because two projects can share a folder name — the path is what tells
   *  them apart. */
  displayPath: string
  isCurrent: boolean
  collapsed: boolean
  count: number
  /** The ids `count` counted, including panes a folded subtree is hiding. The
   *  count badge is painted with the rolled-up status of this set, so its
   *  colour describes the same panes the number does. */
  paneIds: string[]
  lineage: PaneLineageRow[]
  /** The same rows, split into run groups. */
  groups: { id: string; name: string; rows: PaneLineageRow[] }[]
}

export interface ActivePaneView {
  id: string
  agentKey: string
  agentLabel: string
  /** agentLabel is the auto-derived title, not a name the user chose. The lists
   *  mark it with a ◦ so an unchosen name is recognisable without hovering. */
  autoNamed?: boolean
  roleKey: RoleKey
  roleLabel: string
  stageId: StageId
  command: string
  /** The pane's badge status, copied from its terminal's displayStatus, plus
   *  'waiting' for a cold-restore placeholder that has no terminal yet. Typed
   *  rather than `string` so the value survives the trip from useTerminal to
   *  the sidebar and the agent-overview rows — it used to widen here, which is
   *  why the consumer had to cast it back. */
  status: DisplayStatus | 'waiting'
  error?: string
  injectionStatus: InjectionStatus
  preparationStatus?: PreparationStatus
  kickoffStatus?: KickoffStatus
  origin: 'manual' | 'pipeline' | 'mcp'
  /** Pane id of the parent that spawned this pane; absent for roots. Copied
   *  verbatim — the tree itself is built in App's paneLineage, which is the
   *  structure layer this view model must not duplicate. */
  spawnedBy?: string
  /** True when this pane's lineage subtree is folded in the lists. */
  collapsed?: boolean
  /** True when this pane corresponds to a slot marked is_commander=true in
   *  the stage config — shown as 🎯 指揮官 badge in the active-agents list
   *  and the pane header. */
  isCommander?: boolean
  /** CLI session id for resume. Claude: pinned at launch; Codex/Antigravity: filled
   *  once detected from the session file. Shown so the user can confirm capture. */
  sessionId?: string
  /** Human-readable slot label (e.g. "Architecture"). Empty for single-agent
   *  stages or manually-spawned panes. Used as stable by_pane key. */
  slotLabel?: string
  /** True when the pane is minimized to the sidebar (hidden in grid, PTY alive). */
  isMinimized?: boolean
  /** True while the pane's loop is active — shown as an ∞ badge next to status. */
  loopActive?: boolean
  /** Epoch ms of the scheduled loop auto-resume; null/undefined when not waiting. */
  loopWaitUntil?: number | null
  /** True when the pane's agent is resume-capable — RENDERS the rebuild control
   *  (disabled until canRebuild), matching the in-pane button's discoverability. */
  rebuildVisible?: boolean
  /** Uses App's canonical resume eligibility check — ENABLES the control. The
   *  sidebar only renders a rebuild control; App remains the sole owner of the
   *  rebuild operation. */
  canRebuild?: boolean
  /** True while App has a rebuild in flight for this pane's session — disables
   *  the rebuild control so a double-click cannot start a second kill/spawn. */
  rebuilding?: boolean
}

export interface SpawnPayload {
  agentKey: string
  roleKey: RoleKey
  stageId: StageId
  workspacePath: string
  customName?: string
  /** Run group to open the pane in. Set only by the sidebar's per-group ＋,
   *  which knows which group the user is pointing at; every other entry point
   *  leaves it unset and the pane lands in the group the active tab names. */
  runGroupId?: string
  /** CLI account profile id for an isolated LOGIN pane (Settings → CLI
   *  accounts). Only set by that flow — never by the control pane itself. */
  loginProfileId?: string
  /** True for a LOGIN pane (Settings → CLI accounts sign-in, with or without
   *  loginProfileId). Suppresses the session-marker bootstrap — the pane sits
   *  at an interactive sign-in wizard, so nothing may inject input into it.
   *  Only set by that flow — never by the control pane itself. */
  isLogin?: boolean
}

export interface ResumePayload {
  agentKey: string
  sessionId: string
  workspacePath: string
  customName?: string
}

/** Slim view of App's SpawnHistoryEntry — just what the resume datalist needs. */
export interface ResumeHistoryEntry {
  agentKey: string
  agentLabel: string
  customName?: string
  roleLabel: string
  sessionId?: string
  workspacePath: string
  /** Absent on records whose spawn time was never captured (see
   *  SpawnHistoryEntry); the option label then just omits the date. */
  spawnedAt?: string
}

export interface PipelineSummary {
  id: string
  name: string
  builtin: boolean
  stage_count: number
}

export type PipelineState = 'idle' | 'running' | 'completed' | 'aborted'

/** Entry mode detected from the opened workspace (see App.detectMode). */
export type WorkspaceMode = 'pipeline' | 'spawn' | 'completed'

export interface PipelineStatusView {
  state: PipelineState
  stageIndex: number // 0..5; only meaningful when running
  totalStages: number
  task: string
  workspacePath: string
  log: string[] // tiny human-readable log of major transitions
  projectId: string
  projectFile: string
  pipelineLogFile: string
  backendLogFile: string
}

export interface ExistingProjectInfo {
  projectId: string
  name: string
  state: 'idle' | 'running' | 'completed' | 'aborted'
  taskDescription: string
  currentStageIndex: number
  totalStages: number
  stagesCompleted: number
  nextStageIndex: number // -1 if all done
  updatedAt: string
  projectFile: string
  pipelineId: string
  runCount: number
}

export interface AnalyzerModelOption {
  name: string
  parameter_size: string
  size: number
}

export interface BenchmarkModelResult {
  name: string
  score: number
  passed: boolean
}

export interface AnalyzerStatusView {
  available: boolean
  version: string
  defaultModel: string
  models: AnalyzerModelOption[]
  benchmarkResults: BenchmarkModelResult[]
}

interface Props {
  backendStatus: BackendStatus
  backendUrl: string
  agentSpecs: AgentSpec[]
  roles: Role[]
  stages: Stage[]
  panes: ActivePaneView[]
  pipeline: PipelineStatusView
  yoloEnabled: boolean
  analyzerModel: string
  analyzerStatus: AnalyzerStatusView
  autoAnswerEnabled: boolean
  existingProject: ExistingProjectInfo | null
  /** Workspace chosen on the Welcome screen; seeds the input on entry. */
  workspace?: string
  /** Entry mode; drives which sections lead (spawn → manual spawn open). */
  mode?: WorkspaceMode
  /** All pipeline summaries from usePipelines. */
  pipelines?: PipelineSummary[]
  /** Currently active pipeline id (global). */
  activePipelineId?: string
  /** Full backend instance — forwarded to GitPane for git operations. */
  backend?: ReturnType<typeof useBackend>
  /** Past spawns (incl. backend-backfilled manual panes) for the resume datalist. */
  spawnHistory?: ResumeHistoryEntry[]
  /** The currently focused pane id — highlights the matching agent-item. */
  focusPaneId?: string
  /** Panes in the App-owned multi-select set — highlights the matching rows. */
  selectedPaneIds?: Set<string>
  /** Mirrors StageTabBar's global rebuild state so both controls invoke the
   *  same App-owned operation and present the same availability. */
  canRebuildAll?: boolean
  /** Rebuildable pane counts keyed by workspace path (trailing slashes
   *  trimmed). Each workspace heading's ↻ enables on its OWN workspace;
   *  canRebuildAll above answers for the one on screen, which is what the
   *  toolbar's copy of the button means. */
  rebuildableByWorkspace?: Record<string, number>
  rebuildingAll?: boolean
  /** Issue dispatch/handle status — forwarded to GitPane for badges. */
  issueHandoffs?: Record<string, { paneId: string; mode: string; state: string }>
  /** Manifest-driven contributions available to this Host window. */
  pluginContributions?: PluginRegionContribution[]
  /** Main-process-only legacy Git recovery mode. */
  legacyGitRecovery?: boolean
  /** Main-process-only legacy Plans recovery mode. */
  legacyPlansRecovery?: boolean
  /** Change count published by the legacy Git recovery contribution. */
  gitChangesCount?: number
  /** Left slot collapsed — swaps the panel body for a narrow icon rail.
   *  Unrelated to a pane's own collapsed flag (see `lineage`). */
  collapsed?: boolean
  /** Lineage rows in display order, from App's structure-layer computed.
   *  Omitted or empty renders the flat list unchanged, so every other consumer
   *  of this component keeps working. */
  lineage?: PaneLineageRow[]
  /** Workspace sections, this window's first. Omitted renders the flat list —
   *  which is what every other mount of this component gets. */
  workspaces?: WorkspaceGroupRow[]
  /** True in a detached window: it is one run group's view of ONE workspace,
   *  so it neither opens others nor switches between them — the controls are
   *  hidden rather than left to do nothing.
   *
   *  Phrased as the exception because Vue casts an absent boolean prop to
   *  false, which would have made the permissive spelling deny by default. */
  detachedWindow?: boolean
  /** View ids assigned to this slot, in tab order. Omitted means "all of
   *  them" — the layout store supplies the real list. A view moved to another
   *  slot disappears from here, which is what keeps it a singleton. */
  views?: string[]
}

const props = defineProps<Props>()

/** Panes in tree order, each paired with its depth.
 *
 *  Joins the structure layer (`lineage`, rebuilt only when the tree actually
 *  changes) with the status layer (`panes`, replaced every 400ms). Without a
 *  `lineage` prop this degrades to the previous flat list, so the other
 *  mounts of this component are unaffected.
 *
 *  Rows whose pane is missing are skipped rather than rendered blank: the two
 *  props are updated in the same tick but arrive as separate reactive writes,
 *  so a frame can see one before the other. */
const orderedPanes = computed(() => {
  const rows = props.lineage
  if (!rows?.length) {
    return props.panes.map((pane) => ({ pane, depth: 0, hasChildren: false, collapsed: false }))
  }
  const byId = new Map(props.panes.map((p) => [p.id, p]))
  const out: { pane: ActivePaneView; depth: number; hasChildren: boolean; collapsed: boolean }[] = []
  for (const r of rows) {
    const pane = byId.get(r.id)
    if (pane) out.push({ pane, depth: r.depth, hasChildren: r.hasChildren, collapsed: r.collapsed })
  }
  return out
})

/** The workspaces this window runs panes in — the one it was opened with plus
 *  any adopted from the picker. A single `null` entry stands for the ungrouped
 *  list: no heading, every pane under it, which is what this looked like
 *  before workspaces were a layer at all. */
const localWorkspaceRows = computed<(WorkspaceGroupRow | null)[]>(() => {
  const rows = props.workspaces?.filter((w) => w.isCurrent) ?? []
  return rows.length ? rows : [null]
})

/** Whether the list has real workspace headings to draw. When it does the list
 *  must render even with no panes at all: the headings carry the only ＋ that
 *  opens an agent, so replacing them with an empty message leaves the sidebar
 *  with no way back in. */
const hasWorkspaceRows = computed(() => localWorkspaceRows.value.some((w) => w))

/* ── Workspace rails ─────────────────────────────────────────────────────
 *
 *  A strip of one-glyph cells down the sidebar's left edge, one per group of
 *  workspaces plus a fixed All. Picking a cell filters the list below it, so
 *  the list's height tracks the biggest group rather than the project count.
 *
 *  Switching rails deliberately moves NOTHING: the workspace on screen, its
 *  panes and the terminal all stay where they are. The strip is a viewfinder
 *  over the list, not a project switcher — which is why the rail holding the
 *  current workspace keeps a dot even while you look at another.
 *
 *  TWO LAYERS, TWO LIFETIMES — the split is the point:
 *
 *  - WHICH GROUPS EXIST is a property of the projects, so it goes through
 *    `settings*` into the global navide.db (kv → `ui_settings`). It outlives
 *    the window and every window sees the same set.
 *  - WHICH GROUP YOU ARE LOOKING AT is a property of this view, so it stays in
 *    sessionStorage. Sharing it would make one window jump when another
 *    switched, and a restart is better off showing the whole list than a
 *    filtered subset nobody remembers choosing.
 *
 *  This mirrors what the sidebar already does one level down: run groups are
 *  persisted per project, while `collapsedWorkspaces` is not persisted at all.
 */
const RAILS_KEY = 'agentTeam.workspaceRails'
const ACTIVE_RAIL_KEY = 'agentTeam.activeWorkspaceRail'

/** Rails as stored: the serialized list, or '' when nothing is stored yet. */
function storedRails(): string {
  return settingsGet<string>(RAILS_KEY, '')
}

function readViewState(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function writeViewState(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* sessionStorage unavailable — the chosen rail just won't survive a reload */
  }
}

/** Seeded synchronously from the settings cache, which the window fills from
 *  its bootstrap snapshot before first paint — so the rails are already right
 *  on the first render rather than appearing a beat later. The authoritative
 *  value arrives on connect-time reconcile and lands through the subscription
 *  below, which is also what makes a first run (no snapshot) fill in. */
const workspaceRails = ref<WorkspaceRail[]>(parseRails(storedRails()))
const activeRailId = ref<string>(readViewState(ACTIVE_RAIL_KEY) ?? ALL_RAIL_ID)

watch(
  workspaceRails,
  (rails) => {
    const next = serializeRails(rails)
    // A list that arrived FROM settings must not be written straight back:
    // the value is already stored, and echoing it would have two windows
    // ping-pong the same list between them.
    if (next === storedRails()) return
    settingsSet(RAILS_KEY, next)
  },
  { deep: true }
)
watch(activeRailId, (id) => writeViewState(ACTIVE_RAIL_KEY, id))

/** Another window regrouped, or the connect-time reconcile brought the stored
 *  list in. Either way this window's strip follows. */
const stopRailSync = onSettingsChanged((keys) => {
  if (!keys.includes(RAILS_KEY)) return
  const incoming = storedRails()
  if (incoming === serializeRails(workspaceRails.value)) return
  workspaceRails.value = parseRails(incoming)
})
onUnmounted(stopRailSync)

/** The real headings, without the `null` that stands for the ungrouped list. */
const railRows = computed<WorkspaceGroupRow[]>(() =>
  localWorkspaceRows.value.filter((w): w is WorkspaceGroupRow => !!w)
)

/** Whether the strip is worth its 46px.
 *
 *  Hidden in a detached window, which is one workspace by definition. With no
 *  rails yet it still renders, but as a lone ＋ — the only entry point to
 *  making the first group, and dead weight if it were a full strip of one. */
const showRail = computed(() => !props.detachedWindow && hasWorkspaceRows.value)

const railCells = computed<RailCell[]>(() =>
  buildRailCells({
    rails: workspaceRails.value,
    rows: railRows.value,
    currentPath: workspacePath.value,
    activeId: activeRailId.value,
    allLabel: i18n.global.t('label.all-workspaces'),
  })
)

/** The headings actually drawn. Falls through to the unfiltered list whenever
 *  the strip is not shown, so nothing about the sidebar changes for a window
 *  that never makes a rail. */
const visibleWorkspaceRows = computed<(WorkspaceGroupRow | null)[]>(() =>
  showRail.value
    ? filterRowsByRail(railRows.value, workspaceRails.value, activeRailId.value)
    : localWorkspaceRows.value
)

/** The current rail's name, for the section heading. Empty on All, where the
 *  heading keeps saying "Workspace". */
const activeRailName = computed(
  () => railCells.value.find((c) => c.active && c.id !== ALL_RAIL_ID)?.name ?? ''
)

function selectRail(id: string): void {
  activeRailId.value = id
}

/** Which rail a workspace sits in, for the ticks in its context menu. */
function railIdForPath(path: string): string {
  return railIdOf(workspaceRails.value, path)
}

function assignWorkspaceToRail(path: string, railId: string): void {
  workspaceRails.value = assignToRail(workspaceRails.value, path, railId)
  closeWsMenu()
}

/* Naming a rail.
 *
 *  A real dialog, and `position: fixed` — the same call `.ws-ctx-menu` makes
 *  and for the same reason. The first version was an inline field positioned
 *  `absolute` inside the strip: it was created correctly and was never once
 *  visible, because the pane list scrolls under `overflow-y: auto` (which
 *  clips it) and the status bar sits at z-index 200 (which covers it).
 *  Clicking ＋ therefore looked like a dead button.
 *
 *  Not `window.prompt` either — that blocks the whole renderer in Electron,
 *  terminals included — and a prompt could not offer the colour, which on an
 *  8px bar is the group's only label and so has to be the user's choice. */
const railDialog = ref<{
  mode: 'create' | 'rename'
  id: string
  text: string
  color: number
  x: number
  y: number
} | null>(null)

/** Roughly what the dialog occupies, for the same edge flip the menus do. */
const RAIL_DLG_H = 168
const RAIL_DLG_W = 232

function railDialogAt(ev: MouseEvent | undefined): { x: number; y: number } {
  // Anchored to the pointer when there is one, top-left of the sidebar when
  // the caller had no event (keyboard activation).
  const cx = ev?.clientX ?? 60
  const cy = ev?.clientY ?? 80
  return {
    x: Math.max(8, Math.min(cx, window.innerWidth - RAIL_DLG_W - 8)),
    y: Math.max(8, Math.min(cy, window.innerHeight - RAIL_DLG_H - 8)),
  }
}

function startCreateRail(ev?: MouseEvent): void {
  railMenu.value = null
  railDialog.value = {
    mode: 'create',
    id: '',
    text: '',
    color: nextRailColor(workspaceRails.value),
    ...railDialogAt(ev),
  }
}
function startRenameRail(id: string, ev?: MouseEvent): void {
  const rail = workspaceRails.value.find((r) => r.id === id)
  const at = railMenu.value ? { x: railMenu.value.x, y: railMenu.value.y } : railDialogAt(ev)
  railMenu.value = null
  if (!rail) return
  railDialog.value = {
    mode: 'rename',
    id,
    text: rail.name,
    color: rail.color ?? 0,
    x: Math.min(at.x, window.innerWidth - RAIL_DLG_W - 8),
    y: Math.min(at.y, window.innerHeight - RAIL_DLG_H - 8),
  }
}
function commitRailInput(): void {
  const input = railDialog.value
  if (!input) return
  // A blank name keeps the dialog open rather than silently doing nothing:
  // the Create button is disabled, and Enter on an empty field is a no-op.
  if (!input.text.trim()) return
  railDialog.value = null
  railOpen.value = false
  if (input.mode === 'rename') {
    workspaceRails.value = setRailColor(
      renameRail(workspaceRails.value, input.id, input.text),
      input.id,
      input.color
    )
    return
  }
  const next = createRail(workspaceRails.value, input.text, Date.now(), input.color)
  workspaceRails.value = next
  // Show the new rail at once. Creating a group and being left looking at
  // another one reads as the button having done nothing.
  const made = next[next.length - 1]
  if (made) activeRailId.value = made.id
}
function cancelRailInput(): void {
  railDialog.value = null
  railOpen.value = false
}

/** Focus the field the moment it appears. A naming box you have to click into
 *  first is one the keyboard cannot finish. */
const railInputEl = ref<HTMLInputElement | null>(null)
watch(railDialog, async (open) => {
  if (!open) return
  await nextTick()
  railInputEl.value?.focus()
  railInputEl.value?.select()
})

/** Escape closes it; a click outside does too. Same shape as the context
 *  menus above, minus the scroll listener — the dialog is fixed, so scrolling
 *  the list underneath does not strand it. */
function onRailDialogKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') cancelRailInput()
}
watch(railDialog, (open) => {
  if (open) {
    document.addEventListener('click', cancelRailInput)
    document.addEventListener('keydown', onRailDialogKeydown)
  } else {
    document.removeEventListener('click', cancelRailInput)
    document.removeEventListener('keydown', onRailDialogKeydown)
  }
})
onUnmounted(() => {
  document.removeEventListener('click', cancelRailInput)
  document.removeEventListener('keydown', onRailDialogKeydown)
})

function removeRail(id: string): void {
  railMenu.value = null
  workspaceRails.value = deleteRail(workspaceRails.value, id)
  // Its members are not deleted, only ungrouped — All is where they land.
  if (activeRailId.value === id) activeRailId.value = ALL_RAIL_ID
}

/* Dropping a workspace heading onto a cell files it there. The heading already
 * carries `application/x-workspace-path` for reorder/detach, so this adds a
 * third outcome to that one gesture without touching its source: cells sit
 * outside the list, and detach still keys off the pointer leaving the window. */
const railDropId = ref<string | null>(null)

/** Whether the flyout — names, counts, ＋ — is out over the list.
 *
 *  The 8px strip alone cannot say which colour is which group, so everything
 *  wider than a bar lives here and appears only while the pointer is on the
 *  edge or a drag is looking for a target. It overlays rather than pushes:
 *  the whole point of the strip is that the groups cost the workspace names
 *  no width. */
const railOpen = ref(false)

function onStripLeave(): void {
  // Two reasons to stay out after the pointer goes: a drag still hunting for
  // a target, and a half-typed group name that would vanish under the cursor.
  if (railDropId.value !== null || railDialog.value) return
  railOpen.value = false
}

/** A workspace heading dragged near the edge opens the flyout, which turns a
 *  row of 8px bars into targets big enough to actually hit. */
function onStripDragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('application/x-workspace-path')) return
  e.preventDefault()
  railOpen.value = true
}

/** A workspace drag is in flight. Lights the bars up: nothing else says the
 *  strip is a place you can drop a project, and the gesture is invisible
 *  otherwise. */
const wsDragActive = ref(false)

/** How close to the left edge a drag has to come to open the flyout — and how
 *  far it may then wander before it closes again.
 *
 *  Two numbers, not one. The strip is 8px wide, so hitting it to open the
 *  flyout is a pixel-hunt nobody wins; 44px is a target you can actually aim
 *  at. But the flyout it opens is 178px wide, so a single threshold would
 *  close it the moment the pointer moved onto the thing it just opened. The
 *  wider figure is hysteresis, not slop. */
const RAIL_DRAG_OPEN_PX = 44
const RAIL_DRAG_KEEP_PX = 200

/** Opens the flyout when a workspace drag comes near the sidebar's left edge.
 *
 *  Bound to the whole row rather than the strip: dragover on an 8px column
 *  means the drop targets are only reachable by first hitting a target the
 *  same size, which is the problem the flyout exists to solve.
 *
 *  Deliberately narrow at rest — the same drag also reorders headings and
 *  detaches a workspace by leaving the window, and a flyout that opened across
 *  the whole list would cover the rows those two need to land on. */
function onWrapDragOver(e: DragEvent): void {
  if (!wsDragActive.value) return
  if (!e.dataTransfer?.types.includes('application/x-workspace-path')) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const from = e.clientX - rect.left
  if (from < (railOpen.value ? RAIL_DRAG_KEEP_PX : RAIL_DRAG_OPEN_PX)) {
    e.preventDefault()
    railOpen.value = true
  } else if (railDropId.value === null) {
    railOpen.value = false
  }
}
function onStripDragLeave(e: DragEvent): void {
  // dragleave also fires moving BETWEEN children; only a leave that lands
  // outside the strip is the drag actually going away.
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement).contains(to)) return
  railDropId.value = null
  railOpen.value = false
}

function onRailDragOver(e: DragEvent, id: string): void {
  if (!e.dataTransfer?.types.includes('application/x-workspace-path')) return
  e.preventDefault()
  railDropId.value = id
}
function onRailDragLeave(id: string): void {
  if (railDropId.value === id) railDropId.value = null
}
function onRailDrop(e: DragEvent, id: string): void {
  railDropId.value = null
  railOpen.value = false
  wsDragActive.value = false
  const from = e.dataTransfer?.getData('application/x-workspace-path') ?? ''
  if (!from) return
  workspaceRails.value = assignToRail(workspaceRails.value, from, id)
}

/** Roughly what the rail menu occupies, for the same edge flip the workspace
 *  menu does. Two entries and a divider. */
const RAIL_MENU_H = 76
const RAIL_MENU_W = 150
const railMenu = ref<{ id: string; x: number; y: number } | null>(null)

function openRailMenu(ev: MouseEvent, id: string): void {
  ev.preventDefault()
  // All is not a rail: there is nothing to rename and nothing to delete.
  if (id === ALL_RAIL_ID) return
  const y =
    ev.clientY + RAIL_MENU_H > window.innerHeight
      ? Math.max(0, ev.clientY - RAIL_MENU_H)
      : ev.clientY
  const x = Math.max(0, Math.min(ev.clientX, window.innerWidth - RAIL_MENU_W))
  railMenu.value = { id, x, y }
}
function closeRailMenu(): void {
  railMenu.value = null
}
function onRailMenuKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeRailMenu()
}
watch(railMenu, (open) => {
  if (open) {
    document.addEventListener('click', closeRailMenu)
    document.addEventListener('keydown', onRailMenuKeydown)
    document.addEventListener('scroll', closeRailMenu, true)
  } else {
    document.removeEventListener('click', closeRailMenu)
    document.removeEventListener('keydown', onRailMenuKeydown)
    document.removeEventListener('scroll', closeRailMenu, true)
  }
})
onUnmounted(() => {
  document.removeEventListener('click', closeRailMenu)
  document.removeEventListener('keydown', onRailMenuKeydown)
  document.removeEventListener('scroll', closeRailMenu, true)
})

/** A group's spine state: the same signal its tab already shows.
 *
 *  An identity palette was the first attempt — a colour per group, hashed from
 *  its id. It told you WHICH group a row belonged to, which the heading right
 *  above it already says. Rolling up the run state instead makes the colour
 *  carry what the heading does not: whether anything in that group is moving.
 *  Reusing rollupTabStatus rather than restating its rule also means the
 *  sidebar cannot drift from the tab bar — one definition of "active", not two.
 */
function groupState(rows: readonly { pane: ActivePaneView }[]): TabRunState {
  return rollupTabStatus(rows.map((r) => r.pane.status))
}

/** Every workspace heading's count-badge status, keyed by path.
 *
 *  Rolled up from `paneIds` — the same set the number counts — so a folded
 *  subtree cannot make the colour and the number disagree. Held as one computed
 *  rather than a per-row call so the 400ms status sync does one pass over the
 *  panes instead of one per heading per render. */
const wsCountStates = computed<Map<string, PaneStatusValue | undefined>>(() => {
  const statusById = new Map(props.panes.map((p) => [p.id, p.status]))
  const out = new Map<string, PaneStatusValue | undefined>()
  for (const ws of props.workspaces ?? []) {
    out.set(ws.path, rollupPaneStatus(ws.paneIds.flatMap((id) => statusById.get(id) ?? [])))
  }
  return out
})

/** The attributes that paint a count pill with a status.
 *
 *  One binding rather than three so the badge either carries the whole signal
 *  or none of it — a `data-state` with no tooltip is a colour with no legend,
 *  which is what the group dot used to be. Nothing at all when there is nothing
 *  to report, leaving the pill on its neutral default. */
function countBadgeAttrs(state: PaneStatusValue | undefined): Record<string, unknown> {
  if (!state) return {}
  return {
    'data-state': state,
    style: statusBadgeStyle(state),
    title: paneStatusLabelText(state),
  }
}

/** Does this workspace have anything its ↻ could rebuild?
 *
 *  The button sits on every workspace heading but read one window-wide flag,
 *  so it took its enabled state — and its action — from whichever workspace
 *  was on screen rather than the one it is attached to. */
function wsCanRebuild(path: string): boolean {
  const key = (path ?? '').replace(/\/+$/, '')
  return (props.rebuildableByWorkspace?.[key] ?? 0) > 0
}

/** One workspace's rows, split into run groups and resolved to panes.
 *
 *  A single ungrouped section renders WITHOUT a heading: a workspace where
 *  nobody has made a group should look exactly as it does today, and a lone
 *  "manual" heading over everything is a label that distinguishes nothing.
 *
 *  `rail` says whether any row in THIS workspace can show a fold caret. The
 *  caret sits in a 12px slot before the status dot, so a row that has one
 *  starts 18px further right than a row that does not — which is why a pane
 *  that happened to spawn a child stopped lining up with its childless
 *  siblings at the same depth. Reserving the slot on every row of that
 *  workspace puts them back on one left edge; a workspace with no lineage
 *  reserves nothing and keeps the left edge it has always had. Answered per
 *  workspace, not once for the window: a window holding a folded project that
 *  has a parent/child pair would otherwise indent every row of a second, flat
 *  project against a caret that is nowhere on screen. */
function groupSectionsOf(
  ws: WorkspaceGroupRow | null
): { id: string; name: string; state: TabRunState; bare: boolean; rail: boolean; rows: ReturnType<typeof panesOf> }[] {
  if (!ws) {
    const rail = orderedPanes.value.some((r) => r.hasChildren)
    return [{ id: '', name: '', state: 'empty', bare: true, rail, rows: orderedPanes.value }]
  }
  const byId = new Map(props.panes.map((pane) => [pane.id, pane]))
  const bare = ws.groups.length <= 1 && (ws.groups[0]?.id ?? '') === ''
  const rail = ws.groups.some((g) => g.rows.some((r) => r.hasChildren))
  return ws.groups.map((g) => {
    const rows = g.rows.flatMap((r) => {
      const pane = byId.get(r.id)
      return pane ? [{ pane, depth: r.depth, hasChildren: r.hasChildren, collapsed: r.collapsed }] : []
    })
    return { id: g.id, name: g.name, state: groupState(rows), bare, rail, rows }
  })
}

/** The panes belonging to one section, in lineage order. */
function panesOf(
  ws: WorkspaceGroupRow | null
): { pane: ActivePaneView; depth: number; hasChildren: boolean; collapsed: boolean }[] {
  if (!ws) return orderedPanes.value
  const byId = new Map(props.panes.map((pane) => [pane.id, pane]))
  const out: { pane: ActivePaneView; depth: number; hasChildren: boolean; collapsed: boolean }[] = []
  for (const r of ws.lineage) {
    const pane = byId.get(r.id)
    if (pane) out.push({ pane, depth: r.depth, hasChildren: r.hasChildren, collapsed: r.collapsed })
  }
  return out
}

// Build tag injected at build time (electron.vite.config.ts) so the header
// shows exactly which build is running — avoids confusion over which version
// is live when juggling worktrees / uncommitted changes.
const buildTag = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev'

const { state: updateState, startDownload } = useUpdater()

// Announce a freshly-available update once per version — subtle, non-spammy.
// Patch releases keep the message-only toast (main auto-downloads them); the
// badge and Settings → Updates section are the interactive entry points.
// Minor/major updates never auto-download, so ask instead: a confirm dialog
// with the version jump and release notes offers Download / Later. "Later"
// simply closes — no re-prompt for that version.
const { toast: notifyToast, confirm: notifyConfirm } = useNotify()
let lastNotifiedUpdate: string | undefined
watch(
  () => [updateState.value.status, updateState.value.availableVersion] as const,
  ([status, version]) => {
    if (status === 'available' && version && version !== lastNotifiedUpdate) {
      lastNotifiedUpdate = version
      // severity is undefined when the main process predates severity support;
      // treat that as 'patch' to preserve the old toast behavior.
      const severity = updateState.value.severity ?? 'patch'
      if (severity === 'patch') {
        notifyToast(i18n.global.t('updater.new-version-toast', { version }), { type: 'info' })
        return
      }
      const body = i18n.global.t('updater.major-update-body', {
        current: updateState.value.currentVersion,
        version,
      })
      const notes = updateState.value.releaseNotes
      const message = notes ? `${body}\n\n${i18n.global.t('updater.release-notes')}:\n${notes}` : body
      void notifyConfirm(message, {
        title: i18n.global.t('updater.major-update-title'),
        confirmText: i18n.global.t('updater.download-now'),
        cancelText: i18n.global.t('updater.later'),
      }).then((accepted) => {
        if (accepted) void startDownload()
      })
    }
  },
)

const emit = defineEmits<{
  (e: 'spawn', payload: SpawnPayload): void
  (e: 'spawn-resume', payload: ResumePayload): void
  (e: 'kill', paneId: string): void
  (e: 'kill-all'): void
  (e: 'minimize', paneId: string): void
  /** Fold/unfold this pane's lineage subtree. App owns the state so every
   *  list stays in step and the choice can be persisted. */
  (e: 'toggle-collapsed', paneId: string): void
  /** Fold/unfold a whole workspace section. */
  (e: 'toggle-workspace', path: string): void
  /** Bring a workspace to the front — focus its window if one has it open,
   *  otherwise open it. */
  /** Open a new agent in a workspace that is not this window's. */
  (e: 'open-workspace-picker'): void
  (e: 'switch-to-workspace', path: string): void
  (e: 'close-workspace', path: string): void
  (e: 'detach-workspace', path: string, x: number, y: number): void
  (e: 'reorder-workspace', fromPath: string, toPath: string): void
  (e: 'reveal-workspace-folder', path: string): void
  (e: 'interrupt', paneId: string): void
  (e: 'rebuild', paneId: string): void
  /** From a workspace heading: that workspace. From the toolbar: undefined,
   *  meaning the workspace on screen. */
  (e: 'rebuild-all', workspacePath?: string): void
  (e: 'restore', paneId: string): void
  (e: 'context-menu', paneId: string, ev: MouseEvent): void
  (e: 'pipeline-start', payload: { task: string; workspacePath: string; pipelineId?: string }): void
  (e: 'pipeline-next'): void
  (e: 'pipeline-abort'): void
  (e: 'pipeline-reset'): void
  (e: 'update:yoloEnabled', v: boolean): void
  (e: 'update:analyzerModel', v: string): void
  (e: 'update:autoAnswerEnabled', v: boolean): void
  (e: 'refresh-analyzer'): void
  (e: 'workspace-check', path: string): void
  (e: 'pipeline-resume'): void
  (e: 'pipeline-restart', payload: { task: string; workspacePath: string }): void
  (e: 'focus-pane', paneId: string, ev?: MouseEvent): void
  (e: 'reorder-pane', fromId: string, toId: string): void
  (e: 'open-settings'): void
  (e: 'open-pipeline-manager', pipelineId?: string): void
  (e: 'open-history', workspacePath?: string): void
  (e: 'switch-workspace'): void
  (e: 'workspace-browse', path: string): void
  (e: 'dispatch-issue', payload: { paneId: string; issue: IssueDetail }): void
  (e: 'spawn-for-issue', payload: { agentKey: string; mode: IssueHandlerMode; issue: Issue; provider: IssueProvider }): void
  (e: 'open-git-accounts'): void
  (e: 'changes-count', count: number): void
  (e: 'rename-pane', paneId: string, name: string): void
  (e: 'install-cli', payload: { agentKey: string; label: string }): void
  (e: 'update:collapsed', v: boolean): void
}>()

const renamingPaneId = ref<string | null>(null)
const renameDraft = ref('')
let _cancelledRename = false

// Autofocus + select the rename input the moment it mounts. Mirrors App.vue's
// vFocus: a shared array template ref's `.find()` could resolve to a stale
// (already unmounted) input on the second edit, leaving the real input
// unfocused so keystrokes were silently dropped ("rename works once, then
// does nothing").
const vFocus = {
  mounted(el: HTMLInputElement): void {
    el.focus()
    el.select()
  },
}

function startRename(p: ActivePaneView): void {
  _cancelledRename = false
  renameDraft.value = p.agentLabel
  renamingPaneId.value = p.id
}

function commitRename(): void {
  if (_cancelledRename || !renamingPaneId.value) return
  emit('rename-pane', renamingPaneId.value, renameDraft.value.trim())
  renamingPaneId.value = null
}

function onRenameKeydown(e: KeyboardEvent): void {
  // Ignore the Enter/Escape an IME (e.g. Chinese) sends while composing —
  // that keystroke confirms candidate selection, not the rename.
  if (e.isComposing) return
  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledRename = true; renamingPaneId.value = null }
}

function agentTypeLabel(agentKey: string): string {
  return props.agentSpecs?.find(s => s.agentKey === agentKey)?.label ?? agentKey
}

const yoloLocal = computed<boolean>({
  get: () => props.yoloEnabled,
  set: (v) => emit('update:yoloEnabled', v)
})

const analyzerModelLocal = computed<string>({
  get: () => props.analyzerModel || props.analyzerStatus.defaultModel,
  set: (v) => emit('update:analyzerModel', v)
})

// Only show models that passed the benchmark (or all if no results yet)
const filteredModels = computed<AnalyzerModelOption[]>(() => {
  const results = props.analyzerStatus.benchmarkResults
  if (!results || results.length === 0) return props.analyzerStatus.models
  const passMap = new Map(results.map((r) => [r.name, r.passed]))
  return props.analyzerStatus.models.filter((m) => passMap.get(m.name) !== false)
})

const autoAnswerLocal = computed<boolean>({
  get: () => props.autoAnswerEnabled,
  set: (v) => emit('update:autoAnswerEnabled', v)
})

const workspacePath = ref<string>('')
const isTaskDragOver = ref(false)
// Workspace selected on the Welcome screen flows in here; the user can still
// edit / re-browse afterwards. Writing it triggers the workspace-check watch
// below, so picking a workspace auto-detects any existing project.
watch(
  () => props.workspace,
  (v) => {
    const next = v ?? ''
    if (next !== workspacePath.value) workspacePath.value = next
  },
  { immediate: true }
)
// Task description uses sessionStorage so it survives Vite HMR / component
// re-mounts within the same app session, but NOT across app restarts. The
// previous localStorage-based approach made stale text linger forever even
// after the pipeline finished and the app was relaunched.
const TASK_DESC_KEY = 'agentTeam.pipelineTaskDescription'
// The one-time cleanup of the old persist-forever localStorage entry moved to
// lib/settings PURGED_LOCALSTORAGE_KEYS (runs with the storage migration).
const taskDescription = ref<string>(
  (() => { try { return sessionStorage.getItem(TASK_DESC_KEY) ?? '' } catch { return '' } })()
)
watch(taskDescription, (v) => {
  try { sessionStorage.setItem(TASK_DESC_KEY, v) } catch { /* ignore */ }
})
// Secondary safety net: if parent has an authoritative task (e.g. pipeline is
// running) and our local copy is empty, mirror it back. Never overwrite a
// non-empty local edit.
watch(
  () => props.pipeline.task,
  (parentTask) => {
    if (parentTask && taskDescription.value.trim() === '') {
      taskDescription.value = parentTask
    }
  },
  { immediate: true }
)
// When the user explicitly resets the pipeline (Reset button → state='idle'
// AND parent task cleared), also wipe the local textarea + sessionStorage so
// they start fresh next time.
watch(
  () => [props.pipeline.state, props.pipeline.task] as const,
  ([state, parentTask]) => {
    if (state === 'idle' && !parentTask) {
      taskDescription.value = ''
      try { sessionStorage.removeItem(TASK_DESC_KEY) } catch { /* ignore */ }
    }
  }
)
const pickingWorkspace = ref<boolean>(false)
const confirmingRestart = ref<boolean>(false)

function startOverNow(): void {
  if (!props.existingProject) {
    confirmingRestart.value = false
    return
  }
  const task = props.existingProject.taskDescription || taskDescription.value.trim()
  if (!task || !workspacePath.value.trim()) {
    confirmingRestart.value = false
    return
  }
  // Send the path verbatim: folder names may legitimately end with a space
  // (e.g. Google Drive folders), and every source of this value (picker,
  // Welcome screen, drag-drop) already provides an exact filesystem path.
  emit('pipeline-restart', { task, workspacePath: workspacePath.value })
  confirmingRestart.value = false
}

async function pickWorkspace(): Promise<void> {
  if (!window.agentTeam?.pickWorkspace) return
  pickingWorkspace.value = true
  try {
    const picked = await window.agentTeam.pickWorkspace(workspacePath.value || undefined)
    if (picked) emit('workspace-browse', picked)
  } finally {
    pickingWorkspace.value = false
  }
}

// Debounced peek for existing project whenever the workspace path stabilises.
let workspaceDebounce: number | null = null
watch(workspacePath, (v) => {
  if (workspaceDebounce !== null) window.clearTimeout(workspaceDebounce)
  workspaceDebounce = window.setTimeout(() => {
    emit('workspace-check', v)
  }, 400)
}, { immediate: true })
onUnmounted(() => {
  if (workspaceDebounce !== null) window.clearTimeout(workspaceDebounce)
})

defineExpose({ openPipelineDetail, showResumeError, selectSidebarTab })

const manualAgentSpecs = computed(() =>
  props.agentSpecs.filter((spec) => spec.agentKey !== 'terminal')
)

// Available agent types for "Handle Issue As…" pane spawn.
const availableAgents = computed(() =>
  manualAgentSpecs.value.map((spec) => ({ key: spec.agentKey, label: spec.label }))
)

const pickedAgent = ref<string>(manualAgentSpecs.value[0]?.agentKey ?? 'claude')
const pickedRole = ref<RoleKey>('')

// CLI availability for the spawn dropdown — onboarding dep ids match agentKeys.
// Refreshed on backend connect and on dropdown focus (throttled: the status
// call shells out per dep) so a just-installed CLI sheds its badge without a
// reload.
const missingClis = ref<Set<string>>(new Set())
let cliStatusFetchedAt = 0
async function refreshCliStatus(): Promise<void> {
  if (!props.backend || props.backendStatus !== 'connected') return
  if (Date.now() - cliStatusFetchedAt < 10_000) return
  cliStatusFetchedAt = Date.now()
  try {
    const resp = await props.backend.send<{ deps?: { id: string; group: string; status: string }[] }>(
      'onboarding.status',
      {}
    )
    const deps = resp.payload?.deps ?? []
    missingClis.value = new Set(
      deps.filter((d) => d.group === 'agent_cli' && d.status === 'missing').map((d) => d.id)
    )
  } catch {
    // keep last known state; the exit=127 install dialog still covers misses
  }
}
watch(
  () => props.backendStatus,
  (s) => {
    if (s === 'connected') void refreshCliStatus()
  },
  { immediate: true }
)

watch(
  manualAgentSpecs,
  (specs) => {
    if (!specs.some((spec) => spec.agentKey === pickedAgent.value)) {
      pickedAgent.value = specs[0]?.agentKey ?? 'claude'
    }
  },
  { immediate: true }
)

// ── Top-level tab: core tabs plus recovery Git and Manifest contributions ─────
const _TAB_KEY = 'agentTeam.sidebarTab'
type SidebarTab = 'agents' | 'pipeline' | 'explorer' | 'git' | 'plans' | `plugin:${string}`
const CORE_SIDEBAR_TABS = ['agents', 'pipeline', 'explorer'] as const
type CoreSidebarTab = (typeof CORE_SIDEBAR_TABS)[number]
const legacyGitRecovery = computed(() => props.legacyGitRecovery === true)
const legacyPlansRecovery = computed(() => props.legacyPlansRecovery === true)
const pluginTabId = (key: string): `plugin:${string}` => `plugin:${key}`
const isPluginTab = (tab: SidebarTab): tab is `plugin:${string}` => tab.startsWith('plugin:')
const pluginTabs = computed(() =>
  (props.pluginContributions ?? [])
    .filter((entry) => entry.location === 'left')
    .map((entry) => ({ ...entry, tabId: pluginTabId(entry.contributionKey) }))
)
const gitPluginTab = computed(() => pluginTabs.value.find((entry) => entry.pluginId === 'navide.git') ?? null)
const plansPluginTab = computed(() => pluginTabs.value.find((entry) => entry.pluginId === 'navide.plans') ?? null)
const genericPluginTabs = computed(() => pluginTabs.value.filter((entry) =>
  entry.pluginId !== 'navide.git' && entry.pluginId !== 'navide.plans'
))

async function projectPlansPreferencesBeforePrepare(): Promise<void> {
  const activeWorkspace = props.workspace || workspacePath.value || ''
  if (!activeWorkspace) return
  try {
    await window.agentTeam?.projectLegacyPlansPreferences?.({
      workspace_path: activeWorkspace,
      values: readLegacyPlansPreferenceProjection(activeWorkspace),
    })
  } catch {
    // Migration is create-only and best effort; the package still owns the
    // surface when the legacy storage origin is unavailable.
  }
}
const failedPluginIcons = ref(new Set<string>())
const pluginIconFailureKey = (entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): string =>
  `${entry.contributionKey}\u0000${entry.icon ?? ''}`
const hasPluginIcon = (entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): boolean =>
  Boolean(entry.icon) && !failedPluginIcons.value.has(pluginIconFailureKey(entry))
/** Single-colour artwork is painted with CSS rather than shown as an image:
 *  the icon becomes a mask over `currentColor`, so it follows the tab's text
 *  colour like the built-in SVG icons instead of keeping the shade the plugin
 *  author baked in (one drawn for a dark theme is invisible on a light one).
 *  Colour artwork stays an <img> — a mask would flatten it to one tone. */
const isMonoPluginIcon = (
  entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon' | 'iconMonochrome'>
): boolean => hasPluginIcon(entry) && entry.iconMonochrome === true
const pluginIconMask = (
  entry: Pick<PluginRegionContribution, 'icon'>
): Record<string, string> => ({ '--plugin-icon': `url("${entry.icon}")` })
function markPluginIconFailed(entry: Pick<PluginRegionContribution, 'contributionKey' | 'icon'>): void {
  const failures = new Set(failedPluginIcons.value)
  failures.add(pluginIconFailureKey(entry))
  failedPluginIcons.value = failures
}
const sidebarTab = ref<SidebarTab>(
  (() => {
    try {
      const v = sessionStorage.getItem(_TAB_KEY) as SidebarTab | null
      // Backward-compat: unknown / legacy values fall back to the first tab.
      const isKnown = v !== null && (
        v === 'agents' || v === 'pipeline' || v === 'explorer' ||
        v === 'plans' || v.startsWith('plugin:') || (v === 'git' && legacyGitRecovery.value)
      )
      return isKnown ? v : 'agents'
    } catch { return 'agents' }
  })()
)
watch(sidebarTab, (v) => { try { sessionStorage.setItem(_TAB_KEY, v) } catch { /* ignore */ } })

// Opening Git while the session sits in legacy recovery is the user's natural
// retry: the downgrade is usually a transient activation failure, and the Host
// answers with a bounded budget of v2 attempts.
let awaitingGitV2Tab = false
let gitV2RetryInFlight = false
function requestGitV2Retry(): void {
  const retry = window.agentTeam?.retryGitV2
  if (!retry || gitV2RetryInFlight) return
  gitV2RetryInFlight = true
  awaitingGitV2Tab = true
  void retry()
    .then((result) => { if (!result?.ok) awaitingGitV2Tab = false })
    .catch(() => { awaitingGitV2Tab = false })
    .finally(() => { gitV2RetryInFlight = false })
}

watch(legacyGitRecovery, (enabled) => {
  if (enabled || sidebarTab.value !== 'git') return
  const restored = gitPluginTab.value?.tabId
  if (restored) {
    awaitingGitV2Tab = false
    sidebarTab.value = restored
    return
  }
  // A retry we asked for lands on the v2 tab below, once the contribution
  // catalog refresh arrives; only an unrelated exit drops back to Agents.
  if (!awaitingGitV2Tab) sidebarTab.value = 'agents'
}, { immediate: true })

watch(gitPluginTab, (tab) => {
  if (!tab || !awaitingGitV2Tab) return
  awaitingGitV2Tab = false
  showSidebarTab(tab.tabId)
})

watch(pluginTabs, (tabs) => {
  if (isPluginTab(sidebarTab.value) && !tabs.some((tab) => tab.tabId === sidebarTab.value)) {
    sidebarTab.value = 'agents'
  }
}, { immediate: true })

// Cmd+1/2/3/4/5 preserve the established Agents / Pipeline / Explorer / Git /
// Plans positions. V2 Git owns the same fourth command slot as recovery Git.
//
// These used to be a bare `document.addEventListener('keydown')` sitting
// outside the keybinding system, which meant Settings could neither list nor
// rebind them — and worse, unbinding Cmd+1 there still left this listener
// switching the sidebar. They are ordinary commands now; only the text-input
// guard stayed behind, because the central dispatcher does not look at
// `e.target` and this shortcut must not fire while someone is typing.
const SIDEBAR_TABS: SidebarTab[] = [...CORE_SIDEBAR_TABS, 'git', 'plans']

function typingInTextField(): boolean {
  const el = document.activeElement as HTMLElement | null
  const tag = el?.tagName ?? ''
  // The xterm helper textarea is not real text entry — the shortcut works there.
  const isXterm = tag === 'TEXTAREA' && el?.classList.contains('xterm-helper-textarea')
  return !isXterm && (tag === 'INPUT' || tag === 'TEXTAREA' || !!el?.isContentEditable)
}

for (let i = 1; i <= SIDEBAR_TABS.length; i++) {
  registerCommand(`controlPane.selectSidebarTab${i}`, () => {
    // Decline rather than no-op: returning false keeps the dispatcher from
    // calling preventDefault(), so the keystroke still reaches the text field
    // and anything else listening. The old raw listener behaved this way.
    if (typingInTextField()) return false
    selectSidebarTab(SIDEBAR_TABS[i - 1])
  })
}

// VS Code-style sidebar shortcuts, consistent with the editor window which uses
// the same command ids: Cmd+Shift+E / R / G.
registerCommand('workbench.action.focusExplorer', () => selectSidebarTab('explorer'))
registerCommand('workbench.action.focusPipeline', () => selectSidebarTab('pipeline'))
registerCommand('workbench.action.focusSourceControl', () => {
  if (legacyGitRecovery.value) {
    selectSidebarTab('git')
    return
  }
  if (gitPluginTab.value) selectSidebarTab(gitPluginTab.value.tabId)
})
// Cmd+Shift+U → spawn an agent with the currently picked CLI/role (the green
// "Open Agent" button); spawn() itself no-ops when canSpawn is false.
registerCommand('workbench.action.spawnAgent', () => spawn())
// Ctrl+<n> → pick the Nth manual CLI type for the next spawn. Only sets
// pickedAgent (does not touch existing panes); switches to the Agents tab and
// expands the Manual Spawn card so the changed dropdown is visible. Slots past
// the list are no-ops.
for (let i = 1; i <= 9; i++) {
  registerCommand(`controlPane.selectCliType${i}`, () => {
    const spec = manualAgentSpecs.value[i - 1]
    if (spec) {
      pickedAgent.value = spec.agentKey
      // Also the dialog's own pick: with it already open the seeding watch does
      // not fire, and the dropdown this shortcut exists to move would not move.
      modalAgent.value = spec.agentKey
      manualSpawnOpen.value = true
      selectSidebarTab('agents')
    }
  })
}

// ── Pipeline two-layer navigation ─────────────────────────────────────────────
const sidebarView = ref<'list' | 'pipeline'>('list')
const openedPipelineId = ref<string>('')

const openedPipeline = computed(
  () => props.pipelines?.find((p) => p.id === openedPipelineId.value) ?? null
)

function openPipelineDetail(id: string): void {
  openedPipelineId.value = id
  sidebarView.value = 'pipeline'
}

function backToList(): void {
  sidebarView.value = 'list'
}

// Switch the left sidebar tab. Entering the Pipeline tab always lands on the
// list view (never a stale detail) — openPipelineDetail is the only path into
// the detail view, so the panel can't render blank after the opened pipeline
// goes away. Used by the tab buttons, Cmd+1..5, and Cmd+Shift+E/R/G.
function showSidebarTab(tab: SidebarTab): void {
  sidebarTab.value = tab
  if (tab === 'pipeline') sidebarView.value = 'list'
}

const gitChangesCount = computed(() => props.gitChangesCount ?? 0)

function selectSidebarTab(tab: SidebarTab): void {
  const target = tab === 'git' && !legacyGitRecovery.value
    ? gitPluginTab.value?.tabId
    : tab
  if (!target) return
  showSidebarTab(target)
  if (tab === 'git' && legacyGitRecovery.value) requestGitV2Retry()
  // Surfacing a tab while the slot is collapsed has to reopen it, or Cmd+1..5
  // and the programmatic entry points would only move a highlight on the rail.
  // Collapsing is the parent's state, so ask rather than set — the same one-way
  // contract as TokenStatsPanel's `update:expanded`.
  //
  // Only this path expands, never showSidebarTab: repairing an active tab that
  // was moved out from under us is not a request to see the panel, and a
  // collapsed sidebar must not pop open because Settings moved a view.
  if (props.collapsed) emit('update:collapsed', false)
}

// Rail entries mirror the tab strip. Emoji icons rather than the strip's inline
// SVGs: the rail is 36px wide, and copying five <path> blobs to render them at
// half size buys nothing over the icon convention TokenStatsPanel's rail set.
// `title` keeps its shortcut hint: Cmd+1..5 are bound to SIDEBAR_TABS by
// position in that list, not by position in the strip, so reordering the strip
// leaves the hints correct.
const RAIL_TABS: { id: SidebarTab; icon?: string; label: string; title: string; path: string }[] = [
  { id: 'agents', icon: '\u{1F916}', label: 'label.agents', title: 'Agents (\u23181)', path: 'M2 3.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm0 4.5a1.25 1.25 0 1 1 2.5 0A1.25 1.25 0 0 1 2 8Zm0 4.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM6.5 2.75A.75.75 0 0 1 7.25 2h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5A.75.75 0 0 1 7.25 6.5h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Z' },
  { id: 'pipeline', icon: '\u{1F500}', label: 'label.pipeline', title: 'Pipeline (\u23182)', path: 'M0 1.75C0 .784.784 0 1.75 0h3.5C6.216 0 7 .784 7 1.75v3.5A1.75 1.75 0 0 1 5.25 7H4v4a1 1 0 0 0 1 1h4v-1.25C9 9.784 9.784 9 10.75 9h3.5c.966 0 1.75.784 1.75 1.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-.75H5A2.5 2.5 0 0 1 2.5 11V7h-.75A1.75 1.75 0 0 1 0 5.25Zm1.75-.25a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Zm9 9a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Z' },
  { id: 'explorer', icon: '\u{1F4C1}', label: 'label.explorer', title: 'Explorer (\u23183)', path: 'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z' },
  { id: 'git', label: 'label.git', title: 'Git (\u23184)', path: 'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z' },
  { id: 'plans', icon: '\u{1F4CB}', label: 'label.plans', title: 'Plans (\u23185)', path: 'M5 2a1 1 0 0 0-1 1H2.75A1.75 1.75 0 0 0 1 4.75v9.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 14.25v-9.5A1.75 1.75 0 0 0 13.25 3H12a1 1 0 0 0-1-1H5Zm0 2h6v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Zm-2.25.5H4a2.5 2.5 0 0 0 2 1h4a2.5 2.5 0 0 0 2-1h1.25a.25.25 0 0 1 .25.25v9.5a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25v-9.5a.25.25 0 0 1 .25-.25Z' },
]

// Ordered by the slot, not by the table above: moving a view also reorders it.
const visibleTabs = computed(() => {
  const assigned = props.views
  if (!assigned) return RAIL_TABS
  return assigned
    .map((id) => RAIL_TABS.find((t) => t.id === id))
    .filter((t): t is typeof RAIL_TABS[number] => !!t)
})

// Membership as a set, for the panels that stay mounted regardless of which
// tab is showing. Those must also disappear when their view moves to another
// slot, or the app runs two live copies: two backend subscriptions, and a Git
// badge fed by a panel the user can no longer see.
const visibleTabIds = computed(() => new Set(visibleTabs.value.map((t) => t.id)))

// The active tab can be moved out from under us — by this window's own
// Settings, or by another window, since the layout is shared. Falling back to
// the first remaining tab keeps the panel showing something; without this the
// body renders nothing and the sidebar looks broken rather than empty.
watch(visibleTabs, (tabs) => {
  if (!tabs.length || tabs.some((t) => t.id === sidebarTab.value) || isPluginTab(sidebarTab.value)) return
  showSidebarTab(tabs[0].id)
}, { immediate: true })

function isPipelineRunning(pipelineId: string): boolean {
  return pipelineId === (props.activePipelineId ?? '') && props.pipeline.state === 'running'
}

// The unfinished run recorded in project.json belongs to exactly ONE pipeline.
// Offering "Resume" while a DIFFERENT pipeline is active let the user resume
// stage N of pipeline A against pipeline B's (possibly shorter) stage list.
// A record with no pipelineId predates per-pipeline projects and stays
// resumable, so old workspaces keep the banner they have always had.
const resumeMatchesActivePipeline = computed<boolean>(() => {
  const owner = props.existingProject?.pipelineId ?? ''
  if (!owner) return true
  return owner === (props.activePipelineId ?? '')
})

// Name of the pipeline the unfinished run belongs to, for the card shown when
// it is not the active one. Falls back to the raw id: the pipeline may have
// been deleted, and the id is still more use than an empty string.
const resumeOwnerPipelineName = computed<string>(() => {
  const owner = props.existingProject?.pipelineId ?? ''
  return props.pipelines?.find((p) => p.id === owner)?.name ?? owner
})

// ── Pipeline list pagination ───────────────────────────────────────────────
const PIPELINE_PAGE_SIZE = 5
const pipelinePage = ref(0)
const pipelinePageCount = computed(() =>
  Math.ceil((props.pipelines?.length ?? 0) / PIPELINE_PAGE_SIZE)
)
const pagedPipelines = computed(() => {
  const start = pipelinePage.value * PIPELINE_PAGE_SIZE
  return (props.pipelines ?? []).slice(start, start + PIPELINE_PAGE_SIZE)
})
watch(() => props.pipelines?.length, () => { pipelinePage.value = 0 })

const previewOpen = ref<boolean>(false)
const manualSpawnOpen = ref<boolean>(false)
/** The dialog's own CLI pick, seeded from pickedAgent each time it opens and
 *  never written back. The ＋ menu's ✓ is the default for the next spawn from
 *  the menu itself, so trying another CLI inside the dialog must not move it. */
const modalAgent = ref<string>(pickedAgent.value)
/** Which CLI the spawn actions run: the dialog's pick while it is open, the
 *  menu's default otherwise. */
const activeSpawnAgent = computed(() =>
  manualSpawnOpen.value ? modalAgent.value : pickedAgent.value
)
const pipelineOpen = ref<boolean>(true)
// Manual spawn used to be a card, and a spawn-mode workspace opened with it
// already expanded. As a dialog that same default means it appears over the
// app at startup, unasked. It now opens only when something asks it to: the
// ＋ menu, Ctrl+<n>, a resume error, or another window's request.

const currentRole = computed<Role | undefined>(() =>
  props.roles.find((r) => r.key === pickedRole.value)
)

// Keep pickedRole valid when the roles registry mutates from any window.
watch(
  () => props.roles,
  (rs) => {
    if (rs.length === 0) return
    if (pickedRole.value && !rs.find((r) => r.key === pickedRole.value)) pickedRole.value = ''
  },
  { immediate: true }
)

function openPipelineManager(pipelineId?: string): void {
  emit('open-pipeline-manager', pipelineId)
}

function interruptTooltip(p: ActivePaneView): string {
  if (p.status !== 'running') return i18n.global.t('action.interrupt-not-running')
  return i18n.global.t('action.interrupt')
}

const canSpawn = computed(
  () => props.backendStatus === 'connected' && workspacePath.value.trim().length > 0
)

// ── Resume an existing session by id (right of "Open Terminal") ───────────────
const resumeSessionId = ref<string>('')
// Validation runs in App.vue (it owns the backend round-trip); the not-found
// message is pushed back here via the exposed showResumeError().
const resumeNotice = ref<string>('')

// Datalist options: past sessions for the currently-picked CLI across ALL
// workspaces that carry a session id, newest first, deduped by id. Each option
// keeps its origin workspacePath so resume can target the session's own cwd
// (cross-workspace resume), not the currently-selected workspace. The label
// shows the workspace folder so cross-workspace ids are distinguishable.
const resumeOptions = computed<{ sessionId: string; label: string; workspacePath: string }[]>(() => {
  const seen = new Set<string>()
  const out: { sessionId: string; label: string; workspacePath: string }[] = []
  for (const entry of [...(props.spawnHistory ?? [])].reverse()) {
    const sid = (entry.sessionId ?? '').trim()
    if (!sid || entry.agentKey !== activeSpawnAgent.value) continue
    if (seen.has(sid)) continue
    seen.add(sid)
    const when = entry.spawnedAt ? entry.spawnedAt.slice(0, 16).replace('T', ' ') : '—'
    const ws = entry.workspacePath.split('/').filter(Boolean).pop() ?? entry.workspacePath
    out.push({
      sessionId: sid,
      label: `${entry.customName || entry.agentLabel} · ${entry.roleLabel || '—'} · ${ws} · ${when}`,
      workspacePath: entry.workspacePath
    })
  }
  return out
})

const canResume = computed(() => canSpawn.value && resumeSessionId.value.trim().length > 0)

// Clear a stale not-found hint as soon as the user edits the id.
watch(resumeSessionId, () => {
  resumeNotice.value = ''
})

function resumeAgent(): void {
  if (!canResume.value) return
  resumeNotice.value = ''
  const sid = resumeSessionId.value.trim()
  // A datalist pick carries its origin workspace (cross-workspace resume); a
  // manually-pasted id with no history match falls back to the current one.
  const origin = resumeOptions.value.find((o) => o.sessionId === sid)?.workspacePath
  emit('spawn-resume', {
    agentKey: activeSpawnAgent.value,
    sessionId: sid,
    workspacePath: origin ?? workspacePath.value
  })
}

function showResumeError(message: string): void {
  resumeNotice.value = message
  // The notice renders inside the spawn card body, which only mounts on the
  // Agents tab and only while the card is open. Callers reach here from the
  // Agent History modal and from pane reconnect, so surface both — otherwise
  // the message lands in an unmounted subtree and the failure looks silent.
  selectSidebarTab('agents')
  manualSpawnOpen.value = true
}

// Stage count for the pipeline currently being viewed (may differ from active pipeline)
const effectiveStageCount = computed(() => {
  if (!openedPipelineId.value || openedPipelineId.value === (props.activePipelineId ?? '')) {
    return props.stages.length
  }
  return openedPipeline.value?.stage_count ?? 0
})

const canRunPipeline = computed(
  () =>
    props.backendStatus === 'connected' &&
    workspacePath.value.trim().length > 0 &&
    taskDescription.value.trim().length > 0 &&
    props.pipeline.state !== 'running' &&
    effectiveStageCount.value > 0
)

/** Set while a spawn is on its way from a workspace heading other than this
 *  window's primary. Cleared once the request is out — the card's own button
 *  always means "here". */
const spawnWorkspaceOverride = ref<string>('')

/** Same shape as spawnWorkspaceOverride, for the group a sidebar ＋ named.
 *  Cleared with it — the spawn card's own button always means "wherever the
 *  active tab points". */
const spawnGroupOverride = ref<string>('')

function emitSpawn(agentKey: string): void {
  emit('spawn', {
    agentKey,
    roleKey: pickedRole.value,
    stageId: '',
    workspacePath: spawnWorkspaceOverride.value || workspacePath.value,
    runGroupId: spawnGroupOverride.value || undefined
  })
  spawnWorkspaceOverride.value = ''
  spawnGroupOverride.value = ''
}

/** What the heading's ＋ will open. The spawn card can be folded shut, so the
 *  button has to say which agent it is about to run. */
const pickedAgentLabel = computed(
  () => manualAgentSpecs.value.find((s) => s.agentKey === pickedAgent.value)?.label ?? pickedAgent.value
)

// ── The ＋ menu on this window's workspace heading ────────────────────────────
// The default CLI and role for a one-click spawn: it reads and writes
// pickedAgent/pickedRole, which is what its ✓ marks. The Manual spawn dialog
// keeps its own CLI pick (modalAgent) instead — it is where you go to run
// something other than the default, and doing so must not reset the default.
const addMenuOpen = ref<boolean>(false)
/** Which workspace heading opened the menu, so a pick starts there. */
const addMenuWorkspace = ref<string>('')
/** Which group row opened the menu, so a pick lands in that group rather than
 *  in whichever one the stage tab happens to be showing. Empty for the
 *  workspace heading's ＋, which has no group to name. */
const addMenuGroup = ref<string>('')

// ── Right-click on a workspace heading ───────────────────────────────────
const wsMenu = ref<{ path: string; canClose: boolean; x: number; y: number } | null>(null)

/** `canClose` is the answer to "would closing this do anything?".
 *
 *  A workspace that is not the one on screen: always — closing it changes the
 *  list and nothing else.
 *
 *  The one on screen: only when this window holds another to land on. Closing
 *  it switches to the next workspace first and lets go of this one after, so
 *  with nothing to switch to there is nowhere to go and the item would do
 *  nothing. Back to the Welcome picker is the titlebar's ↺ button, which asks
 *  first — deliberately not folded in here, where a menu item would discard a
 *  window's last project without a word.
 *
 *  Not in a detached window either: switchToWorkspace declines there, so the
 *  landing this depends on never happens. */
// Drag-out: dragging a workspace heading and releasing OUTSIDE this window
// gives that workspace its own window. Deliberately the same gesture as a stage
// tab in StageTabBar — both mean "pull this out of here", so both are a drag to
// nowhere rather than one drag and one menu item.
//
// Only when this window holds more than one: dragging out the only workspace
// would empty this window to fill a new one, which is a no-op the long way
// round. A detached window is already one group of one workspace.
/** Whether dragging a heading OUT of the window is meaningful.
 *
 *  Needs a second workspace: pulling out the only one empties this window to
 *  fill a new one. Reordering has the same floor for its own reason — there is
 *  nothing to reorder against. */
const canDetachWorkspace = computed(
  () => !props.detachedWindow && localWorkspaceRows.value.length > 1
)

/** Whether a workspace heading can be dragged at all.
 *
 *  One gesture, THREE outcomes now: released on another heading it reorders,
 *  released on the rail it files the project into that group, released outside
 *  the window it detaches.
 *
 *  The first and last need a second workspace, and this used to require one
 *  too. Filing does not — a window holding a single project can perfectly well
 *  put it in a group — and the stale floor made the whole heading undraggable
 *  in exactly that case, so the rail could never be given anything. Hence the
 *  extra clause rather than a shared one: the outcomes have different
 *  preconditions and each is checked where it happens. */
const canDragWorkspace = computed(
  () =>
    !props.detachedWindow &&
    (localWorkspaceRows.value.length > 1 || workspaceRails.value.length > 0)
)

/** Whether the workspace on screen has somewhere to land if it is closed.
 *  Same shape as canDetachWorkspace and for the same reason — both need a
 *  second workspace to be meaningful — but kept apart: they answer different
 *  questions and one of them changing should not silently change the other.
 *  (That split is exactly what let the drag floor be relaxed for filing
 *  without also letting a window close its last workspace.) */
const canCloseCurrent = computed(
  () => !props.detachedWindow && localWorkspaceRows.value.length > 1
)

/** Whether every workspace this window holds is already folded shut, which is
 *  what turns the header button from "collapse all" into "expand all". */
const allWorkspacesCollapsed = computed(() => {
  // The rows ON SCREEN, not every row the window holds: folding "all" while a
  // rail hides half the list would leave the button reading "expand all" over
  // a list that is plainly open.
  const rows = visibleWorkspaceRows.value.filter((w): w is WorkspaceGroupRow => !!w)
  return rows.length > 0 && rows.every((w) => w.collapsed)
})

/** Fold or unfold every workspace at once.
 *
 *  One toggle rather than a pair: with the list already folded, a "collapse
 *  all" that does nothing is a button that looks broken. The label and the
 *  icon follow the state so it always says what pressing it will do.
 */
function toggleAllWorkspaces(): void {
  const collapse = !allWorkspacesCollapsed.value
  for (const ws of visibleWorkspaceRows.value) {
    if (!ws) continue
    if (ws.collapsed !== collapse) emit('toggle-workspace', ws.path)
  }
}

/** Groups folded shut in the sidebar.
 *
 *  Keyed by workspace AND group: run groups are per-workspace, and the
 *  ungrouped section's id is empty in every one of them, so the id alone would
 *  fold two workspaces' loose panes together.
 *
 *  Per window and not persisted, the same judgement the workspace collapse
 *  makes: which groups you want out of the way is a property of the view you
 *  are looking at, not of the project. */
const collapsedGroups = ref<Set<string>>(new Set())
const groupKey = (wsPath: string, id: string): string => `${wsPath}\u0000${id}`
function isGroupCollapsed(wsPath: string, id: string): boolean {
  return collapsedGroups.value.has(groupKey(wsPath, id))
}
function toggleGroup(wsPath: string, id: string): void {
  const key = groupKey(wsPath, id)
  const next = new Set(collapsedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedGroups.value = next
}

/** The heading a workspace drag is hovering, for the drop line. */
const wsDragOverPath = ref<string>('')
let draggingWorkspacePath = ''

function onWsDragOver(e: DragEvent, path: string): void {
  // Values are unreadable during dragover (protected mode); the type is not.
  if (!e.dataTransfer?.types.includes('application/x-workspace-path')) return
  if (path === draggingWorkspacePath) return
  e.preventDefault()
  wsDragOverPath.value = path
}

function onWsDragLeave(path: string): void {
  if (wsDragOverPath.value === path) wsDragOverPath.value = ''
}

function onWsDrop(e: DragEvent, path: string): void {
  wsDragOverPath.value = ''
  const from = e.dataTransfer?.getData('application/x-workspace-path') ?? ''
  if (!from || from === path) return
  emit('reorder-workspace', from, path)
}
/** What the row does, for its tooltip.
 *
 *  Dragging a heading out is invisible otherwise — nothing about the row says
 *  it can be dragged, and when the window holds only one workspace it silently
 *  cannot be, which reads as broken rather than as deliberate.
 */
function wsHeadTitle(path: string): string {
  const parts: string[] = []
  if (!props.detachedWindow && path !== workspacePath.value) {
    parts.push(i18n.global.t('label.workspace-switch-hint'))
  }
  if (canDetachWorkspace.value) parts.push(i18n.global.t('label.workspace-detach-hint'))
  // Filing a project into a group is otherwise an invisible affordance: the
  // cells look like filters, and nothing says a heading can be dropped on one.
  if (canDragWorkspace.value && workspaceRails.value.length) {
    parts.push(i18n.global.t('label.workspace-group-hint'))
  }
  return parts.join(' · ')
}

function onWsDragStart(e: DragEvent, path: string): void {
  if (!canDragWorkspace.value) {
    e.preventDefault()
    return
  }
  // Its own data type, so this never reads as a pane drag to the drop targets
  // in this list (which check application/x-pane-id).
  e.dataTransfer?.setData('application/x-workspace-path', path)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  draggingWorkspacePath = path
  wsDragActive.value = true
}
function onWsDragEnd(e: DragEvent, path: string): void {
  wsDragOverPath.value = ''
  draggingWorkspacePath = ''
  wsDragActive.value = false
  // A drag released anywhere else leaves no dragleave on the strip.
  railDropId.value = null
  railOpen.value = false
  if (!canDetachWorkspace.value) return
  const outside =
    e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight
  if (outside) emit('detach-workspace', path, e.screenX, e.screenY)
}

/** Roughly what the menu occupies, for the edge flip below.
 *
 *  Measured rather than guessed would be better, but the element does not
 *  exist until this sets wsMenu — and a menu that appears in the wrong place
 *  and then jumps is worse than one placed from a constant. Kept generous:
 *  overshooting flips a menu that would have fitted, undershooting lets one
 *  hang off the edge, and only the second is a bug. */
const WS_MENU_H = 96
const WS_MENU_W = 170

function openWsMenu(ev: MouseEvent, path: string, canClose: boolean): void {
  ev.preventDefault()
  addMenuOpen.value = false
  // Right-clicking near the bottom put the menu under the status bar, which
  // paints over it: it opened downward from the cursor with nothing to stop it
  // leaving the window. Flip it above the cursor instead — the same way a
  // native menu does — and keep it inside the right edge.
  const y = ev.clientY + WS_MENU_H > window.innerHeight
    ? Math.max(0, ev.clientY - WS_MENU_H)
    : ev.clientY
  const x = Math.max(0, Math.min(ev.clientX, window.innerWidth - WS_MENU_W))
  wsMenu.value = { path, canClose, x, y }
}
function closeWsMenu(): void {
  wsMenu.value = null
}
function onWsMenuKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeWsMenu()
}
watch(wsMenu, (open) => {
  if (open) {
    document.addEventListener('click', closeWsMenu)
    document.addEventListener('keydown', onWsMenuKeydown)
    document.addEventListener('scroll', closeWsMenu, true)
  } else {
    document.removeEventListener('click', closeWsMenu)
    document.removeEventListener('keydown', onWsMenuKeydown)
    document.removeEventListener('scroll', closeWsMenu, true)
  }
})
onUnmounted(() => {
  document.removeEventListener('click', closeWsMenu)
  document.removeEventListener('keydown', onWsMenuKeydown)
  document.removeEventListener('scroll', closeWsMenu, true)
})

function wsMenuAction(kind: 'reveal' | 'copy' | 'close'): void {
  const m = wsMenu.value
  if (!m) return
  closeWsMenu()
  if (kind === 'reveal') emit('reveal-workspace-folder', m.path)
  else if (kind === 'copy') void navigator.clipboard?.writeText(m.path)
  else emit('close-workspace', m.path)
}
// Fixed, not absolute: the pane list scrolls under `overflow-y: auto`, which
// would clip a menu positioned inside it.
const addMenuAnchor = ref<{ top: number; bottom: number; right: number } | null>(null)
/** Tallest the ＋ menu gets: the roster scroller's cap (`.ws-add-scroll`,
 *  360px) plus the fixed furniture around it — role picker, two dividers,
 *  the Terminal and Manual-spawn buttons, and the menu's own padding. Only
 *  used to decide whether the menu opens downwards or flips up, so it has to
 *  track that CSS cap; leaving it at the old 300 would have let a menu open
 *  downwards into a gap it no longer fits in. */
const ADD_MENU_MAX_H = 450

const addMenuStyle = computed(() => {
  const a = addMenuAnchor.value
  if (!a) return {}
  // Flip upwards when there is not enough room below the button.
  const below = window.innerHeight - a.bottom
  return below < ADD_MENU_MAX_H && a.top > below
    ? { bottom: `${window.innerHeight - a.top + 4}px`, right: `${a.right}px` }
    : { top: `${a.bottom + 4}px`, right: `${a.right}px` }
})

function toggleAddMenu(ev: MouseEvent, wsPath = '', groupId = ''): void {
  if (!canSpawn.value) return
  if (addMenuOpen.value && addMenuWorkspace.value === wsPath && addMenuGroup.value === groupId) {
    addMenuOpen.value = false
    return
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  addMenuAnchor.value = { top: r.top, bottom: r.bottom, right: window.innerWidth - r.right }
  addMenuWorkspace.value = wsPath
  addMenuGroup.value = groupId
  addMenuOpen.value = true
}

/** Pick a CLI from the menu and open it. Writing pickedAgent first means the
 *  card agrees with what just happened, and that spawn() takes its usual path —
 *  including the guided install for a CLI that is not there. */
function spawnAs(agentKey: string): void {
  pickedAgent.value = agentKey
  spawnWorkspaceOverride.value = addMenuWorkspace.value
  spawnGroupOverride.value = addMenuGroup.value
  addMenuOpen.value = false
  spawn(agentKey)
}

/** The plain-shell spec, kept out of manualAgentSpecs because the agent
 *  dropdown and "Handle Issue As…" are both about CLIs. */
const terminalSpec = computed(() => props.agentSpecs.find((s) => s.agentKey === 'terminal'))

/** The ＋ menu's plain shell.
 *
 *  Mirrors openTerminal, but into the workspace whose heading opened the menu.
 *  Never with a role: role text is injected into a CLI's prompt, and a shell
 *  would simply print it — which is why openTerminal sends an empty roleKey too,
 *  and why this sits with the actions rather than among the agents, where the
 *  role select above would look like it applied.
 */
function openTerminalFromMenu(): void {
  // Menu first, like spawnAs: a click that turns out to be a no-op still
  // dismisses the menu, rather than leaving it open with nothing happening.
  const ws = addMenuWorkspace.value || workspacePath.value
  const group = addMenuGroup.value
  addMenuOpen.value = false
  if (!canSpawn.value) return
  emit('spawn', { agentKey: 'terminal', roleKey: '', stageId: '', workspacePath: ws, runGroupId: group || undefined })
}

function openSpawnCardFromMenu(): void {
  spawnGroupOverride.value = addMenuGroup.value
  addMenuOpen.value = false
  manualSpawnOpen.value = true
}

function onAddMenuKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') addMenuOpen.value = false
}

function onSpawnModalKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') manualSpawnOpen.value = false
}
watch(manualSpawnOpen, (open) => {
  if (open) {
    modalAgent.value = pickedAgent.value
    document.addEventListener('keydown', onSpawnModalKeydown)
  } else document.removeEventListener('keydown', onSpawnModalKeydown)
})
onUnmounted(() => document.removeEventListener('keydown', onSpawnModalKeydown))
function closeAddMenu(): void {
  addMenuOpen.value = false
}

watch(addMenuOpen, (open) => {
  if (open) {
    // The badge on a missing CLI is only as fresh as the last check, and the
    // card refreshes on its dropdown's focus — this menu has no dropdown.
    void refreshCliStatus()
    document.addEventListener('click', closeAddMenu)
    document.addEventListener('keydown', onAddMenuKeydown)
    // Capture: the pane list is the element that scrolls, and its scroll
    // events do not bubble. Without this the menu would hang in mid-air over
    // whatever scrolled into the button's old place.
    document.addEventListener('scroll', closeAddMenu, true)
  } else {
    document.removeEventListener('click', closeAddMenu)
    document.removeEventListener('keydown', onAddMenuKeydown)
    document.removeEventListener('scroll', closeAddMenu, true)
  }
})
onUnmounted(() => {
  document.removeEventListener('click', closeAddMenu)
  document.removeEventListener('keydown', onAddMenuKeydown)
  document.removeEventListener('scroll', closeAddMenu, true)
})

function spawn(agentKey: string = activeSpawnAgent.value): void {
  if (!canSpawn.value) return
  // Spawning a CLI we know is missing only produces a pane that dies with 127.
  // Offer the guided install instead of that dead end — but re-detect first,
  // since the cached status may predate an install the user just finished.
  if (missingClis.value.has(agentKey)) {
    void spawnOrOfferInstall(agentKey)
    return
  }
  emitSpawn(agentKey)
}

async function spawnOrOfferInstall(agentKey: string): Promise<void> {
  cliStatusFetchedAt = 0
  await refreshCliStatus()
  if (!missingClis.value.has(agentKey)) {
    emitSpawn(agentKey)
    return
  }
  const spec = manualAgentSpecs.value.find((s) => s.agentKey === agentKey)
  spawnWorkspaceOverride.value = ''
  spawnGroupOverride.value = ''
  emit('install-cli', { agentKey, label: spec?.label ?? agentKey })
}

function openTerminal(): void {
  if (!canSpawn.value) return
  emit('spawn', {
    agentKey: 'terminal',
    roleKey: '',
    stageId: '',
    workspacePath: workspacePath.value
  })
}

function startPipeline(): void {
  if (!canRunPipeline.value) return
  emit('pipeline-start', {
    task: taskDescription.value.trim(),
    workspacePath: workspacePath.value,
    // Pass the opened pipeline id so App.vue activates it first if it differs from active
    pipelineId: openedPipelineId.value || undefined,
  })
  backToList()
}

const statusColor = computed(() => {
  switch (props.backendStatus) {
    case 'connected':
      return '#3fb950'
    case 'connecting':
    case 'starting':
      return '#d29922'
    case 'disconnected':
      return '#8b949e'
    default:
      return '#f85149'
  }
})

const runningCount = computed(
  () => props.panes.filter((p) => p.status === 'running' || p.status === 'starting').length
)

// Running agent panes an issue can be dispatched to (id + display label).
const dispatchTargets = computed(() =>
  props.panes
    .filter((p) => p.status === 'running' || p.status === 'starting')
    .map((p) => ({ id: p.id, label: p.slotLabel || p.roleLabel || p.agentLabel }))
)

function publishGitContributionState(): void {
  window.agentTeam?.setGitContributionState?.({
    workspacePath: workspacePath.value,
    analyzerModel: props.analyzerModel,
    dispatchTargets: dispatchTargets.value,
    availableAgents: availableAgents.value,
    issueHandoffs: props.issueHandoffs ?? {},
  })
}

watch(
  [workspacePath, () => props.analyzerModel, dispatchTargets, availableAgents, () => props.issueHandoffs],
  publishGitContributionState,
  { immediate: true, deep: true },
)

onUnmounted(() => window.agentTeam?.clearGitContributionState?.())

const pipelineProgress = computed(() => {
  const total = props.pipeline.totalStages || props.stages.length || 1
  if (props.pipeline.state === 'idle') return 0
  if (props.pipeline.state === 'completed') return 100
  return Math.round(((props.pipeline.stageIndex + 1) / total) * 100)
})

const pipelineCurrentStage = computed<Stage | null>(() => {
  if (props.pipeline.state !== 'running') return null
  return props.stages[props.pipeline.stageIndex] ?? null
})

const pipelineNextStage = computed<Stage | null>(() => {
  if (props.pipeline.state !== 'running') return null
  return props.stages[props.pipeline.stageIndex + 1] ?? null
})

function injectionLabel(status: ActivePaneView['injectionStatus']): string {
  switch (status) {
    case 'pending':
      return 'role: waiting'
    case 'scheduled':
      return 'role: injecting'
    case 'sent':
      return 'role: injected'
    case 'failed':
      return 'role: inject failed'
    case 'skipped':
      return 'role: skipped'
  }
}

function preparationLabel(status: ActivePaneView['preparationStatus']): string {
  switch (status) {
    case 'starting':
      return 'setup: starting CLI'
    case 'checking-dialog':
      return 'setup: checking dialog'
    case 'settling':
      return 'setup: waiting prompt'
    case 'injecting-role':
      return 'setup: injecting role'
    case 'waiting-agent':
      return 'setup: waiting agent'
    case 'ready':
      return 'setup: ready'
    case 'failed':
      return 'setup: failed'
    default:
      return ''
  }
}

function kickoffLabel(status?: ActivePaneView['kickoffStatus']): string {
  if (!status || status === 'none') return ''
  switch (status) {
    case 'pending':
      return '· kickoff: queued'
    case 'sent':
      return '· kickoff: sent'
    // Written, but the only echo we got was the buffer growing — which a
    // booting CLI does regardless. Say so rather than claiming it was sent.
    case 'unverified':
      return '· kickoff: unverified'
    case 'failed':
      return '· kickoff: failed'
  }
}

// ── Active Agents list: compact rows, one expands at a time (accordion) ──────
// A click focuses the pane AND toggles the row's detail body; collapsed rows
// stay one line tall so a long agent list can be scanned without scrolling.
const expandedPaneId = ref<string | null>(null)

function onAgentLineClick(paneId: string, ev?: MouseEvent): void {
  emit('focus-pane', paneId, ev)
  // A modifier click is a multi-select gesture — leave the accordion as-is.
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) return
  expandedPaneId.value = expandedPaneId.value === paneId ? null : paneId
}

// The detail body says "this is the pane you are on", so it only holds while
// this window has the OS focus. Each workspace window renders its own
// ControlPane and nothing tells a window that another one took over, so
// without this gate a window left in the background keeps a row expanded
// (and `focusPaneId` falls back to the first pane, so one row is always a
// candidate). The state itself is kept, not cleared: coming back to the
// window restores the row the user had open.
const windowFocused = ref(document.hasFocus())
function onWindowFocus(): void {
  windowFocused.value = true
}
function onWindowBlur(): void {
  windowFocused.value = false
}
window.addEventListener('focus', onWindowFocus)
window.addEventListener('blur', onWindowBlur)
onUnmounted(() => {
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('blur', onWindowBlur)
})

/** Whether an agent row shows its detail body: the accordion row the user
 *  clicked, or the focused pane — either way only while this window is on top. */
function isRowExpanded(paneId: string): boolean {
  if (!windowFocused.value) return false
  return expandedPaneId.value === paneId || props.focusPaneId === paneId
}

// ── Active Agents list: drag-reorder (mirrors the TerminalPane header drop) ──
// Dragging one agent-line onto another agent-item emits 'reorder-pane'; App.vue
// splices `panes.value`, so the Grid and this list reorder together. During
// dragover the payload is unreadable (dataTransfer protected mode), so hovering
// is gated on the data TYPE plus a local drag-source id — the actual id check
// happens on drop.
const reorderDragOverId = ref('')
let draggingPaneId = ''
// Every pane the in-flight drag moves: the whole multi-selection when the
// grabbed row is part of one (App.vue reorders the batch), else just that row.
// Rendered as dragging, and excluded from being a drop target for itself.
const draggingBatchIds = ref<string[]>([])

function onAgentDragStart(e: DragEvent, paneId: string): void {
  if (!e.dataTransfer) return
  const batch = resolveDragBatch(paneId, props.selectedPaneIds, props.panes.map((p) => p.id))
  e.dataTransfer.setData('application/x-pane-id', paneId)
  // Only a real batch writes the MIME — its presence is what marks a batch drag
  // for drop targets, including ones in another window.
  if (batch.length > 1) e.dataTransfer.setData(PANE_BATCH_MIME, batch.join('\n'))
  setBatchDragImage(
    e.dataTransfer,
    batch.length,
    i18n.global.t('action.dragging-panes', { count: batch.length })
  )
  e.dataTransfer.effectAllowed = 'move'
  draggingPaneId = paneId
  draggingBatchIds.value = batch
}

function onAgentDragEnd(e: DragEvent): void {
  const paneId = draggingPaneId
  const batch = draggingBatchIds.value
  draggingPaneId = ''
  draggingBatchIds.value = []
  reorderDragOverId.value = ''
  // Cross-window handoff, same contract as TerminalPane's header dragend:
  // dropEffect 'none' ⇒ nothing in this window consumed the drag, so let main
  // route the pane to whatever window sits under the release point.
  if (!paneId || e.dataTransfer?.dropEffect !== 'none') return
  window.agentTeam?.cliPaneDragEnd?.(paneId, e.screenX, e.screenY, batch)
}

function onAgentDragOver(e: DragEvent, paneId: string): void {
  if (
    draggingPaneId === paneId
    || draggingBatchIds.value.includes(paneId)
    || !e.dataTransfer?.types.includes('application/x-pane-id')
  ) return
  e.preventDefault()
  reorderDragOverId.value = paneId
}

function onAgentDragLeave(paneId: string): void {
  if (reorderDragOverId.value === paneId) reorderDragOverId.value = ''
}

function onAgentDrop(e: DragEvent, paneId: string): void {
  reorderDragOverId.value = ''
  const draggedId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (!draggedId || draggedId === paneId) return
  emit('reorder-pane', draggedId, paneId)
}

function onWorkspaceDrop(e: DragEvent): void {
  const paths = extractDropPaths(e)
  if (!paths.length) return
  workspacePath.value = paths[0]
}

async function onTaskDrop(e: DragEvent): Promise<void> {
  isTaskDragOver.value = false
  const dropped = extractDropPaths(e)
  if (!dropped.length) return
  // Read the caret before awaiting — the drop event is only live synchronously.
  const el = e.target as HTMLTextAreaElement
  const caret = el.selectionStart
  const text = (await stabilizeDroppedPaths(dropped)).join(' ')
  const cur = taskDescription.value
  const start = Math.min(caret ?? cur.length, cur.length)
  taskDescription.value = cur.slice(0, start) + text + cur.slice(start)
}

</script>

<template>
  <aside class="sidebar" :class="{ 'is-collapsed': collapsed }">
    <!-- Collapsed rail: one icon per tab — click expands and switches tab. -->
    <div v-if="collapsed" class="rail">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        class="rail-btn"
        :class="{ active: sidebarTab === t.id || (t.id === 'git' && gitPluginTab?.tabId === sidebarTab) }"
        :title="$t('layout.expand')"
        @click="selectSidebarTab(t.id)"
      >
        <span
          v-if="t.id === 'git' && gitPluginTab && isMonoPluginIcon(gitPluginTab)"
          class="plugin-tab-icon plugin-tab-icon--mono"
          :style="pluginIconMask(gitPluginTab)"
          aria-hidden="true"
        ></span>
        <img
          v-else-if="t.id === 'git' && gitPluginTab && hasPluginIcon(gitPluginTab)"
          class="plugin-tab-icon"
          :src="gitPluginTab.icon ?? ''"
          width="15"
          height="15"
          alt=""
          @error="markPluginIconFailed(gitPluginTab)"
        />
        <svg v-else-if="!t.icon" class="rail-icon rail-icon-git" width="18" height="18"
             viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path :d="t.path"/></svg>
        <span v-else class="rail-icon">{{ t.icon }}</span>
        <span class="rail-label">{{ $t(t.label) }}</span>
        <span v-if="t.id === 'git' && gitChangesCount > 0" class="rail-badge">{{ gitChangesCount > 99 ? '99+' : gitChangesCount }}</span>
      </button>
      <button
        v-for="pluginTab in genericPluginTabs"
        :key="pluginTab.tabId"
        class="rail-btn"
        :class="{ active: sidebarTab === pluginTab.tabId }"
        :title="pluginTab.title"
        @click="selectSidebarTab(pluginTab.tabId)"
      >
        <span
          v-if="isMonoPluginIcon(pluginTab)"
          class="plugin-tab-icon plugin-tab-icon--mono"
          :style="pluginIconMask(pluginTab)"
          aria-hidden="true"
        ></span>
        <img
          v-else-if="hasPluginIcon(pluginTab)"
          class="plugin-tab-icon"
          :src="pluginTab.icon ?? ''"
          width="15"
          height="15"
          alt=""
          @error="markPluginIconFailed(pluginTab)"
        />
        <span v-else class="plugin-tab-fallback" aria-hidden="true">◇</span>
        <span class="rail-label">{{ pluginTab.title }}</span>
      </button>
    </div>

    <!-- ── Top-level tab nav (icon style, Cursor-like) ────────────────────── -->
    <div class="sidebar-tabs">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        :class="[
          'tab-btn',
          { 'plugin-tab-btn': t.id === 'git' && !legacyGitRecovery && gitPluginTab },
          { active: sidebarTab === t.id || (t.id === 'git' && gitPluginTab?.tabId === sidebarTab) }
        ]"
        :data-legacy-git-tab="t.id === 'git' && legacyGitRecovery ? '' : undefined"
        :data-plugin-contribution="t.id === 'git' && !legacyGitRecovery ? gitPluginTab?.contributionKey : undefined"
        :title="t.id === 'git' && gitPluginTab ? `${gitPluginTab.title} (⌘4)` : t.title"
        @click="selectSidebarTab(t.id)"
      >
        <template v-if="t.id === 'git' && !legacyGitRecovery && gitPluginTab">
          <span
            v-if="isMonoPluginIcon(gitPluginTab)"
            class="plugin-tab-icon plugin-tab-icon--mono"
            :style="pluginIconMask(gitPluginTab)"
            aria-hidden="true"
          ></span>
          <img
            v-else-if="hasPluginIcon(gitPluginTab)"
            class="plugin-tab-icon"
            :src="gitPluginTab.icon ?? ''"
            width="15"
            height="15"
            alt=""
            @error="markPluginIconFailed(gitPluginTab)"
          />
          <span v-else class="plugin-tab-fallback" aria-hidden="true">◇</span>
        </template>
        <svg v-else width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path :d="t.path"/></svg>
        <span v-if="t.id === 'git' && gitChangesCount > 0" class="git-badge">{{ gitChangesCount > 99 ? '99+' : gitChangesCount }}</span>
      </button>
      <button
        v-for="pluginTab in genericPluginTabs"
        :key="pluginTab.tabId"
        :class="['tab-btn', 'plugin-tab-btn', { active: sidebarTab === pluginTab.tabId }]"
        :data-plugin-contribution="pluginTab.contributionKey"
        :title="pluginTab.title"
        @click="selectSidebarTab(pluginTab.tabId)"
      >
        <span
          v-if="isMonoPluginIcon(pluginTab)"
          class="plugin-tab-icon plugin-tab-icon--mono"
          :style="pluginIconMask(pluginTab)"
          aria-hidden="true"
        ></span>
        <img
          v-else-if="hasPluginIcon(pluginTab)"
          class="plugin-tab-icon"
          :src="pluginTab.icon ?? ''"
          width="15"
          height="15"
          alt=""
          @error="markPluginIconFailed(pluginTab)"
        />
        <span v-else class="plugin-tab-fallback" aria-hidden="true">◇</span>
      </button>
      <span class="tab-spacer"></span>
      <button class="tab-collapse" :title="$t('layout.collapse')" @click="emit('update:collapsed', true)">‹</button>
    </div>

    <!-- ── Explorer / plugin regions (shared split: panel on top, agent dock pinned at bottom) ── -->
    <div v-show="sidebarTab === 'explorer' || sidebarTab === 'git' || sidebarTab === 'plans' || isPluginTab(sidebarTab)" class="pane-split">
      <div
        class="part-top"
        :class="{ 'part-top-plugin': sidebarTab !== 'explorer' && !legacyGitRecovery && !legacyPlansRecovery }"
        style="flex: 1"
      >
        <ExplorerPane
          v-if="backend && visibleTabIds.has('explorer')"
          v-show="sidebarTab === 'explorer'"
          :workspace-path="workspace ?? ''"
          :backend="backend"
        />
        <!-- Generic plugin views are mounted by contribution key; the renderer
             never receives the Host-generated instance id. -->
        <PluginRegionHost
          v-for="pluginTab in genericPluginTabs"
          :key="pluginTab.contributionKey"
          :contribution="pluginTab"
          :workspace-path="workspace ?? ''"
          :visible="!collapsed && sidebarTab === pluginTab.tabId"
        />
        <PluginRegionHost
          v-if="gitPluginTab && !legacyGitRecovery"
          :key="gitPluginTab.contributionKey"
          :contribution="gitPluginTab"
          :workspace-path="workspace ?? ''"
          :visible="!collapsed && (sidebarTab === gitPluginTab.tabId || sidebarTab === 'git')"
        />
        <PluginRegionHost
          v-if="plansPluginTab && !legacyPlansRecovery"
          :key="plansPluginTab.contributionKey"
          :contribution="plansPluginTab"
          :workspace-path="workspace ?? ''"
          :visible="!collapsed && sidebarTab === 'plans'"
          :before-prepare="projectPlansPreferencesBeforePrepare"
        />
        <template v-if="legacyGitRecovery && backend && sidebarTab === 'git'">
          <div class="legacy-recovery-label" data-legacy-recovery-label>Legacy recovery</div>
          <GitPluginHostSlot
            :workspace-path="workspace ?? ''"
            :visible="true"
            :backend="backend"
            :analyzer-model="analyzerModel"
            :dispatch-targets="dispatchTargets"
            :available-agents="availableAgents"
            :issue-handoffs="issueHandoffs"
            @changes-count="$emit('changes-count', $event)"
            @open-workspace="$emit('workspace-browse', $event)"
            @dispatch-issue="$emit('dispatch-issue', $event)"
            @spawn-for-issue="$emit('spawn-for-issue', $event)"
            @focus-pane="$emit('focus-pane', $event)"
            @open-git-accounts="$emit('open-git-accounts')"
          />
        </template>
        <template v-if="legacyPlansRecovery && backend && sidebarTab === 'plans'">
          <div class="legacy-recovery-label" data-plans-legacy-recovery-label>Legacy recovery</div>
          <PlanPane
            class="plans-split"
            :workspace-path="workspace ?? ''"
            :backend="backend"
          />
        </template>
      </div>
    </div>

    <!-- ── Pipeline tab · list view (full-height scroll) ─────────────────── -->
    <div v-if="visibleTabIds.has('pipeline') && sidebarTab === 'pipeline' && sidebarView === 'list'" class="pipeline-split">
    <div class="part-top">

    <section class="block panel-section">
      <label class="checkbox-row">
        <input v-model="yoloLocal" type="checkbox" />
        <span>
          <strong>{{ $t('label.yolo-mode') }}</strong> {{ $t('label.yolo-bypass') }}
          <span class="muted-inline">({{ yoloVendors }})</span>
        </span>
      </label>
    </section>

    <!-- ── Pipeline list ────────────────────────────────────────────────── -->
    <section class="block panel-section">
      <div class="row between">
        <label class="lbl">{{ $t('label.pipelines') }}</label>
        <button class="ghost manage-btn" title="Manage pipelines" @click="openPipelineManager()">⚙</button>
      </div>
      <ul v-if="pipelines && pipelines.length && pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="pipeline-list">
        <li
          v-for="p in pagedPipelines"
          :key="p.id"
          class="pipeline-item"
          :class="{ 'pipeline-active': p.id === activePipelineId }"
          @click="openPipelineDetail(p.id)"
        >
          <span class="pipeline-item-name">{{ p.name }}</span>
          <span class="pipeline-item-meta">{{ p.stage_count }} stages</span>
          <span
            class="pipeline-item-badge"
            :class="isPipelineRunning(p.id) ? 'running'
              : p.id === activePipelineId && pipeline.state === 'completed' ? 'done'
              : existingProject?.pipelineId === p.id && existingProject?.nextStageIndex < 0 ? 'done'
              : 'idle'"
          >
            {{ isPipelineRunning(p.id) ? '● running'
              : p.id === activePipelineId && pipeline.state === 'completed' ? `✓ ${existingProject?.runCount ?? 1} done`
              : existingProject?.pipelineId === p.id && existingProject?.nextStageIndex < 0 ? `✓ ${existingProject.runCount} done`
              : '○ idle' }}
          </span>
        </li>
      </ul>
      <p v-else-if="pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="hint">{{ $t('label.no-pipelines') }}</p>
      <div v-if="pipelinePageCount > 1 && pipeline.state !== 'running' && pipeline.state !== 'aborted'" class="pipeline-pagination">
        <button class="ghost pg-btn" :disabled="pipelinePage === 0" @click="pipelinePage--">‹</button>
        <span class="pg-info">{{ pipelinePage + 1 }} / {{ pipelinePageCount }}</span>
        <button class="ghost pg-btn" :disabled="pipelinePage >= pipelinePageCount - 1" @click="pipelinePage++">›</button>
      </div>
      <!-- ── Resume card (workspace re-opened with unfinished pipeline) ── -->
      <template v-if="pipeline.state !== 'running' && existingProject && existingProject.state !== 'idle' && existingProject.nextStageIndex >= 0 && !resumeMatchesActivePipeline">
        <div class="pipeline-running-divider"></div>
        <!-- Resume is gated on the run's own pipeline being active, but hiding
             the card entirely left an unfinished run invisible. Say so, and let
             the button take the switch-then-resume path. -->
        <div class="resume-mismatch-card">
          <p class="resume-mismatch-text">
            {{ $t('label.resume-other-pipeline', { name: resumeOwnerPipelineName }) }}
          </p>
          <button class="ghost wide" @click="emit('pipeline-resume')">
            {{ $t('action.switch-and-resume') }}
          </button>
        </div>
      </template>
      <template v-if="pipeline.state !== 'running' && existingProject && existingProject.state !== 'idle' && existingProject.nextStageIndex >= 0 && resumeMatchesActivePipeline">
        <div class="pipeline-running-divider"></div>
        <div class="resume-card">
          <div class="resume-head">
            <strong>↻ Resume existing pipeline</strong>
            <span class="resume-state" :data-state="existingProject.state">{{ existingProject.state }}</span>
          </div>
          <div class="resume-meta">
            <span>{{ existingProject.stagesCompleted }}/{{ existingProject.totalStages }} stages done</span>
            <span class="dot">·</span>
            <span>updated {{ existingProject.updatedAt }}</span>
          </div>
          <div v-if="existingProject.taskDescription" class="resume-task">
            {{ existingProject.taskDescription.length > 200
              ? existingProject.taskDescription.slice(0, 200) + '…'
              : existingProject.taskDescription }}
          </div>
          <div class="row">
            <button class="primary wide" @click="emit('pipeline-resume')">
              ▶ Resume from Stage {{ String(existingProject.nextStageIndex + 1).padStart(2, '0') }}
            </button>
            <button
              class="danger"
              @click="confirmingRestart = true"
              :title="$t('action.discard-progress')"
            >
              ↺ Start over
            </button>
          </div>
        </div>
      </template>

      <!-- ── Running widget inline ── -->
      <template v-if="pipeline.state === 'running' || pipeline.state === 'aborted'">
        <div class="pipeline-running-divider"></div>
        <div class="pipeline-running-name">
          <div class="prn-title">
            ▶ {{ pipelines?.find(p => p.id === activePipelineId)?.name ?? $t('label.pipelines') }}
          </div>
          <div v-if="pipeline.task" class="prn-task">{{ pipeline.task }}</div>
          <div class="prn-meta">
            <span v-if="autoAnswerEnabled" class="prn-auto">{{ $t('label.full-auto') }} · {{ analyzerModelLocal }}</span>
            <span v-else class="prn-manual">{{ $t('label.manual-confirm') }}</span>
          </div>
        </div>
        <div v-if="pipeline.state === 'running'" class="pipeline-running">
          <div class="progress">
            <div class="bar" :style="{ width: pipelineProgress + '%' }"></div>
          </div>
          <div class="pipeline-line">
            Stage {{ pipeline.stageIndex + 1 }} / {{ pipeline.totalStages }}
            <span v-if="pipelineCurrentStage" class="muted">· {{ pipelineCurrentStage.shortTitle }}</span>
          </div>
          <div class="row pipeline-row">
            <button class="primary wide" :disabled="!pipelineNextStage" @click="emit('pipeline-next')">
              {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : $t('action.finish') }}
            </button>
            <button class="danger" @click="emit('pipeline-abort')">{{ $t('action.abort') }}</button>
          </div>
        </div>
        <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
          {{ $t('label.pipeline-aborted') }}
        </p>
      </template>
    </section>

    </div><!-- /part-top -->
    </div><!-- end pipeline tab · list view -->

    <!-- ── Agents tab ────────────────────────────────────────────────────── -->
    <div v-if="visibleTabIds.has('agents') && sidebarTab === 'agents'" class="agents-split">
    <div class="part-bottom">

    <!-- ── Active agents ──────────────────────────────────────────────────── -->
    <section class="block panel-section">
      <div class="row between agent-list-hdr">
        <!-- Each workspace row carries its own count now, so the header is a
             plain section title rather than a running/total tally. -->
        <!-- On a rail the heading names it: the list below is a subset, and
             nothing else on screen would say so. -->
        <label class="lbl">{{ workspaces?.length ? (activeRailName || $t('label.workspace')) : $t('label.active-agents', { running: runningCount, total: panes.length }) }}</label>
        <!-- Adds a WORKSPACE, not an agent: the per-workspace ＋ below opens
             an agent inside one. Always present — the section is a list of
             projects whether or not any is grouped yet. -->
        <button
          v-if="!detachedWindow && localWorkspaceRows.some((w) => w)"
          class="hdr-fold-ws"
          :title="allWorkspacesCollapsed ? $t('action.expand-all-folders') : $t('action.collapse-all-folders')"
          :aria-label="allWorkspacesCollapsed ? $t('action.expand-all-folders') : $t('action.collapse-all-folders')"
          @click="toggleAllWorkspaces"
        >
          <!-- The explorer's collapse-all glyph: two offset frames, dashed to
               fold and crossed to unfold. The front frame is filled with the
               sidebar's own background so the overlap reads as depth. -->
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="4.5" y="1.5" width="10" height="10" rx="1" />
            <rect x="1.5" y="4.5" width="10" height="10" rx="1" fill="var(--bg-base)" />
            <path :d="allWorkspacesCollapsed ? 'M4 9.5h5M6.5 7v5' : 'M4 9.5h5'" />
          </svg>
        </button>
        <button
          v-if="!detachedWindow"
          class="hdr-add-ws"
          :title="$t('action.open-workspace-picker')"
          :aria-label="$t('action.open-workspace-picker')"
          @click="emit('open-workspace-picker')"
        >＋</button>
        <!-- Both of these act on one workspace's panes, so once the list is
             grouped they belong on that workspace's own row. This is the
             ungrouped fallback. -->
        <div v-if="!workspaces?.length" class="agent-header-actions">
          <button
            class="agent-rebuild-all-btn"
            :class="{ busy: rebuildingAll }"
            :disabled="!canRebuildAll || rebuildingAll"
            :title="$t('action.rebuild-all-cli-panes')"
            :aria-label="$t('action.rebuild-all-cli-panes')"
            @click="emit('rebuild-all')"
          >
            <RebuildIcon />
          </button>
          <button class="history-btn" :title="$t('label.history')" @click="emit('open-history')"><HistoryIcon /></button>
        </div>
      </div>
      <!-- Only the ungrouped list swaps itself out for the empty message. A
           grouped one keeps its workspace rows and puts the message under the
           one that is empty, because those rows hold the ＋ that opens an
           agent — the sidebar must never lose its own entry point. -->
      <div v-if="panes.length === 0 && !hasWorkspaceRows" class="empty">{{ $t('label.no-agents-running') }}</div>
      <div v-else class="ws-rail-wrap" @dragover="onWrapDragOver">
        <!-- One glyph per group of workspaces, All pinned first. Filters the
             list beside it; moves nothing else. -->
        <!-- An 8px strip on the very edge: one bar per group, the colour
             standing in for the name. Everything wider than that — names,
             counts, the ＋ — lives in a flyout that OVERLAYS the list on
             hover, so the groups cost the workspace names no width at all.

             `v-show` on the flyout, not `v-if`: it is the keyboard-reachable
             copy of the strip, and a menu that does not exist until the
             pointer arrives cannot be tabbed to. -->
        <div
          v-if="showRail"
          class="ws-strip"
          :class="{ open: railOpen }"
          @mouseenter="railOpen = true"
          @mouseleave="onStripLeave"
          @dragover="onStripDragOver"
          @dragleave="onStripDragLeave"
        >
          <div class="ws-stick">
            <div
              class="ws-bars"
              :class="{ hot: wsDragActive }"
              role="group"
              :aria-label="$t('label.workspace-groups')"
            >
              <button
                v-for="cell in (workspaceRails.length ? railCells : [])"
                :key="cell.id || 'all'"
                class="ws-bar"
                :class="{
                  on: cell.active,
                  drop: railDropId === cell.id,
                  dim: cell.empty && !cell.active,
                  cur: cell.hasCurrent,
                  all: !cell.id,
                }"
                :style="cell.color ? { background: cell.color } : undefined"
                :aria-pressed="cell.active"
                :title="`${cell.name} · ${cell.count}`"
                @click="selectRail(cell.id)"
                @contextmenu="openRailMenu($event, cell.id)"
                @dragover="onRailDragOver($event, cell.id)"
                @dragenter="onRailDragOver($event, cell.id)"
                @dragleave="onRailDragLeave(cell.id)"
                @drop.prevent="onRailDrop($event, cell.id)"
              ></button>
              <button
                class="ws-bar ws-bar-add"
                :title="$t('action.new-workspace-group')"
                :aria-label="$t('action.new-workspace-group')"
                @click.stop="startCreateRail($event)"
              ></button>
            </div>

            <div v-show="railOpen" class="ws-flyout">
              <button
                v-for="cell in (workspaceRails.length ? railCells : [])"
                :key="cell.id || 'all'"
                class="ws-rcell"
                :class="{ on: cell.active, drop: railDropId === cell.id, dim: cell.empty && !cell.active }"
                :aria-pressed="cell.active"
                @click="selectRail(cell.id)"
                @contextmenu="openRailMenu($event, cell.id)"
                @dragover="onRailDragOver($event, cell.id)"
                @dragenter="onRailDragOver($event, cell.id)"
                @dragleave="onRailDragLeave(cell.id)"
                @drop.prevent="onRailDrop($event, cell.id)"
              >
                <span
                  class="ws-rswatch"
                  :class="{ tint: !!cell.color }"
                  :style="cell.color ? { '--tint': cell.color } : undefined"
                ><span class="ws-rglyph">{{ cell.glyph }}</span></span>
                <span class="ws-rname-t">{{ cell.name }}</span>
                <!-- You are still working in this group even while looking at
                     another one. Nothing else on screen would say so. -->
                <span v-if="cell.hasCurrent" class="ws-rdot"></span>
                <span v-if="cell.count" class="ws-rbump">{{ cell.count }}</span>
              </button>
              <button class="ws-rcell ws-radd" @click.stop="startCreateRail($event)">
                <span class="ws-rswatch ws-rswatch--add">＋</span>
                <span class="ws-rname-t">{{ $t('action.new-workspace-group') }}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="ws-rail-body">
      <ul class="agent-list">
        <template v-for="ws in visibleWorkspaceRows" :key="ws?.path ?? '\u0000ungrouped'">
        <!-- The row is the switch. It was the name alone, which is a few
             characters wide with nothing to say it does anything — the caret,
             the two actions and ＋ all stop propagation, so they keep working. -->
        <li
          v-if="ws"
          class="ws-head ws-head--current"
          :class="{
            'ws-head--viewing': ws.path === workspacePath,
            'ws-head--switchable': !detachedWindow && ws.path !== workspacePath,
            'ws-head--drop': wsDragOverPath === ws.path,
          }"
          :title="wsHeadTitle(ws.path)"
          :draggable="canDragWorkspace"
          @dragstart="onWsDragStart($event, ws.path)"
          @dragend="onWsDragEnd($event, ws.path)"
          @dragover="onWsDragOver($event, ws.path)"
          @dragenter="onWsDragOver($event, ws.path)"
          @dragleave="onWsDragLeave(ws.path)"
          @drop.prevent="onWsDrop($event, ws.path)"
          @click="!detachedWindow && ws.path !== workspacePath && emit('switch-to-workspace', ws.path)"
          @contextmenu="openWsMenu($event, ws.path, ws.path !== workspacePath || canCloseCurrent)"
        >
          <button
            class="ws-caret"
            :title="ws.collapsed ? $t('action.expand-subtree') : $t('action.collapse-subtree')"
            @click.stop="emit('toggle-workspace', ws.path)"
          >{{ ws.collapsed ? '›' : '⌄' }}</button>
          <span class="ws-icon"><FolderIcon /></span>
          <span class="ws-text" :title="ws.path">
            <span class="ws-line">
              <span class="ws-name">{{ ws.label }}</span>
              <span class="ws-count" v-bind="countBadgeAttrs(wsCountStates.get(ws.path))">{{ ws.count }}</span>
            </span>
            <span class="ws-path">{{ ws.displayPath }}</span>
          </span>
          <button
            class="ws-act"
            :class="{ busy: rebuildingAll }"
            :disabled="!wsCanRebuild(ws.path) || rebuildingAll"
            :title="$t('action.rebuild-all-cli-panes')"
            :aria-label="$t('action.rebuild-all-cli-panes')"
            @click.stop="emit('rebuild-all', ws.path)"
          >
            <RebuildIcon />
          </button>
          <button class="ws-act" :title="$t('label.history')" @click.stop="emit('open-history', ws.path)"><HistoryIcon /></button>
          <!-- Opens the same CLI and role the spawn card holds, in THIS
               workspace — the menu remembers which heading opened it. -->
          <button
            class="ws-add"
            :disabled="!canSpawn"
            :aria-expanded="addMenuOpen && addMenuWorkspace === ws.path"
            :title="canSpawn ? `${$t('action.add-to-grid')} · ${pickedAgentLabel}` : $t('label.set-workspace-first')"
            @click.stop="toggleAddMenu($event, ws.path)"
          ><AddPaneIcon /></button>
        </li>
        <template v-for="g in groupSectionsOf(ws)" :key="`${ws?.path ?? ''}/${g.id}`">
        <!-- The group layer sits BESIDE the lineage rather than above it: a
             spine on the left edge, not another step of indentation. Indentation
             is already spent on parent/child panes, and a third level would push
             an MCP child's name past the width it has.

             The header sticks to the top of the scroller so a long list always
             says which group you are inside; the 2px rail down the member rows
             (see .agent-item.in-group) says the group has not ended yet. The
             rail is deliberately NEUTRAL — group colour means run state here,
             and two different groups can both be green, so a coloured rail
             could not answer "which group am I in". The stuck header answers
             that; the rail only answers "still the same one". -->
        <li
          v-if="!g.bare"
          v-show="!ws?.collapsed"
          class="ws-grp"
          :data-state="g.state"
        >
          <button
            class="ws-grp-caret"
            :title="isGroupCollapsed(ws?.path ?? '', g.id)
              ? $t('action.expand-subtree')
              : $t('action.collapse-subtree')"
            @click.stop="toggleGroup(ws?.path ?? '', g.id)"
          >{{ isGroupCollapsed(ws?.path ?? '', g.id) ? '›' : '⌄' }}</button>
          <span class="ws-grp-key" :title="$t(runGroupStateLabelKey(g.state))"></span>
          <span class="ws-grp-name" :title="g.name || $t('label.manual-spawn')">{{ g.name || $t('label.manual-spawn') }}</span>
          <!-- Neutral, unlike the workspace heading's: this row already carries
               its run state in the key beside the name, and a second colour
               here — on a different scale, since the key has four states and a
               status has nine — reads as two signals disagreeing. -->
          <span class="ws-count">{{ g.rows.length }}</span>
          <!-- The sidebar's own entry point: ＋ here opens an agent in THIS
               group, which the stage tab bar cannot express — it can only open
               into whichever group it is currently showing. Management (rename,
               delete, detach) stays on the tab bar so there is one place to
               change a group, not two that can disagree. -->
          <button
            v-if="ws && !g.bare && canSpawn"
            class="ws-grp-add"
            :aria-expanded="addMenuOpen && addMenuWorkspace === ws.path && addMenuGroup === g.id"
            :title="`${$t('action.open-agent-in-group')} · ${pickedAgentLabel}`"
            :aria-label="$t('action.open-agent-in-group')"
            @click.stop="toggleAddMenu($event, ws.path, g.id)"
          >＋</button>
        </li>
        <li
          v-for="({ pane: p, depth, hasChildren, collapsed: folded }, gi) in g.rows"
          v-show="!ws?.collapsed && !isGroupCollapsed(ws?.path ?? '', g.id)"
          :key="p.id"
          class="agent-item"
          :style="depth ? { marginLeft: depth * 13 + 'px' } : undefined"
          :class="{ 'in-group': !g.bare, 'in-group-last': !g.bare && gi === g.rows.length - 1, pipeline: p.origin === 'pipeline', manager: p.isCommander, minimized: p.isMinimized, 'agent-item--focus': p.id === props.focusPaneId, 'agent-item--selected': props.selectedPaneIds?.has(p.id), 'agent-item--dragging': draggingBatchIds.includes(p.id), 'drag-over': reorderDragOverId === p.id, expanded: isRowExpanded(p.id) }"
          @dragover="onAgentDragOver($event, p.id)"
          @dragenter="onAgentDragOver($event, p.id)"
          @dragleave="onAgentDragLeave(p.id)"
          @drop.prevent="onAgentDrop($event, p.id)"
        >
          <div class="agent-line" role="button" title="Focus pane" draggable="true" @dragstart="onAgentDragStart($event, p.id)" @dragend="onAgentDragEnd" @click="onAgentLineClick(p.id, $event)" @contextmenu.prevent="emit('context-menu', p.id, $event)">
            <button
              v-if="hasChildren"
              class="lineage-caret"
              :title="folded ? $t('action.expand-subtree') : $t('action.collapse-subtree')"
              @click.stop="emit('toggle-collapsed', p.id)"
            >{{ folded ? '▸' : '▾' }}</button>
            <span v-else-if="depth || g.rail" class="lineage-spacer"></span>
            <span class="status-dot" :data-state="p.status" :style="statusBadgeStyle(p.status)" :title="paneStatusLabelText(p.status)"></span>
            <!-- No MCP tag beside it. `origin === 'mcp'` is still recorded and
                 still drives spawn behaviour; it just does not need a badge.
                 The indentation already says an agent spawned this pane, and
                 the badge repeated it on the one row where the pane's own name
                 has least room. -->
            <span v-if="p.origin === 'pipeline'" class="pipe-tag">P{{ p.stageId }}</span>
            <input
              v-if="renamingPaneId === p.id"
              v-focus
              v-model="renameDraft"
              class="rename-input"
              @keydown="onRenameKeydown"
              @blur="commitRename"
              @click.stop
              @mousedown.stop
            />
            <span
              v-else
              class="badge"
              :title="`${p.agentLabel}\n${$t('action.rename')}`"
              @dblclick.stop="startRename(p)"
            >{{ p.agentLabel }}</span>
            <span
              v-if="p.autoNamed && renamingPaneId !== p.id"
              class="auto-name-mark"
              :title="$t('pane.terminal.auto-named-tooltip')"
            >◦</span>
            <span v-if="p.isCommander" class="manager-inline" title="Stage manager — controls flow and decides ---STAGE-DONE---">🎯 Mgr</span>
            <span v-if="!isRowExpanded(p.id)" class="agent-line-sub">{{ agentTypeLabel(p.agentKey) }} · {{ p.roleLabel || 'No role' }}</span>
            <span v-if="p.isMinimized" class="minimized-tag" title="Docked in sidebar">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
              Docked
            </span>
            <span class="expand-caret" aria-hidden="true">▶</span>
            <span class="agent-line-actions">
              <button
                v-if="p.rebuildVisible && !p.isMinimized"
                class="icon-btn agent-rebuild-btn"
                :disabled="p.rebuilding || !p.canRebuild"
                :title="p.canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
                :aria-label="p.canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
                @click.stop="emit('rebuild', p.id)"
              >
                <RebuildIcon />
              </button>
              <button class="icon-btn agent-minimize-btn" :title="$t('pane.terminal.minimize-tooltip')" @click.stop="emit('minimize', p.id)">⊟</button>
            </span>
          </div>
          <template v-if="isRowExpanded(p.id)">
            <div class="agent-role-line">
              <span class="agent-role-main">{{ agentTypeLabel(p.agentKey) }}<span v-if="p.roleLabel"> · {{ p.roleLabel }}</span></span>
              <span class="state" :data-state="p.status" :style="statusBadgeStyle(p.status)">{{ paneStatusLabelText(p.status) }}</span>
            </div>
            <div v-if="!p.isMinimized && p.origin === 'pipeline'" class="stage-line">
              stage {{ p.stageId }} · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
            </div>
            <div v-else-if="!p.isMinimized" class="stage-line">
              manual · {{ preparationLabel(p.preparationStatus) }} · {{ injectionLabel(p.injectionStatus) }} {{ kickoffLabel(p.kickoffStatus) }}
            </div>
            <div v-if="!p.isMinimized" class="agent-cmd"><code>{{ p.command }}</code></div>
            <div v-if="!p.isMinimized && p.sessionId" class="agent-session" title="CLI session id — used to resume this agent's memory on restart">
              <span class="agent-session-k">session</span><code>{{ p.sessionId }}</code>
            </div>
            <div v-if="p.error" class="err">{{ p.error }}</div>
            <div class="row tight">
              <template v-if="p.isMinimized">
                <button class="ghost" @click="emit('restore', p.id)">{{ $t('action.restore') }}</button>
                <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
              </template>
              <template v-else>
                <button class="ghost" @click="emit('interrupt', p.id)" :disabled="p.status !== 'running'" :title="interruptTooltip(p)">
                  {{ $t('action.interrupt') }}
                </button>
                <button class="danger" @click="emit('kill', p.id)">{{ $t('action.remove') }}</button>
              </template>
            </div>
          </template>
        </li>
        </template>
        <li v-if="ws && !panesOf(ws).length" v-show="!ws.collapsed" class="ws-empty">{{ $t('label.no-agents-running') }}</li>
        </template>
        <!-- Workspaces open in another window. The registry knows their name,
             agent and busy flag; everything else needs the window that owns
             them, which is what clicking a row goes to. -->
      </ul>
        <!-- Every member of this group is closed. Not an error and not the
             same as "no agents": the group still exists, its projects are just
             not open in this window. -->
        <div v-if="showRail && !visibleWorkspaceRows.length" class="ws-rail-empty">
          {{ $t('label.workspace-group-empty') }}
        </div>
        </div><!-- /ws-rail-body -->
      </div><!-- /ws-rail-wrap -->

      <!-- Naming a group. Fixed and high, like the context menus: anything
           positioned inside the list is clipped by its scroller and painted
           over by the status bar. -->
      <div
        v-if="railDialog"
        class="ws-gdlg"
        :style="{ top: `${railDialog.y}px`, left: `${railDialog.x}px` }"
        @click.stop
      >
        <div class="ws-gdlg-t">
          {{ railDialog.mode === 'create' ? $t('action.new-workspace-group') : $t('action.rename-workspace-group') }}
        </div>
        <input
          ref="railInputEl"
          v-model="railDialog.text"
          class="ws-gdlg-in"
          type="text"
          maxlength="24"
          :placeholder="$t('label.workspace-group-name')"
          @keydown.enter.stop="commitRailInput"
          @keydown.esc.stop="cancelRailInput"
        />
        <div class="ws-gdlg-l">{{ $t('label.workspace-group-colour') }}</div>
        <div class="ws-gdlg-sw">
          <button
            v-for="(c, i) in RAIL_PALETTE"
            :key="c"
            class="ws-gsw"
            :class="{ on: railDialog.color === i }"
            :style="{ background: c }"
            :aria-pressed="railDialog.color === i"
            @click="railDialog.color = i"
          ></button>
        </div>
        <div class="ws-gdlg-a">
          <button class="ws-gbtn" @click="cancelRailInput">{{ $t('action.cancel') }}</button>
          <button
            class="ws-gbtn primary"
            :disabled="!railDialog.text.trim()"
            @click="commitRailInput"
          >{{ railDialog.mode === 'create' ? $t('action.create') : $t('action.save') }}</button>
        </div>
      </div>

      <div
        v-if="railMenu"
        class="ws-ctx-menu"
        :style="{ top: `${railMenu.y}px`, left: `${railMenu.x}px` }"
        @click.stop
      >
        <button class="ws-ctx-opt" @click="startRenameRail(railMenu.id, $event)">
          {{ $t('action.rename-workspace-group') }}
        </button>
        <div class="ws-add-div"></div>
        <!-- Deletes the group, never its projects: they fall back to All. -->
        <button class="ws-ctx-opt danger" @click="removeRail(railMenu.id)">
          {{ $t('action.delete-workspace-group') }}
        </button>
      </div>

      <div
        v-if="wsMenu"
        class="ws-ctx-menu"
        :style="{ top: `${wsMenu.y}px`, left: `${wsMenu.x}px` }"
        @click.stop
      >
        <button class="ws-ctx-opt" @click="wsMenuAction('reveal')">{{ $t('action.open-in-finder') }}</button>
        <button class="ws-ctx-opt" @click="wsMenuAction('copy')">{{ $t('action.copy-path') }}</button>
        <!-- Membership is exclusive, so this reads as a radio group: one tick,
             and "None" is a real choice rather than the absence of one. -->
        <template v-if="workspaceRails.length">
          <div class="ws-add-div"></div>
          <div class="ws-ctx-lbl">{{ $t('label.move-to-workspace-group') }}</div>
          <button class="ws-ctx-opt" @click="assignWorkspaceToRail(wsMenu.path, '')">
            <span class="ws-ctx-ck">{{ railIdForPath(wsMenu.path) === '' ? '✓' : '' }}</span>
            <span>{{ $t('label.no-workspace-group') }}</span>
          </button>
          <button
            v-for="r in workspaceRails"
            :key="r.id"
            class="ws-ctx-opt"
            @click="assignWorkspaceToRail(wsMenu.path, r.id)"
          >
            <span class="ws-ctx-ck">{{ railIdForPath(wsMenu.path) === r.id ? '✓' : '' }}</span>
            <span>{{ r.name }}</span>
          </button>
        </template>
        <!-- The primary workspace is what this window was opened with; closing
             it would leave the window with no root. Switch or close the window
             instead. -->
        <template v-if="wsMenu.canClose">
          <div class="ws-add-div"></div>
          <button class="ws-ctx-opt danger" @click="wsMenuAction('close')">
            {{ $t('action.close-workspace') }}
          </button>
        </template>
      </div>

      <div v-if="addMenuOpen" class="ws-add-menu" :style="addMenuStyle" @click.stop>
        <select v-model="pickedRole" class="ws-add-role">
          <option value="">{{ $t('label.select-role') }}</option>
          <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select>
        <div class="ws-add-div"></div>
        <div class="ws-add-scroll">
          <button
            v-for="spec in manualAgentSpecs"
            :key="spec.agentKey"
            class="ws-add-opt"
            :class="{ on: spec.agentKey === pickedAgent }"
            @click="spawnAs(spec.agentKey)"
          >
            <span class="ws-add-ck">{{ spec.agentKey === pickedAgent ? '✓' : '' }}</span>
            <span class="ws-add-lb">
              {{ missingClis.has(spec.agentKey) ? $t('label.agent-not-installed', { label: spec.label }) : spec.label }}
            </span>
          </button>
        </div>
        <div class="ws-add-div"></div>
        <!-- A plain shell. Not in the list above: that list scrolls once there
             are more CLIs than fit, and an eleventh entry sat below the fold
             where it read as missing. Down here it is always in view, which is
             also how the Manual spawn dialog treats it — a button beside the
             agent dropdown rather than an entry in it.
             Its own handler rather than spawnAs: the role picked above is
             injected into a CLI's prompt, and a shell would print it. -->
        <button
          v-if="terminalSpec"
          class="ws-add-opt ws-add-more ws-add-term"
          @click="openTerminalFromMenu"
        >{{ terminalSpec.label }}</button>
        <button class="ws-add-opt ws-add-more ws-add-card" @click="openSpawnCardFromMenu">
          {{ $t('label.manual-spawn') }}…
        </button>
      </div>

      <!-- A dialog rather than a permanent card: the sidebar is a list of what
           is running, and a form for starting something new sat in it all day
           whether or not it was wanted. Every control inside is unchanged. -->
      <div v-if="manualSpawnOpen" class="spawn-modal-backdrop nv-modal-overlay" @click.self="manualSpawnOpen = false">
        <div class="spawn-card spawn-card--modal nv-modal-shell" role="dialog" aria-modal="true">
        <div class="spawn-card-hdr">
          <span>{{ $t('label.manual-spawn') }}</span>
          <button class="spawn-modal-close" :aria-label="$t('action.close')" @click="manualSpawnOpen = false">✕</button>
        </div>
        <div class="spawn-card-body">
          <div class="row two-col">
            <select v-model="modalAgent" @focus="refreshCliStatus">
              <option v-for="spec in manualAgentSpecs" :key="spec.agentKey" :value="spec.agentKey">
                {{ missingClis.has(spec.agentKey) ? $t('label.agent-not-installed', { label: spec.label }) : spec.label }}
              </option>
            </select>
            <select v-model="pickedRole">
              <option value="">{{ $t('label.select-role') }}</option>
              <option v-for="r in roles" :key="r.key" :value="r.key">{{ r.label }}</option>
            </select>
          </div>
          <div class="row spawn-actions">
            <button class="primary wide" :disabled="!canSpawn" @click="spawn()">{{ $t('action.add-to-grid') }}</button>
            <button class="ghost wide terminal-btn" :disabled="!canSpawn" @click="openTerminal">{{ $t('action.open-terminal') }}</button>
          </div>
          <div class="row resume-actions">
            <input
              v-model="resumeSessionId"
              class="resume-input"
              list="resume-session-list"
              :placeholder="$t('label.resume-session-id')"
              :disabled="!canSpawn"
            />
            <datalist id="resume-session-list">
              <option v-for="opt in resumeOptions" :key="opt.sessionId" :value="opt.sessionId">
                {{ opt.label }}
              </option>
            </datalist>
            <button class="ghost resume-btn" :disabled="!canResume" @click="resumeAgent">
              {{ $t('action.resume-agent') }}
            </button>
          </div>
          <p v-if="resumeNotice" class="hint warn">{{ resumeNotice }}</p>
          <p v-if="!canSpawn" class="hint warn">
            {{ backendStatus !== 'connected' ? $t('label.waiting-backend') : $t('label.set-workspace-first') }}
          </p>

          <div v-if="currentRole" class="prompt-block">
            <div class="prompt-head">
              <button class="link" @click="previewOpen = !previewOpen">
                {{ previewOpen ? '▾' : '▸' }} {{ currentRole.label }} system prompt
              </button>
              <button class="link tiny" @click="emit('open-settings')" :title="$t('action.settings') + ' (⌘,)'">
                ⚙ {{ $t('action.settings') }}
              </button>
            </div>
            <p class="role-line">{{ currentRole.one_line }}</p>
            <pre v-if="previewOpen" class="prompt-preview">{{ currentRole.system_prompt }}</pre>
          </div>
          <div v-else class="prompt-block warn-block">
            <p class="warn">
              {{ roles.length === 0 ? $t('label.no-roles-available') : $t('label.no-role-selected') }}
            </p>
            <div v-if="roles.length === 0" class="row tight">
              <button class="ghost" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>

    </div><!-- /part-bottom -->
    </div><!-- end agents tab -->

    <!-- ── Pipeline tab · detail view (no split, full-height scroll) ──────── -->
    <div v-if="visibleTabIds.has('pipeline') && sidebarTab === 'pipeline' && sidebarView === 'pipeline'" class="pipeline-split">
    <div class="pipeline-detail-scroll">
      <section class="block pipeline-detail-header">
        <div class="pipeline-detail-nav">
          <button class="ghost back-btn" @click="backToList">← Back</button>
          <span class="pipeline-detail-name">{{ openedPipeline?.name ?? openedPipelineId }}</span>
          <span v-if="openedPipelineId === activePipelineId" class="active-tag">{{ $t('label.default') }}</span>
          <button class="ghost manage-btn" title="Manage pipelines" @click="openPipelineManager(openedPipelineId || undefined)">⚙</button>
        </div>
      </section>
      <section class="block" :class="{ pipeline: pipelineOpen }">
        <button class="lbl collapsible-header" @click="pipelineOpen = !pipelineOpen">
          {{ pipelineOpen ? '▾' : '▸' }} {{ openedPipeline?.name ?? $t('label.pipelines') }} · {{ effectiveStageCount }}-stage
        </button>
        <template v-if="pipelineOpen">
        <div
          v-if="
            existingProject &&
            pipeline.state !== 'running' &&
            existingProject.state !== 'idle' &&
            existingProject.nextStageIndex >= 0 &&
            !resumeMatchesActivePipeline
          "
          class="resume-mismatch-card"
        >
          <p class="resume-mismatch-text">
            {{ $t('label.resume-other-pipeline', { name: resumeOwnerPipelineName }) }}
          </p>
          <button class="ghost wide" @click="emit('pipeline-resume')">
            {{ $t('action.switch-and-resume') }}
          </button>
        </div>
        <div
          v-if="
            existingProject &&
            pipeline.state !== 'running' &&
            existingProject.state !== 'idle' &&
            existingProject.nextStageIndex >= 0 &&
            resumeMatchesActivePipeline
          "
          class="resume-card"
        >
          <div class="resume-head">
            <strong>↻ Resume existing pipeline</strong>
            <span class="resume-state" :data-state="existingProject.state">{{ existingProject.state }}</span>
          </div>
          <div class="resume-meta">
            <span>{{ existingProject.stagesCompleted }}/{{ existingProject.totalStages }} stages done</span>
            <span class="dot">·</span>
            <span>updated {{ existingProject.updatedAt }}</span>
          </div>
          <div v-if="existingProject.taskDescription" class="resume-task">
            {{ existingProject.taskDescription.length > 200
              ? existingProject.taskDescription.slice(0, 200) + '…'
              : existingProject.taskDescription }}
          </div>
          <div class="row">
            <button class="primary wide" @click="emit('pipeline-resume')">
              ▶ Resume from Stage {{ String(existingProject.nextStageIndex + 1).padStart(2, '0') }}
            </button>
            <button
              class="danger"
              @click="confirmingRestart = true"
              :title="$t('action.discard-progress')"
            >
              ↺ Start over
            </button>
          </div>
        </div>
        <div
          v-else-if="existingProject && existingProject.nextStageIndex < 0 && openedPipelineId === activePipelineId"
          class="resume-card done"
        >
          <div class="done-header">
            <strong>✓ Project completed</strong>
            <span class="resume-meta">
              All {{ existingProject.totalStages }} stages done · {{ existingProject.updatedAt }}
            </span>
          </div>
        </div>

        <textarea
          v-model="taskDescription"
          :disabled="pipeline.state === 'running'"
          :class="{ 'drag-over': isTaskDragOver }"
          :placeholder="$t('label.task-placeholder')"
          rows="3"
          spellcheck="false"
          @dragover.prevent
          @dragenter.prevent="isTaskDragOver = true"
          @dragleave="isTaskDragOver = false"
          @drop.prevent="onTaskDrop"
        ></textarea>
        <label class="checkbox-row">
          <input v-model="autoAnswerLocal" type="checkbox" :disabled="!analyzerStatus.available" />
          <span>
            <strong>{{ $t('label.full-auto') }}</strong>
            <span v-if="!analyzerStatus.available" class="muted-inline">{{ $t('label.needs-ollama') }}</span>
            <span v-else class="muted-inline">{{ $t('label.auto-answers') }}</span>
          </span>
        </label>
        <div v-if="analyzerStatus.available" class="analyzer-row">
          <label class="lbl tiny">{{ $t('label.model') }}</label>
          <select v-model="analyzerModelLocal">
            <option v-for="m in filteredModels" :key="m.name" :value="m.name">
              {{ m.name }} · {{ m.parameter_size || (m.size / 1e9).toFixed(1) + 'GB' }}
            </option>
          </select>
          <button
            class="ghost refresh"
            @click="emit('refresh-analyzer')"
            title="Refresh Ollama health + model list"
          >
            ↻
          </button>
        </div>
        <div v-else class="analyzer-row">
          <span class="muted-inline">{{ $t('label.ollama-unreachable') }}</span>
          <button class="ghost refresh" @click="emit('refresh-analyzer')" title="Retry connection">
            {{ $t('action.retry') }}
          </button>
        </div>
        <div v-if="pipeline.state === 'idle' || pipeline.state === 'completed' || pipeline.state === 'aborted'" class="row pipeline-row">
          <button class="primary wide" :disabled="!canRunPipeline" @click="startPipeline">
            {{ $t('action.run-pipeline') }}
          </button>
          <button
            v-if="pipeline.state !== 'idle'"
            class="ghost"
            @click="emit('pipeline-reset')"
            :title="$t('action.clear-pipeline')"
          >
            {{ $t('action.reset') }}
          </button>
        </div>
        <div v-else class="pipeline-running">
          <div class="progress">
            <div class="bar" :style="{ width: pipelineProgress + '%' }"></div>
          </div>
          <div class="pipeline-line">
            Stage {{ pipeline.stageIndex + 1 }} / {{ pipeline.totalStages }}
            <span v-if="pipelineCurrentStage" class="muted">
              · {{ pipelineCurrentStage.shortTitle }}
            </span>
          </div>
          <div class="row pipeline-row">
            <button
              class="primary wide"
              :disabled="!pipelineNextStage"
              @click="emit('pipeline-next')"
            >
              {{ pipelineNextStage ? `Next → ${pipelineNextStage.shortTitle}` : $t('action.finish') }}
            </button>
            <button class="danger" @click="emit('pipeline-abort')">{{ $t('action.abort') }}</button>
          </div>
        </div>
        <p v-if="pipeline.state === 'completed'" class="hint ok">
          {{ $t('label.pipeline-completed', { count: pipeline.totalStages || stages.length }) }}
        </p>
        <p v-else-if="pipeline.state === 'aborted'" class="hint warn">
          {{ $t('label.pipeline-aborted-paused') }}
        </p>
        <p v-else-if="pipeline.state === 'idle' && !canRunPipeline" class="hint">
          {{ $t('label.provide-task') }}
        </p>
        </template>
      </section>
    </div><!-- /pipeline-detail-scroll -->
    </div><!-- end pipeline tab · detail view -->

    <Teleport to="body">
      <div v-if="confirmingRestart" class="restart-modal" @click.self="confirmingRestart = false">
        <div class="restart-card">
          <h3>{{ $t('label.restart-title') }}</h3>
          <p v-if="existingProject" v-html="$t('hint.restart-confirm', { completed: existingProject.stagesCompleted, total: existingProject.totalStages })"></p>
          <div v-if="existingProject?.taskDescription" class="restart-task">
            {{ existingProject.taskDescription.length > 240
              ? existingProject.taskDescription.slice(0, 240) + '…'
              : existingProject.taskDescription }}
          </div>
          <p class="restart-warn">
            {{ $t('label.restart-preserved') }}
          </p>
          <div class="restart-actions">
            <button class="ghost" @click="confirmingRestart = false">{{ $t('action.cancel') }}</button>
            <button class="danger" @click="startOverNow">{{ $t('action.wipe-restart') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: var(--bg-base);
  border-right: 1px solid var(--border-muted);
  color: var(--text-primary);
  font-size: var(--font-xs);
  overflow: hidden;
}

/* ── Sidebar top-level tabs ─────────────────────────────────────── */
.sidebar-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-muted);
  margin: -4px -14px 0;
  padding: 4px 10px 6px;
}
.tab-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.tab-btn:hover { color: var(--text-primary); background: var(--bg-elevated); }
.tab-btn.active {
  color: var(--text-bright);
  background: var(--bg-muted);
}
/* Smaller than the 18px SVGs beside it on purpose. Those are drawn with
   padding inside their own viewBox, while a plugin ships artwork that fills
   its bitmap edge to edge, so matching the box makes the plugin icon read as
   the largest thing in the rail. This trims it to the SVGs' apparent size;
   `contain` keeps non-square artwork from stretching. */
.plugin-tab-icon {
  display: block;
  width: 15px;
  height: 15px;
  object-fit: contain;
}
/* Silhouette artwork: the icon is the mask and the button's own text colour is
   the ink, so it tracks :hover and .active like the built-in SVG icons.
   The artwork arrives as a per-plugin data URL in the --plugin-icon custom
   property, set inline on the element. */
.plugin-tab-icon--mono {
  background-color: currentColor;
  -webkit-mask-image: var(--plugin-icon);
  mask-image: var(--plugin-icon);
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}
.tab-spacer { flex: 1; }
/* Not a .tab-btn: that class means "a sidebar tab", and both the shortcut
   handling and its tests index the strip by position. */
.tab-collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 30px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.tab-collapse:hover { color: var(--text-primary); background: var(--bg-elevated); }

/* ── Collapsed rail ──────────────────────────────────────────────────
   The panel body is hidden, not unmounted: ExplorerPane and GitPane hold
   scroll position, expanded folders and in-flight backend requests that a
   v-if would throw away every time the slot is collapsed. */
.sidebar.is-collapsed {
  padding: 0;
  gap: 0;
}
.sidebar.is-collapsed > :not(.rail) { display: none; }
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex: 1;
  min-height: 0;
  /* Five vertical labels overflow a short window; the sidebar hides its own
     overflow, so without this the last tab becomes unreachable. */
  overflow-y: auto;
}
.rail-btn {
  position: relative;
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
.rail-btn:hover { background: var(--bg-subtle); color: var(--text-bright); }
.rail-btn.active { color: var(--accent-fg); }
.rail-icon { font-size: var(--font-lg); }
/* No emoji reads as a branch, so git uses its own glyph — kept in Git's
   brand orange so the rail stays as colourful as the emoji beside it. */
.rail-icon-git { color: #f05033; }
.rail-label {
  /* No rotate(180deg): the bottom-up "book spine" trick flips CJK glyphs
     upside down. Plain vertical-rl keeps CJK upright and rotates Latin 90°. */
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  font-size: var(--font-3xs);
  text-transform: uppercase;
}
.rail-badge {
  position: absolute;
  top: 6px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  background: var(--attention-fg);
  color: var(--text-on-emphasis);
  border-radius: 999px;
  padding: 0 3px;
}
.git-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--attention-fg);
  color: var(--bg-base);
  font-size: 9px;
  font-weight: 700;
  border-radius: 999px;
  padding: 0 3px;
  line-height: 1;
  border: 1px solid var(--bg-base);
}
.legacy-recovery-label {
  align-self: flex-start;
  flex: none;
  margin: 4px 0 2px;
  padding: 1px 6px;
  border-radius: 999px;
  color: var(--attention-fg);
  background: var(--bg-muted);
  border: 1px solid var(--border-muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── Flat section style (VS Code / GitPane) ──────────────────────────────── */
.panel-section {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 6px 0 10px;
  border-top: 1px solid var(--border-muted);
}
/* first visible section in each scroll area: no top divider */
.part-top > .block:first-child,
.part-bottom > .block:first-child {
  border-top: none;
  padding-top: 4px;
}

.section-divider {
  border: none;
  border-top: 1px solid var(--border-muted);
  margin: 6px 0;
}

/* Section header label (matches GitPane sec-label) */
.lbl {
  font-size: var(--font-2xs);
  font-weight: 600;
  letter-spacing: 0.2px;
  text-transform: none;
  color: var(--text-secondary);
  padding: 2px 0;
  display: block;
}
.lbl.tiny {
  font-size: var(--font-3xs);
  color: var(--text-muted);
  padding: 0;
}

/* Section header row with actions (matches GitPane sec-hdr layout) */
.panel-section > .row.between {
  min-height: 22px;
  align-items: center;
  padding: 0;
}

button.collapsible-header {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
button.collapsible-header:hover {
  color: var(--text-bright);
}
button.collapsible-header:hover {
  color: var(--text-bright);
}
input[type='text'],
select,
textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: var(--font-xs);
  box-sizing: border-box;
  width: 100%;
}
textarea {
  font-family: var(--font-mono);
  resize: vertical;
}
input[type='text']:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
textarea.drag-over {
  border-color: var(--accent-focus);
  box-shadow: inset 0 0 0 1px var(--accent-focus), 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.row.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.row.between {
  justify-content: space-between;
}
.row.tight {
  gap: 4px;
  margin-top: 4px;
}
.row.workspace-row {
  gap: 4px;
}
.row.workspace-row input {
  flex: 1;
}
.row.workspace-row .browse {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: var(--font-2xs);
  padding: 6px 10px;
}
.row.workspace-row .switch-ws {
  flex-shrink: 0;
  font-size: var(--font-sm);
  padding: 6px 9px;
  line-height: 1;
}
.checkbox-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  font-size: var(--font-2xs);
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
}
.checkbox-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  accent-color: var(--attention-fg);
  flex-shrink: 0;
}
.checkbox-row strong {
  color: var(--attention-fg);
}
.analyzer-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 22px;
}
.analyzer-row .lbl.tiny {
  font-size: 9px;
  margin: 0;
}
.analyzer-row select {
  flex: 1;
  font-size: var(--font-2xs);
  padding: 4px 6px;
}
.analyzer-row .refresh {
  font-size: var(--font-2xs);
  padding: 4px 8px;
  flex-shrink: 0;
}
.muted-inline {
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.muted-inline {
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.pipeline-row {
  margin-top: 4px;
}
.spawn-actions {
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}
.terminal-btn {
  opacity: 0.6;
  border-style: dashed;
  transition: opacity var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out);
}
.terminal-btn:hover:not(:disabled) {
  opacity: 1;
}
.resume-actions {
  gap: 4px;
  align-items: stretch;
}
.resume-input {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  padding: 4px 6px;
  background: var(--bg-muted);
  color: var(--text-bright);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
}
.resume-btn {
  flex-shrink: 0;
}

button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.wide {
  flex: 1;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:not(:disabled):hover {
  background: var(--success-strong);
}
button.danger {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-bright);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.link {
  background: transparent;
  border: none;
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  padding: 2px 4px;
  text-align: left;
}
/* Title left, controls right: the row is space-between, and without this the
   ＋ lands in the middle of it. */
.agent-list-hdr > .lbl { margin-right: auto; }
.agent-list-hdr {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-base);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-muted);
  margin-bottom: 4px;
}
.agent-header-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}
/* Sized to the header's text, not to the 32px action buttons beside it: once
   the list is grouped this is the only control left up here. */
/* The fold-all control shares the ＋'s box but not its class: one class for
   both made "find the add button" return whichever came first in the DOM. */
.hdr-add-ws,
.hdr-fold-ws {
  flex: none;
  border: none;
  background: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: var(--font-sm);
  line-height: 1;
  color: var(--text-muted);
}
.hdr-add-ws:hover,
.hdr-fold-ws:hover { color: var(--text-bright); }
/* Icon, not a glyph: centre it in the box the ＋ sizes by its text. */
.hdr-fold-ws {
  display: flex;
  align-items: center;
}
button.history-btn {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--font-md);
  padding: 0;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  border-radius: var(--radius-xs);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
button.agent-rebuild-all-btn {
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-default);
}
button.agent-rebuild-all-btn svg {
  width: 15px;
  height: 15px;
}
button.agent-rebuild-all-btn:hover:not(:disabled) {
  color: var(--text-bright);
  border-color: var(--accent-fg);
  background: var(--bg-subtle);
}
button.agent-rebuild-all-btn:disabled {
  opacity: 0.4;
}
button.agent-rebuild-all-btn.busy svg {
  animation: agent-rebuild-spin 0.8s linear infinite;
}
@keyframes agent-rebuild-spin {
  to { transform: rotate(360deg); }
}
button.history-btn :deep(svg) { width: 15px; height: 15px; }
button.history-btn:hover {
  color: var(--text-bright);
  border-color: var(--accent-fg);
  background: var(--bg-subtle);
}
button.icon-btn {
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-size: var(--font-sm);
  line-height: 1;
  cursor: pointer;
  border-radius: var(--radius-xs);
  opacity: 0.5;
}
button.icon-btn:hover {
  opacity: 1;
  background: var(--bg-muted);
}
button.icon-btn.muted {
  opacity: 0.3;
}
button.icon-btn.muted:hover {
  opacity: 0.8;
}
.hint {
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  margin: 0;
  line-height: var(--lh-base);
}
.hint.warn {
  color: var(--attention-fg);
}
.hint.ok {
  color: var(--success-fg);
}
/* ── Pipeline list styles ──────────────────────────────────────────────────── */
.pipeline-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 6px;
}
.pg-btn {
  padding: 2px 8px;
  font-size: var(--font-md);
  line-height: 1;
  min-width: 28px;
}
.pg-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.pg-info {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  min-width: 36px;
  text-align: center;
}
.pipeline-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pipeline-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out);
}
.pipeline-item:hover {
  background: var(--bg-elevated);
  border-color: var(--border-default);
}
.pipeline-item.pipeline-active {
  border-color: var(--accent-emphasis);
  background: var(--accent-subtle);
}
.pipeline-item-name {
  flex: 1;
  font-size: var(--font-xs);
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-active .pipeline-item-name {
  color: var(--accent-bright);
}
.pipeline-item-meta {
  font-size: var(--font-3xs);
  color: var(--text-muted);
  white-space: nowrap;
}
.pipeline-item-badge {
  font-size: var(--font-3xs);
  white-space: nowrap;
}
.pipeline-item-badge.running {
  color: var(--success-fg);
}
.pipeline-item-badge.idle {
  color: var(--text-muted);
}
.pipeline-item-badge.done {
  color: var(--accent-fg);
}
.new-pipeline-row {
  margin-top: 6px;
  gap: 4px;
}
.new-pipeline-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--accent-emphasis);
  border-radius: var(--radius-xs);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 4px 6px;
}
/* ── Pipeline detail header ────────────────────────────────────────────────── */
.pipeline-detail-header {
  padding: 8px 10px;
}
.pipeline-detail-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.back-btn {
  font-size: var(--font-2xs);
  padding: 2px 6px;
  color: var(--text-secondary);
}
.back-btn:hover {
  color: var(--text-bright);
}
.manage-btn {
  font-size: var(--font-2xs);
  padding: 2px 6px;
  color: var(--text-secondary);
}
.manage-btn:hover {
  color: var(--text-bright);
}
.pipeline-detail-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--accent-bright);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-detail-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.active-tag {
  font-size: var(--font-3xs);
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid color-mix(in srgb, var(--success-strong) 33%, transparent);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
  white-space: nowrap;
}
.rename-input {
  flex: 1;
  background: var(--bg-inset);
  border: 1px solid var(--accent-emphasis);
  border-radius: var(--radius-xs);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 3px 6px;
}
.hint code,
.agent-cmd code {
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  font-size: var(--font-3xs);
}
.pipeline {
  background: var(--bg-inset);
  border: 1px solid var(--accent-muted);
  padding: 10px;
  border-radius: var(--radius-sm);
}
.pipeline-detail-scroll .pipeline {
  flex: 1;
  min-height: 0;
}
.pipeline-detail-scroll .pipeline textarea {
  flex: 1;
  min-height: 60px;
}
.manual-spawn {
  background: var(--bg-inset);
  border: 1px solid var(--accent-muted);
  padding: 10px;
  border-radius: var(--radius-sm);
}
.resume-card {
  background: var(--bg-elevated);
  border: 1px solid var(--accent-muted);
  border-left: 3px solid var(--accent-fg);
  border-radius: var(--radius-xs);
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.resume-mismatch-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-left: 3px solid var(--attention-fg);
  border-radius: var(--radius-xs);
  padding: 8px 10px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.resume-mismatch-text {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin: 0;
}
.resume-card.done {
  border-left-color: var(--success-fg);
}
.resume-card.done .done-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.resume-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-xs);
  color: var(--text-primary);
}
.resume-state {
  margin-left: auto;
  font-size: 9px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--bg-muted);
}
.resume-state[data-state='running'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.resume-state[data-state='aborted'] {
  background: var(--danger-deep);
  color: var(--danger-fg);
}
.resume-state[data-state='completed'] {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
.resume-meta {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.resume-meta .dot {
  margin: 0 4px;
}
.resume-task {
  font-size: var(--font-2xs);
  color: var(--text-primary);
  background: var(--bg-inset);
  padding: 6px 8px;
  border-radius: var(--radius-xs);
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
}
.restart-modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.restart-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--danger-fg);
  border-radius: var(--radius-md);
  padding: 20px 22px;
  width: min(480px, 90vw);
  color: var(--text-bright);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.restart-card h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.restart-card p {
  margin: 8px 0;
  line-height: 1.6;
  color: var(--text-primary);
}
.restart-card .restart-warn {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.restart-task {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  margin: 8px 0;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
}
.restart-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}
.pipeline-running-divider {
  border-top: 1px solid var(--border-muted);
  margin: 8px 0;
}
.pipeline-running-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.prn-title {
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--success-fg);
  letter-spacing: 0.02em;
}
.prn-task {
  font-size: var(--font-2xs);
  color: var(--text-bright);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prn-meta {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.prn-auto {
  color: var(--attention-fg);
}
.prn-manual {
  color: var(--text-secondary);
}
.pipeline-running {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress {
  height: 6px;
  background: var(--bg-subtle);
  border-radius: 999px;
  overflow: hidden;
}
.progress .bar {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, var(--accent-emphasis) 0%, var(--accent-focus) 40%, var(--success-fg) 100%);
  background-size: 200% 100%;
  transition: width var(--motion-base) var(--ease-out);
  animation: bar-flow 2.5s linear infinite, bar-pulse 2s ease-in-out infinite;
}
.progress .bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.25) 50%,
    transparent 100%
  );
  animation: bar-shimmer 1.8s ease-in-out infinite;
}
@keyframes bar-flow {
  0%   { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@keyframes bar-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
@keyframes bar-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.82; }
}
.pipeline-line {
  font-size: var(--font-2xs);
  font-weight: 600;
}
.pipeline-line .muted {
  color: var(--text-secondary);
  font-weight: 400;
}
.empty {
  color: var(--text-muted);
  font-style: italic;
  padding: 8px 0;
}
.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  /* This list is the sidebar's main content and repeats per agent, so the gap
     is paid once per row. 1px still separates the hover backgrounds. */
  gap: 1px;
}
/* Collapsed rows are borderless one-liners; the card chrome only appears on
 * the single expanded item so a long list scans as compact rows. */
/* ── Workspace rail ──────────────────────────────────────────────────────
   Eight pixels on the very edge. One bar per group, the colour standing in
   for the name; everything wider — names, counts, ＋ — lives in a flyout that
   OVERLAYS the list rather than pushing it.

   The width is the whole point. The sidebar runs 273–315px, and a pane row
   already spends 22px on indent plus 13px per lineage level, so the 40px
   strip this replaced was taking the workspace names' last usable inches. */
.ws-rail-wrap {
  display: flex;
  align-items: flex-start;
  position: relative;
  /* The sidebar has no global border-box reset (see .ws-grp), and a flex row
     here would otherwise let the list push past .sidebar's overflow. */
  box-sizing: border-box;
  min-width: 0;
}
.ws-rail-body {
  flex: 1;
  /* Without this a long pane name sets the track's width and the strip gets
     squeezed out — flex items floor at their content size, not at zero. */
  min-width: 0;
}
.ws-strip {
  position: relative;
  flex: none;
  width: 8px;
  box-sizing: border-box;
  /* Over the list, so the flyout is not clipped by the rows it covers. */
  z-index: 4;
}
.ws-stick {
  /* Same offset and layer logic as .ws-grp: clears the section header. */
  position: sticky;
  top: 29px;
}
.ws-bars {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 2px;
}
.ws-bar {
  width: 8px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--border-default);
  opacity: 0.42;
  cursor: pointer;
  transition:
    opacity var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out);
}
.ws-bar:hover { opacity: 0.85; }
/* A workspace is being dragged. The bars are the only thing on screen that
   could take it, and at 8px and 42% opacity they read as decoration — so they
   come forward for the length of the gesture. */
.ws-bars.hot .ws-bar {
  opacity: 0.9;
  transform: scaleX(1.4);
}
.ws-bars.hot .ws-bar-add { opacity: 0.9; }
.ws-bar.on { opacity: 1; }
/* Nothing in this group is open in this window. Faint, never gone: the bar is
   the way back to the projects it holds. */
.ws-bar.dim { opacity: 0.16; }
/* The group you are still working in, while looking at another one. An
   outline rather than a dot — 8px has no room for a second mark. */
.ws-bar.cur {
  outline: 1.5px solid var(--success-fg);
  outline-offset: 1.5px;
}
.ws-bar.drop {
  outline: 1.5px solid var(--accent-fg);
  outline-offset: 1.5px;
  opacity: 1;
}
/* All is every group at once, so it takes the neutral ink rather than
   claiming one of the hues. */
.ws-bar.all { background: var(--text-muted); }
.ws-bar-add {
  height: 12px;
  background: none;
  box-shadow: inset 0 0 0 1px var(--border-default);
  opacity: 0.7;
}
.ws-bar-add:hover {
  box-shadow: inset 0 0 0 1px var(--accent-fg);
  opacity: 1;
}

/* Absolute is safe HERE, unlike the dialog: the strip plus this is 186px and
   the left slot's floor is 240px (SLOT_LIMITS.left.min), so it can never reach
   the scroller's right edge to be clipped. Vertically it grows with the group
   count, hence the cap — a long list scrolls inside itself rather than running
   off the bottom of the pane list. */
.ws-flyout {
  position: absolute;
  z-index: 6;
  top: 0;
  left: 0;
  min-width: 178px;
  max-height: 320px;
  overflow-y: auto;
  padding: 5px;
  box-sizing: border-box;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: 0 10px 28px rgb(0 0 0 / 32%);
}
.ws-rcell {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 7px 3px 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.ws-rcell:hover { background: var(--bg-hover); }
.ws-rcell.on {
  background: var(--bg-subtle);
  color: var(--text-bright);
  font-weight: 600;
}
.ws-rcell.dim { opacity: 0.55; }
.ws-rcell.drop { border-color: var(--accent-fg); background: var(--bg-hover); }
.ws-rswatch {
  flex: none;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
}
/* Tinted rather than filled: the hue has to carry the group's identity here
   the same way it does on the bar, but a name still has to be readable on it,
   and white-on-amber is not. */
.ws-rswatch.tint {
  background: color-mix(in srgb, var(--tint) 20%, transparent);
  color: var(--tint);
}
.ws-rswatch--add {
  background: none;
  color: var(--text-muted);
  font-size: var(--font-sm);
  font-weight: 400;
}
.ws-rglyph { line-height: 1; pointer-events: none; }
.ws-rname-t {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-rdot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success-fg);
}
.ws-rbump {
  flex: none;
  min-width: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-muted);
  font-size: var(--font-3xs);
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.ws-rcell.on .ws-rbump { background: var(--bg-base); color: var(--text-primary); }
/* Group dialog — naming and colour.
   Fixed and at menu height for the same reason .ws-ctx-menu is: the pane list
   scrolls under overflow-y:auto (which clips) and the status bar sits at
   z-index 200 (which covers). The first version of this was positioned inside
   the strip and was never visible once. */
.ws-gdlg {
  position: fixed;
  z-index: 300;
  width: 232px;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated, var(--bg-secondary));
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.ws-gdlg-t {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--text-bright);
  margin-bottom: 8px;
}
.ws-gdlg-in {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--font-xs);
  outline: none;
}
.ws-gdlg-in:focus { border-color: var(--accent-fg); }
.ws-gdlg-l {
  margin: 10px 0 5px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ws-gdlg-sw { display: flex; gap: 6px; }
.ws-gsw {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
/* The ring is drawn outside the swatch so the colour itself stays whole —
   an inset marker on a 24px chip eats the very thing being picked. */
.ws-gsw.on {
  border-color: var(--bg-elevated, var(--bg-secondary));
  box-shadow: 0 0 0 2px var(--accent-fg);
}
.ws-gdlg-a {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.ws-gbtn {
  padding: 4px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.ws-gbtn:hover { background: var(--bg-hover); }
.ws-gbtn.primary {
  border-color: var(--accent-fg);
  background: var(--accent-fg);
  color: var(--bg-base);
  font-weight: 600;
}
.ws-gbtn.primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-rail-empty {
  padding: 10px 12px;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}

/* Section label inside the workspace context menu, above the group list. */
.ws-ctx-lbl {
  padding: 5px 12px 2px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.ws-ctx-ck {
  display: inline-block;
  width: 13px;
  color: var(--accent-fg);
}

/* Workspace section heading. The sidebar's outer layer: one per project, this
   window's first. */
.ws-head {
  display: flex;
  /* Everything lines up with the NAME, not with the two-line block: a control
     centred against both rows would sit against the path instead. */
  align-items: flex-start;
  gap: 5px;
  padding: 3px 4px 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-bright);
  user-select: none;
}
.ws-head:first-child { padding-top: 1px; }
/* Height of the name's line box — every control matches it so they centre on
   that row rather than on the block. */
.ws-head > .ws-caret,
.ws-head > .ws-icon,
.ws-head > .ws-act,
.ws-head > .ws-add { height: 16px; align-self: flex-start; }
.ws-caret {
  flex: none;
  width: 14px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: var(--font-3xs);
  line-height: 1;
  color: var(--text-secondary);
}
.ws-caret:hover { color: var(--text-bright); }
.ws-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}
.ws-icon svg { display: block; }
/* Name over path. Both line-heights are set tight — this row repeats down the
   sidebar, so every pixel of leading is paid for many times over. */
.ws-text {
  min-width: 0;
  margin-right: auto;
  display: flex;
  flex-direction: column;
}
/* The name's own line, so the count sits against the name however long the
   path below it happens to be. */
.ws-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}
.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 16px;
}
/* The path disambiguates two projects that share a folder name. It is the
   part that gets dropped when the row runs out of width; the full path is on
   the row's tooltip either way. */
.ws-path {
  min-width: 0;
  font-weight: 400;
  font-size: 9.5px;
  line-height: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The workspace on screen. The others in this window keep running; their
   headings read as links to switch to. */
.ws-head--viewing .ws-name { color: var(--accent-bright, var(--text-bright)); }
/* Where a dragged workspace would land. A line above the row rather than a
   filled background: the heading already uses background for hover, and a drop
   marker that looks like hover says the wrong thing about what is about to
   happen. */
.ws-head--drop { box-shadow: inset 0 2px 0 0 var(--accent-fg); }

/* The row being viewed has no click action, so the cursor is free to say the
   one thing it can do. A switchable row keeps `pointer`: clicking to switch is
   its primary action, and the tooltip carries the drag. */
.ws-head--viewing[draggable='true'] { cursor: grab; }
.ws-head--viewing[draggable='true']:active { cursor: grabbing; }
.ws-head--switchable { cursor: pointer; border-radius: var(--radius-xs); }
.ws-head--switchable:hover { background: var(--bg-hover); }
.ws-head--switchable:hover .ws-name { text-decoration: underline; }
.ws-text--switchable:hover .ws-name { text-decoration: underline; }
/* Only another window's name is a link — this window's own is where you are. */
.ws-head:not(.ws-head--current) .ws-text { cursor: pointer; }
.ws-head:not(.ws-head--current) .ws-text:hover .ws-name { text-decoration: underline; }
/* Same SHAPE as StageTabBar's tab-count — a pane tally means the same thing in
   both places, so it should not read as two different objects. The colour is
   where they now differ, and deliberately: a tab already carries its own run
   dot right beside the number, while a sidebar heading is often the only thing
   left on screen once its section is folded. See the [data-state] rules below. */
.ws-count {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 15px;
  padding: 0 4px;
  border-radius: var(--radius-md);
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-muted));
  font-weight: 400;
  font-size: var(--font-3xs);
  font-variant-numeric: tabular-nums;
}
/* The WORKSPACE heading's tally is a status light too — and only that one; the
   group heading's pill is left neutral, because that row already says its run
   state in the key beside the name.

   A workspace heading is the only thing left on screen once its section is
   folded, and a grey number there could not say whether anything under it had
   errored or was waiting on the user — the coloured dot that answers this sits
   on the pane rows, which are exactly what folding hides. The status is the
   loudest one under the heading (see rollupPaneStatus), and it is spelled out
   in the pill's tooltip so the colour is not a legend nobody has.

   Same defaults and the same --status-badge-* override hooks as the pane row's
   .state pill: one status vocabulary, painted once per surface, so recolouring
   a status in Settings moves the tally with everything else. */
.ws-count[data-state='running'] {
  background: var(--status-badge-bg, var(--success-muted));
  color: var(--status-badge-fg, var(--success-fg));
}
.ws-count[data-state='starting'] {
  background: var(--status-badge-bg, var(--status-starting-muted));
  color: var(--status-badge-fg, var(--status-starting-fg));
}
.ws-count[data-state='idle'] {
  background: var(--status-badge-bg, var(--status-idle-muted));
  color: var(--status-badge-fg, var(--status-idle-fg));
}
.ws-count[data-state='awaiting'] {
  background: var(--status-badge-bg, color-mix(in srgb, var(--warning-fg) 20%, transparent));
  color: var(--status-badge-fg, var(--warning-fg));
}
.ws-count[data-state='error'] {
  background: var(--status-badge-bg, var(--danger-deep));
  color: var(--status-badge-fg, var(--danger-fg));
}
.ws-count[data-state='exited'] {
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-disabled));
}
.ws-count[data-state='stopped'] {
  background: var(--status-badge-bg, var(--bg-inset));
  color: var(--status-badge-fg, var(--text-bright));
}
/* The two rollupPaneStatus can return that a pane row never shows on its own.
   Without them the pill fell through to the neutral chip — a workspace whose
   panes were all cold-restore placeholders, or all disconnected, looked the
   same as one with no status at all. */
.ws-count[data-state='waiting'] {
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-primary));
}
.ws-count[data-state='disconnected'] {
  background: var(--status-badge-bg, var(--bg-inset));
  color: var(--status-badge-fg, var(--text-bright));
}
/* Boxed and centred like .ws-act rather than sized by a font: the ＋ used to
   be a full-width character, whose weight came from the typeface and so could
   never match the stroke icons beside it. */
.ws-add {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.65;
}
/* One pixel over the 11px its siblings use. This is the row's primary action
   and its mark carries three elements to their one, so equal pixel size would
   read as smaller and busier; 12px restores the balance without breaking rank. */
.ws-add :deep(svg) { width: 12px; height: 12px; }
.ws-head:hover .ws-add { opacity: 1; }
.ws-add:hover { color: var(--text-bright); }

/* Rebuild-all and history, moved off the section header: both act on one
   workspace's panes. Sized to the row rather than the 32px header button. */
.ws-act {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--font-3xs);
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.65;
}
.ws-head:hover .ws-act { opacity: 1; }
.ws-act:hover:not(:disabled) { color: var(--text-bright); }
.ws-act:disabled { opacity: 0.3; cursor: default; }
.ws-act :deep(svg) { width: 11px; height: 11px; }
.ws-act.busy :deep(svg) { animation: agent-rebuild-spin 0.8s linear infinite; }
/* Kept visible while its menu is open, so the menu has a visible origin. */
.ws-add[aria-expanded='true'] { opacity: 1; color: var(--text-bright); }

/* The ＋ menu. Fixed rather than absolute: the pane list scrolls, and an
   absolute menu inside it would be clipped by that scroll container. */
.ws-add-menu {
  position: fixed;
  z-index: 60;
  width: 200px;
  max-width: calc(100vw - 24px);
  padding: 5px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated, var(--bg-secondary));
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
  font-size: var(--font-xs);
}
.ws-add-role {
  width: calc(100% - 12px);
  margin: 2px 6px 4px;
  font-size: 11.5px;
}
.ws-add-div { height: 1px; margin: 4px 0; background: var(--border-muted); }
/* Tall enough for the whole roster, capped against the viewport so a short
 * window still gets a menu that fits. 200px was set when ten vendors was the
 * whole list; at fourteen it cut the last four off with nothing on screen
 * saying so, and they read as unsupported. Each row is ~24px (12px text +
 * 3px padding either side), so 360px carries fifteen. */
.ws-add-scroll {
  max-height: min(360px, 45vh);
  overflow-y: auto;
  /* Scroll affordance. The two fades are painted in the scroller's own
   * coordinate space (`local`), so each one is visible only while content is
   * hidden in that direction; the two shadows stay pinned to the box
   * (`scroll`) and are covered by a fade once that end is reached. Pure CSS —
   * no scroll listener. The list must never again look complete when it is
   * not: that mistake has now been made twice here (see the Terminal entry's
   * comment in the template). */
  background:
    linear-gradient(var(--bg-elevated, var(--bg-secondary)) 30%, transparent) top / 100% 14px no-repeat local,
    linear-gradient(transparent, var(--bg-elevated, var(--bg-secondary)) 70%) bottom / 100% 14px no-repeat local,
    radial-gradient(farthest-side at 50% 0, rgb(0 0 0 / 22%), transparent) top / 100% 5px no-repeat scroll,
    radial-gradient(farthest-side at 50% 100%, rgb(0 0 0 / 22%), transparent) bottom / 100% 5px no-repeat scroll;
}
.ws-add-opt {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 10px;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.ws-add-opt:hover { background: var(--bg-hover, rgb(255 255 255 / 7%)); }
.ws-add-opt.on { color: var(--text-bright); font-weight: 600; }
.ws-add-ck { flex: none; width: 10px; font-size: var(--font-3xs); }
.ws-add-lb { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-add-more { color: var(--text-secondary); padding-left: 26px; }

/* Right-click menu on a workspace heading. Fixed at the pointer, same reason
   the ＋ menu is fixed: the pane list scrolls. */
.ws-ctx-menu {
  position: fixed;
  /* Above the status bar (200) and the titlebar (200). A context menu is the
     frontmost thing on screen while it is open; at 61 the status bar painted
     over the bottom of any menu opened near it. */
  z-index: 300;
  min-width: 150px;
  padding: 4px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-elevated, var(--bg-secondary));
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
  font-size: var(--font-xs);
}
.ws-ctx-opt {
  display: block;
  width: 100%;
  padding: 3px 12px;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.ws-ctx-opt:hover { background: var(--bg-hover, rgb(255 255 255 / 7%)); }
/* A menu row, not a button. `button.danger` elsewhere paints a filled red
   background with light text; this selector is more specific and was only
   overriding the colour, leaving red on red — the label vanished. */
.ws-ctx-opt.danger {
  background: none;
  color: var(--danger-bright, #e05252);
}
.ws-ctx-opt.danger:hover { background: var(--danger-subtle, rgb(224 82 82 / 12%)); }
/* ── Run group layer ────────────────────────────────────────────────────────
   Still not another step of indentation — indentation is already spent on
   parent/child panes, and a third level would push an MCP child's name past
   the width it has. What the layer costs instead is 2px on the left (the rail
   down the member rows) and one tinted row that sticks to the top of the
   scroller. Between them they answer the two questions the plain micro-heading
   could not: "is this a container?" (the tint and the rail) and "which group am
   I in, now that the heading has scrolled away?" (the stuck heading itself). */
.ws-empty {
  padding: 4px 8px 6px 18px;
  color: var(--text-muted);
  font-style: italic;
}

.ws-grp {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 18px;
  margin: 5px 2px 2px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  user-select: none;
  border-radius: var(--radius-xs);
  /* The sidebar has no global border-box reset, and this row now carries
     padding on all four sides — without this it would push its own content
     wider than the list and .sidebar's overflow:hidden would clip it, the way
     .sidebar-tabs once had to be pulled back with negative margins. */
  box-sizing: border-box;
  /* Sticks inside .part-bottom, the same scroller .agent-list-hdr sticks in.
     29px clears that header: 22px min-height + 6px padding-bottom + 1px
     border. Its 4px margin sits outside the sticky box, so it is not counted.
     z-index 1 puts this under the section header (which is 2) and over the
     rows it scrolls past. */
  position: sticky;
  top: 29px;
  z-index: 1;
  /* Two layers, because the tint token may be translucent and a stuck header
     must not let the rows scroll through it: the tint is painted over the
     sidebar's own opaque background. */
  background: linear-gradient(var(--bg-subtle), var(--bg-subtle)), var(--bg-base);
}
/* Sits where the workspace caret sits one level up, so the two read as the
   same control at two depths. */
.ws-grp-caret {
  flex: none;
  width: 12px;
  border: none;
  background: none;
  padding: 0;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.ws-grp-caret:hover { color: var(--text-bright); }
/* Same four states, same tokens, as StageTabBar's tab dot — the sidebar must
   not be able to say "active" where the tab says otherwise. */
.ws-grp-key {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--border-default);
}
.ws-grp[data-state='awaiting'] .ws-grp-key { background: var(--warning-fg); }
.ws-grp[data-state='active'] .ws-grp-key { background: var(--success-fg); }
.ws-grp[data-state='idle'] .ws-grp-key { background: var(--status-idle-emphasis); }
.ws-grp-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Reserved space, not conditional space: the button keeps its box when hidden
   so the count does not shift sideways as the pointer crosses the row. */
.ws-grp-add {
  flex: none;
  margin-left: auto;
  border: none;
  background: none;
  padding: 0 2px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out);
}
.ws-grp:hover .ws-grp-add,
.ws-grp-add:focus-visible,
.ws-grp-add[aria-expanded='true'] { opacity: 1; }
.ws-grp-add:hover { color: var(--text-bright); }
@media (prefers-reduced-motion: reduce) {
  .ws-grp-add { transition: none; }
}
/* A rail down the rows — but read the history before touching its colour.
   The first attempt was a COLOURED stripe, meant to tell you which group you
   were in once its heading had scrolled away. Then the colour became the
   group's RUN STATE rather than its identity — the more useful signal, and the
   tab bar's own — and the stripe could no longer answer the question it
   existed for: two groups that are both running are both green. So it went.

   This one is deliberately NEUTRAL and answers a different question. "Which
   group am I in" is now answered by the heading, which sticks to the top of
   the scroller; all the rail says is "this group has not ended yet", and for
   that, one border-coloured line is enough. Giving it a colour again would
   walk straight back into the contradiction above. */

.agent-item {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  padding: 0 4px;
}
/* Panes sit under the workspace that owns them. The sibling selector is what
   scopes this: an ungrouped list has no .ws-head, so nothing indents and that
   layout is untouched. Lineage children add their own margin on top of it. */
.ws-head ~ .agent-item { padding-left: 22px; }
/* Group members give up 2px, and only 2px — the name column is already
   truncating, so the rail is paid for out of the gutter, not out of the name.
   Written with .ws-head in the selector to outrank the 22px rule above rather
   than relying on source order. */
.ws-head ~ .agent-item.in-group {
  position: relative;
  padding-left: 24px;
}
.ws-head ~ .agent-item.in-group::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 0;
  /* Reaches 1px past the row to bridge .agent-list's gap, so the rail reads as
     one line rather than a dotted one. The last member stops short instead, so
     the rail ends with the group rather than pointing at the next heading. */
  bottom: -1px;
  width: 2px;
  border-radius: 1px;
  background: var(--border-default);
  pointer-events: none;
}
.ws-head ~ .agent-item.in-group-last::before { bottom: 2px; }
.agent-item.expanded {
  background: var(--bg-subtle);
  border-color: var(--border-muted);
  padding-bottom: 8px;
}
.agent-item.expanded.pipeline {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.agent-item.expanded.manager {
  border-color: var(--attention-muted);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--manager-fg) 15%, transparent) inset;
}
.agent-item--focus {
  background: color-mix(in srgb, var(--accent-focus) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--accent-focus);
}
.agent-item.expanded.agent-item--focus {
  border-color: var(--accent-focus);
  box-shadow: inset 2px 0 0 var(--accent-focus), 0 0 0 1px var(--accent-focus);
}
/* Multi-select highlight — softer than focus, mirrors the pane surfaces'
   *--selected styles (accent at reduced strength). */
.agent-item--selected {
  background: color-mix(in srgb, var(--accent-focus) 16%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent-focus) 55%, transparent);
}
/* Every row a batch drag is carrying fades out together, so it is obvious the
   whole selection is moving and not just the grabbed row. */
.agent-item--dragging {
  opacity: 0.45;
}
/* Reorder drop target feedback, matching .pane-header.drag-over in TerminalPane.vue. */
.agent-item.drag-over {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.agent-line {
  display: flex;
  align-items: center;
  gap: 6px;
  /* The tallest thing in the row is the agent badge at 10px + 2px padding,
     so ~16px of content. 22 keeps a comfortable margin without the row
     reading as a paragraph. */
  min-height: 22px;
  cursor: pointer;
  border-radius: var(--radius-xs);
  padding: 1px 2px;
  overflow: hidden;
}
.role-line {
  font-size: var(--font-3xs);
  color: var(--accent-bright);
  margin-bottom: 3px;
  padding-left: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-line:hover {
  background: var(--bg-hover);
}
/* A dot is foreground-only, so it takes --status-badge-fg where the pill takes
   both variables. Each rule below is that status's DEFAULT colour and stays the
   whole story until the user recolours the status in Settings; only then is the
   variable present and the fallback overridden. The base rule carries the
   fallback too, because idle/running/stopped/starting are painted here rather
   than by a rule of their own. */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
  background: var(--status-badge-fg, var(--text-muted));
}
.status-dot[data-state='running'] {
  background: var(--status-badge-fg, var(--success-fg));
  animation: agent-dot-pulse 1.6s ease-in-out infinite;
}
.status-dot[data-state='starting'] {
  background: var(--status-badge-fg, var(--status-starting-fg));
  animation: agent-dot-pulse 0.9s ease-in-out infinite;
}
.status-dot[data-state='idle'] {
  background: var(--status-badge-fg, var(--status-idle-fg));
}
/* The CLI asked something and is parked on the answer. It pulses like running
   rather than sitting flat like idle: this is the one state where nothing at
   all happens until the user acts, so it must not read as "quiet, all done". */
.status-dot[data-state='awaiting'] {
  background: var(--status-badge-fg, var(--warning-fg));
  box-shadow: 0 0 0 2px
    color-mix(in srgb, var(--status-badge-fg, var(--warning-fg)) 25%, transparent);
  animation: agent-dot-pulse 1.2s ease-in-out infinite;
}
/* Cold-restore placeholder: nothing spawned yet — a hollow ring, so it never
   reads as a live-but-quiet pane. */
.status-dot[data-state='waiting'] {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--status-badge-fg, var(--text-secondary));
}
.status-dot[data-state='error'] {
  background: var(--status-badge-fg, var(--danger-fg));
  box-shadow: 0 0 0 2px
    color-mix(in srgb, var(--status-badge-fg, var(--danger-fg)) 25%, transparent);
}
.status-dot[data-state='exited'] {
  background: var(--status-badge-fg, var(--text-disabled));
  opacity: 0.6;
}
@keyframes agent-dot-pulse {
  50% { opacity: 0.35; }
}
.expand-caret {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 8px;
  color: var(--text-muted);
  transition: transform var(--motion-fast) var(--ease-out);
}
.agent-item.expanded .expand-caret {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  .status-dot { animation: none !important; }
  .expand-caret { transition: none; }
  .progress .bar,
  .progress .bar::after { animation: none; }
}
.agent-line-sub {
  font-size: var(--font-3xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  /* Yields four times faster than the name badge beside it. Both used to
     shrink at the same rate, so a narrow sidebar cut the pane's own name —
     the row's identity — to make room for context that repeats on the
     expanded card anyway. */
  flex-shrink: 4;
}
.agent-line .minimized-tag {
  margin-left: auto;
}
.agent-line .minimized-tag ~ .expand-caret {
  margin-left: 6px;
}
.agent-line-actions {
  display: none;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.agent-line:hover .agent-line-actions,
.agent-line:focus-within .agent-line-actions,
.agent-item.expanded .agent-line-actions {
  display: inline-flex;
}
.agent-line .badge {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.agent-role-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  margin: 4px 0 5px;
}
/* The agent's own name is the one thing worth reading at a glance; the rest of
   the card is deliberately quieter so the eye lands here first. */
.agent-role-main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-bright);
  font-weight: 500;
}
/* Actions read as one quiet pair: Remove only fills in on hover, so a card at
   rest is not dominated by a red block. */
.agent-item.expanded > .row.tight {
  margin-top: 8px;
}
.agent-item.expanded > .row.tight button {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border-radius: var(--radius-xs);
}
.agent-item.expanded > .row.tight button.danger {
  background: transparent;
  color: var(--danger-fg);
  border: 1px solid color-mix(in srgb, var(--danger-fg) 40%, transparent);
}
.agent-item.expanded > .row.tight button.danger:hover {
  background: var(--danger-emphasis);
  border-color: transparent;
  color: var(--text-on-emphasis);
}
.agent-item.expanded > .agent-role-line,
.agent-item.expanded > .stage-line,
.agent-item.expanded > .agent-cmd,
.agent-item.expanded > .agent-session,
.agent-item.expanded > .err,
.agent-item.expanded > .row.tight {
  margin-left: 18px;
  margin-right: 6px;
}
.agent-minimize-btn,
.agent-close-btn {
  box-sizing: border-box;
  margin-left: 4px;
  padding: 0 4px;
  font-size: var(--font-2xs);
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--icon-btn-sm);
  width: var(--icon-btn-sm);
}
.agent-minimize-btn:hover {
  color: var(--text-primary);
  background: var(--bg-muted);
}
.agent-minimize-btn:focus-visible,
.agent-close-btn:focus-visible,
.agent-rebuild-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.agent-rebuild-btn {
  flex: 0 0 auto;
  box-sizing: border-box;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  padding: 2px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.agent-rebuild-btn svg {
  width: 14px;
  height: 14px;
}
.agent-rebuild-btn:hover:not(:disabled) {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.agent-rebuild-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.agent-close-btn:hover {
  color: var(--danger-fg);
  background: var(--danger-deep);
}
.stage-line {
  color: var(--text-muted);
  font-size: var(--font-3xs);
  margin-bottom: 6px;
}
.pipe-tag {
  font-size: var(--font-3xs);
  font-weight: 700;
  background: var(--accent-subtle);
  color: var(--accent-fg);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
}
/* Agent-spawned pane. Distinct hue from .pipe-tag so the two provenance marks
   are never confused; both sit in the same slot before the name. */
/* Fold control for a pane that has children. Sized to match .lineage-spacer so
   a childless row at the same depth still lines up with its siblings. */
.lineage-caret {
  flex: none;
  width: 12px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 9px;
  line-height: 1;
  color: var(--text-secondary);
}
.lineage-caret:hover { color: var(--text-bright); }
.lineage-spacer {
  flex: none;
  width: 12px;
}
.badge {
  font-weight: 600;
  font-size: var(--font-3xs);
  background: var(--bg-muted);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  color: var(--text-primary);
}
.badge.role {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
/* Auto-name marker — same treatment as the pane header's. */
.auto-name-mark {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  line-height: 1;
  opacity: 0.45;
  margin-left: -4px; /* pulls back .agent-line's 6px gap */
  user-select: none;
}
.minimized-tag {
  margin-left: auto;
  font-size: var(--font-3xs);
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: none;
  padding: 0;
}
.manager-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid color-mix(in srgb, var(--manager-fg) 35%, transparent);
  border-radius: 999px;
  padding: 1px 6px;
  white-space: nowrap;
  flex-shrink: 0;
}
/* Each rule is the DEFAULT colour of its status and stays the whole story until
   the user recolours that status in Settings; only then does the badge carry
   --status-badge-bg/-fg inline and win the var() fallback. */
.state {
  margin-left: auto;
  font-size: var(--font-3xs);
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-secondary));
}
.state[data-state='running'] {
  background: var(--status-badge-bg, var(--success-muted));
  color: var(--status-badge-fg, var(--success-fg));
}
.state[data-state='starting'] {
  background: var(--status-badge-bg, var(--status-starting-muted));
  color: var(--status-badge-fg, var(--status-starting-fg));
}
.state[data-state='idle'] {
  background: var(--status-badge-bg, var(--status-idle-muted));
  color: var(--status-badge-fg, var(--status-idle-fg));
}
.state[data-state='awaiting'] {
  background: var(--status-badge-bg, color-mix(in srgb, var(--warning-fg) 20%, transparent));
  color: var(--status-badge-fg, var(--warning-fg));
}
.state[data-state='error'] {
  background: var(--status-badge-bg, var(--danger-deep));
  color: var(--status-badge-fg, var(--danger-fg));
}
.state[data-state='exited'] {
  background: var(--status-badge-bg, var(--bg-muted));
}
/* 'stopped' was painted in literal hex here, which punched a black hole through
   the light theme. It resolves through the palette's `ink` now, matching the
   pane pill. */
.state[data-state='stopped'] {
  background: var(--status-badge-bg, var(--bg-inset));
  color: var(--status-badge-fg, var(--text-bright));
  border: 1px solid var(--border-default);
}
.agent-item.minimized {
  opacity: 0.7;
}

.agent-cmd {
  margin-bottom: 4px;
  overflow: hidden;
}
.agent-cmd code {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-session {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.agent-session-k {
  flex: none;
  font-size: 9px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-muted);
}
/* Command and session id are both machine strings: same chip, one line each,
   truncated rather than wrapped. The full value is in the row's title. */
.agent-item.expanded > .agent-cmd code,
.agent-item.expanded > .agent-session code {
  display: block;
  flex: 1;
  min-width: 0;
  background: var(--bg-muted);
  border-radius: var(--radius-xs);
  padding: 3px 6px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.err {
  color: var(--danger-fg);
  font-size: var(--font-3xs);
  margin: 4px 0;
}
.prompt-block {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
}
.role-line {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
}
.prompt-preview {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bg-inset);
  border-radius: var(--radius-xs);
  font-size: var(--font-3xs);
  line-height: var(--lh-base);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--text-bright);
}
.prompt-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.prompt-head .tiny {
  margin-left: auto;
  font-size: var(--font-3xs);
}
.warn-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.warn-block .warn {
  color: var(--attention-fg);
  margin: 0;
}

/* ── Manual spawn card (matches GitPane git-card / History style) ─────────── */
.spawn-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  overflow: hidden;
  margin-top: 6px;
}
.spawn-card-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  min-height: 28px;
  background: var(--bg-subtle);
  cursor: pointer;
  user-select: none;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-primary);
}
/* The header is a dialog title now, not a fold toggle. */
.spawn-card-hdr { cursor: default; }
.spawn-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
.spawn-card--modal {
  /* Keeps its own 320px: it is a compact spawn card, not a dialog tier. */
  width: min(320px, 92vw);
  max-width: 100%;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated, var(--bg-secondary));
  box-shadow: var(--shadow-modal);
}
.spawn-card--modal .spawn-card-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: default;
}
.spawn-modal-close {
  border: none;
  background: none;
  padding: 0 2px;
  cursor: pointer;
  font-size: var(--font-xs);
  line-height: 1;
  color: var(--text-muted);
}
.spawn-modal-close:hover { color: var(--text-bright); }
.spawn-card-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border-muted);
}

/* ── Shared split-scroll layout (pipeline + explorer + agents) ──────────── */
.pane-split,
.pipeline-split,
.agents-split {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0 -14px -14px; /* compensate sidebar padding */
}
.pane-split .part-top,
.pipeline-split .part-top {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0; /* sections use border-top as divider, no inter-section gap needed */
  padding: 0 14px 4px;
  min-height: 0;
}
.pane-split .part-top.part-top-plugin {
  padding: 0;
  overflow: hidden;
}
/* Pipeline list is the whole scroll area now (nothing sits below it), so it
   needs the same bottom breathing room the agent pane has. */
.pipeline-split .part-top {
  padding-bottom: 14px;
}
.pane-split .part-bottom,
.agents-split .part-bottom {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0 14px 14px;
  min-height: 0;
}
.pane-split .part-resize {
  flex-shrink: 0;
  height: 11px;
  cursor: row-resize;
  display: flex;
  align-items: center;
  background: var(--bg-base);
  border-top: 1px solid var(--border-muted);
  border-bottom: 1px solid var(--border-muted);
  transition: background var(--motion-fast) var(--ease-out);
}
.pane-split .part-resize:hover {
  background: var(--bg-elevated);
}
.pane-split .part-resize-grip {
  margin: 0 auto;
  width: 44px;
  height: 3px;
  border-radius: var(--radius-xs);
  background: var(--text-muted);
  transition: height var(--motion-fast) var(--ease-out), width var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.pane-split .part-resize:hover .part-resize-grip,
.pane-split .part-resize:active .part-resize-grip {
  height: 4px;
  width: 60px;
  background: var(--accent-focus);
}
.pipeline-split .pipeline-detail-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 14px 14px;
  min-height: 0;
}
.plans-split {
  flex: 1;
  min-height: 0;
  margin: 0 -14px -14px;
}
/* ExplorerPane fills its part-top container. The recovery badge is excluded so
   its own `flex: none` survives — otherwise it is stretched down the whole
   column and steals the height the panel below it needs. */
.pane-split .part-top > *:not(.legacy-recovery-label) {
  flex: 1;
  min-height: 0;
}

</style>
