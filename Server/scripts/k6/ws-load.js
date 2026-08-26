// k6 WebSocket load test for OwnCord server
// Run: k6 run --vus 50 --duration 60s scripts/k6/ws-load.js
//
// The wire protocol is the envelope format from docs/protocol.md: every
// client->server frame is {type, id?, payload:{...}} and the first frame MUST
// be an `auth` envelope. If you change protocol/schema.json, grep this
// script — it is not generated and CI does not run it, so it rots silently
// (it once drifted to pre-envelope framing and reported green while every
// auth failed).
//
// Prerequisites: the target server must already have the loadtest users
// (K6_USERNAME<vu-number>, all sharing K6_PASSWORD) registered, and the
// target channel readable by them.
//
// Environment variables:
//   K6_WS_URL     - WebSocket URL (default: wss://localhost:8443/api/v1/ws)
//   K6_HTTP_URL   - HTTP base URL (default: https://localhost:8443)
//   K6_USERNAME   - Test user prefix (default: loadtest)
//   K6_PASSWORD   - Test user password (default: LoadTest123!)
//   K6_CHANNEL_ID - Channel ID to send messages in (default: 1)
//
// Self-signed TLS (the default server cert): run k6 with --insecure-skip-tls-verify.

import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Custom metrics
const wsConnections = new Counter("ws_connections");
const wsAuthed = new Counter("ws_authed");
const wsReady = new Counter("ws_ready");
const wsMessages = new Counter("ws_messages_sent");
const wsAcks = new Counter("ws_send_acks");
const wsErrors = new Counter("ws_errors");
const wsConnectTime = new Trend("ws_connect_time", true);
const wsMessageRate = new Rate("ws_message_success");
const authTime = new Trend("auth_time", true);
const broadcastLatency = new Trend("ws_broadcast_latency_ms", true);

// Configuration
const WS_URL = __ENV.K6_WS_URL || "wss://localhost:8443/api/v1/ws";
const HTTP_URL = __ENV.K6_HTTP_URL || "https://localhost:8443";
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
        { duration: "10s", target: 10 }, // warm up
        { duration: "30s", target: 50 }, // ramp to 50
        { duration: "60s", target: 50 }, // sustain
        { duration: "10s", target: 100 }, // spike
        { duration: "30s", target: 100 }, // sustain spike
        { duration: "10s", target: 0 }, // ramp down
      ],
    },
  },
  thresholds: {
    ws_connect_time: ["p(95)<2000"], // 95% connect under 2s
    ws_message_success: ["rate>0.95"], // 95% of sends acked
    ws_errors: ["count<50"], // fewer than 50 errors
    auth_time: ["p(95)<1000"], // 95% auth under 1s
    // A run where nobody authenticated or went ready is a broken run, no
    // matter how green everything else looks — this is the assertion that
    // was missing when the script drifted off the wire protocol.
    ws_authed: ["count>0"],
    ws_ready: ["count>0"],
  },
};

// envelope wraps a client->server frame in the protocol's outer shape.
function envelope(type, payload) {
  return JSON.stringify({ type: type, payload: payload });
}

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

    let authed = false;
    let ready = false;
    let msgCount = 0;
    const maxMessages = 10;
    const pendingSends = {}; // send-id -> Date.now() at send

    // First frame must be the auth envelope (serve_auth.go).
    socket.send(envelope("auth", { token: token }));

    socket.on("message", function (msg) {
      try {
        const data = JSON.parse(msg);
        switch (data.type) {
          case "auth_ok":
            authed = true;
            wsAuthed.add(1);
            break;
          case "auth_error":
            wsErrors.add(1);
            socket.close();
            break;
          case "ready":
            ready = true;
            wsReady.add(1);
            socket.send(envelope("channel_focus", { channel_id: CHANNEL_ID }));
            break;
          case "chat_send_ok":
            wsAcks.add(1);
            wsMessageRate.add(true);
            if (data.id && pendingSends[data.id]) {
              broadcastLatency.add(Date.now() - pendingSends[data.id]);
              delete pendingSends[data.id];
            }
            break;
          case "error":
            wsErrors.add(1);
            wsMessageRate.add(false);
            break;
          default:
            // Broadcast traffic (chat_message, presence, typing, seq'd
            // frames) — receiving it is the point of the load, no assertion.
            break;
        }
      } catch (_e) {
        wsErrors.add(1);
      }
    });

    socket.on("error", function (_e) {
      wsErrors.add(1);
    });

    // Send messages periodically (respecting rate limits). Gated on ready:
    // sends before the session is established only measure error handling.
    socket.setInterval(function () {
      if (!ready) {
        return;
      }
      if (msgCount >= maxMessages) {
        socket.close();
        return;
      }
      const id = `${vuId}-${msgCount}-${Date.now()}`;
      pendingSends[id] = Date.now();
      socket.send(
        JSON.stringify({
          type: "chat_send",
          id: id,
          payload: {
            channel_id: CHANNEL_ID,
            content: `Load test message ${vuId}-${msgCount}`,
          },
        }),
      );
      wsMessages.add(1);
      msgCount++;
    }, 2000); // 1 message every 2 seconds (well under rate limit)

    // Typing indicators (client->server type is typing_start, not "typing").
    socket.setInterval(function () {
      if (ready && msgCount < maxMessages) {
        socket.send(envelope("typing_start", { channel_id: CHANNEL_ID }));
      }
    }, 4000);

    // Presence updates (client->server type is presence_update; bare
    // "presence" is the server->client broadcast).
    socket.setInterval(function () {
      if (authed) {
        socket.send(envelope("presence_update", { status: "online" }));
      }
    }, 15000);

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
