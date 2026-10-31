# 紅果短劇 4.1

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

## 更新提醒視窗

- 正式版發行說明的「摘要：」條列現在完整顯示：不再只取前 4 條，單條上限由 24 字放寬到 72 字，視窗內可捲動；超過 20 條時顯示「另有 N 條未列出」。
- 解析也更寬鬆：支援 `-`、`*`、`•`、`1.`、`1、`、`（1）` 等項目符號、CRLF、`## 摘要` 標題、縮排子項、小標題；遇到「SHA256」「下載」「檔案」等小標題或普通段落就停止，連結與校驗碼行不會變成摘要。沒有「摘要」標題的內文仍不顯示。
- 相容舊版：已安裝的 3.4／4.0 仍只讀前 4 條並截到 24 字，所以 4.1 發行說明把最重要的 4 條短句放最前面。

## 與 AdGuard、防毒軟體並存

移除舊版、重裝後，AdGuard 可能把新程式當成未設定的應用程式，攔截或改簽 HTTPS。4.1 從三個層面降低影響（無法在本機重現各家軟體，以下是程式碼層面的防護）：

- 啟動時把作業系統憑證庫合併進主程序的信任清單（`src/native/system-trust.js`）。AdGuard 的 HTTPS 過濾憑證裝在系統庫，Node 預設不認，過去會當作網路錯誤。取不到系統庫時維持原狀。
- 匿名播放設備註冊失敗不再整個程序生命週期都記住。同一個 5 秒內仍共用同一次失敗（預取與連點不會連發請求），之後下一次播放會重新註冊；改網路或代理設定會立即清掉失敗紀錄。註冊失敗不會建立設備，成功的設備仍整個程序共用一個。
- 失敗原因（憑證不被信任、連線被攔截或中斷）會寫進錯誤訊息，提示把紅果短劇加入 AdGuard／防毒軟體例外，或暫時關閉 HTTPS 過濾。

## 發行邊界

4.1 為 **正式版**（`v4.1` / GitHub Latest）。`windows/4.1-release-*` 分支的 Windows CI 建置後，由 `publish-release` 工作建立發行：安裝版（NSIS）、`.blockmap`、`latest.yml`（應用內更新必需）與便攜 ZIP。安裝檔未簽章，SHA256 寫在發行說明。先前的預發布 `installer-4.1-traditional-pre` 不再更新。
