<script setup lang="ts">
// Read-only reference for how MCP is used in Navide, shown inside Settings →
// 說明. The two directions below are genuinely separate subsystems that happen
// to share a protocol name; conflating them is the usual confusion.

interface ToolRow {
  name: string
  what: string
}

interface CompareRow {
  aspect: string
  provide: string
  consume: string
}

const planTools: ToolRow[] = [
  { name: 'plan_list', what: '列出這個工作區的所有計畫，含階段與待辦進度' },
  { name: 'plan_read', what: '讀取一份計畫的完整內容' },
  { name: 'plan_create', what: '建立新計畫（從草稿開始）' },
  { name: 'plan_update_stage', what: '推進階段：草稿 → 審查中 → 已核准 → 進行中 → 完成' },
  { name: 'plan_update_todo', what: '更新單一待辦的狀態' },
  { name: 'plan_add_note', what: '寫入發現或決策的紀錄' },
]

const cliTools: ToolRow[] = [
  { name: 'cli_list_targets', what: '有哪些 CLI pane 在線上、位址怎麼寫、對方是否忙碌' },
  { name: 'cli_send', what: '把任意指令送給指定的 pane（同工作區或跨工作區視窗），回傳查詢用的 msg_key；位址填 group 則廣播給自己分頁群組裡的其他 pane' },
  { name: 'cli_send_and_wait', what: '送出指令並等對方把這回合做完，順便帶回它最後說了什麼' },
  { name: 'cli_check_message', what: '用 msg_key 查一則送出的訊息後來如何：排隊中、已送達、或失敗與原因（只留最近一小時）' },
  { name: 'cli_open_agent', what: '開一個新的 CLI pane 並指派任務，完成後它會回報' },
  { name: 'cli_read_log', what: '讀取另一個 pane 對話紀錄的結尾（預設 200 行），也可帶游標只讀新增的部分' },
  { name: 'cli_get_status', what: '查另一個 pane 是否忙碌、最近一次活動' },
  { name: 'cli_wait_idle', what: '等到另一個 pane 閒置或逾時（最長 120 秒）；逾時會說明是卡在權限提示、還在做事、還是連不上' },
]

const uiTools: ToolRow[] = [
  { name: 'ui_list_actions', what: '列出目標視窗目前註冊的所有動作 id' },
  { name: 'ui_invoke', what: '呼叫一個註冊動作（例如開新 pane、切分頁、開設定）' },
  { name: 'ui_snapshot', what: '取得目標視窗目前的 UI 狀態快照（pane、分頁、焦點…）' },
]

const comparison: CompareRow[] = [
  {
    aspect: '誰是 server',
    provide: 'Navide',
    consume: '外部服務（Context7、GitHub…）',
  },
  {
    aspect: '誰在呼叫',
    provide: 'pane 裡的 CLI agent',
    consume: 'Navide 後端',
  },
  {
    aspect: '在哪設定',
    provide: '不用設定，開 pane 就自動接上',
    consume: '設定 → MCP',
  },
  {
    aspect: '什麼時候作用',
    provide: 'agent 想用的時候',
    consume: '只在流程（pipeline）啟動時',
  },
  {
    aspect: '做什麼',
    provide: '操作 Navide：計畫、傳訊、開 agent',
    consume: '讀取技術文件，附加到開場提示',
  },
]
</script>

