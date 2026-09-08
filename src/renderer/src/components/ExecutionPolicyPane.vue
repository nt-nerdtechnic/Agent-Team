<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  EXECUTION_POLICY_MODES,
  isHighRiskExecutionPolicy,
  V2_SYSTEM_NAMESPACES,
  type ExecutionPolicy,
  type ExecutionPolicyMode,
  type PluginSystemNamespace,
} from '@navide/plugin-contracts'
import type {
  ExecutionPolicyApi,
  ExecutionPolicyError,
  ExecutionPolicyOperationResult,
  ExecutionPolicySettingsSnapshot,
  ExecutionPolicySource,
} from '../../../shared/executionPolicy'

const props = defineProps<{
  workspacePath?: string
}>()

const { t, te } = useI18n()
const snapshot = ref<ExecutionPolicySettingsSnapshot | null>(null)
const draft = ref<ExecutionPolicy | null>(null)
const draftBasePolicy = ref<ExecutionPolicy | null>(null)
const draftBaseRevision = ref<number | null>(null)
const selectedSource = ref<ExecutionPolicySource | null>(null)
const shellInput = ref('')
const shellInputError = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const fullConfirmed = ref(false)
const repositoryFullConfirmed = ref(false)
const rebuildArmed = ref(false)
const rebuildConfirmed = ref(false)
const sourceResetArmed = ref(false)
const sourceResetConfirmed = ref(false)
const externalUpdate = ref(false)
let loadSequence = 0
let stopChanged: (() => void) | undefined

const systemNamespaces = [...V2_SYSTEM_NAMESPACES]
const policyModes = [...EXECUTION_POLICY_MODES]

function policyApi(): ExecutionPolicyApi | undefined {
  return window.agentTeam?.executionPolicy
}

function currentWorkspacePath(): string | undefined {
  const workspacePath = props.workspacePath?.trim()
  return workspacePath && workspacePath.length > 0 ? workspacePath : undefined
}

function clonePolicy(policy: ExecutionPolicy): ExecutionPolicy {
  return {
    schemaVersion: policy.schemaVersion,
    mode: policy.mode,
    system: [...policy.system],
    shell: [...policy.shell],
  }
}

function sourceSelectionFor(next: ExecutionPolicySettingsSnapshot): ExecutionPolicySource | null {
  return next.workspace?.selectedSource ?? null
}

function policiesEqual(left: ExecutionPolicy, right: ExecutionPolicy): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.mode === right.mode &&
    left.system.length === right.system.length &&
    left.system.every((item, index) => item === right.system[index]) &&
    left.shell.length === right.shell.length &&
    left.shell.every((item, index) => item === right.shell[index])
}

const draftDirty = computed(() =>
  draft.value !== null && draftBasePolicy.value !== null &&
  !policiesEqual(draft.value, draftBasePolicy.value)
)

function replaceDraftFromSnapshot(next: ExecutionPolicySettingsSnapshot): void {
  snapshot.value = next
  selectedSource.value = sourceSelectionFor(next)
  const source = next.userPolicy ?? next.defaultPolicy
  draft.value = clonePolicy(source)
  draftBasePolicy.value = clonePolicy(source)
  draftBaseRevision.value = next.global.revision
  fullConfirmed.value = false
  shellInputError.value = ''
  externalUpdate.value = false
}

function applySnapshotPreservingDraft(next: ExecutionPolicySettingsSnapshot): void {
  const wasDirty = draftDirty.value
  snapshot.value = next
  selectedSource.value = sourceSelectionFor(next)
  if (!wasDirty) {
    replaceDraftFromSnapshot(next)
    return
  }
  if (draftBaseRevision.value !== next.global.revision) externalUpdate.value = true
}

