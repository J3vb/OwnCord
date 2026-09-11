#!/usr/bin/env bash
# Coverage floor gate for the client. Reads vitest's coverage-summary.json
# and fails when statements pct is below the floor in coverage-floor.json.
#
# From Client/:
#   bash scripts/coverage-floor.sh
#   bash scripts/coverage-floor.sh --summary coverage/coverage-summary.json
set -euo pipefail

summary="${1:-coverage/coverage-summary.json}"
floor_file="coverage-floor.json"

for f in "$summary" "$floor_file"; do
  [ -f "$f" ] || {
    echo "coverage-floor: no such file: $f" >&2
    exit 2
  }
done

# Parse the floor (simple awk, same pattern as server)
floor=$(awk '/"aggregate"/ { gsub(/[^0-9.]/, "", $2); print $2 }' "$floor_file")
if [ -z "$floor" ]; then
  echo "coverage-floor: no aggregate floor in $floor_file" >&2
  exit 2
fi

# Parse vitest coverage-summary.json: extract total.statements.pct
# vitest v8 provider outputs: { "total": { "statements": { "pct": 85.3, ... } } }
pct=$(awk '/"statements"/ { found=1 } found && /"pct"/ { gsub(/[^0-9.]/, "", $2); print $2; exit }' "$summary")
if [ -z "$pct" ]; then
  echo "coverage-floor: no statements pct in $summary" >&2
  exit 2
fi

# Compare (integer tenths to avoid floating-point issues)
floor_tenths=$(awk "BEGIN { printf \"%d\", $floor * 10 }")
pct_tenths=$(awk "BEGIN { printf \"%d\", $pct * 10 }")

if [ "$pct_tenths" -lt "$floor_tenths" ]; then
  echo "coverage-floor: FAIL statements ${pct}% (floor ${floor}%)"
  exit 1
fi

echo "coverage-floor: ok statements ${pct}% (floor ${floor}%)"
