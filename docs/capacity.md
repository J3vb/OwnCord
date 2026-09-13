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
  real ceiling is; finding that is B6-10's job, not this document's.
- **The budgets were tightened, not met-and-left.** Every initial budget was
  between 3× and 1000× the measured figure, which would have let a large
  regression land without failing anything.
- **The `--layout` trap was not hypothetical.** The first 25×25 room measured
  during development reported 150/625 tracks at 0% loss and exit status 0 under
  `lk load-test`'s default layout. Every figure above comes from a run that
  asserted the track total.
