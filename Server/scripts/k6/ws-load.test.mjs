// Offline execution check: node --test Server/scripts/k6/ws-load.test.mjs
// Run the actual harness with k6 I/O mocked, not a copy of its algorithms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("./ws-load.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export default function ()", "function websocketScenario()")
  .replace(/^export /gm, "");
const script = new vm.Script(source);
const epoch = 1800000000000;
const channels = (n) => Array.from({ length: n }, (_, i) => i + 10).join(",");

function harness(env = {}, vu = 1, files = {}) {
  let now = epoch;
  const metrics = {};
  const frames = [];
  const handlers = {};
  const intervals = new Map();
  const timeouts = [];
  const connects = [];
  const logins = [];
  let closes = 0;
  let body = {};
  let dialMs = 0;
  class Metric {
    constructor(name) {
      this.name = name;
      metrics[name] = [];
    }
    add(value, tags) {
      metrics[this.name].push({ value, tags });
    }
  }
  const context = vm.createContext({
    __ENV: env,
    __VU: vu,
    Date: { now: () => now },
    exec: { scenario: { startTime: epoch, iterationInTest: 0 } },
    Counter: Metric,
    Gauge: Metric,
    Rate: Metric,
    Trend: Metric,
    // k6/data and the init-context open(): the array is built once, as k6's is.
    SharedArray: function (_name, build) {
      return build();
    },
    open: (path) => files[path],
    check: () => true,
    sleep: () => {},
    crypto: globalThis.crypto,
    http: {
      post: (url, payload, params) => {
        logins.push({ url, payload: JSON.parse(payload), params });
        return { status: 200, body: '{"token":"test-token"}', headers: {} };
      },
      get: () => ({ status: 200, json: () => body }),
    },
    ws: {
      connect: (url, params, callback) => {
        connects.push({ url, params, at: now });
        now += dialMs;
        callback({
          send: (frame) => frames.push(JSON.parse(frame)),
          on: (event, handler) => {
            handlers[event] = handler;
          },
          setInterval: (callback, ms) => intervals.set(ms, callback),
          // k6/ws refuses a timer that is not in the future.
          setTimeout: (callback, ms) => {
            if (!(ms > 0))
              throw new Error(`setTimeout requires a >0 timeout parameter, received ${ms}`);
            timeouts.push({ ms, callback });
          },
          close: () => {
            closes++;
          },
        });
        return { status: 101 };
      },
    },
  });
  script.runInContext(context);
  const evaluate = (expression) => vm.runInContext(expression, context);
  return {
    metrics,
    frames,
    intervals,
    timeouts,
    connects,
    logins,
    closes: () => closes,
    evaluate,
    // How long the next ws.connect takes to open, on the harness clock.
    dialTakes: (ms) => {
      dialMs = ms;
    },
    at: (seconds) => {
      now = epoch + seconds * 1000;
    },
    start: () => {
      evaluate("websocketScenario()");
      handlers.message('{"type":"auth_ok"}');
      handlers.message('{"type":"ready"}');
    },
    receive: (frame) => handlers.message(JSON.stringify(frame)),
    // The socket's `close` event, as k6 fires it when the connection ends.
    close: () => handlers.close(),
    observe: (sample) => {
      body = sample;
      evaluate("observerScenario()");
    },
    summary: (data = { metrics: {} }) => {
      context.summaryData = data;
      return JSON.parse(evaluate("handleSummary(summaryData).stdout"));
    },
  };
}

test("ceiling spreads actual sends/focus with unchanged total rate and burst headroom", () => {
  const stats = readFileSync(new URL("../../ws/hub_stats.go", import.meta.url), "utf8");
  const limit = Number(/const topicRateLimitPerSecond = (\d+)/.exec(stats)[1]);
  const env = { K6_PROFILE: "ceiling-search", K6_CEILING_CHANNELS: channels(11) };
  const pool = [];
  for (let vu = 1; vu <= 501; vu++) {
    const h = harness(env, vu);
    h.at(31);
    h.start();
    h.intervals.get(2000)();
    h.intervals.get(4000)();
    const sent = h.frames.find((f) => f.type === "chat_send");
    const focus = h.frames.find((f) => f.type === "channel_focus");
    const typing = h.frames.find((f) => f.type === "typing_start");
    assert.equal(sent.payload.channel_id, focus.payload.channel_id);
    assert.equal(sent.payload.channel_id, typing.payload.channel_id);
    assert.equal(h.metrics.ws_messages_sent.length, 1);
    assert.equal(h.metrics.ws_messages_sent[0].tags.channel, String(sent.payload.channel_id));
    assert.equal(h.metrics.ws_messages_sent[0].tags.step, "100");
    pool.push(sent.payload.channel_id);
  }
  // Observer can have any id; activation can take any subset of this pool.
  // Even the entire pool puts no more than half the sliding limit on a topic.
  for (const channel of new Set(pool)) {
    assert.ok(pool.filter((id) => id === channel).length <= limit / 2);
  }
  const h = harness(env);
  const summary = h.summary().load_measurement;
  assert.equal(summary.topic_limit_per_second, limit);
  assert.equal(summary.steps.length, 5);
  for (const step of summary.steps) {
    assert.equal(step.planned_total_messages_per_second, step.connections / 2);
    assert.equal(step.planned_mean_messages_per_second_per_channel, step.connections / 22);
    assert.ok(step.max_scheduled_messages_per_channel_in_1s <= limit / 2);
  }
  assert.ok(new Set(pool).size > 1);
  const measured = h.summary({
    metrics: {
      "ws_messages_sent{step:100,channel:10}": { values: { count: 300 } },
    },
  }).load_measurement.steps[0].channels[0];
  assert.equal(measured.sent_count, 300);
  assert.equal(measured.observed_send_attempts_per_second, 5);
});

