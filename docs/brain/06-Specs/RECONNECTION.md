# Reconnection with State Recovery

## Complete Architecture Specification

*Created: 2026-03-28 | Status: IMPLEMENTED | Related: [[PROTOCOL]], [[CHATSERVER]], [[CLIENT-ARCHITECTURE]]*

---

## 1. Executive Summary

OwnCord implements reconnection with state recovery at two layers:
the WebSocket chat connection and the LiveKit voice connection.
The WS layer uses a sequence-based ring buffer replay system --
the client tracks the highest `seq` number received and sends it
on reconnect; the server replays missed events from a 1,000-event
ring buffer. If the client is too far behind, a full `ready`
payload is sent instead. The LiveKit layer has its own auto-reconnect
with stored token reuse.

---

## 2. Architecture Overview

```
  +---------------------------+         +---------------------------+
  | Client (ws.ts)            |         | Server (serve.go + hub.go)|
  |                           |         |                           |
  | lastSeq = 0               |         | seq = atomic.Uint64(0)    |
  |                           |         | replayBuf = RingBuffer(   |
  | On each message:          |         |   capacity: 1000)         |
  |   if msg.seq > lastSeq:   |         |                           |
  |     lastSeq = msg.seq     |         | On each broadcast:        |
  |                           |         |   seq = nextSeq()         |
  | On reconnect:             |         |   msg = wrapWithSeq(msg,  |
  |   send auth with          |         |     seq)                  |
  |   { token, last_seq }     |         |   replayBuf.Push(seq,msg) |
  |                           |         |   deliver to clients      |
  +---------------------------+         +---------------------------+
              |                                     |
              | auth { token, last_seq: 42 }        |
              +------------------------------------>|
              |                                     |
              |       1. Authenticate user           |
              |       2. EventsSince(42)             |
              |         |                            |
              |         +-- Events found:            |
              |         |   Send auth_ok + replay    |
              |         |                            |
              |         +-- Events too old (nil):    |
              |             Send auth_ok + full ready |
              |                                     |
              |<------------------------------------+
```

---

## 3. Server-Side: Event Ring Buffer

### 3.1 Data Structure

**File:** `Server/ws/ringbuffer.go`

```go
type eventEntry struct {
    seq  uint64
    data []byte
}

type EventRingBuffer struct {
    mu      sync.RWMutex
    entries []eventEntry
    size    int    // Capacity (1,000)
    pos     int    // Next write position (circular)
    count   int    // Total entries stored (up to size)
}
```

The ring buffer is a fixed-size circular array with read-write
mutex synchronization. It stores the raw JSON bytes of each
broadcast message along with its sequence number.

### 3.2 Operations

| Operation | Complexity | Thread-Safe | Description |
|-----------|-----------|-------------|-------------|
| `Push(seq, data)` | O(1) | Write lock | Overwrite oldest entry at `pos`, advance |
| `EventsSince(afterSeq)` | O(n) | Read lock | Return all entries with `seq > afterSeq` |
| `OldestSeq()` | O(1) | Read lock | Return oldest entry's seq, or 0 if empty |

### 3.3 EventsSince Logic

```
EventsSince(afterSeq):
  1. If buffer is empty: return nil
  2. Find oldest entry index: (pos - count + size) % size
  3. Get oldest seq number
  4. If afterSeq < oldestSeq: return nil  // Too far behind
  5. Iterate from oldest to newest:
     if entry.seq > afterSeq: add to result
  6. Return result (ordered by seq)
```

Returning `nil` (vs empty slice) signals "too old" -- the server
falls back to a full `ready` payload.

### 3.4 Buffer Capacity

```go
replayBuf: NewEventRingBuffer(1000)
```

1,000 events is sufficient for typical usage (messages, typing
indicators, voice state changes). At ~50 events/minute, this
covers ~20 minutes of missed events.

---

## 4. Server-Side: Sequence Numbers

### 4.1 Monotonic Counter

**File:** `Server/ws/hub.go`

```go
seq uint64  // atomic monotonic counter
```

Every broadcast message gets a unique, monotonically increasing
sequence number via `atomic.AddUint64(&h.seq, 1)`.

### 4.2 Message Stamping

**File:** `Server/ws/hub.go`, `wrapWithSeq` and `deliverBroadcast`

