<script setup lang="ts">
// Read-only icon reference, shown inside Settings → 說明.
// This is where a user looks up "介面上這顆按鈕是幹嘛的": every icon below is
// drawn with the same path data the real surface uses, so the shapes match
// what is on screen. Static mirror — if a surface changes its icon, this file
// has to be updated by hand.
//
// Most rows keep their icon cell in the template, because the icon column is
// sometimes an inline SVG, sometimes a Unicode glyph, sometimes a colour dot,
// and sometimes just the word 「文字」. Only the two purely textual tables use
// data rows.

interface StageBadgeRow {
  badge: string
  color: string
  meaning: string
  canStart: string
}

interface TextButtonRow {
  name: string
  where: string
  effect: string
}

// Plan stage badges. The progress bar under the badge uses the same palette,
// so the two are always consistent.
const stageBadges: StageBadgeRow[] = [
  { badge: 'Draft', color: '灰', meaning: '草稿，還在寫。', canStart: '不能' },
  { badge: 'In Review', color: '黃', meaning: '等你審。', canStart: '不能' },
  { badge: 'Approved', color: '藍', meaning: '已核准。', canStart: '可以' },
  { badge: 'In Progress', color: '橘', meaning: '執行中。', canStart: '可以' },
  { badge: 'Done', color: '綠', meaning: '完成。', canStart: '—' },
  { badge: 'Abandoned', color: '紅', meaning: '放棄。', canStart: '—' },
]

// The Messages panel has no icons at all — every control is a text button.
const messageButtons: TextButtonRow[] = [
  {
    name: 'Pause delivery / Resume delivery',
    where: '面板標題列',
    effect: '暫停或恢復整條訊息遞送。暫停期間訊息會排隊，不會送進面板。',
  },
  {
    name: 'Clear log',
    where: '面板標題列',
    effect: '清掉這份紀錄的顯示（不影響已送達的訊息）。',
  },
  {
    name: 'Withdraw',
    where: '還在排隊的訊息列上',
    effect: '撤回這則訊息。只在它還沒送達前有效。提示字串是 Take this message back before it reaches the target pane。',
  },
  {
    name: 'Resend',
    where: '送失敗或已撤回的訊息列上',
    effect: '再送一次。',
  },
]
</script>

