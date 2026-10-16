# chip_force — 籌碼力度每日選股

台股「法人買賣超 ÷ 發行股數（佔股本比）→ 過去 N 日標準化 z → z ≥ k 且買超」選股程式，依老墨「法人力度指標」公開說明重建（原 XQ 腳本加密，數值可能與原版略有差異）。

## 檔案

- `chip_force.py` — 唯一程式，只用 Python 標準函式庫，無需安裝套件
- `data/YYYYMMDD.csv` — 每日原始資料快取（全市場法人買賣超＋發行股數），**進版控**，換電腦不用重抓
- `output/` — 每日結果：`latest_<法人>.md`、`YYYYMMDD_<法人>.md`、`YYYYMMDD_<法人>_顯著買超.csv`
- `build_dashboard.py` + `dashboard_template.html` — 每天選股後由快取產生單檔視覺化頁面 `output/dashboard.html`（最近 10 個交易日、兩種法人）。改選股參數時，`build_dashboard.py` 的 `PARAMS`／`MODES` 要一起改。
- `backtest.py` — 回測（訊號隔日開盤進場、持有 1/5/10/20 日收盤出場，扣來回成本，對照同日全市場等權基準）。價量快取 `data/px_YYYYMMDD.csv`；由手動 workflow `.github/workflows/backtest.yml` 執行，報告在 `output/backtest.md`、逐筆在 `output/backtest_trades.csv`、彙總在 `output/backtest_summary.json`（`python backtest.py --report-only` 可不連網重做報告）。`build_dashboard.py` 會把彙總放進視覺化頁面的「回測」分頁。回補有時間預算，中斷後再按一次會接著抓。
- `screenshot.py` — 每天產生頁面後，把上半部（摘要、力度排行、散布圖，含「非投資建議」註記）截成 PNG：`output/screenshots/latest_投信.png`、`latest_三大法人.png`，以及每天一份 `YYYYMMDD_*.png`（只留最近 30 天），給 Skool 課程用。
- `METHOD.md` — 選股方法完整說明（內部文件：公式、參數、回測摘要、保密規則）。
- `site/` — Skool 付費會員專屬網站（Cloudflare Worker + KV）：email 註冊需本月驗證碼、管理者在 `/admin` 核准、每月重新驗證、每帳號最多 2 台裝置。部署由 `.github/workflows/site.yml`，每天 `daily.yml` 會把 `output/dashboard.html` 上傳到 KV。說明見 `site/README.md`。免費方案每個請求只有約 10ms CPU：密碼雜湊用 PBKDF2 1 萬次（舊帳號 10 萬次，登入時自動升級），不要再調高；要檢查網站回應時間、CPU 與錯誤，手動跑 `.github/workflows/site-check.yml`。KV 各地同步約有 1 分鐘延遲，所以會員資料拆成 `user:`（帳密）、`st:`（狀態，只有註冊和管理者寫）、`vm:`（每月驗證）、`ss:`（登入裝置）四個 key（另有 `sk:<Skool 帳號>` → email，讓一個 Skool 帳號只能綁一個 email），各自只由負責的動作寫入；不要再合併成一筆整包寫回，否則會員登入/登出會蓋掉管理者的核准。
- 自動化：主要觸發是會員網站 Worker 的 Cloudflare 排程（`site/wrangler.toml` 的 `[triggers]`，週一到週五台北 17:30–22:30 每小時），Worker 的 `scheduled()` 用 Worker secret `GH_TOKEN`（GitHub secret `SITE_GH_TOKEN`，只有本 repo 的 Actions 寫入權限）呼叫 `daily.yml` 的 workflow_dispatch，帶 `auto=true`：當天已完成就略過。GitHub 自己的 cron（台北 17:47–23:47）常延遲 6–9 小時，只當備援。舊的 Claude 頁面排程已停用。
- 排程：`.github/workflows/daily.yml`（自動 commit 回 repo）

## 常用指令

```bash
python chip_force.py                                   # 三大法人，W=60、k=2.0
python chip_force.py --investor 投信 --mode 穩健        # 投本比
python chip_force.py --investor 外資 --window 120 --k 2.5 --confirm 2
python chip_force.py --date 2026-09-29                 # 指定日期
```

使用者說「跑今天的籌碼力度」＝執行預設指令並摘要 `output/latest_三大法人.md`；
「把門檻改成 2.5」＝改 `--k`（若要改排程預設，同步改 `daily.yml` 與 `argparse` 預設值）。

## 參數（對應原指標 8 個參數）

`--investor`（三大法人／外資／投信／自營）、`--window`（20/60/120）、`--k`（1.5/2.0/2.5）、`--confirm`（1/2/3）、`--mode`（靈敏／穩健）、`--min-ratio`、`--min-volume`（最低成交張數，預設 1000，0＝不篩）、`--fast`（10/20/30）、`--slow`（40/60/120）。

## 注意事項

- 資料來源：證交所 T86、MI_QFIIS（上市）；櫃買中心（上櫃，選配，介面常改版，失敗時自動略過只跑上市）。證交所有限流，程式內已 `sleep`，不要拿掉。
- 欄位以關鍵字比對（`_col`），證交所改欄位名時先檢查 `fetch_twse_day` / `fetch_tpex_day`。
- 成交量只抓篩選當日，快取為 `data/vol_YYYYMMDD.csv`（兩市場都成功才寫入）；解析函式 `fetch_twse_volume` / `fetch_tpex_volume`，介面改版時先檢查這兩個。
- 僅納入 4 碼普通股（`is_common_stock`）。
- 快取、輸出都由 GitHub Actions 自動 commit；本機跑完若要保留結果再自行 commit，避免與 bot 的 commit 衝突，開工前先 `git pull`。
- 結果僅為公開資料之統計，非投資建議。

## 選股方法保密
會員看得到的地方（`dashboard_template.html`、頁面裡的 `DATA`、`site/worker.js` 的使用說明 `/guide`、Skool 截圖）都不要寫出公式或參數（60 日、z、標準差、門檻 2、0.05%、1000 張、20/60 日均線）。頁面資料只放門檻值 `params.k` 畫虛線，力度欄位叫 `f`、畫面上叫「力度」。

## 選股頁資料欄位
每檔：`c` 代號、`n` 名稱、`m` 市場、`v` 成交張數、`net` 法人買賣超(張)、`r` 佔股本比、`f` 力度、`x` 買方轉強、`p` 收盤、`g` 漲跌%（和前一交易日收盤比，來自 `data/px_*.csv`，由 `fill_prices.py` 每天補抓）、顯著買超另有 `s` 連續上榜天數、`w` 近 10 日首次上榜、`b` 投信與三大法人雙榜（`build_dashboard.py` 的 `add_tags`）。
個股明細：`build_dashboard.py` 另外產生 `output/series.json`（近 60 交易日、曾上榜股票的 `i`/`t` 三大法人／投信買賣超張數、`fi`/`ft` 力度、`p` 收盤，約 1MB，不進 git），`site/upload.sh` 上傳到 KV key `series`，Worker 的 `/series.json`（需登入且本月已驗證）提供，頁面點股票時才載入。
會員網站有 manifest 與主畫面圖示（`site/icons.js` 由 `site/icon.svg` 轉成 PNG 內嵌），手機加到主畫面會像 APP 全螢幕開啟。
