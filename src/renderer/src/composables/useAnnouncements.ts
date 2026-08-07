import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import { i18n } from '../i18n'
import { settingsGet, settingsSet } from '../lib/settings'
import { WHATS_NEW, cmpSemver, pickText } from '../lib/whatsNew'
import type { UpdateState } from '../../../shared/updater'

/**
 * Announcements centre — the status-bar feed of version news.
 *
 * Two sources, normalised into one list: the curated release notes in
 * whatsNew.ts (everything up to the running version) and the live updater
 * state (a pending update, or a run of failed background checks). Read state is
 * a bounded id set in ui_settings, so it follows the user across windows.
 *
 * Module-level singleton state, like useNotify — the status-bar item and the
 * popover read the same feed without prop drilling.
 */

export type AnnouncementKind = 'release' | 'update'
/** The button an update row offers, when its status affords one. */
export type AnnouncementAction = 'download' | 'install'

export interface Announcement {
  /** Stable across renders: `release:<version>`, `update:<version>`, `update-failed`. */
  id: string
  kind: AnnouncementKind
  version?: string
  /** Already localized for the active locale. */
  title: string
  highlights: string[]
  note?: string
  /** Only set where a real timestamp exists — never fabricated. */
  createdAt?: number
  read: boolean
  action?: AnnouncementAction
}

const READ_IDS_KEY = 'agentTeam.announcements.readIds'
/** Keep the persisted set small: ui_settings is one shared 512 KB document. */
const MAX_READ_IDS = 100

const readIds = ref<string[]>([])
/** The live updater state, handed in by App.vue — useUpdater is NOT a singleton
 *  and instantiating it here would add another onStateChanged subscription.
 *  Boxed in an object so the ref isn't unwrapped away by shallowRef's typing. */
const updateSource = shallowRef<{ state: Ref<UpdateState> } | null>(null)
let loaded = false

/** The feed id of a release announcement, so callers elsewhere (the What's New
 *  modal) can mark the same entry read without knowing the id format. */
export function releaseAnnouncementId(version: string): string {
  return `release:${version}`
}

const appVersion = computed(
  () => updateSource.value?.state.value.currentVersion || window.agentTeam?.version || ''
)

function releaseItems(locale: string, current: string): Announcement[] {
  if (!current) return []
  return WHATS_NEW.filter((entry) => cmpSemver(entry.version, current) <= 0)
    .slice()
    .sort((a, b) => cmpSemver(b.version, a.version))
    .map((entry) => ({
      id: releaseAnnouncementId(entry.version),
      kind: 'release' as const,
      version: entry.version,
      title: pickText(entry.title, locale),
      highlights: entry.highlights.map((text) => pickText(text, locale)),
      note: entry.note ? pickText(entry.note, locale) : undefined,
      read: false,
    }))
}

function updateItems(state: UpdateState | null): Announcement[] {
  if (!state) return []
  const t = i18n.global.t
  const items: Announcement[] = []

  // A run of failed background checks rides alongside the status, so it is its
  // own item rather than a variant of the pending-update one.
  const failure = state.lastCheckFailure
  if (failure) {
    const at = Date.parse(failure.at)
    items.push({
      id: 'update-failed',
      kind: 'update',
      title: t('updater.badge-check-failed'),
      highlights: [t('updater.check-failure', { count: failure.count, message: failure.message })],
      createdAt: Number.isNaN(at) ? undefined : at,
      read: false,
    })
  }

  const version = state.availableVersion ?? ''
  let title = ''
  let action: AnnouncementAction | undefined
  switch (state.status) {
    case 'available':
      title = t('updater.available', { version })
      action = 'download'
      break
    case 'downloading':
      title = t('updater.downloading', { percent: state.percent ?? 0 })
      break
    case 'downloaded':
      title = t('updater.downloaded')
      action = 'install'
      break
    case 'installing':
      title = t('updater.restarting')
      break
    case 'error':
      title = t('updater.error', { message: state.message ?? '' })
      break
    default:
      break
  }
  if (title) {
    const checkedAt = state.checkedAt ? Date.parse(state.checkedAt) : NaN
    items.push({
      id: version ? `update:${version}` : 'update-error',
      kind: 'update',
      version: version || undefined,
      title,
      highlights: state.releaseNotes ? [state.releaseNotes] : [],
      note: state.quitInstallArmed ? t('updater.downloaded-on-quit') : undefined,
      createdAt: Number.isNaN(checkedAt) ? undefined : checkedAt,
      read: false,
      action,
    })
  }
  return items
}

const items: ComputedRef<Announcement[]> = computed(() => {
  // Read the locale so a language switch re-localizes the whole feed.
  const locale = i18n.global.locale.value
  const seen = new Set(readIds.value)
  const merged = [
    ...updateItems(updateSource.value?.state.value ?? null),
    ...releaseItems(locale, appVersion.value),
  ]
  return merged.map((item) => ({ ...item, read: seen.has(item.id) }))
})

const unreadCount = computed(() => items.value.filter((item) => !item.read).length)

function persist(ids: string[]): void {
  readIds.value = ids.slice(-MAX_READ_IDS)
  settingsSet(READ_IDS_KEY, readIds.value)
}

function markRead(id: string): void {
  if (readIds.value.includes(id)) return
  persist([...readIds.value, id])
}

function markAllRead(): void {
  const unread = items.value.filter((item) => !item.read).map((item) => item.id)
  if (unread.length === 0) return
  // persist() truncates to the TAIL, so append oldest-first: `items` is
  // newest-first, and a batch bigger than MAX_READ_IDS would otherwise drop the
  // newest ids and resurrect them as unread.
  persist([...readIds.value, ...unread.reverse()])
}

/** Hand the live updater state in (call once, right after useUpdater()). */
function setUpdateSource(state: Ref<UpdateState>): void {
  updateSource.value = { state }
}

function load(): void {
  if (loaded) return
  loaded = true
  const stored = settingsGet<unknown>(READ_IDS_KEY, null)
  if (Array.isArray(stored)) {
    readIds.value = stored.filter((id): id is string => typeof id === 'string')
    return
  }
  // No stored set at all — a fresh install. Baseline everything on screen as
  // read (like App.vue does for the What's New watermark) so a new user isn't
  // greeted by every historical release note at once.
  persist(items.value.map((item) => item.id).reverse())
}

export function useAnnouncements() {
  load()
  return {
    items,
    unreadCount,
    markRead,
    markAllRead,
    setUpdateSource,
  }
}
