// End-to-end coverage for the `plugins:prepareInstall` IPC handler, focused on
// the wire → verifier hand-off: the registry detail API speaks snake_case
// (`public_key` at the detail top level, `signature` on each version row) and
// `prepareInstall` takes camelCase (`publicKey`, `signature`). This proves the
// mapping is wired so a validly-signed package actually reaches
// `signed-verified`, a tampered/rotated signature hard-blocks, and missing
// material degrades to `unsigned` (fail-closed).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'

const { handlers, browserWindowFromWebContents } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  browserWindowFromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: browserWindowFromWebContents },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { isTrustedPluginManagementSender, registerPluginIpc } from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function buildPkg(requires: string[] = ['git']): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    engines: { navide: '^0.1.0' },
    entry: 'dist/main.js',
    requires,
  })
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'dist/main.js', data: 'console.log("demo")' },
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildBackendPkg(): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Demo backend', license: 'MIT' },
    backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
  })
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    {
      name: 'backend/entry',
      data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      unixMode: 0o100755,
    },
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}

function signB64(digest: string, privateKey: Parameters<typeof edSign>[2]): string {
  return edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
}

/** Detail JSON as the registry serialises it — snake_case, publisher-level key. */
interface WireDetail {
  latest_version: string | null
  public_key: string | null
  versions: Array<{
    version: string
    package_digest: string
    signature: string | null
    trust_tier: string
    yanked: boolean
  }>
}

/** A fetch that serves the detail endpoint and the package download from a
 *  single fixed package + detail body, routing by URL suffix. */
function installFetch(detail: WireDetail, bytes: Uint8Array, digest: string): void {
  global.fetch = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.endsWith('/download')) {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return ab
        },
        headers: { get: (h: string) => (h.toLowerCase() === 'x-package-digest' ? digest : null) },
      }
    }
    return { ok: true, status: 200, async json() { return detail } }
  }) as unknown as typeof fetch
}

function register(
  pluginsRoot = '/plugins',
  manager = new FrontendPluginManager()
): (...a: unknown[]) => unknown {
  registerPluginIpc(manager, pluginsRoot, () => true)
  const handler = handlers.get('plugins:prepareInstall')
  if (!handler) throw new Error('prepareInstall handler not registered')
  return handler
}

describe('plugin management sender authorization', () => {
  beforeEach(() => {
    handlers.clear()
    browserWindowFromWebContents.mockReset()
  })

  it('accepts only a live trusted Host top-level window', () => {
    const sender = {}
    const trustedWindow = { isDestroyed: () => false, webContents: sender }
    const trustedWindows = new Set([trustedWindow])
    browserWindowFromWebContents.mockReturnValue(trustedWindow)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(true)

    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: {} } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    const pluginSender = {}
    browserWindowFromWebContents.mockReturnValue(trustedWindow)
    expect(
      isTrustedPluginManagementSender(
        { sender: pluginSender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue({ isDestroyed: () => true, webContents: sender })
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)

    browserWindowFromWebContents.mockReturnValue(null)
    expect(
      isTrustedPluginManagementSender(
        { sender, senderFrame: { parent: null } } as never,
        trustedWindows as never
      )
    ).toBe(false)
  })

  it('rejects unauthorized senders on every plugins channel before side effects', async () => {
    const manager = {
      listDescriptors: vi.fn(),
      listInstalledPackages: vi.fn(),
      registerDescriptor: vi.fn(),
      registerInstalledPackage: vi.fn(),
      removeInstalledPlugin: vi.fn(),
    } as unknown as FrontendPluginManager
    const authorize = vi.fn(() => false)
    const fetchBefore = global.fetch
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(manager, '/plugins', authorize)

    const calls: Array<[string, unknown]> = [
      ['plugins:listInstalled', undefined],
      ['plugins:marketplaceSearch', 'demo'],
      ['plugins:prepareInstall', { namespace: 'acme', name: 'demo' }],
      ['plugins:commitInstall', { id: 'acme.demo', confirmed: true }],
      ['plugins:remove', { id: 'acme.demo' }],
    ]
    try {
      for (const [channel, args] of calls) {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`${channel} handler not registered`)
        await expect(
          Promise.resolve().then(() => handler({ unauthorized: true }, args))
        ).rejects.toThrow(/unauthorized plugin management request/)
      }
      expect(authorize).toHaveBeenCalledTimes(calls.length)
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listDescriptors).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages).not.toHaveBeenCalled()
      expect(manager.registerDescriptor).not.toHaveBeenCalled()
      expect(manager.registerInstalledPackage).not.toHaveBeenCalled()
      expect(manager.removeInstalledPlugin).not.toHaveBeenCalled()
    } finally {
      global.fetch = fetchBefore
    }
  })
})

