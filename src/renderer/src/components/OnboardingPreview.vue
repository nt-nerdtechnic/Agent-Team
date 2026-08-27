<script setup lang="ts">
/**
 * OnboardingPreview — the right-hand illustration column of the wizard.
 *
 * `settings` renders a static mock of the macOS System Settings pane a
 * permission lives in, so the user knows where to look once the OS prompt
 * appears. `app` renders a decorative mock of the app shell for the steps
 * that have no matching settings pane.
 *
 * Purely presentational: nothing here reads real OS state.
 */
defineProps<{
  variant: 'settings' | 'app'
  pane?: string
  caption?: string
  granted?: boolean
  rows?: string[]
}>()
</script>

<template>
  <div class="op-stage">
    <!-- macOS System Settings mock -->
    <div v-if="variant === 'settings'" class="op-window">
      <div class="op-titlebar">
        <span class="op-dot red" />
        <span class="op-dot yellow" />
        <span class="op-dot green" />
        <span class="op-crumb">{{ pane }}</span>
      </div>
      <div class="op-window-body">
        <p class="op-caption">{{ caption }}</p>
        <div class="op-list">
          <div class="op-row app" :class="{ on: granted }">
            <span class="op-appicon">N</span>
            <span class="op-appname">Navide</span>
            <span class="op-switch" :class="{ on: granted }"><span class="op-knob" /></span>
          </div>
          <div v-for="r in rows ?? []" :key="r" class="op-row ghost">
            <span class="op-appicon ghost" />
            <span class="op-appname ghost">{{ r }}</span>
            <span class="op-switch"><span class="op-knob" /></span>
          </div>
        </div>
        <div class="op-listfoot"><span>+</span><span>−</span></div>
      </div>
    </div>

    <!-- App shell mock -->
    <div v-else class="op-window">
      <div class="op-titlebar">
        <span class="op-dot red" />
        <span class="op-dot yellow" />
        <span class="op-dot green" />
        <span class="op-crumb">Navide</span>
      </div>
      <div class="op-app">
        <div class="op-sidebar">
          <span v-for="i in 5" :key="i" class="op-bar" :style="{ width: `${90 - i * 9}%` }" />
        </div>
        <div class="op-panes">
          <div class="op-pane">
            <span class="op-bar accent" style="width: 55%" />
            <span class="op-bar" style="width: 80%" />
            <span class="op-bar" style="width: 68%" />
            <span class="op-bar" style="width: 42%" />
          </div>
          <div class="op-pane">
            <span class="op-bar accent" style="width: 40%" />
            <span class="op-bar" style="width: 72%" />
            <span class="op-bar" style="width: 58%" />
          </div>
        </div>
      </div>
    </div>

    <p v-if="variant === 'app' && caption" class="op-footnote">{{ caption }}</p>
  </div>
</template>

<style scoped>
.op-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  height: 100%;
  padding: 32px;
}
.op-window {
  width: 100%;
  max-width: 420px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  box-shadow: 0 24px 60px -20px var(--shadow-overlay);
}
.op-titlebar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
}
.op-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-disabled);
}
.op-dot.red {
  background: var(--danger-fg);
}
.op-dot.yellow {
  background: var(--attention-fg);
}
.op-dot.green {
  background: var(--success-fg);
}
.op-crumb {
  margin-left: 8px;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.op-window-body {
  padding: 18px 18px 14px;
}
.op-caption {
  margin: 0 0 14px;
  font-size: 11.5px;
  line-height: var(--lh-base);
  color: var(--text-muted);
}
.op-list {
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-inset);
}
.op-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.op-row:last-child {
  border-bottom: 0;
}
.op-row.app.on {
  background: var(--bg-selected);
}
.op-appicon {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-3xs);
  font-weight: 700;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.op-appicon.ghost {
  background: var(--bg-muted);
}
.op-appname {
  flex: 1;
  font-size: var(--font-xs);
  color: var(--text-primary);
}
.op-appname.ghost {
  color: var(--text-muted);
}
.op-switch {
  flex: none;
  width: 30px;
  height: 17px;
  border-radius: 999px;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  padding: 1px;
  display: flex;
  transition:
    background 0.18s,
    border-color 0.18s;
}
.op-switch.on {
  background: var(--success-emphasis);
  border-color: var(--success-emphasis);
  justify-content: flex-end;
}
.op-knob {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-on-emphasis);
}
.op-listfoot {
  display: flex;
  gap: 10px;
  padding: 6px 4px 0;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}

/* ── App shell mock ─────────────────────────────────────────────────────────── */
.op-app {
  display: flex;
  height: 220px;
}
.op-sidebar {
  width: 30%;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 12px;
  background: var(--bg-inset);
  border-right: 1px solid var(--border-muted);
}
.op-panes {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.op-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px;
}
.op-pane + .op-pane {
  border-top: 1px solid var(--border-muted);
}
.op-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-muted);
}
.op-bar.accent {
  background: color-mix(in srgb, var(--accent-fg) 45%, transparent);
}
.op-footnote {
  margin: 0;
  max-width: 420px;
  text-align: center;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--text-muted);
}
</style>
