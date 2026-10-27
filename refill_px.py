#!/usr/bin/env python3
"""
回補價量快取 data/px_YYYYMMDD.csv，給個股明細畫 K 棒與均線（2026-10 起）：
  1. 舊的 px_ 沒有最高／最低價 → 重抓補上
  2. 往前補到最近 --days 個交易日都有價量（240 日均線要往前多 240 天）
從最近的交易日往回走平日；有法人快取的期間照快取判斷休市，更早的日子證交所沒有資料（休市）就不會寫入快取。可以中斷後重跑，已補好的會略過。
用法：python refill_px.py [--days 310] [--budget-min 45]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import time

import backtest as bt
import chip_force as c


def has_hl(p) -> bool:
    with p.open(encoding="utf-8") as fh:
        return "high" in (csv.DictReader(fh).fieldnames or [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=310)
    ap.add_argument("--budget-min", type=float, default=45)
    args = ap.parse_args()
    deadline = time.time() + args.budget_min * 60
    files = sorted(f for f in c.CACHE.glob("*.csv") if f.stem.isdigit() and len(f.stem) == 8)
    legal = {f.stem for f in files if f.stat().st_size > 200}   # 休市日的法人快取只有標題列
    d = dt.date(int(files[-1].stem[:4]), int(files[-1].stem[4:6]), int(files[-1].stem[6:]))
    first_legal = files[0].stem
    have = fetched = skipped = miss = 0
    while have < args.days:
        if time.time() > deadline:
            print("已達時間預算，下次再接著跑"); break
        ds = d.strftime("%Y%m%d")
        p = c.CACHE / f"px_{ds}.csv"
        if d.weekday() < 5:
            if p.exists() and has_hl(p):
                have += 1
            elif p.exists() or ds in legal or ds < first_legal:
                bt.load_px(d, None, refresh=True)
                if p.exists() and has_hl(p):
                    have += 1; fetched += 1
                    print(f"{ds}：完成")
                else:
                    skipped += 1; miss += 1
                    print(f"  {ds}：沒有資料（休市或抓取失敗）")
                    if miss >= 15:
                        print("連續 15 個平日抓不到，停止（可能是資料來源暫時無法連線）"); break
                    d -= dt.timedelta(days=1)
                    continue
                miss = 0
            else:
                skipped += 1   # 有法人資料的期間內，沒有法人快取的平日＝休市
        d -= dt.timedelta(days=1)
    print(f"有價量（含最高最低）{have} 個交易日、這次抓 {fetched} 天、略過 {skipped} 天；最早 {d + dt.timedelta(days=1)}")


if __name__ == "__main__":
    main()
