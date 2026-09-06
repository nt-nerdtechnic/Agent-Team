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
沒有自己的 Workspace：每個定址到 Pane 的 Tool（`cli_send`、`cli_send_and_wait`、
`cli_read_log`、`cli_get_status`、`cli_wait_idle`）都必須使用完整的 `<folder>/<pane>` 形式，
而不是裸的 Pane 名稱（或是給一個 `pane_id`：它指名唯一一個 Pane，本身就已經是完整
限定的，因此不受這條規則約束）；每個定址到 UI 狀態（`ui_invoke`、`ui_snapshot`、
`ui_list_actions`）或 Plan 文件（`plan_*`）的 Tool 都必須明確給定
`workspace_path` —— 以 Pane 身分執行的呼叫端可以省略，並取得該 Pane 自己的
Workspace。沒有 Pane 也意味著沒有分頁群組：host 與外部呼叫端呼叫 `cli_send` 的
`to: "group"` 廣播會以 `no-group` 被拒絕 —— 它既沒有自己的群組可以扇出，也沒有視
窗可以問。請改成逐一定址，或用 `pane_id`。

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
| `cli_list_targets` | — | 列出可定址的 CLI Pane：`name`、`address`、`pane_id`（每個 `ui.pane.*` action 都吃這個鍵，也可以在下面那幾個 Pane Tool 上取代 `address`）、`workspace_path`、`same_workspace`、`busy`、`hold_reason?` |
| `cli_whoami` | — | **僅限 CLI Pane。** 自己的身分，形狀與名冊描述別人時完全相同：`{ok, you: {name, address, pane_id, workspace_path, agent_key, busy, spawned_by?}}`。`pane_id` 是所有 `ui.pane.*` 動作唯一接受的鍵，所以這是 pane 能對自己動作的前提；`spawned_by` 是開出你的那個 pane（它關掉後回 `{pane_id, gone: true}`）|
| `cli_send` | `to`（Pane 位址，或 `"group"` 表示廣播）、`text`、`wait_for_delivery_s=0`（上限 120）、`pane_id?`、`reply_to?` | 在另一個 Pane 進入 Idle 後遞送一則指令（忙碌則排入佇列）；回傳 `msg_key`，若有等待則一併回傳它的結果 |
| `cli_check_message` | `msg_key` | 某次 `cli_send` 的結果：`{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_cancel_message` | `msg_key` | 收回一則你送出、但還沒送進去的訊息。由擁有收件佇列的視窗裁決：還在排隊就丟棄、狀態轉為 `cancelled`；已經開始投遞則忽略撤回並回報它最終的狀態。撤回不是失敗，也不會寫任何通知回給你。回傳 `{ok, msg_key, status, reason?}` |
| `cli_inbox_summary` | — | 你自己送出、目前卡住或失敗的訊息：`{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20`（上限 200） | **僅限 CLI Pane。** 目前排給*你*、還沒送進來的訊息：`{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]}` |
| `cli_read_incoming` | `uid=""`、`limit=5`（上限 20）、`include_delivered=false`、`peek=false` | **僅限 CLI Pane。** 寄給你的訊息**全文**——`cli_pending_incoming` 只給 200 字元且壓平空白：`{count, messages: [{uid, sender, status, kind?, content, age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}], note?}`。**預設讀取即消費**，讀過的訊息不會再注入你的輸入框；`peek: true` 只讀不消費。消費採「先保留、後釋放」，釋放若遺失，訊息會退回佇列並可能再送達一次；`consumed` 逐則回報，未消費的原因寫在 `note` |
| `cli_send_and_wait` | `to`、`text`、`timeout_s=60`（上限 120）、`pane_id?` | `cli_send` 再加上等待該回合結束；回傳 `cli_wait_idle` 的結果，外加 `{ok, target, msg_key}` |
| `cli_open_agent` | `agent`、`name`、`task`、`workspace_path`（非 Pane 呼叫端必填）、`model`、`effort` | 帶著一項任務 Spawn 新的 CLI Pane；回傳 `{ok, name, address, pane_id}`，若該次 Spawn 跨過 Advisory 門檻則另附 `advisories`。`model` 與 `effort` 為選填，該 CLI 不支援時會「拒絕」而非忽略，Pane 不會悄悄用別的模型啟動。多數 CLI 接受 model；接受獨立 effort 的較少，其餘把 effort 編在 model id 裡（`gpt-5.3-codex-high`）。model id 不做驗證（每次改版都會變），effort 則會對照該 CLI 的合法值檢查 |

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

