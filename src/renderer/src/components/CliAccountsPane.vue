<script setup lang="ts">
import { inject, onMounted, ref } from 'vue'
import { CLI_AGENT_SPECS } from '../lib/agentSpecs'
import { cliAccountSwitchKey, type useCliProfiles, type CliProfile } from '../composables/useCliProfiles'
import { useNotify } from '../composables/useNotify'
import {
  accountUsageFor,
  formatRemaining,
  formatResetAbsolute,
  formatResetCountdown,
  refreshUsage,
  remainingTier,
  usageFor,
  type UsageSnapshot,
  type UsageWindow,
} from '../composables/useUsage'
import { i18n } from '../i18n'

const props = defineProps<{
  api: ReturnType<typeof useCliProfiles>
  /** True when a workspace is open. Sign-in spawns a login pane inside the
   *  workspace, so without one the flow dead-ends — block it up front
   *  (before the profile row is created) instead of leaving an orphan row. */
  workspaceOpen?: boolean
}>()

// Asks the app shell to open a terminal pane running the agent's CLI so the
// user can complete the CLI's own sign-in flow (it opens the browser itself).
// With `loginProfileId` set, the pane runs in that profile's isolated login
// home: the credentials land in the profile's slot without switching the
// active account or touching running panes. Without it, the login runs live
// (active account / built-in Default).
const emit = defineEmits<{ (e: 'login', agentKey: string, loginProfileId?: string): void }>()

const { error } = props.api

function supported(agentKey: string): boolean {
  return props.api.supportedAgents.value.includes(agentKey)
}

// ── Card identity (cards are named by who is signed in, not a custom label) ──
function rowIdentity(agentKey: string, profileId: string | null) {
  return props.api.identityFor(agentKey, profileId)
}

function rowName(agentKey: string, profile: CliProfile | null): string {
  const identity = rowIdentity(agentKey, profile?.id ?? null)
  if (identity?.email) return identity.email
  // Signed in but the CLI stores no identity (kimi): fall back to the label.
  if (identity?.signedIn) return profile?.name ?? t('cli-account.default')
  return profile ? t('settings.accounts.cli.not-signed-in') : t('cli-account.default')
}

// Sign-in spawns a login pane inside the current workspace; without one the
// flow dead-ends in the app shell. Block early — BEFORE creating a profile
// row — so a click can't leave an orphan "Not signed in" row behind.
function requireWorkspace(): boolean {
  if (props.workspaceOpen) return true
  toast(t('settings.accounts.cli.login-no-workspace'), { type: 'error' })
  return false
}

// ── Add account: create an empty slot, then start its isolated CLI login ────
const saving = ref(false)

async function addAccount(agentKey: string): Promise<void> {
  if (saving.value) return
  if (!requireWorkspace()) return
  saving.value = true
  try {
    // Auto-named — rows display the signed-in identity, names are internal.
    // Unique against EXISTING auto names (max N + 1, "Account 1" being the
    // built-in Default): deletions leave gaps, so length-based numbering
    // could mint a duplicate label — indistinguishable rows for agents whose
    // credentials carry no identity (kimi falls back to the name).
    const nums = props.api
      .profilesForAgent(agentKey)
      .map((p) => /^Account (\d+)$/.exec(p.name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
    const name = `Account ${nums.length ? Math.max(...nums) + 1 : 2}`
    const created = await props.api.create(agentKey, name)
    if (!created) return
    emit('login', agentKey, created.id)
  } finally {
    saving.value = false
  }
}

// ── Sign in on an existing row (fresh Default, or retry an abandoned login) ──
async function signIn(agentKey: string, profileId: string | null): Promise<void> {
  if (!requireWorkspace()) return
  const activeId = props.api.defaultProfileId(agentKey)
  if (profileId !== null && profileId !== activeId) {
    // Non-active profile: isolated login — no account switch, running panes
    // keep their credentials.
    emit('login', agentKey, profileId)
    return
  }
  // Active profile or built-in Default: live login (harvested into the slot
  // by the usage poller). Signing in on a non-active Default row still
  // switches to it first, as before.
  if (activeId !== profileId) {
    if (!(await requestSetDefault(agentKey, profileId))) return
  }
  emit('login', agentKey)
}

// ── Set default ──────────────────────────────────────────────────────────────
const { toast } = useNotify()
const t = i18n.global.t

// Main window provides the quiescence-aware switch (confirm + force + pane
// restart); without it fall back to plain setDefault.
const switchAccount = inject(cliAccountSwitchKey, null)

async function requestSetDefault(agentKey: string, profileId: string | null): Promise<boolean> {
  const res = switchAccount
    ? await switchAccount(agentKey, profileId)
    : await props.api.setDefault(agentKey, profileId)
  if (res.ok) {
    // Re-poll so the card's quota reflects the newly active account.
    refreshUsage()
    return true
  }
  // PANES_RUNNING skips the composable's banner: with no handler it carries a
  // ready message — toast it. A declined confirm has no message (stay silent).
  if (res.code === 'PANES_RUNNING' && res.message) toast(res.message, { type: 'error' })
  return false
}

// ── Delete confirm ───────────────────────────────────────────────────────────
const confirmRemoveId = ref<string | null>(null)

async function remove(id: string | null, agentKey: string): Promise<void> {
  const ok = await props.api.remove(id, agentKey)
  if (ok) confirmRemoveId.value = null
}

function windowRemaining(w: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - w.usedPercent))
}