```go
func (h *Hub) deliverBroadcast(bm broadcastMsg) {
    seq := h.nextSeq()
    msg := wrapWithSeq(bm.msg, seq)    // Inject "seq" field into JSON
    h.replayBuf.Push(seq, msg)          // Store for replay
    // ... deliver to clients
}
```

`wrapWithSeq` injects a `"seq"` field into an existing JSON
message without full re-serialization (string concatenation after
the opening `{`).

### 4.3 Ephemeral Messages

Not all messages are stored in the ring buffer. Messages sent via
`broadcastExclude` (e.g., typing indicators) are NOT stored -- they
are ephemeral and should not survive reconnection replay.

| Stored in Ring Buffer (via `BroadcastToChannel`/`BroadcastToAll`) | NOT Stored (via `broadcastExclude`/`SendToUser`) |
|------------------------------------------------------------------|--------------------------------------------------|
| `chat_message` (non-DM only) | `typing` (ephemeral, `broadcastExclude`) |
| `chat_edited` (non-DM only) | `dm_channel_open` (direct via `SendToUser`) |
| `chat_deleted` (non-DM only) | `dm_channel_close` (direct via `SendToUser`) |
| `reaction_update` (non-DM only) | DM `chat_message`/`chat_edited`/`chat_deleted`/`reaction_update` |
| `presence` | |
| `voice_state` | |
| `voice_leave` | |
| `member_join` | |
| `member_update` | |
| `member_ban` | |
| `channel_create` | |
| `channel_update` | |
| `channel_delete` | |
| `server_restart` | |

**Note:** DM events (chat messages, reactions, open/close) are sent
via `SendToUser` and bypass the broadcast channel entirely. They do
not get sequence numbers and are not stored in the replay buffer.
This means DM events cannot be replayed on reconnect -- the client
relies on the full `ready` payload (which includes `dm_channels`)
if a replay fallback occurs.

---

## 5. Server-Side: Auth + Reconnect Flow

**File:** `Server/ws/serve.go`, lines 71-103

```go
// authenticateConn parses the auth message
type authPayload struct {
    Token   string `json:"token"`
    LastSeq uint64 `json:"last_seq"`
}
```

After successful authentication:

```
ServeWS(hub, database):
  1. Accept WebSocket connection
  2. authenticateConn() -> user, tokenHash, lastSeq
  3. Reject duplicate connections (prevent ping-pong loops)
  4. Register client with hub
  5. Look up role name
  6. Check lastSeq:
     |
     +-- lastSeq > 0:
     |    events = hub.ReplayBuffer().EventsSince(lastSeq)
     |    |
     |    +-- events != nil (replay available):
     |    |    a. Send auth_ok
     |    |    b. For each event: send to client
     |    |    c. Log "replay completed" with event count
     |    |    d. Update presence to "online"
     |    |    e. Start read/write loops
     |    |    f. RETURN (skip full ready)
     |    |
     |    +-- events == nil (too far behind):
     |         Log "replay failed (seq too old)"
     |         Fall through to full ready...
     |
     +-- lastSeq == 0 (fresh connection):
          Send full ready payload:
          a. auth_ok
          b. ready (channels, members, voice states, DMs, ...)
          c. member_join broadcast to all
          d. Start read/write loops
```

### 5.1 Reconnect vs Fresh: What Differs

| Aspect | Fresh Connect | Reconnect (replay) |
|--------|--------------|-------------------|
| `ready` payload | Yes (full state) | No (missed events only) |
| `member_join` broadcast | Yes | No (user was already known) |
| Presence update | Yes | Yes |
| Voice state | In `ready` | Replayed via ring buffer |
| DM state | In `ready` | Replayed via ring buffer |

---

## 6. Client-Side: WebSocket Reconnection

### 6.1 Sequence Tracking

**File:** `Client/tauri-client/src/lib/ws.ts`

```typescript
let lastSeq = 0;

// In message handler:
const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
if (seq > lastSeq) {
  lastSeq = seq;
}
```

### 6.2 Auth Message with last_seq

```typescript
send({ type: "auth", payload: { token: config.token, last_seq: lastSeq } });
```

### 6.3 Connection States

```typescript
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";
```

### 6.4 Reconnection Logic

