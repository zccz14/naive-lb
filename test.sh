#!/usr/bin/env bash
# 逐条验证 naive-lb 的四条路径。需要 BASE 与 GATEWAY_TOKEN。
set -euo pipefail
BASE=${BASE:?set BASE, e.g. https://naive-lb.zccz14.workers.dev}
GATEWAY_TOKEN=${GATEWAY_TOKEN:?set GATEWAY_TOKEN}
auth=(-H "Authorization: Bearer $GATEWAY_TOKEN" -H 'content-type: application/json')

echo '1) health';        curl -sS "$BASE/health"; echo
echo '2) models';        curl -sS "${auth[@]}" "$BASE/v1/models"; echo
echo '3) no token → 401'; curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/v1/models"
echo '4) /v1/requests → 404 且无 request_not_found'
curl -sS -w ' %{http_code}\n' "${auth[@]}" "$BASE/v1/requests/probe"
echo '5) responses 流式（事件序列）'
curl -sS -N "${auth[@]}" "$BASE/v1/responses" -d '{"model":"naive-n0.5-lite","input":"say ok","stream":true}' \
  | grep -o '^event: .*' | uniq -c
echo '6) responses 非流式'
curl -sS "${auth[@]}" "$BASE/v1/responses" -d '{"model":"naive-n0.5-lite","input":"say ok","stream":false}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["status"],[i["type"] for i in d["output"]],d["usage"])'
