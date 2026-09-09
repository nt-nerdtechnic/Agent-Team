// @vitest-environment happy-dom
// Renaming a role key used to be a client-side two-step: upsert under the new
// key, then delete the old one. roles.delete refuses while a stage slot still
// names the role, so on a default install (qa is wired into several slots) the
// sequence stopped halfway and left BOTH keys behind, with no way out. The
// backend now owns the whole move via roles.rename.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
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

const pm: Role = { key: 'pm', label: 'Project Manager', one_line: 'plans', system_prompt: '# PM' }
const qa: Role = { key: 'qa', label: 'QA Engineer', one_line: 'tests it', system_prompt: '# QA' }
const tester: Role = { key: 'tester', label: 'QA Engineer', one_line: 'tests it', system_prompt: '# QA' }

const pipelines: PipelineSummary[] = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 2 },
]

describe('PipelineManagerModal — role key rename', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
    i18n.global.locale.value = 'en-US'
  })

  async function open(roles: Role[] = [pm, qa]) {
    i18n.global.locale.value = 'en-US'
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines, active_pipeline_id: 'default', path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', { stages: [], pipeline_id: 'default', path: '/data/stages.json' })

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
        workspacePath: '/tmp/ws',
        open: true,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    await w.findAll('.tabs button')[1].trigger('click')
    await flushPromises()
    return { wrapper: w, mock, rolesApi }
  }

  /** The roles tab body (index 1; index 0 is the pipelines tab). */
  const tab = (w: VueWrapper): DOMWrapper<Element> => w.findAll('.tab-body')[1]
  const keyField = (w: VueWrapper) =>
    tab(w).findAll('.split-detail input')[0] as DOMWrapper<HTMLInputElement>
  const saveBtn = (w: VueWrapper) => tab(w).find('.detail-head .primary')

  /** Select a role by its visible key (rSorted is label-sorted). */
  async function select(w: VueWrapper, key: string): Promise<void> {
    const row = tab(w).findAll('.split-list li').find((li) => li.find('.mono-key').text() === key)
    expect(row, `no row for ${key}`).toBeDefined()
    await row!.trigger('click')
    await flushPromises()
  }

  async function renameQaTo(w: VueWrapper, newKey: string): Promise<void> {
    await select(w, 'qa')
    await keyField(w).setValue(newKey)
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()
  }

  it('renames a role that stage slots still use, in one backend call', async () => {
    const { wrapper: w, mock, rolesApi } = await open()
    mock.setResponse('roles.rename', {
      role: tester,
      roles: [pm, tester],
      repointed_pipeline_ids: ['default', 'maintenance', 'custom-1'],
    })

    await renameQaTo(w, 'tester')

    // One call, with the full draft the store needs.
    expect(mock.sent.find((s) => s.type === 'roles.rename')?.payload).toEqual({
      old_key: 'qa',
      new_key: 'tester',
      label: 'QA Engineer',
      one_line: 'tests it',
      system_prompt: '# QA',
    })
    // The dead two-step path is gone.
    expect(mock.sent.some((s) => s.type === 'roles.upsert')).toBe(false)
    expect(mock.sent.some((s) => s.type === 'roles.delete')).toBe(false)

    // No duplicate left behind, and the editor follows the new key.
    expect(rolesApi.roles.value.map((r) => r.key)).toEqual(['pm', 'tester'])
    expect(keyField(w).element.value).toBe('tester')
    expect(tab(w).find('.summary-ok').text()).toBe('Saved "QA Engineer"')
    expect(tab(w).find('.err-msg').exists()).toBe(false)
  })

  it('tells the user how many pipelines had their reference repointed', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.rename', {
      role: tester,
      roles: [pm, tester],
      repointed_pipeline_ids: ['default', 'maintenance', 'custom-1'],
    })

    const before = useNotify().toasts.value.length
    await renameQaTo(w, 'tester')

    const added = useNotify().toasts.value.slice(before)
    expect(added.at(-1)?.message).toBe(
      i18n.global.t('label.role-rename-repointed', { count: 3 })
    )
    expect(added.at(-1)?.message).toContain('3')
  })

  it('stays quiet about repointing when no slot used the role', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.rename', {
      role: tester, roles: [pm, tester], repointed_pipeline_ids: [],
    })

    const before = useNotify().toasts.value.length
    await renameQaTo(w, 'tester')

    expect(useNotify().toasts.value.slice(before)).toHaveLength(0)
    expect(tab(w).find('.summary-ok').exists()).toBe(true)
  })

  it('gives an escape route when the new key is already taken (ROLE_KEY_EXISTS)', async () => {
    // Reachable when another window created the key, or when a half-finished
    // rename from the old two-step path left it in the registry.
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.rename', null, {
      ok: false,
      error: { code: 'ROLE_KEY_EXISTS', message: "role 'tester' already exists", details: { role_key: 'tester' } },
    })

    await renameQaTo(w, 'tester')

    const msg = tab(w).find('.err-msg').text()
    expect(msg).toBe(i18n.global.t('hint.role-key-exists-recover', { key: 'tester' }))
    expect(msg).toContain('tester')
    // The instruction has to be one the user can actually carry out.
    expect(msg.toLowerCase()).toContain('delete')
    expect(tab(w).find('.summary-ok').exists()).toBe(false)
  })

  it('explains ROLE_NOT_FOUND in the UI language instead of echoing the backend', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.rename', null, {
      ok: false,
      error: { code: 'ROLE_NOT_FOUND', message: "no such role: 'qa'", details: { role_key: 'qa' } },
    })
    i18n.global.locale.value = 'zh-TW'
    await flushPromises()

    await renameQaTo(w, 'tester')

    const msg = tab(w).find('.err-msg').text()
    // The message names the key that vanished — the OLD one, not the target.
    expect(msg).toBe(i18n.global.t('hint.role-not-found-refresh', { key: 'qa' }))
    expect(msg).toContain('qa')
    // Raw backend English must not reach a zh-TW user.
    expect(msg).not.toContain('no such role')
    expect(tab(w).find('.summary-ok').exists()).toBe(false)
  })

  it('still surfaces the raw reason for a code it has no advice for', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.rename', null, {
      ok: false, error: { code: 'INTERNAL_ERROR', message: 'roles.json is read-only' },
    })

    await renameQaTo(w, 'tester')

    expect(tab(w).find('.err-msg').text()).toBe('roles.json is read-only')
  })

  it('a plain edit with the key untouched still goes through roles.upsert', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('roles.upsert', { role: { ...qa, label: 'QA Lead' }, roles: [pm, { ...qa, label: 'QA Lead' }] })

    await select(w, 'qa')
    await (tab(w).findAll('.split-detail input')[1] as DOMWrapper<HTMLInputElement>).setValue('QA Lead')
    await flushPromises()
    await saveBtn(w).trigger('click')
    await flushPromises()

    expect(mock.sent.some((s) => s.type === 'roles.rename')).toBe(false)
    expect(mock.sent.find((s) => s.type === 'roles.upsert')?.payload).toMatchObject({ key: 'qa' })
  })

  it('explains the disabled Save when the target key is a stuck leftover', async () => {
    // Both keys present is exactly the state the old two-step bug produced.
    // rCanSave blocks the send, so without a message the user just sees a dead
    // button — the same dead end, one layer up.
    const { wrapper: w, mock } = await open([pm, qa, tester])

    await select(w, 'qa')
    await keyField(w).setValue('tester')
    await flushPromises()

    expect(saveBtn(w).attributes('disabled')).toBeDefined()
    expect(tab(w).find('.warn-msg').text()).toBe(
      i18n.global.t('hint.role-key-exists-recover', { key: 'tester' })
    )
    expect(mock.sent.some((s) => s.type === 'roles.rename')).toBe(false)
  })

  it('keeps the plain duplicate-key warning for a brand new role', async () => {
    const { wrapper: w } = await open()

    await tab(w).find('.new-btn').trigger('click')
    await keyField(w).setValue('pm')
    await flushPromises()

    expect(tab(w).find('.warn-msg').text()).toBe(i18n.global.t('error.key-exists'))
  })
  // ── Open stage draft vs. a rename that repoints its slots ─────────────────
  // The draft is a deep copy taken before the rename. Saving it after would
  // write the vanished key back — the dangling role_key the rename exists to
  // prevent.
  const stageWithRole = (roleKey: string) => ({
    id: '01',
    title: 'Specification',
    short_title: 'Spec',
    question: '',
    description: '',
    recommended_roles: [],
    sentinel: '',
    allow_questions: false,
    doc_query: '',
    slots: [
      { agent_key: 'claude', role_key: roleKey, label: 'Lead', kickoff_body: '', is_commander: false },
      { agent_key: 'codex', role_key: 'pm', label: 'Second', kickoff_body: '', is_commander: false },
    ],
  })

  /** Open the pipelines tab on Default's stage 01 with a dirtied title. */
  async function openDirtyStageDraft(mock: ReturnType<typeof createMockBackend>, w: VueWrapper) {
    await w.findAll('.tabs button')[0].trigger('click')
    await flushPromises()
    await w.findAll('.tab-body')[0].find('.pl-list .pl-item').trigger('click')
    await flushPromises()
    const titleInput = w.findAll('.tab-body')[0].findAll('.split-detail input')[2]
    await titleInput.setValue('Specification v2')
    await flushPromises()
    return { mock }
  }

  async function saveStage(w: VueWrapper): Promise<void> {
    await w.findAll('.tab-body')[0].find('.detail-head .primary').trigger('click')
    await flushPromises()
  }

  it('adopts the repointed role keys into an open stage draft', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles: [pm, qa], path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines, active_pipeline_id: 'default', path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [stageWithRole('qa')], pipeline_id: 'default', path: '/data/stages.json',
    })
    mock.setResponse('stages.upsert', { stage: stageWithRole('tester') })

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
        backend: mock.backend, terminalPort: createTerminalDockStub(),
        rolesApi, pipelinesApi, workspacePath: '/tmp/ws', open: true,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    await openDirtyStageDraft(mock, w)

    // A rename lands while the draft is open.
    mock.emit('stages.changed', {
      stages: [stageWithRole('tester')], pipeline_id: 'default', reason: 'role_rename',
    })
    await flushPromises()
    await saveStage(w)

    const sent = mock.sent.filter((s) => s.type === 'stages.upsert').at(-1)
    const slots = (sent?.payload.stage as { slots: { role_key: string }[] }).slots
    expect(slots.map((s) => s.role_key)).toEqual(['tester', 'pm'])
    // The title edit the user was making survives the adoption.
    expect((sent?.payload.stage as { title: string }).title).toBe('Specification v2')
  })

  it('leaves the draft alone for a stage change that is not a rename', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles: [pm, qa], path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines, active_pipeline_id: 'default', path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [stageWithRole('qa')], pipeline_id: 'default', path: '/data/stages.json',
    })
    mock.setResponse('stages.upsert', { stage: stageWithRole('qa') })

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
        backend: mock.backend, terminalPort: createTerminalDockStub(),
        rolesApi, pipelinesApi, workspacePath: '/tmp/ws', open: true,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    await openDirtyStageDraft(mock, w)

    // Someone else edited the same stage's slots; that is NOT a rename, and the
    // open draft must keep what the user has.
    mock.emit('stages.changed', {
      stages: [stageWithRole('someone-elses-key')], pipeline_id: 'default', reason: 'upsert',
    })
    await flushPromises()
    await saveStage(w)

    const sent = mock.sent.filter((s) => s.type === 'stages.upsert').at(-1)
    const slots = (sent?.payload.stage as { slots: { role_key: string }[] }).slots
    expect(slots.map((s) => s.role_key)).toEqual(['qa', 'pm'])
  })
})
