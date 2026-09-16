// k6 WebSocket load test for OwnCord server — the BPR-030 capacity profile
// (B6-9) plus the B6-10 operational profiles: reconnect storm + per-phase
// observer (`operational`), the connection-ceiling search (`ceiling-search`),
// and the restart drill (`restart`).
//
// The wire protocol is the envelope format from docs/protocol.md: every
// client->server frame is {type, id?, payload:{...}} and the first frame MUST
// be an `auth` envelope. If you change protocol/schema.json, grep this
// script — it is not generated and CI does not run it, so it rots silently
// (it once drifted to pre-envelope framing and reported green while every
// auth failed). Every frame type used below was re-read against
// docs/protocol.md on 2026-09-12 for B6-9 and re-verified 2026-09-15 for
// B6-10: auth.last_seq (protocol.md:141), auth.active_channel_id
// (protocol.md:150-160, honoured on a resume and re-checked server-side),
// auth_ok.replay_source (protocol.md:192, none|buffer|db), the three-tier
// replay pipeline (protocol.md:305-315: in-memory ring 1000, events table
// 5000), channel_focus remaining idempotent after auth_ok (protocol.md:160),
// voice_join and its reply order (protocol.md:1241-1251), the voice_leave
// broadcast (protocol.md:1250-1276), voice_state (protocol.md:1323 — the
// sequenced broadcast carries user_id and username, and nothing the sender
// controls), and server_restart {reason, delay_seconds} (protocol.md:1815).
//
// K6_PROFILE selects the scenario set, and it is the only knob that changes
// scenarios or thresholds:
//
//   capacity (default) — the B6-9 run: same scenario, same thresholds, same
//     metric names. Every B6-10 code path below is gated on the other
//     profiles and emits nothing otherwise; the new metrics are only
//     *registered* on non-capacity profiles, so a capacity run's
//     k6-summary.json metric key set stays byte-identical. authenticate()'s
//     bounded login retry is gated too: on capacity it is one attempt, timed
//     whatever the outcome, a refusal counts one ws_error, and the caller
//     sleeps a second — B6-9's login path, unchanged.
//   operational — the 100-connection sustain PLUS, concurrently: the observer
//     VU polling /api/v1/metrics every 5 s (per-phase deltas), the reconnect
//     storm (every socket closes at K6_RAMP + K6_STORM_AT on the scenario
//     clock, reconnects with last_seq + active_channel_id and resumes), the voice churn (voice VUs leave+rejoin on epoch-aligned
//     K6_VOICE_CHURN_MS boundaries), and the upload-admission scenario. No
//     voice-load.sh SFU cohort — the churn exercises the control plane, not
//     the media path.
//   restart — 100 connections at the capacity rate; the workflow (or the
//     operator) stops the server 30 s into the sustain (60 s ramp + 30 s =
//     90 s from run start) and boots it again on the same data dir. k6 keeps
//     sending through the frame's delay_seconds drain window, then reconnects
//     with last_seq + active_channel_id and measures the resume.
//   ceiling-search — one ramping-vus scenario stepping connections by
//     K6_CEILING_STEP from 100 to K6_CEILING_MAX, ramping each step in over
//     30 s and then holding it 60 s, sending at the capacity rate, with the
//     observer VU recording the writer-wait delta per step. Every trend is
//     tagged step=<n> (delivery and acknowledgement only during the hold —
//     the ramp-in is tagged step=<n>-ramp and folds into the aggregate); the
//     steps are informational and no threshold gates any of them.
//
// Logins are paced everywhere, never burst. POST /api/v1/auth/login sits
// behind a process-wide bcrypt admission budget of max(2*NumCPU, 4) — four
// slots on the constrained leg, ~13 admissions/s — and a per-IP window that
// counts REFUSED attempts too (api/middleware.go, "one timestamp per call").
// A hundred VUs logging in at the same instant therefore refuse each other,
// their retries burn the per-IP window, and the whole cohort gives up: the
// second B6-10 dispatch connected 189 of 500 ceiling sockets and lost every
// uploads VU that way. So the uploads scenario ramps its VUs in like the
// WebSocket scenario does, each ceiling step ramps in over 30 s, and a VU
// that still cannot log in sits the run out rather than iterating again.
//
// Prerequisites: the target server must already have the loadtest users
// (K6_USERNAME<vu-number>, all sharing K6_PASSWORD) registered, and the
// target channel readable by them. BPR-030's profile is 250 registered users
// while K6_PEAK_VUS of them are connected; seeding all 250 is the caller's job
// (.github/workflows/load-baseline.yml). k6 numbers VUs once per test, not
// per scenario, and every VU logs in as loadtest<its own id>, so the uploads
// VUs are loadtest accounts the WebSocket VUs never use (one VU, one account,
// all inside the 250 seeded) and per-user quota cycles cleanly: 4 admits →
// refuses at K6_UPLOAD_BYTES and user_quota_mb=1.
//
// Environment variables:
//   K6_PROFILE          - capacity (default) | operational | restart |
//                         ceiling-search
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
//   K6_STORM_AT         - operational: seconds into the sustain (after
//                         K6_RAMP) at which every socket closes at once and
//                         reconnects — one wave, anchored on the scenario
//                         clock (default: 120)
//   K6_VOICE_CHURN_MS   - operational: voice leave+rejoin period (default: 10000)
//   K6_UPLOAD_BYTES     - operational: per-upload payload size (default: 262144)
//   K6_CEILING_MAX      - ceiling-search: highest connection count probed (default: 500)
//   K6_CEILING_STEP     - ceiling-search: connection increment per step (default: 100)
//
// Self-signed TLS (the default server cert): run k6 with --insecure-skip-tls-verify.

import ws from "k6/ws";
import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Gauge, Rate, Trend } from "k6/metrics";

// Configuration
const PROFILE = __ENV.K6_PROFILE || "capacity";
if (!["capacity", "operational", "restart", "ceiling-search"].includes(PROFILE)) {
  throw new Error(
    `K6_PROFILE must be "capacity", "operational", "restart" or "ceiling-search" (got: ${PROFILE})`,
  );
}
const IS_OPERATIONAL = PROFILE === "operational";
const IS_RESTART = PROFILE === "restart";
const IS_CEILING = PROFILE === "ceiling-search";
// The B6-10 profiles. A metric registered under this flag must not exist on a
// capacity run: that summary's metric key set is B6-9's, byte for byte.
const IS_B6_10 = PROFILE !== "capacity";
// The observer scenario and its metrics run under operational and
// ceiling-search — one measures per phase, the other per step.
const OBS_ON = IS_OPERATIONAL || IS_CEILING;
// k6 hands out VU ids test-wide from a pool filled in VU-init completion
// order, so which id the observer holds is NOT deterministic: a dispatch on
// 77fdce30 gave a WebSocket VU id 1, and the old `__VU - OBS_VUS` username
// logged it in as loadtest0 (never seeded, 401, login_giveups red). Every VU
// therefore logs in as loadtest<__VU> — one VU, one account, no arithmetic —
// and the caller seeds at least vus_max accounts. The "first VOICE_VUS VUs
// join voice" rule widens by the observer's slot, whichever id it took.
const OBS_VUS = OBS_ON ? 1 : 0;
// The resume path (last_seq + active_channel_id) runs under operational and
// restart: the storm closes and reopens sockets, the drill loses the process.
const RESUMES_ON = IS_OPERATIONAL || IS_RESTART;

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
// The OwnCord half of the voice-join budget: voice_join → voice_token. The
// LiveKit half needs a WebRTC stack k6 does not have; Server/scripts/voice-load.sh
// carries it and docs/capacity.md publishes the two halves separately.
const voiceJoinTime = new Trend("voice_join_time", true);
const voiceTokens = new Counter("voice_tokens");

