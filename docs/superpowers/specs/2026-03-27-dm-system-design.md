# OwnCord Direct Messages — Design Spec

**Date:** 2026-03-27
**Status:** Approved
**Scope:** Full-stack 1-on-1 DM support — server (Go), protocol, schema, client (TypeScript)

---

## Overview

Add Discord-style 1-on-1 direct messaging. A DM is a channel with `type = 'dm'` and exactly two participants. Existing message storage, pagination, typing, reactions, and read states all reuse the channel infrastructure. New tables track DM participants and per-user sidebar visibility.

---

## 1. Schema Changes

### Migration: Add DM channel type

Alter the `channels` table CHECK constraint to allow `'dm'` as a channel type.

### New table: `dm_participants`

```sql
CREATE TABLE dm_participants (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_dm_participants_user ON dm_participants(user_id);
```

Every DM channel has exactly 2 rows in this table.

### New table: `dm_open_state`

```sql
CREATE TABLE dm_open_state (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  opened_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel_id)
);
```

Controls whether a DM appears in a user's sidebar. "Closing" a DM deletes the row. Sending a message to a closed DM re-inserts it.

---

## 2. Server: Database Layer

### New functions in `db/dm_queries.go`

- `GetOrCreateDMChannel(user1Id, user2Id int) (*Channel, bool, error)` — returns existing DM channel between two users, or creates one. The `bool` indicates whether it was newly created. Creates the channel with `type='dm'`, `name=''`, inserts both participants, and opens the DM for both users.

- `GetUserDMChannels(userId int) ([]DMChannelInfo, error)` — returns all open DM channels for a user, with recipient info (username, avatar, status), last message preview, last message timestamp, and unread count. Ordered by most recent message descending.

- `OpenDM(userId, channelId int) error` — insert into `dm_open_state` (idempotent, ON CONFLICT IGNORE).

- `CloseDM(userId, channelId int) error` — delete from `dm_open_state`.

- `IsDMParticipant(userId, channelId int) (bool, error)` — check if user is a participant in this DM channel.

- `GetDMRecipient(channelId, requestingUserId int) (*User, error)` — get the other participant in a DM channel.

### DMChannelInfo struct

```go
type DMChannelInfo struct {
    ChannelID      int    `json:"channel_id"`
    Recipient      DMUser `json:"recipient"`
    LastMessageID  *int   `json:"last_message_id"`
    LastMessage    string `json:"last_message"`
    LastMessageAt  string `json:"last_message_at"`
    UnreadCount    int    `json:"unread_count"`
}

type DMUser struct {
    ID       int    `json:"id"`
    Username string `json:"username"`
    Avatar   string `json:"avatar"`
    Status   string `json:"status"`
}
```

---

## 3. Server: REST API

### New endpoints

All under `/api/v1/`:

#### `POST /api/v1/dms`

Create or get a DM channel with another user.

**Request:** `{ "recipient_id": 42 }`

**Response:** `{ "channel_id": 99, "recipient": { "id": 42, "username": "Player1", ... }, "created": true }`

**Logic:**
1. Validate recipient exists and is not the requesting user
2. Call `GetOrCreateDMChannel(authUserId, recipientId)`
3. If newly created, open DM for both users
4. Return channel info

#### `GET /api/v1/dms`

List the authenticated user's open DM channels.

**Response:** `{ "dm_channels": [ { "channel_id": 99, "recipient": {...}, "last_message": "Hey!", "last_message_at": "2026-03-27T14:00:00Z", "unread_count": 2 }, ... ] }`

**Logic:** Call `GetUserDMChannels(authUserId)`, ordered by most recent message.

#### `DELETE /api/v1/dms/{channelId}`

Close a DM (hide from sidebar). Messages are preserved.

**Logic:**
1. Verify user is a DM participant
2. Call `CloseDM(authUserId, channelId)`
3. Return 204

### Modified endpoint

#### `GET /api/v1/channels/{id}/messages`

Add a permission check: if the channel `type == 'dm'`, verify the requesting user is a participant via `IsDMParticipant()`. Otherwise use the existing role-based permission check.

#### `POST /channels/{id}/typing` (WebSocket `typing` event)

Same DM participant check. Typing indicators work in DMs with no code changes beyond the permission gate.

---

## 4. Server: WebSocket Changes

### Message routing for DM channels

In `hub.go`, when broadcasting a message for a DM channel (`type == 'dm'`):
- Instead of `BroadcastToChannel()` (which checks channel subscriptions), use `SendToUser()` for each of the two participants
- This ensures both users receive the message regardless of which channels they've "joined"

### Modified: `handleChatSend`

When the target channel is a DM:
1. Check `IsDMParticipant()` instead of `requireChannelPerm()`
2. After persisting the message, auto-reopen the DM for the recipient if closed (insert into `dm_open_state`)
3. If reopened, send a `dm_channel_open` event to the recipient
4. Broadcast using `SendToUser()` to both participants

### New WebSocket events

#### `dm_channel_open` (server → client)

Sent when a DM is opened or auto-reopened for a user.

