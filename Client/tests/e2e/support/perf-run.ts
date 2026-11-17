// The run record of an opt-in performance measurement: one header line saying
// exactly what ran (commit, versions, machine, settings, seed), then one line
// per trial, appended to test-results/perf/<suite>.jsonl for
// scripts/analyze-perf.mjs. Numbers, names and versions only: no tokens,
// message text or captured content.
//
//   OWNCORD_PERF_ARM     label of what is being measured (default "baseline")
//   OWNCORD_PERF_SEED    seed for generated content (default: random, recorded)
//   OWNCORD_PERF_TRIALS  trials per scenario (default 10)
import type { Browser } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { fromClientRoot } from "../config/clientRoot";

export const PERF_ARM = process.env.OWNCORD_PERF_ARM ?? "baseline";
export const PERF_SEED = Number(
  process.env.OWNCORD_PERF_SEED ?? Math.floor(Math.random() * 2 ** 31),
);
export const PERF_TRIALS = Math.max(1, Number(process.env.OWNCORD_PERF_TRIALS ?? 10));

export type TrialStatus = "ok" | "unverified" | "failed" | "discarded";
export type Metrics = Record<string, number | null>;

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: fromClientRoot("."), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function pinnedLiveKitServer(): string {
  const installer = readFileSync(fromClientRoot("tests/e2e/scripts/install-livekit.mjs"), "utf8");
  return /const release = "([^"]+)"/.exec(installer)?.[1] ?? "unknown";
}

function packageVersions(): { client: string; livekitClient: string } {
  const pkg = JSON.parse(readFileSync(fromClientRoot("package.json"), "utf8")) as {
    version: string;
    dependencies: Record<string, string>;
  };
  return { client: pkg.version, livekitClient: pkg.dependencies["livekit-client"] ?? "unknown" };
}

export interface Trial {
  readonly scenario: string;
  readonly trial: number;
  readonly status: TrialStatus;
  readonly metrics?: Metrics;
  /** Why a trial is not "ok". */
  readonly reason?: string;
  /** Labels that are not numbers: encoder, frame size, limitation reason. */
  readonly info?: Record<string, string>;
}

export interface PerfRun {
  readonly id: string;
  trial(row: Trial): void;
}

/** Starts a run: writes its header line and returns the trial writer. */
export function startPerfRun(
  suite: string,
  browser: Browser,
  settings: Record<string, string | number | boolean>,
): PerfRun {
  const out = fromClientRoot(`test-results/perf/${suite}.jsonl`);
  mkdirSync(dirname(out), { recursive: true });
  const id = randomUUID();
  const versions = packageVersions();
  const cpu = cpus();
  const header = {
    kind: "run",
    run: id,
    suite,
    arm: PERF_ARM,
    seed: PERF_SEED,
    startedAt: new Date().toISOString(),
    sha: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    client: versions.client,
    livekitClient: versions.livekitClient,
    livekitServer: pinnedLiveKitServer(),
    browser: `${browser.browserType().name()} ${browser.version()}`,
    // The browser lane runs software codecs on a headless browser; the encoder
    // each stream really used is recorded per stream, never inferred.
    backend: "browser-livekit-js",
    os: `${platform()} ${release()} ${arch()}`,
    cpus: cpu.length,
    cpuModel: cpu[0]?.model ?? "unknown",
    memGB: Number((totalmem() / 2 ** 30).toFixed(1)),
    load1: Number(loadavg()[0]!.toFixed(2)),
    ci: !!process.env.CI,
    network: "loopback, unshaped",
    settings,
  };
  appendFileSync(out, `${JSON.stringify(header)}\n`);
  return {
    id,
    trial(row) {
      const line = { kind: "trial", run: id, suite, arm: PERF_ARM, metrics: {}, ...row };
      appendFileSync(out, `${JSON.stringify(line)}\n`);
    },
  };
}

/** Round to a fixed number of decimals, keeping null for "not measured". */
export const round = (value: number | null | undefined, digits = 1): number | null =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));
