# OwnCord Server

The OwnCord server is a Go program. It serves a REST API and a WebSocket
connection over a SQLite database. Voice and video go through LiveKit. It is a
single binary (`chatserver`) that creates its own `config.yaml` on first start.

For the detail agents and maintainers need (rules, build tags, gotchas), read
[CLAUDE.md](CLAUDE.md). For running a server as an operator, read
[docs/quick-start.md](../docs/quick-start.md).

For a task-to-code map across the server, client, native code and admin panel,
start with [Starting a change](../docs/contributing.md#starting-a-change).

## Folder map

| Folder                | What is in it                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `main.go`             | Entry point. Also the `healthcheck`, `token` and `restore` subcommands.                       |
| `api/`                | REST handlers.                                                                                |
| `ws/`                 | WebSocket hub: fan-out, send queues, replay and voice state.                                  |
| `auth/`               | Sessions, passwords and TOTP.                                                                 |
| `permissions/`        | Role and permission checks. The only place that reads raw permission bits.                    |
| `service/`            | Domain logic shared by the REST and WebSocket entry points.                                   |
| `db/`                 | Hand-written query wrappers over SQLite.                                                      |
| `db/dbgen/`           | **Generated** by sqlc. Do not edit. Use the `db-change` skill.                                |
| `migrations/`         | SQL migrations. They only go forward.                                                         |
| `rollback/`           | Hand-run SQL that reverses later migrations, and the order to run it in.                      |
| `config/`             | Loads `config.yaml` and environment overrides.                                                |
| `storage/`            | Validates and stores file uploads.                                                            |
| `admin/`              | The web admin panel (`admin/static/`, plain JS, no build step).                               |
| `updater/`            | Self-update and signature checks.                                                             |
| `plugin/`             | WASM plugin runtime. The real sandbox needs build tag `wazero`; the default build has a stub. |
| `telemetry/`          | OpenTelemetry. The SDK wiring needs build tag `otel`; the default build has a stub.           |
| `safefetch/`          | The one bounded path for outbound fetches of content the server did not choose.               |
| `invariants/`         | Tests that enforce architecture rules, such as the `db` import boundary.                      |
| `cmd/`                | Extra programs: `genprotocol`, `gendocs`, `dbinventory`, `seed`, `smoke`.                     |
| `scripts/`            | Shell and JS tooling: coverage floor, Docker smoke, k6 and load scripts.                      |
| `testdata/`           | Test fixtures, including the SQLite snapshots.                                                |
| `internal/app/`       | Server wiring and start-up, called from `main.go`.                                            |
| `internal/alphasnap/` | Gives tests a private copy of the committed alpha dataset.                                    |

Small helper packages, all imported by the packages above:

| Package      | What it does                                                            |
| ------------ | ----------------------------------------------------------------------- |
| `clientip/`  | Works out the real client IP of a request, behind trusted proxies.      |
| `logctx/`    | A `slog` handler that adds request context to every log record.         |
| `syncutil/`  | Mutex types that detect deadlocks under `-tags deadlock`.               |
| `stackutil/` | Goroutine stack capture that is safe to log, and panic helpers.         |
| `diskutil/`  | Free disk space for a path, per operating system.                       |
| `netclass/`  | Classifies an IP address by how far it can be reached. Opens no socket. |
| `metrics/`   | Small in-process counters that work without the OpenTelemetry SDK.      |

These helpers stay at the top level on purpose. Moving them would change every
import path.

Other notable files at this level: `.env.example`, `Dockerfile`, `docker-compose.yml`,
`config.yaml.example`, `livekit.yaml.example`, `Makefile`, `sqlc.yaml` and
`coverage-floor.json`. The local tracing and metrics stack (`make otel-up`) lives in
`deploy/docker/`.

## Run it

You need Go 1.27 (see [docs/contributing.md](../docs/contributing.md#prerequisites)).
From this folder:

```bash
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=dev" .
./chatserver            # reads config.yaml in the working directory
./chatserver --help     # lists the subcommands
```

On Windows, build with `go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .`.
[docs/quick-start.md](../docs/quick-start.md) has the full first-run steps.

To fill a development database, run `go run ./cmd/seed -confirm-dev`.

## Test it

From this folder:

```bash
make test           # go test -race -timeout 20m ./...
make test-deadlock  # go test -tags deadlock -count=1 ./...
go test ./...       # quick run
```

CI also builds four tag variants: default, `-tags otel`, `-tags wazero` and
`-tags otel,wazero`. To run the main server CI checks from the repository
root, use `npm run check:server`.

Other `make` targets (`sqlc-generate`, `protocol-generate`, `docs-verify` and
more) are listed in [docs/contributing.md](../docs/contributing.md#server-go)
and at the top of the [Makefile](Makefile).
