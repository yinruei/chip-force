#!/usr/bin/env bash
# 把 output/dashboard.html 上傳到會員網站的 KV（key: dashboard）。
set -euo pipefail
# 去掉貼上 secret 時常多出來的空白、換行
CLOUDFLARE_ACCOUNT_ID=$(printf %s "${CLOUDFLARE_ACCOUNT_ID:-}" | tr -d '[:space:]')
CLOUDFLARE_API_TOKEN=$(printf %s "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
cd "$(dirname "$0")/.."
ID=$(bash site/kv_id.sh)
# 防呆：網站上已經是比較新的資料就不覆蓋（例如部署網站時，repo 裡還沒有今天的資料）
LIVE=$(mktemp)
curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ID}/values/dashboard" -o "$LIVE" || : > "$LIVE"
LIVE_DATE=$(python3 site/page_date.py "$LIVE"); NEW_DATE=$(python3 site/page_date.py output/dashboard.html)
rm -f "$LIVE"
echo "網站上的資料：${LIVE_DATE:-（沒有）}；這次要上傳：${NEW_DATE:-（沒有）}"
if [ -z "$NEW_DATE" ] || { [ -n "$LIVE_DATE" ] && [ "$NEW_DATE" \< "$LIVE_DATE" ]; }; then
  echo "這次的頁面比網站上的舊，不上傳"
  exit 0
fi
curl -fsS -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: text/html; charset=utf-8" \
  --data-binary @output/dashboard.html \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ID}/values/dashboard" > /dev/null
echo "已上傳 dashboard.html 到會員網站"
# 個股明細（點股票時才載入）
if [ -f output/series.json ]; then
  curl -fsS -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
    --data-binary @output/series.json \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ID}/values/series" > /dev/null
  echo "已上傳 series.json 到會員網站"
fi