test("unsafe ceiling inputs fail before sockets; custom maximum/step/rate still work", () => {
  for (const list of [undefined, "1,2,3,4", "1,1", "1,2oops", "1,", "0", "-1"]) {
    assert.throws(
      () => harness({ K6_PROFILE: "ceiling-search", K6_CEILING_CHANNELS: list }),
      /K6_CEILING_CHANNELS/,
    );
  }
  for (const knob of ["K6_CEILING_STEP", "K6_SEND_INTERVAL_MS"]) {
    assert.throws(() => harness({ K6_PROFILE: "ceiling-search", [knob]: "0" }), /requires/);
  }
  // A per-user rate the server will not admit (service/message_crud.go caps
  // each user at 10 sends/second) would measure only the admitted subset.
  for (const interval of ["1", "50", "99"]) {
    assert.throws(
      () => harness({ K6_PROFILE: "ceiling-search", K6_SEND_INTERVAL_MS: interval }),
      /requires/,
    );
  }
  const h = harness({
    K6_PROFILE: "ceiling-search",
    K6_CEILING_MAX: "250",
    K6_CEILING_STEP: "100",
    K6_SEND_INTERVAL_MS: "500",
    K6_CEILING_CHANNELS: channels(11),
  });
  h.start();
  assert.ok(h.intervals.has(500));
  const steps = h.summary().load_measurement.steps;
  assert.deepEqual(
    steps.map((s) => s.connections),
    [100, 200, 250],
  );
  assert.equal(steps.at(-1).planned_total_messages_per_second, 500);
  assert.ok(steps.at(-1).max_scheduled_messages_per_channel_in_1s <= 50);
  // Ramp sends must not inflate the held per-channel rate.
  h.at(1);
  h.intervals.get(500)();
  assert.equal(h.metrics.ws_messages_sent[0].tags.step, "100-ramp");
});

test("a resumed connection keeps the VU's send, typing and presence phase (OC-0445)", () => {
  const h = harness({ K6_PROFILE: "operational" });
  // First connection at t=10.5 s: send phase 500 ms of 2000, typing 2500 of
  // 4000, presence 10500 of 15000. Timers start immediately on a fresh socket.
  h.at(10.5);
  h.start();
  const firstSend = h.intervals.get(2000);
  assert.equal(typeof firstSend, "function");
  assert.equal(h.timeouts.filter((t) => t.ms < 2000).length, 0);

  // The storm: every VU reopens its socket at t=180 s (phase 0 of every
  // period). A plain setInterval would put all sends on that shared phase.
  h.evaluate("vuLastSeq = 7");
  h.at(180);
  h.evaluate("websocketScenario()");
  const byDelay = (ms) => h.timeouts.filter((t) => t.ms === ms);
  assert.equal(byDelay(500).length, 1, "send re-anchors 500 ms later");
  assert.equal(byDelay(2500).length, 1, "typing re-anchors 2500 ms later");
  assert.equal(byDelay(10500).length, 1, "presence re-anchors 10500 ms later");
  assert.equal(h.intervals.get(2000), firstSend, "no interval before the phase point");

  // The phased tick fires before auth_ok: nothing is sent yet, and the
  // interval that follows keeps the period.
  const sent = () => h.frames.filter((f) => f.type === "chat_send").length;
  const before = sent();
  byDelay(500)[0].callback();
  assert.equal(sent(), before);
  assert.notEqual(h.intervals.get(2000), firstSend);
  h.receive({ type: "auth_ok", payload: { replay_source: "buffer" } });
  h.intervals.get(2000)();
  assert.equal(sent(), before + 1);
});

test("K6_SEND_PHASE=aligned puts every VU's sends on the epoch grid; typing keeps its own phase (OC-0454)", () => {
  assert.throws(() => harness({ K6_SEND_PHASE: "burst" }), /K6_SEND_PHASE/);

  for (const [vu, at] of [
    [1, 10.5],
    [2, 11.25],
  ]) {
    const h = harness({ K6_SEND_PHASE: "aligned" }, vu);
    h.at(at);
    h.start();
    const sendDelay = 2000 - ((at * 1000) % 2000);
    const first = h.timeouts.filter((t) => t.ms === sendDelay);
    assert.equal(first.length, 1, `VU ${vu} send waits for the next 2 s boundary`);
    assert.equal(h.intervals.has(2000), false, "no send interval before the boundary");
    assert.ok(h.intervals.has(4000), "typing starts on the connection's own phase");

    h.at(at + sendDelay / 1000);
    first[0].callback();
    assert.equal(h.frames.filter((f) => f.type === "chat_send").length, 1);
    assert.ok(h.intervals.has(2000), "the period continues from the boundary");
  }

  const spread = harness({});
  spread.at(10.5);
  spread.start();
  assert.ok(spread.intervals.has(2000), "the default still sends on the connection's own phase");
});

