# Direct Message (DM) System

## Complete Architecture Specification

*Created: 2026-03-28 | Status: IMPLEMENTED | Related: [[CLIENT-ARCHITECTURE]], [[CHATSERVER]], [[SCHEMA]], [[API]], [[PROTOCOL]]*

---

## 1. Executive Summary

OwnCord supports 1-on-1 direct messages (DMs) as a parallel
communication channel alongside server text channels. DMs have
their own database schema (dm_participants, dm_open_state), REST
API endpoints, WebSocket events, and client-side sidebar mode.
DMs use participant-based authorization (`IsDMParticipant`) instead
of role-based permissions, and every handler that touches a channel
must branch on `ch.Type == "dm"` for authorization.

---

## 2. Architecture Overview

```
  +-------------------+        +-------------------+        +---------------------+
  | Client (DM Mode)  |        | Go Chat Server    |        |   SQLite Database   |
  |                   |        |                   |        |                     |
  | dm.store.ts       |        | api/dm_handler.go |        | channels (type=dm)  |
  | DmSidebar.ts      |<------>| ws/handlers.go    |<------>| dm_participants     |
  | ChatArea (reused) |        | db/dm_queries.go  |        | dm_open_state       |
  | SidebarArea.ts    |        |                   |        | messages (shared)   |
  |                   |        |                   |        | read_states (shared)|
  +-------------------+        +-------------------+        +---------------------+
```

---

## 3. Database Schema

### 3.1 Channels Table (Shared)

DM channels are stored in the existing `channels` table with
`type = 'dm'` and an empty name:

```sql
INSERT INTO channels (name, type) VALUES ('', 'dm')
```

### 3.2 DM Participants

```sql
CREATE TABLE dm_participants (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (channel_id, user_id)
);
```

Each DM channel has exactly two participants. This table
establishes who can access the channel.

### 3.3 DM Open State

```sql
CREATE TABLE dm_open_state (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  opened_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, channel_id)
);
```

A user can "close" a DM without deleting it. The DM channel and
messages persist; only the user's visibility is toggled. Closing
removes the row from `dm_open_state`. Re-opening adds it back
(idempotent via `INSERT OR IGNORE`).

---

## 4. Server-Side Implementation

### 4.1 Database Layer

**File:** `Server/db/dm_queries.go`

| Function | Purpose | Concurrency Safety |
|----------|---------|--------------------|
| `GetOrCreateDMChannel(user1, user2)` | Find or create DM channel | IMMEDIATE transaction prevents TOCTOU race |
| `GetUserDMChannels(userId)` | List open DMs with last message + unread count | Single query with LEFT JOINs |
| `OpenDM(userId, channelId)` | Add to open state (idempotent) | `INSERT OR IGNORE` |
| `CloseDM(userId, channelId)` | Remove from open state | `DELETE` |
| `IsDMParticipant(userId, channelId)` | Authorization check | Simple SELECT |
| `GetDMParticipantIDs(channelId)` | Get both user IDs | Returns []int64 |
| `GetDMRecipient(channelId, requestingUserId)` | Get the other user | Excludes requesting user |

### 4.2 GetOrCreateDMChannel: Race-Free Design

```
GetOrCreateDMChannel(user1ID, user2ID) -> (*Channel, bool, error):
  1. BeginTx with sql.LevelSerializable (maps to BEGIN EXCLUSIVE
     in modernc/sqlite — acquires an exclusive lock immediately)
  2. SELECT existing DM channel between the two users:
     JOIN dm_participants dp1 ON dp2 WHERE dp1.user_id=? AND dp2.user_id=?
  3. If found:
     a. Re-open for the calling user (INSERT OR IGNORE dm_open_state)
     b. COMMIT
     c. Fetch full channel via GetChannel(existingID)
     d. Return (channel, false, nil)
  4. If ErrNoRows (not found):
     a. INSERT INTO channels (type='dm')
     b. INSERT both participants
     c. INSERT OR IGNORE dm_open_state for both users
     d. COMMIT
     e. Fetch full channel via GetChannel(newID)
     f. Return (channel, true, nil)
  5. On any other error: ROLLBACK and return nil, false, err
```

