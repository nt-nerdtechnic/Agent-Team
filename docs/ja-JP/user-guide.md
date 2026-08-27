# ユーザーガイド

[English](../en-US/user-guide.md) | [繁體中文](../zh-TW/user-guide.md) | 日本語 | [ドキュメント](README.md)

## プロダクトモデル

Navide は、一人のエンジニアが複数の AI Agent を指揮するために設計されています。主な操作は常に File Editing とは限りません。Outcome の設定、Session の協調、Progress の観察、意味ある Exception の処理、検証済み Result の受け入れです。

日々の作業は三つの Loop を通じて進みます。

1. **Genesis** は Pipeline を使い、Idea を最初に動く Prototype へ変えます。
2. **Evolution** は一つ以上の Agent Session を通じて既存 Project を反復的に開発、Test、Fix、Refine します。
3. **Intervention** は Diff、Editor、Terminal、Diagnostics、Git、Review Tool を通じて、エンジニアが Result を確認または直接変更できるようにします。

現在の Pipeline は Genesis Loop を実装しています。Manual Pane と Maintenance Mode は初期 Evolution Workflow を提供し、Editor と Review Surface は Intervention を提供します。

## Runtime の考え方

Navide には三つの Work Level があります。

1. **Workspace** は Project Folder であり、Project State、Run History、Git Operation の境界です。
2. **Pane** は Agent CLI または Plain Shell を実行する Live Terminal Session です。
3. **Pipeline** は設定可能な Stage の順序付き集合です。各 Stage は一つ以上の Parallel Slot を持ち、各 Slot が Agent と Role を選びます。

## Workspace

Welcome Screen は Recent Workspace を一覧表示し、Pinning をサポートし、存在しない Folder を示します。Workspace を開くと UI State と対象 Session が復元されます。Workspace を切り替える、または閉じる前に、中断してはならない Active Work を完了または Abort してください。

Navide は Workspace 内の `.agent-team/` に、ユーザーごとに非公開の Project Intelligence を保存します。この Directory は Git から除外され、共有 Team State として扱ってはなりません。個々のエンジニアの Local Workflow に属する Task Context、Session Metadata、Run History、Handoff、Token Information が含まれる場合があります。

Source Code と明示的に共有された Documentation は、Repository における Team-visible Truth であり続けます。`.agent-team/` の情報を共有する必要がある場合は、Specification、Architecture Decision、Test Report、Issue、Commit、Pull Request など、意図的な Artifact に変換してください。

## Manual Agent Pane

完全な Genesis Pipeline が不要な Exploration、Maintenance、Evolution Task では Manual Spawn を使います。

- Agent と Role を選択します。
- Spawn 前に Launch Command を確認します。
- Agent が不要な場合は Plain Terminal Pane を使います。
- Main Layout を占有せず PTY を維持するには Pane を Minimize します。
- Navide が再利用可能な Session ID を検出した後にのみ Rebuild または Resume します。

組み込みで対応する Agent Key は 13 種類のコーディング CLI（Aider、Antigravity CLI、Claude Code、Codex、Copilot CLI、Cursor CLI、Grok CLI、Kilo Code、Kimi Code、Muse Code、OpenCode、Pi、Qwen Code）です。正確な CLI Behavior と Provider Billing は各 External Tool が引き続き管理します。

## Pipeline

付属 Pipeline は Requirement、Planning、Design、Implementation、Security Review、Testing を網羅します。Stage、Slot、Role、Kickoff Prompt、Question、Completion Sentinel は Settings で設定できます。

一つの Stage で複数 Slot を並行実行できます。Navide は設定された Completion Signal と Agent State に基づいて進行します。Generated Change と Test Result は必ず確認してください。Automatic Completion は Workflow Progress を示すもので、Correctness を保証しません。

## Manager と Worker の協調

一つの Slot を Global Manager として動かせます。Manager は Stage 間 Context を受け取り、Worker に作業を Delegation し、Worker Question を処理し、Navide の Routing Protocol を通じて Stage Completion を Signal します。

Task が Decomposition または Parallel Ownership の恩恵を受ける場合に Manager を使います。小さな Task では、Single-agent Stage の方が通常は低コストで確認しやすくなります。

## Automation Mode

