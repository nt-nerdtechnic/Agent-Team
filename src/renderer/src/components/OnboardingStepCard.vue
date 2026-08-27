<script setup lang="ts">
/**
 * OnboardingStepCard — one step of a sequential guided flow.
 *
 * Three visual states, mirroring the guided-setup pattern:
 *   done      → collapses to title + filled checkmark badge
 *   expanded  → title, description and the action slot
 *   upcoming  → title only, dimmed, click to expand
 */
defineProps<{
  title: string
  description?: string
  done?: boolean
  expanded?: boolean
  optional?: boolean
  meta?: string
  warning?: string
}>()

defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div class="oc-card" :class="{ done, expanded }">
    <button type="button" class="oc-head" @click="$emit('toggle')">
      <span class="oc-title">
        {{ title }}
        <span v-if="optional" class="oc-tag">{{ $t('label.optional') }}</span>
        <span v-if="meta" class="oc-meta">{{ meta }}</span>
      </span>
      <span v-if="done" class="oc-check" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </button>

    <!-- A done card still opens on click: its actions include Re-detect, and a
         dead click was the only feedback when a user re-checked a green step. -->
    <div v-if="expanded" class="oc-body">
      <p v-if="description" class="oc-desc">{{ description }}</p>
      <p v-if="warning" class="oc-warn">{{ warning }}</p>
      <div class="oc-actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.oc-card {
  border-radius: 14px;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  margin-bottom: 12px;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.oc-card.expanded {
  border-color: var(--border-default);
}
.oc-card.done {
  background: var(--bg-subtle);
}

.oc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 20px 22px;
  background: none;
  border: 0;
  text-align: left;
  cursor: pointer;
}
.oc-card.expanded .oc-head {
  padding-bottom: 8px;
}

.oc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 17px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--text-bright);
}
.oc-card:not(.expanded):not(.done) .oc-title {
  color: var(--text-secondary);
}

.oc-tag {
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 5px;
}
.oc-meta {
  font: 11px/1 ui-monospace, Menlo, monospace;
  color: var(--text-muted);
}

.oc-check {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
}

.oc-body {
  padding: 0 22px 20px;
}
.oc-desc {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.oc-warn {
  margin: -6px 0 14px;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--attention-fg);
}
.oc-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
