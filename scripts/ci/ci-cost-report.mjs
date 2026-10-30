#!/usr/bin/env node
// Measure what GitHub Actions spends on this repository over a window of days.
//
//   GITHUB_TOKEN=... node scripts/ci/ci-cost-report.mjs [--days 30] [--repo J3vb/OwnCord] [--json out.json] [--cache dir]
//   node --test scripts/ci/ci-cost-report.test.mjs
//
// ARCH-047: CI cost was quoted from one hand-timed run (docs/archive/plans/
// ci-cost-2026-09-20.md). This reads every run in the window and its jobs
// (every attempt, so reruns count), and prints job-minutes per workflow, event
// and runner OS, the slowest jobs, and how close the Windows native E2E comes
// to its timeout. Behind a proxy, set NODE_USE_ENV_PROXY=1.
//
// Job-minutes are wall time from a job's start to its end, rounded up per job
// the way GitHub bills private repositories. A public repository is not billed
// for standard runners, so for this repository the minutes measure queue
// pressure on the plan's concurrent-job cap, not money.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.github.com";
const DAY_MS = 86_400_000;
// Billing multipliers GitHub applies to private-repository minutes.
export const OS_MULTIPLIER = { linux: 1, windows: 2, macos: 10 };

export const CI_WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "ci.yml",
);

// nativeTimeoutFromWorkflow reads the client-native job's timeout-minutes, so
// the report judges timeouts against the limit CI actually enforces.
export function nativeTimeoutFromWorkflow(yaml) {
  const job = yaml.split(/\r?\n  client-native:\r?\n/)[1];
  const match = job?.split(/\r?\n  [\w-]+:\r?\n/)[0].match(/^ {4}timeout-minutes: (\d+)$/m);
  if (!match) throw new Error("ci.yml: no timeout-minutes on the client-native job");
  return Number(match[1]);
}

export function runnerOS(labels) {
  const joined = (labels ?? []).join(" ").toLowerCase();
  if (joined.includes("windows")) return "windows";
  if (joined.includes("macos")) return "macos";
  return "linux";
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const ms = Date.parse(end) - Date.parse(start);
  return ms > 0 ? ms / 60_000 : 0;
}

// summarize folds runs and their jobs into the report's numbers. jobsByRun maps
// a run id to every job of every attempt. A job that never started (skipped by
// an `if:`) has no started_at worth counting and contributes nothing.
export function summarize(
  runs,
  jobsByRun,
  { nativeJobName = "Client E2E (Windows native)", nativeTimeout = 100 } = {},
) {
  const workflows = new Map();
  const jobs = new Map();
  const byOS = { linux: 0, windows: 0, macos: 0 };
  const byEvent = new Map();
  let totalMinutes = 0;
  let billedMinutes = 0;

  for (const run of runs) {
    // Code scanning names each dynamic run after its PR, and Dependabot after
    // its update; one row per run would bury the workflows that matter.
    const name = /^PR #\d+$/.test(run.name)
      ? "PR #n (dynamic, per PR)"
      : / - Update #\d+$/.test(run.name)
        ? "Dependabot updates"
        : run.name;
    const wf = workflows.get(name) ?? { runs: 0, minutes: 0, billed: 0, wall: [], failed: 0 };
    wf.runs += 1;
    if (run.conclusion === "failure" || run.conclusion === "timed_out") wf.failed += 1;
    wf.wall.push(minutesBetween(run.run_started_at ?? run.created_at, run.updated_at));
    let runMinutes = 0;
    for (const job of jobsByRun.get(run.id) ?? []) {
      if (job.conclusion === "skipped") continue;
      const mins = minutesBetween(job.started_at, job.completed_at);
      if (mins === 0) continue;
      const os = runnerOS(job.labels);
      const billed = Math.ceil(mins) * OS_MULTIPLIER[os];
      runMinutes += mins;
      wf.minutes += mins;
      wf.billed += billed;
      byOS[os] += mins;
      totalMinutes += mins;
      billedMinutes += billed;
      const key = `${name} / ${job.name}`;
      const j = jobs.get(key) ?? {
        name: job.name,
        workflow: name,
        durations: [],
        failed: 0,
        timedOut: 0,
        os,
      };
      j.durations.push(mins);
      if (job.conclusion === "failure") j.failed += 1;
      if (job.name === nativeJobName && mins >= nativeTimeout - 1) j.timedOut += 1;
      jobs.set(key, j);
    }
    const ev = byEvent.get(`${name} (${run.event})`) ?? { runs: 0, minutes: 0 };
    ev.runs += 1;
    ev.minutes += runMinutes;
    byEvent.set(`${name} (${run.event})`, ev);
    workflows.set(name, wf);
  }

  const native = [...jobs.values()].find((j) => j.name === nativeJobName && j.workflow === "CI");
  return {
    totalMinutes,
    billedMinutes,
    byOS,
    workflows: [...workflows.entries()]
      .map(([name, w]) => ({
        name,
        runs: w.runs,
        failed: w.failed,
        minutes: w.minutes,
        billed: w.billed,
        wallP50: percentile(w.wall, 50),
        wallP90: percentile(w.wall, 90),
      }))
      .sort((a, b) => b.minutes - a.minutes),
    events: [...byEvent.entries()]
      .map(([name, e]) => ({ name, ...e }))
      .sort((a, b) => b.minutes - a.minutes),
    jobs: [...jobs.values()]
      .map((j) => ({
        workflow: j.workflow,
        name: j.name,
        os: j.os,
        count: j.durations.length,
        failed: j.failed,
        minutes: j.durations.reduce((s, d) => s + d, 0),
        p50: percentile(j.durations, 50),
        p90: percentile(j.durations, 90),
        max: Math.max(...j.durations),
      }))
      .sort((a, b) => b.minutes - a.minutes),
    native: native
      ? {
          count: native.durations.length,
          failed: native.failed,
          timedOut: native.timedOut,
          p50: percentile(native.durations, 50),
          p90: percentile(native.durations, 90),
          p99: percentile(native.durations, 99),
          max: Math.max(...native.durations),
          over: Object.fromEntries(
            [30, 40, 50, 60].map((m) => [m, native.durations.filter((d) => d > m).length]),
          ),
          timeout: nativeTimeout,
          share: native.durations.reduce((s, d) => s + d, 0) / (totalMinutes || 1),
        }
      : null,
  };
}

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const fmt1 = (n) => n.toFixed(1);

