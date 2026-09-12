# Plan: B6-9 — Published capacity profile

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-9 — Published capacity profile (roadmap workstreams 8 and 14)
**Satisfies**: BPR-030 (≥ 250 registered users, ≥ 100 simultaneous connections, ≥ 25 concurrent voice participants, "backed by published measurements on stated hardware")
**Complexity**: Medium-high
**Drafted**: 2026-09-12 at `dev` `1d100f98` (B6-8 landed as squash `7f84f534`, PR #1590; `1d100f98` is #1591 on top of it)

## Summary

BPR-030 promises three numbers and _published measurements on stated hardware_.
Today none of the three is measured on any stated hardware: `load-baseline.yml`
boots the server directly on an unconstrained `ubuntu-latest`, its own header
says the results are relative rather than a capacity promise, and four of the
six latency budgets have no metric behind them at all.

B6-9 closes that in one pass, in the order that makes the result trustworthy:

1. **the voice harness** — wrap LiveKit's own `lk load-test` (25 audio
   publishers + 25 subscribers) against the `livekit-server` OwnCord itself
   manages, pinned to the same release the product downloads;
2. **the missing metrics** — add the four measurements the budget table asks
   for and the two p99 thresholds it is missing, to `ws-load.js`, **before**
   any qualifying run;
3. **the constrained leg** — run the server under
   `--cpuset-cpus=0,1 --cpus=2 --memory=4g --memory-swap=4g`, which is the
   reference hardware reproduced rather than owned, with the load generator
   deliberately _outside_ that budget;
4. **publish the profile first** — `docs/capacity.md` states the hardware, the
   configuration and the exact commands, and is committed **before** the first
   qualifying run so the numbers cannot choose their own hardware;
5. **then run it**, and record what actually happened — tightening budgets where
   the data allows and filing a ledger finding where it does not.

**No number publishes unless it came from the constrained leg.** The existing
unconstrained job survives as an explicitly-labelled ceiling check, and so does
the developer's 16-core B3 bench baseline; neither may be quoted as capacity.

## Verify before you implement

Facts established from source at `1d100f98`; re-check any a parallel branch may
have moved. Rows marked **Refuted** contradict something the PRD or the task
brief asserts, and the plan below is built on the refutation, not the claim.

