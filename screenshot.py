#!/usr/bin/env python3
"""
把 output/dashboard.html 的上半部（日期、摘要、力度排行、散布圖）截成 PNG，方便貼到 Skool 課程。
每個法人各一張：
  output/screenshots/YYYYMMDD_投信.png、YYYYMMDD_外資.png（每天一份，只留最近 KEEP 天）
  output/screenshots/latest_投信.png、latest_外資.png（永遠是最新一天）
需要 playwright（pip install playwright && python -m playwright install chromium）。
本機若已有 Chromium，可用環境變數 CHROMIUM_EXECUTABLE 指定路徑。
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PAGE = HERE / "output" / "dashboard.html"
SHOTS = HERE / "output" / "screenshots"
KEEP = 30
# 頁面上「看哪個法人」按鈕的文字 → 檔名
INVESTORS = {"投信（投本比）": "投信", "外資": "外資"}


def latest_date(html: str) -> str:
    data = json.loads(re.search(r"const DATA = (.*?);\nconst P", html, re.S).group(1))
    return max(data["dates"])


def main() -> None:
    day = latest_date(PAGE.read_text(encoding="utf-8"))
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE") or None)
        page = browser.new_page(viewport={"width": 1100, "height": 1000}, device_scale_factor=2,
                                color_scheme="light")
        page.goto(PAGE.as_uri())
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(800)  # 等字型與圖表畫完
        for label, name in INVESTORS.items():
            # 按鈕會被藏起來，所以直接用程式點，不用滑鼠點
            page.evaluate("label => [...document.querySelectorAll('#invSeg button')]"
                          ".find(b => b.textContent.trim() === label).click()", label)
            page.wait_for_timeout(300)
            # 截圖用不到的按鈕先藏起來（標題下方已寫日期），並在圖底加上註記
            page.evaluate("""() => {
              document.querySelector('header .controls').style.display = 'none';
              let n = document.getElementById('shotNote');
              if (!n) {
                n = document.createElement('p'); n.id = 'shotNote';
                n.style.cssText = 'margin:0;font-size:13px;color:var(--ink-3)';
                n.textContent = '依證交所、櫃買中心公開法人買賣超資料統計，僅供研究參考，非投資建議。';
                document.querySelector('section.panels').after(n);
              }
            }""")
            box = page.locator("#shotNote").bounding_box()
            clip = {"x": 0, "y": 0, "width": 1100, "height": box["y"] + box["height"] + 20}
            for out in (SHOTS / f"{day}_{name}.png", SHOTS / f"latest_{name}.png"):
                page.screenshot(path=str(out), clip=clip, full_page=True)
            print(f"截圖：{day}_{name}.png")
        browser.close()

    # 只留最近 KEEP 天的每日截圖（latest_*.png 不刪）
    days = sorted({f.name[:8] for f in SHOTS.glob("2*_*.png")})
    for old in days[:-KEEP]:
        for f in SHOTS.glob(f"{old}_*.png"):
            f.unlink()


if __name__ == "__main__":
    main()
