# 疑難排解

[English](../en-US/troubleshooting.md) | 繁體中文 | [日本語](../ja-JP/troubleshooting.md) | [文件中心](README.md)

## 應用程式無法啟動

1. 確認 Node.js 22.12+（22.x）、pnpm 10+、Python 3.12+ 與 uv 0.11+。
2. 重新安裝 Lockfile 指定的相依套件：

   ```bash
   pnpm install --frozen-lockfile
   uv --project backend sync --locked
   ```

3. 在 Terminal 中以 `pnpm dev` 啟動，檢查第一個 Backend 或 Electron Error。
4. 執行 `pnpm typecheck`，區分環境問題與原始碼錯誤。

## Backend Health 持續顯示不可用

- 確認沒有其他 Process 阻擋本機 Loopback 通訊。
- 檢查 macOS Security Software 是否拒絕封裝後的 Python Backend。
- 開發模式下，單獨執行 `uv --project backend run python -m agent_team_backend` 以顯示 Startup Error。

## 找不到 Agent CLI

- 在一般 Interactive Terminal 中執行該 CLI 的 Version Command。
- 安裝後重新啟動 Navide，使它取得更新後的 `PATH`。
- 在 Navide 啟動 CLI 前，先完成該 CLI 自己的 Authentication Flow。
- 確認 Executable Name：`claude`、`codex`、`agy` 或 `grok`。

## CLI 回報自己的 Auto-update 失敗

Pane 內可能出現 CLI 自己的訊息，例如 `✘ Auto-update failed`。同一個 CLI 的安裝目錄由所有 Pane 與 Profile 共用，多個 Pane 同時更新時可能互相衝突。

- 開啟 Settings → CLI Agents。失敗的更新會列在該 CLI 的那一列，含時間、版本與記錄該結果的 Config Home。
- 使用該列的更新動作。它會在終端機執行 CLI 自己的更新指令（`claude update`、`codex update`、`agy update`、`grok update`）；Navide 不會自行更新 CLI。沒有更新子指令的 CLI 則改為連結到官方文件。
- 若衝突反覆發生，可把該 CLI 的 Auto-update 設為手動。Navide 會在每次 Spawn 帶入該 CLI 官方提供的關閉變數，改由這個面板更新。
- 執行中的 Session 會沿用啟動時的 Binary；更新後請重新啟動該 Pane。

## Pane 一直停在「detecting session」

Codex、Antigravity 與 Grok 依賴 Log 或 Database Discovery，將新的 CLI Session 綁定到 Navide Pane。

- 傳送一般訊息，讓 CLI 保存 Pane Marker。
- 確認 CLI 能寫入其正常 Session Directory。
- 第一次 Session 被偵測前，不要立即 Rebuild 或 Resume。
- 如果偵測始終沒有完成，在建立 Issue 前保留 Pane Output 與相關 Backend Log。

## Resume 無法運作

- 確認該 Pane 先前曾到達 Detected Session 狀態。
- 確認原始 CLI 的 History 中仍有該 Session。
- 檢查 Workspace Path 是否改變。
- CLI Upgrade 可能改變 Resume Syntax 或 Session Storage；Bug Report 應包含 CLI 與 Navide Version。

## Token Stats 空白或重複

- Token Tracking 依賴 Provider Log Format，只有 CLI 寫入相容 Record 後才能看見 Usage。
- 確認 Navide 已將 CLI Session 與目前 Workspace、Pane 建立關聯。
- 帳務請與 Provider Dashboard 比較；Navide 顯示的是 Operational Telemetry。
- 如果重複問題持續存在，請回報 CLI Version、可安全分享的 Session ID，以及經過遮蔽的範例 Record。

## Local Analyzer 無法使用

- 使用 Ollama 時，確認 Service 正在執行，而且設定的 Model 已存在。
- 使用 GGUF Model 時，確認 File Path、Architecture Support 與可用 Memory。
- Analyzer Failure 應只降低選用 Automation 能力，不應阻止一般手動 Terminal 使用。

## macOS 權限阻擋工作流

開啟 **System Settings → Privacy & Security**，檢查 Automation、Files and Folders、Accessibility 與 Full Disk Access。只授予特定 CLI 與 Workspace 實際需要的權限。修改權限後重新啟動受影響的應用程式。

## Terminal Pane 的複製貼上行為異常

- CLI 啟用 Mouse Reporting 時，一般拖曳會被轉送給程式本身，劃不出任何選取。請按住 **Option**（macOS）或 **Shift**（Windows/Linux）再拖曳，強制進行文字選取。
- **Edit → Copy**、Pane 右鍵的 **Copy** 與 **⌘C / Ctrl+C** 都會複製終端機選取。終端機的選取對作業系統不可見，因此背景執行的第三方輔助使用或剪貼簿工具（Typeless 這類會攔截 Edit 選單或 Pasteboard 的工具）可能吃掉複製動作。若複製沒有任何反應，請關閉該工具（或在 **System Settings → Privacy & Security → Accessibility** 中排除 Navide）後再試。
- 在 CLI 面板要插入換行而不送出，可按 **Shift+Enter**、**Ctrl+Enter** 或 **⌘Enter**。一般 shell 面板只有 Shift+Enter 有此作用 —— Ctrl+Enter 維持送出，因為那是 shell 原本的行為。單純的 Enter 一律送出。

## Context7 或 Documentation Injection 失敗

Documentation Injection 採用 Best-effort。檢查 MCP Configuration、Package Runtime 與 Network Access。Fetch 失敗不應阻擋手動任務；如果 Workspace 必須保持離線，請停用整合。

## Git Authentication Prompt 無法完成

- 使用 `git remote -v` 確認 Remote。
- 在一般 Terminal 測試相同 Fetch 或 Push。
- 優先使用現有 SSH Agent 或 Credential Manager 設定。
- 絕對不要將 Access Token 貼到 Issue Report 或 Terminal Screenshot。

## 提交有用的 Bug

請包含：

- Navide Commit 或 Version
- macOS Version 與 Architecture
- Agent CLI 名稱與 Version
- Reproduction Steps
- Expected Behavior 與 Actual Behavior
- 經過遮蔽的 Log 或 Screenshot

使用 Repository 的 [Bug Report Template](https://github.com/nt-nerdtechnic/Navide/issues/new?template=bug_report.yml)。Vulnerability 請依照英文版 [Security Policy](../../SECURITY.md) 私下回報。
