<script setup lang="ts">
// Minimal terminal host for embedded CLI agent panels (AiCliDock).
// Deliberately a slim wrapper over useTerminal instead of reusing
// TerminalPane: this panel needs tryReattach/pasteText (not in TerminalPane's
// expose) and none of its header chrome (loop/rebuild/drag/minimize). All
// xterm, scrollback, UTF-8 and resize behavior stays inside useTerminal.
import { onMounted, ref, watch } from 'vue'
import { useTerminal } from '@navide/terminal'
import { useTheme } from '@navide/plugin-ui/foundation'
import type { MentionCandidate, TerminalDockPort } from '@navide/terminal'
import { agentProfileFor } from '../agentProfile'

const props = defineProps<{
  paneId: string
  terminalPort: TerminalDockPort
  workspacePath?: string
  /** Resolves the addresses offered by the @-mention menu, with the group and
   *  status words already translated by the host. A getter, called on the `@`
   *  keystroke rather than on every render — see TerminalPane's copy of this
   *  prop for why. */
  mentionCandidates?: (paneId: string) => MentionCandidate[]
}>()

const containerRef = ref<HTMLElement | null>(null)
const terminal = useTerminal(props.paneId, props.terminalPort, {
  workspacePath: props.workspacePath,
  mentionCandidates: () => props.mentionCandidates?.(props.paneId) ?? [],
  agentProfileFor,
})
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})

defineExpose({
  spawn: terminal.spawn,
  tryReattach: terminal.tryReattach,
  pasteText: terminal.pasteText,
  interrupt: terminal.interrupt,
  kill: terminal.kill,
  /** Cancel an in-flight terminal.create and return the pane to the Start UI.
   *  A bare cancelPendingCreate leaves status at 'starting' (its other callers
   *  respawn immediately); this panel instead goes back to idle. Writing the
   *  returned refs is sanctioned surface (cf. TerminalPane's setStopped). */
  cancelPendingCreate: async (): Promise<void> => {
    await terminal.cancelPendingCreate()
    terminal.status.value = 'idle'
    terminal.startingStartedAt.value = null
  },
  focus: terminal.focus,
  fitTerminal: terminal.fitTerminal,
  status: terminal.status,
  displayStatus: terminal.displayStatus,
  sessionId: terminal.sessionId,
  error: terminal.error,
  lastRawActivityAt: terminal.lastRawActivityAt,
})
</script>

<template>
  <div ref="containerRef" class="ai-cli-xterm-host" :data-pane-id="paneId"></div>
</template>

<style scoped>
.ai-cli-xterm-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  position: relative;
  background: var(--bg-base);
}
</style>
