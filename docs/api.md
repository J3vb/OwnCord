# REST API Reference

OwnCord server REST API reference. All endpoints use the base URL `https://{server}:{port}/api/v1`.

---

## Authentication

All authenticated endpoints require a session token delivered via the `Authorization: Bearer {token}` header. Tokens are obtained from `POST /api/v1/auth/login`, `POST /api/v1/auth/register`, or `POST /api/v1/auth/verify-totp` after a partial 2FA challenge.

### Session Lifecycle

- Sessions are created on login/register and stored with a SHA-256 hash of the raw token, the client IP, User-Agent, and an expiry timestamp.
- Each authenticated request updates the session's `last_active` timestamp.
- Banned users are rejected at the middleware level with `403 FORBIDDEN`.

### Middleware Stack (all routes)

In mount order (`Server/api/router.go`):

1. **boundRequestID** -- drops an oversized (>128 bytes) or non-printable client-supplied `X-Request-Id` before chi adopts it.
2. **RequestID** (chi) -- assigns the request ID used in logs.
3. **setRequestIDHeader** -- echoes the request ID into the `X-Request-Id` response header.
4. **Recoverer** -- catches panics, logs them through `slog` with a stack capture, returns 500.
5. **Request Logger** -- structured logging of method, path, status, duration.
6. **Telemetry HTTP middleware** -- OpenTelemetry tracing; a no-op unless the server was built with `-tags otel` and telemetry is enabled.
7. **SecurityHeadersWithTLS** -- (adds `Strict-Transport-Security` when TLS is on) sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'self'`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cache-Control: no-store`.
8. **MaxBodySize** -- 1 MiB default for all routes except `/api/v1/uploads` (which has its own 100 MiB limit).
9. **Coraza WAF** (optional) -- OWASP Core Rule Set request filtering, mounted only when `server.waf_enabled: true` (see `docs/server-configuration.md`).

Note: chi's `middleware.RealIP` is deliberately **not** used -- client IPs are resolved from `X-Forwarded-For` only when the peer is listed in `server.trusted_proxies`.

---

## Standard Error Response

