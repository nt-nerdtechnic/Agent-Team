<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { CliHealthCandidate, CliHealthEntry, CliHealthStatus, OnboardStatus } from '../composables/useOnboarding'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  initialHealth: CliHealthStatus
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'resolved'): void
  (e: 'use-binary', payload: { agentKey: string; path: string; version: string }): void
}>()
const { t } = useI18n()

type Step = 'detect' | 'repair' | 'verify'
const steps: Step[] = ['detect', 'repair', 'verify']
const stepIndex = ref(0)
const current = computed(() => steps[stepIndex.value])
const health = ref(props.initialHealth)
const checking = ref(false)
const message = ref('')

// update_failed is reported by the CLI itself and is fixed by re-running the
// vendor's update from CLI management — not by this repair guide.
const affectedKeys = computed(() => new Set(
  health.value.findings.filter((finding) => finding.type !== 'update_failed')
    .map((finding) => finding.agent_key)))
const affectedEntries = computed(() => health.value.entries.filter((entry) => affectedKeys.value.has(entry.agent_key)))

function findingType(entry: CliHealthEntry): 'probe_failed' | 'duplicate_install' {
  const finding = health.value.findings.find(
    (item) => item.agent_key === entry.agent_key && item.type !== 'update_failed')
  return finding?.type === 'probe_failed' ? 'probe_failed' : 'duplicate_install'
}

async function openDiagnostics(entry: CliHealthEntry): Promise<void> {
  const result = await window.agentTeam?.openTerminal(entry.diagnostic_command)
  message.value = result?.ok
    ? t('cli-health.terminal-opened')
    : t('cli-health.terminal-failed', { error: result?.error || 'unknown' })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

const NPM_PACKAGES: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
}

// Paths whose removal was already opened in Terminal this session; they no
// longer count as working backups until the next re-detect refreshes the data.
const removedPaths = ref<Set<string>>(new Set())

function sameNpmInstall(entry: CliHealthEntry, first: CliHealthCandidate, second: CliHealthCandidate): boolean {
  const packageName = NPM_PACKAGES[entry.agent_key]
  if (!packageName) return false
  const marker = `/node_modules/${packageName}/`
  if (!first.resolved_path.includes(marker) || !second.resolved_path.includes(marker)) return false
  return first.resolved_path.split(marker)[0] === second.resolved_path.split(marker)[0]
}

function remainingOk(entry: CliHealthEntry, candidate: CliHealthCandidate): CliHealthCandidate | undefined {
  return entry.candidates.find((item) =>
    item !== candidate
    && item.status === 'ok'
    && !removedPaths.value.has(item.resolved_path)
    && !sameNpmInstall(entry, candidate, item))
}

function removalAllowed(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  // Removal must never target the last working install: broken candidates are
  // always removable, working ones only with a surviving working backup.
  if (removedPaths.value.has(candidate.resolved_path)) return false
  if (candidate.status !== 'ok') return true
  return remainingOk(entry, candidate) !== undefined
}

function isNpmOwned(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  const packageName = NPM_PACKAGES[entry.agent_key]
  return Boolean(packageName && candidate.resolved_path.includes(`/node_modules/${packageName}/`))
}

function showBlockedNote(entry: CliHealthEntry, candidate: CliHealthCandidate): boolean {
  return candidate.status === 'ok'
    && !removedPaths.value.has(candidate.resolved_path)
    && isNpmOwned(entry, candidate)
    && !removalAllowed(entry, candidate)
}

function removalCommand(entry: CliHealthEntry, candidate: CliHealthCandidate): string {
  if (!removalAllowed(entry, candidate)) return ''
  // A removal-aware backend's verdict is final (empty string = unavailable);
  // reconstruct locally only when the payload predates removal support.
  if (candidate.removal_command !== undefined) return candidate.removal_command
  const packageName = NPM_PACKAGES[entry.agent_key]
  if (!packageName || !candidate.resolved_path.includes(`/node_modules/${packageName}/`)) return ''

  const npmPath = candidate.path.replace(/\/[^/]+$/, '/npm')
  const description = `Remove ${entry.label} ${candidate.version || ''} from ${candidate.path}`.replace(/  +/g, ' ')
  const uninstall = `${shellQuote(npmPath)} uninstall -g ${shellQuote(packageName)}`
  return `printf '%s\\n' ${shellQuote(description)}; printf 'Continue? [y/N] '; read -r answer; case "$answer" in [Yy]*) ${uninstall} ;; *) echo 'Cancelled.' ;; esac`
}

