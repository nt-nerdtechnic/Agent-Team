import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginPublisherTrustStore } from './pluginPublisherTrust'

describe('PluginPublisherTrustStore', () => {
  let root: string
  let file: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-publisher-trust-'))
    file = join(root, 'publisher-trust.json')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('persists publisher consent independently of package-version grants', () => {
    const store = new PluginPublisherTrustStore(file)
    expect(store.isTrusted('acme', 'acme.demo')).toBe(false)

    store.trust('acme', 'acme.demo')

    expect(new PluginPublisherTrustStore(file).isTrusted('acme', 'acme.demo')).toBe(true)
    expect(new PluginPublisherTrustStore(file).isTrusted('acme', 'acme.other')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      trustedPackages: [{ publisherId: 'acme', packageId: 'acme.demo' }],
    })
  })

  it('can revoke a publisher without changing any capability grant', () => {
    const store = new PluginPublisherTrustStore(file)
    store.trust('acme', 'acme.demo')
    store.revoke('acme', 'acme.demo')
    expect(new PluginPublisherTrustStore(file).isTrusted('acme', 'acme.demo')).toBe(false)
  })

  it('rejects duplicate and unknown trust fields instead of silently widening consent', () => {
    writeFileSync(
      file,
      '{"schemaVersion":1,"trustedPackages":[],"trustedPackages":[{"publisherId":"acme","packageId":"acme.demo"}]}'
    )
    expect(new PluginPublisherTrustStore(file).isTrusted('acme', 'acme.demo')).toBe(false)

    writeFileSync(
      file,
      '{"schemaVersion":1,"trustedPackages":[{"publisherId":"acme","packageId":"acme.demo","allPackages":true}]}'
    )
    expect(new PluginPublisherTrustStore(file).isTrusted('acme', 'acme.demo')).toBe(false)
  })
})
