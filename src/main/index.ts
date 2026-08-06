import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, safeStorage, session, shell } from 'electron'
import { join, dirname } from 'node:path'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { startBackend, getResolvedUserPath, type BackendHandle } from './backend'
import { abandonPendingBackends } from './backend-pending'
import { installApplicationMenu, type AppMenuHooks, type RecentMenuEntry } from './menu'
import { openNoopPluginView, openFsProbePluginView, openMiniIdePluginView, devMiniIdePluginDescriptor, openPlansPluginView, devPlansPluginDescriptor, openGitPluginView, devGitPluginDescriptor, registerBundledMiniIde, registerBundledPlans, registerBundledGit, frontendPluginManager } from './plugins/frontendPluginManager'
import { registerPluginIpc } from './plugins/pluginIpc'
import { registerStorageIpc } from './storage-ipc'
import { lockPageZoom } from './web-contents-zoom'
import { installContextMenu, registerTerminalContextMenu } from './context-menu'
import { initUpdater } from './updater'
import { withDeadline } from './deadline'
import { WindowRegistry, type WindowBounds, type WindowEntry } from './window-registry'
import { setWindowDockTileBadge } from './dock-tile-badge'
import { BackendBroadcastTracker } from './backend-broadcast'
import { watchBackendExit } from './backend-crash'
import {
  CliBufferRelay,
  CLI_BUFFER_REPLY_CHANNEL,
  type CliPaneBufferResult
} from './cli-buffer-relay'
import {
  hitTestWindows,
  selectDropCandidates,
  PANE_DRAG_END_CHANNEL,
  EXTERNAL_PANE_DROP_CHANNEL,
  type CandidateWindow
} from './cross-window-drag'
import { readHealthCheckTimeoutSec, writeHealthCheckTimeoutSec } from './health-timeout'
import { readCdpDebugConfig, writeCdpDebugConfig, type CdpDebugConfig } from './cdp-debug'
import { classifyEditorOpen, resolveExternalOpenTarget } from './editor-fallback'
import {
  buildEditorArgv,
  classifyOpenRequest,
  detectEditors,
  launchEditorProcess,
  normalizeEditorId,
  DEFAULT_EDITOR_ID,
  type DetectedEditor,
  type EditorPreference
} from './editors'
import { findManualLogFile } from './manual-log-search'
import { searchLogFiles } from './log-content-search'
import {
  getPermissionStatuses,
  requestPermission,
  openPermissionSettings,
  type PermissionKey,
} from './permissions'
import { resolveBackendDataDir, readUiSettingsText, UI_SETTINGS_FILE } from './ui-settings-bootstrap'
import { PlanWindowRegistry } from './plan-windows'
import {
  GitAccountsStore,
  type GitAccountCrypto,
  type GitAccountInput
} from './gitAccountsStore'

if (process.platform === 'darwin') {
  app.dock.setIcon(nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')))
}

let backend: BackendHandle | null = null
// In-flight initial backend start, so before-quit can wait for it (capped) and
// stop the process instead of orphaning it when the user quits mid-startup.
let backendStarting: Promise<void> | null = null
// Message from the most recent failed start/restart attempt, so the renderer
// can show a real error instead of sitting in "starting" forever after a
// retry also fails. Cleared as soon as a start attempt succeeds.
let backendLastError: string | null = null
// Confirm-before-quit config, driven from the renderer (shared "confirm before
// close" setting). Localized strings are supplied by the renderer.
let quitConfirm = {
  enabled: true,
  message: 'Quit?',
  detail: '',
  quitLabel: 'Quit',
  cancelLabel: 'Cancel',
  dontShowLabel: "Don't show this again",
}
let quitConfirmed = false
// Multiple independent main windows (VS Code-style cmd+shift+N). `mainWindow`
// tracks the most-recently-focused one so dialogs parent to it; `mainWindows`
// holds them all for lifecycle code that must reach every main window.
let mainWindow: BrowserWindow | null = null
const mainWindows = new Set<BrowserWindow>()
// Focus recency per window id — approximates z-order for the cross-window pane
// drop hit-test (Electron has no cross-platform z-order query).
const windowFocusSeq = new Map<number, number>()
let windowFocusCounter = 0
app.on('browser-window-focus', (_event, win) => {
  windowFocusSeq.set(win.id, ++windowFocusCounter)
})
app.on('browser-window-created', (_event, win) => {
  const id = win.id
  win.on('closed', () => windowFocusSeq.delete(id))
})
// Maps each main window to its workspace_path so we can focus an existing window
// instead of creating a duplicate when the same folder is opened again.
const mainWindowWorkspaces = new Map<BrowserWindow, string>()
// Detached run-group child windows. A detached window shows only one run group of
// its workspace. It is deliberately kept OUT of mainWindowWorkspaces and the
// crash-restore registry (see detachedWindowIds) so it is never treated as a
// standalone workspace window (no focus-instead-of-open, no restore reopen).
const detachedGroups = new Map<string, BrowserWindow>()          // groupId → child window
const detachedGroupWorkspace = new Map<string, string>()         // groupId → workspace_path
const detachedWindowIds = new Set<number>()                      // child window ids

// Send an event to every non-detached main window bound to a workspace (used to
// hand a run group off to / back from a detached child window).
function broadcastToWorkspace(workspacePath: string, channel: string, payload: unknown): void {
  for (const win of mainWindows) {
    if (win.isDestroyed() || detachedWindowIds.has(win.id)) continue
    if (mainWindowWorkspaces.get(win) !== workspacePath) continue
    win.webContents.send(channel, payload)
  }
}
// Workspace paths can refer to the same folder via a trailing slash, a symlink,
// or different casing (macOS FS is case-insensitive); realpath settles all
// three. Falls back to the trimmed string when the folder no longer exists.
function normalizeWorkspacePath(p: string): string {
  const trimmed = (p ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  try {
    return realpathSync(trimmed)
  } catch {
    return trimmed
  }
}

function findMainWindowForWorkspace(workspacePath: string): BrowserWindow | null {
  const target = normalizeWorkspacePath(workspacePath)
  if (!target) return null
  for (const [win, wp] of mainWindowWorkspaces) {
    if (!win.isDestroyed() && normalizeWorkspacePath(wp) === target) return win
  }
  return null
}

// Tell every main window the set of open workspaces changed so Welcome screens
// refresh their "open" badges (they re-query workspace:listOpen on this event).
function broadcastOpenWorkspacesChanged(): void {
  for (const win of mainWindows) {
    if (win.isDestroyed() || detachedWindowIds.has(win.id)) continue
    win.webContents.send('workspace:openChanged')
  }
}
// Route a native application-menu action to the renderer of the most relevant
// main window: the focused window when it is a real workspace window (editor /
// detached child windows never receive these), else the most-recently-focused
// main window.
function sendMenuAction(action: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target =
    focused && !focused.isDestroyed() && mainWindows.has(focused) && !detachedWindowIds.has(focused.id)
      ? focused
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null
  target?.webContents.send('menu:action', action)
}
// Application menu is rebuilt whenever the recent-workspaces list changes (each
// window's renderer pushes the latest list via 'menu:setRecents'). Hooks are
// assembled once in whenReady and stored so rebuildAppMenu can reuse them.
let appMenuHooks: AppMenuHooks = {}
let lastRecents: RecentMenuEntry[] = []
function rebuildAppMenu(): void {
  installApplicationMenu(appMenuHooks, lastRecents)
}
// Crash-restore: persists open workspace windows so an unexpected exit can be
// detected and offered for restore on the next launch (see window-registry.ts).
// Path resolved lazily — dev re-points userData (…-dev) below, after imports.
const windowRegistry = new WindowRegistry(() => join(app.getPath('userData'), 'open-windows.json'))
// Health-check timeout: user-configurable via Settings, persisted here so
// startBackend() (called before any renderer window exists) can read it.
// Path resolved lazily for the same reason as windowRegistry's, above.
const healthTimeoutPath = (): string => join(app.getPath('userData'), 'health-check-timeout.json')
// Chrome DevTools Protocol (CDP) debug toggle: user-configurable via Settings.
// Path resolved lazily for the same dev-userData reason as above — see the
// pre-ready read of this file, below the dev userData override.
const cdpDebugPath = (): string => join(app.getPath('userData'), 'cdp-debug.json')
// Git account registry: main-owned, safeStorage-encrypted PATs bound per
// workspace (see gitAccountsStore.ts). Built lazily so app.getPath / safeStorage
// are only touched after the app is ready (IPC calls arrive from renderers).
let gitAccountsStore: GitAccountsStore | null = null
function getGitAccountsStore(): GitAccountsStore {
  if (!gitAccountsStore) {
    const crypto: GitAccountCrypto = {
      get available(): boolean {
        return safeStorage.isEncryptionAvailable()
      },
      encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (enc: string): string => safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
    gitAccountsStore = new GitAccountsStore(join(app.getPath('userData'), 'git-accounts.json'), crypto)
  }
  return gitAccountsStore
}
// Windows from the previous (uncleanly exited) run, offered to the FIRST
// renderer that asks via restore:getPending; cleared on apply/dismiss.
let pendingRestore: WindowEntry[] | null = null
let pendingRestoreClaimed = false

function loadWindow(win: BrowserWindow, params: Record<string, string>): void {
  const qs = new URLSearchParams(params).toString()
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${qs ? '?' + qs : ''}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: qs ? '?' + qs : '' })
  }
}

