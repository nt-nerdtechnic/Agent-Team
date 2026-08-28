# プライバシーとデータフロー

[English](../en-US/privacy.md) | [繁體中文](../zh-TW/privacy.md) | 日本語 | [ドキュメント](README.md)

Navide は **Local-first** ですが、常に完全オフラインという意味ではありません。Electron Application、Python Backend、Terminal Session、非公開の Project Intelligence、Workspace State、Orchestration Logic は Mac 上で動作します。外部 Service を有効化または利用すると、データが端末外へ送られる場合があります。

## Navide がローカルに保存するデータ

有効な機能に応じて、Navide は次を保存します。

- `<workspace>/.agent-team/` 内の、ユーザーごとに非公開の Project Intelligence と Run Artifact
- Application Data Directory 内の Role、Pipeline、Recent Workspace、UI Setting、Analyzer Setting、AI Provider Setting
- Application Data Directory 内の Host 管理 Plugin Storage Partition。認証済みの Plugin/Package ごとに分離され、Workspace Scope では認証済み Workspace ごとに分離されます。Navide や Plugin Registry へ送信されません
- Local CLI Log から得た Token Attribution と Deduplication Metadata
- 任意の AI Provider API Key。制限された File Permission（対応 System では `0600`）で保護された Local Settings File に保存

Navide は Project Telemetry Service を運営せず、Navide Account を必要としません。

## 非公開の Project Intelligence

`.agent-team/` は、その Local Workspace を使う個々のユーザーに属します。Git から除外され、人間の Team Member 間で State を同期するためのものではありません。Private Prompt、Task Context、Session Identifier、Agent Output、Run Event、Handoff、Token Summary、将来の Coordination Metadata が含まれる場合があります。

`.agent-team/` を `.gitignore` から削除したり、意図的に作成した Project Documentation の代わりとして公開したりしないでください。Artifact を共有する必要がある場合は、必要な Specification、Decision、Report、Patch、Evidence だけを Review して Export してください。

将来の Portability Feature では、Redaction と Selection Control を伴う明示的な Local Export/Import を使用すべきです。Navide は Private Project Intelligence を暗黙に Cloud または Repository State へ変えてはなりません。

## 外部と通信する可能性がある機能

| 機能 | 送信先の可能性 | 関係するデータ |
|---|---|---|
| Coding Agent CLI | CLI Vendor または設定された Model Provider | Prompt、選択した Context、Tool Result、Provider 定義の Telemetry |
| Cloud AI（Inline 編集と Code Review） | Anthropic、OpenAI、Google、Groq、DeepSeek、Mistral、xAI、Custom Endpoint | 選択したコード、Prompt、Model Parameter |
| Context7 Injection | Context7 と MCP Distribution/Runtime Dependency | 検出された Library Name と Documentation Query |
| Web Search | Search Provider | Search Query Text |
| Git Operation と Issue Detection | 設定された Git Host。Local `git`、`gh`、`glab` CLI 経由 | Repository/Issue Data と、CLI または Host Account Flow が扱う Credential |
| Update Check | GitHub Releases | Application Version と通常の Network Metadata |
| Plugin Registry Trust Refresh | 選択した Official Registry、または明示的に承認した self-hosted Registry | インストール済み marketplace plugin の namespace/name。Refresh では Plugin Source や Archive を送信しない |
| MCP Server | 設定された MCP Server と、それが利用する Service | Server の Tool と Configuration に全面的に依存 |

Private Code や規制対象 Data を送信する前に、各 Provider の Policy を確認してください。

