// @vitest-environment happy-dom
// The two reclaim controls in Settings › General. App.vue is not mountable
// (see App.logPreview.test.ts) and neither is the whole SettingsModal without
// its backend/stages/analyzer scaffolding, so this reads the source for the
// contract those rows depend on — and the i18n bundle for the strings they
// render, which is where a missing key would show up as a raw key on screen.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/SettingsModal.vue'),
  'utf8'
)

describe('Settings › General reclaim rows', () => {
  it('offers every threshold down to the 15-minute floor', () => {
    for (const minutes of ['15', '30', '60', '180', '480']) {
      expect(source).toContain(`<option value="${minutes}">`)
    }
  })

  // The floor exists so a stored value cannot turn the sweep into "reclaim as
  // soon as the user stops typing"; offering a shorter one in the UI would be
  // a control that silently does something else.
  it('offers nothing below the floor the logic clamps to', () => {
    const offered = [...source.matchAll(/<option value="(\d+)">/g)].map((m) => Number(m[1]))
    const thresholds = offered.filter((n) => n >= 15 && n <= 480)
    expect(Math.min(...thresholds)).toBe(15)
  })

  it('hides the reclaim-now row when the feature is switched off', () => {
    const row = source.slice(source.indexOf('general-idle-reclaim-now'))
    expect(source).toContain('v-if="idleReclaimEnabledModel"\n                data-settings-section="general-idle-reclaim-now"')
    expect(row).toContain("emit('reclaim-now')")
  })

  // "Reclaim" alone does not say whether pressing it costs one pane or a dozen.
  it('names the count on the button and disables it at zero', () => {
    const row = source.slice(source.indexOf('general-idle-reclaim-now'))
    expect(row).toContain(':disabled="reclaimNowCount === 0"')
    expect(row).toContain('idle-reclaim-now-action')
    expect(row).toContain('idle-reclaim-now-action-empty')
  })

  it.each(['en-US', 'zh-TW'] as const)('has every string it renders in %s', (locale) => {
    const t = (key: string): string =>
      i18n.global.t(key, { count: 3, size: '1.1 GB' }, { locale })
    for (const key of [
      'settings.general.idle-reclaim',
      'settings.general.idle-reclaim-hint',
      'settings.general.idle-reclaim-after',
      'settings.general.idle-reclaim-after-hint',
      'settings.general.idle-reclaim-15m',
      'settings.general.idle-reclaim-30m',
      'settings.general.idle-reclaim-1h',
      'settings.general.idle-reclaim-3h',
      'settings.general.idle-reclaim-8h',
      'settings.general.idle-reclaim-now',
      'settings.general.idle-reclaim-now-hint',
      'settings.general.idle-reclaim-now-empty',
      'settings.general.idle-reclaim-now-action',
      'settings.general.idle-reclaim-now-action-empty',
      'pane.terminal.idle-reclaimed',
    ]) {
      expect(t(key), `${key} missing in ${locale}`).not.toBe(key)
    }
  })

  // The count and the size are the whole point of the copy — a bundle that
  // dropped the placeholders would render a sentence that says nothing.
  it.each(['en-US', 'zh-TW'] as const)('keeps the count and size placeholders in %s', (locale) => {
    const hint = i18n.global.t(
      'settings.general.idle-reclaim-now-hint',
      { count: 4, size: '1.1 GB' },
      { locale }
    )
    expect(hint).toContain('4')
    expect(hint).toContain('1.1 GB')
  })
})
