<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { RestoreScope } from '../lib/resumeBehavior'

const props = defineProps<{ open: boolean; count: number }>()
const emit = defineEmits<{
  select: [scope: RestoreScope]
  fresh: []
  cancel: []
}>()

const dialog = ref<HTMLDivElement | null>(null)
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    dialog.value?.focus()
  },
  { immediate: true }
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="dialog" class="restore-scope-modal nv-modal-overlay" tabindex="-1" @keydown.esc="emit('cancel')">
      <section class="restore-scope-card nv-modal-shell nv-modal-shell--compact" role="dialog" aria-modal="true" :aria-label="$t('restore.scope-title')">
        <h2>{{ $t('restore.scope-title') }}</h2>
        <p>{{ $t('restore.scope-message', { count }) }}</p>
        <div class="scope-actions">
          <button @click="emit('select', 'single')">{{ $t('restore.scope-single') }}</button>
          <button @click="emit('select', 'page')">{{ $t('restore.scope-page') }}</button>
          <button @click="emit('select', 'tab')">{{ $t('restore.scope-tab') }}</button>
          <button @click="emit('select', 'all')">{{ $t('restore.scope-all') }}</button>
        </div>
        <button class="fresh" @click="emit('fresh')">{{ $t('restore.scope-fresh') }}</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.restore-scope-modal {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 131);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
.restore-scope-card {
  width: min(var(--modal-w-compact), 92vw);
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
}
h2 { margin: 0 0 8px; font-size: 17px; }
p { margin: 0 0 16px; color: var(--text-secondary); }
.scope-actions { display: grid; gap: 8px; }
button {
  min-height: 34px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
}
button:hover, button:focus-visible { border-color: var(--accent-focus); }
.fresh { width: 100%; margin-top: 12px; color: var(--text-secondary); }
</style>
