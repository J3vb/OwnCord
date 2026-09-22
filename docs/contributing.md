# Contributing

How to set up the development environment and contribute to OwnCord.

## Development Setup

### Prerequisites

| Platform        | Server | Client       |
| --------------- | ------ | ------------ |
| Windows 10+ x64 | ✅     | ✅           |
| Linux x64       | ✅     | ✅           |
| Linux ARM64     | ✅     | ✅ (CI only) |

- **Go 1.26+** (server)
- **Node.js 26.x / npm 11.x** (client) — `Client/.nvmrc` is the source of truth;
  `engine-strict` makes a different major a hard failure at `npm ci`, not a
  warning, and `node scripts/check-node-policy.mjs` fails the Repository
  Hygiene job when any other statement of the version disagrees with it
- **Rust / Cargo** (Tauri client — not needed for server-only work)
- **Docker + Compose v2** (optional — alternative to building the server locally)

### Available Commands

#### Root facade — one entry point

From the repository root. These orchestrate the per-stack commands below; they
are a convenience, not a replacement. Nothing here needs `make`, and everything
works the same on Windows, macOS and Linux.

| Command                       | Description                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run bootstrap`           | `npm ci` in all three package roots                                                                                           |
| `npm run check`               | Everything CI gates on: server, client, Rust                                                                                  |
| `npm run check:server`        | Server only — build variants, vet, race, deadlock, lint, generated-output drift                                               |
| `npm run check:client`        | Client only — typecheck, lint (warnings denied, import cycles), knip, coverage-gated unit + integration tests, bundle budgets |
| `npm run check:rust`          | Tauri backend — `cargo test --lib` and clippy                                                                                 |
| `npm run check:docs`          | Fail if a watched document contradicts the ledger's finding counts, or the ledger fails to render                             |
| `npm run format`              | Prettier over the client, `gofmt -w` over the server                                                                          |
| `npm run generate`            | Regenerate protocol constants and the sqlc query layer                                                                        |
| `npm run release:preflight`   | `check` plus a client production build                                                                                        |
| `node scripts/run.mjs --list` | Print the exact command every task runs, and where                                                                            |

Tools CI installs but you may not have — `golangci-lint`, `sqlc` — are skipped
with a printed reason rather than failing the run.

**Working on the server only? You never need Node.** The facade prints each
command it runs and the directory it runs it in; those are the commands in the
next section, and using them directly is equally correct.

#### Server (Go)

| Command                                                   | Description                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| `go build -o chatserver.exe -ldflags "-s -w" .`           | Build server binary (Windows)                                            |
| `CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w" .` | Build server binary (Linux)                                              |
| `go build -tags otel .`                                   | Build with OpenTelemetry SDK (requires `go get` first — see Phase B)     |
| `go build -tags wazero .`                                 | Build with Wazero plugin runtime (requires `go get` first — see Phase C) |
| `go test ./...`                                           | Run all server tests                                                     |
| `go test ./... -cover`                                    | Run server tests with coverage                                           |
| `go test -race ./...`                                     | Run server tests with race detection                                     |

**Make targets** (run from `Server/`):

| Command                  | Description                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `make test`              | Run the test suite the way CI does (`-race`, 20 min timeout)                       |
| `make test-deadlock`     | Run the deadlock-detection pass CI also runs (`-tags deadlock`)                    |
| `make cover`             | Per-package coverage (what CI uploads) + a function summary                        |
| `make cover-all`         | Cross-package coverage — the honest number (also lists 0.0% functions)             |
| `make sqlc-install`      | Install the pinned sqlc version into `$GOBIN`                                      |
| `make sqlc-generate`     | Regenerate the type-safe Go query layer (`db/dbgen/`, SQLite engine)               |
| `make sqlc-verify`       | Fail if the committed `dbgen` output is stale (used by CI)                         |
| `make protocol-generate` | Regenerate the WS message-type constants (Go + TS) from `protocol/schema.json`     |
| `make protocol-verify`   | Fail if the committed protocol constants are stale (used by CI)                    |
| `make otel-up`           | Start Jaeger (traces) + Prometheus (metrics) via Docker for local OTel development |
| `make otel-down`         | Stop and remove the OTel dev containers                                            |

