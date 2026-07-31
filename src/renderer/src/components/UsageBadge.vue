<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import {
  accountUsageFor,
  formatRemaining,
  formatResetAbsolute,
  formatResetCountdown,
  refreshUsage,
  remainingPercent,
  remainingTier,
  usageFor,
  type UsageWindow
} from '../composables/useUsage'
import { cliAccountSwitchKey, type useCliProfiles } from '../composables/useCliProfiles'
import { useNotify } from '../composables/useNotify'
import { executeCommand } from '../keybindings/commandRegistry'
import { i18n } from '../i18n'

// Compact remaining-quota badge for a CLI pane header. Renders nothing when
// the agent has no usage provider or nothing was fetched yet; shows ⚠ when
// the CLI's stored credentials are expired. Hover opens a fixed-position
// detail popover (teleported to body so the pane header can't clip it).

const props = defineProps<{
  agentKey: string
  cliProfiles: ReturnType<typeof useCliProfiles>
}>()

const snap = computed(() => usageFor(props.agentKey))
const remaining = computed(() => remainingPercent(snap.value))
const tier = computed(() => (remaining.value === null ? 'ok' : remainingTier(remaining.value)))
const expired = computed(() => snap.value?.status === 'expired')
const cached = computed(() => snap.value?.stale === true)
const visible = computed(() => remaining.value !== null || expired.value || cached.value)

// Account-switch block: only shown when this agent has ≥1 extra profile.
const canSwitch = computed(() => props.cliProfiles.hasProfiles(props.agentKey))
const switchProfiles = computed(() => props.cliProfiles.profilesForAgent(props.agentKey))
const activeProfileId = computed(() => props.cliProfiles.defaultProfileId(props.agentKey) ?? '')
const critSwitch = computed(() => tier.value === 'crit')

const open = ref(false)
const popStyle = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })
const badgeRef = ref<HTMLElement | null>(null)
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

const POP_WIDTH = 260

function onEnter(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (open.value || openTimer) return
  openTimer = setTimeout(() => {
    openTimer = null
    const rect = badgeRef.value?.getBoundingClientRect()
    if (rect) {
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - POP_WIDTH - 8))
      popStyle.value = { top: `${rect.bottom + 6}px`, left: `${left}px` }
    }
    open.value = true
  }, 150)
}

function onLeave(): void {
  if (openTimer) {
    clearTimeout(openTimer)
    openTimer = null
  }
  // Short grace so the cursor can travel from badge into the popover.
  closeTimer = setTimeout(() => {
    closeTimer = null
    open.value = false
  }, 120)
}

const { alert: notifyAlert } = useNotify()
const t = i18n.global.t

// Main window provides the quiescence-aware switch (confirm + force + pane
// restart). Other windows fall back to plain setDefault, whose PANES_RUNNING
// failure carries a ready message and surfaces as the alert below.
const switchAccount = inject(cliAccountSwitchKey, null)

async function selectProfile(id: string): Promise<void> {
  if (id === activeProfileId.value) return
  const target = id || null
  const res = switchAccount
    ? await switchAccount(props.agentKey, target)
    : await props.cliProfiles.setDefault(props.agentKey, target)
  if (!res.ok) {
    if (res.message) void notifyAlert(res.message, { title: t('cli-account.switch-title') })
    return
  }
  // Re-poll so the badge reflects the newly active account's quota promptly.
  refreshUsage()
}

// Jump straight to Settings › Accounts (CLI account manager) so a new account
// can be added. Close the popover first — the modal opens on top of it.
function openAccountSettings(): void {
  open.value = false
  executeCommand('workbench.action.openSettingsAccounts')
}

onBeforeUnmount(() => {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
})

function rowRemaining(w: UsageWindow): string {
  return formatRemaining(Math.max(0, Math.min(100, 100 - w.usedPercent)))
}

function rowBarWidth(w: UsageWindow): string {
  return `${Math.max(0, Math.min(100, 100 - w.usedPercent))}%`
}

function rowTier(w: UsageWindow): 'ok' | 'warn' | 'crit' {
  return remainingTier(Math.max(0, Math.min(100, 100 - w.usedPercent)))
}

function rowReset(w: UsageWindow): string {
  const countdown = formatResetCountdown(w.resetsAt)
  if (!countdown) return ''
  return `${countdown} · ${formatResetAbsolute(w.resetsAt)}`
}

