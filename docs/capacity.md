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
- **`--network=host`** because LiveKit's default media path is the UDP
  50000-60000 range, and publishing ten thousand ports is not a thing. This
  removes a NAT hop, so the
  latencies below are a **floor** for bridged or reverse-proxied deployments,
  not a ceiling.
- **`debian:bookworm-slim` with the release binary mounted, not the published
  distroless image.** That image ships no shell and cannot host the companion
  `livekit-server` process this profile needs. The capacity claim is about the
  machine budget; the packaging is qualified separately by the artifact and
  container lifecycle smokes (`Server/cmd/smoke`,
  `Server/scripts/docker-smoke.sh`).
- **`advertise_internal_ip`.** OwnCord's generated `livekit.yaml` sets
  `use_external_ip: true`; on its own the SFU then advertises only the
  machine's STUN-discovered public address, which no same-machine client can
  reach — voice connects and carries no media. `advertise_internal_ip` keeps
  the host candidates alongside it. This knob is a property of measuring on one
  machine, not a deployment recommendation.
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

### Sizing for 1,000–2,000 online

The profile above is the **published floor** — the cheapest box an owner is
likely to buy, qualified at 2 vCPU / 4 GB for 100 connections. The scaling
target is larger, and on this hardware the two tiers below are the size to
buy. They are a **recommendation for a community that size**, not a measured
qualification: the qualifying runs for 1,000–2,000 are tracked by the scaling
phase and will be published here as they land, per this document's rule that
hardware is named before the numbers.

| Tier  | Hardware            | Qualifies                                      | Why this one                                                                                        |
| ----- | ------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Base  | 2 vCPU / 4 GB / SSD | the published profile and roughly 1,000 online | Steady state at realistic chat rates fits on 2 vCPU; the published 100-connection profile has room  |
| 2,000 | 4 vCPU / 8 GB / SSD | about 2,000 online                             | Roughly doubles bcrypt login throughput and fan-out CPU headroom, which are the two 2-vCPU ceilings |

Memory is not the constraint at either tier: 2,000 idle connections measure
about 266 MB resident, 324 MB at 100 messages/s and 443 MB at 200 messages/s,
with 3 goroutines per connection. Buy the **4 vCPU tier for 2,000** for the
CPU, not the RAM. Beyond 2,000, CPU fan-out is the next wall rather than
SQLite. Server-wide sustained message rate is bounded by SQLite's single
writer; that limit will be revisited as the scaling runs are published.

#### Open-file limit (file descriptors)

