// @vitest-environment happy-dom
// The per-vendor push-channel switches in Settings → CLI Agents.
//
// The switch is a negative list shared with the backend, which is the only
// place it is applied: what this file pins down is that the UI writes the key
// the backend reads, that it only offers vendors that actually have a channel,
// and that every channel is on until someone says otherwise.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { seedSettings, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

/** The key both sides agree on — see push_delivery.DISABLED_SETTING_KEY. */
const PUSH_DISABLED_KEY = 'pushChannelsDisabled'

/** The component's own toggle, reproduced here rather than mounting the whole
 *  settings modal: the modal pulls in the analyzer, the updater and the MCP
 *  catalog, none of which this behaviour touches. */
function togglePushChannel(current: string[], key: string): string[] {
  const set = new Set(current)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  const next = [...set]
  settingsSet(PUSH_DISABLED_KEY, next)
  return next
}

describe('Settings — push channels', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    vi.restoreAllMocks()
  })

  it('offers exactly the CLIs that declare a channel', () => {
    const offered = CLI_AGENT_SPECS.filter((s) => s.pushChannel).map((s) => s.agentKey)
    expect(offered.sort()).toEqual(['claude', 'kilo', 'opencode', 'qwen'])
  })

  it('every declared channel is on when nothing was ever saved', () => {
    const disabled = settingsGet<string[]>(PUSH_DISABLED_KEY, [])
    expect(disabled).toEqual([])
    for (const spec of CLI_AGENT_SPECS) {
      expect(disabled.includes(spec.agentKey)).toBe(false)
    }
  })

  it('switching one off records only that one', () => {
    const next = togglePushChannel([], 'opencode')
    expect(next).toEqual(['opencode'])
    expect(settingsGet<string[]>(PUSH_DISABLED_KEY, [])).toEqual(['opencode'])
  })

  it('switching it back on removes it again', () => {
    const off = togglePushChannel([], 'qwen')
    const back = togglePushChannel(off, 'qwen')
    expect(back).toEqual([])
    expect(settingsGet<string[]>(PUSH_DISABLED_KEY, [])).toEqual([])
  })

  it('allows every channel to be switched off', () => {
    // Unlike the CLI-agents list, which must keep one enabled or nothing can
    // spawn: with no channels at all, messages are simply typed in.
    let disabled: string[] = []
    for (const spec of CLI_AGENT_SPECS.filter((s) => s.pushChannel)) {
      disabled = togglePushChannel(disabled, spec.agentKey)
    }
    expect(disabled.sort()).toEqual(['claude', 'kilo', 'opencode', 'qwen'])
  })

  it('reads back a list saved by another window', () => {
    seedSettings({ [PUSH_DISABLED_KEY]: ['kilo', 'claude'] })
    expect(settingsGet<string[]>(PUSH_DISABLED_KEY, []).sort()).toEqual(['claude', 'kilo'])
  })

  it('has a cost line for every vendor it offers', async () => {
    const { i18n } = await import('@navide/plugin-ui/foundation')
    for (const locale of ['en-US', 'zh-TW'] as const) {
      const messages = i18n.global.getLocaleMessage(locale) as Record<string, any>
      const block = messages.settings?.pushChannels
      expect(block, locale).toBeTruthy()
      for (const spec of CLI_AGENT_SPECS.filter((s) => s.pushChannel)) {
        expect(block[`cost-${spec.agentKey}`], `${locale}/${spec.agentKey}`).toBeTruthy()
      }
    }
  })
})