All error responses use this JSON envelope:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable detail"
}
```

### Error Codes

| Code | HTTP Status | When It Occurs |
| ---- | ----------- | -------------- |
| `UNAUTHORIZED` | 401 | Missing/invalid/expired session token |
| `INVALID_CREDENTIALS` | 401 | Login/register with bad username/password/invite (generic to prevent enumeration) |
| `FORBIDDEN` | 403 | Insufficient permissions, banned account, or admin IP restriction |
| `NOT_FOUND` | 404 | Resource (channel, message, user, invite, file, backup) not found |
| `RATE_LIMITED` | 429 | Too many requests; response includes `Retry-After` header (seconds) |
| `INVALID_INPUT` / `BAD_REQUEST` | 400 | Malformed body, missing required fields, invalid query params |
| `CONFLICT` | 409 | Duplicate username on register, or server already up-to-date on update |
| `TOO_LARGE` | 413 | File exceeds upload size limit |
| `SERVER_ERROR` / `INTERNAL` | 500 | Internal server error |
| `BAD_GATEWAY` | 502 | Upstream failure (GitHub API, LiveKit, GIF provider, asset download) |
| `GIF_DISABLED` | 503 | GIF proxy is not configured on this server (no `gif.api_key`) |

---

## Auth Endpoints

### POST /api/v1/auth/register

Create a new account using an invite code. The first user is created via `/admin/api/setup` instead.

**Auth:** None (public)
**Rate limit:** 3 requests/minute per IP

#### Request

```json
{
  "username": "alex",
  "password": "MyStr0ng!Pass",
  "invite_code": "abc123def"
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `username` | string | Yes | HTML-stripped, trimmed. Must be non-empty. |
| `password` | string | Yes | Validated for strength (min length, complexity). |
| `invite_code` | string | Yes | Must be a valid, non-expired, non-revoked invite with remaining uses. |

#### Response 201 Created

```json
{
  "token": "raw-session-token-64-chars",
  "user": {
    "id": 2,
    "username": "alex",
    "avatar": "",
    "display_name": null,
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing username/password/invite_code, or weak password |
| 400 | `INVALID_CREDENTIALS` | Bad invite code, expired/revoked invite, or duplicate username |
| 403 | `FORBIDDEN` | Registration is closed or unavailable while server-wide 2FA is required |
| 429 | `RATE_LIMITED` | Exceeded 3 registrations/minute from this IP |
| 500 | `SERVER_ERROR` | Hashing failure, session creation failure, or DB error |

---

### POST /api/v1/auth/login

Authenticate with username and password.

**Auth:** None (public)
**Rate limit:** 5 requests/minute per IP. After 10 failed attempts within 15 minutes from the same IP, the IP is locked out for 15 minutes. Independently, 10 failed attempts against the same username (from any IP) lock that account out for 15 minutes. Lockouts are persisted to the database and survive server restarts.

#### Request

```json
{
  "username": "alex",
  "password": "MyStr0ng!Pass"
}
```

#### Response 200 OK

If the account does not have TOTP enabled:

```json
{
  "token": "raw-session-token-64-chars",
  "requires_2fa": false,
  "user": {
    "id": 1,
    "username": "alex",
    "avatar": "/api/v1/files/uuid",
    "display_name": "Alex",
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

If the account has TOTP enabled:

```json
{
  "partial_token": "opaque-partial-token",
  "requires_2fa": true
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing username or password |
| 401 | `UNAUTHORIZED` | Wrong username or password |
| 403 | `FORBIDDEN` | Account is banned/suspended |
| 429 | `RATE_LIMITED` | IP locked out after 10 consecutive failures (15 min cooldown) |
| 500 | `SERVER_ERROR` | Session creation failure |

---

### POST /api/v1/auth/verify-totp

Complete a TOTP login challenge started by `POST /api/v1/auth/login`.

**Auth:** Required with the `partial_token` from the login response
**Rate limit:** 10 requests/minute per IP, plus a 5-attempt budget per partial challenge

#### Request

```json
{
  "code": "123456"
}
```

#### Response 200 OK

```json
{
  "token": "raw-session-token-64-chars",
  "requires_2fa": false,
  "user": {
    "id": 1,
    "username": "alex",
    "avatar": "/api/v1/files/uuid",
    "display_name": "Alex",
    "about": null,
    "custom_status": null,
    "status": "offline",
    "role_id": 4,
    "totp_enabled": true,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

See [GET /api/v1/auth/me](#get-apiv1authme) for the full user-object field table.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Malformed request body |
| 401 | `UNAUTHORIZED` | Missing/expired challenge, invalid TOTP code, or challenge consumed |
| 500 | `SERVER_ERROR` | Session creation failure |

---

### GET /api/v1/auth/me

Get the current authenticated user's profile.

**Auth:** Required (Bearer token)

#### Response 200 OK

```json
{
  "id": 1,
  "username": "alex",
  "avatar": "/api/v1/files/uuid",
  "display_name": "Alex",
  "about": "A short bio.",
  "custom_status": "building things",
  "status": "online",
  "role_id": 2,
  "totp_enabled": true,
  "created_at": "2026-03-24T12:00:00Z"
}
```

This is the canonical **user object**, also returned as `user` by register,
login and the TOTP challenge.

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | User ID |
| `username` | string | Unique handle; the name `@mentions` resolve against |
| `avatar` | string | Avatar URL (`/api/v1/files/{id}` after an upload, or an `https://` URL), or empty string |
| `display_name` | string\|null | Nickname rendered instead of `username`; null when unset |
| `about` | string\|null | Profile bio, max 300 characters; null when unset |
| `custom_status` | string\|null | Free-text status line, max 128 characters; null when unset. Set over WebSocket (`presence_update`), not over REST |
| `status` | string | One of: `online`, `idle`, `dnd`, `invisible`, `offline`. **This is the caller's own true status**, so `invisible` appears here; every payload describing this user to *anyone else* reports `offline` instead |
| `role_id` | int64 | Numeric role ID (1=Owner, 2=Admin, 3=Moderator, 4=Member) |
| `totp_enabled` | bool | Whether the user has a confirmed TOTP secret |
| `created_at` | string | ISO 8601 timestamp |

---

### POST /api/v1/auth/logout

Invalidate the current session token.

**Auth:** Required (Bearer token)

#### Response 204 No Content

---

### DELETE /api/v1/auth/account

Permanently delete the authenticated user's account. Requires password confirmation.

**Auth:** Required (Bearer token)
**Rate limit:** 5 requests/minute per IP. After 3 failed password attempts, the endpoint locks out for 15 minutes per user.

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 204 No Content

Account deleted successfully. All sessions, messages (soft-deleted), and associated data are cleaned up.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing or incorrect password |
| 403 | `FORBIDDEN` | Cannot delete the last admin account |
| 429 | `RATE_LIMITED` | Locked out after 3 failed password attempts (15 min cooldown) |
| 500 | `SERVER_ERROR` | Database error during deletion |

---

### POST /api/v1/users/me/totp/enable

Start TOTP enrollment for the authenticated user. The secret is not persisted until `/api/v1/users/me/totp/confirm` succeeds.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 200 OK

```json
{
  "qr_uri": "otpauth://totp/OwnCord:alex?...",
  "backup_codes": []
}
```

---

### POST /api/v1/users/me/totp/confirm

Confirm a pending TOTP enrollment.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass",
  "code": "123456"
}
```

#### Response 204 No Content

---

### DELETE /api/v1/users/me/totp

Disable TOTP for the authenticated user.

**Auth:** Required
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 204 No Content

---

## User Profile & Sessions

### PATCH /api/v1/users/me

Update the authenticated user's profile. Broadcasts a `user_update` WebSocket
message to all clients on success, carrying the full profile snapshot (the
event replaces the client's copy rather than patching it).

**Auth:** Required
**Rate limit:** 10 requests/minute

#### Request

```json
{
  "username": "newname",
  "avatar": "https://example.com/pic.png",
  "display_name": "New Name",
  "about": "A short bio."
}
```

| Field          | Rules                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `username`     | Required. The unique handle; `@mentions` resolve against it.                                                                                                                               |
| `avatar`       | Optional. Must be an `https://` URL (max 512 chars) or `""` to clear. Upload a file instead with `POST /api/v1/users/me/avatar`.                                                           |
| `display_name` | Optional, 1–32 characters. Shown instead of `username` everywhere; `""` clears it and falls back to the username. Rejected if it contains control or invisible (bidi-override) characters. |
| `about`        | Optional, max 300 characters. `""` clears it.                                                                                                                                              |

Omitting a field leaves it unchanged; sending `""` clears the nullable ones.
`display_name` and `about` are HTML-sanitized and trimmed server-side, and the
length caps count characters, not bytes.

#### Response 200 OK

Returns the updated user object (same shape as `GET /api/v1/auth/me`).

---

### POST /api/v1/users/me/avatar

Upload an avatar image and point the authenticated user's avatar at it.
Broadcasts a `user_update` on success, exactly like the PATCH above.

The bytes are stored as an ordinary attachment with no channel, and
`users.avatar` is set to `/api/v1/files/{id}`. That URL is what makes the
picture readable: `GET /api/v1/files/{id}` normally serves an unlinked
attachment only to its uploader, and additionally admits one that some user's
avatar currently points at — so an avatar is readable by every authenticated
user for exactly as long as it is in use, and stops being readable the moment
it is replaced.

Not registered when the server has no working storage backend.

**Auth:** Required
**Rate limit:** 5 uploads/minute per user

#### Request

`multipart/form-data` with a single `file` part.

| Rule       | Value                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Type       | `image/png`, `image/jpeg` or `image/webp`, sniffed from the file's own bytes (the client's `Content-Type` is ignored) |
| Size       | 1 MiB                                                                                                                 |
| Dimensions | 1024x1024, measured from the sniffed image                                                                            |

GIF is refused (an animated avatar renders in every message row), and so is
SVG — it is markup with script and external-fetch capability, and an avatar is
rendered inline by definition. The server does not re-encode or crop; the
client is expected to downscale and square-crop before uploading.

#### Response 201 Created

```json
{
  "id": "5f2c...",
  "filename": "me.png",
  "size": 20481,
  "mime": "image/png",
  "url": "/api/v1/files/5f2c...",
  "width": 256,
  "height": 256
}
```

#### Errors

| Status | Code           | Cause                                                          |
| ------ | -------------- | -------------------------------------------------------------- |
| 400    | `BAD_REQUEST`  | Missing `file` part, wrong type, too large, or too many pixels |
| 429    | `RATE_LIMITED` | Too many uploads                                               |

---

### PUT /api/v1/users/me/password

Change the authenticated user's password. Verifies the old password, enforces
password strength, and revokes all *other* sessions on success.

**Auth:** Required
**Rate limit:** 5 requests/minute, plus a failed-confirmation lockout on
repeated wrong old passwords

#### Request

```json
{
  "old_password": "OldPass!1",
  "new_password": "NewStr0ng!Pass"
}
```

#### Response 204 No Content

Password changed and other sessions revoked. If the password change committed
but revoking other sessions failed, the endpoint returns **200 OK** with a
warning body instead (the new password is in effect — do not retry with the
old one).

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Weak new password, or new password equals old |
| 403 | `FORBIDDEN` | Incorrect old password |
| 429 | `RATE_LIMITED` | Too many attempts / lockout |

---

### GET /api/v1/users/me/sessions

List the authenticated user's active sessions.

**Auth:** Required

#### Response 200 OK

```json
{
  "sessions": [
    {
      "id": 12,
      "device": "Mozilla/5.0 ...",
      "ip": "192.168.1.100",
      "created_at": "2026-07-01T10:00:00Z",
      "last_used": "2026-07-19T09:00:00Z",
      "is_current": true
    }
  ]
}
```

---

### DELETE /api/v1/users/me/sessions/{id}

Revoke one of the authenticated user's sessions by ID.

**Auth:** Required

#### Response 204 No Content

---

## Channel Endpoints

### GET /api/v1/channels

List all channels the authenticated user has `READ_MESSAGES` permission for. DM channels are NOT included (use `GET /api/v1/dms` instead).

**Auth:** Required

#### Response 200 OK

```json
[
  {
    "id": 1,
    "name": "general",
    "type": "text",
    "topic": "Welcome to the server!",
    "category": "Text Channels",
    "position": 0,
    "slow_mode": 0,
    "archived": false,
    "nsfw": false,
    "voice_max_users": 0,
    "voice_max_video": 0
  }
]
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | Channel ID |
| `name` | string | Channel name |
| `type` | string | `text`, `voice`, or `announcement` (announcement channels are read like text but only `MANAGE_MESSAGES` holders can post) |
| `topic` | string | Channel topic/description |
| `category` | string | Category grouping |
| `position` | int | Sort order within category |
| `slow_mode` | int | Slow-mode delay in seconds (0 = disabled) |
| `archived` | bool | Whether the channel is archived |
| `nsfw` | bool | Age-restriction label. **Stored and shipped only** — the server applies no content behaviour to a flagged channel (see below) |
| `voice_max_users` | int | Voice capacity, 0 = unlimited. Enforced on join (`CHANNEL_FULL`) |
| `voice_max_video` | int | Simultaneous cameras/screen shares, 0 = unlimited. Enforced on publish (`VIDEO_LIMIT`) |

#### The `nsfw` flag

`nsfw` is metadata and nothing else. The server stores it, ships it in `ready`
and in the `channel_create` / `channel_update` broadcasts, and audits an
operator flipping it — and does **not** filter content, check anyone's age, or
restrict who may read or post in a flagged channel. Every consequence is the
client's: the desktop client shows a one-time-per-session "may contain
sensitive content" gate before rendering a flagged channel's messages
(remembered in `sessionStorage`, so a new session asks again) and marks the
channel in its sidebar. A client that ignores the field behaves exactly as it
did before the field existed.

---

### GET /api/v1/channels/{id}/messages

Paginated message history for a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (or DM participant membership)

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `before` | int64 | 0 (latest) | >= 0 | Cursor: return messages with ID less than this value |
| `limit` | int | 50 | 1-100 | Number of messages to return |

#### Response 200 OK

```json
{
  "messages": [
    {
      "id": 1042,
      "channel_id": 5,
      "user": {
        "id": 1,
        "username": "alex",
        "avatar": "uuid.png"
      },
      "content": "Hello!",
      "reply_to": null,
      "attachments": [
        {
          "id": "file-uuid",
          "filename": "photo.jpg",
          "size": 204800,
          "mime_type": "image/jpeg",
          "url": "/api/v1/files/file-uuid",
          "width": 1920,
          "height": 1080
        }
      ],
      "reactions": [
        {
          "emoji": "\ud83d\udc4d",
          "count": 2,
          "me": true
        }
      ],
      "pinned": false,
      "edited_at": null,
      "deleted": false,
      "timestamp": "2026-03-14T10:30:00Z",
      "mentions": [7],
      "mentions_everyone": false
    }
  ],
  "has_more": true
}
```

`mentions` is the server-resolved list of mentioned user IDs (always present,
empty when the message mentions nobody) and `mentions_everyone` reports an
`@everyone`/`@here` that cleared the `MENTION_EVERYONE` permission. Both are
resolved at send time and re-resolved on edit; an `@word` that matches no
username, or an `@everyone` from a user without the bit, carries no mention
semantics and stays plain text. The same two fields appear on pinned-message
responses and on the WebSocket `chat_message`/`chat_edited` payloads.

#### Pagination

Use cursor-based pagination by passing the `id` of the last message as the `before` parameter:

```
GET /api/v1/channels/5/messages?before=1042&limit=50
```

When `has_more` is `false`, you have reached the beginning of the channel history.

---

### GET /api/v1/channels/{id}/messages/around/{messageId}

The window of channel history centred on one message, for jumping to a message
that is not in the client's loaded page — a search hit, a pinned entry, a reply
reference, or an `owncord://message/{channelId}/{messageId}` permalink.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (or DM participant membership) — the same gate as `GET /messages`

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `limit` | int | 50 | 1-100 | Total window size, centre included |

Half the window sits before the centre and the remainder after it: `limit=50`
returns up to 25 older messages, the centre, and up to 24 newer ones. Near the
start or end of a channel the window is simply shorter — it is not re-balanced
toward the other side.

#### Response 200 OK

```json
{
  "messages": [],
  "has_more_before": true,
  "has_more_after": true
}
```

`messages` holds the same message objects as `GET /messages` (user, attachments,
reactions with the `me` flag, `mentions`, `mentions_everyone`), but is ordered
**oldest-first**, not newest-first like the paginated history endpoint.

`has_more_before` / `has_more_after` report whether the channel holds further
live history on each side of the returned window. A client that renders an
around-window is *detached* from the live tail while `has_more_after` is true:
newly broadcast messages belong below the window and are not part of it, so the
client should offer a "jump to present" affordance that refetches the normal
`GET /messages` tail.

#### Errors

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | `id` or `messageId` is not a positive integer, or `limit` is not a positive integer |
| 403 | `FORBIDDEN` | The channel exists but `READ_MESSAGES` is denied |
| 404 | `NOT_FOUND` | The channel does not exist, the caller is not a participant of the DM, or the message does not live in this channel |

Soft-deleted messages are 404 here, not an empty window: history omits deleted
rows, so there is no row to centre on. Deleted messages are also excluded from
the window itself, exactly as in `GET /messages`.

---

### POST /api/v1/channels/{id}/messages/purge

Bulk soft-delete the newest messages in a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` **and** `MANAGE_MESSAGES` on the channel (per-channel overrides apply)

Not available in DM channels — a DM has no `MANAGE_MESSAGES` gate, so those
requests are rejected with 403.

#### Request Body

```json
{
  "limit": 50,
  "before": 1042
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | integer | Yes | How many messages to delete, 1--100. Values above 100 are clamped; 0 or negative is a 400. |
| `before` | integer | No | Only delete messages with an id below this one. Omit or `0` to start from the newest. |

#### Response 200 OK

```json
{
  "channel_id": 5,
  "ids": [1042, 1041, 1040],
  "count": 3
}
```

`ids` is newest-first and may hold fewer than `limit` entries when the channel
has less history; already-deleted messages are skipped. Deletion is soft: the
rows stay as tombstones, exactly as with a single delete. A single
[`chat_bulk_deleted`](protocol.md#chat_bulk_deleted-server---client-broadcast)
WebSocket event is broadcast to the channel (not one `chat_deleted` per
message), and one `message_purge` audit entry is written.

Rate limited to 5/sec per user.

---

### GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users

List the users who reacted to a message with a specific emoji — the "who
reacted" tooltip behind a reaction pill.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel (DM: participant)

The reactor list is a separate endpoint rather than `user_ids` inline on every
reaction summary, so message payloads stay small: a busy channel carries dozens
of pills per page and almost none of them are ever hovered.

`{emoji}` is a path segment and must be percent-encoded (`👍` → `%F0%9F%91%8D`).
The message must belong to `{id}`; a message in another channel is a 404, so the
channel in the URL is always the one the permission check ran against.

#### Response 200 OK

```json
{
  "users": [
    { "id": 3, "username": "alice", "avatar": "" },
    { "id": 7, "username": "bob", "avatar": "/api/v1/files/abc123" }
  ]
}
```

Ordered oldest reaction first and capped at **100** reactors — the list is for a
tooltip, not an audit. `users` is always an array (`[]` when nobody used that
emoji, which is also the answer for an emoji that does not exist). `avatar` is
`""` when the user has none.

| Status | Error | When |
|--------|-------|------|
| 400 | `BAD_REQUEST` | Non-positive `id`/`messageId`, or an empty / over-32-rune / control-character emoji |
| 403 | `FORBIDDEN` | No `READ_MESSAGES` on the channel |
| 404 | `NOT_FOUND` | Channel or message not found, the message lives in another channel, or a DM the caller is not in |

---

### GET /api/v1/channels/{id}/pins

Get all pinned messages for a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel

#### Response 200 OK

Returns `{ "messages": [...], "has_more": false }`. `has_more` is always `false` for pins (all pinned messages are returned at once).

---

### POST /api/v1/channels/{id}/pins/{messageId}

Pin a message in a channel.

**Auth:** Required
**Permission:** `MANAGE_MESSAGES` on the channel

#### Response 204 No Content

---

### DELETE /api/v1/channels/{id}/pins/{messageId}

Unpin a message from a channel.

**Auth:** Required
**Permission:** `MANAGE_MESSAGES` on the channel

#### Response 204 No Content

---

## Search

### GET /api/v1/search

Full-text search across messages in channels the user can read. Uses SQLite FTS5 for matching.

**Auth:** Required
**Rate limit:** 30 requests/minute

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `q` | string | (required) | non-empty | Search query (FTS5 syntax) |
| `channel_id` | int64 | (all channels) | > 0 | Restrict search to a single channel |
| `limit` | int | 50 | 1-100 | Maximum results to return |

#### Response 200 OK

```json
{
  "results": [
    {
      "message_id": 1042,
      "channel_id": 5,
      "channel_name": "general",
      "user": {
        "id": 1,
        "username": "alex"
      },
      "content": "...matched text...",
      "timestamp": "2026-03-14T10:30:00Z",
      "mentions": [7],
      "mentions_everyone": false
    }
  ]
}
```

---

## GIFs

The server proxies the Klipy GIF API so the provider API key stays server-side.
Clients never contact `api.klipy.com` — a key shipped in the desktop bundle
would be public by construction. The key is configured as `gif.api_key`
(see [Server Configuration](server-configuration.md#gif-picker-gif)).

**Default-off contract:** with no key configured, both endpoints return
`503` with error code `GIF_DISABLED`. Clients must treat that as "this server
does not have GIFs" and hide/disable the GIF affordance — not retry.

The media URLs in the response point at Klipy's CDN; the client still validates
them against its `klipy.com` CDN allowlist before rendering.

### GET /api/v1/gif/search

**Auth:** Required
**Rate limit:** 30 requests/minute (dedicated per-IP bucket)

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `q` | string | (required) | 1-100 chars | Search term |
| `limit` | int | 20 | 1-50 | Maximum results to return |

#### Response 200 OK

```json
{
  "results": [
    {
      "id": "abc123",
      "title": "happy cat",
      "media_formats": {
        "tinygif": { "url": "https://media.klipy.com/abc123_tiny.gif" },
        "gif": { "url": "https://media.klipy.com/abc123.gif" }
      }
    }
  ]
}
```

Only `id`, `title`, and the two `media_formats` URLs are forwarded. Every other
field the upstream returns is dropped, so an upstream that echoed the API key
could not leak it to clients. Results missing either format are omitted.

#### Errors

| Status | Code | When |
| ------ | ---- | ---- |
| 400 | `INVALID_INPUT` | Missing/blank `q`, `q` over 100 chars, or `limit` outside 1-50 |
| 401 | `UNAUTHORIZED` | No valid session (checked before the disabled check) |
| 429 | `RATE_LIMITED` | Over 30 requests/minute |
| 502 | `BAD_GATEWAY` | Upstream error, timeout, or unparseable response |
| 503 | `GIF_DISABLED` | `gif.api_key` is not configured |

### GET /api/v1/gif/trending

Same auth, rate limit, response shape, and error codes as
`/api/v1/gif/search`, minus the `q` parameter.

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `limit` | int | 20 | 1-50 | Maximum results to return |

---

## Direct Messages

DM channels use participant-based authorization rather than role-based permissions.

### POST /api/v1/dms

Create or retrieve a 1-on-1 DM channel with another user. If a DM channel already exists, it is returned and re-opened.

**Auth:** Required

#### Request

```json
{
  "recipient_id": 2
}
```

#### Response 200 OK (existing channel) or 201 Created (new channel)

```json
{
  "channel_id": 100,
  "recipient": {
    "id": 2,
    "username": "jordan",
    "avatar": "uuid.png",
    "status": "online"
  },
  "created": false
}
```

---

### GET /api/v1/dms

List all open DM channels for the authenticated user, ordered by most recent activity.

**Auth:** Required

#### Response 200 OK

```json
{
  "dm_channels": [
    {
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
      "last_message_id": 5042,
      "last_message": "Hey, how's it going?",
      "last_message_at": "2026-03-28T14:30:00Z",
      "unread_count": 3
    }
  ]
}
```

| Field        | Description                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `recipient`  | The other participant of a 1:1 DM. **Backward compatibility only** — for a group it carries the first of `recipients`. |
| `recipients` | Every participant except the caller. What group-aware clients read.                                                    |
| `name`       | Optional group name; `""` for a 1:1 DM and for an unnamed group.                                                       |
| `is_group`   | True for a group DM. Stored, not derived from the live participant count.                                              |

`status` is viewer-adjusted: an `invisible` participant reads as `offline`.

---

### POST /api/v1/dms/group

Create a group DM between the caller and 2–8 other users (3–10 total).

Unlike `POST /api/v1/dms` this **always creates**: the same set of people may
reasonably want more than one group, so there is no "the group for these users"
to look up.

Blocks are enforced in both directions, per recipient — a user may neither pull
someone they have blocked into a room with them nor use a group to reach
someone who has blocked them. The check is creation-time only; see
`docs/protocol.md` § DM Authorization for why sending into a group is not
block-checked.

**Auth:** Required

#### Request

```json
{
  "recipient_ids": [2, 3],
  "name": "Lunch crew"
}
```

| Field           | Type   | Required | Description                                                                     |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------- |
| `recipient_ids` | int[]  | Yes      | 2–8 other users. De-duplicated; the caller is dropped if named.                 |
| `name`          | string | No       | Group name, ≤ 100 characters. HTML-stripped. Omit or `""` for an unnamed group. |

#### Response 201 Created

The same DM summary shape `GET /api/v1/dms` returns, from the creator's seat.
Every participant — the creator included — also receives a `dm_channel_open`.

#### Errors

| Status | Code          | Reason                                                                |
| ------ | ------------- | --------------------------------------------------------------------- |
| 400    | `BAD_REQUEST` | Fewer than 2 or more than 8 recipients, or a name over 100 characters |
| 403    | `FORBIDDEN`   | A recipient is blocked by, or has blocked, the caller                 |
| 404    | `NOT_FOUND`   | A recipient does not exist                                            |

---

### PATCH /api/v1/dms/{channelId}

Set or clear a group DM's name.

Any participant may rename it. That is Discord's rule and the only one that
works here: a group DM has no owner column and no roles, so "who may rename" has
exactly one answer that does not require inventing an ownership model. A 1:1 DM
refuses — its name is who is in it.

**Auth:** Required (participant)

#### Request

```json
{ "name": "Lunch crew" }
```

An empty name clears it, and the group falls back to listing its members.

#### Response 200 OK

The DM summary shape, from the caller's seat. Every participant also receives a
`dm_channel_open` carrying the new name.

#### Errors

| Status | Code          | Reason                                                      |
| ------ | ------------- | ----------------------------------------------------------- |
| 400    | `BAD_REQUEST` | The channel is a 1:1 DM, or the name exceeds 100 characters |
| 404    | `NOT_FOUND`   | Not a participant of this DM                                |

---

### DELETE /api/v1/dms/{channelId}

Remove a DM from the caller's sidebar. What that means depends on the kind of DM,
and the route is shared because the _gesture_ is shared:

- **1:1 DM** — a hide. The channel and messages remain, the caller remains a
  participant, and a new message from either side re-opens it.
- **Group DM** — a **leave**. The caller comes out of `dm_participants`, stops
  receiving the group's messages, and cannot return unaided. When the last
  participant leaves, the channel row is deleted (a DM nobody is in is reachable
  by nobody, and its messages cascade off the channel).

The caller receives `dm_channel_close`; after a group leave the remaining
participants receive a fresh `dm_channel_open` with the new membership.

**Auth:** Required (participant)

#### Response 204 No Content

#### Errors

| Status | Code        | Reason                       |
| ------ | ----------- | ---------------------------- |
| 404    | `NOT_FOUND` | Not a participant of this DM |

---

## User Blocks

Blocking a user prevents DM creation and messaging in both directions
(backed by the `user_blocks` table).

### GET /api/v1/blocks

List the IDs of users the authenticated user has blocked.

**Auth:** Required

#### Response 200 OK

```json
{ "blocked_user_ids": [2, 7] }
```

---

### PUT /api/v1/blocks/{userId}

Block a user.

**Auth:** Required

#### Response 200 OK

```json
{ "message": "user blocked" }
```

---

### DELETE /api/v1/blocks/{userId}

Unblock a user.

**Auth:** Required

---

## Invite Endpoints

All invite endpoints require authentication and the `MANAGE_INVITES` permission.

### POST /api/v1/invites

Create a new invite code.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Request

```json
{
  "max_uses": 5,
  "expires_in_hours": 48
}
```

Both fields are optional. An empty body creates an invite with unlimited uses and no expiry.

#### Response 201 Created

```json
{
  "id": 1,
  "code": "abc123def",
  "max_uses": 5,
  "uses": 0,
  "expires_at": "2026-03-30T10:30:00Z",
  "revoked": false,
  "created_at": "2026-03-28T10:30:00Z"
}
```

---

### GET /api/v1/invites

List all invites (active, expired, and revoked).

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 200 OK

Returns a JSON array of invite objects.

---

### DELETE /api/v1/invites/{code}

Revoke an invite by its code string.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 204 No Content

---

## File Upload and Serving

### POST /api/v1/uploads

Upload a file as multipart form data.

**Auth:** Required
**Rate limit:** 10 requests/minute
**Body size limit:** 100 MiB
**Content-Type:** `multipart/form-data`

Files are validated against blocked magic bytes (PE executables, ELF binaries, Mach-O binaries, shell scripts). Files are stored with UUID filenames.

#### Response 201 Created

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "filename": "photo.jpg",
  "size": 204800,
  "mime": "image/jpeg",
  "url": "/api/v1/files/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "width": 1920,
  "height": 1080
}
```

`width` and `height` are only present for image files.

---

### GET /api/v1/files/{id}

Serve a previously uploaded file by its UUID.

**Auth:** Required (Bearer token) — downloads are access-controlled
**Caching:** `Cache-Control: private, no-cache` (never stored by shared/proxy caches; browsers must revalidate)

Supports HTTP range requests and conditional requests. MIME types that could
execute under the app origin (HTML, SVG, XML, PDF) are served with
`Content-Disposition: attachment` to force download.

---

## Custom Emoji

Server-wide custom emoji, usable as `:shortcode:` in message content and as
reaction strings.

**Permission model.** Reading the set is open to any authenticated member —
an emoji nobody can render is not an emoji, and the set is server-wide with no
per-channel scope to leak. Adding and removing require **MANAGE_SERVER**.

That is a deliberate reuse rather than a new permission bit: a bit is a
schema-visible, forever decision, and "who may change server-wide branding" is
exactly what MANAGE_SERVER already answers for the server name, icon and
settings. There is no `MANAGE_EMOJI`.

### GET /api/v1/emoji

List every custom emoji, ordered by shortcode.

**Auth:** Required

#### Response 200 OK

```json
[
  { "id": 3, "shortcode": "wave", "url": "/api/v1/emoji/3/image" },
  { "id": 7, "shortcode": "party_blob", "url": "/api/v1/emoji/7/image" }
]
```

`url` is server-relative and authenticated — see GET /api/v1/emoji/{id}/image.

---

### POST /api/v1/emoji

Upload one custom emoji as multipart form data.

**Auth:** Required — **MANAGE_SERVER**
**Rate limit:** 10 requests/minute per user
**Body size limit:** 1 MiB (the image itself is capped at 512 KiB)
**Content-Type:** `multipart/form-data`

| Field       | Type   | Notes                                                                                                                                           |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `shortcode` | string | `[a-z0-9_]{2,32}`; surrounding colons are stripped and the value is lowercased before validation, so `:WAVE:` and `wave` are the same shortcode |
| `file`      | file   | PNG, JPEG, GIF or WebP                                                                                                                          |

Validation, in the order it is applied — the permission check runs before the
multipart body is read, so a member without the bit never causes a spool to
disk:

1. MANAGE_SERVER, then the rate limit, then the shortcode format.
2. At most **512 KiB** of image bytes.
3. The MIME type is **sniffed from the file's own bytes**, never taken from the
   client's part header. Only `image/png`, `image/jpeg`, `image/gif` and
   `image/webp` are accepted. SVG is refused outright: it is markup with script
   and external-fetch capability, and an emoji is by definition rendered inline.
4. Dimensions are re-read from the sniffed image (WebP headers are parsed
   directly, since the standard library has no WebP decoder) and must be at
   most **128 x 128**.
5. Shortcodes are unique case-insensitively; a collision is `409 CONFLICT`.
6. A server holds at most 200 emoji.

On success the full set is broadcast as `emoji_update` (see protocol.md), so
every connected client converges without a reconnect.

#### Response 201 Created

```json
{ "id": 3, "shortcode": "wave", "url": "/api/v1/emoji/3/image" }
```

#### Errors

| Status | Code           | Cause                                           |
| ------ | -------------- | ----------------------------------------------- |
| 400    | `BAD_REQUEST`  | bad shortcode, wrong format, too large, too big |
| 403    | `FORBIDDEN`    | caller lacks MANAGE_SERVER                      |
| 409    | `CONFLICT`     | an emoji with that shortcode already exists     |
| 429    | `RATE_LIMITED` | upload rate limit exceeded                      |

---

### GET /api/v1/emoji/{id}/image

Serve one emoji's image bytes.

**Auth:** Required (Bearer token)
**Caching:** `Cache-Control: private, max-age=86400, immutable`

Authenticated rather than public so an emoji cannot be used as an
unauthenticated tracking pixel hosted on someone else's server. There is no
per-channel ACL to apply — emoji are server-wide by construction, so
authentication is the whole check. An emoji's bytes never change for a given
id (a replacement is a new row), which is what lets the response be cached
hard. Unknown ids answer 404.

---

### DELETE /api/v1/emoji/{id}

Delete one custom emoji and unlink its stored file.

**Auth:** Required — **MANAGE_SERVER**

Messages and reactions that used the shortcode fall back to rendering the
literal `:shortcode:` text. Broadcasts `emoji_update` on success.

#### Response 204 No Content

#### Errors

| Status | Code          | Cause                        |
| ------ | ------------- | ---------------------------- |
| 400    | `BAD_REQUEST` | id is not a positive integer |
| 403    | `FORBIDDEN`   | caller lacks MANAGE_SERVER   |
| 404    | `NOT_FOUND`   | no emoji with that id        |

---

## Health Check

### GET /health

### GET /api/v1/health

Public health check endpoint, no authentication required. The server version
is deliberately not exposed here (anti-fingerprinting hardening, C-2).

```json
{
  "status": "ok",
  "uptime": 86400,
  "online_users": 3
}
```

---

## Server Info

### GET /api/v1/info

Returns the server name. The version field was removed from this
unauthenticated endpoint (anti-fingerprinting hardening, C-2).

**Auth:** None

```json
{
  "name": "My OwnCord Server"
}
```

---

## Metrics

### GET /api/v1/metrics

Runtime server metrics. Restricted to admin-allowed CIDRs.

**Auth:** Admin IP restriction (not token-based)

```json
{
  "uptime": "2h30m15s",
  "uptime_seconds": 9015.0,
  "goroutines": 42,
  "heap_alloc_mb": 12.5,
  "heap_sys_mb": 24.0,
  "num_gc": 156,
  "connected_users": 8,
  "voice_sessions": 2,
  "broadcast_drops": 0,
  "livekit_healthy": true,
  "reconnect_tier_buffer": 120,
  "reconnect_tier_db": 4,
  "reconnect_tier_full": 1,
  "backpressure_queue_disconnects": 0,
  "backpressure_high_fallbacks": 0,
  "backpressure_low_drops": 17,
  "db_writer_wait_count": 3,
  "db_writer_wait_seconds": 0.021,
  "perm_cache_hits": 5120,
  "perm_cache_misses": 84,
  "event_persister": {
    "persisted": 4021,
    "dropped": 0,
    "flushes": 311,
    "errors": 0
  }
}
```

`voice_sessions` is the number of active voice connections. `broadcast_drops`
is the cumulative count of events dropped because the **hub-wide broadcast
queue** was full — sequenced events lost before delivery, worth alerting on
if it ever grows. Per-client send-queue pressure is reported separately:
`backpressure_queue_disconnects` (clients disconnected to force a
replay-recovering reconnect), `backpressure_high_fallbacks` (high-priority
sends that fell back to the normal queue), and `backpressure_low_drops`
(typing/presence messages silently dropped — safe to lose, but a growth trend
means clients are draining too slowly). `reconnect_tier_*` counts resume
attempts served from the in-memory ring buffer, the persisted event log, and
full-resync fallback; a rising `full` share means the replay budget is too
small for observed disconnect gaps. `db_writer_wait_count`/`_seconds`
accumulate time requests spent queueing for SQLite's single write connection —
the most direct saturation signal for the write path. `perm_cache_*` report
permission-cache effectiveness (a miss is any lookup that repopulated from the
database). `livekit_healthy` is omitted when no LiveKit health check is wired;
`event_persister` is omitted when event persistence is disabled.

### GET /metrics (Prometheus)

A Prometheus text-format exporter is mounted at `/metrics` **only** when the
server was built with `-tags otel` and `telemetry.exporter` is set to
`prometheus`. It is admin-IP-restricted like the JSON endpoint. In the default
build the route does not exist (404).

---

## Admin API Authorization

The admin panel API lives under `/admin/api` (not `/api/v1`) and takes the same
`Authorization: Bearer {token}` header — a login session or an API token, which
inherits its owning user's role.

Authorization is two-layered:

1. **Perimeter.** The request is rejected with `403 FORBIDDEN` unless the
   principal's role holds at least one bit of `permissions.AdminPerimeter`
   (`ADMINISTRATOR`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_SERVER`,
   `VIEW_AUDIT_LOG`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MUTE_MEMBERS`). Banned
   users are rejected here even while their session is still valid.
2. **Per-route bit.** Route groups then require the specific permission below.
   `ADMINISTRATOR` bypasses every one of them; owner-only routes gate on role
   *position* (`>= 100`) instead of on a bit, so not even `ADMINISTRATOR`
   substitutes for being the owner.

| Route | Requires |
| ----- | -------- |
| `GET /admin/api/me` | perimeter only |
| `GET /admin/api/stats` | perimeter only |
| `GET /admin/api/users` | perimeter only |
| `PATCH /admin/api/users/{id}` | perimeter; `BAN_MEMBERS` for `banned`, `MANAGE_ROLES` for `role_id` (checked in the service) |
| `DELETE /admin/api/users/{id}/sessions` | `KICK_MEMBERS` |
| `GET/POST/PATCH/DELETE /admin/api/channels…` (incl. `/permissions` and `/user-permissions`) | `MANAGE_CHANNELS` |
| `GET/POST/PATCH/DELETE /admin/api/roles…` (incl. `/roles/reorder`) | `MANAGE_ROLES` |
| `GET /admin/api/audit-log` | `VIEW_AUDIT_LOG` |
| `GET/PATCH /admin/api/settings` | `MANAGE_SERVER` |
| `POST /admin/api/logs/ticket`, `GET /admin/api/logs/stream` | `ADMINISTRATOR` |
| `/api/v1/admin/plugins…` | `ADMINISTRATOR` |
| `/admin/api/tokens…`, `/admin/api/backup(s)…`, `/admin/api/updates…` | Owner role (position 100) |

Moderation routes additionally enforce the **role hierarchy**: the actor must
strictly outrank the target (`actor.position > target.position`), and a role
assignment may only grant a role positioned strictly below the actor's own —
so an admin cannot promote anyone to Owner, and a moderator cannot demote an
admin. Violations return `403 FORBIDDEN`.

### GET /admin/api/me

Describes the calling principal so a panel can hide what the role cannot use.
Every route still re-checks its bit server-side.

#### Response 200 OK

```json
{
  "id": 7,
  "username": "mod",
  "role_id": 3,
  "role_name": "Moderator",
  "role_position": 60,
  "permissions": 1048575,
  "is_owner": false
}
```

---

## First-Run Setup

### GET /admin/api/setup/status

Reports whether initial setup is needed (no users exist yet).

**Auth:** None (public). After the first user exists, the response reveals
nothing about the configuration.

#### Response 200 OK

```json
{
  "needs_setup": true,
  "defaults": {
    "server_name": "OwnCord",
    "motd": "Welcome!",
    "registration_open": false,
    "port": 8443,
    "tls_mode": "self-signed",
    "tls_domain": "",
    "upload_max_size_mb": 100,
    "voice_quality": "medium",
    "voice_auto_download": true
  }
}
```

`defaults` (wizard prefill from the running config and settings table) is
present only while `needs_setup` is `true`.

---

### POST /admin/api/setup

Create the first (Owner) account, optionally applying first-run wizard
configuration. Only functional while no users exist; afterwards it returns an
error.

**Auth:** None (public)
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "username": "owner",
  "password": "MyStr0ng!Pass",
  "wizard": {
    "server_name": "My Server",
    "motd": "Welcome!",
    "registration_open": false,
    "port": 8443,
    "tls_mode": "self-signed",
    "tls_domain": "",
    "upload_max_size_mb": 100,
    "voice_quality": "medium",
    "voice_auto_download": true
  }
}
```

All `wizard` fields are optional; `server_name`, `motd` and
`registration_open` are stored in the settings table (live), the rest are
written back to `config.yaml` (consumed at startup).

#### Response 200 OK

```json
{
  "token": "raw-session-token",
  "user_id": 1,
  "username": "owner",
  "invite_code": "abc123def",
  "restart_required": false,
  "restart_url": "",
  "warnings": []
}
```

`restart_required` is `true` when wizard values that are only read at startup
(port, TLS) differ from the running config; the server restarts itself right
after responding, and `restart_url` is where the admin panel will be reachable
afterwards. `warnings` lists non-fatal problems (e.g. `config.yaml` not
writable) — the account exists whenever this response is returned.

---

## Server Stats & User Administration

### GET /admin/api/stats

Aggregate counts for the admin dashboard.

**Auth:** Admin perimeter

#### Response 200 OK

```json
{
  "user_count": 12,
  "message_count": 4821,
  "channel_count": 9,
  "invite_count": 2,
  "db_size_bytes": 1048576,
  "online_count": 3
}
```

---

### GET /admin/api/users

List all users with role and ban state.

**Auth:** Admin perimeter
**Query params:** `limit` (default 50, min 1), `offset` (default 0)

#### Response 200 OK

Array of:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | int | |
| `username` | string | |
| `avatar` | string? | omitted when unset |
| `role_id` | int | |
| `role_name` | string | |
| `status` | string | presence status |
| `created_at` | string | |
| `last_seen` | string? | omitted when never seen |
| `banned` | bool | |
| `ban_reason` | string? | omitted when unset |
| `ban_expires` | string? | omitted for permanent bans |

Password hashes and TOTP secrets are never included.

---

### PATCH /admin/api/users/{id}

Change a user's role and/or ban state. Both actions route through the
moderation service, which enforces the required bit (`MANAGE_ROLES` for
`role_id`, `BAN_MEMBERS` for `banned`), the role hierarchy, and writes the
audit row.

**Auth:** Admin perimeter + per-action bit (see above)

#### Request

```json
{
  "role_id": 3,
  "banned": true,
  "ban_reason": "spam",
  "ban_duration_hours": 24
}
```

All fields optional. `ban_duration_hours` makes the ban temporary (1–8760;
omitted or `0` = permanent) and is only meaningful with `banned: true`.

#### Response 200 OK -- the updated user (same shape as the list entry).

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid id/body, `ban_duration_hours` out of range, or attempting to modify your own account |
| 403 | `FORBIDDEN` | Missing bit, or the actor does not outrank the target |
| 404 | `NOT_FOUND` | User not found |

---

### DELETE /admin/api/users/{id}/sessions

Force-logout: revoke every session of the target user. The hierarchy rule
(actor outranks target) is enforced in the moderation service and the action
is audited.

**Auth:** `KICK_MEMBERS`

#### Response 204 No Content

---

## Audit Log

### GET /admin/api/audit-log

Read the audit trail, newest first.

**Auth:** `VIEW_AUDIT_LOG`
**Query params:** `limit` (default 50, min 1), `offset` (default 0)

#### Response 200 OK

Array of:

```json
{
  "id": 991,
  "actor_id": 1,
  "actor_name": "owner",
  "action": "user_ban",
  "target_type": "user",
  "target_id": 7,
  "detail": "spam",
  "created_at": "2026-08-04T12:00:00Z"
}
```

---

## Server Settings

### GET /admin/api/settings

**Auth:** `MANAGE_SERVER`

Returns the settings table as a flat string map, e.g.:

```json
{
  "server_name": "My Server",
  "motd": "Welcome!",
  "registration_open": "1",
  "require_2fa": "0"
}
```

---

### PATCH /admin/api/settings

Update settings. Keys are validated against a whitelist before anything is
written, and all updates are applied in one transaction; each change is
audited as `setting_change`.

**Auth:** `MANAGE_SERVER`

#### Request

A flat map of key → string value. Allowed keys: `server_name`, `server_icon`,
`motd`, `max_upload_bytes`, `voice_quality`, `require_2fa`,
`registration_open`, `backup_schedule`, `backup_retention`. Boolean settings
accept `1/0/true/false` and are normalized to `1`/`0`.

`backup_schedule` (`off`/`daily`/`weekly`) and `backup_retention` (days) are
enforced by the server's maintenance loop — see the Backup Strategy section
of `docs/deployment.md` for the exact semantics.

Enabling `require_2fa` is refused unless registration is closed **and** every
user has TOTP enabled.

#### Response 200 OK -- the full settings map after the update.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Unknown key, invalid boolean, or `require_2fa` preconditions not met |

---

## API Tokens

Owner-only: minting a long-lived bearer credential over the network is the one
admin action that, via a hijacked session, would outlive a password change and
bulk logout (API tokens deliberately live outside the session table). These
routes are the HTTP equivalent of the `server token create|list|revoke` CLI.

### GET /admin/api/tokens

**Auth:** Owner role

#### Response 200 OK

Array of:

```json
{
  "id": 1,
  "user_id": 1,
  "username": "owner",
  "label": "ci-bot",
  "created_at": "2026-08-01T10:00:00Z",
  "last_used": null,
  "expires_at": null,
  "revoked_at": null
}
```

Token hashes are never returned.

---

### POST /admin/api/tokens

**Auth:** Owner role

#### Request

```json
{
  "label": "ci-bot",
  "username": "",
  "expires_hours": 0
}
```

`label` is required. Empty `username` binds the token to the owner account;
`expires_hours: 0` means never expires.

#### Response 201 Created

```json
{
  "id": 2,
  "token": "raw-api-token",
  "label": "ci-bot",
  "user": "owner"
}
```

The raw token is shown exactly once and is never recoverable.

---

### DELETE /admin/api/tokens/{id}

**Auth:** Owner role

#### Response 204 No Content

`404 NOT_FOUND` if there is no *active* token with that id.

---

## Backups

All backup routes are Owner-only. Backups are SQLite snapshots (`VACUUM INTO`)
stored under `data/backups/`.

### POST /admin/api/backup

Create a backup named `chatserver_<UTC timestamp>.db`.

**Auth:** Owner role

#### Response 200 OK

```json
{
  "path": "chatserver_20260804_120000.db",
  "created": "20260804_120000"
}
```

---

### GET /admin/api/backups

List backups, newest first.

**Auth:** Owner role

#### Response 200 OK

```json
[{ "name": "chatserver_20260804_120000.db", "size": 1048576, "date": "2026-08-04T12:00:00Z" }]
```

---

### DELETE /admin/api/backups/{name}

**Auth:** Owner role

`name` is validated against path traversal. Returns `204 No Content`, or
`404 NOT_FOUND` if the file does not exist.

---

### POST /admin/api/backups/{name}/restore

Restore the database from a backup. The server first writes a
`pre_restore_<timestamp>.db` safety backup (the restore is aborted if that
fails), broadcasts a `server_restart` to connected clients, checkpoints and
closes the database, copies the backup over it, responds, and then restarts
itself.

**Auth:** Owner role

#### Response 200 OK

```json
{
  "message": "database restored — server restarting",
  "backup": "chatserver_20260804_120000.db"
}
```

---

## Server Updates

Owner-only self-update from GitHub Releases (minisign/Ed25519-verified; see
`docs/security.md`).

### GET /admin/api/updates

**Auth:** Owner role

#### Response 200 OK

```json
{
  "current": "v1.2.0-alpha.2",
  "latest": "v1.2.0",
  "update_available": true,
  "required_assets_present": true,
  "release_url": "…",
  "download_url": "…",
  "checksum_url": "…",
  "signature_url": "…",
  "manifest_url": "…",
  "manifest_signature_url": "…",
  "release_notes": "…",
  "can_apply": true
}
```

`can_apply` is `false` in container deployments (detected via
`OWNCORD_CONTAINER`, which the shipped Dockerfile sets, or the engine marker
files): checking still works, but `POST /updates/apply` will refuse — the
admin SPA replaces the apply button with an image-upgrade note.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 503 | `UPDATE_UNAVAILABLE` | Update checking is not configured |
| 502 | `UPDATE_CHECK_FAILED` | GitHub API failure |

---

### POST /admin/api/updates/apply

Download, verify and apply the latest release. On success the server responds
first, then broadcasts a restart notice, swaps the binary (with staged-hash
re-verification against TOCTOU swaps), spawns the new process and shuts down.

**Auth:** Owner role

#### Response 200 OK

```json
{ "status": "applying", "version": "v1.2.0" }
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 503 | `CONTAINER_DEPLOYMENT` | Container deployment — the binary is image content; upgrade by pulling the new image (opt back in with `OWNCORD_CONTAINER=0` if the binary is bind-mounted) |
| 503 | `UPDATE_UNAVAILABLE` | Update checking is not configured |
| 409 | `NO_UPDATE` | Already up to date |
| 502 | `UPDATE_CHECK_FAILED` / `MISSING_ASSETS` / `DOWNLOAD_FAILED` | Check, asset or download/verification failure |

---

## Server Logs (SSE)

Streaming the server log requires two steps because `EventSource` cannot send
an `Authorization` header.

### POST /admin/api/logs/ticket

Issue a single-use ticket (30 s TTL) bound to the calling bearer credential.

**Auth:** `ADMINISTRATOR`

#### Response 200 OK

```json
{ "ticket": "64-hex-chars" }
```

---

### GET /admin/api/logs/stream?ticket={ticket}

Server-Sent Events stream of structured log records: on connect the in-memory
ring buffer (capacity 2000) is replayed as backfill, then new entries stream
live, with a keepalive every 15 s. The ticket is consumed on connect; the
`ADMINISTRATOR` bit is re-checked throughout the stream, and revoking the
underlying session or API token (or banning the user) mid-stream cuts it.

**Auth:** single-use ticket (from `POST /admin/api/logs/ticket`)

Each event's data is one JSON record:

```json
{ "ts": "2026-08-04T12:00:00Z", "level": "INFO", "msg": "…", "source": "…", "attrs": "…" }
```

---

## Role Management

Create, edit, delete and reorder roles. The whole group requires
`MANAGE_ROLES`; `RoleService` then enforces the hierarchy rules below, so a
principal that clears the bit still cannot escalate through it.

**Rules, all measured against the *actor's* role position:**

- You may only create, edit, delete or reorder roles positioned **strictly
  below** your own. Equal rank is refused too, so a role cannot rewrite itself.
  Nothing sits above position 100, which makes the seeded Owner role
  immutable and undeletable for everyone, owner included.
- You may never **grant** a permission bit your own role lacks. Removing one is
  allowed — de-escalation is always safe. `ADMINISTRATOR` bypasses this check
  entirely (it is what lets the owner hand out anything).
- The default role (`is_default = 1`) cannot be deleted: every member falls
  back to it.
- Deleting a role moves its members onto the default role in one `UPDATE`,
  drops the role's `channel_overrides` rows, invalidates the moved members'
  cached permissions, and broadcasts a `member_update` per member.
- Names are unique **case-insensitively** (migration `023`), matching the
  case-insensitive lookup the desktop client does. Max 32 characters.
- Colors are `#rgb` or `#rrggbb`, normalized to uppercase. `""` clears the
  color. Anything else is `400`.
- Unknown permission bits are masked off rather than rejected.
- Every mutation writes an audit row (`role_create`, `role_update`,
  `role_delete`, `role_reorder`) and broadcasts `roles_update` (see
  `docs/protocol.md`) carrying the full new list.

### GET /admin/api/roles

Roles ordered by position descending, each with its member count.

#### Response 200 OK

```json
[
  { "id": 1, "name": "Owner", "color": "#E74C3C", "permissions": 2147483647, "position": 100, "is_default": false, "member_count": 1 },
  { "id": 4, "name": "Member", "color": null, "permissions": 1635, "position": 40, "is_default": true, "member_count": 12 }
]
```

### POST /admin/api/roles

#### Request

```json
{
  "name": "Helper",
  "color": "#5865F2",
  "permissions": 3,
  "position": 50
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | 1–32 characters, unique case-insensitively |
| `color` | string | No | `#rgb`/`#rrggbb`, or `""` for none |
| `permissions` | integer | No | Bitfield; defaults to `0` |
| `position` | integer | No | Defaults to one below the actor's own position |

#### Response 201 Created

The created role (`id`, `name`, `color`, `permissions`, `position`,
`is_default` — always `false`; the default role is seeded, never created).

#### Errors

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | Missing/blank/over-long name, duplicate name, bad color, negative position |
| 403 | `FORBIDDEN` | Missing `MANAGE_ROLES`, position at or above your own, or a permission bit you lack |

### PATCH /admin/api/roles/{id}

Partial update — every field is optional and an omitted one is left alone.
Same body and same errors as `POST`, plus `404 NOT_FOUND` for a missing role.
Editing a role at or above your own position is `403`.

A permission change additionally invalidates the cached permissions of that
role's members and re-syncs their channel visibility (the server sends targeted
`channel_create`/`channel_delete`), because a role's mask is the base every
channel's effective permission derives from.

#### Response 200 OK

The updated role.

### DELETE /admin/api/roles/{id}

#### Response 204 No Content

#### Errors

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | The role is the default role, or is the seeded Owner role |
| 403 | `FORBIDDEN` | Missing `MANAGE_ROLES`, or the role is at or above your own position |
| 404 | `NOT_FOUND` | No such role |

### PATCH /admin/api/roles/reorder

#### Request

```json
{ "role_ids": [2, 9, 3, 4] }
```

`role_ids` is highest-rank-first and must name **exactly** the set of roles
strictly below your own position — a partial list is refused rather than
silently leaving the omitted roles at positions that now collide. Positions are
normalized to `N…1`, so they stay unique, stay below the actor, and never
collide with the untouched roles above.

#### Response 200 OK

The full role list after the reorder, position descending.

#### Errors

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | Wrong number of ids, or a duplicate id |
| 403 | `FORBIDDEN` | Missing `MANAGE_ROLES`, or an id that is unknown or not below your rank |

---

## Channel Management (admin)

`POST /admin/api/channels` takes `{name, type, category, topic, position}`;
`PATCH /admin/api/channels/{id}` takes `{name, topic, category, slow_mode,
position, archived, nsfw, voice_max_users, voice_max_video}` and seeds every
omitted field from the current row, so a partial body is safe.

The numeric fields are bounds-checked before anything is written, and an
out-of-range value is refused with `400 INVALID_INPUT` rather than clamped —
a caller that sent `-1` meant something, and storing `0` would hide it. A
refused body writes nothing at all:

| Field | Range | Meaning |
|-------|-------|---------|
| `slow_mode` | 0…21600 | Cooldown in seconds; 0 = off (6-hour ceiling, as Discord) |
| `voice_max_users` | 0…99 | Voice capacity; 0 = unlimited |
| `voice_max_video` | 0…99 | Simultaneous cameras/screen shares; 0 = unlimited |

`nsfw` is a bool and is stored, broadcast and audited only — the server applies
no content behaviour to a flagged channel (see `GET /api/v1/channels`). The
audit detail names the transition: `updated #foo (marked NSFW)` /
`(unmarked NSFW)`, and plain `updated #foo` when the flag did not move.

The voice limits are stored on a channel of any type but are only meaningful on
a voice one; the desktop client offers them for voice channels alone and omits
the keys entirely elsewhere, so a text-channel edit cannot wipe limits the row
happens to hold.

`type` must be `text`, `voice` or `announcement` (`400 INVALID_INPUT`
otherwise). **`category` constrains nothing.** Categories are free text and a
channel of any type may live under any of them — a voice channel under
"Gaming", a text channel under "Voice Channels". Grouping is a display concern:
the desktop client groups by whatever category a channel carries and falls back
to a synthetic "Voice" group only for voice channels with no category at all.
(Before phase 5 the server refused any non-voice channel under a category
literally named "Voice Channels", and any voice channel outside it.)

`PATCH` accepts `category`, so moving a channel between categories is an edit
rather than a delete-and-recreate. An empty string makes it uncategorized.

---

## Channel Permission Overrides

Two override layers per channel, both gated on `MANAGE_CHANNELS` and both
audit-logged. They resolve in Discord's order:

```
base role permissions -> role override -> user override
```

The later, narrower layer wins: a **user** deny beats a **role** allow, a user
allow beats a role deny, and within one layer allow beats deny. `ADMINISTRATOR`
bypasses both layers entirely. See `docs/schema.md` ("Permission Checking
Logic") for the formula and `permissions.EffectiveChannelPerms` for the single
implementation.

Denying `READ_MESSAGES` hides the channel outright — from the WS `ready`
payload, from `GET /api/v1/channels`, from reconnect replay and from live
broadcasts. Every write below invalidates the affected permission cache entries
and then re-syncs connected clients with targeted `channel_create` /
`channel_delete` messages, so sidebars converge without a reconnect.

DM channels have no override surface: `400 INVALID_INPUT`.

### GET /admin/api/channels/{id}/permissions

Both layers for one channel. `roles` lists **every** role (zero masks when it
carries no override) so the panel can render a complete grid; `users` lists
**only** members who actually have an override row.

#### Response 200 OK

```json
{
  "channel_id": 4,
  "roles": [
    { "role_id": 1, "role_name": "Owner", "position": 100, "permissions": 2147483647, "allow": 0, "deny": 0 },
    { "role_id": 4, "role_name": "Member", "position": 40, "permissions": 1635, "allow": 0, "deny": 514 }
  ],
  "users": [
    { "user_id": 12, "username": "alice", "role_id": 4, "allow": 2, "deny": 0 }
  ]
}
```

### PUT /admin/api/channels/{id}/permissions/{roleId}

### PUT /admin/api/channels/{id}/user-permissions/{userId}

Write one override row. Same body for both layers:

```json
{ "allow": 2, "deny": 1 }
```

| Field | Type | Description |
|-------|------|-------------|
| `allow` | integer | Bits granted in this channel |
| `deny` | integer | Bits refused in this channel |

Bits outside `permissions.AllPerms` are masked off rather than rejected, so an
unknown bit can never be persisted. A row with both masks `0` is meaningless —
the admin panel sends `DELETE` for that case instead.

#### Response 200 OK

The stored row: `{role_id, role_name, position, permissions, allow, deny}` for
the role layer, `{user_id, username, role_id, allow, deny}` for the user layer.

#### Cache and fan-out

- Role layer: `InvalidateAll` (any member of that role is affected), then
  `RefreshChannelVisibility`.
- User layer: `InvalidateUser(userId)` only — a per-user override cannot change
  anyone else's verdict, and dropping the whole cache for one member would cost
  every connected client a repopulate — then `RefreshChannelVisibility`, which
  resolves visibility per user through the full order.

#### Audit

`channel_perms_update` / `channel_user_perms_update`, target `channel`.

#### Errors

| Status | Code | When |
|--------|------|------|
| 400 | `BAD_REQUEST` | Unparseable id or body |
| 400 | `INVALID_INPUT` | The channel is a DM |
| 403 | `FORBIDDEN` | Missing `MANAGE_CHANNELS` |
| 404 | `NOT_FOUND` | Unknown channel, role or user |

### DELETE /admin/api/channels/{id}/permissions/{roleId}

### DELETE /admin/api/channels/{id}/user-permissions/{userId}

Clear the override row, returning the target to the layer above it. `204 No
Content`; deleting a row that does not exist is a no-op, not a `404`. Same
cache/fan-out behavior as the writes; audits as `channel_perms_clear` /
`channel_user_perms_clear`.

---

## Plugin Administration

Manage WASM plugins. These endpoints sit behind **both** the admin IP
restriction (allowed CIDRs) **and** admin bearer-token authentication, and
require the `ADMINISTRATOR` bit specifically (the widened admin perimeter does
not open them).
Plugin execution additionally requires a server built with `-tags wazero`
and `plugins.enabled: true` in config.

### GET /api/v1/admin/plugins

List installed plugins.

#### Response 200 OK

Array of plugin rows: `ID`, `Name`, `Version`, `Enabled`, `ManifestJSON`,
`InstalledAt`.

### POST /api/v1/admin/plugins/install

Install a plugin from an uploaded zip (multipart form). The archive is
size-capped (16 MiB compressed / 64 MiB uncompressed) and hardened against
zip-slip and symlinks; installation is staged and atomically renamed.

#### Response 201 Created

```json
{ "name": "plugin-name" }
```

### POST /api/v1/admin/plugins/{id}/enable

### POST /api/v1/admin/plugins/{id}/disable

Enable or disable an installed plugin.

### DELETE /api/v1/admin/plugins/{id}

Uninstall a plugin.

---

## LiveKit Endpoints

These endpoints are only registered when LiveKit voice is configured.

### POST /api/v1/livekit/webhook

LiveKit webhook receiver. Uses LiveKit JWT verification. Admin-IP-restricted. Called by the LiveKit server, not by clients.

### GET /api/v1/livekit/health

Check whether the LiveKit server is reachable.

**Auth:** Admin IP restriction

#### Response 200 OK

```json
{
  "status": "ok",
  "livekit_reachable": true
}
```

#### Response 503 Service Unavailable

```json
{
  "status": "degraded",
  "livekit_reachable": false,
  "error": "connection refused"
}
```

### /livekit/* (Reverse Proxy)

All requests to `/livekit/*` are reverse-proxied to the LiveKit server URL. The `/livekit` prefix is stripped before forwarding. This allows the client to connect to LiveKit through OwnCord's HTTPS server, avoiding mixed-content blocks.

**Auth:** None (LiveKit handles its own JWT-based auth)
**Rate limit:** 30 requests/minute per IP

---

## Diagnostics

### GET /api/v1/diagnostics/connectivity

Returns connectivity diagnostics for debugging voice/network issues.

**Auth:** Required (any authenticated user)
**Rate limit:** 5 requests/minute per user

```json
{
  "server": {
    "version": "1.0.0",
    "uptime_s": 3600,
    "go_version": "go1.23.0",
    "online_users": 5
  },
  "voice": {
    "enabled": true,
    "livekit_url": "ws://localhost:7880",
    "livekit_health": true,
    "node_ip": "203.0.113.1",
    "proxy_path": "/livekit"
  },
  "client": {
    "remote_addr": "192.168.1.100",
    "is_private_network": true
  }
}
```

---

## Client Auto-Update

### GET /api/v1/client-update/{target}/{current_version}

Tauri-compatible update endpoint. The desktop client checks this to see if a newer version is available.

**Auth:** None

#### Path Parameters

| Param | Type | Description |
| ----- | ---- | ----------- |
| `target` | string | Tauri updater target `{os}-{arch}-{installer}` (e.g., `windows-x86_64-nsis`, `linux-x86_64-appimage`, `linux-aarch64-appimage`). Selects the platform's updater artifact and is echoed back as the `platforms` key. Targets without a published updater artifact (e.g., `linux-x86_64-deb`) get 204. |
| `current_version` | string | Client's current semver version (e.g., `1.0.0`) |

#### Response 200 OK (update available)

```json
{
  "version": "1.2.0",
  "notes": "## What's Changed\n...",
  "pub_date": "2026-03-28T00:00:00Z",
  "platforms": {
    "windows-x86_64-nsis": {
      "signature": "base64-encoded-signature",
      "url": "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/OwnCord_1.2.0_x64-setup.nsis.zip"
    }
  }
}
```

#### Response 204 No Content

Client is already up-to-date, or no client build is published for `target`.

---

## WebSocket

### GET /api/v1/ws

WebSocket upgrade endpoint. Authentication is performed in-band (first message must be an `auth` frame with the session token). See [protocol.md](protocol.md) for the full WebSocket message protocol.
