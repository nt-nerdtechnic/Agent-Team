import { describe, expect, it, vi } from 'vitest'
import {
  activateFactoryGitWithLegacyFallback,
  assertFactoryGitRestoreAllowed,
  shouldAttemptFactoryGit,
} from './factoryGitStartup'

describe('shouldAttemptFactoryGit', () => {
  it('selects factory Git only for a normal, non-opted-out profile with no installed package', () => {
    expect(shouldAttemptFactoryGit({ forcedLegacy: false, installedPackagePresent: false, optedOut: false })).toBe(true)
    expect(shouldAttemptFactoryGit({ forcedLegacy: true, installedPackagePresent: false, optedOut: false })).toBe(false)
    expect(shouldAttemptFactoryGit({ forcedLegacy: false, installedPackagePresent: true, optedOut: false })).toBe(false)
    expect(shouldAttemptFactoryGit({ forcedLegacy: false, installedPackagePresent: false, optedOut: true })).toBe(false)
  })
})

describe('assertFactoryGitRestoreAllowed', () => {
  it('does not let Extensions restore override process-forced legacy recovery', () => {
    expect(() => assertFactoryGitRestoreAllowed({ forcedLegacy: true })).toThrow(
      /NAVIDE_GIT_RECOVERY=legacy/
    )
    expect(() => assertFactoryGitRestoreAllowed({ forcedLegacy: false })).not.toThrow()
  })
})

describe('activateFactoryGitWithLegacyFallback', () => {
  it('keeps a successfully loaded factory v2 package selected', () => {
    const activateLegacy = vi.fn()
    const activation = { pluginId: 'navide.git' }

    expect(activateFactoryGitWithLegacyFallback({
      loadFactory: () => ({ loaded: true, activation }),
      activateLegacy,
    })).toEqual({ mode: 'v2', activation })
    expect(activateLegacy).not.toHaveBeenCalled()
  })

  it('selects the whole legacy package when the factory v2 bundle cannot load', () => {
    expect(activateFactoryGitWithLegacyFallback({
      loadFactory: () => ({ loaded: false, reason: 'entry file is missing' }),
      activateLegacy: () => ({ registered: true }),
    })).toEqual({ mode: 'legacy', v2Reason: 'entry file is missing' })
  })

  it('reports both failures when neither compatibility artifact can load', () => {
    expect(activateFactoryGitWithLegacyFallback({
      loadFactory: () => ({ loaded: false, reason: 'invalid manifest' }),
      activateLegacy: () => ({ registered: false, reason: 'legacy entry missing' }),
    })).toEqual({
      mode: 'unavailable',
      v2Reason: 'invalid manifest',
      legacyReason: 'legacy entry missing',
    })
  })

  it('converts a thrown factory loader into legacy fallback', () => {
    expect(activateFactoryGitWithLegacyFallback({
      loadFactory: () => { throw new Error('bundle parse failed') },
      activateLegacy: () => ({ registered: true }),
    })).toEqual({ mode: 'legacy', v2Reason: 'bundle parse failed' })
  })
})
