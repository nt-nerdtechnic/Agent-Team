<script setup lang="ts">
// Pipeline Manager modal: unifies pipeline + stage editing and role management,
// replacing the old Role Manager and Stages windows. Hosted inside the main
// window — the backend connection, theme and notification host belong to the
// host app, so this component only owns the pipeline/stage/role UI.
import { computed, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { TerminalDockPort } from '@navide/terminal'
import { useNotify } from '@navide/plugin-ui/foundation'
import { AiCliDock } from '@navide/plugin-shell'
import type { useRoles, Role } from '../composables/useRoles'
import type { usePipelines, PipelineSummary } from '../composables/usePipelines'
import { useStages } from '../composables/useStages'
import { stageToBackend, type AgentKey, type Stage, type StageSlot } from '../data/stages'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { buildPmAiContext } from '../lib/pmAiContext'
import { aiTerminalPaneId } from '@navide/plugin-shell'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  terminalPort: TerminalDockPort
  rolesApi: ReturnType<typeof useRoles>
  pipelinesApi: ReturnType<typeof usePipelines>
  /** Workspace the embedded CLI dock spawns in; empty = no workspace open. */
  workspacePath: string
  /** Deep link: jump straight into this pipeline's detail view when opened. */
  initialPipelineId?: string
  /** Visibility. The modal stays MOUNTED while closed (v-show, not v-if) so the
   *  AiCliDock keeps owning its PTY — unmounting would let the backend janitor
   *  reap a CLI the user is still running. */
  open: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
}>()
const { backend, rolesApi, pipelinesApi } = props

const notify = useNotify()

const activeTab = ref<'pipelines' | 'roles'>('pipelines')

const statusClass = computed(() => {
  switch (backend.status.value) {
    case 'connected': return 'status-connected'
    case 'connecting':
    case 'starting': return 'status-starting'
    case 'disconnected': return 'status-disconnected'
    default: return 'status-error'
  }
})

// Esc is owned by the host's `workbench.action.closeModal` stack — a listener
// here would be dead code behind the capture-phase keybinding dispatcher. The
// host calls this first so a nested confirm dialog closes before the modal.
function closeTopLayer(): boolean {
  const openConfirm = sConfirmDelete.value || sConfirmReset.value || rConfirmDelete.value || rConfirmReset.value
  if (!openConfirm) return false
  sConfirmDelete.value = false
  sConfirmReset.value = false
  rConfirmDelete.value = false
  rConfirmReset.value = false
  return true
}
defineExpose({ closeTopLayer })

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINES TAB — list view (CRUD) + detail view (stage editor)
// ══════════════════════════════════════════════════════════════════════════════

const plView = ref<'list' | 'detail'>('list')
const plEditingId = ref<string>('')
const plNewName = ref('')
const plCreating = ref(false)
const plBusy = ref(false)
const plSummary = ref('')
const plRenamingId = ref('')
const plRenameText = ref('')

// Stage cache scoped to the pipeline being edited: getActivePipelineId feeds
// both refresh() and the stages.changed broadcast filter, so external edits to
// OTHER pipelines never clobber the list shown here.
const stagesApi = useStages(backend, () => plEditingId.value)
const sActiveStages = computed(() => stagesApi.stages.value)

const plCurrentPipeline = computed(
  () => pipelinesApi.pipelines.value.find((p) => p.id === plEditingId.value) ?? null
)

async function plEnterDetail(id: string): Promise<void> {
  plEditingId.value = id
  plView.value = 'detail'
  sSelectedId.value = null
  sDraft.value = null
  sIsNew.value = false
  sError.value = ''
  await stagesApi.refresh(id)
  if (sActiveStages.value.length > 0) sSelectStage(sActiveStages.value[0].id)
}

function plBackToList(): void {
  plView.value = 'list'
  plEditingId.value = ''
  sSelectedId.value = null
  sDraft.value = null
  sIsNew.value = false
}

async function plCreate(): Promise<void> {
  if (!plNewName.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    const p = await pipelinesApi.createPipeline(plNewName.value.trim())
    if (p) { plNewName.value = ''; plCreating.value = false; plSummary.value = `Created "${p.name}"` }
    else notify.toast('Create failed', { type: 'error' })
  } finally {
    plBusy.value = false
  }
}

async function plSetActive(id: string): Promise<void> {
  if (plBusy.value) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.setActivePipeline(id)
    if (ok) plSummary.value = 'Default pipeline updated'
    else notify.toast('Set default failed', { type: 'error' })
  } finally {
    plBusy.value = false
  }
}

function plStartRename(id: string, currentName: string): void {
  plRenamingId.value = id
  plRenameText.value = currentName
}

async function plConfirmRename(): Promise<void> {
  if (!plRenameText.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.renamePipeline(plRenamingId.value, plRenameText.value.trim())
    if (ok) {
      plSummary.value = 'Renamed'
      plRenamingId.value = ''
    } else {
      notify.toast('Rename failed', { type: 'error' })
    }
  } finally {
    plBusy.value = false
  }
}

async function plDelete(id: string, name: string): Promise<void> {
  if (!(await notify.confirm(`Delete "${name}"? This cannot be undone.`, { title: 'Delete Pipeline', confirmText: 'Delete' }))) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.deletePipeline(id)
    if (ok) {
      plSummary.value = `Deleted "${name}"`
      plBackToList()
    } else {
      notify.toast('Delete failed', { type: 'error' })
    }
  } finally {
    plBusy.value = false
  }
}

async function plResetBuiltin(p: PipelineSummary): Promise<void> {
  if (!(await notify.confirm(`Reset "${p.name}" to its factory stages? This cannot be undone.`, { title: 'Reset Pipeline', confirmText: 'Reset' }))) return
  plBusy.value = true
  try {
    const ok = await pipelinesApi.resetBuiltin(p.id)
    if (ok) {
      plSummary.value = `Reset "${p.name}"`
      if (plView.value === 'detail' && plEditingId.value === p.id) {
        await stagesApi.refresh(p.id)
        sSelectStage(sActiveStages.value[0]?.id ?? null)
      }
    }
  } finally {
    plBusy.value = false
  }
}