test("voice churn is spread across the cohort by default, aligned as a named burst (PERF-02)", () => {
  assert.throws(
    () => harness({ K6_PROFILE: "operational", K6_VOICE_CHURN_PHASE: "storm" }),
    /K6_VOICE_CHURN_PHASE/,
  );

  // Spread (default): VU n sits at (n-1)/(VOICE_VUS + OBS_VUS) through the
  // period. With VOICE_VUS=4 plus the observer's slot the offsets are 0, 2000,
  // 4000, 6000, 8000 ms, and VU 5 (a voice VU whenever the observer holds a
  // lower id) gets its own slot rather than sharing VU 1's. Start partway
  // through a period (t=0.5 s), so the first tick waits for this VU's own
  // offset rather than the epoch boundary — the arithmetic the sign of JS `%`
  // would otherwise get wrong.
  for (const [vu, delayMs] of [
    [1, 9500],
    [2, 1500],
    [3, 3500],
    [5, 7500],
  ]) {
    const h = harness(
      { K6_PROFILE: "operational", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "4" },
      vu,
    );
    h.at(0.5);
    h.start();
    assert.equal(
      h.timeouts.filter((t) => t.ms === delayMs).length,
      1,
      `VU ${vu} churns ${delayMs} ms after t=0.5`,
    );
  }

  // Aligned: every VU lands on the same epoch grid, the deliberate burst.
  for (const vu of [1, 2, 3]) {
    const h = harness(
      {
        K6_PROFILE: "operational",
        K6_VOICE_CHANNEL_ID: "9",
        K6_VOICE_VUS: "4",
        K6_VOICE_CHURN_PHASE: "aligned",
      },
      vu,
    );
    h.at(0);
    h.start();
    assert.equal(h.timeouts.filter((t) => t.ms === 10000).length, 1);
    assert.equal(h.timeouts.filter((t) => t.ms < 10000).length, 0, `VU ${vu} is not spread`);
  }

  // The measurement attributes a cross-VU frame to the SENDER's offset, not
  // the epoch grid: a frame from VU 2 (offset 2000) seen 50 ms after that
  // offset is a 50 ms delivery, not 2050 ms.
  const spread = harness(
    { K6_PROFILE: "operational", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "4" },
    1,
  );
  spread.at(2.05);
  spread.start();
  spread.receive({ type: "voice_state", seq: 1, payload: { username: "loadtest2" } });
  assert.equal(spread.metrics.voice_state_delivery_ms.at(-1).value, 50);

  const aligned = harness(
    {
      K6_PROFILE: "operational",
      K6_VOICE_CHANNEL_ID: "9",
      K6_VOICE_VUS: "4",
      K6_VOICE_CHURN_PHASE: "aligned",
    },
    1,
  );
  aligned.at(2.05);
  aligned.start();
  aligned.receive({ type: "voice_state", seq: 1, payload: { username: "loadtest2" } });
  assert.equal(aligned.metrics.voice_state_delivery_ms.at(-1).value, 2050);

  // A username this run did not mint measures nothing rather than guessing.
  const foreign = harness(
    { K6_PROFILE: "operational", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "4" },
    1,
  );
  foreign.at(2.05);
  foreign.start();
  foreign.receive({ type: "voice_state", seq: 1, payload: { username: "someoneelse" } });
  assert.equal(foreign.metrics.voice_state_delivery_ms.length, 0);

  // Q10: the aligned burst is published unbudgeted. The voice-join budget
  // gates spread churn (and capacity) and is dropped only under aligned; the
  // count sanity gate stays either way.
  const budgeted = harness(
    { K6_PROFILE: "operational", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "4" },
    1,
  );
  assert.equal(
    budgeted.evaluate('options.thresholds["voice_join_time"][0]'),
    "p(95)<250",
    "spread churn keeps the voice-join budget",
  );
  const burst = harness(
    {
      K6_PROFILE: "operational",
      K6_VOICE_CHANNEL_ID: "9",
      K6_VOICE_VUS: "4",
      K6_VOICE_CHURN_PHASE: "aligned",
    },
    1,
  );
  assert.equal(burst.evaluate('options.thresholds["voice_join_time"]'), undefined);
  assert.equal(burst.evaluate('options.thresholds["voice_tokens"][0]'), "count>0");
  // Capacity does not churn, so an aligned input (the workflow passes it to
  // every profile) must not drop its voice-join budget.
  const capacity = harness(
    { K6_PROFILE: "capacity", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_CHURN_PHASE: "aligned" },
    1,
  );
  assert.equal(capacity.evaluate('options.thresholds["voice_join_time"][0]'), "p(95)<250");
});

test("operational acknowledgement and delivery samples carry the observer's phase", () => {
  const h = harness({ K6_PROFILE: "operational" });
  h.start();
  // The same boundaries obsPhase draws: ramp, sustain, uploads from
  // K6_RAMP + 60 s, the 30 s storm window at K6_RAMP + K6_STORM_AT, then
  // upload again until the run drains.
  const cases = [
    [59.999, "ramp"],
    [60, "sustain"],
    [119.999, "sustain"],
    [120, "upload"],
    [179.999, "upload"],
    [180, "storm"],
    [210, "storm"],
    [210.001, "upload"],
  ];
  for (const [time, phase] of cases) {
    h.at(time);
    h.receive({ type: "chat_message", payload: { content: `t=${epoch + time * 1000 - 10} v=2` } });
    assert.equal(h.metrics.ws_delivery_latency_ms.at(-1).tags.phase, phase);
    h.intervals.get(2000)();
    const send = h.frames.at(-1);
    h.receive({ type: "chat_send_ok", id: send.id });
    assert.equal(h.metrics.ws_broadcast_latency_ms.at(-1).tags.phase, phase);
  }
  for (const metric of ["ws_delivery_latency_ms", "ws_broadcast_latency_ms"]) {
    for (const phase of ["ramp", "sustain", "storm", "upload"]) {
      assert.equal(h.evaluate(`options.thresholds["${metric}{phase:${phase}}"][0]`), "p(95)>=0");
      // p(99) too: the operational ack tail is the published concern.
      assert.equal(h.evaluate(`options.thresholds["${metric}{phase:${phase}}"][1]`), "p(99)>=0");
    }
  }
  // The run-wide budget is untouched by the per-phase series.
  assert.equal(h.evaluate('options.thresholds["ws_broadcast_latency_ms"][0]'), "p(95)<150");
  assert.equal(h.evaluate('options.thresholds["ws_broadcast_latency_ms"][1]'), "p(99)<300");
});

