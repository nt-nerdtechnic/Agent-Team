import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLaunchDescriptor } from './plugins/frontendPluginManager'

// The main process registers every IPC handler at module evaluation. A
// synchronous store write that runs before them and throws (read-only, full or
// EPERM userData) used to abort the whole module, so the App came up with no
// backend, no menus and no error surface at all. These tests drive the real
// `src/main/index.ts` module with a grant store that refuses to write.

const ipcChannels: string[] = []
const grantWrites: string[] = []

vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => '/tmp/navide-startup-grant-failure-test',
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    // Never resolves: this test is about module evaluation, not app readiness.
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

vi.mock('./plugins/pluginCapabilityGrantStore', () => ({
  PluginCapabilityGrantStore: class {
    get(): null { return null }
    set(pluginId: string): void {
      grantWrites.push(pluginId)
      throw new Error("EACCES: permission denied, open '.navide-capability-grants.json'")
    }
    remove(): void {}
  },
}))

const plansDescriptor = {
  id: 'navide.plans',
  packageVersion: '1.2.3',
  packageDir: '/tmp/navide-startup-grant-failure-test/navide-plans',
  requires: [],
  capabilityPolicy: { kind: 'manifest-v2', system: ['fs'] },
  devUrl: '',
  entryFile: '/tmp/navide-startup-grant-failure-test/navide-plans/index.html',
} as unknown as PluginLaunchDescriptor

describe('main process startup with an unwritable capability grant store', () => {
  beforeEach(() => {
    ipcChannels.length = 0
    grantWrites.length = 0
    vi.resetModules()
  })

  it('still registers IPC handlers when the navide.plans grant write throws', { timeout: 60_000 }, async () => {
    const manager = await import('./plugins/frontendPluginManager')
    const original = manager.frontendPluginManager.getDescriptor.bind(manager.frontendPluginManager)
    vi.spyOn(manager.frontendPluginManager, 'getDescriptor').mockImplementation((id: string) =>
      id === 'navide.plans' ? plansDescriptor : original(id)
    )

    await import('./index')

    // The failing write really was attempted, so the guard below is load-bearing.
    expect(grantWrites).toContain('navide.plans')
    // Handlers registered after the grant write must still exist.
    expect(ipcChannels).toContain('backend:info')
    expect(ipcChannels).toContain('backend:restart')
  })
})
