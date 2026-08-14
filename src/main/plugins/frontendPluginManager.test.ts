import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The manager imports electron for its view lifecycle. A functional stub backs
// both the registry tests (which touch none of it) and the view-lifecycle tests
// below, which drive open/hide/resize/death paths against fakes. The factory
// exports its captured state as `__mock` (hoisted, so it must be self-contained).
vi.mock('electron', () => {
  type Handler = (...args: unknown[]) => unknown
  const ipcHandlers = new Map<string, Handler>()
  const ipcListeners = new Map<string, Handler>()
  const views: unknown[] = []
  const windows: unknown[] = []
  let nextWebContentsId = 1000

  class FakeWebContents {
    id = nextWebContentsId++
    sent: Array<{ channel: string; args: unknown[] }> = []
    loads: string[] = []
    private destroyed = false
    private listeners = new Map<string, Handler[]>()
    isDestroyed(): boolean {
      return this.destroyed
    }
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    }
    loadURL(url: string): Promise<void> {
      this.loads.push(url)
      return Promise.resolve()
    }
    loadFile(file: string, opts?: { search?: string }): Promise<void> {
      this.loads.push(`${file}${opts?.search ?? ''}`)
      return Promise.resolve()
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  class WebContentsView {
    webContents = new FakeWebContents()
    bounds: unknown = null
    visible = false
    constructor(_opts?: unknown) {
      views.push(this)
    }
    setBounds(b: unknown): void {
      this.bounds = b
    }
    setVisible(v: boolean): void {
      this.visible = v
    }
  }

  // Constructed by the manager for dedicated plugin host windows (mini-IDE).
  class BrowserWindow {
    options: Record<string, unknown>
    title: string
    destroyed = false
    minimized = false
    shown = false
    focusCount = 0
    contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
    children: unknown[] = []
    private listeners = new Map<string, Handler[]>()
    contentView = {
      addChildView: (v: unknown): void => {
        this.children.push(v)
      },
      removeChildView: (v: unknown): void => {
        this.children = this.children.filter((c) => c !== v)
      },
    }
    constructor(options?: Record<string, unknown>) {
      this.options = options ?? {}
      this.title = String(options?.title ?? '')
      windows.push(this)
    }
    setTitle(t: string): void {
      this.title = t
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isMinimized(): boolean {
      return this.minimized
    }
    restore(): void {
      this.minimized = false
    }
    show(): void {
      this.shown = true
    }
    focus(): void {
      this.focusCount++
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.contentBounds }
    }
    on(event: string, cb: Handler): this {
      const list = this.listeners.get(event) ?? []
      list.push(cb)
      this.listeners.set(event, list)
      return this
    }
    once(event: string, cb: Handler): this {
      const wrapper: Handler = (...args) => {
        this.removeListener(event, wrapper)
        return cb(...args)
      }
      return this.on(event, wrapper)
    }
    removeListener(event: string, cb: Handler): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== cb)
      )
      return this
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
    }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }

  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      ipcHandlers.set(channel, fn)
    },
    on: (channel: string, fn: Handler): void => {
      ipcListeners.set(channel, fn)
    },
  }

  return {
    WebContentsView,
    BrowserWindow,
    ipcMain,
    app: {},
    __mock: { ipcHandlers, ipcListeners, views, windows },
  }
})

import * as electron from 'electron'
import type { BrowserWindow } from 'electron'
import {
  FrontendPluginManager,
  frontendPluginManager,
  isReservedPluginId,
  devPlansPluginDescriptor,
  openMiniIdePluginView,
  PLANS_PLUGIN_ID,
  MINI_IDE_PLUGIN_ID,
  bundledMiniIdeDir,
  registerBundledMiniIde,
  type PluginLaunchDescriptor,
} from './frontendPluginManager'
import { manifestV2CapabilityPolicy } from './pluginPermissions'

interface FakeWebContentsLike {
  id: number
  sent: Array<{ channel: string; args: unknown[] }>
  loads: string[]
  isDestroyed(): boolean
  emit(event: string, ...args: unknown[]): void
  close(): void
}
interface FakeViewLike {
  webContents: FakeWebContentsLike
  bounds: { x: number; y: number; width: number; height: number } | null
  visible: boolean
}
interface FakeWindowLike {
  options: Record<string, unknown>
  title: string
  destroyed: boolean
  minimized: boolean
  shown: boolean
  focusCount: number
  children: unknown[]
  isDestroyed(): boolean
  close(): void
  emit(event: string, ...args: unknown[]): void
}
const { ipcHandlers, ipcListeners, views, windows } = (
  electron as unknown as {
    __mock: {
      ipcHandlers: Map<string, (...args: unknown[]) => unknown>
      ipcListeners: Map<string, (...args: unknown[]) => unknown>
      views: FakeViewLike[]
      windows: FakeWindowLike[]
    }
  }
).__mock