async function createWindow(
  params: Record<string, string> = {},
  opts?: { bounds?: WindowBounds }
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: opts?.bounds?.width ?? 1280,
    height: opts?.bounds?.height ?? 800,
    ...(opts?.bounds ? { x: opts.bounds.x, y: opts.bounds.y } : {}),
    title: 'Navide',
    titleBarStyle: 'hidden',
    // Start hidden and show only once the renderer has painted its first frame,
    // so the user never sees the white flash of an unpainted window. The dark
    // backgroundColor matches the default theme as a safety net for the instant
    // between show() and paint.
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium throttles occluded windows: rAF pauses, setTimeout is clamped
      // to >=1s, and after 5 minutes hidden it drops to roughly once a minute.
      // Terminal panes drain PTY output through a timer and xterm's WriteBuffer
      // yields with setTimeout every 12ms, so throttling turns a backgrounded
      // window into multi-second keystroke lag once the user switches back.
      backgroundThrottling: false
    }
  })
  mainWindows.add(win)
  mainWindow = win
  const winId = win.id // captured — win.id is not readable after destroy
  // A detached run-group child window is scoped to one group of its workspace —
  // never track it as a standalone workspace window (no dedup focus, no restore).
  if (params.detached_group) {
    detachedWindowIds.add(winId)
  } else if (params.workspace_path) {
    mainWindowWorkspaces.set(win, params.workspace_path)
    windowRegistry.setWorkspace(winId, params.workspace_path)
  }
  win.on('moved', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  win.on('resized', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  // backgroundThrottling is off for the terminals, which also pins the
  // renderer's document.hidden to false — so the Page Visibility API can no
  // longer tell it when to pause background polling. Report the window state
  // directly instead (see App.vue's git status poll).
  const sendVisibility = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('window:visibility', win.isVisible() && !win.isMinimized())
  }
  win.on('hide', sendVisibility)
  win.on('show', sendVisibility)
  win.on('minimize', sendVisibility)
  win.on('restore', sendVisibility)
  // Show on first paint (theme already applied → no white/wrong-theme flash).
  // Fallback timer guarantees the window appears even if ready-to-show is missed.
  let _shown = false
  const showOnce = (): void => {
    if (_shown || win.isDestroyed()) return
    _shown = true
    win.show()
  }
  win.once('ready-to-show', showOnce)
  setTimeout(showOnce, 4000)
  win.on('focus', () => { mainWindow = win })
  win.on('closed', () => {
    mainWindows.delete(win)
    mainWindowWorkspaces.delete(win)
    windowRegistry.remove(winId)
    detachedWindowIds.delete(winId)
    if (mainWindow === win) {
      const remaining = [...mainWindows]
      mainWindow = remaining.length ? remaining[remaining.length - 1] : null
    }
    broadcastOpenWorkspacesChanged()
  })

  loadWindow(win, { window: 'main', ...params })
  return win
}

function revealMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  app.focus({ steal: true })
  win.focus()
}

function focusOrCreateMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow)
    return
  }

  void createWindow().then((win) => {
    // createWindow intentionally stays hidden until its first painted frame.
    // Focus it after that initial show so reopening from the Dock never appears
    // to do nothing and does not reintroduce the startup white flash.
    if (win.isVisible()) revealMainWindow(win)
    else win.once('show', () => revealMainWindow(win))
  })
}

// The Pipeline Manager is a modal inside a workspace window: reveal one and let
// its renderer open the modal. Target selection mirrors sendMenuAction (detached
// run-group children never host it), and a window is created when none is left —
// on macOS the app outlives its last window, where a silent no-op would make the
// menu item look broken. The send waits for the first paint so it can never race
// the renderer's listener registration.
function requestPipelineManager(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target =
    focused && !focused.isDestroyed() && mainWindows.has(focused) && !detachedWindowIds.has(focused.id)
      ? focused
      : [...mainWindows].reverse().find((w) => !w.isDestroyed() && !detachedWindowIds.has(w.id))

  const send = (win: BrowserWindow): void => {
    if (!win.isDestroyed()) win.webContents.send('menu:open-pipeline-manager', {})
  }
  const revealAndSend = (win: BrowserWindow): void => {
    if (win.isVisible()) {
      revealMainWindow(win)
      send(win)
    } else {
      win.once('show', () => {
        revealMainWindow(win)
        send(win)
      })
    }
  }

  if (target) revealAndSend(target)
  else void createWindow().then(revealAndSend)
}

function backendInfoPayload() {
  if (!backend) {
    return backendLastError
      ? { status: 'error' as const, error: backendLastError }
      : { status: 'starting' as const }
  }
  return {
    status: 'ready' as const,
    host: backend.host,
    port: backend.port,
    pid: backend.proc.pid,
    shell: backend.shell,
    httpUrl: `http://${backend.host}:${backend.port}`,
    wsUrl: `ws://${backend.host}:${backend.port}/ws`
  }
}

// Push the current backend info to every window so each renderer's useBackend
// can reconnect after a restart (the port changes) or show disconnected on stop.
// Only the focused window(s) get it immediately — otherwise a single backend
// blip flashes "reconnecting" in every open window at once. Backgrounded
// windows get the latest snapshot queued and delivered on their next 'focus'
// event (see below).
const backendBroadcastTracker = new BackendBroadcastTracker<ReturnType<typeof backendInfoPayload>>()

function broadcastBackendChanged(): void {
  const payload = backendInfoPayload()
  // The plugin capability broker connects to the backend directly from main
  // (it must not proxy through a renderer), so it needs the wsUrl the same way
  // the renderers do — pushed on every backend transition.
  frontendPluginManager.setBackendWsUrl(payload.status === 'ready' ? payload.wsUrl : null)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const { immediate } = backendBroadcastTracker.dispatch(win.id, win.isFocused(), payload)
    if (immediate) win.webContents.send('backend:changed', payload)
  }
}

// Flush a queued backend info snapshot to a window as soon as it regains
// focus, and stop tracking it once closed. Registered on every BrowserWindow
// (not just main windows) so Roles/Stages/Editor windows behave the same way.
app.on('browser-window-created', (_event, win) => {
  win.on('focus', () => {
    const payload = backendBroadcastTracker.takePending(win.id)
    if (payload !== undefined && !win.isDestroyed()) win.webContents.send('backend:changed', payload)
  })
  win.on('closed', () => backendBroadcastTracker.forget(win.id))
})

// Extensions view: install/update/remove third-party plugins. Verified packages
// are written under userData/plugins and scanned back on next launch.
const pluginsRoot = (): string => join(app.getPath('userData'), 'plugins')
registerPluginIpc(frontendPluginManager, pluginsRoot())
frontendPluginManager.loadInstalledPlugins(pluginsRoot())

// Storage usage & cleanup: clears only Electron-owned caches (Chromium HTTP/
// code/GPU caches, electron-updater downloads). Never user state.
registerStorageIpc()

