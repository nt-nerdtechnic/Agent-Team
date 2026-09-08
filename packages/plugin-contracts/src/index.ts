import manifestV2Schema from './schemas/plugin-manifest-v2.schema.json' with { type: 'json' }
import capabilitiesV1 from './schemas/capabilities-v1.json' with { type: 'json' }
import executionPolicyV1Schema from './schemas/execution-policy-v1.schema.json' with { type: 'json' }
import { canonicalHtmlPath, canonicalPackagePath } from './archive.js'

export * from './archive.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type StoragePartitionScope = 'plugin' | 'workspace'
export type StorageGetResult =
  | { found: true; value: JsonValue }
  | { found: false; value: null }

export const V2_VIEW_LOCATIONS = ['top', 'bottom', 'right', 'left', 'main', 'window'] as const
export const V2_SYSTEM_NAMESPACES = ['fs', 'ui', 'aiCli'] as const
export const V2_SHELL_MODES = ['allowlist', 'full'] as const
export const EXECUTION_POLICY_SCHEMA_VERSION = 1 as const
export const EXECUTION_POLICY_MODES = ['full', 'allowlist', 'denylist'] as const

export type PluginSystemNamespace = (typeof V2_SYSTEM_NAMESPACES)[number]
export type PluginShellMode = (typeof V2_SHELL_MODES)[number]
export type ExecutionPolicyMode = (typeof EXECUTION_POLICY_MODES)[number]

export interface ExecutionPolicy {
  schemaVersion: typeof EXECUTION_POLICY_SCHEMA_VERSION
  mode: ExecutionPolicyMode
  system: PluginSystemNamespace[]
  shell: string[]
}

export type PluginManifestV2Permissions = {
  system?: PluginSystemNamespace[]
  shell?: PluginShellMode
}

export type PluginManifestV2View = {
  id: string
  kind: 'custom'
  location: (typeof V2_VIEW_LOCATIONS)[number]
  title: string
  icon?: string
  entry: string
}

export type PluginManifestV2 = {
  schemaVersion: 2
  apiVersion: string
  id: string
  name: string
  version: string
  publisher: string
  engines?: { navide: string }
  permissions: PluginManifestV2Permissions
  marketplace: {
    description: string
    license: string
    repository?: string
    homepage?: string
    categories?: string[]
    icon?: string
  }
  contributes?: { views: PluginManifestV2View[] }
  backend?: {
    entry: string
    protocolVersion: 1
    activation: 'startup'
  }
  /** Legacy fields are intentionally unavailable on a v2 manifest. */
  requires?: never
  entry?: never
}

export type PluginContractErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_MANIFEST'
  | 'INVALID_EXECUTION_POLICY'
  | 'INVALID_PACKAGE'

export class PluginContractError extends Error {
  constructor(
    message: string,
    readonly code: PluginContractErrorCode = 'INVALID_MANIFEST'
  ) {
    super(message)
    this.name = 'PluginContractError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string, code: PluginContractErrorCode = 'INVALID_MANIFEST'): never {
  throw new PluginContractError(message, code)
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be a JSON object`)
  return value
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${label} has unknown field '${key}'`)
  }
}

function required(value: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail(`${label} is missing required field '${key}'`)
  }
  return value[key]
}

function stringValue(value: unknown, label: string, minLength = 0, maxLength?: number): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const length = Array.from(value).length
  if (length < minLength) fail(`${label} must be a string with at least ${minLength} character(s)`)
  if (maxLength !== undefined && length > maxLength) {
    fail(`${label} must be a string with at most ${maxLength} character(s)`)
  }
  return value
}

function displayText(value: unknown, label: string, maxLength = 80): string {
  const text = stringValue(value, label, 1, maxLength)
  if (/\r|\n|[<>]/.test(text)) fail(`${label} contains unsafe characters`)
  return text
}

function uniqueStringArray(
  value: unknown,
  label: string,
  minItems: number,
  maxItems: number
): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    fail(`${label} must contain ${minItems}-${maxItems} item(s)`)
  }
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicate items`)
  return result
}

function requiredUniqueStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`, 'INVALID_EXECUTION_POLICY')
  const result = value.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`${label}[${index}] must be a string`, 'INVALID_EXECUTION_POLICY')
    }
    return item
  })
  if (new Set(result).size !== result.length) {
    fail(`${label} must not contain duplicate items`, 'INVALID_EXECUTION_POLICY')
  }
  return result
}

