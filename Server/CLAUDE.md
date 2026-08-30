# OwnCord Server (Go)

Go 1.26, module `github.com/J3vb/OwnCord/Server`. Key deps: chi (HTTP), koanf
(config), sqlc-generated SQLite layer, LiveKit server SDK, coraza WAF,
prometheus.

## Layout

- `api/` REST handlers · `ws/` WebSocket hub · `auth/` sessions/TOTP ·
  `permissions/` role checks · `service/` domain logic shared by both entry points
- `db/` hand-written query wrappers; `db/dbgen/` is generated (see `db-change`)
- `cmd/` executable tooling, one `package main` per subdirectory —
  `cmd/genprotocol/` regenerates the protocol constants from `protocol/schema.json`,
  `cmd/seed/` fills a dev database (`go run ./cmd/seed -confirm-dev`),
  `cmd/dbinventory/` prints the `db`-importer table for
  `docs/architecture/server-boundaries.md` (exits 1 on an unlisted importer).
  `scripts/` holds shell/JS tooling only; no Go entry point lives there
- `admin/` web admin panel · `updater/` self-update + signature verification ·
  `plugin/` WASM plugin runtime (`-tags wazero`) · `telemetry/` OTel (`-tags otel`)
- `syncutil/` lock helpers that gain deadlock detection under `-tags deadlock`

## Gotchas

- Build tags gate whole files, so all four variants must compile: default,
  `-tags otel`, `-tags wazero`, `-tags otel,wazero`. Tests must also pass under
  `-race` and under `-tags deadlock`. The `ci-check` skill has the commands.
- `admin/static/index.html` is server-owned, and its invariants are locked from
  two places: text-level ones from `admin/perm_grid_test.go` and
  `admin/emoji_section_test.go`, execution-level ones from
  `Client/tests/contract/` — Go has no JS engine, so a Go port could only grep.
  Do not "fix" that split by rewriting the contract test as a regex.
- `ws` is the hub: broadcast fan-out, per-client send queues, replay, and voice
  state all interact under several locks. Sequenced frames share one per-client
  FIFO because clients ack only `max(seq)` — a frame that skips the queue, or a
  seq allocated for a frame that is then dropped, is silently unrecoverable.
- Prefer the standard library. `syncutil` exists so lock usage is uniform and
  detectable; do not hand-roll around it. `Server/invariants/` enforces this
  at `go test` time; exceptions are greppable via `grep -rn "invariant:allow" Server/`.
- Only `db/` and `service/` import `db` freely. Any other production file that
  imports it needs a row in `invariants/db_import_boundary.go` (`DBImportAllow`)
  with a disposition and reason — the B3 inventory, which only shrinks. New
  persistence goes behind a service, not into a handler.
- Only `permissions/` calls the raw permission bit helpers (`HasPerm`,
  `HasAnyPerm`, `HasServerPerm`, `HasAdmin`, `EffectivePerms`,
  `EffectiveChannelPerms`). Everywhere else resolves a `permissions.Subject`
  and asks the predicate that owns the property (`CanViewChannel`,
  `CanAdmitSession`, `CanSendMessage`, `CanType`, `CanJoinVoice`,
  `CanModerateVoice`) — one predicate per security property, so a call site
  cannot re-derive half a rule. The residue that predates B2-5 is listed by
  symbol in `invariants/authz_chokepoint.go` (`AuthzResidueAllow`) with a
  class and a reason; that list only shrinks too.