// Bundled mini-IDE — the official builtin editor surface, shipped inside the
// app package (resources/plugins/mini-ide) and built from dist-plugins in dev.
// An officially-verified marketplace install scanned above takes precedence;
// see registerBundledMiniIde for the full precedence order.
const bundledMiniIde = registerBundledMiniIde(frontendPluginManager, {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
if (!bundledMiniIde.registered) {
  console.warn(`[main] bundled mini-IDE unavailable: ${bundledMiniIde.reason}`)
}

// Bundled Plans — the official builtin plan surface, shipped inside the app
// package (resources/plugins/plans) and built from dist-plugins in dev. Mirrors
// the mini-IDE registration above; see registerBundledPlans for precedence.
const bundledPlans = registerBundledPlans(frontendPluginManager, {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
if (!bundledPlans.registered) {
  console.warn(`[main] bundled Plans unavailable: ${bundledPlans.reason}`)
}

// Bundled Git — the official builtin standalone Git client surface, shipped
// inside the app package (resources/plugins/git) and built from dist-plugins in
// dev. Mirrors the mini-IDE / Plans registration above; see registerBundledGit
// for precedence.
const bundledGit = registerBundledGit(frontendPluginManager, {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
if (!bundledGit.registered) {
  console.warn(`[main] bundled Git unavailable: ${bundledGit.reason}`)
}

ipcMain.handle('backend:info', () => backendInfoPayload())

// A backend that dies after a successful start must not keep reporting
// 'ready' with a dead port: watch its exit and, if it is still the active
// handle (deliberate stop/restart/quit paths clear `backend` BEFORE killing
// the process, so those exits are ignored), surface the crash so every
// window's useBackend reaches the terminal 'error' state and the existing
// Retry UI takes over. Deliberately no auto-restart.
function watchBackendCrash(b: BackendHandle): void {
  watchBackendExit(b.proc, () => backend === b, (message) => {
    console.error(`[main] ${message}`)
    backend = null
    backendLastError = message
    broadcastBackendChanged()
  })
}

// Serialize lifecycle ops so a double-click can't spawn two backends or race a
// stop against a start.
let backendBusy = false

ipcMain.handle('backend:restart', async () => {
  if (backendBusy) return backendInfoPayload()
  backendBusy = true
  try {
    // A restart during the initial spawn must not double-spawn: wait for the
    // in-flight start to settle first (its promise never rejects) so the
    // handle it produces lands in `backend` and is stopped below instead of
    // being orphaned when overwritten.
    if (backendStarting) {
      await backendStarting
      backendStarting = null
    }
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    try {
      backend = await startBackend(readHealthCheckTimeoutSec(healthTimeoutPath()) * 1000)
      backendLastError = null
      watchBackendCrash(backend)
      console.log(`[main] backend restarted at ${backend.host}:${backend.port}`)
    } catch (err) {
      console.error('[main] backend restart failed', err)
      backend = null
      backendLastError = String(err)
    }
    broadcastBackendChanged()
    return backendInfoPayload()
  } finally {
    backendBusy = false
  }
})

ipcMain.handle('backend:stop', async () => {
  if (backendBusy) return { ok: false }
  backendBusy = true
  try {
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    broadcastBackendChanged()
    return { ok: true }
  } finally {
    backendBusy = false
  }
})

ipcMain.handle('workspace:pick', async (_event, defaultPath?: string) => {
  const opts: Electron.OpenDialogOptions = {
    title: 'Pick workspace folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder'
  }
  if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('workspace:new', async () => {
  const opts: Electron.OpenDialogOptions = {
    title: 'New workspace folder',
    defaultPath: app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder'
  }

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('app:home-dir', () => app.getPath('home'))

/**
 * Read the current UI theme id from the backend-owned ui_settings.json ('' when
 * unset/unreadable). Store values are JSON-encoded strings (lib/settings keeps
 * the legacy localStorage encoding), so the raw value needs a second parse.
 */
function readUiSettings(): Record<string, unknown> {
  try {
    const dataDir = resolveBackendDataDir({
      envOverride: process.env.AGENT_TEAM_DATA_DIR,
      isPackaged: app.isPackaged,
      appDataPath: app.getPath('appData'),
      platform: process.platform,
      homeDir: app.getPath('home'),
      xdgDataHome: process.env.XDG_DATA_HOME
    })
    return JSON.parse(readUiSettingsText(join(dataDir, UI_SETTINGS_FILE))) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** One ui_settings value, decoded. Returns null when absent or malformed. */
function uiSetting<T>(settings: Record<string, unknown>, key: string): T | null {
  const raw = settings[key]
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function currentUiTheme(): string {
  const theme = uiSetting<string>(readUiSettings(), 'agent-team:theme')
  return typeof theme === 'string' ? theme : ''
}

const DEFAULT_EDITOR_SETTING_KEY = 'agentTeam.defaultEditor'
const DEFAULT_EDITOR_COMMAND_KEY = 'agentTeam.defaultEditor.customCommand'

/** The user's default-editor preference, read fresh per open. Settings changes
 *  reach main through the backend's ui_settings.json mirror (written on every
 *  set), so there is no cache to invalidate and no IPC to keep in sync. */
function currentEditorPreference(): EditorPreference {
  const settings = readUiSettings()
  const rawCommand = uiSetting<unknown>(settings, DEFAULT_EDITOR_COMMAND_KEY)
  const customCommand = Array.isArray(rawCommand)
    ? rawCommand.filter((part): part is string => typeof part === 'string')
    : []
  const editorId = normalizeEditorId(
    uiSetting<string>(settings, DEFAULT_EDITOR_SETTING_KEY),
    customCommand
  )
  return { editorId, customCommand }
}

// Editor detection is filesystem work over every PATH entry; cache it and let
// Settings force a rescan after the user installs something.
let detectedEditorsCache: DetectedEditor[] | null = null

function currentDetectedEditors(refresh = false): DetectedEditor[] {
  if (refresh || !detectedEditorsCache) {
    detectedEditorsCache = detectEditors(getResolvedUserPath())
  }
  return detectedEditorsCache
}

// An external editor that cannot be launched falls back to the mini-IDE, which
// on its own looks like the setting was ignored. Warn once per editor id per
// session: enough to explain it, not so much that every click nags.
const warnedEditorIds = new Set<string>()

function warnEditorUnavailable(target: BrowserWindow | null, editorId: string): void {
  if (warnedEditorIds.has(editorId)) return
  warnedEditorIds.add(editorId)
  const win = target && !target.isDestroyed() ? target : mainWindow
  if (!win || win.isDestroyed()) return
  void dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Editor unavailable',
    message: `Could not open your default editor (${editorId})`,
    detail:
      'Navide opened the file in the Mini-IDE instead. Check Settings → General → Default editor: ' +
      'the editor may not be installed, or its command may have moved.',
  })
}

/**
 * Spawn an external editor. Resolves false when the process could not start or
 * died with a non-zero status right away — the caller then falls back.
 *
 * argv is passed as an array and never through a shell, so a path containing
 * spaces or shell metacharacters stays a single argument. PATH is the
 * login-shell one the backend resolved: the PATH Electron inherits when
 * launched from Finder omits Homebrew and friends.
 */
function launchExternalEditor(argv: string[], cwd?: string): Promise<boolean> {
  const [command, ...args] = argv
  if (!command) return Promise.resolve(false)
  return launchEditorProcess(() =>
    spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: getResolvedUserPath() }
    })
  )
}

/**
 * Route one editor-open request: the mini-IDE (default, and the only surface
 * that can serve diff/sidebar/bare opens), the OS default application, or the
 * external editor the user chose. Any failure past the decision point falls
 * back to the mini-IDE, so an open never silently does nothing.
 */
async function routeEditorOpen(
  host: BrowserWindow | null,
  params: Record<string, string>
): Promise<boolean> {
  const preference = currentEditorPreference()
  const route = classifyOpenRequest(params, preference)
  if (route.via === 'mini-ide') return openMiniIdeEditor(host, params)

  const workspacePath = params.workspace_path ?? ''
  // `file_ws` (an out-of-workspace file's own root) is what `filepath` is
  // relative to when present — the same containment rule as the fallback path.
  const abs = resolveExternalOpenTarget(params.file_ws || workspacePath, params.filepath ?? '')
  if (!abs) return openMiniIdeEditor(host, params)

  if (route.via === 'system') {
    // shell.openPath returns '' on success, or an error message.
    const err = await shell.openPath(abs)
    if (!err) return true
    return openMiniIdeEditor(host, params)
  }

  const parsedLine = Number.parseInt(params.line ?? '', 10)
  const argv = buildEditorArgv(route.editorId, currentDetectedEditors(), preference.customCommand, {
    file: abs,
    line: Number.isFinite(parsedLine) ? parsedLine : undefined,
    workspace: workspacePath
  })
  if (argv && (await launchExternalEditor(argv))) return true
  warnEditorUnavailable(host, route.editorId)
  return openMiniIdeEditor(host, params)
}

/**
 * Open a folder in an editor: the id the caller asked for ("Open with…"), or
 * the user's default. `mini-ide` reopens the mini-IDE against that folder as
 * its workspace root; everything else hands the directory to the editor.
 */
async function openFolderInEditor(
  host: BrowserWindow | null,
  dir: string,
  editorId?: string
): Promise<boolean> {
  if (!dir || !existsSync(dir)) return false
  const preference = currentEditorPreference()
  const id = editorId
    ? normalizeEditorId(editorId, preference.customCommand)
    : preference.editorId
  if (id === DEFAULT_EDITOR_ID) return openMiniIdeEditor(host, { workspace_path: dir })
  if (id === 'system') {
    const err = await shell.openPath(dir)
    if (!err) return true
    warnEditorUnavailable(host, id)
    return false
  }
  const argv = buildEditorArgv(id, currentDetectedEditors(), preference.customCommand, {
    dir,
    workspace: dir
  })
  if (argv && (await launchExternalEditor(argv, dir))) return true
  warnEditorUnavailable(host, id)
  return false
}

/**
 * Open the mini-IDE plugin view (the editor surface) in its dedicated window,
 * forwarding editor open params (`filepath`/`file_ws`/`line`/`sidebar`/`diff_*`/
 * `branch_diff_*`) as the entry query EditorWindowApp reads from
 * `window.location.search`. A changed workspace reloads the running view (see
 * FrontendPluginManager.open) — `file_ws`, the root of a file living outside
 * the workspace, deliberately is NOT part of that identity, so opening an
 * external file adds a tab instead of reloading; `host` only parents the
 * unavailable-fallback dialog.
 */
function openMiniIdeEditor(host: BrowserWindow | null, params: Record<string, string>): boolean {
  const { workspace_path: workspacePath = '', ...extraParams } = params
  const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
  const opened = openMiniIdePluginView(workspacePath, httpUrl, extraParams, currentUiTheme())
  if (!opened) {
    // Last-resort fallback: the mini-IDE ships bundled with the app, so this
    // only fires when the bundled assets are missing/invalid and no verified
    // marketplace install is present.
    const target = host && !host.isDestroyed() ? host : mainWindow
    if (target && !target.isDestroyed()) {
      void handleMiniIdeUnavailable(target, workspacePath, extraParams)
    }
  }
  return opened
}

// The `ui.open_in_editor` host capability (plugin broker): a sandboxed plugin
// view (e.g. the Git window's file list) asks the host to open a file. It goes
// through the same router as window:openEditor so the user's default-editor
// choice applies here too, with the mini-IDE as the fallback.
frontendPluginManager.setOpenInEditorHandler((params) => routeEditorOpen(null, params))

// Shell-level host capabilities (plugin broker): the Git window's remote/
// worktree cards need the same shell actions GitPane reaches via
// window.agentTeam — browser open, Finder reveal, open-workspace-window
// (mirrors the window:openMain handler), and a native directory picker.
frontendPluginManager.setHostShellHandlers({
  openExternal: async (url) => {
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  },
  revealPath: (target) => {
    try {
      shell.showItemInFolder(target)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  },
  openWorkspace: (ws) => {
    const existing = findMainWindowForWorkspace(ws)
    if (existing) {
      revealMainWindow(existing)
      return { ok: true }
    }
    // duplicate=1: same semantics as window:openMain — skip pane restore for a
    // window cloned while its source's CLI sessions are still running.
    void createWindow({ workspace_path: ws, duplicate: '1' })
    return { ok: true }
  },
  pickFolder: async (defaultPath) => {
    const opts = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      ...(defaultPath ? { defaultPath } : {}),
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]!
  },
})

/**
 * Fallback when the mini-IDE plugin view could not be opened: plain file opens
 * go to the OS default application; diff/branch-diff and bare opens keep a
 * dialog (no external equivalent).
 */
async function handleMiniIdeUnavailable(
  target: BrowserWindow,
  workspacePath: string,
  params: Record<string, string>
): Promise<void> {
  const kind = classifyEditorOpen(params)
  if (kind === 'file') {
    // `file_ws` (an out-of-workspace file's own root) is what `filepath` is
    // relative to when present — resolving it against the workspace instead
    // would point at a different file, or at nothing.
    const abs = resolveExternalOpenTarget(params.file_ws || workspacePath, params.filepath ?? '')
    if (abs) {
      // shell.openPath returns an empty string on success, or an error message.
      const err = await shell.openPath(abs)
      if (err) shell.showItemInFolder(abs)
      return
    }
    // Missing/unsafe target (e.g. stale reference) — fall through to the dialog.
  }
  void dialog.showMessageBox(target, {
    type: 'info',
    title: 'Mini-IDE unavailable',
    message: kind === 'diff' ? 'Diff view requires the Mini-IDE' : 'Mini-IDE could not be loaded',
    detail:
      (kind === 'diff'
        ? 'Diff views can only be shown in the Mini-IDE, and its bundled assets are missing or invalid. '
        : 'The bundled Mini-IDE assets are missing or invalid. ') +
      'Reinstall Navide, or install the Mini-IDE extension from Settings → Extensions. ' +
      '(Development: run `pnpm run build:mini-ide` to produce dist-plugins/mini-ide.)',
  })
}

function openDiffWindow(host: BrowserWindow | null, params: Record<string, string>): void {
  // EditorWindowApp reads diff_filepath/diff_staged from the entry query on
  // startup (or after the query-change reload) and opens the diff tab.
  openMiniIdeEditor(host, {
    workspace_path: params.workspace_path ?? '',
    diff_filepath: params.filepath ?? '',
    diff_staged: params.staged ?? '',
    diff_name: params.name ?? params.filepath ?? '',
    diff_commit: params.commit ?? '',
    sidebar: 'git',
  })
}

ipcMain.handle('window:openMain', (_event, args?: { workspace_path?: string }) => {
  const params: Record<string, string> = {}
  const ws = (args?.workspace_path ?? '').trim()
  if (ws) {
    // Already open in some window → focus it instead of duplicating.
    const existing = findMainWindowForWorkspace(ws)
    if (existing) {
      revealMainWindow(existing)
      return { ok: true }
    }
    params.workspace_path = ws
    // duplicate=1 marks a window cloned from a live one (its source's CLI
    // sessions are still running), so the renderer skips pane restore once.
    // Externally-opened workspaces (openWorkspaceFromPath) must NOT carry
    // this — their previous sessions are dead and restore should run.
    params.duplicate = '1'
  }
  void createWindow(params)
  return { ok: true }
})

// The renderer switches workspaces at runtime (Welcome picker / back-to-Welcome)
// without reloading, so main's per-window workspace map — and the crash-restore
// registry — must be told. Empty path = the window returned to Welcome.
ipcMain.on('window:reportWorkspace', (event, workspacePath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win)) return
  if (detachedWindowIds.has(win.id)) return // detached child — never registry-tracked
  const ws = String(workspacePath ?? '').trim()
  if (ws) mainWindowWorkspaces.set(win, ws)
  else mainWindowWorkspaces.delete(win)
  windowRegistry.setWorkspace(win.id, ws)
  broadcastOpenWorkspacesChanged()
})

// Renderers push the latest recent-workspaces list so the native File > Open
// Recent submenu stays in sync. Every window pushes on each change, so skip the
// rebuild when the list is unchanged.
ipcMain.on('menu:setRecents', (_e, recents: RecentMenuEntry[]) => {
  const next = Array.isArray(recents) ? recents : []
  if (JSON.stringify(next) === JSON.stringify(lastRecents)) return
  lastRecents = next
  rebuildAppMenu()
})

// Welcome screens badge already-open workspaces and focus the existing window
// instead of opening a duplicate (same-folder double-open causes PTY/git
// conflicts). listOpen feeds the badges; focusExisting is the click path —
// it returns false when the workspace is only open in the asking window
// itself, so re-selecting your own workspace stays a normal no-op open.
ipcMain.handle('workspace:listOpen', () => {
  const open: string[] = []
  for (const [win, wp] of mainWindowWorkspaces) {
    if (!win.isDestroyed()) open.push(wp)
  }
  return open
})

ipcMain.handle('workspace:focusExisting', (event, workspacePath: string) => {
  const self = BrowserWindow.fromWebContents(event.sender)
  const existing = findMainWindowForWorkspace(String(workspacePath ?? ''))
  if (!existing || existing === self) return false
  revealMainWindow(existing)
  return true
})

// ── Crash-restore prompt (see window-registry.ts) ────────────────────────────
// The first window to ask claims the banner; apply/dismiss both clear it.
ipcMain.handle('restore:getPending', () => {
  if (!pendingRestore || pendingRestoreClaimed) return null
  pendingRestoreClaimed = true
  return pendingRestore.map((w) => w.workspace_path)
})

ipcMain.handle('restore:apply', () => {
  const entries = pendingRestore ?? []
  pendingRestore = null
  for (const entry of entries) {
    // Already reopened manually → focus, don't duplicate.
    const existing = findMainWindowForWorkspace(entry.workspace_path)
    if (existing) {
      revealMainWindow(existing)
    } else {
      // No duplicate=1 flag: a crash-restore boot's sessions are dead, so the
      // renderer runs pane restore (restore=1 is informational only).
      void createWindow(
        { workspace_path: entry.workspace_path, restore: '1' },
        entry.bounds ? { bounds: entry.bounds } : undefined
      )
    }
  }
  return { ok: true, opened: entries.length }
})

ipcMain.handle('restore:dismiss', () => {
  pendingRestore = null
  return { ok: true }
})

ipcMain.handle('restore:getAutoRestore', () => windowRegistry.getRestoreOnLaunch())

ipcMain.handle('restore:setAutoRestore', (_e, value: boolean) => {
  windowRegistry.setRestoreOnLaunch(value === true)
  return { ok: true }
})

// ── Detached run-group windows ───────────────────────────────────────────────
// Open a run group of a workspace in its own scoped child window. The main
// window(s) of that workspace are told to hand the group off (group:detached);
// when the child closes, they are told to take it back (group:reattached).
ipcMain.handle(
  'window:detachGroup',
  async (_e, arg: { groupId?: string; workspacePath?: string; bounds?: WindowBounds }) => {
    const groupId = String(arg?.groupId ?? '')
    const workspacePath = String(arg?.workspacePath ?? '')
    if (!groupId || !workspacePath) return { ok: false }
    const existing = detachedGroups.get(groupId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return { ok: true }
    }
    const child = await createWindow(
      { window: 'main', workspace_path: workspacePath, detached_group: groupId },
      arg.bounds ? { bounds: arg.bounds } : undefined
    )
    detachedGroups.set(groupId, child)
    detachedGroupWorkspace.set(groupId, workspacePath)
    broadcastToWorkspace(workspacePath, 'group:detached', { groupId })
    child.on('closed', () => {
      detachedGroups.delete(groupId)
      detachedGroupWorkspace.delete(groupId)
      broadcastToWorkspace(workspacePath, 'group:reattached', { groupId })
    })
    return { ok: true }
  }
)

ipcMain.handle('window:getDetachedGroups', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const ws = win ? mainWindowWorkspaces.get(win) : undefined
  if (!ws) return [] as string[]
  const result: string[] = []
  for (const [gid, child] of detachedGroups) {
    if (!child.isDestroyed() && detachedGroupWorkspace.get(gid) === ws) result.push(gid)
  }
  return result
})

ipcMain.handle('window:openDiff', (event, args: Record<string, string>) => {
  openDiffWindow(BrowserWindow.fromWebContents(event.sender), args ?? {})
  return { ok: true }
})

// The standalone Git client plugin view — its own dedicated window (mini-IDE
// parity), opened from the main window's "open standalone Git" entry. Resolves
// the backend HTTP base + current theme like openMiniIdeEditor.
function openGitWindow(workspacePath: string, extraParams: Record<string, string> = {}): boolean {
  const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
  return openGitPluginView(workspacePath, httpUrl, currentUiTheme(), extraParams)
}

ipcMain.handle('window:openGit', (_event, args: Record<string, string>) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  // Optional diff target: focus the Git window on a file's diff (shown in its
  // own panel, not the mini-IDE). GitWindowApp reads these git_diff_* keys on
  // load and via the incremental openTarget delivery when already open.
  const extraParams: Record<string, string> = {}
  if (args.filepath) {
    extraParams.git_diff_filepath = args.filepath
    extraParams.git_diff_staged = args.staged ?? ''
    extraParams.git_diff_commit = args.commit ?? ''
  }
  const ok = openGitWindow(workspacePath, extraParams)
  return { ok }
})

function openBranchDiffWindow(host: BrowserWindow | null, params: Record<string, string>): void {
  // EditorWindowApp reads branch_diff_base/branch_diff_compare from the entry
  // query on startup (or after the query-change reload) and opens the tab.
  openMiniIdeEditor(host, {
    workspace_path: params.workspace_path ?? '',
    branch_diff_base: params.branch_diff_base ?? 'main',
    branch_diff_compare: params.branch_diff_compare ?? '',
  })
}

ipcMain.handle('window:openBranchDiff', (event, args: Record<string, string>) => {
  openBranchDiffWindow(BrowserWindow.fromWebContents(event.sender), args ?? {})
  return { ok: true }
})

// Reject only what git itself forbids in ref names (git-check-ref-format), so
// non-ASCII (e.g. CJK) branch names are allowed — matching the Python backend's
// _INVALID_REF_RE. An ASCII allowlist here wrongly rejected branches like
// "AI修改". Not the security boundary: execFile is exec-not-shell and the
// leading-'-' check below blocks flag smuggling.
const INVALID_GIT_REF_RE = /(\.\.|\x00|@\{|\\|[ ~^:?*[\]]|\/$|\.lock$|\.lock\/)/

function validateRef(value: string, label: string): string | null {
  if (!value) return null // empty is OK (means "omit")
  if (value.startsWith('-')) return `invalid ${label}: must not start with '-'`
  if (INVALID_GIT_REF_RE.test(value))
    return `invalid ${label}: contains characters git disallows in ref names`
  return null
}

// Run git diff directly in main process — no Python backend needed, always up-to-date.
ipcMain.handle('git:diff-head', async (_event, args: { workspace_path: string; base?: string; compare?: string }) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const cwd = (args.workspace_path ?? '').trim()
  if (!cwd) return { ok: false, diff: '', error: 'workspace_path required' }
  const compare = (args.compare ?? '').trim()
  const base = (args.base ?? '').trim()
  const refErr = validateRef(base, 'base') ?? validateRef(compare, 'compare')
  if (refErr) return { ok: false, diff: '', error: refErr }
  // A compare target needs an explicit base — align with the backend, which
  // errors here rather than silently diffing HEAD and ignoring compare.
  if (compare && !base) return { ok: false, diff: '', error: 'base branch is required to compare' }
  try {
    const gitArgs: string[] = ['-c', 'core.quotePath=false', 'diff']
    if (compare && base) {
      gitArgs.push(`${base}...${compare}`)
    } else {
      gitArgs.push('HEAD')
    }
    // timeout+SIGKILL so a hung git (stale mount, wedged filter) can't spin the
    // diff pane forever; generous maxBuffer since we only keep the first 100 K.
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      killSignal: 'SIGKILL'
    })
    const truncated = stdout.length > 100_000
    return { ok: true, diff: stdout.slice(0, 100_000), truncated }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; killed?: boolean; code?: string }
    if (e.killed) return { ok: false, diff: '', error: 'git diff timed out' }
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ok: false, diff: '', error: 'diff too large to display' }
    return { ok: false, diff: '', error: e.stderr?.trim() || e.message || 'git error' }
  }
})

