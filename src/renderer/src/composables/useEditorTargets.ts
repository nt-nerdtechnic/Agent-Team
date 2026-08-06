import { ref, type Ref } from 'vue'
import { HOST_EDITOR_IDS } from '../lib/defaultEditor'

/** One entry of an "Open with ▸" submenu. */
export interface EditorTarget {
  id: string
  labelKey: string
}

const HOST_TARGETS: EditorTarget[] = HOST_EDITOR_IDS.map((id) => ({
  id,
  labelKey: `label.editor-${id}`,
}))

/**
 * Targets offered by "Open with ▸": the host editors (always available) plus
 * the external editors main actually found on this machine.
 *
 * Concurrent calls share one round trip, but a later call re-probes: main keeps
 * its own detection cache, so this stays cheap while still picking up an editor
 * the user installed (and re-detected in Settings) since the menu last opened.
 * Without the host bridge (or if the probe fails) the list degrades to the host
 * editors alone.
 */
export function useEditorTargets(): {
  editorTargets: Ref<EditorTarget[]>
  loadEditorTargets: () => Promise<void>
} {
  const editorTargets = ref<EditorTarget[]>(HOST_TARGETS)
  let inFlight: Promise<void> | null = null

  async function probe(): Promise<void> {
    let detected: { id: string; available: boolean }[] = []
    try {
      detected = (await window.agentTeam?.listEditors()) ?? []
    } catch {
      detected = []
    }
    editorTargets.value = [
      ...HOST_TARGETS,
      ...detected
        .filter((editor) => editor.available)
        .map((editor) => ({ id: editor.id, labelKey: `label.editor-${editor.id}` })),
    ]
  }

  function loadEditorTargets(): Promise<void> {
    inFlight ??= probe().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return { editorTargets, loadEditorTargets }
}
