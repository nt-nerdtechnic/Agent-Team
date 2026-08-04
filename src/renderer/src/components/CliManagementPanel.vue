<script setup lang="ts">
/**
 * CLI management — one row per registered agent CLI.
 *
 * Everything runnable here comes from the backend registry: Navide surfaces the
 * vendor's own update/doctor/install commands and runs them in a terminal the
 * user can see. It never wraps, parses or substitutes a vendor command, and it
 * never downloads or installs anything itself.
 */
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding } from '../composables/useOnboarding'
import type {
  AutoupdatePolicy, CliHealthEntry, CliUpdateRecord, MaintenanceAction, OnboardDep,
} from '../composables/useOnboarding'

const CliInstallDialog = defineAsyncComponent(() => import('./CliInstallDialog.vue'))

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()

const onboarding = useOnboarding(props.backend)
const { cliDeps, cliHealth, loading, maintaining } = onboarding
const message = ref('')
/** Dep id whose guided install dialog is open ('' = none). */
const installTarget = ref('')

onMounted(() => { void onboarding.refresh() })

function closeInstall(): void {
  installTarget.value = ''
  void onboarding.refresh()
}

function entryFor(dep: OnboardDep): CliHealthEntry | undefined {
  return cliHealth.value?.entries.find((entry) => entry.agent_key === dep.id)
}

function lastUpdate(dep: OnboardDep): CliUpdateRecord | undefined {
  return entryFor(dep)?.update_state[0]
}

/** Alternates only matter while a second physical install exists. */
function duplicates(dep: OnboardDep): CliHealthEntry['candidates'] {
  const candidates = entryFor(dep)?.candidates ?? []
  return candidates.length > 1 ? candidates : []
}

function busy(dep: OnboardDep, action: MaintenanceAction): boolean {
  return maintaining.value === `${dep.id}:${action}`
}

async function run(dep: OnboardDep, action: MaintenanceAction): Promise<void> {
  const result = await onboarding.runMaintenance(dep.id, action)
  if (!result) return
  message.value = result.ok
    ? t('cli-manage.terminal-opened', { command: result.command })
    : t('cli-manage.command-unavailable', { label: dep.label })
}

async function setPolicy(dep: OnboardDep, event: Event): Promise<void> {
  const policy = (event.target as HTMLSelectElement).value as AutoupdatePolicy
  await onboarding.setAutoupdatePolicy(dep.id, policy)
}

async function removeAlternate(command: string): Promise<void> {
  const result = await window.agentTeam?.openTerminal(command)
  message.value = result?.ok
    ? t('cli-manage.terminal-opened', { command })
    : t('cli-manage.terminal-failed', { error: result?.error || 'unknown' })
}

async function useBinary(dep: OnboardDep, path: string): Promise<void> {
  const fingerprint = cliHealth.value?.fingerprint || ''
  if (!fingerprint) return
  await props.backend.send('onboarding.cli_health.select_binary', {
    agent_key: dep.id, path, fingerprint,
  })
  await onboarding.refresh()
}

const hasFailedUpdate = computed(() => new Set(
  (cliHealth.value?.findings ?? [])
    .filter((finding) => finding.type === 'update_failed')
    .map((finding) => finding.agent_key),
))

/** The outcome string is the vendor's, not ours: translate the values we know
 *  and pass anything else through verbatim rather than showing a missing key. */