/** Host-window fake with just the surface the manager touches. */
class FakeBrowserWindow {
  title = ''
  destroyed = false
  minimized = false
  shown = false
  focusCount = 0
  contentBounds = { x: 0, y: 0, width: 1000, height: 700 }
  children: unknown[] = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  contentView = {
    addChildView: (v: unknown): void => {
      this.children.push(v)
    },
    removeChildView: (v: unknown): void => {
      this.children = this.children.filter((c) => c !== v)
    },
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {
    this.shown = true
  }
  focus(): void {
    this.focusCount++
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.contentBounds }
  }
  setTitle(t: string): void {
    this.title = t
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
    return this
  }
  once(event: string, cb: (...args: unknown[]) => void): this {
    const wrapper = (...args: unknown[]): void => {
      this.removeListener(event, wrapper)
      cb(...args)
    }
    return this.on(event, wrapper)
  }
  removeListener(event: string, cb: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((l) => l !== cb)
    )
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args)
  }
}

function asHost(win: FakeBrowserWindow): BrowserWindow {
  return win as unknown as BrowserWindow
}

function descriptor(id: string): PluginLaunchDescriptor {
  return { id, requires: [], devUrl: '', entryFile: `/plugins/${id}/index.html` }
}

describe('isReservedPluginId', () => {
  it('flags the built-in navide.* namespace, not third-party ids', () => {
    expect(isReservedPluginId('navide.mini-ide')).toBe(true)
    expect(isReservedPluginId('navide.noop')).toBe(true)
    expect(isReservedPluginId('navide.plans')).toBe(true)
    expect(isReservedPluginId('acme.demo')).toBe(false)
  })
})

describe('devPlansPluginDescriptor', () => {
  it('describes the navide.plans dev bundle with the plans-only event grant', () => {
    const desc = devPlansPluginDescriptor()
    expect(desc.id).toBe(PLANS_PLUGIN_ID)
    expect(desc.id).toBe('navide.plans')
    expect(desc.requires).toEqual(['fs', 'ui', 'plans', 'terminal'])
    // Built separately (vite.plans.config.ts) — never served by the dev server.
    expect(desc.devUrl).toBe('')
    expect(desc.entryFile.endsWith('dist-plugins/plans/index.html')).toBe(true)
  })

  it('registers only via the builtin/official path (reserved id)', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(devPlansPluginDescriptor())).toThrow(/reserved/)
    expect(() =>
      mgr.registerDescriptor(devPlansPluginDescriptor(), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor(PLANS_PLUGIN_ID)?.id).toBe('navide.plans')
  })
})

describe('registerDescriptor reserved-id guard', () => {
  it('refuses a third-party plugin claiming a reserved built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() => mgr.registerDescriptor(descriptor('navide.mini-ide'))).toThrow(/reserved/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('allows the host itself to register a built-in id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { builtin: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('allows an officially-verified install to register a reserved id', () => {
    const mgr = new FrontendPluginManager()
    expect(() =>
      mgr.registerDescriptor(descriptor('navide.mini-ide'), { official: true })
    ).not.toThrow()
    expect(mgr.getDescriptor('navide.mini-ide')?.id).toBe('navide.mini-ide')
  })

  it('registers an ordinary third-party descriptor', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(descriptor('acme.demo'))
    expect(mgr.getDescriptor('acme.demo')?.id).toBe('acme.demo')
  })

  it('lists validated Manifest v2 view contributions for Host discovery', () => {
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor({
      ...descriptor('acme.files'),
      views: [
        {
          id: 'left',
          contributionKey: 'acme.files.left',
          kind: 'custom',
          location: 'left',
          title: 'Files',
          entryFile: '/plugins/acme.files/frontend/left/index.html',
        },
        {
          id: 'window',
          contributionKey: 'acme.files.window',
          kind: 'custom',
          location: 'window',
          title: 'Files window',
          entryFile: '/plugins/acme.files/frontend/window/index.html',
        },
      ],
    })
    expect(mgr.listViewContributions()).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.files.left',
        location: 'left',
      }),
      expect.objectContaining({
        contributionKey: 'acme.files.window',
        location: 'window',
      }),
    ])
  })
})

