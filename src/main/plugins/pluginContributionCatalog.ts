import type { PluginLaunchDescriptor } from './frontendPluginManager'

export type PluginContributionLocation =
  | 'top'
  | 'bottom'
  | 'right'
  | 'left'
  | 'main'
  | 'window'

/** Public Host discovery record. It deliberately contains no live instance
 * identity; instance handles remain entirely inside the main process. */
export interface PluginContributionCatalogEntry {
  pluginId: string
  packageVersion: string | null
  contributionKey: string
  title: string
  /** Host-only, verified on-disk identity. IPC must project this to safe bytes. */
  iconFile: string | null
  kind: 'custom'
  location: PluginContributionLocation
  manifestOrder: number
}

/** Build deterministic navigation metadata from the active descriptor table.
 * Package id is the primary ordering key; manifest order is the stable tie
 * breaker within a package. */
export function buildPluginContributionCatalog(
  descriptors: readonly PluginLaunchDescriptor[],
): PluginContributionCatalogEntry[] {
  return descriptors
    .flatMap((descriptor) =>
      (descriptor.views ?? []).map((view, manifestOrder) => ({
        pluginId: descriptor.id,
        packageVersion: descriptor.packageVersion ?? null,
        contributionKey: view.contributionKey,
        title: view.title,
        iconFile: view.iconFile ?? null,
        kind: view.kind,
        location: view.location,
        manifestOrder,
      }))
    )
    .sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId) || left.manifestOrder - right.manifestOrder
    )
}
