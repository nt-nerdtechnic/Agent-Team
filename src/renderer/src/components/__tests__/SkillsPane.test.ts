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
  { key: 'claude', label: 'Claude Code', state: 'wired', reads_shared_root: false },
  { key: 'kimi', label: 'Kimi Code', state: 'wired', reads_shared_root: false },
  { key: 'pi', label: 'Pi', state: 'wired', reads_shared_root: false },
  { key: 'codex', label: 'Codex', state: 'wired', reads_shared_root: true },
  { key: 'aider', label: 'Aider', state: 'unsupported', reads_shared_root: false },
]

const nativeSkill = {
  name: 'bug-buster',
  description: 'Fixes bugs',
  source: 'copilot',
  owner_agent: 'copilot',
  path: '/Users/x/.copilot/skills/bug-buster',
  real_path: '/Users/x/.copilot/skills/bug-buster',
  aliases: [],
  valid: true,
  error: '',
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    // Consent already on record: the default fixture is about everything
    // *after* the first write into ~/.agents/skills was allowed.
    'skills.list': { ok: true, payload: { skills: [skill], root: '/tmp/skills', agents, write_consented: true } },
    'skills.get': { ok: true, payload: { skill } },
    'skills.create': { ok: true, payload: { skill } },
    'skills.save': { ok: true, payload: { ok: true, skill: { ...skill, revision: 'rev-2' } } },
    'skills.set_enabled': { ok: true, payload: { skill: { ...skill, enabled: false } } },
    'skills.delete': { ok: true, payload: { name: skill.name, deleted: true } },
    'skills.set_targets': { ok: true, payload: { skill } },
    'skills.set_native_targets': { ok: true, payload: { ok: true } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
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
      consent: true,
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
    // Targets are unset, so every deliverable agent receives it.
    expect(cells[0].classes()).toContain('on')
    expect(cells[1].classes()).toContain('on')
    expect(cells[2].classes()).toContain('on')
    // codex reads ~/.agents/skills itself: automatic, not a switch.
    expect(cells[3].classes()).toContain('auto')
    expect(cells[4].classes()).toContain('unsupported')
  })

  it('paints an automatic cell as delivered but never toggleable', async () => {
    const { send } = await openMatrix()
    const codex = wrapper!.findAll('.skills-matrix tbody td')[3]

    expect(codex.find('button').text()).toBe('●')
    expect((codex.find('button').element as HTMLButtonElement).disabled).toBe(true)
    await codex.find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_targets', expect.anything())
  })

  it('does not count automatic agents when deciding a row is "all"', async () => {
    const { send } = await openMatrix({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, targets: ['claude', 'pi'] }], root: '/tmp/skills', agents },
      },
    })

    // Re-adding kimi completes the editable set {claude, kimi, pi}; codex is
    // automatic and must not keep the row from collapsing back to null.
    await wrapper!.findAll('.skills-matrix tbody td')[1].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_targets', { name: 'review-code', agents: null })
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


describe('SkillsPane native skills', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath: vi.fn().mockResolvedValue({ ok: true }) } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function open(view: 'list' | 'matrix', extra: Record<string, unknown> = {}) {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: {
          skills: [skill],
          native: [nativeSkill],
          native_targets: {},
          root: '/tmp/skills',
          agents,
          ...extra,
        },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    if (view === 'matrix') {
      await wrapper.findAll('.skills-view-switch button')[1].trigger('click')
      await flushPromises()
    }
    return mocked
  }

  it('lists a native skill read-only under its own group with its source', async () => {
    await open('list')

    const item = wrapper!.find('.skill-list-item.native')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('bug-buster')
    expect(item.find('.skill-source-tag').text()).toBe("copilot's own")
    // No enable switch: it is not ours to switch.
    expect(item.findAll('input[type="checkbox"], [role="switch"]')).toHaveLength(0)
  })

  it('shows a native row in the matrix, automatic for its owner and opt-in elsewhere', async () => {
    await open('matrix')

    const rows = wrapper!.findAll('.skills-matrix tbody tr')
    expect(rows).toHaveLength(2)
    const native = rows[1]
    expect(native.classes()).toContain('native')
    const cells = native.findAll('td')
    // Owner (copilot) is not among the fixture agents; every wired cell is
    // opt-in and therefore off by default.
    expect(cells[0].classes()).toContain('off')
    expect(cells[1].classes()).toContain('off')
    expect(cells[3].classes()).toContain('off') // codex: native rows are not "auto" for shared-root readers
    expect(cells[4].classes()).toContain('unsupported')
  })

  it('opts a native skill in to another agent by real path', async () => {
    const { send } = await open('matrix')

    await wrapper!.findAll('.skills-matrix tbody tr')[1].findAll('td')[0].find('button').trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('skills.set_native_targets', {
      real_path: '/Users/x/.copilot/skills/bug-buster',
      agents: ['claude'],
    })
  })

  it('marks the owner cell automatic when the owner is a listed agent', async () => {
    await open('matrix', {
      native: [{ ...nativeSkill, source: 'claude', owner_agent: 'claude', path: '/Users/x/.claude/skills/bug-buster', real_path: '/Users/x/.claude/skills/bug-buster' }],
    })

    const cells = wrapper!.findAll('.skills-matrix tbody tr')[1].findAll('td')
    expect(cells[0].classes()).toContain('auto')
    expect((cells[0].find('button').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('never delivers an invalid native skill', async () => {
    const { send } = await open('matrix', {
      native: [{ ...nativeSkill, valid: false, error: 'SKILL.md missing' }],
    })
    const row = wrapper!.findAll('.skills-matrix tbody tr')[1]

    expect(row.classes()).toContain('off')
    expect(row.text()).toContain('SKILL.md missing')
    await row.findAll('td')[0].find('button').trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('skills.set_native_targets', expect.anything())
  })

  it('makes a shared skill the user created read-only in the editor', async () => {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [{ ...skill, managed: false }], native: [], root: '/tmp/skills', agents },
      },
      'skills.get': { ok: true, payload: { skill: { ...skill, managed: false } } },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const buttons = wrapper.findAll('.skill-editor-actions button')
    expect(buttons.every((b) => (b.element as HTMLButtonElement).disabled)).toBe(true)
    expect(wrapper.text()).toContain('edit it where it lives')
  })
})

