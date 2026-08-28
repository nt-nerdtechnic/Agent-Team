import { describe, expect, it } from 'vitest'
import vitestConfig from './vitest.config'

describe('public plugin package aliases', () => {
  it('resolves specific plugin-ui subpaths before the package root', () => {
    const alias = vitestConfig.resolve?.alias
    expect(alias && !Array.isArray(alias)).toBe(true)
    const keys = Object.keys(alias as Record<string, string>)
    const root = keys.indexOf('@navide/plugin-ui')

    expect(root).toBeGreaterThan(-1)
    for (const key of [
      '@navide/plugin-ui/styles.css',
      '@navide/plugin-ui/shared/testing',
      '@navide/plugin-ui/shared',
      '@navide/plugin-ui/foundation',
    ]) {
      expect(keys.indexOf(key)).toBeGreaterThan(-1)
      expect(keys.indexOf(key)).toBeLessThan(root)
    }
  })
})