// Reviewable plan doc: top-level, non-infrastructure `.agent-team/plans/*.html`
// (mirrors PlanWindowApp's isHtmlPlanDoc). Such opens route to the Plan window,
// which renders them; the mini-IDE would only show their raw HTML source.
function isHtmlPlanDocPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  if (!normalized.startsWith('.agent-team/plans/')) return false
  const name = normalized.slice('.agent-team/plans/'.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

ipcMain.handle('window:openEditor', async (event, args: Record<string, string>) => {
  const params = args ?? {}
  const workspacePath = params.workspace_path ?? ''
  const filepath = params.filepath ?? ''
  // With `file_ws` the path is relative to that root, not to the workspace —
  // it can never name this workspace's plan doc, so keep it out of the route.
  if (workspacePath && !params.file_ws && isHtmlPlanDocPath(filepath)) {
    openPlanWindow(workspacePath, filepath)
    return { ok: true }
  }
  const ok = await routeEditorOpen(BrowserWindow.fromWebContents(event.sender), params)
  return { ok }
})

// Default-editor surface for Settings and the "Open with…" menus: the built-in
// editors plus whether each one was found on this machine.
ipcMain.handle('editors:list', (_event, args?: { refresh?: boolean }) =>
  currentDetectedEditors(args?.refresh === true)
)

ipcMain.handle(
  'editor:openFolder',
  async (event, args: { dir?: string; editorId?: string }) => {
    const ok = await openFolderInEditor(
      BrowserWindow.fromWebContents(event.sender),
      args?.dir ?? '',
      args?.editorId
    )
    return { ok }
  }
)

// Plan review windows: one per workspace; reopening focuses the existing one.
const planWindows = new PlanWindowRegistry<BrowserWindow>()
// Plan windows whose renderer has not yet subscribed to plan:open-doc. Maps the
// window to the most recently requested plan; flushed on did-finish-load so a
// click made during load (before the subscription exists) is never lost.
const planWindowPending = new Map<BrowserWindow, string>()

function openPlanWindow(workspacePath: string, relPath?: string): void {
  const existing = planWindows.get(workspacePath)
  if (existing) {
    // Already open for this workspace: focus it and, when a plan was clicked,
    // ask the live window to switch to it instead of reopening a new window.
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (relPath) {
      if (planWindowPending.has(existing)) {
        // Renderer still loading and not yet subscribed: remember the latest
        // request; did-finish-load flushes the final choice.
        planWindowPending.set(existing, relPath)
      } else {
        existing.webContents.send('plan:open-doc', relPath)
      }
    }
    return
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Plans',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Hosts an AiCliDock terminal — see the main window for why throttling
      // must stay off.
      backgroundThrottling: false
    }
  })
  planWindows.set(workspacePath, win)
  // Registered before the renderer subscribes to plan:open-doc. Track the plan
  // this window was launched for; a click on a different plan during load
  // overwrites it, and did-finish-load re-sends the final choice if it differs.
  const initialRelPath = relPath ?? ''
  planWindowPending.set(win, initialRelPath)
  win.webContents.once('did-finish-load', () => {
    const pending = planWindowPending.get(win)
    planWindowPending.delete(win)
    if (pending && pending !== initialRelPath) {
      win.webContents.send('plan:open-doc', pending)
    }
  })
  win.on('closed', () => {
    planWindowPending.delete(win)
    planWindows.remove(workspacePath, win)
  })
  loadWindow(win, {
    window: 'plans',
    workspace_path: workspacePath,
    ...(relPath ? { rel_path: relPath } : {})
  })
}

