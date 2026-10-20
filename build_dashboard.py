#!/usr/bin/env python3
"""
由快取資料產生單檔視覺化頁面 output/dashboard.html（內含最近 10 個交易日、兩種法人的結果）。
只讀 data/ 的快取，不連網；每天排程跑完選股後執行。
參數須與 daily.yml 的選股參數一致（外資＝靈敏、投信＝穩健）。
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
MODES = {"外資": "靈敏", "投信": "穩健"}   # 2026-10-20 起由三大法人改成外資
# 展示版（/demo，不用登入）：用延遲的舊資料讓非會員看介面；付費會員才看得到最新的
DEMO_LAG = 20    # 至少延遲幾個交易日（約一個月）
DEMO_DAYS = 10   # 顯示幾個交易日（兩週，「本週統整」才看得出效果）
DEMO_LOCKED = 5  # 最近幾個交易日「上鎖」：只給檔數與產業分布，股票名單在頁面上模糊處理（真的名單不放進展示版）


_IND: dict[str, str] | None = None


def industry_of(code: str) -> str:
    """產業分類（證交所 ISIN 一覽表的產業別，快取在 data/industry.csv；只讀快取、不連網）。"""
    global _IND
    if _IND is None:
        import industry
        _IND = industry.load()
    return _IND.get(code, "")


_THEMES: dict[str, list[str]] | None = None


def themes_of(code: str) -> list[str]:
    """題材標籤（本站自己整理的，不是官方分類）：data/themes.csv，每行一個題材、代號用空白隔開；一檔可以有多個題材。"""
    global _THEMES
    if _THEMES is None:
        _THEMES = {}
        f = c.CACHE / "themes.csv"
        if f.exists():
            with f.open(encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    t = (r.get("theme") or "").strip()
                    for code_ in (r.get("codes") or "").split():
                        if t and t not in _THEMES.setdefault(code_, []):
                            _THEMES[code_].append(t)
    return _THEMES.get(code, [])


def row(r: dict, close: dict, prev: dict) -> dict:
    code = r["代號"]
    p, p0 = close.get(code), prev.get(code)
    return {"c": code, "n": r["名稱"], "m": r["市場"], "v": r["成交張數"], "net": r["法人買賣超(張)"],
            "r": r["佔股本比(%)"], "f": r["力度z"], "x": bool(r["買方轉強"]),
            # 收盤價與漲跌幅（和前一個交易日收盤比；除權息日會和官方漲跌不同）
            "p": p, "g": round((p / p0 - 1) * 100, 2) if p and p0 else None, "ind": industry_of(code),
            **({"th": themes_of(code)} if themes_of(code) else {})}


def load_close(ds: str) -> dict[str, float]:
    """只讀快取 px_YYYYMMDD.csv 的收盤價；沒有就回傳空的。"""
    f = c.CACHE / f"px_{ds}.csv"
    if not f.exists():
        return {}
    with f.open(encoding="utf-8") as fh:
        return {r["code"]: float(r["close"]) for r in csv.DictReader(fh) if float(r["close"] or 0) > 0}


def add_tags(out: dict) -> None:
    """標記：s＝連續上榜天數、w＝近 10 個交易日第一次上榜、b＝投信和外資同一天都上榜（只看顯著買超）。"""
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
        both = {r["c"] for r in e["投信"]["picks"]} & {r["c"] for r in e["外資"]["picks"]}
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


def build_series(out: dict, latest: dt.date) -> dict:
    """個股明細（點股票時才載入）：近 KEEP_DAYS 個交易日、曾上榜股票的法人買賣超、力度、收盤價。
    i／t＝外資／投信買賣超（張），fi／ft＝兩者的力度（i 沿用舊名，以前是三大法人），p＝收盤價；陣列和 d（日期）一一對應。"""
    w = PARAMS["window"]
    days = c.collect(KEEP_DAYS + w, latest, include_otc=True, deadline=time.time() - 1)
    codes = {r["c"] for e in out["dates"].values() for inv in e for lst in ("picks", "strong") for r in e[inv][lst]}
    n = len(days)
    net = {inv: {code: [0.0] * n for code in codes} for inv in MODES}
    shares: dict[str, float] = {}
    for i, (_, rows) in enumerate(days):
        for r in rows:
            code = r["code"]
            if code not in codes:
                continue
            for inv in MODES:
                net[inv][code][i] = r[inv] or 0.0
            if r["shares"] > 0:
                shares[code] = r["shares"]   # 和選股一樣用最新的發行股數
    keep = range(max(w, n - KEEP_DAYS), n)
    ds_keep = [days[i][0].strftime("%Y%m%d") for i in keep]
    closes = [load_close(ds) for ds in ds_keep]
    series = {}
    for code in sorted(codes):
        sh = shares.get(code)
        if not sh:
            continue
        item = {}
        for inv, (kn, kf) in {"外資": ("i", "fi"), "投信": ("t", "ft")}.items():
            ratio = [x / sh * 100.0 for x in net[inv][code]]
            fs = []
            for t in keep:
                m, sd = c.mean_std(ratio[t - w:t])
                fs.append(round((ratio[t] - m) / sd, 2) if sd > 0 else 0.0)
            item[kn] = [round(net[inv][code][t] / 1000) for t in keep]
            item[kf] = fs
        item["p"] = [cl.get(code) for cl in closes]
        series[code] = item
    return {"d": ds_keep, "s": series}


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
    last = max(out["dates"])
    ser = build_series(out, dt.date(int(last[:4]), int(last[4:6]), int(last[6:])))
    (c.OUT / "series.json").write_text(json.dumps(ser, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"series.json：{len(ser['s'])} 檔、{len(ser['d'])} 天")
    print(f"dashboard.html：{', '.join(out['dates'])}")
    build_demo(out, ser, html_tpl=(HERE / "dashboard_template.html").read_text(encoding="utf-8"))


def locked_summary(e: dict) -> dict:
    """上鎖的日子只留統計數字：檔數、連續上榜／新上榜／雙榜幾檔、前 5 大產業。不含任何代號、名稱、價格。"""
    picks = e["picks"]
    cnt: dict[str, int] = {}
    th: dict[str, int] = {}
    for r in picks:
        k = r.get("ind") or industry_of(r["c"]) or "其他"
        cnt[k] = cnt.get(k, 0) + 1
        for t in r.get("th") or themes_of(r["c"]):
            th[t] = th.get(t, 0) + 1
    return {"n": len(picks), "ns": len(e["strong"]), "hot": sum(1 for r in picks if r.get("s", 0) >= 2),
            "new": sum(1 for r in picks if r.get("w")), "both": sum(1 for r in picks if r.get("b")),
            "otc": sum(1 for r in picks if r["m"] == "上櫃"),
            "ind": sorted(cnt.items(), key=lambda x: -x[1])[:5], "th": sorted(th.items(), key=lambda x: -x[1])[:5]}


def build_demo(out: dict, ser: dict, html_tpl: str) -> None:
    """展示版：取 DEMO_LAG 個交易日以前的 DEMO_DAYS 天，個股明細也只到那一天。"""
    ds_all = sorted(out["dates"])
    # 結束日：至少 DEMO_LAG 個交易日以前，而且兩份清單都有內容的最近一天（第一眼不要看到空清單）
    j = len(ds_all) - 1 - DEMO_LAG
    while j >= DEMO_DAYS - 1 and not all(len(out["dates"][ds_all[j]][inv]["picks"]) >= 3 for inv in MODES):
        j -= 1
    keep = ds_all[max(0, j - DEMO_DAYS + 1):j + 1] if j >= 0 else []
    if len(keep) < DEMO_DAYS:
        print("資料天數不夠，略過展示版")
        return
    end = keep[-1]
    demo = {"params": out["params"], "dates": {d: out["dates"][d] for d in keep}, "demo": {"until": end, "join": "__JOIN_URL__"}}
    for d in ds_all[-DEMO_LOCKED:]:
        if d > end:
            demo["dates"][d] = {"locked": True, **{inv: locked_summary(out["dates"][d][inv]) for inv in MODES}}
    codes = {r["c"] for d in keep for e in [out["dates"][d]] for inv in MODES for lst in ("picks", "strong") for r in e[inv][lst]}
    n = ser["d"].index(end) + 1 if end in ser["d"] else 0
    dser = {"d": ser["d"][:n], "s": {k: {f: v[:n] for f, v in ser["s"][k].items()} for k in sorted(codes) if k in ser["s"]}}
    note = f"展示版：{end[:4]}-{end[4:6]}-{end[6:]} 以前的資料完整開放，最近的交易日只顯示檔數與產業；付費會員每個交易日 17:30 看到最新完整名單"
    html = html_tpl.replace("資料更新於 __UPDATED__（台北時間）", note)
    html = html.replace("__DATA__", json.dumps(demo, ensure_ascii=False, separators=(",", ":")))
    (c.OUT / "demo.html").write_text(html, encoding="utf-8")
    (c.OUT / "demo_series.json").write_text(json.dumps(dser, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    locked = sorted(d for d in demo["dates"] if d > end)
    print(f"demo.html：{keep[0]} ～ {end}，明細 {len(dser['s'])} 檔；上鎖 {', '.join(locked)}")


if __name__ == "__main__":
    main()
