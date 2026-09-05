// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

describe('Plans build provenance', () => {
  it('publishes the compiled build id and Host-selected package identity for DevTools', async () => {
    window.history.replaceState({}, '', '?plans_package_version=0.1.93&plans_package_source=factory-dev')
    vi.resetModules()
    const { plansBuildProvenance } = await import('./provenance')
    expect(plansBuildProvenance).toEqual({
      buildId: expect.any(String),
      packageVersion: '0.1.93',
      packageSource: 'factory-dev',
    })
  })
})
