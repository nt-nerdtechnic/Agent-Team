// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// wiring for CLI-pane multi-select (Cmd/Ctrl/Shift-click) + the batch
// right-click context menu, so a refactor can't silently drop it.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)
const enLocale = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/i18n/locales/en-US.json'),
  'utf8'
)
const zhLocale = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/i18n/locales/zh-TW.json'),
  'utf8'
)

describe('App CLI-pane multi-select + batch context menu', () => {
  it('holds a selection set and prunes it as panes change', () => {
    expect(appSource).toContain('const selectedPaneIds = ref(new Set<string>())')
    // Pruned inside the panes watcher against the live id set.
    expect(appSource).toContain('[...selectedPaneIds.value].filter((id) => ids.has(id))')
  })

  it('toggles the set on modifier-click and clears it on a plain click', () => {
    expect(appSource).toContain('function onSetFocus(paneId: string, ev?: MouseEvent): void')
    expect(appSource).toContain('ev.metaKey || ev.ctrlKey || ev.shiftKey')
    // Plain click resets the selection.
    expect(appSource).toContain('selectedPaneIds.value = new Set()')
  })

  it('targets the whole selection only when the clicked pane is in a set of >1', () => {
    expect(appSource).toContain('const ctxTargetIds = computed<string[]>')
    expect(appSource).toContain('selectedPaneIds.value.has(m.paneId) && selectedPaneIds.value.size > 1')
    expect(appSource).toContain('const ctxIsBatch = computed(() => ctxTargetIds.value.length > 1)')
  })

  it('defines the batch action helpers', () => {
    expect(appSource).toContain('async function batchInterrupt(ids: string[])')
    expect(appSource).toContain('function batchMinimize(ids: string[])')
    expect(appSource).toContain('function batchRestore(ids: string[])')
    expect(appSource).toContain('async function batchKill(ids: string[])')
    expect(appSource).toContain('async function batchRebuild(ids: string[])')
  })

  it('renders the batch menu branch wired to the batch helpers', () => {
    expect(appSource).toContain('<template v-if="ctxIsBatch">')
    expect(appSource).toContain('batchInterrupt(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchRebuild(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchMinimize(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchRestore(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchKill(ctxTargetIds); closePaneCtxMenu()')
  })

  it('passes selection state + the click event down to each pane surface', () => {
    expect(appSource).toContain(':is-selected="selectedPaneIds.has(p.id)"')
    expect(appSource).toContain('@set-focus="(ev) => onSetFocus(p.id, ev)"')
    expect(appSource).toContain('@click="(ev) => onSetFocus(p.id, ev)"')
  })

  it('ships i18n keys for every batch menu label in both locales', () => {
    for (const src of [enLocale, zhLocale]) {
      const json = JSON.parse(src)
      expect(json.action['selected-count']).toContain('{count}')
      expect(json.action['interrupt-selected']).toBeTruthy()
      expect(json.action['rebuild-selected']).toBeTruthy()
      expect(json.action['minimize-selected']).toBeTruthy()
      expect(json.action['restore-selected']).toBeTruthy()
      expect(json.action['remove-selected']).toBeTruthy()
    }
  })
})
