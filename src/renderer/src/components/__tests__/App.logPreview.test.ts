// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles (see
// App.auxiliaryPaneDrag.test.ts), so it isn't practical to mount it here.
// These tests parse the source text instead, guarding the two log-preview
// regressions this change fixes: undefined CSS tokens, and ESC not closing
// only the topmost (preview) modal.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)
// The modal markup + CSS moved into AgentHistoryModal.vue; the open/close
// state and keybinding wiring stayed in App.vue.
const modalSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/AgentHistoryModal.vue'),
  'utf8'
)
const semanticTokensSource = readFileSync(
  resolve(process.cwd(), 'packages/plugin-ui/src/foundation/styles/tokens/semantic.css'),
  'utf8'
)

function block(startMarker: string, endMarker: string, source: string = appSource): string {
  const start = source.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return source.slice(start, end)
}

describe('Log preview modal CSS tokens', () => {
  it('only references --xxx custom properties defined in semantic.css (fallback-guarded vars excluded)', () => {
    const css = block('.log-preview-overlay {', '</style>', modalSource)
    // Only vars used WITHOUT a fallback must resolve — that's the class of bug
    // fixed here (undefined token -> transparent background).
    const referenced = [...css.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1])
    expect(referenced.length).toBeGreaterThan(0)
    for (const token of referenced) {
      expect(semanticTokensSource, `${token} should be defined in semantic.css`).toMatch(
        new RegExp(`${token}:`)
      )
    }
  })
})

describe('Log preview modal ESC handling', () => {
  it('closes the preview before any other modal in workbench.action.closeModal', () => {
    const closeModal = block(
      "registerCommand('workbench.action.closeModal', () => {",
      '})'
    )
    const previewIdx = closeModal.indexOf('previewLogOpen.value')
    const settingsIdx = closeModal.indexOf('showSettings.value')
    expect(previewIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(previewIdx).toBeLessThan(settingsIdx)
  })

  it('feeds previewLogOpen into the modalOpen context so Escape is armed', () => {
    // The preview-open watch writes the context through the single source of
    // truth, and that source accounts for previewLogOpen.
    const watchBlock = block('watch(previewLogOpen, (open) => {', '})')
    expect(watchBlock).toContain("setContext('modalOpen', mainModalOpen())")
    const fnStart = appSource.indexOf('function mainModalOpen(')
    expect(fnStart).toBeGreaterThan(-1)
    const fnBody = appSource.slice(fnStart, appSource.indexOf('\n}', fnStart))
    expect(fnBody).toContain('previewLogOpen.value')
  })
})

describe('History log path back-fill ordering', () => {
  // Agent History auto-selects the newest entry during the `await nextTick()`
  // inside spawnPane, so a path written before spawn() points at a file the
  // backend has not created yet and the failed read sticks. The back-fill must
  // therefore come after `await ref.spawn(`. Since a reattaching spawn only
  // learns the surviving PTY's real transcript inside that call, the ordering
  // is now load-bearing twice over.
  it('back-fills historyEntry.outputLogFile only after ref.spawn resolves', () => {
    const spawnIdx = appSource.indexOf('await ref.spawn({')
    expect(spawnIdx, 'ref.spawn call should exist').toBeGreaterThan(-1)
    const backfillIdx = appSource.indexOf('historyEntry.outputLogFile = effectiveLogFile')
    expect(backfillIdx, 'history back-fill should exist').toBeGreaterThan(-1)
    expect(backfillIdx).toBeGreaterThan(spawnIdx)
    // And the adopted path is only readable after spawn returns.
    const adoptIdx = appSource.indexOf('const effectiveLogFile')
    expect(adoptIdx).toBeGreaterThan(spawnIdx)
    expect(adoptIdx).toBeLessThan(backfillIdx)
  })
})

describe('Log preview content cleanup', () => {
  it('clears previewLogContent and previewLogTitle when previewLogOpen becomes false', () => {
    const watchBlock = block('watch(previewLogOpen, (open) => {', '})')
    expect(watchBlock).toContain('if (!open)')
    expect(watchBlock).toContain("previewLogContent.value = ''")
    expect(watchBlock).toContain("previewLogTitle.value = ''")
  })
})
