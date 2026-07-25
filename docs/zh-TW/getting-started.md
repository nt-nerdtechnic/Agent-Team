# 開始使用

[English](../en-US/getting-started.md) | 繁體中文 | [日本語](../ja-JP/getting-started.md) | [文件中心](README.md)

Navide 支援配備 Apple 晶片且執行 macOS 13 以上版本的 Mac。[v0.1.47 GitHub Prerelease](https://github.com/nt-nerdtechnic/Navide/releases/tag/v0.1.47) 提供未簽章的 DMG 與 ZIP 下載；這些檔案尚未經 Apple 簽章或 Notarization。

若要安裝 Preview，請下載 DMG、將 Navide 複製到「應用程式」，然後在 Finder 中按住 Control 點擊 App 並選擇「打開」。若 macOS 仍阻擋執行，請前往「系統設定 → 隱私權與安全性」，針對 Navide 選擇「強制打開」。請勿停用整個系統的 Gatekeeper。

## 從原始碼安裝的前置需求

- macOS 13+
- Node.js 22+
- pnpm 10+
- Python 3.12+
- uv 0.11+
- 至少一個受支援的 Coding CLI：
  - Claude Code（`claude`）
  - Codex（`codex`）
  - Antigravity CLI（`agy`）
  - Grok CLI（`grok`）
- 選用：用於本機分析的 Ollama 或本機 GGUF 模型

每個 Coding CLI 都有自己的安裝、驗證、訂閱與資料政策。Navide 不會取代這些需求。

## 從原始碼安裝

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

`pnpm dev` 會同時啟動 Electron 應用程式、Vite Renderer 與 Python FastAPI Backend。

## 首次啟動

Onboarding Wizard 會檢查必要 Runtime，並偵測可用的 Agent CLI。依序完成：

1. 解決任何阻擋啟動的基礎相依套件。
2. 確認至少一個 Coding CLI 已可使用並完成驗證。
3. 如果需要 Intent Detection 與自動回答，設定 Local Analyzer。
4. 只授予實際工作流需要的 macOS 權限。
5. 開啟一個可信任的專案資料夾作為 Workspace。

Navide 可能依照 Agent 與 Terminal 存取 Workspace 的方式，要求 Automation、Files and Folders 或 Full Disk Access。授予權限前，請先閱讀 macOS 顯示的原因。

完成 Onboarding 後，Settings → CLI Agents 會列出每個偵測到的 CLI，包含版本、安裝方式與上次更新結果，並可執行該 CLI 自己的更新與診斷指令。

## 執行第一個任務

最小成功測試：

1. 開啟可丟棄或已使用版本控制的 Workspace。
2. 手動啟動一個 Agent。
3. 提供唯讀任務，例如「總結這個 Repository」。
4. 確認 Terminal Output、Session Detection 與 History 都有更新。
5. 如果 CLI 提供相容 Usage Log，檢查 Token Stats。

手動流程確認正常後，再用小型任務測試 Pipeline。理解各 Stage 定義與影響之前，請停用 YOLO 或 Full Auto。

## 開發檢查

```bash
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests
```

如果應用程式、Backend、CLI、Session Binding、Analyzer 或 Token Tracking 未正常啟動，請參考[疑難排解](troubleshooting.md)。
