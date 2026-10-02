#!/usr/bin/env python3
"""
籌碼力度（法人力度）每日選股
================================
依老墨「法人力度指標」公開說明頁的邏輯重建（原 XQ 腳本為加密檔，參數與判斷方式
以說明頁為準，細節可能與原版不完全相同）：

  1. 佔股本比  r_t = 法人當日買賣超股數 / 發行股數 × 100 (%)
  2. 標準化    z_t = (r_t − 過去 W 日 r 的平均) / 過去 W 日 r 的標準差
               （不含當日，避免當日極端值稀釋自己）
  3. 顯著買超  z_t ≥ 極端靈敏度 k，且 r_t > 0，且連續 confirm 天成立
     穩健模式另外要求 r_t ≥ 最低佔股本比（預設 0.05%）
  4. 另外附上 近期(快)/長期(慢) 均線，標出「買方轉強」（快線上穿慢線）

資料來源：臺灣證券交易所 T86（三大法人買賣超日報）、MI_QFIIS（發行股數）。
上櫃（櫃買中心）資料為選配，抓不到時自動略過。

用法：
  python chip_force.py                      # 預設：三大法人、W=60、k=2.0
  python chip_force.py --investor 投信       # 投本比
  python chip_force.py --window 120 --k 2.5 --confirm 2 --mode 穩健
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "data"
OUT = HERE / "output"
TZ = dt.timezone(dt.timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (chip-force screener)"}

INVESTORS = ("三大法人", "外資", "投信", "自營")


# ----------------------------------------------------------------- 抓資料
def _get_json(url: str, retries: int = 3) -> dict | None:
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            print(f"  ! {e} ({i + 1}/{retries})", file=sys.stderr)
            time.sleep(5 * (i + 1))
    return None


def _num(s) -> float:
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _col(fields: list[str], *keys: str) -> int | None:
    """依欄位名稱找索引（證交所欄位名常微調，用關鍵字比對較耐用）。"""
    for i, f in enumerate(fields):
        if all(k in f for k in keys):
            return i
    return None


def fetch_twse_day(d: dt.date) -> list[dict] | None:
    """回傳當日上市個股的法人買賣超 + 發行股數；非交易日回傳 []，失敗回傳 None。"""
    ds = d.strftime("%Y%m%d")
    t86 = _get_json(f"https://www.twse.com.tw/rwd/zh/fund/T86?date={ds}&selectType=ALLBUT0999&response=json")
    if t86 is None:
        return None
    if t86.get("stat") != "OK" or not t86.get("data"):
        return []  # 休市
    time.sleep(3)
    qf = _get_json(f"https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date={ds}&selectType=ALLBUT0999&response=json")
    shares: dict[str, float] = {}
    if qf and qf.get("stat") == "OK":
        f2 = qf.get("fields", [])
        ic, isz = _col(f2, "證券代號"), _col(f2, "發行股數")
        if ic is not None and isz is not None:
            for row in qf["data"]:
                shares[row[ic].strip()] = _num(row[isz])

    f = t86["fields"]
    ic, iname = _col(f, "證券代號"), _col(f, "證券名稱")
    i_fx = _col(f, "外陸資買賣超")            # 外陸資(不含外資自營商)
    i_fxd = _col(f, "外資自營商買賣超")
    i_it = _col(f, "投信買賣超")
    i_tot = _col(f, "三大法人買賣超")
    # 自營商買賣超合計：第一個「自營商買賣超」且不是(自行)/(避險)
    i_dl = next((i for i, x in enumerate(f) if x.startswith("自營商買賣超") and "(" not in x and "（" not in x), None)

    rows = []
    for row in t86["data"]:
        code = row[ic].strip()
        fx = _num(row[i_fx]) + (_num(row[i_fxd]) if i_fxd is not None else 0)
        rows.append({
            "code": code, "name": row[iname].strip(), "market": "上市",
            "外資": fx, "投信": _num(row[i_it]),
            "自營": _num(row[i_dl]) if i_dl is not None else 0.0,
            "三大法人": _num(row[i_tot]),
            "shares": shares.get(code, 0.0),
        })
    return rows


def fetch_tpex_day(d: dt.date) -> list[dict] | None:
    """上櫃（選配）。櫃買中心介面改版頻繁，失敗就回 None 並略過。"""
    url = ("https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW"
           f"&date={d:%Y/%m/%d}&response=json")
    js = _get_json(url, retries=2)
    if not js:
        return None
    tables = js.get("tables") or []
    if not tables or not tables[0].get("data"):
        return []
    t = tables[0]
    f = t.get("fields", [])
    ic, iname = _col(f, "代號"), _col(f, "名稱")
    i_fx = _col(f, "外資及陸資", "買賣超")
    i_it = _col(f, "投信", "買賣超")
    i_dl = _col(f, "自營商", "買賣超")
    i_tot = _col(f, "三大法人", "買賣超")
    if None in (ic, iname, i_tot):
        return None
    rows = []
    for row in t["data"]:
        rows.append({
            "code": str(row[ic]).strip(), "name": str(row[iname]).strip(), "market": "上櫃",
            "外資": _num(row[i_fx]) if i_fx is not None else 0.0,
            "投信": _num(row[i_it]) if i_it is not None else 0.0,
            "自營": _num(row[i_dl]) if i_dl is not None else 0.0,
            "三大法人": _num(row[i_tot]),
            "shares": 0.0,  # 由 openapi 補
        })
    return rows


_TPEX_SHARES: dict[str, float] | None = None


def tpex_shares() -> dict[str, float]:
    global _TPEX_SHARES
    if _TPEX_SHARES is None:
        _TPEX_SHARES = {}
        js = _get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O", retries=2)
        for r in js or []:
            code = str(r.get("SecuritiesCompanyCode") or r.get("公司代號") or "").strip()
            n = r.get("IssueShares") or r.get("已發行普通股數或TDR原股發行股數")
            if code and n:
                _TPEX_SHARES[code] = _num(n)
    return _TPEX_SHARES


# ----------------------------------------------------------------- 成交量（只抓篩選當日）
def fetch_twse_volume(d: dt.date) -> dict[str, float] | None:
    """上市個股當日成交張數；失敗回傳 None。"""
    js = _get_json(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={d:%Y%m%d}&type=ALLBUT0999&response=json")
    if not js or js.get("stat") != "OK":
        return None
    for t in js.get("tables") or []:
        f = t.get("fields") or []
        ic, iv = _col(f, "證券代號"), _col(f, "成交股數")
        if ic is not None and iv is not None and t.get("data"):
            return {str(r[ic]).strip(): _num(r[iv]) / 1000 for r in t["data"]}
    return None


def fetch_tpex_volume(d: dt.date) -> dict[str, float] | None:
    """上櫃個股當日成交張數；介面改版時回傳 None。"""
    js = _get_json(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={d:%Y/%m/%d}&id=&response=json", retries=2)
    for t in (js or {}).get("tables") or []:
        f = t.get("fields") or []
        ic, iv = _col(f, "代號"), _col(f, "成交股數")
        if ic is not None and iv is not None and t.get("data"):
            return {str(r[ic]).strip(): _num(r[iv]) / 1000 for r in t["data"]}
    return None


def load_volume(d: dt.date, include_otc: bool) -> tuple[dict[str, float], set[str]]:
    """回傳 (代號→成交張數, 取得成功的市場)。兩個市場都成功才寫入快取。"""
    p = CACHE / f"vol_{d:%Y%m%d}.csv"
    if p.exists():
        with p.open(encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
        return {r["code"]: float(r["lots"]) for r in rows}, {r["market"] for r in rows}
    vols: dict[str, float] = {}
    ok: set[str] = set()
    rows = []
    for market, fn in (("上市", fetch_twse_volume), ("上櫃", fetch_tpex_volume)):
        if market == "上櫃" and not include_otc:
            continue
        time.sleep(2)
        v = fn(d)
        if v is None:
            print(f"  ! {d} {market}成交量抓取失敗，該市場不套用成交張數門檻", file=sys.stderr)
            continue
        ok.add(market)
        vols.update(v)
        rows += [{"code": c, "market": market, "lots": n} for c, n in v.items()]
    if ok == ({"上市", "上櫃"} if include_otc else {"上市"}):
        CACHE.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["code", "market", "lots"])
            w.writeheader()
            w.writerows(rows)
    return vols, ok


# ----------------------------------------------------------------- 快取
FIELDS = ["code", "name", "market", "外資", "投信", "自營", "三大法人", "shares"]


def cache_path(d: dt.date) -> Path:
    return CACHE / f"{d:%Y%m%d}.csv"


def load_day(d: dt.date) -> list[dict] | None:
    p = cache_path(d)
    if not p.exists():
        return None
    with p.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        for k in ("外資", "投信", "自營", "三大法人", "shares"):
            r[k] = float(r[k])
    return rows


def save_day(d: dt.date, rows: list[dict]) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    with cache_path(d).open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def collect(n_days: int, end: dt.date, include_otc: bool, max_lookback: int = 600,
            deadline: float | None = None) -> list[tuple[dt.date, list[dict]]]:
    """由 end 往回收集 n_days 個交易日（有快取就用快取）。超過 deadline（time.time()）就不再抓新的日子。"""
    days: list[tuple[dt.date, list[dict]]] = []
    d = end
    for _ in range(max_lookback):
        if len(days) >= n_days:
            break
        if d.weekday() < 5:
            rows = load_day(d)
            if rows is None and deadline is not None and time.time() > deadline:
                print("  ! 已達時間預算，停止回補更早的資料", file=sys.stderr)
                break
            if rows is None:
                print(f"抓取 {d} ...", file=sys.stderr)
                rows = fetch_twse_day(d)
                time.sleep(3)  # 證交所限流：約每 5 秒 3 次
                if rows is None:
                    print(f"  ! {d} 上市資料抓取失敗，略過（下次重抓）", file=sys.stderr)
                    d -= dt.timedelta(days=1)
                    continue
                if rows and include_otc:
                    otc = fetch_tpex_day(d)
                    time.sleep(2)
                    if otc:
                        sh = tpex_shares()
                        for r in otc:
                            r["shares"] = sh.get(r["code"], 0.0)
                        rows += otc
                # 當日資料若還沒公布（今天且傍晚前）不要寫入空快取
                if rows or d < dt.datetime.now(TZ).date():
                    save_day(d, rows)
            if rows:
                days.append((d, rows))
        d -= dt.timedelta(days=1)
    return sorted(days, key=lambda x: x[0])


# ----------------------------------------------------------------- 計算
def mean_std(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    m = sum(xs) / n
    v = sum((x - m) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
    return m, math.sqrt(v)


def sma(xs: list[float], n: int) -> float | None:
    return sum(xs[-n:]) / n if len(xs) >= n else None


def is_common_stock(code: str) -> bool:
    # 4 碼數字 = 普通股；排除 ETF(00xx)、特別股、TDR 等
    return len(code) == 4 and code.isdigit() and not code.startswith("0")


def screen(days, investor: str, window: int, k: float, confirm: int,
           mode: str, min_ratio: float, fast: int, slow: int,
           volume: dict[str, float] | None = None, vol_markets: set[str] = frozenset(), min_volume: float = 0):
    dates = [d for d, _ in days]
    # 以最新一日的發行股數為準（股本變動時較貼近現況）；缺值時往前找
    series: dict[str, dict] = {}
    for idx, (_, rows) in enumerate(days):
        for r in rows:
            c = r["code"]
            if not is_common_stock(c):
                continue
            s = series.setdefault(c, {"name": r["name"], "market": r["market"],
                                      "net": [None] * len(days), "shares": 0.0})
            s["net"][idx] = r[investor]
            if r["shares"] > 0:
                s["shares"] = r["shares"]
            s["name"] = r["name"]

    last = len(days) - 1
    picks, strengthen = [], []
    for code, s in series.items():
        sh = s["shares"]
        if sh <= 0 or s["net"][last] is None:
            continue
        # 沒出現在當日名單 = 當日無法人交易 → 視為 0
        ratio = [((n or 0.0) / sh * 100.0) for n in s["net"]]
        if len(ratio) < window + confirm:
            continue

        zs = []
        for j in range(confirm):
            t = last - j
            hist = ratio[t - window:t]
            m, sd = mean_std(hist)
            zs.append((ratio[t] - m) / sd if sd > 0 else 0.0)
        z_today = zs[0]
        r_today = ratio[last]

        ok = all(z >= k for z in zs) and all(ratio[last - j] > 0 for j in range(confirm))
        if mode == "穩健":
            ok = ok and r_today >= min_ratio

        f_now, s_now = sma(ratio, fast), sma(ratio, slow)
        f_prev, s_prev = sma(ratio[:-1], fast), sma(ratio[:-1], slow)
        cross_up = None not in (f_now, s_now, f_prev, s_prev) and f_prev <= s_prev and f_now > s_now

        # 成交張數門檻：只對成交量資料取得成功的市場套用；當日沒成交視為 0
        lots = volume.get(code, 0.0) if volume is not None and s["market"] in vol_markets else None
        if min_volume > 0 and lots is not None and lots < min_volume:
            continue

        rec = {
            "代號": code, "名稱": s["name"], "市場": s["market"],
            "成交張數": round(lots) if lots is not None else "",
            "法人買賣超(張)": round(s["net"][last] / 1000),
            "佔股本比(%)": round(r_today, 4),
            "力度z": round(z_today, 2),
            f"近{window}日佔股本比均值(%)": round(mean_std(ratio[last - window:last])[0], 4),
            f"快線MA{fast}(%)": round(f_now, 4) if f_now is not None else "",
            f"慢線MA{slow}(%)": round(s_now, 4) if s_now is not None else "",
            "買方轉強": "✓" if cross_up else "",
        }
        if ok:
            picks.append(rec)
        elif cross_up and r_today > 0:
            strengthen.append(rec)

    picks.sort(key=lambda x: x["力度z"], reverse=True)
    strengthen.sort(key=lambda x: x["力度z"], reverse=True)
    return dates[last], picks, strengthen


# ----------------------------------------------------------------- 輸出
def write_outputs(date: dt.date, picks, strengthen, args) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    stem = f"{date:%Y%m%d}_{args.investor}"
    if picks:
        with (OUT / f"{stem}_顯著買超.csv").open("w", encoding="utf-8-sig", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(picks[0].keys()))
            w.writeheader()
            w.writerows(picks)

    def table(rows, limit):
        if not rows:
            return "_（無）_\n"
        cols = ["代號", "名稱", "市場", "成交張數", "法人買賣超(張)", "佔股本比(%)", "力度z", "買方轉強"]
        out = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
        for r in rows[:limit]:
            out += "| " + " | ".join(str(r[c]) for c in cols) + " |\n"
        if len(rows) > limit:
            out += f"\n…另有 {len(rows) - limit} 檔，見 CSV。\n"
        return out

    md = (
        f"# 籌碼力度選股 {date:%Y-%m-%d}\n\n"
        f"條件：{args.investor} × 佔股本比，標準化視窗 {args.window} 日，"
        f"極端靈敏度 k={args.k}，確認 {args.confirm} 天，{args.mode}模式"
        + (f"（佔股本比 ≥ {args.min_ratio}%）" if args.mode == "穩健" else "")
        + (f"，成交張數 ≥ {args.min_volume:g}" if args.min_volume > 0 else "") + "\n\n"
        f"## 顯著買超（{len(picks)} 檔，依力度 z 排序）\n\n{table(picks, args.top)}\n"
        f"## 買方轉強（快線上穿慢線、未達顯著門檻，{len(strengthen)} 檔）\n\n{table(strengthen, 20)}\n"
        "> 依公開法人買賣超資料之統計，非投資建議。\n"
    )
    p = OUT / f"{stem}.md"
    p.write_text(md, encoding="utf-8")
    (OUT / f"latest_{args.investor}.md").write_text(md, encoding="utf-8")
    return p


def main() -> None:
    ap = argparse.ArgumentParser(description="籌碼力度（法人力度）每日選股")
    ap.add_argument("--investor", choices=INVESTORS, default="三大法人")
    ap.add_argument("--window", type=int, choices=(20, 60, 120), default=60, help="極端值比較區間")
    ap.add_argument("--k", type=float, choices=(1.5, 2.0, 2.5), default=2.0, help="極端靈敏度")
    ap.add_argument("--confirm", type=int, choices=(1, 2, 3), default=1, help="訊號確認天數")
    ap.add_argument("--mode", choices=("靈敏", "穩健"), default="靈敏")
    ap.add_argument("--min-ratio", type=float, default=0.05, help="穩健模式的最低佔股本比(%%)")
    ap.add_argument("--min-volume", type=float, default=1000, help="最低成交張數（當日），0＝不篩")
    ap.add_argument("--fast", type=int, choices=(10, 20, 30), default=20)
    ap.add_argument("--slow", type=int, choices=(40, 60, 120), default=60)
    ap.add_argument("--date", help="YYYY-MM-DD，預設今天")
    ap.add_argument("--no-otc", action="store_true", help="不抓上櫃")
    ap.add_argument("--top", type=int, default=30)
    args = ap.parse_args()

    end = dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(TZ).date()
    need = max(args.window, args.slow) + args.confirm + 1
    days = collect(need, end, include_otc=not args.no_otc)
    if len(days) < need:
        sys.exit(f"交易日資料不足（{len(days)}/{need}），請稍後重試。")

    volume, vol_markets = None, set()
    if args.min_volume > 0:
        volume, vol_markets = load_volume(days[-1][0], include_otc=not args.no_otc)
    date, picks, strengthen = screen(days, args.investor, args.window, args.k, args.confirm,
                                     args.mode, args.min_ratio, args.fast, args.slow,
                                     volume, vol_markets, args.min_volume)
    p = write_outputs(date, picks, strengthen, args)
    print(p.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
