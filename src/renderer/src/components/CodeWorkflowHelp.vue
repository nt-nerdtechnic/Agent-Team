<script setup lang="ts">
// Read-only reference for the code workflow surfaces (Git, Plans, Mini-IDE,
// preview), shown inside Settings → 說明. Static mirror of 使用手冊第 4 冊 —
// every button label, menu item and shortcut below was verified against the
// real components; keep them in sync if those change.

interface FileButtonRow {
  glyph: string
  meaning: string
  where: string
}

interface CommitMenuRow {
  item: string
  what: string
}

interface RemoteActionRow {
  control: string
  behavior: string
}

interface DiffRow {
  how: string
  what: string
}

interface PlanToolRow {
  tool: string
  opens: string
}

interface EditorSectionRow {
  section: string
  key: string
  note: string
}

interface EditorActionRow {
  action: string
  keys: string[]
  note?: string
}

interface PreviewRow {
  kind: string
  extensions: string
  how: string
}

interface ShortcutRow {
  keys: string[]
  action: string
  where: string
}

// ── Git：檔案列上的按鈕 ────────────────────────────────────────────────
const fileButtons: FileButtonRow[] = [
  { glyph: '＋', meaning: 'Stage', where: 'Changes 的每一列' },
  { glyph: '↩', meaning: 'Discard', where: 'Changes 的每一列' },
  { glyph: '−', meaning: 'Unstage', where: 'Staged 的每一列' },
  { glyph: '⊡', meaning: 'File history + blame', where: '兩段都有' },
  { glyph: '↰ / ↱', meaning: 'Accept Ours / Accept Theirs', where: '衝突中的檔案' },
]

// ── Git：Commit 主鈕旁的 ▾ 選單 ───────────────────────────────────────
const commitMenu: CommitMenuRow[] = [
  { item: '✓ Commit', what: '一般提交。' },
  { item: '✎ Amend Commit', what: '併進上一個 commit；輸入框提示會換成 Amend message…。' },
  { item: '↑ Commit & Push', what: '提交後直接推。' },
  { item: '⇅ Commit & Sync', what: '提交後 pull --rebase 再推。' },
  { item: '↺ Undo Last Commit', what: '把上一個 commit 拆回工作區。' },
  { item: '✦ Auto Commit', what: '開關，右邊帶 ON / OFF 徽章。' },
]

// ── Git：遠端操作列 ───────────────────────────────────────────────────
const remoteActions: RemoteActionRow[] = [
  {
    control: '帳號藥丸',
    behavior:
      'Account for this workspace——這個工作區用哪個 Git 帳號。沒綁時顯示 No account，選單裡可以挑已存的帳號或 + Add new account…。',
  },
  { control: '↑ Publish', behavior: 'Publish Branch。只在分支還沒有 upstream 時出現。' },
  { control: '重新整理圖示', behavior: 'Fetch。' },
  { control: '↓', behavior: 'Pull。' },
  { control: '↑', behavior: 'Push，右上角以上標顯示領先幾個 commit。' },
  { control: '⇅', behavior: 'Sync（pull --rebase + push）。' },
  { control: '▾', behavior: 'More pull/push options，見下。' },
]

// ── Git：四種看變更的方式 ─────────────────────────────────────────────
const diffViews: DiffRow[] = [
  {
    how: '點一列檔案',
    what: 'DiffPane：單檔的工作區／已暫存／某個 commit 的差異，可以逐 hunk Stage、Unstage、Discard。看 commit 時是唯讀的。',
  },
  {
    how: '分支列的 ⇔，或 Mini-IDE 標題列的 Diff Review',
    what: 'BranchDiffPane：兩個分支整體比對，檔案清單加並排 hunk，附 AI Review 開關與 Expand All / Collapse All。Diff Review 一按就是開新視窗。',
  },
  {
    how: '檔案列的 ⊡',
    what: '就地展開兩層小面板：這個檔案的 commit 紀錄，再往下是 diff + blame。不是另開視窗。',
  },
  {
    how: 'History 卡片的 View full history',
    what: '獨立的 Git History 視窗。',
  },
]

// ── 計畫文件：審閱工具列 ──────────────────────────────────────────────
const planTools: PlanToolRow[] = [
  {
    tool: '☑ Todos',
    opens: '待辦清單。左鍵點狀態會循環 pending → in-progress → done → pending；右鍵才是切換 skipped。每列可 Edit / Delete，底下有 Add a todo… 加新的。',
  },
  {
    tool: '💬 Review Notes',
    opens: '審查意見。有未解決的才會出現在工具列上（否則收在 ⋯ 裡）。可以掛在某個章節上——章節旁的 Comment 按鈕就是這樣用的。動作有 Edit、Delete、Resolve。',
  },
  {
    tool: '▶ Execute',
    opens: '只在 stage 是 approved 時出現。Choose an agent to execute this plan，挑一家 CLI 就把整份計畫派工出去，同時把 stage 推到 in-progress。',
  },
  { tool: '✓ Approve', opens: '主鈕。' },
  {
    tool: '⋯ More actions',
    opens: 'Outline / Review Notes / History，以及 Share to Git、Open in Browser、Reopen、Archive、Abandon、Delete。',
  },
]