The serializable transaction prevents a TOCTOU race where two concurrent
requests both see ErrNoRows and create duplicate DM channels.

### 4.3 GetUserDMChannels: Query Design

```sql
SELECT
    c.id, u.id, u.username, u.avatar, u.status,
    lm.id, lm.content, lm.timestamp,
    COUNT(CASE WHEN m_unread.id > COALESCE(rs.last_message_id, 0)
               AND m_unread.deleted = 0 THEN 1 END) AS unread_count
FROM dm_open_state dos
JOIN channels c ON c.id = dos.channel_id AND c.type = 'dm'
JOIN dm_participants dp ON dp.channel_id = c.id AND dp.user_id != ?
JOIN users u ON u.id = dp.user_id
LEFT JOIN messages lm ON lm.id = (
    SELECT MAX(id) FROM messages WHERE channel_id = c.id AND deleted = 0
)
LEFT JOIN messages m_unread ON m_unread.channel_id = c.id
LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
WHERE dos.user_id = ?
GROUP BY c.id
ORDER BY COALESCE(lm.timestamp, dos.opened_at) DESC
```

Returns: channel_id, recipient info (id, username, avatar, status),
last message preview, unread count. Ordered by most recent activity.

### 4.4 REST API

**File:** `Server/api/dm_handler.go`

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/dms` | POST | Bearer token | Create or retrieve DM channel |
| `/api/v1/dms` | GET | Bearer token | List all open DM channels |
| `/api/v1/dms/{channelId}` | DELETE | Bearer token | Close (hide) a DM channel |

#### POST /api/v1/dms

**Request:**
```json
{ "recipient_id": 42 }
```

**Response (200 OK or 201 Created):**
```json
{
  "channel_id": 15,
  "recipient": { "id": 42, "username": "bob", "avatar": "", "status": "online" },
  "created": true
}
```

**Validation:**
- recipient_id must be positive
- Cannot DM yourself
- Recipient must exist

#### GET /api/v1/dms

**Response (200 OK):**
```json
{
  "dm_channels": [
    {
      "channel_id": 15,
      "recipient": { "id": 42, "username": "bob", "avatar": "", "status": "online" },
      "last_message_id": 789,
      "last_message": "Hey, check this out",
      "last_message_at": "2026-03-28T10:30:00Z",
      "unread_count": 3
    }
  ]
}
```

#### DELETE /api/v1/dms/{channelId}

- Verifies DM participation via `IsDMParticipant`
- Removes from `dm_open_state` only (messages preserved)
- Broadcasts `dm_channel_close` via WebSocket to the closing user
- Returns 204 No Content

### 4.5 WebSocket Events

| Event | Direction | Description |
|-------|----------|-------------|
| `dm_channel_open` | Server -> Client | DM channel was opened/re-opened |
| `dm_channel_close` | Server -> Client | DM channel was closed by user |

The `dm_channel_close` event is sent via `DMBroadcaster.SendToUser()`
(an interface satisfied by `*ws.Hub`) so the sidebar updates
immediately without a reconnect.

### 4.6 Authorization: The IsDMParticipant Rule

**CRITICAL RULE:** Every handler that touches a channel must check
`ch.Type == "dm"` and verify participant membership instead of
using role-based permissions.

Affected handlers:
- **WS:** `channel_focus`, `typing`, `chat_send`, `chat_edit`,
  `chat_delete`, `reaction_add`, `reaction_remove`
- **REST:** GET messages, pins

```go
// Pattern used in every DM-aware handler:
if ch.Type == "dm" {
    isParticipant, err := h.db.IsDMParticipant(c.userID, channelID)
    if err != nil || !isParticipant {
        c.sendMsg(buildErrorMsg(ErrCodeForbidden, "not a DM participant"))
        return
    }
} else {
    // Normal role-based permission check
}
```

---

## 5. Client-Side Implementation

### 5.1 DM Store

**File:** `Client/tauri-client/src/stores/dm.store.ts`

```typescript
interface DmChannel {
  readonly channelId: number;
  readonly recipient: DmUser;
  readonly lastMessageId: number | null;
  readonly lastMessage: string;
  readonly lastMessageAt: string;
  readonly unreadCount: number;
}

