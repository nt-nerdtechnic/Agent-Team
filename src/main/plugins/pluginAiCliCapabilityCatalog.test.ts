import { describe, expect, it } from 'vitest'
import { capabilitiesV1 } from '../../../packages/plugin-contracts/src/index'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'

const AI_CONTRACT_CASES = [
  {
    address: 'aiCli.reattachSession',
    required: ['sessionId', 'cols', 'rows'],
    valid: { sessionId: 'session-1', cols: 100, rows: 30 },
    invalid: [{ sessionId: 'session-1' }, { sessionId: 'session-1', cols: 0, rows: 30 }],
  },
  {
    address: 'aiCli.redrawSession',
    required: ['sessionId', 'cols', 'rows'],
    valid: { sessionId: 'session-1', cols: 100, rows: 30 },
    invalid: [{ sessionId: 'session-1' }, { sessionId: 'session-1', cols: 0, rows: 30 }],
  },
  {
    address: 'aiCli.stopSession',
    required: ['sessionId', 'force'],
    valid: { sessionId: 'session-1', force: true },
    invalid: [{ sessionId: 'session-1' }, { sessionId: 'session-1', force: 'true' }],
  },
] as const

describe('public AI CLI capability catalog', () => {
  it.each(AI_CONTRACT_CASES)('$address has matching schema and Host validator rules', ({ address, required, valid, invalid }) => {
    const schemaMethod = (capabilitiesV1 as {
      methods: Array<{ address: string; params: { required?: string[]; properties?: Record<string, unknown> } }>
    }).methods.find((method) => method.address === address)
    const catalogEntry = PUBLIC_CAPABILITY_CATALOG[address]

    expect(schemaMethod).toBeDefined()
    expect(catalogEntry).toBeDefined()
    expect(schemaMethod?.params.required).toEqual(required)
    for (const key of required) expect(schemaMethod?.params.properties).toHaveProperty(key)
    expect(catalogEntry?.validateRequest?.(valid)).toBe(true)
    for (const value of invalid) expect(catalogEntry?.validateRequest?.(value)).toBe(false)
  })

  it('keeps the complete schema AI method set in the executable catalog', () => {
    const schemaAddresses = (capabilitiesV1 as { methods: Array<{ address: string }> }).methods
      .map(({ address }) => address)
      .filter((address) => address.startsWith('aiCli.'))
    const catalogAddresses = Object.keys(PUBLIC_CAPABILITY_CATALOG)
      .filter((address) => address.startsWith('aiCli.') && PUBLIC_CAPABILITY_CATALOG[address]?.kind === 'method')
    expect(catalogAddresses).toEqual(schemaAddresses)
  })

  it('accepts Host-owned profile listing and tuple-owned resume requests', () => {
    expect(PUBLIC_CAPABILITY_CATALOG['aiCli.listProfiles']?.validateRequest?.({})).toBe(true)
    expect(PUBLIC_CAPABILITY_CATALOG['aiCli.resumeSession']?.validateRequest?.({ cols: 100, rows: 30 })).toBe(true)
  })

  it('does not accept a renderer-selected session id for resume', () => {
    expect(PUBLIC_CAPABILITY_CATALOG['aiCli.resumeSession']?.validateRequest?.({
      sessionId: 'foreign-session',
      cols: 100,
      rows: 30,
    })).toBe(false)
  })

  it('accepts the documented unattended-mode flag on start', () => {
    expect(PUBLIC_CAPABILITY_CATALOG['aiCli.startSession']?.validateRequest?.({
      profileId: 'codex',
      cols: 100,
      rows: 30,
      yolo: true,
    })).toBe(true)
  })
})
