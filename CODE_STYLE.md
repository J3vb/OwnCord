# Code style

Condensed from the sources listed at the end, at commit `7732f969` (2026-09-25). On conflict, the code and config win, then the source documents.

How code is written in OwnCord: formatting, language rules, naming, error handling, tests, comments, and commit shape. Most rules here are enforced by a linter, a test or CI; the enforcing tool is named next to each. Per-component layout and gotchas: [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md).

## Formatting

| Scope                                                     | Tool        | Enforced how                                                                                            |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| All tracked text files (TS/JS, Markdown, YAML, JSON, CSS) | Prettier    | Gate: `npx prettier --check .` from the repo root (the Repository Hygiene job; `npm run check:hygiene`) |
| Go                                                        | `gofmt`     | Runs as a formatter inside `golangci-lint` (`gofmt -l` alone cannot fail a build)                       |
| Rust                                                      | `cargo fmt` | Gate: `cargo fmt --all -- --check` (default profile; see [Rust](#rust))                                 |

`.prettierrc.json`: `singleQuote: false`, `semi: true`, `trailingComma: "all"`, `printWidth: 100`, `tabWidth: 2`, `arrowParens: "always"`, `endOfLine: "lf"`.

`.prettierignore` excludes generated files verified by `git diff --exit-code` instead of reformatting (`Server/db/dbgen/`, `Client/src/lib/protocolTypes.ts`), frozen wire fixtures (`protocol/fixtures/`), dated snapshot docs, build and scratch output under a nested `.gitignore` Prettier does not read (`Client/dist/`, `Client/src-tauri/target/`, `.serena/`, etc.), every `*.html` file, and per-machine agent state (`.remember/`, `.claude/homunculus/`).

`.editorconfig` is a baseline, not a gate: nothing lints it, but it agrees with Prettier, gofmt and rustfmt, so an editor that honours it produces bytes CI accepts. UTF-8, LF, final newline, trimmed trailing whitespace, 2-space indent by default; tabs for `*.go`, `go.mod`, `go.sum` and `Makefile`; 4-space indent for `*.rs`.

## TypeScript

**Compiler (`Client/tsconfig.json`).** Strictness flags: `strict: true`, `noUncheckedIndexedAccess`, `noImplicitOverride`. `noUnusedLocals`/`noUnusedParameters`, `noImplicitReturns` and `exactOptionalPropertyTypes` are off; unused names are ESLint's job. Other options: `esModuleInterop`, `forceConsistentCasingInFileNames`, `isolatedModules`, `resolveJsonModule`, `skipLibCheck`, `noEmit`; target/lib `ES2023`, `module: "ESNext"`, `moduleResolution: "bundler"`. `types: ["node"]` lets unit tests use Node globals; `tsconfig.build.json` resets `types` to `[]` so app code cannot. `tests/e2e` has its own `tsconfig.e2e.json` (`npm run typecheck:e2e`).

**ESLint** (`Client/eslint.config.js`: `@eslint/js` `recommended` + `typescript-eslint` `recommendedTypeChecked`, plus):

- `@typescript-eslint/no-floating-promises`: error. A promise must be awaited, handled with `.catch`, or explicitly `void`-ed (the default `ignoreVoid` accepts `void p()`).
- `@typescript-eslint/switch-exhaustiveness-check`: error, with `considerDefaultExhaustiveForUnions: true`. A `default` clause counts as exhaustive, so only a switch over a union with no `default` must list every member (the same rule as Go's `exhaustive`). A switch that misses a member is a silent drop, not a type error.
- `@typescript-eslint/no-unused-vars`: error; a `^_` prefix opts out (but see oxlint's `no-underscore-dangle` under [Naming](#naming)).
- `consistent-return`: error.
- `@typescript-eslint/no-misused-promises`: error, but with `checksVoidReturn: false`. An `async` function may be passed where a void-returning callback is expected (event listeners, `ws.on` handlers), and nothing then checks that its rejection is handled: catch inside it.
- Relaxed or off, as deliberate project style (see the inline comments in `eslint.config.js`): the `no-unsafe-*` family, `no-explicit-any` (warn), `no-non-null-assertion`, `no-empty-function`, `unbound-method`, `require-await`, `no-redundant-type-constituents`, `no-require-imports`, `prefer-promise-reject-errors`, and `preserve-caught-error` (re-throwing with a different message is a project pattern).
- `no-restricted-imports` / `no-restricted-syntax`: error on any `@tauri-apps/*` static or dynamic import outside `src/platform/desktop/**`. Native imports stay behind the desktop platform seam; see [docs/architecture/platform-contracts.md](docs/architecture/platform-contracts.md).
- The config relaxes `no-floating-promises`, `no-explicit-any` and `consistent-return` for `tests/**/*.ts`, but every ESLint gate (CI, `npm run lint`, pre-push) lints `src/` only: `tests/` is never ESLinted, and colocated `src/**/*.test.ts` files get the full rule set.

**Other client lint gates** (all fatal under `src/`):

- `npm run lint:ox`: oxlint with `--deny-warnings` and `Client/.oxlintrc.json` (correctness errors; suspicious and perf warnings; `no-underscore-dangle`). Any warning fails.
- `npm run lint:cycles`: oxlint `import/no-cycle` at `--max-warnings=0`. A new import cycle in `src/` fails; invert the dependency edge rather than importing upward.
- `npx knip` (blocking; `Client/knip.json`, project `src/**/*.ts`): fails on an unused file, export or dependency.

**Custom ESLint rules** (`Client/eslint-rules.js`). Each encodes one invariant from `Client/CLAUDE.md` as a lint rule rather than prose. All five are `error`.

| Rule                             | Enforces                                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-leave-voice-when-superseded` | Forbids `leaveVoice()` inside a branch that already confirmed the current reconnect/connect attempt was superseded: that call acts on whichever session currently owns shared state, which by then may be a newer, live attempt. |
| `e2ee-epoch-needs-keypair-check` | Requires a `this._ecdhKeyPair !== …` identity check alongside any `this._e2eeEpoch !== …` staleness check: the epoch alone cannot detect a torn-down-then-restarted session for a non-key-holder.                                |
| `e2ee-verified-status-literal`   | Requires the `status` passed to `setPeerVerification`/`setPeerVerificationIfCurrent` to be a string literal, never computed: a peer can only be reported verified from a hand-written call site tied to a real signature check.  |
| `no-identity-scope-fallback`     | Forbids a `??`/`\|\|` placeholder as the `userId` argument to `getOrCreateIdentityKeyPair`: a missing id must abort, not mint or adopt a keypair under a placeholder scope.                                                      |
| `no-store-write-in-ws-on`        | Forbids calling an imported store mutator (`set*`/`add*`/`update*`/… from a `stores/` module) inside a `ws.on(...)` callback outside `src/lib/dispatcher.ts`, the single WebSocket-event entry point into domain stores.         |

Scope: `no-store-write-in-ws-on` covers `src/**/*.ts` except `src/lib/dispatcher.ts`. The others are scoped by `files:` globs: the supersession rule to `lib/livekitSession.ts`, `lib/livekitReconnect.ts` and `features/voice/joinOrchestration.ts`; the two E2EE rules to `lib/livekitE2EE.ts` and `features/voice/e2ee{Identity,Epoch,PeerState,Worker,Offer}.ts`; the identity rule to those six plus `lib/identity.ts`. Code moved into a new file is unguarded until that file is added to the glob.

## Go

`Server/.golangci.yml` (v2) sets no `linters.default`, so v2's `standard` set (errcheck, govet, ineffassign, staticcheck, unused) runs alongside the `enable:` list: 22 linters in all.

| Linter                               | Purpose                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `govet`                              | `go vet`'s analyzers                                                                                                                                                                                                                                                                                                     |
| `errcheck`                           | Every error return must be checked                                                                                                                                                                                                                                                                                       |
| `ineffassign`                        | Flags an assignment whose value is never used                                                                                                                                                                                                                                                                            |
| `unused`                             | Flags unused constants, variables, functions and types                                                                                                                                                                                                                                                                   |
| `staticcheck`                        | Every staticcheck, gosimple (S) and stylecheck (ST) check except `SA1019` (suppressed for a tracked websocket-library migration). Because `checks` is explicit, the six ST checks golangci-lint normally disables are on: ST1000, ST1003, ST1016, ST1020–ST1022                                                          |
| `gocritic`                           | Opinionated bug and performance checks (`diagnostic` + `performance` tags; `hugeParam` disabled as too noisy for struct-heavy code)                                                                                                                                                                                      |
| `gosec`                              | Security static analysis: SQL injection, hardcoded credentials, weak crypto (excludes G104/G304/G306/G706, each with a stated reason)                                                                                                                                                                                    |
| `bodyclose`                          | Flags unclosed HTTP response bodies                                                                                                                                                                                                                                                                                      |
| `contextcheck`                       | Verifies `context.Context` propagation                                                                                                                                                                                                                                                                                   |
| `nilerr`                             | Flags returning `nil` when `err != nil`                                                                                                                                                                                                                                                                                  |
| `prealloc`                           | Suggests pre-allocating slices                                                                                                                                                                                                                                                                                           |
| `unconvert`                          | Flags unnecessary type conversions                                                                                                                                                                                                                                                                                       |
| `unparam`                            | Flags unused function parameters                                                                                                                                                                                                                                                                                         |
| `wastedassign`                       | Flags assignments that are never used                                                                                                                                                                                                                                                                                    |
| `modernize`                          | Flags outdated idioms (use `slices`/`maps`/`min`/`max`, range-over-int, `any`, `fmt.Appendf`)                                                                                                                                                                                                                            |
| `funlen`, `cyclop`, `nestif`, `dupl` | Complexity budgets set as **targets**, not parked at today's worst: funlen 100 lines / 50 statements, cyclop max-complexity 20, nestif min-complexity 8, dupl threshold 150 (looser than the tool defaults, which over-count Go's `if err != nil`). An offender is refactored, never excluded. Not applied to `_test.go` |
| `exhaustive`                         | A switch over an enum-like type with no `default` must list every member (`default-signifies-exhaustive: true`)                                                                                                                                                                                                          |
| `errorlint`                          | Requires `errors.Is`/`errors.As` over `==` and type assertions on errors, and `%w` in `Errorf`                                                                                                                                                                                                                           |
| `durationcheck`                      | Flags a `time.Duration` multiplied by another `Duration`-typed value                                                                                                                                                                                                                                                     |

`gofmt` runs as a formatter in the same tool, excluding `db/dbgen` (generated, verified separately). `unparam`, `gosec` and `errcheck` are disabled on `_test.go`; `gosec` is also excluded under `cmd/smoke/`, a CI harness whose whole job is to exec a named binary and stat a path it created. `issues.max-issues-per-linter: 0`, `max-same-issues: 0` and `uniq-by-line: false`: every finding is reported, nothing is hidden as a backlog.

**Error wrapping.** Wrap an underlying error with context as `fmt.Errorf("<op>: %w", err)`; classify with an exported sentinel as `fmt.Errorf("%w: <detail>", ErrX)` (both forms appear in `Server/db/markers.go`). Callers use `errors.Is`/`errors.As`. `errorlint` fails `==` or a type assertion on an error, and an error formatted with anything but `%w`.

**Context.** `context.Context` is the first parameter of any function that can block or be cancelled (the pattern throughout `Server/service/`), and `contextcheck` verifies it propagates rather than being dropped or replaced with `context.Background()` partway down a call chain.

**Package conventions.** `api/` REST handlers, `ws/` WebSocket hub, `auth/` sessions and TOTP, `permissions/` role checks, `service/` domain logic shared by both entry points, `db/` hand-written query wrappers (generated code under `db/dbgen/`), `syncutil/` lock helpers with deadlock detection under `-tags deadlock`. Only `db/` and `service/` import `db` freely. New authorization code resolves a `permissions.Subject` and calls the predicate that owns the property; only `permissions/` and the frozen residue in `AuthzResidueAllow` call the raw permission-bit helpers. Prefer the standard library, except for locks: use `syncutil`, never a raw `sync.Mutex`. Full detail: [Server/CLAUDE.md](Server/CLAUDE.md#gotchas).

**`Server/invariants/`** is a structural rule layer (syntactic, `go/parser` only, no type information) that runs at `go test` time and encodes rules the generic linters cannot express, each tied to a documented invariant or a real past defect:

| Rule ID                                    | Checks                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncutil-locks`                           | Forbids raw `sync.Mutex`/`sync.RWMutex` in `ws` and `service`: they must use `syncutil`, so the `-tags deadlock` pass can see the lock                                                                                                                                                                                                                                    |
| `authz-chokepoint`                         | Only `permissions/` may call the raw bit helpers (`HasPerm`, `HasAnyPerm`, `HasServerPerm`, `HasAdmin`, `EffectivePerms`, `EffectiveChannelPerms`); everywhere else must go through a named predicate. The pre-existing residue (server-wide gates such as `api.RequirePermission`, administrator short-circuits) is frozen in `AuthzResidueAllow` with exact call counts |
| `db-import-boundary` (+ `db-handle-owner`) | Only `db/` and `service/` may import `db` freely; any other importer needs a `DBImportAllow` row (disposition + reason). The `db-handle-owner` half also fails raw-handle use (`SQLDb()`/`SQLReaderDB()`, `BeginTx()` on a `*db.DB`, a `*sql.DB`/`Tx`/`Conn` beside a db import) outside a `boundary` row, which pins the exact calls it makes                            |
| `egress-sites`                             | Restricts which functions may open an outbound network connection, against an inventoried allow-list of trigger, destination and gate                                                                                                                                                                                                                                     |
| `file-sizes`                               | Caps non-test Go files under `Server/` at 500 lines by default, with declared, classed exemptions                                                                                                                                                                                                                                                                         |

Exceptions are rows in each rule's Go table (`DBImportAllow`, `AuthzResidueAllow`, `EgressAllow`, `FileSizeOverrides`), or a line-scoped `//invariant:allow <rule-id> — <reason>` on the flagged line itself (none in use today; one without a reason suppresses nothing and is reported as `invariant-allow-needs-reason`). The DB-import, authz-residue and grandfathered file-size lists only shrink; `EgressAllow` is an inventory, so a new outbound path adds a row.

## Rust

`Client/src-tauri/` has no `rustfmt.toml` or `clippy.toml` (`.cargo/` included), so both tools run their defaults. `rust-toolchain.toml` pins Rust 1.98.1 (with clippy and rustfmt), which rustup applies to every cargo run there. CI gates `cargo fmt --all -- --check`, then `cargo clippy --all-targets -- -D warnings` (any warning fails, test code included), then `cargo test --lib`. `Cargo.toml` sets `[lints.rust]`: `unsafe_op_in_unsafe_fn = "deny"`, `unused_unsafe = "warn"` (fatal under `-D warnings`).

Tauri commands are marked `#[tauri::command]`; ones that must run off the main thread (e.g. `Client/src-tauri/src/credentials.rs`) use `#[tauri::command(async)]`. The Rust backend is deliberately thin, native APIs only, though on Linux it runs the voice/video session (`src-tauri/src/native_voice/`). Keep the TypeScript state machine platform-blind and put Linux-only behaviour in the adapter or the Rust session ([Client/CLAUDE.md](Client/CLAUDE.md)).

## Naming

- **Go** naming is lint-enforced by staticcheck's ST checks: ST1003 (MixedCaps; initialisms as `ID`, `URL`, `HTTP`, `JSON`; no underscores), ST1016 (one receiver name per type), ST1005 (error strings lower-case, no trailing punctuation).
- **TypeScript:** oxlint's `no-underscore-dangle` (fatal under `src/`) rejects a leading or trailing `_` except on `this._x` members, function parameters, destructured names and its allow-list, so `const _x` fails even though `no-unused-vars` accepts `^_`.
- **Client files, by observation (not lint-enforced):** a UI component is one PascalCase file under `src/components/` (e.g. `MemberList.ts`); `src/lib/` mixes camelCase (`httpProxy.ts`) and kebab-case (`deep-link.ts`), so match the neighbours and don't rename; tests are `*.test.ts`, colocated under `src/features/` or under `tests/`.
- Rule identifiers are kebab-case: Go invariant IDs (`"syncutil-locks"`) and ESLint local rules (`no-leave-voice-when-superseded`).
- Otherwise, match the surrounding file.

## Error handling

- **Go:** wrap with `%w` (context or sentinel) and unwrap with `errors.Is`/`errors.As` (`errorlint`); check every error return (`errcheck`); never return `nil` when `err != nil` (`nilerr`).
- **TypeScript:** a promise must be awaited, handled with `.catch`, or explicitly `void`-ed (`no-floating-promises`). Because `no-misused-promises` sets `checksVoidReturn: false`, an `async` callback passed to a listener or `ws.on` is not flagged: catch inside it.
- Security-sensitive invariants (voice-session supersession, E2EE epoch/keypair staleness, identity scope, permission chokepoints) are enforced as lint rules or `Server/invariants/` checks, not left to review alone; see the tables above.

## Tests

**Frameworks.**

- **vitest** (jsdom): `Client/tests/unit`, `tests/integration`, `tests/contract`, and the colocated `src/**/*.test.ts` files.
- **Playwright:** `Client/tests/e2e` (including `admin/` and `native/`), plus `tests/browser` in vitest browser mode.
- **`go test`** for `Server/**/*_test.go`, under `-race` and in a separate `-tags deadlock` pass.
- **goleak:** `goleak.VerifyTestMain(m)` in the `TestMain` of `admin`, `api`, `auth`, `config`, `db`, `permissions`, `storage`, `updater` and `ws` (not `service` or the other packages).
- **`cargo test --lib`** for the Rust backend.

**Conventions.**

- A regression test must fail when the behaviour is actually broken. Prefer observable outcomes (a message is received once, a permission actually denies, remote media decodes) over implementation details ([docs/testing-behavior.md](docs/testing-behavior.md)).
- **Never make a failing test pass by weakening its assertions.** The client unit suite is green and must stay green that way ([CLAUDE.md](CLAUDE.md#gotchas)).
- A client test whose assertions read, import or execute an artifact owned by another top-level component (`Server/`, root `protocol/`) belongs in `tests/contract`, not `tests/unit` (`src-tauri/` is Client, so reading it is a unit test). Placement follows capability: a contract test the owning component can run stays in its own suite (e.g. `Server/updater/tauri_key_contract_test.go`). The file name and top-level `describe`/`Test` name must name the owned artifact's path, and a contract test may only live in a blocking tier ([docs/contributing.md](docs/contributing.md#what-belongs-in-testscontract)).
- Some client code rules fail the unit suite rather than lint: new UI text outside a `src/i18n/` catalog (`tests/unit/ui-strings.test.ts`, shrink-only baseline); an unowned listener, interval, `setTimeout` or `new AbortController` in `src/` (lifecycle rules R1–R4, `tests/unit/lifecycle-ownership.test.ts`, shrink-only allowlist); importing a `features/*/wsHandlers.ts` from anywhere but `lib/dispatcher.ts` (`src/features/dispatcherDoor.test.ts`). Rules: [Client/CLAUDE.md](Client/CLAUDE.md).
- **Coverage.** Client: 90% statements plus 70% branches/functions/lines in `vitest.config.ts`, and a 93% aggregate statement floor in `Client/coverage-floor.json` (checked by `Client/scripts/coverage-floor.sh`). Server: an aggregate floor plus per-package floors (`ws`, `service`, `permissions`, `auth`, `db`) in `Server/coverage-floor.json`, checked by `Server/scripts/coverage-floor.sh` on the Linux CI leg. A floor only ever rises, never lowered without a recorded hold-point decision. Never lower a threshold to make a change fit.
- **Server build tags.** All four variants (default, `-tags otel`, `-tags wazero`, `-tags otel,wazero`) must compile; the suite must pass under `-race` and under `-tags deadlock`; and CI also runs the tag-gated tests (`-tags wazero ./plugin/...`, `-tags otel ./telemetry/... ./api/...`). Verify with `npm run check:server` plus those tag-gated tests ([AGENTS.md](AGENTS.md#commands)), not a plain `go build && go test`.
- **Mutation testing (Stryker).** Expand targets only after measuring a baseline. PR CI's `stryker.ci.config.mjs` mutates only `src/lib/permissions.ts` and breaks below 90%; the full `stryker.config.mjs` breaks below 50%. Don't lower thresholds to make new tests green.

## Comments

Go doc comments are lint-enforced by staticcheck: every non-`main` package has a `// Package <name> …` comment (ST1000), and a doc comment on an exported function, type, var or const starts with its name (ST1020–ST1022). There is no other written comment guide. In practice, comments explain _why_, not _what_: the Go invariant files (`Server/invariants/*.go`) and the ESLint rules (`Client/eslint-rules.js`) document the invariant a check encodes, the historical defect that motivated it, and where exceptions are recorded, rather than restating the code.

## Commits and PRs

- Branch from `dev`; `dev` is the integration branch and all contributions target it; `main` carries releases only. Branch names: `feature/<name>`, `fix/<name>`, `docs/<name>`.
- Conventional-commit subjects: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.
- For anything non-trivial the body carries the reasoning, not a restatement of the diff: what was wrong, why the obvious fix is wrong, what was done, concrete numbers, and a `Verified:` paragraph proving both directions (the defect present before, absent after). End with a `Not included:` line naming adjacent scope deliberately left out, and why.
- PR flow: open against `dev`; every required check must pass (the branch is protected, so a red PR cannot merge); request review; **squash merge with a conventional-commit subject on the squashed commit**.
- A change an operator would notice gets a `CHANGELOG.md` entry under `## Unreleased`, following that file's "How to write an entry" rule (grouped, scannable, no walls of text).

## Sources

- [.prettierrc.json](.prettierrc.json), [.prettierignore](.prettierignore), [.editorconfig](.editorconfig)
- [Client/tsconfig.json](Client/tsconfig.json), [Client/eslint.config.js](Client/eslint.config.js), [Client/eslint-rules.js](Client/eslint-rules.js), [Client/.oxlintrc.json](Client/.oxlintrc.json), [Client/knip.json](Client/knip.json), [Client/package.json](Client/package.json), [Client/vitest.config.ts](Client/vitest.config.ts)
- [Server/.golangci.yml](Server/.golangci.yml), [Server/invariants/invariants.go](Server/invariants/invariants.go), [Server/invariants/syncutil_locks.go](Server/invariants/syncutil_locks.go), [Server/invariants/authz_chokepoint.go](Server/invariants/authz_chokepoint.go), [Server/invariants/db_import_boundary.go](Server/invariants/db_import_boundary.go), [Server/invariants/egress_sites.go](Server/invariants/egress_sites.go), [Server/invariants/file_sizes.go](Server/invariants/file_sizes.go), [Server/db/markers.go](Server/db/markers.go)
- [Client/src-tauri/Cargo.toml](Client/src-tauri/Cargo.toml), [Client/src-tauri/rust-toolchain.toml](Client/src-tauri/rust-toolchain.toml), [Client/src-tauri/src/credentials.rs](Client/src-tauri/src/credentials.rs)
- [.github/workflows/ci.yml](.github/workflows/ci.yml), [scripts/run.mjs](scripts/run.mjs), [Client/stryker.ci.config.mjs](Client/stryker.ci.config.mjs), [Client/stryker.config.mjs](Client/stryker.config.mjs), [Client/coverage-floor.json](Client/coverage-floor.json), [Server/coverage-floor.json](Server/coverage-floor.json)
- [CLAUDE.md](CLAUDE.md), [Server/CLAUDE.md](Server/CLAUDE.md), [Client/CLAUDE.md](Client/CLAUDE.md), [docs/contributing.md](docs/contributing.md), [docs/testing-behavior.md](docs/testing-behavior.md)
