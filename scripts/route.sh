#!/usr/bin/env bash
set -euo pipefail

default_label="${ROUTE_DEFAULT:?the default input is required}"
jobs='{}'
if [[ -n "${ROUTE_JOBS:-}" ]]; then
  jobs="$(jq -c 'if type == "object" and all(.[]; type == "string") then . else error("not a map") end' <<<"$ROUTE_JOBS" 2>/dev/null)" || {
    echo "::warning::The jobs input is not a JSON map of job name to runner label; routing only the default runner."
    jobs='{}'
  }
fi

finish() {
  local runner="$1" runners="$2" decision="${3:-}"
  {
    echo "runner=$runner"
    echo "runners=$runners"
    echo "decision-id=$decision"
  } >>"${GITHUB_OUTPUT:-/dev/stdout}"
}

use_default() {
  if [[ "${FAIL_ON_ERROR:-false}" == "true" ]]; then
    echo "::error::$1" >&2
    exit 1
  fi
  echo "::warning::$1 Jobs use their default runner."
  finish "$default_label" "$jobs"
  exit 0
}

trap 'use_default "CostGraph AutoPilot hit an unexpected error."' ERR

COSTGRAPH_API_KEY="${INPUT_API_KEY:-${COSTGRAPH_API_KEY:-}}"
if [[ -z "$COSTGRAPH_API_KEY" ]]; then
  echo "::notice::CostGraph AutoPilot is not signed in, so jobs use their default runner. Pull requests from forks are never signed in."
  finish "$default_label" "$jobs"
  exit 0
fi
echo "::add-mask::$COSTGRAPH_API_KEY"

event_path="${GITHUB_EVENT_PATH:-/dev/null}"
repository="${GITHUB_REPOSITORY:-}"
workflow_path="${GITHUB_WORKFLOW_REF:-}"
workflow_path="${workflow_path#"$repository/"}"
workflow_path="${workflow_path%%@*}"
providers="$(tr -s ', ' '\n' <<<"${ROUTE_PROVIDERS:-}" | jq -Rsc 'split("\n") | map(select(length > 0)) | if length == 0 then null else . end')"

limit_list() {
  local input="$1" value="$2" allowed="$3" aliases="$4" list
  list="$(tr -s ', ' '\n' <<<"$value" | jq -Rsc --argjson allowed "$allowed" --argjson aliases "$aliases" \
    'split("\n") | map(select(length > 0) | ascii_downcase | $aliases[.] // .) | unique
     | if length == 0 then null elif all(.[]; . as $v | $allowed | index($v)) then . else error("not allowed") end' 2>/dev/null)" || {
    echo "::warning::The $input input must list only: $(jq -r 'join(", ")' <<<"$allowed"). It is ignored." >&2
    list=null
  }
  echo "$list"
}

max_cores=null
if [[ -n "${ROUTE_MAX_CORES:-}" ]]; then
  if [[ "$ROUTE_MAX_CORES" =~ ^[1-9][0-9]{0,8}$ ]]; then
    max_cores="$ROUTE_MAX_CORES"
  else
    echo "::warning::The max-cores input must be a positive whole number. It is ignored."
  fi
fi

allow_gpu=null
case "${ROUTE_ALLOW_GPU:-}" in
  true | false) allow_gpu="$ROUTE_ALLOW_GPU" ;;
  '') ;;
  *) echo "::warning::The allow-gpu input must be true or false. It is ignored." ;;
esac

allowed_os="$(limit_list allowed-os "${ROUTE_ALLOWED_OS:-}" '["linux","macos","windows"]' '{}')"
allowed_arch="$(limit_list allowed-arch "${ROUTE_ALLOWED_ARCH:-}" '["x64","x86_64","arm64"]' '{"x64":"x86_64"}')"

