<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useEditorTargets } from '../composables/useEditorTargets'
import { useRecentWorkspaces, type RecentWorkspace } from '../composables/useRecentWorkspaces'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** Opened from the sidebar rather than shown at startup: gets a close
   *  button, Escape and a backdrop click. Off by default — there is nothing
   *  behind the startup screen to dismiss it to. */
  dismissible?: boolean
}>()
const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'open-settings'): void
  (e: 'close'): void
}>()

function dismiss(): void {
  if (props.dismissible) emit('close')
}
function onDismissKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') dismiss()
}
onMounted(() => {
  if (props.dismissible) document.addEventListener('keydown', onDismissKey)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onDismissKey))

const { recent, loaded, error, touch, pin, unpin, remove } = useRecentWorkspaces(props.backend)

const picking = ref(false)
const creating = ref(false)

// Workspaces open in other windows (this window shows Welcome, so it has
// none itself). Fed by main's registry; refreshed on workspace:openChanged.
const openWorkspaces = ref<string[]>([])
let disposeOpenChanged: (() => void) | null = null

async function refreshOpenWorkspaces(): Promise<void> {
  openWorkspaces.value = (await window.agentTeam?.listOpenWorkspaces?.()) ?? []
}

onMounted(() => {
  void refreshOpenWorkspaces()
  disposeOpenChanged = window.agentTeam?.onOpenWorkspacesChanged?.(() => {
    void refreshOpenWorkspaces()
  }) ?? null
})

onBeforeUnmount(() => {
  disposeOpenChanged?.()
  disposeOpenChanged = null
  window.removeEventListener('keydown', onCtxKeydown)
})

function isOpenElsewhere(path: string): boolean {
  const norm = (p: string): string => p.replace(/\/+$/, '')
  const target = norm(path)
  return openWorkspaces.value.some((ws) => norm(ws) === target)
}

// Pinned first, then most-recent-first (backend already orders by recency).
const ordered = computed<RecentWorkspace[]>(() => {
  const pinned = recent.value.filter((r) => r.pinned)
  const rest = recent.value.filter((r) => !r.pinned)
  return [...pinned, ...rest]
})

// How the workspace's last pipeline run ended, mirrored onto the recent entry
// by the backend's pipeline handlers. Folders that never ran one ('' from older
// entries, 'idle' from a project that was only ever used to spawn CLI panes)
// get no badge — a row of identical placeholders is noise, not information.
function stateBadge(state: string): { icon: string; label: string; cls: string } | null {
  switch (state) {
    case 'completed':
      return { icon: '✓', label: 'completed', cls: 'completed' }
    case 'running':
      return { icon: '▶', label: 'running', cls: 'running' }
    case 'aborted':
      return { icon: '⏸', label: 'aborted', cls: 'aborted' }
    default:
      return null
  }
}

