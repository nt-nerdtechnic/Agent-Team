<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import type { AiCliSessionController } from './index'

const props = withDefaults(
  defineProps<{
    controller: AiCliSessionController
    defaultProfileId?: string
    initialCols?: number
    initialRows?: number
  }>(),
  {
    defaultProfileId: 'codex',
    initialCols: 100,
    initialRows: 30,
  },
)

const input = ref('')
const output = ref('')
const running = ref(props.controller.sessionId !== null)
const pending = ref(false)
const error = ref<string | null>(null)

const removeOutputListener = props.controller.onOutput((data) => {
  output.value += data
})

async function start(): Promise<void> {
  if (pending.value || running.value) return
  pending.value = true
  error.value = null
  try {
    await props.controller.start(props.defaultProfileId, props.initialCols, props.initialRows)
    running.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to start AI CLI session'
  } finally {
    pending.value = false
  }
}

async function sendText(): Promise<void> {
  if (!running.value || pending.value || input.value.length === 0) return
  const data = input.value
  input.value = ''
  pending.value = true
  error.value = null
  try {
    await props.controller.send(data.endsWith('\n') ? data : `${data}\n`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to send input'
    input.value = data
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
    error.value = cause instanceof Error ? cause.message : 'Unable to stop AI CLI session'
  } finally {
    pending.value = false
  }
}

onUnmounted(() => {
  removeOutputListener()
  props.controller.dispose()
})

defineExpose({ start, sendText, stop })
</script>

<template>
  <section class="navide-safe-ai-cli" aria-label="AI CLI">
    <div class="navide-safe-ai-cli__toolbar">
      <button v-if="!running" type="button" :disabled="pending" @click="start">Start</button>
      <button v-else type="button" :disabled="pending" @click="stop">Stop</button>
    </div>
    <pre class="navide-safe-ai-cli__output" aria-live="polite">{{ output }}</pre>
    <form class="navide-safe-ai-cli__input" @submit.prevent="sendText">
      <input v-model="input" :disabled="!running || pending" aria-label="AI CLI input" />
      <button type="submit" :disabled="!running || pending || input.length === 0">Send</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