- **YOLO** は対応 CLI で Approval または Trust Prompt を回避する CLI-specific Flag を渡します。一部 CLI は Confirmation Gate なしですでに Tool を実行する場合があります。
- **Full Auto** は利用可能な Task Context を使い、Analyzer が Agent Question に回答できるようにします。
- **Strict** は選択された Timeout または Progression Boundary で確認を求めます。
- **Continuous** は設定された Automation Behavior に従って Pipeline を進行させます。
- **Local Analyzer** は Local Intent Classification と関連 Automation を有効化します。

保守的な設定から始めてください。YOLO と Full Auto は、追加の User Confirmation なしに Agent が File を変更したり Command を実行したりする可能性があります。

## Management by Exception

Navide の長期的な運用哲学は、可逆的で観察可能な作業を Agent に継続させ、人間の判断に価値があるときだけエンジニアへ注意を戻すことです。現在の Automation Mode は初期 Control であり、完全な Policy Engine ではありません。

次の場合に介入してください。

- Requirement に大きく異なる複数の有効な解釈がある
- Architecture または Product Choice が長期的な影響を持つ
- Session が Ownership、File、Technical Direction をめぐって Conflict している
- Test と明示された Acceptance Criteria が一致しない
- Credential、Payment、Deployment、Publication、Destructive Operation、External System が関係する
- Result に Subjective Product Judgment または Quality Judgment が必要

Routine Exploration、Reversible Edit、Local Test、Diagnostic、Repair は、可視性と中断可能性を保ちながら、最終的には Approval Noise なしで進むべきです。

## History と Token Tracking

History は Pipeline、Stage、Pane、Question、Analyzer、Handoff、Warning Event の Append-only Timeline です。Run History は `.agent-team/runs/` に保存され、Filter または Export できます。

Token Stats は対応 Local CLI Log を Parse し、Usage を Workspace、Pane、Stage、Run に Attribution します。Observability Feature であり、Provider Invoice ではありません。Provider 側の Usage と Billing が正式な情報です。

## Git と Review

Marketplace Install が利用可能になるまで、Navide は削除可能な Official Git Factory Package を提供します。Active Package Version は Embedded Left View と Dedicated Git Window の両方を提供します。Extensions で Bundled Git を削除すると再起動後も削除状態が維持され、同じ画面の **Restore** で Factory Copy を復元できます。Verified Marketplace Version が存在する場合はそちらが優先されます。Git View は Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue、関連 Workflow をサポートし、Multi-repository Workspace では検出された Repository を切り替えられます。Repository Operation は Navide の Host／Backend Boundary 内に留まり、GitHub／GitLab Issue Detection は利用可能な場合に設定済みの `gh` または `glab` CLI を使用します。選択された v2 Package が Load、Mount、または Ready Report に失敗した場合、その Process では Retained Legacy Git Renderer を明示して使用します。Security／Trust／Permission Denial は Fallback を Trigger しません。

特に Automatic または Parallel Run の後は、Commit 前に変更を確認してください。Agent-generated Change が Git Panel に表示されたというだけで、安全になるわけではありません。

## Editor と AI Terminal

Editor は Monaco を使用し、File Editing、Diagnostics、Plan Rendering、Diff、Conflict、AI-assisted Workflow を提供します。右側の AI パネルは実際の Coding Agent CLI Terminal（メインウィンドウと同じ Agent）を組み込み、起動時に Editor の Context を注入します。

これらの Tool は、より広い Engineering Environment における Intervention Surface です。Navide は最終的に、従来の IDE を主要環境として必要としない完全な Professional Workflow を提供することを目指します。

## Settings と Portability

Settings は Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance、Keyboard Shortcut を扱います。CLI Agents では Install 済みの Coding CLI も管理します。バージョン、Install 方法、重複 Install、その CLI 自身の最後の更新結果を表示し、その CLI 公式の更新コマンドと診断コマンドを Terminal で実行できます。Navide はベンダーのコマンドを提示して実行するだけで、CLI 自体を更新することはありません。Export された Settings は API Key と Token を Redact します。Third-party Server を有効化する前に、MCP Command と Environment Variable を確認してください。

`.agent-team/` は現在 Portability Mechanism ではありません。将来 Machine 間で移行する場合は Git Synchronization ではなく、Redaction と Retention Control を備えた明示的な Local Export/Import Flow を使用すべきです。
