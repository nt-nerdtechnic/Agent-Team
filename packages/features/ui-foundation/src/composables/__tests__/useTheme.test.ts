// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { useTheme, DEFAULT_THEME } from '../useTheme'
import { settingsGet, settingsSet } from '@navide/shared'
import { __resetSettingsForTest } from '../../../../shared/src/testing'

const THEME_KEY = 'agent-team:theme'
const CUSTOM_KEY = 'agent-team:theme-custom'

function html(): HTMLElement {
  return document.documentElement
}

/** Values live JSON-encoded in the settings store (legacy localStorage encoding). */
function storedJson(key: string): unknown {
  const raw = settingsGet<string | null>(key, null)
  return raw == null ? null : JSON.parse(raw)
}

describe('useTheme', () => {
  beforeEach(() => {
    // Reset persisted + DOM state. The composable is a module-level singleton,
    // so each test starts from a clean, explicit baseline.
    __resetSettingsForTest()
    html().removeAttribute('data-theme')
    html().removeAttribute('style')
    const { resetCustom, setTheme } = useTheme()
    resetCustom()
    setTheme(DEFAULT_THEME)
    __resetSettingsForTest()
  })

  it('defaults to dark-github when nothing is stored', () => {
    const { loadTheme, theme } = useTheme()
    const res = loadTheme()
    expect(res.fromLocal).toBe(false)
    expect(theme.value).toBe('dark-github')
    expect(html().getAttribute('data-theme')).toBe('dark-github')
  })

  it('loads the theme from the settings store', () => {
    settingsSet(THEME_KEY, JSON.stringify('dark-forest'))
    const { loadTheme, theme } = useTheme()
    const res = loadTheme()
    expect(res.fromLocal).toBe(true)
    expect(theme.value).toBe('dark-forest')
    expect(html().getAttribute('data-theme')).toBe('dark-forest')
  })

  it('adopts the backend fallback when the store is empty and promotes it', () => {
    const { loadTheme, theme } = useTheme()
    const res = loadTheme({ theme: 'light', theme_custom: { '--accent-fg': '#abcdef' } })
    expect(res.fromLocal).toBe(false)
    expect(theme.value).toBe('light')
    // Promoted to the source of truth so later loads are stable.
    expect(storedJson(THEME_KEY)).toBe('light')
    expect(storedJson(CUSTOM_KEY)).toEqual({
      '--accent-fg': '#abcdef',
    })
  })

  it('the stored value wins over the backend fallback', () => {
    settingsSet(THEME_KEY, JSON.stringify('high-contrast'))
    const { loadTheme, theme } = useTheme()
    loadTheme({ theme: 'light' })
    expect(theme.value).toBe('high-contrast')
  })

  it('falls back to default for an unknown stored theme', () => {
    settingsSet(THEME_KEY, JSON.stringify('nonsense'))
    const { loadTheme, theme } = useTheme()
    loadTheme()
    expect(theme.value).toBe(DEFAULT_THEME)
  })

  it('setTheme updates the attribute + store and keeps overrides', () => {
    const { setCustomOverride, setTheme, theme, customOverrides } = useTheme()
    setCustomOverride('--accent-fg', '#112233')
    setTheme('dark-midnight')
    expect(theme.value).toBe('dark-midnight')
    expect(html().getAttribute('data-theme')).toBe('dark-midnight')
    expect(storedJson(THEME_KEY)).toBe('dark-midnight')
    // Custom override survives the built-in theme switch.
    expect(customOverrides.value['--accent-fg']).toBe('#112233')
    expect(html().style.getPropertyValue('--accent-fg')).toBe('#112233')
  })

  it('ignores an invalid theme id in setTheme', () => {
    const { setTheme, theme } = useTheme()
    setTheme('dark-forest')
    setTheme('not-a-theme')
    expect(theme.value).toBe('dark-forest')
  })

  it('setCustomOverride applies inline var and clears with null', () => {
    const { setCustomOverride, customOverrides } = useTheme()
    setCustomOverride('--danger-fg', '#ff0000')
    expect(html().style.getPropertyValue('--danger-fg')).toBe('#ff0000')
    expect(storedJson(CUSTOM_KEY)).toEqual({
      '--danger-fg': '#ff0000',
    })
    setCustomOverride('--danger-fg', null)
    expect(html().style.getPropertyValue('--danger-fg')).toBe('')
    expect(customOverrides.value['--danger-fg']).toBeUndefined()
  })

  it('resetCustom clears every override', () => {
    const { setCustomOverride, resetCustom, customOverrides } = useTheme()
    setCustomOverride('--accent-fg', '#111111')
    setCustomOverride('--success-fg', '#222222')
    resetCustom()
    expect(customOverrides.value).toEqual({})
    expect(html().style.getPropertyValue('--accent-fg')).toBe('')
    expect(html().style.getPropertyValue('--success-fg')).toBe('')
    expect(storedJson(CUSTOM_KEY)).toEqual({})
  })
})
