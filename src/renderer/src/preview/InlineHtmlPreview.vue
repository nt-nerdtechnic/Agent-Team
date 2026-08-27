<script setup lang="ts">
// HTML pushed inline by an agent or plugin, rendered in a fully locked-down
// iframe.
//
// Two layers, because the sandbox attribute alone is not enough. `sandbox=""`
// (no allow-*) stops scripts, forms, same-origin access and navigation — but
// it does NOT stop subresource requests, so a pushed `<img src="http://…">`
// would still phone home. The injected CSP closes that: `default-src 'none'`
// blocks every fetch the document could start, with inline styles and data:
// images allowed so ordinary formatted content still renders. Same approach as
// planRuntime's preparePlanDocHtml, minus the script nonce it needs and this
// does not.
import { computed } from 'vue'

const props = defineProps<{ content: string; title?: string }>()

const CSP =
  '<meta http-equiv="Content-Security-Policy" content="' +
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" +
  '">'

const doc = computed(() => CSP + props.content)
</script>

<template>
  <iframe class="ihp" sandbox="" :srcdoc="doc" :title="props.title ?? 'HTML preview'" />
</template>

<style scoped>
.ihp {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
