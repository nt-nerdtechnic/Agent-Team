<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import ToggleSwitch from './settings/ToggleSwitch.vue'

type Backend = ReturnType<typeof useBackend>

interface SkillSummary {
  name: string
  description: string
  enabled: boolean
  valid?: boolean
  nativeConflict?: boolean
  /** Agent keys this skill is restricted to; null = every wired agent. */
  targets: string[] | null
  /** Created by Navide (editable, deletable) vs. put in the shared root by the user. */
  managed: boolean
  /** Original location, when this skill was migrated from a CLI's own directory. */
  migratedFrom: string | null
  path?: string
}

/**
 * A skill a CLI keeps in its own directory. Read-only reflection: Navide
 * lists it and can deliver it to *other* agents, but never edits or moves it.
 */
interface NativeSkill {
  name: string
  description: string
  /** Root it was found under, e.g. "copilot". */
  source: string
  /** Agent that already reads it without Navide's help. */
  ownerAgent: string
  path: string
  /** Resolved directory — the identity, since names collide across roots. */
  realPath: string
  aliases: string[]
  valid: boolean
  error: string
  /** Agents the user chose to deliver it to; opt-in, empty by default. */
  targets: string[]
}

/** One CLI vendor and what the managed library can do with it. */
interface SkillAgent {
  key: string
  label: string
  state: 'wired' | 'planned' | 'unsupported'
  /** Discovers ~/.agents/skills itself: shared skills reach it with no delivery. */
  readsSharedRoot: boolean
}

/** One matrix row: a shared skill or a native one, behind one interface. */
type MatrixRow =
  | { kind: 'shared'; key: string; skill: SkillSummary }
  | { kind: 'native'; key: string; skill: NativeSkill }

interface SkillAttachment {
  name: string
  path?: string
}

interface SkillDraft extends SkillSummary {
  revision: string | null
  body: string
  userInvocable: boolean
  disableModelInvocation: boolean
  allowedTools: string
  disallowedTools: string
  model: string
  effort: string
  context: string
  attachments: SkillAttachment[]
  fieldKeys: Set<string>
}

interface ResponseLike {
  payload?: unknown
  error?: { code?: string; message?: string } | null
}

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const skills = ref<SkillSummary[]>([])
const nativeSkills = ref<NativeSkill[]>([])
const agents = ref<SkillAgent[]>([])
/** Whether the user has once allowed writes into ~/.agents/skills. */
const writeConsented = ref(false)
const view = ref<'list' | 'matrix'>('list')
const rootPath = ref('')
const selectedName = ref('')
const draft = ref<SkillDraft | null>(null)
const query = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const creating = ref(false)
const newName = ref('')
const newDescription = ref('')

const filteredNative = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return nativeSkills.value
  return nativeSkills.value.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(needle)
  )
})

async function openNativeFolder(skill: NativeSkill): Promise<void> {
  if (skill.path) await window.agentTeam?.openPath?.(skill.path)
}

const filteredSkills = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return skills.value
  return skills.value.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(needle)
  )
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeSummary(value: unknown): SkillSummary | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  return {
    name: value.name,
    description: stringValue(value.description),
    enabled: booleanValue(value.enabled, true),
    valid: typeof value.valid === 'boolean' ? value.valid : undefined,
    nativeConflict: typeof (value.native_conflict ?? value.nativeConflict) === 'boolean'
      ? Boolean(value.native_conflict ?? value.nativeConflict)
      : undefined,
    targets: normalizeTargets(value.targets),
    managed: booleanValue(value.managed, true),
    migratedFrom: stringValue(value.migrated_from) || null,
    path: stringValue(value.path) || undefined,
  }
}

function normalizeNative(value: unknown, targets: Record<string, string[]>): NativeSkill | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  const realPath = stringValue(value.real_path)
  if (!realPath) return null
  return {
    name: value.name,
    description: stringValue(value.description),
    source: stringValue(value.source),
    ownerAgent: stringValue(value.owner_agent) || stringValue(value.source),
    path: stringValue(value.path),
    realPath,
    aliases: Array.isArray(value.aliases)
      ? value.aliases.filter((item): item is string => typeof item === 'string')
      : [],
    valid: booleanValue(value.valid, true),
    error: stringValue(value.error),
    targets: targets[realPath] ?? [],
  }
}

function normalizeNativeTargets(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [real, agents] of Object.entries(value)) {
    if (Array.isArray(agents)) out[real] = agents.filter((a): a is string => typeof a === 'string')
  }
  return out
}

function normalizeTargets(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeAgents(value: unknown): SkillAgent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.key !== 'string' || !entry.key) return []
    const state = entry.state
    return [{
      key: entry.key,
      label: stringValue(entry.label) || entry.key,
      state: state === 'wired' || state === 'planned' ? state : 'unsupported',
      readsSharedRoot: booleanValue(entry.reads_shared_root, false),
    }]
  })
}

function normalizeAttachments(value: unknown): SkillAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [{ name: entry }]
    if (!isRecord(entry)) return []
    const name = stringValue(entry.name || entry.relative_path || entry.path)
    return name ? [{ name, path: stringValue(entry.path) || undefined }] : []
  })
}

