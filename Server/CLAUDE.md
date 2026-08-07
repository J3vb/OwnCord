# OwnCord Server (Go)

Go 1.26, module `github.com/owncord/server`. Key deps: chi (HTTP), koanf
(config), sqlc-generated SQLite layer, LiveKit server SDK, coraza WAF,
prometheus.

## Layout

- `api/` REST handlers · `ws/` WebSocket hub · `auth/` sessions/TOTP ·
  `permissions/` role checks · `service/` domain logic shared by both entry points
- `db/` hand-written query wrappers; `db/dbgen/` is generated (see `db-change`)
- `admin/` web admin panel · `updater/` self-update + signature verification ·
  `plugin/` WASM plugin runtime (`-tags wazero`) · `telemetry/` OTel (`-tags otel`)
- `syncutil/` lock helpers that gain deadlock detection under `-tags deadlock`

## Gotchas

- Build tags gate whole files, so all four variants must compile: default,
  `-tags otel`, `-tags wazero`, `-tags otel,wazero`. Tests must also pass under
  `-race` and under `-tags deadlock`. The `ci-check` skill has the commands.
- `ws` is the hub: broadcast fan-out, per-client send queues, replay, and voice
  state all interact under several locks. Sequenced frames share one per-client
  FIFO because clients ack only `max(seq)` — a frame that skips the queue, or a
  seq allocated for a frame that is then dropped, is silently unrecoverable.
- Prefer the standard library. `syncutil` exists so lock usage is uniform and
  detectable; do not hand-roll around it.
