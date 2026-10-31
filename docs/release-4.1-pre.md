# 紅果短劇 4.1 預發布

## 播放

- 加密片源邊下邊播時是分片 MP4，瀏覽器無法跳轉，4.0 因此在按快進、快退（預設方向鍵 ±5 秒）或拖動進度條時從頭重播。4.1 保留 4.0 的快速起播：串流實際讀到的加密位元組同時寫入播放暫存（非下載目錄），下載完成後解成一般 MP4；第一次跳轉時換成這個檔案並落在目標秒數。準備期間原畫面照常播放，連按會合併成一次換檔。
- 本機檔、HLS、明文來源與已換檔的片源仍用瀏覽器原生跳轉。失敗、整集超過 300MB 或回應仍是串流時，只提示，不重播也不反覆重試。
- 離開本集或關閉播放會停止背景下載並清掉暫存。已存的續播位置在加密串流上也改走換檔，不再從 0 開始。
- 同一個 App 工作階段內，切換分集再切回會沿用各集剛才的播放秒數（不寫入 store 的每集永久紀錄）。

## 搜尋、熱播榜與下一季

- 海報：`src/native/cover-url.js` 統一處理封面網址。HEIC 變體（App 搜尋、新片補充）換成同一張圖的 `~tplv-shrink:640:0.image`；非紅果 CDN 的 HEIC 維持留空。官網搜尋依序挑第一個可用封面。合併官網與 App 結果時，缺封面的一筆用重複項補上。畫面端 `CoverImage` 載入失敗時先重試相容版本，再顯示佔位圖。
- 熱播榜：`catalog.js` 從來源的 `statusTags`（或渲染後的狀態標籤）讀出 `is_new`，`Browse` 卡片頂部列依序是排名、綠色「新劇」、評分；窄卡片自動縮小。
- 下一季：`season-title` 去掉劇名尾端標點並提供忽略標點的 `key`，查找與比對都用 `key`，因此「大學沒畢業，你怎麼登上福布斯了！」能對上「…福布斯了第二季」。播放器把末集查找包成可重試的流程：失敗不快取、播完時仍在查找就等待（最多 8 秒），確認沒有下一季才照常結束。

## 回歸驗證

- `scripts/check-seekable-capture.cjs`、`scripts/check-app-media.cjs`、`scripts/check-player-seek-swap.cjs`
- `scripts/check-player-resume.cjs`（含 session 跨集）、`scripts/check-player-controls.cjs`、`scripts/check-streaming.cjs`
- `scripts/check-seek-chromium.cjs`：真實 Chromium 與 FFmpeg（需要 Electron 與 ffmpeg，不納入 `npm test`）
- `scripts/check-rankings.cjs`、`scripts/check-cover-image.cjs`、`src/native/next-season.test.cjs`、`scripts/check-player-resume.cjs`（末集下一季）
- `npm test` 全平台檢查

## 發行邊界

4.1 為 **預發布**（`installer-4.1-traditional-pre` / GitHub Pre-release）。自動更新仍只認正式版，不會自動拉到 4.1 預發布。安裝檔未簽章，由 `windows/4.1-pre-*` 分支的 Windows CI 建置並上傳，發行頁只放安裝版（NSIS）與便攜 ZIP，SHA256 寫在發行說明；不上傳 `latest.yml`、`.blockmap` 與 `WINDOWS-SHA256SUMS.txt`，CI 每次發布都會刪掉這些舊附件。
