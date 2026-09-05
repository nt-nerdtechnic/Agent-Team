<script setup lang="ts">
// A machine is asking to pair. This is what somebody actually sees.
//
// The same question exists on a card inside the account window, and that card
// stays — it is the record, and the way back in if this was dismissed. But it
// is five sections down a window nobody has open, and a request that expires in
// five minutes cannot wait for somebody to go looking. So it comes to them.
//
// Only the responder gets one. The initiator asked for this; interrupting them
// with a prompt about their own request would be telling somebody what they
// just did.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { useBackend } from '../composables/useBackend'
import { usePairingState, type PairingRow } from '../composables/usePairingState'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
const state = usePairingState(props.backend)

/** Reads the shared snapshot, never its own copy: two readers a poll apart
 *  would let this ask a question the card had already answered. */
const prompts = computed<PairingRow[]>(() =>
  state.prompts.value.filter((row) => Boolean(row.code)),
)

/** One at a time in flight, the same gate every other trust act uses. */
const pendingId = ref('')
const busy = computed(() => pendingId.value !== '')

async function answer(row: PairingRow, accept: boolean): Promise<void> {
  if (busy.value) return
  pendingId.value = row.deviceId
  try {
    const confirm = await window.agentTeam?.trustConfirm('p2p.pair.confirm', row.deviceId)
    await props.backend.send('p2p.pair.confirm', {
      deviceId: row.deviceId,
      accept,
      confirm,
    })
    await state.refresh()
  } catch {
    /* the prompt stays; the next poll shows whatever is really true */
  } finally {
    pendingId.value = ''
  }
}

/** Puts the prompt away without answering. The card in the account window keeps
 *  the request until it expires, so this hides a question rather than deciding
 *  it — which is why it is not sent anywhere. It puts away *this* request: the
 *  same device asking again is a new question and asks again. */
function later(row: PairingRow): void {
  state.dismiss(row)
}

onMounted(() => state.subscribe())
onUnmounted(() => state.release())

/** A fingerprint in groups of four: sixteen unbroken hex characters is the
 *  comparison people give up on. */
function grouped(value: string | undefined): string {
  const raw = (value ?? '').replace(/\s+/g, '')
  return raw ? (raw.match(/.{1,4}/g)?.join(' ') ?? raw) : ''
}
</script>

<template>
  <!-- Over the content, top-right, and out of the way of the traffic lights.
       It is a notification, not a modal: it does not take the keyboard and it
       does not stop somebody finishing what they were typing. -->
  <div v-if="prompts.length" class="pair-prompts" role="status" aria-live="polite">
    <div v-for="row in prompts" :key="row.deviceId" class="pair-prompt">
      <p class="pp-title">
        {{ t('settings.p2p.pair.asked-by', { device: row.deviceName || row.deviceId }) }}
      </p>
      <p class="pp-label">{{ t('settings.p2p.pair.code-label') }}</p>
      <p class="pp-code">{{ row.code }}</p>
      <p class="pp-body">
        {{ t('settings.p2p.pair.compare', { device: row.deviceName || row.deviceId }) }}
      </p>
      <p class="pp-label">{{ t('settings.p2p.pair.fingerprint-label') }}</p>
      <p class="pp-fp"><code>{{ grouped(row.fingerprint) }}</code></p>
      <div class="pp-acts">
        <button class="pp-btn pp-primary" :disabled="busy" @click="answer(row, true)">
          {{ t('settings.p2p.pair.allow') }}
        </button>
        <button class="pp-btn pp-danger" :disabled="busy" @click="answer(row, false)">
          {{ t('settings.p2p.pair.mismatch') }}
        </button>
        <button
          class="pp-btn pp-quiet"
          :title="t('settings.p2p.pair.later-title')"
          @click="later(row)"
        >
          {{ t('settings.p2p.pair.later') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above the content, below anything modal: this must not cover a dialog the
   person is already answering. Uses the existing popover level rather than
   inventing a number. */
.pair-prompts {
  position: fixed; top: 44px; right: 16px; z-index: var(--z-popover);
  display: flex; flex-direction: column; gap: 8px; max-width: 320px;
}
.pair-prompt {
  background: var(--bg-elevated, var(--bg-base)); color: var(--text-primary);
  border: 1px solid var(--attention-fg); border-radius: var(--radius-card, 10px);
  box-shadow: var(--shadow-popover); padding: 12px 14px;
  animation: pp-in var(--motion-fast, 120ms) var(--ease-out, ease-out);
}
/* Somebody who has asked for less motion still needs to see this; it simply
   arrives instead of sliding. */
@media (prefers-reduced-motion: reduce) {
  .pair-prompt { animation: none; }
}
@keyframes pp-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.pp-title { margin: 0; font-size: 13px; font-weight: 600; }
.pp-label {
  margin: 8px 0 0; font-size: var(--font-3xs); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
}
.pp-code {
  margin: 2px 0 0; font-family: var(--font-mono, monospace);
  font-size: 24px; letter-spacing: 0.18em; user-select: text;
}
.pp-body { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.pp-fp { margin: 2px 0 0; font-size: 12px; }
.pp-fp code { user-select: text; letter-spacing: 0.06em; }
.pp-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.pp-btn {
  font: inherit; font-size: 12px; padding: 3px 10px; cursor: pointer;
  border-radius: var(--radius-control, 6px); border: 1px solid var(--border-default);
  background: none; color: var(--text-secondary);
}
.pp-btn:disabled { opacity: 0.5; cursor: default; }
.pp-primary {
  background: var(--accent-emphasis); border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.pp-danger { color: var(--danger-fg); border-color: var(--danger-fg); }
.pp-quiet { border-color: transparent; }
.pp-quiet:hover { color: var(--text-primary); }
</style>