```
WS closed (not intentional):
  |
  scheduleReconnect():
    if (intentionalClose || certMismatchBlock || !config) return;
    delay = min(1000 * 2^attempt, maxReconnectDelay)
    setState("reconnecting")
    setTimeout(() => {
      reconnectAttempt++
      connect(config)
    }, delay)
```

**Exponential backoff:**
- Attempt 1: 1,000ms
- Attempt 2: 2,000ms
- Attempt 3: 4,000ms
- Attempt 4: 8,000ms
- ...
- Max: 30,000ms (configurable via `maxReconnectDelayMs`)

### 6.5 Reset on Success

```typescript
if (msg.type === "auth_ok") {
  setState("connected");
  reconnectAttempt = 0;  // Reset backoff
  startHeartbeat();
}
```

### 6.6 lastSeq Reset

`lastSeq` is only reset to 0 on intentional disconnect (logout).
Automatic reconnects preserve `lastSeq` so the server can replay
missed events.

### 6.7 TOFU Certificate Mismatch Blocking

If the Rust WS proxy detects a TLS certificate fingerprint mismatch
(TOFU check), reconnection is blocked until the user acknowledges
the changed certificate:

```typescript
let certMismatchBlock = false;
// Set to true on mismatch event
// Blocks scheduleReconnect()
// Reset via acceptCertFingerprint()
```

---

## 7. Client-Side: LiveKit Auto-Reconnect

### 7.1 Trigger

**File:** `Client/tauri-client/src/lib/livekitSession.ts`, `handleDisconnected`

LiveKit auto-reconnect triggers on unexpected disconnects (reason
is not `CLIENT_INITIATED`) when the session has a stored token,
channel ID, and URL.

### 7.2 Reconnect Flow

```
handleDisconnected(reason):
  |
  +-- reason === CLIENT_INITIATED? -> leaveVoice(), done
  |
  +-- Has latestToken + currentChannelId + lastUrl?
       |
       Yes: Clean up current room (no WS leave sent)
            Create AbortController for cancellation
            attemptAutoReconnect(token, url, channelId, ...)
       |
       No: leaveVoice() + error callback
```

### 7.3 Auto-Reconnect Loop

```
attemptAutoReconnect(token, url, channelId, directUrl, signal):
  for attempt = 1 to MAX_RECONNECT_ATTEMPTS (2):
    1. Wait RECONNECT_DELAY_MS (3,000ms)
    2. If signal.aborted or channel changed: abort
    3. Try:
       a. Create new Room
       b. resolveLiveKitUrl (handle local vs remote + TLS proxy)
       c. room.connect(url, token)
       d. startAudio()
       e. restoreLocalVoiceState("reconnect")
       f. setupAudioPipeline()
       g. startTokenRefreshTimer()
       h. requestTokenRefresh() (get fresh token for next time)
       i. SUCCESS -> return
    4. Catch: log warning, clean up room, try next attempt

  All attempts failed:
    leaveVoice(true)  // Send voice_leave over WS
    leaveVoiceChannel()
    Error: "Voice connection lost -- failed to reconnect"
```

### 7.4 Cancellation

The AbortController allows `leaveVoice()` to cancel a pending
reconnect loop:

```typescript
leaveVoice(sendWs = true): void {
  if (this.reconnectAc !== null) {
    this.reconnectAc.abort();
    this.reconnectAc = null;
  }
  // ... rest of cleanup
}
```

This prevents the user from being stuck in a reconnect loop when
they manually disconnect.

### 7.5 Token Refresh After Reconnect

After a successful auto-reconnect, the client immediately requests
a fresh token via `voice_token_refresh` WS message. This ensures
the stored token is not close to expiry. The token refresh timer
(3.5 hours) is also restarted.

---

## 8. Heartbeat Monitoring

### 8.1 Client-Side

**File:** `Client/tauri-client/src/lib/ws.ts`

```typescript
const HEARTBEAT_INTERVAL_MS = 30_000;

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    send({ type: "ping", payload: {} });
  }, HEARTBEAT_INTERVAL_MS);
}
```

### 8.2 Server-Side

The server sweeps for stale connections every 30 seconds and kicks
clients with no activity for 90 seconds. The `ping` message
from the client resets the activity timer (any incoming message
calls `c.touch()`, but `ping` is specifically sent for this purpose).

```
Heartbeat sweep (30s interval):
  For each connected client:
    if (now - lastActivity > 90s):
      close connection
      log "kicked stale connection"
```

