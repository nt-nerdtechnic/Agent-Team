import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The Plans lifecycle-record repair discards durable Host state. It is exposed
// to the renderer, so it must carry the same sender trust check as the Git
// recovery retry it is modelled on: an untrusted sender may not reach it.

const userDataRoot = mkdtempSync(join(tmpdir(), 'plans-repair-ipc-'))
const lifecyclePath = join(userDataRoot, 'plugin-storage-v2', 'plans-lifecycle.json')
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const gateCalls: string[] = []

vi.mock('electron', () => {
  const app = {
    isPackaged: false,
    getPath: () => userDataRoot,
    setPath: () => {},
    getName: () => 'Navide',
    getVersion: () => '0.0.0-test',
    on: () => {},
    once: () => {},
    setName: () => {},
    // Never resolves: nothing that waits for app-ready runs in this test.
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: () => {} },
    setAboutPanelOptions: () => {},
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] { return [] }
    // No window owns the sender, so the trust check must refuse it.
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
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      },
      on: () => {},
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

// Stand in for the real migration gate, so a repair reaching it is observable
// without touching plugin storage.
vi.mock('./plugins/plansStorageMigrationGate', () => ({
  createPlansStorageMigrationGate: () => (packageVersion: string) => {
    gateCalls.push(packageVersion)
    return Promise.resolve({ status: 'ready' })
  },
}))

afterAll(() => rmSync(userDataRoot, { recursive: true, force: true }))

describe('Plans storage record repair IPC', () => {
  it('refuses an untrusted sender and leaves the record untouched', async () => {
    mkdirSync(join(userDataRoot, 'plugin-storage-v2'), { recursive: true })
    writeFileSync(lifecyclePath, '{broken')

    await import('./index')

    const repair = handlers.get('plans:repairStorageRecord')
    expect(repair, 'the repair has no operator entry point').toBeTypeOf('function')

    const result = await repair!({ sender: {}, senderFrame: { parent: null } })

    expect(result).toEqual({ ok: false, repaired: false, reason: 'untrusted sender' })
    // The unreadable record survives: an untrusted renderer cannot discard
    // durable Host state, and the gate was never re-run for it.
    expect(readFileSync(lifecyclePath, 'utf8')).toBe('{broken')
    expect(gateCalls).toEqual([])
  })
})