describe('loadInstalledPlugins official receipt gate', () => {
  const official = generateKeyPairSync('ed25519')
  const officialPem = official.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let root: string
  let envBefore: string | undefined

  function writePlugin(id: string, receipt?: Record<string, unknown>): void {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
    if (receipt) writeFileSync(join(dir, '.navide-receipt.json'), JSON.stringify(receipt))
  }

  function officialReceipt(id: string): Record<string, unknown> {
    const digest = 'ab'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), official.privateKey).toString(
      'base64'
    )
    return { id, version: '1.0.0', digest, signature }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-plugins-'))
    envBefore = process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = officialPem
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (envBefore === undefined) delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    else process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = envBefore
  })

  it('registers a navide. plugin whose receipt verifies against the pinned key', () => {
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toContain('navide.mini-ide')
    expect(mgr.getDescriptor('navide.mini-ide')).toBeDefined()
  })

  it('refuses a navide. plugin without a receipt', () => {
    writePlugin('navide.mini-ide')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/receipt/)
    expect(mgr.getDescriptor('navide.mini-ide')).toBeUndefined()
  })

  it('refuses a navide. plugin whose receipt was signed by a different key', () => {
    const rogue = generateKeyPairSync('ed25519')
    const digest = 'cd'.repeat(32)
    const signature = edSign(null, Buffer.from(digest, 'ascii'), rogue.privateKey).toString(
      'base64'
    )
    writePlugin('navide.mini-ide', { id: 'navide.mini-ide', version: '1.0.0', digest, signature })
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
  })

  it('falls back to the shipped pin when no env override is set', () => {
    // Without an override the pin comes from OFFICIAL_PUBLISHER_KEY_PEM, so this
    // test-only key is refused for MISMATCHING the pin — not for the absence of
    // one. That distinction is what proves the shipped constant is wired in; if
    // it were ever emptied, the message would revert to "no pinned official".
    delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    writePlugin('navide.mini-ide', officialReceipt('navide.mini-ide'))
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(loaded).toEqual([])
    expect(errors.join(' ')).toMatch(/pinned official key/)
    expect(errors.join(' ')).not.toMatch(/no pinned official/)
  })

  it('loads third-party plugins with no receipt requirement', () => {
    writePlugin('acme.demo')
    const mgr = new FrontendPluginManager()
    const { loaded, errors } = mgr.loadInstalledPlugins(root)
    expect(errors).toEqual([])
    expect(loaded).toEqual(['acme.demo'])
  })
})

describe('bundled mini-IDE builtin resolution', () => {
  let root: string

  /** Write a valid bundled mini-IDE dir (manifest + entry) under `dir`. */
  function writeBundled(dir: string, manifest?: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(
        manifest ?? {
          id: MINI_IDE_PLUGIN_ID,
          version: '1.0.0',
          entry: 'index.html',
          requires: ['fs', 'git'],
        }
      )
    )
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-bundled-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves resourcesPath/plugins/mini-ide when packaged', () => {
    expect(bundledMiniIdeDir({ isPackaged: true, resourcesPath: '/res' })).toBe(
      join('/res', 'plugins', 'mini-ide')
    )
  })

  it('resolves dist-plugins/mini-ide under the dev root when unpackaged', () => {
    expect(
      bundledMiniIdeDir({ isPackaged: false, resourcesPath: '/res', devRoot: '/repo' })
    ).toBe(join('/repo', 'dist-plugins', 'mini-ide'))
  })

  it('registers the bundled copy as builtin when nothing is installed (packaged)', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(true)
    const desc = mgr.getDescriptor(MINI_IDE_PLUGIN_ID)
    expect(desc?.entryFile).toBe(join(dir, 'index.html'))
    expect(desc?.requires).toEqual(['fs', 'git'])
  })

  it('registers the dev dist-plugins copy when unpackaged', () => {
    const dir = join(root, 'dist-plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, {
      isPackaged: false,
      resourcesPath: '/unused',
      devRoot: root,
    })
    expect(result.registered).toBe(true)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('an already-installed (official) copy takes precedence over the bundled copy', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    const installed: PluginLaunchDescriptor = {
      id: MINI_IDE_PLUGIN_ID,
      requires: ['fs'],
      devUrl: '',
      entryFile: '/userData/plugins/navide.mini-ide/index.html',
    }
    mgr.registerDescriptor(installed, { official: true })

    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(true)
    // Installed copy stays active; the bundled one is only the fallback.
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(installed.entryFile)
  })

  it('removing the installed override reverts to the bundled builtin', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir)
    const mgr = new FrontendPluginManager()
    mgr.registerDescriptor(
      {
        id: MINI_IDE_PLUGIN_ID,
        requires: ['fs'],
        devUrl: '',
        entryFile: '/userData/plugins/navide.mini-ide/index.html',
      },
      { official: true }
    )
    registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })

    mgr.removeInstalledPlugin(MINI_IDE_PLUGIN_ID)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)?.entryFile).toBe(join(dir, 'index.html'))
  })

  it('a missing bundled dir is refused without crashing (dialog fallback)', () => {
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('an invalid bundled manifest is refused without crashing', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), 'not json at all')
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled manifest claiming a different id is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    writeBundled(dir, {
      id: 'acme.impostor',
      version: '1.0.0',
      entry: 'index.html',
      requires: [],
    })
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/acme\.impostor/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })

  it('a bundled dir whose entry file is missing is refused', () => {
    const dir = join(root, 'plugins', 'mini-ide')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ id: MINI_IDE_PLUGIN_ID, version: '1.0.0', entry: 'index.html', requires: [] })
    )
    const mgr = new FrontendPluginManager()
    const result = registerBundledMiniIde(mgr, { isPackaged: true, resourcesPath: root })
    expect(result.registered).toBe(false)
    expect(result.reason).toMatch(/entry file missing/)
    expect(mgr.getDescriptor(MINI_IDE_PLUGIN_ID)).toBeUndefined()
  })
})

