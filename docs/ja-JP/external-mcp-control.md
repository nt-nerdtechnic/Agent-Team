# 外部 MCP 制御

[English](../en-US/external-mcp-control.md) | [繁體中文](../zh-TW/external-mcp-control.md) | 日本語 | [ドキュメント](README.md)

Navide は MCP（Model Context Protocol）Endpoint `/plan-mcp` を公開しており、
Navide の Pane で動作する CLI Agent はこれを自動的に使用します。同じ Endpoint
は Navide 自身の Process Tree の外にある Client — Script、別の場所で動作する
AI Agent、あるいは MCP に対応した任意の Tool — にも開放でき、動作中の Navide
ウィンドウを操作させられます。Pane を開く、UI Action を呼び出す、別の Agent の
会話 Log を読む、Plan Document を管理する、といった操作です。

これは既定では無効です。有効にするということは、**この Mac 上で動作するあらゆる
Process が Navide を制御できる**ということです。有効化する前に
[セキュリティモデル](#セキュリティモデル)を参照してください。

すべての Pane がすでに自動的に得ている二つの方向（Navide が自身の CLI Agent に
Tool を渡す方向と、Pipeline 実行中に Navide が外部の Documentation MCP Server を
利用する方向）については、App 内の Settings → MCP にある「說明」タブ
（[`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)）を参照して
ください。本ドキュメントが扱うのは三つ目、Opt-in の方向 — 外部 Client が Navide
を制御する方向です。

## 接続

1. **Settings → MCP → External access** を開き、**Allow external MCP clients**
   を有効にします。
2. **Connection URL** をコピーします。形式は次のとおりです。

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` は Backend の現在の Port であり（起動時に動的に選ばれるため、再起動
   をまたぐと URL が変わります。Navide を再起動したらコピーし直してください）、
   `<token>` は外部の呼び出し元だけに Scope された Bearer Secret です。
3. MCP Client を **streamable HTTP** でその URL に向けます。それ以上の Handshake
   や登録は不要です。すべての Tool 呼び出しは URL の Query String にある Token で
   認証されます。
4. 同じパネルの **Regenerate token** は古い Token を即座に無効化し、新しい Token
   を発行します。URL が漏洩した可能性がある場合に使用してください。

この Endpoint が受け付ける呼び出し元の Credential は三種類だけです。Pane 自身の
Credential（Navide が claude/codex の Pane を Spawn するときに発行）、この Backend
内部の「host」Credential（自身の CLI 配線が使用）、そして上記の外部 Credential
— これは Settings の Toggle で制御されます。外部の呼び出し元は Pane の Identity
を持たず、したがって自分の Workspace も持ちません。Pane を指定するすべての Tool
（`cli_send`、`cli_read_log`、`cli_get_status`、`cli_wait_idle`）は、素の Pane 名
ではなく完全修飾の `<folder>/<pane>` 形式を必要とし、UI State を指定する Tool
（`ui_invoke`、`ui_snapshot`、`ui_list_actions`）や Plan Document を指定する Tool
（`plan_*`）は明示的な `workspace_path` を必要とします。Pane として動作する
呼び出し元はこれを省略でき、その場合その Pane 自身の Workspace が使われます。

実装: [`plan_mcp.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp.py)
（Tool）、[`plan_mcp_auth.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_auth.py)
（Credential Store、App Data Directory 配下の `plan_mcp_auth.json`）、
[`plan_mcp_wiring.py`](../../backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp_wiring.py)
（Pane/Host の配線 — 外部 Client には不要）。

## Tool カタログ

### Plan Document

| Tool | パラメータ | 動作 |
|---|---|---|
| `plan_list` | `workspace_path` | `.agent-team/plans/` 配下の Plan Document を一覧: `rel_path`、`name`、`stage`、`overview`、`todos` の要約、`mtime` |
| `plan_read` | `workspace_path`, `rel_path` | 一つの Plan の Parse 済み Meta と生の HTML を読み取り |
| `plan_create` | `workspace_path`, `name`, `overview`, `todos` | Template から Plan を作成し、Stage `draft` から開始 |
| `plan_update_stage` | `workspace_path`, `rel_path`, `stage` | Stage を設定: `draft`、`in-review`、`approved`、`in-progress`、`done`、`abandoned` |
| `plan_update_todo` | `workspace_path`, `rel_path`, `todo_id`, `status` | 一つの Todo の Status を設定: `pending`、`in-progress`、`done`、`skipped` |
| `plan_add_note` | `workspace_path`, `rel_path`, `text`, `author?`（`ai`\|`user`、既定は `ai`） | Review Note を追記 |

ここで `workspace_path` が必須なのは、外部 Client が Pane ではないためです。Pane
の呼び出し元はこれを省略し、Tool はその Pane 自身の Workspace を使います。これは
Plan ウィンドウが Plan を解決する際の基準と同じものです。

`plan_create` は、`workspace_path` がどの Live Pane の Workspace とも一致しない
場合に `warning` フィールドを返します。File は書き込まれますが、Navide の Plan
ウィンドウはそれを見つけられません。

`plan_list` はリストを返し、MCP はリストを単一の JSON 配列ではなく**要素ごとに
一つの Content Block** として配信します。Block を連結して一度に Parse すると
`Extra data` で失敗します。各 Block を個別に Parse するか、呼び出しの
`structuredContent` を読んでください。ここにある他の Tool はすべて単一の Object
を返すため、これが問題になるのは `plan_list` だけです。

### CLI Pane — メッセージングと Spawn

これらの Tool は、Agent が裸行の `---MSG-START---` Block を出力して到達するのと
同じ配信 Queue に投入します。共有されるアドレス、Idle Gate、防護策については
[CLI 間メッセージング](inter-cli-messaging.md)を参照してください。

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_list_targets` | — | アドレス指定可能な CLI Pane を一覧: `name`、`address`、`workspace_path`、`same_workspace`、`busy`、`hold_reason?` |
| `cli_send` | `to`, `text`, `wait_for_delivery_s=0`（上限 120） | 別の Pane が Idle になった時点で指示を配信（Busy なら Queue に保留）。`msg_key` を返し、待機を指定した場合はその結末も返す |
| `cli_check_message` | `msg_key` | 一つの `cli_send` の結末: `{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_inbox_summary` | — | 自分の送信のうち滞留中または失敗しているもの: `{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20`（上限 200） | **CLI Pane 専用。** *自分宛*に Queue され、まだ入っていないもの: `{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt}]}` |
| `cli_send_and_wait` | `to`, `text`, `timeout_s=60`（上限 120） | `cli_send` に加えてその Turn の完了まで待機。`cli_wait_idle` の結果に `{ok, target, msg_key}` を付けて返す |
| `cli_open_agent` | `agent`, `name`, `task`, `workspace_path`（Pane 以外の呼び出し元では必須） | Task 付きで新しい CLI Pane を Spawn。`{ok, name, address}` を返し、Spawn が Advisory の閾値を越えた場合は `advisories` も返す |

`cli_send` は、メッセージが配信のために*受理された*時点で返り、相手の Agent が
読んだ時点ではありません。`cli_check_message` がそのループを閉じます。`status`
は `queued`（Broadcast 済みでどのウィンドウからも報告がない — Busy な Pane の
ために保留されたメッセージは、実際に注入されるまでここに留まります）、
`delivered`、`failed` のいずれかです。`failed` の場合、`reason` は受信側
ウィンドウの判定です。`rate-limit`（同じペア間で短時間にメッセージが多すぎる）、
`queue-full`（対象の保留メッセージ Queue が上限に達している）、`inject-failed`
（Pane への打ち込みが通らなかった）、`pane-closed`（配信前に対象が消えた）、
`no-report`（試行が結果を報告しなかった）です。

失敗は、要求がなくても送信側の Pane にも Push されます。Navide は対象と理由を
記した `[Navide MSG] delivery failed` の通知を、その Pane が Idle になった時点で、
通常のメッセージと同じ Queue と注入経路を通じて書き込みます。これは一度も Poll
しない Agent 向けの注意喚起であり、`cli_check_message` が引き続き正式な答えです。
また、この通知はアドレス指定可能ではないため、これに返信すべきものは何もありません。

**メッセージが入るまで待つ。** Poll がループを閉じるのは Poll を忘れない Agent に
対してだけで、送って先へ進む Agent は何も知ることができません。
`wait_for_delivery_s` は、その答えを同じ呼び出しの中に置く仕組みです。`cli_send` は
その秒数だけメッセージが実際に入るのを待ち、同じ結果の中で何が起きたかを報告します。

| 結末 | 返るもの |
|---|---|
| 入った | `status: "delivered"`、`settled_after_s` |
| ウィンドウが拒否した | `status: "failed"`（別の Machine からの場合は `"rejected"`）、`reason` |
| 時間切れの時点でまだ待機中 | `status: "queued"`、`waited_s`。受信側ウィンドウが理由を述べた場合は `hold` と `held_for_s` も |

拒否されても `ok` は **true** のままです。理由は `cli_send_and_wait` の
`target_lost` と同じで、送信は実際に行われ `msg_key` も本物なので、`ok: false` と
答えると「一度も送っていない」と読まれて再送を招き、作業が二重に発行されてしまう
からです。有用な範囲は 10〜30 秒です。この待機は呼び出し元自身の Turn を消費し、
Turn の途中の Pane や入力されている Pane はメッセージをはるかに長く保留しうるから
です。既定の `0` のままなら、答えは従来と 1 Byte も変わりません。

**メッセージがまだ Queue にある理由。** `hold` は Messages パネルが表示するのと
同じ理由で、`{key, n?}` の形をとります。`key` は `typing`、`mid-turn`、`behind`、
`starting`、`settling`、`not-ready`、`gone`、`paused`、`remote-ack` のいずれかで、
`held_for_s` はその状態が続いている長さです。これは `cli_check_message` と、
Timeout した `cli_send` の待機に現れ、メッセージが決着したあとや、どのウィンドウも
理由を報告していない間は現れません。`cli_list_targets` は同じ事実を Pane ごとに
`hold_reason` として見せ、それが `busy` を説明可能にしています。ただしここから送った
メッセージがその Pane 宛に Queue されている間だけなので、無いことは何も意味しません。

**Queue に長く留まりすぎたとき。** `queued` のメッセージが **2 分**を超えて待つと
`stale` が現れます。`cli_check_message` でも、Timeout した `cli_send` の待機でも
同じです。これは判定ではありません——何も失敗しておらず、何も諦めていません——
「これは向かっている途中だ」という前提が安全でなくなる地点であり、隣の `hold` と
併せて読み、待ち続けるか、別の相手に頼むか、ユーザーに何か伝えるかを判断して
ください。計測の起点は現在の Hold ではなく送信時点です。`mid-turn` と `typing` の
間を行き来するメッセージは毎回 `held_for_s` を振り出しに戻しますし、この仕組みが
本来対象としているケース——どのウィンドウも Hold を一度も報告しなかったケース——には、
読むべき Hold の時計自体がありません。

`cli_inbox_summary` は、尋ねるための `msg_key` を持たない場合の同じ事実です。引数を
取らず、呼び出し元自身についてだけ答え、現在 stale または失敗している自分の送信を
すべて返します。60 文字の `excerpt` が付くので、Key を控えていなくてもどのメッセージ
かが分かります。配信済みのものと、送ったばかりで Queue に入っているものは除かれる
ため、空のリストは「自分のものは何も滞留していない」を意味し、「何も送っていない」
ではありません。これは通知が届かない Agent のために存在します。配信失敗通知は送信側
の Pane が Idle になってからそこへ入力されるため、1 時間 Busy であり続ける Agent は
一度も目にせず、外部 Client にはそもそも入力する先の Pane がありません。自分の作業の
合間にこれを呼ぶことが、20 分前に送ったメッセージがまだ Queue に座っていると知る
方法です。

このテーブルは Backend の**メモリ**であり、Log ではありません。直近 500 件の送信を
1 時間保持し、Backend の再起動で失われます。未知の `msg_key` は
`{ok: false, error}` を返し、これは「もう追跡していない」という意味であって
「一度も送っていない」という意味ではありません。

`cli_pending_incoming` はその鏡像です。*自分宛*に Queue されているものを古い順に返し、
`status` は `queued` か `delivering`、Agent ではなく Navide が書いたメッセージには
`notice` または `fallback` の `kind` が付きます。**これは本節で唯一、外部 Client が
使えないツールです。** ここにある他のすべては Pane に*対して*働きかけますが、これは
呼び出し元自身の Inbox を尋ねるものであり、Inbox を持つのは CLI Pane だけです。Host や
外部の呼び出し元には宛先になれる Messaging 名がないため、この呼び出しは空のリストでは
なく `{ok: false, error}` を返します。自分を宛先にできるものが存在しない以上、自分を
待っているものも存在しません。外部から同じ景色を得たい Client は、`cli_list_targets`
で Pane の `hold_reason` を読むか、`cli_check_message` / `cli_inbox_summary` で自分の
送信を追ってください。

上の送信テーブルと違い、こちらは永続化されたメッセージ Log を読むため、Backend の
再起動を越えて残ります。制限が 2 つあります。Log はメッセージが Queue に入った少し後に
受信側の Window が書き込むため、直前の 1 秒間に送られたものはまだ載っていないことが
あります。またメッセージはその Pane の**現在の** Messaging 名で照合されるため、その後
に改名して離れた名前宛に Queue されているものは返りません。

`cli_send_and_wait` は、手動の `cli_send` + `cli_wait_idle` の組み合わせが負ける
競合を処理します。送信した瞬間に対象が Idle であるため、素の待機はメッセージを
読む前に「すでに Idle」を返してしまうのです。このツールはまずメッセージが**入る**
のを待ち、そのうえで送信前に記録した対象の最終活動より*新しい* Turn だけを答えと
して受け入れるため、`last_activity.text` は相手の Agent が返答として述べた内容に
なります。Timeout 時の `reason` は `cli_wait_idle` のものに加え、Idle のまま
メッセージを拾う気配をまったく見せなかった対象に対する `never_started` があります。
送信自体が拒否された場合は `cli_send` の `{ok: false, error}` をそのまま返します。

`timeout_s` は両方の段階をカバーします。**最大でもその半分**がメッセージを送り込む
ために使われ、残りが Turn の完了を待ちます。配信に使われた時間は無駄になりません
——Pane が空けばメッセージは着地し、それは Idle の待機がどのみち座って待っていた
はずの時間だからです——とはいえ折り返し地点でまだ保留されているメッセージが残り
時間で答えを得る見込みは薄く、その Hold の理由は「Timeout、Busy」よりはるかに有用な
答えです。最後まで届かなかった場合の結果は `source: "not_delivered"` で、
`delivery_status` を伴います（`queued` なら `hold` / `held_for_s`、`failed` /
`rejected` なら `reason`）。これは、対象が Idle のままメッセージが保留されていた
ケースへの修正です。以前の順序では、送信した時点の状態から `idle` と答えてしまい、
作業が一度も引き渡されていないのに「あなたの作業を終えた」と読めてしまいました。
`target_lost` と同じく `ok: true` のままです——これを理由に再送しないでください。

待機*中*に対象がアドレス指定可能でなくなった場合 — ウィンドウが閉じた、Pane が
Kill された — 結果は `{ok: true, idle: false, source: "target_lost", error}` に
なります。ここが `ok: true` のままなのは意図的です。送信はすでに行われており
`msg_key` も有効なので、ここで失敗を報告すると「一度も送っていない」と読まれて
再送を招き、作業が二重に発行されてしまうからです。これは「配信済みだが、完了した
かどうかはもう確認できない」と読んでください。

Spawn に上限はありません。Pane は任意の数の子を Spawn でき、Workspace は任意の数の
CLI Pane を保持でき、Spawn の連鎖は任意の深さで実行できます。Advisory の閾値
（子 3、Workspace の Pane 8、深さ 2）を越えても呼び出しは成功し、コストを示す
`advisories` を返します。たとえば各 Pane が 250〜500MB を占めることなどです。
それでも失敗するのは不正なリクエストです。未知の Agent Key、名前の欠落または
すでに使用済み、空の Task です。これらの Advisory は Diagnostics としても記録され、
`ui_diagnostics` で読み取れます。

### CLI Pane — 読み戻し

| Tool | パラメータ | 動作 |
|---|---|---|
| `cli_read_log` | `target`, `tail_lines=200`, `since?` | Pane の会話 Log の末尾（≤512KB かつ ≤`tail_lines` 行）。`next_cursor` と `rotated` を返す |
| `cli_get_status` | `target` | `{busy, agent_key, last_activity?, ui?}` — `ui` は所有ウィンドウが応答したときに `ui.pane.getStatus` を反映 |
| `cli_wait_idle` | `target`, `timeout_s=60`（上限 120） | Pane が Idle になるか Timeout するまで Block。`{idle, source, waited_s, last_activity?, ui_status?}` を返し、Timeout 時は `reason` も返す |

`cli_read_log` の `since` は増分読み取りです。前回の呼び出しの `next_cursor` を
渡し戻すと、同じ末尾を読み直す代わりに、それ以降に Pane が述べた分だけを取得
できます。Cursor は追記専用の Capture File 内の Byte Offset であるため、その File
が切り詰められたり置き換えられたりすると意味を失います。その場合、呼び出しは
`rotated: true` を伴う素の末尾を返し、これは新しい出力ではなく仕切り直しです。

`cli_wait_idle` の `last_activity` は `cli_get_status` が同じキーで報告するものと
同じなので、Turn を待ち切った呼び出し元は二度目の呼び出しなしにその Turn の内容も
得られます。`ui_status` は Pane に対する所有ウィンドウ自身の見解であり、待機中に
Probe が届いた場合にのみ存在します。Timeout 時、`reason` は似て見えるが実際には
異なる三つの失敗を切り分けます。`awaiting`（Pane が Permission Prompt で停止し、
**人間**を待っている — UI で応答してください）、`busy`（本当にまだ作業中。もっと
待ってください）、`unreachable`（Pane を所有するウィンドウが応答しなくなったため、
結果の中身はどれも最新ではない）です。

**Capability の境界 — Idle/完了の検出。** ほとんどの CLI の Log Reader は、完了した
Turn のテキストを載せた `turn_complete` Event を発行します。**aider、antigravity、
claude、codex、copilot、cursor、grok、kilo、kimi、muse、opencode、pi、qwen** です。
これらでは `cli_wait_idle` と `cli_get_status` の `last_activity.type` が正確な
Turn 完了 Signal で解決します — ただし一点だけ但し書きがあります。**grok、kimi、
pi、qwen** は自前の Turn 終了記録を持たず、Log の 8 秒の沈黙から `turn_complete`
を合成するため、この四つでは Event 自体が推測であり、Turn の途中で十分に長い間が
空くと待機が早く終わることがあります。素の Terminal Pane にはそうした Signal が
まったくありません —
`cli_wait_idle` は新しい活動のない 10 秒の静穏期間から Idle を推測する方式に
フォールバックし（応答では `source: "quiet_period"`）、`cli_get_status` の
`last_activity` は `"agent_active"` しか報告しないことがあります。静穏期間に
基づく Idle 結果は Heuristic として扱い、CLI が実際に完了したという保証とは
考えないでください。

これは、`cli_send_and_wait` の結果で読むべきフィールドが `source` である理由でも
あります。どの CLI が生み出したものでも形は同じですが、確度は同じではありません。
aider/antigravity/claude/codex/copilot/cursor/kilo/muse/opencode からの
`turn_complete` は Turn が終わったという CLI 自身の言明であり、grok/kimi/pi/qwen
からの同じ値は上記の 8 秒沈黙による推測です。そして `quiet_period` — 素の
Terminal Pane で唯一得られる結果 — は、Turn の終了を何も報告しなかったという
意味なので、Signal を信用せず中身を確認してください。`target_lost` は四つ目の値で、
Turn に対する判定ではない唯一のものです。待機が判定に至る前に Pane が消えたことを
示します。

### UI Action Bus

| Tool | パラメータ | 動作 |
|---|---|---|
| `ui_list_actions` | `workspace_path` | `workspace_path` を所有する Navide ウィンドウに登録されたすべての Command ID を一覧 |
| `ui_invoke` | `workspace_path`, `action`, `args?` | 登録済みの Action を一つ呼び出し、`args` をそのまま渡す |
| `ui_snapshot` | `workspace_path` | そのウィンドウの UI State の構造化 Snapshot |

三つとも所有ウィンドウの応答を最大 15 秒待ち、現在 `workspace_path` を開いている
ウィンドウがなければ Error になります（完全一致の文字列比較 — ウィンドウを開いた
ときと同じ Path を渡してください）。`ui_invoke` の `action: "ui.workspace.open"`
だけが例外です。その Workspace をまだどのウィンドウも所有していない可能性がある
ため、`workspace_path` に一致するウィンドウではなく、生きている任意の Navide
ウィンドウ一つにルーティングされます。

`ui_list_actions` は、下記の `ui.*` の ID だけでなく、そのウィンドウが Keybinding
に使う Command Registry *全体*を返します。内部 ID（例: `workbench.action.*`）は
キーボードショートカットのために存在するもので、外部向けの文書化された契約では
ありません。安定した文書化済みの引数形状を持つのは、下の表にある `ui.*` の Action
だけです。

#### `ui.*` Action リファレンス

| Action | Args | 効果 |
|---|---|---|
| `ui.settings.open` | `{tab?}`（`general`、`mcp`、`analyzer`、`updates`、`appearance`、`accounts`、`storage`、`keybindings` のいずれか） | Settings を開く。任意で特定のタブへ |
| `ui.settings.close` | — | Settings を閉じる |
| `ui.pane.create` | `{agent, name?, task?}` | ウィンドウが開いている Workspace に `agent` の Pane を Spawn。`task` を指定した場合は Kickoff Prompt として送られ、Role 注入はスキップされる |
| `ui.pane.close` | `{paneId}` | Pane を Kill |
| `ui.pane.focus` | `{paneId}` | Pane を表示して Focus（必要ならタブを切り替え） |
| `ui.pane.getStatus` | `{paneId}` | その Pane の `{status, buffer, logPath?}` を返す |
| `ui.tab.switch` | `{tabId}` | Active な Stage/Run-group タブを切り替え |
| `ui.preview.show` | `{kind, …}` | 右レールのプレビューパネルにファイル・diff・インラインスニペットを表示 |
| `ui.window.openPlans` | — | Plan ウィンドウを開く |
| `ui.window.openGit` | — | 現在の Workspace の Git ウィンドウを開く |
| `ui.window.openPipeline` | `{pipelineId?}` | Pipeline Manager ウィンドウを開く |
| `ui.workspace.open` | `{path}` | `path` を Workspace として開く（生きている任意のウィンドウにルーティング — 上記参照） |
| `ui.layout.setMode` | `{mode}` | Pane の Layout Mode を変更 |

この一覧はここではなくコード側で保守されています。正確な引数形状に依存する前に、
[`App.vue`](../../src/renderer/src/App.vue) の
`registerCommand('ui.*', …)` ブロックと照合してください。

`ui_snapshot` の形は Renderer が決めます（`App.vue` の
`buildUiActionSnapshot`）。`{workspace, panes: [{id, name?, agentKey,
workspacePath, status?}], activeTab, settingsOpen, openWorkspaces}` です。

## Pane の id は Pane より長く生きる

CLI Pane の接続 URL は Pane が生成された瞬間に一度だけ書かれ、CLI プロセスは動いて
いるかぎりそれを持ち続けます。その中の `pane=<id>` はその瞬間の Pane id です。そし
て Pane id は中のプロセスではなく Pane そのものに属します。ウィンドウのリロード、
Run Group のデタッチ、そしてそれを戻す操作は、いずれも動き続けている同じ CLI の周り
に Pane を作り直して新しい id を与えるので、URL には古い id が残ります。

その古い id は今も有効です。ウィンドウがその行き先を記録するため、古い id を持つ呼
び出しは「そのプロセスが実際に結びついている Pane」として応答されます。`plan_*` が
既定にする Workspace も、`cli_list_targets` の `you` も、`cli_send` が裸の名前と自
分宛て送信を判定する identity も同じです。二度リロードしても連鎖は切れず（各ホップ
は現在の Pane に畳み込まれます）、id が Pane について別の Workspace に移ることは決し
て許されません。

Pane の [Push Channel](inter-cli-messaging.md#push-channel) もおおむね同じように付
いていきますが、一つ例外があります。ウィンドウのリロードでは保持され、デタッチされ
たウィンドウから Run Group が戻る場合も保持されます。しかし**デタッチ**では保持され
ません。Pane を渡す側のウィンドウが、受け取る側が Pane を要求する前に Pane を——そ
して Channel も一緒に——手放すためで、デタッチされた Pane はその CLI を再起動するま
で Channel が存在しなかった頃と同じく入力欄に打ち込まれます。claude Pane は影響を受
けません。その hook は次のターン終了時に自分で張り直します。

どの id をどの id が引き継いだかは Navide のウィンドウが申告し、そのまま信用されま
す。デタッチの最中は申告される id がまだ生きていて、手放そうとしているウィンドウが
所有しているため、「生きている Pane に対する主張」と「正当な引き継ぎ」はバックエン
ドから区別できず、拒否ではなくログに記録されます。取り返しがつかない一点だけは別途
拒否されます。接続中のウィンドウがミラーしている Pane は、誰が要求しても Push
Channel を手放しません。

引き継ぎを伴わずにその警告が出る既知のケースが一つあります。Run Group の一つがデタ
ッチされている状態でメインウィンドウがリロードすると、その Group が別の場所にあると
知る前にその Group の Pane を復元してしまい、子ウィンドウの id を一時的に主張しま
す。ウィンドウに知らされた時点で自動的に是正され、子ウィンドウの Push Channel が奪
われることはありません。

いまも拒否されるのは、どこも指していない id です。Pane が閉じられたか、それを所有し
ていたウィンドウが忘れられるほど長く不在だった場合です。名乗れる identity が残って
いないので、このエンドポイントのすべての Tool が `this pane's id is stale` と答えま
す。対処は Pane を開き直すことです。（これは上のキュー中メッセージに付く `stale` と
は別物で、あちらは「2 分以上待っている」ことしか意味しません。）

これは下の Tool **リスト**の問題とは別です。リストは Client が接続時に取った
スナップショットで Navide には更新手段がありませんが、id は呼び出しのたびに Navide
が解決しています。

## Tool リストは一度だけ読まれる

MCP Client は接続時に Server の Tool リストを尋ね、Navide の `/plan-mcp` はその後
それを変更することがありません。つまり **Client がその瞬間に見たものが、そのまま
持ち続けるもの**になります。

- **CLI Pane** は、その CLI Process の起動時にリストを Snapshot します。Navide が
  更新されたときすでに動いていた Pane は、もう存在しない Backend と話している状態
  です。新しい Navide が追加した Tool やパラメータを取り込むには、Pane を開き直して
  ください。
- **外部 Client** は、再接続するまでリストを保持します。いずれにせよ Connection URL
  は再起動をまたぐと変わる（Port は起動時に選ばれる）ため、これは通常それだけで
  解消します。

アップグレード後、Navide はそれを一度だけ知らせます。ステータスバーの Announcement
フィードに「MCP tools may have changed」という項目が現れ、置き換えられた Version を
示します。これは、この Backend が実際に前回とは異なる Version で起動したときにだけ
現れます。初回インストール時にも、通常の再起動時にも現れません。

### なぜ Navide は Client に通知しないのか

Protocol にはこのための仕組みがあります。Server が `tools.listChanged` Capability を
宣言し、Tool の集合が変わったときに `notifications/tools/list_changed` を送ると、
それを扱う Client は Session の途中でリストを読み直します。Navide がこれを使えない
理由は、互いに独立した 2 つあります。

**Transport に Push する先がありません。** `/plan-mcp` は streamable HTTP を
Stateless モードで、JSON 応答で動かしています。Transport は Request ごとに構築されて
破棄され、開いたままの Stream は保持されません。この構成では、Server 発の通知が
Client へ届く経路がありません。MCP SDK はそれを長命な Stream 宛に送ろうとし、
見つからず、破棄します。届くようにするには Session 指向のモードで動かす必要があり、
それはこの Endpoint が意図的に持たない状態です。（2026-07-28 版の仕様は Protocol
レベルの Session を廃し、これらの通知を Client が開く `subscriptions/listen` Stream
へ移しました。どちらにせよ開いたままの Stream です。）

**半分の CLI は無視します。** 各 Client 自身のソースまたはドキュメントに対して確認、
2026-08-17:

| CLI | `list_changed` で Tool リストを読み直すか？ |
|---|---|
| Claude Code | する（2.1.0 以降） |
| GitHub Copilot CLI | する |
| OpenCode | する |
| Grok | する |
| Codex CLI | しない — 通知を Log に記録するだけで何もしない |
| Cursor（`cursor-agent`） | しない — 更新は `/mcp` による手動操作 |
| Qwen Code | しない — この Fork は上流の Gemini CLI にある Handler を落としている |
| Kimi CLI | しない — 通知処理そのものがない |

いずれにせよ通知すべきことは何もありません。`/plan-mcp` の Tool はすべて Import 時
に登録され、その集合は Backend の実行中に変わらないからです。Pane を開き直すことが
解決策のすべてであり、だからこそ工学的に回避するのではなくドキュメントに記して
います。

## CDP デバッグ（エスケープハッチ）

Settings → MCP → External access には **Chrome DevTools Protocol** の Toggle も
あります（[`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts)、設定は
`userData/cdp-debug.json`）。有効化には App の再起動が必要で — Electron は
`--remote-debugging-port` を App の Ready 前に設定した場合しか受け付けません —
デバッグ Port は `127.0.0.1` にのみ Bind されます。

これは Fallback であって主要な統合経路ではありません。上の Tool カタログが
カバーするものはすべてそちらを使ってください。CDP が存在するのはカバーされない
もののためです。実際にレンダリングされたウィンドウのスクリーンショットを撮る、
登録された `ui.*` Action がないものを操作する、といった用途です。できることの
大きさゆえに（下記参照）、最後の手段として扱ってください。

## セキュリティモデル

| これを有効にすると… | …こうなります |
|---|---|
| **Allow external MCP clients** | 有効な間、このマシン上で動作するあらゆるものが Navide を制御できます。Pane の Spawn と Close、開いているどの Workspace のどの CLI Pane への指示送信、Plan/Git/Pipeline ウィンドウのオープン、そして別の Pane の会話 Log の読み取りです。 |
| **CDP debug** | 有効な間、このマシン上で動作するあらゆるものが Navide の Renderer 内で任意のコードを実行できます。どの Tool 契約にも縛られない、完全なリモートデバッグアクセスです。 |

実務上の注意:

- どちらの Toggle も `127.0.0.1` にのみ Bind され、LAN やリモートへ露出することは
  ありません。ただし共有マシンでは、「このマシン」には他のすべてのローカル
  ユーザーアカウントと、あなたの権限で動作する他のすべての Process が含まれます。
- 外部 Token は Bearer Secret です。Connection URL を持つ者は誰でも、Token を
  再生成するまで完全な外部アクセスを持ちます。Token は App Data Directory 配下の
  `plan_mcp_auth.json` に平文で保存されます。
- これらの Tool を通じた Filesystem への書き込みは、Backend の他の部分が使うのと
  同じ Path Guard（`fs_service._resolve_safe`）で引き続き制限されます。Plan Tool は
  Workspace の `.agent-team/plans/` の内側にしか書き込めません。UI Action と CDP
  には同等の Sandbox がありません。UI Action は `App.vue` の Handler が行うことを
  そのまま行い、CDP は無制限のコード実行です。
- それを必要とした作業が終わったら、外部アクセスと CDP は元どおり無効に戻して
  ください。どちらも既定で有効にしておくことを意図したものではありません。

関連: Navide 全般の Local-first なデータ姿勢については
[プライバシーとデータフロー](privacy.md)を、すべての Pane が自動的に得る二つの
方向については App 内の Settings → MCP にある「說明」タブを参照してください。
