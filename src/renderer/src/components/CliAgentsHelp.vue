<script setup lang="ts">
// Read-only reference for the CLI agents themselves, shown inside Settings → 說明.
// Static mirror of Navide 使用手冊 第 2 冊：哪些 CLI 內建、怎麼偵測與安裝、角色怎麼
// 套用、設定 ▸ CLI Agents 有什麼、帳號與額度從哪來。表格內容對照過 agentSpecs 與
// 後端 vendor 檔 — 那些改了，這裡要跟著改。

interface VendorRow {
  name: string
  bin: string
  skipFlag: string
  usage: boolean
  multiAccount: boolean
}

interface SourceRow {
  source: string
  when: string
}

interface ActionRow {
  action: string
  detail: string
}

interface BadgeRow {
  display: string
  meaning: string
}

interface TroubleRow {
  symptom: string
  cause: string
  fix: string
}

// ＋ 選單與 Ctrl+1…9 的預設順序。「額度」＝ Navide 讀得到剩餘用量；
// 「多帳號」＝ 可以在設定裡掛多組登入並切換。沒有略過權限旗標的三家
// （Grok CLI、OpenCode、Pi）是因為那些 CLI 本身沒有這個旗標。
const vendors: VendorRow[] = [
  { name: 'Claude Code', bin: 'claude', skipFlag: '--dangerously-skip-permissions', usage: true, multiAccount: true },
  { name: 'Codex', bin: 'codex', skipFlag: '--dangerously-bypass-approvals-and-sandbox', usage: true, multiAccount: true },
  { name: 'Antigravity CLI', bin: 'agy', skipFlag: '--dangerously-skip-permissions', usage: true, multiAccount: false },
  { name: 'Grok CLI', bin: 'grok', skipFlag: '', usage: true, multiAccount: true },
  { name: 'Kimi Code', bin: 'kimi', skipFlag: '--yolo', usage: true, multiAccount: true },
  { name: 'OpenCode', bin: 'opencode', skipFlag: '', usage: true, multiAccount: false },
  { name: 'Qwen Code', bin: 'qwen', skipFlag: '--yolo', usage: true, multiAccount: false },
  { name: 'Kilo Code', bin: 'kilo', skipFlag: '--auto', usage: true, multiAccount: true },
  { name: 'Pi', bin: 'pi', skipFlag: '', usage: true, multiAccount: false },
  { name: 'Copilot CLI', bin: 'copilot', skipFlag: '--yolo', usage: true, multiAccount: false },
  { name: 'Cursor CLI', bin: 'agent', skipFlag: '--force', usage: true, multiAccount: false },
  { name: 'Aider', bin: 'aider', skipFlag: '--yes-always', usage: false, multiAccount: false },
  { name: 'Muse Code', bin: 'muse', skipFlag: '--disable-approval', usage: false, multiAccount: false },
  { name: 'Droid', bin: 'droid', skipFlag: '--auto high', usage: false, multiAccount: false },
]

// 三個入口共用同一個安裝引導對話框，差別只在來源。
const dialogSources: SourceRow[] = [
  {
    source: 'spawn',
    when: '你在 ＋ 選單或 Manual spawn 選了一個沒安裝的 CLI。',
  },
  {
    source: 'pane',
    when: '面板真的開起來但 CLI 找不到——PTY 以 127 結束；或後端啟動前的探測直接回報找不到執行檔（涵蓋 Open Agent、Resume、Handle Issue、pipeline 階段）。',
  },
  {
    source: 'settings',
    when: '設定 ▸ CLI Agents 底部「安裝與更新」清單裡按「安裝」。',
  },
]

const installActions: ActionRow[] = [
  {
    action: '更新（指令）',
    detail: '在真實終端機執行原廠自己的更新指令。沒有官方指令的改成一顆「依官方文件更新」連結。',
  },
  { action: '診斷（指令）', detail: '執行原廠的 doctor 指令。' },
  { action: '安裝', detail: '叫出第 2 章那個安裝引導對話框。' },
  { action: '自動更新', detail: '維持官方預設，或改成手動（只在這裡更新）。' },
  { action: '重新偵測', detail: '右上角，強制重掃一次。' },
]

