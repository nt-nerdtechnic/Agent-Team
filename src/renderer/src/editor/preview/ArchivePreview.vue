<script setup lang="ts">
// Archive entry listing for .zip/.tar/.tar.gz/.tgz via the WS fs.list_archive
// handler: {ok, entries: [{name, size, is_dir}], total_entries, truncated}.
import { onMounted, ref } from 'vue'
import type { useBackend } from '../../composables/useBackend'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
}>()

interface ArchiveEntry {
  name: string
  size: number
  is_dir: boolean
}

interface ListArchiveResp {
  ok: boolean
  entries?: ArchiveEntry[]
  total_entries?: number
  truncated?: boolean
  error?: string
}

const loading = ref(true)
const error = ref('')
const entries = ref<ArchiveEntry[]>([])
const totalEntries = ref(0)
const truncated = ref(false)

function formatBytes(bytes: number): string {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

onMounted(async () => {
  try {
    const r = await props.backend.send<ListArchiveResp>('fs.list_archive', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    if (!r.payload?.ok) {
      error.value = r.payload?.error || 'list failed'
      return
    }
    entries.value = r.payload.entries ?? []
    totalEntries.value = r.payload.total_entries ?? entries.value.length
    truncated.value = r.payload.truncated ?? false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="arcp">
    <div v-if="loading" class="arcp-status">{{ $t('preview.archive-loading') }}</div>
    <div v-else-if="error" class="arcp-card">
      <span class="arcp-card-icon">⬛</span>
      <p class="arcp-card-name">{{ name }}</p>
      <p class="arcp-card-error">{{ $t('preview.archive-error') }} ({{ error }})</p>
    </div>
    <template v-else>
      <div class="arcp-status">
        {{ $t('preview.archive-entries', { count: totalEntries }) }}
        <span v-if="truncated"> · {{ $t('preview.archive-truncated') }}</span>
      </div>
      <div class="arcp-scroll">
        <table class="arcp-table">
          <thead>
            <tr>
              <th class="arcp-th">{{ $t('preview.archive-col-name') }}</th>
              <th class="arcp-th arcp-th--size">{{ $t('preview.archive-col-size') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in entries" :key="entry.name">
              <td class="arcp-td arcp-td--name">
                <span class="arcp-icon">{{ entry.is_dir ? '📁' : '📄' }}</span>{{ entry.name }}
              </td>
              <td class="arcp-td arcp-td--size">{{ entry.is_dir ? '' : formatBytes(entry.size) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.arcp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.arcp-status {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  flex: none;
}
.arcp-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}
.arcp-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.arcp-card-name {
  margin: 0;
  font-weight: 600;
}
.arcp-card-error {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg, #e5534b);
}
.arcp-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.arcp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-xs);
}
.arcp-th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle, rgba(128, 128, 128, 0.12));
  text-align: left;
  font-weight: 600;
  white-space: nowrap;
}
.arcp-th,
.arcp-td {
  padding: 3px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
}
.arcp-td--name {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-all;
}
.arcp-icon {
  margin-right: 6px;
}
.arcp-th--size,
.arcp-td--size {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
