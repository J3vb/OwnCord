#!/usr/bin/env bash
# Smoke the shipped Server/docker-compose.yml (WP 4.8b). Phase 8 of
# docker-smoke.sh, which calls it with the candidate image; it can also be run
# alone. Usage: compose-smoke.sh <image>
#
# docker-smoke.sh proves the single image. This proves the two-container stack
# an owner actually installs, against design 4.8 (compose publishes exactly
# 8443/tcp, 7881/tcp and 7882/udp; the LiveKit key and secret are typed once,
# in .env):
#
#   1. port count — the file as Compose resolves it publishes exactly those
#      three ports, none of them a range;
#   2. one secret — with only .env holding the secret, the stack comes up and
#      GET /api/v1/livekit/health is 200 (a signed ListRooms, so LiveKit
#      accepted the server's pair), and 7882/udp is a bound socket;
#   3. the check can fail — the server recreated with a different secret gets
#      503, so a 200 above is not a probe that always passes;
#   4. legacy install — an old livekit.yaml with a port range and a STALE
#      keys: pair is dropped in and LiveKit restarted: health is 200 again
#      (the env pair replaces the file's) and 7882/udp is still bound (the
#      range flags zero the file's range).
#
# "Bound" is read from /proc/net/udp inside LiveKit's network namespace, never
# from LiveKit's startup log or `livekit-server ports`: both print udp_port
# even when the port_range wins (design 4.8, step 0), so neither proves which
# port is in use. To see the check fail on purpose, drop the two
# --rtc.port_range_* flags in a scratch copy of the compose file: phase 4 must
# then fail on the socket.
#
# Not covered: UDP media reachability through the published port. That is
# proven end to end by Server/ws/livekit_single_port_real_test.go.
set -euo pipefail
# Same reason as docker-smoke.sh: Git Bash must not rewrite container paths.
export MSYS_NO_PATHCONV=1

image="${1:?usage: compose-smoke.sh <image>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_dir="$(cd "$script_dir/.." && pwd)"
work="$(mktemp -d)"
project="owncord-csmoke"

# busybox:1.37.0, the multi-arch index digest, so one pin serves amd64 and
# arm64. Used only to read /proc/net/udp: the LiveKit image has no shell to
# exec into, so a helper joins its network namespace instead.
readonly busybox_image="busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
# Loopback offset of 8443 (docker-smoke.sh uses 18443 the same way): clear of
# cmd/smoke -docker on 8443, and off the LAN.
readonly smoke_port=18443
readonly health_url="https://127.0.0.1:${smoke_port}/api/v1/livekit/health"
readonly up_timeout=120
readonly probe_timeout=60
# 7882 in hex, as /proc/net/udp prints a local port.
readonly udp_port_hex="1ECA"

# dc <compose args> — the stack, run from the temp dir with relative names
# (MSYS_NO_PATHCONV stops Git Bash converting host paths for a native
# docker.exe). dc_files is reassigned when a phase needs another override.
dc_files=(-f docker-compose.yml -f override.yml)
dc() {
  (cd "$work" && docker compose -p "$project" "${dc_files[@]}" "$@")
}

cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# show_logs — both services' logs, the one-time setup token masked as
# docker-smoke.sh does: a fresh volume prints it on the console.
show_logs() {
  dc logs --no-color --tail 200 2>&1 |
    sed -E 's/(Setup token[[:space:]]+)[^[:space:]]+/\1[redacted]/' || true
}

fail() {
  echo "::error::compose: $*"
  show_logs
  exit 1
}

for tool in jq openssl curl docker; do
  command -v "$tool" >/dev/null 2>&1 ||
    { echo "::error::compose: $tool is required"; exit 1; }
done
docker compose version >/dev/null 2>&1 ||
  { echo "::error::compose: the docker compose plugin is required"; exit 1; }

# --- Set up the temp project: what an owner has after `cp *.example` -------
cp "$server_dir/docker-compose.yml" "$work/docker-compose.yml"
cp "$server_dir/config.yaml.example" "$work/config.yaml"
# The key and secret exist ONLY here (design: typed once). The secret is 64 hex
# characters, past the 32-character minimum the server enforces.
api_key="key-$(openssl rand -hex 8)"
api_secret="$(openssl rand -hex 32)"
printf 'LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$api_key" "$api_secret" >"$work/.env"
# Hermetic: no STUN for the external IP. This edits the smoke's copy of the
# operator's livekit.yaml, not the compose file under test.
sed 's/use_external_ip: true/node_ip: 127.0.0.1/' "$server_dir/livekit.yaml.example" >"$work/livekit.yaml"
grep -q 'node_ip: 127.0.0.1' "$work/livekit.yaml" ||
  { echo "::error::compose: livekit.yaml.example no longer has 'use_external_ip: true' to replace"; exit 1; }
# The bind-mounted files are read by uid 65532 / the LiveKit user, not by us.
chmod 644 "$work/config.yaml" "$work/livekit.yaml" "$work/.env"
# Candidate image, and loopback-only offset ports. `!override` replaces the
# file's list instead of appending to it (Compose 2.24+).
cat >"$work/override.yml" <<OVERRIDE
services:
  owncord:
    image: ${image}
    ports: !override
      - "127.0.0.1:${smoke_port}:8443"
  livekit:
    ports: !override
      - "127.0.0.1:17881:7881"
      - "127.0.0.1:17882:7882/udp"
OVERRIDE