#### Client (Tauri v2)

**Build & dev**

| Command                 | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `npm run dev`           | Start Vite dev server with hot reload (alias for `dev:desktop`)           |
| `npm run dev:desktop`   | Vite dev server with the Tauri overlay (`vite.config.desktop.ts`)         |
| `npm run build`         | TypeScript check + Vite production build (alias for `build:desktop`)      |
| `npm run build:desktop` | TypeScript check + production build of the Tauri target                   |
| `npm run build:budget`  | Scratch `--manifest` build into `dist-budget/` (input to `check:budgets`) |
| `npm run check:budgets` | Bundle budget gate — gzip sizes vs `bundle-budgets.json`, fails closed    |
| `npm run tauri dev`     | Launch Tauri app in dev mode                                              |
| `npm run tauri build`   | Build release installer (NSIS on Windows, AppImage+deb on Linux)          |

**Linux native voice build prerequisite.** The Linux client links LiveKit's
Rust SDK (`livekit`), whose `webrtc-sys` crate compiles C++ against Chromium's
hermetic libc++ and therefore needs **clang >= 21** plus a prebuilt
**libwebrtc** (~148 MB download, ~800 MB extracted). GCC is refused. Run the
installer in each shell you build from, before any Linux Rust build (`cargo
test`, `cargo clippy`, `tauri build`):

```bash
eval "$(Client/scripts/linux-webrtc-toolchain.sh)"
```

It installs clang-21 from apt.llvm.org (once, system-wide), downloads
libwebrtc once into `~/.cache/owncord-linux-webrtc`, and prints the
environment (`CC`, `CXX`, `LK_CUSTOM_WEBRTC`) for the current shell only, so a
new terminal needs the `eval` again. In CI it writes them to `$GITHUB_ENV`;
ci.yml caches the libwebrtc directory, and clang is installed fresh each run. Windows client builds and
server-only work need none of this. Design and rationale:
[docs/architecture/voice-e2ee.md](architecture/voice-e2ee.md); the phase that
ships the user-visible voice path is a separate change.

**Tests**

| Command                    | Description                            |
| -------------------------- | -------------------------------------- |
| `npm test`                 | Run all tests (vitest)                 |
| `npm run test:unit`        | Unit tests only                        |
| `npm run test:integration` | Integration tests only                 |
| `npm run test:contract`    | Cross-component contract tests only    |
| `npm run test:e2e`         | Playwright E2E (mocked Tauri)          |
| `npm run test:e2e:native`  | Playwright E2E (real Tauri exe + CDP)  |
| `npm run test:e2e:admin`   | Playwright E2E (real Go server + SPA)  |
| `npm run test:e2e:prod`    | Playwright E2E (prod build)            |
| `npm run test:e2e:ui`      | Playwright UI mode                     |
| `npm run test:watch`       | Vitest watch mode                      |
| `npm run test:coverage`    | Coverage report                        |
| `npm run test:mutate`      | Stryker mutation testing               |
| `npm run test:mutate:dry`  | Stryker dry-run (no mutations applied) |
| `npm run test:browser`     | Vitest browser-mode tests              |

PR CI runs only the narrow mutation subset (`Client/stryker.ci.config.mjs`,
`src/lib/permissions.ts`). The full-client mutation baseline
(`src/lib/**` + `src/stores/**`, 76 files / 12 387 mutants) is the sharded
`mutation` job in `.github/workflows/nightly-test-depth.yml`, driven locally
with `cd Client && STRYKER_SHARD=<livekit|audio-media|transport-auth|lib-rest|stores>
npx stryker run stryker.shard.config.mjs`. `Client/scripts/check-mutation-shards.mjs`
proves the shard union still equals the configured surface. The measured score
is recorded in `docs/plans/b7-8-mutation-baseline-*.md`.

**Type checking, linting & formatting**

