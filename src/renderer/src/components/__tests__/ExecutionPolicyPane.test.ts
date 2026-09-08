// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExecutionPolicyPane from '../ExecutionPolicyPane.vue'
import type {
  ExecutionPolicyApi,
  ExecutionPolicySettingsSnapshot,
} from '../../../../shared/executionPolicy'

const DEFAULT_POLICY = {
  schemaVersion: 1 as const,
  mode: 'allowlist' as const,
  system: ['fs', 'ui', 'aiCli'] as const,
  shell: ['git', 'gh', 'glab'],
}
const RECOMMENDED_POLICY = {
  schemaVersion: 1 as const,
  mode: 'denylist' as const,
  system: ['aiCli'] as const,
  shell: ['sudo'],
}

function snapshot(overrides: Partial<ExecutionPolicySettingsSnapshot> = {}): ExecutionPolicySettingsSnapshot {
  return {
    defaultPolicy: { ...DEFAULT_POLICY, system: [...DEFAULT_POLICY.system] },
    userPolicy: null,
    global: {
      policy: { ...DEFAULT_POLICY, system: [...DEFAULT_POLICY.system] },
      revision: 0,
      state: 'default',
    },
    workspace: {
      policy: { ...DEFAULT_POLICY, system: [...DEFAULT_POLICY.system] },
      revision: 0,
      selectedSource: null,
      activeSource: 'default',
      status: 'active',
      recommendation: {
        state: 'valid',
        policy: { ...RECOMMENDED_POLICY, system: [...RECOMMENDED_POLICY.system] },
        fingerprint: 'a'.repeat(64),
      },
      effectivePolicyKey: 'epk1:test',
      effectivePolicyHash: 'eph1:test',
    },
    recovery: { state: 'missing', canRebuild: false, unsafePaths: [] },
    sourceRecovery: { state: 'missing', canReset: false, unsafePaths: [] },
    ...overrides,
  }
}