// Deep link into a pipeline's detail view. Used by the host's
// `initialPipelineId` prop when the modal is opened from a specific pipeline.
// Unknown ids get one list refresh before being ignored.
async function openPipelineDeepLink(pipelineId: string): Promise<void> {
  activeTab.value = 'pipelines'
  if (!pipelinesApi.pipelines.value.some((p) => p.id === pipelineId)) {
    await pipelinesApi.refresh()
    if (!pipelinesApi.pipelines.value.some((p) => p.id === pipelineId)) return
  }
  await plEnterDetail(pipelineId)
}

// Fires when the modal is opened with an id (and on a later id change while it
// stays open); deferred until the pipeline list has loaded.
let deepLinkPending = false
watch(
  () => [props.open, props.initialPipelineId] as const,
  ([open, id], prev) => {
    if (!open) { deepLinkPending = false; return }
    // Only a real closed→open transition resets the view; on the immediate run
    // the state is already fresh and the stage refs below are still in their TDZ.
    const justOpened = !!prev && !prev[0]
    if (!id) {
      // Opened without a deep link. The modal stays mounted between openings so
      // the CLI dock keeps its PTY, so reset the view the way a fresh window did.
      if (justOpened) plBackToList()
      return
    }
    if (!pipelinesApi.isLoaded.value) { deepLinkPending = true; return }
    deepLinkPending = false
    void openPipelineDeepLink(id)
  },
  { immediate: true }
)
watch(
  () => pipelinesApi.isLoaded.value,
  (loaded) => {
    if (!loaded || !deepLinkPending || !props.open) return
    deepLinkPending = false
    if (props.initialPipelineId) void openPipelineDeepLink(props.initialPipelineId)
  }
)

// ══════════════════════════════════════════════════════════════════════════════
// STAGE EDITOR (pipeline detail view)
// ══════════════════════════════════════════════════════════════════════════════

// Every registered CLI vendor is dispatchable — derived from the canonical
// specs. This list was a hand-kept 3-entry subset (claude/codex/antigravity)
// for a long time, which silently hid the other nine CLIs from pipelines.
const AGENT_OPTIONS: { key: AgentKey; label: string }[] = CLI_AGENT_SPECS.map(
  (s) => ({ key: s.agentKey as AgentKey, label: s.label })
)

const sSelectedId = ref<string | null>(null)
const sDraft = ref<Stage | null>(null)
const sIsNew = ref(false)
const sSaving = ref(false)
const sError = ref('')
const sConfirmDelete = ref(false)
const sConfirmReset = ref(false)
const sSummary = ref('')
const sExportBusy = ref(false)
const sImporting = ref(false)
const sAddingSlot = ref(false)
const sEditingSlotIndex = ref<number | null>(null)
const sSlotDraft = ref<StageSlot>({ agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false })

const sIsDirty = computed(() => {
  if (!sDraft.value) return false
  if (sIsNew.value) return true
  const orig = sActiveStages.value.find((s) => s.id === sDraft.value!.id)
  if (!orig) return true
  return JSON.stringify(stageToBackend(sDraft.value)) !== JSON.stringify(stageToBackend(orig))
})
const sCanSave = computed(() => {
  if (!sDraft.value || !sDraft.value.id.trim() || !sDraft.value.title.trim()) return false
  if (!sDraft.value.slots || sDraft.value.slots.length === 0) return false
  if (sIsNew.value && sActiveStages.value.find((s) => s.id === sDraft.value!.id.trim())) return false
  return sIsDirty.value
})

// Keep the selection valid when the stage list changes (broadcasts, deletes).
watch(() => stagesApi.stages.value, (ss) => {
  if (plView.value !== 'detail' || sIsNew.value) return
  if (ss.length > 0 && sSelectedId.value === null) sSelectStage(ss[0].id)
  else if (sSelectedId.value && !ss.find((s) => s.id === sSelectedId.value)) sSelectStage(ss[0]?.id ?? null)
}, { deep: false })

function sSelectStage(id: string | null): void {
  sSelectedId.value = id; sError.value = ''; sAddingSlot.value = false; sEditingSlotIndex.value = null
  if (!id) { sDraft.value = null; return }
  const s = sActiveStages.value.find((s) => s.id === id)
  if (s) { sDraft.value = JSON.parse(JSON.stringify(s)); sIsNew.value = false }
}
function sStartNew(): void {
  sSelectedId.value = null; sError.value = ''; sAddingSlot.value = false; sIsNew.value = true
  sDraft.value = {
    id: '', title: '', shortTitle: '', question: '', description: '',
    recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '', slots: [],
  }
}

