<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useBackend } from './capabilityBackend'
import MultiRepoGit from './components/MultiRepoGit.vue'
import type { GitSurfacePorts } from './ports/gitSurface'
import type { GitContributionState } from './ports/gitContribution'
import type { PluginGitContributionHostPort } from './pluginSurfacePorts'

const props = defineProps<{
  surfacePorts: GitSurfacePorts
  hostPort: PluginGitContributionHostPort
}>()

const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
const backend = useBackend()
const state = ref<GitContributionState>({
  workspacePath,
  analyzerModel: '',
  dispatchTargets: [],
  availableAgents: [],
  issueHandoffs: {},
})
let stopState: (() => void) | null = null

function applyState(next: GitContributionState): void {
  if (next.workspacePath === workspacePath) state.value = next
}

onMounted(async () => {
  const initial = await props.hostPort.getState().catch(() => null)
  if (initial) applyState(initial)
  stopState = props.hostPort.onStateChanged(applyState)
})

onUnmounted(() => {
  stopState?.()
  stopState = null
})

async function dispatch(action: Parameters<PluginGitContributionHostPort['dispatch']>[0]): Promise<void> {
  try { await props.hostPort.dispatch(action) } catch { /* Host action failures are scoped and fail closed. */ }
}
</script>

<template>
  <MultiRepoGit
    :workspace-path="workspacePath"
    :backend="backend"
    :surface-ports="surfacePorts"
    :analyzer-model="state.analyzerModel"
    :dispatch-targets="state.dispatchTargets"
    :available-agents="state.availableAgents"
    :issue-handoffs="state.issueHandoffs"
    @changes-count="dispatch({ operation: 'changes_count', count: $event })"
    @open-workspace="dispatch({ operation: 'open_workspace', path: $event })"
    @open-file="dispatch({ operation: 'open_file', payload: $event })"
    @open-conflict="dispatch({ operation: 'open_conflict', payload: $event })"
    @open-diff="dispatch({ operation: 'open_diff', payload: $event })"
    @open-branch-diff="dispatch({ operation: 'open_branch_diff', payload: $event })"
    @dispatch-issue="dispatch({ operation: 'dispatch_issue', payload: $event })"
    @spawn-for-issue="dispatch({ operation: 'spawn_for_issue', payload: $event })"
    @focus-pane="dispatch({ operation: 'focus_pane', paneId: $event })"
    @open-git-accounts="dispatch({ operation: 'open_git_accounts' })"
  />
</template>
