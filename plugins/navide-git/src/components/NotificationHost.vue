<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useNotify } from '@navide/plugin-ui/foundation'

const { toasts, dialog, promptValue, dialogCheckbox, dismissToast, resolveDialog } = useNotify()

const toastIcon = { success: '✓', error: '✕', info: 'ℹ' } as const

const modalEl = ref<HTMLDivElement | null>(null)
const promptInput = ref<HTMLInputElement | null>(null)
watch(dialog, async (d) => {
  if (d) {
    await nextTick()
    // Focus the text field for a prompt so the user can type immediately;
    // otherwise focus the modal so Enter/Esc are handled.
    if (d.kind === 'prompt') promptInput.value?.select()
    else modalEl.value?.focus()
  }
})
</script>

<template>
  <Teleport to="body">
    <!-- Toast stack (non-blocking, auto-dismiss) -->
    <div class="toast-stack">
      <transition-group name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="t.type"
          @click="dismissToast(t.id)"
        >
          <span class="toast-icon">{{ toastIcon[t.type] }}</span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </transition-group>
    </div>

    <!-- Alert / Confirm dialog (blocking) -->
    <div v-if="dialog" ref="modalEl" class="modal" tabindex="-1" @click.self="resolveDialog(false)" @keydown.esc="resolveDialog(false)" @keydown.enter="resolveDialog(true)">
      <div class="card" :class="dialog.kind">
        <header>
          <span class="dot"></span>
          <strong>{{ dialog.title }}</strong>
        </header>
        <div class="body">
          <pre>{{ dialog.message }}</pre>
          <input
            v-if="dialog.kind === 'prompt'"
            ref="promptInput"
            v-model="promptValue"
            class="prompt-input"
            type="text"
            :placeholder="dialog.placeholder"
            @keydown.enter.stop.prevent="resolveDialog(true)"
            @keydown.esc.stop.prevent="resolveDialog(false)"
          />
          <label v-if="dialog.checkboxLabel" class="dialog-check">
            <input v-model="dialogCheckbox" type="checkbox" />
            <span>{{ dialog.checkboxLabel }}</span>
          </label>
        </div>
        <footer>
          <button
            v-if="dialog.kind === 'confirm' || dialog.kind === 'prompt'"
            class="ghost"
            @click="resolveDialog(false)"
          >
            {{ dialog.cancelText }}
          </button>
          <button class="primary" @click="resolveDialog(true)">
            {{ dialog.confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Toast stack ──────────────────────────────────────────────────────── */
.toast-stack {
  position: fixed;
  top: 16px;
  right: 16px;
  /* Above every overlay in the app (settings/pipeline-manager modals sit at
     8000-9000): a toast or confirm hidden behind one reads as a silent failure,
     and a hidden confirm still answers Enter. */
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 240px;
  max-width: 420px;
  padding: 10px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--text-secondary);
  border-radius: 6px;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  line-height: 1.45;
  box-shadow: 0 8px 24px var(--shadow-overlay);
  cursor: pointer;
}
.toast.success {
  border-left-color: var(--success-fg);
}
.toast.error {
  border-left-color: var(--danger-fg);
}
.toast.info {
  border-left-color: var(--accent-fg);
}
.toast-icon {
  flex-shrink: 0;
  font-weight: 700;
}
.toast.success .toast-icon {
  color: var(--success-fg);
}
.toast.error .toast-icon {
  color: var(--danger-fg);
}
.toast.info .toast-icon {
  color: var(--accent-fg);
}
.toast-msg {
  flex: 1;
  word-break: break-word;
  white-space: pre-wrap;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

/* ── Dialog (alert / confirm) ─────────────────────────────────────────── */
.modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10100;
}
.modal:focus {
  outline: none;
}
.card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--accent-fg);
  border-radius: 8px;
  width: min(520px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px var(--shadow-overlay);
  overflow: hidden;
}
.card.confirm {
  border-left-color: var(--attention-fg);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 20%, transparent);
}
.card.confirm .dot {
  background: var(--attention-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--attention-fg) 20%, transparent);
}
header strong {
  color: var(--text-bright);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
}
.body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-bright);
}
.prompt-input {
  margin-top: 12px;
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-bright);
  font-family: inherit;
  font-size: 13px;
}
.prompt-input:focus {
  outline: none;
  border-color: var(--accent-fg);
}
.dialog-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.dialog-check input {
  cursor: pointer;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-base);
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:hover {
  background: var(--success-strong);
}
button.ghost {
  background: transparent;
}
button.ghost:hover {
  background: var(--bg-muted);
}
</style>
