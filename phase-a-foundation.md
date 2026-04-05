# OwnCord — Phase A: Foundation

**Steps 1–5 | Weeks 1–7 | Community Scale Edition**

*Service Layer • Type-Safe DB • PostgreSQL Target • Logging • Pub/Sub Hub*

---

## Phase Overview

Phase A builds the server-side foundation that everything else depends on. These 5 steps transform the Go backend from a working alpha into an architecture that can carry 100+ concurrent users and 146 remaining features. Nothing in Phase B or C works well without this foundation in place.

The service layer (Step 1) is the prerequisite for the pub/sub hub (Step 5) and the DB interface (Step 3). sqlc (Step 2) feeds into Step 3. Logging consolidation (Step 4) is a quick win done in any gap. The pub/sub refactor (Step 5) was Phase B in v1 but moves up here because at community scale the iterate-and-filter broadcast model breaks down.

### Timeline

| Step | Task | Duration | Depends On | Parallel? |
|------|------|----------|------------|-----------|
| 1 | Extract service/domain layer + permission cache | 2–3 weeks | — | No |
| 2 | Adopt sqlc | 1 week | — | Yes (with 1) |
| 3 | Abstract DB + PostgreSQL target | 2–3 weeks | Steps 1+2 | No |
| 4 | Consolidate logging | 1–2 days | — | Yes (anytime) |
| 5 | Refactor hub to pub/sub + global rate limits | 2–3 weeks | Step 1 | After Step 1 |

### Milestone Gate

**After Phase A:** The server has a clean service layer, type-safe queries, a dual-database backend, efficient pub/sub broadcasting, and consistent logging. You can start building community-scale features (roles, permissions, moderation) on a foundation that will carry them.

---

## Step 1: Extract Service / Domain Layer

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

Business logic is scattered across REST handlers (api/), WebSocket handlers (ws/), and database queries (db/). When a feature like message editing needs permission checks, content validation, slowmode enforcement, notification triggers, read state updates, and a broadcast event, that logic must exist in both the REST path and the WebSocket path. Without a central service layer, logic is duplicated, tested twice, and inevitably diverges. At community scale, this divergence becomes a source of permission bypass bugs and inconsistent behavior.

### Solution

Create a Server/service/ package containing domain services: MessageService, ChannelService, PermissionService, ModerationService, UserService. Both REST and WebSocket handlers become thin adapters that parse input, call the appropriate service method, and format the response. All business rules, validation, and side effects live in one place.

### Community Scale Considerations

At 100+ users, the service layer also becomes the natural place for connection-scoped permission caching. Rather than querying the database for permissions on every message send, the PermissionService maintains a cached permission set per user that gets invalidated on role changes or channel permission updates. This is critical for broadcast performance — the pub/sub layer (Step 5) needs fast permission lookups, not database round-trips.

### Pros & Cons

| Pros | Cons |
|------|------|
| Single source of truth for all business rules | Upfront refactoring cost across existing handlers |
| Handlers become trivial to write and review | Requires defining clear service interfaces |
| Service methods are independently unit-testable | Adds an abstraction layer (more files to navigate) |
| Eliminates logic duplication between REST and WS | Must migrate carefully to avoid breaking tests |
| Natural home for permission caching at scale | Permission cache invalidation adds complexity |
| Clean dependency injection via deps.go pattern | |

### Implementation Plan

1. Define service interfaces for each domain (MessageService, ChannelService, etc.) with methods matching the operations you need.
2. Extract existing business logic from handlers into service implementations. Start with MessageService since chat is the most active domain.
3. Add a PermissionService with an in-memory cache per user. Cache is populated on connection, invalidated on role/channel permission changes via an internal event.
4. Wire services via dependency injection through the existing deps.go pattern. Handlers receive a service instance, not a DB connection.
5. Migrate one handler domain at a time using the strangler-fig pattern already established in the V2 migration.

---

## Step 2: Adopt sqlc for Type-Safe Database Access

**Effort:** Low (1 week) | **Impact:** High | **Phase:** A — Foundation

### Problem

Every database query is hand-written Go code with manual struct mapping. Each new feature adds more queries, and each query is a chance for silent field mismatches or type errors that only surface at runtime. With PostgreSQL as a second backend (Step 3), maintaining two sets of hand-written queries would be unsustainable.

### Solution

Adopt sqlc. Write SQL queries in .sql files, run sqlc generate, get type-safe Go functions with correct structs. You keep full control over the SQL (critical for SQLite-specific features like FTS5 and permission bitfields) but get compile-time safety for free. sqlc also supports generating queries for both SQLite and PostgreSQL from the same schema, which directly enables Step 3.

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **sqlc** | SQL-first: you write SQL, it generates Go. Full control over queries, compile-time type safety, zero runtime overhead. Supports both SQLite and PostgreSQL. | **RECOMMENDED** |
| sqlx | Query builder with compile-time checking. More dynamic but less control. Heavier runtime. | VIABLE |
| GORM / Ent | Full ORM. Hides SQL behind Go structs. Fights you on complex queries, FTS5, bitfields. Performance overhead at scale. | AVOID |
| Status quo | Continue hand-writing query functions. Doesn't scale, doubles work when adding PostgreSQL. | AVOID |

### Pros & Cons (sqlc)

| Pros | Cons |
|------|------|
| Compile-time type safety for every query | Adds a code generation step to the build |
| Auto-generated structs match your schema exactly | Dynamic queries (variable WHERE clauses) need workarounds |
| You still write raw SQL — full control | Team must learn sqlc conventions and annotations |
| Zero runtime overhead (no reflection) | Some SQLite/PostgreSQL differences need separate query files |
| Supports generating for both SQLite and PostgreSQL | |
| Mechanical migration: copy existing SQL into .sql files | |

