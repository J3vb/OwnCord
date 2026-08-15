#!/usr/bin/env bash
# Boot-smoke a freshly built server image: start it, wait for
# `/chatserver healthcheck` to pass, print the logs, tear it down.
#
# Used by both ci.yml (every PR to main) and release.yml (before anything is
# signed or pushed), so a boot regression is caught pre-merge instead of at
# tag time. Usage: docker-smoke.sh <image>
#
# The image runs as uid 65532 with WORKDIR /app, and the server writes its
# default config.yaml to the cwd and the database/cert into data/. Neither
# path is writable in a bare `docker run` (/app is root-owned, and the
# VOLUME /app/data anonymous volume is created root-owned too) — that is
# what real deployments' bind mounts provide, and what v1.2.0-alpha.3's
# first release run died on. Give the container the same thing with two
# tmpfs mounts (Docker's tmpfs default mode is 1777).
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image>}"
name="owncord-smoke-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" --tmpfs /app --tmpfs /app/data "$image" >/dev/null

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
