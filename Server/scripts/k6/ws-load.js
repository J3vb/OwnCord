// k6 WebSocket load test for OwnCord server — the BPR-030 capacity profile.
//
// The wire protocol is the envelope format from docs/protocol.md: every
// client->server frame is {type, id?, payload:{...}} and the first frame MUST
// be an `auth` envelope. If you change protocol/schema.json, grep this
// script — it is not generated and CI does not run it, so it rots silently
// (it once drifted to pre-envelope framing and reported green while every
// auth failed). Every frame type used below was re-read against
// docs/protocol.md on 2026-09-12 for B6-9.
//
// Prerequisites: the target server must already have the loadtest users
// (K6_USERNAME<vu-number>, all sharing K6_PASSWORD) registered, and the
// target channel readable by them. BPR-030's profile is 250 registered users
// while K6_PEAK_VUS of them are connected; seeding all 250 is the caller's job
// (.github/workflows/load-baseline.yml).
//
// Environment variables:
//   K6_WS_URL           - WebSocket URL (default: wss://localhost:8443/api/v1/ws)
//   K6_HTTP_URL         - HTTP base URL (default: https://localhost:8443)
//   K6_USERNAME         - Test user prefix (default: loadtest)
//   K6_PASSWORD         - Test user password (default: LoadTest123!)
//   K6_CHANNEL_ID       - Text channel to send messages in (default: 1)
//   K6_PEAK_VUS         - Peak simultaneous connections (default: 100)
//   K6_RAMP             - Ramp-up duration (default: 60s)
//   K6_SUSTAIN          - Duration at peak (default: 180s)
//   K6_SEND_INTERVAL_MS - Per-connection send interval (default: 2000)
//   K6_VOICE_CHANNEL_ID - Voice channel id; unset disables the voice leg
//   K6_VOICE_VUS        - How many VUs join voice (default: 25 when the
//                         voice channel is set, 0 otherwise)
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

// B6-9 additions. Each one is a budget row in docs/capacity.md that had no
// measurement behind it.
//
// ws_auth_ok_time is NOT ws_connect_time: the latter stops the moment the
// socket opens, which is before the `auth` envelope has even been sent. The
// budget is "WebSocket open -> auth_ok received", i.e. the server's in-band
// session admission, so it needs its own clock.
const wsAuthOkTime = new Trend("ws_auth_ok_time", true);
// Recipient delivery, not sender acknowledgement. ws_broadcast_latency_ms is
// keyed off the sender's own chat_send_ok; the B3 carryover said so in as many
// words. This measures a chat_message arriving at a DIFFERENT connection.
const deliveryLatency = new Trend("ws_delivery_latency_ms", true);
const deliveries = new Counter("ws_deliveries");
// The OwnCord half of the voice-join budget: voice_join -> voice_token. The
// LiveKit half needs a WebRTC stack k6 does not have; Server/scripts/voice-load.sh
// carries it and docs/capacity.md publishes the two halves separately.
const voiceJoinTime = new Trend("voice_join_time", true);
const voiceTokens = new Counter("voice_tokens");

// Configuration
const WS_URL = __ENV.K6_WS_URL || "wss://localhost:8443/api/v1/ws";
const HTTP_URL = __ENV.K6_HTTP_URL || "https://localhost:8443";
const USERNAME_PREFIX = __ENV.K6_USERNAME || "loadtest";
const PASSWORD = __ENV.K6_PASSWORD || "LoadTest123!";
const CHANNEL_ID = parseInt(__ENV.K6_CHANNEL_ID || "1");
const PEAK_VUS = parseInt(__ENV.K6_PEAK_VUS || "100");
const RAMP = __ENV.K6_RAMP || "60s";
const SUSTAIN = __ENV.K6_SUSTAIN || "180s";
const RAMP_DOWN = "20s";
const SEND_INTERVAL_MS = parseInt(__ENV.K6_SEND_INTERVAL_MS || "2000");
const VOICE_CHANNEL_ID = parseInt(__ENV.K6_VOICE_CHANNEL_ID || "0");
const VOICE_VUS = VOICE_CHANNEL_ID ? parseInt(__ENV.K6_VOICE_VUS || "25") : 0;

