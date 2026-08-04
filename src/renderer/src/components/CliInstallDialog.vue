<script setup lang="ts">
/**
 * Guided CLI install — the single wizard behind every "this CLI is missing"
 * moment: the backend's pre-spawn probe finding no executable (Open Agent,
 * Resume, Handle Issue, a pipeline stage), a pane exiting 127, picking a
 * not-installed CLI in the spawn dropdown, or the Install button in CLI
 * management.
 *
 * Shaped like the first-run onboarding wizard on purpose — check → install →
 * verify — because the situation is the same one: the environment is not ready
 * and the user needs to be walked through making it ready, not handed a
 * yes/no confirm that goes quiet afterwards. Prerequisites are shown during
 * the check step (not only after an install has already failed), and every
 * failure mode has its own message and its own next action.
 *
 * Everything runnable still comes from the backend registry — this component
 * never composes an install command of its own.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type InstallResult, type OnboardDep } from '../composables/useOnboarding'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  depId: string
  /** Where the prompt came from; only 'pane' offers to start the CLI again. */
  origin?: 'pane' | 'spawn' | 'settings'
  /** Label to show before the backend status arrives (avoids an empty title). */
  fallbackLabel?: string
}>()

const emit = defineEmits<{
  close: []
  installed: [depId: string]
  relaunch: [depId: string]
  /** So the opener can update its own copy without re-running a full probe. */
  'dismiss-changed': [payload: { depId: string; dismissed: boolean }]
}>()

const { t } = useI18n()
const onboarding = useOnboarding(props.backend)
const {
  deps, installing, installElapsedSec, loading, watching, watchOutcome, installPromptDismissed,
} = onboarding

const result = ref<InstallResult | null>(null)
const terminalError = ref('')
const dontAsk = ref(false)

onMounted(() => { void onboarding.refresh() })
onBeforeUnmount(() => { onboarding.dispose() })

// Reflect the stored opt-out once status arrives, so the box isn't shown
// unticked to someone who already switched this CLI's prompt off.
watch(installPromptDismissed, (dismissed) => { dontAsk.value = dismissed.has(props.depId) })

const dep = computed<OnboardDep | undefined>(() => deps.value.find((d) => d.id === props.depId))
const label = computed(() => dep.value?.label || props.fallbackLabel || props.depId)

/** Bootstrap binaries that are themselves installable deps here. */
const BOOTSTRAP_DEP: Record<string, string> = { brew: 'homebrew', npm: 'node' }

const blockers = computed(() => result.value?.missing_requirements ?? [])

function requirementDep(binary: string): OnboardDep | undefined {
  const id = BOOTSTRAP_DEP[binary]
  return id ? deps.value.find((d) => d.id === id) : undefined
}

/**
 * The one place that decides what the user is looking at. Derived rather than
 * assigned, so a background re-detect (the terminal watcher) can move the
 * dialog to 'done' without any explicit transition.
 */
const phase = computed<'intro' | 'installing' | 'waiting' | 'blocked' | 'failed' | 'done'>(() => {
  if (installing.value === props.depId) return 'installing'
  if (dep.value?.status === 'ok') return 'done'
  if (watching.value === props.depId) return 'waiting'
  if (blockers.value.length) return 'blocked'
  if (result.value && (!result.value.ok || result.value.terminal_opened === false)) return 'failed'
  return 'intro'
})

const failureText = computed(
  () => result.value?.error || result.value?.output || terminalError.value
)

// ── Steps (check → install → verify) ────────────────────────────────────────
const STEPS = ['check', 'install', 'verify'] as const
type Step = (typeof STEPS)[number]

/**
 * Prerequisites with their state. The probe reports them up front; a failed
 * install can also name one the probe did not know about, so the two are
 * merged rather than one replacing the other.
 */
const requirementRows = computed<{ name: string; ok: boolean }[]>(() => {
  const rows = (dep.value?.requirements ?? []).map((r) => ({ name: r.name, ok: r.ok }))
  for (const name of blockers.value) {
    const known = rows.find((r) => r.name === name)
    if (known) known.ok = false
    else rows.push({ name, ok: false })
  }
  return rows
})
const missingRequirements = computed(() => requirementRows.value.filter((r) => !r.ok).map((r) => r.name))

/** Step the user last navigated to; the derived one below can overrule it. */
const requestedStep = ref<Step>('check')

/**
 * Which step is on screen. Derived from what is actually happening, so the
 * wizard follows the install rather than needing to be clicked along: a
 * running install is always the install step, a detected CLI is always verify.
 */
