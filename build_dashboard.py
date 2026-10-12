#!/usr/bin/env python3
"""
由快取資料產生單檔視覺化頁面 output/dashboard.html（內含最近 10 個交易日、兩種法人的結果）。
只讀 data/ 的快取，不連網；每天排程跑完選股後執行。
參數須與 daily.yml 的選股參數一致（三大法人＝靈敏、投信＝穩健）。
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import sys
import time
from pathlib import Path

import chip_force as c

HERE = Path(__file__).resolve().parent
KEEP_DAYS = 60   # 頁面預設只顯示最近 10 天，更早的由使用者按「更早」展開
PARAMS = {"window": 60, "k": 2.0, "confirm": 1, "min_ratio": 0.05, "min_volume": 1000, "fast": 20, "slow": 60}
MODES = {"三大法人": "靈敏", "投信": "穩健"}


def row(r: dict) -> dict:
    return {"c": r["代號"], "n": r["名稱"], "m": r["市場"], "v": r["成交張數"], "net": r["法人買賣超(張)"],
            "r": r["佔股本比(%)"], "z": r["力度z"], "x": bool(r["買方轉強"])}


def load_volume_cached(d: dt.date):
    """只讀快取：先用 vol_，沒有就用回測抓的 px_（同一份成交張數）。"""
    if (c.CACHE / f"vol_{d:%Y%m%d}.csv").exists():
        return c.load_volume(d, include_otc=True)
    f = c.CACHE / f"px_{d:%Y%m%d}.csv"
    if not f.exists():
        return {}, set()
    with f.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    return {r["code"]: float(r["lots"]) for r in rows}, {r["market"] for r in rows}


def main() -> None:
    p = PARAMS
    need = max(p["window"], p["slow"]) + p["confirm"] + 1
    # 有成交量資料的日子 = 有 vol_ 快取（選股當天抓的）或 px_ 快取（回測抓的價量）
    have = {f.stem.split("_", 1)[1] for pat in ("vol_*.csv", "px_*.csv") for f in c.CACHE.glob(pat)}
    out = {"params": p, "dates": {}}
    for ds in sorted(have)[-KEEP_DAYS:]:
        d = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:]))
        # deadline 設成過去 = 只讀快取、不連網；缺資料的日子就略過
        days = c.collect(need, d, include_otc=True, deadline=time.time() - 1)
        if len(days) < need or days[-1][0] != d:
            print(f"略過 {d}：快取的交易日資料不足", file=sys.stderr)
            continue
        vol, markets = load_volume_cached(d)
        if not vol:
            continue
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