test("restart receipt boundaries, legacy tags and nonempty summary samples", () => {
  const h = harness({ K6_PROFILE: "restart" });
  h.start();
  const cases = [
    [59.999, "ramp"],
    [60, "pre-restart"],
    [134.999, "pre-restart"],
    [135, "recovery"],
    [164.999, "recovery"],
    [165, "post-restart"],
    [239.999, "post-restart"],
    [240, "ramp-down"],
  ];
  for (const [time, phase] of cases) {
    h.at(time);
    h.receive({ type: "chat_message", payload: { content: `t=${epoch + time * 1000 - 10} v=2` } });
    assert.equal(h.metrics.ws_delivery_latency_ms.at(-1).tags.phase, phase);
    assert.equal(h.metrics.ws_deliveries.at(-1).tags.phase, phase);
    h.intervals.get(2000)();
    const send = h.frames.at(-1);
    h.receive({ type: "chat_send_ok", id: send.id });
    assert.equal(h.metrics.ws_broadcast_latency_ms.at(-1).tags.phase, phase);
  }
  const metrics = {};
  for (const metric of ["ws_delivery_latency_ms", "ws_broadcast_latency_ms"]) {
    for (const phase of ["pre-restart", "recovery", "post-restart"]) {
      const samples = h.metrics[metric].filter((s) => s.tags.phase === phase);
      metrics[`${metric}{phase:${phase}}`] = {
        values: { "p(95)": samples.at(-1).value, count: samples.length },
      };
      assert.ok(h.evaluate(`options.thresholds["${metric}{phase:${phase}}"]`));
    }
  }
  const summary = h.summary({ metrics });
  assert.deepEqual(summary.metrics, metrics); // Existing series survive unchanged.
  const windows = summary.load_measurement.windows;
  assert.deepEqual(
    windows.map((w) => [w.start_s, w.end_s]),
    [
      [0, 60],
      [60, 135],
      [135, 165],
      [165, 240],
      [240, null],
    ],
  );
  for (const window of windows.slice(1, 4)) {
    assert.equal(window.delivery.p95_ms, 10);
    assert.equal(window.delivery.sample_count, 2);
    assert.equal(window.acknowledgement.sample_count, 2);
  }
  assert.equal(windows[3].role, "settled");
  const empty = h.summary().load_measurement.windows[2].delivery;
  assert.deepEqual(empty, { p95_ms: null, sample_count: 0 });
});

test("custom restart windows use their own floors and reject empty windows", () => {
  const h = harness({ K6_PROFILE: "restart", K6_RESTART_AT: "90", K6_RESTART_RECOVERY_S: "20" });
  const windows = h.summary().load_measurement.windows;
  assert.equal(windows[1].duration_s, 30);
  assert.equal(windows[3].duration_s, 130);
  assert.equal(
    h.evaluate('options.thresholds["ws_deliveries{phase:pre-restart}"][0]'),
    "count>=44550",
  );
  assert.equal(
    h.evaluate('options.thresholds["ws_deliveries{phase:post-restart}"][0]'),
    "count>=193050",
  );
  for (const env of [
    { K6_RESTART_AT: "60" },
    { K6_RESTART_AT: "210" },
    { K6_RESTART_RECOVERY_S: "0" },
    { K6_SUSTAIN: "30s" },
  ]) {
    assert.throws(() => harness({ K6_PROFILE: "restart", ...env }), /nonempty/);
  }
});

test("restart observer uses scenario clock and never subtracts counters across boots", () => {
  const h = harness({ K6_PROFILE: "restart" });
  h.at(62); // Observer first scheduled late: phase clock must still be t=0.
  h.observe({ uptime_seconds: 162, db_writer_wait_count: 100 });
  h.at(63);
  h.observe({ uptime_seconds: 163, db_writer_wait_count: 110 });
  let sample = h.metrics.obs_db_writer_wait_count.at(-1);
  assert.equal(sample.tags.phase, "pre-restart");
  assert.equal(sample.value, 10);
  h.at(137);
  h.observe({ error: "unavailable" });
  assert.equal(h.metrics.obs_db_writer_wait_count.length, 1);
  h.at(140);
  h.observe({ uptime_seconds: 1, db_writer_wait_count: 3 });
  sample = h.metrics.obs_db_writer_wait_count.at(-1);
  assert.equal(sample.tags.phase, "recovery");
  assert.equal(sample.value, 3);
});

