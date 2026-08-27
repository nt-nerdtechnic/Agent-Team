<script setup lang="ts">
// AiCliDock — the shared right-side CLI agent terminal shell (rail toggle +
// resize + agent picker + Start/Interrupt/Stop + embedded PTY terminal),
// extracted from the Pipeline Manager window's inline AI panel so other
// standalone windows (Plan) can embed the same real-CLI panel.
//
// Layout contract (inherited from the retired AiChatDock): renders three
// siblings (rail / resize
// handle / panel) meant to sit at the END of a row-flex container. Width is
// clamped 280–600 and persisted per-window via `widthKey`. The terminal mounts
// EAGERLY as soon as a workspace exists — panel visibility is v-show only —
// because the connect-time reattach must claim ownership of a still-running
// PTY even while the panel stays closed; an unclaimed PTY is reaped by the
// backend janitor after its idle window.
//
// State machine carried over from the PM panel verbatim:
// - connect-time tryReattach (once per window life) with a `reattaching` lock
//   that keeps Start disabled — a spawn racing the reattach would double-bind
//   the session handlers (doubled output + leaked subscription);
// - Start requires a live backend connection and always means a NEW PTY
//   (skipReattach: true; a still-live predecessor is reaped via
//   replaces_terminal_id);
// - context (host-supplied `buildContext`) is injected on FRESH spawns only —
//   reattach keeps the running conversation untouched;
// - Stop while 'starting' cancels the pending terminal.create (no sessionId
//   yet, kill() would be a no-op and a hung create uncancellable).
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { CLI_AGENT_SPECS } from '../agents'
import { bracketedPaste, resolveCliCommand } from '../lib/aiCliContext'
import type { MentionCandidate, TerminalDockPort } from '@navide/terminal'
import AiCliTerminal from './AiCliTerminal.vue'

const props = withDefaults(
  defineProps<{
    /** Settings key persisting this window's panel width (per-window). */
    widthKey: string
    /** Workspace the CLI spawns in; empty shows the no-workspace empty state. */
    workspacePath: string
    terminalPort: TerminalDockPort
    /** Pane id, unique per (surface, workspace) — derive it with
     *  aiTerminalPaneId(). The first 8 chars MUST be hex: aider's per-pane
     *  chat-history file name is derived from paneId.slice(0, 8) and the
     *  backend only claims 8-hex tokens — a non-hex prefix silently degrades
     *  aider to the SHARED history file. */
    paneId: string
    /** terminal.create metadata origin tag (e.g. 'pipeline-manager'). */
    origin: string
    /** False while the host is still resolving its workspace — suppresses the
     *  no-workspace empty state until the answer is definitive. */
    workspaceResolved?: boolean
    /** Initial width when no persisted value exists yet. */
    defaultWidth?: number
    /** i18n key for the rail tooltip and panel header title. */
    titleKey?: string
    /** Settings key persisting the agent choice; defaults to `${widthKey}.agent`. */
    agentKeyStorageKey?: string
    /** Subset of agent keys offered in the picker; defaults to all CLI agents. */
    agentKeys?: string[]
    /** Context payload injected after a fresh spawn; nothing is injected when
     *  absent. May be async (e.g. reads the open document via the backend). */
    buildContext?: () => string | Promise<string>
    /** Silence window after the CLI's startup output before injecting. */
    injectQuietMs?: number
    /** Hard cap on waiting for that silence. */
    injectTimeoutMs?: number
  }>(),
  {
    workspaceResolved: true,
    defaultWidth: 360,
    titleKey: 'pane.ai-terminal.title',
    injectQuietMs: 2000,
    injectTimeoutMs: 12000,
  }
)

const emit = defineEmits<{
  (e: 'spawned', agentKey: string): void
  (e: 'exited'): void
  (e: 'status', status: string): void
}>()

const { t } = useI18n()

// ── Shell: open state, lazy mount, width ────────────────────────────────────

const open = defineModel<boolean>('open', { default: false })

function toggle(): void {
  open.value = !open.value
}

