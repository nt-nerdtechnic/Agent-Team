// User preferences for which CLI agents appear in the manual-spawn dropdown and
// in what order. Module-scoped singleton refs so the Settings modal (writer) and
// App.vue (reader) share one reactive source — a plain settingsGet() is not
// reactive, so a shared ref is what makes a settings edit reflect live.
//
// Persistence: primarily per-workspace, in project.json (App.vue watches
// `order`/`disabled` and calls project.set_ui_state, mirroring how run-group
// tabs are persisted); App.vue calls loadCliAgentPrefsFromProject() on every
// workspace switch to load that workspace's saved value. The global per-user
// KV (settings.ts) is still written unconditionally here as a backstop — it's
// the only persistence when no workspace is open yet or the window is
// detached (App.vue's workspace-scoped save silently no-ops in both cases) —
// and doubles as the fallback default for a workspace that never persisted
// its own value, so existing users don't lose their current customization.

import { ref, watch } from 'vue'

import { settingsGet, settingsSet } from '@navide/shared'

const ORDER_KEY = 'agentTeam.cliAgents.order' // legacy global fallback default
const DISABLED_KEY = 'agentTeam.cliAgents.disabled' // legacy global fallback default

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(settingsGet(key, ''))
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // no/blank/corrupt setting → empty (caller treats as "no custom preference")
  }
  return []
}

const order = ref<string[]>(readStringArray(ORDER_KEY))
const disabled = ref<string[]>(readStringArray(DISABLED_KEY))

watch(order, (v) => settingsSet(ORDER_KEY, JSON.stringify(v)), { deep: true })
watch(disabled, (v) => settingsSet(DISABLED_KEY, JSON.stringify(v)), { deep: true })

/**
 * Apply the workspace's persisted CLI agent order/disabled list (from
 * project.cli_agent_order / project.cli_agent_disabled). null/undefined
 * (never persisted for this workspace) falls back to the legacy global
 * default; [] is a valid "explicitly cleared to default" value.
 */
export function loadCliAgentPrefsFromProject(
  cliAgentOrder: string[] | null | undefined,
  cliAgentDisabled: string[] | null | undefined
): void {
  order.value = Array.isArray(cliAgentOrder) ? cliAgentOrder : readStringArray(ORDER_KEY)
  disabled.value = Array.isArray(cliAgentDisabled) ? cliAgentDisabled : readStringArray(DISABLED_KEY)
}

/**
 * Order `agentKeys` by the user's custom order; keys not in the order keep their
 * original relative position, appended after the ordered ones (stable).
 */
export function orderedAgentKeys(agentKeys: string[]): string[] {
  const rank = (k: string) => {
    const i = order.value.indexOf(k)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...agentKeys].sort((a, b) => rank(a) - rank(b))
}

export function isAgentEnabled(agentKey: string): boolean {
  return !disabled.value.includes(agentKey)
}

export function useCliAgentPrefs() {
  return { order, disabled }
}
