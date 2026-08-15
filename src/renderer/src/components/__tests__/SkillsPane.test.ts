// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import SkillsPane from '../SkillsPane.vue'

const skill = {
  name: 'review-code',
  description: 'Review changes carefully',
  enabled: true,
  valid: true,
  path: '/tmp/skills/review-code',
  revision: 'rev-1',
  fields: {
    name: 'review-code',
    description: 'Review changes carefully',
    'user-invocable': true,
    'disable-model-invocation': false,
    'allowed-tools': ['Read', 'Grep'],
    unknown: { preserved: true },
  },
  body: 'Check the diff.',
  attachments: [{ path: 'references/checklist.md', size: 42 }],
}

const agents = [
  { key: 'claude', label: 'Claude Code', state: 'wired' },
  { key: 'kimi', label: 'Kimi Code', state: 'wired' },
  { key: 'pi', label: 'Pi', state: 'wired' },
  { key: 'codex', label: 'Codex', state: 'planned' },
  { key: 'aider', label: 'Aider', state: 'unsupported' },
]

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'skills.list': { ok: true, payload: { skills: [skill], root: '/tmp/skills', agents } },
    'skills.get': { ok: true, payload: { skill } },
    'skills.create': { ok: true, payload: { skill } },
    'skills.save': { ok: true, payload: { ok: true, skill: { ...skill, revision: 'rev-2' } } },
    'skills.set_enabled': { ok: true, payload: { skill: { ...skill, enabled: false } } },
    'skills.delete': { ok: true, payload: { name: skill.name, deleted: true } },
    'skills.set_targets': { ok: true, payload: { skill } },
    ...overrides,
  }
  const send = vi.fn(async (type: string) => responses[type])
  return { backend: { send } as never, send }
}

describe('SkillsPane', () => {
  let wrapper: VueWrapper | undefined
  const openPath = vi.fn().mockResolvedValue({ ok: true })

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    openPath.mockClear()
    vi.restoreAllMocks()
  })

  it('loads the library and renders editable fields and read-only attachments', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.list', {})
    expect(send).toHaveBeenCalledWith('skills.get', { name: 'review-code' })
    expect(wrapper.get('.skill-list-copy strong').text()).toBe('review-code')
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Check the diff.')
    expect(wrapper.get('.skill-attachments').text()).toContain('references/checklist.md')

    await wrapper.get('.skill-editor-head button').trigger('click')
    expect(openPath).toHaveBeenCalledWith('/tmp/skills/review-code')
  })

  it('creates a skill and reloads it into the editor', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.skills-toolbar .primary').trigger('click')
    const inputs = wrapper.findAll('.skills-create input')
    await inputs[0].setValue('new-skill')
    await inputs[1].setValue('A new skill')
    await wrapper.get('.skills-create').trigger('submit')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'new-skill',
      description: 'A new skill',
    })
  })

  it('sends a known-field patch and keeps the draft visible on conflict', async () => {
    const { backend, send } = mockBackend({
      'skills.save': {
        ok: false,
        payload: null,
        error: { code: 'SKILL_CONFLICT', message: 'stale revision' },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.skill-body').setValue('Unsaved local draft')
    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith(
      'skills.save',
      expect.objectContaining({
        name: 'review-code',
        body: 'Unsaved local draft',
        expected_revision: 'rev-1',
        fields: expect.objectContaining({ name: 'review-code', description: 'Review changes carefully' }),
      })
    )
    expect(wrapper.find('.skills-conflict').exists()).toBe(true)
    expect((wrapper.get('.skill-body').element as HTMLTextAreaElement).value).toBe('Unsaved local draft')
  })

  it('uses hyphenated aliases as canonical and synchronizes existing underscore aliases on save', async () => {
    const skillWithAliases = {
      ...skill,
      fields: {
        ...skill.fields,
        'user-invocable': false,
        user_invocable: true,
        'disable-model-invocation': true,
        disable_model_invocation: false,
        'allowed-tools': ['Read'],
        allowed_tools: ['Write'],
        'disallowed-tools': ['Bash'],
        disallowed_tools: ['Edit'],
      },
    }
    const { backend, send } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [skillWithAliases], root: '/tmp/skills' } },
      'skills.get': { ok: true, payload: { skill: skillWithAliases } },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.skill-editor-actions .primary').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith(
      'skills.save',
      expect.objectContaining({
        fields: expect.objectContaining({
          'user-invocable': false,
          user_invocable: false,
          'disable-model-invocation': true,
          disable_model_invocation: true,
          'allowed-tools': ['Read'],
          allowed_tools: ['Read'],
          'disallowed-tools': ['Bash'],
          disallowed_tools: ['Bash'],
        }),
      })
    )
  })

  it('normalizes native_conflict into the list status rail and editor warning', async () => {
    const conflictingSkill = { ...skill, native_conflict: true }
    const { backend } = mockBackend({
      'skills.list': { ok: true, payload: { skills: [conflictingSkill], root: '/tmp/skills' } },
      'skills.get': { ok: true, payload: { skill: conflictingSkill } },
    })
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.skill-status-rail .conflicted').exists()).toBe(true)
    expect(wrapper.get('.skill-badge.warning').text()).toBe(i18n.global.t('settings.skills.native-conflict'))
  })

  it('updates enabled state only after success and moves deletions to Trash', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { backend, send } = mockBackend()
    wrapper = mount(SkillsPane, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.skill-list-item [role="switch"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_enabled', { name: 'review-code', enabled: false })

    await wrapper.get('.skill-editor-actions .danger').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.delete', { name: 'review-code' })
  })
})

