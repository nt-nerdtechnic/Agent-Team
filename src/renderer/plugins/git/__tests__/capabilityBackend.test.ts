// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TYPE_TO_CAP, resolveCapability, useBackend } from '../capabilityBackend'
import { GIT_PLUGIN_REQUIRES } from '../../../../shared/pluginCapabilities'
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

  it('maps the three-way conflict calls (inverse of the host capabilityMap)', () => {
    expect(resolveCapability('git.conflict_stages')).toEqual({
      ns: 'git',
      method: 'conflict_stages',
    })
    expect(resolveCapability('git.list_conflicts')).toEqual({ ns: 'git', method: 'list_conflicts' })
    expect(resolveCapability('git.mark_resolved')).toEqual({ ns: 'git', method: 'mark_resolved' })
  })

  it('maps the diff calls the shared DiffPane sends', () => {
    expect(resolveCapability('git.diff_file')).toEqual({ ns: 'git', method: 'diff_file' })
    expect(resolveCapability('git.apply_patch')).toEqual({ ns: 'git', method: 'apply_patch' })
    expect(resolveCapability('fs.read_image')).toEqual({ ns: 'fs', method: 'read_image' })
  })

  // Asserted against the shared declaration, so adding a namespace to the map
  // without granting it in the manifest fails here instead of at runtime.
  it('maps only into the granted capability namespaces', () => {
    const allowed = new Set(GIT_PLUGIN_REQUIRES)
    for (const ref of Object.values(TYPE_TO_CAP)) {
      expect(allowed.has(ref.ns)).toBe(true)
    }
  })

  it('maps the embedded GitPane issues panel calls', () => {
    expect(resolveCapability('issues.list')).toEqual({ ns: 'issues', method: 'list' })
    expect(resolveCapability('issues.set_state')).toEqual({ ns: 'issues', method: 'set_state' })
  })

  it('maps the open-in-editor host capability (mini-IDE hand-off)', () => {
    expect(resolveCapability('ui.open_in_editor')).toEqual({
      ns: 'ui',
      method: 'open_in_editor',
    })
  })

  it('maps the shell-level host capabilities (worktree/remote card actions)', () => {
    expect(resolveCapability('ui.open_external')).toEqual({ ns: 'ui', method: 'open_external' })
    expect(resolveCapability('ui.reveal_path')).toEqual({ ns: 'ui', method: 'reveal_path' })
    expect(resolveCapability('ui.open_workspace')).toEqual({ ns: 'ui', method: 'open_workspace' })
    expect(resolveCapability('ui.pick_folder')).toEqual({ ns: 'ui', method: 'pick_folder' })
  })

  it('maps the embedded AiCliDock PTY surface (terminal + @-mention fs probes)', () => {
    expect(resolveCapability('terminal.create')).toEqual({ ns: 'terminal', method: 'create' })
    expect(resolveCapability('terminal.input')).toEqual({ ns: 'terminal', method: 'input' })
    expect(resolveCapability('terminal.log_sent')).toEqual({ ns: 'terminal', method: 'log_sent' })
    expect(resolveCapability('terminal.resize')).toEqual({ ns: 'terminal', method: 'resize' })
    expect(resolveCapability('terminal.interrupt')).toEqual({ ns: 'terminal', method: 'interrupt' })
    expect(resolveCapability('terminal.kill')).toEqual({ ns: 'terminal', method: 'kill' })
    expect(resolveCapability('terminal.reattach')).toEqual({ ns: 'terminal', method: 'reattach' })
    expect(resolveCapability('terminal.redraw')).toEqual({ ns: 'terminal', method: 'redraw' })
    // Second dot → explicit remap, not the uniform split.
    expect(resolveCapability('terminal.create.cancel')).toEqual({
      ns: 'terminal',
      method: 'create_cancel',
    })
    expect(resolveCapability('shell.run')).toEqual({ ns: 'terminal', method: 'run' })
    expect(resolveCapability('fs.list_files_flat')).toEqual({ ns: 'fs', method: 'list_files_flat' })
    expect(resolveCapability('fs.stat_path')).toEqual({ ns: 'fs', method: 'stat_path' })
  })

  it('no longer maps the retired AIChatPane chat/search surface', () => {
    expect(resolveCapability('ai.chat.start')).toBeNull()
    expect(resolveCapability('ai.enhance_prompt')).toBeNull()
    expect(resolveCapability('search.find_in_files')).toBeNull()
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

describe('useBackend shim one-way input casts', () => {
  const callCapability = vi.fn()
  const castCapability = vi.fn()

  function installNav(withCast: boolean): void {
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      ...(withCast ? { castCapability } : {}),
      on: vi.fn(() => () => {}),
      ready: vi.fn(),
    }
  }

  beforeEach(() => {
    callCapability.mockReset()
    castCapability.mockReset()
  })

  it('casts terminal.input fire-and-forget and resolves ok immediately', async () => {
    installNav(true)
    const backend = useBackend()
    const resp = await backend.send('terminal.input', { terminal_session_id: 't-1', data: 'x' })
    expect(castCapability).toHaveBeenCalledWith('terminal', 'input', {
      terminal_session_id: 't-1',
      data: 'x',
    })
    expect(callCapability).not.toHaveBeenCalled()
    expect(resp.ok).toBe(true)
  })

  it('casts terminal.log_sent the same way', async () => {
    installNav(true)
    const backend = useBackend()
    const resp = await backend.send('terminal.log_sent', { terminal_session_id: 't-1' })
    expect(castCapability).toHaveBeenCalledWith('terminal', 'log_sent', {
      terminal_session_id: 't-1',
    })
    expect(callCapability).not.toHaveBeenCalled()
    expect(resp.ok).toBe(true)
  })

  it('keeps request/response semantics for every other terminal type', async () => {
    installNav(true)
    callCapability.mockResolvedValue({ reqId: 'r1', ok: true, result: { alive: [], dead: [] } })
    const backend = useBackend()
    await backend.send('terminal.reattach', { terminal_session_ids: ['t-1'] })
    expect(castCapability).not.toHaveBeenCalled()
    expect(callCapability).toHaveBeenCalledWith('terminal', 'reattach', {
      terminal_session_ids: ['t-1'],
    })
  })

  it('falls back to callCapability when the host lacks castCapability', async () => {
    installNav(false)
    callCapability.mockResolvedValue({ reqId: 'r1', ok: true, result: null })
    const backend = useBackend()
    const resp = await backend.send('terminal.input', { data: 'x' })
    expect(callCapability).toHaveBeenCalledWith('terminal', 'input', { data: 'x' })
    expect(resp.ok).toBe(true)
  })

  it('returns a timeout envelope when the capability broker misses the deadline', async () => {
    installNav(true)
    callCapability.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const backend = useBackend()
      const responsePromise = backend.send('git.status', { workspace_path: '/workspace' }, 25)
      await vi.advanceTimersByTimeAsync(24)
      expect(callCapability).toHaveBeenCalledWith('git', 'status', { workspace_path: '/workspace' })

      await vi.advanceTimersByTimeAsync(1)
      const response = await responsePromise
      expect(response.ok).toBe(false)
      expect(response.error).toEqual({
        code: 'TIMEOUT',
        message: "capability call 'git.status' timed out after 25ms",
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