/** General account windows (not per-model buckets) — same headline pick as
 *  UsageBadge so both surfaces agree on the big number. */
const HEADLINE_KINDS = new Set(['session', 'weekly', 'monthly'])

function headlineWindow(snap: UsageSnapshot): UsageWindow | undefined {
  return snap.windows.find((w) => HEADLINE_KINDS.has(w.kind)) ?? snap.windows[0]
}

interface CardUsage {
  expired: boolean
  noData: boolean
  cached: boolean
  resetExpired: boolean
  big: string
  tier: 'ok' | 'warn' | 'crit'
  headLabel: string
  windows: UsageWindow[]
  foot: string
  lastSuccess: string
  refreshStatus: string
}

/** Display model for a card's quota area; undefined hides the area. */
function cardUsage(agentKey: string, profileId: string | null): CardUsage | undefined {
  const accountSnap = accountUsageFor(agentKey, profileId)
  const isActive = props.api.defaultProfileId(agentKey) === profileId
  const snap = accountSnap ?? (isActive ? usageFor(agentKey) : undefined)
  if (!snap) return undefined
  const cached = snap.stale === true
  const windows = snap.windows.filter((w) => !w.expired)
  const currentSnap = { ...snap, windows }
  const head = headlineWindow(currentSnap)
  const refreshStatus = refreshStatusLabel(snap.refreshStatus ?? snap.status)
  const base = {
    expired: snap.status === 'expired' || snap.refreshStatus === 'expired',
    cached,
    resetExpired: cached && windows.length === 0 && snap.windows.length > 0,
    lastSuccess: formatResetAbsolute(snap.lastSuccessAt ?? snap.fetchedAt),
    refreshStatus,
  }
  if (!head)
    return {
      ...base,
      noData: !base.resetExpired,
      big: '',
      tier: 'ok',
      headLabel: '',
      windows: [],
      foot: '',
    }
  const rem = windowRemaining(head)
  return {
    ...base,
    noData: false,
    big: formatRemaining(rem),
    tier: remainingTier(rem),
    headLabel: head.label,
    windows,
    foot: cardFoot(currentSnap, head),
  }
}

function refreshStatusLabel(status: string): string {
  const known = new Set([
    'not-refreshed',
    'no-credentials',
    'expired',
    'rate-limited',
    'unavailable',
    'error',
    'ok',
  ])
  return known.has(status) ? t(`usage.refresh-status-${status}`) : status
}

/** Card footer: the non-headline windows plus the headline reset countdown. */
function cardFoot(snap: UsageSnapshot, head: UsageWindow): string {
  const parts = snap.windows
    .filter((w) => w !== head)
    .map((w) => `${w.label} ${formatRemaining(windowRemaining(w))}`)
  const countdown = formatResetCountdown(head.resetsAt)
  if (countdown) parts.push(t('usage.resets-in', { time: countdown }))
  return parts.join(' · ')
}

function barTitle(w: UsageWindow): string {
  const base = `${w.label} ${formatRemaining(windowRemaining(w))}`
  const countdown = formatResetCountdown(w.resetsAt)
  return countdown ? `${base} · ${t('usage.resets-in', { time: countdown })}` : base
}

// Per-account avatar: first character over a deterministic color picked from
// the profile id, so the same account always gets the same tint (same
// palette as UsageBadge's account switcher).
const AVATAR_COLORS = ['#1f6feb', '#8957e5', '#2da44e', '#bc4c00', '#bf3989', '#1b7c83', '#9e6a03']

