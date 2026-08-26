<script lang="ts">
// Tasker tab of the right-hand rail: the machine-level background jobs
// registered on this Mac, in three sections — the user's Unix crontab entries,
// the launchd agents under ~/Library/LaunchAgents and /Library/LaunchAgents,
// and the daemons under /Library/LaunchDaemons. Only the user's own
// LaunchAgents get action buttons (`managed`); the system ones are shown for
// visibility and are read-only. Daemons are their own section because the whole
// class is read-only and mostly unknowable — a state filter over them would
// only ever be a control that changes nothing.
// All scanning and mutation lives in the backend (`executions.*` RPC); this
// panel only renders and confirms.
//
// Laid out for a ~300px column (the rail is resizable down to 180px): every row
// is two compact lines, and the long strings (command, raw line, plist path)
// live in an expandable detail block that scrolls instead of widening the rail.
import type { ExecutionsSnapshot as CachedSnapshot } from '../lib/cronDescribe'

// Module scope on purpose (a `<script setup>` binding would be per-instance):
// this panel lives under a `v-else-if`, so switching rail tabs or collapsing the
// rail unmounts it. Without the cache every remount would shell out to
// `crontab -l` + `launchctl list` again.
let cachedSnapshot: CachedSnapshot | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import {
  describeCron,
  describeLaunchAgentSchedule,
  type CrontabEntry,
  type ExecutionsSnapshot,
  type LaunchAgentEntry,
  type Translate,
} from '../lib/cronDescribe'

type CronFilter = 'all' | 'enabled' | 'disabled'
type AgentFilter = 'all' | 'running' | 'stopped'
type Kind = 'crontab' | 'launchagent'

// Inline (not a named `Props` interface): with the module-scope `<script>` block
// above, a local interface name would leak into the default export's type.
const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
// vue-i18n's overloaded `t` doesn't match the plain (key, params) seam the
// describe helpers take; adapt once here rather than casting at every call.
const tr: Translate = (key, params) => (params ? t(key, params) : t(key))

/** Identifies one row across both sections. Rows are addressed by (kind, key)
 *  rather than by the string sent to the backend, because two crontab lines can
 *  be byte-identical — comparing raw lines would light up both of them. */
interface RowRef {
  kind: Kind
  key: string
}

const snapshot = ref<ExecutionsSnapshot | null>(null)
const scanError = ref('')
/** Row currently being mutated. One mutation at a time: crontab writes are
 *  read-modify-write, so overlapping them would race. */
const busyTarget = ref<RowRef | null>(null)
const opError = reactive<Record<Kind, string>>({ crontab: '', launchagent: '' })
/** Row awaiting delete confirmation; the prompt renders inside its own row. */
const pendingRemove = ref<RowRef | null>(null)

/** In-flight `executions.list` requests — drives the ↻ button's spin/disabled. */
const inflight = ref(0)
const scanning = computed(() => inflight.value > 0)
const busy = computed(() => busyTarget.value !== null)

function isPending(kind: Kind, key: string): boolean {
  const p = pendingRemove.value
  return p !== null && p.kind === kind && p.key === key
}

const cronFilter = ref<CronFilter>('enabled')
// "all" on purpose: this section exists so the user can see everything that is
// registered on the machine, and some system agents have no knowable state.
const agentFilter = ref<AgentFilter>('all')

const CRON_FILTERS: CronFilter[] = ['all', 'enabled', 'disabled']
const AGENT_FILTERS: AgentFilter[] = ['all', 'running', 'stopped']

const crontab = computed(() => snapshot.value?.crontab ?? null)
const launchAgents = computed(() => snapshot.value?.launch_agents ?? null)

/** A LaunchAgent counts as up when launchd has it either running or loaded.
 *  Never true for a job whose state is unknown — both fields are null then. */
function isAgentUp(agent: LaunchAgentEntry): boolean {
  return agent.running === true || agent.loaded === true
}

/** Rows are keyed by plist path, not label: the same label legitimately exists
 *  in both the user and the system directory (Google keystone does exactly
 *  that), and those are two separate registrations. */
