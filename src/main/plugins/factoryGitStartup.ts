interface FactoryLoadSuccess<T> {
  loaded: true
  activation: T
}

interface FactoryLoadFailure {
  loaded: false
  reason: string
}

interface LegacyActivationResult {
  registered: boolean
  reason?: string
}

export function shouldAttemptFactoryGit(state: {
  forcedLegacy: boolean
  installedPackagePresent: boolean
  optedOut: boolean
}): boolean {
  return !state.forcedLegacy && !state.installedPackagePresent && !state.optedOut
}

export function assertFactoryGitRestoreAllowed(state: { forcedLegacy: boolean }): void {
  if (state.forcedLegacy) {
    throw new Error(
      'Bundled Git cannot be restored while NAVIDE_GIT_RECOVERY=legacy is forcing legacy recovery'
    )
  }
}

/** Select one complete Git implementation during the factory compatibility
 * window. Trust/grant decisions happen before this seam; it handles only an
 * App-bundled v2 artifact that was selected but could not be loaded. */
export function activateFactoryGitWithLegacyFallback<T>(dependencies: {
  loadFactory(): FactoryLoadSuccess<T> | FactoryLoadFailure
  activateLegacy(): LegacyActivationResult
}):
  | { mode: 'v2'; activation: T }
  | { mode: 'legacy'; v2Reason: string }
  | { mode: 'unavailable'; v2Reason: string; legacyReason: string } {
  let factory: FactoryLoadSuccess<T> | FactoryLoadFailure
  try {
    factory = dependencies.loadFactory()
  } catch (error) {
    factory = {
      loaded: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (factory.loaded) return { mode: 'v2', activation: factory.activation }
  const legacy = dependencies.activateLegacy()
  if (legacy.registered) return { mode: 'legacy', v2Reason: factory.reason }
  return {
    mode: 'unavailable',
    v2Reason: factory.reason,
    legacyReason: legacy.reason ?? 'legacy Git bundle unavailable',
  }
}
