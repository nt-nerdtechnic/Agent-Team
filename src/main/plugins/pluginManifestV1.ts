import {
  assertKnownCapabilities,
  assertSafeEntryPath,
  PluginVerifyError,
} from './pluginVerify'
import { InstalledPluginError } from './pluginManifestErrors'
import { isValidManifestV2PluginId } from './pluginManifestV2'

const SEMVER_RE = /^\d+\.\d+\.\d+$/

export type LegacyInstalledManifest = {
  schemaVersion?: never
  id: string
  version: string
  /** Registry v1 packages may carry the publisher identity; old local files may not. */
  publisher?: string
  requires: string[]
  entry: string
}

/** Parse the pre-schemaVersion internal manifest format. */
export function parseManifestV1(raw: Record<string, unknown>): LegacyInstalledManifest {
  const id = raw.id
  if (typeof id !== 'string' || !isValidManifestV2PluginId(id)) {
    throw new InstalledPluginError(
      `manifest id must be '<publisher>.<name>' lowercase, got ${String(id)}`
    )
  }
  const version = raw.version
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new InstalledPluginError(`manifest version must be semver, got ${String(version)}`)
  }
  const entry = raw.entry
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new InstalledPluginError(`manifest ${id} has no 'entry' (frontend bundle path)`)
  }
  try {
    assertSafeEntryPath(entry)
  } catch (error) {
    if (error instanceof PluginVerifyError) {
      throw new InstalledPluginError(`manifest ${id} has unsafe entry path: ${entry}`)
    }
    throw error
  }
  const requires = Array.isArray(raw.requires) ? raw.requires.map(String) : []
  if (requires.includes('storage')) {
    throw new InstalledPluginError("legacy manifests cannot declare unsupported capability 'storage'")
  }
  try {
    assertKnownCapabilities(requires)
  } catch (error) {
    if (error instanceof PluginVerifyError) throw new InstalledPluginError(error.message)
    throw error
  }
  const publisher = raw.publisher
  if (publisher !== undefined && (typeof publisher !== 'string' || publisher.length === 0)) {
    throw new InstalledPluginError(`manifest ${id} has an invalid publisher`)
  }
  return { id, version, ...(publisher !== undefined ? { publisher } : {}), requires, entry }
}
