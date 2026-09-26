#!/usr/bin/env bash
# Coverage floor gate for the client. Reads vitest's coverage-summary.json and
# fails when the total statements pct is below the floor in coverage-floor.json.
#
# From Client/:
#   bash scripts/coverage-floor.sh
#   bash scripts/coverage-floor.sh coverage/coverage-summary.json
#
# Both files are parsed with node, not awk. vitest writes coverage-summary.json
# as ONE minified line, so a line-oriented `awk '/"pct"/ {...}'` concatenates
# every number in the file into a single nonsense value — and because that value
# is still non-empty and compares greater than the floor, the gate reports "ok"
# and exits 0 no matter how bad coverage actually is. A gate that cannot fail is
# worse than no gate, so the parsing has to understand JSON.
#
# Requires the `json-summary` coverage reporter (vitest.config.ts). It is not in
# vitest's defaults; without it this script exits 2 rather than passing blindly.
set -euo pipefail

summary="${1:-coverage/coverage-summary.json}"
floor_file="coverage-floor.json"

for f in "$summary" "$floor_file"; do
  if [ ! -f "$f" ]; then
    echo "coverage-floor: no such file: $f" >&2
    echo "coverage-floor: run 'npx vitest run --coverage' first; the json-summary reporter writes it" >&2
    exit 2
  fi
done

if ! floor=$(node -e '
  const fs = require("node:fs");
  const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).aggregate;
  if (typeof v !== "number" || !Number.isFinite(v)) process.exit(1);
  process.stdout.write(String(v));
' "$floor_file"); then
  echo "coverage-floor: no numeric \"aggregate\" floor in $floor_file" >&2
  exit 2
fi

if ! pct=$(node -e '
  const fs = require("node:fs");
  const total = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).total;
  const v = total && total.statements ? total.statements.pct : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) process.exit(1);
  process.stdout.write(String(v));
' "$summary"); then
  echo "coverage-floor: no numeric total.statements.pct in $summary" >&2
  exit 2
fi

# Compare in tenths as integers so the result does not depend on the shell's
# (absent) floating-point support.
floor_tenths=$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 10)))' "$floor")
pct_tenths=$(node -e 'process.stdout.write(String(Math.round(Number(process.argv[1]) * 10)))' "$pct")

if [ "$pct_tenths" -lt "$floor_tenths" ]; then
  echo "coverage-floor: FAIL statements ${pct}% (floor ${floor}%)"
  exit 1
fi

echo "coverage-floor: ok statements ${pct}% (floor ${floor}%)"
