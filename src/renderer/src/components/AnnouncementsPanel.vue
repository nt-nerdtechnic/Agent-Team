<script setup lang="ts">
// Announcements centre popover, anchored to its status-bar item (same backdrop
// + fixed-card shape as the backend supervisor popover in App.vue).
//
// Purely prop/emit driven: the feed and the updater actions live in App.vue, so
// this component only decides layout, expansion and which button a row offers.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Announcement } from '../composables/useAnnouncements'

const props = defineProps<{ items: Announcement[] }>()
const emit = defineEmits<{
  close: []
  'mark-all-read': []
  read: [id: string]
  download: []
  install: []
}>()

const expandedId = ref<string | null>(null)

/** Rows rendered per page — the rest wait behind the load-more button. The
 *  popover is v-if'd by its opener, so this resets on every open. */
const PAGE_SIZE = 8
const visibleCount = ref(PAGE_SIZE)

const visibleItems = computed(() => props.items.slice(0, visibleCount.value))
const remainingCount = computed(() => props.items.length - visibleItems.value.length)

function loadMore(): void {
  visibleCount.value += PAGE_SIZE
}

function toggle(item: Announcement): void {
  if (expandedId.value === item.id) {
    expandedId.value = null
    return
  }
  expandedId.value = item.id
  if (!item.read) emit('read', item.id)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <div class="an-backdrop" @click="emit('close')" />
  <div class="an-pop nv-popover" @click.stop>
    <div class="an-head">
      <span class="an-head-title">{{ $t('announce.title') }}</span>
      <button class="an-btn" data-act="mark-all" @click="emit('mark-all-read')">
        {{ $t('announce.mark-all-read') }}
      </button>
      <button class="an-btn" data-act="close" :title="$t('announce.close')" @click="emit('close')">✕</button>
    </div>

    <div class="an-list">
      <div v-if="items.length === 0" class="an-empty">{{ $t('announce.empty') }}</div>
      <div
        v-for="item in visibleItems"
        :key="item.id"
        class="an-row"
        :class="{ expanded: expandedId === item.id, unread: !item.read }"
        :data-ann-id="item.id"
        :data-ann-kind="item.kind"
        @click="toggle(item)"
      >
        <div class="an-line1">
          <span class="an-icon">{{ item.kind === 'release' ? '🏷' : '⬆' }}</span>
          <span class="an-title">{{ item.title }}</span>
          <span v-if="item.version" class="an-ver">v{{ item.version }}</span>
          <span v-if="!item.read" class="an-dot" />
        </div>
        <div v-if="item.createdAt" class="an-time">{{ fmtTime(item.createdAt) }}</div>
        <div v-if="item.action" class="an-acts">
          <button
            v-if="item.action === 'download'"
            class="an-btn an-btn-primary"
            data-act="download"
            @click.stop="emit('download')"
          >{{ $t('updater.download') }}</button>
          <button
            v-else
            class="an-btn an-btn-primary"
            data-act="install"
            @click.stop="emit('install')"
          >{{ $t('updater.install') }}</button>
        </div>
        <div v-if="expandedId === item.id" class="an-detail">
          <div v-if="item.kind === 'update' && item.highlights.length > 0" class="an-sub">
            {{ $t('updater.release-notes') }}
          </div>
          <ul v-if="item.highlights.length > 0" class="an-points">
            <li v-for="(point, index) in item.highlights" :key="index">{{ point }}</li>
          </ul>
          <div v-if="item.note" class="an-note">{{ item.note }}</div>
        </div>
      </div>
      <div v-if="remainingCount > 0" class="an-more">
        <button class="an-btn" data-act="load-more" @click="loadMore">
          {{ $t('announce.load-more', { count: remainingCount }) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.an-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.an-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 340px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.an-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.an-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.an-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.an-btn:hover { color: var(--text-bright); }
.an-btn-primary {
  color: var(--accent-fg);
  font-weight: 600;
}
.an-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.an-empty {
  padding: 20px 10px;
  text-align: center;
  color: var(--text-muted);
}
.an-more {
  padding: 8px 10px;
  display: flex;
  justify-content: center;
}
.an-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-muted);
  cursor: pointer;
}
.an-row:hover { background: var(--bg-hover); }
.an-line1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.an-icon { flex: none; }
.an-title {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.an-row.unread .an-title { font-weight: 600; color: var(--text-bright); }
.an-ver {
  flex: none;
  font-size: var(--font-3xs);
  border-radius: 99px;
  padding: 0 6px;
  background: var(--bg-hover);
  color: var(--text-muted);
}
.an-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
}
.an-time {
  margin-top: 2px;
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.an-acts {
  margin-top: 5px;
  display: flex;
  gap: 5px;
}
.an-detail { padding: 6px 0 2px; }
.an-sub {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 3px;
}
.an-points {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text-primary);
}
.an-note {
  margin-top: 5px;
  color: var(--text-muted);
}
</style>
