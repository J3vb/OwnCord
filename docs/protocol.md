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
13. [Threads](#threads)
14. [Channel Updates](#channel-updates)
15. [Member Updates](#member-updates)
16. [Moderation Queue](#moderation-queue)
17. [Moderator Actions](#moderator-actions)
18. [Voice Signaling](#voice-signaling)
19. [Voice Moderation](#voice-moderation)
20. [Voice End-to-End Encryption](#voice-end-to-end-encryption)
21. [Direct Messages](#direct-messages)
22. [Server Restart](#server-restart)
23. [Error Handling](#error-handling)
24. [Rate Limits](#rate-limits)
25. [Message Type Reference Table](#message-type-reference-table)

---

## Transport Layer

### WebSocket Endpoint

```
wss://{host}/api/v1/ws
```

The client connects via the Tauri Rust backend's WS proxy rather than native WebView2 WebSocket. This is required because WebView2 rejects self-signed TLS certificates. The Rust proxy uses TOFU (Trust On First Use) certificate pinning.

### Transport Limits

| Limit                  | Value        |
| ---------------------- | ------------ |
| Max read size          | 1 MB         |
| Max read size pre-auth | 8 KiB        |
| Max message content    | 4000 runes   |
| Write timeout          | 10 seconds   |
| Auth deadline          | 10 seconds   |
| Send buffer per client | 256 messages |

---

## Message Envelope

Every WebSocket message is a JSON object with these fields:

```json
{
  "type": "message_type",
  "id": "unique-request-id",
  "payload": {},
  "seq": 42
}
```

| Field     | Type   | Required                     | Description                                                                                                                                      |
| --------- | ------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`    | string | Yes                          | Determines how `payload` is interpreted                                                                                                          |
| `id`      | string | Client messages only         | Client-generated UUID for request/response correlation                                                                                           |
| `payload` | object | Yes                          | Contents vary by `type`. Must be present (can be `{}`).                                                                                          |
| `seq`     | uint64 | Broadcast messages only      | Monotonically increasing sequence number. Only present on server-to-client broadcast messages.                                                   |
| `cseq`    | uint64 | Sequenced server frames only | Per-connection count of sequenced frames written to this socket, starting at 1. See Delivery guarantee. Absent from servers without the feature. |

---

## Sequence Numbers

The sequence number system enables reconnection with state recovery.

1. The server maintains an atomic `uint64` counter.
2. Every broadcast message gets the next seq number.
3. The message is stored in a 1000-event replay ring buffer.
4. The client tracks `lastSeq` from every server broadcast.

### Which Messages Get seq

| Category           | Has seq? | Examples                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel broadcasts | Yes      | `chat_message`, `chat_edited`, `chat_deleted`, `chat_bulk_deleted`, `chat_pinned`, `reaction_update`, `poll_update`                                                                                                                                                                                                                                                   |
| Global broadcasts  | Yes      | `presence`, `presence_batch` (see below), `member_join`, `member_update`, `member_ban`, `roles_update`, `emoji_update`, `sticker_update`, `voice_state` (broadcast form; see below), `voice_leave`, `channel_update`, `channel_delete`, `server_restart`                                                                                                              |
| Ephemeral          | No       | `typing`, `upload_policy` (see below), `game_activity_policy` (see below), a full `presence_batch` snapshot (see below), `mod_queue`, `mod_action`, `member_timeouts` (see below), `channel_categories` (see below), `appeal_status`, `mention_count`, `read_state`, `channel_activity`, `thread_follow_update`, `channel_create` (targeted per recipient; see below) |
| DM chat events     | Yes      | DM `chat_message`, `chat_edited`, `chat_deleted`, `reaction_update`, `poll_update` — sequenced and replayable exactly like channel broadcasts, delivered only to the DM's participants                                                                                                                                                                                |
| DM lifecycle       | No       | `dm_channel_open`, `dm_channel_close`, `dm_request` (B5-6)                                                                                                                                                                                                                                                                                                            |
| Call signalling    | No       | `call_incoming`, `call_declined`                                                                                                                                                                                                                                                                                                                                      |
| Direct responses   | No       | `auth_ok`, `auth_error`, `chat_send_ok`, `chat_forward_ok`, `poll_create_ok`, `poll_vote_ok`, `poll_end_ok`, `error`, `voice_config`, `voice_token`, `pong`                                                                                                                                                                                                           |

**Presence is sequenced, but droppable.** Connect and disconnect presence
arrives as `presence_batch` (one frame per coalescing window), a status change
(`presence_update`) as `presence`; both are sequenced global broadcasts that
replay on a warm resume. Unlike every other sequenced frame, a presence frame
that finds a client's send buffer full is **dropped instead of disconnecting
the client**: the client then gets a full `presence_batch` snapshot within one
window, and its next resume takes the full `ready`, because replay cannot bring
back a seq below ones it has since seen. Clients must treat presence as
eventually consistent and must not assume they have seen every transition. See
Presence for the invisible-member split.

**Delivery guarantee.** Every frame that carries `seq` also carries `cseq`: 1
on the first sequenced frame written to a socket, one more on each later one.
A frame not meant for this connection never uses a `cseq`. While `cseq` stays
contiguous, the client has every sequenced frame the server addressed to this
connection, except presence frames, which may be dropped and are repaired by a
full `presence_batch` snapshot. When the server loses a frame it cannot replay
(one dropped before it was sequenced, or one withheld because its content gate
could not be read), it marks each connected recipient for a full resync and
makes that connection's next `cseq` one higher than expected. A client that
sees a `cseq` other than last + 1 reconnects with its `last_seq` after a short
random delay, and the server answers with the full `ready`. `cseq` restarts on
every socket and is never sent back. A server without this feature sends no
`cseq`, and the client then skips the check.

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

| Field                 | Type     | Required | Description                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`               | string   | Yes      | Session token obtained from `POST /api/v1/auth/login`                                                                                                                                                                                                                                                                     |
| `last_seq`            | uint64   | No       | Last sequence number received. If > 0, server attempts replay. Default 0.                                                                                                                                                                                                                                                 |
| `active_channel_id`   | int64    | No       | The channel the client had open when it disconnected. Honoured only on a resume (`last_seq > 0`) and only after the server re-checks read permission; an unknown or unreadable id is ignored. Omit when unknown.                                                                                                          |
| `wake`                | bool     | No       | `true` marks a dial the client made on its own after its process was suspended (a laptop waking from sleep). Servers that keep one connection per device session accept it like any other dial; the flag is ignored. Older servers refused it with `ANOTHER_DEVICE_ACTIVE` while a different session held the connection. |
| `epoch`               | int      | No       | The wire epoch this client speaks (`PROTOCOL_EPOCH`, generated from `protocol/schema.json`). Absent means 0. See [Compatibility](#compatibility-protocol-epoch).                                                                                                                                                          |
| `features`            | string[] | No       | Optional capabilities this client can render, declared once per connection (see [Client features](#client-features)). Absent means none. Only `"forums"` is defined; unknown names are ignored. The list is untrusted input and only ever narrows what the socket is sent.                                                |
| `identity_public_key` | string   | No       | This device's voice E2EE identity public key (base64, at most 128 characters, same rules as `identity_public_key` on `PATCH /users/me`). See [Identity key per device](#identity-key-per-device). An invalid or wrongly typed value is ignored and logged; it never fails the handshake.                                  |

#### Identity key per device

Each device keeps its own identity keypair, and several devices of one account
can be connected at once, so the account's single published key
(`users.identity_public_key`) cannot say which key signed a given voice
announce. The key therefore travels with the connection: the server keeps the
`identity_public_key` from a connection's `auth` frame on that connection and
on its session row (`sessions.identity_public_key`, rewritten on every connect),
and attaches it to every `voice_e2ee_announce` that connection makes (see
[voice_e2ee_announce (Server -> Client)](#voice_e2ee_announce-server---client-broadcast-to-voice-channel)).
The field is optional: an older client sends none, and its announces carry
none. `users.identity_public_key` and `PATCH /users/me` are unchanged.

`active_channel_id` closes a resume-only gap. The hub restores a reconnecting
client's channel subscription by copying it from the previous connection entry,
but that entry is deleted as soon as the server observes the old socket close —
which normally happens well before the client reconnects. Without the hint the
resumed socket holds no channel subscription until its post-`auth_ok`
`channel_focus` round trip completes, and everything broadcast to that channel
in the meantime reaches nobody on that connection and can never be re-requested,
since the client only ever reports `max(seq)`.

The hint is honoured on both resume paths: a replay-capable resume (ring or
cold tier) and the full re-sync the hub sends when replay cannot converge — for
instance after a server restart, when the fresh per-boot sequence floor makes
every in-memory gap unreplayable. The full re-sync also holds no channel
subscription until `channel_focus` otherwise, so omitting the hint there loses
the same frames.

Clients should still send `channel_focus` after `auth_ok` — it remains the
fallback for servers that predate this field, and it is idempotent.

`wake` carries no privilege and grants nothing. The server keeps one live
connection per **device session** (the session token the socket authenticated
with), not one per account, so a device dialling on its own after a suspend no
longer displaces another device and is never refused: it connects alongside the
others. The flag is accepted and ignored. `ANOTHER_DEVICE_ACTIVE` is no longer
sent; the code stays in the protocol for clients that still talk to an older
server, which refused a wake dial while a different session held the live
connection or a call parked in the voice grace window.

#### Connection model

- One connection per device session. A user may be connected from several
  devices at once, each on its own session token; everything addressed to "the
  user" (direct messages, read state, mention counts, permission and role
  changes, timeouts, settings) reaches every connection.
- A new connection replaces an older one only when it is the **same session**
  (a reload, a network reconnect, a wake on the same device). The older socket
  receives `SESSION_REPLACED` and is closed; the new one carries on.
- At most 10 connections per user. The 11th evicts the oldest connection of a
  different session with `SESSION_REPLACED`.
- Presence is online while any connection exists; the user goes offline, once,
  when the last one drops.
- A ban, sign-out-everywhere or an admin disconnect closes every connection. A
  single revoked session closes only the connection that rode it.
- Voice: one call per account. A `voice_join` from a second device **moves**
  the call: the device that held it receives `voice_disconnected` with reason
  `Call moved to another device` before anything produced by the new join, and
  the new device joins normally. A move to a different channel broadcasts
  `voice_leave` for the old one; a move within the same channel does not, since
  the new device's join produces the `voice_state`. Voice commands
  (`voice_leave`, `voice_mute`, `voice_deafen`, `voice_camera`,
  `voice_screenshare`, watching and E2EE announces, token refresh) from a
  connection that does not hold the call do nothing to the call another
  connection holds. While a call is on another device, `ready` and
  `voice_state` still list the user as in voice, so a client must not send
  `voice_leave` on `ready` for a call it does not hold locally.

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
      "role_ids": [1, 4],
      "display_name": "Alex A.",
      "about": "A short bio.",
      "custom_status": "shipping phase 6",
      "custom_status_expires_at": "2026-10-15T18:00:00Z",
      "banner": "/api/v1/files/7a1e...",
      "banner_color": "#5865f2",
      "status": "invisible"
    },
    "server_name": "My Server",
    "motd": "Welcome!",
    "replay_source": "none",
    "upload_policy": {
      "max_upload_bytes": 104857600,
      "blocked_extensions": ["bat", "cmd", "ps1", "vbs", "js", "hta"],
      "thumbnails": true
    },
    "game_activity_policy": { "enabled": true }
  }
}
```

`game_activity_policy.enabled` (WP 8.3e-2) is whether game activity is shown on
this server right now. It rides every `auth_ok`, connect and resume alike: a
resume gets no `ready`, and the unsequenced
[`game_activity_policy`](#game_activity_policy-server---client-broadcast)
frame is not replayed, so a switch flipped while the client was offline
reaches it here. A client treats this value, when present, as the answer to
"is game activity supported", ahead of `ready.capabilities.game_activity`; a
server that omits it leaves the answer to `ready`.

`display_name`, `about`, `custom_status`, `banner` and `banner_color` are the
signed-in user's own profile fields, `null` when unset. `display_name` is what clients render
instead of `username`; `@mentions` still resolve against `username`, which is
the unique handle.

`display_name` (max 32), `custom_status` (max 128) and a group DM name (max 100) are single-line text: runs of spaces collapse to one, and the server
refuses control characters, line and paragraph separators (so no line breaks or
tabs), invisible and blank-filler characters (zero-width, bidi overrides,
variation selectors other than the emoji selector after a symbol) and more than
2 combining marks in a row. A zero-width joiner is allowed only between
emoji/symbol characters. The length cap counts what is left after collapsing.
Names and statuses stored before this rule stay as they are.

`custom_status_expires_at` (RFC 3339 UTC, or `null` when the custom status has
no expiry or there is none) is the instant the signed-in user's own custom
status clears itself, so a client can show a countdown. It is **only** in the
user's own `auth_ok` and `GET /api/v1/users/me`: every other client is never
told the instant, it just sees the status go to `null` (see `presence`). A
status whose instant has passed but that the server has not cleared yet is
sent as `null` in both fields.

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

`upload_policy` is what a client checks before an upload; the upload route
stays authoritative, and later fields may be added. `max_upload_bytes` is
`upload.max_size_mb` in bytes, the largest file `POST /api/v1/uploads`
accepts. `0` means uploads are disabled on this server: the route refuses
every non-empty file, and clients disable attaching. An older server omits
`upload_policy`; clients then assume 100 MiB.

`blocked_extensions` and `allowed_extensions` are the file-type policy in
force (config.yaml's lists, or the owner's saved ones). Only a file name's
final extension counts, case-insensitively, ignoring trailing dots and spaces:
a blocked one is refused, and a non-empty `allowed_extensions` accepts only
those. Either is omitted when empty or unknown, and clients then refuse
nothing by name. A saved change reaches connected clients at once as an
[`upload_policy`](#upload_policy-server---client-broadcast) event, and new
connections from then on.

`thumbnails` is `true` when the server serves
`GET /api/v1/files/{id}/thumb`, an image's bounded preview. A client then shows
an inline image from that route and loads the full file only when it is
opened. It is omitted by older servers, and clients then show the full file.
A `image/heic`, `image/heif` or `image/tiff` attachment has no image a client
can show except that route's JPEG, so a client without `thumbnails` shows it as
a file to download.

### Step 3: Failure -- auth_error

```json
{
  "type": "auth_error",
  "payload": {
    "message": "invalid token"
  }
}
```

`message` is one of a fixed set the server actually sends: `invalid message`
(the first frame did not parse as JSON), `first message must be auth` (the
first frame was not type `auth`), `missing token`, `invalid token`, `session
expired`, and `user not found`.

After sending `auth_error`, the server closes the connection with close code
**1008** (policy violation) and reason `authentication failed`.

One refusal carries more than `message`. When the client's `epoch` is outside
the range the server accepts, the payload is:

```json
{
  "type": "auth_error",
  "payload": {
    "message": "this client speaks protocol epoch 0 but the server needs 2; update the client",
    "code": "protocol_epoch_unsupported",
    "client_epoch": 0,
    "server_epoch": 2,
    "min_epoch": 2
  }
}
```

`message` names which side to update; the numbers let a client decide for
itself (`server_epoch > client_epoch` — the client is the older side). The
close that follows is the same 1008.

### Client features

`auth` carries an optional `features: string[]` (additive within epoch 1; absent
is `[]`). It is how a client says it can render something an older client could
not, so the server can withhold that thing instead of showing the older client a
broken one. The server keeps the parsed set on the connection for its life; every
connection sends a fresh `auth`, so a client that updates re-declares. It is the
first such declaration. Names the server does not know are ignored, the list is
capped (32 names of at most 32 bytes each), and it grants nothing: it only
narrows what the socket is sent.

| Feature  | Declared by            | Effect on a socket that does **not** declare it                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `forums` | clients from WP 6.9d-b | No `type: "forum"` row in `ready.channels`, and no forum `channel_create` (channel creation, visibility refresh, timeout refresh and role refresh alike). Those frames are per recipient and unsequenced, so skipping one allocates no sequence number. It also gets no frame for a forum's posts (see [Forum posts](#forum-posts)). |

`channel_update` for a forum is **not** filtered: it is one shared sequenced
frame, and dropping it for some sockets would allocate a sequence number and
withhold it. A client without forums drops an update for a channel id it does not
hold. `channel_delete` is a bare id and is equally harmless. REST
`GET /api/v1/channels` is not used by those clients and lists forums with their
type.

### Compatibility (protocol epoch)

The protocol has one version number, the **epoch**, declared once as
`protocol_epoch` in `protocol/schema.json` and generated into
`ws.ProtocolEpoch` (server) and `PROTOCOL_EPOCH` (client). The client sends it
in `auth`; the server accepts an `epoch` in `[min_epoch, server_epoch]` and
refuses anything else with `protocol_epoch_unsupported`.

- **Within an epoch, changes are additive.** New optional fields; new message
  types the other side may ignore. Unknown server→client types are ignored by
  the client; unknown client→server types get an `error` frame. The frozen
  transcripts under `protocol/fixtures/epoch-1/` replay against the server
  (`Server/ws/protocol_epoch1_contract_test.go`) for as long as epoch 1 is
  accepted — a failing fixture means "bump the epoch", not "fix the fixture".
  The client half replays each server→client frame through the real dispatcher
  and asserts its store effect (`Client/tests/contract/protocol-fixtures.test.ts`,
  ARCH-02), so a rename or retype on the wire fails a client test and not only
  the server's. The previous release's client is held to the same fixtures in
  CI (ARCH-027); see [N-1 compatibility](../protocol/README.md#n-1-compatibility).
- **A breaking change is a new epoch.** Bump `protocol_epoch`, regenerate, and
  set `minClientEpoch` (`Server/ws/messages.go`) to the new value: the server
  accepts exactly one epoch by policy. Epoch 1 additionally accepts an absent
  `epoch` (0), because clients up to v1.2.0-alpha.4 predate the field.
- **The server upgrades first.** A release's signed server-update manifest
  carries its `protocol_epoch`, and `GET /api/v1/client-update` never
  advertises a release whose epoch is newer than the server's own — a client
  that auto-updated onto it would be refused at the next handshake. Releases
  that do not bump the epoch (fixes, additive features) reach clients whether
  or not the server has been updated.
- **A refused client can still update in place.** On
  `protocol_epoch_unsupported` with a newer server, the desktop client shows
  the regular update banner on the connect page.

### Step 4: ready Payload

After `auth_ok`, the server sends a `ready` message containing all initial state.

### Step 5: Presence

The user's arrival rides the next `presence_batch` to all connected clients,
preceded by a `member_join` only for a member they cannot have yet (see
`member_join`):

```json
{
  "type": "presence_batch",
  "seq": 16,
  "payload": { "updates": [{ "user_id": 1, "status": "online", "custom_status": null }] }
}
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

### Server Protocol Ping

Every 25 seconds the server sends a WebSocket protocol Ping frame (RFC 6455
control frame, not a JSON message) and waits up to 25 seconds for the Pong.
Browsers and WebSocket libraries answer it automatically, so a peer stays
alive even when its app-level ping timer is throttled. A Pong counts as
activity for the stale sweep below; a peer that misses a Pong is disconnected,
so a silent peer is closed within 50 seconds. A client can treat a gap of more
than 2.5 × 25 seconds without any frame from the server as a dead connection.
The server sends a message larger than 16 KiB as a fragmented message (RFC
6455 continuation frames), so a Pong or Ping never waits behind one large frame
on a slow link.

### Server Stale Client Sweep

Every 30 seconds, the server checks all clients. Any client with no activity (a message, or a Pong to the server's protocol Ping) for 90 seconds is forcibly disconnected. Normal chat activity also keeps the connection alive.

### Client Silence Deadline

The client treats any inbound frame (a `pong`, chat, presence) as proof that
the socket still delivers. After 60 seconds with no inbound frame, it drops a
half-open socket and reconnects. It does this only once a heartbeat ping has
gone unanswered for at least 15 seconds. That rule keeps a minimised window,
whose throttled heartbeat timer may not have sent a ping yet, from
reconnecting for no reason.

When the client may have just woken from a suspend — a heartbeat tick that
lands more than three heartbeat intervals (90 seconds) after the previous one,
the window becoming visible again, or the network coming back online — it
sends a ping at once and shortens the deadline to 15 seconds (never extending
one already due sooner). A socket that died during the suspend is redialled
within about 15 seconds instead of staying Connected for up to a minute.
A gap longer than 90 seconds since the client last saw its clock running — at
a heartbeat tick, an inbound frame or when a reconnect is about to dial — also
marks its next dials `wake: true` ([Step 1](#step-1-client-sends-auth)); the
flag is informational now that devices coexist
([connection-and-auth.md](architecture/ux/connection-and-auth.md) §4).

### Desktop Transport Liveness

The desktop client's Rust WebSocket proxy (`Client/src-tauri/src/ws_proxy.rs`)
also sends a WebSocket protocol Ping every 25 seconds, which the server's read
loop answers with a Pong. If no frame of any kind arrives for 62.5 seconds
(2.5 ping intervals), the proxy closes the socket and the client reconnects.
This catches a half-open connection that a firewall or NAT dropped silently,
and does not depend on the webview's JSON ping timer, which the OS may throttle
while the window is minimised. The JSON ping above is unchanged.

---

## Reconnection with State Recovery

When a connection drops, the client automatically reconnects with exponential backoff (1s to 30s max) and sends `last_seq` in the `auth` message. The server resolves the reconnect through a **3-tier replay pipeline** (cheapest first):

| Tier | Condition                                                                                                   | Server Behavior                                                                                                                      | `replay_source` |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| —    | `last_seq == 0`                                                                                             | Full flow: `auth_ok` + `ready`, then the user's presence in the next `presence_batch`                                                | `none`          |
| 1    | seq within the in-memory ring buffer (1000 events)                                                          | Replay flow: `auth_ok` + missed events + `presence_batch` (no `ready`). Channel-scoped events are permission-filtered (fail-closed). | `buffer`        |
| 2    | seq within the persistent `events` table (max 5000 events, subject to retention)                            | Same replay flow, served from the cold tier                                                                                          | `db`            |
| 3    | seq too far behind, channel visibility changed while away, or a frame for this user was dropped or withheld | Full flow (fallback): same as `last_seq == 0`                                                                                        | `none`          |

A visibility watermark forces the tier-3 full re-sync whenever channel
visibility changed while the client was disconnected, so permission changes
can never be replayed around.

DM chat events (`chat_message`, `chat_edited`, `chat_deleted`,
`reaction_update` in DM channels) are sequenced into the same ring buffer and
`events` table as channel broadcasts, so they replay at tiers 1 and 2 —
filtered to the DM's participants. The unsequenced DM lifecycle events
(`dm_channel_open`/`dm_channel_close`) are not replayed; that state is always
recoverable via the full `ready` payload. `dm_request` (B5-6) is unsequenced
too, but its state is not in `ready` — a missed one is recovered from
`GET /api/v1/dm-requests` instead (see the dm_request section below).

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

**capabilities:** `{ "message_deduplication": true, "message_retry_window_seconds": 86400, "message_retry_floor_ms": 0, "read_pointer": true, "user_notes": true, "profile_banners": true, "dm_privacy": true, "polls": true, "threads": true, "multi_role": true, "manage_nicknames": true, "game_activity": true, "listening_activity": true, "thread_follows": true, "voice_messages": true }`. `voice_messages` (WP 8.9) means `POST /api/v1/uploads` accepts the `voice_duration_ms` and `voice_waveform` query parameters and an attachment of a voice message carries `duration_ms` and `waveform` (see `docs/api.md`, File Upload and Serving); a client that does not see it offers no voice message recorder. `listening_activity` (WP 8.10a) means the server understands `listening_update`, carries a member's song as `listening` on `presence` and `presence_batch` and as `ready.listening`, and has member activity switched on right now; it follows the same admin switch as `game_activity` and is `false` while it is off. A client that does not see it sends no `listening_update` and shows no song. `game_activity` means the server understands `activity_update`, carries a member's game as `activity` on `presence` and `presence_batch` and as `ready.activities`, and has game activity switched on right now (WP 8.3e-2: an admin can turn it off, and the flag is then `false`, like `threads` tracking whether threads are available); a client that does not see it sends no `activity_update` and shows no game. The runtime switch is [`game_activity_policy`](#game_activity_policy-server---client-broadcast). `multi_role` means a member can hold several roles: `role_ids` rides `members[]`, `auth_ok.user`, `member_join.user` and `member_update`, `roles[]` carry `hoist` and `mentionable`, and `PUT` / `DELETE {base}/{id}/roles/{roleId}` add and remove one role (see `docs/api.md`, Member actions). A client that does not see it treats `role` as the only role. `manage_nicknames` means the server accepts `PUT /api/v1/moderation/users/{id}/nickname` (body `{ "display_name": string | null }`, `null` or `""` clears) from a member holding `MANAGE_NICKNAMES` who outranks the target, and answers with the usual `user_update` frame to every client; a client that does not see it offers no Change Nickname action, even if the member holds the bit. `polls` means the server understands `poll_create`, `poll_vote` and `poll_end` and sends `poll_update`; a client that does not see it hides the Poll button. `threads` means the server supports the thread frames and `GET /api/v1/channels/{id}/threads` (see Threads); a client that does not see it shows no thread controls. `ready` never lists thread rows in `channels`. `thread_follows` means the server understands `thread_follow`, sends `thread_follow_update` and lists the viewer's followed threads in `ready.threads`; a client that does not see it shows no Follow control and no followed threads. It is only ever `true` together with `threads`. `dm_privacy` means the server stores the two direct message privacy settings (`GET` and `PUT /api/v1/users/me/privacy`, body `{ "allow_member_dms": bool, "message_requests": bool }`, both required); a client that does not see it shows no privacy controls. The server applies them to direct messages (see `dm_request`). `profile_banners` means the server supports profile banners (`POST` and `DELETE /api/v1/users/me/banner`, `banner_color` on `PATCH /api/v1/users/me`); a client that does not see it shows no banner controls. `user_notes` means the server stores private profile notes (`GET` and `PUT /api/v1/users/me/notes/{userId}`); a client that does not see it keeps notes in local storage. `read_pointer` means the server supports `channel_focus.read`, `mark_read.message_id`, `mark_unread` and the `read_state` frame (see Channel Focus and Read State). A client that does not see it keeps marking on focus and does not offer Mark Unread.
These fields advertise retry-safe `chat_send` support. Older servers omit them;
clients must not infer support from the protocol epoch or silently retry a
durable pending message against a server that no longer advertises support.

**channels[]:** `id`, `name`, `type` (`text`/`voice`/`announcement`/`forum`), `category`, `category_id`, `category_position`, `topic`, `position`, `can_send`, `can_moderate_voice`, `can_move_voice`, `can_delete_others`, `can_pin`, `can_react`, `slow_mode`, `nsfw`, `afk`, `private`, `nsfw_acknowledged`, `voice_max_users`, `voice_max_video`, `unread_count` (text, announcement and voice), `last_message_id` (text, announcement and voice), `mention_count` (text, announcement and voice), `last_read_message_id` (text, announcement and voice)

`last_read_message_id` is the caller's own read pointer (`read_states.last_message_id`):
the newest message id they have read, or `0` when they have no read state for the
channel. It is not `last_message_id`, which is the newest live message in the
channel. A client can place its NEW line after the pointer. It is plain data with
no capability flag; an older server omits it.

`afk` is `true` on the server's one AFK voice channel and `false` everywhere
else (migration `067`, WP 6.10a); it rides the same payload on `ready`,
`channel_create` and `channel_update`, and an older server omits it, which a
client reads as `false`. The AFK channel is listen-only: the voice token for it
(on `voice_join` and on `voice_token_refresh`) grants no microphone, camera or
screen-share publishing whatever the role allows. An admin sets or clears it
with `PUT /admin/api/afk-channel`, and the previous and the new channel each
get a `channel_update`.

`forum` (migration `075`, WP 6.9d) is present on a `type: "forum"` channel and absent
on every other: `{ "tags": [{ "id", "name", "emoji"?, "position" }], "require_tag": bool,
"default_auto_archive_minutes": 60 | 1440 | 4320 | 10080 }`. It rides `ready`,
`channel_create` and `channel_update`, is identical for every recipient (so the shared
`channel_update` stays shared), and an older server omits it. A forum holds no messages,
so it carries no `unread_count`, `last_message_id`, `mention_count` or
`last_read_message_id`; its `can_send` means "may create a post". Its guidelines are its
`topic`. A forum is sent only to sockets that declared the `forums`
[client feature](#client-features). `chat_send` into a forum answers `BAD_REQUEST`, and
`typing_start` into one is dropped silently. The forum's tags and settings are written
with `PUT /admin/api/channels/{id}/forum` (and `/api/v1/moderation/channels/{id}/forum`):
the body is the whole `forum` object, a tag without `id` is created, a listed `id` is
renamed, re-emojied and repositioned (its place in the list), a tag missing from the list
is deleted with its links to posts, and the result is one audit row and one
`channel_update`. At most 20 tags per forum, names of 1 to 20 characters unique ignoring
case, `emoji` an optional reaction emoji. Posts arrive in a later change.

`nsfw`, `nsfw_acknowledged`, `voice_max_users` and `voice_max_video` are always
present, with their column defaults on an unconfigured channel — `false`,
`false`, `0`, and **`25`** for `voice_max_video`, which is `DEFAULT 25` rather
than zero (migration 004) — never omitted, so "absent" never has to mean two
different things. `nsfw` is a label the server enforces (see below);
`nsfw_acknowledged` is whether the CALLER has their own consent row for it
(migration `047`, B5-7) — always `false` for an unlabelled channel, where it
means nothing; the two voice limits are the values
the voice-join path enforces with `CHANNEL_FULL` / `VIDEO_LIMIT`, shipped so a
client can show "3/5" and explain a refusal it could have predicted.

`private` (3D-6) is the channel-level lock flag, always present on every guild
channel object (`ready` `channels[]`, `channel_create`, `channel_update`), voice
channels included, and never on a DM, so a client can draw a lock icon. A channel is
private when the default role (the `is_default` role, never a hard-coded id)
cannot `READ_MESSAGES` there once that channel's override for the default role
is applied to the role's base permissions, using the same permission math as
every other channel check; a default role with Administrator is never private,
and neither is a channel when no default role exists. It is a property of the
channel, not of the viewer: every recipient of a frame gets the same value, so
the shared `channel_update` carries it. An older server omits it; treat an
absent `private` as `false`. A per-member override never changes it.

`can_moderate_voice` is whether the caller may mute, deafen or disconnect
voice participants (and move those they outrank) in that channel. It is `permissions.AuthorizeVoiceModerator`,
the same authorizer the voice-moderation commands enforce in the target's
channel: the base role must hold `MUTE_MEMBERS`, and the effective permission
after both override layers must hold `READ_MESSAGES | MUTE_MEMBERS`
(Administrator bypasses the bits). Target rank and move-destination capacity
are per-target and stay server-side refusals. No override data is sent. Older
servers omit it.

`can_move_voice` is whether the caller may move voice participants in that
channel regardless of rank. It is `permissions.AuthorizeVoiceMover`: the base
role must hold `MOVE_MEMBERS` and the effective permission after both override
layers must hold `READ_MESSAGES | MOVE_MEMBERS` (Administrator bypasses the
bits). It is independent of `can_moderate_voice`: a caller with only
`MOVE_MEMBERS` gets `can_move_voice` true and `can_moderate_voice` false and may
move but not mute, deafen or disconnect. The owner is a valid move target only
while the owner-only setting `voice_owner_movable` is on, and each target takes
at most 3 moves per 30 seconds; both stay server-side refusals. Older servers
omit it; treat an absent value as "unchanged", never as `false`.

`can_delete_others`, `can_pin` and `can_react` are the caller's per-channel
message affordances, always present on every non-DM channel and absent from
`dm_channels` entries, which carry none of these affordance fields. Each is one
predicate's verdict over the caller's role and both override layers, the same
predicate the server enforces, so a control built on it is never refused for
lack of permission:

- `can_delete_others` is `permissions.CanDeleteMessage` answering "as a
  moderator" (`READ_MESSAGES | MANAGE_MESSAGES`), for deleting another member's
  message. Deleting your own message never depends on it.
- `can_pin` is `permissions.CanPinMessage` (`READ_MESSAGES | MANAGE_MESSAGES`
  in the channel), enforced by `SetMessagePinned` and the REST pin routes.
- `can_react` is `permissions.CanAddReaction` (`READ_MESSAGES | ADD_REACTIONS`,
  false while timed out), enforced by the reaction handlers.

An Administrator gets all three `true`. A timed-out moderator keeps
`can_delete_others` and `can_pin` in channels, because enforcement allows
both there, but `can_react` follows the timeout. Older servers omit all three;
a client then keeps its role-only behaviour and must not treat absent as
`false`. No override data is sent.

`mention_count` is the number of unread messages that mention this user — a
direct `@username` or an authorized `@everyone`/`@here` — in that channel. It is
raised by the send that mentions them (never by an edit) and reset to 0 by
`channel_focus` or `mark_read` at the latest message. A read-state move to the
middle of a channel (`mark_read` with `message_id`, `mark_unread`) recomputes it
from the mentions that raised the badge, with a forward move never raising it
and a backward move never lowering it (see Channel Focus and Read State).
Unlike `unread_count` it is never capped.

`unread_count` counts unread messages but is **capped at 100**: any channel with
100 or more unread messages reports exactly `100`, and the client renders the cap
as `99+`. The cap bounds the per-channel count on every connect — a channel with
thousands of never-read messages does not scan every row — so a client must not
read `100` as an exact total.

**dm_channels[]:** `channel_id`, `recipient` (user object with `id`, `username`, `avatar`, `status`), `last_message_id`, `last_message`, `last_message_at`, `unread_count`, `mention_count`, `last_read_message_id`

A DM's `last_read_message_id` is the caller's own read pointer for the DM, `0` when
they have never read it. The same value is returned by `GET /api/v1/dms`.

A group entry also carries `owner_id`, the group's owner (a current member). It
is omitted for a 1:1 DM, so a client can read its presence as "this server has
group owners". The owner is set to the creator at create and handed to the
lowest remaining member id when the owner leaves or is erased. `GET /dms` and
every `dm_channel_open` carry it too.

A group entry also carries `icon`, the group's icon as a file URL
(`/api/v1/files/{id}`), `""` when it has none. Unlike `owner_id` it is present on
every DM entry, `""` for a 1:1 DM, so a client reads an absent key as an older
server. Load it as an uploaded avatar URL is loaded. Only the group's members
can fetch it, and only while it is the live icon, so a client that loses access
(removed, or the icon replaced) falls back to the stacked avatars.

A DM's `mention_count` is the same `read_states.mention_count` the channel list
carries. It used to be absent here, so a DM mention badge silently reset to 0 on
every reconnect; the ready payload now ships the stored value. A DM's
`unread_count` is capped at 100 under the same rule as `channels[]` above.

**members[]:** All registered users with `id`, `username`, `avatar`, `role` (lowercase name of the member's top role), `role_ids` (every role the member holds, top role first, always an array with at least one id; absent on an older server, where `role` is the only role), `status`, `display_name` (`null` when unset — render it instead of `username`), `about` (the About Me bio, `null` when unset; sent for every member, invisible ones included), `created_at` (the account creation instant, RFC 3339 UTC like `2026-10-15T13:04:05Z`; for an approval-mode account this is the application time), `custom_status` (`null` when unset), `identity_public_key` (base64 long-term E2EE identity key, omitted when the user has not published one — see voice E2EE TOFU), `banner` (the profile banner image path `/api/v1/files/{id}`) and `banner_color` (`#rgb` or `#rrggbb`, lower-case); both are omitted when unset, so absent means no banner

**activities[]:** The games connected members are playing, as `{user_id, name, started_at}` (`started_at` in unix milliseconds), sorted by `user_id`; always an array, `[]` when nobody is playing. It lists every connected member who reports a game and is not offline to this viewer, the viewer included: an invisible member appears only in their own `ready`. It is a separate array, not a field of `members[]`, and is the first key of the payload. It is `[]` while an admin has game activity switched off, and absent on a server without the `game_activity` capability; a client then treats every member as not playing. Later changes arrive as `presence`.

**member_timeouts[]:** The active timeouts this viewer may see, as `{user_id, expires_at}` (RFC 3339 UTC); always an array, `[]` when there are none. A viewer who holds `MODERATE_MEMBERS` or `ADMINISTRATOR` gets every unexpired timeout, sorted by `user_id`; everyone else gets only their own entry, because a timeout is a sanction and other members are not told of it. It is the last field before `members` in the payload. An absent key means an older server: show no timeout icons. See [member_timeouts](#member_timeouts-server---client).

**categories[]:** The full channel category list, as `{id, name, position}` ordered by `(position, id)`. It is present **only** when the viewer holds `MANAGE_CHANNELS` or `ADMINISTRATOR`, and then always, as `[]` when no category exists. Everyone else gets no `categories` key at all: they build their sidebar groups from the `category`, `category_id` and `category_position` of the channels they can see, so the name of an empty category, or of one whose channels are all hidden from them, never reaches them. It sorts between `capabilities` and `channels` in the payload. An absent key means either an older server or a viewer who cannot manage channels: derive groups from `channels[]`. A manager who gains `MANAGE_CHANNELS` mid-session learns the empty categories at the next `ready`, or from the next `channel_categories` frame. See [channel_categories](#channel_categories-server---client).

`status` is per-viewer. Two rules apply, in this order, so a client never has
to reconstruct them:

1. A member with no live connection is `"offline"`, whatever status they last
   chose — a chosen `idle`/`dnd`/`invisible` is preserved server-side across a
   disconnect so the next connect can honour it, but it must not render as
   "present" in the meantime. A member whose connection has not come online
   yet is `"offline"` too; their `presence` broadcast follows once it does.
2. An `"invisible"` member is `"offline"` to everyone but themselves. The
   viewer's own entry carries their true status.

**listening[]:** The songs connected members are listening to (WP 8.10a), as `{user_id, title, artist, player, started_at, duration_ms}` (`started_at` in unix milliseconds, `duration_ms` `0` when unknown), sorted by `user_id`; always an array, `[]` when nobody is. Same visibility as `activities[]`: every connected member who reports a song and is not offline to this viewer, the viewer included, so an invisible member appears only in their own `ready`. It is a separate array, not a field of `members[]`, and sorts between `dm_channels` and `member_timeouts`. It is `[]` while an admin has member activity switched off, and absent on a server without the `listening_activity` capability. Later changes arrive as `presence`.

**threads[]:** The viewer's followed, open threads (WP 6.9c), newest activity first, at most 200; the key is present whenever the server advertises `thread_follows` and is `[]` when the viewer follows none. Each entry is `{ "thread": ThreadInfo, "last_message_id", "last_read_message_id", "unread_count", "mention_count" }`: the thread, the newest live message in it (`0` when empty), the viewer's read pointer for it (`0` for none), the number of messages after the pointer (counted up to 100, as in `channels[]`) and the viewer's `read_states.mention_count` for it. An archived thread is left out (it is still in the thread list), and so is a thread whose parent channel the viewer cannot read (a deny override, a lost role, an archived parent): the follow is kept and the thread returns when read access does. A thread of an NSFW-labelled parent the viewer has not acknowledged is left out too, and `thread_follow_update` frames for it are not sent, because a thread's name discloses its starter message. A follow row for a user who cannot read the parent (or has not acknowledged it) is kept and ignored; it surfaces again if they later regain `READ_MESSAGES` or acknowledge. An older client ignores the key. `ready` is authoritative for the set; `thread_follow_update` only keeps it current.

**voice_states[]:** All users currently in any voice channel: `channel_id`, `user_id`, `username`, `muted`, `deafened`, `server_muted`, `server_deafened`, `speaking`, `camera`, `screenshare`

**roles[]:** All server roles with `id`, `name`, `color`, `permissions` (bitfield), `position`, `is_default`, `hoist` (the role is its own member-list group; every role that existed before multi-role support starts `true`, a new role `false`) and `mentionable` (any member may ping the role). An absent `hoist` means an older server: treat every role as hoisted.

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

| Field               | Type           | Required | Constraints                                                                   |
| ------------------- | -------------- | -------- | ----------------------------------------------------------------------------- |
| `channel_id`        | number         | Yes      | Positive integer                                                              |
| `content`           | string         | Yes\*    | Max 4000 runes. HTML-sanitized. \*Can be empty if `attachments` is non-empty. |
| `reply_to`          | number or null | No       | ID of a message in the same channel that is not deleted, else `BAD_REQUEST`.  |
| `reply_ping`        | bool           | No       | With `reply_to`, `true` adds the replied-to author to `mentions`. See below.  |
| `attachments`       | string[]       | No       | Upload IDs from `POST /api/v1/uploads`. Requires `ATTACH_FILES` permission.   |
| `client_message_id` | string         | No       | Stable timestamp and UUID v4, scoped to the sender. See retry contract below. |
| `sticker_id`        | number         | No       | Sends a custom sticker. See _Sticker messages_ below.                         |

**Sticker messages (WP 8.8a).** `sticker_id`, a positive integer naming a row of
`GET /api/v1/stickers`, makes the send a sticker message. A sticker send has no
text and no attachments (`content` empty or absent, `attachments` empty), and
`client_message_id` is required, because the message and its sticker row commit
in one transaction with the receipt, as a poll's rows do. Any of those broken is
`BAD_REQUEST`, as is a `sticker_id` that is not a positive integer. A sticker
that does not exist, or was deleted after the sender last loaded the set, is
refused with `STICKER_NOT_FOUND` (it refines `NOT_FOUND`) and nothing is stored;
the client refreshes its picker from `sticker_update`. Every other gate is the
ordinary send's: `SEND_MESSAGES`, the channel, DM, thread and forum checks,
slow mode and the rate limit all apply, and `reply_to` and `reply_ping` work.
The stored `content` is the fallback `[Sticker: <name>]`, so search, push text
and clients that do not know the field still read something. A sticker message
cannot be edited or forwarded (`BAD_REQUEST`); it can be deleted, replied to
and reacted to like any message. The server advertises the `stickers`
capability in `ready`; an older server ignores `sticker_id` and would store an
empty send as `BAD_REQUEST`, so a client sends it only when the capability is set.

`reply_ping` is optional and defaults to `false`: a send that omits it does
not ping, so a client from before the field existed keeps its old behaviour.
When it is `true`, `reply_to` is set and the replied-to author is not the
sender, the author's id is added to the message's `mentions`, so the highlight,
`mention_count`, `channel_activity.mentions_you` and push candidates all follow
as for an `@username`. The same rules apply as for an `@username`: a parent
author who blocked the sender, or who cannot read the channel, is listed in
`mentions` but gets no badge or push. Without `reply_to`, or when replying to
your own message, `reply_ping` is ignored. A non-boolean value is a bad
payload (`BAD_REQUEST`). The ping is stored with the message and kept when the
message is edited; deleting the message takes back the badge it raised. An
edit never raises a badge. Older servers ignore the field.

In a two-person DM `chat_send` is also refused with `FORBIDDEN` when the other
participant cannot be reached by the sender (see _Refusing a 1:1 interaction_
under DM Authorization), before anything is stored.

`chat_send` also accepts optional `client_message_id`: exactly
`<13-digit Unix milliseconds>:<lowercase UUID v4>` (50 characters), generated
once for the logical message and kept unchanged across transport retries.
The envelope `id` remains a fresh correlation id for each request. Omission
preserves older clients' existing send behavior without deduplication.

The embedded time must be less than 24 hours old and no more than five minutes
ahead of the server clock (or equal to a later advertised restore floor).
Expired or malformed ids return `BAD_REQUEST`;
clients must keep the timestamp unchanged and retain expired text for copying
or discarding rather than silently minting another id for an uncertain send.

The first accepted request binds `(sender, client_message_id)` transactionally
to its channel, raw content, reply target, `reply_ping` and ordered attachment ids. A repeat
of the same request returns the original message id and timestamp, with the
current envelope `id`, optional echoed `client_message_id`, and
`deduplicated: true`. New sends omit `deduplicated` (equivalent to false).
The `chat_message` broadcast also echoes `client_message_id` when supplied;
history does not carry it, so clients also reconcile by acknowledged server
message id when history was restored before acknowledgment.

Retries still pass the general chat rate limit. A matching receipt is
answered before the channel, send-permission, DM membership/block/timeout and
content checks: the message was accepted when it was sent, so a later
permission change cannot turn its acknowledgment into a refusal. A key with no
receipt is a new send and passes every check. A matching receipt does not
spend slow-mode cooldown, reopen DMs, increment mentions, dispatch push
notifications or broadcast another message. Changed payloads or channels with the same key
return `CONFLICT`. Keys belong to their sender, so another authorized sender
may independently use the same key without seeing the first sender's result.
Receipts survive message deletion: a deleted original, including one removed
with its channel, returns `ALREADY_DELETED` and is never recreated. A key with
no receipt for a missing channel returns `NOT_FOUND`. A malformed, expired or
pre-restore key with no receipt returns `BAD_REQUEST` before any permission
check.

Message content, mentions, attachment ownership links and the receipt commit
together. Receipts contain only ids, a request fingerprint, the original
timestamp and expiry, and are removed on sender erasure or expiry maintenance.
Expired logical ids are refused even after their receipts have been pruned.
This guarantees one persisted message per accepted key during its retry
window, not delivery of every post-commit notification across a process crash;
normal history/reconnect synchronization recovers the committed message.
Deduplication survives ordinary process restarts. Before the admin backup
restore overwrites the closed database, the server durably advances a monotonic
retry floor outside that database. The floor includes the permitted five-minute
clock skew. A receipt-missing id older than that floor returns `BAD_REQUEST`
with an instruction to review the draft; an existing matching receipt remains
acknowledgeable. `ready.capabilities.message_retry_floor_ms` advertises the
floor (0 before any restore). New logical ids use `max(Date.now(), floor)`,
while recovered pending ids remain unchanged. Sidecar read/write failures
fail closed. This protects the supported admin restore path; replacing database
and sidecar files manually can discard this history, so such recovery requires
deliberate review of pending drafts. The client never automatically retries
recovered drafts.

### chat_send_ok (Server -> Client)

Direct response to sender (no seq):

```json
{
  "type": "chat_send_ok",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "message_id": 1042,
    "timestamp": "2026-03-14T10:30:00Z",
    "client_message_id": "1773484200000:3f2b8a52-6d1c-4a0e-9f4b-0c7d5e1a2b34",
    "skipped_attachment_ids": ["9f1c0b6e-2d4a-4c1b-8e53-7a1f0d9c4b21"]
  }
}
```

`client_message_id` is echoed when the send carried one, and `deduplicated:
true` marks an ack answered from a receipt (a retry). Both are omitted
otherwise.

`skipped_attachment_ids` is optional and present only when the send named
uploads it did not attach, listed in request order without repeats. The message
was stored and broadcast without those files. An id lands here when it was
swept as an unlinked upload, belongs to another user, is already attached to a
message, is a live avatar or group icon, or does not exist; the server gives no reason per
id, and the list only ever contains ids the sender sent. A deduplicated ack
carries the same list as the original ack, derived from the message's stored
attachments. When every requested id is skipped and the send has no text, no
message is stored and the server answers with the `ATTACHMENTS_UNAVAILABLE`
error instead (see Error Codes). Clients that do not know the field ignore it.

### chat_forward (Client -> Server)

Copy one message into one channel or DM (WP 6.9a). The sender must be able to
read the source and post in the target:

```json
{
  "type": "chat_forward",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "payload": {
    "client_message_id": "1773484200000:3f2b8a52-6d1c-4a0e-9f4b-0c7d5e1a2b35",
    "channel_id": 9,
    "message_id": 1042
  }
}
```

`channel_id` is the target and `message_id` the message to forward; both must be
positive integers. `client_message_id` is **required**, with the same shape and
24-hour retry window as `chat_send`. One frame is one target: a client that
forwards to several targets sends one frame per target, one after another, each
with its own `client_message_id`, so each forward commits whole or not at all.
Resending the same frame (same `client_message_id`, same `message_id` and
`channel_id`) after a lost acknowledgement is answered from the receipt before
any gate runs: one message, no second copy of the files. The same id with
another source or target is `CONFLICT`.

The result is an ordinary message (`kind` 0) **by the sender** in the target,
sent as a sequenced `chat_message` exactly as a `chat_send` would be, with the
`forward` block described under `chat_message`. Its `content` is a snapshot of
the source's text and its `attachments` are the sender's own copies of the
source's files, so later edits or deletes of the original change nothing and
clients that do not know `forward` draw a plain message. Because it is a message
of the sender, it can be replied to, reacted to, pinned and deleted; it cannot
be edited (`FORBIDDEN`). The optional text a user types with a forward is sent
by the client as a separate `chat_send` after the acknowledgement.

A forward never pings: `mentions` is `[]`, `mentions_everyone` and
`mentions_here` are false, no mention row or badge is written, and a channel
target sends no push. A DM target behaves as a DM message does, including push
and the first-contact rule: a one-to-one DM whose recipient has not accepted
the sender stages a message request instead of delivering.

The server checks, in this order, and a refusal stores nothing:

1. **Source readable.** The message must exist, be an ordinary (`kind` 0) live
   message, and be in a channel or DM the sender can read, including the NSFW
   acknowledgement. Every refusal here is `NOT_FOUND`, the answer for an unknown
   id, so nothing is learned about a message the sender cannot read.
2. **Target postable.** The same rule as `chat_send`: `NOT_FOUND` for an unknown
   channel; `FORBIDDEN` without READ_MESSAGES and SEND_MESSAGES (and
   MANAGE_MESSAGES in an announcement channel), in an archived channel, in a DM
   the sender is not in, or in a one-to-one DM where either side has blocked the
   other; `TIMED_OUT` under a moderator timeout.
3. **ATTACH_FILES** in a channel target when the source has files.
4. **NSFW.** A source in a labelled channel can be forwarded only to another
   labelled channel, never to a DM or an unlabelled channel (`FORBIDDEN`).

Then `RATE_LIMITED` applies (see Rate limits: 5 per 10 seconds per user, after
the receipt check so retries are free), slow mode is charged in the target as
for a send, and the files are cloned. The clones are charged to the sender's
storage quota at their full size, even where a hard link uses no extra disk; a
full quota or a full disk is `FORBIDDEN` with the reason in `message`. A file
whose bytes are already gone is skipped, and a source with no text whose files
are all gone is `ATTACHMENTS_UNAVAILABLE`. Read access to the source channel is
checked again just before the transaction that stores the forward, and the
source row is read again inside it, so a source deleted (or whose channel was
made unreadable) in the meantime is refused with `NOT_FOUND`, nothing is stored
and the quota is released.

### poll_create (Client -> Server)

Post a poll as a message (WP 6.9b). Creating is sending: the sender needs the same
permissions in the channel as for `chat_send`, slow mode is charged, and a DM obeys
its blocks, timeouts and message requests.

```json
{
  "type": "poll_create",
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "payload": {
    "client_message_id": "1773484200000:3f2b8a52-6d1c-4a0e-9f4b-0c7d5e1a2b35",
    "channel_id": 9,
    "question": "Lunch?",
    "answers": [{ "text": "Pizza" }, { "text": "Sushi", "emoji": "🍣" }],
    "duration_hours": 24,
    "allow_multiselect": false
  }
}
```

`client_message_id` is required, as for `chat_forward`: a retry after a lost
acknowledgement is answered from the receipt and never posts a second poll. Reusing
an id for another poll is a `CONFLICT`. Every text is sanitised first and then
bounded in characters: the question 1 to 300, 2 to 10 answers of 1 to 55 each. A
field that is empty after sanitising, or holds a control character (a newline
included), is refused with `BAD_REQUEST`. Duplicate answer text is allowed. `emoji`
is optional and is a Unicode emoji or a `:shortcode:`, as for a reaction.
`duration_hours` is one of 1, 4, 8, 24, 72 or 168. `allow_multiselect` defaults to
false. Answer ids are 1 to n in input order.

Beyond the send rate limit (10 per second), a user may create 5 polls per 10 minutes
(`RATE_LIMITED`). A retry answered from a receipt is not charged.

The poll is an ordinary message (`kind` 0) whose `content` is a readable fallback
that has no words of any language: `📊 <question>`, then one line `- [<emoji> ]<answer>`
per answer. A client that does not know polls shows that text, and search finds the
poll by it. The sequenced `chat_message` carries the `poll` block described under
`chat_message`, with `mentions: []` whatever the text holds: a poll never pings and
sends no channel push. A poll cannot be edited or forwarded.

### poll_create_ok (Server -> Client)

Direct response to the sender (no seq):

```json
{
  "type": "poll_create_ok",
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "payload": {
    "message_id": 1104,
    "channel_id": 9,
    "client_message_id": "1773484200000:3f2b8a52-6d1c-4a0e-9f4b-0c7d5e1a2b35",
    "deduplicated": false
  }
}
```

`deduplicated: true` marks an acknowledgement answered from a receipt (a retry);
nothing was stored or broadcast for it.

### poll_vote (Client -> Server)

Set the sender's whole selection on a poll (WP 6.9b). The payload is the new
selection, not a delta, so the command is idempotent and needs no
`client_message_id`:

```json
{
  "type": "poll_vote",
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "payload": { "message_id": 1104, "answer_ids": [2] }
}
```

`answer_ids` is required. `[]` removes the sender's vote. The ids must be distinct
answers of the poll, and at most one on a single-choice poll; otherwise the answer
is `BAD_REQUEST` and nothing is written. A vote replaces the sender's earlier
selection. A retry of the selection the sender already holds is acknowledged with
the current version and nothing is broadcast, which covers a lost acknowledgement.

Voting is reacting: the sender must be able to read the message, and a message
that is missing, deleted, not a poll or in a channel the sender cannot read all
answer `NOT_FOUND`, so voting leaks nothing. Then the reaction gates apply
unchanged: `ADD_REACTIONS`, not timed out, the channel not archived, and for a DM
membership and no block. A member who cannot send in an announcement channel can
still vote there. A poll that was ended, or whose `expires_at` has passed (by the
server clock, whether or not the expiry timer has run), refuses the vote with
`POLL_ENDED`. A vote racing the end is either counted, and then in the final
counts, or refused; never both. Votes and ends share one budget of 10 per 10
seconds per user (`RATE_LIMITED`).

### poll_vote_ok (Server -> Client)

Direct response to the sender (no seq):

```json
{
  "type": "poll_vote_ok",
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "payload": { "message_id": 1104, "version": 3, "answer_ids": [2] }
}
```

`version` is the poll's version after the vote (the current one for a no-op retry)
and `answer_ids` the sender's stored selection, sorted.

### poll_end (Client -> Server)

End a poll now:

```json
{
  "type": "poll_end",
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "payload": { "message_id": 1104 }
}
```

Ending follows the delete rule. The sender must be able to read the message
(`NOT_FOUND` otherwise), the channel must not be archived, and the sender must be
allowed to delete the message: its author, or a member with `MANAGE_MESSAGES` in
the channel. A timed-out author can still end their own poll. In a DM only the
author may end it. Anything else is `FORBIDDEN`. A poll that already ended gives
`POLL_ENDED`. Ending removes nothing, so it writes no audit row.

### poll_end_ok (Server -> Client)

Direct response to the sender (no seq): `{ "message_id": 1104 }`. Every reader,
the sender included, learns the final counts from the sequenced `poll_update`.

### poll_update (Server -> Client)

Sequenced and replayable like `reaction_update`, to the channel's subscribers or a
DM's participants, and withheld from a member who has not acknowledged a labelled
(NSFW) channel:

```json
{
  "type": "poll_update",
  "seq": 1042,
  "payload": {
    "channel_id": 9,
    "message_id": 1104,
    "version": 3,
    "total_voters": 5,
    "counts": [
      { "answer_id": 1, "count": 2 },
      { "answer_id": 2, "count": 3 }
    ],
    "ended": false,
    "ended_at": null,
    "user_id": 17,
    "answer_ids": [2]
  }
}
```

Counts are absolute, never deltas, and every answer is listed. `user_id` and
`answer_ids` are present only on a vote and name the voter and their new set
(`[]` for a removal), which is how the voter's other devices learn their own
selection. An end has neither, and carries `ended: true` and `ended_at`. It is sent
when a poll is ended by `poll_end` and when the expiry timer ends one (including
polls that expired while the server was down, which are announced before the server
accepts connections).

**The version rule.** `version` is per poll and rises by one on every vote change
and on the end. Frames can reach a client out of order, because two commits are
emitted by different handlers, so a client keeps the highest version it has seen
for a poll and drops a frame below it. A frame with a higher version is a complete
state, so no earlier frame is needed. A client also keeps a second watermark for
its own selection: `me` changes only from a frame whose `user_id` is the viewer's
and whose version is above the last such version. The `results.version` and `me`
of a history read are both watermarks too, so a replayed `chat_message` (version 0) or an older history page never moves a poll back. A `poll_update` for a message
the client has not loaded is dropped; loading it later brings fresh state.

### chat_forward_ok (Server -> Client)

Direct response to the sender (no seq):

```json
{
  "type": "chat_forward_ok",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "payload": {
    "message_id": 1103,
    "channel_id": 9,
    "client_message_id": "1773484200000:3f2b8a52-6d1c-4a0e-9f4b-0c7d5e1a2b35",
    "deduplicated": false
  }
}
```

`message_id` is the new message in `channel_id` (the target). `deduplicated:
true` marks an acknowledgement answered from a receipt (a retry); nothing was
stored or broadcast for it.

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
      "role": "admin",
      "display_name": "Alex A."
    },
    "content": "Hello everyone!",
    "reply_to": null,
    "referenced_message": null,
    "timestamp": "2026-03-14T10:30:00Z",
    "attachments": [],
    "reactions": [],
    "pinned": false,
    "mentions": [7, 9],
    "mentions_everyone": true,
    "mentions_here": false
  }
}
```

`user.display_name` is the author's nickname to render instead of `username`;
present only when the author has one, omitted otherwise (see `member_join`).

A call log row in a DM is a `chat_message` with two more payload fields, both
omitted for an ordinary message: `kind` (`"call"`, the closed set
`chat_message.kind` in `protocol/schema.json`) and `call`, `{started_at,
ended_at, participants}`. `started_at` and `ended_at` use the same layout as
`timestamp` of the surface they ride on (`ended_at` is `null` while the call is
live), and `participants` is the list of user IDs who were in the call at any
point. `content` is fallback text that only clients that do not know `kind`
show. `chat_send` ignores any `kind` or `call` a client sends: only the server
writes a call row, and nobody can edit, delete, pin, react to or reply to one.
The same fields ride on each message in `GET /channels/{id}/messages`
(`before`, `after` and `around`). Every member of the DM sees `participants`,
including members who join a group DM later, the same audience that sees the
channel's `voice_state` and its history. Clients treat an unknown `kind` as an
ordinary message.

A forwarded message (WP 6.9a, `chat_forward`) is an ordinary message with one
more payload field, `forward`, omitted for every other message:
`{"source_channel_id": 5, "source_message_id": 1042, "source_timestamp":
"2026-03-14T10:30:00Z"}`. `source_message_id` is the original message, or `null`
when the original is deleted or purged, so a client shows the jump link only when
it is set and it knows the channel. The block carries no author and no channel
name. It is static, so it replays unchanged, and it rides on each message in
`GET /channels/{id}/messages`. For a forward of a forward the block names the
original, not the intermediate forward. A forward cannot be edited. Readers of the
target see the text and files the sender chose to share even when they cannot read
the source; the ids in the block are only numbers, and jumping to the source is
permission-checked as any jump is.

A poll message (WP 6.9b, `poll_create`) is an ordinary message with one more
payload field, `poll`, omitted for every other message and for a deleted one:

```json
"poll": {
  "question": "Lunch?",
  "answers": [{ "answer_id": 1, "text": "Pizza", "emoji": null }, { "answer_id": 2, "text": "Sushi", "emoji": "🍣" }],
  "allow_multiselect": false,
  "expires_at": "2026-10-22T12:00:00Z",
  "ended": false,
  "ended_at": null,
  "results": { "version": 0, "total_voters": 0, "counts": [{ "answer_id": 1, "count": 0 }, { "answer_id": 2, "count": 0 }], "me": [] }
}
```

`results` are computed when the frame is built and never stored. The live frame is
shared by every reader and is sent at creation, so `counts` are zero and `me` is
`[]`. History fills the block per reader: `me` is the reader's own answer ids, and
`ended` is true when `ended_at` is set or `expires_at` has passed, so a read is
correct before anything marks the poll ended. `results.version` counts vote changes
and the end, so a client that holds a higher version must not replace it with a
lower one, such as a replayed creation frame. The block is the same shape on every
message of `GET /channels/{id}/messages`. Votes, the end and expiry change the
block only through `poll_update`, and the server advertises the `polls` capability
in `ready`.

A sticker message (WP 8.8a, `chat_send` with `sticker_id`) is an ordinary message
with one more payload field, `sticker`, omitted for every other message and for a
deleted one: `{"id": 3, "name": "Wave", "url": "/api/v1/stickers/3/image"}`.
`content` is the fallback `[Sticker: Wave]`. `name` is the label kept from send
time, so it survives a rename or delete of the sticker. When the sticker has been
deleted, `id` and `url` are `null` and only `name` is left: a client shows a
"deleted sticker" placeholder. The live frame always carries the id and url, the
block is static, and it rides on each message in `GET /channels/{id}/messages`
and on each search hit, where a deleted sticker already reads `null`.

A group DM can also hold group event rows (WP 3B-10): `kind` is one of
`group_add`, `group_remove`, `group_leave`, `group_rename` and `group_icon`, and
the payload gains `group_event`, present only for these kinds. `group_event` is
`{"target_user_id": 12}` for add and remove, `{}` for leave, `{"name": "Raid
night"}` for rename (`""` means the name was removed) and `{"icon_removed":
false}` for icon. A group row is read-only like a call row, and `chat_send`
ignores any `kind` or `group_event` a client sends. The same block rides on each
message in `GET /channels/{id}/messages`.

The server writes a group row, with an English fallback sentence in `content` for
clients that do not know the kind (`Alice added Bob to the group.`), in these
cases. Every row is a sequenced `chat_message` from the REST request that caused
it, sent to the members after the change, so it is replayed on reconnect:

- `group_add` — one per user added by `POST /dms/{id}/members`. The author is the
  adder, `group_event.target_user_id` the added user.
- `group_remove` — the owner removed a member (`DELETE /dms/{id}/members/{userId}`).
  The removed member does not receive it.
- `group_leave` — a member left (`DELETE /dms/{id}`). The last leaver writes none.
- `group_rename` — a changed name (`PATCH /dms/{id}`). An unchanged name writes none.
- `group_icon` — the icon was set (`POST /dms/{id}/icon`, `group_event.icon_removed`
  `false`) or removed (`DELETE /dms/{id}/icon`, `true`). Removing an icon the group
  does not have writes none. The row carries no icon URL: the icon is in the
  summary, and a replaced icon stops being served.

Within one change the refreshed `dm_channel_open` is sent to every member before
the row, so a newly added user hears of the DM first. An owner transfer
(`PUT /dms/{id}/owner`) sends the refreshed `dm_channel_open` only and writes no
row. A group row raises the unread count for everyone except its author, carries
no mention and sends no push.

A pin writes a pin row (WP 6.12): `kind` is `pin_add`, the author is the pinner
and `reply_to` is the id of the pinned message, with `referenced_message` null on
the live frame (history fills it in, redacted to `{id, deleted: true}` once the
target is soft-deleted, and `reply_to` becomes null when the target is purged).
`content` is the English fallback `Alice pinned a message to this channel.`. The
row is written in the same transaction as the pin, only when the message was not
already pinned and no live pin row for it was written in the last 10 minutes, so
pin, unpin and pin again writes one row. Unpinning writes none. It is a sequenced
`chat_message` to the channel's readers or the DM's delivery audience, as any DM
frame (a one-to-one DM whose request is still pending reaches only the pinner), replayed on
reconnect; it raises the unread count for everyone but the pinner (the pinner's read state advances to the row and their mention count resets, as for call and group rows), carries no
mention and sends no push. Unlike a call or group row, its author or a moderator
(MANAGE_MESSAGES in a channel, the author only in a DM) may delete it, as an
ordinary message. It cannot be edited, replied to, reacted to or pinned.

A welcome row (WP 8.6) greets a new member in the channel the admin picked with the
`welcome_channel_id` setting: `kind` is `member_join`, the author is the new member,
`reply_to` is null and `content` is the English fallback `alice joined the server.`
that only clients that do not know `kind` show; a current client draws its own
greeting line. The server writes it once the account is usable, that is after a
`register` in invite or open mode and when an admin approves an application in approval
mode, and only while that setting names an existing, non-archived text channel; it
writes nothing otherwise, and a failure to write or deliver it never fails the
registration or approval. It is a sequenced `chat_message` to the channel's readers
with a `channel_activity` note for readers elsewhere, replayed on reconnect, raising
the unread count for everyone but the new member (whose read state advances to the
row), carrying no mention and sending no push. Its author or a moderator
(MANAGE_MESSAGES) may delete it, as an ordinary message. It cannot be edited, reacted to
or pinned, but unlike the other system rows a member may reply to it: the client's
wave button sends an ordinary `chat_send` of `👋` with `reply_to` set to the row.

The server writes one call row per DM call, from voice presence. The row is
created when the first person joins the DM's voice channel (its author is the
first joiner), and it is sent as an ordinary sequenced `chat_message` to the DM's
audience, so it is replayed on reconnect like chat. If a recipient had closed
the DM, a `dm_channel_open` for them comes first, as for a ring. A one-to-one
call is logged once both sides have accepted the DM (see `dm_request`); a call in a DM that
has not been accepted writes no row and sends no frame. A group DM has no such condition. The call ends 10 seconds after the
last person leaves, so a quick rejoin is the same call, and `ended_at` is the
time of the last leave. The end is sent as a `chat_edited` with the row's
`message_id` and `channel_id`, the fallback `content` for the finished call
(for example `started a call that lasted 5 minutes.`), `kind`, the final `call`
block (with `ended_at` set and the complete `participants` list), empty
`mentions`, and **`edited_at: null`**. Clients replace the row's `call` and do
not show an edited marker for `kind: "call"`; a client that does not know `kind`
shows the new `content` without one, because `edited_at` is null. Joining or
leaving mid-call sends no frame. If the server stops during a call, the call is
ended at the last time anyone was seen in it when the server next starts, and
that end is sent like any other. Calls that continue across a restart are not
carried over: people who rejoin start a new row.

| Field                | Type           | Description                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mentions`           | number[]       | User IDs the server resolved from `@username` and `<@id>` tokens, plus the replied-to author when `reply_ping` was set. Always present; empty when nothing resolved.                                                                                                                                                                  |
| `mention_roles`      | number[]       | Role IDs the server resolved from `<@&id>` tokens that cleared the role-mention gate (the role is `mentionable`, or the author holds `READ_MESSAGES` and `MENTION_EVERYONE` on the channel). Always present; empty when nothing resolved. A client counts a role mention only when the role is listed here. An older server omits it. |
| `mentions_everyone`  | bool           | `true` when the message carried `@everyone` or `@here` **and** the author holds `MENTION_EVERYONE` on that channel.                                                                                                                                                                                                                   |
| `mentions_here`      | bool           | `true` when `mentions_everyone` came from `@here` rather than `@everyone` (never both).                                                                                                                                                                                                                                               |
| `referenced_message` | object or null | Snippet of the `reply_to` parent, so a reply to a message outside the loaded window still shows who and what. See below.                                                                                                                                                                                                              |

`referenced_message` is `{id, user: {id, username, avatar}, content, deleted,
has_attachments}`, computed when the frame is built (never stored). `content`
is the parent's text cut to 100 runes (markdown, not rendered). It is `null`
when the message is not a reply, or the parent is gone or lives in another
channel (the server never follows a `reply_to` across channels). A soft-deleted
parent is redacted to `{id, user: null, content: "", deleted: true,
has_attachments: false}`. An older server omits the field; clients fall back to
the loaded message, then to "unknown message". `GET /channels/{id}/messages`
(history, `around`) and the pins list carry the same field per message. The
snippet is live-only: the copy kept for replay (ring buffer and the `events`
table) carries `referenced_message: null`, so a client resuming after
the parent was deleted never receives its text and falls back to the unknown
parent bar. A client that holds a snippet redacts it (`deleted: true`, no
`user`, no `content`) on `chat_deleted` and `chat_bulk_deleted` when the
deleted message is the parent.

Mentions are resolved server-side at send time against existing usernames
(case-insensitive, whole-word, capped at 20 per message, plus the replied-to
author when the reply pinged, who never counts against the cap). The content may
also carry `<@123>` (a user by id) and `<@&5>` (a role by id) tokens; the server
stores them as typed. A user id that names no reachable user is ignored. User
and role tokens share the cap of 20 and at most 60 distinct tokens are looked
at. An `@word` that matches no username, an unknown id, a `<@&id>` for a role
that is not `mentionable` from an author without `MENTION_EVERYONE`, and an
`@everyone`/`@here` from an author without `MENTION_EVERYONE`, resolve to
nothing and stay plain text — clients must highlight from these fields rather
than re-parsing the content. DMs never carry `mentions_everyone` or
`mention_roles`; a `<@&id>` in a DM stays text.

Every holder of a role in `mention_roles` gets the same badge, `channel_activity`
`mentions_you` flag and push candidacy as a direct `mentions` hit (the author and
anyone who blocked the author are skipped, and the holder must be able to read
the channel). The holders are expanded once at send and are not listed in
`mentions`. An edit re-resolves `mention_roles` but never raises a badge.

`@everyone` and `@here` both raise `mention_count` for every reader except
`@here` skips a reader with no live connection when the badge is written (the
server's mention worker treats that reader as unreachable, the same way a push
notification would; the write lands a fraction of a second after the send). A client cannot tell the two tokens apart from
`mentions_everyone` alone, which is why `mentions_here` exists: a reconnecting
client that replays this frame from the gap it was disconnected for must not
raise a mention badge for a here-only mention the server never counted — there
is no `ready` in that reconnect tier to correct a wrong badge afterward. A
direct `mentions` hit is unaffected either way.

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
    "mention_roles": [],
    "mentions_everyone": false,
    "mentions_here": false
  }
}
```

`mentions`/`mention_roles`/`mentions_everyone`/`mentions_here` are re-resolved from the edited
content and replace the stored set, except a reply-ping target, which an
edit keeps. Editing never raises anyone's
`mention_count`: a badge is only ever raised by the original send, so
re-adding an already-counted mention cannot double-count it.

The end of a DM call log row is also a `chat_edited`, with `edited_at: null`,
the row's `kind` (`"call"`) and its final `call` block (see `chat_message`). It
is not an edit by anyone: a client replaces `content` and `call` and does not
show an edited marker.

### chat_delete (Client -> Server)

Deleting another member's message needs the channel's `can_delete_others`
verdict (see `channels[]` under `ready`); deleting your own does not. A DM
has no `can_delete_others`: a participant deletes only their own messages.

```json
{
  "type": "chat_delete",
  "id": "req-uuid",
  "payload": {
    "message_id": 1042
  }
}
```

The author can delete their own message with `READ_MESSAGES` alone: losing
`SEND_MESSAGES` on the channel does not stop them removing what they wrote, and
neither does a timeout. A denied `READ_MESSAGES` does. Moderators with
`MANAGE_MESSAGES` can delete others' messages (non-DM channels only).

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

### chat_pinned (Server -> Client, broadcast)

Emitted by the REST pin/unpin handlers
(`POST`/`DELETE /api/v1/channels/{id}/pins/{messageId}`, gated on
`READ_MESSAGES|MANAGE_MESSAGES`, or DM participant) to every reader of the
channel, so other clients and the pinner's own other devices do not show stale
pins. Sequenced and replayable like `chat_edited`; `pinned` is the new state.
Whether the caller may send the pin is the channel's `can_pin` verdict (see
`channels[]` under `ready`). A DM has no `can_pin`; there any participant who
is not blocked and not timed out may pin.

```json
{
  "seq": 46,
  "type": "chat_pinned",
  "payload": {
    "message_id": 1042,
    "channel_id": 5,
    "pinned": true
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
The caller must also be able to read the channel, including any age-restriction
acknowledgement. A message that does not exist, is deleted, or is in a channel
the caller cannot read is answered `NOT_FOUND` with the same message in every
case.

A message holds at most **20 different emoji**. A `reaction_add` with a new
emoji on a message that already has 20 is refused with `REACTION_LIMIT` and no
`reaction_update` is sent. Adding to an emoji already on the message, and
removing, still work, so a message that already held more than 20 keeps them.
The cap applies in DMs too.

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

```json
{
  "type": "presence_update",
  "payload": {
    "status": "dnd",
    "custom_status": "in a meeting",
    "custom_status_expires_in": 3600
  }
}
```

Valid `status` values: `"online"`, `"idle"`, `"dnd"`, `"invisible"`.
`"offline"` is still accepted from older clients (which used it to mean
"appear offline") and is treated as the plain offline it says. Rate limited:
1 per 10 seconds.

`custom_status` is optional and max 128 characters, HTML-sanitized and trimmed
server-side, and checked as single-line text (no line breaks, control or
invisible characters). **Omitting the field leaves the stored text alone**; sending `""`
clears it. The distinction matters because a client's auto-idle timer sends a
bare status flip several times an hour and must not blank the text the user
typed. While the user is timed out a non-empty `custom_status` is refused with
`TIMED_OUT`; a bare status change and `""` still apply.

`custom_status_expires_in` is optional: whole seconds, **60 to 604800** (one
minute to seven days), after which the server clears the custom status by
itself. A relative duration, so a client's clock skew does not matter; "clear
today" is the seconds to local midnight. It is valid only with a non-empty
`custom_status`: sent without one, with `""`, as a string or a fraction, or out
of range, the frame is refused with `BAD_REQUEST`. A new `custom_status`
without it has no expiry and replaces any old one; a bare status flip leaves
both text and expiry alone; `""` clears both. The user's own `auth_ok.user` and
`GET /api/v1/users/me` return the resulting `custom_status_expires_at`; it is
never sent to other users. Idle, DnD and Invisible timers are not part of this:
they stay on the client. An older server ignores the field, so the status just
never expires there.

The chosen status is stored as chosen, `invisible` included, and persists
across reconnects (see `auth_ok`). A custom status persists too, and is
cleared on `POST /api/v1/auth/logout`.

### activity_update (Client -> Server)

Reports the game the user is playing, or that they stopped. It has its own
frame and its own budget, so it never competes with `presence_update` (the
client's auto-idle timer spends that budget) and writes nothing to the
database.

```json
{
  "type": "activity_update",
  "payload": { "activity": { "name": "Factorio", "started_at": 1761206400000 } }
}
```

```json
{ "type": "activity_update", "payload": { "activity": null } }
```

`activity` is required: an object with a string `name` and an integer
`started_at` (unix milliseconds), or `null` to clear. A missing field, a field
of another JSON type or a non-integer `started_at` is refused with
`BAD_REQUEST`.

- `name` is trimmed, then follows the `custom_status` text rules (single line,
  no control or invisible characters, runs of spaces collapse), 1 to 128
  characters. Too long or bad text is `BAD_REQUEST`. A name that is empty after
  trimming clears the activity, like `null`.
- `started_at` is clamped to the last 24 hours: never later than now, never
  earlier than now minus 24 h.
- While the user is timed out a set is refused with `TIMED_OUT`, like a
  non-empty `custom_status`; a clear still applies.
- While an admin has game activity switched off for the server (WP 8.3e-2) a
  set is refused with `GAME_ACTIVITY_DISABLED`, before the rate limit, so the
  refusal spends no budget; a clear still applies (with nothing set it does
  nothing). The client takes the refusal quietly and asks again on its next
  poll, so its game shows once the switch is back on; a refusal never overrides
  the policy the server last stated (it can arrive after a newer `true`). Turning the switch
  off clears every shown game on the server: every connected client gets a
  `presence` frame with `activity: null` about each affected visible user (an
  invisible user's goes to that user's own connection only), and `presence`
  frames sent afterwards carry no game.
- Setting an activity is limited to 1 per 10 seconds per user, on its own
  budget; over it the frame is refused with `RATE_LIMITED` and the client
  retries on its next poll. A clear is never limited.
- Naming the game the connection already shows (whatever its `started_at`), or
  clearing when nothing is set, does nothing: no frame is sent, no budget is
  spent and no reply is sent. The shown `started_at` is kept, so a client sends
  `null` when a game exits and a relaunch starts a new timer.
- A change is broadcast as a `presence` frame with the user's live status and
  custom status plus the new `activity`. While the user is invisible only their
  own connection gets that frame; nobody else is sent anything.
- The activity belongs to the connection and has no table of its own (the
  `presence` frames that carry it are logged like any other). A device that
  connects again replaces the previous connection and starts with no activity
  until it sends one; a late `activity_update` from the replaced connection is
  ignored. Disconnecting, or a server restart, clears it.

The capability is `game_activity`.

### listening_update (Client -> Server)

Reports the song the user is listening to, or that it stopped (WP 8.10a). Same
shape of rules as `activity_update`, with its own frame and its own budget so a
song change never eats the game's or `presence_update`'s. It writes nothing to
the database.

```json
{
  "type": "listening_update",
  "payload": {
    "listening": {
      "title": "Song",
      "artist": "Band",
      "player": "Spotify",
      "started_at": 1761206400000,
      "duration_ms": 215000
    }
  }
}
```

```json
{ "type": "listening_update", "payload": { "listening": null } }
```

`listening` is required: an object with string `title`, `artist` and `player`
and integer `started_at` and `duration_ms`, or `null` to clear. A missing
field, a field of another JSON type or a non-integer number is refused with
`BAD_REQUEST`.

- `title`, `artist` and `player` are trimmed, then follow the `custom_status`
  text rules (single line, no control or invisible characters, runs of spaces
  collapse). `title` is 1 to 128 characters and `artist` 0 to 128 (it may be
  empty); `player` (the app that plays it) is 1 to 64, and an empty `player` is
  `BAD_REQUEST`. A `title` that is empty after trimming clears the listening,
  like `null`.
- `started_at` is the unix milliseconds the song would have started at (now
  minus the position) and is clamped like a game's: never later than now,
  never earlier than now minus 24 h.
- `duration_ms` is the song's length: `0` means unknown, a negative value is
  `BAD_REQUEST`, and anything over 24 h is capped at 24 h.
- While the user is timed out a set is refused with `TIMED_OUT`; a clear still
  applies.
- The per-server switch covers music too: while an admin has member activity
  switched off a set is refused with `GAME_ACTIVITY_DISABLED`, before the rate
  limit, and a clear still applies. Turning the switch off clears every shown
  song together with every shown game, in the same `presence` frame per user
  (see `activity_update` for who receives it).
- Setting a song is limited to 1 per 10 seconds per user, on its own budget;
  over it the frame is refused with `RATE_LIMITED`, and the client keeps its
  latest song and sends it on its next poll. A clear is never limited.
- Naming the song the connection already shows (same `title`, `artist` and
  `player`, whatever its `started_at` or `duration_ms`), or clearing when
  nothing is set, does nothing: no frame, no budget, no reply. The shown
  `started_at` is kept, so a seek does not rebroadcast.
- A change is broadcast as a `presence` frame with the user's live status,
  custom status and game plus the new `listening`; a game change likewise
  keeps the song. While the user is invisible only their own connection gets
  that frame.
- The song belongs to the connection and has no table of its own. A device
  that connects again replaces the previous connection and starts with no song
  until it sends one; a late `listening_update` from the replaced connection
  is ignored, and its disconnect does not clear the new connection's.
  Disconnecting, or a server restart, clears it.

The capability is `listening_activity`.

### presence (Server -> Client, broadcast)

```json
{
  "seq": 50,
  "type": "presence",
  "payload": {
    "user_id": 1,
    "status": "online",
    "custom_status": "shipping phase 6",
    "activity": { "name": "Factorio", "started_at": 1761206400000 },
    "listening": null
  }
}
```

`listening` (WP 8.10a) is the song the user is listening to (see
`listening_update`): `{title, artist, player, started_at, duration_ms}`, always
present (`null` when none), with the same rules as `activity`: every presence
frame carries the current value, invisible users show `null` to everyone else
and the truth to themselves, and it is `null` while member activity is switched
off. A server without the `listening_activity` capability omits the key.

`activity` is the game the user is playing (see `activity_update`), always
present (`null` when none), like `custom_status`. Every presence frame carries
the current value, so a status change, a custom status expiry or an idle flip
keeps showing the game. For an invisible user, everyone else gets `activity:
null` (the same rule that blanks `custom_status`) and only the user's own copy
carries the game; an `activity_update` while invisible reaches only the user,
and going back online shows it again. While game activity is switched off for the server the value is always
`null`. A server without the
`game_activity` capability omits the key.

`custom_status` is always present (`null` when unset), so "cleared it" is
distinguishable from "this event does not mention it"; every presence
broadcast carries the current value. When a custom status expires the server
broadcasts a `presence` for the user with `custom_status: null` and the same
`status` (split for an invisible user like any other presence), exactly as if
they had cleared it; clients need no timer for other users' statuses.

**Invisible splits this message in two.** When a user's status is
`"invisible"`, everyone else receives a broadcast that says `"offline"`, and
the user themselves receives a separate, targeted `presence` carrying their
true `"invisible"`. A client must therefore not assume it sees the same
presence value for a user that everyone else does — and must not "correct" its
own status back to online on the strength of a broadcast it did not receive.

`presence` now carries only a user's own status changes (`presence_update`).
Coming online and going offline arrive in `presence_batch`. A client older
than this release ignores `presence_batch`, so it shows stale connect and
disconnect presence until it updates.

### presence_batch (Server -> Client, broadcast)

Connect and disconnect presence is coalesced for 300 ms and sent as one frame
listing every user whose presence changed in that window, so a reconnect herd
of N users costs each client a handful of frames instead of N.

```json
{
  "seq": 51,
  "type": "presence_batch",
  "payload": {
    "updates": [
      {
        "user_id": 1,
        "status": "online",
        "custom_status": "shipping phase 6",
        "activity": { "name": "Factorio", "started_at": 1761206400000 },
        "listening": null
      },
      {
        "user_id": 4,
        "status": "offline",
        "custom_status": null,
        "activity": null,
        "listening": null
      }
    ]
  }
}
```

Each entry means what a `presence` with the same fields means: `custom_status`,
`activity` and `listening` (WP 8.10a) are always present (`null` when unset), and an invisible user is
`"offline"` with `custom_status: null`, `activity: null` and `listening: null` for everyone but themselves — the invisible user's
own copy of the same frame (same `seq`) carries their true status. An entry
for a user the client does not know is ignored: a member the recipient's list
may not have yet arrives first as a `member_join` (see `member_join`).

**Full snapshot.** A client whose send buffer was full when a presence frame
arrived has that frame dropped (not the connection) and receives, within the
next window, an unsequenced `presence_batch` with `"full": true`. It lists
every connected user who is not offline to that client (its own true status
and custom text included, even when invisible), each with their current
`custom_status`, `activity` and `listening` (always present, `null` when unset); every member it leaves
out is offline, so an invisible member is simply absent. Clear an offline
member's custom text, which is what `ready` shows.

---

## Channel Focus and Read State

### channel_focus (Client -> Server)

```json
{ "type": "channel_focus", "payload": { "channel_id": 5 } }
{ "type": "channel_focus", "payload": { "channel_id": 5, "read": false } }
```

Tells the server which channel the user is currently viewing. Affects broadcast delivery and unread tracking: by default it advances the caller's read state to the channel's latest message and resets that channel's `mention_count` to 0.

`read` is an optional boolean and is `true` when absent, so older clients behave as before. With `"read": false` the frame focuses and subscribes only: it writes no read state and sends no `read_state` frame, and a pending `channel_activity` hint for the channel is still delivered. A deferred focus (see the rate limits) keeps its `read` flag. `read: false` is meant for a client that places the NEW line by the read pointer and marks read itself (see `mark_read`); a server without the `read_pointer` capability ignores the field.

### mark_read (Client -> Server)

```json
{ "type": "mark_read", "payload": { "channel_id": 5 } }
{ "type": "mark_read", "payload": { "channel_id": 5, "message_id": 812 } }
```

Without `message_id`, advances the caller's read state for `channel_id` to that
channel's latest message and resets its `mention_count` to 0 — exactly what
`channel_focus` does to unread state — **without** changing which channel the
connection is focused on. This is what backs "Mark as Read" in the channel
context menu and "Mark All as Read": marking a channel the user is _not_ looking
at must not rebind the connection's focused channel, which would misroute unread
bookkeeping for the channel actually on screen.

With `message_id`, reads the channel up to that message. The move is
**forward only**: a `message_id` at or below the current pointer changes
nothing (a late mark from a device that was displaced cannot undo newer
progress), and an id past the channel's newest message is clamped to it. The id
need not name an existing message. When the pointer moves, `mention_count`
becomes the lower of its current value and the number of live mentions after the
new pointer; when it does not move, `mention_count` is unchanged. A
`message_id` that is not a positive integer answers `BAD_REQUEST`.

Same access check as `channel_focus`: `READ_MESSAGES` on the channel, or DM
participation. A denied channel answers `FORBIDDEN`; a non-positive
`channel_id` answers `BAD_REQUEST`. Every accepted `mark_read`, including one
that changes nothing, is answered with a `read_state` frame to the caller. Over
its 5/sec budget a frame is dropped silently.

### mark_unread (Client -> Server)

```json
{ "type": "mark_unread", "payload": { "channel_id": 5, "message_id": 790 } }
```

Moves the caller's read pointer to the message just before `message_id`, so that
message and every later one are unread again (the pointer is `0` when it is the
channel's first message). It may move the pointer either way. `message_id` is
required and must be a positive integer (`BAD_REQUEST` otherwise) naming a live
message of `channel_id`, otherwise the answer is `NOT_FOUND` and nothing
changes. The same access check as `channel_focus` applies (`FORBIDDEN`).

`mention_count` is recomputed from the mentions that raised the badge: a
backward move raises it to the number of live mentions after the new pointer
unless it is already higher, and a forward move lowers it to that number unless
it is already lower. Mentions that reached the user before the server began
recording them (see `docs/schema.md`, `mention_receipts`) are not restored.

`mark_unread` has its own 5/sec budget and, unlike `mark_read`, answers
`RATE_LIMITED` over it. On success the caller gets a `read_state` frame.

### read_state (Server -> Client, direct)

```json
{
  "type": "read_state",
  "payload": {
    "channel_id": 5,
    "last_read_message_id": 789,
    "unread_count": 23,
    "mention_count": 1
  }
}
```

The caller's read pointer in `channel_id` after a `mark_read` or `mark_unread`
was accepted. It replaces the client's pointer, `unread_count` (capped at 100,
like the one in `ready`) and `mention_count` for that channel or DM outright,
including the one on screen. Sent after every accepted `mark_read` and
`mark_unread`, even a no-op, and never after `channel_focus`. A rejected command
sends no frame.

Sent to every live connection of the caller, unsequenced and never replayed;
it shares the queue of `mention_count`, and each is written and sent under one
lock, so a reader's last frame carries the latest committed state. A client that
resumes keeps its own pointer, and the next full `ready` is the truth. A frame
that reaches a connection just before its `ready` can be overwritten by an
older snapshot; the next `ready` corrects it.

### mention_count (Server -> Client, direct)

```json
{ "type": "mention_count", "payload": { "channel_id": 5, "count": 3 } }
```

Tells one reader that their `read_states.mention_count` in `channel_id` changed,
carrying the new total. `count` is the reader's total after the change (the
server pushes the total, not a delta), so a lost or duplicated frame still
converges.

This is the live path for the sidebar and taskbar/tray unread badge when a
mention lands in a channel the reader is **not** viewing: `chat_message` is
published only to the channel's topic subscribers (the focused channel), so an
unfocused reader never receives it. After the mention worker's batched write
commits, it pushes one `mention_count` frame per reader whose read-state guard
actually admitted the bump — a reader who had already read the message, or whose
message was removed before the flush, is not pushed. Deleting or purging a
mentioning message pushes the same frame with the reader's lowered total, so a
badge the event raised is also cleared live — but only to a reader who can still
see the channel; a reader whose access was revoked (removed override, role
change, left the DM) is skipped, and the stored total is still corrected.

Every write and the frame it pushes are one critical section, so a reader
receives frames in the order the server changed its total: an increment flush
coalesced on the mention worker and a deletion's decrement cannot invert, so a
reader's last frame always carries the latest committed total. Targeted,
unsequenced and never replayed; a disconnected reader recovers the
authoritative total on their next `ready`.

The client ignores the frame for the channel currently on screen (its own
`chat_message` handles that badge, counting a mention that lands while the
window is unfocused too) and for a DM-channel id (a DM's badge lives in the DM
store and its mention bump rides the DM's `chat_message`).

---

### channel_activity (Server -> Client, targeted)

```json
{
  "type": "channel_activity",
  "payload": {
    "channels": [
      {
        "channel_id": 5,
        "message_id": 812,
        "author_id": 3,
        "mentions_you": false,
        "mentions_everyone": false
      }
    ]
  }
}
```

An unread hint for a channel the reader can read but is **not** viewing:
`chat_message` is published only to the channel's topic subscribers, so an
unfocused reader would otherwise learn of a new message only on the next
`ready`. Each entry names a channel and a message that arrived there since the
last frame; the client calls its channel-unread path with `message_id` (and
never counts the flags as a mention, since `mention_count` owns the badge
total).

The server batches. A hub coalescer records each committed send and flushes on a
leading-edge 1 s window: the first message after a quiet second is sent at once,
later ones wait for the window to close. A flush resolves each changed channel's
audience once and sends every recipient **one** frame listing all the channels
that changed for them, so a connection gets about one frame per second however
many channels are busy.

For a **thread** id (WP 6.9c) the audience is narrowed to the thread's followers
who can read its parent, so an entry never reaches a user who does not follow
the thread. A forum post is the exception: its entry goes to the forum's whole
audience, as before (WP 6.9d). A client that finds a thread id here for a thread it does not follow
can ignore it. A role mention (`mention_roles`) in a thread raises the holders' mention badge but
sends a hint only to those who follow the thread, and does not make them follow it.

- **Audience.** Connected users who may view the channel (the same
  `CanViewChannel` verdict as `ready`), for `text`, `announcement` and `voice` channels
  only (the channels `ready` gives an `unread_count`). Not sent to the channel's
  topic subscribers (they get `chat_message`), to the author of the window's
  latest message, or for DMs (their participants get the sequenced
  `chat_message` whatever they have focused). Edits, deletes, pins and
  reactions produce no frame.
- **Entries.** Per recipient and channel, at most two, in ascending
  `message_id`: the latest message that mentioned the recipient (when there is
  one), then the latest message overall when its id is higher. `mentions_you`
  is true when the entry's message named the recipient with `@user`;
  `mentions_everyone` when it pinged them with `@everyone`, or with `@here`
  while their status shows them present. The two are separate because a client
  may mute broad mentions without muting direct ones. A message from an author the
  recipient has blocked, or the recipient's own message, sets neither flag.
  A window keeps at most 16 mentioning messages per channel; `mention_count`
  still raises the badge for any beyond that.
- **NSFW.** A reader who has not acknowledged an NSFW-labelled channel gets the
  entry **without `author_id`**, with `channel_id`, `message_id` and both flags
  intact. `ready` already gives them the unread count and last message id.
- **Delivery.** Unsequenced (no `seq`), on the low-priority queue, never stored
  or replayed. A hint is not sent for a message the recipient already marked
  read or opened. A full queue drops it silently and never forces a full `ready`.
  A frame is not recalled once sent; pending state naming an erased user or a
  swept message is dropped before the flush.

`ready` and `mention_count` stay authoritative: a missed or dropped frame costs
nothing, and a server that predates the frame simply never sends one.

---

## Threads

A thread is a discussion started on one message of a text channel. It is a channel row of type `thread` under that channel (its parent) and has no permission state of its own: who can see it, read it and post in it is answered by the parent's roles and overrides, plus the thread's `locked` flag. `ready` and `channel_create` never carry thread rows. A client learns a thread from the `thread` field on its starter message (history, `chat_message`), from `thread_changed`, from `thread_create_ok`, and from the list route.

### ThreadInfo

```json
{
  "id": 91,
  "parent_id": 5,
  "name": "Release plan",
  "owner_id": 12,
  "starter_message_id": 4410,
  "archived": false,
  "locked": false,
  "auto_archive_minutes": 1440,
  "message_count": 7,
  "last_message_at": "2026-10-21T09:30:00Z",
  "created_at": "2026-10-20T08:00:00Z"
}
```

A forum post's `ThreadInfo` also carries `post`: `{ "tag_ids": [3, 7], "first_message": { "id": 5120, "author_id": 12, "preview": "...", "deleted": false, "has_attachments": false } }`. It is absent on a thread of a text channel. `first_message` is `null` after the opening message is hard-deleted; a soft-deleted one reads `deleted: true` with an empty preview. See [Forum posts](#forum-posts).

`owner_id` and `starter_message_id` are `null` once the user or message is erased. `last_message_at` is `null` for a thread with no replies. `message_count` counts user messages. History rows and `chat_message` carry `thread` only on the starter message. A live `chat_message` for a message that has just been sent never has it; the thread arrives as `thread_create_ok` and `thread_changed`.

### thread_create (Client -> Server)

```json
{
  "type": "thread_create",
  "id": "req-uuid",
  "payload": {
    "channel_id": 5,
    "message_id": 4410,
    "name": "Release plan",
    "auto_archive_minutes": 1440
  }
}
```

`name` is 1 to 100 runes after sanitising. `auto_archive_minutes` is one of 60, 1440, 4320 or 10080; omitted or 0 means 1440. The caller needs `READ_MESSAGES` and `SEND_MESSAGES` in the parent, which must be a text channel. The starter must be a live user message in that channel that has no thread. A message has at most one thread, and that makes the create idempotent without a request key: a retry by the thread's owner (a lost `thread_create_ok`) is answered with the same `thread_create_ok`, before the rate gate and without announcing anything. Rate limited to 5 per 10 minutes per user (`RATE_LIMITED`).

Errors: `THREAD_EXISTS` (the message already has a thread that the caller did not make; the error payload carries `thread_id`, so the loser of a race learns the winner), `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`, `RATE_LIMITED`.

### thread_create_ok (Server -> Client, direct)

`{ "thread": ThreadInfo }`, with the request `id`. Sockets that have the parent channel focused (subscribed to its topic) hear `thread_changed`; others learn the thread from the list route or the starter message when they open the channel.

### thread_update (Client -> Server)

`{ "thread_id": 91, "name"?: string, "archived"?: bool, "locked"?: bool, "auto_archive_minutes"?: int, "tag_ids"?: int[] }`; an absent field is unchanged. `tag_ids` replaces a forum post's tags (at most 5, all tags of that forum, at least one when the forum requires a tag) and is `BAD_REQUEST` on any other thread; the owner or a user with `MANAGE_MESSAGES` may set it. The thread's owner may rename, archive, unarchive and change the idle period. Only a user with `MANAGE_MESSAGES` may set `locked`. A locked thread belongs to moderators: the owner's change is `THREAD_LOCKED`. Answered with `thread_update_ok` (`{ "thread_id": 91 }`); the new state reaches everyone as `thread_changed`.

### thread_delete (Client -> Server)

`{ "thread_id": 91 }`. Moderators (`MANAGE_MESSAGES`) only. The thread and its messages are removed, an audit row is written, and the starter message may start a new thread.

### thread_focus (Client -> Server)

`{ "thread_id": 91 }`, or `null` to close. A second focus slot beside `channel_focus`: the thread open beside the focused channel. It subscribes the socket to the thread's frames (ordinary `chat_message`, `chat_edited`, reactions and so on, sequenced on the thread) and, like `channel_focus`, marks the thread read. The caller needs `READ_MESSAGES` in the **parent**. `channel_focus` still refuses a thread id. `mark_read` and `mark_unread` accept one, with the same parent check, and focus nothing, so the open thread panel and a sidebar row can move the thread's read pointer. The slot is revalidated after the subscribe, and is dropped silently when the parent's overrides, a role change, a timeout or the thread's deletion take the right away. It is not carried across a reconnect: re-send `thread_focus` after `ready`. Over its own budget of 5 per second it answers `RATE_LIMITED`.

### thread_follow (Client -> Server)

`{ "thread_id": 91, "follow": true }`. Follows (`true`) or unfollows (`false`) a thread for the caller; both are idempotent. The thread must be visible to the caller (the parent's `READ_MESSAGES`, the gate `thread_focus` uses), otherwise `NOT_FOUND`; a locked or archived thread can still be followed or unfollowed. Answered with `thread_follow_ok`, then a `thread_follow_update` to the caller's socket. Over its own budget of 5 per second it answers `RATE_LIMITED`. The capability is `thread_follows`. A thread whose parent is NSFW-labelled needs the member's acknowledgement first: without it `thread_follow` answers `FORBIDDEN` with `NSFW_ACKNOWLEDGEMENT_REQUIRED` and writes nothing.

A user also follows a thread without asking: by **creating** it, by **posting** in it (including a forward or a poll), and by being **directly mentioned** in a post there (`@name` or a reply ping, never `@everyone` or `@here`). Unfollowing removes the follow and posting again follows again. A follow is a preference, never permission: it grants nothing and limits nothing, and every use of it is checked against what the parent channel lets the user see.

### thread_follow_ok (Server -> Client, direct)

`{ "thread_id": 91, "following": true }`, with the request `id`. `following` is the state the follow was left in.

### thread_follow_update (Server -> Client, targeted)

`{ "thread_id": 91, "following": true, "thread"?: ThreadInfo }`. One user's follow of a thread, sent only to that user's socket. Unsequenced, on the low queue like `mention_count`, not replayed: a missed frame costs nothing, because `ready.threads` is authoritative. `thread` is the thread's current state and is present when `following` is `true`. Sent when

- the user is newly made a follower by a post (their own, or a direct mention in someone else's);
- the user follows or unfollows with `thread_follow`;
- a followed thread changes (rename, archive, lock, a new message), carrying the same `ThreadInfo` as `thread_changed`: this is how a sidebar row stays current for a user who does not have the parent focused. Only users who can still read the parent receive it;
- the thread is deleted: `following` is `false` and there is no `thread`.

A client applies the last frame it received for a thread. Two devices racing a follow and an unfollow each get a frame carrying the state that device's write left, and the next `ready` corrects any difference.

### thread_changed (Server -> Client, broadcast)

`{ "thread": ThreadInfo }` with the thread's absolute state, sequenced on the **parent** channel, so it reaches the sockets subscribed to the parent's topic (those with it focused) and is replayed to them on reconnect; it is not broadcast to every viewer of the channel list. Sent for a create, an update, a post to the thread (count and activity) and an automatic archive. The server sends at most one per thread per 2 seconds: the first change goes out at once, and later changes in the window fold into one trailing frame. Its name may disclose content, so a channel marked NSFW is withheld until acknowledged.

### thread_deleted (Server -> Client, broadcast)

`{ "channel_id": 5, "thread_id": 91 }`, sequenced on the parent. A socket that had the thread open also receives an unsequenced copy, because it need not be subscribed to the parent. A client ignores a `thread_changed` for a thread id it has already seen deleted: a change read just before the delete may be sequenced after it.

### Forum posts

A forum holds no messages. A post is a thread whose parent is the forum, with no starter message; its first message is the opening message, which `channels.thread_post_message_id` points at. Sockets that did not declare the [`forums` feature](#client-features) are sent nothing about a forum's posts: no `thread_changed` for a post, and `channel_focus` / `thread_focus` on a post (or its forum) is refused before the subscription. A socket that loses the feature to a role refresh stops receiving them, because the feature set is read again at send time.

#### forum_post_create (Client -> Server)

```json
{
  "type": "forum_post_create",
  "id": "req-uuid",
  "payload": {
    "client_message_id": "1760000000000:6f1c0c5e-0000-4000-8000-000000000000",
    "channel_id": 9,
    "name": "Dark mode",
    "content": "Please add a dark theme.",
    "attachments": [],
    "tag_ids": [3]
  }
}
```

`channel_id` is the forum. `name` is the title, 1 to 100 runes after sanitising. `content` and `attachments` follow the `chat_send` rules and the opening message needs one of them. `tag_ids` holds at most 5 distinct tags of the forum, and at least one when the forum has `require_tag`. The caller needs `READ_MESSAGES` and `SEND_MESSAGES` in the forum (and `ATTACH_FILES` with attachments), is subject to the forum's slow mode, and shares the `thread_create` budget (5 per 10 minutes, `RATE_LIMITED`). The post's `auto_archive_minutes` is the forum's default. The post and its opening message commit in one transaction.

The request is idempotent on `client_message_id`, as `chat_send` is: a retry of a post that committed is answered with the same `forum_post_create_ok` and `deduplicated: true`, before the `thread_create` budget is spent and even if the post has since been archived. A retry of a post that has since been deleted answers `ALREADY_DELETED`; a retry whose payload differs from the original answers `CONFLICT`. A retry from a caller who can no longer see the forum is acknowledged without the `thread` field. A malformed request (title, tag shape) is refused before it costs a token.

Errors: `BAD_REQUEST` (title, tags, empty message, a channel that is not a forum), `NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `SLOW_MODE`, `ALREADY_DELETED`, `CONFLICT`.

#### forum_post_create_ok (Server -> Client, direct)

`{ "thread": ThreadInfo, "message_id": 5120, "client_message_id": "...", "deduplicated": false, "skipped_attachment_ids"?: string[] }`, with the request `id`. `skipped_attachment_ids` lists requested uploads that were not attached, as in `chat_send_ok`, and is absent when every one was. `thread` is absent on a deduplicated acknowledgement to a caller who can no longer see the forum. The new post reaches other sockets that have the forum focused as `thread_changed`, and the opening message reaches sockets with the post open (`thread_focus`) as an ordinary `chat_message`. Editing or deleting the opening message sends `thread_changed` for the post (its preview).

### Idle archive

An open thread is archived when `auto_archive_minutes` pass with no message. A post to an archived thread reopens it in the same transaction; a locked thread stays archived until a moderator reopens it.

### Thread list

`GET /api/v1/channels/{id}/threads` (see the REST reference) lists a channel's threads, gated by the parent's `READ_MESSAGES`.

---

## Channel Updates

Channel messages are triggered by REST API calls from admins and reach only the clients that may view the channel (`channel_delete` excepted).

### channel_create (Server -> Client, targeted)

```json
{
  "type": "channel_create",
  "payload": {
    "id": 8,
    "name": "gaming",
    "type": "text",
    "category": "Hangout",
    "category_id": 2,
    "category_position": 1,
    "topic": "",
    "position": 3,
    "slow_mode": 0,
    "nsfw": false,
    "afk": false,
    "private": false,
    "voice_max_users": 0,
    "voice_max_video": 0,
    "can_send": true,
    "can_moderate_voice": false,
    "can_move_voice": false,
    "can_delete_others": false,
    "can_pin": false,
    "can_react": true
  }
}
```

Every `channel_create` is addressed to one client and carries that viewer's own
`can_send`, `can_moderate_voice`, `can_move_voice`, `can_delete_others`, `can_pin` and `can_react`
— the same values `ready` ships per channel.
It has no `seq` and is not replayed: a client that misses one is forced onto a
full `ready` on resume instead. It is sent in three cases:

- **Channel creation.** Every connected client that may view the new channel
  gets its own copy, so a new channel arrives with its verdicts already set.
- **Visibility refresh.** When a role or channel-override edit changes who may
  see or post, `RefreshChannelVisibility` sends each still-visible client its
  own copy, so the composer affordance converges without a reconnect. A role
  edit or a role- or user-override edit on the channel converges the
  voice-moderation, delete-others, pin and reaction controls the same way.
- **Timeout refresh.** When a moderator times a member out or lifts the
  timeout, or the timeout expires, that member alone gets a fresh copy of
  every channel they can see, so their `can_send` and `can_react` follow the
  timeout without a reconnect.

Older servers sent `channel_create` as one shared broadcast without these fields.
**Treat an absent `can_send`, `can_moderate_voice`, `can_move_voice`, `can_delete_others`, `can_pin` or `can_react` as "unchanged", never as `false`.**

### channel_update (Server -> Client, broadcast)

Full channel object — the same payload shape as `channel_create`, built by the
same constructor so the two events can never disagree about which fields a
client is told about. Sent on every admin `PATCH`, so a client applies channel
edits (rename, topic, category move, slow mode, `nsfw`, voice limits) without
reconnecting.

**Category fields (WP 6.5a).** Every channel object (`ready.channels[]`,
`channel_create`, `channel_update`) carries three category fields, identical for
every recipient so the shared `channel_update` frame stays shared: `category`
(the category's name, `""` when none; kept for older clients), `category_id`
(the category's id, `0` when none) and `category_position` (the category's
position in the category order, `0` when none). A client groups channels by
`category_id`. Renaming, reordering or deleting a category changes these
fields on every channel in the touched categories, so the server re-sends a
`channel_update` for each of them (to the clients that may read that channel,
as for any channel edit) and then a `channel_categories` frame to managers. A
deleted category leaves its channels in place with `category_id` `0`.
`category_position` can have gaps (a hidden or empty category still holds a
position), so clients only sort by it and never treat it as an index.

`nsfw` is shipped so clients can gate or label a channel, and **the server now
enforces it** (migration `047`, B5-7): a member with no acknowledgement row
for a labelled channel gets no content from it — no message history, around
window, pins, reaction users, reacting (`reaction_add`/`reaction_remove` answer
`NOT_FOUND`), search hits, or live/replayed `chat_message` /
`chat_edited` / `reaction_update` — and no attachment bytes from it either,
regardless of client. `channel_create`/`channel_update` themselves still reach
every viewer including the one that just turned the label on, since those
frames carry no message content; `nsfw_acknowledged` is per-viewer and ships
only in `ready` (above), not in this broadcast, the same reason `can_send` is
omitted from it. None of the per-viewer fields (`can_send`,
`can_moderate_voice`, `can_move_voice`, `can_delete_others`, `can_pin`, `can_react`) ship here:
this is one encoded frame for every recipient, and a single value would be
wrong for some of them. See `PUT`/`DELETE
/api/v1/channels/{id}/nsfw-acknowledgement` (`docs/api.md`) for how a client
records or revokes consent, and the `nsfw_ack` frame below for the second-
device signal. The desktop client's own gating UI (blur, consent prompt) is
B9's; an account with no standing acknowledgement simply never satisfies the
server-side gate and receives no content to render, on any device or client
that ignores this UI — the row is per-user, not per-session or per-device, so
a second device or a client that skips the gating UI inherits whatever the
account has already acknowledged rather than bypassing consent.

`private` follows the channel's override for the default role: an override edit
re-sends it on the `channel_create` that `RefreshChannelVisibility` addresses
to each still-visible client, and on the next `channel_update`.

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

### nsfw_ack (Server -> Client, direct)

B5-7. Sent to the caller's OWN other live sockets after `PUT` or `DELETE
/api/v1/channels/{id}/nsfw-acknowledgement` (`docs/api.md`), so a second
device converges without a reconnect.

```json
{
  "type": "nsfw_ack",
  "payload": { "channel_id": 8, "acknowledged": true }
}
```

| Field          | Type    | Description                                         |
| -------------- | ------- | --------------------------------------------------- |
| `channel_id`   | integer | The channel the caller just acknowledged or revoked |
| `acknowledged` | boolean | `true` after `PUT`, `false` after `DELETE`          |

**Unsequenced and NOT replayed**, like `dm_channel_open`/`dm_request`: a
client that misses one (a dropped connection during the request) recovers on
its next `ready`, whose per-channel `nsfw_acknowledged` field is the
persisted source of truth — there is nothing here a resync needs to recover
that `ready` does not already carry.

---

## Member Updates

All member messages are broadcast to all connected clients.

### member_join (Server -> Client, broadcast)

Sent when a ban is lifted (an admin unban or an overturned ban appeal) so
clients re-add the row `member_ban` removed. Coming online is presence, not a
join: every client's `ready` already lists every member, so a connect sends no
`member_join`. It is still sent, just ahead of the `presence_batch` (or the
`presence`) carrying their status, for a member other clients cannot have
yet: a first-ever connect (repeated on the next connect if that first
handshake failed before the announcement, or if it comes within about 2
seconds, before the first connect's status write), or the return of a user
whose temporary ban lapsed. Unlike presence, `member_join` is never dropped for a
full send buffer. Clients that watched `member_join` to learn someone came
online must read presence instead. On an unban, `status` is `"offline"`
unless the user holds a live connection (a lapsed temporary ban lets them
reconnect before the unban).

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
      "role_ids": [4],
      "display_name": "New User",
      "about": "Hello there",
      "created_at": "2026-10-15T13:04:05Z",
      "banner": "/api/v1/files/7a1e...",
      "banner_color": "#5865f2",
      "identity_public_key": "base64-identity-pubkey"
    },
    "status": "online"
  }
}
```

`role_ids` lists every role the user holds, top role first, like
`ready.members[]`; `role` is the top role's name. `display_name` is the nickname to render instead of `username`; omitted when
unset. `about` is the About Me bio (`null` when unset) and `created_at` the
account creation instant (RFC 3339 UTC); both match the same fields of
`ready.members[]`, and neither appears on `chat_message.user`. `banner` and
`banner_color` are the profile banner, omitted when unset like in
`ready.members[]`.
`identity_public_key` is the user's long-term E2EE identity public key
(see voice E2EE TOFU); omitted when the user has not published one. The
top-level `status` is the viewer-safe presence the user comes online as (an
invisible connector reports `"offline"` here) — clients must render presence
from this field rather than assuming `"online"` because a `member_join`
arrived.

### member_update (Server -> Client, broadcast)

Triggered when a user's roles change: an admin replaces, adds or removes a role, a role is renamed or deleted, or a role reorder moves a role the user holds. A reorder sends one frame to every member who holds a moved role together with another role, not only to those whose top role changed.

```json
{
  "seq": 71,
  "type": "member_update",
  "payload": {
    "user_id": 5,
    "role": "moderator",
    "role_ids": [3, 4]
  }
}
```

`role` is the name of the member's top role (highest `position`, lowest id on a
tie) and `role_ids` every role they hold. `role_ids[0]` is the top role; order
the rest by `roles[].position`, because a roster cached before a reorder may
keep an older order for the tail. `role_ids` is absent when
the server could not read the holder list for this frame and on an older
server; keep the member's previous roles then.

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
      {
        "id": 1,
        "name": "Owner",
        "color": "#E74C3C",
        "permissions": 2147483647,
        "position": 100,
        "is_default": false,
        "hoist": true,
        "mentionable": false
      },
      {
        "id": 4,
        "name": "Member",
        "color": null,
        "permissions": 1635,
        "position": 40,
        "is_default": true,
        "hoist": true,
        "mentionable": false
      }
    ]
  }
}
```

Unfiltered on purpose — the same list already ships in every client's `ready`
payload, so it discloses nothing new. A role permission change that alters
channel visibility is delivered separately, as targeted
`channel_create`/`channel_delete` messages, and a role deletion additionally
sends one `member_update` per reassigned member.

### sticker_update (Server -> Client, broadcast)

Sent to every connected client after a custom sticker is uploaded, renamed or
deleted through `/api/v1/stickers`. Like `emoji_update` it carries the **whole**
set, so a client replaces its list wholesale and a dropped event can never leave
a deleted sticker in a picker.

```json
{
  "seq": 75,
  "type": "sticker_update",
  "payload": {
    "stickers": [
      { "id": 3, "name": "Wave", "emoji": "👋", "url": "/api/v1/stickers/3/image" },
      { "id": 7, "name": "Party Blob", "emoji": null, "url": "/api/v1/stickers/7/image" }
    ]
  }
}
```

`stickers` is always an array, `[]` when the last sticker was deleted, ordered by
name ignoring case. `emoji` is the optional related emoji (a single emoji or a
`:shortcode:`) the picker searches by, `null` for none. `url` is a server-relative
path that requires the session token (see api.md). Unfiltered, for the same
reason `emoji_update` is, and, like the emoji, **not** in the `ready` payload:
clients load the set once over `GET /api/v1/stickers` and keep it fresh from this
event.

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

### upload_policy (Server -> Client, broadcast)

Sent to every connected client after the owner saves either upload file-type
list in the admin panel (`PATCH /admin/api/settings` with
`upload_blocked_extensions` or `upload_allowed_extensions`). It carries both
lists in force, so a composer's pre-upload check follows the save without a
reconnect; auth_ok carries the same lists from then on.

```json
{
  "type": "upload_policy",
  "payload": {
    "blocked_extensions": [],
    "allowed_extensions": []
  }
}
```

Both fields are always arrays, `[]` when emptied, and replace the lists
auth_ok gave; `max_upload_bytes` and `thumbnails` keep their auth_ok values.
Two empty lists allow every extension, though the content blocks still refuse
executables. Unfiltered: the lists are already in every client's auth_ok.

Unsequenced and never replayed: auth_ok carries the current lists on every
connect and resume, so a replayed older frame could only overwrite them. A
client whose send queue is full is disconnected instead, and its next auth_ok
carries the current lists.

### game_activity_policy (Server -> Client, broadcast)

Sent to every connected client after an admin with `MANAGE_SERVER` saves the
`game_activity_enabled` setting in the admin panel (`PATCH
/admin/api/settings`). The setting is `true` while no row exists.

```json
{
  "type": "game_activity_policy",
  "payload": { "enabled": false }
}
```

`enabled` is whether member activity is shown on this server: games
(`activity_update`) and, since WP 8.10a, music (`listening_update`); the admin
panel calls the setting "Member activity (games and music)". Turning it off
clears the server's state first (every connection's shown game and song, see
`activity_update`) and then sends this frame; turning it on sends only the
frame, and the games return as clients send them again. The clearing `presence`
frames ride the sequenced broadcast queue and this frame is sent directly, so
their wire order against each other is not guaranteed: a client treats `false`
as clearing every game itself and ignores a game that arrives on `presence`
afterwards. A client that sees `false` sends no `activity_update` and
shows no game; on `true` it sends its current game at once.

Unfiltered, unsequenced and never replayed, like
[`upload_policy`](#upload_policy-server---client-broadcast): `auth_ok` carries
the same value as `game_activity_policy` on every connect and resume, so a
replayed older frame could only overwrite a newer one. A client whose send
queue is full is disconnected instead, and its next `auth_ok` carries the
current value. For operators: if the setting cannot be read at server start the
switch starts off (the server logs `game_activity_policy_unreadable`); saving
it again in the admin panel recovers. A client that connects at the moment of the switch may keep
asking once per poll; the server refuses each set with
`GAME_ACTIVITY_DISABLED`, so nothing is shown.

### user_update (Server -> Client, broadcast)

Broadcast when a user changes their own profile via `PATCH /api/v1/users/me`,
`POST /api/v1/users/me/avatar`, `DELETE /api/v1/users/me/avatar`,
`POST /api/v1/users/me/banner` or `DELETE /api/v1/users/me/banner` (username,
avatar, display name, about, banner and/or identity key).

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
    "banner": "/api/v1/files/7a1e...",
    "banner_color": "#5865f2",
    "identity_public_key": "base64-identity-pubkey"
  }
}
```

The payload is a full snapshot, not a delta: it **replaces** the client's copy
of that user's profile. `avatar`, `display_name`, `about`, `banner` and
`banner_color` are always present and may be `null` (unset/cleared) — a profile edit that removes a field has to
be distinguishable from one that leaves it alone.
`identity_public_key` carries the user's current long-term E2EE identity key
and is omitted when none is published; peers that pinned a different key must
surface a TOFU mismatch.

---

## Moderation Queue

### mod_queue (Server -> Client)

B5-8: a change in the report queue — a report filed, assigned or closed —
delivered ONLY to connected holders of the `MODERATE_MEMBERS` permission bit
(or `ADMINISTRATOR`). The reporter and the subject never receive this frame,
even if one of them separately holds the bit (report confidentiality). It is
unsequenced and never replayed: a moderator who was offline when a report
changed gets the current queue from `GET /api/v1/moderation/queue`, not from
reconnect replay.

```json
{
  "type": "mod_queue",
  "payload": {
    "report_id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9",
    "state": "assigned"
  }
}
```

The payload carries only the report's opaque public id and its new state —
never the reporter's identity, never the reported content, never the
subject, and never the sequential internal id (a bit holder who could
correlate `report_id` values in order could otherwise infer a report's
position relative to reports they cannot see). `state` is one of `open`,
`assigned`, `resolved`, `dismissed`.

**B5-10 reuses this same wire type for an appeal-queue change** (a
submission, assignment or decision), carrying `appeal_id` instead of
`report_id` — one wire type, two optional ids, exactly one of which is ever
set on a given frame:

```json
{
  "type": "mod_queue",
  "payload": {
    "appeal_id": "1a2b3c4d5e6f7081920a1b2c3d4e5f60",
    "state": "overturned"
  }
}
```

Like the report variant, this frame is filtered against one principal: the
appellant. A moderator who filed the appeal being changed never receives
this frame about their OWN appeal, even though they can see its state
through `GET /api/v1/appeals/mine` — the same confidentiality rule
`mod_queue`'s report variant applies to the reporter and subject. The
ACTING moderator on the appealed action is deliberately NOT excluded: they
may already see the appeal through the queue and detail views, so there is
no oracle to protect against for them. `state` here is one of `open`,
`assigned`, `upheld`, `overturned`, `withdrawn` — a withdrawal broadcasts
this frame too, so a connected moderator's queue view drops the row
immediately rather than only on their next `GET`.

---

## Moderator Actions

### mod_action (Server -> Client)

B5-9: a warning issued, a timeout applied, or a timeout lifted, delivered
ONLY to the live target — targeted and unsequenced, never replayed. A
disconnected target simply sees the warning in `ready`'s `notices` on next
connect; every own warning, timeout, removal and lapsed or reversed ban,
with its ledger id, is readable over REST at `GET /api/v1/users/me/moderation` (see
[api.md](api.md)).

```json
{
  "type": "mod_action",
  "payload": {
    "id": 42,
    "kind": "timeout",
    "reason": "at most 500 runes, no control characters",
    "expires_at": "2026-09-06T12:00:00Z"
  }
}
```

`kind` is `warning` or `timeout`. `expires_at` is `null` for a warning and
for a lifted timeout; present for an active timeout.

### member_timeouts (Server -> Client)

WP 3C-7c: the active-timeout list changed. A timeout was issued, lifted or ran out, or the viewer's role changed so that they now (or no longer) hold `MODERATE_MEMBERS`/`ADMINISTRATOR`. Targeted and unsequenced, never replayed. It **replaces the viewer's list wholesale**, the way `roles_update` and `emoji_update` do: drop what you hold and keep exactly these entries.

```json
{
  "type": "member_timeouts",
  "payload": {
    "timeouts": [{ "user_id": 5, "expires_at": "2026-10-15T13:00:00Z" }]
  }
}
```

Audience: every connected moderator (`MODERATE_MEMBERS` or `ADMINISTRATOR`) receives the full list; a timed-out member receives only their own entry (or `[]` once it ends). Anyone else normally receives nothing, but after a role change or a reconnect a non-moderator may receive a redundant frame holding only their own entry (often `[]`); apply it like any other. When a viewer stops being a moderator they receive one last frame holding only their own entry. A frame can arrive straight after `ready` when a role change lands while the connection is being set up; apply it over the `ready` list like any other. `ready.member_timeouts` carries the same view on every connect, and a resume that missed a change takes a full `ready`, so a client that was offline never needs the frame. An entry is active while now is before `expires_at`; a client should also drop it locally at that moment. The list names no actor and no reason. An Administrator target is exempt from the timeout's effect, but the sanction still exists, so the list shows it. The server does not consult this view: enforcement stays in the send predicates.

### channel_categories (Server -> Client)

WP 6.5a: the channel category list changed (a category was created, renamed, reordered or deleted). Targeted and unsequenced, never replayed. It **replaces the manager's list wholesale**, the way `roles_update` does: drop what you hold and keep exactly these entries.

```json
{
  "type": "channel_categories",
  "payload": {
    "categories": [
      { "id": 2, "name": "Hangout", "position": 0 },
      { "id": 5, "name": "Voice", "position": 1 }
    ]
  }
}
```

Audience: every connected client that holds `MANAGE_CHANNELS` or `ADMINISTRATOR`, judged when the frame is sent, and no one else. A non-manager is never sent the list, so the name of an empty or hidden category cannot reach them; they follow the `category*` fields on the channels they can see (see [channel_update](#channel_update-server---client-broadcast)). The frame follows the `channel_update` frames the same change produced. `ready.categories` carries the same list on every connect, and a resume that missed a change takes a full `ready`, so a client that was offline never needs the frame.

The REST routes that change categories are `GET`/`POST /api/v1/moderation/channels/categories`, `PUT .../categories/order` (body `{"ids":[...]}`, the full ordered id list; `409 CATEGORY_LIST_STALE` and nothing written when the set differs from the current one) and `PATCH`/`DELETE .../categories/{id}`, all `MANAGE_CHANNELS`, mirrored under `/admin/api/channels/categories`. A channel `POST`/`PATCH` accepts `category_id` (`0` = none, `400` when unknown); the older `category` name string still works (matched ignoring case, created when new, `""` = none) and `category_id` wins when both are sent. See [docs/api.md](api.md).

## Appeals

### appeal_status (Server -> Client)

B5-10: an appeal's state changed (assigned, decided, or withdrawn),
delivered ONLY to the appellant — targeted and unsequenced, never replayed.
A disconnected appellant simply sees the current state on their next
`GET /api/v1/appeals/mine`.

```json
{
  "type": "appeal_status",
  "payload": {
    "id": "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9",
    "state": "overturned",
    "decision_note": "at most 2000 runes, no control characters"
  }
}
```

`id` is the appeal's opaque public id. `state` is one of `assigned`,
`upheld`, `overturned`, `withdrawn`. `decision_note` is `null` until the
appeal is decided.

### ready's notices

`ready`'s payload carries a `notices` array: every warning issued to the
connecting user that they have not yet acknowledged.

```json
{
  "notices": [
    {
      "id": 42,
      "kind": "warning",
      "reason": "at most 500 runes, no control characters",
      "created_at": "2026-09-05T10:00:00Z"
    }
  ]
}
```

Acknowledge one with `POST /api/v1/users/me/notices/{id}/ack` (see
[api.md](api.md)) — own rows only. An acknowledged warning never reappears
here.

---

## Voice Signaling

Voice uses LiveKit as the SFU. WebSocket messages handle signaling (join/leave/state) while the actual audio/video flows through LiveKit's own WebSocket connection.

### voice_join (Client -> Server)

```json
{ "type": "voice_join", "payload": { "channel_id": 10, "user_initiated": true } }
```

`user_initiated` is optional: the client sets it when the user chose the join
and omits it on automatic rejoins (voice reconnect, resume, `voice_moved`). It
only exempts the join from a moderator's rejoin block (see `voice_mod_kick`).

In a two-person DM the join is refused with `FORBIDDEN` (`cannot join this call`)
when the other participant cannot be reached by the caller (see _Refusing a 1:1
interaction_ under DM Authorization).

The caller needs `CONNECT_VOICE` in the channel and, outside a DM,
`READ_MESSAGES` too: a voice channel hidden from the caller is not joinable.

A channel with `voice_max_users` set refuses a join with `CHANNEL_FULL` once it
holds that many users, except for a caller with `can_moderate_voice` in that
channel (`permissions.AuthorizeVoiceModerator`): a voice moderator joins a full
channel. Older servers apply the cap to everyone.

On success, server sends:

1. `voice_token` -- LiveKit JWT + URL
2. `voice_state` broadcast -- joiner's state to all clients
3. Existing `voice_state` messages -- one per existing participant (to joiner only)
4. `voice_config` -- channel audio settings (to joiner only)

All four keep the order above on the joiner's own socket: item 2 is
delivered synchronously (same call, same seq mechanism as any other
broadcast) rather than handed to the hub's asynchronous broadcast queue, so
it is written before item 3 in the same program order as items 1 and 4.

A refused join is answered with an `error` whose envelope `id` echoes the
`voice_join`'s own `id` (omitted when the request carried none), so the client
rolls back only the join that was refused, never on an error answering another
command. Servers before this change sent join refusals with no `id`; the client
still treats an id-less error as a refusal when its code is one a join can
return (`CHANNEL_FULL`, `VOICE_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`,
`RATE_LIMITED`, `ALREADY_JOINED`, `INTERNAL`, `TIMED_OUT`).

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

`direct_url` is the server's own `voice.livekit_url`, sent only when its host
is loopback (`localhost`, `127.0.0.1`, `::1`) and omitted otherwise; a client
without it connects through the `url` proxy path.

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

`quality` is the server's `voice.quality` setting; there is no per-channel
override. `threshold_mode`, `mixing_threshold` and `top_speakers` are reserved:
they are always sent, but no client reads them.

Quality presets:

| Preset   | Bitrate     |
| -------- | ----------- |
| `low`    | 32,000 bps  |
| `medium` | 64,000 bps  |
| `high`   | 128,000 bps |

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

`speaking` is always `false`: the speaking indicator comes from LiveKit's active
speakers, not from the server. The field is kept for compatibility.

`voice_state` also arrives **unsequenced** in one case: when a client joins a
voice channel, the states of participants already in the room are relayed to
it directly, one message per participant (see the `voice_join` reply order
above) — those relayed copies carry no `seq` and are not replayed on resume.
Every other `voice_state` — a join, a leave, a mute/unmute, anything that
changes an existing participant's state — is the sequenced broadcast form
shown above.

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

Four moderator commands act on another user's voice session. Mute, deafen,
disconnect and, for a target the actor outranks, move run
`permissions.AuthorizeVoiceModerator`; `voice_mod_move` can also be authorized
by `MOVE_MEMBERS` through `permissions.AuthorizeVoiceMover` (see `voice_mod_move`
below). Each runs its authorizer against the actor in the TARGET's channel:
the actor's base role must hold `MUTE_MEMBERS` (`ADMINISTRATOR` bypasses the bit;
for mute, deafen and disconnect never the hierarchy, and as it also passes
`AuthorizeVoiceMover`, an Administrator may move anyone), and the effective permission after both override layers
must hold `READ_MESSAGES | MUTE_MEMBERS`, so a channel-level deny holds and a
room the actor cannot see cannot be moderated. For a DM call the actor must be a
participant. The actor must strictly outrank the target by role position, except
for a move authorized by `MOVE_MEMBERS`. The target must currently be in a voice
channel. Each is rate limited to 5/sec and
written to the audit log (`voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`,
`voice_mod_kick`, target type `user`).

Failures: `FORBIDDEN` (missing bit, or a target of equal/higher rank on the
`MUTE_MEMBERS` path),
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
room cannot keep talking into it. Clearing it clears `deafened` too, so the
target hears the room again; `muted` is left as-is, and the target unmutes
themselves. The server cannot tell a deafen the target chose from the one the
moderator applied, so the desktop client keeps a deafen the target set before
the moderator did and restates it with `voice_deafen`.

### voice_mod_move (Client -> Server)

```json
{ "type": "voice_mod_move", "payload": { "user_id": 7, "to_channel_id": 12 } }
```

Authorized by either of two paths. A `MUTE_MEMBERS` holder moves members they
strictly outrank, exactly as before `MOVE_MEMBERS` existed (no owner switch, no
per-target limit). A `MOVE_MEMBERS` holder (base role, effective in the target's
channel) may move a member of any rank, the owner included; the owner is skipped
(`FORBIDDEN`, "the owner cannot be moved") while the owner-only setting
`voice_owner_movable` is `false` (default `true`), and a move of a member of
equal or higher rank is further limited to 3 per 30 seconds per target (a
move that then fails at eviction still counts). An actor holding neither bit
gets the same refusal whether the target is in voice or not. On every move the
mover must also be able to see the destination channel; one they cannot see
answers `NOT_FOUND` ("channel not found"), the same as a missing one.

The destination is checked against the TARGET's `CONNECT_VOICE` and, outside a
DM, `READ_MESSAGES` (a move must not place someone where they could not go
themselves) and against the destination's `voice_max_users` (skipped when the
target is a voice moderator there, as their own `voice_join` would be). The server then
runs its voice-leave routine for the target — `voice_leave` is broadcast, the
LiveKit participant is removed, the row deleted — and sends the target
`voice_moved`. The target's client answers with an ordinary `voice_join` for
the destination, so capacity, token minting and key-holder election keep their
single implementation.

A target whose socket has dropped while the server holds its call open for a
reconnect (up to 15 seconds) has no socket to receive `voice_moved`. The server
removes it from voice instead, audits the action as `voice_mod_kick`, and
answers the moderator with `VOICE_ERROR` ("user was reconnecting; removed from
voice instead of moved").

### voice_moved (Server -> Client, direct)

```json
{ "type": "voice_moved", "payload": { "to_channel_id": 12 } }
```

Sent only to the moved user. The client tears down its LiveKit session and joins
`to_channel_id`.

`by_user_id` is optional: the id of the moderator who made the move, so the
client can tell the member who moved them. It is present on a moderator move and
absent on the AFK sweep's, which has no actor. Older servers omit it.

```json
{ "type": "voice_moved", "payload": { "to_channel_id": 12, "by_user_id": 7 } }
```

`reason` is optional and absent on a moderator move. `"afk"` means the server's
AFK sweep moved a member who had been idle (presence `idle`) in a server voice
channel for the AFK timeout (`afk_timeout_seconds`) to the AFK channel:

```json
{ "type": "voice_moved", "payload": { "to_channel_id": 12, "reason": "afk" } }
```

The sweep runs every 60 seconds and moves at most 25 members per run, oldest
idle first. It moves only a member who could join the AFK channel themselves
(`CONNECT_VOICE`, not archived, room under `voice_max_users`) and only out of a
server voice channel, never out of a DM or group call; otherwise the member
stays where they are. A member whose socket has dropped is not moved. The
move is the same eviction plus client re-join as a moderator move: a server
mute or deafen survives it, and for 60 seconds an automatic `voice_join` to the
channel left is refused (a `user_initiated` join is not), so nothing returns the
member automatically. No audit row is written. A client that does not know
`reason` ignores it and re-joins as for a moderator move.

### voice_mod_kick (Client -> Server)

```json
{ "type": "voice_mod_kick", "payload": { "user_id": 7 } }
```

Removes the target from the LiveKit room, deletes their `voice_states` row and
broadcasts `voice_leave`, then sends them `voice_disconnected`. A target whose
call is being held for a reconnect is still removed, but gets no
`voice_disconnected`; on resume it sees only the replayed `voice_leave`.

For 60 seconds after any moderator kick or move, the server refuses an
automatic `voice_join` from the removed user to the channel it was removed from
with `FORBIDDEN` ("You were removed from this voice channel"), so a client
still reconnecting its voice cannot rejoin the call it was removed from. Other
channels are unaffected. A `voice_join` with `"user_initiated": true` (the
user's own click) is never refused this way and clears the block; the normal
join checks (permissions, bans, archive, capacity) still apply.

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

`voice_e2ee_announce` is rate limited at 5 per second per user.
`voice_e2ee_offer` has a higher outer budget of 64 per second per (sender,
voice channel) — the key holder fans one offer per peer on a rotation — plus
an inner cap of 5 per second per (sender, channel, target) so no single
recipient can be flooded (the W1-2 per-victim cap). Both answer
`RATE_LIMITED` when exceeded. Key material must be standard-alphabet base64
(padded or unpadded).

**Identity keys + TOFU:** each client holds a long-term ECDSA P-256 identity
keypair, published via `PATCH /api/v1/users/me` (`identity_public_key`) and
distributed in the `ready` / `member_join` / `user_update` member payloads.
Peers pin the key on first sight (trust-on-first-use) and verify each
announce's `signature` against the pin, so a malicious server cannot swap
`user_id ↔ ephemeral pubkey` without the announce failing verification. A
later identity-key change is accepted once the announce verifies against the
new key; the pin is replaced and the change is surfaced to the user.

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
    "signature": "base64-ecdsa-signature",
    "identity_public_key": "base64-device-identity-public-key",
    "video_decode": ["vp8", "h264", "vp9"]
  }
}
```

`identity_public_key` is optional: the public half of the device identity key
that made `signature`. A client sends it because the `auth` frame often cannot
carry the key on the first connection of an app start (the user id that scopes
the key only arrives in `auth_ok`). It uses the same rules as the `auth`
frame's field (base64, at most 128 characters). The server stores the
announce's key with the announce and relays it; when the announce has none, it
uses the connection's `auth`-frame key, and when neither exists the relayed
announce carries none. An invalid or wrongly typed value is ignored (the
announce is still accepted and the `auth`-frame key is used) and logged. The
connection's own key is never changed by an announce.

The server validates `signature` like `public_key` (standard-alphabet base64,
max 128 chars) and stores it alongside the key, but never verifies it — only
clients hold the pinned identity keys.

`video_decode` is optional: the video codecs this participant can decode, as
lowercase MIME subtypes (`vp8`, `h264`, `vp9`, `h265`, `av1`), so a screen
sharer can pick a codec every viewer can decrypt and render. The server treats
the values as opaque but accepts at most 8 entries, each 1-16 characters of
`[a-z0-9]`. If the list breaks that rule, or is not a list of strings, the server drops the whole field and
still accepts the announce — a bad list never affects the key. Each announce
replaces the stored list; an announce without the field clears it. Receivers
treat an absent or empty list as `["vp8", "h264"]`.

### voice_e2ee_announce (Server -> Client, broadcast to voice channel)

Relayed to the other participants with the sender's user ID attached. Also
replayed to late joiners (and to a resumed socket) from the stored
key+signature+list+identity key. `signature` and `video_decode` are omitted
when the announcing client did not send them (or sent an invalid
`video_decode`). `identity_public_key` is the announcing device's key: the
one in the announce itself when it sent a valid one, otherwise its connection's
`auth`-frame key. It is stored with the announce, so a live relay and every
replay carry the key of the device that made that announce. It is omitted when
the client sent neither (an older client):

```json
{
  "type": "voice_e2ee_announce",
  "payload": {
    "user_id": 1,
    "public_key": "base64-ecdh-pubkey",
    "signature": "base64-ecdsa-signature",
    "video_decode": ["vp8", "h264", "vp9"],
    "identity_public_key": "base64-device-identity-public-key"
  }
}
```

**Verify rule.** A receiving client verifies `signature` against the
announce's `identity_public_key` when it is present, and otherwise against the
member's published key (`identity_public_key` on the member object), which is
what an older server or client provides. The server relays the key and never
verifies the signature itself.

### voice_watch (Client -> Server)

The whole set of users whose **screen share** this participant watches now
(cameras are not counted). It is idempotent, so a lost or reordered frame
heals on the next send; clients re-send after a join and after a resume. An
empty list is valid and means "watching nothing".

```json
{ "type": "voice_watch", "payload": { "user_ids": [2, 5] } }
```

The sender must be in a voice channel (otherwise `VOICE_ERROR`). More than 16
ids answers `BAD_PAYLOAD`. The server drops ids that are not positive and the
sender's own id, removes duplicates and sorts ascending; it does not check
that the ids are in the channel or sharing (clients filter on display).
Rate limited at 10 per 5 seconds per user (`RATE_LIMITED`). The set lives in
memory on the member's voice slot, survives a resume, and is cleared on leave
and on a new join.

### voice_watching (Server -> Client, broadcast to voice channel)

Relayed to the other members of the same voice channel only (never the
sender, nobody outside the channel) when a member's set is stored. It is an
unsequenced pub/sub frame like `voice_e2ee_announce`: no `seq`, never
replayed. The server therefore re-sends it on join and on resume, one frame
per other member whose set is non-empty. There is no frame on leave; peers
drop that user's entry on `voice_leave`. `user_ids` is always an array.

```json
{ "type": "voice_watching", "payload": { "user_id": 1, "user_ids": [2, 5] } }
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

`encrypted_key` is opaque to the server (base64 and length checks only). Its
layout is:

```
0x01 ‖ epoch (u64 big-endian) ‖ AES-GCM ciphertext of the 32-byte room key
```

`epoch` is the holder's key-rotation counter, bound as GCM additional data so
the relay cannot change it without failing authentication. A receiver applies
an offer only if its epoch is at least the highest it has already applied from
that sender (equal is allowed: the holder re-sends the current key when a peer
re-announces); the mark resets when the sender announces a new ephemeral key.
A blob with no header (exactly 48 bytes: key + GCM tag) is the pre-epoch
format and is still accepted from holders on an older build; that
compatibility path is scheduled for removal in the next release.

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

Sent when a DM is opened, created, auto-reopened by an incoming message or call ring, or has
its membership changed (a group created, renamed, left, a member added or removed,
or the owner or the icon changed). A group's payload carries `owner_id` and `icon` (see `ready`). It is
always the full summary from the receiving member's seat, so a client replaces its
stored summary wholesale.

The payload is the same shape as one entry of the `ready` payload's
`dm_channels` and of `GET /api/v1/dms`, so a client has exactly one DM shape to
parse. It is built **per viewer**: `recipient` and `recipients` are both defined
relative to who is reading them, and the reader never appears in their own
`recipients`.

The one exception to "same shape" is `last_read_message_id`: it comes from the
read-state lookup behind `ready` and `GET /api/v1/dms`, which this event does not
run, so it is **absent** here rather than reported as `0`.

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

### dm_request (Server -> Client)

B5-6, one-to-one DMs only. Sent to the **recipient** in two situations:

- **On creation**, once: the first message from a sender the recipient does
  not yet trust (`docs/schema.md` migration `046`) stages a `message_requests`
  row instead of opening the conversation, and the recipient gets this frame
  with `preview` set. A resend while the request is still pending, or after
  it was ignored or deleted, creates no second row and sends nothing
  (decision 5) — the sender's own frames (`chat_send_ok`, `chat_message`) are
  unaffected either way, and the sender never learns which of the two cases
  they hit. `blocked` is not part of this silence (Codex P2-9): a resend from
  a blocked sender never reaches this gate at all — it is refused up front
  with `ErrBlocked` by the existing, pre-B5-6 block check, which the sender
  does see.
- **Never, when the recipient has message requests off.** A member who has
  direct messages on and message requests off (`message_requests: false` in
  `PUT /api/v1/users/me/privacy`) is reached by a first message directly: the
  request is recorded as already accepted, the recipient gets `dm_channel_open`
  and the `chat_message` as for any trusted sender, and no `dm_request` frame
  is sent. Requests already waiting stay pending. Turning requests back on
  later keeps that pair trusted. The setting is read when the message is
  stored, so a change made while a first message is in flight takes effect for
  that message either way.
- **On every transition**, with the new `state` and `preview: null` (the held
  message never changes): `accept` (`dm_channel_open` is sent first, then
  this), `ignore`, `delete`, `block` — see `docs/api.md`'s "Message Requests"
  section for the REST routes that decide a request. Sent to the recipient's
  other live connections, not to the sender.

```json
{
  "type": "dm_request",
  "payload": {
    "id": 1,
    "state": "pending",
    "channel_id": 100,
    "sender": {
      "id": 7,
      "username": "stranger",
      "display_name": "",
      "avatar": ""
    },
    "preview": {
      "message_id": 55,
      "content": "hi, stranger",
      "timestamp": "2026-09-05T12:00:00Z"
    },
    "created_at": "2026-09-05T12:00:00Z",
    "decided_at": null
  }
}
```

| Field        | Type           | Description                                                                                   |
| ------------ | -------------- | --------------------------------------------------------------------------------------------- |
| `state`      | string         | `pending`, `accepted`, `ignored`, `deleted` or `blocked`                                      |
| `sender`     | object         | The message's author — a stranger's profile, safely previewed with no automatic fetch (below) |
| `preview`    | object \| null | The held message's id/content/timestamp; present only on creation, `null` on every transition |
| `decided_at` | string \| null | Set once a recipient transition lands; `null` while pending                                   |

**Unsequenced and NOT replayed**, like `dm_channel_open`/`dm_channel_close`
above: a client that misses one recovers from `GET /api/v1/dm-requests`, the
persisted source of truth, rather than the replay ring buffer. Unlike
`dm_channel_open` it does not bump the visibility watermark — a missed
`dm_request` does not strand a channel a full resync is needed to see, the
REST inbox already has it.

**The recipient's client must render this with every automatic media, embed,
link-preview and avatar fetch suppressed** — decision 4's "safely previewed":
`sender.avatar` can be an external URL (Codex P3-10), so fetching it is
exactly the kind of network request to a stranger-controlled endpoint this
frame exists to withhold, same as any link or embed in the message body.
Nothing the client would otherwise auto-fetch runs until the recipient
accepts (B9 implements the client half; this frame carries the flag by
construction — the suppression list above is exhaustive over what the
payload contains to fetch from).

**The sender receives nothing from this path, ever** — not a hint that a
request exists, not its state, not whether it was ever decided.

### DM Authorization

All handlers that touch a channel check the channel type and branch to participant-based authorization for DMs instead of role-based permissions. This applies to: `chat_send`, `chat_edit`, `chat_delete`, `reaction_add`/`remove`, `typing_start`, `channel_focus`, `mark_read`, `mark_unread`, `call_ring`, `call_decline`.

Group DMs need no special case: `dm_participants` holds one row per
participant, and every check is a lookup on `(user_id, channel_id)`.

**Refusing a 1:1 interaction.** `chat_send`, `chat_edit`, `reaction_add` /
`reaction_remove`, `call_ring` and `voice_join` (with `voice_token_refresh`) in
a two-person DM are refused with `FORBIDDEN` when the other participant cannot
be reached by the sender, and `typing_start` is dropped silently. That is the
case when either has blocked the other, and also when the other participant has
turned off direct messages from members (`allow_member_dms`, see `GET
/api/v1/users/me/privacy`) and holds no trust row for the sender (accepted,
sent first, or grandfathered). Every cause produces the same code and message
on a given command (`you can't message this user`; `cannot join this call` for
`voice_join`), so the frame says nothing about which cause applies. A refused
send writes no message and no message request, and the recipient receives no
frame. On `chat_send`, `call_ring` and `voice_join`, a failed read of the setting is answered `INTERNAL`, not `FORBIDDEN`.
Creating a group DM, or adding people to one, is refused with the same `FORBIDDEN`
and message (`cannot add this user to a group DM`) whatever the cause: a block,
a person with direct messages off who does not trust the caller, or a person the
caller holds an unaccepted message request to. Only the caller's trust counts,
the response never names the person, and a member who later turns direct
messages off stays in the group.

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

Only a participant of the DM may ring it (`FORBIDDEN` otherwise, which also
covers a counterpart who cannot be reached by the caller, see _Refusing a 1:1
interaction_ under DM Authorization), and not
while timed out (`TIMED_OUT`; `call_decline` still works). A 1:1 ring to
someone who has not accepted the caller (a pending, ignored or deleted message
request alike) is refused at once with `CALL_REQUIRES_ACCEPTANCE` and never
delivered; `call_decline` to them stays a silent success. Rate limited
to one ring every 3 seconds per user — per _user_, not per channel, because the
abuse it prevents is spamming somebody with call banners.

The client joins the DM's voice channel **before** ringing: the ring is only
truthful once the caller is actually there, and the server enforces it — a ring
from a caller who is not in that DM's voice channel is refused with `VOICE_ERROR`
and nobody is rung. The client sends the ring once the voice session
is connected, not while it is still securing (so none goes out if the join is
refused or the caller leaves first), and holds it back so it never goes out
within 3 seconds (plus transport slack) of the previous ring. It drops a
held-back ring if the socket has disconnected.

A callee who had closed the DM gets it reopened: the server sends them a
`dm_channel_open` for the channel just before the `call_incoming`, so the DM is
back in their sidebar when the banner appears. An already-open DM sends none.

### call_incoming (Server -> Client)

Forwarded to every other participant that is connected. An offline addressee is
a no-op by construction — a ring that arrives after the fact is worse than no
ring.

A ring (and a `call_declined`) is delivered in order behind any earlier
`voice_leave`/`voice_state` the server sent to that client, so a stale leave
never lands after, and cancels, the new ring.

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
`call_declined`, on a `voice_leave` that empties the room, or after a 30 second timeout.
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
    "delay_seconds": 5,
    "reconnect_spread_ms": 20000
  }
}
```

`reason` is one of a closed set, generated from `protocol/schema.json`
(`ws.RestartReason`, `ServerRestartReason`):

| `reason`         | Sent when                                                                  |
| ---------------- | -------------------------------------------------------------------------- |
| `update`         | an admin applied a server update                                           |
| `update_aborted` | with `delay_seconds` 0: the staged update failed, the restart is cancelled |
| `backup_restore` | an admin restored a backup                                                 |
| `setup`          | the setup wizard finished                                                  |
| `shutdown`       | a stop or restart from outside the server (a signal, a supervisor)         |

A restart the admin panel starts is announced twice: once by the admin
action, and again by the hub as the server stops, both naming the same
`reason`. A stop from outside is announced once, as `shutdown`.

A positive `delay_seconds` announces that the socket is about to drop. The
desktop client keeps the session for every `reason`: it counts down,
reconnects with the same token once the server is back and returns to the
channel it was in. Voice ends when the socket actually drops after an
announcement, since the server's voice state goes with the process; the
announcement alone leaves the call, because an update can still be aborted.
After the drop, the client re-joins the call with one ordinary `voice_join`
once `ready` arrives, within a window that depends on the `reason`
([voice-and-e2ee.md](architecture/ux/voice-and-e2ee.md), RT-12).
A zero `delay_seconds` cancels an earlier announcement (`update_aborted`).

`reconnect_spread_ms` spreads the reconnect herd: 10 ms per client connected
when the notice is sent, capped at 30 000 (2,000 clients get 20 s). Each client
picks a uniform offset in `[0, reconnect_spread_ms]` and makes its first
redial at `delay_seconds` plus that offset after the notice, or that offset
after the drop when the socket drops later than announced. A network-return or
focus signal does not cut this wait short, unlike an ordinary reconnect's
backoff. A server that predates the field omits it; treat that as 0.

### Fresh-connect admission (`SERVER_BUSY`)

A fresh connect (and a resume that falls back to a full `ready`) takes one of
a bounded number of ready-build permits (2 × the server's CPU count) after
`auth` is accepted and before any handshake work. It waits up to 10 s for one;
past that the server sends, before `auth_ok`,

```json
{
  "type": "error",
  "payload": {
    "code": "SERVER_BUSY",
    "message": "server busy, retrying shortly",
    "retry_after_ms": 3712
  }
}
```

and closes with status 1013 (try again later). `retry_after_ms` is drawn from
2.5–5 s per refusal, so the refused connects do not return together; a client
waits at least that long before redialling. The desktop client does this
silently, without an error toast. On a first sign-in it keeps its connecting
screen: each refusal restarts the 20 s first-authentication deadline, up to
70 s after the first attempt, after which the sign-in fails with an error. A
warm resume served by replay never waits for a permit.

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

| Code                       | Description                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAD_REQUEST`              | Invalid payload format or field values                                                                                                                                                                                                        |
| `BAD_PAYLOAD`              | Structurally valid message with a field that fails validation (E2EE announce/offer key material, signatures, targets)                                                                                                                         |
| `INTERNAL`                 | Server-side error                                                                                                                                                                                                                             |
| `NOT_FOUND`                | Channel or message not found                                                                                                                                                                                                                  |
| `FORBIDDEN`                | Missing required permission                                                                                                                                                                                                                   |
| `NOT_KEY_HOLDER`           | `voice_e2ee_offer` sent by a participant who is not the channel's key holder                                                                                                                                                                  |
| `STICKER_NOT_FOUND`        | A `chat_send` named a sticker that does not exist or was deleted. Nothing was stored. Refines `NOT_FOUND`.                                                                                                                                    |
| `THREAD_EXISTS`            | The message already has a thread; the error carries `thread_id`                                                                                                                                                                               |
| `THREAD_LOCKED`            | The thread is locked; only a moderator may post in it or change it                                                                                                                                                                            |
| `GAME_ACTIVITY_DISABLED`   | `activity_update` or `listening_update` set a game or a song while an admin has member activity switched off for the server; a clear is never refused (WP 8.3e-2, 8.10a)                                                                      |
| `RATE_LIMITED`             | Too many requests (the error carries only `code` and `message`; REST 429s carry a `Retry-After` header, WS errors do not)                                                                                                                     |
| `ALREADY_JOINED`           | Already in this voice channel                                                                                                                                                                                                                 |
| `CHANNEL_FULL`             | Voice channel at capacity                                                                                                                                                                                                                     |
| `VOICE_ERROR`              | Voice-specific error                                                                                                                                                                                                                          |
| `VIDEO_LIMIT`              | Maximum video streams reached                                                                                                                                                                                                                 |
| `BANNED`                   | User is banned                                                                                                                                                                                                                                |
| `INVALID_JSON`             | Message is not valid JSON                                                                                                                                                                                                                     |
| `UNKNOWN_TYPE`             | Unrecognized message type                                                                                                                                                                                                                     |
| `SLOW_MODE`                | Channel has slow mode enabled                                                                                                                                                                                                                 |
| `TIMED_OUT`                | A send, edit, reaction, voice join, call ring or custom status refused by an active moderator timeout (B5-9)                                                                                                                                  |
| `CALL_REQUIRES_ACCEPTANCE` | A 1:1 `call_ring` whose recipient has not accepted the caller's message request; the ring is never delivered                                                                                                                                  |
| `CONFLICT`                 | Duplicate reaction or constraint violation                                                                                                                                                                                                    |
| `ALREADY_DELETED`          | The target message is already soft-deleted (the WebSocket twin of REST's `409 ALREADY_DELETED`)                                                                                                                                               |
| `REACTION_LIMIT`           | A `reaction_add` with a new emoji on a message that already has 20 different ones. No `reaction_update` is sent. Refines `BAD_REQUEST`.                                                                                                       |
| `POLL_ENDED`               | A `poll_vote` on a poll that was ended or whose time ran out, or a `poll_end` on one already ended. Nothing was written and no `poll_update` is sent. Refines `BAD_REQUEST`.                                                                  |
| `ATTACHMENTS_UNAVAILABLE`  | A `chat_send` with no text whose every attachment was skipped (swept, foreign, already attached, a live avatar or group icon, or missing). No message is delivered and no ids are returned; the client holds the list. Refines `BAD_REQUEST`. |
| `SERVER_MUTED`             | Self-unmute refused: a moderator imposed the mute                                                                                                                                                                                             |
| `SERVER_DEAFENED`          | Self-undeafen refused: a moderator imposed the deafen                                                                                                                                                                                         |
| `SESSION_REPLACED`         | Sent before the close to a connection displaced because the same device session reconnected, or because the account is over its 10-connection cap; the client does not reconnect on its own                                                   |
| `SERVER_BUSY`              | A fresh connect waited too long for a ready-build permit; carries `retry_after_ms`, and the socket closes 1013 (see Fresh-connect admission)                                                                                                  |
| `REQUEST_TIMEOUT`          | A command's database work ran past the per-frame deadline and was not applied; the `error` carries the command's `id` (see Command deadlines). Unlike `SERVER_BUSY` it does not end the connection                                            |
| `ANOTHER_DEVICE_ACTIVE`    | No longer sent; kept for clients that still talk to an older server, which refused a wake reconnect while a different session held the connection                                                                                             |

After 10 consecutive invalid JSON messages, the connection is forcibly closed.

A command's `channel_id`, `message_id`, `thread_id`, `user_id` and
`to_channel_id` must be positive integers. A missing, fractional, zero or
negative one is refused with `BAD_REQUEST` and an `invalid payload` message
before the command runs. Two exceptions: `chat_command`'s `channel_id` may be
0 ("no channel"), and ids sent as plain integers or lists (`reply_to`,
`target_user_id`, `user_ids`, `tag_ids`, `answer_ids`) are checked by the
command itself. An id that a
command documents as optional (`mark_read`'s `message_id`, `thread_focus`'s
`thread_id`) may be left out or `null`, but is checked when present.

### Command deadlines

Each inbound frame's database work (the periodic session recheck, the
app-level `ping` session touch and the command handler) runs under a 10 s
deadline, under the 25 s server ping interval. A command that is still failing
when the deadline passes is answered with `REQUEST_TIMEOUT`, carrying the
command's `id`, and its effects are not applied: a transaction whose context
ends before commit is rolled back. Work after a commit (mention badges, push,
audit rows) is detached from the frame's context, so a deadline that expires
after the commit still yields the normal success reply and broadcast. A retry
is safe: `chat_send` and `chat_forward` dedupe on `client_message_id`, an edit is idempotent, a
delete answers `ALREADY_DELETED`, a reaction answers `CONFLICT` and `mark_read`
is idempotent. `voice_mod_mute`, `voice_mod_deafen`, `voice_mod_move`,
`voice_mod_kick` and `chat_command` are exempt: they pair a database write with
a LiveKit call or a plugin budget of their own. The retry answers differ by
command: a retried `reaction_add` answers `CONFLICT` and a retried
`reaction_remove` answers `BAD_REQUEST`. A timed-out send in a slow-mode channel,
or a timed-out `voice_token_refresh`, has already spent its rate budget, so the
retry may answer `SLOW_MODE` or `RATE_LIMITED` until the window passes.
`typing_start` answers nothing on a timeout, because it swallows every error
that is not a refusal. `channel_focus`, `mark_read` and `mark_unread` answer
`REQUEST_TIMEOUT` when a database call runs past the deadline. `mark_read` and
`mark_unread` also answer it when the wait is for the lock that orders
`mention_count` and `read_state` frames behind a stalled mention write. A
`voice_join` bounds its checks and the membership insert by the deadline and
answers `REQUEST_TIMEOUT` without joining; once the membership row is committed
the rest of the join runs to completion. A channel switch that times out after
it left the previous channel has already dropped that membership, and the
client has received the `voice_leave` for it. A `voice_token_refresh` that times out answers
`REQUEST_TIMEOUT` and leaves the user in voice; only a real refusal evicts, and
a client `voice_leave` always releases the user's slot. One exception to the
bound: `chat_delete` flushes the message's pending mention counts on a detached
context before it deletes, so that step is not limited by the deadline. The
deadline bounds each command, not each connection: commands queued behind a
stalled writer each wait their own deadline in turn. A client that predates the
code treats it as an unknown error string.

---

## Rate Limits

All rate limits are enforced server-side using a token bucket rate limiter.

| Action                                      | Limit | Window                                     | Error Response       |
| ------------------------------------------- | ----- | ------------------------------------------ | -------------------- |
| Chat send                                   | 10    | 1 second                                   | `RATE_LIMITED` error |
| Chat edit                                   | 10    | 1 second                                   | `RATE_LIMITED` error |
| Chat delete                                 | 10    | 1 second                                   | `RATE_LIMITED` error |
| Typing                                      | 1     | 3 seconds                                  | Silently dropped     |
| Presence                                    | 1     | 10 seconds                                 | `RATE_LIMITED` error |
| Reactions                                   | 5     | 1 second                                   | `RATE_LIMITED` error |
| Voice join / leave                          | 5     | 1 second                                   | `RATE_LIMITED` error |
| Voice camera                                | 2     | 1 second                                   | `RATE_LIMITED` error |
| Voice screenshare                           | 2     | 1 second                                   | `RATE_LIMITED` error |
| Voice token refresh                         | 1     | 60 seconds                                 | `RATE_LIMITED` error |
| Voice E2EE announce                         | 5     | 1 second                                   | `RATE_LIMITED` error |
| Voice E2EE offer                            | 64    | 1 second                                   | `RATE_LIMITED` error |
| Voice moderation (mute/deafen/move/kick)    | 5     | 1 second                                   | `RATE_LIMITED` error |
| Call ring                                   | 1     | 3 seconds                                  | `RATE_LIMITED` error |
| Call decline                                | 1     | 3 seconds                                  | `RATE_LIMITED` error |
| Forward (`chat_forward`)                    | 5     | 10 seconds                                 | `RATE_LIMITED` error |
| Poll create (`poll_create`)                 | 5     | 10 minutes                                 | `RATE_LIMITED` error |
| Poll vote and end (`poll_vote`, `poll_end`) | 10    | 10 seconds (one shared budget)             | `RATE_LIMITED` error |
| Plugin command (`chat_command`)             | 5     | 1 second                                   | `RATE_LIMITED` error |
| Channel focus                               | 5     | 1 second                                   | Deferred             |
| Thread create                               | 5     | 10 minutes                                 | `RATE_LIMITED` error |
| Thread focus                                | 5     | 1 second (own budget)                      | `RATE_LIMITED` error |
| Mark read                                   | 5     | 1 second (own budget, separate from focus) | Silently dropped     |
| Ping                                        | 2     | 1 second                                   | Silently dropped     |

The E2EE offer budget is deliberately higher than the announce budget: a key
rotation fires one offer per peer in a single burst, so the limit is sized to
a whole rotation rather than to a single frame. Within that outer budget an
inner cap of 5 per second per (sender, channel, target) stops any single
recipient from being flooded.

A `channel_focus` over its budget is deferred rather than dropped: the server
remembers the latest refused channel and applies it (subscription and read
state) as soon as the window frees, so a burst of channel switches ends on the
channel the user landed on, with the `read` flag it carried. A newer `channel_focus` supersedes a pending one,
whether it succeeds or fails. If the user can no longer read the deferred
channel when it is applied, the reply is a `FORBIDDEN` error carrying that
frame's `id`.

---

## Message Type Reference Table

The authoritative type inventory is [protocol/schema.json](../protocol/schema.json),
from which the Go and TypeScript constant files are generated
(`make protocol-generate` / verified in CI by `make protocol-verify`). The
tables below add per-type behavioral notes.

### Client -> Server (28 types)

| Type                  | Rate Limit                                                  | Notes                                                           |
| --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `auth`                | N/A (first message)                                         | Token + optional last_seq                                       |
| `chat_send`           | 10/sec                                                      | + slow mode per channel                                         |
| `chat_forward`        | 10/sec, then 5/10sec                                        | One target per frame; `client_message_id` required; no pings    |
| `poll_create`         | 10/sec, then 5/10min                                        | `client_message_id` required; no pings                          |
| `poll_vote`           | 10/10sec (shared with `poll_end`)                           | Whole selection; idempotent                                     |
| `poll_end`            | 10/10sec (shared with `poll_vote`)                          | Author, or `MANAGE_MESSAGES`; DM author only                    |
| `chat_edit`           | 10/sec                                                      | Own messages only                                               |
| `chat_delete`         | 10/sec                                                      | Own or mod (non-DM)                                             |
| `reaction_add`        | 5/sec                                                       |                                                                 |
| `reaction_remove`     | 5/sec                                                       |                                                                 |
| `typing_start`        | 1/3sec/channel                                              | Silently dropped                                                |
| `channel_focus`       | 5/sec (deferred, see above)                                 | Updates read state                                              |
| `thread_focus`        | 5/sec, own budget (`RATE_LIMITED`)                          | Second focus slot for a thread; marks it read                   |
| `thread_create`       | 5/10min                                                     | `RATE_LIMITED`; a retry by the owner is free                    |
| `thread_follow`       | 5/sec, own budget (`RATE_LIMITED`)                          | Follow or unfollow a thread; idempotent                         |
| `mark_read`           | 5/sec, own budget (silently dropped)                        | Updates read state without moving focus; answers `read_state`   |
| `mark_unread`         | 5/sec, own budget (`RATE_LIMITED`)                          | Moves the read pointer back; answers `read_state`               |
| `presence_update`     | 1/10sec                                                     |                                                                 |
| `activity_update`     | 1/10sec, own budget (`RATE_LIMITED`)                        | A set only; a clear and a repeat of the current one are free    |
| `listening_update`    | 1/10sec, own budget (`RATE_LIMITED`)                        | A set only; a clear and a repeat of the current song are free   |
| `voice_join`          | 5/sec                                                       |                                                                 |
| `voice_leave`         | 5/sec                                                       | Empty payload                                                   |
| `voice_mute`          | 2/sec                                                       | Refused with `SERVER_MUTED` while server muted                  |
| `voice_deafen`        | 2/sec                                                       | Refused with `SERVER_DEAFENED` while server deafened            |
| `voice_camera`        | 2/sec                                                       | Requires USE_VIDEO                                              |
| `voice_screenshare`   | 2/sec                                                       | Requires SHARE_SCREEN                                           |
| `voice_mod_mute`      | 5/sec                                                       | AuthorizeVoiceModerator in target's channel + outranks          |
| `voice_mod_deafen`    | 5/sec                                                       | AuthorizeVoiceModerator in target's channel + outranks          |
| `voice_mod_move`      | 5/sec (and 3 per 30 sec per target of equal or higher rank) | AuthorizeVoiceModerator + outranks, or AuthorizeVoiceMover      |
| `voice_mod_kick`      | 5/sec                                                       | AuthorizeVoiceModerator in target's channel + outranks          |
| `voice_token_refresh` | 1/60sec                                                     | Must be in voice                                                |
| `voice_e2ee_announce` | 5/sec                                                       | ECDH pubkey announce                                            |
| `voice_e2ee_offer`    | 64/sec outer, 5/sec per target                              | Wrapped room key to target (budgeted per key rotation)          |
| `voice_watch`         | 10/5sec                                                     | Must be in voice; screen shares watched, max 16 ids             |
| `call_ring`           | 1/3sec                                                      | DM participants only; fans out as `call_incoming`               |
| `call_decline`        | 1/3sec                                                      | DM participants only; fans out as `call_declined`               |
| `chat_command`        | 5/sec                                                       | Plugin slash command; max 64 args; broadcast gated by `CanPost` |
| `ping`                | 2/sec (silently dropped)                                    | Heartbeat                                                       |

### Server -> Client (46 types)

| Type                   | Has seq? | Delivery                                                                                               |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `auth_ok`              | No       | Direct                                                                                                 |
| `auth_error`           | No       | Direct (then close)                                                                                    |
| `ready`                | No       | Direct                                                                                                 |
| `chat_message`         | Yes      | Channel or DM participants                                                                             |
| `chat_send_ok`         | No       | Direct to sender                                                                                       |
| `chat_forward_ok`      | No       | Direct to sender                                                                                       |
| `poll_create_ok`       | No       | Direct to sender                                                                                       |
| `poll_vote_ok`         | No       | Direct to sender                                                                                       |
| `poll_end_ok`          | No       | Direct to sender                                                                                       |
| `thread_create_ok`     | No       | Direct to sender                                                                                       |
| `thread_update_ok`     | No       | Direct to sender                                                                                       |
| `thread_follow_ok`     | No       | Direct to sender                                                                                       |
| `thread_follow_update` | No       | The one user (low queue, not replayed)                                                                 |
| `thread_changed`       | Yes      | Parent channel (coalesced, at most 1 per thread per 2 s)                                               |
| `thread_deleted`       | Yes      | Parent channel; unsequenced copy to sockets with the thread open                                       |
| `chat_edited`          | Yes      | Channel or DM participants                                                                             |
| `chat_deleted`         | Yes      | Channel or DM participants                                                                             |
| `chat_bulk_deleted`    | Yes      | Channel                                                                                                |
| `chat_pinned`          | Yes      | Channel                                                                                                |
| `reaction_update`      | Yes      | Channel or DM participants                                                                             |
| `poll_update`          | Yes      | Channel or DM participants                                                                             |
| `typing`               | No       | Channel (excl. sender) or DM                                                                           |
| `presence`             | Yes      | All clients                                                                                            |
| `presence_batch`       | Yes      | All clients (a full snapshot: no, direct to one client)                                                |
| `channel_create`       | No       | Each client that may view the channel (per-recipient)                                                  |
| `channel_update`       | Yes      | All clients                                                                                            |
| `channel_delete`       | Yes      | All clients                                                                                            |
| `voice_state`          | Yes      | All clients                                                                                            |
| `voice_leave`          | Yes      | All clients                                                                                            |
| `voice_moved`          | No       | Direct to moved user                                                                                   |
| `voice_disconnected`   | No       | Direct to disconnected user                                                                            |
| `voice_config`         | No       | Direct to joiner                                                                                       |
| `voice_token`          | No       | Direct to joiner                                                                                       |
| `member_join`          | Yes      | All clients                                                                                            |
| `member_update`        | Yes      | All clients                                                                                            |
| `user_update`          | Yes      | All clients (profile changes)                                                                          |
| `member_ban`           | Yes      | All clients                                                                                            |
| `roles_update`         | Yes      | All clients (full role list)                                                                           |
| `emoji_update`         | Yes      | All clients (full custom-emoji set)                                                                    |
| `sticker_update`       | Yes      | All clients (full custom-sticker set)                                                                  |
| `upload_policy`        | No       | All clients (both upload file-type lists)                                                              |
| `game_activity_policy` | No       | All clients (the game activity switch)                                                                 |
| `dm_channel_open`      | No       | Direct to participant                                                                                  |
| `dm_channel_close`     | No       | Direct to participant                                                                                  |
| `dm_request`           | No       | Direct to recipient (B5-6)                                                                             |
| `call_incoming`        | No       | Direct to each other DM participant                                                                    |
| `call_declined`        | No       | Direct to each other DM participant                                                                    |
| `voice_e2ee_announce`  | No       | Voice channel (excl. sender)                                                                           |
| `voice_e2ee_offer`     | No       | Direct to target participant                                                                           |
| `voice_watching`       | No       | Voice channel (excl. sender)                                                                           |
| `server_restart`       | Yes      | All clients                                                                                            |
| `mod_queue`            | No       | Connected `MODERATE_MEMBERS`/`ADMINISTRATOR` holders only                                              |
| `mod_action`           | No       | Direct to the live target only                                                                         |
| `member_timeouts`      | No       | Connected `MODERATE_MEMBERS`/`ADMINISTRATOR` holders (full list) and each timed-out member (own entry) |
| `channel_categories`   | No       | Connected `MANAGE_CHANNELS`/`ADMINISTRATOR` holders only (full list, judged at send time)              |
| `appeal_status`        | No       | Direct to the appellant only                                                                           |
| `mention_count`        | No       | Direct to the reader whose mention badge changed (DP-27)                                               |
| `read_state`           | No       | Direct to the caller after an accepted `mark_read` or `mark_unread` (WP 3D-5c)                         |
| `error`                | No       | Direct to requester                                                                                    |
| `pong`                 | No       | Direct to pinger                                                                                       |
| `command_reply`        | No       | Direct to invoking client (ephemeral plugin reply)                                                     |
| `plugin_broadcast`     | Yes      | Channel (plugin output posted as a broadcast; sequenced and replayable)                                |
| `nsfw_ack`             | No       | Direct to the user's own sockets (B5-7)                                                                |

### Plugin command types

Three wire types exist for the WASM plugin system. Since 2026-08-04 they are
listed in `protocol/schema.json` like every other type (closing DC-01), so
the generated constants cover them and `make protocol-verify` plus the
`ws` package's protocol-contract test gate them against drift.

| Type               | Direction        | Notes                                                                                                                                                                                                                |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_command`     | Client -> Server | `{command, args[], channel_id, req_id?}`; max 64 args; unknown commands return an `error`. Rate limited at 5/sec (`RATE_LIMITED`); a channel broadcast is gated by the same `CanPost` policy as a real message send. |
| `command_reply`    | Server -> Client | Ephemeral plugin reply, sent only to the invoking client; echoes `req_id`. Payload: `{text}`.                                                                                                                        |
| `plugin_broadcast` | Server -> Client | Plugin output posted to a channel. Payload: `{channel_id, user_id, command, text}`.                                                                                                                                  |