| Claim                                                                           | Status        | Evidence                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B6-8 has landed on `dev`                                                        | **Confirmed** | `7f84f534` "feat(server): rehearse the alpha-to-beta upgrade and its rollback (B6-8) (#1590)"; the branch's own trailing docs commits are in it (`dev`'s `ci-check` skill carries the deadlock-leg correction) |
| `load-baseline.yml` boots the server unconstrained, and says so                 | **Confirmed** | `load-baseline.yml:1-9` — "Runner-grade hardware is NOT a capacity promise"; `runs-on: ubuntu-latest`, `go build` then `./chatserver &` with no cgroup                                                         |
| `ws_connect_time` stops at socket open, before `auth_ok`                        | **Confirmed** | `ws-load.js` — `wsConnectTime.add(Date.now() - connectStart)` is the first statement of the `ws.connect` callback; `auth_ok` is handled ~30 lines later in `socket.on("message")`                              |
| `auth_time` has a p95 threshold and no p99                                      | **Confirmed** | `ws-load.js` `thresholds` — `auth_time: ["p(95)<1000"]`                                                                                                                                                        |
| `auth_time` measures the **REST** login, not the WS handshake                   | **Confirmed** | `authenticate()` brackets `http.post(.../api/v1/auth/login)` only                                                                                                                                              |
| `ws_broadcast_latency_ms` measures **sender acknowledgement**                   | **Confirmed** | `ws-load.js` — the `chat_send_ok` case is the only writer, keyed off `pendingSends[data.id]`, i.e. the sender's own envelope id                                                                                |
| Recipient delivery is measurable cross-VU with no server change                 | **Confirmed** | `docs/protocol.md:491` — `chat_message` is a channel broadcast carrying `payload.content` verbatim; every VU runs in one k6 process on one clock, so a send timestamp embedded in the content is comparable    |
| A channel broadcast reaches a connection only after its `channel_focus`         | **Confirmed** | `docs/protocol.md:150-155` — the subscription comes from the `channel_focus` round trip (or `active_channel_id` on a resume); `ws-load.js` already sends it on `ready`                                         |
| Voice join is a **WebSocket** path k6 can drive                                 | **Confirmed** | `docs/protocol.md:1241-1275` — `voice_join {channel_id}` → `voice_token {token, url, direct_url}`; rate limit 5/sec (`:1926`)                                                                                  |
| No voice metric exists today                                                    | **Confirmed** | `ws-load.js` never sends `voice_join`; the word "voice" does not appear in the file                                                                                                                            |
| `drainBudget` is 20 s and already asserted                                      | **Confirmed** | `Server/cmd/smoke/main.go:48` `drainBudget = 20 * time.Second`, enforced at `main.go:251` and `docker.go:236-250`                                                                                              |
| `lk load-test` takes the publisher/subscriber counts B6-9 needs                 | **Confirmed** | livekit-cli docs: `--audio-publishers`, `--subscribers`, `--duration`, `--room`, `--num-per-second` (default 5, max 10). `Server/scripts/voice-test.sh:60` already calls it with 2 + 2                         |
| `lk load-test` reports a per-participant join latency                           | **Refuted**   | Its output is two text tables — a per-track loading table (packets, bitrate, loss) and a per-subscriber summary (expected vs actual tracks, bitrate, loss, errors). Neither is a join-time distribution        |
| The "Message send → sender acknowledgement **(REST)**" budget row is measurable | **Refuted**   | No REST endpoint creates a message — every write reaches `service/message_delivery.go` from the WS read pump (B6-8 post-merge note, re-confirmed in `Server/api/channel_handler.go`). The path is WS-only      |
| `voice.auto_download_livekit` can supply the SFU                                | **Confirmed** | `Server/ws/livekit_download.go` — pinned `DefaultLiveKitVersion = "1.13.5"`, verified against the release `checksums.txt`, stored under `<data_dir>/livekit/`                                                  |
| Voice is **off** unless credentials are configured                              | **Confirmed** | `config.go:722-725` — default/dev credentials are blanked with a warning; `internal/app/hub.go` `buildVoice` reports `voiceEnabled` from `NewLiveKitClient`, and `api/router.go:502` mounts nothing when false |
| Voice credentials and binary are settable from the environment                  | **Confirmed** | `config.go:691` `env.Provider("OWNCORD_", …)` + `envKeyToKoanf` — the first underscore splits section from key, so `OWNCORD_VOICE_LIVEKIT_API_KEY` → `voice.livekit_api_key`                                   |
| A voice channel with default limits admits 25                                   | **Confirmed** | `Server/ws/voice_join.go:146,153` gate on `ch.VoiceMaxUsers > 0`; `AdminCreateChannel` defaults it to 0, and `"voice"` is a valid type (`service/channel_admin.go:39`)                                         |
| Password hashing is bcrypt **cost 12**                                          | **Confirmed** | `Server/auth/password.go:17` `bcryptCost = 12`; `auth/admission.go:19` calls it "a quarter second of one core"                                                                                                 |
| The bcrypt admission budget is sized from `runtime.NumCPU()`                    | **Confirmed** | `auth/admission.go` `DefaultAdmissionBudget() = max(2*runtime.NumCPU(), 4)`, selected by `ExpensiveAuthConcurrency: 0` (`config.go:458`)                                                                       |
| `--cpus=2` alone makes the container look like a 2-vCPU box                     | **Refuted**   | `--cpus` is a CFS quota; `runtime.NumCPU()` reads the CPU affinity mask, so it would still report the runner's 4. `--cpuset-cpus=0,1` is what sizes `NumCPU`, `GOMAXPROCS` and the admission budget to 2       |
| Registration is closed on a fresh database and the workflow already opens it    | **Confirmed** | `load-baseline.yml` — `PATCH /admin/api/settings {"registration_open":"true"}` with the comment explaining migration 001                                                                                       |
| `ws-load.js` is not generated, and CI does not run it                           | **Confirmed** | Its own header says so, and no workflow but `load-baseline.yml` references it. It has drifted off the wire protocol before                                                                                     |
| `.claude/plans/` is whitelisted, so this plan is tracked                        | **Confirmed** | `.gitignore:20` `!.claude/plans/` under the `.claude/*` exclusion                                                                                                                                              |
| No capacity document exists to publish into                                     | **Confirmed** | `docs/` has no capacity page; "250 registered" appears only under `docs/plans/`                                                                                                                                |

### What the refutations change

- **The "(REST)" sender-acknowledgement row is renamed, not measured as
  written.** `< 200 ms p95 / < 500 ms p99` is applied to the WebSocket
  `chat_send` → `chat_send_ok` round trip, which is the only send
  acknowledgement OwnCord has. The PRD's parenthetical is corrected rather than
  satisfied.
- **"Voice join (token + LiveKit room join)" cannot be measured as one number
  with these tools.** k6 has no WebRTC stack, and `lk load-test` publishes no
  join-latency distribution. B6-9 therefore measures and publishes the two
  halves separately — the OwnCord half (`voice_join` → `voice_token`) against the
  `< 2 s / < 4 s` budget as a real p95/p99, and the LiveKit half as the cohort's
  ramp-inclusive wall clock to full subscription, explicitly labelled as not a
  percentile. The gap is filed as a finding, not papered over.
