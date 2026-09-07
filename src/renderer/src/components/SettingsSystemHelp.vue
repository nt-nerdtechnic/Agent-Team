<script setup lang="ts">
// Read-only reference for the settings window and the system surfaces around it
// (Navide Cloud, the app menus, standalone windows, resource upkeep).
// Static mirror of the shipped UI — a prose copy of the "設定與系統" manual.
// Purely presentational: no props, no emits, no state.

interface TabRow {
  /** Only set on the first row of a group; drives the rowspan cell. */
  group?: string
  groupSpan?: number
  tab: string
  what: string
  more: string
}

interface SettingRow {
  name: string
  desc: string
  fallback: string
}

interface StatusRow {
  state: string
  when: string
  color: string
}

interface MatrixRow {
  cell: string
  meaning: string
  who: string
}

interface PairRow {
  key: string
  value: string
}

interface TripleRow {
  a: string
  b: string
  c: string
}

interface StageRow {
  stage?: string
  stageSpan?: number
  toggle: string
  fallback: string
}

// ── 1 · 十七個分頁 ────────────────────────────────────────────────────────
const tabs: TabRow[] = [
  {
    group: 'GENERAL',
    groupSpan: 5,
    tab: 'General',
    what: '關閉確認、閒置回收門檻、接續行為、預設編輯器、額度徽章',
    more: '本頁第 2 章',
  },
  {
    tab: 'Appearance',
    what: '語言、主題與自訂顏色、重開視窗、環境檢查、Backend 逾時、Loop 提示',
    more: '本頁第 2 章',
  },
  { tab: 'Status badges', what: '九種面板狀態的名稱與顏色', more: '本頁第 2 章' },
  {
    tab: 'Layout',
    what: '五槽外殼、每個 view 落在哪一槽、版面 preset',
    more: '本面板的「工作區與面板」分頁第 4 章',
  },
  {
    tab: 'Navide Cloud',
    what: '跨裝置連線狀態、本機指紋、誰可以命令這台機器',
    more: '本頁第 5 章',
  },
  {
    group: 'ACCOUNTS & AGENTS',
    groupSpan: 3,
    tab: 'Accounts',
    what: 'Git 帳號與 CLI 帳號',
    more: '本面板的「CLI Agent 與帳號」分頁',
  },
  {
    tab: 'CLI Agents',
    what: '各家 CLI 的安裝、啟動參數、權限模式',
    more: '本面板的「CLI Agent 與帳號」分頁',
  },
  { tab: 'Analyzer', what: '本機推論後端、模型下載、模型評測', more: '本頁第 4 章' },
  {
    group: 'INTEGRATIONS',
    groupSpan: 5,
    tab: 'MCP',
    what: 'MCP server 的新增、啟用與檢視',
    more: '本面板的「Agent 協作」分頁',
  },
  { tab: 'Skills', what: '共用技能庫與投遞對象矩陣', more: '本頁第 3 章' },
  { tab: 'Prompts', what: '提示技能庫（∞ 按鈕施放的整段提示）', more: '本頁第 3 章' },
  {
    tab: 'Memory',
    what: '各家 CLI 的指示檔（CLAUDE.md／AGENTS.md 等）',
    more: '本頁第 3 章',
  },
  { tab: 'Extensions', what: '已安裝的外掛與市集安裝', more: '本頁第 4 章' },
  { group: 'SYSTEM', groupSpan: 4, tab: 'Storage', what: '磁碟用量掃描與清理', more: '本頁第 4 章' },
  { tab: 'Shortcuts', what: '快捷鍵改綁、匯入匯出', more: '本頁第 4 章' },
  { tab: 'Updates', what: '檢查／下載／安裝三段開關', more: '本頁第 4 章' },
  {
    tab: 'Help',
    what: '唯讀參考：跨面板傳訊、MCP 與本篇說明',
    more: '就是你現在看的這個分頁',
  },
]

// ── 2 · General ──────────────────────────────────────────────────────────
const generalSettings: SettingRow[] = [
  {
    name: 'Confirm before closing a pane',
    desc: '按 ⌘W 關面板前先問。正在跑一個 turn 的面板一定會問，不受這個開關影響。',
    fallback: '開',
  },
  {
    name: 'Reclaim idle CLIs',
    desc: '閒置回收總開關（見本面板的「工作區與面板」分頁第 3 章）。',
    fallback: '開',
  },
  {
    name: 'Reclaim after',
    desc: '15 分鐘／30 分鐘／1 小時／3 小時／8 小時／Never。',
    fallback: '30 分鐘',
  },
  {
    name: 'Reclaim now',
    desc: '不等門檻，現在就回收；旁邊寫有幾個面板符合、大約佔多少記憶體。',
    fallback: '—',
  },
  {
    name: 'Resume conversations on open',
    desc: '開啟工作區時舊面板怎麼辦：Always resume／Always start fresh／Ask each time。',
    fallback: 'Always',
  },
  {
    name: 'Resume scope',
    desc: '接續範圍：One CLI／Current Grid page／Active tab／All CLIs。',
    fallback: 'One CLI',
  },
  {
    name: 'Resume sessions after a backend restart',
    desc: 'Backend 掛掉會帶走所有 CLI 行程；開著的話它回來後自動接續畫面上的面板。',
    fallback: '—',
  },
  {
    name: 'Concurrent resume limit',
    desc: '同時最多幾個面板一起接續（1–10），其餘排隊。出現 terminal.create timeout 就調低。',
    fallback: '—',
  },
  {
    name: 'Default editor',
    desc:
      'Mini-IDE／系統預設程式／偵測到的編輯器／自訂命令，可 Re-detect 重新偵測。'
      + '自訂命令可用 {file}、{dir}、{line}、{workspace}，指令直接執行、不經過 shell。'
      + '換掉它不會改變 diff——差異檢視永遠用 Mini-IDE。',
    fallback: 'Mini-IDE',
  },
  {
    name: 'CLI quota badge',
    desc: '在面板標題顯示剩餘額度，並可設更新間隔（1／5／15／30 分鐘）。',
    fallback: '開，5 分鐘',
  },
  {
    name: 'Backend Startup Timeout',
    desc: '等 Backend 起來的秒數，15–120；機器慢就調高。（這一項在 Appearance 分頁。）',
    fallback: '—',
  },
]