ipcMain.handle('window:openPlans', (_event, args: { workspace_path?: string; rel_path?: string }) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  const relPath = (args?.rel_path ?? '').trim()
  openPlanWindow(workspacePath, relPath || undefined)
  return { ok: true }
})

// Git History: routes to the unified Git plugin window (its History view). The
// dedicated `?window=githistory` renderer it used to open is gone.
ipcMain.handle('window:openGitHistory', (_event, args: { workspace_path?: string }) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  const ok = openGitWindow(workspacePath)
  return { ok }
})

// Plan execute dispatch: the plan window hands an approved plan to a CLI
// agent. Focus the main window bound to the plan's workspace and forward the
// payload; that renderer creates/reuses the agent pane and injects the
// execution prompt. delivered:false when no main window is open for the
// workspace (the renderer-side handler re-validates the workspace anyway).
ipcMain.handle(
  'plans:dispatch-execution',
  (_event, args: { workspace_path?: string; rel_path?: string; agent_key?: string }): { delivered: boolean } => {
    const workspacePath = String(args?.workspace_path ?? '').trim()
    const relPath = String(args?.rel_path ?? '').trim()
    const agentKey = String(args?.agent_key ?? '').trim()
    if (!workspacePath || !relPath || !agentKey) return { delivered: false }
    const win = findMainWindowForWorkspace(workspacePath)
    if (!win || win.isDestroyed()) return { delivered: false }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('plans:execute-dispatch', {
      workspace_path: workspacePath,
      rel_path: relPath,
      agent_key: agentKey
    })
    return { delivered: true }
  }
)

// Dispatch outcome from the main window, forwarded to the workspace's plan
// window so it can confirm (toast) or roll back the execution record. Silently
// dropped when the plan window is gone — the plan window's dispatch timeout
// covers that case.
ipcMain.on(
  'plans:execution-result',
  (_event, args: { workspace_path?: string; rel_path?: string; ok?: boolean; reason?: string }) => {
    const workspacePath = String(args?.workspace_path ?? '').trim()
    const relPath = String(args?.rel_path ?? '').trim()
    if (!workspacePath || !relPath) return
    const win = planWindows.get(workspacePath)
    if (!win) return
    win.webContents.send('plans:execution-result', {
      workspace_path: workspacePath,
      rel_path: relPath,
      ok: args?.ok === true,
      ...(args?.reason ? { reason: String(args.reason) } : {})
    })
  }
)

// Editor-window AI Chat fetches a CLI pane's cleaned scrollback. Panes live in
// the main window(s), so relay the request there and await the matching reply
// (correlation id + timeout; see cli-buffer-relay.ts).
const cliBufferRelay = new CliBufferRelay()

ipcMain.on(CLI_BUFFER_REPLY_CHANNEL, (_event, requestId: string, result: CliPaneBufferResult) => {
  cliBufferRelay.handleReply(requestId, result)
})

ipcMain.handle('cli:get-pane-buffer', (_event, paneId: string): Promise<CliPaneBufferResult> => {
  const targets = [...mainWindows].filter((w) => !w.isDestroyed()).map((w) => w.webContents)
  return cliBufferRelay.request(targets, String(paneId ?? ''))
})

// Cross-window pane drop fallback. Same-app cross-window drops that land on
// an accepting drop target are delivered directly by Chromium and handled
// there; this path covers a release that NO drop target consumed (the source
// sees dropEffect 'none' in its dragend and reports the release point), and
// we hand it to the window under that point. Valid targets: the editor window
// plus every main window (other workspaces and detached group windows). Every
// OTHER app window still participates in the hit-test as an occluder, so a
// release on e.g. the Plans window never falls through to a main window
// covered underneath it.
ipcMain.on(
  PANE_DRAG_END_CHANNEL,
  (event, args: { paneId?: string; screenX?: number; screenY?: number }) => {
    const paneId = String(args?.paneId ?? '')
    if (!paneId) return
    const point = { x: Number(args?.screenX ?? 0), y: Number(args?.screenY ?? 0) }
    const sender = BrowserWindow.fromWebContents(event.sender)
    // A release inside the source window's own bounds means the user let go
    // over their own window (a non-drop area, or an Esc cancel) — the drag
    // keeps that window foreground, so never route to whatever sits beneath.
    if (sender && !sender.isDestroyed()) {
      const b = sender.getBounds()
      if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) {
        return
      }
    }
    const validTargets = new Set<BrowserWindow>(mainWindows)
    const windows: CandidateWindow<BrowserWindow>[] = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      windows.push({
        id: win.id,
        bounds: win.getBounds(),
        visible: win.isVisible(),
        minimized: win.isMinimized(),
        window: win
      })
    }
    const candidates = selectDropCandidates(
      windows,
      sender?.id ?? null,
      (id) => windowFocusSeq.get(id) ?? 0
    )
    const win = hitTestWindows(point, candidates)
    if (!win || !validTargets.has(win)) return
    win.webContents.send(EXTERNAL_PANE_DROP_CHANNEL, {
      paneId,
      screenX: point.x,
      screenY: point.y
    })
  }
)