<template>
  <div class="irh">
    <p class="irh-intro">
      按鈕圖示查詢表：看到介面上某顆按鈕，來這裡查它叫什麼、在哪一區、按下去會發生什麼。
      每一顆都對應程式碼裡實際存在的圖示，名稱欄保留原始的英文 <code>title</code> / <code>aria-label</code>。
    </p>

    <div class="irh-callout">
      <div class="irh-callout-title">怎麼用這張表</div>
      <div class="irh-callout-text">
        先看畫面上那顆按鈕在哪一區，翻到對應章節，用「圖示」欄比對外形。
        名稱欄是滑鼠停留時會浮出的原始提示字串——分不出來時，把滑鼠停在按鈕上一秒，
        浮出來的字直接對得上這一欄。
      </div>
    </div>

    <!-- ── 1 側欄 ───────────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">1 · 側欄</h2>

      <h3 class="irh-h3">分頁列</h3>
      <p class="irh-p">
        側欄頂端一排分頁。<strong>展開時</strong>顯示下表的線稿圖示；<strong>收合成細軌時</strong>，
        Agents / Pipeline / Explorer / Plans 四個改用 emoji（🤖 🔀 📁 📋），
        只有 Git 沒有 emoji、細軌上仍畫同一顆 SVG。
      </p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm0 4.5a1.25 1.25 0 1 1 2.5 0A1.25 1.25 0 0 1 2 8Zm0 4.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM6.5 2.75A.75.75 0 0 1 7.25 2h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5A.75.75 0 0 1 7.25 6.5h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Z"/></svg>
              </td>
              <td><code>Agents (⌘1)</code></td>
              <td>側欄分頁列第 1 顆</td>
              <td>切到 agent 樹狀清單。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h3.5C6.216 0 7 .784 7 1.75v3.5A1.75 1.75 0 0 1 5.25 7H4v4a1 1 0 0 0 1 1h4v-1.25C9 9.784 9.784 9 10.75 9h3.5c.966 0 1.75.784 1.75 1.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-.75H5A2.5 2.5 0 0 1 2.5 11V7h-.75A1.75 1.75 0 0 1 0 5.25Zm1.75-.25a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Zm9 9a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Z"/></svg>
              </td>
              <td><code>Pipeline (⌘2)</code></td>
              <td>分頁列第 2 顆</td>
              <td>切到多階段自動流程。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z"/></svg>
              </td>
              <td><code>Explorer (⌘3)</code></td>
              <td>分頁列第 3 顆</td>
              <td>切到檔案總管。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
              </td>
              <td><code>Git (⌘4)</code></td>
              <td>分頁列第 4 顆</td>
              <td>切到版本控制。右上角有數字徽章時，那是未提交的變更檔數（超過 99 顯示 <code>99+</code>）。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2a1 1 0 0 0-1 1H2.75A1.75 1.75 0 0 0 1 4.75v9.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 14.25v-9.5A1.75 1.75 0 0 0 13.25 3H12a1 1 0 0 0-1-1H5Zm0 2h6v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Zm-2.25.5H4a2.5 2.5 0 0 0 2 1h4a2.5 2.5 0 0 0 2-1h1.25a.25.25 0 0 1 .25.25v9.5a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25v-9.5a.25.25 0 0 1 .25-.25Z"/></svg>
              </td>
              <td><code>Plans (⌘5)</code></td>
              <td>分頁列第 5 顆</td>
              <td>切到計畫文件清單。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◇</span></td>
              <td>外掛自訂</td>
              <td>分頁列尾端</td>
              <td>外掛提供的分頁。外掛沒帶圖示時就顯示這顆菱形當替身。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">‹</span></td>
              <td><code>Collapse panel</code></td>
              <td>分頁列最右</td>
              <td>把整條側欄收成細軌。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">工作區列</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1"/><path d="M4 9.5h5"/></svg>
              </td>
              <td><code>Collapse all folders</code> / <code>Expand all folders</code></td>
              <td>Agents 區段標題列</td>
              <td>一次收合或展開所有工作區。全部收起時圖示裡那一橫會多一豎變成加號。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>Open workspace…</code></td>
              <td>Agents 區段標題列</td>
              <td>叫出工作區選擇器，把另一個專案收進<strong>同一個視窗</strong>。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 12.5v-9h4l1.5 2h7v7z"/></svg>
              </td>
              <td>（無提示字串）</td>
              <td>每一列工作區名稱前</td>
              <td>純標記，表示這一列是一個工作區資料夾。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span> / <span class="irh-glyph">⌄</span></td>
              <td><code>Expand subtree</code> / <code>Collapse subtree</code></td>
              <td>工作區列最左</td>
              <td>收合這個工作區底下的群組與面板。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>Rebuild every resumable CLI pane…</code></td>
              <td>工作區列右側</td>
              <td>把這個工作區裡每個可續接的 CLI 面板整批重建。會打斷進行中的回合並重印對話。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h-1A1.5 1.5 0 0 0 3 5v8.5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-1"/><rect x="5.5" y="1.5" width="5" height="3" rx="1"/><path d="M5.75 8h4.5M5.75 11h3"/></svg>
              </td>
              <td><code>History</code></td>
              <td>工作區列右側</td>
              <td>打開這個工作區的 agent 歷史紀錄。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M14 8.6V4.25A1.75 1.75 0 0 0 12.25 2.5h-8.5A1.75 1.75 0 0 0 2 4.25v7.5A1.75 1.75 0 0 0 3.75 13.5H8.6"/><path d="M4.9 5.9 7.4 8.4 4.9 10.9"/><path d="M12.25 9.75v5M9.75 12.25h5"/></svg>
              </td>
              <td><code>Open Agent</code>（後面接目前選定的 CLI 名稱）</td>
              <td>工作區列最右</td>
              <td>
                開新面板的主入口。按下去彈出 Role 下拉＋CLI 清單＋Terminal／Manual spawn。
                工作區路徑還沒設定時會變成 <code>Set workspace path first</code> 且不可按。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>New group</code></td>
              <td>側欄最左緣色軌的飛出選單</td>
              <td>新增一個<strong>工作區群組</strong>（管很多專案時才用得到的分類層）。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">群組列與面板列</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span> / <span class="irh-glyph">⌄</span></td>
              <td><code>Expand subtree</code> / <code>Collapse subtree</code></td>
              <td>群組列最左</td>
              <td>收合這一群的成員。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>Open an agent in this group</code></td>
              <td>群組列最右</td>
              <td>同樣是開新面板，差別在新面板直接落進<strong>這個群組</strong>。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▸</span> / <span class="irh-glyph">▾</span></td>
              <td><code>Expand subtree</code> / <code>Collapse subtree</code></td>
              <td>面板列最左（有子面板時才出現）</td>
              <td>
                收合這個 agent 開出來的子面板整棵樹。<strong>注意</strong>：工作區與群組用的是
                <code>›/⌄</code>，血緣用的是 <code>▸/▾</code>，兩組不同。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>Named automatically from this session's first instruction…</code></td>
              <td>面板名稱右側</td>
              <td>純記號：這個名字是自動取的。改過名字就不再出現。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td><code>Stage manager — controls flow and decides ---STAGE-DONE---</code></td>
              <td>面板名稱旁，顯示為 <code>🎯 Mgr</code></td>
              <td>純記號：這個面板是 pipeline 的階段總管。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
              </td>
              <td><code>Docked in sidebar</code></td>
              <td>面板列上，顯示為圖示＋<code>Docked</code></td>
              <td>純標籤：這個面板已經收起來了，只剩側欄這一列。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td>（無提示字串）</td>
              <td>面板列右側</td>
              <td>展開這一列的詳細資訊（session id、Interrupt 等）。展開後箭頭轉 90 度朝下。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>Rebuild (resume the conversation) ⌘R</code></td>
              <td>面板列右側</td>
              <td>只重建這一個面板。沒有可續接的 session 時會變灰，提示改成「先送一則訊息」。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td><code>Minimize to sidebar</code></td>
              <td>面板列最右</td>
              <td>把面板收起來，只留側欄這一列。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚙</span></td>
              <td><code>Manage pipelines</code></td>
              <td>Pipeline 分頁標題列</td>
              <td>打開 Roles / Pipelines 管理視窗。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↺</span></td>
              <td><code>Discard all stage progress and re-run from Stage 01</code></td>
              <td>Pipeline 的 Resume 卡片，按鈕文字 <code>↺ Start over</code></td>
              <td>放棄已跑的階段進度，從第一階段重來（會先要你確認）。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 2 面板本體 ───────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">2 · 面板本體</h2>

      <h3 class="irh-h3">標題列</h3>
      <p class="irh-p">由左到右。多數按鈕只在對應狀態下才出現，所以你不會一次看到全部。</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>Rebuild (resume the conversation) ⌘R</code></td>
              <td>標題列最左</td>
              <td>
                關掉再以 <code>--resume</code> 用目前尺寸重開，用來清掉重畫不掉的殘影。
                <strong>會打斷進行中的回合並重印整段對話。</strong>
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td><code>Minimize to sidebar</code></td>
              <td>rebuild 右側</td>
              <td>把面板收進側欄，座位讓出來。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>Named automatically from this session's first instruction — rename it and it stays yours</code></td>
              <td>標題文字右側</td>
              <td>純記號：名字是自動取的。雙擊標題改名後就消失。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td><code>Global Manager — coordinates across stages…</code></td>
              <td>標題文字旁，顯示 <code>🎯 Mgr</code></td>
              <td>純記號：這是 pipeline 的總管面板。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td><code>Loop — send the configured loop prompt to this pane</code></td>
              <td>標題列</td>
              <td>開始／停止自動循環：每回合結束就自動把設定好的 loop 提示再送一次。滑鼠停在上面會浮出提示技能環。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td><code>∞ Loop</code>（進行中徽章）</td>
              <td>標題列，loop 跑起來後取代上面那顆</td>
              <td>顯示循環狀態；等待中會顯示倒數。點一下處理目前的等待。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td><code>⚠ Login expired</code> ／ 提示 <code>The CLI's login has expired — click to send its login command</code></td>
              <td>標題列</td>
              <td>這個 CLI 的登入過期了。<strong>點一下會直接把登入指令送進面板。</strong></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td>額度徽章的警告狀態</td>
              <td>標題列最右</td>
              <td>額度讀不到時顯示。滑鼠停上去看原因：憑證過期、CLI 不在 PATH，或是正在讀取。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">數字</span></td>
              <td><code>Remaining quota — hover for details</code></td>
              <td>標題列最右</td>
              <td>
                剩餘額度。滑鼠移上去展開帳號清單。讀取中顯示 <code>reading</code>；
                快取值會有 <code>Cached quota</code> 的提示。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td>（清單項目，無獨立提示）</td>
              <td>額度浮層的帳號清單</td>
              <td>純記號：打勾那個是目前使用中的帳號。點其他列即切換帳號。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">～</span></td>
              <td>（無提示字串）</td>
              <td>額度浮層裡百分比數字前</td>
              <td>純記號：這個數字是舊快照，不是剛讀到的。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>Add / manage accounts…</code></td>
              <td>額度浮層底部</td>
              <td>跳到設定裡的 CLI 帳號頁。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↻</span></td>
              <td><code>↻ Continue</code> ／ 提示 <code>This session was restored and is waiting at the prompt…</code></td>
              <td>終端機畫面下方</td>
              <td>面板是重啟後還原的、停在提示符不動時才出現。按下去送出 <em>continue</em>，把工作接回去。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">佔位卡</h3>
      <p class="irh-p">重開 app、或被閒置回收之後，面板會變成一張卡片。</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↩</span></td>
              <td><code>Click to resume</code>（進行中變 <code>Resuming…</code>）</td>
              <td>卡片正中央</td>
              <td>把 CLI 叫回來、接著原本的對話繼續。<strong>點卡片任何一處都有效</strong>，不必瞄準這顆按鈕。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td><code>Minimize to sidebar</code></td>
              <td>卡片右上角</td>
              <td>連卡片也收進側欄。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>Named automatically…</code></td>
              <td>卡片標題旁</td>
              <td>純記號，同上。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 3 舞台與 tab 列 ──────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">3 · 舞台與 tab 列</h2>

      <h3 class="irh-h3">四顆排列模式鈕</h3>
      <p class="irh-p">在 tab 列右端。四顆都是符號，不是圖檔。</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊞</span></td>
              <td><code>Grid — show all panes</code></td>
              <td>tab 列右端第 1 顆</td>
              <td>所有面板並排。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◧</span></td>
              <td><code>Sidebar — show the selected pane with the Active agents list</code></td>
              <td>第 2 顆</td>
              <td>焦點面板佔主區，旁邊一條列出還在跑的 agent。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◎</span></td>
              <td><code>Spotlight — show the selected pane with thumbnails</code></td>
              <td>第 3 顆</td>
              <td>焦點面板放大，其餘變縮圖條。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⧉</span></td>
              <td><code>Fullscreen — fill the workspace with the selected pane</code></td>
              <td>第 4 顆</td>
              <td>焦點面板佔滿整個工作區。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">Grid 比例工具列</h3>
      <p class="irh-p">只在 Grid 模式、且面板超過一個時出現。</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td><code>Auto — fit all panes</code></td>
              <td>比例列第 1 顆</td>
              <td>自動塞下全部面板，不分頁。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">2×1</span></td>
              <td><code>2×1 layout — pages of 2 panes</code></td>
              <td>比例列</td>
              <td>固定每頁 2 格。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">2×2</span></td>
              <td><code>2×2 layout — pages of 4 panes</code></td>
              <td>比例列</td>
              <td>固定每頁 4 格。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">3×3</span></td>
              <td><code>3×3 layout — pages of 9 panes</code></td>
              <td>比例列</td>
              <td>固定每頁 9 格。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">×</span></td>
              <td><code>Custom columns</code> / <code>Custom rows</code></td>
              <td>比例列右側兩個輸入框，中間是 <code>×</code></td>
              <td>自己填欄數與列數（1–9），按 Enter 或離開欄位就套用。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">‹</span></td>
              <td><code>Previous page</code></td>
              <td>比例列最右，頁碼左邊</td>
              <td>上一頁面板。已在第一頁時是灰的。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span></td>
              <td><code>Next page</code></td>
              <td>頁碼右邊</td>
              <td>下一頁面板。中間的 <code>1/3</code> 是目前頁／總頁數。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">tab 列本身</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td><code>刪除此 tab</code></td>
              <td>每個 tab 的右側</td>
              <td>該 tab 沒有面板時直接刪掉；還有面板時會先跳選單問你要「移到其他分組」還是「關閉所有 pane」。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">+</span></td>
              <td><code>新增 Pipeline 區塊</code></td>
              <td>tab 列末端</td>
              <td>新增一個分組（tab）。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>Rebuild every resumable CLI pane in the active tab…</code></td>
              <td>tab 列最末端</td>
              <td>把目前這個 tab 裡所有可續接的面板整批重建。執行中圖示會轉。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 4 狀態列 ─────────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">4 · 狀態列</h2>

      <h3 class="irh-h3">左半：環境狀態</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              </td>
              <td>（無提示字串）</td>
              <td>狀態列最左，後面接分支名</td>
              <td>純顯示：目前的 Git 分支。分支名後面的 <code>*</code> 表示有未提交的變更。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span> <span class="irh-glyph">↑</span></td>
              <td>（無提示字串）</td>
              <td>分支名後面</td>
              <td>純顯示：落後遠端幾個 commit（<code>↓</code>）、領先幾個（<code>↑</code>）。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">色點</span></td>
              <td><code>backend</code> / <code>backend down</code> / <code>connecting…</code></td>
              <td>狀態列左半</td>
              <td>後端連線狀態，色點跟著狀態變色。點開有位址、PID 與 <em>Restart</em> / <em>Stop</em>。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▤</span></td>
              <td><code>CLI resources</code></td>
              <td>狀態列左半，顯示為 <code>▤ 3</code> 這種形式</td>
              <td>目前有幾個面板在跑，以及 CPU／記憶體。點開看每個面板的用量，可以直接回收或跳過去。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>↑</code>＋版本號</td>
              <td>狀態列左半</td>
              <td>有新版可下載。點一下開始處理更新。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span></td>
              <td><code>↓</code>＋百分比</td>
              <td>同上位置</td>
              <td>
                更新下載中。下載完會換成 <code>Update ready</code> 或 <code>Restart for new version</code>；
                失敗則是 <code>Update failed</code> / <code>Update check failed</code>。
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">右半：進行中的事</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↻</span></td>
              <td><code>Backfilling historical token usage in the background</code>，顯示 <code>↻ tidying token history…</code></td>
              <td>狀態列右半</td>
              <td>純顯示：背景正在回填歷史用量。不必理它。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td><code>Leftover CLI processes</code>，顯示 <code>⚠ N leftover</code></td>
              <td>狀態列右半</td>
              <td>有殘留的孤兒終端機行程。<strong>點一下把它們清掉。</strong></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚡</span></td>
              <td><code>{count} conversation(s) may have been disconnected — click to recover</code></td>
              <td>狀態列右半</td>
              <td>有面板斷線。點文字開重連挑選器。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td><code>Dismiss</code></td>
              <td>緊接在 <code>⚡</code> 那條後面</td>
              <td>忽略這次的斷線提示，不做重連。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">📢</span></td>
              <td><code>Announcements</code></td>
              <td>狀態列右半，後面接版本號與未讀數</td>
              <td>打開公告中心：更新說明與通知，可展開內容、全部標為已讀、直接觸發下載／安裝。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">時間</span></td>
              <td><code>Time</code></td>
              <td>狀態列右半</td>
              <td>
                點開看現在時間、本次 session 起始、專案建立時間與 build 標記。
                <strong>build 標記不是時鐘</strong>，不會跟著走。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td><code>Close all sessions and tabs (history kept)</code></td>
              <td>狀態列最右</td>
              <td>關掉所有 session 與 tab。歷史會保留。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 5 Git 面板 ───────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">5 · Git 面板</h2>

      <h3 class="irh-h3">面板頂端工具列</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM1.5 8a.75.75 0 1 1 1.5 0A.75.75 0 0 1 1.5 8zm.75 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 3.5h9.5a.75.75 0 0 0 0-1.5h-9.5a.75.75 0 0 0 0 1.5zM4 8.75h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5zm0 5.5h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5z"/></svg>
              </td>
              <td><code>Switch to List View</code></td>
              <td>工具列（目前是樹狀時顯示這顆）</td>
              <td>把變更檔案改成平鋪清單。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12v1.5H2zm0 3.5h12V9H2zm0 3.5h12v1.5H2z"/></svg>
              </td>
              <td><code>Switch to Tree View</code></td>
              <td>工具列（目前是清單時顯示這顆）</td>
              <td>把變更檔案改成資料夾樹。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1"/><path d="M4 9.5h5"/></svg>
              </td>
              <td><code>Collapse all folders</code></td>
              <td>工具列（只在樹狀模式）</td>
              <td>把所有資料夾收起來。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
              </td>
              <td><code>Refresh</code></td>
              <td>工具列</td>
              <td>重讀一次 Git 狀態。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><path d="M5.5 1.5v13M1.5 5.5h4"/></svg>
              </td>
              <td><code>Open in New Window</code></td>
              <td>工具列（側欄模式才有）</td>
              <td>把 Git 面板拉到獨立視窗。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7 5v3.5l3 1.5-.5 1L6 9V5z"/></svg>
              </td>
              <td><code>Diff Review</code></td>
              <td>工具列（內嵌在編輯器視窗時才有）</td>
              <td>開一個合併差異＋審查的分頁。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">···</span></td>
              <td><code>More options</code></td>
              <td>工具列最右</td>
              <td>
                檢視選單：清單／樹狀、依名稱／路徑／狀態排序、顯示被忽略的檔案。
                目前生效的項目前面有 <code>✓</code>。
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">檔案列（Changes / Staged Changes）</h3>
      <p class="irh-p">
        這一區的按鈕全是符號，同一顆符號在「資料夾列」「單檔列」「區段標題」上重複出現，作用範圍不同而已。
      </p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>Stage</code> / <code>Stage folder</code> / <code>Stage All</code></td>
              <td>Changes 區的單檔列／資料夾列／區段標題</td>
              <td>把這個檔案、這個資料夾底下全部、或全部變更加入暫存。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">−</span></td>
              <td><code>Unstage</code> / <code>Unstage folder</code> / <code>Unstage All Changes</code></td>
              <td>Staged Changes 區對應位置</td>
              <td>把已暫存的內容退回未暫存。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↩</span></td>
              <td><code>Discard</code> / <code>Discard folder</code> / <code>Discard All Changes</code></td>
              <td>Changes 區對應位置</td>
              <td><strong>丟掉修改</strong>，把檔案還原成上一次提交的樣子。會先確認。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊡</span></td>
              <td><code>File history + blame</code></td>
              <td>單檔列</td>
              <td>展開這個檔案的歷史與逐行歸屬。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↰</span></td>
              <td><code>Accept Ours</code></td>
              <td>衝突檔案列（狀態 <code>U</code>）</td>
              <td>整檔採用「我們這邊」的版本解衝突。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↱</span></td>
              <td><code>Accept Theirs</code></td>
              <td>衝突檔案列</td>
              <td>整檔採用「對方那邊」的版本解衝突。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              </td>
              <td>（無提示字串，旁邊是資料夾路徑）</td>
              <td>樹狀模式的資料夾列</td>
              <td>純標記。點整列可收合／展開該資料夾。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H3.75zm6.75.56v2.19c0 .138.112.25.25.25h2.19L10.5 2.06z"/></svg>
              </td>
              <td><code>Open diff in editor</code></td>
              <td>History 展開某個 commit 後的檔案清單</td>
              <td>在編輯器開啟那個檔案在該 commit 的差異。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">Commit 區</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▾</span></td>
              <td><code>More options</code></td>
              <td>Commit 按鈕右邊</td>
              <td>展開下表六個動作。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td><code>Commit</code></td>
              <td>▾ 選單</td>
              <td>提交已暫存的內容。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✎</span></td>
              <td><code>Amend Commit</code></td>
              <td>▾ 選單</td>
              <td>把這次的內容併進上一個 commit。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>Commit &amp; Push</code></td>
              <td>▾ 選單</td>
              <td>提交後直接推上遠端。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td><code>Commit &amp; Sync</code></td>
              <td>▾ 選單</td>
              <td>提交後先拉再推。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↺</span></td>
              <td><code>Undo Last Commit</code></td>
              <td>▾ 選單</td>
              <td>撤銷上一個 commit（變更留在工作區）。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✦</span></td>
              <td><code>Auto Commit</code></td>
              <td>▾ 選單</td>
              <td>切換自動提交開關。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⟳</span></td>
              <td>（無提示字串）</td>
              <td>Commit 訊息欄</td>
              <td>純顯示：AI 正在幫你生成 commit 訊息。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">分支列與遠端列</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
              </td>
              <td>分支藥丸（顯示目前分支名）</td>
              <td>遠端動作列最左</td>
              <td>展開／收合分支面板。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.622 0zM8 1.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
              </td>
              <td><code>Account for this workspace</code></td>
              <td>分支藥丸右邊</td>
              <td>選這個工作區要用哪組 Git 帳號推送。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
              </td>
              <td><code>Fetch</code></td>
              <td>遠端動作列</td>
              <td>抓遠端的最新狀態，不動你的工作區。執行中會換成轉動的 <code>⟳</code>。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span></td>
              <td><code>Pull</code></td>
              <td>遠端動作列</td>
              <td>把遠端的 commit 拉下來。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>Push</code> / <code>Publish Branch</code></td>
              <td>遠端動作列</td>
              <td>推上去。後面的數字是領先幾個 commit；分支還沒有遠端時變成 Publish。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td><code>Sync (pull --rebase + push)</code></td>
              <td>遠端動作列</td>
              <td>一次做完先拉（rebase）再推。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▾</span></td>
              <td><code>More pull/push options</code></td>
              <td>遠端動作列最右</td>
              <td>展開 Pull、Pull (rebase)、Push、Push (force with lease)，以及多個 remote 的個別推送。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇔</span></td>
              <td><code>Compare</code></td>
              <td>分支面板的每一列（非目前分支）</td>
              <td>比較那個分支與目前分支的差異。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇡</span></td>
              <td><code>Rebase onto</code></td>
              <td>分支列</td>
              <td>把目前分支重定基底到那個分支上。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇣</span></td>
              <td><code>Merge into current</code></td>
              <td>分支列</td>
              <td>把那個分支合併進目前分支。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↵</span></td>
              <td><code>Switch</code></td>
              <td>分支列</td>
              <td>切換到那個分支。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td><code>Show remote branches</code> / <code>Hide remote branches</code></td>
              <td>分支面板頂端</td>
              <td>清單裡要不要一併列出遠端分支。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⬇</span></td>
              <td><code>Checkout locally</code></td>
              <td>遠端分支列（本地還沒有這個分支時）</td>
              <td>把遠端分支拉成本地分支並切過去。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">Stash 與 Worktree</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⎘</span></td>
              <td><code>Apply (keep draft)</code></td>
              <td>Stash 卡片的每一列</td>
              <td>套用這份草稿，但草稿留著。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>Pop (apply &amp; remove)</code></td>
              <td>Stash 列</td>
              <td>套用並把草稿從清單移除。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td><code>Drop</code></td>
              <td>Stash 列</td>
              <td>直接丟掉這份草稿。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↗</span></td>
              <td><code>Open remote URL</code></td>
              <td>Remotes 卡片</td>
              <td>在瀏覽器打開這個 remote 的網址。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⧉</span></td>
              <td><code>Open in New Window</code></td>
              <td>Worktrees 卡片的每一列</td>
              <td>用新視窗打開那個 worktree。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◱</span></td>
              <td><code>Reveal in Finder</code></td>
              <td>Worktree 列</td>
              <td>在 Finder 顯示該資料夾。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🔒</span> <span class="irh-glyph">🔓</span></td>
              <td><code>Lock</code> / <code>Unlock</code></td>
              <td>Worktree 列</td>
              <td>鎖住／解鎖這個 worktree，防止被清理。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇄</span></td>
              <td><code>Move</code></td>
              <td>Worktree 列</td>
              <td>把 worktree 搬到別的路徑。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td><code>Remove</code></td>
              <td>Worktree 列</td>
              <td>移除這個 worktree。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              </td>
              <td><code>Browse folder</code></td>
              <td>新增 worktree 的輸入列</td>
              <td>用檔案選擇器挑放置位置。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>Add worktree</code></td>
              <td>新增 worktree 列最右</td>
              <td>照上面填的路徑與分支建立 worktree。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="irh-callout irh-callout--warn">
        <div class="irh-callout-title">同一顆符號在不同區意思不同</div>
        <div class="irh-callout-text">
          <code>↑</code> 在遠端列是 Push、在 Stash 列是 Pop；<code>⇅</code> 在遠端列是 Sync、
          在分支面板頂端是「顯示遠端分支」；<code>✕</code> 在 Stash 是丟棄草稿、在 Worktree 是移除 worktree。
          先確認你在哪一區，再對照。
        </div>
      </div>
    </section>

    <!-- ── 6 計畫視窗 ───────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">6 · 計畫視窗</h2>
      <p class="irh-p">
        計畫文件上方那條工具列。<strong>這裡全部是符號，沒有一顆是圖檔。</strong>
        視窗變窄時按鈕會由右往左收進 <code>⋯</code> 選單——Todos 最先被收、Approve 最後——
        所以同一份文件在不同寬度下看到的按鈕數量不一樣。
      </p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">文字</span></td>
              <td>stage 徽章（<code>Draft</code> / <code>In Review</code> / <code>Approved</code> / <code>In Progress</code> / <code>Done</code> / <code>Abandoned</code>）</td>
              <td>工具列最左</td>
              <td>純顯示：這份計畫走到哪個階段。顏色見下表。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">☑</span></td>
              <td><code>Todos</code></td>
              <td>工具列</td>
              <td>開關下方的待辦清單面板。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">💬</span></td>
              <td><code>Review Notes · N unresolved</code></td>
              <td>工具列，右上角帶未解決數字</td>
              <td>
                開關審查留言面板。<strong>只有還有未解決留言時才出現這顆</strong>；
                沒有未解決留言時，入口在 <code>⋯</code> 選單裡。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td><code>Execute</code> ／ 提示 <code>Dispatch this approved plan to a CLI agent</code></td>
              <td>工具列</td>
              <td>
                展開 CLI agent 選擇面板，把這份計畫派給某個 agent 執行。
                <strong>只有 stage 是 approved 時才出現。</strong>
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td><code>Approve</code>（不可按時提示 <code>Requires draft or in-review stage with all notes resolved</code>）</td>
              <td>工具列</td>
              <td>把 stage 改成 approved 並蓋上核准時間。留言沒清完、或階段不對就是灰的。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⋯</span></td>
              <td><code>More actions</code></td>
              <td>工具列最右，永遠都在</td>
              <td>
                溢位選單：Outline、Review Notes、History、Share to Git、Open in Browser、
                Reopen、Archive／Unarchive、Abandon、Delete，以及被收進來的常駐按鈕。
              </td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▸</span></td>
              <td><code>Outline</code></td>
              <td><code>⋯</code> 選單內</td>
              <td>展開文件章節錨點清單，點標題直接跳過去。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td>清除章節錨點</td>
              <td>新增留言的輸入框旁</td>
              <td>把這則留言掛的章節取消，改成整份文件層級的留言。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">狀態字</span></td>
              <td><code>Click to cycle status; right-click to toggle skipped</code></td>
              <td>每一則 todo 前面（顯示 <code>pending</code> / <code>in-progress</code> / <code>done</code> / <code>skipped</code>）</td>
              <td>左鍵循環切換狀態，右鍵切換「略過」。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">stage 徽章的顏色</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>徽章</th><th>顏色</th><th>意思</th><th>能不能動工</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in stageBadges" :key="row.badge">
              <td><code>{{ row.badge }}</code></td>
              <td class="irh-nowrap">{{ row.color }}</td>
              <td>{{ row.meaning }}</td>
              <td class="irh-nowrap">{{ row.canStart }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="irh-note">徽章下方的進度條用同一組顏色，兩者永遠一致。</p>
    </section>

    <!-- ── 7 右側 rail 與 Messages ──────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">7 · 右側 rail 與 Messages</h2>

      <h3 class="irh-h3">右側五個分頁</h3>
      <p class="irh-p">
        同一批分頁有兩種長相：<strong>收合成細軌時是 emoji</strong>，
        <strong>展開後的分頁列是線稿圖示</strong>。兩欄放在一起對照。
      </p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3 8a5 5 0 1 1 10 0A5 5 0 0 1 3 8Z"/><path d="M7.4 4.5h1.2v3.4h2.9v1.2H7.4Z"/></svg>
              </td>
              <td><code>History</code>（細軌上是 📜）</td>
              <td>右側 rail 第 1 個</td>
              <td>看過去的 agent 對話紀錄。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5h2.25v6H2.5Z"/><path d="M6.9 3.5h2.25v10H6.9Z"/><path d="M11.3 6h2.25v7.5H11.3Z"/></svg>
              </td>
              <td><code>Tokens</code>（細軌上是 📊）</td>
              <td>rail 第 2 個</td>
              <td>token 用量統計。細軌上這一顆旁邊的小數字就是目前累計量。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 3h8.5A1.75 1.75 0 0 1 14 4.75v8.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-8.5A1.75 1.75 0 0 1 3.75 3Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25Z"/><path d="M2.75 6.5h10.5V8H2.75Z"/><path d="M5 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 5 1Zm6 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 11 1Z"/></svg>
              </td>
              <td><code>Schedule</code>（細軌上是 🗓）</td>
              <td>rail 第 3 個</td>
              <td>排程任務。<strong>介面上寫的是 Schedule，不是 Tasker。</strong></td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 3h10.5A1.75 1.75 0 0 1 15 4.75v6.5A1.75 1.75 0 0 1 13.25 13H2.75A1.75 1.75 0 0 1 1 11.25v-6.5A1.75 1.75 0 0 1 2.75 3Zm0 1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25Z"/><path d="M2.4 5.32a.75.75 0 0 1 1.04-.22L8 8.1l4.56-3a.75.75 0 1 1 .82 1.26l-4.97 3.26a.75.75 0 0 1-.82 0L2.62 6.36a.75.75 0 0 1-.22-1.04Z"/></svg>
              </td>
              <td><code>Messages</code>（細軌上是 ✉）</td>
              <td>rail 第 4 個</td>
              <td>跨面板訊息的收送紀錄。</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5c3.1 0 5.7 2.1 6.9 4.2a.6.6 0 0 1 0 .6C13.7 10.4 11.1 12.5 8 12.5S2.3 10.4 1.1 8.3a.6.6 0 0 1 0-.6C2.3 5.6 4.9 3.5 8 3.5Zm0 1.5C5.6 5 3.4 6.6 2.3 8c1.1 1.4 3.3 3 5.7 3s4.6-1.6 5.7-3C12.6 6.6 10.4 5 8 5Z"/><path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>
              </td>
              <td><code>Preview</code>（細軌上是 👁）</td>
              <td>rail 第 5 個</td>
              <td>檔案預覽與變更記錄軌。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span></td>
              <td><code>Collapse</code></td>
              <td>展開後的分頁列末端</td>
              <td>把整條 rail 收回細軌。細軌上任一顆圖示則是「展開並切到該分頁」。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⟲</span></td>
              <td><code>Reset run counter</code> / <code>Wipe workspace history</code> / <code>Wipe global tally</code></td>
              <td>Tokens 分頁的三個統計區塊各一顆</td>
              <td>把該範圍的統計歸零。三顆的作用範圍不同：本次執行、這個工作區、全域。會先確認。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">Messages 面板</h3>
      <div class="irh-callout irh-callout--warn">
        <div class="irh-callout-title">這一區沒有圖示</div>
        <div class="irh-callout-text">
          Messages 面板上的按鈕<strong>全部是文字按鈕</strong>，沒有任何符號或圖示可以比對。要找的話認文字：
        </div>
      </div>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>作用</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in messageButtons" :key="row.name">
              <td class="irh-icocell"><span class="irh-plain">文字</span></td>
              <td><code>{{ row.name }}</code></td>
              <td>{{ row.where }}</td>
              <td>{{ row.effect }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 8 狀態色與記號 ───────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">8 · 狀態色與記號</h2>
      <p class="irh-p">這些不是按鈕，但是使用者最常問「這個點是什麼顏色代表什麼」的地方。</p>

      <h3 class="irh-h3">面板列的圓點（側欄每一列面板前面）</h3>
      <p class="irh-p">圓形、8px。顏色<strong>可以在設定裡自訂</strong>，下表是出廠預設。</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>樣子</th><th>狀態</th><th>意思</th><th>要不要理它</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="running"></span>綠色、緩慢呼吸</td>
              <td><code>running</code></td>
              <td>agent 正在跑。</td>
              <td>等就好。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="starting"></span>黃色、快速呼吸</td>
              <td><code>starting</code></td>
              <td>正在啟動。</td>
              <td>等就好。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="idle"></span>藍色、靜止</td>
              <td><code>idle</code></td>
              <td>開著但沒事做。</td>
              <td>可以下指令。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="awaiting"></span>橘色、呼吸＋光暈</td>
              <td><code>awaiting</code></td>
              <td>
                <strong>CLI 問了你問題，卡在那裡等答案。</strong>
                做成會動的樣式就是為了不讓它看起來像「沒事發生」。
              </td>
              <td>去回答它。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="waiting"></span>空心圓環（灰邊）</td>
              <td><code>waiting</code></td>
              <td>還沒真的開起來的佔位列。</td>
              <td>點一下才會起來。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="error"></span>紅色、靜止＋光暈</td>
              <td><code>error</code></td>
              <td>出錯了。</td>
              <td>要看。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="exited"></span>深灰、半透明</td>
              <td><code>exited</code></td>
              <td>已經結束。</td>
              <td>可重建或移除。</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="stopped"></span>中性灰</td>
              <td><code>stopped</code> / <code>disconnected</code></td>
              <td>停掉或斷線。</td>
              <td>斷線可從狀態列的 <code>⚡</code> 重連。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">群組列與 tab 上的方點</h3>
      <p class="irh-p">
        圓角方形、7px，跟上面的圓點<strong>刻意做成不同形狀</strong>，因為它講的是一整群、不是單一面板。
        側欄群組列與上方 tab 用的是同一套規則、同一組顏色，共四態；
        <strong>橘色排在綠色之前</strong>——一群裡只要有一個面板在等你回應，
        整群就顯示橘，即使旁邊還有面板在跑：
      </p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>顏色</th><th>狀態</th><th>提示字串（群組列 ／ tab）</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="awaiting"></span>橘</td>
              <td><code>awaiting</code></td>
              <td>
                <code>Needs you — an agent in this group is blocked on a permission or a question</code> ／
                <code>A CLI in this tab is waiting on you</code>
              </td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="active"></span>綠</td>
              <td><code>active</code></td>
              <td>
                <code>Running — an agent in this group is active</code> ／
                <code>Some CLIs in this tab are running</code>
              </td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="idle"></span>藍</td>
              <td><code>idle</code></td>
              <td>
                <code>Idle — agents are open, none running</code> ／
                <code>Every CLI in this tab is idle</code>
              </td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="empty"></span>中性灰</td>
              <td><code>empty</code></td>
              <td>
                <code>Not opened — every pane here is waiting to be restored</code> ／
                <code>This tab has no panes</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="irh-callout">
        <div class="irh-callout-title">三態，不是兩態</div>
        <div class="irh-callout-text">
          綠與藍是「有東西在裡面」的兩種狀態；灰是第三態——這一群全部都還沒真的開起來（或根本沒有面板）。
          看到灰點不代表壞掉。
        </div>
      </div>

      <h3 class="irh-h3">其他記號</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr><th>圖示</th><th>名稱</th><th>位置</th><th>意思</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>Named automatically from this session's first instruction — rename it and it stays yours</code></td>
              <td>面板標題與側欄面板列的名稱右側</td>
              <td>這個名字是系統從本次 session 第一則指令自動取的。<strong>你手動改過名之後就永久消失。</strong></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td><code>Global Manager</code> / <code>Stage manager</code>，顯示為 <code>🎯 Mgr</code></td>
              <td>面板標題與側欄面板列</td>
              <td>這個面板是 pipeline 的階段總管，負責判斷每個階段何時結束。</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td>（無提示字串）</td>
              <td>側欄面板列右側</td>
              <td>可展開更多資訊。展開後轉 90 度朝下。與計畫視窗的 <code>▶ Execute</code> 是不同的東西。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.irh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 92ch;
}

.irh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.irh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.irh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.irh-callout--warn .irh-callout-title { color: var(--attention-fg); }
.irh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.irh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}

