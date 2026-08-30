// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { revealPath } from '../hostShell'

const agentTeamReveal = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  agentTeamReveal.mockClear()
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { revealPath: agentTeamReveal }
})

describe('hostShell.revealPath', () => {
  it('reaches Electron shell through the preload bridge', async () => {
    await revealPath('/Users/me/project/README.md')
    expect(agentTeamReveal).toHaveBeenCalledWith('/Users/me/project/README.md')
  })

  it('does not throw when the bridge is absent', async () => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
    await expect(revealPath('/tmp/x')).resolves.toBeUndefined()
  })
})
