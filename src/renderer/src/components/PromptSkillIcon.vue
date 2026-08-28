<script setup lang="ts">
// One line-art glyph per PromptSkillIcon name. Same house style as the other
// icon components: 16×16, currentColor stroke, round caps.
import type { PromptSkillIcon } from '../lib/promptSkills'

defineProps<{ name: PromptSkillIcon }>()

const PATHS: Record<PromptSkillIcon, string> = {
  // fast-forward — a task that keeps pushing ahead
  advance: 'M2.6 3.8 7 8l-4.4 4.2zM8.6 3.8 13 8l-4.4 4.2z',
  // check in a circle — verify / get to green
  green: 'M5.4 8.2 7.2 10l3.4-3.9',
  // magnifier — survey without changing anything
  scan: 'M10.2 10.2 13.6 13.6',
  // page with a folded corner — docs / reports
  doc: 'M4 2.2h5l3 3v8.6H4zM9 2.2v3.1h3M6 9.2h4M6 11.2h2.6',
  // cycle arrow — refactor / tidy in rounds
  refactor: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.4v2.6h-2.6',
  // pencil — a one-off prompt written on the spot
  edit: 'M11.1 2.5 13.5 4.9 6.2 12.2l-3.2 0.8 0.8-3.2zM9.9 3.7l2.4 2.4',
}
</script>

<template>
  <svg class="ps-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle v-if="name === 'green'" cx="8" cy="8" r="5.9" />
    <circle v-else-if="name === 'scan'" cx="7" cy="7" r="4.3" />
    <path :d="PATHS[name]" />
  </svg>
</template>

<style scoped>
.ps-icon {
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
