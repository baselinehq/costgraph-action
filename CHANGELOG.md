# Changelog

## v0.0.1

First release of the CostGraph cost review action set.

- Root action: estimates the monthly cost of one or more Terraform plans on any
  cloud, with same-shape alternatives at other providers, in one pull request
  comment that is updated in place, plus the job summary.
- `setup` action: installs the CostGraph CLI and Infracost with checksum
  verification and can point Infracost at CostGraph pricing.
- Outputs `total-monthly-cost`, `previous-monthly-cost`, `diff-monthly-cost` and
  `comment-url`.

### Breaking changes from the EC2-only preview

- The action is now a composite action built on the CostGraph CLI; the Node
  implementation is removed.
- Removed inputs: `base-plan-path`, `aws-region`, `operating-system`,
  `monthly-hours`, `minimum-monthly-savings`, `candidate-instance-types`,
  `comment-key`.
- `api-url` now defaults to `https://api.costgraph.ai`.
- Outputs `before-monthly`, `after-monthly`, `monthly-delta` and `complete` are
  replaced by `previous-monthly-cost`, `total-monthly-cost`, `diff-monthly-cost`
  and `comment-url`.