- **`--cpus` is not the constraint that matters.** Without `--cpuset-cpus` the
  server would size its bcrypt admission budget and `GOMAXPROCS` for hardware
  the container cannot use, which is the opposite of reproducing a 2-vCPU box.

## Patterns to Mirror

| Category                | Source                                       | Pattern                                                                                                                         |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Recorded-not-gated data | `docs/plans/b3-bench-baseline-2026-09-01.md` | Provenance block (commit, date, toolchain, CPU, exact command) then the numbers in a fenced block so Prettier leaves them alone |
| Refusing a short result | `Server/scripts/bench-baseline.sh:12-17`     | An `EXPECTED` list, and a missing entry is a hard failure — "a silently shorter baseline is worse than no baseline"             |
| Honest headers          | `load-baseline.yml:1-9`                      | The workflow states what its numbers are and are not, at the top of the file                                                    |
| `::error::` + log tail  | `Server/scripts/docker-smoke.sh:62-69`       | Annotate the failure, then print the thing that makes it actionable                                                             |
| Why-not-what comments   | `Server/scripts/docker-smoke.sh:17-30`       | Every non-obvious step carries the reason it exists                                                                             |
| Existing `lk` wrapper   | `Server/scripts/voice-test.sh`               | Flag plumbing, the `command -v lk` guard and the install hint — extend the shape, don't re-derive it                            |

## Files to Change

| File                                  | Action | Why                                                                                                                 |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `Server/scripts/voice-load.sh`        | CREATE | The 25 + 25 voice harness: pins the SFU version, runs `lk load-test`, asserts tracks/errors/loss, writes the report |
| `Server/scripts/k6/ws-load.js`        | UPDATE | Four new metrics, two new p99 thresholds, and the sustained 100-connection capacity profile                         |
| `.github/workflows/load-baseline.yml` | UPDATE | A `leg: [constrained, ceiling]` matrix; 250 registered users; the voice leg; a header that says which leg publishes |
| `docs/capacity.md`                    | CREATE | The published profile: hardware, configuration, exact commands, budgets — committed before the first run            |
| `docs/deployment.md`                  | UPDATE | Link the capacity page from the operator-facing docs                                                                |
| `.superpowers/findings-ledger.json`   | UPDATE | Findings for anything the constrained leg misses, and for the unmeasurable combined voice-join number               |
| `CHANGELOG.md`                        | UPDATE | Unreleased entry — the published capacity profile and the harness                                                   |
| `docs/plans/b6-*.prd.md`              | UPDATE | B6-9 row → `in-progress`, then `complete` + this plan's link; correct the two refuted budget rows                   |

## Tasks

### Task 1: The voice harness

- **Action**: `Server/scripts/voice-load.sh` — 25 audio publishers + 25
  subscribers against the `livekit-server` **OwnCord itself is running**, not a
  separately booted one, so the measurement is of the product's configuration:

  ```bash
  lk load-test --url "$LIVEKIT_URL" --api-key "$API_KEY" --api-secret "$API_SECRET" \
    --room "$ROOM" --audio-publishers 25 --subscribers 25 \
    --num-per-second 10 --duration "$DURATION" | tee "$REPORT"
  ```

  Around that:

  - `command -v lk` guard with the install hint, mirroring `voice-test.sh`;
  - **pin the SFU**: default `LIVEKIT_VERSION` to `1.13.5`, the value of
    `ws.DefaultLiveKitVersion`, and print it into the report. A harness that
    measures a different SFU release than the product downloads is measuring
    something the owner will never run;
  - **assert, don't just print**: parse the subscriber summary and fail when any
    subscriber's actual tracks ≠ expected, when the error column is non-empty,
    or when packet loss exceeds `LOSS_BUDGET` (default 1%). `lk load-test` exits
    0 on a fully lossy room, so an unparsed table is a green run that proves
    nothing — the `bench-baseline.sh` `EXPECTED` lesson;
  - record the wall clock from launch to the end of the run as
    `livekit_wall_seconds`, and **label it in the report as ramp-inclusive and
    not a percentile** (`--num-per-second 10` means 50 participants take ≥ 5 s to
    spawn before any join cost is paid).

- **Why**: this is the PRD's named high risk ("the 25-participant voice number
  cannot be measured because no harness exists") and the owner's 2026-09-11
  decision is to wrap the SFU vendor's own tool rather than write one.
