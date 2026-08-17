import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { assertExactTrustFields, requireTrustObject } from './pluginTrustJson'

export type RegistryAuthority = 'official' | 'self-hosted'

export type RegistrySignerStatus = 'active' | 'rotating' | 'expired' | 'revoked'

export interface RegistryPackageEnvelope {
  schemaVersion: 1
  artifactDigest: string
  packageId: string
  version: string
  target: string
  publisherId: string
  keyId: string
  signedAt: string
}

export interface RegistrySignerTrust {
  keyId: string
  publicKey: string
  status: RegistrySignerStatus
  notBefore: string
  notAfter: string
}

export interface RegistryBlockedPackage {
  packageId: string
  version?: string
}

export interface RegistryTrustMetadata {
  schemaVersion: 1
  registryProfile: 'official' | 'self-hosted-dev'
  /** Informational identity only. The Host never turns this response value
   * into a trust root; signature verification still uses pinnedRootKey. */
  rootFingerprint: string
  generatedAt: string
  expiresAt: string
  signers: RegistrySignerTrust[]
  blockedPublishers: string[]
  blockedPackages: RegistryBlockedPackage[]
}

export type RegistryTrustErrorCode =
  | 'TRUST_METADATA_INVALID'
  | 'SIGNATURE_REQUIRED'
  | 'REGISTRY_SIGNATURE_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'SIGNER_UNKNOWN'
  | 'SIGNER_REVOKED'
  | 'SIGNER_INVALID'
  | 'PUBLISHER_BLOCKED'
  | 'PACKAGE_BLOCKED'

export class RegistryTrustError extends Error {
  constructor(
    readonly code: RegistryTrustErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'RegistryTrustError'
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

/** Validate the exact wire shape before a Registry envelope becomes Host
 * evidence. This is also used for retained receipt files. */
export function assertRegistryPackageEnvelopeShape(
  value: unknown,
  label = 'registry envelope'
): asserts value is RegistryPackageEnvelope {
  const envelope = requireTrustObject(value, label)
  assertExactTrustFields(envelope, label, [
    'schemaVersion',
    'artifactDigest',
    'packageId',
    'version',
    'target',
    'publisherId',
    'keyId',
    'signedAt',
  ])
  if (envelope.schemaVersion !== 1) throw new Error(`${label} schemaVersion is unsupported`)
  for (const field of [
    'artifactDigest',
    'packageId',
    'version',
    'target',
    'publisherId',
    'keyId',
    'signedAt',
  ]) {
    requiredString(envelope[field], `${label}.${field}`)
  }
}

/** Validate the exact root-signed metadata shape. Unknown nested fields are
 * rejected as well as unknown top-level fields. */
export function assertRegistryTrustMetadataShape(
  value: unknown,
  label = 'registry trust metadata'
): asserts value is RegistryTrustMetadata {
  const metadata = requireTrustObject(value, label)
  assertExactTrustFields(metadata, label, [
    'schemaVersion',
    'registryProfile',
    'rootFingerprint',
    'generatedAt',
    'expiresAt',
    'signers',
    'blockedPublishers',
    'blockedPackages',
  ])
  if (metadata.schemaVersion !== 1) throw new Error(`${label} schemaVersion is unsupported`)
  if (metadata.registryProfile !== 'official' && metadata.registryProfile !== 'self-hosted-dev') {
    throw new Error(`${label}.registryProfile is invalid`)
  }
  if (
    typeof metadata.rootFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.rootFingerprint)
  ) {
    throw new Error(`${label}.rootFingerprint is invalid`)
  }
  requiredString(metadata.generatedAt, `${label}.generatedAt`)
  requiredString(metadata.expiresAt, `${label}.expiresAt`)
  if (!Array.isArray(metadata.signers)) throw new Error(`${label}.signers must be an array`)
  metadata.signers.forEach((value, index) => {
    const signer = requireTrustObject(value, `${label}.signers[${index}]`)
    assertExactTrustFields(signer, `${label}.signers[${index}]`, [
      'keyId',
      'publicKey',
      'status',
      'notBefore',
      'notAfter',
    ])
    requiredString(signer.keyId, `${label}.signers[${index}].keyId`)
    requiredString(signer.publicKey, `${label}.signers[${index}].publicKey`)
    if (!['active', 'rotating', 'expired', 'revoked'].includes(String(signer.status))) {
      throw new Error(`${label}.signers[${index}].status is invalid`)
    }
    requiredString(signer.notBefore, `${label}.signers[${index}].notBefore`)
    requiredString(signer.notAfter, `${label}.signers[${index}].notAfter`)
  })
  if (!Array.isArray(metadata.blockedPublishers)) {
    throw new Error(`${label}.blockedPublishers must be an array`)
  }
  metadata.blockedPublishers.forEach((value, index) =>
    requiredString(value, `${label}.blockedPublishers[${index}]`)
  )
  if (!Array.isArray(metadata.blockedPackages)) {
    throw new Error(`${label}.blockedPackages must be an array`)
  }
  metadata.blockedPackages.forEach((value, index) => {
    const blocked = requireTrustObject(value, `${label}.blockedPackages[${index}]`)
    assertExactTrustFields(blocked, `${label}.blockedPackages[${index}]`, ['packageId'], ['version'])
    requiredString(blocked.packageId, `${label}.blockedPackages[${index}].packageId`)
    if (blocked.version !== undefined) {
      requiredString(blocked.version, `${label}.blockedPackages[${index}].version`)
    }
  })
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareCanonicalKeys(left, right))
        .map(([key, item]) => [key, canonicalValue(item)])
    )
  }
  return value
}

