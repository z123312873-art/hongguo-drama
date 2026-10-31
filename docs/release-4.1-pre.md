# 紅果短劇 4.1 預發布

## 播放與進度

- 同一個 App 工作階段內，切換分集再切回會沿用各集剛才的播放秒數（不寫入 store 的每集永久紀錄）。
- 進度條與 ±5 秒快進／快退會依 **已緩衝／已落盤** 範圍限制；超出時提示稍候，避免整集從頭重播。
- 加密線上播放維持 4.0 的 pipe 起播；約 30 秒後在背景低優先寫入 **播放暫存**（非下載目錄），供後段拖動；未落盤區間會等待緩衝。
- 明文 CDN、本地檔、完整 online cache 與下載功能行為不變；下載仍走原佇列，完整 cache 仍可加速下載。

## 回歸驗證

- `scripts/check-player-resume.cjs`（含 session 跨集）
- `scripts/check-player-controls.cjs`（含 seek 上限）
- `scripts/check-online-spill.cjs`
- `scripts/check-streaming.cjs`
- `npm test` 全平台檢查

## 發行邊界

4.1 為 **預發布**（`installer-4.1-traditional-pre` / GitHub Pre-release）。自動更新仍只認正式版，不會自動拉到 4.1 預發布。

## 安裝包

| 類型 | 檔名 | 備註 |
|------|------|------|
| 便携 ZIP | `hongguo-4.1-win-x64-portable.zip` | 已上傳 Pre-release（與 NSIS 同版 4.1.0） |
| NSIS 安裝檔 | `hongguo-downloader-4.1-win-x64-setup.exe` | 已由 `windows/4.1-pre-*` 分支觸發 CI 建置並上傳；SHA256 見 `WINDOWS-SHA256SUMS.txt` |

安裝檔未簽章。便携包由 `npm run build:dir` 產出 `dist/win-unpacked` 後 zip 打包。