function agentKey(agent: LaunchAgentEntry): string {
  return agent.plist_path ?? agent.label
}

const visibleCronEntries = computed<CrontabEntry[]>(() => {
  const entries = crontab.value?.entries ?? []
  if (cronFilter.value === 'enabled') return entries.filter((e) => e.enabled)
  if (cronFilter.value === 'disabled') return entries.filter((e) => !e.enabled)
  return entries
})

/** The launchd agents: both directories that are bootstrapped into the user's
 *  GUI session, i.e. everything that is not a system daemon. */
const agentEntries = computed<LaunchAgentEntry[]>(() =>
  (launchAgents.value?.agents ?? []).filter((a) => a.scope !== 'system-daemon')
)

/** /Library/LaunchDaemons. Read-only in full, and shown unfiltered. */
const daemonEntries = computed<LaunchAgentEntry[]>(() =>
  (launchAgents.value?.agents ?? []).filter((a) => a.scope === 'system-daemon')
)

// Both state filters require a known state: a job launchctl cannot see is
// neither running nor stopped, so it only ever shows up under "all".
const visibleAgents = computed<LaunchAgentEntry[]>(() => {
  const agents = agentEntries.value
  if (agentFilter.value === 'running')
    return agents.filter((a) => a.runtime_known && isAgentUp(a))
  if (agentFilter.value === 'stopped')
    return agents.filter((a) => a.runtime_known && !isAgentUp(a))
  return agents
})

const scannedAtLabel = computed(() => {
  const at = snapshot.value?.scanned_at
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  return new Date(at * 1000).toLocaleTimeString(undefined, { hour12: false })
})

function agentFailed(agent: LaunchAgentEntry): boolean {
  return agent.last_exit_code !== null && agent.last_exit_code !== 0
}

function agentStateNote(agent: LaunchAgentEntry): string {
  // Unknown must never be rendered as "not loaded": `launchctl list` cannot see
  // the system domain without root, so we genuinely do not know.
  if (!agent.runtime_known) return t('executions.state.unknown')
  if (agent.running) return ''
  if (agent.loaded) return t('executions.state.loaded-not-running')
  return t('executions.state.not-loaded')
}

/** Neutral dot for an unknown state — neither the green "up" nor the grey
 *  "stopped" reading would be true. */
function agentDotClass(agent: LaunchAgentEntry): Record<string, boolean> {
  if (!agent.runtime_known) return { unknown: true }
  return { idle: !isAgentUp(agent), err: agentFailed(agent) }
}

