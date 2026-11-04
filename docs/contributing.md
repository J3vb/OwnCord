# Contributing

Thanks for wanting to change OwnCord. This page gets you from a fresh clone
to a merged pull request. Every command and rule in full is in the
[contributor reference](contributing-reference.md). Cutting a release is in the
[maintainer guide](maintainers.md).

## Where things live

| Folder                            | What it is                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| [Server/](../Server/README.md)    | The Go server: chat, the API and voice, over SQLite.                      |
| [Client/](../Client/README.md)    | The desktop app (Tauri v2): a TypeScript front end and a small Rust part. |
| [protocol/](../protocol/)         | `schema.json`, the list of WebSocket messages. Code is generated from it. |
| [deploy/](../deploy/)             | The systemd unit, the Unraid template and a local metrics stack.          |
| [docs/](README.md)                | Guides and reference pages. Start at the index.                           |
| [scripts/](../scripts/)           | Repository checks and the root command runner.                            |
| [tools/](../tools/)               | Developer tools.                                                          |
| [.github/](../.github/)           | CI workflows, issue forms and the pull request template.                  |
| [.githooks/](../.githooks/)       | Git hooks. See [Git hooks](#git-hooks).                                   |
| `.claude/`, `.codex/`, `.agents/` | Setup for AI coding agents. You can ignore these.                         |
| [.superpowers/](../.superpowers/) | The shared list of bugs found in bug hunts.                               |

## Starting a change

Find the part you want to change, then the tests that cover it.

| You want to change                 | Start in                                                                                                  | Tests                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Server REST or WebSocket behaviour | [api/](../Server/api/), [ws/](../Server/ws/), then [service/](../Server/service/)                         | Tests beside the Go package: [Server (Go)](#server-go)  |
| The desktop app's screens          | [features/](../Client/src/features/); [client architecture](architecture/client.md) says who owns what    | Client tests: [Client (Tauri v2)](#client-tauri-v2)     |
| Native desktop behaviour           | [src-tauri/src/](../Client/src-tauri/src/) and [platform/desktop/](../Client/src/platform/desktop/)       | Rust tests. Check it on the system it is for.           |
| The server's admin panel           | [admin/static/js/](../Server/admin/static/js/)                                                            | Server admin tests and the admin tests in `Client/`     |
| A database query or table          | [queries/](../Server/db/queries/) or a new [migration](../Server/migrations/). Never edit generated code. | The regenerate check and the service tests              |
| A WebSocket message type           | [protocol/schema.json](../protocol/schema.json), then regenerate                                          | The regenerate check and the server and client tests    |
| A check, a build or CI             | [scripts/](../scripts/) and [.github/workflows/](../.github/workflows/)                                   | The script's own tests. These changes run every CI job. |

**Never hand-edit generated code.** CI fails when it drifts, and the next
regenerate throws your edit away. The generated folders and how to regenerate
them are listed in the root [CLAUDE.md](../CLAUDE.md#generated-code--never-hand-edit).

When something fails and you ask for help, include the command, the folder you
ran it in and the error. A check you could not run is something to mention,
not a pass.

## Development setup

### Prerequisites

| System          | Server | Desktop app   |
| --------------- | ------ | ------------- |
| Windows 10+ x64 | Yes    | Yes           |
| Linux x64       | Yes    | Yes           |
| Linux ARM64     | Yes    | Yes (CI only) |

- **Go 1.27** for the server. Go downloads the exact version for you.
- **Node.js 26 and npm 11** for the desktop app and the root scripts. Another
  major version is refused on install.
- **Rust** for the desktop app. rustup installs the right version for you. You
  do not need Rust for server-only work.
- **Docker** is optional.

Building the desktop app **on Linux** needs two extras: clang 21 and a prebuilt
WebRTC library for voice, and the GStreamer headers for the camera. One script
sets up the first. Run it in each terminal you build from:

```bash
eval "$(Client/scripts/linux-webrtc-toolchain.sh)"
sudo apt-get install -y libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev
```

Details: [Linux build prerequisites](contributing-reference.md#client-tauri-v2).
Windows builds and server-only work need none of this.

### Available Commands

From the repository root. They work the same on Windows, macOS and Linux.

| Command                       | What it does                                     |
| ----------------------------- | ------------------------------------------------ |
| `npm run bootstrap`           | Install everything                               |
| `npm run check`               | Run the checks CI runs, for the whole repository |
| `npm run check:server`        | The server checks only                           |
| `npm run check:client`        | The desktop app checks only                      |
| `npm run check:rust`          | The Rust checks only                             |
| `npm run format`              | Format everything                                |
| `npm run generate`            | Regenerate all generated code and doc blocks     |
| `node scripts/run.mjs --list` | Show the exact command each task runs, and where |

`npm run check` skips the browser test suites and a few security scans. CI
runs those. A tool you do not have installed is skipped with a note.

#### Server (Go)

You never need Node for server work. From `Server/`:

| Command              | What it does                               |
| -------------------- | ------------------------------------------ |
| `go build .`         | Build the server                           |
| `make test`          | Run the tests the way CI does              |
| `make test-deadlock` | The deadlock-detection pass CI also runs   |
| `make sqlc-generate` | Regenerate the database code               |
| `make docs-generate` | Regenerate the generated parts of the docs |

Every make target: [Server commands](contributing-reference.md#server-go).

#### Client (Tauri v2)

From `Client/`:

| Command               | What it does                                 |
| --------------------- | -------------------------------------------- |
| `npm run tauri dev`   | Run the desktop app with live reload         |
| `npm run tauri build` | Build the installer                          |
| `npm test`            | Run the unit, integration and contract tests |
| `npm run test:e2e`    | Run the browser tests                        |
| `npm run typecheck`   | Check the types                              |
| `npm run lint`        | Run the linters                              |

Every script, mutation testing and the Android build:
[Client commands](contributing-reference.md#client-tauri-v2).

### Git hooks

The hooks catch the most common CI failures before you push. Turn them on once
per clone:

```bash
npm run hooks:install
```

Before a commit they format and check the files you staged. Before a push they
build what you changed. Skip them with `--no-verify`; CI still checks
everything.

**This turns off any other git hooks you had in `.git/hooks/`.** Move those
into `.githooks/`, or skip this and run `npm run check` before you push.
Details: [Git hooks](contributing-reference.md#git-hooks-recommended).

## Reporting problems

| Kind                            | Where                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| A bug you can reproduce         | [Issues](https://github.com/J3vb/OwnCord/issues/new/choose)                             |
| A question about setup or usage | [Discussions → Q&A](https://github.com/J3vb/OwnCord/discussions/categories/q-a)         |
| An idea                         | [Discussions → Ideas](https://github.com/J3vb/OwnCord/discussions/categories/ideas)     |
| A security problem              | [Private report](https://github.com/J3vb/OwnCord/security/advisories/new), never public |

### Security reporting

**Never open a public issue, pull request or discussion for a security bug.**
This repository is public, so a commit message, a PR description or a branch
name can give a weakness away. Report it
[privately](https://github.com/J3vb/OwnCord/security/advisories/new) first, and
let the fix be coordinated. The fix itself says what changed, never what was
weak. That includes problems in the repository's own CI and settings.
The policy: [SECURITY.md](../SECURITY.md).

## Branch and PR model

- **Branch from `dev`, and open your pull request against `dev`.** `dev` is
  where all work comes together.
- `main` only holds releases. A release merges `dev` into `main`.

`dev` only takes pull requests. The required checks must pass, but no review
approval is needed, so you can merge your own PR once CI is green.

Good to know:

- **Some CI jobs show as "skipped" on a PR into `dev`.** The Docker and full
  desktop builds only run for `main`. That is expected.
- **CI runs only the jobs your change needs.** A docs change skips the server
  and browser tests. A change to CI, scripts or a lockfile runs everything. How
  to see what your branch will run:
  [How CI picks its jobs](contributing-reference.md#how-ci-picks-its-jobs).
- **Squash merge**, with a conventional commit subject.

### Branch Naming

- `feature/<name>` for new features
- `fix/<name>` for bug fixes
- `docs/<name>` for documentation

## Commit Format

Use conventional commits:

```text
feat: add thread support to channels
fix: prevent duplicate WebSocket connections
docs: update quick-start guide
```

Other prefixes: `refactor`, `test`, `chore`, `perf`, `ci`.

For anything more than a small change, the body explains why:

- what was wrong;
- why the obvious fix is wrong, if it is;
- what you did, with numbers where you have them;
- a `Verified:` paragraph showing the problem was there before and is gone
  after.

End with a **`Not included:`** line naming nearby work you chose to leave out,
and why. It shows the gap was seen, not missed.

A change made by an AI agent with no person watching also lists the files it
changed, the state it writes and the two edge cases it tested, as the root
[CLAUDE.md](../CLAUDE.md#ai-quality-guardrails--engineering-standards) asks.

## Pull Request Process

1. Branch from `dev`.
2. Open the PR against `dev`.
3. Wait for the required checks to pass.
4. Ask for a review if you want one.
5. Squash merge, with a conventional commit subject.

If a server owner or user would notice your change, add a line to
`CHANGELOG.md` under `## Unreleased`. Follow that file's "How to write an
entry": short, plain, one line per fix, no ids and no file paths.

## Testing

- **Write tests first where you can.**
- **Never lower a coverage floor** to make a change fit. A PR that raises
  coverage raises the floor too.
- **Never make a failing test pass by weakening it.**
- `npm test` in `Client/` and `make test` in `Server/` cover most changes. The
  browser and real-server suites run in CI.

Which tests run where, and which block a merge:
[Testing in detail](contributing-reference.md#testing-in-detail). What makes a
good regression test: [testing-behavior.md](testing-behavior.md).

### What belongs in `tests/contract`

A contract test reads or runs a file from another part of the repository
(`Server/`, `Client/` or `protocol/`). It lives with whichever side can run
it, and its name says which file it checks. The full rules:
[Contract tests](contributing-reference.md#what-belongs-in-testscontract).

## Code Style

The full rules are in [code-style.md](code-style.md). In short:

- **TypeScript:** Prettier, ESLint, oxlint and knip. No `any`.
- **Go:** `gofmt` and `golangci-lint`. Wrap errors with `%w`. Prefer the
  standard library.
- **Rust:** `cargo fmt` and `cargo clippy`. Keep the Rust side small.

## Dependency Policy

- **The lockfiles decide versions.** CI installs only from them.
- **Upgrades come as reviewed PRs.** Dependabot opens one grouped PR a week
  per ecosystem. Major versions are always updated by hand, after reading the
  changelog.
- **Security scans run in CI** when dependencies change.
- **Tool versions are pinned** (Node, Go, Rust, sqlc, GitHub Actions).

The details, and why there are three npm package roots instead of a
workspace: [Dependency policy in detail](contributing-reference.md#dependency-policy-in-detail).

## Plugin Development

Plugins are WASM modules, and the plugin system is **experimental**: off by
default, and it may change in any release with no warning. How to build one:
[the example plugin](../Server/plugin/examples/hello/README.md).

## Release procedure

Releases are cut by the maintainer. The steps are in the
[maintainer guide](maintainers.md#release-procedure).
