#!/usr/bin/env python3
"""
上榜通知：每日頁面上傳後執行。會員追蹤的股票今天有上榜（任一法人的顯著買超或買方轉強），
就用 Web Push 推播到他開啟通知的裝置。

資料都在會員網站的 KV（用 Cloudflare API 讀寫）：
  wl:<email>    追蹤的股票 [{c, n, m}]
  push:<email>  推播訂閱 [{endpoint, keys}]；推播服務回 404/410（裝置取消了）就移除
  st:<email>    要是 active；vm:<email> 要是本月（和看頁面的條件一樣）
  vapid         推播金鑰（Worker 第一次有人開通知時產生）
  notified      上次通知的交易日，同一天不重複通知

用法：python notify.py               # 每日流程（需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、KV_ID）
      python notify.py --test EMAIL  # 對這個會員的裝置送一則測試通知
      python notify.py --dry-run     # 只印出會通知誰，不送出
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE / "output" / "dashboard.html"
TZ = dt.timezone(dt.timedelta(hours=8))
SITE = os.environ.get("SITE_URL", "https://chip-force-site.littleblacker29.workers.dev")
INVS = (("投信", "投信"), ("外資", "外資"))
MAX_LINES = 5


# ----------------------------------------------------------------- KV（Cloudflare API）
class KV:
    def __init__(self, account: str, token: str, ns: str):
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{ns}"
        self.h = {"Authorization": f"Bearer {token}"}

    def _req(self, method: str, path: str, data: bytes | None = None):
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=self.h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def get(self, key: str):
        raw = self._req("GET", "/values/" + urllib.parse.quote(key, safe=""))
        return None if raw is None else raw.decode("utf-8")

    def get_json(self, key: str, default):
        raw = self.get(key)
        try:
            return json.loads(raw) if raw else default
        except ValueError:
            return default

    def put(self, key: str, value: str) -> None:
        self._req("PUT", "/values/" + urllib.parse.quote(key, safe=""), value.encode("utf-8"))

    def keys(self, prefix: str) -> list[str]:
        out, cursor = [], ""
        while True:
            q = urllib.parse.urlencode({"prefix": prefix, "limit": 1000, **({"cursor": cursor} if cursor else {})})
            js = json.loads(self._req("GET", "/keys?" + q))
            out += [k["name"] for k in js.get("result", [])]
            cursor = (js.get("result_info") or {}).get("cursor") or ""
            if not cursor:
                return out


# ----------------------------------------------------------------- 今天的上榜
def latest_listing(page: Path = PAGE) -> tuple[str, dict[str, list[str]]]:
    """回傳 (日期, {代號: ["投信 顯著買超", ...]})。"""
    raw = page.read_text(encoding="utf-8")
    data = json.loads(re.search(r"const DATA = (.*?);\nconst P", raw, re.S).group(1))
    ds = max(data["dates"])
    hit: dict[str, list[str]] = {}
    for key, label in INVS:
        e = data["dates"][ds][key]
        for lst, word in (("picks", "顯著買超"), ("strong", "買方轉強")):
            for r in e[lst]:
                hit.setdefault(r["c"], []).append(f"{label} {word}")
    return ds, hit


def message(ds: str, items: list[dict], hit: dict[str, list[str]]) -> dict | None:
    got = [x for x in items if x["c"] in hit]
    if not got:
        return None
    lines = [f"{x['c']} {x.get('n', '')}：{'、'.join(hit[x['c']])}" for x in got[:MAX_LINES]]
    if len(got) > MAX_LINES:
        lines.append(f"…還有 {len(got) - MAX_LINES} 檔")
    return {"title": f"你追蹤的 {len(got)} 檔今天上榜（{int(ds[4:6])}/{int(ds[6:])}）", "body": "\n".join(lines),
            "url": "/", "tag": f"chip-{ds}"}


# ----------------------------------------------------------------- 推播
def send(subs: list[dict], payload: dict, vapid_d: str) -> tuple[list[dict], int]:
    """回傳 (還有效的訂閱, 成功送出數)。"""
    from pywebpush import WebPushException, webpush
    keep, ok = [], 0
    for s in subs:
        try:
            webpush(subscription_info={"endpoint": s["endpoint"], "keys": s["keys"]}, data=json.dumps(payload, ensure_ascii=False),
                    vapid_private_key=vapid_d, vapid_claims={"sub": SITE}, ttl=12 * 3600)
            keep.append(s); ok += 1
        except WebPushException as e:
            code = e.response.status_code if e.response is not None else None
            if code in (404, 410):
                print(f"  裝置已取消通知，移除（{code}）")
            else:
                print(f"  ! 推播失敗 {code}：{str(e)[:200]}", file=sys.stderr)
                keep.append(s)
    return keep, ok


def main() -> None:
    ap = argparse.ArgumentParser(description="追蹤股票上榜通知")
    ap.add_argument("--test", metavar="EMAIL", help="對這個會員的裝置送一則測試通知")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="今天已通知過也再送一次")
    args = ap.parse_args()
    env = {k: os.environ.get(k, "").strip() for k in ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "KV_ID")}
    if not all(env.values()):
        sys.exit("缺少 CLOUDFLARE_ACCOUNT_ID／CLOUDFLARE_API_TOKEN／KV_ID，略過通知")
    kv = KV(env["CLOUDFLARE_ACCOUNT_ID"], env["CLOUDFLARE_API_TOKEN"], env["KV_ID"])
    vapid = kv.get_json("vapid", None)
    if not vapid:
        print("還沒有人開啟通知（沒有推播金鑰），略過")
        return

    if args.test:
        email = args.test.strip().lower()
        subs = kv.get_json(f"push:{email}", [])
        print(f"{email}：{len(subs)} 台裝置")
        payload = {"title": "測試通知", "body": "收到這則就代表上榜通知設定成功 👍", "url": "/", "tag": "chip-test"}
        if subs and not args.dry_run:
            keep, ok = send(subs, payload, vapid["d"])
            if len(keep) != len(subs):
                kv.put(f"push:{email}", json.dumps(keep))
            print(f"送出 {ok} 則")
        return

    ds, hit = latest_listing()
    if kv.get("notified") == ds and not args.force:
        print(f"{ds} 已經通知過，略過")
        return
    month = dt.datetime.now(TZ).strftime("%Y%m")
    n_user = n_sent = 0
    for key in kv.keys("push:"):
        email = key.split(":", 1)[1]
        subs = kv.get_json(key, [])
        if not subs:
            continue
        if kv.get(f"st:{email}") != "active" or kv.get(f"vm:{email}") != month:
            continue   # 和看頁面的條件一樣：已開通、本月已驗證
        payload = message(ds, kv.get_json(f"wl:{email}", []), hit)
        if not payload:
            continue
        n_user += 1
        print(f"{email[:3]}***：{payload['title']}")
        if args.dry_run:
            continue
        keep, ok = send(subs, payload, vapid["d"])
        n_sent += ok
        if len(keep) != len(subs):
            kv.put(key, json.dumps(keep))
    if not args.dry_run:
        kv.put("notified", ds)
    print(f"{ds}：通知 {n_user} 位會員、送出 {n_sent} 則")


if __name__ == "__main__":
    main()