async function sSave(): Promise<void> {
  if (!sDraft.value || !sCanSave.value) return
  sSaving.value = true; sError.value = ''
  try {
    const payload = stageToBackend({ ...sDraft.value, id: sDraft.value.id.trim() })
    const resp = await backend.send<{ stage: Record<string, unknown> }>(
      'stages.upsert', { stage: payload, pipeline_id: plEditingId.value }
    )
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Save failed'; return }
    sSummary.value = `Saved "${sDraft.value.title}"`
    sSelectedId.value = sDraft.value.id.trim()
    sIsNew.value = false
    await stagesApi.refresh(plEditingId.value)
  } catch (err) {
    sError.value = err instanceof Error ? err.message : 'Save failed'
  } finally { sSaving.value = false }
}
async function sDoDelete(): Promise<void> {
  if (!sDraft.value || sIsNew.value) { sConfirmDelete.value = false; return }
  try {
    const resp = await backend.send<{ stages: unknown[] }>(
      'stages.delete', { id: sDraft.value.id, pipeline_id: plEditingId.value }
    )
    sConfirmDelete.value = false
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Delete failed'; return }
    sSummary.value = `Deleted "${sDraft.value.id}"`
    await stagesApi.refresh(plEditingId.value)
    sSelectStage(sActiveStages.value[0]?.id ?? null)
  } catch (err) {
    sConfirmDelete.value = false
    sError.value = err instanceof Error ? err.message : 'Delete failed'
  }
}
async function sDoReset(): Promise<void> {
  try {
    const resp = await backend.send<{ stages: unknown[] }>(
      'stages.reset', { pipeline_id: plEditingId.value }
    )
    sConfirmReset.value = false
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Reset failed'; return }
    sSummary.value = 'Reset to factory defaults'
    await stagesApi.refresh(plEditingId.value)
    sSelectStage(sActiveStages.value[0]?.id ?? null)
  } catch (err) {
    sConfirmReset.value = false
    sError.value = err instanceof Error ? err.message : 'Reset failed'
  }
}
async function sMoveUp(index: number): Promise<void> {
  if (index <= 0) return
  const ids = sActiveStages.value.map((s) => s.id)
  ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
  try {
    await backend.send('stages.reorder', { ids, pipeline_id: plEditingId.value })
    await stagesApi.refresh(plEditingId.value)
  } catch { /* ignore transient WS errors for reorder */ }
}
async function sMoveDown(index: number): Promise<void> {
  if (index >= sActiveStages.value.length - 1) return
  const ids = sActiveStages.value.map((s) => s.id)
  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
  try {
    await backend.send('stages.reorder', { ids, pipeline_id: plEditingId.value })
    await stagesApi.refresh(plEditingId.value)
  } catch { /* ignore transient WS errors for reorder */ }
}

function sStartAddSlot(): void {
  sAddingSlot.value = true
  sEditingSlotIndex.value = null
  sSlotDraft.value = { agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false }
}
function sCancelAddSlot(): void { sAddingSlot.value = false; sEditingSlotIndex.value = null }
async function sConfirmAddSlot(): Promise<void> {
  if (!sDraft.value || !sSlotDraft.value.label.trim()) return
  if (!sDraft.value.slots) sDraft.value.slots = []
  sDraft.value.slots.push({ ...sSlotDraft.value })
  sAddingSlot.value = false
  await sSave()
}
function sStartEditSlot(index: number): void {
  sEditingSlotIndex.value = index
  sAddingSlot.value = false
  sSlotDraft.value = { ...sDraft.value!.slots![index] }
}
async function sSaveEditSlot(): Promise<void> {
  if (!sDraft.value?.slots || sEditingSlotIndex.value === null) return
  sDraft.value.slots[sEditingSlotIndex.value] = { ...sSlotDraft.value }
  sEditingSlotIndex.value = null
  await sSave()
}
async function sRemoveSlot(index: number): Promise<void> {
  if (!sDraft.value?.slots || sDraft.value.slots.length <= 1) return  // must keep at least one
  if (sEditingSlotIndex.value === index) sEditingSlotIndex.value = null
  sDraft.value.slots.splice(index, 1)
  await sSave()
}

