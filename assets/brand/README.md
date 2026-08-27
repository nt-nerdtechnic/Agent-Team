# Navide Logo Kit

概念:水晶摺面 N — 一條摺疊的緞帶構成 N,青色(左)流向紫色(右),摺面代表 SDLC 階段間的自動交接(Automated Handoff)。正式版 = 1254px 高解析原圖(`import/source-hires.png`),全部素材由此輸出。

原圖是白底渲染稿。輸出時已去背,並**移除渲染附帶的投影**:圖標一律乾淨去背、無陰影,要陰影請在使用端自行加。

## 檔案

### 根目錄
- `navide-mark-exact.svg` — 主圖標的 SVG 包裝(內嵌 1024px PNG,無限放大會糊)
- `navide-appicon.svg` — macOS App icon(向量深色圓角底 + 內嵌圖標)

### png/(透明底)
- `navide-mark-1024/512/256.png` — 主圖標
- `navide-appicon-1024/512/256.png` — App icon(深色 #0d1117 圓角底)
- `favicon-64/32.png` — favicon
- `navide-mark-on-white-512.png` — 白底版
- `navide-lockup-full.png` — 圖標 + Navide 字標,直式鎖定組合(1254px)

### light/(淺色背景用)
- `navide-mark-white-1024/512.png` — 白底圖標
- `navide-appicon-light-1024.png` — 白底圓角 App icon
- `navide-lockup-light-2x.png` — 白底直式鎖定組合

### social/
- `github-social-1280x640.png` — GitHub Social preview / og:image / README 頂圖
- `youtube-avatar-800x800.png` — YouTube 頻道頭像(圓形裁切安全)
- `youtube-banner-2560x1440.png` — YouTube 橫幅(內容置於 1546×423 中央安全區)

深色底素材(social/、appicon)的字標用白色,`i` 上的圓點維持品牌青色。

### import/
- `source-plate.png` — 原始白底渲染稿(1254px),重建時的唯一輸入
- `source-hires.png` — 上者的去背版(含字標,備用)

### tools/
- `cutout.py` — 去背:飽和度定圖標輪廓、白度 matte 處理字標、移除投影
- `build_kit.py` — 由去背結果輸出上列全部素材。改圖後重跑即可全套重建

## 未提供
下列三個向量檔需要重新繪製幾何,不是轉檔能得到的,本次未產出:
- `navide-mark.svg`(向量描摹版)— 原圖是多面漸層 + 反光,自動描摹會糊掉或爆出數百條路徑
- `navide-mark-flat.svg`(純色扁平版,供 16–32px 與貼紙)
- `navide-mark-mono.svg`(單色版,繼承 currentColor,供終端與印刷)

小尺寸目前請用 `png/favicon-32.png`。

## 上架位置
- GitHub:Settings → Social preview 上傳 `social/github-social-1280x640.png`;org 頭像用 appicon
- navide.dev:favicon 用 `png/favicon-32.png`,og:image 用 github-social,頁首用 `navide-mark-exact.svg`
- YouTube:`social/` 內對應檔直接上傳

## 使用規則
- 最小尺寸 16px;周圍留白至少為圖標寬的 20%
- 不要旋轉、描邊、加陰影或改變摺面順序

MIT © Navide Team
