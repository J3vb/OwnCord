# OwnCord Engineering Improvements: Research Report

*Generated: 2026-03-20 | Sources: 25+ | Scope: Coding standards, patterns, and methods only (no new features)*

## Executive Summary

OwnCord's architecture is fundamentally sound — the Go hub pattern with channel-based message routing, immutable reactive stores, layered client architecture, and protocol-first design all align with industry best practices from Discord, Matrix/Element, and other production chat platforms. This report identifies **14 improvement areas** where existing code can be strengthened through better patterns, stricter standards, and proven techniques from mature platforms.

---

## 1. Go Server: Error Handling & Sentinel Errors

### Current State
OwnCord uses `fmt.Errorf` and inline error strings throughout handlers. Error checks like `if err != nil` return generic messages.

### What Production Platforms Do
Discord's Go services and Matrix's Dendrite server use **sentinel errors** with `errors.Is`/`errors.As` for well-defined failure conditions, and **error wrapping** with `%w` to preserve context chains.

### Recommendation
- Define sentinel errors in the `db` package: `var ErrNotFound = errors.New("not found")`, `var ErrForbidden = errors.New("forbidden")`, etc.
- Wrap errors with context: `return fmt.Errorf("CreateMessage channel=%d: %w", channelID, err)` instead of bare `return err`
- In handlers, use `errors.Is(err, db.ErrNotFound)` to map to protocol error codes cleanly
- This eliminates string-matching for error classification and makes error flows testable

