# Changelog

## Unreleased

- `terraform-cost`: resources that already exist are priced from your bill when the API key can read it (`focus:read`). Needs a CostGraph CLI that supports `cost output --plan`; older versions keep estimates.
- `ci-cost`: comments what a pull request's CI runs have cost so far, from the CI runners reported to CostGraph. Needs CostGraph CLI newer than v0.7.0.

## v0.0.2

- `terraform-cost`: the estimate is available as a file. New output `estimate-path`, new inputs `output-path` (where to write it) and `artifact-name` (upload it as a workflow artifact you can download from the run).

## v0.0.1

First release of the CostGraph GitHub Actions.

- `terraform-cost`: estimates the monthly cost of one or more Terraform plans on any
  cloud, with same-shape alternatives at other providers, in one pull request
  comment that is updated in place, plus the job summary.
- Root action (CostGraph CLI setup): installs the CostGraph CLI, and optionally
  Infracost wired to CostGraph pricing, with checksum verification.
- Outputs `total-monthly-cost`, `previous-monthly-cost`, `diff-monthly-cost` and
  `comment-url`.

### Breaking changes from the EC2-only preview

- The pull request review moves to `baselinehq/costgraph-action/terraform-cost`
  and is built on the CostGraph CLI; the Node implementation is removed. The
  root action now only installs the CLI.
- Removed inputs: `base-plan-path`, `aws-region`, `operating-system`,
  `monthly-hours`, `minimum-monthly-savings`, `candidate-instance-types`,
  `comment-key`.
- `api-url` now defaults to `https://api.costgraph.ai`.
- Outputs `before-monthly`, `after-monthly`, `monthly-delta` and `complete` are
  replaced by `previous-monthly-cost`, `total-monthly-cost`, `diff-monthly-cost`
  and `comment-url`.
