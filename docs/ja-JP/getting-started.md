# はじめに

[English](../en-US/getting-started.md) | [繁體中文](../zh-TW/getting-started.md) | 日本語 | [ドキュメント](README.md)

Navide は Apple silicon 上の macOS 13 以降をサポートします。[v0.1.47 GitHub Prerelease](https://github.com/nt-nerdtechnic/Navide/releases/tag/v0.1.47) では、未署名の DMG と ZIP を提供しています。Apple による署名も Notarization も行われていません。

Preview をインストールするには、DMG をダウンロードして Navide を Applications にコピーし、Finder でアプリを Control-click して**開く**を選択します。それでも macOS にブロックされる場合は、Navide に対して**システム設定 → プライバシーとセキュリティ → このまま開く**を使用してください。Gatekeeper をシステム全体で無効化しないでください。

## Source からインストールするために必要なもの

- macOS 13+
- Node.js 22.12+（22.x）
- pnpm 10+
- Python 3.12+
- uv 0.11+
- 対応する Coding CLI が一つ以上：
  - Claude Code (`claude`)
  - Codex (`codex`)
  - Antigravity CLI (`agy`)
  - Grok CLI (`grok`)
- 任意：Local Analysis 用の Ollama または Local GGUF Model

各 Coding CLI には、それぞれ独自の Installation、Authentication、Subscription、Data Policy があります。Navide はそれらの要件を置き換えません。

## Source からインストール

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

`pnpm dev` は Electron Application、Vite Renderer、Python FastAPI Backend をまとめて起動します。

## 初回起動

Onboarding Wizard が必要な Runtime を確認し、利用可能な Agent CLI を検出します。次の手順を完了してください。

1. Block されている基盤 Dependency を解決します。
2. 対応する Coding CLI が一つ以上利用可能で、Authentication 済みであることを確認します。
3. Intent Detection と Automatic Answer を使う場合は Local Analyzer を設定します。
4. 使用する Workflow に必要な macOS 権限だけを付与します。
5. 信頼できる Project Folder を Workspace として開きます。

Agent と Terminal が Workspace を操作する方法によって、Navide は Automation、Files and Folders、Full Disk Access を要求する場合があります。権限を付与する前に、macOS が表示する理由を確認してください。

Onboarding 後は Settings → CLI Agents に、検出された各 CLI のバージョン・Install 方法・最後の更新結果が一覧表示され、その CLI 自身の更新コマンドと診断コマンドを実行できます。

## 最初の Task を実行する

最小構成で動作を確認するには：

1. 破棄可能、または Version Control された Workspace を開きます。
2. Agent を一つ手動で Spawn します。
3. 「この Repository を要約する」など、Read-only の Task を与えます。
4. Terminal Output、Session Detection、History が更新されることを確認します。
5. CLI が対応する Usage Log を提供する場合は Token Stats を確認します。

Manual Flow が動作したら、小さな Task で Pipeline を試してください。Stage Definition を確認し、影響を理解するまでは YOLO または Full Auto を無効にしてください。

## 開発チェック

```bash
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests
```

Application、Backend、CLI、Session Binding、Analyzer、Token Tracking が期待どおり起動しない場合は、[トラブルシューティング](troubleshooting.md)を参照してください。
