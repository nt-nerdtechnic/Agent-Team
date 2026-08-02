<script setup lang="ts">
// Plan review window (?window=plans&workspace_path=…): plan list on the left,
// the opened plan document on the right. Plan docs stack the shared review
// toolbar (PlanReviewToolbar, format-agnostic via PlanStore) above a body that
// switches on format: HTML plans render in the interactive srcdoc preview
// (PlanDocPreview, render-time injected runtime); markdown plans render in
// PlanMarkdownBody. Other HTML docs keep the plain sandboxed FilePreviewPane;
// plain markdown (no frontmatter meta) falls back to the read-only PlanFileView.
// Plans only — no file tree, terminal, or git.
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from './composables/useBackend'
import { initSettingsBackend, onSettingsChanged, settingsGet, settingsSet } from './lib/settings'
import { useTheme } from './composables/useTheme'
import { useNotify } from './composables/useNotify'
import { resolvePlanStore, type PlanCtx, type WriteResult } from './composables/planStore'
import { sanitizePlanSectionHtml } from './editor/planRuntime'
import PlansPane from './editor/PlansPane.vue'
import PlanReviewToolbar from './editor/PlanReviewToolbar.vue'
import PlanFileView from './editor/PlanFileView.vue'
import PlanMarkdownBody from './editor/PlanMarkdownBody.vue'
import FilePreviewPane from './editor/FilePreviewPane.vue'
import PlanDocPreview from './editor/PlanDocPreview.vue'
import NotificationHost from './components/NotificationHost.vue'
// Lazy-loaded: AIChatPane statically pulls mermaid + katex (heavy). The async
// chunk is only fetched when the panel is first opened (v-if below), keeping
// the plan window's first paint unaffected.
const AIChatPane = defineAsyncComponent(() => import('./components/AIChatPane.vue'))

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const workspaceBaseName = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
// Plan to auto-open on mount: the sidebar list clicked a plan, which opened
// this window with the plan carried in the query string.
const initialRelPath = params.get('rel_path') ?? ''

const backend = useBackend()
// Hook the settings cache to this window's own ws connection so theme changes
// made in other windows arrive as ui.settings_changed broadcasts.
initSettingsBackend(backend)
const { loadTheme } = useTheme()
const { t } = useI18n()
const { toast, confirm } = useNotify()

// ── AI Chat panel (right) ─────────────────────────────────────────────────────
const AI_PANEL_W_KEY = 'plan-ai-panel-width'
const aiPanelOpen = ref(false)
// Mounted lazily on first open, then kept alive via v-show so the chat state
// (threads, streaming) survives toggling the panel closed.
const aiPanelMounted = ref(false)
const aiPanelWidth = ref(Math.max(280, Math.min(600, parseInt(settingsGet(AI_PANEL_W_KEY, '360'), 10))))
let aiResizing = false
function toggleAiPanel(): void {
  aiPanelOpen.value = !aiPanelOpen.value
  if (aiPanelOpen.value) aiPanelMounted.value = true
}
function onAiResizeStart(): void {
  aiResizing = true
  document.addEventListener('mousemove', onAiResizeMove)
  document.addEventListener('mouseup', onAiResizeEnd)
}
function onAiResizeMove(e: MouseEvent): void {
  if (!aiResizing) return
  aiPanelWidth.value = Math.max(280, Math.min(600, window.innerWidth - e.clientX))
}
function onAiResizeEnd(): void {
  if (!aiResizing) return
  aiResizing = false
  settingsSet(AI_PANEL_W_KEY, String(aiPanelWidth.value))
  document.removeEventListener('mousemove', onAiResizeMove)
  document.removeEventListener('mouseup', onAiResizeEnd)
}

const openDoc = ref<{ relPath: string; name: string } | null>(null)
// Read-only history snapshot shown instead of the live plan (Phase C); the
// snapshot preview renders without a toolbar and ignores write interactions.
const snapshotPreview = ref<{ relPath: string; label: string } | null>(null)

