<script setup lang="ts">
import navideMark from '../assets/navide-mark.png'

/**
 * The waiting indicator for work that happens *around* a running app — a
 * workspace switch, a list reloading — as opposed to the app itself starting
 * or stopping.
 *
 * Boot and shutdown breathe the mark in place: the app is the thing arriving
 * or leaving, so the mark is what moves. Everywhere else the app never
 * stopped running and only its surroundings are changing, so here the mark
 * holds its size and an arc travels around it instead. Same brand, different
 * sentence — which is why this is a separate component rather than a shared
 * one those two also use.
 */
withDefaults(defineProps<{
  /** Outer box in px; the mark scales with it. */
  size?: number
  /** Announced to screen readers. Empty leaves the element unlabelled, for
   *  callers whose surrounding text already says what is loading. */
  label?: string
}>(), { size: 72, label: '' })
</script>

<template>
  <span
    class="brand-loader"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <img class="brand-loader-logo" :src="navideMark" alt="" />
    <span class="brand-loader-orbit"></span>
  </span>
</template>

<style scoped>
.brand-loader {
  position: relative;
  margin: 0 auto;
  display: grid;
  place-items: center;
}
.brand-loader-logo {
  /* Just under half the box, the proportion the workspace-switch cover was
     tuned at; scaling with the box keeps every size looking like one mark. */
  width: 47%;
  height: 47%;
  display: block;
  /* Opacity only, and shallower and quicker than boot's 2.6s breathe: the
     scale is what makes that one read as breathing, so leaving it out is what
     keeps these two apart at a glance. */
  animation: brand-loader-glow 1.5s ease-in-out infinite;
}
.brand-loader-orbit {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--accent-muted);
  /* Two lit sides rather than one: the trailing quarter reads as a sweep round
     the mark, where a single arc reads as the plain spinner it replaces. */
  border-top-color: var(--accent-fg);
  border-right-color: var(--accent-focus);
  animation: brand-loader-orbit 1.1s linear infinite;
}
@keyframes brand-loader-orbit {
  to { transform: rotate(360deg); }
}
@keyframes brand-loader-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.62; }
}
@media (prefers-reduced-motion: reduce) {
  .brand-loader-logo { animation: none; }
  .brand-loader-orbit { animation-duration: 2.4s; }
}
</style>