.irh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.irh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.irh-h3 {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.irh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.irh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* This page has four-column tables with long English tooltip strings in them,
   so horizontal scrolling matters more here than anywhere else in 說明. */
.irh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.irh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.irh-table th,
.irh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.irh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.irh-table tr:last-child td { border-bottom: none; }
.irh-nowrap { white-space: nowrap; }

/* Fixed, centred icon column so the shapes line up down the table and stay
   comparable at a glance — that is the whole point of this page. */
.irh-icocell {
  width: 62px;
  min-width: 62px;
  text-align: center;
  white-space: nowrap;
}

/* Icons follow the text colour so both themes are correct without a second
   palette. Filled and stroked variants match how each surface draws them. */
.irh-ic {
  width: 17px;
  height: 17px;
  display: inline-block;
  vertical-align: -3px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-primary);
}
.irh-ic--filled {
  fill: currentColor;
  stroke: none;
}
.irh-glyph {
  font-size: 15px;
  color: var(--text-primary);
}
.irh-plain {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}

/* Swatches for chapter 8. These reuse the same tokens the real indicators use
   (ControlPane's .status-dot and StageTabBar's .tab-dot), so a recoloured
   theme moves the sample and the real thing together. They are static — the
   live dots animate, this page just names the colour. */
.irh-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 7px;
  vertical-align: 1px;
  background: var(--text-muted);
}
.irh-dot[data-state='running'] { background: var(--success-fg); }
.irh-dot[data-state='starting'] { background: var(--status-starting-fg); }
.irh-dot[data-state='idle'] { background: var(--status-idle-fg); }
.irh-dot[data-state='awaiting'] {
  background: var(--warning-fg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning-fg) 25%, transparent);
}
.irh-dot[data-state='waiting'] {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-secondary);
}
.irh-dot[data-state='error'] {
  background: var(--danger-fg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-fg) 25%, transparent);
}
.irh-dot[data-state='exited'] {
  background: var(--text-disabled);
  opacity: 0.6;
}
.irh-dot[data-state='stopped'] { background: var(--text-muted); }

.irh-sq {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 7px;
  vertical-align: 1px;
  background: var(--border-default);
}
.irh-sq[data-state='awaiting'] { background: var(--warning-fg); }
.irh-sq[data-state='active'] { background: var(--success-fg); }
.irh-sq[data-state='idle'] { background: var(--status-idle-emphasis); }

.irh code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}
</style>
