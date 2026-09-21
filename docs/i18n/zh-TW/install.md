# 安裝與首次連線

[简体中文](../../install.md) · [English](../en/install.md) · [繁體中文](install.md) · [日本語](../ja/install.md) · [한국어](../ko/install.md)

本說明使用 `0.1.0-alpha.1` 的命令列介面。實際驗證的系統、瀏覽器及用戶端請參閱[相容矩陣](../../compatibility.md)（簡體中文）；目前為開發候選版本，尚未發布到 npm。

## 1. 下載發行套件或準備原始碼

一般使用者應優先從對應版本的 [GitHub Releases](https://github.com/gjw199513/babel-content-clipper/releases) 下載 `babel-content-clipper-extension-0.1.0-alpha.1.zip`，並解壓縮到會長期保留的目錄。只使用瀏覽器擷取時，不需要下載原始碼、安裝 Node.js 或自行建置。

需要連接本機 MCP 時，再下載同一 Release 中的 `babel-content-clipper-0.1.0-alpha.1.tgz`。本機元件需要 Node.js 22 或更新版本，請確認 `node --version` 能正常執行。瀏覽器擷取本身不依賴 FFmpeg；Agent 需要裁切影音時，再使用其執行環境中既有的媒體工具。

從原始碼目錄建置：

```sh
npm ci
npm run build
```

使用 Release 中的 MCP 安裝套件時，請在自己的安裝目錄執行以下命令。請將檔名替換成實際下載的安裝套件路徑。

```sh
npm install /absolute/path/babel-content-clipper-0.1.0-alpha.1.tgz
```

使用原始碼時，本機元件位於 `dist/node/cli.js`；使用安裝套件時，則位於 `node_modules/babel-content-clipper/dist/node/cli.js`。下文使用原始碼方式的相對路徑；執行命令時請停留在原始碼根目錄。

## 2. 載入擴充功能並取得連線識別碼

在瀏覽器擴充功能管理頁開啟「開發人員模式」，選擇「載入未封裝項目」：原始碼方式請選擇 `dist/extension`，Release 方式則選擇包含 `manifest.json` 的 ZIP 解壓縮目錄。Chrome 無法直接載入一般 ZIP；無需原始碼，但必須先解壓縮。真正的一鍵安裝需要瀏覽器商店或瀏覽器認可的企業發佈管道。

開啟 Babel 側邊欄，點選「展開管理」進入素材庫，再開啟「連線與設定」。複製畫面顯示的瀏覽器連線識別碼 `profileId`。它用於區分不同瀏覽器的資料，不是網站帳號。

此建置的擴充功能 ID 為 `lpmplddblefacpachnchfgcdebjebdbh`。仍應對照擴充功能管理頁實際顯示的 ID；自行修改建置 key 後必須使用自己的 ID。

此時可在一般網頁選取文字，透過右鍵或 `Alt+Shift+S` 儲存。即使尚未連接 MCP，擴充功能也應能儲存並顯示記錄。

更新原始碼或替換擴充功能建置後，請在擴充功能管理頁點選該擴充功能的「重新載入」，再重新開啟側邊欄。僅重新開啟瀏覽器視窗不能證明新程式碼已載入；請勿為了更新而刪除擴充功能資料。

## 3. 安裝本機橋接並產生用戶端設定

將下方的 `YOUR_PROFILE_ID` 替換成上一步的連線識別碼。安裝程式會產生 Native Messaging 註冊檔、啟動指令碼及 MCP 設定範例。它預設保護既有檔案；遇到 `INSTALL_TARGET_EXISTS` 時，先確認既有檔案是否屬於目前安裝，只有更新自己的舊安裝時才使用 `--overwrite`。

macOS / Google Chrome：

```sh
node dist/node/cli.js --mode=install \
  --extension-id lpmplddblefacpachnchfgcdebjebdbh \
  --profile-id YOUR_PROFILE_ID \
  --manifest-dir "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  --mcp-config-out ./babel-clipper-mcp.json
```

使用 Chromium 時，將 `--manifest-dir` 改為 `$HOME/Library/Application Support/Chromium/NativeMessagingHosts`；使用 Edge 時改為 `$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts`。這些瀏覽器分別讀取自己的註冊目錄。

Linux 的對應目錄通常是 `$HOME/.config/google-chrome/NativeMessagingHosts`、`$HOME/.config/chromium/NativeMessagingHosts` 或 `$HOME/.config/microsoft-edge/NativeMessagingHosts`。不同發行管道可能使用自己的目錄；此平台仍需依相容矩陣完成實機驗證。

Windows 可使用相同 CLI 產生檔案，再將目前使用者登錄中對應瀏覽器的 Native Messaging 主機預設值設為所產生 JSON 檔案的絕對路徑。CLI 輸出的 `manualBrowserLocations` 會列出對應的登錄機碼。Windows 的主機啟動與註冊尚未在本專案實機驗證，僅產生檔案不算支援通過。

安裝成功時，終端機會回傳包含 `nativeHost.manifestPath`、`nativeHost.launcherPath` 及 `mcpConfig.path` 的 JSON。請勿移動或刪除元件安裝目錄；產生的設定使用絕對路徑。

將 `babel-clipper-mcp.json` 中 `mcpServers` 下的項目合併到用戶端自己的 MCP 設定。不同用戶端的設定檔位置及外層格式不同，請使用該用戶端提供的 MCP 設定入口。產生的 `command` 是本機 Node 的絕對路徑，參數包含元件、設定目錄及 `profileId`；不需要填入作者電腦上的路徑。

輸出目錄只需選擇一種入口：

- 素材庫「連線與設定」中的「全域預設成品目錄（選填）」。
- 安裝時加入 `--output-root /absolute/path/to/output`，儲存一個 MCP 預設目錄；也可在某個用戶端的 MCP 啟動參數加入 `--output-root`，只覆寫該連線的預設目錄。
- 處理某次工作時，由使用者或 Agent 明確提供絕對目錄。

解析順序為本次工作、MCP 預設值、擴充功能全域預設值。單次覆寫不會修改預設值。明確提供但無法使用的目錄會回報錯誤，不會改存到其他位置。

例如，某個用戶端可採用獨立的連線預設目錄：

```sh
node dist/node/cli.js --mode=mcp --profile-id YOUR_PROFILE_ID --output-root /absolute/path/to/client-output
```

這是 stdio 服務啟動命令，通常由 MCP 用戶端執行。它不會修改擴充功能的全域設定或其他用戶端的設定。

## 4. 檢查完整連線

安裝完成後，在素材庫的「連線與設定」點選「重新連線本機服務」，並啟動或重新整理用戶端的 MCP 連線。接著執行：

```sh
node dist/node/cli.js --mode=doctor --profile-id YOUR_PROFILE_ID
```

如果安裝時使用了 `--config-dir`，診斷時請使用相同參數。只有回傳 `ready: true` 且擴充功能診斷成功，才表示所選 profile 的完整連線已就緒。缺少瀏覽器連線、設定錯誤及主機未啟動會分別回傳具體狀態。

請 Agent 執行「查詢 Babel Clipper 的待處理記錄」。單純查詢不會領取或處理工作。確認 Agent 能讀取剛才的選文後，再明確要求「將這筆選文儲存成文字檔，並回寫處理結果」；Agent 會依照[執行契約](agent-workflow.md)領取該 Job、儲存產物並提交結果。素材庫應顯示已處理狀態及本次歷史。

## 常見問題

| 現象 | 排查方向 |
|---|---|
| `PROFILE_REQUIRED` 或 profile 不一致 | 從目前瀏覽器素材庫複製 `profileId`，檢查用戶端參數，不可使用其他測試 profile。 |
| 找不到 Native Host | 檢查註冊目錄是否屬於目前瀏覽器、JSON 中的擴充功能 ID、啟動指令碼路徑與執行權限，然後重新連線。 |
| `BROKER_UNAVAILABLE` | 啟動擴充功能的本機連線或 MCP 用戶端。doctor 只檢查狀態，不負責在背景啟動。 |
| `BROWSER_UNAVAILABLE` | 保持對應瀏覽器及擴充功能執行，檢查素材庫的本機服務連線狀態。此錯誤不表示待辦清單為空。 |
| `WRITEBACK_UNACKNOWLEDGED` 或回寫時斷線 | 保留原本的 `requestId` 及完全相同的結果內容，重新連線後進行冪等重送；取得持久化 ACK 前不可宣稱完成。 |
| 已處於處理中但 Agent 失去連線 | 先確認原執行是否仍在進行；系統不會因逾時而自動釋放或重複執行。 |
| 網頁無法擷取 | 瀏覽器內部頁面、權限受限頁面或特殊閱讀器可能無法存取；使用有明確標示的降級方式，截圖不會變成原文。 |
| `TAB_CAPTURE_PERMISSION_REQUIRED` | 切回要錄製的網頁，點選瀏覽器工具列上的 Babel 擴充功能圖示，再為本次片段開啟現場儲存。也可先在該頁選取文字並以真實快捷鍵擷取，再直接從側邊欄錄製；目前驗收已通過此路徑。授權呼叫必須發生在目標網頁，不能在素材庫頁面呼叫後視為影片頁已授權。擴充功能重新載入後需再次呼叫。經遮蔽的具體原因會儲存在失敗詳細資料中；未啟動時只能算已記錄時間範圍。 |
| 輸出目錄錯誤 | 檢查實際最高優先順序的目錄及目前系統使用者權限，不需在兩處重複設定。 |

移除擴充功能或刪除瀏覽器資料會影響本機資料。移動到新 profile 前請先匯出備份，並確認匯出內容是否包含附件位元組；只有中繼資料的備份無法還原圖片或錄製檔。外部 Agent 產生的成品不包含在擴充功能附件備份中。