const EXECUTION_POLICY_SHELL_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/** Return the stable lowercase spelling used for persisted shell names. */
export function canonicalizeExecutionPolicyShellName(value: unknown): string {
  if (typeof value !== 'string') {
    fail('execution policy.shell entry must be a string', 'INVALID_EXECUTION_POLICY')
  }
  if (!EXECUTION_POLICY_SHELL_ENTRY.test(value)) {
    fail(
      `execution policy.shell contains an unsafe executable spelling '${value}'`,
      'INVALID_EXECUTION_POLICY'
    )
  }
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

/** Parse and validate the global, agent-oriented Execution Policy contract. */
export function parseExecutionPolicy(raw: unknown): ExecutionPolicy {
  if (!isRecord(raw)) fail('execution policy must be a JSON object', 'INVALID_EXECUTION_POLICY')
  const policy = raw
  const policyKeys = ['schemaVersion', 'mode', 'system', 'shell'] as const
  for (const key of Object.keys(policy)) {
    if (!policyKeys.includes(key as (typeof policyKeys)[number])) {
      fail(`execution policy has unknown field '${key}'`, 'INVALID_EXECUTION_POLICY')
    }
  }
  for (const key of policyKeys) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      fail(`execution policy is missing required field '${key}'`, 'INVALID_EXECUTION_POLICY')
    }
  }
  if (policy.schemaVersion !== EXECUTION_POLICY_SCHEMA_VERSION) {
    fail(
      `execution policy schemaVersion must be ${EXECUTION_POLICY_SCHEMA_VERSION}`,
      'INVALID_EXECUTION_POLICY'
    )
  }
  if (!EXECUTION_POLICY_MODES.includes(policy.mode as ExecutionPolicyMode)) {
    fail('execution policy mode is invalid', 'INVALID_EXECUTION_POLICY')
  }

  const system = requiredUniqueStringArray(policy.system, 'execution policy.system')
  if (system.some((item) => !V2_SYSTEM_NAMESPACES.includes(item as PluginSystemNamespace))) {
    fail('execution policy.system contains an unknown namespace', 'INVALID_EXECUTION_POLICY')
  }

  if (!Array.isArray(policy.shell)) {
    fail('execution policy.shell must be an array', 'INVALID_EXECUTION_POLICY')
  }
  const shell = policy.shell.map((item, index) => {
    if (typeof item !== 'string') {
      fail(`execution policy.shell[${index}] must be a string`, 'INVALID_EXECUTION_POLICY')
    }
    return canonicalizeExecutionPolicyShellName(item)
  })
  if (new Set(shell).size !== shell.length) {
    fail('execution policy.shell must not contain duplicate items', 'INVALID_EXECUTION_POLICY')
  }

  const mode = policy.mode as ExecutionPolicyMode
  if (mode === 'full' && (system.length > 0 || shell.length > 0)) {
    fail('execution policy full mode must have empty system and shell arrays', 'INVALID_EXECUTION_POLICY')
  }

  return {
    schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
    mode,
    system: system as PluginSystemNamespace[],
    shell,
  }
}

function safePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 1)
  if (canonicalPackagePath(path) === null) {
    fail(`${label} is not a safe package-relative path`)
  }
  return path
}

function htmlPath(value: unknown, label: string): string {
  const path = safePath(value, label)
  if (canonicalHtmlPath(path) === null) {
    fail(`${label} is not a safe package-relative HTML path`)
  }
  return path
}

function httpsUri(value: unknown, label: string): string {
  const uri = stringValue(value, label, 1, 2048)
  if (!/^https:\/\/[^\s]+$/.test(uri)) fail(`${label} must be an https URL`)
  return uri
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const VERSION_RANGE = /^[~^]?[0-9]+\.[0-9]+\.[0-9]+$/
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const PUBLISHER = /^[a-z0-9][a-z0-9-]*$/
const VIEW_ID = /^[a-z][a-z0-9-]*$/
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.()+ -]*$/
const SCRIPT_EXTENSIONS = new Set([
  '.py',
  '.pyw',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.cmd',
  '.bat',
])