```json
{
  "type": "dm_channel_open",
  "payload": {
    "channel_id": 99,
    "recipient": { "id": 42, "username": "Player1", "avatar": "", "status": "online" }
  }
}
```

#### `dm_channel_close` (server → client)

Sent when a user closes a DM (confirmation of the DELETE request).

```json
{
  "type": "dm_channel_close",
  "payload": {
    "channel_id": 99
  }
}
```

### Modified: `ready` payload

Add `dm_channels` array to the ready payload:

```json
{
  "type": "ready",
  "payload": {
    "user": { ... },
    "channels": [ ... ],
    "dm_channels": [
      {
        "channel_id": 99,
        "recipient": { "id": 42, "username": "Player1", "avatar": "", "status": "online" },
        "last_message_id": 1234,
        "last_message": "Hey!",
        "last_message_at": "2026-03-27T14:00:00Z",
        "unread_count": 2
      }
    ],
    "members": [ ... ]
  }
}
```

---

## 5. Client: State Management

### New store: `dm.store.ts`

```typescript
interface DmChannel {
  readonly channelId: number;
  readonly recipient: {
    readonly id: number;
    readonly username: string;
    readonly avatar: string;
    readonly status: string;
  };
  readonly lastMessageId: number | null;
  readonly lastMessage: string;
  readonly lastMessageAt: string;
  readonly unreadCount: number;
}

interface DmState {
  readonly channels: readonly DmChannel[];
}
```

**Actions:**
- `setDmChannels(channels)` — bulk set from `ready` payload
- `addDmChannel(channel)` — add/update from `dm_channel_open` event
- `removeDmChannel(channelId)` — remove from `dm_channel_close` event
- `updateDmLastMessage(channelId, message, timestamp)` — update on new message
- `decrementUnread(channelId)` / `clearUnread(channelId)` — mark as read

---

## 6. Client: API

### New methods in `api.ts`

- `getDmChannels(): Promise<{ dm_channels: DmChannel[] }>` — `GET /api/v1/dms`
- `createDm(recipientId: number): Promise<{ channel_id: number, recipient: DmUser, created: boolean }>` — `POST /api/v1/dms`
- `closeDm(channelId: number): Promise<void>` — `DELETE /api/v1/dms/{channelId}`

Messages use the existing `getMessages(channelId)` — no changes needed.

---

## 7. Client: Sidebar Integration

### DM section in channel mode

The "DIRECT MESSAGES" section in the sidebar reads from `dmStore` instead of guessing from online members. Shows:
- All open DMs (including offline users)
- Last message preview + timestamp
- Unread badge
- Click to enter DM mode for that channel

### DM mode sidebar

When in DM mode, the `DmSidebar` component shows all open DMs from the store. The selected DM loads messages via `getMessages(channelId)`.

### "New DM" flow

The "+" button next to "DIRECT MESSAGES":
1. Opens a member picker (all server members, including offline)
2. Selecting a user calls `createDm(userId)`
3. Server returns the channel_id
4. Client switches to DM mode with that channel active
5. Messages load via existing `getMessages(channelId)`

### Auto-reopen

When a `dm_channel_open` event arrives (someone messaged you in a closed DM), the client adds it to the DM store and shows the unread badge. No mode switch — just the badge appears.

---

## 8. Client: Message Loading in DM Mode

When the user selects a DM conversation:
1. `setActiveDmUser(recipientId)` + `setSidebarMode("dms")`
2. The chat area's `ChannelController` loads messages for the DM `channelId` — this is the same `switchChannel(channelId)` call used for regular channels
3. Typing, reactions, pins, message editing — all work automatically because they're keyed on `channelId`
4. The ChatHeader shows `@Username` instead of `#channel-name`

---

## 9. Protocol & Server Impact Summary

| Change | Location | Type |
|--------|----------|------|
| Add `'dm'` to channel type CHECK | Migration | Schema |
| `dm_participants` table | Migration | Schema |
| `dm_open_state` table | Migration | Schema |
| `dm_queries.go` | `Server/db/` | New file |
| `dm_handler.go` | `Server/api/` | New file |
| DM routes in router | `Server/api/router.go` | Modify |
| DM participant check in message handler | `Server/ws/handlers.go` | Modify |
| DM routing in hub broadcast | `Server/ws/hub.go` | Modify |
| `dm_channel_open`/`dm_channel_close` events | `Server/ws/` | New events |
| DM channels in `ready` payload | `Server/ws/` | Modify |
| `dm.store.ts` | `Client/src/stores/` | New file |
| `api.ts` DM methods | `Client/src/lib/` | Modify |
| `dispatcher.ts` DM event handlers | `Client/src/lib/` | Modify |
| `SidebarArea.ts` DM section | `Client/src/pages/` | Modify |
| `DmSidebar.ts` real data | `Client/src/components/` | Modify |

---

## 10. What's NOT Included

- No blocking / message requests
- No group DMs
- No DM-specific notification settings
- No DM search (uses existing channel search)
- No file upload changes (existing upload works for any channel_id)