function normalizeDraft(value: unknown): SkillDraft | null {
  const summary = normalizeSummary(value)
  if (!summary || !isRecord(value)) return null
  const fields = isRecord(value.fields) ? value.fields : value
  const list = (key: string): string => {
    const raw = fields[key]
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').join(', ') : stringValue(raw)
  }
  return {
    ...summary,
    description: stringValue(fields.description, summary.description),
    revision: stringValue(value.revision) || null,
    body: stringValue(value.body),
    userInvocable: booleanValue(fields['user-invocable'] ?? fields.user_invocable, true),
    disableModelInvocation: booleanValue(
      fields['disable-model-invocation'] ?? fields.disable_model_invocation,
      false
    ),
    allowedTools: list('allowed-tools') || list('allowed_tools'),
    disallowedTools: list('disallowed-tools') || list('disallowed_tools'),
    model: stringValue(fields.model),
    effort: stringValue(fields.effort),
    context: stringValue(fields.context),
    attachments: normalizeAttachments(value.attachments ?? value.files),
    fieldKeys: new Set(Object.keys(fields)),
  }
}

function commaList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function setAliasedField(
  fields: Record<string, unknown>,
  existingKeys: Set<string>,
  canonicalKey: string,
  legacyKey: string,
  value: unknown
): void {
  fields[canonicalKey] = value
  // The backend merges patches, so an existing legacy alias cannot be removed here.
  // Keep it synchronized with the canonical hyphenated key instead.
  if (existingKeys.has(legacyKey)) fields[legacyKey] = value
}

function responseMessage(resp: ResponseLike, fallback: string): string {
  const payload = isRecord(resp.payload) ? resp.payload : null
  return stringValue(payload?.error) || resp.error?.message || fallback
}

function isConflictResponse(resp: ResponseLike): boolean {
  const payload = isRecord(resp.payload) ? resp.payload : null
  return payload?.conflict === true || resp.error?.code === 'SKILL_CONFLICT'
}

async function loadSkills(preferredName = selectedName.value): Promise<void> {
  loading.value = true
  error.value = ''
  conflict.value = false
  try {
    const resp = await props.backend.send<{
      skills?: unknown[]
      native?: unknown[]
      native_targets?: unknown
      agents?: unknown[]
      root?: string
      write_consented?: boolean
      ok?: boolean
      error?: string
    }>('skills.list', {})
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-load'))
      return
    }
    skills.value = (resp.payload?.skills ?? []).flatMap((item) => {
      const skill = normalizeSummary(item)
      return skill ? [skill] : []
    })
    agents.value = normalizeAgents(resp.payload?.agents)
    const nativeTargets = normalizeNativeTargets(resp.payload?.native_targets)
    nativeSkills.value = (resp.payload?.native ?? []).flatMap((item) => {
      const skill = normalizeNative(item, nativeTargets)
      return skill ? [skill] : []
    })
    rootPath.value = stringValue(resp.payload?.root)
    writeConsented.value = booleanValue(resp.payload?.write_consented, false)
    const next = skills.value.find((skill) => skill.name === preferredName)?.name
      ?? skills.value[0]?.name
      ?? ''
    if (next) await selectSkill(next)
    else {
      selectedName.value = ''
      draft.value = null
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function selectSkill(name: string): Promise<void> {
  selectedName.value = name
  draft.value = null
  busy.value = true
  error.value = ''
  conflict.value = false
  try {
    const resp = await props.backend.send<{ skill?: unknown; ok?: boolean; error?: string }>('skills.get', { name })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-load-one'))
      return
    }
    const next = normalizeDraft(resp.payload?.skill)
    if (!next) {
      error.value = t('settings.skills.error-invalid-response')
      return
    }
    draft.value = next
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

/**
 * Ask once before the first write into the user's own ~/.agents/skills.
 * The text names the exact directory and what will land there; declining
 * writes nothing. Consent is recorded server-side and never asked again.
 */
function askWriteConsent(root: string): boolean {
  return window.confirm(t('settings.skills.consent-body', { root }))
}

async function createSkill(): Promise<void> {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  error.value = ''
  try {
    let consent = writeConsented.value
    if (!consent) {
      consent = askWriteConsent(rootPath.value)
      if (!consent) return
    }
    let resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.create', {
      name,
      description: newDescription.value.trim(),
      consent,
    })
    // The backend is the source of truth for consent; if it still wants it
    // (e.g. state file reset), ask now rather than fail.
    if (!resp.ok && resp.error?.code === 'SKILL_CONSENT_REQUIRED') {
      const root = (resp.error.details as { root?: string } | undefined)?.root ?? rootPath.value
      if (!askWriteConsent(root)) return
      resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.create', {
        name,
        description: newDescription.value.trim(),
        consent: true,
      })
    }
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-create'))
      return
    }
    writeConsented.value = true
    creating.value = false
    newName.value = ''
    newDescription.value = ''
    await loadSkills(name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function saveSkill(): Promise<void> {
  if (!draft.value || busy.value) return
  busy.value = true
  error.value = ''
  conflict.value = false
  const current = draft.value
  try {
    const fields: Record<string, unknown> = {
      name: current.name,
      description: current.description,
    }
    setAliasedField(fields, current.fieldKeys, 'user-invocable', 'user_invocable', current.userInvocable)
    setAliasedField(
      fields,
      current.fieldKeys,
      'disable-model-invocation',
      'disable_model_invocation',
      current.disableModelInvocation
    )
    const advanced: Array<[string, string | null, string | string[]]> = [
      ['allowed-tools', 'allowed_tools', commaList(current.allowedTools)],
      ['disallowed-tools', 'disallowed_tools', commaList(current.disallowedTools)],
      ['model', null, current.model],
      ['effort', null, current.effort],
      ['context', null, current.context],
    ]
    for (const [key, legacyKey, value] of advanced) {
      if (
        (Array.isArray(value) ? value.length > 0 : value !== '')
        || current.fieldKeys.has(key)
        || (legacyKey !== null && current.fieldKeys.has(legacyKey))
      ) {
        if (legacyKey === null) fields[key] = value
        else setAliasedField(fields, current.fieldKeys, key, legacyKey, value)
      }
    }
    const resp = await props.backend.send<{ ok?: boolean; skill?: unknown; revision?: string; conflict?: boolean; error?: string }>(
      'skills.save',
      {
        name: current.name,
        fields,
        body: current.body,
        expected_revision: current.revision,
      }
    )
    if (!resp.ok || resp.payload?.ok === false) {
      conflict.value = isConflictResponse(resp)
      error.value = responseMessage(
        resp,
        conflict.value ? t('settings.skills.conflict-body') : t('settings.skills.error-save')
      )
      return
    }
    const savedSkill = isRecord(resp.payload?.skill) ? resp.payload.skill : null
    current.revision = stringValue(savedSkill?.revision, current.revision ?? '') || current.revision
    const summary = skills.value.find((skill) => skill.name === current.name)
    if (summary) summary.description = current.description
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function setEnabled(skill: SkillSummary, enabled: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.set_enabled', {
      name: skill.name,
      enabled,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-toggle'))
      return
    }
    skill.enabled = enabled
    if (draft.value?.name === skill.name) draft.value.enabled = enabled
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function deleteSkill(): Promise<void> {
  if (!draft.value || busy.value) return
  const name = draft.value.name
  if (!window.confirm(t('settings.skills.delete-confirm', { name }))) return
  busy.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.delete', { name })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-delete'))
      return
    }
    await loadSkills()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function openSkillFolder(): Promise<void> {
  const path = draft.value?.path || rootPath.value
  if (path) await window.agentTeam?.openPath?.(path)
}

const wiredAgents = computed(() => agents.value.filter((agent) => agent.state === 'wired'))

/** Every matrix row: shared skills first, then the CLIs' own, in one shape. */
const matrixRows = computed<MatrixRow[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const match = (name: string, description: string) =>
    !needle || `${name} ${description}`.toLowerCase().includes(needle)
  return [
    ...skills.value
      .filter((skill) => match(skill.name, skill.description))
      .map((skill): MatrixRow => ({ kind: 'shared', key: `shared:${skill.name}`, skill })),
    ...nativeSkills.value
      .filter((skill) => match(skill.name, skill.description))
      .map((skill): MatrixRow => ({ kind: 'native', key: `native:${skill.realPath}`, skill })),
  ]
})

