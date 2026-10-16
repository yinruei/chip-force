#!/usr/bin/env python3
"""印出選股頁 HTML 裡最新一天的日期（YYYYMMDD）；讀不到就印空字串。給 upload.sh 比對新舊用。"""
import re
import sys


def latest(path: str) -> str:
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return ""
    m = re.search(r"const DATA = (.*?);\nconst P", text, re.S)
    dates = re.findall(r'"(\d{8})":\{"', m.group(1)) if m else []
    return max(dates) if dates else ""


print(latest(sys.argv[1]))
