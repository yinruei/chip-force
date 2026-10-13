#!/usr/bin/env bash
# 找出（沒有就建立）會員網站用的 KV namespace，印出它的 id。
# 需要環境變數 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID。
set -euo pipefail
# 去掉貼上 secret 時常多出來的空白、換行
CLOUDFLARE_ACCOUNT_ID=$(printf %s "${CLOUDFLARE_ACCOUNT_ID:-}" | tr -d '[:space:]')
CLOUDFLARE_API_TOKEN=$(printf %s "${CLOUDFLARE_API_TOKEN:-}" | tr -d '[:space:]')
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN
TITLE="chip-force-site"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces"
AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
id=$(curl -fsS -H "$AUTH" "${API}?per_page=100" \
  | python3 -c "import json,sys; print(next((n['id'] for n in json.load(sys.stdin)['result'] if n['title']=='${TITLE}'), ''))")
if [ -z "$id" ]; then
  id=$(curl -fsS -X POST -H "$AUTH" -H "Content-Type: application/json" -d "{\"title\":\"${TITLE}\"}" "$API" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])")
fi
echo "$id"
