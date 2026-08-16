// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TYPE_TO_CAP, resolveCapability, useBackend } from '../capabilityBackend'
import { PLANS_PLUGIN_REQUIRES } from '../../../../shared/pluginCapabilities'
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
// lib/settings + the embedded AiCliDock's useTerminal). The map MUST resolve
// all of them.
const PLANS_SENT_TYPES = [
  // fs (stat_path/list_files_flat also back the CLI dock's @-mention)
  'fs.read_file', 'fs.write_file', 'fs.list_dir', 'fs.list_files_flat',
  'fs.glob_files', 'fs.delete', 'fs.rename', 'fs.list_archive',
  'fs.convert_office', 'fs.stat_path',
  // plans — the document index (PlanWindowApp root resolution, PlansPane
  // listing + parsed-meta cache write-back)
  'plans.resolve_root', 'plans.list_docs', 'plans.cache_put',
  // ui / settings (theme sync via lib/settings.ts)
  'ui.settings.get', 'ui.settings.set',
  // embedded AiCliDock — interactive PTY (useTerminal)
  'terminal.create', 'terminal.create.cancel', 'terminal.input',
  'terminal.log_sent', 'terminal.resize', 'terminal.interrupt', 'terminal.kill',
  'terminal.reattach', 'terminal.redraw',
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
    expect(manifest.requires).toEqual([...PLANS_PLUGIN_REQUIRES])
    // A frontend view starts when the host opens it; the loader never reads
    // activationEvents, so declaring one would promise an unimplemented
    // lifecycle.
    expect(manifest.activationEvents).toBeUndefined()
  })

  it('grants exactly the namespaces the capability map uses', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8')
    const manifest = JSON.parse(raw) as { requires: string[] }
    const mappedNs = new Set(Object.values(TYPE_TO_CAP).map((ref) => ref.ns))
    for (const ns of mappedNs) expect(manifest.requires).toContain(ns)
    // `plans` gates both the document-index calls and the `plans.changed` event.
    expect(manifest.requires).toContain('plans')
    expect(mappedNs.has('plans')).toBe(true)
  })
})

describe('TYPE_TO_CAP coverage', () => {
  it('resolves every WS type the Plans UI sends to a capability', () => {
    const unmapped = PLANS_SENT_TYPES.filter((t) => resolveCapability(t) === null)
    expect(unmapped).toEqual([])
  })

  it('maps only into the granted capability namespaces', () => {
    const allowed = new Set(PLANS_PLUGIN_REQUIRES)
    for (const ref of Object.values(TYPE_TO_CAP)) {
      expect(allowed.has(ref.ns)).toBe(true)
    }
  })

  it('splits the uniform fs namespace on the dotted method', () => {
    expect(resolveCapability('fs.read_file')).toEqual({ ns: 'fs', method: 'read_file' })
    expect(resolveCapability('fs.list_dir')).toEqual({ ns: 'fs', method: 'list_dir' })
  })

  it('splits the uniform plans namespace on the dotted method', () => {
    // Unmapped, PlanWindowApp's mount-time root resolution and PlansPane's
    // listing both fail with UNMAPPED_CAPABILITY inside the plugin sandbox,
    // leaving the window with the raw query-string workspace as its root.
    expect(resolveCapability('plans.resolve_root')).toEqual({
      ns: 'plans',
      method: 'resolve_root',
    })
    expect(resolveCapability('plans.list_docs')).toEqual({ ns: 'plans', method: 'list_docs' })
    expect(resolveCapability('plans.cache_put')).toEqual({ ns: 'plans', method: 'cache_put' })
  })

  it('remaps the non-uniform settings family onto the ui namespace', () => {
    expect(resolveCapability('ui.settings.get')).toEqual({ ns: 'ui', method: 'settings_get' })
    expect(resolveCapability('ui.settings.set')).toEqual({ ns: 'ui', method: 'settings_set' })
  })

  it('maps the AiCliDock PTY surface onto the terminal namespace', () => {
    expect(resolveCapability('terminal.create')).toEqual({ ns: 'terminal', method: 'create' })
    expect(resolveCapability('terminal.input')).toEqual({ ns: 'terminal', method: 'input' })
    expect(resolveCapability('terminal.reattach')).toEqual({ ns: 'terminal', method: 'reattach' })
    // Second dot → explicit remap, not the uniform split.
    expect(resolveCapability('terminal.create.cancel')).toEqual({
      ns: 'terminal',
      method: 'create_cancel',
    })
    expect(resolveCapability('shell.run')).toEqual({ ns: 'terminal', method: 'run' })
  })

  it('returns null for types outside the Plans surface', () => {
    // The retired AIChatPane chat/search/git surface is gone with the pane —
    // the Plans tree sends no git.* call at all (planShare writes via fs).
    expect(resolveCapability('git.status')).toBeNull()
    expect(resolveCapability('git.commit')).toBeNull()
    expect(resolveCapability('git.diff_all')).toBeNull()
    expect(resolveCapability('editor.rewrite')).toBeNull()
    expect(resolveCapability('ai.chat.start')).toBeNull()
    expect(resolveCapability('search.find_in_files')).toBeNull()
    expect(resolveCapability('plans.nope')).toBeNull()
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

  it('casts terminal.input fire-and-forget when the host exposes castCapability', async () => {
    const castCapability = vi.fn()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      castCapability,
      on: vi.fn(() => () => {}),
      ready: vi.fn(),
    }
    const backend = useBackend()
    const resp = await backend.send('terminal.input', { terminal_session_id: 't-1', data: 'x' })
    expect(castCapability).toHaveBeenCalledWith('terminal', 'input', {
      terminal_session_id: 't-1',
      data: 'x',
    })
    expect(callCapability).not.toHaveBeenCalled()
    expect(resp.ok).toBe(true)
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