function timeAgo(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

async function openWorkspace(path: string): Promise<void> {
  // Already open in another window → focus that window instead of opening a
  // duplicate (two windows on one folder means conflicting PTY/git operations).
  if (await window.agentTeam?.focusWorkspaceWindow?.(path)) return
  await touch(path)
  emit('select', path)
}

async function browse(): Promise<void> {
  if (!window.agentTeam) return
  picking.value = true
  try {
    const picked = await window.agentTeam.pickWorkspace()
    if (picked) await openWorkspace(picked)
  } finally {
    picking.value = false
  }
}

async function newWorkspace(): Promise<void> {
  if (!window.agentTeam) return
  creating.value = true
  try {
    const picked = await window.agentTeam.newWorkspace()
    if (picked) await openWorkspace(picked)
  } finally {
    creating.value = false
  }
}

async function openHome(): Promise<void> {
  if (!window.agentTeam) return
  const home = await window.agentTeam.getHomeDir()
  if (home) await openWorkspace(home)
}

async function togglePin(item: RecentWorkspace, ev: Event): Promise<void> {
  ev.stopPropagation()
  if (item.pinned) await unpin(item.path)
  else await pin(item.path)
}

async function removeItem(item: RecentWorkspace, ev: Event): Promise<void> {
  ev.stopPropagation()
  await remove(item.path)
}

// ── Context menu ─────────────────────────────────────────────────────────────
// Backdrop + fixed menu, following the PlansPane convention.
const { editorTargets, loadEditorTargets } = useEditorTargets()
const ctxMenu = ref<{ show: boolean; x: number; y: number; path: string }>({
  show: false,
  x: 0,
  y: 0,
  path: '',
})
const ctxMenuEl = ref<HTMLElement | null>(null)

// Keep the menu inside the viewport: clamp with a rough size first so it never
// spawns off-screen, then re-clamp once the real element is measured.
function clampMenu(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

async function openCtxMenu(e: MouseEvent, item: RecentWorkspace): Promise<void> {
  e.preventDefault()
  const first = clampMenu(e.clientX, e.clientY, 200, 180)
  ctxMenu.value = { show: true, x: first.x, y: first.y, path: item.path }
  window.addEventListener('keydown', onCtxKeydown)
  void loadEditorTargets()
  await nextTick()
  const el = ctxMenuEl.value
  if (!el || !ctxMenu.value.show) return
  const rect = el.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const fit = clampMenu(e.clientX, e.clientY, rect.width, rect.height)
  if (fit.x !== ctxMenu.value.x || fit.y !== ctxMenu.value.y) {
    ctxMenu.value = { ...ctxMenu.value, x: fit.x, y: fit.y }
  }
}

function closeCtxMenu(): void {
  window.removeEventListener('keydown', onCtxKeydown)
  ctxMenu.value = { ...ctxMenu.value, show: false, path: '' }
}

function onCtxKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCtxMenu()
}

function ctxOpenInEditor(editorId?: string): void {
  void window.agentTeam?.openFolderInEditor(ctxMenu.value.path, editorId)
  closeCtxMenu()
}

function ctxReveal(): void {
  void window.agentTeam?.revealPath(ctxMenu.value.path)
  closeCtxMenu()
}

function ctxCopyPath(): void {
  void navigator.clipboard?.writeText(ctxMenu.value.path)
  closeCtxMenu()
}
</script>

<template>
  <div class="welcome-overlay" :class="{ 'welcome-overlay--modal': dismissible }" @click.self="dismiss">
    <div class="welcome-card">
      <header class="w-head">
        <button v-if="dismissible" class="w-close" :aria-label="$t('action.close')" @click="dismiss">✕</button>
        <h1>Navide</h1>
        <p class="tagline">{{ $t('label.tagline') }}</p>
      </header>

      <section class="w-open">
        <h2>{{ $t('label.open-workspace') }}</h2>
        <div class="w-open-btns">
          <button class="primary" :disabled="picking" @click="browse">
            {{ picking ? '…' : $t('action.browse') }}
          </button>
          <button class="ghost" :disabled="creating" @click="newWorkspace">
            {{ creating ? '…' : $t('action.new-workspace') }}
          </button>
          <button class="ghost" @click="openHome">
            {{ $t('action.open-home') }}
          </button>
        </div>
      </section>

      <section class="w-recent">
        <h2>{{ $t('label.recent') }}</h2>

        <p v-if="error" class="w-error">{{ error }}</p>

        <ul v-if="ordered.length" class="recent-list">
          <li
            v-for="item in ordered"
            :key="item.path"
            class="recent-item"
            :class="{ stale: !item.exists }"
            @click="openWorkspace(item.path)"
            @contextmenu="openCtxMenu($event, item)"
          >
            <button
              class="pin"
              :class="{ on: item.pinned }"
              :title="item.pinned ? $t('label.unpin') : $t('label.pin')"
              @click="togglePin(item, $event)"
            >
              {{ item.pinned ? '★' : '☆' }}
            </button>
            <div class="r-body">
              <div class="r-top">
                <span class="r-name">{{ item.name }}</span>
                <span v-if="isOpenElsewhere(item.path)" class="r-open" :title="$t('label.already-open')">{{ $t('label.already-open') }}</span>
                <span
                  v-if="stateBadge(item.last_known_state)"
                  class="r-badge"
                  :class="stateBadge(item.last_known_state)?.cls"
                >
                  {{ stateBadge(item.last_known_state)?.icon }}
                  {{ stateBadge(item.last_known_state)?.label }}
                </span>
                <span v-if="!item.exists" class="r-missing" title="Folder not found">{{ $t('label.missing') }}</span>
                <span class="r-time">{{ timeAgo(item.last_opened_at) }}</span>
              </div>
              <div class="r-path">{{ item.path }}</div>
              <div v-if="item.last_known_task" class="r-task">"{{ item.last_known_task }}"</div>
            </div>
            <button
              v-if="!isOpenElsewhere(item.path)"
              class="r-delete"
              :title="$t('action.remove-from-history')"
              @click="removeItem(item, $event)"
            >✕</button>
          </li>
        </ul>

        <p v-else-if="loaded" class="w-empty" v-html="$t('label.no-recent-workspaces')"></p>
      </section>

      <footer class="w-foot">
        <button class="link" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
      </footer>
    </div>

    <template v-if="ctxMenu.show">
      <div class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <div ref="ctxMenuEl" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpenInEditor()">{{ $t('action.open-in-default-editor') }}</button>
        <div class="menu-item has-sub">
          <span>{{ $t('action.open-with') }}</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button
              v-for="target in editorTargets"
              :key="target.id"
              class="menu-item"
              @click="ctxOpenInEditor(target.id)"
            >{{ $t(target.labelKey) }}</button>
          </div>
        </div>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxReveal">{{ $t('action.reveal-in-finder') }}</button>
        <button class="menu-item" @click="ctxCopyPath">{{ $t('action.copy-path') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.welcome-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-inset);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: calc(var(--z-modal) + 110);
}
/* Opened over a working window, so the app stays visible behind it — the
   startup screen's opaque inset would read as "the workspace closed". */
.welcome-overlay--modal { background: rgb(0 0 0 / 45%); }
.w-head { position: relative; }
.w-close {
  position: absolute;
  top: 0;
  right: 0;
  border: none;
  background: none;
  padding: 2px 4px;
  cursor: pointer;
  font-size: var(--font-sm);
  line-height: 1;
  color: var(--text-muted);
}
.w-close:hover { color: var(--text-bright); }
.welcome-card {
  width: 560px;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 28px 32px;
  color: var(--text-bright);
  box-shadow: 0 16px 48px var(--shadow-overlay);
}
.w-head h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.5px;
}
.tagline {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.w-open,
.w-recent {
  margin-top: 24px;
}
.w-open h2,
.w-recent h2 {
  font-size: var(--font-sm);
  color: var(--text-secondary);
  font-weight: 600;
  margin: 0 0 10px;
}
.w-open-btns {
  display: flex;
  gap: 10px;
}
button.primary {
  background: var(--success-emphasis);
  border: 1px solid var(--success-strong);
  color: var(--text-on-emphasis);
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: var(--font-sm);
}
button.primary:hover:not(:disabled) {
  background: var(--success-strong);
}
button.ghost {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: var(--font-sm);
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-subtle);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recent-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}
.recent-item:hover {
  background: var(--bg-subtle);
  border-color: var(--border-default);
}
.recent-item.stale {
  opacity: 0.55;
}
.pin {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1.4;
  padding: 0;
}
.pin.on {
  color: var(--attention-fg);
}
.r-body {
  flex: 1;
  min-width: 0;
}
.r-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.r-name {
  font-weight: 600;
  font-size: var(--font-sm);
}
.r-badge {
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.r-badge.completed {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.r-badge.running {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.r-badge.aborted {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.r-missing {
  font-size: var(--font-3xs);
  color: var(--danger-fg);
}
.r-open {
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border-radius: 10px;
  color: var(--success-fg);
  background: var(--success-subtle);
}
.r-time {
  margin-left: auto;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.r-path {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-task {
  font-size: var(--font-xs);
  color: var(--text-primary);
  margin-top: 2px;
}
.r-delete {
  background: transparent;
  border: none;
  color: transparent;
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 2px 4px;
  border-radius: 4px;
  flex-shrink: 0;
  align-self: center;
}
.recent-item:hover .r-delete {
  color: var(--text-muted);
}
.r-delete:hover {
  color: var(--danger-fg) !important;
  background: var(--bg-muted);
}
.w-empty {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.6;
}
.w-error {
  color: var(--danger-fg);
  font-size: var(--font-xs);
}
.w-foot {
  margin-top: 24px;
  border-top: 1px solid var(--border-muted);
  padding-top: 14px;
}
button.link {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 0;
}
button.link:hover {
  color: var(--text-bright);
}
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.ctx-menu {
  position: fixed;
  z-index: 41;
  min-width: 180px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 8px 24px var(--shadow-overlay);
  padding: 4px;
}
.ctx-menu .menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.ctx-menu .menu-item:hover {
  background: var(--bg-active);
}
.ctx-menu .menu-sep {
  height: 1px;
  background: var(--border-muted);
  margin: 4px 0;
}
/* Hover submenu (Open with ▸) */
.ctx-menu .menu-item.has-sub {
  position: relative;
  justify-content: space-between;
  gap: 12px;
}
.ctx-menu .sub-caret {
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.ctx-menu .ctx-submenu {
  position: absolute;
  top: -5px;
  left: 100%;
  margin-left: 2px;
  display: none;
  min-width: 180px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 8px 24px var(--shadow-overlay);
}
.ctx-menu .menu-item.has-sub:hover .ctx-submenu {
  display: block;
}
</style>
