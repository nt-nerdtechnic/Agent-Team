// Reusable "What's New" announcements.
//
// When the app starts running a version that has an entry here — and the user
// hasn't seen that version's announcement yet — App.vue shows WhatsNewModal
// once. To announce a future release (a rename, a headline feature, a migration
// note, …), just add an entry: the modal machinery handles showing it a single
// time, keyed on the app version. Prepend a NEW entry — retitling the one on
// top loses the release it belonged to (v0.1.78 was lost that way), which the
// no-gaps test in whatsNew.test.ts now catches.
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
    version: '0.1.89',
    title: {
      'zh-TW': '官方 Brand 視覺升級、Git 多倉庫選擇器、靜音閒置回收與品質守衛',
      'en-US': 'Official Brand Assets, Git Multi-Repo Selector, Quiet Idle Sweep & Quality Gates',
    },
    highlights: [
      {
        'zh-TW':
          '官方 Brand Assets 視覺升級：全新深淺色 Logo、向量 SVG、macOS Canvas 規範應用程式圖標與多尺寸 Web Favicon。',
        'en-US':
          'Official Brand Assets: new light/dark logos, vector SVGs, macOS canvas icons, and multi-size web favicons.',
      },
      {
        'zh-TW':
          'Git 多倉庫選擇器：工作區包含多個 Git 倉庫時，Git 面板支援下拉快速切換當前焦點儲存庫。',
        'en-US':
          'Git Multi-Repo Selector: easily switch between repositories in multi-repository workspaces directly within the Git pane.',
      },
      {
        'zh-TW':
          '定時閒置回收靜音：背景定時掃描並回收長時間閒置的 CLI 終端時僅記錄於日誌，不再彈出打擾 Toast 提示。',
        'en-US':
          'Quiet Idle Sweep: background timed idle sweeps log quietly without popping up disruptive toast notifications.',
      },
      {
        'zh-TW':
          'WebSocket 指數退避重連：WebSocket 連線中斷時自動依指數退避策略重試連線（1.5s 至 30s）。',
        'en-US':
          'WebSocket Exponential Reconnect: automatic reconnection with exponential backoff on dropped WebSocket connections.',
      },
      {
        'zh-TW':
          'Ruff 靜態分析與發布守衛：發布流程正式引入 Ruff ASYNC 與 F821 規則檢查，嚴防未定義變數與 Event Loop 阻塞。',
        'en-US':
          'Release Quality Gates: integrates Ruff ASYNC and F821 checks into release gates to guard against unhandled imports and loop stalls.',
      },
    ],
  },
  {
    version: '0.1.88',
    title: {
      'zh-TW': '後端 Event Loop 延遲監控、視窗最小尺寸防護與 Kimi 延遲優化',
      'en-US': 'Event-Loop Latency Watchdog, Window Minimum Dimensions & Kimi TUI Optimization',
    },
    highlights: [
      {
        'zh-TW':
          'Event Loop 延遲監控看門狗：每秒探測後端排程延遲，及時發現並記錄潛在的長耗時操作。',
        'en-US':
          'Event-Loop Latency Watchdog: monitors and logs backend scheduling latency to catch blocking operations early.',
      },
      {
        'zh-TW':
          '視窗最小尺寸限制：為桌面視窗設定合理的最小寬高防護，避免過度縮小導致介面擠壓。',
        'en-US':
          'Window Minimum Dimensions: enforces minimum window bounds to prevent layout distortion when resized small.',
      },
      {
        'zh-TW':
          'Kimi CLI 退出鍵瞬間響應：預設配置 escape sequence 延遲時間，消除 Kimi TUI 介面下的選單切換延遲。',
        'en-US':
          'Kimi TUI Esc Sequence Fix: configures escape timeouts so menu and navigation keys respond immediately.',
      },
      {
        'zh-TW':
          'Git 倉庫受限掃描時間：大型或網路檔案系統上的倉庫探索加入時間預算，不阻塞後端事件循環。',
        'en-US':
          'Bounded Git Discovery: bounds filesystem repository discovery scans with a timeout budget to keep the backend responsive.',
      },
    ],
  },
  {
    version: '0.1.87',
    title: {
      'zh-TW': '工作區 Slot 佈局、檔案預覽面板、Process 記憶體探針與閒置回收',
      'en-US': 'Workbench Layout Model, File Previews, Process Memory Probes & Idle Reclaim',
    },
    highlights: [
      {
        'zh-TW':
          '工作區 Slot 自訂佈局：支援左/右/底側欄自訂槽位與快捷鍵折疊切換。',
        'en-US':
          'Workbench Layout Model: custom slot containers across left, right, and bottom panels with collapse shortcuts.',
      },
      {
        'zh-TW':
          '檔案與產物預覽面板：支援 Markdown、HTML 與程式碼片段即時預覽，以及 Diff 唯讀檢視。',
        'en-US':
          'File & Artifact Previews: inline rendering for Markdown, HTML, code snippets, and Diff views.',
      },
      {
        'zh-TW':
          '後端 Process 記憶體探針：狀態列即時顯示後端與終端記憶體佔用與 Token 詳細統計。',
        'en-US':
          'Process Memory Telemetry: status bar popovers with real-time memory usage and token usage breakdowns.',
      },
      {
        'zh-TW':
          '終端長時間閒置回收：自動回收長時間無操作的 CLI 面板釋放系統記憶體，支援點擊一鍵恢復。',
        'en-US':
          'Terminal Idle Reclaim: automatically reclaims memory from long-idle CLI processes with one-click restore.',
      },
    ],
  },
  {
    version: '0.1.86',
    title: {
      'zh-TW': '階段分頁狀態燈號、⌘W 彈窗關閉優化、剪貼簿貼上防禦與 Dev 正式版隔離',
      'en-US': 'Stage Tab Status Dots, ⌘W Modal Close, Paste Timeout Defense & Dev/Prod Isolation',
    },
    highlights: [
      {
        'zh-TW':
          'StageTabBar 狀態燈號：頂部階段標籤新增彩色動態狀態燈號與 Tooltip，即時匯總該階段所有 Agent 的運行、提問等待或錯誤狀態。',
        'en-US':
          'Stage Tab Status Dots: stage tabs show live color status dots and tooltips summarizing running, awaiting question, or error states across all agents in that stage.',
      },
      {
        'zh-TW':
          '⌘W 彈窗關閉與防誤觸確認：按 ⌘W 優先關閉最上層 Modal 彈窗；關閉閒置 CLI 面板前新增防誤觸確認與「不再詢問」選項。',
        'en-US':
          '⌘W Modal Close & Pane Protection: ⌘W prioritizes closing open modals; closing idle panes includes a confirmation dialog with a "Don\'t ask again" option.',
      },
      {
        'zh-TW':
          '剪貼簿貼上防禦與逾時延長：延長 Paste ACK 逾時至 60 秒，避免 Agent 高負載輸出時誤報貼上遺失，精準區分逾時與真實傳輸中斷。',
        'en-US':
          'Paste Timeout Defense: extends paste ACK timeout to 60s to prevent false paste failure warnings during heavy terminal bursts.',
      },
      {
        'zh-TW':
          'Dev 與正式版全域隔離：Dev 模式主動保護正式版全域 Hooks 與日誌流，避免多實例搶佔端口與背景卡死。',
        'en-US':
          'Dev & Production Isolation: dev mode preserves production hooks and bounds startup scans so dev and production can run side-by-side without interference.',
      },
      {
        'zh-TW':
          'Manifest v2 外掛架構升級：支援 Combined 前後端外掛規範、發布者信任驗證、Shell Broker 與能力授權機制。',
        'en-US':
          'Manifest v2 Plugin Architecture: full support for combined frontend/backend plugins, publisher trust validation, and Shell Broker capability grants.',
      },
    ],
  },
  {
    version: '0.1.85',
    title: {
      'zh-TW': '外掛平台 Manifest v2 升級、發布者信任驗證與 Shell Broker 安全授權',
      'en-US': 'Manifest v2 Plugin Platform, Publisher Trust & Shell Broker Capability Grants',
    },
    highlights: [
      {
        'zh-TW':
          'Manifest v2 外掛架構：支援前後端組合（Combined）與後端專用外掛規範，外掛與主程式版本嚴格解耦。',
        'en-US':
          'Manifest v2 Plugin Platform: supports combined frontend/backend plugins and backend-only manifests decoupled from core versions.',
      },
      {
        'zh-TW':
          '發布者信任與能力授權：引進外掛發布者金鑰簽署與 Shell Broker 權限授權，確保外掛環境執行安全。',
        'en-US':
          'Publisher Trust & Capability Grants: introduces publisher signature checks and Shell Broker capability grants for hermetic plugin execution.',
      },
    ],
  },
  {
    version: '0.1.84',
    title: {
      'zh-TW': 'CLI 互傳訊息：投遞失敗回報、Claude Stop hook 直送、打字時暫緩投遞',
      'en-US': 'Inter-CLI Messaging: Delivery-Failure Notices, Claude Stop-Hook Hand-Over & Typing Hold',
    },
    highlights: [
      {
        'zh-TW':
          '投遞失敗回報：訊息送不到時，寄件 pane 會收到一則 `[Navide MSG] delivery failed` 系統通知，說明目標與原因。',
        'en-US':
          'Delivery-failure notices: when a message cannot be delivered, the sending pane receives a `[Navide MSG] delivery failed` notice naming the target and the reason.',
      },
      {
        'zh-TW':
          'Claude Stop hook 直送：Claude pane 回合結束時若有訊息在等，會直接經由 Stop hook 交給 agent 當下一步指令，完全不經過輸入框。',
        'en-US':
          'Claude Stop-hook hand-over: a message waiting for a Claude pane is handed to the agent as its next instruction when its turn ends, without ever touching the input box.',
      },
      {
        'zh-TW':
          '打字時暫緩投遞與整段貼上：目標 pane 有人在輸入時訊息會顯示為「輸入中」暫緩，注入一律以 bracketed paste 整段送入，不再打斷你打到一半的提示。',
        'en-US':
          'Typing hold & whole-paste injection: delivery waits while someone is typing in the target pane, and injections land as a single bracketed paste so a half-written prompt is never submitted with them.',
      },
      {
        'zh-TW':
          '訊息種類持久化與系統通知標章：訊息記錄面板會記住每則訊息的種類，系統通知重新載入後仍顯示「系統通知」標章。',
        'en-US':
          'Kind persistence & system-notice badge: the message log remembers each message\'s kind, so system notices keep their "system notice" badge across reloads.',
      },
    ],
  },
  {
    version: '0.1.83',
    title: {
      'zh-TW': '自訂快捷鍵編輯器、多面板批量拖曳與 CLI 提問狀態提示',
      'en-US': 'Custom Keybindings Editor, Multi-Pane Batch Dragging & QUESTION Status Badge',
    },
    highlights: [
      {
        'zh-TW':
          '自訂快捷鍵編輯器：重構全域快捷鍵系統並提供 Keybindings 編輯器，支援按鍵錄製、衝突偵測與一鍵恢復預設值。',
        'en-US':
          'Custom Keybindings Editor: overhauled keybinding engine with an interactive editor supporting live key recording, conflict detection, and default resets.',
      },
      {
        'zh-TW':
          '多面板批量拖曳與 Drop 貼上：支援 Shift 多選面板批量拖曳與 Ghost 懸浮圖示，可一次性拖入終端機貼上批量 @mention 標籤。',
        'en-US':
          'Multi-pane batch dragging & dropping: Shift-select multiple agent panes to drag with a ghost image and drop all @mention tags into terminals at once.',
      },
      {
        'zh-TW':
          'CLI 提問 QUESTION 標章與通訊優化：Agent 在終端等待提問回答時自動切換為橙色 QUESTION 標章，並優化 Agent 跨工作區通訊與訊息日誌持久化。',
        'en-US':
          'QUESTION badge & agent messaging: displays an orange QUESTION badge when an agent awaits input, with persistent agent message logging across workspaces.',
      },
    ],
  },
  {
    version: '0.1.82',
    title: {
      'zh-TW': 'Agents 側邊欄分頁獨立、未註冊帳號自動歸併與 Git Unstage 容錯優化',
      'en-US': 'Dedicated Agents sidebar tab, automatic account registration/deduplication & resilient Git unstage',
    },
    highlights: [
      {
        'zh-TW':
          'Agents 側邊欄分頁獨立：將代理人列表獨立為標籤分頁（⌘1 Agents、⌘2 Pipeline、⌘3 Explorer、⌘4 Git、⌘5 Plans），享有全高度獨佔捲動空間。',
        'en-US':
          'Dedicated Agents sidebar tab: split the agents list into its own tab (⌘1 Agents, ⌘2 Pipeline, ⌘3 Explorer, ⌘4 Git, ⌘5 Plans) with full-height scrollable space.',
      },
      {
        'zh-TW':
          '帳號自動註冊與重複去重：偵測到本機外部 CLI 登入自動建立 Profile 進行管理，並對同信箱多重登入自動去重歸併，保持選單簡潔。',
        'en-US':
          'Automatic account registration & deduplication: automatically creates profiles for new CLI logins and folds duplicate same-email credentials into single profiles.',
      },
      {
        'zh-TW':
          'Plan MCP 鑑權與 Git Unstage 容錯：Plan MCP 服務加入 Token 安全鑑權；Git 面板取消暫存（Unstage）自動過濾過期路徑並進行容錯重試。',
        'en-US':
          'Plan MCP auth & resilient Git unstage: added token security for Plan MCP server and auto-filtered stale pathspec retries on Git unstage actions.',
      },
    ],
  },
  {
    version: '0.1.81',
    title: {
      'zh-TW': '外部 CLI 憑證自動監控同步、Terminal 滾動無痕狀態與 Meta Muse Code Agent 支援',
      'en-US': 'Automatic credential sync watcher, smooth terminal scroll activity & Meta Muse Code CLI support',
    },
    highlights: [
      {
        'zh-TW':
          '外部 CLI 憑證自動監控同步：新增背景 Credential Watcher 服務，本機外部 CLI 登入或 Token 變更時自動同步寫入 Vault 快取與帳號切換面板。',
        'en-US':
          'Automatic credential sync watcher: added a background Credential Watcher service that syncs external CLI login changes into the profile vault and account switcher instantly.',
      },
      {
        'zh-TW':
          'Terminal 滾動活動時間繼承：優化終端機滾動狀態，長滾動期間活動時間戳記自動繼承，防止查看歷史紀錄時 RUNNING 狀態標籤誤閃為 IDLE。',
        'en-US':
          'Smooth terminal scroll activity: activity timestamps carry forward during sustained scrolling, preventing the RUNNING badge from flickering to IDLE while browsing history.',
      },
      {
        'zh-TW':
          'Meta Muse Code Agent 支援：新增對 Meta Muse Code CLI Agent 的選單支援、啟動與安裝檢測，並完備 CLI Vendor 開發手冊。',
        'en-US':
          'Meta Muse Code Agent support: added menu options, spawn detection, and installer checks for the Meta Muse Code CLI agent.',
      },
    ],
  },
  {
    version: '0.1.80',
    title: {
      'zh-TW': 'LLM 智慧 Pane 命名、Copilot/Qwen Hooks 路由與 WebGL 終端加速',
      'en-US': 'LLM-assisted Pane Naming, Copilot/Qwen Hooks & WebGL Terminal Acceleration',
    },
    highlights: [
      {
        'zh-TW':
          'LLM 智慧標題命名與平滑升級：首回合對話完成後自動請求本地模型生成高適配性 Pane 標題，並在不干擾使用者自訂命名的前提下平滑升級面板名稱。',
        'en-US':
          'LLM-assisted pane naming: automatically generates relevant pane titles using local models after the first turn and smoothly upgrades panel labels without overwriting custom renames.',
      },
      {
        'zh-TW':
          'Copilot / Qwen Hooks 路由與 Plan MCP 隔離：新增 Copilot 與 Qwen CLI 專屬 Hook 路由 Endpoint；Plan MCP Server 支援獨立目錄隔離與權限保護。',
        'en-US':
          'Copilot/Qwen CLI hooks & Plan MCP isolation: added dedicated hook endpoint routes for Copilot and Qwen CLI; isolated Plan MCP server homes with permission security.',
      },
      {
        'zh-TW':
          'WebGL 終端渲染加速與輸入緩衝：Terminal 支援 WebGL 硬體加速渲染，並新增 prepareGate 輸入緩衝防護，防止啟動準備階段丟失輸入按鍵。',
        'en-US':
          'WebGL terminal acceleration & input buffering: enabled WebGL hardware-accelerated rendering in Terminal with prepareGate input buffering during pane startup.',
      },
    ],
  },
  {
    version: '0.1.79',
    title: {
      'zh-TW': '剪貼簿圖片貼上轉檔、拖曳路徑轉義優化與 Agent 總覽詳情面板',
      'en-US': 'Clipboard image-to-file paste, escaped drop paths & Agent Overview panel',
    },
    highlights: [
      {
        'zh-TW':
          '剪貼簿截圖與拖曳路徑轉義：⌘V 貼上剪貼簿截圖自動寫入實體檔（`userData/dropped-files/`）；拖曳檔案自動使用斜線轉義格式，便於 CLI Agent 直接掃描識別。',
        'en-US':
          'Clipboard screenshot paste & escaped drop paths: ⌘V pasting a screenshot saves a real image file under `userData/dropped-files/`; dragged paths use backslash escaping for instant CLI agent scanning.',
      },
      {
        'zh-TW':
          'Agent 狀態總覽與狀態列面板互斥：新增 Agent 總覽面板 (`AgentOverviewPanel`) 與時間詳情面板 (`ClockPanel`)，狀態列 Popover 具備互斥開啟機制，且 UsageBadge 支援 Esc/Blur 自動關閉防護。',
        'en-US':
          'Agent Overview & status-bar popover management: added AgentOverviewPanel and ClockPanel, mutually exclusive status-bar popovers, and Esc/blur auto-dismissal for UsageBadge.',
      },
      {
        'zh-TW':
          '對話記錄保護與重連 Session 標題繼承：修復從 Claude/Grok 環境啟動 Navide 時對話紀錄遺失問題，並在恢復舊 Session 時自動繼承面板 `auto_name` 標籤。',
        'en-US':
          'Transcript protection & session auto-name inheritance: fixed transcript loss when launching inside Claude/Grok environments, and carried `auto_name` labels on session resumes.',
      },
    ],
  },
  {
    version: '0.1.78',
    title: {
      'zh-TW': '對話記錄遺失修復、跨工作區訊息持久化與 CLI 後端一家一檔重構',
      'en-US': 'Transcript-loss fix, cross-workspace message persistence & per-vendor CLI backend',
    },
    highlights: [
      {
        'zh-TW':
          '修復無聲對話遺失：從 Claude Code 環境裡啟動 Navide 時，pane 會繼承子 session 標記而靜默停寫對話記錄，重啟後 pane 變空白。後端現於啟動時剝除該標記（並防禦 Grok 同型標記），對話記錄保證落盤。',
        'en-US':
          'Fixed silent transcript loss: launching Navide from inside a Claude Code environment made panes inherit a child-session marker and silently stop writing transcripts (blank panes after restart). The backend now strips the marker at startup (plus Grok’s equivalents), so transcripts always persist.',
      },
      {
        'zh-TW':
          '跨工作區 CLI 訊息升級：訊息紀錄改用 SQLite v2 結構持久化、跨工作區外送追蹤與重連補水，並新增狀態列公告面板與版本/時鐘顯示。',
        'en-US':
          'Cross-workspace CLI messaging upgrade: message logs persist in a SQLite v2 schema with outbound tracking and reconnect hydration, plus a new status-bar announcements panel and version/clock chips.',
      },
      {
        'zh-TW':
          '終端效能與架構整併：PTY 生命週期改用獨立執行緒池並一次汲取讀取緩衝（長輸出更順）；後端 CLI 程式碼完成「一家一檔」重構（12 家各自獨立模組 + 統一 registry），新增 CLI 支援從此只需一個檔案。',
        'en-US':
          'Terminal performance & architecture: PTY lifecycle moved to an isolated thread pool with drained reads (smoother long outputs); the CLI backend finished its one-file-per-vendor refactor (12 self-contained vendor modules + a single registry), so adding a CLI now takes one file.',
      },
    ],
  },
  {
    version: '0.1.77',
    title: {
      'zh-TW': '三方 Git 衝突解決面板、預設外部編輯器路由與 DebugModal 診斷視窗',
      'en-US': '3-way Git conflict resolution pane, default external editor routing & DebugModal diagnostics',
    },
    highlights: [
      {
        'zh-TW':
          '三方 Git 衝突視覺化解決與外掛相容：新增 ConflictPane 能直接讀取 Git Index 三方 Merge Stages，高亮標記衝突解決與即時切換，並完全對映給外掛與獨立編輯器視窗。',
        'en-US':
          '3-way Git conflict resolution & plugin compatibility: added ConflictPane with direct Git Index merge stages reading, highlight resolve actions, and full mapping to plugins and standalone windows.',
      },
      {
        'zh-TW':
          '預設外部編輯器與快速鍵操作提升：可選擇 VS Code / Cursor 等為預設外部編輯器並支援開啟專案資料夾；新增 Ctrl+Tab 面板切換與 ⌘⇧L 系統診斷工具 DebugModal。',
        'en-US':
          'Default external editor & keybindings overhaul: choose VS Code or Cursor as your default editor with Open Folder support; added Ctrl+Tab pane cycling and ⌘⇧L DebugModal diagnostics.',
      },
      {
        'zh-TW':
          'CLI 訊息傳遞擴充與自動退避防禦：補齊 Grok、Kimi、Pi、Qwen 的訊息轉發與 Copilot/OpenCode/Kilo 的 Plan MCP 自動掛載，並新增 CLI 停滯 (Stall) 退避與帳號切換快取保護。',
        'en-US':
          'Expanded CLI messaging & stall protection: added turn-text messaging for Grok, Kimi, Pi, Qwen and Plan MCP wiring for Copilot/OpenCode/Kilo, plus CLI stall backoff and parked account cache preservation.',
      },
    ],
  },
  {
    version: '0.1.76',
    title: {
      'zh-TW': 'Claude CLI 用量讀取優化、自動更新 Pipeline 與安穩關機保護',
      'en-US': 'Claude CLI usage panel integration, update pipeline UI & robust app shutdown',
    },
    highlights: [
      {
        'zh-TW':
          'Claude CLI 直接面板讀取與帳號容錯：改由直接驅動 Claude CLI 內建用量面板讀取額度，徹底避免輪詢時 Token 旋轉問題，並能自動偵測被本機清空的失效憑證。',
        'en-US':
          'Claude CLI panel scraping & credential resilience: directly reads usage from Claude CLI without rotating OAuth refresh tokens, with automatic detection of wiped credentials.',
      },
      {
        'zh-TW':
          '自動更新 Pipeline 視覺化與確認還原：新增「檢查 ➔ 下載 ➔ 安裝」三階段進度條，並在更新安裝異常或逾時時自動復原使用者設定的「關閉 App 確認」視窗。',
        'en-US':
          'Visual update pipeline & quit confirmation recovery: added 3-stage update pipeline indicators and restored quit confirmation dialogs when an install fails or times out.',
      },
      {
        'zh-TW':
          '依賴安裝連鎖鏈與 Terminal IME 輸入優化：CLI 安裝對話框支援自動接續連鎖安裝步驟，並優化 Terminal 在輸入法 (IME) 及視窗切換時的 Focus 清除與狀態復原。',
        'en-US':
          'Sequential dependency installer & Terminal IME focus fixes: automated multi-step CLI dependency installation and resolved focus/IME state leakage during terminal pane disposal.',
      },
    ],
  },
  {
    version: '0.1.75',
    title: {
      'zh-TW': '跨工作區 Agent 通訊與定址系統',
      'en-US': 'Cross-workspace Agent addressing & inter-agent messaging',
    },
    highlights: [
      {
        'zh-TW':
          '跨工作區 CLI 定址與 MCP 工具：發布跨工作區通訊註冊表，將 CLI 訊息傳送包裝為 MCP 工具，實現跨視窗、跨工作區 Agent 之間的無縫對話。',
        'en-US':
          'Cross-workspace CLI addressing & MCP tools: introduced a global addressing registry exposing inter-agent messaging as MCP tools for cross-window collaboration.',
      },
      {
        'zh-TW':
          '拖曳面板 @ 定址輸入：支援將遠端視窗或頁籤面板直接拖曳至 "@" 提及輸入框，自動帶入其全區目標位址。',
        'en-US':
          'Drag-to-mention @ addressing: drag any remote pane onto the "@" mention box to automatically insert its fully qualified address.',
      },
      {
        'zh-TW':
          '環境初始化與 Plan 加載強化：改善全新安裝時的依賴安裝順序與錯誤呈現，並優化 Plan 文件讀取的後端等待流程。',
        'en-US':
          'Onboarding & Plan loading fixes: refined dependency bootstrap ordering and plan document loading readiness.',
      },
    ],
  },
  {
    version: '0.1.74',
    title: {
      'zh-TW': 'Tasker 排程引擎與人性化 Cron 表達式文字',
      'en-US': 'Tasker scheduling engine & human-readable cron descriptions',
    },
    highlights: [
      {
        'zh-TW':
          'Cron 定時與循環任務：後端排程服務升級，支援 Cron 表達式定時觸發、單次與循環 Timer、以及 Max Iterations 最大執行次數限制。',
        'en-US':
          'Cron scheduling & recurring tasks: backend execution engine now supports cron expressions, one-shot/recurring timers, and max iteration bounds.',
      },
      {
        'zh-TW':
          'Tasker 控制介面：Tasker 面板新增直覺的 Cron 排程輸入框，動態顯示人性化中文/英文時間描述（例如「每 5 分鐘」）。',
        'en-US':
          'Tasker schedule UI: added intuitive cron controls with real-time human-readable time descriptions (e.g. "Every 5 minutes").',
      },
      {
        'zh-TW':
          '背景 Timer 邊界保護：強化背景排程 Timer 綁定與早期終止機制，確保逾時排程不佔用背景資源。',
        'en-US':
          'Protected background timers: hardened background timer binding and early termination to ensure idle schedules do not leak resources.',
      },
    ],
  },
  {
    version: '0.1.73',
    title: {
      'zh-TW': '模組化 CLI Agent 面板與互動能力全面升級',
      'en-US': 'Modular CLI Agent panel & interactive PTY capabilities',
    },
    highlights: [
      {
        'zh-TW':
          '全新 AiCliDock 面板：全面替換原本純文字 Chat 介面，為 mini-IDE、Git 與 Plans 外掛視窗帶入完全互動式、功能齊全的 CLI Agent 面板。',
        'en-US':
          'New AiCliDock panel: replaces legacy plain-text chat with a fully interactive CLI agent panel across mini-IDE, Git, and Plans windows.',
      },
      {
        'zh-TW':
          '外掛 PTY 互動能力管道：允許外掛視窗順暢呼叫互動式 PTY 能力，享受同主視窗級別的 Agent 互動與終端呈現。',
        'en-US':
          'Plugin PTY capability broker: pipes interactive PTY capabilities through the broker to grant plugin windows full main-window agent power.',
      },
      {
        'zh-TW':
          '後端架構輕量化：完全移除舊版 AI Chat 後端介面，專注於高效能、高穩定的原生 CLI Agent Engine。',
        'en-US':
          'Lightweight backend architecture: retired legacy AI chat backend surfaces to focus on high-performance native CLI agent engines.',
      },
    ],
  },
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
    version: '0.1.69',
    title: {
      'zh-TW': '更新檢查更即時、滾輪捲動不再誤鎖 RUNNING 狀態',
      'en-US': 'More responsive update checks & scroll no longer latches the RUNNING badge',
    },
    highlights: [
      {
        'zh-TW':
          '自動更新檢查間隔由較長週期縮短為 30 分鐘，且開啟「自動檢查」時立刻重新檢查一次，不必等下一輪。',
        'en-US':
          'Background update checks now run every 30 minutes, and enabling auto-check re-checks immediately instead of waiting for the next cycle.',
      },
      {
        'zh-TW': '終端轉發的滾輪捲動不再被當成活動訊號，瀏覽歷史時 RUNNING 標籤不會被鎖住。',
        'en-US':
          'Wheel scrolls forwarded to the terminal no longer count as activity, so browsing history keeps the RUNNING badge from latching on.',
      },
      {
        'zh-TW': 'Agent 歷史載入時，對已無對應 pane 的項目補上移除時間戳，時間欄位不再空白。',
        'en-US':
          'Agent History stamps a removal time on load for entries with no live pane, so their timestamp column is no longer blank.',
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
    version: '0.1.67',
    title: {
      'zh-TW': '儲存空間監控與安全清理、Claude 憑證跨目錄複製修復與終端效能調校',
      'en-US': 'Storage monitor with guarded cleanup, Claude credential fix & terminal performance',
    },
    highlights: [
      {
        'zh-TW':
          '設定新增 Storage 分頁：檢視各項資料佔用的空間並進行清理，清理只會動它能證明無人使用的資料（Codex pane home 等），live 資料受保護。',
        'en-US':
          'New Storage tab in Settings: see what is using disk and reclaim it. Cleanup only offers data it can prove no pane still references (stale Codex pane homes and the like) — live data is protected.',
      },
      {
        'zh-TW':
          '憑證修復：停止跨 config 目錄複製 Claude token（切帳號後舊 pane 顯示 Login expired 的根因），改由該 Profile 自己的 home 讀取登入狀態；aider 每個 pane 也有各自的對話歷史檔。',
        'en-US':
          'Credential fixes: stopped copying Claude tokens across config dirs (the root cause of “Login expired” on older panes after an account switch) and read a managed profile’s login from its own home; aider panes now get their own chat-history file.',
      },
      {
        'zh-TW':
          '終端與效能：修復 RUNNING 標籤中途誤閃 idle、localStorage 滿時靜默丟失 scrollback、--resume 產生的重複 PTY；PTY 每次喚醒改讀整個 viewport，token 匯入改為五分鐘合併並只追加變動日誌。',
        'en-US':
          'Terminal & performance: fixed the RUNNING badge flickering to idle mid-task, scrollback silently dropped when localStorage is full, and the duplicate PTY a --resume spawn left behind; PTY wakeups now repaint a whole viewport and token ingestion coalesces into a five-minute window with an append-only delta log.',
      },
    ],
  },
  {
    version: '0.1.66',
    title: {
      'zh-TW': '多家 CLI 額度偵測、帳號切換器餘額顯示與 Agent SPAWN 開面板',
      'en-US': 'Quota detection for more CLIs, per-account remaining quota & agent SPAWN blocks',
    },
    highlights: [
      {
        'zh-TW':
          '額度偵測擴充至 opencode、qwen、kilo、pi、copilot、cursor 等供應商，帳號切換器直接顯示每個帳號的剩餘額度。',
        'en-US':
          'Quota fetchers added for opencode, qwen, kilo, pi, copilot and cursor, with each account’s remaining quota shown right in the account switcher.',
      },
      {
        'zh-TW': 'CLI Agent 可用 SPAWN 區塊直接開出新的 CLI 面板，把工作交給另一個 agent。',
        'en-US':
          'CLI agents can open new CLI panes themselves via SPAWN blocks, handing work off to another agent.',
      },
      {
        'zh-TW':
          'CLI 還原可設定為延遲載入（開啟時才起 CLI）；Claude Profile Home 改以執行中狀態優先播種，避免舊快照覆蓋剛刷新的 token。',
        'en-US':
          'CLI restore can be configured to load lazily (a CLI starts when you open it), and Claude profile homes seed runtime-first so an old snapshot can no longer overwrite a freshly refreshed token.',
      },
    ],
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
