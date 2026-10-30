#!/usr/bin/env bash
# Lifecycle-smoke a freshly built server image (B6-2). Not merely "does it
# start": the phases below mirror Server/cmd/smoke/main.go, which proves the
# same lifecycle for the standalone binary.
#
#   1. cold boot on an EMPTY named volume, with minimal privilege;
#   2. migrate — config.yaml and a SQLite database were actually created;
#   3. privilege — the container really is unprivileged, capability-free
#      and running as uid 65532, and the image declares a HEALTHCHECK;
#   4. drain — `docker stop` exits 0 inside the drain budget;
#   5. replace — a NEW container on the SAME volume reaches healthy and finds
#      the data the first one left behind;
#   6. wizard persists — on a fresh volume the first-run setup wizard is driven
#      over its HTTP API, the container it restarts is replaced, and the chosen
#      settings are still in force (WP 4.7c);
#   7. recovery — the documented `config reset-overrides` command, run against
#      the same volume: refused while the server runs (exit 1, file untouched),
#      and with it stopped, drops the lockout-capable keys, keeps the tuning
#      values, and the server comes back healthy (WP 4.7c);
#   8. compose — the shipped Server/docker-compose.yml, run by
#      compose-smoke.sh with this image: exactly three published ports, the
#      one LiveKit secret in .env works (and a wrong one fails), and an old
#      livekit.yaml cannot bring the port range back (WP 4.8b);
#   9. browser client — only with --browser-client: a container with the
#      browser client switched on serves the bundle's index at / and the
#      script it references, the check cmd/smoke -browser-client makes for
#      the standalone assets.
#
# Used by ci.yml, release.yml (before anything is signed or pushed) and
# nightly-docker-smoke.yml, so a regression is caught pre-merge instead of at
# tag time. Only release.yml passes --browser-client: the other two build the
# image without the web bundle, and GET / then answers 404 by design.
# Usage: docker-smoke.sh [--browser-client] <image>
#
# Phases 1-7: no config mount and no env, that is the contract being tested
# (phase 8 boots the compose stack, which mounts its config). The image
# boots on its own, as uid 65532, writing its default config.yaml into the
# /app skeleton the Dockerfile ships owned by that uid. The first
# v1.2.0-alpha.3 release run died exactly there ("writing default config:
# permission denied") when /app was still root-owned. /app/data is a named
# volume because that is how an owner actually runs it — and Docker seeds an
# empty named volume from the image directory, ownership included, so the
# permission property above is still the one under test.
#
# Phase 5 replaces the container rather than restarting it: `docker start`
# reuses the container's own writable layer and would pass even if the volume
# were never mounted. Replacement is also the only upgrade path OwnCord
# supports (docs/deployment.md — `docker compose pull && up -d`).
set -euo pipefail
# Git Bash on Windows rewrites the /chatserver argument below into a Windows
# path unless told not to, and the smoke then reports a false boot failure.
# Exported here so callers do not have to remember it (ENV-03).
export MSYS_NO_PATHCONV=1

browser_client=false
if [ "${1:-}" = "--browser-client" ]; then
  browser_client=true
  shift
fi
image="${1:?usage: docker-smoke.sh [--browser-client] <image>}"
vol="owncord-smoke-vol-$$"
wiz_vol="owncord-smoke-wiz-vol-$$"
work="$(mktemp -d)"
containers=()

# Generous because a cold boot also generates a self-signed certificate; a
# replacement is normally healthy within a second. The drain budget matches
# Server/cmd/smoke/main.go's drainBudget, so both assets are held to one number.
readonly boot_timeout=90
readonly drain_budget=20
# Phases 6 and 7 speak HTTP, so one container publishes its port. 18443, never
# 8443: cmd/smoke -docker (upgrade-rehearsal.yml) binds 8443 on the same
# runner. Loopback only, as cmd/smoke/docker.go does: the owner created below
# is a throwaway and must not be reachable from the LAN.
readonly smoke_port=18443
readonly smoke_url="https://127.0.0.1:${smoke_port}"
# The wizard's restart exits the container (there is no restart policy), so
# this bounds the wait for that exit rather than assuming a restart happens.
readonly restart_timeout=60