type CellState = 'auto' | 'on' | 'off' | 'planned' | 'unsupported'

/**
 * What one matrix cell means. "auto" is the state a switch cannot express:
 * the agent already reads this skill on its own, so it is delivered without
 * Navide and cannot be withheld without touching the user's directory.
 */
function cellState(row: MatrixRow, agent: SkillAgent): CellState {
  if (agent.state !== 'wired') return agent.state
  if (row.kind === 'shared') {
    if (agent.readsSharedRoot) return 'auto'
    if (!row.skill.enabled) return 'off'
    return row.skill.targets === null || row.skill.targets.includes(agent.key) ? 'on' : 'off'
  }
  if (agent.key === row.skill.ownerAgent) return 'auto'
  if (!row.skill.valid) return 'off'
  return row.skill.targets.includes(agent.key) ? 'on' : 'off'
}

function delivers(row: MatrixRow, agent: SkillAgent): boolean {
  const state = cellState(row, agent)
  return state === 'on' || state === 'auto'
}

/** A cell the user can toggle: wired agent, not automatic, row not switched off. */
function cellEditable(row: MatrixRow, agent: SkillAgent): boolean {
  if (agent.state !== 'wired') return false
  if (row.kind === 'shared') return !agent.readsSharedRoot && row.skill.enabled
  return agent.key !== row.skill.ownerAgent && row.skill.valid
}

function cellHint(row: MatrixRow, agent: SkillAgent): string {
  const skill = row.skill.name
  const state = cellState(row, agent)
  if (state === 'planned') return t('settings.skills.matrix-planned-hint', { agent: agent.label })
  if (state === 'unsupported') return t('settings.skills.matrix-unsupported-hint', { agent: agent.label })
  if (state === 'auto') {
    return row.kind === 'shared'
      ? t('settings.skills.matrix-auto-shared-hint', { agent: agent.label })
      : t('settings.skills.matrix-auto-native-hint', { agent: agent.label })
  }
  return t('settings.skills.matrix-cell', { skill, agent: agent.label })
}

function cellGlyph(row: MatrixRow, agent: SkillAgent): string {
  const state = cellState(row, agent)
  if (state === 'unsupported') return '—'
  if (state === 'planned') return '·'
  if (state === 'auto') return '●'
  return state === 'on' ? '✓' : ''
}