/** Return whether a value is a canonical Manifest v2 package id. */
export function isValidManifestV2PluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value)
}

type ParsedSemver = {
  core: [string, string, string]
  prerelease: string[]
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value)
  if (!match) return null
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Compare SemVer 2.0.0 precedence; build metadata is intentionally ignored. */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null

  for (let index = 0; index < a.core.length; index += 1) {
    const result = compareNumericIdentifiers(a.core[index], b.core[index])
    if (result !== 0) return result
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1
    }
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier)
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier)
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier)
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function parsePermissions(value: unknown): PluginManifestV2Permissions {
  const permissions = assertObject(value, 'manifest permissions')
  assertOnlyKeys(permissions, ['system', 'shell'], 'manifest permissions')
  let system: PluginSystemNamespace[] | undefined
  if (Object.prototype.hasOwnProperty.call(permissions, 'system')) {
    const values = uniqueStringArray(permissions.system, 'manifest permissions.system', 1, 3)
    if (values.some((item) => !V2_SYSTEM_NAMESPACES.includes(item as PluginSystemNamespace))) {
      fail('manifest permissions.system contains an unknown namespace')
    }
    system = values as PluginSystemNamespace[]
  }
  let shell: PluginShellMode | undefined
  if (Object.prototype.hasOwnProperty.call(permissions, 'shell')) {
    if (!V2_SHELL_MODES.includes(permissions.shell as PluginShellMode)) {
      fail('manifest permissions.shell contains an unknown mode')
    }
    shell = permissions.shell as PluginShellMode
  }
  return { ...(system ? { system } : {}), ...(shell ? { shell } : {}) }
}

function parseMarketplace(value: unknown): PluginManifestV2['marketplace'] {
  const marketplace = assertObject(value, 'manifest marketplace')
  assertOnlyKeys(
    marketplace,
    ['description', 'license', 'repository', 'homepage', 'categories', 'icon'],
    'manifest marketplace'
  )
  const description = displayText(required(marketplace, 'description', 'manifest marketplace'), 'manifest marketplace.description', 280)
  const license = stringValue(required(marketplace, 'license', 'manifest marketplace'), 'manifest marketplace.license', 1, 100)
  if (!LICENSE.test(license)) fail('manifest marketplace.license contains invalid characters')
  const result: PluginManifestV2['marketplace'] = { description, license }
  if (marketplace.repository !== undefined) result.repository = httpsUri(marketplace.repository, 'manifest marketplace.repository')
  if (marketplace.homepage !== undefined) result.homepage = httpsUri(marketplace.homepage, 'manifest marketplace.homepage')
  if (marketplace.categories !== undefined) {
    const categories = uniqueStringArray(marketplace.categories, 'manifest marketplace.categories', 0, 5)
    if (categories.some((category) => !/^[a-z0-9][a-z0-9-]{0,39}$/.test(category))) {
      fail('manifest marketplace.categories contains an invalid category')
    }
    result.categories = categories
  }
  if (marketplace.icon !== undefined) result.icon = safePath(marketplace.icon, 'manifest marketplace.icon')
  return result
}

