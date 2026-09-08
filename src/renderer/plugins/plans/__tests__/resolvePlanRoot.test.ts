import { describe, expect, it, vi } from 'vitest'
import { resolvePlanRoot, type PlansBackendPort } from '../resolvePlanRoot'

function backend(send: PlansBackendPort['send']): PlansBackendPort {
  return { send }
}

describe('resolvePlanRoot', () => {
  it('returns the backend root for a successful Plans resolution', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      payload: { ok: true, root: '/repo' },
    }))

    await expect(resolvePlanRoot(backend(send), '/repo/packages/app')).resolves.toBe('/repo')
    expect(send).toHaveBeenCalledWith(
      'plans.resolve_root',
      { workspace_path: '/repo/packages/app' },
    )
  })

  it('falls back to the workspace when the response has no usable root', async () => {
    const send = vi.fn(async () => ({
      ok: false,
      payload: null,
    }))

    await expect(resolvePlanRoot(backend(send), '/repo')).resolves.toBe('/repo')
  })

  it('leaves transport failures for the UI caller to handle', async () => {
    const failure = new Error('backend unavailable')
    const send = vi.fn(async () => {
      throw failure
    })

    await expect(resolvePlanRoot(backend(send), '/repo')).rejects.toBe(failure)
  })
})
