import {
  FrontendPluginManager,
  hasCompletePlansContributions,
  PLANS_PLUGIN_ID,
} from './plugins/frontendPluginManager'

export interface PlansWindowRouterOptions {
  frontendPluginManager: FrontendPluginManager
  openCatalogContributionWindow: (
    contributionKey: string,
    workspacePath: string,
    extraParams?: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string }>
  migratePlansStorageState: () => Promise<unknown>
  isPlansRecoveryEnabled: () => boolean
  enterPlansRecovery: (reason: string) => void
  openLegacyPlanWindow: (workspacePath: string, relPath?: string) => Promise<void>
  warnMain: (message: string) => void
}

export interface PlansWindowRouter {
  openPlanWindow: (workspacePath: string, relPath?: string) => Promise<boolean>
}

export function createPlansWindowRouter(options: PlansWindowRouterOptions): PlansWindowRouter {
  const {
    frontendPluginManager,
    openCatalogContributionWindow,
    migratePlansStorageState,
    isPlansRecoveryEnabled,
    enterPlansRecovery,
    openLegacyPlanWindow,
    warnMain,
  } = options

  async function openPlanWindow(workspacePath: string, relPath?: string): Promise<boolean> {
    const plansDescriptor = frontendPluginManager.getDescriptor(PLANS_PLUGIN_ID)
    const hasCompleteV2Package = Boolean(
      hasCompletePlansContributions(plansDescriptor) &&
      plansDescriptor?.packageVersion &&
      plansDescriptor?.packageDir
    )
    if (!hasCompleteV2Package || isPlansRecoveryEnabled()) {
      await openLegacyPlanWindow(workspacePath, relPath)
      return true
    }

    if (plansDescriptor?.packageVersion) {
      await migratePlansStorageState()
      if (isPlansRecoveryEnabled()) {
        await openLegacyPlanWindow(workspacePath, relPath)
        return true
      }
      const result = await openCatalogContributionWindow(
        `${PLANS_PLUGIN_ID}.window`,
        workspacePath,
        relPath ? { rel_path: relPath } : {},
      )
      if (result.ok) return true
      if (frontendPluginManager.plansBackendFallbackAllowed()) {
        enterPlansRecovery('window-open-failure')
        await openLegacyPlanWindow(workspacePath, relPath)
        return true
      }
      warnMain(`[main] ${PLANS_PLUGIN_ID} window open denied: ${result.error ?? 'unknown error'}`)
      return false
    }
    await openLegacyPlanWindow(workspacePath, relPath)
    return true
  }

  return {
    openPlanWindow,
  }
}
