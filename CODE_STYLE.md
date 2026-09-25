# Code Style

Condensed from the sources listed at the end, at commit `7732f969`
(2026-09-25). On conflict, the source documents win.

How code is written in OwnCord — formatting, language conventions, naming,
error handling, tests, comments, and commit/PR shape. For layout and
gotchas per component, see [Server/CLAUDE.md](Server/CLAUDE.md) and
[Client/CLAUDE.md](Client/CLAUDE.md).

## Formatting

| Language   | Tool        | Enforced how                                                                     |
| ---------- | ----------- | -------------------------------------------------------------------------------- |
| TypeScript | Prettier    | Gate; config below                                                               |
| Go         | `gofmt`     | Runs as a formatter inside `golangci-lint` (`gofmt -l` alone can't fail a build) |
| Rust       | `cargo fmt` | Gate (no `rustfmt.toml` in the repo — default profile)                           |

`.prettierrc.json`: `singleQuote: false`, `semi: true`, `trailingComma: "all"`,
`printWidth: 100`, `tabWidth: 2`, `arrowParens: "always"`, `endOfLine: "lf"`.

`.prettierignore` excludes generated files that are verified by `git diff
--exit-code` instead of reformatted (`Server/db/dbgen/`,
`Client/src/lib/protocolTypes.ts`), frozen wire fixtures
(`protocol/fixtures/`), dated snapshot docs, and build/scratch output that
lives under a nested `.gitignore` Prettier doesn't read (`Client/dist/`,
`Client/src-tauri/target/`, `.serena/`, etc).

`.editorconfig` is a baseline, not a gate — nothing lints it, but it agrees
with Prettier/gofmt/rustfmt so an editor that honours it produces bytes CI
accepts: UTF-8, LF, final newline, trim trailing whitespace, 2-space indent
by default; tabs for `*.go`, `go.mod`, `go.sum` and `Makefile` (gofmt/make
require it); 4-space indent for `*.rs` (rustfmt default).

No `clippy.toml` in the repo — clippy runs with its defaults.

## TypeScript

`Client/tsconfig.json` strict flags actually enabled: `strict: true`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `esModuleInterop`,
`forceConsistentCasingInFileNames`, `isolatedModules`. Target `ES2023`,
`moduleResolution: "bundler"`. `types: ["node"]` is set for the dev config
so unit tests can use Node globals; `tsconfig.build.json` resets `types` to
`[]` so app code can't reach for them.

ESLint (`Client/eslint.config.js`, `typescript-eslint` `recommendedTypeChecked`
plus):

- `@typescript-eslint/no-floating-promises`: error — an unhandled promise is
  a swallowed rejection.
- `@typescript-eslint/switch-exhaustiveness-check` (error, unions count as
  exhaustive only with a `default`) — a switch over a union that misses a
  member is a silent drop, not a type error.
- `@typescript-eslint/no-unused-vars`: error, `^_` prefix opts out.
- `consistent-return`: error.
- `@typescript-eslint/no-misused-promises`: error but `checksVoidReturn:
false` — fire-and-forget `void somePromise()` is an intentional project
  pattern.
- A block of `no-unsafe-*`, `no-explicit-any` (warn), `no-non-null-assertion`,
  `no-empty-function`, `unbound-method`, `require-await`, and
  `no-redundant-type-constituents` are relaxed/off — deliberate project style,
  not oversight (see inline comments in `eslint.config.js`).
- `no-restricted-imports` / `no-restricted-syntax`: error on any
  `@tauri-apps/*` static or dynamic import outside `src/platform/desktop/**` —
  native imports stay behind the desktop platform seam (B7-4/B7-5); see
  [docs/architecture/platform-contracts.md](docs/architecture/platform-contracts.md).
- `npm run lint:cycles` (oxlint `import/no-cycle`, `--max-warnings=0`) fails on
  any new import cycle in `src/`.
- Test files (`tests/**/*.ts`) relax `no-floating-promises`,
  `no-explicit-any`, and `consistent-return`.

Custom rules in `Client/eslint-rules.js` — each encodes one invariant from
`Client/CLAUDE.md` as a lint rule rather than leaving it as prose:

