import {
  compareSemver as comparePublicSemver,
  isValidManifestV2PluginId as isPublicManifestV2PluginId,
  parseManifestV2 as parsePublicManifestV2,
  PluginContractError,
  V2_SHELL_MODES,
  V2_SYSTEM_NAMESPACES,
  V2_VIEW_LOCATIONS,
  type PluginManifestV2,
  type PluginManifestV2Permissions,
  type PluginManifestV2View,
  type PluginShellMode,
  type PluginSystemNamespace,
} from '../../../packages/plugin-contracts/src/index'
import { InstalledPluginError } from './pluginManifestErrors'

export {
  V2_SHELL_MODES,
  V2_SYSTEM_NAMESPACES,
  V2_VIEW_LOCATIONS,
}
export type {
  PluginManifestV2,
  PluginManifestV2Permissions,
  PluginManifestV2View,
  PluginShellMode,
  PluginSystemNamespace,
}

/** Return whether a value is a canonical Manifest v2 package id. */
export function isValidManifestV2PluginId(value: unknown): value is string {
  return isPublicManifestV2PluginId(value)
}

/** Compare SemVer precedence using the public contract implementation. */
export function compareSemver(left: string, right: string): number | null {
  return comparePublicSemver(left, right)
}

/**
 * Host adapter preserving the Host error type while delegating all Manifest v2
 * validation to the public contracts package.
 */
export function parseManifestV2(raw: Record<string, unknown>): PluginManifestV2 {
  try {
    return parsePublicManifestV2(raw)
  } catch (error) {
    if (error instanceof PluginContractError) {
      throw new InstalledPluginError(error.message)
    }
    throw error
  }
}
