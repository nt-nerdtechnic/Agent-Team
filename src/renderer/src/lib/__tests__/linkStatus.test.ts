// What each input produces, rather than what strings are still in a file.
//
// These two decisions used to be inline in their components, where the only
// available check was "the key is mentioned somewhere" — which passes a
// classifier wired to the wrong branch, and the test name claimed the opposite.
import { describe, expect, it } from 'vitest'

import { disabledReasonKey, linkErrorKey } from '../linkStatus'

describe('linkErrorKey', () => {
  it('names the four failures a person can act on differently', () => {
    // Wait, check the address, or sign in again — the answers differ, so the
    // sentences have to.
    expect(linkErrorKey('timed out during opening handshake')).toBe('err-timeout')
    expect(linkErrorKey('[Errno 61] Connection refused')).toBe('err-refused')
    expect(linkErrorKey("[Errno 8] nodename nor servname provided")).toBe('err-dns')
    expect(linkErrorKey('certificate verify failed')).toBe('err-tls')
    expect(linkErrorKey('Connection reset by peer')).toBe('err-reset')
  })

  it('does not confuse one failure for another', () => {
    // The check that matters: a classifier wired to the wrong branch keeps
    // every string in the file and shows the wrong sentence.
    expect(linkErrorKey('[Errno 61] Connection refused')).not.toBe('err-timeout')
    expect(linkErrorKey('timed out')).not.toBe('err-refused')
    expect(linkErrorKey('getaddrinfo failed')).not.toBe('err-tls')
  })

  it('reads the words wherever they appear, and whatever the case', () => {
    // These arrive as Python exception text, which is not a format anybody
    // promised to keep stable.
    expect(linkErrorKey('TimeoutError')).toBe('err-timeout')
    expect(linkErrorKey('ConnectionRefusedError')).toBe('err-refused')
    expect(linkErrorKey('SSL: CERTIFICATE_VERIFY_FAILED')).toBe('err-tls')
    expect(linkErrorKey('Broken pipe')).toBe('err-reset')
  })

  it('says nothing about a failure it has never seen', () => {
    // A friendly sentence invented for an unknown error replaces the only clue
    // with a guess; the caller shows the original instead.
    expect(linkErrorKey('something entirely new')).toBeNull()
    expect(linkErrorKey('')).toBeNull()
  })
})

describe('disabledReasonKey', () => {
  const base = { linkReason: '', busy: false, editable: true }

  it('gives each of the three reasons its own answer', () => {
    expect(disabledReasonKey({ ...base, linkReason: 'connecting…' })).toBe('connecting…')
    expect(disabledReasonKey({ ...base, busy: true })).toBe('policy.saving')
    expect(disabledReasonKey({ ...base, editable: false })).toBe('policy.readonly-short')
  })

  it('does not answer one reason with another', () => {
    // "Saving" and "read-only" are both not-connected-shaped if you squint,
    // and telling all three "not connected" sends two of them to the network.
    expect(disabledReasonKey({ ...base, busy: true })).not.toBe('policy.readonly-short')
    expect(disabledReasonKey({ ...base, editable: false })).not.toBe('policy.saving')
  })

  it('puts the link first, because it is the reason with a countdown', () => {
    expect(
      disabledReasonKey({ linkReason: 'not connected', busy: true, editable: false }),
    ).toBe('not connected')
  })

  it('says nothing when nothing is wrong', () => {
    expect(disabledReasonKey(base)).toBeNull()
  })
})
