<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { GitCredentialPrompt } from '../composables/useGit'
import type { GitCredentialAccountPort } from '../ports/gitSurface'

const props = defineProps<{
  show: boolean
  prompt: GitCredentialPrompt | null
  accountPort: GitCredentialAccountPort
}>()

const emit = defineEmits<{ (event: 'submit' | 'cancel'): void }>()
const usernameInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)
const saveAsAccount = ref(false)
const saveLabel = ref('')
const step = ref<'username' | 'password'>('username')

watch(() => props.show, (visible) => {
  if (!visible) return
  saveAsAccount.value = false
  saveLabel.value = ''
  step.value = props.prompt?.usernameRequestId ? 'username' : 'password'
  void props.accountPort.refresh()
  void nextTick(() => {
    ;(step.value === 'username' ? usernameInput.value : passwordInput.value)?.focus()
  })
}, { immediate: true })

function goToPassword(): void {
  step.value = 'password'
  void nextTick(() => passwordInput.value?.focus())
}

async function submit(): Promise<void> {
  const prompt = props.prompt
  if (saveAsAccount.value && prompt?.username && prompt.password) {
    const saved = await props.accountPort.addAccount({
      label: saveLabel.value.trim() || `${prompt.host} (${prompt.username})`,
      host: prompt.host,
      username: prompt.username,
      token: prompt.password,
    })
    if (saved) {
      const account = props.accountPort.accounts.value.find(
        ({ host, username }) => host === prompt.host && username === prompt.username,
      )
      if (account) await props.accountPort.bind(account.id)
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
          ref="usernameInput"
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
          ref="passwordInput"
          v-model="prompt.password"
          class="qi-input"
          type="password"
          autocomplete="current-password"
          spellcheck="false"
          :placeholder="$t('label.git-credential-password')"
          @keydown.enter="submit"
        />
        <template v-if="step === 'password'">
          <p class="qi-hint">{{ $t('hint.git-credential-token') }}</p>
          <label v-if="accountPort.available.value" class="qi-save-row">
            <input v-model="saveAsAccount" type="checkbox" />
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
        <div class="qi-actions">
          <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="emit('cancel')">{{ $t('action.cancel') }}</button>
          <button v-if="step === 'username'" class="btn-primary nv-btn nv-btn--primary" @click="goToPassword">{{ $t('action.next') }}</button>
          <button v-else data-submit-credential class="btn-primary nv-btn nv-btn--primary" @click="submit">{{ $t('action.submit') }}</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.tp-backdrop { position: fixed; inset: 0; z-index: 9998; background: var(--modal-backdrop); backdrop-filter: blur(var(--modal-backdrop-blur)); }
.cred-quick-input { position: fixed; z-index: 9999; top: 18vh; left: 50%; display: flex; width: min(var(--modal-w-compact), 92vw); transform: translateX(-50%); flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--bg-subtle); box-shadow: var(--shadow-modal); }
.qi-title { color: var(--text-secondary); font-size: var(--font-xs); word-break: break-word; }
.qi-input { padding: 7px 9px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-base); color: var(--text-primary); font-size: var(--font-sm); }
.qi-input.sm { padding: 5px 8px; font-size: var(--font-xs); }
.qi-input:focus { border-color: var(--accent-focus); outline: none; }
.qi-hint { margin: 0; color: var(--text-muted); font-size: var(--font-2xs); line-height: 1.4; }
.qi-save-row { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); cursor: pointer; font-size: var(--font-2xs); }
.qi-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.btn-primary, .btn-ghost { padding: 4px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); font-family: var(--font-ui); font-size: var(--font-xs); line-height: var(--lh-tight); cursor: pointer; }
.btn-primary { border-color: var(--success-strong); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.btn-ghost { border-color: var(--border-default); background: transparent; color: var(--text-secondary); }
.btn-primary:focus-visible, .btn-ghost:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
</style>
