import { describe, expect, it } from 'vitest'
import { PlanWindowRegistry } from './plan-windows'

class FakeWindow {
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
}

describe('PlanWindowRegistry', () => {
  it('returns null for an unknown workspace', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    expect(reg.get('/ws/a')).toBeNull()
  })

  it('returns the live window registered for a workspace', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    const win = new FakeWindow()
    reg.set('/ws/a', win)
    expect(reg.get('/ws/a')).toBe(win)
    expect(reg.hasWindow(win)).toBe(true)
    expect(reg.workspaceForWindow(win)).toBe('/ws/a')
  })

  it('keeps windows per workspace independent', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    const a = new FakeWindow()
    const b = new FakeWindow()
    reg.set('/ws/a', a)
    reg.set('/ws/b', b)
    expect(reg.get('/ws/a')).toBe(a)
    expect(reg.get('/ws/b')).toBe(b)
  })

  it('prunes destroyed windows on lookup', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    const win = new FakeWindow()
    reg.set('/ws/a', win)
    win.destroyed = true
    expect(reg.get('/ws/a')).toBeNull()
    // Pruned, not just filtered: a revived flag must not resurrect the entry.
    win.destroyed = false
    expect(reg.get('/ws/a')).toBeNull()
  })

  it('does not treat a destroyed window as a trusted registered window', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    const win = new FakeWindow()
    reg.set('/ws/a', win)
    win.destroyed = true
    expect(reg.hasWindow(win)).toBe(false)
    expect(reg.workspaceForWindow(win)).toBeNull()
    win.destroyed = false
    expect(reg.hasWindow(win)).toBe(false)
    expect(reg.workspaceForWindow(win)).toBeNull()
  })

  it('remove() evicts only the matching window', () => {
    const reg = new PlanWindowRegistry<FakeWindow>()
    const stale = new FakeWindow()
    const fresh = new FakeWindow()
    reg.set('/ws/a', stale)
    reg.set('/ws/a', fresh) // replaced before stale's close event fired
    reg.remove('/ws/a', stale)
    expect(reg.get('/ws/a')).toBe(fresh)
    reg.remove('/ws/a', fresh)
    expect(reg.get('/ws/a')).toBeNull()
  })
})
