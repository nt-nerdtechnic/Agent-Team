// @vitest-environment happy-dom
// Pipeline Manager — pipelines tab. Two guarantees:
//  1. the surface is translated (it shipped with ~20 hard-coded English strings
//     that leaked through the zh-TW UI);
//  2. set-default / delete carry the host workspace, which is what lets the
//     backend refuse them while that workspace's project is running.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, effectScope, type EffectScope } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useRoles, type Role } from '../../composables/useRoles'
import { usePipelines, type PipelineSummary } from '../../composables/usePipelines'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => null }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PipelineManagerModal = (await import('../PipelineManagerModal.vue')).default as any

const WORKSPACE = '/Users/me/Desktop/Agent-Team'

const roles: Role[] = [
  { key: 'pm', label: 'Project Manager', one_line: 'plans', system_prompt: '# PM' },
]
const pipelines: PipelineSummary[] = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 2 },
  { id: 'custom', name: 'Custom', builtin: false, stage_count: 1 },
]
const secondStage = {
  id: '02',
  title: 'Build',
  short_title: 'Build',
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '---DONE---',
  allow_questions: false,
  doc_query: '',
  slots: [
    { agent_key: 'claude', role_key: 'pm', label: 'Dev', kickoff_body: '', is_commander: false },
  ],
}
const twoSlotStage = {
  id: '01',
  title: 'Specification',
  short_title: 'Spec',
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '---DONE---',
  allow_questions: false,
  doc_query: '',
  slots: [
    { agent_key: 'claude', role_key: 'pm', label: 'Lead', kickoff_body: '', is_commander: false },
    { agent_key: 'codex', role_key: 'pm', label: 'Second', kickoff_body: '', is_commander: false },
  ],
}

/** Prose that used to be baked into the template in English. */
const HARD_CODED_ENGLISH = [
  'Pipeline Manager',
  'New Pipeline',
  'Pipeline name',
  'stage(s)',
  'Back',
  'Set as default',
  'Allow questions',
  'Pause for user answers',
  'parallel slots',
  'at least one required',
  'Designate as global manager',
  'Save slot',
  'Reset to factory stages',
  'unassigned',
]

