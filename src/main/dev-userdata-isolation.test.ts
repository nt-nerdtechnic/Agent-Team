import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('dev userData isolation', () => {
  it('overrides userData before any module-level store resolves it', () => {
    const override = mainSource.indexOf("app.setPath('userData'")
    expect(override).toBeGreaterThan(-1)
    // These resolve their root eagerly at module evaluation, so a later
    // override left a dev run reading and writing the packaged app's plugins
    // directory (shared capability grants and factory opt-outs).
    for (const eager of [
      'new PluginCapabilityGrantStore(pluginsRoot())',
      'new PluginFactoryOptOutStore(pluginsRoot())',
      'frontendPluginManager.loadInstalledPlugins(pluginsRoot()',
      "join(app.getPath('userData'), 'plugin-storage-v2', 'lifecycle.json')",
    ]) {
      const at = mainSource.indexOf(eager)
      expect(at, `${eager} not found`).toBeGreaterThan(-1)
      expect(at, `${eager} resolves userData before the dev override`).toBeGreaterThan(override)
    }
  })
})