**Sources:**
- [Robust Go: Best Practices for Error Handling](https://leapcell.io/blog/robust-go-best-practices-for-error-handling)
- [Go slog structured logging guide](https://go.dev/blog/slog)

---

## 2. Go Server: Structured Logging Levels

### Current State
OwnCord uses `slog.Info` for most log lines, including routine operations like `"message sent"` and `"channel_focus"`. This creates noise in production.

### What Production Platforms Do
Matrix's Synapse and Dendrite use tiered logging: `Debug` for per-message flow, `Info` for connection lifecycle events, `Warn` for recoverable issues, `Error` for things that need attention.

### Recommendation
- **Debug:** Per-message dispatch, typing events, presence updates, broadcast delivery counts
- **Info:** Connection/disconnection, auth success, voice join/leave
- **Warn:** Rate limit hits, malformed messages, non-fatal DB errors
- **Error:** DB write failures, LiveKit communication failures, unrecoverable states

Specific lines to change:
- `handlers.go:230` "message sent" → `slog.Debug`
- `handlers.go:513` "channel_focus" → `slog.Debug`
- `serve.go:65-66` "websocket connected" + audit log → keep `slog.Info`

**Sources:**
- [Logging in Go with Slog: The Ultimate Guide](https://betterstack.com/community/guides/logging/logging-in-go/)

---

## 3. Go Server: Message Builder Type Safety

### Current State
All WebSocket messages are built using `map[string]any` (e.g., `buildChatMessage`, `buildAuthOK`). This has zero compile-time safety — a typo in a key name or wrong type silently produces broken protocol messages.

### What Production Platforms Do
Matrix's Dendrite and Revolt's server define **typed structs** for every protocol message and use `json.Marshal` on those structs.

### Recommendation
Define typed structs matching PROTOCOL.md:

```go
type ChatMessagePayload struct {
    ID        int64             `json:"id"`
    ChannelID int64             `json:"channel_id"`
    User      UserSummary       `json:"user"`
    Content   string            `json:"content"`
    Timestamp string            `json:"timestamp"`
    ReplyTo   *int64            `json:"reply_to"`
    Attachments []AttachmentInfo `json:"attachments,omitempty"`
}

type ServerMessage struct {
    Type    string      `json:"type"`
    ID      string      `json:"id,omitempty"`
    Payload interface{} `json:"payload"`
}
```

Benefits: compile-time field validation, IDE autocomplete, easier protocol evolution, automatic documentation via godoc.

---

## 4. Go Server: Graceful Shutdown & Connection Draining

### Current State
`Hub.GracefulStop()` stops LiveKit and closes the hub channel, but doesn't drain existing connections or wait for in-flight messages.

### What Production Platforms Do
Discord's gateway servers use **connection draining**: on shutdown signal, stop accepting new connections, send `server_restart` to all clients, wait for a grace period (5-10s), then close remaining connections.

### Recommendation
```
1. Signal received → h.BroadcastServerRestart("shutdown", 5)
2. Stop accepting new WS upgrades (close HTTP listener)
3. time.Sleep(5 * time.Second) or wait for all clients to disconnect
4. h.Stop() → close remaining connections
```

This pairs with the existing `server_restart` protocol message — just needs the server-side orchestration.

**Sources:**
- [Go WebSocket Server Guide: production best practices](https://websocket.org/guides/languages/go/)
- [Discord engineering: gateway resilience](https://medium.com/@neerupujari5/why-discord-rarely-goes-down-8-engineering-principles-you-should-copy-today-704ee44b42a9)

---

## 5. Client: Component Lifecycle & Memory Leak Prevention

### Current State
Components use `mount()`/`destroy()` with manual `unsub()` calls. Some components may not clean up all event listeners, timers, or DOM references.

### What Production Platforms Do
Element/Matrix uses a disposable pattern where every subscription, timer, and event listener is tracked in a cleanup array and flushed on unmount.

### Recommendation
Add a `Disposable` mixin/base pattern:

```typescript
class Disposable {
  private cleanups: Array<() => void> = [];

  protected addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  protected onStoreChange<T>(store: Store<T>, listener: (s: T) => void): void {
    this.addCleanup(store.subscribe(listener));
  }

  protected onEvent(el: EventTarget, event: string, handler: EventListener): void {
    el.addEventListener(event, handler);
    this.addCleanup(() => el.removeEventListener(event, handler));
  }

  protected onInterval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.addCleanup(() => clearInterval(id));
  }

  destroy(): void {
    for (const fn of this.cleanups) fn();
    this.cleanups.length = 0;
  }
}
```

Every component extends `Disposable` instead of manually tracking `unsub` arrays. This is how Element Web, Rocket.Chat, and most production chat clients prevent leaks.

**Sources:**
- [Fixing Memory Leaks: Best Practices](https://suggestron.com/2025/05/18/fixing-memory-leaks-in-react-angular-and-vue-js-best-practices-and-tools/)
- [JavaScript Memory Leaks in 2025](https://medium.com/@deval93/javascript-memory-leaks-in-2025-how-to-detect-prevent-and-fix-them-ade013bd8b46)

---

## 6. Client: Virtual Scrolling for Message List

### Current State
`MessageList.ts` renders all loaded messages as DOM elements. As conversation history grows, DOM size increases linearly, causing:
- Increasing memory usage
- Slower re-renders
- Scroll jank

### What Production Platforms Do
Discord uses virtual scrolling — only messages visible in the viewport (plus a small buffer) exist as DOM elements. Stream Chat, Rocket.Chat, and Element all use this pattern. Kreya reports rendering millions of messages without lag using this approach.

### Recommendation
Implement a windowed rendering approach:
1. Maintain the full message array in the store (current behavior — keep this)
2. Only render messages in `[scrollTop - buffer, scrollTop + viewportHeight + buffer]`
3. Use a sentinel element at top/bottom to trigger pagination
4. Recycle DOM nodes instead of creating/destroying on scroll

Key consideration: chat messages have variable heights, so use a height-estimation cache (measure once, cache, re-measure on resize).

**Sources:**
- [Virtual Scrolling: Rendering millions of messages without lag](https://kreya.app/blog/using-virtual-scrolling/)
- [Rocket.Chat issue #5111: Infinite scroll without DOM manipulation](https://github.com/RocketChat/Rocket.Chat/issues/5111)

---

## 7. Protocol: Message Delivery Acknowledgment

### Current State
`chat_send` gets a `chat_send_ok` ack — good. But broadcasts (`chat_message`, `chat_edited`, `chat_deleted`, etc.) have no delivery guarantee. If a client misses a broadcast due to a brief disconnect, the message is lost from their view until they reload.

### What Production Platforms Do
- Discord uses **sequence numbers** on gateway events. On reconnect, the client sends the last sequence number and gets missed events replayed.
- Matrix uses a **sync token** — each sync response includes a `next_batch` token. On reconnect, the client resumes from its last token.
- Slack uses a similar **event ID** approach.

### Recommendation
Add a monotonic `seq` field to all server→client broadcasts:
```json
{ "type": "chat_message", "seq": 4821, "payload": { ... } }
```

On reconnect, the client sends `{ "type": "auth", "payload": { "token": "...", "last_seq": 4820 } }`. The server replays events from `last_seq + 1` to current. This requires:
1. A bounded event buffer on the server (ring buffer of last N events per channel)
2. A `seq` counter on the Hub
3. Client-side gap detection: if received `seq` skips a number, request a resync

This is the single highest-impact improvement for reliability — every major chat platform implements this pattern.

**Sources:**
- [WebSocket Reconnection: State Sync and Recovery Guide](https://websocket.org/guides/reconnection/)
- [WebSocket reliability in realtime](https://ably.com/topic/websocket-reliability-in-realtime-infrastructure)
- [Discord: why it rarely fails](https://medium.com/@neerupujari5/why-discord-rarely-goes-down-8-engineering-principles-you-should-copy-today-704ee44b42a9)

---

## 8. Protocol: Heartbeat Improvements

### Current State
Client sends `ping` every 30s. Server responds with `pong`. No server-initiated keepalive. If the server detects a dead connection, it only notices when a `conn.Read` or `conn.Write` fails.

### What Production Platforms Do
Discord's gateway sends server-initiated heartbeats at a specified interval (sent in the `HELLO` event). If the client misses sending a heartbeat response, the server closes the connection. This is bidirectional: both sides monitor liveness.

### Recommendation
- Server should also track last-received-message time per client
- If no message received from a client in 60s (2x heartbeat interval), close the connection as stale
- This prevents "ghost connections" where the client process crashed but TCP hasn't timed out yet
- The `readPump` can check `time.Since(c.lastActivity)` periodically

---

## 9. SQLite: Performance Pragmas

### Current State
OwnCord uses SQLite in WAL mode (good). But additional pragmas can significantly improve performance.

### What Production Deployments Do
The most-cited SQLite performance tuning guide recommends these pragmas for production chat workloads:

### Recommendation
Ensure these pragmas are set at connection init:
```sql
PRAGMA journal_mode = WAL;          -- already done
PRAGMA synchronous = NORMAL;        -- safe with WAL, 2x faster than FULL
PRAGMA temp_store = MEMORY;         -- temp tables in RAM
PRAGMA mmap_size = 268435456;       -- 256MB memory-mapped I/O
PRAGMA cache_size = -64000;         -- 64MB page cache
PRAGMA wal_autocheckpoint = 1000;   -- optimal checkpoint interval
PRAGMA busy_timeout = 5000;         -- wait 5s on lock instead of immediate SQLITE_BUSY
PRAGMA foreign_keys = ON;           -- enforce referential integrity
```

Also: periodic `PRAGMA optimize` (once per connection close) lets SQLite auto-tune its query planner.

**Sources:**
- [SQLite performance tuning (phiresky)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
- [SQLite Performance Optimization Guide 2026](https://forwardemail.net/en/blog/docs/sqlite-performance-optimization-pragma-chacha20-production-guide)
- [SQLite Optimizations For Ultra High-Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)

---

## 10. Client: Store Subscription Efficiency

### Current State
`store.ts` uses `queueMicrotask` for batched notifications — excellent. But `subscribe()` fires on EVERY state change, and components must use `subscribeSelector` manually to avoid unnecessary re-renders.

### What Production Platforms Do
Element uses a Flux dispatcher with fine-grained event types. Zustand (used by many production apps) defaults to selector-based subscriptions with shallow equality.

### Recommendation
- Make `subscribeSelector` the primary API. Rename it to just `subscribe` and make the old `subscribe` into `subscribeAll` (rare use case)
- Add a built-in `shallowEqual` comparator for array/object selectors
- Consider adding a `batch()` utility for coordinated multi-store updates (e.g., when the `ready` payload updates channels, members, voice states, and roles simultaneously)

This reduces wasted re-renders and is the pattern used by Zustand, Jotai, and Redux Toolkit.

---

## 11. Client: WebSocket Reconnection with State Recovery

### Current State
`ws.ts` has exponential backoff reconnection — good. But on reconnect, the client re-authenticates and gets a fresh `ready` payload. Any messages received between disconnect and reconnect are lost.

### What Production Platforms Do
- Discord replays missed events using sequence numbers (see #7)
- Slack has a "catch up" mechanism that fetches missed events on reconnect
- Matrix resumes from the last sync token

### Recommendation (client side of #7)
1. Track last received `seq` number
2. On reconnect, send `last_seq` in the auth message
3. If the server can replay, process the replayed events normally
4. If too far behind (server returns `"resync_required"`), do a full state refresh (current behavior)
5. During reconnect, queue outbound messages locally and flush after reconnection

---

## 12. Go Server: Request-Scoped Structured Logging

### Current State
Log lines include `user_id` and sometimes `channel_id`, but each log call adds these manually. There's no correlation ID across a single message's lifecycle.

### What Production Platforms Do
Matrix's Dendrite uses request-scoped loggers with `slog.With()` to carry context through an entire handler chain.

### Recommendation
In `handleMessage`, create a request-scoped logger:
```go
reqLog := slog.With(
    "user_id", c.userID,
    "msg_type", env.Type,
    "req_id", env.ID,
)
```
Pass `reqLog` to sub-handlers instead of using the global `slog`. This:
- Eliminates repeated `"user_id", c.userID` in every log call
- Enables tracing a single message through its entire lifecycle
- Makes log grep/filter much easier in production

**Sources:**
- [Structured Logging with slog (Go blog)](https://go.dev/blog/slog)

---

## 13. Testing: WebSocket Integration Test Patterns

### Current State
Tests use `NewTestClient` with bare send channels — functional but doesn't test the actual WebSocket upgrade, serialization, or connection lifecycle.

### What Production Platforms Do
Matrix's Dendrite has a `test.Server` that starts a real HTTP server, upgrades to WebSocket, and runs scenarios end-to-end. Mumble has protocol-level integration tests.

### Recommendation
Add a thin integration test layer:
1. Start a test HTTP server with `httptest.NewServer`
2. Connect via real WebSocket (`nhooyr.io/websocket.Dial`)
3. Send auth message, receive `auth_ok` + `ready`
4. Run message send/receive scenarios
5. Test reconnection and error paths

This catches serialization bugs, protocol violations, and concurrency issues that unit tests with mock channels miss. Keep existing unit tests as-is — add this as a separate `_integration_test.go` file.

---

## 14. Client: TypeScript Strict Mode Enforcement

### Current State
The client uses TypeScript but some patterns (like `as unknown as` casts in ws.ts listener registry) bypass type safety.

### What Production Platforms Do
Element Web uses strict TypeScript with `"strict": true` and avoids `any` types. Revolt's client also enforces strict mode.

### Recommendation
- Audit `tsconfig.json` for `"strict": true`, `"noUncheckedIndexedAccess": true`
- Replace `as unknown as` casts with proper generics or discriminated union narrowing
- The ws.ts listener registry can use a generic `Map<T, Set<WsListener<T>>>` pattern that avoids casts entirely
- Replace `map[string]any` equivalent patterns (`Record<string, unknown>`) with typed interfaces

---

## Key Takeaways (Priority Order)

1. **Message sequence numbers + replay on reconnect** (#7, #11) — highest-impact reliability improvement; every major platform does this
2. **Typed message structs in Go** (#3) — eliminates an entire class of silent protocol bugs
3. **Virtual scrolling for messages** (#6) — prevents performance degradation as conversations grow
4. **Disposable component pattern** (#5) — systematic prevention of memory leaks
5. **SQLite pragma tuning** (#9) — free performance gains with no code changes
6. **Sentinel errors** (#1) — cleaner error handling, better testability
7. **Structured logging levels** (#2) — reduces noise, improves debuggability
8. **Request-scoped logging** (#12) — makes production debugging tractable
9. **Graceful shutdown** (#4) — prevents data loss during server restarts
10. **Server-side heartbeat monitoring** (#8) — detects ghost connections faster
11. **Store subscription efficiency** (#10) — reduces wasted re-renders
12. **WebSocket integration tests** (#13) — catches serialization/protocol bugs
13. **TypeScript strict mode** (#14) — catches type errors at compile time
14. **Heartbeat improvements** (#8) — bidirectional liveness detection

---

## Sources

1. [Go WebSocket Server Guide](https://websocket.org/guides/languages/go/)
2. [A Million WebSockets and Go](https://www.freecodecamp.org/news/million-websockets-and-go-cc58418460bb/)
3. [WebSocket Reconnection: State Sync Guide](https://websocket.org/guides/reconnection/)
4. [WebSocket Best Practices for Production](https://websocket.org/guides/best-practices/)
5. [WebSocket reliability in realtime](https://ably.com/topic/websocket-reliability-in-realtime-infrastructure)
6. [WebSocket architecture best practices](https://ably.com/topic/websocket-architecture-best-practices)
7. [Discord: handling 2.5M concurrent voice users](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc)
8. [Why Discord rarely fails: 8 engineering principles](https://medium.com/@neerupujari5/why-discord-rarely-goes-down-8-engineering-principles-you-should-copy-today-704ee44b42a9)
9. [Element Web architecture (DeepWiki)](https://deepwiki.com/element-hq/element-web)
10. [Matrix JS SDK](https://github.com/matrix-org/matrix-js-sdk)
11. [Matrix Specification](https://spec.matrix.org/latest/)
12. [SQLite performance tuning (phiresky)](https://phiresky.github.io/blog/2020/sqlite-performance-tuning/)
13. [SQLite Performance Optimization Guide 2026](https://forwardemail.net/en/blog/docs/sqlite-performance-optimization-pragma-chacha20-production-guide)
14. [SQLite Optimizations For Ultra High-Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance)
15. [Virtual Scrolling: millions of messages without lag](https://kreya.app/blog/using-virtual-scrolling/)
16. [Rocket.Chat: infinite scroll DOM issues](https://github.com/RocketChat/Rocket.Chat/issues/5111)
17. [LiveKit Documentation](https://docs.livekit.io/)
18. [LiveKit Client Protocol](https://docs.livekit.io/reference/internals/client-protocol/)
19. [Robust Go: Error Handling Best Practices](https://leapcell.io/blog/robust-go-best-practices-for-error-handling)
20. [Structured Logging with slog (Go blog)](https://go.dev/blog/slog)
21. [Logging in Go with Slog (Better Stack)](https://betterstack.com/community/guides/logging/logging-in-go/)
22. [Fixing Memory Leaks: Best Practices](https://suggestron.com/2025/05/18/fixing-memory-leaks-in-react-angular-and-vue-js-best-practices-and-tools/)
23. [JavaScript Memory Leaks in 2025](https://medium.com/@deval93/javascript-memory-leaks-in-2025-how-to-detect-prevent-and-fix-them-ade013bd8b46)
24. [Revolt Chat (GitHub)](https://github.com/revoltchat)
25. [Building Scalable Real-Time Applications with LiveKit](https://azumo.com/artificial-intelligence/ai-insights/livekit-building-production-ready-real-time-voice-and-video-applications)

---

## Methodology

Searched 20+ queries across web, analyzed 25+ sources, and cross-referenced against the current OwnCord codebase (Go server: `ws/`, `api/`, `db/`, `auth/`; Client: `lib/`, `stores/`, `components/`). Sub-questions investigated: self-hosted platform architectures, voice/video patterns, testing strategies, resilience patterns, security practices, performance optimization.
