import { describe, expect, it } from 'vitest'
import {
  assertExactTrustFields,
  parseHostTrustJsonObject,
} from './pluginTrustJson'

describe('parseHostTrustJsonObject', () => {
  it('parses a JSON object with unique keys', () => {
    expect(parseHostTrustJsonObject('{"schemaVersion":1}', 'trust document')).toEqual({
      schemaVersion: 1,
    })
  })

  it('rejects a UTF-8 BOM before parsing', () => {
    expect(() => parseHostTrustJsonObject('\ufeff{}', 'trust document')).toThrow(/BOM/)
  })

  it('rejects duplicate keys before JSON.parse can overwrite them', () => {
    expect(() =>
      parseHostTrustJsonObject('{"rootPublicKeyPem":"first","rootPublicKeyPem":"second"}', 'trust document')
    ).toThrow(/duplicate JSON object key: rootPublicKeyPem/)
  })

  it('rejects invalid JSON and non-object roots', () => {
    expect(() => parseHostTrustJsonObject('{', 'trust document')).toThrow(/not valid JSON/)
    expect(() => parseHostTrustJsonObject('[]', 'trust document')).toThrow(/must be a JSON object/)
  })

  it('rejects unknown schema fields at the caller boundary', () => {
    const value = parseHostTrustJsonObject('{"schemaVersion":1,"unexpected":true}', 'trust document')
    expect(() => assertExactTrustFields(value, 'trust document', ['schemaVersion'])).toThrow(
      /unknown fields.*unexpected/
    )
  })
})
