<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type OnboardDep } from '../composables/useOnboarding'
import { usePermissions, PERMISSION_KEYS } from '../composables/usePermissions'
import OnboardingStepCard from './OnboardingStepCard.vue'
import OnboardingPreview from './OnboardingPreview.vue'
import { useSettings } from '../composables/useSettings'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const emit = defineEmits<{ (e: 'complete'): void; (e: 'close'): void }>()

const { t } = useI18n()
const settings = useSettings()
function toggleLanguage(): void {
  settings.setLanguage(settings.language.value === 'zh-TW' ? 'en-US' : 'zh-TW')
}

const ob = useOnboarding(props.backend)
const perms = usePermissions()

onMounted(() => {
  void ob.refresh()
  void perms.refresh()
})

// The wizard can be closed mid-install; its timers must not outlive it.
onBeforeUnmount(() => ob.dispose())

/** Install button label — carries the elapsed seconds, the only progress an
 *  inline brew install reports before its output arrives all at once. */
function installLabel(dep: OnboardDep): string {
  if (ob.installing.value !== dep.id) return t('onboard.install')
  const secs = ob.installElapsedSec.value
  return secs > 0 ? `${t('onboard.installing')} (${secs}s)` : t('onboard.installing')
}

// Re-detect during an install would race the refresh the install itself runs,
// and the loser's response overwrites the winner's status.
const detectBusy = computed(() => ob.loading.value || !!ob.installing.value)

/** ollama installed but its daemon is down — pulling a model cannot work. */
function ollamaStopped(dep: OnboardDep): boolean {
  return dep.id === 'ollama' && dep.status === 'ok' && !ob.ollamaServiceUp.value
}