/** Agents a row can be toggled for — the ones a full "All" would name. */
function editableAgents(row: MatrixRow): SkillAgent[] {
  return wiredAgents.value.filter((agent) => cellEditable(row, agent))
}

async function setTargets(skill: SkillSummary, next: string[] | null): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const previous = skill.targets
  skill.targets = next
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.set_targets', {
      name: skill.name,
      agents: next,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      skill.targets = previous
      error.value = responseMessage(resp, t('settings.skills.error-targets'))
      return
    }
    if (draft.value?.name === skill.name) draft.value.targets = next
  } catch (err) {
    skill.targets = previous
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function setNativeTargets(skill: NativeSkill, next: string[]): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  const previous = skill.targets
  skill.targets = next
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>(
      'skills.set_native_targets',
      { real_path: skill.realPath, agents: next }
    )
    if (!resp.ok || resp.payload?.ok === false) {
      skill.targets = previous
      error.value = responseMessage(resp, t('settings.skills.error-targets'))
    }
  } catch (err) {
    skill.targets = previous
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

/** Toggle one cell. Shared rows materialize the implicit "every agent" list first. */
async function toggleCell(row: MatrixRow, agent: SkillAgent): Promise<void> {
  if (!cellEditable(row, agent)) return
  if (row.kind === 'native') {
    const current = row.skill.targets
    const next = current.includes(agent.key)
      ? current.filter((key) => key !== agent.key)
      : [...current, agent.key]
    await setNativeTargets(row.skill, next)
    return
  }
  const editable = editableAgents(row).map((entry) => entry.key)
  const current = row.skill.targets ?? editable
  const next = current.includes(agent.key)
    ? current.filter((key) => key !== agent.key)
    : [...current, agent.key]
  // Back to every editable agent means no restriction at all, so the skill
  // keeps following the agent list instead of freezing today's members.
  const all = editable.every((key) => next.includes(key))
  await setTargets(row.skill, all ? null : next)
}

async function setRow(row: MatrixRow, all: boolean): Promise<void> {
  if (row.kind === 'native') {
    if (!row.skill.valid) return
    await setNativeTargets(row.skill, all ? editableAgents(row).map((a) => a.key) : [])
    return
  }
  if (!row.skill.enabled) return
  await setTargets(row.skill, all ? null : [])
}

/**
 * Migrate a CLI's own skill into ~/.agents/skills. Per-item, every time,
 * with the three facts the plan requires spelled out: what moves, what is
 * left in its place, and that it can be undone. Declining does nothing.
 */
async function migrateNative(skill: NativeSkill): Promise<void> {
  if (busy.value || !skill.valid) return
  const ok = window.confirm(
    t('settings.skills.migrate-body', { name: skill.name, from: skill.path, root: rootPath.value, agent: skill.source })
  )
  if (!ok) return
  busy.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.migrate_native', {
      real_path: skill.realPath,
      consent: true,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-migrate'))
      return
    }
    await loadSkills(skill.name)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

/** Undo a migration: the skill goes back where it came from, the link goes away. */
async function restoreNative(skill: SkillSummary): Promise<void> {
  if (busy.value || !skill.migratedFrom) return
  const ok = window.confirm(t('settings.skills.restore-body', { name: skill.name, to: skill.migratedFrom }))
  if (!ok) return
  busy.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ ok?: boolean; error?: string }>('skills.restore_native', {
      name: skill.name,
    })
    if (!resp.ok || resp.payload?.ok === false) {
      error.value = responseMessage(resp, t('settings.skills.error-restore'))
      return
    }
    await loadSkills()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function rowSourceLabel(row: MatrixRow): string {
  if (row.kind === 'shared') {
    if (row.skill.migratedFrom) return t('settings.skills.source-migrated')
    return row.skill.managed
      ? t('settings.skills.source-shared')
      : t('settings.skills.source-shared-user')
  }
  return t('settings.skills.source-native', { agent: row.skill.source })
}

async function openRowFolder(row: MatrixRow): Promise<void> {
  const path = row.kind === 'shared' ? row.skill.path : row.skill.path
  if (path) await window.agentTeam?.openPath?.(path)
}

onMounted(() => void loadSkills())
</script>

<template>
  <div class="skills-pane" data-settings-section="skills">
    <div class="skills-toolbar">
      <div>
        <h2>{{ t('settings.skills.title') }}</h2>
        <p>{{ t('settings.skills.intro') }}</p>
      </div>
      <div class="skills-toolbar-actions">
        <div class="skills-view-switch" role="group" :aria-label="t('settings.skills.view-matrix')">
          <button
            type="button"
            :class="{ on: view === 'list' }"
            :aria-pressed="view === 'list'"
            @click="view = 'list'"
          >{{ t('settings.skills.view-list') }}</button>
          <button
            type="button"
            :class="{ on: view === 'matrix' }"
            :aria-pressed="view === 'matrix'"
            @click="view = 'matrix'"
          >{{ t('settings.skills.view-matrix') }}</button>
        </div>
        <button type="button" :disabled="loading || busy" @click="loadSkills()">
          {{ t('action.refresh') }}
        </button>
        <button type="button" class="primary" :disabled="busy" @click="creating = true">
          {{ t('settings.skills.new') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="skills-error" role="alert">{{ error }}</p>
    <div v-if="conflict" class="skills-conflict">
      <div>
        <strong>{{ t('settings.skills.conflict-title') }}</strong>
        <span>{{ t('settings.skills.conflict-body') }}</span>
      </div>
      <button type="button" @click="selectSkill(selectedName)">{{ t('settings.skills.reload') }}</button>
    </div>

    <form v-if="creating" class="skills-create" @submit.prevent="createSkill">
      <label>
        <span>{{ t('settings.skills.name') }}</span>
        <input v-model="newName" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" autocomplete="off" spellcheck="false" />
      </label>
      <label>
        <span>{{ t('settings.skills.description') }}</span>
        <input v-model="newDescription" autocomplete="off" />
      </label>
      <div class="skills-create-actions">
        <button type="button" @click="creating = false">{{ t('action.cancel') }}</button>
        <button type="submit" class="primary" :disabled="!newName.trim() || busy">
          {{ t('settings.skills.create') }}
        </button>
      </div>
    </form>

    <section v-if="view === 'matrix'" class="skills-matrix">
      <p class="skills-matrix-intro">{{ t('settings.skills.matrix-intro') }}</p>
      <input
        v-model="query"
        class="skills-search skills-matrix-search"
        type="search"
        :placeholder="t('settings.skills.search')"
      />
      <div v-if="matrixRows.length === 0" class="skills-state">
        {{ t('settings.skills.matrix-none') }}
      </div>
      <div v-else class="skills-matrix-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col" class="corner">{{ t('settings.skills.matrix-skill') }}</th>
              <th
                v-for="agent in agents"
                :key="agent.key"
                scope="col"
                :class="agent.state"
                :title="agent.label"
              >{{ agent.key }}</th>
              <th scope="col" class="bulk"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in matrixRows"
              :key="row.key"
              :class="{
                off: row.kind === 'shared' ? !row.skill.enabled : !row.skill.valid,
                native: row.kind === 'native',
                active: row.kind === 'shared' && selectedName === row.skill.name,
              }"
            >
              <th scope="row">
                <button
                  v-if="row.kind === 'shared'"
                  type="button"
                  class="matrix-name"
                  @click="selectSkill(row.skill.name); view = 'list'"
                >{{ row.skill.name }}</button>
                <button
                  v-else
                  type="button"
                  class="matrix-name"
                  :title="row.skill.path"
                  @click="openRowFolder(row)"
                >{{ row.skill.name }}</button>
                <span class="matrix-source" :class="row.kind">{{ rowSourceLabel(row) }}</span>
                <span v-if="row.kind === 'shared' && !row.skill.enabled" class="matrix-note">
                  {{ t('settings.skills.matrix-disabled-row') }}
                </span>
                <span v-else-if="row.kind === 'native' && !row.skill.valid" class="matrix-note">
                  {{ row.skill.error || t('settings.skills.invalid') }}
                </span>
              </th>
              <td
                v-for="agent in agents"
                :key="agent.key"
                :class="cellState(row, agent)"
              >
                <button
                  type="button"
                  :disabled="!cellEditable(row, agent) || busy"
                  :aria-pressed="delivers(row, agent)"
                  :aria-label="cellHint(row, agent)"
                  :title="cellHint(row, agent)"
                  @click="toggleCell(row, agent)"
                >{{ cellGlyph(row, agent) }}</button>
              </td>
              <td class="bulk">
                <button
                  type="button"
                  :disabled="editableAgents(row).length === 0 || busy"
                  @click="setRow(row, true)"
                >{{ t('settings.skills.matrix-row-all') }}</button>
                <button
                  type="button"
                  :disabled="editableAgents(row).length === 0 || busy"
                  @click="setRow(row, false)"
                >{{ t('settings.skills.matrix-row-none') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="skills-matrix-legend">
        <li><span class="swatch auto">●</span>{{ t('settings.skills.matrix-legend-auto') }}</li>
        <li><span class="swatch on">✓</span>{{ t('settings.skills.matrix-legend-on') }}</li>
        <li><span class="swatch off"></span>{{ t('settings.skills.matrix-legend-off') }}</li>
        <li><span class="swatch planned">·</span>{{ t('settings.skills.matrix-legend-planned') }}</li>
        <li><span class="swatch unsupported">—</span>{{ t('settings.skills.matrix-legend-unsupported') }}</li>
      </ul>
    </section>

    <div v-show="view === 'list'" class="skills-layout">
      <aside class="skills-library" :aria-label="t('settings.skills.library')">
        <input
          v-model="query"
          class="skills-search"
          type="search"
          :placeholder="t('settings.skills.search')"
        />
        <div v-if="loading" class="skills-state">{{ t('label.loading') }}</div>
        <div v-else-if="filteredSkills.length === 0 && filteredNative.length === 0" class="skills-state">
          <strong>{{ t('settings.skills.empty-title') }}</strong>
          <span>{{ t('settings.skills.empty-body') }}</span>
        </div>
        <template v-if="!loading">
          <div
            v-for="skill in filteredSkills"
            :key="skill.name"
            class="skill-list-item"
            :class="{ active: selectedName === skill.name }"
          >
            <button type="button" class="skill-select" @click="selectSkill(skill.name)">
              <span class="skill-status-rail" aria-hidden="true">
                <span :class="skill.enabled ? 'enabled' : 'disabled'"></span>
                <span :class="skill.valid === false ? 'invalid' : skill.valid === true ? 'valid' : 'unknown'"></span>
                <span :class="skill.nativeConflict === true ? 'conflicted' : skill.nativeConflict === false ? 'clear' : 'unknown'"></span>
              </span>
              <span class="skill-list-copy">
                <strong>{{ skill.name }}</strong>
                <span>{{ skill.description || t('settings.skills.no-description') }}</span>
              </span>
            </button>
            <ToggleSwitch
              :model-value="skill.enabled"
              :disabled="busy"
              :aria-label="t(skill.enabled ? 'settings.skills.disable' : 'settings.skills.enable', { name: skill.name })"
              @click.stop
              @update:model-value="setEnabled(skill, $event)"
            />
          </div>
        </template>
        <template v-if="filteredNative.length > 0">
          <div class="skills-group-title">{{ t('settings.skills.native-group') }}</div>
          <div
            v-for="skill in filteredNative"
            :key="skill.realPath"
            class="skill-list-item native"
          >
            <button
              type="button"
              class="skill-select"
              :title="skill.path"
              @click="openNativeFolder(skill)"
            >
              <span class="skill-status-rail" aria-hidden="true">
                <span class="enabled"></span>
                <span :class="skill.valid ? 'valid' : 'invalid'"></span>
                <span class="clear"></span>
              </span>
              <span class="skill-list-copy">
                <strong>{{ skill.name }}</strong>
                <span>{{ skill.description || skill.error || t('settings.skills.no-description') }}</span>
              </span>
            </button>
            <span class="skill-source-tag">{{ t('settings.skills.source-native', { agent: skill.source }) }}</span>
            <button
              type="button"
              class="skill-migrate"
              :disabled="busy || !skill.valid"
              :title="t('settings.skills.migrate-hint')"
              @click.stop="migrateNative(skill)"
            >{{ t('settings.skills.migrate') }}</button>
          </div>
        </template>
      </aside>

      <main class="skills-editor">
        <div v-if="!draft" class="skills-state editor-empty">
          <strong>{{ t('settings.skills.select-title') }}</strong>
          <span>{{ t('settings.skills.select-body') }}</span>
        </div>
        <template v-else>
          <header class="skill-editor-head">
            <div>
              <div class="skill-editor-title-row">
                <h3>{{ draft.name }}</h3>
                <span v-if="draft.valid === false" class="skill-badge danger">{{ t('settings.skills.invalid') }}</span>
                <span v-if="draft.nativeConflict" class="skill-badge warning">{{ t('settings.skills.native-conflict') }}</span>
                <span v-if="!draft.managed" class="skill-badge">{{ t('settings.skills.source-shared-user') }}</span>
              </div>
              <p>{{ draft.managed ? t('settings.skills.editor-hint') : t('settings.skills.editor-readonly-hint') }}</p>
            </div>
            <button type="button" :disabled="!draft.path && !rootPath" @click="openSkillFolder">
              {{ t('settings.skills.open-folder') }}
            </button>
          </header>

          <div class="skill-form">
            <label>
              <span>{{ t('settings.skills.name') }}</span>
              <input :value="draft.name" disabled />
            </label>
            <label>
              <span>{{ t('settings.skills.description') }}</span>
              <textarea v-model="draft.description" rows="2"></textarea>
            </label>
            <div class="skill-switches">
              <label>
                <span>
                  <strong>{{ t('settings.skills.user-invocable') }}</strong>
                  <small>{{ t('settings.skills.user-invocable-hint') }}</small>
                </span>
                <ToggleSwitch v-model="draft.userInvocable" :aria-label="t('settings.skills.user-invocable')" />
              </label>
              <label>
                <span>
                  <strong>{{ t('settings.skills.model-invocation') }}</strong>
                  <small>{{ t('settings.skills.model-invocation-hint') }}</small>
                </span>
                <ToggleSwitch
                  :model-value="!draft.disableModelInvocation"
                  :aria-label="t('settings.skills.model-invocation')"
                  @update:model-value="draft.disableModelInvocation = !$event"
                />
              </label>
            </div>
            <label>
              <span>{{ t('settings.skills.instructions') }}</span>
              <textarea v-model="draft.body" class="skill-body" rows="12" spellcheck="false"></textarea>
            </label>

            <details class="skill-advanced">
              <summary>{{ t('settings.skills.advanced') }}</summary>
              <div class="skill-advanced-grid">
                <label><span>{{ t('settings.skills.allowed-tools') }}</span><input v-model="draft.allowedTools" /></label>
                <label><span>{{ t('settings.skills.disallowed-tools') }}</span><input v-model="draft.disallowedTools" /></label>
                <label><span>{{ t('settings.skills.model') }}</span><input v-model="draft.model" /></label>
                <label><span>{{ t('settings.skills.effort') }}</span><input v-model="draft.effort" /></label>
                <label><span>{{ t('settings.skills.context') }}</span><input v-model="draft.context" /></label>
              </div>
            </details>

            <section class="skill-attachments">
              <div>
                <strong>{{ t('settings.skills.attachments') }}</strong>
                <span>{{ t('settings.skills.attachments-hint') }}</span>
              </div>
              <ul v-if="draft.attachments.length">
                <li v-for="attachment in draft.attachments" :key="attachment.path || attachment.name">
                  {{ attachment.name }}
                </li>
              </ul>
              <p v-else>{{ t('settings.skills.no-attachments') }}</p>
            </section>

            <footer class="skill-editor-actions">
              <button
                v-if="draft.migratedFrom"
                type="button"
                :disabled="busy"
                :title="draft.migratedFrom"
                @click="restoreNative(draft)"
              >{{ t('settings.skills.restore') }}</button>
              <button type="button" class="danger" :disabled="busy || !draft.managed" @click="deleteSkill">
                {{ t('settings.skills.delete') }}
              </button>
              <button type="button" class="primary" :disabled="busy || draft.valid === false || !draft.managed" @click="saveSkill">
                {{ t('settings.skills.save') }}
              </button>
            </footer>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.skills-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> and the scope band the settings modal renders above it. */
  padding: 16px 22px 18px;
  gap: 12px;
  overflow: hidden;
  color: var(--text-primary);
}
.skills-toolbar,
.skill-editor-head,
.skill-editor-actions,
.skills-toolbar-actions,
.skills-create-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.skills-toolbar h2,
.skill-editor-head h3 { margin: 0; color: var(--text-bright); }
.skills-toolbar h2 { font-size: 15px; }
.skill-editor-head h3 { font-size: 14px; }
.skills-toolbar p,
.skill-editor-head p { margin: 3px 0 0; color: var(--text-secondary); font-size: 11px; }
button,
input,
textarea {
  font: inherit;
}
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
button.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
button.danger { color: var(--danger-fg); }
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible { outline: 2px solid var(--accent-emphasis); outline-offset: 2px; }
.skills-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default));
  border-radius: var(--radius-control);
  color: var(--danger-fg);
  background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle));
  font-size: 11px;
}
.skills-conflict {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  border-left: 3px solid var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle));
  font-size: 11px;
}
.skills-conflict div { display: flex; flex-direction: column; gap: 2px; }
.skills-create {
  display: grid;
  grid-template-columns: minmax(130px, 0.65fr) minmax(220px, 1.35fr) auto;
  align-items: end;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.skills-create label,
.skill-form > label,
.skill-advanced-grid label { display: flex; flex-direction: column; gap: 4px; }
.skills-create label > span,
.skill-form > label > span,
.skill-advanced-grid label > span {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
input,
textarea {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 7px 8px;
}
textarea { resize: vertical; line-height: 1.5; }
input:focus,
textarea:focus { border-color: var(--accent-emphasis); }
input:disabled { color: var(--text-muted); background: var(--bg-muted); }
.skills-layout {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  min-height: 0;
  flex: 1;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  overflow: hidden;
  background: var(--bg-subtle);
}
.skills-library {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
  gap: 7px;
  border-right: 1px solid var(--border-default);
  overflow-y: auto;
}
.skills-search { flex: 0 0 auto; }
.skill-list-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-height: 52px;
  padding: 7px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}
.skill-list-item.active { background: var(--bg-muted); border-color: var(--border-default); }
.skill-select {
  display: grid;
  grid-template-columns: 5px minmax(0, 1fr);
  align-items: center;
  align-self: stretch;
  gap: 9px;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
}
.skill-select:hover:not(:disabled) { background: transparent; }
.skill-status-rail { align-self: stretch; display: grid; grid-template-rows: repeat(3, 1fr); gap: 2px; }
.skill-status-rail span { width: 4px; min-height: 6px; border-radius: 1px; background: var(--text-disabled); }
.skill-status-rail .enabled,
.skill-status-rail .valid,
.skill-status-rail .clear { background: var(--success-fg); }
.skill-status-rail .disabled { background: var(--text-disabled); }
.skill-status-rail .invalid,
.skill-status-rail .conflicted { background: var(--danger-fg); }
.skill-list-copy { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.skill-list-copy strong { overflow: hidden; text-overflow: ellipsis; color: var(--text-bright); font-size: 12px; }
.skill-list-copy > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 10px; }
.skill-list-item :deep(.toggle-switch) { width: 32px; height: 18px; }
.skill-list-item :deep(.toggle-switch-thumb) { width: 14px; height: 14px; }
.skill-list-item :deep(.toggle-switch.on .toggle-switch-thumb) { left: 16px; }
.skills-editor { min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 16px 18px; }
.skills-state { display: flex; flex-direction: column; gap: 4px; padding: 18px 8px; color: var(--text-secondary); font-size: 11px; text-align: center; }
.skills-state strong { color: var(--text-bright); }
.editor-empty { height: 100%; align-items: center; justify-content: center; }
.skill-editor-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.skill-badge { border-radius: var(--radius-pill); padding: 2px 7px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
.skill-badge.danger { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 12%, transparent); }
.skill-badge.warning { color: var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 12%, transparent); }
.skill-form { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
.skill-switches { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border-default); border-radius: var(--radius-card); overflow: hidden; }
.skill-switches label { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 10px; }
.skill-switches label + label { border-left: 1px solid var(--border-muted); }
.skill-switches label > span { display: flex; flex-direction: column; gap: 2px; }
.skill-switches strong { color: var(--text-bright); font-size: 11px; }
.skill-switches small { color: var(--text-secondary); font-size: 10px; }
.skill-body { min-height: 210px; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.skill-advanced { border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-muted); }
.skill-advanced summary { padding: 9px 10px; cursor: pointer; color: var(--text-bright); font-size: 11px; font-weight: 600; }
.skill-advanced-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 0 10px 10px; }
.skill-attachments { display: grid; grid-template-columns: minmax(170px, 0.7fr) minmax(0, 1.3fr); gap: 12px; padding: 10px; border: 1px solid var(--border-default); border-radius: var(--radius-card); }
.skill-attachments > div { display: flex; flex-direction: column; gap: 2px; }
.skill-attachments strong { color: var(--text-bright); font-size: 11px; }
.skill-attachments span,
.skill-attachments p,
.skill-attachments li { color: var(--text-secondary); font-size: 10px; }
.skill-attachments p,
.skill-attachments ul { margin: 0; }
.skill-attachments ul { padding-left: 18px; font-family: Menlo, Monaco, monospace; }
.skill-editor-actions { padding-top: 2px; }

