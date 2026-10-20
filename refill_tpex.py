#!/usr/bin/env python3
"""
回補上櫃的外資／投信／自營買賣超（2026-10 發現：櫃買中心欄位名稱看不出法人，舊程式抓不到，
快取裡上櫃這三欄全是 0，只有三大法人合計是對的）。
對 data/YYYYMMDD.csv 每一天重抓櫃買中心，只更新上櫃列的四個數字，股本與上市資料不動。
已經有值的日子會略過（可以中斷後重跑）。
用法：python refill_tpex.py [--budget-min 40]
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time

import chip_force as c


def needs_fix(rows: list[dict]) -> bool:
    otc = [r for r in rows if r["market"] == "上櫃"]
    return bool(otc) and not any(r["外資"] or r["投信"] or r["自營"] for r in otc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget-min", type=float, default=40)
    args = ap.parse_args()
    deadline = time.time() + args.budget_min * 60
    days = sorted(f.stem for f in c.CACHE.glob("*.csv") if f.stem.isdigit() and len(f.stem) == 8)
    todo = []
    for ds in days:
        d = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:]))
        rows = c.load_day(d)
        if rows and needs_fix(rows):
            todo.append((d, rows))
    print(f"共 {len(days)} 天，需要回補 {len(todo)} 天")
    done = fail = 0
    for d, rows in todo:
        if time.time() > deadline:
            print("已達時間預算，下次再接著跑"); break
        otc = c.fetch_tpex_day(d)
        time.sleep(2)
        if not otc or not any(r["投信"] or r["外資"] for r in otc):
            fail += 1
            print(f"  ! {d} 抓不到或沒有法人明細", file=sys.stderr)
            continue
        new = {r["code"]: r for r in otc}
        n = 0
        for r in rows:
            if r["market"] == "上櫃" and r["code"] in new:
                for k in ("外資", "投信", "自營", "三大法人"):
                    r[k] = new[r["code"]][k]
                n += 1
        c.save_day(d, rows)
        done += 1
        print(f"{d}：更新 {n} 檔上櫃")
    left = len(todo) - done - fail
    print(f"完成 {done} 天、失敗 {fail} 天、未處理 {left} 天")


if __name__ == "__main__":
    main()
