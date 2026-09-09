// @vitest-environment happy-dom
// An unfinished run belongs to exactly ONE pipeline. Offering Resume while a
// DIFFERENT pipeline is active resumed stage N of pipeline A against pipeline
// B's stage list, so the card is gated on a match — but gating it away left the
// user with an unfinished run and NOTHING on screen saying so, and made
// App.vue's "switch to the run's pipeline, then resume" branch unreachable.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane, { type ExistingProjectInfo } from '../ControlPane.vue'

const pipelines = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 6 },
  { id: 'custom', name: 'Release Train', builtin: false, stage_count: 4 },
]

const project = (over: Partial<ExistingProjectInfo> = {}): ExistingProjectInfo => ({
  projectId: 'p1',
  name: 'demo',
  state: 'aborted',
  taskDescription: 'ship the thing',
  currentStageIndex: 1,
  totalStages: 4,
  stagesCompleted: 2,
  nextStageIndex: 2,
  updatedAt: '2026-09-09',
  projectFile: '/tmp/ws/.agent-team/project.json',
  pipelineId: 'custom',
  runCount: 1,
  ...over,
})

function mountWith(
  existingProject: ExistingProjectInfo | null,
  activePipelineId: string
): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages: [],
      panes: [],
      pipeline: { state: 'idle' },
      pipelines,
      activePipelineId,
      existingProject,
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false, version: '', defaultModel: '', models: [], benchmarkResults: [],
      },
      autoAnswerEnabled: false,
      workspace: '/tmp/ws',
      workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

describe('ControlPane – resume card when the run belongs to another pipeline', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
  })

  it('shows exactly one card, the mismatch one, when the pipelines differ', () => {
    wrapper = mountWith(project(), 'default')

    expect(wrapper.findAll('.resume-mismatch-card')).toHaveLength(1)
    // The real Resume card must stay gated — that is the bug it was added for.
    expect(wrapper.findAll('.resume-card')).toHaveLength(0)
  })

  it('names the pipeline the run belongs to', () => {
    wrapper = mountWith(project(), 'default')

    const text = wrapper.find('.resume-mismatch-card').text()
    expect(text).toContain('Release Train')
    expect(text).toBe(
      i18n.global.t('label.resume-other-pipeline', { name: 'Release Train' }) +
        i18n.global.t('action.switch-and-resume')
    )
  })

  it('falls back to the raw id when the pipeline is gone from the list', () => {
    wrapper = mountWith(project({ pipelineId: 'deleted-one' }), 'default')

    expect(wrapper.find('.resume-mismatch-card').text()).toContain('deleted-one')
  })

  it('resuming from the mismatch card emits pipeline-resume, which switches first', () => {
    wrapper = mountWith(project(), 'default')

    wrapper.find('.resume-mismatch-card button').trigger('click')

    expect(wrapper.emitted('pipeline-resume')).toHaveLength(1)
  })

  it('shows the normal card and no mismatch card when the pipelines match', () => {
    wrapper = mountWith(project({ pipelineId: 'default' }), 'default')

    expect(wrapper.findAll('.resume-card')).toHaveLength(1)
    expect(wrapper.findAll('.resume-mismatch-card')).toHaveLength(0)
  })

  it('shows neither card when there is nothing to resume', () => {
    wrapper = mountWith(project({ nextStageIndex: -1 }), 'default')

    expect(wrapper.findAll('.resume-card')).toHaveLength(0)
    expect(wrapper.findAll('.resume-mismatch-card')).toHaveLength(0)
  })

  it('a run with no recorded pipeline still gets the plain card', () => {
    // Pre-dates per-pipeline projects; it stays resumable as it always was.
    wrapper = mountWith(project({ pipelineId: '' }), 'default')

    expect(wrapper.findAll('.resume-card')).toHaveLength(1)
    expect(wrapper.findAll('.resume-mismatch-card')).toHaveLength(0)
  })

  it('covers the pipeline detail view too', async () => {
    wrapper = mountWith(project(), 'default')
    ;(wrapper.vm as unknown as { openPipelineDetail: (id: string) => void }).openPipelineDetail('custom')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.resume-mismatch-card')).toHaveLength(1)
    expect(wrapper.findAll('.resume-card')).toHaveLength(0)
    wrapper.find('.resume-mismatch-card button').trigger('click')
    expect(wrapper.emitted('pipeline-resume')).toHaveLength(1)
  })
})
