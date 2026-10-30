# OwnCord Architecture Blueprints

**Index checked against:** `origin/dev` at `ac6ffc4e`, 2026-10-13. Each page
carries its own "Verified against" line.

This folder is the map of how OwnCord is built. Start here if you need to
find the right architecture page for a question. Most pages pair a Mermaid
diagram (GitHub draws these) with a short explanation and a **Source of
truth** list of the files it describes.

## Index

### How the system is built today

| Doc                                                    | Diagrams                                         | Covers                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [system-overview.md](system-overview.md)               | D1 System context, D8 Deployment topology        | All processes, trust boundaries, ports, single-instance limits                                                                 |
| [server.md](server.md)                                 | D2 Server package map, D3 REST request lifecycle | Go package structure, database-access styles, the middleware chain                                                             |
| [websocket.md](websocket.md)                           | D4 WS connect / replay / dispatch                | The real-time engine: sign-in over the socket, 3-tier reconnect replay, backpressure, typed dispatch                           |
| [data-model.md](data-model.md)                         | D5 Entity-relationship overview                  | All 50 application tables from migrations 001–059, grouped by domain                                                           |
| [voice-e2ee.md](voice-e2ee.md)                         | D6 Voice + E2EE flow                             | LiveKit token flow, the loopback TLS tunnel, the ECDH key-holder relay, and native voice on Linux                              |
| [linux-native-voice.md](linux-native-voice.md)         | Linux native voice                               | The Rust `native_voice/` backend: audio, camera, screen share, codecs and global shortcuts on Linux                            |
| [client.md](client.md)                                 | D7 Client module map                             | The Tauri client as built: start-up, dispatcher, stores, Rust commands                                                         |
| [plugins.md](plugins.md)                               | —                                                | The experimental WASM plugin boundary: off twice and compiled out of releases, no API promise, what may and may never move     |
| [diagnostics.md](diagnostics.md)                       | —                                                | Every diagnostic surface, the list of everything the server sends off the machine, and what a support bundle contains          |
| [data-lifecycle.md](data-lifecycle.md)                 | —                                                | Destructive operations (account erasure, deletion, sweeps, backup and restore) with a failure model each, and every data class |
| [rich-content-inventory.md](rich-content-inventory.md) | —                                                | Every path that fetches content the operator did not choose, and the bounds on each                                            |

### Contracts and inventories read by tests

These pages are checked by tests or generated in part. Change their structure
only together with the test that reads them.

| Doc                                            | Covers                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [platform-contracts.md](platform-contracts.md) | The desktop/browser seam: where native dependencies are isolated, and the three that have no browser equivalent                                      |
| [server-boundaries.md](server-boundaries.md)   | B3-0 inventory: every file above the domain layer that imports `db`, with a disposition. Generated table, enforced by `db-import-boundary`           |
| [community-services.md](community-services.md) | B5-0: the community, content and moderation services, each with abuse cases, data ownership and lifecycle                                            |
| [ui-contract.md](ui-contract.md)               | B9-2: the shared UI rules every feature follows: colour tokens, focus, keyboard, announcements, motion, teardown, and the reusable Playwright checks |

### Decisions

Short decision records, kept here until the ADR series exists (roadmap Phase 7).

| Doc                                                    | Covers                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| [channel-scope-decision.md](channel-scope-decision.md) | Why live channel frames reach only the focused channel while replay covers every readable one |

### Target behaviour (not shipped behaviour)

| Doc                 | Covers                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| [ux/](ux/README.md) | The client **behaviour** spec: what every view should do and how it reacts to events, permissions and failure |

## Structure, behaviour and seams

[client.md](client.md) maps the client _as built_: modules, stores and wiring.
The [ux/](ux/README.md) set describes _target_ behaviour for every view, with
state tables and event-to-reaction maps. Where today's code differs from the
target, the UX docs carry dated **Current gap** notes. So the UX set also works
as a list of UX improvements still to make. Never cite the UX docs as shipped
behaviour.

[platform-contracts.md](platform-contracts.md) is a third kind of page: a map
of the desktop/browser seam. B7 built the desktop side
(`Client/src/platform/contracts/` and `Client/src/platform/desktop/`). The
browser side is deferred to B8, so that half of the page is still a decision
record, not a description of code.

## Maintenance rule

These documents are written by hand, not generated (except the marked table in
server-boundaries.md). One rule keeps them honest:

> If a pull request changes the _structure_ of anything in a diagram's
> **Source of truth** list (a new package, table, message type or flow), that
> pull request also updates the diagram.

Diagrams name stable identifiers (package names, table names, message types)
rather than line numbers where they can. Line-number evidence lives in the
dated audit reports, which are snapshots by design.

## Relationship to other docs

- `docs/api.md`, `docs/protocol.md` and `docs/schema.md` are the _reference
  specs_: request and response shapes, wire formats and table definitions.
  These blueprints describe _structure and flow_, not payload shapes. Older
  drift between the specs and the code is listed in the dated audit reports,
  for example
  [2026-08-04-docs-and-ui-coverage.md](../audits/2026-08-04-docs-and-ui-coverage.md).
- [trust-model.md](../trust-model.md) says who can read what, and why.
- `docs/client-architecture.md` is a redirect page kept for old links.
  [client.md](client.md) is the client architecture document.
