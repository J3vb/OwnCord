# Capacity

What one OwnCord server is qualified to carry, on stated hardware, with the
commands that reproduce the measurement.

> **The hardware and the commands in this document were published before the
> first qualifying run.** That ordering is deliberate and is visible in
> `git log`: reference hardware chosen after seeing results is hardware chosen
> to fit the numbers. If a target is missed, the miss is published here and
> recorded in the findings ledger — it is never re-run on a bigger machine.

## The profile

| Property                 | Target | Why this number                                                 |
| ------------------------ | ------ | --------------------------------------------------------------- |
| Registered users         | ≥ 250  | BPR-030                                                         |
| Simultaneous connections | ≥ 100  | BPR-030, sustained for 180 s rather than touched at a peak      |
| Concurrent voice         | ≥ 25   | BPR-030; 25 audio publishers and 25 subscribers, so 625 streams |

## Reference hardware

**2 vCPU, 4 GB RAM, SSD, Linux x64** — the cheapest VPS or single-board class
an owner is likely to buy.

It is **reproduced, not owned**. The server runs inside a cgroup that gives it
exactly that budget, so anyone with Docker can re-run the measurement:

```
docker run -d --name owncord-sut \
  --network=host \
  --cpuset-cpus=0,1 --cpus=2 \
  --memory=4g --memory-swap=4g \
  -v "$WORK:/app" -w /app \
  -e OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=100 \
  -e OWNCORD_VOICE_LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
  -e OWNCORD_VOICE_LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  -e OWNCORD_VOICE_LIVEKIT_URL=ws://127.0.0.1:7880 \
  -e OWNCORD_VOICE_LIVEKIT_BINARY=/app/livekit-server \
  -e OWNCORD_VOICE_NODE_IP=127.0.0.1 \
  -e OWNCORD_VOICE_ADVERTISE_INTERNAL_IP=true \
  debian:bookworm-slim /app/chatserver
```

Why each part of that is load-bearing:

- **`--cpuset-cpus=0,1` is the constraint, not `--cpus=2`.** `--cpus` is a CFS
  quota, and `runtime.NumCPU()` reads the CPU affinity mask, not the quota. With
  `--cpus=2` alone on a 32-core host the container still reports 32 CPUs, so the
  server sizes `GOMAXPROCS` and its bcrypt admission budget
  (`auth/admission.go`: twice the core count) for hardware the cgroup will never
  give it. Both flags are passed: the cpuset for what the runtime sees, the
  quota for what it may consume.
- **`--memory-swap=4g` equal to `--memory`** disables swap, so 4 GB is the
  ceiling rather than the point at which paging starts.
- **`--network=host`** because LiveKit's media path is UDP 50000-60000, and
  publishing ten thousand ports is not a thing. This removes a NAT hop, so the
  latencies below are a **floor** for bridged or reverse-proxied deployments,
  not a ceiling.
- **`debian:bookworm-slim` with the release binary mounted, not the published
  distroless image.** That image ships no shell and cannot host the companion
  `livekit-server` process this profile needs. The capacity claim is about the
  machine budget; the packaging is qualified separately by the artifact and
  container lifecycle smokes (`Server/cmd/smoke`,
  `Server/scripts/docker-smoke.sh`).
- **`node_ip=127.0.0.1` with `advertise_internal_ip`.** OwnCord's generated
  `livekit.yaml` sets `use_external_ip: true`; without a `node_ip` the SFU
  discovers the machine's public address by STUN and advertises ICE candidates
  no same-machine client can reach — voice connects and carries no media. These
  two knobs are a property of measuring on one machine, not of the product. The
  server logs its "node_ip is not a public address" warning, which is correct
  here and must not be copied into a real deployment.
- **The load generators are outside that budget**, pinned with
  `taskset -c 2,3`. A generator sharing the server's cores measures the
  generator.

### What is not the reference hardware

- The **ceiling leg** of `load-baseline.yml` runs the same profile with no
  cgroup at all, on the whole runner. It shows headroom. It is not capacity.
- The **benchmark baseline** in
  [plans/b3-bench-baseline-2026-09-01.md](plans/b3-bench-baseline-2026-09-01.md)
  was recorded on a 16-core developer workstation. It is a relative
  before/after instrument for Go benchmarks. It is not capacity either.

## Configuration

Everything else is the shipped default. The non-defaults are:

| Key                                             | Value       | Why                                                                                                                |
| ----------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `security.auth_rate_limit_multiplier`           | `100`       | Every connection logs in from 127.0.0.1, and the per-IP auth limits assume roughly one person per address          |
| `voice.livekit_api_key` / `livekit_api_secret`  | per run     | The shipped dev credentials are blanked at load and disable voice entirely, so a run on them would measure nothing |
| `voice.livekit_binary`                          | mounted SFU | Pins the SFU version and removes the container's need for egress and a CA bundle                                   |
| `voice.node_ip` / `voice.advertise_internal_ip` | loopback    | See above — single-machine ICE, not a deployment setting                                                           |

The SFU is **livekit-server 1.13.5**, the release the server itself downloads
(`ws.DefaultLiveKitVersion`). Measuring a different SFU release than the product
ships would measure something no owner ever runs.

## Latency budgets

Budgets may be **tightened from data and never loosened** — anything looser
than a published figure is a finding, not a number to publish. These are the
live budgets, already tightened from the first qualifying run; the "initial"
column is where the B6 PRD started, kept so the tightening is auditable.

