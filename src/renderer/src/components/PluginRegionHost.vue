<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface PluginRegionContribution {
  pluginId: string
  packageVersion: string | null
  contributionKey: string
  title: string
  icon: string | null
  kind: 'custom'
  location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window'
  manifestOrder: number
}

const props = defineProps<{
  contribution: PluginRegionContribution
  workspacePath: string
  visible: boolean
}>()

const host = ref<HTMLElement | null>(null)
const error = ref<string | null>(null)
let observer: ResizeObserver | null = null
let disposed = false
let opened = false
let openedWorkspace = ''
let queue = Promise.resolve()
let syncGeneration = 0

function bounds(): { x: number; y: number; width: number; height: number } | null {
  const element = host.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((reason: unknown) => {
    error.value = reason instanceof Error ? reason.message : String(reason)
  })
}

function sync(): void {
  const generation = ++syncGeneration
  enqueue(async () => {
    if (disposed || generation !== syncGeneration) return
    const workspacePath = props.workspacePath.trim()
    const contributionKey = props.contribution.contributionKey
    if (!workspacePath || !props.visible) {
      if (opened) {
        await window.agentTeam?.plugins?.closeContribution({ contributionKey })
        opened = false
        openedWorkspace = ''
      }
      return
    }
    const rect = bounds()
    if (!rect) return
    if (opened && openedWorkspace !== workspacePath) {
      await window.agentTeam?.plugins?.closeContribution({ contributionKey })
      opened = false
      openedWorkspace = ''
    }
    if (!opened) {
      const result = await window.agentTeam?.plugins?.openContribution({
        contributionKey,
        workspace_path: workspacePath,
        bounds: rect,
      })
      if (!result?.ok) throw new Error(result?.error ?? 'plugin contribution could not be opened')
      // The request may have crossed a workspace change or unmount while the
      // Host was creating the view. Close by stable contribution key rather
      // than exposing the late opaque instance id to the renderer.
      if (disposed || generation !== syncGeneration) {
        await window.agentTeam?.plugins?.closeContribution({ contributionKey })
        return
      }
      opened = true
      openedWorkspace = workspacePath
      error.value = null
      return
    }
    const result = await window.agentTeam?.plugins?.updateContribution({
      contributionKey,
      bounds: rect,
      visible: props.visible,
    })
    if (!result?.ok) throw new Error('plugin contribution is no longer active')
    error.value = null
  })
}

watch(
  () => [props.workspacePath, props.visible, props.contribution.contributionKey] as const,
  () => void nextTick(sync),
)

onMounted(() => {
  observer = new ResizeObserver(() => sync())
  if (host.value) observer.observe(host.value)
  sync()
})

onBeforeUnmount(() => {
  disposed = true
  syncGeneration += 1
  observer?.disconnect()
  observer = null
  // Always enqueue cleanup. An open request can still be in flight, and a
  // close queued behind it prevents a late response from orphaning a view.
  enqueue(async () => {
    await window.agentTeam?.plugins?.closeContribution({
      contributionKey: props.contribution.contributionKey,
    })
    opened = false
    openedWorkspace = ''
  })
})
</script>

<template>
  <div ref="host" class="plugin-region-host" :data-plugin-contribution="contribution.contributionKey">
    <div v-if="error" class="plugin-region-host__error" role="status">
      {{ contribution.title }} unavailable
    </div>
  </div>
</template>

<style scoped>
.plugin-region-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.plugin-region-host__error {
  align-items: center;
  color: var(--text-muted, #8b949e);
  display: flex;
  height: 100%;
  justify-content: center;
  padding: 1rem;
}
</style>
