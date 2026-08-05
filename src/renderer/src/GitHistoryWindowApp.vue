<script setup lang="ts">
// Git History window (?window=githistory&workspace_path=…): the full-history
// dialog promoted to a standalone BrowserWindow, mirroring the plan window
// pattern. Owns its own backend connection and useGit instance (log loading is
// driven by useGit's workspace/ws-connected watchers); GitHistoryModal renders
// in standalone mode so it fills the window, and closing it closes the window.
import { onMounted, onUnmounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { initSettingsBackend, onSettingsChanged } from './lib/settings'
import { useTheme } from './composables/useTheme'
import { useGit } from './composables/useGit'
import GitHistoryModal from './components/GitHistoryModal.vue'
import NotificationHost from './components/NotificationHost.vue'

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const workspaceBaseName = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath

const backend = useBackend()
// Hook the settings cache to this window's own ws connection so theme changes
// made in other windows arrive as ui.settings_changed broadcasts.
initSettingsBackend(backend)
const { loadTheme } = useTheme()

const {
  gitLog,
  logScope,
  logOrder,
  isLoadingLog,
  canLoadMoreLog,
  setLogScope,
  setLogOrder,
  loadMoreLog,
  logSearch,
  showCommit,
  commitFileDiff,
  cherryPick,
  revertCommit,
  checkoutCommit,
  createBranch,
  createTag,
  mergeBranch,
  resetToCommit
} = useGit(() => workspacePath, backend)

function closeWindow(): void {
  window.close()
}

let offThemeSettingsChange: (() => void) | null = null

onMounted(() => {
  document.title = `${workspaceBaseName} — Git History`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
  })
})
onUnmounted(() => {
  offThemeSettingsChange?.()
})
</script>

<template>
  <GitHistoryModal
    show
    standalone
    :backend="backend"
    :workspace-path="workspacePath"
    :git-log="gitLog"
    :log-scope="logScope"
    :log-order="logOrder"
    :is-loading-log="isLoadingLog"
    :can-load-more-log="canLoadMoreLog"
    :set-log-scope="setLogScope"
    :set-log-order="setLogOrder"
    :load-more-log="loadMoreLog"
    :log-search="logSearch"
    :show-commit="showCommit"
    :commit-file-diff="commitFileDiff"
    :cherry-pick="cherryPick"
    :revert-commit="revertCommit"
    :checkout-commit="checkoutCommit"
    :create-branch="createBranch"
    :create-tag="createTag"
    :merge-into-current="mergeBranch"
    :reset-to-commit="resetToCommit"
    @close="closeWindow"
  />
  <NotificationHost />
</template>