const step = computed<Step>(() => {
  if (dep.value?.status === 'ok') return 'verify'
  if (phase.value === 'installing' || phase.value === 'waiting' || phase.value === 'failed') {
    return 'install'
  }
  return requestedStep.value
})
const stepIndex = computed(() => STEPS.indexOf(step.value))

async function runInstall(): Promise<void> {
  const target = dep.value
  if (!target || installing.value) return
  result.value = null
  terminalError.value = ''
  requestedStep.value = 'install'
  const r = await onboarding.install(target)
  result.value = r
  if (r?.needs_terminal && r.terminal_opened === false) {
    terminalError.value = t('cli-install.terminal-failed')
  }
  // A blocked install belongs back at the check step: what's wrong is the
  // environment, not the install itself.
  if (r?.missing_requirements?.length) requestedStep.value = 'check'
  if (dep.value?.status === 'ok') emit('installed', props.depId)
}

/** Install a bootstrap tool (Homebrew, Node for npm) without leaving the flow. */
async function installRequirement(binary: string): Promise<void> {
  const target = requirementDep(binary)
  if (!target || installing.value) return
  const r = await onboarding.install(target)
  // Keep the blocker visible when the prerequisite itself failed; clear it so
  // the primary install can be retried once the prerequisite is in place.
  if (r?.ok) result.value = null
  else result.value = r
}

async function toggleDontAsk(): Promise<void> {
  const ok = await onboarding.dismissInstallPrompt(props.depId, dontAsk.value)
  if (!ok) {
    dontAsk.value = !dontAsk.value
    return
  }
  emit('dismiss-changed', { depId: props.depId, dismissed: dontAsk.value })
}

function relaunch(): void {
  emit('relaunch', props.depId)
  emit('close')
}
</script>