- **Mirror**: `Server/scripts/voice-test.sh` for the flag plumbing and the guard;
  `docker-smoke.sh` for `::error::` and the why-not-what commentary.
- **Test**: ShellCheck **0.9.0** (`koalaman/shellcheck:v0.9.0` — `:stable` is
  0.11.0 and misses SC2015), plus one offline self-check: `voice-load.sh --selftest`
  feeds a captured pass table and a captured fail table through the parser and
  asserts the exit codes, so the assertions have teeth without a live SFU.
- **Validate**: against a locally running server with voice configured, the
  script exits 0 and the report names the SFU version, the 25/25 counts and the
  loss figures; with `LOSS_BUDGET=0` it exits non-zero.

### Task 2: The missing metrics and their thresholds

- **Action**: in `Server/scripts/k6/ws-load.js` — re-read `docs/protocol.md`
  while touching it, per the file's own header. Four new measurements and the
  thresholds the budget table asks for:

  | Metric                               | Measures                                                     | Threshold                    |
  | ------------------------------------ | ------------------------------------------------------------ | ---------------------------- |
  | `ws_auth_ok_time`                    | socket open → `auth_ok` received                             | `p(95)<1000`, `p(99)<2000`   |
  | `auth_time` (existing)               | REST login                                                   | add `p(99)<2000`             |
  | `ws_broadcast_latency_ms` (existing) | `chat_send` → `chat_send_ok` (sender ack)                    | add `p(95)<200`, `p(99)<500` |
  | `ws_delivery_latency_ms`             | `chat_send` on one VU → `chat_message` on a **different** VU | `p(95)<250`, `p(99)<500`     |
  | `voice_join_time`                    | `voice_join` → `voice_token`                                 | `p(95)<2000`, `p(99)<4000`   |

  `ws_connect_time` keeps its existing `p(95)<2000` and its meaning; it is a
  different measurement from `ws_auth_ok_time`, not a replacement.

  Recipient delivery carries the send time **in the message content**:

  ```js
  // t=<13-digit ms> v=<sender VU> is read back off the chat_message broadcast.
  // Not client_message_id: that field is validated to exactly 50 chars of
  // "<13 ms>:<lowercase UUID v4>" (service/message_delivery.go:29-36) and every
  // keyed send also writes a delivery receipt row — a different code path under
  // test for free. Content is echoed verbatim by the broadcast and sanitisation
  // leaves "t=1757…" alone.
  const content = `Load test message ${vuId}-${msgCount} t=${Date.now()} v=${vuId}`;
  ```

  and the `chat_message` case skips `v=<own VU>` so a sender never measures its
  own echo — the budget says _recipient_ delivery.

  Then the capacity profile: ramp 0 → 100 over 60 s, **sustain 100 for 180 s**,
  ramp down 20 s, with the socket hold and the per-VU message budget derived
  from one `K6_HOLD_SECONDS` knob (default 25, preserving today's behaviour).
  Today every VU closes its socket after 25 s, so "100 simultaneous connections"
  holds only in the gaps between iterations — a sustained claim needs the socket
  held across the whole sustain window. `chat_send` is 10/sec, so 1 message per
  2 s per VU stays well inside it.

  Voice: gated on `K6_VOICE_CHANNEL_ID` and driven by the lowest-numbered VUs
  (`K6_VOICE_VUS`, default 0 → off; the capacity leg sets 25) so the WS profile
  and the voice profile are the same run. `voice_join` is 5/sec per connection
  and each VU joins once.

- **Why**: four of the six budget rows have no metric and two lack a p99. Adding
  them after a run would let the run choose its own thresholds; the PRD says
  explicitly that this lands before the first qualifying run.
- **Gotcha**: the script is not generated and CI does not run it — it has rotted
  off the wire protocol before, which is why every new frame type here is quoted
  against `docs/protocol.md` in a comment, and why `ws_authed`/`ws_ready` keep
  their `count>0` assertions. Add the same for voice: a voice leg where nobody
  got a token must not report a clean p95 over an empty sample.
- **Validate**: `k6 run --insecure-skip-tls-verify ws-load.js` against a local
  server reports non-zero counts for every new metric, and the summary JSON
  carries all the new thresholds. `npm run format` clean (Prettier owns this
  file).

### Task 3: The constrained leg

- **Action**: rewrite `load-baseline.yml` around
  `strategy.matrix: leg: [constrained, ceiling]`, one copy of the seeding and
  measurement steps, two boot steps selected by `if:`.

  The constrained boot:

  ```bash
  docker run -d --name owncord-sut \
    --network=host \
    --cpuset-cpus=0,1 --cpus=2 --memory=4g --memory-swap=4g \
    -v "$work:/app" -w /app \
    -e OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=100 \
    -e OWNCORD_VOICE_LIVEKIT_API_KEY -e OWNCORD_VOICE_LIVEKIT_API_SECRET \
    -e OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT=true \
    debian:bookworm-slim /app/chatserver
  ```

  Every flag earns its place:

  - **`--cpuset-cpus=0,1` is the one that matters.** `--cpus=2` is a CFS quota;
    `runtime.NumCPU()` reads the affinity mask, so under `--cpus` alone the
    bcrypt admission budget and `GOMAXPROCS` would still be sized for the
    runner's 4 cores — the server would believe it had hardware it does not
    have. Both flags are passed: the cpuset for what the runtime sees, the quota
    for what it may consume.
  - **`--memory-swap=4g`** equal to `--memory` disables swap, so 4 GB is really
    the ceiling rather than the point where paging starts.
  - **`--network=host`** because LiveKit's media path is UDP 50000-60000 and
    publishing ten thousand ports is not a thing; host networking keeps the
    cgroup constraint (which is what the reference hardware _is_) without a NAT
    in the middle of the measurement.
  - **`debian:bookworm-slim` with the release binary mounted**, not the published
    distroless image: that image has no shell and cannot host the
    auto-downloaded companion `livekit-server` process. The capacity claim is
    about the machine budget; the _packaging_ is qualified by B6-1's and B6-2's
    lifecycle smokes. Say this in the header rather than letting a reader assume
    the published image was measured.
  - **the load generator stays outside the budget** — k6 and `lk` run on the
    host, on CPUs 2-3. A generator inside the SUT's budget measures the
    generator.

  Also in this task:

  - seed **250** users (the `users` input default moves 100 → 250) while k6 uses
    the first 100 — that is the profile: 250 registered, 100 connected;
  - create the voice channel and export `K6_VOICE_CHANNEL_ID`; generate random
    LiveKit credentials per run (default/dev credentials blank themselves and
    voice silently disappears, `config.go:722`);
  - run `voice-load.sh` from Task 1 against the same server, then the k6 run;
  - upload `k6-summary.json`, the voice report, the metrics snapshot, the
    container's own view of its limits and the server log, per leg;
  - **fail the job on a threshold breach** for the `constrained` leg (k6 exits 99) and tolerate it on `ceiling`, which is informational by construction;
  - rewrite the header: what the constrained leg is, that it is the only leg any
    published number may come from, and that the ceiling leg exists to show
    headroom on a big box.

- **Why**: the owner's 2026-09-11 decision, verbatim. It is also the mitigation
  for the PRD's named risk — reference hardware stated before the numbers exist,
  reproducible by anyone with Docker.
- **Gotcha**: `ubuntu-latest` is 4 vCPU, so `--cpuset-cpus=0,1` assumes ≥ 4
  cores. Assert `nproc` ≥ 4 before the boot and fail loudly; a 2-core runner
  would silently put the generator and the SUT on the same two CPUs and quietly
  invalidate every number.
- **Validate**: `actionlint`; ShellCheck 0.9.0 on the new script; then
  `gh workflow run load-baseline.yml --ref feat/b6-9-published-capacity-profile`
  — both legs complete and upload artifacts. (`workflow_dispatch` runs from a
  pushed branch ref; only `schedule` is default-branch-only.)

### Task 4: Publish the profile — before the first run

- **Action**: `docs/capacity.md`, committed and pushed **before** the qualifying
  run, containing:
  - **the hardware**: 2 vCPU / 4 GB RAM / SSD, Linux x64, and the exact
    `docker run` line that reproduces it, with the note that the cpuset — not the
    quota — is what makes the server see two cores;
  - **the configuration**: every non-default key the leg sets and why;
  - **the commands**: build, boot, the seeding calls, `voice-load.sh` and the
    `k6 run`, verbatim and copy-pasteable;
  - **the budget table** with the two corrected rows (the sender-ack row is a
    WebSocket round trip, and voice join is published as two halves);
  - **an empty "Measured" section** with a provenance block ready to fill —
    commit, date, runner, SFU version, exact commands — mirroring
    `b3-bench-baseline-2026-09-01.md`;
  - **"Reading these numbers"**: the ceiling leg and the B3 bench baseline are
    not capacity; `lk`'s synthetic voice identities are not the same 25
    identities as the k6 `voice_join` sessions (the SFU carries 25 publishers +
    25 subscribers while OwnCord's control plane carries 25 voice states — a
    composition, not an end-to-end 25); 250 registered users is a seeded
    population, not 250 concurrently active ones; and `--network=host` removes a
    NAT hop, so these latencies are a floor for bridged or proxied deployments;
  - a link from `docs/deployment.md`.
- **Why**: this is the whole mitigation for "reference hardware is chosen to fit
  the numbers". Committing the hardware and the commands in a separate, earlier
  commit than the results makes the ordering auditable in `git log` instead of
  asserted in prose.
- **Validate**: `npm run format`, `npm run check:docs`, and
  `cd Server && go run -tags otel,wazero ./cmd/gendocs` leaves no diff (this is
  hand-written prose, not a `gendocs:` block, but the regeneration must stay
  clean).

### Task 5: Run it, and record what actually happened

- **Action**: dispatch the workflow on the branch, take the artifacts, and fill
  `docs/capacity.md`'s Measured section from the **constrained** leg only. Then,
  per row:
  - **met with margin** → tighten the budget to the measured p99 plus headroom,
    and say in the doc that it was tightened from data;
  - **met** → publish as is;
  - **missed** → publish the measured number, mark the row missed, and open a
    `.superpowers/findings-ledger.json` finding with the severity the gap
    deserves. **Do not re-run on a bigger box.** The ceiling leg's figure may be
    quoted only as "this is what the same run does with more cores", never as
    the profile.
  - Also file the finding for the unmeasurable combined voice-join number
    (Task 2's refutation) regardless of outcome — it is a known gap in the
    evidence, not a defect in the server, and the ledger is where known gaps
    live rather than a doc footnote.
- **Why**: "If a target is missed on the constrained leg, the finding is the
  deliverable." An honest miss with a ledger row is worth more than a number
  from hardware chosen after the fact.
- **Validate**: `node .superpowers/render-ledger.mjs --check`; the Measured
  section's provenance names the workflow run id and the commit, so a reader can
  fetch the same artifacts.

### Task 6: Reconcile the PRD and the changelog

- **Action**: B6-9 row → `complete` (or `in-progress` with the gap named, if a
  target missed) with this plan's link; correct the two refuted budget rows in
  "Initial latency budgets" so the PRD stops asking for a REST measurement that
  cannot exist and a combined voice number that cannot be measured; add the
  `CHANGELOG.md` unreleased entry.
- **Why**: a budget table that asks for an impossible measurement will be
  re-planned as new work at HP-6. The PRD's own rule is "tighten from data,
  never loosen" — correcting _what_ is measured is not loosening _how much_.
- **Validate**: `npm run format`; the PRD's B6-9 status matches what the
  Acceptance section below can actually tick.

## Validation

Run the `ci-check` skill, not an ad-hoc `go build && go test` — CI compiles four
build-tag variants and the deadlock leg is the whole tree.

| Gate                    | Command                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| Shell                   | `koalaman/shellcheck:v0.9.0` on `voice-load.sh`                                |
| Voice parser self-check | `Server/scripts/voice-load.sh --selftest`                                      |
| Workflow syntax         | `actionlint`                                                                   |
| Formatting and docs     | `npm run format`, `npm run check:docs`, `npm run check:hygiene`                |
| Generated docs          | `cd Server && go run -tags otel,wazero ./cmd/gendocs` → no diff                |
| Full gates              | `ci-check` skill                                                               |
| The measurement itself  | `gh workflow run load-baseline.yml --ref feat/b6-9-published-capacity-profile` |
| Ledger                  | `node .superpowers/render-ledger.mjs --check`                                  |

## Risks

| Risk                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_time` p95 < 1 s is missed because bcrypt cost 12 on 2 vCPU is ~0.5 s per login | Medium     | Medium | The 60 s ramp keeps logins to ~1.7/s against a 2-core budget, so it should hold. If it does not, that is the finding — the cost is a deliberate security choice, not a bug to tune away |
| A shared runner's noisy neighbour moves the numbers run to run                       | High       | Medium | Publish the run id and repeat the qualifying run; the cpuset keeps the generator off the SUT's cores, which is the largest controllable source                                          |
| `lk load-test` exits 0 over a fully lossy room                                       | Medium     | High   | Task 1 parses the subscriber summary and fails on track mismatch, errors or loss over budget; the parser has an offline self-check                                                      |
| The voice leg passes with voice silently disabled                                    | Medium     | High   | Default LiveKit credentials blank themselves (`config.go:722`); the leg generates random ones and a `voice_tokens` count assertion fails a run where nobody got a token                 |
| `ws-load.js` drifts off the wire protocol again                                      | Medium     | High   | Every new frame is quoted against `docs/protocol.md` in-file; the `count>0` thresholds turn drift into a red run instead of a clean empty one                                           |
| The constrained leg is quietly not constrained                                       | Low        | High   | `nproc` precondition, and the leg records `nproc`/`GOMAXPROCS`/cgroup limits from **inside** the container into the artifact                                                            |
| `--network=host` makes the measurement unlike a bridged deployment                   | Medium     | Low    | Stated in `docs/capacity.md`: it removes a NAT hop, so the published latencies are a floor for bridged/proxied deployments, not a ceiling                                               |
| 250 bcrypt-cost-12 registrations time the seeding step out                           | Medium     | Low    | Seeding is not measured; the job timeout moves from 25 to 45 minutes and the loop reports progress                                                                                      |

## Out of scope

- **Reconnect storms, database-pool wait deltas, upload admission through quota,
  TLS overhead** — B6-10's operational measurements. B6-9 measures the three
  BPR-030 numbers and the six budget rows, nothing more.
- **Failure drills** (disk-full, corrupt input, restore under readers) — B6-11.
- **Gating CI on these numbers.** Like the B3 bench baseline, this is recorded
  and published; `load-baseline.yml` stays `workflow_dispatch` and out of the
  blocking matrix. A perf gate on shared runners is a flake factory.
- **ARM64 capacity.** One reference hardware profile, x64, per the owner
  decision. ARM64 assets are qualified for lifecycle by B6-1, not for capacity.
- **Video.** BPR-030 says 25 concurrent _voice_; `--video-publishers` stays 0
  and `voice_max_video` is untouched.
- **Tuning the server to hit a budget.** If a number is missed, B6-9 reports it.
  Changing the server to make it pass is separate work with its own plan.

## Open questions for the owner

1. **Does a missed budget block B6-9 or HP-6?** This plan assumes it blocks
   neither automatically: the milestone's deliverable is a _published, honest_
   profile, and a missed row publishes as missed with a ledger finding. HP-6 is
   where the owner decides whether that is acceptable.
2. **Should `load-baseline.yml` gain a nightly schedule?** Not taken here — a
   perf run on shared runners is the flake source its own header names. It stays
   `workflow_dispatch`, re-run deliberately before releases.

## Acceptance

Ticked only where a run actually happened. Evidence is run **34701291805**
(`load-baseline.yml`, commit `593c764b`), constrained leg.

- [x] `lk load-test` runs 25 audio publishers + 25 subscribers against the
      OwnCord-managed `livekit-server`, pinned to the version the product
      downloads, and the harness fails on track mismatch, subscriber errors or
      packet loss over budget
      — 625/625 tracks, 12.5 mbps, 0% loss, 0 errors, SFU 1.13.5 under OwnCord's
      own generated `livekit.yaml`. `--selftest` covers the parser against real
      captured output offline. The assertions are not decoration: `lk`'s default
      `--layout speaker` produced 150/625 at 0% loss and exit 0 during development.
- [x] `ws_auth_ok_time`, `ws_delivery_latency_ms` and `voice_join_time` exist
      with p95 **and** p99 thresholds; `auth_time` and `ws_broadcast_latency_ms`
      gained their missing thresholds — all landed **before** the first
      qualifying run
      — commit `d4875606`, four commits before the run's `593c764b`.
      `summaryTrendStats` had to be added too: the threshold engine checks p99
      without putting it in the summary, so the artifact feeding the document
      would not have contained the number it publishes.
- [x] `load-baseline.yml` has a constrained leg pinned to 2 CPUs by cpuset and
      4 GB with swap off, the load generator outside that budget, and the
      container's own view of its limits recorded in the artifact
      — from inside the container: `nproc 2`, `cpu.max 200000 100000`,
      `cpuset.cpus.effective 0-1`, `memory.max 4294967296`, `memory.swap.max 0`.
      The cpuset is what made that true; `--cpus=2` alone reported 32 CPUs on a
      32-core host.
- [x] `docs/capacity.md` states the hardware, the configuration and the exact
      reproducible commands, and its commit **precedes** the qualifying run's
      commit in `git log`
      — `593c764b` is the capacity document's own commit and the run's head SHA:
      the document was the last thing pushed before the run was dispatched, and
      the Measured section was filled afterwards in a separate commit.
- [x] 250 registered users, 100 simultaneous connections sustained for 180 s,
      and 25 concurrent voice participants are all met on the constrained leg —
      or the miss is published as a miss with a ledger finding
      — all three met, nothing missed. 250 seeded, `vus_max` 100 across the
      sustain, 625/625 voice tracks; 12,137 messages sent, 1,139,476
      cross-connection deliveries, 0 WebSocket errors. Every latency budget
      passed with 3x-1000x margin, so all five were **tightened** rather than
      met and left.
- [x] Every published number comes from the constrained leg; the ceiling leg and
      the B3 bench baseline are labelled as ceilings in the document itself
      — and the ceiling leg turned out to be within noise of the constrained one
      (delivery p95 58 ms vs 60 ms), which is itself published: two CPUs are not
      saturated by this profile, so it is met with room rather than at the edge.
- [x] The two refuted budget rows are corrected in the PRD rather than left
      asking for measurements that cannot exist
      — the sender-ack row no longer says "(REST)", and voice join publishes as
      two halves. The initial-budget table is marked superseded and points at
      `capacity.md`, which HP-6 now measures against.
- [x] `ci-check` green for the legs this branch can affect
      — `check:docs` and `check:hygiene` pass; ShellCheck 0.9.0 and
      actionlint-with-shellcheck were run against the changed files through
      Docker, which `run.mjs` skips on Windows. **The Go, Rust and client legs
      were not re-run and are not claimed**: this branch changes one shell
      script, one k6 script, one workflow and documentation, and touches no Go,
      Rust or client source. CI runs them all on the PR.

## Post-merge notes

Things that were not visible when this plan was written.

**`lk load-test`'s default layout silently measures a quarter of the load.**
`--layout speaker` subscribes each simulated subscriber to about six tracks
however many are published, so a 25-publisher / 25-subscriber room reports
`150/625` tracks at 0% packet loss, no errors and exit status 0. Measured with
lk 2.18.6 against livekit-server 1.13.5: `speaker` gave 150/625 at 2.9 mbps,
`5x5` gave 625/625 at 12.0 mbps. The plan assumed the assertion would be
"actual == expected"; without the layout flag that assertion would have failed
every correct run, and without the assertion the layout default would have
published a quarter-load figure as a 25-participant result. Both are needed.

**`K6_VUS` is one of k6's own option names.** The first draft used it for the
peak-connection knob and k6 consumed it as the `vus` option, warning
"`vus=5` overrides scenarios configuration" and flattening the ramp. Renamed to
`K6_PEAK_VUS`. Custom `K6_`-prefixed names are fine; k6's own option names are
not.

**`summaryTrendStats` is not optional when a document publishes p99.** k6's
threshold engine evaluates `p(99)<…` perfectly well while the summary JSON
contains nothing above p95, so the run passes and the artifact that feeds
`docs/capacity.md` has no p99 in it.

**A `fail` helper that exits cannot be used by its own negative tests.** The
voice harness's selftest called `assert_total` directly for the cases that must
be rejected; the first rejection exited the script, with the message swallowed
by the redirect, so the selftest looked like a silent failure. The negative
cases run in a subshell.

**`--cpus` is not the constraint people think it is.** Verified rather than
argued: `docker run --cpus=2 debian nproc` reports the host's 32;
`--cpuset-cpus=0,1 --cpus=2` reports 2. Since `runtime.NumCPU()` reads the
affinity mask, a `--cpus`-only rig lets the server size `GOMAXPROCS` and its
bcrypt admission budget for cores it cannot use — the opposite of reproducing a
2-vCPU box.

**OwnCord's own generated `livekit.yaml` is usable for a single-machine load
rig, with two knobs.** The native E2E writes its own SFU config for loopback
ICE, and this plan expected to have to do the same. It does not:
`voice.node_ip=127.0.0.1` plus `voice.advertise_internal_ip` make the generated
config reachable from a same-machine client (verified at 25/25 tracks, 0% loss),
so the measurement runs against the product's configuration rather than a
hand-written one. The server logs its "node_ip is not a public address" warning,
which is correct for a rig and must not be copied into a deployment.

**The load workflow had been unrunnable since B4-1.** Its seeding step PATCHed
`registration_open`, a setting key B4-1 replaced with `registration_mode`, and
treated any non-200 as fatal — so the job exited 1 at seeding. Nothing noticed,
because the workflow is `workflow_dispatch`-only and in no CI matrix. Recorded
as OC-0444. The call was also unnecessary: a fresh install is invite mode.

**The combined voice-join figure is not measurable with these tools, and that
is not a ledger finding.** k6 has no WebRTC stack and `lk load-test` publishes
no join-latency distribution. The plan said to file it; on reflection the
ledger's shape is file/line/repro for defects, and this is a limit of the
instruments rather than a defect, so it is recorded in `docs/capacity.md`
beside the number it qualifies instead of as a synthetic defect row.

**Two CPUs were not the bottleneck, so this profile does not locate the
ceiling.** The unconstrained ceiling leg matched the constrained leg within
noise. That is good news for BPR-030 and a caution about scope: these numbers
say the 250/100/25 profile fits comfortably on the reference hardware, and say
almost nothing about where saturation begins. Finding that is B6-10's work.