**廣播給自己的分頁群組。** `to: "group"` 會送給呼叫端自己那個分頁群組中的每一個
其他 Pane，一樣限於呼叫端自己的 Workspace。它刻意不是裸行協定的 `all` —— 那一個
指的是視窗裡的每一個 Pane，不管群組；同一個字代表兩種範圍會非常難除錯。代價也就
是 `all` 本來就有的那個：真的取名叫 `group` 的 Pane，在這裡無法再以名稱定址。不屬
於任何群組的 Pane 共用同一個隱含群組，因此它們互相送得到，而不是誰也送不到；從沒
建立過群組的人送出的廣播，也不會無聲地什麼都不做。

回傳的形狀不一樣 ——
`{ok, broadcast: "group", group_id, delivered_to, recipients: [{name, pane_id, msg_key, accepted, reason?}]}`
—— 帶著**每個收件者各一個** `msg_key`，因為每個收件者都是一則普通而獨立的訊息：
有自己的成對 Rate Limit 額度、自己的 Idle 保留、自己的投遞回報。因此上面所說的一
切都是逐個收件者分別適用，每個 key 也要分別交給 `cli_check_message`；
`wait_for_delivery_s` 不適用於廣播，會被忽略。若某個收件者在視窗列出它之後、遞送
之前消失了，它會就地以 `accepted: false` 與 `reason: "target-offline"` 回報，而不
會拖垮整次廣播的其餘部分。`recipients` 是空的並不是失敗 —— 那代表你的群組裡沒有
別人。

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

`cli_pending_incoming` 是它的鏡像 —— 目前排給*你*、還沒進來的訊息，最舊的排在前
面，`status` 是 `queued` 或 `delivering`，而由 Navide 而非某個 Agent 寫的訊息會帶
著 `notice` 或 `fallback` 的 `kind`。**它是本節中唯一外部 Client 用不了的工具。**
這裡其他每一個工具都是對某個 Pane*做事*；這一個問的是呼叫端自己的收件匣，而只有
CLI Pane 才有收件匣：Host 或外部呼叫端沒有 messaging 名稱可以被定址，所以這個呼叫
回來的是 `{ok: false, error}`，不是一份空清單。沒有東西能對你定址，也就沒有東西會
在等你。想從外部得到類似畫面的外部 Client，請改讀 `cli_list_targets` 中某個 Pane 的
`hold_reason`，或用 `cli_check_message` / `cli_inbox_summary` 追蹤自己送出的訊息。

和上面那張送出記錄的表不同，這一個讀的是持久化的訊息記錄，所以它撐得過 Backend 重
啟。有兩個限制：這份記錄是由接收端視窗在訊息排進佇列後片刻才寫下的，所以最後一秒才
送出的東西可能還沒被列出來；而訊息是以該 Pane **當前**的 messaging 名稱比對的，因此
排給某個它後來已經改掉的名字的訊息不會被回傳。

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
| `cli_read_log` | `target`、`tail_lines=200`、`since?`、`pane_id?` | Pane 對話記錄的尾端（≤512KB 且 ≤`tail_lines` 行）；回傳 `next_cursor` 與 `rotated` |
| `cli_get_status` | `target`、`pane_id?` | `{busy, agent_key, last_activity?, ui?}` —— 當擁有該 Pane 的視窗有回應時，`ui` 鏡射 `ui.pane.getStatus` |
| `cli_wait_idle` | `target`、`timeout_s=60`（上限 120）、`pane_id?` | 阻擋直到該 Pane 進入 Idle 或逾時；回傳 `{idle, source, waited_s, last_activity?, ui_status?}`，逾時再加上 `reason` |

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
cursor、droid、grok、kilo、kimi、muse、opencode、pi、qwen**。對這些而言，
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
copilot/cursor/droid/kilo/muse/opencode 的 `turn_complete` 是 CLI 自己說回合結束了；
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

