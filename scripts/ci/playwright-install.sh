#!/usr/bin/env bash
#
# Install the Playwright chromium browser in CI, with a bounded apt phase.
#
#   cd Client && bash ../scripts/ci/playwright-install.sh
#
# Signature this exists for: a CI step `Install Playwright browser` that shows
# "cancelled" and takes the whole job with it, its log a few `Ign:N
# http://azure.archive.ubuntu.com/ubuntu noble InRelease` lines and then
# nothing until `##[error]The operation was canceled.` at the job's own
# timeout-minutes. `playwright install --with-deps` runs `apt-get update &&
# apt-get install` internally with no bound, so a runner whose apt mirror
# hangs holds the step for the entire job budget, and the failure is
# attributed to the job.
#
# Why two phases instead of `install --with-deps`:
#   - attribution: apt (`install-deps`) and the ~300 MB browser download
#     (`install`) fail and time out on their own, under the step's
#     timeout-minutes, instead of one opaque hang;
#   - cache: the browser lands in ~/.cache/ms-playwright, which
#     .github/actions/playwright-install restores with actions/cache, so on a
#     hit the download phase is a no-op.
#
# The apt packages are cached too, keyed on the runner image. On an exact hit
# (OWNCORD_PLAYWRIGHT_APT_CACHE_HIT=true) the cached .debs are exactly what
# `install-deps` fetched on this same image, so they go in with `dpkg -i` and
# apt never touches the network: a slow mirror stalls `apt-get update` itself,
# not just the package download, so reusing the .debs under `install-deps`
# would not be enough. If dpkg refuses them, the cold path below runs.
#
# Cold path: `install-deps`, with apt's archive pointed at the cache directory
# so .github/actions/playwright-install can save every .deb it fetched. The azure mirror
# can trickle rather than fail (tens of KB/s, so the Timeout keys below never
# fire), so each attempt is bounded at APT_ATTEMPT_SECS; if the first one times
# out or fails, the azure mirror is swapped for archive.ubuntu.com and it runs
# once more. That
# is the one retry here, because the failure is runner infrastructure (a
# mirror outage), not a defect in this repository. A failing browser download
# is a real failure and is not retried.

set -euo pipefail

APT_ATTEMPT_SECS=240

apt_cache="${OWNCORD_PLAYWRIGHT_APT_CACHE:-}"
apt_cache_hit="${OWNCORD_PLAYWRIGHT_APT_CACHE_HIT:-}"

# Run as root under timeout so the kill reaches apt-get itself; npm gets its own
# cache so nothing root-owned lands in the runner's ~/.npm.
install_deps() {
  sudo timeout --kill-after=15 "$APT_ATTEMPT_SECS" \
    env PATH="$PATH" npm_config_cache=/tmp/owncord-root-npm \
    npx playwright install-deps chromium
}

use_archive_mirror() {
  echo "apt: install-deps failed or timed out, switching to archive.ubuntu.com"
  sudo grep -rlF azure.archive.ubuntu.com /etc/apt 2>/dev/null |
    xargs -r sudo sed -i 's#http://azure\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g'
  sudo dpkg --configure -a || true
}

if ! command -v apt-get >/dev/null 2>&1; then
  npx playwright install-deps chromium
  npx playwright install chromium
  exit 0
fi

sudo tee /etc/apt/apt.conf.d/99-owncord-ci >/dev/null <<'APTCONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
APT::Keep-Downloaded-Packages "true";
Binary::apt::APT::Keep-Downloaded-Packages "true";
APTCONF

# apt downloads straight into the cache directory: an image's own clean-up
# hooks (docker-clean and the like) only empty /var/cache/apt/archives.
if [[ -n "$apt_cache" ]]; then
  mkdir -p "$apt_cache/partial"
  echo "Dir::Cache::Archives \"$apt_cache/\";" |
    sudo tee -a /etc/apt/apt.conf.d/99-owncord-ci >/dev/null
fi

shopt -s nullglob
deps_done=false
if [[ -n "$apt_cache" && "$apt_cache_hit" == "true" ]]; then
  cached=("$apt_cache"/*.deb)
  echo "apt cache: ${#cached[@]} package(s) restored"
  if ((${#cached[@]})) && sudo dpkg -i "${cached[@]}"; then
    deps_done=true
  else
    echo "apt cache: dpkg could not install the cached packages, running install-deps"
  fi
fi

if [[ "$deps_done" != true ]]; then
  if ! install_deps; then
    use_archive_mirror
    install_deps
  fi
  if [[ -n "$apt_cache" ]]; then
    sudo rm -rf "$apt_cache/partial" "$apt_cache/lock"
    sudo chown -R "$(id -u):$(id -g)" "$apt_cache"
    debs=("$apt_cache"/*.deb)
    echo "apt cache: ${#debs[@]} package(s) to keep"
  fi
fi

npx playwright install chromium