function clampWidth(w: number): number {
  return Math.max(280, Math.min(600, w))
}
const width = ref(clampWidth(parseInt(settingsGet(props.widthKey, String(props.defaultWidth)), 10)))
let resizing = false
// The dock's right edge is the viewport edge in a standalone window but not
// when the host is a centered modal, so measure it instead of assuming.
const panelRef = ref<HTMLElement | null>(null)
let resizeAnchorX = 0
function onResizeStart(): void {
  resizing = true
  // A zero right edge means the element has no layout yet — fall back to the viewport.
  resizeAnchorX = panelRef.value?.getBoundingClientRect().right || window.innerWidth
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
}
function onResizeMove(e: MouseEvent): void {
  if (!resizing) return
  width.value = clampWidth(resizeAnchorX - e.clientX)
}
function onResizeEnd(): void {
  if (!resizing) return
  resizing = false
  settingsSet(props.widthKey, String(width.value))
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
})

// ── CLI state machine ───────────────────────────────────────────────────────

const termRef = ref<InstanceType<typeof AiCliTerminal> | null>(null)

const agentSpecs = computed(() =>
  props.agentKeys
    ? CLI_AGENT_SPECS.filter((s) => props.agentKeys!.includes(s.agentKey))
    : CLI_AGENT_SPECS
)
const agentStorageKey = computed(() => props.agentKeyStorageKey ?? `${props.widthKey}.agent`)
const agentKey = ref(settingsGet<string>(agentStorageKey.value, 'claude'))
watch(agentKey, (k) => settingsSet(agentStorageKey.value, k))

const starting = ref(false)
const status = computed(() => termRef.value?.status ?? 'idle')
/** A PTY is attached (fresh spawn or reattach) and not yet exited. */
const active = computed(() => status.value === 'starting' || status.value === 'running')
const agentLabel = computed(
  () => CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey.value)?.label ?? agentKey.value
)
const workspaceName = computed(() => props.workspacePath.split('/').filter(Boolean).pop() ?? '')

watch(status, (s, prev) => {
  emit('status', s)
  const wasActive = prev === 'starting' || prev === 'running'
  if (wasActive && !(s === 'starting' || s === 'running')) emit('exited')
})

// Connect-time reattach (once per window life): claim a CLI left running by a
// previous window instance instead of respawning. Runs once the backend is
// connected AND a workspace exists (the terminal mounts eagerly with it, even
// while the panel is closed) — a dead or absent PTY simply leaves the Start UI
// showing. Start is locked out while it is in flight (see header note).
let reattachAttempted = false
const reattaching = ref(false)
async function maybeReattach(): Promise<void> {
  if (reattachAttempted) return
  if (props.terminalPort.status.value !== 'connected') return
  if (!props.workspacePath) return
  reattachAttempted = true
  reattaching.value = true
  try {
    await nextTick() // the v-if just unlocked — let the terminal mount first
    // Pass the agent: this path never calls spawn(), which is the only other
    // place useTerminal records it, and the input protocol (Shift+Enter,
    // bracketed paste) degrades to plain-shell encoding without it.
    await termRef.value?.tryReattach({ agentKey: agentKey.value })
  } catch { /* PTY gone — fall through to the Start UI */ }
  finally { reattaching.value = false }
}
watch(
  [() => props.terminalPort.status.value, () => props.workspacePath],
  () => void maybeReattach(),
  { immediate: true }
)

// Names offered by the terminal's @-mention menu: every pane in the backend
// messaging roster except this one, as `<folder>/<pane>` addresses. Polled
// rather than pushed (as in the main window) — the list only feeds
// autocomplete, so a stale snapshot costs nothing; routing always re-resolves
// in the backend. This panel is not itself registered in the roster, so the
// mentions go one way: from here out to the main window's panes.
const mentionTargets = ref<MentionCandidate[]>([])
async function refreshMentionTargets(): Promise<void> {
  if (props.terminalPort.status.value !== 'connected') return
  try {
    const resp = await props.terminalPort.listAgentPanes()
    // Every address here lives in another window, so none of them carries a
    // status this panel could read — the menu draws hollow dots and says so by
    // omission rather than inventing one.
    const group = t('mention.group-remote')
    mentionTargets.value = (resp.payload?.panes ?? [])
      .filter((p) => p.qualified_name && p.pane_id !== props.paneId)
      .map((p) => ({ address: p.qualified_name as string, group }))
  } catch {
    mentionTargets.value = []
  }
}
// Stable identity so the terminal's prop does not churn on every render; the
// polled list is read through it when the menu opens.
const mentionCandidateGetter = (): MentionCandidate[] => mentionTargets.value
watch(() => props.terminalPort.status.value, () => void refreshMentionTargets(), { immediate: true })
const mentionPollTimer = setInterval(() => void refreshMentionTargets(), 10_000)
onUnmounted(() => clearInterval(mentionPollTimer))

