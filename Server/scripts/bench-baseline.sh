#!/usr/bin/env bash
# Record a benchmark baseline (B3-6 item 6, workstream 11).
#
#   cd Server && ./scripts/bench-baseline.sh      # or: make bench-baseline
#   BENCH_COUNT=3 ./scripts/bench-baseline.sh     # fewer repeats while iterating
#
# Writes ../docs/plans/b3-bench-baseline-<YYYY-MM-DD>.md: a provenance block
# (commit, date, toolchain, platform, CPU, the exact command) followed by
# benchstat's table in a fenced block, so Prettier leaves the numbers alone.
#
# Baselines are RECORDED, not gated. Nothing in CI compares these numbers and
# this script is deliberately wired into no workflow — that gate is B6's. The
# one thing it does enforce is the EXPECTED list below: a renamed or deleted
# benchmark still produces a table that looks complete, and a silently shorter
# baseline is worse than no baseline. So a missing name is a hard failure —
# restore the name, or edit EXPECTED deliberately.
set -euo pipefail

# Every benchmark the baseline must contain. The -bench regexp and the post-run
# guard are both built from this one list.
EXPECTED=(
	PermissionInvalidation
	ReadStateWrite
	BroadcastFanout
	ReplaySelection
	UploadAdmission
	ReconnectStorm
)

BENCH_COUNT="${BENCH_COUNT:-6}"

# golang.org/x/perf carries no semver tags, so the newest resolvable version is
# a pseudo-version. Pinned, and deliberately NOT in go.mod — benchstat is a
# tool, not something the server links.
BENCHSTAT="golang.org/x/perf/cmd/benchstat@v0.0.0-20260825160852-19be9d8e6c70"

cd "$(dirname "$0")/.." || exit 1

alternation="$(printf '%s|' "${EXPECTED[@]}")"
pattern="^Benchmark(${alternation%|})\$"
shown="go test -run '^\$' -bench '${pattern}' -benchmem -count=${BENCH_COUNT} ./..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
raw="$tmp/raw.txt"
clean="$tmp/bench.txt"

echo "bench-baseline: ${shown}"
echo "bench-baseline: -count=${BENCH_COUNT}; about a minute at 6."

# Keep only what benchstat reads — result lines and the goos/goarch/pkg/cpu
# configuration lines it keys on — plus whatever a failure would print.
# `go test ./...` also emits ok/? lines per package that benchstat cannot parse,
# and it folds the test binary's own output into its stdout, which lands INSIDE
# a result line because the benchmark's name is printed before it runs (see
# quietLogs in ws/hub_bench_test.go).
set +e
go test -run '^$' -bench "$pattern" -benchmem -count="$BENCH_COUNT" ./... 2>&1 |
	grep -E '^(Benchmark|goos:|goarch:|pkg:|cpu:|--- FAIL|panic:|FAIL|#)|\.go:[0-9]+:' >"$raw"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
	echo "bench-baseline: the benchmark run failed (exit ${status}):" >&2
	cat "$raw" >&2
	exit 1
fi

# The guardrail: a benchmark that no longer exists cannot quietly drop out.
missing=""
for name in "${EXPECTED[@]}"; do
	grep -qE "^Benchmark${name}[-[:space:]]" "$raw" || missing="${missing} ${name}"
done
if [ -n "$missing" ]; then
	echo "bench-baseline: expected benchmark(s) missing from the run:${missing}" >&2
	echo "bench-baseline: renamed or deleted. Restore the name, or edit EXPECTED in" >&2
	echo "bench-baseline: scripts/bench-baseline.sh on purpose. No baseline written." >&2
	exit 1
fi

grep -E '^(Benchmark|goos:|goarch:|pkg:|cpu:)' "$raw" >"$clean"

date_stamp="$(date -u +%Y-%m-%d)"
out="../docs/plans/b3-bench-baseline-${date_stamp}.md"
cpu="$(sed -n 's/^cpu: *//p' "$raw" | head -1 | sed 's/[[:space:]]*$//')"
[ -n "$cpu" ] || cpu="unknown"

{
	cat <<EOF
# B3 benchmark baseline — ${date_stamp}

**Status:** recorded ${date_stamp}. Baselines are recorded, not gated: no CI
step compares these numbers, and no workflow runs the script that produced
them. The performance gate is B6's; this is the figure it will be set against.

Regenerate with \`make bench-baseline\` from \`Server/\`. The script refuses to
write a baseline that is missing any of the benchmarks it expects, so a rename
cannot silently shorten the table.

## Provenance

- Commit: \`$(git rev-parse HEAD)\`
- Date (UTC): ${date_stamp}
- Toolchain: \`$(go version)\`
- Platform: \`$(go env GOOS)/$(go env GOARCH)\`
- CPU: ${cpu}
- benchstat: \`go run ${BENCHSTAT}\`

Command:

\`\`\`
${shown}
\`\`\`

## Reading these numbers

- One machine, one run. A figure here is comparable only with another run of
  this script on the same hardware and toolchain — never across contributors.
- The \`ws\` benchmarks point the default logger at \`io.Discard\` for the
  duration of the run (\`quietLogs\`, \`ws/hub_bench_test.go\`), so these figures
  exclude the log sink's write cost but keep the record-formatting cost.
- \`± n%\` is benchstat's confidence range over the repeats. The
  allocation-heavy benchmarks carry the widest ranges; read a small movement in
  those as noise until a repeat says otherwise.

## benchstat

\`\`\`
EOF
	# label=file, so the column header is stable instead of a temp path. The
	# sed strips trailing padding: Go's own `cpu:` line carries some, and
	# Prettier trims trailing whitespace even inside a fenced block, so
	# without this every regenerated baseline fails the hygiene gate.
	go run "$BENCHSTAT" "b3-baseline=$clean" | sed 's/[[:space:]]*$//'
	printf '%s\n' '```'
} >"$out"

echo "bench-baseline: wrote ${out}"