function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function avatarInitial(label: string): string {
  const s = label.trim()
  return s ? s.charAt(0).toUpperCase() : '?'
}

// Fresh numbers when the pane opens (same nudge UsageBadge sends on switch).
onMounted(() => refreshUsage())
</script>

<template>
  <div class="cli-pane">
    <div class="cli-head">
      <h3 class="cli-title">{{ $t('settings.accounts.cli.title') }}</h3>
      <p class="cli-hint">{{ $t('settings.accounts.cli.hint') }}</p>
    </div>

    <div v-if="error" class="cli-banner danger">{{ error }}</div>

    <section v-for="spec in CLI_AGENT_SPECS" :key="spec.agentKey" class="cli-agent">
      <div class="cli-agent-head">
        <span class="cli-agent-name">{{ spec.label }}</span>
        <button
          v-if="supported(spec.agentKey)"
          class="cli-btn ghost sm"
          :disabled="saving"
          @click="addAccount(spec.agentKey)"
        >
          {{ $t('settings.accounts.cli.new-account') }}
        </button>
      </div>

      <!-- Agents that cannot isolate multiple accounts (e.g. antigravity). -->
      <p v-if="!supported(spec.agentKey)" class="cli-unsupported">
        {{ $t('settings.accounts.cli.unsupported') }}
      </p>

      <template v-else>
        <div class="cli-card-grid">
          <!-- First card is the built-in Default (the user's real home). -->
          <div
            v-for="p in [null, ...api.profilesForAgent(spec.agentKey)]"
            :key="p?.id ?? '__default__'"
            class="cli-card"
            :class="{ active: api.defaultProfileId(spec.agentKey) === (p?.id ?? null) }"
          >
            <div class="cli-card-head">
              <span
                class="cli-card-av"
                :class="{ default: !p }"
                :style="p ? { background: avatarColor(p.id) } : undefined"
              >
                {{ avatarInitial(rowName(spec.agentKey, p)) }}
              </span>
              <span
                class="cli-card-id"
                :class="{ dim: p && !rowIdentity(spec.agentKey, p.id)?.signedIn }"
              >
                {{ rowName(spec.agentKey, p) }}
              </span>
              <span
                v-if="api.defaultProfileId(spec.agentKey) === (p?.id ?? null)"
                class="cli-badge"
              >
                {{ $t('settings.accounts.cli.is-default') }}
              </span>
            </div>
            <span v-if="!p" class="cli-card-meta">{{
              rowIdentity(spec.agentKey, null)?.signedIn
                ? $t('settings.accounts.cli.default-hint')
                : $t('settings.accounts.cli.not-signed-in')
            }}</span>

            <!-- Quota area (single-element v-for = local display-model alias). -->
            <template
              v-for="u in [cardUsage(spec.agentKey, p?.id ?? null)]"
              :key="'usage'"
            >
              <template v-if="u && !u.noData">
                <div v-if="u.resetExpired" class="cli-card-none">
                  <span class="cli-card-dash">—</span>
                  <span class="cli-card-foot">{{ $t('usage.cached-reset-expired') }}</span>
                </div>
                <template v-else>
                  <div class="cli-card-big" :class="u.tier">
                    {{ u.big }}
                    <small>{{ u.headLabel }}</small>
                  </div>
                  <div class="cli-card-bars">
                    <div
                      v-for="w in u.windows"
                      :key="w.kind + w.label"
                      class="cli-mini-bar"
                      :title="barTitle(w)"
                    >
                      <div
                        class="cli-mini-fill"
                        :class="remainingTier(windowRemaining(w))"
                        :style="{ width: windowRemaining(w) + '%' }"
                      ></div>
                    </div>
                  </div>
                  <div v-if="u.foot" class="cli-card-foot">{{ u.foot }}</div>
                </template>
                <div v-if="u.cached" class="cli-card-cache">
                  {{ $t('usage.cached-at', { time: u.lastSuccess }) }}
                </div>
                <div v-if="u.cached" class="cli-card-refresh">
                  {{ $t('usage.refresh-status', { status: u.refreshStatus }) }}
                </div>
              </template>
              <div
                v-else-if="u || rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn"
                class="cli-card-none"
              >
                <span class="cli-card-dash">—</span>
                <span class="cli-card-foot">{{ $t('usage.no-data') }}</span>
                <span v-if="u?.expired" class="cli-card-expired">
                  ⚠ {{ $t('usage.expired-tooltip') }}
                </span>
                <span v-if="u?.refreshStatus" class="cli-card-refresh">
                  {{ $t('usage.refresh-status', { status: u.refreshStatus }) }}
                </span>
              </div>
            </template>

            <div class="cli-card-actions">
              <template v-if="confirmRemoveId === (p?.id ?? '__default__')">
                <span class="cli-confirm-text">{{ $t('settings.accounts.cli.delete-confirm') }}</span>
                <button class="cli-btn danger sm" @click="remove(p?.id ?? null, spec.agentKey)">
                  {{ $t('settings.accounts.cli.delete') }}
                </button>
                <button class="cli-btn ghost sm" @click="confirmRemoveId = null">
                  {{ $t('settings.accounts.cli.cancel') }}
                </button>
              </template>
              <template v-else>
                <button
                  v-if="api.defaultProfileId(spec.agentKey) !== (p?.id ?? null)"
                  class="cli-btn ghost sm"
                  @click="requestSetDefault(spec.agentKey, p?.id ?? null)"
                >
                  {{ $t('settings.accounts.cli.set-default') }}
                </button>
                <button
                  v-if="!rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn || cardUsage(spec.agentKey, p?.id ?? null)?.expired"
                  class="cli-btn ghost sm"
                  @click="signIn(spec.agentKey, p?.id ?? null)"
                >
                  {{ $t('settings.accounts.cli.sign-in') }}
                </button>
                <button
                  v-if="p || rowIdentity(spec.agentKey, null)?.signedIn"
                  class="cli-btn ghost sm"
                  @click="confirmRemoveId = (p?.id ?? '__default__')"
                >
                  {{ $t('settings.accounts.cli.delete') }}
                </button>
              </template>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.cli-pane { display: flex; flex-direction: column; }
.cli-head { margin-bottom: 14px; }
.cli-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--text-bright); }
.cli-hint { margin: 0; font-size: 11.5px; color: var(--text-secondary); max-width: 52ch; line-height: 1.4; }

