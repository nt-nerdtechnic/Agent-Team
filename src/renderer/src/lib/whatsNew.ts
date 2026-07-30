// Reusable "What's New" announcements.
//
// When the app starts running a version that has an entry here — and the user
// hasn't seen that version's announcement yet — App.vue shows WhatsNewModal
// once. To announce a future release (a rename, a headline feature, a migration
// note, …), just add an entry: the modal machinery handles showing it a single
// time, keyed on the app version.
//
// Content lives here (not in the i18n JSON) so an announcement is one self
// contained edit. Each field carries both supported locales; pickText falls
// back to the default locale (zh-TW) for anything missing.

export type WhatsNewText = {
  'zh-TW': string
  'en-US': string
}

export interface WhatsNewEntry {
  /** App version this announcement belongs to, e.g. '0.1.65'. */
  version: string
  title: WhatsNewText
  /** Bullet highlights shown in order. */
  highlights: WhatsNewText[]
  /** Optional footer note, e.g. an action the user should take. */
  note?: WhatsNewText
}

// Chrome labels (header + dismiss button), kept here so the whole announcement
// is editable in one place without touching the i18n JSON.
export const WHATS_NEW_CHROME = {
  header: { 'zh-TW': '新版更新', 'en-US': 'What’s New' } as WhatsNewText,
  dismiss: { 'zh-TW': '知道了', 'en-US': 'Got it' } as WhatsNewText,
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '0.1.68',
    title: {
      'zh-TW': '儲存架構升級：更快、更可靠',
      'en-US': 'Storage upgrade: faster and more reliable',
    },
    highlights: [
      {
        'zh-TW':
          '你的設定、token 用量與工作區資料已自動搬入資料庫（SQLite）。搬移在首次啟動時自動完成，所有資料原樣保留，無需任何操作。',
        'en-US':
          'Your settings, token usage and workspace data now live in a database (SQLite). The move happens automatically on first launch — everything is preserved, nothing to do.',
      },
      {
        'zh-TW':
          '大幅降低磁碟寫入：token 記帳從每 10 秒重寫一份大檔，改為只寫入變動的部分（約 30 倍減少）。',
        'en-US':
          'Far less disk churn: token accounting now writes only what changed instead of rewriting a large file every 10 seconds (~30x less I/O).',
      },
      {
        'zh-TW':
          '舊的 JSON 檔案會保留為 *.migrated-v1 備份，不會被刪除。',
        'en-US':
          'Your old JSON files are kept as *.migrated-v1 backups — nothing is deleted.',
      },
    ],
    note: {
      'zh-TW':
        '注意：若你之後改回安裝舊版本，App 會像全新安裝一樣看不到既有資料（資料並未消失——把 *.migrated-v1 檔案改回原名即可還原）。',
      'en-US':
        'Note: if you later downgrade to an older version, the app will look freshly installed (your data is not lost — rename the *.migrated-v1 files back to restore it).',
    },
  },
  {
    version: '0.1.65',
    title: {
      'zh-TW': '我們更名為「Navide」',
      'en-US': 'We’re now “Navide”',
    },
    highlights: [
      {
        'zh-TW':
          '應用程式已從「Navide (Agent-Team)」更名為「Navide」。這是同一個 App，你的資料與設定都不受影響。',
        'en-US':
          'The app was renamed from “Navide (Agent-Team)” to “Navide”. It’s the same app — your data and settings are untouched.',
      },
      {
        'zh-TW': 'macOS 自動更新已修復（先前一個打包問題會讓更新失敗）。',
        'en-US':
          'macOS auto-update now installs correctly — a packaging issue that broke updates has been fixed.',
      },
    ],
    note: {
      'zh-TW':
        '若這次更新後 App 沒有自動重新開啟，請從「應用程式」再開一次即可；之後的更新會自動重啟。',
      'en-US':
        'If the app didn’t reopen by itself after this update, just launch it again from Applications — future updates relaunch automatically.',
    },
  },
]

/** The announcement authored for a specific version, if any. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((entry) => entry.version === version)
}

/** Compare two X.Y.Z versions. An empty/blank string sorts as the oldest. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The announcement to show on startup: the newest entry the user hasn't seen
 * yet whose version has actually shipped (i.e. seenVersion < entry.version <=
 * currentVersion). This lets an announcement be authored under the version the
 * change happened in — it still fires for anyone whose update jumps past it,
 * even though the module itself only ships from the next release on. Returns
 * null when there is nothing to show.
 */
export function pickWhatsNew(
  currentVersion: string,
  seenVersion: string,
): WhatsNewEntry | null {
  if (!currentVersion) return null
  const unseen = WHATS_NEW.filter(
    (entry) =>
      cmpSemver(entry.version, seenVersion) > 0 &&
      cmpSemver(entry.version, currentVersion) <= 0,
  )
  if (unseen.length === 0) return null
  return unseen.reduce((newest, entry) =>
    cmpSemver(entry.version, newest.version) > 0 ? entry : newest,
  )
}

/** Resolve localized text, falling back to the default locale then en-US. */
export function pickText(text: WhatsNewText, locale: string): string {
  return (
    (text as Record<string, string>)[locale] ?? text['zh-TW'] ?? text['en-US'] ?? ''
  )
}
