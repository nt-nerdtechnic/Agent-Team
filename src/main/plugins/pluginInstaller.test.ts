import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareInstall,
  commitInstall,
  defaultInstallerDeps,
  removePlugin,
  isUpdateAvailable,
  type InstallerDeps,
} from './pluginInstaller'
import { sha256Hex } from './pluginVerify'
import { makeZip, type ZipFile } from './zipFixture'

const REQ_BASE = {
  registryUrl: 'http://localhost:8787',
  namespace: 'acme',
  name: 'demo',
  version: '1.0.0',
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    engines: { navide: '^0.1.0' },
    entry: 'dist/main.js',
    requires: ['git'],
    ...overrides,
  })
}

function pkg(files?: ZipFile[]): { bytes: Uint8Array; digest: string } {
  const zip = makeZip(
    files ?? [
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ]
  )
  return { bytes: new Uint8Array(zip), digest: sha256Hex(new Uint8Array(zip)) }
}

function manifestV2(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Demo view', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Demo',
          entry: 'frontend/left/index.html',
        },
      ],
    },
    ...overrides,
  })
}

function v2Pkg(
  files: ZipFile[] = [
    { name: 'manifest.json', data: manifestV2() },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ]
): { bytes: Uint8Array; digest: string } {
  const zip = makeZip(files)
  return { bytes: new Uint8Array(zip), digest: sha256Hex(new Uint8Array(zip)) }
}

/** Deps that serve a fixed package and capture filesystem writes in a map. */
function fakeDeps(bytes: Uint8Array, digestHeader: string | null = 'from-header') {
  const writes = new Map<string, Uint8Array>()
  const removed: string[] = []
  const dirs: string[] = []
  const modes = new Map<string, number>()
  const deps: InstallerDeps = {
    async download() {
      return { bytes, digestHeader }
    },
    mkdirp(dir) {
      dirs.push(dir)
    },
    writeFile(path, data) {
      writes.set(path, data)
    },
    chmod(path, mode) {
      modes.set(path, mode)
    },
    rmrf(dir) {
      removed.push(dir)
    },
  }
  return { deps, writes, removed, dirs, modes }
}

describe('prepareInstall', () => {
  it('verifies and returns manifest + entries for a good package', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.id).toBe('acme.demo')
    expect(prepared.trustTier).toBe('unsigned')
    expect(prepared.requiresConfirmation).toBe(false)
  })

  it('flags sensitive capabilities for confirmation', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'terminal'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.sensitive).toEqual(['fs', 'terminal'])
    expect(prepared.requiresConfirmation).toBe(true)
  })

  it('rejects a forged digest (bytes do not match expected)', async () => {
    const { bytes } = pkg()
    const { deps } = fakeDeps(bytes, null)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: 'f'.repeat(64) }, deps)
    ).rejects.toThrow(/digest/)
  })

  it('rejects when the download header disagrees with expected digest', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, 'a'.repeat(64))
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/header/)
  })

  it('rejects an identity mismatch (manifest id != requested)', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, name: 'other', expectedDigest: digest }, deps)
    ).rejects.toThrow(/identity/)
  })

  it('verifies a valid Ed25519 signature → signed-verified', async () => {
    const { bytes, digest } = pkg()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signature = edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(
      { ...REQ_BASE, expectedDigest: digest, signature, publicKey: pubPem },
      deps
    )
    expect(prepared.trustTier).toBe('signed-verified')
  })

  it('blocks a signed package whose signature does not verify', async () => {
    const { bytes, digest } = pkg()
    const { publicKey } = generateKeyPairSync('ed25519') // key A
    const other = generateKeyPairSync('ed25519') // sign with key B
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const badSig = edSign(null, Buffer.from(digest, 'ascii'), other.privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        { ...REQ_BASE, expectedDigest: digest, signature: badSig, publicKey: pubPem },
        deps
      )
    ).rejects.toThrow(/signature/i)
  })

  it('rejects an unknown capability in the package manifest', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'network'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/network/)
  })

  it('accepts a v2 frontend contribution and verifies its entry file', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.manifest.schemaVersion).toBe(2)
    if (prepared.manifest.schemaVersion !== 2) throw new Error('expected Manifest v2')
    expect(prepared.manifest.permissions).toEqual({})
    expect(prepared.requiresConfirmation).toBe(false)
  })

  it('rejects a v2 storage permission before installation', async () => {
    const storageBytes = new Uint8Array(
      makeZip([
        { name: 'manifest.json', data: manifestV2({ permissions: { storage: ['write'] } }) },
        { name: 'frontend/left/index.html', data: '<!doctype html>' },
      ])
    )
    const storageDigest = sha256Hex(storageBytes)
    const { deps, removed, writes } = fakeDeps(storageBytes, storageDigest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: storageDigest }, deps)
    ).rejects.toThrow(/storage/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('requires confirmation for a backend-only v2 package with empty permissions', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.manifest.schemaVersion).toBe(2)
    if (prepared.manifest.schemaVersion !== 2) throw new Error('expected Manifest v2')
    expect(prepared.manifest.permissions).toEqual({})
    expect(prepared.containsBackendExecutable).toBe(true)
    expect(prepared.requiresConfirmation).toBe(true)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a backend entry without archive executable metadata', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/not marked executable/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it.each([
    { label: 'shebang', data: Buffer.from('#!/bin/sh\nexit 0\n') },
    { label: 'BOM-prefixed shebang', data: Buffer.from('\ufeff#!/bin/sh\nexit 0\n') },
  ])('rejects an executable extensionless $label script', async ({ data }) => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data, unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/raw script/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects an empty executable backend entry', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: '', unixMode: 0o100755 },
    ])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/backend entry is empty/)
  })

  it('rejects a v2 package whose contribution entry is absent', async () => {
    const { bytes, digest } = v2Pkg([{ name: 'manifest.json', data: manifestV2() }])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/referenced file is missing/)
  })

  it('rejects duplicate archive entries before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'first' },
      { name: 'dist/main.js', data: 'second' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/duplicate archive entry path/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a non-canonical manifest alias before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      {
        name: './manifest.json',
        data: manifest({ entry: 'evil.html', requires: ['terminal'] }),
      },
      { name: 'dist/main.js', data: 'x' },
      { name: 'evil.html', data: 'blocked' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it.each([
    { name: '../escape/', kind: 'directory' as const, message: 'unsafe archive entry' },
    { name: 'link', kind: 'symlink' as const, message: 'regular file or directory' },
    { name: 'device', kind: 'special' as const, message: 'regular file or directory' },
  ])('rejects unsafe $kind entries before any install side effect', async ({ name, kind, message }) => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name, kind, data: '' },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(new RegExp(message))
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })
})

