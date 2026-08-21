// End-to-end coverage for the `plugins:prepareInstall` IPC handler, focused on
// the wire → verifier hand-off: the registry detail API speaks snake_case
// (`public_key` at the detail top level, `signature` on each version row) and
// `prepareInstall` takes camelCase (`publicKey`, `signature`). This proves the
// mapping is wired so a validly-signed package actually reaches
// `signed-verified`, a tampered/rotated signature hard-blocks, and missing
// material remains `unsigned` only on the legacy v1 compatibility path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256Hex } from './pluginVerify'
import { registryRootFingerprint } from './pluginRegistryRootApproval'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  readRegistryTrustSnapshot,
  registryReceiptFromEvidence,
  verifyInstalledRegistryPackage,
} from './pluginInstalledTrust'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { defaultInstallerDeps, type InstallerTrustConfig } from './pluginInstaller'
import type { PluginActivationCatalogEntry } from './installedPlugins'
import { projectBackendPluginActivationCatalog } from './pluginBackendActivationCatalog'
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

import {
  isTrustedPluginManagementSender,
  registerPluginIpc,
  resolveConfiguredMarketplace,
} from './pluginIpc'
import { FrontendPluginManager } from './frontendPluginManager'

function buildPkg(
  packageId = 'acme.demo',
  publisherId = 'acme'
): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: packageId,
    name: 'Demo',
    version: '1.0.0',
    publisher: publisherId,
    permissions: {},
    marketplace: { description: 'Demo frontend', license: 'MIT' },
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
  })
  const zip = makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ])
  const bytes = new Uint8Array(zip)
  return { bytes, digest: sha256Hex(bytes) }
}

function buildReservedPkg(): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'navide.spoof',
    name: 'Spoof',
    version: '1.0.0',
    publisher: 'navide',
    permissions: {},
    marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Spoof',
          entry: 'frontend/left/index.html',
        },
      ],
    },
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
  )
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

function buildLegacyPkg(requires: string[] = []): { bytes: Uint8Array; digest: string } {
  const manifest = JSON.stringify({
    id: 'acme.demo',
    version: '1.0.0',
    publisher: 'acme',
    requires,
    entry: 'dist/main.js',
  })
  const bytes = new Uint8Array(
    makeZip([
      { name: 'manifest.json', data: manifest },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ])
  )
  return { bytes, digest: sha256Hex(bytes) }
}

function keypair(): { pubPem: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pubPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}

function signCanonical(value: unknown, privateKey: Parameters<typeof edSign>[2]): string {
  return edSign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), privateKey).toString('base64')
}

const registryRoot = keypair()
const registrySigner = keypair()
const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z')
const TRUST_CONFIG: InstallerTrustConfig = {
  pinnedRegistryRootKey: registryRoot.pubPem,
  now: FIXED_NOW,
}

/** Detail JSON as the central-signing registry serialises it. */
interface WireDetail {
  latest_version: string | null
  trust_metadata: RegistryTrustMetadata
  trust_metadata_signature: string
  versions: Array<{
    version: string
    package_digest: string
    target: string
    registry_envelope: RegistryPackageEnvelope
    registry_signature: string | null
    trust_tier: string
    yanked: boolean
  }>
}

function signedDetail(
  digest: string,
  packageId = 'acme.demo',
  publisherId = 'acme'
): WireDetail {
  const registryEnvelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId,
    version: '1.0.0',
    target: 'universal',
    publisherId,
    keyId: 'registry-test-1',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  const trustMetadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [
      {
        keyId: 'registry-test-1',
        publicKey: registrySigner.pubPem,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      },
    ],
    blockedPublishers: [],
    blockedPackages: [],
  }
  return {
    latest_version: '1.0.0',
    trust_metadata: trustMetadata,
    trust_metadata_signature: signCanonical(trustMetadata, registryRoot.privateKey),
    versions: [
      {
        version: '1.0.0',
        package_digest: digest,
        target: 'universal',
        registry_envelope: registryEnvelope,
        registry_signature: signCanonical(registryEnvelope, registrySigner.privateKey),
        trust_tier: 'signed-verified',
        yanked: false,
      },
    ],
  }
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
  registerPluginIpc(manager, pluginsRoot, () => true, TRUST_CONFIG)
  const handler = handlers.get('plugins:prepareInstall')
  if (!handler) throw new Error('prepareInstall handler not registered')
  return handler
}

