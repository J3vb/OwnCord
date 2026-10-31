# Contributing

This page is for developers who want to change OwnCord. It covers the tools you
need, the commands you run, how branches and pull requests work, how a release
is cut, and the rules for tests and dependencies.

## Where things live

One row per top-level folder. Each folder with its own README or `CLAUDE.md`
has more detail there.

| Folder                            | What it is                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Server/](../Server/README.md)    | Go REST and WebSocket server over SQLite, with LiveKit voice. Has a package map.                                                                       |
| [Client/](../Client/README.md)    | Tauri v2 desktop app: TypeScript frontend and a thin Rust backend.                                                                                     |
| [protocol/](../protocol/)         | `schema.json`, the source of truth for WebSocket message types. Generated code comes from it.                                                          |
| [deploy/](../deploy/)             | Deployment files: the systemd unit, the Unraid template and the local tracing and metrics stack (`docker/`).                                           |
| [docs/](README.md)                | Guides, reference pages, architecture notes, dated audits and plans. Start at the index.                                                               |
| [scripts/](../scripts/)           | Repository checks, the root command runner (`run.mjs`) and the CI selector.                                                                            |
| [tools/](../tools/)               | Developer tools: the [introspection MCP server](mcp-introspect.md).                                                                                    |
| [.github/](../.github/)           | CI workflows, issue forms and the pull request template.                                                                                               |
| [.githooks/](../.githooks/)       | Git hooks. See [Git hooks](#git-hooks-recommended).                                                                                                    |
| `.claude/`, `.codex/`, `.agents/` | Setup for AI coding agents, plus `.no-mistakes.yaml`. Human contributors can ignore these. The rules in `AGENTS.md` and `CLAUDE.md` apply to everyone. |
| [.superpowers/](../.superpowers/) | The shared bug-hunt findings ledger and its renderer.                                                                                                  |

## Starting a change

Find the owner below before following dependencies. The checks are starting
points for iteration, not a replacement for the full [testing requirements](#testing)
or required CI checks.

| Task                               | Start here                                                                                                                                                                           | Find the relevant checks                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Server REST or WebSocket behaviour | [api/](../Server/api/), [ws/](../Server/ws/), then the owning [service/](../Server/service/)                                                                                         | Tests beside the Go package; see [Server commands](#server-go).                                                                                                                      |
| Desktop UI or feature behaviour    | [features/](../Client/src/features/), [components/](../Client/src/components/), [pages/](../Client/src/pages/); use the [client architecture](architecture/client.md) for ownership. | Client unit/integration tests and the feature's browser or E2E tests; see [Client commands](#client-tauri-v2).                                                                       |
| Native desktop behaviour           | [src-tauri/src/](../Client/src-tauri/src/) and its caller in [platform/desktop/](../Client/src/platform/desktop/)                                                                    | Rust tests plus the relevant native E2E suite. Check platform-specific code on its target OS.                                                                                        |
| Server admin panel                 | [admin/static/js/](../Server/admin/static/js/); action registration is in [core.js](../Server/admin/static/js/core.js).                                                              | Server admin tests, Client contract tests and admin E2E; see [contract ownership](#what-belongs-in-testscontract). The tests are in `Client/` and need Node 26 and its dependencies. |
| Database query or schema           | Hand-written [queries/](../Server/db/queries/) or a new [migration](../Server/migrations/); sqlc output is generated.                                                                | Regeneration/drift checks, migration tests and the consuming service tests.                                                                                                          |
| WebSocket message-type constants   | [protocol/schema.json](../protocol/schema.json), then the Go and TypeScript consumers                                                                                                | Protocol regeneration/drift checks and the affected server/client tests. The schema generates constants, not complete payload definitions.                                           |
| Check, build or CI behaviour       | [run.mjs](../scripts/run.mjs), [ci-select.mjs](../scripts/ci-select.mjs) and the affected [workflow](../.github/workflows/)                                                          | Adjacent script tests and the affected gate. Cross-component inputs can select checks outside the changed folder.                                                                    |

From the repository root, `node scripts/run.mjs --list` prints the existing
check commands and their working directories. Server-only contributors can
use the [Go commands directly](#server-go) without Node.

For a failure, keep the command, working directory, failing test and relevant
error together; use the full log when the excerpt is insufficient. A skipped
tool or a platform you could not exercise is a verification limitation, not
a passing check.

## Development Setup

### Prerequisites

| Platform        | Server | Client       |
| --------------- | ------ | ------------ |
| Windows 10+ x64 | ✅     | ✅           |
| Linux x64       | ✅     | ✅           |
| Linux ARM64     | ✅     | ✅ (CI only) |

- **Go 1.27** for the server. `Server/go.mod` sets `go 1.27.0` and pins the
  toolchain to `go1.27.3`. With `GOTOOLCHAIN=auto` (Go's default), Go downloads
  that toolchain for you.
- **Node.js 26 and npm 11** for the client and the root scripts.
  `Client/.nvmrc` is the source of truth.
  - Each `package.json` has an `engines` block, and each package's `.npmrc`
    sets `engine-strict=true`. So `npm ci` fails on a different major version.
  - `node scripts/checks/check-node-policy.mjs` fails the Repository Hygiene job when
    any other place states a different version.
- **Rust 1.98.1** for the Tauri client, with `clippy` and `rustfmt`.
  `Client/src-tauri/rust-toolchain.toml` pins it, and rustup installs it for
  you. You do not need Rust for server-only work.
- **Docker with Compose v2** is optional. It is an alternative to building the
  server yourself.

### Available Commands

#### Root commands (one entry point)

Run these from the repository root. They call the per-stack commands listed
further down. They are a convenience, not a replacement. None of them needs
`make`, and they work the same on Windows, macOS and Linux.

| Command                       | What it does                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run bootstrap`           | `npm ci` in all three package roots                                                                             |
| `npm run check`               | CI's static, unit and drift gates for docs, hygiene, server, client and Rust                                    |
| `npm run check:server`        | Server only: four build variants, vet, race tests, deadlock pass, lint, generated-output drift                  |
| `npm run check:client`        | Client only: typecheck, lint, knip, mutation-shard check, quarantine check, tests with coverage, bundle budgets |
| `npm run check:rust`          | Tauri backend: `cargo fmt --check`, `cargo test --lib` and clippy                                               |
| `npm run check:docs`          | Doc counts and citations, the migrations check, and the findings ledger render                                  |
| `npm run check:hygiene`       | Prettier, shellcheck, actionlint and the script self-tests the Repository Hygiene job runs                      |
| `npm run format`              | Prettier over the whole repository, `gofmt -w` over the server, `cargo fmt` over the Rust code                  |
| `npm run generate`            | Regenerate protocol constants, the sqlc query layer, and the generated doc blocks                               |
| `npm run release:preflight`   | `check`, plus a client production build                                                                         |
| `node scripts/run.mjs --list` | Print the exact command every task runs, and where                                                              |

`npm run check` does not run the Playwright suites, `govulncheck`, `npm audit`
or the coverage-floor scripts. CI runs those.

Some tools CI installs may be missing on your machine: `golangci-lint`, `sqlc`,
`shellcheck`, `actionlint` and `gofmt`. The root commands skip them and print
why, instead of failing.

**Working on the server only? You never need Node.** Each root command prints
the command it runs and the folder it runs in. Those are the commands in the
next section, and running them directly is just as correct.

#### Server (Go)

Run these from `Server/`.

| Command                                                   | What it does                            |
| --------------------------------------------------------- | --------------------------------------- |
| `go build -o chatserver.exe -ldflags "-s -w" .`           | Build the server binary (Windows)       |
| `CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w" .` | Build the server binary (Linux)         |
| `go build -tags otel .`                                   | Build with the OpenTelemetry SDK        |
| `go build -tags wazero .`                                 | Build with the Wazero plugin runtime    |
| `go test ./...`                                           | Run all server tests                    |
| `go test ./... -cover`                                    | Run server tests with coverage          |
| `go test -race ./...`                                     | Run server tests with the race detector |

**Make targets** (run from `Server/`):

| Command                  | What it does                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `make test`              | Run the tests the way CI does (`-race`, 20 minute timeout)                         |
| `make test-deadlock`     | Run the deadlock-detection pass CI also runs (`-tags deadlock`)                    |
| `make fuzz`              | Fuzz every `Fuzz*` target, one at a time (local only, 30 s each by default)        |
| `make sim`               | Long run of the seeded hub simulation (20 seeds at 10,000 steps)                   |
| `make bench-baseline`    | Record the benchmark baseline (local only, never gated)                            |
| `make cover`             | Per-package coverage (what CI uploads) and a function summary                      |
| `make cover-all`         | Cross-package coverage, the honest number. Also lists 0.0% functions               |
| `make sqlc-install`      | Install the pinned sqlc version into `$GOBIN`                                      |
| `make sqlc-generate`     | Regenerate the Go query layer in `db/dbgen/`                                       |
| `make sqlc-verify`       | Fail if the committed `db/dbgen/` output is stale (used by CI)                     |
| `make protocol-generate` | Regenerate the WebSocket message constants (Go and TS) from `protocol/schema.json` |
| `make protocol-verify`   | Fail if the committed protocol constants are stale (used by CI)                    |
| `make docs-generate`     | Regenerate the `gendocs` blocks in `docs/`                                         |
| `make docs-verify`       | Fail if the generated doc blocks are stale                                         |
| `make otel-up`           | Start Jaeger (traces) and Prometheus (metrics) in Docker for OTel work             |
| `make otel-down`         | Stop and remove those OTel containers                                              |

#### Client (Tauri v2)

Run these from `Client/`.

**Build and dev**

| Command                      | What it does                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                | Start the Vite dev server with hot reload (alias for `dev:desktop`)                                                    |
| `npm run dev:desktop`        | Vite dev server with the Tauri overlay (`vite.config.desktop.ts`)                                                      |
| `npm run build`              | TypeScript check and Vite production build (alias for `build:desktop`)                                                 |
| `npm run build:desktop`      | TypeScript check and production build of the Tauri target                                                              |
| `npm run build:budget`       | Scratch `--manifest` build into `dist-budget/` (input to `check:budgets`)                                              |
| `npm run check:budgets`      | Bundle budget gate: gzip sizes against `bundle-budgets.json`                                                           |
| `npm run preview`            | Serve the production build with `vite preview`                                                                         |
| `npm run tauri dev`          | Launch the Tauri app in dev mode                                                                                       |
| `npm run tauri build`        | Build the release installer (NSIS on Windows, AppImage and deb on Linux)                                               |
| `npm run screenshots:readme` | Retake the three README images in `.github/images/` from a real server with demo data (about 3 minutes; not run by CI) |

**Linux build prerequisite: native voice.** The Linux client links LiveKit's
Rust SDK (`livekit`). Its `webrtc-sys` crate compiles C++ against Chromium's
own libc++. So it needs **clang 21 or newer** and a prebuilt **libwebrtc**
(about 148 MB to download, about 800 MB unpacked). GCC does not work.

Run this in each shell you build from, before any Linux Rust build
(`cargo test`, `cargo clippy`, `tauri build`):

```bash
eval "$(Client/scripts/linux-webrtc-toolchain.sh)"
```

How the script finds a compiler:

1. If `CC` and `CXX` are both set, it uses them. Both must be clang 21 or newer,
   or it stops with an error.
2. Otherwise it uses an installed `clang++-21`, or a `clang++` that reports
   version 21 or newer.
3. Only if neither exists does it install clang-21 from apt.llvm.org. It does
   this once, system-wide, and only on the Debian and Ubuntu releases
   apt.llvm.org publishes. Elsewhere, install clang 21 or newer yourself.

It downloads libwebrtc and the CUDA headers (for NVIDIA hardware H.264) once
into `~/.cache/owncord-linux-webrtc`. After pulling this change, run
`cargo clean -p webrtc-sys` once so the crate rebuilds with them. It prints the
settings (`CC`, `CXX`, `LK_CUSTOM_WEBRTC`) for the current shell only, so a new
terminal needs the `eval` again. In CI it writes them to `$GITHUB_ENV`. CI
caches the libwebrtc folder and installs clang fresh on each run.

Windows client builds and server-only work need none of this. Design and
reasons: [docs/architecture/voice-e2ee.md](architecture/voice-e2ee.md).

**Linux build prerequisite: camera.** The Linux client captures the camera
with GStreamer (`src-tauri/src/native_voice/camera.rs`). So a Linux Rust build
also needs the GStreamer development headers:

```bash
sudo apt-get install -y libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev
```

The GStreamer runtime libraries already come with WebKitGTK. The `.deb`
declares them and the camera plugins, and the AppImage bundles its own. Only
the `-dev` headers are an extra build-time need. They matter only on the same
Linux Rust builds that compile `webrtc-sys`. Every CI Linux job that builds the
client installs them, and `scripts/checks/check-workflow-guards.mjs` fails a workflow
whose Tauri build step leaves them out.

**Tests**

| Command                         | What it does                                              |
| ------------------------------- | --------------------------------------------------------- |
| `npm test`                      | Run all vitest tests (unit, integration and contract)     |
| `npm run test:unit`             | Unit tests only                                           |
| `npm run test:integration`      | Integration tests only                                    |
| `npm run test:contract`         | Cross-component contract tests only                       |
| `npm run test:coverage`         | All vitest tests with a coverage report                   |
| `npm run test:watch`            | Vitest watch mode                                         |
| `npm run test:browser`          | Vitest browser-mode tests                                 |
| `npm run test:e2e`              | Playwright E2E, full suite (mocked Tauri)                 |
| `npm run test:e2e:smoke`        | Playwright smoke subset (mocked Tauri)                    |
| `npm run test:e2e:prod`         | Playwright E2E against a production build                 |
| `npm run test:e2e:ui`           | Playwright UI mode                                        |
| `npm run test:e2e:admin`        | Playwright E2E against a real Go server and the admin SPA |
| `npm run test:e2e:fullstack`    | Playwright E2E against a real server and real media       |
| `npm run test:e2e:soak`         | Long-session soak against a real server (about an hour)   |
| `npm run test:e2e:native`       | Playwright E2E against the real Tauri exe over CDP        |
| `npm run test:e2e:native-voice` | Linux native-voice interop against a local LiveKit server |
| `npm run test:e2e:artifact`     | Installed release artifact smoke (CI only)                |
| `npm run test:e2e:build-server` | Build the Go server the real-server suites use            |
| `npm run test:mutate`           | Stryker mutation testing                                  |
| `npm run test:mutate:dry`       | Stryker dry run (no mutations applied)                    |

**Mutation testing in CI.**

- **On a PR:** CI runs a narrow mutation check on `src/lib/permissions.ts`
  (`Client/tests/mutation/stryker.ci.config.mjs`). It is a step in Client Static Checks. It
  runs only when a PR touches that file, its unit test or the Stryker configs.
- **Nightly:** the full client baseline is the sharded `mutation` job in
  `.github/workflows/nightly-test-depth.yml`. It covers the base config's
  surface, 179 files today. To run one shard locally:

  ```bash
  cd Client
  STRYKER_SHARD=<livekit|audio-media|transport-auth|lib-rest|stores|safety-moderation> \
    npx stryker run tests/mutation/stryker.shard.config.mjs
  ```

- `Client/scripts/check-mutation-shards.mjs` proves the shards together still
  cover the whole surface. It runs in Client Static Checks on every PR, so a
  new file cannot sit outside every shard until the nightly fails.
- The measured score is recorded in `docs/archive/plans/b7-8-mutation-baseline-*.md`.

**Type checking and linting**

| Command                     | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `npm run typecheck`         | Full typecheck (all sources)                                            |
| `npm run typecheck:build`   | Typecheck the build config only                                         |
| `npm run typecheck:e2e`     | Typecheck the E2E tests (`tsconfig.e2e.json`)                           |
| `npm run check:admin-types` | Check the Server-owned admin panel (`checkJs`, shrink-only baseline)    |
| `npm run lint`              | oxlint (warnings denied), the import-cycle check, then ESLint on `src/` |
| `npm run lint:fix`          | ESLint auto-fix                                                         |
| `npm run lint:ox`           | oxlint only. Any warning under `Client/src/` fails                      |
| `npm run lint:cycles`       | Import-cycle check only                                                 |
| `npm run knip`              | Find dead code and unused exports                                       |

The client has no format script of its own. Prettier is set up once at the
repository root, so run `npm run format` from the root.

#### Android

The Android app is the same client and Rust crate, built by Tauri into an APK.
The Gradle project is committed under `Client/src-tauri/gen/android/`; edit it
there (the manifest, `app/build.gradle.kts`), never regenerate it with
`tauri android init`, which would overwrite those edits.

- **Get an APK:** every PR that touches the client source or the Rust shell
  runs the `Android APK` job in CI. It builds a signed arm64 APK and uploads it
  as the `owncord-android-<sha>` artifact (kept 14 days) on the run's Summary
  page. Runs from a fork or from Dependabot have no signing secrets, so they
  build an unsigned APK as a compile check and upload nothing.
- **Local development:** JDK 17, the Android SDK with an NDK, `ANDROID_HOME`
  and `NDK_HOME` set, and `rustup target add aarch64-linux-android` (add
  `x86_64-linux-android` for an emulator). Then `npx tauri android dev` from
  `Client/` runs the app on an emulator or a USB-connected phone against the
  vite dev server. Debug builds allow plain http so the phone can reach it.
- **Release builds** are signed in CI only, with a keystore kept in repository
  secrets. Never build a release APK locally for distribution, and never commit
  a keystore or `keystore.properties` (both are gitignored). `release.yml`'s
  `release-client-android` job publishes `OwnCord_<v>_arm64.apk` and its
  updater `.sig` on every release; the keystore must never change, or
  installed apps can no longer take an update.
- **Updates:** the app asks its server's client-update endpoint for the
  `android-aarch64-apk` target, checks the `.sig` with the desktop updater
  key, and opens Android's package installer
  (`update_commands/android.rs` and `ApkInstallerPlugin.kt`). Android always
  shows its own Install prompt for an app installed outside a store.
- **Rust:** code that only exists on desktop (tray, unread badge, window
  helpers, game detection) is behind `#[cfg(desktop)]`. CI runs
  `cargo clippy --target aarch64-linux-android -- -D warnings`, so an item that
  is only used from desktop code needs the same gate.

### Git hooks (recommended)

The hooks in `.githooks/` catch the most common CI failures on your machine.
Turn them on once per clone, from the repository root:

```bash
npm run hooks:install    # runs: git config core.hooksPath .githooks
```

It also registers the findings-ledger merge driver (`scripts/merge-ledger.mjs`,
named in `.gitattributes`), so merging `dev` into a branch that added ledger
entries keeps both sides' entries instead of conflicting. If both sides took the
same new id, the branch's entry is renumbered and the driver prints the rename.

**`pre-commit`** looks only at staged files:

- Go files staged: `gofmt` and `go vet`.
- sqlc inputs staged: checks that `db/dbgen/` is up to date.
- `protocol/schema.json` staged: checks the generated protocol constants.
- Server routes, migrations or config staged: checks the generated doc blocks.
- Findings ledger staged: validates it.
- Any file staged: Prettier, when the root `node_modules` exists.
- Client TypeScript staged: oxlint (warnings denied under `Client/src/`) and
  `tsc --noEmit`.

**`pre-push`** compares your branch with `origin/dev` or `origin/main`,
whichever is nearer. It skips Markdown-only changes.

- Server changed: builds all four build-tag variants. Set
  `OWNCORD_PREPUSH_TESTS=1` to also run `go test -race ./...`.
- Client changed: client typecheck and type-aware ESLint.

To skip a hook, use `--no-verify` or set `OWNCORD_SKIP_HOOKS=1`. CI still
checks everything.

Neither hook needs `make`, and neither needs Node for the Go checks.

**`core.hooksPath` replaces your other hooks.** Once it is set, Git looks for
every hook in `.githooks/` and never in `.git/hooks/`. `.githooks/` has only
`pre-commit` and `pre-push`. So `hooks:install` silently turns off any other
hook you had in `.git/hooks/` (`post-commit`, `post-checkout`, and so on).
Nothing warns you. Either move that hook into `.githooks/` (it stays untracked,
so it stays yours), or skip `hooks:install` and run `npm run check` before you
push.

## Plugin Development

Plugins are WASM modules. The server loads them at runtime when it is built
with `-tags wazero`.

> **The plugin ABI is experimental and has no compatibility promise.** The
> plugin system is off in two ways. It compiles only under `-tags wazero`
> (`Server/plugin/sandbox_default.go`). And `plugins.enabled` defaults to
> `false` (`Server/config/config.go`). The five exported functions may change
> or disappear in any release, with no deprecation period.

[`Server/plugin/examples/hello/README.md`](../Server/plugin/examples/hello/README.md)
covers the ABI, the build command, and the pinned TinyGo, Go and Binaryen
versions. That file is the only place the plugin toolchain versions are kept.

The example's `.wasm` is not checked in. TinyGo writes absolute paths from the
build machine into its output and has no `-trimpath`. So two builds never
match byte for byte, and no CI job can verify one. Build it locally from the
source next to it.

---

## Reporting problems, and where things go

Bugs, questions, ideas and security problems each go to a different place.
The difference matters most for security problems.

| Kind                            | Where                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A bug you can reproduce         | [Issues](https://github.com/J3vb/OwnCord/issues/new/choose). The form asks for the details needed to reproduce it |
| A question about setup or usage | [Discussions → Q&A](https://github.com/J3vb/OwnCord/discussions/categories/q-a)                                   |
| An idea or feature suggestion   | [Discussions → Ideas](https://github.com/J3vb/OwnCord/discussions/categories/ideas), not an issue                 |
| A security vulnerability        | [Private advisory](https://github.com/J3vb/OwnCord/security/advisories/new)                                       |

### Security reporting

**Never open a public issue, pull request or discussion for a security bug.**
Use [private security reporting](https://github.com/J3vb/OwnCord/security/advisories/new).

- [SECURITY.md](../SECURITY.md) is the main policy. It gives the response
  timeline.
- [docs/security.md](security.md) says what stays private, and for how long.

This repository is public. A commit message, a PR description and a branch
name can all reveal a weakness. If you are fixing something you think is a
security problem, report it in a private advisory first and let the fix be
coordinated. Do not describe the weakness in the public change that fixes it.
This also applies to weaknesses in the repository's own automation and
settings, not only to bugs in the server or client.

## Branch and PR model

This section is the one source of truth for the branch model. The root
`README.md`, `CLAUDE.md` and the PR template summarise it and link here.

- `dev` is the integration branch. **All contributions target `dev`.**
- `main` is for releases only. `dev` is merged into `main` for a release, and
  release tags are cut from `main`.

`dev` is protected, and changes reach it only through pull requests:

- Direct pushes are rejected.
- Seventeen status checks must pass.
- No approving review is required (`required_approving_review_count` is 0).
- The rules apply to admins too.

So you can merge your own PR once CI is green, but no commit reaches `dev`
without CI running on it. The settings and the reasons for them are in
[`docs/plans/b0-dev-branch-protection.sh`](plans/b0-dev-branch-protection.sh).
That script records the intended settings. Editing it does not change GitHub.

Three things to know before you open a PR:

- **Some jobs are skipped on a PR into `dev`.** The Server Docker Build and
  Tauri Full Build jobs run only for `main`. On a PR into `dev` they show as
  _skipped_. That is expected, not a failure.
- **Which other jobs run depends on your diff, but only on a PR into `dev`.**
  A plan or prose change runs neither the server jobs nor the browser suites.
  A change to `.github/`, `scripts/`, a lockfile, or any path the selector does
  not know runs everything. The rules, and the cross-boundary links behind
  them, are in [`scripts/ci-select.mjs`](../scripts/ci-select.mjs). Its unit
  tests run in the Repository Hygiene check. To see what your branch selects:

  ```bash
  git diff --name-status -M origin/dev...HEAD > "$TMPDIR/changed-paths.txt"
  node scripts/ci-select.mjs --paths-file "$TMPDIR/changed-paths.txt"
  ```

  The file must hold `git diff --name-status` lines. A bare list of paths reads
  as no paths, and an empty or unreadable diff or an unknown path selects
  every capability. The selector prints one name per line; this is what each
  name runs:

  | Name          | CI job(s) it gates                                                                         | Run it locally                                                           | Covered by `npm run check`?                                      |
  | ------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
  | `server`      | Server Lint & Invariants; the steps of Server Build & Test (ubuntu-latest, windows-latest) | `npm run check:server`                                                   | Yes, except the optional `golangci-lint` and `sqlc`; one OS only |
  | `client`      | Client Static Checks; Client Unit Tests; Node policy (refused major)                       | `npm run check:client`                                                   | Mostly. Not run: the npm security audit and `typecheck:e2e`      |
  | `rust`        | Rust Unit Tests                                                                            | `npm run check:rust`                                                     | Yes, on your OS only. Linux also needs the WebRTC toolchain      |
  | `browser`     | Client E2E (Playwright); Client E2E (parity subset, blocking)                              | In `Client/`: `npm run test:e2e:smoke`, `test:browser`, `test:e2e:prod`  | No                                                               |
  | `integration` | Client E2E (real server and media); Admin Panel E2E (real server)                          | In `Client/`: `npm run test:e2e:fullstack`, `npm run test:e2e:admin`     | No                                                               |
  | `native`      | Client E2E (Windows native)                                                                | Windows only: `npm run test:e2e:native` in `Client/` after a Tauri build | No. No local equivalent off Windows                              |
  | `webclient`   | Client E2E (web portal, non-blocking)                                                      | In `Client/`: `npm run test:e2e:web`                                     | No                                                               |
  | `workflows`   | Workflow Security Lint                                                                     | `zizmor --offline .github/workflows/`                                    | No. `actionlint` runs in `check:hygiene` if installed            |
  | `deps`        | Supply-chain Scan                                                                          | `osv-scanner` and `cargo deny`; see `osv-scanner.toml`                   | No                                                               |
  | `permissions` | The "Permissions mutation hotspot" step of Client Static Checks                            | In `Client/`: `npx stryker run tests/mutation/stryker.ci.config.mjs`     | No                                                               |
  | `changelog`   | The "Changelog gate" step of Server Build & Test (ubuntu-latest); Server Lint & Invariants | In `Server/`: `go test -count=1 -run TestBundledChangelog ./admin/`      | Yes, as part of `check:server`                                   |

  Docs & Ledger Consistency and Repository Hygiene always run. A skipped
  optional tool is a verification limitation, not a pass: `run.mjs` names it
  at the end of the task.

  A PR into `main` always runs every job. Release evidence needs every
  required check to pass on the tagged commit, so a skipped check would block
  the release. A **push to `dev`** also runs every job. That push is the
  squash-merged tree, and it catches two PRs that are green alone but red
  together. While a `dev` → `main` release PR is open, a push to `dev` runs the
  suite twice, once for the push and once for the PR update. That is accepted
  for that short window.

- **Squash merge**, with a conventional commit subject on the squashed commit.

## Release procedure

This is the end-to-end procedure for cutting a release. Every step runs on
`main` or against it. The order matters, because the release workflow
(`release.yml`) stops on any missing input. In the examples below,
`vX.Y.Z` stands for the version you are releasing. From 2.5.0 on, versions
carry no `-beta.N` suffix: a release with new features bumps the minor number,
a fixes-only release bumps the patch number. The project is still a beta; the
release notes say so.

1. **Reconcile `main` into `dev` first, if the last release was squashed.**
   A release PR that was squash-merged makes `dev` and `main` drift apart. You
   can tell because `git merge-tree origin/main origin/dev` reports conflicts.
   Fix it with a real merge commit that has `main` as a parent, not a squash.
   Earlier examples: #1425 and #1809.

2. **Set the same version in the three client manifests.**
   - `Client/src-tauri/tauri.conf.json` (`version`)
   - `Client/package.json` (`version`)
   - `Client/src-tauri/Cargo.toml` (`version`)

   `release.yml`'s `verify-versions` job compares each one with the tag. Any
   mismatch fails the whole run. Make this edit at release time, not earlier.

3. **Write the release notes under the tag heading in `CHANGELOG.md`.**
   `release.yml` finds the `## vX.Y.Z` heading (a title may follow the
   tag) and copies everything up to the next `## ` heading. If that section is
   missing or empty, it stops the publish. Normally you rename
   `## Unreleased` to the tag, then start a fresh `## Unreleased` above it.

   **This section becomes the GitHub release page, word for word.** Nothing
   rewrites it, so write it for end users:
   - one short paragraph saying what this release gives them;
   - then **Highlights**, **Added**, **Changed**, **Fixed** and
     **Known issues**, in plain language, without walls of PR numbers;
   - internal, CI and test-only changes in a short **Under the hood** list at
     the end.

   The "How to write an entry" rules in `CHANGELOG.md` still apply. One early
   beta's release page had to be rewritten after publishing because its
   section was internal prose. This step stops that from happening again.

   **Record the release in [`docs/STATUS.md`](STATUS.md)** in the same PR.
   Update "Current release" and add a row to its Releases table.
   `release.yml`'s `release-status` job refuses a version with no row there.
   Docs & Ledger Consistency also fails a PR whose client version has no row.

4. **Update user-facing status text if it changed.** If the release changes
   what platforms are published or the project stage, update the platform
   table in `docs/quick-start.md` and the status wording in the README badge
   and text, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md` and `docs/summaries/product.md`. The
   hobby-project disclaimer stays.

5. **Open the release PR from `dev` into `main`.** Every CI job runs on a PR
   into `main`, because a skipped check would block the release. This is the
   first full Tauri build of the frozen tree.

6. **Merge the release PR with a merge commit.** Squash-merging `dev` into
   `main` causes the drift from step 1 at every release. A merge commit keeps
   `dev` and `main` sharing history. Squash is still the rule for PRs into
   `dev`.

7. **Run the Linux checklist and check the nightly, then tag on `main`.** Cut the tag (`vX.Y.Z`) on
   the merge commit.
   - The release ruleset forbids deleting a tag. So a failed first run costs
     you the next version number, not a rewrite.
   - The release is a **full release**, not a pre-release. `gh release create`
     runs without `--prerelease`, so existing servers' `/releases/latest`
     updater still sees it.
   - Before tagging, check that the latest nightly `upgrade-rehearsal.yml` run
     is green. `release.yml`'s `nightly-drills` job refuses the release if the
     latest scheduled run is not `success` or is more than 72 hours old. The
     release's own rehearsal skips the failure and recovery drills, so the
     nightly is the only place they run.
   - Before tagging, the [Linux release checklist](linux-release-checklist.md)
     must pass on all three sessions: X11, GNOME Wayland (48 or newer) and KDE
     Plasma Wayland. If any item fails on any session, do not tag. Keep the
     filled-in tables with the release PR.
   - Emergency override: set the `RELEASE_ALLOW_RED_NIGHTLY` repository
     variable to `true` before tagging, and remove it afterwards. A dry run
     uses the `allow_red_nightly` input instead. The job then passes with a
     warning. Only scheduled runs count, so after a fix for a red nightly
     merges, wait for the next nightly rather than using the override.

8. **Approve the two `environment: release` stops.** The
   `release-server-docker` and `publish` jobs each wait for the required
   reviewer. Record who approved and when. Nothing is pushed to `ghcr.io` or
   published until both pass.

9. **Verify the published files from another machine.** Run the
   [Verifying a Download](deployment.md#verifying-a-download) commands from a
   machine that is not the CI runner: checksums, minisign on the server
   files, and `gh attestation verify` for the files and the container image.
   - The Windows client installers are **unsigned**. Code signing was declined
     for the beta. So first launch shows the SmartScreen "Windows protected
     your PC" prompt, and the quick-start note covers it for users.
   - The server files and every provenance and SBOM attestation are still
     signed and must verify.

Two rules are easy to get wrong, so they are written down here on purpose:

- `dev` → `main` release PRs use a **merge commit** (step 6).
- The release is a **full release, not a pre-release** (step 7).

A major version bump does not change protocol compatibility. Compatibility is
keyed on `protocol_epoch` in `protocol/schema.json` (still **1**), never on the
version string. So a `2.x` client speaks the same epoch as the
`1.2.0-alpha.*` releases, and the epoch-1 fixtures keep replaying.

Background: the merge-commit and full-release rules are owner decisions D-13
and D-14, and the unsigned installers are decision D-08.

### README screenshots

Before a release that changes what the app looks like, retake the README
images on the frozen `dev` head with `npm run screenshots:readme` (from
`Client/`) and land them in a PR to `dev` before the release PR. The run starts
a real server in a temporary folder, seeds a demo community through the normal
HTTP and WebSocket routes, and writes `Client.png`, `loginpage.png` and
`Admin_Panel.png` at 1440x900 in the default dark theme.

### Update signing keys

The desktop app and the server use separate update signing keys. A release
needs these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`

To rotate the server update key, update
[Server/updater/server_update_public_key.txt](../Server/updater/server_update_public_key.txt).
Roll it over in stages so running servers keep accepting updates.

## Branch Naming

- `feature/<name>` for new features
- `fix/<name>` for bug fixes
- `docs/<name>` for documentation changes

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

For anything non-trivial, the body explains the reasoning. Do not just repeat
the diff. Cover:

- what was wrong;
- why the obvious fix is wrong;
- what you did, with concrete numbers;
- a `Verified:` paragraph that proves both directions: the defect was there
  before, and it is gone after.

A change made by an agent with no human watching (the `bughunt-fix` workflow,
a routine, a CI-triggered session) also includes the pre-flight parts that
[CLAUDE.md](../CLAUDE.md#ai-quality-guardrails--engineering-standards) asks for:
the affected files, the state mutations, and the two edge cases it handled and
tested. In an interactive session those were agreed before work started. In an
unattended one, the commit body or PR description is where a reviewer sees
what was assumed.

End with a **`Not included:`** line. Name the nearby work you chose to leave
out, and why. A written deferral is useful work. It shows the gap was
considered, not missed. It also means work you spot mid-change does not have
to become either scope creep or a blocking question. Put it in the commit that
noticed it.

## Pull Request Process

See [Branch and PR model](#branch-and-pr-model) above for which branch to start
from and target.

1. Branch from `dev`.
2. Open the PR against `dev`.
3. All seventeen required checks must pass. `dev` is protected, so a red PR
   cannot merge.
4. Ask for a code review.
5. Squash merge, with a conventional commit subject.

If an operator would notice your change, add a `CHANGELOG.md` entry under
`## Unreleased`. Follow that file's **"How to write an entry"** section. It is
a rule, not a style tip: short lists grouped by user-facing area, one line per
fix, saying what was broken and what it does now. No walls of text, no `OC-*`
ids, no file paths.

## Testing

**Coverage floors.** Never lower a floor to make a change fit.

- **Client:** `Client/coverage-floor.json` sets the aggregate statement floor,
  **93%** today. `vitest.config.ts` reads it as its statement threshold, and
  adds 70% thresholds for branches, functions and lines.
  `Client/scripts/coverage-floor.sh` checks the same floor in CI.
- **Server:** `Server/coverage-floor.json` sets an aggregate floor and a floor
  for each of five core packages (`ws`, `service`, `permissions`, `auth`,
  `db`). `Server/scripts/coverage-floor.sh` checks them on the Linux leg of
  Server Build & Test. It fails closed: an empty or unreadable profile exits 2
  instead of passing.
- A PR that raises coverage also raises the floor in the same PR. The rule is
  in `Server/CLAUDE.md`. Use `make cover-all` to see the honest cross-package
  number.

Write tests first where you can.

### Tiers

| Tier                              | Command                         | CI job                                                                             | Blocks merge?          |
| --------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| `Client/tests/unit`               | `npm run test:unit`             | Client Unit Tests                                                                  | yes                    |
| `Client/tests/integration`        | `npm run test:integration`      | Client Unit Tests                                                                  | yes                    |
| `Client/tests/contract`           | `npm run test:contract`         | Client Unit Tests                                                                  | yes                    |
| `Client/tests/browser`            | `npm run test:browser`          | Client E2E (Playwright)                                                            | yes                    |
| `Client/tests/e2e`                | `npm run test:e2e`              | Client E2E (Playwright)                                                            | yes                    |
| `Client/tests/e2e` (prod build)   | `npm run test:e2e:prod`         | Client E2E (parity subset, blocking)                                               | yes                    |
| `Client/tests/e2e/native`         | `npm run test:e2e:native`       | Client E2E (Windows native)                                                        | yes                    |
| `Client/tests/e2e/native-voice`   | `npm run test:e2e:native-voice` | Rust Unit Tests                                                                    | yes                    |
| `Client/tests/e2e/artifact-smoke` | `npm run test:e2e:artifact`     | Desktop Artifact Smoke (`client-artifact-smoke.yml`, nightly and before `publish`) | no (gates the release) |
| `Client/tests/e2e/admin`          | `npm run test:e2e:admin`        | Admin Panel E2E (real server)                                                      | yes                    |
| `Client/tests/e2e/fullstack`      | `npm run test:e2e:fullstack`    | Client E2E (real server and media)                                                 | yes                    |
| `Server/**/*_test.go`             | `make test`                     | Server Build & Test                                                                | yes                    |
| `Client/src-tauri`                | `cargo test --lib`              | Rust Unit Tests                                                                    | yes                    |

On a PR, Client E2E (Playwright) always runs the smaller smoke set
(`npm run test:e2e:smoke`) against the Vite dev server. The full suite runs in
Client E2E (parity subset) against the production bundle.

`npm test`, not `npm run test:unit`, is the command that includes
`tests/contract`. CI runs it as `vitest run --coverage`, and
`npm run check:client` runs the same thing through `npm run test:coverage`.

### What belongs in `tests/contract`

A test is a **contract test** when its assertions read, import or run a file
owned by a _different top-level component_ (`Server/`, `Client/`, root
`protocol/`) from the one its test runner lives in. A comment that mentions
the other side does not count.

1. **Placement follows what can run it, not who owns it.** A contract test
   lives in the tier whose runtime can run or parse the file. If the owning
   component can run it, it stays in that component's own suite. For example,
   `Server/updater/tauri_key_contract_test.go` reads
   `Client/src-tauri/tauri.conf.json` and stays in Go. Go parses JSON fine, and
   the assertion is about a server constant.
2. **Ownership is shown in the name, never in the folder.** The file name and
   the top-level `describe` or `Test` name must name the owned file's path.
3. **A contract test may only live in a blocking tier.** A non-blocking job is
   not coverage. Blocking means the tier's CI job is in the required checks
   for `dev`, recorded in `docs/plans/b0-dev-branch-protection.sh`. A job in
   `.github/workflows/ci.yml` that fails hard but is not on that list still
   blocks nothing. Every tier marked "yes" above is on it. The admin, real-media
   and Windows native jobs joined the list in #1563.
4. **`Client/` is one component.** Its TypeScript frontend and its thin Rust
   backend in `src-tauri/` are the same side of the boundary. So a
   `tests/unit` test that reads `src-tauri/tauri.conf.json` is an ordinary unit
   test. The same goes for a Go test that reads its own package's embedded
   files (`Server/admin/perm_grid_test.go`).

E2E tests couple at runtime, not through files, so they stay in `tests/e2e`.

If a tier ever gets its own runner, copy the empty-scope guard in
`Server/invariants/invariants_test.go`. It fails loudly when a configured
scope matches nothing, instead of passing on an empty set.

For what makes a good regression test, and the full list of local and CI test
lanes, see [testing-behavior.md](testing-behavior.md).

## Code Style

The full rules, and the tool that enforces each one, are in
[code-style.md](code-style.md). In short:

- **TypeScript:** Prettier, ESLint, oxlint and knip. Layout:
  [Client Architecture](architecture/client.md).
- **Go:** `gofmt` and `golangci-lint`. Prefer the standard library.
- **Rust:** `cargo fmt` and `cargo clippy`. Keep the backend small and use
  native APIs only.

## Dependency Policy

These rules sit behind what the lockfiles already enforce. They were decided
on 2026-08-05.

- **Lockfiles are the authority.** `package-lock.json`, `go.sum` and
  `Cargo.lock` pin every transitive dependency. CI installs only from them
  (`npm ci`, and module or registry verification). Never use a bare
  `npm install` in CI or hooks. `package.json` keeps normal caret ranges.
  Pinning exact versions there would repeat the lockfile's job and turn every
  security patch into a manual edit.
- **Upgrades arrive as reviewed PRs, not silent drift.** Dependabot runs
  weekly for each ecosystem and package root (`.github/dependabot.yml`).
  - Each one opens a single grouped PR, so families with exact peer pins
    (such as `vitest` and `@vitest/*`, or `@stryker-mutator/*`) move together.
  - Major version updates are ignored everywhere. A human adopts a major
    deliberately, after reading the changelog.
  - `target-branch: dev` covers version updates only. Dependabot _security_
    updates always open against the default branch (`main`). Before you close
    one, open a matching PR against `dev` and track it. The weekly grouped
    update ignores majors and some packages, so it may never ship the fix.
- **Security checks run in CI** when the matching part of the repository
  changes:
  - `npm audit --omit=dev --audit-level=high` in Client Static Checks. It
    covers shipped dependencies only. Dev-tool advisories are triaged in the
    workflow comment instead of blocking on pins that cannot be fixed.
  - `govulncheck` for Go, in Server Build & Test.
  - `osv-scanner` over every lockfile and `cargo-deny` for Rust, in the
    Supply-chain Scan job, when a manifest or lockfile changes.
  - `cargo audit` for Rust, in Tauri Full Build, on PRs into `main`.
  - `knip` refuses unused client dependencies.
- **Tool versions are pinned too.**
  - Node: `Client/.nvmrc`, every `actions/setup-node` in CI, and an `engines`
    block in all three `package.json` files say Node 26. Each package's
    `.npmrc` sets `engine-strict=true`, so a different major fails the install
    instead of warning.
  - Three things stop those Node statements drifting apart. `Client/.nvmrc` is
    the single source of truth. `node scripts/checks/check-node-policy.mjs` fails the
    Repository Hygiene job when another statement disagrees. And the
    `node-policy` CI job installs a wrong major on purpose to prove all three
    roots refuse it.
  - `Server/sqlc.version` pins sqlc. Go is pinned by `go.mod`
    (`GOTOOLCHAIN=auto`). Rust is pinned by
    `Client/src-tauri/rust-toolchain.toml`. GitHub Actions are pinned by
    commit SHA, and Dependabot bumps the pins.
  - The one deliberate exception is the plugin toolchain. TinyGo and Binaryen
    are _documented_ rather than pinned in a file, because no check installs
    them and nothing would read the pin. The example plugin's README is their
    single source of truth.
- **Three package roots, not an npm workspace.** This was measured on
  2026-08-26 (npm 11.17, Node 26), not decided on principle. Turning `/`,
  `/Client` and `/tools/mcp-introspect` into npm workspaces would give one
  298 KB lockfile instead of three (17 KB, 253 KB and 42 KB). It would dedupe
  614 resolved packages to 582, a saving of 32 packages (5.2%). Client install
  time would not change (5642 ms against 5667 ms).

  The things you might expect to break do not. `npm ci` inside `Client/` still
  works. `npm run <script>` still finds the hoisted binaries, because npm adds
  every parent `node_modules/.bin` to `PATH`. And `engine-strict` still fails
  the install on a wrong Node major.

  The real costs:
  - Twelve CI steps key their cache on `Client/package-lock.json` (nine in
    `ci.yml`, three in `nightly-test-depth.yml`). That file would stop
    existing.
  - Repository Hygiene installs only the root packages on purpose, because
    Prettier is all it needs. Under workspaces that install grew from 970 ms
    to 6172 ms and from 39 to 318 packages, unless every call adds
    `--workspaces=false`. That fix works (1112 ms, 38 packages), but everyone
    would have to remember it forever.
  - One lockfile would put all three npm Dependabot groups back into the same
    file. Today they rewrite three separate files. Merging them would bring
    back the merge, rebase, re-run-CI churn that the grouping comment at the
    top of `.github/dependabot.yml` exists to prevent.

  Saving 32 packages does not pay for that. The roots stay separate,
  `npm run bootstrap` installs all three, and Dependabot covers all three.

Background: the dependency policy closed audit findings 2026-04-07 #8 and
DC-11.