cleanup() {
  local c
  # "${a[@]:-}" yields one empty element for an empty array under `set -u`,
  # hence the guard rather than an unconditional rm.
  for c in "${containers[@]:-}"; do
    if [ -n "$c" ]; then
      docker rm -f "$c" >/dev/null 2>&1 || true
    fi
  done
  docker volume rm -f "$vol" "$wiz_vol" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# fail <container> <message> — ::error:: is the GitHub Actions annotation
# prefix; the container's log is what makes the annotation actionable.
fail() {
  local c=$1
  shift
  echo "::error::$*"
  show_logs "$c" || true
  exit 1
}

# show_logs <container> — the container's log with the one-time setup token
# masked. The server prints that token on the console, never through slog, and
# phases 6 and 7 hold it long enough to matter if a CI log is public.
show_logs() {
  docker logs "$1" 2>&1 |
    sed -E 's/(Setup token[[:space:]]+)[^[:space:]]+/\1[redacted]/'
}

# start <container> [<volume> [<publish> [<env>]]] — the flags are the
# minimal-privilege posture docs/deployment.md tells owners to use, so the smoke
# tests what is documented. The volume defaults to the one phases 1-5 share;
# <publish>, when given, is a docker -p mapping, and <env> one docker -e pair.
start() {
  local c=$1 v=${2:-$vol} publish=${3:-} env=${4:-}
  # Never empty, so no empty-array expansion is needed under `set -u`.
  local -a args=(-v "$v:/app/data" --cap-drop=ALL --security-opt=no-new-privileges:true)
  containers+=("$c")
  if [ -n "$publish" ]; then
    args+=(-p "$publish")
  fi
  if [ -n "$env" ]; then
    args+=(-e "$env")
  fi
  local out
  if ! out=$(docker run -d --name "$c" "${args[@]}" "$image" 2>&1); then
    if [ -n "$publish" ]; then
      echo "::error::could not start $c with -p $publish: is the host port in ${publish} already in use? (docker-smoke needs it free)"
    fi
    echo "$out"
    exit 1
  fi
}

# wait_healthy <phase> <container> — polls the binary's own healthcheck
# subcommand, which is the only probe a distroless image can answer.
wait_healthy() {
  local phase=$1 c=$2 i
  for ((i = 0; i < boot_timeout; i++)); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" != "true" ]; then
      fail "$c" "$phase: container exited before reporting healthy"
    fi
    if docker exec "$c" /chatserver healthcheck >/dev/null 2>&1; then
      echo "$phase: healthy after ${i}s"
      return 0
    fi
    sleep 1
  done
  fail "$c" "$phase: never reported healthy within ${boot_timeout}s"
}

# have_file <container> <path> — docker cp is served by the daemon against the
# container filesystem, so it needs no shell inside the image.
#
# Streamed to stdout rather than to a host path on purpose. MSYS_NO_PATHCONV=1
# above is required for the CONTAINER side of every docker argument, but it also
# stops Git Bash converting the HOST side: `docker cp c:/f /tmp/x` then reaches
# the native Windows docker.exe as `D:\tmp\x` and fails with "directory does not
# exist" — a false negative indistinguishable from a missing file. Only `docker`
# needs the raw path; MSYS `tar` handles POSIX host paths itself, so every host
# path below is handed to tar or the shell, never to docker.
have_file() {
  docker cp "$1:$2" - >/dev/null 2>&1
}

# drain <phase> <container> — SIGTERM via docker stop, then assert the server
# shut itself down rather than being killed. docker stop escalates to SIGKILL
# after the timeout, and a killed container exits 137, so the exit code is the
# assertion; the elapsed time keeps a drain that merely crawls from passing.
drain() {
  local phase=$1 c=$2 started elapsed code
  started=$SECONDS
  docker stop -t "$drain_budget" "$c" >/dev/null
  elapsed=$((SECONDS - started))
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  [ "$code" = "0" ] ||
    fail "$c" "$phase: exited $code after SIGTERM, want 0 (137 = killed after the ${drain_budget}s budget)"
  [ "$elapsed" -le "$drain_budget" ] ||
    fail "$c" "$phase: took ${elapsed}s, budget is ${drain_budget}s"
  echo "$phase: drained cleanly in ${elapsed}s"
}

name="owncord-smoke-$$"

# --- Phases 1 and 2: cold boot on an empty volume, migrate, reach healthy ---
docker volume create "$vol" >/dev/null
start "$name"
wait_healthy "cold boot" "$name"

for artefact in /app/config.yaml /app/data/chatserver.db; do
  have_file "$name" "$artefact" ||
    fail "$name" "cold boot: first boot did not create $artefact"
done
echo "cold boot: config.yaml and a migrated database exist"

# The one assertion phase 5 cannot pass for the wrong reason. config.yaml lives
# in the image layer, so a replacement legitimately recreates it; and migrating
# into an empty volume would also produce a chatserver.db. Only a file nothing
# in the image can recreate distinguishes "the volume persisted" from "the
# server started over".
printf 'owncord-smoke %s\n' "$$" >"$work/smoke-marker"
tar -cf - -C "$work" smoke-marker | docker cp - "$name:/app/data"

# --- Phase 3: minimal privilege -------------------------------------------
# Asserted as container properties, not as "the flags we passed" — the image's
# USER is the one that matters, and a future --privileged at a call site must
# fail here rather than silently widen the posture.
user=$(docker inspect -f '{{.Config.User}}' "$name")
[ "$user" = "65532:65532" ] ||
  fail "$name" "privilege: image runs as '$user', want 65532:65532 (non-root)"

privileged=$(docker inspect -f '{{.HostConfig.Privileged}}' "$name")
[ "$privileged" = "false" ] ||
  fail "$name" "privilege: container is privileged"

capdrop=$(docker inspect -f '{{.HostConfig.CapDrop}}' "$name")
case "$capdrop" in
*ALL*) ;;
*) fail "$name" "privilege: CapDrop is '$capdrop', want ALL" ;;
esac