| Rule                             | Enforces                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-leave-voice-when-superseded` | Forbids `leaveVoice()` inside a branch that already confirmed the current reconnect/connect attempt was superseded — that call acts on whichever session currently owns shared state, which by then may be a newer, live attempt.      |
| `e2ee-epoch-needs-keypair-check` | Requires a `this._ecdhKeyPair !== …` identity check alongside any `this._e2eeEpoch !== …` staleness check — epoch alone can't detect a torn-down-then-restarted session for a non-key-holder.                                          |
| `e2ee-verified-status-literal`   | Requires the `status` field passed to `setPeerVerification`/`setPeerVerificationIfCurrent` to be a string literal, never computed — a peer can only be reported verified from a hand-written call site tied to a real signature check. |
| `no-identity-scope-fallback`     | Forbids a `??`/`\|\|` placeholder as the `userId` argument to `getOrCreateIdentityKeyPair` — a missing id must abort, not mint/adopt a keypair under a placeholder scope.                                                              |
| `no-store-write-in-ws-on`        | Forbids calling an imported store mutator (`set*`/`add*`/`update*`/… from a `stores/` module) from inside a `ws.on(...)` callback outside `src/lib/dispatcher.ts`, the single WS-event entry point into domain stores.                 |

## Go

`Server/.golangci.yml` (v2) enabled linters, one line each:

| Linter                               | Purpose                                                                                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gocritic`                           | Opinionated bug/perf/style checks (diagnostic + performance tags; `hugeParam` disabled — too noisy for struct-heavy code)                                                                                                                                      |
| `gosec`                              | Security static analysis: SQL injection, hardcoded creds, weak crypto (excludes G104/G304/G306/G706, each with a stated reason)                                                                                                                                |
| `errcheck`                           | Every error return must be checked                                                                                                                                                                                                                             |
| `bodyclose`                          | Flags unclosed HTTP response bodies                                                                                                                                                                                                                            |
| `contextcheck`                       | Verifies `context.Context` propagation                                                                                                                                                                                                                         |
| `nilerr`                             | Flags returning `nil` when `err != nil`                                                                                                                                                                                                                        |
| `prealloc`                           | Suggests pre-allocating slices                                                                                                                                                                                                                                 |
| `unconvert`                          | Removes unnecessary type conversions                                                                                                                                                                                                                           |
| `unparam`                            | Flags unused function parameters                                                                                                                                                                                                                               |
| `wastedassign`                       | Flags assignments that are never used                                                                                                                                                                                                                          |
| `staticcheck`                        | Advanced correctness/perf/deprecation checks (`all` minus `SA1019`, suppressed for a tracked websocket-library migration)                                                                                                                                      |
| `modernize`                          | Flags outdated idioms (use `slices`/`maps`/`min`/`max`, range-over-int, `any`, `fmt.Appendf`)                                                                                                                                                                  |
| `funlen`, `cyclop`, `nestif`, `dupl` | Complexity budgets — a **ratchet**, not a standard: each threshold sits just above today's worst offender (funlen 100 lines/50 statements, cyclop max-complexity 20, nestif min-complexity 8, dupl threshold 150), tightened over time; excluded on `_test.go` |
| `exhaustive`                         | A switch over an enum-like type with no `default` must list every member (`default-signifies-exhaustive: true`)                                                                                                                                                |
| `errorlint`                          | Requires `errors.Is`/`errors.As` over `==`/type assertions on wrapped errors, and `%w` in `Errorf`                                                                                                                                                             |
| `durationcheck`                      | Flags a `time.Duration` multiplied by another `Duration`-typed value                                                                                                                                                                                           |

