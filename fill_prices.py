#!/usr/bin/env python3
"""
補抓最近交易日的開收盤價與成交量（data/px_YYYYMMDD.csv），讓選股頁能顯示收盤價和漲跌幅。
只補缺的日子；已經有 px_ 快取的不重抓。每天排程選股後執行。
"""
from __future__ import annotations

import datetime as dt
import time

import backtest as bt
import chip_force as c
from build_dashboard import KEEP_DAYS

# 法人資料快取 data/YYYYMMDD.csv 的日期 = 交易日（休市日的快取只有標題列，略過）；多抓一天，才算得出第一天的漲跌幅
days = sorted(p.stem for p in c.CACHE.glob("*.csv") if p.stem.isdigit() and len(p.stem) == 8 and p.stat().st_size > 200)[-(KEEP_DAYS + 1):]
deadline = time.time() + 15 * 60
for ds in days:
    if (c.CACHE / f"px_{ds}.csv").exists():
        continue
    if bt.load_px(dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:])), deadline) is None:
        print(f"略過 {ds}：抓不到價量")
