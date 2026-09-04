#!/usr/bin/env bash
#
# The shipped-dependency advisory gate, minus the npm registry's uptime.
#
#   bash scripts/npm-audit-gate.sh
#   bash scripts/npm-audit-gate.sh --selftest
#
# `npm audit` exits 1 for two unrelated reasons: it found an advisory at or
# above --audit-level, and it could not reach the audit endpoint. CI ran the
# bare command, so a registry outage turned into a red Client Static Checks on
# a pull request that never touched the client:
#
#   { error: 'Service Unavailable' }
#   npm error audit endpoint returned an error
#
# This keeps the gate and drops the outage. It is deliberately FAIL-CLOSED:
# only a recognised transport/outage signature is forgiven, and anything else
# — including any real finding — still fails. A persistent outage warns and
# passes rather than blocking every PR for as long as npm is down; the warning
# is visible in the job summary, and the gate runs again on the next push.
set -uo pipefail

ATTEMPTS=3

# Errors that mean "the endpoint did not answer", never "your dependencies are
# fine". Anything not matched here is treated as a real result.
OUTAGE_RE='audit endpoint returned an error|Service Unavailable|Bad Gateway|Gateway Time-?out|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network timeout|request to .* failed'

is_outage() {
  # A parseable audit report is a real result whatever words it contains, so
  # this is checked first: a vulnerable package named after an HTTP status
  # must not read as an outage.
  if printf '%s' "$1" | grep -q '"vulnerabilities"'; then
    return 1
  fi
  printf '%s' "$1" | grep -qiE "$OUTAGE_RE"
}

selftest() {
  failed=0
  check() { # check <expect: outage|real> <label> <text>
    if is_outage "$3"; then got=outage; else got=real; fi
    if [ "$got" = "$1" ]; then echo "PASS $2"; else echo "FAIL $2 (got $got, want $1)"; failed=1; fi
  }

  # The exact shape that reddened the build.
  check outage "npm's audit endpoint error" \
    "{ error: 'Service Unavailable' }
npm error audit endpoint returned an error"
  check outage "DNS failure" "npm error code ENOTFOUND"
  check outage "proxy 502" "npm error 502 Bad Gateway - GET https://registry.npmjs.org/-/npm/v1/security/audits"

  # A real result must never be forgiven, including one that mentions a
  # vulnerable package with an unlucky name.
  check real "a real high finding" \
    '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}'
  # An advisory whose TITLE carries an outage phrase. Without the
  # "vulnerabilities" precedence rule in is_outage this reads as an outage and
  # a real high finding is waved through, so this fixture is what holds that
  # rule in place.
  check real "a finding whose advisory title says Service Unavailable" \
    '{"vulnerabilities":{"ws":{"severity":"high","via":[{"title":"Service Unavailable via a crafted header"}]}},"metadata":{"vulnerabilities":{"high":1}}}'
  check real "an npm error that is not a transport error" \
    "npm error code EUSAGE
npm error This command requires an existing lockfile."

  [ "$failed" -eq 0 ] && echo "selftest: all assertions pass"
  exit "$failed"
}

[ "${1:-}" = "--selftest" ] && selftest

cd "$(dirname "$0")/../Client" || exit 1

for attempt in $(seq 1 "$ATTEMPTS"); do
  if out=$(npm audit --omit=dev --audit-level=high --json 2>&1); then
    echo "npm audit: no advisory at or above high in shipped dependencies."
    exit 0
  fi

  if ! is_outage "$out"; then
    printf '%s\n' "$out"
    echo "npm audit failed with a real result (an advisory at or above high, or a usage error)."
    exit 1
  fi

  printf '%s\n' "$out" | tail -5
  echo "npm audit: the registry's audit endpoint did not answer (attempt ${attempt}/${ATTEMPTS})."
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep $((attempt * 15))
  fi
done

echo "::warning::npm audit endpoint unavailable after ${ATTEMPTS} attempts; the shipped-dependency advisory gate did not run. Re-run this job once the registry recovers."
exit 0