function mockExecutionPolicy(initial: ExecutionPolicySettingsSnapshot = snapshot()): ExecutionPolicyApi {
  const api: ExecutionPolicyApi = {
    inspect: vi.fn().mockResolvedValue(initial),
    setUser: vi.fn().mockResolvedValue({ ok: true, changed: true, snapshot: initial }),
    resetUser: vi.fn().mockResolvedValue({ ok: true, changed: true, snapshot: initial }),
    selectSource: vi.fn().mockResolvedValue({ ok: true, changed: true, snapshot: initial }),
    rebuild: vi.fn().mockResolvedValue({ ok: true, changed: true, snapshot: initial }),
    resetSourceSelections: vi.fn().mockResolvedValue({ ok: true, changed: true, snapshot: initial }),
    onChanged: vi.fn().mockReturnValue(() => undefined),
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { executionPolicy: api }
  return api
}

describe('ExecutionPolicyPane', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('shows Host default and keeps a repository recommendation untrusted until accepted', async () => {
    const api = mockExecutionPolicy()
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.get('[data-section="host-default"]').text()).toContain('fs, ui, aiCli')
    expect(wrapper.get('[data-section="repository-recommendation"]').text()).toContain('Untrusted')
    expect(wrapper.get('.ep-recommendation-policy').text()).toContain('Denylist')
    expect(api.selectSource).not.toHaveBeenCalled()

    await wrapper.get('.ep-accept-recommendation').trigger('click')
    await flushPromises()
    expect(api.selectSource).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      request: { source: 'repository', expectedFingerprint: 'a'.repeat(64) },
    })
  })

  it('requires the full-mode high-risk acknowledgement before saving', async () => {
    const api = mockExecutionPolicy(snapshot({
      userPolicy: null,
      global: {
        policy: { ...DEFAULT_POLICY, system: [...DEFAULT_POLICY.system] },
        revision: 0,
        state: 'default',
      },
    }))
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('[data-mode="full"] input').setValue()
    expect(wrapper.get('.ep-full-warning').text()).toContain('arbitrary executables')
    expect(wrapper.get('.ep-save').attributes('disabled')).toBeDefined()
    await wrapper.get('.ep-full-confirmation').setValue(true)
    expect(wrapper.get('.ep-save').attributes('disabled')).toBeUndefined()
    await wrapper.get('.ep-save').trigger('click')
    await flushPromises()

    expect(api.setUser).toHaveBeenCalledWith({
      policy: { schemaVersion: 1, mode: 'full', system: [], shell: [] },
      expectedRevision: 0,
      highRiskConfirmed: true,
      workspacePath: '/workspace',
    })
  })

  it('requires a separate acknowledgement for the current full repository recommendation', async () => {
    const initial = snapshot()
    initial.workspace!.recommendation.policy = { schemaVersion: 1, mode: 'full', system: [], shell: [] }
    const api = mockExecutionPolicy(initial)
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.get('.ep-accept-recommendation').attributes('disabled')).toBeDefined()
    expect(wrapper.get('input[value="repository"]').attributes('disabled')).toBeDefined()
    await wrapper.get('.ep-repository-full-confirmation').setValue(true)
    await wrapper.get('.ep-accept-recommendation').trigger('click')
    await flushPromises()
    expect(api.selectSource).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      request: { source: 'repository', expectedFingerprint: 'a'.repeat(64) },
      highRiskConfirmed: true,
    })

    const changed = structuredClone(initial)
    changed.workspace!.recommendation.fingerprint = 'b'.repeat(64)
    vi.mocked(api.inspect).mockResolvedValue(changed)
    vi.mocked(api.onChanged).mock.calls[0]![0]()
    await flushPromises()
    expect(wrapper.get('.ep-repository-full-confirmation').element).toHaveProperty('checked', false)
    expect(wrapper.get('.ep-accept-recommendation').attributes('disabled')).toBeDefined()
  })

  it('treats an unrestricted denylist recommendation as high risk', async () => {
    const initial = snapshot()
    initial.workspace!.recommendation.policy = { schemaVersion: 1, mode: 'denylist', system: [], shell: [] }
    const api = mockExecutionPolicy(initial)
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.get('.ep-accept-recommendation').attributes('disabled')).toBeDefined()
    await wrapper.get('.ep-repository-full-confirmation').setValue(true)
    await wrapper.get('.ep-accept-recommendation').trigger('click')
    await flushPromises()
    expect(api.selectSource).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      request: { source: 'repository', expectedFingerprint: 'a'.repeat(64) },
      highRiskConfirmed: true,
    })
  })

  it('requires the high-risk acknowledgement before saving an unrestricted denylist', async () => {
    const api = mockExecutionPolicy()
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('[data-mode="denylist"] input').setValue()
    for (const namespace of ['fs', 'ui', 'aiCli']) {
      const checkbox = wrapper.get(`input[data-system="${namespace}"]`)
      if ((checkbox.element as HTMLInputElement).checked) await checkbox.trigger('change')
    }
    while (wrapper.findAll('.ep-chip button').length > 0) {
      await wrapper.findAll('.ep-chip button')[0]!.trigger('click')
    }
    await flushPromises()

    expect(wrapper.get('.ep-full-warning').text()).toContain('arbitrary executables')
    expect(wrapper.get('.ep-save').attributes('disabled')).toBeDefined()
    await wrapper.get('.ep-full-confirmation').setValue(true)
    expect(wrapper.get('.ep-save').attributes('disabled')).toBeUndefined()
    await wrapper.get('.ep-save').trigger('click')
    await flushPromises()

    expect(api.setUser).toHaveBeenCalledWith({
      policy: { schemaVersion: 1, mode: 'denylist', system: [], shell: [] },
      expectedRevision: 0,
      highRiskConfirmed: true,
      workspacePath: '/workspace',
    })
  })

  it('offers rebuild for corruption and manual guidance for an unsafe directory', async () => {
    const corrupted = snapshot({
      recovery: { state: 'corrupt', canRebuild: true, unsafePaths: [] },
    })
    const api = mockExecutionPolicy(corrupted)
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.find('.ep-rebuild').exists()).toBe(true)
    await wrapper.get('.ep-rebuild').trigger('click')
    expect(wrapper.find('.ep-rebuild-confirm').exists()).toBe(true)
    await wrapper.get('.ep-rebuild-confirm input').setValue(true)
    await wrapper.get('.ep-rebuild-confirm').trigger('submit')
    await flushPromises()
    expect(api.rebuild).toHaveBeenCalledWith({ confirmed: true, workspacePath: '/workspace' })

    wrapper.unmount()
    const unsafeApi = mockExecutionPolicy(snapshot({
      recovery: { state: 'directory-unsafe', canRebuild: false, unsafePaths: ['/tmp/execution-policy'] },
    }))
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.find('.ep-rebuild').exists()).toBe(false)
    expect(wrapper.text()).toContain('Policy storage is unsafe')
    expect(unsafeApi.rebuild).not.toHaveBeenCalled()
  })

  it('does not label a fail-closed workspace as an active global source', async () => {
    const api = mockExecutionPolicy(snapshot({
      workspace: {
        ...snapshot().workspace!,
        policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
        activeSource: null,
        selectedSource: 'repository',
        status: 'stale',
      },
    }))
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.get('[data-section="effective-policy"]').text()).toContain('Unavailable')
    expect(api.inspect).toHaveBeenCalledWith('/workspace')
  })

  it('keeps implicit source resolution separate from explicit source selection', async () => {
    const initial = snapshot()
    const explicitDefault = snapshot({
      workspace: {
        ...initial.workspace!,
        selectedSource: 'default',
        activeSource: 'default',
      },
    })
    const api = mockExecutionPolicy(initial)
    api.selectSource = vi.fn().mockResolvedValue({
      ok: true,
      changed: true,
      snapshot: explicitDefault,
    })
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect((wrapper.get('input[value="default"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('input[value="user"]').element as HTMLInputElement).checked).toBe(false)

    await wrapper.get('input[value="default"]').setValue(true)
    await flushPromises()

    expect(api.selectSource).toHaveBeenCalledWith({
      workspacePath: '/workspace',
      request: { source: 'default' },
    })
    expect((wrapper.get('input[value="default"]').element as HTMLInputElement).checked).toBe(true)

    wrapper.unmount()
    const implicitUser = snapshot({
      userPolicy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] },
      global: {
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] },
        revision: 1,
        state: 'user',
      },
      workspace: {
        ...initial.workspace!,
        selectedSource: null,
        activeSource: 'user',
      },
    })
    const userApi = mockExecutionPolicy(implicitUser)
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect((wrapper.get('input[value="user"]').element as HTMLInputElement).checked).toBe(false)
    expect(userApi.selectSource).not.toHaveBeenCalled()
  })

  it('rolls the source radio back when Host rejects a source change', async () => {
    const initial = snapshot()
    const api = mockExecutionPolicy(initial)
    api.selectSource = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'recommendation-stale',
        message: 'The repository policy recommendation changed.',
      },
      snapshot: initial,
    })
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('input[value="repository"]').setValue(true)
    await flushPromises()

    expect((wrapper.get('input[value="default"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('input[value="repository"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('.ep-error').text()).toContain('recommendation changed')
  })

  it('rolls the source radio back when the source request rejects', async () => {
    const initial = snapshot()
    const api = mockExecutionPolicy(initial)
    api.selectSource = vi.fn().mockRejectedValue(new Error('transport unavailable'))
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('input[value="repository"]').setValue(true)
    await flushPromises()

    expect((wrapper.get('input[value="default"]').element as HTMLInputElement).checked).toBe(false)
    expect((wrapper.get('input[value="repository"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.get('.ep-error').text()).toContain('Execution Policy is unavailable')
  })

  it('uses mode-specific allow and deny language in the editors', async () => {
    const api = mockExecutionPolicy()
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const editorBlocks = wrapper.findAll('.ep-editor-block')
    expect(editorBlocks[0].get('h3').text()).toBe('System namespaces to allow')
    expect(editorBlocks[0].text()).toContain('available to the agent')
    expect(editorBlocks[1].get('h3').text()).toBe('Shell executables to allow')

    await wrapper.get('[data-mode="denylist"] input').setValue(true)
    expect(wrapper.findAll('.ep-editor-block')[0].get('h3').text()).toBe('System namespaces to deny')
    expect(wrapper.findAll('.ep-editor-block')[0].text()).toContain('must not use')
    expect(wrapper.findAll('.ep-editor-block')[1].get('h3').text()).toBe('Shell executables to deny')
    expect(api.setUser).not.toHaveBeenCalled()
  })

  it('localizes Host source errors instead of displaying the Host message', async () => {
    i18n.global.locale.value = 'zh-TW'
    const initial = snapshot()
    const api = mockExecutionPolicy(initial)
    api.selectSource = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'recommendation-stale',
        message: 'The Host-only fallback message',
      },
      snapshot: initial,
    })
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('input[value="repository"]').setValue(true)
    await flushPromises()

    expect(wrapper.get('.ep-error').text()).toContain('Repository 政策建議已變更')
    expect(wrapper.get('.ep-error').text()).not.toContain('Host-only fallback message')
  })

  it('shows actionable validation for invalid and canonical duplicate shell names', async () => {
    const api = mockExecutionPolicy()
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    const form = wrapper.get('.ep-shell-add')
    const input = form.get('input')

    await input.setValue('GIT')
    await form.trigger('submit')
    expect(wrapper.get('.ep-error').text()).toContain('already in this policy')
    expect(wrapper.findAll('.ep-chip code').filter((item) => item.text() === 'git')).toHaveLength(1)

    await input.setValue('git status')
    await form.trigger('submit')
    expect(wrapper.get('.ep-error').text()).toContain('top-level executable name')
    expect(api.setUser).not.toHaveBeenCalled()
  })

  it('preserves a dirty draft across external updates until explicitly reloaded', async () => {
    const initial = snapshot({
      userPolicy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] },
      global: {
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] },
        revision: 1,
        state: 'user',
      },
      workspace: {
        ...snapshot().workspace!,
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: ['git'] },
        revision: 1,
        selectedSource: null,
        activeSource: 'user',
      },
      recovery: { state: 'healthy', canRebuild: false, unsafePaths: [] },
    })
    const external = snapshot({
      userPolicy: { schemaVersion: 1, mode: 'allowlist', system: ['ui'], shell: ['gh'] },
      global: {
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['ui'], shell: ['gh'] },
        revision: 2,
        state: 'user',
      },
      workspace: {
        ...snapshot().workspace!,
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['ui'], shell: ['gh'] },
        revision: 2,
        selectedSource: null,
        activeSource: 'user',
      },
      recovery: { state: 'healthy', canRebuild: false, unsafePaths: [] },
    })
    const api = mockExecutionPolicy(initial)
    let changedHandler: (() => void) | undefined
    api.inspect = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(external)
      .mockResolvedValue(external)
    api.onChanged = vi.fn((handler: () => void) => {
      changedHandler = handler
      return () => undefined
    })
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.get('[data-mode="denylist"] input').setValue(true)
    expect(wrapper.findAll('.ep-editor-block')[0].get('h3').text()).toBe('System namespaces to deny')
    expect(changedHandler).toBeDefined()
    changedHandler?.()
    await flushPromises()

    expect(wrapper.find('.ep-conflict').exists()).toBe(true)
    expect(wrapper.findAll('.ep-editor-block')[0].get('h3').text()).toBe('System namespaces to deny')
    expect(wrapper.get('.ep-conflict').text()).toContain('draft is preserved')

    await wrapper.get('.ep-conflict button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.ep-conflict').exists()).toBe(false)
    expect(wrapper.findAll('.ep-editor-block')[0].get('h3').text()).toBe('System namespaces to allow')
    expect(wrapper.get('.ep-chip code').text()).toBe('gh')
  })

  it('confirms the global source reset and explains its repository-file boundary', async () => {
    const initial = snapshot({
      workspace: {
        ...snapshot().workspace!,
        selectedSource: 'default',
        activeSource: 'default',
      },
      sourceRecovery: { state: 'healthy', canReset: true, unsafePaths: [] },
    })
    const api = mockExecutionPolicy(initial)
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.get('.ep-reset-sources').text()).toBe('Reset all Policy Source selections')
    await wrapper.get('.ep-reset-sources').trigger('click')
    expect(wrapper.get('.ep-source-reset-confirm').text()).toContain('does not modify or delete repository policy files')
    await wrapper.get('.ep-source-reset-confirm input').setValue(true)
    await wrapper.get('.ep-source-reset-confirm').trigger('submit')
    await flushPromises()

    expect(api.resetSourceSelections).toHaveBeenCalledWith({
      confirmed: true,
      workspacePath: '/workspace',
    })
    expect(wrapper.find('.ep-source-reset-confirm').exists()).toBe(false)
    expect(wrapper.get('.ep-notice').text()).toBe('All Policy Source selections were reset.')
  })

  it('exposes source reset for recoverable source-state corruption', async () => {
    const api = mockExecutionPolicy(snapshot({
      sourceRecovery: { state: 'corrupt', canReset: true, unsafePaths: [] },
    }))
    wrapper = mount(ExecutionPolicyPane, {
      props: { workspacePath: '/workspace' },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Policy Source state is corrupt')
    expect(wrapper.get('.ep-reset-sources').text()).toBe('Reset all Policy Source selections')
    expect(api.resetSourceSelections).not.toHaveBeenCalled()
  })
})