describe('commitInstall', () => {
  it('writes a backend-only package without creating a frontend descriptor', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, writes, modes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)

    expect(commitInstall(prepared, '/plugins', deps)).toBeUndefined()
    expect(writes.has('/plugins/acme.demo/backend/entry')).toBe(true)
    expect(modes.get('/plugins/acme.demo/backend/entry')).toBe(0o700)
  })

  if (process.platform === 'darwin' || process.platform === 'linux') {
    it('installs a backend entry that can be spawned directly', async () => {
      const executablePath = process.platform === 'darwin' ? '/usr/bin/true' : '/bin/true'
      const { bytes, digest } = v2Pkg([
        {
          name: 'manifest.json',
          data: manifestV2({
            contributes: undefined,
            backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
          }),
        },
        {
          name: 'backend/entry',
          data: readFileSync(executablePath),
          unixMode: 0o100755,
        },
      ])
      const deps: InstallerDeps = {
        ...defaultInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-install-'))
      try {
        const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
        commitInstall(prepared, root, deps)
        const installed = join(root, 'acme.demo', 'backend', 'entry')
        expect(statSync(installed).mode & 0o777).toBe(0o700)
        const spawned = spawnSync(installed)
        expect(spawned.error).toBeUndefined()
        expect(spawned.status).toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('creates directory entries without writing directory bytes', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/', kind: 'directory', data: '' },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps, dirs, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    commitInstall(prepared, '/plugins', deps)
    expect(dirs).toContain('/plugins/acme.demo/dist')
    expect(writes.has('/plugins/acme.demo/dist/')).toBe(false)
  })

  it('writes verified entries under <root>/<id> and returns a descriptor', async () => {
    const { bytes, digest } = pkg()
    const { deps, writes, removed } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    const desc = commitInstall(prepared, '/plugins', deps)
    if (!desc) throw new Error('expected frontend descriptor')
    expect(removed).toContain('/plugins/acme.demo')
    expect([...writes.keys()].sort()).toEqual([
      '/plugins/acme.demo/dist/main.js',
      '/plugins/acme.demo/manifest.json',
    ])
    expect(desc.entryFile).toBe('/plugins/acme.demo/dist/main.js')
  })

  it('returns all v2 view contributions from a committed package', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    const desc = commitInstall(prepared, '/plugins', deps)
    if (!desc) throw new Error('expected frontend descriptor')
    expect(desc.views).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.demo.left',
        location: 'left',
        entryFile: '/plugins/acme.demo/frontend/left/index.html',
      }),
    ])
    expect(writes.has('/plugins/acme.demo/frontend/left/index.html')).toBe(true)
  })

  it('refuses a zip-slip entry before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: '../evil.js', data: 'pwned' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rechecks archive paths before removing an existing install', async () => {
    const { bytes, digest } = pkg()
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    prepared.entries.push({
      path: './manifest.json',
      data: Buffer.from('blocked'),
      kind: 'file',
      type: 'regular',
      executable: false,
    })

    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rechecks backend executable metadata before replacing an install', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    const backend = prepared.entries.find((entry) => entry.path === 'backend/entry')
    if (!backend) throw new Error('expected backend entry')
    backend.executable = false

    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/not marked executable/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })
})