const accountActions: ActionRow[] = [
  {
    action: '＋ 新增帳號',
    detail: '建一筆 profile，然後開一個暫時的登入面板自動啟動該 CLI 的瀏覽器登入。授權完成後帳號自動變成已登入、面板自己關掉。',
  },
  { action: '登入', detail: '該帳號尚未登入或憑證過期時才出現。' },
  {
    action: '設為預設',
    detail: '切換使用中的帳號。切換期間按鈕變成「切換中…」，且全部帳號的按鈕都暫時停用。',
  },
  { action: '重新偵測額度', detail: '只讀得到 CLI 目前登入中的那個帳號。' },
  { action: '刪除', detail: '就地確認。連同儲存的憑證一起移除。' },
]

const badgeStates: BadgeRow[] = [
  { display: '百分比', meaning: '正常。停留看重置時間與各窗口明細。' },
  {
    display: '讀取中',
    meaning: '剛切完帳號，正在讀新帳號的額度。Claude 要開一次 CLI，最多約一分鐘；期間先顯示上一次的數字。',
  },
  { display: '快取', meaning: '這次沒讀成功，顯示的是上次成功的數字，會附上時間。' },
  { display: '⚠', meaning: '憑證已過期，請在那個 CLI 重新登入。' },
  { display: '找不到 Claude Code', meaning: 'PATH 上沒有這支執行檔，所以讀不到，也沒有快取可退回。' },
  { display: '尚無額度資料', meaning: '還沒讀過。' },
]

const troubleshooting: TroubleRow[] = [
  {
    symptom: '面板一開就結束，或 ＋ 選單標示「（未安裝）」',
    cause: 'PATH 上找不到執行檔（PTY 以 127 結束），或啟動前的探測就找不到。',
    fix: '安裝引導對話框會自己跳出來，跟著三步做完；驗證那一步按「重新啟動 {CLI}」接回面板。如果你之前勾過「不要再詢問」，自動彈出被關掉了——改從 ＋ 選單點那家 CLI，那條路徑一定會開對話框。',
  },
  {
    symptom: '裝好了但仍偵測不到',
    cause: '可能需要一個新的終端機工作階段，或它裝在 PATH 之外。',
    fix: '對話框會直說這件事。到設定 ▸ CLI Agents 按「重新偵測」。若那裡列出多套實體安裝，用「改用這個」指定你要的那一套。',
  },
  {
    symptom: '面板出現 ⚠ 登入過期',
    cause: 'CLI 自己印出了登入過期的訊息。目前只有 Claude Code 與 Droid 有這個偵測。',
    fix: '直接點那個徽章，Navide 會把該 CLI 的登入指令送進面板。成功注入後徽章才會熄滅；失敗會保持亮著讓你再點一次。',
  },
  {
    symptom: '切完帳號後某個帳號說「未登入」或 token 過期',
    cause: '那個帳號閒置期間 token 已經過期。',
    fix: 'Navide 會自己開登入流程並跳通知說明原因。這是把帳號停放太久的正常結果，不是切換弄壞了東西。',
  },
  {
    symptom: '面板停在「偵測 session」的遮罩上',
    cause: 'CLI 還沒寫出 session 檔，通常是它正卡在某個需要你回答的畫面（首次啟動的 API key 提示、信任對話框）。',
    fix: '遮罩有 30 秒的寬限期，時間到就自動撤掉讓你直接操作終端機——偵測本身仍在背景繼續跑。副標會一直寫著偵測中，那是正常的。Aider 沒有 session id，本來就不會有這個遮罩。',
  },
  {
    symptom: '額度顯示不更新',
    cause: '剛切完帳號（Claude 要開一次 CLI，最多約一分鐘）；或這次讀取失敗，正在顯示快取；或那家 CLI 根本沒有可讀的額度來源。',
    fix: '先看徽章詳細視窗裡的「刷新：…」——它會直接說出原因。要立刻重讀就按設定 ▸ Accounts 頁首的「重新偵測額度」（會略過失敗後的等待時間）。注意只有 CLI 目前登入的那個帳號讀得到；停放中的帳號只能顯示快取。',
  },
  {
    symptom: '「有 N 個運行中的 CLI pane 正在使用此帳號」',
    cause: '非 Claude 的 CLI 在有面板跑著時不允許就地換憑證。',
    fix: '關掉那些面板再切；或在確認框選「切換並重啟」，讓 Navide 用 resume 重建它們。太頻繁切換會被 60 秒 3 次的限制擋下，等一下再試。',
  },
  {
    symptom: '調了權限略過，正在跑的面板沒反應',
    cause: '旗標在面板啟動當下就寫死進命令列了。',
    fix: '重建（⌘R）或還原那個面板。',
  },
]
</script>

