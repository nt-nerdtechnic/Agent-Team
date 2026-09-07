<script setup lang="ts">
// Read-only reference for the main window's four building blocks — workspace,
// pane, stage layout and sidebar — shown inside Settings → 說明.
// Static mirror of 使用手冊第 1 冊《工作區與面板》; every claim below was
// verified against the codebase when the manual was written. If the layout
// slots, reclaim thresholds or shortcuts change, update this file too.

interface PaneActionRow {
  action: string
  how: string
}

interface StageModeRow {
  mode: string
  behavior: string
}

interface PresetRow {
  preset: string
  effect: string
}

interface SidebarTabRow {
  tab: string
  content: string
  keys: string
}

interface DropTargetRow {
  target: string
  result: string
}

interface InfoPopoverRow {
  where: string
  what: string
}

interface ShortcutRow {
  keys: string
  action: string
}

const paneActions: PaneActionRow[] = [
  { action: '直接開一個', how: '⌘⇧U' },
  { action: '指定第 N 種 CLI', how: 'Ctrl+1 … Ctrl+9' },
  { action: '改名', how: '面板標題雙擊（側欄那一列的 badge 雙擊也可，或右鍵 ▸ Rename）' },
  { action: '關閉焦點面板', how: '⌘W' },
  { action: '重建焦點面板', how: '⌘R' },
  { action: '在面板間循環', how: 'Ctrl+Tab / Ctrl+⇧+Tab' },
]

const stageModes: StageModeRow[] = [
  { mode: 'Grid ⊞', behavior: '全部面板並排。' },
  { mode: 'Sidebar ◧', behavior: '焦點面板佔主要區域，右側一條縮列放其他還在跑的 agent。' },
  { mode: 'Spotlight ◎', behavior: '焦點面板在上，其餘變成下方的縮圖條。' },
  { mode: 'Fullscreen ⧉', behavior: '焦點面板佔滿，其餘收成可展開的浮動小窗。' },
]

const layoutPresets: PresetRow[] = [
  { preset: 'Default', effect: '標準配置。' },
  { preset: 'Focus', effect: '左右兩槽全收成細軌，畫面留給舞台。' },
  { preset: 'Bottom panel', effect: 'History 與 Messages 移到下方橫槽。' },
]

const sidebarTabs: SidebarTabRow[] = [
  { tab: '🤖 Agents', content: '工作區 / 群組 / 面板的樹狀清單', keys: '⌘1' },
  { tab: '🔀 Pipeline', content: '多階段自動流程', keys: '⌘2、⌘⇧Y' },
  { tab: '📁 Explorer', content: '檔案總管', keys: '⌘3、⌘⇧E' },
  { tab: '🌿 Git', content: '版本控制（見「程式碼工作流」分頁）', keys: '⌘4' },
  { tab: '📋 Plans', content: '計畫文件清單（見「程式碼工作流」分頁）', keys: '⌘5、⌘⇧D' },
]

const dropTargets: DropTargetRow[] = [
  { target: '另一列面板上', result: '重新排序' },
  { target: '上方某個 tab 上', result: '換到那個群組' },
  { target: '視窗外', result: '交給另一個視窗，或獨立出去成為新視窗' },
]

const infoPopovers: InfoPopoverRow[] = [
  { where: 'Backend 藥丸', what: '位址與 PID，以及 Restart / Stop 兩顆鈕。' },
  {
    where: '📢 公告徽章',
    what: '公告中心：更新說明與通知條目，可展開內容、Mark all read、直接按 Download / Install 觸發更新、Load more 看更早的。',
  },
  { where: '時鐘', what: '現在時間、本次 session 起始時間、專案建立時間、build 標記。' },
  {
    where: '資源藥丸',
    what: '每個面板的 CPU 與記憶體、總計，可以直接 Reclaim、跳到該面板，或開啟資源控管視窗（見「設定與系統」分頁）。',
  },
]