// B6-10 additions. Registered only on non-capacity profiles: a capacity
// run's summary metric key set stays byte-identical to the B6-9 script's.
// Measurement only — no new latency budgets; the only thresholds these get
// are count>0 / max==0 / count==0 sanity gates, profile-gated below.
const wsResumeTime = RESUMES_ON ? new Trend("ws_resume_time", true) : null;
const wsReplaySource = RESUMES_ON ? new Counter("ws_replay_source") : null;
const wsReplayGap = RESUMES_ON ? new Trend("ws_replay_gap", true) : null;
const voiceStateDelivery = IS_OPERATIONAL ? new Trend("voice_state_delivery_ms", true) : null;
const uploadAdmitTime = IS_OPERATIONAL ? new Trend("upload_admit_time", true) : null;
const uploadRefuseTime = IS_OPERATIONAL ? new Trend("upload_refuse_time", true) : null;
const uploadLowDisk = IS_OPERATIONAL ? new Counter("upload_low_disk") : null;
const uploadOversize = IS_OPERATIONAL ? new Counter("upload_oversize") : null;
const downloadTime = IS_OPERATIONAL ? new Trend("download_time", true) : null;

// The phase-happened gates. k6 rejects a `count` threshold on a Trend metric
// ("unsupported aggregation method count on metric of type trend"), so the
// count>0 sanity gates every new phase was to get live on paired counters,
// not on the trends themselves — a threshold on a trend can only say
// something about the values, never that the sample was non-empty.
const wsResumes = RESUMES_ON ? new Counter("ws_resumes") : null;
const voiceStates = IS_OPERATIONAL ? new Counter("voice_states") : null;
const uploadAdmits = IS_OPERATIONAL ? new Counter("upload_admits") : null;
const uploadRefuses = IS_OPERATIONAL ? new Counter("upload_refuses") : null;
const downloads = IS_OPERATIONAL ? new Counter("downloads") : null;

// The two 429s POST /api/v1/auth/login can answer with, split out so a refusal
// the server made on purpose is never counted as a WebSocket error.
//
// They are different gates and only one is about the server. The per-IP sliding
// window (api/middleware.go:251) sets Retry-After and fires because every
// generator shares one address — an artifact of this topology, which is what
// OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER is for. The process-wide bcrypt
// admission budget (auth/admission.go:60) sets no Retry-After and is sized
// max(2*NumCPU, 4), i.e. 4 concurrent compares on the constrained leg — a real
// operational signal, and the one that binds a simultaneous login burst.
//
// Neither is a defect: both refuse before any bcrypt runs and charge no lockout
// attempt. Both cost the VU its token, so both have to be visible.
const authRateLimited = IS_B6_10 ? new Counter("auth_rate_limited") : null;
const authAdmissionRefused = IS_B6_10 ? new Counter("auth_admission_refused") : null;
// A VU that never obtained a token never connects, and a run full of those
// still reports green. This counter is the gate that says so.
const loginGiveUps = IS_B6_10 ? new Counter("login_giveups") : null;

// Restart-drill metrics (K6_PROFILE=restart). The frame is the sequenced
// server_restart broadcast (protocol.md:1815-1826, reason + delay_seconds);
// the 30 s drain budget it promises is what the workflow asserts from the
// outside (drain_ms, rc).
const serverRestartReceived = IS_RESTART ? new Counter("server_restart_received") : null;
const serverRestartLead = IS_RESTART ? new Trend("server_restart_lead_ms", true) : null;
const restartResumeTime = IS_RESTART ? new Trend("restart_resume_time", true) : null;
// Sends attempted after the server_restart frame and before the socket
// closes, classified acked / errored / unanswered; anything unanswered AND
// absent from every post-restart replay is a lost message (a ledger finding,
// never a doc number).
const drainSends = IS_RESTART ? new Counter("sends_during_drain") : null;
const sendsLost = IS_RESTART ? new Counter("sends_lost") : null;

// The observer's window onto the server, one poll every 5 s (operational and
// ceiling-search; the VU polls /api/v1/metrics — IP-restricted, and the load
// generator is on the same loopback — with no token). Each entry records the
// DELTA since the previous poll, tagged phase=<ramp|sustain|storm|upload>
// under operational and step=<n> under the search: a
// phase's count is its total delta over that window, which is what the
// document publishes, not the end-of-run cumulative B6-9 recorded.
// The observer's phase windows, in obsPhase()'s vocabulary. Declared here
// because the threshold block below runs at module init, before obsPhase.
const PHASES = ["ramp", "sustain", "storm", "upload"];
const obsPollTime = OBS_ON ? new Trend("obs_poll_time", true) : null;
const obsDbWriterWaitCount = OBS_ON ? new Counter("obs_db_writer_wait_count") : null;
const obsDbWriterWaitSeconds = OBS_ON ? new Counter("obs_db_writer_wait_seconds") : null;
const obsDbReaderWaitCount = OBS_ON ? new Counter("obs_db_reader_wait_count") : null;
const obsDbReaderWaitSeconds = OBS_ON ? new Counter("obs_db_reader_wait_seconds") : null;
const obsReconnectTier = IS_OPERATIONAL ? new Counter("obs_reconnect_tier") : null;
const obsBackpressure = IS_OPERATIONAL ? new Counter("obs_backpressure") : null;
const obsConnRejects = OBS_ON ? new Counter("obs_ws_conn_rejects") : null;
// The ceiling search's per-step population, read from the server's own
// connected_users (api/metrics_handler.go). ws_connections cannot answer it:
// it counts ARRIVALS in a window, so a step that held 300 sockets opened by
// earlier steps records none of them. A level, so a Gauge.
const obsConnectedUsers = IS_CEILING ? new Gauge("obs_connected_users") : null;
const obsUploadStorage = IS_OPERATIONAL ? new Gauge("obs_upload_storage_used_mb") : null;

// --- configuration ---------------------------------------------------------

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
// B6-10 knobs. Each name was checked against k6's own option names (K6_VUS
// collided in B6-9); none is one.
const STORM_AT = parseInt(__ENV.K6_STORM_AT || "120"); // seconds
const CHURN_MS = parseInt(__ENV.K6_VOICE_CHURN_MS || "10000");
const UPLOAD_BYTES = parseInt(__ENV.K6_UPLOAD_BYTES || "262144");
// Ceiling-search knobs. The search probes CEILING_START connections, then
// steps by K6_CEILING_STEP, ramping each step in over CEILING_RAMP_S and
// holding it CEILING_HOLD_S, up to K6_CEILING_MAX; the caller must have
// registered at least K6_CEILING_MAX loadtest users for the top step to
// fully connect. 100 logins over 30 s is ~3/s against the constrained leg's
// ~13 admissions/s; a 0 s jump was 100 logins at once, and the header above
// says what that did.
const CEILING_START = 100;
const CEILING_RAMP_S = 30;
const CEILING_HOLD_S = 60;
const CEILING_PERIOD_S = CEILING_RAMP_S + CEILING_HOLD_S;
// The uploads scenario's login ramp: PEAK_VUS logins over this many seconds,
// for the same reason. 30 s keeps it clear of the storm window.
const UPLOAD_RAMP_S = 30;
const CEILING_MAX = parseInt(__ENV.K6_CEILING_MAX || "500");
const CEILING_STEP = parseInt(__ENV.K6_CEILING_STEP || "100");
// 1 upload / 10 s = 6/min per user, inside the 10/min limit (docs/api.md:1965).
const UPLOAD_INTERVAL_S = 10;
// Uploads begin this many seconds into the sustain, so the observer has a
// clean sustain slice before upload pressure starts.
const UPLOADS_AT_S = 60;

// seconds parses k6's duration strings well enough for the knobs above.
function seconds(d) {
  if (d.endsWith("ms")) return parseFloat(d) / 1000;
  if (d.endsWith("m")) return parseFloat(d) * 60;
  return parseFloat(d);
}

