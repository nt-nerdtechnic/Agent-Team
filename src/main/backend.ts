import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { registerPendingBackend, releasePendingBackend } from './backend-pending'
import { killProcessTree } from './process-tree'
import {
  writeBackendPluginActivationCatalog,
  type BackendPluginActivationCatalogFile,
} from './plugins/pluginBackendActivationCatalog'

/**
 * The key that tells a person's own window apart from an agent driving the same
 * socket through MCP.
 *
 * Regenerated per backend, held only here and in the backend's memory: never a
 * file, never an environment variable. Those are the two places a CLI agent on
 * this machine reads without effort — `cat` and `ps -E` — and the whole point of
 * this key is to be out of reach of code that can already open the local
 * socket. See backend/agent_team_backend/confirm_token.py for what that buys
 * and, just as importantly, what it does not.
 */
let confirmKey = ''

/** How long a minted confirmation stays usable. Must match TOKEN_TTL_S. */
const CONFIRM_TTL_MS = 30_000

export function handConfirmKey(proc: ChildProcess): void {
  confirmKey = randomBytes(32).toString('hex')
  // One line, then the pipe closes: the backend reads exactly this much, and a
  // stdin left open would be a channel neither side has a use for.
  proc.stdin?.write(`${confirmKey}\n`)
  proc.stdin?.end()
}

/**
 * Mint a one-time confirmation for one trust-changing action.
 *
 * Bound to the action and to the device it names, so a token minted to approve
 * one machine cannot be spent to block another. Returns null before a backend
 * has been started, which is the honest answer: there is nothing to confirm to.
 */
export function mintTrustConfirmation(
  action: string,
  deviceId: string,
): { nonce: string; expires: string; mac: string } | null {
  if (!confirmKey) return null
  const nonce = randomUUID()
  const expires = String((Date.now() + CONFIRM_TTL_MS) / 1000)
  const payload = ['navide/trust-confirm/v1', nonce, expires, action, deviceId].join('\u0000')
  return { nonce, expires, mac: createHmac('sha256', confirmKey).update(payload).digest('hex') }
}


export interface BackendHandle {
  host: string
  port: number
  shell: string
  /** Where the backend keeps its state — and its ws token. Recorded here
   *  rather than recomputed by callers because dev and packaged resolve it
   *  differently, and two copies of that rule would drift. */
  dataDir: string
  proc: ChildProcess
  stop: () => Promise<void>
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        reject(new Error('failed to allocate port'))
      }
    })
  })
}

/** Ask the user's login shell for its full PATH (captures nvm/fnm/volta etc.).
 *  Returns { shell, path }. Path is null if the shell doesn't respond. */
function getLoginShellEnv(): Promise<{ shell: string; path: string | null }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? '/bin/zsh'
    // zsh reads ~/.zshrc (where installers add PATH, e.g. Claude Code's
    // ~/.local/bin) only in INTERACTIVE mode — a plain login shell (-l)
    // misses it. Marker-wrap the output so shell-config chatter on stdout
    // can't pollute the parsed PATH.
    const flags = shell.endsWith('zsh') ? ['-il', '-c'] : ['-l', '-c']
    const args = [...flags, 'printf "__NAVIDE_PATH__%s\\n" "$PATH"']
    // Generous timeout: a heavy ~/.zshrc (nvm etc.) on a busy machine has been
    // measured at 13s+; timing out silently drops every zshrc PATH entry, which
    // surfaces later as "executable not found (claude)" on CLI spawn.
    execFile(shell, args, { timeout: 15_000 }, (err, stdout) => {
      if (err) { resolve({ shell, path: null }); return }
      const marked = stdout.split('\n').filter((l) => l.startsWith('__NAVIDE_PATH__'))
      const p = (marked.at(-1) ?? '').slice('__NAVIDE_PATH__'.length).trim()
      resolve({ shell, path: p.length > 0 ? p : null })
    })
  })
}

// PATH as resolved for spawned children (login-shell probe merged with the
// process PATH). Cached at backend start so other main-process spawners —
// external editors, see editors.ts — don't pay the probe again.
let resolvedUserPath: string | null = null