const shortcuts: ShortcutRow[] = [
  { keys: '⌘O', action: '開啟工作區' },
  { keys: '⌘N', action: '開新視窗' },
  { keys: '⌘⇧U', action: '開一個新面板' },
  { keys: 'Ctrl+1…9', action: '指定第 N 種 CLI 開面板' },
  { keys: '⌘W', action: '關閉焦點面板' },
  { keys: '⌘R', action: '重建焦點面板' },
  { keys: 'Ctrl+Tab', action: '切到下一個面板' },
  { keys: '⌘B', action: '收合側欄' },
  { keys: '⌘1…⌘5', action: '切換側欄分頁' },
  { keys: '⌘⇧E', action: 'Explorer' },
  { keys: '⌘⇧Y', action: 'Pipeline' },
  { keys: '⌘⇧D', action: 'Plans' },
  { keys: '⌘⇧G', action: '開啟獨立的 Git 視窗（不是切側欄分頁）' },
  { keys: '⌘⇧I', action: '開啟編輯器視窗' },
  { keys: '⌘⌥V', action: 'Preview 分頁' },
]
</script>

<template>
  <div class="wph">
    <p class="wph-intro">
      主畫面的四個構件——工作區、面板、舞台版面、側欄——各自是什麼、怎麼操作。
      這是整套說明的第一部分，其餘章節建立在這裡定義的名詞上。
    </p>

    <!-- ── 1 三個名詞 ───────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">1 · 三個名詞</h2>
      <p class="wph-p">Navide 的主畫面由三層構成。先把這三個詞分清楚，後面所有章節都用它們。</p>

      <div class="wph-card">
        <div class="wph-card-title">工作區（Workspace）</div>
        <p class="wph-p">
          一個專案資料夾。它同時是所有 CLI agent 的起點路徑——agent 開在哪個工作區，
          它的工作目錄就在那裡。工作區的私有狀態（面板記錄、群組、歷史、計畫文件）
          存在該資料夾底下的 <code>.agent-team/</code>。
        </p>
      </div>

      <div class="wph-card">
        <div class="wph-card-title">面板（Pane）</div>
        <p class="wph-p">
          一個跑著 CLI agent 的終端機格子。它有名字，而<strong>那個名字就是它的位址</strong>——
          別的 agent 靠這個名字把訊息送給它。一個工作區可以有很多面板。
        </p>
      </div>

      <div class="wph-card">
        <div class="wph-card-title">群組（Run group）</div>
        <p class="wph-p">
          面板的分組容器，對應上方 tab 列的一個分頁。用來把「同一件事」的幾個 agent 收在一起。
          切換群組就是切換舞台上顯示哪一批面板。
        </p>
      </div>

      <div class="wph-callout">
        <div class="wph-callout-title">層級關係</div>
        <div class="wph-callout-text">
          一個視窗可以擺多個工作區；一個工作區底下有多個群組；一個群組底下有多個面板。
          側欄的 Agents 分頁就是照這個順序由上而下排的。
        </div>
      </div>
    </section>

    <!-- ── 2 工作區 ─────────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">2 · 工作區</h2>

      <h3 class="wph-h3">開啟第一個工作區</h3>
      <p class="wph-p">還沒開任何專案時，畫面是一張全螢幕的歡迎卡：</p>
      <ul class="wph-list">
        <li><strong>Browse</strong>——選一個資料夾當工作區。</li>
        <li><strong>New workspace</strong>——建一個新資料夾並直接開啟。</li>
        <li><strong>Open home</strong>——直接用家目錄。</li>
        <li>
          下方是最近開過的清單，可以 pin 常用的。在清單項目上按右鍵有
          <em>Open in default editor</em>、<em>Reveal in Finder</em>、<em>Copy path</em>。
        </li>
      </ul>
      <p class="wph-p">
        之後隨時可以從選單 <strong>File ▸ Open Workspace…</strong>（<kbd class="wph-kbd">⌘O</kbd>）、
        <strong>File ▸ Open Recent</strong>，或 <strong>File ▸ New Window</strong>（<kbd class="wph-kbd">⌘N</kbd>）開新視窗。
      </p>

      <h3 class="wph-h3">同一個視窗擺多個工作區</h3>
      <p class="wph-p">
        不必為第二個專案另開視窗。在側欄 Agents 分頁裡，工作區區段標題右邊有一顆 <strong>＋</strong>，
        按下去會把同一個選擇器叫回來；選中的專案會被收進<strong>同一個視窗</strong>，
        側欄多出一列工作區標題。
      </p>
      <p class="wph-p">
        點該列標題即切換視野。關鍵在於：<strong>被切走的工作區，它的 agent 繼續在跑</strong>，
        那一列也還在側欄上，只是舞台上暫時不顯示它的面板。
      </p>

      <div class="wph-callout wph-callout--warn">
        <div class="wph-callout-title">切換時會換掉什麼</div>
        <div class="wph-callout-text">
          切換工作區會一併換掉上方 tab 列、舞台、Git 面板、檔案總管、計畫清單，以及終端機的工作目錄。
          如果有 pipeline 正在跑，會先跳確認再切。切換過程中舞台會蓋一層載入卡。
        </div>
      </div>

      <p class="wph-p">
        同一個資料夾如果已經在別的視窗開著，Navide 不會重複開一份，而是把那個視窗叫到最前面。
      </p>

      <h3 class="wph-h3">工作區群組（左緣色軌）</h3>
      <p class="wph-p">
        側欄最左緣有一條 8px 寬的色軌。滑鼠移上去會展開飛出選單，可以新增／改名／刪除工作區群組、
        把工作區拖進群組、或選 <strong>All</strong> 看全部。這一層是給「同時管很多專案」的情況用的，
        只有一兩個專案時可以完全忽略。
      </p>
    </section>

    <!-- ── 3 面板 ───────────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">3 · 面板</h2>

      <h3 class="wph-h3">開一個新面板</h3>
      <p class="wph-p">
        入口是 <strong>＋</strong> 按鈕，側欄的工作區標題列和每個群組標題列上各有一顆
        （差別只在新面板落在哪個群組）。按下去會開一個小選單：
      </p>
      <ul class="wph-list">
        <li>最上面是 <strong>Role</strong> 下拉——選一個預設角色。</li>
        <li>中間是 CLI 清單，沒安裝的會標示出來。</li>
        <li>最下面是 <strong>Terminal</strong>（開一般終端機，不掛 agent）與 <strong>Manual spawn…</strong>。</li>
      </ul>
      <p class="wph-p">
        <em>Manual spawn…</em> 開的是完整對話框，可以指定 agent 與角色、決定要不要加進舞台、
        要不要同時開終端機，也可以貼一個 session id 直接接續舊對話。
      </p>

      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>操作</th><th>做法</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in paneActions" :key="row.action">
              <td>{{ row.action }}</td>
              <td>{{ row.how }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="wph-note">
        自動取名的面板，標題後面會有一個小小的 <code>◦</code> 記號；手動改過名字的就沒有。
      </p>

      <h3 class="wph-h3">右鍵選單</h3>
      <p class="wph-p">
        在面板上或側欄那一列按右鍵：<em>Focus</em>、<em>Rename</em>、<em>Send message</em>、
        <em>Interrupt</em>、<em>Reapply role</em>、<em>Remove</em>。其中 <em>Send message</em>
        會把那個面板的位址插進你目前焦點面板的輸入框——這是跨面板傳訊最快的入口。
      </p>

      <h3 class="wph-h3">收合與佔位卡</h3>
      <p class="wph-p">
        面板右上角的 <code>⊟</code> 是最小化。收起來之後側欄那一列會標上 <strong>Docked</strong>，
        展開後有 <em>Restore</em> 與 <em>Remove</em>。
      </p>
      <p class="wph-p">
        另外有一種狀態叫<strong>佔位卡</strong>：位子還在，但顯示一張「↩ 點一下就繼續」的卡片，
        標題、副標、群組標籤全部保留。重開 app、或被閒置回收之後，面板就是這個樣子。
        點卡片任一處，CLI 會接著原本的對話繼續。
      </p>

      <h3 class="wph-h3">閒置自動回收</h3>
      <p class="wph-p">每個跑著的 CLI 都佔著記憶體與 GPU。Navide 預設會把太久沒動靜的面板降級回佔位卡：</p>
      <ul class="wph-list">
        <li><strong>預設開啟</strong>，門檻 30 分鐘，可在設定裡調。</li>
        <li>每 60 秒掃一次，判準是「既沒有輸出、你也沒有打字」。</li>
        <li><strong>這不是關閉</strong>：座位、名字、訊息位址、session 全部留著，點一下就回來。</li>
        <li>正在被 pipeline 讀取、輸入框裡有草稿、有訊息排隊等著送進來、或正在焦點上的面板，都不會被回收。</li>
      </ul>
      <p class="wph-note">
        回收發生時，狀態列會出現 <code>♻ reclaimed N idle CLI pane(s) — click to resume</code>。
      </p>
    </section>

    <!-- ── 4 版面 ───────────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">4 · 版面</h2>

      <h3 class="wph-h3">舞台排列模式</h3>
      <p class="wph-p">tab 列最右邊有四顆小按鈕，決定舞台上的面板怎麼排：</p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>模式</th><th>行為</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in stageModes" :key="row.mode">
              <td class="wph-nowrap"><strong>{{ row.mode }}</strong></td>
              <td>{{ row.behavior }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="wph-p">
        另外有一個不用選的行為叫 <strong>dual-focus</strong>：當剛好有兩個面板在跑，
        它們會自動左右對開，中間那條分隔線可以拖。
      </p>

      <h3 class="wph-h3">Grid 工具列</h3>
      <p class="wph-p">
        面板超過一個時，Grid 模式下會出現一排比例按鈕：<code>∞</code>（自動）、<code>2×1</code>、
        <code>2×2</code>、<code>3×3</code>，右邊還有一組自訂的<strong>欄 × 列</strong>輸入框（1–9）。
        選了固定尺寸之後，放不下的面板會分頁，右側出現 <code>‹ 1/3 ›</code> 翻頁。
        欄與列之間的分隔線可以直接拖。
      </p>

      <h3 class="wph-h3">五槽外殼</h3>
      <p class="wph-p">
        整個視窗被切成五格：<code>up</code>、<code>left</code>、<code>main</code>、
        <code>right</code>、<code>down</code>。
      </p>
      <ul class="wph-list">
        <li><code>main</code> 永遠是 CLI 舞台，不能搬、不能收。</li>
        <li><code>left</code> 可放：Agents、Pipeline、Explorer、Git、Plans。</li>
        <li><code>right</code> 可放：History、Tokens、Tasker、Messages、Preview。</li>
        <li><code>up</code> 與 <code>down</code> 可收 History、Tasker、Messages。</li>
      </ul>
      <p class="wph-p">
        每一槽有自己的 tab 條和一顆收合箭頭，收起來會變成 36px 寬的細軌
        （點細軌上的圖示可以再展開）。槽的邊界可以拖曳改大小。
      </p>

      <h3 class="wph-h3">用設定調版面</h3>
      <p class="wph-p">
        細部調整在 <strong>設定 ▸ Layout</strong>：每個 view 一列，可以指定它去哪一槽、隱藏或還原、
        設為該槽的預設分頁，也能直接填槽寬數值，另有標題列與狀態列的開關和 <em>Reset layout</em>。
        三個現成的 preset：
      </p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>Preset</th><th>效果</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in layoutPresets" :key="row.preset">
              <td class="wph-nowrap"><strong>{{ row.preset }}</strong></td>
              <td>{{ row.effect }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 5 側欄 ───────────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">5 · 側欄</h2>

      <h3 class="wph-h3">五個分頁</h3>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>分頁</th><th>內容</th><th>快捷鍵</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in sidebarTabs" :key="row.tab">
              <td class="wph-nowrap">{{ row.tab }}</td>
              <td>{{ row.content }}</td>
              <td class="wph-nowrap"><kbd class="wph-kbd">{{ row.keys }}</kbd></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="wph-note">
        <kbd class="wph-kbd">⌘B</kbd> 收合整條側欄。安裝的外掛可能再增加分頁。
      </p>

      <h3 class="wph-h3">Agents 分頁的三層結構</h3>
      <p class="wph-p">由上而下是<strong>工作區列 → 群組列 → 面板列</strong>。</p>
      <ul class="wph-list">
        <li>
          <strong>工作區列</strong>：摺疊箭頭、專案名與路徑、面板數，右邊有 <code>↻</code>（重建全部）、
          History、<code>＋</code>。右鍵有 <em>Open in Finder</em>、<em>Copy path</em>、
          移到某個工作區群組、<em>Close workspace</em>。
        </li>
        <li>
          <strong>群組列</strong>：黏在頂端捲動，顯示狀態色點、群組名、成員數，
          以及一顆「在這個群組裡開 agent」的 <code>＋</code>。成員列的左緣有一條中性色細軌，
          表示它們同屬一群。
        </li>
        <li><strong>面板列</strong>：名稱、狀態、Docked 標籤等。</li>
      </ul>

      <div class="wph-callout">
        <div class="wph-callout-title">群組的改名與刪除不在側欄</div>
        <div class="wph-callout-text">
          群組的 rename / delete / detach 是在<strong>上方 tab 列</strong>那個分頁上操作的，
          側欄的群組列只負責顯示與新增面板。
        </div>
      </div>

      <h3 class="wph-h3">血緣縮排</h3>
      <p class="wph-p">
        由 agent 或 MCP 開出來的子面板，會以每層 13px 的縮排掛在父面板底下，
        父列前面有 <code>▾</code> / <code>▸</code> 可以收合整棵子樹。<strong>沒有另外的標籤</strong>——
        縮排本身就代表「這是別人開的，不是你手動開的」。
      </p>

      <h3 class="wph-h3">多選與批次拖曳</h3>
      <ul class="wph-list">
        <li><kbd class="wph-kbd">⌘</kbd> 點：加選單一列。</li>
        <li><kbd class="wph-kbd">⇧</kbd> 點：選整段區間（依畫面上實際顯示的順序，不是內部順序）。</li>
        <li>
          多選之後按右鍵，選單會變成批次版：<em>Interrupt</em>、<em>Rebuild</em>、
          <em>Minimize</em>、<em>Restore</em>、<em>Remove selected</em>。
        </li>
      </ul>
      <p class="wph-p">拖曳任何一個被選中的面板，<strong>整批</strong>會一起被帶走。放在哪決定結果：</p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>放到</th><th>結果</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in dropTargets" :key="row.target">
              <td class="wph-nowrap">{{ row.target }}</td>
              <td>{{ row.result }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 6 狀態列 ─────────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">6 · 狀態列</h2>
      <p class="wph-p">視窗最底那一條。可以在設定 ▸ Layout 關掉。</p>

      <h3 class="wph-h3">左半：環境狀態</h3>
      <ul class="wph-list">
        <li>Git 分支名，有未提交變更時加 <code>*</code>，後面接 <code>↓behind ↑ahead</code>。</li>
        <li><strong>Backend 藥丸</strong>——狀態燈加上位址，可點開。</li>
        <li><strong>資源藥丸</strong>——CPU 與記憶體，有面板在跑時才出現，可點開。</li>
        <li><strong>更新徽章</strong>——有新版／下載中百分比／已下載待重啟／檢查失敗，可點。</li>
      </ul>

      <h3 class="wph-h3">右半：進行中的事</h3>
      <ul class="wph-list">
        <li>Pipeline 進度，例如 <code>Stage 2 / 5</code>。</li>
        <li><code>↻ tidying</code>——背景整理中。</li>
        <li><code>⚠ N leftover</code>——殘留的孤兒終端機行程，點一下清掉。</li>
        <li><code>⚡ N 個 pane 斷線</code>——點開重連挑選器，或按 <code>✕</code> 忽略。</li>
        <li><strong>📢 公告徽章</strong>＋版本號＋未讀數。</li>
        <li>時鐘。</li>
        <li><code>✕</code> 關閉全部 session。</li>
      </ul>

      <h3 class="wph-h3">四個資訊窗</h3>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>點哪裡</th><th>看到什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in infoPopovers" :key="row.where">
              <td class="wph-nowrap">{{ row.where }}</td>
              <td>{{ row.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="wph-callout wph-callout--warn">
        <div class="wph-callout-title">build 標記不是時鐘</div>
        <div class="wph-callout-text">
          時鐘資訊窗裡那個看起來像時間的 build 標記，是這個版本的建置識別，不會跟著現在時間變動。
        </div>
      </div>
    </section>

    <!-- ── 7 快捷鍵速查 ─────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">7 · 快捷鍵速查</h2>
      <p class="wph-p">本章涉及的按鍵。完整清單與自訂方式在<strong>設定 ▸ Shortcuts</strong>。</p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr><th>按鍵</th><th>動作</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in shortcuts" :key="row.keys">
              <td class="wph-nowrap"><kbd class="wph-kbd">{{ row.keys }}</kbd></td>
              <td>{{ row.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wph {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.wph-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.wph-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wph-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.wph-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.wph-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.wph-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}
.wph-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wph-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wph-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.wph-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wph-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.wph-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.wph-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.wph-callout--warn .wph-callout-title {
  color: var(--attention-fg);
}

.wph-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.wph-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.wph-table th,
.wph-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.wph-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.wph-table tr:last-child td { border-bottom: none; }
.wph-nowrap { white-space: nowrap; }

.wph code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.wph-kbd {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 5px;
  white-space: nowrap;
}
</style>