const RAMP_S = seconds(RAMP);
const SUSTAIN_S = seconds(SUSTAIN);
const UPLOADS_START_S = RAMP_S + UPLOADS_AT_S;
// The storm's fire time: K6_STORM_AT seconds into the sustain, on the
// scenario clock (scenarioStartMs is exec.scenario.startTime for the VU, the
// observer's own start for the phase window — both scenarios start at t=0).
// One shared instant, so the closes land as one wave. It used to be the next
// whole-minute WALL-CLOCK boundary after (hold end − K6_STORM_AT), which
// depends on when the run happened to start: on 77fdce30 that pushed 25 of
// 100 VUs past the ramp-down, and they never got the iteration that resumes.
function stormFireAt(scenarioStartMs) {
  return scenarioStartMs + (RAMP_S + STORM_AT) * 1000;
}

// The ceiling-search schedule. Each step is a CEILING_RAMP_S ramp to the
// target followed by a CEILING_HOLD_S hold at it; a trailing ramp-down drains
// the sockets the same way capacity drains. HOLD_MS below covers the whole
// search, so every VU holds one connection from its first step to the
// ramp-down and the executor's targets ARE the connection counts.
const CEILING_STEPS = [];
for (let v = CEILING_START; v <= CEILING_MAX; v += CEILING_STEP) {
  CEILING_STEPS.push(v);
}
// K6_CEILING_MAX is a probe target, not a grid offset: at max 250 / step 100
// the loop stops at 200 and the run never probes the number it was asked for.
// Everything downstream (stages, step clock, thresholds, total duration)
// iterates this array, so appending the remainder is the whole fix.
if (CEILING_STEPS[CEILING_STEPS.length - 1] < CEILING_MAX) {
  CEILING_STEPS.push(CEILING_MAX);
}
const CEILING_TOTAL_S = CEILING_STEPS.length * CEILING_PERIOD_S + seconds(RAMP_DOWN);
const CEILING_STAGES = CEILING_STEPS.flatMap((v) => [
  { duration: `${CEILING_RAMP_S}s`, target: v },
  { duration: `${CEILING_HOLD_S}s`, target: v },
]).concat([{ duration: RAMP_DOWN, target: 0 }]);
const TOTAL_S = IS_CEILING ? CEILING_TOTAL_S : RAMP_S + SUSTAIN_S + seconds(RAMP_DOWN);

// A connection is held for the WHOLE run, not for a fixed 25 seconds.
// "100 simultaneous connections" is the claim under test: if each VU closed
// its socket mid-run and re-iterated, the peak would only hold in the gaps
// between iterations, and the number published would be a ceiling nobody
// sustained. k6 closes whatever is still open during ramp-down.
const HOLD_MS = TOTAL_S * 1000;

export const options = {
  // k6's default trend stats requested for docs/capacity.md's p99 columns:
  // the threshold engine computes p(99) without putting it in the summary.
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
      // Capacity: ramp to the peak, hold, drain. Ceiling-search: ramp to
      // each step over CEILING_RAMP_S, hold it CEILING_HOLD_S, then the same
      // drain (CEILING_STAGES).
      stages: IS_CEILING
        ? CEILING_STAGES
        : [
            { duration: RAMP, target: PEAK_VUS },
            { duration: SUSTAIN, target: PEAK_VUS },
            { duration: RAMP_DOWN, target: 0 },
          ],
    },
    // The observer runs under operational and ceiling-search, from t=0 so its
    // clock aligns with the run's phases and steps; the uploads scenario only
    // under operational, starting 60 s into the sustain.
    ...(OBS_ON
      ? {
          observer: {
            executor: "constant-vus",
            vus: 1,
            duration: `${TOTAL_S}s`,
            exec: "observerScenario",
          },
        }
      : {}),
    ...(IS_OPERATIONAL
      ? {
          // Ramped in, not started at once: PEAK_VUS logins in one instant
          // is the burst the header describes.
          uploads: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
              { duration: `${UPLOAD_RAMP_S}s`, target: PEAK_VUS },
              { duration: `${TOTAL_S - UPLOADS_START_S - UPLOAD_RAMP_S}s`, target: PEAK_VUS },
            ],
            startTime: `${UPLOADS_START_S}s`,
            exec: "uploadsScenario",
            gracefulStop: "30s",
          },
        }
      : {}),
  },
  thresholds: {
    // The B6-9 capacity budgets. Under ceiling-search they do not gate the
    // run: the search is EXPECTED to find the step where a budget first
    // breaks, so gating the whole run on them would make every search red
    // the moment it works. The document, not the threshold engine, reads the
    // per-step percentiles; the ceiling run still asserts the run was sane
    // (authed/ready/deliveries below).
    ...(IS_CEILING
      ? {}
      : {
          ws_connect_time: ["p(95)<2000"], // 95% connect under 2s
          ws_message_success: ["rate>0.95"], // 95% of sends acked
          // The drill's outage window produces failed connect attempts and
          // error frames that are the drill working, not a defect, so
          // ws_errors does not gate a restart run.
          ...(IS_RESTART ? {} : { ws_errors: ["count<50"] }),
          // docs/capacity.md, "REST login". Tightened from the first
          // qualifying run (measured p95 307 / p99 344 on the constrained
          // leg); bcrypt cost 12 is the floor here, so the headroom left is
          // deliberate and not generous.
          auth_time: ["p(95)<600", "p(99)<1000"],
          // docs/capacity.md, "WebSocket open -> auth_ok received". Tightened
          // from measured p95 13 / p99 29 — the initial budget was 70x the
          // real figure.
          ws_auth_ok_time: ["p(95)<200", "p(99)<500"],
          // docs/capacity.md, "message send -> sender acknowledgement".
          // Tightened from measured p95 57 / p99 83.
          ws_broadcast_latency_ms: ["p(95)<150", "p(99)<300"],
          // docs/capacity.md, "message send -> recipient delivery". Tightened
          // from measured p95 60 / p99 85 over 1.14 million deliveries.
          ws_delivery_latency_ms: ["p(95)<200", "p(99)<400"],
        }),
    // A run where nobody authenticated, went ready, or received anyone
    // else's message is a broken run, no matter how green everything else
    // looks — this is the assertion that was missing when the script drifted
    // off the wire protocol. A percentile over an empty sample passes.
    ws_authed: ["count>0"],
    ws_ready: ["count>0"],
    ws_deliveries: ["count>0"],
    // ...and a run where the VUs that logged in did so is not enough on its
    // own. Under a simultaneous login burst the admission budget refuses most
    // of it (4 concurrent bcrypts on the constrained leg), and a VU that gives
    // up never connects — so the percentiles get computed over whoever made it
    // through, and the run is green while measuring the wrong population. This
    // is the gate that was missing when a ceiling run reported 173 sockets
    // against a vus_max of 501 and passed. Refusals are expected and are not
    // gated; a give-up means the measurement is incomplete.
    ...(IS_B6_10 ? { login_giveups: ["count==0"] } : {}),
    // Voice thresholds only exist when the voice leg does: a `count>0` on a
    // deliberately-disabled leg would fail every non-voice run, while a bare
    // p95 over zero samples would pass a run where voice was silently off.
    ...(VOICE_VUS > 0
      ? {
          // Tightened from measured p95 3 ms / p99 4 ms: this is an HMAC JWT
          // and a session lookup, not a network round trip to an SFU.
          voice_join_time: ["p(95)<250", "p(99)<500"],
          voice_tokens: ["count>0"],
          // The churn's cross-VU voice_state delivery only happens when the
          // voice leg does — an operational run without K6_VOICE_CHANNEL_ID
          // has no voice VUs and must not fail on a leg it never ran.
          ...(IS_OPERATIONAL ? { voice_states: ["count>0"] } : {}),
        }
      : {}),
    // Pass-through thresholds (see passThroughThresholds) that only
    // materialize the tagged operational/restart series in the summary.
    ...(IS_OPERATIONAL || IS_RESTART ? passThroughThresholds() : {}),
    // B6-10 operational sanity gates. No latency budgets: the PRD excludes
    // new targets, so these only assert the phase happened and replay
    // integrity held. Under capacity none of these exist.
    ...(IS_OPERATIONAL
      ? {
          // The storm resumed, and on the tier the protocol documents for an
          // in-process gap: the ring (protocol.md:305-315). tier:none means a
          // resume that served no replay at all — a resume that measured the
          // wrong thing; tier:buffer count>0 proves the storm hit the
          // documented tier.
          // The count>0 gates live on the paired counters above — k6 rejects
          // a count threshold on a Trend.
          // The storm is every connection reconnecting, so the gate is the
          // whole cohort, not one survivor. `>=`, not `==`: a socket that
          // dropped for some other reason also resumes, and that is not a
          // failure of the storm.
          ws_resumes: [`count>=${PEAK_VUS}`],
          ws_replay_gap: ["max==0"],
          "ws_replay_source{tier:none}": ["count==0"],
          "ws_replay_source{tier:buffer}": [`count>=${PEAK_VUS}`],
          // Churn and upload admission: empty-sample traps. A percentile over
          // zero samples passes, so every phase asserts it happened.
          // (voice_states lives with the voice thresholds above: it only
          // exists when the voice leg does.)
          upload_admits: ["count>0"],
          upload_refuses: ["count>0"],
          // A 507 STORAGE_LOW_DISK or a 400 says the scenario or the runner is
          // wrong, not the server (the API's oversize answer is 400, not 413 —
          // docs/api.md:238).
          upload_low_disk: ["count==0"],
          upload_oversize: ["count==0"],
          downloads: ["count>0"],
        }
      : {}),
    // B6-10 restart drill. The drill's own gates: the frame reached every
    // connection, the drain sent something (a 30 s drain always does), and
    // no drain send was lost. Every post-restart resume is served tier none
    // — the per-boot seq floor (OC-0210) renumbers the space and the boot
    // marks visibility changed, so buffer/db replay after a restart is
    // fail-closed unreachable — which is why the gate is tier:none, not
    // tier:db. ws_replay_gap measures contiguity AFTER the post-resume
    // rebase; server_restart_lead_ms and restart_resume_time are
    // measurement-only — the PRD excludes new latency budgets.
    ...(IS_RESTART
      ? {
          // Every held connection, not merely one: the frame's contract is
          // that it reaches all of them, and a drill where 3 of 100 heard it
          // measured nothing. Exactly PEAK_VUS — one frame per connection,
          // counted once (restartReceivedAt guards a repeat).
          server_restart_received: [`count==${PEAK_VUS}`],
          ws_replay_gap: ["max==0"],
          "ws_replay_source{tier:none}": ["count>0"],
          sends_during_drain: ["count>0"],
          sends_lost: ["count==0"],
          // Pass-through thresholds (see passThroughThresholds) that only
          // materialize the pre/post-restart series in the summary.
          "ws_delivery_latency_ms{phase:pre-restart}": ["p(95)>=0"],
          "ws_delivery_latency_ms{phase:post-restart}": ["p(95)>=0"],
          "ws_broadcast_latency_ms{phase:pre-restart}": ["p(95)>=0"],
          "ws_broadcast_latency_ms{phase:post-restart}": ["p(95)>=0"],
        }
      : {}),
    // A cap in config must never be published as the hardware ceiling. Only
    // the max_ws_connections guardrail increments this counter (ws/serve.go:43
    // is its one increment site), so count==0 asserts the cap never bound —
    // which is what makes "the search found the server's ceiling" a claim with
    // evidence behind it rather than an assumption. The workflow sets the cap
    // at twice the probe maximum for exactly this check.
    ...(IS_CEILING ? { obs_ws_conn_rejects: ["count==0"] } : {}),
    // B6-10 ceiling-search. The steps are informational — no threshold gates
    // any of them, and the capacity budgets (above) are not re-gated here: the
    // document, not the threshold engine, reads the per-step percentiles. The
    // base sanity gates already assert the run was sane; what ceiling adds are
    // pass-through thresholds (p(95)>=0 / count>=0 always hold, and an empty
    // series passes) whose only job is to materialize each step as a
    // first-class series in the summary — k6 collapses tagged samples into the
    // aggregate in handleSummary unless a threshold names the sub-metric.
    ...(IS_CEILING ? ceilingStepThresholds() : {}),
  },
}; // envelope wraps a client->server frame in the protocol's outer shape.

