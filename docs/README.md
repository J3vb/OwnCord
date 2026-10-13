# Documentation index

This page lists every document in `docs/`. Use it to find the right page for
what you want to do. If a document is not listed here, it is not current
guidance.

## Four kinds of document

Knowing the kind tells you how far to trust a page:

- **Guides** tell you how to do something.
- **Reference** pages describe a contract the code implements.
- **Audits** are dated snapshots. They were true when written and are never
  updated. Read them as history, not as current status.
- **Plans** record what we intended to do.

## Start here

| I want to…                        | Read                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| Run a server                      | [quick-start.md](quick-start.md)                             |
| Run a server for real             | [deployment.md](deployment.md)                               |
| Fix something that is wrong       | [deployment.md — When it fails](deployment.md#when-it-fails) |
| Know what the beta does not do    | [known-limitations.md](known-limitations.md)                 |
| See the current release and plans | [STATUS.md](STATUS.md)                                       |
| Contribute a change               | [contributing.md](contributing.md)                           |
| Understand how it is built        | [architecture/](architecture/README.md)                      |
| Report a bug                      | [Issues](https://github.com/J3vb/OwnCord/issues/new/choose)  |
| Ask a question or suggest an idea | [Discussions](https://github.com/J3vb/OwnCord/discussions)   |
| Report a security problem         | [security.md](security.md)                                   |
| Know who can read what            | [trust-model.md](trust-model.md)                             |
| Know how much one server can hold | [capacity.md](capacity.md)                                   |

## Guides

| Document                                     | What it covers                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [quick-start.md](quick-start.md)             | Get a server running in as few steps as possible.                                                 |
| [deployment.md](deployment.md)               | Run a server on Windows or Linux, and keep it running: logs, storage, failures, restore, updates. |
| [known-limitations.md](known-limitations.md) | What the beta does not do, and a short FAQ.                                                       |
| [STATUS.md](STATUS.md)                       | The current release, nightly test health and the roadmap.                                         |
| [contributing.md](contributing.md)           | Set up, the branch and pull request model, coding standards, and how to run the CI checks.        |
| [security.md](security.md)                   | How to report a security problem, what stays private, and hardening for operators.                |
| [trust-model.md](trust-model.md)             | Who can read what: text and files the operator can read, encrypted calls, transport, storage.     |
| [capacity.md](capacity.md)                   | How much one server carries: the measured 250/100/25 profile, its hardware and commands.          |
| [livekit-setup.md](livekit-setup.md)         | Set up the LiveKit server for voice and video.                                                    |
| [port-forwarding.md](port-forwarding.md)     | Make a server reachable from outside your home network.                                           |
| [tailscale.md](tailscale.md)                 | Remote access without port forwarding.                                                            |
| [testing-behavior.md](testing-behavior.md)   | Which test lane catches which broken behaviour, and its limits.                                   |
| [mcp-introspect.md](mcp-introspect.md)       | A development-only MCP server for looking inside a running server.                                |

## Reference

These pages describe contracts the code implements. If one disagrees with the
code, the code is right and the page has a bug.

| Document                                           | What it covers                                              |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [api.md](api.md)                                   | The REST API under `/api/v1`.                               |
| [protocol.md](protocol.md)                         | The WebSocket protocol: frames, sequencing and reconnect.   |
| [schema.md](schema.md)                             | The SQLite schema and migrations.                           |
| [server-configuration.md](server-configuration.md) | Every server configuration option.                          |
| [credential-storage.md](credential-storage.md)     | What the desktop app saves, and where.                      |
| [../protocol/schema.json](../protocol/schema.json) | The source of truth for WebSocket message types. See below. |

`protocol/schema.json` sits at the repository root because neither the server
nor the client owns it. `Server/ws/message_types.go` and
`Client/src/lib/protocolTypes.ts` are generated from it. Never edit either by
hand. See [../protocol/README.md](../protocol/README.md).

## Architecture

[architecture/README.md](architecture/README.md) describes each architecture
document and the rule for keeping them current. Each document names the source
files it describes. A pull request that changes those files updates the
document in the same change.

How the system is built:

- [system-overview.md](architecture/system-overview.md): processes, trust
  boundaries, ports and deployment
- [server.md](architecture/server.md): server packages and the REST request path
- [client.md](architecture/client.md): the desktop app's modules, as built
- [data-model.md](architecture/data-model.md): database tables, grouped by area
- [websocket.md](architecture/websocket.md): the real-time engine, reconnect
  and replay
- [voice-e2ee.md](architecture/voice-e2ee.md): voice, LiveKit tokens and
  end-to-end encryption

Inventories and design records:

- [server-boundaries.md](architecture/server-boundaries.md): which server files
  call the database, and the hub's lifecycle
- [data-lifecycle.md](architecture/data-lifecycle.md): destructive operations,
  how each can fail, and every kind of user data
- [diagnostics.md](architecture/diagnostics.md): diagnostic surfaces, what the
  server sends off the machine, and the support bundle
- [community-services.md](architecture/community-services.md): community,
  content and moderation services, with abuse cases and data ownership
- [rich-content-inventory.md](architecture/rich-content-inventory.md): every
  place OwnCord fetches outside content, and its limits
- [b9-ui-contract.md](architecture/b9-ui-contract.md): the shared UI rules
  (colours, focus, keyboard, announcements, motion)

Target state, not shipped behaviour:

- [ux/](architecture/ux/README.md): how each view of the desktop app should
  behave and react to events
- [platform-contracts.md](architecture/platform-contracts.md): what must move
  behind a contract before the client can run in a browser (after beta)
- [plugins.md](architecture/plugins.md): the experimental WASM plugin boundary.
  Off by default, left out of release builds, and with no API promise.

[client-architecture.md](client-architecture.md) only points to
[architecture/client.md](architecture/client.md). It stays so old links work.

## Audits

Audits are dated snapshots. They are **not** updated as the code changes. They
also keep their old paths, so links from commit messages still work. Anything
in them may be out of date. For current status, see
[Where status lives](#where-status-lives).

| Audit                                                                                      | Scope                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [parity-sweep-2026-10.md](parity-sweep-2026-10.md)                                         | Every user-facing area compared with what a Discord user expects, plus a bug sweep.         |
| [ci-flake-audit-2026-10.md](ci-flake-audit-2026-10.md)                                     | CI flakes: checks ranked by red-then-green reruns over 60 days, causes and fixes.           |
| [client-perf-audit-2026-10.md](client-perf-audit-2026-10.md)                               | Client performance: startup, channel switch, scrolling, voice join, memory.                 |
| [linux-platform-audit-2026-10.md](linux-platform-audit-2026-10.md)                         | The Linux desktop app compared with Windows: IPC, WebKitGTK differences, what to fix.       |
| [audit-2026-09-23-windows-update-relaunch.md](audit-2026-09-23-windows-update-relaunch.md) | Windows app update: why the new version can start late (not conclusive).                    |
| [audit-2026-08-23-repository-layout.md](audit-2026-08-23-repository-layout.md)             | Repository layout and contributor experience.                                               |
| [audit-2026-08-23-repository-health.md](audit-2026-08-23-repository-health.md)             | Full repository health.                                                                     |
| [audit-2026-08-19.md](audit-2026-08-19.md)                                                 | Repository health. It says "0 open findings"; that has not been true since. See the ledger. |
| [audit-test-coverage-2026-08-19.md](audit-test-coverage-2026-08-19.md)                     | Tests. Uses its own `T-*` numbering, separate from the findings ledger.                     |
| [audit-2026-08-04-docs-and-coverage.md](audit-2026-08-04-docs-and-coverage.md)             | Documentation accuracy and UI test coverage.                                                |
| [audit-2026-08-04.md](audit-2026-08-04.md)                                                 | Security review.                                                                            |
| [audit-test-coverage-2026-07-25.md](audit-test-coverage-2026-07-25.md)                     | Test coverage.                                                                              |
| [audit-2026-07-19.md](audit-2026-07-19.md)                                                 | Architecture and spec conformance.                                                          |
| [audit-2026-04-07.md](audit-2026-04-07.md)                                                 | The first full audit.                                                                       |

## Plans

[plans/README.md](plans/README.md) lists every plan and its state: active,
partly done, design only, or shipped. A plan's own header can fall out of
date, so **the plan index wins** over it.

## Where status lives

Do not read a defect count, or a "what works" claim, from a document on this
page. Each kind of status has one owner:

| What                                     | Where it lives                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Current release, nightly health, roadmap | [STATUS.md](STATUS.md)                                                  |
| Defects                                  | `.superpowers/findings-ledger.json` (`FINDINGS.md` is rendered from it) |
| Security-sensitive defects               | Private GitHub Security Advisories                                      |
| Rules for generated code                 | `CLAUDE.md`, "Generated code — never hand-edit"                         |

A CI job checks the counts in a few current summaries against the live
ledger. To add a summary to that check, add its document to the allow-list in
`scripts/check-doc-counts.mjs`. Dated baselines and signed scorecards keep the
numbers they measured at their source commits. Never change them to make the
live count check pass.
