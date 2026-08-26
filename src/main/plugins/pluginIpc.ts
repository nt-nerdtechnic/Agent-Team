// IPC surface for the Extensions view: list installed plugins, search the
// marketplace, and drive the verified install / remove flow. The security
// chain lives in `pluginInstaller` (download → digest → signature → scope →
// zip-slip); this module only wires it to `ipcMain` and the loader registry.
//
// Install is two-step so the renderer can interpose a trust confirmation for
// sensitive (fs/aiCli/shell) capabilities or native backend code:
// `plugins:prepareInstall` downloads +
// verifies and returns the trust facts WITHOUT writing to disk; the renderer
// shows the warning, then `plugins:commitInstall` writes the verified package.
// Download bytes never cross to the renderer — the prepared package is held
// main-side, keyed by id, until commit.

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  prepareInstall,
  commitInstallTransaction,
  removePlugin,
  type PreparedInstall,
  type InstallerTrustConfig,
} from './pluginInstaller'
import {
  sensitiveCapabilities,
  assertRegistryUrlAllowed,
  sha256Hex,
} from './pluginVerify'
import type { RegistryPackageEnvelope, RegistryTrustMetadata } from './pluginRegistryTrust'
import { verifyRegistryTrustMetadata } from './pluginRegistryTrust'
import {
  loadOfficialRegistryRootKey,
  resolveMarketplaceRegistryRoot,
} from './pluginRegistryRootApproval'
import {
  isManifestV2,
  loadPluginDir,
  manifestToActivation,
  manifestToInstalledPackageSummary,
  type PluginActivationCatalogEntry,
} from './installedPlugins'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { PluginPublisherTrustStore } from './pluginPublisherTrust'
import {
  REGISTRY_ARTIFACT_NAME,
  readRegistryTrustSnapshot,
  discoverInstalledRegistryPackageIds,
  verifyInstalledRegistryPackage,
  writeRegistryTrustSnapshot,
  type InstalledTrustDecision,
} from './pluginInstalledTrust'
import { currentPluginHostTarget } from './pluginTarget'
import type { FrontendPluginManager } from './frontendPluginManager'

/** Development-only endpoint. It is intentionally not the official Registry
 * identity: a local Registry must establish trust through root approval. */
const DEFAULT_MARKETPLACE_URL = 'http://localhost:8787'
/** App-shipped Official Registry identity. A normalized match is always
 * resolved through the independent packaged root pin and cannot be downgraded
 * by approval. */
const OFFICIAL_MARKETPLACE_URL = 'https://registry.navide.dev'

/** Resolve the marketplace registry URL, enforcing the transport policy
 *  (production forbids plaintext http except loopback). Throws before any
 *  fetch when the configured URL is disallowed. */
export function resolveConfiguredMarketplace(
  explicitTrust?: InstallerTrustConfig
): { registryUrl: string; trust: InstallerTrustConfig } {
  if (explicitTrust) {
    const registryUrl = process.env['AGENT_TEAM_MARKETPLACE_URL'] ?? DEFAULT_MARKETPLACE_URL
    assertRegistryUrlAllowed(registryUrl, app.isPackaged)
    return {
      registryUrl,
      trust: {
        ...explicitTrust,
        registryAuthority: explicitTrust.registryAuthority ?? 'self-hosted',
        officialRegistryUrl: explicitTrust.officialRegistryUrl ?? OFFICIAL_MARKETPLACE_URL,
        expectedTarget: explicitTrust.expectedTarget ?? currentPluginHostTarget(),
      },
    }
  }
  const resolved = resolveMarketplaceRegistryRoot({
    registryUrlOverride: process.env['AGENT_TEAM_MARKETPLACE_URL'],
    defaultRegistryUrl: DEFAULT_MARKETPLACE_URL,
    officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
    officialRootPublicKey: loadOfficialRegistryRootKey(process.resourcesPath),
    approvalFile: process.env['AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'],
  })
  assertRegistryUrlAllowed(resolved.registryUrl, app.isPackaged)
  return {
    registryUrl: resolved.registryUrl,
    trust: {
      pinnedRegistryRootKey: resolved.rootPublicKey,
      registryAuthority: resolved.authority,
      officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
      expectedTarget: currentPluginHostTarget(),
    },
  }
}

