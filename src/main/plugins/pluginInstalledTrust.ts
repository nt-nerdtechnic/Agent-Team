import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  parseInstalledManifest,
  parseManifestJson,
} from './pluginManifest'
import { readManifestFromEntries, readZipEntries } from './pluginPackage'
import {
  verifyRegistryPackageTrust,
  type RegistryAuthority,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { assertSafeArchiveEntries, sha256Hex } from './pluginVerify'
import {
  assertExactTrustFields,
  parseHostTrustJsonObject,
  readHostTrustJsonObject,
  requireTrustObject,
} from './pluginTrustJson'
import { currentPluginHostTarget } from './pluginTarget'
import type { InstalledManifest } from './pluginManifest'
import { PLUGIN_QUARANTINE_MARKER } from './pluginInstallPaths'

export const REGISTRY_RECEIPT_NAME = '.navide-registry-receipt.json'
export const REGISTRY_ARTIFACT_NAME = '.navide-package.zip'
export const REGISTRY_TRUST_SNAPSHOT_NAME = '.navide-registry-trust.json'

export interface RegistryInstallReceipt {
  schemaVersion: 1
  provenance: 'official-registry'
  registryAuthority: RegistryAuthority
  packageId: string
  version: string
  publisherId: string
  target: string
  artifactDigest: string
  envelope: RegistryPackageEnvelope
  envelopeSignature: string
}

export interface RegistryTrustSnapshot {
  schemaVersion: 1
  metadata: RegistryTrustMetadata
  metadataSignature: string
}

export interface InstalledRegistryTrustContext {
  pinnedRootKey: string | null
  snapshot: RegistryTrustSnapshot | null
  registryAuthority?: RegistryAuthority
  officialRegistryUrl?: string
  /** Host-derived target expected during every load/refresh revalidation. */
  expectedTarget?: string
  now?: Date
}

export type InstalledTrustDecision =
  | { action: 'allow'; artifactDigest: string }
  | { action: 'quarantine'; reason: string }

export function assertRegistryTrustSnapshotDoesNotRollback(
  existingBytes: Uint8Array | null,
  next: RegistryTrustSnapshot
): void {
  if (!existingBytes) return
  try {
    const existing = parseTrustSnapshot(
      parseHostTrustJsonObject(
        new TextDecoder().decode(existingBytes),
        'Registry trust snapshot'
      )
    )
    const existingGeneratedAt = Date.parse(existing.metadata.generatedAt)
    const nextGeneratedAt = Date.parse(next.metadata.generatedAt)
    if (
      Number.isFinite(existingGeneratedAt) &&
      Number.isFinite(nextGeneratedAt) &&
      existingGeneratedAt > nextGeneratedAt
    ) {
      throw new Error('refusing to replace Registry trust metadata with an older snapshot')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('older snapshot')) throw error
    // A malformed cache is not a trust source; a new root-verified snapshot repairs it.
  }
}

function parseReceipt(pluginDir: string): RegistryInstallReceipt {
  const raw = readHostTrustJsonObject(
    join(pluginDir, REGISTRY_RECEIPT_NAME),
    REGISTRY_RECEIPT_NAME
  )
  assertExactTrustFields(raw, REGISTRY_RECEIPT_NAME, [
    'schemaVersion',
    'provenance',
    'registryAuthority',
    'packageId',
    'version',
    'publisherId',
    'target',
    'artifactDigest',
    'envelope',
    'envelopeSignature',
  ])
  if (
    raw.schemaVersion !== 1 ||
    raw.provenance !== 'official-registry' ||
    (raw.registryAuthority !== 'official' && raw.registryAuthority !== 'self-hosted') ||
    typeof raw.packageId !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.publisherId !== 'string' ||
    typeof raw.target !== 'string' ||
    typeof raw.artifactDigest !== 'string' ||
    typeof raw.envelopeSignature !== 'string' ||
    raw.envelope === null ||
    typeof raw.envelope !== 'object' ||
    Array.isArray(raw.envelope)
  ) {
    throw new Error(`malformed ${REGISTRY_RECEIPT_NAME}`)
  }
  return raw as unknown as RegistryInstallReceipt
}

function parseTrustSnapshot(raw: Record<string, unknown>): RegistryTrustSnapshot {
  assertExactTrustFields(raw, REGISTRY_TRUST_SNAPSHOT_NAME, [
    'schemaVersion',
    'metadata',
    'metadataSignature',
  ])
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.metadataSignature !== 'string'
  ) {
    throw new Error(`malformed ${REGISTRY_TRUST_SNAPSHOT_NAME}`)
  }
  requireTrustObject(raw.metadata, `${REGISTRY_TRUST_SNAPSHOT_NAME}.metadata`)
  return raw as unknown as RegistryTrustSnapshot
}

function archiveManifest(bytes: Uint8Array): InstalledManifest {
  const entries = readZipEntries(bytes)
  assertSafeArchiveEntries(entries)
  const manifest = parseInstalledManifest(readManifestFromEntries(entries))
  return manifest
}

function installedManifest(pluginDir: string): InstalledManifest {
  const manifest = parseInstalledManifest(
    parseManifestJson(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'))
  )
  return manifest
}

function listExtractedFiles(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute).split(sep).join('/')
      if (rel === REGISTRY_RECEIPT_NAME || rel === REGISTRY_ARTIFACT_NAME) continue
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`installed package contains symlink: ${rel}`)
      if (stat.isDirectory()) visit(absolute)
      else if (stat.isFile()) files.push(rel)
      else throw new Error(`installed package contains unsafe entry: ${rel}`)
    }
  }
  visit(root)
  return files.sort()
}

