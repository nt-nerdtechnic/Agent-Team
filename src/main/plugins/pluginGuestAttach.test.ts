import { describe, expect, it, vi } from 'vitest'
import { createGuestAttachHooks, type MutableWebPreferences } from './pluginGuestAttach'

const APPROVED = 'file:///pkg/index.html?workspace_path=/ws&nv_guest=tok'

function target(overrides: Partial<{ prefs: unknown; attach: boolean }> = {}) {
  return {
    guestAttachPreferences: vi.fn((src: string) =>
      src === APPROVED ? { preload: '/preload/plugin-preload.js', pluginId: 'navide.git' } : null
    ),
    attachGuestContribution: vi.fn(() => overrides.attach ?? true),
  }
}
const guest = (): { close: ReturnType<typeof vi.fn> } => ({ close: vi.fn() })
const event = (): { preventDefault: ReturnType<typeof vi.fn> } => ({ preventDefault: vi.fn() })

describe('createGuestAttachHooks', () => {
  it('forces the Host preload, sandbox and plugin id over whatever the tag asked for', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    // A renderer trying to escalate through the tag.
    const prefs: MutableWebPreferences = {
      preload: '/evil.js',
      nodeIntegration: true,
      sandbox: false,
      contextIsolation: false,
      additionalArguments: ['--plugin-id=navide.plans'],
    }
    hooks.onWillAttach(e, prefs, { src: APPROVED })

    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(prefs.preload).toBe('/preload/plugin-preload.js')
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.webSecurity).toBe(true)
    // Replaced, not appended: the spoofed id is gone.
    expect(prefs.additionalArguments).toEqual(['--plugin-id=navide.git'])
  })

  it('vetoes a src the Host never handed out', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    const prefs: MutableWebPreferences = {}
    hooks.onWillAttach(e, prefs, { src: 'file:///elsewhere/index.html' })
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(prefs.preload).toBeUndefined()
  })

  it('vetoes an attach with no src at all', () => {
    const hooks = createGuestAttachHooks(target())
    const e = event()
    hooks.onWillAttach(e, {}, {})
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('binds the guest that follows an approved will-attach', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).toHaveBeenCalledWith(APPROVED, g)
    expect(g.close).not.toHaveBeenCalled()
  })

  it('closes a guest that arrives without an approval', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).not.toHaveBeenCalled()
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('closes a guest the manager refuses to bind', () => {
    const manager = target({ attach: false })
    const hooks = createGuestAttachHooks(manager)
    const g = guest()
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(g)
    expect(g.close).toHaveBeenCalledTimes(1)
  })

  it('consumes the approval once, so a second guest cannot ride it', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onDidAttach(guest())
    const second = guest()
    hooks.onDidAttach(second)
    expect(manager.attachGuestContribution).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
  })

  it('a vetoed will-attach clears any earlier approval', () => {
    const manager = target()
    const hooks = createGuestAttachHooks(manager)
    hooks.onWillAttach(event(), {}, { src: APPROVED })
    hooks.onWillAttach(event(), {}, { src: 'file:///elsewhere/index.html' })
    const g = guest()
    hooks.onDidAttach(g)
    expect(manager.attachGuestContribution).not.toHaveBeenCalled()
    expect(g.close).toHaveBeenCalledTimes(1)
  })
})
