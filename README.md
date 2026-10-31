<p align="center">
  <img src="build/icon.png" alt="紅果短劇桌面版圖示" width="112" height="112">
</p>

<h1 align="center">紅果短劇 · 繁體桌面版</h1>

<p align="center">在電腦上找劇、接著看、下載與合併。介面預設繁體，Windows 安裝檔由這個倉庫自己發行。</p>

<p align="center">
  <img alt="目前正式版 4.0" src="https://img.shields.io/badge/正式版-4.0-8b3a3a?style=flat-square">
  <img alt="4.1 預發布" src="https://img.shields.io/badge/預發布-4.1-6b5b95?style=flat-square">
  <img alt="說明與介面使用繁體中文" src="https://img.shields.io/badge/文案-繁體中文-555555?style=flat-square">
  <img alt="Windows x64 安裝版" src="https://img.shields.io/badge/Windows-x64-55746b?style=flat-square">
  <a href="LICENSE"><img alt="GPL-3.0 授權" src="https://img.shields.io/badge/license-GPL--3.0-555555?style=flat-square"></a>
</p>

<p align="center">
  <a href="#下載與安裝"><strong>下載與安裝</strong></a> ·
  <a href="#這個版本">這個版本</a> ·
  <a href="#開始使用">開始使用</a> ·
  <a href="#常見問題">常見問題</a>
</p>

這是社群維護的開源修改版，**不是紅果、西飯或河馬的官方用戶端**。不提供付費分集解鎖。劇集、清晰度與可播放範圍取決於來源平臺。

## 下載與安裝

只發行 **Windows x64** 安裝檔。媒體工具已內建，不必另外安裝 Node.js 或 FFmpeg。

