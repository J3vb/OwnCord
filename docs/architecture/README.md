# OwnCord Architecture Blueprints

**Verified against:** commit `5630aa1`, 2026-08-04
**Companion audits:** [docs/audit-2026-08-04-docs-and-coverage.md](../audit-2026-08-04-docs-and-coverage.md) (docs & coverage),
[docs/audit-2026-08-04.md](../audit-2026-08-04.md) (security),
[docs/audit-2026-07-19.md](../audit-2026-07-19.md) (architecture)

This directory is the curated architectural map of OwnCord — the "blueprints" for
the whole system. Every diagram is a Mermaid fenced block (GitHub renders these
natively) followed by a prose explanation and a **Source of truth** file list.

## Index

| Doc                                            | Diagrams                                         | Covers                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [system-overview.md](system-overview.md)       | D1 System context, D8 Deployment topology        | All processes, trust boundaries, ports, single-instance constraints                                                                                                                                                                                                                                                                               |
| [server.md](server.md)                         | D2 Server package map, D3 REST request lifecycle | Go package structure, DB-access styles, middleware chain                                                                                                                                                                                                                                                                                          |
| [websocket.md](websocket.md)                   | D4 WS connect / replay / dispatch                | Real-time engine: auth handshake, 3-tier reconnect replay, backpressure, typed dispatch                                                                                                                                                                                                                                                           |
| [data-model.md](data-model.md)                 | D5 Entity-relationship overview                  | All 26 tables from migrations 001–028, grouped by domain                                                                                                                                                                                                                                                                                          |
| [voice-e2ee.md](voice-e2ee.md)                 | D6 Voice + E2EE flow                             | LiveKit token flow, loopback TLS tunnel, ECDH key-holder relay                                                                                                                                                                                                                                                                                    |
| [client.md](client.md)                         | D7 Client module map                             | Tauri client: bootstrap, dispatcher, stores, Rust sidecars (structure, as-built)                                                                                                                                                                                                                                                                  |
| [ux/](ux/README.md)                            | UX flow + state diagrams                         | Client **behavior** spec (target state): what every view does and how it reacts to events, permissions, and failure                                                                                                                                                                                                                               |
| [platform-contracts.md](platform-contracts.md) | —                                                | Desktop/browser **seam** (target state): where native dependencies will be isolated, and the three that have no browser equivalent                                                                                                                                                                                                                |
| [server-boundaries.md](server-boundaries.md)   | —                                                | B3-0 inventory: every file above the domain layer that imports `db`, with a disposition and target family; hub setters, locks and the start/stop defer stack; the auth slice's before-graph. Generated table, enforced by `db-import-boundary`                                                                                                    |
| [data-lifecycle.md](data-lifecycle.md)         | —                                                | B4-0: the destructive operations (account deletion, message deletion, the orphan sweep, backup/restore, replay retention, session sweeps, the TOTP key, recovery-secret rotation) with a failure model each on five axes; every user-attributable data class with today's deletion behaviour and its B4 target; the alpha-snapshot drill protocol |
| [diagnostics.md](diagnostics.md)               | —                                                | B4-8: every diagnostic surface and that none leaves the machine; the egress inventory the `egress-sites` invariant enforces (every outbound path is manual, configuration-gated or loopback); the runtime no-automatic-telemetry capture; the support-bundle data contract BG-15's B6/B9 implementation must satisfy                              |
| [community-services.md](community-services.md) | —                                                | B5-0: the seven community, content and moderation services B5 adds or changes, each with an abuse-case table (HP-5's twelve topics), a data-ownership table and a lifecycle table against B4-9 erasure, B4-10 markers and B4-11 sweeps; what B5 does not defend against; the `-count=1` document gate in `Server/migrations`                      |
| [plugins.md](plugins.md)                       | —                                                | Experimental WASM plugin boundary: off twice and compiled out of releases, no API promise, post-beta candidates, core that never moves                                                                                                                                                                                                            |

### Structure vs. behavior

[client.md](client.md) maps the client _as-built_ (modules, stores, wiring). The
[ux/](ux/README.md) set is the complementary _behavior_ spec — prescriptive
(to-be) flows for every view, with per-view state matrices and event→reaction
maps. Where today's code diverges from the target, the UX docs carry dated
**⚠ Current gap** callouts, so the set doubles as a UX improvement backlog.

[platform-contracts.md](platform-contracts.md) is a third kind again: a _target
seam_ map. It records where the desktop/browser boundary will be drawn and what
crosses it, measured against today's code. The seam does not exist yet — B7
builds it — so read that document as a decision record, not as structure.

## Maintenance rule

These documents are **curated, not generated**. The rule that keeps them honest:

> If a PR changes the _structure_ of anything listed in a diagram's
> **Source of truth** list (new package, new table, new message type, changed
> flow), that PR updates the corresponding diagram in the same change.

Diagrams reference stable identifiers (package names, table names, message-type
strings) rather than line numbers wherever possible. Line-number evidence lives
in the dated audit reports, which are point-in-time snapshots by design.

## Relationship to other docs

- `docs/api.md`, `docs/protocol.md`, `docs/schema.md` are the _reference specs_
  (request/response shapes, wire formats, DDL). These blueprints describe
  _structure and flow_, not payload shapes. Known drift between the specs and
  the code is catalogued in the dated audit reports (latest:
  [audit-2026-08-04-docs-and-coverage.md](../audit-2026-08-04-docs-and-coverage.md)).
- `docs/client-architecture.md` is a redirect stub kept for old links;
  [client.md](client.md) is the client architecture document.