// --- ceiling-search step clock ----------------------------------------------

// The run anchor is the executor's own start time. Module scope in k6 is
// per VU, so a `let runStart` set on first use would be each VU's FIRST
// ITERATION, and a VU that joins at step 300 would tag the rest of its run
// two steps low. Both ceiling scenarios (websocket_load and observer) start
// at t=0, so their scenario start times are the same anchor.
function runElapsedS() {
  return (Date.now() - exec.scenario.startTime) / 1000;
}
function runStep() {
  const i = Math.floor(runElapsedS() / CEILING_PERIOD_S);
  return CEILING_STEPS[Math.min(Math.max(i, 0), CEILING_STEPS.length - 1)];
}
function inStepRamp() {
  return runElapsedS() % CEILING_PERIOD_S < CEILING_RAMP_S;
}
// Sample tags for the current step, or undefined outside ceiling-search:
// passing undefined tags to add() leaves the sample untagged, which is what
// the capacity profile wants. Connection-establishment samples (connect,
// login, auth_ok, the connection count) belong to the step whose ramp opened
// them; with holdOnly the delivery and acknowledgement trends tag the ramp-in
// as step=<n>-ramp instead, so a step's published p95/p99 is the 60 s it was
// held at that count and not the 30 s of bcrypt that got it there.
function stepTags(holdOnly) {
  if (!IS_CEILING) return undefined;
  const v = runStep();
  return { step: holdOnly && inStepRamp() ? `${v}-ramp` : String(v) };
}

// Restart-drill phase tags: which side of the stop a sample landed on, so
// the document can say whether a missed budget was the drained server, the
// rebooted one, or both. A resumed connection is by construction post-restart.
function restartTags(resumedConn) {
  return IS_RESTART ? { phase: resumedConn ? "post-restart" : "pre-restart" } : undefined;
}

// The pass-through thresholds, one per (metric, step) pair.
function ceilingStepThresholds() {
  const trends = [
    "ws_connect_time",
    "ws_auth_ok_time",
    "auth_time",
    "ws_broadcast_latency_ms",
    "ws_delivery_latency_ms",
  ];
  // ws_connections belongs here for the same reason as the writer-wait pair —
  // it is the step's arrivals, i.e. how many sockets that step's ramp opened.
  // The population the step actually HELD is obs_connected_users, the server's
  // own count, because sockets opened by an earlier step are still up.
  // A step whose population fell short of its label is generator-limited, and
  // the table has to be able to say so.
  const counters = ["obs_db_writer_wait_count", "obs_db_writer_wait_seconds", "ws_connections"];
  const out = {};
  for (const v of CEILING_STEPS) {
    for (const t of trends) out[`${t}{step:${v}}`] = ["p(95)>=0"];
    for (const c of counters) out[`${c}{step:${v}}`] = ["count>=0"];
    // A Gauge aggregates as value; informational like every step key here.
    out[`obs_connected_users{step:${v}}`] = ["value>=0"];
  }
  return out;
}