function refreshStatusLabel(status: string | undefined): string {
  if (!status) return ''
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

// Per-account avatar: first character over a deterministic color picked from
// the profile id, so the same account always gets the same tint.
const AVATAR_COLORS = ['#1f6feb', '#8957e5', '#2da44e', '#bc4c00', '#bf3989', '#1b7c83', '#9e6a03']

function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function avatarInitial(label: string): string {
  const t = label.trim()
  return t ? t.charAt(0).toUpperCase() : '?'
}

// Rows are labeled by the signed-in identity when the backend resolved one.
function accountLabel(profileId: string | null, fallback: string): string {
  return props.cliProfiles.identityFor(props.agentKey, profileId)?.email ?? fallback
}

// Per-account remaining quota, shown as a plain number on each switch row.
// Empty when that slot has no fetched snapshot (e.g. never signed in).
function acctPct(profileId: string | null): string {
  const r = remainingPercent(accountUsageFor(props.agentKey, profileId))
  return r === null ? '' : formatRemaining(r)
}

function acctTier(profileId: string | null): 'ok' | 'warn' | 'crit' {
  const r = remainingPercent(accountUsageFor(props.agentKey, profileId))
  return r === null ? 'ok' : remainingTier(r)
}
</script>

<template>
  <span
    v-if="visible"
    ref="badgeRef"
    class="usage-badge"
    :class="[tier, { cached }]"
    :title="
      open
        ? ''
        : $t(expired ? 'usage.expired-tooltip' : cached ? 'usage.cached-tooltip' : 'usage.badge-tooltip')
    "
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @click.stop
  >
    <template v-if="remaining !== null">
      {{ formatRemaining(remaining) }}
      <small v-if="cached">{{ $t('usage.cached-short') }}</small>
    </template>
    <template v-else>⚠</template>
  </span>
  <Teleport to="body">
    <div
      v-if="open && snap"
      class="usage-pop"
      :style="popStyle"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
    >
      <div class="usage-pop-head">
        <span class="usage-pop-provider">{{ agentKey }}</span>
        <span v-if="snap.planType" class="usage-pop-plan">{{ snap.planType }}</span>
      </div>
      <div v-if="expired" class="usage-pop-expired">{{ $t('usage.expired-tooltip') }}</div>
      <div v-if="cached" class="usage-pop-cached">
        {{ $t('usage.cached-at', { time: formatResetAbsolute(snap.lastSuccessAt ?? snap.fetchedAt) }) }}
        · {{ $t('usage.refresh-status', { status: refreshStatusLabel(snap.refreshStatus) }) }}
      </div>
      <div v-if="cached && snap.staleExpired" class="usage-pop-expired">
        {{ $t('usage.cached-reset-expired') }}
      </div>
      <div v-for="w in snap.windows" :key="w.kind + w.label" class="usage-row">
        <div class="usage-row-top">
          <span class="usage-row-label">{{ w.label }}</span>
          <span v-if="w.expired" class="usage-row-left crit">
            {{ $t('usage.cached-window-expired') }}
          </span>
          <span v-else class="usage-row-left" :class="rowTier(w)">
            {{ $t('usage.remaining', { pct: rowRemaining(w) }) }}
          </span>
        </div>
        <div v-if="!w.expired" class="usage-bar">
          <div class="usage-bar-fill" :class="rowTier(w)" :style="{ width: rowBarWidth(w) }" />
        </div>
        <div v-if="!w.expired && rowReset(w)" class="usage-row-reset">
          {{ $t('usage.resets-in', { time: rowReset(w) }) }}
        </div>
      </div>
      <div class="usage-pop-switch">
        <div v-if="canSwitch" class="usage-pop-switch-title" :class="{ crit: critSwitch }">
          {{ critSwitch ? $t('usage.switch-low') : $t('usage.switch-title') }}
        </div>
        <div v-if="canSwitch" class="usage-acct-list" role="listbox">
          <button
            class="usage-acct"
            role="option"
            :class="{ active: activeProfileId === '' }"
            :aria-selected="activeProfileId === ''"
            @click="selectProfile('')"
          >
            <span class="usage-acct-av default">{{
              avatarInitial(accountLabel(null, $t('usage.switch-default')))
            }}</span>
            <span class="usage-acct-name">{{ accountLabel(null, $t('usage.switch-default')) }}</span>
            <span v-if="acctPct(null)" class="usage-acct-pct" :class="acctTier(null)">{{
              acctPct(null)
            }}</span>
            <span v-if="activeProfileId === ''" class="usage-acct-tick">✓</span>
          </button>
          <button
            v-for="p in switchProfiles"
            :key="p.id"
            class="usage-acct"
            role="option"
            :class="{ active: activeProfileId === p.id }"
            :aria-selected="activeProfileId === p.id"
            @click="selectProfile(p.id)"
          >
            <span class="usage-acct-av" :style="{ background: avatarColor(p.id) }">{{
              avatarInitial(accountLabel(p.id, p.name))
            }}</span>
            <span class="usage-acct-name">{{ accountLabel(p.id, p.name) }}</span>
            <span v-if="acctPct(p.id)" class="usage-acct-pct" :class="acctTier(p.id)">{{
              acctPct(p.id)
            }}</span>
            <span v-if="activeProfileId === p.id" class="usage-acct-tick">✓</span>
          </button>
        </div>
        <button class="usage-acct-manage" @click="openAccountSettings">
          <span class="usage-acct-manage-icon">＋</span>
          <span>{{ $t('usage.switch-manage') }}</span>
        </button>
      </div>
      <div class="usage-pop-updated">
        {{ $t('usage.updated', { time: formatResetAbsolute(snap.fetchedAt) }) }}
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.usage-badge {
  font-size: 9px;
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: default;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
}
.usage-badge.warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border-color: var(--attention-muted);
}
.usage-badge.crit {
  color: var(--danger-fg);
  background: var(--danger-deep);
  border-color: var(--danger-fg);
}
.usage-badge.cached {
  border-style: dashed;
}
.usage-badge small {
  margin-left: 2px;
  font-size: 8px;
  font-weight: 500;
}
.usage-pop {
  position: fixed;
  z-index: 300;
  width: 260px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  font-size: 11px;
  color: var(--text-secondary);
}
.usage-pop-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.usage-pop-provider {
  font-weight: 700;
  text-transform: capitalize;
  color: var(--text-bright);
}
.usage-pop-plan {
  font-size: 10px;
  text-transform: capitalize;
  color: var(--text-secondary);
}
.usage-pop-expired {
  color: var(--danger-fg);
  margin-bottom: 6px;
}
.usage-pop-cached {
  color: var(--attention-fg);
  margin-bottom: 6px;
}
.usage-row {
  margin-bottom: 8px;
}
.usage-row-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 3px;
}
.usage-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-row-left {
  flex-shrink: 0;
  font-weight: 600;
}
.usage-row-left.warn {
  color: var(--attention-fg);
}
.usage-row-left.crit {
  color: var(--danger-fg);
}
.usage-bar {
  height: 4px;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
}
.usage-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--success-fg);
}
.usage-bar-fill.warn {
  background: var(--attention-fg);
}
.usage-bar-fill.crit {
  background: var(--danger-fg);
}
.usage-row-reset {
  margin-top: 2px;
  font-size: 10px;
  opacity: 0.8;
}
.usage-pop-switch {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-default);
}
.usage-pop-switch-title {
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-secondary);
}
.usage-pop-switch-title.crit {
  color: var(--danger-fg);
}
.usage-acct-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.usage-acct {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.usage-acct:hover {
  background: var(--bg-hover);
}
.usage-acct.active {
  color: var(--text-bright);
  font-weight: 600;
}
.usage-acct-av {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.usage-acct-av.default {
  background: var(--border-strong);
}
.usage-acct.active .usage-acct-av {
  box-shadow:
    0 0 0 2px var(--bg-overlay),
    0 0 0 3px var(--accent-fg);
}
.usage-acct-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-acct-tick {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--accent-fg);
}
.usage-acct-pct {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
}
.usage-acct-pct.warn {
  color: var(--attention-fg);
}
.usage-acct-pct.crit {
  color: var(--danger-fg);
}
.usage-acct-manage {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.usage-acct-manage:hover {
  background: var(--bg-hover);
  color: var(--accent-fg);
}
.usage-acct-manage-icon {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
}
.usage-pop-updated {
  margin-top: 4px;
  font-size: 9.5px;
  opacity: 0.6;
}
</style>
