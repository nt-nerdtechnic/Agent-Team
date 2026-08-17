import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseManifestJson as parsePublicManifestJson,
  parseManifestV2 as parsePublicManifestV2,
} from '../../../packages/plugin-contracts/src/index'
import {
  parseInstalledManifest,
  parseManifestJson as parseHostManifestJson,
} from './pluginManifest'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { planPublicCapabilityCall } from './pluginCapabilityBroker'
import { parseBackendWireFrame, parseBackendWireHostFrame } from './pluginBackendSupervisor'
import { readManifestFromEntries, type ZipEntry } from './pluginPackage'

const CONTRACT_FIXTURES = join(process.cwd(), 'docs/plugin-contracts')
const MANIFEST_FIXTURES = join(CONTRACT_FIXTURES, 'fixtures')
const WIRE_FIXTURES = join(CONTRACT_FIXTURES, 'backend-wire-fixtures')
const BACKEND_WIRE_CHILD = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))

const validManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const invalidManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const rawManifestFixtures = readdirSync(join(MANIFEST_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const validWireFixtures = readdirSync(join(WIRE_FIXTURES, 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const invalidWireFixtures = readdirSync(join(WIRE_FIXTURES, 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort()
const rawWireFixtures = readdirSync(join(WIRE_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()

const childToHostWireFixtures = [
  'application-error-without-id.json',
  'error-with-server-info.json',
  'malformed-server-info.json',
  'missing-result-type.json',
  'missing-result-value.json',
  'missing-server-info.json',
  'subscription-close-missing-id.json',
]
const hostToChildWireFixtures = [
  'missing-mcp-meta.json',
  'null-request-id.json',
  'spoofed-runtime-context.json',
  'unknown-wire-method.json',
  'wrong-mcp-version.json',
]

function readFixture(group: string, name: string): string {
  return readFileSync(join(MANIFEST_FIXTURES, group, name), 'utf8')
}

function manifestEntry(raw: string): ZipEntry {
  return {
    path: 'manifest.json',
    data: Buffer.from(raw, 'utf8'),
    kind: 'file',
    type: 'regular',
    executable: false,
  }
}

function runtimeContext() {
  return {
    publisherEligible: false,
    userGrant: {
      packageVersion: '1.0.0',
      system: ['fs', 'ui'] as const,
      shell: 'allowlist' as const,
    },
    runtimeBinding: {
      pluginId: 'acme.files',
      packageVersion: '1.0.0',
      workspaceId: 'workspace-1',
      instanceId: 'instance-1',
      audience: 'view-1',
    },
  }
}

describe('B0 integrated Manifest v2 corpus gate', () => {
  it.each(validManifestFixtures)('accepts %s through public, Host, and package seams', (name) => {
    const raw = readFixture('valid', name)
    const source = parsePublicManifestJson(raw)
    const publicManifest = parsePublicManifestV2(source)
    const hostManifest = parseInstalledManifest(source)
    const packageManifest = readManifestFromEntries([manifestEntry(raw)])

    expect(hostManifest).toEqual(publicManifest)
    expect(parseInstalledManifest(packageManifest)).toEqual(publicManifest)
  })

  it.each(invalidManifestFixtures)('rejects %s through public, Host, and package seams', (name) => {
    const raw = readFixture('invalid', name)
    const source = parsePublicManifestJson(raw)

    expect(() => parsePublicManifestV2(source)).toThrow()
    expect(() => parseInstalledManifest(source)).toThrow()
    expect(() => parseInstalledManifest(readManifestFromEntries([manifestEntry(raw)]))).toThrow()
  })

  it.each(rawManifestFixtures)('rejects raw Manifest input %s before schema validation', (name) => {
    const raw = readFixture('invalid-raw', name)

    expect(() => parsePublicManifestJson(raw)).toThrow()
    expect(() => parseHostManifestJson(raw)).toThrow()
    expect(() => readManifestFromEntries([manifestEntry(raw)])).toThrow()
  })
})

describe('B0 capability and Backend Wire contract gate', () => {
  it('allows declared fs/Git access and denies unsafe or undeclared shell calls', () => {
    const manifest = parsePublicManifestV2(
      parsePublicManifestJson(readFixture('valid', 'frontend-multi-view.json'))
    )
    const policy = manifestV2CapabilityPolicy(manifest.permissions)
    const context = runtimeContext()

    const fsDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'fs',
        method: 'readFile',
        args: { path: 'README.md' },
        reqId: 'fs-1',
      },
      policy,
      context
    )
    expect(fsDecision.kind).toBe('allow')

    const gitDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'shell',
        method: 'run',
        args: { command: 'git status' },
        reqId: 'git-1',
      },
      policy,
      context
    )
    expect(gitDecision.kind).toBe('allow')

    const unsafeShellDecision = planPublicCapabilityCall(
      {
        pluginId: manifest.id,
        ns: 'shell',
        method: 'run',
        args: { command: 'python -c unsafe' },
        reqId: 'shell-1',
      },
      policy,
      context
    )
    expect(unsafeShellDecision).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })

    const undeclaredShellDecision = planPublicCapabilityCall(
      {
        pluginId: 'navide.skills',
        ns: 'shell',
        method: 'run',
        args: { command: 'git status' },
        reqId: 'shell-2',
      },
      manifestV2CapabilityPolicy({}),
      {
        publisherEligible: false,
        userGrant: { packageVersion: '1.0.0', system: [] },
        runtimeBinding: {
          pluginId: 'navide.skills',
          packageVersion: '1.0.0',
          workspaceId: 'workspace-1',
          instanceId: 'instance-1',
          audience: 'view-1',
        },
      }
    )
    expect(undeclaredShellDecision).toMatchObject({
      kind: 'deny',
      response: { error: { code: 'CAPABILITY_DENIED' } },
    })
  })

  it.each(validWireFixtures)('accepts the valid Backend Wire frame %s at the Host framing seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'valid', name), 'utf8').trimEnd()
    expect(() => parseBackendWireFrame(raw)).not.toThrow()
  })

  it('classifies every semantic-invalid Backend Wire fixture by direction', () => {
    expect([...childToHostWireFixtures, ...hostToChildWireFixtures].sort()).toEqual(invalidWireFixtures)
  })

  it.each(childToHostWireFixtures)('rejects child-to-Host semantic-invalid fixture %s at the Host seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid', name), 'utf8').trimEnd()

    expect(() => parseBackendWireHostFrame(raw)).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })

  it.each(hostToChildWireFixtures)('returns a stable child protocol error for Host-to-child fixture %s', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid', name), 'utf8').trimEnd()
    const input = JSON.parse(raw) as { id?: unknown }
    const result = spawnSync(process.execPath, [BACKEND_WIRE_CHILD], {
      encoding: 'utf8',
      input: `${raw}\n`,
      maxBuffer: 1_000_000,
      timeout: 5_000,
    })
    const expected: { jsonrpc: '2.0'; error: { code: -32600; message: 'Invalid request' }; id?: string | number } = {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid request' },
    }
    if (
      (typeof input.id === 'string' && input.id.length > 0) ||
      (typeof input.id === 'number' && Number.isInteger(input.id))
    ) {
      expected.id = input.id
    }

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(result.stdout.trim())).toEqual(expected)
  })

  it.each(rawWireFixtures)('rejects raw Backend Wire input %s at the Host framing seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid-raw', name), 'utf8')
    expect(() => parseBackendWireFrame(raw)).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })
})
