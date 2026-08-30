#!/usr/bin/env bash
# Coverage floor gate (B3-6 item 1). Fails when the aggregate, or any core
# package named in the floor file, is below its floor. Ratchet: Server/CLAUDE.md.
#
# From Server/:
#   bash scripts/coverage-floor.sh coverage.out
#   bash scripts/coverage-floor.sh --floor /tmp/red.json coverage.out
#   OWNCORD_COVERAGE_FLOOR=/tmp/red.json bash scripts/coverage-floor.sh coverage.out
#
# The floor-file shape is fixed, because awk parses it - jq is not guaranteed on
# the runners - and the parser fails closed (exit 2) rather than enforcing less
# than the file says. Four rules: every line inside "packages" is one
# "name": <number> entry, the number unquoted; all five core packages
# (ws, service, permissions, auth, db) are present; the "exclude" array is all
# on ONE line, because a Prettier-wrapped array would parse as no exclusions at
# all; package names are module-relative directories with no trailing slash
# ("cmd", not "cmd/").
#   {"aggregate": <pct>, "exclude": ["db/dbgen", "cmd"],
#    "packages": {"<pkg>": <pct>, ...}}
# "exclude" prefixes are dropped before anything is counted. A percentage is
# covered/total statements truncated to one decimal, so what this prints is
# exactly what the floor file records. LC_ALL=C and [ \t] rather than
# [[:space:]]: the ubuntu runner's awk may be mawk.
set -euo pipefail
export LC_ALL=C

usage() {
  echo "usage: coverage-floor.sh [--floor <file>] [<coverage profile>]" >&2
  exit 2
}

floor="${OWNCORD_COVERAGE_FLOOR:-coverage-floor.json}"
profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --floor)
      floor="${2:?--floor needs a path}"
      shift 2
      ;;
    -*) usage ;;
    *)
      [ -z "$profile" ] || usage
      profile="$1"
      shift
      ;;
  esac
done
profile="${profile:-coverage.out}"

for f in "$floor" "$profile"; do
  [ -f "$f" ] || {
    echo "coverage-floor: no such file: $f" >&2
    exit 2
  }
done

awk '
FNR == NR {                                       # pass 1: the floor file
  if ($0 ~ /"packages"[ \t]*:/) {
    inpkg = 1
    sub(/^.*"packages"[ \t]*:[ \t]*[{]/, "")      # keep any entry on this line
  }
  if ($0 ~ /"exclude"[ \t]*:/) {
    sawexcl = 1
    n = split($0, a, "\"")
    for (i = 4; i <= n; i += 2) if (a[i] != "") excl[++ne] = a[i]
    next
  }
  entry = $0                                      # strip the block brace, comma
  if (inpkg) sub(/[ \t]*[}].*$/, "", entry)
  gsub(/^[ \t]+|[ \t]*,[ \t]*$|[ \t]+$/, "", entry)
  ok = (entry ~ /^"[^"]+"[ \t]*:[ \t]*[0-9]+([.][0-9]+)?$/)
  if (inpkg && entry != "" && !ok)
    err = sprintf("floor file line %d is not a \"name\": <number> entry: %s", FNR, $0)
  if (ok) {
    key = val = entry
    sub(/^"/, "", key); sub(/".*$/, "", key)
    sub(/^[^:]*:[ \t]*/, "", val)
    if (key == "aggregate") { aggfloor = val + 0; haveagg = 1 }
    else if (inpkg) { pkgfloor[key] = val + 0; order[++np] = key }
  }
  if (inpkg && $0 ~ /}/) inpkg = 0                # close AFTER parsing the line
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
  if (err != "") {
    print "coverage-floor: " err
    exit 2
  }
  if (sawexcl && ne == 0) {
    print "coverage-floor: \"exclude\" must be one single-line array, e.g. \"exclude\": [\"db/dbgen\", \"cmd\"]; a wrapped array parses as no exclusions"
    exit 2
  }
  if (!haveagg || tot == 0) {
    print "coverage-floor: floor file or coverage profile is empty/malformed"
    exit 2
  }
  nc = split("ws service permissions auth db", core, " ")
  for (i = 1; i <= nc; i++)
    if (!(core[i] in pkgfloor)) {
      print "coverage-floor: floor file has no floor for core package " core[i]
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
