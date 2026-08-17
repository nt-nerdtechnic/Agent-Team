# 外部 MCP 控制

[English](../en-US/external-mcp-control.md) | 繁體中文 | [日本語](../ja-JP/external-mcp-control.md) | [文件中心](README.md)

Navide 提供一個 MCP（Model Context Protocol）Endpoint `/plan-mcp`，在 Navide
Pane 中執行的 CLI Agent 會自動使用它。同一個 Endpoint 也可以開放給 Navide
自身 Process Tree 以外的 Client —— 一段 Script、在別處執行的 AI Agent，或任何
支援 MCP 的 Tool —— 讓它可以驅動執行中的 Navide 視窗：開啟 Pane、呼叫 UI
Action、讀取另一個 Agent 的對話記錄，以及管理 Plan 文件。

這項功能預設關閉。開啟它代表**你 Mac 上任何執行中的 Process 都能控制
Navide** —— 啟用前請先閱讀[安全模型](#安全模型)。

每個 Pane 本來就自動具備的另外兩個方向（Navide 把 Tool 交給自己的 CLI
Agent，以及 Navide 在 Pipeline 執行期間使用外部文件 MCP Server），請見 App 中
Settings → MCP 底下的「說明」分頁
（[`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)）。
本文件涵蓋的是第三個、需要主動啟用的方向：由外部 Client 控制 Navide。

## 連線方式

1. 開啟 **Settings → MCP → External access**，開啟 **Allow external
   MCP clients**。
2. 複製 **Connection URL**。格式如下：

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` 是 Backend 目前的 Port（在啟動時動態選定，因此 URL 會隨重新啟動
   而改變 —— 重新啟動 Navide 後請重新複製），`<token>` 則是只限外部呼叫端使用
   的 Bearer Secret。
3. 將你的 MCP Client 以 **streamable HTTP** 指向該 URL。不需要額外的 Handshake
   或註冊 —— 每一次 Tool 呼叫都由 URL Query String 中的 Token 驗證。
4. 同一個面板中的 **Regenerate token** 會立即讓舊 Token 失效並產生新的；
   若 URL 可能外流就使用它。

這個 Endpoint 只接受三種呼叫端憑證：Pane 自己的憑證（Navide spawn claude/codex
Pane 時產生）、Backend 自身的內部「host」憑證（供其自有 CLI 接線使用），以及
上述的外部憑證 —— 由 Settings 的開關控管。外部呼叫端沒有 Pane 身分，因此也
沒有自己的 Workspace：每個定址到 Pane 的 Tool（`cli_send`、`cli_read_log`、
`cli_get_status`、`cli_wait_idle`）都必須使用完整的 `<folder>/<pane>` 形式，
而不是裸的 Pane 名稱；每個定址到 UI 狀態（`ui_invoke`、`ui_snapshot`、
`ui_list_actions`）或 Plan 文件（`plan_*`）的 Tool 都必須明確給定
`workspace_path` —— 以 Pane 身分執行的呼叫端可以省略，並取得該 Pane 自己的
Workspace。

實作：[`plan_mcp.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp.py)
（Tool）、[`plan_mcp_auth.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_auth.py)
（憑證儲存，位於 App Data 目錄下的 `plan_mcp_auth.json`），以及
[`plan_mcp_wiring.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_wiring.py)
（Pane／host 接線 —— 外部 Client 不需要）。

## Tool 目錄

### Plan 文件

| Tool | 參數 | 功能 |
|---|---|---|
| `plan_list` | `workspace_path` | 列出 `.agent-team/plans/` 底下的 Plan 文件：`rel_path`、`name`、`stage`、`overview`、`todos` 摘要、`mtime` |
| `plan_read` | `workspace_path`、`rel_path` | 讀取單一 Plan 已解析的 meta 與原始 HTML |
| `plan_create` | `workspace_path`、`name`、`overview`、`todos` | 依 Template 建立 Plan，起始 stage 為 `draft` |
| `plan_update_stage` | `workspace_path`、`rel_path`、`stage` | 設定 stage：`draft`、`in-review`、`approved`、`in-progress`、`done`、`abandoned` |
| `plan_update_todo` | `workspace_path`、`rel_path`、`todo_id`、`status` | 設定單一 todo 的狀態：`pending`、`in-progress`、`done`、`skipped` |
| `plan_add_note` | `workspace_path`、`rel_path`、`text`、`author?`（`ai`\|`user`，預設 `ai`） | 附加一則 Review Note |

這裡必須給 `workspace_path`，因為外部 Client 不是 Pane；Pane 呼叫端省略它時，
這些 Tool 會使用該 Pane 自己的 Workspace，而那正是 Plan 視窗用來解析 Plan 的
依據。

當 `workspace_path` 不符合任何 Live Pane 的 Workspace 時，`plan_create` 會回傳
`warning` 欄位 —— 檔案仍會寫入，但 Navide 的 Plan 視窗找不到它。

`plan_list` 回傳的是一個 List，而 MCP 傳遞 List 的方式是**每個項目一個 Content
Block**，不是單一 JSON 陣列。把這些 Block 串接起來一次解析會出現 `Extra data`
錯誤；請逐個 Block 各自解析，或改讀該次呼叫的 `structuredContent`。這裡其他每個
Tool 都回傳單一物件，因此這個問題只會在 `plan_list` 上出現。

### CLI Pane —— 傳訊與 Spawn

這些 Tool 進入的是與 Agent 印出裸行 `---MSG-START---` 區塊相同的遞送佇列；
[CLI 之間的訊息傳遞](inter-cli-messaging.md)
文件說明了它們共用的位址、Idle 閘門與防護機制。

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_list_targets` | — | 列出可定址的 CLI Pane：`name`、`address`、`workspace_path`、`same_workspace`、`busy`、`hold_reason?` |
| `cli_send` | `to`、`text`、`wait_for_delivery_s=0`（上限 120） | 在另一個 Pane 進入 Idle 後遞送一則指令（忙碌則排入佇列）；回傳 `msg_key`，若有等待則一併回傳它的結果 |
| `cli_check_message` | `msg_key` | 某次 `cli_send` 的結果：`{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_inbox_summary` | — | 你自己送出、目前卡住或失敗的訊息：`{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_send_and_wait` | `to`、`text`、`timeout_s=60`（上限 120） | `cli_send` 再加上等待該回合結束；回傳 `cli_wait_idle` 的結果，外加 `{ok, target, msg_key}` |
| `cli_open_agent` | `agent`、`name`、`task`、`workspace_path`（非 Pane 呼叫端必填） | 帶著一項任務 Spawn 新的 CLI Pane；回傳 `{ok, name, address}`，若該次 Spawn 跨過 Advisory 門檻則另附 `advisories` |

`cli_send` 在訊息*被接受*遞送時就回傳，不是在另一個 Agent 讀到時才回傳。
`cli_check_message` 補上這個閉環：`status` 可能是 `queued`（已廣播，尚無視窗
回報 —— 為忙碌 Pane 保留的訊息會停在這個狀態，直到真正被注入為止）、
`delivered` 或 `failed`。在 `failed` 時，`reason` 是接收端視窗的判定：
`rate-limit`（同一組配對之間短時間內訊息過多）、`queue-full`（目標的待遞送訊息
佇列已滿）、`inject-failed`（輸入到該 Pane 沒有生效）、`pane-closed`（目標在
遞送前就消失了），或 `no-report`（該次嘗試從未回報結果）。

失敗也會在未被主動查詢的情況下推送到寄件 Pane：Navide 會在該 Pane 進入 Idle 後，
透過與一般訊息相同的佇列與注入路徑，寫入一則 `[Navide MSG] delivery failed`
通知，指出目標與原因。這是給從不輪詢的 Agent 的提醒 —— `cli_check_message`
仍是權威答案，而且該通知不可定址，因此不該有任何東西去回覆它。

**等訊息真的送進去。** 輪詢只對記得輪詢的 Agent 才閉得起這個環，而送完就走的 Agent
永遠什麼也學不到。`wait_for_delivery_s` 就是把答案放進同一次呼叫裡的做法：
`cli_send` 會為此等上那麼久，等訊息真的進去，並在同一份結果中回報發生了什麼。

| 結果 | 回傳什麼 |
|---|---|
| 它進去了 | `status: "delivered"`、`settled_after_s` |
| 視窗拒絕了它 | `status: "failed"`（若來自另一台裝置則是 `"rejected"`）、`reason` |
| 時間用完時仍在等待 | `status: "queued"`、`waited_s`，若接收端視窗說明了原因則另附 `hold` 與 `held_for_s` |

被拒絕時 `ok` 仍然維持 **true**，理由和 `cli_send_and_wait` 的 `target_lost` 一樣：
送出已經發生、`msg_key` 也是真的，因此回答 `ok: false` 會被讀成「從未送出」而誘發
重送，導致同一件工作被派發兩次。10–30 秒是實用的範圍 —— 這段等待花掉的是呼叫端
自己的回合，而正在跑回合或正被輸入的 Pane 可能把訊息保留得久得多。維持預設值 `0`
時，答案與過去逐位元組相同。

**訊息為何仍在佇列中。** `hold` 就是 Messages 面板顯示的同一個原因 —— `{key, n?}`，
其中 `key` 可能是 `typing`、`mid-turn`、`behind`、`starting`、`settling`、
`not-ready`、`gone`、`paused` 或 `remote-ack` —— 而 `held_for_s` 是它維持這個狀態
多久了。它會出現在 `cli_check_message`，以及逾時的 `cli_send` 等待上；一旦訊息塵埃
落定，或在還沒有任何視窗回報過原因時，它就不存在。`cli_list_targets` 以
`hold_reason` 逐 Pane 呈現同一件事，那正是讓 `busy` 變得可以解釋的東西 —— 但只在
從這裡送出的某則訊息正為那個 Pane 排隊時才有，所以它不存在並不說明任何事。

**當它排隊太久時。** 一則 `queued` 的訊息等超過**兩分鐘**之後就會出現 `stale`，
`cli_check_message` 與逾時的 `cli_send` 等待都一樣。它不是判定 —— 沒有東西失敗，
也沒有東西放棄 —— 它是「它正在路上」不再是安全假設的那個分界點，因此請連同旁邊的
`hold` 一起讀，再決定要繼續等、改找別人，還是對使用者說點什麼。它是從送出那一刻起
算的，而不是從目前這個保留起算：在 `mid-turn` 與 `typing` 之間來回跳動的訊息每次
都會把 `held_for_s` 歸零重數，而這個欄位真正要處理的情況 —— 從頭到尾沒有任何視窗
回報過保留原因的那一種 —— 根本沒有保留計時可讀。

`cli_inbox_summary` 是同一件事，只是不需要有 `msg_key` 才問得出來。它不接受任何
參數，只回答關於呼叫端自己的事，並回傳你目前每一則 stale 或失敗的送出 —— 附上
60 個字元的 `excerpt`，讓你即使沒留著 key 也認得出是哪一則訊息。已送達與剛排進去
的訊息不會列入，因此空清單代表「我沒有東西卡住」，絕不是「什麼都沒送出」。它的存
在是為了那種通知碰不到的 Agent：投遞失敗通知要等寄件 Pane 進入 Idle 才會被輸入回
去，所以連續忙一小時的 Agent 永遠看不到，而外部 Client 根本沒有 Pane 可以輸入。在
你自己的工作之間呼叫它，就是你發現二十分鐘前送出的那則訊息還躺在佇列裡的方式。

那張表是 Backend 的**記憶體**，不是 Log：它保存最近 500 筆送出記錄一小時，
Backend 重新啟動就會遺失。未知的 `msg_key` 會回傳 `{ok: false, error}`，
意思是「不再被追蹤」，不是「從未送出」。

`cli_send_and_wait` 處理的是手動配對 `cli_send` + `cli_wait_idle` 會輸掉的競態 ——
目標在你送出的當下是 Idle 的，因此單純的等待會在它讀到訊息之前就回報
「已經 Idle」。它會先等訊息**送進去**，並在送出前記錄目標的最後一次活動，而且只
接受*更新*的回合作為答案，因此 `last_activity.text` 就是另一個 Agent 的回覆內容。
它的 Timeout `reason` 沿用 `cli_wait_idle` 的，另外加上 `never_started`，代表目標
一直維持 Idle、從未顯示任何接手該訊息的跡象。若送出當場被拒絕，則原樣回傳
`cli_send` 的 `{ok: false, error}`。

`timeout_s` 涵蓋兩個階段：**最多一半**用來把訊息送進去，剩下的才用來等回合。花在
投遞上的時間並沒有白費 —— Pane 一空下來訊息就會落地，而那本來就是 Idle 等待大半
會坐等的東西 —— 但在一半時間點上仍被保留的訊息，不太可能在剩下的時間裡得到回答，
而它的保留原因遠比「逾時，忙碌中」有用得多。當訊息始終沒有抵達時，結果會是
`source: "not_delivered"`，並帶著 `delivery_status`（`queued` 時附 `hold` /
`held_for_s`，`failed` / `rejected` 時附 `reason`）。這修正的是「訊息被保留住、目
標卻閒著」的情況：舊的順序會依訊息被送出時的狀態回答 `idle`，那會被讀成「它把你的
工作做完了」，但那份工作根本從未交出去。和 `target_lost` 一樣，它維持 `ok: true`
—— 不要因為它而重送。

如果目標在等待*期間*不再可定址 —— 視窗關閉、Pane 被 Kill —— 結果會是
`{ok: true, idle: false, source: "target_lost", error}`。它刻意維持 `ok: true`：
送出已經發生、`msg_key` 也仍然有效，因此在此回報失敗會被讀成「從未送出」而誘發
重送，導致同一件工作被派發兩次。請把它讀作「已遞送，但我無法再確認它完成了」。

Spawn 沒有上限。一個 Pane 可以 Spawn 任意數量的子代，一個 Workspace 可以容納
任意數量的 CLI Pane，Spawn 鏈也可以延伸到任意深度 —— 超過 Advisory 門檻
（3 個子代、8 個 Workspace Pane、深度 2）之後呼叫仍會成功，並回傳 `advisories`
指出代價，例如每個 Pane 佔用 250-500MB。真正會失敗的是格式錯誤的請求：未知的
Agent Key、缺少或已被佔用的名稱、空白的任務。這些 Advisory 也會被記錄為
Diagnostics，可透過 `ui_diagnostics` 讀取。

### CLI Pane —— 讀回

| Tool | 參數 | 功能 |
|---|---|---|
| `cli_read_log` | `target`、`tail_lines=200`、`since?` | Pane 對話記錄的尾端（≤512KB 且 ≤`tail_lines` 行）；回傳 `next_cursor` 與 `rotated` |
| `cli_get_status` | `target` | `{busy, agent_key, last_activity?, ui?}` —— 當擁有該 Pane 的視窗有回應時，`ui` 鏡射 `ui.pane.getStatus` |
| `cli_wait_idle` | `target`、`timeout_s=60`（上限 120） | 阻擋直到該 Pane 進入 Idle 或逾時；回傳 `{idle, source, waited_s, last_activity?, ui_status?}`，逾時再加上 `reason` |

`cli_read_log` 的 `since` 提供增量讀取：把上一次呼叫回傳的 `next_cursor` 傳回來，
就只會拿到該 Pane 自那之後說的內容，而不必重讀同一段尾端。這個 Cursor 是
Append-only 擷取檔案中的位元組偏移量，因此一旦該檔案被截斷或取代就失去意義 ——
此時呼叫會回傳單純的尾端並帶上 `rotated: true`，那代表重新開始，而不是新的輸出。

`cli_wait_idle` 的 `last_activity` 與 `cli_get_status` 在同一個 key 底下回報的
內容相同，因此等完一個回合的呼叫端不必再呼叫第二次就能取得該回合說了什麼；
`ui_status` 是擁有該 Pane 的視窗自己的說法，只有在等待期間探測有觸及它時才會
出現。逾時時，`reason` 區分三種看起來相似但其實不同的失敗：`awaiting`（該 Pane
停在權限提示上，正在等**人類** —— 請在 UI 中回答它）、`busy`（它真的還在工作；
再等久一點），以及 `unreachable`（擁有該 Pane 的視窗不再回應，因此結果中的任何
內容都不是最新的）。

**能力邊界 —— Idle／完成偵測。** 大多數 CLI 的 Log Reader 會發出帶有已完成回合
文字的 `turn_complete` 事件：**aider、antigravity、claude、codex、copilot、
cursor、grok、kilo、kimi、muse、opencode、pi、qwen**。對這些而言，
`cli_wait_idle` 與 `cli_get_status` 的 `last_activity.type` 是依據精確的
turn-complete 訊號解析出來的 —— 但有一項但書：**grok、kimi、pi、qwen** 沒有自己的
回合結束記錄，而是從 Log 中 8 秒的靜默合成出 `turn_complete`，因此對這四者而言
該事件本身就是一種推論，回合中途夠長的停頓也可能讓等待提早結束。至於一般
Terminal Pane，則完全沒有這種訊號 ——
`cli_wait_idle` 會退回以 10 秒沒有新活動的安靜期來推論 Idle（回應中
`source: "quiet_period"`），而 `cli_get_status` 的 `last_activity` 可能永遠只會
回報 `"agent_active"`。請把基於安靜期的 Idle 結果當成啟發式判斷，而不是 CLI
真的已經完成的保證。

這也是為什麼 `source` 是 `cli_send_and_wait` 結果中該讀的欄位：不論由哪個 CLI
產生，形狀都一模一樣，但可信度並不相同。來自 aider/antigravity/claude/codex/
copilot/cursor/kilo/muse/opencode 的 `turn_complete` 是 CLI 自己說回合結束了；
同樣的值若來自 grok/kimi/pi/qwen，則是上述的 8 秒靜默推論；而 `quiet_period` ——
一般 Terminal Pane 唯一可得的結果 —— 代表根本沒有任何東西回報回合結束，因此請
檢查內容，而不要信任訊號。`target_lost` 是第四個值，也是唯一一個不是對回合下
判定的值：它表示該 Pane 在等待能得出判定之前就消失了。

### UI Action Bus

| Tool | 參數 | 功能 |
|---|---|---|
| `ui_list_actions` | `workspace_path` | 列出擁有 `workspace_path` 的 Navide 視窗中註冊的每一個 Command id |
| `ui_invoke` | `workspace_path`、`action`、`args?` | 呼叫一個已註冊的 Action，`args` 原樣傳入 |
| `ui_snapshot` | `workspace_path` | 該視窗 UI 狀態的結構化快照 |

這三者都會等待擁有該 Workspace 的視窗回應最多 15 秒，若目前沒有任何視窗開著
`workspace_path` 就會錯誤（以完全相同的字串比對 —— 請傳入該視窗被開啟時所用的
同一個路徑）。`ui_invoke` 的 `action: "ui.workspace.open"` 是唯一的例外：
由於可能還沒有任何視窗擁有該 Workspace，它會被路由到任何一個 Live 的 Navide
視窗，而不是符合 `workspace_path` 的那一個。

`ui_list_actions` 回傳的是該視窗用於其 Keybinding 的*整份* Command Registry，
不只是下面的 `ui.*` id —— 內部 id（例如 `workbench.action.*`）是為鍵盤快捷鍵而
存在的，並非有文件保證的外部契約；只有下表中的 `ui.*` Action 具有穩定且有文件
記載的參數形狀。

#### `ui.*` Action 參考

| Action | 參數 | 效果 |
|---|---|---|
| `ui.settings.open` | `{tab?}`（`general`、`mcp`、`analyzer`、`updates`、`appearance`、`accounts`、`storage`、`keybindings` 之一） | 開啟 Settings，可指定切到特定分頁 |
| `ui.settings.close` | — | 關閉 Settings |
| `ui.pane.create` | `{agent, name?, task?}` | 在該視窗已開啟的 Workspace 中為 `agent` Spawn 一個 Pane；若有給 `task`，會作為 Kickoff Prompt 送出並略過 Role 注入 |
| `ui.pane.close` | `{paneId}` | Kill 一個 Pane |
| `ui.pane.focus` | `{paneId}` | 顯示並聚焦一個 Pane（必要時切換分頁） |
| `ui.pane.getStatus` | `{paneId}` | 回傳該 Pane 的 `{status, buffer, logPath?}` |
| `ui.tab.switch` | `{tabId}` | 切換作用中的 Stage／Run-group 分頁 |
| `ui.window.openPlans` | — | 開啟 Plan 視窗 |
| `ui.window.openGit` | — | 為目前 Workspace 開啟 Git 視窗 |
| `ui.window.openPipeline` | `{pipelineId?}` | 開啟 Pipeline Manager 視窗 |
| `ui.workspace.open` | `{path}` | 將 `path` 開啟為 Workspace（路由到任一 Live 視窗 —— 見上文） |
| `ui.layout.setMode` | `{mode}` | 變更 Pane Layout 模式 |

這份清單維護在程式碼裡，不是在這裡 —— 在依賴確切的參數形狀之前，請對照
[`App.vue`](../../src/renderer/src/App.vue) 中的
`registerCommand('ui.*', …)` 區塊查證。

`ui_snapshot` 的形狀由 Renderer 決定
（`App.vue` 中的 `buildUiActionSnapshot`）：`{workspace, panes: [{id, name?,
agentKey, workspacePath, status?}], activeTab, settingsOpen,
openWorkspaces}`。

## Pane 的 id 活得比 Pane 久

CLI Pane 的連線 URL 只在 Pane 生成的那一刻寫入一次，CLI Process 只要還活著就一直
帶著它。裡面的 `pane=<id>` 是那一刻的 Pane id —— 而 Pane id 屬於 Pane 本身，不屬
於裡面的 Process。重載視窗、把 Run Group 拆出去、或把它收回來，都會用同一個還在跑
的 CLI 重建一個 Pane 並發給它新的 id，於是 URL 裡留下的是舊的那個。

那個舊 id 仍然有效。視窗會記下它去了哪裡，所以帶著舊 id 的呼叫會以「這個 Process
實際附著的 Pane」的身分被回答：`plan_*` 預設的 Workspace 一樣、`cli_list_targets`
裡的 `you` 一樣、`cli_send` 用來判斷裸名與自寄的身分也一樣。重載兩次也不會斷鏈 ——
每一跳都會被壓平到當前的 Pane —— 而且 id 永遠不允許跟著 Pane 跨到別的 Workspace。

Pane 的[Push 通道](inter-cli-messaging.md#push-通道)大致也是這樣跟著走，但有一個例外。
重載視窗會保留通道，Run Group 從拆出的子視窗收回來也會。**拆出（detach）**則不會：
交出 Pane 的那個視窗會在接收端認領它之前就先釋放 Pane、連同通道一起，所以被拆出的
Pane 會回到「用打字送訊息」的舊行為，直到它的 CLI 重新啟動為止。claude Pane 不受影
響：它的 hook 會在下一次回合結束時自行重新掛上。

「哪個 id 被哪個取代」是由 Navide 視窗宣告的，而且會被直接採信 —— 因為 detach 時被
宣告的那個 id 本來就還活著、而且屬於正在放手的那個視窗，所以「宣稱一個仍活著的
Pane」與「合法的交接」在後端無法分辨，只會記 log 而不會拒絕。真正不可逆的那件事則
另外擋掉：只要還有連線中的視窗在鏡射某個 Pane，它的推送通道就不會被任何人拿走。

有一個已知情況會在沒有實際交接的前提下印出那則警告：主視窗在某個 Run Group 已被拆
出時重載，它會在得知該 Group 已經在別處之前就先還原那個 Group 的 Pane，因而短暫地
宣告了子視窗的 id。一旦主視窗被告知就會自行修正，而子視窗的 Push 通道從頭到尾不會
被拿走。

仍然會被拒絕的，是一個什麼都指不到的 id：Pane 已經關閉，或擁有它的視窗離開夠久已
被遺忘。此時沒有任何身分可以代表，因此這個 Endpoint 上的每個 Tool 都會回
`this pane's id is stale`，解法是重新開啟該 Pane。（這跟上面排隊訊息上的 `stale`
是不同的字：那個只是說訊息已經等了超過兩分鐘。）

這跟下面的 Tool **清單**不是同一個問題。清單是 Client 連線當下拍下的快照，Navide
無從更新；id 則是 Navide 每次呼叫都重新解析的。

## Tool 清單只讀一次

MCP Client 會在連線時向 Server 索取一次 Tool 清單，而 Navide 的 `/plan-mcp` 之後
永遠不會改動它。因此**Client 在那一刻看到什麼，就一直留著什麼**：

- **CLI Pane** 會在它的 CLI Process 啟動時把清單拍成快照。Navide 更新時就已經在跑
  的 Pane，講話的對象是一個不復存在的 Backend；請重新開啟該 Pane，才能取得較新版
  Navide 新增的 Tool 或參數。
- **外部 Client** 會保留它的清單，直到你重新連線為止。反正 Connection URL 會隨著
  重新啟動而改變（Port 是啟動時挑的），所以這件事通常會自己解決。

升級之後 Navide 會說一次，就在狀態列的公告串流裡：一則「MCP tools may have
changed」項目，指出它取代的是哪個版本。它只在這次 Backend 確實以不同於上一次的版
本啟動時才出現 —— 全新安裝時不會，一般重新啟動時也不會。

### 為什麼 Navide 不乾脆通知 Client

協定其實有對應的做法 —— Server 宣告 `tools.listChanged` capability，之後在它的
Tool 集合改變時送出 `notifications/tools/list_changed`，而會處理它的 Client 就會在
Session 中途重讀清單。Navide 不能用它，有兩個彼此獨立的原因。

**這個 Transport 沒有地方可以推。** `/plan-mcp` 以 stateless 模式執行 streamable
HTTP 並回應 JSON：Transport 是每個請求建立又拆掉的，不會有任何 Stream 保持開啟。
在那種組態下，由 Server 發起的通知沒有路徑可以抵達 Client —— MCP SDK 會把它送往一
條長壽的 Stream，找不到，然後丟棄。要讓它送得到，就得改跑 Session 導向的模式，而
那正是這個 Endpoint 刻意不採用的狀態。（2026-07-28 版的規格移除了協定層級的
Session，並把這些通知移到由 Client 開啟的 `subscriptions/listen` Stream 上 ——
不論哪一種，都是一條保持開啟的 Stream。）

**有一半的 CLI 會忽略它。** 依各 Client 自己的原始碼或文件查核，2026-08-17：

| CLI | 收到 `list_changed` 會重讀 Tool 清單嗎？ |
|---|---|
| Claude Code | 會，自 2.1.0 起 |
| GitHub Copilot CLI | 會 |
| OpenCode | 會 |
| Grok | 會 |
| Codex CLI | 不會 —— 記錄該通知然後什麼也不做 |
| Cursor（`cursor-agent`） | 不會 —— 要用 `/mcp` 手動重新整理 |
| Qwen Code | 不會 —— 這個 fork 拿掉了上游 Gemini CLI 有的處理器 |
| Kimi CLI | 不會 —— 完全沒有通知處理 |

而且無論如何也沒有什麼好通知的：`/plan-mcp` 的每個 Tool 都在 import 時註冊，而這
組集合在 Backend 執行期間永遠不變。重新開啟 Pane 就是全部的解法，這也是為什麼它被
寫成文件，而不是用工程手段繞過。

## CDP debug（逃生口）

Settings → MCP → External access 底下另有一個 **Chrome DevTools Protocol**
開關（[`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts)，設定位於
`userData/cdp-debug.json`）。啟用它需要重新啟動 App —— Electron 只有在 App
ready 之前設定 `--remote-debugging-port` 才會採納 —— 而且該 Debug Port 只綁定在
`127.0.0.1`。

這是備援手段，不是主要的整合路徑：凡是上面 Tool 目錄涵蓋得到的，都請用 Tool
目錄。CDP 存在是為了那些涵蓋不到的事 —— 對實際算繪出來的視窗截圖，或驅動沒有
註冊 `ui.*` Action 的東西。因為它能做的事（見下文），請把它當成最後手段。

## 安全模型

| 啟用這個…… | ……代表 |
|---|---|
| **Allow external MCP clients** | 只要開著，這台機器上任何執行中的東西都能控制 Navide：Spawn 與關閉 Pane、對任何已開啟 Workspace 中的任何 CLI Pane 送出指令、開啟 Plan／Git／Pipeline 視窗，以及讀取另一個 Pane 的對話記錄。 |
| **CDP debug** | 只要開著，這台機器上任何執行中的東西都能在 Navide 的 Renderer 內執行任意程式碼 —— 完整的遠端偵錯存取權，不受任何 Tool 契約限制。 |

實務注意事項：

- 兩個開關都只綁定 `127.0.0.1` —— 不會暴露到 LAN 或遠端 —— 但在共用機器上，
  「這台機器」包含其他每一個本機使用者帳號，以及每一個以你的身分執行的 Process。
- 外部 Token 是 Bearer Secret：任何人只要拿到 Connection URL，在你重新產生
  Token 之前都擁有完整的外部存取權。它以明文儲存在 App Data 目錄下的
  `plan_mcp_auth.json`。
- 透過這些 Tool 進行的檔案系統寫入，仍受 Backend 其餘部分所用的同一道路徑防護
  約束（`fs_service._resolve_safe`）—— Plan 相關 Tool 只能寫入某個 Workspace 的
  `.agent-team/plans/` 之內。UI Action 與 CDP 沒有等價的 Sandbox：UI Action 會做
  它在 `App.vue` 中的 Handler 所做的任何事，而 CDP 則是不受限制的程式碼執行。
- 用完那些需要它們的工作之後，請把外部存取與 CDP 關回去；兩者都不該預設一直開著。

另見：[隱私與資料流](privacy.md)，說明 Navide 一般性的 Local-first 資料立場；
以及 App 內 Settings → MCP 底下的「說明」分頁，說明每個 Pane 自動具備的那兩個
方向。