const pendingRemoval = ref<{ entry: CliHealthEntry; candidate: CliHealthCandidate } | null>(null)

function isPendingRemoval(candidate: CliHealthCandidate): boolean {
  return pendingRemoval.value?.candidate === candidate
}

function requestRemoval(entry: CliHealthEntry, candidate: CliHealthCandidate): void {
  message.value = ''
  pendingRemoval.value = { entry, candidate }
}

function cancelRemoval(): void {
  pendingRemoval.value = null
}

async function confirmRemoval(): Promise<void> {
  if (!pendingRemoval.value) return
  const { entry, candidate } = pendingRemoval.value
  pendingRemoval.value = null
  const result = await window.agentTeam?.openTerminal(removalCommand(entry, candidate))
  if (result?.ok) {
    removedPaths.value = new Set(removedPaths.value).add(candidate.resolved_path)
    message.value = t('cli-health.removal-opened', { label: entry.label })
  } else {
    message.value = t('cli-health.terminal-failed', { error: result?.error || 'unknown' })
  }
}

async function useBinary(entry: CliHealthEntry, candidate: CliHealthCandidate): Promise<void> {
  const selected = await props.backend.send<{ ok: boolean }>('onboarding.cli_health.select_binary', {
    agent_key: entry.agent_key,
    path: candidate.path,
    fingerprint: health.value.fingerprint,
  }).catch(() => null)
  // Compatibility with an older backend: keep the existing dismissal path
  // while the renderer/backend are temporarily on different versions.
  if (!selected?.ok || selected.payload?.ok === false) {
    await props.backend.send('onboarding.cli_health.dismiss', {
      fingerprint: health.value.fingerprint,
    }).catch(() => {})
  }
  emit('use-binary', {
    agentKey: entry.agent_key,
    path: candidate.path,
    version: candidate.version,
  })
}

async function recheck(): Promise<void> {
  checking.value = true
  message.value = ''
  try {
    const resp = await props.backend.send<OnboardStatus>('onboarding.status', {})
    if (!resp.payload?.cli_health) return
    // Fresh probe data supersedes any in-flight confirmation or session-local
    // removal tracking (object identities change with the new payload).
    pendingRemoval.value = null
    removedPaths.value = new Set()
    health.value = resp.payload.cli_health
    if (!health.value.findings.length) {
      emit('resolved')
      return
    }
    message.value = t('cli-health.still-detected')
  } finally {
    checking.value = false
  }
}

async function dismiss(): Promise<void> {
  await props.backend.send('onboarding.cli_health.dismiss', {
    fingerprint: health.value.fingerprint,
  }).catch(() => {})
  emit('close')
}
</script>

