<script setup lang="ts">
import { ref } from 'vue'
import { CLI_AGENT_SPECS } from '../lib/agentSpecs'
import type { useCliProfiles, CliProfile } from '../composables/useCliProfiles'
import { useNotify } from '../composables/useNotify'
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

// ── Row identity (rows are named by who is signed in, not a custom label) ────
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

// ── Set default (confirm when running panes block the switch) ────────────────
const { confirm: notifyConfirm, toast } = useNotify()
const t = i18n.global.t

async function requestSetDefault(agentKey: string, profileId: string | null): Promise<boolean> {
  let res = await props.api.setDefault(agentKey, profileId)
  if (res.ok) return true
  if (res.code !== 'PROFILE_IN_USE') return false
  // Running panes block the switch. Offer to terminate them (backend kills
  // each live pane's CLI process and waits for exit before swapping) and
  // retry with force. Other failures surface via the composable `error`
  // banner above.
  const label = CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey)?.label ?? agentKey
  const ok = await notifyConfirm(
    t('cli-account.switch-in-use', { count: res.runningCount ?? 0, agent: label }),
    {
      title: t('cli-account.switch-title'),
      confirmText: t('cli-account.switch-force'),
      cancelText: t('cli-account.switch-cancel'),
    },
  )
  if (!ok) return false
  res = await props.api.setDefault(agentKey, profileId, { force: true })
  return res.ok
}

// ── Delete confirm ───────────────────────────────────────────────────────────
const confirmRemoveId = ref<string | null>(null)

async function remove(id: string): Promise<void> {
  const ok = await props.api.remove(id)
  if (ok) confirmRemoveId.value = null
}
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
        <div class="cli-list">
          <!-- Built-in Default (the user's real home). -->
          <div class="cli-row">
            <div class="cli-row-main">
              <span class="cli-row-name">{{ rowName(spec.agentKey, null) }}</span>
              <span class="cli-row-meta">{{
                rowIdentity(spec.agentKey, null)?.signedIn
                  ? $t('settings.accounts.cli.default-hint')
                  : $t('settings.accounts.cli.not-signed-in')
              }}</span>
            </div>
            <div class="cli-row-actions">
              <span v-if="api.defaultProfileId(spec.agentKey) === null" class="cli-badge">
                {{ $t('settings.accounts.cli.is-default') }}
              </span>
              <button v-else class="cli-btn ghost sm" @click="requestSetDefault(spec.agentKey, null)">
                {{ $t('settings.accounts.cli.set-default') }}
              </button>
              <button
                v-if="!rowIdentity(spec.agentKey, null)?.signedIn"
                class="cli-btn ghost sm"
                @click="signIn(spec.agentKey, null)"
              >
                {{ $t('settings.accounts.cli.sign-in') }}
              </button>
            </div>
          </div>

          <!-- Created profiles. -->
          <div v-for="p in api.profilesForAgent(spec.agentKey)" :key="p.id" class="cli-row">
            <div class="cli-row-main">
              <span
                class="cli-row-name"
                :class="{ dim: !rowIdentity(spec.agentKey, p.id)?.signedIn }"
              >
                {{ rowName(spec.agentKey, p) }}
              </span>
            </div>
            <div class="cli-row-actions">
              <template v-if="confirmRemoveId === p.id">
                <span class="cli-confirm-text">{{ $t('settings.accounts.cli.delete-confirm') }}</span>
                <button class="cli-btn danger sm" @click="remove(p.id)">
                  {{ $t('settings.accounts.cli.delete') }}
                </button>
                <button class="cli-btn ghost sm" @click="confirmRemoveId = null">
                  {{ $t('settings.accounts.cli.cancel') }}
                </button>
              </template>
              <template v-else>
                <span v-if="api.defaultProfileId(spec.agentKey) === p.id" class="cli-badge">
                  {{ $t('settings.accounts.cli.is-default') }}
                </span>
                <button v-else class="cli-btn ghost sm" @click="requestSetDefault(spec.agentKey, p.id)">
                  {{ $t('settings.accounts.cli.set-default') }}
                </button>
                <button
                  v-if="!rowIdentity(spec.agentKey, p.id)?.signedIn"
                  class="cli-btn ghost sm"
                  @click="signIn(spec.agentKey, p.id)"
                >
                  {{ $t('settings.accounts.cli.sign-in') }}
                </button>
                <button class="cli-btn ghost sm" @click="confirmRemoveId = p.id">
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

.cli-list { display: flex; flex-direction: column; gap: 6px; }
.cli-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.cli-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cli-row-name { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.cli-row-name.dim { font-weight: 400; color: var(--text-muted); }
.cli-row-meta { font-size: 11px; color: var(--text-secondary); }
.cli-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cli-confirm-text { font-size: 11px; color: var(--text-secondary); }
.cli-badge {
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