function parseViews(value: unknown): { views: PluginManifestV2View[] } {
  const contributes = assertObject(value, 'manifest contributes')
  assertOnlyKeys(contributes, ['views'], 'manifest contributes')
  if (!Array.isArray(contributes.views) || contributes.views.length < 1 || contributes.views.length > 16) {
    fail('manifest contributes.views must contain 1-16 view(s)')
  }
  const views = contributes.views.map((raw, index) => {
    const view = assertObject(raw, `manifest contributes.views[${index}]`)
    assertOnlyKeys(view, ['id', 'kind', 'location', 'title', 'icon', 'entry'], `manifest contributes.views[${index}]`)
    const id = stringValue(required(view, 'id', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].id`)
    if (!VIEW_ID.test(id)) fail(`manifest contributes.views[${index}].id is invalid`)
    if (view.kind !== 'custom') fail(`manifest contributes.views[${index}].kind must be 'custom'`)
    if (!V2_VIEW_LOCATIONS.includes(view.location as (typeof V2_VIEW_LOCATIONS)[number])) {
      fail(`manifest contributes.views[${index}].location is invalid`)
    }
    const title = displayText(required(view, 'title', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].title`)
    const entry = htmlPath(required(view, 'entry', `manifest contributes.views[${index}]`), `manifest contributes.views[${index}].entry`)
    const parsed: PluginManifestV2View = {
      id,
      kind: 'custom',
      location: view.location as PluginManifestV2View['location'],
      title,
      entry,
    }
    if (view.icon !== undefined) parsed.icon = safePath(view.icon, `manifest contributes.views[${index}].icon`)
    return parsed
  })
  const ids = new Set<string>()
  for (const view of views) {
    if (ids.has(view.id)) fail(`manifest contributes.views contains duplicate id '${view.id}'`)
    ids.add(view.id)
  }
  return { views }
}

function parseBackend(value: unknown): PluginManifestV2['backend'] {
  const backend = assertObject(value, 'manifest backend')
  assertOnlyKeys(backend, ['entry', 'protocolVersion', 'activation'], 'manifest backend')
  const entry = safePath(required(backend, 'entry', 'manifest backend'), 'manifest backend.entry')
  const filename = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase()
  const extension = filename.slice(filename.lastIndexOf('.'))
  if (SCRIPT_EXTENSIONS.has(extension)) {
    fail('manifest backend.entry must reference a packaged executable, not a raw script')
  }
  if (backend.protocolVersion !== 1) fail('manifest backend.protocolVersion must be 1')
  if (backend.activation !== 'startup') fail("manifest backend.activation must be 'startup'")
  return { entry, protocolVersion: 1, activation: 'startup' }
}

export function parseManifestV2(raw: unknown): PluginManifestV2 {
  const manifest = assertObject(raw, 'manifest')
  assertOnlyKeys(
    manifest,
    ['schemaVersion', 'apiVersion', 'id', 'name', 'version', 'publisher', 'engines', 'permissions', 'marketplace', 'contributes', 'backend'],
    'manifest'
  )
  if (manifest.schemaVersion !== 2) fail('manifest schemaVersion must be 2')
  const apiVersion = stringValue(required(manifest, 'apiVersion', 'manifest'), 'manifest apiVersion')
  if (!VERSION_RANGE.test(apiVersion)) {
    fail('manifest apiVersion must be a simple semver range')
  }
  const id = stringValue(required(manifest, 'id', 'manifest'), 'manifest id')
  if (!PLUGIN_ID.test(id)) {
    fail(`manifest id must be lowercase dot-separated segments, got ${id}`)
  }
  const name = displayText(required(manifest, 'name', 'manifest'), 'manifest name')
  const version = stringValue(required(manifest, 'version', 'manifest'), 'manifest version')
  if (!SEMVER.test(version)) fail(`manifest version must be semver, got ${version}`)
  const publisher = stringValue(required(manifest, 'publisher', 'manifest'), 'manifest publisher')
  if (!PUBLISHER.test(publisher)) fail('manifest publisher must be lowercase')
  if (id.split('.', 1)[0] !== publisher) {
    fail('manifest publisher must match id namespace')
  }
  let engines: PluginManifestV2['engines'] | undefined
  if (manifest.engines !== undefined) {
    const parsedEngines = assertObject(manifest.engines, 'manifest engines')
    assertOnlyKeys(parsedEngines, ['navide'], 'manifest engines')
    engines = { navide: stringValue(required(parsedEngines, 'navide', 'manifest engines'), 'manifest engines.navide', 1) }
  }
  const permissions = parsePermissions(required(manifest, 'permissions', 'manifest'))
  const marketplace = parseMarketplace(required(manifest, 'marketplace', 'manifest'))
  if (manifest.contributes === undefined && manifest.backend === undefined) {
    fail('manifest must declare contributes or backend')
  }
  const contributes = manifest.contributes === undefined ? undefined : parseViews(manifest.contributes)
  const backend = manifest.backend === undefined ? undefined : parseBackend(manifest.backend)
  return {
    schemaVersion: 2,
    apiVersion,
    id,
    name,
    version,
    publisher,
    ...(engines ? { engines } : {}),
    permissions,
    marketplace,
    ...(contributes ? { contributes } : {}),
    ...(backend ? { backend } : {}),
  }
}