// Native OS notification for CLI state changes (turn done / needs input). The
// renderer decides WHEN to call this (background-only, deduped) and supplies the
// already-localized title/body; main stays i18n-agnostic. Clicking the
// notification restores+focuses the most-recent main window and tells its
// renderer which pane to switch to via `notify:focusPane`.
ipcMain.handle(
  'window:notify',
  (event, args: { paneId?: string; title?: string; body?: string }): { ok: boolean } => {
    if (!Notification.isSupported()) return { ok: false }
    const title = String(args?.title ?? '').trim()
    if (!title) return { ok: false }
    const notification = new Notification({
      title,
      body: String(args?.body ?? ''),
      silent: false,
    })
    const paneId = String(args?.paneId ?? '')
    notification.on('click', () => {
      const win =
        BrowserWindow.fromWebContents(event.sender) ??
        (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
      if (!win) return
      revealMainWindow(win)
      if (paneId) win.webContents.send('notify:focusPane', paneId)
    })
    notification.show()
    return { ok: true }
  }
)

// Dock badge (macOS-only, Terminal.app-style): a number for how many panes have
// unseen done/attention activity. The renderer tracks WHEN to update it
// (useSystemNotify's pendingCount); main just reflects the count.
ipcMain.on('window:setBadgeCount', (event, count: number) => {
  if (process.platform !== 'darwin') return
  app.dock?.setBadge(count > 0 ? String(count) : '')
  // Mirror the count onto the sender window's own Dock tile (Terminal.app-style):
  // the system red badge shows on its thumbnail while the window is minimized.
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    setWindowDockTileBadge(win, count > 0 ? String(count) : '')
  }
})

ipcMain.handle(
  'dialog:saveJson',
  async (
    _event,
    args: { defaultName?: string; content: string; title?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
    const defaultName = args?.defaultName ?? 'export.json'
    const ext = defaultName.includes('.') ? defaultName.slice(defaultName.lastIndexOf('.') + 1) : 'json'
    const extFilters: Record<string, { name: string; extensions: string[] }> = {
      md:   { name: 'Markdown', extensions: ['md'] },
      json: { name: 'JSON',     extensions: ['json'] },
      txt:  { name: 'Text',     extensions: ['txt'] },
    }
    const primaryFilter = extFilters[ext] ?? { name: ext.toUpperCase(), extensions: [ext] }
    const opts: Electron.SaveDialogOptions = {
      title: args?.title ?? 'Export',
      defaultPath: defaultName,
      filters: [
        primaryFilter,
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      await fs.writeFile(result.filePath, args.content, 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

ipcMain.handle(
  'dialog:openJson',
  async (
    _event,
    args?: { title?: string }
  ): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Import JSON',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      const content = await fs.readFile(result.filePaths[0], 'utf-8')
      return { ok: true, path: result.filePaths[0], content }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

ipcMain.handle(
  'dialog:pickFile',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Select File',
      properties: ['openFile'],
      filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    }
    if (args?.defaultPath) opts.defaultPath = args.defaultPath
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, path: result.filePaths[0] }
  }
)

ipcMain.handle(
  'dialog:pickFiles',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Select Files',
      properties: ['openFile', 'multiSelections'],
      filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    }
    if (args?.defaultPath) opts.defaultPath = args.defaultPath
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, paths: result.filePaths }
  }
)

ipcMain.handle('shell:openTerminal', async (_event, command: string) => {
  if (!command || typeof command !== 'string') return { ok: false, error: 'invalid command' }
  // Open Terminal.app and run the install command interactively (sudo / OAuth
  // prompts need a real TTY). The command is AppleScript-escaped.
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Terminal" to do script "${escaped}"\ntell application "Terminal" to activate`
  return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    proc.on('error', (err) => resolve({ ok: false, error: String(err) }))
    proc.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: `osascript exited ${code}` }))
  })
})

// macOS TCC permissions (onboarding wizard). Requests are user-initiated only —
// a request may raise a system prompt, status never does.
ipcMain.handle('permissions:status', async () => await getPermissionStatuses())

ipcMain.handle(
  'permissions:request',
  async (_event, key: PermissionKey, payload?: { title?: string; body?: string }) =>
    await requestPermission(key, payload)
)