describe('view lifecycle (open / hideSelf / resize / death paths)', () => {
  const OPEN_TARGET = 'plugin:openTarget'

  function openView(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    query?: string
  ): FakeViewLike {
    const before = views.length
    mgr.open(asHost(host), { ...descriptor(id), query }, 'fill')
    // Existing-view opens create no new fake; return the plugin's current view.
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function openTargets(view: FakeViewLike): Record<string, string>[] {
    return view.webContents.sent
      .filter((m) => m.channel === OPEN_TARGET)
      .map((m) => m.args[0] as Record<string, string>)
  }

  it('leaves the host title alone when mirrorTitle is not requested', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.title = 'my-repo — Navide'
    const view = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    // A plugin embedded in a shared window must never rename that window.
    view.webContents.emit('page-title-updated', {}, 'something — Acme')
    expect(host.title).toBe('my-repo — Navide')
  })

  it('hideSelf hides only the calling sender view', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openView(mgr, host, 'acme.a', '?workspace_path=/ws')
    const before = views.length
    mgr.open(asHost(host), descriptor('acme.b'), { x: 0, y: 0, width: 10, height: 10 })
    const viewB = views[before]
    expect(viewA.visible).toBe(true)
    expect(viewB.visible).toBe(true)

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: viewA.webContents.id } })
    expect(viewA.visible).toBe(false)
    expect(viewB.visible).toBe(true)

    // Unknown sender → no-op (never hides someone else's view).
    hide!({ sender: { id: 999999 } })
    expect(viewB.visible).toBe(true)
  })

  it('drops the running record when the webContents dies and reopen recreates', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const first = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(first.webContents.loads).toHaveLength(1)

    // Simulate renderer death (any path other than manager.destroy()).
    first.webContents.close()

    const countBefore = views.length
    const second = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(views.length).toBe(countBefore + 1) // recreated, not reused
    expect(second).not.toBe(first)
    expect(second.webContents.loads).toHaveLength(1)
  })

  it('delivers a changed open target to the running view without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=src/a.ts&line=7')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', filepath: 'src/a.ts', line: '7' },
    ])
  })

  it('queues an open target racing the first load and flushes on did-finish-load', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    // Second open arrives before the entry finished loading.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&filepath=b.ts')
    expect(openTargets(view)).toEqual([])

    view.webContents.emit('did-finish-load')
    expect(openTargets(view)).toEqual([{ workspace_path: '/ws', filepath: 'b.ts' }])
  })

  it('delivers an out-of-workspace open (file_ws) in-page without reloading', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws&http_url=http://x')
    view.webContents.emit('did-finish-load')

    // `file_ws` names the external file's own root; the workspace is unchanged,
    // so the view must keep its open tabs and just receive the target.
    openView(mgr, host, 'acme.editor', '?workspace_path=/ws&file_ws=/elsewhere&filepath=notes.md')
    expect(view.webContents.loads).toHaveLength(1) // no reload
    expect(openTargets(view)).toEqual([
      { workspace_path: '/ws', file_ws: '/elsewhere', filepath: 'notes.md' },
    ])
  })

  it('reloads the entry when the workspace changes (legacy routing)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws-a')
    view.webContents.emit('did-finish-load')

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws-b')
    expect(view.webContents.loads).toHaveLength(2) // reloaded with new params
    expect(openTargets(view)).toEqual([]) // no in-page delivery on reload
  })

  it('sizes a fill view to the host content bounds and tracks host resize', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    host.contentBounds = { x: 0, y: 0, width: 800, height: 600 }
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 800, height: 600 })

    host.contentBounds = { x: 0, y: 0, width: 1024, height: 768 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })

    // Hidden views stop tracking (listener removed on hide).
    mgr.deactivate('acme.editor')
    host.contentBounds = { x: 0, y: 0, width: 500, height: 400 }
    host.emit('resize')
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('re-opening a running view reveals and focuses the hosting window', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    host.minimized = true
    host.shown = false

    openView(mgr, host, 'acme.editor', '?workspace_path=/ws')
    expect(view.visible).toBe(true)
    expect(host.minimized).toBe(false)
    expect(host.shown).toBe(true)
    expect(host.focusCount).toBeGreaterThan(0)
  })

  it('cross-window open keeps the view on its original host and focuses that host', () => {
    const mgr = new FrontendPluginManager()
    const hostA = new FakeBrowserWindow()
    const hostB = new FakeBrowserWindow()
    const view = openView(mgr, hostA, 'acme.editor', '?workspace_path=/ws')

    openView(mgr, hostB, 'acme.editor', '?workspace_path=/ws&filepath=c.ts')
    expect(hostA.children).toContain(view)
    expect(hostB.children).not.toContain(view)
    expect(hostA.focusCount).toBeGreaterThan(0)
    expect(hostB.focusCount).toBe(0)
  })
})

