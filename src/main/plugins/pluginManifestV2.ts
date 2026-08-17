import { InstalledPluginError } from './pluginManifestErrors'
import { canonicalHtmlPath, canonicalPackagePath } from './pluginPathPolicy'

const V2_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const V2_API_VERSION_RE = /^[~^]?\d+\.\d+\.\d+$/
const V2_VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const V2_PUBLISHER_RE = /^[a-z0-9][a-z0-9-]*$/
const V2_VIEW_ID_RE = /^[a-z][a-z0-9-]*$/
const V2_HTTPS_URI_RE = /^https:\/\/[^\s]+$/
export const V2_VIEW_LOCATIONS = ['top', 'bottom', 'right', 'left', 'main', 'window'] as const
export const V2_SYSTEM_NAMESPACES = ['fs', 'ui', 'aiCli'] as const
export const V2_SHELL_MODES = ['allowlist', 'full'] as const

/** Return whether a value is a canonical Manifest v2 package id. */
export function isValidManifestV2PluginId(value: unknown): value is string {
  return typeof value === 'string' && V2_ID_RE.test(value)
}

export type PluginSystemNamespace = (typeof V2_SYSTEM_NAMESPACES)[number]
export type PluginShellMode = (typeof V2_SHELL_MODES)[number]

export type PluginManifestV2Permissions = {
  system?: PluginSystemNamespace[]
  shell?: PluginShellMode
}

// Manifest-level guard for recognizable source/script filenames. Proving that
// archive bytes are the correct target executable belongs to the B8 packager.
const KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS = new Set([
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

type ParsedSemver = {
  core: [string, string, string]
  prerelease: string[]
}

function parseSemver(value: string): ParsedSemver | null {
  const match = V2_VERSION_RE.exec(value)
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new InstalledPluginError(message)
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) fail(`${label} must be a JSON object`)
  return value
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${label} has unknown field '${key}'`)
  }
}

function requiredValue(value: Record<string, unknown>, key: string, label: string): unknown {
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

function displayText(value: unknown, label: string): string {
  const text = stringValue(value, label, 1, 80)
  if (/\r|\n|[<>]/.test(text)) fail(`${label} contains unsafe characters`)
  return text
}

function stringArray(value: unknown, label: string, minItems = 0, maxItems?: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minItems ||
    (maxItems !== undefined && value.length > maxItems)
  ) {
    fail(
      `${label} must be an array with ${minItems}${maxItems === undefined ? '+' : `-${maxItems}`} item(s)`
    )
  }
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`, 0))
  if (new Set(result).size !== result.length) fail(`${label} must not contain duplicate items`)
  return result
}

function safePath(value: unknown, label: string): string {
  const path = stringValue(value, label, 1)
  if (canonicalPackagePath(path) === null) fail(`${label} is not a safe package-relative path`)
  return path
}

function backendEntry(value: unknown): string {
  const entry = safePath(value, 'manifest backend.entry')
  const filename = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase()
  const dot = filename.lastIndexOf('.')
  if (dot >= 0 && KNOWN_SOURCE_BACKEND_SCRIPT_EXTENSIONS.has(filename.slice(dot))) {
    fail('manifest backend.entry must reference a packaged executable, not a raw script')
  }
  return entry
}

function htmlPath(value: unknown, label: string): string {
  const path = stringValue(value, label, 1)
  if (canonicalHtmlPath(path) === null) fail(`${label} is not a safe package-relative HTML path`)
  return path
}

function assertUniqueViewIds(views: readonly PluginManifestV2View[]): void {
  const seen = new Set<string>()
  for (const view of views) {
    if (seen.has(view.id)) {
      fail(`manifest contributes.views contains duplicate id '${view.id}'`)
    }
    seen.add(view.id)
  }
}

