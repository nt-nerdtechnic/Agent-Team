<script setup lang="ts">
// Clock popover, anchored to the status-bar clock (same backdrop + fixed-card
// shape as the backend supervisor popover in App.vue).
//
// It exists because the status bar carries two timestamps that look alike: the
// live clock and the build stamp frozen at bundle time. Everything here is
// derived from props — `now` is App.vue's existing 1s tick, so the popover adds
// no timer of its own.
import { computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** Epoch ms, re-sent every second by App.vue's status-bar tick. */
  now: number
  /** Epoch ms when this renderer booted. */
  startedAt: number
  /** Project `created_at` (ISO 8601); empty when no project is open. */
  projectCreatedAt: string
  /** Frozen at bundle time — the whole reason this popover exists. */
  buildTag: string
}>()
const emit = defineEmits<{ close: [] }>()

const { locale, t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const nowText = computed(() =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeStyle: 'medium' }).format(
    new Date(props.now)
  )
)

const timezoneText = computed(() => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  // getTimezoneOffset() counts minutes *behind* UTC, so UTC+8 reports -480.
  const offsetMinutes = -new Date(props.now).getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const hours = Math.floor(absolute / 60)
  const minutes = absolute % 60
  const offset = `UTC${sign}${hours}${minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : ''}`
  return zone ? `${zone} (${offset})` : offset
})

/** At most two units, largest first: "3 小時 21 分", "1 天", "5 分". */
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMinutes < 1) return t('clock.duration-less-than-minute')
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(t('clock.duration-days', { count: days }))
  if (hours > 0) parts.push(t('clock.duration-hours', { count: hours }))
  // Minutes are noise next to a day-scale uptime.
  if (minutes > 0 && days === 0) parts.push(t('clock.duration-minutes', { count: minutes }))
  return parts.join(' ')
}

const uptimeText = computed(() => formatDuration(props.now - props.startedAt))

const projectCreatedText = computed(() => {
  const created = Date.parse(props.projectCreatedAt)
  if (Number.isNaN(created)) return t('clock.project-unknown')
  const absolute = new Intl.DateTimeFormat(locale.value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(created))
  const elapsedDays = Math.max(0, Math.floor((props.now - created) / 86_400_000))
  const relative = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(
    elapsedDays === 0 ? 0 : -elapsedDays,
    'day'
  )
  return `${absolute} · ${relative}`
})
</script>

<template>
  <div class="ck-backdrop" @click="emit('close')" />
  <div class="ck-pop nv-popover" @click.stop>
    <div class="ck-head">
      <span class="ck-head-title">{{ t('clock.title') }}</span>
      <button class="ck-btn" data-act="close" :title="t('clock.close')" @click="emit('close')">✕</button>
    </div>
    <div class="ck-rows">
      <div class="ck-row" data-row="now">
        <span class="ck-k">{{ t('clock.now') }}</span>
        <span class="ck-v">{{ nowText }}</span>
      </div>
      <div class="ck-row" data-row="timezone">
        <span class="ck-k">{{ t('clock.timezone') }}</span>
        <span class="ck-v">{{ timezoneText }}</span>
      </div>
      <div class="ck-row" data-row="uptime">
        <span class="ck-k">{{ t('clock.uptime') }}</span>
        <span class="ck-v">{{ uptimeText }}</span>
      </div>
      <div class="ck-row" data-row="project">
        <span class="ck-k">{{ t('clock.project-created') }}</span>
        <span class="ck-v">{{ projectCreatedText }}</span>
      </div>
      <div class="ck-row" data-row="build">
        <span class="ck-k">{{ t('clock.build') }}</span>
        <span class="ck-v">{{ buildTag }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ck-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.ck-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 300px;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: 12px;
  color: var(--text-secondary);
}
.ck-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.ck-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.ck-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: 10px;
  cursor: pointer;
}
.ck-btn:hover { color: var(--text-bright); }
.ck-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}
.ck-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.ck-k {
  flex: none;
  width: 84px;
  color: var(--text-muted);
}
.ck-v {
  flex: 1;
  min-width: 0;
  color: var(--text-bright);
  overflow-wrap: anywhere;
}
.ck-row[data-row='build'] .ck-v {
  font-family: var(--font-mono);
  color: var(--text-secondary);
}
</style>
