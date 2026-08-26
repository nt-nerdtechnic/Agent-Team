# CLI 間メッセージング

[English](../en-US/inter-cli-messaging.md) | [繁體中文](../zh-TW/inter-cli-messaging.md) | 日本語 | [ドキュメント](README.md)

Navide で動作する 2 つの CLI Agent は互いに会話できます。どちらにも API も
共有 File も Plugin も必要ありません。Agent はいくつかのプレーンな行を出力する
だけで別の Agent を宛先に指定でき、Navide は相手の Pane が空いた時点でその
メッセージを入力します。

このドキュメントはその Protocol のリファレンスです。アドレス、Wire Format、
メッセージが届いたとき、あるいは失敗したときに Agent が目にするもの、そして
メッセージが実際に配信されるタイミングを決めるルールを扱います。

ここに書かれたものはすべて Machine 上に留まります。メッセージは App 内の Pane
間を移動するだけで、外部へ送られることは一切ありません。

外部の MCP Client は `cli_send` を通じて同じ配信 Queue に到達します。
[外部 MCP 制御](external-mcp-control.md)を参照してください。

---

## アドレス

すべての CLI Pane は **Messaging Handle** を持ち、それは Pane がタイトルとして
表示している文字列と同じです。表示されている名前がそのままアドレスです。

- 新しい Pane は `<agent key>-<n>` から始まります（`claude-1`、`codex-2`）。
- Pane の名前を変更すると Handle も変わります。新しい名前がすでに使われている
  場合、Navide は別の名前を求めます。キャンセルすると名前変更自体が破棄されます。
- Pane のタイトルを消すと、Handle は自動導出されたタイトルに戻ります。それも
  ない場合はベンダーラベルに戻ります。
- Handle は再起動しても保持されます。
- プレーンな Terminal Pane に Handle はありません。送信も受信もできません。
- `Navide` は予約語です。Navide 自身のメッセージの送信元名だからです。この
  タイトルの Pane には Suffix が付き（`Navide-2`）、Pane をこの名前に変更する
  ことは拒否されます。

CLI Pane で `@` を入力すると、そこから宛先に指定できるすべての Handle の補完
メニューが開きます。他の Workspace Window にある Pane も含まれます。`@` を入力
した直後に Pane を別の Pane 上へドロップすると、その Pane のアドレスが挿入され
ます。

