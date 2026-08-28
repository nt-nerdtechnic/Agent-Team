// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '../../i18n'
import McpPane from '../McpPane.vue'

const agents = [
  { key: 'claude', label: 'Claude Code', state: 'wired', reflects: true },
  { key: 'codex', label: 'Codex', state: 'wired', reflects: true },
  { key: 'droid', label: 'Droid', state: 'planned', reflects: true },
  { key: 'aider', label: 'Aider', state: 'unsupported', reflects: false },
]

/** Navide's own list: what the block above this pane manages. */
const navideServers = [
  {
    name: 'context7',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    enabled: true,
    status: 'connected',
    tool_count: 2,
  },
]

const native = [
  {
    name: 'context7',
    agent: 'claude',
    transport: 'stdio',
    path: '/Users/x/.claude.json',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    url: '',
    env: { API_KEY: '***', LOG_LEVEL: 'debug' },
    headers: {},
    enabled: true,
    valid: true,
    error: '',
  },
  {
    name: 'xmind',
    agent: 'codex',
    transport: 'http',
    path: '/Users/x/.codex/config.toml',
    command: '',
    args: [],
    url: 'https://app.xmind.com/mcp',
    env: {},
    headers: {},
    enabled: false,
    valid: true,
    error: '',
  },
]

function mockBackend(payload: Record<string, unknown> = {}) {
  const send = vi.fn(async (_type: string, _payload?: unknown) => ({
    ok: true,
    payload: { servers: navideServers, native, agents, path: '/tmp/mcp.json', revision: '1', ...payload },
  }))
  return { backend: { send } as never, send }
}