describe('terminal PTY routing + output micro-batching', () => {
  const CAP_EVENT = 'plugin:cap:event'

  interface DispatchSeam {
    dispatchEvent(event: string, payload: unknown): void
  }

  function dispatch(mgr: FrontendPluginManager, event: string, payload: unknown): void {
    ;(mgr as unknown as DispatchSeam).dispatchEvent(event, payload)
  }

  function eventsOf(
    view: FakeViewLike,
    type: string
  ): Array<{ type: string; data: Record<string, unknown> }> {
    return view.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => m.args[0] as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === type)
  }

  function openTerminalPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[] = ['terminal']
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function output(id: string, data: string, sequence = 1): Record<string, unknown> {
    return { terminal_session_id: id, pane_id: 'p', sequence, data, stream: 'stdout' }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers batched output ONLY to the plugin whose create bound the session', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')

    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    dispatch(mgr, 'terminal.output', output('t-1', 'hi'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('coalesces an output burst into one IPC send with concatenated data', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'he', 1))
    dispatch(mgr, 'terminal.output', output('t-1', 'll', 2))
    dispatch(mgr, 'terminal.output', output('t-1', 'o', 3))
    expect(eventsOf(view, 'terminal.output')).toHaveLength(0) // still batching
    vi.advanceTimersByTime(12)

    const got = eventsOf(view, 'terminal.output')
    expect(got).toHaveLength(1)
    expect(got[0].data.data).toBe('hello')
    expect(got[0].data.sequence).toBe(3) // last event's fields ride along
  })

  it('flushes pending output before terminal.exit and retires the route', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'bye'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-1', exit_code: 0 })

    // Output landed BEFORE exit despite the batch window (ordering barrier).
    const all = viewA.webContents.sent
      .filter((m) => m.channel === CAP_EVENT)
      .map((m) => (m.args[0] as { type: string }).type)
    expect(all).toEqual(['terminal.output', 'terminal.exit'])
    expect(eventsOf(viewB, 'terminal.exit')).toHaveLength(0)

    // The route is gone: later output for the id is DROPPED (never fanned out).
    dispatch(mgr, 'terminal.output', output('t-1', 'late'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(1) // just the flush
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('drops output/exit for sessions no plugin bound (no fan-out)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')

    dispatch(mgr, 'terminal.output', output('t-9', 'orphan'))
    dispatch(mgr, 'terminal.exit', { terminal_session_id: 't-9', exit_code: 0 })
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
    expect(eventsOf(viewA, 'terminal.exit')).toHaveLength(0)
  })

  it('registers every alive session from a reattach response', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.reattach', { alive: ['t-1', 't-2'], dead: [] })

    dispatch(mgr, 'terminal.output', output('t-1', 'a'))
    dispatch(mgr, 'terminal.output', output('t-2', 'b'))
    vi.advanceTimersByTime(12)

    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(2)
    expect(eventsOf(viewA, 'terminal.output')).toHaveLength(0)
  })

  it('destroy drops pending batches and keeps the route marked — output never leaks', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    mgr.destroy('acme.term-a')
    vi.advanceTimersByTime(12)
    // The dead view's pending batch is dropped, never fanned out to others.
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)

    // The route entry is RETAINED with the dead owner: later output for the id
    // is dropped, not delivered to unrelated plugins.
    dispatch(mgr, 'terminal.output', output('t-1', 'later'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0)
  })

  it('a renderer crash runs the same terminal teardown as destroy()', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const viewA = openTerminalPlugin(mgr, host, 'acme.term-a')
    const viewB = openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })

    dispatch(mgr, 'terminal.output', output('t-1', 'secret'))
    viewA.webContents.close() // crash path — fires the 'destroyed' hook
    vi.advanceTimersByTime(12)
    expect(eventsOf(viewB, 'terminal.output')).toHaveLength(0) // batch dropped

    // Route retained: the crashed plugin's session is still owned by it, so a
    // sibling's reattach may not claim it (see the filter test below).
    const filtered = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-1'],
      cols: 0,
      rows: 0,
    })
    expect(filtered.terminal_session_ids).toEqual([])
  })

  it('re-claim after teardown: the SAME plugin reattaches and delivery resumes', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-1' })
    mgr.destroy('acme.term-a')

    // Reopened view of the same plugin: its own retained id passes the filter…
    const payload = mgr.filterTerminalReattachPayload('acme.term-a', {
      terminal_session_ids: ['t-1'],
    })
    expect(payload.terminal_session_ids).toEqual(['t-1'])

    // …and after the reattach response re-registers, delivery resumes.
    const reopened = openTerminalPlugin(mgr, host, 'acme.term-a')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.reattach', { alive: ['t-1'], dead: [] })
    dispatch(mgr, 'terminal.output', output('t-1', 'back'))
    vi.advanceTimersByTime(12)
    expect(eventsOf(reopened, 'terminal.output')).toHaveLength(1)
  })

  it('reattach filter strips ids owned by another plugin, keeps own and unknown ids', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    openTerminalPlugin(mgr, host, 'acme.term-a')
    openTerminalPlugin(mgr, host, 'acme.term-b')
    mgr.noteTerminalRoutes('acme.term-a', 'terminal.create', { terminal_session_id: 't-a' })
    mgr.noteTerminalRoutes('acme.term-b', 'terminal.create', { terminal_session_id: 't-b' })

    const payload = mgr.filterTerminalReattachPayload('acme.term-b', {
      terminal_session_ids: ['t-a', 't-b', 't-unknown'],
      cols: 80,
      rows: 24,
    })
    // The live sibling's session is stripped; own + never-seen ids pass
    // (never-seen covers app-restart re-claims and non-broker PTYs).
    expect(payload.terminal_session_ids).toEqual(['t-b', 't-unknown'])
    expect(payload.cols).toBe(80) // other fields untouched

    // A payload without an ids array passes through unchanged.
    const untouched = { cols: 80 }
    expect(mgr.filterTerminalReattachPayload('acme.term-b', untouched)).toBe(untouched)
  })
})

