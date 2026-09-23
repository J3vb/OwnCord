# OC-0445: unnecessary timeout reads during voice fan-out

Investigation: 2026-09-23. Base: `dev` at
`233b93f42ad941e00f43f2a62494707bdd30fe6e`. **Status: open pending operational
qualification on both TLS legs.** Published capacity budgets are unchanged.

The OC-0445 ledger entry carries this evidence and stays open until the
operational run below qualifies the fix.

## Validation

All four server build variants, `go vet`, golangci-lint 2.11.3, the full
deadlock suite, the plain admin allocation test and docs/ledger checks passed.
The full hub suite passed with `-race`, including race, sweep and simulation
tests (466.102 s, 88.8% coverage). A final whole-hub deadlock rerun also passed.

The whole-server `go test -race -count=1 ./... -coverprofile=... -cover` run
timed out in `db` and `service` at the default ten-minute package deadline;
the other packages passed. Rerunning those two packages without coverage and
with `-timeout=20m` also timed out, in SQLite migration work at different tests.
No race report or assertion failure was emitted. This is not a whole-server
race pass, and the aggregate coverage gate remains unconfirmed. CI must finish
those packages; no test assertion or product latency budget was relaxed.

## Cause and evidence

The sender acknowledgement is enqueued by `handleMessageApply` before the
asynchronous chat broadcast. Moving acknowledgements ahead of the broadcast,
or introducing a priority queue, would therefore not address this bottleneck
and would endanger the single-FIFO sequencing contract.

Voice leave/join resolves its audience through `voiceEventAudience` →
`channelReadAudienceImpl` → `subjectFor` → `PermissionService.Subject`.
Although role and override data are cached, `Subject` reads `HasActiveTimeout`
live for each non-administrator. `permissions.CanViewChannel` does not consult
timeout state. With 100 member connections, one audience scan needlessly
executes 100 timeout queries; 25 synchronized leave/join pairs execute 5,000.
These reads consume CPU and the shared database reader pool alongside chat
permission checks and readback. Chat persistence and upload quota/metadata writes
also compete for the database's writer and the same CPUs. The existing
owner-only fan-out fixture bypasses the timeout lookup and conceals this cost.

Before changing production code, a file-backed database benchmark reproduced
the 100 timeout reads per audience. CPU, block and mutex profiles were captured.
A diagnostic ablation returned the fixture's known `false` timeout value instead
of querying it: across five mixed bursts, median per-run acknowledgement p95
fell from 141.1 to 91.02 ms and delivery p95 from 141.5 to 101.2 ms. This temporary
benchmark-only bypass was removed before the final measurements. Production
write/admission checks were never bypassed. The `diagnostic-*.txt` logs preserve
that experiment: their counter records wrapper invocations (5,100), including
calls short-circuited by the ablation, rather than actual SQL executions. They
are separate from the final production-fix comparison below.

The final audience CPU profile attributes 86.34% of all samples to stacks through
`HasActiveTimeout`; after the fix, that function has no samples. These profiles
include fixture setup as well as benchmark iterations. The initial mixed block
profile shows `database/sql.(*DB).conn` at 39.79% of cumulative blocking delay,
including `MessageService.SendMessage`. Its mutex profile is dominated by upload
quota/metadata serialization, not the hub's sequence lock. These are summed
goroutine delays, not request percentiles. Text profile summaries are adjacent
to this report; commands below regenerate the binary profiles.

This establishes a concrete amplified cost and a causal local improvement. It
does **not** establish that this is the sole cause of the historical TLS tails.
Average cgroup CPU cannot rule out short bursts or database waits. Also, the
original ledger's 58,243 `voice_state` samples count deliveries observed by
recipients (`voiceStates.add(1)` in `ws-load.js`), not 58,243 broadcast operations;
they cannot support the original “five times as many broadcasts” inference.

## Fix and invariants

`PermissionService.CanViewChannel` resolves only the visibility inputs, through
the existing generation-guarded role/override cache and live DM membership.
The hub uses it when the permission service is present; the existing live
checker fallback is retained. A partially resolved `Subject` is never exposed
to a caller that could mistakenly use it for a write gate. `Subject` continues
to resolve timeouts live for sends, reactions and voice admission.

The change retains per-user overrides, fail-closed resolution, administrator
semantics, archive handling, DM membership and cache invalidation. Dispatch-time
NSFW filtering is unchanged. No queue, lock, rate limit, topic admission rule,
sequence assignment, replay append, reconnect registration or recipient
delivery ordering changes. Sequenced frames still traverse the same normal FIFO
under the existing `seqMu` serialization, preserving `max(seq)` acknowledgement
and replay semantics.

Regression tests count timeout reads rather than enforcing noisy timing limits.
They also cover timeout application/lifting without invalidation, write/admission
denial while timed out, role/user override invalidation, admin bypass, archive
denial, missing permissions, store failure and live DM membership removal.

## Controlled before/after measurements

Go 1.26.7, Linux amd64, Intel Xeon Platinum 8573C. Both revisions used the
identical benchmark source, `GOMAXPROCS=2`, and affinity to CPUs 0 and 1,
sequentially with no concurrent test runs. File-backed SQLite, four readers,
100 ordinary members, warmed permission cache. This host has an eight-CPU
cgroup quota; it is **not** the reference 2-vCPU / 4-GB cgroup.