function outcomeLabel(outcome: string): string {
  return outcome === 'success' || outcome === 'failed'
    ? t(`cli-manage.outcome.${outcome}`)
    : outcome || t('cli-manage.outcome.unknown')
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
</script>

<template>
  <div class="cm">
    <div class="cm-head">
      <div>
        <h3 class="cm-title">{{ $t('cli-manage.title') }}</h3>
        <p class="cm-hint">{{ $t('cli-manage.hint') }}</p>
      </div>
      <button class="cm-btn" :disabled="loading" @click="onboarding.refresh()">
        {{ loading ? $t('cli-manage.detecting') : $t('cli-manage.redetect') }}
      </button>
    </div>

    <p v-if="message" class="cm-message">{{ message }}</p>

    <div v-for="dep in cliDeps" :key="dep.id" class="cm-row">
      <div class="cm-row-head">
        <span class="cm-name">{{ dep.label }}</span>
        <span :class="['cm-badge', dep.status]">{{ $t(`cli-manage.status.${dep.status}`) }}</span>
        <span v-if="dep.version" class="cm-version">{{ dep.version }}</span>
        <span v-if="dep.install_method" class="cm-method">
          {{ $t(`cli-manage.method.${dep.install_method}`) }}
        </span>
      </div>

      <div v-if="dep.resolved_path" class="cm-path" :title="dep.resolved_path">{{ dep.resolved_path }}</div>

      <div v-if="lastUpdate(dep)" :class="['cm-update', { failed: hasFailedUpdate.has(dep.id) }]">
        <span>{{ $t('cli-manage.last-update') }}</span>
        <strong>{{ outcomeLabel(lastUpdate(dep)!.outcome) }}</strong>
        <span>{{ formatTime(lastUpdate(dep)!.timestamp) }}</span>
        <code v-if="lastUpdate(dep)!.version_from">
          {{ lastUpdate(dep)!.version_from }}{{ lastUpdate(dep)!.version_to ? ` → ${lastUpdate(dep)!.version_to}` : '' }}
        </code>
        <span class="cm-scope">{{ lastUpdate(dep)!.scope }}</span>
      </div>

      <div v-if="duplicates(dep).length" class="cm-dupes">
        <div class="cm-dupes-title">{{ $t('cli-manage.duplicates', { count: duplicates(dep).length }) }}</div>
        <div v-for="candidate in duplicates(dep)" :key="candidate.resolved_path" class="cm-dupe">
          <code>{{ candidate.resolved_path }}</code>
          <span v-if="candidate.is_primary" class="cm-active">{{ $t('cli-manage.active') }}</span>
          <button v-else class="cm-btn small" @click="useBinary(dep, candidate.path)">
            {{ $t('cli-manage.use-this') }}
          </button>
          <button
            v-if="candidate.removal_command"
            class="cm-btn small danger"
            @click="removeAlternate(candidate.removal_command)"
          >
            {{ $t('cli-manage.remove') }}
          </button>
        </div>
      </div>

      <div class="cm-actions">
        <button
          v-if="dep.update_cmd"
          class="cm-btn"
          :disabled="!!maintaining"
          :title="dep.update_cmd"
          @click="run(dep, 'update')"
        >
          {{ busy(dep, 'update') ? $t('cli-manage.opening') : $t('cli-manage.update', { command: dep.update_cmd }) }}
        </button>
        <a v-else-if="dep.docs_url" class="cm-btn link" :href="dep.docs_url" target="_blank" rel="noreferrer">
          {{ $t('cli-manage.update-via-docs') }}
        </a>

        <button v-if="dep.doctor_cmd" class="cm-btn" :disabled="!!maintaining" :title="dep.doctor_cmd" @click="run(dep, 'doctor')">
          {{ $t('cli-manage.doctor', { command: dep.doctor_cmd }) }}
        </button>

        <button
          v-if="dep.status === 'missing' && dep.can_install"
          class="cm-btn"
          :disabled="!!maintaining"
          @click="installTarget = dep.id"
        >
          {{ $t('cli-manage.install') }}
        </button>

        <label v-if="dep.autoupdate_env" class="cm-policy">
          {{ $t('cli-manage.autoupdate') }}
          <select :value="dep.autoupdate_policy" @change="setPolicy(dep, $event)">
            <option value="vendor">{{ $t('cli-manage.policy.vendor') }}</option>
            <option value="manual">{{ $t('cli-manage.policy.manual') }}</option>
          </select>
        </label>
      </div>
    </div>

    <p class="cm-footnote">{{ $t('cli-manage.footnote') }}</p>

    <!-- Same guided flow the spawn dropdown and a 127 exit open, so an install
         started here reports prerequisites, failures and detection alike. -->
    <CliInstallDialog
      v-if="installTarget"
      :backend="backend"
      :dep-id="installTarget"
      origin="settings"
      @close="closeInstall"
    />
  </div>
</template>

<style scoped>
.cm { display: flex; flex-direction: column; gap: 12px; }
.cm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cm-title { font-size: 14px; font-weight: 700; margin: 0 0 4px; }
.cm-hint { font-size: 12px; color: var(--text-muted, #8b95a3); margin: 0; max-width: 52em; }
.cm-message { font-size: 12px; color: var(--text-muted, #8b95a3); margin: 0; word-break: break-all; }

.cm-row {
  border: 1px solid var(--border, #2c323e); border-radius: 10px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.cm-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cm-name { font-weight: 700; font-size: 13.5px; }
.cm-badge { font-size: 11px; border-radius: 99px; padding: 1px 8px; background: var(--surface-2, #232833); }
.cm-badge.ok { color: #2b8a3e; }
.cm-badge.missing { color: #8b95a3; }
.cm-badge.outdated { color: #c77400; }
.cm-version, .cm-method, .cm-scope { font-size: 11.5px; color: var(--text-muted, #8b95a3); }
.cm-method { border: 1px solid var(--border, #2c323e); border-radius: 99px; padding: 0 8px; }
.cm-path {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px;
  color: var(--text-muted, #8b95a3); overflow-x: auto; white-space: nowrap;
}

.cm-update { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.cm-update.failed { color: #c0392b; }
.cm-update code { font-size: 11.5px; }

.cm-dupes { display: flex; flex-direction: column; gap: 6px; }
.cm-dupes-title { font-size: 12px; color: #c77400; }
.cm-dupe { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.cm-dupe code { overflow-x: auto; }
.cm-active { color: var(--text-muted, #8b95a3); }

.cm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cm-btn {
  font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border, #2c323e); background: var(--surface-2, #232833);
  color: inherit; text-decoration: none;
}
.cm-btn:disabled { opacity: 0.5; cursor: default; }
.cm-btn.small { padding: 2px 8px; }
.cm-btn.danger { color: #c0392b; }
.cm-policy { display: flex; align-items: center; gap: 6px; font-size: 12px; margin-left: auto; }
.cm-footnote { font-size: 11.5px; color: var(--text-muted, #8b95a3); margin: 0; }
</style>