describe('cast channel (IPC_CAST / handleCast)', () => {
  function openPlugin(
    mgr: FrontendPluginManager,
    host: FakeBrowserWindow,
    id: string,
    requires: string[]
  ): FakeViewLike {
    const before = views.length
    mgr.open(
      asHost(host),
      { id, requires, devUrl: '', entryFile: `/plugins/${id}/index.html` },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    return views.length > before ? views[views.length - 1] : views[before - 1]
  }

  function castPayload(ns: string, method: string): Record<string, unknown> {
    return { ns, method, args: { terminal_session_id: 't-1', data: 'x' }, reqId: 'r1' }
  }

  it('accepts whitelisted casts from a known sender (terminal.input / log_sent)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    // No backend transport in tests — reaching 'no-backend' proves the cast
    // passed sender, shape, scoping AND the whitelist.
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'))).toBe('no-backend')
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'log_sent'))).toBe(
      'no-backend'
    )
  })

  it('rejects non-whitelisted backend types (mirror of the shim CAST_TYPES)', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'resize'))).toBe(
      'not-castable'
    )
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'kill'))).toBe(
      'not-castable'
    )
  })

  it('rejects casts for namespaces the manifest never granted', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.fsonly', ['fs'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'input'))).toBe('denied')
  })

  it('rejects unmapped methods, unknown senders and malformed payloads', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    expect(mgr.handleCast(view.webContents.id, castPayload('terminal', 'nope'))).toBe('unmapped')
    expect(mgr.handleCast(999999, castPayload('terminal', 'input'))).toBe('unknown-sender')
    expect(mgr.handleCast(view.webContents.id, { nope: true })).toBe('malformed')
  })

  it('is wired to the plugin:cap:cast IPC channel', () => {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    const view = openPlugin(mgr, host, 'acme.term', ['terminal'])
    const cast = ipcListeners.get('plugin:cap:cast')
    expect(cast).toBeDefined()
    expect(() =>
      cast!({ sender: { id: view.webContents.id } }, castPayload('terminal', 'input'))
    ).not.toThrow()
  })
})

