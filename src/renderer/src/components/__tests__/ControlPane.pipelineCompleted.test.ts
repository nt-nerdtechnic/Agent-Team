// @vitest-environment happy-dom
// The "pipeline completed" notice used to hard-code "all 4 stages" in the
// message itself. Pipelines are user-defined now, so the count has to come from
// the running pipeline rather than the translation.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const stage = (id: string, shortTitle: string) => ({
  id,
  title: shortTitle,
  shortTitle,
  question: '',
  description: '',
  recommendedRoles: [],
  sentinel: '',
  allowQuestions: false,
  docQuery: '',
  slots: [{ agentKey: 'claude', roleKey: '', label: shortTitle, kickoffBody: '', isCommander: false }],
})

function mountCompleted(totalStages: number, stageCount: number): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  const stages = Array.from({ length: stageCount }, (_, i) => stage(`0${i + 1}`, `S${i + 1}`))
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages,
      panes: [],
      pipeline: { state: 'completed', stageIndex: Math.max(0, totalStages - 1), totalStages },
      pipelines: [{ id: 'p1', name: 'Custom', builtin: false, stage_count: stageCount }],
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false, version: '', defaultModel: '', models: [], benchmarkResults: [],
      },
      autoAnswerEnabled: false,
      existingProject: null,
      workspace: '/tmp/ws',
      workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

describe('ControlPane – pipeline completed notice', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
  })

  async function openDetail(totalStages: number, stageCount: number): Promise<string> {
    wrapper = mountCompleted(totalStages, stageCount)
    ;(wrapper.vm as unknown as { openPipelineDetail: (id: string) => void }).openPipelineDetail('p1')
    await wrapper.vm.$nextTick()
    return wrapper.find('.hint.ok').text()
  }

  it('reports the running pipeline stage count, not a hard-coded 4', async () => {
    const text = await openDetail(3, 3)
    expect(text).toContain('all 3 stages')
    expect(text).not.toContain('4')
    expect(text).not.toContain('{count}')
  })

  it('follows a longer pipeline too', async () => {
    const text = await openDetail(7, 7)
    expect(text).toContain('all 7 stages')
    expect(text).not.toContain('{count}')
  })

  // A restored run can carry totalStages: 0; the count then falls back to the
  // stage list the pane was handed.
  it('falls back to the stage list when the run recorded no total', async () => {
    // Guard for the discriminator below: dropping the `|| stages.length`
    // fallback renders this, which is what the last assertion catches.
    expect(i18n.global.t('label.pipeline-completed', { count: 0 })).toContain('all 0 stages')

    const text = await openDetail(0, 3)
    expect(text).toContain('all 3 stages')
    expect(text).not.toContain('{count}')
    expect(text).not.toContain('all 0 stages')
  })
})