export function renderMarkdown(report, { repo, since, until }) {
  const out = [];
  out.push(`# CI cost, ${repo}, ${since} to ${until}`, "");
  out.push(
    `Job-minutes: **${fmt(report.totalMinutes)}** (Linux ${fmt(report.byOS.linux)}, Windows ${fmt(report.byOS.windows)}, macOS ${fmt(report.byOS.macos)}).`,
  );
  out.push(
    `At private-repository rates that would bill **${fmt(report.billedMinutes)}** minutes.`,
    "",
  );
  out.push(
    "## Per workflow",
    "",
    "| Workflow | Runs | Failed | Job-min | Billed-equiv | Wall p50 | Wall p90 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const w of report.workflows)
    out.push(
      `| ${w.name} | ${w.runs} | ${w.failed} | ${fmt(w.minutes)} | ${fmt(w.billed)} | ${fmt1(w.wallP50)} | ${fmt1(w.wallP90)} |`,
    );
  out.push(
    "",
    "## Per workflow and event",
    "",
    "| Workflow (event) | Runs | Job-min |",
    "| --- | ---: | ---: |",
  );
  for (const e of report.events) out.push(`| ${e.name} | ${e.runs} | ${fmt(e.minutes)} |`);
  out.push(
    "",
    "## Top 25 jobs by job-minutes",
    "",
    "| Workflow / job | OS | Runs | Failed | Job-min | p50 | p90 | Max |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const j of report.jobs.slice(0, 25))
    out.push(
      `| ${j.workflow} / ${j.name} | ${j.os} | ${j.count} | ${j.failed} | ${fmt(j.minutes)} | ${fmt1(j.p50)} | ${fmt1(j.p90)} | ${fmt1(j.max)} |`,
    );
  if (report.native) {
    const n = report.native;
    out.push("", "## Windows native E2E", "");
    out.push(
      `${n.count} runs, ${n.failed} failed, ${n.timedOut} hit the ${n.timeout}-minute timeout. Duration p50 ${fmt1(n.p50)} min, p90 ${fmt1(n.p90)}, p99 ${fmt1(n.p99)}, max ${fmt1(n.max)}. Over 30/40/50/60 min: ${[30, 40, 50, 60].map((m) => n.over[m]).join("/")}. ${fmt1(n.share * 100)}% of all job-minutes.`,
    );
  }
  return `${out.join("\n")}\n`;
}

async function get(path, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, { headers });
    } catch (err) {
      // A dropped connection over a run of a thousand requests is expected.
      if (attempt >= 4) throw new Error(`GET ${path}: ${err.message}`, { cause: err });
    }
    if (res?.ok) return res.json();
    // An exhausted hourly quota resets within the hour: wait for it rather than
    // throw away a long read.
    const reset = Number(res?.headers.get("x-ratelimit-reset"));
    if (res?.headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
      const waitMs = Math.min(reset * 1000 - Date.now() + 5000, 3_900_000);
      process.stderr.write(`rate limited, waiting ${Math.ceil(waitMs / 60_000)} min\n`);
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
      attempt = -1;
      continue;
    }
    if (res && (attempt >= 4 || (res.status < 500 && res.status !== 403 && res.status !== 429))) {
      throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// The runs endpoint stops at 1,000 results per query, so the window is read a
// day at a time.
async function fetchRuns(repo, since, until, token) {
  const runs = [];
  for (let day = since.getTime(); day < until.getTime(); day += DAY_MS) {
    const d = new Date(day).toISOString().slice(0, 10);
    for (let page = 1; ; page++) {
      const body = await get(
        `/repos/${repo}/actions/runs?created=${d}&status=completed&per_page=100&page=${page}`,
        token,
      );
      runs.push(...body.workflow_runs);
      if (body.workflow_runs.length < 100) break;
    }
  }
  return runs;
}

function validCachedJobs(jobs) {
  const timestamp = (value) =>
    value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  return (
    Array.isArray(jobs) &&
    jobs.every(
      (job) =>
        job !== null &&
        typeof job === "object" &&
        typeof job.name === "string" &&
        Array.isArray(job.labels) &&
        job.labels.every((label) => typeof label === "string") &&
        timestamp(job.started_at) &&
        timestamp(job.completed_at) &&
        (job.conclusion === null || typeof job.conclusion === "string"),
    )
  );
}

function readJobsCache(file) {
  try {
    const jobs = JSON.parse(readFileSync(file, "utf8"));
    return validCachedJobs(jobs) ? jobs : null;
  } catch (err) {
    if (err instanceof SyntaxError || err.code === "ENOENT") return null;
    throw err;
  }
}

function writeJobsCache(file, jobs) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(jobs), { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// A completed run's jobs never change, so with --cache each run is read once
// across invocations.
export async function fetchJobs(repo, runs, token, cacheDir, request = get) {
  const jobsByRun = new Map();
  let next = 0;
  async function worker() {
    while (next < runs.length) {
      const run = runs[next++];
      const cached = cacheDir ? join(cacheDir, `jobs-${run.id}-${run.run_attempt ?? 1}.json`) : "";
      const cachedJobs = cached ? readJobsCache(cached) : null;
      if (cachedJobs !== null) {
        jobsByRun.set(run.id, cachedJobs);
        continue;
      }
      const jobs = [];
      for (let page = 1; ; page++) {
        const body = await request(
          `/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`,
          token,
        );
        jobs.push(...body.jobs);
        if (body.jobs.length < 100) break;
      }
      jobsByRun.set(run.id, jobs);
      if (cached) writeJobsCache(cached, jobs);
      if (jobsByRun.size % 200 === 0)
        process.stderr.write(`jobs read for ${jobsByRun.size}/${runs.length} runs\n`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return jobsByRun;
}

export function parseArgs(argv) {
  const args = { days: 30, repo: "J3vb/OwnCord", json: "", cache: "" };
  const flags = new Set(["--days", "--repo", "--json", "--cache"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flags.has(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[++i];
    if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--days") args.days = Number(value);
    else if (flag === "--repo") args.repo = value;
    else if (flag === "--json") args.json = value;
    else args.cache = value;
  }
  if (!Number.isInteger(args.days) || args.days < 1)
    throw new Error("--days must be a positive integer");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo))
    throw new Error("--repo must use owner/repository form");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const until = new Date(new Date().toISOString().slice(0, 10));
  const since = new Date(until.getTime() - args.days * DAY_MS);
  const runs = await fetchRuns(args.repo, since, until, token);
  if (args.cache) mkdirSync(args.cache, { recursive: true });
  const jobsByRun = await fetchJobs(args.repo, runs, token, args.cache);
  const report = summarize(runs, jobsByRun, {
    nativeTimeout: nativeTimeoutFromWorkflow(readFileSync(CI_WORKFLOW, "utf8")),
  });
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(report, null, 2));
  }
  process.stdout.write(
    renderMarkdown(report, {
      repo: args.repo,
      since: since.toISOString().slice(0, 10),
      until: until.toISOString().slice(0, 10),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
