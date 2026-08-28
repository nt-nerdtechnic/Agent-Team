<script setup lang="ts">
// An in-window plugin contribution, carried by an Electron <webview>.
//
// It used to be a native WebContentsView positioned from measured DOM bounds.
// That composites above the whole document, so a modal could never cover a
// plugin panel, and geometry had to be mirrored by hand (bounds, host resize,
// zoom factor). As a guest in this document the panel is laid out and stacked
// by CSS like anything else.
//
// Identity stays with the Host: prepareContribution returns only a URL holding
// a one-time token, and main overrides the guest's webPreferences on attach.
// Measured, not assumed: `display: none` keeps a guest's webContents alive and
// running, which is what lets a hidden Git tab keep its changes badge current.
import { onBeforeUnmount, ref, watch } from 'vue'

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
  /** Retained for call-site compatibility. A guest is created as soon as the
   *  element renders, so an in-window contribution is always warm. */
  prewarm?: boolean
}>()

const src = ref<string | null>(null)
const error = ref<string | null>(null)
let generation = 0

async function prepare(): Promise<void> {
  const mine = ++generation
  src.value = null
  error.value = null
  if (!props.workspacePath) return
  try {
    const result = await window.agentTeam?.plugins?.prepareContribution({
      contributionKey: props.contribution.contributionKey,
      workspace_path: props.workspacePath,
    })
    // A workspace change or unmount may have overtaken this request.
    if (mine !== generation) return
    if (!result?.ok || !result.url) {
      error.value = result?.error ?? 'plugin contribution could not be prepared'
      return
    }
    src.value = result.url
  } catch (cause) {
    if (mine !== generation) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

watch(
  () => [props.workspacePath, props.contribution.contributionKey] as const,
  () => void prepare(),
  { immediate: true }
)

onBeforeUnmount(() => {
  // Removing the element destroys the guest; this only clears the Host-side
  // registry entry so the next mount starts clean.
  generation += 1
  void window.agentTeam?.plugins?.closeContribution({
    contributionKey: props.contribution.contributionKey,
  })
})
</script>

<template>
  <div
    v-show="visible"
    class="plugin-region-host"
    :data-plugin-contribution="contribution.contributionKey"
  >
    <div v-if="error" class="plugin-region-host__error" role="status">
      {{ contribution.title }} unavailable
    </div>
    <webview v-else-if="src" class="plugin-region-host__view" :src="src" />
  </div>
</template>

<style scoped>
.plugin-region-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.plugin-region-host__view {
  display: flex;
  width: 100%;
  height: 100%;
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