# A project left by a crashed earlier run on a reused runner must not answer
# the health probe for this one.
dc down -v --remove-orphans >/dev/null 2>&1 || true

# --- Phase 1: the shipped file publishes exactly three ports ---------------
# Resolved by Compose itself, from the file as shipped (no override), so this
# is not just the Go YAML parser's view of it.
ports_json=$(cd "$work" && docker compose -p "$project" -f docker-compose.yml config --format json |
  jq -c '[.services[].ports[]? | "\(.published)>\(.target)/\(.protocol)"] | sort') ||
  { echo "::error::compose: docker compose config failed on Server/docker-compose.yml"; exit 1; }
want_ports='["7881>7881/tcp","7882>7882/udp","8443>8443/tcp"]'
[ "$ports_json" = "$want_ports" ] || {
  echo "::error::compose: published ports are $ports_json, want exactly $want_ports (no ranges)"
  exit 1
}
echo "compose ports: exactly 8443/tcp, 7881/tcp and 7882/udp"

# probe_health <want-status> <phase> — poll until the health route answers the
# wanted status (the server and LiveKit settle a moment after "up"), bounded.
# 200 must also say livekit_reachable:true. -k: self-signed, and the peer is
# this host's loopback publish.
probe_health() {
  local want=$1 phase=$2 i status=""
  for ((i = 0; i < probe_timeout; i++)); do
    status=$(cd "$work" && curl -ksS --max-time 10 -o health.out -w '%{http_code}' \
      "$health_url" 2>/dev/null) || status="curl-failed"
    [ "$status" = "$want" ] && break
    sleep 1
  done
  [ "$status" = "$want" ] ||
    fail "$phase: GET /api/v1/livekit/health returned $status after ${probe_timeout}s, want $want"
  if [ "$want" = "200" ]; then
    tr -d ' \n' <"$work/health.out" | grep -q '"livekit_reachable":true' ||
      fail "$phase: health answered 200 without livekit_reachable:true"
  fi
  echo "$phase: health $status after ${i}s"
}

# assert_udp_bound <phase> — 7882 must be a bound UDP socket in LiveKit's own
# network namespace. Never the startup log or `livekit-server ports` (header).
assert_udp_bound() {
  local phase=$1 cid i table=""
  cid=$(dc ps -q livekit) || fail "$phase: docker compose ps failed"
  [ -n "$cid" ] || fail "$phase: no livekit container"
  for ((i = 0; i < 30; i++)); do
    table=$(docker run --rm --network "container:$cid" "$busybox_image" \
      sh -c 'cat /proc/net/udp; cat /proc/net/udp6 2>/dev/null || true' 2>&1) ||
      fail "$phase: could not read /proc/net/udp in LiveKit's namespace: $table"
    # Column 2 is local_address:port; the header row never matches.
    if printf '%s\n' "$table" | awk -v p=":${udp_port_hex}\$" '$2 ~ p {found = 1} END {exit !found}'; then
      echo "$phase: 7882/udp (:${udp_port_hex}) is bound in LiveKit's namespace"
      return 0
    fi
    sleep 1
  done
  echo "$table"
  fail "$phase: nothing bound on 7882/udp (:${udp_port_hex}) in LiveKit's namespace"
}

# --- Phase 2: one secret, in .env only -------------------------------------
dc up -d --wait --wait-timeout "$up_timeout" ||
  fail "one secret: the stack did not become healthy within ${up_timeout}s"
probe_health 200 "one secret"
assert_udp_bound "one secret"

# --- Phase 3: a mismatched secret fails the same check ---------------------
# The .env can no longer be mis-keyed against LiveKit, so mis-key the server's
# side instead: same compose file, a different secret for owncord alone.
cat >"$work/badsecret.yml" <<BADSECRET
services:
  owncord:
    environment:
      OWNCORD_VOICE_LIVEKIT_API_SECRET: $(openssl rand -hex 32)
BADSECRET
dc_files=(-f docker-compose.yml -f override.yml -f badsecret.yml)
dc up -d --no-deps --force-recreate --wait --wait-timeout "$up_timeout" owncord ||
  fail "mismatch: owncord did not become healthy with the wrong secret"
probe_health 503 "mismatch"
dc_files=(-f docker-compose.yml -f override.yml)
dc up -d --no-deps --force-recreate --wait --wait-timeout "$up_timeout" owncord ||
  fail "mismatch: owncord did not become healthy after restoring the secret"
probe_health 200 "mismatch restored"

# --- Phase 4: a legacy livekit.yaml cannot bring the range or the keys back -
# Written in place with `cat >`: the bind mount pins the inode, so `mv` or
# `sed -i` would leave the container on the old file. The check after the
# restart proves the container sees the legacy file.
cat >"$work/livekit.yaml" <<LEGACY
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  node_ip: 127.0.0.1
keys:
  stale-key-$(openssl rand -hex 4): $(openssl rand -hex 32)
LEGACY
chmod 644 "$work/livekit.yaml"
dc restart livekit ||
  fail "legacy: livekit did not restart on the old-style livekit.yaml"
docker cp "$(dc ps -q livekit)":/etc/livekit/livekit.yaml - | tar -xO | grep -q port_range_start ||
  fail "legacy: the livekit container does not see the old-style livekit.yaml"
probe_health 200 "legacy"
assert_udp_bound "legacy"

echo "compose smoke passed: three ports, one secret works, a wrong secret fails, an old livekit.yaml cannot revive the range"
