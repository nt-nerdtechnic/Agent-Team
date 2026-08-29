<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import MultiRepoGit from './components/MultiRepoGit.vue'
import SettingsReadinessNotice from './components/SettingsReadinessNotice.vue'
import { onSettingsChanged, settingsGet, useKeybindings } from '@navide/plugin-ui/shared'
import { useTheme } from '@navide/plugin-ui/foundation'
import type { GitSurfacePorts, LegacyRepoSelectionPort } from './ports/gitSurface'
import { HOST_GIT_COMMAND_IDS, type GitContributionState } from './ports/gitContribution'
import type { PluginGitContributionHostPort } from './pluginSurfacePorts'

const props = defineProps<{
  surfacePorts: GitSurfacePorts
  hostPort: PluginGitContributionHostPort
  legacyRepoSelection: LegacyRepoSelectionPort
}>()

const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
const state = ref<GitContributionState>({
  workspacePath,
  analyzerModel: '',
  dispatchTargets: [],
  availableAgents: [],
  issueHandoffs: {},
})
const analyzerModel = ref(settingsGet('agentTeam.analyzerModel', ''))
let stopState: (() => void) | null = null
let stopSettings: (() => void) | null = null
const { registerCommand } = useKeybindings()

for (const command of HOST_GIT_COMMAND_IDS) {
  registerCommand(command, () => {
    void dispatch({ operation: 'execute_host_command', command })
  })
}

function applyState(next: GitContributionState): void {
  if (next.workspacePath === workspacePath) state.value = next
}

const { loadTheme } = useTheme()

onMounted(async () => {
  // mount.ts stamps data-theme once from the entry query so the first paint is
  // not a flash of the wrong theme. That snapshot goes stale the moment the
  // user switches theme, so adopt the store's value here and follow it after —
  // the same contract GitWindowApp keeps.
  loadTheme()
  const initial = await props.hostPort.getState().catch(() => null)
  if (initial) applyState(initial)
  stopState = props.hostPort.onStateChanged(applyState)
  stopSettings = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
    if (keys.includes('agentTeam.analyzerModel')) {
      analyzerModel.value = settingsGet('agentTeam.analyzerModel', '')
    }
  })
})

onUnmounted(() => {
  stopState?.()
  stopState = null
  stopSettings?.()
  stopSettings = null
})

async function dispatch(action: Parameters<PluginGitContributionHostPort['dispatch']>[0]): Promise<void> {
  try { await props.hostPort.dispatch(action) } catch { /* Host action failures are scoped and fail closed. */ }
}
</script>

<template>
  <div class="git-left-root">
    <SettingsReadinessNotice />
    <div class="git-left-content">
      <MultiRepoGit
        :workspace-path="workspacePath"
        :legacy-repo-selection="legacyRepoSelection"
        :surface-ports="surfacePorts"
        :analyzer-model="analyzerModel"
        :dispatch-targets="state.dispatchTargets"
        :available-agents="state.availableAgents"
        :issue-handoffs="state.issueHandoffs"
        @changes-count="dispatch({ operation: 'changes_count', count: $event })"
        @open-workspace="dispatch({ operation: 'open_workspace', path: $event.path, grant: $event.grant })"
        @open-file="dispatch({ operation: 'open_file', payload: $event })"
        @open-conflict="dispatch({ operation: 'open_conflict', payload: $event })"
        @open-diff="dispatch({ operation: 'open_diff', payload: $event })"
        @open-branch-diff="dispatch({ operation: 'open_branch_diff', payload: $event })"
        @dispatch-issue="dispatch({ operation: 'dispatch_issue', payload: $event })"
        @spawn-for-issue="dispatch({ operation: 'spawn_for_issue', payload: $event })"
        @focus-pane="dispatch({ operation: 'focus_pane', paneId: $event })"
        @open-git-accounts="dispatch({ operation: 'open_git_accounts' })"
      />
    </div>
  </div>
</template>

<style scoped>
.git-left-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
}

.git-left-content {
  /* The child pane fills this box with `flex: 1 1 0%`, which only takes
     effect when this element is itself a flex container. Without it the
     pane collapses to content height and everything below the first few
     sections is clipped away. */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
