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
| `cli_list_targets` | — | 列出可定址的 CLI Pane：`name`、`address`、`workspace_path`、`same_workspace`、`busy` |
| `cli_send` | `to`、`text` | 在另一個 Pane 進入 Idle 後遞送一則指令（忙碌則排入佇列）；回傳 `msg_key` |
| `cli_check_message` | `msg_key` | 某次 `cli_send` 的結果：`{status, target, age_seconds, reason?, settled_after_s?}` |
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

那張表是 Backend 的**記憶體**，不是 Log：它保存最近 500 筆送出記錄一小時，
Backend 重新啟動就會遺失。未知的 `msg_key` 會回傳 `{ok: false, error}`，
意思是「不再被追蹤」，不是「從未送出」。

`cli_send_and_wait` 處理的是手動配對 `cli_send` + `cli_wait_idle` 會輸掉的競態 ——
目標在你送出的當下是 Idle 的，因此單純的等待會在它讀到訊息之前就回報
「已經 Idle」。它會在送出前記錄目標的最後一次活動，並且只接受*更新*的回合作為
答案，因此 `last_activity.text` 就是另一個 Agent 的回覆內容。它的 Timeout
`reason` 沿用 `cli_wait_idle` 的，另外加上 `never_started`，代表目標一直維持
Idle、從未顯示任何接手該訊息的跡象。若送出當場被拒絕，則原樣回傳 `cli_send` 的
`{ok: false, error}`。

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