async function mountPane(backend: never): Promise<VueWrapper> {
  const wrapper = mount(McpPane, { props: { backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

async function openCompareView(wrapper: VueWrapper): Promise<void> {
  const button = wrapper.findAll('.mcp-view-switch button').find((b) => b.text() === 'Compare')
  await button!.trigger('click')
  await flushPromises()
}

async function openCard(wrapper: VueWrapper, name: string): Promise<void> {
  const card = wrapper.findAll('.mcp-card').find((c) => c.find('strong').text() === name)
  if (!card) throw new Error(`no card named ${name}`)
  await card.trigger('click')
  await flushPromises()
}

describe('McpPane', () => {
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

  it('lists both sources from one call and files each row under where it came from', async () => {
    const { backend, send } = mockBackend()
    wrapper = await mountPane(backend)

    expect(send).toHaveBeenCalledWith('mcp.list_servers', {})
    const names = wrapper.findAll('.mcp-card strong').map((el) => el.text())
    expect(names).toEqual(['context7', 'xmind'])
    // context7 is Navide's *and* claude's: one row, grouped under Navide.
    const groups = wrapper.findAll('.mcp-group-title').map((el) => el.text())
    expect(groups[0]).toContain('Navide')
    expect(groups[1]).toContain('Codex')
  })

  it('shows every place a server is configured on its card', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)

    const card = wrapper.findAll('.mcp-card').find((c) => c.find('strong').text() === 'context7')
    const places = card!.findAll('.pchip').map((el) => el.text())
    expect(places).toEqual(['Navide', 'claude'])
  })

  it('separates "not configured" from "this CLI has no MCP" in the matrix', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openCompareView(wrapper)

    const row = wrapper
      .findAll('tbody tr')
      .find((tr) => tr.find('.matrix-name').exists() && tr.find('.matrix-name').text() === 'context7')
    const cells = row!.findAll('td')
    // Navide, claude, codex, droid, aider
    expect(cells.map((cell) => cell.attributes('class'))).toEqual([
      'here',
      'here',
      'off',
      'off',
      'unsupported',
    ])
  })

  it('marks a natively configured but switched-off server as disabled, not absent', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openCompareView(wrapper)

    const row = wrapper
      .findAll('tbody tr')
      .find((tr) => tr.find('.matrix-name').exists() && tr.find('.matrix-name').text() === 'xmind')
    const cells = row!.findAll('td')
    expect(cells[0].attributes('class')).toBe('off') // not one of Navide's
    expect(cells[2].attributes('class')).toBe('disabled') // codex, enabled:false
  })

  it('filters by source and by search text', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)

    const codexChip = wrapper.findAll('.mcp-chip').find((c) => c.text().startsWith('codex'))
    await codexChip!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.mcp-card strong').map((el) => el.text())).toEqual(['xmind'])

    const allChip = wrapper.findAll('.mcp-chip').find((c) => c.text().startsWith('All'))
    await allChip!.trigger('click')
    await wrapper.find('.mcp-pane-search').setValue('upstash')
    await flushPromises()
    expect(wrapper.findAll('.mcp-card strong').map((el) => el.text())).toEqual(['context7'])
  })

  it('opens one drawer showing every place, and offers no way to edit a native config', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openCard(wrapper, 'context7')

    const drawer = wrapper.find('.mcp-drawer')
    expect(drawer.exists()).toBe(true)
    expect(drawer.text()).toContain('Navide')
    expect(drawer.text()).toContain('Claude Code')
    expect(drawer.text()).toContain('/Users/x/.claude.json')
    // Read-only: the drawer has no inputs at all.
    expect(drawer.findAll('input')).toHaveLength(0)
    expect(drawer.findAll('textarea')).toHaveLength(0)
  })

  it('opens the CLI config file rather than trying to write it', async () => {
    const { backend } = mockBackend()
    wrapper = await mountPane(backend)
    await openCard(wrapper, 'context7')

    const button = wrapper
      .findAll('.mcp-drawer-actions button')
      .find((b) => b.text() === 'Open config file')
    await button!.trigger('click')
    await flushPromises()

    expect(openPath).toHaveBeenCalledWith('/Users/x/.claude.json')
  })

  it('reports a config it could not read instead of dropping it', async () => {
    const { backend } = mockBackend({
      servers: [],
      native: [
        {
          name: 'config.toml',
          agent: 'codex',
          transport: 'unknown',
          path: '/Users/x/.codex/config.toml',
          command: '',
          args: [],
          url: '',
          env: {},
          headers: {},
          enabled: true,
          valid: false,
          error: 'invalid TOML: line 3',
        },
      ],
    })
    wrapper = await mountPane(backend)

    expect(wrapper.find('.mcp-card-detail').text()).toContain('invalid TOML')
    await openCard(wrapper, 'config.toml')
    expect(wrapper.find('.mcp-drawer-hint.danger').text()).toContain('invalid TOML')
  })

  it('says so when nothing is configured anywhere', async () => {
    const { backend } = mockBackend({ servers: [], native: [] })
    wrapper = await mountPane(backend)

    expect(wrapper.find('.nv-empty').exists()).toBe(true)
    expect(wrapper.findAll('.mcp-card')).toHaveLength(0)
  })

  it('surfaces a failed listing without clearing what it already showed', async () => {
    const send = vi.fn(async () => ({ ok: false, error: { message: 'backend down' } }))
    wrapper = await mountPane({ send } as never)

    expect(wrapper.find('.mcp-pane-error').text()).toBe('backend down')
  })

  it('ignores a stale reload that lands after a newer one', async () => {
    // The parent refreshes this pane whenever it reloads its own list, so two
    // reloads really do overlap; the older answer must not win.
    const payloads = [
      { servers: [], native: [], agents, path: '/tmp/mcp.json', revision: '1' },
      { servers: navideServers, native, agents, path: '/tmp/mcp.json', revision: '2' },
    ]
    const resolvers: ((value: unknown) => void)[] = []
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )
    wrapper = mount(McpPane, {
      props: { backend: { send } as never },
      global: { plugins: [i18n] },
    })

    // The mount already fired one; start a second without awaiting it, so both
    // are genuinely in flight.
    void (wrapper.vm as unknown as { reload: () => Promise<void> }).reload()
    await flushPromises()
    // Answer the newer request first, then let the stale one land.
    resolvers[1]({ ok: true, payload: payloads[1] })
    await flushPromises()
    resolvers[0]({ ok: true, payload: payloads[0] })
    await flushPromises()

    expect(wrapper.findAll('.mcp-card strong').map((el) => el.text())).toEqual([
      'context7',
      'xmind',
    ])
    expect(wrapper.find('.mcp-pane-state.nv-loading').exists()).toBe(false)
  })
})
