#!/usr/bin/env bash

billing_url="https://app.costgraph.ai/settings/account/billing"

require_billing() {
  local api_url="${COSTGRAPH_API_URL:-https://api.costgraph.ai}" status
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -H "X-API-Key: $COSTGRAPH_API_KEY" \
    "${api_url%/}/api/v1/tenant/pricing/compute" 2>/dev/null)" || return 0
  [[ "$status" == "402" ]] || return 0
  echo "billing-required=true" >>"${GITHUB_OUTPUT:-/dev/stdout}"
  echo "::error::Set up billing in CostGraph to see $1: $billing_url" >&2
  exit 0
}
