import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginActivationCatalogEntry } from './installedPlugins'

export interface BackendPluginActivationCatalog {
  schemaVersion: 1
  packages: Array<{
    pluginId: string
    packageVersion: string
    packageDir: string
    provenance: 'official-registry'
    artifactDigest: string
    backend: {
      entryFile: string
      protocolVersion: 1
      activation: 'startup'
    }
  }>
}

export interface BackendPluginActivationCatalogFile {
  path: string
  sha256: string
}

/** Project only Host-verified Registry backend activations. Developer-local,
 * frontend-only, or incomplete records are omitted fail-closed. */
export function projectBackendPluginActivationCatalog(
  entries: readonly PluginActivationCatalogEntry[]
): BackendPluginActivationCatalog {
  return {
    schemaVersion: 1,
    packages: entries.flatMap((entry) => {
      if (
        !entry.backend ||
        entry.provenance !== 'official-registry' ||
        typeof entry.artifactDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.artifactDigest)
      ) {
        return []
      }
      return [
        {
          pluginId: entry.pluginId,
          packageVersion: entry.packageVersion,
          packageDir: entry.packageDir,
          provenance: 'official-registry' as const,
          artifactDigest: entry.artifactDigest,
          backend: {
            entryFile: entry.backend.entryFile,
            protocolVersion: entry.backend.protocolVersion,
            activation: entry.backend.activation,
          },
        },
      ]
    }),
  }
}

/** Write exact catalog bytes owner-only and return the digest bound into the
 * backend child environment. The Python process must reject any byte change. */
export function writeBackendPluginActivationCatalog(
  path: string,
  catalog: BackendPluginActivationCatalog
): BackendPluginActivationCatalogFile {
  const bytes = Buffer.from(JSON.stringify(catalog), 'utf8')
  const temporary = `${path}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
