// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import CliAccountsPane from '../CliAccountsPane.vue'
import { i18n } from '../../i18n'
import type {
  useCliProfiles,
  CliProfile,
  CliProfileDefaults,
  CliProfileIdentities,
} from '../../composables/useCliProfiles'

// Stub useNotify (module-level singleton) so confirm dialogs resolve without
// rendering NotificationHost. Shared spies, reset between tests.
const notify = {
  toast: vi.fn(),
  alert: vi.fn(async () => true),
  confirm: vi.fn(async (..._args: unknown[]) => true),
  prompt: vi.fn(async () => null),
}
vi.mock('../../composables/useNotify', () => ({ useNotify: () => notify }))

// CLI_AGENT_SPECS order: claude(0), codex(1), antigravity(2), grok(3), kimi(4)
const SUPPORTED = ['claude', 'codex', 'grok', 'kimi']

interface ApiOptions {
  profiles?: CliProfile[]
  defaults?: CliProfileDefaults
  identities?: CliProfileIdentities
  supported?: string[]
  error?: string
}

// Fake `api` prop mirroring the useCliProfiles return shape (refs + fns),
// with no backend WS underneath.
function makeApi(opts: ApiOptions = {}) {
  const profiles = ref<CliProfile[]>(opts.profiles ?? [])
  const defaults = ref<CliProfileDefaults>(opts.defaults ?? {})
  const identities = ref<CliProfileIdentities>(opts.identities ?? {})
  const supportedAgents = ref<string[]>(opts.supported ?? SUPPORTED)
  const error = ref<string>(opts.error ?? '')

  const api = {
    profiles,
    defaults,
    identities,
    supportedAgents,
    loaded: ref(true),
    loading: ref(false),
    error,
    refresh: vi.fn(async () => {}),
    create: vi.fn(async (agentKey: string, name: string): Promise<CliProfile | null> => {
      const profile: CliProfile = { id: 'created-id', agentKey, name, createdAt: '2026-07-25' }
      profiles.value = [...profiles.value, profile]
      return profile
    }),
    rename: vi.fn(async () => null),
    remove: vi.fn(async () => true),
    setDefault: vi.fn(async () => ({ ok: true as const })),
    profilesForAgent: (agentKey: string) => profiles.value.filter((p) => p.agentKey === agentKey),
    hasProfiles: (agentKey: string) => profiles.value.some((p) => p.agentKey === agentKey),
    defaultProfileId: (agentKey: string) => defaults.value[agentKey] ?? null,
    findProfile: (id: string | null | undefined) =>
      id ? profiles.value.find((p) => p.id === id) : undefined,
    identityFor: (agentKey: string, profileId: string | null) =>
      identities.value[agentKey]?.[profileId ?? '__default__'] ?? null,
  }
  return api as unknown as ReturnType<typeof useCliProfiles>
}

function profile(id: string, agentKey: string, name: string): CliProfile {
  return { id, agentKey, name, createdAt: '2026-07-25' }
}