const statusBadges: StatusRow[] = [
  { state: 'starting', when: '已啟動，還沒有任何輸出', color: 'Blue' },
  { state: 'running', when: 'agent 正在產出輸出', color: 'Green' },
  { state: 'idle', when: '做完一個 turn，停在提示符等你', color: 'Yellow' },
  { state: 'awaiting', when: '卡在權限確認或一個問題上', color: 'Orange' },
  { state: 'stopped', when: '被你停掉', color: 'Ink' },
  { state: 'exited', when: '行程結束了', color: 'Grey' },
  { state: 'error', when: '啟動失敗，或終端機出錯', color: 'Red' },
  { state: 'waiting', when: '還原出來的佔位卡，從沒開過（只出現在清單）', color: 'Grey' },
  { state: 'disconnected', when: '後端 session 掉了（只出現在清單）', color: 'Yellow' },
]

// ── 3 · Skills / Memory ──────────────────────────────────────────────────
const skillMatrix: MatrixRow[] = [
  {
    cell: '✓ / 空白',
    meaning: '開新面板時會（或不會）把這個技能帶給它，可逐格點開關。',
    who: '11 家：antigravity、claude、codex、copilot、cursor、grok、kimi、muse、opencode、pi、qwen',
  },
  {
    cell: '● already reads it',
    meaning: '它自己就會讀 ~/.agents/skills，不經過 Navide 投遞，因此也無法對它單獨關掉（格子不可點）。',
    who: '6 家：codex、copilot、cursor、grok、muse、opencode',
  },
  {
    cell: '— no skills mechanism',
    meaning: '那家 CLI 根本沒有技能這回事，接不上。',
    who: '3 家：aider、kilo、droid',
  },
  {
    cell: '· supported, not wired yet',
    meaning: '有技能機制但 Navide 還沒接上。',
    who: '目前沒有',
  },
]

const memoryCoverage: PairRow[] = [
  { key: 'Mapped', value: 'Navide 知道這家 CLI 把指示放哪。13 家屬於這類。' },
  {
    key: 'Set in your config',
    value:
      '只有 aider。它沒有自己的檔名——它讀的是 .aider.conf.yml 裡 read: 那一欄指名的檔案，'
      + '所以你在那裡寫了什麼，這裡就列什麼（最多 20 個）。'
      + 'CONVENTIONS.md 只是官方文件的建議名稱，程式本身並不認得它。',
  },
  { key: 'Not mapped', value: 'Navide 不知道路徑的 CLI。目前是空的。' },
]

// ── 4 · Storage / Updates ────────────────────────────────────────────────
const storageCategories: PairRow[] = [
  {
    key: 'App data',
    value: '輪替後的 backend 記錄檔、目前的記錄檔、Navide 資料庫、設定備份、執行期暫存、CLI 額度快取',
  },
  { key: 'Electron caches', value: 'Chromium 快取、已下載的更新包、瀏覽器狀態' },
  { key: 'CLI agent homes', value: '封存的 CLI profile、profile 快取、CLI 對話歷史、孤兒 pane 家目錄' },
  { key: 'Workspaces', value: '孤兒／過期的 agent 記錄、pipeline 歷史與執行記錄、計畫歷史' },
]

const updateStages: StageRow[] = [
  { stage: 'Check', stageSpan: 2, toggle: 'Automatically check for updates', fallback: '開' },
  {
    toggle: 'Tell me when update checks keep failing ＋ 連續失敗幾次才提醒（1–10）',
    fallback: '開，3 次',
  },
  { stage: 'Download', stageSpan: 2, toggle: 'Automatically download updates', fallback: '開' },
  { toggle: 'Retry failed downloads ＋ 重試次數（0–5）', fallback: '開，3 次' },
  { stage: 'Install', stageSpan: 2, toggle: 'Install updates when you quit', fallback: '關' },
  { toggle: 'Install timeout（5–120 秒）', fallback: '20 秒' },
]

// ── 5 · Navide Cloud ─────────────────────────────────────────────────────
const needsYou: TripleRow[] = [
  {
    a: 'Pairing',
    b: '有裝置來敲門但還沒核准。',
    c: 'Not my device — block、Later',
  },
  {
    a: 'Access request',
    b: '「{裝置} 想要碰 {工作區} 裡的 {面板}」，附嘗試次數。',
    c: 'Approve、Dismiss、Block',
  },
]

// ── 6 · 選單與視窗 ───────────────────────────────────────────────────────
const windowMenu: PairRow[] = [
  { key: 'Navide Cloud', value: '開帳號視窗（本頁第 5 章）。' },
  { key: 'Pipeline Manager', value: 'Pipelines 與 Roles 的管理介面。' },
  { key: 'Resource Manager', value: '資源控管介面（本頁第 7 章）。' },
  {
    key: 'Minimize／Zoom／Bring All to Front',
    value: '標準 macOS 視窗操作。Zoom 是把視窗框放到最大，跟面板內容的字級縮放無關。',
  },
]

const scheduleSections: TripleRow[] = [
  {
    a: 'System crontab',
    b: '你自己的 crontab',
    c: '每一列都可停用／啟用、可移除',
  },
  {
    a: 'macOS Agents',
    b: '~/Library/LaunchAgents 與 /Library/LaunchAgents',
    c: '只有 ~/Library/LaunchAgents 裡你自己的那些有 ⏸／▶ 與 🗑；系統層的只顯示、沒有按鈕',
  },
  { a: 'macOS Daemons', b: '/Library/LaunchDaemons', c: '整段唯讀' },
]

const otherWindows: PairRow[] = [
  { key: '新的主視窗', value: 'File ▸ New Window（⌘N）' },
  {
    key: '編輯器（Mini-IDE）視窗',
    value:
      '⌘⇧I，或點檔案總管／搜尋結果／終端機裡的檔案連結'
      + '（見本面板的「程式碼工作流」分頁）',
  },
  { key: 'Git 視窗', value: 'Git 面板標題列的 Open in New Window，或 ⌘⇧G' },
  { key: '差異檢視', value: 'Git 面板點檔案列或 commit 裡的檔案' },
  { key: '分支比較', value: 'Git 面板的分支比較動作' },
  {
    key: 'Plan 視窗',
    value: '點終端機裡印出的計畫文件路徑，或開啟一份 HTML 計畫文件；每個工作區一個',
  },
  {
    key: '拖出來的群組視窗',
    value:
      '把上方的 tab 拖到視窗外放開；標題列的 Merge back 併回去'
      + '（見本面板的「工作區與面板」分頁第 5 章）',
  },
  { key: '拖出來的工作區視窗', value: '把側欄的工作區列拖出去（視窗裡要有兩個以上工作區）' },
]