// ── Mini-IDE：左側四個區塊 ────────────────────────────────────────────
const editorSections: EditorSectionRow[] = [
  { section: 'Explorer', key: '⌘⇧E', note: '檔案樹。' },
  { section: 'Search', key: '⌘⇧F', note: '跨檔搜尋；⌘⇧H 跨檔取代。' },
  { section: 'Source Control', key: '⌘⇧G', note: '就是 Git 面板的嵌入版，帶變更數徽章。' },
  { section: 'Problems', key: '⌘⇧M', note: '診斷清單，帶錯誤數徽章；AI Review 的意見也會落在這裡。' },
]

// ── Mini-IDE：常用編輯動作 ────────────────────────────────────────────
const editorActions: EditorActionRow[] = [
  { action: '分割編輯區', keys: ['⌘\\'], note: '切換編輯群組 ⌘K ⌘← / ⌘K ⌘→' },
  { action: '尋找 / 取代', keys: ['⌘F', '⌘⌥F'] },
  { action: '下一個 / 上一個符合', keys: ['⌘G', '⌘⇧G'] },
  { action: '跳到行 / 檔內符號 / 全域符號', keys: ['⌘L', '⌘⇧O', '⌘T'] },
  { action: '格式化整份 / 選取範圍', keys: ['⇧⌥F', '⌘K ⌘F'] },
  { action: '摺疊 / 展開', keys: ['⌘⌥[', '⌘⌥]'], note: '全部 ⌘K ⌘0 / ⌘K ⌘J' },
  { action: '多游標：上下加一個', keys: ['⌘⌥↑', '⌘⌥↓'] },
  { action: '選下一個相同的 / 全部', keys: ['⌘D', '⌘⇧L'] },
  { action: 'Quick Fix', keys: ['⌘.'] },
  { action: 'AI 就地改寫', keys: ['⌘K ⌘K'] },
  { action: 'AI 接續補完（ghost）', keys: ['⌘I'] },
  { action: '開關 AI Terminal', keys: ['⌘J'], note: '或 ⌘⇧A' },
  { action: '把選取的程式碼丟給 AI Terminal', keys: ['⌘⇧L'], note: '游標不在編輯區時' },
  { action: 'Quick Open / 命令面板', keys: ['⌘P', '⌘⇧P'] },
]

// ── 預覽：只看副檔名決定怎麼開 ────────────────────────────────────────
const previewTypes: PreviewRow[] = [
  {
    kind: 'image',
    extensions: 'png jpg jpeg gif bmp webp ico svg avif apng',
    how: '圖片，可 Fit to window / Actual size。',
  },
  { kind: 'video', extensions: 'mp4 webm mov m4v mkv ogv', how: '播放器。' },
  { kind: 'audio', extensions: 'mp3 wav m4a ogg flac aac opus', how: '播放器。' },
  { kind: 'pdf', extensions: 'pdf', how: '內嵌檢視器。' },
  {
    kind: 'html',
    extensions: 'html htm',
    how: '沙箱 iframe，標著 sandboxed · no scripts。預設開原始碼，用 Preview / Raw 切換。',
  },
  { kind: 'csv', extensions: 'csv tsv', how: '可排序表格，最多 5000 列。同樣預設開原始碼。' },
  { kind: 'font', extensions: 'ttf otf woff woff2', how: '字型樣本。' },
  {
    kind: 'archive',
    extensions: 'zip tar tgz（含 .tar.gz）',
    how: '列出壓縮檔內容，兩欄 Name / Size。',
  },
  { kind: 'notebook', extensions: 'ipynb', how: '逐 cell 呈現，最多 500 個 cell。' },
  { kind: 'office', extensions: 'docx xlsx', how: '由後端轉換後顯示。' },
  {
    kind: 'binary',
    extensions:
      'gz bz2 xz 7z rar jar war exe dll so dylib bin dat o a class pyc wasm db sqlite sqlite3 dmg iso eot doc xls ppt pptx',
    how: '資訊卡加 hex dump，最多前 64 KB。',
  },
]

// ── 快捷鍵速查（「在哪」是判斷條件，不是補充說明）─────────────────────
const shortcuts: ShortcutRow[] = [
  { keys: ['⌘4'], action: '側欄 Git 分頁', where: '主視窗' },
  { keys: ['⌘5'], action: '側欄 Plans 分頁', where: '主視窗' },
  { keys: ['⌘⇧G'], action: '開獨立 Git 視窗', where: '主視窗' },
  { keys: ['⌘⇧I'], action: '開編輯器視窗', where: '任何地方' },
  { keys: ['⌘⌥V'], action: '右槽 Preview 分頁', where: '主視窗' },
  { keys: ['⌘↩', '⌘⇧↩'], action: 'Commit / Amend', where: 'Git 視窗' },
  { keys: ['⌘⇧M'], action: '產生 AI commit message', where: 'Git 視窗' },
  { keys: ['⌘⇧A', '⌘⇧U'], action: 'Stage all / Unstage all', where: 'Git 視窗' },
  { keys: ['⌘⇧F', '⌘⇧L'], action: 'Fetch / Pull', where: 'Git 視窗' },
  { keys: ['⌘⇧P', '⌘⇧S'], action: 'Push / Sync', where: 'Git 視窗' },
  { keys: ['F5', '⌘⇧R'], action: '重新整理', where: 'Git 視窗' },
  { keys: ['⌘L'], action: '跳到 AI Terminal', where: 'Git 視窗' },
  { keys: ['⌘P'], action: '快速開啟計畫', where: 'Plan 視窗' },
  { keys: ['Esc'], action: '依序取消編輯／關選單／退出快照／關視窗', where: 'Plan 視窗' },
  { keys: ['⌘⇧E', '⌘⇧F'], action: 'Explorer / Search', where: 'Mini-IDE' },
  { keys: ['⌘⇧G', '⌘⇧M'], action: 'Source Control / Problems', where: 'Mini-IDE' },
  { keys: ['⌘1', '⌘9'], action: '切到第 N 個檔案分頁（⌘1…⌘9）', where: 'Mini-IDE' },
  { keys: ['⌘\\'], action: '分割編輯區', where: 'Mini-IDE' },
  { keys: ['⌘.'], action: 'Quick Fix', where: 'Mini-IDE' },
  { keys: ['⌘K ⌘K', '⌘I'], action: 'AI 改寫 / AI 補完', where: 'Mini-IDE' },
  { keys: ['⌘J'], action: '開關 AI Terminal', where: 'Mini-IDE' },
  { keys: ['⌘K ⌘S'], action: '快捷鍵速查表', where: 'Mini-IDE' },
]
</script>