describe('official (navide.) install policy', () => {
  const REQ_OFFICIAL = {
    registryUrl: 'http://localhost:8787',
    namespace: 'navide',
    name: 'mini-ide',
    version: '1.0.0',
  }

  function officialPkg(): { bytes: Uint8Array; digest: string } {
    return pkg([
      {
        name: 'manifest.json',
        data: manifest({ id: 'navide.mini-ide', name: 'Mini IDE', publisher: 'navide', entry: 'index.html' }),
      },
      { name: 'index.html', data: '<!doctype html>' },
    ])
  }

  function pem(key: KeyObject): string {
    return key.export({ type: 'spki', format: 'pem' }).toString()
  }

  function signWith(privateKey: KeyObject, digest: string): string {
    return edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
  }

  const official = generateKeyPairSync('ed25519')
  const rogue = generateKeyPairSync('ed25519')
  let envBefore: string | undefined

  beforeEach(() => {
    envBefore = process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = pem(official.publicKey)
  })

  afterEach(() => {
    if (envBefore === undefined) delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    else process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = envBefore
  })

  it('allows a navide. package signed by the pinned official key and writes a receipt', async () => {
    const { bytes, digest } = officialPkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(
      {
        ...REQ_OFFICIAL,
        expectedDigest: digest,
        signature: signWith(official.privateKey, digest),
        publicKey: pem(official.publicKey),
      },
      deps
    )
    expect(prepared.official).toBe(true)
    expect(prepared.trustTier).toBe('signed-verified')

    commitInstall(prepared, '/plugins', deps)
    const receiptRaw = writes.get('/plugins/navide.mini-ide/.navide-receipt.json')
    expect(receiptRaw).toBeDefined()
    const receipt = JSON.parse(Buffer.from(receiptRaw!).toString('utf8'))
    expect(receipt).toMatchObject({ id: 'navide.mini-ide', version: '1.0.0', digest })
    expect(typeof receipt.signature).toBe('string')
  })

  it('rejects a navide. package signed by a non-official key', async () => {
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        {
          ...REQ_OFFICIAL,
          expectedDigest: digest,
          signature: signWith(rogue.privateKey, digest),
          publicKey: pem(rogue.publicKey),
        },
        deps
      )
    ).rejects.toThrow(/official/)
  })

  it('rejects an unsigned navide. package', async () => {
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_OFFICIAL, expectedDigest: digest }, deps)
    ).rejects.toThrow(/official/)
  })

  // Without an override the pin is the shipped constant, so this test key is
  // rejected for mismatching it rather than for there being no pin at all —
  // which is what proves the constant is actually in force.
  it('rejects a navide. package signed by anything but the shipped pin', async () => {
    delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        {
          ...REQ_OFFICIAL,
          expectedDigest: digest,
          signature: signWith(official.privateKey, digest),
          publicKey: pem(official.publicKey),
        },
        deps
      )
    ).rejects.toThrow(/not signed by the pinned official publisher key/)
  })

  it('does not write a receipt for a third-party install', async () => {
    const { bytes, digest } = pkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.official).toBe(false)
    commitInstall(prepared, '/plugins', deps)
    expect([...writes.keys()].some((p) => p.endsWith('.navide-receipt.json'))).toBe(false)
  })

  it('refuses a package that smuggles its own .navide-receipt.json', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'x' },
      { name: '.navide-receipt.json', data: '{"id":"acme.demo"}' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/must not contain/)
  })
})

describe('removePlugin', () => {
  it('removes the plugin directory', () => {
    const { deps, removed } = fakeDeps(new Uint8Array())
    removePlugin('/plugins', 'acme.demo', deps)
    expect(removed).toContain('/plugins/acme.demo')
  })
})

describe('isUpdateAvailable', () => {
  it('detects a strictly-newer latest version', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpdateAvailable('1.0.0', '2.0.0')).toBe(true)
    expect(isUpdateAvailable('1.2.0', '1.10.0')).toBe(true)
    expect(isUpdateAvailable('1.2.3-alpha.1', '1.2.3')).toBe(true)
  })

  it('is false for same or older or missing versions', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false)
    expect(isUpdateAvailable('2.0.0', '1.9.9')).toBe(false)
    expect(isUpdateAvailable('1.2.3', '1.2.3+build.4')).toBe(false)
    expect(isUpdateAvailable('1.2.3-alpha+build.1', '1.2.3-alpha+build.2')).toBe(false)
    expect(isUpdateAvailable('1.0.0', null)).toBe(false)
    expect(isUpdateAvailable('1.0.0', 'not-semver')).toBe(false)
  })
})
