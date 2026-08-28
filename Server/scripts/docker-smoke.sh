#!/usr/bin/env bash
# Boot-smoke a freshly built server image: start it, wait for
# `/chatserver healthcheck` to pass, print the logs, tear it down.
#
# Used by both ci.yml (every PR to main) and release.yml (before anything is
# signed or pushed), so a boot regression is caught pre-merge instead of at
# tag time. Usage: docker-smoke.sh <image>
#
# Deliberately a bare `docker run` — no mounts, no env, no config. That is
# the contract being tested: the image boots on its own, as uid 65532, and
# writes its default config.yaml and data/ into the /app skeleton the
# Dockerfile ships owned by that uid. The first v1.2.0-alpha.3 release run
# died exactly here ("writing default config: permission denied") when /app
# was still root-owned; adding mounts to the smoke would only hide a repeat.
set -euo pipefail
# Git Bash on Windows rewrites the /chatserver argument below into a Windows
# path unless told not to, and the smoke then reports a false boot failure.
# Exported here so callers do not have to remember it (ENV-03).
export MSYS_NO_PATHCONV=1

image="${1:?usage: docker-smoke.sh <image>}"
name="owncord-smoke-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" "$image" >/dev/null

ok=0
for _ in $(seq 1 30); do
  sleep 1
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "::error::container exited during boot smoke"
    docker logs "$name"
    exit 1
  fi
  if docker exec "$name" /chatserver healthcheck; then ok=1; break; fi
done
docker logs "$name"
if [ "$ok" != "1" ]; then
  echo "::error::container never reported healthy within 30s"
  exit 1
fi
