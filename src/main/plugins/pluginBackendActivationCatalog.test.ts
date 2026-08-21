import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  projectBackendPluginActivationCatalog,
  writeBackendPluginActivationCatalog,
} from './pluginBackendActivationCatalog'

describe('backend plugin activation catalog', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('projects only Host-verified Registry backend activations', () => {
    const digest = 'a'.repeat(64)
    expect(
      projectBackendPluginActivationCatalog([
        {
          pluginId: 'acme.backend',
          packageVersion: '1.0.0',
          packageDir: '/plugins/acme.backend',
          views: [],
          provenance: 'official-registry',
          artifactDigest: digest,
          backend: {
            entryFile: '/plugins/acme.backend/backend/plugin',
            protocolVersion: 1,
            activation: 'startup',
          },
        },
        {
          pluginId: 'acme.local',
          packageVersion: '1.0.0',
          packageDir: '/local/acme.local',
          views: [],
          provenance: 'developer-local-unpacked',
          backend: {
            entryFile: '/local/acme.local/backend/plugin',
            protocolVersion: 1,
            activation: 'startup',
          },
        },
      ])
    ).toEqual({
      schemaVersion: 1,
      packages: [
        {
          pluginId: 'acme.backend',
          packageVersion: '1.0.0',
          packageDir: '/plugins/acme.backend',
          provenance: 'official-registry',
          artifactDigest: digest,
          backend: {
            entryFile: '/plugins/acme.backend/backend/plugin',
            protocolVersion: 1,
            activation: 'startup',
          },
        },
      ],
    })
  })

  it('writes owner-only exact bytes and returns their sha256 binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-catalog-'))
    roots.push(root)
    const pluginsRoot = join(root, 'plugins')
    const path = join(pluginsRoot, '.navide-backend-activation.json')
    const file = writeBackendPluginActivationCatalog(path, {
      schemaVersion: 1,
      packages: [],
    })
    const bytes = readFileSync(path)

    expect(bytes.toString('utf8')).toBe('{"schemaVersion":1,"packages":[]}')
    expect(file).toEqual({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    expect(dirname(file.path)).toBe(pluginsRoot)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
