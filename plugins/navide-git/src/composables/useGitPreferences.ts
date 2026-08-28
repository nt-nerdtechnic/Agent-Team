import { onScopeDispose, ref, type Ref } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  GIT_AUTO_COMMIT_KEY,
  GIT_LOG_ORDER_KEY,
  GIT_LOG_SCOPE_KEY,
  GIT_TOP_RATIO_KEY,
} from '../git-feature/gitPreferences'

export type GitLogScope = 'all' | 'current'
export type GitLogOrder = 'ancestor' | 'date'

export interface GitPreferences {
  readonly logScope: Readonly<Ref<GitLogScope>>
  readonly logOrder: Readonly<Ref<GitLogOrder>>
  readonly autoCommit: Readonly<Ref<boolean>>
  readonly gitTopRatio: Readonly<Ref<number>>
  setLogScope(scope: GitLogScope): void
  setLogOrder(order: GitLogOrder): void
  setAutoCommit(enabled: boolean): void
  setGitTopRatio(ratio: number): void
}

function readLogScope(): GitLogScope {
  return settingsGet<string | null>(GIT_LOG_SCOPE_KEY, null) === 'current' ? 'current' : 'all'
}

function readLogOrder(): GitLogOrder {
  return settingsGet<string | null>(GIT_LOG_ORDER_KEY, null) === 'date' ? 'date' : 'ancestor'
}

function readAutoCommit(): boolean {
  return settingsGet<string | null>(GIT_AUTO_COMMIT_KEY, null) === 'true'
}

function readTopRatio(): number {
  return parseFloat(settingsGet(GIT_TOP_RATIO_KEY, '')) || 0.5
}

/** Owns Git's durable preferences and separates external hydration from user writes. */
export function useGitPreferences(onExternalLogChange?: () => void): GitPreferences {
  const logScope = ref<GitLogScope>(readLogScope())
  const logOrder = ref<GitLogOrder>(readLogOrder())
  const autoCommit = ref(readAutoCommit())
  const gitTopRatio = ref(readTopRatio())

  const stopSettings = onSettingsChanged((keys) => {
    let logChanged = false
    if (keys.includes(GIT_LOG_SCOPE_KEY)) {
      const next = readLogScope()
      if (next !== logScope.value) {
        logScope.value = next
        logChanged = true
      }
    }
    if (keys.includes(GIT_LOG_ORDER_KEY)) {
      const next = readLogOrder()
      if (next !== logOrder.value) {
        logOrder.value = next
        logChanged = true
      }
    }
    if (keys.includes(GIT_AUTO_COMMIT_KEY)) {
      autoCommit.value = readAutoCommit()
    }
    if (keys.includes(GIT_TOP_RATIO_KEY)) {
      gitTopRatio.value = readTopRatio()
    }
    if (logChanged) onExternalLogChange?.()
  })
  onScopeDispose(stopSettings)

  return {
    logScope,
    logOrder,
    autoCommit,
    gitTopRatio,
    setLogScope(scope) {
      if (logScope.value === scope) return
      logScope.value = scope
      settingsSet(GIT_LOG_SCOPE_KEY, scope)
    },
    setLogOrder(order) {
      if (logOrder.value === order) return
      logOrder.value = order
      settingsSet(GIT_LOG_ORDER_KEY, order)
    },
    setAutoCommit(enabled) {
      if (autoCommit.value === enabled) return
      autoCommit.value = enabled
      settingsSet(GIT_AUTO_COMMIT_KEY, String(enabled))
    },
    setGitTopRatio(ratio) {
      if (gitTopRatio.value === ratio) return
      gitTopRatio.value = ratio
      settingsSet(GIT_TOP_RATIO_KEY, String(ratio))
    },
  }
}
