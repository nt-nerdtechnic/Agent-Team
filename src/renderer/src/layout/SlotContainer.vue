<script setup lang="ts">
// Chrome for a horizontal slot: the tab strip, the collapse affordance, and the
// body. What goes *in* the body is the caller's business — the container takes
// a scoped slot rather than a component map, so the one place that knows each
// view's props stays the one place that passes them.
//
// The vertical slots (left / right) are still served by their own bespoke hosts
// and are not routed through here yet; see the layout plan's Phase B.
import { computed } from 'vue'
import { viewById } from './viewRegistry'
import type { SlotId } from './slots'

interface Props {
  slotId: SlotId
  /** View ids in tab order. Empty renders nothing and takes no space. */
  views: string[]
  active: string | null
  collapsed: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:active', v: string): void
  (e: 'update:collapsed', v: boolean): void
}>()

const tabs = computed(() =>
  props.views.map((id) => viewById(id)).filter((v): v is NonNullable<typeof v> => !!v)
)

/** The body only ever renders the active view — one mounted view per slot. */
const activeId = computed(() => {
  if (props.active && props.views.includes(props.active)) return props.active
  return props.views[0] ?? null
})

// Which way the chevron points is the direction the body would move, so `up`
// and `down` are mirror images of each other rather than both saying "down".
const chevron = computed(() => {
  const away = props.slotId === 'up' ? '⌃' : '⌄'
  const back = props.slotId === 'up' ? '⌄' : '⌃'
  return props.collapsed ? back : away
})

function pick(id: string): void {
  // Clicking a tab on a collapsed strip opens it, matching the side rails —
  // otherwise the click moves a highlight and nothing else happens.
  if (props.collapsed) emit('update:collapsed', false)
  if (id !== props.active) emit('update:active', id)
}
</script>

<template>
  <section
    v-if="tabs.length"
    class="slot"
    :class="[`slot--${slotId}`, { 'is-collapsed': collapsed }]"
  >
    <header class="slot-tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="slot-tab"
        :class="{ active: t.id === activeId }"
        :title="$t(t.titleKey)"
        @click="pick(t.id)"
      >
        <span class="slot-tab-icon">{{ t.icon }}</span>
        <span class="slot-tab-label">{{ $t(t.titleKey) }}</span>
      </button>
      <span class="slot-spacer" />
      <button
        class="slot-collapse"
        :title="collapsed ? $t('layout.expand') : $t('layout.collapse')"
        @click="emit('update:collapsed', !collapsed)"
      >{{ chevron }}</button>
    </header>

    <!-- v-show, not v-if: collapsing must not tear down the view's state. -->
    <div v-show="!collapsed" class="slot-body">
      <slot :view-id="activeId" />
    </div>
  </section>
</template>

<style scoped>
.slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
}
.slot--up { border-bottom: 1px solid var(--border-muted); }
.slot--down { border-top: 1px solid var(--border-muted); }

.slot-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  height: var(--rail-size, 36px);
  flex: 0 0 auto;
  padding: 0 6px;
  border-bottom: 1px solid var(--border-muted);
}
.slot.is-collapsed .slot-tabs { border-bottom: none; }

.slot-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s, background 0.15s;
}
.slot-tab:hover { color: var(--text-primary); background: var(--bg-elevated); }
.slot-tab.active { color: var(--text-bright); background: var(--bg-muted); }
.slot-tab-icon { font-size: 13px; }
.slot-tab-label { font-size: 11px; }

.slot-spacer { flex: 1; }
.slot-collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 24px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.slot-collapse:hover { color: var(--text-primary); background: var(--bg-elevated); }

.slot-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
