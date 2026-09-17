#!/usr/bin/env bash
# Coverage floor gate (B3-6 item 1). Fails when the aggregate, or any core
# package named in the floor file, is below its floor. Ratchet: Server/CLAUDE.md.
#
# From Server/:
#   bash scripts/coverage-floor.sh coverage.out
#   bash scripts/coverage-floor.sh --floor /tmp/red.json coverage.out
#   OWNCORD_COVERAGE_FLOOR=/tmp/red.json bash scripts/coverage-floor.sh coverage.out
#
# The floor file is JSON, so node parses it - the same choice
# Client/scripts/coverage-floor.sh makes for the identical job. A line-oriented
# parse cannot see the nesting and so cannot fail closed: a Prettier-wrapped
# "exclude" array parses as no exclusions at all, and a malformed entry
# silently enforces less than the file says. A floor file node cannot read (not
# JSON, no numeric "aggregate", a non-numeric package floor) exits 2 before awk
# runs, and the core-package loop below still catches one that omits a package.
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

# Three lines from one node parse: the aggregate, the space-separated excludes,
# the space-separated "pkg=pct" pairs. Node never sees the coverage profile.
if ! floor_vals=$(node -e '
  const fs = require("node:fs");
  const f = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const num = (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) process.exit(1);
    return v;
  };
  const pkgs = Object.entries(f.packages || {}).map(([k, v]) => `${k}=${num(v)}`);
  const agg = num(f.aggregate);
  process.stdout.write([agg, (f.exclude || []).join(" "), pkgs.join(" ")].join("\n") + "\n");
' "$floor"); then
  echo "coverage-floor: not a usable floor file: $floor" >&2
  exit 2
fi
{ read -r aggfloor; read -r excl; read -r pkgs; } <<< "$floor_vals"

awk -v aggf="$aggfloor" -v exclv="$excl" -v pkgf="$pkgs" '
BEGIN {                                           # the floor, pre-parsed by node
  aggfloor = aggf + 0
  if (pkgf != "") {
    n = split(pkgf, pbuf, " ")
    for (i = 1; i <= n; i++) {
      eq = index(pbuf[i], "=")
      key = substr(pbuf[i], 1, eq - 1)
      pkgfloor[key] = substr(pbuf[i], eq + 1) + 0
      order[++np] = key
    }
  }
  if (exclv != "") {
    n = split(exclv, xbuf, " ")
    for (i = 1; i <= n; i++) excl[++ne] = xbuf[i]
  }
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
  if (tot == 0) {
    print "coverage-floor: coverage profile is empty/malformed"
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
' "$profile"