interface InstalledSummary {
  id: string
  requires: string[]
  sensitive: string[]
  provenance?: 'official-registry' | 'developer-local-unpacked'
  warning?: string
}

export interface PluginTrustRefreshController {
  refreshRegistryTrust(): Promise<{
    decisions: Array<{ pluginId: string; action: 'allow' | 'quarantine'; reason?: string }>
    activationCatalog: ReturnType<FrontendPluginManager['loadInstalledPlugins']>['activationCatalog']
  }>
}

export interface PluginIpcOptions {
  verifyCommittedInstall?: (
    pluginDir: string,
    pluginId: string,
    trust: InstallerTrustConfig
  ) => InstalledTrustDecision
  onActivationChange?: (change: {
    pluginId: string
    activation?: PluginActivationCatalogEntry
  }) => void
  /** Actual uninstall boundary; rollback/quarantine paths deliberately do not call this. */
  cleanupPluginStorage?: (pluginId: string) => Promise<void>
}

function assertPluginRemovalTarget(pluginsRoot: string, value: unknown): string {
  if (!isValidManifestV2PluginId(value)) throw new Error('invalid plugin id')
  const root = resolve(pluginsRoot)
  const target = resolve(root, value)
  if (dirname(target) !== root) throw new Error('invalid plugin id')
  return value
}

function cleanupFailedPluginInstall(
  manager: FrontendPluginManager,
  onActivationChange: PluginIpcOptions['onActivationChange'],
  pluginId: string
): void {
  try {
    manager.removeInstalledPlugin(pluginId)
  } catch {
    // Cleanup is best-effort; the install failure remains the reported error.
  }
  try {
    onActivationChange?.({ pluginId })
  } catch {
    // Keep manager cleanup and the original install failure from being masked.
  }
}

/** Restrict plugin management to the owning WebContents of a live Host window. */
export function isTrustedPluginManagementSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trustedWindows: ReadonlySet<BrowserWindow>
): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    window &&
      !window.isDestroyed() &&
      trustedWindows.has(window) &&
      window.webContents === event.sender &&
      !event.senderFrame?.parent
  )
}

/** Register every `plugins:*` handler exactly once. `pluginsRoot` is where
 *  verified packages are written (`userData/plugins`). */
