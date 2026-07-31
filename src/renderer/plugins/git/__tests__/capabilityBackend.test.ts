// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TYPE_TO_CAP, resolveCapability, useBackend } from '../capabilityBackend'
import type { useBackend as realUseBackend } from '../../../src/composables/useBackend'

// ── Compile-time interface parity ────────────────────────────────────────────
// The plugin build aliases the real `useBackend` to the shim; if their public
// surfaces drift, these assignments stop type-checking (caught by vue-tsc).
type Real = ReturnType<typeof realUseBackend>
type Shim = ReturnType<typeof useBackend>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shimAssignableToReal: Real = undefined as unknown as Shim
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _realAssignableToShim: Shim = undefined as unknown as Real

describe('TYPE_TO_CAP git surface', () => {
  it('maps the askpass answer calls the credential modal depends on', () => {
    expect(resolveCapability('git.credential_submit')).toEqual({
      ns: 'git',
      method: 'credential_submit',
    })
    expect(resolveCapability('git.credential_cancel')).toEqual({
      ns: 'git',
      method: 'credential_cancel',
    })
  })

  it('maps the diff calls the shared DiffPane sends', () => {
    expect(resolveCapability('git.diff_file')).toEqual({ ns: 'git', method: 'diff_file' })
    expect(resolveCapability('git.apply_patch')).toEqual({ ns: 'git', method: 'apply_patch' })
    expect(resolveCapability('fs.read_image')).toEqual({ ns: 'fs', method: 'read_image' })
  })

  it('maps only into the granted capability namespaces', () => {
    const allowed = new Set(['git', 'fs', 'ui'])
    for (const ref of Object.values(TYPE_TO_CAP)) {
      expect(allowed.has(ref.ns)).toBe(true)
    }
  })
})

describe('useBackend shim status', () => {
  type NavListener = (data: unknown) => void
  const listeners = new Map<string, Set<NavListener>>()
  const callCapability = vi.fn()

  function fire(type: string, data: unknown): void {
    listeners.get(type)?.forEach((cb) => cb(data))
  }

  beforeEach(() => {
    listeners.clear()
    callCapability.mockReset()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      on: (type: string, cb: NavListener): (() => void) => {
        let set = listeners.get(type)
        if (!set) {
          set = new Set()
          listeners.set(type, set)
        }
        set.add(cb)
        return () => set!.delete(cb)
      },
      ready: vi.fn(),
    }
  })

  it('starts optimistic and tracks nav.backend_status transitions', () => {
    const backend = useBackend()
    expect(backend.status.value).toBe('connected')
    fire('nav.backend_status', { status: 'disconnected' })
    expect(backend.status.value).toBe('disconnected')
    fire('nav.backend_status', { status: 'connecting' })
    expect(backend.status.value).toBe('connecting')
    fire('nav.backend_status', { status: 'connected' })
    expect(backend.status.value).toBe('connected')
    fire('nav.backend_status', { status: 'error' })
    expect(backend.status.value).toBe('error')
  })

  it('ignores malformed status payloads', () => {
    const backend = useBackend()
    fire('nav.backend_status', { status: 'disconnected' })
    fire('nav.backend_status', null)
    fire('nav.backend_status', {})
    fire('nav.backend_status', { status: 'bogus' })
    expect(backend.status.value).toBe('disconnected')
  })

  it('forwards on() subscriptions (credential events) to the nav bridge', () => {
    const backend = useBackend()
    const cb = vi.fn()
    backend.on('git.credential_request', cb)
    fire('git.credential_request', { request_id: 'r1' })
    expect(cb).toHaveBeenCalledWith({ request_id: 'r1' })
  })
})
