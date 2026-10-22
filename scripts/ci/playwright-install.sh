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
# The apt packages are cached too. A slow mirror does not stall, it trickles
# (~25 MB of fonts and library upgrades at tens of KB/s), so the Timeout keys
# below never fire and the step runs out its timeout-minutes. When
# OWNCORD_PLAYWRIGHT_APT_CACHE names a directory, its .debs are copied into
# apt's archive before `install-deps`, so apt downloads only what is missing
# (it checks each file's hash against the index), and every .deb apt has
# afterwards is copied back for the composite action to save.
#
# The retry here is apt's own: Acquire::Retries re-attempts a failed fetch and
# the Timeout keys bound each attempt, so a dead mirror fails in a bounded time.
# It is the one retry allowed for this step because the failure is proven
# runner infrastructure (a mirror outage), not a defect in this repository.
# Nothing else here retries; a failing browser download is a real failure.

set -euo pipefail

if command -v sudo >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  sudo tee /etc/apt/apt.conf.d/99-owncord-ci >/dev/null <<'APTCONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "3";
APT::Keep-Downloaded-Packages "true";
Binary::apt::APT::Keep-Downloaded-Packages "true";
APTCONF
fi

apt_cache="${OWNCORD_PLAYWRIGHT_APT_CACHE:-}"
archives=/var/cache/apt/archives
if [[ -n "$apt_cache" && -d "$archives" ]]; then
  mkdir -p "$apt_cache"
  shopt -s nullglob
  cached=("$apt_cache"/*.deb)
  echo "apt cache: ${#cached[@]} package(s) restored"
  if ((${#cached[@]})); then
    sudo cp "${cached[@]}" "$archives"/
  fi
fi

npx playwright install-deps chromium

if [[ -n "$apt_cache" && -d "$archives" ]]; then
  debs=("$archives"/*.deb)
  if ((${#debs[@]})); then
    cp "${debs[@]}" "$apt_cache"/
  fi
  echo "apt cache: ${#debs[@]} package(s) to keep"
fi

npx playwright install chromium
