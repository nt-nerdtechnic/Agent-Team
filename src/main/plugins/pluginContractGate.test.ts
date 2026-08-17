import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
import { parseBackendWireFrame } from './pluginBackendSupervisor'
import { readManifestFromEntries, type ZipEntry } from './pluginPackage'

const CONTRACT_FIXTURES = join(process.cwd(), 'docs/plugin-contracts')
const MANIFEST_FIXTURES = join(CONTRACT_FIXTURES, 'fixtures')
const WIRE_FIXTURES = join(CONTRACT_FIXTURES, 'backend-wire-fixtures')

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
const rawWireFixtures = readdirSync(join(WIRE_FIXTURES, 'invalid-raw'))
  .filter((name) => name.endsWith('.json'))
  .sort()

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

  it.each(rawWireFixtures)('rejects raw Backend Wire input %s at the Host framing seam', (name) => {
    const raw = readFileSync(join(WIRE_FIXTURES, 'invalid-raw', name), 'utf8')
    expect(() => parseBackendWireFrame(raw)).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })
})
