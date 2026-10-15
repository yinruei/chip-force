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
SHOW_BACKTEST = False   # 回測分頁先拿掉；改成 True 就會把 output/backtest_summary.json 放回頁面
KEEP_DAYS = 60   # 頁面預設只顯示最近 10 天，更早的由使用者按「更早」展開
PARAMS = {"window": 60, "k": 2.0, "confirm": 1, "min_ratio": 0.05, "min_volume": 1000, "fast": 20, "slow": 60}
MODES = {"三大法人": "靈敏", "投信": "穩健"}


def row(r: dict, close: dict, prev: dict) -> dict:
    code = r["代號"]
    p, p0 = close.get(code), prev.get(code)
    return {"c": code, "n": r["名稱"], "m": r["市場"], "v": r["成交張數"], "net": r["法人買賣超(張)"],
            "r": r["佔股本比(%)"], "f": r["力度z"], "x": bool(r["買方轉強"]),
            # 收盤價與漲跌幅（和前一個交易日收盤比；除權息日會和官方漲跌不同）
            "p": p, "g": round((p / p0 - 1) * 100, 2) if p and p0 else None}


def load_close(ds: str) -> dict[str, float]:
    """只讀快取 px_YYYYMMDD.csv 的收盤價；沒有就回傳空的。"""
    f = c.CACHE / f"px_{ds}.csv"
    if not f.exists():
        return {}
    with f.open(encoding="utf-8") as fh:
        return {r["code"]: float(r["close"]) for r in csv.DictReader(fh) if float(r["close"] or 0) > 0}


def add_tags(out: dict) -> None:
    """標記：s＝連續上榜天數、w＝近 10 個交易日第一次上榜、b＝投信和三大法人同一天都上榜（只看顯著買超）。"""
    ds_list = sorted(out["dates"])
    for inv in MODES:
        hist: list[set[str]] = []
        for i, ds in enumerate(ds_list):
            picks = out["dates"][ds][inv]["picks"]
            for r in picks:
                s, j = 1, i - 1
                while j >= 0 and r["c"] in hist[j]:
                    s, j = s + 1, j - 1
                r["s"] = s
                r["w"] = i >= 10 and all(r["c"] not in h for h in hist[i - 10:i])
            hist.append({r["c"] for r in picks})
    for ds in ds_list:
        e = out["dates"][ds]
        both = {r["c"] for r in e["投信"]["picks"]} & {r["c"] for r in e["三大法人"]["picks"]}
        for inv in MODES:
            for r in e[inv]["picks"]:
                r["b"] = r["c"] in both


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
    # 頁面只需要門檻值來畫虛線；其他參數不放進頁面，避免從原始碼看出選股條件
    out = {"params": {"k": p["k"]}, "dates": {}}
    trading = sorted(f.stem for f in c.CACHE.glob("*.csv") if f.stem.isdigit() and len(f.stem) == 8)
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
        close = load_close(ds)
        i = trading.index(ds) if ds in trading else 0
        prev = load_close(trading[i - 1]) if i > 0 else {}
        entry = {}
        for inv, mode in MODES.items():
            _, picks, strong = c.screen(days, inv, p["window"], p["k"], p["confirm"], mode, p["min_ratio"],
                                        p["fast"], p["slow"], vol, markets, p["min_volume"])
            _, p0, s0 = c.screen(days, inv, p["window"], p["k"], p["confirm"], mode, p["min_ratio"], p["fast"], p["slow"])
            entry[inv] = {"picks": [row(r, close, prev) for r in picks], "strong": [row(r, close, prev) for r in strong],
                          "before": {"picks": len(p0), "strong": len(s0)}}
        out["dates"][ds] = entry
    if not out["dates"]:
        sys.exit("沒有可用的日期，未產生頁面。")
    add_tags(out)
    bt = c.OUT / "backtest_summary.json"
    if SHOW_BACKTEST and bt.exists():
        out["backtest"] = json.loads(bt.read_text(encoding="utf-8"))
    html = (HERE / "dashboard_template.html").read_text(encoding="utf-8")
    now = dt.datetime.now(c.TZ).strftime("%Y-%m-%d %H:%M")
    html = html.replace("__DATA__", json.dumps(out, ensure_ascii=False, separators=(",", ":"))).replace("__UPDATED__", now)
    c.OUT.mkdir(parents=True, exist_ok=True)
    (c.OUT / "dashboard.html").write_text(html, encoding="utf-8")
    print(f"dashboard.html：{', '.join(out['dates'])}")


if __name__ == "__main__":
    main()