async function installRegistryEvidence(
  root: string,
  bytes: Uint8Array,
  digest: string,
  detail = signedDetail(digest),
  namespace = 'acme',
  name = 'demo'
): Promise<void> {
  installFetch(detail, bytes, digest)
  const manager = new FrontendPluginManager()
  registerPluginIpc(manager, root, () => true, TRUST_CONFIG)
  const prepareHandler = handlers.get('plugins:prepareInstall')
  const commitHandler = handlers.get('plugins:commitInstall')
  if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
  await prepareHandler(null, { namespace, name })
  commitHandler(null, { id: `${namespace}.${name}`, publisherConfirmed: true })
  manager.removeInstalledPlugin(`${namespace}.${name}`)
  handlers.clear()
}

function writeExpiredTrustSnapshot(root: string): void {
  const detail = signedDetail('0'.repeat(64))
  const metadata: RegistryTrustMetadata = {
    ...detail.trust_metadata,
    generatedAt: '2026-08-14T10:00:00.000Z',
    expiresAt: '2026-08-15T10:00:00.000Z',
  }
  writeFileSync(
    join(root, '.navide-registry-trust.json'),
    JSON.stringify({
      schemaVersion: 1,
      metadata,
      metadataSignature: signCanonical(metadata, registryRoot.privateKey),
    })
  )
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

describe('plugins:remove boundary validation', () => {
  beforeEach(() => handlers.clear())

  it('rejects malformed ids before deleting or changing activation state', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-invalid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'keep.txt'), 'keep')
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      const invalidIds: unknown[] = [
        '',
        '.',
        '..',
        '/',
        '\\',
        '../acme.demo',
        '..\\acme.demo',
        '/tmp/acme.demo',
        'acme.demo/..',
        'acme.%2e',
        '%2e%2e',
        'Acme.demo',
        'acme',
        'acme..demo',
        'acme.demo.',
        null,
        42,
      ]
      for (const id of invalidIds) {
        expect(() => removeHandler(null, { id })).toThrow(/invalid plugin id/)
      }
      expect(() => removeHandler(null, null)).toThrow(/invalid plugin id/)
      expect(existsSync(installedDir)).toBe(true)
      expect(removeInstalledPlugin).not.toHaveBeenCalled()
      expect(onActivationChange).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes a valid direct-child id and clears its activation state', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-remove-valid-'))
    const installedDir = join(root, 'acme.demo')
    mkdirSync(installedDir, { recursive: true })
    const manager = new FrontendPluginManager()
    const removeInstalledPlugin = vi.spyOn(manager, 'removeInstalledPlugin')
    const onActivationChange = vi.fn()
    try {
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange,
      })
      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')

      expect(removeHandler(null, { id: 'acme.demo' })).toEqual({ ok: true })
      expect(existsSync(installedDir)).toBe(false)
      expect(removeInstalledPlugin).toHaveBeenCalledWith('acme.demo')
      expect(onActivationChange).toHaveBeenCalledWith({ pluginId: 'acme.demo' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('plugins:prepareInstall wire → verifier mapping', () => {
  const savedFetch = global.fetch
  const savedMarketplaceUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
  const savedRootApprovalFile = process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
  beforeEach(() => handlers.clear())
  afterEach(() => {
    global.fetch = savedFetch
    if (savedMarketplaceUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    else process.env['AGENT_TEAM_MARKETPLACE_URL'] = savedMarketplaceUrl
    if (savedRootApprovalFile === undefined) {
      delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    } else {
      process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = savedRootApprovalFile
    }
    vi.restoreAllMocks()
  })

  it('rejects an unapproved custom Registry before making a network request', async () => {
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    delete process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE']
    global.fetch = vi.fn() as unknown as typeof fetch
    registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true)
    const handler = handlers.get('plugins:prepareInstall')
    if (!handler) throw new Error('prepareInstall handler not registered')

    await expect(handler(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /explicit root approval/
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('uses a separately approved custom Registry root instead of response metadata', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-custom-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://registry.acme.test',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.acme.test'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      registerPluginIpc(new FrontendPluginManager(), '/plugins', () => true, TRUST_CONFIG)
      const handler = handlers.get('plugins:prepareInstall')
      if (!handler) throw new Error('prepareInstall handler not registered')
      await expect(handler(null, { namespace: 'acme', name: 'demo' })).resolves.toMatchObject({
        trustTier: 'signed-verified',
        requiresPublisherTrust: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses an approved self-hosted root for the default local Registry profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-local-registry-'))
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'http://localhost:8787',
        rootPublicKeyPem: registryRoot.pubPem,
        confirmedFingerprint: registryRootFingerprint(registryRoot.pubPem),
      })
    )
    delete process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile

    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'http://localhost:8787',
        trust: { pinnedRegistryRootKey: registryRoot.pubPem },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads the Official Registry root from packaged resources, not runtime approval', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-packaged-root-'))
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'official-registry-root.pem'), registryRoot.pubPem)
    const approvalFile = join(root, 'root-approval.json')
    writeFileSync(
      approvalFile,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://registry.navide.dev',
        rootPublicKeyPem: registrySigner.pubPem,
        confirmedFingerprint: registryRootFingerprint(registrySigner.pubPem),
      })
    )
    const previousResourcesDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'resourcesPath'
    )
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: root,
    })
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.navide.dev'
    process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'] = approvalFile
    try {
      expect(resolveConfiguredMarketplace()).toMatchObject({
        registryUrl: 'https://registry.navide.dev',
        trust: {
          pinnedRegistryRootKey: registryRoot.pubPem,
          registryAuthority: 'official',
        },
      })
    } finally {
      if (previousResourcesDescriptor) {
        Object.defineProperty(process, 'resourcesPath', previousResourcesDescriptor)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not activate a self-hosted reserved package after restart', () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    const root = mkdtempSync(join(tmpdir(), 'navide-reserved-restart-'))
    const pluginDir = join(root, 'navide.spoof')
    mkdirSync(join(pluginDir, 'frontend', 'left'), { recursive: true })
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        apiVersion: '^1.0.0',
        id: 'navide.spoof',
        name: 'Spoof',
        version: '1.0.0',
        publisher: 'navide',
        permissions: {},
        marketplace: { description: 'Reserved namespace spoof', license: 'MIT' },
        contributes: {
          views: [
            {
              id: 'left',
              kind: 'custom',
              location: 'left',
              title: 'Spoof',
              entry: 'frontend/left/index.html',
            },
          ],
        },
      })
    )
    writeFileSync(join(pluginDir, 'frontend', 'left', 'index.html'), '<!doctype html>')
    writeFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME), bytes)
    writeFileSync(
      join(pluginDir, REGISTRY_RECEIPT_NAME),
      JSON.stringify(
        registryReceiptFromEvidence({
          packageId: 'navide.spoof',
          version: '1.0.0',
          publisherId: 'navide',
          target: 'universal',
          artifactDigest: digest,
          envelope: detail.versions[0].registry_envelope,
          envelopeSignature: detail.versions[0].registry_signature ?? '',
          registryAuthority: 'self-hosted',
        })
      )
    )
    writeFileSync(
      join(root, REGISTRY_TRUST_SNAPSHOT_NAME),
      JSON.stringify({
        schemaVersion: 1,
        metadata: detail.trust_metadata,
        metadataSignature: detail.trust_metadata_signature,
      })
    )
    try {
      const manager = new FrontendPluginManager()
      const loaded = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          registryAuthority: 'self-hosted',
          officialRegistryUrl: 'https://registry.navide.dev',
          now: FIXED_NOW,
        },
      })
      expect(loaded.loaded).toEqual([])
      expect(loaded.activationCatalog).toEqual([])
      expect(loaded.errors.join(' ')).toMatch(/App-authorized Official Registry/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('(a) verifies the root-authorized Registry envelope → signed-verified', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    installFetch(detail, bytes, digest)
    const res = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(res.trustTier).toBe('signed-verified')
  })

  it('(b) a forged Registry signature hard-blocks without downgrade', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = signCanonical(
      { ...detail.versions[0].registry_envelope, artifactDigest: 'deadbeef'.repeat(8) },
      registrySigner.privateKey
    )
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /signature/i
    )
  })

  it('(c) missing Registry signing material fails closed for v2', async () => {
    const { bytes, digest } = buildPkg()
    const detail = signedDetail(digest)
    detail.versions[0].registry_signature = null
    installFetch(detail, bytes, digest)
    await expect(register()(null, { namespace: 'acme', name: 'demo' })).rejects.toThrow(
      /missing Registry signatures/i
    )
  })

  it('ignores arbitrary publisher key material when the Registry chain is valid', async () => {
    const { bytes, digest } = buildPkg()
    const detail = Object.assign(signedDetail(digest), { public_key: keypair().pubPem })
    Object.assign(detail.versions[0], { signature: 'attacker-controlled' })
    installFetch(detail, bytes, digest)
    const result = (await register()(null, { namespace: 'acme', name: 'demo' })) as {
      trustTier: string
    }
    expect(result.trustTier).toBe('signed-verified')
  })

  it('requires an explicit commit confirmation for a backend package', async () => {
    const { bytes, digest } = buildBackendPkg()
    const detail = signedDetail(digest)
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
      expect(() => commitHandler(null, { id: 'acme.demo' })).toThrow(
        /publisher trust confirmation/
      )
      expect(() =>
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).toThrow(/capability and backend risk confirmation/)
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({
        id: 'acme.demo',
        requires: [],
      })
      expect(existsSync(join(root, 'acme.demo', 'backend', 'entry'))).toBe(true)

      const listHandler = handlers.get('plugins:listInstalled')
      const removeHandler = handlers.get('plugins:remove')
      if (!listHandler || !removeHandler) throw new Error('inventory handlers not registered')
      expect(listHandler(null)).toEqual([{
        id: 'acme.demo',
        requires: [],
        sensitive: [],
        provenance: 'official-registry',
      }])

      expect(removeHandler(null, { id: 'acme.demo' })).toEqual({ ok: true })
      expect(listHandler(null)).toEqual([])
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires publisher consent for a Registry v1 package even with legacy non-sensitive requires', async () => {
    const { bytes, digest } = buildLegacyPkg(['git'])
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-v1-publisher-consent-'))
    try {
      const manager = new FrontendPluginManager()
      const prepareHandler = register(root, manager)
      const prepared = (await prepareHandler(null, {
        namespace: 'acme',
        name: 'demo',
      })) as { requiresPublisherTrust: boolean; requiresConfirmation: boolean }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(prepared.requiresConfirmation).toBe(false)
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!commitHandler) throw new Error('commitInstall handler not registered')
      expect(() => commitHandler(null, { id: 'acme.demo' })).toThrow(/publisher trust confirmation/)
      expect(commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })).toEqual({
        id: 'acme.demo',
        requires: ['git'],
      })
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: ['git'], provenance: 'official-registry' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects only a verified same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-activation-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [] })

      expect(
        projectBackendPluginActivationCatalog([...active.values()])
      ).toMatchObject({
        schemaVersion: 1,
        packages: [
          {
            pluginId: 'acme.demo',
            packageVersion: '1.0.0',
            packageDir: join(root, 'acme.demo'),
            artifactDigest: digest,
            backend: {
              entryFile: join(root, 'acme.demo', 'backend', 'entry'),
              protocolVersion: 1,
              activation: 'startup',
            },
          },
        ],
      })

      const removeHandler = handlers.get('plugins:remove')
      if (!removeHandler) throw new Error('remove handler not registered')
      expect(removeHandler(null, { id: 'acme.demo' })).toEqual({ ok: true })
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears the prior activation before adding a replacement backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-replace-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [] })
      changes.length = 0

      installFetch(signedDetail(digest), bytes, digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [] })

      expect(changes.map(({ activation }) => (activation ? 'add' : 'clear'))).toEqual([
        'clear',
        'add',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    [
      'package write',
      () => {
        vi.spyOn(defaultInstallerDeps, 'writeFile').mockImplementation(() => {
          throw new Error('test package write failure')
        })
      },
    ],
    [
      'Registry trust snapshot write',
      () => {
        vi.spyOn(
          defaultInstallerDeps as Required<typeof defaultInstallerDeps>,
          'writeRegistryTrustSnapshot'
        ).mockImplementation(() => {
          throw new Error('test trust snapshot failure')
        })
      },
    ],
  ] as const)('restores the previous install when %s fails after a replacement starts', async (_label, injectFailure) => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-install-failure-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [] })
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
      expect(active.has('acme.demo')).toBe(true)

      installFetch(signedDetail(digest), bytes, digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      injectFailure()

      expect(() =>
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toThrow(/test .* failure/)
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
      expect(active.has('acme.demo')).toBe(true)
      expect(projectBackendPluginActivationCatalog([...active.values()]).packages).toEqual([
        expect.objectContaining({
          pluginId: 'acme.demo',
          packageDir: join(root, 'acme.demo'),
          artifactDigest: digest,
        }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the previous install when post-commit verification throws after a replacement starts', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-failure-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    let failVerification = false
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => {
          if (failVerification) throw new Error('test post-commit verification failure')
          return { action: 'allow', artifactDigest: digest }
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toEqual({ id: 'acme.demo', requires: [] })
      expect(active.has('acme.demo')).toBe(true)

      installFetch(signedDetail(digest), bytes, digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      failVerification = true

      expect(() =>
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toThrow(/test post-commit verification failure/)
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
      expect(active.has('acme.demo')).toBe(true)
      expect(projectBackendPluginActivationCatalog([...active.values()]).packages).toEqual([
        expect.objectContaining({
          pluginId: 'acme.demo',
          packageDir: join(root, 'acme.demo'),
          artifactDigest: digest,
        }),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['v2 frontend-only', buildPkg],
    ['legacy v1', buildLegacyPkg],
  ])('clears a prior backend activation when replaced by %s', async (_label, buildReplacement) => {
    const backend = buildBackendPkg()
    installFetch(signedDetail(backend.digest), backend.bytes, backend.digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-downgrade-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => {
          changes.push(change)
          active.delete(change.pluginId)
          if (change.activation) active.set(change.pluginId, change.activation)
        },
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      commitHandler(null, {
        id: 'acme.demo',
        publisherConfirmed: true,
        riskConfirmed: true,
      })
      expect(active.get('acme.demo')?.backend).toBeDefined()
      changes.length = 0

      const replacement = buildReplacement()
      installFetch(signedDetail(replacement.digest), replacement.bytes, replacement.digest)
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(commitHandler(null, { id: 'acme.demo' })).toEqual({
        id: 'acme.demo',
        requires: [],
      })

      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
      expect(active.has('acme.demo')).toBe(false)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not project a quarantined same-session backend activation', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-same-session-quarantine-'))
    const active = new Map<string, PluginActivationCatalogEntry>()
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: ({ pluginId, activation }) => {
          active.delete(pluginId)
          if (activation) active.set(pluginId, activation)
        },
        verifyCommittedInstall: () => ({
          action: 'quarantine',
          reason: 'test quarantine',
        }),
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')

      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      expect(() =>
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toThrow(/installed plugin quarantined/)
      expect(projectBackendPluginActivationCatalog([...active.values()])).toEqual({
        schemaVersion: 1,
        packages: [],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries Official Registry authority through post-commit verification', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-post-commit-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.navide.dev'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://registry.navide.dev',
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      const prepared = (await prepareHandler(null, { namespace: 'acme', name: 'demo' })) as {
        requiresPublisherTrust: boolean
      }
      expect(prepared.requiresPublisherTrust).toBe(true)
      expect(
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).toEqual({ id: 'acme.demo', requires: [] })
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not require publisher consent for an authorized first-party identity', async () => {
    const { bytes, digest } = buildReservedPkg()
    const detail = signedDetail(digest, 'navide.spoof', 'navide')
    installFetch(detail, bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-official-publisher-trust-'))
    const previousUrl = process.env['AGENT_TEAM_MARKETPLACE_URL']
    process.env['AGENT_TEAM_MARKETPLACE_URL'] = 'https://registry.navide.dev'
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(manager, root, () => true, {
        ...TRUST_CONFIG,
        registryAuthority: 'official',
        officialRegistryUrl: 'https://registry.navide.dev',
      })
      const prepareHandler = handlers.get('plugins:prepareInstall')
      if (!prepareHandler) throw new Error('prepareInstall handler not registered')
      const prepared = (await prepareHandler(null, {
        namespace: 'navide',
        name: 'spoof',
      })) as { requiresPublisherTrust: boolean }
      expect(prepared.requiresPublisherTrust).toBe(false)
    } finally {
      if (previousUrl === undefined) delete process.env['AGENT_TEAM_MARKETPLACE_URL']
      else process.env['AGENT_TEAM_MARKETPLACE_URL'] = previousUrl
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-verifies committed files before registration and quarantines tampering', async () => {
    const { bytes, digest } = buildBackendPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-post-commit-'))
    try {
      const manager = new FrontendPluginManager()
      registerPluginIpc(
        manager,
        root,
        () => true,
        TRUST_CONFIG,
        undefined,
        {
          verifyCommittedInstall: (pluginDir, pluginId, trust) => {
            writeFileSync(join(pluginDir, 'backend', 'entry'), 'tampered after commit')
            return verifyInstalledRegistryPackage(pluginDir, pluginId, {
              pinnedRootKey: trust.pinnedRegistryRootKey,
              snapshot: readRegistryTrustSnapshot(root),
              now: trust.now,
            })
          },
        }
      )
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })

      expect(() =>
        commitHandler(null, {
          id: 'acme.demo',
          publisherConfirmed: true,
          riskConfirmed: true,
        })
      ).toThrow(/installed package file was modified/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(join(root, 'acme.demo', '.navide-package.zip'))).toBe(false)
      expect(existsSync(join(root, '.navide-quarantine'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not resurrect a package when trust expires after prepare', async () => {
    const { bytes, digest } = buildPkg()
    installFetch(signedDetail(digest), bytes, digest)
    const root = mkdtempSync(join(tmpdir(), 'navide-expired-after-prepare-'))
    const installTrust: InstallerTrustConfig = { ...TRUST_CONFIG, now: new Date(FIXED_NOW) }
    try {
      const manager = new FrontendPluginManager()
      const controller = registerPluginIpc(manager, root, () => true, installTrust)
      const prepareHandler = handlers.get('plugins:prepareInstall')
      const commitHandler = handlers.get('plugins:commitInstall')
      if (!prepareHandler || !commitHandler) throw new Error('install handlers not registered')
      await prepareHandler(null, { namespace: 'acme', name: 'demo' })
      installTrust.now = new Date('2026-08-18T12:00:00.000Z')
      expect(() =>
        commitHandler(null, { id: 'acme.demo', publisherConfirmed: true })
      ).toThrow(/expired/)
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)

      await expect(controller.refreshRegistryTrust()).resolves.toMatchObject({
        decisions: [],
        activationCatalog: [],
      })
      expect(manager.listInstalledPackages()).toEqual([])
      expect(existsSync(join(root, 'acme.demo'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an expired-cache package inactive until online refresh restores it', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      writeExpiredTrustSnapshot(root)
      const manager = new FrontendPluginManager()
      const expiredLoad = manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(expiredLoad.activationCatalog).toEqual([])
      expect(manager.listInstalledPackages()).toEqual([])

      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(refreshed.activationCatalog).toHaveLength(1)
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an expired-cache package quarantined when trust refresh fails', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-fail-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
      writeExpiredTrustSnapshot(root)
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an active package while a still-valid cached snapshot survives refresh failure', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-cache-'))
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      global.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      await expect(controller.refreshRegistryTrust()).rejects.toThrow(/HTTP 503/)
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips an expired HTTP 200 candidate and accepts the next valid candidate', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-invalid-candidate-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const validFirst = signedDetail(first.digest)
      const expiredMetadata: RegistryTrustMetadata = {
        ...validFirst.trust_metadata,
        generatedAt: '2026-08-14T10:00:00.000Z',
        expiresAt: '2026-08-15T10:00:00.000Z',
      }
      const expiredFirst: WireDetail = {
        ...validFirst,
        trust_metadata: expiredMetadata,
        trust_metadata_signature: signCanonical(expiredMetadata, registryRoot.privateKey),
      }
      const validSecond = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: true, status: 200, async json() { return expiredFirst } }
        }
        return { ok: true, status: 200, async json() { return validSecond } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
      expect(readRegistryTrustSnapshot(root)?.metadata).toEqual(validSecond.trust_metadata)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('continues trust metadata refresh when the first installed package detail is missing', async () => {
    const first = buildPkg()
    const second = buildPkg('beta.other', 'beta')
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-candidates-'))
    try {
      await installRegistryEvidence(root, first.bytes, first.digest)
      await installRegistryEvidence(
        root,
        second.bytes,
        second.digest,
        signedDetail(second.digest, 'beta.other', 'beta'),
        'beta',
        'other'
      )
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(second.digest, 'beta.other', 'beta')
      global.fetch = vi.fn(async (url: unknown) => {
        if (String(url).includes('/api/extensions/acme/demo')) {
          return { ok: false, status: 404 }
        }
        return { ok: true, status: 200, async json() { return detail } }
      }) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG)

      const refreshed = await controller.refreshRegistryTrust()
      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: first.digest },
        { pluginId: 'beta.other', action: 'allow', artifactDigest: second.digest },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package whose directory disappeared without a network candidate', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-missing-dir-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      rmSync(join(root, 'acme.demo'), { recursive: true, force: true })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/missing/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an active Registry package with a malformed manifest before refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-malformed-manifest-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      writeFileSync(join(root, 'acme.demo', 'manifest.json'), '{malformed')
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toMatchObject([
        {
          pluginId: 'acme.demo',
          action: 'quarantine',
          reason: expect.stringMatching(/malformed/),
        },
      ])
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.demo' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reconciles active Registry state even when there are zero safe candidates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-zero-candidates-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      const manager = new FrontendPluginManager()
      manager.registerInstalledPackage({
        id: 'acme.orphan',
        requires: [],
        provenance: 'official-registry',
      })
      global.fetch = vi.fn() as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed).toMatchObject({
        decisions: [
          {
            pluginId: 'acme.orphan',
            action: 'quarantine',
          },
        ],
        activationCatalog: [],
      })
      expect(global.fetch).not.toHaveBeenCalled()
      expect(manager.listInstalledPackages()).toEqual([])
      expect(changes).toEqual([{ pluginId: 'acme.orphan' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a valid active Registry package after trust refresh', async () => {
    const { bytes, digest } = buildPkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-trust-refresh-valid-active-'))
    const changes: Array<{ pluginId: string; activation?: PluginActivationCatalogEntry }> = []
    try {
      await installRegistryEvidence(root, bytes, digest)
      const manager = new FrontendPluginManager()
      manager.loadInstalledPlugins(root, {
        provenance: 'official-registry',
        trust: {
          pinnedRootKey: registryRoot.pubPem,
          snapshot: readRegistryTrustSnapshot(root),
          now: FIXED_NOW,
        },
      })
      const detail = signedDetail(digest)
      global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return detail
        },
      })) as unknown as typeof fetch
      const controller = registerPluginIpc(manager, root, () => true, TRUST_CONFIG, undefined, {
        onActivationChange: (change) => changes.push(change),
      })

      const refreshed = await controller.refreshRegistryTrust()
      expect(refreshed.decisions).toEqual([
        { pluginId: 'acme.demo', action: 'allow', artifactDigest: digest },
      ])
      expect(manager.listInstalledPackages()).toEqual([
        { id: 'acme.demo', requires: [], provenance: 'official-registry' },
      ])
      expect(changes).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