// The panel opens from display:none — refit once measurable so the terminal
// paints at the real width (sanctioned explicit-refit path, no history loss).
watch(open, (o) => {
  if (o) void nextTick(() => termRef.value?.fitTerminal({ redrawAfterSettle: true }))
})

async function start(): Promise<void> {
  const term = termRef.value
  // Also require a live connection: a create queued while disconnected would
  // race the connect-time tryReattach and double-bind output handlers.
  if (!term || !props.workspacePath || starting.value || active.value || reattaching.value) return
  if (props.terminalPort.status.value !== 'connected') return
  starting.value = true
  try {
    const shell = props.terminalPort.shell.value || 'bash'
    const command = resolveCliCommand({
      agentKey: agentKey.value,
      paneId: props.paneId,
      historyRoot: props.workspacePath,
      yoloStored: settingsGet<string>('agentTeam.yolo', '1'),
    })
    await term.spawn({
      // zsh reads ~/.zshrc (where installers add PATH) only in interactive
      // mode — plain -lc misses it (same wrapping as App.vue spawns).
      command: [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', command],
      cwd: props.workspacePath,
      agentKey: agentKey.value,
      metadata: {
        workspace_path: props.workspacePath,
        origin: props.origin,
        yolo: settingsGet<string>('agentTeam.yolo', '1') !== '0',
      },
      // Start always means a NEW PTY. Reattach belongs to the connect-time
      // tryReattach above — letting spawn's internal reattach run here could
      // rebind a live conversation and re-inject context into it. A still-live
      // predecessor is reaped via replaces_terminal_id.
      skipReattach: true,
    })
    // Context is injected on FRESH spawns only — reattach keeps the running
    // conversation untouched (mount-time tryReattach already claimed any live
    // PTY, so reaching here means this spawn created a new one).
    if (term.status === 'running') {
      emit('spawned', agentKey.value)
      void injectContext()
    }
  } catch { /* spawn errors are rendered inside the terminal by useTerminal */ }
  finally { starting.value = false }
}

async function pasteContext(
  term: InstanceType<typeof AiCliTerminal>,
  build: () => string | Promise<string>
): Promise<void> {
  const text = await build()
  if (!text) return
  // The two halves are separate sends 300 ms apart, so the transport can go
  // down between them. Sending the CR regardless would submit whatever the
  // prompt already held — or an empty line — as if it were this context.
  if (!term.pasteText(bracketedPaste(text))) return
  // Let the CLI ingest the paste before the submitting CR.
  await new Promise((r) => setTimeout(r, 300))
  term.pasteText('\r')
}

/** Best-effort context injection after a fresh spawn: wait for the CLI's
 *  startup output to go quiet (injectQuietMs of silence after first output,
 *  injectTimeoutMs cap), then bracketed-paste the host's context and submit.
 *  Failure never blocks the CLI. */
async function injectContext(): Promise<void> {
  const term = termRef.value
  const build = props.buildContext
  if (!term || !build) return
  try {
    const deadline = Date.now() + props.injectTimeoutMs
    for (;;) {
      const last = term.lastRawActivityAt
      if ((last > 0 && Date.now() - last >= props.injectQuietMs) || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 250))
      if (term.status !== 'running') return // died during startup — nothing to inject
    }
    await pasteContext(term, build)
  } catch { /* best-effort */ }
}

/** Host-triggered re-injection into a running CLI (no quiet-wait: the CLI is
 *  already interactive). No-op without buildContext or a running PTY. */
async function injectNow(): Promise<void> {
  const term = termRef.value
  const build = props.buildContext
  if (!term || !build || term.status !== 'running') return
  try { await pasteContext(term, build) } catch { /* best-effort */ }
}

function interrupt(): void {
  void termRef.value?.interrupt()
}
function stop(): void {
  const term = termRef.value
  if (!term) return
  // While 'starting' there is no sessionId yet, so kill() would be a no-op and
  // a hung terminal.create would be uncancellable — cancel the pending create.
  if (term.status === 'starting') void term.cancelPendingCreate().catch(() => {})
  else void term.kill()
}