Every WebSocket holds one file descriptor, so a server's connection count is
bounded by `RLIMIT_NOFILE`. The Go runtime already lifts the soft limit to
just under the hard one at init, and the server **raises its soft limit to the
hard limit at start-up** and logs the result, so the number that matters is the
**hard limit** the supervisor or the shell sets. The risk is a low hard limit
— a plain `ulimit -n 1024`, or an old daemon or unit default of 1,024 — which a
few hundred online will reach, and which cannot hold 2,000 online (about 2,100
descriptors with the process's own files). How to set the hard limit under
systemd, Docker Compose or a bare binary, and the boot warning's budget, are
in [Open-file limit](deployment.md#open-file-limit-file-descriptors).

## Configuration

Everything else is the shipped default. The non-defaults are:

| Key                                            | Value       | Why                                                                                                                |
| ---------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `security.auth_rate_limit_multiplier`          | `100`       | Every connection logs in from 127.0.0.1, and the per-IP auth limits assume roughly one person per address          |
| `voice.livekit_api_key` / `livekit_api_secret` | per run     | The shipped dev credentials are blanked at load and disable voice entirely, so a run on them would measure nothing |
| `voice.livekit_binary`                         | mounted SFU | Pins the SFU version and removes the container's need for egress and a CA bundle                                   |
| `voice.advertise_internal_ip`                  | `true`      | See above — single-machine ICE, not a deployment setting                                                           |

The SFU is **livekit-server 1.13.7**, the release the server itself downloads
(`ws.DefaultLiveKitVersion`). Measuring a different SFU release than the product
ships would measure something no owner ever runs. The qualifying runs recorded
below predate the 1.13.7 pin and were measured against **1.13.5**; the blocks
name the release each was run on.

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

For the **steady** profile these budgets were tightened from a measured p99
with at least twice it as headroom, so a busier runner does not turn a published
promise into a flake. That headroom is a property of the steady shape:
the operational profile runs a storm, a 25-way voice churn and upload pressure
alongside the same fan-out, and there the acknowledgement p99 was once measured
_at_ its budget (ramp p99 299 ms on 2026-09-23) and once over it (tls-off upload
p99 301 ms against 300, filed as OC-0481). Both were busy-runner tails on the
2026-09-23 pair: the `dev` re-measurement of 2026-09-28 puts the operational
upload-phase p99 at 71 ms (tls-off) and 65 ms (`self_signed`), and the run-wide
p99 at 64 ms on both, so OC-0481 is resolved with no budget change.
The budgets do not move for a busy-runner tail — it is a finding, not a
number to loosen (see the operational section). `auth_time` is the one steady
row with the least room on purpose: its floor is bcrypt at cost 12, roughly a
quarter-second of one core, and that is a deliberate security cost rather than
something to tune away.

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
# The first-run setup token the server printed at start-up. It goes to stderr
# beside the banner, and `docker logs` includes both streams.
SETUP_TOKEN=$(docker logs owncord-sut 2>&1 | sed -n 's/.*Setup token[[:space:]]*//p' | tail -n 1)
TOKEN=$(curl -sk -X POST "$BASE/admin/api/setup" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg t "$SETUP_TOKEN" '{username:"loadadmin",password:"LoadTest123!Admin",setup_token:$t}')" | jq -r .token)
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

`node --test Server/scripts/k6/ws-load.test.mjs` executes the WebSocket harness
with mocked k6 I/O, checking channel assignment, rate bounds, restart boundaries,
summary samples and profile compatibility. It runs in the PR consistency job;
it does not replace a real load run.

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
  recorded and published. `load-baseline.yml` is `workflow_dispatch` plus a
  weekly `schedule:`, never part of the blocking CI matrix, because a perf run
  on shared runners is a flake source. GitHub runs a `schedule:` only from the
  default branch, so the schedule begins once this workflow reaches `main`;
  from then it re-measures the constrained profile on `main`'s commit each
  week (the workflow and the harness it drives are always the same revision),
  prints the commit it measured, and uploads its artifacts, so a regression is
  visible in the Actions history without anyone dispatching a run. A `dev`
  measurement is a dispatch with `--ref dev`. It does not gate anything.
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
- **Client timers keep their phase across the storm (OC-0445).** Every socket
  reopens at one instant, so a send, typing or presence timer restarted from
  that instant would put all 100 users on the same beat for the rest of the run
  — a metronome no population produces, and one that measured 500–750 ms
  acknowledgement p95 from the storm to the drain on an unchanged server.
  `phasedInterval` re-anchors each timer on the phase the connection's first
  socket established, and a resumed socket's first phased tick waits for
  `auth_ok`. `ws_broadcast_latency_ms` and `ws_delivery_latency_ms` carry
  `phase=ramp|sustain|upload|storm` so a run says which phase missed a budget.

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

The search uses **multiple pre-seeded text channels**, supplied through
`K6_CEILING_CHANNELS`. A connection focuses and posts in its assigned channel
for its lifetime. Each connection still sends once per `K6_SEND_INTERVAL_MS`:
step N still offers `N × 1000 / interval_ms` messages/s in total. The fan-out
is now within each channel, so these results are a multi-channel capacity
shape and are not directly comparable to the old single-channel fan-out.

The harness reserves **50% of the 100-message sliding one-second topic limit**.
For interval I, each VU can schedule `ceil(1000 / I)` sends in that window,
even when timers align. Each channel therefore gets at most
`floor(50 / ceil(1000 / I))` VU slots. Provision at least
`ceil((ceiling_max + 1) / slots_per_channel)` distinct, readable text channels;
the extra slot covers the observer's arbitrary VU id. The workflow seeds these
automatically at its default 2 s interval: **11 channels for 500 connections**.
Manual runs must supply the ids; missing, duplicate, invalid or insufficient
lists fail at init instead of silently measuring a topic cap. Faster custom
send intervals need more channels. The server's rate limit is unchanged.

The send interval itself is also bounded: each user may send at most 10
messages/second (`Server/service/message_crud.go`), so `ceiling-search` rejects
`K6_SEND_INTERVAL_MS` below 100 at init. A faster interval would be admitted
only for the subscribed subset and would silently publish that subset's latency
as the hardware ceiling — the same code-cap-masquerading-as-hardware defect
OC-0447 closed, one layer up.

`k6-summary.json` and stdout include `load_measurement.steps`: hold boundaries,
planned total and mean per-channel message rates, a conservative per-channel
one-second send bound, and **each channel's observed send-attempt count/rate**
(count divided by the 60 s hold, excluding ramp sends). This is generator-side
traffic evidence, not a server admission counter. Delayed processing can still
bunch frames at the server: the workflow's post-run gate must read
`topic_sheds_total == 0` from the server's `/api/v1/metrics` snapshot before
any step is called a hardware measurement. Report held population and
generator saturation alongside it.

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

The corrected search was run on 2026-09-28 (run 36360932108, on `dev`); its
per-step table and the limiting resources it names are under "Ceiling search" in
the measured section below.

### Voice control churn

The voice connections stop joining once and sitting: every `K6_VOICE_CHURN_MS`
(default 10 000) each leaves and rejoins, so the voice-join budget above is
applied under churn rather than under a single join. A `voice_state_delivery_ms`
trend measures a `voice_state` broadcast reaching a _different_ connection.

`K6_VOICE_CHURN_PHASE` selects the churn's shape (PERF-02):

- **`spread` (default)** — each voice VU's leave+rejoin sits at its own offset
  through the period, so the cohort's joins arrive like an ordinary
  population's churn and the voice-join row measures one join. This is the
  shape a published voice-join figure is taken from.
- **`aligned`** — every voice VU leaves and rejoins on the same instant. This
  serialises the cohort's joins into one queue: it is the deliberate burst
  OC-0480 records, published as that and never used for the voice-join row.
  The voice-join budget does not gate an `aligned` run (the burst is published
  unbudgeted); the count sanity gate still does. The 130–437 ms p95 previously
  published in this section came from this shape; it is a harness artifact, not
  a single-join cost.

- **Budget**: the voice-join row above, taken under `spread` (and by the
  capacity profile, which does not churn). `voice_state_delivery_ms` has none.
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
and sending, `docker stop --time=90`s the container (a grace past both the 30 s
drill gate and the server's 50 s teardown cap, so an overrun is measured rather
than SIGKILLed), records the server's exit code and the drain wall clock, then
starts the same container again — same cgroup, same flags, same data directory,
so the second boot is the same server and not a lookalike.

- **Measures** the restart frame reaching every connection and the lead from
  frame arrival to the socket actually closing; the resume time after the second
  boot; the sends attempted during the drain; and the sends lost.
- **Gated on** exit code 0, a drain inside 30 s, `sends_lost:
count==0`, and no replay gap across the restart. A message that was sent,
  never acknowledged and absent from the channel history after the second boot
  is a **lost message** — a defect recorded in the findings ledger and
  published as "lost N of M" until it is fixed, not a number to round. The
  history is the only place to look: the post-restart resume is a full re-sync
  (next point), so no replay will ever carry a drain-window send.
- **The 30 s drain gate is deliberately stricter than the server's cap.** The
  server bounds its whole teardown at 50 s (`teardownBudget` in
  `Server/internal/app/lifecycle.go`), of which the HTTP drain alone may take
  30 s (`httpDrainBudget`) to let a slow upload or export finish. The drill has
  no slow transfers in flight, so a normal restart must still finish well
  inside 30 s; a drain between 30 s and 50 s fails the drill even though the
  server would not have cut it short.
- **Delivery and acknowledgement keep their `phase:pre-restart` and
  `phase:post-restart` tags**, with a separate `phase:recovery` for the stop,
  drain, outage and reconnects. The explicit windows below separate recovery
  from settled load; neither ramp is included in the steady comparison.
- **Post-restart resume is always the `none` tier, by design.** A restart
  renumbers the sequence space and marks visibility changed, so a connection
  that resumes after one cannot be served from the `events` table and the server
  says so rather than replaying a gap. The tier split above is therefore
  measured on the storm, where the tiers are reachable.
- **The 20 s figure above is not this gate.** That is the idle smoke's drain;
  this drill's hard bound is the 30 s stop timeout, after which the container is
  killed and the run fails.

#### Restart measurement windows

All boundaries are seconds from the executor's scenario start, inclusive at
the start and exclusive at the end. Samples are assigned **at receipt**;
a delayed delivery sent in recovery but received after its boundary belongs
to the settled window. Defaults (`K6_RAMP=60s`, `K6_SUSTAIN=180s`,
`K6_RESTART_RECOVERY_S=30`) are:

| Existing phase tag | Window                                  | What it measures                                     |
| ------------------ | --------------------------------------- | ---------------------------------------------------- |
| `ramp`             | [0, 60) s                               | Growing population; excluded from steady comparison  |
| `pre-restart`      | [60, 135) s                             | 75 s of steady load before the scheduled stop        |
| `recovery`         | [135, 165) s                            | Stop, drain, outage and reconnect activity           |
| `post-restart`     | [165, 240) s                            | 75 s of planned settled load after recovery          |
| `ramp-down`        | [240, 260) s and any graceful-stop tail | Draining population; excluded from steady comparison |

`K6_RESTART_AT` defaults to `(2 × ramp + sustain − recovery) / 2`, rounded to
a whole second; the workflow uses 135 s. Manual runs must schedule the actual
stop to match this knob. The summary's `load_measurement.windows` gives the
configured boundaries/durations and **delivery and acknowledgement p95 and
sample counts** for every phase. Existing tagged metrics remain in place.
Empty windows report `sample_count: 0, p95_ms: null`, never a zero-latency
success. The steady-window delivery floors scale separately with each window's
duration, so explicit asymmetric `K6_RESTART_AT` overrides still work. Empty or
reversed steady/recovery windows fail configuration validation.

The recovery window is fixed, not proof that all connections recovered within
30 s. No receipts during an outage means no latency samples: read its sample
count with drain duration, resume timings and losses. Check the actual stop
against the planned boundary and verify the cohort recovered before calling
`post-restart` settled. A full load run is still needed to compare recovery
with settled and pre-stop p95s; a remaining steady-state gap is not automatically
caused by the restart. Historical numbers used different windows and must be
read with their original boundaries, even though the pre/post tag names survive.

The observer uses the same scenario clock and phases. After a detected reboot
(`uptime_seconds` decreases), counter deltas start from the new boot rather
than subtracting the old process's totals. Polls remain 5 s apart, and deltas
crossing a boundary are booked at the poll's end; they are supporting evidence,
not exact per-message attribution.

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

OC-0445's diagnosis profiled the constrained server with the block and mutex
samplers on, because a CPU profile alone cannot see contention on the single
SQLite writer. Enabling `server.pprof_enabled` (e.g.
`-e OWNCORD_SERVER_PPROF_ENABLED=true`) turns both samplers on, so no scratch
build is needed; their rates and overrides are in
[server-configuration.md](server-configuration.md). The listener is on
`127.0.0.1:6060`; the container runs with `--network=host`, so the host reaches
it directly. During the run, curl `goroutine?debug=2` dumps every 2 s and
back-to-back 30 s CPU profiles, then block, mutex and heap profiles once at the
end, with the sampler pinned to the generator CPUs (`taskset -c 2,3`) so it
does not compete with the server it measures.

## Scale profile

What 1,000–2,000 people online at once actually do, on the same reference
cgroup and the same pinned generators as everything above. It is the instrument
the scaling phase measures itself against, and like the rest of this document
**its method is published here before its first qualifying run**.

```
gh workflow run load-baseline.yml -f profile=scale --ref dev
# the defaults, spelled out:
#   -f scale_connections=2000 -f scale_active=0.1 -f scale_burst_send_ms=2000 -f scale_herd_spread_s=15
```

Constrained leg only, no voice leg. `K6_PROFILE=scale` in
`Server/scripts/k6/ws-load.js`; `capacity`, `operational`, `restart` and
`ceiling-search` are unchanged by it.

### Traffic model

The other profiles are stress shapes. Every connection sends every 2 s, types
every 4 s and flips presence every 15 s, which at 2,000 connections would be
1,000 messages/s. No community of 2,000 behaves like that, and no single SQLite
writer carries it. This profile uses the idle-heavy model the owner chose
(decision D2, 2026-09-30):

- **N connected** (`scale_connections`, default 2,000), spread over **20 text
  channels**: about 100 members per channel at 2,000.
- **A small active fraction.** `K6_SCALE_ACTIVE` defaults to 0.1, spread evenly
  within every channel. An active user sends a keyed `chat_send` every
  `K6_SCALE_SEND_MS` (default 8,000 ms), about **25 messages/s** server-wide.
  - The send carries a `client_message_id`, as the desktop client's does, so
    every message also writes its delivery receipt.
  - It is preceded by `typing_start` at most once per 3 s. That is the
    client's own throttle (`Client/src/components/MessageInput.ts`), and no
    one else types.
- **Presence only on a status flip.** Each user flips once per 10 minutes,
  as `Client/src/lib/presence.ts` sends `presence_update` only on a change.
  Each user has its own slot in that period, so 2,000 users flip at about
  3.3/s.
- **Timers keep their phase across reconnects (OC-0445).** A herd redial
  changes when a user is connected, not when they type.

### Windows

One run, six windows on the scenario clock. Each window is `[start, end)`
seconds, and a sample belongs to the window it was **received** in. The
defaults are:

| Window      | Default           | What runs                                                                                                                                                   | What it publishes                                                                                   |
| ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ramp`      | [0, 180) s        | N fresh connections, paced; the last is scheduled 10 s before `steady` opens                                                                                | `auth_ok`, dial → `ready`                                                                           |
| `steady`    | [180, 360) s      | The traffic model above                                                                                                                                     | acknowledgement, delivery, the held population                                                      |
| `burst`     | [360, 420) s      | Active users send every `K6_SCALE_BURST_SEND_MS` (default 2,000 ms: about **100 messages/s**)                                                               | acknowledgement, delivery                                                                           |
| `login`     | [420, 510) s      | `K6_SCALE_LOGINS` (default **500**) fresh password logins over `K6_SCALE_LOGIN_SPREAD_S` (default **10 s**), each from its own address, over steady traffic | time to a token including retries, give-ups, per-attempt login time, refusals                       |
| `herd`      | [510, 600) s      | Every socket drops on its own slot of a `scale_herd_spread_s` spread (default **15 s**) and redials a full `ready`                                          | time until all N are `ready`, dial → `ready` p50/p95/p99, `auth_ok`, backpressure queue disconnects |
| `ramp-down` | [600, end) and on | Draining                                                                                                                                                    | Excluded                                                                                            |

`K6_SCALE_RAMP_S`, `_STEADY_S`, `_BURST_S`, `_LOGIN_S` and `_HERD_S` move the
boundaries. Init refuses empty windows, a herd spread no shorter than its window,
and a login spread no shorter than its window.

**The herd comes last because it may not settle.** Nothing measured after it
could be attributed.

**The herd is N fresh connections carrying the token alone.** A restart resumes
every client at tier `none`, which is a full `ready` (see "Graceful shutdown
under load"). N fresh connects therefore reproduce the post-restart herd without
the drain. The client redials after 0.5–1 s of jitter, and its backoff grows
while the server is down (`Client/src/lib/ws.ts`), so a 10–30 s spread is
realistic.

A VU that is kicked, or is still dialling when its slot passes, joins the herd
with that dial. A dial that started before its slot but opened after it drops
on the next tick and redials. `herd_ready_at_ms` is measured from the herd's
start to each VU's first `ready` after its drop.

The observer polls `/api/v1/metrics` every 5 s and tags each delta with its
window:

- writer and reader waits;
- backpressure queue disconnects;
- topic sheds;
- `connected_users` (`obs_population`).

`load_measurement` in `k6-summary.json` carries:

- per window: acknowledgement, delivery, `auth_ok`, `ready` and login
  p50/p95/p99 with sample counts, sends, queue disconnects, the lowest
  population and the writer wait;
- the herd and login-burst figures;
- the planned message rates;
- `run_start_epoch_ms`, the wall-clock anchor that the CPU samples are sliced
  against.

An empty window reports `sample_count: 0` and null percentiles, never a
zero-latency success.

### Population and seeding

- **Every seeded user and every VU has its own address.** The server boots with
  `server.trusted_proxies: ["127.0.0.1/32"]`, and user n and VU n both send
  `X-Forwarded-For: 10.x.y.z`, derived from n, from registration to the last
  frame.
  - **This is a measurement setting, never a deployment recommendation.**
    `trusted_proxies` lists your real reverse-proxy hops and nothing else
    (`docs/server-configuration.md`). The setting exists here so that the
    per-IP limits see 2,000 people rather than one host.
  - On one address, the restart drill's login ramp gave up on 877 of 1,000
    VUs (run 36739426993).
- **Sessions are minted at seeding.** Registration returns a session token, and
  sessions persist in SQLite. `tokens.txt` keeps one token per user, and a VU
  starts from its token as a returning desktop client does (`Client/src/main.ts`,
  `resumeStoredSession`). The measured windows therefore contain no bcrypt
  except the login burst's. The file stays on the runner and is never uploaded.
- **Registration runs 2 × NumCPU in flight**, which is the server's bcrypt
  admission budget. A refusal from that budget is retried, and anything else
  fails the seeding.
- **N + 501 users are seeded:** the cohort, the observer and the login-burst
  VUs. k6 hands VU ids out test-wide, and VU n logs in as `loadtest<n>`.
- **The channel spread is checked at init.** At the faster of the two send
  intervals, no channel may be scheduled more than half the 100 messages/s topic
  limit (OC-0447), counted over every id in the pool. An interval below 100 ms
  (10 sends/s per user, `Server/service/message_crud.go`) is also refused.

The non-defaults this profile adds to the configuration table above:

| Key                         | Value              | Why                                                                                      |
| --------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `server.trusted_proxies`    | `["127.0.0.1/32"]` | Per-IP limits model distinct people; a measurement setting, not a deployment setting     |
| `server.max_ws_connections` | 2 × N              | As for the ceiling search: a configuration cap can never be the number the run publishes |

### Budgets and gates

**The existing budgets, applied to the window they describe:**

| Window            | Measure                                                                   | Budget         |
| ----------------- | ------------------------------------------------------------------------- | -------------- |
| `steady`          | Message send → sender acknowledgement, p95 / p99                          | 150 / 300 ms   |
| `steady`          | Message send → recipient delivery, p95 / p99                              | 200 / 400 ms   |
| `steady`, `burst` | Sends acknowledged (`ws_message_success`), not answered with an error     | > 95%          |
| `ramp`            | WebSocket open → `auth_ok` received, p95 / p99 (the connects happen here) | 200 / 500 ms   |
| `ramp`, `herd`    | WebSocket connect (`ws_connect_time`), p95                                | < 2 s          |
| `burst`           | Acknowledgement p95; delivery p95                                         | 150 ms; 200 ms |
| `login`           | REST login (`auth_time`, the successful attempt), p95 / p99               | 600 / 1,000 ms |

**New budgets for the herd and the login burst (owner decision D3,
2026-09-30).** They apply to this profile, and no existing row changes:

| Scenario    | Measure                                                          | Budget                                                   |
| ----------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| herd        | Every VU `ready` again, from the herd's start                    | ≤ 30 s (`herd_ready_at_ms` max, with `herd_readies` ≥ N) |
| herd        | Dial → `ready`, p95 (`ws_ready_time{phase:herd}`)                | ≤ 5 s                                                    |
| herd        | Backpressure queue disconnects in the window                     | 0                                                        |
| login burst | Give-ups                                                         | 0                                                        |
| login burst | First attempt → token, retries included (`login_burst_time` max) | ≤ 70 s, for all K (`login_burst_ok` ≥ K)                 |

A login-burst VU retries a refusal at most 12 times, which spans about 45 s,
and then counts one give-up and stops. It never retries in an unbounded loop
(the B6-10 defect).

**Validity gates.** A run that fails one of these did not measure what it
claims:

- `login_giveups == 0`: every cohort VU obtained a session.
- `obs_population{phase:steady}` min ≥ N: the whole population was connected
  at every poll of the steady window.
- `ws_messages_sent` and `ws_deliveries` in `steady` and in `burst` each reach
  30% of the window's planned count (planned sends × the smallest channel's
  other members, for deliveries): a window that never carried its load cannot
  pass its percentiles over a handful of samples.
- `obs_ws_conn_rejects == 0`.
- `topic_sheds_total == 0`, read from the server's own snapshot. This workflow
  gate is shared with the ceiling search.

**No run-wide latency gate.** The herd is expected to break a run-wide
percentile, so each window is gated on its own, and a herd miss can neither fail
nor hide the steady result.

A missed budget is published as measured and recorded in the findings ledger.
It is never re-run on a bigger box. The first run is expected to pass `steady`
and fail the herd, and it is published that way.

Like every profile here, it does not gate the pipeline (decision D6). It runs
by dispatch.

### The generator

- **The generator is sampled.** k6 is pinned to two CPUs, and every 5 s the
  sampler records k6's own CPU time (`k6_ticks` in `cpu.stat.log`) beside the
  container's `cpu.stat`. After the run, `windows-cpu.txt` gives the server's
  and the generator's average and peak cores per window.
- **A window whose k6 averaged 90% or more of its two CPUs is marked
  `GENERATOR-LIMITED`.** It says what the generator could offer, not what the
  server can carry, and it is published as such, never as a server result.
- **Memory is not the question.** Measured locally with k6 1.3.0, 2,501 VUs of
  this script hold about 2.0 GB resident on a 16 GB runner. The open question
  is whether two generator cores can drive 2,000 connections at this mix, and
  the first run answers it.
- **If `steady` is generator-limited, the fix is the runner, not the
  harness.** The options are a larger GitHub runner or a lighter driver (P2-T8
  used a Node driver). Choosing between them is the owner's call (decision D6).

### Reproducing it by hand

```bash
# the boot above, plus the profile's two settings
docker run -d --name owncord-sut ... \
  -e OWNCORD_SERVER_TRUSTED_PROXIES=127.0.0.1/32 \
  -e OWNCORD_SERVER_MAX_WS_CONNECTIONS=4000 \
  debian:bookworm-slim /app/chatserver

# the population: 20 text channels, then N + 501 users registered with their
# own X-Forwarded-For and their tokens kept in user order — the workflow's
# "Seed owner, channels, invite and users" step, scale branch

cd Server/scripts/k6 && mkdir -p reports
K6_PROFILE=scale K6_WS_URL=wss://127.0.0.1:8443/api/v1/ws K6_HTTP_URL=https://127.0.0.1:8443 \
K6_PEAK_VUS=2000 K6_SCALE_CHANNELS="$CHANNEL_IDS" K6_SCALE_TOKENS="$WORK/tokens.txt" \
  taskset -c 2,3 k6 run --insecure-skip-tls-verify ws-load.js
```

### Measured

**No qualifying run yet.** The first run will be dispatched on `dev` after this
section lands there. Its per-window table, its generator column and its run link
will be published here.

## Measured

Every number below comes from the **constrained** leg and from nothing else.

> **Provenance note (2026-09-25, superseded by the RE-05 note below).** These qualifying runs were dispatched from
> measurement branches, not from `dev` or `main`: the `commit:` line in each
> block is that branch's head, which is **not** an ancestor of `dev`/`main` and
> so does not resolve in a checkout of either. The **workflow run id** in each
> block is the resolvable handle — it names the branch, the commit and the run
> logs on GitHub. The B10 release-candidate load run on a `dev`/`main` ancestor
> (the comparison B10 item 8 asks for) is **pending at R6**; until it exists,
> these branch runs are the only qualifying evidence, and they are published as
> that. No unresolvable short SHA is presented as a release-revision citation.
>
> **Ceiling-search and restart are now `dev` runs (2026-09-28).** The
> ceiling-search block below was the first qualifying run on a `dev` ancestor —
> commit `8349ed2e`, dispatched from `dev` itself rather than a measurement
> branch — so its `commit:` line resolves in a checkout of `dev`. The restart
> block was re-made the same day on a later `dev` commit `8e9e8443` (run 36372371602) and also resolves in a checkout of `dev`. The capacity and
> operational blocks were still measurement-branch runs at this point (superseded
> by the RE-05 note below). The workflow run id stays
> the resolvable handle for every block.
>
> **RE-05 is met: capacity and operational are now `dev` runs (2026-09-28).**
> The capacity block below was re-made on the `dev` tip `a989b8a8` (run 36383236783) and the operational pair on the same commit (run 36383239328),
> after the k6 harness and server fixes the older blocks predate. Both runs'
> `commit:` lines resolve in a checkout of `dev`, which is exactly the B10
> item-8 comparison RE-05 owed. Every block now cites a resolvable
> `dev` revision; no measurement-branch run remains as a qualifying figure,
> and the operational re-measurement resolves OC-0481 (see that section). Once
> this workflow reaches `main` (the next release), its weekly `schedule:` keeps
> a fresh run of `main`'s commit in the Actions history without anyone
> dispatching one.

### The profile on `dev` (RE-05, 2026-09-28)

This is the B10 item-8 comparison RE-05 asked for: the same constrained profile
re-measured on a `dev` ancestor with the corrected k6 harness (OC-0445) and the
server changes the 2026-09-12 block predates. It is the current reference figure
for the profile; the historical block below it is kept as provenance.

```
commit:          a989b8a8d803cc601dc30f2d17a64da5585b05e3  (on dev; not yet on main)
date (UTC):      2026-09-28
workflow run:    36383236783  (.github/workflows/load-baseline.yml, profile=capacity)
job:             108803153693  (capacity, constrained)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.7
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

| Profile target                       | Achieved                                                   | Met? |
| ------------------------------------ | ---------------------------------------------------------- | ---- |
| 250 registered users                 | 250 seeded, all registrations accepted                     | Yes  |
| 100 simultaneous connections (180 s) | 100 authenticated and ready, `vus_max` 100 for the sustain | Yes  |
| 25 concurrent voice participants     | 625/625 tracks at 0% packet loss, 0 errors                 | Yes  |

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 264 ms | 271 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 17 ms  | 23 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 35 ms  | 77 ms  | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 36 ms  | 82 ms  | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 4 ms   | 5 ms   | 250 ms / 500 ms    | Yes  |

Every budget is met with room. 12,139 messages sent, 12,131 acknowledged,
**1,139,557 cross-connection deliveries**, 25 voice tokens, **0 WebSocket
errors**, 100/100 sockets authenticated and ready. Server CPU inside the cgroup
averaged 0.28 of its 2 CPUs, peaked at 0.91, and `nr_throttled` did not move:
the two CPUs were not the constraint. The ceiling leg of the same run (the whole
4-CPU runner) measured recipient delivery p95 / p99 34 / 55 ms against the
constrained leg's 36 / 82 ms, so the reference cgroup is still not the limiting
factor at this profile.

### The profile as first published (2026-09-12, historical)

The block below is the run the tightened budgets were originally set from. Its
commit is a measurement branch, so only its run id resolves; it is kept for the
budget-tightening provenance and is superseded as the current figure by the
`dev` block above.

```
commit:          593c764b2d749a9415741211c01216d9d5da2153  (measurement branch feat/b6-9-published-capacity-profile; not on dev/main)
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

The operational blocks below were re-made on 2026-09-23 from commit `4b2ea56b`
(run 35856013841, on branch `fm/oc-0445-fable`), after OC-0445 found that the
2026-09-16 operational figures had measured a phase-locked load generator rather
than the server — the `self_signed` block says how. **They were re-made again on
the `dev` tip `a989b8a8` (run 36383239328) on 2026-09-28**, so every operational
figure now resolves in a checkout of `dev`; the two `dev` blocks below are the
current figures and the 2026-09-23 pair is kept as the intermediate provenance.
The ceiling-search and restart blocks were re-made on 2026-09-28, both dispatched
from `dev` itself — ceiling-search from commit `8349ed2e` (run 36360932108) and
restart from commit `8e9e8443` (run 36372371602) — so their `commit:` lines
resolve in a checkout of `dev`. The restart block replaces the **superseded**
2026-09-16 run from commit `e57335c7`, which predates the OC-0446 harness
correction and the OC-0484 fix and is kept below as historical evidence only.
Every other historical block's SHA is a measurement branch, not an ancestor of
`dev`/`main`, and there the run id is the only resolvable handle. Each block is
filled from its own **constrained** leg and from nothing else, and the `tls off`
block publishes as a delta against the `self_signed` one rather than on its own.

The budget rows missed under the 2026-09-16 restart drill are published as
missed and are findings-ledger entries (OC-0446, OC-0447); neither was re-run on
a bigger machine and no budget was loosened. OC-0447's ceiling-search correction
was re-measured on 2026-09-28 (run 36360932108) and passes its zero-shedding
gate; OC-0446's restart correction was re-measured the same day (run 36372371602)
after OC-0484's full-resync subscription gap was fixed by
[#1940](https://github.com/J3vb/OwnCord/pull/1940), and that run passes every
validity gate. The operational profile's two misses were OC-0445, and the blocks
below are its re-measurement, with the harness corrected and the server
unchanged.

**OC-0481 is resolved by the `dev` re-measurement.** That finding recorded a
single tls-off upload-phase acknowledgement p99 of 301 ms against the 300 ms
budget on a busy shared runner (2026-09-23). The same profile on `dev` measured
the upload-phase p99 at **71 ms** on the tls-off leg and 65 ms on the
`self_signed` leg, and the run-wide p99 at 64 ms on both — the earlier 301 ms
was a busy-runner tail, and no budget was loosened to accommodate it. The full
per-phase series is in each `dev` block below.

#### Operational on `dev`, `tls.mode: self_signed` (2026-09-28)

```
commit:          a989b8a8d803cc601dc30f2d17a64da5585b05e3  (on dev; not yet on main)
date (UTC):      2026-09-28
workflow run:    36383239328  (.github/workflows/load-baseline.yml, profile=operational)
job:             108803160564  (operational, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.7
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 331 ms | 348 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 15 ms  | 20 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 40 ms  | 64 ms  | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 42 ms  | 68 ms  | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 33 ms  | 59 ms  | 250 ms / 500 ms    | Yes  |

Per phase, send → acknowledgement p95 / p99: ramp 27 / 44 ms, sustain
43 / 73 ms, upload 41 / 65 ms, storm window 39 / 61 ms; delivery 30 / 47,
44 / 76, 42 / 68 and 40 / 66 ms. The spread voice churn (PERF-02 / OC-0480,
the default since) keeps the voice-join p95 at 33 ms instead of the old aligned
25-way rejoin's 157 ms. 100 of 100 storm sockets resumed from the in-memory
buffer (`ws_replay_source{tier:buffer}` 100, `db` 0, `none` 0), `ws_replay_gap`
max 0, all three `backpressure_*` deltas 0, 300 upload admits / 995 quota
refuses / 300 downloads, 0 `STORAGE_LOW_DISK`, 0 oversize, 0 WebSocket errors.
12,089 sends, 12,074 acknowledged, 1,134,078 deliveries. Server CPU averaged
0.23 of its 2 CPUs, peaked at 1.22, `nr_throttled` did not move.

#### Operational on `dev`, `tls.mode: off` (2026-09-28)

```
commit:          a989b8a8d803cc601dc30f2d17a64da5585b05e3  (on dev; not yet on main)
date (UTC):      2026-09-28
workflow run:    36383239328  (.github/workflows/load-baseline.yml, profile=operational)
job:             108803160609  (operational, constrained, tls off)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.7
lk:              2.18.6
load generators: k6 and lk, pinned to CPUs 2-3 with taskset
```

Same shape as the block above; the delta against it follows the table:

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 302 ms | 308 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 22 ms  | 31 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 40 ms  | 64 ms  | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 42 ms  | 67 ms  | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 26 ms  | 41 ms  | 250 ms / 500 ms    | Yes  |

Per phase, send → acknowledgement p95 / p99: ramp 28 / 41 ms, sustain
39 / 54 ms, **upload 43 / 71 ms**, storm 38 / 53 ms; delivery 32 / 49,
40 / 56, 44 / 74 and 40 / 56 ms. The upload-phase p99 that OC-0481 recorded at
301 ms is 71 ms here. 100 of 100 storm resumes from the buffer, `ws_replay_gap`
max 0, 0 backpressure deltas, 300 admits / 995 quota refuses / 300 downloads, 0
`STORAGE_LOW_DISK`, 0 oversize, 0 WebSocket errors, 12,085 sends, 12,073
acknowledged, 1,133,881 deliveries. Server CPU averaged 0.21 of 2, peaked 1.16,
`nr_throttled` did not move. TLS off is cheaper on login here (302 / 308 ms
against 331 / 348 ms); the acknowledgement and delivery rows are within 1 ms
of the `self_signed` leg, and voice join and `auth_ok` differ by 7–18 ms in
opposite directions, which is the point of publishing the pair as a delta
rather than an absolute.

TLS delta for this `dev` pair, `self_signed − off` (a positive number means the
TLS leg was slower). This is the current delta; the 2026-09-23 table further
down is historical.

| Row                           | self_signed p95 / p99 | off p95 / p99 | Delta p95 / p99  |
| ----------------------------- | --------------------- | ------------- | ---------------- |
| REST login                    | 331 / 348 ms          | 302 / 308 ms  | **+29 / +40 ms** |
| WebSocket open → `auth_ok`    | 15 / 20 ms            | 22 / 31 ms    | **−7 / −11 ms**  |
| Send → sender acknowledgement | 40 / 64 ms            | 40 / 64 ms    | **0 / 0 ms**     |
| Send → recipient delivery     | 42 / 68 ms            | 42 / 67 ms    | **0 / +1 ms**    |
| Voice join (OwnCord half)     | 33 / 59 ms            | 26 / 41 ms    | **+7 / +18 ms**  |

The two legs are still two matrix jobs on two runner VMs, so the reading is
unchanged: the TLS cost of this profile is not distinguishable from runner
noise at one run per mode.

#### Operational, `tls.mode: self_signed` (2026-09-23, historical)

```
commit:          4b2ea56bb9777c6a435b8eb6423d1293a7276230  (measurement branch fm/oc-0445-fable; not on dev/main)
date (UTC):      2026-09-23
workflow run:    35856013841  (.github/workflows/load-baseline.yml, profile=operational)
job:             107164548694  (operational, constrained, tls self_signed)
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

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 239 ms | 335 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 12 ms  | 19 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 45 ms  | 234 ms | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 48 ms  | 231 ms | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 157 ms | 204 ms | 250 ms / 500 ms    | Yes  |

Every threshold was met; this is the first operational run to conclude
`success`. Per phase (the `phase` tag `ws_broadcast_latency_ms` and
`ws_delivery_latency_ms` carry since OC-0445), send → acknowledgement p95 / p99
was 68 / 299 ms in the ramp, 46 / 224 ms in the sustain, 44 / 186 ms under
uploads and 37 / 282 ms in the storm window; delivery 93 / 355, 48 / 219,
46 / 184 and 40 / 284 ms. A second run the same hour (35856019988) measured
41 / 80 ms and 43 / 81 ms on this leg; two `dev` runs interleaved with the pair
(35856016690, 35856022553) measured 287 / 427 and 330 / 467 ms for
acknowledgement, with the same server.

**The 2026-09-16 figures (run 35113946945: 228 / 348 ms and 250 / 361 ms,
published as OC-0445) measured the load generator, not the server.** Per-10 s
buckets on an unchanged server (run 35852682786) put send → acknowledgement
p95 at 3–69 ms in every bucket up to the storm and at 506–582 ms in every
bucket after it on the `self_signed` leg, and at 2–89 ms and 584–746 ms on the
TLS-off leg. The storm closed every socket at one scenario instant, and each
new socket's send timer was a plain `setInterval` from that instant, so from
t=180 s all 100 senders sent in the same 50 ms slot
every 2 s. A hundred simultaneous sends queue behind the single SQLite writer
at about 6 ms a hop — the checkout itself is held 0.4 ms; the hop is the next
sender waiting out the previous send's 100-recipient fan-out on two vCPUs —
which is 600 ms for the last in line. The server did the same work at the same
rate before and after the storm; only the arrival pattern changed. `ws-load.js`
now keeps each connection's send, typing and presence phase across reconnects
(`phasedInterval`): a reconnect changes when a user is connected, not when they
type. OC-0445 records the diagnosis and OC-0454 the per-hop cost of a burst that
is genuinely simultaneous.

`K6_SEND_PHASE=aligned` reproduces that burst on purpose: every VU sends on the
same epoch-aligned instant. The default, `spread`, is unchanged. A local
re-profile (OC-0454, 2026-09-23; 4-CPU sandbox, server and k6 on two CPUs each)
confirmed the hop is not the writer checkout. The message transaction holds
the writer ~0.3 ms. The rest is the burst's 10,000 fan-out frames, each its own
TLS record and write syscall, saturating two CPUs for ~100 ms. About half of
the acknowledgement time k6 reports in a burst is the generator itself: a VU
parses the other senders' frames before it reaches its own `chat_send_ok`.
Since then a send takes the writer once, not twice: the author's read-state
advance runs inside the message transaction. That halved writer waits and
took ~7% off the aligned-burst p95 (318 → 297 ms locally). Spread sends are
unchanged at 18 ms. These local figures are not reference-runner figures.

**OC-0454 is declined by owner decision D-09 (Q14, 2026-09-26) as an accepted
low, and this document does not budget the aligned burst.** The shape is a
property of per-frame fan-out cost — one TLS record and one write syscall per
frame per recipient — not a correctness defect, and a real population rarely
presses Enter in unison. Reopen on a user-visible burst scenario where the
acknowledgement tail costs someone; the fix then is a connection wrapper that
coalesces queued frames into one flush.

**Measurement-only rows — no budget is published for any of them, and this
document does not invent one.**

| Figure                                | p95    | p99    | Count               |
| ------------------------------------- | ------ | ------ | ------------------- |
| Storm resume, open → `auth_ok`        | 72 ms  | 77 ms  | 100                 |
| `voice_state` reaching another socket | 175 ms | 214 ms | 58,396              |
| Upload admitted (201)                 | 119 ms | 274 ms | 300                 |
| Upload refused by quota (507)         | 9 ms   | 113 ms | 995                 |
| Authenticated download                | 10 ms  | 19 ms  | 300 (1 in 4 ranged) |

Storm: 100 of 100 sockets closed and resumed, **every one served from the
in-memory buffer** (`ws_replay_source{tier:buffer}` 100, `db` 0, `none` 0),
`ws_replay_gap` max 0, and the storm phase's `ws_conn_rejects` and all three
`backpressure_*` deltas 0. Uploads: 300 admits, 995 quota refuses, 0
`STORAGE_LOW_DISK`, 0 oversize, 75 MB of storage charged. 0 WebSocket errors,
0 login give-ups, 1,133,495 cross-connection deliveries from 12,078 sends.

Database waits, **per phase, as deltas** — the figure this section exists for:

| Phase   | Writer waits | Writer seconds | Reader waits | Reader seconds |
| ------- | ------------ | -------------- | ------------ | -------------- |
| ramp    | 940          | 10.3 s         | 7,901        | 3.1 s          |
| sustain | 3,428        | 23.5 s         | 29,880       | 9.9 s          |
| storm   | 1,327        | 9.6 s          | 13,667       | 5.9 s          |
| upload  | 4,394        | 47.5 s         | 43,324       | 14.2 s         |
| run     | 10,666       | 98.6 s         | 102,413      | 35.2 s         |

With the senders spread out again, the writer's wait per waiting checkout is
7–11 ms in every phase (6.9 ms in the sustain, 7.2 ms in the storm window,
10.8 ms under uploads) instead of the 2026-09-16 run's 12 s inside a 30 s storm
window. The upload phase still carries the most writer wait because it is half
the run, not because it queues differently.

Server CPU inside the cgroup, from `cpu.stat.log` (5 s samples of
`usage_usec`): 0.26 CPUs of 2 on average over the run, 0.83 at the peak, in the
uploads cohort's login ramp. **The two CPUs were not the constraint on this
run.**

#### Operational, `tls.mode: off` (2026-09-23, historical)

```
commit:          4b2ea56bb9777c6a435b8eb6423d1293a7276230  (measurement branch fm/oc-0445-fable; not on dev/main)
date (UTC):      2026-09-23
workflow run:    35856013841  (.github/workflows/load-baseline.yml, profile=operational)
job:             107164548275  (operational, constrained, tls off)
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
`ws_replay_gap` max 0, 0 WebSocket errors, 0 login give-ups, 1,133,899
deliveries from 12,084 sends, 300 admits / 993 quota refuses / 300 downloads,
0 `STORAGE_LOW_DISK`, 0 oversize. Server CPU 0.31 of 2 on average, 0.98 at the
peak. Every threshold was met:

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 307 ms | 544 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 5 ms   | 11 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 85 ms  | 266 ms | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 93 ms  | 270 ms | 200 ms / 400 ms    | Yes  |
| Voice join (OwnCord half)     | 130 ms | 176 ms | 250 ms / 500 ms    | Yes  |

Per phase, send → acknowledgement p95 / p99: ramp 35 / 151 ms, sustain
51 / 176 ms, upload 110 / 301 ms, storm window 102 / 271 ms. The second run
(35856019988) measured 96 / 267 ms and 98 / 266 ms on this leg and missed the
voice-join p95 (335 ms against 250) — a row the interleaved `dev` runs missed
too (437 ms on `self_signed` in 35856022553). Those runs were taken under the
old aligned churn, so that voice-join row measured a 25-way simultaneous rejoin
rather than one join (PERF-02 / OC-0480): it is a harness shape, not a
single-join cost. The default is now `spread`; a `spread` operational run is
what republishes this table. The `dev` runs measured 373 / 452 and
276 / 352 ms for acknowledgement on this leg.

Per-phase database waits on this leg, for comparison with the table above:

| Phase   | Writer waits | Writer seconds | Reader waits | Reader seconds |
| ------- | ------------ | -------------- | ------------ | -------------- |
| ramp    | 694          | 7.6 s          | 8,712        | 3.3 s          |
| sustain | 1,809        | 21.3 s         | 29,593       | 9.8 s          |
| storm   | 1,334        | 20.3 s         | 13,184       | 6.6 s          |
| upload  | 3,766        | 75.2 s         | 45,414       | 15.5 s         |
| run     | 8,257        | 137.0 s        | 100,112      | 35.8 s         |

#### TLS delta, `self_signed − off` (2026-09-23 pair, historical)

The delta between the two 2026-09-23 blocks above, kept as provenance; the
current delta is the `dev` pair's, published with the `dev` `tls.mode: off`
block. A positive number means the TLS leg was slower.

| Row                                 | self_signed p95 / p99 | off p95 / p99 | Delta p95 / p99   |
| ----------------------------------- | --------------------- | ------------- | ----------------- |
| REST login                          | 239 / 335 ms          | 307 / 544 ms  | **−68 / −209 ms** |
| WebSocket open → `auth_ok`          | 12 / 19 ms            | 5 / 11 ms     | **+7 / +8 ms**    |
| Send → sender acknowledgement       | 45 / 234 ms           | 85 / 266 ms   | **−40 / −32 ms**  |
| Send → recipient delivery           | 48 / 231 ms           | 93 / 270 ms   | **−45 / −39 ms**  |
| Voice join (OwnCord half)           | 157 / 204 ms          | 130 / 176 ms  | **+27 / +28 ms**  |
| Storm resume                        | 72 / 77 ms            | 156 / 162 ms  | −84 / −85 ms      |
| `voice_state` cross-socket delivery | 175 / 214 ms          | 155 / 174 ms  | +20 / +40 ms      |
| Upload admitted                     | 119 / 274 ms          | 128 / 184 ms  | −9 / +90 ms       |
| Upload refused by quota             | 9 / 113 ms            | 102 / 203 ms  | −93 / −90 ms      |
| Authenticated download              | 10 / 19 ms            | 12 / 22 ms    | −2 / −3 ms        |
| Writer wait, run total              | 98.6 s                | 137.0 s       | −38.4 s           |

**Most rows still come out negative: the plaintext leg measured slower on the
two message paths, on resume and on refusals.** That is published as it was
measured, and no TLS cost is claimed from this pair for the same reason as
before: the two legs are two matrix jobs on two different runner VMs, so every
row carries a full run's worth of runner noise, and the second pair of the
same hour (35856019988: 41 / 80 ms against 96 / 267 ms for acknowledgement)
moved the message rows by more than this delta. The honest reading remains
**"the TLS cost of this profile is not distinguishable from runner noise at
one run per mode"**. Nothing here recommends running with TLS off; the default
remains `self_signed`.

#### Restart under load

**Measured on `dev` (2026-09-28).** The corrected drill (OC-0446) was
re-dispatched on `dev` after the full-resync subscription gap (**OC-0484**) was
fixed by [#1940](https://github.com/J3vb/OwnCord/pull/1940), and this run passes
every validity gate — including `ws_replay_gap max==0`, which both pre-fix
`dev` dispatches failed (max 9 and 13), and `sends_lost count==0`. The profile
is published below. A same-day intermediate re-dispatch (run 36371370515,
commit `8e9e8443`) failed only on `sends_lost=3` (248 drain sends: 244 acked,
4 unanswered, 3 absent from history) with every other gate passing, including
`ws_replay_gap max==0`; recorded as an observed stop-boundary flake, not a
result. OC-0484 is resolved by #1940, and its ledger entry records both invalid
`dev` runs and this flake.

```
commit:          8e9e8443f423f30dbb603f376edf052c0bab180b  (on dev; not yet on main)
date (UTC):      2026-09-28
workflow run:    36372371602  (.github/workflows/load-baseline.yml, profile=restart)
job:             108771187580  (restart, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.7
lk:              2.18.6
load generators: k6, pinned to CPUs 2-3 with taskset (no voice leg on this profile)
```

The stop is scheduled at T+135 s — 60 s of ramp, then a 75 s `pre-restart`
window at full fan-out, so both steady windows are the same length (OC-0446).

| Drill figure                       | Measured                                    | Gate                    | Met? |
| ---------------------------------- | ------------------------------------------- | ----------------------- | ---- |
| Drain wall clock (`docker stop`)   | **6,122 ms**                                | inside 30 s             | Yes  |
| Server exit code                   | **0**                                       | 0                       | Yes  |
| `server_restart` frames received   | **100 of 100**                              | 100                     | Yes  |
| Lead, frame arrival → socket close | p95 5,004 ms, max 5,005 ms                  | ≥ `delay_seconds` (5 s) | Yes  |
| Sends attempted during the drain   | **250: 250 acked, 0 errored, 0 unanswered** | —                       | —    |
| Sends lost across the restart      | **0**                                       | 0                       | Yes  |
| Replay gap across the restart      | max 0                                       | 0                       | Yes  |
| Resume tier after the second boot  | 100 of 100 `none`                           | `none` by design        | Yes  |
| Resume time after the second boot  | p95 71 ms, p99 81 ms, max 86 ms             | no budget               | —    |

The budget rows, and the two sides of the stop:

| Path                          | p95    | p99    | Budget (p95 / p99) | Met? |
| ----------------------------- | ------ | ------ | ------------------ | ---- |
| REST login                    | 216 ms | 231 ms | 600 ms / 1 s       | Yes  |
| WebSocket open → `auth_ok`    | 6 ms   | 10 ms  | 200 ms / 500 ms    | Yes  |
| Send → sender acknowledgement | 20 ms  | 35 ms  | 150 ms / 300 ms    | Yes  |
| Send → recipient delivery     | 20 ms  | 36 ms  | 200 ms / 400 ms    | Yes  |

| Side           | Recipient delivery p95 / p99 | Sender ack p95 / p99 | Deliveries |
| -------------- | ---------------------------- | -------------------- | ---------- |
| `pre-restart`  | **20 / 31 ms**               | 21 / 32 ms           | 371,143    |
| `post-restart` | **21 / 39 ms**               | 20 / 37 ms           | 370,990    |

Every threshold was met. The equal-length windows now measure within a
millisecond of each other — delivery p95 20 vs 21 ms, ack p95 21 vs 20 ms over
371,143 and 370,990 deliveries — so the ~10× imbalance OC-0446 described is
gone and the stop costs no steady-state latency. The `recovery` window (stop,
drain, outage, reconnects) measured delivery p95 22 ms / p99 49 ms over 143,167
samples and is not a budget row.

**No resource in the reference box limits this profile.** Server CPU inside the
cgroup (`cpu.stat.log`, 5 s samples of `usage_usec`) averaged **0.27 of 2 CPUs**
over the first boot and **0.16 of 2** over the second, peaking at **0.50 of 2**;
`nr_throttled` stayed **0** across the whole run. The single SQLite writer —
whose queue is what the ceiling search names as the limiter above 400
connections — queued 1,837 waits for **3.7 s** total, split across the phases
(533 waits / 0.8 s pre-restart, 280 / 1.4 s in recovery, 612 / 0.8 s
post-restart), and the reader pool never queued outside recovery (3,254 waits /
13.8 s, all in the stop window). With 100 connections and full fan-out on both
sides of the stop, CPU sat at a quarter of its two-CPU budget and the writer
queue stayed sub-second per steady phase, so the profile is met with room — the
same conclusion the steady block reached, against the same cgroup.

The block below is the **superseded 2026-09-16 measurement**, kept as historical
evidence for OC-0446 and not a current result. It also predates the OC-0484 fix
below, and its `post-restart` window is the pre-correction one:

```
commit:          e57335c789e19b08b3302a68de1598353cf1578d  (measurement branch feat/b6-10-operational-measurements; not on dev/main)
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
no gap. The drain finished in a fifth of the 30 s drill gate under 100 connections
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
  `recovery`, `post-restart` and `ramp-down`. The ramp and the ramp-down are
  excluded from both steady windows — the second because `TOTAL_S` runs 20 s
  past `SUSTAIN_S`, and a still-draining population is no more comparable to a
  fixed one than a still-filling one; the outage and its reconnects are
  _published as their own phase_ rather than discarded, because that cost is
  exactly what burying it in a warm-up exclusion would erase. A resumed
  connection is no longer evidence of anything — it is true for every sample
  after the stop, including those taken while the rest of the cohort was still
  coming back. The observer's samples carry these same phase names, so its
  writer-wait and reader-wait deltas split at the stop too.
- **The observer VU runs under `restart`**, so the per-phase writer-wait
  deltas exist on both sides of the stop, and a floor on
  `ws_deliveries{phase:pre-restart}` / `{phase:post-restart}` fails the drill
  when a window did not carry the workload — a comparison between two windows
  is worthless if either was empty.

The corrected drill was dispatched on 2026-09-28. Its first `dev` dispatches
failed the drill's own `ws_replay_gap max==0` validity gate (max 9 on
`8349ed2e`, max 13 on `a04f8edd`), so they published no latency result. The gap
was a real property of the post-restart resume, not a harness artifact
(**OC-0484**): `active_channel_id` was honoured only inside `handleReconnect`,
and only after its final `mustFullResync` check passed (`Server/ws/replay.go`).
A restart renumbers the sequence space, so every post-restart resume is forced
onto the full-resync path _before_ that check, and `handleFreshConnect` then
registered the socket with `channelID` still 0 — it subscribed no `ChannelTopic`.
Channel frames broadcast between `auth_ok` and the client's post-`auth_ok`
`channel_focus` reached nobody on that socket, and the client tracks only
`max(seq)`, so the hole was silent and permanent until the user re-mounted the
channel. [#1940](https://github.com/J3vb/OwnCord/pull/1940) honours
`active_channel_id` on the full-ready path too; the `dev` run at the top of this
section passes the gate at `max 0`. The 34/51 ms and 393/452 ms above remain
what the 2026-09-16 run measured, and remain not an equal-load comparison.

#### Ceiling search

**The re-measured multi-channel search is published here.** This is the run
PERF-03 exists for: the corrected harness (OC-0447), dispatched from `dev`
itself, with the zero-shedding gate passing.

```
commit:          8349ed2ecb84cafd84afaaf94cac79831b417181  (on dev; not yet on main)
date (UTC):      2026-09-28
workflow run:    36360932108  (.github/workflows/load-baseline.yml, profile=ceiling-search)
job:             108737854635  (ceiling-search, constrained, tls self_signed)
runner:          ubuntu-latest, 4 CPU / 16 GB host
cgroup as seen from inside the container (limits.txt):
                 nproc 2
                 cpu.max 200000 100000      (= 2 CPUs)
                 cpuset.cpus.effective 0-1
                 memory.max 4294967296      (= 4 GiB)
                 memory.swap.max 0          (= no swap)
livekit-server:  1.13.7
lk:              2.18.6
load generators: k6, pinned to CPUs 2-3 with taskset (no voice leg on this profile)
```

501 users seeded (one per probe slot for the 500 step), `obs_ws_conn_rejects`
**0** — so no figure below is a configuration cap — `login_giveups` 0 (one login
was refused by the bcrypt admission budget and retried — `auth_admission_refused`
1), and `topic_sheds_total` **0** with no `topic rate limit exceeded` line: every
step was limited by the server, not by the topic limiter or a config default.
The cohort is spread over 11 text channels (`CEILING_CHANNELS=11`) at the 2 s
send interval, so the total offer is `N × 1000 / 2000` messages/s with no
channel above its share of the 100/s limiter. Every requested population was
held: `obs_connected_users` was exactly 100 / 200 / 300 / 400 / 500 at each
step's hold, and each step's `ws_connections` arrivals were 100 (its own ramp).
The observed total send-attempt rate matched the planned rate through step 400
(50.0, 100.0, 150.0, 199.9/s against 50/100/150/200 planned); it read high at
step 500 (281.7/s observed against 250 planned), which is the generator bunching
frames as the server's ack path slows — generator-side evidence, not admission.

| Step | Held (`obs_connected_users`) | Delivery p95 / p99    | Sender ack p95 / p99  | Login p95 / p99    | `auth_ok` p95 | Writer wait (step total; per wait) | Server CPU (avg / peak of 2) | Host loadavg (avg / peak) |
| ---- | ---------------------------- | --------------------- | --------------------- | ------------------ | ------------- | ---------------------------------- | ---------------------------- | ------------------------- |
| 100  | 100                          | **6 / 8 ms**          | **5 / 8 ms**          | 269 / 272 ms       | 3 ms          | 1.0 s; 0.8 ms                      | 0.12 / 0.26                  | 0.69 / 1.05               |
| 200  | 200                          | **15 / 22 ms**        | **14 / 21 ms**        | 275 / 283 ms       | 8 ms          | 4.8 s; 1.6 ms                      | 0.25 / 0.26                  | 2.19 / 2.68               |
| 300  | 300                          | **30 / 60 ms**        | **30 / 59 ms**        | **352 / 361 ms**   | 7 ms          | 7.4 s; 2.0 ms                      | 0.46 / 0.47                  | 2.23 / 2.69               |
| 400  | 400                          | 97 / 286 ms           | 99 / 287 ms           | **737 / 1,362 ms** | 83 ms         | 80.7 s; 14.9 ms                    | 0.72 / 0.75                  | 3.09 / 3.45               |
| 500  | 500                          | **7,331 / 11,618 ms** | **7,253 / 11,533 ms** | 2,573 / 2,866 ms   | 818 ms        | 1,466.2 s; 78.9 ms                 | 1.11 / 1.50                  | 3.58 / 3.72               |

(Budgets, from the table at the top of this document: REST login 600 ms / 1 s;
WebSocket open → `auth_ok` 200 / 500 ms; send → sender acknowledgement
150 / 300 ms; send → recipient delivery 200 / 400 ms.)

**The last step at which every budget held is 300.** Step 400 breaks the REST
login budget (p95 737 ms against 600 ms) while the two message paths still hold
(delivery 97 ms, ack 99 ms); step 500 breaks recipient delivery and sender
acknowledgement together (p95 7.3 s against 200 ms and 150 ms), along with
`auth_ok` (p95 818 ms against 200 ms) and the still-broken login (p95 2,573 ms).

**Login breaks first, at 400, under near-saturated ramp CPU with the writer
also queueing; the message paths break at 500 on the single SQLite writer, with
the CPU at its full budget.** Every step held its population and the search
never walked into the topic limiter, so the numbers are the server's own.

The table's CPU column covers each step's 60 s hold. `ws-load.js` times a VU's
REST login when it starts, so each step's 100 logins fall in its 30 s ramp, and
`cpu.stat.log` (5 s samples of `usage_usec`) shows the ramps running much hotter
than the holds.

- **Login breaks at 400 with the ramp CPU near saturation.** The step-400 ramp
  averages **1.49 of 2** and peaks at **1.70**. That is the window in which its
  logins are timed (p95 737 ms against 600 ms). The hold that follows sits at
  0.72, so the CPU pressure is the login ramp itself, whose bcrypt checks are
  CPU work. The writer also queues more at this step (per wait 2.0 ms at 300,
  14.9 ms at 400), and the login's session persist shares it. This run does not
  separate the two, so the login break is attributed to the ramp CPU and the
  writer together, not to the writer alone. Both message paths still hold at
  400 (delivery 97 ms, ack 99 ms).
- **The message paths break at 500 on the SQLite writer.** The per-waiting
  checkout cost is 0.8 ms at 100, 1.6 ms at 200, 2.0 ms at 300, 14.9 ms at 400,
  and **78.9 ms at 500**. The step-500 window alone records 18,587 writer waits
  totalling **1,466 s** of waiting, against 3,683 waits / 7.4 s at the last step
  that met every budget. Delivery and ack p95 reach 7.3 s. The ramp CPU at 500
  averages **1.85 of 2** and peaks at **2.02**, the full budget, and
  `nr_throttled` goes from 0 to **11** in that ramp. So the writer queue that
  breaks the message paths forms on a CPU that is also saturated.
- **The reader pool never queued** — 1,565 reader waits / 5.4 s over the entire
  run — so the contention is the writer's, not the read side.
- **Dispatch lag is not the limiter.** `ws_dispatch_lag_ms` over the run was p95
  2 ms / p99 10 ms / max 160 ms, `ws_broadcast_ms` the same shape, and
  `hub_seqmu_max_hold_ms` 168.75 ms — the hub's own fan-out serialization stayed
  in the sub-200 ms range the whole run, consistent with OC-0454's finding that
  per-frame fan-out cost does not bind at these counts.
- **Both failing steps are generator-_contended_ on the host.** At step 400 the
  host 4-CPU load average was 3.09 (peak 3.45) with k6 pinned to two CPUs; at
  step 500 it reached 3.72. The server-side signals above (ramp CPU at 400, the
  writer queue at 500) move with the failing budgets, so the steps are not
  marked generator-limited.

The last all-budget step is **300 connections** on the 2-vCPU reference box.
Beyond it, login is the first budget to fail (at 400, near-saturated ramp CPU
with the writer also queueing) and the message paths follow at 500 through the
writer queue — the operational
section's property that the SQLite writer is one checkout at a time, so a
per-message hop that is sub-millisecond idle becomes a queue once enough senders
share it. This is _not_ the fan-out CPU limit: dispatch lag and the `seqMu` hold
stayed sub-200 ms throughout.

The per-step figures are informational — nothing is gated on the search, and no
new budget is set by it. The block below is the **superseded 2026-09-16
single-channel run**, kept as historical evidence for OC-0447 and not a current
result:

```
commit:          e57335c789e19b08b3302a68de1598353cf1578d  (measurement branch feat/b6-10-operational-measurements; not on dev/main)
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
exactly 100 messages/s into a single channel — and
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

**The harness has since been corrected (OC-0447).** The search no longer walks
into the limiter:

- **The cohort is spread across channels with enforced headroom.** The earlier
  correction seeded `ceil(ceiling_max / 150)` channels but allowed missing or
  insufficient lists and did not bound aligned sends. The completed correction
  uses the sliding-window calculation above: 11 channels at max 500 and a 2 s
  send interval, no more than 46 VU slots per channel (23 messages/s scheduled
  mean, at most 46 scheduled sends in one second). The total remains 250
  messages/s at step 500. The summary publishes the planned rate and observed
  send-attempt rate for every channel and hold. Sender and focus use the same id.
- **Shedding is now a hard failure, not a footnote.** A post-run step reads
  `topic_sheds_total` from the server's `/api/v1/metrics` snapshot on the
  ceiling leg (it originally grepped the server log for
  `topic rate limit exceeded`) and fails the run if it is non-zero or missing,
  with the same posture as the run's own
  `obs_ws_conn_rejects == 0`: the search is shaped to stay under the limiter,
  so a shed frame means the shaping is wrong and the steps above the first shed
  are **inconclusive rather than a ceiling**. `CEILING_CHANNELS` is printed in
  the failure so the fix is one input away.

That correction was re-measured on 2026-09-28 (the multi-channel block at the
top of this section): the corrected search holds every requested population up
to 500, passes the zero-shedding gate, and locates the last all-budget step at
**300**. Login breaks first at 400, with near-saturated ramp CPU and the writer
also queueing, and the message paths break at 500 on the **SQLite writer**. The 2026-09-16 table above remains historical single-channel evidence and is
**not** comparable to the multi-channel shape — the new spread changes recipient
fan-out at every step, including 100.
