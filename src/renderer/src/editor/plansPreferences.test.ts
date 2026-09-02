// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { readLegacyPlansPreferenceProjection } from './plansPreferences'

afterEach(() => {
  localStorage.clear()
})

describe('legacy Plans preference projection', () => {
  it('reads only the fixed workspace-scoped preference allowlist', () => {
    const workspacePath = '/workspace/project'
    localStorage.setItem('navide.plans.filter./workspace/project', 'approved')
    localStorage.setItem('navide.plans.recent./workspace/project', '["old.html"]')
    localStorage.setItem('navide.plans.unknown./workspace/project', 'secret')

    expect(readLegacyPlansPreferenceProjection(workspacePath)).toEqual({
      'plans.filter': 'approved',
      'plans.recent': '["old.html"]',
    })
  })
})