// The operational/restart pass-through thresholds, the same trick as
// ceilingStepThresholds(): k6 collapses a tagged sample into its parent metric
// in handleSummary unless a threshold names the sub-metric, and docs/capacity.md
// quotes every series below. count>=0 (Counter), value>=0 (Gauge) and
// p(95)>=0 (Trend) always hold, and an empty series passes — these gate
// nothing, they only make the sub-metric exist in k6-summary.json. Spread
// BEFORE the real gates so a real threshold on the same key wins.
function passThroughThresholds() {
  const out = {};
  const tiers = ["buffer", "db", "none"];
  for (const t of tiers) out[`ws_replay_source{tier:${t}}`] = ["count>=0"];
  if (IS_RESTART) {
    for (const o of ["acked", "errored", "unanswered"]) {
      out[`sends_during_drain{outcome:${o}}`] = ["count>=0"];
    }
    return out; // no observer scenario under the restart drill
  }
  const perPhase = [
    "obs_db_writer_wait_count",
    "obs_db_writer_wait_seconds",
    "obs_db_reader_wait_count",
    "obs_db_reader_wait_seconds",
    "obs_ws_conn_rejects",
  ];
  for (const p of PHASES) {
    for (const c of perPhase) out[`${c}{phase:${p}}`] = ["count>=0"];
    // The one Gauge among the observer's metrics; a Gauge aggregates as value.
    out[`obs_upload_storage_used_mb{phase:${p}}`] = ["value>=0"];
  }
  // Tier and backpressure come in two shapes: the run total per tier/kind,
  // and the per-phase delta (a sub-metric key takes several comma-separated
  // tags, and a sample matches a key whose tags are a subset of its own, so
  // the same sample feeds both). The per-phase pair is what the storm row
  // publishes; the totals stay because the tier split is also a run figure.
  const reconnectTiers = ["buffer", "db", "full"];
  const kinds = ["queue_disconnects", "high_fallbacks", "low_drops"];
  for (const t of reconnectTiers) out[`obs_reconnect_tier{tier:${t}}`] = ["count>=0"];
  for (const k of kinds) out[`obs_backpressure{kind:${k}}`] = ["count>=0"];
  for (const p of PHASES) {
    for (const t of reconnectTiers) out[`obs_reconnect_tier{phase:${p},tier:${t}}`] = ["count>=0"];
    for (const k of kinds) out[`obs_backpressure{phase:${p},kind:${k}}`] = ["count>=0"];
  }
  return out;
}

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

// How many times authenticate() will re-attempt one login before giving up,
// and so the ceiling on how long a VU can spend getting a token. Sized against
// the constrained leg's admission budget (4 concurrent bcrypts at cost 12 ≈ 16
// admissions/s), not against the budget itself — the budget is the server's
// and does not move for a test. Twelve attempts with the backoff below span
// ~45 s.
const LOGIN_ATTEMPTS = 12;

// Login and get session token.
//
// The retry lives here rather than in the callers, because there are two of
// them (the WebSocket loop and the uploads scenario) and a refusal has to be
// handled identically in both. This is the bug that invalidated B6-10's first
// three runs: an unbounded `sleep(1); return` at a call site means ONE
// transient 429 converts that VU into a permanent ~1/s login-hammering loop,
// and the loop is self-sustaining — every retry is refused because every other
// stuck VU is retrying too — so it never recovers on its own.
//
// The artifact counts bear it out. Refusals arrive at a *steady* 24.78/s in the
// operational run and ~224/s in the ceiling run, which is a stuck population,
// not a startup burst. In the operational run the WebSocket side was intact
// (ws_connections and ws_authed both 200 against 100 WS VUs, i.e. every VU
// connected and the storm reconnected each one) — the refusals came from a
// minority of the 100 uploads VUs. In the ceiling run they came from the
// majority: 173 sockets opened against a vus_max of 501, and the run passed
// anyway, because nothing asserted that the VUs had got on the wire.
function authenticate(username) {
  for (let attempt = 0; attempt < LOGIN_ATTEMPTS; attempt++) {
    const start = Date.now();
    const res = http.post(
      `${HTTP_URL}/api/v1/auth/login`,
      JSON.stringify({ username, password: PASSWORD }),
      { headers: { "Content-Type": "application/json" } },
    );

    // Capacity is B6-9's login verbatim: one attempt, timed whatever the
    // outcome, any non-200 (429 included) one ws_error, plain return — the
    // caller's sleep(1) follows. Everything below this line is B6-10's.
    if (!IS_B6_10) {
      authTime.add(Date.now() - start);
      if (res.status !== 200) {
        wsErrors.add(1);
        return null;
      }
      return JSON.parse(res.body).token;
    }

    // A 429 is the server shedding load on purpose, and it is retryable — the
    // admission budget frees its slots every ~250 ms. It is NOT a ws_error:
    // that counter backs the published "0 WebSocket errors" claim, and a run
    // that counted refusals there published a defect that did not exist while
    // hiding the one that did (VUs that never connected).
    if (res.status === 429) {
      // k6 exposes headers under their canonical names, so Retry-After is the
      // one to look for; the lowercase spelling is here only so a k6 that
      // stops canonicalising cannot silently reclassify every per-IP refusal
      // as an admission refusal — which is the distinction this split exists
      // to draw.
      if (res.headers["Retry-After"] ?? res.headers["retry-after"]) authRateLimited.add(1);
      else authAdmissionRefused.add(1);
      // Backoff, so the retries of many stuck VUs de-synchronise instead of
      // arriving in lockstep and re-colliding on the same slots.
      if (attempt < LOGIN_ATTEMPTS - 1) sleep(1 + attempt * 0.5);
      continue;
    }
    if (res.status !== 200) {
      // Counted whatever happens next: a failed login attempt is a real error
      // and the published "0 WebSocket errors" claim has to see it.
      wsErrors.add(1);
      // A transport failure (k6 reports status 0) or a 5xx is transient, and
      // one of them cost the self_signed operational leg on eb344cc8 its run:
      // zero 429s all run, one login answered non-200, and this function gave
      // up on the first attempt — one VU of a hundred took login_giveups to 1
      // and the whole run red. A refusal the server MEANT (400/401/403) is not
      // retryable and still returns at once.
      if ((res.status === 0 || res.status >= 500) && attempt < LOGIN_ATTEMPTS - 1) {
        sleep(1 + attempt * 0.5);
        continue;
      }
      return null;
    }

    // Timed on success only. A refusal returns in ~0 ms, so timing every
    // attempt would drag the auth_time percentiles down and flatter the budget
    // — and "REST login" means a login, not an attempt.
    authTime.add(Date.now() - start, stepTags());

    return JSON.parse(res.body).token;
  }
  return null;
} // Per-VU state. Module scope in k6 is per-VU and persists across
// iterations — the resume path relies on this: when a socket ends, the next
// iteration of the same VU reconnects with the state it kept.
let vuToken = null; // stored session token (a resume does not re-login)
let vuLastSeq = 0; // highest seq this VU has seen on any connection
let vuHoldEnd = 0; // wall-clock ms when this VU's first connection ends
let vuStormDone = false; // the storm already fired for this VU
let vuInVoice = false; // this VU believes it holds a voice session
// Restart drill: contents of this VU's drain sends that got neither an ack
// nor an error before the socket closed. VU scope on purpose — the socket
// they were sent on is gone, and the check happens on the next iteration.
let vuDrainUnanswered = [];

