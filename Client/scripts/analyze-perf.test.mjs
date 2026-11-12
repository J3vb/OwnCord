import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compareArms, eligible, group, parseLines, report } from "./analyze-perf.mjs";

const trial = (run, arm, value, status = "ok", reason) => ({
  kind: "trial",
  run,
  suite: "chat",
  scenario: "send",
  arm,
  status,
  reason,
  metrics: { ackMs: value },
});

const lines = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");

test("bad lines are reported and the rest still parse", () => {
  const text = `${lines([{ kind: "run", run: "r1" }, trial("r1", "base", 5)])}\nnot json\n{"kind":"x"}\n`;
  const parsed = parseLines(text);
  assert.equal(parsed.runs.size, 1);
  assert.equal(parsed.trials.length, 1);
  assert.deepEqual(parsed.errors, ["line 3: not JSON", 'line 4: unknown kind "x"']);
});

test("only ok trials feed the numbers, and an unverified one makes the scenario ineligible", () => {
  const scenarios = group([
    trial("r1", "base", 10),
    trial("r1", "base", 12),
    trial("r2", "base", 999, "unverified", "no GPU"),
  ]);
  const s = scenarios.get("chat / send");
  assert.deepEqual(s.statuses, { ok: 2, unverified: 1 });
  assert.equal(eligible(s.statuses), false);
  assert.deepEqual([...s.metrics.get("ackMs").get("base").values()], [[10, 12]]);
  const { text } = report(scenarios);
  assert.match(text, /Eligible: no\./);
  assert.match(text, /Not ok because: no GPU\./);
});

test("a discarded window does not block eligibility", () => {
  assert.equal(eligible({ ok: 5, discarded: 1 }), true);
  assert.equal(eligible({ ok: 5, failed: 1 }), false);
});

test("a real difference has an interval clear of zero, no difference straddles it", () => {
  const base = [
    [100, 102, 101],
    [99, 100, 101],
    [100, 101, 103],
  ];
  const faster = base.map((r) => r.map((v) => v - 30));
  const moved = compareArms(base, faster);
  assert.ok(moved.ci95[1] < 0);
  assert.ok(Math.abs(moved.pct + 30) < 1);
  const same = compareArms(
    base,
    base.map((r) => [...r].reverse()),
  );
  assert.ok(same.ci95[0] <= 0 && same.ci95[1] >= 0);
});

test("the compare table appears only for metrics both arms measured", () => {
  const scenarios = group([trial("r1", "base", 10), trial("r2", "cand", 8)]);
  const { text, json } = report(scenarios, ["base", "cand"]);
  assert.match(text, /cand vs base/);
  assert.equal(json.filter((j) => j.compare).length, 1);
  assert.equal(json.filter((j) => j.statuses).length, 1);
  assert.doesNotMatch(report(scenarios, ["base", "other"]).text, /other vs base/);
});

test("a scenario with no ok trials still appears in the JSON, with why", () => {
  const { json } = report(group([trial("r1", "base", 0, "unverified", "no GPU")]));
  assert.deepEqual(json, [
    { scenario: "chat / send", statuses: { unverified: 1 }, eligible: false, reasons: ["no GPU"] },
  ]);
});
