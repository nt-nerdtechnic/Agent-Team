import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { registerPendingBackend, releasePendingBackend } from './backend-pending'

export interface BackendHandle {
  host: string
  port: number
  shell: string
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

export async function startBackend(healthCheckTimeoutMs = 45_000): Promise<BackendHandle> {
  const port = await findFreePort()
  const host = '127.0.0.1'

  // Electron strips PATH on macOS when launched from Finder/Dock.
  // Use a login shell to recover the full user PATH (nvm, fnm, volta, brew…).
  const env = { ...process.env }
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

  // Backend plugin discovery scans the same directory the frontend installs
  // plugins into (see pluginsRoot in index.ts; honour a pre-set value).
  if (!env.AGENT_TEAM_PLUGINS_DIR) {
    env.AGENT_TEAM_PLUGINS_DIR = join(app.getPath('userData'), 'plugins')
  }

  let proc: ChildProcess
  if (app.isPackaged) {
    const binaryPath = join(process.resourcesPath, 'bin', 'agent_team_backend')
    proc = spawn(binaryPath, ['--port', String(port), '--log-level', 'info'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
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
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  }

  // From here until the start finishes, shutdown owns this child: nothing else
  // holds a reference to it yet, and quitting mid-start would otherwise leave it
  // running after the app is gone.
  if (!registerPendingBackend(proc)) {
    throw new Error('backend start abandoned: the app is quitting')
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[backend] ${chunk.toString()}`)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[backend] ${chunk.toString()}`)
  })

  const handle: BackendHandle = {
    host,
    port,
    shell: userShell,
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
        const timer = setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
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
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
    throw err
  } finally {
    // Settled either way: the handle below owns the process now, or it is dead.
    // Shutdown has nothing left to abandon here.
    releasePendingBackend(proc)
  }
  return handle
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
