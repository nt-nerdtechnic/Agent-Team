# 隱私與資料流

[English](../en-US/privacy.md) | 繁體中文 | [日本語](../ja-JP/privacy.md) | [文件中心](README.md)

Navide 採用 **Local-first**，但不代表所有情況都完全離線。Electron 應用程式、Python Backend、Terminal Session、私有專案智慧、Workspace 狀態與調度邏輯都在你的 Mac 上執行；當你啟用或使用外部服務時，資料可能離開裝置。

## Navide 保存在本機的資料

依照啟用功能，Navide 會儲存：

- `<workspace>/.agent-team/` 中的個人私有專案智慧與 Run Artifact
- 應用程式資料目錄中的 Role、Pipeline、Recent Workspace、UI Setting、Analyzer Setting 與 AI Provider Setting
- 從本機 CLI Log 衍生的 Token Attribution 與 Deduplication Metadata
- 選用的 AI Provider API Key；它會儲存在受限制檔案權限保護的本機設定檔中（受支援系統上為 `0600`）

Navide 不營運專案 Telemetry 服務，也不要求建立 Navide 帳號。

## 私有專案智慧

`.agent-team/` 屬於本機 Workspace 的個別使用者。它排除於 Git，也不是用來同步人類團隊狀態。內容可能包含私人 Prompt、Task Context、Session Identifier、Agent Output、Run Event、Handoff、Token Summary 與未來的 Coordination Metadata。

不要從 `.gitignore` 移除 `.agent-team/`，也不要將它作為刻意撰寫專案文件的替代品。如果必須分享 Artifact，請只檢查並 Export 必要的 Specification、Decision、Report、Patch 或 Evidence。

未來的可攜功能應使用具有 Redaction 與 Selection Control 的明確本機 Export／Import。Navide 絕不能無聲地把私有專案智慧轉換成雲端或 Repository 狀態。

## 可能對外通訊的功能

| 功能 | 可能接收者 | 涉及資料 |
|---|---|---|
| Coding Agent CLI | CLI 供應商或設定的模型 Provider | Prompt、選取的 Context、Tool Result 與供應商定義的 Telemetry |
| Cloud AI（Inline 編輯與 Code Review） | Anthropic、OpenAI、Google、Groq、DeepSeek、Mistral、xAI 或自訂 Endpoint | 選取的程式碼、Prompt 與 Model Parameter |
| Context7 Injection | Context7 及其 MCP Distribution／Runtime 相依套件 | 偵測到的 Library Name 與文件查詢 |
| Web Search | Search Provider | 搜尋查詢文字 |
| Git Operation | 設定的 Git Host | Repository 資料，以及由 Git 或 Host Flow 處理的憑證 |
| Update Check | GitHub Releases | 應用程式版本與一般網路 Metadata |
| Plugin Registry Trust Refresh | 所選的 Official Registry，或明確核准的 self-hosted Registry | 已安裝 marketplace plugin 的 namespace/name；Refresh 不會傳送 Plugin Source 或 Archive |
| MCP Server | 設定的 MCP Server 與它使用的服務 | 完全取決於該 Server 的 Tool 與設定 |

傳送私人程式碼或受規範資料前，請先閱讀各 Provider 政策。

只要仍有已安裝的 marketplace plugin，Navide 會在 App 啟動時及每 15
分鐘，將該 Plugin 的 namespace/name 傳送給所選的 Registry。這個 Request
用來取得已簽署的 Trust Metadata，讓 Navide 偵測遭撤銷的 Publisher 或
Package，並隔離已安裝的 Plugin。目的地由設定的 Registry URL 決定：使用
Official URL 時，會使用 App Pin 的 Official Registry；使用 self-hosted URL
時，則只使用使用者明確核准的 URL 與 Root。這個 Refresh 不會上傳 Plugin
Source、Package Archive 或 Workspace File。

Navide 會在 Plugin Installation 旁的本機資料中保留最新的已簽署 Trust
Snapshot，讓重新啟動後仍能進行檢查；Registry 自己的 Request Log 則由該
Registry 決定保存方式。目前沒有獨立的 Refresh 開關；移除已安裝的
marketplace plugin 後，這項資料流就會停止，其他外部服務資料流仍由各自的
設定控制。

## 憑證

Agent CLI 憑證保留在各 CLI 自己的設定中。如果在 Navide 輸入 Cloud AI Key，Navide 會把它保存在本機，供 AI 功能（Inline 編輯、Code Review）使用。設定 Export 會遮蔽 API Key 與 Token。

本機檔案權限可以降低同一部電腦其他使用者意外存取的機會，但無法防範 Malware、遭入侵的使用者帳號、無限制 Agent、Backup，或具有同等權限的 Process。

## Agent 權限

除非外部 CLI 提供並啟用自己的 Sandbox，Agent 會以目前使用者的作業系統權限執行。Navide 目前尚未提供完整 Workspace Sandbox。

YOLO Mode 可能略過 CLI Confirmation 或 Sandbox 保護。只應在可信任、已使用版本控制的 Workspace 中使用，並於執行後檢查 Command 與 Diff。

## Context Handoff

跨 Agent Handoff 可能包含 Task Context 與先前 Stage Output。自動 Secret Scrubbing 目前還不是完整安全邊界。不要把憑證放進 Prompt、Generated Plan、Log，或可能交給其他 Agent 的檔案。

## 移除本機資料

停止所有 Active Session 後，可以從 Workspace 的 `.agent-team/` 目錄移除私有專案智慧。刪除它可能會移除 Resumability、Run History、Attribution 與累積 Context，但不會刪除原始碼 Repository。整個應用程式的設定與歷史位於 Navide Application Data Directory。刪除前請備份需要保留的設定。

回報 Vulnerability 請依照英文版 [Security Policy](../../SECURITY.md) 私下進行。
