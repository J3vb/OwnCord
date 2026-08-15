# Infrastructure roadmap — design

Date: 2026-08-15
Status: implemented 2026-08-15 (same PR), with two deliberate leftovers:
the TOTP/partial-auth persister seam (Track 2 §3 — lowest impact, cut to
bound the change) and published capacity numbers (Track 3 §7 — the
`load-baseline` workflow now exists to produce them; publish only measured
values).

## Problem

OwnCord is deliberately single-instance (D8, `docs/architecture/system-overview.md`),
and that decision holds. A multi-model review pass (inventory sweep, eight review
lenses, adversarial verification) concluded the runtime is further along than the
operations story: the biggest growth risks are operational gaps, not throughput
ceilings. This roadmap records the verified, non-sensitive recommendations in
three tracks. Findings with security-sensitive detail were reported to the
maintainer separately per `docs/security.md` and are intentionally not itemized
here.

Overall verdict: no re-architecting needed. The codebase already fixes its own
bottlenecks where it finds them (session-touch throttle, batched audit/event
writers, WAL reader/writer pool split, the auth lockout persister seam). The
work below lets a single instance absorb roughly a 10x user increase without
revisiting D8.

## Track 1 — Raise the single-instance ceiling

Ordered by leverage. All stay inside D8; no new subsystems.

1. **Hub dispatch-loop liveness.** The hub's panic breaker (3 panics/60s,
   `Server/ws/hub.go`) stops broadcast delivery permanently with nothing
   observing it — clients still connect and appear online. On trip: `os.Exit(1)`
   so a supervisor restarts the process, and expose dispatch-loop liveness on
   `/health`. Do not attempt in-process self-recovery.
2. **Connection capacity guardrail.** Add a configurable global ceiling on
   concurrent WebSocket connections, checked before the upgrade and returning
   503 when reached. Static value; no adaptive logic.
3. **Presence broadcast coalescing.** Connect/disconnect presence broadcasts go
   through the sequenced path and fan out to all clients; a reconnect storm
   (proxy blip, deploy) multiplies that. Coalesce into one frame per
   ~250–500 ms window. Do **not** restructure `seqMu`'s fan-out itself — per-client
   FIFO ordering depends on it (see "What not to do").
4. **Narrow permission-cache invalidation.** Role-scoped channel-override edits
   call `InvalidateAll()` and then `RefreshChannelVisibility`, repopulating
   ~2×N entries synchronously inside the admin request. Narrow to the affected
   role's users — the per-user endpoints already use `InvalidateUser` with
   exactly this rationale (`Server/admin/handlers_channel_perms.go`).
5. **Read-state write short-circuit.** `channel_focus`/`mark_read` UPSERT the
   read-state row on the single writer even when it is already correct
   (`Server/service/channel.go`). Skip the write when `latestID` matches and
   `mention_count` is 0; optionally debounce bursts. Same shape as the
   session-touch throttle already in `Server/api/middleware.go`.
6. **Single-process file lock.** Take an exclusive flock on a `.lock` beside the
   SQLite file and fail fast with a legible message (warn-and-continue if the
   lock syscall errors — network filesystems). Process-local presence/replay
   state assumes one process owns the DB; make that assumption enforced.
7. **Small DB items.** Make the replay ring (1000) and cold-replay cap (5000)
   configurable; add `database.max_readers` with a sane bound; rewrite
   `DeleteExpiredSessions` to be index-friendly (note: `expires_at` is stored in
   RFC3339 `T` format — format the cutoff to match or migrate the data); gate
   boot-time `ANALYZE` on schema change plus a cheap `PRAGMA optimize`; add a
   table-driven test for the read/write SQL router (`isReadOnlySQL`).

## Track 2 — Cheap seams for a multi-instance future

Interfaces and documentation only. Nothing here builds distributed systems.

1. **Storage backend interface.** `*storage.Storage` is threaded concretely
   through ~9 handler signatures. Carve a consumer-side interface in `api/`
   (repo precedent: `service.Store`). Note `Open` must return
   `io.ReadSeekCloser` + size/modtime because both serve paths use
   `http.ServeContent` — that constraint is exactly what makes an S3 backend
   nontrivial, and discovering it now is the point. Do not implement S3.
2. **Split the admin CIDR list by purpose.** `/admin`, `/api/v1/metrics`, the
   Prometheus exporter, and the LiveKit webhook all share `admin_allowed_cidrs`.
   The webhook is already cryptographically authenticated; metrics scraping and
   human admin access are different trust domains. Separate config keys so
   moving one off-box never widens another. Cheapest seam for voice as a
   separate scaling unit.
3. **Persist TOTP/partial-auth stores via the existing persister seam.**
   `RateLimiter` already has the optional-persister shape; give
   `UsedTOTPCodeStore`/`PartialAuthStore` the same (store hashes, not raw
   codes). Do **not** persist the rate-limiter sliding windows — hottest path,
   benefit only exists post-multi-instance.
4. **Document the fifth D8 blocker.** Boot-time presence/voice reset
   (`Server/main.go`) is a single-instance assumption missing from D8's blocker
   list. One doc bullet: "process-local presence/voice state, wiped and rebuilt
   per process."

## Track 3 — Ops hygiene

The highest-impact track. Ordered.