function compareCanonicalKeys(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0)!)
  const comparedLength = Math.min(leftCodePoints.length, rightCodePoints.length)

  for (let index = 0; index < comparedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index]
    const rightCodePoint = rightCodePoints[index]
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1
  }

  if (leftCodePoints.length === rightCodePoints.length) return 0
  return leftCodePoints.length < rightCodePoints.length ? -1 : 1
}

export function canonicalTrustJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function verifyCanonicalSignature(value: unknown, signature: string, publicKey: string): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(canonicalTrustJson(value), 'utf8'),
      createPublicKey(publicKey),
      Buffer.from(signature, 'base64')
    )
  } catch {
    return false
  }
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', `${field} is not a valid timestamp`)
  }
  return parsed
}

export interface VerifyRegistryPackageTrustInput {
  envelope: RegistryPackageEnvelope
  envelopeSignature: string | null | undefined
  trustMetadata: RegistryTrustMetadata
  trustMetadataSignature: string | null | undefined
  pinnedRootKey: string | null
  expected: Pick<
    RegistryPackageEnvelope,
    'artifactDigest' | 'packageId' | 'version' | 'target' | 'publisherId'
  >
  now?: Date
}

export interface VerifiedRegistryPackageTrust {
  publisherId: string
  keyId: string
}

export function verifyRegistryTrustMetadata(
  metadata: RegistryTrustMetadata,
  metadataSignature: string | null | undefined,
  pinnedRootKey: string | null,
  nowValue: Date = new Date()
): void {
  try {
    assertRegistryTrustMetadataShape(metadata)
  } catch (error) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!pinnedRootKey) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'no pinned registry root is configured')
  }
  if (!metadataSignature) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'root-signed registry trust metadata is required'
    )
  }
  if (!verifyCanonicalSignature(metadata, metadataSignature, pinnedRootKey)) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'registry trust metadata signature failed verification against the pinned root'
    )
  }
  const now = nowValue.getTime()
  const generatedAt = timestamp(metadata.generatedAt, 'trust metadata generatedAt')
  const expiresAt = timestamp(metadata.expiresAt, 'trust metadata expiresAt')
  if (generatedAt > now || expiresAt < now || expiresAt <= generatedAt) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'registry trust metadata is expired')
  }
  if (
    metadata.schemaVersion !== 1 ||
    !['official', 'self-hosted-dev'].includes(metadata.registryProfile) ||
    !/^sha256:[0-9a-f]{64}$/.test(metadata.rootFingerprint)
  ) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      'registry trust profile or informational root fingerprint is invalid'
    )
  }
}

