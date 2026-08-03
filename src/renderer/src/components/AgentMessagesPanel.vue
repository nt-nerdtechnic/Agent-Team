<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentMessaging } from '../composables/useAgentMessaging'

const emit = defineEmits<{ (e: 'close'): void }>()

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
  <Teleport to="body">
    <div class="msg-overlay" @click.self="emit('close')">
      <div class="msg-panel">
        <div class="msg-head">
          <span class="msg-title">{{ $t('msg.panel-title') }}</span>
          <button
            class="msg-btn"
            @click="messaging.paused.value ? messaging.resumeMessaging() : messaging.pauseMessaging()"
          >
            {{ messaging.paused.value ? $t('msg.resume') : $t('msg.pause') }}
          </button>
          <button class="msg-btn" @click="messaging.clearMessageLog()">{{ $t('msg.clear-log') }}</button>
          <button class="msg-btn msg-close" @click="emit('close')">✕</button>
        </div>

        <div v-if="messaging.paused.value" class="msg-paused">{{ $t('msg.paused-banner') }}</div>

        <div class="msg-list">
          <div v-if="rows.length === 0" class="msg-empty">{{ $t('msg.empty') }}</div>
          <div
            v-for="msg in rows"
            :key="msg.id"
            class="msg-row"
            :class="{ expanded: expandedId === msg.id }"
            @click="toggleExpand(msg.id)"
          >
            <div class="msg-row-line">
              <span class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
              <span class="msg-route">{{ msg.from }} → {{ msg.to }}</span>
              <span v-if="msg.remote" class="msg-xws" :title="msg.remoteWorkspace">
                {{ $t('msg.cross-workspace-badge') }}
              </span>
              <span class="msg-st" :data-st="msg.status">{{ $t(`msg.status-${msg.status}`) }}</span>
              <span class="msg-preview">{{ msg.content }}</span>
            </div>
            <div v-if="expandedId === msg.id" class="msg-detail">
              <pre>{{ msg.content }}</pre>
              <div v-if="msg.reason" class="msg-reason">{{ msg.reason }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.msg-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  -webkit-app-region: no-drag;
}

.msg-panel {
  width: min(720px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  box-shadow: 0 24px 60px var(--shadow-overlay);
  overflow: hidden;
}

:root[data-theme='light'] .msg-panel {
  border-color: rgba(31, 35, 40, 0.15);
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}

.msg-title {
  flex: 1;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.msg-btn {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-primary);
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.msg-btn:hover { background: rgba(128, 128, 128, 0.22); }
.msg-btn:disabled { opacity: 0.45; cursor: default; }
.msg-close { font-size: 13px; }

.msg-paused {
  padding: 6px 16px;
  font-size: 12.5px;
  background: rgba(230, 160, 60, 0.15);
  color: #e8a54b;
  border-bottom: 1px solid rgba(230, 160, 60, 0.25);
}

.msg-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}

.msg-empty {
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}

.msg-row {
  padding: 6px 16px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  cursor: pointer;
}

.msg-row:hover { background: rgba(128, 128, 128, 0.08); }

.msg-row-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  min-width: 0;
}

.msg-time { color: var(--text-secondary); flex: none; }
.msg-route { color: var(--text-primary); font-weight: 600; flex: none; }

.msg-st {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 8px;
}

.msg-xws {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 8px;
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
  color: var(--text-secondary);
}

.msg-detail { padding: 8px 4px 4px; }

.msg-detail pre {
  margin: 0;
  padding: 8px 10px;
  background: rgba(128, 128, 128, 0.1);
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
  color: var(--text-primary);
}

.msg-reason {
  margin-top: 6px;
  font-size: 12px;
  color: #e0706a;
}
</style>