// seconds parses k6's duration strings well enough for the two knobs above.
function seconds(d) {
  if (d.endsWith("ms")) return parseFloat(d) / 1000;
  if (d.endsWith("m")) return parseFloat(d) * 60;
  return parseFloat(d);
}

// A connection is held for the WHOLE run, not for a fixed 25 seconds.
// "100 simultaneous connections" is the claim under test: if each VU closed
// its socket mid-run and re-iterated, the peak would only hold in the gaps
// between iterations, and the number published would be a ceiling nobody
// sustained. k6 closes whatever is still open during ramp-down.
const HOLD_MS = (seconds(RAMP) + seconds(SUSTAIN) + seconds(RAMP_DOWN)) * 1000;

export const options = {
  // k6's default trend stats stop at p(95), and the threshold engine computes
  // p(99) without ever putting it in the summary. docs/capacity.md publishes
  // p99 for every budget row, so it has to be asked for here or the artifact
  // that feeds the document simply does not contain the number.
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max", "count"],
  scenarios: {
    // BPR-030's profile: ramp to the peak, hold it, then drain.
    websocket_load: {
      executor: "ramping-vus",
      startVUs: 0,
      // Long enough to let a held socket be closed rather than killed; the
      // default would cut the ramp-down short at this hold length.
      gracefulRampDown: "30s",
      gracefulStop: "30s",
      stages: [
        { duration: RAMP, target: PEAK_VUS },
        { duration: SUSTAIN, target: PEAK_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
    },
  },
  thresholds: {
    ws_connect_time: ["p(95)<2000"], // 95% connect under 2s
    ws_message_success: ["rate>0.95"], // 95% of sends acked
    ws_errors: ["count<50"], // fewer than 50 errors
    // docs/capacity.md, "REST login". p99 is new in B6-9.
    auth_time: ["p(95)<1000", "p(99)<2000"],
    // docs/capacity.md, "WebSocket open -> auth_ok received". Both new.
    ws_auth_ok_time: ["p(95)<1000", "p(99)<2000"],
    // docs/capacity.md, "message send -> sender acknowledgement". The metric
    // existed with no threshold at all, so it could not fail.
    ws_broadcast_latency_ms: ["p(95)<200", "p(99)<500"],
    // docs/capacity.md, "message send -> recipient delivery". Both new.
    ws_delivery_latency_ms: ["p(95)<250", "p(99)<500"],
    // A run where nobody authenticated, went ready, or received anyone
    // else's message is a broken run, no matter how green everything else
    // looks — this is the assertion that was missing when the script drifted
    // off the wire protocol. A percentile over an empty sample passes.
    ws_authed: ["count>0"],
    ws_ready: ["count>0"],
    ws_deliveries: ["count>0"],
    // Voice thresholds only exist when the voice leg does: a `count>0` on a
    // deliberately-disabled leg would fail every non-voice run, while a bare
    // p95 over zero samples would pass a run where voice was silently off.
    ...(VOICE_VUS > 0
      ? {
          voice_join_time: ["p(95)<2000", "p(99)<4000"],
          voice_tokens: ["count>0"],
        }
      : {}),
  },
};

// envelope wraps a client->server frame in the protocol's outer shape.
function envelope(type, payload) {
  return JSON.stringify({ type: type, payload: payload });
}

// sentAt / sentBy read the send timestamp and sender back out of a
// chat_message's content.
//
// The timestamp rides in the content rather than in client_message_id because
// that field is validated to exactly 50 characters of
// "<13-digit ms>:<lowercase UUID v4>" (service/message_delivery.go), and every
// keyed send also commits a delivery-receipt row — a second code path under
// measurement for free. Content is echoed verbatim by the broadcast
// (docs/protocol.md, chat_message) and sanitisation leaves "t=1757..." alone.
//
// Every VU shares one k6 process and one wall clock, so a timestamp written by
// VU 7 is directly comparable in VU 52.
const SENT_AT = /\bt=(\d{13})\b/;
const SENT_BY = /\bv=(\d+)\b/;
function sentAt(content) {
  const t = SENT_AT.exec(content || "");
  return t ? parseInt(t[1]) : 0;
}
function sentBy(content) {
  const v = SENT_BY.exec(content || "");
  return v ? parseInt(v[1]) : 0;
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
  const joinsVoice = VOICE_VUS > 0 && vuId <= VOICE_VUS;

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
    const pendingSends = {}; // send-id -> Date.now() at send
    let voiceJoinSent = 0;

    // First frame must be the auth envelope (serve_auth.go). The clock for
    // ws_auth_ok_time starts here, after the socket is open.
    const authSentAt = Date.now();
    socket.send(envelope("auth", { token: token }));

    socket.on("message", function (msg) {
      try {
        const data = JSON.parse(msg);
        switch (data.type) {
          case "auth_ok":
            authed = true;
            wsAuthed.add(1);
            wsAuthOkTime.add(Date.now() - authSentAt);
            break;
          case "auth_error":
            wsErrors.add(1);
            socket.close();
            break;
          case "ready":
            ready = true;
            wsReady.add(1);
            // The channel subscription comes from this round trip: before it
            // completes, nothing broadcast to the channel reaches this
            // connection at all (docs/protocol.md, active_channel_id).
            socket.send(envelope("channel_focus", { channel_id: CHANNEL_ID }));
            if (joinsVoice) {
              voiceJoinSent = Date.now();
              socket.send(envelope("voice_join", { channel_id: VOICE_CHANNEL_ID }));
            }
            break;
          case "chat_send_ok":
            wsAcks.add(1);
            wsMessageRate.add(true);
            if (data.id && pendingSends[data.id]) {
              broadcastLatency.add(Date.now() - pendingSends[data.id]);
              delete pendingSends[data.id];
            }
            break;
          case "chat_message": {
            // Recipient delivery. A sender also receives its own broadcast,
            // and timing that would measure the sender's round trip a second
            // time — the budget says recipient, so own echoes are skipped.
            const content = data.payload && data.payload.content;
            const from = sentBy(content);
            const at = sentAt(content);
            if (at && from && from !== vuId) {
              deliveryLatency.add(Date.now() - at);
              deliveries.add(1);
            }
            break;
          }
          case "voice_token":
            // voice_join's first reply (docs/protocol.md, reply order 1-4).
            // This is the OwnCord half of the voice-join budget: session
            // admission plus the LiveKit JWT, with no SFU connect in it.
            if (voiceJoinSent) {
              voiceJoinTime.add(Date.now() - voiceJoinSent);
              voiceJoinSent = 0;
            }
            voiceTokens.add(1);
            break;
          case "error":
            wsErrors.add(1);
            wsMessageRate.add(false);
            break;
          default:
            // Broadcast traffic (presence, typing, voice_state, seq'd
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
    // The interval keeps running for the whole hold — there is no message cap,
    // because the sustained fan-out IS the load being measured.
    socket.setInterval(function () {
      if (!ready) {
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
            // t= and v= are read back by every other connection; see sentAt.
            content: `Load test message ${vuId}-${msgCount} t=${Date.now()} v=${vuId}`,
          },
        }),
      );
      wsMessages.add(1);
      msgCount++;
    }, SEND_INTERVAL_MS); // chat_send is 10/sec; 1 per 2s is well under it

    // Typing indicators (client->server type is typing_start, not "typing").
    socket.setInterval(function () {
      if (ready) {
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

    // Leave voice before the socket goes, so the run exercises the leave path
    // rather than relying on disconnect cleanup to tidy up 25 voice states.
    if (joinsVoice) {
      socket.setTimeout(function () {
        socket.send(envelope("voice_leave", {}));
      }, HOLD_MS - 2000);
    }

    // Hold the connection for the whole run (see HOLD_MS).
    socket.setTimeout(function () {
      socket.close();
    }, HOLD_MS);
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

// k6's own text summary is not importable from a script without jslib, so an
// overridden handleSummary can only emit JSON. The file is the artifact the
// workflow uploads; stdout carries the same bytes for a local run.
export function handleSummary(data) {
  return {
    stdout: JSON.stringify(data, null, 2),
    "reports/k6-summary.json": JSON.stringify(data, null, 2),
  };
}