async function load(options: { replaceDraft?: boolean } = {}): Promise<void> {
  const api = policyApi()
  if (!api) {
    error.value = t('settings.executionPolicy.unavailable')
    return
  }
  const sequence = ++loadSequence
  const replaceDraft = options.replaceDraft ?? !draftDirty.value
  loading.value = true
  if (!externalUpdate.value) error.value = ''
  try {
    const next = await api.inspect(props.workspacePath)
    if (sequence !== loadSequence) return
    if (replaceDraft) replaceDraftFromSnapshot(next)
    else applySnapshotPreservingDraft(next)
  } catch {
    if (sequence === loadSequence) error.value = t('settings.executionPolicy.unavailable')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

const workspaceSnapshot = computed(() => snapshot.value?.workspace ?? null)
const recommendation = computed(() => workspaceSnapshot.value?.recommendation ?? null)
const recommendationIsHighRisk = computed(() => {
  const policy = recommendation.value?.policy
  return !!policy && isHighRiskExecutionPolicy(policy)
})
const repositoryNeedsConfirmation = computed(() => recommendationIsHighRisk.value && !repositoryFullConfirmed.value)
watch([() => props.workspacePath, () => recommendation.value?.fingerprint], () => {
  repositoryFullConfirmed.value = false
}, { flush: 'sync' })
const effectiveSource = computed<ExecutionPolicySource | null>(() => {
  if (workspaceSnapshot.value) return workspaceSnapshot.value.activeSource
  return snapshot.value?.global.state === 'user'
    ? 'user'
    : snapshot.value?.global.state === 'default'
      ? 'default'
      : null
})
const policyMutationAvailable = computed(() => {
  const state = snapshot.value?.recovery.state
  return state === 'missing' || state === 'healthy'
})
const draftIsHighRisk = computed(() => !!draft.value && isHighRiskExecutionPolicy(draft.value))
const canSave = computed(() => {
  if (!draft.value || busy.value || !policyMutationAvailable.value) return false
  return !draftIsHighRisk.value || fullConfirmed.value
})
const hasUserPolicy = computed(() => snapshot.value?.userPolicy !== null && snapshot.value?.userPolicy !== undefined)

function modeLabel(mode: ExecutionPolicyMode): string {
  return t(`settings.executionPolicy.mode.${mode}`)
}

function sourceLabel(source: ExecutionPolicySource): string {
  return t(`settings.executionPolicy.source.${source}`)
}

function recommendationStateLabel(state: NonNullable<typeof recommendation.value>['state']): string {
  return t(`settings.executionPolicy.recommendationState.${state}`)
}

function recoveryStateLabel(state: NonNullable<ExecutionPolicySettingsSnapshot['recovery']>['state']): string {
  return t(`settings.executionPolicy.recoveryState.${state}`)
}

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : t('settings.executionPolicy.none')
}

function setMode(mode: ExecutionPolicyMode): void {
  if (!draft.value) return
  draft.value.mode = mode
  fullConfirmed.value = false
  if (mode === 'full') {
    draft.value.system = []
    draft.value.shell = []
  }
}

function toggleSystem(namespace: PluginSystemNamespace): void {
  if (!draft.value || draft.value.mode === 'full') return
  const next = new Set(draft.value.system)
  if (next.has(namespace)) next.delete(namespace)
  else next.add(namespace)
  draft.value.system = systemNamespaces.filter((item) => next.has(item))
}

function addShell(): void {
  if (!draft.value || draft.value.mode === 'full') return
  shellInputError.value = ''
  const name = shellInput.value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._+-]*$/u.test(name)) {
    shellInputError.value = t('settings.executionPolicy.shellInvalid')
    return
  }
  if (draft.value.shell.includes(name)) {
    shellInputError.value = t('settings.executionPolicy.shellDuplicate', { name })
    return
  }
  draft.value.shell = [...draft.value.shell, name]
  shellInput.value = ''
}

function removeShell(name: string): void {
  if (!draft.value) return
  draft.value.shell = draft.value.shell.filter((item) => item !== name)
}

type OperationKind = 'save' | 'resetUser' | 'source' | 'rebuild' | 'resetSources'

function operationErrorMessage(operationError: ExecutionPolicyError): string {
  const key = `settings.executionPolicy.errors.${operationError.code}`
  return te(key) ? t(key) : operationError.message
}