@media (max-width: 800px) {
  .skills-pane { overflow-y: auto; }
  .skills-layout { grid-template-columns: 1fr; overflow: visible; }
  .skills-library { max-height: 240px; border-right: 0; border-bottom: 1px solid var(--border-default); }
  .skills-editor { overflow: visible; }
  .skills-create { grid-template-columns: 1fr; }
  .skill-switches,
  .skill-advanced-grid,
  .skill-attachments { grid-template-columns: 1fr; }
  .skill-switches label + label { border-left: 0; border-top: 1px solid var(--border-muted); }
}
/* ── Capability matrix ─────────────────────────────────────────────────── */
.skills-view-switch {
  display: inline-flex;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  overflow: hidden;
}
.skills-view-switch button {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 11px;
  font-size: 11px;
}
.skills-view-switch button.on { background: var(--bg-elevated); color: var(--text-bright); font-weight: 600; }
.skills-matrix {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 9px;
}
.skills-matrix-intro { margin: 0; color: var(--text-secondary); font-size: 11px; }
/* The matrix is the one place a horizontal scrollbar is correct: one column
   per vendor cannot be reflowed without losing the comparison it exists for. */
.skills-matrix-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
}
.skills-matrix table { border-collapse: separate; border-spacing: 0; font-size: 11px; width: 100%; }
.skills-matrix th,
.skills-matrix td { border-bottom: 1px solid var(--border-muted); padding: 0; white-space: nowrap; }
.skills-matrix thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-weight: 600;
  padding: 6px 7px;
  text-align: center;
}
.skills-matrix thead th.planned,
.skills-matrix thead th.unsupported { opacity: 0.55; }
.skills-matrix thead th.corner,
.skills-matrix tbody th {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-muted);
  text-align: left;
  padding: 4px 9px 4px 7px;
  min-width: 150px;
}
.skills-matrix thead th.corner { z-index: 3; }
.skills-matrix tbody th { background: var(--bg-base); }
.skills-matrix tr.active tbody th,
.skills-matrix tbody tr.active th { color: var(--text-bright); }
.skills-matrix .matrix-name {
  border: 0;
  background: transparent;
  padding: 2px 0;
  font-size: 11px;
  color: inherit;
  text-align: left;
}
.skills-matrix .matrix-name:hover { text-decoration: underline; background: transparent; }
.skills-matrix .matrix-note { display: block; color: var(--text-secondary); font-size: 10px; }
.skills-matrix tbody tr.off th,
.skills-matrix tbody tr.off td { opacity: 0.5; }
.skills-matrix td > button {
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 5px 7px;
  min-width: 34px;
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
}
.skills-matrix td.on > button { color: var(--accent-success, #6BC77F); font-weight: 700; }
.skills-matrix td.planned > button,
.skills-matrix td.unsupported > button { color: var(--text-secondary); opacity: 0.6; }
.skills-matrix td.unsupported { background: var(--bg-muted); }
.skills-matrix td.bulk { padding: 3px 7px; display: flex; gap: 5px; }
.skills-matrix td.bulk button { padding: 2px 7px; font-size: 10px; }
.skills-matrix-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font-size: 10.5px;
}
.skills-matrix-legend li { display: flex; align-items: center; gap: 5px; }
.skills-matrix-legend .swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
}
.skills-matrix-legend .swatch.on { color: var(--accent-success, #6BC77F); font-weight: 700; }
.skills-matrix-legend .swatch.unsupported { background: var(--bg-muted); }
/* ── Two sources ─────────────────────────────────────────────────────── */
.skills-group-title {
  margin: 10px 4px 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.skill-list-item.native .skill-select { cursor: default; }
.skill-migrate { padding: 3px 8px; font-size: 11px; white-space: nowrap; }
.skill-list-item.native .skill-select:hover { background: transparent; }
.skill-source-tag,
.skills-matrix .matrix-source {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.skills-matrix .matrix-source { margin-left: 6px; }
.skills-matrix .matrix-source.native { border-style: dashed; }
.skills-matrix-search { max-width: 260px; }
.skills-matrix td.auto > button {
  color: var(--accent-success, #6BC77F);
  background: color-mix(in srgb, var(--accent-success, #6BC77F) 14%, transparent);
  cursor: default;
}
.skills-matrix td.auto > button:disabled { opacity: 1; }
.skills-matrix tbody tr.native th { border-left: 3px dashed var(--border-muted); }
.skills-matrix-legend .swatch.auto {
  color: var(--accent-success, #6BC77F);
  background: color-mix(in srgb, var(--accent-success, #6BC77F) 14%, transparent);
  border-color: transparent;
}
</style>
