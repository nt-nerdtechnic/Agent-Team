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
| `cli_list_targets` | — | アドレス指定可能な CLI Pane を一覧: `name`、`address`、`workspace_path`、`same_workspace`、`busy` |
| `cli_send` | `to`, `text` | 別の Pane が Idle になった時点で指示を配信（Busy なら Queue に保留）。`msg_key` を返す |
| `cli_check_message` | `msg_key` | 一つの `cli_send` の結末: `{status, target, age_seconds, reason?, settled_after_s?}` |
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

このテーブルは Backend の**メモリ**であり、Log ではありません。直近 500 件の送信を
1 時間保持し、Backend の再起動で失われます。未知の `msg_key` は
`{ok: false, error}` を返し、これは「もう追跡していない」という意味であって
「一度も送っていない」という意味ではありません。

`cli_send_and_wait` は、手動の `cli_send` + `cli_wait_idle` の組み合わせが負ける
競合を処理します。送信した瞬間に対象が Idle であるため、素の待機はメッセージを
読む前に「すでに Idle」を返してしまうのです。このツールは送信前に対象の最終活動を
記録し、*それより新しい* Turn だけを答えとして受け入れるため、
`last_activity.text` は相手の Agent が返答として述べた内容になります。Timeout 時の
`reason` は `cli_wait_idle` のものに加え、Idle のままメッセージを拾う気配を
まったく見せなかった対象に対する `never_started` があります。送信自体が拒否された
場合は `cli_send` の `{ok: false, error}` をそのまま返します。

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
