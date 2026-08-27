import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RESTORE_ATTEMPTS, parseRegistryDoc, pendingFromDoc, WindowRegistry } from './window-registry'

describe('parseRegistryDoc', () => {
  it('returns a clean empty doc for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]', '{"windows": "nope"}']) {
      expect(parseRegistryDoc(text)).toEqual({
        version: 1, cleanExit: true, windows: [], snapshot: [], restoreOnLaunch: true, restoreFailures: {},
      })
    }
  })

  it('parses a valid doc and drops malformed window entries', () => {
    const doc = parseRegistryDoc(JSON.stringify({
      version: 1,
      cleanExit: false,
      windows: [
        { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { workspace_path: '' }, // empty → dropped
        { nope: true }, // malformed → dropped
        { workspace_path: '/b' },
      ],
    }))
    expect(doc.cleanExit).toBe(false)
    expect(doc.windows).toEqual([
      { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { workspace_path: '/b' },
    ])
  })
})

describe('pendingFromDoc', () => {
  const base = { snapshot: [], restoreOnLaunch: true, restoreFailures: {} }

  it('offers nothing after a clean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: true, windows: [{ workspace_path: '/a' }], ...base })).toBeNull()
  })

  it('offers nothing when no workspaces were open', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [], ...base })).toBeNull()
  })

  it('offers the windows after an unclean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [{ workspace_path: '/a' }], ...base }))
      .toEqual([{ workspace_path: '/a' }])
  })
})

describe('WindowRegistry', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): unknown => JSON.parse(readFileSync(file, 'utf-8'))

  it('simulated crash: next launch sees the previous windows as pending', () => {
    const run1 = new WindowRegistry(file)
    expect(run1.readPendingAndReset()).toBeNull() // first run ever
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
    // and the offer is one-shot: a third run (also unclean) has no windows
    const run3 = new WindowRegistry(file)
    expect(run3.readPendingAndReset()).toBeNull()
  })

  it('clean exit: next launch has nothing to restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull()
  })

  it('clean exit snapshots open windows for auto-restore, surviving the remove() sweep', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    // Quit sequence: each window closes → remove(). This used to wipe the
    // snapshot to [] (the bug); it must survive.
    run1.remove(1)
    run1.remove(2)

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull() // clean exit → no crash banner
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
  })

  it('restoreOnLaunch=false suppresses clean-exit auto-restore and persists across reset', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setRestoreOnLaunch(false)
    run1.markCleanExit()
    run1.remove(1)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([]) // setting off → nothing
    expect(run2.getRestoreOnLaunch()).toBe(false) // setting preserved across the reset
  })

  it('a crash yields a restore banner but no clean-exit auto-restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([{ workspace_path: '/ws/alpha' }]) // banner
    expect(run2.cleanExitRestore()).toEqual([]) // not clean → no auto-restore
  })

  it('closing a window or returning to Welcome removes its entry', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setWorkspace(2, '/ws/beta')
    reg.remove(1)
    reg.setWorkspace(2, '') // back to Welcome
    expect(readDoc()).toMatchObject({ cleanExit: false, windows: [] })
  })

  it('keeps bounds attached to the window entry across workspace updates', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setBounds(1, { x: 5, y: 6, width: 700, height: 500 })
    // bounds writes are debounced — force a flush via an immediate-persist op
    reg.setWorkspace(1, '/ws/alpha')
    expect(readDoc()).toMatchObject({
      windows: [{ workspace_path: '/ws/alpha', bounds: { x: 5, y: 6, width: 700, height: 500 } }],
    })
  })

  it('ignores bounds for untracked (Welcome) windows', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setBounds(9, { x: 0, y: 0, width: 100, height: 100 })
    reg.markCleanExit() // flush
    expect(readDoc()).toMatchObject({ windows: [] })
  })

  it('survives a corrupt file on disk', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    const reg = new WindowRegistry(file)
    expect(reg.readPendingAndReset()).toBeNull()
  })
})

