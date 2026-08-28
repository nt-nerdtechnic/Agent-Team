// @vitest-environment happy-dom
// Batch drag: dragging a pane that belongs to a multi-selection moves the whole
// selection, the same way the right-click menu acts on the whole selection.
// App.vue cannot be mounted here (backend/terminal/onboarding lifecycles), so
// the wiring is asserted against its source and the behaviour is exercised
// through the shared composable with real DOM drag events.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PANE_BATCH_MIME, PANE_ID_MIME, type CliContextPayload } from '@navide/terminal'
import { reorderBatchByIds, resolveDragBatch } from '../../lib/paneBatchDrag'
import { usePaneReorderDrag } from '../../composables/usePaneReorderDrag'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const terminalPaneSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/TerminalPane.vue'),
  'utf8'
)
const controlPaneSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/ControlPane.vue'),
  'utf8'
)

describe('App batch drag wiring', () => {
  it('reorders the whole dragged batch, not just the grabbed pane', () => {
    expect(appSource).toContain('reorderBatchByIds(panes.value, paneDragBatch(fromId), toId)')
  })

  it('derives the batch from the same multi-selection the context menu uses', () => {
    expect(appSource).toContain(
      'resolveDragBatch(paneId, selectedPaneIds.value, panes.value.map((p) => p.id))'
    )
  })

  it('moves every batched pane when the batch is dropped on a tab', () => {
    const moveFn = appSource.slice(
      appSource.indexOf('async function movePaneToGroup'),
      appSource.indexOf('/** Delete a RunGroup tab.')
    )
    expect(moveFn).toContain('for (const id of paneDragBatch(paneId))')
    // Panes already in the target group must not be re-persisted.
    expect(moveFn).toContain("(pane.runGroupId ?? '') === targetGroupId) continue")
  })

  it('shares every dragged pane when a batch is dropped on a terminal', () => {
    expect(appSource).toContain(
      '@cli-context-drop="(sourceIds) => injectPaneContextSources(sourceIds, p.id)"'
    )
    const injectFn = appSource.slice(
      appSource.indexOf('async function injectPaneContextSources'),
      appSource.indexOf('// Shared delivery tail')
    )
    // Sequential: two interleaved bracketed pastes would corrupt each other.
    expect(injectFn).toContain('for (const id of sourcePaneIds)')
    expect(injectFn).toContain('await injectPaneContext(id, targetPaneId)')
  })

  it('hands the batch to the drag payload and to the cross-window handoff', () => {
    expect(appSource).toContain(':selection-batch-ids="selectionBatchIds"')
    expect(appSource).toContain('batchFor: paneDragBatch,')
    expect(appSource).toContain(
      'window.agentTeam?.cliPaneDragEnd?.(paneId, screenX, screenY, paneDragBatch(paneId))'
    )
  })

  it('shares every pane of a batch released over another window', () => {
    expect(appSource).toContain(
      'void injectPaneContextSources(paneIds?.length ? paneIds : [paneId], targetPaneId)'
    )
  })

  it('renders every pane of the batch as dragging on all three aux surfaces', () => {
    const occurrences = appSource.split("'pane-dragging': auxiliaryDraggingBatchIds.includes(p.id)")
    expect(occurrences).toHaveLength(4) // 3 surfaces → 3 splits + 1
  })

  it('keeps the selection batch empty below two panes', () => {
    expect(appSource).toContain('selectedPaneIds.value.size < 2')
  })
})

describe('TerminalPane batch drag wiring', () => {
  it('carries the selection when the grabbed pane is part of it', () => {
    expect(terminalPaneSource).toContain('function headerDragBatch(): string[]')
    expect(terminalPaneSource).toContain('batch.includes(props.paneId) ? batch : [props.paneId]')
  })

  it('refuses to be a reorder target for a batch it belongs to', () => {
    expect(terminalPaneSource).toContain('draggingSelf || isOwnBatchMember(e)')
  })

  it('reads every source pane from the drop, batch or not', () => {
    expect(terminalPaneSource).toContain('resolveCliDropSources(')
    expect(terminalPaneSource).toContain("emit('cli-context-drop', sourcePaneIds)")
  })
})