| Path                                                    | p95      | p99      | Initial          | Measured by                      |
| ------------------------------------------------------- | -------- | -------- | ---------------- | -------------------------------- |
| REST login                                              | < 600 ms | < 1 s    | < 1 s / < 2 s    | k6 `auth_time`                   |
| WebSocket open → `auth_ok` received                     | < 200 ms | < 500 ms | < 1 s / < 2 s    | k6 `ws_auth_ok_time`             |
| Message send → sender acknowledgement                   | < 150 ms | < 300 ms | < 200 / < 500 ms | k6 `ws_broadcast_latency_ms`     |
| Message send → recipient delivery (every connection)    | < 200 ms | < 400 ms | < 250 / < 500 ms | k6 `ws_delivery_latency_ms`      |
| Voice join, OwnCord half (`voice_join` → `voice_token`) | < 250 ms | < 500 ms | < 2 s / < 4 s    | k6 `voice_join_time`             |
| Graceful drain to exit 0                                | < 20 s   | —        | unchanged        | `Server/cmd/smoke` `drainBudget` |

Each tightened budget keeps at least twice the measured p99 as headroom, so a
busier runner does not turn a published promise into a flake. `auth_time` is
the one with the least room on purpose: its floor is bcrypt at cost 12, roughly
a quarter-second of one core, and that is a deliberate security cost rather
than something to tune away.

Two of the PRD's rows are corrected rather than satisfied, because as written
they ask for measurements that cannot exist:

- **The sender-acknowledgement row said "(REST)".** No REST endpoint creates a
  message: every write reaches `service/message_delivery.go` from the WebSocket
  read pump. The budget is applied to the WebSocket `chat_send` →
  `chat_send_ok` round trip, which is the only send acknowledgement OwnCord has.
- **"Voice join (token + LiveKit room join)" is published as two halves.** k6
  has no WebRTC stack, and `lk load-test` publishes no join-latency
  distribution, so no tool here can produce the combined figure as a
  percentile. The OwnCord half is a real p95/p99 above; the LiveKit half is
  reported as the cohort's ramp-inclusive connect wall clock in the voice
  report, explicitly not a percentile.

## Reproducing the measurement

The whole profile is one workflow:

```
gh workflow run load-baseline.yml -f users=250 -f connections=100 -f voice=25
```