# A declared HEALTHCHECK is what gives a bare `docker run`, Podman or
# Kubernetes a health state; without one, .State.Health is absent entirely.
# The status itself is not asserted — Docker's own probe interval would make
# that a timing test, and wait_healthy above already proved the server healthy.
health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")
[ -n "$health" ] ||
  fail "$name" "privilege: image declares no HEALTHCHECK, so no health state is reported"
echo "privilege: non-root uid 65532, no capabilities, health state '$health'"

# --- Phase 4: graceful drain ----------------------------------------------
drain "drain" "$name"

# --- Phase 5: replace the container against the SAME volume ----------------
docker rm "$name" >/dev/null
replacement="${name}-replacement"
start "$replacement"
wait_healthy "replace" "$replacement"

docker cp "$replacement:/app/data/smoke-marker" - 2>/dev/null | tar -xO >"$work/marker.after" ||
  fail "$replacement" "replace: the data volume did not survive container replacement"
cmp -s "$work/smoke-marker" "$work/marker.after" ||
  fail "$replacement" "replace: the data volume was recreated, not reused"
have_file "$replacement" /app/data/chatserver.db ||
  fail "$replacement" "replace: database is missing after replacement"
echo "replace: reused the existing data volume and database"

# The replacement must drain as cleanly as the first boot did; a lock the first
# drain failed to release surfaces here, not on phase 4.
show_logs "$replacement"
drain "replace drain" "$replacement"

echo "phases 1-5 passed: boot, migrate, healthy, minimal privilege, drain, replace"

# --- Phase 6: the wizard's settings survive a container recreate (WP 4.7c) ---
# A container's config.yaml is not the place settings persist (it lives in the
# image layer, or is a read-only mount), so the wizard writes
# config-overrides.json into the data volume instead. A fresh volume keeps
# this independent of phases 1-5, and the setup token only exists while no
# user does.
wiz="${name}-wizard"
docker volume create "$wiz_vol" >/dev/null
start "$wiz" "$wiz_vol" "127.0.0.1:${smoke_port}:8443"
wait_healthy "wizard" "$wiz"

