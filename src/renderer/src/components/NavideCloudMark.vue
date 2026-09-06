<script setup lang="ts">
// The Navide Cloud mark: a cloud whose interior is a three-node mesh.
//
// Two variants because the same drawing cannot survive both sizes. In the
// titlebar the mark renders at 14px, where the mesh collapses into a smudge,
// so `solid` keeps only the silhouette. `mesh` is for the headers that
// introduce the feature, where there is room for the nodes to read as
// separate devices linked to each other.
withDefaults(
  defineProps<{
    /** `mesh` draws the linked nodes; `solid` is the small-size silhouette. */
    variant?: 'mesh' | 'solid'
  }>(),
  { variant: 'mesh' }
)
</script>

<template>
  <svg class="nv-cloud-mark" viewBox="0 0 32 24" aria-hidden="true">
    <!-- Cloud outline, shared by both variants. -->
    <path
      class="nv-cloud-outline"
      d="M8.6 20.5a5.6 5.6 0 0 1-.5-11.17A7.2 7.2 0 0 1 21.6 7.4a5.1 5.1 0 0 1 1.3 10.1"
    />
    <path class="nv-cloud-outline" d="M8.6 20.5h13.9" />
    <template v-if="variant === 'mesh'">
      <!-- Three devices, linked through the cloud rather than to each other. -->
      <path class="nv-cloud-link" d="M15.6 8.6 10.6 15.2M15.6 8.6l5 6.6M10.6 15.2h10" />
      <circle class="nv-cloud-node" cx="15.6" cy="8.6" r="2" />
      <circle class="nv-cloud-node" cx="10.6" cy="15.2" r="2" />
      <circle class="nv-cloud-node" cx="20.6" cy="15.2" r="2" />
    </template>
  </svg>
</template>

<style scoped>
.nv-cloud-mark {
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  overflow: visible;
}
.nv-cloud-outline {
  stroke-width: 1.7;
}
/* The links sit behind the nodes and must not compete with the outline. */
.nv-cloud-link {
  stroke-width: 1.2;
  opacity: 0.55;
}
/* The nodes are rings punched out of whatever the mark sits on, so the fill
   follows the container: a tinted tile sets --nv-cloud-node-fill to its own
   background, and anything that does not falls back to the app canvas. */
.nv-cloud-node {
  stroke-width: 1.5;
  fill: var(--nv-cloud-node-fill, var(--bg-base));
}
</style>
