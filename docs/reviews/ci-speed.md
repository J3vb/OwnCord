# CI speed review

Reviewed 2026-11-06 against dev commit `f1cef74ed530c77d3dc814f583793d5747a9867b`.

## Decision

Keep this review small and documentation-only. The main costs are test execution,
mutation testing, and native compilation. Existing caches already cover most downloads.
No measured, sufficiently validated workflow change is ready to ship in this review.
Do not add cache overhead merely because an install step lacks a cache.

No files under `Client/src/` are changed. Implementation follow-ups must branch from
`dev` and target `dev`, retain all required check names, and preserve release isolation.

## Evidence and method

Read all 12 files in `.github/workflows/`, the shared Playwright installer action,
and `scripts/ci-select.mjs`. Sampled completed GitHub Actions runs using the jobs API
with `per_page=100`. Times below are job elapsed time (completion minus start), not
queue time, billing minutes, or end-to-end workflow duration. Concurrent jobs must
not be summed to estimate developer waiting time. Values are rounded to minutes.
The sample is deliberately small: it establishes priorities, not long-term percentiles
or a promised speedup. Failed nightly runs are included and identified below.

CI sample: three full `dev` push runs on 2026-11-06:
[42205920908](https://github.com/J3vb/OwnCord/actions/runs/42205920908),
[42209733453](https://github.com/J3vb/OwnCord/actions/runs/42209733453), and
[42213694435](https://github.com/J3vb/OwnCord/actions/runs/42213694435).
The jobs endpoint reports latest-attempt jobs; these are not a measurement of total
retry cost. PRs into dev can select fewer jobs than these full push runs.

| CI job                               | Observed range  | Dominant work                                                        |
| ------------------------------------ | --------------- | -------------------------------------------------------------------- |
| Server Build & Test (Windows)        | 27.80-28.75 min | Race tests: 22.52-23.33 min                                          |
| Server Build & Test (Linux)          | 22.57-25.92 min | Race/coverage: 14.40-16.68 min; deadlock: 4.02-4.35 min              |
| Client E2E (real server and media)   | 20.63-21.13 min | Test command: 18.97-19.67 min                                        |
| Client E2E (Windows native)          | 13.78-19.32 min | Two signed NSIS packages: 4.05-7.08 min, plus native build and tests |
| Client E2E (parity subset, blocking) | 14.37-16.87 min | Production specs: 13.27-15.78 min                                    |
| Client Static Checks                 | 14.57-14.83 min | Permissions mutation: 12.30-12.52 min                                |
| Rust Unit Tests                      | 12.40-41.30 min | Interop: 8.50-8.63 min; one apt install took 29.03 min               |
| Client Unit Tests                    | 6.70-10.02 min  | Coverage run plus half-hour-timezone run                             |
| Android APK                          | 6.68-8.30 min   | APK build: 5.00-6.65 min                                             |

The Rust outlier is an installation problem, not evidence that Rust compilation
always takes 41 minutes. In the newest run, system dependencies took 67 seconds.
Root `npm ci` in Repository Hygiene took one second in that run; an additional npm
cache is not justified by this observation. The parity browser install took 8-11
seconds across these runs, so browser downloading is not its bottleneck.

### Scheduled and release work

| Workflow / job                          | Sampled elapsed time                   | Evidence                                                                                                                                                       |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nightly mutation, slowest shard         | 58.30 min on Nov 5; 84.58 min on Nov 6 | [Nov 5 successful run](https://github.com/J3vb/OwnCord/actions/runs/41948882405), [Nov 6 failed run](https://github.com/J3vb/OwnCord/actions/runs/42145018264) |
| Nightly in-call heap                    | 66.70-66.95 min                        | Same two nightly runs; intentional hour-long call                                                                                                              |
| Nightly long-session soak               | 57.32 min on Nov 5                     | Same Nov 5 run; includes intentional idle time                                                                                                                 |
| Release, slowest build (Linux Tauri)    | 17.97 min                              | [Nov 4 release](https://github.com/J3vb/OwnCord/actions/runs/41874345658)                                                                                      |
| Desktop Artifact Smoke, Linux x64 build | 15.42 min                              | [Nov 6 run](https://github.com/J3vb/OwnCord/actions/runs/42219391858)                                                                                          |
| Load Baseline, constrained capacity     | 7.05 min                               | [Nov 1 run](https://github.com/J3vb/OwnCord/actions/runs/41305336276)                                                                                          |
| Upgrade and Rollback Rehearsal          | 4.83 min                               | [Nov 6 run](https://github.com/J3vb/OwnCord/actions/runs/42212487280)                                                                                          |
| Nightly Docker Smoke, amd64             | 4.23 min                               | [Nov 6 run](https://github.com/J3vb/OwnCord/actions/runs/42204013212)                                                                                          |
| Weekly Supply-chain Scan                | 0.63 min                               | [Nov 6 run](https://github.com/J3vb/OwnCord/actions/runs/42164010184)                                                                                          |
| Protocol N-1 Compatibility              | 0.55 min                               | [Nov 2 run](https://github.com/J3vb/OwnCord/actions/runs/41451157780)                                                                                          |

The reusable artifact-smoke target has separate build and smoke jobs; the build
number above is not the whole workflow. CI re-run is orchestration, and Claude Code
is request-driven automation: neither is a test-sharding priority. Their timeouts
are not runtime measurements. CodeQL appeared in Actions history but is outside the
checked-in workflow files reviewed here.

## Prioritized experiments

### 1. Bound Rust system-package installation latency

Investigate the 29-minute apt step first. Record apt update, removal, download and
installation times separately. Trial bounded download timeouts and retries, or adapt
the existing Playwright apt archive pattern to the Rust dependency list. Key any
archive by runner image, architecture and exact package-list inputs; a miss must
perform the full installation. An incomplete cache must never skip dependencies.
Keep this confined to ordinary CI initially; publishing jobs retain their current
cache restrictions. Do not cache system directories or skip apt verification.

Potential benefit: reduce a large observed tail; no median speedup established.
Validation: empty cache, refreshed runner image/package list, failed mirror, and a
complete compile/interop run. Package restoration needs its own small reviewed PR.

### 2. Split long tests while preserving required contexts

For server tests, first collect per-package `go test -json` timings on both platforms.
Go already runs packages concurrently: splitting an existing parallel invocation
can duplicate compilation without shortening its longest package. If independent
packages dominate, trial balanced shards and retain each existing required check as
an aggregate that fails for failed, cancelled or unexpectedly missing shards.
Linux coverage must merge every shard before applying the unchanged floors; retain
race, deadlock, tag-gated, document and generated-output checks.

For parity and full-stack Playwright jobs, measure per-spec timings, then trial two
balanced shards with isolated server/media state and uniquely named reports. Keep
all specs and retries unchanged, merge reports, and verify that failures propagate.
Extra runner slots and repeated setup can reduce waiting time while increasing total
runner minutes. Avoid changing native installer journeys in the same PR.

Potential benefit: a fraction of the 13-20 minute browser test steps, subject to
balance and available runner slots. No halving claim is justified yet.

### 3. Rebalance nightly mutation shards using measured duration

The Nov 6 `lib-rest-9` shard took 84.58 minutes, close to the 90-minute ceiling;
`lib-rest-4` took 79.62 and `stores-4` 77.97. Use multiple nights of actual duration
alongside mutant counts when splitting or moving targets. Preserve full target
coverage, one pinned dev revision, and failure on missing aggregate reports.
Do not lower mutation thresholds or shorten the intentional heap/soak durations.
The existing late-start guard protects daytime runner capacity; adding more shards
without considering queue contention can make PR feedback slower.

### 4. Refine skip-when-unchanged rules only after tracing consumers

The existing selector already skips unrelated capabilities on PRs into dev. It
runs everything on dev/main pushes, PRs into main and manual dispatch, and falls
back to everything when input is missing or unknown. Keep those semantics.

Candidate: narrowly classify test-only files under `Client/tests/` that have no
native, browser or integration consumers. Today the broad Client prefix selects
several expensive jobs. Trace direct imports, shared setup, fixtures, configuration,
source-reading tests and build scripts before adding an exact exception. Never
classify every test file or every Markdown file as irrelevant: cross-component
readers exist. Existing shared CI inputs under `.github/` and `scripts/` must retain
their conservative fallback unless an exact consumer inventory proves otherwise.

Test each exception with its positive consumers and its exclusions, rename/delete
inputs, and unknown-path fallback. Preserve expanded server matrix check names;
job-level skipping currently cannot replace their step-level gates. Do not use
workflow-level path filtering for required CI contexts. Protocol compatibility is
already path-filtered and explicitly non-required; keep its scheduled backstop.

## Caching decisions

- Keep existing npm, Go, Rust, libwebrtc, LiveKit and Docker caches. Inspect restore
  and save duration before changing keys; distinguish warm, cold and partial hits.
- The shared Playwright action already caches browsers and image-specific apt
  archives. A second cache would duplicate it.
- A root npm cache is rejected for now: the measured install is only one second.
  setup-node caches package-manager downloads, not an installed dependency tree;
  `npm ci` remains necessary on a hit. See the [official setup-node documentation](https://github.com/actions/setup-node/blob/v4/docs/advanced-usage.md#caching-packages-data).
- Nightly cargo-fuzz compilation and LiveKit downloads are possible cache targets,
  but measure their installation cost before adding more cache entries.
- Release and reusable artifact-smoke jobs deliberately avoid cache restoration;
  release Rust cache steps use lookup-only. Do not transplant ordinary CI caches
  into artifact-publishing or clean reproducibility builds.

## Delivery and acceptance

This PR contains only this report. No job, cache, test, threshold, trigger or check
name changes. The proposed root npm cache was discarded after measuring its cost.

For each later implementation, submit a separate small PR against dev with the
repository-required pre-flight plan. Compare at least five comparable before/after
runs, recording job time, setup time, queue delay, failures/retries and cache state.
Use `scripts/ci/ci-cost-report.mjs` for a wider window and runner-minute accounting;
include all API pages and rerun attempts when measuring total cost.

Run `npm run check:docs` for documentation changes. Workflow changes additionally
need `npm run check:hygiene`, actionlint and offline zizmor; selector changes need
the existing selector and workflow-guard suites. Never claim a skipped local tool
as a passed check. Cache experiments must prove cold operation and changed-input
invalidation; split jobs must prove complete coverage and failure propagation.
Revert a change if overhead exceeds savings or any required check stops reporting.