/** The PATH to give processes main spawns. Falls back to the process PATH
 *  when the backend has not started yet (or the probe failed). */
export function getResolvedUserPath(): string {
  return resolvedUserPath ?? process.env.PATH ?? ''
}

/** Mirror a backend log line to our own stdio, best-effort.
 *
 *  The stream we inherited can go away while the app lives on — closing the
 *  terminal that launched a dev run leaves a dead pipe behind — and a write to
 *  it fails asynchronously with EIO. Swallow that: losing a log line is not a
 *  reason to take the app down with an uncaught exception. */
export function forwardBackendLog(stream: NodeJS.WriteStream, chunk: Buffer): void {
  try {
    stream.write(`[backend] ${chunk.toString()}`, () => {
      /* async write failure — the stream is gone, nothing to do */
    })
  } catch {
    /* synchronous failure (already-destroyed stream) — same story */
  }
}

let stdioGuarded = false

/** Keep a dead stdio pipe from killing the app.
 *
 *  A broken pipe surfaces as an 'error' event on the stream itself, which
 *  Node turns into an uncaught exception when nothing listens. The write
 *  callback in forwardBackendLog does NOT cover this: the event fires on its
 *  own, independently of any one write. Observed as an EIO crash dialog after
 *  the terminal that launched a dev run went away. */
export function guardStdioStreams(): void {
  if (stdioGuarded) return
  stdioGuarded = true
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
}

export function bindBackendPluginActivationCatalog(
  base: NodeJS.ProcessEnv,
  catalog: BackendPluginActivationCatalogFile
): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.AGENT_TEAM_PLUGINS_DIR
  env.AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG = catalog.path
  env.AGENT_TEAM_PLUGIN_ACTIVATION_CATALOG_SHA256 = catalog.sha256
  return env
}

