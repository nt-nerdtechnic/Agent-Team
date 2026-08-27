import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

describe('PluginFactoryOptOutStore', () => {
  it('persists a factory-package opt-out until it is explicitly restored', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    try {
      const store = new PluginFactoryOptOutStore(root)
      store.add('navide.git')

      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(true)

      new PluginFactoryOptOutStore(root).remove('navide.git')
      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed for malformed state until an explicit restore repairs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    try {
      writeFileSync(join(root, '.navide-factory-plugin-opt-outs.json'), '{not-json', {
        mode: 0o600,
      })

      const store = new PluginFactoryOptOutStore(root)
      expect(store.has('navide.git')).toBe(true)
      store.remove('navide.git')
      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
