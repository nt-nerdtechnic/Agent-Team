import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseInstalledManifest,
  parseManifestJson,
  manifestToDescriptor,
  loadPluginDir,
  scanInstalledPlugins,
  InstalledPluginError,
} from './installedPlugins'

const VALID = { id: 'acme.demo', version: '1.2.3', entry: 'dist/main.js', requires: ['fs', 'git'] }

const CONTRACT_FIXTURES = join(process.cwd(), 'docs/plugin-contracts/fixtures')
const VALID_V2_FIXTURES = readdirSync(join(CONTRACT_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const INVALID_V2_FIXTURES = readdirSync(join(CONTRACT_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()

function readFixture(group: string, name: string): string {
  return readFileSync(join(CONTRACT_FIXTURES, group, name), 'utf8')
}

describe('parseInstalledManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseInstalledManifest(VALID)
    expect(m.id).toBe('acme.demo')
    expect(m.requires).toEqual(['fs', 'git'])
  })

  it('rejects a bad id', () => {
    expect(() => parseInstalledManifest({ ...VALID, id: 'NotValid' })).toThrow(InstalledPluginError)
  })

  it('rejects a non-semver version', () => {
    expect(() => parseInstalledManifest({ ...VALID, version: '1.0' })).toThrow(/semver/)
  })

  it('rejects a missing entry', () => {
    const { entry: _e, ...noEntry } = VALID
    expect(() => parseInstalledManifest(noEntry)).toThrow(/entry/)
  })

  it('rejects an unknown capability (scope over-reach)', () => {
    expect(() => parseInstalledManifest({ ...VALID, requires: ['fs', 'network'] })).toThrow(/network/)
  })

  it('keeps the v2 storage permission out of the legacy manifest path', () => {
    expect(() => parseInstalledManifest({ ...VALID, requires: ['storage'] })).toThrow(
      /legacy manifests/
    )
  })

  it.each(['../escape.js', 'a/../../etc/passwd', '/abs/main.js', '..\\win.js', 'C:/win.js'])(
    'rejects a path-traversal entry %j',
    (entry) => {
      expect(() => parseInstalledManifest({ ...VALID, entry })).toThrow(InstalledPluginError)
      expect(() => parseInstalledManifest({ ...VALID, entry })).toThrow(/unsafe entry path/)
    }
  )
})

describe('Manifest v2 contract corpus', () => {
  it.each(VALID_V2_FIXTURES)(
    'accepts valid fixture %s',
    (name) => {
      const manifest = parseInstalledManifest(JSON.parse(readFixture('valid', name)))
      expect(manifest.schemaVersion).toBe(2)
    }
  )

  it.each(INVALID_V2_FIXTURES)('rejects invalid fixture %s', (name) => {
    expect(() => parseInstalledManifest(JSON.parse(readFixture('invalid', name)))).toThrow()
  })

  it('rejects duplicate object keys before manifest validation', () => {
    expect(() => parseManifestJson(readFixture('invalid-raw', 'duplicate-permission-key.json'))).toThrow(
      /duplicate JSON object key: ui/
    )
  })

  it('rejects a UTF-8 BOM before manifest validation', () => {
    expect(() => parseManifestJson(readFixture('invalid-raw', 'manifest-utf8-bom.json'))).toThrow(
      /BOM/
    )
  })

  it('derives the Host view catalog from v2 contributions', () => {
    const manifest = parseInstalledManifest(
      JSON.parse(readFixture('valid', 'frontend-multi-view.json'))
    )
    const descriptor = manifestToDescriptor(manifest, '/plugins/acme.files')
    expect(descriptor.requires).toEqual(['fs', 'ui'])
    expect(descriptor.capabilityPolicy).toEqual({
      kind: 'manifest-v2',
      grants: [
        { permission: 'fs', access: 'read' },
        { permission: 'ui', access: 'openInEditor' },
        { permission: 'ui', access: 'openExternal' },
      ],
    })
    expect(descriptor.views).toHaveLength(6)
    expect(descriptor.views?.find((view) => view.id === 'left')).toMatchObject({
      contributionKey: 'acme.files.left',
      kind: 'custom',
      location: 'left',
      entryFile: '/plugins/acme.files/frontend/left/index.html',
    })
  })
})

describe('manifestToDescriptor', () => {
  it('resolves entry against the plugin dir and empties devUrl', () => {
    const d = manifestToDescriptor(parseInstalledManifest(VALID), '/plugins/acme.demo')
    expect(d.id).toBe('acme.demo')
    expect(d.devUrl).toBe('')
    expect(d.entryFile).toBe('/plugins/acme.demo/dist/main.js')
    expect(d.requires).toEqual(['fs', 'git'])
  })
})

describe('loadPluginDir', () => {
  let root: string
  let outside: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugin-dir-'))
    outside = mkdtempSync(join(tmpdir(), 'plugin-outside-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects a UTF-8 BOM when loading an installed manifest from disk', () => {
    writeFileSync(
      join(root, 'manifest.json'),
      readFileSync(join(CONTRACT_FIXTURES, 'invalid-raw', 'manifest-utf8-bom.json'))
    )
    expect(loadPluginDir(root).error).toMatch(/BOM/)
  })

  it('returns a descriptor for a valid plugin dir', () => {
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(VALID))
    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor?.id).toBe('acme.demo')
    expect(loaded.descriptor?.entryFile).toBe(join(root, 'dist/main.js'))
  })

  it('loads a v2 custom view from its contribution entry and placement', () => {
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.viewer',
      name: 'Viewer',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A viewer.', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'left',
            kind: 'custom',
            location: 'left',
            title: 'Viewer',
            entry: 'frontend/left/index.html',
          },
        ],
      },
    }
    mkdirSync(join(root, 'frontend', 'left'), { recursive: true })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'frontend', 'left', 'index.html'), '<!doctype html>')

    const loaded = loadPluginDir(root)
    expect(loaded.error).toBeUndefined()
    expect(loaded.descriptor?.views).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.viewer.left',
        location: 'left',
        entryFile: join(root, 'frontend', 'left', 'index.html'),
      }),
    ])
  })

  it('returns an error (never throws) for a missing or invalid manifest', () => {
    expect(loadPluginDir(join(root, 'nope')).error).toBeTruthy()
    writeFileSync(join(root, 'manifest.json'), '{ not json')
    expect(loadPluginDir(root).error).toBeTruthy()
    expect(loadPluginDir(root).descriptor).toBeUndefined()
  })

  it('rejects a symlinked contribution path', () => {
    const manifest = {
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'acme.viewer',
      name: 'Viewer',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'A viewer.', license: 'MIT' },
      contributes: {
        views: [
          {
            id: 'left',
            kind: 'custom',
            location: 'left',
            title: 'Viewer',
            entry: 'frontend/left/index.html',
          },
        ],
      },
    }
    mkdirSync(join(outside, 'left'), { recursive: true })
    writeFileSync(join(outside, 'left', 'index.html'), '<!doctype html>')
    symlinkSync(outside, join(root, 'frontend'))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))

    expect(loadPluginDir(root).error).toMatch(/referenced file is missing or unsafe/)
  })
})

describe('scanInstalledPlugins', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plugins-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns [] for a non-existent root', () => {
    expect(scanInstalledPlugins(join(root, 'nope'))).toEqual([])
  })

  it('parses valid plugins and reports bad ones without throwing', () => {
    const good = join(root, 'acme.demo')
    mkdirSync(good)
    writeFileSync(join(good, 'manifest.json'), JSON.stringify(VALID))

    const bad = join(root, 'broken')
    mkdirSync(bad)
    writeFileSync(join(bad, 'manifest.json'), '{ not json')

    const scanned = scanInstalledPlugins(root)
    const ok = scanned.find((s) => s.descriptor?.id === 'acme.demo')
    const err = scanned.find((s) => s.error)
    expect(ok?.descriptor?.entryFile).toBe(join(good, 'dist/main.js'))
    expect(err?.error).toBeTruthy()
  })
})