1. **Implement the backup scheduler and retention — or visibly disable the
   controls.** `backup_schedule`/`backup_retention` exist in the settings table,
   admin UI, and API docs, but nothing reads them; a fresh install shows
   "Daily" selected and never backs up. Implement inside the existing 15-min
   maintenance loop (retention is in days, per the UI), or grey the controls
   out today. Do not build a general job scheduler.
2. **Enrich the default-build metrics surface.** `/api/v1/metrics` omits signals
   already computed in memory: reconnect tier stats, event-persister stats,
   writer-pool `WaitCount`/`WaitDuration` (the single most direct signal for the
   single-writer bottleneck), aggregate per-client backpressure counters, and
   permission-cache hit/miss. ~60 lines across ~4 files; do this before
   touching the otel path. Also wire or delete the seven declared-but-never-
   recorded OTel instruments in `Server/telemetry/metrics.go`.
3. **Make `/health` honest.** It returns a static "ok" — never checks the DB,
   disk, or hub dispatch loop. Add a bounded `SELECT 1`, disk-free check, and
   hub liveness; return 503 with a reason. Cache the result — the endpoint is
   unauthenticated and rate-limit exempt.
4. **Boot-smoke release artifacts.** The release pipeline signs and publishes
   server binaries and a Docker image it never executes. Boot each artifact
   against a scratch dir, poll `/health`, kill it; gate signing/publishing on
   that. This is the failure whose blast radius scales with adoption via
   self-update.
5. **Bare-metal Linux posture.** Ship a systemd unit template (note:
   `ProtectSystem=strict` breaks the self-updater unless the install dir is
   writable; ACME needs `AmbientCapabilities=CAP_NET_BIND_SERVICE`;
   `TimeoutStopSec=35` matches the 30s drain), a "Linux (systemd)" deployment
   section, and a cron backup one-liner. Add a "Reverse Proxy Topology" section
   with a working nginx snippet — and state correctly that LiveKit *signaling*
   is already proxied at `/livekit/*`; only WebRTC media (UDP range / TCP
   fallback) must be directly reachable.
6. **Backup robustness.** Make the backup directory configurable (mirror the
   `SetDatabasePath` plumb), document an optional post-backup hook command for
   off-host shipping (rsync/rclone left to the operator), remove the output
   file on `VACUUM INTO` error, and run `PRAGMA integrity_check` before listing
   a backup as restorable. Document that backups stall writes for their
   duration and schedule them off-peak. No S3, no manifests.
7. **Fix the k6 load script, then publish one capacity number.**
   `Server/scripts/k6/ws-load.js` predates the envelope protocol: auth fails on
   the first frame, three of four message types are wrong, and the only
   assertion checks HTTP 101 — a fully broken run reports green. Fix it, gate
   VU-connected on `auth_ok`/`ready`, add a `workflow_dispatch`-only job, and
   publish one reference sizing (connections vs p99 broadcast latency vs
   CPU/RAM) naming the two real bottlenecks. Do not gate main CI on it.
8. **Config and admin-settings honesty.** Warn (never fail) on unknown config
   keys — capture the koanf key set after the defaults layer as the allow-list
   and diff a second instance loaded from the file. Remove or disable the five
   admin-settings fields nothing reads (`server_icon`, `backup_schedule`,
   `backup_retention`, `max_upload_bytes`, `voice_quality`) and document which
   require config.yaml + restart. Add a boot-time disk-free warning and a
   metric (needs a build-tagged Windows path). Return 507/503, not 400, when
   upload storage fails at the OS level.
9. **CI/release polish.** Add a `concurrency` group to `release.yml`
   (`cancel-in-progress: false`); move `client-check`/`client-tests` off
   windows-latest or write down why they are there; record a graduation
   criterion for the non-blocking admin-e2e job; record the macOS scope
   decision near D8 rather than adding an unsigned build. Add the Tailscale
   CGNAT range note to `docs/tailscale.md` (admin routes 403 by default from
   `100.x.y.z` addresses).

## What not to do

- Do not decompose the hub's `seqMu` fan-out or make its queue sizes tunable —
  per-client FIFO ordering depends on the current structure
  (`Server/ws/hub_broadcast.go`, `Server/ws/CLAUDE.md`). Architecture fix or
  nothing; never a dial.
- Do not derive broadcast audience from pubsub subscribers —
  `hub_broadcast.go` documents why that was rejected.
- Do not build S3, a job scheduler, cloud backup shipping, disk-based admission
  control, adaptive connection limits, or settings hot-reload.
- Do not persist rate-limiter sliding windows or carve a pub/sub-slash-replay
  interface — speculative abstraction over the most delicate code in the repo.
- Do not publish capacity numbers before the k6 script is fixed.
- Do not attempt hub self-recovery after the panic breaker trips.

## Suggested sequencing

1. Track 3 #1 (backup scheduler) — the current UI state misleads operators.
2. Track 3 #2 + #3 (metrics + health) — everything in Track 1 is guesswork
   without these signals.
3. Track 3 #4 (release boot-smoke) — blast radius scales with adoption.
4. Track 3 #5 + #6 (systemd + proxy docs + backup dir) — one coherent
   bare-metal pass; also the prerequisite for the hub breaker `os.Exit(1)`.
5. Track 1 #1 + #2 (hub liveness + connection ceiling) — small, self-contained,
   no locking changes.

Follow-up review passes suggested where this one was thin: release-path supply
chain, TLS/ACME renewal failure handling and secrets at rest, and voice/LiveKit
failure and scaling behavior.