# The token is printed on the console only. Read it from the container's log
# into a variable; it is never echoed.
setup_token=""
for ((i = 0; i < boot_timeout; i++)); do
  setup_token=$(docker logs "$wiz" 2>&1 |
    sed -n 's/.*Setup token[[:space:]]\{1,\}\([^[:space:]]\{1,\}\).*/\1/p' | tail -n 1) || true
  [ -n "$setup_token" ] && break
  sleep 1
done
[ -n "$setup_token" ] ||
  fail "$wiz" "wizard: the server printed no setup token, so first-run setup is not open"

# The request is written to a file, not an argument, so the password and token
# are not in the process list. JSON is parsed with grep -o: the script also runs
# under Git Bash, which has no jq. -k because the certificate is self-signed
# and the peer is this host's own loopback publish.
wiz_pass="smoke-${$}-${RANDOM}-Ab1"
cat >"$work/setup.json" <<EOF
{"username":"smokeowner","password":"${wiz_pass}","setup_token":"${setup_token}","wizard":{"port":8443,"tls_mode":"self_signed","upload_max_size_mb":123,"voice_quality":"high"}}
EOF
# The curls run from inside $work with relative names: MSYS_NO_PATHCONV=1
# stops Git Bash converting a host path handed to a native curl.exe. Only a
# refused connection is retried (the published port can lag the healthcheck by
# a moment); any HTTP answer, including an error, is final.
status=""
for ((i = 0; i < 10; i++)); do
  rc=0
  status=$(cd "$work" && curl -ksS --max-time 30 -o setup.out -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data-binary @setup.json "$smoke_url/admin/api/setup" 2>/dev/null) || rc=$?
  [ "$rc" = "7" ] || break
  sleep 1
done
[ "$rc" = "0" ] ||
  fail "$wiz" "wizard: POST /admin/api/setup did not complete (curl exit $rc)"
[ "$status" = "201" ] ||
  fail "$wiz" "wizard: POST /admin/api/setup returned HTTP $status, want 201"
tr -d ' \n' <"$work/setup.out" | grep -q '"restart_required":true' ||
  fail "$wiz" "wizard: setup did not report restart_required (the wizard changed startup-only values)"
session_token=$(tr -d ' \n' <"$work/setup.out" | grep -o '"token":"[^"]*"' | head -n 1 | cut -d'"' -f4)
[ -n "$session_token" ] ||
  fail "$wiz" "wizard: setup returned no session token"
printf 'Authorization: Bearer %s\n' "$session_token" >"$work/auth.hdr"

# admin_get <outfile> — GET the settings list with the session token. Relative
# names from inside $work, as above.
admin_get() {
  (cd "$work" && curl -ksS --max-time 30 --fail -o "$1" -H @auth.hdr \
    "$smoke_url/admin/api/config/settings")
}
echo "wizard: setup accepted (201, restart_required)"

# The restart exits the container and nothing brings it back, so wait for the
# exit with a bound instead of assuming a restart. Only then is the volume
# quiescent and safe to hand to a replacement.
for ((i = 0; i < restart_timeout; i++)); do
  [ "$(docker inspect -f '{{.State.Running}}' "$wiz")" = "false" ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$wiz")" = "false" ] ||
  fail "$wiz" "wizard: the container did not exit within ${restart_timeout}s of the wizard's restart"
echo "wizard: container exited ($(docker inspect -f '{{.State.ExitCode}}' "$wiz")) for its restart"

# read_overrides <container> — print the overrides file with whitespace removed.
read_overrides() {
  docker cp "$1:/app/data/config-overrides.json" - 2>/dev/null | tar -xO | tr -d ' \n'
}

read_overrides "$wiz" | grep -q '"upload.max_size_mb":123' ||
  fail "$wiz" "wizard: config-overrides.json in the volume lacks upload.max_size_mb"

