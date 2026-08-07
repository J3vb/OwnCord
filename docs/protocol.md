# WebSocket Protocol Reference

All client-server real-time communication happens over a single WebSocket connection. Messages are JSON with a `type` and `payload`.

**Related docs:**
- [api.md](api.md) -- REST endpoints (message history, file uploads, etc.)
- [schema.md](schema.md) -- Database tables and permission bitfields

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
12. [Channel Focus and Read State](#channel-focus-and-read-state)
13. [Channel Updates](#channel-updates)
14. [Member Updates](#member-updates)
15. [Voice Signaling](#voice-signaling)
16. [Voice Moderation](#voice-moderation)
17. [Voice End-to-End Encryption](#voice-end-to-end-encryption)
18. [Direct Messages](#direct-messages)
19. [Server Restart](#server-restart)
20. [Error Handling](#error-handling)
21. [Rate Limits](#rate-limits)
22. [Message Type Reference Table](#message-type-reference-table)

---

## Transport Layer

### WebSocket Endpoint

```
wss://{host}/api/v1/ws
```

The client connects via the Tauri Rust backend's WS proxy rather than native WebView2 WebSocket. This is required because WebView2 rejects self-signed TLS certificates. The Rust proxy uses TOFU (Trust On First Use) certificate pinning.

### Transport Limits

| Limit | Value |
|-------|-------|
| Max read size | 1 MB |
| Max message content | 4000 runes |
| Write timeout | 10 seconds |
| Auth deadline | 10 seconds |
| Send buffer per client | 256 messages |

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Determines how `payload` is interpreted |
| `id` | string | Client messages only | Client-generated UUID for request/response correlation |
| `payload` | object | Yes | Contents vary by `type`. Must be present (can be `{}`). |
| `seq` | uint64 | Broadcast messages only | Monotonically increasing sequence number. Only present on server-to-client broadcast messages. |

---

## Sequence Numbers

The sequence number system enables reconnection with state recovery.

1. The server maintains an atomic `uint64` counter.
2. Every broadcast message gets the next seq number.
3. The message is stored in a 1000-event replay ring buffer.
4. The client tracks `lastSeq` from every server broadcast.

### Which Messages Get seq

| Category | Has seq? | Examples |
|----------|----------|---------|
| Channel broadcasts | Yes | `chat_message`, `chat_edited`, `chat_deleted`, `chat_bulk_deleted`, `reaction_update` |
| Global broadcasts | Yes | `member_join`, `member_leave`, `member_update`, `member_ban`, `roles_update`, `emoji_update`, `voice_state`, `voice_leave`, `channel_create`, `channel_update`, `channel_delete`, `server_restart` |
| Ephemeral | No | `typing`, `presence` from a `presence_update` (see below) |
| DM messages | No | DM `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update`, `dm_channel_open`, `dm_channel_close` |
| Call signalling | No | `call_incoming`, `call_declined` |
| Direct responses | No | `auth_ok`, `auth_error`, `chat_send_ok`, `error`, `voice_config`, `voice_token`, `pong` |

**`presence` is split, and only one half is sequenced.** Connect and disconnect
presence is a normal sequenced global broadcast, so it replays on a warm resume.
A `presence` caused by the user changing their own status (`presence_update`) is
sent on the low-priority, droppable tier instead: it carries no `seq`, it can be
shed under send-buffer pressure for a fully connected client, and it is not
replayed — so a status change made while a client was away is not delivered when
that client resumes.

This is deliberate, not an oversight: presence is best-effort by design, and
`member_join` carries `status` precisely so a client can re-derive presence
without depending on the correction arriving. Clients must treat presence as
eventually-consistent and must not assume they have seen every transition. See
Presence for the invisible-member split.

---

## Authentication Flow

### Step 1: Client Sends auth

After the WebSocket connection is established, the client sends the first message within 10 seconds:

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
| `token` | string | Yes | Session token obtained from `POST /api/v1/auth/login` |
| `last_seq` | uint64 | No | Last sequence number received. If > 0, server attempts replay. Default 0. |
| `active_channel_id` | int64 | No | The channel the client had open when it disconnected. Honoured only on a resume (`last_seq > 0`) and only after the server re-checks read permission; an unknown or unreadable id is ignored. Omit when unknown. |

`active_channel_id` closes a resume-only gap. The hub restores a reconnecting
client's channel subscription by copying it from the previous connection entry,
but that entry is deleted as soon as the server observes the old socket close —
which normally happens well before the client reconnects. Without the hint the
resumed socket holds no channel subscription until its post-`auth_ok`
`channel_focus` round trip completes, and everything broadcast to that channel
in the meantime reaches nobody on that connection and can never be re-requested,
since the client only ever reports `max(seq)`.

Clients should still send `channel_focus` after `auth_ok` — it remains the
fallback for servers that predate this field, and it is idempotent.

### Step 2: Success -- auth_ok

```json
{
  "type": "auth_ok",
  "payload": {
    "user": {
      "id": 1,
      "username": "alex",
      "avatar": "/api/v1/files/5f2c...",
      "role": "admin",
      "display_name": "Alex A.",
      "about": "A short bio.",
      "custom_status": "shipping phase 6",
      "status": "invisible"
    },
    "server_name": "My Server",
    "motd": "Welcome!",
    "replay_source": "none"
  }
}
```

`display_name`, `about` and `custom_status` are the signed-in user's own
profile fields, `null` when unset. `display_name` is what clients render
instead of `username`; `@mentions` still resolve against `username`, which is
the unique handle.

`status` is the user's **own true status**, `"invisible"` included. Only this
message and their own `ready` entry ever carry it — every other client is told
`"offline"` for an invisible user (see Presence). The connection comes online
as the status saved from the last session when that was `idle`, `dnd` or
`invisible`, and as `online` otherwise; a client should not re-assert a status
the server already agreed with.

`replay_source` reports which replay tier served this (re)connection:
`"none"` (fresh connection / full re-sync), `"buffer"` (in-memory ring
buffer), or `"db"` (persistent `events` table). See
[Reconnection with State Recovery](#reconnection-with-state-recovery).

### Step 3: Failure -- auth_error

```json
{
  "type": "auth_error",
  "payload": {
    "message": "Invalid or expired token"
  }
}
```

After sending `auth_error`, the server closes the connection.

### Step 4: ready Payload

After `auth_ok`, the server sends a `ready` message containing all initial state.

### Step 5: Member Join + Presence

The server broadcasts to all connected clients:

```json
{ "type": "member_join", "payload": { "user": { "id": 1, "username": "alex", "avatar": "uuid.png", "role": "admin" } } }
{ "type": "presence", "payload": { "user_id": 1, "status": "online", "custom_status": null } }
```

### Periodic Session Revalidation

Every 10 messages, the server re-checks the session token against the database. If the session has been revoked, expired, or the user banned, the connection is closed immediately.

---

## Heartbeat and Connection Liveness

### Client Ping

The client sends a JSON ping every 30 seconds:

```json
{ "type": "ping", "payload": {} }
```

### Server Pong

The server responds immediately:

```json
{ "type": "pong" }
```

### Server Stale Client Sweep

Every 30 seconds, the server checks all clients. Any client with no activity for 90 seconds is forcibly disconnected. Normal chat activity also keeps the connection alive.

---

## Reconnection with State Recovery

When a connection drops, the client automatically reconnects with exponential backoff (1s to 30s max) and sends `last_seq` in the `auth` message. The server resolves the reconnect through a **3-tier replay pipeline** (cheapest first):

| Tier | Condition | Server Behavior | `replay_source` |
|------|-----------|-----------------|-----------------|
| — | `last_seq == 0` | Full flow: `auth_ok` + `ready` + `member_join` + `presence` | `none` |
| 1 | seq within the in-memory ring buffer (1000 events) | Replay flow: `auth_ok` + missed events + `presence` (no `member_join`, no `ready`). Channel-scoped events are permission-filtered (fail-closed). | `buffer` |
| 2 | seq within the persistent `events` table (max 5000 events, subject to retention) | Same replay flow, served from the cold tier | `db` |
| 3 | seq too far behind, or channel visibility changed while away | Full flow (fallback): same as `last_seq == 0` | `none` |

A visibility watermark forces the tier-3 full re-sync whenever channel
visibility changed while the client was disconnected, so permission changes
can never be replayed around.

DM events are not stored in the ring buffer; DM history persisted to the
`events` table is replayable via tier 2, and everything is always recoverable
via the full `ready` payload.

---

## Initial State (ready)

Sent once after `auth_ok` (fresh connection or replay fallback).

```json
{
  "type": "ready",
  "payload": {
    "channels": [ ... ],
    "dm_channels": [ ... ],
    "members": [ ... ],
    "voice_states": [ ... ],
    "roles": [ ... ],
    "server_name": "My Server",
    "motd": "Welcome!"
  }
}
```

### Payload Fields

**channels[]:** `id`, `name`, `type` (`text`/`voice`/`announcement`), `category`, `topic`, `position`, `can_send`, `slow_mode`, `nsfw`, `voice_max_users`, `voice_max_video`, `unread_count` (text + announcement), `last_message_id` (text + announcement), `mention_count` (text + announcement)

`nsfw`, `voice_max_users` and `voice_max_video` are always present, with their
zero values (`false`, `0`, `0`) on an unconfigured channel — never omitted, so
"absent" never has to mean two different things. `nsfw` is a label the server
never acts on (see below); the two voice limits are the values the voice-join
path enforces with `CHANNEL_FULL` / `VIDEO_LIMIT`, shipped so a client can show
"3/5" and explain a refusal it could have predicted.

`mention_count` is the number of unread messages that mention this user — a
direct `@username` or an authorized `@everyone`/`@here` — in that channel. It is
raised by the send that mentions them (never by an edit) and reset to 0 by
`channel_focus` or `mark_read`.

**dm_channels[]:** `channel_id`, `recipient` (user object with `id`, `username`, `avatar`, `status`), `last_message_id`, `last_message`, `last_message_at`, `unread_count`, `mention_count`

A DM's `mention_count` is the same `read_states.mention_count` the channel list
carries. It used to be absent here, so a DM mention badge silently reset to 0 on
every reconnect; the ready payload now ships the stored value.

**members[]:** All registered users with `id`, `username`, `avatar`, `role` (lowercase name), `status`, `display_name` (`null` when unset — render it instead of `username`), `custom_status` (`null` when unset), `identity_public_key` (base64 long-term E2EE identity key, omitted when the user has not published one — see voice E2EE TOFU)

`status` is per-viewer. Two rules apply, in this order, so a client never has
to reconstruct them:

1. A member with no live connection is `"offline"`, whatever status they last
   chose — a chosen `idle`/`dnd`/`invisible` is preserved server-side across a
   disconnect so the next connect can honour it, but it must not render as
   "present" in the meantime.
2. An `"invisible"` member is `"offline"` to everyone but themselves. The
   viewer's own entry carries their true status.

**voice_states[]:** All users currently in any voice channel: `channel_id`, `user_id`, `muted`, `deafened`, `server_muted`, `server_deafened`

**roles[]:** All server roles with `id`, `name`, `color`, `permissions` (bitfield)

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
| `channel_id` | number | Yes | Positive integer |
| `content` | string | Yes* | Max 4000 runes. HTML-sanitized. *Can be empty if `attachments` is non-empty. |
| `reply_to` | number or null | No | Message ID being replied to |
| `attachments` | string[] | No | Upload IDs from `POST /api/v1/uploads`. Requires `ATTACH_FILES` permission. |

### chat_send_ok (Server -> Client)

Direct response to sender (no seq):

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
    "attachments": [],
    "reactions": [],
    "pinned": false,
    "mentions": [7, 9],
    "mentions_everyone": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `mentions` | number[] | User IDs the server resolved from `@username` tokens. Always present; empty when nothing resolved. |
| `mentions_everyone` | bool | `true` when the message carried `@everyone` or `@here` **and** the author holds `MENTION_EVERYONE` on that channel. |

Mentions are resolved server-side at send time against existing usernames
(case-insensitive, whole-word, capped at 20 per message). An `@word` that
matches no username, and an `@everyone`/`@here` from an author without
`MENTION_EVERYONE`, resolve to nothing and stay plain text — clients must
highlight from these fields rather than re-parsing the content. DMs never carry
`mentions_everyone`.

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

Own messages only. Max 4000 runes.

### chat_edited (Server -> Client, broadcast)

```json
{
  "seq": 43,
  "type": "chat_edited",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "content": "Hello everyone! (edited)",
    "edited_at": "2026-03-14T10:31:00Z",
    "mentions": [7],
    "mentions_everyone": false
  }
}
```

`mentions`/`mentions_everyone` are re-resolved from the edited content and
replace the stored set. Editing never raises anyone's `mention_count`: a badge
is only ever raised by the original send, so re-adding an already-counted
mention cannot double-count it.

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

Moderators with `MANAGE_MESSAGES` can delete others' messages (non-DM channels only).

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

### chat_bulk_deleted (Server -> Client, broadcast)

Emitted by the REST bulk delete (`POST /api/v1/channels/{id}/messages/purge`,
gated on `READ_MESSAGES|MANAGE_MESSAGES`, non-DM channels only) instead of one
`chat_deleted` per message. `ids` is newest-first and never null; the deletes
are soft, so clients mark each id as a tombstone exactly as they do for
`chat_deleted`.

```json
{
  "seq": 45,
  "type": "chat_bulk_deleted",
  "payload": {
    "channel_id": 5,
    "ids": [1042, 1041, 1040]
  }
}
```

---

## Reactions

### reaction_add / reaction_remove (Client -> Server)

```json
{
  "type": "reaction_add",
  "payload": {
    "message_id": 1042,
    "emoji": "\ud83d\udc4d"
  }
}
```

Rate limited at 5/sec. Requires `ADD_REACTIONS` permission (or DM participant).

`emoji` is a free-form string, not a fixed enum: it is a unicode emoji, or the
literal `:shortcode:` of a custom emoji (see api.md). It must be non-empty, at
most **34 runes** — the longest custom shortcode (32) plus its two colons —
carry no control characters, and survive the HTML sanitizer unchanged. A
reaction whose `:shortcode:` no longer names an existing emoji stays a valid
reaction and renders as its plain text.

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

Rate limited: 1 per 3 seconds per user per channel. Silently dropped when rate limited.

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

Typing broadcasts are ephemeral -- they are NOT stored in the replay ring buffer.

---

## Presence

### presence_update (Client -> Server)

```json
{
  "type": "presence_update",
  "payload": { "status": "invisible", "custom_status": "heads down" }
}
```

Valid `status` values: `"online"`, `"idle"`, `"dnd"`, `"invisible"`.
`"offline"` is still accepted from older clients (which used it to mean
"appear offline") and is treated as the plain offline it says. Rate limited:
1 per 10 seconds.

`custom_status` is optional and max 128 characters, HTML-sanitized and trimmed
server-side. **Omitting the field leaves the stored text alone**; sending `""`
clears it. The distinction matters because a client's auto-idle timer sends a
bare status flip several times an hour and must not blank the text the user
typed.

The chosen status is stored as chosen, `invisible` included, and persists
across reconnects (see `auth_ok`). A custom status persists too, and is
cleared on `POST /api/v1/auth/logout`.

### presence (Server -> Client, broadcast)

```json
{
  "seq": 50,
  "type": "presence",
  "payload": {
    "user_id": 1,
    "status": "online",
    "custom_status": "shipping phase 6"
  }
}
```

`custom_status` is always present (`null` when unset), so "cleared it" is
distinguishable from "this event does not mention it"; every presence
broadcast carries the current value.

**Invisible splits this message in two.** When a user's status is
`"invisible"`, everyone else receives a broadcast that says `"offline"`, and
the user themselves receives a separate, targeted `presence` carrying their
true `"invisible"`. A client must therefore not assume it sees the same
presence value for a user that everyone else does — and must not "correct" its
own status back to online on the strength of a broadcast it did not receive.

---

## Channel Focus and Read State

### channel_focus (Client -> Server)

```json
{ "type": "channel_focus", "payload": { "channel_id": 5 } }
```

Tells the server which channel the user is currently viewing. Affects broadcast delivery and unread tracking: it advances the caller's read state to the channel's latest message and resets that channel's `mention_count` to 0.

### mark_read (Client -> Server)

```json
{ "type": "mark_read", "payload": { "channel_id": 5 } }
```

Advances the caller's read state for `channel_id` to that channel's latest
message and resets its `mention_count` to 0 — exactly what `channel_focus` does
to unread state — **without** changing which channel the connection is focused
on. This is what backs "Mark as Read" in the channel context menu and "Mark All
as Read": marking a channel the user is *not* looking at must not rebind the
connection's focused channel, which would misroute unread bookkeeping for the
channel actually on screen.

Same access check as `channel_focus`: `READ_MESSAGES` on the channel, or DM
participation. A denied channel answers `FORBIDDEN`; a non-positive
`channel_id` answers `BAD_REQUEST`. There is no response on success — the client
clears its local badge optimistically and the next `ready` confirms.

---

## Channel Updates

All channel update messages are broadcast to all connected clients. Triggered by REST API calls from admins.

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
    "position": 3,
    "slow_mode": 0,
    "nsfw": false,
    "voice_max_users": 0,
    "voice_max_video": 0
  }
}
```

`can_send` is an **optional extra field on the targeted form only.** When a role
or channel-override edit changes who may post, `RefreshChannelVisibility` sends
each still-visible client its own `channel_create`, and that copy carries this
viewer's `can_send` — the same value `ready` ships per channel — so the composer
affordance converges without a reconnect.

The broadcast form omits it: one encoded frame is delivered to a whole audience,
and a single value would be wrong for some of them. Older servers omit it too.
**Treat an absent `can_send` as "unchanged", never as `false`** — a client that
resets on absence would disable the composer on every ordinary broadcast.

### channel_update (Server -> Client, broadcast)

Full channel object — the same payload shape as `channel_create`, built by the
same constructor so the two events can never disagree about which fields a
client is told about. Sent on every admin `PATCH`, so a client applies channel
edits (rename, topic, category move, slow mode, `nsfw`, voice limits) without
reconnecting.

`nsfw` is shipped so clients can gate or label a channel; **the server applies
no content behaviour of its own to a flagged channel** — no filtering, no age
check, no restriction on who may read or post. The desktop client shows a
one-time-per-session warning before rendering the channel and marks it in the
sidebar; a client that ignores the field behaves exactly as before it existed.

Archiving or unarchiving additionally triggers targeted `channel_create` /
`channel_delete` sends (`Hub.RefreshChannelVisibility`), because it changes who
may see the channel rather than only how it looks.

**An archived channel is read-only, and the server enforces that.** History
stays readable, but `chat_send` is refused with `FORBIDDEN` and `voice_join`
with `BAD_REQUEST`, and archiving a voice channel evicts whoever is already
connected. Hiding the channel is not on its own a protection: a caller that
still holds the id — a custom client, or a stock client racing the
`channel_delete` the archive transition sends — would otherwise keep writing
into an archive that nobody can see or moderate.

### channel_delete (Server -> Client, broadcast)

```json
{
  "seq": 62,
  "type": "channel_delete",
  "payload": { "id": 8 }
}
```

---

## Member Updates

All member messages are broadcast to all connected clients.

### member_join (Server -> Client, broadcast)

Sent when a user first connects (fresh connection, not reconnect replay).

```json
{
  "seq": 70,
  "type": "member_join",
  "payload": {
    "user": {
      "id": 5,
      "username": "newuser",
      "avatar": null,
      "role": "member",
      "display_name": "New User",
      "identity_public_key": "base64-identity-pubkey"
    }
  }
}
```

`display_name` is the nickname to render instead of `username`; omitted when
unset. `identity_public_key` is the user's long-term E2EE identity public key
(see voice E2EE TOFU); omitted when the user has not published one.

### member_update (Server -> Client, broadcast)

Triggered when an admin changes a user's role.

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

### member_ban (Server -> Client, broadcast)

```json
{
  "seq": 72,
  "type": "member_ban",
  "payload": { "user_id": 5 }
}
```

### roles_update (Server -> Client, broadcast)

Sent to every connected client after any role mutation (create, edit, delete or
reorder) through `/admin/api/roles`. The payload is the **whole** role list in
the same shape and order the `ready` payload uses — position descending —
rather than a delta: the client replaces `channelsStore.roles` wholesale, so a
dropped intermediate event can never leave a deleted role on screen.

```json
{
  "seq": 73,
  "type": "roles_update",
  "payload": {
    "roles": [
      { "id": 1, "name": "Owner", "color": "#E74C3C", "permissions": 2147483647, "position": 100, "is_default": false },
      { "id": 4, "name": "Member", "color": null, "permissions": 1635, "position": 40, "is_default": true }
    ]
  }
}
```

Unfiltered on purpose — the same list already ships in every client's `ready`
payload, so it discloses nothing new. A role permission change that alters
channel visibility is delivered separately, as targeted
`channel_create`/`channel_delete` messages, and a role deletion additionally
sends one `member_update` per reassigned member.

### emoji_update (Server -> Client, broadcast)

Sent to every connected client after a custom emoji is uploaded or deleted
through `/api/v1/emoji`. Like `roles_update` this carries the **whole** set
rather than a delta — the client replaces its shortcode map wholesale, so a
dropped intermediate event can never leave a deleted emoji rendering in the
messages that name it.

```json
{
  "seq": 74,
  "type": "emoji_update",
  "payload": {
    "emoji": [
      { "id": 3, "shortcode": "wave", "url": "/api/v1/emoji/3/image" },
      { "id": 7, "shortcode": "party_blob", "url": "/api/v1/emoji/7/image" }
    ]
  }
}
```

`emoji` is always an array, `[]` when the last emoji was deleted. Shortcodes
are lowercase and `[a-z0-9_]{2,32}`; `url` is a server-relative path that
requires the session token (see api.md). Ordered by shortcode.

Unfiltered on purpose, for the same reason `roles_update` is: emoji are
server-wide with no channel scope, and every client may already `GET
/api/v1/emoji` for the same list. The set is **not** in the `ready` payload —
it changes rarely and belongs to the server, not the session, so clients load
it once over REST and keep it fresh from this event.

### user_update (Server -> Client, broadcast)

Broadcast when a user changes their own profile via `PATCH /api/v1/users/me`
or `POST /api/v1/users/me/avatar` (username, avatar, display name, about
and/or identity key).

```json
{
  "seq": 73,
  "type": "user_update",
  "payload": {
    "user_id": 5,
    "username": "newname",
    "avatar": "/api/v1/files/5f2c...",
    "display_name": "New Name",
    "about": "A short bio.",
    "identity_public_key": "base64-identity-pubkey"
  }
}
```

The payload is a full snapshot, not a delta: it **replaces** the client's copy
of that user's profile. `avatar`, `display_name` and `about` are always present
and may be `null` (unset/cleared) — a profile edit that removes a field has to
be distinguishable from one that leaves it alone.
`identity_public_key` carries the user's current long-term E2EE identity key
and is omitted when none is published; peers that pinned a different key must
surface a TOFU mismatch.

### member_leave (reserved)

`member_leave` is a defined message type that the server does not currently
emit (clients handle it defensively). Reserved for future member-removal
flows.

---

## Voice Signaling

Voice uses LiveKit as the SFU. WebSocket messages handle signaling (join/leave/state) while the actual audio/video flows through LiveKit's own WebSocket connection.

### voice_join (Client -> Server)

```json
{ "type": "voice_join", "payload": { "channel_id": 10 } }
```

On success, server sends (in order):
1. `voice_token` -- LiveKit JWT + URL
2. `voice_state` broadcast -- joiner's state to all clients
3. Existing `voice_state` messages -- one per existing participant (to joiner only)
4. `voice_config` -- channel audio settings (to joiner only)

### voice_token (Server -> Client, direct)

```json
{
  "type": "voice_token",
  "payload": {
    "channel_id": 10,
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "url": "/livekit",
    "direct_url": "ws://localhost:7880",
    "is_key_holder": false
  }
}
```

`is_key_holder` tells the joiner whether they are the channel's E2EE key
holder (see [Voice End-to-End Encryption](#voice-end-to-end-encryption)).
Tokens are 5-minute scoped JWTs whose publish sources (mic/camera/screen) are
restricted by the user's permissions.

### voice_config (Server -> Client, direct)

```json
{
  "type": "voice_config",
  "payload": {
    "channel_id": 10,
    "quality": "medium",
    "bitrate": 64000,
    "max_users": 50,
    "threshold_mode": "top_speakers",
    "mixing_threshold": 0,
    "top_speakers": 5
  }
}
```

Quality presets:

| Preset | Bitrate |
|--------|---------|
| `low` | 32,000 bps |
| `medium` | 64,000 bps |
| `high` | 128,000 bps |

### voice_leave (Client -> Server)

```json
{ "type": "voice_leave", "payload": {} }
```

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

### voice_speakers (reserved)

`voice_speakers` (`{ channel_id, speakers: [user_id, ...], threshold_mode }`)
is a defined message type that the server does not currently emit; clients
already handle it. Reserved for active-speaker signaling.

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
    "screenshare": false,
    "server_muted": false,
    "server_deafened": false
  }
}
```

`server_muted` / `server_deafened` are moderator-imposed (see [Voice
Moderation](#voice-moderation)). `muted` / `deafened` are always set alongside
them, so a client that ignores the two new fields still renders the user as
silenced; they exist so the UI can show that the user may not lift it.

### voice_mute / voice_deafen (Client -> Server)

```json
{ "type": "voice_mute", "payload": { "muted": true } }
{ "type": "voice_deafen", "payload": { "deafened": true } }
```

Rate limited: 2/sec each. While the sender is `server_muted`, an unmute
(`muted: false`) is refused with `SERVER_MUTED`; while `server_deafened`, an
undeafen is refused with `SERVER_DEAFENED`. Muting or deafening oneself is
always allowed.

### voice_camera (Client -> Server)

```json
{ "type": "voice_camera", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `USE_VIDEO` permission.

### voice_screenshare (Client -> Server)

```json
{ "type": "voice_screenshare", "payload": { "enabled": true } }
```

Rate limited: 2/sec. Requires `SHARE_SCREEN` permission.

### voice_token_refresh (Client -> Server)

```json
{ "type": "voice_token_refresh", "payload": {} }
```

Rate limited: 1 per 60 seconds. Must be in a voice channel.

---

## Voice Moderation

Four moderator commands act on another user's voice session. All four require
`MUTE_MEMBERS` on the actor's role (`ADMINISTRATOR` bypasses the bit, never the
hierarchy), the actor must strictly outrank the target by role position, and
the target must currently be in a voice channel. Each is rate limited to 5/sec
and written to the audit log (`voice_mod_mute`, `voice_mod_deafen`,
`voice_mod_move`, `voice_mod_kick`, target type `user`).

Failures: `FORBIDDEN` (missing bit, or target of equal/higher rank),
`VOICE_ERROR` (target not in voice, not in the named channel, or not
connected), `BAD_REQUEST` (self-target, non-voice destination),
`NOT_FOUND` (unknown destination channel), `CHANNEL_FULL` (destination at
capacity).

### voice_mod_mute (Client -> Server)

```json
{ "type": "voice_mod_mute", "payload": { "channel_id": 10, "user_id": 7, "muted": true } }
```

`channel_id` is the channel the moderator believes the target is in; the action
is refused when the target has since moved. Sets `server_muted` (and `muted`)
and mutes the target's published audio track at the SFU, then broadcasts
`voice_state`. Clearing it leaves `muted` as-is, so a user who was already
self-muted stays muted until they unmute themselves.

Server mute is scoped to the voice session: it survives a channel switch but
not a leave and re-join, because the `voice_states` row is deleted on leave.

### voice_mod_deafen (Client -> Server)

```json
{ "type": "voice_mod_deafen", "payload": { "channel_id": 10, "user_id": 7, "deafened": true } }
```

Sets `server_deafened` (and `deafened`) and broadcasts `voice_state`. Deafen has
no SFU equivalent — it governs what the target plays back — so it is enforced by
the target's client honoring the flag plus the server refusing their own
undeafen. Deafening also applies a server mute, so a user who cannot hear the
room cannot keep talking into it.

### voice_mod_move (Client -> Server)

```json
{ "type": "voice_mod_move", "payload": { "user_id": 7, "to_channel_id": 12 } }
```

The destination is checked against the TARGET's `CONNECT_VOICE` (a move must not
place someone where they could not go themselves) and against the destination's
`voice_max_users`. The server then runs its voice-leave routine for the target —
`voice_leave` is broadcast, the LiveKit participant is removed, the row deleted
— and sends the target `voice_moved`. The target's client answers with an
ordinary `voice_join` for the destination, so capacity, token minting and
key-holder election keep their single implementation.

### voice_moved (Server -> Client, direct)

```json
{ "type": "voice_moved", "payload": { "to_channel_id": 12 } }
```

Sent only to the moved user. The client tears down its LiveKit session and joins
`to_channel_id`.

### voice_mod_kick (Client -> Server)

```json
{ "type": "voice_mod_kick", "payload": { "user_id": 7 } }
```

Removes the target from the LiveKit room, deletes their `voice_states` row and
broadcasts `voice_leave`, then sends them `voice_disconnected`.

### voice_disconnected (Server -> Client, direct)

```json
{
  "type": "voice_disconnected",
  "payload": { "channel_id": 10, "reason": "You were disconnected from voice by a moderator" }
}
```

---

## Voice End-to-End Encryption

Voice/video media can be end-to-end encrypted. The server never holds the room
key — it only relays the ECDH key exchange between participants and tracks who
the **key holder** is (deterministically, the participant with the lowest user
ID in the channel). The joiner learns whether they are the key holder from
`voice_token.is_key_holder`. When a participant leaves, the key holder rotates
the room key so departed members cannot decrypt future media.

Both E2EE message types are rate limited at 5 per second per user. Key
material must be standard-alphabet base64 (padded or unpadded).

**Identity keys + TOFU:** each client holds a long-term ECDSA P-256 identity
keypair, published via `PATCH /api/v1/users/me` (`identity_public_key`) and
distributed in the `ready` / `member_join` / `user_update` member payloads.
Peers pin the key on first sight (trust-on-first-use) and verify each
announce's `signature` against the pin, so a malicious server cannot swap
`user_id ↔ ephemeral pubkey` after first contact. A later key change is
surfaced to the user as a TOFU mismatch.

### voice_e2ee_announce (Client -> Server)

Announce this participant's ephemeral ECDH public key to the channel.
`signature` is the ECDSA P-256 signature by the sender's long-term identity
key over `"owncord-voice-e2ee-announce-v1" ‖ userId ‖ ephemeral-pubkey-raw`
(TOFU — see above). It is optional at the protocol level: legacy clients omit
it, and receiving clients enforce the fail-closed posture (peer has a
published identity key but the signature is missing/invalid → reject).

```json
{
  "type": "voice_e2ee_announce",
  "payload": {
    "public_key": "base64-ecdh-pubkey",
    "signature": "base64-ecdsa-signature"
  }
}
```

The server validates `signature` like `public_key` (standard-alphabet base64,
max 128 chars) and stores it alongside the key, but never verifies it — only
clients hold the pinned identity keys.

### voice_e2ee_announce (Server -> Client, broadcast to voice channel)

Relayed to the other participants with the sender's user ID attached. Also
replayed to late joiners from the stored key+signature. `signature` is
omitted when the announcing client did not send one:

```json
{
  "type": "voice_e2ee_announce",
  "payload": {
    "user_id": 1,
    "public_key": "base64-ecdh-pubkey",
    "signature": "base64-ecdsa-signature"
  }
}
```

### voice_e2ee_offer (Client -> Server)

The key holder wraps the room key for a specific participant:

```json
{
  "type": "voice_e2ee_offer",
  "payload": {
    "target_user_id": 2,
    "encrypted_key": "base64-wrapped-room-key",
    "iv": "base64-iv"
  }
}
```

### voice_e2ee_offer (Server -> Client, relay to target)

Delivered only to `target_user_id`, with the sender attached:

```json
{
  "type": "voice_e2ee_offer",
  "payload": {
    "from_user_id": 1,
    "encrypted_key": "base64-wrapped-room-key",
    "iv": "base64-iv"
  }
}
```

---

## Direct Messages

### dm_channel_open (Server -> Client)

Sent when a DM is opened, created, auto-reopened by an incoming message, or has
its membership changed (a group created, renamed, or left).

The payload is the same shape as one entry of the `ready` payload's
`dm_channels` and of `GET /api/v1/dms`, so a client has exactly one DM shape to
parse. It is built **per viewer**: `recipient` and `recipients` are both defined
relative to who is reading them, and the reader never appears in their own
`recipients`.

```json
{
  "type": "dm_channel_open",
  "payload": {
    "channel_id": 100,
    "name": "Lunch crew",
    "is_group": true,
    "recipient": {
      "id": 2,
      "username": "jordan",
      "display_name": "Jo",
      "avatar": "/api/v1/files/uuid",
      "status": "online"
    },
    "recipients": [
      {
        "id": 2,
        "username": "jordan",
        "display_name": "Jo",
        "avatar": "/api/v1/files/uuid",
        "status": "online"
      },
      {
        "id": 3,
        "username": "sam",
        "display_name": "",
        "avatar": "",
        "status": "idle"
      }
    ],
    "last_message_id": null,
    "last_message": "",
    "last_message_at": "",
    "unread_count": 0
  }
}
```

| Field        | Type   | Description                                                                                                                                                    |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipient`  | object | The other participant of a 1:1 DM. **Backward compatibility only** — for a group it carries the first of `recipients` so a pre-group client renders something. |
| `recipients` | array  | Every participant except the reader. The field group-aware clients read.                                                                                       |
| `name`       | string | Optional group name. `""` for a 1:1 DM and for an unnamed group.                                                                                               |
| `is_group`   | bool   | True for a group DM. Stored (`channels.is_group`), not derived from the live participant count — a group people have left stays a group.                       |

`status` is viewer-adjusted: an `invisible` participant reads as `offline` to
everyone but themselves.

### dm_channel_close (Server -> Client)

```json
{
  "type": "dm_channel_close",
  "payload": { "channel_id": 100 }
}
```

Sent to the caller of `DELETE /api/v1/dms/{id}`. For a group that is a _leave_,
and the remaining participants receive a fresh `dm_channel_open` carrying the
new membership.

### DM Authorization

All handlers that touch a channel check the channel type and branch to participant-based authorization for DMs instead of role-based permissions. This applies to: `chat_send`, `chat_edit`, `chat_delete`, `reaction_add`/`remove`, `typing_start`, `channel_focus`, `mark_read`, `call_ring`, `call_decline`.

Group DMs need no special case: `dm_participants` holds one row per
participant, and every check is a lookup on `(user_id, channel_id)`.

**Blocks are a 1:1 rule.** A block refuses DM creation and gates every
interaction sink in a two-person DM, but is _not_ consulted inside a group: a
group is a shared room, and dropping one member's messages for one other member
would leave the two of them reading different conversations under the same
name. Blocks are instead enforced when the group is created — a user may
neither add someone they have blocked nor add someone who has blocked them.

---

## DM Calls

A "call" in a DM is **not** a server-side object. It is somebody being present
in that DM's voice channel — which `voice_state` already broadcasts — and
ringing is transient signalling on top of it. There is no call id and no call
record: a persisted call would be one more thing a crashed client can leave
dangling, in exchange for information the presence already carries.

### call_ring (Client -> Server)

```json
{
  "type": "call_ring",
  "payload": { "channel_id": 100 }
}
```

Only a participant of the DM may ring it (`FORBIDDEN` otherwise). Rate limited
to one ring every 3 seconds per user — per _user_, not per channel, because the
abuse it prevents is spamming somebody with call banners.

The client joins the DM's voice channel **before** ringing: the ring is only
truthful once the caller is actually there.

### call_incoming (Server -> Client)

Forwarded to every other participant that is connected. An offline addressee is
a no-op by construction — a ring that arrives after the fact is worse than no
ring.

```json
{
  "type": "call_incoming",
  "payload": { "channel_id": 100, "from_user": 2, "username": "jordan" }
}
```

### call_decline (Client -> Server) / call_declined (Server -> Client)

```json
{
  "type": "call_decline",
  "payload": { "channel_id": 100 }
}
```

Answered with `call_declined` (same payload shape as `call_incoming`) to the
DM's other participants. It is addressed to all of them rather than to "the
ringer" because the server does not know who that was — no call state, by
design — and in a group more than one person may be ringing.

A declining client stops its own ring; a ringing client stops on
`call_declined`, on the ringer's `voice_leave`, or after a 30 second timeout.
A timeout deliberately sends **no** `call_decline`: it means "nobody was there",
and the ringer's own 30s window already covers it.

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

---

## Error Handling

### error (Server -> Client)

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

### Error Codes

| Code | Description |
|------|-------------|
| `BAD_REQUEST` | Invalid payload format or field values |
| `INTERNAL` | Server-side error |
| `NOT_FOUND` | Channel or message not found |
| `FORBIDDEN` | Missing required permission |
| `RATE_LIMITED` | Too many requests (includes `retry_after` in seconds) |
| `ALREADY_JOINED` | Already in this voice channel |
| `CHANNEL_FULL` | Voice channel at capacity |
| `VOICE_ERROR` | Voice-specific error |
| `VIDEO_LIMIT` | Maximum video streams reached |
| `BANNED` | User is banned |
| `INVALID_JSON` | Message is not valid JSON |
| `UNKNOWN_TYPE` | Unrecognized message type |
| `SLOW_MODE` | Channel has slow mode enabled |
| `CONFLICT` | Duplicate reaction or constraint violation |
| `SERVER_MUTED` | Self-unmute refused: a moderator imposed the mute |
| `SERVER_DEAFENED` | Self-undeafen refused: a moderator imposed the deafen |

After 10 consecutive invalid JSON messages, the connection is forcibly closed.

---

## Rate Limits

All rate limits are enforced server-side using a token bucket rate limiter.

| Action | Limit | Window | Error Response |
|--------|-------|--------|----------------|
| Chat send | 10 | 1 second | `RATE_LIMITED` error |
| Chat edit | 10 | 1 second | `RATE_LIMITED` error |
| Chat delete | 10 | 1 second | `RATE_LIMITED` error |
| Typing | 1 | 3 seconds | Silently dropped |
| Presence | 1 | 10 seconds | `RATE_LIMITED` error |
| Reactions | 5 | 1 second | `RATE_LIMITED` error |
| Voice join / leave | 5 | 1 second | `RATE_LIMITED` error |
| Voice camera | 2 | 1 second | `RATE_LIMITED` error |
| Voice screenshare | 2 | 1 second | `RATE_LIMITED` error |
| Voice token refresh | 1 | 60 seconds | `RATE_LIMITED` error |
| Voice E2EE announce | 5 | 1 second | `RATE_LIMITED` error |
| Voice E2EE offer | 64 | 1 second | `RATE_LIMITED` error |
| Voice moderation (mute/deafen/move/kick) | 5 | 1 second | `RATE_LIMITED` error |
| Call ring | 1 | 3 seconds | `RATE_LIMITED` error |

The E2EE offer budget is deliberately higher than the announce budget: a key
rotation fires one offer per peer in a single burst, so the limit is sized to
a whole rotation rather than to a single frame.

---

## Message Type Reference Table

The authoritative type inventory is [protocol-schema.json](protocol-schema.json),
from which the Go and TypeScript constant files are generated
(`make protocol-generate` / verified in CI by `make protocol-verify`). The
tables below add per-type behavioral notes.

### Client -> Server (27 types)

| Type | Rate Limit | Notes |
|------|-----------|-------|
| `auth` | N/A (first message) | Token + optional last_seq |
| `chat_send` | 10/sec | + slow mode per channel |
| `chat_edit` | 10/sec | Own messages only |
| `chat_delete` | 10/sec | Own or mod (non-DM) |
| `reaction_add` | 5/sec | |
| `reaction_remove` | 5/sec | |
| `typing_start` | 1/3sec/channel | Silently dropped |
| `channel_focus` | None | Updates read state |
| `mark_read` | None | Updates read state without moving focus |
| `presence_update` | 1/10sec | |
| `voice_join` | 5/sec | |
| `voice_leave` | 5/sec | Empty payload |
| `voice_mute` | 2/sec | Refused with `SERVER_MUTED` while server muted |
| `voice_deafen` | 2/sec | Refused with `SERVER_DEAFENED` while server deafened |
| `voice_camera` | 2/sec | Requires USE_VIDEO |
| `voice_screenshare` | 2/sec | Requires SHARE_SCREEN |
| `voice_mod_mute` | 5/sec | Requires MUTE_MEMBERS + outranks target |
| `voice_mod_deafen` | 5/sec | Requires MUTE_MEMBERS + outranks target |
| `voice_mod_move` | 5/sec | Requires MUTE_MEMBERS + outranks target |
| `voice_mod_kick` | 5/sec | Requires MUTE_MEMBERS + outranks target |
| `voice_token_refresh` | 1/60sec | Must be in voice |
| `voice_e2ee_announce` | 5/sec | ECDH pubkey announce |
| `voice_e2ee_offer` | 64/sec | Wrapped room key to target (budgeted per key rotation) |
| `call_ring` | 1/3sec | DM participants only; fans out as `call_incoming` |
| `call_decline` | None | DM participants only; fans out as `call_declined` |
| `chat_command` | None | Plugin slash command; max 64 args; broadcast gated by `CanPost` |
| `ping` | None | Heartbeat |

### Server -> Client (39 types)

| Type | Has seq? | Delivery |
|------|----------|----------|
| `auth_ok` | No | Direct |
| `auth_error` | No | Direct (then close) |
| `ready` | No | Direct |
| `chat_message` | Non-DM only | Channel or DM participants |
| `chat_send_ok` | No | Direct to sender |
| `chat_edited` | Non-DM only | Channel or DM participants |
| `chat_deleted` | Non-DM only | Channel or DM participants |
| `chat_bulk_deleted` | Yes | Channel |
| `reaction_update` | Non-DM only | Channel or DM participants |
| `typing` | No | Channel (excl. sender) or DM |
| `presence` | Yes | All clients |
| `channel_create` | Yes | All clients |
| `channel_update` | Yes | All clients |
| `channel_delete` | Yes | All clients |
| `voice_state` | Yes | All clients |
| `voice_leave` | Yes | All clients |
| `voice_moved` | No | Direct to moved user |
| `voice_disconnected` | No | Direct to disconnected user |
| `voice_config` | No | Direct to joiner |
| `voice_token` | No | Direct to joiner |
| `voice_speakers` | No | Reserved — not currently emitted |
| `member_join` | Yes | All clients |
| `member_leave` | Yes | Reserved — not currently emitted |
| `member_update` | Yes | All clients |
| `user_update` | Yes | All clients (profile changes) |
| `member_ban` | Yes | All clients |
| `roles_update` | Yes | All clients (full role list) |
| `emoji_update` | Yes | All clients (full custom-emoji set) |
| `dm_channel_open` | No | Direct to participant |
| `dm_channel_close` | No | Direct to participant |
| `call_incoming` | No | Direct to each other DM participant |
| `call_declined` | No | Direct to each other DM participant |
| `voice_e2ee_announce` | No | Voice channel (excl. sender) |
| `voice_e2ee_offer` | No | Direct to target participant |
| `server_restart` | Yes | All clients |
| `error` | No | Direct to requester |
| `pong` | No | Direct to pinger |
| `command_reply` | No | Direct to invoking client (ephemeral plugin reply) |
| `plugin_broadcast` | No | Channel (plugin output posted as a broadcast) |

### Plugin command types

Three wire types exist for the WASM plugin system. Since 2026-08-04 they are
listed in `protocol-schema.json` like every other type (closing DC-01), so
the generated constants cover them and `make protocol-verify` plus the
`ws` package's protocol-contract test gate them against drift.

| Type | Direction | Notes |
|------|-----------|-------|
| `chat_command` | Client -> Server | `{command, args[], channel_id, req_id?}`; max 64 args; unknown commands return an `error`. No dedicated rate limit; a channel broadcast is gated by the same `CanPost` policy as a real message send. |
| `command_reply` | Server -> Client | Ephemeral plugin reply, sent only to the invoking client; echoes `req_id`. Payload: `{text}`. |
| `plugin_broadcast` | Server -> Client | Plugin output posted to a channel. Payload: `{channel_id, user_id, command, text}`. |
