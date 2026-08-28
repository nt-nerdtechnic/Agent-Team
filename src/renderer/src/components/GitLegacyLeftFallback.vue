<script setup lang="ts">
// Recovery-only compatibility adapter. Issue 31 owns removal of this adapter,
// the legacy Git source, and its build wiring; do not add new production call sites.
import MultiRepoGit from './MultiRepoGit.vue'
import type { Issue, IssueDetail, IssueHandlerMode, IssueProvider } from '../composables/useIssues'
import { createHostGitTransport } from '../composables/hostGitTransport'
import { createHostGitSurfacePorts } from '../composables/hostSurfacePorts'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  workspacePath: string
  visible: boolean
  backend: ReturnType<typeof useBackend>
  analyzerModel?: string
  dispatchTargets?: { id: string; label: string }[]
  availableAgents?: { key: string; label: string }[]
  issueHandoffs?: Record<string, { paneId: string; mode: string; state: string }>
}>()

const emit = defineEmits<{
  (e: 'changes-count', count: number): void
  (e: 'open-workspace', path: string): void
  (e: 'dispatch-issue', payload: { paneId: string; issue: IssueDetail }): void
  (e: 'spawn-for-issue', payload: { agentKey: string; mode: IssueHandlerMode; issue: Issue; provider: IssueProvider }): void
  (e: 'focus-pane', paneId: string): void
  (e: 'open-git-accounts'): void
}>()

const gitTransport = createHostGitTransport(props.backend)
const surfacePorts = createHostGitSurfacePorts(props.backend, gitTransport)
</script>

<template>
  <div v-show="visible" class="git-legacy-left-fallback">
    <MultiRepoGit
      :workspace-path="workspacePath"
      :backend="backend"
      :surface-ports="surfacePorts"
      :analyzer-model="analyzerModel"
      :dispatch-targets="dispatchTargets"
      :available-agents="availableAgents"
      :issue-handoffs="issueHandoffs"
      @changes-count="emit('changes-count', $event)"
      @open-workspace="emit('open-workspace', $event)"
      @dispatch-issue="emit('dispatch-issue', $event)"
      @spawn-for-issue="emit('spawn-for-issue', $event)"
      @focus-pane="emit('focus-pane', $event)"
      @open-git-accounts="emit('open-git-accounts')"
    />
  </div>
</template>

<style scoped>
.git-legacy-left-fallback {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
