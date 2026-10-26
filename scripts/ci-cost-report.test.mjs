import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs, { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import {
  CI_WORKFLOW,
  fetchJobs,
  parseArgs,
  minutesBetween,
  nativeTimeoutFromWorkflow,
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

test("nativeTimeoutFromWorkflow reads the client-native job, not a neighbour", () => {
  const yaml = [
    "jobs:",
    "  client-e2e:",
    "    timeout-minutes: 40",
    "  client-native:",
    "    name: Client E2E (Windows native)",
    "    timeout-minutes: 70",
    "    steps:",
    "      - run: x",
    "        timeout-minutes: 25",
    "  other:",
    "    timeout-minutes: 5",
  ].join("\n");
  assert.equal(nativeTimeoutFromWorkflow(yaml), 70);
  assert.throws(() => nativeTimeoutFromWorkflow("jobs:\n  other:\n    timeout-minutes: 5\n"));
  assert.ok(nativeTimeoutFromWorkflow(readFileSync(CI_WORKFLOW, "utf8")) > 0);
});

test("report arguments preserve defaults and valid explicit values", () => {
  assert.deepEqual(parseArgs([]), { days: 30, repo: "J3vb/OwnCord", json: "", cache: "" });
  assert.deepEqual(
    parseArgs([
      "--repo",
      "owner/repo",
      "--days",
      "7",
      "--json",
      "report.json",
      "--cache",
      "cache dir",
    ]),
    {
      days: 7,
      repo: "owner/repo",
      json: "report.json",
      cache: "cache dir",
    },
  );
});

test("report options reject missing values and following flags", () => {
  for (const flag of ["--days", "--repo", "--json", "--cache"]) {
    assert.throws(() => parseArgs([flag]), /requires a value/);
    assert.throws(() => parseArgs([flag, "--days", "7"]), /requires a value/);
    assert.throws(() => parseArgs([flag, ""]), /requires a value/);
  }
});

test("report repository names must contain exactly an owner and repository", () => {
  for (const repo of [
    "OwnCord",
    "owner/repo/extra",
    "https://github.com/owner/repo",
    "/repo",
    "owner/",
  ]) {
    assert.throws(() => parseArgs(["--repo", repo]), /owner\/repository/);
  }
});

test("report arguments reject invalid day counts and unknown options", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
    assert.throws(() => parseArgs(["--days", value]), /positive integer/);
  }
  assert.throws(() => parseArgs(["--typo", "7"]), /unknown argument/);
});

test("invalid report CLI arguments fail before making any GitHub request", () => {
  const blockNetwork =
    "data:text/javascript," +
    encodeURIComponent('globalThis.fetch = () => { throw new Error("UNEXPECTED_NETWORK"); };');
  const script = fileURLToPath(new URL("./ci-cost-report.mjs", import.meta.url));
  for (const args of [
    ["--repo"],
    ["--cache"],
    ["--json"],
    ["--repo", "owner/repo/extra"],
    ["--days", "0"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", blockNetwork, script, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /requires a value|owner\/repository|positive integer/);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
  }
});

function cacheFixture(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), "owncord-jobs-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "jobs-123-1.json");
  writeFileSync(file, contents);
  return { dir, file };
}

const cacheRun = [{ id: 123, run_attempt: 1 }];
const cacheJob = job("fixture job", 0, 2);

test("a valid jobs cache avoids every request, including an empty job list", async (t) => {
  for (const rows of [[cacheJob], []]) {
    const { dir } = cacheFixture(t, JSON.stringify(rows));
    const result = await fetchJobs("fixture/repo", cacheRun, "", dir, () =>
      assert.fail("cache hit made a request"),
    );
    assert.deepEqual(result.get(123), rows);
  }
});

for (const contents of ['{"partial":', "{}", "[null]", '[{"name":123}]']) {
  test(`invalid jobs cache is refetched: ${contents}`, async (t) => {
    const { dir, file } = cacheFixture(t, contents);
    let requests = 0;
    const result = await fetchJobs("fixture/repo", cacheRun, "", dir, async () => {
      requests++;
      return { jobs: [cacheJob] };
    });
    assert.equal(requests, 1);
    assert.deepEqual(result.get(123), [cacheJob]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [cacheJob]);
    assert.deepEqual(readdirSync(dir), ["jobs-123-1.json"]);
  });
}

test("cache repair publishes only complete paginated data", async (t) => {
  const { dir, file } = cacheFixture(t, "broken");
  let page = 0;
  const result = await fetchJobs("fixture/repo", cacheRun, "", dir, async () => {
    assert.equal(readFileSync(file, "utf8"), "broken", "cache replaced before the read completed");
    return { jobs: ++page === 1 ? Array(100).fill(cacheJob) : [cacheJob] };
  });
  assert.equal(page, 2);
  assert.equal(result.get(123).length, 101);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 101);
});

test("failed atomic replacement keeps the original and removes its temporary file", async (t) => {
  const { dir, file } = cacheFixture(t, "broken");
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (destination !== file) return original(source, destination);
    assert.deepEqual(JSON.parse(readFileSync(source, "utf8")), [cacheJob]);
    assert.equal(readFileSync(file, "utf8"), "broken");
    throw Object.assign(new Error("fixture replacement denied"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    fetchJobs("fixture/repo", cacheRun, "", dir, async () => ({ jobs: [cacheJob] })),
    /fixture replacement denied/,
  );
  assert.equal(readFileSync(file, "utf8"), "broken");
  assert.deepEqual(readdirSync(dir), ["jobs-123-1.json"]);
});
