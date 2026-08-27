import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRegistryDoc, WindowRegistry } from './window-registry'

// A window's adopted workspaces were persisted by setAdoptedWorkspaces but
// dropped again by sanitizeEntries on the next launch, so a window running
// three projects always came back running one. This pins the round-trip.

const doc = (windows: unknown[], snapshot: unknown[] = []): string =>
  JSON.stringify({ version: 1, cleanExit: true, windows, snapshot, restoreOnLaunch: true })

describe('window registry – adopted workspaces persistence', () => {
  it('keeps adopted_workspaces through a parse round-trip', () => {
    const parsed = parseRegistryDoc(
      doc([{ workspace_path: '/ws', adopted_workspaces: ['/a', '/b'] }])
    )
    expect(parsed.windows[0].adopted_workspaces).toEqual(['/a', '/b'])
  })

  it('keeps them on the snapshot too — that is what clean-exit restore reads', () => {
    const parsed = parseRegistryDoc(
      doc([], [{ workspace_path: '/ws', adopted_workspaces: ['/a'] }])
    )
    expect(parsed.snapshot[0].adopted_workspaces).toEqual(['/a'])
  })

  it('omits the field for a window that adopted nothing rather than storing []', () => {
    const parsed = parseRegistryDoc(doc([{ workspace_path: '/ws' }, { workspace_path: '/x', adopted_workspaces: [] }]))
    expect('adopted_workspaces' in parsed.windows[0]).toBe(false)
    expect('adopted_workspaces' in parsed.windows[1]).toBe(false)
  })

  it('drops malformed items without losing the entry', () => {
    const parsed = parseRegistryDoc(
      doc([
        { workspace_path: '/a', adopted_workspaces: 'not-a-list' },
        { workspace_path: '/b', adopted_workspaces: ['/ok', '', 7, null] }
      ])
    )
    expect(parsed.windows).toHaveLength(2)
    expect(parsed.windows[0].adopted_workspaces).toBeUndefined()
    expect(parsed.windows[1].adopted_workspaces).toEqual(['/ok'])
  })

  it('keeps bounds, detached_group and adopted_workspaces together', () => {
    const parsed = parseRegistryDoc(
      doc([{
        workspace_path: '/ws',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        detached_group: 'g',
        adopted_workspaces: ['/a']
      }])
    )
    expect(parsed.windows[0]).toEqual({
      workspace_path: '/ws',
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      detached_group: 'g',
      adopted_workspaces: ['/a']
    })
  })

  it('survives a full write → relaunch cycle through the registry class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navide-registry-'))
    const file = join(dir, 'open-windows.json')
    try {
      const reg = new WindowRegistry(file)
      reg.readPendingAndReset()
      reg.setWorkspace(1, '/ws')
      reg.setAdoptedWorkspaces(1, ['/a', '/b'])
      reg.markCleanExit()

      const again = new WindowRegistry(file)
      again.readPendingAndReset()
      expect(again.cleanExitRestore().map((e) => e.adopted_workspaces)).toEqual([['/a', '/b']])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
