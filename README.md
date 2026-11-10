<p align="center">
  <img src="build/icon.png" alt="紅果短劇桌面版圖示" width="112" height="112">
</p>

<h1 align="center">紅果短劇 · 繁體桌面版</h1>

<p align="center">在電腦上找劇、接著看、下載與合併。介面預設繁體，Windows 安裝檔由這個倉庫自己發行。</p>

<p align="center">
  <img alt="目前正式版 4.5" src="https://img.shields.io/badge/正式版-4.5-8b3a3a?style=flat-square">
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

**[下載 4.5 正式版（Windows x64）](https://github.com/z123312873-art/hongguo-drama/releases/download/v4.5/hongguo-downloader-4.5-win-x64-setup.exe)** — [發行頁](https://github.com/z123312873-art/hongguo-drama/releases/tag/v4.5) 附 SHA256 與大小。

也可使用 [4.5 便攜版 ZIP（解壓即用）](https://github.com/z123312873-art/hongguo-drama/releases/download/v4.5/hongguo-downloader-4.5-win-x64.zip)。

- 依畫面安裝。預設目錄是 `C:\hongguo`，安裝時可以改。
- 安裝檔未簽章。請從 [4.5 正式版](https://github.com/z123312873-art/hongguo-drama/releases/tag/v4.5) 下載，並對照該頁的 SHA256。
- 先退出正在執行的舊程式再安裝。設定、觀看紀錄與已下載的影片會留在原來的資料目錄。
- 桌面與開始功能表的捷徑名稱是「紅果短劇」。
- 已安裝的 4.3 會在程式裡看到更新摘要。下載與安裝都要自己確認。

自動更新只檢查本倉庫的正式版，不檢查預發布，也不檢查原作者倉庫。

## 這個版本

上面的下載仍是已發布的 4.5 正式版。這一輪是 4.6 預發佈，詳見 [4.6 更新說明](docs/release-4.6.md)。預發佈安裝檔在 [installer-4.6-traditional-pre](https://github.com/z123312873-art/hongguo-drama/releases/tag/installer-4.6-traditional-pre)，已安裝的 4.5 不會被導去這一版。已發布說明留在 [4.5 更新說明](docs/release-4.5.md)。

4.6 預發佈：

- 新增「紅果立即登入」登入成功後，顯示頭像與暱稱
- 登入時發驗證碼，登入後同步觀看記錄與收藏
- 未上線短劇播放提示2秒後自動關閉
- 頁碼可從目前頁直接點後面五頁

## 開始使用

1. 打開程式。第一次安裝時，畫面是繁體中文。已經選過語言的人維持原來的選擇。
2. 在「發現短劇」挑一部，或到搜尋輸入劇名。
3. 「發現短劇」旁邊的「搶先上線日」會列出即將上線的短劇，再按一次回到原本的海報牆。
4. 按「立即播放」在線看。要存檔時，再勾選集數。
5. 之後從「我的劇庫」或「觀看紀錄」接著看。下載進度在「下載管理」。
6. 想和手機同步時，按左下角「紅果立即登入」。登入後觀看紀錄和已上線的收藏與手機同一份，尚未上線的收藏只留在這台電腦；登出後觀看紀錄回到這台電腦自己的紀錄，收藏留在這台電腦。收藏清單是同一份、最近收藏的在前，可以按可播放、尚未上線、真人劇、漫劇、AI 劇篩選，也能查看手機收藏夾；收藏夾新增、改名、刪除與移動仍請在手機操作。

右上角可在繁體與簡體之間切換。轉換只改畫面上的文字；搜尋框、檔名與下載目錄保持原樣。

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

片源由來源服務決定。鎖定集保持鎖定，這個程式不提供解鎖。在線播放看實際畫面。不保證每一集都有相同的清晰度。

### 影片與設定放在哪裡？

影片在設定裡的下載目錄。設定、任務與觀看紀錄在 Windows 上預設位於 `%APPDATA%\hongguo-downloader\`。

### 怎樣更新？

安裝版預設檢查本倉庫的正式版。出現新版本時，先由你決定是否下載，下載完成後再決定是否安裝。預發布不會提示。

### 裝了新版，為什麼還是舊版本？

先退出所有正在執行的紅果短劇，再執行新的安裝檔，並從安裝程式建立的捷徑啟動。設定頁顯示的版本號才是目前執行的版本。

### 畫面連不上，並提到憑證？

請把紅果短劇加入過濾或防毒軟體的例外，或暫時關閉加密連線過濾後再試。程式不會關閉憑證檢查。

## 從原始碼建置

需要 Node.js 22.12 或更新版本。

```sh
git clone https://github.com/z123312873-art/hongguo-drama.git
cd hongguo-drama
npm ci
npm test
npm run dev
```

Windows 安裝檔：`npm run build:installer`。步驟見 [發行說明](docs/RELEASING.md)。自行建置不會自動簽章。已發行的安裝檔以 [4.5 正式版](https://github.com/z123312873-art/hongguo-drama/releases/tag/v4.5) 為準。

## 授權

本專案延續 [jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 的 [GPL-3.0](LICENSE)。元件授權見 [第三方聲明](THIRD-PARTY-NOTICES.md)。

更早的基礎包括 [327044572/hongguo-downloader](https://github.com/327044572/hongguo-downloader)、[zhenyong97/hongguo-downloader](https://github.com/zhenyong97/hongguo-downloader) 與 [dawei233/hongguo-drama](https://github.com/dawei233/hongguo-drama)。片源演算法來源見 [演算法來源聲明](src/native/licenses/NOTICE.txt)。

開源授權只適用於這個軟體，不包含劇集內容。安裝檔裡沒有劇集影片。
