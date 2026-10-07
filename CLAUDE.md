# chip_force — 籌碼力度每日選股

台股「法人買賣超 ÷ 發行股數（佔股本比）→ 過去 N 日標準化 z → z ≥ k 且買超」選股程式，依老墨「法人力度指標」公開說明重建（原 XQ 腳本加密，數值可能與原版略有差異）。

## 檔案

- `chip_force.py` — 唯一程式，只用 Python 標準函式庫，無需安裝套件
- `data/YYYYMMDD.csv` — 每日原始資料快取（全市場法人買賣超＋發行股數），**進版控**，換電腦不用重抓
- `output/` — 每日結果：`latest_<法人>.md`、`YYYYMMDD_<法人>.md`、`YYYYMMDD_<法人>_顯著買超.csv`
- `build_dashboard.py` + `dashboard_template.html` — 每天選股後由快取產生單檔視覺化頁面 `output/dashboard.html`（最近 10 個交易日、兩種法人）。改選股參數時，`build_dashboard.py` 的 `PARAMS`／`MODES` 要一起改。
- `backtest.py` — 回測（訊號隔日開盤進場、持有 1/5/10/20 日收盤出場，扣來回成本，對照同日全市場等權基準）。價量快取 `data/px_YYYYMMDD.csv`；由手動 workflow `.github/workflows/backtest.yml` 執行，報告在 `output/backtest.md`、逐筆在 `output/backtest_trades.csv`、彙總在 `output/backtest_summary.json`（`python backtest.py --report-only` 可不連網重做報告）。`build_dashboard.py` 會把彙總放進視覺化頁面的「回測」分頁。回補有時間預算，中斷後再按一次會接著抓。
- 自動化：GitHub 的 cron 常延遲 6–9 小時，所以 `daily.yml` 排了每小時一次（台北 17:47–23:47），當天已完成就自動略過。Claude 的「籌碼力度頁面每日更新」排程（週一到週五台北 19:33、23:33）只負責把 `output/dashboard.html` 重新發佈到 Artifact：repo 裡最新交易日比 Artifact 上新才發佈。Claude 的排程沒有權限觸發 workflow 或 push，所以選股要靠 GitHub 的 cron。
- 排程：`.github/workflows/daily.yml`（週一至週五台北 17:47，自動 commit 回 repo）

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