`gofmt` runs as a formatter (not a linter) in the same tool, and its
exclusion is `db/dbgen` (generated, verified separately).
`unparam`/`gosec`/`errcheck` are relaxed on `_test.go`; `gosec` is also
excluded under `cmd/smoke/` (a CI harness whose whole job is to exec a
named binary and stat a path it created — the taint gosec flags there is
the tool's purpose). `issues.max-issues-per-linter: 0` and `max-same-issues:
0` — every finding is reported, nothing hidden as a backlog.

**Error wrapping**: use `fmt.Errorf("%w: ...", sentinelErr)` to wrap a
sentinel error with context (e.g. `Server/db/markers.go`), and
`errors.Is`/`errors.As` to unwrap — enforced by `errorlint`.

**Context use**: `context.Context` is the first parameter of any function
that can block or be cancelled (`ctx context.Context` as the first arg is
the pattern throughout `Server/service/`), and `contextcheck` verifies it
propagates rather than being dropped or replaced with `context.Background()`
partway down a call chain.

**Package conventions**: `api/` REST handlers, `ws/` WebSocket hub, `auth/`
sessions/TOTP, `permissions/` role checks, `service/` domain logic shared by
both entry points, `db/` hand-written query wrappers (generated code lives
under `db/dbgen/`), `syncutil/` lock helpers with deadlock detection under
`-tags deadlock`. Only `db/` and `service/` import `db` freely; any other
production file needs a recorded exception. Only `permissions/` calls the
raw permission-bit helpers; everywhere else resolves a `permissions.Subject`
and calls the predicate that owns the property. Prefer the standard library;
`syncutil` exists so lock usage stays uniform and detectable to the deadlock
pass — don't hand-roll around it. Full detail:
[Server/CLAUDE.md](Server/CLAUDE.md#gotchas).

**`Server/invariants/`** is a structural rule layer (syntactic, `go/parser`
only, no type info) that runs at `go test` time and encodes rules the
generic linters can't express, each tied to a documented invariant or a real
past defect:

| Rule ID                                    | Checks                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncutil-locks`                           | Forbids raw `sync.Mutex`/`sync.RWMutex` in `ws` and `service` — must use `syncutil`, so the `-tags deadlock` pass can see the lock                                                                    |
| `authz-chokepoint`                         | Only `permissions/` may call the raw bit helpers (`HasPerm`, `HasAnyPerm`, `HasServerPerm`, `HasAdmin`, `EffectivePerms`, `EffectiveChannelPerms`); everywhere else must go through a named predicate |
| `db-import-boundary` (+ `db-handle-owner`) | Only `db/` and `service/` may import `db` freely; other importers need a recorded, reasoned allow-list entry                                                                                          |
| `egress-sites`                             | Restricts which functions in a file may open an outbound network connection, against an inventoried allow-list of trigger/destination/gate                                                            |
| `file-sizes`                               | Caps non-test Go files under `Server/` at 500 lines by default, with declared, classed exemptions                                                                                                     |

Exceptions are greppable via `invariant:allow` comments; each allow-list
only shrinks.

## Rust

`Client/src-tauri/` has no `rustfmt.toml` or `clippy.toml` — both tools run
with their default profiles/lints, gated as `cargo fmt` + `cargo clippy` in
CI (per [docs/contributing.md](docs/contributing.md#code-style)).
`Cargo.toml` sets `[lints.rust]`: `unsafe_op_in_unsafe_fn = "deny"`,
`unused_unsafe = "warn"`.

Tauri commands are marked `#[tauri::command]`; ones that need to run off the
main thread (`Client/src-tauri/src/credentials.rs`) use
`#[tauri::command(async)]`. The Rust backend is deliberately thin — native
APIs only, no business logic — per
[Client/CLAUDE.md](Client/CLAUDE.md): "TypeScript frontend ... plus a
deliberately thin Rust backend in `src-tauri/` for native APIs only."
Formatting is prettier/rustfmt-enforced; match the surrounding code rather
than reasoning about style from scratch.

## Naming

- Conventional-commit type prefixes (`feat`, `fix`, `refactor`, `docs`,
  `test`, `chore`, `perf`, `ci`) for commit subjects.
- Branch names: `feature/<name>`, `fix/<name>`, `docs/<name>`.
- Go stable rule IDs are kebab-case string constants (`"syncutil-locks"`,
  `"db-import-boundary"`).
- ESLint local rule names are kebab-case (`no-leave-voice-when-superseded`).
- Beyond these documented conventions, no repo-wide naming style guide was
  found in the sources read for this doc — match the surrounding file.

## Error handling

- Go: wrap with `%w` and a sentinel error, unwrap with `errors.Is`/`errors.As`
  (`errorlint` enforces this); every error return is checked (`errcheck`);
  don't silently return `nil` when `err != nil` (`nilerr`).
- TypeScript: unhandled promise rejections are a lint error
  (`no-floating-promises`); a `void`-prefixed fire-and-forget promise is the
  one accepted exception (`no-misused-promises` with `checksVoidReturn:
false`). `preserve-caught-error` is deliberately off — re-throwing with a
  different message is a project pattern.
- Security-sensitive invariants (voice-session supersession, E2EE
  epoch/keypair staleness, identity scope, permission chokepoints) are
  enforced as lint rules or `Server/invariants/` checks, not left to review
  alone — see the tables above.

## Tests

Frameworks: **vitest** (`Client/tests/unit`, `tests/integration`,
`tests/contract`, jsdom), **Playwright** (`Client/tests/e2e`, `tests/e2e/admin`,
`tests/e2e/native`, plus `tests/browser` in vitest browser mode), **`go
test`** with `-race` (and a separate `-tags deadlock` pass) for
`Server/**/*_test.go`, and **goleak** (`goleak.VerifyTestMain(m)` in each
package's `main_test.go`) to catch leaked goroutines. `cargo test --lib`
covers the Rust backend.

Conventions:

- A regression test must fail when the behavior is actually broken; prefer
  observable outcomes (a message is received once, a permission actually
  denies, remote media decodes) over implementation details
  ([docs/testing-behavior.md](docs/testing-behavior.md)).
- **Never make a failing test pass by weakening its assertions** — the
  client unit suite is green and must stay green this way
  ([CLAUDE.md](CLAUDE.md#gotchas)).
- A test whose assertions read, import, or execute an artifact owned by a
  _different_ top-level component belongs in `tests/contract`, not
  `tests/unit` — ownership is declared in the test/file name, and a contract
  test may only live in a tier whose CI job is in the required-checks list
  (see [docs/contributing.md](docs/contributing.md#what-belongs-in-testscontract)).
- Client coverage thresholds: 90% statements plus 70% branch/function/line in
  `vitest.config.ts`, with a 92% aggregate statement floor in
  `Client/coverage-floor.json`. Server has per-package floors
  (`ws`, `service`, `permissions`, `auth`, `db`) in
  `Server/coverage-floor.json`, checked by `Server/scripts/coverage-floor.sh`
  on the Linux CI leg — a floor only ever rises (a ratchet), never lowered
  without a recorded hold-point decision. Never lower a threshold to make a
  change fit.
- Server build-tag variants (`default`, `-tags otel`, `-tags wazero`,
  `-tags otel,wazero`) must all compile and pass `-race` and `-tags
deadlock`; verify with the `ci-check` skill rather than a plain `go build &&
go test`.
- Expand mutation-test targets (Stryker, 90% minimum) only after measuring
  a baseline; don't lower thresholds to make new tests green.

## Comments

No repo-wide comment style guide was found in the sources read for this doc.
In practice, comments in this codebase explain _why_, not _what_ — Go rule
files (`Server/invariants/*.go`) and ESLint rules
(`Client/eslint-rules.js`) consistently document the invariant a check
encodes, the historical bug shape that motivated it, and where the
allow-list for exceptions lives, rather than restating the code.

## Commits and PRs

- Branch from `dev`; `dev` is the integration branch and all contributions
  target it; `main` carries releases only.
- Use conventional commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`,
  `test:`, `chore:`, `perf:`, `ci:`).
- For anything non-trivial, the commit body carries the reasoning (what was
  wrong, why the obvious fix is wrong, what was done, a `Verified:`
  paragraph), and ends with a `Not included:` line naming scope
  deliberately left out.
- PR process: branch from `dev` → open PR against `dev` → all required
  checks must pass (protected branch, so a red PR can't merge) → request
  review → **squash merge with a conventional commit subject on the
  squashed commit**.
- User-visible changes get a `CHANGELOG.md` entry under `## Unreleased`,
  following that file's own "How to write an entry" rule (grouped,
  scannable, no walls of text).

## Sources

- [.prettierrc.json](.prettierrc.json)
- [.prettierignore](.prettierignore)
- [.editorconfig](.editorconfig)
- [Client/eslint.config.js](Client/eslint.config.js)
- [Client/eslint-rules.js](Client/eslint-rules.js)
- [Client/tsconfig.json](Client/tsconfig.json)
- [Server/.golangci.yml](Server/.golangci.yml)
- [Server/invariants/invariants.go](Server/invariants/invariants.go)
- [Server/invariants/syncutil_locks.go](Server/invariants/syncutil_locks.go)
- [Server/invariants/authz_chokepoint.go](Server/invariants/authz_chokepoint.go)
- [Server/invariants/db_import_boundary.go](Server/invariants/db_import_boundary.go)
- [Server/invariants/egress_sites.go](Server/invariants/egress_sites.go)
- [Server/invariants/file_sizes.go](Server/invariants/file_sizes.go)
- [Client/src-tauri/Cargo.toml](Client/src-tauri/Cargo.toml)
- [Client/src-tauri/src/commands.rs](Client/src-tauri/src/commands.rs)
- [Client/src-tauri/src/credentials.rs](Client/src-tauri/src/credentials.rs)
- [Server/CLAUDE.md](Server/CLAUDE.md)
- [Client/CLAUDE.md](Client/CLAUDE.md)
- [CLAUDE.md](CLAUDE.md)
- [docs/contributing.md](docs/contributing.md)
- [docs/testing-behavior.md](docs/testing-behavior.md)
