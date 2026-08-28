// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CLI_CONTEXT_MIME, PANE_ID_MIME, type CliContextPayload } from '@navide/terminal'
import { reorderByIds } from '../../lib/paneOrder'
import { usePaneReorderDrag } from '../../composables/usePaneReorderDrag'

// Mounting App starts backend, terminal, settings, and onboarding lifecycles.
// Keep the template wiring checks narrow, then dispatch real DOM drag events
// through the same shared handlers used by all three lightweight layouts.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function elementOpeningTag(className: string): string {
  const classAt = appSource.indexOf(`class="${className}"`)
  expect(classAt, `${className} should exist`).toBeGreaterThan(-1)
  const start = appSource.lastIndexOf('<div', classAt)
  const end = appSource.indexOf('>', classAt)
  return appSource.slice(start, end + 1)
}

function expectPaneDragSurface(openingTag: string): void {
  expect(openingTag).toContain('draggable="true"')
  expect(openingTag).toContain('@dragstart="onAuxiliaryPaneDragStart($event, p.id)"')
  expect(openingTag).toContain('@dragend="onAuxiliaryPaneDragEnd"')
  expect(openingTag).toContain('@dragover="onAuxiliaryPaneDragOver($event, p.id)"')
  expect(openingTag).toContain('@drop.prevent="onAuxiliaryPaneDrop($event, p.id)"')
  expect(openingTag).toContain("'pane-drag-over': auxiliaryDragOverPaneId === p.id")
}

describe('App auxiliary pane drag surfaces', () => {
  it('wires Auto meeting cards as pane drag sources and targets', () => {
    const autoStart = appSource.indexOf('class="auto-meeting-list"')
    const spotlightStart = appSource.indexOf('class="spotlight-strip"')
    const autoSection = appSource.slice(autoStart, spotlightStart)
    expect(autoSection).toContain('class="meeting-item"')
    expectPaneDragSurface(elementOpeningTag('meeting-item'))
  })

  it('wires Spotlight thumbnails as pane drag sources and targets', () => {
    expectPaneDragSurface(elementOpeningTag('spotlight-thumb'))
  })

  it('wires Fullscreen PiP rows as pane drag sources and targets', () => {
    const pipStart = appSource.indexOf('class="float-pip-list"')
    expect(pipStart).toBeGreaterThan(-1)
    const pipItemClass = appSource.indexOf('class="meeting-item"', pipStart)
    expect(pipItemClass).toBeGreaterThan(pipStart)
    const start = appSource.lastIndexOf('<div', pipItemClass)
    const end = appSource.indexOf('>', pipItemClass)
    expectPaneDragSurface(appSource.slice(start, end + 1))
  })

  it('reorders and persists after a real dragstart/dragover/drop sequence', () => {
    const items = [{ id: 'pane-a' }, { id: 'pane-b' }]
    const persist = vi.fn()
    const payloads: Record<string, CliContextPayload> = {
      'pane-a': { paneId: 'pane-a', agentKey: 'claude', label: 'Claude' },
      'pane-b': { paneId: 'pane-b', agentKey: 'codex', label: 'Codex' },
    }
    const drag = usePaneReorderDrag({
      payloadFor: (paneId) => payloads[paneId] ?? null,
      reorder(fromId, toId) {
        if (reorderByIds(items, fromId, toId)) persist(items.map((item) => item.id))
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
    } as unknown as DataTransfer
    const dragEvent = (type: string): Event => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(event, { dataTransfer })
      return event
    }
    const source = document.createElement('div')
    const target = document.createElement('div')
    source.draggable = true
    target.draggable = true
    source.addEventListener('dragstart', (event) => drag.onDragStart(event as DragEvent, 'pane-a'))
    target.addEventListener('dragover', (event) => drag.onDragOver(event as DragEvent, 'pane-b'))
    target.addEventListener('drop', (event) => drag.onDrop(event as DragEvent, 'pane-b'))

    source.dispatchEvent(dragEvent('dragstart'))
    expect(data.get(PANE_ID_MIME)).toBe('pane-a')
    expect(JSON.parse(data.get(CLI_CONTEXT_MIME) ?? '')).toMatchObject(payloads['pane-a'])

    const overAccepted = !target.dispatchEvent(dragEvent('dragover'))
    expect(overAccepted).toBe(true)
    expect(drag.dragOverPaneId.value).toBe('pane-b')

    target.dispatchEvent(dragEvent('drop'))
    expect(items.map((item) => item.id)).toEqual(['pane-b', 'pane-a'])
    expect(persist).toHaveBeenCalledWith(['pane-b', 'pane-a'])
    expect(drag.dragOverPaneId.value).toBe('')
  })
})
