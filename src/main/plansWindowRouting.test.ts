import { describe, expect, it, vi } from 'vitest'
import {
  createPlansWindowRouter,
} from './plansWindowRouting'
import {
  FrontendPluginManager,
  PLANS_PLUGIN_ID,
  type PluginLaunchDescriptor,
} from './plugins/frontendPluginManager'

describe('Plans window production routing unit tests', () => {
  function setupRouter(options: {
    recoveryEnabled?: boolean
    backendAvailable?: boolean
    fallbackAllowed?: boolean
    v2OpenResult?: { ok: boolean; error?: string }
    descriptor?: PluginLaunchDescriptor | null
  } = {}) {
    const manager = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const packageVersion = '0.1.0'

    const descriptor: PluginLaunchDescriptor = options.descriptor !== undefined
      ? options.descriptor!
      : {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: '/path/to/plans',
          requires: ['fs', 'ui', 'plans', 'terminal'],
          capabilityPolicy: {
            kind: 'manifest-v2',
            system: ['fs', 'ui', 'aiCli'],
            shell: 'allowlist',
            grants: [],
          },
          devUrl: '',
          entryFile: '/path/to/plans/window.html',
          views: [
            {
              id: 'left',
              contributionKey: `${PLANS_PLUGIN_ID}.left`,
              kind: 'custom',
              location: 'left',
              title: 'Plans',
              entryFile: '/path/to/plans/left.html',
            },
            {
              id: 'window',
              contributionKey: `${PLANS_PLUGIN_ID}.window`,
              kind: 'custom',
              location: 'window',
              title: 'Plans',
              entryFile: '/path/to/plans/window.html',
            },
          ],
        }

    if (descriptor) {
      manager.registerDescriptor(descriptor, { builtin: true })
    }

    if (options.backendAvailable === false) {
      manager.markPlansBackendUnavailable('child-unavailable')
    }

    const legacyOpened: Array<{ workspacePath: string; relPath?: string }> = []
    const recoveryEntered: string[] = []
    const warnings: string[] = []
    const migrations: string[] = []

    const openCatalogWindowSpy = vi.fn(
      async (_key: string, _ws: string, _extra?: Record<string, string>) =>
        options.v2OpenResult ?? { ok: true },
    )
    const fallbackSpy = options.fallbackAllowed !== undefined
      ? vi.spyOn(manager, 'plansBackendFallbackAllowed').mockReturnValue(options.fallbackAllowed)
      : vi.spyOn(manager, 'plansBackendFallbackAllowed')

    let recoveryState = options.recoveryEnabled ?? false
    const router = createPlansWindowRouter({
      frontendPluginManager: manager,
      openCatalogContributionWindow: openCatalogWindowSpy,
      migratePlansStorageState: async () => {
        migrations.push('migrated')
      },
      isPlansRecoveryEnabled: () => recoveryState,
      enterPlansRecovery: (reason) => {
        recoveryState = true
        recoveryEntered.push(reason)
      },
      openLegacyPlanWindow: async (ws, rel) => {
        legacyOpened.push({ workspacePath: ws, relPath: rel })
      },
      warnMain: (msg) => {
        warnings.push(msg)
      },
    })

    return {
      manager,
      router,
      openCatalogWindowSpy,
      legacyOpened,
      recoveryEntered,
      warnings,
      migrations,
      fallbackSpy,
      workspacePath,
    }
  }

  it('does not register openPlansWindowHandler directly, allowing single registration in host index composition', async () => {
    const { manager, router } = setupRouter()
    const rawManager = manager as unknown as { openPlansWindowHandler?: ((ws: string, rel?: string) => Promise<boolean>) | null }
    expect(rawManager.openPlansWindowHandler).toBeNull()

    // Index composition registers exactly once
    manager.setOpenPlansWindowHandler((ws, rel) => router.openPlanWindow(ws, rel))
    expect(rawManager.openPlansWindowHandler).toBeDefined()

    const openSpy = vi.spyOn(router, 'openPlanWindow').mockResolvedValue(true)
    const result = await rawManager.openPlansWindowHandler!('/test-workspace', '.agent-team/plans/my-plan.html')
    expect(result).toBe(true)
    expect(openSpy).toHaveBeenCalledWith('/test-workspace', '.agent-team/plans/my-plan.html')
  })

  it('delegates to injected openCatalogContributionWindow with navide.plans.window after migration', async () => {
    const { router, migrations, openCatalogWindowSpy, workspacePath } = setupRouter()

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/example.html')
    expect(ok).toBe(true)
    expect(migrations).toEqual(['migrated'])
    expect(openCatalogWindowSpy).toHaveBeenCalledWith(
      'navide.plans.window',
      workspacePath,
      { rel_path: '.agent-team/plans/example.html' },
    )
  })

  it('passes empty extra params if relPath is omitted', async () => {
    const { router, openCatalogWindowSpy, workspacePath } = setupRouter()

    const ok = await router.openPlanWindow(workspacePath)
    expect(ok).toBe(true)
    expect(openCatalogWindowSpy).toHaveBeenCalledWith(
      'navide.plans.window',
      workspacePath,
      {},
    )
  })

  it('does not own generic openCatalogContributionWindow or manage contribution window maps', () => {
    const { router } = setupRouter()
    expect((router as unknown as Record<string, unknown>).openCatalogContributionWindow).toBeUndefined()
    expect((router as unknown as Record<string, unknown>).contributionWindows).toBeUndefined()
  })

  it('routes to legacy plan window when plans recovery is initially enabled', async () => {
    const { router, legacyOpened, openCatalogWindowSpy, workspacePath } = setupRouter({
      recoveryEnabled: true,
    })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(ok).toBe(true)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/plan.html' }])
  })

  it('routes to legacy plan window when descriptor is missing or incomplete', async () => {
    const { router, legacyOpened, openCatalogWindowSpy, workspacePath } = setupRouter({
      descriptor: null,
    })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(ok).toBe(true)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/plan.html' }])
  })

  it('falls back to legacy plan window if migration puts plans in recovery', async () => {
    const manager = new FrontendPluginManager()
    const workspacePath = '/workspace'
    manager.registerDescriptor(
      {
        id: PLANS_PLUGIN_ID,
        packageVersion: '0.1.0',
        packageDir: '/path/to/plans',
        requires: ['fs', 'ui', 'plans', 'terminal'],
        capabilityPolicy: {
          kind: 'manifest-v2',
          system: ['fs', 'ui', 'aiCli'],
          shell: 'allowlist',
          grants: [],
        },
        devUrl: '',
        entryFile: '/path/to/plans/window.html',
        views: [
          {
            id: 'left',
            contributionKey: `${PLANS_PLUGIN_ID}.left`,
            kind: 'custom',
            location: 'left',
            title: 'Plans',
            entryFile: '/path/to/plans/left.html',
          },
          {
            id: 'window',
            contributionKey: `${PLANS_PLUGIN_ID}.window`,
            kind: 'custom',
            location: 'window',
            title: 'Plans',
            entryFile: '/path/to/plans/window.html',
          },
        ],
      },
      { builtin: true },
    )
    let recoveryState = false
    const legacyOpened: Array<{ workspacePath: string; relPath?: string }> = []
    const openCatalogWindowSpy = vi.fn(async () => ({ ok: true }))

    const router = createPlansWindowRouter({
      frontendPluginManager: manager,
      openCatalogContributionWindow: openCatalogWindowSpy,
      migratePlansStorageState: async () => {
        recoveryState = true
      },
      isPlansRecoveryEnabled: () => recoveryState,
      enterPlansRecovery: () => {},
      openLegacyPlanWindow: async (ws, rel) => {
        legacyOpened.push({ workspacePath: ws, relPath: rel })
      },
      warnMain: () => {},
    })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/example.html')
    expect(ok).toBe(true)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/example.html' }])
  })

  it('falls back to legacy recovery if v2 open fails and fallback is allowed', async () => {
    const { router, legacyOpened, recoveryEntered, workspacePath } = setupRouter({
      v2OpenResult: { ok: false, error: 'child crashed' },
      fallbackAllowed: true,
    })

    const result = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(result).toBe(true)
    expect(recoveryEntered).toEqual(['window-open-failure'])
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/plan.html' }])
  })

  it('returns false and logs warning if v2 open fails and fallback is disallowed', async () => {
    const { router, warnings, legacyOpened, recoveryEntered, workspacePath } = setupRouter({
      v2OpenResult: { ok: false, error: 'unauthorized grant' },
      fallbackAllowed: false,
    })

    const result = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(result).toBe(false)
    expect(recoveryEntered).toHaveLength(0)
    expect(legacyOpened).toHaveLength(0)
    expect(warnings).toContainEqual(expect.stringContaining('navide.plans window open denied: unauthorized grant'))
  })
})
