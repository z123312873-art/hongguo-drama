# 紅果短劇 4.1 預發布

## 播放

- 加密片源邊下邊播時是分片 MP4，瀏覽器無法跳轉，4.0 因此在按快進、快退（預設方向鍵 ±5 秒）或拖動進度條時從頭重播。4.1 保留 4.0 的快速起播：串流實際讀到的加密位元組同時寫入播放暫存（非下載目錄），下載完成後解成一般 MP4；第一次跳轉時換成這個檔案並落在目標秒數。準備期間原畫面照常播放，連按會合併成一次換檔。
- 本機檔、HLS、明文來源與已換檔的片源仍用瀏覽器原生跳轉。失敗、整集超過 300MB 或回應仍是串流時，只提示，不重播也不反覆重試。
- 離開本集或關閉播放會停止背景下載並清掉暫存。已存的續播位置在加密串流上也改走換檔，不再從 0 開始。
- 同一個 App 工作階段內，切換分集再切回會沿用各集剛才的播放秒數（不寫入 store 的每集永久紀錄）。

## 回歸驗證

- `scripts/check-seekable-capture.cjs`、`scripts/check-app-media.cjs`、`scripts/check-player-seek-swap.cjs`
- `scripts/check-player-resume.cjs`（含 session 跨集）、`scripts/check-player-controls.cjs`、`scripts/check-streaming.cjs`
- `scripts/check-seek-chromium.cjs`：真實 Chromium 與 FFmpeg（需要 Electron 與 ffmpeg，不納入 `npm test`）
- `npm test` 全平台檢查

## 發行邊界

4.1 為 **預發布**（`installer-4.1-traditional-pre` / GitHub Pre-release）。自動更新仍只認正式版，不會自動拉到 4.1 預發布。安裝檔未簽章，由 `windows/4.1-pre-*` 分支的 Windows CI 建置並上傳，SHA256 見發行頁 `WINDOWS-SHA256SUMS.txt`。