function assertExtractedContent(pluginDir: string, archiveBytes: Uint8Array): void {
  const entries = readZipEntries(archiveBytes)
  assertSafeArchiveEntries(entries)
  const archivedFiles = entries
    .filter((entry) => entry.type === 'regular')
    .map((entry) => entry.path)
    .sort()
  const installedFiles = listExtractedFiles(pluginDir)
  if (JSON.stringify(installedFiles) !== JSON.stringify(archivedFiles)) {
    throw new Error('installed package file set does not match retained Registry artifact')
  }
  for (const entry of entries) {
    if (entry.type !== 'regular') continue
    const installed = readFileSync(join(pluginDir, entry.path))
    if (!installed.equals(Buffer.from(entry.data))) {
      throw new Error(`installed package file was modified: ${entry.path}`)
    }
  }
}

/**
 * Fail-closed activation/spawn verifier for an installed Registry package.
 * The caller must supply the current root-signed trust snapshot; the receipt
 * is evidence, never a trust root or a cached "trusted" flag.
 */
export function verifyInstalledRegistryPackage(
  pluginDir: string,
  expectedPackageId: string,
  trust: InstalledRegistryTrustContext
): InstalledTrustDecision {
  try {
    if (!trust.snapshot) throw new Error('current Registry trust metadata is unavailable')
    const receipt = parseReceipt(pluginDir)
    const archiveBytes = new Uint8Array(readFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME)))
    const digest = sha256Hex(archiveBytes)
    const manifest = archiveManifest(archiveBytes)
    const publisherId = manifest.publisher ?? manifest.id.split('.')[0]
    if (
      receipt.packageId !== expectedPackageId ||
      receipt.packageId !== manifest.id ||
      receipt.version !== manifest.version ||
      receipt.publisherId !== publisherId ||
      receipt.artifactDigest !== digest
    ) {
      throw new Error('Registry receipt identity does not match the retained artifact')
    }
    verifyRegistryPackageTrust({
      envelope: receipt.envelope,
      envelopeSignature: receipt.envelopeSignature,
      trustMetadata: trust.snapshot.metadata,
      trustMetadataSignature: trust.snapshot.metadataSignature,
      pinnedRootKey: trust.pinnedRootKey,
      expected: {
        artifactDigest: digest,
        packageId: manifest.id,
        version: manifest.version,
        target: receipt.target,
        publisherId,
      },
      expectedHostTarget: trust.expectedTarget ?? currentPluginHostTarget(),
      now: trust.now,
    })
    if (receipt.registryAuthority !== (trust.registryAuthority ?? 'self-hosted')) {
      throw new Error('Registry authority does not match the current Host configuration')
    }
    assertExtractedContent(pluginDir, archiveBytes)
    return { action: 'allow', artifactDigest: digest }
  } catch (error) {
    return {
      action: 'quarantine',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Discover refresh candidates from retained Host evidence without treating
 * the package as active or trusted. The identity must agree across the direct
 * child directory, Host receipt, and validated retained v1/v2 manifest. */
export function discoverInstalledRegistryPackageIds(pluginsRoot: string): string[] {
  const packageIds = new Set<string>()
  let entries: Dirent[]
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(pluginsRoot, entry.name)
    try {
      if (existsSync(join(pluginDir, PLUGIN_QUARANTINE_MARKER))) continue
      const receipt = parseReceipt(pluginDir)
      const installed = installedManifest(pluginDir)
      const manifest = archiveManifest(
        new Uint8Array(readFileSync(join(pluginDir, REGISTRY_ARTIFACT_NAME)))
      )
      if (
        receipt.packageId !== entry.name ||
        installed.id !== entry.name ||
        manifest.id !== entry.name ||
        installed.version !== manifest.version ||
        (installed.publisher ?? installed.id.split('.')[0]) !==
          (manifest.publisher ?? manifest.id.split('.')[0])
      ) {
        continue
      }
      packageIds.add(entry.name)
    } catch {
      // A malformed/tampered package is not a refresh candidate and remains inactive.
    }
  }
  return [...packageIds].sort()
}

export function readRegistryTrustSnapshot(pluginsRoot: string): RegistryTrustSnapshot | null {
  try {
    return parseTrustSnapshot(
      readHostTrustJsonObject(
        join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME),
        REGISTRY_TRUST_SNAPSHOT_NAME
      )
    )
  } catch {
    return null
  }
}

/** Persist a root-signed snapshot atomically. Registry refresh can call this
 * seam before asking the manager to re-evaluate running packages. */
export function writeRegistryTrustSnapshot(
  pluginsRoot: string,
  snapshot: RegistryTrustSnapshot
): void {
  mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 })
  const path = join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME)
  const temporary = `${path}.tmp`
  let existing: Uint8Array | null = null
  try {
    existing = new Uint8Array(readFileSync(path))
  } catch {
    // No prior snapshot.
  }
  assertRegistryTrustSnapshotDoesNotRollback(existing, snapshot)
  writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  renameSync(temporary, path)
}

export function registryReceiptFromEvidence(input: {
  packageId: string
  version: string
  publisherId: string
  target: string
  artifactDigest: string
  envelope: RegistryPackageEnvelope
  envelopeSignature: string
  registryAuthority?: RegistryAuthority
}): RegistryInstallReceipt {
  return {
    schemaVersion: 1,
    provenance: 'official-registry',
    ...input,
    registryAuthority: input.registryAuthority ?? 'self-hosted',
  }
}
