# WebSocket Protocol Spec

All client-server communication (except file uploads, REST API
queries, and admin panel) happens over a single WebSocket connection.
Messages are JSON with a `type` and `payload`.

**Related specs:**
- [[API]] -- REST endpoints (message history, file uploads, etc.)
- [[SCHEMA]] -- Database tables and permission bitfields
- [[CLIENT-ARCHITECTURE]] -- Client-side dispatcher, stores, types
- [[VOICE-CHAT-DESIGN]] -- LiveKit voice/video architecture
- `docs/protocol-schema.json` -- Machine-readable message schema

---

## Table of Contents

1. [Transport Layer](#transport-layer)
2. [Message Envelope](#message-envelope)
3. [Sequence Numbers](#sequence-numbers)
4. [Authentication Flow](#authentication-flow)
5. [Heartbeat and Connection Liveness](#heartbeat-and-connection-liveness)
6. [Reconnection with State Recovery](#reconnection-with-state-recovery)
7. [Initial State (ready)](#initial-state-ready)
8. [Chat Messages](#chat-messages)
9. [Reactions](#reactions)
10. [Typing Indicators](#typing-indicators)
11. [Presence](#presence)
12. [Channel Focus](#channel-focus)
13. [Channel Updates](#channel-updates)
14. [Member Updates](#member-updates)
15. [Voice Signaling](#voice-signaling)
16. [Direct Messages](#direct-messages)
17. [Server Restart](#server-restart)
18. [Error Handling](#error-handling)
19. [Rate Limits](#rate-limits)
20. [Client Dispatcher Pattern](#client-dispatcher-pattern)
21. [Message Type Reference Table](#message-type-reference-table)
22. [Known Protocol Drift](#known-protocol-drift)

---

## Transport Layer

### WebSocket Endpoint

```
wss://{host}/api/v1/ws
```

The client connects via the Tauri Rust backend's WS proxy
(`ws_connect` IPC command) rather than native WebView2 WebSocket.
This is required because WebView2 rejects self-signed TLS
certificates. The Rust proxy uses TOFU (Trust On First Use)
certificate pinning.

### Connection Flow

```
Client (TS)                Rust WS Proxy                Server (Go)
    |                          |                           |
    |-- ws_connect(url) ------>|                           |
    |                          |-- TLS handshake --------->|
    |                          |   (TOFU cert pinning)     |
    |                          |<-- WebSocket upgrade ---->|
    |<-- ws-state: "open" -----|                           |
    |                          |                           |
    |-- ws_send(auth JSON) --->|-- raw bytes ------------>|
    |                          |<-- auth_ok JSON ---------|
    |<-- ws-message(JSON) -----|                           |
```

### Transport Limits

| Limit | Value | Source |
|-------|-------|--------|
| Max read size | 1 MB | `serve.go` `conn.SetReadLimit(1 << 20)` |
| Max message size (client-side) | 1 MB | `ws.ts` `DEFAULT_MAX_MESSAGE_SIZE` |
| Max message content | 4000 runes | `handlers.go` `maxMessageLen` |
| HTTP request header (proxy) | 16 KB | `livekit_proxy.rs` |
| Write timeout | 10 seconds | `serve.go` `writeTimeout` |
| Auth deadline | 10 seconds | `serve.go` `authDeadline` |
| Send buffer per client | 256 messages | `client.go` `sendBufSize` |
| Broadcast channel | 256 messages | `hub.go` channel buffer |

### Tauri IPC Events

The WS proxy emits these Tauri events:

| Event | Payload | When |
|-------|---------|------|
| `ws-message` | Raw JSON string | Server sends any message |
| `ws-state` | `"open"` or `"closed"` | Connection opens or closes |
| `ws-error` | Error string | Transport error occurs |
| `cert-tofu` | `CertTofuEvent` object | TLS certificate event |

```typescript
interface CertTofuEvent {
  host: string;
  fingerprint: string;
  status: "trusted_first_use" | "trusted" | "mismatch";
  message?: string;
  storedFingerprint?: string;
}
```

On `cert-tofu` with `status: "mismatch"`, the client blocks
reconnection (`certMismatchBlock = true`) and shows a warning
dialog. The user can accept the new fingerprint via
`ws.acceptCertFingerprint(host, fingerprint)`.

---

## Message Envelope

Every WebSocket message is a JSON object with these fields:

```json
{
  "type": "message_type",
  "id": "unique-request-id",
  "payload": { },
  "seq": 42
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Determines how `payload` is interpreted. See [[#Message Type Reference Table]] |
| `id` | string | Client messages only | Client-generated UUID for request/response correlation. Server includes the same `id` in direct responses (`chat_send_ok`, `error`). |
| `payload` | object | Yes | Contents vary by `type`. Must be present (can be `{}`). |
| `seq` | uint64 | Broadcast messages only | Monotonically increasing sequence number. Only present on server-to-client broadcast messages. NOT included on direct responses (`error`, `chat_send_ok`, `auth_ok`). |

### Envelope Go Structs

```go
// Inbound (client -> server)
type envelope struct {
    Type    string          `json:"type"`
    ID      string          `json:"id,omitempty"`
    Payload json.RawMessage `json:"payload,omitempty"`
}

// Outbound (server -> client)
type wsMsg struct {
    Type    string `json:"type"`
    ID      string `json:"id,omitempty"`
    Payload any    `json:"payload,omitempty"`
}
```

### TypeScript Envelope

```typescript
interface WsEnvelope<T> {
  readonly type: string;
  readonly id?: string;
  readonly payload: T;
}
```

The client `ws.ts` sends every message with a `crypto.randomUUID()` id.

---

## Sequence Numbers

The sequence number system enables reconnection with state
recovery by allowing the client to tell the server "replay
everything I missed."

### How seq Works

1. The hub maintains an atomic `uint64` counter (`hub.seq`).
2. Every message sent via `BroadcastToChannel()` or
   `BroadcastToAll()` gets the next seq via `hub.nextSeq()`.
3. The seq is injected into the JSON using string manipulation
   (not re-serialization) for performance:

```go
// wrapWithSeq: {"type":"chat_message",...}
//           -> {"seq":123,"type":"chat_message",...}
func wrapWithSeq(msg []byte, seq uint64) []byte {
    prefix := fmt.Sprintf(`{"seq":%d,`, seq)
    result := append([]byte(prefix), msg[1:]...)
    return result
}
```

4. The wrapped message is stored in the replay ring buffer.
5. The client tracks `lastSeq` in `ws.ts`:

```typescript
const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
if (seq > lastSeq) {
  lastSeq = seq;
}
```

### Which Messages Get seq

| Category | Has seq? | Examples |
|----------|----------|---------|
| Channel broadcasts | Yes | `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update` |
| Global broadcasts | Yes | `presence`, `member_join`, `member_leave`, `member_update`, `member_ban`, `voice_state`, `voice_leave`, `channel_create`, `channel_update`, `channel_delete`, `server_restart`, `dm_channel_open`, `dm_channel_close` |
| Ephemeral (no ring buffer) | No | `typing` (via `broadcastExclude`) |
| DM messages | No | DM `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update`, `dm_channel_open`, `dm_channel_close` (via `SendToUser`) |
| Direct responses | No | `auth_ok`, `auth_error`, `chat_send_ok`, `error`, `voice_config`, `voice_token`, `pong` |

### Message Delivery

```
                   handleMessage()
                        |
                        v
              +---------+-----------+
              |                     |
    c.sendMsg(response)    BroadcastToChannel(msg)
    [direct, no seq]       [via broadcast chan]
                                    |
                                    v
                           deliverBroadcast()
                                    |
                        +-----------+-----------+
                        |                       |
                   nextSeq()            replayBuf.Push()
                   wrapWithSeq()        [store for replay]
                        |
                        v
                   h.mu.RLock()
                   iterate clients
                   c.sendMsg(msg)
```

---

## Authentication Flow

### Step 1: Client Sends auth

After the WebSocket connection is established (`ws-state: "open"`),
the client sends the first message within 10 seconds:

```json
{
  "type": "auth",
  "payload": {
    "token": "session-token-from-login",
    "last_seq": 0
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `token` | string | Yes | Session token obtained from `POST /api/auth/login` |
| `last_seq` | uint64 | No | Last sequence number received. If > 0, server attempts replay. Default 0. |

### Step 2: Server Authenticates

The server (`authenticateConn` in `serve.go`):

1. Reads the first message with a 10-second timeout.
2. Validates the envelope type is `"auth"`.
3. SHA-256 hashes the token and looks up the session.
4. Checks session expiry (`auth.IsSessionExpired`).
5. Loads the user record.
6. Checks ban status (`auth.IsEffectivelyBanned`).
7. Checks for duplicate connections (`hub.IsUserConnected`).

### Step 3a: Success -- auth_ok

```json
{
  "type": "auth_ok",
  "payload": {
    "user": {
      "id": 1,
      "username": "alex",
      "avatar": "uuid.png",
      "role": "admin"
    },
    "server_name": "My Server",
    "motd": "Welcome!"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `user.id` | number | User's database ID |
| `user.username` | string | Display name |
| `user.avatar` | string or null | Avatar filename (served from `/files/`) |
| `user.role` | string | Lowercase role name (`"admin"`, `"moderator"`, `"member"`) |
| `server_name` | string | Server display name from settings |
| `motd` | string | Message of the day from settings |

Settings are cached for 30 seconds (`settingsCacheTTL`) to avoid
per-connection DB queries.

### Step 3b: Failure -- auth_error

```json
{
  "type": "auth_error",
  "payload": {
    "message": "Invalid or expired token"
  }
}
```

Possible auth_error messages:
- `"invalid message"` -- first message was not valid JSON
- `"first message must be auth"` -- wrong message type
- `"missing token"` -- token field empty
- `"invalid token"` -- session not found in DB
- `"session expired"` -- session past expiry date
- `"user not found"` -- user deleted
- `"already connected from another client"` -- duplicate login

After sending `auth_error`, the server closes the connection.
The client treats `auth_error` as non-recoverable: sets
`intentionalClose = true` and does not reconnect.

### Step 3c: Banned -- error with BANNED code

```json
{
  "type": "error",
  "payload": {
    "code": "BANNED",
    "message": "you are banned"
  }
}
```

Banned users receive an `error` (not `auth_error`) and the
connection is closed.

### Step 4: ready Payload

After `auth_ok`, the server sends a `ready` message containing
all initial state. See [[#Initial State (ready)]].

### Step 5: Member Join + Presence

The server broadcasts to all connected clients:

```json
{ "type": "member_join", "payload": { "user": { "id": 1, "username": "alex", "avatar": "uuid.png", "role": "admin" } } }
{ "type": "presence", "payload": { "user_id": 1, "status": "online" } }
```

### Full Auth Sequence Diagram

```
Client                              Server
  |                                    |
  |---- WSS handshake (via Rust) ----->|
  |<--- 101 Switching Protocols -------|
  |                                    |
  |---- { type: "auth", payload: {     |
  |        token: "...",               |
  |        last_seq: 0                 |
  |      }} --------------------------->|
  |                                    |-- validate token
  |                                    |-- check session expiry
  |                                    |-- check ban status
  |                                    |-- check duplicate conn
  |                                    |
  |<--- { type: "auth_ok", ... } ------|
  |<--- { type: "ready", ... } --------|
  |                                    |
  |                                    |-- broadcast member_join
  |                                    |-- broadcast presence
  |                                    |
  |<--- heartbeat / message flow ----->|
```

### Periodic Session Revalidation

Every 10 messages (`SessionCheckInterval`), the server re-checks
the session token hash against the database. If the session has
been revoked, expired, or the user banned, the connection is
closed immediately via `kickClient`.

---

## Heartbeat and Connection Liveness

### Client Ping

The client sends a JSON ping every 30 seconds
(`HEARTBEAT_INTERVAL_MS = 30_000`):

```json
{ "type": "ping", "payload": {} }
```

### Server Pong

The server responds immediately:

```json
{ "type": "pong" }
```

The client silently ignores `pong` messages (no dispatch to listeners).

### Server Stale Client Sweep

Every 30 seconds, the hub's `sweepStaleClients()` iterates all
clients. Any client whose `lastActivity` is older than 90 seconds
(`staleClientTimeout`) is forcibly disconnected via `kickClient()`.

```
Timeline:
  0s   Client sends ping  → lastActivity reset
  30s  Client sends ping  → lastActivity reset
  60s  Client sends ping  → lastActivity reset
  90s  Sweep runs — client OK (within 90s)
  ...
  If client misses 3 pings (90s), next sweep kicks them.
```

Every incoming message (including pings) calls `c.touch()` which
updates `lastActivity`. So normal chat activity also keeps the
connection alive.

---

## Reconnection with State Recovery

When a connection drops unexpectedly, the client automatically
reconnects with exponential backoff (1s to 30s max) and sends
`last_seq` in the `auth` message. The server replays missed
events from a 1,000-event ring buffer, or falls back to a full
`ready` payload if too far behind.

| Condition | Server Behavior |
|-----------|-----------------|
| `last_seq == 0` | Full flow: `auth_ok` + `ready` + `member_join` + `presence` |
| `last_seq > 0` AND seq in buffer | Replay flow: `auth_ok` + missed events + `presence` (no `member_join`, no `ready`) |
| `last_seq > 0` AND seq NOT in buffer | Full flow (fallback): same as `last_seq == 0` |

**Important:** DM events are not stored in the ring buffer (they
use `SendToUser`, not the broadcast channel). DM state is only
recoverable via the full `ready` payload.

See [[RECONNECTION]] for complete architecture: ring buffer
internals, client reconnection logic, LiveKit auto-reconnect,
TOFU certificate blocking, and edge cases.

---

## Initial State (ready)

Sent once after `auth_ok` (fresh connection or replay fallback).

### Server -> Client

```json
{
  "type": "ready",
  "payload": {
    "channels": [
      {
        "id": 1,
        "name": "general",
        "type": "text",
        "category": "Main",
        "position": 0,
        "unread_count": 3,
        "last_message_id": 1040
      },
      {
        "id": 10,
        "name": "voice-chat",
        "type": "voice",
        "category": "Main",
        "position": 1
      }
    ],
    "dm_channels": [
      {
        "channel_id": 100,
        "recipient": {
          "id": 2,
          "username": "jordan",
          "avatar": "",
          "status": "online"
        },
        "last_message_id": 500,
        "last_message": "Hey!",
        "last_message_at": "2026-03-14T10:00:00Z",
        "unread_count": 1
      }
    ],
    "members": [
      {
        "id": 1,
        "username": "alex",
        "avatar": "uuid.png",
        "role": "admin",
        "status": "online"
      }
    ],
    "voice_states": [
      {
        "channel_id": 10,
        "user_id": 2,
        "muted": false,
        "deafened": false
      }
    ],
    "roles": [
      {
        "id": 1,
        "name": "Owner",
        "color": "#E74C3C",
        "permissions": 2147483647
      },
      {
        "id": 2,
        "name": "Admin",
        "color": "#F39C12",
        "permissions": 1073741823
      },
      {
        "id": 3,
        "name": "Moderator",
        "color": "#3498DB",
        "permissions": 1048575
      },
      {
        "id": 4,
        "name": "Member",
        "color": null,
        "permissions": 7779
      }
    ],
    "server_name": "My Server",
    "motd": "Welcome!"
  }
}
```

### Payload Field Details

**channels[]:**

| Field | Type | Present On | Description |
|-------|------|-----------|-------------|
| `id` | number | All | Channel database ID |
| `name` | string | All | Channel name |
| `type` | string | All | `"text"`, `"voice"`, or `"announcement"` |
| `category` | string or null | All | Category grouping |
| `position` | number | All | Display order |
| `unread_count` | number | text only | Messages unread by this user |
| `last_message_id` | number | text only | ID of most recent message |

**dm_channels[]:**

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | number | DM channel database ID |
| `recipient` | DmRecipient | The other participant |
| `last_message_id` | number or null | Latest message ID |
| `last_message` | string | Preview of latest message |
| `last_message_at` | string (ISO 8601) | Timestamp of latest message |
| `unread_count` | number | Unread message count |

**members[]:** All registered users with `id`, `username`,
`avatar`, `role` (lowercase name), `status`.

**voice_states[]:** All users currently in any voice channel.
Only `channel_id`, `user_id`, `muted`, `deafened` (no
`speaking`/`camera`/`screenshare` — those come via live
`voice_state` events).

**roles[]:** All server roles with `id`, `name`, `color`, `permissions` (bitfield).

---

## Chat Messages

### chat_send (Client -> Server)

```json
{
  "type": "chat_send",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "channel_id": 5,
    "content": "Hello everyone!",
    "reply_to": null,
    "attachments": ["upload-uuid-1"]
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `channel_id` | number | Yes | Positive integer. Channel must exist. |
| `content` | string | Yes* | Max 4000 runes. HTML-sanitized (strict policy). *Can be empty if `attachments` is non-empty. |
| `reply_to` | number or null | No | Message ID being replied to |
| `attachments` | string[] | No | Upload IDs from `POST /api/uploads`. Requires `ATTACH_FILES` permission. |

**Processing steps (server):**

1. Rate limit: `chat:${userId}` at 10/sec.
2. Parse and validate `channel_id`.
3. Fetch channel from DB (must exist).
4. **DM branch:** If `channel.type == "dm"`, check
   `IsDMParticipant` instead of role permissions.
5. **Non-DM branch:** Check `READ_MESSAGES | SEND_MESSAGES`.
6. **Slow mode:** If `ch.SlowMode > 0` and user lacks
   `MANAGE_MESSAGES`, enforce `slow:${userId}:${channelId}`
   rate limit.
7. Sanitize content via `bluemonday.StrictPolicy()`.
8. Validate content is non-empty (or has attachments).
9. Validate content <= 4000 runes.
10. If attachments present, check `ATTACH_FILES` permission.
11. Persist message to DB (`CreateMessage`).
12. Link attachments to message (`LinkAttachmentsToMessage`).
    On failure, delete the orphaned message.
13. Re-fetch message to get timestamp.
14. Send `chat_send_ok` to sender.
15. Broadcast `chat_message` to channel (or DM participants).
16. **DM auto-reopen:** For DMs, call `OpenDM` for the
    recipient and send `dm_channel_open` if the DM was closed.

### chat_send_ok (Server -> Client)

Direct response to sender (no seq). Includes original request `id`.

```json
{
  "type": "chat_send_ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "message_id": 1042,
    "timestamp": "2026-03-14T10:30:00Z"
  }
}
```

### chat_message (Server -> Client, broadcast)

```json
{
  "seq": 42,
  "type": "chat_message",
  "payload": {
    "id": 1042,
    "channel_id": 5,
    "user": {
      "id": 1,
      "username": "alex",
      "avatar": "uuid.png",
      "role": "admin"
    },
    "content": "Hello everyone!",
    "reply_to": null,
    "timestamp": "2026-03-14T10:30:00Z",
    "attachments": [{
      "id": "upload-uuid-1",
      "filename": "photo.jpg",
      "size": 204800,
      "mime": "image/jpeg",
      "url": "/files/upload-uuid-1"
    }],
    "reactions": [],
    "pinned": false
  }
}
```

**DM delivery:** Instead of `BroadcastToChannel`, DM messages are
sent directly to both participants via `SendToUser`. This bypasses
the channel-focus subscription model, ensuring both users receive
the message regardless of which channel they're viewing.

### chat_edit (Client -> Server)

```json
{
  "type": "chat_edit",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042,
    "content": "Hello everyone! (edited)"
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `message_id` | number | Positive integer. Must be own message. |
| `content` | string | Non-empty, max 4000 runes, HTML-sanitized. |

**Processing:** Rate limited (10/sec). Checks DM participant or
`SEND_MESSAGES` permission. `EditMessage` verifies ownership internally.

### chat_edited (Server -> Client, broadcast)

```json
{
  "seq": 43,
  "type": "chat_edited",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "content": "Hello everyone! (edited)",
    "edited_at": "2026-03-14T10:31:00Z"
  }
}
```

### chat_delete (Client -> Server)

```json
{
  "type": "chat_delete",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042
  }
}
```

**Processing:** Rate limited (10/sec). For non-DM channels,
moderators with `MANAGE_MESSAGES` can delete others' messages.
In DM channels, users can only delete their own messages.
Generates an audit log entry.

### chat_deleted (Server -> Client, broadcast)

```json
{
  "seq": 44,
  "type": "chat_deleted",
  "payload": {
    "message_id": 1042,
    "channel_id": 5
  }
}
```

---

## Reactions

### reaction_add (Client -> Server)

```json
{
  "type": "reaction_add",
  "payload": {
    "message_id": 1042,
    "emoji": "\ud83d\udc4d"
  }
}
```

### reaction_remove (Client -> Server)

```json
{
  "type": "reaction_remove",
  "payload": {
    "message_id": 1042,
    "emoji": "\ud83d\udc4d"
  }
}
```

| Field | Type | Constraints |
|-------|------|-------------|
| `message_id` | number | Positive integer |
| `emoji` | string | Non-empty, max 32 bytes, no control characters (U+0000-U+001F, U+007F) |

**Processing:** Rate limited at 5/sec. DM channels check
`IsDMParticipant`; non-DM channels require `ADD_REACTIONS`
permission. Error responses use generic "reaction failed" to
prevent IDOR information leakage.

### reaction_update (Server -> Client, broadcast)

```json
{
  "seq": 45,
  "type": "reaction_update",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "emoji": "\ud83d\udc4d",
    "user_id": 1,
    "action": "add"
  }
}
```

`action` is `"add"` or `"remove"`.

---

## Typing Indicators

### typing_start (Client -> Server)

```json
{ "type": "typing_start", "payload": { "channel_id": 5 } }
```

**Processing:**
1. Rate limited: 1 per 3 seconds per user per channel.
   Rate-limited messages are silently dropped (no error sent).
2. Channel must exist. Unknown channels are silently dropped.
3. DM channels: check `IsDMParticipant` (silently drop if not).
4. Broadcast to channel members excluding sender (via
   `broadcastExclude`). For DMs, broadcast to both participants
   via `broadcastToDMParticipants`.

Typing broadcasts are ephemeral -- they are NOT stored in the
replay ring buffer (sent via `broadcastExclude`, not
`BroadcastToChannel`).

### typing (Server -> Client, broadcast)

```json
{
  "type": "typing",
  "payload": {
    "channel_id": 5,
    "user_id": 1,
    "username": "alex"
  }
}
```

**Client behavior:** Show typing indicator for 5 seconds. Reset
timer on new typing event from same user.

---

## Presence

### presence_update (Client -> Server)

```json
{ "type": "presence_update", "payload": { "status": "online" } }
```

| Field | Type | Valid Values |
|-------|------|-------------|
| `status` | string | `"online"`, `"idle"`, `"dnd"`, `"offline"` |

Rate limited: 1 per 10 seconds. Server persists to DB and
broadcasts to all clients.

### presence (Server -> Client, broadcast)

```json
{
  "seq": 50,
  "type": "presence",
  "payload": {
    "user_id": 1,
    "status": "online"
  }
}
```

**Automatic presence changes:**
- On WS connect: server sets `"online"`.
- On WS disconnect (`readPump` exit): server sets `"offline"`.
- Server auto-sets `"idle"` after 10 minutes of no WS activity
  (not yet implemented -- documented as future behavior).

---

## Channel Focus

### channel_focus (Client -> Server)

```json
{ "type": "channel_focus", "payload": { "channel_id": 5 } }
```

**Purpose:** Tells the server which channel the user is currently
viewing. This affects:

1. **Broadcast delivery:** `deliverBroadcast` only sends
   channel-scoped messages to clients whose `channelID` or
   `voiceChID` matches the target channel.
2. **Unread tracking:** Server calls `UpdateReadState` to mark
   all messages in the channel as read.

**Processing:**
1. Validate `channel_id` is positive.
2. Fetch channel from DB (must exist).
3. DM channels: check `IsDMParticipant`.
4. Non-DM channels: check `READ_MESSAGES`.
5. Update client's `channelID` field (under mutex).
6. Get latest message ID and update read state.

There is no explicit `channel_unfocus` message. Focusing a new
channel implicitly unfocuses the previous one.

---

## Channel Updates

All channel update messages are broadcast to all connected clients
(not channel-scoped). These are triggered by REST API calls from
admins, not by WebSocket messages.

### channel_create (Server -> Client, broadcast)

```json
{
  "seq": 60,
  "type": "channel_create",
  "payload": {
    "id": 8,
    "name": "gaming",
    "type": "text",
    "category": "Hangout",
    "topic": "",
    "position": 3
  }
}
```

### channel_update (Server -> Client, broadcast)

```json
{
  "seq": 61,
  "type": "channel_update",
  "payload": {
    "id": 8,
    "name": "gaming-talk",
    "type": "text",
    "category": "Hangout",
    "topic": "Gaming discussion",
    "position": 4
  }
}
```

Note: Server sends the full channel object (all fields), not a
partial update. See [[#Known Protocol Drift]].

### channel_delete (Server -> Client, broadcast)

```json
{
  "seq": 62,
  "type": "channel_delete",
  "payload": { "id": 8 }
}
```

When a voice channel is deleted, the server calls
`CleanupVoiceForChannel` which removes all voice participants from
the DB, clears their client voice state, removes them from LiveKit,
and broadcasts `voice_leave` for each.

Channel types: `"text"`, `"voice"`, `"announcement"`, `"dm"` (DM
channels are not included in channel_create/update/delete broadcasts).

---

## Member Updates

All member messages are broadcast to all connected clients.

### member_join (Server -> Client, broadcast)

```json
{
  "seq": 70,
  "type": "member_join",
  "payload": {
    "user": {
      "id": 5,
      "username": "newuser",
      "avatar": null,
      "role": "member"
    }
  }
}
```

Sent when a user first connects (fresh connection, not reconnect
replay).

### member_leave (Server -> Client, broadcast)

```json
{
  "type": "member_leave",
  "payload": { "user_id": 5 }
}
```

Note: `member_leave` is referenced in `types.ts` but the server
does not currently broadcast it (disconnect triggers a `presence`
update to `"offline"` instead).

### member_update (Server -> Client, broadcast)

```json
{
  "seq": 71,
  "type": "member_update",
  "payload": {
    "user_id": 5,
    "role": "moderator"
  }
}
```

Triggered when an admin changes a user's role via REST API.

### member_ban (Server -> Client, broadcast)

```json
{
  "seq": 72,
  "type": "member_ban",
  "payload": { "user_id": 5 }
}
```

Triggered when a user is banned via REST API.

---

## Voice Signaling

Voice uses LiveKit as the SFU. WebSocket messages handle signaling
(join/leave/state) while the actual audio/video flows through
LiveKit's own WebSocket connection. See [[VOICE-CHAT-DESIGN]] for
full architecture.

### voice_join (Client -> Server)

```json
{ "type": "voice_join", "payload": { "channel_id": 10 } }
```

**Server processing (9 steps):**

1. Parse and validate `channel_id`.
2. Check `CONNECT_VOICE` permission.
3. Validate channel exists in DB.
4. Verify LiveKit is configured and running.
5. If already in same channel: send `ALREADY_JOINED` error.
6. If in a different channel: call `handleVoiceLeave` first.
7. Check channel capacity (`voice_max_users`).
8. Persist join to DB (`JoinVoiceChannel`).
9. Generate LiveKit token with permission-based publish/subscribe grants.

**On success, server sends (in order):**

1. `voice_token` -- LiveKit JWT + URL
2. `voice_state` broadcast -- joiner's state to all clients
3. Existing `voice_state` messages -- one per existing participant (to joiner only)
4. `voice_config` -- channel audio settings (to joiner only)

**Rollback on failure:** If token generation or state retrieval
fails after DB join, `rollbackVoiceJoin` clears the client's
voice channel, removes the DB row, and broadcasts `voice_leave`.

### voice_token (Server -> Client, direct)

```json
{
  "type": "voice_token",
  "payload": {
    "channel_id": 10,
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "url": "/livekit",
    "direct_url": "ws://localhost:7880"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | number | Voice channel joined |
| `token` | string | LiveKit JWT (4-hour TTL). Contains grants: `room_join`, `room` name, `can_publish` (based on `SPEAK_VOICE` perm), `can_subscribe` (always true), `can_publish_data`. Identity: `"user-{id}"`. Name: username. |
| `url` | string | Always `"/livekit"` -- proxy path through OwnCord's HTTPS server |
| `direct_url` | string | Raw LiveKit URL (e.g., `"ws://localhost:7880"`). Used by localhost clients to avoid TLS proxy. |

**Client URL resolution:**
- Localhost connections: use `direct_url` directly.
- Remote connections: start Rust-side TLS proxy
  (`start_livekit_proxy`), connect via
  `ws://127.0.0.1:{proxy_port}/livekit/...`.

### voice_token_refresh (Client -> Server)

```json
{ "type": "voice_token_refresh", "payload": {} }
```

Rate limited: 1 per 60 seconds. Requires being in a voice channel.
Server generates a fresh LiveKit token and sends a new
`voice_token` message. The client requests this 3.5 hours into a
session (30 minutes before the 4-hour TTL expiry).

### voice_config (Server -> Client, direct)

```json
{
  "type": "voice_config",
  "payload": {
    "channel_id": 10,
    "quality": "medium",
    "bitrate": 64000,
    "max_users": 50
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `channel_id` | number | Voice channel |
| `quality` | string | `"low"`, `"medium"`, or `"high"` |
| `bitrate` | number | Target audio bitrate in bits/s (32000, 64000, or 128000) |
| `max_users` | number | Channel capacity (0 = unlimited) |

Quality presets (Go source of truth in `voice_broadcast.go`):

| Preset | Bitrate |
|--------|---------|
| `low` | 32,000 bps |
| `medium` | 64,000 bps |
| `high` | 128,000 bps |

### voice_leave (Client -> Server)

```json
{ "type": "voice_leave", "payload": {} }
```

Empty payload. Server clears voice channel from client, removes
from DB, broadcasts `voice_leave` to all, and calls
`livekit.RemoveParticipant` (best-effort).

Also called automatically on WS disconnect (`readPump` defer).

### voice_leave (Server -> Client, broadcast)

```json
{
  "seq": 80,
  "type": "voice_leave",
  "payload": {
    "channel_id": 10,
    "user_id": 1
  }
}
```

### voice_state (Server -> Client, broadcast)

```json
{
  "seq": 81,
  "type": "voice_state",
  "payload": {
    "channel_id": 10,
    "user_id": 1,
    "username": "alex",
    "muted": false,
    "deafened": false,
    "speaking": false,
    "camera": false,
    "screenshare": false
  }
}
```

Broadcast to ALL clients (not just channel members) on:
- Voice join (initial state)
- Mute/deafen/camera/screenshare toggle

### voice_mute (Client -> Server)

```json
{ "type": "voice_mute", "payload": { "muted": true } }
```

Requires being in a voice channel. Updates DB, broadcasts
`voice_state`.

### voice_deafen (Client -> Server)

```json
{ "type": "voice_deafen", "payload": { "deafened": true } }
```

Same behavior as `voice_mute`.

### voice_camera (Client -> Server)

```json
{ "type": "voice_camera", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `USE_VIDEO` permission (bit 11).
When enabling, checks `voice_max_video` limit from DB. On
exceeding limit, returns `VIDEO_LIMIT` error.

### voice_screenshare (Client -> Server)

```json
{ "type": "voice_screenshare", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `SHARE_SCREEN` permission (bit 12).

### voice_speakers (Server -> Client) -- LEGACY

Speaker detection is now handled client-side via LiveKit SDK's
`RoomEvent.ActiveSpeakersChanged`. The `voice_speakers` message
type exists in `types.ts` for backward compatibility but is NOT
sent by the current server.

### Migration Note (LiveKit)

The following Pion-era message types have been removed:
- `voice_offer` / `voice_answer` -- replaced by LiveKit token-based join
- `voice_ice` -- handled internally by LiveKit SDK
- `voice_speakers` -- client-side via LiveKit SDK events
- `voice_config.threshold_mode` -- LiveKit handles mixing internally
- `voice_config.top_speakers` -- LiveKit handles speaker selection

---

## Direct Messages

### dm_channel_open (Server -> Client)

Sent when a DM is opened, created, or auto-reopened by an
incoming message.

```json
{
  "type": "dm_channel_open",
  "payload": {
    "channel_id": 100,
    "recipient": {
      "id": 2,
      "username": "jordan",
      "avatar": "uuid.png",
      "status": "online"
    }
  }
}
```

Note: The `recipient` here is the "other user" from the
perspective of the receiving client. When user A opens a DM with
user B, user A gets `recipient: B`, and auto-reopen sends user B
a `dm_channel_open` with `recipient: A`.

### dm_channel_close (Server -> Client)

```json
{
  "type": "dm_channel_close",
  "payload": { "channel_id": 100 }
}
```

Sent when:
- REST `DELETE /api/v1/dms/{id}` is called (REST handler
  sends via `SendToUser` over WS)

Note: There is no `dm_close` WebSocket message type. DM closing
is handled exclusively via the REST endpoint, which then pushes
a `dm_channel_close` event to the user's WS connection.

DM channels persist in the database but are marked as "closed"
per user. Messages in a closed DM trigger auto-reopen.

### DM Authorization

All handlers that touch a channel check `ch.Type == "dm"` and
branch to `IsDMParticipant` instead of role-based permissions.
This applies to:
- `chat_send` -- participant check instead of `SEND_MESSAGES`
- `chat_edit` -- participant check instead of `SEND_MESSAGES`
- `chat_delete` -- participant check (no mod override in DMs)
- `reaction_add`/`reaction_remove` -- participant check instead of
  `ADD_REACTIONS`
- `typing_start` -- participant check (silent drop if not)
- `channel_focus` -- participant check instead of `READ_MESSAGES`

### DM Broadcast Pattern

DM messages bypass the channel-subscription model. Instead of
`BroadcastToChannel` (which only reaches clients focused on that
channel), DMs use `broadcastToDMParticipants` or `SendToUser`
which sends to all connections of each participant regardless of
their focused channel.

---

## Server Restart

### server_restart (Server -> Client, broadcast)

```json
{
  "seq": 100,
  "type": "server_restart",
  "payload": {
    "reason": "update",
    "delay_seconds": 5
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `reason` | string | Why the server is restarting (e.g., `"update"`, `"shutdown"`) |
| `delay_seconds` | number | Seconds until actual shutdown |

**Server behavior (`GracefulStop`):**
1. Broadcast `server_restart` to all clients.
2. Stop LiveKit process (if managed).
3. Wait 5 seconds for graceful disconnect.
4. Close all remaining client connections.
5. Stop the hub dispatch loop.

**Client behavior:** Display banner, auto-reconnect after delay.

---

## Error Handling

### error (Server -> Client)

All request failures return a standard error envelope:

```json
{
  "type": "error",
  "id": "original-req-uuid",
  "payload": {
    "code": "FORBIDDEN",
    "message": "No permission to post here"
  }
}
```

If the original request had an `id`, the error includes it for
correlation. The `id` field is omitted for broadcast-triggered
errors or system errors.

### Error Codes

| Code | Description | Context |
|------|-------------|---------|
| `BAD_REQUEST` | Invalid payload format or field values | Any handler |
| `INTERNAL` | Server-side error (DB failure, etc.) | Any handler |
| `NOT_FOUND` | Channel or message not found | chat_send, chat_edit, chat_delete, voice_join |
| `FORBIDDEN` | Missing required permission | Any permissioned action |
| `RATE_LIMITED` | Too many requests (includes `retry_after`) | Any rate-limited action |
| `ALREADY_JOINED` | Already in this voice channel | voice_join |
| `CHANNEL_FULL` | Voice channel at capacity | voice_join |
| `VOICE_ERROR` | Voice-specific error (not configured, not in channel) | voice_mute, voice_deafen, voice_join |
| `VIDEO_LIMIT` | Maximum video streams reached | voice_camera |
| `BANNED` | User is banned | auth, periodic session check |
| `INVALID_JSON` | Message is not valid JSON | envelope parse |
| `UNKNOWN_TYPE` | Unrecognized message type | dispatch |
| `SLOW_MODE` | Channel has slow mode enabled | chat_send |
| `CONFLICT` | Duplicate reaction or constraint violation | reaction_add |

### Rate Limit Error Format

```json
{
  "type": "error",
  "payload": {
    "code": "RATE_LIMITED",
    "message": "too many messages",
    "retry_after": 1
  }
}
```

`retry_after` is in seconds (float).

### Invalid JSON Handling

The server tracks consecutive invalid messages per client
(`invalidCount`). After 10 consecutive invalid messages, the
connection is forcibly closed. The counter resets on any valid
JSON parse.

---

## Rate Limits

All rate limits are enforced server-side using a token bucket
rate limiter (`auth.RateLimiter`).

| Action | Limit | Window | Key Format | Error Response |
|--------|-------|--------|-----------|----------------|
| Chat send | 10 | 1 second | `chat:{userId}` | `RATE_LIMITED` error |
| Chat edit | 10 | 1 second | `chat_edit:{userId}` | `RATE_LIMITED` error |
| Chat delete | 10 | 1 second | `chat_delete:{userId}` | `RATE_LIMITED` error |
| Typing | 1 | 3 seconds | `typing:{userId}:{channelId}` | Silently dropped |
| Presence | 1 | 10 seconds | `presence:{userId}` | `RATE_LIMITED` error |
| Reactions | 5 | 1 second | `reaction:{userId}` | `RATE_LIMITED` error |
| Voice camera | 2 | 1 second | `voice_camera:{userId}` | `RATE_LIMITED` error |
| Voice screenshare | 2 | 1 second | `voice_screenshare:{userId}` | `RATE_LIMITED` error |
| Voice token refresh | 1 | 60 seconds | `voice_token_refresh:{userId}` | `RATE_LIMITED` error |
| Slow mode | 1 | N seconds (configurable) | `slow:{userId}:{channelId}` | `SLOW_MODE` error |

---

## Client Dispatcher Pattern

The client uses a dispatcher pattern (`lib/dispatcher.ts`) to wire
WebSocket events to store updates. The `wireDispatcher()` function
registers listeners on the `WsClient` and returns a cleanup function.

### Architecture

```
WsClient.handleMessage(raw)
    |
    v
  parse JSON -> extract type, payload, id, seq
    |
    v
  track lastSeq (if seq > lastSeq)
    |
    v
  dispatch(msg) -> iterate listeners for msg.type
    |
    +--> dispatcher listener -> update stores
    +--> livekitSession listener (voice_token)
    +--> component-specific listeners
```

### Dispatcher Mappings

| Server Message | Store Action(s) |
|----------------|-----------------|
| `auth_ok` | `setAuth(token, user, server_name, motd)` |
| `auth_error` | `setTransientError`, `clearAuth` |
| `ready` | `setChannels`, `setMembers`, `setVoiceStates`, `setDmChannels`, etc. |
| `chat_message` | `addMessage`, `incrementUnread`, `notifyIncomingMessage` |
| `chat_send_ok` | `confirmSend` |
| `chat_edited` | `editMessage` |
| `chat_deleted` | `deleteMessage` |
| `reaction_update` | `updateReaction` |
| `typing` | `setTyping` |
| `presence` | `updatePresence` |
| `channel_create` | `addChannel` |
| `channel_update` | `updateChannel` |
| `channel_delete` | `removeChannel` |
| `voice_state` | `updateVoiceState` |
| `voice_leave` | `removeVoiceUser` |
| `voice_config` | `setVoiceConfig`, `joinVoiceChannel` |
| `voice_token` | `handleVoiceToken` (LiveKit session) |
| `voice_speakers` | `setSpeakers` |
| `member_join` | `addMember` |
| `member_leave` | `removeMember` |
| `member_update` | `updateMemberRole` |
| `member_ban` | `removeMember` |
| `dm_channel_open` | `addDmChannel` |
| `dm_channel_close` | `removeDmChannel` |
| `server_restart` | display restart banner |
| `error` | `setTransientError` or specific handler |

---

## Message Type Reference Table

### Client -> Server (18 types)

| Type | Payload Interface | Rate Limit | Notes |
|------|-------------------|-----------|-------|
| `auth` | `AuthPayload` | N/A (first message) | Token + optional last_seq |
| `chat_send` | `ChatSendPayload` | 10/sec | + slow mode per channel |
| `chat_edit` | `ChatEditPayload` | 10/sec | Own messages only |
| `chat_delete` | `ChatDeletePayload` | 10/sec | Own or mod (non-DM) |
| `reaction_add` | `ReactionAddPayload` | 5/sec | |
| `reaction_remove` | `ReactionRemovePayload` | 5/sec | |
| `typing_start` | `TypingStartPayload` | 1/3sec/channel | Silently dropped |
| `channel_focus` | `ChannelFocusPayload` | None | Updates read state |
| `presence_update` | `PresenceUpdatePayload` | 1/10sec | |
| `voice_join` | `VoiceJoinPayload` | None | |
| `voice_leave` | `{}` | None | Empty payload |
| `voice_mute` | `VoiceMutePayload` | None | |
| `voice_deafen` | `VoiceDeafenPayload` | None | |
| `voice_camera` | `VoiceCameraPayload` | 2/sec | Requires USE_VIDEO |
| `voice_screenshare` | `VoiceScreensharePayload` | 2/sec | Requires SHARE_SCREEN |
| `voice_token_refresh` | `{}` | 1/60sec | Must be in voice |
| `soundboard_play` | `SoundboardPlayPayload` | N/A | TypeScript only, no Go handler |
| `ping` | `{}` | None | Heartbeat |

### Server -> Client (25 types)

| Type | Payload Interface | Has seq? | Delivery |
|------|-------------------|----------|----------|
| `auth_ok` | `AuthOkPayload` | No | Direct |
| `auth_error` | `AuthErrorPayload` | No | Direct (then close) |
| `ready` | `ReadyPayload` | No | Direct |
| `chat_message` | `ChatMessagePayload` | Non-DM only | Channel (seq) or DM participants (no seq) |
| `chat_send_ok` | `ChatSendOkPayload` | No | Direct to sender |
| `chat_edited` | `ChatEditedPayload` | Non-DM only | Channel (seq) or DM participants (no seq) |
| `chat_deleted` | `ChatDeletedPayload` | Non-DM only | Channel (seq) or DM participants (no seq) |
| `reaction_update` | `ReactionUpdatePayload` | Non-DM only | Channel (seq) or DM participants (no seq) |
| `typing` | `TypingPayload` | No | Channel (excl. sender) or DM |
| `presence` | `PresencePayload` | Yes | All clients |
| `channel_create` | `ChannelCreatePayload` | Yes | All clients |
| `channel_update` | `ChannelUpdatePayload` | Yes | All clients |
| `channel_delete` | `ChannelDeletePayload` | Yes | All clients |
| `voice_state` | `VoiceStatePayload` | Yes | All clients |
| `voice_leave` | `VoiceLeavePayload` | Yes | All clients |
| `voice_config` | `VoiceConfigPayload` | No | Direct to joiner |
| `voice_token` | `VoiceTokenPayload` | No | Direct to joiner |
| `voice_speakers` | `VoiceSpeakersPayload` | N/A | Legacy (not sent) |
| `member_join` | `MemberJoinPayload` | Yes | All clients |
| `member_leave` | `MemberLeavePayload` | N/A | Defined in TS, not sent by Go |
| `member_update` | `MemberUpdatePayload` | Yes | All clients |
| `member_ban` | `MemberBanPayload` | Yes | All clients |
| `dm_channel_open` | `DmChannelOpenPayload` | No | Direct to participant (via `SendToUser`) |
| `dm_channel_close` | `DmChannelClosePayload` | No | Direct to participant (via `SendToUser`) |
| `server_restart` | `ServerRestartPayload` | Yes | All clients |
| `error` | `ErrorPayload` | No | Direct to requester |
| `pong` | (none) | No | Direct to pinger |

**Delivery notes:** Typing uses `broadcastExclude` (not
`BroadcastToChannel`), so it never gets a seq and is never stored
in the replay ring buffer. DM events (chat messages, edits,
deletes, reactions, open/close) are sent via `SendToUser`, which
also bypasses the broadcast channel -- no seq, no ring buffer
storage. This means DM events are not replayable on reconnect.

---

## Message History (REST, not WebSocket)

Message history is fetched via REST to keep the WS connection lean:

```
GET /api/v1/channels/{id}/messages?before={msg_id}&limit=50
```

See [[API]] for full REST endpoint documentation.

---

## Known Protocol Drift

The following discrepancies exist between the Go server
implementation and the TypeScript client types (documented in
`protocol-schema.json` under `drift_notes`):

1. **chat_message user.role:** Go sends `user.role` but TS
   `ChatMessagePayload` uses `MessageUser` (no role field).
2. **chat_message reactions/pinned:** Go sends `reactions[]`
   and `pinned` fields. TS `ChatMessagePayload` omits both.
3. **channel_create topic:** Go sends `topic` (string) but TS
   `ChannelCreatePayload` omits it.
4. **channel_update full object:** Go sends all 6 channel
   fields. TS `ChannelUpdatePayload` only has `id`, optional
   `name`, optional `position`.
5. **voice_config extra fields:** TS `VoiceConfigPayload` has
   `threshold_mode`, `mixing_threshold`, `top_speakers` which
   are not present in Go's `voiceConfigPayload` struct (legacy
   Pion fields).
6. **voice_token direct_url:** TS marks as optional. Go always
   sends it (may be empty string).
7. **soundboard_play:** TS defines client message type but Go
   has no handler for it (returns `UNKNOWN_TYPE`).
8. **dm_channel_open payload shape:** Go sends
   `{channel_id, recipient}` while TS `DmChannelOpenPayload`
   expects additional fields (`last_message_id`, `last_message`,
   `last_message_at`, `unread_count`).
