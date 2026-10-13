#!/usr/bin/env bash
# 把 output/dashboard.html 上傳到會員網站的 KV（key: dashboard）。
set -euo pipefail
cd "$(dirname "$0")/.."
ID=$(bash site/kv_id.sh)
curl -fsS -X PUT -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: text/html; charset=utf-8" \
  --data-binary @output/dashboard.html \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${ID}/values/dashboard" > /dev/null
echo "已上傳 dashboard.html 到會員網站"
