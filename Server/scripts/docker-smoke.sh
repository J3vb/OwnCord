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
#      the data the first one left behind.
#
# Used by ci.yml, release.yml (before anything is signed or pushed) and
# nightly-docker-smoke.yml, so a regression is caught pre-merge instead of at
# tag time. Usage: docker-smoke.sh <image>
#
# No config mount and no env: that is the contract being tested. The image
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

image="${1:?usage: docker-smoke.sh <image>}"
vol="owncord-smoke-vol-$$"
work="$(mktemp -d)"
containers=()

# Generous because a cold boot also generates a self-signed certificate; a
# replacement is normally healthy within a second. The drain budget matches
# Server/cmd/smoke/main.go's drainBudget, so both assets are held to one number.
readonly boot_timeout=90
readonly drain_budget=20

cleanup() {
  local c
  # "${a[@]:-}" yields one empty element for an empty array under `set -u`,
  # hence the guard rather than an unconditional rm.
  for c in "${containers[@]:-}"; do
    if [ -n "$c" ]; then
      docker rm -f "$c" >/dev/null 2>&1 || true
    fi
  done
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# fail <container> <message> — ::error:: is the GitHub Actions annotation
# prefix; the container's log is what makes the annotation actionable.
fail() {
  local c=$1
  shift
  echo "::error::$*"
  docker logs "$c" 2>&1 || true
  exit 1
}

# start <container> — the flags are the minimal-privilege posture
# docs/deployment.md tells owners to use, so the smoke tests what is documented.
start() {
  containers+=("$1")
  docker run -d --name "$1" \
    -v "$vol:/app/data" \
    --cap-drop=ALL \
    --security-opt=no-new-privileges:true \
    "$image" >/dev/null
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
docker logs "$replacement"
drain "replace drain" "$replacement"

echo "docker smoke passed: boot, migrate, healthy, minimal privilege, drain, replace"