// ── 7 · 維護速查 ─────────────────────────────────────────────────────────
const maintenance: PairRow[] = [
  { key: '記憶體吃太兇', value: 'Resource Manager ▸ Reclaim；或設定 ▸ General 調低閒置門檻' },
  { key: '磁碟滿了', value: '設定 ▸ Storage ▸ Clean safe items' },
  { key: '狀態列有 ⚠ N leftover', value: '點它，按 Clean up' },
  { key: '面板全部沒反應', value: 'Backend 藥丸 ▸ Restart' },
  { key: '快捷鍵互相打架', value: '設定 ▸ Shortcuts ▸ Conflicts 篩選器' },
  { key: '某個鍵怎麼改都沒用', value: '看它有沒有 ⚠：選單佔用的鍵在這裡改不掉' },
  { key: '另一台機器的 agent 送不到', value: '設定 ▸ Navide Cloud ▸ 規則卡（預設全拒）' },
  { key: '背景有東西在偷跑', value: '右側槽 ▸ Schedule' },
  { key: '設定要搬到另一台機器', value: '設定視窗底部 ▸ Export bundle' },
]
</script>

<template>
  <div class="syh">
    <p class="syh-intro">
      設定視窗的十七個分頁分別管什麼、Navide Cloud 怎麼把幾台機器接成一個私有網路，
      以及選單、獨立視窗與資源維護這些散在主畫面之外的系統面。
    </p>

    <!-- ── 1 · 設定總覽 ─────────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">1</span>設定總覽</h2>
      <p class="syh-p">
        設定視窗用 <kbd class="syh-kbd">⌘,</kbd> 開啟，標題列的齒輪鈕是同一個入口。
        左側側欄分四組，共 <strong>17 個分頁</strong>。
      </p>

      <h3 class="syh-h3">搜尋框</h3>
      <p class="syh-p">
        側欄標題底下有一個搜尋框，提示字是 <code>Search settings…</code>。
        它<strong>跨分頁</strong>比對設定項的標題、所屬區塊與關鍵字（中英文都收），最多列 8 筆；
        點一筆會切到那個分頁並捲到對應區塊，沒命中時顯示 <code>No matching settings</code>。
        <kbd class="syh-kbd">Esc</kbd> 清空。
      </p>
      <div class="syh-callout">
        <div class="syh-callout-title">搜尋索引不是全覆蓋</div>
        <div class="syh-callout-text">
          索引是一份人工維護的清單，<strong>CLI Agents、Layout、Extensions 這三個分頁沒有任何條目</strong>，
          搜尋不到它們裡面的東西，得自己點進去。
        </div>
      </div>

      <h3 class="syh-h3">十七個分頁</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>分組</th><th>分頁</th><th>這裡能調什麼</th><th>詳見</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in tabs" :key="row.tab">
              <td v-if="row.group" :rowspan="row.groupSpan" class="syh-group">{{ row.group }}</td>
              <td class="syh-nowrap"><strong>{{ row.tab }}</strong></td>
              <td>{{ row.what }}</td>
              <td class="syh-muted">{{ row.more }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note">
        Help 分頁沒有任何設定項，只有幾篇對照文件——你正在看的就是其中一篇。
        設定視窗底部另有 <em>Export bundle</em>／<em>Import bundle</em>，可以把整包設定搬到別台機器。
      </p>
    </section>

    <!-- ── 2 · General / Appearance / Status badges ─────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">2</span>General、Appearance、Status badges</h2>

      <h3 class="syh-h3">General</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>設定</th><th>說明</th><th>預設</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in generalSettings" :key="row.name">
              <td><strong>{{ row.name }}</strong></td>
              <td>{{ row.desc }}</td>
              <td class="syh-nowrap">{{ row.fallback }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="syh-h3">Appearance</h3>
      <ul class="syh-list">
        <li>
          <strong>Language</strong> — <strong>只有兩種</strong>：<code>繁體中文</code> 與
          <code>English</code>。這是使用者層級偏好，套用到所有工作區。
        </li>
        <li>
          <strong>Theme</strong> — 五種內建：Dark (GitHub)、Midnight、Forest、Light、High Contrast，
          預設是 Dark (GitHub)。
        </li>
        <li>
          <strong>Custom Colors</strong> — 八個可覆寫的色彩 token（背景、表面、文字、次要文字、邊框、
          強調、成功、危險）。覆寫疊在目前主題之上，<strong>換主題時保留</strong>；
          <em>↺ Reset to defaults</em> 還原。
        </li>
        <li><strong>Restore Windows</strong> — 下次啟動時重開上次結束時開著的工作區視窗。</li>
        <li>
          <strong>Environment</strong> — <em>↻ Re-run environment check</em> 重跑首次啟動的環境偵測精靈
          （Homebrew／Node／CLI／Ollama 等）。
        </li>
        <li>
          <strong>Loop Prompt</strong> — 按面板 <code>∞</code> 按鈕時送出的提示，
          以及每個 turn 結束後用來續跑的 resume 文字。
        </li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">沒有通知與音效設定</div>
        <div class="syh-callout-text">
          設定視窗裡<strong>找不到聲音或通知的開關</strong>。CLI 完成與需要你回答時的提示音是固定會響的；
          系統通知的權限是在首次啟動的環境精靈裡處理，不在設定裡。
          唯一與通知有關的開關是 Updates 分頁的「更新檢查連續失敗時提醒我」。
        </div>
      </div>

      <h3 class="syh-h3">Status badges</h3>
      <p class="syh-p">
        把九種面板狀態各自<strong>改名並選顏色</strong>。中英文名稱可以分開填（各限 24 字，
        留空就退回內建翻譯）。改完之後面板徽章、側欄、會議條與資源面板全部跟著變。
        <strong>設定存在你的帳號上，不跟著專案走。</strong>
      </p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>狀態</th><th>什麼時候是這個狀態</th><th>預設色</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in statusBadges" :key="row.state">
              <td><code>{{ row.state }}</code></td>
              <td>{{ row.when }}</td>
              <td class="syh-nowrap">{{ row.color }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note">
        顏色十種（Green／Yellow／Orange／Red／Blue／Purple／Pink／Cyan／Grey／Ink），
        都走主題 token，在任何主題下都讀得出來。單列 <em>Reset</em>、整頁 <em>Reset all</em>。
      </p>
    </section>

    <!-- ── 3 · Skills / Prompts / Memory ────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">3</span>Skills、Prompts、Memory</h2>

      <h3 class="syh-h3">Skills — 共用技能庫</h3>
      <p class="syh-p">
        技能是一個資料夾，裡面有一份 <code>SKILL.md</code>，寫著「遇到某類任務時照這樣做」。
        這一頁（標題 <em>Managed Skills</em>）做三件事：看見所有 CLI 手上的技能、
        決定<strong>誰收到哪一個</strong>、以及建立新技能。
      </p>
      <div class="syh-callout">
        <div class="syh-callout-title">共用根目錄</div>
        <div class="syh-callout-text">
          Navide 建立的技能一律放在 <code>~/.agents/skills</code>。
          這一頁<strong>不會搬動或改寫</strong>各家 CLI 自己資料夾裡的技能——
          那些只是被反射出來讓你看見，並且可以投遞給別家。
          （有一個明確的 <em>Move into shared library</em> 動作是例外，它會搬檔並留下 symlink，可以還原。）
        </div>
      </div>
      <p class="syh-p">
        頁面有 <strong>Browse</strong>（卡片瀏覽）與 <strong>Route</strong>（投遞矩陣）兩種檢視。
        矩陣橫軸是 14 家 CLI，直軸是技能，每格四種狀態，每一列還有 <em>All</em>／<em>None</em> 兩顆批次鈕：
      </p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>格子</th><th>意思</th><th>哪幾家</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in skillMatrix" :key="row.cell">
              <td class="syh-nowrap"><code>{{ row.cell }}</code></td>
              <td>{{ row.meaning }}</td>
              <td>{{ row.who }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p">
        點一個技能會開抽屜。Navide 自己建立的技能可完整編輯：<em>Description</em>、
        <em>User invocable</em>（允許使用者直接叫用）、<em>Model invocation</em>（允許模型自己挑）、
        <em>Instructions (Markdown)</em>，以及 <em>Advanced agent fields</em>
        （allowed／disallowed tools、model、effort、context）。附件唯讀，要管理就按 <em>Open folder</em>。
        已知欄位可改，其他 frontmatter 原樣保留；刪除是 <em>Move to Trash</em>。
        同名技能若 CLI 自己也有一份，會標 <em>Native skill wins</em>——它自己的那份優先。
      </p>

      <h3 class="syh-h3">Prompts — 提示技能庫</h3>
      <p class="syh-p">
        和上面的 Skills 是<strong>兩件不同的事</strong>。提示技能是一整段可重複使用的指令，
        由面板標題列的 <code>∞</code> 按鈕施放。
        <strong>一個技能就是一整段完整提示——挑一個技能是「換掉」提示，不是接在別的後面。</strong>
      </p>
      <ul class="syh-list">
        <li>
          <code>∞</code> <strong>直接按下去</strong>，施放的是預設技能（清單上標 <em>★ Default</em> 的那個）。
        </li>
        <li>
          滑鼠<strong>停在 <code>∞</code> 上約 0.3 秒</strong>，其餘技能會在按鈕下方<strong>展開成一圈</strong>讓你挑；
          游標移向那一圈時有短暫寬限，不會馬上收掉。
        </li>
        <li>
          可選技能<strong>超過 5 個</strong>，或面板太窄（小於 320px）時，改成直式清單，技能與按鍵完全一樣。
        </li>
        <li>指向任一個會顯示預覽卡：圖示、名稱、<strong>完整的提示內容</strong>，以及 turn 上限。</li>
        <li>
          鍵盤：在 <code>∞</code> 上按 <kbd class="syh-kbd">↓</kbd> 展開，方向鍵移動，
          <kbd class="syh-kbd">1</kbd>–<kbd class="syh-kbd">9</kbd> 直接施放，
          <kbd class="syh-kbd">Esc</kbd> 收起。
        </li>
        <li>停用的技能留在設定頁裡，但<strong>從那一圈裡消失</strong>。</li>
      </ul>
      <p class="syh-note">
        每個技能可設 <em>Name</em>、<em>Icon</em>、<em>Summary</em>、<em>Prompt sent on cast</em>、
        <em>Resume text</em>（留空就用全域續跑文字）、<em>Turn cap</em>（0 = 不限）、<em>Category</em>；
        每一筆有 <em>Set as default</em>、<em>Enable</em>／<em>Disable</em>、<em>Duplicate</em>、<em>Delete</em>。
      </p>

      <h3 class="syh-h3">Memory — 各家 CLI 的指示檔</h3>
      <p class="syh-p">
        每家 CLI 動工前都會先讀一份指示檔——<code>CLAUDE.md</code>、<code>AGENTS.md</code>、
        <code>QWEN.md</code>、<code>.cursor</code> 規則。
        這一頁列的單位是<strong>檔案不是 CLI</strong>：一個檔案列一次，後面掛著所有會讀它的 CLI，
        並且可以就地編輯。
      </p>
      <ul class="syh-list">
        <li>
          分 <strong>User level</strong>（家目錄）與 <strong>Project level</strong>（目前工作區）兩段。
          沒開資料夾時只列使用者層級。
        </li>
        <li>還不存在的檔案標 <em>Not created</em>——按存檔就會建立它，連同上層缺的資料夾。</li>
        <li>
          編輯中若檔案被別的程式改掉，會擋下來要你先 <em>Reload from disk</em>，
          不會直接覆蓋你或對方的內容。
        </li>
      </ul>
      <p class="syh-p">底部的 <strong>CLI coverage</strong> 把 14 家分成三類：</p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>分類</th><th>意思</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in memoryCoverage" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.key }}</strong></td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">cursor 的使用者層級是有條件的</div>
        <div class="syh-callout-text">
          <code>cursor</code> 沒有專門的 user-scope 載入器，它是從目前資料夾一路往上找到檔案系統根目錄。
          所以家目錄那幾份規則<strong>只有在專案剛好放在家目錄底下時才讀得到</strong>；
          專案放在外接磁碟上就讀不到。這一頁仍會把它們列出來，
          但 cursor 是唯一<strong>沒有任何「標準檔」的 CLI</strong>，所以 Navide 從不主動提供替它建立檔案。
          另外 <code>copilot</code> 只有專案層級，沒有使用者層級的指示檔。
        </div>
      </div>
    </section>

    <!-- ── 4 · Storage / Shortcuts / Updates / Analyzer / Extensions ── -->
    <section class="syh-section">
      <h2 class="syh-h2">
        <span class="syh-num">4</span>Storage、Shortcuts、Updates、Analyzer、Extensions
      </h2>

      <h3 class="syh-h3">Storage</h3>
      <p class="syh-p">
        掃描這個 app、各家 CLI 的家目錄、以及你開過的工作區佔了多少磁碟，
        共 <strong>25 個項目分四大類</strong>，其中 17 項可清理。
      </p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>分類</th><th>內容舉例</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in storageCategories" :key="row.key">
              <td class="syh-nowrap"><strong>{{ row.key }}</strong></td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p">
        每一項標一個風險等級 <strong>Safe</strong>／<strong>Caution</strong>／<strong>Danger</strong>，
        動不得的標 <em>Not removable</em>；<em>Paths</em> 可展開看實際路徑。
        上方的 <em>Stale threshold</em>（7／30／90 天，預設 30）決定「多久沒動過才算過期、才可清理」。
      </p>
      <p class="syh-p">
        清理兩顆鈕：<em>Clean safe items</em> 一次清掉所有安全項；<em>Clean selected</em> 清你自己勾的。
        兩者都會跳確認框寫明大約釋出多少空間，勾到 Danger 項時另外警告。
      </p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">刪掉就沒了</div>
        <div class="syh-callout-text">
          確認鈕寫的是 <em>Delete permanently</em>——不是丟到垃圾桶。
          真正需要用到 <em>Clean selected</em> 的只有一項：<strong>CLI conversation history</strong>
          （各家 CLI 的對話歷史），它是唯一既標 Danger 又可清理的項目。清掉之後那些對話就接不回來了。
        </div>
      </div>

      <h3 class="syh-h3">Shortcuts</h3>
      <p class="syh-p">
        表格四欄：<em>Command</em>、<em>Shortcut</em>、<em>Active when</em>（生效情境）、<em>Source</em>。
      </p>
      <ul class="syh-list">
        <li>
          點一顆按鍵方塊就地開始<strong>錄製</strong>；<code>+</code> 加第二組綁定；<code>✕</code> 移除一組。
          和弦最多兩段。
        </li>
        <li>
          改動<strong>立即寫進 <code>keybindings.json</code></strong> 並套用到每一個開著的視窗，沒有存檔鈕。
        </li>
        <li>
          搜尋框同時比對命令名稱與按鍵寫法（<code>cmd+shift+p</code> 和
          <kbd class="syh-kbd">⌘⇧P</kbd> 都找得到）；三個篩選器 <em>All</em>／<em>Customized</em>／<em>Conflicts</em>。
        </li>
        <li><em>Conflicts</em> 會標出互相打架的綁定，並說明是誰永遠贏、還是靠 <em>Active when</em> 分開的。</li>
        <li>
          單列 <em>Reset to default</em>，整頁 <em>Reset all</em>。<em>Export</em>／<em>Import</em> 搬設定，
          <strong>匯入是取代不是合併</strong>，會先告訴你幾條被丟棄、幾條被匯入，被拒絕的條目也會列出來。
        </li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">兩個拆不掉的鍵，和一類拆了也沒用的鍵</div>
        <div class="syh-callout-text">
          「開啟設定」與「開啟快捷鍵設定」是回到設定的唯一路，最後一組綁定上是 🔒 不是 ✕——
          <strong>可以改綁到別的鍵，但不能解除</strong>。
          另外，被應用程式選單佔用的按鍵會標 ⚠：那些鍵在 app 看到之前就被選單接走了，
          <strong>在這裡解除綁定並不會讓它停手</strong>。
        </div>
      </div>
      <p class="syh-note">
        用 <code>✕</code> 解除的綁定，在 <code>keybindings.json</code> 裡是記成一條
        <code>-command</code>（命令名稱前加減號）的規則。手改檔案時就是用這個寫法。
        頁面最下方另有「終端機」與「應用程式選單」兩份唯讀對照表。
      </p>

      <h3 class="syh-h3">Updates</h3>
      <p class="syh-p">更新拆成三段，各自有開關，所以可以組出「自動檢查但不自動下載」這種行為：</p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>階段</th><th>開關</th><th>預設</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in updateStages" :key="row.toggle">
              <td v-if="row.stage" :rowspan="row.stageSpan" class="syh-group">{{ row.stage }}</td>
              <td>{{ row.toggle }}</td>
              <td class="syh-nowrap">{{ row.fallback }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p">
        <em>Install updates when you quit</em> 預設關是刻意的：<strong>安裝一定會重開 app</strong>，
        所以留著關就是「每次自己決定」。頁面上有目前版本、<em>Check for updates</em>，
        以及一條 Check → Download → Install 的三段進度軌。
        更新頻道下拉目前只有 Stable 可選，Beta 標著「not available yet」。
      </p>
      <p class="syh-p">
        狀態列的更新徽章對應這幾種狀態：<code>v{版本} ready</code>、下載中的百分比、
        <code>Update failed</code>、<code>Update check failed</code>。
        <strong>公告中心裡也能直接按 <em>Download</em> 或 <em>Install</em></strong>
        （見本面板的「工作區與面板」分頁第 6 章）。
      </p>

      <h3 class="syh-h3">Analyzer</h3>
      <p class="syh-p">
        這裡設定的是<strong>本機小模型</strong>，Navide 拿它做 pipeline 的意圖判讀，
        跟你在面板裡用的 CLI agent 無關。三段：
      </p>
      <ul class="syh-list">
        <li>
          <strong>Inference backend</strong> — 先選 <em>Ollama REST</em> 或 <em>llama.cpp</em> 兩種後端。
          選 llama.cpp 要填 <code>llama-cli</code> 路徑（有自動偵測鈕與檔案瀏覽器）與選用的 GGUF 模型路徑；
          選 Ollama 則填推論網址（預設 <code>http://localhost:11434</code>）。兩者旁邊都有健康指示燈。
        </li>
        <li>
          <strong>Model manager</strong>（Ollama 模式） — 輸入模型名稱按 <em>Download</em> 下載，有進度條；
          下方列出已安裝的模型（名稱、參數量、大小），可逐一刪除。
        </li>
        <li>
          <strong>Model benchmark</strong> — 對所有本機模型跑四項任務：技術棧偵測（輸出 JSON）、
          工作區一句話摘要、從文件清單挑最相關的一筆、解析 CLI 輸出並抽出問題與選項。
          結果表逐項打勾並附耗時，<strong>四題至少過三題（≥75%）</strong>才算通過；
          沒過的模型會從模型下拉選單裡藏起來。
        </li>
      </ul>

      <h3 class="syh-h3">Extensions</h3>
      <p class="syh-p">
        三段：<strong>Bundled</strong>（隨附套件，例如 Bundled Git，可停用後再 <em>Restore</em>）、
        <strong>Installed</strong>（自行安裝的，列出敏感能力與相依，可 <em>Remove</em>）、
        <strong>Marketplace</strong>（搜尋並安裝）。
      </p>
      <p class="syh-p">
        安裝是<strong>兩道確認</strong>，而且在確認之前不會寫入任何檔案：先是「信任發佈者」——
        畫面明說<em>有效的簽章只證明套件沒被竄改，不代表你願意執行這個發佈者的程式</em>；
        接著是「確認外掛權限」，列出它要求的敏感能力，並在帶有原生後端執行檔時特別警告。
      </p>
    </section>

    <!-- ── 5 · Navide Cloud ─────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">5</span>Navide Cloud</h2>
      <p class="syh-p">
        Navide Cloud 把你的幾台機器接成一個<strong>私有網路</strong>，
        讓這台上的 agent 可以把訊息送到另一台上的 agent。兩個入口分工明確：
      </p>
      <ul class="syh-list">
        <li>
          <strong>帳號視窗</strong> — 標題列齒輪左邊那顆雲朵圖示，或選單
          <strong>Window ▸ Navide Cloud</strong>。登入、貼 token、登出、配對、信任管理都在這裡。
        </li>
        <li>
          <strong>設定 ▸ Navide Cloud</strong> — 連線狀態、本機指紋，以及授權規則。
          <strong>登入相關的動作在這一頁是唯讀的</strong>，頁面自己會提示你去標題列那顆按鈕。
        </li>
      </ul>

      <h3 class="syh-h3">登入</h3>
      <p class="syh-p">
        帳號視窗未登入時有三個分頁：<em>Sign in</em>、<em>Create account</em>、<em>Use a token</em>。
      </p>
      <p class="syh-p">
        用的是 <strong>Email + 密碼</strong>（至少 8 碼），<strong>沒有 magic link 登入</strong>，
        顯示名稱可留空。註冊後會寄一封<strong>驗證信</strong>，視窗上有 <em>Check now</em> 與 <em>Resend</em>；
        驗證是軟性的——沒驗證不會擋你用，只有要邀請別人時才要求先驗證。
        <em>Use a token</em> 是進階路徑：貼上伺服器發的 access token，
        <strong>存進系統 keychain 之後不再顯示</strong>。
      </p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">目前沒有密碼重設</div>
        <div class="syh-callout-text">
          建立帳號的頁面自己就寫著這件事：密碼還沒有重設流程，請自己存好。
        </div>
      </div>
      <p class="syh-p">
        伺服器位址是<strong>寫死的</strong>，設定裡沒有可改的欄位，帳號視窗只以唯讀的 <em>Server</em> 一列顯示它。
        連線狀態有六種：<code>Not signed in</code>、<code>Connecting…</code>、
        <code>Waiting for Keychain</code>、<code>Connected</code>、
        <code>Cannot reach the server</code>、<code>Access token rejected</code>。
        <em>Your network</em> 區塊有一個 <em>Turn off</em>／<em>Turn on</em> 開關可以暫時離線，
        帳號與設定都留著。
      </p>

      <h3 class="syh-h3">配對兩台裝置</h3>
      <p class="syh-p">
        兩台機器都登入<strong>同一個帳號</strong>之後，對方會出現在 <em>Your network</em> 清單裡
        （含 Online／Offline、上次出現時間、開著幾個面板）。
      </p>
      <ol class="syh-list">
        <li>在對方那一列按 <strong>Pair</strong>。</li>
        <li>兩邊螢幕各自跳出<strong>同一組六位數字</strong>，並列出對方的指紋。</li>
        <li>
          畫面寫著「Check that {裝置} is showing these same six digits.」——
          <strong>你要親眼比對兩台螢幕上的數字</strong>。
        </li>
        <li>
          發起方按 <em>They match</em> / <em>They do not match</em>；
          接收方按 <em>Allow pairing</em> / <em>They do not match</em>。兩邊都可以按 <em>Later</em> 先擱著。
        </li>
        <li>
          <strong>兩邊都確認之後才真的配對。</strong>
          單邊確認只會顯示「You confirmed. Waiting for the other device.」
        </li>
      </ol>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">數字不一樣就是有東西夾在中間</div>
        <div class="syh-callout-text">
          介面的原話是：「Different digits on the two screens means something is in between.
          Refuse, and nothing pairs.」這一步是整套信任的地基，不要因為麻煩就隨手按 match。
        </div>
      </div>
      <p class="syh-note">
        配對碼有時效（約五分鐘），而且只存在記憶體裡——Backend 重啟會忘掉進行到一半的配對，重來即可。
        接收方不需要主動開什麼，請求會自己跳到畫面右上角。
        <em>Pair</em> 按鈕只在對方上線、尚未配對、而且是<strong>你自己帳號</strong>底下的裝置時才出現；
        別人的裝置得先敲門。
      </p>

      <h3 class="syh-h3">信任、封鎖與解除配對</h3>
      <p class="syh-p">
        每台裝置三種狀態：<strong>Paired</strong>（已配對）、<strong>Not paired</strong>（尚未配對）、
        <strong>Blocked</strong>（已封鎖）；自己這台永遠標成 <em>This device</em>。
        帳號視窗上方的 <strong>Needs you</strong> 收兩種待辦：
      </p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>種類</th><th>內容</th><th>能按什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in needsYou" :key="row.a">
              <td class="syh-nowrap"><strong>{{ row.a }}</strong></td>
              <td>{{ row.b }}</td>
              <td>{{ row.c }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p">
        <em>Approve</em> 的授權範圍很窄——介面明說「Approving writes a rule for exactly this pane.
        Nothing else on this device is granted.」<em>Later</em> 只是把它從清單收起來，
        對方下次再嘗試就會回來。
      </p>
      <ul class="syh-list">
        <li>
          <strong>封鎖</strong>：<em>Blocked</em> 區塊列出被封鎖的裝置，按 <em>Unblock</em> 解除。
          封鎖<strong>排在所有規則前面，連你自己的其他裝置也擋</strong>。
        </li>
        <li>
          <strong>解除配對</strong>：裝置列上的 <em>Unpair</em>，說明是「Forget this device.
          It is not blocked.」——忘掉這台，但不等於封鎖；下次它再出現會被當成第一次見到，
          對方那邊也會收到通知。對方離線時一樣可以解除。
        </li>
      </ul>
      <p class="syh-p">
        <strong>Device identity</strong> 區塊貼出身分異常的告示，最該注意的一則是<strong>金鑰換了</strong>：
        它的訊息會直接被拒收，畫面同時列出「記住的指紋」與「這次送來的指紋」，
        而且<strong>刻意不放任何按鈕</strong>——介面要你先去跟那台機器的擁有者當面對過再說。
        另外，若某台裝置一直都是加密傳訊、突然送來一則明文，那則也會被擋下並留下紀錄。
      </p>

      <h3 class="syh-h3">誰可以命令這台機器</h3>
      <p class="syh-p">
        設定 ▸ Navide Cloud 裡的規則卡，標題是 <em>Who may command panes on this device</em>。
        它<strong>只管從別台裝置進來的訊息</strong>，本機 agent 之間不受影響。
      </p>
      <ul class="syh-list">
        <li>
          <strong>預設全拒</strong>：「Nothing is allowed by default: a message is refused unless
          a rule below matches it.」
        </li>
        <li>
          一條規則就是「<em>From</em>（哪個帳號／哪台裝置）→ <em>May reach</em>（哪個工作區／哪個面板）」，
          欄位<strong>留空表示不限</strong>。
        </li>
        <li>
          有一個現成的開關 <strong>Allow my own other devices</strong>：
          登入同一帳號的任何裝置都能碰這裡的任何面板，包含之後才加入的。
        </li>
        <li>規則存在伺服器上，<strong>只有連線時才能改</strong>；離線時顯示的是最後收到的那一份。</li>
        <li>
          規則用這台裝置的金鑰簽章。若出現「Your rules could not be verified」，
          在驗證前什麼都不會被接受，按 <em>Sign rules now</em> 重簽。
        </li>
      </ul>

      <h3 class="syh-h3">跨裝置傳訊</h3>
      <p class="syh-p">
        位址是三段式 <code>&lt;裝置&gt;/&lt;工作區&gt;/&lt;面板&gt;</code>。
        兩段 <code>&lt;工作區&gt;/&lt;面板&gt;</code> 是同一台機器，一段就是自己工作區裡的面板名。
        <strong>本機解析永遠優先</strong>，本機找不到才去問跨裝置名冊。
        裝置那一段可以寫裝置 ID 或它的名字；名字如果對到不只一台，會直接回報歧義而不是猜一個。
      </p>
      <div class="syh-callout">
        <div class="syh-callout-title">這是給 agent 用的位址</div>
        <div class="syh-callout-text">
          面板輸入框的 <code>@</code> 提及選單只列<strong>本機</strong>的面板（含同一台機器上其他視窗的），
          沒有插入跨裝置位址的按鈕。跨裝置位址是寫在 agent 的 <code>to:</code> 那一行、
          或由 MCP 工具送出的（見本面板的「Agent 協作」分頁）。
          送不到時的回覆是 <code>device-offline</code>、<code>unknown-target</code>、
          <code>link-offline</code> 或 <code>link-unauthorized</code>；另外，回覆串接不跨機器。
        </div>
      </div>
    </section>

    <!-- ── 6 · 選單、獨立視窗與排程 ─────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">6</span>選單、獨立視窗與排程</h2>

      <h3 class="syh-h3">Window 選單</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>項目</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in windowMenu" :key="row.key">
              <td><strong>{{ row.key }}</strong></td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note">
        Pipeline Manager 與 Resource Manager 是<strong>在主視窗裡開的對話框</strong>，
        不是另外的作業系統視窗。Window 選單這四項都沒有快捷鍵。
      </p>

      <div class="syh-card">
        <div class="syh-card-title">Pipeline Manager</div>
        <p class="syh-p">
          兩個分頁。<strong>Pipelines</strong> 一條流程由數個 stage 組成，stage 可設 ID、標題、
          <em>Sentinel</em>（結束標記，例如 <code>---DONE---</code>）與是否
          <em>Pause for user answers</em>；每個 stage 底下至少掛一個 slot，slot 要指定 <em>Agent</em>、
          <em>Role Key</em>、顯示名稱與 <em>Kickoff Body</em>（開場提示），並可勾
          <strong>Designate as global manager</strong>——被指定的 slot 做完自己的事之後轉為跨 stage 的協調者，
          <strong>一條流程只能有一個</strong>。內建流程被改壞了可以按 <em>Reset to factory stages</em> 還原
          （會先確認，不可復原）。
        </p>
        <p class="syh-p">
          <strong>Roles</strong> 分頁管角色本身（Key、Label、一句話摘要、System prompt），
          並註明<strong>改動只影響之後新開的面板</strong>。兩個分頁都有 <em>⬇ Export JSON</em>／
          <em>⬆ Import JSON</em>／<em>↺ Reset to Defaults</em>。
        </p>
      </div>

      <h3 class="syh-h3">Help 選單</h3>
      <ul class="syh-list">
        <li>
          <strong>Navide on GitHub</strong>、<strong>Report an Issue…</strong> — 開到 GitHub 專案與 issue 頁。
        </li>
        <li>
          <strong>Keyboard Shortcuts</strong> — 開設定的 Shortcuts 分頁。
          這個選單項<strong>不帶快捷鍵標示</strong>，鍵盤走的是
          <kbd class="syh-kbd">⌘K</kbd> <kbd class="syh-kbd">⌘S</kbd> 這組和弦。
        </li>
        <li>
          法律頁面六條，依序 <em>Privacy</em>、<em>Security Policy</em>、<em>Code of Conduct</em>、
          <em>Boundaries</em>、<em>Licenses</em>、<em>Legal</em>，都開到 navide.dev 上對應的頁。
          （<strong>沒有服務條款</strong>，這是刻意的。）
        </li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">View 選單少了幾個東西是故意的</div>
        <div class="syh-callout-text">
          <kbd class="syh-kbd">⌘0</kbd>／<kbd class="syh-kbd">⌘+</kbd>／<kbd class="syh-kbd">⌘-</kbd>
          的整窗縮放被拿掉了，因為 Navide 的縮放是<strong>每個面板各自的內容字級</strong>。
          <kbd class="syh-kbd">⌘R</kbd> 也改成「重建焦點面板」，重新載入整個視窗改用
          <kbd class="syh-kbd">⇧⌘R</kbd>，選單裡則是一個不帶快捷鍵的 <em>Reload Window</em>。
          <kbd class="syh-kbd">⌘W</kbd> 在 macOS 上留給了「關閉分頁」，
          所以關視窗只剩紅綠燈或 <kbd class="syh-kbd">⌘Q</kbd>。
        </div>
      </div>

      <h3 class="syh-h3">Schedule（排程）— 不是獨立視窗</h3>
      <p class="syh-p">
        這台 Mac 的背景排程列在<strong>右側槽的一個分頁</strong>裡，分頁名稱是 <strong>Schedule</strong>（🗓），
        也可以搬到上下兩槽。它不是從 Window 選單開的視窗。分三段：
      </p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>區塊</th><th>來源</th><th>能不能操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in scheduleSections" :key="row.a">
              <td class="syh-nowrap"><strong>{{ row.a }}</strong></td>
              <td><code>{{ row.b }}</code></td>
              <td>{{ row.c }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p">
        系統層唯讀是因為動它們需要 root，而 Navide 從不要求——後端也擋著，不只是介面不給按。
        這也是為什麼 daemon 自成一段：它們的狀態多半只能顯示成
        <code>State unknown (requires root)</code>。
        每一列可展開看 Schedule／Command／Raw line，或 Label／Scope／Plist path／Last exit code／State。
        移除 LaunchAgent 會<strong>卸載並永久刪除它的 plist</strong>，會先跳確認。
      </p>
      <p class="syh-note">
        這裡<strong>沒有「立刻執行」也沒有「在 Finder 顯示」</strong>，只有停用／啟用與移除兩種動作。
        上方有 <em>Rescan</em> 與上次掃描時間。
      </p>

      <h3 class="syh-h3">其他從 UI 開的視窗</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>視窗</th><th>怎麼開</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in otherWindows" :key="row.key">
              <td class="syh-nowrap">{{ row.key }}</td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout">
        <div class="syh-callout-title">兩個容易誤會的地方</div>
        <div class="syh-callout-text">
          <strong>Git History 沒有自己的視窗</strong>——「View full history」開的是 Git 視窗裡的歷史檢視。
          <strong><kbd class="syh-kbd">⌘⇧D</kbd> 也不再開視窗</strong>，
          它只是把左側側欄切到 Plans 分頁；要開 Plan 視窗得從計畫文件本身開。
        </div>
      </div>
      <p class="syh-note">
        同一個工作區已經在別的視窗開著時，Navide 不會再開一份，而是把那個視窗叫到前面。
      </p>
    </section>

    <!-- ── 7 · 資源與維護 ───────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">7</span>資源與維護</h2>

      <h3 class="syh-h3">資源控管</h3>
      <p class="syh-p">
        兩個入口看同一份資料：狀態列的資源藥丸（小面板），與 <strong>Window ▸ Resource Manager</strong>
        （完整介面）。列的是<strong>整台機器</strong>的 CLI，不只這個視窗的。
      </p>
      <ul class="syh-list">
        <li>
          欄位：<em>Name</em>、<em>Trend</em>（最近走勢的小折線）、<em>CPU</em>、<em>Memory</em>；
          閒置的標 <code>IDLE</code>。
        </li>
        <li>上方是 CPU 與記憶體總量，各附一行「佔這台機器多少」，以及 <em>Refresh</em>。</li>
        <li>篩選 <em>All</em>／<em>Running</em>／<em>Idle</em>，排序 Memory／CPU／Name。</li>
        <li>
          <strong>每列只有兩個動作</strong>：點名稱＝跳到那個面板（並關掉這個介面），
          或按 <em>Reclaim</em> 回收它。<strong>沒有強制結束</strong>。
        </li>
        <li>底下一行寫著目前的自動回收設定（開／關、幾分鐘），旁邊 <em>Settings</em> 直接跳過去調。</li>
        <li>另有 <strong>Disk space</strong> 一段，可 <em>Scan</em> 掃工作區用量、<em>Review</em> 跳到 Storage 分頁。</li>
      </ul>
      <p class="syh-note">
        數字是<strong>整棵行程樹</strong>一起算的。正在忙的面板按回收會被跳過並回報
        <code>Still busy — reclaim skipped.</code>；面板已經關掉則回報
        <code>That pane is no longer open.</code>
      </p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">記憶體是啟動地板，不是慢慢長出來的</div>
        <div class="syh-callout-text">
          一個閒著的 CLI 仍然抓著它啟動時要走的記憶體，<strong>常常是每個 200–300 MB</strong>。
          這是啟動成本，不會因為你「定期重啟它」而變少——重啟只是把同樣的地板重新付一次。
          真正能把記憶體拿回來的手段只有<strong>回收</strong>：結束那個行程，
          面板變成點一下就繼續的佔位卡，對話從 CLI 自己的 transcript 接回來
          （見本面板的「工作區與面板」分頁第 3 章）。
        </div>
      </div>

      <h3 class="syh-h3">孤兒行程與 Backend</h3>
      <ul class="syh-list">
        <li>
          <strong>殘留的 CLI 行程</strong> — 狀態列出現 <code>⚠ N leftover</code> 時點開，會問
          「Found N leftover CLI process(es) from a previous run — they can exhaust memory.
          Clean them up?」，按 <em>Clean up</em> 清掉、<em>Dismiss</em> 略過。
          這些是上一輪執行沒收乾淨的行程。
        </li>
        <li>
          <strong>Backend</strong> — 狀態列的 Backend 藥丸點開有位址、PID，以及兩顆鈕：
          <em>Restart</em>（沒連上時顯示 <em>Start</em>）與 <em>Stop</em>（只有連上時能按）。
          <strong>重啟 Backend 會一併帶走所有 CLI 行程</strong>；
          想讓它回來之後自動接續對話，就把 General 分頁的
          <em>Resume sessions after a backend restart</em> 打開。
        </li>
        <li>
          Backend 起太慢而報錯時，調 Appearance 分頁的 <em>Backend Startup Timeout</em>（15–120 秒）。
        </li>
      </ul>

      <h3 class="syh-h3">維護動作速查</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr><th>症狀</th><th>去哪裡</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in maintenance" :key="row.key">
              <td>{{ row.key }}</td>
              <td>{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.syh {
  display: flex;
  flex-direction: column;
  gap: 26px;
  color: var(--text-primary);
  max-width: 78ch;
}

.syh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.syh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.syh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.syh-num {
  color: var(--accent-fg);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-sm);
}

.syh-h3 {
  margin: 10px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}

.syh-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.syh-list {
  margin: 0;
  padding-left: 1.4em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.syh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.syh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.syh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.syh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.syh-callout--warn .syh-callout-title {
  color: var(--attention-fg);
}

.syh-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.syh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.syh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.syh-table th,
.syh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.syh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-table tr:last-child td { border-bottom: none; }

.syh-group {
  background: var(--bg-inset);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-nowrap { white-space: nowrap; }
.syh-muted { color: var(--text-secondary); }

.syh code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.syh-kbd {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 6px;
  white-space: nowrap;
  color: var(--text-primary);
}
</style>