function applyOperationResult(
  result: ExecutionPolicyOperationResult,
  operation: OperationKind,
): boolean {
  if (!result.ok) {
    error.value = operationErrorMessage(result.error)
    applySnapshotPreservingDraft(result.snapshot)
    if (result.error.code === 'policy-conflict') externalUpdate.value = true
    return false
  }
  if (operation === 'save' || operation === 'resetUser' || operation === 'rebuild') {
    replaceDraftFromSnapshot(result.snapshot)
  } else {
    applySnapshotPreservingDraft(result.snapshot)
  }
  notice.value = t(`settings.executionPolicy.notice.${operation}`)
  return true
}

async function save(): Promise<void> {
  const api = policyApi()
  if (!api || !draft.value || !canSave.value) return
  const expectedRevision = draftBaseRevision.value
  if (expectedRevision === null) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.setUser({
      policy: clonePolicy(draft.value),
      expectedRevision,
      ...(draftIsHighRisk.value ? { highRiskConfirmed: fullConfirmed.value } : {}),
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    applyOperationResult(result, 'save')
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function resetUser(): Promise<void> {
  const api = policyApi()
  if (!api) return
  const expectedRevision = snapshot.value?.global.revision
  if (expectedRevision === undefined) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.resetUser(
      {
        expectedRevision,
        ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
      },
    )
    applyOperationResult(result, 'resetUser')
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function selectSource(source: ExecutionPolicySource): Promise<void> {
  const api = policyApi()
  const workspacePath = props.workspacePath?.trim()
  if (!api || !workspacePath) return
  const request = source === 'repository'
    ? recommendation.value?.state === 'valid' && recommendation.value.fingerprint
      ? { source, expectedFingerprint: recommendation.value.fingerprint } as const
      : null
    : { source } as const
  if (!request) return
  if (source === 'repository' && repositoryNeedsConfirmation.value) {
    if (snapshot.value) selectedSource.value = sourceSelectionFor(snapshot.value)
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.selectSource({
      workspacePath,
      request,
      ...(source === 'repository' && recommendationIsHighRisk.value
        ? { highRiskConfirmed: repositoryFullConfirmed.value }
        : {}),
    })
    applyOperationResult(result, 'source')
  } catch {
    if (snapshot.value) selectedSource.value = sourceSelectionFor(snapshot.value)
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

async function rebuild(): Promise<void> {
  const api = policyApi()
  if (!api || !rebuildConfirmed.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.rebuild({
      confirmed: true,
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    if (applyOperationResult(result, 'rebuild')) {
      rebuildArmed.value = false
      rebuildConfirmed.value = false
    }
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

function armRebuild(): void {
  rebuildArmed.value = true
  rebuildConfirmed.value = false
}

function cancelRebuild(): void {
  rebuildArmed.value = false
  rebuildConfirmed.value = false
}

async function resetSourceSelections(): Promise<void> {
  const api = policyApi()
  if (!api || !sourceResetConfirmed.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await api.resetSourceSelections({
      confirmed: true,
      ...(currentWorkspacePath() ? { workspacePath: currentWorkspacePath() } : {}),
    })
    if (applyOperationResult(result, 'resetSources')) {
      sourceResetArmed.value = false
      sourceResetConfirmed.value = false
    }
  } catch {
    error.value = t('settings.executionPolicy.unavailable')
  } finally {
    busy.value = false
  }
}

function armSourceReset(): void {
  sourceResetArmed.value = true
  sourceResetConfirmed.value = false
}

function cancelSourceReset(): void {
  sourceResetArmed.value = false
  sourceResetConfirmed.value = false
}

async function reloadLatest(): Promise<void> {
  await load({ replaceDraft: true })
}

onMounted(() => {
  stopChanged = policyApi()?.onChanged(() => { void load({ replaceDraft: false }) })
  void load({ replaceDraft: true })
})

onUnmounted(() => stopChanged?.())
watch(() => props.workspacePath, () => { void load({ replaceDraft: !draftDirty.value }) })
</script>

<template>
  <div class="execution-policy-pane">
    <p v-if="loading" class="ep-loading">{{ $t('settings.executionPolicy.loading') }}</p>
    <p v-if="error" class="ep-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="ep-notice" role="status">{{ notice }}</p>
    <div v-if="externalUpdate" class="ep-conflict" role="alert">
      <span>{{ $t('settings.executionPolicy.externalUpdate') }}</span>
      <button type="button" :disabled="busy" @click="reloadLatest">
        {{ $t('settings.executionPolicy.reloadLatest') }}
      </button>
    </div>

    <section class="ep-section ep-effective" data-section="effective-policy">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.effectiveTitle') }}</h2>
        <span v-if="workspaceSnapshot" class="ep-status" :class="`ep-status-${workspaceSnapshot.status}`">
          {{ $t(`settings.executionPolicy.status.${workspaceSnapshot.status}`) }}
        </span>
      </div>
      <p v-if="!workspaceSnapshot" class="ep-hint">{{ $t('settings.executionPolicy.noWorkspace') }}</p>
      <template v-else>
        <p class="ep-summary">
          {{ $t('settings.executionPolicy.effectiveSource') }}:
          <strong>{{ effectiveSource ? sourceLabel(effectiveSource) : $t('settings.executionPolicy.status.unavailable') }}</strong>
          · {{ $t('settings.executionPolicy.modeLabel') }}: <strong>{{ modeLabel(workspaceSnapshot.policy.mode) }}</strong>
        </p>
        <p v-if="workspaceSnapshot.status !== 'active'" class="ep-warning" role="alert">
          {{ $t(`settings.executionPolicy.statusDetail.${workspaceSnapshot.status}`) }}
        </p>
      </template>
    </section>

    <section class="ep-section" data-section="host-default">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.hostDefaultTitle') }}</h2>
        <span class="ep-readonly">{{ $t('settings.executionPolicy.readOnly') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.hostDefaultHint') }}</p>
      <div v-if="snapshot" class="ep-policy-card">
        <div><strong>{{ $t('settings.executionPolicy.modeLabel') }}</strong>: {{ modeLabel(snapshot.defaultPolicy.mode) }}</div>
        <div><strong>{{ $t('settings.executionPolicy.systemLabel') }}</strong>: {{ listOrNone(snapshot.defaultPolicy.system) }}</div>
        <div><strong>{{ $t('settings.executionPolicy.shellLabel') }}</strong>: {{ listOrNone(snapshot.defaultPolicy.shell) }}</div>
      </div>
    </section>

    <section v-if="snapshot && draft" class="ep-section" data-section="user-policy">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.userTitle') }}</h2>
        <span class="ep-readonly" v-if="!hasUserPolicy">{{ $t('settings.executionPolicy.notCreated') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.userHint') }}</p>
      <div class="ep-mode-list" role="radiogroup" :aria-label="$t('settings.executionPolicy.modeLabel')">
        <label v-for="mode in policyModes" :key="mode" class="ep-mode-option" :data-mode="mode">
          <input
            type="radio"
            name="execution-policy-mode"
            :value="mode"
            :checked="draft.mode === mode"
            @change="setMode(mode)"
          />
          <span>{{ modeLabel(mode) }}</span>
        </label>
      </div>

      <div v-if="draftIsHighRisk" class="ep-full-warning" role="alert">
        {{ $t('settings.executionPolicy.fullWarning') }}
        <label class="ep-confirm-label">
          <input v-model="fullConfirmed" type="checkbox" class="ep-full-confirmation" />
          {{ $t('settings.executionPolicy.fullConfirmation') }}
        </label>
      </div>

      <template v-if="draft.mode !== 'full'">
        <div class="ep-editor-block">
          <h3>{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'systemDenylistLabel' : 'systemAllowlistLabel'}`) }}</h3>
          <p class="ep-hint">{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'systemDenylistHint' : 'systemAllowlistHint'}`) }}</p>
          <div class="ep-checkbox-grid">
            <label v-for="namespace in systemNamespaces" :key="namespace">
              <input
                type="checkbox"
                :checked="draft.system.includes(namespace)"
                :data-system="namespace"
                @change="toggleSystem(namespace)"
              />
              <code>{{ namespace }}</code>
            </label>
          </div>
        </div>
        <div class="ep-editor-block">
          <h3>{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'shellDenylistLabel' : 'shellAllowlistLabel'}`) }}</h3>
          <p class="ep-hint">{{ $t(`settings.executionPolicy.${draft.mode === 'denylist' ? 'shellDenylistHint' : 'shellAllowlistHint'}`) }}</p>
          <form class="ep-shell-add" @submit.prevent="addShell">
            <input
              v-model="shellInput"
              :placeholder="$t('settings.executionPolicy.shellPlaceholder')"
              :aria-invalid="Boolean(shellInputError)"
              pattern="[A-Za-z0-9][A-Za-z0-9._+-]*"
            />
            <button type="submit" :disabled="!shellInput.trim()">{{ $t('settings.executionPolicy.add') }}</button>
          </form>
          <p v-if="shellInputError" class="ep-error" role="alert">{{ shellInputError }}</p>
          <div v-if="draft.shell.length" class="ep-chip-list">
            <span v-for="name in draft.shell" :key="name" class="ep-chip">
              <code>{{ name }}</code>
              <button type="button" :aria-label="$t('settings.executionPolicy.removeShell', { name })" @click="removeShell(name)">×</button>
            </span>
          </div>
          <p v-else class="ep-empty">{{ $t('settings.executionPolicy.none') }}</p>
        </div>
      </template>

      <div class="ep-actions">
        <button class="ep-save" :disabled="!canSave" @click="save">{{ $t('settings.executionPolicy.save') }}</button>
        <button class="ep-reset" :disabled="busy || !hasUserPolicy || !policyMutationAvailable" @click="resetUser">{{ $t('settings.executionPolicy.resetUser') }}</button>
      </div>
    </section>

    <section v-if="snapshot" class="ep-section" data-section="policy-source">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.sourceTitle') }}</h2>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.sourceHint') }}</p>
      <div class="ep-source-list">
        <label v-for="source in (['default', 'user', 'repository'] as ExecutionPolicySource[])" :key="source" class="ep-source-option">
          <input
            type="radio"
            name="execution-policy-source"
            :value="source"
            v-model="selectedSource"
            :disabled="busy || !workspaceSnapshot || (source === 'user' && !hasUserPolicy) || (source === 'repository' && (recommendation?.state !== 'valid' || repositoryNeedsConfirmation))"
            @change="selectSource(source)"
          />
          <span>
            <strong>{{ sourceLabel(source) }}</strong>
            <small v-if="source === 'repository' && recommendation">{{ recommendationStateLabel(recommendation.state) }}</small>
          </span>
        </label>
      </div>
      <p v-if="!workspaceSnapshot" class="ep-hint">{{ $t('settings.executionPolicy.sourceNeedsWorkspace') }}</p>
      <p v-if="snapshot.sourceRecovery.state === 'corrupt'" class="ep-warning" role="alert">
        {{ $t('settings.executionPolicy.sourceCorruptHint') }}
      </p>
      <p v-else-if="snapshot.sourceRecovery.state === 'unsafe-entry' || snapshot.sourceRecovery.state === 'unavailable'" class="ep-warning ep-manual-recovery" role="alert">
        {{ $t('settings.executionPolicy.sourceManualRecoveryHint') }}
      </p>
      <ul v-if="snapshot.sourceRecovery.unsafePaths.length" class="ep-path-list">
        <li v-for="path in snapshot.sourceRecovery.unsafePaths" :key="path"><code>{{ path }}</code></li>
      </ul>
      <button
        v-if="snapshot.sourceRecovery.canReset && !sourceResetArmed"
        class="ep-reset-sources"
        :disabled="busy"
        type="button"
        @click="armSourceReset"
      >{{ $t('settings.executionPolicy.resetSourceSelections') }}</button>
      <form v-if="sourceResetArmed" class="ep-source-reset-confirm" role="dialog" aria-modal="true" @submit.prevent="resetSourceSelections">
        <p>{{ $t('settings.executionPolicy.resetSourceSelectionsBody') }}</p>
        <label>
          <input v-model="sourceResetConfirmed" type="checkbox" />
          {{ $t('settings.executionPolicy.resetSourceSelectionsCheck') }}
        </label>
        <div class="ep-actions">
          <button type="submit" :disabled="!sourceResetConfirmed || busy">{{ $t('settings.executionPolicy.resetSourceSelectionsConfirm') }}</button>
          <button type="button" @click="cancelSourceReset">{{ $t('settings.executionPolicy.cancel') }}</button>
        </div>
      </form>
    </section>

    <section v-if="recommendation" class="ep-section" data-section="repository-recommendation">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.recommendationTitle') }}</h2>
        <span class="ep-untrusted">{{ $t('settings.executionPolicy.untrusted') }}</span>
      </div>
      <p class="ep-hint">{{ $t('settings.executionPolicy.recommendationHint') }}</p>
      <p class="ep-recommendation-state">{{ recommendationStateLabel(recommendation.state) }}</p>
      <div v-if="recommendation.policy" class="ep-policy-card ep-recommendation-policy">
        <div><strong>{{ $t('settings.executionPolicy.modeLabel') }}</strong>: {{ modeLabel(recommendation.policy.mode) }}</div>
        <div><strong>{{ $t('settings.executionPolicy.systemLabel') }}</strong>: {{ listOrNone(recommendation.policy.system) }}</div>
        <div><strong>{{ $t('settings.executionPolicy.shellLabel') }}</strong>: {{ listOrNone(recommendation.policy.shell) }}</div>
      </div>
      <div v-if="recommendation.state === 'valid' && recommendationIsHighRisk" class="ep-warning">
        <p>{{ $t('settings.executionPolicy.fullWarning') }}</p>
        <label>
          <input v-model="repositoryFullConfirmed" type="checkbox" class="ep-repository-full-confirmation" />
          {{ $t('settings.executionPolicy.fullConfirmation') }}
        </label>
      </div>
      <button
        v-if="recommendation.state === 'valid' && recommendation.fingerprint && workspaceSnapshot?.selectedSource !== 'repository'"
        class="ep-accept-recommendation"
        :disabled="busy || repositoryNeedsConfirmation"
        @click="selectSource('repository')"
      >{{ $t('settings.executionPolicy.acceptRecommendation') }}</button>
    </section>

    <section v-if="snapshot" class="ep-section" data-section="recovery">
      <div class="ep-section-heading">
        <h2>{{ $t('settings.executionPolicy.recoveryTitle') }}</h2>
        <span class="ep-status" :class="`ep-status-${snapshot.recovery.state}`">{{ recoveryStateLabel(snapshot.recovery.state) }}</span>
      </div>
      <p v-if="snapshot.recovery.state === 'corrupt'" class="ep-warning" role="alert">
        {{ $t('settings.executionPolicy.corruptHint') }}
      </p>
      <p v-else-if="snapshot.recovery.state === 'unsafe-entry' || snapshot.recovery.state === 'directory-unsafe' || snapshot.recovery.state === 'directory-unavailable'" class="ep-warning ep-manual-recovery" role="alert">
        {{ $t('settings.executionPolicy.manualRecoveryHint') }}
      </p>
      <ul v-if="snapshot.recovery.unsafePaths.length" class="ep-path-list">
        <li v-for="path in snapshot.recovery.unsafePaths" :key="path"><code>{{ path }}</code></li>
      </ul>
      <button v-if="snapshot.recovery.canRebuild && !rebuildArmed" class="ep-rebuild" :disabled="busy" @click="armRebuild">
        {{ $t('settings.executionPolicy.rebuild') }}
      </button>
      <button
        v-if="snapshot.recovery.state === 'unsafe-entry' || snapshot.recovery.state === 'directory-unsafe' || snapshot.recovery.state === 'directory-unavailable' || snapshot.sourceRecovery.state === 'unsafe-entry' || snapshot.sourceRecovery.state === 'unavailable'"
        class="ep-recheck"
        :disabled="busy"
        type="button"
        @click="reloadLatest"
      >{{ $t('settings.executionPolicy.recheck') }}</button>
      <form v-if="rebuildArmed" class="ep-rebuild-confirm" @submit.prevent="rebuild">
        <p>{{ $t('settings.executionPolicy.rebuildConfirmBody') }}</p>
        <label><input v-model="rebuildConfirmed" type="checkbox" /> {{ $t('settings.executionPolicy.rebuildConfirmCheck') }}</label>
        <div class="ep-actions">
          <button type="submit" :disabled="!rebuildConfirmed || busy">{{ $t('settings.executionPolicy.rebuildConfirm') }}</button>
          <button type="button" @click="cancelRebuild">{{ $t('settings.executionPolicy.cancel') }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.execution-policy-pane {
  padding: 0 22px 24px;
  overflow-y: auto;
  font-size: var(--font-sm);
}
.ep-section {
  margin: 0 0 22px;
  padding: 16px 0 0;
  border-top: 1px solid var(--border-muted);
}
.ep-section:first-of-type { border-top: 0; padding-top: 0; }
.ep-section-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
.ep-section h2 { margin: 0; font-size: 15px; color: var(--text-bright); }
.ep-section h3 { margin: 0 0 4px; font-size: 13px; color: var(--text-bright); }
.ep-hint, .ep-summary, .ep-recommendation-state, .ep-empty { color: var(--text-secondary); margin: 5px 0 10px; line-height: 1.45; }
.ep-loading, .ep-notice, .ep-error { margin: 0 0 10px; }
.ep-error, .ep-warning { color: var(--text-danger, #c44); }
.ep-notice { color: var(--text-success, #1a7f37); }
.ep-readonly, .ep-untrusted, .ep-status { font-size: var(--font-2xs); color: var(--text-secondary); }
.ep-untrusted { color: #c77400; }
.ep-status { padding: 2px 6px; border-radius: 4px; background: var(--bg-subtle); }
.ep-status-active, .ep-status-healthy { color: var(--text-success, #1a7f37); }
.ep-status-corrupt, .ep-status-stale, .ep-status-unavailable, .ep-status-unsafe-entry, .ep-status-directory-unsafe, .ep-status-directory-unavailable { color: #c77400; }
.ep-policy-card, .ep-rebuild-confirm { padding: 10px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle); line-height: 1.7; }
.ep-conflict { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 12px; padding: 9px 12px; border: 1px solid #c77400; border-radius: var(--radius-card); background: rgba(199, 116, 0, .1); color: var(--text-bright); }
.ep-conflict button { flex: 0 0 auto; }
.ep-recommendation-policy { margin: 8px 0 10px; }
.ep-mode-list, .ep-source-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 14px; }
.ep-mode-option, .ep-source-option { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-control); }
.ep-source-option { min-width: 150px; }
.ep-source-option span { display: flex; flex-direction: column; gap: 2px; }
.ep-source-option small { color: var(--text-secondary); }
.ep-full-warning { padding: 10px 12px; border-left: 3px solid #c77400; background: rgba(199, 116, 0, .1); line-height: 1.5; }
.ep-confirm-label { display: block; margin-top: 9px; font-weight: 600; }
.ep-editor-block { margin: 14px 0; }
.ep-checkbox-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.ep-checkbox-grid label { display: flex; gap: 6px; align-items: center; }
.ep-shell-add { display: flex; gap: 8px; }
.ep-shell-add input { min-width: 180px; }
.ep-chip-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.ep-chip { display: inline-flex; gap: 5px; align-items: center; padding: 3px 7px; border-radius: 999px; background: var(--bg-subtle); border: 1px solid var(--border-default); }
.ep-chip button { border: 0; padding: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.ep-path-list { margin: 7px 0 10px; padding-left: 20px; color: var(--text-secondary); }
.ep-path-list code { overflow-wrap: anywhere; }
.ep-actions { display: flex; gap: 8px; margin-top: 14px; }
.ep-actions button, .ep-accept-recommendation, .ep-rebuild, .ep-reset-sources, .ep-recheck { transition: filter var(--motion-fast) var(--ease-out); }
.ep-actions button:hover:not(:disabled), .ep-accept-recommendation:hover:not(:disabled), .ep-rebuild:hover:not(:disabled), .ep-reset-sources:hover:not(:disabled), .ep-recheck:hover:not(:disabled) { filter: brightness(.93); }
.ep-rebuild-confirm { margin-top: 10px; }
.ep-rebuild-confirm p { margin-top: 0; }
.ep-source-reset-confirm { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle); line-height: 1.5; }
.ep-source-reset-confirm p { margin-top: 0; }
.ep-recheck { margin-left: 8px; }
</style>
