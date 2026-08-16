/** Public Manifest v2 capability catalog used by the Host broker.
 *
 * The machine-readable JSON catalog remains the documentation/registry source
 * of truth. This small executable projection contains only the fields needed
 * to fail closed before a public request reaches a Host adapter.
 */

export type PublicCapabilityScope = 'workspace' | 'plugin'
export type PublicCapabilityEligibility = 'public' | 'firstParty'

export interface PublicCapabilityCatalogEntry {
  address: string
  kind: 'method' | 'event'
  namespace: 'fs' | 'ui' | 'aiCli' | 'shell'
  scope: PublicCapabilityScope
  eligibility: PublicCapabilityEligibility
  validateRequest?: (value: unknown) => value is Record<string, unknown>
}

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
  if (!isRecord(value) || !hasOnlyKeys(value, ['profileId', 'cols', 'rows'])) return false
  return nonEmptyString(value.profileId) && positiveInteger(value.cols) && positiveInteger(value.rows)
}

function validateSessionRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('sessionId', value)
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
  return systemMethod(address, 'aiCli', validateRequest, 'firstParty')
}

export const PUBLIC_CAPABILITY_CATALOG: Readonly<Record<string, PublicCapabilityCatalogEntry>> = {
  'fs.readFile': systemMethod('fs.readFile', 'fs', (value) => requestWithString('path', value)),
  'fs.listDirectory': systemMethod('fs.listDirectory', 'fs', (value) => requestWithString('path', value)),
  'fs.glob': systemMethod('fs.glob', 'fs', (value) => requestWithString('pattern', value)),
  'fs.stat': systemMethod('fs.stat', 'fs', (value) => requestWithString('path', value)),
  'ui.openInEditor': systemMethod('ui.openInEditor', 'ui', validateEditorRequest),
  'ui.openExternal': systemMethod('ui.openExternal', 'ui', validateExternalRequest),
  'aiCli.startSession': aiCliMethod('aiCli.startSession', validateStartRequest),
  'aiCli.cancelStart': aiCliMethod('aiCli.cancelStart', (value) => requestWithString('requestId', value)),
  'aiCli.reattachSession': aiCliMethod('aiCli.reattachSession', validateSessionRequest),
  'aiCli.sendInput': aiCliMethod('aiCli.sendInput', validateInputRequest),
  'aiCli.resizeSession': aiCliMethod('aiCli.resizeSession', validateResizeRequest),
  'aiCli.redrawSession': aiCliMethod('aiCli.redrawSession', validateSessionRequest),
  'aiCli.interruptSession': aiCliMethod('aiCli.interruptSession', validateSessionRequest),
  'aiCli.stopSession': aiCliMethod('aiCli.stopSession', validateSessionRequest),
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
    eligibility: 'firstParty',
  },
  'aiCli.exited': {
    address: 'aiCli.exited',
    kind: 'event',
    namespace: 'aiCli',
    scope: 'workspace',
    eligibility: 'firstParty',
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
