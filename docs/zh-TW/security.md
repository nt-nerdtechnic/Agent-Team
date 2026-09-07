# 安全政策

本頁是根目錄 [SECURITY.md](../../SECURITY.md) 的摘要翻譯；以英文版為準。

## 支援版本

Navide 目前在 1.0 之前。安全修復針對 `main` 的最新程式碼與最新發布版；較舊的快照不保證修復。

## 回報弱點

請勿為疑似弱點開公開的 GitHub Issue。請寄信到 **nt.nerdtechnic@gmail.com**，主旨：

```text
[Navide] Security Vulnerability
```

附上描述、重現步驟、可能影響、受影響版本或 commit，若有建議修法也請附上。報告中請移除憑證、私有原始碼與無關的個人資料。

專案目標是 48 小時內回覆收到、7 天內給出狀態更新。這是回應目標，不保證在期限內解決。

## 範圍與善意研究

包含：本 repository、Navide 桌面應用、`server.navide.dev` 的 Navide Cloud 中繼。不包含：Navide 啟動的外部 CLI（請向上游回報）、需要實體接觸已解鎖機器的情境、刻意關閉 `contextIsolation`／`sandbox`／簽章才成立的發現。

在範圍內、不侵犯隱私、不影響服務、給予合理修復時間再揭露的善意研究，不會被追究法律責任。請不要對正式中繼上他人的帳號或裝置做測試；伺服器可在本機執行。

## 安全模型

Electron 應用、Python 後端、PTY、協調狀態與工作區資料都在使用者機器上執行；後端只監聽 loopback。每次安全審查對照的攻擊者位置與對應控制，寫在 [Security threat model](../en-US/security-threat-model.md)。憑證、代理權限、Git 白名單邊界、交接與日誌、外部整合與已知限制，請見英文版。
