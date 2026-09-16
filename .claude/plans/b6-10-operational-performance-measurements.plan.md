# Plan: B6-10 — Operational performance measurements

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-10 — Operational performance measurements (roadmap workstream 9, plus the 2026-09-06 "B3 performance evidence" audit carryover)
**Satisfies**: the operational half of BPR-030's "published measurements on stated hardware" — the numbers an operator needs _after_ the profile is met: what a reconnect storm, a restart, a saturated writer, a full quota and TLS cost on the reference hardware
**Complexity**: Large
**Drafted**: 2026-09-15 at `dev` `96258158` (B6-9 landed as PR #1592; #1593–#1595 on top of it touch nothing this plan changes)

## Summary

B6-9 proved the 250/100/25 profile fits on 2 vCPU / 4 GB with room to spare —
and, by its own post-merge note, "these figures say almost nothing about where
saturation begins". B6-10 is the second half of the capacity promise: the same
cgroup, the same generators, the same publish-before-run rule, applied to the
seven things the roadmap says must be measured and that a steady 100-connection
sustain never exercises.

Everything here is **measurement, not tuning, and not new targets**. The PRD
puts "new performance targets" out of scope; the only budgets applied are the
ones `docs/capacity.md` already publishes, and where a scenario has no budget
(a reconnect storm has none) the number is published as what it is. A missed
existing budget under an operational scenario is a ledger finding; a lost
message across a restart is a defect, not a number.

The seven measurements, and the instrument for each:

| #   | Roadmap says                               | What is measured                                                                                                                                                            | Instrument                                                 |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | reconnect storms                           | 100 sockets dropped and resumed at once with `last_seq`: resume time, `replay_source` tier split, replay gap integrity, `ws_conn_rejects` / backpressure deltas             | k6 scenario + `/api/v1/metrics` deltas                     |
| 2   | database waits                             | `db_writer_wait_count` / `db_writer_wait_seconds` **deltas per phase**, not a single end-of-run total                                                                       | k6 observer VU polling `/api/v1/metrics`, tagged by phase  |
| 3   | message fan-out                            | where recipient-delivery p95/p99 leave their budget as connections step 100 → 200 → … on the constrained cgroup — the ceiling B6-9 could not locate                         | k6 step-load scenario, per-step tagged trends              |
| 4   | voice control                              | `voice_join` → `voice_token` and `voice_state` broadcast delivery while the 25 voice VUs churn join/leave, instead of joining once and sitting                              | k6 voice-churn scenario                                    |
| 5   | upload/download pressure (audit carryover) | authenticated `POST /api/v1/uploads` admission through **both** bounds — quota admit (201) and quota refuse (507) — plus `GET /api/v1/files/{id}` under the WebSocket load  | k6 HTTP scenario with a deliberately small `user_quota_mb` |
| 6   | TLS overhead                               | the same profile on `tls.mode: self_signed` and `tls.mode: off`, published as a delta per budget row                                                                        | second matrix dimension on the constrained leg             |
| 7   | graceful shutdown                          | `docker stop` under 100 connections and in-flight sends: `server_restart` reaches every client, drain wall clock vs the 30 s budget, exit 0, no message lost across restart | workflow-driven restart while k6 holds sockets and resumes |

**No number publishes unless it came from the constrained cgroup.** The ceiling
leg stays a labelled headroom check exactly as in B6-9.

## Verify before you implement

Facts established from source at `96258158`. Rows marked **Refuted** or
**Corrected** contradict something the roadmap, the PRD or an obvious first
design would assume, and the plan is built on the correction.

| Claim                                                                                              | Status                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B6-9 is complete and the constrained leg is reusable as-is                                         | **Confirmed**                         | `load-baseline.yml:74` `leg: [constrained, ceiling]`; `docs/capacity.md` Measured section carries runs 34701291805 and 34701991385                                                                                                                                                                                                                                                                                                                                                                           |
| Writer-pool wait count/duration are already exposed                                                | **Confirmed**                         | `Server/api/metrics_handler.go:68-69` `db_writer_wait_count` / `db_writer_wait_seconds`, fed by `database.SQLDb().Stats()` (`router.go:552`)                                                                                                                                                                                                                                                                                                                                                                 |
| Reader-pool wait is exposed                                                                        | **Unknown**                           | `db/diagnostics.go:82` reports only `d.writer.Stats()`. Task 0 checks whether `db.go` keeps a separate reader pool; if it does and its `Stats()` is not surfaced, add the pair. The roadmap says "pool" waits, plural                                                                                                                                                                                                                                                                                        |
| Reconnect tier counters and backpressure totals are already exposed                                | **Confirmed**                         | `metrics_handler.go:40-50` `reconnect_tier_{buffer,db,full}`, `backpressure_*`, `ws_conn_rejects`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/api/v1/metrics` is reachable from the load generator without a token                             | **Confirmed**                         | `docs/api.md:2824` IP-restricted; the generator is on `--network=host` at 127.0.0.1, and B6-9's "Snapshot server metrics" step already reads it                                                                                                                                                                                                                                                                                                                                                              |
| A client resumes with `last_seq` and is told which tier served it                                  | **Confirmed**                         | `docs/protocol.md:141` `auth.last_seq`; `:192` `auth_ok.replay_source` ∈ `none` / `buffer` / `db`; `:309` three-tier pipeline, ring 1000 events, `events` table 5000                                                                                                                                                                                                                                                                                                                                         |
| A resumed socket needs `active_channel_id` to keep receiving the channel during resume             | **Confirmed**                         | `docs/protocol.md:150-160` — without it, broadcasts between `auth_ok` and the `channel_focus` round trip reach nobody on that connection. The storm scenario sends it, or it measures a gap the protocol documents                                                                                                                                                                                                                                                                                           |
| The in-memory ring does not survive a restart, so a restart storm is a **tier-`db`** storm         | **Corrected (during implementation)** | `protocol.md:311-315` tier 1 is the in-memory buffer; `shutdownServers` (`internal/app/http.go`) drains handlers into the persister before stopping the hub so the `events` table holds the tail. **But the resume is served tier `none`, not tier `db`**: the per-boot seq floor (OC-0210, `internal/app/persistence.go:105`) renumbers the sequence space and the boot marks visibility changed, so buffer/db replay after a restart is fail-closed unreachable. The gate is `ws_replay_source{tier:none}` |
| The server tells clients it is going away, with a delay                                            | **Confirmed**                         | `docs/protocol.md:1815` `server_restart {reason, delay_seconds}`; `hub.GracefulStopContext` (`ws/hub.go:316`) sends it inside the shutdown budget                                                                                                                                                                                                                                                                                                                                                            |
| The shutdown budget is 30 s, the smoke's drain budget is 20 s                                      | **Confirmed**                         | `internal/app/lifecycle.go:30` `shutdownBudget = 30 * time.Second`; `cmd/smoke/main.go:48` `drainBudget = 20 * time.Second`. capacity.md publishes the 20 s row. Under load the 30 s is the contract; 20 s is what an idle server proves                                                                                                                                                                                                                                                                     |
| TLS overhead needs a reverse proxy or a second listener                                            | **Refuted**                           | `tls.mode: off` exists — `auth/tls.go:93,97` returns a nil `TLSConfig`, `internal/app/healthcheck.go:50` handles it, `config.go:539` documents it. Same binary, same cgroup, one env var                                                                                                                                                                                                                                                                                                                     |
| Upload admission goes through quota **and** headroom before the store write                        | **Confirmed**                         | `service/storage_quota.go:18` "Charge BEFORE the store write"; `UploadService.Reserve` (`:144`) checks both bounds; `upload_handler.go:138-150` maps them to **507** `STORAGE_QUOTA_EXCEEDED` / `STORAGE_LOW_DISK`                                                                                                                                                                                                                                                                                           |
| An oversize upload is a 413                                                                        | **Refuted**                           | `docs/api.md:238` — oversize is **400**; the API's only 413 is plugin install. The k6 scenario must not classify a 400 as a quota refusal                                                                                                                                                                                                                                                                                                                                                                    |
| The per-user quota is configurable from the environment                                            | **Confirmed**                         | `config.go:359` `upload.user_quota_mb` (0 = unlimited); `OWNCORD_UPLOAD_USER_QUOTA_MB` via `envKeyToKoanf` (`:695-700` documents the `upload.` prefix)                                                                                                                                                                                                                                                                                                                                                       |
| Uploads are rate-limited **10/minute per user**                                                    | **Confirmed**                         | `docs/api.md:1965`. This caps the shape: the measurement is admission latency at a realistic rate, not upload throughput                                                                                                                                                                                                                                                                                                                                                                                     |
| Downloads are authenticated and range-capable                                                      | **Confirmed**                         | `docs/api.md:1988-1998` `GET /api/v1/files/{id}`, Bearer, `Cache-Control: private, no-cache`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BenchmarkReconnectStorm` is a network measurement of a reconnect storm                            | **Corrected**                         | `ws/hub_bench_test.go:40` — 50 in-process sim clients, hub-only, no socket, no auth, no TLS. It is a microbenchmark and stays labelled as one (roadmap item 9's last sentence). B6-10 measures the wire path                                                                                                                                                                                                                                                                                                 |
| `max_ws_connections` could become the ceiling the step-load search "finds"                         | **Confirmed**                         | `config.go:271`; `ws_conn_rejects` counts refusals. The ceiling search sets it explicitly above `K6_CEILING_MAX` and asserts `ws_conn_rejects` stayed 0, so a config cap is never published as a hardware ceiling                                                                                                                                                                                                                                                                                            |
| One k6 VU keeps state across iterations, so "reconnect on close" is expressible without a new tool | **Confirmed**                         | k6 documented behaviour: module-scope variables are per-VU and persist between iterations; `ws.connect` is blocking, so a closed socket ends the iteration and the next iteration reconnects with the stored `last_seq`                                                                                                                                                                                                                                                                                      |
| `K6_`-prefixed knobs must avoid k6's own option names                                              | **Confirmed**                         | B6-9 post-merge note (`K6_VUS` collided). New knobs here: `K6_PROFILE`, `K6_STORM_AT`, `K6_CEILING_MAX`, `K6_CEILING_STEP`, `K6_UPLOAD_BYTES`, `K6_VOICE_CHURN_MS` — none is a k6 option                                                                                                                                                                                                                                                                                                                     |
| `.claude/plans/` is tracked and Prettier-gated                                                     | **Confirmed**                         | `.gitignore` whitelist; PRD open question decided 2026-09-08                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### What the corrections change

- **TLS overhead is a one-line matrix dimension**, not a proxy rig. The
  operational profile runs twice on the constrained cgroup — `self_signed` and
  `off` — and the document publishes the per-row delta. It is a delta, never an
  absolute promise about `off`, because nothing ships with TLS off.
- **The upload scenario classifies by body, not status family.** 201 admit,
  507 + `STORAGE_QUOTA_EXCEEDED` quota refuse, 507 + `STORAGE_LOW_DISK` headroom
  refuse (should be zero here; non-zero means the runner's disk, not the
  server, is the story), 400 oversize (a scenario bug), anything else an error.
- **The restart storm is the tier-`db` measurement**, and the client-side
  storm is the tier-`buffer` one. Both tiers get a real number; `reconnect_tier_*`
  deltas prove which tier each storm actually hit, so a storm that quietly fell
  through to `full` re-sync is visible.

## Patterns to Mirror

| Category                    | Source                                               | Pattern                                                                                                                                            |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Env-gated scenario          | `Server/scripts/k6/ws-load.js:80-81,144-155`         | `VOICE_VUS` is 0 unless the channel id is set, and its thresholds exist only when the leg does — a disabled leg neither fails nor passes vacuously |
| Frame quoted from the spec  | `ws-load.js` (every `case` cites `docs/protocol.md`) | The script is not generated and has drifted before; every new frame type carries the protocol line it was read from                                |
| `count>0` sanity thresholds | `ws-load.js:139-142`                                 | `ws_authed`, `ws_ready`, `ws_deliveries` — a percentile over an empty sample passes, so every new phase gets a count assertion                     |
| Per-leg gating              | `.github/workflows/load-baseline.yml:335-347`        | Constrained leg fails on a breach with the "do NOT re-run on a bigger box" annotation; ceiling leg is `::notice::` only                            |
| Publish before run          | `docs/capacity.md:6-10`                              | Hardware, configuration and commands committed before the first qualifying run; the Measured section is a later commit, visible in `git log`       |
| Record the machine          | `load-baseline.yml:220-240`                          | cgroup limits read from **inside** the container into the artifact                                                                                 |
| Restart drill shape         | `Server/cmd/smoke/main.go:233-253`                   | Send the platform's graceful stop, assert clean exit inside the budget, then assert the second boot is healthy                                     |
| Labelled microbenchmark     | `docs/plans/b3-bench-baseline-2026-09-01.md:28-45`   | "Reading these numbers" states what the figure excludes and what it may be compared with                                                           |

## Files to Change

| File                                  | Action | Why                                                                                                                                                       |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Server/scripts/k6/ws-load.js`        | UPDATE | `K6_PROFILE=capacity` (default, byte-identical behaviour) / `operational` / `restart` / `ceiling-search`; the observer VU; storm, churn, upload scenarios |
| `.github/workflows/load-baseline.yml` | UPDATE | `profile` input; `tls` matrix dimension for the operational profile; the restart step; per-profile artifact names                                         |
| `Server/api/metrics_handler.go`       | UPDATE | **Only if Task 0 finds an unsurfaced reader pool** — one `sql.DBStats` source and two fields, mirroring the writer pair                                   |
| `docs/capacity.md`                    | UPDATE | New "Operational measurements" section: what each scenario is, its commands, an empty Measured block — committed **before** the run                       |
| `docs/api.md`                         | UPDATE | Only if a metrics field is added (it is a `gendocs:` block — regenerate, never hand-edit)                                                                 |
| `docs/deployment.md`                  | UPDATE | Added during implementation: the metrics reference is hand-written there, so a new field needs its sample row and its "what it means" bullet              |
| `.superpowers/findings-ledger.json`   | UPDATE | Any existing budget missed under an operational scenario; any message lost across the restart                                                             |
| `CHANGELOG.md`                        | UPDATE | Unreleased entry                                                                                                                                          |
| `docs/plans/b6-*.prd.md`              | UPDATE | B6-10 row → `in-progress` now, `complete` + this link at the end                                                                                          |

No new script, no new workflow, no new dependency. k6 already speaks HTTP,
multipart and WebSocket; the workflow already owns the cgroup, the SFU and the
seeding. Everything B6-10 needs is a scenario and a step.

## Tasks

### Task 0: Is the reader pool's wait exposed?

- **Action**: read `Server/db/db.go` around `pool()` (`:340`). If there is a
  reader `*sql.DB` distinct from the writer, and `/api/v1/metrics` reports only
  the writer's `Stats()`, add `DBReaderStats func() sql.DBStats` to
  `MetricsSources` and `db_reader_wait_count` / `db_reader_wait_seconds`,
  wired at `router.go:552` beside the writer. Regenerate `docs/api.md`
  (`cd Server && go run -tags otel,wazero ./cmd/gendocs`). If there is no
  separate reader pool, record that in the capacity document's "Reading these
  numbers" and do nothing.
- **Why**: the audit carryover asks for "database-pool wait count/duration
  deltas". A single-writer SQLite server queues on the writer, so that is the
  number that matters — but "the reader pool never waited" is a claim the
  document can only make if the reader pool was looked at.
- **Mirror**: `metrics_handler.go:152-156`, the writer pair.
- **Validate**: `metrics_handler_test.go` gains the reader pair in its
  table; `gendocs` leaves no diff after regeneration.

### Task 1: The operational profile in `ws-load.js`

- **Action**: `K6_PROFILE` selects the scenario set. `capacity` is the default
  and must leave the B6-9 run **byte-for-byte unchanged** in behaviour: same
  scenario, same thresholds, same metric names. Prove it by diffing the
  `k6-summary.json` metric key set of a `capacity` run before and after this
  change.

  `K6_PROFILE=operational` adds, on top of the 100-connection sustain:

  **The observer** — one VU, its own scenario, `GET /api/v1/metrics` every 5 s
  for the whole run. It records `db_writer_wait_count`, `db_writer_wait_seconds`,
  `reconnect_tier_*`, `backpressure_*`, `ws_conn_rejects`, `upload_storage_used_mb`
  (and the reader pair if Task 0 added it) as k6 Gauges tagged
  `phase=<ramp|sustain|storm|upload>`. Phases are wall-clock windows the
  scenarios' `startTime`s define, so the observer can tag by elapsed time. The
  per-phase **delta** is what publishes; the run-total is what B6-9 already
  had.

  **Reconnect storm (tier `buffer`)** — at `K6_STORM_AT` (default 120 s into
  the sustain) every VU closes its socket and reconnects immediately with
  `auth {last_seq, active_channel_id}` (`protocol.md:141,150`). Measures:
  - `ws_resume_time`: socket open → `auth_ok` with `last_seq > 0`;
  - `ws_replay_source{buffer|db|none}` counters from `auth_ok.payload.replay_source`;
  - `ws_replay_gap`: for each VU, the number of `seq` values between its
    stored `last_seq` and the first live frame after `auth_ok` that were
    **not** delivered. Must be 0 — a replay with holes is a defect, not a
    latency number. The VU keeps the highest `seq` it has seen (module scope,
    per VU) and checks contiguity on the replayed frames;
  - the observer's `ws_conn_rejects` and `backpressure_*` deltas in the storm
    phase.

  Thresholds: `ws_resume_time: count>0`, `ws_replay_gap: max==0`,
  `ws_replay_source_none: count==0` (a storm that fell through to a full
  re-sync measured the wrong tier). No latency budget — none is published, and
  the PRD forbids inventing one here.

  **Voice churn** — the 25 voice VUs stop joining once and sitting. Every
  `K6_VOICE_CHURN_MS` (default 10 000) each leaves and rejoins
  (`voice_leave`, then `voice_join` → `voice_token`, `protocol.md:1241-1275`,
  5/s limit is far away at this rate). `voice_join_time` keeps its capacity
  budget; new `voice_state_delivery_ms` measures the `voice_state` broadcast
  reaching a **different** VU, the same embedded-timestamp trick B6-9 used for
  `chat_message` — check first whether `voice_state` carries anything the
  sender controls; if not, correlate by `(user_id, event time on the observer's
clock)` since every VU shares one k6 process clock.

  **Upload admission and download** — a separate HTTP scenario, 100 VUs each
  uploading one `K6_UPLOAD_BYTES` file (default 256 KiB) every 10 s (inside the
  10/min limit, `api.md:1965`) with `OWNCORD_UPLOAD_USER_QUOTA_MB=1` on the
  server, so each user's fifth upload is refused by quota. Classifies by body:
  - `upload_admit_time` (201) and `upload_refuse_time` (507 +
    `STORAGE_QUOTA_EXCEEDED`);
  - `upload_low_disk: count==0` (507 + `STORAGE_LOW_DISK` means the runner is
    full, not the server under test);
  - `upload_oversize: count==0` (400 means the scenario is wrong,
    `api.md:238`);
  - `download_time` for `GET /api/v1/files/{id}` of a file this VU admitted,
    Bearer-authenticated, with `Range` on one in four to exercise the range
    path (`api.md:1996`).

  All of it runs **concurrently with the WebSocket sustain**, so the
  recipient-delivery trend is measured while the writer is also charging
  quotas — that interaction is the point of the observer's per-phase wait delta.

- **Why**: roadmap item 9, items 1, 2, 4 and 5 of the summary table, in the
  one script CI already owns. A second script would duplicate `authenticate`,
  `envelope` and the socket handler and drift independently.
- **Gotcha**: k6's `ws.connect` callback returns when the socket closes, so
  "reconnect with `last_seq`" is the next iteration of the same VU. The VU must
  not treat its own deliberate close as an error (`ws_errors` would fire 100
  times at the storm), and the reconnect must send `active_channel_id` or it
  measures the documented resume gap rather than the server.
- **Validate**: `k6 run ws-load.js` with `K6_PROFILE=operational` against a
  local server reports non-zero counts for every new metric and
  `ws_replay_gap` max 0; with `K6_PROFILE=capacity` the summary's metric key
  set is identical to the pre-change script. `npm run format` clean.

### Task 2: The ceiling search

- **Action**: `K6_PROFILE=ceiling-search` — one ramping-vus scenario stepping
  connections by `K6_CEILING_STEP` (default 100) from 100 to `K6_CEILING_MAX`
  (default 500), holding each step 60 s, sending at the capacity profile's
  rate. Every trend is tagged `step=<n>` so the summary carries per-step
  p95/p99 for `ws_delivery_latency_ms`, `ws_broadcast_latency_ms` and
  `auth_time`, and the observer's writer-wait delta per step.

  The workflow seeds `K6_CEILING_MAX` users for this profile (bcrypt cost 12 at
  2 cores is ~0.5 s each: 500 users ≈ 4 min, unmeasured, inside the job
  timeout) and boots the server with `OWNCORD_SERVER_MAX_WS_CONNECTIONS` set
  above the maximum, asserting `ws_conn_rejects == 0` at the end — otherwise
  the "ceiling" found is a config default.

  **What publishes**: "the last step at which every capacity.md budget held",
  plus the per-step table. Steps are informational; the profile is not gated
  on any of them and no new budget is set. If every step holds at
  `K6_CEILING_MAX`, publish that the ceiling is above 500 and stop — do not
  chase it on a shared runner.

- **Why**: B6-9's post-merge note: "two CPUs were not the bottleneck, so this
  profile does not locate the ceiling. Finding that is B6-10's work." Item 3
  of the summary table.
- **Gotcha**: the host is a 4-CPU runner and k6 itself sits on two of them;
  at 500 sockets × 50 msg/s fan-out the **generator** may be the bottleneck.
  The observer records k6's own `data_received` rate and the generator's CPU
  (`/proc/loadavg` from the workflow, sampled per step); if generator CPU is
  saturated before the server's cgroup is (`cpu.stat` `nr_throttled` from
  inside the container), the document says so and the step is marked
  "generator-limited", not published as a server ceiling.
- **Validate**: locally at `K6_CEILING_MAX=200 K6_CEILING_STEP=100` the summary
  carries two `step` tag values per trend.

### Task 3: The restart drill under load

- **Action**: `K6_PROFILE=restart` holds 100 connections sending at the
  capacity rate, and the **workflow**, not k6, sends the stop:

  ```bash
  # T+30s into the hold. --time is the SIGKILL deadline, set to 90 s so a
  # drain that overruns the 30 s budget (internal/app/lifecycle.go) is
  # measured and reported rather than killed and hidden.
  start=$(date +%s%N)
  docker stop --time=90 owncord-sut
  rc=$(docker wait owncord-sut)      # exit code of the drained server
  drain_ms=$(( ($(date +%s%N) - start) / 1000000 ))
  # boot again on the same data dir, same cgroup, same flags
  ```

  k6 measures on its side:
  - `server_restart_received: count==100` and
    `server_restart_lead_ms` — from the frame's arrival to the socket's
    actual close (should be ≥ `delay_seconds`, `protocol.md:1815`);
  - `restart_resume_time`: socket open → `auth_ok` after the second boot, with
    `ws_replay_source{tier:none}: count>0` — **corrected during implementation**:
    the ring dies with the process (`protocol.md:311`), but the per-boot seq
    floor (OC-0210) makes db replay unreachable too, so the designed
    post-restart resume is a full re-sync;
  - `ws_replay_gap: max==0` again, across the restart — every message a VU had
    acknowledged before the stop appears in some other VU's replay after it;
  - `sends_during_drain`: sends attempted after `server_restart` and before
    close, split by acknowledged / errored / unanswered. **Unanswered and
    absent from every replay is a lost message** — a ledger finding, severity
    high, not a number in the doc.

  The workflow records `drain_ms`, `rc`, and the server log's last lines into
  the artifact and fails the step if `rc != 0` or `drain_ms > 30000`.

- **Why**: items 1 (tier `db`) and 7 of the summary table. The smoke harness
  proves a 20 s idle drain; nothing yet proves the 30 s contract with 100
  clients and in-flight writes, which is the case the operator actually hits
  during an update.
- **Mirror**: `cmd/smoke/main.go` `drain` for the assert-then-boot-again shape;
  `shutdownServers` order (handlers drain **before** the hub stops, so the
  tail of writes reaches the persister — that ordering is exactly what
  `ws_replay_gap` checks from the outside).
- **Validate**: locally with `docker stop` by hand; `drain_ms` under 30 000,
  `rc` 0, `ws_replay_gap` max 0.

### Task 4: The workflow

- **Action**: `load-baseline.yml` gains `inputs.profile`
  (`capacity` default | `operational` | `restart` | `ceiling-search`) and, for
  `operational` only, a second matrix dimension `tls: [self_signed, off]` on
  the constrained leg (`fromJSON` on the input; the ceiling leg runs only for
  `capacity`, as today). `tls: off` sets `OWNCORD_TLS_MODE=off` and flips the
  k6 URLs to `http://` / `ws://`; nothing else changes, which is what makes the
  delta a TLS delta.

  Per profile: the seed count (`users` = `K6_CEILING_MAX` for the search), the
  extra env (`OWNCORD_UPLOAD_USER_QUOTA_MB=1` for operational,
  `OWNCORD_SERVER_MAX_WS_CONNECTIONS` for the search), the restart step, and
  the artifact name `capacity-<profile>-<leg>[-<tls>]`. Sample
  `/sys/fs/cgroup/cpu.stat` from inside the container per phase/step into the
  artifact (Task 2's generator-vs-server question).

  Gating stays as B6-9 left it: the constrained leg fails on a breach of an
  **existing** budget or of a `count`/`max==0` sanity threshold; new
  operational trends have no latency thresholds. The header gains a paragraph
  per profile saying what it measures and what it does not.

- **Why**: one workflow, one cgroup recipe, one seeding step; a second
  workflow would re-derive the constrained boot and diverge from the published
  `docker run` line.
- **Validate**: `actionlint`; ShellCheck 0.9.0 on the changed `run:` blocks
  (through Docker, as B6-9 did — `run.mjs` skips it on Windows); then one
  `gh workflow run load-baseline.yml --ref <branch> -f profile=<each>` per
  profile, all completing and uploading.

### Task 5: Publish the scenarios — before the run

- **Action**: `docs/capacity.md` gains an "Operational measurements" section,
  committed and pushed **before** any qualifying run of the new profiles:
  - one subsection per summary-table row: what the scenario is, the exact
    knobs and commands, which existing budget (if any) applies, and what the
    number is **not** (a storm has no budget; the TLS row is a delta; the
    ceiling step is generator-checked; the microbenchmark
    `BenchmarkReconnectStorm` is a different instrument);
  - "Reading these numbers" additions: per-phase deltas vs run totals; why
    the quota is 1 MB (to cross it, not to recommend it); why `tls: off` is
    measured but never shipped; the reader-pool answer from Task 0;
  - an empty Measured block per profile with the same provenance shape as the
    existing one (commit, run id, cgroup as seen from inside, SFU, lk, k6).
- **Why**: the same publish-before-run rule B6-9 established, for the same
  reason — scenarios designed after seeing results are scenarios chosen to
  pass. The commit order is the audit trail.
- **Validate**: `npm run format`, `npm run check:docs`; `gendocs` no diff.

### Task 6: Run it, record it, reconcile

- **Action**: dispatch each profile on the branch (operational twice, for the
  two TLS modes), fill the Measured blocks from the constrained artifacts
  only, then per outcome:
  - an existing budget held under the scenario → publish;
  - an existing budget missed → publish the miss, open a ledger finding with
    the file/line the scenario points at, **do not re-run bigger and do not
    loosen**;
  - `ws_replay_gap > 0` or a lost drain-time message → ledger finding, severity
    high, and the row publishes as "lost N of M" until fixed;
  - the ceiling search publishes its last-good step and per-step table, with
    generator-limited steps marked as such;
  - the TLS delta publishes per row as `self_signed − off`.

  Then the PRD: B6-10 row → `complete` (or `in-progress` naming the open
  finding), this plan linked; `CHANGELOG.md` unreleased entry; B6-11 is told
  in its own row that the restart-under-load drill already exists here and
  should be reused, not re-planned.

- **Validate**: `node .superpowers/render-ledger.mjs --check`; every Measured
  block names a run id and a commit; `ci-check` skill.

## Validation

```bash
# script
cd Server/scripts/k6 && K6_PROFILE=capacity    k6 run --insecure-skip-tls-verify ws-load.js   # unchanged metric set
cd Server/scripts/k6 && K6_PROFILE=operational k6 run --insecure-skip-tls-verify ws-load.js
npm run format && npm run check:docs && npm run check:hygiene
# workflow
actionlint
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:v0.9.0 <extracted run: blocks>
gh workflow run load-baseline.yml --ref feat/b6-10-operational-measurements -f profile=operational
gh workflow run load-baseline.yml --ref feat/b6-10-operational-measurements -f profile=restart
gh workflow run load-baseline.yml --ref feat/b6-10-operational-measurements -f profile=ceiling-search
# Go, only if Task 0 touched metrics
cd Server && go run -tags otel,wazero ./cmd/gendocs && git diff --exit-code docs/api.md
# everything
# → ci-check skill
node .superpowers/render-ledger.mjs --check
```

## Risks

| Risk                                                                                          | Likelihood | Impact | Mitigation                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The generator, not the server, is the ceiling at 400–500 sockets on a 4-CPU runner            | High       | High   | Per-step `cpu.stat` from inside the cgroup and k6 CPU on the host; a generator-limited step is labelled, never published as a server ceiling                                   |
| The storm's own 100 deliberate closes register as `ws_errors` and fail the existing threshold | High       | Low    | The VU marks its close as intentional before calling `socket.close()`; `ws_errors` counts only unexpected closes                                                               |
| `active_channel_id` omitted on resume measures the documented protocol gap, not the server    | Medium     | High   | The resume frame always carries it; `ws_replay_gap` would otherwise blame the server for a client omission                                                                     |
| A message sent in the drain window is lost and the doc quietly publishes a latency around it  | Medium     | High   | `sends_during_drain` splits acked / errored / unanswered and `ws_replay_gap` is a `max==0` threshold — lost is red, not a footnote                                             |
| `tls: off` gets read as a supported deployment                                                | Medium     | Medium | Published only as a delta, with the sentence "nothing ships with TLS off" beside it; `docs/deployment.md` untouched                                                            |
| The 1 MB quota is read as a recommendation                                                    | Low        | Low    | Stated in the doc as the value that makes the refuse path reachable inside a 10/min limit                                                                                      |
| The observer VU's polling perturbs the writer it measures                                     | Low        | Low    | `/api/v1/metrics` is a read of in-memory counters and `sql.DBStats`; 5 s cadence; the observer's own request time is recorded so a slow poll is visible                        |
| Seeding 500 bcrypt-12 users pushes the job past its timeout                                   | Medium     | Low    | Only the ceiling-search profile seeds that many; timeout raised for that profile; seeding is not measured                                                                      |
| The `capacity` profile drifts while the script grows                                          | Medium     | High   | Task 1's key-set diff is the acceptance test; the capacity thresholds block is not touched by this branch                                                                      |
| A shared runner's noise makes the TLS delta smaller than run-to-run variance                  | High       | Low    | Publish both runs' raw rows beside the delta; if the delta is inside B6-9's observed run-to-run movement (a few ms), say "not distinguishable from noise" rather than a number |

## Out of scope

- **New latency budgets for storms, restarts, uploads or the ceiling.** The PRD
  excludes new targets. These publish as measurements; HP-6 decides whether any
  becomes a promise.
- **Tuning anything to make a number better.** A missed existing budget is a
  finding with its own plan.
- **Disk-full, low-headroom, corrupt input, interrupted migration** — B6-11.
  The restart drill here is the healthy-restart case; B6-11 reuses it for the
  unhealthy ones.
- **ACME / manual TLS cost.** `self_signed` vs `off` isolates the handshake and
  record cost; certificate issuance is deferred with B6-3–B6-5.
- **Video, ARM64, bridged networking** — as B6-9.
- **Gating CI on any of this.** `workflow_dispatch` only, as before.

## Open questions for the owner

1. **Does the TLS delta need both TLS modes on the ceiling leg too?** Not
   taken: the ceiling leg is informational and would double its cost for a
   number nobody may quote.
2. **Is a lost drain-window message a B6-10 blocker or a B6-11 finding?** This
   plan files it as a high-severity ledger row and marks B6-10 `in-progress`
   until fixed; the owner may prefer to close B6-10 on the measurement and
   route the fix through B6-11's interrupted-restart drill.
3. **Ceiling-search maximum.** 500 is chosen as "twice the profile, then
   double again"; a higher figure on a 4-CPU runner is generator-bound before
   it is server-bound, so it is not offered.

## Acceptance

Ticked only where a run actually happened; evidence is the run id and commit in
`docs/capacity.md`'s Measured blocks.

- [ ] `K6_PROFILE=capacity` produces the same metric key set and thresholds as
      before this branch (diff of `k6-summary.json` keys attached to the PR)
- [ ] Reconnect storm: 100 resumes with `replay_source == buffer`,
      `ws_replay_gap` max 0, `ws_resume_time` published with its count, the
      storm-phase deltas of `ws_conn_rejects` and `backpressure_*` published
- [ ] Writer-pool wait count/seconds published as **per-phase deltas** (and
      the reader pair, or the documented reason it does not exist)
- [ ] Ceiling search: per-step p95/p99 table, the last step where every
      capacity budget held, `ws_conn_rejects == 0`, generator-limited steps
      labelled from `cpu.stat` evidence
- [ ] Voice churn: `voice_join_time` under join/leave churn against its
      existing budget, `voice_state` cross-VU delivery published
- [ ] Upload admission: 201 admit and 507 quota-refuse latencies published,
      zero `STORAGE_LOW_DISK`, zero 400; authenticated download (with range)
      latency under the WebSocket load published
- [ ] TLS: the operational profile on `self_signed` and `off`, delta per
      capacity.md row, with the noise caveat where the delta is inside
      run-to-run movement
- [ ] Restart under load: `server_restart` received by all 100, drain wall
      clock and exit 0 inside 30 s, `replay_source == none` on resume (corrected
      from `db`; see Task 3),
      `ws_replay_gap` max 0, `sends_during_drain` accounted — none lost
- [ ] Every published number comes from the constrained cgroup and the
      "Operational measurements" section's commit precedes each run's commit
      in `git log`
- [ ] Any miss or loss is a ledger finding, never a re-run on bigger hardware
- [ ] PRD row, changelog and `ci-check` green for the legs this branch touches
