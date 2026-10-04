# CostGraph PR pricing review

A dependency-free GitHub Action that reviews a Terraform plan, estimates the
monthly EC2 cost change, and suggests cheaper instances in one updating PR comment.
It calls CostGraph's pricing API directly.

## Add it to your Terraform PR workflow

Generate a saved plan in your existing authenticated Terraform job, then run:

```yaml
permissions:
  contents: read
  pull-requests: write

# Under the existing job's steps, after terraform init and cloud authentication:
steps:
  - name: Plan
    run: |
      terraform plan -input=false -out=tfplan
      terraform show -json tfplan > tfplan.json

  - name: Review cost impact
    uses: s1ntaxe770r/costgraph-pricing-action@<COMMIT_SHA>
    with:
      api-key: ${{ secrets.COSTGRAPH_API_KEY }}
      plan-path: tfplan.json
      aws-region: us-east-1
```

Replace `<COMMIT_SHA>` with a reviewed commit or release of this repository.
To supply your key, open your consuming GitHub repository's **Settings → Secrets
and variables → Actions → New repository secret**, name it `COSTGRAPH_API_KEY`,
and paste a CostGraph API key. The action reads it through `api-key` and sends it
as the `X-API-Key` request header. Never put a real key in workflow YAML.

Create the key in CostGraph's account settings at
https://app.costgraph.ai/settings/account/api-keys. This action needs pricing
access, not cloud provider credentials. Generating a real infrastructure plan
may separately need your cloud credentials.

The plan file path is relative to the workspace, not a prior step's working
directory. For a plan generated in `infra/`, use `infra/tfplan.json`.

Use a normal `pull_request` workflow for trusted branches. Fork PRs do not receive
the CostGraph secret or a write-capable token; skip the privileged review job for
forks and Dependabot:

```yaml
jobs:
  terraform:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]'
    # Your existing plan job and the steps above go here.
```

Do not run untrusted PR Terraform under `pull_request_target` with secrets.
Terraform plans can contain sensitive values; the action sends only instance
pricing fields to CostGraph, and never publishes the plan JSON.

Use workflow concurrency to avoid an older run overwriting a newer review:

```yaml
concurrency:
  group: costgraph-${{ github.event.pull_request.number }}-infra
  cancel-in-progress: true
```

## Compare branches without deploying infrastructure

Optionally pass `base-plan-path` alongside `plan-path`. Generate both plans using
`terraform plan -out=...` and `terraform show -json`: one at the base commit and
one at the PR commit, with matching variables and provider settings. The action
compares the planned instance inventories by resource address. That makes the
estimate meaningful even for an undeployed demo where both plans would otherwise
show every instance as a creation. Unknown values still remain unpriced.

```yaml
with:
  api-key: ${{ secrets.COSTGRAPH_API_KEY }}
  base-plan-path: base/tfplan.json
  plan-path: proposed/tfplan.json
  aws-region: us-east-1
```