docker rm "$wiz" >/dev/null
wiz="${name}-wizard-replacement"
start "$wiz" "$wiz_vol" "127.0.0.1:${smoke_port}:8443"
wait_healthy "wizard replace" "$wiz"

admin_get settings.json ||
  fail "$wiz" "wizard replace: GET /admin/api/config/settings failed"
tr -d ' \n' <"$work/settings.json" >"$work/settings.flat"
grep -Eq '"key":"upload\.max_size_mb","type":"[a-z]+","value":123[,}]' "$work/settings.flat" ||
  fail "$wiz" "wizard replace: upload.max_size_mb is not 123 after the recreate"
grep -Eq '"key":"voice\.quality","type":"[a-z]+","value":"high"[,}]' "$work/settings.flat" ||
  fail "$wiz" "wizard replace: voice.quality is not high after the recreate"
echo "wizard replace: upload.max_size_mb=123 and voice.quality=high held across the recreate"

# --- Phase 7: the documented recovery command (WP 4.7c) --------------------
# The command is the one docs/server-configuration.md gives under "If a panel
# change locks you out", run the way a bare `docker run` owner runs it: same
# image, same volume, same minimal-privilege flags, no extra -e.
reset_overrides() {
  docker run --rm -v "$wiz_vol:/app/data" \
    --cap-drop=ALL --security-opt=no-new-privileges:true \
    "$image" config reset-overrides
}

# Leave the lockout-capable key in the file the way a real panel save does: a
# PATCH with the session token and the confirmation header the server expects.
# The allowlist still admits the address this request arrives from (the docker
# bridge, or loopback through the port relay), so the server's lockout guard
# accepts it, plus a TEST-NET-3 range. Both are values the reset must never
# print.
cat >"$work/patch.json" <<'EOF'
{"server.admin_allowed_cidrs":["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","203.0.113.0/24"]}
EOF
status=$(cd "$work" && curl -ksS --max-time 30 -o patch.out -w '%{http_code}' \
  -X PATCH -H 'Content-Type: application/json' -H @auth.hdr \
  -H 'X-OwnCord-Confirm: server.admin_allowed_cidrs' \
  --data-binary @patch.json "$smoke_url/admin/api/config/settings") ||
  fail "$wiz" "recovery: PATCH /admin/api/config/settings did not complete"
[ "$status" = "200" ] ||
  fail "$wiz" "recovery: PATCH /admin/api/config/settings returned HTTP $status, want 200"
read_overrides "$wiz" | grep -q '"server.admin_allowed_cidrs"' ||
  fail "$wiz" "recovery: the panel save did not reach config-overrides.json"

# Refused while the server runs: it holds the database's process lock. The file
# now holds the key, so "unchanged" has something to protect.
read_overrides "$wiz" >"$work/overrides.before"
code=0
reset_overrides >"$work/reset.running" 2>&1 || code=$?
if [ "$code" != "1" ]; then
  echo "reset-overrides output (key names only):"
  cat "$work/reset.running"
  fail "$wiz" "recovery: reset-overrides exited $code against a running server, want 1 (refused)"
fi
grep -q 'in use by another process' "$work/reset.running" ||
  { cat "$work/reset.running"; fail "$wiz" "recovery: the refusal was not the process lock"; }
read_overrides "$wiz" >"$work/overrides.after"
cmp -s "$work/overrides.before" "$work/overrides.after" ||
  fail "$wiz" "recovery: a refused reset still changed config-overrides.json"
grep -q '"server.admin_allowed_cidrs"' "$work/overrides.after" ||
  fail "$wiz" "recovery: the refused reset removed the lockout key"
echo "recovery: reset-overrides refused while the server runs (exit 1, process lock), file unchanged"

drain "recovery drain" "$wiz"

code=0
reset_overrides >"$work/reset.stopped" 2>&1 || code=$?
if [ "$code" != "0" ]; then
  echo "reset-overrides output (key names only):"
  cat "$work/reset.stopped"
  fail "$wiz" "recovery: reset-overrides exited $code with the server stopped, want 0"
