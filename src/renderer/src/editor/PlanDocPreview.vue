<script setup lang="ts">
// Interactive preview for `.agent-team/plans/*.html` plan documents (plan
// window only — the mini-IDE's FilePreviewPane is untouched). Reads the file,
// injects the render-time runtime (planRuntime.ts), and renders via a
// `srcdoc` iframe sandboxed to `allow-scripts` (no same-origin). Frame
// messages are validated against the whitelist protocol before being emitted
// to the host; writes always go through the review toolbar's write path.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseHtmlPlanMeta } from '../composables/usePlanHtml'
import type { useBackend } from '../composables/useBackend'
import {
  createPlanRuntimeMessageHandler,
  extractPlanOutline,
  preparePlanDocHtml,
} from './planRuntime'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
  /** Bumped by the host after a meta write; triggers an in-place reload. */
  refresh: number
}>()

const emit = defineEmits<{
  (e: 'todo-clicked', payload: { todoId: string; alt: boolean }): void
  (e: 'section-comment', anchor: string): void
  (e: 'open-code', payload: { path: string; line: number }): void
  (e: 'section-edit', payload: { anchor: string; html: string }): void
  (e: 'section-delete', anchor: string): void
}>()

const { t } = useI18n()

const frame = ref<HTMLIFrameElement | null>(null)
const docHtml = ref('')
const loadError = ref(false)
// Backend's own reason ("not a file", "path escapes workspace", a WS timeout…).
// Shown verbatim next to the generic message: without it every cause — most
// often a plan written under a different workspace root — looks identical.
const loadErrorDetail = ref('')
// True while the frame reports an in-progress inline section edit; the host
// (PlanWindowApp) checks this so ESC cancels the edit before closing the window.
const editing = ref(false)
// Last position reported by the runtime; re-injected on reload so a meta
// write does not jump the document back to the top.
const scrollY = ref(0)

let todoIds: string[] = []
let anchors: string[] = []

function setLoadError(reason: unknown): void {
  loadError.value = true
  loadErrorDetail.value =
    reason instanceof Error ? reason.message : String(reason ?? '').trim()
}

async function loadDoc(): Promise<void> {
  // A reload (external plans.changed / meta write) swaps in a fresh iframe whose
  // runtime never sends section-editing:false, so clear stale edit state here —
  // otherwise `editing` sticks true and ESC keeps calling cancelEdit() instead
  // of closing the window.
  editing.value = false
  try {
    const resp = await props.backend.send<{ ok: boolean; content?: string; error?: string }>(
      'fs.read_file',
      { workspace_path: props.workspacePath, rel_path: props.relPath },
    )
    if (!resp.payload?.ok || resp.payload.content === undefined) {
      setLoadError(resp.payload?.error)
      return
    }
    const content = resp.payload.content
    const meta = parseHtmlPlanMeta(content)?.meta ?? null
    todoIds = meta?.todos.map((todo) => todo.id) ?? []
    anchors = extractPlanOutline(content)
    const counts: Record<string, number> = {}
    for (const note of meta?.reviewNotes ?? []) {
      if (!note.resolved && note.anchor) counts[note.anchor] = (counts[note.anchor] ?? 0) + 1
    }
    docHtml.value = preparePlanDocHtml(content, {
      anchors: counts,
      commentLabel: t('pane.plans.doc-comment'),
      editLabel: t('pane.plans.edit'),
      deleteLabel: t('pane.plans.delete'),
      saveLabel: t('pane.plans.save'),
      cancelLabel: t('pane.plans.cancel'),
      scrollY: scrollY.value,
    })
    loadError.value = false
    loadErrorDetail.value = ''
  } catch (err) {
    setLoadError(err)
  }
}

const onMessage = createPlanRuntimeMessageHandler({
  getSourceWindow: () => frame.value?.contentWindow,
  getTodoIds: () => todoIds,
  getAnchors: () => anchors,
  onTodoClicked: (todoId, alt) => emit('todo-clicked', { todoId, alt }),
  onSectionComment: (anchor) => emit('section-comment', anchor),
  onOpenCode: (path, line) => emit('open-code', { path, line }),
  onSectionEdit: (anchor, html) => emit('section-edit', { anchor, html }),
  onSectionDelete: (anchor) => emit('section-delete', anchor),
  onSectionEditing: (active) => {
    editing.value = active
  },
  onScrollPos: (y) => {
    scrollY.value = y
  },
})

onMounted(() => {
  window.addEventListener('message', onMessage)
  void loadDoc()
})
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

watch(
  () => props.refresh,
  () => {
    void loadDoc()
  },
)

/** Outline navigation: ask the runtime to scroll to an anchored heading. */
function scrollToAnchor(anchor: string): void {
  frame.value?.contentWindow?.postMessage({ type: 'scroll-to', anchor }, '*')
}

/** ESC overlay support: whether an inline section edit is in progress. */
function isEditing(): boolean {
  return editing.value
}

/** Ask the frame to cancel an in-progress inline section edit. */
function cancelEdit(): void {
  frame.value?.contentWindow?.postMessage({ type: 'cancel-edit' }, '*')
}

defineExpose({ scrollToAnchor, isEditing, cancelEdit })
</script>

<template>
  <div class="pdp">
    <div v-if="loadError" class="pdp-error">
      <span>{{ t('pane.plans.doc-load-failed') }}</span>
      <span v-if="loadErrorDetail" class="pdp-error-reason">{{ loadErrorDetail }}</span>
      <span class="pdp-error-path">{{ workspacePath }} › {{ relPath }}</span>
    </div>
    <!-- allow-scripts only (no same-origin): the frame stays an opaque origin;
         the injected CSP additionally confines the document itself. -->
    <iframe
      v-else
      ref="frame"
      class="pdp-frame"
      sandbox="allow-scripts"
      :srcdoc="docHtml"
      :title="relPath"
    />
  </div>
</template>

<style scoped>
.pdp {
  display: flex;
  min-height: 0;
}

/* White base like FilePreviewPane's HTML frame: documents without their own
   background stay readable when the app theme is dark. */
.pdp-frame {
  background: #fff;
  border: none;
  flex: 1;
  height: 100%;
  width: 100%;
}

.pdp-error {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  flex: 1;
  flex-direction: column;
  font-size: 13px;
  gap: 6px;
  justify-content: center;
  padding: 0 16px;
  text-align: center;
}

/* The backend's raw reason and the exact path it was resolved against —
   diagnostic detail, deliberately quieter than the message above. */
.pdp-error-reason,
.pdp-error-path {
  font-size: 12px;
  opacity: 0.75;
  overflow-wrap: anywhere;
}

.pdp-error-path {
  font-family: var(--font-mono, monospace);
}
</style>
