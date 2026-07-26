<script setup lang="ts">
/**
 * Sidebar nav item. Clickable full-width row with an optional `icon` slot and
 * a text label; emits `select` on activation. Keyboard-accessible via button.
 */
defineProps<{
  label: string
  active?: boolean
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button
    type="button"
    class="settings-nav-item"
    :class="{ active }"
    :title="label"
    :aria-current="active ? 'page' : undefined"
    @click="emit('select')"
  >
    <span class="settings-nav-item-icon">
      <slot name="icon"></slot>
    </span>
    <span class="settings-nav-item-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.settings-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px var(--space-row-x);
  border: none;
  background: transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  font-size: var(--font-row-title);
  transition: background-color 120ms ease, color 120ms ease;
}
.settings-nav-item:hover {
  background: var(--bg-hover);
}
.settings-nav-item:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}
.settings-nav-item.active {
  background: var(--bg-selected);
  color: var(--accent-fg);
  font-weight: 600;
}
/* Left indicator bar on the active row (Cursor-style). */
.settings-nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: 0 2px 2px 0;
  background: var(--accent-emphasis);
}
.settings-nav-item-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.settings-nav-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrow modal: collapse to an icon-only rail. The label stays in the
   accessibility tree (visually hidden, not display:none) and the button's
   title attribute provides a hover tooltip. */
@media (max-width: 720px) {
  .settings-nav-item {
    justify-content: center;
    gap: 0;
    padding: 8px 0;
  }
  .settings-nav-item-label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    overflow: hidden;
    white-space: nowrap;
  }
}
</style>
