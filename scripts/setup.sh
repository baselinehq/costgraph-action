#!/usr/bin/env bash
set -euo pipefail

cli_base="https://setup.costgraph.ai/costgraph-cli"
infracost_base="https://github.com/infracost/infracost/releases/download"
pinned_infracost_version="v0.10.46"

fail() {
  echo "::error::$1" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() {
  curl -fsSL --retry 3 --retry-connrefused -o "$2" "$1"
}

verify() {
  local actual
  actual="$(sha256_of "$1")"
  [[ -n "$2" && "$actual" == "$2" ]] || fail "checksum mismatch for $(basename "$1"): expected ${2:-nothing}, got $actual"
}

write_env() {
  local delimiter
  delimiter="COSTGRAPH_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s<<%s\n%s\n%s\n' "$1" "$delimiter" "$2" "$delimiter" >>"$GITHUB_ENV"
}

pinned_infracost_sha256() {
  case "$1" in
    linux-amd64) echo d0d081cd39b07b2ca5c315830bfc4bcdfb0183b04c19cb18835c154482a2c97b ;;
    linux-arm64) echo acd693c7d001fef44787bc5de65fffcb25bf5445885fd1da98a7b31281e32b43 ;;
    darwin-amd64) echo 16f9d48469fcbc5e8133f10dca54cd34f15487f1da331c1be579cc8d80d9c3dc ;;
    darwin-arm64) echo 09fa73ecdc762c1b557df70234eb44cc446a9a9e412a4ab326185cac3f39e631 ;;
  esac
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported runner OS $(uname -s); use a Linux or macOS runner" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported runner architecture $(uname -m); use an amd64 or arm64 runner" ;;
esac

version_pattern='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

announce_newer_action() {
  local used="${ACTION_REF:-}" latest
  [[ "$used" =~ $version_pattern ]] || return 0
  latest="$(curl -fsS --max-time 5 ${ACTION_TOKEN:+-H "Authorization: Bearer $ACTION_TOKEN"} \
    https://api.github.com/repos/baselinehq/costgraph-action/releases/latest 2>/dev/null | jq -r '.tag_name // empty' 2>/dev/null)" || return 0
  [[ "$latest" =~ $version_pattern && "$latest" != "$used" ]] || return 0
  [[ "$(printf '%s\n%s\n' "$used" "$latest" | sort -V | tail -1)" == "$latest" ]] || return 0
  echo "::notice title=costgraph-action $latest is available::This workflow uses costgraph-action $used. Use @v0 to get every 0.x release, or see https://github.com/baselinehq/costgraph-action/releases"
}
root="${RUNNER_TEMP:?RUNNER_TEMP is not set}/costgraph"
bin="$root/bin"
mkdir -p "$bin"
tmp="$(mktemp -d "$root/download.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

cli_version="${CLI_VERSION:-latest}"
if [[ "$cli_version" == "latest" ]]; then
  cli_version="$(curl -fsSL --retry 3 --retry-connrefused "$cli_base/latest" | tr -d '[:space:]')"
fi
cli_version="v${cli_version#v}"
[[ "$cli_version" =~ $version_pattern ]] || fail "cli-version must be latest or a release such as v0.5.0, got $cli_version"

if [[ "$os" == darwin ]]; then
  cli_asset="costgraph-cli_darwin_all.tar.gz"
else
  cli_asset="costgraph-cli_linux_${arch}.tar.gz"
fi
echo "Installing CostGraph CLI $cli_version ($cli_asset)"
fetch "$cli_base/${cli_version#v}/$cli_asset" "$tmp/$cli_asset" || fail "could not download CostGraph CLI $cli_version; check that the version exists"
fetch "$cli_base/${cli_version#v}/checksums.txt" "$tmp/checksums.txt"
verify "$tmp/$cli_asset" "$(awk -v f="$cli_asset" '$2 == f { print $1 }' "$tmp/checksums.txt")"
tar -xzf "$tmp/$cli_asset" -C "$tmp" costgraph
install -m 0755 "$tmp/costgraph" "$bin/costgraph"

infracost_version=""
if [[ "${INSTALL_INFRACOST:-true}" == "true" ]]; then
  infracost_version="${INFRACOST_VERSION:-$pinned_infracost_version}"
  infracost_version="v${infracost_version#v}"
  [[ "$infracost_version" =~ $version_pattern ]] || fail "infracost-version must be a release such as $pinned_infracost_version, got $infracost_version"
  platform="$os-$arch"
  infracost_asset="infracost-$platform.tar.gz"
  echo "Installing Infracost $infracost_version ($infracost_asset)"
  fetch "$infracost_base/$infracost_version/$infracost_asset" "$tmp/$infracost_asset" || fail "could not download Infracost $infracost_version; check that the version exists"
  if [[ "$infracost_version" == "$pinned_infracost_version" ]]; then
    expected="$(pinned_infracost_sha256 "$platform")"
  else
    echo "::warning::Infracost $infracost_version has no checksum pinned in this action; verifying against the checksum published with the release"
    fetch "$infracost_base/$infracost_version/$infracost_asset.sha256" "$tmp/infracost.sha256"
    expected="$(cut -d' ' -f1 "$tmp/infracost.sha256")"
  fi
  verify "$tmp/$infracost_asset" "$expected"
  tar -xzf "$tmp/$infracost_asset" -C "$tmp" "infracost-$platform"
  install -m 0755 "$tmp/infracost-$platform" "$bin/infracost"
  write_env INFRACOST_SKIP_UPDATE_CHECK true
fi

echo "$bin" >>"$GITHUB_PATH"
export PATH="$bin:$PATH"
costgraph version
[[ -z "$infracost_version" ]] || INFRACOST_SKIP_UPDATE_CHECK=true infracost --version

if [[ -n "${COSTGRAPH_API_KEY:-}" && "${EXPORT_INFRACOST_ENV:-false}" == "true" ]]; then
  echo "::add-mask::$COSTGRAPH_API_KEY"
  infracost_env="$(costgraph cost setup-infracost)"
  eval "$infracost_env"
  while read -r _ assignment; do
    name="${assignment%%=*}"
    write_env "$name" "${!name}"
  done <<<"$infracost_env"
fi

{
  echo "cli-version=$cli_version"
  echo "infracost-version=$infracost_version"
} >>"$GITHUB_OUTPUT"

announce_newer_action
