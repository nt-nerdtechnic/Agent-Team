import { onMounted, onUnmounted } from 'vue'
import type { KeybindingRule } from './types'
import { defaults } from './defaults'
import { KeyResolver } from './keyResolver'
import { executeCommand, registerCommand } from './commandRegistry'
import { setContext, getContext } from './contextService'
import { parseUserRules, sanitizeUserRules, serializeUserRules } from './customization'

export type { KeybindingRule }
export { registerCommand, executeCommand, setContext, getContext }

interface KeybindingsBridge {
  readKeybindings?: () => Promise<{ ok: boolean; content?: string; error?: string }>
  writeKeybindings?: (content: string) => Promise<{ ok: boolean; error?: string }>
  onKeybindingsChanged?: (cb: (content: string) => void) => void
}

function bridge(): KeybindingsBridge | undefined {
  return (window as Window & { agentTeam?: KeybindingsBridge }).agentTeam
}

let _userRules: KeybindingRule[] = []
// Bumped by every rule change so the async startup read can tell whether it is
// still the newest word on the subject; without it a save made while the first
// read is in flight is silently rolled back when that read lands.
let _rulesVersion = 0
let _resolver = new KeyResolver(defaults)
let _refCount = 0
let _changeSubscribed = false
let _capturing = false
let _captureTimer: ReturnType<typeof setTimeout> | null = null
const CAPTURE_TIMEOUT_MS = 60_000
const _listeners = new Set<() => void>()

/**
 * Suspends dispatch while the Settings recorder is reading raw keystrokes.
 * The dispatcher's listener is installed at App mount, i.e. before the
 * recorder's, and window capture-phase listeners run in registration order —
 * so the recorder cannot outrank it and has to switch it off instead.
 */
export function setKeyCaptureActive(active: boolean): void {
  if (_captureTimer !== null) {
    clearTimeout(_captureTimer)
    _captureTimer = null
  }
  _capturing = active
  if (active) {
    // Dead-man switch: while capture is on, every shortcut in the app is off. If
    // the recorder ever fails to switch it back — an exception mid-recording, a
    // future refactor that swaps its v-if for v-show — the user is left with a
    // silently keyboard-dead app and no way to tell why. Recording one chord
    // takes seconds, so releasing after a minute costs nothing and bounds the
    // blast radius of any such bug.
    _captureTimer = setTimeout(() => {
      _captureTimer = null
      _capturing = false
      _resolver.resetChord()
    }, CAPTURE_TIMEOUT_MS)
  } else {
    _resolver.resetChord()
  }
}

export function isKeyCaptureActive(): boolean {
  return _capturing
}

function buildResolver(): void {
  _resolver = new KeyResolver([...defaults, ..._userRules])
  for (const listener of _listeners) listener()
}

function handleKeydown(e: KeyboardEvent): void {
  // Mid-composition keys (zhuyin/pinyin/kana) must never match shortcuts nor
  // start chords; intercepting them breaks composition and lags typing. Don't
  // also gate on keyCode 229: non-composing IME-intercepted events ("Process")
  // carry 229 too and must still resolve via e.code (ctrl+digit leak fix).
  if (e.isComposing) return
  if (_capturing) return
  const rule = _resolver.resolve(e, getContext())
  if (!rule) {
    // Chord started: consume the first key so it doesn't reach bubble-phase
    // handlers (e.g. cmd+k would otherwise open CmdK while waiting for the
    // second key of the cmd+k cmd+f chord).
    if (_resolver.hasPendingChord()) {
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    return
  }
  if (executeCommand(rule.command, rule.args)) {
    e.stopImmediatePropagation()
    e.preventDefault()
  }
}

async function loadUserRulesFromIPC(): Promise<void> {
  const api = bridge()
  if (!api?.readKeybindings) return
  const version = _rulesVersion
  try {
    const result = await api.readKeybindings()
    if (_rulesVersion !== version) return // superseded by a save or a broadcast
    if (result?.ok && result.content) {
      setUserRules(parseUserRules(result.content).rules)
    } else if (result && !result.ok) {
      // Falling back to defaults is right, but doing it silently is not: from
      // the user's side their customisations just vanished. Main only reports
      // !ok for a real failure (a missing file is ok with an empty set), so
      // this always means something worth seeing.
      console.warn('[keybindings] could not read keybindings.json, using defaults:', result.error)
    }
  } catch (e) {
    console.warn('[keybindings] failed to load user rules, using defaults:', e)
  }
}

// Every window keeps its own resolver, so a change made in Settings has to be
// pushed to the Mini IDE / Git / Plan windows too — without it those windows
// would keep the shipped defaults until they were reopened.
function subscribeToChanges(): void {
  const api = bridge()
  if (_changeSubscribed || !api?.onKeybindingsChanged) return
  _changeSubscribed = true
  api.onKeybindingsChanged((content: string) => {
    setUserRules(parseUserRules(content).rules)
  })
}

// Call in root App setup() to install the capture-phase window listener.
// Individual components may also call useKeybindings() purely to registerCommand/setContext —
// the listener is shared; only the first mount actually attaches it.
export function useKeybindings() {
  onMounted(() => {
    if (_refCount === 0) {
      window.addEventListener('keydown', handleKeydown, { capture: true })
      void loadUserRulesFromIPC()
      subscribeToChanges()
    }
    _refCount++
  })

  onUnmounted(() => {
    _refCount--
    if (_refCount === 0) {
      window.removeEventListener('keydown', handleKeydown, { capture: true })
      _resolver.resetChord()
    }
  })

  return { registerCommand, executeCommand, setContext, getContext }
}

// Load user-defined overrides (e.g. from userData/keybindings.json via IPC).
// Later rules take priority over defaults.
export function setUserRules(rules: KeybindingRule[]): void {
  // Never let a stored rule set strand the way back into Settings, however it
  // got there — a hand-edited file reaches this the same as an editor save.
  _userRules = sanitizeUserRules(rules)
  _rulesVersion++
  buildResolver()
}

export function getUserRules(): KeybindingRule[] {
  return _userRules
}

/** Notifies callers whenever the effective rule set changes (local or remote). */
export function onUserRulesChanged(listener: () => void): () => void {
  _listeners.add(listener)
  return () => { _listeners.delete(listener) }
}

/**
 * Persists overrides and applies them here immediately. The main process
 * echoes the write to every other window, so all resolvers converge without a
 * restart.
 */
export async function saveUserRules(
  rules: KeybindingRule[],
): Promise<{ ok: boolean; error?: string }> {
  setUserRules(rules)
  const api = bridge()
  if (!api?.writeKeybindings) return { ok: false, error: 'keybindings bridge unavailable' }
  try {
    // Persist what actually took effect, not what was handed in: setUserRules
    // may have dropped a rule that would strand a protected command, and a file
    // holding rules the app silently ignores is worse than no file.
    return await api.writeKeybindings(serializeUserRules(_userRules))
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// Test seam: drops subscriptions so suites can re-mount cleanly.
export function _resetKeybindingsState(): void {
  _userRules = []
  _listeners.clear()
  _changeSubscribed = false
  _capturing = false
  if (_captureTimer !== null) {
    clearTimeout(_captureTimer)
    _captureTimer = null
  }
  buildResolver()
}