describe('plugins:prepareInstall wire → verifier mapping', () => {
  const savedFetch = global.fetch
  beforeEach(() => handlers.clear())
  afterEach(() => {
    global.fetch = savedFetch
    vi.restoreAllMocks()
  })

  it('(a) threads version-row signature + detail public_key → signed-verified', async () => {
    const { bytes, digest } = buildPkg()
    const { pubPem, privateKey } = keypair()
    const detail: WireDetail = {
      latest_version: '1.0.0',
      public_key: pubPem, // detail top-level (publisher key)
      versions: [
        {
          version: '1.0.0',
          package_digest: digest,
          signature: signB64(digest, privateKey), // version-row signature
          trust_tier: 'signed-verified',
          yanked: false,
        },
      ],
    }
    installFetch(detail, bytes, digest)
    const res = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(res.trustTier).toBe('signed-verified')
  })

  it('(b) tampered signature hard-blocks with SIGNATURE_INVALID (no downgrade)', async () => {
    const { bytes, digest } = buildPkg()
    const { pubPem, privateKey } = keypair()
    const detail: WireDetail = {
      latest_version: '1.0.0',
      public_key: pubPem,
      versions: [
        {
          version: '1.0.0',
          package_digest: digest,
          signature: signB64('deadbeef'.repeat(8), privateKey), // signs a different digest
          trust_tier: 'signed-verified',
          yanked: false,
        },
      ],
    }
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /signature/i
    )
  })

  it('(c) no signing material → unsigned (fail-closed, not blocked)', async () => {
    const { bytes, digest } = buildPkg()
    const detail: WireDetail = {
      latest_version: '1.0.0',
      public_key: null,
      versions: [
        {
          version: '1.0.0',
          package_digest: digest,
          signature: null,
          trust_tier: 'unsigned',
          yanked: false,
        },
      ],
    }
    installFetch(detail, bytes, digest)
    const res = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(res.trustTier).toBe('unsigned')
  })

  it('rotated publisher key (sig valid, detail public_key mismatched) → SIGNATURE_INVALID', async () => {
    const { bytes, digest } = buildPkg()
    const signer = keypair() // package signed with this key
    const rotated = keypair() // registry now advertises a different key
    const detail: WireDetail = {
      latest_version: '1.0.0',
      public_key: rotated.pubPem, // mismatched → verify must fail-closed, not downgrade
      versions: [
        {
          version: '1.0.0',
          package_digest: digest,
          signature: signB64(digest, signer.privateKey),
          trust_tier: 'signed-verified',
          yanked: false,
        },
      ],
    }
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /signature/i
    )
  })

  it('requires an explicit commit confirmation for a backend package', async () => {
    const { bytes, digest } = buildBackendPkg()
    const detail: WireDetail = {
      latest_version: '1.0.0',
      public_key: null,
      versions: [
        {
          version: '1.0.0',
          package_digest: digest,
          signature: null,
          trust_tier: 'unsigned',
          yanked: false,
        },
      ],
    }
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-ipc-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as {
        containsBackendExecutable: boolean
        requiresConfirmation: boolean
      }
      expect(prepared.containsBackendExecutable).toBe(true)
      expect(prepared.requiresConfirmation).toBe(true)

      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      expect(() => commitHandler(null, { id: 'acme.demo' })).toThrow(/confirmation is required/)
      expect(commitHandler(null, { id: 'acme.demo', confirmed: true })).toEqual({
        id: 'acme.demo',
        requires: [],
      })
      expect(existsSync(join(root, 'acme.demo', 'backend', 'entry'))).toBe(true)

      const listHandler = handlers.get('plugins:listInstalled')
      const removeHandler = handlers.get('plugins:remove')
      if (!listHandler || !removeHandler) throw new Error('inventory handlers not registered')
      expect(listHandler(null)).toEqual([{ id: 'acme.demo', requires: [], sensitive: [] }])

      expect(removeHandler(null, { id: 'acme.demo' })).toEqual({ ok: true })
      expect(listHandler(null)).toEqual([])
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