describe('mini-IDE dedicated window (openMiniIdePluginView)', () => {
  // These tests exercise the module-level singleton + dedicated-window path, so
  // each test must close the live window (module state resets via 'closed').
  beforeEach(() => {
    frontendPluginManager.registerBuiltin({
      id: MINI_IDE_PLUGIN_ID,
      requires: [],
      devUrl: '',
      entryFile: '/plugins/mini-ide/index.html',
    })
  })

  afterEach(() => {
    for (const win of windows) {
      if (!win.isDestroyed()) win.close()
    }
    frontendPluginManager.destroy(MINI_IDE_PLUGIN_ID)
  })

  function lastWindow(): FakeWindowLike {
    return windows[windows.length - 1]
  }
  function lastView(): FakeViewLike {
    return views[views.length - 1]
  }

  it('creates a dedicated host window with the legacy editor options', () => {
    const winsBefore = windows.length
    const ok = openMiniIdePluginView('/ws', 'http://h:1')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1)
    const win = lastWindow()
    expect(win.options).toMatchObject({
      width: 1100,
      height: 760,
      title: 'Mini-IDE',
      titleBarStyle: 'hidden',
      backgroundColor: '#0d1117',
    })
    // The view attaches to the dedicated window and fills its content bounds.
    const view = lastView()
    expect(win.children).toContain(view)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  it('passes the current theme in the entry query', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    expect(lastView().webContents.loads[0]).toContain('theme=light')
  })

  it('mirrors the plugin page title onto the dedicated host window', () => {
    openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    // The host's own webContents is blank; without mirroring the window would
    // keep its creation-time title in the macOS Window menu forever.
    expect(win.title).toBe('Mini-IDE')
    lastView().webContents.emit('page-title-updated', {}, 'main.ts — Mini-IDE')
    expect(win.title).toBe('main.ts — Mini-IDE')
  })

  it('ignores an empty page title so the window keeps its feature name', () => {
    openMiniIdePluginView('/ws', 'http://h:1')
    const win = lastWindow()
    lastView().webContents.emit('page-title-updated', {}, '')
    expect(win.title).toBe('Mini-IDE')
  })

  it('reopen restores and focuses the dedicated window without reloading', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    const win = lastWindow()
    const view = lastView()
    view.webContents.emit('did-finish-load')
    win.minimized = true

    const winsBefore = windows.length
    openMiniIdePluginView('/ws', '', { filepath: 'a.ts' }, 'light')
    expect(windows.length).toBe(winsBefore) // same window reused
    expect(win.minimized).toBe(false)
    expect(win.focusCount).toBeGreaterThan(0)
    expect(view.webContents.loads).toHaveLength(1) // no reload
    const targets = view.webContents.sent.filter((m) => m.channel === 'plugin:openTarget')
    expect(targets).toHaveLength(1)
    expect(targets[0].args[0]).toMatchObject({ workspace_path: '/ws', filepath: 'a.ts' })
  })

  it('a theme change alone does not reload the running view', () => {
    openMiniIdePluginView('/ws', '', {}, 'light')
    const view = lastView()
    view.webContents.emit('did-finish-load')

    openMiniIdePluginView('/ws', '', {}, 'dark-github')
    expect(view.webContents.loads).toHaveLength(1) // still the first load
  })

  it('hideSelf closes the dedicated window and tears the view down', () => {
    openMiniIdePluginView('/ws')
    const win = lastWindow()
    const view = lastView()

    const hide = ipcListeners.get('plugin:hideSelf')
    expect(hide).toBeDefined()
    hide!({ sender: { id: view.webContents.id } })
    expect(win.destroyed).toBe(true)
    expect(view.webContents.isDestroyed()).toBe(true)
  })

  it('close then reopen recreates the window and view cleanly', () => {
    openMiniIdePluginView('/ws')
    const win1 = lastWindow()
    win1.close()

    const winsBefore = windows.length
    const viewsBefore = views.length
    const ok = openMiniIdePluginView('/ws')
    expect(ok).toBe(true)
    expect(windows.length).toBe(winsBefore + 1) // fresh window
    expect(views.length).toBe(viewsBefore + 1) // fresh view
    expect(lastWindow()).not.toBe(win1)
    expect(lastView().webContents.loads).toHaveLength(1)
  })
})

