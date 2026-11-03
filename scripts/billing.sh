#!/usr/bin/env bash

billing_required() {
  local api_url="${COSTGRAPH_API_URL:-https://api.costgraph.ai}" status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "X-API-Key: $COSTGRAPH_API_KEY" \
    "${api_url%/}/api/v1/tenant/pricing/compute" 2>/dev/null)" || return 1
  [[ "$status" == "402" ]]
}
