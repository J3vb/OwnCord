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
case "$BENCH_COUNT" in
'' | *[!0-9]*)
	echo "bench-baseline: BENCH_COUNT must be a positive integer, got '${BENCH_COUNT}'" >&2
	exit 1
	;;
esac
if [ "$BENCH_COUNT" -lt 1 ]; then
	echo "bench-baseline: BENCH_COUNT must be a positive integer, got '${BENCH_COUNT}'" >&2
	exit 1
fi

# golang.org/x/perf carries no semver tags, so the newest resolvable version is
# a pseudo-version. Pinned, and deliberately NOT in go.mod — benchstat is a
# tool, not something the server links.
BENCHSTAT="golang.org/x/perf/cmd/benchstat@v0.0.0-20260825160852-19be9d8e6c70"

cd "$(dirname "$0")/.."

alternation="$(printf '%s|' "${EXPECTED[@]}")"
pattern="^Benchmark(${alternation%|})\$"
shown="go test -run '^\$' -bench '${pattern}' -benchmem -count=${BENCH_COUNT} ./..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
full="$tmp/full.txt"    # everything go test printed, for diagnosing a failure
clean="$tmp/bench.txt"  # only what benchstat can parse
draft="$tmp/out.md"     # the document, moved onto $out once it is complete

echo "bench-baseline: ${shown}"
echo "bench-baseline: -count=${BENCH_COUNT}; about a minute at 6."

# Keep only what benchstat reads — result lines and the goos/goarch/pkg/cpu
# configuration lines it keys on — plus whatever a failure would print.
# `go test ./...` also emits ok/? lines per package that benchstat cannot parse,
# and it folds the test binary's own output into its stdout, which lands INSIDE
# a result line because the benchmark's name is printed before it runs (see
# quietLogs in ws/hub_bench_test.go).
set +e
go test -run '^$' -bench "$pattern" -benchmem -count="$BENCH_COUNT" ./... 2>&1 | tee "$full" |
	grep -E '^(Benchmark|goos:|goarch:|pkg:|cpu:)' >"$clean"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
	echo "bench-baseline: the benchmark run failed (exit ${status}), unfiltered output:" >&2
	cat "$full" >&2
	exit 1
fi

# Guard 1: a benchmark that no longer exists cannot quietly drop out.
missing=""
for name in "${EXPECTED[@]}"; do
	grep -qE "^Benchmark${name}[-[:space:]]" "$clean" || missing="${missing} ${name}"
done
if [ -n "$missing" ]; then
	echo "bench-baseline: expected benchmark(s) missing from the run:${missing}" >&2
	echo "bench-baseline: renamed or deleted. Restore the name, or edit EXPECTED in" >&2
	echo "bench-baseline: scripts/bench-baseline.sh on purpose. No baseline written." >&2
	exit 1
fi

date_stamp="$(date -u +%Y-%m-%d)"
out="../docs/plans/b3-bench-baseline-${date_stamp}.md"
cpu="$(sed -n 's/^cpu: *//p' "$clean" | head -1 | sed 's/[[:space:]]*$//')"
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
- \`go test ./...\` runs the three packages' benchmark binaries concurrently
  (\`-p\` defaults to GOMAXPROCS), so each package's figures are measured under
  the others' load. A noise source the command shape B3-6 specifies accepts.
- \`BenchmarkPermissionInvalidation\` runs against a bare hub with no
  \`PermissionService\`, so every client's verdict is a live lookup. That is the
  uncached worst case, not what a server with the 30 s permission cache pays.
- Regenerating writes a NEW dated file. Replace the row in
  \`docs/plans/README.md\` and delete the superseded document — only the newest
  baseline is kept, so there is one number to compare against.

## benchstat

\`\`\`
EOF
	# label=file, so the column header is stable instead of a temp path. The
	# sed strips trailing padding: Go's own `cpu:` line carries some, and
	# Prettier trims trailing whitespace even inside a fenced block, so
	# without this every regenerated baseline fails the hygiene gate.
	go run "$BENCHSTAT" "b3-baseline=$clean" | sed 's/[[:space:]]*$//'
	printf '%s\n' '```'
} >"$draft"

# Guard 2: every expected benchmark reached the RENDERED TABLE, not merely the
# run. Guard 1 greps the result lines, and a result line corrupted by output
# the benchmark itself wrote still starts with the benchmark's name — so
# benchstat drops that row, exits 0, and guard 1 sees nothing wrong. benchstat
# prints the name without its Benchmark prefix.
missing=""
for name in "${EXPECTED[@]}"; do
	grep -qE "^${name}[-[:space:]]" "$draft" || missing="${missing} ${name}"
done
if [ -n "$missing" ]; then
	echo "bench-baseline: benchstat produced no row for:${missing}" >&2
	echo "bench-baseline: the benchmark ran but its result line was unparseable —" >&2
	echo "bench-baseline: usually output written from inside the benchmark, which" >&2
	echo "bench-baseline: lands mid-line because go test prints the name first." >&2
	echo "bench-baseline: No baseline written." >&2
	exit 1
fi

# Only now replace the committed baseline. Everything above renders into $tmp,
# so a failure anywhere — benchstat's first-run module fetch, a proxy outage, a
# bad pin — leaves the existing document intact instead of truncating it.
mv "$draft" "$out"

echo "bench-baseline: wrote ${out}"
