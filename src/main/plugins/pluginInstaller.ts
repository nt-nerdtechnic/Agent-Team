// Plugin install / update / remove orchestration for the main process.
//
// The security-critical chain (download → digest → signature → capability
// scope → zip-slip-guarded unpack) is delegated to the pure, unit-tested
// `pluginVerify` + `pluginPackage` + `installedPlugins` modules; this file is
// the thin I/O shell that wires them to the network and the filesystem. Every
// side-effecting dependency (network download, fs writes) is injectable so the
// whole flow can be driven in tests without a real registry or disk.
//
// Install is split into prepare → commit so the UI can interpose a trust
// confirmation (sensitive `fs`/`aiCli`/`shell` capabilities) AFTER verification but
// BEFORE anything is written to disk.

import { chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalArchivePath, portableArchiveCollisionKey } from './pluginPathPolicy'
import {
  verifyPackage,
  assertSafeArchiveEntries,
  assertOfficialPublisher,
  isOfficialPluginId,
  resolveOfficialPublisherKey,
  PluginVerifyError,
  TRUST_SIGNED,
  type TrustTier,
} from './pluginVerify'
import {
  verifyRegistryPackageTrust,
  type RegistryAuthority,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  assertRegistryTrustSnapshotDoesNotRollback,
  registryReceiptFromEvidence,
  writeRegistryTrustSnapshot,
  type RegistryInstallReceipt,
  type RegistryTrustSnapshot,
} from './pluginInstalledTrust'
import { readZipEntries, readManifestFromEntries, type ZipEntry } from './pluginPackage'
import {
  parseInstalledManifest,
  assertManifestFiles,
  isManifestV2,
  manifestCapabilities,
  manifestToDescriptor,
  OFFICIAL_RECEIPT_NAME,
  type InstalledManifest,
  type OfficialReceipt,
} from './installedPlugins'
import { compareSemver } from './pluginManifestV2'
import type { PluginLaunchDescriptor } from './frontendPluginManager'

/** What a caller must supply to install a specific marketplace version. The
 *  trusted `expectedDigest` and (optional) signature material come from the
 *  registry's extension-detail API, fetched by the caller before installing. */
export interface InstallRequest {
  registryUrl: string
  namespace: string
  name: string
  version: string
  /** sha256 hex from the version's `package_digest` (trusted metadata). */
  expectedDigest: string
  /** Detached base64 Ed25519 signature, when available (else omitted). */
  signature?: string | null
  /** Publisher PEM public key, when available (else omitted). */
  publicKey?: string | null
  /** Trust tier the registry recorded (`signed-verified`/`unsigned`). */
  claimedTrustTier?: string | null
  /** Registry-selected artifact target bound into the signed envelope. */
  target?: string | null
  /** Registry-owned signing evidence for Manifest v2 packages. */
  registryEnvelope?: RegistryPackageEnvelope | null
  registrySignature?: string | null
  trustMetadata?: RegistryTrustMetadata | null
  trustMetadataSignature?: string | null
}

export interface InstallerTrustConfig {
  /** Host-owned root pin. It is never accepted from a package or registry response. */
  pinnedRegistryRootKey: string | null
  /** Host-derived authority. Registry response metadata cannot upgrade this. */
  registryAuthority?: RegistryAuthority
  /** Normalized App-pinned Official Registry URL, when configured. */
  officialRegistryUrl?: string
  now?: Date
}

const DEFAULT_INSTALLER_TRUST: InstallerTrustConfig = {
  pinnedRegistryRootKey: null,
  registryAuthority: 'self-hosted',
}

const HOST_OWNED_ARCHIVE_NAMES = new Set([
  OFFICIAL_RECEIPT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  '.navide-backend-activation.json',
].map((name) => portableArchiveCollisionKey(name)!))

