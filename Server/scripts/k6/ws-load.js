// k6 WebSocket load test for OwnCord server
// Run: k6 run --vus 50 --duration 60s scripts/k6/ws-load.js
//
// Environment variables:
//   K6_WS_URL     - WebSocket URL (default: ws://localhost:8443/ws)
//   K6_HTTP_URL   - HTTP base URL (default: http://localhost:8443)
//   K6_USERNAME   - Test user prefix (default: loadtest)
//   K6_PASSWORD   - Test user password (default: LoadTest123!)
//   K6_CHANNEL_ID - Channel ID to send messages in (default: 1)

import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Custom metrics
const wsConnections = new Counter("ws_connections");
const wsMessages = new Counter("ws_messages_sent");
const wsErrors = new Counter("ws_errors");
const wsConnectTime = new Trend("ws_connect_time", true);
const wsMessageRate = new Rate("ws_message_success");
const authTime = new Trend("auth_time", true);

// Configuration
const WS_URL = __ENV.K6_WS_URL || "ws://localhost:8443/ws";
const HTTP_URL = __ENV.K6_HTTP_URL || "http://localhost:8443";
const USERNAME_PREFIX = __ENV.K6_USERNAME || "loadtest";
const PASSWORD = __ENV.K6_PASSWORD || "LoadTest123!";
const CHANNEL_ID = parseInt(__ENV.K6_CHANNEL_ID || "1");

export const options = {
  scenarios: {
    // Ramp up connections gradually
    websocket_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 },   // warm up
        { duration: "30s", target: 50 },   // ramp to 50
        { duration: "60s", target: 50 },   // sustain
        { duration: "10s", target: 100 },  // spike
        { duration: "30s", target: 100 },  // sustain spike
        { duration: "10s", target: 0 },    // ramp down
      ],
    },
  },
  thresholds: {
    ws_connect_time: ["p(95)<2000"],     // 95% connect under 2s
    ws_message_success: ["rate>0.95"],    // 95% message success
    ws_errors: ["count<50"],             // fewer than 50 errors
    auth_time: ["p(95)<1000"],           // 95% auth under 1s
  },
};

// Login and get session token
function authenticate(username) {
  const start = Date.now();
  const res = http.post(
    `${HTTP_URL}/api/v1/auth/login`,
    JSON.stringify({ username, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" } },
  );
  authTime.add(Date.now() - start);

  if (res.status !== 200) {
    wsErrors.add(1);
    return null;
  }

  const body = JSON.parse(res.body);
  return body.token;
}

export default function () {
  const vuId = __VU;
  const username = `${USERNAME_PREFIX}${vuId}`;

  // Authenticate
  const token = authenticate(username);
  if (!token) {
    sleep(1);
    return;
  }

  // Connect WebSocket
  const connectStart = Date.now();
  const res = ws.connect(WS_URL, null, function (socket) {
    wsConnectTime.add(Date.now() - connectStart);
    wsConnections.add(1);

    // Send auth on connect
    socket.send(
      JSON.stringify({
        type: "auth",
        token: token,
      }),
    );

    // Handle incoming messages
    socket.on("message", function (msg) {
      try {
        const data = JSON.parse(msg);

        // After auth_ok, focus a channel and start sending
        if (data.type === "ready") {
          socket.send(
            JSON.stringify({
              type: "channel_focus",
              channel_id: CHANNEL_ID,
            }),
          );
        }
      } catch (_e) {
        wsErrors.add(1);
      }
    });

    socket.on("error", function (_e) {
      wsErrors.add(1);
    });

    // Send messages periodically (respecting rate limits)
    let msgCount = 0;
    const maxMessages = 10;

    socket.setInterval(function () {
      if (msgCount >= maxMessages) {
        socket.close();
        return;
      }

      const msg = JSON.stringify({
        type: "chat_send",
        channel_id: CHANNEL_ID,
        content: `Load test message ${vuId}-${msgCount} at ${Date.now()}`,
      });

      socket.send(msg);
      wsMessages.add(1);
      wsMessageRate.add(true);
      msgCount++;
    }, 2000); // 1 message every 2 seconds (well under rate limit)

    // Send typing indicators
    socket.setInterval(function () {
      if (msgCount < maxMessages) {
        socket.send(
          JSON.stringify({
            type: "typing",
            channel_id: CHANNEL_ID,
          }),
        );
      }
    }, 4000); // 1 typing every 4 seconds (under 1/3s limit)

    // Send presence updates
    socket.setInterval(function () {
      socket.send(
        JSON.stringify({
          type: "presence",
          status: "online",
        }),
      );
    }, 15000); // 1 presence every 15 seconds (under 1/10s limit)

    // Keep connection alive for the test duration
    socket.setTimeout(function () {
      socket.close();
    }, 25000);
  });

  check(res, {
    "WebSocket status is 101": (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
    wsMessageRate.add(false);
  }

  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }),
    "reports/k6-summary.json": JSON.stringify(data, null, 2),
  };
}

// Built-in k6 text summary
function textSummary(data, opts) {
  // k6 handles this automatically when not overridden
  return JSON.stringify(data, null, 2);
}
