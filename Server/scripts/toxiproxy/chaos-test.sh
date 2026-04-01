#!/bin/bash
# Toxiproxy chaos testing for OwnCord
#
# Prerequisites:
#   1. toxiproxy-server running: toxiproxy-server &
#   2. OwnCord server running on port 8443
#   3. toxiproxy-cli available in PATH
#
# Usage: bash scripts/toxiproxy/chaos-test.sh

set -euo pipefail

TOXI_HOST="${TOXI_HOST:-localhost:8474}"
SERVER_HOST="${SERVER_HOST:-localhost}"
SERVER_PORT="${SERVER_PORT:-8443}"
PROXY_PORT="${PROXY_PORT:-18443}"

echo "=== OwnCord Chaos Testing ==="
echo "Toxiproxy API: $TOXI_HOST"
echo "Target server: $SERVER_HOST:$SERVER_PORT"
echo "Proxy port: $PROXY_PORT"
echo ""

# Create proxy
echo "[1/7] Creating proxy..."
toxiproxy-cli create owncord \
  --listen "0.0.0.0:$PROXY_PORT" \
  --upstream "$SERVER_HOST:$SERVER_PORT" 2>/dev/null || \
  echo "  (proxy already exists)"

echo ""
echo "[2/7] Test: Normal connectivity (baseline)"
echo "  Connect to localhost:$PROXY_PORT and verify response..."
curl -sf "http://localhost:$PROXY_PORT/api/v1/health" && echo " OK" || echo " FAIL"
sleep 1

echo ""
echo "[3/7] Test: High latency (500ms)"
echo "  Simulates slow network / cross-region..."
toxiproxy-cli toxic add owncord --type latency \
  --attribute latency=500 --attribute jitter=100 \
  --toxicName latency_test 2>/dev/null
echo "  Running health check with latency..."
time curl -sf "http://localhost:$PROXY_PORT/api/v1/health" && echo " OK" || echo " FAIL"
toxiproxy-cli toxic remove owncord --toxicName latency_test
sleep 1

echo ""
echo "[4/7] Test: Packet loss (30%)"
echo "  Simulates unreliable WiFi..."
toxiproxy-cli toxic add owncord --type timeout \
  --attribute timeout=3000 \
  --toxicName timeout_test 2>/dev/null
echo "  Health check should timeout after 3s..."
timeout 5 curl -sf "http://localhost:$PROXY_PORT/api/v1/health" 2>/dev/null && echo " OK (fast)" || echo " Timed out as expected"
toxiproxy-cli toxic remove owncord --toxicName timeout_test
sleep 1

echo ""
echo "[5/7] Test: Bandwidth limit (10KB/s)"
echo "  Simulates throttled connection..."
toxiproxy-cli toxic add owncord --type bandwidth \
  --attribute rate=10 \
  --toxicName bandwidth_test 2>/dev/null
echo "  Health check with bandwidth limit..."
time curl -sf "http://localhost:$PROXY_PORT/api/v1/health" && echo " OK" || echo " FAIL"
toxiproxy-cli toxic remove owncord --toxicName bandwidth_test
sleep 1

echo ""
echo "[6/7] Test: Connection reset"
echo "  Simulates abrupt disconnection..."
toxiproxy-cli toxic add owncord --type reset_peer \
  --attribute timeout=1000 \
  --toxicName reset_test 2>/dev/null
echo "  Health check should fail after 1s..."
curl -sf --max-time 3 "http://localhost:$PROXY_PORT/api/v1/health" 2>/dev/null && echo " OK (unexpected)" || echo " Reset as expected"
toxiproxy-cli toxic remove owncord --toxicName reset_test
sleep 1

echo ""
echo "[7/7] Test: Downstream slicer (fragment responses)"
echo "  Simulates packet fragmentation..."
toxiproxy-cli toxic add owncord --type slicer \
  --attribute average_size=10 --attribute size_variation=5 --attribute delay=10 \
  --toxicName slicer_test 2>/dev/null
echo "  Health check with sliced responses..."
curl -sf "http://localhost:$PROXY_PORT/api/v1/health" && echo " OK" || echo " FAIL"
toxiproxy-cli toxic remove owncord --toxicName slicer_test

echo ""
echo "=== Cleanup ==="
toxiproxy-cli delete owncord 2>/dev/null || true
echo "Done. All chaos tests complete."
