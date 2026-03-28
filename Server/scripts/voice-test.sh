#!/bin/bash
# voice-test.sh — LiveKit voice integration smoke test
#
# Prerequisites:
#   - LiveKit CLI: go install github.com/livekit/livekit-cli/cmd/lk@latest
#   - OwnCord server running with LiveKit enabled
#   - LIVEKIT_URL and LIVEKIT_API_KEY/SECRET set (or pass via flags)
#
# Usage:
#   ./voice-test.sh
#   LIVEKIT_URL=ws://remote:7880 ./voice-test.sh

set -euo pipefail

LIVEKIT_URL="${LIVEKIT_URL:-ws://localhost:7880}"
API_KEY="${LIVEKIT_API_KEY:-devkey}"
API_SECRET="${LIVEKIT_API_SECRET:-secret}"
TEST_ROOM="voice-test-$(date +%s)"

echo "=== LiveKit Voice Integration Test ==="
echo "URL: $LIVEKIT_URL"
echo "Room: $TEST_ROOM"
echo ""

# Verify lk CLI is available
if ! command -v lk &>/dev/null; then
  echo "ERROR: lk (LiveKit CLI) not found."
  echo "Install: go install github.com/livekit/livekit-cli/cmd/lk@latest"
  exit 1
fi

# 1. Create a test room
echo "[1/4] Creating test room..."
lk room create "$TEST_ROOM" \
  --url "$LIVEKIT_URL" \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  2>/dev/null && echo "  OK" || echo "  SKIP (room may not need explicit creation)"

# 2. Generate tokens for 2 test participants
echo "[2/4] Generating participant tokens..."
TOKEN_A=$(lk token create \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --join --room "$TEST_ROOM" \
  --identity "test-user-a" \
  --valid-for 5m 2>/dev/null)
echo "  Token A: ${TOKEN_A:0:20}..."

TOKEN_B=$(lk token create \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --join --room "$TEST_ROOM" \
  --identity "test-user-b" \
  --valid-for 5m 2>/dev/null)
echo "  Token B: ${TOKEN_B:0:20}..."

# 3. Load test with synthetic participants
echo "[3/4] Running load test (2 publishers, 2 subscribers, 10s)..."
lk load-test \
  --url "$LIVEKIT_URL" \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  --room "$TEST_ROOM" \
  --audio-publishers 2 \
  --subscribers 2 \
  --duration 10s \
  2>&1 | tail -5

# 4. Cleanup
echo "[4/4] Cleaning up test room..."
lk room delete "$TEST_ROOM" \
  --url "$LIVEKIT_URL" \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET" \
  2>/dev/null && echo "  OK" || echo "  SKIP"

echo ""
echo "=== Voice test complete ==="