export function parseManifestV2(raw: Record<string, unknown>): PluginManifestV2 {
  assertOnlyKeys(
    raw,
    [
      'schemaVersion',
      'apiVersion',
      'id',
      'name',
      'version',
      'publisher',
      'engines',
      'permissions',
      'marketplace',
      'contributes',
      'backend',
    ],
    'manifest'
  )
  if (raw.schemaVersion !== 2) fail('manifest schemaVersion must be 2')
  const apiVersion = stringValue(requiredValue(raw, 'apiVersion', 'manifest'), 'manifest apiVersion', 1)
  if (!V2_API_VERSION_RE.test(apiVersion)) fail('manifest apiVersion must be a simple semver range')
  const id = stringValue(requiredValue(raw, 'id', 'manifest'), 'manifest id', 1)
  if (!V2_ID_RE.test(id)) fail(`manifest id must be lowercase dot-separated segments, got ${id}`)
  const name = displayText(requiredValue(raw, 'name', 'manifest'), 'manifest name')
  const version = stringValue(requiredValue(raw, 'version', 'manifest'), 'manifest version', 1)
  if (!V2_VERSION_RE.test(version)) fail(`manifest version must be semver, got ${version}`)
  const publisher = stringValue(requiredValue(raw, 'publisher', 'manifest'), 'manifest publisher', 1)
  if (!V2_PUBLISHER_RE.test(publisher)) fail('manifest publisher must be lowercase')
  if (id.split('.', 1)[0] !== publisher) {
    fail('manifest publisher must match id namespace')
  }

  let engines: { navide: string } | undefined
  if (raw.engines !== undefined) {
    const value = assertObject(raw.engines, 'manifest engines')
    assertOnlyKeys(value, ['navide'], 'manifest engines')
    engines = {
      navide: stringValue(
        requiredValue(value, 'navide', 'manifest engines'),
        'manifest engines.navide',
        1
      ),
    }
  }

  const permissionsValue = assertObject(
    requiredValue(raw, 'permissions', 'manifest'),
    'manifest permissions'
  )
  assertOnlyKeys(permissionsValue, ['system', 'shell'], 'manifest permissions')
  const permissions: PluginManifestV2Permissions = {}
  if (permissionsValue.system !== undefined) {
    const namespaces = stringArray(permissionsValue.system, 'manifest permissions.system', 1, 3)
    if (namespaces.some((namespace) => !(V2_SYSTEM_NAMESPACES as readonly string[]).includes(namespace))) {
      fail('manifest permissions.system contains an unknown namespace')
    }
    permissions.system = namespaces as PluginSystemNamespace[]
  }
  if (permissionsValue.shell !== undefined) {
    const shell = stringValue(permissionsValue.shell, 'manifest permissions.shell', 1)
    if (!(V2_SHELL_MODES as readonly string[]).includes(shell)) {
      fail('manifest permissions.shell must be allowlist or full')
    }
    permissions.shell = shell as PluginShellMode
  }

  const marketplaceValue = assertObject(
    requiredValue(raw, 'marketplace', 'manifest'),
    'manifest marketplace'
  )
  assertOnlyKeys(
    marketplaceValue,
    ['description', 'license', 'repository', 'homepage', 'categories', 'icon'],
    'manifest marketplace'
  )
  const description = stringValue(
    requiredValue(marketplaceValue, 'description', 'manifest marketplace'),
    'manifest marketplace.description',
    1,
    280
  )
  if (/\r|\n|[<>]/.test(description)) {
    fail('manifest marketplace.description contains unsafe characters')
  }
  const license = stringValue(
    requiredValue(marketplaceValue, 'license', 'manifest marketplace'),
    'manifest marketplace.license',
    1,
    100
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9.()+ -]*$/.test(license)) {
    fail('manifest marketplace.license is not a safe SPDX expression')
  }
  const marketplace: PluginManifestV2['marketplace'] = { description, license }
  for (const key of ['repository', 'homepage'] as const) {
    if (marketplaceValue[key] !== undefined) {
      const uri = stringValue(marketplaceValue[key], `manifest marketplace.${key}`, 1, 2048)
      if (!V2_HTTPS_URI_RE.test(uri)) fail(`manifest marketplace.${key} must be an HTTPS URL`)
      marketplace[key] = uri
    }
  }
  if (marketplaceValue.categories !== undefined) {
    const categories = stringArray(
      marketplaceValue.categories,
      'manifest marketplace.categories',
      0,
      5
    )
    for (const category of categories) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(category)) {
        fail('manifest marketplace.categories contains an invalid slug')
      }
    }
    marketplace.categories = categories
  }
  if (marketplaceValue.icon !== undefined) {
    marketplace.icon = safePath(marketplaceValue.icon, 'manifest marketplace.icon')
  }

  let contributes: PluginManifestV2['contributes']
  if (raw.contributes !== undefined) {
    const value = assertObject(raw.contributes, 'manifest contributes')
    assertOnlyKeys(value, ['views'], 'manifest contributes')
    if (!Array.isArray(value.views) || value.views.length < 1) {
      fail('manifest contributes.views must contain at least one view')
    }
    if (value.views.length > 16) {
      fail('manifest contributes.views must contain between 1 and 16 views')
    }
    const views: PluginManifestV2View[] = value.views.map((rawView, index) => {
      const view = assertObject(rawView, `manifest contributes.views[${index}]`)
      assertOnlyKeys(
        view,
        ['id', 'kind', 'location', 'title', 'icon', 'entry'],
        `manifest contributes.views[${index}]`
      )
      const viewId = stringValue(
        requiredValue(view, 'id', `manifest contributes.views[${index}]`),
        `manifest contributes.views[${index}].id`,
        1
      )
      if (!V2_VIEW_ID_RE.test(viewId)) fail(`manifest contributes.views[${index}].id is invalid`)
      if (view.kind !== 'custom') fail(`manifest contributes.views[${index}].kind must be custom`)
      const location = stringValue(
        requiredValue(view, 'location', `manifest contributes.views[${index}]`),
        `manifest contributes.views[${index}].location`,
        1
      )
      if (!(V2_VIEW_LOCATIONS as readonly string[]).includes(location)) {
        fail(`manifest contributes.views[${index}].location is unsupported`)
      }
      const title = displayText(
        requiredValue(view, 'title', `manifest contributes.views[${index}]`),
        `manifest contributes.views[${index}].title`
      )
      const entry = htmlPath(
        requiredValue(view, 'entry', `manifest contributes.views[${index}]`),
        `manifest contributes.views[${index}].entry`
      )
      const result: PluginManifestV2View = {
        id: viewId,
        kind: 'custom',
        location: location as PluginManifestV2View['location'],
        title,
        entry,
      }
      if (view.icon !== undefined) {
        result.icon = safePath(view.icon, `manifest contributes.views[${index}].icon`)
      }
      return result
    })
    assertUniqueViewIds(views)
    contributes = { views }
  }

  let backend: PluginManifestV2['backend']
  if (raw.backend !== undefined) {
    const value = assertObject(raw.backend, 'manifest backend')
    assertOnlyKeys(value, ['entry', 'protocolVersion', 'activation'], 'manifest backend')
    if (value.protocolVersion !== 1) fail('manifest backend.protocolVersion must be 1')
    if (value.activation !== 'startup') fail('manifest backend.activation must be startup')
    backend = {
      entry: backendEntry(requiredValue(value, 'entry', 'manifest backend')),
      protocolVersion: 1,
      activation: 'startup',
    }
  }
  if (!contributes && !backend) fail('manifest must declare contributes or backend')

  return {
    schemaVersion: 2,
    apiVersion,
    id,
    name,
    version,
    publisher,
    engines,
    permissions,
    marketplace,
    contributes,
    backend,
  }
}
