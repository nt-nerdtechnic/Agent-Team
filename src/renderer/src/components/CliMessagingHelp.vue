<script setup lang="ts">
// Read-only reference for inter-CLI messaging, shown inside Settings → 說明.
// Static mirror of the messaging system; the limits below are the real
// constants from useAgentMessaging.ts — keep them in sync if those change.

interface AddressRow {
  form: string
  meaning: string
  example: string
}

interface GuardRow {
  limit: string
  value: string
  why: string
}

interface TroubleRow {
  symptom: string
  cause: string
  fix: string
}

interface CoverageRow {
  cli: string
  send: string
  sendKind: 'both' | 'protocol' | 'none'
}

// Sending needs one of the two routes. The MCP tools are wired only for claude
// and codex; the output protocol needs Navide to read the agent's turn text,
// which only four vendors' logs actually carry. Receiving is unaffected either
// way — that is text injected into the terminal.
const coverage: CoverageRow[] = [
  { cli: 'Claude Code', send: 'MCP 工具 ＋ 輸出協定', sendKind: 'both' },
  { cli: 'Codex', send: 'MCP 工具 ＋ 輸出協定', sendKind: 'both' },
  { cli: 'Copilot CLI', send: '僅輸出協定', sendKind: 'protocol' },
  { cli: 'Aider', send: '僅輸出協定', sendKind: 'protocol' },
  { cli: 'Antigravity CLI', send: '目前不支援', sendKind: 'none' },
  { cli: 'Grok CLI', send: '目前不支援', sendKind: 'none' },
  { cli: 'Kimi Code', send: '目前不支援', sendKind: 'none' },
  { cli: 'OpenCode', send: '目前不支援', sendKind: 'none' },
  { cli: 'Qwen Code', send: '目前不支援', sendKind: 'none' },
  { cli: 'Kilo Code', send: '目前不支援', sendKind: 'none' },
  { cli: 'Pi', send: '目前不支援', sendKind: 'none' },
  { cli: 'Cursor CLI', send: '目前不支援', sendKind: 'none' },
]

const addressing: AddressRow[] = [
  {
    form: '<pane 名稱>',
    meaning: '只找自己這個工作區裡的 pane',
    example: 'reviewer',
  },
  {
    form: '<資料夾名>/<pane 名稱>',
    meaning: '指定另一個工作區視窗裡的 pane',
    example: 'Agent-Team/reviewer',
  },
  {
    form: '<路徑後綴>/<pane 名稱>',
    meaning: '資料夾同名時用來消歧',
    example: 'work/proj/reviewer',
  },
  {
    form: '<絕對路徑>/<pane 名稱>',
    meaning: '最精確的寫法',
    example: '/Users/me/proj/reviewer',
  },
]

const guards: GuardRow[] = [
  {
    limit: '同一組「來源 → 目標」的頻率',
    value: '每 60 秒最多 5 則',
    why: '兩個 agent 互相回覆可能無限往返',
  },
  {
    limit: '單一 pane 的待送佇列',
    value: '最多 10 則',
    why: '對方忙不過來時不要無限堆積',
  },
  {
    limit: '送出後等不到結果',
    value: '30 分鐘後標為失敗',
    why: '對方視窗被關掉時，訊息不會永遠卡在「佇列中」',
  },
  {
    limit: '暫停開關',
    value: '訊息面板',
    why: '你隨時可以喊停，訊息會排隊但不送出',
  },
]

const troubleshooting: TroubleRow[] = [
  {
    symptom: 'agent 說它沒有傳訊的工具',
    cause: '那個 pane 是在功能上線前開的（MCP 工具是 pane 啟動當下接上去的），或那個 CLI 本來就不支援',
    fix: '先對照下方「哪些 CLI 送得出訊息」；若該 CLI 支援，關掉那個 pane 重開',
  },
  {
    symptom: '提示 pane id 已失效（stale）',
    cause: 'pane 被拆到別的視窗、或視窗重新載入過，身分換了但 CLI 還握著舊的',
    fix: '重開那個 pane；或改用 ---MSG--- 協定，它每次都用當下的身分',
  },
  {
    symptom: 'unknown workspace',
    cause: '那個資料夾名沒有對應的工作區視窗開著',
    fix: '確認對方視窗開著，或先請 agent 列出可傳送的對象',
  },
  {
    symptom: 'ambiguous workspace / ambiguous target',
    cause: '兩個工作區資料夾同名，或同一工作區有兩個同名 pane',
    fix: '改用完整路徑；同名 pane 則改掉其中一個的名稱',
  },
  {
    symptom: '訊息一直停在「佇列中」',
    cause: '對方正在跑長任務，還沒閒下來',
    fix: '正常現象，等它做完；真的卡住 30 分鐘會自動標為失敗',
  },
  {
    symptom: '提示超出頻率限制',
    cause: '同一組來源 → 目標 60 秒內超過 5 則',
    fix: '通常代表兩個 agent 在無效往返，去看看它們在聊什麼',
  },
  {
    symptom: '訊息面板一則都沒動',
    cause: '投遞被暫停了',
    fix: '在訊息面板按「恢復投遞」',
  },
]
</script>