export function manifestReferencedFiles(manifest: PluginManifestV2): string[] {
  const paths: string[] = []
  for (const view of manifest.contributes?.views ?? []) {
    paths.push(view.entry)
    if (view.icon) paths.push(view.icon)
  }
  if (manifest.marketplace.icon) paths.push(manifest.marketplace.icon)
  if (manifest.backend) paths.push(manifest.backend.entry)
  return [...new Set(paths)]
}

function parseJsonString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') throw new Error('invalid JSON string')
  let cursor = start + 1
  while (cursor < text.length) {
    const char = text[cursor++]
    if (char === '\\') {
      cursor++
      continue
    }
    if (char === '"') {
      const raw = text.slice(start, cursor)
      const value = JSON.parse(raw)
      if (typeof value !== 'string') throw new Error('invalid JSON string')
      return { value, next: cursor }
    }
    if (char < ' ') throw new Error('invalid JSON string')
  }
  throw new Error('unterminated JSON string')
}

function assertUniqueJsonKeys(text: string): void {
  let cursor = 0
  const skipWhitespace = (): void => {
    while (/\s/.test(text[cursor] ?? '')) cursor += 1
  }
  const parseValue = (): void => {
    skipWhitespace()
    const char = text[cursor]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') {
      cursor = parseJsonString(text, cursor).next
      return
    }
    if (text.startsWith('true', cursor)) {
      cursor += 4
      return
    }
    if (text.startsWith('false', cursor)) {
      cursor += 5
      return
    }
    if (text.startsWith('null', cursor)) {
      cursor += 4
      return
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      cursor += number[0].length
      return
    }
    throw new Error('invalid JSON value')
  }
  const parseObject = (): void => {
    cursor += 1
    skipWhitespace()
    const keys = new Set<string>()
    if (text[cursor] === '}') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      skipWhitespace()
      const key = parseJsonString(text, cursor)
      cursor = key.next
      if (keys.has(key.value)) throw new PluginContractError(`duplicate JSON object key: ${key.value}`, 'INVALID_JSON')
      keys.add(key.value)
      skipWhitespace()
      if (text[cursor++] !== ':') throw new Error('invalid JSON object')
      parseValue()
      skipWhitespace()
      if (text[cursor] === '}') {
        cursor += 1
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON object')
    }
    throw new Error('unterminated JSON object')
  }
  const parseArray = (): void => {
    cursor += 1
    skipWhitespace()
    if (text[cursor] === ']') {
      cursor += 1
      return
    }
    while (cursor < text.length) {
      parseValue()
      skipWhitespace()
      if (text[cursor] === ']') {
        cursor += 1
        return
      }
      if (text[cursor++] !== ',') throw new Error('invalid JSON array')
    }
    throw new Error('unterminated JSON array')
  }
  parseValue()
  skipWhitespace()
  if (cursor !== text.length) throw new Error('trailing JSON data')
}