describe('ControlPane agent list batch drag wiring', () => {
  it('writes the batch MIME only for a real batch', () => {
    expect(controlPaneSource).toContain(
      "if (batch.length > 1) e.dataTransfer.setData(PANE_BATCH_MIME, batch.join('\\n'))"
    )
  })

  it('excludes batch members from being drop targets and fades them out', () => {
    expect(controlPaneSource).toContain('draggingBatchIds.value.includes(paneId)')
    expect(controlPaneSource).toContain("'agent-item--dragging': draggingBatchIds.includes(p.id)")
  })
})

describe('batch drag behaviour through the shared composable', () => {
  const setup = (batch: string[]) => {
    const items = [{ id: 'pane-a' }, { id: 'pane-b' }, { id: 'pane-c' }]
    const payloads: Record<string, CliContextPayload> = {
      'pane-a': { paneId: 'pane-a', agentKey: 'claude' },
      'pane-b': { paneId: 'pane-b', agentKey: 'codex' },
      'pane-c': { paneId: 'pane-c', agentKey: 'copilot' },
    }
    const persist = vi.fn()
    const drag = usePaneReorderDrag({
      payloadFor: (paneId) => payloads[paneId] ?? null,
      batchFor: (paneId) => resolveDragBatch(paneId, new Set(batch), items.map((i) => i.id)),
      reorder(fromId, toId) {
        const moving = resolveDragBatch(fromId, new Set(batch), items.map((i) => i.id))
        if (reorderBatchByIds(items, moving, toId)) persist(items.map((i) => i.id))
      },
      handOff: vi.fn(),
    })
    const data = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'move',
      get types() { return [...data.keys()] },
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      setDragImage: vi.fn(),
    } as unknown as DataTransfer
    const dragEvent = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { dataTransfer })
      return event
    }
    return { items, drag, data, dragEvent, persist }
  }

  it('writes the whole selection into the drag payload', () => {
    const { drag, data, dragEvent } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-a')

    expect(data.get(PANE_ID_MIME)).toBe('pane-a')
    expect(data.get(PANE_BATCH_MIME)).toBe('pane-a\npane-c')
    expect(drag.draggingBatchIds.value).toEqual(['pane-a', 'pane-c'])
  })

  it('moves the whole selection on drop, keeping its relative order', () => {
    const { items, drag, dragEvent, persist } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-a')
    drag.onDrop(dragEvent('drop') as DragEvent, 'pane-b')

    expect(items.map((i) => i.id)).toEqual(['pane-a', 'pane-c', 'pane-b'])
    expect(persist).toHaveBeenCalledWith(['pane-a', 'pane-c', 'pane-b'])
  })

  it('refuses a pane of the batch as its own drop target', () => {
    const { drag, dragEvent } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-a')

    const target = document.createElement('div')
    target.addEventListener('dragover', (e) => drag.onDragOver(e as DragEvent, 'pane-c'))
    const accepted = !target.dispatchEvent(dragEvent('dragover'))

    expect(accepted).toBe(false)
    expect(drag.dragOverPaneId.value).toBe('')
  })

  it('still accepts a pane outside the batch as a target', () => {
    const { drag, dragEvent } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-a')

    const target = document.createElement('div')
    target.addEventListener('dragover', (e) => drag.onDragOver(e as DragEvent, 'pane-b'))
    const accepted = !target.dispatchEvent(dragEvent('dragover'))

    expect(accepted).toBe(true)
    expect(drag.dragOverPaneId.value).toBe('pane-b')
  })

  it('drags a single pane unchanged when it is outside the selection', () => {
    const { items, drag, data, dragEvent } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-b')
    expect(data.has(PANE_BATCH_MIME)).toBe(false)

    drag.onDrop(dragEvent('drop') as DragEvent, 'pane-c')
    expect(items.map((i) => i.id)).toEqual(['pane-a', 'pane-c', 'pane-b'])
  })

  it('clears the dragging batch when the drag ends', () => {
    const { drag, dragEvent } = setup(['pane-a', 'pane-c'])
    drag.onDragStart(dragEvent('dragstart') as DragEvent, 'pane-a')
    drag.onDragEnd(dragEvent('dragend') as DragEvent)

    expect(drag.draggingBatchIds.value).toEqual([])
  })
})
