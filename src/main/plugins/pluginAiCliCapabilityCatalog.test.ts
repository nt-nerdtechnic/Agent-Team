import { describe, expect, it } from 'vitest'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'

describe('public AI CLI capability catalog', () => {
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