describe('restore failure breaker', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): { restoreFailures?: Record<string, number> } =>
    JSON.parse(readFileSync(file, 'utf-8'))

  /** One launch that restores `paths` and then dies without ever going stable —
   *  the wedged-backend case the breaker exists for. */
  const wedgedLaunch = (paths: string[]): WindowRegistry => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.beginRestore(paths.map((p) => ({ workspace_path: p })))
    return reg
  }

  it('charges and persists the attempt BEFORE the window is restored', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }])
    expect(plan.restore).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.skipped).toEqual([])
    // Already on disk: a hang or kill -9 from here on still leaves the charge.
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1 })
  })

  it('accumulates across launches and skips at the threshold, restoring the rest', () => {
    for (let i = 1; i <= MAX_RESTORE_ATTEMPTS; i++) {
      wedgedLaunch(['/ws/drive', '/ws/local'])
      expect(readDoc().restoreFailures).toEqual({ '/ws/drive': i, '/ws/local': i })
    }
    // Next launch: /ws/drive is out of budget, a never-seen workspace is not.
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }, { workspace_path: '/ws/fresh' }])
    expect(plan.skipped).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.restore).toEqual([{ workspace_path: '/ws/fresh' }])
    // A skipped workspace is not charged again — it is already at the cap.
    expect(readDoc().restoreFailures).toEqual({
      '/ws/drive': MAX_RESTORE_ATTEMPTS, '/ws/local': MAX_RESTORE_ATTEMPTS, '/ws/fresh': 1,
    })
  })

  it('a stable backend clears the ledger, giving every workspace its budget back', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/drive'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.clearRestoreFailures() // ← what backend-autorestart's onStable calls
    expect(readDoc().restoreFailures).toEqual({})
    expect(reg.beginRestore([{ workspace_path: '/ws/drive' }]).restore)
      .toEqual([{ workspace_path: '/ws/drive' }])
  })

  it('an explicit user restore overrides the skip and resets that tally', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/drive', '/ws/other'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }], { userInitiated: true })
    expect(plan.restore).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.skipped).toEqual([])
    // Consent resets the workspace it named to a fresh budget (this attempt is
    // still charged), and touches nothing else.
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1, '/ws/other': MAX_RESTORE_ATTEMPTS })
  })

  it('carries the ledger across the startup reset', () => {
    wedgedLaunch(['/ws/drive'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset() // rewrites the file for this run
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1 })
    expect(reg.restoreFailureCounts()).toEqual({ '/ws/drive': 1 })
  })

  it('a doc written before the breaker existed loads with an empty ledger', () => {
    writeFileSync(file, JSON.stringify({
      version: 1, cleanExit: true, windows: [], snapshot: [{ workspace_path: '/ws/alpha' }],
      restoreOnLaunch: true,
    }), 'utf-8')
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    expect(reg.restoreFailureCounts()).toEqual({})
    // ...and the old snapshot still restores normally.
    expect(reg.beginRestore(reg.cleanExitRestore()).restore).toEqual([{ workspace_path: '/ws/alpha' }])
  })

  it('ignores a corrupt ledger rather than failing the whole doc', () => {
    writeFileSync(file, JSON.stringify({
      version: 1, cleanExit: true, windows: [], snapshot: [], restoreOnLaunch: true,
      restoreFailures: { '/ws/a': 2, '/ws/bad': 'nope', '/ws/zero': 0, '': 5, '/ws/frac': 1.7 },
    }), 'utf-8')
    expect(parseRegistryDoc(readFileSync(file, 'utf-8')).restoreFailures)
      .toEqual({ '/ws/a': 2, '/ws/frac': 1 })
  })

  it('skips every workspace when they have all burned their budget', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/a', '/ws/b'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/a' }, { workspace_path: '/ws/b' }])
    // Nothing to open. index.ts only sets openedAny inside the plan.restore
    // loop, so an empty list falls through to the plain createWindow() that
    // opens the workspace-less Welcome window — the app is never left blind.
    expect(plan.restore).toEqual([])
    expect(plan.skipped).toHaveLength(2)
  })
})
