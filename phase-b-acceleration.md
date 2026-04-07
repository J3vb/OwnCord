# OwnCord — Phase B: Acceleration

**Steps 6–8 | Weeks 6–14 | Community Scale Edition**

*Solid.js Frontend • Event Persistence • OpenTelemetry*

---

## Phase Overview

Phase B runs after the server foundation is in place. It tackles the three remaining infrastructure gaps: a proper frontend framework to accelerate UI development, event persistence for reliable reconnection at scale, and pluggable observability for community hub operators. These steps overlap with the tail end of Phase A since Step 6 is entirely client-side work.

The Solid.js migration (Step 6) is the highest-effort, highest-payoff change in the entire plan. Event persistence (Step 7) and OpenTelemetry (Step 8) are shorter server-side tasks that run in parallel. All three are required before the community hub milestone can ship.

### Timeline

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 6 | Adopt Solid.js (incremental) | 4–6 weeks | — | Yes (client-side) |
| 7 | Event persistence layer | 1–2 weeks | Steps 1+3 | Yes (with 6, 8) |
| 8 | Add OpenTelemetry | 1–2 weeks | Step 1 | Yes (with 6, 7) |

### Milestone Gate

**After Phase B:** The client has a proper framework, reconnection is reliable at scale, and operators have pluggable monitoring. The community hub milestone (Milestone 2 from the parity plan) is shippable.

---

## Step 6: Adopt Solid.js Frontend Framework

**Effort:** High (4–6 weeks incremental) | **Impact:** Critical | **Phase:** B — Acceleration

### Problem

The vanilla TypeScript frontend has effectively become a custom framework: reactive stores, a component model, a dispatcher, virtual scrolling, manual DOM lifecycle management. Every new UI feature requires hand-wiring DOM creation, updates, and teardown. Community-scale features (role permission editors with tri-state per-channel overrides, audit log viewers with filtering, moderation dashboards, member lists grouped by role with presence indicators) are complex stateful UIs that are painful to build and maintain without a framework.

### Options

| Framework | Reactivity Model | Migration Path | Tauri Ecosystem | Verdict |
|-----------|-----------------|----------------|-----------------|---------|
| **Solid.js** | Signals, effects, memos — maps directly to existing store pattern | Incremental: wrap stores as signals, convert components one by one | Growing. Solid + Tauri examples available. Vite integration native. | **RECOMMENDED** |
| Svelte 5 | Runes (compile-time reactivity). Simple component model, no virtual DOM. | Requires rewriting components in .svelte files. Larger upfront cost. | Good. Tauri + Svelte is well-documented. | VIABLE |
| React | Virtual DOM reconciliation. useState/useEffect hooks. Largest ecosystem. | Full rewrite into JSX components. Hooks model differs from current stores. | Excellent. Most Tauri projects use React. Huge community. | VIABLE |
| Vue 3 | Composition API with ref/reactive. Template-based. Good DX. | Moderate. Composition API maps reasonably to stores. | Good. Tauri + Vue works well. | VIABLE |
| Stay vanilla | Custom reactive stores + manual DOM. Full control, full burden. | No migration. But every new feature carries the full cost. | N/A | AVOID |

### Why Solid.js

Solid is the recommended choice because it has the lowest migration cost and the closest philosophical match to what OwnCord already has. Your existing reactive stores are conceptually identical to Solid signals. Solid compiles to direct DOM operations with no virtual DOM overhead, so performance stays where it is now. The migration is incremental: wrap existing stores as Solid signals, convert one component at a time, keep the WebSocket dispatcher and LiveKit facade untouched since they are framework-agnostic.

### Pros & Cons (Solid.js)

| Pros | Cons |
|------|------|
| Signals map 1:1 to existing store pattern | Smaller community than React or Vue |
| No virtual DOM — same performance as vanilla | Fewer off-the-shelf UI component libraries |
| Incremental migration (component by component) | Team must learn Solid's reactivity rules |
| Proper component lifecycle and error boundaries | Some vanilla patterns don't translate directly |
| Strong TypeScript support (first-class) | Migration is still weeks of work even incrementally |
| Small bundle size (~7KB gzipped) | |
| Vite integration is native (no config changes) | |

### Migration Strategy

1. Install Solid.js and configure Vite for JSX/TSX. Keep all existing code working — Solid and vanilla coexist.
2. Wrap existing stores as Solid signals using a thin adapter. This lets new Solid components read from existing state immediately.
3. Convert one leaf component (a simple, self-contained UI element) to Solid as a proof of concept. Validate that it works in the Tauri WebView.
4. Migrate components bottom-up: leaf components first, then containers. Each converted component is a self-contained PR.
5. Leave framework-agnostic code (dispatcher, LiveKit facade, API client, crypto) untouched. These don't need to change.
6. Once all components are migrated, remove the old DOM manipulation utilities and the custom component model.

---

## Step 7: Event Persistence Layer

> **NEW IN V2** — This step was a deferred TODO in v1. At community scale the 1000-event ring buffer is insufficient — 100 active users can burn through it in minutes.

