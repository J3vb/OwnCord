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

function harness(env = {}, vu = 1) {
  let now = epoch;
  const metrics = {};
  const frames = [];
  const handlers = {};
  const intervals = new Map();
  let body = {};
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
    exec: { scenario: { startTime: epoch } },
    Counter: Metric,
    Gauge: Metric,
    Rate: Metric,
    Trend: Metric,
    check: () => true,
    sleep: () => {},
    http: {
      post: () => ({ status: 200, body: '{"token":"test-token"}' }),
      get: () => ({ status: 200, json: () => body }),
    },
    ws: {
      connect: (_url, _params, callback) => {
        callback({
          send: (frame) => frames.push(JSON.parse(frame)),
          on: (event, handler) => {
            handlers[event] = handler;
          },
          setInterval: (callback, ms) => intervals.set(ms, callback),
          setTimeout: () => {},
          close: () => {},
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
    evaluate,
    at: (seconds) => {
      now = epoch + seconds * 1000;
    },
    start: () => {
      evaluate("websocketScenario()");
      handlers.message('{"type":"auth_ok"}');
      handlers.message('{"type":"ready"}');
    },
    receive: (frame) => handlers.message(JSON.stringify(frame)),
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