路徑比對只適用於沒有 Pane 身分的呼叫者 —— 外部 Client 或 Host Wiring。從 Navide
CLI Pane 發出、且指名該 Pane 自己 Workspace 的呼叫，會直接送到掛著該 Pane 的那個
視窗，不論它有沒有 Focus、當下開著哪一個專案；指名另一個專案則維持廣播路徑，讓
刻意的跨視窗呼叫仍然送得到真的開著那個專案的視窗。

送達視窗不等於在 `workspace_path` 上執行。作用於「這個視窗當下顯示的專案」的
Action —— `ui.pane.create`、`ui.preview.show`、`ui.window.openGit` —— 若該視窗已
切換到別的專案，會回一個錯誤，而不是默默對錯的專案動手。唯讀的 Op（`ui_snapshot`、
`ui_list_actions`、`ui_diagnostics`、`ui.pane.getStatus`）兩種情況都會回應，並如實
描述那個視窗當下的狀態。

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
| `ui.preview.show` | `{kind, …}` | 在右側 rail 的預覽面板顯示檔案、diff 或內嵌片段 |
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

### 預覽記錄

每個 Workspace 都保有一條「這裡被改了什麼、被顯示了什麼」的記錄軌，持久化在該
Workspace 的 `.agent-team/navide.db`，重啟 Navide 後仍在。這三個 Tool 是 Agent
這一端的入口：回報自己的寫入、讀回其他寫入者回報的內容，以及把某個東西推到使用者
眼前。

| Tool | 參數 | 功能 |
|---|---|---|
| `preview_record` | `rel_path`、`change="modified"`、`note`、`kind="file"`、`content`、`title`、`workspace_path` | 回報你剛剛建立、修改或刪除的檔案；回傳 `{uid, created_at, rel_path, change, merged}`，外加 `warning?` |
| `preview_list` | `limit=50`（上限 300）、`since=0`、`change`、`agent`、`workspace_path` | 讀回這條記錄軌，最新的在前；回傳 `{workspace_path, entries, truncated}`，外加 `warning?` |
| `preview_show` | `rel_path`、`kind="file"`、`content`、`title`、`workspace_path` | 把檔案、diff 或內嵌內容推進右側 rail 的預覽面板；回傳視窗自己的 `{ok, result, error}` 外加 `recorded`，`ok` 時再加上 `uid`、`merged` 與 `warning?` |

`workspace_path` 的行為與 `plan_*` 這組 Tool 完全一致：Pane 呼叫端可以省略它，會取
得該 Pane 自己的 Workspace；Host 或外部呼叫端沒有 Pane 身分，必須傳入，否則呼叫會
錯誤。

`preview_list` 的 `entries` 中每個元素都有 `uid`、`created_at`（Epoch 毫秒）、
`change`、`rel_path`、`kind`、`title`、`source`、`pane_id`、`agent`、`tool`、
`note` 與 `payload`。

| 欄位 | 值域 |
|---|---|
| `change` | `created`、`modified`、`deleted`、`shown` |
| `source` | `user`（在 App 內操作）、`agent`（MCP 呼叫或 CLI Hook）、`watcher`（檔案系統兜底，**無歸屬**） |
| `kind` | `file`、`diff`、`snippet`、`html`、`markdown` |

`preview_record` 只接受 `created`、`modified` 與 `deleted`。`shown` 只由
`preview_show` 寫入，而且要等擁有該 Workspace 的視窗確認收下這次推送之後才寫 ——
沒有人看到的預覽永遠不會被記成 shown。`preview_list` 的 `change` 過濾器四種都接受。

