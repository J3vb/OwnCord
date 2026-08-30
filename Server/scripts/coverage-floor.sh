#!/usr/bin/env bash
# Coverage floor gate (B3-6 item 1). Fails when the aggregate, or any core
# package named in the floor file, is below its floor. Ratchet: Server/CLAUDE.md.
#
# From Server/:
#   bash scripts/coverage-floor.sh coverage.out
#   bash scripts/coverage-floor.sh --floor /tmp/red.json coverage.out
#   OWNCORD_COVERAGE_FLOOR=/tmp/red.json bash scripts/coverage-floor.sh coverage.out
#
# The floor-file shape is fixed, because awk parses it — jq is not guaranteed on
# the runners. Keep one entry per line, "exclude" on a single line, and package
# names as module-relative directories with no trailing slash:
#   {"aggregate": <pct>, "exclude": ["db/dbgen", "cmd"],
#    "packages": {"<pkg>": <pct>, ...}}
# "exclude" prefixes are dropped before anything is counted. A percentage is
# covered/total statements truncated to one decimal, so what this prints is
# exactly what the floor file records. [ \t] rather than [[:space:]] below: the
# ubuntu runner's awk may be mawk.
set -euo pipefail

floor="${OWNCORD_COVERAGE_FLOOR:-coverage-floor.json}"
if [ "${1:-}" = "--floor" ]; then
  floor="${2:?--floor needs a path}"
  shift 2
fi
profile="${1:-coverage.out}"

for f in "$floor" "$profile"; do
  [ -f "$f" ] || {
    echo "coverage-floor: no such file: $f" >&2
    exit 2
  }
done

awk '
FNR == NR {                                       # pass 1: the floor file
  if ($0 ~ /"packages"[ \t]*:/) { inpkg = 1; next }
  if (inpkg && $0 ~ /}/) inpkg = 0
  if ($0 ~ /"exclude"[ \t]*:/) {
    n = split($0, a, "\"")
    for (i = 4; i <= n; i += 2) if (a[i] != "") excl[++ne] = a[i]
    next
  }
  if (!match($0, /"[^"]+"[ \t]*:[ \t]*[0-9]/)) next
  key = val = $0
  sub(/^[^"]*"/, "", key); sub(/".*$/, "", key)
  sub(/^[^:]*:[ \t]*/, "", val); sub(/[^0-9.].*$/, "", val)
  if (key == "aggregate") { aggfloor = val + 0; haveagg = 1 }
  else if (inpkg) { pkgfloor[key] = val + 0; order[++np] = key }
  next
}
/^mode:/ { next }
{                                                 # pass 2: the coverage profile
  rel = $1
  sub(/:[0-9]+\.[0-9]+,[0-9]+\.[0-9]+$/, "", rel)   # drop the block range
  sub(/^.*\/Server\//, "", rel)                     # module-relative path
  pkg = (rel ~ /\//) ? rel : "."
  sub(/\/[^\/]*$/, "", pkg)
  for (i = 1; i <= ne; i++)
    if (index(pkg "/", excl[i] "/") == 1) next
  tot += $2; ptot[pkg] += $2
  if ($3 > 0) { cov += $2; pcov[pkg] += $2 }
}
function check(name, c, t, fl,   tenths, under) { # figures compared in tenths
  tenths = int(c * 1000 / t)
  under = (tenths < int(fl * 10 + 0.5))
  printf "coverage-floor: %s %s %.1f%% (floor %.1f%%, %d/%d statements)\n", (under ? "FAIL" : "ok"), name, tenths / 10, fl, c, t
  return under
}
END {
  if (!haveagg || np == 0 || tot == 0) {
    print "coverage-floor: floor file or coverage profile is empty/malformed"
    exit 2
  }
  bad = check("aggregate", cov, tot, aggfloor)
  for (i = 1; i <= np; i++) {
    p = order[i]
    if (!(p in ptot)) {
      printf "coverage-floor: FAIL %s: no statements in the coverage profile\n", p
      bad = 1
      continue
    }
    if (check(p, pcov[p], ptot[p], pkgfloor[p])) bad = 1
  }
  exit bad
}
' "$floor" "$profile"
