<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { retrySettings, settingsReadiness } from '@navide/plugin-ui/shared'

const { t } = useI18n()
const retrying = ref(false)

async function retry(): Promise<void> {
  if (retrying.value) return
  retrying.value = true
  try {
    await retrySettings()
  } catch {
    // The shared readiness state exposes the failure to this notice again.
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div v-if="settingsReadiness.status === 'failed'" class="settings-readiness-notice" role="alert">
    <span>{{ t('git.settings-unavailable') }}</span>
    <button type="button" :disabled="retrying" @click="void retry()">
      {{ retrying ? t('git.settings-retrying') : t('git.settings-retry') }}
    </button>
  </div>
</template>

<style scoped>
.settings-readiness-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--danger-bg, #5b1f24) 45%, var(--bg-primary));
  color: var(--text-primary);
  font-size: var(--font-xs);
}

.settings-readiness-notice button {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  padding: 3px 8px;
}

.settings-readiness-notice button:disabled {
  cursor: default;
  opacity: .6;
}
</style>
