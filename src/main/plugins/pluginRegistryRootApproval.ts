import { createHash, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertExactTrustFields,
  readHostTrustJsonObject,
} from './pluginTrustJson'
import type { RegistryAuthority } from './pluginRegistryTrust'
import { OFFICIAL_PUBLISHER_KEY_PEM, publicKeysEqual } from './pluginVerify'

interface RegistryRootApprovalDocument {
  schemaVersion: 1
  registryUrl: string
  rootPublicKeyPem: string
  confirmedFingerprint: string
}

const OFFICIAL_REGISTRY_ROOT_RESOURCE = join(
  'resources',
  'official-registry-root.pem'
)

/** Read the independent Official Registry root from the App's packaged
 * resources. A missing, malformed, non-Ed25519, or publisher-key file is
 * treated as unprovisioned. The resourcesPath argument is the test seam; the
 * runtime caller supplies Electron's process.resourcesPath. */
export function loadOfficialRegistryRootKey(
  resourcesPath: string = process.resourcesPath
): string | null {
  try {
    const publicKey = createPublicKey(
      readFileSync(join(resourcesPath, OFFICIAL_REGISTRY_ROOT_RESOURCE), 'utf8').trim()
    )
    if (publicKey.asymmetricKeyType !== 'ed25519') return null

    const normalizedPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    if (publicKeysEqual(normalizedPem, OFFICIAL_PUBLISHER_KEY_PEM)) return null
    return normalizedPem
  } catch {
    return null
  }
}

function normalizedUrl(value: string): string {
  const parsed = new URL(value)
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

export function registryRootFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return `sha256:${createHash('sha256').update(der).digest('hex')}`
}

/** Resolve trust before contacting a Registry. The normal App-configured URL
 * always uses the build pin. The local development default is a separate
 * self-hosted endpoint and requires an explicit, durable operator-owned
 * approval file; response metadata is never consulted. */
export function resolveMarketplaceRegistryRoot(input: {
  registryUrlOverride?: string
  defaultRegistryUrl: string
  /** The normalized URL identity of the Registry whose root is shipped in the App. */
  officialRegistryUrl?: string
  officialRootPublicKey: string | null
  approvalFile?: string
}): {
  registryUrl: string
  rootPublicKey: string
  fingerprint: string
  source: 'app' | 'user'
  authority: RegistryAuthority
} {
  const defaultRegistryUrl = normalizedUrl(input.defaultRegistryUrl)
  // Keep the old call shape safe for callers that have one default URL. App
  // wiring supplies this separately so localhost cannot inherit the official
  // build pin merely because it is the development default.
  const officialRegistryUrl = normalizedUrl(input.officialRegistryUrl ?? input.defaultRegistryUrl)
  const requestedRegistryUrl =
    input.registryUrlOverride === undefined
      ? defaultRegistryUrl
      : normalizedUrl(input.registryUrlOverride)
  if (requestedRegistryUrl === officialRegistryUrl) {
    if (!input.officialRootPublicKey) {
      throw new Error('Official Registry root is not provisioned in this build')
    }
    return {
      registryUrl: officialRegistryUrl,
      rootPublicKey: input.officialRootPublicKey,
      fingerprint: registryRootFingerprint(input.officialRootPublicKey),
      source: 'app',
      authority: 'official',
    }
  }
  if (!input.approvalFile) {
    throw new Error('custom marketplace Registry requires an explicit root approval file')
  }
  let approval: RegistryRootApprovalDocument
  try {
    const raw = readHostTrustJsonObject(
      input.approvalFile,
      'custom marketplace Registry root approval file'
    )
    assertExactTrustFields(raw, 'custom marketplace Registry root approval file', [
      'schemaVersion',
      'registryUrl',
      'rootPublicKeyPem',
      'confirmedFingerprint',
    ])
    approval = raw as unknown as RegistryRootApprovalDocument
  } catch {
    throw new Error('custom marketplace Registry root approval file is unreadable')
  }
  if (
    approval.schemaVersion !== 1 ||
    typeof approval.registryUrl !== 'string' ||
    typeof approval.rootPublicKeyPem !== 'string' ||
    typeof approval.confirmedFingerprint !== 'string'
  ) {
    throw new Error('custom marketplace Registry root approval file is invalid')
  }
  const registryUrl = requestedRegistryUrl
  if (normalizedUrl(approval.registryUrl) !== registryUrl) {
    throw new Error('custom marketplace Registry URL does not match its root approval')
  }
  const computed = registryRootFingerprint(approval.rootPublicKeyPem)
  if (computed !== approval.confirmedFingerprint) {
    throw new Error('custom marketplace Registry root fingerprint confirmation does not match')
  }
  return {
    registryUrl,
    rootPublicKey: approval.rootPublicKeyPem,
    fingerprint: computed,
    source: 'user',
    authority: 'self-hosted',
  }
}