describe('CliAccountsPane', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.clearAllMocks()
  })

  function mountPane(
    api: ReturnType<typeof useCliProfiles>,
    opts: { workspaceOpen?: boolean } = {},
  ) {
    wrapper = mount(CliAccountsPane, {
      props: { api, workspaceOpen: opts.workspaceOpen ?? true },
      global: { plugins: [i18n] },
    })
    return wrapper
  }

  /** Section for one agent, in CLI_AGENT_SPECS order. */
  function section(w: VueWrapper, index: number) {
    return w.findAll('section.cli-agent')[index]
  }

  function buttonByText(scope: ReturnType<VueWrapper['findAll']>[number], text: string) {
    return scope.findAll('button').find((b) => b.text() === text)
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders the Default row plus profile rows for a supported agent', () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2'), profile('p2', 'claude', 'Account 3')],
    })
    const w = mountPane(api)

    const claude = section(w, 0)
    expect(claude.text()).toContain('Claude Code')
    expect(claude.findAll('.cli-row')).toHaveLength(3) // Default + 2 profiles
    expect(buttonByText(claude, '+ New account')).toBeDefined()
    expect(claude.find('.cli-unsupported').exists()).toBe(false)
  })

  it('shows the unsupported message and no rows for an unsupported agent', () => {
    const w = mountPane(makeApi())

    const antigravity = section(w, 2)
    expect(antigravity.get('.cli-unsupported').text()).toBe(
      'This agent does not support multiple accounts.',
    )
    expect(antigravity.findAll('.cli-row')).toHaveLength(0)
    expect(buttonByText(antigravity, '+ New account')).toBeUndefined()
  })

  // ── rowName ────────────────────────────────────────────────────────────────

  it('names rows by email first, then profile name when signed in, else not-signed-in', () => {
    const api = makeApi({
      profiles: [
        profile('p-email', 'claude', 'Account 2'),
        profile('p-noemail', 'claude', 'Account 3'),
        profile('p-signedout', 'claude', 'Account 4'),
      ],
      identities: {
        claude: {
          'p-email': { email: 'me@example.com', signedIn: true },
          'p-noemail': { email: null, signedIn: true },
          'p-signedout': { email: null, signedIn: false },
        },
      },
    })
    const w = mountPane(api)

    const names = section(w, 0)
      .findAll('.cli-row-name')
      .map((n) => n.text())
    // Row 0 is the built-in Default (no identity -> "Default" label).
    expect(names).toEqual(['Default', 'me@example.com', 'Account 3', 'Not signed in'])
  })

  // ── addAccount ─────────────────────────────────────────────────────────────

  it('addAccount creates an auto-named slot and emits an isolated login (no switch)', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    await buttonByText(section(w, 0), '+ New account')!.trigger('click')
    await flushPromises()

    // 1 existing claude profile -> "Account 3".
    expect(api.create).toHaveBeenCalledWith('claude', 'Account 3')
    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude', 'created-id']])
  })

  it('addAccount never reuses a deleted auto name (max existing N + 1)', async () => {
    // "Account 2" was deleted, leaving only "Account 3". Length-based
    // numbering would mint a second "Account 3" — indistinguishable rows for
    // identity-less agents (kimi). Max+1 must yield "Account 4".
    const api = makeApi({ profiles: [profile('p3', 'kimi', 'Account 3')] })
    const w = mountPane(api)

    await buttonByText(section(w, 4), '+ New account')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith('kimi', 'Account 4')
  })

  it('addAccount starts at "Account 2" when no existing name matches the pattern', async () => {
    const api = makeApi({ profiles: [profile('px', 'kimi', 'Work login')] })
    const w = mountPane(api)

    await buttonByText(section(w, 4), '+ New account')!.trigger('click')
    await flushPromises()

    expect(api.create).toHaveBeenCalledWith('kimi', 'Account 2')
  })

  // ── no-workspace guard (login pane needs a workspace to spawn into) ────────

  it('addAccount without a workspace blocks BEFORE creating a row and toasts', async () => {
    const api = makeApi()
    const w = mountPane(api, { workspaceOpen: false })

    await buttonByText(section(w, 0), '+ New account')!.trigger('click')
    await flushPromises()

    // No orphan "Not signed in" row: create was never called, nothing emitted.
    expect(api.create).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()
    expect(notify.toast).toHaveBeenCalledTimes(1)
    expect(notify.toast.mock.calls[0][0]).toContain('Open a workspace first')
  })

  it('signIn without a workspace blocks up front (no switch, no login emit)', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api, { workspaceOpen: false })

    const row = section(w, 0).findAll('.cli-row')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign in')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toBeUndefined()
    expect(notify.toast).toHaveBeenCalledTimes(1)
  })

  // ── signIn ─────────────────────────────────────────────────────────────────

  it('signIn on a non-active profile emits an isolated login without switching', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    // Row 0 is the built-in Default; row 1 is p1 (not signed in, not active).
    const row = section(w, 0).findAll('.cli-row')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign in')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude', 'p1']])
  })

  it('signIn on the ACTIVE profile stays a live login (no profile id)', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
    })
    const w = mountPane(api)

    const row = section(w, 0).findAll('.cli-row')[1]
    await row.findAll('button').find((b) => b.text() === 'Sign in')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).not.toHaveBeenCalled()
    expect(w.emitted('login')).toEqual([['claude']])
  })

  it('signIn on a non-active Default row still switches first, then logs in live', async () => {
    const api = makeApi({
      profiles: [profile('p1', 'claude', 'Account 2')],
      defaults: { claude: 'p1' },
    })
    const w = mountPane(api)

    const defaultRow = section(w, 0).findAll('.cli-row')[0]
    await defaultRow.findAll('button').find((b) => b.text() === 'Sign in')!.trigger('click')
    await flushPromises()

    expect(api.setDefault).toHaveBeenCalledWith('claude', null)
    expect(w.emitted('login')).toEqual([['claude']])
  })

  // ── setDefault / PROFILE_IN_USE confirm flow ───────────────────────────────

  it('retries setDefault with force after confirming PROFILE_IN_USE', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockResolvedValueOnce({ ok: false, code: 'PROFILE_IN_USE', runningCount: 2 })
    notify.confirm.mockResolvedValueOnce(true)
    const w = mountPane(api)

    // Default is null, so the profile row shows "Set as default".
    await buttonByText(section(w, 0), 'Set as default')!.trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(notify.confirm.mock.calls[0][0]).toContain('2 running Claude Code panes')
    expect(setDefault).toHaveBeenCalledTimes(2)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
  })

  it('does not retry when the PROFILE_IN_USE confirm is cancelled', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const setDefault = api.setDefault as ReturnType<typeof vi.fn>
    setDefault.mockResolvedValueOnce({ ok: false, code: 'PROFILE_IN_USE', runningCount: 1 })
    notify.confirm.mockResolvedValueOnce(false)
    const w = mountPane(api)

    await buttonByText(section(w, 0), 'Set as default')!.trigger('click')
    await flushPromises()

    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(w.emitted('login')).toBeUndefined()
  })

  // ── remove ─────────────────────────────────────────────────────────────────

  it('removes a profile only after the inline two-step confirmation', async () => {
    const api = makeApi({ profiles: [profile('p1', 'claude', 'Account 2')] })
    const w = mountPane(api)

    // Step 1: the row's Delete button arms the inline confirm.
    await buttonByText(section(w, 0), 'Delete')!.trigger('click')
    expect(api.remove).not.toHaveBeenCalled()
    expect(section(w, 0).get('.cli-confirm-text').text()).toContain('Delete this account?')

    // Step 2: the danger Delete button performs the removal.
    await section(w, 0).get('.cli-btn.danger').trigger('click')
    await flushPromises()

    expect(api.remove).toHaveBeenCalledWith('p1')
    // Confirm state is cleared after a successful remove.
    expect(section(w, 0).find('.cli-confirm-text').exists()).toBe(false)
  })

  // ── error banner ───────────────────────────────────────────────────────────

  it('shows the danger banner when the composable reports an error', () => {
    const w = mountPane(makeApi({ error: 'boom: backend unavailable' }))

    const banner = w.get('.cli-banner.danger')
    expect(banner.text()).toBe('boom: backend unavailable')
  })

  it('shows no banner when there is no error', () => {
    const w = mountPane(makeApi())
    expect(w.find('.cli-banner').exists()).toBe(false)
  })
})