---

## Step 3: Abstract DB + PostgreSQL as First-Class Target

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

SQLite serializes all writes through a single WAL. At 100+ concurrent users generating messages, reactions, presence updates, read state changes, and typing indicators, write contention creates latency spikes. The pure-Go SQLite driver (modernc.org/sqlite) is slower than CGO alternatives, compounding this. Community hub mode requires a database that handles concurrent writes gracefully.

### Solution

Define a **store.Store** interface that the service layer calls. Implement both **SQLiteStore** (default for friend groups, zero-config) and **PostgresStore** (for community hubs, configurable in owncord.toml). SQLite remains the default. PostgreSQL is opt-in for operators who need scale.

#### PostgreSQL-Specific Requirements

- **Connection pooling:** Use pgxpool for connection management. Community hubs need 20–50 pooled connections to handle concurrent reads and writes.
- **Full-text search:** SQLite uses FTS5. PostgreSQL uses tsvector/tsquery with GIN indexes. The Store interface must abstract search so the caller doesn't know which engine is running.
- **Migrations:** Maintain parallel migration sets — one for SQLite, one for PostgreSQL. sqlc can generate query code for both from the same logical queries.
- **Config:** owncord.toml gets a database section: type = "sqlite" (default) or type = "postgres" with a connection string.

### Options (PostgreSQL Driver)

| Option | Details | Verdict |
|--------|---------|---------|
| **pgx + pgxpool** | Pure Go PostgreSQL driver. High performance, connection pooling built in, excellent type support. | **RECOMMENDED** |
| lib/pq | Older Go PostgreSQL driver. Stable but no longer actively developed. No built-in pooling. | AVOID |
| SQLite only | Skip PostgreSQL entirely. Works for friend groups but creates a hard ceiling for community hubs. | AVOID |

### Pros & Cons

| Pros | Cons |
|------|------|
| PostgreSQL handles concurrent writes natively | Two database backends to maintain and test |
| SQLite stays as zero-config default | FTS5 vs tsvector differences need careful abstraction |
| In-memory store for faster unit tests | Parallel migration sets add maintenance cost |
| Self-hosters choose the DB that fits their scale | PostgreSQL adds an external dependency for community hubs |
| pgxpool handles connection lifecycle automatically | Interface design requires upfront thought |
| Forces clean separation between queries and logic | CI must test both backends |

---

## Step 4: Consolidate to One Logging Library

**Effort:** Low (1–2 days) | **Impact:** Medium | **Phase:** A — Foundation

### Problem

The server imports both uber.org/zap and rs/zerolog. They serve the same purpose but produce different output formats, require separate configuration, and create ambiguity about which to import. At community scale, consistent log formatting matters because operators need to parse logs reliably for monitoring and alerting.

### Options

| Option | Details | Verdict |
|--------|---------|---------|
| **zerolog** | Lower allocations, simpler API, smaller binary. Fits the lean single-binary philosophy. Zero-allocation JSON output. | **RECOMMENDED** |
| zap | Larger ecosystem, more middleware integrations. Slightly higher allocation but battle-tested. | VIABLE |
| log/slog | Go standard library (1.21+). No external dependency, structured logging, pluggable backends. | VIABLE |
| Keep both | Inconsistent logs, double config, operator confusion. Unacceptable at community scale. | AVOID |

### Recommendation

**zerolog** is the recommended choice. It aligns with OwnCord's lean-binary philosophy and produces zero-allocation JSON logs. **log/slog** is a strong alternative if you want zero external logging dependencies. Either way, pick one and do a project-wide find-and-replace. This is a one-session task.

---

## Step 5: Refactor Hub to Pub/Sub Broadcast Model

> **MOVED UP FROM PHASE B** — This step was Phase B in v1. At community scale it is foundational — the iterate-and-filter broadcast model breaks down at 100+ connections.

**Effort:** Medium (2–3 weeks) | **Impact:** Critical | **Phase:** A — Foundation

### Problem

The hub currently iterates all connections and checks permissions per message. At 100 users across 20 channels, that's 100 permission checks for every message in any channel — 80 of which are wasted because those users aren't in that channel. Add role-based visibility, DND suppression, notification overrides, and thread subscriptions, and every broadcast becomes a complex routing computation that scales linearly with total connections, not with relevant subscribers.

### Solution

Refactor to an internal pub/sub model. Each chat channel maps to a topic. Connections subscribe to topics based on their current permissions (fed by the PermissionService cache from Step 1). Broadcasting becomes publishing to a topic — the routing is pre-computed at subscription time, not evaluated per message.

### Community Scale Additions

- **Global rate limiting:** Add server-wide throughput caps alongside per-connection limits. A busy channel should not saturate the broadcast loop and starve other channels.
- **Backpressure handling:** When a slow client can't keep up, the pub/sub layer should drop low-priority events (typing indicators first, then presence) or force a reconnect.
- **Priority queues:** Direct mentions and DMs should have higher priority than typing indicators or presence updates. The pub/sub model should support priority tiers.

### Pros & Cons

| Pros | Cons |
|------|------|
| Broadcast cost is O(subscribers) not O(all connections) | Requires rethinking the current hub architecture |
| Permission checks happen at subscribe time, not per message | Subscription management adds complexity (stale subscriptions) |
| Natural model for threads, DMs, and announcement channels | Permission changes trigger re-subscription (must be fast) |
| Cleanly separates connection management from message routing | Priority queue implementation adds complexity |
| Enables priority tiers and backpressure handling | Testing pub/sub is more involved than testing a simple loop |
| Global rate limiting becomes straightforward per-topic | |
