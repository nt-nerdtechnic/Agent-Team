<script setup lang="ts">
// AiChatDock — the shared right-side AI chat shell used by the editor, plan,
// and git windows. Encapsulates the activity-rail toggle button, the resize
// handle (width clamped 280–600, persisted per-window via `widthKey`), and the
// lazily mounted AIChatPane: the heavy chunk (mermaid/katex) loads on first
// open (v-if), then the instance is kept alive via v-show so chat state
// (threads, streaming) survives toggling the panel closed.
//
// Layout contract: renders three siblings (rail / resize handle / panel) meant
// to sit at the END of a row-flex container — exactly how the three windows
// previously inlined the shell.
//
// Open state is a `v-model:open`-able model so hosts (EditorWindowApp's
// commands, ask-ai actions) can open/toggle it externally; hosts that never
// bind it get self-contained toggle behavior. The inner AIChatPane instance is
// exposed as `pane` for hosts that call its imperative API (addContextChip /
// injectDraft / focusInput).
import { defineAsyncComponent, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { settingsGet, settingsSet } from '../lib/settings'
import type { useBackend } from '../composables/useBackend'
// `import type` keeps the ref fully typed with no runtime/bundle cost; the
// component itself stays async so the dock never drags the pane's heavy static
// deps into the host window's first paint.
import type AIChatPaneType from './AIChatPane.vue'
const AIChatPane = defineAsyncComponent(() => import('./AIChatPane.vue'))

const props = withDefaults(
  defineProps<{
    /** Settings key persisting this window's panel width (per-window). */
    widthKey: string
    workspacePath: string
    backend: ReturnType<typeof useBackend>
    /** Initial width when no persisted value exists yet. */
    defaultWidth?: number
    /** i18n key for the rail button tooltip (hosts with a shortcut hint override this). */
    titleKey?: string
    // Optional editor bridge callbacks, passed through to AIChatPane verbatim.
    getEditorContent?: () => string
    getEditorSelection?: () => string
    getActiveRelPath?: () => string
    getOpenFiles?: () => string[]
    insertTextAtCursor?: (text: string) => void
    openFile?: (relPath: string, line?: number) => void
    saveDirtyFiles?: () => Promise<void>
  }>(),
  { defaultWidth: 360, titleKey: 'pane.ai-chat.title' }
)

const { t } = useI18n()

const open = defineModel<boolean>('open', { default: false })
// Mounted lazily on first open, then kept alive via v-show (see header note).
const paneMounted = ref(false)
watch(open, (v) => { if (v) paneMounted.value = true }, { immediate: true })

function toggle(): void {
  open.value = !open.value
}

function clampWidth(w: number): number {
  return Math.max(280, Math.min(600, w))
}
const width = ref(clampWidth(parseInt(settingsGet(props.widthKey, String(props.defaultWidth)), 10)))
let resizing = false
function onResizeStart(): void {
  resizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
}
function onResizeMove(e: MouseEvent): void {
  if (!resizing) return
  width.value = clampWidth(window.innerWidth - e.clientX)
}
function onResizeEnd(): void {
  if (!resizing) return
  resizing = false
  settingsSet(props.widthKey, String(width.value))
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
})

const pane = ref<InstanceType<typeof AIChatPaneType> | null>(null)
defineExpose({ pane, toggle })
</script>

<template>
  <!-- Activity rail (AI Chat toggle) -->
  <div class="ai-dock-rail">
    <button
      class="ai-dock-rail-btn"
      :class="{ active: open }"
      :title="t(titleKey)"
      @click="toggle"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
      </svg>
    </button>
  </div>
  <div v-show="open" class="ai-dock-resize-handle" @mousedown.prevent="onResizeStart" />
  <div v-show="open" class="ai-dock-panel" :style="{ width: width + 'px' }">
    <AIChatPane
      v-if="paneMounted"
      ref="pane"
      :workspace-path="workspacePath"
      :backend="backend"
      embedded
      :active="open"
      :get-editor-content="getEditorContent"
      :get-editor-selection="getEditorSelection"
      :get-active-rel-path="getActiveRelPath"
      :get-open-files="getOpenFiles"
      :insert-text-at-cursor="insertTextAtCursor"
      :open-file="openFile"
      :save-dirty-files="saveDirtyFiles"
    />
  </div>
</template>

<style scoped>
.ai-dock-rail {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}

.ai-dock-rail-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}

.ai-dock-rail-btn:hover {
  color: var(--text-bright);
}

.ai-dock-rail-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.ai-dock-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}

.ai-dock-resize-handle:hover {
  background: var(--accent-emphasis);
}

.ai-dock-panel {
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}
</style>
