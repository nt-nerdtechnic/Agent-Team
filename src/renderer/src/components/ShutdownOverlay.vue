<script setup lang="ts">
import { computed } from 'vue'

/**
 * The screen shown while the app is quitting.
 *
 * Quitting takes seconds — main waits out a starting backend, then stops the
 * running one while it sweeps every PTY child — and the window stays up for
 * all of it. Without this the app looks hung at exactly the moment the user
 * can no longer do anything about it.
 */
export type QuitStage = 'saving' | 'stopping' | 'closing'

const props = defineProps<{ stage: QuitStage | null }>()

const stageKey = computed(() => (props.stage ? `shutdown.${props.stage}` : ''))
</script>

<template>
  <div v-if="props.stage" class="shutdown-overlay" role="status" aria-live="polite">
    <div class="shutdown-card">
      <span class="shutdown-spinner" aria-hidden="true"></span>
      <p class="shutdown-title">{{ $t('shutdown.title') }}</p>
      <p class="shutdown-stage">{{ $t(stageKey) }}</p>
    </div>
  </div>
</template>

<style scoped>
/* Opaque, not translucent: the app is on its way out, and a see-through veil
   over a still-rendered UI invites one more click that will not land. */
.shutdown-overlay {
  position: fixed;
  inset: 0;
  /* Above every modal and toast in the app (the highest in use is 10100,
     NotificationHost.vue:160): once main is tearing down, nothing may sit on
     top of the shutdown screen. */
  z-index: 10200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  animation: shutdown-fade 140ms ease-out;
}
.shutdown-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 0 24px;
  text-align: center;
}
.shutdown-spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent-fg);
  animation: shutdown-spin 720ms linear infinite;
}
.shutdown-title {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.shutdown-stage {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
@keyframes shutdown-spin {
  to { transform: rotate(360deg); }
}
@keyframes shutdown-fade {
  from { opacity: 0; }
}
/* A spinner is decoration here — the stage line carries the meaning — so it is
   safe to hold it still for anyone who asked for less motion. */
@media (prefers-reduced-motion: reduce) {
  .shutdown-overlay { animation: none; }
  .shutdown-spinner { animation: none; }
}
</style>