| Command                   | Description                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `npm run typecheck`       | Full typecheck (all sources)                                   |
| `npm run typecheck:build` | Typecheck build config only                                    |
| `npm run lint`            | oxlint (warnings denied) + import cycles + ESLint check (src/) |
| `npm run lint:fix`        | ESLint auto-fix                                                |
| `npm run lint:ox`         | oxlint only; fails on any warning under `Client/src/`          |
| `npm run format`          | Prettier format (src/ + tests/)                                |
| `npm run format:check`    | Prettier check only (no writes)                                |
| `npm run knip`            | Dead code and unused export detection                          |

### Git hooks (recommended)

Committed hooks in `.githooks/` catch the most common CI failures locally. Enable once per clone (from the repo root):

```bash
npm run hooks:install    # = git config core.hooksPath .githooks
```

| Hook         | What it runs                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | gofmt + `go vet` (when Go files staged), oxlint (warnings denied under `Client/src/`) + prettier + `tsc --noEmit` (when client TS staged), `sqlc-verify` / `protocol-verify` (when their inputs staged) |
| `pre-push`   | Server build in all build-tag variants, client typecheck + type-aware ESLint. Set `OWNCORD_PREPUSH_TESTS=1` to also run `go test -race ./...`                                                           |

Bypass with `--no-verify` or `OWNCORD_SKIP_HOOKS=1` when needed — CI still enforces everything.

Neither hook needs `make`, and neither needs Node for the Go checks.

**`core.hooksPath` is exclusive.** Once set, Git resolves every hook against
`.githooks/` and never looks in `.git/hooks/` again. `.githooks/` holds only
`pre-commit` and `pre-push`, so `hooks:install` silently disables any other
hook you installed there (`post-commit`, `post-checkout`, ...). Nothing warns
you. Put it under `.githooks/` instead (untracked, so it stays yours), or skip
`hooks:install` and use `npm run check` before pushing.

## Plugin Development

Plugins are WASM modules loaded at runtime when the server is built with `-tags wazero`.

> **The plugin ABI is experimental and carries no compatibility promise.** The
> subsystem is disabled twice over — it compiles only under `-tags wazero`
> (`Server/plugin/sandbox_default.go`), and `plugins.enabled` defaults to
> `false` (`Server/config/config.go`) — and the five exported functions may
> change or be removed in any release without a deprecation period.

See [`Server/plugin/examples/hello/README.md`](../Server/plugin/examples/hello/README.md)
for the ABI, the build command, and the pinned TinyGo/Go/Binaryen versions. That
file is the single source of truth for the plugin toolchain — this page used to
carry a second copy of the version table, and the two had already drifted apart
in wording.

The example's `.wasm` is not checked in: TinyGo embeds absolute host paths from
the building machine and offers no `-trimpath`, so its output is not
byte-reproducible and no CI job can verify it. Build it locally from the source
beside it.

---

## Reporting problems, and where things go

Bugs, questions and vulnerabilities have three different destinations, and the
difference matters most for the third.