export function parseStrictJson(text: string, label = 'JSON'): unknown {
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} must not start with UTF-8 BOM`, 'INVALID_JSON')
  try {
    assertUniqueJsonKeys(text)
  } catch (error) {
    if (error instanceof PluginContractError) throw error
    fail(`${label} is not valid: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof PluginContractError) throw error
    fail(`${label} is not valid: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_JSON')
  }
}

export function parseManifestJson(text: string): Record<string, unknown> {
  const parsed = parseStrictJson(text, 'manifest JSON')
  if (!isRecord(parsed)) fail('manifest must be a JSON object')
  return parsed
}

export function parseExecutionPolicyJson(text: string): ExecutionPolicy {
  return parseExecutionPolicy(parseStrictJson(text, 'execution policy JSON'))
}

export const PLUGIN_ERROR_CODES = [
  'CAPABILITY_DENIED',
  'METHOD_NOT_FOUND',
  'INVALID_ARGUMENT',
  'WORKSPACE_SCOPE_VIOLATION',
  'USER_CANCELLED',
  'TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'PLUGIN_STOPPING',
  'STORAGE_QUOTA_EXCEEDED',
  'INTERNAL_ERROR',
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export class PluginError extends Error {
  constructor(
    readonly code: PluginErrorCode,
    message: string,
    readonly details?: JsonValue
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export interface PublicMethodParams {
  'fs.readFile': { path: string }
  'fs.writeFile': { path: string; content: string }
  'fs.readImage': { path: string }
  'fs.listDirectory': { path: string }
  'fs.listFilesFlat': { query?: string; maxResults?: number }
  'fs.glob': { pattern: string }
  'fs.stat': { path: string }
  'fs.statPath': { path: string }
  'ui.openInEditor': { path: string; line?: number; column?: number }
  'ui.openPlansWindow': { path: string }
  'ui.openExternal': { url: string }
  'aiCli.listProfiles': Record<string, never>
  'aiCli.startSession': { profileId: string; requestId?: string; cols: number; rows: number; yolo?: boolean }
  'aiCli.resumeSession': { cols: number; rows: number }
  'aiCli.cancelStart': { requestId: string }
  'aiCli.reattachSession': { sessionId: string; cols: number; rows: number }
  'aiCli.sendInput': { sessionId: string; data: string }
  'aiCli.resizeSession': { sessionId: string; cols: number; rows: number }
  'aiCli.redrawSession': { sessionId: string; cols: number; rows: number }
  'aiCli.interruptSession': { sessionId: string }
  'aiCli.stopSession': { sessionId: string; force: boolean }
  'shell.run': { command: string }
  'storage.get': { scope: StoragePartitionScope; key: string }
  'storage.set': { scope: StoragePartitionScope; key: string; value: JsonValue }
  'storage.delete': { scope: StoragePartitionScope; key: string }
}

export interface PublicMethodResults {
  'fs.readFile': { content: string }
  'fs.writeFile': { ok: boolean }
  'fs.readImage': { ok: boolean; data_url?: string }
  'fs.listDirectory': { entries: Array<{ name: string; kind: 'file' | 'directory' }> }
  'fs.listFilesFlat': { files?: string[] }
  'fs.glob': { paths: string[] }
  'fs.stat': { kind: 'file' | 'directory'; size: number; modifiedAt: string }
  'fs.statPath': { exists: boolean }
  'ui.openInEditor': { opened: boolean }
  'ui.openPlansWindow': { opened: boolean }
  'ui.openExternal': { opened: boolean }
  'aiCli.listProfiles': { profiles: Array<{ id: string; label: string }> }
  'aiCli.startSession': { sessionId: string }
  'aiCli.resumeSession': { sessionId: string; profileId: string } | null
  'aiCli.cancelStart': Record<string, never>
  'aiCli.reattachSession': { sessionId: string }
  'aiCli.sendInput': Record<string, never>
  'aiCli.resizeSession': Record<string, never>
  'aiCli.redrawSession': Record<string, never>
  'aiCli.interruptSession': Record<string, never>
  'aiCli.stopSession': Record<string, never>
  'shell.run': { exitCode: number; stdout: string; stderr: string }
  'storage.get': StorageGetResult
  'storage.set': null
  'storage.delete': boolean
}

export type PublicMethod = keyof PublicMethodParams
export type Params<M extends PublicMethod> = PublicMethodParams[M]
export type Result<M extends PublicMethod> = PublicMethodResults[M]

export interface PublicEventPayloads {
  'workspace.filesChanged': {
    changes: Array<{ path: string; kind: 'created' | 'changed' | 'deleted' }>
  }
  'aiCli.output': { sessionId: string; data: string }
  'aiCli.exited': { sessionId: string; exitCode: number | null }
}

export type PublicEvent = keyof PublicEventPayloads
export type Payload<E extends PublicEvent> = PublicEventPayloads[E]

export interface Disposable {
  dispose(): void
}

export { manifestV2Schema, capabilitiesV1, executionPolicyV1Schema }