/** A downloaded, verified package ready to commit to disk. */
export interface PreparedInstall {
  id: string
  version: string
  publisherId: string
  manifest: InstalledManifest
  entries: ZipEntry[]
  trustTier: TrustTier
  sensitive: string[]
  /** True when the verified package contains a declared backend executable. */
  containsBackendExecutable: boolean
  /** True when the plugin declares a sensitive capability or contains native
   *  backend code and the UI must obtain confirmation before commit. */
  requiresConfirmation: boolean
  /** True only for a `navide.` package that passed the Host-authorized
   *  Official Registry gate (or the legacy v1 publisher pin). Drives trusted
   *  registration without treating a self-hosted Registry as first-party. */
  official: boolean
  /** Verified sha256 hex digest of the package bytes (receipt material). */
  digest: string
  /** Detached signature over the digest, when present (receipt material). */
  signature: string | null
  /** Host-generated Registry evidence retained for every marketplace v2
   * package. Never feed this envelope signature into the legacy digest receipt. */
  registryEvidence?: {
    artifact: Uint8Array
    receipt: RegistryInstallReceipt
    trustSnapshot: RegistryTrustSnapshot
  }
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

/** Injectable side-effects (network + filesystem) so the flow is testable. */
export interface InstallerDeps {
  /** Fetch a package blob + the registry's `X-Package-Digest` header. */
  download(url: string): Promise<{ bytes: Uint8Array; digestHeader: string | null }>
  mkdirp(dir: string): void
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array | null
  /** Atomic Host-owned Registry trust snapshot persistence. */
  writeRegistryTrustSnapshot?: typeof writeRegistryTrustSnapshot
  /** Apply a controlled mode after writing the declared backend executable. */
  chmod(path: string, mode: number): void
  rmrf(dir: string): void
}

/** Default deps: global `fetch` (Electron main / Node 18+) + `node:fs`. */
export const defaultInstallerDeps: InstallerDeps = {
  async download(url) {
    const res = await fetch(url)
    if (!res.ok) throw new InstallError(`download failed: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { bytes, digestHeader: res.headers.get('x-package-digest') }
  },
  mkdirp(dir) {
    mkdirSync(dir, { recursive: true })
  },
  writeFile(path, data) {
    writeFileSync(path, data)
  },
  readFile(path) {
    try {
      return new Uint8Array(readFileSync(path))
    } catch {
      return null
    }
  },
  writeRegistryTrustSnapshot,
  chmod(path, mode) {
    chmodSync(path, mode)
  },
  rmrf(dir) {
    rmSync(dir, { recursive: true, force: true })
  },
}

function downloadUrl(req: InstallRequest): string {
  const base = req.registryUrl.replace(/\/+$/, '')
  return `${base}/api/extensions/${req.namespace}/${req.name}/${req.version}/download`
}

function canonicalEntryPath(entry: ZipEntry): string {
  const path = canonicalArchivePath(
    entry.path,
    entry.type === 'directory' ? 'directory' : 'regular'
  )
  if (path === null) throw new InstallError(`unsafe archive entry path: ${entry.path}`)
  return path
}

function startsWithExecutableShebang(data: Uint8Array): boolean {
  const offset = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0
  return data[offset] === 0x23 && data[offset + 1] === 0x21
}

/** Validate the narrow Issue 02 POSIX executable contract. Exact binary
 * format and OS/architecture validation remain owned by Issue 27. */
function assertBackendExecutable(
  manifest: InstalledManifest,
  entries: readonly ZipEntry[]
): string | undefined {
  if (!isManifestV2(manifest) || !manifest.backend) return undefined
  const backendPath = manifest.backend.entry
  const entry = entries.find(
    (candidate) =>
      candidate.type === 'regular' && canonicalEntryPath(candidate) === backendPath
  )
  if (!entry) {
    throw new InstallError(`backend entry is missing or not a regular file: ${backendPath}`)
  }
  if (entry.data.length === 0) {
    throw new InstallError(`backend entry is empty: ${backendPath}`)
  }
  if (!entry.executable) {
    throw new InstallError(`backend entry is not marked executable: ${backendPath}`)
  }
  if (startsWithExecutableShebang(entry.data)) {
    throw new InstallError(
      `backend entry must be a packaged executable, not a raw script: ${backendPath}`
    )
  }
  return backendPath
}

/**
 * Download + fully verify a package WITHOUT writing anything. Runs the digest,
 * signature, and capability-scope checks, cross-checks the identity, and reads
 * the manifest. Throws on any verification failure. On success returns the
 * decoded entries and the trust facts the UI gates on.
 */
export async function prepareInstall(
  req: InstallRequest,
  deps: InstallerDeps = defaultInstallerDeps,
  trust: InstallerTrustConfig = DEFAULT_INSTALLER_TRUST
): Promise<PreparedInstall> {
  const { bytes, digestHeader } = await deps.download(downloadUrl(req))

  // The download's advertised digest, when present, must match the trusted
  // metadata digest — a mismatch means the blob was swapped mid-flight.
  if (digestHeader && digestHeader !== req.expectedDigest) {
    throw new InstallError(
      `download digest header ${digestHeader} does not match expected ${req.expectedDigest}`
    )
  }

  // Validate every archive path before reading the manifest or any later install step.
  const entries = readZipEntries(bytes)
  assertSafeArchiveEntries(entries)
  const rawManifest = readManifestFromEntries(entries)
  const manifest = parseInstalledManifest(rawManifest)
  assertManifestFiles(
    manifest,
    entries
      .filter((entry) => entry.type === 'regular')
      .map((entry) => canonicalEntryPath(entry))
  )
  const backendEntry = assertBackendExecutable(manifest, entries)
  const expectedId = `${req.namespace}.${req.name}`
  if (manifest.id !== expectedId) {
    throw new InstallError(
      `package identity ${manifest.id} does not match requested ${expectedId}`
    )
  }
  if (manifest.version !== req.version) {
    throw new InstallError(
      `package version ${manifest.version} does not match requested ${req.version}`
    )
  }

  const v2 = isManifestV2(manifest)
  const packageVerification = verifyPackage({
    bytes,
    expectedDigest: req.expectedDigest,
    // Publisher keys and signatures are a legacy v1 compatibility path. A v2
    // package cannot self-supply the key that establishes its own trust.
    signature: v2 ? null : req.signature,
    publicKey: v2 ? null : req.publicKey,
    claimedTrustTier: req.claimedTrustTier,
    requires: manifestCapabilities(manifest),
  })
  let trustTier = packageVerification.trustTier
  let registryEvidence: PreparedInstall['registryEvidence']
  let official = false

  if (v2) {
    if (!req.registryEnvelope || !req.trustMetadata || !req.target) {
      throw new PluginVerifyError(
        'SIGNATURE_REQUIRED',
        `plugin '${manifest.id}' is missing registry signing evidence`
      )
    }
    const envelopeSignature = req.registrySignature
    const trustMetadataSignature = req.trustMetadataSignature
    if (!envelopeSignature || !trustMetadataSignature) {
      throw new PluginVerifyError(
        'SIGNATURE_REQUIRED',
        `plugin '${manifest.id}' is missing Registry signatures`
      )
    }
    verifyRegistryPackageTrust({
      envelope: req.registryEnvelope,
      envelopeSignature,
      trustMetadata: req.trustMetadata,
      trustMetadataSignature,
      pinnedRootKey: trust.pinnedRegistryRootKey,
      expected: {
        artifactDigest: packageVerification.digest,
        packageId: manifest.id,
        version: manifest.version,
        target: req.target,
        publisherId: manifest.publisher,
      },
      now: trust.now,
    })
    const requestedRegistryUrl = new URL(req.registryUrl).toString().replace(/\/+$/, '')
    const officialRegistryUrl = trust.officialRegistryUrl
      ? new URL(trust.officialRegistryUrl).toString().replace(/\/+$/, '')
      : null
    official =
      isOfficialPluginId(manifest.id) &&
      trust.registryAuthority === 'official' &&
      officialRegistryUrl !== null &&
      requestedRegistryUrl === officialRegistryUrl &&
      req.trustMetadata.registryProfile === 'official'
    if (isOfficialPluginId(manifest.id) && !official) {
      throw new PluginVerifyError(
        'NOT_OFFICIAL',
        `plugin '${manifest.id}' claims the official 'navide.' namespace but the Host did not authorize the Official Registry`
      )
    }
    trustTier = TRUST_SIGNED
    registryEvidence = {
      artifact: bytes,
      receipt: registryReceiptFromEvidence({
        packageId: manifest.id,
        version: manifest.version,
        publisherId: manifest.publisher,
        target: req.target,
        artifactDigest: packageVerification.digest,
        envelope: req.registryEnvelope,
        envelopeSignature,
        registryAuthority: trust.registryAuthority ?? 'self-hosted',
      }),
      trustSnapshot: {
        schemaVersion: 1,
        metadata: req.trustMetadata,
        metadataSignature: trustMetadataSignature,
      },
    }
  }

  if (v2 && trustTier !== TRUST_SIGNED) {
    throw new PluginVerifyError(
      'SIGNATURE_REQUIRED',
      `plugin '${manifest.id}' is unsigned; Manifest v2 marketplace installs require a registry signature`
    )
  }

  // The v2 Registry envelope binds publisherId to packageId before this point.
  // Keep the publisher-key check only for the bounded v1 compatibility path.
  if (!v2) {
    assertOfficialPublisher(manifest.id, req.publicKey, trustTier, resolveOfficialPublisherKey())
    official = isOfficialPluginId(manifest.id)
  }

  return {
    id: manifest.id,
    version: manifest.version,
    publisherId: isManifestV2(manifest) ? manifest.publisher : manifest.id.split('.')[0],
    manifest,
    entries,
    trustTier,
    sensitive: packageVerification.sensitive,
    containsBackendExecutable: backendEntry !== undefined,
    requiresConfirmation:
      packageVerification.sensitive.length > 0 || backendEntry !== undefined,
    official,
    digest: packageVerification.digest,
    signature: v2 ? req.registrySignature ?? null : req.signature ?? null,
    registryEvidence,
  }
}

/**
 * Write a prepared, verified package into `<pluginsRoot>/<id>/`, replacing any
 * previous install of the same id (so update reuses this path). The archive is
 * revalidated before the existing directory is removed. Returns the frontend
 * launch descriptor when the package contributes views; backend-only packages
 * return undefined and are discovered through the activation catalog.
 */
export function commitInstall(
  prepared: PreparedInstall,
  pluginsRoot: string,
  deps: InstallerDeps = defaultInstallerDeps
): PluginLaunchDescriptor | undefined {
  const dir = join(pluginsRoot, prepared.id)
  assertSafeArchiveEntries(prepared.entries)
  const safeEntries = prepared.entries.map((entry) => ({
    entry,
    path: canonicalEntryPath(entry),
  }))
  const smuggledHostFile = safeEntries.find(({ path }) => {
    const collisionKey = portableArchiveCollisionKey(path)
    return collisionKey !== null && HOST_OWNED_ARCHIVE_NAMES.has(collisionKey)
  })
  if (smuggledHostFile) {
    throw new InstallError(`package must not contain ${smuggledHostFile.path}`)
  }
  const backendEntry = assertBackendExecutable(prepared.manifest, prepared.entries)
  const descriptor =
    isManifestV2(prepared.manifest) && prepared.manifest.contributes === undefined
      ? undefined
      : manifestToDescriptor(prepared.manifest, dir)
  const trustSnapshotPath = join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME)
  if (prepared.registryEvidence) {
    assertRegistryTrustSnapshotDoesNotRollback(
      deps.readFile(trustSnapshotPath),
      prepared.registryEvidence.trustSnapshot
    )
  }
  deps.rmrf(dir) // idempotent replace (fresh install or update)
  for (const { entry, path } of safeEntries) {
    const target = join(dir, path)
    if (entry.type === 'directory') {
      deps.mkdirp(target)
    } else if (entry.type === 'regular') {
      deps.mkdirp(dirname(target))
      deps.writeFile(target, entry.data)
      if (path === backendEntry) deps.chmod(target, 0o700)
    } else {
      throw new InstallError(`archive entry is not a regular file: ${entry.path}`)
    }
  }
  // Official installs persist the verified digest + signature so the loader
  // can re-verify against the pinned key on every startup (see
  // `verifyOfficialInstall` in installedPlugins.ts).
  if (prepared.registryEvidence) {
    deps.mkdirp(dir)
    deps.writeFile(join(dir, REGISTRY_ARTIFACT_NAME), prepared.registryEvidence.artifact)
    deps.writeFile(
      join(dir, REGISTRY_RECEIPT_NAME),
      new TextEncoder().encode(JSON.stringify(prepared.registryEvidence.receipt, null, 2))
    )
    const writeTrustSnapshot = deps.writeRegistryTrustSnapshot ?? writeRegistryTrustSnapshot
    writeTrustSnapshot(pluginsRoot, prepared.registryEvidence.trustSnapshot)
  } else if (prepared.official && prepared.signature) {
    const receipt: OfficialReceipt = {
      id: prepared.id,
      version: prepared.version,
      digest: prepared.digest,
      signature: prepared.signature,
    }
    deps.mkdirp(dir)
    deps.writeFile(
      join(dir, OFFICIAL_RECEIPT_NAME),
      new TextEncoder().encode(JSON.stringify(receipt, null, 2))
    )
  }
  return descriptor
}

/** Remove an installed plugin's directory. Idempotent. */
export function removePlugin(
  pluginsRoot: string,
  id: string,
  deps: InstallerDeps = defaultInstallerDeps
): void {
  deps.rmrf(join(pluginsRoot, id))
}

/**
 * Whether `latestVersion` is a strictly-newer semver than `installedVersion`.
 * Used to surface an update in the Extensions view. Non-semver inputs return
 * false (no false-positive update prompts).
 */
export function isUpdateAvailable(installedVersion: string, latestVersion: string | null): boolean {
  if (!latestVersion) return false
  const comparison = compareSemver(installedVersion, latestVersion)
  return comparison !== null && comparison < 0
}
