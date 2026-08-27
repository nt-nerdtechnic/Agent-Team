<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AiCliSessionController, SafeAiCliPanelHandle } from './index'

const QUIET_MS = 3_500
const QUIET_TIMEOUT_MS = 25_000

const props = withDefaults(defineProps<{
  controller: AiCliSessionController
  defaultProfileId?: string
  initialCols?: number
  initialRows?: number
}>(), { defaultProfileId: 'codex', initialCols: 100, initialRows: 30 })

const { t } = useI18n()
const terminalHost = ref<HTMLElement | null>(null)
const running = ref(props.controller.sessionId !== null)
const pending = ref(false)
const collapsed = ref(false)
const error = ref<string | null>(null)
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let lastOutputAt = 0
let inputQueue = Promise.resolve()

const removeOutputListener = props.controller.onOutput((data) => {
  lastOutputAt = Date.now()
  terminal?.write(data)
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
  if (pending.value || running.value) return
  pending.value = true
  error.value = null
  try {
    await props.controller.start(
      props.defaultProfileId,
      terminal?.cols || props.initialCols,
      terminal?.rows || props.initialRows,
    )
    running.value = true
    lastOutputAt = Date.now()
    await nextTick()
    await fitAndResize()
    terminal?.focus()
  } catch (cause) {
    reportError(cause, 'ai-cli.start-failed')
  } finally {
    pending.value = false
  }
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
  if (terminalHost.value) terminal.open(terminalHost.value)
  terminal.onData((data) => {
    if (!running.value) return
    void enqueueInput(data).catch((cause) => reportError(cause, 'ai-cli.send-failed'))
  })
  resizeObserver = new ResizeObserver(() => {
    void fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
  })
  if (terminalHost.value) resizeObserver.observe(terminalHost.value)
  void fitAndResize()
})

watch(collapsed, async (value) => {
  if (value) return
  await nextTick()
  await fitAndResize().catch((cause) => reportError(cause, 'ai-cli.resize-failed'))
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  removeOutputListener()
  removeExitListener()
  terminal?.dispose()
  fitAddon?.dispose()
  props.controller.dispose()
})

defineExpose<SafeAiCliPanelHandle>({ start, focus, submitPrompt, stop })
</script>

<template>
  <section class="navide-safe-ai-cli" :class="{ 'is-collapsed': collapsed }" :aria-label="t('ai-cli.label')">
    <header class="navide-safe-ai-cli__toolbar">
      <strong>{{ t('ai-cli.title') }}</strong>
      <span class="navide-safe-ai-cli__spacer" />
      <button v-if="running" type="button" :disabled="pending" @click="interrupt">{{ t('ai-cli.interrupt') }}</button>
      <button v-if="!running" type="button" :disabled="pending" @click="start">{{ t('ai-cli.start') }}</button>
      <button v-else type="button" :disabled="pending" @click="stop">{{ t('ai-cli.stop') }}</button>
      <button type="button" :aria-expanded="!collapsed" @click="collapsed = !collapsed">{{ collapsed ? '▴' : '▾' }}</button>
    </header>
    <div v-show="!collapsed" ref="terminalHost" class="navide-safe-ai-cli__terminal" />
    <p v-if="error" class="navide-safe-ai-cli__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.navide-safe-ai-cli { display: flex; width: 360px; min-width: 240px; min-height: 0; flex: 0 0 auto; flex-direction: column; border-left: 1px solid var(--border-subtle); background: var(--bg-primary); color: var(--text-primary); }
.navide-safe-ai-cli__toolbar { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); }
.navide-safe-ai-cli__toolbar strong { font-size: var(--font-xs); }
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
