<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiCliProfile, AiCliSessionController, SafeAiCliPanelHandle } from './index'
import { setContext, settingsGet, settingsReadiness, settingsReady, settingsSet } from './shared'

const QUIET_MS = 3_500
const QUIET_TIMEOUT_MS = 25_000
const MIN_WIDTH = 280
const MAX_WIDTH = 600
const EARLY_OUTPUT_LIMIT = 64 * 1024

const props = withDefaults(defineProps<{
  controller: AiCliSessionController
  defaultProfileId?: string
  initialCols?: number
  initialRows?: number
  buildContext?: () => string
}>(), { defaultProfileId: 'claude', initialCols: 100, initialRows: 30 })

const { t } = useI18n()
const terminalHost = ref<HTMLElement | null>(null)
const running = ref(props.controller.sessionId !== null)
const pending = ref(false)
const collapsed = ref(true)
const error = ref<string | null>(null)
const profiles = ref<AiCliProfile[]>([])
const selectedProfileId = ref(settingsGet('git-ai-panel-width.agent', props.defaultProfileId))
const panelWidth = ref(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(settingsGet('git-ai-panel-width', 360)) || 360)))
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let lastOutputAt = 0
let inputQueue = Promise.resolve()
let initialization: Promise<void> = Promise.resolve()
let earlyOutput = ''
let stopWidthResize: (() => void) | null = null

const removeOutputListener = props.controller.onOutput((data) => {
  lastOutputAt = Date.now()
  if (terminal) terminal.write(data)
  else earlyOutput = `${earlyOutput}${data}`.slice(-EARLY_OUTPUT_LIMIT)
})
const removeExitListener = props.controller.onExit(() => { running.value = false })

function reportError(cause: unknown, fallbackKey: string): void {
  error.value = cause instanceof Error ? cause.message : t(fallbackKey)
}

function enqueueInput(data: string): Promise<void> {
  const next = inputQueue.catch(() => undefined).then(() => props.controller.send(data))
  inputQueue = next.catch(() => undefined)
  return next
}

async function fitAndResize(): Promise<void> {
  if (!terminal || !fitAddon || !running.value || collapsed.value) return
  fitAddon.fit()
  await props.controller.resize(terminal.cols, terminal.rows)
}

async function start(): Promise<void> {
  await initialization
  if (pending.value || running.value) return
  pending.value = true
  error.value = null
  try {
    await props.controller.start(
      selectedProfileId.value,
      terminal?.cols || props.initialCols,
      terminal?.rows || props.initialRows,
      { yolo: settingsGet<string>('agentTeam.yolo', '1') !== '0' },
    )
    running.value = true
    lastOutputAt = Date.now()
    await nextTick()
    await fitAndResize()
    const context = props.buildContext?.().trim()
    if (context) {
      await waitForQuiet()
      await enqueueInput(`\u001b[200~${context}\u001b[201~`)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await enqueueInput('\r')
    }
    terminal?.focus()
  } catch (cause) {
    reportError(cause, 'ai-cli.start-failed')
  } finally {
    pending.value = false
  }
}

function selectProfile(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  selectedProfileId.value = value
  settingsSet('git-ai-panel-width.agent', value)
}

function beginWidthResize(event: PointerEvent): void {
  if (collapsed.value) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = panelWidth.value
  const move = (next: PointerEvent) => {
    panelWidth.value = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth - (next.clientX - startX)))
  }
  const finish = () => {
    settingsSet('git-ai-panel-width', panelWidth.value)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    stopWidthResize = null
  }
  stopWidthResize?.()
  stopWidthResize = finish
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish, { once: true })
}

async function stop(): Promise<void> {
  if (!running.value || pending.value) return
  pending.value = true
  error.value = null
  try {
    await props.controller.stop()
    running.value = false
  } catch (cause) {
    reportError(cause, 'ai-cli.stop-failed')
  } finally {
    pending.value = false
  }
}

async function interrupt(): Promise<void> {
  if (!running.value || pending.value) return
  try {
    await props.controller.interrupt()
  } catch (cause) {
    reportError(cause, 'ai-cli.interrupt-failed')
  }
}

