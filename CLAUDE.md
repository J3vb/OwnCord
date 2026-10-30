# OwnCord

Self-hosted chat platform (beta). `Server/` is a Go 1.27 REST + WebSocket
server over SQLite with LiveKit voice/video; `Client/` is a Tauri
v2 desktop app (TypeScript frontend, thin Rust backend). Per-component detail
lives in `Server/CLAUDE.md` and `Client/CLAUDE.md`; the protocol
and schema are documented in `docs/protocol.md`, `docs/schema.md`, and
`docs/architecture/README.md`.

## Generated code — never hand-edit

CI fails on drift, and the next generator run silently discards your edit.

| Generated                                                                                         | Source of truth                                                         | Workflow                                              |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `Server/db/dbgen/`                                                                                | `Server/db/queries/sqlite/*.sql`, `Server/migrations/`                  | `db-change` skill                                     |
| `Server/ws/message_types.go`, `Server/httperr/codes.go` **and** `Client/src/lib/protocolTypes.ts` | `protocol/schema.json`                                                  | `protocol-change` skill                               |
| `gendocs:*` blocks in `docs/api.md`, `docs/schema.md`, `docs/server-configuration.md`             | `Server/api/router.go`, `Server/migrations/`, `Server/config/config.go` | `cd Server && go run -tags otel,wazero ./cmd/gendocs` |

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

Optional; none is needed to build or test. The last four are also CI checks
that fail closed on a new finding (Workflow Security Lint and Supply-chain Scan
are required on `dev`; triggers in `scripts/ci-select.mjs`, pinned versions in
`.github/workflows/ci.yml`). Run the matching one before pushing that kind of
change.

- `ast-grep` — structural search/rewrite across TS/Go/Rust: `sg -p 'console.log($A)' -l ts`
- `gotestsum` — only the failures of a Go run: `cd Server && gotestsum -- -race ./...`
- `lk` (livekit-cli) — voice/video without a browser: `lk load-test --rooms 1 --publishers 2 --layout 5x5 --url <ws>`
- `ctx7` — current library docs: `npx ctx7@latest library <name> "<question>"`
- `osv-scanner` — after moving any lockfile; invocation and baseline in `osv-scanner.toml`
- `cargo-deny` — after changing `Client/src-tauri/Cargo.toml`/`.lock`: `cargo deny --manifest-path Client/src-tauri/Cargo.toml check`
- `zizmor` — after editing `.github/workflows/`: `zizmor --offline .github/workflows/`
- `actionlint` — after editing a workflow (CI pins 1.7.7): `actionlint .github/workflows/*.yml`

## AI Quality Guardrails & Engineering Standards

OwnCord is in beta with real users, so the bar is zero known defects and no
new hidden debt. These rules bind every agent and model working here. Where a
linter or test enforces a rule, it is named; the rest is checked in review.

### Pre-flight plan

Before writing code for anything beyond a one-line fix, post a plan with
exactly these three parts, then stop:

- **Affected files** — every file you will create, edit or regenerate.
- **State mutations** — each store, table, lock-guarded field, config key or
  on-disk file the change writes, and who else reads it.
- **Exactly two edge cases** you will handle and test. Pick the two most
  likely to bite: a network drop mid-operation, two callers racing on the
  same state, a reconnect that supersedes the attempt, a partial write.

When a human is in the loop, wait for their confirmation before editing (in
plan mode, the plan file is the pre-flight). An unattended run — a
`bughunt-fix` workflow, a routine, a CI-triggered session — has nobody to
ask: it writes the same three parts into the commit body or PR description
and proceeds, so a reviewer can see what was assumed.

### Go (`Server/`)

- **No naked returns.** Every `return` names its values, even in a function
  with named results. A naked return hides which value is live at that point.
  `nakedret` fails one at any function length (`max-func-lines: 0`).
- **Wrap every error you pass up with `%w`:** `fmt.Errorf("<op>: %w", err)`
  for context, `fmt.Errorf("%w: <detail>", ErrX)` for a sentinel. Callers
  use `errors.Is`/`errors.As`. `errorlint` fails `%v`/`%s` on an error and
  `==` on a wrapped one (docs/code-style.md, "Error wrapping").
- **Every new goroutine takes a `context.Context` and exits on `ctx.Done()`.**
  Bounded work gets `context.WithTimeout`/`WithDeadline` with its `cancel`
  deferred; a long-lived loop takes its owner's lifecycle context
  (`ws/event_persister.go`'s `go p.run(ctx)` is the pattern). A bare
  `go func() { … }()` with no context and no exit path is a leak and is
  rejected in review. `contextcheck` fails a dropped or replaced context.

### Frontend and Tauri (`Client/`)

- **`any` is banned.** Use the precise type, a generated protocol type, or
  `unknown` plus a narrowing check. `@typescript-eslint/no-explicit-any` is an
  error in `eslint.config.js`. The residue in `src/lib/voice/livekitReconnect.ts`
  only shrinks — never add an `eslint-disable` for this rule.
- **Every Tauri `invoke()` is wrapped in `try/catch`** where it is called, in
  `src/platform/desktop/` (the only place a `@tauri-apps` import may appear).
  The `catch` turns the rejection into a typed result or a user-visible
  error; never let it reach the caller unhandled or `void` it away. The
  webview keeps working when the Rust side fails. `nativeInvoke.ts` holds the
  shared door (`tryInvoke` returns a result, `invokeOrThrow` rejects with a
  `NativeCallError` that keeps the host's reason), and
  `local/invoke-needs-try-catch` fails a bare `invoke` everywhere else there.
- **WebSocket state stays isolated per connection attempt.** `src/lib/ws.ts`
  tags each `connect()` with a generation counter so a stale socket's events
  cannot touch the live connection. New code follows it: a handler checks it
  still owns the attempt before acting, reconnect cleanup touches only its
  own attempt's resources, and server events reach stores only through
  `src/lib/dispatcher.ts` (`no-store-write-in-ws-on` and
  `src/features/dispatcherDoor.test.ts` enforce that door).

## Gotchas

- **Verify with the `ci-check` skill**, not with an ad-hoc `go build && go test`.
  CI compiles four Go build-tag variants and runs a deadlock-detection pass;
  the default build proves nothing about the tagged ones.
- **The client unit suite is green and must stay green.** Never make a failing
  test pass by weakening its assertions.
- **A Linux Rust build of the client needs a prerequisite**: `livekit`
  (Linux-only) pulls `webrtc-sys`, which needs clang >= 21 and a prebuilt
  libwebrtc. Run `eval "$(Client/scripts/linux-webrtc-toolchain.sh)"` in each
  shell you build from, before `cargo test`/`clippy`/`tauri build`. It uses
  `CC`/`CXX` or an installed clang >= 21, and installs clang-21 from
  apt.llvm.org only on Debian/Ubuntu. Windows and server-only work need
  nothing. Details: [docs/architecture/linux-native-voice.md](docs/architecture/linux-native-voice.md),
  [docs/contributing.md](docs/contributing.md#client-tauri-v2).
- Security fixes ship as ordinary PRs to `dev` with neutral wording: say what
  was fixed, never the weakness. Never a public issue. Outside reporters use
  the private route in `docs/security.md`. This repo is public — unfixed
  defects do not belong in commits, issues, or PR descriptions.
- Branch from `dev` and PR to `dev` — `dev` is the integration branch and is
  PR-only; `main` carries releases. Squash merge, conventional commit subjects.
  Full model: [docs/contributing.md](docs/contributing.md#branch-and-pr-model).
