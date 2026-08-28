import { describe, expect, it, vi } from 'vitest'
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

  it('warns and treats malformed state as not opted out until restore repairs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-factory-opt-outs-'))
    try {
      writeFileSync(join(root, '.navide-factory-plugin-opt-outs.json'), '{not-json', {
        mode: 0o600,
      })

      const store = new PluginFactoryOptOutStore(root)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(store.has('navide.git')).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid factory opt-out state'))
      store.remove('navide.git')
      expect(new PluginFactoryOptOutStore(root).has('navide.git')).toBe(false)
      warn.mockRestore()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