function focus(): void {
  if (collapsed.value) collapsed.value = false
  void nextTick(() => terminal?.focus())
}

// Whether this panel's terminal currently holds focus. Published as the shared
// `terminalFocus` keybinding context, which every rule written to yield to a
// focused PTY reads (`escape` in the Plan window, the Git window's git.*
// chords). The Host renderer's own terminal composable publishes it for CLI
// panes; a plugin window has no such composable, so without this the guard is
// vacuously true there and the key is consumed before the PTY ever sees it.
let ownsTerminalFocus = false

function claimTerminalFocus(): void {
  ownsTerminalFocus = true
  setContext('terminalFocus', true)
}

function releaseTerminalFocus(): void {
  if (!ownsTerminalFocus) return
  ownsTerminalFocus = false
  setContext('terminalFocus', false)
}

function onTerminalFocusOut(event: FocusEvent): void {
  // Focus moving within the terminal (xterm swaps its helper textarea) is not a
  // release. Anything else is — including a null relatedTarget, which is what a
  // click on a non-focusable element elsewhere in the window reports; treating
  // that as "only the window blurred" would strand the context on for good.
  const next = event.relatedTarget
  if (next instanceof Node && terminalHost.value?.contains(next)) return
  releaseTerminalFocus()
}

async function waitForQuiet(): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS
  while (running.value && Date.now() < deadline && Date.now() - lastOutputAt < QUIET_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function submitPrompt(prompt: string): Promise<boolean> {
  if (!running.value) await start()
  if (!running.value) return false
  await waitForQuiet()
  if (!running.value) return false
  try {
    await enqueueInput(`\u001b[200~${prompt}\u001b[201~`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await enqueueInput('\r')
    focus()
    return true
  } catch (cause) {
    reportError(cause, 'ai-cli.send-failed')
    return false
  }
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    scrollback: 5_000,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 12,
    theme: { background: '#00000000' },
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  if (terminalHost.value) {
    terminal.open(terminalHost.value)
    // focusin/focusout rather than the textarea's own focus/blur: xterm owns
    // that element and may replace it, and these bubble from whichever one it
    // is currently using.
    terminalHost.value.addEventListener('focusin', claimTerminalFocus)
    terminalHost.value.addEventListener('focusout', onTerminalFocusOut)
  }
  if (earlyOutput) {
    terminal.write(earlyOutput)
    earlyOutput = ''
  }
  terminal.onData((data) => {
    if (!running.value) return
    void enqueueInput(data).catch((cause) => reportError(cause, 'ai-cli.send-failed'))
  })
  resizeObserver = new ResizeObserver(() => {
    void fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
  })
  if (terminalHost.value) resizeObserver.observe(terminalHost.value)
  initialization = (async () => {
    let canPersistSettings = false
    try {
      await settingsReady()
      canPersistSettings = true
    } catch {
      // The owning v2 surface renders a retry affordance. Keep this panel
      // usable with non-persistent defaults, but never write them back.
    }
    profiles.value = await props.controller.listProfiles()
    if (!profiles.value.some(({ id }) => id === selectedProfileId.value)) {
      selectedProfileId.value = profiles.value[0]?.id ?? props.defaultProfileId
      if (canPersistSettings) settingsSet('git-ai-panel-width.agent', selectedProfileId.value)
    }
    const resumed = await props.controller.resume(terminal?.cols || props.initialCols, terminal?.rows || props.initialRows)
    if (resumed) {
      running.value = true
      selectedProfileId.value = resumed.profileId
      if (canPersistSettings) settingsSet('git-ai-panel-width.agent', resumed.profileId)
    }
    await fitAndResize()
  })().catch((cause) => reportError(cause, 'ai-cli.start-failed'))
})

watch(collapsed, async (value) => {
  if (value) return
  await nextTick()
  await fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
})

// If the first authoritative snapshot failed, the panel may have rendered with
// non-persistent defaults while the surrounding v2 surface offers Retry. Apply
// the real snapshot when that retry succeeds, without reacting to later user
// edits or queued writes.
watch(() => settingsReadiness.status, (status) => {
  if (status !== 'ready') return
  selectedProfileId.value = settingsGet('git-ai-panel-width.agent', selectedProfileId.value)
  panelWidth.value = Math.min(
    MAX_WIDTH,
    Math.max(MIN_WIDTH, Number(settingsGet('git-ai-panel-width', panelWidth.value)) || panelWidth.value),
  )
})

onUnmounted(() => {
  terminalHost.value?.removeEventListener('focusin', claimTerminalFocus)
  terminalHost.value?.removeEventListener('focusout', onTerminalFocusOut)
  // A panel unmounted while focused never fires focusout, and a stuck-on
  // context would disable every `!terminalFocus` binding in the window.
  releaseTerminalFocus()
  resizeObserver?.disconnect()
  stopWidthResize?.()
  removeOutputListener()
  removeExitListener()
  terminal?.dispose()
  fitAddon?.dispose()
  props.controller.dispose()
})

defineExpose<SafeAiCliPanelHandle>({ start, focus, submitPrompt, stop })
</script>

<template>
  <section
    class="navide-safe-ai-cli"
    :class="{ 'is-collapsed': collapsed }"
    :style="collapsed ? undefined : { width: `${panelWidth}px` }"
    :aria-label="t('ai-cli.label')"
  >
    <div v-if="!collapsed" class="navide-safe-ai-cli__resizer" @pointerdown="beginWidthResize" />
    <header class="navide-safe-ai-cli__toolbar">
      <strong>{{ t('ai-cli.title') }}</strong>
      <select
        v-if="!running"
        :value="selectedProfileId"
        :aria-label="t('ai-cli.profile')"
        @change="selectProfile"
      >
        <option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{ profile.label }}</option>
      </select>
      <span class="navide-safe-ai-cli__spacer" />
      <button v-if="running" type="button" :disabled="pending" @click="interrupt">{{ t('ai-cli.interrupt') }}</button>
      <button v-if="!running" type="button" :disabled="pending" @click="start">{{ t('ai-cli.start') }}</button>
      <button v-else type="button" :disabled="pending" @click="stop">{{ t('ai-cli.stop') }}</button>
      <button class="navide-safe-ai-cli__toggle" type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">{{ collapsed ? '▴' : '▾' }}</button>
    </header>
    <div v-show="!collapsed" ref="terminalHost" class="navide-safe-ai-cli__terminal" />
    <p v-if="error" class="navide-safe-ai-cli__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.navide-safe-ai-cli { position: relative; display: flex; width: 360px; min-width: 280px; max-width: 600px; min-height: 0; flex: 0 0 auto; flex-direction: column; border-left: 1px solid var(--border-subtle); background: var(--bg-primary); color: var(--text-primary); }
