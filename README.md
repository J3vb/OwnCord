[![CI](https://github.com/J3vb/OwnCord/actions/workflows/ci.yml/badge.svg)](https://github.com/J3vb/OwnCord/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/J3vb/OwnCord?include_prereleases&label=release)](https://github.com/J3vb/OwnCord/releases/latest)
![Status](https://img.shields.io/badge/status-beta-orange)
![Go](https://img.shields.io/badge/go-1.27%2B-00ADD8?logo=go&logoColor=white)
![Tauri](https://img.shields.io/badge/tauri-v2-24C8DB?logo=tauri&logoColor=white)
![Platforms](https://img.shields.io/badge/platforms-Windows%20x64%20%7C%20Windows%20ARM64%20%7C%20Linux%20x64%20%7C%20Linux%20ARM64-informational)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

# OwnCord

OwnCord is a self-hosted chat app I build for me and my friends. It has text
channels, voice and video, and a server you own.

> **Beta, and a hobby project.**
> I build this for fun and run it for a small group of friends. It is not a
> product. There is no support promise, and it is not production-ready. Expect
> rough edges, fast changes and the odd breaking change.
>
> Do not use it for anything sensitive.

OwnCord has two parts:

- a **Go server**, which you run on a spare computer or a VPS
- a **desktop app**, built with Tauri, which your friends install

You start the server, give your friends an invite code, and that is it.

<p align="center">
  <img src=".github/images/Client.png" alt="OwnCord Client" width="700">
</p>

<p align="center">
  <img src=".github/images/loginpage.png" alt="Login Page" width="340">
  <img src=".github/images/Admin_Panel.png" alt="Admin Panel" width="340">
</p>

## Start here

| I want to…                              | Read                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| Get a server running quickly            | [docs/quick-start.md](docs/quick-start.md)             |
| Run the server on Linux with Docker     | [docs/deployment.md](docs/deployment.md)               |
| Let friends connect without router work | [docs/tailscale.md](docs/tailscale.md)                 |
| Open ports on my router myself          | [docs/port-forwarding.md](docs/port-forwarding.md)     |
| Know what the beta does not do          | [docs/known-limitations.md](docs/known-limitations.md) |
| Find any other document                 | [docs/README.md](docs/README.md)                       |

## What works today

| Area            | Status          |
| --------------- | --------------- |
| Text chat       | Working in beta |
| Voice and video | Working in beta |
| Admin panel     | Working in beta |

Security is reviewed in regular passes. Each review is a dated audit, listed in
[docs/README.md](docs/README.md#audits).

## Features

- **Chat.** Real-time channels and direct messages, with saved history and
  per-channel message retention.
- **Voice and video.** Runs on [LiveKit](https://livekit.io). The server can
  download and run LiveKit for you. Call media is end-to-end encrypted, and
  you can check another person's security key.
- **Who can join.** Four registration modes: `closed`, `invite`, `approval`
  and `open`. Invite codes and role-based permissions.
- **Moderation.** Reports, appeals, warnings and timeouts, the Moderation
  Center, Message Requests and NSFW handling.
- **Admin panel.** A web page for logs, backups, retention, the audit log and
  updates.
- **Files.** Uploads and inline images and video. The app asks before it loads
  content from other websites.
- **Accounts.** Two-factor sign-in (TOTP) with backup codes, a recovery kit you
  keep yourself, and rate limits on sign-in.
- **Devices.** Sign in on several devices. The desktop app keeps saved
  credentials in the system keyring.
- **Updates.** The desktop app updates itself and checks each update's
  signature first.
- **Plugins (experimental).** WASM plugins can add slash commands. They are
  off by default and not in release builds. To try them, build with
  `-tags wazero` and set `plugins.enabled`.
- **GIF picker.** Off by default. Each server uses its own
  [Klipy](https://partner.klipy.com) key, set with `gif.api_key`
  ([setup](docs/server-configuration.md#gif-picker-gif)).

More detail: [docs/architecture/](docs/architecture/README.md) and
[docs/protocol.md](docs/protocol.md).

## Platform support

| Part          | Windows x64     | Windows ARM64   | Linux x64            | Linux ARM64          |
| ------------- | --------------- | --------------- | -------------------- | -------------------- |
| Server        | Yes             | Yes             | Yes                  | Yes                  |
| Desktop app   | Yes (installer) | Yes (installer) | Yes (AppImage, .deb) | Yes (AppImage, .deb) |
| Docker server | No              | No              | Yes                  | Yes                  |

Installing the app on Linux: [docs/linux-install.md](docs/linux-install.md).

The Docker image is `ghcr.io/j3vb/owncord-server`. One tag covers both `amd64`
and `arm64`.

## Quick start

The full guide is [docs/quick-start.md](docs/quick-start.md). This is the
short version.

### Option A: download the server

1. Download the server from
   [Releases](https://github.com/J3vb/OwnCord/releases). Each release also has
   checksums, signatures, SBOMs, a signed provenance record and a full copy of
   the source code.
2. Start the server:
   - Windows x64: `chatserver.exe`
   - Windows ARM64: `chatserver-windows-arm64.exe`
   - Linux: `./chatserver`, from `chatserver-linux-amd64.tar.gz` or
     `chatserver-linux-arm64.tar.gz`
3. Open `https://localhost:8443/admin` in a browser.
4. Follow the setup wizard. It asks for the **setup token** that the server
   printed when it started. The wizard creates your Owner account and saves
   your settings to `config.yaml`.
5. Make invite codes on the admin panel's **Invites** page, or with **Invite
   people** in the desktop app. Send them to your friends.

### Option B: Docker on Linux

The compose file and the `.example` files are **not separate release
downloads**. Get them from the source code attached to a
[release](https://github.com/J3vb/OwnCord/releases), or from the `Server/`
folder of this repository.

```bash
cd Server
cp .env.example .env
cp livekit.yaml.example livekit.yaml
cp config.yaml.example config.yaml
# Edit .env first: set the LiveKit key and secret there, and only there.
# Never use a ' in either value; letters and digits (for example
# `openssl rand -hex 32`) are safest.
# livekit.yaml is required (compose mounts it); editing it is optional, and it
# holds no key or secret.
# The compose file already connects the server to LiveKit,
# so config.yaml needs no voice changes.
docker compose up -d
```

Compose publishes `8443/TCP`, `7881/TCP` and `7882/UDP`. Forward those three on
your router for remote access.

The full Docker guide is in [docs/deployment.md](docs/deployment.md#docker-linux).

### The first connection

The server makes its own certificate. The desktop app uses **trust on first
use** (TOFU): it asks you once to trust the server's certificate, then
remembers it. If the certificate changes later, the app warns you.

## How it is built

Most of the code is written with AI tools. Quality comes from automated checks
(CI, tests and linting) and from me and my friends using it every day.
[docs/ai-workflow.md](docs/ai-workflow.md) says who does what and which checks
catch what. This
keeps changes fast, but it also means behaviour can change quickly between
releases.

## Architecture

The server and the desktop app talk over three channels:

- **WebSocket (WSS)** for live chat events
- **HTTPS** for the REST API
- **LiveKit** for voice and video

```text
+---------------------+         +---------------------+
|   OwnCord Client    |         |   OwnCord Server    |
|   (Tauri v2)        |         |       (Go)          |
|                     |         |                     |
|  +---------------+  |  WSS    |  +---------------+  |
|  |  Chat UI      |--+------->|  |  WebSocket Hub|  |
|  +---------------+  |         |  +---------------+  |
|  +---------------+  |  HTTPS  |  +---------------+  |
|  |  REST Client  |--+------->|  |  REST API     |  |
|  +---------------+  |         |  +---------------+  |
|  +---------------+  | LiveKit |  +---------------+  |
|  |  Voice/Video  |--+------->|  |  LiveKit SFU  |  |
|  +---------------+  |         |  +---------------+  |
+---------------------+         |  +---------------+  |
                                |  |  SQLite DB    |  |
                                |  +---------------+  |
                                +---------------------+
```

The server also serves the web admin panel. The desktop app has a TypeScript
front end and a small Rust back end.

## Build and test

### Prerequisites

- Go 1.27 or newer
- Node.js 26.x and npm 11.x. `Client/.nvmrc` sets the version. A different
  major version makes `npm ci` fail.
- Rust stable, for the desktop app
- On Linux, the desktop app also needs clang 21 or newer, a prebuilt
  libwebrtc and the GStreamer `-dev` packages. See
  [docs/contributing.md](docs/contributing.md#client-tauri-v2).

### Build from source

```bash
# Server (Windows)
cd Server
go build -o chatserver.exe -ldflags "-s -w -X main.version=dev" .

# Server (Linux)
cd Server
CGO_ENABLED=0 go build -o chatserver -ldflags "-s -w -X main.version=dev" .

# Desktop app
cd Client
npm install
npm run tauri build
```

### Run the checks

From the repository root:

```bash
npm run check                  # server, client, Rust, docs and hygiene
npm run check:server           # or one part at a time
node scripts/run.mjs --list    # shows exactly what each task runs, and where
```

This runs the same static, unit and drift checks as CI. It does **not** run
everything CI runs: the Playwright tests, govulncheck, npm audit, the coverage
floors, `typecheck:e2e` and the tag-gated Go tests are left out. See
[AGENTS.md](AGENTS.md#commands) for the exact split.

You can also run each part directly. **Server work needs no Node at all.**

```bash
# Server
cd Server
go test ./...

# Client
cd Client
npm run typecheck
npm run lint
npm test
```

The full list of commands is in [docs/contributing.md](docs/contributing.md).

## Configuration

On first start, the server creates `config.yaml` and a `data/` folder:

```text
data/
├── chatserver.db
├── cert.pem        # self-signed TLS certificate (key.pem is next to it)
├── uploads/
└── backups/
```

You can set the TLS mode, upload limits, LiveKit settings and which networks
may open the admin panel. Every option is in
[docs/server-configuration.md](docs/server-configuration.md).

## Reporting a security problem

- Use a private [GitHub Security Advisory](https://github.com/J3vb/OwnCord/security/advisories/new).
- Do not open a public issue for a security bug.
- The full policy is in [SECURITY.md](SECURITY.md) and
  [docs/security.md](docs/security.md).

## Getting help

There is no support promise (see the note at the top). But each kind of
message has a right place:

| What you have                 | Where it goes                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| A bug you can reproduce       | [Issues](https://github.com/J3vb/OwnCord/issues/new/choose)                                 |
| A question about setup or use | [Discussions → Q&A](https://github.com/J3vb/OwnCord/discussions/categories/q-a)             |
| An idea or feature request    | [Discussions → Ideas](https://github.com/J3vb/OwnCord/discussions/categories/ideas)         |
| A security problem            | [Private advisory](https://github.com/J3vb/OwnCord/security/advisories/new), never an issue |

## Contributing

1. Make a branch from `dev`. `dev` is where development happens.
2. Keep each change focused, and test it.
3. Open a pull request into `dev`. `dev` is merged into `main` for releases.

The full process is in [docs/contributing.md](docs/contributing.md).

## Documentation

[docs/README.md](docs/README.md) lists every document in `docs/`. It groups
them into guides, reference, audits and plans. The ones people use most:

- [docs/quick-start.md](docs/quick-start.md): get a server running
- [docs/deployment.md](docs/deployment.md): run a server for real
- [docs/contributing.md](docs/contributing.md): set up, branch, and run the
  checks CI runs
- [docs/security.md](docs/security.md): report a security problem
- [docs/STATUS.md](docs/STATUS.md): the current release and roadmap
- [docs/architecture/](docs/architecture/README.md): how the system is built
- [docs/architecture/ux/](docs/architecture/ux/README.md): how the desktop app
  should behave (a target-state spec)
- [docs/api.md](docs/api.md), [docs/protocol.md](docs/protocol.md),
  [docs/schema.md](docs/schema.md) and
  [docs/server-configuration.md](docs/server-configuration.md): reference
- [docs/plans/README.md](docs/plans/README.md): the plan index. It records each
  plan's state and overrides a plan's own header.

Audits are dated snapshots. Nobody updates them afterwards, so read them as
history.

### Files for AI coding agents

These short files give an AI agent, or a new contributor, the key context:
[AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md) at the repository root, and
the overviews in [docs/summaries/](docs/summaries/README.md)
([product](docs/summaries/product.md),
[architecture](docs/summaries/architecture.md),
[design system](docs/summaries/design-system.md),
[database](docs/summaries/database.md) and [API](docs/summaries/api.md)), plus
[docs/code-style.md](docs/code-style.md). Each one lists its sources. If they disagree,
the code wins, then those sources.

Human contributors can ignore the agent tool folders `.claude/`, `.codex/` and
`.agents/` and the file `.no-mistakes.yaml`. `AGENTS.md` and the `CLAUDE.md`
files are written for agents, but the rules in them apply to everyone.

## Update signing (maintainers)

The desktop app and the server use separate update signing keys.

A release needs these GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY`
- `SERVER_UPDATE_SIGNING_PRIVATE_KEY_PASSWORD`

To rotate the server update key, update
[Server/updater/server_update_public_key.txt](Server/updater/server_update_public_key.txt).
Roll it over in stages so running servers keep accepting updates.

## License

AGPL-3.0
