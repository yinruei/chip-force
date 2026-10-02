#!/usr/bin/env python3
"""
籌碼力度回測
============
把每天的「顯著買超」「買方轉強」訊號，往後持有 1/5/10/20 個交易日，看平均報酬、勝率，
並和「同一天全市場（同樣的流動性門檻）等權平均」比較。

假設（刻意保守、避免偷看未來）：
  - 訊號在 t 日收盤後才算得出來 → 進場價 = t+1 日開盤價
  - 出場價 = t+h 日收盤價
  - 每筆扣來回交易成本（預設 0.585% = 手續費 0.1425%×2 + 證交稅 0.3%，未計券商折讓）
  - 每個訊號日只用「當時以前」的資料算 z；成交張數門檻用訊號日當天的成交量
已知限制：股價是未還原的收盤價，除權息日的跳空會被當成虧損（對所有組別一視同仁，
基準也一樣）；同一檔股票連續多天出訊號會被當成多筆；持有期重疊，t 值會偏高。

資料：data/YYYYMMDD.csv（法人）＋ data/px_YYYYMMDD.csv（開盤、收盤、成交張數，本程式補抓）。
用法：python backtest.py --days 250 --budget-min 200
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import statistics
import sys
import time
from pathlib import Path

import chip_force as c

HORIZONS = (1, 5, 10, 20)
INVESTORS = {"三大法人": "靈敏", "投信": "穩健"}   # 與 daily.yml 一致
PX_FIELDS = ["code", "market", "open", "close", "lots"]


# ----------------------------------------------------------------- 抓價量
def _px_table(js: dict | None, id_key: str):
    for t in (js or {}).get("tables") or []:
        f = t.get("fields") or []
        ic, io, icl, iv = c._col(f, id_key), c._col(f, "開盤"), c._col(f, "收盤"), c._col(f, "成交股數")
        if None not in (ic, io, icl, iv) and t.get("data"):
            out = {}
            for r in t["data"]:
                o, cl, v = c._num(r[io]), c._num(r[icl]), c._num(r[iv])
                out[str(r[ic]).strip()] = (o, cl, v / 1000)
            return out
    return None


def fetch_twse_px(d: dt.date):
    js = c._get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=ALLBUT0999&response=json")
    return _px_table(js, "證券代號") if js and js.get("stat") == "OK" else None


def fetch_tpex_px(d: dt.date):
    js = c._get_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={d:%Y/%m/%d}&id=&response=json", retries=2)
    return _px_table(js, "代號")


def load_px(d: dt.date, deadline: float | None):
    """回傳 {code: (market, open, close, lots)}；沒有資料回傳 None。兩個市場都成功才寫入快取。"""
    p = c.CACHE / f"px_{d:%Y%m%d}.csv"
    if p.exists():
        with p.open(encoding="utf-8") as fh:
            return {r["code"]: (r["market"], float(r["open"]), float(r["close"]), float(r["lots"])) for r in csv.DictReader(fh)}
    if deadline is not None and time.time() > deadline:
        return None
    print(f"抓取價量 {d} ...", file=sys.stderr)
    out, ok = {}, set()
    for market, fn in (("上市", fetch_twse_px), ("上櫃", fetch_tpex_px)):
        time.sleep(3)
        px = fn(d)
        if px is None:
            print(f"  ! {d} {market}價量抓取失敗", file=sys.stderr)
            continue
        ok.add(market)
        out.update({code: (market, *v) for code, v in px.items()})
    if ok == {"上市", "上櫃"}:
        c.CACHE.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(PX_FIELDS)
            for code, (m, o, cl, lots) in out.items():
                w.writerow([code, m, o, cl, lots])
    return out or None


# ----------------------------------------------------------------- 回測核心（純函式，可單獨測）
def run_backtest(days, px, window=60, k=2.0, confirm=1, min_ratio=0.05, min_volume=1000.0,
                 fast=20, slow=60, cost_pct=0.585, horizons=HORIZONS):
    """days: [(date, rows)] 由舊到新；px: {date: {code: (market, open, close, lots)}}。回傳逐筆記錄。"""
    need = max(window, slow) + confirm + 1
    trades = []
    for i in range(need - 1, len(days)):
        d = days[i][0]
        pd_ = px.get(d)
        if not pd_:
            continue
        vol = {code: v[3] for code, v in pd_.items()}
        markets = {v[0] for v in pd_.values()}
        sl = days[i - need + 1:i + 1]

        def ret(code, h):
            if i + h >= len(days):
                return None
            a, b = px.get(days[i + 1][0], {}).get(code), px.get(days[i + h][0], {}).get(code)
            if not a or not b or a[1] <= 0 or b[2] <= 0:
                return None
            return (b[2] / a[1] - 1) * 100

        bench = {}
        for h in horizons:
            rs = [r for code, v in pd_.items() if c.is_common_stock(code) and v[3] >= min_volume
                  for r in [ret(code, h)] if r is not None]
            bench[h] = sum(rs) / len(rs) if rs else None

        for inv, mode in INVESTORS.items():
            _, picks, strong = c.screen(sl, inv, window, k, confirm, mode, min_ratio, fast, slow, vol, markets, min_volume)
            for group, recs in (("顯著買超", picks), ("買方轉強", strong)):
                for rec in recs:
                    z = rec["力度z"]
                    labels = [group]
                    if group == "顯著買超":
                        labels.append("顯著買超 z2–3" if z < 3 else "顯著買超 z3–5" if z < 5 else "顯著買超 z≥5")
                    for h in horizons:
                        r = ret(rec["代號"], h)
                        if r is None or bench[h] is None:
                            continue
                        for lab in labels:
                            trades.append({"date": d, "inv": inv, "group": lab, "code": rec["代號"], "name": rec["名稱"],
                                           "z": z, "h": h, "gross": r, "net": r - cost_pct, "bench": bench[h]})
    return trades


def summarize(trades):
    """依 (法人, 組別, 持有天數) 彙總。t 值用「每個訊號日的平均超額報酬」計算。"""
    keys = sorted({(t["inv"], t["group"], t["h"]) for t in trades}, key=lambda x: (x[0], x[1], x[2]))
    rows = []
    for inv, group, h in keys:
        ts = [t for t in trades if t["inv"] == inv and t["group"] == group and t["h"] == h]
        nets = [t["net"] for t in ts]
        by_day: dict = {}
        for t in ts:
            by_day.setdefault(t["date"], []).append(t["net"] - t["bench"])
        daily = [sum(v) / len(v) for v in by_day.values()]
        t_stat = None
        if len(daily) > 2 and statistics.stdev(daily) > 0:
            t_stat = statistics.mean(daily) / (statistics.stdev(daily) / math.sqrt(len(daily)))
        rows.append({
            "inv": inv, "group": group, "h": h, "n": len(ts), "days": len(by_day),
            "gross": sum(t["gross"] for t in ts) / len(ts), "net": sum(nets) / len(nets),
            "median": statistics.median(nets), "win": sum(1 for x in nets if x > 0) / len(nets) * 100,
            "bench": sum(t["bench"] for t in ts) / len(ts), "excess": statistics.mean(daily) if daily else 0.0, "t": t_stat,
        })
    return rows


def write_report(rows, trades, meta, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "backtest_trades.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["訊號日", "法人", "組別", "代號", "名稱", "力度z", "持有天數", "毛報酬%", "淨報酬%", "同期基準%"])
        for t in sorted(trades, key=lambda t: (t["date"], t["inv"], t["group"], t["code"], t["h"])):
            w.writerow([t["date"], t["inv"], t["group"], t["code"], t["name"], t["z"], t["h"],
                        round(t["gross"], 3), round(t["net"], 3), round(t["bench"], 3)])
    md = [f"# 籌碼力度回測\n",
          f"- 訊號日：{meta['first']} ～ {meta['last']}（共 {meta['signal_days']} 個有價量資料的交易日）",
          f"- 條件：比較區間 {meta['window']} 日、z ≥ {meta['k']}、成交張數 ≥ {meta['min_volume']:g}；三大法人＝靈敏模式，投信＝穩健模式（佔股本比 ≥ {meta['min_ratio']}%）",
          f"- 進場＝訊號隔日開盤價，出場＝持有 N 日後收盤價；淨報酬已扣來回成本 {meta['cost']}%",
          "- 基準＝同一天、同樣流動性門檻的全市場普通股，用同樣進出場規則的等權平均；超額＝淨報酬 − 基準",
          "- t 值：以「每個訊號日的平均超額報酬」計算；持有期重疊，實際顯著性比表面上低",
          "- 限制：未還原股價（除權息日會被當成虧損，基準同樣受影響）、同一檔連續出訊號會重複計入、未考慮漲停買不到與滑價", ""]
    for inv in INVESTORS:
        md.append(f"## {inv}\n")
        for h in HORIZONS:
            sub = [r for r in rows if r["inv"] == inv and r["h"] == h]
            if not sub:
                continue
            md.append(f"### 持有 {h} 日\n")
            md.append("| 組別 | 筆數 | 訊號日數 | 平均毛報酬% | 平均淨報酬% | 中位數% | 勝率% | 基準% | 超額% | t 值 |")
            md.append("|---|---|---|---|---|---|---|---|---|---|")
            for r in sub:
                t = f"{r['t']:.2f}" if r["t"] is not None else "—"
                md.append(f"| {r['group']} | {r['n']} | {r['days']} | {r['gross']:.2f} | {r['net']:.2f} | {r['median']:.2f} | "
                          f"{r['win']:.1f} | {r['bench']:.2f} | {r['excess']:+.2f} | {t} |")
            md.append("")
    md.append("> 歷史統計不保證未來表現，非投資建議。")
    p = out_dir / "backtest.md"
    p.write_text("\n".join(md), encoding="utf-8")
    return p


def main() -> None:
    ap = argparse.ArgumentParser(description="籌碼力度回測")
    ap.add_argument("--days", type=int, default=250, help="往回取幾個交易日的資料")
    ap.add_argument("--end", help="YYYY-MM-DD，預設今天")
    ap.add_argument("--budget-min", type=float, default=200, help="抓新資料的時間預算（分鐘），超過就用現有的資料回測")
    ap.add_argument("--min-volume", type=float, default=1000)
    ap.add_argument("--cost", type=float, default=0.585, help="來回交易成本(%%)")
    args = ap.parse_args()

    end = dt.date.fromisoformat(args.end) if args.end else dt.datetime.now(c.TZ).date()
    deadline = time.time() + args.budget_min * 60
    days = c.collect(args.days, end, include_otc=True, deadline=deadline)
    print(f"法人資料 {len(days)} 個交易日：{days[0][0]} ～ {days[-1][0]}", file=sys.stderr)
    need = 62  # = max(window, slow) + confirm + 1：前 61 日只用來暖機，不需要價量
    px = {}
    for d, _ in days[need - 1:]:
        p = load_px(d, deadline)
        if p:
            px[d] = p
    print(f"價量資料 {len(px)}/{len(days) - need + 1} 日", file=sys.stderr)
    # 只用「連續有價量」的最後一段，避免中間缺日讓「持有 N 日」失真
    first_sig = need - 1
    for j in range(len(days) - 1, need - 2, -1):
        if days[j][0] not in px:
            first_sig = j + 1
            break
    days = days[max(0, first_sig - (need - 1)):]
    if len(days) < need + 2:
        sys.exit(f"連續有價量的交易日不足（{len(days)} 日 < {need + 2}）；請再執行一次讓它繼續回補。")
    trades = run_backtest(days, px, min_volume=args.min_volume, cost_pct=args.cost)
    if not trades:
        sys.exit("沒有任何可計算的訊號。")
    sig_days = sorted({t["date"] for t in trades})
    meta = {"first": sig_days[0], "last": sig_days[-1], "signal_days": len(sig_days), "window": 60, "k": 2.0,
            "min_volume": args.min_volume, "min_ratio": 0.05, "cost": args.cost}
    p = write_report(summarize(trades), trades, meta, c.OUT)
    print(p.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