// ─────────────────────── Row expand ───────────────────────
// Same interaction vocabulary as HistoryPanel: click a row to toggle, expanded
// ids tracked in a Set that is replaced (not mutated) so Vue sees the change.
const expandedIds = ref<Set<string>>(new Set())
function toggle(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

/** Drop expanded ids that no longer exist. Crontab ids are derived from the raw
 *  line and its index, so disabling or removing an entry renames it. */
function pruneExpanded(snap: ExecutionsSnapshot): void {
  const live = new Set<string>()
  for (const entry of snap.crontab?.entries ?? []) live.add(entry.id)
  for (const agent of snap.launch_agents?.agents ?? []) live.add(agentKey(agent))
  const next = new Set<string>()
  for (const id of expandedIds.value) if (live.has(id)) next.add(id)
  if (next.size !== expandedIds.value.size) expandedIds.value = next
}

/** Every executions RPC shells out, and the service allows each command 10s.
 *  The client's 10s default leaves no headroom, so a slow `launchctl` would be
 *  reported as a client timeout instead of the backend's real error. */
const RPC_TIMEOUT_MS = 25_000

/** Scan generation. Refreshes may overlap (a broadcast can land mid-scan), so
 *  each one records its own number and only the newest response is applied —
 *  otherwise a slow pre-mutation scan would overwrite the post-mutation state. */
let scanSeq = 0

async function refresh(userInitiated = false): Promise<void> {
  // Scanning shells out to crontab/launchctl, so a request sent before the
  // backend is up would just burn the client timeout and leave the panel
  // permanently empty. The status watcher below re-runs this once connected.
  if (props.backend.status.value !== 'connected') return
  const seq = ++scanSeq
  inflight.value += 1
  scanError.value = ''
  // Only an explicit ↻ discards operation errors: a background refresh (mutation
  // follow-up or another window's broadcast) must not wipe an unread failure.
  if (userInitiated) {
    opError.crontab = ''
    opError.launchagent = ''
  }
  try {
    const resp = await props.backend.send<ExecutionsSnapshot>('executions.list', {}, RPC_TIMEOUT_MS)
    if (seq !== scanSeq) return
    if (resp.ok && resp.payload) {
      snapshot.value = resp.payload
      cachedSnapshot = resp.payload
      cachedAt = Date.now()
      pruneExpanded(resp.payload)
    } else scanError.value = resp.error?.message ?? 'executions.list failed'
  } catch (err) {
    if (seq !== scanSeq) return
    scanError.value = String((err as Error).message ?? err)
  } finally {
    inflight.value -= 1
  }
}

function rescan(): void {
  void refresh(true)
}

/** Send a mutation and surface `ok: false` errors inline under its section. */
async function mutate(
  kind: Kind,
  type: 'executions.set_enabled' | 'executions.remove',
  payload: Record<string, unknown>,
  key: string
): Promise<void> {
  if (busyTarget.value) return
  busyTarget.value = { kind, key }
  opError[kind] = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(
      type,
      payload,
      RPC_TIMEOUT_MS
    )
    if (!resp.ok) {
      opError[kind] = resp.error?.message ?? `${type} failed`
      return
    }
    if (resp.payload && resp.payload.ok === false) {
      opError[kind] = resp.payload.error ?? `${type} failed`
      return
    }
    await refresh()
  } catch (err) {
    opError[kind] = String((err as Error).message ?? err)
  } finally {
    busyTarget.value = null
  }
}

function toggleCron(entry: CrontabEntry): void {
  void mutate(
    'crontab',
    'executions.set_enabled',
    { kind: 'crontab', target: entry.raw, enabled: !entry.enabled },
    entry.id
  )
}

function toggleAgent(agent: LaunchAgentEntry): void {
  void mutate(
    'launchagent',
    'executions.set_enabled',
    { kind: 'launchagent', target: agent.label, enabled: !isAgentUp(agent) },
    agentKey(agent)
  )
}

function askRemove(kind: Kind, key: string): void {
  pendingRemove.value = { kind, key }
}

function cancelRemove(): void {
  pendingRemove.value = null
}

/** `key` addresses the row; `target` is what the backend expects (raw / label). */
function confirmRemove(kind: Kind, key: string, target: string): void {
  pendingRemove.value = null
  void mutate(kind, 'executions.remove', { kind, target }, key)
}

let offChanged: (() => void) | null = null

onMounted(() => {
  // Any window's mutation rebroadcasts, so every open view stays in sync.
  offChanged = props.backend.on('executions.changed', () => {
    void refresh()
  })
  // Show the cached scan first so a remount doesn't flash empty, then rescan
  // unless the cache is still fresh.
  if (cachedSnapshot) snapshot.value = cachedSnapshot
  if (!cachedSnapshot || Date.now() - cachedAt > CACHE_TTL_MS) void refresh()
})

// This panel mounts with the app when Tasker was the last active tab, i.e.
// while the backend is still starting. Rescan on (re)connect the way
// useTokens does, or a boot-time miss would never recover on its own.
watch(
  () => props.backend.status.value,
  (status, previous) => {
    if (status === 'connected' && previous !== 'connected') void refresh()
  }
)

onUnmounted(() => {
  offChanged?.()
})
</script>

