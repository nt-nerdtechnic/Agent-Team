<script setup lang="ts">
// Font specimen preview for .ttf/.otf/.woff/.woff2. Loads the file from the
// backend's /fs/raw endpoint through the FontFace API under a per-instance
// family name; the face is removed from document.fonts on unmount.
import { onMounted, onUnmounted, ref } from 'vue'
import type { useBackend } from '../../composables/useBackend'
import { buildRawUrl, wsTokenFromUrl } from '../previewTypes'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
}>()

// Unique per pane instance so two open font tabs never collide.
const family = `fpv-font-${Math.random().toString(36).slice(2, 10)}`
const loading = ref(true)
const error = ref('')
let face: FontFace | null = null

const SPECIMEN_SIZES = [32, 24, 18, 14]
const PANGRAM = 'The quick brown fox jumps over the lazy dog'
const DIGITS = '0123456789 !@#$%&*()'
const CJK = '敏捷的棕色狐狸跳過懶惰的狗'

onMounted(async () => {
  const url = buildRawUrl(
    props.backend.httpUrl.value,
    props.workspacePath,
    props.relPath,
    wsTokenFromUrl(props.backend.wsUrl?.value ?? ''),
  )
  try {
    const f = new FontFace(family, `url("${url}")`)
    await f.load()
    document.fonts.add(f)
    // Only a successfully registered face needs cleanup on unmount.
    face = f
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  if (face) document.fonts.delete(face)
})
</script>

<template>
  <div class="fontp">
    <div v-if="loading" class="fontp-status">{{ $t('preview.font-loading') }}</div>
    <div v-else-if="error" class="fontp-card">
      <span class="fontp-card-icon">⬛</span>
      <p class="fontp-card-name">{{ name }}</p>
      <p class="fontp-card-error">{{ $t('preview.font-error') }} ({{ error }})</p>
    </div>
    <div v-else class="fontp-specimen" :style="{ fontFamily: `'${family}'` }">
      <p
        v-for="size in SPECIMEN_SIZES"
        :key="size"
        class="fontp-line"
        :style="{ fontSize: size + 'px' }"
      >{{ PANGRAM }}</p>
      <p class="fontp-line fontp-line--digits">{{ DIGITS }}</p>
      <p class="fontp-line fontp-line--cjk">{{ CJK }}</p>
    </div>
  </div>
</template>

<style scoped>
.fontp {
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.fontp-status {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.fontp-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}
.fontp-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.fontp-card-name {
  margin: 0;
  font-weight: 600;
}
.fontp-card-error {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg, #e5534b);
}
.fontp-specimen {
  padding: 16px 20px;
}
.fontp-line {
  margin: 0 0 12px;
  overflow-wrap: break-word;
}
.fontp-line--digits {
  font-size: var(--font-xl);
}
.fontp-line--cjk {
  font-size: 24px;
}
</style>