**Effort:** Medium (1–2 weeks) | **Impact:** High | **Phase:** B — Acceleration

### Problem

The current reconnection protocol uses a 1000-event in-memory ring buffer. When a client reconnects, the server replays missed events from the buffer. At 100+ active users, a busy server generates 1000 events in minutes. Any user who goes offline for 10–15 minutes will find their last_seq is no longer in the buffer, forcing a full ready re-sync. That re-sync serializes all channels, permissions, member lists, and presence state — an expensive operation that gets more expensive with more users and channels.

### Solution

Implement a tiered event persistence model. Keep the in-memory ring buffer for hot events (last ~60 seconds). Write events to the database (via the Store interface from Step 3) for cold replay. On reconnect, the server first checks the ring buffer. If last_seq is too old, it queries the database for events since last_seq up to a reasonable limit. Only if both are exhausted does it fall back to a full ready re-sync. Events in the database are pruned after a configurable retention period (default: 24 hours).

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **Tiered (buffer + DB)** | Ring buffer for hot path, database for cold replay. Best balance of performance and reliability. Uses existing Store interface. | **RECOMMENDED** |
| Larger ring buffer | Increase from 1000 to 50000 events in memory. Simple but uses significant RAM and is still lossy. | VIABLE |
| External event log | Use NATS JetStream or Redis Streams. Robust but adds an external dependency to self-hosted deployments. | AVOID |
| Status quo | Keep 1000-event buffer. Works for friend groups, fails at community scale. | AVOID |

### Pros & Cons (Tiered)

| Pros | Cons |
|------|------|
| Hot path stays fast (in-memory ring buffer) | Event writes add DB load (mitigated by batching) |
| Cold replay from DB handles longer disconnections | Must handle event serialization/deserialization |
| Full re-sync becomes rare instead of common | Retention pruning adds a background job |
| Uses existing Store interface — no new dependencies | Query performance matters — needs indexed seq column |
| Configurable retention (24h default) keeps DB size bounded | Two code paths for replay (buffer vs DB) add complexity |
| Architecture was already designed to be persistence-ready | |

### Implementation Plan

1. Add an events table to the schema (both SQLite and PostgreSQL migrations): seq INTEGER PRIMARY KEY, event_type TEXT, payload BLOB, channel_id TEXT, created_at TIMESTAMP. Index on (channel_id, seq).
2. Add PersistEvent and GetEventsSince methods to the Store interface. The SQLite implementation uses INSERT with write batching (flush every 100ms or 50 events, whichever comes first).
3. Modify the reconnection handler: check ring buffer first, then query DB, then fall back to full re-sync. Each tier returns the events it can plus a "complete" flag.
4. Add a background goroutine that prunes events older than the retention period (configurable, default 24h). Runs every hour.
5. Add metrics for reconnection tier hits (buffer/db/full) to feed into OpenTelemetry (Step 8).

---

## Step 8: Add OpenTelemetry for Observability

> **MOVED UP FROM PHASE C** — This step was Phase C in v1. Community hub operators expect pluggable monitoring from day one.

**Effort:** Medium (1–2 weeks) | **Impact:** High | **Phase:** B — Acceleration

### Problem

The current observability is custom: a /metrics endpoint with hand-picked counters, structured logging across two libraries, and client-side JSONL logs. Community hub operators running servers for 100+ people need plug-and-play compatibility with their existing monitoring stack (Prometheus, Grafana, Datadog). They also need distributed tracing to diagnose slow requests when users report latency.

### Solution

Integrate the OpenTelemetry Go SDK. Instrument the Chi router middleware for automatic HTTP tracing, add spans to service layer methods, and export metrics in Prometheus format via OTLP. Self-hosters get plug-and-play compatibility with whatever monitoring they already run. This replaces the custom /metrics endpoint with an industry-standard exporter.

### What to Instrument

- **HTTP layer:** Chi middleware for automatic request tracing — method, path, status code, duration. This is a single middleware addition.
- **Service layer:** Spans around key service methods (CreateMessage, EditMessage, CheckPermission, etc.). This shows where time is spent in business logic.
- **Database layer:** Query timing and connection pool metrics. Shows when the DB is the bottleneck.
- **WebSocket layer:** Custom metrics for messages/second, active connections, broadcast latency, reconnection rates (by tier from Step 7).
- **LiveKit:** Voice session metrics — active sessions, participant count, connection quality distribution.

### Pros & Cons

| Pros | Cons |
|------|------|
| Self-hosters plug into existing monitoring (Grafana, Datadog, etc.) | OTel SDK adds ~5MB to binary size |
| Distributed tracing across REST → Service → DB | Tracing overhead (small but nonzero) on every request |
| Replaces custom /metrics with industry-standard export | Configuration complexity for exporters |
| Chi and database drivers have OTel middleware available | Additional Docker Compose services (collector) for full setup |
| Essential for community hub operators to diagnose issues | |
