import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonicalJson'

// The backend pins the same literal in backend/tests/test_ws_handlers_trust.py
// (test_canonical_json_matches_the_renderer_fixture_literally). The fixture was
// chosen to exercise every rule the two implementations must agree on: key
// order, nested objects and arrays, a tab and quotes and a backslash and a
// slash, U+2028, an astral character (surrogate pair) and DEL.
const FIXTURE = {"version": 1, "default": "deny", "rules": [{"to": {"paneName": "審查者", "workspace": "/w/α"}, "from": {"deviceId": "d-1", "memberId": "m-1"}, "action": "allow"}], "blocked": [], "note": "tab\there \"q\" \\ /slash 😀"}
const EXPECTED = "{\"blocked\":[],\"default\":\"deny\",\"note\":\"tab\\there \\\"q\\\" \\\\ /slash\\u2028\\ud83d\\ude00\\u007f\",\"rules\":[{\"action\":\"allow\",\"from\":{\"deviceId\":\"d-1\",\"memberId\":\"m-1\"},\"to\":{\"paneName\":\"\\u5be9\\u67e5\\u8005\",\"workspace\":\"/w/\\u03b1\"}}],\"version\":1}"

describe('canonicalJson', () => {
  it('spells the fixture exactly as the backend does', () => {
    expect(canonicalJson(FIXTURE)).toBe(EXPECTED)
  })

  it('is insensitive to key order and whitespace, which is the point', () => {
    const a = canonicalJson({ version: 1, default: 'deny', rules: [] })
    const b = canonicalJson({ rules: [], default: 'deny', version: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"default":"deny","rules":[],"version":1}')
  })

  it('refuses values that have no JSON spelling rather than guessing', () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError)
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
  })
})