describe('SkillsPane write consent', () => {
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

  async function startCreate(consented: boolean) {
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: consented },
      },
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const newButton = wrapper.findAll('.skills-toolbar-actions button').find((b) => b.text() === 'New skill')!
    await newButton.trigger('click')
    await wrapper.find('.skills-create input').setValue('fresh')
    return mocked
  }

  it('asks once, names the exact folder, and sends consent only after yes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { send } = await startCreate(false)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toContain('/Users/x/.agents/skills')
    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'fresh', description: '', consent: true,
    })
  })

  it('writes nothing when the user declines', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { send } = await startCreate(false)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(send).not.toHaveBeenCalledWith('skills.create', expect.anything())
  })

  it('does not ask again once consent is on record', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const { send } = await startCreate(true)

    await wrapper!.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('skills.create', {
      name: 'fresh', description: '', consent: true,
    })
  })

  it('re-asks when the backend still wants consent, then retries', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const mocked = mockBackend({
      'skills.list': {
        ok: true,
        payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true },
      },
    })
    let calls = 0
    mocked.send.mockImplementation(async (type: string) => {
      if (type === 'skills.create' && calls++ === 0) {
        return { ok: false, error: { code: 'SKILL_CONSENT_REQUIRED', message: 'x', details: { root: '/Users/x/.agents/skills' } } }
      }
      return type === 'skills.create'
        ? { ok: true, payload: { skill } }
        : { ok: true, payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true } }
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const newButton = wrapper.findAll('.skills-toolbar-actions button').find((b) => b.text() === 'New skill')!
    await newButton.trigger('click')
    await wrapper.find('.skills-create input').setValue('fresh')

    await wrapper.find('.skills-create').trigger('submit')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    const creates = mocked.send.mock.calls.filter((c) => c[0] === 'skills.create')
    expect(creates).toHaveLength(2)
    expect(creates[1][1]).toMatchObject({ consent: true })
  })
})

describe('SkillsPane migrate and restore', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openPath: vi.fn() } as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  async function openList(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const mocked = mockBackend({
      'skills.list': { ok: true, payload: { skills: [], native: [], root: '/Users/x/.agents/skills', agents, write_consented: true, ...payload } },
      'skills.migrate_native': { ok: true, payload: { skill, from: nativeSkill.path } },
      'skills.restore_native': { ok: true, payload: { name: 'review-code', restored_to: '/x' } },
      ...extra,
    })
    wrapper = mount(SkillsPane, { props: { backend: mocked.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mocked
  }

  it('migrates only after a confirm that names source, destination and undo', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { send } = await openList({ native: [nativeSkill] })

    await wrapper!.find('.skill-migrate').trigger('click')
    await flushPromises()

    const text = confirm.mock.calls[0][0] as string
    expect(text).toContain('/Users/x/.copilot/skills/bug-buster')   // from
    expect(text).toContain('/Users/x/.agents/skills')               // to
    expect(text).toContain('copilot keeps reading it')              // link stays
    expect(text).toContain('Restore')                               // undo
    expect(send).toHaveBeenCalledWith('skills.migrate_native', {
      real_path: '/Users/x/.copilot/skills/bug-buster',
      consent: true,
    })
  })

  it('does nothing when the migrate confirm is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { send } = await openList({ native: [nativeSkill] })

    await wrapper!.find('.skill-migrate').trigger('click')
    await flushPromises()

    expect(send).not.toHaveBeenCalledWith('skills.migrate_native', expect.anything())
  })

  it('never offers migrate for an invalid native skill', async () => {
    await openList({ native: [{ ...nativeSkill, valid: false, error: 'SKILL.md missing' }] })

    expect((wrapper!.find('.skill-migrate').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows restore only for a migrated skill and confirms the destination', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const migrated = { ...skill, migrated_from: '/Users/x/.copilot/skills/review-code' }
    const { send } = await openList(
      { skills: [migrated] },
      { 'skills.get': { ok: true, payload: { skill: migrated } } }
    )

    const restore = wrapper!.findAll('.skill-editor-actions button').find((b) => b.text() === 'Restore')
    expect(restore).toBeDefined()
    await restore!.trigger('click')
    await flushPromises()

    expect(confirm.mock.calls[0][0]).toContain('/Users/x/.copilot/skills/review-code')
    expect(send).toHaveBeenCalledWith('skills.restore_native', { name: 'review-code' })
  })

  it('has no restore button for a skill born in the shared root', async () => {
    await openList({ skills: [skill] })

    const labels = wrapper!.findAll('.skill-editor-actions button').map((b) => b.text())
    expect(labels).not.toContain('Restore')
  })
})
