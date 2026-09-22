# OwnCord

Self-hosted chat platform (alpha). `Server/` is a Go 1.26 REST + WebSocket
server over SQLite with LiveKit voice/video; `Client/` is a Tauri
v2 desktop app (TypeScript frontend, thin Rust backend). Per-component detail
lives in `Server/CLAUDE.md` and `Client/CLAUDE.md`; the protocol
and schema are documented in `docs/protocol.md`, `docs/schema.md`, and
`docs/architecture/README.md`.

## Generated code — never hand-edit

CI fails on drift, and the next generator run silently discards your edit.

| Generated                                                                             | Source of truth                                                         | Workflow                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `Server/db/dbgen/`                                                                    | `Server/db/queries/*.sql`, `Server/migrations/`                         | `db-change` skill                                     |
| `Server/ws/message_types.go` **and** `Client/src/lib/protocolTypes.ts`                | `protocol/schema.json`                                                  | `protocol-change` skill                               |
| `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md` | `Server/api/router.go`, `Server/migrations/`, `Server/config/config.go` | `cd Server && go run -tags otel,wazero ./cmd/gendocs` |

## Bug-hunt ledger

`.superpowers/findings-ledger.json` is the shared ledger of hunt findings and
the only tracked copy — open a PR against it to add one. The readable
`FINDINGS.md` is **not tracked**: generate it whenever you want to read one
(gitignored, under a second, and CI uploads it as a build artifact):

```
node .superpowers/render-ledger.mjs           # write a local FINDINGS.md
node .superpowers/render-ledger.mjs --check   # validate the ledger only
```

Statuses: `open`, `fixed`, `declined`, `refuted`, `duplicate`, `blocked`;
`severity` must be `critical`, `high`, `medium` or `low`. Edit the ledger, never
the rendering — a hand-edited `FINDINGS.md` is overwritten by the next render
and committed by nothing. Everything else under `.superpowers/` is per-session
scratch and stays local.

## Tools for agents

Optional command-line tools that make a task cheaper. Install the ones you need
— none is required to build or test OwnCord. The last four are also CI checks
(`.github/workflows/ci.yml`), gated by the change selector: `workflow-lint` on a
`.github/**` change, `supply-chain` on a manifest, lockfile, `osv-scanner.toml`
or `deny.toml` change. Each fails closed on a new finding, so run the matching
one locally before pushing that kind of change.

| Tool                                                       | Reach for it when                                                                       | Install / run                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ast-grep`](https://ast-grep.github.io/)                  | searching or rewriting a structural pattern across TS/Go/Rust, rather than grep         | `brew install ast-grep` · `sg -p 'console.log($A)' -l ts`                                                                                  |
| [`gotestsum`](https://github.com/gotestyourself/gotestsum) | a failing Go run where you want the failures, not the wall of `ok` lines                | `go install gotest.tools/gotestsum@latest` · `cd Server && gotestsum -- -race ./...`                                                       |
| [`lk`](https://github.com/livekit/livekit-cli)             | checking voice/video without a browser — synthetic publishers against a room            | `brew install livekit-cli` · `lk load-test --rooms 1 --publishers 2 --layout 5x5 --url <ws>`                                               |
| [`ctx7`](https://context7.com)                             | looking up current library docs rather than trusting memory                             | `npx ctx7@latest library <name> "<question>"`                                                                                              |
| `osv-scanner`                                              | after moving any lockfile (`Server/go.mod`, npm, Cargo)                                 | `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest`, or the release binary; invocation and baseline in `osv-scanner.toml` |
| `cargo-deny`                                               | after changing `Client/src-tauri/Cargo.toml`/`.lock` — advisories, licences and sources | `cargo install cargo-deny` · `cargo deny --manifest-path Client/src-tauri/Cargo.toml check`; policy in `Client/src-tauri/deny.toml`        |
| `zizmor`                                                   | after editing anything under `.github/workflows/`                                       | `brew install zizmor` · `zizmor --offline .github/workflows/`                                                                              |
| `actionlint`                                               | after editing a workflow — expression syntax and action inputs                          | `brew install actionlint` (CI pins 1.7.7) · `actionlint .github/workflows/*.yml`                                                           |

CI installs each linter from a pinned release with a checked digest; the exact
steps (and the versions) are in `.github/workflows/ci.yml`.

## Gotchas

- **Verify with the `ci-check` skill**, not with an ad-hoc `go build && go test`.
  CI compiles four Go build-tag variants and runs a deadlock-detection pass;
  the default build proves nothing about the tagged ones.
- **The client unit suite is green and must stay green.** Never make a failing
  test pass by weakening its assertions.
- **A Linux Rust build of the client needs a prerequisite**: `livekit`
  (Linux-only) pulls `webrtc-sys`, which needs clang >= 21 and a prebuilt
  libwebrtc. Run `eval "$(Client/scripts/linux-webrtc-toolchain.sh)"` in each
  shell you build from, before `cargo test`/`clippy`/`tauri build`. Windows and server-only
  work need nothing. Details: [Client/CLAUDE.md](Client/CLAUDE.md),
  [docs/contributing.md](docs/contributing.md#client-tauri-v2).
- Security issues go through GitHub Security Advisories, never public issues
  (`docs/security.md`). This repo is public — unfixed defects do not belong in
  commits, issues, or PR descriptions.
- Branch from `dev` and PR to `dev` — `dev` is the integration branch and is
  PR-only; `main` carries releases. Squash merge, conventional commit subjects.
  Full model: [docs/contributing.md](docs/contributing.md#branch-and-pr-model).