<template>
  <div class="cwh">
    <p class="cwh-intro">
      Git 面板、計畫文件、內建編輯器與預覽——把 agent 做出來的變更看清楚、審過、提交出去。
      這裡沿用「工作區／面板」這組名詞。
    </p>

    <!-- ── 1 三個工作面 ─────────────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">三個工作面</h2>
      <p class="cwh-p">
        Agent 把程式改完之後，你要做的事有三件：看它改了什麼、決定要不要收、把計畫推到下一步。
        Navide 為此準備了三個面，各自都能當側欄分頁用，也都能開成<strong>獨立視窗</strong>。
      </p>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">Git（Source Control）</span>
          <span class="cwh-tag">側欄第 4 個分頁</span>
        </div>
        <p class="cwh-p">
          工具提示寫著 <em>Git (⌘4)</em>。在主視窗按 <kbd class="cwh-kbd">⌘⇧G</kbd>
          會直接開<strong>獨立的 Git 視窗</strong>；面板標題列的 <em>Open in New Window</em> 也一樣。
        </p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">Plans（計畫文件）</span>
          <span class="cwh-tag">側欄第 5 個分頁</span>
        </div>
        <p class="cwh-p">
          <kbd class="cwh-kbd">⌘5</kbd> 那個分頁只是一份<strong>清單</strong>。點任一份會彈出獨立的
          Plan Review 視窗，標題是 <code>&lt;專案資料夾&gt; — Plans</code>。
        </p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">Mini-IDE（內建編輯器）</span>
          <span class="cwh-tag">只以獨立視窗存在</span>
        </div>
        <p class="cwh-p">
          <kbd class="cwh-kbd">⌘⇧I</kbd> 開啟，或在 Explorer 點一下檔案。標題是
          <code>&lt;檔名&gt; — Mini-IDE</code>，有未存檔時前面加 <code>●</code>。
        </p>
      </div>

      <div class="cwh-callout">
        <div class="cwh-callout-title">三個視窗都掛著同一個 AI Terminal</div>
        <div class="cwh-callout-text">
          Git 視窗、Plan 視窗、Mini-IDE 的右緣都有一條窄軌，點開就是 <strong>AI Terminal</strong>——
          一個真正的 CLI agent 面板（不是 API 聊天視窗），可以選 agent、<em>Start</em>、
          <em>Interrupt</em>、<em>Stop</em>。它會把當下的情境（工作區路徑、開著的計畫、選取的程式碼）
          自動注入給 agent，所以你可以邊看 diff 邊叫它改。
        </div>
      </div>
    </section>

    <!-- ── 2 Git：暫存與提交 ────────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">Git：暫存與提交</h2>

      <h3 class="cwh-h3">兩段式清單</h3>
      <p class="cwh-p">
        面板標題是 <strong>SOURCE CONTROL</strong>，底下分成 <strong>Staged Changes</strong> 與
        <strong>Changes</strong> 兩段（開了「顯示忽略檔案」還會多一段 <strong>Ignored</strong>）。
        點一列開 diff；<kbd class="cwh-kbd">⇧</kbd> 或 <kbd class="cwh-kbd">⌘</kbd> 點可以多選，
        上方會出現「N selected」與一顆 <code>✕</code>。
      </p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>鈕</th><th>意思</th><th>出現在</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in fileButtons" :key="row.glyph">
              <td class="cwh-nowrap"><code>{{ row.glyph }}</code></td>
              <td>{{ row.meaning }}</td>
              <td>{{ row.where }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p">
        段落標題右邊是整段的操作：Staged 那段只有一顆 <code>−</code>（<em>Unstage All Changes</em>）；
        Changes 那段是 <code>↩</code>（<em>Discard All Changes</em>）與 <code>＋</code>（<em>Stage All</em>）。
        <strong>在段落標題上按右鍵</strong>還會多出 <em>Save Draft</em>。
      </p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">清單模式少一顆鈕</div>
        <div class="cwh-callout-text">
          切成 <em>View as Tree</em> 時，資料夾那一列本身也有 <code>＋</code> / <code>↩</code> /
          <code>−</code>，可以整包暫存或捨棄。但在 <em>View as List</em> 模式下，已暫存的那一列<strong>只剩
          <code>⊡</code></strong>——要取消暫存得用段落標題的 <em>Unstage All Changes</em>、右鍵選單，
          或先切回樹狀檢視。
        </div>
      </div>

      <h3 class="cwh-h3">寫 commit message</h3>
      <p class="cwh-p">
        輸入框的提示文字是 <em>Message (⌘↩ to commit)</em>，按 <kbd class="cwh-kbd">⌘↩</kbd> 就送出。
        旁邊那顆 <code>✦</code> 是 <strong>AI commit message</strong>——讀目前暫存的內容，
        替你生一段訊息（跑的時候變成 <code>⟳</code>）。
      </p>
      <p class="cwh-p">
        主鈕寫著 <strong>✓ Commit</strong>，右邊的 <code>▾</code>（<em>More options</em>）
        展開後由上而下是：
      </p>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>項目</th><th>做什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in commitMenu" :key="row.item">
              <td class="cwh-nowrap"><code>{{ row.item }}</code></td>
              <td>{{ row.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p">
        <strong>Auto Commit</strong> 打開之後，狀態列會照著跑一輪：
        <em>Auto Commit waiting — triggers in {n}s</em> → <em>Staging all changes…</em> →
        <em>Running lint check…</em> → <em>Generating AI commit message…</em> → <em>Committing…</em>。
        這條路上沒有你按確認的機會，開之前先想清楚。
      </p>

      <h3 class="cwh-h3"><code>···</code> 檢視選單</h3>
      <p class="cwh-p">
        標題列的 <code>···</code>（<em>More options</em>）裡有三組：<em>View as List</em> /
        <em>View as Tree</em>、<strong>Sort by</strong> 的 <em>Name</em> / <em>Path</em> /
        <em>Status</em>，以及 <em>Show Ignored Files</em>。目前生效的那一項前面有 <code>✓</code>。
        清單／樹狀也另外做成標題列上的獨立按鈕。
      </p>

      <h3 class="cwh-h3">還不是 Git 儲存庫的資料夾</h3>
      <p class="cwh-p">
        會看到 <strong>Not a Git repository</strong> 卡片，提供 <em>Initialize Repository</em>、
        <em>Initialize (without .gitignore)</em>、<em>Initialize in a specific folder…</em>，
        下面還可以貼一個網址走 <em>Connect to Remote</em>。若子資料夾裡有別的 repo，會列出
        <em>Found {n} Git repo(s) in subfolders</em>；一個工作區有多個 repo 時，
        面板頂端會長出一排 repo 分頁（工作區根目錄那個標成 <code>⌂</code>，每個分頁帶分支名與變更數）。
      </p>
    </section>

    <!-- ── 3 Git：分支與遠端 ────────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">Git：分支與遠端</h2>

      <h3 class="cwh-h3">分支面板</h3>
      <p class="cwh-p">
        面板最底下那顆藥丸顯示目前分支（分離 HEAD 時直接寫 <code>(detached)</code>）與領先／落後數，
        點一下展開分支面板。
      </p>
      <ul class="cwh-list">
        <li>最上面是建立分支的輸入框，提示 <em>New branch name…</em>，右邊 <code>＋</code> 送出。</li>
        <li>
          本地分支每一列有四顆鈕：<code>⇔</code> <em>Compare</em>、<code>⇡</code> <em>Rebase onto</em>、
          <code>⇣</code> <em>Merge into current</em>、<code>↵</code> <em>Switch</em>。
          目前分支只顯示 <code>✓</code>，沒有按鈕。
        </li>
        <li>
          在分支列按右鍵：<em>Merge current branch into {branch}</em>、
          <em>Merge current branch into {branch} &amp; push</em>、<em>Delete Branch</em>。
        </li>
        <li>
          <code>⇅</code> 切換 <em>Show remote branches</em> / <em>Hide remote branches</em>；
          遠端分支每列一顆 <code>⬇</code> <em>Checkout locally</em>。
        </li>
      </ul>
      <p class="cwh-p">
        按 <code>⇔</code> 之後結果直接展在面板裡，標成 <code>{branch} ↔ {current}</code>，
        附統計行與檔案清單。
      </p>

      <h3 class="cwh-h3">遠端操作列</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>鈕</th><th>行為</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in remoteActions" :key="row.control">
              <td class="cwh-nowrap">{{ row.control }}</td>
              <td>{{ row.behavior }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p">
        <code>▾</code> 裡是 <em>↓ Pull</em>、<em>↓ Pull (Rebase)</em>、<em>↑ Push</em>、
        <em>↑ Push (Force with lease)</em>；設了不只一個 remote 時，最後還會多一組
        <strong>Push to remote</strong>，每個 remote 一列。
      </p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">認證失敗先查帳號綁定</div>
        <div class="cwh-callout-text">
          推不上去時，優先看帳號藥丸綁的是不是對的帳號，而不是重設遠端。憑證失效時面板會直接提示到
          「設定 › Accounts」更新。密碼欄位要貼的是 Personal Access Token，不是登入密碼。
        </div>
      </div>
    </section>

    <!-- ── 4 Git：衝突、草稿與歷史 ──────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">Git：衝突、草稿與歷史</h2>

      <h3 class="cwh-h3">衝突</h3>
      <p class="cwh-p">
        merge / rebase / cherry-pick 進行中時，面板頂端會出現橫幅 <code>⚠ {op} in progress</code>
        加上衝突檔案數，右邊一顆 <em>Abort merge</em>（或 <em>Abort rebase</em> /
        <em>Abort cherry-pick</em>）。另有一個對話框標成 <strong>Merge conflict ({n} file(s))</strong>，
        提供 <em>Abort merge</em> 與 <em>Resolve conflicts</em> 兩條路。全部解完之後橫幅換成
        <em>✓ All conflicts resolved — ready to commit merge</em>，附一顆 <em>Go to commit</em>。
      </p>
      <p class="cwh-p">
        單純的整檔取捨用檔案列上的 <code>↰</code> / <code>↱</code> 就好。要逐段處理就進
        <strong>ConflictPane</strong>：
      </p>
      <ul class="cwh-list">
        <li>標題掛 <strong>CONFLICT</strong> 徽章，旁邊寫 <em>{n} / {m} resolved</em>。</li>
        <li>
          每一段衝突可選 <em>Accept Ours</em>、<em>Accept Theirs</em>、<em>Accept Both</em>、
          <em>Accept Base</em>，或 <em>Edit</em> 手改（改完 <em>Confirm</em> / <em>Cancel</em>）。
        </li>
        <li><em>Base</em> 開關會把共同祖先那一版也叫出來對照。</li>
        <li>全部處理完按 <strong>Apply &amp; Stage</strong> 寫回並暫存。</li>
        <li>二進位檔不能三方合併，會直接說 <em>Binary conflict</em>，只能整檔取捨。</li>
        <li>Git 視窗裡另外有一顆 <strong>Resolve with agent</strong>，把衝突整包丟給 CLI agent 去解。</li>
      </ul>

      <h3 class="cwh-h3">Draft（stash）</h3>
      <p class="cwh-p">
        Navide 把 stash 叫做 <strong>Draft</strong>，卡片就在下半部，空的時候寫 <em>No draft</em>。
      </p>
      <ul class="cwh-list">
        <li>
          <strong>存進去</strong>：Changes 段落標題<strong>右鍵</strong> → <em>Save Draft</em>，
          或單一檔案右鍵 → <em>Save File as Draft</em>。對話框標題
          <em>Save as Draft (label optional)</em>，標籤可留空。
        </li>
        <li>
          <strong>拿回來</strong>：每一列三顆鈕——<code>⎘</code> <em>Apply (keep draft)</em>、
          <code>↑</code> <em>Pop (apply &amp; remove)</em>、<code>✕</code> <em>Drop</em>。
        </li>
      </ul>
      <p class="cwh-note">工具列上沒有這顆鈕，只走右鍵選單——第一次找不到是正常的。</p>

      <h3 class="cwh-h3">看變更：四種 diff</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>怎麼開</th><th>看到什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in diffViews" :key="row.how">
              <td>{{ row.how }}</td>
              <td>{{ row.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p">
        面板裡的 History 卡片本身就畫著 SVG 泳道圖，HEAD 那顆點會被標亮。Git History 視窗則是完整表格：
        <strong>Graph / Description / Author / Date / Commit</strong> 五欄，可切 <em>All branches</em>
        或 <em>Current Branch</em>、<em>Date order</em> 或 <em>Ancestor order</em>、
        <em>Show Remote Branches</em>，上方能 <em>Search commits…</em>，下方 <em>Load more</em>。
        在任一個 commit 上按右鍵：<em>Checkout (detached)</em>、<em>Create Branch…</em>、
        <em>Create Tag</em>、<em>Merge into current</em>、<em>Cherry-pick</em>、<em>Revert</em>、
        <em>Reset Current Branch to This Commit…</em>、<em>Copy Commit ID</em>、
        <em>Copy Commit Message</em>。
      </p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">AI Review 會流進 Problems</div>
        <div class="cwh-callout-text">
          BranchDiffPane 裡的 <em>AI Review</em> 產生的意見不是只顯示在旁邊——它們會被寫進編輯器的診斷，
          所以同一批意見在 Mini-IDE 的 <strong>Problems</strong> 分頁（<kbd class="cwh-kbd">⌘⇧M</kbd>）
          也看得到，可以一條一條跳過去修。
        </div>
      </div>
    </section>

    <!-- ── 5 計畫文件：清單與生命週期 ───────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">計畫文件：清單與生命週期</h2>

      <h3 class="cwh-h3">計畫檔放在哪</h3>
      <p class="cwh-p">
        計畫是工作區底下 <code>.agent-team/plans/</code> 裡的檔案，兩種格式都算數：HTML 用
        <code>&lt;kebab-slug&gt;_&lt;6 位十六進位&gt;.html</code>，Markdown 用
        <code>&lt;kebab-slug&gt;.plan.md</code>。底線開頭的檔案（像 <code>_spec.md</code>、
        <code>_template.html</code>）是基礎建設，清單不會列。
      </p>
      <p class="cwh-p">
        這些檔案<strong>由 agent 寫、也由 agent 更新</strong>——你在計畫視窗裡按的每一個動作
        （改 todo 狀態、留審查意見、核准），最後都落回同一個檔案。
        你要做的是叫 agent「幫我建一份計畫」，然後在視窗裡審。
      </p>

      <h3 class="cwh-h3">清單</h3>
      <p class="cwh-p">
        側欄 <strong>Plans</strong> 分頁（<kbd class="cwh-kbd">⌘5</kbd>）與 Plan 視窗左欄用的是同一份清單。
        至少有一份計畫時才會出現工具列：
      </p>
      <ul class="cwh-list">
        <li>搜尋框 <em>Search plans…</em>，比對標題、檔名與 overview。</li>
        <li>Stage 篩選：<em>All stages</em> / Draft / In Review / Approved / In Progress / Done / Abandoned。</li>
        <li>
          排序 <em>Sort by</em>：<strong>Title</strong>、<strong>Last updated</strong>、
          <strong>Progress</strong> 三種，旁邊 <code>↑</code>／<code>↓</code> 換升冪降冪。
        </li>
        <li><code>☰</code> 在「依 stage 分群」與「單一清單」之間切換。</li>
      </ul>
      <p class="cwh-p">
        這四個選擇會<strong>按工作區各自記住</strong>。分區有 <strong>Recent</strong>
        （最多 5 筆，釘選的排最前，也只有這一區有釘選鈕）、<strong>All plans</strong>、
        各個 stage 群組、<strong>Archived</strong>（預設收合），以及底部的 <strong>Completed</strong>
        動作列（<em>Archive all done</em> / <em>Delete all</em>）。每一列會顯示 stage 標籤、
        <em>{done}/{total} done</em> 進度條、格式標籤 <code>html</code> / <code>markdown</code>，
        還有 <em>{count} for you</em>——只有你能清掉的項目數。
      </p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">「Active」不是「進行中」</div>
        <div class="cwh-callout-text">
          清單裡的 <strong>Active</strong> 分區收的是<strong>沒有計畫 metadata 的純文件</strong>
          （每一列都帶 <code>doc</code> 標籤），跟 stage 是不是 <em>in-progress</em> 無關。
          要把這種檔案升級成真正的計畫，在它上面按右鍵選 <strong>Promote to Plan</strong>。
        </div>
      </div>

      <p class="cwh-p">
        列上按右鍵，由上而下：<em>Open</em>、<em>Copy path</em>、（HTML 才有）<em>Share to Git</em>
        與 <em>Rename</em>、<em>Archive</em>／<em>Unarchive</em>、（純文件才有）
        <em>Promote to Plan</em>、<em>Delete</em>。改名要照 <code>kebab-slug_6hex.html</code> 的格式，
        不合規會被擋下。計畫列還可以<strong>直接拖到一個 CLI 面板上</strong>，把目標注入給那個 agent。
      </p>

      <h3 class="cwh-h3">Stage 與 archived 是兩回事</h3>
      <p class="cwh-p">
        生命週期是 <code>draft → in-review → approved → in-progress → done</code>，
        外加一個岔路 <code>abandoned</code>。
      </p>
      <div class="cwh-callout">
        <div class="cwh-callout-title">兩個獨立的軸</div>
        <div class="cwh-callout-text">
          <strong>stage</strong> 回答「這件事走到哪了」；<strong>archived</strong>
          回答「我還想不想在清單裡看到它」。archived 是一個旗標，不是一個 stage——一份
          <em>in-progress</em> 的計畫也可以被封存，一份 <em>done</em> 的計畫也可以留在清單上。
        </div>
      </div>
      <p class="cwh-p">
        還有一條硬規則：<strong>agent 只有在 stage 到了 <code>approved</code>（或更後面）才會動手寫程式。</strong>
        所以「開始」這兩個字的實際意思是——把 stage 推到 approved。
      </p>

      <h3 class="cwh-h3">開起來長什麼樣</h3>
      <p class="cwh-p">
        點清單任一列，會彈出獨立的 <strong>Plan Review 視窗</strong>：左邊計畫清單、中間文件、
        右邊 AI Terminal。<strong>同一個工作區只會有一個這種視窗</strong>——已經開著的時候再點別份，
        是把那個視窗<strong>換頁</strong>，不會再開一個。
      </p>
      <p class="cwh-p">
        文件本體依格式分流：<code>.agent-team/plans/</code> 裡的 HTML 走互動式預覽
        （沙箱 iframe，可以就地編輯章節、對章節留言、點 todo 換狀態）；帶 metadata 的 Markdown 走
        <strong>PlanMarkdownBody</strong>（章節可編輯、todo 可切、mermaid 會畫出來）；
        沒有 metadata 的 Markdown 是唯讀的，也就不會有工具列。
      </p>
    </section>

    <!-- ── 6 計畫文件：審閱工具箱 ───────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">計畫文件：審閱工具箱</h2>
      <p class="cwh-p">
        Plan 視窗上方那條工具列不分格式，左邊是 stage 藥丸、<em>Archived</em> 藥丸（封存時才出現）
        與 <em>{done}/{total} done</em> 進度條，右邊是一排只有圖示的按鈕。視窗變窄時它們會依序收進
        <code>⋯</code>。
      </p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>鈕</th><th>展開什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in planTools" :key="row.tool">
              <td class="cwh-nowrap">{{ row.tool }}</td>
              <td>{{ row.opens }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">Approve 按不下去的兩個原因</div>
        <div class="cwh-callout-text">
          它只在 stage 是 <strong>draft 或 in-review</strong>、而且<strong>所有審查意見都已 Resolve</strong>
          時才亮。停用時的提示就寫著 <em>Requires draft or in-review stage with all notes resolved</em>。
          另外注意：draft 是<strong>直接跳到 approved</strong> 的，工具列上沒有「送審」這顆鈕。
        </div>
      </div>

      <p class="cwh-p"><code>⋯</code> 裡還有兩個值得單獨講的：</p>
      <ul class="cwh-list">
        <li><strong>Outline</strong>——展開成一列一個章節標題，點了就捲到那一段。文件有標題時才出現。</li>
        <li>
          <strong>History</strong>——歷次快照，新的在上，每列一顆 <em>Preview</em>
          （用唯讀模式開舊版，上方有 <em>Back to current plan</em> 可以回來）與一顆 <em>Diff</em>
          （就地列出跟現行版的差異：stage 怎麼變、哪個 todo 換了狀態、增刪幾條、
          review note 差幾則、增減幾行）。
        </li>
      </ul>

      <p class="cwh-note">
        審查意見的<strong>回覆是 agent 寫的</strong>，介面上只讀不寫——你留意見、按 Resolve，
        回覆由 agent 補上。
      </p>

      <h3 class="cwh-h3">右邊那條 AI Terminal</h3>
      <p class="cwh-p">
        新開一個 agent 時，Navide 會自動先餵給它：工作區路徑、目前開著的計畫檔、
        它的名稱／stage／每個 todo 的狀態，以及計畫內容本身。所以你可以直接問
        「這份計畫第三階段的風險是什麼」，不必再貼一次檔案。
      </p>
    </section>

    <!-- ── 7 編輯器視窗 ─────────────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">編輯器視窗</h2>
      <p class="cwh-p">
        <kbd class="cwh-kbd">⌘⇧I</kbd> 開啟，或在 Explorer 點一下檔案。分頁式的 Monaco 編輯器，
        <kbd class="cwh-kbd">⌘1</kbd>…<kbd class="cwh-kbd">⌘9</kbd> 切分頁
        （超出範圍會落到最後一個分頁）。
      </p>

      <h3 class="cwh-h3">左側四個區塊</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>區塊</th><th>快捷鍵</th><th>備註</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in editorSections" :key="row.section">
              <td class="cwh-nowrap">{{ row.section }}</td>
              <td class="cwh-nowrap"><kbd class="cwh-kbd">{{ row.key }}</kbd></td>
              <td>{{ row.note }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note">
        這個區塊叫 <strong>Source Control</strong>，不叫 Git——在 Mini-IDE 裡
        <kbd class="cwh-kbd">⌘⇧G</kbd> 是聚焦到它；同一個組合鍵在主視窗則是開獨立 Git 視窗。
      </p>

      <h3 class="cwh-h3">常用編輯動作</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>動作</th><th>按鍵</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in editorActions" :key="row.action">
              <td>{{ row.action }}</td>
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="key">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
                <span v-if="row.note" class="cwh-keynote">（{{ row.note }}）</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note">
        取代刻意不用 <kbd class="cwh-kbd">⌘H</kbd>，把那個組合留給 macOS 的「隱藏視窗」。
        全部快捷鍵可在設定 ▸ Shortcuts 改，<kbd class="cwh-kbd">⌘K ⌘S</kbd> 開速查表。
      </p>

      <h3 class="cwh-h3">換掉預設編輯器</h3>
      <p class="cwh-p">
        不想用內建編輯器的話，到<strong>設定 ▸ General ▸ Default editor</strong> 改路由。
        選項依序是 <em>Mini-IDE (built in)</em>（預設）、<em>System default application</em>、
        <em>Visual Studio Code</em>、<em>Cursor</em>、<em>Custom command…</em>。
        偵測不到的會變灰並標上「未安裝」，旁邊 <em>Re-detect</em> 可以重掃。
      </p>
      <p class="cwh-p">
        <em>Custom command…</em> 填的是 argv，直接執行、不經 shell，可用的佔位符是
        <code>{file}</code>、<code>{dir}</code>、<code>{line}</code>、<code>{workspace}</code>，
        並附三組現成模板。留空的話仍會用 Mini-IDE 開。
      </p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">macOS 上 code / cursor 預設不在 PATH</div>
        <div class="cwh-callout-text">
          裝了 VS Code 或 Cursor 不等於 <code>code</code> / <code>cursor</code> 指令可用——
          那是另一個要手動做的安裝步驟。Navide 會先查 PATH，查不到就去
          <code>/Applications/&lt;App&gt;.app/…/bin/</code> 找。真的啟動失敗時它會<strong>自動退回
          Mini-IDE</strong>，並跳一次 <em>Editor unavailable</em> 提示
          （同一個編輯器每個 session 只提醒一次）。
        </div>
      </div>

      <p class="cwh-p">
        另外有三種開檔<strong>永遠</strong>走 Mini-IDE，不理會這個設定：diff 與分支比對
        （磁碟上沒有那個檔案可以交出去）、沒有指定檔案的空開啟，
        以及從搜尋或 Git 側欄點進去的開啟。
      </p>
    </section>

    <!-- ── 8 檔案預覽與變更記錄軌 ───────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">檔案預覽與變更記錄軌</h2>

      <h3 class="cwh-h3">預覽支援哪些檔案</h3>
      <p class="cwh-p">
        Navide <strong>只看副檔名</strong>就決定怎麼開（要在讀檔案內容之前就決定）。
        不在下表的一律用文字編輯器開。
      </p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>類型</th><th>副檔名</th><th>怎麼呈現</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in previewTypes" :key="row.kind">
              <td class="cwh-nowrap">{{ row.kind }}</td>
              <td><code>{{ row.extensions }}</code></td>
              <td>{{ row.how }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p">
        Markdown 不在這張表裡，它走另一條路：<code>.md</code> 用 MarkdownPreview，
        但 <code>.plan.md</code> 會被導去計畫視圖。
      </p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">只有 html 與 csv 不自動預覽</div>
        <div class="cwh-callout-text">
          上表其他類型點開<strong>直接是預覽</strong>；html 與 csv 刻意先給你原始碼，
          要按 <em>Preview</em> 才切過去。另外 <code>docx</code>、<code>xlsx</code>、<code>zip</code>、
          <code>woff</code> 這些同時也在二進位清單裡，但字型、壓縮檔、Office 的判斷排在二進位前面，
          所以會拿到專屬的呈現，不會退成 hex dump。
        </div>
      </div>

      <h3 class="cwh-h3">變更記錄軌</h3>
      <p class="cwh-p">
        右槽 <strong>Preview</strong> 分頁（<kbd class="cwh-kbd">⌘⌥V</kbd>）的下半部是
        <strong>Recent changes</strong>——這個工作區最近被動過什麼。每一列四欄：
      </p>
      <ul class="cwh-list">
        <li><strong>時間</strong>——相對值（<em>now</em> / <em>{n}m</em> / <em>{n}h</em> / <em>{n}d</em>）。</li>
        <li>
          <strong>動作</strong>——<code>+</code> created、<code>~</code> modified、
          <code>−</code> deleted、<code>▸</code> shown。
        </li>
        <li><strong>路徑</strong>——太長時中間省略。</li>
        <li>
          <strong>誰做的</strong>——agent 名稱；沒有歸屬資訊時就寫 <code>—</code>，<strong>不會猜</strong>。
        </li>
      </ul>
      <p class="cwh-p">
        上方四顆篩選鈕：<em>All</em> / <em>You</em> / <em>Agent</em> / <em>Watcher</em>。
        點一列可以把那個檔案或 diff 叫回上半部的預覽區（已刪除的列點不動）。
      </p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">關掉視窗也還在</div>
        <div class="cwh-callout-text">
          這份記錄由後端寫進工作區自己的資料庫（<code>&lt;工作區&gt;/.agent-team/navide.db</code>），
          <strong>每個工作區各留最新 300 筆</strong>，關掉視窗、重開 app 都還在。
          它在 app 啟動時就載好，不必先打開右槽。同一個變更如果被檔案監看與 agent 各報一次，
          兩筆會合併成一筆，並以有歸屬的那筆為準——所以你不會看到同一件事出現兩次。
        </div>
      </div>
    </section>

    <!-- ── 9 快捷鍵速查 ─────────────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">快捷鍵速查</h2>
      <p class="cwh-p">
        這一冊涉及的按鍵。完整清單與自訂方式在<strong>設定 ▸ Shortcuts</strong>。
      </p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr><th>按鍵</th><th>動作</th><th>在哪個視窗</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in shortcuts" :key="row.action + row.where">
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="key">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
              </td>
              <td>{{ row.action }}</td>
              <td class="cwh-nowrap">{{ row.where }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">同一個組合鍵在不同視窗做不同的事</div>
        <div class="cwh-callout-text">
          <kbd class="cwh-kbd">⌘⇧G</kbd>、<kbd class="cwh-kbd">⌘⇧M</kbd>、
          <kbd class="cwh-kbd">⌘⇧F</kbd>、<kbd class="cwh-kbd">⌘1</kbd>–<kbd class="cwh-kbd">⌘9</kbd>
          都被三個視窗各自認領過，上表的「在哪個視窗」欄不是補充說明，是判斷條件。另外，
          Git 視窗與 Plan 視窗裡的 AI Terminal 一旦取得焦點，這些鍵全部讓給 CLI，不會被視窗攔走。
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cwh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.cwh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cwh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cwh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.cwh-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.cwh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.cwh-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}
.cwh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cwh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cwh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cwh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.cwh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.cwh-callout--warn .cwh-callout-title {
  color: var(--attention-fg);
}

.cwh-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cwh-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cwh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.cwh-tag {
  font-size: var(--font-2xs);
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 8px;
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.cwh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.cwh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.cwh-table th,
.cwh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cwh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cwh-table tr:last-child td { border-bottom: none; }
.cwh-nowrap { white-space: nowrap; }

.cwh-keycell {
  white-space: nowrap;
}
.cwh-keysep {
  color: var(--text-secondary);
  margin: 0 4px;
}
.cwh-keynote {
  color: var(--text-secondary);
  white-space: normal;
}

.cwh code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.cwh-kbd {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.9em;
  line-height: 1.4;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  color: var(--text-bright);
  white-space: nowrap;
}
</style>