---

## 9. Data Flow: Reconnection Sequence

```
  Client                         Server
    |                               |
    | (connection drops)            |
    |                               |
    | scheduleReconnect()           |
    | delay = 1000ms * 2^attempt    |
    |                               |
    | ... wait ...                  |
    |                               |
    | ws_connect (via Rust proxy)   |
    +------------------------------>|
    |                               |
    | auth { token, last_seq: 42 }  |
    +------------------------------>|
    |                               |
    |    authenticateConn()         |
    |    EventsSince(42)            |
    |    -> [events 43, 44, 45]     |
    |                               |
    |<-- auth_ok --                 |
    |<-- event (seq: 43) --         |
    |<-- event (seq: 44) --         |
    |<-- event (seq: 45) --         |
    |                               |
    | setState("connected")         |
    | reconnectAttempt = 0          |
    | startHeartbeat()              |
    |                               |
    | (resume normal operation)     |
```

---

## 10. Edge Cases

### 10.1 Duplicate Connection Prevention

The server rejects duplicate logins:

```go
if hub.IsUserConnected(user.ID) {
    conn.Write("already connected from another client")
    conn.Close(StatusPolicyViolation, "already connected")
    return
}
```

This prevents ping-pong reconnect loops where a new connection
opens before the old one is fully cleaned up.

### 10.2 Ring Buffer Overflow

If the client is disconnected for longer than the ring buffer
can cover (~20 minutes at typical activity), `EventsSince` returns
nil. The server falls through to a full `ready` payload, which
is equivalent to a fresh login.

### 10.3 Voice Reconnect During WS Reconnect

The WS reconnect and LiveKit reconnect are independent:
- WS reconnect restores chat state (messages, presence, etc.)
- LiveKit reconnect restores voice state (room connection, tracks)

If the WS reconnect succeeds but LiveKit fails, the user remains
in chat but loses voice. The error callback notifies: "Voice
connection lost -- failed to reconnect".

### 10.4 Token Expiry During Disconnect

LiveKit tokens have a 4-hour TTL. If the disconnect period exceeds
this, the stored token is expired and auto-reconnect fails. The
client must rejoin voice manually (which requests a new token).

---

## 11. Files Reference

| File | Role |
|------|------|
| `Server/ws/ringbuffer.go` | EventRingBuffer (Push, EventsSince, OldestSeq) |
| `Server/ws/hub.go` | Seq counter, deliverBroadcast + ring buffer storage |
| `Server/ws/serve.go` | Auth with last_seq, replay logic, full ready fallback |
| `Client/tauri-client/src/lib/ws.ts` | lastSeq tracking, reconnect scheduling, backoff |
| `Client/tauri-client/src/lib/livekitSession.ts` | LiveKit auto-reconnect (handleDisconnected, attemptAutoReconnect) |

---

## 12. Implementation Status

| Component | Status |
|-----------|--------|
| EventRingBuffer (1,000 events) | DONE |
| Monotonic sequence counter | DONE |
| Message stamping (wrapWithSeq) | DONE |
| Auth with last_seq | DONE |
| Server replay logic (EventsSince) | DONE |
| Full ready fallback | DONE |
| Client lastSeq tracking | DONE |
| Exponential backoff reconnect | DONE |
| TOFU cert mismatch blocking | DONE |
| Heartbeat (30s client, 90s server timeout) | DONE |
| LiveKit auto-reconnect (2 attempts, 3s delay) | DONE |
| AbortController cancellation | DONE |
| Token refresh after reconnect | DONE |
| Duplicate connection rejection | DONE |

---

## 13. Known Limitations

1. **Ring buffer is server-side only:** If the server restarts, the
   ring buffer is lost. All reconnecting clients get a full `ready`.
2. **No per-channel replay filtering:** The ring buffer stores ALL
   broadcast events. A client in channel A receives replayed events
   from channel B too (which are filtered client-side).
3. **Fixed capacity:** The 1,000-event buffer is not configurable
   without code changes.
4. **No offline message queue:** Messages sent while the client is
   disconnected are only available if they're in the ring buffer.
   There is no persistent offline queue.
5. **LiveKit reconnect uses stored token:** If the token is close
   to expiry, reconnect may fail. The 3.5-hour refresh timer
   mitigates this but doesn't eliminate the window.