interface DmState {
  readonly channels: readonly DmChannel[];
}
```

**Actions (all immutable):**

| Function | Purpose |
|----------|---------|
| `setDmChannels(channels)` | Bulk set from ready payload |
| `addDmChannel(channel)` | Add/update (from `dm_channel_open`) |
| `removeDmChannel(channelId)` | Remove (from `dm_channel_close`) |
| `updateDmLastMessage(channelId, ...)` | Update last message + increment unread |
| `clearDmUnread(channelId)` | Clear unread on channel focus |

### 5.2 DmSidebar Component

**File:** `Client/tauri-client/src/components/DmSidebar.ts`

The DM sidebar replaces the channel sidebar when in "DM mode".
It shares the `channel-sidebar` CSS container class.

```
+-------------------------------+
| <- Back to {Server Name}      |   dm-back-header
|    Return to channels         |
+-------------------------------+
| [Find a conversation]         |   dm-search (input)
+-------------------------------+
| Friends                       |   dm-nav-item
+-------------------------------+
| Direct Messages            +  |   dm-section-label + dm-add button
+-------------------------------+
| [A] Alice              x     |   dm-item (active state)
|     status dot                |   dm-avatar + dm-status
+-------------------------------+
| [B] Bob                x     |
|     "Last message preview"    |
+-------------------------------+
```

**Features:**
- Back-to-server header with arrow icon
- Search input (placeholder, filtering not yet implemented)
- Friends nav item (placeholder)
- New DM button (+)
- Conversation items sorted by unread status
- Per-item close button (X, visible on hover)
- Avatar with initial letter or image + status dot
- Active state highlighting
- Unread dot indicator

### 5.3 Sidebar Mode Switching

**File:** `Client/tauri-client/src/pages/main-page/SidebarArea.ts`

The sidebar has two modes:
- **Channel mode:** Shows text/voice channels, members, voice widget
- **DM mode:** Shows DmSidebar with conversation list

Switching is controlled by the UI store:

```typescript
// In ui.store.ts
interface UiState {
  readonly sidebarMode: "channels" | "dm";
  // ...
}
```

### 5.4 Chat Area Reuse

DM messages use the same `ChatArea` component as server channels.
The difference is in authorization (participant-based) and the
chat header, which shows `@ username` instead of `# channel-name`.

**File:** `Client/tauri-client/src/pages/main-page/ChatHeader.ts`

For DM channels, the header:
- Shows `@` prefix instead of `#`
- Displays recipient username (resolved from DM participants)
- Shows live status indicator (online/idle/dnd/offline)

### 5.5 DM Channel Switching

When a DM conversation is selected:
1. `channelsStore.setActiveChannel(dmChannelId)`
2. Messages are loaded via the same REST endpoint (`GET /api/v1/channels/{id}/messages`)
3. Unread count is cleared via `clearDmUnread(channelId)`
4. WebSocket `channel_focus` is sent

When closing a DM while viewing it:
1. The DM is removed from the list
2. Sidebar switches to the next DM in the list
3. If no DMs remain, switches back to channel mode

### 5.6 Starting a New DM

The "+" button opens a member picker modal where the user selects
a recipient. This triggers:
1. `POST /api/v1/dms` with the selected user's ID
2. On success: `addDmChannel(response)` to the store
3. Switch sidebar to DM mode and select the new channel

### 5.7 Auto-Reopen on Message

When a message arrives in a closed DM channel, the channel is
automatically re-opened in the sidebar. The server broadcasts
`dm_channel_open` to both participants when a message is sent
in a DM channel that one participant has closed.

---

## 6. Data Flow: DM Lifecycle