<template>
  <div class="ch-page">
    <section class="ch-dialog" role="dialog" aria-modal="true" :aria-label="$t('cli-health.title')">
      <header class="ch-top">
        <div>
          <div class="ch-kicker">{{ $t('cli-health.kicker') }}</div>
          <h1>{{ $t('cli-health.title') }}</h1>
        </div>
        <ol class="ch-steps">
          <li v-for="(step, index) in steps" :key="step" :class="{ active: current === step, done: index < stepIndex }">
            <span>{{ index < stepIndex ? '✓' : index + 1 }}</span>
            {{ $t(`cli-health.step.${step}`) }}
          </li>
        </ol>
      </header>

      <main class="ch-main">
        <template v-if="current === 'detect'">
          <h2>{{ $t('cli-health.detect-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.detect-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card">
            <div class="ch-card-head">
              <strong>{{ entry.label }}</strong>
              <span class="ch-warning">{{ $t(`cli-health.finding.${findingType(entry)}`) }}</span>
            </div>
            <div v-for="candidate in entry.candidates" :key="candidate.resolved_path" class="ch-candidate" :class="{ primary: candidate.is_primary }">
              <div class="ch-candidate-top">
                <span>{{ candidate.is_primary ? $t('cli-health.active') : $t('cli-health.alternate') }}</span>
                <code>{{ candidate.version || $t('cli-health.unknown-version') }}</code>
                <span v-if="candidate.signal" class="ch-signal">{{ candidate.signal }}</span>
              </div>
              <code class="ch-path">{{ candidate.path }}</code>
              <div class="ch-candidate-actions">
                <button
                  v-if="candidate.status === 'ok' && !candidate.is_primary"
                  class="ch-btn primary ch-use-binary"
                  @click="useBinary(entry, candidate)"
                >
                  {{ $t('cli-health.use-version', { version: candidate.version || $t('cli-health.unknown-version') }) }}
                </button>
                <button
                  v-if="removalCommand(entry, candidate) && !isPendingRemoval(candidate)"
                  class="ch-btn danger ch-remove-binary"
                  @click="requestRemoval(entry, candidate)"
                >
                  {{ $t('cli-health.remove-installation') }}
                </button>
              </div>
              <div v-if="isPendingRemoval(candidate)" class="ch-confirm">
                <strong>{{ $t('cli-health.confirm-remove-title') }}</strong>
                <p>{{ $t('cli-health.confirm-remove-desc', { path: candidate.path, version: candidate.version || $t('cli-health.unknown-version') }) }}</p>
                <p v-if="remainingOk(entry, candidate)">
                  {{ $t('cli-health.confirm-remove-keep', { path: remainingOk(entry, candidate)?.path }) }}
                </p>
                <div class="ch-confirm-actions">
                  <button class="ch-btn ghost ch-cancel-removal" @click="cancelRemoval">{{ $t('action.cancel') }}</button>
                  <button class="ch-btn danger ch-confirm-removal" @click="confirmRemoval">{{ $t('cli-health.confirm-continue') }}</button>
                </div>
              </div>
              <p v-if="showBlockedNote(entry, candidate)" class="ch-blocked">
                {{ $t('cli-health.removal-blocked') }}
              </p>
            </div>
            <div class="ch-actions-note">{{ $t('cli-health.use-version-note') }}</div>
          </section>
        </template>

        <template v-else-if="current === 'repair'">
          <h2>{{ $t('cli-health.repair-title') }}</h2>
          <p class="ch-lead">{{ $t('cli-health.repair-desc') }}</p>
          <section v-for="entry in affectedEntries" :key="entry.agent_key" class="ch-card repair">
            <strong>{{ entry.label }}</strong>
            <ol>
              <li>{{ $t('cli-health.keep-primary') }}</li>
              <li>{{ $t('cli-health.remove-alternate') }}</li>
              <li>{{ $t('cli-health.run-doctor') }}</li>
            </ol>
            <button class="ch-btn primary" @click="openDiagnostics(entry)">
              {{ $t('cli-health.open-terminal') }} · <code>{{ entry.diagnostic_command }}</code>
            </button>
            <div class="ch-version-actions">
              <button
                v-for="candidate in entry.candidates.filter((item) => item.status === 'ok' && !item.is_primary)"
                :key="candidate.resolved_path"
                class="ch-btn primary"
                @click="useBinary(entry, candidate)"
              >
                {{ $t('cli-health.use-version', { version: candidate.version || $t('cli-health.unknown-version') }) }}
              </button>
            </div>
          </section>
        </template>

        <template v-else>
          <div class="ch-verify">
            <div class="ch-check">✓</div>
            <h2>{{ $t('cli-health.verify-title') }}</h2>
            <p class="ch-lead">{{ $t('cli-health.verify-desc') }}</p>
            <button class="ch-btn primary" :disabled="checking" @click="recheck">
              {{ checking ? $t('label.detecting') : $t('action.re-detect') }}
            </button>
          </div>
        </template>

        <p v-if="message" class="ch-message">{{ message }}</p>
      </main>

      <footer class="ch-footer">
        <button class="ch-btn ghost" @click="dismiss">{{ $t('action.skip-for-now') }}</button>
        <span />
        <button v-if="stepIndex > 0" class="ch-btn ghost" @click="stepIndex--">{{ $t('action.back') }}</button>
        <button v-if="stepIndex < steps.length - 1" class="ch-btn primary" @click="stepIndex++">{{ $t('action.next') }}</button>
        <button v-else class="ch-btn ghost" @click="dismiss">{{ $t('cli-health.close') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ch-page {
  position: fixed;
  inset: 0;
  z-index: 9550;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(0, 0, 0, .58);
  backdrop-filter: blur(3px);
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.ch-dialog {
  width: min(880px, calc(100vw - 56px));
  max-height: min(760px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--bg-base);
  box-shadow: 0 22px 70px rgba(0, 0, 0, .48);
}
.ch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  padding: 24px 30px 20px;
  border-bottom: 1px solid var(--border-muted);
}
.ch-kicker { color: var(--accent-bright); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 5px 0 0; color: var(--text-bright); font-size: 25px; }
.ch-steps { display: flex; gap: 22px; margin: 0; padding: 0; list-style: none; color: var(--text-muted); font-size: 12px; }
.ch-steps li { display: flex; align-items: center; gap: 7px; }
.ch-steps li span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid var(--border-default); border-radius: 50%; }
.ch-steps li.active { color: var(--text-bright); }
.ch-steps li.active span { border-color: var(--accent-bright); color: var(--accent-bright); }
.ch-steps li.done span { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ch-main { width: 100%; padding: 30px; overflow: auto; box-sizing: border-box; }
h2 { margin: 0 0 8px; color: var(--text-bright); font-size: 22px; }
.ch-lead { margin: 0 0 26px; color: var(--text-secondary); line-height: 1.6; }
.ch-card { padding: 20px; margin-bottom: 14px; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-subtle); }
.ch-card-head, .ch-candidate-top { display: flex; align-items: center; gap: 10px; }
.ch-card-head { justify-content: space-between; margin-bottom: 14px; }
.ch-warning { color: var(--attention-fg); font-size: 12px; }
.ch-candidate { padding: 12px 14px; margin-top: 8px; border-left: 3px solid var(--border-default); background: var(--bg-base); border-radius: 6px; }
.ch-candidate.primary { border-left-color: var(--accent-bright); }
.ch-candidate-top { color: var(--text-secondary); font-size: 12px; }
.ch-candidate-top code { margin-left: auto; color: var(--text-bright); }
.ch-signal { color: var(--danger-fg); font-weight: 700; }
.ch-path { display: block; margin-top: 8px; color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
.ch-candidate-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.ch-confirm { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--danger-fg); border-radius: 8px; background: var(--bg-subtle); font-size: 13px; }
.ch-confirm p { margin: 6px 0 0; color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.ch-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.ch-blocked { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.ch-actions-note { margin-top: 14px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.ch-version-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.repair ol { color: var(--text-secondary); line-height: 1.8; }
.ch-verify { text-align: center; padding-top: 50px; }
.ch-check { display: grid; place-items: center; width: 54px; height: 54px; margin: 0 auto 18px; border-radius: 50%; background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 25px; }
.ch-message { color: var(--attention-fg); text-align: center; }
.ch-footer { display: flex; align-items: center; gap: 10px; margin-top: auto; padding: 16px 30px; border-top: 1px solid var(--border-muted); }
.ch-footer span { flex: 1; }
.ch-btn { border: 1px solid var(--border-default); border-radius: 7px; padding: 9px 14px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); }
.ch-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.danger { border-color: var(--danger-fg); color: var(--danger-fg); background: transparent; }
.ch-btn.ghost { background: transparent; }
/* Hover feedback: the variants restate their own resting colour so the base
 * rule cannot recolour them. Transition and focus ring come from semantic.css. */
.ch-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); color: var(--text-bright); }
.ch-btn.primary:hover:not(:disabled) { background: var(--accent-focus); border-color: var(--accent-focus); color: var(--text-on-emphasis); }
.ch-btn.danger:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--danger-fg); color: var(--danger-fg); }
.ch-btn.ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-bright); }
.ch-btn:disabled { opacity: .55; cursor: default; }
.ch-btn code { font-size: 11px; }
@media (max-width: 760px) {
  .ch-page { padding: 14px; }
  .ch-dialog { width: calc(100vw - 28px); max-height: calc(100vh - 28px); }
  .ch-top { align-items: flex-start; flex-direction: column; gap: 16px; padding: 20px; }
  .ch-steps { gap: 12px; }
  .ch-main { padding: 22px 20px; }
  .ch-footer { padding: 14px 20px; }
}
</style>
