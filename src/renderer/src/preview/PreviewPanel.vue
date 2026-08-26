<script setup lang="ts">
// Read-only preview host for the right rail. Owns the header, footer and empty
// state; every body is an existing component:
//   file     -> editor/FilePreviewPane (11 PreviewKinds, unchanged)
//   diff     -> editor/DiffPane in readonly mode
//   markdown -> ./MarkdownPreview (shared markdownRender + mermaid)
//   snippet  -> ./SnippetPreview
//   html     -> ./InlineHtmlPreview (sandbox="")
// Monaco is intentionally never loaded here: the rail is 180-520px wide, the
// panel is read-only, and pulling Monaco into the main window would cost every
// workspace window. "Open in editor" is the escape hatch instead.
import { computed, ref } from 'vue'
import { useNotify } from '../composables/useNotify'
import type { useBackend } from '../composables/useBackend'
import DiffPane from '../editor/DiffPane.vue'
import FilePreviewPane from '../editor/FilePreviewPane.vue'
import InlineHtmlPreview from './InlineHtmlPreview.vue'
import MarkdownPreview from './MarkdownPreview.vue'
import SnippetPreview from './SnippetPreview.vue'
import { previewSubtitle, previewTitle, type PreviewTarget } from './previewTarget'
import { usePreview } from './usePreview'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  workspacePath: string
}>()

const notify = useNotify()
const { current, clear } = usePreview()

const target = computed<PreviewTarget | null>(() => current.value)
const title = computed(() => (target.value ? previewTitle(target.value) : ''))
const subtitle = computed(() => (target.value ? previewSubtitle(target.value) : ''))

// Inline kinds carry their payload in `content`; file-backed kinds do not.
const inlineContent = computed(() => {
  const t = target.value
  if (!t) return null
  return t.kind === 'snippet' || t.kind === 'html' || t.kind === 'markdown' ? t.content : null
})

const attribution = computed(() => {
  const t = target.value
  if (!t || !t.source || t.source === 'user') return ''
  return t.origin ? `${t.source} · ${t.origin}` : t.source
})

// A target can name any workspace — the payload comes from MCP and is not
// checked against the set of open projects. Anything that acts on that path
// (below: opening an editor window on it) must therefore refuse a target that
// does not belong to the workspace this panel is showing; otherwise a pushed
// target could aim a read-write editor at an arbitrary directory.
const isForeignWorkspace = computed(() => {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return false
  return t.workspacePath !== props.workspacePath
})

const canOpenInEditor = computed(() => {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return false
  return !isForeignWorkspace.value
})

const copied = ref(false)

async function copyContent(): Promise<void> {
  const text = inlineContent.value
  if (text === null) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    notify.toast('Copy failed', { type: 'error' })
  }
}

type AgentApi = {
  openEditorWindow?: (a: {
    workspace_path: string
    filepath?: string
    name?: string
  }) => Promise<unknown>
}

// Escape hatch for anything the narrow rail renders poorly. Only file-backed
// targets have somewhere to go.
function openInEditor(relPath?: string, name?: string): void {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return
  // Not only the button: DiffPane's open-file event lands here too.
  if (!canOpenInEditor.value) return
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  const rel = relPath ?? t.relPath
  void api.openEditorWindow({
    workspace_path: t.workspacePath,
    filepath: rel,
    name: name ?? rel.split('/').pop() ?? rel,
  })
}
</script>

<template>
  <div class="pv">
    <template v-if="target">
      <header class="pv-hdr">
        <span class="pv-kind">{{ target.kind }}</span>
        <span class="pv-title" :title="subtitle || title">{{ title }}</span>
        <span class="pv-acts">
          <button
            v-if="inlineContent !== null"
            class="pv-btn"
            :title="$t('preview.copy')"
            @click="copyContent"
          >
            {{ copied ? $t('preview.copied') : $t('preview.copy') }}
          </button>
          <button
            v-if="canOpenInEditor"
            class="pv-btn"
            :title="$t('preview.open-in-editor')"
            @click="openInEditor()"
          >
            {{ $t('preview.open') }}
          </button>
          <button class="pv-btn pv-x" :title="$t('preview.close')" @click="clear">×</button>
        </span>
      </header>

      <div class="pv-body">
        <FilePreviewPane
          v-if="target.kind === 'file'"
          :key="target.workspacePath + ':' + target.relPath"
          :workspace-path="target.workspacePath"
          :rel-path="target.relPath"
          :name="title"
          :backend="props.backend"
        />
        <DiffPane
          v-else-if="target.kind === 'diff'"
          :key="target.workspacePath + ':' + target.relPath + ':' + String(target.staged)"
          :workspace-path="target.workspacePath"
          :filepath="target.relPath"
          :staged="target.staged === true"
          :commit="target.commit"
          :name="title"
          :backend="props.backend"
          readonly
          @open-file="(f) => openInEditor(f.filepath, f.name)"
        />
        <MarkdownPreview
          v-else-if="target.kind === 'markdown'"
          :content="target.content"
        />
        <InlineHtmlPreview
          v-else-if="target.kind === 'html'"
          :content="target.content"
          :title="title"
        />
        <SnippetPreview v-else :content="target.content" :lang="target.lang" />
      </div>

      <footer class="pv-foot">
        <span v-if="subtitle" class="pv-sub" :title="subtitle">{{ subtitle }}</span>
        <span v-if="target.kind === 'html'" class="pv-flag">{{ $t('preview.sandboxed') }}</span>
        <span v-if="isForeignWorkspace" class="pv-flag pv-warn">{{ $t('preview.foreign-workspace') }}</span>
        <span v-if="attribution" class="pv-flag">{{ attribution }}</span>
      </footer>
    </template>

    <div v-else class="pv-empty">
      <div class="pv-empty-icon" />
      <div class="pv-empty-title">{{ $t('preview.empty-title') }}</div>
      <div class="pv-empty-hint">{{ $t('preview.empty-hint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.pv-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  flex: none;
}
.pv-kind {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft, rgba(123, 148, 240, 0.16));
  color: var(--accent, #7b94f0);
}
.pv-title {
  font-size: 11.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.pv-acts {
  display: flex;
  gap: 4px;
  flex: none;
}
.pv-btn {
  font-size: var(--font-3xs);
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--border-default);
  background: transparent;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
}
.pv-btn:hover {
  opacity: 1;
}
.pv-x {
  padding: 2px 6px;
}
.pv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pv-body > * {
  flex: 1;
  min-height: 0;
}
.pv-foot {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-top: 1px solid var(--border-default);
  font-size: var(--font-3xs);
  opacity: 0.7;
}
.pv-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  direction: rtl;
  text-align: left;
}
.pv-flag {
  flex: none;
}
.pv-warn {
  color: var(--warning, #c77400);
  font-weight: 600;
}
.pv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 20px;
  text-align: center;
}
.pv-empty-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1.5px dashed var(--border-default);
}
.pv-empty-title {
  font-size: var(--font-xs);
  font-weight: 600;
}
.pv-empty-hint {
  font-size: 10.5px;
  opacity: 0.65;
  line-height: 1.6;
}
</style>