<template>
  <div class="mh">
    <p class="mh-intro">
      MCP（Model Context Protocol）是一套讓 AI agent 呼叫外部工具的通用協定。
      Navide 用到它的地方有<strong>三個方向</strong>，彼此除了協定同名之外沒有關係——
      這是最常見的誤解來源，所以先分清楚。
    </p>

    <div class="mh-dirs">
      <div class="mh-dir">
        <div class="mh-dir-arrow">CLI agent → Navide</div>
        <div class="mh-dir-title">Navide 提供工具</div>
        <p class="mh-dir-text">
          pane 裡的 agent 可以反過來操作 Navide：讀寫計畫、傳訊給其他 pane、開新的 agent。
          <strong>不需要任何設定</strong>，開 pane 時自動接上。
        </p>
      </div>
      <div class="mh-dir">
        <div class="mh-dir-arrow">Navide → 外部服務</div>
        <div class="mh-dir-title">Navide 取用文件</div>
        <p class="mh-dir-text">
          Navide 後端連到外部 MCP server 讀取技術文件，附加到流程的開場提示裡。
          在<strong>設定 → MCP</strong> 設定，<strong>只在跑流程時作用</strong>。
        </p>
      </div>
      <div class="mh-dir">
        <div class="mh-dir-arrow">外部 client → Navide</div>
        <div class="mh-dir-title">外部控制</div>
        <p class="mh-dir-text">
          Navide process 之外的 client（腳本、另一個 agent……）也能操作 Navide 本身。
          <strong>預設關閉</strong>，要在<strong>設定 → MCP → External access</strong> 手動開啟。
        </p>
      </div>
    </div>

    <!-- ── 方向一 ───────────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">方向一：Navide 提供給 CLI agent 的工具</h2>
      <p class="mh-p">
        pane 一啟動，agent 的工具清單裡就會多出這些。你不需要教它，也不用設定——
        直接用中文交代就好，例如「幫我把這份計畫的第二階段標成完成」。
      </p>

      <h3 class="mh-h3">計畫文件</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="t in planTools" :key="t.name">
              <td class="mh-tool"><code>{{ t.name }}</code></td>
              <td>{{ t.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note">
        計畫是 agent 用這些工具寫出來的 HTML，你在 Navide 的計畫視窗閱讀與核准。
        agent 只有在階段推進到「已核准」之後才會開始寫程式。
      </p>

      <h3 class="mh-h3">與其他 CLI 協作</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="t in cliTools" :key="t.name">
              <td class="mh-tool"><code>{{ t.name }}</code></td>
              <td>{{ t.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note">
        詳細用法見本頁的「CLI 互傳訊息」主題。
        「等對方做完」是盡力而為：多數 CLI（含 Cursor）會自己回報回合結束，
        Kimi／Grok／Pi／Qwen 是靠 8 秒沒動靜推論的。回傳的 <code>source</code> 就是在講
        這次的「做完」有多可信，這幾家請當作參考而不是保證。
        若等待途中對方的視窗被關掉、pane 被砍掉，<code>source</code> 會是
        <code>target_lost</code>：訊息確實送出去了，只是已經無法確認它做完沒有——
        這不是送出失敗，不要重送。
      </p>
      <p class="mh-note">
        同一個工作區裡可以有兩個 pane 同名，這時候光靠名字說不清要找誰，
        上面幾個工具會直接以 <code>ambiguous-target</code> 拒絕，而不是隨便挑一個。
        要指定其中一個，就把 <code>cli_list_targets</code> 回傳的 <code>pane_id</code>
        當參數傳給 <code>cli_send</code>、<code>cli_send_and_wait</code>、
        <code>cli_read_log</code>、<code>cli_get_status</code> 或
        <code>cli_wait_idle</code>，這時候位址參數就不用填了。
        平常還是用名字比較好讀；pane 換了新的 CLI 重開之後 id 會換一個，
        遇到 <code>unknown-pane-id</code> 重新查一次即可。跨裝置的 pane 沒有本機 id，
        只能用名字定址。
      </p>
      <p class="mh-note">
        <code>cli_send</code> 的位址填 <code>group</code>，不是去找名叫 group 的 pane，而是廣播給
        <strong>自己所在分頁群組</strong>裡的其他 pane（同工作區）。這跟裸行協定的
        <code>all</code> 不一樣：<code>all</code> 是整個視窗、不分群組。沒有分到任何
        群組的 pane 共用同一個隱含群組，所以它們彼此送得到，而不是誰也送不到。
        回傳的形狀也不一樣：<code>recipients</code> 裡每個收件者各有一個
        <code>msg_key</code>，要分別拿去 <code>cli_check_message</code> 查；空的
        <code>recipients</code> 代表你的群組裡沒有別人，不是失敗。代價與
        <code>all</code> 相同：真的取名叫 group 的 pane 從此無法用名字定址。
      </p>

      <h3 class="mh-h3">哪些 CLI 接得到</h3>
      <p class="mh-p">
        目前只有 <strong>Claude Code</strong> 與 <strong>Codex</strong>。
        這兩家的 CLI 支援在啟動時用參數指定 MCP server，Navide 就是這樣接上的——
        不會去改你自己的 MCP 設定檔。其他 CLI 要嘛不支援這種接法，要嘛只能改設定檔，
        目前沒有接。
      </p>
      <p class="mh-note">
        接線是 <strong>pane 啟動當下</strong>做的。所以功能更新後，已經開著的 pane
        還是舊的工具清單——關掉重開才會拿到新的。
      </p>
    </section>

    <!-- ── 方向二 ───────────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">方向二：Navide 取用外部 MCP</h2>
      <p class="mh-p">
        這是<strong>設定 → MCP</strong> 那一頁在管的東西。Navide 後端會連到你設定的 MCP server，
        讀取跟當前任務相關的技術文件，把它附加在流程開場提示的前面，讓 agent 一開始就有正確的
        API 參考。
      </p>
      <p class="mh-p">內建目錄裡的選項：</p>
      <ul class="mh-list">
        <li><code>context7</code> — 各種框架與函式庫的最新官方文件</li>
        <li><code>github</code> — 讀取 repo、issue、PR 內容</li>
        <li><code>filesystem</code> — 讀取指定目錄的檔案</li>
        <li><code>brave-search</code> — 網路搜尋</li>
        <li><code>sentry</code> — 讀取錯誤追蹤資料</li>
      </ul>
      <div class="mh-warn">
        <p>
          <strong>這裡設定的 server 不會出現在 CLI agent 的工具清單裡。</strong>
          它們只服務「讀取上下文 → 注入開場提示」這一件事，而且<strong>只在跑流程時</strong>觸發，
          你手動開的 pane 完全不會用到。
        </p>
        <p>
          想讓 Claude Code 或 Codex 自己能用某個 MCP server（例如讓它直接查 GitHub），
          請用那個 CLI 自己的 MCP 設定，不是這裡。
        </p>
      </div>
    </section>

    <!-- ── 方向三 ───────────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">方向三：外部 client 控制 Navide</h2>
      <p class="mh-p">
        跟方向一同一個端點（<code>/plan-mcp</code>），但開放給 <strong>Navide process 之外</strong>
        的 client 連——外部腳本、跑在別處的 agent、任何 MCP client 都算。除了方向一那些工具，
        還多了兩組：
      </p>

      <h3 class="mh-h3">操作 Navide 介面</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="t in uiTools" :key="t.name">
              <td class="mh-tool"><code>{{ t.name }}</code></td>
              <td>{{ t.what }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note">
        <code>ui_invoke</code> 能呼叫的動作 id（例如 <code>ui.pane.create</code>、
        <code>ui.settings.open</code>）要先用 <code>ui_list_actions</code> 查——它會列出目標視窗
        當下註冊的所有 id，實際可用的以那份清單為準。
      </p>

      <div class="mh-warn">
        <p><strong>開啟後，本機任何程式皆可控制 Navide。</strong>能做的事包括開關 pane、跨工作區傳訊、
          讀取其他 pane 的對話紀錄、操作介面。連線網址（含一次性 token）在
          <strong>設定 → MCP → External access</strong> 複製，「重新產生 token」會讓舊網址立即失效。</p>
        <p>同一個面板裡的 <strong>Chrome DevTools Protocol</strong> 開關是另一條、更底層的逃生口——
          給截圖或還沒註冊成動作的操作用，不是主要路徑。它一旦開啟，本機任何行程都能對 Navide
          執行任意程式碼，且僅綁定 127.0.0.1，需要重啟 App 才生效。</p>
      </div>
    </section>

    <!-- ── 對照 ─────────────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">方向一與方向二的對照</h2>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <thead>
            <tr>
              <th></th>
              <th>Navide 提供工具</th>
              <th>Navide 取用文件</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in comparison" :key="row.aspect">
              <th class="mh-aspect">{{ row.aspect }}</th>
              <td>{{ row.provide }}</td>
              <td>{{ row.consume }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 疑難排解 ─────────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">出問題時</h2>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <thead>
            <tr><th>症狀</th><th>原因與解法</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>agent 說它沒有計畫或傳訊的工具</td>
              <td>那個 pane 開啟時還沒接上（功能更新前開的），或用的 CLI 不是 Claude Code／Codex。
                  前者關掉重開即可。</td>
            </tr>
            <tr>
              <td>設定 → MCP 加了 server，但 agent 用不到</td>
              <td>那是方向二，只給流程讀文件用。要讓 agent 自己能呼叫，得設定在那個 CLI 自己的
                  MCP 設定裡。設定 → MCP 下半部的「各 CLI 的 MCP」會唯讀列出每家 CLI 自己
                  設了哪些 server，可以直接對照確認。</td>
            </tr>
            <tr>
              <td>agent 說計畫載入失敗</td>
              <td>計畫工具都要指定工作區路徑。若 agent 傳的路徑跟 pane 實際的工作區不同，
                  就會寫到 Navide 看不見的地方。請它改用 pane 的工作區路徑。</td>
            </tr>
            <tr>
              <td>提示 pane 身分已失效</td>
              <td>pane 被拆到別的視窗或視窗重新載入過，接線時記下的身分過期了。重開該 pane。</td>
            </tr>
            <tr>
              <td>外部 client 連線被拒（external token rejected / disabled）</td>
              <td>方向三預設關閉，要先在設定 → MCP → External access 開啟；或是網址裡的 token
                  已經被「重新產生 token」換掉，複製最新的連線網址即可。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.mh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.mh-dirs {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.mh-dir {
  flex: 1 1 260px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mh-dir-arrow {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  color: var(--accent-fg);
  background: var(--accent-subtle);
  border-radius: 99px;
  padding: 1px 9px;
  align-self: flex-start;
}
.mh-dir-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.mh-dir-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.mh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.mh-h3 {
  margin: 8px 0 0;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary);
}
.mh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.mh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.mh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mh-warn {
  border-left: 3px solid var(--st-progress, #c77400);
  background: var(--bg-inset);
  border-radius: 0 8px 8px 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mh-warn p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.mh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
}
.mh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.mh-table th,
.mh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.mh-table thead th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.mh-table tr:last-child td,
.mh-table tr:last-child th { border-bottom: none; }
.mh-aspect {
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.mh-tool { white-space: nowrap; }

.mh code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
