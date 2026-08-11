<script setup lang="ts">
// Main-window Plans tab (sidebar): a browse-only plan list. Clicking a plan no
// longer drills down in place — it pops out the wide plan review window
// (PlanWindowApp) and auto-opens that plan. One window per workspace: an
// already-open window is focused and switched to the newly clicked plan. The
// list self-refreshes on the backend's plans.changed broadcast (owned by
// PlansPane), and PlansPane handles its own delete/rename/context-menu.
import { onMounted, onUnmounted, ref } from 'vue'
import { useBackend } from '../composables/useBackend'
import PlansPane from './PlansPane.vue'

const { workspacePath } = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
}>()

const plansPaneRef = ref<InstanceType<typeof PlansPane> | null>(null)

// Open the clicked plan in the detached wide plan window. `root` is the project
// root the rel_path is relative to — the workspace itself unless it is a
// subdirectory of the repository the plans live in, in which case the window
// would resolve the path against the wrong base.
function openInWindow(relPath: string, root: string): void {
  void window.agentTeam?.openPlansWindow({
    workspace_path: root || workspacePath,
    rel_path: relPath,
  })
}

// ESC closes the plan list's own context menu / rename overlay when open. This
// only ever acts on Escape, so it does not fight ControlPane's Cmd+number
// sidebar-tab shortcuts, and it never closes a window (this is an embedded pane).
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (plansPaneRef.value?.closeActiveOverlay?.()) event.preventDefault()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onUnmounted(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <PlansPane
    ref="plansPaneRef"
    class="plan-pane"
    :workspace-path="workspacePath"
    :backend="backend"
    @open-file="(payload) => openInWindow(payload.filepath, payload.root)"
  />
</template>

<style scoped>
.plan-pane {
  height: 100%;
}
</style>