async function sExport(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  sExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  // Export the snake_case backend shape so a round-trip import (raw dicts fed
  // back to stages.upsert) preserves short_title / slots[].agent_key etc.
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), stages: sActiveStages.value.map(stageToBackend) }
  const result = await window.agentTeam.saveJson({ title: 'Export stages', defaultName: `agent-team-stages-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) sSummary.value = `Exported ${envelope.stages.length} stage(s)`
  sExportBusy.value = false
}
async function sImport(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  sImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import stages JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.stages) ? parsed.stages : [])
      let ok = 0, failed = 0
      for (const entry of raw) {
        const s = entry as Record<string, unknown>
        if (!s.id) { failed++; continue }
        const resp = await backend.send('stages.upsert', { stage: s, pipeline_id: plEditingId.value })
        if (resp.ok) ok++; else failed++
      }
      sSummary.value = `Imported ${ok} stage(s)` + (failed ? ` · ${failed} failed` : '')
      await stagesApi.refresh(plEditingId.value)
    } catch (err) { sError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  sImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// ROLES TAB
// ══════════════════════════════════════════════════════════════════════════════

interface DraftRole {
  key: string; label: string; one_line: string; system_prompt: string
  isNew: boolean; originalKey: string
}

const rSelectedKey = ref<string | null>(null)
const rDraft = ref<DraftRole | null>(null)
const rSaving = ref(false)
const rError = ref('')
const rConfirmDelete = ref(false)
const rConfirmReset = ref(false)
const rSummary = ref('')
const rImporting = ref(false)
const rExportBusy = ref(false)

const rSorted = computed(() =>
  [...rolesApi.roles.value].sort((a, b) => a.label.localeCompare(b.label))
)

watch(() => rolesApi.roles.value, (rs) => {
  // Never steal the draft while the user is composing a new role: rStartNew()
  // leaves rSelectedKey null, which the first branch would otherwise claim.
  if (rDraft.value?.isNew) return
  if (rs.length > 0 && rSelectedKey.value === null) rSelectKey(rs[0].key)
  else if (rSelectedKey.value && !rs.find((r) => r.key === rSelectedKey.value))
    rSelectKey(rs[0]?.key ?? null)
}, { deep: false })

function rFromRole(r: Role, isNew: boolean): DraftRole {
  return { key: r.key, label: r.label, one_line: r.one_line, system_prompt: r.system_prompt, isNew, originalKey: isNew ? '' : r.key }
}
function rSelectKey(key: string | null): void {
  rSelectedKey.value = key; rError.value = ''
  if (!key) { rDraft.value = null; return }
  const r = rolesApi.find(key)
  if (r) rDraft.value = rFromRole(r, false)
}
function rStartNew(): void {
  rSelectedKey.value = null; rError.value = ''
  rDraft.value = { key: '', label: '', one_line: '', system_prompt: '# Role: \nYou are a...\n\n# Guidelines:\n1. ...\n\n# Output Format:\n...', isNew: true, originalKey: '' }
}

const rIsDirty = computed(() => {
  if (!rDraft.value) return false
  if (rDraft.value.isNew) return true
  const r = rolesApi.find(rDraft.value.originalKey)
  if (!r) return true
  return r.label !== rDraft.value.label || r.one_line !== rDraft.value.one_line || r.system_prompt !== rDraft.value.system_prompt || r.key !== rDraft.value.key
})
const rCanSave = computed(() => {
  if (!rDraft.value) return false
  if (!rDraft.value.key.trim() || !rDraft.value.label.trim() || !rDraft.value.system_prompt.trim()) return false
  // Block if the target key is already taken by a DIFFERENT role (covers both new and rename).
  const existing = rolesApi.find(rDraft.value.key.trim())
  if (existing && existing.key !== rDraft.value.originalKey) return false
  return rIsDirty.value
})

async function rSave(): Promise<void> {
  if (!rDraft.value || !rCanSave.value) return
  rSaving.value = true; rError.value = ''; rSummary.value = ''
  const payload = { key: rDraft.value.key.trim(), label: rDraft.value.label.trim(), one_line: rDraft.value.one_line.trim(), system_prompt: rDraft.value.system_prompt }
  // Capture before awaiting — the draft can be swapped out while requests are in flight.
  const originalKey = rDraft.value.originalKey
  const wasRename = !rDraft.value.isNew && originalKey && originalKey !== payload.key
  try {
    // rolesApi.* resolve to null/false on failure instead of throwing, so the
    // catch below never sees backend errors — surface them explicitly.
    const role = await rolesApi.upsert(payload)
    if (!role) {
      rError.value = rolesApi.error.value || 'Save failed'
      notify.toast(rError.value, { type: 'error' })
      return
    }
    if (wasRename && !(await rolesApi.remove(originalKey))) {
      rError.value = rolesApi.error.value || 'Rename cleanup failed'
      notify.toast(rError.value, { type: 'error' })
      return
    }
    rSelectKey(role.key)
    rSummary.value = `Saved "${payload.label}"`
  } catch (err) { rError.value = String((err as Error).message ?? err) }
  finally { rSaving.value = false }
}
async function rDoDelete(): Promise<void> {
  if (!rDraft.value || rDraft.value.isNew) { rConfirmDelete.value = false; return }
  const ok = await rolesApi.remove(rDraft.value.originalKey || rDraft.value.key)
  rConfirmDelete.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else rError.value = rolesApi.error.value
}
async function rDoReset(): Promise<void> {
  const ok = await rolesApi.reset()
  rConfirmReset.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else rError.value = rolesApi.error.value
}
async function rExport(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  rExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), roles: rolesApi.roles.value }
  const result = await window.agentTeam.saveJson({ title: 'Export roles', defaultName: `agent-team-roles-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) rSummary.value = `Exported ${envelope.roles.length} role(s)`
  rExportBusy.value = false
}
async function rImport(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  rImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import roles JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.roles) ? parsed.roles : [])
      let ok = 0
      for (const entry of raw) {
        const e = entry as Record<string, unknown>
        if (typeof e?.key === 'string' && e.key && typeof e.system_prompt === 'string')
          if (await rolesApi.upsert({ key: e.key as string, label: String(e.label ?? e.key), one_line: String(e.one_line ?? ''), system_prompt: e.system_prompt as string })) ok++
      }
      rSummary.value = `Imported ${ok} role(s)`
    } catch (err) { rError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  rImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// AI PANEL — shared AiCliDock (embedded CLI PTY) bound to the host's workspace
// ══════════════════════════════════════════════════════════════════════════════

// The host window's current workspace; empty when none is open, which is the
// dock's own "No workspace available" empty state.
const aiWorkspace = computed(() => props.workspacePath)

// Pane id derived per (surface, workspace) so a PM surface on another workspace
// never steals/reaps this one's PTY; stable for a given workspace, which keeps
// useTerminal's localStorage keys (terminal-pty / terminal-scroll) stable
// across close/reopen — that is what lets a still-running CLI be reattached
// instead of respawned. The dock is keyed by it so switching workspace rebuilds
// the dock (its reattach is once per dock life).
const aiPaneId = computed(() => aiTerminalPaneId('pm', aiWorkspace.value))

/** Snapshot of what the user is looking at, injected by the dock after a
 *  fresh spawn (buildPmAiContext stays a pure, unit-tested function). */
function buildAiContext(): string {
  const inDetail = plView.value === 'detail' && !!plEditingId.value
  return buildPmAiContext({
    workspacePath: aiWorkspace.value,
    pipelineName: inDetail ? (plCurrentPipeline.value?.name ?? plEditingId.value) : null,
    stages: inDetail ? sActiveStages.value.map(stageToBackend) : [],
    pipelines: pipelinesApi.pipelines.value.map((p) => ({
      name: p.name,
      stageCount: p.stage_count,
      isDefault: p.id === pipelinesApi.activePipelineId.value,
    })),
    roles: rolesApi.roles.value.map((r) => ({ key: r.key, label: r.label, oneLine: r.one_line })),
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="pm-overlay" @click.self="emit('close')">
      <div class="pm-modal">
  <div class="app">
    <header class="top">
      <div class="title">Pipeline Manager</div>
      <nav class="tabs">
        <button :class="{ active: activeTab === 'pipelines' }" @click="activeTab = 'pipelines'">
          {{ $t('settings.nav.pipelines') }}
        </button>
        <button :class="{ active: activeTab === 'roles' }" @click="activeTab = 'roles'">
          {{ $t('settings.nav.roles') }}
        </button>
      </nav>
      <div class="meta">
        <span class="dot" :class="statusClass"></span>
        <span>backend {{ backend.status.value }}</span>
      </div>
      <button class="pm-close" title="Close (ESC)" @click="emit('close')">✕</button>
    </header>

    <div class="main-row">
    <div class="tab-col">
    <!-- ── PIPELINES TAB ─────────────────────────────────────────────────── -->
    <div v-show="activeTab === 'pipelines'" class="tab-body">
      <!-- List view -->
      <template v-if="plView === 'list'">
        <div class="toolbar">
          <button class="ghost" :disabled="plBusy" @click="plCreating = !plCreating">＋ New Pipeline</button>
          <span v-if="plSummary" class="summary-ok">{{ plSummary }}</span>
        </div>
        <div v-if="plCreating" class="pl-create-row">
          <input
            v-model="plNewName" type="text" placeholder="Pipeline name…" class="pl-input"
            spellcheck="false"
            @keyup.enter="plCreate" @keyup.escape="plCreating = false; plNewName = ''" />
          <button class="ghost" :disabled="!plNewName.trim() || plBusy" @click="plCreate">Create</button>
          <button class="ghost" @click="plCreating = false; plNewName = ''">Cancel</button>
        </div>
        <ul v-if="pipelinesApi.pipelines.value.length" class="pl-list">
          <li
            v-for="p in pipelinesApi.pipelines.value" :key="p.id"
            class="pl-item" :class="{ 'pl-active': p.id === pipelinesApi.activePipelineId.value }"
            role="button"
            @click="plEnterDetail(p.id)">
            <span class="pl-name">{{ p.name }}</span>
            <span class="pl-meta">{{ p.stage_count }} stage(s)</span>
            <span v-if="p.id === pipelinesApi.activePipelineId.value" class="pl-badge">{{ $t('label.default') }}</span>
            <button
              v-if="p.builtin" class="icon-btn" :disabled="plBusy"
              title="Reset to factory stages"
              @click.stop="plResetBuiltin(p)">↺</button>
            <span class="pl-enter">›</span>
          </li>
        </ul>
        <p v-else class="hint">No pipelines loaded yet…</p>
      </template>

      <!-- Detail view: pipeline header + stage editor -->
      <template v-else>
        <div class="pl-detail-header">
          <button class="ghost back-btn" @click="plBackToList">← Back</button>
          <template v-if="plRenamingId === plEditingId">
            <input
              v-model="plRenameText" class="pl-input pl-rename" spellcheck="false"
              @keyup.enter="plConfirmRename" @keyup.escape="plRenamingId = ''" />
            <button class="ghost tiny" :disabled="plBusy" @click="plConfirmRename">✓</button>
            <button class="ghost tiny" @click="plRenamingId = ''">✕</button>
          </template>
          <template v-else>
            <h2 class="pl-detail-title">
              {{ plCurrentPipeline?.name ?? plEditingId }}
              <button
                class="icon-btn" :disabled="plBusy" :title="$t('action.rename')"
                @click="plStartRename(plEditingId, plCurrentPipeline?.name ?? '')">✎</button>
            </h2>
          </template>
          <div class="pl-detail-actions">
            <span v-if="plEditingId === pipelinesApi.activePipelineId.value" class="pl-badge">{{ $t('label.default') }}</span>
            <button
              v-else class="ghost" :disabled="plBusy"
              @click="plSetActive(plEditingId)">✓ Set as default</button>
            <button
              class="icon-btn danger-icon"
              :disabled="plBusy || pipelinesApi.pipelines.value.length <= 1"
              :title="pipelinesApi.pipelines.value.length <= 1 ? $t('hint.at-least-one-pipeline') : $t('action.delete-pipeline')"
              @click="plDelete(plEditingId, plCurrentPipeline?.name ?? '')">🗑</button>
          </div>
        </div>

        <div v-if="stagesApi.loading.value" class="hint pad">Loading stages…</div>
        <template v-else>
          <div class="toolbar">
            <button class="ghost" :disabled="sExportBusy" @click="sExport">{{ sExportBusy ? '…' : $t('settings.roles.export-json') }}</button>
            <button class="ghost" :disabled="sImporting" @click="sImport">{{ sImporting ? '…' : $t('settings.roles.import-json') }}</button>
            <button class="ghost danger-link" @click="sConfirmReset = true">↺ {{ $t('action.reset-defaults') }}</button>
            <span v-if="sSummary" class="summary-ok">{{ sSummary }}</span>
          </div>
          <div class="split">
            <aside class="split-list">
              <button class="primary new-btn" @click="sStartNew">{{ $t('action.add-stage') }}</button>
              <ul>
                <li
                  v-for="(s, idx) in sActiveStages" :key="s.id"
                  :class="{ active: sSelectedId === s.id && !sIsNew }"
                  @click="sSelectStage(s.id)">
                  <div class="row-g spread">
                    <span class="mono-key">{{ s.id }}</span>
                    <div class="row-g gap">
                      <button class="icon-btn" :disabled="idx === 0" :title="$t('action.move-up')" @click.stop="sMoveUp(idx)">▲</button>
                      <button class="icon-btn" :disabled="idx === sActiveStages.length - 1" :title="$t('action.move-down')" @click.stop="sMoveDown(idx)">▼</button>
                    </div>
                  </div>
                  <div class="item-label">
                    {{ s.shortTitle }}
                    <span v-if="s.slots.some(sl => sl.isCommander)" class="manager-badge" :title="`Manager: ${s.slots.find(sl => sl.isCommander)?.label}`">🎯</span>
                  </div>
                  <div class="item-sub">
                    {{ s.slots.length === 1 ? `${s.slots[0].agentKey} · ${s.slots[0].roleKey}` : `${s.slots.length} parallel slots` }}
                  </div>
                </li>
              </ul>
            </aside>
            <section v-if="sDraft" class="split-detail">
              <div class="detail-head">
                <h3>{{ sIsNew ? $t('label.new-stage') : $t('label.edit-stage') }}</h3>
                <div class="row-g gap">
                  <button v-if="!sIsNew" class="danger" @click="sConfirmDelete = true">{{ $t('settings.roles.delete') }}</button>
                  <button class="primary" :disabled="!sCanSave || sSaving" @click="sSave">{{ sSaving ? $t('label.saving') : sIsNew ? $t('action.create') : $t('settings.roles.save') }}</button>
                </div>
              </div>
              <p v-if="sError" class="err-msg">{{ sError }}</p>
              <div class="two-col">
                <div class="field">
                  <label class="lbl">{{ $t('label.id') }}</label>
                  <input v-model="sDraft.id" type="text" placeholder="e.g. 04.5" spellcheck="false" :disabled="!sIsNew" />
                  <p v-if="sIsNew && sDraft.id && sActiveStages.find(s => s.id === sDraft!.id.trim())" class="warn-msg">{{ $t('error.id-exists') }}</p>
                </div>
                <div class="field">
                  <label class="lbl">{{ $t('label.short-title') }}</label>
                  <input v-model="sDraft.shortTitle" type="text" placeholder="e.g. Review" spellcheck="false" />
                </div>
              </div>
              <div class="field">
                <label class="lbl">{{ $t('label.title') }}</label>
                <input v-model="sDraft.title" type="text" spellcheck="false" />
              </div>
              <div class="two-col">
                <div class="field">
                  <label class="lbl">{{ $t('label.sentinel') }}</label>
                  <input v-model="sDraft.sentinel" type="text" placeholder="---DONE---" spellcheck="false" />
                </div>
                <div class="field">
                  <label class="lbl">Allow questions</label>
                  <label class="check-row"><input v-model="sDraft.allowQuestions" type="checkbox" /><span>Pause for user answers</span></label>
                </div>
              </div>
              <div class="field">
                <label class="lbl">Context7 doc query</label>
                <input v-model="sDraft.docQuery" type="text" placeholder="e.g. security best practices, authentication" spellcheck="false" />
              </div>
              <div class="slots-section">
                <div class="row-g spread">
                  <label class="lbl">Slots <span class="slot-required">* at least one required</span></label>
                  <button class="ghost small" @click="sStartAddSlot">{{ $t('action.add-slot') }}</button>
                </div>
                <p v-if="!sDraft.slots?.length" class="warn-msg">Add at least one slot before saving.</p>
                <template v-for="(slot, i) in sDraft.slots" :key="i">
                  <div v-if="sEditingSlotIndex !== i" class="slot-item" @click="sStartEditSlot(i)">
                    <div class="row-g spread">
                      <span class="item-label">{{ slot.label }}<span v-if="slot.isCommander" class="manager-badge">🎯 Manager</span></span>
                      <button class="icon-btn danger-icon" :disabled="sDraft.slots.length <= 1" title="Cannot delete the last slot" @click.stop="sRemoveSlot(i)">✕</button>
                    </div>
                    <div class="item-sub">{{ slot.agentKey }} · {{ slot.roleKey }}</div>
                  </div>
                  <div v-else class="slot-form">
                    <div class="two-col">
                      <div class="field"><label class="lbl">{{ $t('label.label') }}</label><input v-model="sSlotDraft.label" type="text" spellcheck="false" /></div>
                      <div class="field"><label class="lbl">{{ $t('label.agent') }}</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                    </div>
                    <div class="field">
                      <label class="lbl">{{ $t('label.role-key') }}</label>
                      <select v-model="sSlotDraft.roleKey">
                        <option value="">(unassigned)</option>
                        <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                      </select>
                    </div>
                    <label class="check-row manager-toggle">
                      <input v-model="sSlotDraft.isCommander" type="checkbox" />
                      <span><strong>🎯 Designate as global manager</strong> — This slot finishes its own work, prints <code>---MANAGER-READY---</code>, then coordinates across stages. Only one manager per pipeline.</span>
                    </label>
                    <div class="field"><label class="lbl">{{ $t('label.kickoff-body') }}</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false" class="mono"></textarea></div>
                    <div class="row-g gap">
                      <button class="ghost" @click="sCancelAddSlot">{{ $t('action.cancel') }}</button>
                      <button class="primary" :disabled="!sSlotDraft.label.trim()" @click="sSaveEditSlot">Save slot</button>
                    </div>
                  </div>
                </template>
                <div v-if="sAddingSlot" class="slot-form">
                  <div class="two-col">
                    <div class="field"><label class="lbl">{{ $t('label.label') }}</label><input v-model="sSlotDraft.label" type="text" spellcheck="false" /></div>
                    <div class="field"><label class="lbl">{{ $t('label.agent') }}</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                  </div>
                  <div class="field">
                    <label class="lbl">{{ $t('label.role-key') }}</label>
                    <select v-model="sSlotDraft.roleKey">
                      <option value="">(unassigned)</option>
                      <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                    </select>
                  </div>
                  <label class="check-row manager-toggle">
                    <input v-model="sSlotDraft.isCommander" type="checkbox" />
                    <span><strong>🎯 Designate as global manager</strong> — Only one per pipeline.</span>
                  </label>
                  <div class="field"><label class="lbl">{{ $t('label.kickoff-body') }}</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false" class="mono"></textarea></div>
                  <div class="row-g gap">
                    <button class="ghost" @click="sCancelAddSlot">{{ $t('action.cancel') }}</button>
                    <button class="primary" :disabled="!sSlotDraft.label.trim()" @click="sConfirmAddSlot">{{ $t('action.add') }}</button>
                  </div>
                </div>
              </div>
            </section>
            <section v-else class="split-detail empty-detail">
              <p>{{ $t('hint.select-stage-or-create') }}</p>
            </section>
          </div>
        </template>
      </template>
    </div>

    <!-- ── ROLES TAB ─────────────────────────────────────────────────────── -->
    <div v-show="activeTab === 'roles'" class="tab-body">
      <div class="toolbar">
        <button class="ghost" :disabled="rExportBusy" @click="rExport">{{ rExportBusy ? '…' : $t('settings.roles.export-json') }}</button>
        <button class="ghost" :disabled="rImporting" @click="rImport">{{ rImporting ? '…' : $t('settings.roles.import-json') }}</button>
        <button class="ghost danger-link" @click="rConfirmReset = true">↺ {{ $t('action.reset-defaults') }}</button>
        <span v-if="rSummary" class="summary-ok">{{ rSummary }}</span>
      </div>
      <div class="split">
        <aside class="split-list">
          <button class="primary new-btn" @click="rStartNew">{{ $t('settings.roles.new-role') }}</button>
          <ul>
            <li
              v-for="r in rSorted" :key="r.key"
              :class="{ active: rSelectedKey === r.key && rDraft && !rDraft.isNew }"
              @click="rSelectKey(r.key)">
              <div class="row-g"><span class="mono-key">{{ r.key }}</span><span v-if="r.is_default" class="badge">default</span></div>
              <div class="item-label">{{ r.label }}</div>
              <div class="item-sub">{{ r.one_line }}</div>
            </li>
          </ul>
        </aside>
        <section v-if="rDraft" class="split-detail">
          <div class="detail-head">
            <h3>{{ rDraft.isNew ? $t('label.new-role') : $t('label.edit-role') }}</h3>
            <div class="row-g gap">
              <button v-if="!rDraft.isNew" class="danger" @click="rConfirmDelete = true">{{ $t('settings.roles.delete') }}</button>
              <button class="primary" :disabled="!rCanSave || rSaving" @click="rSave">{{ rSaving ? $t('label.saving') : rDraft.isNew ? $t('action.create') : $t('settings.roles.save') }}</button>
            </div>
          </div>
          <p v-if="rError" class="err-msg">{{ rError }}</p>
          <div class="two-col">
            <div class="field">
              <label class="lbl">{{ $t('settings.roles.key-label') }}</label>
              <input v-model="rDraft.key" type="text" placeholder="lowercase_key" spellcheck="false" :disabled="!rDraft.isNew && rDraft.originalKey === 'pm'" />
              <p v-if="rDraft.isNew && rolesApi.find(rDraft.key.trim())" class="warn-msg">key already exists</p>
            </div>
            <div class="field">
              <label class="lbl">{{ $t('settings.roles.label-label') }}</label>
              <input v-model="rDraft.label" type="text" placeholder="e.g. Tech Lead" spellcheck="false" />
            </div>
          </div>
          <div class="field">
            <label class="lbl">{{ $t('settings.roles.one-line-label') }}</label>
            <input v-model="rDraft.one_line" type="text" placeholder="short hint shown in dropdown" spellcheck="false" />
          </div>
          <div class="field">
            <label class="lbl">{{ $t('settings.roles.system-prompt-label') }}</label>
            <textarea v-model="rDraft.system_prompt" rows="14" spellcheck="false"></textarea>
            <p class="hint">{{ rDraft.system_prompt.length }} chars · Changes apply to new spawns only</p>
          </div>
        </section>
        <section v-else class="split-detail empty-detail">
          <p>{{ $t('hint.select-role-or-create') }}</p>
        </section>
      </div>
    </div>
    </div><!-- end tab-col -->

    <!-- Right AI terminal dock (rail toggle + resize + embedded CLI PTY) -->
    <AiCliDock
      :key="aiPaneId"
      width-key="pm-ai-panel-width"
      agent-key-storage-key="pm-ai-agent"
      :pane-id="aiPaneId"
      origin="pipeline-manager"
      :workspace-path="aiWorkspace"
      :terminal-port="terminalPort"
      :build-context="buildAiContext"
    />
    </div><!-- end main-row -->

    <!-- ── Confirm dialogs ───────────────────────────────────────────────── -->
    <div v-if="sConfirmDelete" class="modal" @click.self="sConfirmDelete = false">
      <div class="modal-card">
        <h3>{{ $t('hint.delete-stage-title') }}</h3>
        <p>{{ $t('hint.delete-stage-warning') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="sConfirmDelete = false">{{ $t('action.cancel') }}</button>
          <button class="danger" @click="sDoDelete">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
    <div v-if="sConfirmReset" class="modal" @click.self="sConfirmReset = false">
      <div class="modal-card">
        <h3>{{ $t('hint.reset-stages-title') }}</h3>
        <p>{{ $t('hint.reset-stages-warning') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="sConfirmReset = false">{{ $t('action.cancel') }}</button>
          <button class="danger" @click="sDoReset">{{ $t('action.reset') }}</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmDelete" class="modal" @click.self="rConfirmDelete = false">
      <div class="modal-card">
        <h3>{{ $t('settings.roles.delete-confirm-title', { label: rDraft?.label }) }}</h3>
        <p>{{ $t('settings.roles.cannot-undo') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="rConfirmDelete = false">{{ $t('action.cancel') }}</button>
          <button class="danger" @click="rDoDelete">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmReset" class="modal" @click.self="rConfirmReset = false">
      <div class="modal-card">
        <h3>{{ $t('settings.roles.reset-confirm-title') }}</h3>
        <p>{{ $t('settings.roles.reset-confirm-body') }}</p>
        <div class="modal-actions">
          <button class="ghost" @click="rConfirmReset = false">{{ $t('action.cancel') }}</button>
          <button class="danger" @click="rDoReset">{{ $t('action.reset-defaults') }}</button>
        </div>
      </div>
    </div>
  </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pm-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  z-index: 8000;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.pm-modal {
  width: 92vw;
  max-width: 1100px;
  height: 88vh;
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
}
.pm-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.pm-close:hover {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-inset);
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  overflow: hidden;
}
.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.tabs {
  display: flex;
  gap: 2px;
}
.tabs button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.tabs button:hover {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.tabs button.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-weight: 600;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-secondary);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.dot.status-connected { background: var(--success-fg); }
.dot.status-starting { background: var(--attention-fg); }
.dot.status-disconnected { background: var(--text-secondary); }
.dot.status-error { background: var(--danger-fg); }

.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
.tab-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.tab-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 16px;
  flex-shrink: 0;
}
.toolbar button {
  font-size: 11px;
  padding: 5px 10px;
}
.summary-ok {
  font-size: 11px;
  color: var(--success-fg);
}

/* ── Pipeline list view ───────────────────────────────────────────────────── */
.pl-create-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 0 16px 8px;
}
.pl-input {
  flex: 0 1 260px;
}
.pl-list {
  list-style: none;
  margin: 0 16px;
  padding: 0;
  overflow-y: auto;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
}
.pl-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bg-subtle);
  cursor: pointer;
}
.pl-item:last-child {
  border-bottom: none;
}
.pl-item:hover {
  background: var(--bg-subtle);
}
.pl-item.pl-active {
  background: var(--accent-subtle);
}
.pl-name {
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-meta {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.pl-badge {
  font-size: 10px;
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid color-mix(in srgb, var(--success-strong) 33%, transparent);
  border-radius: 3px;
  padding: 1px 5px;
  white-space: nowrap;
}
.pl-enter {
  color: var(--text-muted);
  font-size: 14px;
}

/* ── Pipeline detail header ───────────────────────────────────────────────── */
.pl-detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 0;
  flex-shrink: 0;
}
.back-btn {
  font-size: 11px;
  padding: 3px 8px;
  color: var(--text-secondary);
}
.back-btn:hover {
  color: var(--text-bright);
}
.pl-detail-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--accent-bright);
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-rename {
  flex: 0 1 260px;
}
.pl-detail-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.tiny {
  font-size: 11px;
  padding: 3px 7px;
}
.pad {
  padding: 8px 16px;
}

/* ── Split layout (list + editor) ─────────────────────────────────────────── */
.split {
  flex: 1;
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
  border-top: 1px solid var(--border-muted);
}
.split-list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-muted);
  background: var(--bg-base);
  overflow-y: auto;
}
.new-btn {
  margin: 10px;
  flex-shrink: 0;
}
.split-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.split-list li {
  padding: 9px 12px;
  border-bottom: 1px solid var(--bg-subtle);
  cursor: pointer;
}
.split-list li:hover {
  background: var(--bg-subtle);
}
.split-list li.active {
  background: var(--accent-subtle);
}
.split-detail {
  padding: 14px 18px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.empty-detail {
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-muted);
}
.detail-head h3 {
  margin: 0;
  font-size: 15px;
}
.row-g {
  display: flex;
  align-items: center;
  gap: 6px;
}
.row-g.gap {
  gap: 8px;
}
.row-g.spread {
  justify-content: space-between;
  width: 100%;
}
.mono-key {
  font-family: Menlo, Monaco, monospace;
  font-size: 10px;
  color: var(--accent-bright);
  background: var(--bg-muted);
  padding: 1px 6px;
  border-radius: 4px;
}
.badge {
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
}
.item-label {
  font-weight: 600;
  margin-top: 2px;
}
.item-sub {
  color: var(--text-secondary);
  font-size: 11px;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.manager-badge {
  margin-left: 4px;
  font-size: 10px;
}

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
input[type='text'],
select,
textarea {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 8px 10px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 13px;
  box-sizing: border-box;
  width: 100%;
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
textarea.mono {
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  min-height: 100px;
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  cursor: pointer;
}
.check-row input[type='checkbox'] {
  width: 14px;
  height: 14px;
  accent-color: var(--attention-fg);
}
.manager-toggle {
  align-items: flex-start;
  line-height: 1.5;
}
.manager-toggle input[type='checkbox'] {
  margin-top: 2px;
  flex-shrink: 0;
}

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}
button.danger:hover {
  background: var(--danger-muted);
}
button.ghost {
  background: transparent;
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}
button.small {
  font-size: 11px;
  padding: 4px 10px;
}
.icon-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.danger-icon {
  color: var(--danger-fg);
}
.danger-link {
  color: var(--danger-fg);
}

/* ── Slots ────────────────────────────────────────────────────────────────── */
.slots-section {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.slot-required {
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text-muted);
}
.slot-item {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 8px 10px;
  cursor: pointer;
}
.slot-item:hover {
  border-color: var(--border-default);
}
.slot-form {
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 10px;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── Messages ─────────────────────────────────────────────────────────────── */
.hint {
  color: var(--text-secondary);
  font-size: 11px;
  margin: 0;
}
.warn-msg {
  color: var(--attention-fg);
  font-size: 11px;
  margin: 4px 0 0;
}
.err-msg {
  color: var(--danger-fg);
  font-size: 12px;
  margin: 0;
}

/* ── Modals ───────────────────────────────────────────────────────────────── */
/* Nested inside .pm-overlay (z-index 8000): must sit above the modal shell that
   hosts them, hence a z-index past the shell's own stacking level. */
.modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 8100;
}
.modal-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px 22px;
  max-width: 460px;
}
.modal-card h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.modal-card p {
  font-size: 12px;
  color: var(--text-primary);
  margin: 0 0 14px;
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
