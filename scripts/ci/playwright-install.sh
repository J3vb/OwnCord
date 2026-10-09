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
#   - cache: the browser lands in ~/.cache/ms-playwright, which the workflows
#     restore with actions/cache, so on a hit the download phase is a no-op.
#     `install-deps` has no such cache and always runs.
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
APTCONF
fi

npx playwright install-deps chromium
npx playwright install chromium
