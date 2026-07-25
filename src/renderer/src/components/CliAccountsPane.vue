<script setup lang="ts">
import { ref } from 'vue'
import { CLI_AGENT_SPECS } from '../lib/agentSpecs'
import type { useCliProfiles, CliProfile } from '../composables/useCliProfiles'
import { useNotify } from '../composables/useNotify'
import { i18n } from '../i18n'

const props = defineProps<{
  api: ReturnType<typeof useCliProfiles>
}>()

const { error } = props.api

function supported(agentKey: string): boolean {
  return props.api.supportedAgents.value.includes(agentKey)
}

// ── Add form (per agent) ─────────────────────────────────────────────────────
const addingAgent = ref<string | null>(null)
const addName = ref('')
const saving = ref(false)

function openAdd(agentKey: string): void {
  addingAgent.value = agentKey
  addName.value = ''
}
function closeAdd(): void {
  addingAgent.value = null
}
async function saveAdd(): Promise<void> {
  if (!addingAgent.value || !addName.value.trim() || saving.value) return
  saving.value = true
  try {
    const created = await props.api.create(addingAgent.value, addName.value.trim())
    if (created) closeAdd()
  } finally {
    saving.value = false
  }
}

// ── Rename form (per profile) ────────────────────────────────────────────────
const renamingId = ref<string | null>(null)
const renameName = ref('')

function openRename(profile: CliProfile): void {
  renamingId.value = profile.id
  renameName.value = profile.name
}
function closeRename(): void {
  renamingId.value = null
}
async function saveRename(): Promise<void> {
  if (!renamingId.value || !renameName.value.trim() || saving.value) return
  saving.value = true
  try {
    const ok = await props.api.rename(renamingId.value, renameName.value.trim())
    if (ok) closeRename()
  } finally {
    saving.value = false
  }
}

// ── Set default (confirm when running panes block the switch) ────────────────
const { confirm: notifyConfirm } = useNotify()
const t = i18n.global.t

async function requestSetDefault(agentKey: string, profileId: string | null): Promise<void> {
  const res = await props.api.setDefault(agentKey, profileId)
  if (res.ok || res.code !== 'PROFILE_IN_USE') return
  // Running panes block the switch. Offer to interrupt them (backend sends
  // Esc to each live pane) and retry with force. Other failures surface via
  // the composable `error` banner above.
  const label = CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey)?.label ?? agentKey
  const ok = await notifyConfirm(
    t('cli-account.switch-in-use', { count: res.runningCount ?? 0, agent: label }),
    {
      title: t('cli-account.switch-title'),
      confirmText: t('cli-account.switch-force'),
      cancelText: t('cli-account.switch-cancel'),
    },
  )
  if (!ok) return
  await props.api.setDefault(agentKey, profileId, { force: true })
}

// ── Delete confirm ───────────────────────────────────────────────────────────
const confirmRemoveId = ref<string | null>(null)

async function remove(id: string): Promise<void> {
  const ok = await props.api.remove(id)
  if (ok) {
    confirmRemoveId.value = null
    if (renamingId.value === id) closeRename()
  }
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
          :disabled="addingAgent === spec.agentKey"
          @click="openAdd(spec.agentKey)"
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
              <span class="cli-row-name">{{ $t('cli-account.default') }}</span>
              <span class="cli-row-meta">{{ $t('settings.accounts.cli.default-hint') }}</span>
            </div>
            <div class="cli-row-actions">
              <span v-if="api.defaultProfileId(spec.agentKey) === null" class="cli-badge">
                {{ $t('settings.accounts.cli.is-default') }}
              </span>
              <button v-else class="cli-btn ghost sm" @click="requestSetDefault(spec.agentKey, null)">
                {{ $t('settings.accounts.cli.set-default') }}
              </button>
            </div>
          </div>

          <!-- Created profiles. -->
          <div v-for="p in api.profilesForAgent(spec.agentKey)" :key="p.id" class="cli-row">
            <template v-if="renamingId === p.id">
              <input
                v-model="renameName"
                class="cli-input"
                type="text"
                spellcheck="false"
                @keydown.enter="saveRename"
                @keydown.esc="closeRename"
              />
              <div class="cli-row-actions">
                <button class="cli-btn ghost sm" @click="closeRename">
                  {{ $t('settings.accounts.cli.cancel') }}
                </button>
                <button class="cli-btn primary sm" :disabled="!renameName.trim() || saving" @click="saveRename">
                  {{ $t('settings.accounts.cli.save') }}
                </button>
              </div>
            </template>
            <template v-else>
              <div class="cli-row-main">
                <span class="cli-row-name">{{ p.name }}</span>
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
                  <button class="cli-btn ghost sm" @click="openRename(p)">
                    {{ $t('settings.accounts.cli.rename') }}
                  </button>
                  <button class="cli-btn ghost sm" @click="confirmRemoveId = p.id">
                    {{ $t('settings.accounts.cli.delete') }}
                  </button>
                </template>
              </div>
            </template>
          </div>
        </div>

        <!-- Add form. -->
        <div v-if="addingAgent === spec.agentKey" class="cli-form">
          <input
            v-model="addName"
            class="cli-input"
            type="text"
            spellcheck="false"
            :placeholder="$t('settings.accounts.cli.name-placeholder')"
            @keydown.enter="saveAdd"
            @keydown.esc="closeAdd"
          />
          <div class="cli-form-actions">
            <button class="cli-btn ghost sm" @click="closeAdd">
              {{ $t('settings.accounts.cli.cancel') }}
            </button>
            <button class="cli-btn primary sm" :disabled="!addName.trim() || saving" @click="saveAdd">
              {{ $t('settings.accounts.cli.save') }}
            </button>
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

.cli-form {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-inset, var(--bg-subtle));
  display: flex;
  align-items: center;
  gap: 8px;
}
.cli-form-actions { display: flex; gap: 8px; margin-left: auto; }
.cli-input {
  flex: 1;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  padding: 5px 8px;
}
.cli-input:focus { outline: none; border-color: var(--accent-focus); }

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
