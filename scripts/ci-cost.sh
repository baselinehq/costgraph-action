#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

pull_request="$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:-/dev/null}")"
if [[ -z "$pull_request" ]]; then
  echo "::notice::Not a pull request event; the CI cost comment is posted only on pull requests."
  exit 0
fi
[[ "$pull_request" =~ ^[0-9]+$ ]] || fail "the event's pull request number is not a number"
[[ -n "${COSTGRAPH_API_KEY:-}" ]] || fail "api-key is empty. Store a CostGraph API key with the focus:read scope as the COSTGRAPH_API_KEY secret and pass it as api-key."
echo "::add-mask::$COSTGRAPH_API_KEY"
[[ -n "${COSTGRAPH_GITHUB_TOKEN:-}" ]] || fail "github-token is empty; the comment needs a token with pull-requests: write"
command -v costgraph >/dev/null || fail "the CostGraph CLI is not installed; run baselinehq/costgraph-action first"
costgraph cost ci comment github --help 2>/dev/null | grep -q -- '--pull-request' || fail "this CostGraph CLI release cannot post the CI cost comment; set cli-version to latest or a release newer than v0.7.0"

status=0
result="$(GITHUB_TOKEN="$COSTGRAPH_GITHUB_TOKEN" costgraph -o json cost ci comment github \
  --repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}" \
  --pull-request "$pull_request" \
  --behavior "${COMMENT_BEHAVIOR:-update}" \
  --github-api-url "${COSTGRAPH_GITHUB_API_URL:-${GITHUB_API_URL:-https://api.github.com}}")" || status=$?
if ((status != 0)); then
  message="$(jq -r '.error // empty' <<<"$result" 2>/dev/null)" || message=""
  fail "${message:-the CI cost comment could not be posted}"
fi
comment_url="$(jq -r '.url // empty' <<<"$result")"
echo "CI cost comment: $comment_url"
jq -r '"total-cost=\(.cost.total)", "comment-url=\(.url // "")"' <<<"$result" >>"${GITHUB_OUTPUT:-/dev/stdout}"
