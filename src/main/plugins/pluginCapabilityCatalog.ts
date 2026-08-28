import type { JsonValue, StoragePartitionScope } from '../../../packages/plugin-contracts/src/index'
import { normalizeJsonValue, utf8ByteLength } from './pluginStorageJson'

/** Public Manifest v2 capability catalog used by the Host broker.
 *
 * The machine-readable JSON catalog remains the documentation/registry source
 * of truth. This small executable projection contains only the fields needed
 * to fail closed before a public request reaches a Host adapter.
 */

export type PublicCapabilityScope = 'workspace' | 'plugin'
/** Partition class a plugin may request from a Host-managed storage call. The
 *  Host derives the actual partition identity; the request only selects one of
 *  these two classes. */
export type StoragePartitionClass = StoragePartitionScope
export type PublicCapabilityEligibility = 'public' | 'firstParty'

export const STORAGE_LIMITS = {
  maxKeyBytes: 256,
  maxValueBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
} as const

/** Executable names accepted by the public shell.run allowlist mode.
 * Package identity cannot add to or bypass this Host-owned policy. */
export const HOST_SHELL_EXECUTABLE_ALLOWLIST: readonly string[] = ['git', 'gh', 'glab']

interface PublicCapabilityCatalogBase {
  address: string
  kind: 'method' | 'event'
  eligibility: PublicCapabilityEligibility
  validateRequest?: (value: unknown) => value is Record<string, unknown>
}

/** Public storage entries are deliberately a separate union member: they do
 * not have a fixed namespace scope because the request chooses plugin versus
 * workspace while the Host derives the identity. */
export interface PublicStorageCapabilityCatalogEntry extends PublicCapabilityCatalogBase {
  namespace: 'storage'
  storage: true
  kind: 'method'
  validateRequest: (value: unknown) => value is Record<string, unknown>
}

export interface PublicSystemCapabilityCatalogEntry extends PublicCapabilityCatalogBase {
  namespace: 'fs' | 'ui' | 'aiCli' | 'shell'
  /** Host-pinned scope for declared namespaces (only `ui.openExternal` is
   *  `plugin`; storage has its own discriminated entry). */
  scope: PublicCapabilityScope
  storage?: false
}

export type PublicCapabilityCatalogEntry =
  | PublicStorageCapabilityCatalogEntry
  | PublicSystemCapabilityCatalogEntry

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function requestWithString(
  key: string,
  value: unknown,
  optionalKeys: readonly string[] = []
): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, [key, ...optionalKeys]) && nonEmptyString(value[key])
}

/** Storage requests contain only a partition class and key; `set` additionally
 *  contains a JSON value. Partition identity is always Host-derived. */
export type StorageRequestValidationError = 'INVALID_ARGUMENT' | 'STORAGE_QUOTA_EXCEEDED'

export function storageRequestValidationError(
  value: unknown,
  address: 'storage.get' | 'storage.set' | 'storage.delete' = 'storage.get'
): StorageRequestValidationError | null {
  try {
    const allowedKeys = address === 'storage.set' ? ['scope', 'key', 'value'] : ['scope', 'key']
    if (!isRecord(value) || !hasOnlyKeys(value, allowedKeys)) return 'INVALID_ARGUMENT'
    const record = value as Record<string, unknown>
    const scope = record.scope
    if (scope !== 'plugin' && scope !== 'workspace') return 'INVALID_ARGUMENT'
    if (!nonEmptyString(record.key)) return 'INVALID_ARGUMENT'
    if (utf8ByteLength(record.key) > STORAGE_LIMITS.maxKeyBytes) {
      return 'STORAGE_QUOTA_EXCEEDED'
    }
    if (address === 'storage.set') {
      const normalized = normalizeJsonValue(record.value)
      if (!normalized) return 'INVALID_ARGUMENT'
      if (normalized.bytes > STORAGE_LIMITS.maxValueBytes) {
        return 'STORAGE_QUOTA_EXCEEDED'
      }
    }
    return null
  } catch {
    return 'INVALID_ARGUMENT'
  }
}

export function validateStorageRequest(
  value: unknown,
  address: 'storage.get' | 'storage.set' | 'storage.delete' = 'storage.get'
): value is Record<string, unknown> & {
  scope: StoragePartitionClass
  key: string
  value?: JsonValue
} {
  return storageRequestValidationError(value, address) === null
}

function validateEditorRequest(value: unknown): value is Record<string, unknown> {
  if (!requestWithString('path', value, ['line', 'column'])) return false
  const record = value as Record<string, unknown>
  return (
    (record.line === undefined || positiveInteger(record.line)) &&
    (record.column === undefined || positiveInteger(record.column))
  )
}

function validateExternalRequest(value: unknown): value is Record<string, unknown> {
  if (!requestWithString('url', value)) return false
  return /^https:\/\/[^\s]+$/i.test(String((value as Record<string, unknown>).url))
}

function validateStartRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['profileId', 'requestId', 'cols', 'rows', 'paneId', 'yolo'])) return false
  return (
    nonEmptyString(value.profileId) &&
    (value.requestId === undefined || nonEmptyString(value.requestId)) &&
    positiveInteger(value.cols) &&
    positiveInteger(value.rows) &&
    (value.paneId === undefined || nonEmptyString(value.paneId)) &&
    (value.yolo === undefined || typeof value.yolo === 'boolean')
  )
}

function validateEmptyRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, [])
}

function validateResumeRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['cols', 'rows']) &&
    positiveInteger(value.cols) && positiveInteger(value.rows)
}

function validateWriteFileRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['path', 'content']) &&
    nonEmptyString(value.path) && typeof value.content === 'string'
}

function validateListFilesRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['query', 'maxResults'])) return false
  return (
    (value.query === undefined || typeof value.query === 'string') &&
    (value.maxResults === undefined || positiveInteger(value.maxResults))
  )
}

function validateSessionRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('sessionId', value)
}

function validateReattachRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'cols', 'rows'])) return false
  return nonEmptyString(value.sessionId) &&
    ((positiveInteger(value.cols) && positiveInteger(value.rows)) ||
      (value.cols === 0 && value.rows === 0))
}

function validateStopRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'force'])) return false
  return nonEmptyString(value.sessionId) && typeof value.force === 'boolean'
}

function validateInputRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'data'])) return false
  return nonEmptyString(value.sessionId) && typeof value.data === 'string'
}

function validateResizeRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'cols', 'rows'])) return false
  return nonEmptyString(value.sessionId) && positiveInteger(value.cols) && positiveInteger(value.rows)
}

function validateShellRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('command', value)
}

function systemMethod(
  address: string,
  namespace: 'fs' | 'ui' | 'aiCli',
  validateRequest: (value: unknown) => value is Record<string, unknown>,
  eligibility: PublicCapabilityEligibility = 'public'
): PublicCapabilityCatalogEntry {
  return {
    address,
    kind: 'method',
    namespace,
    scope: namespace === 'ui' && address === 'ui.openExternal' ? 'plugin' : 'workspace',
    eligibility,
    validateRequest,
  }
}

function aiCliMethod(
  address: string,
  validateRequest: (value: unknown) => value is Record<string, unknown>
): PublicCapabilityCatalogEntry {
  return systemMethod(address, 'aiCli', validateRequest)
}

function storageMethod(
  address: 'storage.get' | 'storage.set' | 'storage.delete'
): PublicCapabilityCatalogEntry {
  return {
    address,
    kind: 'method',
    namespace: 'storage',
    storage: true,
    eligibility: 'public',
    validateRequest: (value) => validateStorageRequest(value, address),
  }
}

export const PUBLIC_CAPABILITY_CATALOG: Readonly<Record<string, PublicCapabilityCatalogEntry>> = {
  'fs.readFile': systemMethod('fs.readFile', 'fs', (value) => requestWithString('path', value)),
  'fs.writeFile': systemMethod('fs.writeFile', 'fs', validateWriteFileRequest),
  'fs.readImage': systemMethod('fs.readImage', 'fs', (value) => requestWithString('path', value)),
  'fs.listDirectory': systemMethod('fs.listDirectory', 'fs', (value) => requestWithString('path', value)),
  'fs.listFilesFlat': systemMethod('fs.listFilesFlat', 'fs', validateListFilesRequest),
  'fs.glob': systemMethod('fs.glob', 'fs', (value) => requestWithString('pattern', value)),
  'fs.stat': systemMethod('fs.stat', 'fs', (value) => requestWithString('path', value)),
  'fs.statPath': systemMethod('fs.statPath', 'fs', (value) => requestWithString('path', value)),
  'ui.openInEditor': systemMethod('ui.openInEditor', 'ui', validateEditorRequest),
  'ui.openExternal': systemMethod('ui.openExternal', 'ui', validateExternalRequest),
  'storage.get': storageMethod('storage.get'),
  'storage.set': storageMethod('storage.set'),
  'storage.delete': storageMethod('storage.delete'),
  'aiCli.listProfiles': aiCliMethod('aiCli.listProfiles', validateEmptyRequest),
  'aiCli.startSession': aiCliMethod('aiCli.startSession', validateStartRequest),
  'aiCli.resumeSession': aiCliMethod('aiCli.resumeSession', validateResumeRequest),
  'aiCli.cancelStart': aiCliMethod('aiCli.cancelStart', (value) => requestWithString('requestId', value)),
  'aiCli.reattachSession': aiCliMethod('aiCli.reattachSession', validateReattachRequest),
  'aiCli.sendInput': aiCliMethod('aiCli.sendInput', validateInputRequest),
  'aiCli.resizeSession': aiCliMethod('aiCli.resizeSession', validateResizeRequest),
  'aiCli.redrawSession': aiCliMethod('aiCli.redrawSession', validateResizeRequest),
  'aiCli.interruptSession': aiCliMethod('aiCli.interruptSession', validateSessionRequest),
  'aiCli.stopSession': aiCliMethod('aiCli.stopSession', validateStopRequest),
  'shell.run': {
    address: 'shell.run',
    kind: 'method',
    namespace: 'shell',
    scope: 'workspace',
    eligibility: 'public',
    validateRequest: validateShellRequest,
  },
  'workspace.filesChanged': {
    address: 'workspace.filesChanged',
    kind: 'event',
    namespace: 'fs',
    scope: 'workspace',
    eligibility: 'public',
  },
  'aiCli.output': {
    address: 'aiCli.output',
    kind: 'event',
    namespace: 'aiCli',
    scope: 'workspace',
    eligibility: 'public',
  },
  'aiCli.exited': {
    address: 'aiCli.exited',
    kind: 'event',
    namespace: 'aiCli',
    scope: 'workspace',
    eligibility: 'public',
  },
}

export const PUBLIC_CAPABILITY_EVENT_ADDRESSES: readonly string[] = [
  'workspace.filesChanged',
  'aiCli.output',
  'aiCli.exited',
]

export function publicCapabilityEntry(address: string): PublicCapabilityCatalogEntry | null {
  return PUBLIC_CAPABILITY_CATALOG[address] ?? null
}