.navide-safe-ai-cli__resizer { position: absolute; z-index: 1; top: 0; bottom: 0; left: -3px; width: 6px; cursor: col-resize; }
.navide-safe-ai-cli__toolbar { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); }
.navide-safe-ai-cli__toolbar strong { font-size: var(--font-xs); }
.navide-safe-ai-cli__toolbar select { min-width: 0; max-width: 132px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-secondary); }
.navide-safe-ai-cli__spacer { flex: 1; }
.navide-safe-ai-cli__toolbar button { border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-secondary); padding: 3px 7px; cursor: pointer; }
.navide-safe-ai-cli__toolbar button:hover { background: var(--bg-hover); color: var(--text-primary); }
.navide-safe-ai-cli__toolbar button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.navide-safe-ai-cli__toolbar button:active { transform: translateY(1px); }
.navide-safe-ai-cli__toolbar button:disabled { cursor: default; opacity: .5; }
.navide-safe-ai-cli__terminal { flex: 1; min-height: 180px; padding: 6px; overflow: hidden; }
.navide-safe-ai-cli__error { margin: 0; padding: 6px 8px; color: var(--danger-fg); font-size: var(--font-xs); }
.navide-safe-ai-cli.is-collapsed { width: 42px; min-width: 42px; min-height: 34px; }
.navide-safe-ai-cli.is-collapsed .navide-safe-ai-cli__toolbar > :not(:last-child) { display: none; }
</style>