describe('ui.open_in_editor host capability — workspace containment / caller root', () => {
  const CALL = 'plugin:cap:call'

  /** Open a `ui`-granted view bound to /ws and return the call seam. */
  function openUiPlugin(): {
    mgr: FrontendPluginManager
    view: FakeViewLike
    opens: Array<Record<string, string>>
    call: (args: Record<string, unknown>) => Promise<{
      ok?: boolean
      result?: unknown
      error?: { code: string; message: string }
    }>
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.viewer',
        requires: ['ui'],
        devUrl: '',
        entryFile: '/plugins/acme.viewer/index.html',
        query: '?workspace_path=/ws',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opens: Array<Record<string, string>> = []
    mgr.setOpenInEditorHandler((params) => {
      opens.push(params)
      return true
    })
    const handler = ipcHandlers.get(CALL)
    expect(handler).toBeDefined()
    return {
      mgr,
      view,
      opens,
      call: async (args) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_in_editor',
          args,
        })) as { ok?: boolean; error?: { code: string; message: string } },
    }
  }

  it('uses the host-assigned workspace when the call names no root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/app.ts' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/ws', filepath: 'src/app.ts' }])
  })

  it('rejects a traversal that escapes the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '../../Users/neillu/.ssh/id_rsa' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('rejects an absolute path outside the workspace', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '/etc/passwd' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('honours a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    // Opening a file that lives outside the view's workspace: the caller names
    // the file's own root, and the target is normalized against it.
    const resp = await call({ workspace_path: '/elsewhere', filepath: 'notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/elsewhere', filepath: 'notes/todo.md' }])
  })

  it('rejects a traversal that escapes a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '../secrets/key' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })

  it('normalizes an absolute filepath against a call-supplied root', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ workspace_path: '/elsewhere', filepath: '/elsewhere/notes/todo.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/elsewhere', filepath: 'notes/todo.md' }])
  })

  it('normalizes an in-workspace path before handing it downstream', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: 'src/../README.md' })
    expect(resp.error).toBeUndefined()
    expect(opens).toEqual([{ workspace_path: '/ws', filepath: 'README.md' }])
  })

  it('rejects a bare workspace reference (no file to open)', async () => {
    const { opens, call } = openUiPlugin()
    const resp = await call({ filepath: '.' })
    expect(resp.error?.code).toBe('BAD_REQUEST')
    expect(opens).toEqual([])
  })
})

describe('Manifest v2 ui.open_external gesture gate', () => {
  const CALL = 'plugin:cap:call'
  const GESTURE = 'plugin:userGesture'

  function openV2External(): {
    view: FakeViewLike
    opened: string[]
    call: (url: string) => Promise<{ ok?: boolean; error?: { code: string; message?: string } }>
    announceGesture: () => void
  } {
    const mgr = new FrontendPluginManager()
    const host = new FakeBrowserWindow()
    mgr.open(
      asHost(host),
      {
        id: 'acme.links',
        requires: ['ui'],
        capabilityPolicy: manifestV2CapabilityPolicy({ ui: ['openExternal'] }),
        devUrl: '',
        entryFile: '/plugins/acme.links/index.html',
      },
      'fill'
    )
    const view = views[views.length - 1]
    const opened: string[] = []
    mgr.setHostShellHandlers({
      openExternal: async (url) => {
        opened.push(url)
        return { ok: true }
      },
      revealPath: () => ({ ok: true }),
      openWorkspace: () => ({ ok: true }),
      pickFolder: async () => null,
    })
    const handler = ipcHandlers.get(CALL)
    const gesture = ipcListeners.get(GESTURE)
    expect(handler).toBeDefined()
    expect(gesture).toBeDefined()
    return {
      view,
      opened,
      call: async (url) =>
        (await handler!({ sender: { id: view.webContents.id } }, {
          reqId: 'r1',
          ns: 'ui',
          method: 'open_external',
          args: { url },
        })) as { ok?: boolean; error?: { code: string; message?: string } },
      announceGesture: () => gesture!({ sender: { id: view.webContents.id } }),
    }
  }

  it('requires a trusted gesture and consumes the credit once', async () => {
    const { opened, call, announceGesture } = openV2External()
    expect((await call('https://example.com')).error?.code).toBe('USER_GESTURE_REQUIRED')
    announceGesture()
    expect((await call('https://example.com')).ok).toBe(true)
    expect((await call('https://example.com/again')).error?.code).toBe('USER_GESTURE_REQUIRED')
    expect(opened).toEqual(['https://example.com'])
  })

  it('rejects plaintext URLs even when a gesture was announced', async () => {
    const { opened, call, announceGesture } = openV2External()
    announceGesture()
    expect((await call('http://example.com')).error?.code).toBe('BAD_REQUEST')
    expect(opened).toEqual([])
  })
})
