// Module-level singleton holding what the right-rail preview panel shows.
//
// Deliberately not persisted: a preview target is a here-and-now working
// context, and the file it points at may not exist after a restart. The rail's
// tab selection is persisted separately by TokenStatsPanel.

import { computed, ref } from 'vue'
import type { PreviewTarget } from './previewTarget'

const current = ref<PreviewTarget | null>(null)
// Bumped on every show(); TokenStatsPanel watches it to switch to the Preview
// tab and expand the rail. A counter rather than a boolean so two consecutive
// pushes of the same target still surface the panel.
const focusRequest = ref(0)

// Shows a target and surfaces the panel (switch tab + expand the rail).
function show(target: PreviewTarget): void {
  current.value = target
  focusRequest.value += 1
}

// Surfaces the panel without changing what it shows. Backs the
// workbench.action.focusPreview keybinding, so the shortcut does not need a
// reference to the rail component that owns the tab state.
function focus(): void {
  focusRequest.value += 1
}

function clear(): void {
  current.value = null
}

// Drops every reference to a workspace, used when the window switches project
// so a stale path is never previewed against the new workspace.
function clearWorkspace(workspacePath: string): void {
  const t = current.value
  if (!t) return
  if ((t.kind === 'file' || t.kind === 'diff') && t.workspacePath === workspacePath) {
    current.value = null
  }
}

// Test seam: reset the singleton between test cases.
function reset(): void {
  current.value = null
  focusRequest.value = 0
}

export function usePreview() {
  return {
    current: computed(() => current.value),
    focusRequest: computed(() => focusRequest.value),
    show,
    focus,
    clear,
    clearWorkspace,
    reset,
  }
}