request="$(jq -cn \
  --arg repository "$repository" \
  --arg workflow "${GITHUB_WORKFLOW:-}" \
  --arg workflow_path "$workflow_path" \
  --arg run_id "${GITHUB_RUN_ID:-0}" \
  --arg run_attempt "${GITHUB_RUN_ATTEMPT:-1}" \
  --arg route_job "${GITHUB_JOB:-}" \
  --arg runner_name "${RUNNER_NAME:-}" \
  --arg event "${GITHUB_EVENT_NAME:-}" \
  --arg default "$default_label" \
  --arg os "${ROUTE_OS:-}" \
  --arg arch "${ROUTE_ARCH:-}" \
  --arg cpu "${ROUTE_CPU:-}" \
  --arg ram "${ROUTE_RAM:-}" \
  --arg gpu "${ROUTE_GPU:-}" \
  --arg docker "${ROUTE_DOCKER:-false}" \
  --arg release "${ROUTE_RELEASE:-false}" \
  --arg secrets "${ROUTE_SECRETS:-true}" \
  --arg policy "${ROUTE_POLICY:-}" \
  --argjson providers "$providers" \
  --argjson max_cores "$max_cores" \
  --argjson allowed_os "$allowed_os" \
  --argjson allowed_arch "$allowed_arch" \
  --argjson allow_gpu "$allow_gpu" \
  --argjson jobs "$jobs" \
  --slurpfile payload <(jq -c '.' "$event_path" 2>/dev/null || echo '{}') \
  '{
    repository: $repository, workflow: $workflow, workflow_path: $workflow_path,
    run_id: ($run_id | tonumber), run_attempt: ($run_attempt | tonumber),
    route_job: $route_job, runner_name: $runner_name, event: $event,
    fork: (($payload[0].pull_request.head.repo.fork // false) and ($payload[0].pull_request.head.repo.full_name != $repository)),
    pull_request: ($payload[0].pull_request.number // null),
    default: $default, os: $os, arch: $arch,
    cpu: (($cpu | tonumber?) // 0), ram_gb: (($ram | tonumber?) // null), gpu: (($gpu | tonumber?) // 0),
    docker: ($docker == "true"), release: ($release == "true"), secrets: ($secrets != "false"),
    policy: $policy, providers: $providers, jobs: $jobs,
    max_cores: $max_cores, allowed_os: $allowed_os, allowed_arch: $allowed_arch, allow_gpu: $allow_gpu
  }')" || request=""
[[ -n "$request" ]] || use_default "Could not build the CostGraph AutoPilot request."

api_url="${COSTGRAPH_API_URL:-https://api.costgraph.ai}"
response="$(curl -sS --max-time 3 -X POST "${api_url%/}/api/v1/tenant/ci/route" \
  -H "X-API-Key: $COSTGRAPH_API_KEY" -H 'Content-Type: application/json' \
  -d "$request" -w '\n%{http_code}' 2>/dev/null)" || use_default "CostGraph AutoPilot did not answer in time."
status="${response##*$'\n'}"
body="${response%$'\n'*}"
[[ "$status" == "200" ]] || use_default "CostGraph AutoPilot answered $status: $(jq -r '.message // "no message"' <<<"$body" 2>/dev/null)."

runner="$(jq -er '.data.runner | select(type == "string" and length > 0)' <<<"$body" 2>/dev/null)" || use_default "CostGraph AutoPilot sent an answer this action cannot read."
runners="$(jq -c '.data.jobs | map_values(.runner)' <<<"$body")"
[[ "$jobs" != '{}' ]] || runners='{}'
decision="$(jq -r '.data.decision_id // ""' <<<"$body")"

jq -r '.data.jobs | to_entries[] | "\(.key): \(.value.runner) (\(.value.reason))"' <<<"$body"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### CostGraph AutoPilot for CI"
    echo
    echo "| Job | Runner | Why |"
    echo "| --- | --- | --- |"
    jq -r '.data.jobs | to_entries[] | "| \(.key) | \(.value.runner) | \(.value.reason) |"' <<<"$body"
  } >>"$GITHUB_STEP_SUMMARY"
fi
finish "$runner" "$runners" "$decision"
