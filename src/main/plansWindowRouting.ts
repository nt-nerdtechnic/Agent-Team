import {
  FrontendPluginManager,
  hasCompletePlansContributions,
  PLANS_PLUGIN_ID,
} from './plugins/frontendPluginManager'
import type { PlansStorageAvailability } from './plugins/plansStorageMigrationGate'

export interface PlansWindowRouterOptions {
  frontendPluginManager: FrontendPluginManager
  openCatalogContributionWindow: (
    contributionKey: string,
    workspacePath: string,
    extraParams?: Record<string, string>,
  ) => Promise<{ ok: boolean; error?: string }>
  migratePlansStorageState: () => Promise<PlansStorageAvailability>
  isPlansRecoveryEnabled: () => boolean
  enterPlansRecovery: (reason: string) => void
  openLegacyPlanWindow: (workspacePath: string, relPath?: string) => Promise<boolean | void>
  warnMain: (message: string) => void
}

export interface PlansWindowRouter {
  openPlanWindow: (workspacePath: string, relPath?: string) => Promise<boolean>
}

export interface ContributionWindowConfig {
  width: number
  height: number
  title?: string
  titleBarStyle?: 'hidden'
  backgroundColor: string
  show: boolean
  modal?: boolean
  parent?: undefined
  webPreferences: {
    contextIsolation: boolean
    nodeIntegration: boolean
  }
}

export function getContributionWindowKey(
  contributionKey: string,
  workspacePath: string,
  normalizeWorkspace?: (path: string) => string,
): string {
  if (contributionKey === `${PLANS_PLUGIN_ID}.window`) {
    const normalized = normalizeWorkspace
      ? normalizeWorkspace(workspacePath)
      : (workspacePath ?? '').trim().replace(/\/+$/, '')
    return `${contributionKey}:${normalized}`
  }
  return contributionKey
}

export function getContributionWindowConfig(
  contributionKey: string,
  title?: string,
): ContributionWindowConfig {
  if (contributionKey === `${PLANS_PLUGIN_ID}.window`) {
    return {
      width: 1100,
      height: 760,
      title: title || 'Plans',
      backgroundColor: '#0d1117',
      show: false,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    }
  }

  return {
    width: 1280,
    height: 820,
    title,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
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
    const hasAvailableV2Backend = frontendPluginManager.isPlansBackendAvailable()
    if (!hasCompleteV2Package || isPlansRecoveryEnabled()) {
      return (await openLegacyPlanWindow(workspacePath, relPath)) !== false
    }

    if (!hasAvailableV2Backend) {
      if (frontendPluginManager.plansBackendFallbackAllowed()) {
        enterPlansRecovery('backend-unavailable')
        return (await openLegacyPlanWindow(workspacePath, relPath)) !== false
      }
      warnMain(`[main] ${PLANS_PLUGIN_ID} backend is unavailable for the selected package`)
      return false
    }

    if (plansDescriptor?.packageVersion) {
      const storage = await migratePlansStorageState()
      if (storage.status === 'unavailable') {
        warnMain(`[main] ${PLANS_PLUGIN_ID} storage is unavailable`)
        return false
      }
      if (storage.status === 'recovery' || isPlansRecoveryEnabled()) {
        return (await openLegacyPlanWindow(workspacePath, relPath)) !== false
      }
      const result = await openCatalogContributionWindow(
        `${PLANS_PLUGIN_ID}.window`,
        workspacePath,
        relPath ? { rel_path: relPath } : {},
      )
      if (result.ok) return true
      if (frontendPluginManager.plansBackendFallbackAllowed()) {
        enterPlansRecovery('window-open-failure')
        return (await openLegacyPlanWindow(workspacePath, relPath)) !== false
      }
      warnMain(`[main] ${PLANS_PLUGIN_ID} window open denied: ${result.error ?? 'unknown error'}`)
      return false
    }
    return (await openLegacyPlanWindow(workspacePath, relPath)) !== false
  }

  return {
    openPlanWindow,
  }
}
