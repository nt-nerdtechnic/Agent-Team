<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { pickText, WHATS_NEW_CHROME, type WhatsNewEntry } from '../lib/whatsNew'

const props = defineProps<{ entry: WhatsNewEntry }>()
const emit = defineEmits<{ close: [] }>()

const { locale } = useI18n()

const title = computed(() => pickText(props.entry.title, locale.value))
const header = computed(() => pickText(WHATS_NEW_CHROME.header, locale.value))
const dismiss = computed(() => pickText(WHATS_NEW_CHROME.dismiss, locale.value))
const highlights = computed(() =>
  props.entry.highlights.map((h) => pickText(h, locale.value)),
)
const note = computed(() =>
  props.entry.note ? pickText(props.entry.note, locale.value) : '',
)
</script>

<template>
  <Teleport to="body">
    <div
      class="modal"
      tabindex="-1"
      @click.self="emit('close')"
      @keydown.esc="emit('close')"
      @keydown.enter="emit('close')"
    >
      <div class="card">
        <header>
          <span class="dot"></span>
          <strong>{{ header }} · v{{ entry.version }}</strong>
        </header>
        <div class="body">
          <h2 class="title">{{ title }}</h2>
          <ul class="highlights">
            <li v-for="(line, i) in highlights" :key="i">{{ line }}</li>
          </ul>
          <p v-if="note" class="note">{{ note }}</p>
        </div>
        <footer>
          <button class="primary" @click="emit('close')">{{ dismiss }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2100;
}
.modal:focus {
  outline: none;
}
.card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--accent-fg);
  border-radius: 8px;
  width: min(520px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: 13px;
  box-shadow: 0 12px 48px var(--shadow-overlay);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 20%, transparent);
}
header strong {
  color: var(--text-bright);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
}
.title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-bright);
}
.highlights {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  line-height: 1.55;
}
.highlights li {
  color: var(--text-bright);
}
.note {
  margin: 14px 0 0;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  line-height: 1.5;
  color: var(--text-secondary);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-base);
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:hover {
  background: var(--success-strong);
}
</style>