アドレスは常に Handle です。Pane にはもう一つ内部的な **id** があり、それが現れる
のは一箇所だけ——CLI が生成されるときに渡される MCP 接続 URL で、`cli_send` などの
Tool はこれで呼び出し元を知ります。その id は中のプロセスではなく Pane に属するの
で、止まっていない CLI の周りに作り直された Pane（ウィンドウのリロード、デタッチ）
は新しい id を得る一方、CLI は古いものを持ち続けます。古い id はそのプロセスが実際
に結びついている Pane に解決され続けます。
[外部 MCP 制御](external-mcp-control.md#pane-の-id-は-pane-より長く生きる)を参照
してください。

---

## 送信

Agent は **裸の行**に——先頭に空白を置かず、Fenced Code Block の中には決して
入れずに——ブロックを出力することで送信します。

```
---MSG-START--- to: reviewer
Please review src/main.ts and reply with the blocking issues only.
---MSG-END---
```

（このページで表示するため、ここでの例は Fence で囲んでいます。Agent は Fence
なしで出力しなければなりません。``` や ~~~ の中身は Parser が意図的に無視する
ため、これらの Marker を含むコードサンプルは無害なままです。）

Parser が適用するルール:

- `to:` は `---MSG-START---` と**同じ行**に置くか、単独で 1 行を占める Marker の
  **すぐ下の行**に置きます。どちらの形式でもブロックは開きます。配信されるすべて
  のメッセージに付くヒントが教えるのは同じ行に書く形式であり、書くべきなのはそち
  らです。もう一方も受け付けるのは、「Marker は行全体でなければならない」と
  「Marker は 1 行を独占する」がどちらも同じくらい自然に読めるからです。その書き
  方をしたブロックは、以前はただの文字列として破棄され、Queue にも入らず、失敗通
  知も出ず、どちらの側にも痕跡が残りませんでした。
- Navide が*読み取れない* Marker も、もう黙ってはいません。ブロックを開きながら
  1 つも生成しなかった Turn には、[書式の通知](#認識できない形式の通知)が返ります。
- `to:` フィールドは、任意指定の `re:` フィールドまでのすべてを取ります。
- `---MSG-END---` の欠落は許容されます。ブロックは次の `---MSG-START---` か、
  Turn の終わりで閉じます。
- 宛先が空、または本文が空のブロックは破棄されます。
- 1 つの Turn に複数のブロックを含めることができ、そのすべてが送信されます。
- 本文中の `---MARKER---` 形式の Token は、配信前に Zero-width Space で分断され
  ます。転送されたテキストが Parser を再び起動させることは決してありません。

### Broadcast

`to: all`（または `to: *`、大文字小文字を区別しません）は、**同じ Workspace
Window 内**の他のすべての Pane にメッセージを配信します。各受信者は通常の独立
したメッセージを受け取り、それぞれ独自の Queue Slot、Rate Limit の予算、Log 行
を持ちます。Broadcast が Workspace を越えることはありません。

### 別の Workspace

別の Workspace Window にある Pane は `<folder>/<pane>` の形式で指定します。

```
---MSG-START--- to: Agent-Team/reviewer
Rebased onto main — please re-run the suite.
---MSG-END---
```

開いている 2 つの Workspace が同じ Folder 名を持つ場合は、フルパス
（`/Users/me/Agent-Team/reviewer`）を使います。`/` を含まない宛先は、常に送信側
の Window 内で解決されます。

### 返信

配信されたメッセージは Correlation ID を伴います。それを `re:` フィールドに
そのまま返すと、返信が元のメッセージに紐づきます。Messages パネルはこれを使って
2 つの行をスレッドとしてまとめます。`re:` なしで書かれた返信も配信されます。
紐づけがない状態で届くだけです。

---

## 受信

配信されたメッセージは、対象 Pane に次のように入力されます。

```
[Navide MSG] from: builder-1
Please review src/main.ts and reply with the blocking issues only.
（回覆方式：第一行完整寫成 ---MSG-START--- to: builder-1 re: 4f2a…，下一行起為訊息內容，最後一行寫 ---MSG-END---；to: 必須與 ---MSG-START--- 同一行，不可換行；re 欄位請原樣帶回，三行都要頂格，不可縮排，也不可放進 code block）
```

最初の行は常に送信者を示します。末尾のヒントは、Protocol を教わっていない Pane
に返信方法を伝えるためのものです。1 行に収まっているため、Marker と誤認される
ことはありません。

### 配信失敗通知

メッセージを配信できないとき、**送信側**の Pane に通知されます。

```
[Navide MSG] delivery failed — to: reviewer
reason: No pane named “reviewer”
（原訊息開頭：Please review src/main.ts and reply with the blocking…）
```

reason は常に英語です。Agent がそれを読むためであり、Messages パネルは同じ事実
をユーザー向けに別途ローカライズします。この通知は通常の Queue と Idle Gate を
通るため、送信側の Pane を Turn の途中で妨げるのではなく、Pane が空いた時点で
届きます。

通知はアドレスではありません。これに返信すべきものは何もなく、通知自体の配信に
失敗した場合は Log に記録されるだけで、2 つ目の通知が生まれることはありません。

Window 内の生きた CLI Pane ではない送信者に通知は届きません。失敗より前に閉じた
Pane、プレーンな Terminal、そして外部の MCP Client（こちらは代わりに Poll する
ための `cli_check_message` があります）です。

### まだ保留中であることの通知

配信に失敗したメッセージはそう伝えます。しかし、ただ送出されないままのメッセージ
は何も言わず、それを送った Pane は作業を引き渡せたつもりのまま先へ進みます。Queue
に入って **2 分**が過ぎた時点で、送信側の Pane に通知されます。

```
[Navide MSG] still held — to: reviewer
reason: Someone is typing in the target pane — waiting 2 min so far
（原訊息開頭：Please review src/main.ts and reply with the blocking…）
```

これは失敗ではなく、何かを諦めたわけでもありません。メッセージは引き続き Queue に
あり、対象が空けばそのまま送出されます。これが送信者にもたらすのは判断の機会です
——待ち続ける、別の相手に頼む、あるいはユーザーに伝える——答えが向かってきていると
思い込む代わりに。

1 つのメッセージから生まれるこの通知は、生涯で**1 通**だけです。1 時間 Busy な
ままの対象が各送信者に費やさせるのは 1 通だけであり、引用される理由は、その時点で
Messages パネルが表示しているのと同じ `hold` です。

同じルールは、Window 内の生きた Pane である送信者すべてに、その送り方を問わず適用
されます。裸行のブロック、別の Pane からの `cli_send`、別の Workspace 宛のメッセー
ジ、どれでも同じです。Pane *ではない*送信者——外部の MCP Client——に通知は届きません。
入力する先が存在しないからです。そちらは代わりに `cli_inbox_summary` に尋ね、同じ
問いへの答えを得ます。

### 認識できない形式の通知

`---MSG-START---` を単独の行に出力しながらブロックを 1 つも生成しなかった Turn は、
それを書いた Pane でそう伝えられます。

```
[Navide MSG] message not recognized — 這個 turn 出現了 ---MSG-START---，但沒有解析出任何訊息，因此沒有送出、也沒有排進佇列。
```

これは、このページの残りの部分が報告できない唯一の失敗です。ここに書かれている他の
すべては、存在するメッセージ——Queue に入った、保留された、失敗した——についての説明
であり、だからこそ報告できます。Parse されなかったブロックはメッセージを生みません。
Queue のエントリもなく、Log の行もなく、再送も取り消しもできる対象がありません。
送信者には普通の Turn に見え、受信者はついに何も聞かされないままです。

伝えられるのは書いた Pane だけです。その Turn が何を送ろうとしていたかを知っている
のはそこだけだからです。発火するのは Turn がブロックを**1 つも**生成しなかったとき
だけで、一方の Parse に成功し他方が失敗した Turn では何も言いません。

### 何が自分を待っているかを尋ねる

ここまでの通知はすべて Pane に入力されるものであり、つまりその Pane が Turn の合間
にいるときにしか届きません。長い作業に没頭している Agent こそ、何も伝えられない相手
です——そして `cli_pending_incoming` 以前は、自分から尋ねる手段もありませんでした。
`cli_inbox_summary` が答えるのは*「自分が送ったものは届いたか」*であり、*「自分を
待っているものはあるか」*に答えるものはありませんでした。

```
cli_pending_incoming()
→ {ok, count, messages: [{uid, sender, status, age_seconds, kind?, excerpt}]}
```

古い順です。`status` は `queued`（Turn の合間になるのを待っている）か `delivering`
（今まさに入っている最中）です。`kind` は Agent ではなく Navide が書いたメッセージ
であることを示します。`notice` は自分の送信に対する配信フィードバック、`fallback`
は自分が Spawn した Pane からの[代理レポート](#pane-の-spawn)です。

何かが自分を待っているかもしれないとき、自分の作業の区切りで呼び出してください。
`cli_open_agent` で Task を送り出した後や、誰かが中断したくなるかもしれない長い実行
の途中などです。空でない答えは、今いる Turn を切り上げる理由になります。それこそが
メッセージを着地させるものです。

知っておく価値のある制限が 2 つあります。Log は、メッセージが Queue に入った少し後に
受信側の Window が書き込むため、直前の 1 秒間に送られたものはまだ載っていないことが
あります。またメッセージは**現在の** Messaging 名で照合されるため、その後に改名して
離れた名前宛に Queue されているものは、自分に見えるものではありません。
`cli_inbox_summary` と違い、こちらは永続化された Log を読むため、Backend の再起動を
越えて残ります。Inbox を持つのは CLI Pane だけです。Host や外部の呼び出し元には宛先
になれる Messaging 名がないため、空のリストではなくエラーが返ります。

### Spawn フィードバック通知

うまくいかなかった Spawn Request も、同じ方法で要求元の Pane に報告されます。

```
[Navide MSG] spawn failed — 名稱「reviewer」已被其他 pane 使用，請換一個名稱
```

```
[Navide MSG] spawn partial — pane「reviewer」已開啟，但任務注入失敗，請自行確認
```

この 2 つの Prefix が意図的に異なるのは、求められる対応が正反対だからです。
`spawn failed` は Pane が作成されなかったことを意味します。Request を修正して
再試行してください。`spawn partial` は Pane は**開いている**が、Task だけが届か
なかったことを意味します。もう一度 Spawn すると、すでにそこにある Pane と衝突
します。

成功した Spawn はそれ自体では何も送りません。新しい Pane 自身が、通常の MSG
ブロックで親に報告します。その報告は子 Agent 自身の出力です——しかし、報告を書かない
まま Turn を終えた子 Agent が、親に何も残さないということはもうありません。下記の
[代理レポート](#代理レポート)を参照してください。

どちらも配信失敗とまったく同じ System Notice です。Navide が書いたものであり、
`Navide` を宛先にできるものは存在せず、返信すべきではありません。Messages
パネルでは `system notice` バッジが付き、Resend はありません。

---

## Pane の Spawn

同じ裸行の規律で Spawn Request も送れます。新しい Pane は Task を Kickoff として
作成され、通常の MSG ブロックで親に報告します。

```
---SPAWN-START---
agent: codex
name: reviewer
task: Review the diff on this branch and report blocking issues.
---SPAWN-END---
```

`agent:` は Agent Key、`name:` は未使用でなければならず、`task:` はそのフィールド
からブロックの終わりまでが対象です。Spawn に上限はありません。Advisory の閾値を
超えても呼び出しは成功し、要求元にはそのコストが伝えられます。不正な Request
（未知の Agent Key、名前の欠落や重複、空の Task）は、問題を示す
[Spawn フィードバック通知](#spawn-フィードバック通知)として返ってきます。

### 代理レポート

親への報告は子 Agent 自身の出力であり、Navide が書くものではありません。Navide が
保証するのは、親が**何かしら**を受け取ることです。Task が入った後に子 Agent が終える
最初の Turn で、次の 2 つのいずれかが起こります。

- 子 Agent が親を宛先にした——その場合は自身の報告が送られ、他には何も送られません。
- そうしなかった——その場合はその Turn の出力が代わりに転送され、求められていた報告
  と決して取り違えられないようラベルが付きます。

```
[Navide MSG] fallback report — 這個 pane 的 turn 結束時沒有輸出 ---MSG-START--- 區塊，以下是它這個 turn 的最後輸出，由 Navide 代為轉交，不是它自己寫的回報：
…
```

上記の通知群と違い、これは実在の送信者——子 Agent——を持つ通常のメッセージであり、
返信も再送もできます。メッセージ Log と `cli_pending_incoming` では
`kind: fallback` を伴います。

**Pane ごとに生涯 1 回だけ。** その最初の Turn がどちらに転んでもこの負債は清算され
るため、働き続ける子 Agent が報告の連続に変わることはありません。Broadcast は報告と
して数えます。親もそれが届く Pane の 1 つだからです。子 Agent の作業中に親が閉じて
いた場合や、その Turn に転送する価値のあるテキストがなかった場合は、何も送られません。
長い Turn では先頭ではなく末尾が残されます。報告になるはずだった Turn は、その結論で
終わるからです。

これによってその報告が完了シグナルになるわけではありません。Spawn した Pane が本当に
完了したことを確かめるには、`cli_get_status` / `cli_wait_idle` で自分で状態を確認して
ください。

---

## 配信の実際の仕組み

**メッセージは画面ではなく Turn のテキストから読み取られます。** Navide は、その
ベンダーの Log Reader が報告する Pane の完了した Turn を Parse します。Terminal
Buffer を走査することはありません。知っておく価値のある帰結が 2 つあります。

- メッセージは出力された瞬間ではなく、送信側の Turn が終わったときに送出されます。
- Log Reader が Assistant のテキストを運ばないベンダーは、そもそもメッセージを
  送信できません。受信は引き続き動作します。

**配信は対象が Idle になるまで待ちます。** メッセージが注入されるのは、対象 Pane
が生きていて、起動を終えていて、Role や Kickoff の注入中ではなく、その CLI が
Turn の終了を報告済みで、約 2 秒間静かだったときだけです。Permission Prompt で
止まっている Pane は意図的に除外され、Question で止まっている Pane は除外され
ません。Log に Turn 終了の記録を持たないベンダーでは、「Turn が終わった」ことを
十分な長さの沈黙から推測するため、それらの Pane は他より少し遅れてメッセージを
受け入れます。

**ただし CLI 自身が入力を Queue する場合を除きます。** 最後の 2 つの条件——Turn が
終わっていること、そして約 2 秒の静かな窓——は、境界を待つために存在します。
`acceptsMidTurnInput` を宣言するベンダーは、その境界を自ら提供します。Turn の途中で
書き込まれたテキストは CLI 自身の Queue に入り、次の Turn で取り込まれます。ユーザー
が Turn の途中で入力するときと同じ経路です。それらの Pane では、メッセージは届いた
時点で入ります。今日それに該当するのは `claude` だけであり、これは既定ではなく
ベンダーごとに実測した主張であり続けなければなりません——`qwen` は Queue した複数の
メッセージを 1 回の送信にまとめるため、そこで Turn の途中に配信すると 2 人の送信者が
1 つの Turn に混ざってしまいます。

これが、メッセージの向きによって生じていた差を埋めます。Busy な Pane からの返信は
**78 秒**かかり、Idle な Pane への送信は 2 秒でした。返信は親が Idle になるのを待ち、
親は決して Idle にならなかったからです。

意図的に免除*されない*ものが 3 つあります。

- **Typing の保留。** それはキーボードの前にいる人を守るものであり、CLI が Queue
  した入力をどう扱おうと、書きかけの行は同じように失われます。
- **Busy 状態。** Turn の実行中、その Pane は `cli_wait_idle` と
  `cli_list_targets` に対して引き続き自身を Busy と報告します。Pane が何を受け入れ
  るかと、何をしているかは別の問いです。
- **Push Channel。** この免除は入力による経路だけのものです。claude の rewake hook
  は Stop hook 配信の Idle 側の半分であり、Turn の途中はもともと Stop hook の担当で、
  その Stop hook はいずれにせよ Turn の境界で発火します——つまり短縮できる遅延はあり
  ません。加えて、別のイベントのために待機している Waiter に Envelope を渡すことは、
  それに基づいて何も行動しなかった CLI に対して配信済みと記録することになります。
  Turn の途中のメッセージは入力で送られます。

**配信はユーザーのことも待ちます。** 注入は Enter で終わるため、Composer が保持
しているもの——まだ書きかけの行も含めて——を送信してしまいます。入力行に未送信の
テキストがある Pane、または直近数秒以内にキー入力を受けた Pane は、書きかけた
ものを送信するか消去するまで `typing` として保留されます。Pane 上のマウス移動は
Typing ではありませんが、Clipboard の Paste は Typing です。

未送信の行は、ユーザーが Pane へ送ったものから読み取られます。Navide が中を
覗けない CLI の入力ボックスからではありません。この隙間から漏れるケースが 1 つ
あります。CLI 自身が入力ボックスに入れたテキスト——上矢印で以前の Prompt を呼び
出す、補完を受け入れる——はボックスを埋めますが、Navide からは何も入力されて
いないように見えるため、数秒のキー入力ウィンドウだけが守りになります。

同じ隙間は逆方向にも働き、そちらの方が重要です。Permission Prompt や Question に
`1` や `y` だけで答えた場合、キー押下の時点で受理されるため、行が消えたことを
Navide に伝える Enter が続きません。したがって Pane が `awaiting` から
抜けたことをもって回答が受理されたとみなし、未送信の行はいずれにせよ最後の
キー入力から 1 分で配信の保留をやめます。これがないと、たった 1 つの `1` が Pane
を永久に足止めし、以降のすべてのメッセージが `typing` で止まり、その Pane は
問い合わせるすべてに対して Busy と報告されることになります。

**一度に 1 通、順番どおりに。** 各対象は独自の FIFO Queue を持ち、In-flight な
注入は最大 1 つです。注入自体は Bracketed Paste と検証付きの送信で構成されます。
Pane がテキストをエコーバックしない場合、そのメッセージは配信済みと仮定される
のではなく失敗扱いになります。Paste Guard は、書き込みを TUI がまるごと受け取る
単一の挿入に保ち、ユーザー自身の入力と混ざりうるキー押下の連なりにしません。
ベンダーを問わず、すべてのメッセージがこれを伴います。Navide の他の注入（Role
Prompt、Kickoff、Loop の催促）も現在はこれを伴います。ただし TUI が Bracketed
Paste を有効に保つことが判明しているベンダーに限り、かつその TUI が実際に有効に
している間だけです。`!` の Shell モードに入った claude Pane や、生の Login Prompt
で止まっている Pane はこれを無効にしており、そこに書き込まれた Guard は文字どおり
`[200~` として届きます。そのため単一行の注入では、ベンダーだけを信用するのでは
なく、相手側のプログラムが最後に宣言した内容を Terminal に問い合わせます。複数行
のテキストは無条件にラップされます。そこでは Guard こそが、埋め込まれた改行で
Prompt を半分だけ送信してしまうのを防ぐものだからです。

**Workspace をまたぐ配信は受信側の Window のものです。** 送信側の Window は
Backend の Registry にアドレスを渡し、対象 Pane を所有する Window が Queue への
追加、注入、結果の報告を行います。その報告が届くまでメッセージは Queue に留まり
ます。報告が決して来ない場合——相手の Window が Kill された、Machine が Sleep
した——メッセージは約 30 分後に失敗となります。

---

## Stop hook 配信（claude）

ここまでのすべては、メッセージが Pane に**入力される**ことを説明しています。
`claude` Pane にはもう 1 つの経路があり、そちらは入力ボックスをまったく使い
ません。

Claude Code は Turn が終わるときに Stop hook を実行し、Stop hook は「止まるな
——代わりにこれをやれ」と答えることができます。Navide はすでにその hook を
Install しています。そのため claude Pane の Turn が終わる時点で待機中のメッセージ
があると、hook の答え*そのもの*がそのメッセージになります。Claude はそれを次の
指示として受け取り、作業を続けます。

これによって変わること:

- **入力ボックスに一切触れません。** Bracketed Paste も Enter も検証付き送信も
  ないため、書きかけの行が到着したメッセージによって送信されることはなく、
  `typing` の保留は守るべき対象を持ちません。
- **Idle Gate も適用されません。** Pane は Idle ではなく、*Turn を終えつつある*
  ——それが hook の発火する瞬間だからです。
- **メッセージを送出してよいかを決める Guard は引き続き適用されます。** グロー
  バルな一時停止、FIFO の順序、対象ごとの Queue、そしてペアごとの Rate Limit
  です。最後のものはメッセージ送信時に消費されるため、すでに Queue に入っている
  ものは支払い済みです。

Pane を所有する Window に問い合わせが行き、その Window はメッセージを消費する
のではなく**予約**します。行は In-flight として保持され——通常の Queue からは
見えないため、同じメッセージが同時に注入されることはありえません——引き渡しが
確認されてはじめて配信済みになります。Workspace をまたぐメッセージも、それより
前ではなくその同じ瞬間に送信者へ報告します。Messages パネルではその行に
**via hook** バッジが付きますが、これは In-memory のみで、Reload 後は通常の配信
済みメッセージとして表示されます。

hook は実行中ずっと Agent を Block するため、Window の応答時間は **1.5 秒**です。
それを過ぎると hook は待つのをやめ、Pane は通常どおり停止します。予約された
メッセージは Queue の先頭に戻され、通常の入力による経路で送出されます。何も失われ
ず、二重配信も起きません。遅れて届いた応答には、hook はすでに諦めたと伝えられ
ます。

「Queue に何もない」という応答は JSON ではなく**空応答**です。Claude Code は hook
の stdout をその判断として読み取り、認識できない JSON Object は hook Error として
ユーザーに報告されます。空は「判断なし」を意味し、それがまさに正しい振る舞い
です。

Block された Turn も CLI の会話 Log には書き込まれ、その Reader は少し後にそれを
Turn 終了として報告します。Navide はその記録を Superseded とマークします。そこ
から読み取れるもの（Pane が他者に宛てた MSG ブロック、Sentinel、Auto-name）は
すべて有効ですが、それはもはや Pane が空いていることを意味しません。実際に空い
ていないからです。

### カバーしない範囲

- **Turn が終わる瞬間だけ。** Idle のまま座っている claude Pane は Stop hook を
  実行しません。その空白は後述の `rewake` Channel が別途カバーします。こちらは
  Agent が作業中に現れたメッセージのための経路です。
- **claude だけ。** 自分自身の停止を Block できる hook を持つ CLI は他にありま
  せん。
- **hook が Navide に到達したときだけ。** hook が Install されていない、Backend
  が動いていない、hook Request が Timeout した——そのいずれもが入力による配信へ
  Fallback し、挙動の変化はまったくありません。
- **連続回数に上限があります。** この方法で 5 通連続したあとは Pane の停止が許可
  され、Queue に残っているものは入力で送出されます。Claude Code は連続 8 回の
  Block で独自の上限を強制しますが、先に止めることで、上限は我々が説明できるもの
  に保たれます。

---

## Push Channel

上の Stop hook は、より大きな考え方の一例です。一部の CLI には入力ボックス以外の
経路があります。それが存在する場合 Navide はそれを使い、うまくいかないときは入力
へ Fallback します。

Push は別種のメッセージではありません。同じ Queue、同じ FIFO 順序、同じ Rate
Limit、同じグローバル一時停止を使い、変わるのは最後の一歩だけです。Messages
パネルではその行に **via `<channel>`** バッジが付き、`via hook` と同様に
In-memory のみです。

### 各 Channel の価値

| CLI | Channel | 起動時に必要なもの | 「配信済み」が証明すること |
|---|---|---|---|
| `opencode` | `tui-http` — `POST /tui/append-prompt` のあと `/tui/submit-prompt` | `--port <free port> --hostname 127.0.0.1` | 両方の呼び出しが 2xx を返したこと。TUI がテキストを受け取り、送信したことを意味します |
| `kilo` | `tui-http`、同じパス | 同上、加えて `KILO_SERVER_PASSWORD` | 上記と同じ |
| `qwen` | `input-file` — 追記される 1 件の JSONL レコード | `--input-file <per-pane file>` | その行が書き込まれたこと。CLI はそのファイルを 1 秒に 2 回 Poll するため、これが証明するのは**読まれたことではなく書かれたこと**です |
| `claude` | `rewake` — Navide 上で待機する Background hook を、メッセージとともに起こす | なし。Install 済みの hook がこれを準備します | まだ待機していた hook が Envelope を受け取ったこと。Agent がそれをどう扱うかは Claude Code の領分であり、Navide の領分ではありません |

それ以外はすべて、これまでとまったく同じように入力されます。

### どの Hold が引き続き適用されるか

CLI の Composer に書き込む Channel は、入力と同じように入力ボックスを占有する
ため、メッセージの届き方が変わるだけで他は何も変わりません。

- `tui-http` は**引き続きユーザーを待ちます。** `append-prompt` は Composer が
  保持しているものに追記するため、`typing` の保留は変わりません。
- `tui-http` は**引き続き Turn の終了を待ちます。** メッセージが Push されるのは
  Idle な Pane に対してだけです。

それが買うのは、単一で Atomic な挿入です。Bracketed Paste の Guard も、検証付き
送信も不要で、Byte レベルでユーザー自身のキー入力と混ざる可能性もありません。

Composer に到達しない Channel は、それを守るために存在する保留を落とします。

- `input-file` は**ユーザーを待ちません。** レコードは CLI 自身のメッセージ
  Queue——入力されたメッセージが Enter のあとに加わるのと同じ Queue——に入るため、
  Pane に書きかけの行があっても危険はなく、`typing` の保留は適用されません。
- `input-file` は**引き続き Turn の終了を待ちます**。これは仕組み上の制約ではなく
  意図的な選択です。Qwen は Queue に溜まった複数のプレーンメッセージを 1 回の
  送信にまとめるため、忙しい Pane に Push すると 2 人の送信者のメッセージを 1 つ
  の Turn として Agent に渡してしまう可能性があります。
- `rewake` も**ユーザーを待たず**、**引き続き Turn の終了を待ちます**。これは
  Stop hook 配信の Idle 側の半分であり、Turn の途中は Stop hook 自身の担当です。

### claude の 2 本立て：Stop hook と rewake

claude Pane はいま、入力ボックスに一切触れない経路を 2 つ持ち、それぞれが正反対
の瞬間をカバーします。

| | Stop hook | rewake |
|---|---|---|
| 発火 | Turn が終わるとき | Pane が Idle で待機している間 |
| メッセージの届き方 | Agent の次の指示として | **System Reminder** として |
| 上限 | Pane ごとに連続 5 回 | Navide 側にはなし |

メッセージの*届き方*の違いこそが、rewake の Envelope に、これは別の Agent からの
メッセージであり対応すべきものだと述べる冒頭行が 1 行余分に付いている理由です。
そうしないと System Reminder は、渡された作業ではなく Agent 自身の実行についての
注記として読まれてしまいます。Pane の Terminal では、この起動は Claude Code 自身
のラベル `Stop hook feedback` の下に表示されます。

Claude Code は hook の出力を 10,000 文字で打ち切り——それを超えると残りを File に
書き出してプレビューを表示します——そのため、それより長い Envelope はそもそも
Push されず、代わりに入力されます。そちらならすべてが届きます。冒頭行もこの上限
に数えられるため、メッセージ本体に使えるのは約 9,800 文字です。それより長いもの
は単に通常の経路を通ります。

待機中の Request は、Navide が自身の Application Data Directory に保持する Token
を伴います。この File はユーザー本人しか読めません。これは認可の境界ではありません
——hook と同じ Settings File にも置かれ、ユーザーとして動作するものなら何でも読める
からです——これが買うのは、この Machine の Navide が Install した hook だけが Pane
に居座れるということです。Token は一度だけ発行されて保持されるため、Backend を
再起動しても、実行中の Pane が持っている hook は無効になりません。

この待機役は Session 開始時に配置され、毎 Turn の終わりに更新されます。その間は
Pane ごとに 1 つの Sleep している Process です。Pane が閉じたとき、Navide が渡す
ものを得たとき、または 30 分後に解放され、待機役を持たない Pane は単に入力へ
Fallback します。`UserPromptSubmit` を使えばもっと頻繁に更新できますが、意図的に
使っていません。そのイベントで 2 を返して終了すると、通常は入力したばかりの
Prompt が消えてしまうためです。

### トレードオフを率直に

- **`opencode` Pane は認証なしの Port を提供します。** OpenCode には
  `OPENCODE_SERVER_PASSWORD` 変数がありますが、その TUI 自身が自分の Server に
  対して認証しません。設定すると CLI が自分自身へ行うすべての Request が `401`
  で返り、Pane は起動中に死にます（1.15.12 で確認）。そのため Port は
  `127.0.0.1` に Bind した状態で開いたままにしています。この Machine 上でユーザー
  として動作するものなら何でも、その Pane を操作できます。Kilo の TUI はこの変数
  を読むため、Kilo Pane には Pane ごとの Secret が与えられ、その Port はこの意味
  では開いていません。
- **Port が唯一の隔離です。** OpenCode の `/tui/*` Endpoint は `?directory=`
  パラメータを受け付けますが、これは Gate ではありません。別の Workspace を指定
  した Request も同じように処理されます。Pane を隔てているのは 1 Pane 1 Port と
  いう構成です。
- **Port は選ばれるだけで、予約されません。** Navide は Kernel に空き Port を
  尋ねてその番号を CLI に渡し、CLI は少し後にそれを Bind します。その間に他の
  ものが取ることがあります。CLI が Bind に失敗した Pane は単に Channel を持たず、
  そこへのメッセージはすべて従来どおり入力されます。
- **ユーザー自身の `--port` で起動した Pane はそのままにされます。** ユーザーが
  自分で書いたコマンドで、すでにこの Flag を持つ Pane も同様です。
- **`qwen` Pane の Watch File は追記専用で、Pane と寿命を共にします。** 起動時に
  Navide の Application Data Directory へ空で作成され、Pane が閉じると削除され
  ます。Kill された Backend が残した File は次回起動時に掃除されます。それまで、
  その中のメッセージはすべて平文です。Pane の実行中に Rotate も Truncate もされ
  ません。CLI の Watcher は File が縮んだのを見ると先頭から読み直すため、中の
  メッセージをすべて再生してしまうからです。
- **Push の失敗はメッセージの失敗ではありません。** Envelope は通常の入力による
  経路へ戻ります——Pane が入力を受け付けられる状態ならただちに、そうでなければ
  後の Tick で——そして Channel は 1 分間放置されるため、壊れた Channel のコスト
  は 1 秒あたり 1 回ではなく 1 回の試行で済みます（CLI の Server がまだ立ち上がって
  いないだけの場合は数秒だけで、これは自然に解消します）。二重配信は起きません。
  追記はできたが送信できなかった Push は、失敗を報告する前に Composer を Clear
  します。そして Clear は Best-effort であるため、メッセージはその場で入力される
  のではなく Queue に戻されます。

### 無効化する

**Settings → CLI Agents → Push channels** に、Channel を持つすべての CLI が一覧
されます。すべて有効です。1 つを無効にすると、それらの Pane へのメッセージは入力
されるようになります。これは Channel が存在する前にすべての Pane がしていたこと
です。すでに実行中の Pane は起動時に与えられたものを保持し——Port は開いたまま、
Watch File もそのまま——ですが、もう何も Push されず、そのために再起動は不要です。
claude の Channel は自身の Settings File にある hook です。有効・無効のどちらに
切り替えても `~/.claude/settings.json` はただちに書き換えられ、その entry は
Backend の次の再起動を待たずに Switch と一緒に現れたり消えたりします。

再度有効にすると同じ Pane がまた使えるようになります。claude 以外はただちに有効
です。claude Pane は起動時にその Settings File を読むため、すでに開いている Pane
はそのときに与えられた hook のまま動いています。切り替えがその Pane に届くのは
次回の起動時で、それまで、そこへのメッセージは入力されます。切り替えのあとに開いた
Pane は最初から新しい Settings File を持っています。

---

## Guard Rail

| Guard | 上限 |
|---|---|
| 送信者→対象ペアごとの Rate Limit | 60 秒あたり 5 通 |
| 対象 Pane ごとの Pending メッセージ | 10 |
| 配信 Log | 直近 500 行 |
| グローバル一時停止 | Messages パネルのヘッダー |

ペアごとの予算は、2 つの Agent が互いを Loop に引き込むのを防ぐものです。パネル
からの再試行も、他の送信と同じようにこれを消費します。配信失敗通知は独自の別予算
を持つため、フィードバックが送信者の Quota を消費することはありません。

---

## Messages パネル

右側 Rail の **Messages** タブは配信 Log です。この Window が送受信したすべての
メッセージを新しい順に、その Status とともに——まだ Queue にあるものについては、
なぜまだ送出されていないかも——表示します。

- **Pause / Resume** は Window 全体の注入を停止・再開します。
- **Clear log** は完了した行を削除し、まだ In-flight のものを残します。
- **Withdraw** はメッセージを取り消します。行がまだ `queued` の間だけ表示されます
  ——下記を参照してください。
- **Resend** は失敗した行や取り消した行をまったく新しいメッセージとして再送し、
  すべてを一から検証し直すため、別の理由で再び失敗することがあります。配信失敗
  通知には `system notice` バッジが付き、Resend はありません。通知は他の行の失敗
  を報告するだけで、その行自身が Resend を持っているからです。
- Log は Backend Store にミラーされ、Reload 時に復元されます。Window が死んだ
  時点でまだ In-flight だった行は失敗（`window-reloaded`）として戻ります。Queue
  は Reload を越えて生き残らず、自動的に再配信されるものはありません。

### メッセージの取り消し

メッセージは長い間 Queue に留まることがあります——対象が Turn の途中かもしれず、
誰かがその Pane で入力しているかもしれません——そして Queue から取り出されるまで
は、まだ呼び戻せます。`queued` の行で **Withdraw** を押すとまさにそれが起きます。
メッセージは Queue を離れ、行は `Withdrawn` になり、対象 Pane には何も入力されま
せん。後ろに並んでいたメッセージが繰り上がります。

境界線は配信であって、後悔ではありません。行が `delivering` になった時点で
Envelope は Pane へ書き込まれている最中であり、Button は消えます。配信済みの
メッセージは取り消せません。CLI Agent がすでに読んでいるからです。

取り消しは失敗ではありません。送信側の Pane に配信失敗通知は届かず——意図して
取りやめた送信なので、伝えるべきことがありません——行も失敗理由を持たず、
`Withdrawn` という Status だけを持ちます。Resend は提供され、その本文をまったく
新しいメッセージとして再送します。

別の Workspace の Window 宛のメッセージでは、Withdraw は*要求*です。Queue はその
Window のものであり、配信を報告するのと同じ経路で答えます。待っている間、行は
`cancelling` を表示し、最終的に実際に起きたほう——取り消し、あるいは先に入って
しまった場合は配信済み——に落ち着きます。

逆方向も同じです。自分の Pane 宛に Queue されたメッセージ——別の Workspace から、
MCP の `cli_send` から、あるいは別の Machine から中継されたもの——はこの Window
のパネルから取り消せて、送信側には失敗を伝えるのと同じ経路で伝わります。

### メッセージがまだ Queue にある理由

| Hold | 意味 |
|---|---|
| `behind` | 同じ対象宛の他のメッセージの後ろで待機中 |
| `busy` / `not-ready` | 対象 Pane が入力を受け付ける状態ではない |
| `starting` | 対象 Pane がまだ起動中 |
| `typing` | 誰かが対象 Pane で入力している |
| `mid-turn` | 対象 Agent が作業中（Turn の途中で入力を Queue するベンダーでは決して報告されない） |
| `settling` | 対象が静かになったばかりで、落ち着くのを待っている（同じ免除が適用される） |
| `paused` | この Window の配信が一時停止中 |
| `gone` | 対象 Pane がもう存在しない |
| `remote-ack` | 別の Window へ送信済みで、その報告を待っている |
| `cancelling` | 別の Window に取り消しを要求し、その答えを待っている |

`cli_send` を通じて入ってきたメッセージは、その Hold を Backend にも報告します。
そのため送信元の Agent は、見るべき Messages パネルがなくても同じ理由を読み取れます
——[外部 MCP 制御](external-mcp-control.md)を参照してください。伝わるのは*理由*だけ、
それが変わったときだけ、しかも Backend が `msg_key` ですでに追跡しているメッセージ
についてだけです。1 つの Window 内の 2 つの Pane 間のメッセージは他のどこにも知られて
おらず、何も報告しません。Hold 自体は引き続き In-memory であり、永続化されることは
ありません。

### メッセージが失敗した理由

| Reason | 意味 |
|---|---|
| `unknown-target` | その Handle を持つ Pane がない |
| `self-send` | Pane が自分自身を宛先にした |
| `rate-limit` / `queue-full` | 上記の Guard Rail |
| `pane-closed` | 配信前に対象が閉じた |
| `inject-failed` / `inject-error` | Pane への入力が通らなかった |
| `window-reloaded` | In-flight の間に Window が Reload した |
| `no-report` | 相手の Window が結果を報告しなかった |
| `unknown-workspace` / `ambiguous-workspace` | `<folder>/<pane>` アドレスが、開いている Workspace のどれにも一致しなかった、または複数に一致した |
| `unknown-target-in-workspace` / `ambiguous-target` | Workspace は解決したが、Pane 名が一致しなかった、または 2 つに一致した |

---

## Agent に Protocol を教える

- **Pipeline Slot** は自動的に Protocol を受け取ります。すべての Slot Kickoff に
  は、Messaging と Spawn の指示が Prefix として付きます。
- **手動で開いた Pane** には最初から与えられません。最初に受け取ったメッセージ
  に付く返信ヒントが返信には十分であり、Protocol はいつでも Pane に貼り付けて
  渡せます。
- Handle は Pane の名前変更に伴って変わるため、Agent は Session の前の方で得た
  アドレスを覚えているのではなく、`@` の補完リストを読み直すべきです。

---

## 実装の所在

| 関心事 | File |
|---|---|
| Marker、Parser、Envelope と通知のレンダリング（純粋関数） | `src/renderer/src/lib/agentMessaging.ts` |
| Handle Registry、Queue、Guard Rail、配信 State Machine | `src/renderer/src/composables/useAgentMessaging.ts` |
| 注入、Idle Gate、Turn テキストの Hook | `src/renderer/src/App.vue` |
| Stop hook 配信：hook の Timeout 内で所有 Window に問い合わせる | `backend/agent_team_backend/hook_drain.py` |
| Push Channel：Spawn の配線と Transport 本体 | `backend/agent_team_backend/push_delivery.py` |
| CLI がどの Channel を提供するか | `backend/agent_team_backend/cli_vendors/<key>.py`（`push_channel`） |
| その Channel がどの配信 Hold に従うか | `packages/features/plugin-shell/src/agents/<key>.ts`（`pushChannel`） |
| CLI が Turn の途中で入力を Queue するか | `packages/features/plugin-shell/src/agents/<key>.ts`（`acceptsMidTurnInput`） |
| 受信者から見た Queue | `backend/agent_team_backend/agent_message_log.py`（`pending_incoming`） |
| Install される hook コマンドと、どのイベントが応答を保持するか | `backend/agent_team_backend/claude_hooks.py` |
| 配信結果と Hold を、MCP の呼び出し元が読む形で | `backend/agent_team_backend/plugins/builtin/navide_plans/plan_mcp.py` |
| Agent に渡される Protocol テキスト | `src/renderer/src/data/stages.ts` |
| 配信 Log の UI | `src/renderer/src/components/AgentMessagesPanel.vue` |