<template>
  <div class="ci-page" @click.self="emit('close')">
    <section class="ci-dialog" role="dialog" aria-modal="true">
      <header class="ci-top">
        <div>
          <div class="ci-kicker">{{ $t('cli-install.kicker') }}</div>
          <h1>{{ $t('cli-install.title', { label }) }}</h1>
        </div>
        <!-- Same step rail as the first-run wizard: the user is in the same
             situation (environment not ready) and gets the same shape of help. -->
        <ol class="ci-steps">
          <li
            v-for="(name, index) in STEPS"
            :key="name"
            :class="{ active: step === name, done: index < stepIndex }"
          >
            <span>{{ index < stepIndex ? '✓' : index + 1 }}</span>
            {{ $t(`cli-install.step.${name}`) }}
          </li>
        </ol>
      </header>

      <main class="ci-main">
        <!-- Step 1 · Check ---------------------------------------------------->
        <template v-if="step === 'check'">
          <h2>{{ $t('cli-install.check-title', { label }) }}</h2>
          <p class="ci-lead">{{ $t('cli-install.lead', { label }) }}</p>

          <section class="ci-card">
            <div class="ci-card-head">
              <strong>{{ label }}</strong>
              <span v-if="dep" :class="['ci-badge', dep.status]">
                {{ $t(`cli-install.status.${dep.status}`) }}
              </span>
              <span v-else class="ci-badge">{{ $t('label.detecting') }}</span>
            </div>
            <p v-if="dep?.description" class="ci-note">{{ dep.description }}</p>
          </section>

          <!-- Prerequisites, BEFORE anything is attempted -------------------->
          <section v-if="requirementRows.length" class="ci-card" :class="{ blocked: missingRequirements.length }">
            <div class="ci-card-label">{{ $t('cli-install.requirements-label') }}</div>
            <ul class="ci-reqs">
              <li v-for="req in requirementRows" :key="req.name" :class="{ missing: !req.ok }">
                <span class="ci-req-mark">{{ req.ok ? '✓' : '!' }}</span>
                <code>{{ req.name }}</code>
                <span class="ci-note">
                  {{ req.ok ? $t('cli-install.requirement-ok') : $t('cli-install.requirement-missing') }}
                </span>
                <button
                  v-if="!req.ok && requirementDep(req.name)"
                  class="ci-btn primary small ci-install-requirement"
                  :disabled="!!installing"
                  @click="installRequirement(req.name)"
                >
                  {{ installing === requirementDep(req.name)!.id
                    ? $t('cli-install.installing', { seconds: installElapsedSec })
                    : $t('cli-install.install-requirement', { label: requirementDep(req.name)!.label }) }}
                </button>
              </li>
            </ul>
            <p v-if="missingRequirements.length" class="ci-note">
              {{ $t('cli-install.blocked-desc', { label }) }}
            </p>
          </section>

          <!-- What will run, verbatim ---------------------------------------->
          <section v-if="dep && dep.can_install" class="ci-card">
            <div class="ci-card-label">{{ $t('cli-install.command-label') }}</div>
            <code class="ci-command">{{ result?.command || dep.install_cmd }}</code>
            <p class="ci-note">
              {{ dep.needs_terminal
                ? $t('cli-install.note-terminal')
                : $t('cli-install.note-inline') }}
            </p>
          </section>
          <!-- Until the first status arrives `dep` is undefined; without this
               the card claimed the CLI had no install command at all. -->
          <section v-else-if="!dep" class="ci-card">
            <p class="ci-note">{{ $t('label.detecting') }}</p>
          </section>
          <section v-else class="ci-card">
            <p class="ci-note">{{ $t('cli-install.no-install-command', { label }) }}</p>
            <a
              v-if="dep.docs_url"
              class="ci-btn ghost"
              :href="dep.docs_url"
              target="_blank"
              rel="noreferrer"
            >{{ $t('cli-install.docs') }}</a>
          </section>
        </template>

        <!-- Step 2 · Install -------------------------------------------------->
        <template v-else-if="step === 'install'">
          <h2>{{ $t('cli-install.install-title', { label }) }}</h2>

          <section v-if="phase === 'installing'" class="ci-card">
            <strong>{{ $t('cli-install.installing', { seconds: installElapsedSec }) }}</strong>
            <p class="ci-note">{{ $t('cli-install.note-inline') }}</p>
          </section>

          <section v-else-if="phase === 'waiting'" class="ci-card waiting">
            <strong>{{ $t('cli-install.waiting-title') }}</strong>
            <p class="ci-note">{{ $t('cli-install.waiting-desc', { label }) }}</p>
            <code v-if="result?.command" class="ci-command">{{ result.command }}</code>
          </section>

          <section v-else-if="phase === 'failed'" class="ci-card failed">
            <strong>{{ $t('cli-install.failed-title') }}</strong>
            <pre v-if="failureText" class="ci-error">{{ failureText }}</pre>
            <a
              v-if="dep?.docs_url || result?.docs_url"
              class="ci-btn ghost"
              :href="dep?.docs_url || result?.docs_url"
              target="_blank"
              rel="noreferrer"
            >{{ $t('cli-install.docs') }}</a>
          </section>

          <section v-else class="ci-card">
            <div class="ci-card-label">{{ $t('cli-install.command-label') }}</div>
            <code class="ci-command">{{ result?.command || dep?.install_cmd }}</code>
          </section>

          <!-- The watcher gave up; nothing else will change on its own -------->
          <p v-if="watchOutcome === 'timeout' && phase !== 'waiting'" class="ci-warn">
            {{ $t('cli-install.waiting-timeout', { label }) }}
          </p>
          <p v-if="result?.ok && !result.needs_terminal && dep?.status !== 'ok'" class="ci-warn">
            {{ $t('cli-install.installed-not-detected', { label }) }}
          </p>
        </template>

        <!-- Step 3 · Verify --------------------------------------------------->
        <template v-else>
          <div class="ci-verdict">
            <div class="ci-check">✓</div>
            <h2>{{ $t('cli-install.done-title', { label }) }}</h2>
            <p class="ci-lead">
              {{ dep?.version
                ? $t('cli-install.done-desc', { version: dep.version })
                : $t('cli-install.done-desc-no-version') }}
            </p>
            <code v-if="dep?.binary_path" class="ci-command">{{ dep.binary_path }}</code>
            <div class="ci-row center">
              <button
                v-if="origin === 'pane'"
                class="ci-btn primary ci-relaunch"
                @click="relaunch"
              >
                {{ $t('cli-install.relaunch', { label }) }}
              </button>
            </div>
          </div>
        </template>
      </main>

      <footer class="ci-footer">
        <label v-if="dep?.group === 'agent_cli'" class="ci-dont-ask">
          <input v-model="dontAsk" type="checkbox" @change="toggleDontAsk" />
          {{ $t('cli-install.dont-ask', { label }) }}
        </label>
        <span />
        <button class="ci-btn ghost ci-redetect" :disabled="loading || !!installing" @click="onboarding.refresh()">
          {{ loading ? $t('label.detecting') : $t('action.re-detect') }}
        </button>
        <button class="ci-btn ghost ci-close" @click="emit('close')">
          {{ step === 'verify' ? $t('cli-install.close') : $t('cli-install.not-now') }}
        </button>
        <button
          v-if="step !== 'verify' && dep && dep.can_install"
          class="ci-btn primary ci-install"
          :disabled="!!installing || phase === 'waiting'"
          @click="runInstall"
        >
          <template v-if="phase === 'installing'">
            {{ $t('cli-install.installing', { seconds: installElapsedSec }) }}
          </template>
          <template v-else-if="result">{{ $t('cli-install.retry') }}</template>
          <template v-else>{{ $t('cli-install.install') }}</template>
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ci-page {
  position: fixed;
  inset: 0;
  z-index: 9560;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: rgba(0, 0, 0, .58);
  backdrop-filter: blur(3px);
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.ci-dialog {
  width: min(620px, calc(100vw - 56px));
  max-height: min(680px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  background: var(--bg-base);
  box-shadow: 0 22px 70px rgba(0, 0, 0, .48);
}
.ci-top {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 22px 28px 18px; border-bottom: 1px solid var(--border-muted); flex-wrap: wrap;
}
.ci-kicker { color: var(--accent-bright); font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.ci-steps { display: flex; gap: 16px; margin: 0; padding: 0; list-style: none; color: var(--text-muted); font-size: 12px; }
.ci-steps li { display: flex; align-items: center; gap: 6px; }
.ci-steps li span { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid var(--border-default); border-radius: 50%; }
.ci-steps li.active { color: var(--text-bright); }
.ci-steps li.active span { border-color: var(--accent-bright); color: var(--accent-bright); }
.ci-steps li.done span { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ci-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ci-badge { font-size: 11px; border-radius: 99px; padding: 1px 9px; background: var(--bg-base); color: var(--text-muted); }
.ci-badge.ok { color: var(--success-fg, #2b8a3e); }
.ci-badge.outdated { color: var(--attention-fg); }
.ci-reqs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ci-reqs li { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12.5px; }
.ci-reqs .ci-note { margin: 0; }
.ci-req-mark {
  display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 11px; flex: none;
}
.ci-reqs li.missing .ci-req-mark { background: var(--attention-fg); }
.ci-btn.small { padding: 3px 9px; font-size: 12px; margin-left: auto; }
.ci-row.center { justify-content: center; }
h1 { margin: 6px 0 0; color: var(--text-bright); font-size: 22px; }
.ci-desc { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; }
.ci-main { padding: 22px 28px; overflow: auto; }
.ci-lead { margin: 0 0 18px; color: var(--text-secondary); line-height: 1.6; }
.ci-card { padding: 14px 16px; margin-bottom: 12px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-subtle); }
.ci-card.blocked { border-color: var(--attention-fg); }
.ci-card.failed { border-color: var(--danger-fg); }
.ci-card-label { color: var(--text-muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.ci-command { display: block; margin-top: 8px; color: var(--text-bright); font-size: 12px; overflow-wrap: anywhere; }
.ci-note { margin: 8px 0 0; color: var(--text-secondary); font-size: 12.5px; line-height: 1.6; }
.ci-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.ci-error {
  margin: 10px 0 12px; padding: 10px 12px; max-height: 180px; overflow: auto;
  border-radius: 8px; background: var(--bg-base); color: var(--text-secondary);
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
}
.ci-warn { margin: 10px 0 0; color: var(--attention-fg); font-size: 12.5px; line-height: 1.6; }
.ci-verdict { text-align: center; padding: 20px 0 8px; }
.ci-check { display: grid; place-items: center; width: 50px; height: 50px; margin: 0 auto 16px; border-radius: 50%; background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 24px; }
h2 { margin: 0 0 8px; color: var(--text-bright); font-size: 19px; }
.ci-footer { display: flex; align-items: center; gap: 10px; margin-top: auto; padding: 14px 28px; border-top: 1px solid var(--border-muted); flex-wrap: wrap; }
.ci-footer span { flex: 1; }
.ci-dont-ask { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 12px; cursor: pointer; }
.ci-btn { border: 1px solid var(--border-default); border-radius: 7px; padding: 8px 13px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); text-decoration: none; font-size: 13px; }
.ci-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ci-btn.ghost { background: transparent; }
.ci-btn:disabled { opacity: .55; cursor: default; }
@media (max-width: 620px) {
  .ci-page { padding: 14px; }
  .ci-dialog { width: calc(100vw - 28px); }
  .ci-top, .ci-main, .ci-footer { padding-left: 18px; padding-right: 18px; }
}
</style>
