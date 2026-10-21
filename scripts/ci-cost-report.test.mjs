import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  minutesBetween,
  percentile,
  renderMarkdown,
  runnerOS,
  summarize,
} from "./ci-cost-report.mjs";

const at = (min) => new Date(Date.UTC(2026, 9, 1) + min * 60_000).toISOString();
const job = (name, start, end, labels = ["ubuntu-latest"], conclusion = "success") => ({
  name,
  started_at: at(start),
  completed_at: at(end),
  labels,
  conclusion,
});

test("runnerOS reads the runner label", () => {
  assert.equal(runnerOS(["windows-latest"]), "windows");
  assert.equal(runnerOS(["macos-14"]), "macos");
  assert.equal(runnerOS(["ubuntu-24.04"]), "linux");
  assert.equal(runnerOS([]), "linux");
});

test("percentile uses nearest rank", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([7], 90), 7);
});

test("minutesBetween ignores missing or reversed times", () => {
  assert.equal(minutesBetween(at(0), at(30)), 30);
  assert.equal(minutesBetween(null, at(30)), 0);
  assert.equal(minutesBetween(at(30), at(0)), 0);
});

test("summarize counts every attempt, skips skipped jobs and weights Windows", () => {
  const runs = [
    {
      id: 1,
      name: "CI",
      event: "pull_request",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(40),
    },
    {
      id: 2,
      name: "CI",
      event: "push",
      conclusion: "failure",
      run_started_at: at(0),
      updated_at: at(100),
    },
    {
      id: 3,
      name: "Nightly",
      event: "schedule",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(10),
    },
    {
      id: 4,
      name: "PR #12",
      event: "dynamic",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(1),
    },
    {
      id: 5,
      name: "PR #34",
      event: "dynamic",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(1),
    },
    {
      id: 6,
      name: "npm_and_yarn in /. - Update #1611282372",
      event: "dynamic",
      conclusion: "failure",
      run_started_at: at(0),
      updated_at: at(1),
    },
  ];
  const jobsByRun = new Map([
    [
      1,
      [
        job("Server", 0, 20),
        job("Client E2E (Windows native)", 0, 30.5, ["windows-latest"]),
        job("Docs", 0, 0, [], "skipped"),
      ],
    ],
    [
      2,
      [
        job("Server", 0, 20, ["ubuntu-latest"], "failure"),
        job("Server", 30, 50),
        job("Client E2E (Windows native)", 0, 100, ["windows-latest"], "cancelled"),
      ],
    ],
    [3, [job("Smoke", 0, 10)]],
  ]);

  const r = summarize(runs, jobsByRun);
  assert.equal(r.totalMinutes, 20 + 30.5 + 20 + 20 + 100 + 10);
  assert.equal(r.byOS.windows, 130.5);
  // Rounded up per job, Windows doubled: 20 + 31*2 + 20 + 20 + 100*2 + 10.
  assert.equal(r.billedMinutes, 332);

  const ci = r.workflows.find((w) => w.name === "CI");
  assert.deepEqual([ci.runs, ci.failed], [2, 1]);
  assert.equal(r.workflows.find((w) => w.name === "PR #n (dynamic, per PR)").runs, 2);
  assert.equal(r.workflows.find((w) => w.name === "Dependabot updates").runs, 1);

  const server = r.jobs.find((j) => j.name === "Server");
  assert.deepEqual([server.count, server.failed, server.minutes], [3, 1, 60]);

  assert.equal(r.native.count, 2);
  assert.equal(r.native.timedOut, 1);
  assert.equal(r.native.max, 100);
  assert.deepEqual(r.native.over, { 30: 2, 40: 1, 50: 1, 60: 1 });
  assert.ok(Math.abs(r.native.share - 130.5 / 200.5) < 1e-9);

  assert.deepEqual(
    r.events.map((e) => e.name),
    [
      "CI (push)",
      "CI (pull_request)",
      "Nightly (schedule)",
      "PR #n (dynamic, per PR) (dynamic)",
      "Dependabot updates (dynamic)",
    ],
  );
});

test("renderMarkdown names the window and the native job", () => {
  const runs = [
    {
      id: 1,
      name: "CI",
      event: "pull_request",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(40),
    },
  ];
  const jobsByRun = new Map([[1, [job("Client E2E (Windows native)", 0, 30, ["windows-latest"])]]]);
  const md = renderMarkdown(summarize(runs, jobsByRun), {
    repo: "o/r",
    since: "2026-09-01",
    until: "2026-10-01",
  });
  assert.match(md, /^# CI cost, o\/r, 2026-09-01 to 2026-10-01/);
  assert.match(md, /## Windows native E2E\n\n1 runs, 0 failed, 0 hit the 100-minute timeout/);
});
