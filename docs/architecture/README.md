# OwnCord Architecture Blueprints

**Verified against:** commit `ddc49f0`, 2026-07-19
**Companion audit:** [docs/audit-2026-07-19.md](../audit-2026-07-19.md)

This directory is the curated architectural map of OwnCord — the "blueprints" for
the whole system. Every diagram is a Mermaid fenced block (GitHub renders these
natively) followed by a prose explanation and a **Source of truth** file list.

## Index

| Doc | Diagrams | Covers |
|-----|----------|--------|
| [system-overview.md](system-overview.md) | D1 System context, D8 Deployment topology | All processes, trust boundaries, ports, single-instance constraints |
| [server.md](server.md) | D2 Server package map, D3 REST request lifecycle | Go package structure, DB-access styles, middleware chain |
| [websocket.md](websocket.md) | D4 WS connect / replay / dispatch | Real-time engine: auth handshake, 3-tier reconnect replay, backpressure, V1/V2 dispatch |
| [data-model.md](data-model.md) | D5 Entity-relationship overview | All 23 tables from migrations 001–015, grouped by domain |
| [voice-e2ee.md](voice-e2ee.md) | D6 Voice + E2EE flow | LiveKit token flow, loopback TLS tunnel, ECDH key-holder relay |
| [client.md](client.md) | D7 Client module map | Tauri client: bootstrap, dispatcher, stores, Rust sidecars |

## Maintenance rule

These documents are **curated, not generated**. The rule that keeps them honest:

> If a PR changes the *structure* of anything listed in a diagram's
> **Source of truth** list (new package, new table, new message type, changed
> flow), that PR updates the corresponding diagram in the same change.

Diagrams reference stable identifiers (package names, table names, message-type
strings) rather than line numbers wherever possible. Line-number evidence lives
in the dated audit reports, which are point-in-time snapshots by design.

## Relationship to other docs

- `docs/api.md`, `docs/protocol.md`, `docs/schema.md` are the *reference specs*
  (request/response shapes, wire formats, DDL). These blueprints describe
  *structure and flow*, not payload shapes. Known drift between the specs and
  the code is catalogued in [audit-2026-07-19.md §2](../audit-2026-07-19.md).
- `docs/client-architecture.md` predates the abandonment of the Solid.js
  migration; [client.md](client.md) reflects the current state.
