# CLI 之間的訊息傳遞

[English](../en-US/inter-cli-messaging.md) | 繁體中文 | [日本語](../ja-JP/inter-cli-messaging.md) | [文件中心](README.md)

在 Navide 中執行的兩個 CLI Agent 可以互相對話。雙方都不需要 API、共用檔案或
Plugin —— 一個 Agent 只要印出幾行純文字就能對另一個定址，而 Navide 會在對方的
Pane 空下來時，把訊息輸入進去。

本文件是該協定的參考：位址、傳輸格式、Agent 在訊息送達或失敗時看到什麼，以及
決定訊息何時真正送達的規則。

這裡的一切都留在本機。訊息只在 App 內的 Pane 之間傳遞；絕不會被送到其他任何地方。

外部 MCP Client 透過 `cli_send` 接上同一個投遞佇列 ——
見[外部 MCP 控制](external-mcp-control.md)。

---

## 位址

每個 CLI Pane 都有一個 **messaging handle**，而它就是該 Pane 顯示為標題的同一個
字串。你看到的名稱就是位址。

- 新 Pane 從 `<agent key>-<n>` 開始 —— `claude-1`、`codex-2`。
- 重新命名 Pane 會一併改掉 Handle。若新名稱已被使用，Navide 會要求換一個；
  取消則整個放棄這次重新命名。
- 清空 Pane 標題會讓 Handle 回到自動推導的標題，若沒有則回到 Vendor 標籤。
- Handle 在重新啟動後仍然保留。
- 一般 Terminal Pane 沒有 Handle。它們不能傳送也不能接收。
- `Navide` 是保留名稱 —— 它是 Navide 自己的訊息所使用的來源名稱。標題取成這個
  名字的 Pane 會被加上後綴（`Navide-2`），而把 Pane 改名成它會被拒絕。

在 CLI Pane 中輸入 `@` 會開啟一份補完選單，列出你從那裡可以定址的每一個
Handle，包含其他 Workspace 視窗中的 Pane。剛輸入 `@` 之後把一個 Pane 拖放到另一
個 Pane 上，會插入該 Pane 的位址。