// An install's output lands in one burst; without this the pane stays pinned
// to the first line and the actual error scrolls out of sight.
const logEl = ref<HTMLElement | null>(null)
watch(
  () => ob.logLines.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

// ── Steps ─────────────────────────────────────────────────────────────────────
type StepId = 'environment' | 'agents' | 'permissions' | 'ready'

// The permission step only exists where the OS has permissions to grant.
const steps = computed<StepId[]>(() =>
  perms.supported.value
    ? ['environment', 'agents', 'permissions', 'ready']
    : ['environment', 'agents', 'ready'],
)
const stepIndex = ref(0)
const current = computed<StepId>(() => steps.value[Math.min(stepIndex.value, steps.value.length - 1)])
const isLast = computed(() => stepIndex.value >= steps.value.length - 1)
const progress = computed(() => (stepIndex.value / Math.max(1, steps.value.length - 1)) * 100)

function stepDone(id: StepId): boolean {
  if (id === 'environment') return ob.foundationReady.value
  // Analyzer is optional (see compute_gate) — a CLI alone completes this step.
  if (id === 'agents') return ob.hasAnyCli.value
  if (id === 'permissions') return perms.allGranted.value
  return ob.allRequiredReady.value
}

// ── Accordion ─────────────────────────────────────────────────────────────────
interface Card {
  key: string
  done: boolean
}

const cards = computed<Card[]>(() => {
  if (current.value === 'environment') {
    return ob.foundationDeps.value.map((d) => ({ key: d.id, done: d.status === 'ok' }))
  }
  if (current.value === 'agents') {
    return [
      ...ob.cliDeps.value.map((d) => ({ key: d.id, done: d.status === 'ok' })),
      ...ob.analyzerDeps.value.map((d) => ({ key: d.id, done: d.status === 'ok' })),
      { key: 'model', done: ob.models.value.length > 0 },
    ]
  }
  if (current.value === 'permissions') {
    return PERMISSION_KEYS.map((k) => ({ key: k, done: perms.isSettled(k) }))
  }
  return []
})

const picked = ref('')
watch(current, () => {
  picked.value = ''
  infoKey.value = ''
})

// Without an explicit pick, the first unfinished card is the open one.
const activeKey = computed(() => {
  if (picked.value && cards.value.some((c) => c.key === picked.value)) return picked.value
  return (cards.value.find((c) => !c.done) ?? cards.value[cards.value.length - 1])?.key ?? ''
})

const infoKey = ref('')
function toggleInfo(key: string): void {
  infoKey.value = infoKey.value === key ? '' : key
}

// Clearing the pick hands the accordion back to "first unfinished card", which
// reads as a collapse. Needed now that finished cards expand too.
function togglePick(key: string): void {
  picked.value = picked.value === key ? '' : key
}

// ── Model picker ──────────────────────────────────────────────────────────────
const selectedModel = ref('')
const customModel = ref('')
const pullTarget = computed(() => customModel.value.trim() || selectedModel.value)

function isInstalled(name: string): boolean {
  return ob.models.value.includes(name)
}

function pickModel(name: string): void {
  selectedModel.value = name
  customModel.value = ''
}

// Default selection follows the recommended catalog entry once it arrives.
watch(
  ob.modelCatalog,
  (cat) => {
    if (!selectedModel.value && !customModel.value && cat.length) {
      selectedModel.value = (cat.find((m) => m.recommended) ?? cat[0]).name
    }
  },
  { immediate: true },
)

// ── Permissions ───────────────────────────────────────────────────────────────
// Full Disk Access cannot be requested in-app; the user flips it in System
// Settings, so poll while the step is on screen to pick the change up.
watch(
  current,
  (id) => (id === 'permissions' ? perms.startPolling() : perms.stopPolling()),
  { immediate: true },
)

const PERM_PANES: Record<TccPermissionKey, string> = {
  automation: 'Privacy & Security › Automation',
  notifications: 'Notifications',
  folders: 'Privacy & Security › Files and Folders',
  fullDisk: 'Privacy & Security › Full Disk Access',
}
// Full Disk Access has no in-app request path — only System Settings.
const SETTINGS_ONLY: TccPermissionKey[] = ['fullDisk']

function requestPermission(key: TccPermissionKey): void {
  const payload =
    key === 'notifications'
      ? { title: t('onboard.notif-test-title'), body: t('onboard.notif-test-body') }
      : undefined
  void perms.request(key, payload)
}

const activePermission = computed<TccPermissionKey | null>(() =>
  current.value === 'permissions' ? ((activeKey.value || null) as TccPermissionKey | null) : null,
)

// ── Footer ────────────────────────────────────────────────────────────────────
async function installMissing(deps: OnboardDep[]): Promise<void> {
  for (const d of deps) {
    if (d.status === 'ok' || !d.can_install) continue
    const result = await ob.install(d)
    // An interactive install only *opens* a terminal — the tool is not there
    // yet. Continuing would run the next command (which may need it) against a
    // machine that still lacks it: on a fresh Mac every `brew install …` after
    // Homebrew failed with exit 127. Stop and let the watcher/Re-detect catch up.
    if (result?.needs_terminal) break
    // A missing bootstrap binary blocks everything downstream of it too.
    if (result?.missing_requirements?.length) break
  }
}

// Escape hatch: the wizard must never be a dead end. Skipping persists the
// complete flag so it doesn't re-block every launch — later gaps are covered
// in-app (missing-CLI badges in the spawn dropdown, the exit=127 install
// prompt), and Settings → Appearance re-opens this wizard on demand.
function skipForNow(): void {
  void ob
    .markComplete()
    .catch(() => {})
    .finally(() => emit('close'))
}

function finish(): void {
  void ob
    .markComplete()
    .catch(() => {})
    .finally(() => emit('complete'))
}
</script>

<template>
  <div class="ob-page">
    <header class="ob-top">
      <ol class="ob-steps">
        <li v-for="(s, i) in steps" :key="s" :class="{ active: current === s, done: stepDone(s) }">
          <button type="button" @click="stepIndex = i">{{ $t(`onboard.step.${s}`) }}</button>
          <span v-if="i < steps.length - 1" class="ob-chev" aria-hidden="true">›</span>
        </li>
      </ol>
      <button class="ob-lang-btn" @click="toggleLanguage">
        <span :class="{ active: settings.language.value === 'zh-TW' }">繁中</span>
        <span class="ob-lang-sep">/</span>
        <span :class="{ active: settings.language.value === 'en-US' }">EN</span>
      </button>
      <div class="ob-progress"><span :style="{ width: `${progress}%` }" /></div>
    </header>

    <div class="ob-split">
      <!-- ── Left: guided cards ───────────────────────────────────────────── -->
      <main class="ob-main">
        <h1 class="ob-head">{{ $t(`onboard.head.${current}`) }}</h1>

        <!-- Environment -->
        <template v-if="current === 'environment'">
          <OnboardingStepCard
            v-for="d in ob.foundationDeps.value"
            :key="d.id"
            :title="d.label"
            :description="d.description"
            :meta="d.version"
            :done="d.status === 'ok'"
            :expanded="activeKey === d.id"
            :warning="d.status === 'outdated' ? $t('onboard.outdated', { min: d.min_version }) : ''"
            @toggle="togglePick(d.id)"
          >
            <template #actions>
              <button
                v-if="d.can_install"
                class="ob-btn primary"
                :disabled="!!ob.installing.value"
                @click="ob.install(d)"
              >
                {{ installLabel(d) }}
              </button>
              <a v-else-if="d.docs_url" class="ob-btn primary" :href="d.docs_url" target="_blank" rel="noreferrer">
                {{ $t('onboard.install-guide') }}
              </a>
              <button class="ob-btn ghost" :disabled="detectBusy" @click="ob.refresh()">
                {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
              </button>
            </template>
          </OnboardingStepCard>

          <button
            class="ob-linkbtn"
            :disabled="!!ob.installing.value"
            @click="installMissing(ob.foundationDeps.value)"
          >
            {{ $t('action.install-missing') }}
          </button>
        </template>

        <!-- Agents -->
        <template v-else-if="current === 'agents'">
          <OnboardingStepCard
            v-for="d in [...ob.cliDeps.value, ...ob.analyzerDeps.value]"
            :key="d.id"
            :title="d.label"
            :description="d.description"
            :meta="d.version"
            :optional="d.optional"
            :done="d.status === 'ok'"
            :expanded="activeKey === d.id"
            :warning="ollamaStopped(d) ? $t('onboard.ollama-stopped') : ''"
            @toggle="togglePick(d.id)"
          >
            <template #actions>
              <button
                v-if="ollamaStopped(d)"
                class="ob-btn primary"
                @click="ob.startOllamaService()"
              >
                {{ $t('action.start-ollama') }}
              </button>
              <button
                v-else-if="d.can_install"
                class="ob-btn primary"
                :disabled="!!ob.installing.value"
                @click="ob.install(d)"
              >
                {{ installLabel(d) }}
              </button>
              <a v-else-if="d.docs_url" class="ob-btn primary" :href="d.docs_url" target="_blank" rel="noreferrer">
                {{ $t('onboard.install-guide') }}
              </a>
              <button class="ob-btn ghost" :disabled="detectBusy" @click="ob.refresh()">
                {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
              </button>
            </template>
          </OnboardingStepCard>

          <!-- Analysis model -->
          <OnboardingStepCard
            :title="$t('label.analysis-model')"
            :description="$t('hint.download-model')"
            optional
            :done="ob.models.value.length > 0"
            :expanded="activeKey === 'model'"
            @toggle="togglePick('model')"
          >
            <template #actions>
              <div class="ob-models">
                <div class="ob-installed">
                  <template v-if="ob.models.value.length">
                    <span v-for="m in ob.models.value" :key="m" class="ob-chip ok">✓ {{ m }}</span>
                  </template>
                  <span v-else class="ob-chip empty">{{ $t('label.no-models-installed') }}</span>
                </div>

                <div class="ob-model-grid">
                  <button
                    v-for="m in ob.modelCatalog.value"
                    :key="m.name"
                    type="button"
                    class="ob-model-card"
                    :class="{ selected: selectedModel === m.name }"
                    @click="pickModel(m.name)"
                  >
                    <span class="ob-model-radio" />
                    <span class="ob-model-info">
                      <span class="ob-model-name">
                        {{ m.name }}
                        <span v-if="m.recommended" class="ob-tag rec">{{ $t('label.recommended') }}</span>
                        <span v-if="isInstalled(m.name)" class="ob-tag inst">{{ $t('label.installed') }}</span>
                      </span>
                      <span class="ob-model-desc">{{ m.desc }}</span>
                    </span>
                    <span class="ob-model-size">{{ m.size }}</span>
                  </button>
                </div>

                <label class="ob-model-custom">
                  <span class="ob-model-custom-label">{{ $t('label.other-model') }}</span>
                  <input
                    v-model="customModel"
                    class="ob-input"
                    placeholder="e.g. codellama:7b, gemma3:4b"
                    spellcheck="false"
                  />
                </label>
              </div>

              <button
                class="ob-btn primary"
                :disabled="!pullTarget || !!ob.pulling.value"
                @click="ob.pullModel(pullTarget)"
              >
                {{
                  ob.pulling.value
                    ? $t('onboard.downloading', { name: ob.pulling.value })
                    : $t('action.download-model', { name: pullTarget || $t('label.model') })
                }}
              </button>
              <button class="ob-btn ghost" :disabled="detectBusy" @click="ob.refresh()">
                {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
              </button>
            </template>
          </OnboardingStepCard>
        </template>

        <!-- Permissions -->
        <template v-else-if="current === 'permissions'">
          <OnboardingStepCard
            v-for="k in PERMISSION_KEYS"
            :key="k"
            :title="$t(`onboard.perm.${k}.title`)"
            :description="$t(`onboard.perm.${k}.desc`)"
            :optional="SETTINGS_ONLY.includes(k)"
            :done="perms.statuses.value[k] === 'granted'"
            :expanded="activeKey === k"
            :warning="perms.statuses.value[k] === 'denied' ? $t(`onboard.perm.${k}.denied`) : ''"
            @toggle="togglePick(k)"
          >
            <template #actions>
              <button
                v-if="!SETTINGS_ONLY.includes(k) && perms.statuses.value[k] !== 'denied'"
                class="ob-btn primary"
                :disabled="!!perms.requesting.value"
                @click="requestPermission(k)"
              >
                {{ perms.requesting.value === k ? $t('onboard.requesting') : $t('onboard.allow') }}
              </button>
              <button
                v-else
                class="ob-btn primary"
                @click="perms.openSettings(k)"
              >
                {{ $t('onboard.open-settings') }}
              </button>
              <button class="ob-btn ghost" @click="perms.refresh()">{{ $t('action.re-detect') }}</button>
              <button
                class="ob-info"
                type="button"
                :aria-label="$t('onboard.why')"
                @click="toggleInfo(k)"
              >
                ⓘ
              </button>
              <p v-if="infoKey === k" class="ob-note">{{ $t(`onboard.perm.${k}.why`) }}</p>
            </template>
          </OnboardingStepCard>
        </template>

        <!-- Ready -->
        <template v-else>
          <p class="ob-hint">{{ $t('hint.ready-check') }}</p>
          <ul class="ob-gate">
            <li :class="{ ok: ob.foundationReady.value }">
              <span>{{ ob.foundationReady.value ? '✓' : '○' }}</span> {{ $t('label.foundation-ready') }}
            </li>
            <li :class="{ ok: ob.hasAnyCli.value }">
              <span>{{ ob.hasAnyCli.value ? '✓' : '○' }}</span> {{ $t('label.at-least-one-cli') }}
            </li>
            <li :class="{ ok: ob.analyzerReady.value }">
              <span>{{ ob.analyzerReady.value ? '✓' : '○' }}</span> {{ $t('label.ollama-model-ready') }} ·
              {{ $t('label.optional') }}
            </li>
            <li v-if="perms.supported.value" :class="{ ok: perms.allGranted.value }">
              <span>{{ perms.allGranted.value ? '✓' : '○' }}</span> {{ $t('onboard.perm-gate') }} ·
              {{ $t('label.optional') }}
            </li>
          </ul>
          <button class="ob-linkbtn" :disabled="detectBusy" @click="ob.refresh()">
            {{ ob.loading.value ? $t('label.detecting') : $t('action.re-detect') }}
          </button>
        </template>

        <!-- Install log -->
        <div v-if="ob.logLines.value.length" ref="logEl" class="ob-log">
          <div v-for="(l, i) in ob.logLines.value" :key="i" class="ob-log-line">{{ l }}</div>
        </div>
      </main>

      <!-- ── Right: illustration ──────────────────────────────────────────── -->
      <aside class="ob-aside">
        <OnboardingPreview
          v-if="activePermission"
          variant="settings"
          :pane="PERM_PANES[activePermission]"
          :caption="$t(`onboard.perm.${activePermission}.pane-hint`)"
          :granted="perms.statuses.value[activePermission] === 'granted'"
        />
        <OnboardingPreview v-else variant="app" :caption="$t(`onboard.aside.${current}`)" />
      </aside>
    </div>

    <footer class="ob-footer">
      <button class="ob-btn ghost" @click="skipForNow">{{ $t('action.skip-for-now') }}</button>
      <button v-if="stepIndex > 0" class="ob-btn ghost" @click="stepIndex--">{{ $t('action.back') }}</button>
      <span class="ob-spacer" />
      <button
        v-if="!isLast"
        class="ob-btn primary"
        :disabled="!!ob.installing.value"
        @click="stepIndex++"
      >
        {{ $t('action.next') }}
      </button>
      <button
        v-else
        class="ob-btn primary"
        :disabled="!ob.allRequiredReady.value"
        :title="ob.allRequiredReady.value ? '' : $t('hint.not-ready')"
        @click="finish"
      >
        {{ $t('action.open-app') }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.ob-page {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  -webkit-app-region: no-drag;
}

/* ── Top stepper ────────────────────────────────────────────────────────────── */
.ob-top {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px 22px 16px;
}
.ob-steps {
  display: flex;
  align-items: center;
  gap: 14px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.ob-steps li {
  display: flex;
  align-items: center;
  gap: 14px;
}
.ob-steps button {
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
  transition: color 0.15s;
}
.ob-steps li.done button {
  color: var(--text-secondary);
}
.ob-steps li.active button {
  color: var(--text-bright);
}
.ob-chev {
  font-size: 15px;
  color: var(--text-disabled);
}
.ob-lang-btn {
  position: absolute;
  right: 22px;
  display: flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
}
.ob-lang-btn span.active {
  color: var(--text-bright);
  font-weight: 600;
}
.ob-lang-sep {
  color: var(--text-muted);
  margin: 0 2px;
}
.ob-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--border-muted);
}
.ob-progress span {
  display: block;
  height: 100%;
  background: var(--text-bright);
  transition: width 0.25s ease;
}

/* ── Split layout ───────────────────────────────────────────────────────────── */
.ob-split {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-height: 0;
}
.ob-main {
  overflow-y: auto;
  padding: 48px 56px 32px;
}
.ob-aside {
  overflow: hidden;
  border-left: 1px solid var(--border-muted);
  background: var(--bg-inset);
}
@media (max-width: 1000px) {
  .ob-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .ob-aside {
    display: none;
  }
  .ob-main {
    padding: 32px 28px;
  }
}

.ob-head {
  margin: 0 0 32px;
  font-size: 34px;
  line-height: 1.2;
  font-weight: 750;
  letter-spacing: -0.02em;
  color: var(--text-bright);
}
.ob-hint {
  font-size: 13.5px;
  color: var(--text-secondary);
  margin: 0 0 16px;
  line-height: 1.55;
}

/* ── Card actions ───────────────────────────────────────────────────────────── */
.ob-btn {
  font-size: 13px;
  padding: 9px 18px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  line-height: 1.3;
}
.ob-btn:hover:not(:disabled) {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.ob-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ob-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
.ob-btn.primary:hover:not(:disabled) {
  background: var(--accent-focus);
  color: var(--text-on-emphasis);
}
.ob-info {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 0;
  background: none;
  color: var(--text-muted);
  font-size: 15px;
  cursor: pointer;
}
.ob-info:hover {
  color: var(--text-bright);
}
.ob-note {
  flex-basis: 100%;
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-muted);
}
.ob-linkbtn {
  background: none;
  border: 0;
  padding: 4px 0;
  font-size: 12.5px;
  color: var(--accent-fg);
  cursor: pointer;
}
.ob-linkbtn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Model picker ───────────────────────────────────────────────────────────── */
.ob-models {
  flex-basis: 100%;
  margin-bottom: 4px;
}
.ob-installed {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.ob-chip {
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-secondary);
}
.ob-chip.ok {
  color: var(--success-fg);
  border-color: color-mix(in srgb, var(--success-fg) 35%, transparent);
}
.ob-chip.empty {
  color: var(--text-muted);
  font-family: inherit;
}
.ob-model-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ob-model-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-base);
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s;
}
.ob-model-card:hover {
  border-color: var(--border-default);
  background: var(--bg-muted);
}
.ob-model-card.selected {
  border-color: var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 8%, var(--bg-base));
}
.ob-model-radio {
  flex: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  position: relative;
}
.ob-model-card.selected .ob-model-radio {
  border-color: var(--accent-emphasis);
}
.ob-model-card.selected .ob-model-radio::after {
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  background: var(--accent-emphasis);
}
.ob-model-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ob-model-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font: 12px/1.3 ui-monospace, Menlo, monospace;
  color: var(--text-bright);
}
.ob-model-desc {
  font-size: 11px;
  color: var(--text-muted);
}
.ob-model-size {
  flex: none;
  font: 11px/1 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--bg-muted);
}
.ob-tag {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  padding: 1px 6px;
  border-radius: 999px;
  line-height: 1.5;
}
.ob-tag.rec {
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent-fg) 14%, transparent);
}
.ob-tag.inst {
  color: var(--success-fg);
  background: color-mix(in srgb, var(--success-fg) 14%, transparent);
}
.ob-model-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.ob-model-custom-label {
  flex: none;
  font-size: 11px;
  color: var(--text-secondary);
}
.ob-input {
  flex: 1;
  min-width: 0;
  font: 11px/1 ui-monospace, Menlo, monospace;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-base);
  color: var(--text-bright);
}
.ob-input:focus {
  outline: none;
  border-color: var(--accent-emphasis);
}
.ob-input::placeholder {
  color: var(--text-muted);
}

/* ── Ready gate ─────────────────────────────────────────────────────────────── */
.ob-gate {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.ob-gate li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  font-size: 14px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ob-gate li.ok {
  color: var(--success-fg);
}
.ob-gate li span {
  font-weight: 700;
}

.ob-log {
  margin-top: 20px;
  max-height: 140px;
  overflow-y: auto;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 8px 10px;
  font: 11px/1.5 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
}
.ob-log-line {
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Footer ─────────────────────────────────────────────────────────────────── */
.ob-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 22px;
  border-top: 1px solid var(--border-muted);
}
.ob-spacer {
  flex: 1;
}
</style>
