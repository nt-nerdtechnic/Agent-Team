<script setup lang="ts">
// Read-only code snippet pushed inline by an agent or plugin (no file behind
// it). Deliberately thin: monospace text with line numbers, no syntax
// highlighting and no editor — the rail is 180-520px wide and anything richer
// belongs in the editor window.
import { computed } from 'vue'

const props = defineProps<{ content: string; lang?: string }>()

const lines = computed(() => props.content.replace(/\n$/, '').split('\n'))
const gutterWidth = computed(() => String(lines.value.length).length)
</script>

<template>
  <div class="sp">
    <pre class="sp-code"><code
      v-for="(line, i) in lines"
      :key="i"
      class="sp-line"
    ><span class="sp-ln" :style="{ minWidth: gutterWidth + 'ch' }">{{ i + 1 }}</span>{{ line }}
</code></pre>
  </div>
</template>

<style scoped>
.sp {
  height: 100%;
  overflow: auto;
}
.sp-code {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
  font-size: 11.5px;
  line-height: var(--lh-loose);
  white-space: pre;
}
.sp-line {
  display: block;
}
.sp-ln {
  display: inline-block;
  margin-right: 10px;
  text-align: right;
  opacity: 0.45;
  user-select: none;
}
</style>
