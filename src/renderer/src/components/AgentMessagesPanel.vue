<script setup lang="ts">
// Messages tab of the right-hand rail: the inter-CLI delivery log.
//
// Laid out for a ~300px column (the rail is resizable down to 180px): every row
// is two compact lines, and the message body lives in an expandable detail
// block that scrolls instead of widening the rail.
import { computed, ref } from 'vue'
import { useAgentMessaging } from '../composables/useAgentMessaging'

const messaging = useAgentMessaging()

const expandedId = ref<number | null>(null)

// Newest first for the log list.
const rows = computed(() => [...messaging.messages.value].reverse())

function toggleExpand(id: number): void {
  expandedId.value = expandedId.value === id ? null : id
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}
</script>

<template>
  <div class="msg-panel">
    <div class="msg-bar">
      <span class="msg-title">{{ $t('msg.panel-title') }}</span>
      <span class="msg-acts">
        <button
          class="msg-btn"
          data-act="pause"
          @click="messaging.paused.value ? messaging.resumeMessaging() : messaging.pauseMessaging()"
        >
          {{ messaging.paused.value ? $t('msg.resume') : $t('msg.pause') }}
        </button>
        <button class="msg-btn" data-act="clear" @click="messaging.clearMessageLog()">
          {{ $t('msg.clear-log') }}
        </button>
      </span>
    </div>

    <div v-if="messaging.paused.value" class="msg-paused">{{ $t('msg.paused-banner') }}</div>

    <div class="msg-list">
      <div v-if="rows.length === 0" class="msg-empty">{{ $t('msg.empty') }}</div>
      <div
        v-for="msg in rows"
        :key="msg.id"
        class="msg-row"
        :class="{ expanded: expandedId === msg.id }"
        :data-msg-id="msg.id"
        @click="toggleExpand(msg.id)"
      >
        <div class="msg-line1">
          <span class="msg-route">{{ msg.from }} → {{ msg.to }}</span>
          <span class="msg-st" :data-st="msg.status">{{ $t(`msg.status-${msg.status}`) }}</span>
          <span v-if="msg.remote" class="msg-xws" :title="msg.remoteWorkspace">
            {{ $t('msg.cross-workspace-badge') }}
          </span>
        </div>
        <div class="msg-line2">
          <span class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
          <span class="msg-preview">{{ msg.content }}</span>
        </div>
        <div v-if="expandedId === msg.id" class="msg-detail">
          <pre>{{ msg.content }}</pre>
          <div v-if="msg.reason" class="msg-reason">{{ msg.reason }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-panel {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.msg-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}

.msg-title {
  min-width: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-acts {
  display: flex;
  /* At the rail's 180px minimum the two labels stack rather than clip. */
  flex-wrap: wrap;
  gap: 4px;
}

.msg-btn {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-primary);
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  cursor: pointer;
}

.msg-btn:hover { background: rgba(128, 128, 128, 0.22); }
.msg-btn:disabled { opacity: 0.45; cursor: default; }

.msg-paused {
  flex: none;
  padding: 4px 10px;
  font-size: 10px;
  background: rgba(230, 160, 60, 0.15);
  color: #e8a54b;
  border-bottom: 1px solid rgba(230, 160, 60, 0.25);
}

.msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.msg-empty {
  padding: 20px 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-secondary);
}

.msg-row {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  cursor: pointer;
}

.msg-row:hover { background: rgba(128, 128, 128, 0.08); }

.msg-line1 {
  display: flex;
  align-items: center;
  /* The status / cross-workspace badges don't shrink; let them drop to another
     line instead of being clipped when the rail is near its 180px minimum. */
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.msg-line2 {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  margin-top: 2px;
}

.msg-route {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-time {
  flex: none;
  font-size: 10px;
  color: var(--text-secondary);
}

.msg-st {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
}

.msg-xws {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
  background: rgba(110, 150, 230, 0.18);
  color: #7ba3e8;
}

.msg-st[data-st='queued'] { background: rgba(128, 128, 128, 0.18); color: var(--text-secondary); }
.msg-st[data-st='delivering'] { background: rgba(230, 160, 60, 0.18); color: #e8a54b; }
.msg-st[data-st='delivered'] { background: rgba(80, 190, 100, 0.18); color: #4fae5f; }
.msg-st[data-st='failed'] { background: rgba(220, 80, 70, 0.18); color: #e0706a; }

.msg-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-secondary);
}

.msg-detail { padding: 6px 0 2px; }

.msg-detail pre {
  margin: 0;
  padding: 6px 8px;
  background: rgba(128, 128, 128, 0.1);
  border-radius: 4px;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
  color: var(--text-primary);
}

.msg-reason {
  margin-top: 4px;
  font-size: 10px;
  color: #e0706a;
}

:root[data-theme='light'] .msg-bar,
:root[data-theme='light'] .msg-row {
  border-bottom-color: rgba(31, 35, 40, 0.15);
}
</style>