.cli-banner {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.4;
  margin-bottom: 12px;
}
.cli-banner.danger {
  background: var(--danger-subtle, var(--bg-muted));
  border: 1px solid var(--danger-muted, var(--border-default));
  color: var(--danger-fg, var(--text-primary));
}

.cli-agent { margin-bottom: 18px; }
.cli-agent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.cli-agent-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.cli-unsupported { margin: 0; font-size: 11px; color: var(--text-muted); font-style: italic; }

.cli-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}
.cli-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.cli-card.active {
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 1px var(--accent-emphasis);
}
.cli-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-card-av {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
}
.cli-card-av.default { background: var(--border-strong); }
.cli-card-id {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cli-card-id.dim { font-weight: 400; color: var(--text-muted); }
.cli-card-meta { font-size: 10.5px; color: var(--text-secondary); }

.cli-card-big {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-primary);
}
.cli-card-big small {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-left: 4px;
}
.cli-card-big.warn { color: var(--attention-fg); }
.cli-card-big.crit { color: var(--danger-fg); }
.cli-card-bars { display: flex; flex-direction: column; gap: 3px; }
.cli-mini-bar {
  height: 3px;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
}
.cli-mini-fill { height: 100%; border-radius: 999px; background: var(--success-fg); }
.cli-mini-fill.warn { background: var(--attention-fg); }
.cli-mini-fill.crit { background: var(--danger-fg); }
.cli-card-foot { font-size: 10px; color: var(--text-muted); }
.cli-card-cache { font-size: 10px; font-weight: 600; color: var(--attention-fg); }
.cli-card-refresh { font-size: 10px; color: var(--text-muted); }
.cli-card-expired { font-size: 11px; font-weight: 600; color: var(--danger-fg); }
.cli-card-none { display: flex; flex-direction: column; gap: 2px; }
.cli-card-dash {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-muted);
}

.cli-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}
.cli-confirm-text { font-size: 11px; color: var(--text-secondary); }
.cli-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent-subtle, var(--bg-muted));
  border: 1px solid var(--accent-muted, var(--border-default));
  border-radius: 999px;
  padding: 1px 8px;
}

.cli-btn {
  border-radius: 5px;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
.cli-btn.sm { font-size: 11px; padding: 3px 8px; }
.cli-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cli-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.cli-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.cli-btn.ghost { background: transparent; color: var(--text-secondary); }
.cli-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.cli-btn.danger {
  background: var(--danger-emphasis, var(--danger-fg));
  border-color: var(--danger-emphasis, var(--danger-fg));
  color: var(--text-on-emphasis);
}
</style>