<template>
  <div class="tasker">
    <div class="tk-bar">
      <span class="tk-stamp">
        {{ scannedAtLabel ? t('executions.last-scan', { time: scannedAtLabel }) : '—' }}
      </span>
      <button
        class="tk-rescan"
        :disabled="scanning"
        :title="scanning ? t('executions.scanning') : t('executions.rescan')"
        @click="rescan"
      >
        <span class="tk-rescan-icon" :class="{ spinning: scanning }">↻</span>
      </button>
    </div>

    <p v-if="scanError" class="tk-scan-error">
      {{ t('executions.scan-failed', { message: scanError }) }}
    </p>

    <div class="tk-body">
      <!-- ── Unix crontab ─────────────────────────────────────────────── -->
      <section class="tk-section" data-section="crontab">
        <div class="tk-sec-hdr">
          <span class="tk-sec-title">{{ t('executions.crontab.title') }}</span>
          <span class="tk-count">
            {{ t('executions.count', { count: crontab?.entries.length ?? 0 }) }}
          </span>
        </div>
        <div class="tk-chips">
          <button
            v-for="f in CRON_FILTERS"
            :key="f"
            class="tk-chip"
            :class="{ on: cronFilter === f }"
            :data-filter="f"
            @click="cronFilter = f"
          >
            {{ t(`executions.crontab.filter-${f}`) }}
          </button>
        </div>

        <p v-if="crontab && !crontab.supported" class="tk-unsupported">
          {{ t('executions.unsupported') }}
        </p>
        <p v-else-if="crontab?.error" class="tk-sec-error">{{ crontab.error }}</p>
        <template v-else>
          <div
            v-for="entry in visibleCronEntries"
            :key="entry.id"
            class="tk-row"
            :class="{ off: !entry.enabled }"
            :data-entry-id="entry.id"
          >
            <div
              class="tk-row-head"
              :title="expandedIds.has(entry.id) ? t('executions.row.collapse') : t('executions.row.expand')"
              @click="toggle(entry.id)"
            >
              <div class="tk-line1">
                <span class="tk-dot" :class="{ idle: !entry.enabled }" />
                <span class="tk-name">{{ entry.name }}</span>
                <span v-if="!entry.enabled" class="tk-tag">
                  {{ t('executions.tag.disabled') }}
                </span>
              </div>
              <div class="tk-line2">
                <span class="tk-desc">{{ describeCron(entry.schedule, tr) }}</span>
                <span class="tk-acts">
                  <button
                    class="tk-act tk-act-toggle"
                    :disabled="busy"
                    :title="entry.enabled ? t('executions.action.disable') : t('executions.action.enable')"
                    @click.stop="toggleCron(entry)"
                  >
                    {{ entry.enabled ? '⏸' : '▶' }}
                  </button>
                  <button
                    class="tk-act tk-act-remove"
                    :disabled="busy"
                    :title="t('executions.action.remove')"
                    @click.stop="askRemove('crontab', entry.id)"
                  >
                    🗑
                  </button>
                </span>
              </div>
            </div>

            <div v-if="expandedIds.has(entry.id)" class="tk-detail">
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.schedule') }}</span>
                <code class="tk-v">{{ entry.schedule }}</code>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.command') }}</span>
                <code class="tk-v">{{ entry.command }}</code>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.raw') }}</span>
                <code class="tk-v">{{ entry.raw }}</code>
              </div>
            </div>

            <div v-if="isPending('crontab', entry.id)" class="tk-confirm">
              <p class="tk-confirm-lead">
                {{ t('executions.confirm.crontab', { name: entry.name }) }}
              </p>
              <code class="tk-confirm-detail">{{ entry.raw }}</code>
              <p class="tk-confirm-warning">{{ t('executions.confirm.warning') }}</p>
              <div class="tk-confirm-acts">
                <button class="tk-confirm-cancel" @click.stop="cancelRemove">
                  {{ t('executions.confirm.cancel') }}
                </button>
                <button
                  class="tk-confirm-ok"
                  :disabled="busy"
                  @click.stop="confirmRemove('crontab', entry.id, entry.raw)"
                >
                  {{ t('executions.confirm.ok') }}
                </button>
              </div>
            </div>
          </div>
          <p v-if="!visibleCronEntries.length" class="tk-empty nv-empty nv-empty--inline">{{ t('executions.empty') }}</p>
        </template>

        <p v-if="opError.crontab" class="tk-op-error" data-error-section="crontab">
          {{ opError.crontab }}
        </p>
      </section>

      <!-- ── macOS launchd agents (user + system) ──────────────────────── -->
      <section class="tk-section" data-section="launchagent">
        <div class="tk-sec-hdr">
          <span class="tk-sec-title">{{ t('executions.launchagents.title') }}</span>
          <span class="tk-count">
            {{ t('executions.count', { count: agentEntries.length }) }}
          </span>
        </div>
        <div class="tk-chips">
          <button
            v-for="f in AGENT_FILTERS"
            :key="f"
            class="tk-chip"
            :class="{ on: agentFilter === f }"
            :data-filter="f"
            @click="agentFilter = f"
          >
            {{ t(`executions.launchagents.filter-${f}`) }}
          </button>
        </div>

        <p v-if="launchAgents && !launchAgents.supported" class="tk-unsupported">
          {{ t('executions.unsupported') }}
        </p>
        <p v-else-if="launchAgents?.error" class="tk-sec-error">{{ launchAgents.error }}</p>
        <template v-else>
          <div
            v-for="agent in visibleAgents"
            :key="agentKey(agent)"
            class="tk-row"
            :class="{ off: agent.runtime_known && !isAgentUp(agent) }"
            :data-agent-label="agent.label"
            :data-agent-key="agentKey(agent)"
            :data-scope="agent.scope"
          >
            <div
              class="tk-row-head"
              :title="expandedIds.has(agentKey(agent)) ? t('executions.row.collapse') : t('executions.row.expand')"
              @click="toggle(agentKey(agent))"
            >
              <div class="tk-line1">
                <span class="tk-dot" :class="agentDotClass(agent)" />
                <span class="tk-name">{{ agent.name }}</span>
                <span v-if="agent.scope !== 'user'" class="tk-tag scope">
                  {{ t(`executions.scope.${agent.scope}`) }}
                </span>
                <span v-if="agent.pid !== null" class="tk-tag pid">
                  {{ t('executions.tag.pid', { pid: agent.pid }) }}
                </span>
                <span v-if="agentFailed(agent)" class="tk-tag exit">
                  {{ t('executions.tag.exit', { code: agent.last_exit_code }) }}
                </span>
              </div>
              <div class="tk-line2">
                <span class="tk-desc">{{ describeLaunchAgentSchedule(agent, tr) }}</span>
                <!-- Read-only rows get no buttons at all: everything outside
                     ~/Library/LaunchAgents needs root, which we never ask for. -->
                <span v-if="agent.managed" class="tk-acts">
                  <button
                    class="tk-act tk-act-toggle"
                    :disabled="busy"
                    :title="isAgentUp(agent) ? t('executions.action.disable') : t('executions.action.enable')"
                    @click.stop="toggleAgent(agent)"
                  >
                    {{ isAgentUp(agent) ? '⏸' : '▶' }}
                  </button>
                  <button
                    class="tk-act tk-act-remove"
                    :disabled="busy"
                    :title="t('executions.action.remove')"
                    @click.stop="askRemove('launchagent', agentKey(agent))"
                  >
                    🗑
                  </button>
                </span>
              </div>
            </div>

            <div v-if="expandedIds.has(agentKey(agent))" class="tk-detail">
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.label') }}</span>
                <code class="tk-v">{{ agent.label }}</code>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.scope') }}</span>
                <span class="tk-v">{{ t(`executions.scope.${agent.scope}`) }}</span>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.plist') }}</span>
                <code class="tk-v">{{ agent.plist_path ?? '—' }}</code>
              </div>
              <div v-if="agent.last_exit_code !== null" class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.exit-code') }}</span>
                <code class="tk-v">{{ agent.last_exit_code }}</code>
              </div>
              <div v-if="agentStateNote(agent)" class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.state') }}</span>
                <span class="tk-v">{{ agentStateNote(agent) }}</span>
              </div>
            </div>

            <div v-if="isPending('launchagent', agentKey(agent))" class="tk-confirm">
              <p class="tk-confirm-lead">
                {{ t('executions.confirm.launchagent', { name: agent.name }) }}
              </p>
              <code class="tk-confirm-detail">{{ agent.label }}</code>
              <code v-if="agent.plist_path" class="tk-confirm-detail">{{ agent.plist_path }}</code>
              <p class="tk-confirm-warning">{{ t('executions.confirm.warning') }}</p>
              <div class="tk-confirm-acts">
                <button class="tk-confirm-cancel" @click.stop="cancelRemove">
                  {{ t('executions.confirm.cancel') }}
                </button>
                <button
                  class="tk-confirm-ok"
                  :disabled="busy"
                  @click.stop="confirmRemove('launchagent', agentKey(agent), agent.label)"
                >
                  {{ t('executions.confirm.ok') }}
                </button>
              </div>
            </div>
          </div>
          <p v-if="!visibleAgents.length" class="tk-empty nv-empty nv-empty--inline">{{ t('executions.empty') }}</p>
        </template>

        <p v-if="opError.launchagent" class="tk-op-error" data-error-section="launchagent">
          {{ opError.launchagent }}
        </p>
      </section>

      <!-- ── macOS launchd daemons (/Library/LaunchDaemons) ────────────── -->
      <!-- No filter chips and no action buttons: every row here needs root, so
           there is nothing to act on, and `launchctl list` usually cannot see
           these at all — a state filter would be a control that never moves.
           The state itself is still read from the payload, because a daemon
           that does show up in `launchctl list` has a real one. -->
      <section class="tk-section" data-section="daemon">
        <div class="tk-sec-hdr no-chips">
          <span class="tk-sec-title">{{ t('executions.daemons.title') }}</span>
          <span class="tk-count">
            {{ t('executions.count', { count: daemonEntries.length }) }}
          </span>
        </div>

        <p v-if="launchAgents && !launchAgents.supported" class="tk-unsupported">
          {{ t('executions.unsupported') }}
        </p>
        <p v-else-if="launchAgents?.error" class="tk-sec-error">{{ launchAgents.error }}</p>
        <template v-else>
          <div
            v-for="agent in daemonEntries"
            :key="agentKey(agent)"
            class="tk-row"
            :class="{ off: agent.runtime_known && !isAgentUp(agent) }"
            :data-agent-label="agent.label"
            :data-agent-key="agentKey(agent)"
            :data-scope="agent.scope"
          >
            <div
              class="tk-row-head"
              :title="expandedIds.has(agentKey(agent)) ? t('executions.row.collapse') : t('executions.row.expand')"
              @click="toggle(agentKey(agent))"
            >
              <div class="tk-line1">
                <span class="tk-dot" :class="agentDotClass(agent)" />
                <span class="tk-name">{{ agent.name }}</span>
                <span class="tk-tag scope">{{ t(`executions.scope.${agent.scope}`) }}</span>
                <span v-if="agent.pid !== null" class="tk-tag pid">
                  {{ t('executions.tag.pid', { pid: agent.pid }) }}
                </span>
                <span v-if="agentFailed(agent)" class="tk-tag exit">
                  {{ t('executions.tag.exit', { code: agent.last_exit_code }) }}
                </span>
              </div>
              <div class="tk-line2">
                <span class="tk-desc">{{ describeLaunchAgentSchedule(agent, tr) }}</span>
              </div>
            </div>

            <div v-if="expandedIds.has(agentKey(agent))" class="tk-detail">
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.label') }}</span>
                <code class="tk-v">{{ agent.label }}</code>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.scope') }}</span>
                <span class="tk-v">{{ t(`executions.scope.${agent.scope}`) }}</span>
              </div>
              <div class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.plist') }}</span>
                <code class="tk-v">{{ agent.plist_path ?? '—' }}</code>
              </div>
              <div v-if="agent.last_exit_code !== null" class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.exit-code') }}</span>
                <code class="tk-v">{{ agent.last_exit_code }}</code>
              </div>
              <div v-if="agentStateNote(agent)" class="tk-kv">
                <span class="tk-k">{{ t('executions.detail.state') }}</span>
                <span class="tk-v">{{ agentStateNote(agent) }}</span>
              </div>
            </div>
          </div>
          <p v-if="!daemonEntries.length" class="tk-empty nv-empty nv-empty--inline">{{ t('executions.empty') }}</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tasker {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tk-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.tk-stamp {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-rescan {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 11px;
  line-height: 1.7;
}
.tk-rescan:hover:not(:disabled) {
  color: var(--text-bright);
}
.tk-rescan:disabled {
  opacity: 0.5;
  cursor: default;
}
.tk-rescan-icon.spinning {
  display: inline-block;
  animation: tk-spin 1s linear infinite;
}
@keyframes tk-spin {
  to {
    transform: rotate(360deg);
  }
}

.tk-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.tk-section {
  border-bottom: 1px solid var(--bg-subtle);
  padding-bottom: 6px;
}
.tk-sec-hdr {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 10px 4px;
}
/* Matches the 4px + .tk-chips 6px gap the filtered sections leave above their
   first row, so the unfiltered one doesn't sit tighter than its neighbours. */
.tk-sec-hdr.no-chips {
  padding-bottom: 10px;
}
.tk-sec-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-count {
  flex: none;
  font-size: 10px;
  color: var(--text-secondary);
}
.tk-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 10px 6px;
}
.tk-chip {
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  padding: 1px 7px;
  font-size: 10px;
  color: var(--text-secondary);
  cursor: pointer;
}
.tk-chip:hover {
  background: var(--bg-hover);
}
.tk-chip.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
}