test("capacity/operational keep their scenarios, channel and summary shape", () => {
  for (const profile of ["capacity", "operational"]) {
    const h = harness({ K6_PROFILE: profile, K6_CHANNEL_ID: "42", K6_CEILING_CHANNELS: "invalid" });
    h.start();
    h.intervals.get(2000)();
    assert.equal(h.frames.at(-1).payload.channel_id, 42);
    assert.equal(h.metrics.ws_messages_sent[0].tags, undefined);
    assert.equal(Boolean(h.evaluate("options.scenarios.observer")), profile === "operational");
    assert.equal(Boolean(h.evaluate("options.scenarios.uploads")), profile === "operational");
    assert.deepEqual(h.summary({ metrics: {} }), { metrics: {} });
  }
});

test("load workflow seeds enough channels for the harness at each supported maximum", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/load-baseline.yml", import.meta.url),
    "utf8",
  );
  const assignment = workflow
    .split("\n")
    .find((line) => line.trim().startsWith("ceiling_channels=$(("));
  assert.ok(assignment);
  for (const maximum of [100, 200, 250, 500, 1000]) {
    const count = Number(
      execFileSync("bash", ["-c", `${assignment}\nprintf '%s' "$ceiling_channels"`], {
        env: { ...process.env, CEILING_MAX: String(maximum) },
        encoding: "utf8",
      }),
    );
    assert.doesNotThrow(() =>
      harness({
        K6_PROFILE: "ceiling-search",
        K6_CEILING_MAX: String(maximum),
        K6_CEILING_CHANNELS: channels(count),
      }),
    );
  }
});

// --- scale (P5-S01) ---------------------------------------------------------

const scaleEnv = (extra = {}) => ({
  K6_PROFILE: "scale",
  K6_SCALE_CHANNELS: channels(20),
  ...extra,
});

test("scale rejects too few channels for its topic headroom and sends above 10/s per user", () => {
  // The default single channel cannot hold 10% of 2,501 ids under half the
  // 100/s topic limit, and neither can 20 channels once a user bursts at 10/s.
  assert.throws(() => harness({ K6_PROFILE: "scale" }), /K6_SCALE_CHANNELS/);
  assert.throws(() => harness(scaleEnv({ K6_SCALE_CHANNELS: channels(1) })), /K6_SCALE_CHANNELS/);
  assert.throws(
    () => harness(scaleEnv({ K6_SCALE_BURST_SEND_MS: "100" })),
    /K6_SCALE_CHANNELS needs at least \d+/,
  );
  for (const list of ["1,1", "1,2oops", "0"]) {
    assert.throws(() => harness(scaleEnv({ K6_SCALE_CHANNELS: list })), /K6_SCALE_CHANNELS/);
  }
  // service/message_crud.go admits at most 10 sends/second per user.
  for (const knob of ["K6_SCALE_SEND_MS", "K6_SCALE_BURST_SEND_MS"]) {
    for (const ms of ["99", "50", "0", "x"]) {
      assert.throws(() => harness(scaleEnv({ [knob]: ms })), /10 sends\/second/);
    }
  }
  for (const active of ["0", "1.5", "-0.1", "x"]) {
    assert.throws(() => harness(scaleEnv({ K6_SCALE_ACTIVE: active })), /K6_SCALE_ACTIVE/);
  }
  // At the limit and with enough channels it runs.
  assert.doesNotThrow(() =>
    harness(scaleEnv({ K6_SCALE_BURST_SEND_MS: "100", K6_SCALE_CHANNELS: channels(60) })),
  );
  assert.doesNotThrow(() => harness(scaleEnv()));
});

test("scale phase windows are computed from the knobs, and the summary publishes them", () => {
  const h = harness(scaleEnv());
  const cases = [
    [0, "ramp"],
    [179.999, "ramp"],
    [180, "steady"],
    [359.999, "steady"],
    [360, "burst"],
    [419.999, "burst"],
    [420, "login"],
    [509.999, "login"],
    [510, "herd"],
    [599.999, "herd"],
    [600, "ramp-down"],
  ];
  for (const [t, phase] of cases) assert.equal(h.evaluate(`scalePhaseAt(${t})`), phase, `t=${t}`);
  const windows = h.summary().load_measurement.windows;
  assert.deepEqual(
    windows.map((w) => [w.phase, w.start_s, w.end_s]),
    [
      ["ramp", 0, 180],
      ["steady", 180, 360],
      ["burst", 360, 420],
      ["login", 420, 510],
      ["herd", 510, 600],
      ["ramp-down", 600, null],
    ],
  );
  const stages = h.evaluate("options.scenarios.websocket_load.stages");
  assert.deepEqual(JSON.parse(JSON.stringify(stages)), [
    // The last connection is scheduled 10 s before steady opens, so the
    // steady window starts with the population in place.
    { duration: "170s", target: 2000 },
    { duration: "430s", target: 2000 },
    { duration: "20s", target: 0 },
  ]);
  const login = h.evaluate("options.scenarios.login_burst");
  assert.equal(login.executor, "per-vu-iterations");
  assert.equal(login.vus, 500);
  assert.equal(login.iterations, 1);
  assert.equal(login.startTime, "420s");
  assert.equal(h.evaluate("options.scenarios.observer.duration"), "620s");
  assert.equal(h.evaluate("SCALE_VUS_MAX"), 2501);

  const custom = harness(
    scaleEnv({
      K6_PEAK_VUS: "300",
      K6_SCALE_RAMP_S: "30",
      K6_SCALE_STEADY_S: "60",
      K6_SCALE_BURST_S: "20",
      K6_SCALE_LOGIN_S: "40",
      K6_SCALE_HERD_S: "45",
      K6_SCALE_HERD_SPREAD_S: "10",
      K6_SCALE_LOGINS: "50",
    }),
  );
  assert.deepEqual(
    custom.summary().load_measurement.windows.map((w) => [w.start_s, w.end_s]),
    [
      [0, 30],
      [30, 90],
      [90, 110],
      [110, 150],
      [150, 195],
      [195, null],
    ],
  );
  assert.equal(custom.evaluate("options.scenarios.login_burst.startTime"), "110s");
  assert.equal(custom.evaluate("SCALE_VUS_MAX"), 351);
  // Every window must exist, and the herd must outlast its own spread.
  for (const env of [
    { K6_SCALE_STEADY_S: "0" },
    { K6_SCALE_BURST_S: "0" },
    { K6_SCALE_LOGIN_S: "x" },
    { K6_SCALE_HERD_S: "15" },
    { K6_SCALE_HERD_SPREAD_S: "0" },
    { K6_SCALE_LOGINS: "0" },
    { K6_SCALE_LOGIN_SPREAD_S: "90" },
  ]) {
    assert.throws(() => harness(scaleEnv(env)), /scale requires/, JSON.stringify(env));
  }
});

