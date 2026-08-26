# Documentation index

Every document in `docs/` is listed here. If it is not on this page it is not
current guidance.

Docs fall into four kinds, and the difference matters when you are deciding
whether to trust one: **guidance** tells you how to do something,
**reference** describes a contract the code actually implements, **audits** are
dated snapshots that were true when written and were never updated, and
**plans** record intent. Read an audit as history, not as status.

## Start here

| I want to… | Read |
| --- | --- |
| Run a server | [quick-start.md](quick-start.md) |
| Deploy for real | [deployment.md](deployment.md) |
| Contribute a change | [contributing.md](contributing.md) |
| Understand the system | [architecture/](architecture/README.md) |
| Report a vulnerability | [security.md](security.md) |

## Guidance

| Document | Covers |
| --- | --- |
| [quick-start.md](quick-start.md) | Getting a server running with the fewest steps. |
| [deployment.md](deployment.md) | Production deployment on Windows and Linux. |
| [contributing.md](contributing.md) | Environment setup, **the branch and PR model**, coding standards, how to run the checks CI runs. |
| [security.md](security.md) | How to report a vulnerability, and how findings are handled in public vs private. |
| [livekit-setup.md](livekit-setup.md) | Standing up the LiveKit SFU for voice and video. |
| [port-forwarding.md](port-forwarding.md) | Making a server reachable from outside the LAN. |
| [tailscale.md](tailscale.md) | Remote access without port forwarding. |
| [mcp-introspect.md](mcp-introspect.md) | Dev-only MCP server for introspecting a running instance. |

## Reference

These describe contracts the code implements. If one disagrees with the code,
the code is right and the document is a bug.

| Document | Covers |
| --- | --- |
| [api.md](api.md) | REST API under `/api/v1`. |
| [protocol.md](protocol.md) | WebSocket protocol — frames, sequencing, reconnect. |
| [schema.md](schema.md) | SQLite schema and migrations. |
| [server-configuration.md](server-configuration.md) | Every server configuration option. |
| [credential-storage.md](credential-storage.md) | What the desktop client persists, and where. |
| [protocol-schema.json](protocol-schema.json) | **Generated-code source of truth.** `Server/ws/message_types.go` and `Client/src/lib/protocolTypes.ts` are generated from it — never hand-edit either. |

## Architecture

[architecture/README.md](architecture/README.md) indexes the blueprints and
carries the maintenance rule: each blueprint names its source-of-truth files,
and a PR touching those updates the blueprint in the same change.

- [system-overview.md](architecture/system-overview.md), [server.md](architecture/server.md), [client.md](architecture/client.md)
- [data-model.md](architecture/data-model.md), [websocket.md](architecture/websocket.md), [voice-e2ee.md](architecture/voice-e2ee.md)
- [ux/](architecture/ux/README.md) — target-state UX spec, per-view states and event→reaction maps

[client-architecture.md](client-architecture.md) is a redirect stub; the live
document is [architecture/client.md](architecture/client.md).

## Audits — dated, not maintained

Point-in-time snapshots. They are **not** updated as the code moves, and they
are deliberately left alone when paths change, so links from commit messages
keep resolving. Anything here may be stale; the ledger and the plan index carry
current status.

| Audit | Scope |
| --- | --- |
| [audit-2026-08-23-repository-layout.md](audit-2026-08-23-repository-layout.md) | Repository layout and contributor experience (`RL-01`…`RL-22`). |
| [audit-2026-08-23-repository-health.md](audit-2026-08-23-repository-health.md) | Full repository health. |
| [audit-2026-08-19.md](audit-2026-08-19.md) | Repo health. **States "0 open findings" — untrue since; see the ledger.** |
| [audit-test-coverage-2026-08-19.md](audit-test-coverage-2026-08-19.md) | Test audit (`T-*`, a separate register from the `OC-*` ledger). |
| [audit-2026-08-04-docs-and-coverage.md](audit-2026-08-04-docs-and-coverage.md) | Documentation accuracy and UI/UX test coverage. |
| [audit-2026-08-04.md](audit-2026-08-04.md) | Security review. |
| [audit-test-coverage-2026-07-25.md](audit-test-coverage-2026-07-25.md) | Test-coverage audit. |
| [audit-2026-07-19.md](audit-2026-07-19.md) | Architecture and spec-conformance review. |
| [audit-2026-04-07.md](audit-2026-04-07.md) | First comprehensive audit. |

## Plans

[plans/README.md](plans/README.md) indexes every plan with a recorded state —
active, partially implemented, design-only, or shipped — and **is the authority
over a plan's own header**, which can drift.

## Where status actually lives

Do not read a defect count, or a "what works" claim, out of a document on this
page. Status has owners:

| Concern | Source of truth |
| --- | --- |
| Defect status | `.superpowers/findings-ledger.json` (`FINDINGS.md` is rendered from it) |
| Security-sensitive defects | Private GitHub Security Advisories |
| Phase order and gates | [plans/repo-health-roadmap-2026-08-23.md](plans/repo-health-roadmap-2026-08-23.md) |
| Current measured baseline | [plans/b0-baseline-2026-08-25.md](plans/b0-baseline-2026-08-25.md) |
| Generated-code contracts | `CLAUDE.md`, "Generated code — never hand-edit" |

A CI job checks that documents on this page do not contradict the ledger's
counts. Adding a count to a document means adding it to that check's allow-list
in `scripts/check-doc-counts.mjs`.
