declare const __NAVIDE_PLANS_BUILD_ID__: string

export interface PlansBuildProvenance {
  readonly buildId: string
  readonly packageVersion: string
  readonly packageSource: string
}

const compiledBuildId = typeof __NAVIDE_PLANS_BUILD_ID__ === 'string'
  ? __NAVIDE_PLANS_BUILD_ID__
  : 'test-build'

function queryValue(name: string): string {
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? ''
}

export const plansBuildProvenance: PlansBuildProvenance = Object.freeze({
  buildId: compiledBuildId,
  packageVersion: queryValue('plans_package_version') || 'unknown',
  packageSource: queryValue('plans_package_source') || 'unknown',
})

declare global {
  interface Window {
    __NAVIDE_PLANS_PROVENANCE__?: PlansBuildProvenance
  }
}