fi
# Key names are printed; values never are.
grep -q 'server.admin_allowed_cidrs' "$work/reset.stopped" ||
  fail "$wiz" "recovery: reset-overrides did not name the key it removed"
if grep -Eq '203\.0\.113|172\.16\.0\.0|192\.168\.0\.0' "$work/reset.stopped"; then
  fail "$wiz" "recovery: reset-overrides printed a setting's value"
fi
read_overrides "$wiz" >"$work/overrides.reset"
if grep -q '"server.admin_allowed_cidrs"' "$work/overrides.reset"; then
  fail "$wiz" "recovery: the lockout key is still in config-overrides.json after the reset"
fi
grep -q '"upload.max_size_mb":123' "$work/overrides.reset" ||
  fail "$wiz" "recovery: the reset removed upload.max_size_mb, which is not lockout-capable"
echo "recovery: reset-overrides removed server.admin_allowed_cidrs and kept upload.max_size_mb"

# The server must come back on the recovered volume.
docker start "$wiz" >/dev/null
wait_healthy "recovery restart" "$wiz"
# The admin surface answers again with the same session, under the default
# allowlist the reset fell back to.
admin_get settings.recovered.json ||
  fail "$wiz" "recovery restart: GET /admin/api/config/settings failed after the reset"
echo "recovery restart: the admin settings API answers"
show_logs "$wiz"
drain "recovery final drain" "$wiz"

# --- Phase 9: the image serves the browser client (--browser-client only) ---
# The setting is off by default, so the env override switches it on, the way
# an owner's compose file would. The wizard volume is reused: it already has
# an owner, so the server boots straight into normal mode on the same port.
if [ "$browser_client" = "true" ]; then
  web="${name}-web"
  start "$web" "$wiz_vol" "127.0.0.1:${smoke_port}:8443" \
    "OWNCORD_SERVER_BROWSER_CLIENT_ENABLED=true"
  wait_healthy "browser client" "$web"
  status=""
  for ((i = 0; i < 10; i++)); do
    rc=0
    status=$(cd "$work" && curl -ksS --max-time 30 -o index.html \
      -w '%{http_code} %{content_type}' "$smoke_url/" 2>/dev/null) || rc=$?
    [ "$rc" = "7" ] || break
    sleep 1
  done
  [ "$rc" = "0" ] ||
    fail "$web" "browser client: GET / did not complete (curl exit $rc)"
  case "$status" in
    "200 text/html"*) ;;
    *) fail "$web" "browser client: GET / answered '$status', want 200 text/html (is the web bundle in this image?)" ;;
  esac
  grep -q '<script type="module"' "$work/index.html" ||
    fail "$web" "browser client: GET / has no <script type=\"module\">"
  script=$(grep -o '/assets/[A-Za-z0-9._/-]*\.js' "$work/index.html" | head -n 1) || true
  [ -n "$script" ] ||
    fail "$web" "browser client: GET / references no /assets/*.js script"
  status=$(cd "$work" && curl -ksS --max-time 30 -o /dev/null -w '%{http_code}' \
    "$smoke_url$script") ||
    fail "$web" "browser client: GET $script did not complete"
  [ "$status" = "200" ] ||
    fail "$web" "browser client: GET $script answered $status, want 200"
  echo "browser client: / serves the bundle index and $script"
  drain "browser client drain" "$web"
fi

# --- Phase 8: the compose stack (WP 4.8b) -----------------------------------
# Last, because it is the slowest and needs the host ports and images the
# phases above do not. It tears its own project down; its own failure output
# names the phase. Run as a child so its trap and `set -e` stay its own.
bash "$(dirname "${BASH_SOURCE[0]}")/compose-smoke.sh" "$image"

suffix=""
[ "$browser_client" = "true" ] && suffix=", browser client"
echo "docker smoke passed: boot, migrate, healthy, minimal privilege, drain, replace, wizard persists across a recreate, reset-overrides recovers${suffix}, compose stack"
