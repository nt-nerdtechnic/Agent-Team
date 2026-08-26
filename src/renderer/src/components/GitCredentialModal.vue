<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { GitCredentialPrompt } from '../composables/useGit'
import { useGitAccounts } from '../composables/useGitAccounts'

const props = defineProps<{
  show: boolean
  prompt: GitCredentialPrompt | null
  // When provided, offers "Save as account & bind this workspace".
  workspacePath?: string
}>()

const emit = defineEmits<{
  (e: 'submit'): void
  (e: 'cancel'): void
}>()

// Autofocus the current step's field whenever the modal (re)opens or advances.
const usernameInputRef = ref<HTMLInputElement | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)

// Optional "save as account" flow (safeStorage-backed).
const gitAccounts = useGitAccounts()
const saveAsAccount = ref(false)
const saveLabel = ref('')

// VS Code/Cursor-style Quick Input shows one field at a time. Password is
// always asked (git resolves it last); Username is skipped entirely when a
// credential helper or the URL already supplied it, so start on Password
// in that case instead of showing a step that will never receive an id.
type Step = 'username' | 'password'
const step = ref<Step>('username')

watch(() => props.show, (visible) => {
  if (!visible) return
  saveAsAccount.value = false
  saveLabel.value = ''
  step.value = props.prompt?.usernameRequestId ? 'username' : 'password'
  void nextTick(() => {
    if (props.workspacePath) void gitAccounts.refresh()
    ;(step.value === 'username' ? usernameInputRef.value : passwordInputRef.value)?.focus()
  })
})

function goToPassword(): void {
  step.value = 'password'
  void nextTick(() => passwordInputRef.value?.focus())
}

async function onSubmit(): Promise<void> {
  // Best-effort: persist + bind before submitting the credential so a failure
  // here never blocks the git operation that is waiting on this prompt.
  if (saveAsAccount.value && props.workspacePath && props.prompt) {
    const { host, username, password } = props.prompt
    if (username && password) {
      const ok = await gitAccounts.addAccount({
        label: saveLabel.value.trim() || `${host} (${username})`,
        host,
        username,
        token: password
      })
      if (ok) {
        const created = gitAccounts.accounts.value.find(
          (a) => a.host === host && a.username === username
        )
        if (created) await gitAccounts.bind(props.workspacePath, created.id)
      }
    }
  }
  emit('submit')
}
</script>

<template>
  <Teleport to="body">
    <template v-if="show && prompt">
      <div class="tp-backdrop nv-modal-overlay" @click="emit('cancel')" />
      <div class="cred-quick-input nv-modal-shell nv-modal-shell--compact" @click.stop @keydown.esc="emit('cancel')">
        <div class="qi-title">{{ $t('label.git-credential-title', { host: prompt.host }) }}</div>

        <input
          v-if="step === 'username'"
          ref="usernameInputRef"
          v-model="prompt.username"
          class="qi-input"
          type="text"
          autocomplete="username"
          spellcheck="false"
          :placeholder="$t('label.git-credential-username')"
          @keydown.enter="goToPassword"
        />
        <input
          v-else
          ref="passwordInputRef"
          v-model="prompt.password"
          class="qi-input"
          type="password"
          autocomplete="current-password"
          spellcheck="false"
          :placeholder="$t('label.git-credential-password')"
          @keydown.enter="onSubmit"
        />

        <template v-if="step === 'password'">
          <p class="qi-hint">{{ $t('hint.git-credential-token') }}</p>
          <template v-if="workspacePath && gitAccounts.available.value">
            <label class="qi-save-row">
              <input type="checkbox" v-model="saveAsAccount" />
              <span>{{ $t('git.account.save-and-bind') }}</span>
            </label>
            <input
              v-if="saveAsAccount"
              v-model="saveLabel"
              class="qi-input sm"
              type="text"
              spellcheck="false"
              :placeholder="$t('settings.accounts.label')"
            />
          </template>
        </template>

        <div class="qi-actions">
          <span class="qi-kbd-hint">↵ {{ step === 'username' ? $t('action.next') : $t('action.submit') }} &nbsp;·&nbsp; Esc {{ $t('action.cancel') }}</span>
          <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="emit('cancel')">{{ $t('action.cancel') }}</button>
          <button v-if="step === 'username'" class="btn-primary nv-btn nv-btn--primary" @click="goToPassword">{{ $t('action.next') }}</button>
          <button v-else class="btn-primary nv-btn nv-btn--primary" @click="onSubmit">{{ $t('action.submit') }}</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.tp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
/* VS Code/Cursor Quick Input: a single narrow bar anchored near the top of
   the window, not a centered modal box. */
.cred-quick-input {
  position: fixed;
  z-index: 9999;
  top: 18vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(var(--modal-w-compact), 92vw);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Local entry animation: the shared .nv-modal-shell keyframes end on
     `transform: none`, which would drop this bar's translateX centering
     while it plays. Same motion, centering preserved. */
  animation: qi-modal-in var(--motion-base) var(--ease-out);
}
@keyframes qi-modal-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.985); }
  to { opacity: 1; transform: translateX(-50%); }
}
.qi-title {
  font-size: 11.5px;
  color: var(--text-secondary);
  word-break: break-word;
}
.qi-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  padding: 7px 9px;
}
.qi-input.sm { font-size: 12px; padding: 5px 8px; }
.qi-input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.qi-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}
.qi-save-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}
.qi-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}
.qi-kbd-hint {
  font-size: 10.5px;
  color: var(--text-muted);
  margin-right: auto;
}

/* Canonical button spec — byte-identical in GitPane.vue,
   GitCredentialModal.vue and GitHistoryModal.vue. Scoped styles don't cross
   component boundaries, so the house spec is restated in each; keep the three
   copies in sync. Colours preserve each variant's existing identity (Git's
   primary action stays green); only the scale and the four states are new. */
.btn-primary,
.btn-ghost,
.btn-danger {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  font-size: var(--font-xs);
  line-height: var(--lh-tight);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out);
}
.btn-primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
}
.btn-primary:hover:not(:disabled) {
  background: var(--success-strong);
  border-color: var(--success-strong);
}
.btn-ghost {
  background: transparent;
  border-color: var(--border-default);
  color: var(--text-secondary);
}
.btn-ghost:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.btn-danger {
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.btn-danger:hover:not(:disabled) {
  background: var(--danger-bright);
  border-color: var(--danger-bright);
}
.btn-ghost.btn-danger {
  background: transparent;
  border-color: var(--danger-fg);
  color: var(--danger-fg);
}
.btn-ghost.btn-danger:hover:not(:disabled) {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
  color: var(--danger-fg);
}
.btn-primary.sm,
.btn-ghost.sm,
.btn-danger.sm {
  padding: 3px 7px;
  font-size: var(--font-2xs);
}
.btn-ghost.icon-only {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  flex: 0 0 auto;
}
.btn-primary:active:not(:disabled),
.btn-ghost:active:not(:disabled),
.btn-danger:active:not(:disabled) {
  transform: translateY(1px);
}
.btn-primary:focus-visible,
.btn-ghost:focus-visible,
.btn-danger:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.btn-primary:disabled,
.btn-ghost:disabled,
.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
