#!/usr/bin/env bash
# 把 output/dashboard.html 上傳到會員網站的 KV（key: dashboard）。
set -euo pipefail
# 去掉貼上 secret 時常多出來的空白、換行
CLOUDFLARE_ACCOUNT_ID=$(printf %s "${CLOUDFLARE_ACCOUNT_ID:-}" | tr -d '[:space:]')
CLOUDFLARE_API_TOKEN=$(printf %s "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
cd "$(dirname "$0")/.."
ID=$(bash site/kv_id.sh)
curl -fsS -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: text/html; charset=utf-8" \
  --data-binary @output/dashboard.html \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ID}/values/dashboard" > /dev/null
echo "已上傳 dashboard.html 到會員網站"