**[下載 4.0 正式版（Windows x64）](https://github.com/z123312873-art/hongguo-drama/releases/download/v4.0/hongguo-downloader-4.0-win-x64-setup.exe)**

**[下載 4.1 預發布（Windows x64，NSIS 安裝精靈）](https://github.com/z123312873-art/hongguo-drama/releases/download/installer-4.1-traditional-pre/hongguo-downloader-4.1-win-x64-setup.exe)** — [發行頁](https://github.com/z123312873-art/hongguo-drama/releases/tag/installer-4.1-traditional-pre) 為 Pre-release，SHA256 見該頁 `WINDOWS-SHA256SUMS.txt`。

也可使用 [4.1 便攜版 ZIP（解壓即用）](https://github.com/z123312873-art/hongguo-drama/releases/download/installer-4.1-traditional-pre/hongguo-downloader-4.1-win-x64.zip)。

- 依精靈安裝。預設目錄是 `C:\hongguo`，安裝時可以改。
- 安裝檔未簽章。請從 [4.0 正式版](https://github.com/z123312873-art/hongguo-drama/releases/tag/v4.0) 或 [4.1 預發布](https://github.com/z123312873-art/hongguo-drama/releases/tag/installer-4.1-traditional-pre) 下載，並對照該頁的 SHA256。
- 一般使用只需要這個安裝檔。`latest.yml` 與 `.blockmap` 給更新程式用。
- 先退出正在執行的舊程式再安裝。設定、觀看紀錄與已下載的影片會留在原來的資料目錄。
- 已安裝的 3.4 會看到更新摘要。已安裝的 2.9 只會看到有新版本。下載與安裝都要自己確認。[2.9 安裝檔](https://github.com/z123312873-art/hongguo-drama/releases/tag/installer-2.9-traditional)仍留在原發行頁。


自動更新只檢查本倉庫的正式版，不檢查預發布，也不檢查原作者倉庫。

## 這個版本

4.1 預發布重點：加密片源按快進、快退（預設方向鍵，每次 5 秒）或拖動進度條不再從頭重播；同次開啟 App 內切集會記住各集進度。詳見 [4.1 預發布說明](docs/release-4.1-pre.md)。

4.0 正式版。更新說明：

- 官網搜尋失敗時，從上新名單找回當天的劇。
- 線上播放遇到空片源會再試，並繼續播放。
- 直連更穩，走不通時會提示改開代理。
- 加密片源邊準備邊播放，快速換集不再報錯，載入也更快。
- 海報只顯示劇集自己的評分，短時間重開不用重抓。
- 沒有新一季時，觀看記錄不再把續作檢查顯示成失敗。

搜尋聯想只在輸入時展開，點到別處、開始搜尋或按 Esc 會收起。點開一部劇會先清掉上一筆分集。某一季的最後一集開始播放時，背景查找緊接的下一季；這集播完後倒數 5 秒，再從下一季第 1 集播放。括號裡的「（第一季）」也算一季。

海報右上角是公開評分，右下角愛心與分集標題旁的「加入收藏清單」都記入收藏清單，日期是按下的當天。發現頁頂部依綜合熱播榜輪播。打開時視窗預設最大化。

### 4.1 預發佈

- 加密片源邊下邊播時，瀏覽器無法跳轉。按快進、快退（預設方向鍵，每次 5 秒）或拖動進度條，會換成已保存的完整檔案並接在目標位置，不再回到開頭。
- 開始播放與切集的速度不變：換檔只在第一次跳轉時發生，背景下載與解密沿用同一份下載，不多下載一次。
- 準備期間原畫面照常播放；失敗或本集過大時會提示，並維持原播放，不重播。

## 開始使用

1. 打開「設定」，確認下載目錄後儲存。
2. 在「發現短劇」瀏覽，或在「搜尋與下載」輸入劇名、分享連結或劇集編號。
3. 按「立即播放」在線看。要存檔時，再勾選集數與清晰度。
4. 之後從「我的劇庫」或「觀看紀錄」接著看。下載進度在「下載管理」。

右上角可在繁體與簡體之間切換。轉換只改畫面上的文字；搜尋框、檔名與下載目錄保持原樣。送給紅果搜尋時，繁體關鍵字會另外轉成簡體再查。

## 播放快捷鍵

| 按鍵 | 動作 |
|---|---|
| `空白鍵` | 播放／暫停 |
| `←`／`→` | 後退／前進 5 秒 |
| `↑`／`↓` | 上一集／下一集 |
| `A` | 開啟／關閉連播 |
| `S`／`D` | 降低／提高 0.25 倍速 |
| `F` | 切換全螢幕 |
| `Esc` | 退出豎屏填滿視窗，或關閉目前的選單 |

預設按鍵可在「設定」修改。輸入框、選單與對話方塊不會誤觸播放快捷鍵。

## 常見問題

### 為什麼有些分集鎖定，或清晰度不一樣？

片源由來源服務決定。鎖定集保持鎖定，這個程式不提供解鎖。在線播放看實際畫面；紅果下載在所選 1080P 或 720P 失敗時，才會嘗試更低清晰度。不保證每一集都有 1080P。

### 影片與設定放在哪裡？

影片在設定裡的下載目錄。設定、任務與觀看紀錄在 Windows 上預設位於 `%APPDATA%\hongguo-downloader\`。從劇庫移除、刪除任務、刪除影片與清理快取是不同操作。

### 怎樣更新？

安裝版預設檢查本倉庫的正式版。出現新版本時，先由你決定是否下載，下載完成後再決定是否安裝。預發布不會提示。

### 裝了新版，為什麼還是舊版本？

先退出所有正在執行的紅果短劇，再執行新的安裝檔，並從安裝程式建立的捷徑啟動。設定頁顯示的版本號才是目前執行的版本。

## 從原始碼建置

需要 Node.js 22.12 或更新版本。

```sh
git clone https://github.com/z123312873-art/hongguo-drama.git
cd hongguo-drama
npm ci
npm test
npm run dev
```

Windows 安裝檔：`npm run build:installer`。步驟見 [發行說明](docs/RELEASING.md)。自行建置不會自動簽章。

## 授權

本專案延續 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的 [GPL-3.0](LICENSE)。元件授權見 [第三方聲明](THIRD-PARTY-NOTICES.md)。

更早的基礎包括 [327044572/hongguo-downloader](https://github.com/327044572/hongguo-downloader)、[zhenyong97/hongguo-downloader](https://github.com/zhenyong97/hongguo-downloader) 與 [dawei233/hongguo-drama](https://github.com/dawei233/hongguo-drama)。片源演算法來源見 [演算法來源聲明](src/native/licenses/NOTICE.txt)。

開源授權只適用於這個軟體，不包含劇集內容。安裝檔裡沒有劇集影片。