describe('PipelineManagerModal — pipelines tab', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
    i18n.global.locale.value = 'en-US'
  })

  async function open(
    options: { locale?: 'en-US' | 'zh-TW'; initialPipelineId?: string; workspacePath?: string } = {}
  ) {
    i18n.global.locale.value = options.locale ?? 'en-US'
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [twoSlotStage, secondStage],
      pipeline_id: options.initialPipelineId ?? 'default',
      path: '/data/stages.json',
    })

    scope = effectScope()
    let rolesApi!: ReturnType<typeof useRoles>
    let pipelinesApi!: ReturnType<typeof usePipelines>
    scope.run(() => {
      rolesApi = useRoles(mock.backend)
      pipelinesApi = usePipelines(mock.backend)
    })
    await flushPromises()

    const w = mount(PipelineManagerModal, {
      props: {
        backend: mock.backend,
        terminalPort: createTerminalDockStub(),
        rolesApi,
        pipelinesApi,
        workspacePath: options.workspacePath ?? WORKSPACE,
        open: true,
        initialPipelineId: options.initialPipelineId,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    return { wrapper: w, mock, pipelinesApi }
  }

  /** The pipelines tab body (index 0; index 1 is the roles tab). */
  const tab = (w: VueWrapper) => w.findAll('.tab-body')[0]

  it('renders the list view in the selected locale', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW' })

    expect(w.find('.title').text()).toBe(i18n.global.t('label.pipeline-manager'))
    expect(tab(w).text()).toContain(i18n.global.t('action.new-pipeline'))
    expect(tab(w).text()).toContain(i18n.global.t('label.stage-count', { count: 2 }))
    for (const literal of HARD_CODED_ENGLISH) {
      expect(w.find('.app').text()).not.toContain(literal)
    }
  })

  it('renders the stage detail view in the selected locale', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW', initialPipelineId: 'default' })

    const text = tab(w).text()
    expect(text).toContain(i18n.global.t('label.allow-questions'))
    expect(text).toContain(i18n.global.t('hint.pause-for-user-answers'))
    expect(text).toContain(i18n.global.t('label.parallel-slots', { count: 2 }))
    expect(text).toContain(i18n.global.t('label.slots'))
    for (const literal of HARD_CODED_ENGLISH) {
      expect(w.find('.app').text()).not.toContain(literal)
    }
  })

  it('still reads correctly in en-US (no raw keys leaking through)', async () => {
    const { wrapper: w } = await open({ locale: 'en-US', initialPipelineId: 'default' })

    expect(w.find('.title').text()).toBe('Pipeline Manager')
    expect(tab(w).text()).toContain('2 parallel slots')
    expect(w.find('.app').text()).not.toMatch(/\b(label|action|hint|error)\.[a-z-]+/)
  })

  it('sends the host workspace with set-default so a running project can veto it', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.set_active', {
      active_pipeline_id: 'custom',
      pipelines,
    })

    const setDefault = tab(w)
      .findAll('.pl-detail-actions button')
      .find((b) => b.text().includes(i18n.global.t('action.set-as-default')))
    expect(setDefault).toBeDefined()
    await setDefault!.trigger('click')
    await flushPromises()

    expect(mock.sent.find((s) => s.type === 'pipelines.set_active')?.payload).toEqual({
      pipeline_id: 'custom',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the host workspace with delete so a running project can veto it', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.delete', { pipelines: [pipelines[0]] })

    await tab(w).find('.pl-detail-actions .danger-icon').trigger('click')
    await flushPromises()
    // notify.confirm() parks on a host-rendered dialog; say yes for the user.
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    useNotify().resolveDialog(true)
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'pipelines.delete')
    expect(sent?.payload).toEqual({ pipeline_id: 'custom', workspace_path: WORKSPACE })
  })
  it('shows the backend reason when the delete is vetoed, not a bare "Delete failed"', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.delete', null, {
      ok: false,
      error: { code: 'PIPELINE_RUNNING', message: 'Cannot delete pipeline while a project is running' },
    })

    const before = useNotify().toasts.value.length
    await tab(w).find('.pl-detail-actions .danger-icon').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    const last = useNotify().toasts.value.slice(before).at(-1)
    expect(last?.type).toBe('error')
    expect(last?.message).toContain('Cannot delete pipeline while a project is running')
  })

  it('reports a failed factory reset instead of doing nothing visible', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('pipelines.reset_builtin', null, {
      ok: false, error: { code: 'ERR', message: 'stages.json is read-only' },
    })

    // "Default" is the builtin row, so it carries the ↺ button.
    const before = useNotify().toasts.value.length
    await tab(w).findAll('.pl-list .icon-btn')[0].trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    const last = useNotify().toasts.value.slice(before).at(-1)
    expect(last?.type).toBe('error')
    expect(last?.message).toContain('stages.json is read-only')
  })
  // ── Stage CRUD carries the host workspace ─────────────────────────────────
  // The backend refuses a stage edit whose pipeline is the one a run is using
  // (ws_handlers._stage_edit_hits_running_pipeline). It can only do that when
  // the request names a workspace, so every stage mutation has to send one.

  /** Open the detail view of `default` and hand back the stage editor helpers. */
  async function detail(workspacePath?: string) {
    const opened = await open({ initialPipelineId: 'default', workspacePath })
    return opened
  }

  const sentPayload = (mock: ReturnType<typeof createMockBackend>, type: string) =>
    mock.sent.filter((s) => s.type === type).at(-1)?.payload

  it('sends the workspace with a stage save', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.upsert', { stage: twoSlotStage })

    const titleInput = tab(w).findAll('.split-detail input')[2]
    await titleInput.setValue('Specification v2')
    await tab(w).find('.detail-head .primary').trigger('click')
    await flushPromises()

    expect(sentPayload(mock, 'stages.upsert')).toMatchObject({
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the workspace with a stage delete', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.delete', { stages: [secondStage] })

    await tab(w).find('.detail-head .danger').trigger('click')
    await flushPromises()
    await w.find('.modal .modal-card .danger').trigger('click')
    await flushPromises()

    expect(sentPayload(mock, 'stages.delete')).toEqual({
      id: '01',
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the workspace with a stage reset', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.reset', { stages: [twoSlotStage] })

    await tab(w).find('.toolbar .danger-link').trigger('click')
    await flushPromises()
    await w.find('.modal .modal-card .danger').trigger('click')
    await flushPromises()

    expect(sentPayload(mock, 'stages.reset')).toEqual({
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the workspace with a stage reorder', async () => {
    const { wrapper: w, mock } = await detail()

    // ▼ on the first row: [▲, ▼] per row, so index 1 is the first row's ▼.
    await tab(w).findAll('.split-list li .icon-btn')[1].trigger('click')
    await flushPromises()

    expect(sentPayload(mock, 'stages.reorder')).toEqual({
      ids: ['02', '01'],
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the workspace with every stage written by an import', async () => {
    const { wrapper: w, mock } = await detail()
    const openJson = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({ stages: [twoSlotStage, secondStage] }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    const importBtn = tab(w).findAll('.toolbar .ghost')[1]
    await importBtn.trigger('click')
    await flushPromises()

    const imports = mock.sent.filter((s) => s.type === 'stages.upsert')
    expect(imports).toHaveLength(2)
    for (const sent of imports) {
      expect(sent.payload).toMatchObject({ pipeline_id: 'default', workspace_path: WORKSPACE })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('sends the workspace with a builtin factory reset', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('pipelines.reset_builtin', { pipeline: pipelines[0], pipelines })

    await tab(w).findAll('.pl-list .icon-btn')[0].trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(sentPayload(mock, 'pipelines.reset_builtin')).toEqual({
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('still edits stages when no workspace is open (empty path, guard is a no-op)', async () => {
    const { wrapper: w, mock } = await detail('')
    mock.setResponse('stages.upsert', { stage: twoSlotStage })

    const titleInput = tab(w).findAll('.split-detail input')[2]
    await titleInput.setValue('Specification v2')
    const save = tab(w).find('.detail-head .primary')
    expect(save.attributes('disabled')).toBeUndefined()
    await save.trigger('click')
    await flushPromises()

    // Empty is what the backend already treats as "no workspace to check", so
    // the edit goes through exactly as it did before the workspace was wired.
    expect(sentPayload(mock, 'stages.upsert')).toMatchObject({ workspace_path: '' })
    expect(tab(w).find('.err-msg').exists()).toBe(false)
  })
  // wsClient resolves an ok:false response instead of rejecting, so the
  // try/catch around reorder never saw a backend refusal: the row snapped back
  // on the following refresh and nothing said why.
  it('reports a vetoed stage reorder instead of silently snapping back', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.reorder', null, {
      ok: false,
      error: { code: 'PIPELINE_RUNNING', message: 'Cannot reorder stages while the active pipeline is running' },
    })

    const listsBefore = mock.sent.filter((s) => s.type === 'stages.list').length
    await tab(w).findAll('.split-list li .icon-btn')[1].trigger('click')
    await flushPromises()

    expect(tab(w).find('.err-msg').text()).toContain(
      'Cannot reorder stages while the active pipeline is running'
    )
    // The refusal stops the round trip: no refresh is issued for it.
    expect(mock.sent.filter((s) => s.type === 'stages.list')).toHaveLength(listsBefore)
  })

  it('reports a vetoed move-up too', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.reorder', null, {
      ok: false, error: { code: 'PIPELINE_RUNNING', message: 'reorder refused' },
    })

    // ▲ on the second row: [▲, ▼] per row, so index 2 is the second row's ▲.
    await tab(w).findAll('.split-list li .icon-btn')[2].trigger('click')
    await flushPromises()

    expect(tab(w).find('.err-msg').text()).toContain('reorder refused')
  })

  it('names the first rejected stage on a partially failed import', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.upsert', null, {
      ok: false, error: { code: 'PIPELINE_RUNNING', message: 'Cannot edit stages while the active pipeline is running' },
    })
    const openJson = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({ stages: [twoSlotStage, secondStage] }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    await tab(w).findAll('.toolbar .ghost')[1].trigger('click')
    await flushPromises()

    expect(tab(w).find('.err-msg').text()).toContain(
      'Cannot edit stages while the active pipeline is running'
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })
})
