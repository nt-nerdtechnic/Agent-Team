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

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'skills.list': { ok: true, payload: { skills: [skill], root: '/tmp/skills' } },
    'skills.get': { ok: true, payload: { skill } },
    'skills.create': { ok: true, payload: { skill } },
    'skills.save': { ok: true, payload: { ok: true, skill: { ...skill, revision: 'rev-2' } } },
    'skills.set_enabled': { ok: true, payload: { skill: { ...skill, enabled: false } } },
    'skills.delete': { ok: true, payload: { name: skill.name, deleted: true } },
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
