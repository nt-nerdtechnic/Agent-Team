import { ref } from 'vue'
import {
  PANE_ID_MIME,
  writeCliPaneDragPayload,
  type CliContextPayload,
} from '@navide/terminal'
import { setBatchDragImage } from '../lib/batchDragImage'
import { i18n } from '@navide/plugin-ui/foundation'

interface PaneReorderDragOptions {
  payloadFor: (paneId: string) => CliContextPayload | null
  /** Pane ids a drag started on `paneId` carries — the whole multi-selection
   *  when that pane is part of one. Defaults to the dragged pane alone. */
  batchFor?: (paneId: string) => string[]
  reorder: (fromId: string, toId: string) => void
  handOff: (paneId: string, screenX: number, screenY: number) => void
}

/** Shared HTML5 drag contract for the lightweight pane representations used by
 * Auto, Spotlight, and Fullscreen layouts. */
export function usePaneReorderDrag(options: PaneReorderDragOptions) {
  const dragOverPaneId = ref('')
  const draggingPaneId = ref('')
  /** Every pane the in-flight drag moves (the dragged pane alone when it is not
   *  part of a multi-selection), so all of them can render as dragging. */
  const draggingBatchIds = ref<string[]>([])

  function onDragStart(e: DragEvent, paneId: string): void {
    const payload = options.payloadFor(paneId)
    if (!payload || !e.dataTransfer) return
    const batch = options.batchFor?.(paneId) ?? [paneId]
    writeCliPaneDragPayload(e.dataTransfer, payload, batch)
    setBatchDragImage(
      e.dataTransfer,
      batch.length,
      i18n.global.t('action.dragging-panes', { count: batch.length })
    )
    e.dataTransfer.effectAllowed = 'move'
    draggingPaneId.value = paneId
    draggingBatchIds.value = batch
  }

  function onDragEnd(e: DragEvent): void {
    const paneId = draggingPaneId.value
    draggingPaneId.value = ''
    draggingBatchIds.value = []
    dragOverPaneId.value = ''
    if (!paneId || e.dataTransfer?.dropEffect !== 'none') return
    options.handOff(paneId, e.screenX, e.screenY)
  }

  function onDragOver(e: DragEvent, targetPaneId: string): void {
    if (
      draggingPaneId.value === targetPaneId
      // A pane being dragged as part of a batch is not a target for that batch.
      || draggingBatchIds.value.includes(targetPaneId)
      || !e.dataTransfer?.types.includes(PANE_ID_MIME)
    ) return
    e.preventDefault()
    dragOverPaneId.value = targetPaneId
  }

  function onDragLeave(e: DragEvent, targetPaneId: string): void {
    const target = e.currentTarget as HTMLElement | null
    if (target?.contains(e.relatedTarget as Node | null)) return
    if (dragOverPaneId.value === targetPaneId) dragOverPaneId.value = ''
  }

  function onDrop(e: DragEvent, targetPaneId: string): void {
    dragOverPaneId.value = ''
    const draggedPaneId = e.dataTransfer?.getData(PANE_ID_MIME) || ''
    if (!draggedPaneId || draggedPaneId === targetPaneId) return
    options.reorder(draggedPaneId, targetPaneId)
  }

  return {
    dragOverPaneId,
    draggingPaneId,
    draggingBatchIds,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
  }
}