describe('SkillsPane capability matrix', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = {} as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function openMatrix(overrides: Record<string, unknown> = {}) {
    const mocked = mockBackend(overrides)
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.findAll('.skills-view-switch button')[1].trigger('click')
    await flushPromises()
    return mocked
  }

  it('renders one column per agent and marks the three capability states apart', async () => {
    await openMatrix()

    const headers = wrapper!.findAll('.skills-matrix thead th')
    expect(headers.map((th) => th.text())).toEqual([
      'Skill', 'claude', 'kimi', 'pi', 'codex', 'aider', '',
    ])
    const cells = wrapper!.findAll('.skills-matrix tbody td')
    // Targets are unset, so every wired agent receives it.
    expect(cells[0].classes()).toContain('on')
    expect(cells[1].classes()).toContain('on')
    expect(cells[2].classes()).toContain('on')
    expect(cells[3].classes()).toContain('planned')
    expect(cells[4].classes()).toContain('unsupported')
  })

  it('never lets an unwired agent be toggled', async () => {
    const { send } = await openMatrix()
    const cells = wrapper!.findAll('.skills-matrix tbody td')

    expect((cells[3].find('button').element as HTMLButtonElement).disabled).toBe(true)
    expect((cells[4].find('button').element as HTMLButtonElement).disabled).toBe(true)

    await cells[4].find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_targets', expect.anything())
  })

  it('materializes the implicit all-agents list when one cell is switched off', async () => {
    const { send } = await openMatrix()

    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_targets', {
      name: 'review-code',
      agents: ['claude', 'pi'],
    })
  })

  it('returns to the unrestricted list when every wired agent is selected again', async () => {
    const { send } = await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, targets: ['claude', 'pi'] }], root: '/tmp/skills', agents },
      },
    })

    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    // Not ['claude','pi','kimi'] — an explicit full list would freeze today's
    // agents and stop following newly wired ones.
    expect(send).toHaveBeenCalledWith('skills.set_targets', {
      name: 'review-code',
      agents: null,
    })
  })

  it('sends null for the whole row and an empty list for none', async () => {
    const { send } = await openMatrix()
    const bulk = wrapper!.findAll('.skills-matrix td.bulk button')

    await bulk[1].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: [] })

    await bulk[0].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: null })
  })

  it('rolls the cell back when the backend rejects the change', async () => {
    await openMatrix({ 'skills.set_targets': { ok: false, error: { message: 'nope' } } })
    const cell = () => wrapper!.findAll('.skills-matrix tbody td')[1]

    await cell().find('button').trigger('click')
    await flushPromises()

    expect(cell().classes()).toContain('on')
    expect(wrapper!.find('.skills-error').text()).toBeTruthy()
  })

  it('shows a disabled skill as delivered nowhere', async () => {
    await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, enabled: false }], root: '/tmp/skills', agents },
      },
    })

    const row = wrapper!.find('.skills-matrix tbody tr')
    expect(row.classes()).toContain('off')
    expect(wrapper!.findAll('.skills-matrix tbody td.on')).toHaveLength(0)
    expect(
      (wrapper!.findAll('.skills-matrix tbody td')[0].find('button').element as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
