// @vitest-environment happy-dom
// App.vue mounts backend/terminal/onboarding lifecycles (see
// App.auxiliaryPaneDrag.test.ts), so it isn't practical to mount it here.
// These parse the source text instead, guarding the wiring that makes Agent
// History's "go to pane" land on the right pane — and the keybinding context
// that stops global shortcuts from leaking into a PTY while the modal is open.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function fnBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}', start)
  expect(end, `${name} should terminate`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('onFocusHistoryPane', () => {
  const body = fnBody('onFocusHistoryPane')

  it('re-checks the pane is still live before focusing', () => {
    // A record can outlive its pane (killed while the modal was open) and
    // removedAt is only reconciled on hydrate.
    expect(body).toContain('panes.value.find((p) => p.id === entry.paneId)')
    expect(body).toContain('unavailableHistoryPaneIds')
  })

  it('closes the modal so the pane it focuses is actually visible', () => {
    expect(body).toContain('showHistory.value = false')
  })

  it('restores a minimized pane first', () => {
    // effectiveFocusPaneId skips minimized panes and silently falls back to
    // another one, so focusing without restoring lands on the wrong pane.
    expect(body).toContain('minimizedPanes.value.has(entry.paneId)')
    expect(body).toContain('restorePane(entry.paneId)')
  })

  it('routes through onFocusPane so the pane\'s tab is revealed', () => {
    expect(body).toContain('onFocusPane(entry.paneId)')
  })

  it('re-claims focus after realizing a placeholder pane', () => {
    // Un-realized panes have no TerminalPane ref, so the focusPaneId watcher's
    // focus() is a silent no-op and keystrokes stay in the outgoing pane.
    const realizedIdx = body.indexOf('const wasRealized = pane.realized')
    const focusIdx = body.indexOf('onFocusPane(entry.paneId)')
    expect(realizedIdx).toBeGreaterThan(-1)
    // Liveness must be sampled BEFORE onFocusPane, which starts realization.
    expect(realizedIdx).toBeLessThan(focusIdx)
    expect(body).toContain('blur?.()')
    expect(body).toContain('realizeRestoredPane(entry.paneId)')
    expect(body).toContain('if (focusPaneId.value !== entry.paneId) return')
    expect(body).toContain('paneRefs[entry.paneId]?.focus?.()')
  })
})

describe('Agent History keybinding context', () => {
  it('feeds showHistory into every modalOpen context write', () => {
    const writes = appSource
      .split('\n')
      .filter((line) => line.includes("setContext('modalOpen'"))
    expect(writes.length).toBeGreaterThan(0)
    for (const line of writes) {
      expect(line, `modalOpen write must include showHistory: ${line.trim()}`).toContain(
        'showHistory'
      )
    }
  })

  it('closes the history modal on Escape, peeling nested layers first', () => {
    const start = appSource.indexOf("registerCommand('workbench.action.closeModal', () => {")
    expect(start).toBeGreaterThan(-1)
    const closeModal = appSource.slice(start, appSource.indexOf('\n})', start))
    expect(closeModal).toContain('showHistory.value')
    expect(closeModal).toContain('historyModalRef.value?.closeTopLayer?.()')
    // The pop-out log preview is spawned from this modal and sits on top of it.
    expect(closeModal.indexOf('previewLogOpen.value')).toBeLessThan(
      closeModal.indexOf('showHistory.value')
    )
  })
})
