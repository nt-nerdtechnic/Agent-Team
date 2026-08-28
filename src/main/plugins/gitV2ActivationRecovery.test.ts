import { describe, expect, it, vi } from 'vitest'
import { recoverFailedGitV2Activation } from './gitV2ActivationRecovery'

const failure = {
  pluginId: 'navide.git',
  packageVersion: '2.0.0',
  reason: 'plugin readiness handshake timed out',
}

describe('recoverFailedGitV2Activation', () => {
  it('switches the selected Git package to legacy only after its trusted v2 activation fails', () => {
    const activateLegacy = vi.fn(() => ({ registered: true as const }))
    const onActivated = vi.fn()

    expect(recoverFailedGitV2Activation(failure, {
      selectedDescriptor: () => ({
        id: 'navide.git',
        packageVersion: '2.0.0',
        capabilityPolicy: { kind: 'manifest-v2' },
      }),
      hasExactGrant: () => true,
      activateLegacy,
      onActivated,
    })).toBe(true)
    expect(activateLegacy).toHaveBeenCalledOnce()
    expect(onActivated).toHaveBeenCalledOnce()
  })

  it.each([
    ['another package', { ...failure, pluginId: 'acme.git' }, true],
    ['a stale package version', { ...failure, packageVersion: '1.0.0' }, true],
    ['a missing grant', failure, false],
  ])('does not fall back for %s', (_label, activationFailure, hasGrant) => {
    const activateLegacy = vi.fn(() => ({ registered: true as const }))
    expect(recoverFailedGitV2Activation(activationFailure, {
      selectedDescriptor: () => ({
        id: 'navide.git',
        packageVersion: '2.0.0',
        capabilityPolicy: { kind: 'manifest-v2' },
      }),
      hasExactGrant: () => hasGrant,
      activateLegacy,
      onActivated: vi.fn(),
    })).toBe(false)
    expect(activateLegacy).not.toHaveBeenCalled()
  })

  it('keeps the selected v2 package when the legacy artifact is unavailable', () => {
    const onActivated = vi.fn()
    expect(recoverFailedGitV2Activation(failure, {
      selectedDescriptor: () => ({
        id: 'navide.git',
        packageVersion: '2.0.0',
        capabilityPolicy: { kind: 'manifest-v2' },
      }),
      hasExactGrant: () => true,
      activateLegacy: () => ({ registered: false, reason: 'missing bundle' }),
      onActivated,
    })).toBe(false)
    expect(onActivated).not.toHaveBeenCalled()
  })
})
