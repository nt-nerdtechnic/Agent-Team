<script setup lang="ts">
/**
 * Controlled iOS-style toggle switch. Visual parity with SettingsModal's
 * `.mcp-toggle`; keyboard-accessible via the native <button role="switch">.
 */
const props = defineProps<{
  modelValue: boolean
  disabled?: boolean
  ariaLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function toggle(): void {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="toggle-switch"
    :class="{ on: modelValue }"
    :aria-checked="modelValue"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="toggle-switch-thumb"></span>
  </button>
</template>

<style scoped>
.toggle-switch {
  width: 40px;
  height: 22px;
  border-radius: var(--radius-pill);
  border: none;
  background: var(--text-disabled);
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 0.2s;
  flex-shrink: 0;
  position: relative;
}
.toggle-switch.on {
  background: var(--accent-emphasis);
}
.toggle-switch:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.toggle-switch-thumb {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--text-on-emphasis);
  position: absolute;
  left: 2px;
  transition: left 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
.toggle-switch.on .toggle-switch-thumb {
  left: 20px;
}
</style>
