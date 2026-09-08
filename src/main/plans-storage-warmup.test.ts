import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLaunchDescriptor } from './plugins/frontendPluginManager'

// The Plans storage warm-up clones, re-reads and fsyncs one storage partition
// per workspace Plans has ever been opened in. Started at module evaluation it
// ran that filesystem burst on the libuv threadpool before the app was even
// ready, alongside the backend spawn's login-shell PATH probe. It must not
// start until the app is up.

const ipcChannels: string[] = []
const gateCalls: string[] = []

vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-plans-storage-warmup-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    // Never resolves: the app never becomes ready in this test, so anything
    // that still runs is running at module evaluation time.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] { return [] }
    static fromWebContents(): unknown { return null }
    static fromId(): unknown { return null }
  }
  return {
    app,
    BrowserWindow,
    dialog: {
      showMessageBox: () => Promise.resolve({ response: 0 }),
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    },
    ipcMain: {
      handle: (channel: string) => { ipcChannels.push(channel) },
      on: (channel: string) => { ipcChannels.push(channel) },
      removeHandler: () => {},
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
    Notification: class { static isSupported(): boolean { return false } show(): void {} },
    powerMonitor: { on: () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => {} } },
      fromPartition: () => ({}),
    },
    shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({ popup: () => {} }) },
  }
})

// Stand in for the real migration gate, so entering it is observable without
// touching the filesystem.
vi.mock('./plugins/plansStorageMigrationGate', () => ({
  createPlansStorageMigrationGate: () => (packageVersion: string) => {
    gateCalls.push(packageVersion)
    return Promise.resolve({ status: 'ready' })
  },
}))

// A test checkout has no built plugin bundles, so Plans would fall back to
// legacy recovery — a mode in which the migration returns before the gate and
// this test could never observe anything. Report the bundled package as
// registered and complete, the way a packaged launch does.
vi.mock('./plugins/frontendPluginManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugins/frontendPluginManager')>()
  return {
    ...actual,
    registerBundledPlans: () => ({ registered: true }),
    hasCompletePlansContributions: () => true,
  }
})

const plansDescriptor = {
  id: 'navide.plans',
  packageVersion: '1.2.3',
  packageDir: '/tmp/navide-plans-storage-warmup-test/navide-plans',
  requires: [],
  capabilityPolicy: { kind: 'manifest-v2', system: ['fs'] },
  devUrl: '',
  entryFile: '/tmp/navide-plans-storage-warmup-test/navide-plans/index.html',
} as unknown as PluginLaunchDescriptor

describe('Plans storage warm-up', () => {
  beforeEach(() => {
    ipcChannels.length = 0
    gateCalls.length = 0
    vi.resetModules()
  })

  it('does not run before the app is ready', { timeout: 60_000 }, async () => {
    const manager = await import('./plugins/frontendPluginManager')
    // A selected manifest-v2 Plans package is what makes the migration
    // reachable at all; without it the warm-up would return early and the
    // assertion below would hold for the wrong reason.
    const original = manager.frontendPluginManager.getDescriptor.bind(manager.frontendPluginManager)
    vi.spyOn(manager.frontendPluginManager, 'getDescriptor').mockImplementation((id: string) =>
      id === 'navide.plans' ? plansDescriptor : original(id)
    )

    await import('./index')

    // The module really did evaluate to the end, so the assertion below is
    // about ordering and not about a failed import.
    expect(ipcChannels).toContain('backend:info')
    expect(gateCalls).toEqual([])
  })
})
