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
    version: '0.1.72',
    title: {
      'zh-TW': '獨立視窗 AI 面板整合與極速終端回應',
      'en-US': 'Embedded AI chat in standalone windows & ultra-fast terminal response',
    },
    highlights: [
      {
        'zh-TW':
          '獨立視窗內建 AI Chat 面板：Git 與 Plan 獨立視窗全新整合 AI Chat 右側面板，並支援直接拖曳（Drag & Drop）Git 變更檔案列至終端機。',
        'en-US':
          'Embedded AI Chat in standalone windows: Git & Plan windows now feature an embedded AI Chat panel and support dragging file rows to terminals.',
      },
      {
        'zh-TW':
          'Git 視窗 Editorial Calm 介面重構：採用雜誌感簡潔視覺設計與折疊卡片排版，大幅提升工作區狀態與 Diff 閱讀舒適度。',
        'en-US':
          'Git window Editorial Calm redesign: fresh magazine-style layout and collapsible cards for cleaner working tree and diff reading.',
      },
      {
        'zh-TW':
          '終端機打字延遲大幅降低：優化 CLI 高速輸出時的輸入快取機制，打字回應與動態渲染更加順暢無卡頓。',
        'en-US':
          'Reduced typing latency: optimized input caching during heavy CLI streaming for smoother typing and dynamic rendering.',
      },
    ],
  },
  {
    version: '0.1.71',
    title: {
      'zh-TW': '終端隱藏頁籤渲染優化與 AI Chat CLI 引擎',
      'en-US': 'Hidden terminal tab rendering & CLI-driven AI chat',
    },
    highlights: [
      {
        'zh-TW':
          '隱藏頁籤終端尺寸快取：快取並持久化 Terminal 最佳行列尺寸，解決背景或開機還原時啟動 PTY 輸出繪製過窄且無法拉寬的問題。',
        'en-US':
          'Hidden terminal dimension caching: persists terminal dimensions so background PTYs start at realistic layout widths instead of narrow defaults.',
      },
      {
        'zh-TW':
          'AI Chat 改由 CLI 驅動：AI 聊天視窗改由底層 CLI Engine 驅動，大幅提升回應速度、並能自動回收僵死或孤兒 subprocess。',
        'en-US':
          'CLI-driven AI Chat: AI chat frontend now runs on the native CLI engine for higher stability, automatic orphan cleanup, and better resilience.',
      },
      {
        'zh-TW':
          'Git 獨立視窗與體驗改善：重構 Git 獨立視窗側邊欄為折疊卡片介面，修復 Cmd+C 終端複製、右鍵選取菜單與 Mouse-tracking 拖曳選取。',
        'en-US':
          'Git window & terminal UX: reworked Git window sidebar into collapsible cards, fixed Cmd+C terminal copying, context menu, and mouse text selection.',
      },
    ],
  },
  {
    version: '0.1.70',
    title: {
      'zh-TW': '多帳號憑證管理與系統穩定度提升',
      'en-US': 'Multi-account credentials & stability improvements',
    },
    highlights: [
      {
        'zh-TW':
          '多帳號憑證整合：CLI 憑證統一保管於真實 Home 目錄，支援帳號快速 Swap 切換，Codex 登入憑證自動提升至全域共享。',
        'en-US':
          'Unified multi-account credentials: CLI auth files now live in your real home directory with instant swap switching, and Codex logins auto-promote to shared auth.',
      },
      {
        'zh-TW':
          'CLI 重建安全防護：針對執行中的 CLI 按下 Rebuild/重構時增加二次確認彈窗，防止誤觸致使工作中 Task 中斷。',
        'en-US':
          'Safer CLI rebuilds: a confirmation dialog now protects running CLIs from accidental rebuilds while tasks are active.',
      },
      {
        'zh-TW':
          '獨立 Git 視窗與新手安裝優化：修復獨立 Git 視窗追蹤細節，並確保全新安裝時環境依賴檢測與自動安裝順暢完成。',
        'en-US':
          'Git window & onboarding fixes: refined follow-up interactions in standalone Git windows and hardened onboarding dependency setup.',
      },
    ],
  },
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
