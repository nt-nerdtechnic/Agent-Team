// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import enUS from '../../i18n/locales/en-US.json'
import zhTW from '../../i18n/locales/zh-TW.json'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here — see App.spawnAdvisories.test.ts for the same reasoning.
// These tests parse the source text instead. There is no existing test for the
// sibling restore:getPending flow to extend, so this is the smallest honest
// guard for the new restore:getSkipped wiring.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('restore:getSkipped preload bridge', () => {
  it('is exposed on the restore block alongside getPending', () => {
    expect(preloadSource).toContain(
      "getSkipped: (): Promise<string[]> => ipcRenderer.invoke('restore:getSkipped')"
    )
  })
})

describe('skipped-restore notice wiring in App.vue', () => {
  const flow = block(
    'void window.agentTeam?.restore?.getSkipped?.().then((list) => {',
    '\nfunction onWorkspaceSelected('
  )

  it('is a notice, not a confirm — no apply/dismiss round trip', () => {
    expect(flow).toContain('notifyRestore.alert(')
    expect(flow).not.toContain('notifyRestore.confirm(')
    expect(flow).not.toContain('restore?.apply()')
    expect(flow).not.toContain('restore?.dismiss()')
  })

  it('does nothing when the list is empty', () => {
    expect(flow).toContain('if (!list?.length')
  })

  it('names the skipped workspace paths in the message body', () => {
    expect(flow).toContain("list.join('\\n')")
    expect(flow).toContain("i18n.global.t('restore.skipped-message', { count: list.length })")
    expect(flow).toContain("i18n.global.t('restore.skipped-title'")
  })

  it('waits out the boot overlay the same way the crash prompt does', () => {
    expect(flow).toContain('if (!booting.value) { void show(); return }')
    expect(flow).toContain('const stop = watch(booting, (b) => { if (!b) { stop(); void show() } })')
  })

  it('guards against showing the notice twice in this window', () => {
    // restore:getSkipped is not claimed on the main side, so the renderer must
    // at least not repeat itself within one window.
    expect(appSource).toContain('let skippedNoticeShown = false')
    expect(flow).toContain('skippedNoticeShown')
    expect(flow).toContain('skippedNoticeShown = true')
  })
})

describe('skipped-restore i18n keys', () => {
  for (const [name, restore] of [['en-US', enUS.restore], ['zh-TW', zhTW.restore]] as const) {
    it(`${name} defines the three skipped-restore keys`, () => {
      expect(restore['skipped-title']).toContain('{count}')
      expect(restore['skipped-message']).toBeTruthy()
      expect(restore['skipped-ack']).toBeTruthy()
    })
  }

  it('zh-TW is translated, not an English copy', () => {
    expect(zhTW.restore['skipped-title']).not.toBe(enUS.restore['skipped-title'])
    expect(zhTW.restore['skipped-message']).not.toBe(enUS.restore['skipped-message'])
    expect(zhTW.restore['skipped-ack']).not.toBe(enUS.restore['skipped-ack'])
  })
})
