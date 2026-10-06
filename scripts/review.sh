#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

trimmed() {
  [[ "$1" =~ ^[[:space:]]*(.*[^[:space:]])[[:space:]]*$ ]] && printf '%s' "${BASH_REMATCH[1]}"
}

[[ -n "${COSTGRAPH_API_KEY:-}" ]] || fail "api-key is empty. Store a CostGraph API key as the COSTGRAPH_API_KEY secret and pass it as api-key."
echo "::add-mask::$COSTGRAPH_API_KEY"
command -v costgraph >/dev/null || fail "the CostGraph CLI is not installed; run baselinehq/costgraph-action first"

hyperscaler_plan='any(.resource_changes[]?; (.provider_name // "") | test("/hashicorp/(aws|azurerm|google|google-beta)$"))'
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/costgraph-review.XXXXXX")"
estimates=()
breakdown_flags=()
[[ "${ALTERNATIVES:-true}" == "true" ]] || breakdown_flags+=(--no-alternatives)
while IFS= read -r line || [[ -n "$line" ]]; do
  arg="$(trimmed "$line")" && breakdown_flags+=("$arg")
done <<<"${EXTRA_ARGS:-}"
SUMMARY_FORMAT="${SUMMARY_FORMAT:-github-comment}"
case "$SUMMARY_FORMAT" in
  github-comment | table) ;;
  *) fail "summary-format must be github-comment or table, got ${SUMMARY_FORMAT}" ;;
esac
infracost_ready=false
plans=0
plans_args=()
output_help="$(costgraph cost output --help 2>&1 || true)"
plan_flag_supported=false
[[ "$output_help" == *--plan* ]] && plan_flag_supported=true

while IFS= read -r line || [[ -n "$line" ]]; do
  plan="$(trimmed "$line")" || continue
  plans=$((plans + 1))
  [[ -f "$plan" ]] || fail "plan $plan was not found in $(pwd). plan-path is relative to working-directory."
  jq -e 'has("format_version")' "$plan" >/dev/null 2>&1 || fail "$plan is not a Terraform plan in JSON. Create it with: terraform show -json tfplan > plan.json"

  [[ "$plan_flag_supported" == false ]] || plans_args+=(--plan "$plan")

  echo "::group::Estimating $plan"
  if jq -e "$hyperscaler_plan" "$plan" >/dev/null; then
    if [[ "${RUN_INFRACOST:-true}" == "true" ]]; then
      command -v infracost >/dev/null || fail "$plan has AWS, Azure or Google Cloud resources and Infracost is not installed"
      if [[ "$infracost_ready" == false ]]; then
        infracost_env="$(costgraph cost setup-infracost)"
        eval "$infracost_env"
        export INFRACOST_SKIP_UPDATE_CHECK=true
        infracost_ready=true
      fi
      infracost breakdown --path "$plan" --format json --out-file "$work/infracost-$plans.json"
      estimates+=(--path "$work/infracost-$plans.json")
    else
      echo "::warning::$plan has AWS, Azure or Google Cloud resources and infracost is false, so they are left out of the estimate"
    fi
  fi
  costgraph cost breakdown --path "$plan" --format infracost-json --out-file "$work/costgraph-$plans.json" ${breakdown_flags[@]+"${breakdown_flags[@]}"}
  estimates+=(--path "$work/costgraph-$plans.json")
  echo "::endgroup::"
done <<<"${PLAN_PATHS:-}"

((plans > 0)) || fail "plan-path is empty. Pass the terraform show -json output for each plan."

costgraph cost output "${estimates[@]}" ${plans_args[@]+"${plans_args[@]}"} --format json --out-file "$work/estimate.json"
estimate_path="${OUTPUT_PATH:-${RUNNER_TEMP:-/tmp}/costgraph-estimate.json}"
mkdir -p "$(dirname "$estimate_path")"
cp "$work/estimate.json" "$estimate_path"
echo "estimate-path=$(cd "$(dirname "$estimate_path")" && pwd)/$(basename "$estimate_path")" >>"${GITHUB_OUTPUT:-/dev/stdout}"
if [[ "$SUMMARY_FORMAT" == table ]]; then
  {
    echo '## Cost estimate'
    echo '```text'
    costgraph cost output --path "$work/estimate.json" --format table
    echo '```'
  } >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
else
  costgraph cost output --path "$work/estimate.json" --format github-comment >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
fi
printf '\nHow CostGraph prices Terraform: https://docs.costgraph.ai/costgraph/integrations/infracost\n' >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
jq -r '
  all(.projects[]; .pastBreakdown != null) as $every_project_has_previous
  | "total-monthly-cost=\(.totalMonthlyCost // "")",
    "previous-monthly-cost=\(if $every_project_has_previous then .pastTotalMonthlyCost // "" else "" end)",
    "diff-monthly-cost=\(if $every_project_has_previous then .diffTotalMonthlyCost // "" else "" end)"
' "$work/estimate.json" >>"${GITHUB_OUTPUT:-/dev/stdout}"

comment_url=""
pull_request="$(jq -r '.pull_request.number // empty' "${GITHUB_EVENT_PATH:-/dev/null}")"
if [[ "${POST_COMMENT:-true}" != "true" ]]; then
  echo "Commenting is off; the estimate is in the job summary."
elif [[ -z "$pull_request" ]]; then
  echo "::notice::Not a pull request event; the estimate is in the job summary."
else
  [[ -n "${COSTGRAPH_GITHUB_TOKEN:-}" ]] || fail "github-token is empty; the comment needs a token with pull-requests: write"
  comment_url="$(GITHUB_TOKEN="$COSTGRAPH_GITHUB_TOKEN" costgraph -o json cost comment github --path "$work/estimate.json" \
    --repo "$GITHUB_REPOSITORY" \
    --pull-request "$pull_request" \
    --behavior "${COMMENT_BEHAVIOR:-update}" \
    --github-api-url "${COSTGRAPH_GITHUB_API_URL:-${GITHUB_API_URL:-https://api.github.com}}" | jq -r '.url // empty')"
  echo "Cost comment: $comment_url"
fi
echo "comment-url=$comment_url" >>"${GITHUB_OUTPUT:-/dev/stdout}"
