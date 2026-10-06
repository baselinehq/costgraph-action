# CostGraph GitHub Actions

GitHub Actions that bring CostGraph into your pull requests.

| Action | Use it to | `uses:` |
|---|---|---|
| [Terraform cost](#terraform-cost) | Show the monthly cost of every Terraform change, with cheaper same-shape alternatives, in one pull request comment | `baselinehq/costgraph-action/terraform-cost@v0.0.1` |
| [CostGraph CLI setup](#costgraph-cli-setup) | Install the CostGraph CLI for your own workflow steps | `baselinehq/costgraph-action@v0.0.1` |
| [CI cost comment](#ci-cost-comment) | Show what a pull request's CI runs have cost so far, in one pull request comment | `baselinehq/costgraph-action/ci-cost@main` |

Docs: [Terraform cost with Infracost](https://docs.costgraph.ai/costgraph/integrations/infracost) and [all CostGraph integrations](https://docs.costgraph.ai/costgraph/integrations).

## Terraform cost

Put the monthly cost of every Terraform change in front of the reviewer. On each
pull request the action estimates what the plan costs on any cloud, shows what
the same machine shape costs at other providers, and keeps it all in one
pull request comment that is updated in place.

- Hetzner, DigitalOcean, Linode, Vultr, Scaleway, STACKIT, OVHcloud, UpCloud and
  more are priced from the CostGraph catalog.
- AWS, Azure and Google Cloud are priced through CostGraph, at your bill rates
  once you connect Infracost in CostGraph (see below).
- "Comparable instances" lists alternative instance sizes and prices across providers,
  with potential monthly savings. Review hardware and region differences before switching.
- Several Terraform projects land in one comment and one job summary.

### Quick start

1. Create an API key in CostGraph at
   https://app.costgraph.ai/settings/account/api-keys.
2. In your repository, open **Settings > Secrets and variables > Actions > New
   repository secret**, name it `COSTGRAPH_API_KEY` and paste the key.
3. Add the action after your plan step:

```yaml
name: Terraform

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Plan
        run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > plan.json

      - uses: baselinehq/costgraph-action/terraform-cost@v0.0.1
        with:
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}
          plan-path: plan.json
```

The action reads the plan as JSON (`terraform show -json` or `tofu show -json`).
It does not need cloud credentials; your plan step may. A complete workflow is in
[examples/terraform-pull-request.yml](examples/terraform-pull-request.yml).

### Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | required | CostGraph API key. Pass it from a secret. |
| `plan-path` | required | Terraform plan in JSON. One path per line to review several plans in one comment. |
| `working-directory` | `.` | Directory that `plan-path` is relative to. |
| `github-token` | `github.token` | Token that posts the comment. Needs `pull-requests: write`. |
| `comment` | `true` | Post the estimate on the pull request. The job summary is always written. |
| `comment-behavior` | `update` | `update` edits the earlier cost comment, `new` posts a new one on every run. |
| `alternatives` | `true` | Show the same machine shape at other providers. |
| `summary-format` | `github-comment` | Job summary layout: `github-comment` (same as the comment) or `table`. |
| `extra-args` | empty | Extra arguments for `costgraph cost breakdown`, one per line. |
| `output-path` | runner temp dir | Where to write the estimate file (Infracost JSON 0.2, all plans merged), relative to `working-directory`. |
| `artifact-name` | | Upload the estimate file as a workflow artifact with this name, so you can download it from the run. Empty skips the upload. |
| `fail-on-error` | `true` | Fail the job when the estimate cannot be produced. `false` reports a warning instead. |
| `cli-version` | `latest` | CostGraph CLI release, such as `v0.6.0`. |
| `infracost` | `true` | Run Infracost for AWS, Azure and Google Cloud resources. When `false`, those resources are left out. |
| `infracost-version` | `v0.10.46` | Infracost release. |
| `api-url` | `https://api.costgraph.ai` | CostGraph API URL. |
| `pricing-url` | CLI default | CostGraph pricing URL used for alternatives. |
| `github-api-url` | `github.api_url` | GitHub API URL, for GitHub Enterprise Server. |

### Outputs

| Output | Description |
|---|---|
| `total-monthly-cost` | Monthly cost after the change, in USD. |
| `previous-monthly-cost` | Monthly cost before the change. Empty when part of the estimate has no previous cost. |
| `diff-monthly-cost` | Change in monthly cost. Empty when part of the estimate has no previous cost. |
| `comment-url` | Link to the pull request comment, empty when none was posted. |
| `estimate-path` | Absolute path of the estimate file (Infracost JSON 0.2, all plans merged), for later steps such as `infracost comment` or your own checks. |

```yaml
      - id: cost
        uses: baselinehq/costgraph-action/terraform-cost@v0.0.1
        with:
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}
          plan-path: plan.json
      - run: echo "New monthly cost is $TOTAL"
        env:
          TOTAL: ${{ steps.cost.outputs.total-monthly-cost }}
```

### Pinning versions

`@v0.0.1` pins the action release; for the strongest guarantee pin the full
commit SHA (`baselinehq/costgraph-action/terraform-cost@<sha> # v0.0.1`).
The CostGraph CLI defaults to the latest release; pin it for repeatable estimates:

```yaml
      - uses: baselinehq/costgraph-action/terraform-cost@v0.0.1
        with:
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}
          plan-path: plan.json
          cli-version: v0.6.0
          infracost-version: v0.10.46
```

Every download is verified against a SHA-256 checksum before it runs. The CLI is
checked against the checksums published with its release. Infracost `v0.10.46`
is checked against checksums pinned in this repository; another Infracost
version is checked against the checksum published with that release, with a
warning.

### Multiple Terraform projects

List every plan in one call. Each plan is a project in the comment, with a total
across all of them:

```yaml
      - uses: baselinehq/costgraph-action/terraform-cost@v0.0.1
        with:
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}
          working-directory: infra
          plan-path: |
            network/plan.json
            app/plan.json
```

A pull request has one cost comment. If separate jobs each run the action, the
last one replaces the comment; collect the plans as artifacts into one job
instead.

### AWS, Azure and Google Cloud pricing

Connect your Infracost API key in CostGraph (**Integrations > Infracost**, see
[the Infracost integration docs](https://docs.costgraph.ai/costgraph/integrations/infracost)) and
AWS, Azure and Google Cloud resources are priced at your bill rates. Without it,
CostGraph prices what its catalog covers and lists the rest under "Not priced".
The workflow only needs `COSTGRAPH_API_KEY`; the Infracost key is not stored in
GitHub.

## CI cost comment

Show the reviewer what a pull request's CI has cost so far. The action reads the
cost of the pull request's CI runs from CostGraph and keeps it in one pull
request comment, separate from the Terraform cost comment, that is updated in
place on every run:

- the total since the day the pull request was opened
- the cost of each workflow
- how much went on failed jobs, cancelled jobs and re-runs

### Requirements

- **Blacksmith connected in CostGraph.** The cost comes from the CI runners
  reported to CostGraph; connect Blacksmith first (see
  [the Blacksmith integration docs](https://docs.costgraph.ai/costgraph/integrations/blacksmith)).
  Until its usage arrives, the comment says no CI cost is recorded yet.
- **An API key with the `focus:read` scope**, stored as the `COSTGRAPH_API_KEY`
  secret. Without that scope the action reports that the key needs it.
- **CostGraph CLI newer than v0.7.0.** The default `cli-version: latest` picks it up.

Usage is collected periodically (Blacksmith usage within about 6 hours), so the
comment trails the runs: the run that posts it, and runs from the last few
hours, may not be counted yet.

### Workflow

Add a final job that waits for the others, so the comment is posted after the
CI on each push, even when a job fails:

```yaml
name: CI

on:
  pull_request:

jobs:
  test:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@v5
      - run: make test

  ci-cost:
    needs: [test]
    if: always() && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: baselinehq/costgraph-action/ci-cost@main
        with:
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}
```

`ci-cost` is not in a tagged release of this action yet; pin a commit SHA of `main`, or the next release tag once it is published. The job needs no checkout. Pull requests from forks get no secrets or write
token, so the `if:` skips them.

### Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | required | CostGraph API key with the `focus:read` scope. Pass it from a secret. |
| `github-token` | `github.token` | Token that reads the pull request and posts the comment. Needs `pull-requests: write`. |
| `comment-behavior` | `update` | `update` edits the earlier CI cost comment, `new` posts a new one on every run. |
| `fail-on-error` | `false` | Fail the job when the CI cost cannot be read or posted. The default reports a warning instead. |
| `cli-version` | `latest` | CostGraph CLI release; needs a release newer than `v0.7.0`. |
| `api-url` | `https://api.costgraph.ai` | CostGraph API URL. |
| `github-api-url` | `github.api_url` | GitHub API URL, for GitHub Enterprise Server. |

Outputs: `total-cost`, the pull request's CI cost so far, and `comment-url`, the
link to the comment. Both are empty when no comment was posted.

## CostGraph CLI setup

`baselinehq/costgraph-action` installs the CostGraph CLI (and, by default,
Infracost for AWS, Azure and Google Cloud) and adds them to `PATH`, so you can run the commands yourself:

```yaml
      - uses: baselinehq/costgraph-action@v0.0.1
        with:
          cli-version: v0.6.0
          api-key: ${{ secrets.COSTGRAPH_API_KEY }}

      - env:
          COSTGRAPH_API_KEY: ${{ secrets.COSTGRAPH_API_KEY }}
        run: |
          infracost breakdown --path plan.json --format json --out-file infracost.json
          costgraph cost breakdown --path plan.json --format infracost-json --out-file costgraph.json
          costgraph cost output --path infracost.json --path costgraph.json --format table
```

| Input | Default | Description |
|---|---|---|
| `cli-version` | `latest` | CostGraph CLI release, such as `v0.6.0`. |
| `infracost` | `true` | Also install Infracost, which prices AWS, Azure and Google Cloud. |
| `infracost-version` | `v0.10.46` | Infracost release. |
| `api-key` | empty | When set, Infracost in later steps prices through CostGraph with no further setup. |
| `api-url` | `https://api.costgraph.ai` | CostGraph API URL. |

Outputs: `cli-version` and `infracost-version`, the installed releases.

When `api-key` is set, the action masks it in logs and exports the
Infracost settings, including the key, to the environment of later steps in the
job.

## Security

- Store the key as the `COSTGRAPH_API_KEY` secret. Never write it in workflow YAML.
- Pin the action to a release tag or, better, a commit SHA.
- Grant only `contents: read` and `pull-requests: write`.
- Pull requests from forks do not receive secrets or a write token. Skip the job
  for them, and never run untrusted Terraform under `pull_request_target`:

  ```yaml
  jobs:
    plan:
      if: github.event.pull_request.head.repo.full_name == github.repository
  ```

- Inputs reach the scripts through environment variables, never through shell
  interpolation, and the key is never printed.
- The plan file stays on the runner. CostGraph receives the details of the
  resources it prices; the comment lists resource addresses and their costs.
- Use workflow `concurrency` so an older run does not overwrite a newer comment:

  ```yaml
  concurrency:
    group: cost-${{ github.event.pull_request.number }}
    cancel-in-progress: true
  ```

## Troubleshooting

| Message | Fix |
|---|---|
| `api-key is empty` | The secret is missing or not available to this run (for example a fork pull request). |
| `plan ... was not found` | `plan-path` is relative to `working-directory`, not to an earlier step's directory. |
| `... is not a Terraform plan in JSON` | Convert the saved plan: `terraform show -json tfplan > plan.json`. With `setup-terraform`, set `terraform_wrapper: false` so the JSON is not wrapped. |
| `could not post the cost comment` | Add `pull-requests: write` to the workflow permissions. |
| `the CostGraph API key needs the focus:read scope` | Create an API key with the `focus:read` scope for `ci-cost`. |
| `No CI cost is recorded for this pull request yet` | Connect Blacksmith in CostGraph, then wait for its usage to arrive. |
| AWS, Azure or Google Cloud lines show as not priced | Connect Infracost in CostGraph. |
| `Not a pull request event` | The comment is posted only on pull request events; for `terraform-cost` the job summary is still written. |
| `could not download ... check that the version exists` | Check `cli-version` or `infracost-version` against the published releases. |

## Development

```sh
actionlint
shellcheck scripts/*.sh
```

CI runs both, runs the setup action on Linux (amd64 and arm64) and
macOS, and prices `examples/digitalocean-plan.json` through `terraform-cost` when
the `COSTGRAPH_API_KEY` secret is available.

## License

AGPL-3.0. If you modify and distribute this action, or run a modified version as a service, publish your changes under the same license. See [LICENSE](LICENSE).