<template>
  <div class="cah">
    <p class="cah-intro">
      十四家 CLI agent 怎麼裝、怎麼調、怎麼掛多個帳號，以及額度與成本各自從哪裡來。
      名詞（工作區、面板、群組）沿用「工作區與面板」分頁。
    </p>

    <!-- ── 1 · 支援哪些 CLI ─────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">1</span>支援哪些 CLI</h2>
      <p class="cah-p">
        目前內建 <strong>14 家</strong> CLI agent。下表的順序就是 ＋ 選單與
        <kbd class="cah-kbd">Ctrl</kbd>+<kbd class="cah-kbd">1</kbd>…<kbd class="cah-kbd">9</kbd>
        的預設順序（可在設定裡拖曳調整，見第 4 章）。
      </p>

      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>顯示名稱</th>
              <th>執行檔</th>
              <th>略過權限旗標</th>
              <th>額度</th>
              <th>多帳號</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in vendors" :key="row.bin">
              <td>{{ row.name }}</td>
              <td><code>{{ row.bin }}</code></td>
              <td>
                <code v-if="row.skipFlag">{{ row.skipFlag }}</code>
                <span v-else class="cah-no">—</span>
              </td>
              <td :class="row.usage ? 'cah-yes' : 'cah-no'">{{ row.usage ? '✓' : '—' }}</td>
              <td :class="row.multiAccount ? 'cah-yes' : 'cah-no'">
                {{ row.multiAccount ? '✓' : '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cah-note">
        「額度」＝ Navide 讀得到剩餘用量（第 6 章）。「多帳號」＝ 可以在設定裡掛多組登入並切換（第 5 章）。
        三家沒有略過權限旗標的 CLI（Grok CLI、OpenCode、Pi）是因為它們本身就沒有這個旗標，不是 Navide 沒接。
      </p>

      <div class="cah-callout">
        <div class="cah-callout-title">第 15 個選項不是 agent</div>
        <div class="cah-callout-text">
          ＋ 選單最下方的 <strong>Terminal</strong> 是一般 shell，不掛任何 agent，也不會注入角色。
          它刻意獨立放在清單外，不會被 CLI 清單的捲動吃掉。
        </div>
      </div>
    </section>

    <!-- ── 2 · 安裝與偵測 ───────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">2</span>安裝與偵測</h2>
      <p class="cah-p">
        Navide 不自己下載或安裝任何 CLI，它只執行各家原廠自己的指令，而且執行前一定先把完整指令印給你看。
      </p>

      <h3 class="cah-h3">沒安裝的 CLI 長什麼樣</h3>
      <p class="cah-p">
        ＋ 選單與 Manual spawn 的 agent 下拉裡，偵測不到執行檔的那幾家名稱後面會多一個後綴：
        <code>Kimi Code（未安裝）</code>。除此之外<strong>沒有變灰、也沒有被停用</strong>——選項照樣可以點。
      </p>
      <p class="cah-p">
        偵測結果有 10 秒節流，並在這幾個時機重新整理：backend 連上、＋ 選單打開、
        Manual spawn 的 agent 下拉取得焦點。
      </p>

      <h3 class="cah-h3">點下去會發生什麼</h3>
      <p class="cah-p">
        點一個標示未安裝的 CLI，Navide 會先重新偵測一次（可能你剛剛在別的地方裝好了）；
        如果確定還是缺，就不會開一個注定死掉的面板，而是直接叫出安裝引導對話框。
      </p>

      <h3 class="cah-h3">安裝引導對話框</h3>
      <p class="cah-p">三個入口共用同一個對話框，差別只在來源：</p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr><th>來源</th><th>什麼時候出現</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in dialogSources" :key="row.source">
              <td><code>{{ row.source }}</code></td>
              <td>{{ row.when }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p">對話框固定三步：<strong>檢查 → 安裝 → 驗證</strong>。</p>
      <ul class="cah-list">
        <li>
          <strong>檢查</strong>：顯示已安裝／未安裝／版本過舊，以及這台 Mac 上需要幾個步驟
          （例如 Homebrew → Node → CLI 的編號安裝鏈）。無法自動安裝的前置需求另外列出來。
          「即將執行的指令」逐字顯示。
        </li>
        <li>
          <strong>安裝</strong>：指令通常在外部終端機視窗跑，方便你回答它的提問（密碼、登入）。
          安裝鏈會自動接續下一步。
        </li>
        <li>
          <strong>驗證</strong>：偵測到版本後顯示 ✓ 與執行檔路徑。<strong>只有從面板進來的那次</strong>
          （<code>pane</code>）會多一顆「重新啟動 {CLI}」，把剛剛死掉的面板接回來。
        </li>
      </ul>
      <p class="cah-p">
        同一時間只會有一個安裝對話框——一個 pipeline 讓五個同款面板一起 127，也不會疊出五個框。
      </p>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">「暫時不要」不等於「不要再問」</div>
        <div class="cah-callout-text">
          關掉對話框或按<em>暫時不要</em>不會記住任何事，下次還是會問。要真的關掉，
          得勾底部的 <strong>不要再詢問 {CLI}</strong>。這個勾選<strong>只擋自動彈出</strong>
          （面板死掉、啟動前探測失敗這兩種）；你自己從 ＋ 選單點那家 CLI 的時候，對話框永遠會開
          ——那是你主動要求的。勾選是逐家記錄、永久保存，直到你自己取消勾選；沒有時效。
        </div>
      </div>
    </section>

    <!-- ── 3 · 角色 ─────────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">3</span>角色</h2>

      <h3 class="cah-h3">角色是什麼</h3>
      <p class="cah-p">
        一個角色就是<strong>一段系統提示詞</strong>，加上識別碼、名稱、一行摘要。就這四個欄位——
        <strong>角色不綁定 CLI、不帶顏色、不帶參數</strong>。
      </p>
      <p class="cah-p">
        內建五個預設角色：<code>pm</code>、<code>backend</code>、<code>frontend</code>、
        <code>mobile</code>、<code>qa</code>。
      </p>

      <h3 class="cah-h3">在哪裡編輯</h3>
      <p class="cah-p">
        <strong>Pipeline Manager 視窗</strong>（選單 Window ▸ Pipeline Manager）的
        <strong>Roles</strong> 分頁。左邊是角色清單，右邊編輯四個欄位。可以新增、刪除、
        重設為預設值，以及匯出／匯入 JSON。
      </p>
      <p class="cah-note">
        改了角色不會影響已經在跑的面板——編輯區底下就寫著「Changes apply to new spawns only」。
        設定視窗只是讀取同一份角色清單，它自己沒有編輯介面。
      </p>

      <h3 class="cah-h3">開面板時怎麼套用</h3>
      <p class="cah-p">
        ＋ 選單最上方與 Manual spawn 對話框各有一個 <strong>Role</strong> 下拉，兩者共用同一個選擇。
        Manual spawn 裡還可以展開預覽該角色的一行摘要與完整提示詞。
      </p>
      <p class="cah-p">
        套用的機制很直白：<strong>把角色的系統提示詞當成你自己打的字，貼進 CLI 的輸入框並按 Enter</strong>。
        不是改參數、不是寫設定檔。實際貼進去的內容是角色提示詞加上一段固定的待命後綴
        （要求 agent 回覆「準備就緒，等待任務」後停下來），再加上該面板的 session 標記。
      </p>
      <p class="cah-p">
        面板在這個階段的狀態會顯示<strong>注入角色中</strong>。注入前 Navide 會先自動關掉 CLI 的
        啟動信任對話框（送一個 Enter），並等畫面安靜下來再貼。
      </p>

      <div class="cah-callout">
        <div class="cah-callout-title">Terminal 沒有角色</div>
        <div class="cah-callout-text">
          從 ＋ 選單開的一般終端機不帶角色。原因就是上面那句：角色是打進 CLI 提示框的文字，
          shell 只會把它原樣印出來。
        </div>
      </div>

      <h3 class="cah-h3">Reapply role</h3>
      <p class="cah-p">
        面板右鍵選單的 <em>Reapply role</em>——只有面板正在跑、而且它當初帶了角色時才能點。
        它做的事是<strong>再貼一次那段角色提示詞</strong>，不重啟 CLI、不清對話。
      </p>
      <p class="cah-p">
        兩個和第一次注入不同的地方：這次貼的是<strong>純角色提示詞</strong>，不帶待命後綴、
        也不帶 session 標記；而且如果該面板有 kickoff 提示詞，3 秒後會再自動送一次。
      </p>
    </section>

    <!-- ── 4 · 設定 ▸ CLI Agents ────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">4</span>設定 ▸ CLI Agents</h2>
      <p class="cah-p">這個分頁由四段組成。</p>

      <h3 class="cah-h3">1 · CLI Agents 清單</h3>
      <p class="cah-p">
        逐家勾選要不要出現在 ＋ 選單與 Manual spawn 下拉裡，並用左邊的 <code>⠿</code> 拖曳排序——
        這個順序同時決定 <kbd class="cah-kbd">Ctrl</kbd>+<kbd class="cah-kbd">1</kbd>…<kbd class="cah-kbd">9</kbd>
        對應哪一家。至少要保留一家啟用。
      </p>

      <h3 class="cah-h3">2 · 權限略過</h3>
      <p class="cah-p">
        多數 CLI 有一個「略過權限提示」的旗標，讓 agent 無人值守地跑下去。這裡是兩層設定：
      </p>
      <ul class="cah-list">
        <li>最上面一顆<strong>全域開關</strong>：<em>預設略過權限提示（YOLO 模式）</em>。</li>
        <li>
          下面逐家一列，每列顯示該家的實際旗標（例如 <code>--yolo</code>），右邊一個三態下拉：
          <strong>跟隨全域 / 一律略過 / 一律不略過</strong>。
        </li>
      </ul>
      <p class="cah-p">
        沒有旗標的三家（Grok CLI / OpenCode / Pi）不會出現在這份清單裡，
        頁面下方會直接列出它們的名字說明「沒有東西可切換」。
      </p>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">改了不會影響正在跑的面板</div>
        <div class="cah-callout-text">
          旗標是在面板<strong>啟動的那一刻</strong>就寫進它的命令列的。這裡的變更只影響之後開的面板；
          已經在跑的會保留它啟動時的設定，直到你重建或還原它。
        </div>
      </div>

      <h3 class="cah-h3">3 · 推送通道</h3>
      <p class="cah-p">
        四家 CLI（Claude Code、Kilo Code、OpenCode、Qwen Code）可以直接收下訊息，不必把字打進輸入框。
        逐家開關，每一列都寫著那家的代價（開本機埠、寫明文暫存檔、裝背景 hook…）。
        細節見「CLI 互傳訊息」與「MCP」分頁。
      </p>

      <h3 class="cah-h3">4 · 安裝與更新</h3>
      <p class="cah-p">
        每家 CLI 一列，顯示狀態徽章（已安裝／未安裝／版本過舊）、版本號、
        安裝來源（npm / Homebrew / 官方安裝程式 / 官方安裝腳本）與執行檔完整路徑。可用的動作：
      </p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr><th>動作</th><th>做什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in installActions" :key="row.action">
              <td class="cah-nowrap"><strong>{{ row.action }}</strong></td>
              <td>{{ row.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p">
        偵測到<strong>同一家 CLI 有多套實體安裝</strong>時會多出一段清單，逐條列出路徑，
        標出目前作用中的那一套，其餘可以按 <em>改用這個</em> 換掉，
        或 <em>移除</em>（一樣是在終端機跑原廠的移除指令）。
      </p>
      <p class="cah-note">更新會替換執行檔；已經在執行中的面板要重新啟動才會用到新版本。</p>

      <div class="cah-callout">
        <div class="cah-callout-title">這裡沒有的東西</div>
        <div class="cah-callout-text">
          <strong>沒有「預設參數」欄位</strong>，也<strong>沒有模型選擇的介面</strong>。
          執行檔的指定不是打路徑，而是在偵測到多套安裝時從候選裡挑一套。
          模型與 reasoning effort 只有在<strong>由 agent 透過 MCP 開面板</strong>時才能指定——
          12 家接受指定模型，Aider 與 Droid 不行；要求它們指定模型的呼叫會被明確拒絕，
          而不是悄悄用預設值開起來。
        </div>
      </div>
    </section>

    <!-- ── 5 · 帳號 ─────────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">5</span>帳號</h2>
      <p class="cah-p">
        設定 ▸ <strong>Accounts</strong> 一頁裝了兩塊互不相干的東西：上半是 Git 帳號，下半是 CLI 帳號。
      </p>

      <h3 class="cah-h3">CLI 帳號</h3>
      <p class="cah-p">
        14 家都會列出標題，但只有 <strong>5 家支援多帳號</strong>：Claude Code、Codex、Kimi Code、
        Grok CLI、Kilo Code。其餘只印一行「此 agent 不支援多帳號」，連新增按鈕都沒有。
      </p>
      <p class="cah-p">
        每家底下第一張卡片永遠是內建的 <strong>Default</strong>（你原本的登入憑證），
        後面才是你自己加的帳號。卡片上顯示登入身分的 email、<em>預設</em> 標籤，以及該帳號的剩餘額度。
      </p>

      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr><th>操作</th><th>行為</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in accountActions" :key="row.action">
              <td class="cah-nowrap"><strong>{{ row.action }}</strong></td>
              <td>{{ row.detail }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-note">
        這個面板<strong>沒有改名功能</strong>。帳號名稱是自動產生的（Account 1、Account 2…），
        卡片上顯示的是登入身分，名字只是內部識別。
      </p>
      <p class="cah-p">
        兩種刪不掉的情況會被擋下並說明原因：帳號<strong>目前使用中</strong>（請先切到別的帳號），
        或該帳號的<strong>登入程序還在跑</strong>（請先完成或關掉它的登入面板）。
      </p>

      <p class="cah-p">
        <strong>切換時正在跑的 CLI 會怎樣？</strong>Navide 不會砍掉它們。預設行為是<strong>拒絕切換</strong>
        並告訴你「有 N 個運行中的 CLI pane 正在使用此帳號」。如果你堅持，會跳一個確認框：
        <em>切換帳號將重啟 N 個運行中的 {CLI} pane，繼續？</em>
        按下「切換並重啟」後，那些面板是被 <strong>resume 重建</strong>（接回原本的對話），不是被殺掉。
        有面板重建失敗會出一則摘要通知。
      </p>
      <p class="cah-p">
        Claude Code 是例外：它每次請求前都重讀憑證，所以切換是熱替換——不跳確認框、也不重啟任何面板。
      </p>
      <p class="cah-p">切換太頻繁會被擋（每家 CLI 60 秒最多 3 次），確認強制切換也繞不過去。</p>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">已開著的面板保留原帳號</div>
        <div class="cah-callout-text">
          面板上的說明就寫著：「已開啟的 pane 在重開前仍使用原帳號」。
          所有帳號共用你真實的家目錄（session 與歷史是共通的），切換帳號是<strong>就地替換儲存的憑證</strong>。
        </div>
      </div>

      <h3 class="cah-h3">在終端機外部登入，Navide 會知道</h3>
      <p class="cah-p">
        你在自己的終端機直接跑 <code>claude /login</code> 之類的指令，Navide 有一個憑證監看器
        盯著各家 CLI 的憑證檔目錄。檔案變動後約 <strong>0.8 秒</strong>讀一次「身分指紋」，
        指紋沒變就什麼都不做；變了就把「預設」指標移到對應的帳號，並順手觸發一次額度重讀。
        Accounts 面板上的 email、<em>預設</em> 標籤與額度徽章會跟著即時更新。
      </p>
      <p class="cah-p">
        如果 live 憑證對不到任何已登記的帳號，Navide 會<strong>自動用該 email 建一筆 profile</strong>。
        整個過程不會動你的憑證檔，也<strong>不會重啟你的面板</strong>。
      </p>
      <p class="cah-note">
        限制：如果某家 CLI 從來沒登入過（憑證目錄還不存在），要重開 Navide 之後才會開始監看。
      </p>

      <h3 class="cah-h3">Git 帳號</h3>
      <p class="cah-p">
        四個欄位：<strong>名稱、Host</strong>（預設 <code>github.com</code>）<strong>、Username、Token</strong>。
        清單上每列顯示 <code>host · username · ••••後四碼</code>——Token 本體不會回傳給介面。
        編輯時 Token 留空表示沿用舊的。
      </p>
      <p class="cah-p">
        Token 透過作業系統金鑰鏈（safeStorage）加密後存在本機，解密只發生在主行程。
        金鑰鏈不可用時會出現黃色提示，新增按鈕整個不顯示、編輯被停用。
      </p>
      <div class="cah-callout">
        <div class="cah-callout-title">綁定不在這裡做</div>
        <div class="cah-callout-text">
          「這個工作區要用哪個 Git 帳號」是在<strong>側欄的 Git 面板</strong>上那顆帳號膠囊選的。
          設定頁只負責帳號本身的增刪改。刪掉一個帳號時，指向它的綁定會一起清掉。
        </div>
      </div>
    </section>

    <!-- ── 6 · 額度顯示 ─────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">6</span>額度顯示</h2>
      <p class="cah-p">
        額度徽章長在 <strong>CLI 面板的標題列</strong>上（不是狀態列），顯示剩餘百分比；
        滑鼠停留展開詳細視窗，裡面有各個計量窗口、重置時間，以及帳號切換入口。
        設定 ▸ Accounts 的帳號卡片讀的是同一份資料。
      </p>

      <h3 class="cah-h3">涵蓋哪幾家</h3>
      <p class="cah-p">
        <strong>11 家</strong>：Claude Code、Codex、Kimi Code、Grok CLI、Antigravity CLI、OpenCode、
        Qwen Code、Kilo Code、Pi、Copilot CLI、Cursor CLI。Aider、Muse Code、Droid 沒有可讀的額度來源。
      </p>

      <h3 class="cah-h3">資料從哪來</h3>
      <ul class="cah-list">
        <li>
          <strong>Claude Code 是特例</strong>：Navide 完全不碰它的憑證，而是去跑
          <code>claude -p /usage</code>，讀 CLI 自己印出來的額度報表。
          因此讀一次要啟動一整個 Claude Code，需要幾秒。
        </li>
        <li>
          <strong>其餘 10 家</strong>：讀取該 CLI 已經存在本機的憑證，去查那家供應商自己的用量 API。
          <strong>只讀不寫</strong>——token 的更新一律留給擁有那個檔案的 CLI 自己做。
        </li>
      </ul>
      <p class="cah-note">
        除了少數幾家有官方查詢途徑之外，多數 CLI 並沒有「查額度」的官方指令，
        Navide 走的是各家供應商的用量端點。查不到的一律誠實顯示為「無官方查詢途徑」，不會猜、不會補值。
      </p>

      <h3 class="cah-h3">徽章上會出現的幾種狀態</h3>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr><th>顯示</th><th>意思</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in badgeStates" :key="row.display">
              <td class="cah-nowrap">{{ row.display }}</td>
              <td>{{ row.meaning }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p">
        徽章的開關與刷新間隔在<strong>設定 ▸ General</strong>（不在 CLI Agents 分頁）。
        詳細視窗裡的「刷新：…」一行會直說這次為什麼沒更新：找不到憑證、憑證已過期、受到速率限制、
        無官方查詢途徑、未量測、失敗。
      </p>
    </section>

    <!-- ── 7 · 閒置回收與 CLI 成本 ──────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">7</span>閒置回收與 CLI 成本</h2>
      <p class="cah-p">
        每個跑著的 CLI 都佔著一塊<strong>啟動就配置、之後不再釋放</strong>的記憶體——
        設定頁上的說法是「每個常是 200–300 MB」。開十幾個面板，這件事就會變成整台機器的問題。
      </p>
      <p class="cah-p">
        所以 Navide 預設會把太久沒動靜的面板降級回<strong>佔位卡</strong>：結束那個行程，
        位子、名字、訊息位址全部留著，點一下就從 CLI 自己的紀錄接回對話。
      </p>
      <ul class="cah-list">
        <li>門檻可選 15 分鐘 / 30 分鐘 / 1 小時 / 3 小時 / 8 小時 / 永不回收（預設 30 分鐘），在設定 ▸ General。</li>
        <li>目前聚焦中的、正在等你回答的、輸入框裡有未送出文字的面板，都不會被回收。</li>
        <li>同一段設定裡有一顆 <strong>立即回收</strong>，會先告訴你現在有幾個面板符合條件、大約佔多少。</li>
      </ul>
      <p class="cah-note">
        回收的完整行為（含佔位卡長什麼樣）在「工作區與面板」分頁；
        逐面板的 CPU／記憶體數字與資源控管視窗在「設定與系統」分頁。
      </p>
    </section>

    <!-- ── 8 · 疑難排解 ─────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">8</span>疑難排解</h2>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr><th>症狀</th><th>可能原因</th><th>怎麼辦</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in troubleshooting" :key="row.symptom">
              <td>{{ row.symptom }}</td>
              <td>{{ row.cause }}</td>
              <td>{{ row.fix }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cah {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.cah-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cah-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cah-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
  display: flex;
  align-items: center;
  gap: 8px;
}
.cah-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  font-weight: 700;
}

.cah-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.cah-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}

.cah-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.cah-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cah-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cah-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cah-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.cah-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.cah-callout--warn .cah-callout-title {
  color: var(--attention-fg);
}

.cah-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.cah-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.cah-table th,
.cah-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cah-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cah-table tr:last-child td { border-bottom: none; }

.cah-nowrap { white-space: nowrap; }
.cah-yes { color: var(--text-bright); }
.cah-no { color: var(--text-secondary); }

.cah code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
  word-break: break-all;
}

.cah-kbd {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.88em;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text-bright);
  white-space: nowrap;
}
</style>
