#!/usr/bin/env bash
# 找出（沒有就建立）會員網站用的 KV namespace，印出它的 id。
# 需要環境變數 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID。
set -euo pipefail
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
