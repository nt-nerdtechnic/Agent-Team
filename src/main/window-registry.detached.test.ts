import { describe, it, expect } from 'vitest'
import { parseRegistryDoc, type WindowEntry } from './window-registry'

// A detached run group used to live only in main's memory, so every relaunch
// folded it back into the main window — the user's split disappeared with no
// trace. The registry now carries which group a window was detached for.

const doc = (windows: unknown[]): string =>
  JSON.stringify({ version: 1, cleanExit: true, windows, snapshot: [], restoreOnLaunch: true })

describe('window registry – detached group persistence', () => {
  it('keeps detached_group through a parse round-trip', () => {
    const parsed = parseRegistryDoc(
      doc([{ workspace_path: '/ws', detached_group: 'g-1' }])
    )
    expect(parsed.windows[0].detached_group).toBe('g-1')
  })

  it('omits the field for an ordinary window rather than storing empty', () => {
    const parsed = parseRegistryDoc(doc([{ workspace_path: '/ws' }]))
    expect('detached_group' in parsed.windows[0]).toBe(false)
  })

  it('drops a non-string or empty detached_group', () => {
    const parsed = parseRegistryDoc(
      doc([
        { workspace_path: '/a', detached_group: '' },
        { workspace_path: '/b', detached_group: 42 },
        { workspace_path: '/c', detached_group: { id: 'x' } }
      ])
    )
    expect(parsed.windows.map((w) => w.detached_group)).toEqual([undefined, undefined, undefined])
  })

  it('reads a doc written before the field existed', () => {
    // Forward compatibility matters here: the file is shared with older builds
    // during an upgrade/downgrade cycle.
    const parsed = parseRegistryDoc(doc([{ workspace_path: '/ws', bounds: { x: 0, y: 0, width: 10, height: 10 } }]))
    expect(parsed.windows[0].workspace_path).toBe('/ws')
    expect(parsed.windows[0].bounds?.width).toBe(10)
    expect(parsed.windows[0].detached_group).toBeUndefined()
  })

  it('keeps bounds and detached_group together', () => {
    const parsed = parseRegistryDoc(
      doc([{ workspace_path: '/ws', bounds: { x: 1, y: 2, width: 3, height: 4 }, detached_group: 'g' }])
    )
    const entry = parsed.windows[0] as WindowEntry
    expect(entry.detached_group).toBe('g')
    expect(entry.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('still rejects entries with no workspace path', () => {
    const parsed = parseRegistryDoc(doc([{ detached_group: 'g' }, { workspace_path: '' }]))
    expect(parsed.windows).toHaveLength(0)
  })
})
