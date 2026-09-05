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
//
// Every press has to change something on screen. The first version sent the
// answer and waited for the list to stop containing the request — so a person
// who pressed Allow saw a button dim and nothing else, and a backend that
// answered with an error was indistinguishable from one that answered at all.
// Pressing now moves through three visible states: in flight, settled, gone.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { useBackend } from '../composables/useBackend'
import { usePairingState, requestKey, type PairingRow } from '../composables/usePairingState'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
const state = usePairingState(props.backend)

/** Reads the shared snapshot, never its own copy: two readers a poll apart
 *  would let this ask a question the card had already answered. */
const prompts = computed<PairingRow[]>(() =>
  state.prompts.value.filter((row) => Boolean(row.code)),
)

/** One at a time in flight, the same gate every other trust act uses. Keyed by
 *  the request so the label can say which card is the one waiting. */
const pendingKey = ref('')
const busy = computed(() => pendingKey.value !== '')

/** What a request became, kept after the request itself is gone. The answer
 *  removes it from the snapshot within the same round trip, so without this the
 *  card would vanish at the exact moment it had something to report. */
interface Settled {
  key: string
  deviceName: string
  accepted: boolean
}
const settled = ref<Settled[]>([])
/** Verbatim from the backend, per request. Not classified here: the message is
 *  the only part that says which of a dozen refusals this was. */
const errors = ref<Record<string, string>>({})

/** How long the outcome stays before the card leaves by itself. Long enough to
 *  read a sentence, short enough not to become another thing to dismiss. */
const SETTLED_MS = 2600

const timers: ReturnType<typeof setTimeout>[] = []

/** Settled outcomes first, then the questions still open. A request being
 *  answered is drawn from `settled`, not from the snapshot, which is why the
 *  card survives its own disappearance from the list. */
const cards = computed(() => [
  ...settled.value.map((s) => ({ kind: 'settled' as const, key: s.key, settled: s })),
  ...prompts.value
    .filter((row) => !settled.value.some((s) => s.key === requestKey(row)))
    .map((row) => ({ kind: 'ask' as const, key: requestKey(row), row })),
])

async function answer(row: PairingRow, accept: boolean): Promise<void> {
  if (busy.value) return
  const key = requestKey(row)
  pendingKey.value = key
  errors.value = { ...errors.value, [key]: '' }
  try {
    const confirm = await window.agentTeam?.trustConfirm('p2p.pair.confirm', row.deviceId)
    const resp = await props.backend.send('p2p.pair.confirm', {
      deviceId: row.deviceId,
      accept,
      confirm,
    })
    // An error reply is not an exception, so nothing here would have caught it:
    // the old version treated "CONFIRMATION_REQUIRED" exactly like success and
    // then re-rendered the same unanswered question.
    if (!resp.ok) {
      errors.value = {
        ...errors.value,
        [key]: resp.error?.message || t('settings.p2p.pair.err-generic'),
      }
      return
    }
    settled.value = [
      ...settled.value,
      { key, deviceName: row.deviceName || row.deviceId, accepted: accept },
    ]
    timers.push(
      setTimeout(() => {
        settled.value = settled.value.filter((s) => s.key !== key)
        // Answered, so it must not come back if the snapshot still lists it for
        // a moment. `dismiss` is pruned once the request is really gone.
        state.dismiss(row)
      }, SETTLED_MS),
    )
    await state.refresh()
  } catch (err) {
    errors.value = {
      ...errors.value,
      [key]: err instanceof Error ? err.message : String(err),
    }
  } finally {
    pendingKey.value = ''
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
onUnmounted(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer)
  state.release()
})

/** A fingerprint in groups of four: sixteen unbroken hex characters is the
 *  comparison people give up on. */
function grouped(value: string | undefined): string {
  const raw = (value ?? '').replace(/\s+/g, '')
  return raw ? (raw.match(/.{1,4}/g)?.join(' ') ?? raw) : ''
}
</script>

<template>
  <!-- Over everything, top-right, and out of the way of the traffic lights.
       It is a notification, not a modal: it does not take the keyboard and it
       does not stop somebody finishing what they were typing. -->
  <div v-if="cards.length" class="pair-prompts" role="status" aria-live="polite">
    <div v-for="card in cards" :key="card.key" class="pair-prompt">
      <template v-if="card.kind === 'settled'">
        <p class="pp-title">
          {{
            card.settled.accepted
              ? t('settings.p2p.pair.paired', { device: card.settled.deviceName })
              : t('settings.p2p.pair.done-refused')
          }}
        </p>
      </template>
      <template v-else>
        <p class="pp-title">
          {{ t('settings.p2p.pair.asked-by', { device: card.row.deviceName || card.row.deviceId }) }}
        </p>
        <p class="pp-label">{{ t('settings.p2p.pair.code-label') }}</p>
        <p class="pp-code">{{ card.row.code }}</p>
        <p class="pp-body">
          {{ t('settings.p2p.pair.compare', { device: card.row.deviceName || card.row.deviceId }) }}
        </p>
        <p class="pp-label">{{ t('settings.p2p.pair.fingerprint-label') }}</p>
        <p class="pp-fp"><code>{{ grouped(card.row.fingerprint) }}</code></p>
        <!-- Whatever the backend said, said here. A refusal a person cannot see
             is the same to them as a button that does nothing. -->
        <p v-if="errors[card.key]" class="pp-err">{{ errors[card.key] }}</p>
        <div class="pp-acts">
          <button
            class="pp-btn pp-primary"
            :disabled="busy"
            @click="answer(card.row, true)"
          >
            {{
              pendingKey === card.key
                ? t('settings.p2p.pair.sending')
                : t('settings.p2p.pair.allow')
            }}
          </button>
          <button
            class="pp-btn pp-danger"
            :disabled="busy"
            @click="answer(card.row, false)"
          >
            {{ t('settings.p2p.pair.mismatch') }}
          </button>
          <button
            class="pp-btn pp-quiet"
            :disabled="busy"
            :title="t('settings.p2p.pair.later-title')"
            @click="later(card.row)"
          >
            {{ t('settings.p2p.pair.later') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* The notification level, above modals and everything else. This is a security
   question that expires in five minutes and has to be answered where the person
   is standing; covered by the account or settings window it has not appeared at
   all. `--z-toast` is the existing band for exactly this ("notifications,
   always on top" — semantic.css), so no new level is invented. */
.pair-prompts {
  position: fixed; top: 44px; right: 16px; z-index: var(--z-toast);
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
.pp-err { margin: 8px 0 0; font-size: 12px; color: var(--danger-fg); line-height: 1.5; }
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
