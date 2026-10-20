#!/usr/bin/env python3
"""
每天盤後的「產業觀察圖」（給 Threads／IG／Facebook 用，1080×1350 直式）。
只顯示「法人異常買超集中在哪些產業」與檔數，不出現任何個股名稱或代號。
資料：output/dashboard.html 裡最新一天的顯著買超清單 ＋ data/industry.csv 的產業分類。
輸出：output/social/YYYYMMDD_產業觀察.png、output/social/latest_產業觀察.png（只留最近 KEEP 天）
需要 playwright；本機可用 CHROMIUM_EXECUTABLE 指定 Chromium。
"""
from __future__ import annotations

import collections
import datetime as dt
import html
import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

import industry

HERE = Path(__file__).resolve().parent
PAGE = HERE / "output" / "dashboard.html"
OUT = HERE / "output" / "social"
KEEP = 30
TOP = 5
WD = "一二三四五六日"
INVESTORS = [("投信", "投信"), ("外資", "外資")]


def latest_day() -> tuple[str, dict]:
    raw = PAGE.read_text(encoding="utf-8")
    data = json.loads(re.search(r"const DATA = (.*?);\nconst P", raw, re.S).group(1))
    ds = max(data["dates"])
    return ds, data["dates"][ds]


def by_industry(picks: list[dict], ind: dict[str, str]) -> list[tuple[str, int]]:
    cnt = collections.Counter(ind.get(r["c"], "其他") for r in picks)
    return cnt.most_common()


def section(title: str, rows: list[tuple[str, int]], total: int) -> str:
    if not rows:
        return f'<section><h2>{title}</h2><p class="empty">今天沒有異常買超</p></section>'
    top = rows[:TOP]
    rest = sum(n for _, n in rows[TOP:])
    mx = max(n for _, n in top)
    bars = "".join(
        f'<div class="bar"><div class="nm">{html.escape(name)}</div><div class="tr"><div class="fl" style="width:{n / mx * 100:.1f}%"></div></div><div class="v">{n}</div></div>'
        for name, n in top)
    more = f'<p class="more">其他 {len(rows) - TOP} 個產業共 {rest} 檔</p>' if rest else ""
    return f'<section><h2>{title}<span>共 {total} 檔</span></h2>{bars}{more}</section>'


CSS = """
*{box-sizing:border-box;margin:0}
body{width:1080px;height:1350px;background:linear-gradient(160deg,#071330 0%,#0b2560 55%,#123d9e 100%);color:#f3f6fb;
 font-family:"Noto Sans CJK TC","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;padding:64px 76px 56px;display:flex;flex-direction:column}
.kicker{font-size:30px;letter-spacing:.12em;color:#9cc0ff}
h1{font-size:58px;font-weight:700;margin-top:10px;line-height:1.2}
.date{font-size:32px;color:#c9d6ee;margin-top:14px}
.lead{font-size:30px;line-height:1.55;margin-top:28px;color:#e7eefb;background:rgb(255 255 255 / .07);border-radius:18px;padding:22px 28px}
.lead b{color:#ffffff}
section{margin-top:34px}
h2{font-size:36px;font-weight:700;display:flex;align-items:baseline;gap:18px;margin-bottom:18px}
h2 span{font-size:26px;font-weight:400;color:#9fb4d8}
.bar{display:grid;grid-template-columns:270px 1fr 70px;align-items:center;gap:18px;height:48px}
.nm{font-size:29px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr{height:24px;background:rgb(255 255 255 / .10);border-radius:0 8px 8px 0;position:relative}
.fl{position:absolute;inset:0 auto 0 0;background:#7fb2ff;border-radius:0 8px 8px 0}
.v{font-size:30px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
.more,.empty{font-size:24px;color:#9fb4d8;margin-top:8px}
footer{margin-top:auto;padding-top:16px;font-size:23px;color:#9fb4d8;line-height:1.6;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
footer b{color:#e7eefb;font-size:27px}
"""


def build_html(ds: str, entry: dict, ind: dict[str, str]) -> str:
    d = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:]))
    secs, tops = [], []
    for key, label in INVESTORS:
        picks = entry[key]["picks"]
        rows = by_industry(picks, ind)
        secs.append(section(label, rows, len(picks)))
        if rows:
            n0 = rows[0][1]
            leaders = [name for name, n in rows if n == n0][:2]
            tops.append(f"{label}最集中在<b>{'、'.join(leaders)}</b>（{n0} 檔）")
    lead = "；".join(tops) + "。" if tops else "今天法人沒有明顯異常的買超。"
    return f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>{CSS}</style></head><body>
<div class="kicker">盤後產業觀察</div>
<h1>法人異常買超<br>集中在哪些產業？</h1>
<div class="date">{d.year}/{d.month}/{d.day}（{WD[d.weekday()]}）收盤後・上市櫃普通股</div>
<div class="lead">{lead}</div>
{''.join(secs)}
<footer><div>數字是各產業「法人買超明顯異常」的股票檔數<br>依證交所、櫃買中心公開資料統計，僅供研究參考，非投資建議</div><div style="text-align:right"><b>佛系交易俱樂部</b><br>籌碼力度選股</div></footer>
</body></html>"""


def main() -> None:
    ds, entry = latest_day()
    ind = industry.load(refresh=True)
    if not ind:
        print("沒有產業分類資料，略過產業觀察圖")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    page_html = build_html(ds, entry, ind)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE") or None)
        pg = b.new_page(viewport={"width": 1080, "height": 1350})
        pg.set_content(page_html)
        pg.wait_for_timeout(300)
        for out in (OUT / f"{ds}_產業觀察.png", OUT / "latest_產業觀察.png"):
            pg.screenshot(path=str(out))
        b.close()
    print(f"產業觀察圖：{ds}")
    days = sorted({f.name[:8] for f in OUT.glob("2*_產業觀察.png")})
    for old in days[:-KEEP]:
        (OUT / f"{old}_產業觀察.png").unlink()


if __name__ == "__main__":
    main()
