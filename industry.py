#!/usr/bin/env python3
"""
上市櫃普通股的產業分類（給產業觀察圖用）。
來源：證交所「本國上市／上櫃證券國際證券辨識號碼一覽表」（Big5 網頁）
  https://isin.twse.com.tw/isin/C_public.jsp?strMode=2（上市）、strMode=4（上櫃）
快取在 data/industry.csv（code, industry, updated），超過 7 天才重抓；抓不到就沿用舊的快取。
用法：python industry.py   # 需要時更新快取
"""
from __future__ import annotations

import csv
import datetime as dt
import html
import os
import re
import sys
import urllib.request

import chip_force as c

PATH = c.CACHE / "industry.csv"
URLS = {"上市": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=2",
        "上櫃": "https://isin.twse.com.tw/isin/C_public.jsp?strMode=4"}
MAX_AGE_DAYS = 7


def parse(page: str) -> dict[str, str]:
    """表格每列：代號＋全形空白＋名稱 | ISIN | 上市日 | 市場別 | 產業別 | CFICode | 備註。只留普通股。"""
    out = {}
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S | re.I):
        tds = [html.unescape(re.sub(r"<[^>]+>", "", td)).strip()
               for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S | re.I)]
        if len(tds) < 5:
            continue
        m = re.match(r"^(\d{4})[\s　]", tds[0])
        if m and c.is_common_stock(m.group(1)) and tds[4]:
            out[m.group(1)] = tds[4]
    return out


def fetch() -> dict[str, str]:
    out: dict[str, str] = {}
    for market, url in URLS.items():
        try:
            req = urllib.request.Request(url, headers=c.UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                page = r.read().decode("cp950", "replace")
            got = parse(page)
            print(f"產業分類：{market} {len(got)} 檔")
            out.update(got)
        except Exception as e:  # noqa: BLE001
            print(f"  ! 產業分類抓取失敗（{market}）：{e}", file=sys.stderr)
    return out


def _read(path) -> tuple[dict[str, str], str]:
    with open(path, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    return {r["code"]: r["industry"] for r in rows}, (rows[0]["updated"] if rows else "")


def load(refresh: bool = False) -> dict[str, str]:
    """回傳 {代號: 產業}。refresh=True 時，快取超過 7 天就重抓。環境變數 INDUSTRY_FILE 可改用別的檔案（測試用）。"""
    path = os.environ.get("INDUSTRY_FILE") or PATH
    have, updated = _read(path) if os.path.exists(path) else ({}, "")
    today = dt.datetime.now(c.TZ).date()
    stale = not updated or (today - dt.date.fromisoformat(updated)).days >= MAX_AGE_DAYS
    if refresh and stale and not os.environ.get("INDUSTRY_FILE"):
        got = fetch()
        if len(got) > 1000:   # 太少代表網頁改版或沒抓完整，沿用舊的
            c.CACHE.mkdir(parents=True, exist_ok=True)
            with open(PATH, "w", encoding="utf-8", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["code", "industry", "updated"])
                for code in sorted(got):
                    w.writerow([code, got[code], today.isoformat()])
            return got
    return have


if __name__ == "__main__":
    print(f"產業分類共 {len(load(refresh=True))} 檔")