test("scale gives every VU its own X-Forwarded-For address and starts from a minted token", () => {
  const h = harness(scaleEnv());
  const max = h.evaluate("SCALE_VUS_MAX");
  const seen = new Set();
  for (let vu = 1; vu <= max; vu++) {
    const address = h.evaluate(`scaleAddress(${vu})`);
    assert.match(address, /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    assert.ok(address.split(".").every((o) => Number(o) <= 255));
    seen.add(address);
  }
  assert.equal(seen.size, max);
  // The workflow seeds user i from the address VU i later uses.
  const workflow = readFileSync(
    new URL("../../../.github/workflows/load-baseline.yml", import.meta.url),
    "utf8",
  );
  const helper = workflow.split("\n").find((line) => line.trim().startsWith("scale_address() {"));
  assert.ok(helper, "the workflow defines scale_address");
  for (const vu of [1, 255, 256, 2501, 70000]) {
    const out = execFileSync("bash", ["-c", `${helper}\nscale_address ${vu}`], {
      encoding: "utf8",
    });
    assert.equal(out.trim(), h.evaluate(`scaleAddress(${vu})`));
  }

  // A returning client: auth with the token minted at seeding, no login.
  const tokens = Array.from({ length: max }, (_, i) => `tok${i + 1}`).join("\n");
  const vu = 7;
  const minted = harness(scaleEnv({ K6_SCALE_TOKENS: "/t" }), vu, { "/t": `${tokens}\n` });
  minted.start();
  assert.equal(minted.logins.length, 0);
  assert.equal(minted.frames[0].type, "auth");
  assert.equal(minted.frames[0].payload.token, "tok7");
  assert.equal(minted.frames[0].payload.last_seq, undefined);
  assert.equal(
    minted.connects[0].params.headers["X-Forwarded-For"],
    minted.evaluate(`scaleAddress(${vu})`),
  );

  // No token file: the VU logs in, from its own address.
  const login = harness(scaleEnv(), 9);
  login.start();
  assert.equal(login.logins.length, 1);
  assert.equal(login.logins[0].payload.username, "loadtest9");
  assert.equal(
    login.logins[0].params.headers["X-Forwarded-For"],
    login.evaluate("scaleAddress(9)"),
  );

  // The login burst: a fresh password login from the VU's own address,
  // staggered over the spread, counted apart from the steady give-up gate.
  const burst = harness(scaleEnv(), 2400);
  burst.evaluate("loginBurstScenario()");
  assert.equal(burst.logins[0].payload.username, "loadtest2400");
  assert.equal(
    burst.logins[0].params.headers["X-Forwarded-For"],
    burst.evaluate("scaleAddress(2400)"),
  );
  assert.equal(burst.metrics.login_burst_ok.length, 1);
  assert.equal(burst.metrics.login_burst_time.length, 1);
  assert.equal(burst.metrics.login_giveups.length, 0);
});

test("scale traffic: active users type then send keyed messages, burst raises the rate, presence flips", () => {
  const env = scaleEnv();
  // Channel = vu % 20 and activity is spread within each channel, so VU 5 is
  // idle and VU 185 (the 10th id on channel 5) is active.
  const idle = harness(env, 5);
  idle.at(200);
  idle.start();
  assert.equal(idle.intervals.has(8000), false);
  assert.equal(idle.intervals.has(2000), false);

  const h = harness(env, 185);
  h.at(200);
  h.start();
  const channel = h.evaluate("VU_CHANNEL_ID");
  assert.equal(channel, 15); // channels(20) starts at 10; 185 % 20 = 5.
  const types = () => h.frames.map((f) => f.type);
  const count = (type) => types().filter((t) => t === type).length;

  h.intervals.get(8000)();
  const send = h.frames.at(-1);
  assert.equal(send.type, "chat_send");
  assert.equal(h.frames.at(-2).type, "typing_start");
  assert.equal(send.payload.channel_id, channel);
  assert.match(
    send.payload.client_message_id,
    /^\d{13}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(h.metrics.ws_messages_sent.at(-1).tags.phase, "steady");
  // The burst timer is silent outside the burst window.
  h.intervals.get(2000)();
  assert.equal(count("chat_send"), 1);

  h.at(370);
  h.intervals.get(8000)();
  assert.equal(count("chat_send"), 1, "the steady timer yields to the burst");
  h.intervals.get(2000)();
  assert.equal(count("chat_send"), 2);
  assert.equal(count("typing_start"), 2);
  h.at(372);
  h.intervals.get(2000)();
  assert.equal(count("chat_send"), 3);
  assert.equal(count("typing_start"), 2, "typing is throttled to one per 3 s, like the client");
  assert.equal(h.metrics.ws_messages_sent.at(-1).tags.phase, "burst");

  // Presence: one flip per 10 min, on a per-VU phase inside that period, so
  // the population flips at N / 600 s rather than never inside the run.
  const phase = h.evaluate("presencePhaseMs(185)");
  assert.equal(phase, 184 * 300);
  const delay = (((phase - (epoch + 200000)) % 600000) + 600000) % 600000;
  const flip = h.timeouts.find((t) => t.ms === delay);
  assert.ok(flip, "the first flip waits for the VU's own slot");
  flip.callback();
  h.intervals.get(600000)();
  const statuses = h.frames
    .filter((f) => f.type === "presence_update")
    .map((f) => f.payload.status);
  assert.deepEqual(statuses, ["idle", "online"]);
});

test("scale herd: every socket drops on its spread slot and redials a full ready (OC-0445 phases kept)", () => {
  const env = scaleEnv();
  // Offsets spread (vu - 1) % N over the 15 s spread.
  const late = harness(env, 1001);
  assert.equal(late.evaluate("herdOffsetMs(1001)"), 7500);

  const h = harness(env, 185);
  h.at(200.25);
  h.start();
  const firstSend = h.intervals.get(8000);
  assert.equal(h.evaluate("herdOffsetMs(185)"), 1380);
  const drop = h.timeouts.find((t) => t.ms === 510000 + 1380 - 200250);
  assert.ok(drop, "the drop is scheduled at the VU's herd slot");
  h.at(511.38);
  drop.callback();
  assert.equal(h.closes(), 1);
  assert.equal(h.metrics.herd_drops.length, 1);

  // The redial is a fresh connection (no last_seq): a full ready.
  h.at(512);
  h.evaluate("websocketScenario()");
  const auth = h.frames.at(-1);
  assert.equal(auth.type, "auth");
  assert.equal(auth.payload.last_seq, undefined);
  // The send timer re-anchors on the first connection's phase (250 ms of 8 s),
  // not the redial instant.
  assert.equal(h.evaluate("vuTimerPhase.send"), 250);
  assert.ok(h.timeouts.some((t) => t.ms === 250));
  assert.equal(h.intervals.get(8000), firstSend, "no new interval at the redial instant");
  h.at(512.5);
  h.receive({ type: "auth_ok" });
  h.at(513);
  h.receive({ type: "ready" });
  assert.equal(h.metrics.herd_readies.length, 1);
  assert.equal(h.metrics.herd_ready_at_ms.at(-1).value, 3000);
  assert.equal(h.metrics.ws_ready_time.at(-1).tags.phase, "herd");
  assert.equal(h.metrics.ws_auth_ok_time.at(-1).tags.phase, "herd");
  // A later reconnect of the same VU is not a second herd ready.
  h.evaluate("websocketScenario()");
  h.receive({ type: "ready" });
  assert.equal(h.metrics.herd_readies.length, 1);
});

test("scale herd: a dial that opens after the VU's slot drops on the next tick, not a 0 ms timer", () => {
  // Under load a connect takes seconds: a VU that starts dialling just before
  // its slot opens after it, and k6 refuses socket.setTimeout(fn, 0).
  const h = harness(scaleEnv(), 185);
  h.at(511.37); // the slot is 511.38
  h.dialTakes(2000);
  h.evaluate("websocketScenario()");
  const drop = h.timeouts.find((t) => t.ms === 1);
  assert.ok(drop, "the late dial still drops at once");
  drop.callback();
  assert.equal(h.closes(), 1);
  assert.equal(h.metrics.herd_drops.length, 1);
});

test("scale thresholds: existing budgets per phase, D3 herd and login-burst gates, no run-wide latency gate", () => {
  const h = harness(scaleEnv());
  const t = (key) => h.evaluate(`options.thresholds[${JSON.stringify(key)}]`);
  const has = (key, ...gates) => {
    for (const g of gates) assert.ok(t(key).includes(g), `${key} ${g}`);
  };
  has("ws_broadcast_latency_ms{phase:steady}", "p(95)<150", "p(99)<300");
  has("ws_delivery_latency_ms{phase:steady}", "p(95)<200", "p(99)<400");
  has("ws_auth_ok_time{phase:ramp}", "p(95)<200", "p(99)<500");
  assert.ok(t("ws_broadcast_latency_ms{phase:burst}").includes("p(95)<150"));
  assert.ok(t("ws_delivery_latency_ms{phase:burst}").includes("p(95)<200"));
  assert.deepEqual([...t("obs_population{phase:steady}")], ["min>=2000"]);
  assert.deepEqual([...t("herd_ready_at_ms")], ["max<=30000"]);
  assert.ok(t("ws_ready_time{phase:herd}").includes("p(95)<=5000"));
  assert.deepEqual([...t("herd_readies")], ["count>=2000"]);
  assert.deepEqual([...t("obs_backpressure{phase:herd,kind:queue_disconnects}")], ["count==0"]);
  assert.deepEqual([...t("login_burst_giveups")], ["count==0"]);
  assert.deepEqual([...t("login_burst_time")], ["max<=70000"]);
  assert.deepEqual([...t("login_burst_ok")], ["count>=500"]);
  assert.deepEqual([...t("login_giveups")], ["count==0"]);
  assert.deepEqual([...t("obs_ws_conn_rejects")], ["count==0"]);
  // The remaining existing budgets, each on the window it describes.
  assert.deepEqual([...t("ws_message_success{phase:steady}")], ["rate>0.95"]);
  assert.deepEqual([...t("ws_message_success{phase:burst}")], ["rate>0.95"]);
  assert.ok(t("ws_connect_time{phase:ramp}").includes("p(95)<2000"));
  assert.ok(t("ws_connect_time{phase:herd}").includes("p(95)<2000"));
  has("auth_time{phase:login}", "p(95)<600", "p(99)<1000");
  // Validity floors: 30% of 200 active users' planned sends (25/s steady for
  // 180 s, 100/s burst for 60 s), each delivered to 99 other members.
  assert.deepEqual([...t("ws_messages_sent{phase:steady}")], ["count>=1350"]);
  assert.deepEqual([...t("ws_deliveries{phase:steady}")], ["count>=133650"]);
  assert.deepEqual([...t("ws_messages_sent{phase:burst}")], ["count>=1800"]);
  assert.deepEqual([...t("ws_deliveries{phase:burst}")], ["count>=178200"]);
  assert.equal(t("ws_message_success"), undefined);
  assert.equal(t("ws_connect_time"), undefined);
  assert.equal(t("auth_time"), undefined);
  // A send answered with an error frame counts against its own window.
  const sender = harness(scaleEnv(), 185);
  sender.at(370);
  sender.start();
  sender.receive({ type: "error", payload: { code: "INTERNAL" } });
  sender.receive({ type: "chat_send_ok", id: "x" });
  assert.deepEqual(
    sender.metrics.ws_message_success.map((m) => [m.value, m.tags.phase]),
    [
      [false, "burst"],
      [true, "burst"],
    ],
  );
  // The herd is expected to break a run-wide percentile; each phase is gated
  // on its own instead, so a herd miss cannot hide or fail the steady result.
  assert.equal(t("ws_broadcast_latency_ms"), undefined);
  assert.equal(t("ws_delivery_latency_ms"), undefined);
  assert.equal(t("ws_errors"), undefined);

  const summary = h.summary({
    metrics: {
      "ws_broadcast_latency_ms{phase:steady}": {
        values: { med: 4, "p(95)": 9, "p(99)": 12, max: 30, count: 900 },
      },
    },
    state: { testRunDurationMs: 620000 },
  }).load_measurement;
  assert.equal(summary.profile, "scale");
  assert.equal(summary.planned_steady_messages_per_second, 25);
  assert.equal(summary.planned_burst_messages_per_second, 100);
  const steady = summary.windows.find((w) => w.phase === "steady");
  assert.deepEqual(steady.acknowledgement, { p50_ms: 4, p95_ms: 9, p99_ms: 12, sample_count: 900 });
  assert.deepEqual(steady.delivery, { p50_ms: null, p95_ms: null, p99_ms: null, sample_count: 0 });
  assert.ok(Number.isFinite(summary.run_start_epoch_ms));
});

test("capacity gates: live peak, delivery floor and every voice join are thresholds", () => {
  const voice = { K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "7" };
  const capacity = harness({ K6_PROFILE: "capacity", K6_PEAK_VUS: "10", ...voice });
  const t = (h, name) =>
    JSON.parse(h.evaluate(`JSON.stringify(options.thresholds["${name}"] ?? null)`)) ?? undefined;
  assert.deepEqual(t(capacity, "ws_ready"), ["count>=10"]);
  assert.deepEqual(t(capacity, "ws_unexpected_closes"), ["count==0"]);
  assert.deepEqual(t(capacity, "ws_deliveries"), [
    `count>=${capacity.evaluate("minDeliveries(SUSTAIN_S)")}`,
  ]);
  assert.ok(capacity.evaluate("minDeliveries(SUSTAIN_S)") > 1);
  assert.deepEqual(t(capacity, "voice_vus_joined"), ["count>=7"]);
  assert.deepEqual(t(capacity, "voice_tokens"), ["count>0"]);
  for (const env of [
    { K6_PROFILE: "ceiling-search", K6_CEILING_CHANNELS: channels(11) },
    scaleEnv(),
  ]) {
    const h = harness(env);
    assert.deepEqual(t(h, "ws_ready"), ["count>0"]);
    assert.deepEqual(t(h, "ws_deliveries"), ["count>0"]);
    assert.equal(t(h, "ws_unexpected_closes"), undefined);
  }
});

test("capacity counts a server-initiated close once ready, never its own hold-end close", () => {
  const dropped = harness({ K6_PROFILE: "capacity" });
  dropped.start();
  dropped.close();
  assert.equal(dropped.metrics.ws_unexpected_closes?.length ?? 0, 1);

  const held = harness({ K6_PROFILE: "capacity" });
  held.start();
  held.timeouts.at(-1).callback(); // hold end: the script closes its own socket
  held.close();
  assert.equal(held.metrics.ws_unexpected_closes?.length ?? 0, 0);
});

test("capacity counts a VU's first voice_token once, however many arrive", () => {
  const h = harness({ K6_PROFILE: "capacity", K6_VOICE_CHANNEL_ID: "9", K6_VOICE_VUS: "2" });
  h.start();
  h.receive({ type: "voice_token", payload: {} });
  h.receive({ type: "voice_token", payload: {} });
  assert.equal(h.metrics.voice_tokens.length, 2);
  assert.equal(h.metrics.voice_vus_joined.length, 1);
});
