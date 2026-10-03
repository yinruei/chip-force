#!/usr/bin/env python3
"""
由快取資料產生單檔視覺化頁面 output/dashboard.html（內含最近 10 個交易日、兩種法人的結果）。
只讀 data/ 的快取，不連網；每天排程跑完選股後執行。
參數須與 daily.yml 的選股參數一致（三大法人＝靈敏、投信＝穩健）。
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import chip_force as c

HERE = Path(__file__).resolve().parent
KEEP_DAYS = 10
PARAMS = {"window": 60, "k": 2.0, "confirm": 1, "min_ratio": 0.05, "min_volume": 1000, "fast": 20, "slow": 60}
MODES = {"三大法人": "靈敏", "投信": "穩健"}


def row(r: dict) -> dict:
    return {"c": r["代號"], "n": r["名稱"], "m": r["市場"], "v": r["成交張數"], "net": r["法人買賣超(張)"],
            "r": r["佔股本比(%)"], "z": r["力度z"], "x": bool(r["買方轉強"])}


def main() -> None:
    p = PARAMS
    need = max(p["window"], p["slow"]) + p["confirm"] + 1
    vol_dates = sorted(f.stem[4:] for f in c.CACHE.glob("vol_*.csv"))[-KEEP_DAYS:]
    out = {"params": p, "dates": {}}
    for ds in vol_dates:
        d = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:]))
        days = c.collect(need, d, include_otc=True)
        if len(days) < need or days[-1][0] != d:
            print(f"略過 {d}：快取的交易日資料不足", file=sys.stderr)
            continue
        vol, markets = c.load_volume(d, include_otc=True)
        entry = {}
        for inv, mode in MODES.items():
            _, picks, strong = c.screen(days, inv, p["window"], p["k"], p["confirm"], mode, p["min_ratio"],
                                        p["fast"], p["slow"], vol, markets, p["min_volume"])
            _, p0, s0 = c.screen(days, inv, p["window"], p["k"], p["confirm"], mode, p["min_ratio"], p["fast"], p["slow"])
            entry[inv] = {"picks": [row(r) for r in picks], "strong": [row(r) for r in strong],
                          "before": {"picks": len(p0), "strong": len(s0)}}
        out["dates"][ds] = entry
    if not out["dates"]:
        sys.exit("沒有可用的日期，未產生頁面。")
    bt = c.OUT / "backtest_summary.json"
    if bt.exists():
        out["backtest"] = json.loads(bt.read_text(encoding="utf-8"))
    html = (HERE / "dashboard_template.html").read_text(encoding="utf-8")
    now = dt.datetime.now(c.TZ).strftime("%Y-%m-%d %H:%M")
    html = html.replace("__DATA__", json.dumps(out, ensure_ascii=False, separators=(",", ":"))).replace("__UPDATED__", now)
    c.OUT.mkdir(parents=True, exist_ok=True)
    (c.OUT / "dashboard.html").write_text(html, encoding="utf-8")
    print(f"dashboard.html：{', '.join(out['dates'])}")


if __name__ == "__main__":
    main()