export async function startBackend(
  healthCheckTimeoutMs = 45_000,
  approvedPluginCatalog?: BackendPluginActivationCatalogFile
): Promise<BackendHandle> {
  guardStdioStreams()
  const port = await findFreePort()
  const host = '127.0.0.1'

  // Electron strips PATH on macOS when launched from Finder/Dock.
  // Use a login shell to recover the full user PATH (nvm, fnm, volta, brew…).
  const catalog =
    approvedPluginCatalog ??
    writeBackendPluginActivationCatalog(
      join(app.getPath('userData'), 'plugins', '.navide-backend-activation.json'),
      { schemaVersion: 1, packages: [] }
    )
  const env = bindBackendPluginActivationCatalog(process.env, catalog)
  let userShell = process.env.SHELL ?? '/bin/zsh'
  if (process.platform === 'darwin') {
    const { shell, path: loginPath } = await getLoginShellEnv()
    userShell = shell
    if (loginPath) {
      // Merge: login shell PATH first so user-installed tools take precedence,
      // then any paths the current process already has (rare but harmless).
      const existing = (env.PATH ?? '').split(':').filter(Boolean)
      const merged = [...new Set([...loginPath.split(':'), ...existing])]
      env.PATH = merged.join(':')
    } else {
      // Fallback: add common macOS tool locations the system PATH omits.
      // ~/.local/bin is where Claude Code's official installer puts `claude`.
      const common = [
        join(homedir(), '.local/bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin'
      ]
      const existing = (env.PATH ?? '').split(':').filter(Boolean)
      env.PATH = [...new Set([...common, ...existing])].join(':')
    }
  }
  resolvedUserPath = env.PATH ?? null

  // External Manifest v2 packages are never discovered by directory scan.
  // Python consumes only the exact-byte Host-approved catalog bound above;
  // bundled v1 plugins remain an explicit backend-owned compatibility path.

  let proc: ChildProcess
  if (app.isPackaged) {
    const binaryPath = join(process.resourcesPath, 'bin', 'agent_team_backend')
    proc = spawn(binaryPath, ['--port', String(port), '--log-level', 'info'], {
      env,
      // stdin is open only to hand over the trust-confirmation key, and is
      // closed immediately after. See handConfirmKey below.
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } else {
    // Dev runs alongside the packaged app, which owns the default state dir.
    // Point this backend at a separate dir so the two don't fight over the
    // shared SQLite / session files / backend-port (honour a pre-set value).
    if (!env.AGENT_TEAM_DATA_DIR) {
      env.AGENT_TEAM_DATA_DIR = join(app.getPath('appData'), 'Agent-Team-dev')
    }
    const projectRoot = app.getAppPath()
    proc = spawn(
      'uv',
      ['--project', 'backend', 'run', 'python', '-m', 'agent_team_backend', '--port', String(port), '--log-level', 'debug'],
      {
        cwd: projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
  }

  // From here until the start finishes, shutdown owns this child: nothing else
  // holds a reference to it yet, and quitting mid-start would otherwise leave it
  // running after the app is gone.
  if (!registerPendingBackend(proc)) {
    throw new Error('backend start abandoned: the app is quitting')
  }

  handConfirmKey(proc)

  proc.stdout?.on('data', (chunk: Buffer) => forwardBackendLog(process.stdout, chunk))
  proc.stderr?.on('data', (chunk: Buffer) => forwardBackendLog(process.stderr, chunk))

  const handle: BackendHandle = {
    host,
    port,
    shell: userShell,
    dataDir: env.AGENT_TEAM_DATA_DIR ?? join(app.getPath('appData'), 'Agent-Team'),
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        // Always resolve within the grace period. If the process already exited
        // before this listener attached (e.g. the backend crashed, which is why
        // the UI was stuck "connecting…"), 'exit' never fires again — so the
        // timeout below must resolve unconditionally, or app quit hangs forever.
        // 5s: the backend's shutdown sweep (kill_all — one ps snapshot + 1s
        // grace + watcher/MCP teardown) must finish, or every PTY child is
        // orphaned; 2s cut it off on many-pane workspaces.
        // Past the grace period the sweep did not happen, so this has to reach
        // the whole tree by name: SIGKILL is not forwarded by the bootloader,
        // and killing the handle alone would leave the real backend holding the
        // port with its PTY children reparented to init.
        const timer = setTimeout(() => {
          if (proc.exitCode === null) killProcessTree(proc.pid, 'SIGKILL')
          resolve()
        }, 5000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
  }

  try {
    // Packaged (unsigned/non-notarized) builds can be held up for many seconds
    // by macOS Gatekeeper scanning the bundled binary on first launch after
    // download — 15s was too tight and surfaced as "backend failed to start"
    // even though the process would have come up given more time. Now
    // configurable via Settings (default 45s) — see src/main/health-timeout.ts.
    await waitForHealth(host, port, healthCheckTimeoutMs)
  } catch (err) {
    // Health never came up — kill the orphaned child so it can't linger and
    // contend over the shared ~/.agent-team state on the next start attempt.
    // The process that holds that state is the bootloader's child, not the
    // handle, so this has to take the tree down rather than just the handle.
    killProcessTree(proc.pid, 'SIGKILL')
    throw err
  } finally {
    // Settled either way: the handle below owns the process now, or it is dead.
    // Shutdown has nothing left to abandon here.
    releasePendingBackend(proc)
  }
  return handle
}


/**
 * The credential the backend requires on /ws, or '' if it is not there yet.
 *
 * Read from disk on every call rather than cached: the backend mints a new one
 * each run, and an auto-restart replaces the file under a main process that
 * never stopped. A cached token would survive that and every window would be
 * refused with no obvious cause.
 */
export function readWsToken(handle: BackendHandle): string {
  try {
    return readFileSync(join(handle.dataDir, 'backend-ws-token'), 'utf8').trim()
  } catch {
    // Absent means the backend has not written it yet, or is an older build.
    // Callers pass '' through and the backend answers for itself.
    return ''
  }
}

export async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/health`)
      if (res.ok) return
      lastErr = new Error(`/health responded ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`)
}