Audience values are medians of three 3-second samples (with profiling enabled):

| Metric per 100-member voice audience |       Before |     After |
| ------------------------------------ | -----------: | --------: |
| Time                                 | 1,986,457 ns | 76,371 ns |
| Allocated bytes                      |       59,608 |     7,608 |
| Allocations                          |        1,697 |        97 |
| Timeout queries                      |          100 |         0 |

Burst values are medians of **ten independent runs' percentiles**, not pooled
percentiles. Each run contains 100 sends, 100 sender acknowledgements and 9,900
other-recipient chat deliveries. The mixed case adds 25 voice leave/join pairs
and 100 concurrent upload quota reservations/metadata writes on the same DB.

| Case / metric (ms)                   |          Before |           After |
| ------------------------------------ | --------------: | --------------: |
| Chat only: acknowledgement p95 / p99 |   91.20 / 92.48 |  96.54 / 100.52 |
| Chat only: delivery p95 / p99        |   90.36 / 93.70 |  99.27 / 101.84 |
| Mixed: acknowledgement p95 / p99     | 177.50 / 183.80 | 113.40 / 120.00 |
| Mixed: delivery p95 / p99            | 186.35 / 197.65 | 122.60 / 126.55 |
| Mixed: total burst duration          |          241.20 |          143.65 |
| Mixed: timeout queries per burst     |           5,100 |             100 |

Mixed median p95 improves by 36.1% for acknowledgement and 34.2% for delivery.
The remaining 100 timeout reads are the required live chat admission checks.
Chat-only medians are slightly slower in the after run; this is not evidence of
a general chat-only speedup. Mixed runs remain variable: after-fix acknowledgement
p95 spans 79.77–220.8 ms and delivery p95 81.19–221.3 ms. No claim that every run
meets the published budgets follows from these results. The raw output for every
sample is committed in `before-*.txt` and `after-*.txt`.

The burst benchmark exercises the real message handler, event persister,
audience resolution, fan-out, sequencing and client queues. Time starts when
chat enters the handler (after that client's simulated voice work) and ends
when the in-process consumer reads the queue. Generator and consumers share
the same CPUs as the hub. There is no reconnect storm/handshake, TLS, socket
transport, HTTP parsing, actual voice membership/SFU admission or upload file
I/O. The burst is intentionally synchronized, unlike the complete k6 schedule.
It isolates the voice/upload interaction and **is not a replacement for the
B6-10 operational profile or a new capacity claim**.

## Reproduce

From the repository root, with Go 1.26.7 on `PATH` and CPUs 0–1 available:

```bash
git worktree add --detach /tmp/oc-0445-before 233b93f42ad941e00f43f2a62494707bdd30fe6e
cp Server/ws/oc_0445_bench_test.go /tmp/oc-0445-before/Server/ws/
```

Run the following first in `/tmp/oc-0445-before/Server`, then in the patched
`Server/`, using a different `prefix` each time. Run sequentially, without other
tests or profilers competing on the same CPUs:

```bash
prefix=/tmp/oc-0445-before
GOMAXPROCS=2 taskset -c 0,1 go test ./ws -run '^$' \
  -bench '^BenchmarkOperationalAudience$' -benchtime=3s -count=3 \
  -o "$prefix.test" -cpuprofile="$prefix.cpu" \
  -blockprofile="$prefix.block" -mutexprofile="$prefix.mutex" \
  > "$prefix-audience.txt"
GOMAXPROCS=2 taskset -c 0,1 go test ./ws -run '^$' \
  -bench '^BenchmarkOperationalBurst$' -benchtime=1x -count=10 -timeout=120s \
  > "$prefix-burst.txt"
go tool pprof -top -cum -focus=HasActiveTimeout "$prefix.cpu"
go tool pprof -top -cum "$prefix.block"
go tool pprof -top -cum "$prefix.mutex"
```

To inspect contention in the mixed case, separately run the burst benchmark
with `-bench '^BenchmarkOperationalBurst/mixed$' -benchtime=1x -count=1` and
the three profile flags. Profiling adds overhead: do not combine those request
percentiles with the unprofiled ten-run table above.

## Still required on reference hardware

Docker and k6 are unavailable in this environment. No full operational run was
performed. The owner can run the existing workflow against this PR branch:

```bash
gh workflow run load-baseline.yml --repo J3vb/OwnCord \
  --ref fix/oc-0445-operational-latency \
  -f profile=operational -f users=250 -f connections=100 -f voice=25
```

The workflow runs both `self_signed` and `off` with the server constrained to
2 CPUs / 4 GB and the generators on separate CPUs. For **each leg**, record
`ws_broadcast_latency_ms` (sender acknowledgement) p95 < 150 ms and p99 < 300 ms,
and `ws_delivery_latency_ms` p95 < 200 ms and p99 < 400 ms. Confirm the intended
100-connection population, reconnect recovery/replay integrity, voice churn,
upload admission/refusal behavior, queue drops/errors and CPU/RSS from the
workflow's artifacts. Compare the two TLS legs only after both finish. The
steady-profile behavior on reference hardware also remains unmeasured for this
patch; use `-f profile=capacity` for that companion check.

Only a real operational run's numbers can close OC-0445. Retain the finding as
open if either budget still misses; use the remaining tail profiles to continue
the investigation rather than changing thresholds or rate limits.