// Reviewable plan doc: top-level, non-infrastructure `.agent-team/plans/*.html`.
function isHtmlPlanDoc(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  if (!normalized.startsWith('.agent-team/plans/')) return false
  const name = normalized.slice('.agent-team/plans/'.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

// Bumped after a plan-meta write; PlanDocPreview reloads in place (keeping
// the reported scroll position) instead of remounting.
const planPreviewRefresh = ref(0)

// Format-agnostic persistence adapter for the open doc; the review toolbar and
// the body write-back below both go through it instead of the backend directly.
// `.html` plans resolve to the HTML store (the only branch that mounts the
// toolbar / interactive preview in this stage).
const planStore = computed(() => resolvePlanStore(openDoc.value?.relPath ?? ''))

const toolbarRef = ref<InstanceType<typeof PlanReviewToolbar> | null>(null)
const previewRef = ref<InstanceType<typeof PlanDocPreview> | null>(null)
const mdBodyRef = ref<InstanceType<typeof PlanMarkdownBody> | null>(null)
const plansPaneRef = ref<InstanceType<typeof PlansPane> | null>(null)

// For an open markdown doc: 'loading' while probing frontmatter, then 'plan'
// (carries valid plan meta → shared review toolbar + PlanMarkdownBody) or 'doc'
// (plain markdown with no meta → legacy read-only PlanFileView, no toolbar).
// HTML docs route by path (isHtmlPlanDoc) and never consult this.
const mdKind = ref<'loading' | 'plan' | 'doc'>('loading')

function isMarkdownDoc(relPath: string): boolean {
  return !relPath.endsWith('.html')
}

// Probe the markdown doc's meta once per open: a valid frontmatter plan mounts
// the toolbar, a plain markdown file stays a read-only doc. Re-probing is not
// needed on live refresh — a plain .md does not gain frontmatter from in-window
// actions, and legacy .plan.md already carry frontmatter from the first read.
async function probeMarkdownKind(relPath: string): Promise<void> {
  mdKind.value = 'loading'
  const result = await resolvePlanStore(relPath).readMeta(planCtx(relPath))
  if (openDoc.value?.relPath !== relPath) return // superseded by a newer open
  mdKind.value = result ? 'plan' : 'doc'
}

function onOpenFile(payload: { filepath: string; name: string }): void {
  openDoc.value = { relPath: payload.filepath, name: payload.name }
  snapshotPreview.value = null
  if (isMarkdownDoc(payload.filepath)) void probeMarkdownKind(payload.filepath)
}

// Open a plan by its workspace-relative path (auto-open on mount, or when an
// already-open window is asked to switch plans via the plan:open-doc IPC).
function openRelPath(relPath: string): void {
  if (!relPath) return
  onOpenFile({ filepath: relPath, name: relPath.split('/').pop() ?? relPath })
}

// A plan deleted from the list clears the right pane when it's the open one.
function onPlanDeleted(relPath: string): void {
  if (openDoc.value?.relPath === relPath) {
    openDoc.value = null
    snapshotPreview.value = null
  }
}

function onPreviewSnapshot(payload: { relPath: string; label: string }): void {
  snapshotPreview.value = payload
}

function closeSnapshotPreview(): void {
  snapshotPreview.value = null
}

// file:line references clicked inside the plan document (validated by the
// runtime protocol) open the editor window at that line.
type AgentApi = { openEditorWindow?: (a: Record<string, unknown>) => Promise<unknown> }
function onOpenCode(payload: { path: string; line: number }): void {
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  void api.openEditorWindow({
    workspace_path: workspacePath,
    filepath: payload.path,
    line: payload.line,
  })
}

// In-document interactions, already validated by PlanDocPreview against the
// whitelist protocol, are routed through the toolbar's existing write paths.
function onDocTodoClicked(payload: { todoId: string; alt: boolean }): void {
  const toolbar = toolbarRef.value
  if (!toolbar) return
  if (payload.alt) void toolbar.toggleSkipTodo(payload.todoId)
  else void toolbar.cycleTodo(payload.todoId)
}

function onDocSectionComment(anchor: string): void {
  toolbarRef.value?.startNoteWithAnchor(anchor)
}

// Only one body is mounted per doc (HTML preview or markdown body); scrolling
// the null one is a no-op, so route the toolbar's outline pick to both.
function onOutlineScroll(anchor: string): void {
  previewRef.value?.scrollToAnchor(anchor)
  mdBodyRef.value?.scrollToAnchor(anchor)
}

// Body write-back for inline section edit/delete now goes through the store's
// replaceSectionBody / deleteSection, which mirror the toolbar's optimistic
// lock (re-read fresh content + mtime, apply the byte-surgical mutation to the
// fresh bytes preserving concurrent agent edits, write with expected_mtime,
// retry once on a conflict; a mutation that leaves the content unchanged is a
// silent no-op success). The host still sanitizes untrusted frame HTML first.
function planCtx(relPath: string): PlanCtx {
  return { backend, workspacePath, relPath }
}

function applyBodyWriteResult(result: WriteResult): void {
  if (result.ok) {
    planPreviewRefresh.value++
    return
  }
  if (result.conflict) {
    toast(t('pane.plans.review-save-failed'))
    return
  }
  toast(result.error ?? t('pane.plans.review-save-failed'))
}

// Inline section edit: sanitize the untrusted frame HTML host-side, then
// replace only that section's prose body (never plan-meta/header/todos).
async function onSectionEdit(payload: { anchor: string; html: string }): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const sanitized = sanitizePlanSectionHtml(payload.html)
  const result = await planStore.value.replaceSectionBody(planCtx(relPath), payload.anchor, {
    kind: 'html',
    sanitized,
  })
  applyBodyWriteResult(result)
}

async function onSectionDelete(anchor: string): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const ok = await confirm(t('pane.plans.doc-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  const result = await planStore.value.deleteSection(planCtx(relPath), anchor)
  applyBodyWriteResult(result)
}

// ESC overlay priority: cancel/close the innermost active overlay before
// falling through to closing the window. Order: an in-frame section edit
// (when focus is outside the frame — inside it the runtime handles ESC
// itself), then the plan list's context menu / rename input, then an unsent
// review note, then a read-only snapshot; otherwise close the window.
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (previewRef.value?.isEditing?.()) {
    previewRef.value.cancelEdit()
    event.preventDefault()
    return
  }
  // Markdown body's inline section edit — same priority as the HTML preview's
  // in-frame edit (only one body is ever mounted).
  if (mdBodyRef.value?.isEditing?.()) {
    mdBodyRef.value.cancelEdit()
    event.preventDefault()
    return
  }
  if (plansPaneRef.value?.closeActiveOverlay?.()) {
    event.preventDefault()
    return
  }
  if (toolbarRef.value?.closeActiveOverlay?.()) {
    event.preventDefault()
    return
  }
  if (snapshotPreview.value) {
    closeSnapshotPreview()
    event.preventDefault()
    return
  }
  event.preventDefault()
  window.close()
}

let offThemeSettingsChange: (() => void) | null = null
let offPlansChanged: (() => void) | null = null
let offPlanOpenDoc: (() => void) | null = null

onMounted(() => {
  document.title = `Plans · ${workspaceBaseName}`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
  })
  // Live refresh: a plan changed on disk (any writer) — reload the open
  // preview in place so the scroll position is preserved.
  offPlansChanged = backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    if (p && p.workspace_path === workspacePath) planPreviewRefresh.value++
  })
  window.addEventListener('keydown', onWindowKeydown)
  // Auto-open the plan this window was launched for.
  openRelPath(initialRelPath)
  // While the window stays open, the sidebar clicking another plan focuses this
  // window and asks it to switch (no reopen).
  offPlanOpenDoc = window.agentTeam?.onPlanOpenDoc?.((relPath) => openRelPath(relPath)) ?? null
})
onUnmounted(() => {
  offThemeSettingsChange?.()
  offPlansChanged?.()
  offPlanOpenDoc?.()
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="plan-window">
    <aside class="plan-window-side">
      <PlansPane ref="plansPaneRef" :workspace-path="workspacePath" :backend="backend" @open-file="onOpenFile" @deleted="onPlanDeleted" />
    </aside>
    <main class="plan-window-main">
      <template v-if="openDoc">
        <div v-if="openDoc.relPath.endsWith('.html')" class="plan-window-doc">
          <template v-if="isHtmlPlanDoc(openDoc.relPath)">
            <!-- Read-only snapshot view: no toolbar, write interactions ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanDocPreview
                :key="snapshotPreview.relPath"
                :workspace-path="workspacePath"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :refresh="0"
                @open-code="onOpenCode"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :store="planStore"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
              />
              <PlanDocPreview
                ref="previewRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @todo-clicked="onDocTodoClicked"
                @section-comment="onDocSectionComment"
                @section-edit="onSectionEdit"
                @section-delete="onSectionDelete"
                @open-code="onOpenCode"
              />
            </template>
          </template>
          <FilePreviewPane
            v-else
            :key="openDoc.relPath"
            :workspace-path="workspacePath"
            :rel-path="openDoc.relPath"
            :name="openDoc.name"
            :backend="backend"
          />
        </div>
        <!-- Markdown plan: the shared review toolbar + PlanMarkdownBody when the
             file carries valid frontmatter meta; plain markdown (no meta) keeps
             the legacy read-only PlanFileView with no meta-driven toolbar. -->
        <template v-else>
          <div v-if="mdKind === 'plan'" class="plan-window-doc">
            <!-- Read-only markdown snapshot view: no toolbar, edits ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanFileView
                :key="snapshotPreview.relPath"
                :workspace-path="workspacePath"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :readonly="true"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :store="planStore"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
              />
              <PlanMarkdownBody
                ref="mdBodyRef"
                :key="openDoc.relPath"
                :workspace-path="workspacePath"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @updated="planPreviewRefresh++"
              />
            </template>
          </div>
          <PlanFileView
            v-else-if="mdKind === 'doc'"
            :key="openDoc.relPath"
            :workspace-path="workspacePath"
            :rel-path="openDoc.relPath"
            :backend="backend"
          />
          <div v-else class="plan-window-doc" />
        </template>
      </template>
      <div v-else class="plan-window-empty">{{ t('pane.plans.window-empty') }}</div>
    </main>
    <!-- Right activity rail (AI Chat toggle) -->
    <div class="plan-right-act">
      <button
        class="plan-right-act-btn"
        :class="{ active: aiPanelOpen }"
        :title="t('pane.ai-chat.title')"
        @click="toggleAiPanel"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
        </svg>
      </button>
    </div>
    <!-- AI Chat panel (right): embedded chat bound to this window's workspace -->
    <div v-show="aiPanelOpen" class="plan-ai-resize-handle" @mousedown.prevent="onAiResizeStart" />
    <div v-show="aiPanelOpen" class="plan-ai-panel" :style="{ width: aiPanelWidth + 'px' }">
      <AIChatPane
        v-if="aiPanelMounted"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        :active="aiPanelOpen"
      />
    </div>
    <NotificationHost />
  </div>
</template>

<style scoped>
.plan-window {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.plan-window-side {
  border-right: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow: hidden;
  width: 300px;
}

.plan-window-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Every direct child (doc stack, markdown view, empty state) fills the pane. */
.plan-window-main > * {
  flex: 1 1 0;
  min-height: 0;
}

.plan-window-doc {
  display: flex;
  flex-direction: column;
}

/* Same stretch rule as the editor's .ide-preview-stack: the preview pane
   (last child, below the optional toolbar) takes all remaining height. */
.plan-window-doc > :last-child {
  flex: 1 1 0;
  min-height: 0;
}

.plan-snapshot-banner {
  align-items: center;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  flex-shrink: 0;
  font-size: 12px;
  gap: 10px;
  padding: 6px 12px;
}

.plan-snapshot-label {
  font-weight: 650;
}

.plan-snapshot-note {
  color: var(--text-muted);
  flex: 1;
  font-size: 11px;
}

.plan-snapshot-close {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 11px;
  padding: 3px 10px;
}

.plan-snapshot-close:hover {
  background: var(--bg-hover-strong);
}

.plan-window-empty {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: 13px;
  justify-content: center;
}

/* ── AI Chat panel (right) ────────────────────────────────────────────────── */
.plan-right-act {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}

.plan-right-act-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}

.plan-right-act-btn:hover {
  color: var(--text-bright);
}

.plan-right-act-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.plan-ai-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}

.plan-ai-resize-handle:hover {
  background: var(--accent-emphasis);
}

.plan-ai-panel {
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}
</style>

<!-- Global reset (non-scoped): scoped styles cannot target html/body/#app, so
     without this the window's dark backgroundColor shows through body's default
     8px margin as a thick frame around the content (App.vue/EditorWindowApp do
     the same reset for their windows). -->
<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
</style>