It runs both legs and uploads `capacity-constrained` and `capacity-ceiling`
artifacts (k6 summary, voice report, the container's own view of its cgroup
limits, the server's metrics snapshot and its log).

To run it by hand, after booting the server with the `docker run` above:

```bash
# 1. the population: owner, a text channel, a voice channel, an invite, 250 users
#    (a fresh install is invite mode, so the invite admits every registration)
BASE=https://127.0.0.1:8443
TOKEN=$(curl -sk -X POST "$BASE/admin/api/setup" -H 'Content-Type: application/json' \
  -d '{"username":"loadadmin","password":"LoadTest123!Admin"}' | jq -r .token)
CHANNEL_ID=$(curl -sk -X POST "$BASE/admin/api/channels" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"loadtest","type":"text"}' | jq -r .id)
VOICE_ID=$(curl -sk -X POST "$BASE/admin/api/channels" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"loadvoice","type":"voice"}' | jq -r .id)
INVITE=$(curl -sk -X POST "$BASE/api/v1/invites" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"max_uses":0}' | jq -r .code)
for i in $(seq 1 250); do
  curl -sk -o /dev/null -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"loadtest$i\",\"password\":\"LoadTest123!\",\"invite_code\":\"$INVITE\"}"
done

# 2. the SFU load — 25 audio publishers + 25 subscribers, in the background so
#    voice is present for the whole WebSocket run
PUBLISHERS=25 SUBSCRIBERS=25 DURATION=260s \
LIVEKIT_URL=http://127.0.0.1:7880 \
LIVEKIT_API_KEY="$LIVEKIT_API_KEY" LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  taskset -c 2,3 bash Server/scripts/voice-load.sh &

# 3. the WebSocket load — 100 connections, held for the whole run
cd Server/scripts/k6 && mkdir -p reports
K6_WS_URL=wss://127.0.0.1:8443/api/v1/ws K6_HTTP_URL=https://127.0.0.1:8443 \
K6_CHANNEL_ID="$CHANNEL_ID" K6_VOICE_CHANNEL_ID="$VOICE_ID" \
K6_PEAK_VUS=100 K6_VOICE_VUS=25 K6_RAMP=60s K6_SUSTAIN=180s \
  taskset -c 2,3 k6 run --insecure-skip-tls-verify ws-load.js
```

`Server/scripts/voice-load.sh --selftest` checks the voice harness's own
assertions offline, with no SFU and no `lk` binary.

## Reading these numbers

- **One machine, one run.** A figure here is comparable with another run of the
  same commands on the same cgroup, and with nothing else.
- **250 registered users is a seeded population, not 250 active ones.** The
  profile is 250 accounts in the database while 100 of them hold connections.
- **The 25 voice participants are a composition, not one cohort of 25.** The SFU
  carries 25 synthetic audio publishers and 25 subscribers from `lk load-test`
  (625 streams); OwnCord's control plane simultaneously carries 25 `voice_join`
  sessions from k6 with their tokens, voice states and broadcasts. They are not
  the same 25 identities, because k6 cannot speak WebRTC and `lk` cannot speak
  OwnCord's protocol. Both halves are under load at once, which is the property
  that matters, but this document will not claim 25 end-to-end clients.
- **`lk load-test` must be run with `--layout 5x5`.** Its default,
  `--layout speaker`, subscribes each simulated subscriber to about six tracks
  however many are published: a 25×25 room then reports 150/625 tracks at 0%
  packet loss with exit status 0. `voice-load.sh` sets the layout and asserts
  the track total for exactly that reason.
- **Message rate.** Each connection sends one message every 2 seconds
  (`K6_SEND_INTERVAL_MS`), so 100 connections produce ~50 messages/s fanned out
  to 100 recipients. That is a stress shape, not typical chat traffic; it is the
  fan-out the recipient-delivery budget is measured against.
- **Nothing in CI gates these numbers.** Like the benchmark baseline, they are
  recorded and published. `load-baseline.yml` is `workflow_dispatch` only,
  because a perf run on shared runners is a flake source.
- **The operational profiles below are per-phase, not per-run.** That section's
  database figures are deltas between phases of one run, so they answer "which
  scenario did the writer queue behind" and not "how long did the run wait".
  The run total is the figure this section already publishes.

## Operational measurements

The profile above is a **steady** load: connections that arrive once, hold, and
send. These seven measurements are what an operator meets afterwards — a storm
of reconnects, a writer under load, a restart during an update, a quota that
fills, TLS turned off. They use the same cgroup, the same generators and the
same rule as the profile: **the scenarios and their commands are published
before the first qualifying run**, and a figure comes from the constrained leg
or is not published at all.

They are selected by `K6_PROFILE`, and `capacity` remains the default.

```
gh workflow run load-baseline.yml -f profile=operational    --ref <branch>   # both TLS legs in one run
gh workflow run load-baseline.yml -f profile=restart        --ref <branch>
gh workflow run load-baseline.yml -f profile=ceiling-search -f ceiling_max=500 --ref <branch>
```

**None of them introduces a latency budget.** A scenario either applies a budget
this document already publishes, or publishes its number as what it is with no
budget attached — stated in its own subsection rather than left to inference.
That is the whole of the rule: a new target would need a PRD, and measuring is
not tuning.

### Reconnect storm

At `K6_STORM_AT` (default 120 s into the sustain, on the scenario clock) every
connection closes its socket and reconnects at once, carrying
`auth {last_seq, active_channel_id}`.

- **Measures** `ws_resume_time` (socket open → `auth_ok` with `last_seq > 0`),
  the `ws_replay_source{buffer,db,none}` split, and `ws_replay_gap` — the `seq`
  values between a connection's stored `last_seq` and the first live frame after
  `auth_ok` that were never delivered.
- **Gated on** `ws_replay_gap: max==0` and `ws_replay_source{tier:none}: count==0`. A
  replay with holes is a defect rather than a latency figure, and a storm that
  fell through to a full re-sync measured the wrong tier.
- **No latency budget.** A storm has none published here, and this document does
  not invent one for it.
- **Not `BenchmarkReconnectStorm`.** That is a Go microbenchmark with no sockets
  and no server; it shares a name with this scenario and nothing else.

### Database waits

An observer VU polls `/api/v1/metrics` every 5 s for the whole run, recording
the writer pair (`db_writer_wait_count`, `db_writer_wait_seconds`) and the reader
pair (`db_reader_wait_count`, `db_reader_wait_seconds`) as k6 **Counters** —
each sample is the delta since the previous poll, so the counter's total over a
window _is_ that window's delta — tagged `phase=<ramp|sustain|storm|upload>`,
alongside the reconnect tier split, backpressure and connection rejects.
Upload storage (`obs_upload_storage_used_mb`) is the one Gauge: it is a level,
not a delta.

The tier split and backpressure carry the phase alongside their own tag —
`obs_reconnect_tier{phase:storm,tier:buffer}`,
`obs_backpressure{phase:storm,kind:low_drops}` — which is what makes the
storm's reconnect tiers and dropped frames a **storm** figure rather than a run
total. The tier-only and kind-only keys stay beside them for the run total.

**The published figure is the per-phase delta, not the run total.** The total is
what the section above already had; the delta is what says which scenario the
writer queued behind.

**The reader pool was not surfaced before this, and now is.** The audit
carryover asked for pool wait deltas, and `/api/v1/metrics` reported only the
writer's `Stats()`. OwnCord runs one writer and a separate reader pool, so both
are reported side by side — "the reader never waited" is a claim a document can
only make after looking.

### Message fan-out, to the ceiling

`ceiling-search` steps connections by `K6_CEILING_STEP` (default 100) up to
`K6_CEILING_MAX` (default 500), ramping each step in over 30 s and holding it
60 s at the capacity profile's send rate. Every trend is tagged `step=<n>`, so
the summary carries a per-step p95/p99 for recipient delivery, sender
acknowledgement and login. Delivery and acknowledgement carry the tag only
during the hold: the 30 s ramp-in is the step's logins landing (paced at ~3/s
against a four-slot bcrypt admission budget), and a step's published figure is
the minute it was held at that count, not the bcrypt that got it there.

- **Publishes** the last step at which every budget above still held, plus the
  per-step table. The steps are informational and nothing is gated on them. The
  table's population column is `obs_connected_users{step:<n>}` — the server's
  own `connected_users`, sampled by the observer, because a socket opened at
  step 100 is still held at step 300. `ws_connections{step:<n>}` beside it is
  that step's arrivals only, i.e. whether its VUs got on the wire at all.
