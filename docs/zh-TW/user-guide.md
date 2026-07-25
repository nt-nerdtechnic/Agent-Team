# 使用指南

[English](../en-US/user-guide.md) | 繁體中文 | [日本語](../ja-JP/user-guide.md) | [文件中心](README.md)

## 產品模型

Navide 為一位工程師指揮多個 AI Agent 而設計。主要互動不一定是編輯檔案，而是設定成果、協調 Session、觀察進度、處理重要例外，並接受經過驗證的結果。

日常工作透過三種循環推進：

1. **Genesis** 使用 Pipeline，將想法轉化為第一個可運作 Prototype。
2. **Evolution** 透過一個或多個 Agent Session，反覆開發、測試、修正並微調現有專案。
3. **Intervention** 讓工程師透過 Diff、Editor、Terminal、Diagnostics、Git 與 Review Tool 檢查或直接修改成果。

目前 Pipeline 實作 Genesis 循環；Manual Pane 與 Maintenance Mode 提供早期 Evolution 工作流；Editor 與 Review 介面提供 Intervention。

## Runtime 心智模型

Navide 有三個工作層級：

1. **Workspace** 是專案資料夾，也是 Project State、Run History 與 Git Operation 的邊界。
2. **Pane** 是執行 Agent CLI 或一般 Shell 的 Live Terminal Session。
3. **Pipeline** 是一組依序執行的可設定 Stage。每個 Stage 包含一個或多個平行 slot，每個 slot 選擇 Agent 與 Role。

## Workspace

Welcome Screen 會列出 Recent Workspace、支援 Pin，並標示遺失的 Folder。開啟 Workspace 時會恢復其 UI State 與符合條件的 Session。切換或關閉 Workspace 前，請先完成或中止不能被中斷的 Active Work。

Navide 將個人私有 Project Intelligence 儲存在 Workspace 內的 `.agent-team/`。這個目錄排除於 Git，不應視為團隊共用狀態。它可能包含屬於個人工程流程的 Task Context、Session Metadata、Run History、Handoff 與 Token Information。

原始碼與明確分享的文件仍然是 Repository 裡團隊可見的事實。如果需要分享 `.agent-team/` 中的資訊，應將它轉換為刻意建立的 Artifact，例如 Specification、Architecture Decision、Test Report、Issue、Commit 或 Pull Request。

## Manual Agent Pane

探索、維護或不需要完整 Genesis Pipeline 的 Evolution Task，可以使用 Manual Spawn。

- 選擇 Agent 與 Role。
- Spawn 前檢查 Launch Command。
- 不需要 Agent 時使用一般 Terminal Pane。
- 將 Pane 最小化可以保留 PTY，同時避免占用主要 Layout。
- 只有 Navide 偵測到可重用 Session ID 後，才進行 Rebuild 或 Resume。

受支援的內建 Agent Key 包含 Claude Code、Codex、Antigravity CLI 與 Grok CLI。實際 CLI 行為與 Provider Billing 仍由各外部工具控制。

## Pipeline

內建 Pipeline 涵蓋 Requirements、Planning、Design、Implementation、Security Review 與 Testing。Stage、slot、Role、Kickoff Prompt、Question 與 Completion Sentinel 都能在 Settings 中設定。

一個 Stage 可以平行執行多個 slot。Navide 會根據設定的 Completion Signal 與 Agent State 推進。務必檢查生成變更與測試結果；自動完成只代表工作流進度，不代表成果正確。

## Manager 與 Worker 協調

其中一個 slot 可以擔任 Global Manager。Manager 會接收跨 Stage Context、將工作分派給 Worker、處理 Worker Question，並透過 Navide Routing Protocol 發出 Stage Completion Signal。

需要拆解或平行 Ownership 的任務適合使用 Manager。小型任務通常使用 Single-agent Stage，成本較低也較容易檢查。

## Automation Mode

- **YOLO** 會在受支援時傳入略過 Approval 或 Trust Prompt 的 CLI-specific Flag。某些 CLI 可能原本就不會要求 Tool Confirmation。
- **Full Auto** 允許 Analyzer 根據可用 Task Context 自動回答 Agent Question。
- **Strict** 在特定 Timeout 或 Progression Boundary 要求確認。
- **Continuous** 根據設定的 Automation Behavior 持續推進 Pipeline。
- **Local Analyzer** 啟用本機 Intent Classification 與相關 Automation。

請從保守設定開始。YOLO 與 Full Auto 可能讓 Agent 在沒有再次取得使用者確認的情況下修改檔案或執行 Command。

## 例外管理

Navide 的長期運作哲學，是讓 Agent 在可逆、可觀察的工作中持續執行，只有人類判斷真正有價值時才將注意力交還給工程師。目前 Automation Mode 是早期控制方式，不是完整 Policy Engine。

以下情況應該介入：

- 需求存在多種實質不同但都合理的解釋
- 架構或產品選擇具有長期影響
- Session 在 Ownership、File 或技術方向上衝突
- Test 與明確 Acceptance Criteria 不一致
- 涉及 Credential、Payment、Deployment、Publication、Destructive Operation 或 External System
- 成果需要主觀產品或品質判斷

例行探索、可逆修改、本機測試、診斷與修正，未來應該能在沒有 Approval Noise 的情況下繼續，同時保持可見與可中斷。

## History 與 Token Tracking

History 是 Pipeline、Stage、Pane、Question、Analyzer、Handoff 與 Warning Event 的 Append-only Timeline。Run History 儲存在 `.agent-team/runs/`，並可篩選或 Export。

Token Stats 解析相容的本機 CLI Log，將 Usage 歸屬到 Workspace、Pane、Stage 與 Run。它是 Observability Feature，不是 Provider Invoice；Provider 端 Usage 與 Billing 才是最終依據。

## Git 與 Review

Git View 支援 Repository Discovery、Working Tree Inspection、Staging、Commit、Branch、Remote、Issue 與相關工作流。Multi-repository Workspace 可以在偵測到的 Repository 間切換。

Commit 前務必審查變更，特別是在 Automation 或 Parallel Run 之後。Agent 生成的變更不會因為顯示在 Git Panel 中就自動變得安全。

## Editor 與 AI Chat

Editor 使用 Monaco，並提供 File Editing、Diagnostics、Plan Rendering、Diff、Conflict 與 AI-assisted Workflow。AI Chat 可以使用本機模型或設定的 Cloud Provider。Provider-specific API Key 與 Model Setting 為選用項目，輸入後會儲存在本機。

這些工具是更大工程環境的 Intervention 介面。Navide 的目標，是最終提供完整專業工作流，而不必使用傳統 IDE 作為主要環境。

## Settings 與可攜性

Settings 涵蓋 Role、Pipeline、MCP Server、Analyzer Behavior、AI Provider、Appearance 與 Keyboard Shortcut。CLI Agents 另外管理已安裝的 Coding CLI：版本、安裝方式、重複安裝、該 CLI 上次自我更新的結果，以及在終端機執行該 CLI 官方更新與診斷指令的按鈕。Navide 只呈現並執行官方指令，不會自行更新 CLI。Exported Setting 會遮蔽 API Key 與 Token。啟用第三方 Server 前，請先檢查 MCP Command 與 Environment Variable。

`.agent-team/` 目前不是可攜機制。未來在不同裝置間移轉時，應使用具有 Redaction 與 Retention Control 的明確本機 Export／Import，而不是透過 Git 同步。
