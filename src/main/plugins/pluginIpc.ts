// IPC surface for the Extensions view: list installed plugins, search the
// marketplace, and drive the verified install / remove flow. The security
// chain lives in `pluginInstaller` (download → digest → signature → scope →
// zip-slip); this module only wires it to `ipcMain` and the loader registry.
//
// Install is two-step so the renderer can interpose a trust confirmation for
// sensitive (fs/terminal) capabilities: `plugins:prepareInstall` downloads +
// verifies and returns the trust facts WITHOUT writing to disk; the renderer
// shows the warning, then `plugins:commitInstall` writes the verified package.
// Download bytes never cross to the renderer — the prepared package is held
// main-side, keyed by id, until commit.

import { app, ipcMain } from 'electron'
import {
  prepareInstall,
  commitInstall,
  removePlugin,
  type PreparedInstall,
} from './pluginInstaller'
import { sensitiveCapabilities, assertRegistryUrlAllowed } from './pluginVerify'
import { formatPermissionGrant } from './pluginPermissions'
import type { FrontendPluginManager } from './frontendPluginManager'

const DEFAULT_MARKETPLACE_URL = 'http://localhost:8787'

/** Resolve the marketplace registry URL, enforcing the transport policy
 *  (production forbids plaintext http except loopback). Throws before any
 *  fetch when the configured URL is disallowed. */
function marketplaceUrl(): string {
  const url = process.env['AGENT_TEAM_MARKETPLACE_URL'] ?? DEFAULT_MARKETPLACE_URL
  assertRegistryUrlAllowed(url, app.isPackaged)
  return url
}

interface InstalledSummary {
  id: string
  requires: string[]
  sensitive: string[]
  grants?: string[]
}

/** Register every `plugins:*` handler exactly once. `pluginsRoot` is where
 *  verified packages are written (`userData/plugins`). */
export function registerPluginIpc(
  manager: FrontendPluginManager,
  pluginsRoot: string
): void {
  // Packages verified by prepareInstall, awaiting a commit, keyed by plugin id.
  const prepared = new Map<string, PreparedInstall>()

  ipcMain.handle('plugins:listInstalled', (): InstalledSummary[] => {
    return manager.listDescriptors().map((d) => {
      const grants =
        d.capabilityPolicy?.kind === 'manifest-v2'
          ? d.capabilityPolicy.grants.map(formatPermissionGrant)
          : []
      return {
        id: d.id,
        requires: d.requires,
        sensitive: sensitiveCapabilities(d.requires),
        ...(grants.length ? { grants } : {}),
      }
    })
  })

  ipcMain.handle('plugins:marketplaceSearch', async (_e, query?: string) => {
    const url = new URL('/api/extensions', marketplaceUrl())
    if (query) url.searchParams.set('q', query)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`marketplace search failed: HTTP ${res.status}`)
    return res.json()
  })

  ipcMain.handle(
    'plugins:prepareInstall',
    async (_e, args: { namespace: string; name: string; version?: string }) => {
      const base = marketplaceUrl().replace(/\/+$/, '')
      const detailRes = await fetch(`${base}/api/extensions/${args.namespace}/${args.name}`)
      if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
      const detail = (await detailRes.json()) as {
        latest_version: string | null
        public_key: string | null
        versions: Array<{
          version: string
          package_digest: string
          signature: string | null
          trust_tier: string
          yanked: boolean
        }>
      }
      const wanted = args.version ?? detail.latest_version
      const versionRow = detail.versions.find((v) => v.version === wanted && !v.yanked)
      if (!versionRow) throw new Error(`no installable version ${wanted ?? '(latest)'} found`)

      // Feed the registry's signature material into the client-side verification
      // chain so a validly-signed package can reach `signed-verified`. The wire
      // is snake_case; `prepareInstall` takes camelCase. Signature is the one on
      // the SELECTED version row (paired with its `package_digest`); the public
      // key is publisher-level (detail top-level). Both may be null — an unsigned
      // package or unregistered key simply resolves to `unsigned` (fail-closed;
      // a bad-but-present signature still hard-blocks in `verifyPackage`).
      const result = await prepareInstall({
        registryUrl: marketplaceUrl(),
        namespace: args.namespace,
        name: args.name,
        version: versionRow.version,
        expectedDigest: versionRow.package_digest,
        signature: versionRow.signature,
        publicKey: detail.public_key,
        claimedTrustTier: versionRow.trust_tier,
      })
      prepared.set(result.id, result)
      return {
        id: result.id,
        version: result.version,
        trustTier: result.trustTier,
        sensitive: result.sensitive,
        requiresConfirmation: result.requiresConfirmation,
        ...(result.grants.length ? { grants: result.grants } : {}),
      }
    }
  )

  ipcMain.handle('plugins:commitInstall', (_e, args: { id: string }) => {
    const pkg = prepared.get(args.id)
    if (!pkg) throw new Error(`no prepared install for ${args.id}; call prepareInstall first`)
    const descriptor = commitInstall(pkg, pluginsRoot)
    // `official` was earned in prepareInstall (pinned-official-key check); it
    // is what allows a verified `navide.` install to claim its reserved id.
    manager.registerDescriptor(descriptor, { official: pkg.official })
    prepared.delete(args.id)
    return { id: descriptor.id, requires: descriptor.requires }
  })

  ipcMain.handle('plugins:remove', (_e, args: { id: string }) => {
    prepared.delete(args.id)
    removePlugin(pluginsRoot, args.id)
    manager.removeInstalledPlugin(args.id)
    return { ok: true }
  })
}
