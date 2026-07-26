<script setup lang="ts">
/**
 * Card container for a group of SettingRow items. Direct children are
 * separated by a 1px divider; the divider is drawn on the top edge of every
 * child except the first, so the outer border stays clean.
 */
</script>

<template>
  <div class="settings-card">
    <slot></slot>
  </div>
</template>

<style scoped>
.settings-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  overflow: hidden;
}
.settings-card :deep(> * + *) {
  border-top: 1px solid var(--border-muted);
}
</style>