A runnable example lives at
[s1ntaxe770r/costgraph-pricing-demo](https://github.com/s1ntaxe770r/costgraph-pricing-demo).

## Coverage

- Standalone `aws_instance` resources: creates, deletes, updates, replacements,
  module instances, and expanded `count` / `for_each` resources.
- Both sides are priced at the current catalog rate. This is a projected
  steady-state compute delta for changed resources, not your historical bill or
  the total cost of the deployment. Unchanged resources are excluded.
- Region comes from the resource's `region`, ARN, or availability zone, then the
  explicit `aws-region` fallback. Set the fallback to the actual deployment region.
  For mixed-region plans, each resource must have a known region/zone; do not use
  one fallback to guess unresolved provider aliases.
- OS defaults to Linux because an AMI ID alone does not establish OS/licensing.
  Set `operating-system` to the catalog value for other OSes. Mixed-OS plans should
  be split into separate reviews. Windows licensing, paid AMIs, and discounts are
  not inferred.
- On-demand and spot compute. Spot requires a known availability zone.
- Dedicated hosts/tenancy, ASGs, launch templates, managed node groups, other
  providers, disks, networking, reservations, and Savings Plans are outside v1.
  Unsupported changed resources and unpriced instances are explicitly listed.
- A missing price is **unavailable**, never zero. Totals include only changes with
  both sides priced (creation/deletion has an explicit zero on its absent side).
- Terraform plans marked incomplete/deferred are flagged. Targeted plans only
  cover the resources present in that plan. At most 100 changed EC2 instances are
  reviewed per run; additional changes are marked skipped.

## Cheaper candidates

The action calls `POST /pricing/compute` for before/after prices, then
`POST /recommendations/compute` for proposed instances. API authentication uses
`X-API-Key`. Recommendation requests use the full catalog CPU/RAM capacity, since
a PR does not contain workload utilization.

Suggestions retain provider, region, OS, purchase type, architecture, and at least
the same CPU/RAM. Spot candidates also retain the availability zone. GPU instances,
custom CPU options, and missing architecture metadata are excluded from suggestions.
Matching capacity does not guarantee equivalent CPU performance, local storage,
network bandwidth, or AMI compatibility; suggestions require review.

The current API returns one cheapest candidate per provider and has no architecture
predicate. If that candidate is incompatible, it is omitted; the action cannot
claim that no other compatible option exists. Savings are calculated from hourly
rates using the same `monthly-hours` assumption as the impact calculation, rather
than mixing the API's provider-specific monthly assumptions. Suggested savings
are relative to the proposed instance and do not change the PR cost total.

If the recommendations endpoint is unavailable or returns no compatible candidate,
set `candidate-instance-types: m6a.2xlarge,m6i.2xlarge,m7a.2xlarge` to compare an
explicit shortlist through the pricing endpoint. These candidates receive the
same compatibility checks. The comment identifies the fallback; it is not an
exhaustive catalog search. Maximum 12 candidate types per run.

The pricing endpoint currently requires a nonzero `vm` even for exact EC2 SKU
lookups. The action sends `{cpu_cores: 1, ram_gb: 1}` as that required placeholder,
disables synthetic base pricing, verifies the returned SKU, and uses the returned
catalog capacity for recommendations. The placeholder is never used for sizing or
cost arithmetic.

## Inputs and outputs

| Input | Default | Purpose |
|---|---|---|
| `api-key` | required | CostGraph key, passed as a secret |
| `plan-path` | required | Saved plan converted with `terraform show -json` |
| `base-plan-path` | none | Optional base branch plan for desired-inventory comparison |
| `github-token` | `github.token` | PR comment token |
| `api-url` | `https://pricing.baselinehq.cloud` | HTTPS API base URL |
| `aws-region` | none | Explicit fallback region |
| `operating-system` | `linux` | EC2 catalog OS |
| `monthly-hours` | `730` | Runtime hours, from 1 to 744 |
| `minimum-monthly-savings` | `1` | USD threshold for suggestions |
| `candidate-instance-types` | none | Comma-separated fallback shortlist to price |
| `comment` | `true` | Set `false` for job summary only |
| `comment-key` | `default` | Stable unique marker per project/plan |

Outputs: `before-monthly`, `after-monthly`, `monthly-delta`, and `complete`.
Amounts cover the fully priced changed subset only; they are empty when no
instances are fully priced. `complete` is false for unpriced/unsupported/deferred
changes. A failure to fetch recommendations is reported in the comment without
discarding valid cost estimates. Authentication failures fail the action.

Every run writes a GitHub job summary and updates its existing bot comment.
Multiple Terraform roots should use distinct `comment-key` values. Comment tables
are capped to keep large plans readable; calculations still include all priced
resources within the review limit.

## Test and preview

```sh
cd costgraph-pricing-action
npm test
npm run demo
```

No installation or credentials are needed. The demo uses explicitly illustrative
prices and does not call GitHub or CostGraph. Tests cover the pricing request and
response contracts, arithmetic, unknown values, partial coverage, compatibility,
authentication errors, caching, and comment creation/update. Live API validation
requires your CostGraph key and a real Terraform plan.

Implementation references: [Terraform JSON plan format](https://developer.hashicorp.com/terraform/internals/json-format),
[GitHub JavaScript actions](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action),
and [GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use).
