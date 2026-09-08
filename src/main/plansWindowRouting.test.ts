import { describe, expect, it, vi } from 'vitest'
import {
  createPlansWindowRouter,
  getContributionWindowConfig,
  getContributionWindowKey,
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
    migrationStatus?: 'ready' | 'recovery' | 'unavailable'
    legacyAvailable?: boolean
  } = {}) {
    const manager = new FrontendPluginManager()
    const workspacePath = '/workspace'
    const packageVersion = '0.1.0'

    const descriptor: PluginLaunchDescriptor = options.descriptor !== undefined
      ? options.descriptor!
      : {
          id: PLANS_PLUGIN_ID,
          packageVersion,
          packageDir: process.cwd(),
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

    if (descriptor?.packageVersion && descriptor.packageDir) {
      manager.registerDescriptor(descriptor, { builtin: true })
      manager.registerBackendActivation({
        pluginId: PLANS_PLUGIN_ID,
        packageVersion: descriptor.packageVersion,
        packageDir: descriptor.packageDir,
        entryFile: '/path/to/plans/backend/navide-plans',
        protocolVersion: 1,
        activation: 'startup',
        approvedMethods: ['plans.list'],
        agentMethods: ['plans.list'],
        approvedEvents: ['plans.changed'],
        approvedBridgePorts: ['filesystem'],
      })
      manager.setCapabilityGrantResolver(() => ({
        packageVersion: descriptor.packageVersion!,
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        storage: true,
      }))
    } else if (descriptor) manager.registerDescriptor(descriptor, { builtin: true })

    if (options.backendAvailable === false) {
      manager.markPlansBackendUnavailable('child-unavailable')
    }

    const legacyOpened: Array<{ workspacePath: string; relPath?: string }> = []
    // Recovery state observed at each legacy open; the legacy window only
    // carries its recovery bootstrap when recovery is already on at that point.
    const legacyOpenRecoveryStates: boolean[] = []
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
        return { status: options.migrationStatus ?? 'ready' }
      },
      isPlansRecoveryEnabled: () => recoveryState,
      enterPlansRecovery: (reason) => {
        recoveryState = true
        recoveryEntered.push(reason)
      },
      openLegacyPlanWindow: async (ws, rel) => {
        legacyOpened.push({ workspacePath: ws, relPath: rel })
        legacyOpenRecoveryStates.push(recoveryState)
        return options.legacyAvailable ?? true
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
      legacyOpenRecoveryStates,
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

  it('routes a complete, healthy v2 package to navide.plans.window and never opens legacy', async () => {
    const { router, migrations, openCatalogWindowSpy, legacyOpened, workspacePath } = setupRouter()

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/example.html')
    expect(ok).toBe(true)
    expect(migrations).toEqual(['migrated'])
    expect(openCatalogWindowSpy).toHaveBeenCalledWith(
      'navide.plans.window',
      workspacePath,
      { rel_path: '.agent-team/plans/example.html' },
    )
    expect(legacyOpened).toHaveLength(0)
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

  it('does not open v2 or legacy when migration has no trusted recovery source', async () => {
    const { router, openCatalogWindowSpy, legacyOpened } = setupRouter({ migrationStatus: 'unavailable' })
    expect(await router.openPlanWindow('/workspace')).toBe(false)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([])
  })

  it('uses the explicit migration recovery result before opening v2', async () => {
    const { router, openCatalogWindowSpy, legacyOpened } = setupRouter({ migrationStatus: 'recovery' })
    expect(await router.openPlanWindow('/workspace')).toBe(true)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([{ workspacePath: '/workspace', relPath: undefined }])
  })

  it('reports failure when the retained recovery adapter cannot bind its snapshot', async () => {
    const { router, openCatalogWindowSpy } = setupRouter({ migrationStatus: 'recovery', legacyAvailable: false })
    expect(await router.openPlanWindow('/workspace')).toBe(false)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
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

  it('enters recovery before opening legacy when the v2 package is missing', async () => {
    const { router, legacyOpened, legacyOpenRecoveryStates, recoveryEntered, openCatalogWindowSpy, workspacePath } =
      setupRouter({ descriptor: null })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(ok).toBe(true)
    expect(recoveryEntered).toEqual(['package-incomplete'])
    expect(legacyOpenRecoveryStates).toEqual([true])
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/plan.html' }])
  })

  it('enters recovery before opening legacy when the v2 package misses its window contribution', async () => {
    const { router, legacyOpenRecoveryStates, recoveryEntered, workspacePath } = setupRouter({
      descriptor: {
        id: PLANS_PLUGIN_ID,
        packageVersion: '0.1.0',
        packageDir: process.cwd(),
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
        ],
      },
    })

    expect(await router.openPlanWindow(workspacePath)).toBe(true)
    expect(recoveryEntered).toEqual(['package-incomplete'])
    expect(legacyOpenRecoveryStates).toEqual([true])
  })

  it('does not re-enter recovery when it is already active for a complete package', async () => {
    const { router, recoveryEntered, legacyOpenRecoveryStates, workspacePath } = setupRouter({
      recoveryEnabled: true,
    })

    expect(await router.openPlanWindow(workspacePath)).toBe(true)
    expect(recoveryEntered).toEqual([])
    expect(legacyOpenRecoveryStates).toEqual([true])
  })

  it('routes to legacy plan window when the complete v2 package backend is unavailable', async () => {
    const { router, legacyOpened, recoveryEntered, openCatalogWindowSpy, migrations, workspacePath } = setupRouter({
      backendAvailable: false,
    })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(ok).toBe(true)
    expect(migrations).toHaveLength(0)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(recoveryEntered).toEqual(['backend-unavailable'])
    expect(legacyOpened).toEqual([{ workspacePath, relPath: '.agent-team/plans/plan.html' }])
  })

  it('does not hide an unavailable v2 backend behind legacy when fallback is denied', async () => {
    const { router, legacyOpened, openCatalogWindowSpy, migrations, warnings, workspacePath } = setupRouter({
      backendAvailable: false,
      fallbackAllowed: false,
    })

    const ok = await router.openPlanWindow(workspacePath, '.agent-team/plans/plan.html')
    expect(ok).toBe(false)
    expect(migrations).toHaveLength(0)
    expect(openCatalogWindowSpy).not.toHaveBeenCalled()
    expect(legacyOpened).toHaveLength(0)
    expect(warnings).toContainEqual(expect.stringContaining('backend is unavailable'))
  })

  it('falls back to legacy plan window if migration puts plans in recovery', async () => {
    const manager = new FrontendPluginManager()
    const workspacePath = '/workspace'
    manager.registerDescriptor(
      {
        id: PLANS_PLUGIN_ID,
        packageVersion: '0.1.0',
        packageDir: process.cwd(),
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
    manager.registerBackendActivation({
      pluginId: PLANS_PLUGIN_ID,
      packageVersion: '0.1.0',
      packageDir: process.cwd(),
      entryFile: '/path/to/plans/backend/navide-plans',
      protocolVersion: 1,
      activation: 'startup',
      approvedMethods: ['plans.list'],
      agentMethods: ['plans.list'],
      approvedEvents: ['plans.changed'],
      approvedBridgePorts: ['filesystem'],
    })
    manager.setCapabilityGrantResolver(() => ({
      packageVersion: '0.1.0',
      system: ['fs', 'ui', 'aiCli'],
      shell: 'allowlist',
      storage: true,
    }))
    let recoveryState = false
    const legacyOpened: Array<{ workspacePath: string; relPath?: string }> = []
    const openCatalogWindowSpy = vi.fn(async () => ({ ok: true }))

    const router = createPlansWindowRouter({
      frontendPluginManager: manager,
      openCatalogContributionWindow: openCatalogWindowSpy,
      migratePlansStorageState: async () => {
        recoveryState = true
        return { status: 'recovery' }
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

  describe('getContributionWindowConfig', () => {
    it('uses legacy-compatible 1100x760 size and native titlebar for navide.plans.window', () => {
      const config = getContributionWindowConfig('navide.plans.window', 'Plans')
      expect(config).toEqual({
        width: 1100,
        height: 760,
        title: 'Plans',
        backgroundColor: '#0d1117',
        show: false,
        modal: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      expect(config.titleBarStyle).toBeUndefined()
      expect(config.parent).toBeUndefined()
    })

    it('defaults title to Plans for navide.plans.window when omitted', () => {
      const config = getContributionWindowConfig('navide.plans.window')
      expect(config.title).toBe('Plans')
    })

    it('preserves 1280x820 and hidden titleBarStyle for other contribution windows', () => {
      const gitConfig = getContributionWindowConfig('navide.git.window', 'Git')
      expect(gitConfig).toEqual({
        width: 1280,
        height: 820,
        title: 'Git',
        titleBarStyle: 'hidden',
        backgroundColor: '#0d1117',
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      })

      const customConfig = getContributionWindowConfig('custom.ext.window', 'Custom Ext')
      expect(customConfig.width).toBe(1280)
      expect(customConfig.height).toBe(820)
      expect(customConfig.titleBarStyle).toBe('hidden')
    })
  })

  describe('getContributionWindowKey', () => {
    it('scopes cache key by workspace for navide.plans.window', () => {
      const keyA = getContributionWindowKey('navide.plans.window', '/workspace/repo-a')
      const keyB = getContributionWindowKey('navide.plans.window', '/workspace/repo-b')
      expect(keyA).toBe('navide.plans.window:/workspace/repo-a')
      expect(keyB).toBe('navide.plans.window:/workspace/repo-b')
      expect(keyA).not.toBe(keyB)
    })

    it('normalizes trailing slashes for navide.plans.window cache key', () => {
      const keySlash = getContributionWindowKey('navide.plans.window', '/workspace/repo-a///')
      const keyClean = getContributionWindowKey('navide.plans.window', '/workspace/repo-a')
      expect(keySlash).toBe(keyClean)
    })

    it('uses custom normalizer when provided for navide.plans.window', () => {
      const normalizer = (p: string) => p.toUpperCase()
      const key = getContributionWindowKey('navide.plans.window', '/workspace/repo', normalizer)
      expect(key).toBe('navide.plans.window:/WORKSPACE/REPO')
    })

    it('preserves generic contribution key without workspace scoping for non-plans contributions', () => {
      const keyGitA = getContributionWindowKey('navide.git.window', '/workspace/repo-a')
      const keyGitB = getContributionWindowKey('navide.git.window', '/workspace/repo-b')
      expect(keyGitA).toBe('navide.git.window')
      expect(keyGitB).toBe('navide.git.window')

      const customKey = getContributionWindowKey('custom.other.window', '/workspace/repo-a')
      expect(customKey).toBe('custom.other.window')
    })
  })
})