- **Gated on** `obs_ws_conn_rejects: count==0`. The workflow caps connections at
  twice the probe maximum for exactly this assertion: without it, a "ceiling"
  could be a configuration default rather than the hardware's.
- **A generator-limited step is marked, not published as a ceiling.** k6 shares
  a four-CPU runner with the server; the sampler records the generator's load
  average and the container's `cpu.stat` per step, and where the generator
  saturates first the document says so.
- **If every step holds at `K6_CEILING_MAX`, the answer is "above 500"** and the
  search stops there. It is not chased further on a shared runner.

### Voice control churn

The voice connections stop joining once and sitting: every `K6_VOICE_CHURN_MS`
(default 10 000) each leaves and rejoins. The voice-join budget above is
therefore applied under churn rather than under a single join, and a new
`voice_state_delivery_ms` measures a `voice_state` broadcast reaching a
_different_ connection.

- **Budget**: the voice-join row above. `voice_state_delivery_ms` has none.
- **Still not a WebRTC measurement.** k6 speaks OwnCord's control plane only;
  the media path remains `lk load-test`'s, as the profile's caveats say.

### Upload and download pressure

An HTTP scenario runs alongside the WebSocket sustain: connections upload one
`K6_UPLOAD_BYTES` file (default 256 KiB) at a time, against a server running a
1 MB per-user quota so that the quota bound is reachable inside the upload rate
limit. Downloads cover `GET /api/v1/files/{id}` of a file the caller admitted,
with a `Range` header on one request in four.

- **Measures both sides of the bound** — admission and refusal. A refusal path
  that was never exercised is a path with no evidence behind it, and the quota
  is the one that users actually hit.
- **Gated on** `upload_low_disk: count==0` and `upload_oversize: count==0`. A
  507 `STORAGE_LOW_DISK` means the runner's disk is filling rather than the
  server refusing, and an oversize rejection is a 400 here — so a non-zero count
  on either means the scenario is wrong, not that the server behaved.
- **The quota is 1 MB to be crossed, not to be recommended.** The shipped
  default is untouched; this is a measurement setting, like the auth rate-limit
  multiplier above.

### TLS overhead

The operational profile runs twice on the constrained leg, identical except for
`tls.mode`: `self_signed`, and `off` with both URLs flipped to the plaintext
scheme. Nothing else in the job differs, which is what makes the difference a
TLS delta rather than a configuration delta.

- **Publishes a delta per budget row**, `self_signed − off`, and nothing else.
  The delta is the measurement; neither leg is a new budget.
- **`tls: off` is measured and never shipped.** It exists to isolate what the
  handshake costs on this profile. No figure here recommends running without
  TLS, and the default remains `self_signed`.

### Graceful shutdown under load

The **workflow**, not k6, sends the stop: it waits until the connections are up
and sending, `docker stop --time=90`s the container (a grace past the 30 s
budget, so an overrun is measured rather than SIGKILLed), records the server's
exit code and the drain wall clock, then starts the same container again — same
cgroup, same flags, same data directory, so the second boot is the same server
and not a lookalike.

- **Measures** the restart frame reaching every connection and the lead from
  frame arrival to the socket actually closing; the resume time after the second
  boot; the sends attempted during the drain; and the sends lost.
- **Gated on** exit code 0, a drain inside the 30 s stop timeout, `sends_lost:
count==0`, and no replay gap across the restart. A message that was sent,
  never acknowledged and absent from the channel history after the second boot
  is a **lost message** — a defect recorded in the findings ledger and
  published as "lost N of M" until it is fixed, not a number to round. The
  history is the only place to look: the post-restart resume is a full re-sync
  (next point), so no replay will ever carry a drain-window send.
- **Delivery and acknowledgement are tagged `pre-restart` / `post-restart`**,
  so a budget missed under this profile can be placed on one side of the stop
  or the other rather than averaged across it.
- **Post-restart resume is always the `none` tier, by design.** A restart
  renumbers the sequence space and marks visibility changed, so a connection
  that resumes after one cannot be served from the `events` table and the server
  says so rather than replaying a gap. The tier split above is therefore
  measured on the storm, where the tiers are reachable.
- **The 20 s figure above is not this gate.** That is the idle smoke's drain;
  this drill's hard bound is the 30 s stop timeout, after which the container is
  killed and the run fails.

### Reproducing an operational scenario by hand

```bash
# server, with the profile's extra knobs; the boot itself is unchanged
docker run -d --name owncord-sut ... \
  -e OWNCORD_TLS_MODE=self_signed \
  -e OWNCORD_UPLOAD_USER_QUOTA_MB=1 \
  debian:bookworm-slim /app/chatserver

cd Server/scripts/k6 && mkdir -p reports
K6_PROFILE=operational K6_WS_URL=wss://127.0.0.1:8443/api/v1/ws \
K6_HTTP_URL=https://127.0.0.1:8443 K6_CHANNEL_ID="$CHANNEL_ID" \
K6_VOICE_CHANNEL_ID="$VOICE_ID" K6_PEAK_VUS=100 K6_VOICE_VUS=25 \
K6_RAMP=60s K6_SUSTAIN=180s \
  taskset -c 2,3 k6 run --insecure-skip-tls-verify ws-load.js
```

