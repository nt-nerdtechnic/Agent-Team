import { manifestReferencedFiles as publicManifestReferencedFiles } from '../../../packages/plugin-contracts/src/index'
import { InstalledPluginError } from './pluginManifestErrors'
import { parseManifestJson } from './pluginManifestJson'
import { parseManifestV1, type LegacyInstalledManifest } from './pluginManifestV1'
import { parseManifestV2, type PluginManifestV2, type PluginManifestV2View } from './pluginManifestV2'
import {
  legacyCapabilityPolicy,
  manifestV2CapabilityPolicy,
  type PluginCapabilityPolicy,
} from './pluginPermissions'

export type { LegacyInstalledManifest } from './pluginManifestV1'
export type {
  PluginManifestV2,
  PluginManifestV2Permissions,
  PluginManifestV2View,
} from './pluginManifestV2'
export { InstalledPluginError } from './pluginManifestErrors'
export { parseManifestJson } from './pluginManifestJson'

export type InstalledManifest = PluginManifestV2 | LegacyInstalledManifest

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Dispatch only; format-specific validation lives in pluginManifestV1/V2. */
export function parseInstalledManifest(raw: unknown): InstalledManifest {
  if (!isObject(raw)) throw new InstalledPluginError('manifest must be a JSON object')
  if (
    Object.prototype.hasOwnProperty.call(raw, 'schemaVersion') ||
    Object.prototype.hasOwnProperty.call(raw, 'permissions') ||
    Object.prototype.hasOwnProperty.call(raw, 'marketplace')
  ) {
    return parseManifestV2(raw)
  }
  return parseManifestV1(raw)
}

export function isManifestV2(manifest: InstalledManifest): manifest is PluginManifestV2 {
  return manifest.schemaVersion === 2
}

/** Namespace projection retained for legacy broker/install callers. */
export function manifestCapabilities(manifest: InstalledManifest): string[] {
  if (!isManifestV2(manifest)) return manifest.requires
  return [
    ...(manifest.permissions.system ?? []),
    ...(manifest.permissions.shell ? ['shell'] : []),
  ]
}

export function manifestCapabilityPolicy(manifest: InstalledManifest): PluginCapabilityPolicy {
  return isManifestV2(manifest)
    ? manifestV2CapabilityPolicy(manifest.permissions)
    : legacyCapabilityPolicy(manifest.requires)
}

export function manifestReferencedFiles(manifest: InstalledManifest): string[] {
  if (!isManifestV2(manifest)) return []
  return publicManifestReferencedFiles(manifest)
}

export function assertManifestFiles(manifest: InstalledManifest, availablePaths: Iterable<string>): void {
  const available = new Set(availablePaths)
  for (const path of manifestReferencedFiles(manifest)) {
    if (!available.has(path)) {
      throw new InstalledPluginError(`manifest referenced file is missing: ${path}`)
    }
  }
}