位址永遠是 Handle。Pane 另外還有一個內部 **id**，而它只出現在一個地方：CLI 生成時
拿到的 MCP 連線 URL —— `cli_send` 這些 Tool 就是靠它知道呼叫者是誰。那個 id 屬於
Pane 本身，不屬於裡面的 Process，所以用一個從未停止的 CLI 重建出來的 Pane（重載視
窗、拆出視窗）會拿到新的 id，而 CLI 仍然帶著舊的。舊 id 會繼續解析到該 Process 實
際附著的 Pane；詳見
[外部 MCP 控制](external-mcp-control.md#pane-的-id-活得比-pane-久)。

---

## 傳送

Agent 以印出**裸行**區塊的方式傳送 —— 行首不可有空白，也絕不可放在 fenced code
block 內：

```
---MSG-START--- to: reviewer
Please review src/main.ts and reply with the blocking issues only.
---MSG-END---
```

（此頁的範例之所以加上 fence，是為了讓頁面能正確呈現。Agent 必須以不加 fence 的
方式印出 —— ``` 或 ~~~ 內的內容會被 Parser 刻意忽略，這正是讓含有這些 marker 的
程式碼範例保持惰性的原因。）

Parser 套用的規則：

- `to:` 欄位取到選用的 `re:` 欄位之前的所有內容。
- 缺少 `---MSG-END---` 是可以容忍的：區塊會在下一個 `---MSG-START---` 或該回合
  結束時關閉。
- 目標為空或內文為空的區塊會被丟棄。
- 一個回合可以包含多個區塊；全部都會被送出。
- 內文中任何 `---MARKER---` token 都會在投遞前以零寬空白打斷，因此被轉發的文字
  永遠無法再次觸發 Parser。

### 廣播

`to: all`（或 `to: *`，不分大小寫）會把訊息扇出給**同一個 Workspace 視窗中**的每
一個其他 Pane。每個收件者都會拿到一則普通而獨立的訊息 —— 有自己的佇列位置、
Rate Limit 額度與記錄列。廣播絕不跨越 Workspace。

### 另一個 Workspace

以 `<folder>/<pane>` 對另一個 Workspace 視窗中的 Pane 定址：

```
---MSG-START--- to: Agent-Team/reviewer
Rebased onto main — please re-run the suite.
---MSG-END---
```

當兩個開啟中的 Workspace 有相同的資料夾名稱時，請使用完整路徑
（`/Users/me/Agent-Team/reviewer`）。不含 `/` 的目標一律在傳送端的視窗內解析。

### 回覆

送達的訊息會帶一個 correlation id。把它原樣放回 `re:` 欄位，就能把回覆與它所回應
的訊息串起來，這也是 Messages 面板把兩列串成同一串的依據。沒有寫 `re:` 的回覆一
樣會送達 —— 只是抵達時沒有連結關係。

---

## 接收

送達的訊息會像這樣被輸入到目標 Pane：

```
[Navide MSG] from: builder-1
Please review src/main.ts and reply with the blocking issues only.
（回覆方式：輸出裸行區塊 ---MSG-START--- to: builder-1 re: 4f2a…，下一行起為訊息內容，最後一行 ---MSG-END---；re 欄位請原樣帶回，marker 必須獨立整行且不可放在 code block 內）
```

第一行一律標明寄件者。結尾的提示是用來教會從未拿到協定的 Pane 該怎麼回答；它只有
一行，因此絕不會被誤認成 marker。

### 投遞失敗通知

當訊息無法送達時，會通知**傳送端** Pane：

```
[Navide MSG] delivery failed — to: reviewer
reason: No pane named “reviewer”
（原訊息開頭：Please review src/main.ts and reply with the blocking…）
```

原因一律是英文 —— 那是給 Agent 讀的，而 Messages 面板會另外把同一件事在地化給你
看。通知會走一般的佇列與 idle 閘門，所以它會在傳送端 Pane 空下來時才抵達，而不是
在回合中途打斷它。

通知不是位址：不該有任何東西回覆它，而通知本身若投遞失敗只會被記錄 —— 它絕不會
產生第二則通知。

不是視窗中活著的 CLI Pane 的寄件者不會收到通知：在失敗前就關閉的 Pane、一般
Terminal，或外部 MCP Client（它有 `cli_check_message` 可以改用輪詢）。

### 仍被保留的通知

投遞失敗的訊息會說出來。單純一直沒送出去的訊息則什麼也沒說，而送出它的 Pane 就一
直以為工作已經交接出去了。在佇列中待滿**兩分鐘**之後，會通知傳送端 Pane：

```
[Navide MSG] still held — to: reviewer
reason: Someone is typing in the target pane — waiting 2 min so far
（原訊息開頭：Please review src/main.ts and reply with the blocking…）
```

這不是失敗，也沒有放棄任何東西：訊息仍在佇列中，目標一空下來它仍然會進去。它替寄
件者換來的是做決定的機會 —— 繼續等、改找別人，或是告訴你 —— 而不是逕自假設答案
正在路上。

每則訊息一輩子只會產生**一則**這種通知。一個忙碌一小時的目標，對它的每個寄件者都
只花掉一則通知，而引用的原因就是 Messages 面板在那一刻顯示的同一個 `hold`。

同一條規則涵蓋每一個身為視窗中活著 Pane 的寄件者，不論它是怎麼送的：裸行區塊、來
自另一個 Pane 的 `cli_send`、寄往另一個 Workspace 的訊息。*不是* Pane 的寄件者
—— 外部 MCP Client —— 不會收到通知，因為沒有地方可以把它輸入進去；它改問
`cli_inbox_summary`，那會回答同一個問題。

### Spawn 回饋通知

沒有順利完成的 spawn 請求會以相同方式，回報給提出請求的那個 Pane：

```
[Navide MSG] spawn failed — 名稱「reviewer」已被其他 pane 使用，請換一個名稱
```

```
[Navide MSG] spawn partial — pane「reviewer」已開啟，但任務注入失敗，請自行確認
```

這兩個前綴刻意不同，因為它們要求的是相反的反應。`spawn failed` 表示沒有建立任何
Pane —— 修正請求後再試一次。`spawn partial` 表示 Pane **確實**開啟了，只是它的
任務沒有送到；再 spawn 一次會和已經在那裡的 Pane 相撞。

成功的 spawn 不會送出任何東西：新 Pane 會自己以一般的 MSG 區塊向它的 parent 回報。

這兩者都是系統通知，和投遞失敗完全一樣 —— 是 Navide 寫的，沒有任何東西能對
`Navide` 定址，也不該去回覆它們。在 Messages 面板中它們會帶著 `system notice`
標記，而且沒有 Resend。

---

## Spawn 一個 Pane

同一套裸行規範也承載 spawn 請求。新 Pane 會以該任務作為 kickoff 建立，並以一般的
MSG 區塊向它的 parent 回報：

```
---SPAWN-START---
agent: codex
name: reviewer
task: Review the diff on this branch and report blocking issues.
---SPAWN-END---
```

`agent:` 是一個 agent key，`name:` 必須尚未被使用，而 `task:` 從該欄位一路延伸到
區塊結尾。Spawn 沒有上限 —— 超過 Advisory 門檻之後呼叫仍然會成功，並會告訴請求者
它的代價。格式錯誤的請求（未知的 agent key、缺少或已被使用的名稱、空白的任務）會
以指出問題所在的 [Spawn 回饋通知](#spawn-回饋通知)回來。

---

## 投遞實際上如何運作

**訊息讀自回合文字，而不是螢幕。** Navide 解析的是該 Vendor 的 log reader 所回報
的 Pane 完成回合 —— 它從不掃描終端機緩衝區。有兩個後果值得知道：

- 訊息在傳送回合結束時送出，而不是在它被印出來的那一刻。
- log reader 不帶 Assistant 文字的 Vendor 完全無法傳送訊息。接收仍然可以。

**投遞會等待目標進入 idle。** 只有在目標 Pane 活著、已過啟動階段、不在 Role 或
kickoff 注入中途、它的 CLI 已回報回合結束，而且已經安靜約 2 秒時，訊息才會被注
入。停在權限提示上的 Pane 被刻意排除；停在提問上的 Pane 則不排除。對於 Log 中沒
有回合結束記錄的 Vendor，「回合結束」改以夠長的靜默來推論，所以那些 Pane 會比其
他 Pane 稍晚才接受訊息。

**投遞也會等你。** 注入以 Enter 收尾，因此它會把輸入框裡的東西一併送出 —— 包含
你還在寫的那一行。輸入行中有未送出文字，或在最近幾秒內收到過按鍵的 Pane，會被以
`typing` 保留住，直到你把開了頭的內容送出或清掉。滑鼠在 Pane 上移動不算打字；
剪貼簿貼上則算。

那行未送出的文字是從你送進 Pane 的內容讀出來的，不是從 CLI 的輸入框，因為 Navide
看不進去。有一種情況會從這個缺口漏掉：CLI 自己放進輸入框的文字 —— 用上方向鍵叫
回先前的 prompt，或接受一個補完 —— 會讓輸入框有內容，而 Navide 卻看不到任何輸
入，所以只有那幾秒的按鍵視窗能保護它。

同一個缺口也會反向發生，而且影響更大：以裸的 `1` 或 `y` 回答的權限提示或提問，是
在按鍵當下就被採納的，所以後面不會有 Enter 來告訴 Navide 那一行已經沒了。因此
Pane 離開 `awaiting` 就算作它的答案已被採納，而未送出的那一行不論
如何都會在最後一次按鍵後一分鐘停止保留投遞。少了這一條，單一個 `1` 就會讓 Pane
永久停擺 —— 之後每一則訊息都卡在 `typing`，而且該 Pane 對每個詢問者都回報為忙碌。

**一次一則，依序進行。** 每個目標都有自己的 FIFO 佇列，而且最多只有一次注入在進
行中。注入本身是一次 bracketed paste 加上一次經過驗證的送出 —— 如果該 Pane 從未
把文字回顯出來，這則訊息會被判為失敗，而不是被假定已送達。Paste 護欄讓這次寫入成
為 TUI 整份收下的單一插入，而不是一連串可能與你自己的按鍵交錯的按鍵事件；每一則
訊息都帶著它們，不論是哪一家 Vendor。Navide 的其他注入（Role prompt、kickoff、
loop nudge）現在也帶著它們 —— 僅限那些已知 TUI 會保持開啟 bracketed paste 的
Vendor，而且只在該 TUI 仍然開著它的時候。掉進 `!` shell 模式或停在原始登入提示上
的 claude Pane 已經把它關掉了，而寫進那種狀態的護欄會以字面的 `[200~` 抵達，因此
單行注入會去問終端機：另一端的程式最後宣告了什麼，而不是只信任 Vendor。多行文字
則一律會被包起來：在那裡，護欄正是阻止嵌入的換行送出半個 prompt 的東西。

**跨 Workspace 的投遞屬於接收端視窗。** 傳送端視窗把位址交給後端登錄表，而擁有目
標 Pane 的視窗負責排隊、注入並回報結果。在該回報抵達之前，訊息會維持在佇列中。若
回報始終沒有到來 —— 另一個視窗被砍掉、機器睡著了 —— 訊息會在大約 30 分鐘後被判
為失敗。

---

## Stop-hook 投遞（claude）

以上所有內容描述的都是訊息被**輸入**到 Pane 裡。`claude` Pane 有第二條進入路徑，
而且它完全不使用輸入框。

Claude Code 會在回合結束時執行 Stop hook，而 Stop hook 可以回答「別停 —— 改做這
件事」。Navide 已經安裝了那個 hook。所以當一個 claude Pane 的回合結束時正好有訊息
在等它，hook 的回答*就是*那則訊息：Claude 會把它當成下一個指示接手，並繼續工作。

這改變了什麼：

- **輸入框完全不會被碰到。** 沒有 bracketed paste、沒有 Enter、沒有經過驗證的送
  出 —— 所以你打到一半的那一行不會被抵達的訊息送出，而 `typing` 保留也就沒有什麼
  需要保護的了。
- **idle 閘門同樣不適用。** 該 Pane 不是 idle，而是正在*結束一個回合*，那正是
  hook 觸發的時刻。
- **決定訊息是否可以送出的那些守則仍然適用。** 全域暫停、FIFO 順序、每個目標的佇
  列，以及每一對的 Rate Limit —— 最後這一項是在訊息送出時就花掉的，所以已經排進
  佇列的東西都已經付過了。

擁有該 Pane 的視窗會被詢問，而它是**保留**這則訊息而不是消耗它：那一列會被扣在傳
輸中 —— 對一般佇列不可見，因此同一則訊息絕不可能又被注入一次 —— 而且只有在交接
被確認之後才會變成已送達。跨 Workspace 的訊息也是在同一刻才回報給它的寄件者，不
會更早。在 Messages 面板中，那一列會帶著 **via hook** 標記，它只存在記憶體中 ——
重新載入之後它會讀成一則普通的已送達訊息。

hook 執行期間會擋住 Agent，因此視窗有 **1.5 秒**可以回答。超過之後 hook 就不再等
待，該 Pane 正常停止；被保留的訊息會被放回它佇列的最前端，並以一般的輸入方式送
出。沒有東西遺失，也沒有東西被送達兩次 —— 遲到的回答會被告知 hook 早已放棄了。

「沒有排隊中的訊息」這個回答是一個**空回應**，而不是 JSON：Claude Code 會把 hook
的 stdout 讀成它的決定，而它不認得的 JSON 物件會被當成 hook 錯誤回報給你。空的表
示「沒有決定」，那正是對的。

被擋下的回合仍然會寫進 CLI 的對話 Log，而它的 reader 會在稍後把它回報為一次回合
結束。Navide 會把那筆記錄標記為 superseded：從它讀出來的一切（該 Pane 對其他人定
址的 MSG 區塊、它的 sentinel、它的 auto-name）仍然算數，但它不再代表該 Pane 已經
空下來 —— 因為它並沒有。

### 它沒有涵蓋的部分

- **只有回合結束的那一刻。** 閒置中的 claude Pane 不會執行任何 Stop hook。那個缺
  口由下方的 `rewake` 通道另外涵蓋；這裡談的是 Agent 正在工作時出現的訊息所走的
  路徑。
- **只有 claude。** 沒有其他 CLI 具備能擋住自己停止的 hook。
- **只有在 hook 接得到 Navide 時。** hook 沒安裝、Backend 沒在執行、hook 請求逾時
  —— 這些每一種都會退回輸入方式，行為完全不變。
- **重複次數有上限。** 以這種方式連續 5 則訊息之後，該 Pane 就會被允許停止；佇列
  裡剩下的東西改以輸入方式送出。Claude Code 自己在連續 8 次擋停時強制設限，而先
  一步停下來，能讓這個上限仍然由我們來解釋。

---

## Push 通道

上面的 Stop hook 是一個更大想法的其中一例：有些 CLI 有一條不是它輸入框的進入路
徑。只要存在這種路徑，Navide 就會使用它，而在它行不通時退回輸入方式。

Push 不是另一種訊息。它走同一個佇列、同樣的 FIFO 順序、同樣的 Rate Limit 與同樣
的全域暫停；只有最後一步不同。在 Messages 面板中，那一列會帶著
**via `<channel>`** 標記，它 —— 和 `via hook` 一樣 —— 只存在記憶體中。

### 每個通道值多少

| CLI | 通道 | 啟動時需要什麼 | 「已送達」證明了什麼 |
|---|---|---|---|
| `opencode` | `tui-http` —— 先 `POST /tui/append-prompt` 再 `/tui/submit-prompt` | `--port <free port> --hostname 127.0.0.1` | 兩次呼叫都回 2xx：TUI 收下了文字並把它送出 |
| `kilo` | `tui-http`，路徑相同 | 與上者相同，再加上 `KILO_SERVER_PASSWORD` | 同上 |
| `qwen` | `input-file` —— 附加一筆 JSONL 記錄 | `--input-file <per-pane file>` | 那一行被寫入了。該 CLI 每秒輪詢那個檔案兩次，所以這只證明它被**寫入，而不是被讀取** |
| `claude` | `rewake` —— 一個停泊在 Navide 上的背景 hook，隨訊息一起被喚醒 | 什麼都不需要；已安裝的 hook 會為它上膛 | 一個仍在等待的 hook 收下了 Envelope。Agent 之後拿它做什麼是 Claude Code 的事，不是 Navide 的 |

其餘一切都和以前完全一樣，以輸入方式送入。

### 哪些保留仍然適用

會寫入 CLI composer 的通道，就和輸入一樣佔用輸入框，所以它改變的只有訊息如何抵
達，別的都沒變：

- `tui-http` **仍然會等你。** `append-prompt` 會附加在 composer 目前持有的內容之
  後，所以 `typing` 保留不變。
- `tui-http` **仍然會等回合結束。** 訊息只會被 push 給 idle 的 Pane。

它換來的是一次單一而原子的插入：不需要 bracketed-paste 護欄、不需要經過驗證的送
出，也不會在位元組層級與你自己的按鍵交錯。

從不碰到 composer 的通道，會放掉那個為了保護它而存在的保留：

- `input-file` **不會等你。** 那筆記錄會進到 CLI 自己的訊息佇列，也就是你按下
  Enter 之後、輸入的訊息會加入的同一個佇列，因此 Pane 中寫到一半的那一行毫無危
  險，`typing` 保留也不適用。
- `input-file` **仍然會等回合結束**，這是刻意的選擇，而不是這個機制的限制：Qwen
  會把數則排隊中的純文字訊息合併成一次送出，所以 push 進忙碌的 Pane 可能會把兩個
  寄件者的訊息當成同一個回合交給 Agent。
- `rewake` 同樣**不會等你**，而且**仍然會等回合結束** —— 這是 Stop-hook 投遞的
  idle 那一半，而回合中途是 Stop hook 自己的工作。

### claude 這一對：Stop hook 與 rewake

現在 claude Pane 有兩條從不碰它輸入框的進入路徑，而且它們涵蓋相反的時刻：

| | Stop hook | rewake |
|---|---|---|
| 觸發時機 | 回合結束時 | Pane 閒置期間 |
| 訊息以什麼形式抵達 | Agent 的下一個指示 | 一則 **system reminder** |
| 上限 | 每個 Pane 連續 5 則 | 我們這邊沒有 |

訊息*抵達*方式上的差異，正是 rewake Envelope 要多帶一行開頭、說明這是另一個 Agent
的訊息並且應該去執行的原因：否則 system reminder 會被讀成關於 Agent 自己這次執行
的註記，而不是被交付給它的工作。在該 Pane 的終端機中，這次喚醒會顯示在 Claude
Code 自己的標籤 `Stop hook feedback` 之下。

Claude Code 把 hook 的輸出上限訂在 10,000 個字元 —— 超過之後它會把其餘部分寫到檔
案並顯示預覽 —— 因此比這更長的 Envelope 根本不會被 push，而是改以輸入方式送入，
那樣全部內容都會抵達。開頭那一行也計入這個上限：訊息本身大約有 9,800 個字元，更
長的就單純走一般路徑。

停泊的請求帶著一個 Token，Navide 把它放在自己的應用程式資料目錄裡，只有你讀得到。
它不是授權邊界 —— 它同時也放在 hook 所在的那個設定檔裡，任何以你的身分執行的東西
都讀得到 —— 而它換來的是：只有這台機器上的 Navide 裝出來的 hook 才停泊得上去。它
只鑄造一次並保留下來，所以重新啟動 Backend 不會讓執行中的 Pane 手上那支 hook 失效。

等待者會在 Session 開始時就位，並在每個回合結束時更新。在這之間，它是每個 Pane 一
個沉睡的 Process；它會在 Pane 關閉時、Navide 有東西要交給它時，或 30 分鐘之後被釋
放，而沒有等待者的 Pane 就單純退回輸入方式。`UserPromptSubmit` 會更頻繁地更新
它，但刻意不使用：在那個事件上 exit 2 通常會抹掉你剛剛輸入的 prompt。

### 直說的取捨

- **`opencode` Pane 會提供一個未經驗證的連接埠。** OpenCode 有
  `OPENCODE_SERVER_PASSWORD` 變數，但它自己的 TUI 不會對自己的 Server 驗證：設了
  之後，該 CLI 對自己發出的每個請求都會回 `401`，Pane 會在啟動期間死掉（在
  1.15.12 上驗證過）。因此那個連接埠保持開放，綁在 `127.0.0.1`。這台機器上任何以
  你的身分執行的東西都能驅動那個 Pane。Kilo 的 TUI 確實會讀那個變數，所以 Kilo
  Pane 會拿到每個 Pane 各自的 secret，它的連接埠不會那樣開著。
- **連接埠是唯一的隔離。** OpenCode 的 `/tui/*` endpoint 接受 `?directory=` 參
  數，但那不是閘門 —— 指名不同 Workspace 的請求一樣會被服務。一個 Pane 一個連接
  埠，才是讓 Pane 彼此分開的東西。
- **連接埠是挑出來的，不是預留下來的。** Navide 向 kernel 要一個空閒的連接埠並把
  號碼交給 CLI，而 CLI 會在稍後才綁定它；這中間可能有別的東西把它拿走。CLI 因此
  綁定失敗的 Pane 就單純沒有通道，而送給它的每則訊息都會和以前一樣以輸入方式送入。
- **以你自己的 `--port` 啟動的 Pane 不會被動到。** 指令由你自己撰寫、而且已經帶有
  該旗標的 Pane 也一樣。
- **`qwen` Pane 的監看檔案是 append-only，而且與該 Pane 同壽。** 它會在啟動時於
  Navide 應用程式資料目錄中被建立為空檔，並在 Pane 關閉時移除；被砍掉的 Backend
  留下的檔案會在下次啟動時掃掉。在那之前，其中每則訊息都是明文。它在 Pane 執行期
  間絕不會被輪替或截斷：CLI 的監看器只要看到那個檔案變小，就會從頭重讀整個檔案，
  那會把裡面每一則訊息重播一次。
- **push 失敗絕不等於訊息失敗。** Envelope 會回到一般的輸入路徑 —— 若該 Pane 已可
  接受輸入就立刻進行，否則等到之後的某個 tick —— 而該通道會被放置一分鐘，讓一個壞
  掉的通道只花掉一次嘗試，而不是每秒一次（若只是 CLI 的 Server 還沒起來，就只有幾
  秒，那會自己好）。沒有東西會被送達兩次：附加成功但無法送出的 push，會在回報失敗
  之前清空 composer，而由於清空是 best effort，那則訊息會回到佇列中，而不是當場以
  輸入方式送入。

### 把某個通道關掉

**Settings → CLI Agents → Push channels** 會列出每一個有通道的 CLI。它們全部都是
開啟的；把某一個關掉表示送到那些 Pane 的訊息會以輸入方式送入，也就是在通道存在之
前每個 Pane 的做法。已經在執行的 Pane 會保留它啟動時拿到的東西 —— 它的連接埠仍然
開著、它的監看檔案仍在原處 —— 但不會再有任何東西被 push 給它，而且這件事生效不需
要重新啟動。Claude 的通道是它自己設定檔裡的一個 hook：不論開或關，都會立即改寫
`~/.claude/settings.json`，那筆 hook 會隨著開關出現或消失，而不是晚一次 Backend
重新啟動才生效。

把某個通道重新打開，同樣的 Pane 就能再度使用 —— 除了 Claude 之外都是立刻生效。
Claude Pane 是在啟動時讀那個設定檔的，所以已經開著的 Pane 跑的仍是它當時拿到的
hook：這次切換要等到那個 Pane 下一次啟動才對它生效，在那之前，送給它的訊息會以
輸入方式送入。切換之後才開的 Pane，一開始就是新的設定檔。

---

## 防護欄

| 防護 | 上限 |
|---|---|
| 每個「寄件者→目標」配對的 Rate Limit | 每 60 秒 5 則訊息 |
| 每個目標 Pane 的待處理訊息 | 10 |
| 投遞記錄 | 最後 500 列 |
| 全域暫停 | Messages 面板標題列 |

配對額度是阻止兩個 Agent 把彼此聊進迴圈的東西。從面板重試會像其他任何傳送一樣花
掉額度。投遞失敗通知帶著自己獨立的額度，因此回饋絕不會吃掉寄件者的配額。

---

## Messages 面板

右側 Rail 的 **Messages** 分頁就是投遞記錄：這個視窗傳送或接收的每一則訊息，最新
的在最上面，附帶它的狀態，以及 —— 在它仍在佇列中時 —— 它為何還沒送出。

- **Pause / Resume** 停止與重新啟動整個視窗的注入。
- **Clear log** 丟掉已完成的列，保留仍在傳輸中的那些。
- **Withdraw** 把訊息收回來，只在那一列仍是 `queued` 時出現 —— 見下方。
- **Resend** 會把失敗或已撤回的那一列當成全新的訊息重新傳送，一切從頭重新驗證，
  所以它可能因為不同的原因再次失敗。投遞失敗通知帶著 `system notice` 標記且沒有
  Resend —— 通知只是回報另一列的失敗，而那一列有它自己的。
- 記錄會鏡射到 Backend 儲存，並在重新載入時還原。在視窗死掉時仍在傳輸中的列會以
  失敗（`window-reloaded`）回來 —— 佇列不會在重新載入後存活，也不會有任何東西被
  自動重新投遞。

### 撤回一則訊息

一則訊息可能在佇列裡待很久 —— 目標可能正在跑一個 turn，也可能有人正在那個 Pane
裡打字 —— 而在它被從佇列取走之前，都還收得回來。在 `queued` 那一列按
**Withdraw** 就是做這件事：訊息離開佇列，那一列變成 `Withdrawn`，目標 Pane 裡不
會被打進任何東西，排在它後面的訊息往前遞補。

分界線是投遞，不是後悔。一旦那一列進入 `delivering`，信封正在被寫進 Pane，按鈕
就消失了；已投遞的訊息無法收回，因為 CLI Agent 已經讀到了。

撤回不是失敗。寄件的 Pane 不會收到投遞失敗通知 —— 沒什麼好通知的，這次傳送是刻
意取消的 —— 那一列也不帶失敗原因，只有 `Withdrawn` 狀態。它仍然提供 Resend，會
把內容當成全新的訊息重送。

對於寄往另一個 Workspace 視窗的訊息，Withdraw 是一個*請求*：佇列屬於那個視窗，
它會用回報投遞的同一條路徑回答。等待期間那一列顯示 `cancelling`，最後落在實際發
生的結果上 —— 撤回，或者訊息先進去了就是已投遞。

反方向也一樣。排隊要進你自己 Pane 的訊息 —— 來自另一個 Workspace、來自 MCP 的
`cli_send`、或從另一台機器轉進來的 —— 都可以從這個視窗的面板撤回，寄件方會透過
和收到失敗時同一條路徑被告知。

### 訊息為何仍在佇列中

| 保留 | 意義 |
|---|---|
| `behind` | 正在同一個目標的其他訊息後面等待 |
| `busy` / `not-ready` | 目標 Pane 不在可以接受輸入的狀態 |
| `starting` | 目標 Pane 仍在啟動中 |
| `typing` | 有人正在目標 Pane 中打字 |
| `mid-turn` | 目標 Agent 正在工作 |
| `settling` | 目標剛剛安靜下來；正在等它穩定 |
| `paused` | 這個視窗的投遞已暫停 |
| `gone` | 目標 Pane 已不存在 |
| `remote-ack` | 已送往另一個視窗；正在等它的回報 |
| `cancelling` | 已向另一個視窗要求撤回；正在等它的回答 |

透過 `cli_send` 進來的訊息也會把它的保留原因一併回報給 Backend，因此送出它的
Agent 不必有 Messages 面板可看，也能讀到同一個原因 ——
見[外部 MCP 控制](external-mcp-control.md)。只有*原因*會傳出去，只在它改變時傳，
而且只針對 Backend 已經以 `msg_key` 追蹤中的訊息；同一個視窗中兩個 Pane 之間的訊
息別處無人知曉，也不會回報任何東西。保留本身仍然只存在記憶體中，而且仍然絕不持久
化。

### 訊息為何失敗

| 原因 | 意義 |
|---|---|
| `unknown-target` | 沒有具備該 Handle 的 Pane |
| `self-send` | 某個 Pane 對自己定址 |
| `rate-limit` / `queue-full` | 上面的某條防護欄 |
| `pane-closed` | 目標在投遞前就關閉了 |
| `inject-failed` / `inject-error` | 把它輸入到該 Pane 沒有成功 |
| `window-reloaded` | 視窗在它傳輸中途重新載入 |
| `no-report` | 另一個視窗始終沒有回報結果 |
| `unknown-workspace` / `ambiguous-workspace` | 一個沒有對應到任何開啟中 Workspace、或對應到多個的 `<folder>/<pane>` 位址 |
| `unknown-target-in-workspace` / `ambiguous-target` | Workspace 解析成功，但 Pane 名稱沒有 —— 或是對應到兩個 |

---

## 教會 Agent 這套協定

- **Pipeline slot** 會自動拿到協定：每個 slot 的 kickoff 都會以訊息與 spawn 指示
  作為前綴。
- **手動開啟的 Pane** 不會事先拿到它。它們收到的第一則訊息上的回覆提示就足以回
  覆，而且隨時可以把協定貼進該 Pane 交給它們。
- Handle 會隨著 Pane 被重新命名而改變，因此 Agent 應該重新讀取 `@` 補完清單，而
  不是記住 Session 中稍早的某個位址。

---

## 這些東西放在哪裡

| 事項 | 檔案 |
|---|---|
| Marker、Parser、Envelope 與通知的呈現（純函式） | `src/renderer/src/lib/agentMessaging.ts` |
| Handle 登錄表、佇列、防護欄、投遞狀態機 | `src/renderer/src/composables/useAgentMessaging.ts` |
| 注入、idle 閘門、回合文字 hook | `src/renderer/src/App.vue` |
| Stop-hook 投遞：在 hook 的逾時內詢問擁有該 Pane 的視窗 | `backend/agent_team_backend/hook_drain.py` |
| Push 通道：spawn 接線與傳輸機制本身 | `backend/agent_team_backend/push_delivery.py` |
| 某個 CLI 提供哪一種通道 | `backend/agent_team_backend/cli_vendors/<key>.py`（`push_channel`） |
| 該通道仍然要遵守哪些投遞保留 | `src/renderer/src/agents/<key>.ts`（`pushChannel`） |
| 已安裝的 hook 指令，以及哪個事件會保留它的回應 | `backend/agent_team_backend/claude_hooks.py` |
| 投遞結果與保留原因，以 MCP 呼叫端讀到的形式 | `backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp.py` |
| 交給 Agent 的協定文字 | `src/renderer/src/data/stages.ts` |
| 投遞記錄 UI | `src/renderer/src/components/AgentMessagesPanel.vue` |