`kind` 決定 `rel_path` 與 `content` 哪一個是必填：`file` 與 `diff` 以路徑定址，需要
`rel_path`（相對於 Workspace）；`snippet`、`html` 與 `markdown` 本身*就是*酬載，需要
`content`，上限 512 K 字元 —— 超過會直接拒絕，而不是截斷。`note` 上限 500 字元，
是截斷而不是拒絕。

**歸屬是從呼叫端的憑證讀出來的**，絕不是從參數：記錄下來的 `pane_id` 與 `agent` 就是
呼叫端 Pane 自己的，沒有任何參數能讓呼叫端冒充成別的 Pane。Host 或外部呼叫端寫入的
記錄則沒有歸屬。

`merged: true` 代表這次事件被折進記錄軌上既有的一筆 —— 同路徑、同 `change`、2 秒之
內，通常是因為檔案系統 watcher 先到了 —— 因此沒有新增任何東西，`uid` 是 `""` 而
`created_at` 是 0。這條記錄軌每個 Workspace 保留最新的 300 筆，超過就汰除最舊的。

`warning` 的意思與 `plan_create` 上的相同：沒有任何 Live 的 Navide Pane 使用
`workspace_path`，因此這筆記錄落在使用者看不到的地方。

**這條記錄軌的寫入者不只這三個 Tool。** 當 CLI Agent 透過 `Write`、`Edit`、
`MultiEdit` 或 `NotebookEdit` 改檔時，Navide 會自動記錄並帶上完整歸屬 —— 但僅限有
Hook 機制的廠商，目前是 **claude、qwen 與 copilot**。其餘所有檔案變更都由檔案系統
watcher 兜底，以 `source: "watcher"` 且無歸屬的形式記錄。因此 `preview_list` 看到的
畫面比該 Workspace 上所有 `preview_record` 呼叫的總和更完整，而沒有 `pane_id` 的
記錄代表沒有人認領這次變更 —— 不是沒有東西造成它。

## Pane 的 id 活得比 Pane 久

CLI Pane 的連線 URL 只在 Pane 生成的那一刻寫入一次，CLI Process 只要還活著就一直
帶著它。裡面的 `pane=<id>` 是那一刻的 Pane id —— 而 Pane id 屬於 Pane 本身，不屬
於裡面的 Process。重載視窗、把 Run Group 拆出去、或把它收回來，都會用同一個還在跑
的 CLI 重建一個 Pane 並發給它新的 id，於是 URL 裡留下的是舊的那個。

那個舊 id 仍然有效。視窗會記下它去了哪裡，所以帶著舊 id 的呼叫會以「這個 Process
實際附著的 Pane」的身分被回答：`plan_*` 預設的 Workspace 一樣、`cli_list_targets`
裡的 `you` 一樣、`cli_send` 用來判斷裸名與自寄的身分也一樣。重載兩次也不會斷鏈 ——
每一跳都會被壓平到當前的 Pane —— 而且 id 永遠不允許跟著 Pane 跨到別的 Workspace。

id 不只是身分，也是一個位址。`cli_send`、`cli_send_and_wait`、`cli_read_log`、
`cli_get_status`、`cli_wait_idle` 都吃一個 `pane_id`，用來取代它們原本的位址參數；
當一個 Workspace 裡有兩個 Pane 同名時，這是唯一搆得到其中某一個的辦法 —— 同時對應
到兩者的名稱會以 `ambiguous-target` 被拒絕，而不是隨便猜一個。它走的是同一張表，所
以一個撐過重載或 detach 的 id，會定址到它一路跟過去的那個 Pane。它撐不過的是用一個
**全新**的 CLI 重建出來的 Pane：那條路徑不會宣告任何舊 id，於是那些 Tool 會回
`unknown-pane-id` —— 意思是「去 `cli_list_targets` 讀一個新的 id」，不是「那個 Pane
不見了」。遠端 Pane 的 id 是另一台機器的名冊鑄出來的，不算這裡的 id，所以跨裝置的目
標仍然要用名稱定址。

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