export function verifyRegistryPackageTrust(
  input: VerifyRegistryPackageTrustInput
): VerifiedRegistryPackageTrust {
  try {
    assertRegistryPackageEnvelopeShape(input.envelope)
  } catch (error) {
    throw new RegistryTrustError(
      'TRUST_METADATA_INVALID',
      error instanceof Error ? error.message : String(error)
    )
  }
  const now = (input.now ?? new Date()).getTime()
  verifyRegistryTrustMetadata(
    input.trustMetadata,
    input.trustMetadataSignature,
    input.pinnedRootKey,
    input.now
  )

  for (const field of [
    'artifactDigest',
    'packageId',
    'version',
    'target',
    'publisherId',
  ] as const) {
    if (input.envelope[field] !== input.expected[field]) {
      throw new RegistryTrustError(
        'IDENTITY_MISMATCH',
        `registry envelope ${field} does not match the requested package`
      )
    }
  }

  if (input.envelope.schemaVersion !== 1) {
    throw new RegistryTrustError('TRUST_METADATA_INVALID', 'unsupported registry trust schema')
  }
  if (!input.envelopeSignature) {
    throw new RegistryTrustError('SIGNATURE_REQUIRED', 'registry package signature is required')
  }

  const signer = input.trustMetadata.signers.find(
    (candidate) => candidate.keyId === input.envelope.keyId
  )
  if (!signer) {
    throw new RegistryTrustError(
      'SIGNER_UNKNOWN',
      `unknown registry signer '${input.envelope.keyId}'`
    )
  }
  if (signer.status === 'revoked') {
    throw new RegistryTrustError(
      'SIGNER_REVOKED',
      `registry signer '${signer.keyId}' is revoked`
    )
  }

  const signedAt = timestamp(input.envelope.signedAt, 'registry envelope signedAt')
  const notBefore = timestamp(signer.notBefore, 'registry signer notBefore')
  const notAfter = timestamp(signer.notAfter, 'registry signer notAfter')
  if (signer.status === 'expired' && signedAt > notAfter) {
    throw new RegistryTrustError(
      'SIGNER_INVALID',
      `expired signer '${signer.keyId}' cannot sign a new artifact`
    )
  }
  if (signedAt < notBefore || signedAt > notAfter || signedAt > now) {
    throw new RegistryTrustError(
      'SIGNER_INVALID',
      `registry signer '${signer.keyId}' signature is outside its validity window`
    )
  }

  if (input.trustMetadata.blockedPublishers.includes(input.envelope.publisherId)) {
    throw new RegistryTrustError(
      'PUBLISHER_BLOCKED',
      `publisher '${input.envelope.publisherId}' is blocked`
    )
  }
  if (
    input.trustMetadata.blockedPackages.some(
      (blocked) =>
        blocked.packageId === input.envelope.packageId &&
        (blocked.version === undefined || blocked.version === input.envelope.version)
    )
  ) {
    throw new RegistryTrustError(
      'PACKAGE_BLOCKED',
      `package '${input.envelope.packageId}@${input.envelope.version}' is blocked`
    )
  }

  if (!verifyCanonicalSignature(input.envelope, input.envelopeSignature, signer.publicKey)) {
    throw new RegistryTrustError(
      'REGISTRY_SIGNATURE_INVALID',
      'registry signature failed verification against the authorized signer'
    )
  }

  return { publisherId: input.envelope.publisherId, keyId: signer.keyId }
}