.tk-row {
  border-top: 1px solid var(--bg-subtle);
}
.tk-row.off {
  opacity: 0.65;
}
.tk-row-head {
  padding: 5px 10px;
  cursor: pointer;
}
.tk-row-head:hover {
  background: var(--bg-subtle);
}
.tk-line1 {
  display: flex;
  align-items: center;
  /* The PID / exit tags don't shrink; let them drop to a second line instead of
     being clipped when the rail is near its 180px minimum. */
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.tk-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--success-fg);
}
.tk-dot.idle {
  background: var(--text-disabled);
}
.tk-dot.err {
  background: var(--danger-fg);
}
/* Hollow, so it reads as "no state to report" rather than as either the green
   running dot or the grey stopped one. */
.tk-dot.unknown {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-disabled);
}
.tk-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-tag {
  flex: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
}
.tk-tag.pid {
  color: var(--success-fg);
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.tk-tag.exit {
  color: var(--danger-fg);
  border-color: var(--danger-muted);
  background: var(--danger-subtle);
}
.tk-tag.scope {
  font-weight: 600;
  text-transform: none;
}
.tk-line2 {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 2px;
  padding-left: 11px;
}
.tk-desc {
  flex: 1;
  min-width: 0;
  font-size: 10px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-acts {
  display: flex;
  flex: none;
  gap: 3px;
}
.tk-act {
  appearance: none;
  width: 20px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 9px;
  cursor: pointer;
}
.tk-act:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.tk-act:disabled {
  opacity: 0.5;
  cursor: default;
}
.tk-act-remove:hover:not(:disabled) {
  color: var(--danger-fg);
  border-color: var(--danger-fg);
}

.tk-detail {
  padding: 4px 10px 8px 21px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tk-kv {
  min-width: 0;
}
.tk-k {
  display: block;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}
.tk-v {
  display: block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}

.tk-confirm {
  margin: 0 10px 8px 21px;
  padding: 6px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
}
.tk-confirm-lead {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--text-primary);
}
.tk-confirm-detail {
  display: block;
  margin-bottom: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}
.tk-confirm-warning {
  margin: 0 0 6px;
  font-size: 10px;
  color: var(--danger-bright);
}
.tk-confirm-acts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.tk-confirm-cancel,
.tk-confirm-ok {
  appearance: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
}
.tk-confirm-cancel {
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
.tk-confirm-ok {
  border: 1px solid var(--danger-muted);
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.tk-confirm-ok:disabled {
  opacity: 0.5;
  cursor: default;
}

.tk-empty,
.tk-unsupported,
.tk-sec-error {
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--text-secondary);
}
.tk-sec-error {
  color: var(--danger-bright);
  word-break: break-word;
}
.tk-scan-error,
.tk-op-error {
  flex: none;
  margin: 6px 10px;
  padding: 5px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: 11px;
  word-break: break-word;
}
</style>