export function registerPluginIpc(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  authorizeSender: (event: IpcMainInvokeEvent) => boolean,
  trust?: InstallerTrustConfig,
  publisherTrust = new PluginPublisherTrustStore(
    join(pluginsRoot, '.navide-publisher-trust.json')
  ),
  options: PluginIpcOptions = {}
): PluginTrustRefreshController {
  // Packages verified by prepareInstall, awaiting a commit, keyed by plugin id.
  const prepared = new Map<string, { pkg: PreparedInstall }>()

  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorizeSender(event)) throw new Error('unauthorized plugin management request')
  }

  ipcMain.handle('plugins:listInstalled', (event): InstalledSummary[] => {
    assertAuthorized(event)
    const summaries = new Map<
      string,
      {
        id: string
        requires: string[]
        provenance?: 'official-registry' | 'developer-local-unpacked'
        warning?: string
      }
    >()
    for (const descriptor of manager.listDescriptors()) {
      summaries.set(descriptor.id, { id: descriptor.id, requires: descriptor.requires })
    }
    for (const pkg of manager.listInstalledPackages()) summaries.set(pkg.id, pkg)
    return [...summaries.values()].map((summary) => ({
      id: summary.id,
      requires: summary.requires,
      sensitive: sensitiveCapabilities(summary.requires),
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
    }))
  })

  ipcMain.handle('plugins:listContributions', (event) => {
    assertAuthorized(event)
    return manager.listContributionCatalog()
  })

  ipcMain.handle('plugins:marketplaceSearch', async (event, query?: string) => {
    assertAuthorized(event)
    const { registryUrl } = resolveConfiguredMarketplace(trust)
    const url = new URL('/api/extensions', registryUrl)
    if (query) url.searchParams.set('q', query)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`marketplace search failed: HTTP ${res.status}`)
    return res.json()
  })

  ipcMain.handle(
    'plugins:prepareInstall',
    async (event, args: { namespace: string; name: string; version?: string }) => {
      assertAuthorized(event)
      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const detailRes = await fetch(`${base}/api/extensions/${args.namespace}/${args.name}`)
      if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
      const detail = (await detailRes.json()) as {
        latest_version: string | null
        trust_metadata: RegistryTrustMetadata
        trust_metadata_signature: string
        versions: Array<{
          version: string
          package_digest: string
          target: string
          registry_envelope: RegistryPackageEnvelope
          registry_signature: string
          trust_tier: string
          yanked: boolean
        }>
      }
      const wanted = args.version ?? detail.latest_version
      const versionRow = detail.versions.find((v) => v.version === wanted && !v.yanked)
      if (!versionRow) throw new Error(`no installable version ${wanted ?? '(latest)'} found`)

      // The selected Registry envelope and current root-signed trust metadata
      // are verified against the Host-owned root pin before any install write.
      const result = await prepareInstall({
        registryUrl: marketplace.registryUrl,
        namespace: args.namespace,
        name: args.name,
        version: versionRow.version,
        expectedDigest: versionRow.package_digest,
        target: versionRow.target,
        registryEnvelope: versionRow.registry_envelope,
        registrySignature: versionRow.registry_signature,
        trustMetadata: detail.trust_metadata,
        trustMetadataSignature: detail.trust_metadata_signature,
        claimedTrustTier: versionRow.trust_tier,
        provenance: 'official-registry',
      }, undefined, marketplace.trust)
      prepared.set(result.id, { pkg: result })
      return {
        id: result.id,
        version: result.version,
        trustTier: result.trustTier,
        sensitive: result.sensitive,
        containsBackendExecutable: result.containsBackendExecutable,
        requiresConfirmation: result.requiresConfirmation,
        publisherId: result.publisherId,
        requiresPublisherTrust:
          result.registryEvidence !== undefined &&
          !result.official &&
          !publisherTrust.isTrusted(result.publisherId, result.id),
        requiresRiskConfirmation: result.requiresConfirmation,
      }
    }
  )

  ipcMain.handle(
    'plugins:commitInstall',
    (
      event,
      args: { id: string; publisherConfirmed?: boolean; riskConfirmed?: boolean }
    ) => {
      assertAuthorized(event)
      const pending = prepared.get(args.id)
      if (!pending) throw new Error(`no prepared install for ${args.id}; call prepareInstall first`)
      const { pkg } = pending
      // Re-resolve Host-owned trust at commit time. Prepare-time evidence is
      // retained for the transaction, but expiry, root approval, and target
      // policy must not be frozen across the renderer confirmation round trip.
      const commitTrust = resolveConfiguredMarketplace(trust).trust
      const publisherRequiresTrust =
        pkg.registryEvidence !== undefined &&
        !pkg.official &&
        !publisherTrust.isTrusted(pkg.publisherId, pkg.id)
      if (publisherRequiresTrust && args.publisherConfirmed !== true) {
        throw new Error(`publisher trust confirmation is required for ${pkg.publisherId}`)
      }
      if (pkg.requiresConfirmation && args.riskConfirmed !== true) {
        throw new Error(`capability and backend risk confirmation is required for ${args.id}`)
      }
      // Persist this explicit, package-scoped publisher decision separately
      // from installation and capability grants only after the package has
      // passed post-write verification and manager registration.
      const previousSummary = manager.listInstalledPackages().find((item) => item.id === pkg.id)
      const previousDescriptor = manager.getDescriptor(pkg.id)
      const previousActivation =
        previousSummary?.provenance === 'official-registry'
          ? loadPluginDir(join(pluginsRoot, pkg.id)).activation
          : undefined
      const previousArtifactDigest = previousActivation
        ? (() => {
            try {
              return sha256Hex(
                new Uint8Array(
                  readFileSync(join(pluginsRoot, pkg.id, REGISTRY_ARTIFACT_NAME))
                )
              )
            } catch {
              return undefined
            }
          })()
        : undefined
      let transaction: ReturnType<typeof commitInstallTransaction> | undefined
      let publisherConsentPersisted = false
      try {
        transaction = commitInstallTransaction(pkg, pluginsRoot)
        const descriptor = transaction.descriptor
        let verifiedArtifactDigest: string | undefined
        if (pkg.registryEvidence) {
          const verifyCommitted =
            options.verifyCommittedInstall ??
            ((pluginDir: string, pluginId: string, trustConfig: InstallerTrustConfig) =>
              verifyInstalledRegistryPackage(pluginDir, pluginId, {
                pinnedRootKey: trustConfig.pinnedRegistryRootKey,
                snapshot: readRegistryTrustSnapshot(pluginsRoot),
                registryAuthority: trustConfig.registryAuthority,
                officialRegistryUrl: trustConfig.officialRegistryUrl,
                expectedTarget: trustConfig.expectedTarget ?? currentPluginHostTarget(),
                now: trustConfig.now,
              }))
          const decision = verifyCommitted(join(pluginsRoot, pkg.id), pkg.id, commitTrust)
          if (decision.action === 'quarantine') {
            prepared.delete(args.id)
            throw new Error(`installed plugin quarantined: ${decision.reason}`)
          }
          verifiedArtifactDigest = decision.artifactDigest
        }
        const summary = manifestToInstalledPackageSummary(pkg.manifest, pkg.provenance)
        let activation: PluginActivationCatalogEntry | undefined
        if (pkg.registryEvidence && isManifestV2(pkg.manifest)) {
          activation = manifestToActivation(pkg.manifest, join(pluginsRoot, pkg.id))
          activation.provenance = 'official-registry'
          activation.artifactDigest = verifiedArtifactDigest
        }
        // `official` was earned in prepareInstall (Host-authorized Official
        // Registry check); it
        // is what allows a verified `navide.` install to claim its reserved id.
        options.onActivationChange?.({ pluginId: pkg.id })
        manager.registerInstalledPackage(summary, descriptor, { official: pkg.official })
        if (publisherRequiresTrust) {
          publisherTrust.trust(pkg.publisherId, pkg.id)
          publisherConsentPersisted = true
        }
        if (activation?.backend) options.onActivationChange?.({ pluginId: pkg.id, activation })
        transaction.finalize()
        prepared.delete(args.id)
        return {
          id: pkg.id,
          requires: summary.requires,
        }
      } catch (error) {
        if (publisherConsentPersisted) {
          try {
            publisherTrust.revoke(pkg.publisherId, pkg.id)
          } catch {
            // Preserve the original install failure if consent cleanup fails.
          }
        }
        try {
          transaction?.rollback()
        } catch {
          // Preserve the original install failure if quarantine/rollback fails.
        }
        cleanupFailedPluginInstall(manager, options.onActivationChange, pkg.id)
        if (previousSummary) {
          try {
            manager.registerInstalledPackage(
              previousSummary,
              previousDescriptor,
              { official: previousSummary.provenance === 'official-registry' }
            )
            if (previousSummary.provenance === 'official-registry') {
              if (previousActivation && previousArtifactDigest) {
                const activation = {
                  ...previousActivation,
                  provenance: 'official-registry' as const,
                  artifactDigest: previousArtifactDigest,
                }
                options.onActivationChange?.({ pluginId: pkg.id, activation })
              }
            }
          } catch {
            // Preserve the original install failure if a manager restoration
            // itself cannot be completed.
          }
        }
        throw error
      }
    }
  )

  ipcMain.handle('plugins:remove', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    const cleanupPluginStorage = options.cleanupPluginStorage
    if (!cleanupPluginStorage) {
      throw new Error('plugin storage cleanup is unavailable')
    }
    // Stop live instances before storage cleanup. The storage adapter drains
    // operations already admitted for this plugin; this phase also prevents
    // new renderer calls from being admitted while cleanup is in progress.
    manager.preparePluginRemoval(id)
    // Storage cleanup is an explicit uninstall operation. If it fails, keep
    // the package and prepared state intact so the caller can retry. The
    // manager deliberately remains registered but stopped until this succeeds.
    await cleanupPluginStorage(id)
    removePlugin(pluginsRoot, id)
    manager.removeInstalledPlugin(id)
    prepared.delete(id)
    options.onActivationChange?.({ pluginId: id })
    return { ok: true }
  })

  return {
    async refreshRegistryTrust() {
      const packageIds = discoverInstalledRegistryPackageIds(pluginsRoot)
      const activeRegistryPackages = new Set(
        manager
          .listInstalledPackages()
          .filter((pkg) => pkg.provenance === 'official-registry')
          .map((pkg) => pkg.id)
      )
      const decisions: Array<{
        pluginId: string
        action: 'allow' | 'quarantine'
        reason?: string
      }> = []
      const safePackageIds = new Set(packageIds)
      for (const pluginId of activeRegistryPackages) {
        if (safePackageIds.has(pluginId)) continue
        // A package that disappeared or no longer has a coherent Host-owned
        // manifest is not a refresh candidate. It is nevertheless an active
        // Registry package in memory and must be stopped before this refresh
        // can return, including when there are no network candidates.
        manager.removeInstalledPlugin(pluginId)
        options.onActivationChange?.({ pluginId })
        decisions.push({
          pluginId,
          action: 'quarantine',
          reason:
            'installed Registry package is missing or has a malformed/identity-mismatched manifest',
        })
      }
      if (packageIds.length === 0) return { decisions, activationCatalog: [] }

      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const fallbackToCachedTrust = () => {
        const snapshot = readRegistryTrustSnapshot(pluginsRoot)
        const refreshed = manager.refreshInstalledPluginTrust(pluginsRoot, {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }, new Set([...packageIds, ...activeRegistryPackages]))
        for (const decision of refreshed) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        return refreshed
      }

      let detail: {
        trust_metadata: RegistryTrustMetadata
        trust_metadata_signature: string
      } | null = null
      let lastRefreshError: Error | null = null
      for (const packageId of packageIds) {
        const [namespace, ...nameParts] = packageId.split('.')
        if (!namespace || nameParts.length === 0) continue
        try {
          const response = await fetch(
            `${base}/api/extensions/${namespace}/${nameParts.join('.')}`
          )
          if (!response.ok) {
            lastRefreshError = new Error(
              `trust metadata refresh failed: HTTP ${response.status}`
            )
            continue
          }
          const candidate = (await response.json()) as {
            trust_metadata: RegistryTrustMetadata
            trust_metadata_signature: string
          }
          verifyRegistryTrustMetadata(
            candidate.trust_metadata,
            candidate.trust_metadata_signature,
            marketplace.trust.pinnedRegistryRootKey,
            marketplace.trust.now
          )
          detail = candidate
          break
        } catch (error) {
          lastRefreshError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!detail) {
        fallbackToCachedTrust()
        throw lastRefreshError ?? new Error('trust metadata refresh failed')
      }

      try {
        const snapshot = {
          schemaVersion: 1 as const,
          metadata: detail.trust_metadata,
          metadataSignature: detail.trust_metadata_signature,
        }
        writeRegistryTrustSnapshot(pluginsRoot, snapshot)
        const currentTrust = {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }
        const activeBeforeRefresh = new Set(
          manager
            .listInstalledPackages()
            .filter((pkg) => pkg.provenance === 'official-registry')
            .map((pkg) => pkg.id)
        )
        const refreshedDecisions = manager.refreshInstalledPluginTrust(
          pluginsRoot,
          currentTrust,
          new Set([...packageIds, ...activeBeforeRefresh])
        )
        for (const decision of refreshedDecisions) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        decisions.push(...refreshedDecisions)
        const restoreIds = new Set(
          refreshedDecisions
            .filter(
              (decision) => decision.action === 'allow' && !activeBeforeRefresh.has(decision.pluginId)
            )
            .map((decision) => decision.pluginId)
        )
        const reloaded =
          restoreIds.size > 0
            ? manager.loadInstalledPlugins(
                pluginsRoot,
                { provenance: 'official-registry', trust: currentTrust },
                restoreIds
              )
            : { activationCatalog: [] }
        return { decisions, activationCatalog: reloaded.activationCatalog }
      } catch (error) {
        fallbackToCachedTrust()
        throw error
      }
    },
  }
}
