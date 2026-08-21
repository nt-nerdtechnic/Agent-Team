// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (see App.auxiliaryPaneDrag.test.ts). These tests parse the
// source text instead, guarding the invariant that EVERY main-window modal is
// closable via workbench.action.closeModal (⌘W / Escape) and is fed into the
// 'modalOpen' keybinding context so pane shortcuts stay off behind it.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

// One entry per main-window modal surface: [modalOpen source, closeModal branch marker]
const MODALS: Array<[string, string]> = [
  ['previewLogOpen.value', 'previewLogOpen.value'],
  ['!!cliInstallRequest.value', 'closeCliInstall()'],
  ['reconnectPickerOpen.value', 'reconnectPickerOpen.value = false'],
  ['!!whatsNewEntry.value', 'dismissWhatsNew()'],
  ['showRestoreScopeModal.value', 'settleRestoreScope(null)'],
  ['showSettings.value', 'showSettings.value = false'],
  ['showDebug.value', 'showDebug.value = false'],
  ['showPipelineManager.value', 'pmRef.value?.closeTopLayer?.()'],
  ['showHistory.value', 'historyModalRef.value?.closeTopLayer?.()'],
  ['showCompletionModal.value', 'showCompletionModal.value = false'],
]

function closeModalBody(): string {
  const start = appSource.indexOf("registerCommand('workbench.action.closeModal', () => {")
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n})', start))
}

function mainModalOpenBody(): string {
  const start = appSource.indexOf('function mainModalOpen(')
  expect(start).toBeGreaterThan(-1)
  return appSource.slice(start, appSource.indexOf('\n}', start))
}

describe('Main-window modals: ⌘W / Escape closability', () => {
  it('every modal surface is reachable from workbench.action.closeModal', () => {
    const body = closeModalBody()
    for (const [, branch] of MODALS) {
      expect(body, `closeModal must handle: ${branch}`).toContain(branch)
    }
  })

  it('every modal surface feeds the modalOpen keybinding context', () => {
    const body = mainModalOpenBody()
    for (const [source] of MODALS) {
      expect(body, `mainModalOpen must include: ${source}`).toContain(source)
    }
  })

  it('the log preview (topmost layer) closes before everything else', () => {
    const body = closeModalBody()
    const rest = MODALS.slice(1).map(([, b]) => body.indexOf(b))
    for (const idx of rest) expect(body.indexOf('previewLogOpen.value')).toBeLessThan(idx)
  })

  it('the dialog watch registers the late-declared sources', () => {
    // The three dialog refs are declared after the main modalOpen watch, so
    // they get their own watch — dropping it silently loses ⌘W on them.
    const line = appSource
      .split('\n')
      .find((l) => l.includes('watch([reconnectPickerOpen, cliInstallRequest, whatsNewEntry]'))
    expect(line).toBeTruthy()
    expect(line).toContain("setContext('modalOpen', mainModalOpen())")
  })
})