Production Git Package は Host 所有の argv Allowlist を通して `git`、`gh`、`glab`
をローカルで実行します。Navide がこれらの Service を Proxy したり、Repository
を Navide へ Upload したりすることはありません。Local CLI が Remote Operation
または Issue Query を実行すると、設定された Remote、CLI Login、Provider Policy
に従って GitHub または GitLab が Data を受け取る場合があります。Git Account
Credential は Host の保護された Local Account Store または CLI 自身の Credential
Flow に残り、Plugin Renderer Storage には書き込まれません。分離された v2 Git
Renderer が受け取るのは非 Secret の Account Metadata と Workspace Binding State
だけです。Remote Git Operation では、Host が Backend 呼び出しの直前に Bound
Credential を注入します。Workspace に Host Account の Binding がない場合でも、v2
は Host 所有の Interactive Credential Flow を使用できます。Host は Operation ごとに
Opaque で Instance-bound な Owner を作成し、Git の Prompt を発行元の正確な Git
View に転送し、Response を受け入れる前に Request Ownership を検証します。入力
された Secret はその Exchange の間だけ保持され、Plugin Storage には保存されません。
別の View または別の Workspace からの Credential Response は拒否されます。

インストール済みの marketplace plugin がある間、Navide は Application 起動時と
15 分ごとに、その Plugin の namespace/name を選択した Registry へ送信します。
これは、署名済みの Trust Metadata を取得し、Revoke された Publisher や Package を
検出してインストール済み Plugin を隔離するためです。送信先は設定した Registry URL
で決まります。Official URL を使う場合は App に Pin された Official Registry を、
self-hosted URL を使う場合はユーザーが明示的に承認した URL と Root だけを使います。
この Refresh で Plugin Source、Package Archive、Workspace File を Upload することは
ありません。

Navide は、再起動後の Check に使うため、最新の署名済み Trust Snapshot を Plugin
Installation とともにローカルに保持します。Registry 自身の Request Log の保持は、
その Registry の管理に委ねられます。現在、Refresh 専用の無効化設定はありません。
インストール済みの marketplace plugin をすべて削除すると、この Data Flow は停止
します。その他の外部 Service の Data Flow は、それぞれの設定に従います。

Issue 16 の Production Storage Integration が有効な場合、Plugin の Uninstall は
Cleanup が成功した後に、その Plugin の Local Storage を削除します。後で再インストール
しても、削除された Storage は復元されません。First-party `navide.git` の Migration
は Host 所有の明示的な Consumer であり、Git Preference は認証済みの Package と
Workspace Storage Partition を使用します。Upgrade 時には、以前の Active Snapshot
を新しい Candidate に複製し、Rollback 用に旧 Snapshot を保持する場合があります。

## 認証情報

Agent CLI の Credential は各 CLI の Configuration に残ります。Cloud AI Key を Navide に入力すると、AI 機能（Inline 編集、Code Review）で利用できるようローカル保存されます。Settings Export では API Key と Token を Redact します。

Local File Permission は、同じ Machine 上の他 User による偶発的 Access を減らしますが、Malware、Compromised User Account、Unrestricted Agent、Backup、同等権限の Process からは保護しません。

## Agent の権限

External CLI が独自 Sandbox を提供して有効化しない限り、Agent は現在のユーザーの OS 権限で実行されます。Navide は現在、完全な Workspace Sandbox を提供していません。

YOLO Mode は CLI の Confirmation または Sandbox Protection を回避する場合があります。信頼でき、Version Control された Workspace でのみ使用し、後から Command と Diff を確認してください。

## Context Handoff

Agent 間の Handoff には Task Context と前 Stage の Output が含まれる場合があります。Automatic Secret Scrubbing は、まだ完全な Security Boundary ではありません。他の Agent へ渡される可能性がある Prompt、Generated Plan、Log、File に Credential を置かないでください。

## ローカルデータの削除

Active Session を停止した後、Workspace の `.agent-team/` Directory から Private Project Intelligence を削除できます。削除すると Source Repository は残りますが、Resumability、Run History、Attribution、蓄積 Context が失われる場合があります。Application 全体の Setting と History は Navide Application Data Directory にあります。保持したい Configuration は削除前に Backup してください。

Vulnerability の報告については、[Security Policy（英語）](../../SECURITY.md)を参照してください。
