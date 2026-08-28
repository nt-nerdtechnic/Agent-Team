export interface GitV2ActivationFailure {
  pluginId: string
  packageVersion: string
  reason: string
}

interface SelectedGitDescriptor {
  id: string
  packageVersion?: string
  capabilityPolicy?: { kind: string }
}

interface GitV2RecoveryDependencies {
  selectedDescriptor(): SelectedGitDescriptor | null
  hasExactGrant(pluginId: string, packageVersion: string): boolean
  activateLegacy(): { registered: boolean; reason?: string }
  onActivated(): void
}

/**
 * Switch the whole selected Git package to the retained v1 artifact only when
 * the exact, granted Manifest v2 package reached activation and then failed.
 * Absence, trust/grant denial, and stale-version failures stay fail closed.
 */
export function recoverFailedGitV2Activation(
  failure: GitV2ActivationFailure,
  dependencies: GitV2RecoveryDependencies,
): boolean {
  if (failure.pluginId !== 'navide.git') return false
  const selected = dependencies.selectedDescriptor()
  if (
    selected?.id !== failure.pluginId ||
    selected.packageVersion !== failure.packageVersion ||
    selected.capabilityPolicy?.kind !== 'manifest-v2' ||
    !dependencies.hasExactGrant(failure.pluginId, failure.packageVersion)
  ) {
    return false
  }
  const recovery = dependencies.activateLegacy()
  if (!recovery.registered) return false
  dependencies.onActivated()
  return true
}