<template>
  <div class="cmh">
    <p class="cmh-intro">
      Navide 裡的 CLI agent 可以把指令送給另一個 CLI agent — 同一個工作區、或另一個工作區視窗都行。
      每個 CLI pane 都有一個<strong>名稱</strong>，那個名稱就是它的<strong>位址</strong>，
      也就是你在 pane 標題上看到的字。
    </p>

    <div class="cmh-callout">
      <div class="cmh-callout-title">最重要的一件事</div>
      <div class="cmh-callout-text">
        你不需要背任何語法。直接用中文交代就好，例如
        「<em>請你叫 reviewer 去跑測試</em>」，agent 會自己查位址、自己送出。
        下面的語法是給你除錯時對照用的。
      </div>
    </div>

    <!-- ── 運作方式 ─────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">怎麼運作</h2>
      <pre class="cmh-flow">pane「架構師」                Navide                pane「reviewer」
     │                                                    │
     │  「叫 reviewer 跑測試」 ──►  查名冊、確認對方閒著        │
     │                              ──────────────────►  收到並自動執行
     │                                                    │
     │  ◄───────────  對方回訊也走同一條路  ◄────────────────┘</pre>
      <p class="cmh-p">
        訊息是<strong>自動送出</strong>的，不是貼進輸入框等人按 Enter — 對方會直接開始做。
      </p>
    </section>

    <!-- ── 兩條路 ───────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">兩條路</h2>
      <p class="cmh-p">
        送出訊息有兩種方式，遞送機制完全相同，差別在 agent 怎麼知道自己有這個能力、
        以及<strong>哪些 CLI 支援</strong>（見下一節）。
      </p>

      <div class="cmh-card">
        <div class="cmh-card-head">
          <span class="cmh-card-title">MCP 工具</span>
          <span class="cmh-tag">手動開的 pane 用這個</span>
        </div>
        <p class="cmh-p">
          agent 啟動時就會在自己的工具清單裡看到，不需要任何人教它。
          它可以先查詢有哪些對象在線上，再把指令送過去。
        </p>
        <p class="cmh-note">
          目前只有 <strong>Claude Code</strong> 與 <strong>Codex</strong> 接上了這組工具。
        </p>
      </div>

      <div class="cmh-card">
        <div class="cmh-card-head">
          <span class="cmh-card-title">輸出協定</span>
          <span class="cmh-tag">流程（pipeline）的 pane 自動具備</span>
        </div>
        <p class="cmh-p">agent 在回覆裡輸出這種裸文字區塊，Navide 會攔下來當作訊息：</p>
        <pre class="cmh-code">---MSG-START--- to: reviewer