// After the restart, is every unanswered drain send in the channel history?
// The post-restart resume is a full re-sync (tier none), so no replay will
// ever show them; the persisted history is the only place a message that
// was sent-but-never-acked can be found. Pages back through
// GET /api/v1/channels/{id}/messages until the oldest message on the page
// predates the drain (every content carries its send time as t=<ms>), then
// anything still unseen is a lost message.
function accountForDrainSends(token) {
  const unseen = vuDrainUnanswered.slice();
  const oldest = Math.min(...unseen.map(sentAt));
  let before = 0;
  for (let page = 0; page < 50 && unseen.length; page++) {
    const q = `limit=100${before ? `&before=${before}` : ""}`;
    const res = http.get(`${HTTP_URL}/api/v1/channels/${CHANNEL_ID}/messages?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) {
      // The first post-drain iteration usually lands while the server is
      // still booting: an unreadable history says nothing about loss, so
      // keep the list and check again on the next iteration.
      wsErrors.add(1);
      return;
    }
    const msgs = res.json("messages") || [];
    if (!msgs.length) break;
    for (const m of msgs) {
      const at = unseen.indexOf(m.content);
      if (at !== -1) unseen.splice(at, 1);
    }
    const last = msgs[msgs.length - 1];
    if (sentAt(last.content) && sentAt(last.content) < oldest) break;
    before = last.id;
  }
  vuDrainUnanswered = [];
  sendsLost.add(unseen.length);
}

export default function () {
  const vuId = __VU;
  const username = `${USERNAME_PREFIX}${vuId}`;
  // The first VOICE_VUS WebSocket VUs join voice; the observer, when on,
  // holds one of the low ids, so the cut-off makes room for it.
  const joinsVoice = VOICE_VUS > 0 && vuId <= VOICE_VUS + OBS_VUS;

  // A resume is any connection opened after this VU has seen a seq — i.e.
  // every storm reconnect. Capacity never resumes: vuLastSeq stays 0.
  const resumed = RESUMES_ON && vuLastSeq > 0;

  // Resume iterations reuse the stored token (no re-login on resume).
  let token = vuToken;
  if (!token) {
    token = authenticate(username);
    if (!token) {
      // Give up loudly, then sit the run out. The threshold on login_giveups
      // fails the run, because every number in it was measured over a
      // population missing this VU; returning here would start the next
      // iteration at once and turn one give-up into a login loop for the
      // rest of the run (1758 give-ups from 500 VUs, second dispatch).
      // Capacity keeps B6-9's one-second retry loop instead.
      loginGiveUps?.add(1);
      sleep(IS_B6_10 ? TOTAL_S : 1);
      return;
    }
    vuToken = token;
  }

  if (IS_RESTART && vuDrainUnanswered.length) {
    accountForDrainSends(token);
  }

  const connectStart = Date.now();
  const res = ws.connect(WS_URL, null, function (socket) {
    const openAt = Date.now();
    wsConnectTime.add(openAt - connectStart, stepTags());
    // One ARRIVAL, tagged with the step whose ramp opened it — not the
    // population the step held: a socket opened at step 100 is still up at
    // step 300 and is counted by neither. Arrivals are what says whether a
    // step's VUs got on the wire at all (a step where most never got a token
    // is otherwise indistinguishable from one that connected and degraded —
    // how a contaminated ceiling run passed); the population each step held
    // is obs_connected_users, read from the server. Untagged on capacity
    // (stepTags() is undefined there, and k6 leaves an undefined tag off).
    wsConnections.add(1, stepTags());

    let authed = false;
    let ready = false;
    let msgCount = 0;
    let voiceJoinSent = 0;
    let pendingSends = {}; // send-id -> Date.now() at send
    // Restart-drill per-connection state.
    let restartReceivedAt = 0; // Date.now() when server_restart arrived
    let drainPending = {}; // send-id -> content, sent after the frame
    // Per-connection resume bookkeeping.
    const resumedConn = resumed;
    let resumeStartedAt = 0;
    let resumeGap = 0;
    let gapRecorded = false;
    // Post-restart the server's per-boot seq floor (OC-0210) renumbers the
    // sequence space and the boot marks visibility changed, so every
    // post-restart resume is served tier none (full re-sync). The client
    // rebases: the first sequenced frame after such a resume anchors
    // contiguity, and the gap metric only counts skips from there on.
    let rebasing = false;

    let closeIn;
    if (resumedConn) {
      // A resumed connection holds until the ORIGINAL hold end: the VU
      // re-enters the same hold it never left, it just changed sockets.
      closeIn = Math.max(30000, vuHoldEnd - openAt);
    } else {
      vuHoldEnd = openAt + HOLD_MS;
      closeIn = HOLD_MS;
    }

    // First frame must be the auth envelope (serve_auth.go). The clock for
    // ws_auth_ok_time starts here, after the socket is open.
    const authSentAt = Date.now();
    if (resumedConn) {
      // Resume (protocol.md:141,150): last_seq replays everything this VU
      // has not seen; active_channel_id keeps the channel subscribed across
      // the auth_ok round trip — without it the protocol documents a
      // broadcast gap between auth_ok and channel_focus.
      socket.send(
        envelope("auth", {
          token: token,
          last_seq: vuLastSeq,
          active_channel_id: CHANNEL_ID,
        }),
      );
      resumeStartedAt = Date.now();
    } else {
      socket.send(envelope("auth", { token: token }));
    }

    socket.on("message", function (msg) {
      try {
        const data = JSON.parse(msg);

        // Track the highest seq on any sequenced frame (the resuming
        // profiles only; capacity never tracks and never resumes). A resumed connection
        // checks contiguity against its stored last_seq: every skipped seq
        // is a lost frame — a defect, not a latency number. A seq at or
        // below vuLastSeq is replay overlap — already accounted, ignored.
        if (RESUMES_ON && typeof data.seq === "number" && data.seq > 0) {
          if (rebasing) {
            // New numbering: anchor on the first sequenced frame after the
            // full re-sync; the renumbering itself is not a lost frame.
            vuLastSeq = data.seq;
            rebasing = false;
          } else if (data.seq > vuLastSeq) {
            if (resumedConn) resumeGap += data.seq - vuLastSeq - 1;
            vuLastSeq = data.seq;
          }
        }

        switch (data.type) {
          case "auth_ok":
            authed = true;
            wsAuthed.add(1);
            if (resumedConn) {
              wsResumes.add(1);
              wsResumeTime.add(Date.now() - resumeStartedAt);
              // Which tier served the resume (protocol.md:192).
              const tier = (data.payload && data.payload.replay_source) || "none";
              wsReplaySource.add(1, { tier: tier });
              // Post-restart, the per-boot seq floor renumbered the space and
              // the boot marks visibility changed, so tier none is the
              // designed post-restart resume (full re-sync); the client
              // rebases its seq anchor (internal/app/persistence.go:105,
              // OC-0210).
              if (IS_RESTART && tier === "none") {
                rebasing = true;
              }
              // channel_focus after auth_ok is idempotent (protocol.md:160).
              socket.send(envelope("channel_focus", { channel_id: CHANNEL_ID }));
              if (IS_RESTART) {
                restartResumeTime.add(Date.now() - resumeStartedAt);
              }
            } else {
              wsAuthOkTime.add(Date.now() - authSentAt, stepTags());
            }
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
            if (joinsVoice && !IS_OPERATIONAL) {
              // Capacity joins once on ready, as B6-9. Under operational the
              // churn timer owns every join, so all joins land on the shared
              // K6_VOICE_CHURN_MS grid that voice_state_delivery_ms reads.
              voiceJoinSent = Date.now();
              socket.send(envelope("voice_join", { channel_id: VOICE_CHANNEL_ID }));
            }
            break;
          case "chat_send_ok":
            wsAcks.add(1);
            wsMessageRate.add(true);
            if (data.id && pendingSends[data.id]) {
              broadcastLatency.add(
                Date.now() - pendingSends[data.id],
                stepTags(true) ?? restartTags(resumedConn),
              );
              delete pendingSends[data.id];
            }
            if (IS_RESTART && data.id && drainPending[data.id]) {
              drainSends.add(1, { outcome: "acked" });
              delete drainPending[data.id];
            }
            break;
          case "chat_message": {
            // Recipient delivery. A sender also receives its own broadcast,
            // and timing that would measure the sender's round trip a second
            // time — the budget says recipient, so own echoes are skipped.
            // The <30 s gate keeps replayed frames out of the live-delivery
            // metrics: replay carries old embedded timestamps, live delivery
            // is always well under 30 s (inert in capacity, which never
            // replays).
            const content = data.payload && data.payload.content;
            const from = sentBy(content);
            const at = sentAt(content);
            if (at && from && from !== vuId && Date.now() - at < 30 * 1000) {
              deliveryLatency.add(Date.now() - at, stepTags(true) ?? restartTags(resumedConn));
              deliveries.add(1);
            }
            break;
          }
          case "voice_state": {
            // Sequenced voice_state broadcast (protocol.md:1323). The
            // measurement is operational-only; capacity falls through and
            // ignores the frame, as B6-9 did.
            if (IS_OPERATIONAL && typeof data.seq === "number") {
              const uname = data.payload && data.payload.username;
              // Every join is a churn-tick join, anchored to the shared
              // K6_VOICE_CHURN_MS grid. A voice_state arriving for ANOTHER
              // user at time R was broadcast by that user's epoch-aligned
              // join at boundary = R - (R % CHURN_MS), so R - boundary is the
              // delivery time; the <CHURN_MS/2 gate only accepts frames that
              // attribute to the right boundary unambiguously.
              if (uname && uname !== username) {
                const r = Date.now();
                const boundary = Math.floor(r / CHURN_MS) * CHURN_MS;
                const delta = r - boundary;
                if (delta < CHURN_MS / 2) {
                  voiceStates.add(1);
                  voiceStateDelivery.add(delta);
                }
              }
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
          case "server_restart":
            // Sequenced broadcast, protocol.md:1815-1826 (reason +
            // delay_seconds). The socket's close comes from the server's own
            // drain, not from us; lead_ms measures frame arrival to actual
            // close and should be >= delay_seconds.
            if (IS_RESTART && !restartReceivedAt) {
              restartReceivedAt = Date.now();
              serverRestartReceived.add(1);
            }
            break;
          case "error":
            wsErrors.add(1);
            wsMessageRate.add(false);
            // A drain send the server refused classifies as errored: error
            // envelopes echo the request id (protocol.md:1837).
            if (IS_RESTART && data.id && drainPending[data.id]) {
              drainSends.add(1, { outcome: "errored" });
              delete drainPending[data.id];
            }
            break;
          default:
            // Broadcast traffic (presence, typing, seq'd frames) — receiving
            // it is the point of the load, no assertion.
            break;
        }
      } catch (_e) {
        wsErrors.add(1);
      }
    });

    socket.on("error", function (_e) {
      wsErrors.add(1);
    });

    // ws_replay_gap: the seq values skipped between the stored last_seq and
    // the live stream that follows the replay, 0 when contiguity held. The
    // server writes auth_ok and THEN the replayed events (ws/replay.go,
    // reconnectWriteReplay), so the sample is taken 20 s after the resume —
    // a 1000-frame ring replays in well under a second — rather than at the
    // first frame after auth_ok, which would be the first replayed one.
    // Recording only at close under-reported it: k6's ramp-down kills most
    // held sockets before their own close fires (37 samples for 100 resumes
    // in the second dispatch); close remains the fallback for a resumed
    // socket that went away sooner.
    const recordGap = function () {
      if (resumedConn && !gapRecorded) {
        wsReplayGap.add(resumeGap);
        gapRecorded = true;
      }
    };
    if (RESUMES_ON && resumedConn) {
      socket.setTimeout(recordGap, 20000);
    }
    // The drill's drain sends classify at close: acked/errored removed
    // earlier; the rest are unanswered, their contents kept for the next
    // iteration's history check.
    socket.on("close", function () {
      if (RESUMES_ON) recordGap();
      if (IS_RESTART && restartReceivedAt) {
        serverRestartLead.add(Date.now() - restartReceivedAt);
        for (const id of Object.keys(drainPending)) {
          drainSends.add(1, { outcome: "unanswered" });
          vuDrainUnanswered.push(drainPending[id]);
        }
      }
    });

    // B6-10 reconnect storm: the VU closes its own socket deliberately — this
    // is not an error and must not count into ws_errors — and the next
    // iteration of the same VU reconnects with last_seq + active_channel_id.
    // Every VU fires at the same scenario-clock instant (stormFireAt), which
    // is what makes it a storm rather than smeared churn. Skipped when it
    // would leave too short a resumed window.
    if (IS_OPERATIONAL && !vuStormDone) {
      const fireAt = stormFireAt(exec.scenario.startTime);
      const inMs = fireAt - openAt;
      if (inMs > 30000) {
        socket.setTimeout(function () {
          vuStormDone = true;
          socket.close();
        }, inMs);
      }
    }

    // B6-10 voice churn: every K6_VOICE_CHURN_MS boundary the VU leaves and
    // rejoins, so the voice control plane (voice_join -> voice_token,
    // voice_state broadcasts, voice_leave) is exercised continuously instead
    // of 25 VUs joining once and sitting. Joins are anchored to the shared
    // wall-clock grid (Date.now() % CHURN_MS == 0) because
    // voice_state_delivery_ms reads that grid. (protocol.md:1241-1275; the
    // 5/s per-user limit is far away at one join per 10 s.)
    if (IS_OPERATIONAL && joinsVoice) {
      const churnTick = function () {
        if (authed) {
          if (vuInVoice) {
            // voice_leave broadcast, protocol.md:1250-1276.
            socket.send(envelope("voice_leave", {}));
          }
          voiceJoinSent = Date.now();
          socket.send(envelope("voice_join", { channel_id: VOICE_CHANNEL_ID }));
          vuInVoice = true;
        }
        socket.setTimeout(churnTick, CHURN_MS - (Date.now() % CHURN_MS));
      };
      socket.setTimeout(churnTick, CHURN_MS - (Date.now() % CHURN_MS));
    }

    // Send messages periodically (respecting rate limits). Gated on the
    // session being established: ready on a fresh connection, auth_ok on a
    // resume (a replay resume sends no ready frame, protocol.md:305-315).
    // The interval keeps running for the whole hold — there is no message
    // cap, because the sustained fan-out IS the load being measured.
    socket.setInterval(function () {
      if (!ready && !resumedConn) {
        return;
      }
      const id = `${vuId}-${msgCount}-${Date.now()}`;
      pendingSends[id] = Date.now();
      // Built once: two Date.now() reads could straddle a millisecond, and the
      // drain-send accounting matches the SENT content against channel history
      // by string — a one-ms difference would publish a false sends_lost.
      // t= and v= are read back by every other connection; see sentAt.
      const content = `Load test message ${vuId}-${msgCount} t=${Date.now()} v=${vuId}`;
      if (IS_RESTART && restartReceivedAt) {
        drainPending[id] = content;
      }
      socket.send(
        JSON.stringify({
          type: "chat_send",
          id: id,
          payload: { channel_id: CHANNEL_ID, content: content },
        }),
      );
      wsMessages.add(1);
      msgCount++;
    }, SEND_INTERVAL_MS); // chat_send is 10/sec; 1 per 2s is well under it

    // Typing indicators (client->server type is typing_start, not "typing").
    socket.setInterval(function () {
      if (ready || resumedConn) {
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
    // Capacity-only: under operational the churn timer owns every leave.
    if (joinsVoice && !IS_OPERATIONAL) {
      socket.setTimeout(function () {
        socket.send(envelope("voice_leave", {}));
      }, HOLD_MS - 2000);
    }

    // Hold the connection for the whole run (see HOLD_MS); a resumed
    // connection holds to the original hold end.
    socket.setTimeout(function () {
      socket.close();
    }, closeIn);
  });

  check(res, {
    "WebSocket status is 101": (r) => r && r.status === 101,
  });

  if (!res || res.status !== 101) {
    wsErrors.add(1);
    // Under the drill, a refused connect during the outage is the drill
    // working; it must not drag down the send-success rate that still gates
    // the run (ws_errors is already exempt there for the same reason).
    if (!IS_RESTART) wsMessageRate.add(false);
  }

  sleep(1);
} // The observer: one VU, the whole run, /api/v1/metrics every 5 s. It records
// the DELTA of the server's counters since the previous poll, tagged
// phase=<ramp|sustain|storm|upload>, so the document can publish per-phase
// deltas (the run-total is what B6-9 already had). The observer's elapsed
// clock is aligned with the run's phase windows because the observer scenario
// starts at t=0.
let obsStart = 0;
let obsPrev = null;

// The four windows, in priority order:
//   ramp    — run start to the end of the ramp (K6_RAMP);
//   storm   — the wave: stormFireAt() plus 30 s for the reconnects to land.
//             The same function the VU timers use, so it cannot drift off them;
//   upload  — the uploads scenario's start (K6_RAMP + 60 s) to the end of the
//             run: the uploads VUs keep uploading until the run drains, so
//             booking only the first 30 s would leave most of the pressure
//             tagged `sustain`;
//   sustain — the peak before either of those.
function obsPhase(nowMs) {
  const t = (nowMs - obsStart) / 1000;
  if (t < RAMP_S) return "ramp";
  if (IS_OPERATIONAL && nowMs >= stormFireAt(obsStart) && nowMs <= stormFireAt(obsStart) + 30000) {
    return "storm";
  }
  if (t >= UPLOADS_START_S) return "upload";
  return "sustain";
}

export function observerScenario() {
  if (!obsStart) {
    obsStart = Date.now();
  }
  const start = Date.now();
  const res = http.get(`${HTTP_URL}/api/v1/metrics`);
  obsPollTime.add(Date.now() - start);
  let body;
  try {
    body = res.json();
  } catch (_e) {
    sleep(5);
    return;
  }

  // The first poll is the baseline: without it the "delta" would be the
  // server's cumulative count since boot (the seeding's bcrypt and writes),
  // booked to the first phase or step.
  if (!obsPrev) {
    obsPrev = body;
    sleep(5);
    return;
  }
  const d = (k) => (body[k] || 0) - (obsPrev[k] || 0);

  if (IS_CEILING) {
    // The per-step deltas: the writer-wait pair is the plan's Task 2 observer
    // row; the reader pair and the reject counter ride the same grid.
    const stepTag = { step: String(runStep()) };
    obsDbWriterWaitCount.add(d("db_writer_wait_count"), stepTag);
    obsDbWriterWaitSeconds.add(d("db_writer_wait_seconds"), stepTag);
    obsDbReaderWaitCount.add(d("db_reader_wait_count"), stepTag);
    obsDbReaderWaitSeconds.add(d("db_reader_wait_seconds"), stepTag);
    obsConnRejects.add(d("ws_conn_rejects"), stepTag);
    obsConnectedUsers.add(body.connected_users || 0, stepTag);
  } else {
    const phase = obsPhase(Date.now());
    obsDbWriterWaitCount.add(d("db_writer_wait_count"), { phase });
    obsDbWriterWaitSeconds.add(d("db_writer_wait_seconds"), { phase });
    obsDbReaderWaitCount.add(d("db_reader_wait_count"), { phase });
    obsDbReaderWaitSeconds.add(d("db_reader_wait_seconds"), { phase });
    // Tagged with the phase as well as the tier/kind: the storm's tier split
    // and backpressure delta are per-phase figures (a run total cannot say
    // which phase the reconnects or the drops happened in), and k6 sub-metric
    // keys take both tags — `obs_reconnect_tier{phase:storm,tier:buffer}`.
    obsReconnectTier.add(d("reconnect_tier_buffer"), { phase, tier: "buffer" });
    obsReconnectTier.add(d("reconnect_tier_db"), { phase, tier: "db" });
    obsReconnectTier.add(d("reconnect_tier_full"), { phase, tier: "full" });
    obsBackpressure.add(d("backpressure_queue_disconnects"), {
      phase,
      kind: "queue_disconnects",
    });
    obsBackpressure.add(d("backpressure_high_fallbacks"), {
      phase,
      kind: "high_fallbacks",
    });
    obsBackpressure.add(d("backpressure_low_drops"), { phase, kind: "low_drops" });
    obsConnRejects.add(d("ws_conn_rejects"), { phase });
    if (body.upload_storage_used_mb !== undefined) {
      obsUploadStorage.add(body.upload_storage_used_mb, { phase });
    }
  }
  obsPrev = body;

  sleep(5);
}

// The upload-admission scenario: PEAK_VUS users each uploading one
// K6_UPLOAD_BYTES file every UPLOAD_INTERVAL_S (6/min, inside the 10/min
// limit, docs/api.md:1965) with OWNCORD_UPLOAD_USER_QUOTA_MB=1 on the server,
// so each user's quota crosses inside the run: four admits, then refusals.
// Its VU ids are handed out above the WebSocket scenario's (k6 numbers VUs
// test-wide), so it uses loadtest accounts the WebSocket VUs never touch and
// the per-user quota cycles cleanly. It runs concurrently with the WebSocket sustain: the
// point is the interaction (the writer charging quotas while the
// recipient-delivery trend is measured).
//
// Classification is by response BODY, not status family (docs/api.md:238):
//   201                          -> upload_admit_time
//   507 + STORAGE_QUOTA_EXCEEDED -> upload_refuse_time (the quota bound)
//   507 + STORAGE_LOW_DISK       -> upload_low_disk (the runner is full, not the server)
//   400                          -> upload_oversize (a scenario bug; 400, not 413)
//   anything else                -> ws_errors
const UPLOAD_BLOB = "0".repeat(UPLOAD_BYTES);
let upToken = null;
let upCount = 0;
let upFileId = null;

export function uploadsScenario() {
  const username = `${USERNAME_PREFIX}${__VU}`;
  if (!upToken) {
    upToken = authenticate(username);
    if (!upToken) {
      // As in the WebSocket loop: count it once and sit the run out.
      loginGiveUps?.add(1);
      sleep(TOTAL_S);
      return;
    }
  }

  const start = Date.now();
  const res = http.post(
    `${HTTP_URL}/api/v1/uploads`,
    { file: http.file(UPLOAD_BLOB, "loadtest.bin", "application/octet-stream") },
    { headers: { Authorization: `Bearer ${upToken}` } },
  );
  const dt = Date.now() - start;

  let body = {};
  try {
    body = res.json();
  } catch (_e) {
    // A non-JSON body classifies below by status alone.
  }

  if (res.status === 201) {
    uploadAdmits.add(1);
    uploadAdmitTime.add(dt);
    upFileId = body.id;
    // Download what this VU just admitted, Bearer-authenticated; one in four
    // with a Range header to exercise the range path (docs/api.md:1996).
    upCount++;
    const dstart = Date.now();
    const dres = http.get(`${HTTP_URL}/api/v1/files/${upFileId}`, {
      headers: {
        Authorization: `Bearer ${upToken}`,
        ...(upCount % 4 === 0 ? { Range: "bytes=0-1023" } : {}),
      },
    });
    if (dres.status === 200 || dres.status === 206) {
      downloads.add(1);
      downloadTime.add(Date.now() - dstart);
    } else {
      wsErrors.add(1);
    }
  } else if (res.status === 507) {
    const err = body && body.error;
    if (err === "STORAGE_QUOTA_EXCEEDED") {
      uploadRefuses.add(1);
      uploadRefuseTime.add(dt);
    } else if (err === "STORAGE_LOW_DISK") {
      uploadLowDisk.add(1);
    } else {
      // 507 STORAGE_ERROR or an unmapped 507: a real error.
      wsErrors.add(1);
    }
  } else if (res.status === 400) {
    // The scenario sent something the API refuses — oversize is 400, not 413
    // (docs/api.md:238). Never a quota measurement.
    uploadOversize.add(1);
  } else {
    wsErrors.add(1);
  }

  sleep(UPLOAD_INTERVAL_S);
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