The `VAR=value command` prefix above is POSIX shell syntax; neither PowerShell
nor cmd understands it, so on Windows that line runs k6 with no knobs set and
silently measures the default profile. Pass them with k6's own flag instead
(`k6 run -e K6_PROFILE=operational …`), which works everywhere. These runs are
made on Linux, which is where the form above applies.

## Measured

Every number below comes from the **constrained** leg and from nothing else.

```
commit:          593c764b
date (UTC):      2026-09-12
workflow run:    34701291805  (.github/workflows/load-baseline.yml)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container:
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.5
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

| Profile target                       | Achieved                                                   | Met? |
| ------------------------------------ | ---------------------------------------------------------- | ---- |
| 250 registered users                 | 250 seeded, all registrations accepted                     | Yes  |
| 100 simultaneous connections (180 s) | 100 authenticated and ready, `vus_max` 100 for the sustain | Yes  |
| 25 concurrent voice participants     | 625/625 tracks at 12.5 mbps, 0% packet loss, 0 errors      | Yes  |

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 307 ms | 344 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 13 ms  | 29 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 57 ms  | 83 ms  | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 60 ms  | 85 ms  | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 3 ms   | 4 ms   | 250 ms / 500 ms    | Yes  |

Volumes behind those percentiles, so nobody has to take the distribution on
trust: 12,137 messages sent and 12,131 acknowledged, **1,139,476
cross-connection deliveries**, 25 voice tokens issued, **0 WebSocket errors**.
The voice cohort's connect-and-teardown wall clock was 5 s for all 50
participants, ramp-inclusive — not a percentile, and not comparable with the
OwnCord half above.

### Reproduced, and the tightened budgets re-verified

The tightened budgets above were set from run 34701291805 and then **run
again** against them, because a threshold that has never been evaluated is not
a gate. Run **34701991385**, same commit family, same constrained leg:

| Path                          | run 1 p95 / p99 | run 2 p95 / p99 | Budget          |
| ----------------------------- | --------------- | --------------- | --------------- |
| REST login                    | 307 / 344 ms    | 315 / 331 ms    | 600 ms / 1 s    |
| WebSocket open → `auth_ok`    | 13 / 29 ms      | 21 / 35 ms      | 200 ms / 500 ms |
| Send → sender acknowledgement | 57 / 83 ms      | 51 / 78 ms      | 150 ms / 300 ms |
| Send → recipient delivery     | 60 / 85 ms      | 53 / 79 ms      | 200 ms / 400 ms |
| Voice join (OwnCord half)     | 3 / 4 ms        | 4 / 6 ms        | 250 ms / 500 ms |

Run 2 again reached 100 connections, 1,139,491 cross-connection deliveries, 25
voice tokens, 625/625 voice tracks at 0% loss, and 0 WebSocket errors. Run-to-run
movement is a few milliseconds, so the budgets are not sitting on the noise.

### What this run also says

- **The reference hardware is not the limiting factor at this profile.** The
  ceiling leg — same run, same commit, no cgroup, the whole 4-CPU runner — came
  out within noise of the constrained leg (recipient delivery p95 58 ms vs
  60 ms, p99 83 ms vs 85 ms). Two CPUs and 4 GB are not saturated by 100
  connections and 25 voice participants, so the profile is met with room rather
  than met at the edge. It follows that these figures say little about where the
  real ceiling is; locating it is the `ceiling-search` profile's job, below.
- **The budgets were tightened, not met-and-left.** Every initial budget was
  between 3× and 1000× the measured figure, which would have let a large
  regression land without failing anything.
- **The `--layout` trap was not hypothetical.** The first 25×25 room measured
  during development reported 150/625 tracks at 0% loss and exit status 0 under
  `lk load-test`'s default layout. Every figure above comes from a run that
  asserted the track total.

### The operational profiles

The four runs named in [Operational measurements](#operational-measurements)
were made on 2026-09-16 from commit `e57335c7`, on the branch that added them.
Each block below is filled from its own **constrained** leg and from nothing
else, and the `tls off` block publishes as a delta against the `self_signed`
one rather than on its own.

Two budget rows are missed under the operational profile and under the restart
drill. They are published as missed, and each is a findings-ledger entry
(OC-0445, OC-0446, OC-0447); neither was re-run on a bigger machine and no
budget was loosened.

#### Operational, `tls.mode: self_signed`

```
commit:          e57335c7
date (UTC):      2026-09-16
workflow run:    35113946945  (.github/workflows/load-baseline.yml, profile=operational)
job:             104854470744  (operational, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.5
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

| Path                          | p95    | p99    | Budget (p95 / p99) | Met?                |
| ----------------------------- | ------ | ------ | ------------------ | ------------------- |
| REST login                    | 313 ms | 392 ms | 600 ms / 1 s       | Yes                 |
| WebSocket open → `auth_ok`    | 16 ms  | 26 ms  | 200 ms / 500 ms    | Yes                 |
| Send → sender acknowledgement | 228 ms | 348 ms | 150 ms / 300 ms    | **No** — both       |
| Send → recipient delivery     | 250 ms | 361 ms | 200 ms / 400 ms    | **No** — p95 missed |
| Voice join (OwnCord half)     | 239 ms | 292 ms | 250 ms / 500 ms    | Yes                 |

The two misses are the only thresholds the run crossed. They are OC-0445.

**Measurement-only rows — no budget is published for any of them, and this
document does not invent one.**

| Figure                                | p95    | p99    | Count               |
| ------------------------------------- | ------ | ------ | ------------------- |
| Storm resume, open → `auth_ok`        | 120 ms | 125 ms | 100                 |
| `voice_state` reaching another socket | 367 ms | 450 ms | 58,243              |
| Upload admitted (201)                 | 39 ms  | 48 ms  | 300                 |
| Upload refused by quota (507)         | 26 ms  | 70 ms  | 995                 |
| Authenticated download                | 16 ms  | 44 ms  | 300 (1 in 4 ranged) |

Storm: 100 of 100 sockets closed and resumed, **every one served from the
in-memory buffer** (`ws_replay_source{tier:buffer}` 100, `db` 0, `none` 0),
`ws_replay_gap` max 0, and the storm phase's `ws_conn_rejects` and all three
`backpressure_*` deltas 0. Uploads: 300 admits, 995 quota refuses, 0
`STORAGE_LOW_DISK`, 0 oversize, 75 MB of storage charged. 0 WebSocket errors,
0 login give-ups, 1,129,611 cross-connection deliveries from 12,044 sends.

Database waits, **per phase, as deltas** — the figure this section exists for:

| Phase   | Writer waits | Writer seconds | Reader waits | Reader seconds |
| ------- | ------------ | -------------- | ------------ | -------------- |
| ramp    | 893          | 4.4 s          | 9,106        | 8.4 s          |
| sustain | 2,710        | 5.8 s          | 31,219       | 28.6 s         |
| storm   | 2,043        | 12.0 s         | 13,282       | 10.2 s         |
| upload  | 5,163        | 27.2 s         | 54,096       | 47.2 s         |
| run     | 10,809       | 49.4 s         | 107,703      | 94.5 s         |

The storm's 30 s window carries more writer wait than the whole 60 s sustain
before it, and the upload phase carries more than the rest of the run put
together. The reader pool did wait: it is not a pool that never queues, which
is the claim this document could not make before the pair was surfaced.

Server CPU inside the cgroup, from `cpu.stat.log` (5 s samples of
`usage_usec`): 0.41 CPUs of 2 on average over the run, 1.23 at the peak, in
the upload phase. **The two CPUs were not the constraint on this run**, which
is worth saying beside a missed latency budget.

#### Operational, `tls.mode: off`

```
commit:          e57335c7
date (UTC):      2026-09-16
workflow run:    35113946945  (.github/workflows/load-baseline.yml, profile=operational)
job:             104854471050  (operational, constrained, tls off)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.5
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

Same shape as the block above: 100 of 100 storm resumes all from the buffer,
`ws_replay_gap` max 0, 0 WebSocket errors, 0 login give-ups, 1,129,876
deliveries, 300 admits / 995 quota refuses / 300 downloads, 0
`STORAGE_LOW_DISK`, 0 oversize. Server CPU 0.31 of 2 on average, 0.99 at the
peak. The same two thresholds were crossed, and by more:

| Path                          | p95    | p99    | Budget (p95 / p99) | Met?          |
| ----------------------------- | ------ | ------ | ------------------ | ------------- |
| REST login                    | 263 ms | 413 ms | 600 ms / 1 s       | Yes           |
| WebSocket open → `auth_ok`    | 9 ms   | 22 ms  | 200 ms / 500 ms    | Yes           |
| Send → sender acknowledgement | 329 ms | 472 ms | 150 ms / 300 ms    | **No** — both |
| Send → recipient delivery     | 333 ms | 470 ms | 200 ms / 400 ms    | **No** — both |
| Voice join (OwnCord half)     | 136 ms | 243 ms | 250 ms / 500 ms    | Yes           |

Per-phase database waits on this leg, for comparison with the table above:

| Phase   | Writer waits | Writer seconds | Reader waits | Reader seconds |
| ------- | ------------ | -------------- | ------------ | -------------- |
| ramp    | 1,084        | 3.6 s          | 9,202        | 4.6 s          |
| sustain | 3,343        | 58.4 s         | 30,074       | 14.0 s         |
| storm   | 3,025        | 108.9 s        | 15,106       | 12.5 s         |
| upload  | 8,356        | 318.3 s        | 52,505       | 25.8 s         |
| run     | 15,808       | 489.1 s        | 106,887      | 56.9 s         |

#### TLS delta, `self_signed − off`

A positive number means the TLS leg was slower.

| Row                                 | self_signed p95 / p99 | off p95 / p99 | Delta p95 / p99    |
| ----------------------------------- | --------------------- | ------------- | ------------------ |
| REST login                          | 313 / 392 ms          | 263 / 413 ms  | **+50 / −21 ms**   |
| WebSocket open → `auth_ok`          | 16 / 26 ms            | 9 / 22 ms     | **+7 / +4 ms**     |
| Send → sender acknowledgement       | 228 / 348 ms          | 329 / 472 ms  | **−101 / −124 ms** |
| Send → recipient delivery           | 250 / 361 ms          | 333 / 470 ms  | **−83 / −109 ms**  |
| Voice join (OwnCord half)           | 239 / 292 ms          | 136 / 243 ms  | **+103 / +49 ms**  |
| Storm resume                        | 120 / 125 ms          | 152 / 159 ms  | −32 / −34 ms       |
| `voice_state` cross-socket delivery | 367 / 450 ms          | 190 / 287 ms  | +177 / +163 ms     |
| Upload admitted                     | 39 / 48 ms            | 137 / 290 ms  | −98 / −242 ms      |
| Upload refused by quota             | 26 / 70 ms            | 18 / 81 ms    | +8 / −11 ms        |
| Authenticated download              | 16 / 44 ms            | 12 / 27 ms    | +4 / +17 ms        |
| Writer wait, run total              | 49.4 s                | 489.1 s       | −439.7 s           |

**Several rows come out negative: the plaintext leg measured slower on the two
message paths, on uploads and on resume, and the writer queued ten times
longer on it.** That is published as it was measured. It is also the reason no
TLS cost is claimed from this pair: the two legs are two matrix jobs on two
different runner VMs, so every row carries a full run's worth of runner noise,
and the run-to-run movement B6-9 observed (a few milliseconds) is nowhere near
±100 ms. The honest reading of this table is **"the TLS cost of this profile is
not distinguishable from runner noise at one run per mode"**, not any of the
individual signs in it. Nothing here recommends running with TLS off; the
default remains `self_signed`.

#### Restart under load

```
commit:          e57335c7
date (UTC):      2026-09-16
workflow run:    35113950011  (.github/workflows/load-baseline.yml, profile=restart)
job:             104854480908  (restart, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.5
lk:              2.18.6
load generators: k6, pinned to CPUs 2-3 with taskset (no voice leg on this profile)
```

The stop was sent 90 s into the run — 60 s of ramp plus 30 s at full fan-out.

| Drill figure                       | Measured                                    | Gate                    | Met? |
| ---------------------------------- | ------------------------------------------- | ----------------------- | ---- |
| Drain wall clock (`docker stop`)   | **6,157 ms**                                | inside 30 s             | Yes  |
| Server exit code                   | **0**                                       | 0                       | Yes  |
| `server_restart` frames received   | **100 of 100**                              | 100                     | Yes  |
| Lead, frame arrival → socket close | p95 5,013 ms, max 5,018 ms                  | ≥ `delay_seconds` (5 s) | Yes  |
| Sends attempted during the drain   | **250: 250 acked, 0 errored, 0 unanswered** | —                       | —    |
| Sends lost across the restart      | **0**                                       | 0                       | Yes  |
| Replay gap across the restart      | max 0                                       | 0                       | Yes  |
| Resume tier after the second boot  | 100 of 100 `none`                           | `none` by design        | Yes  |
| Resume time after the second boot  | p95 154 ms, p99 171 ms, max 226 ms          | no budget               | —    |

No message was lost: every one of the 250 drain-window sends was acknowledged
before the socket closed, and all 100 connections came back and re-synced with
no gap. The drain finished in a fifth of the 30 s budget under 100 connections
and in-flight writes.

The budget rows, and the two sides of the stop:

| Path                          | p95    | p99    | Budget (p95 / p99) | Met?          |
| ----------------------------- | ------ | ------ | ------------------ | ------------- |
| REST login                    | 272 ms | 301 ms | 600 ms / 1 s       | Yes           |
| WebSocket open → `auth_ok`    | 17 ms  | 22 ms  | 200 ms / 500 ms    | Yes           |
| Send → sender acknowledgement | 371 ms | 437 ms | 150 ms / 300 ms    | **No** — both |
| Send → recipient delivery     | 378 ms | 444 ms | 200 ms / 400 ms    | **No** — both |

| Side           | Recipient delivery p95 / p99 | Sender ack p95 / p99 | Deliveries |
| -------------- | ---------------------------- | -------------------- | ---------- |
| `pre-restart`  | **34 / 51 ms**               | 32 / 47 ms           | 271,051    |
| `post-restart` | **393 / 452 ms**             | 389 / 444 ms         | 859,303    |

**That ~10× gap is not an equal-load comparison, and must not be quoted as
one.** The `pre-restart` window is the first 90 s of the run: 60 s of ramp
during which most connections are not yet on the wire, then 30 s at full
fan-out. The `post-restart` window is the remaining ~186 s, all of it at full
fan-out. The delivery rates say the same thing — 3,012/s before the stop
against ~4,620/s after it — so part of the gap is simply that the two windows
carried different loads. It is a finding (OC-0446) rather than a published
per-side number, and the fix is to the measurement first: a pre-stop window
that is held at full fan-out for as long as the post-stop one.

What the artifacts can add on the post-restart side is narrow, and it does not
explain the gap:

- Server CPU inside the cgroup was **flat across the stop** — 0.23 CPUs of 2
  over the 30 s at full fan-out before it, 0.20 CPUs over the whole
  post-restart window. The second boot was not busier than the first.
- **No observer VU runs under the `restart` profile**, so there are no
  per-phase writer-wait deltas for this drill. That is the instrument this
  profile is missing, and it is why the paragraph above stops where it does.

**The harness has since been corrected (OC-0446), and the figures above predate
it.** Three things changed, none of which re-measures anything published here:

- **The stop is placed to equalize the windows.** The workflow now derives
  `RESTART_AT` as the midpoint that makes the steady-before and steady-after
  windows the same length — `(2·ramp + sustain − recovery) / 2`, which for the
  BPR-030 defaults is 135 s instead of 90 s. Both windows become 75 s of full
  fan-out.
- **The phases are read off the run clock, not off whether a connection
  resumed.** `restartPhase` splits the run into `ramp`, `pre-restart`,
  `recovery` and `post-restart`. The ramp is excluded from both steady windows;
  the outage and its reconnects are _published as their own phase_ rather than
  discarded, because that cost is exactly what burying it in a warm-up
  exclusion would erase. A resumed connection is no longer evidence of
  anything — it is true for every sample after the stop, including those taken
  while the rest of the cohort was still coming back.
- **The observer VU runs under `restart`**, so the per-phase writer-wait
  deltas exist on both sides of the stop, and a floor on
  `ws_deliveries{phase:pre-restart}` / `{phase:post-restart}` fails the drill
  when a window did not carry the workload — a comparison between two windows
  is worthless if either was empty.

The next restart run will publish an attributable post-restart figure. The
34/51 ms and 393/452 ms above remain what that run measured, and remain not an
equal-load comparison.

#### Ceiling search

```
commit:          e57335c7
date (UTC):      2026-09-16
workflow run:    35113953670  (.github/workflows/load-baseline.yml, profile=ceiling-search)
job:             104854495119  (ceiling-search, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.5
lk:              2.18.6
load generators: k6, pinned to CPUs 2-3 with taskset (no voice leg on this profile)
```

500 users seeded, `obs_ws_conn_rejects` **0** — so no figure below is a
configuration cap — and `login_giveups` 0. Four logins were refused by the
bcrypt admission budget and retried successfully.

| Step | Held (`obs_connected_users`) | Delivery p95 / p99 | Sender ack p95 / p99 | Login p95 | Writer wait | Server CPU (avg / peak of 2) | Host loadavg |
| ---- | ---------------------------- | ------------------ | -------------------- | --------- | ----------- | ---------------------------- | ------------ |
| 100  | 100                          | **29 / 142 ms**    | **28 / 134 ms**      | 241 ms    | 13.1 s      | 0.41 / 0.93                  | 1.26         |
| 200  | 200                          | 397 / 697 ms       | 378 / 675 ms         | 448 ms    | 132.0 s     | 0.71 / 1.22                  | 1.81         |
| 300  | 300                          | 27,349 / 29,477 ms | 30,005 / 33,108 ms   | 485 ms    | 319.2 s     | 0.93 / 1.57                  | 2.67         |
| 400  | **370** of 400               | 29,368 / 29,884 ms | 50,152 / 54,158 ms   | 833 ms    | 486.4 s     | 1.12 / 1.84                  | 3.43         |
| 500  | **411** of 500               | 29,076 / 29,830 ms | 50,906 / 55,674 ms   | 2,735 ms  | 2,395.2 s   | 1.37 / 1.93                  | 3.76         |

**The last step at which every budget above held is 100.** Step 200 already
misses recipient delivery (p95 397 ms against 200 ms) and sender
acknowledgement (378 ms against 150 ms).

**From step 200 up, this search is not measuring the hardware.** All
connections are in one channel sending one message every 2 s, so step 200 is
exactly 200 messages/s into a single channel — and
`topicRateLimitPerSecond = 100` (`Server/ws/hub_stats.go:73`, enforced at
`Server/ws/hub_broadcast.go:402`) caps any single channel at 100 messages/s.
The server log for this run carries **24,893 "hub: topic rate limit exceeded,
dropping message" lines**. Every step at or above 200 is therefore shed by a
constant in the code, and the latency above it is the shed queue plus a
quadratic fan-out (N senders × N recipients on one channel), not a machine
running out. A configuration or code cap must never be published as the
ceiling, so it is not: this table locates the **single-channel topic limiter**,
and the harness shape that walked into it is a finding (OC-0447).

The rest of what the run says, for whoever re-runs it:

- **No step was server-CPU-saturated.** The cgroup peaked at 1.93 of 2 CPUs in
  the top step and averaged 1.37; `nr_throttled` rose by 3 over the whole
  500 s run. Latency in the tens of seconds against a server at two-thirds of
  its budget is the limiter, not the box.
- **Steps 400 and 500 did not hold their population** — 370 of 400 and 411 of
  500 — while the 4-CPU host's load average reached 3.43 and 3.76 with k6 on
  two of those CPUs, and the server closed slow consumers: 797 "client send
  buffer full, closing connection to force reconnect" lines and 857 write-pump
  errors in the server log, against 4,062 client-side `ws_errors` from the
  reconnect churn that followed. **Both steps are marked generator-limited and
  population-short**, and neither is published as a server ceiling.
- The per-step figures are informational. Nothing is gated on them and no new
  budget is set by them.

**The harness has since been corrected (OC-0447), and the figures above predate
it.** The search no longer walks into the limiter:

- **The cohort is spread across channels.** The workflow seeds
  `ceil(ceiling_max / 150)` text channels and passes their ids to k6, and each
  connection picks one by its own VU slot. One message per connection per 2 s
  over 4 channels is 62.5 messages/s per channel at step 500 — a third of the
  limiter left unused — instead of 250/s on one. Connections now
  `channel_focus` the channel they post in, so a VU's subscription matches its
  traffic.
- **Shedding is now a hard failure, not a footnote.** A post-run step greps
  the server log for `topic rate limit exceeded` on the ceiling leg and fails
  the run if it finds any, with the same posture as the run's own
  `obs_ws_conn_rejects == 0`: the search is shaped to stay under the limiter,
  so a shed frame means the shaping is wrong and the steps above the first shed
  are **inconclusive rather than a ceiling**. `CEILING_CHANNELS` is printed in
  the failure so the fix is one input away.

The table above remains what that run measured. The step-100 figure is
unaffected by any of this — it was never near the limiter — and is still the
last step at which every budget held.
