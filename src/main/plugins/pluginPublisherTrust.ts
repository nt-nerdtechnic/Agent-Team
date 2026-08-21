import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  assertExactTrustFields,
  readHostTrustJsonObject,
  requireTrustObject,
} from './pluginTrustJson'

interface PublisherTrustDocument {
  schemaVersion: 1
  trustedPackages: Array<{ publisherId: string; packageId: string }>
}

function emptyDocument(): PublisherTrustDocument {
  return { schemaVersion: 1, trustedPackages: [] }
}

/** Host-owned publisher consent. Cryptographic trust and capability grants
 * deliberately live elsewhere. Consent is publisher + package scoped (and
 * version-independent): trusting one package never trusts every package that
 * the same publisher can upload. */
export class PluginPublisherTrustStore {
  constructor(private readonly filePath: string) {}

  isTrusted(publisherId: string, packageId: string): boolean {
    return this.read().trustedPackages.some(
      (item) => item.publisherId === publisherId && item.packageId === packageId
    )
  }

  trust(publisherId: string, packageId: string): void {
    const publisher = publisherId.trim()
    const plugin = packageId.trim()
    if (!publisher || !plugin) throw new Error('publisher and package ids are required')
    const document = this.read()
    if (this.isTrustedEntry(document, publisher, plugin)) return
    document.trustedPackages.push({ publisherId: publisher, packageId: plugin })
    document.trustedPackages.sort((left, right) =>
      `${left.publisherId}/${left.packageId}`.localeCompare(`${right.publisherId}/${right.packageId}`)
    )
    this.write(document)
  }

  revoke(publisherId: string, packageId: string): void {
    const document = this.read()
    const next = document.trustedPackages.filter(
      (item) => item.publisherId !== publisherId || item.packageId !== packageId
    )
    if (next.length === document.trustedPackages.length) return
    document.trustedPackages = next
    this.write(document)
  }

  private isTrustedEntry(
    document: PublisherTrustDocument,
    publisherId: string,
    packageId: string
  ): boolean {
    return document.trustedPackages.some(
      (item) => item.publisherId === publisherId && item.packageId === packageId
    )
  }

  private read(): PublisherTrustDocument {
    try {
      const value = readHostTrustJsonObject(this.filePath, 'publisher trust document')
      assertExactTrustFields(value, 'publisher trust document', [
        'schemaVersion',
        'trustedPackages',
      ])
      if (
        value.schemaVersion !== 1 ||
        !Array.isArray(value.trustedPackages)
      ) {
        return emptyDocument()
      }
      for (const [index, item] of value.trustedPackages.entries()) {
        const entry = requireTrustObject(item, `publisher trust document.trustedPackages[${index}]`)
        assertExactTrustFields(entry, `publisher trust document.trustedPackages[${index}]`, [
          'publisherId',
          'packageId',
        ])
        if (typeof entry.publisherId !== 'string' || typeof entry.packageId !== 'string') {
          return emptyDocument()
        }
      }
      return value as unknown as PublisherTrustDocument
    } catch {
      return emptyDocument()
    }
  }

  private write(document: PublisherTrustDocument): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
    renameSync(temporary, this.filePath)
  }
}
