#!/usr/bin/env bash
# Builds and runs a real OwnCord server for the admin-panel e2e suite
# (playwright.config.admin.ts). Fresh temp data dir every run, TLS off so
# Playwright talks plain http, loopback only. The server's cwd is the temp
# dir so the first-boot config.yaml template and the wizard's write-back
# land there instead of in the repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../../../../../Server" && pwd)"
PORT="${OWNCORD_ADMIN_E2E_PORT:-18446}"

RUN_DIR="$(mktemp -d -t owncord-admin-e2e-XXXXXX)"
mkdir -p "$RUN_DIR/data"
echo "admin-e2e: data dir $RUN_DIR (port $PORT)" >&2

BIN="$RUN_DIR/chatserver"
(cd "$SERVER_DIR" && go build -o "$BIN" .)

cleanup() {
  # Playwright kills the process group on teardown; the trap covers manual
  # runs. The temp dir is left behind on failure for post-mortems and
  # reaped by the OS otherwise.
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

cd "$RUN_DIR"
OWNCORD_SERVER_PORT="$PORT" \
OWNCORD_SERVER_DATA_DIR="$RUN_DIR/data" \
OWNCORD_DATABASE_PATH="$RUN_DIR/data/chatserver.db" \
OWNCORD_TLS_MODE=off \
OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT=false \
OWNCORD_LOGGING_LEVEL=warn \
"$BIN" &
SERVER_PID=$!
wait "$SERVER_PID"
