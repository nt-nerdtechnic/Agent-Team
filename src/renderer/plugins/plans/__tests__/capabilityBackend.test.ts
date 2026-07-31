// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// Every WS `type` the Plans UI actually sends (collected from PlanWindowApp +
// PlansPane + PlanReviewToolbar + planStore/planShare + PlanFileView/
// PlanMarkdownBody/PlanDocPreview + FilePreviewPane's bundled previews +
// lib/settings). The map MUST resolve all of them.
const PLANS_SENT_TYPES = [
  // fs
  'fs.read_file', 'fs.write_file', 'fs.list_dir', 'fs.delete', 'fs.rename',
  'fs.list_archive', 'fs.convert_office',
  // ui / settings (theme sync via lib/settings.ts)
  'ui.settings.get', 'ui.settings.set',
] as const

// Vitest runs with cwd at the repo root; vite-node serves modules under a
// non-file scheme, so `import.meta.url` cannot locate the manifest.
const MANIFEST_PATH = join(process.cwd(), 'src/renderer/plugins/plans/plugin.json')

describe('plugin.json manifest', () => {
  it('is valid JSON declaring the navide.plans plugin shape', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8')
    const manifest = JSON.parse(raw) as Record<string, unknown>
    expect(manifest.id).toBe('navide.plans')
    expect(manifest.name).toBe('Plans')
    expect(manifest.publisher).toBe('navide')
    expect(manifest.entry).toBe('index.html')
    expect(manifest.requires).toEqual(['fs', 'ui', 'plans'])
    expect(manifest.activationEvents).toEqual(['onStartup'])
  })

  it('grants exactly the namespaces the capability map uses (plus the plans event ns)', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8')
    const manifest = JSON.parse(raw) as { requires: string[] }
    const mappedNs = new Set(Object.values(TYPE_TO_CAP).map((ref) => ref.ns))
    for (const ns of mappedNs) expect(manifest.requires).toContain(ns)
    // `plans` maps no request types — it only gates the `plans.changed` event.
    expect(manifest.requires).toContain('plans')
    expect(mappedNs.has('plans')).toBe(false)
  })
})

describe('TYPE_TO_CAP coverage', () => {
  it('resolves every WS type the Plans UI sends to a capability', () => {
    const unmapped = PLANS_SENT_TYPES.filter((t) => resolveCapability(t) === null)
    expect(unmapped).toEqual([])
  })

  it('maps only into the granted capability namespaces', () => {
    const allowed = new Set(['fs', 'ui'])
    for (const ref of Object.values(TYPE_TO_CAP)) {
      expect(allowed.has(ref.ns)).toBe(true)
    }
  })

  it('splits the uniform fs namespace on the dotted method', () => {
    expect(resolveCapability('fs.read_file')).toEqual({ ns: 'fs', method: 'read_file' })
    expect(resolveCapability('fs.list_dir')).toEqual({ ns: 'fs', method: 'list_dir' })
  })

  it('remaps the non-uniform settings family onto the ui namespace', () => {
    expect(resolveCapability('ui.settings.get')).toEqual({ ns: 'ui', method: 'settings_get' })
    expect(resolveCapability('ui.settings.set')).toEqual({ ns: 'ui', method: 'settings_set' })
  })

  it('returns null for types outside the Plans surface', () => {
    expect(resolveCapability('git.status')).toBeNull()
    expect(resolveCapability('shell.run')).toBeNull()
    expect(resolveCapability('totally.unknown')).toBeNull()
    expect(resolveCapability('')).toBeNull()
  })
})

describe('useBackend shim send()', () => {
  const callCapability = vi.fn()
  beforeEach(() => {
    callCapability.mockReset()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      on: vi.fn(() => () => {}),
      ready: vi.fn(),
    }
  })

  it('routes a mapped type through nav.callCapability and adapts the response', async () => {
    callCapability.mockResolvedValue({ reqId: 'r1', ok: true, result: { content: 'hi' } })
    const backend = useBackend()
    const resp = await backend.send('fs.read_file', { workspace_path: '/w', rel_path: 'a.html' })
    expect(callCapability).toHaveBeenCalledWith('fs', 'read_file', {
      workspace_path: '/w',
      rel_path: 'a.html',
    })
    expect(resp.ok).toBe(true)
    expect(resp.payload).toEqual({ content: 'hi' })
    expect(resp.error).toBeNull()
    expect(resp.type).toBe('fs.read_file')
  })

  it('returns UNMAPPED_CAPABILITY without calling the broker for an unmapped type', async () => {
    const backend = useBackend()
    const resp = await backend.send('git.status', {})
    expect(callCapability).not.toHaveBeenCalled()
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe('UNMAPPED_CAPABILITY')
  })

  it('subscribes to plans.changed via nav.on', () => {
    const backend = useBackend()
    const cb = vi.fn()
    backend.on('plans.changed', cb)
    expect(
      (window as unknown as { nav: { on: ReturnType<typeof vi.fn> } }).nav.on
    ).toHaveBeenCalledWith('plans.changed', cb)
  })
})

describe('useBackend shim status transitions', () => {
  type NavListener = (data: unknown) => void
  const listeners = new Map<string, Set<NavListener>>()

  function fire(type: string, data: unknown): void {
    listeners.get(type)?.forEach((cb) => cb(data))
  }

  beforeEach(() => {
    listeners.clear()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability: vi.fn(),
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

  it('tracks host-pushed nav.backend_status transitions and ignores junk', () => {
    const backend = useBackend()
    expect(backend.status.value).toBe('connected')
    fire('nav.backend_status', { status: 'disconnected' })
    expect(backend.status.value).toBe('disconnected')
    fire('nav.backend_status', null)
    fire('nav.backend_status', { status: 'bogus' })
    expect(backend.status.value).toBe('disconnected')
    fire('nav.backend_status', { status: 'connected' })
    expect(backend.status.value).toBe('connected')
  })
})