```
  Alice (Client)              Server                     Bob (Client)
       |                         |                            |
  1. Click "+" -> Pick Bob       |                            |
       |                         |                            |
  2. POST /api/v1/dms           |                            |
     { recipient_id: bob_id }    |                            |
       |----->                   |                            |
       |      3. GetOrCreate     |                            |
       |         DM channel      |                            |
       |      4. Open for both   |                            |
       |<--- 201 Created ---     |                            |
       |                         |                            |
  5. addDmChannel(channel)       |  dm_channel_open           |
     Switch to DM mode           |---------->                 |
       |                         |                            |
  6. Type message, send          |                            |
       |---> chat_send           |                            |
       |      (channel_id=DM)    |                            |
       |                         |  7. IsDMParticipant check  |
       |                         |  8. Insert message         |
       |                         |  9. Broadcast to both      |
       |<--- chat_message -------|----> chat_message          |
       |                         |                            |
       |                         |                            |
  10. Bob clicks X to close DM   |                            |
       |                         |<--- DELETE /api/v1/dms/15  |
       |                         |     11. CloseDM (remove    |
       |                         |         from open state)   |
       |                         |----> dm_channel_close ---->|
       |                         |                            |
       |                         |                            |
  12. Alice sends another msg    |                            |
       |---> chat_send           |                            |
       |      (channel_id=DM)    |                            |
       |                         |  13. Auto-reopen for Bob   |
       |                         |      (OpenDM)              |
       |                         |----> dm_channel_open ----->|
       |                         |----> chat_message -------->|
```

---

## 7. Files Reference

| File | Role |
|------|------|
| `Server/db/dm_queries.go` | DM database operations |
| `Server/api/dm_handler.go` | REST endpoints (POST, GET, DELETE) |
| `Server/ws/handlers.go` | DM-aware WS handlers (IsDMParticipant checks) |
| `Client/tauri-client/src/stores/dm.store.ts` | DM channel state |
| `Client/tauri-client/src/components/DmSidebar.ts` | DM conversation list UI |
| `Client/tauri-client/src/pages/main-page/SidebarArea.ts` | Channel/DM mode switching |
| `Client/tauri-client/src/pages/main-page/ChatHeader.ts` | DM header (@ username) |
| `Client/tauri-client/src/lib/dispatcher.ts` | DM event dispatching |
| `Client/tauri-client/src/lib/api.ts` | DM REST API calls |
| `Client/tauri-client/src/styles/app.css` | DM sidebar CSS classes |

---

## 8. Implementation Status

| Component | Status |
|-----------|--------|
| Database schema (dm_participants, dm_open_state) | DONE |
| GetOrCreateDMChannel (race-free) | DONE |
| GetUserDMChannels (with unread count) | DONE |
| REST API (POST, GET, DELETE) | DONE |
| WS events (dm_channel_open, dm_channel_close) | DONE |
| IsDMParticipant authorization in all handlers | DONE |
| DM store (client) | DONE |
| DmSidebar component | DONE |
| Sidebar mode switching (channels/DM) | DONE |
| Chat header with @ username | DONE |
| Auto-reopen on message | DONE |
| Close DM -> switch to next | DONE |
| New DM member picker | DONE |
| Unread count and clearing | DONE |

---

## 9. Known Limitations

1. **1-on-1 only:** No group DMs. The schema supports it (multiple
   dm_participants rows per channel) but the UI and API are
   designed for exactly two participants.
2. **No DM notifications:** The notification system
   (`lib/notifications.ts`) currently only handles channel messages.
   DM-specific notification logic is not yet differentiated.
3. **No DM search:** The search input in DmSidebar is a placeholder
   and does not filter conversations.
4. **No "Friends" feature:** The Friends nav item is a placeholder.
5. **Close is per-user:** When one user closes a DM, the other user
   still sees it. Messages are never deleted.
6. **No DM-specific typing indicator:** Typing uses the same
   `typing` WS event as channels; the DM-specific handling is
   done by the `IsDMParticipant` check.