function pasteText(text: string): boolean {
  return termRef.value?.pasteText(text) ?? false
}

defineExpose({ start, stop, interrupt, pasteText, injectNow, toggle, terminal: termRef })
</script>

<template>
  <!-- Activity rail (AI terminal toggle) -->
  <div class="ai-dock-rail">
    <button
      class="ai-dock-rail-btn"
      :class="{ active: open }"
      :title="t(titleKey)"
      @click="toggle"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
      </svg>
    </button>
  </div>
  <div v-show="open" class="ai-dock-resize-handle" @mousedown.prevent="onResizeStart" />
  <div v-show="open" ref="panelRef" class="ai-dock-panel" :style="{ width: width + 'px' }">
    <div class="ai-cli-head">
      <span class="ai-cli-title">{{ t(titleKey) }}</span>
      <span v-if="workspacePath" class="ai-cli-ws" :title="workspacePath">{{ workspaceName }}</span>
    </div>
    <div v-if="!active" class="ai-cli-controls">
      <select v-model="agentKey" class="ai-cli-agent-select">
        <option v-for="s in agentSpecs" :key="s.agentKey" :value="s.agentKey">{{ s.label }}</option>
      </select>
      <button
        class="ai-cli-btn primary"
        :disabled="!workspacePath || starting || reattaching || terminalPort.status.value !== 'connected'"
        :title="workspacePath ? 'Spawn the CLI in ' + workspacePath : 'No workspace available'"
        @click="start"
      >{{ starting ? 'Starting…' : reattaching ? 'Reattaching…' : 'Start' }}</button>
    </div>
    <div v-else class="ai-cli-controls">
      <span class="ai-cli-running-label">{{ agentLabel }}</span>
      <button class="ai-cli-btn ghost" title="Send Ctrl+C to the CLI" @click="interrupt">Interrupt</button>
      <button class="ai-cli-btn danger" title="Kill the CLI process" @click="stop">Stop</button>
    </div>
    <p v-if="workspaceResolved && !workspacePath" class="ai-cli-empty">No workspace available</p>
    <!-- Mounted eagerly once a workspace exists (even while the panel is
         closed) so the connect-time reattach claims PTY ownership before the
         backend janitor reaps it. Keyed by paneId: useTerminal captures
         paneId/workspacePath once at setup, so a re-pointed workspace must
         remount the terminal for a fresh capture. -->
    <AiCliTerminal
      v-if="workspacePath"
      :key="paneId"
      ref="termRef"
      :pane-id="paneId"
      :terminal-port="terminalPort"
      :workspace-path="workspacePath"
      :mention-candidates="mentionCandidateGetter"
      class="ai-cli-term"
    />
  </div>
</template>

<style scoped>
.ai-dock-rail {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}

.ai-dock-rail-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}

.ai-dock-rail-btn:hover {
  color: var(--text-bright);
}

.ai-dock-rail-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.ai-dock-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}

.ai-dock-resize-handle:hover {
  background: var(--accent-emphasis);
}

.ai-dock-panel {
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}

.ai-cli-head {
  align-items: center;
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 8px 10px 4px;
}

.ai-cli-title {
  font-size: var(--font-xs);
  font-weight: 600;
}

.ai-cli-ws {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-controls {
  align-items: center;
  border-bottom: 1px solid var(--border-muted);
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding: 4px 10px 8px;
}

.ai-cli-agent-select {
  flex: 1;
  font-size: var(--font-xs);
  min-width: 0;
  padding: 5px 8px;
}

/* Self-contained button styling: host windows style bare <button> elements in
   their own scoped CSS, which does not reach into this component. */
.ai-cli-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-bright);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  padding: 5px 10px;
}

.ai-cli-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ai-cli-btn.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}

.ai-cli-btn.primary:not(:disabled):hover {
  background: var(--success-strong);
}

.ai-cli-btn.ghost {
  background: transparent;
}

.ai-cli-btn.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}

.ai-cli-btn.danger {
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}

.ai-cli-btn.danger:hover {
  background: var(--danger-muted);
}

.ai-cli-running-label {
  flex: 1;
  font-size: var(--font-xs);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-empty {
  color: var(--text-muted);
  flex-shrink: 0;
  font-size: var(--font-xs);
  margin: 0;
  padding: 12px;
}

.ai-cli-term {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
</style>
