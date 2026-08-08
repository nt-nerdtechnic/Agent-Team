/**
 * Signalling a spawned process and everything it spawned.
 *
 * The backend we spawn is not the backend. In a packaged build it is a
 * PyInstaller onefile bootloader that unpacks itself and forks the real Python
 * process; in dev it is `uv`, which forks python the same way. Under that real
 * process sit the PTY children, each in its own session (see terminals.py).
 *
 * SIGTERM is fine to send to the handle alone — the bootloader forwards it, and
 * the backend's shutdown sweep takes the PTY tree down. SIGKILL is not: it
 * cannot be caught, so nothing forwards it. Killing the handle leaves the real
 * backend running, still holding the port and the shared app-data state, with
 * its PTY children reparented to init. Every SIGKILL therefore has to name each
 * process itself, which is what this module is for.
 */

import { execFileSync } from 'node:child_process'

/**
 * `pid` and all of its descendants, deepest first. Parses the two-column
 * `pid ppid` snapshot `ps` produces; unparsable lines are ignored.
 */
export function descendantsFirst(pid: number, psSnapshot: string): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const line of psSnapshot.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const child = Number(m[1])
    const parent = Number(m[2])
    if (child === parent) continue // pid 0 parents itself on some systems
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(child)
    else childrenOf.set(parent, [child])
  }

  const ordered: number[] = []
  const visited = new Set<number>()
  const walk = (current: number): void => {
    if (visited.has(current)) return // a corrupt snapshot must not loop forever
    visited.add(current)
    for (const child of childrenOf.get(current) ?? []) walk(child)
    ordered.push(current) // post-order: children before the parent that forked them
  }
  walk(pid)
  return ordered
}

/**
 * Send `signal` to `pid` and every process descended from it, children first.
 * Best-effort throughout: a process that died between the snapshot and the
 * signal is the normal case, not an error.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (typeof pid !== 'number' || pid <= 1) return

  let targets = [pid]
  try {
    const snapshot = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000
    })
    targets = descendantsFirst(pid, snapshot)
  } catch {
    /* no snapshot (no ps, timed out) — still take down what we can name */
  }

  for (const target of targets) {
    if (target <= 1) continue
    try {
      process.kill(target, signal)
    } catch {
      /* already gone */
    }
  }
}