| Kind                            | Where                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A reproducible bug              | [Issues](https://github.com/J3vb/OwnCord/issues/new/choose) — the form asks for the environment detail needed to reproduce it |
| A question about setup or usage | [Discussions → Q&A](https://github.com/J3vb/OwnCord/discussions/categories/q-a)                                               |
| An idea or feature suggestion   | [Discussions → Ideas](https://github.com/J3vb/OwnCord/discussions/categories/ideas) — not an issue                            |
| A security vulnerability        | [Private advisory](https://github.com/J3vb/OwnCord/security/advisories/new)                                                   |

### Security reporting

**Never open a public issue, pull request, or discussion for a security bug.**
Use [private security reporting](https://github.com/J3vb/OwnCord/security/advisories/new);
[SECURITY.md](../SECURITY.md) is the canonical policy and states the response
timeline, and [docs/security.md](security.md) says what stays private and for
how long.

This repository is public, so a commit message, a PR description and a branch
name are all disclosure channels. If you are fixing something you believe is a
security problem, say so in the private advisory first and let the fix be
coordinated — do not describe the weakness in the public change that repairs it.
The same applies to weaknesses in the repository's own automation and settings,
not only to bugs in the server or client.

## Branch and PR model

This section is the single source of truth for the branch model. Everywhere
else -- the root `README.md`, `CLAUDE.md`, the PR template -- summarises it and
links here rather than restating it.

- `dev` -- the integration branch. **All contributions target `dev`.**
- `main` -- releases only. `dev` is merged to `main` for a release, and release
  tags are cut from `main`.

`dev` is protected and PR-only: direct pushes are rejected, fifteen status checks
are required, `required_approving_review_count` is 0, and the rule is enforced
on admins. So a PR is self-mergeable once CI is green, but no commit reaches
`dev` without CI having run on it. Settings and rationale live in
[`docs/plans/b0-dev-branch-protection.sh`](plans/b0-dev-branch-protection.sh).

Three consequences worth knowing before you open a PR:

- The Docker and Tauri Full Build jobs are gated on `main` and report as
  _skipped_ on a PR into `dev`. That is expected, not a failure.
- Which of the remaining jobs run is chosen from your diff, and **only on a PR
  into `dev`**. A plan or prose change runs neither the server legs nor the
  browser suites; a change to `.github/`, `scripts/`, a lockfile, or any path
  the classifier has not been taught runs everything. The rules — and the
  cross-boundary dependencies behind them, such as the two `docs/architecture`
  files a Go test reads — are in
  [`scripts/ci-select.mjs`](../scripts/ci-select.mjs), and its unit suite runs
  in the Repository Hygiene check. To see what your branch selects:

  ```bash
  git diff --name-status -M origin/dev...HEAD > "$TMPDIR/changed-paths.txt"
  node scripts/ci-select.mjs --paths-file "$TMPDIR/changed-paths.txt"
  ```

  A PR into `main` always runs every job, because release evidence requires each
  required check to have concluded `success` on the tagged commit, so a
  legitimately skipped check would block the release instead of saving anything.

- Squash merge, and a conventional commit subject on the squashed commit.

## Branch Naming

- `feature/<name>` -- new features
- `fix/<name>` -- bug fixes
- `docs/<name>` -- documentation changes

## Commit Format

Use conventional commits:

```text
feat: add thread support to channels
fix: prevent duplicate WebSocket connections
refactor: extract permission checks into middleware
docs: update quick-start guide
test: add integration tests for invite flow
chore: bump Go dependencies
perf: cache role permissions in memory
ci: add lint step to GitHub Actions
```

For anything non-trivial the body carries the reasoning, not a restatement of
the diff: what was wrong, why the obvious fix is wrong, what was done, concrete
numbers, and a `Verified:` paragraph proving both directions — that the defect
was present before and is absent after.

End with an explicit **`Not included:`** line naming adjacent scope you
deliberately left out, and why. A written deferral is a deliverable: it is what
separates considered-and-declined from silently-missed, and it means adjacent
work you spotted mid-change does not have to become either scope creep or a
blocking question. Put it in the commit that noticed it.

## Pull Request Process

See [Branch and PR model](#branch-and-pr-model) above for what to branch from
and target.

1. Branch from `dev`
2. Open the PR against `dev`
3. All fifteen required checks must pass -- `dev` is protected, so a red PR cannot
   merge
4. Request code review
5. Squash merge, conventional commit subject

If your change is one an operator would notice, add a `CHANGELOG.md` entry under
`## Unreleased`. That file's **"How to write an entry"** section is the rule, and
it is not optional styling: scannable lists grouped by user-facing area, one line
per fix, what was broken then what it does now. No walls of text, no `OC-*` ids,
no file paths.

## Testing

The client suite enforces a **90% statement** floor plus 70% branch, function
and line thresholds in `vitest.config.ts`, mirrored by
`Client/coverage-floor.json`.
The Go suite has floors too, since B3-6: `Server/coverage-floor.json` names an
aggregate and a per-package floor for the five core packages (`ws`, `service`,
`permissions`, `auth`, `db`), and `Server/scripts/coverage-floor.sh` enforces
them on the ubuntu leg of Server Build & Test. It fails closed — an empty or
unparseable profile exits 2 rather than passing. A PR that raises coverage
ratchets the file in the same PR; the ratchet rule is in `Server/CLAUDE.md`.
Use `make cover-all` to see the honest cross-package number. Follow a
test-driven workflow and never lower a threshold to make a change fit.

### Tiers

| Tier                         | Command                      | CI job                               | Blocking |
| ---------------------------- | ---------------------------- | ------------------------------------ | -------- |
| `Client/tests/unit`          | `npm run test:unit`          | Client Unit Tests                    | yes      |
| `Client/tests/integration`   | `npm run test:integration`   | Client Unit Tests                    | yes      |
| `Client/tests/contract`      | `npm run test:contract`      | Client Unit Tests                    | yes      |
| `Client/tests/browser`       | `npm run test:browser`       | Client E2E (Playwright)              | yes      |
| `Client/tests/e2e`           | `npm run test:e2e`           | Client E2E (Playwright)              | yes      |
| `Client/tests/e2e` @parity   | —                            | Client E2E (parity subset, blocking) | yes      |
| `Client/tests/e2e/native`    | `npm run test:e2e:native`    | Client E2E (Windows native)          | yes      |
| `Client/tests/e2e/admin`     | `npm run test:e2e:admin`     | Admin Panel E2E (real server)        | yes      |
| `Client/tests/e2e/fullstack` | `npm run test:e2e:fullstack` | Client E2E (real server and media)   | yes      |
| `Server/**/*_test.go`        | `make test`                  | Server Build & Test                  | yes      |
| `Client/src-tauri`           | `cargo test --lib`           | Rust Unit Tests                      | yes      |

`npm test` — not `npm run test:unit` — is the suite that covers
`tests/contract`. CI runs it as `vitest run --coverage`, and
`npm run check:client` invokes the same thing through `npm run test:coverage`.

### What belongs in `tests/contract`

A test is a **contract test** when its assertions read, import or execute an
artifact owned by a _different top-level component_ (`Server/`, `Client/`, root
`protocol/`) than the one its runner lives in. A comment referencing the other
side does not count.

1. **Placement follows capability, not ownership.** A contract test lives in the
   tier whose runtime can execute or parse the artifact. If the owning component
   can execute it, it stays in that component's own suite —
   `Server/updater/tauri_key_contract_test.go` reads
   `Client/src-tauri/tauri.conf.json` and stays in Go, because Go parses JSON
   fine and the assertion is about a server constant.
2. **Ownership is declared in the name, never in the directory.** The file name
   and the top-level `describe`/`Test` name must name the owned artifact's path.
3. **A contract test may only live in a blocking tier.** A non-blocking job is
   not coverage. Blocking means the tier's CI job is in the required-contexts
   list of `dev`'s branch protection, recorded in
   `docs/plans/b0-dev-branch-protection.sh` — a hard-failing job in
   `.github/workflows/ci.yml` that is missing from that list still gates
   nothing. Every tier above is in it; `Admin Panel E2E (real server)`, the
   real-media and the Windows native jobs graduated in #1563.
4. `Client/` is one component: its TypeScript frontend and its thin Rust backend
   in `src-tauri/` are the same side of the boundary, so a `tests/unit` test that
   reads `src-tauri/tauri.conf.json` is an ordinary unit test. The same goes for a
   Go test reading its own package's embedded assets
   (`Server/admin/perm_grid_test.go`).

E2E is _runtime_ coupling rather than artifact coupling; it stays in `tests/e2e`.

If a tier ever gains a runner of its own, model its anti-vacuity guard on
`Server/invariants/invariants_test.go` — it fails loudly when a configured scope
resolves to nothing, rather than passing on an empty set.

## Code Style

- **TypeScript**: See [Client Architecture](architecture/client.md)
- **Go**: `gofmt` + `golangci-lint`, standard library preferred
- **Rust**: `cargo fmt` + `cargo clippy`, minimal code (native APIs only)

## Dependency Policy

The policy behind what the lockfiles already enforce (decided 2026-08-05,
closing audit findings 2026-04-07 #8 / DC-11):

- **Lockfiles are authoritative.** `package-lock.json`, `go.sum` and
  `Cargo.lock` pin every transitive dependency; CI installs only from them
  (`npm ci`, module/registry verification — never a bare `npm install` in CI
  or hooks). `package.json` keeps ordinary caret ranges: exact-pinning it
  would duplicate what the lockfile does while making every security patch a
  manual edit.
- **Upgrades arrive as reviewed PRs, not ambient drift.** Dependabot runs
  weekly per ecosystem (`.github/dependabot.yml`) with semver-major updates
  ignored across the board — majors are adopted deliberately, by a human,
  reading the changelog. Peer-coupled groups (`vitest`/`@vitest/*`,
  `@stryker-mutator/*`) update as one PR so exact peer pins cannot wedge.
- **Security gates run on every PR:** `npm audit --omit=dev
--audit-level=high` (shipped deps only — dev-tooling advisories are
  triaged in the workflow comment instead of blocking on unfixable pins),
  `govulncheck` for Go, `cargo audit` for Rust, and `knip` refuses unused
  client dependencies outright.
- **Version skew is pinned at the toolchain level** too: `Client/.nvmrc`, every
  `actions/setup-node` in CI, and an `engines` block in all three
  `package.json` files say Node 26 — with `engine-strict=true` in each
  package's `.npmrc`, so a different major fails the install instead of
  warning. Three things keep them from drifting apart: `Client/.nvmrc` is the
  single source of truth, `node scripts/check-node-policy.mjs` fails the
  Repository Hygiene job when any other statement disagrees with it, and the
  `node-policy` CI job installs a wrong major on purpose to prove all three
  roots really do refuse it.
  `Server/sqlc.version` pins sqlc, Go pins via `go.mod` (`GOTOOLCHAIN=auto`),
  and GitHub Actions are SHA-pinned with Dependabot bumping the pins. The one
  deliberate exception is the plugin toolchain: TinyGo and Binaryen are
  _documented_ rather than file-pinned, because no gate installs them and
  nothing would read the pin — the example plugin's README is their single
  source of truth.
- **Three package roots, not an npm workspace** — measured 2026-08-26 (npm
  11.17, Node 26), not decided on principle. Making `/`, `/Client` and
  `/tools/mcp-introspect` npm workspaces buys one 298 KB lockfile instead of
  three (17 KB / 253 KB / 42 KB) and dedupes 614 resolved packages to 582 — 32
  packages, 5.2%. Client install time is unchanged: 5642 ms against 5667 ms.
  The things you would expect to break do not: `npm ci` inside `Client/` still
  exits 0, `npm run <script>` still resolves the hoisted binaries (npm prepends
  every ancestor `node_modules/.bin` to `PATH`), and `engine-strict` still
  fails the install on a wrong Node major. The costs that are real:
  - Ten CI steps key on `cache-dependency-path: Client/package-lock.json` —
    six in `ci.yml`, four in the tag-only, CI-ungated `release.yml`. That file
    stops existing, and four of the ten have no gate that would catch it.
  - Repository Hygiene installs root-only on purpose (prettier is all it
    needs). Under workspaces that grows 970 ms → 6172 ms and 39 → 318
    packages, unless every call site gains `--workspaces=false` — the
    mitigation works (1112 ms, 38 packages) but has to be remembered forever.
  - One lockfile puts all three npm Dependabot groups back into the same file.
    They rewrite three disjoint files today; undoing that reinstates the
    merge-then-rebase-then-re-run-CI storm the grouping comment at the top of
    `.github/dependabot.yml` exists to prevent.

  Thirty-two deduped packages does not pay for that. The roots stay separate,
  `npm run bootstrap` installs all three, and Dependabot covers all three.
