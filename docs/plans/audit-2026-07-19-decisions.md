# Audit 2026-07-19 — Maintainer Decisions

**Date decided:** 2026-07-19 (D1–D8); 2026-07-20 (D9–D10)
**Decided by:** J3vb
**Status:** decisions recorded; greenlit items (D4, D7, D8) implemented 2026-07-19 — see per-row Status. **2026-07-20:** backlog items 3 and 11 (D9, D10) implemented — channel-visibility unified through `permissions.Checker`; V2 dispatch migration finished and V1 deleted.
**Source:** decision points raised by [docs/audit-2026-07-19.md](../audit-2026-07-19.md)

This document records the maintainer's answers to the open decision points from
the 2026-07-19 architectural audit, so follow-up PRs can implement against a
settled direction instead of re-litigating it. Update the **Status** column
here (and the audit's closure table) as items land.

## Decisions

| # | Decision point | Audit ID | Decision | Status |
|---|----------------|----------|----------|--------|
| D1 | `announcement` channel type (documented + offered by admin API, rejected by DB triggers) | A-2026-07-01 | **Implement end-to-end**: migration to allow the type, posting-permission semantics, admin support, client rendering, spec updates. Not a doc-strip — this becomes a real feature. | **Implemented 2026-07-19**: migration 016 allows `announcement`; posting requires MANAGE_MESSAGES (readable like text); admin already offered it; client renders a megaphone icon + unread counts; specs updated. |
| D2 | Data-layer direction (raw SQL vs dead sqlc `db/dbgen` vs `store.Store`) | A-2026-07-05 / A-2026-07-06 | **Adopt sqlc for real**: wire `db.DB` method bodies to the generated `dbgen` queries so sqlc becomes the actual, type-checked query layer. The `sqlc-verify` CI job stays and starts earning its keep. | **Largely done 2026-07-19**: `dbgen.Queries` wired into `db.DB`; 97 methods across all domains delegate to sqlc (no longer dead code). ~43 raw calls remain by design (variable IN, FTS, multi-statement tx, PRAGMA/VACUUM) — tracked in [sqlc-adoption.md](sqlc-adoption.md). |
| D3 | Fate of `Server/store/` (untested abstraction seam) | prior audit #6 | **Remove `store/`** via interface segregation: delete `SQLiteStore` + `MemStore` + the `store` package; port the event/plugin methods into `db`; each consumer depends on a small interface `*db.DB` satisfies. | **Implemented 2026-07-19**: the `store/` package is deleted. Event and plugin methods moved into `db` (`event_queries.go`, `plugin_queries.go`); consumers depend on narrow interfaces `*db.DB` satisfies (`service.Store`, `ws.EventStore`, `plugin.PluginStore`). All service/ws/plugin/api tests now run against a real in-memory SQLite `db` with seed helpers; fault-injection tests embed a real `*db.DB` and override the one method under test. Full server suite + `sqlc-verify` green. |
| D4 | Protocol constants sync (`message_types.go` / `protocolTypes.ts` claim a nonexistent `docs/protocol-schema.json`) | A-2026-07-08 | **Create real codegen**: commit an actual `protocol-schema.json` plus a generator that emits the Go and TS constant files (and, ideally, protocol.md's message table), making the "single source of truth" comment true. | **Implemented 2026-07-19**: `docs/protocol-schema.json` + `Server/scripts/genprotocol` + `make protocol-generate`/`protocol-verify` + CI gate. protocol.md table generation deferred to D7. |
| D5 | Client HTTP TLS gap (`allowSelfSigned: true`, no TOFU pinning on the REST path) | A-2026-07-02 | **Next security work**: build the TOFU HTTP proxy in Rust (mirroring `ws_proxy.rs`) as the next security task — highest-priority security item. | **Implemented 2026-07-19** — `src-tauri/src/http_proxy.rs` (per-host loopback TCP→TLS tunnels, shared TOFU cert store + `cert-tofu` events) + `src/lib/httpProxy.ts`; REST/health/attachments routed through it; `acceptInvalidCerts`/`allowSelfSigned` and the `dangerous-settings` feature removed. See [http-tofu-proxy.md](http-tofu-proxy.md). |
| D6 | Abandoned SolidJS beachhead + stale `docs/client-architecture.md` | A-2026-07-12 | **Delete it all**: remove `src/components/solid/`, `solidMount`/`solidAdapter`, `vite-plugin-solid`, and Solid test deps; retire `client-architecture.md` in favor of [docs/architecture/client.md](../architecture/client.md). | **Implemented 2026-07-19** — solid/ dir, solidMount/solidAdapter, setup-solid tests, vite-plugin-solid, jsx tsconfig settings, and solid-js/@solidjs deps all removed; client-architecture.md is now a pointer. |
| D7 | Spec refresh strategy for api.md / protocol.md / schema.md | A-2026-07-03 | **One refresh PR first**, using the audit's §2 conformance matrix as the checklist; afterwards specs are kept current per-PR (see the maintenance rule in [docs/architecture/README.md](../architecture/README.md)). Announcement channels (D1) later update the *fresh* specs. | **Implemented 2026-07-19** — all three specs refreshed against the code (incl. E2EE protocol section, migrations 001–015, profile/blocks/plugin-admin endpoints); reference tables now point at `protocol-schema.json`. |
| D8 | What to implement first | backlog §6 | **Greenlit now: Protocol codegen (D4) + the quick-wins batch** — `LogAudit` error handling (`admin/handlers_backup.go`), contradictory upload `Cache-Control` (`upload_handler.go`), hub inline settings SQL through the data layer (`ws/hub.go`), Hub constructor cleanup (required collaborators into `NewHub`). | **Implemented 2026-07-19** (all four quick wins + D4). Hub cleanup shipped as: race fix — `eventPersister`/`eventStore`/`pluginSink` are now atomic (they were plain fields written by `main.go` after `NewRouter` had already started `Run`); remaining pre-Run setters now reject late calls with an error log instead of racing silently. Note discovered during the work: the discarded-`LogAudit` pattern is repo-wide (23 call sites) — the two tracker-flagged backup handlers are fixed; whether best-effort audit writes stay the convention elsewhere needs a policy decision. |
| D9 | Channel-visibility unification (rule duplicated across ~4 "must mirror" sites) | A-2026-07-07 / backlog 3 | **Greenlit 2026-07-20 — implement**: funnel all four sites through the existing `permissions.Checker` predicate + one filter helper; add a REST/WS agreement test. See [channel-visibility-unification.md](channel-visibility-unification.md). | **Implemented 2026-07-20** — `permissions.Checker.VisibleChannelIDs` + `ChannelRef`; `ListVisibleChannels`, `buildReady`, `computeAllowedChannels` delegate; `RefreshChannelVisibility` uses `HasChannelPerm`. REST/WS agreement test asserts all three sites yield the identical non-DM set. |
| D10 | Finish the V2 dispatch migration; delete V1 | A-2026-07-09 / backlog 11 | **Greenlit 2026-07-20 — implement**: port the 3 remaining V1 types (`chat_command`, `voice_join`, `voice_leave`) to V2, then delete the V1 registry + fallback path. Server-internal only, no wire change. See [v2-dispatch-migration.md](v2-dispatch-migration.md). | **Implemented 2026-07-20** — the 3 types ported to typed V2 handlers (voice join/leave hand off to the hub routines via new `Result.JoinVoice`/`LeaveVoice` appliers); V1 registry + `handleMessage` fallback deleted; a constructor↔handler parity guard test locks it shut. No wire change. |

## Suggested sequencing

1. **Now (greenlit):**
   - Quick-wins batch (small, independent, low-risk).
   - Protocol codegen (D4) — also unblocks the protocol.md portion of D7.
2. **Next:**
   - Spec refresh PR (D7) — after D4 so protocol.md tables can be generated.
   - Client HTTP TOFU proxy (D5) — next security work.
   - Solid cleanup (D6) — small, can slot in anywhere.
3. **Then (larger, sequenced together):**
   - sqlc adoption (D2), followed by `store/` removal (D3) once queries are
     type-checked — doing D3 after D2 avoids rewiring services twice.
   - Announcement channels (D1) — after the spec refresh so it patches fresh
     specs; needs its own small design note (permission semantics: who can
     post vs read).

## Explicitly not decided here

- ~~Channel-visibility unification (audit backlog 3) and finishing the V2
  dispatch migration (backlog 11) were not greenlit yet.~~ **Greenlit 2026-07-20
  (D9, D10)** — design notes written; see the rows above.
- Client unit suite triage to green/blocking (A-2026-07-04) remains tracked in
  the audit; no scheduling decision was taken.