ipcMain.handle('permissions:open-settings', async (_event, key: PermissionKey) => {
  try {
    await openPermissionSettings(key)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('shell:openPath', async (_event, target: string) => {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  // shell.openPath returns an empty string on success, or an error message.
  const err = await shell.openPath(target)
  if (err) {
    // If openPath failed (e.g. file doesn't exist), try revealing the parent
    // directory in Finder so the user can navigate from there.
    try {
      shell.showItemInFolder(target)
      return { ok: true, revealed: true }
    } catch {
      return { ok: false, error: err }
    }
  }
  return { ok: true }
})

ipcMain.handle('shell:revealPath', async (_event, target: string) => {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  try {
    shell.showItemInFolder(target)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http/https allowed' }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Write read-only content (e.g. a file's HEAD version) to a temp file and open
// it with the OS default app — the equivalent of Cursor's "Open File (HEAD)".
ipcMain.handle('shell:openTempFile', async (_event, filename: string, content: string) => {
  if (!filename || typeof filename !== 'string') return { ok: false, error: 'invalid filename' }
  try {
    const dir = join(tmpdir(), 'agent-team-head')
    await mkdir(dir, { recursive: true })
    const safe = filename.replace(/[/\\]/g, '_')
    const file = join(dir, safe)
    await writeFile(file, content ?? '', 'utf8')
    const err = await shell.openPath(file)
    return err ? { ok: false, error: err } : { ok: true, path: file }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Read bytes from a file starting at a given offset. Used by the stage watcher
// to scan the outputLogFile for sentinel strings — more reliable than cleanBuffer
// which can be truncated or have scanFrom issues from Q&A injections.
ipcMain.handle('keybindings:read', async () => {
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    const content = await readFile(filePath, 'utf-8')
    return { ok: true, content }
  } catch {
    return { ok: true, content: '[]' }
  }
})

ipcMain.handle('keybindings:write', async (_event, content: string) => {
  if (typeof content !== 'string') return { ok: false, error: 'invalid content' }
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    await writeFile(filePath, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('fs:readFrom', async (_event, filePath: string, fromByte: number) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, content: '' }
  try {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(filePath)
    if (stat.size <= fromByte) return { ok: true, content: '', newOffset: fromByte }
    const fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(stat.size - fromByte)
    await fh.read(buf, 0, buf.length, fromByte)
    await fh.close()
    return { ok: true, content: buf.toString('utf-8'), newOffset: stat.size }
  } catch (e) {
    return { ok: false, content: '', newOffset: fromByte, error: String((e as Error)?.message ?? e) }
  }
})

// Canonical form of a path, over the same normalizer the main process uses for
// workspaces. The renderer has no fs access, but it needs this to tell whether
// two spellings — /tmp/wt/proj from a URL param vs /private/tmp/wt/proj from the
// OS file picker — name the same folder. Never rejects: an unresolvable path
// degrades to the trimmed input, and an empty answer simply leaves the caller
// comparing literals.
ipcMain.handle('fs:realpath', async (_event, target: string) => {
  if (typeof target !== 'string' || !target) return ''
  return normalizeWorkspacePath(target)
})

// Legacy spawnHistory fallback: find a manual-session log by filename when
// outputLogFile wasn't recorded at spawn time (see manual-log-search.ts).
ipcMain.handle('logs:findManualLog', async (_event, workspacePath: string, filename: string) => {
  if (!workspacePath || typeof workspacePath !== 'string') return { ok: false, path: null }
  try {
    const path = await findManualLogFile(workspacePath, filename)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, path: null, error: String((e as Error)?.message ?? e) }
  }
})

// Agent History content search: scans each resolved log path for `query`
// (case-insensitive, ANSI-stripped) and returns the ids of files that
// matched. See log-content-search.ts for the chunked-read implementation.
ipcMain.handle(
  'logs:searchContent',
  async (_event, args: { query: string; files: Array<{ id: string; path: string }> }) => {
    if (!args || typeof args.query !== 'string' || !Array.isArray(args.files)) return { matchedIds: [] }
    const matchedIds = await searchLogFiles(args.query, args.files)
    return { matchedIds }
  }
)

ipcMain.on('app:setQuitConfirm', (_event, cfg: Partial<typeof quitConfirm>) => {
  if (cfg && typeof cfg === 'object') quitConfirm = { ...quitConfirm, ...cfg }
})

ipcMain.on('settings:language-changed', (_event, locale: string) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:language-changed', locale)
  }
})

// Zero-flash startup settings: synchronously hand the backend-owned
// ui_settings.json to the renderer before first paint. This is the app's only
// sendSync IPC; the file is a few KB so the block is microseconds. Any error
// yields '{}' — the renderer falls back to defaults and reconciles over ws
// (see ui-settings-bootstrap.ts for the path-resolution contract).
ipcMain.on('settings:bootstrap', (event) => {
  const dataDir = resolveBackendDataDir({
    envOverride: process.env.AGENT_TEAM_DATA_DIR,
    isPackaged: app.isPackaged,
    appDataPath: app.getPath('appData'),
    platform: process.platform,
    homeDir: app.getPath('home'),
    xdgDataHome: process.env.XDG_DATA_HOME
  })
  event.returnValue = readUiSettingsText(join(dataDir, UI_SETTINGS_FILE))
})

ipcMain.handle('settings:health-timeout-read', () => {
  return { ok: true, timeoutSec: readHealthCheckTimeoutSec(healthTimeoutPath()) }
})

ipcMain.handle('settings:health-timeout-write', (_event, timeoutSec: number) => {
  try {
    writeHealthCheckTimeoutSec(healthTimeoutPath(), timeoutSec)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// CDP debug toggle read/write. The port/address switches themselves are
// applied at pre-ready startup (above) — a write here only takes effect after
// the app is restarted.
ipcMain.handle('settings:cdp-debug-read', () => {
  return { ok: true, config: readCdpDebugConfig(cdpDebugPath()) }
})

ipcMain.handle('settings:cdp-debug-write', (_event, config: CdpDebugConfig) => {
  try {
    writeCdpDebugConfig(cdpDebugPath(), config)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Git account registry IPC. CRUD + per-workspace binding live in main because
// safeStorage (token encryption) is a main-process API; the renderer only sees
// masked accounts and, at git-op time, the decrypted credential for the bound
// account. Handlers never throw across the IPC boundary — always { ok, ... }.
ipcMain.handle('git-accounts:available', () => {
  try {
    return { ok: true, available: getGitAccountsStore().available }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:list', () => {
  try {
    return { ok: true, accounts: getGitAccountsStore().list() }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:add', (_event, input: GitAccountInput) => {
  try {
    return { ok: true, account: getGitAccountsStore().add(input) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:update', (_event, id: string, patch: Partial<GitAccountInput>) => {
  try {
    getGitAccountsStore().update(id, patch)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:remove', (_event, id: string) => {
  try {
    getGitAccountsStore().remove(id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:bind', (_event, workspacePath: string, accountId: string) => {
  try {
    getGitAccountsStore().bind(workspacePath, accountId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:unbind', (_event, workspacePath: string) => {
  try {
    getGitAccountsStore().unbind(workspacePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:getBinding', (_event, workspacePath: string) => {
  try {
    return { ok: true, accountId: getGitAccountsStore().getBinding(workspacePath) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:getCredential', (event, workspacePath: string) => {
  // Sensitive: returns a decrypted PAT. Restrict to the top frame of a known
  // app window so a sub-frame/iframe injected into rendered content can't call
  // this to exfiltrate a token.
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win) || event.senderFrame?.parent) {
    return { ok: false, error: 'unauthorized' }
  }
  try {
    return { ok: true, credential: getGitAccountsStore().getCredentialForWorkspace(workspacePath) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Disable hardware-accelerated rendering entirely.
// --disable-gpu eliminates the GPU subprocess without running GPU code in-process.
// Previously we used --in-process-gpu to prevent a separate GPU process from
// crashing (SIGTERM/exit_code=15), but on macOS 26.5 + Electron 33 the
// Chrome_InProcGpuThread crashes on shutdown inside fontations_ffi teardown
// (SIGSEGV at 0x18).  --disable-gpu avoids both problems.
// WebSocket stability is now handled by the 50ms batch + 64KB cap in terminals.py.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

// Dev isolation: give a `npm run dev` instance its own Electron userData so its
// renderer localStorage (layout, settings) doesn't clobber the packaged app's
// when both run at once. Must be set before the app is ready / userData is read.
// The backend's state dir is isolated separately (see backend.ts). Packaged
// builds are untouched.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

// Chrome DevTools Protocol (CDP) debug toggle (Settings > MCP > External
// access). Must be applied before the app is ready — Electron only honors
// --remote-debugging-port set at this point. readCdpDebugConfig resolves any
// read/parse failure to disabled, so a bad file can never turn this on.
const cdpDebugConfig = readCdpDebugConfig(cdpDebugPath())
if (cdpDebugConfig.enabled) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpDebugConfig.port))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

// Folder paths handed to the app from outside (Finder "Open With", a macOS
// Quick Action, or CLI args) open as workspaces. Paths that arrive via the
// `open-file` event before the app is ready (cold launch) are queued here and
// drained in whenReady once a window can be created.
const pendingOpenPaths: string[] = []

// Resolve an incoming path to a workspace folder (a file resolves to its parent)
// and open it in a new main window. Returns false if the path doesn't exist.
function openWorkspaceFromPath(p: string): boolean {
  const target = (p ?? '').trim()
  if (!target) return false
  let dir: string
  try {
    dir = statSync(target).isDirectory() ? target : dirname(target)
  } catch {
    return false
  }
  if (app.isReady()) {
    console.log('[main] open workspace from external path:', dir)
    // If a window already has this workspace open, focus it instead of duplicating.
    const existing = findMainWindowForWorkspace(dir)
    if (existing) {
      revealMainWindow(existing)
      return true
    }
    // The app is usually backgrounded when a Quick Action / "Open With" fires,
    // so bring it to the front and focus the new window — otherwise the window
    // opens behind Finder and looks like nothing happened.
    void createWindow({ workspace_path: dir }).then((win) => {
      app.focus({ steal: true })
      win.focus()
    })
  } else {
    console.log('[main] queue workspace from external path (pre-ready):', dir)
    pendingOpenPaths.push(dir)
  }
  return true
}

// Pull workspace folder paths out of a process argv array (cold-start CLI args
// or a relaunch's second-instance argv). Skips flags and the executable itself.
function workspacePathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => a && !a.startsWith('-') && existsSync(a))
}

// macOS delivers folders/files opened via Finder, "Open With", or a Quick Action
// (`open -b <bundleid> <path>`) through this event — the canonical way to receive
// an external path. Register it as early as possible so launch-time events queue.
app.on('open-file', (event, p) => {
  event.preventDefault()
  openWorkspaceFromPath(p)
})

// Single-instance lock: a second launch must NOT spawn a parallel backend.
// On macOS, closing the window leaves the app alive (see window-all-closed
// below), so relaunching from Finder/Dock would otherwise start a second main
// process — each spawning its own backend that fights over the shared
// ~/.agent-team state, while the orphaned backend is never reaped.
//
// Packaged builds only. In dev, electron-vite owns the process lifecycle and
// restarts often; an instance that didn't exit cleanly (Ctrl+C not reaping the
// Electron child, or macOS keeping the app alive after the window closed) would
// hold the lock and make the next `npm run dev` silently quit at launch.
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // A relaunch carrying folder paths (e.g. a Quick Action that still uses
    // `open -n`) lands here because we hold the single-instance lock. Open the
    // folders as workspaces instead of dropping them.
    const paths = workspacePathsFromArgv(argv)
    if (paths.length) {
      for (const dir of paths) openWorkspaceFromPath(dir)
      return
    }
    // Plain relaunch with no path: focus the existing window (or create one) and
    // reuse the running backend instead of booting another.
    focusOrCreateMainWindow()
  })
}

// Lock down top-level navigation. By default, dropping a file onto a window (or
// any stray location change) navigates the whole window to that URL, replacing
// the app with e.g. a raw .js file's source. This app is a single index.html
// SPA — it never legitimately navigates away — so allow only the dev-server
// origin (HMR/reloads) and our own index.html, and deny every window.open
// except external http(s) links routed to the OS browser.
const DEV_ORIGIN = process.env['ELECTRON_RENDERER_URL']
  ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
  : null
function isAppNavigation(url: string): boolean {
  try {
    const u = new URL(url)
    if (DEV_ORIGIN && u.origin === DEV_ORIGIN) return true
    if (u.protocol === 'file:') return u.pathname.endsWith('/renderer/index.html')
  } catch {
    // Malformed URL — treat as not-app and block.
  }
  return false
}
app.on('web-contents-created', (_e, contents) => {
  // Pane zoom changes terminal/editor font size only. Never let a retained
  // Chromium/Electron page zoom scale the entire Navide interface.
  lockPageZoom(contents)
  // Electron has no default right-click menu; without this one, right-click is
  // inert everywhere and there is no fallback path for copy/paste.
  installContextMenu(contents)
  contents.on('will-navigate', (e, url) => {
    if (!isAppNavigation(url)) e.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})
registerTerminalContextMenu()

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  // The plugin-view dev entry is opt-in via AGENT_TEAM_PLUGIN_DEV=1 so the
  // default menu / UI is unchanged for every normal launch (dev or packaged).
  const pluginDevEnabled = process.env['AGENT_TEAM_PLUGIN_DEV'] === '1'
  if (pluginDevEnabled) {
    // Dev-only: register the locally built mini-IDE (dist-plugins/mini-ide) so
    // editor/diff opens work without a marketplace install. Overrides any
    // installed copy for this run (registerDescriptor replaces by id).
    const devDescriptor = devMiniIdePluginDescriptor()
    if (existsSync(devDescriptor.entryFile)) {
      frontendPluginManager.registerDescriptor(devDescriptor, { builtin: true })
    } else {
      console.warn(
        '[main] AGENT_TEAM_PLUGIN_DEV=1 but mini-IDE dev bundle is missing — run `pnpm run build:mini-ide`'
      )
    }
    // Dev-only: register the locally built Plans plugin (dist-plugins/plans),
    // same gate and override semantics as the mini-IDE above.
    const devPlansDescriptor = devPlansPluginDescriptor()
    if (existsSync(devPlansDescriptor.entryFile)) {
      frontendPluginManager.registerDescriptor(devPlansDescriptor, { builtin: true })
    } else {
      console.warn(
        '[main] AGENT_TEAM_PLUGIN_DEV=1 but Plans dev bundle is missing — run `pnpm run build:plans`'
      )
    }
    // Dev-only: register the locally built Git plugin (dist-plugins/git), same
    // gate and override semantics as the mini-IDE / Plans above.
    const devGitDescriptor = devGitPluginDescriptor()
    if (existsSync(devGitDescriptor.entryFile)) {
      frontendPluginManager.registerDescriptor(devGitDescriptor, { builtin: true })
    } else {
      console.warn(
        '[main] AGENT_TEAM_PLUGIN_DEV=1 but Git dev bundle is missing — run `pnpm run build:git`'
      )
    }
  }
  appMenuHooks = {
    onOpenSettings: () => sendMenuAction('open-settings'),
    onCheckUpdates: () => sendMenuAction('check-updates'),
    onOpenWorkspace: () => sendMenuAction('open-workspace'),
    onOpenRecent: (path: string) => sendMenuAction('open-recent:' + path),
    onNewWindow: () => void createWindow(),
    onOpenPipelineManager: () => requestPipelineManager(),
    onOpenRepo: () => void shell.openExternal('https://github.com/nt-nerdtechnic/Navide'),
    onReportIssue: () => void shell.openExternal('https://github.com/nt-nerdtechnic/Navide/issues'),
    onShowShortcuts: () => sendMenuAction('show-shortcuts'),
    ...(pluginDevEnabled
      ? {
          onOpenNoopPlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            if (host) openNoopPluginView(host)
          },
          onOpenFsProbePlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            if (host) openFsProbePluginView(host)
          },
          onOpenMiniIdePlugin: () => {
            // Dev-only: workspace via AGENT_TEAM_PLUGIN_WORKSPACE, else empty.
            // Opens in the dedicated mini-IDE window (no host needed).
            const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
            openMiniIdePluginView(
              process.env['AGENT_TEAM_PLUGIN_WORKSPACE'] ?? '',
              httpUrl,
              {},
              currentUiTheme()
            )
          },
          onOpenPlansPlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            // Dev-only: workspace via AGENT_TEAM_PLUGIN_WORKSPACE, else empty.
            if (host) {
              const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
              openPlansPluginView(host, process.env['AGENT_TEAM_PLUGIN_WORKSPACE'] ?? '', httpUrl, '', currentUiTheme())
            }
          }
        }
      : {})
  }
  rebuildAppMenu()
  // Fill the native About panel (⌘ About Navide) with Navide branding.
  app.setAboutPanelOptions({
    applicationName: 'Navide',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 NT IT | 恩梯科技股份有限公司',
    credits: 'Navide Team'
  })
  // Register updater IPC before any renderer can request its state. Packaged
  // builds automatically check GitHub Releases after a short delay.
  initUpdater({
    enabled: app.isPackaged && process.platform === 'darwin',
    currentVersion: app.getVersion(),
    // Installing quits the app by design, and the user already agreed to that
    // when they asked for the install. Without this they get a second "Quit?"
    // dialog on top of the one they just answered — and cancelling it leaves
    // the update staged anyway, so the question is not even truthful.
    onInstallStarting: () => { quitConfirmed = true },
    // The install did not take the app down (bad precondition, error, or
    // timeout) — restore the confirmation gate the waiver above disabled.
    onInstallAbandoned: () => { quitConfirmed = false },
  })
  // Detect an unclean previous exit and stash its windows for the restore
  // banner. Always reset the file (start tracking this run) — but only OFFER
  // restore in packaged builds: dev restarts (electron-vite) always look like
  // crashes. AGENT_TEAM_FORCE_RESTORE=1 enables the offer in dev for testing.
  {
    const pending = windowRegistry.readPendingAndReset()
    const restoreEnabled = app.isPackaged || process.env['AGENT_TEAM_FORCE_RESTORE'] === '1'
    pendingRestore = restoreEnabled ? pending : null
    if (pendingRestore) console.log('[main] unclean exit detected;', pendingRestore.length, 'workspace(s) restorable')
  }
  // In dev mode, inject the per-session random token into every renderer →
  // dev-server request so browsers without the token get 403.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    try {
      const devToken = readFileSync(join(tmpdir(), 'agent-team-dev-token'), 'utf-8').trim()
      const origin = new URL(rendererUrl).origin
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${origin}/*`] },
        (details, callback) => {
          callback({ requestHeaders: { ...details.requestHeaders, 'x-electron-token': devToken } })
        }
      )
    } catch {
      // Token file missing — dev server may not be running yet, proceed anyway.
    }
  }

  // Start the backend in PARALLEL with window creation, not before it. Awaiting
  // here meant the first window (and its renderer's first paint) didn't even
  // begin loading until the backend had fully spawned. The renderer shows its
  // boot overlay and connects once the backend is ready (broadcastBackendChanged);
  // it already tolerates a not-yet-ready backend (same path as a restart).
  backendStarting = startBackend(readHealthCheckTimeoutSec(healthTimeoutPath()) * 1000)
    .then((b) => {
      backend = b
      backendLastError = null
      watchBackendCrash(b)
      console.log(`[main] backend ready at ${b.host}:${b.port}`)
      broadcastBackendChanged()
    })
    .catch((err) => {
      console.error('[main] backend failed to start', err)
      backendLastError = String(err)
      broadcastBackendChanged()
    })

  // Open any folders requested at launch: queued open-file events (macOS cold
  // launch from a Quick Action) plus CLI path args on a packaged build. Dev runs
  // skip argv parsing — electron-vite's argv contains paths that aren't workspaces.
  const queued = [...pendingOpenPaths]
  pendingOpenPaths.length = 0
  const cli = app.isPackaged ? workspacePathsFromArgv(process.argv) : []
  const launchPaths = [...new Set([...queued, ...cli])]
  let openedAny = false
  for (const p of launchPaths) {
    if (openWorkspaceFromPath(p)) openedAny = true
  }
  // Clean-exit auto-restore: when nothing was launched explicitly (no Quick
  // Action / CLI path), reopen the windows that were open at the last clean
  // quit — each in its workspace with its saved bounds. Gated by the
  // restoreOnLaunch setting inside cleanExitRestore(); empty after a crash
  // (that path uses the restore banner instead).
  if (!openedAny) {
    const autoRestore = windowRegistry.cleanExitRestore()
    if (autoRestore.length) {
      console.log('[main] clean-exit restore;', autoRestore.length, 'workspace window(s)')
      for (const entry of autoRestore) {
        await createWindow(
          { workspace_path: entry.workspace_path, restore: '1' },
          entry.bounds ? { bounds: entry.bounds } : undefined
        )
      }
      openedAny = true
    }
  }
  if (!openedAny) await createWindow()

  app.on('activate', focusOrCreateMainWindow)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Shutdown budgets. They are deliberately SEPARATE: a single shared deadline
// let a slow spawn eat the stop budget, and stopping must keep its full window
// — it has to outlast backend.stop()'s own 5s SIGTERM grace, or the cap
// SIGKILLs the backend mid-shutdown-sweep and orphans every PTY child.
//
// The spawn budget stays short on purpose. A start that is seconds away is not
// worth making every quit feel slow, and a real start is often far longer than
// any budget worth waiting (the macOS login-shell PATH probe alone has been
// measured at 13s+ before the child even spawns). What makes the short budget
// safe is abandonPendingBackends() below: ending the wait no longer means
// leaving the process behind, so the number only decides how often a
// still-starting backend is killed outright rather than stopped cleanly.
const BACKEND_SPAWN_WAIT_MS = 3000
const BACKEND_STOP_WAIT_MS = 6000

async function teardownBackendAndQuit(): Promise<void> {
  // A user-initiated quit is a clean exit — nothing to restore next launch.
  windowRegistry.markCleanExit()
  // If the backend is still spawning (quit mid-startup), wait for it (capped) so
  // we can stop it rather than orphan the process.
  if (!backend && backendStarting) await withDeadline(backendStarting, BACKEND_SPAWN_WAIT_MS)
  const b = backend
  backend = null
  backendStarting = null
  // Giving up on the WAIT must not mean giving up on the PROCESS. Whatever is
  // still starting — the wait above that ran out, or a restart's start, which
  // `backendStarting` no longer tracks — has a spawned child that Electron
  // exiting would leave running, reparented and still holding the port and the
  // shared app-data state for the next launch to fight over. A finished start
  // is not in that set: its handle owns the process, and `stop()` below is what
  // takes that one down.
  abandonPendingBackends()
  if (b) await withDeadline(b.stop(), BACKEND_STOP_WAIT_MS)
  app.quit()
}

app.on('before-quit', async (e) => {
  // Confirmation gate — shared "confirm before close" setting, driven by renderer.
  if (quitConfirm.enabled && !quitConfirmed) {
    e.preventDefault()
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      type: 'question' as const,
      buttons: [quitConfirm.quitLabel, quitConfirm.cancelLabel],
      defaultId: 0,
      cancelId: 1,
      message: quitConfirm.message,
      detail: quitConfirm.detail,
      checkboxLabel: quitConfirm.dontShowLabel,
      checkboxChecked: false,
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (res.response === 1) return // cancelled — stay open (default already prevented)
    if (res.checkboxChecked) {
      quitConfirm.enabled = false
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('app:quitConfirmDisabled')
      }
    }
    quitConfirmed = true
    void teardownBackendAndQuit() // default prevented → drive quit ourselves
    return
  }
  // Non-dialog path (disabled, or re-entrant after quitConfirmed).
  // A user-initiated quit is a clean exit — nothing to restore next launch.
  // Must run before the early return below (backend may already be gone).
  windowRegistry.markCleanExit()
  if (!backend && !backendStarting) return
  e.preventDefault()
  void teardownBackendAndQuit()
})