幫我跑一下 pnpm test:run，把失敗清單回報給我
---MSG-END---</pre>
        <p class="cmh-note">
          marker 必須獨立成行、頂格，而且不可以放在 markdown 的程式碼區塊裡，否則不會被辨識。
          流程的 slot 在開場時就會被告知這個協定；手動開的 pane 不會，
          但你可以把上面這段直接貼給它——前提是那個 CLI 在下表裡支援輸出協定。
        </p>
      </div>
    </section>

    <!-- ── 支援範圍 ─────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">哪些 CLI 送得出訊息</h2>
      <p class="cmh-p">
        <strong>所有 CLI pane 都收得到訊息</strong>——那是 Navide 直接把文字打進終端機，跟 CLI 種類無關。
        受限的是<strong>主動送出</strong>：
      </p>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr><th>CLI</th><th>能主動送訊嗎</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in coverage" :key="row.cli">
              <td>{{ row.cli }}</td>
              <td :class="row.sendKind === 'none' ? 'cmh-unsupported' : 'cmh-supported'">
                {{ row.send }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cmh-note">
        為什麼有些不支援：輸出協定需要 Navide 讀得到那個 agent「講完一段話」以及它講了什麼。
        這些資訊來自各家 CLI 自己的對話紀錄，而有幾家的紀錄是二進位格式讀不出文字、
        或根本沒有「回合結束」這個訊號。這不是設定問題，目前無解。
      </p>
    </section>

    <!-- ── 定址 ─────────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">怎麼指定對方</h2>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr><th>寫法</th><th>意思</th><th>例子</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in addressing" :key="row.form">
              <td><code>{{ row.form }}</code></td>
              <td>{{ row.meaning }}</td>
              <td><code>{{ row.example }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="cmh-list">
        <li><strong>不帶斜線就永遠出不了自己的工作區。</strong>想跨專案一定要明寫。</li>
        <li><strong>找不到或有歧義一律拒絕，不猜。</strong>把指令送到錯的 CLI，比不送更糟。</li>
        <li><strong>廣播（<code>all</code>）不會跨工作區。</strong>跨專案永遠是明確指名的動作。</li>
      </ul>
    </section>

    <!-- ── 時機 ─────────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">對方什麼時候會收到</h2>
      <p class="cmh-p">
        不是立刻。Navide 會等對方<strong>真的閒下來</strong>才打字進去，避免打斷它正在做的事：
      </p>
      <ul class="cmh-list">
        <li>對方的 CLI 還活著，而且已經過了啟動階段</li>
        <li>沒有正在跑的回合</li>
        <li>最近 2 秒沒有任何輸出</li>
      </ul>
      <p class="cmh-p">
        條件不滿足就先排隊，滿足了自動送出。所以對方正在跑長任務時，你的訊息會等它做完 — 這是刻意的。
        對方收到的訊息開頭會標明來源，它才知道要回覆給誰。
      </p>
    </section>

    <!-- ── 你看得到什麼 ─────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">你在畫面上看得到什麼</h2>
      <ul class="cmh-list">
        <li>
          <strong>狀態列的「訊息」按鈕</strong> — 開啟「CLI 互傳訊息」面板，
          看每一則的來源、目標、狀態與內容；跨工作區的會多一個徽章。也可以在這裡暫停投遞。
        </li>
        <li>
          <strong>收到跨工作區指令時</strong> — 目標視窗會跳出提示，讓你知道這段指令不是你自己下的。
        </li>
        <li>
          <strong>輸入框打 <code>@</code></strong> — 跳出可選名單，包含其他工作區視窗的位址。
        </li>
        <li>
          <strong>把 pane 拖到另一個 pane 上</strong> — 游標剛好停在 <code>@</code> 後面會插入對方的位址；
          否則貼上對方的畫面內容摘要。
        </li>
      </ul>
    </section>

    <!-- ── 護欄 ─────────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">護欄</h2>
      <p class="cmh-p">避免 agent 之間互相刷爆：</p>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr><th>限制</th><th>數值</th><th>為什麼</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in guards" :key="row.limit">
              <td>{{ row.limit }}</td>
              <td class="cmh-nowrap">{{ row.value }}</td>
              <td>{{ row.why }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 疑難排解 ─────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">出問題時怎麼判斷</h2>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr><th>症狀</th><th>原因</th><th>怎麼辦</th></tr>
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

    <!-- ── 限制 ─────────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">已知限制</h2>
      <ul class="cmh-list">
        <li><strong>純終端機 pane 不能當收發對象</strong> — 只有 CLI agent pane 才有名稱。</li>
        <li>
          <strong>多數 CLI 只能收、不能送</strong> — 12 種 CLI 裡目前只有 4 種送得出訊息，
          見上方「哪些 CLI 送得出訊息」。
        </li>
        <li>
          <strong>pane 被拆到獨立視窗、或視窗重新載入後</strong>，MCP 工具那條路要重開 pane 才恢復；
          輸出協定不受影響。
        </li>
        <li>
          <strong>對方佇列滿的時候</strong>，送出端會顯示成功但訊息其實被丟棄 —
          遞送是非同步的，送出當下無從得知。要確認就去看對方視窗的訊息面板。
        </li>
        <li>
          <strong>沒有權限確認</strong> — 跨工作區傳訊不會跳確認框，只會在收到時提示。這是刻意的取捨。
        </li>
      </ul>
    </section>

    <p class="cmh-tip">
      小訣竅：先幫 pane 改個角色名（「reviewer」「架構師」），標題就是位址，之後交代事情會順很多。
    </p>
  </div>
</template>

<style scoped>
.cmh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.cmh-intro {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.65;
}

.cmh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cmh-callout-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cmh-callout-text {
  font-size: 13px;
  line-height: 1.6;
}

.cmh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cmh-h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-bright);
}
.cmh-p {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
}
.cmh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.cmh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: 13px;
  line-height: 1.65;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cmh-flow,
.cmh-code {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.65;
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary);
}

.cmh-card {
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cmh-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cmh-card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-bright);
}
.cmh-tag {
  font-size: 11px;
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 8px;
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.cmh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
}
.cmh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.cmh-table th,
.cmh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cmh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cmh-table tr:last-child td { border-bottom: none; }
.cmh-nowrap { white-space: nowrap; }
.cmh-supported { color: var(--text-primary); }
.cmh-unsupported { color: var(--text-secondary); }

.cmh code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}

.cmh-tip {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>
