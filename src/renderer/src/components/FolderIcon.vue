<template>
  <svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.75 12.5v-9h4l1.5 2h7v7z" />
  </svg>
</template>

<style scoped>
/* Outline, not the 🗀 glyph: that one falls back to a striped block in several
   of the fonts this app runs under. */
.folder-icon {
  display: block;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
