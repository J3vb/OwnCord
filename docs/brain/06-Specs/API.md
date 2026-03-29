# REST API Spec

Base URL: `https://{server}:{port}/api/v1`

## Authentication

All authenticated endpoints require a session token delivered via the
`Authorization: Bearer {token}` header. Tokens are obtained from `POST /api/v1/auth/login`,
`POST /api/v1/auth/register`, or `POST /api/v1/auth/verify-totp` after a partial
2FA challenge.

The server validates the token by SHA-256 hashing it and looking up the
corresponding session row. If the session is expired or the user is banned,
the request is rejected.

### Session Lifecycle

- Sessions are created on login/register and stored with a SHA-256 hash
  of the raw token, the client IP, User-Agent, and an expiry timestamp.
- Each authenticated request "touches" the session (updates `last_active`).
- Banned users are rejected at the middleware level with `403 FORBIDDEN`.

### Middleware Stack (all routes)

1. **RequestID** -- assigns a unique `X-Request-Id` response header.
2. **Recoverer** -- catches panics and returns 500.
3. **Request Logger** -- structured slog logging of method, path, status, duration.
4. **SecurityHeaders** -- sets `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `X-XSS-Protection: 0`,
   `Referrer-Policy: strict-origin-when-cross-origin`,
   `Content-Security-Policy: default-src 'self'`,
   `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
   `Cache-Control: no-store`.
5. **MaxBodySize** -- 1 MiB default for all routes except `/api/v1/uploads`
   (which has its own 100 MiB limit).

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
| `BAD_GATEWAY` | 502 | Upstream failure (GitHub API, LiveKit, asset download) |

---

## Auth Endpoints

### POST /api/v1/auth/register

Create a new account using an invite code. The first user is created via
`/admin/api/setup` instead.

**Auth:** None (public)
**Rate limit:** 3 requests/minute per IP
**Body size:** 1 MiB

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
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

Note: `status` is `"offline"` at registration time. It changes to
`"online"` when the user opens a WebSocket connection.

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
**Rate limit:** 60 requests/minute per IP. After 10 consecutive failures
from the same IP, the IP is locked out for 15 minutes. The per-minute
limit is intentionally high to support automated E2E testing; the
10-failure lockout is the real brute-force protection.

#### Request

```json
{
  "username": "alex",
  "password": "MyStr0ng!Pass"
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `username` | string | Yes | Trimmed (whitespace stripped). |
| `password` | string | Yes | NOT trimmed (passwords may contain leading/trailing whitespace). |

#### Response 200 OK

If the account does not have TOTP enabled, login returns a normal session:

```json
{
  "token": "raw-session-token-64-chars",
  "requires_2fa": false,
  "user": {
    "id": 1,
    "username": "alex",
    "avatar": "uuid.png",
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

If the account has TOTP enabled, login returns a partial challenge instead of a full session:

```json
{
  "partial_token": "opaque-partial-token",
  "requires_2fa": true
}
```

Note: `status` reflects the DB value at login time (typically `"offline"`).
Status changes to `"online"` when the user opens a WebSocket connection.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing username or password |
| 401 | `UNAUTHORIZED` | Wrong username or password (constant-time comparison prevents timing attacks) |
| 403 | `FORBIDDEN` | Account is banned/suspended, or server policy requires TOTP enrollment before login |
| 429 | `RATE_LIMITED` | IP locked out after 10 consecutive failures (15 min cooldown) |
| 500 | `SERVER_ERROR` | Session creation failure |

#### Security Notes

- The server performs bcrypt comparison even when the username does not
  exist, preventing timing-based username enumeration.
- Failure tracking is per-IP, not per-username.
- Successful login resets the failure counter for that IP.

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
    "avatar": "uuid.png",
    "status": "offline",
    "role_id": 4,
    "totp_enabled": true,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Malformed request body |
| 401 | `UNAUTHORIZED` | Missing/expired challenge, invalid TOTP code, or challenge consumed after too many failures |
| 500 | `SERVER_ERROR` | Session creation failure |

---

### GET /api/v1/auth/me

Get the current authenticated user's profile.

**Auth:** Required (Bearer token)
**Rate limit:** None (beyond global middleware)

#### Response 200 OK

```json
{
  "id": 1,
  "username": "alex",
  "avatar": "uuid.png",
  "status": "online",
  "role_id": 2,
  "totp_enabled": true,
  "created_at": "2026-03-24T12:00:00Z"
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | User ID |
| `username` | string | Display name |
| `avatar` | string | Avatar filename (UUID) or empty string |
| `status` | string | One of: `online`, `idle`, `dnd`, `offline` |
| `role_id` | int64 | Numeric role ID (1=Owner, 2=Admin, 3=Moderator, 4=Member) |
| `totp_enabled` | bool | Whether the user has a confirmed TOTP secret |
| `created_at` | string | ISO 8601 timestamp |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Missing, invalid, or expired token |

---

### POST /api/v1/auth/logout

Invalidate the current session token. The token becomes unusable immediately.

**Auth:** Required (Bearer token)
**Rate limit:** None

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 500 | `SERVER_ERROR` | Failed to delete session from DB |

---

### POST /api/v1/users/me/totp/enable

Start TOTP enrollment for the authenticated user.

**Auth:** Required (full session token)
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

Notes:
- The secret is not persisted until `POST /api/v1/users/me/totp/confirm` succeeds.
- `backup_codes` is currently always an empty array.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing or incorrect password |
| 401 | `UNAUTHORIZED` | Missing or invalid session token |
| 500 | `SERVER_ERROR` | Failed to generate the TOTP secret |

---

### POST /api/v1/users/me/totp/confirm

Confirm a pending TOTP enrollment and persist the secret on the user account.

**Auth:** Required (full session token)
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass",
  "code": "123456"
}
```

#### Response 204 No Content

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Malformed request, missing/incorrect password, or no pending enrollment |
| 401 | `UNAUTHORIZED` | Invalid TOTP code or missing session token |
| 500 | `SERVER_ERROR` | Failed to persist the TOTP secret |

---

### DELETE /api/v1/users/me/totp

Disable TOTP for the authenticated user.

**Auth:** Required (full session token)
**Rate limit:** 5 requests/minute per IP

#### Request

```json
{
  "password": "MyStr0ng!Pass"
}
```

#### Response 204 No Content

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `INVALID_INPUT` | Missing or incorrect password |
| 401 | `UNAUTHORIZED` | Missing or invalid session token |
| 403 | `FORBIDDEN` | Server policy currently requires TOTP for all accounts |
| 500 | `SERVER_ERROR` | Failed to clear the TOTP secret |

---

## Channel Endpoints

### GET /api/v1/channels

List all channels the authenticated user has `READ_MESSAGES` permission for.
DM channels are NOT included (use `GET /api/v1/dms` instead).

**Auth:** Required
**Rate limit:** None

#### Response 200 OK

Returns a JSON array of channel objects. Permission filtering uses
batch-fetched channel overrides to avoid N+1 queries.

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
    "archived": false
  },
  {
    "id": 2,
    "name": "General",
    "type": "voice",
    "topic": "",
    "category": "Voice Channels",
    "position": 0,
    "slow_mode": 0,
    "archived": false
  }
]
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | Channel ID |
| `name` | string | Channel name |
| `type` | string | `text`, `voice`, or `announcement` |
| `topic` | string | Channel topic/description |
| `category` | string | Category grouping (e.g., "Text Channels", "Voice Channels") |
| `position` | int | Sort order within category |
| `slow_mode` | int | Slow-mode delay in seconds (0 = disabled) |
| `archived` | bool | Whether the channel is archived |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 500 | `INTERNAL` | DB query failure |

---

### GET /api/v1/channels/{id}/messages

Paginated message history for a channel. For DM channels, participant-based
authorization is used instead of role-based permissions.

**Auth:** Required
**Rate limit:** None
**Permission:** `READ_MESSAGES` on the channel (or DM participant membership)

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `before` | int64 | 0 (latest) | >= 0 | Cursor: return messages with ID less than this value |
| `limit` | int | 50 | 1-100 | Number of messages to return. Clamped to 100 max. |

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
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ],
  "has_more": true
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `messages` | array | Array of message objects, ordered by ID descending (newest first) |
| `has_more` | bool | `true` if there are older messages beyond the current page |
| `messages[].id` | int64 | Message ID (used as cursor for `before` param) |
| `messages[].user` | object | Author info: `id`, `username`, `avatar` |
| `messages[].content` | string | Message text content |
| `messages[].reply_to` | int64 or null | ID of the message this is replying to |
| `messages[].attachments` | array | File attachments with `id`, `filename`, `size`, `mime_type`, `url`, `width`, `height` |
| `messages[].reactions` | array | Reactions with `emoji`, `count`, and `me` (whether the requesting user reacted) |
| `messages[].pinned` | bool | Whether the message is pinned |
| `messages[].edited_at` | string or null | ISO timestamp of last edit |
| `messages[].deleted` | bool | Whether the message has been soft-deleted |
| `messages[].timestamp` | string | ISO 8601 creation timestamp |

#### Pagination

Use cursor-based pagination by passing the `id` of the last message as
the `before` parameter in the next request:

```
GET /api/v1/channels/5/messages?before=1042&limit=50
```

When `has_more` is `false`, you have reached the beginning of the channel history.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid `before` or `limit` parameter |
| 401 | `UNAUTHORIZED` | Not authenticated (DM channels) |
| 403 | `FORBIDDEN` | No `READ_MESSAGES` permission or not a DM participant |
| 404 | `NOT_FOUND` | Channel does not exist |
| 500 | `INTERNAL` | DB query failure |

---

### GET /api/v1/channels/{id}/pins

Get all pinned messages for a channel.

**Auth:** Required
**Permission:** `READ_MESSAGES` on the channel

#### Response 200 OK

```json
{
  "messages": [
    {
      "id": 500,
      "channel_id": 5,
      "user": { "id": 1, "username": "alex", "avatar": "uuid.png" },
      "content": "Important announcement!",
      "reply_to": null,
      "attachments": [],
      "reactions": [],
      "pinned": true,
      "edited_at": null,
      "deleted": false,
      "timestamp": "2026-03-10T09:00:00Z"
    }
  ],
  "has_more": false
}
```

`has_more` is always `false` for pins (all pinned messages are returned at once).

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid channel ID |
| 403 | `FORBIDDEN` | No `READ_MESSAGES` permission |
| 404 | `NOT_FOUND` | Channel does not exist |
| 500 | `INTERNAL` | DB query failure |

---

### POST /api/v1/channels/{id}/pins/{messageId}

Pin a message in a channel.

**Auth:** Required
**Permission:** `MANAGE_MESSAGES` on the channel (Admins bypass)

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid channel ID or message ID |
| 403 | `FORBIDDEN` | No `MANAGE_MESSAGES` permission |
| 404 | `NOT_FOUND` | Message not found or does not belong to this channel |
| 500 | `INTERNAL` | DB update failure |

---

### DELETE /api/v1/channels/{id}/pins/{messageId}

Unpin a message from a channel.

**Auth:** Required
**Permission:** `MANAGE_MESSAGES` on the channel (Admins bypass)

#### Response 204 No Content

No response body.

#### Errors

Same as `POST /api/v1/channels/{id}/pins/{messageId}`.

---

## Search

### GET /api/v1/search

Full-text search across messages in channels the user can read. Uses
SQLite FTS5 for matching. Results are post-filtered by `READ_MESSAGES`
permission using batch-fetched channel overrides.

**Auth:** Required
**Rate limit:** None

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `q` | string | (required) | non-empty | Search query (FTS5 syntax) |
| `channel_id` | int64 | (all channels) | > 0 | Restrict search to a single channel |
| `limit` | int | 50 | 1-100 | Maximum results to return. Clamped to 100. |

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
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ]
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `results` | array | Array of matching messages (may be empty) |
| `results[].message_id` | int64 | Message ID |
| `results[].channel_id` | int64 | Channel the message belongs to |
| `results[].channel_name` | string | Channel name |
| `results[].user` | object | Author `id` and `username` |
| `results[].content` | string | Message content (may contain FTS highlight markers) |
| `results[].timestamp` | string | ISO 8601 timestamp |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Missing `q` parameter, or invalid `channel_id`/`limit` |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 500 | `INTERNAL` | FTS query failure |

---

## Direct Messages

DM channels use participant-based authorization rather than role-based
permissions. Every endpoint verifies the requesting user is a participant
in the DM channel.

### POST /api/v1/dms

Create or retrieve a 1-on-1 DM channel with another user. If a DM channel
already exists between the two users, it is returned and re-opened for the
calling user (so it appears in their sidebar). Uses a serialized transaction
to prevent TOCTOU races.

**Auth:** Required
**Rate limit:** None

#### Request

```json
{
  "recipient_id": 2
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `recipient_id` | int64 | Yes | Must be > 0, must not be the calling user's own ID |

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

| Field | Type | Description |
| ----- | ---- | ----------- |
| `channel_id` | int64 | The DM channel ID (use with `/channels/{id}/messages` to fetch history) |
| `recipient` | object | The other user's profile: `id`, `username`, `avatar`, `status` |
| `created` | bool | `true` if a new channel was created; `false` if an existing one was returned |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid body, `recipient_id` <= 0, or trying to DM yourself |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 404 | `NOT_FOUND` | Recipient user does not exist |
| 500 | `INTERNAL` | DB transaction failure |

---

### GET /api/v1/dms

List all open DM channels for the authenticated user. Channels are ordered
by most recent activity (last message timestamp or open timestamp). Includes
recipient info, last message preview, and unread count.

**Auth:** Required
**Rate limit:** None

#### Response 200 OK

```json
{
  "dm_channels": [
    {
      "channel_id": 100,
      "recipient": {
        "id": 2,
        "username": "jordan",
        "avatar": "uuid.png",
        "status": "online"
      },
      "last_message_id": 5042,
      "last_message": "Hey, how's it going?",
      "last_message_at": "2026-03-28T14:30:00Z",
      "unread_count": 3
    }
  ]
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `dm_channels` | array | Array of open DM channels (may be empty) |
| `dm_channels[].channel_id` | int64 | DM channel ID |
| `dm_channels[].recipient` | object | Other participant: `id`, `username`, `avatar`, `status` |
| `dm_channels[].last_message_id` | int64 or null | ID of the most recent non-deleted message |
| `dm_channels[].last_message` | string | Content preview of the last message (empty if none) |
| `dm_channels[].last_message_at` | string | ISO timestamp of the last message (empty if none) |
| `dm_channels[].unread_count` | int | Number of unread messages based on read_states |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 500 | `INTERNAL` | DB query failure |

---

### DELETE /api/v1/dms/{channelId}

Close a DM channel for the authenticated user (hides it from their sidebar).
The channel and all messages remain in the database. If the other user sends
a new message, the channel is automatically re-opened.

A `dm_channel_close` WebSocket event is sent to the closing user's active
connections so the sidebar updates immediately.

**Auth:** Required
**Rate limit:** None

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid channel ID |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 403 | `FORBIDDEN` | Not a participant in this DM |
| 500 | `INTERNAL` | DB deletion failure |

---

## Invite Endpoints

All invite endpoints require authentication and the `MANAGE_INVITES`
permission (part of the role bitfield). Administrators bypass all
permission checks.

### POST /api/v1/invites

Create a new invite code.

**Auth:** Required
**Permission:** `MANAGE_INVITES`
**Rate limit:** None

#### Request

```json
{
  "max_uses": 5,
  "expires_in_hours": 48
}
```

| Field | Type | Required | Default | Notes |
| ----- | ---- | -------- | ------- | ----- |
| `max_uses` | int | No | 0 (unlimited) | Maximum number of times the invite can be used |
| `expires_in_hours` | int | No | 0 (never) | Hours until the invite expires |

The request body is entirely optional. An empty body `{}` or even no body
creates an invite with unlimited uses and no expiry.

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

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | Invite row ID |
| `code` | string | The invite code string |
| `max_uses` | int or null | Usage cap (`null` = unlimited) |
| `uses` | int | Current usage count |
| `expires_at` | string or null | ISO timestamp of expiry (`null` = never) |
| `revoked` | bool | Whether the invite has been revoked |
| `created_at` | string | ISO timestamp of creation |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 403 | `FORBIDDEN` | Missing `MANAGE_INVITES` permission |
| 500 | `SERVER_ERROR` | DB failure |

---

### GET /api/v1/invites

List all invites (active, expired, and revoked).

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 200 OK

```json
[
  {
    "id": 1,
    "code": "abc123def",
    "max_uses": 5,
    "uses": 2,
    "expires_at": "2026-03-30T10:30:00Z",
    "revoked": false,
    "created_at": "2026-03-28T10:30:00Z"
  },
  {
    "id": 2,
    "code": "xyz789ghi",
    "max_uses": null,
    "uses": 10,
    "expires_at": null,
    "revoked": false,
    "created_at": "2026-03-25T08:00:00Z"
  }
]
```

Returns a JSON array. Empty array `[]` if no invites exist.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 403 | `FORBIDDEN` | Missing `MANAGE_INVITES` permission |
| 500 | `SERVER_ERROR` | DB query failure |

---

### DELETE /api/v1/invites/{code}

Revoke an invite by its code string (not ID). Revoked invites cannot be
used for registration.

**Auth:** Required
**Permission:** `MANAGE_INVITES`

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 403 | `FORBIDDEN` | Missing `MANAGE_INVITES` permission |
| 404 | `NOT_FOUND` | Invite code not found |
| 500 | `SERVER_ERROR` | DB update failure |

---

## File Upload & Serving

### POST /api/v1/uploads

Upload a file as multipart form data.

**Auth:** Required
**Rate limit:** None
**Body size limit:** 100 MiB (applied via route-scoped middleware, overriding
the global 1 MiB limit)
**Content-Type:** `multipart/form-data`

#### Request

Multipart form with a single field named `file`:

```
POST /api/v1/uploads
Content-Type: multipart/form-data; boundary=----Boundary
Authorization: Bearer {token}

------Boundary
Content-Disposition: form-data; name="file"; filename="photo.jpg"
Content-Type: image/jpeg

<binary data>
------Boundary--
```

#### File Validation

1. **Magic bytes check:** The first 8 bytes of the file are read and compared
   against blocked signatures. The following are rejected:
   - PE executables (`.exe`, `.dll`) -- magic `MZ`
   - ELF binaries -- magic `\x7fELF`
   - Mach-O binaries (32/64-bit)
   - Shell scripts -- magic `#!`
2. **Size check:** The file is streamed to disk with an enforced limit of
   `max_upload_mb` from server config (default varies). If the file exceeds
   the limit, the partial write is deleted and the upload is rejected.
3. **Filename sanitization:** Files are stored with a UUID filename, not the
   original. The original filename is recorded in the attachment DB record.

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

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | string | UUID assigned to the file |
| `filename` | string | Original filename from the upload |
| `size` | int64 | File size in bytes |
| `mime` | string | MIME type (from `Content-Type` header, stripped of params) |
| `url` | string | Relative URL to serve the file |
| `width` | int or null | Image width in pixels (only for image/* types, `null` otherwise) |
| `height` | int or null | Image height in pixels (only for image/* types, `null` otherwise) |

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid multipart form, missing `file` field, blocked file type, or oversized file |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 500 | `INTERNAL_ERROR` | DB record insertion failure (file is cleaned up) |

---

### GET /api/v1/files/{id}

Serve a previously uploaded file by its UUID.

**Auth:** None (URLs are unguessable UUIDs)
**Rate limit:** None
**Caching:** `Cache-Control: public, max-age=31536000, immutable`
**CORS:** `Access-Control-Allow-Origin: *`

#### Response 200 OK

Binary file content with appropriate headers:

```
Content-Type: image/jpeg
Content-Disposition: inline; filename="photo.jpg"
Cache-Control: public, max-age=31536000, immutable
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Content-Type, Content-Length
```

Supports HTTP range requests and conditional requests (via `http.ServeContent`).

#### Errors

| Status | Response | Cause |
| ------ | -------- | ----- |
| 404 | HTML "Not Found" | File UUID not found in DB or file missing on disk |
| 500 | "internal server error" | DB lookup failure |

---

## Health Check

### GET /health

Top-level health check, not under the `/api/v1` prefix.

**Auth:** None
**Rate limit:** None

### GET /api/v1/health

Identical to `GET /health` but under the versioned prefix.

**Auth:** None
**Rate limit:** None

#### Response 200 OK

```json
{
  "status": "ok",
  "version": "1.2.0",
  "uptime": 86400,
  "online_users": 3
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `status` | string | Always `"ok"` |
| `version` | string | Server version string |
| `uptime` | int64 | Server uptime in seconds |
| `online_users` | int | Number of connected WebSocket clients |

---

## Server Info

### GET /api/v1/info

Returns the server name and version. Useful for the client connect page.

**Auth:** None
**Rate limit:** None

#### Response 200 OK

```json
{
  "name": "My OwnCord Server",
  "version": "1.2.0"
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Server name from config |
| `version` | string | Server version string |

---

## Metrics

### GET /api/v1/metrics

Runtime server metrics. Restricted to admin-allowed CIDRs (same IPs that
can access `/admin`). No Bearer token required; access is controlled purely
by source IP.

**Auth:** Admin IP restriction (not token-based)
**Rate limit:** None

#### Response 200 OK

```json
{
  "uptime": "2h30m15s",
  "uptime_seconds": 9015.0,
  "goroutines": 42,
  "heap_alloc_mb": 12.5,
  "heap_sys_mb": 24.0,
  "num_gc": 156,
  "connected_users": 8,
  "livekit_healthy": true
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `uptime` | string | Human-readable uptime (Go duration format) |
| `uptime_seconds` | float64 | Uptime in seconds |
| `goroutines` | int | Current goroutine count |
| `heap_alloc_mb` | float64 | Heap allocation in megabytes |
| `heap_sys_mb` | float64 | System heap memory in megabytes |
| `num_gc` | uint32 | Total garbage collection cycles |
| `connected_users` | int | Active WebSocket connections |
| `livekit_healthy` | bool or null | LiveKit reachability (`null` if LiveKit is not configured) |

#### Errors

| Status | Response | Cause |
| ------ | -------- | ----- |
| 403 | `"Forbidden"` | Request IP not in `admin_allowed_cidrs` |

---

## LiveKit Endpoints

These endpoints are only registered when LiveKit voice is configured.

### POST /api/v1/livekit/webhook

LiveKit webhook receiver. Uses LiveKit JWT verification (not OwnCord session
tokens). Admin-IP-restricted.

**Auth:** LiveKit webhook JWT (automatically sent by LiveKit server)
**Access:** Admin-IP-restricted

This endpoint is called by the LiveKit server, not by clients.

---

### GET /api/v1/livekit/health

Check whether the LiveKit server is reachable.

**Auth:** Admin IP restriction
**Rate limit:** None

#### Response 200 OK (healthy)

```json
{
  "status": "ok",
  "livekit_reachable": true
}
```

#### Response 503 Service Unavailable (unhealthy)

```json
{
  "status": "degraded",
  "livekit_reachable": false,
  "error": "connection refused"
}
```

---

### /livekit/* (Reverse Proxy)

All requests to `/livekit/*` are reverse-proxied to the LiveKit server URL
(e.g., `ws://localhost:7880`). The `/livekit` prefix is stripped before forwarding.

This allows the Tauri client to connect to LiveKit through OwnCord's HTTPS
server, avoiding mixed-content blocks (secure page connecting to insecure WS).

**Auth:** None (LiveKit handles its own JWT-based auth via `access_token` query param)
**Rate limit:** 30 requests/minute per IP

WebSocket upgrade requests are detected and proxied bidirectionally. Regular
HTTP requests are forwarded via `httputil.ReverseProxy`.

---

## Diagnostics

### GET /api/v1/diagnostics/connectivity

Returns connectivity diagnostics for debugging voice/network issues.

**Auth:** Required (any authenticated user)
**Rate limit:** 5 requests/minute per user

#### Response 200

```json
{
  "server": {
    "version": "1.3.0",
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

| Field | Type | Description |
| ----- | ---- | ----------- |
| `server.version` | string | Server version string |
| `server.uptime_s` | int | Seconds since server start |
| `server.go_version` | string | Go runtime version |
| `server.online_users` | int | Currently connected users |
| `voice.enabled` | bool | Whether LiveKit is configured |
| `voice.livekit_url` | string | LiveKit server URL |
| `voice.livekit_health` | bool | LiveKit reachable |
| `voice.node_ip` | string | LiveKit node IP (from health) |
| `voice.proxy_path` | string | Reverse proxy path |
| `client.remote_addr` | string | Client's IP as seen by server |
| `client.is_private_network` | bool | Whether client IP is RFC 1918 |

---

## Client Auto-Update

### GET /api/v1/client-update/{target}/{current_version}

Tauri-compatible update endpoint. The desktop client checks this to see if
a newer version is available.

**Auth:** None (unauthenticated, checked before login)
**Rate limit:** None

#### Path Parameters

| Param | Type | Description |
| ----- | ---- | ----------- |
| `target` | string | Platform target (e.g., `windows-x86_64`) |
| `current_version` | string | Client's current semver version (e.g., `1.0.0` or `v1.0.0`) |

#### Response 200 OK (update available)

```json
{
  "version": "1.2.0",
  "notes": "## What's Changed\n...",
  "pub_date": "2026-03-28T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "base64-encoded-signature",
      "url": "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/OwnCord_1.2.0_x64-setup.nsis.zip"
    }
  }
}
```

#### Response 204 No Content

Client is already up-to-date, or no compatible installer asset was found.

#### Errors

| Status | Response | Cause |
| ------ | -------- | ----- |
| 400 | Text error | Missing `target` or `current_version` |
| 502 | Text error | Failed to check GitHub releases or fetch signature |

---

## WebSocket

### GET /api/v1/ws

WebSocket upgrade endpoint. Authentication is performed in-band (first
message must be an `auth` frame with the session token). Not covered in
this REST API spec -- see [[PROTOCOL|PROTOCOL.md]] for the full WebSocket
message protocol.

**Auth:** In-band (not via HTTP headers)
**Rate limit:** Managed by the WebSocket hub

---

## Admin Panel Endpoints

> **Important:** Admin endpoints are served under `/admin/api/*`, NOT under
> `/api/v1/admin/*`. The admin panel is mounted at `/admin` on the main
> router. All `/admin` routes are IP-restricted to `admin_allowed_cidrs`
> (default: private networks only) at the router level.
>
> Within `/admin/api/*`, all routes (except setup and log stream) require
> both admin IP AND a Bearer token with the `ADMINISTRATOR` permission bit.

### GET /admin/api/setup/status

Check whether initial server setup is needed (no users exist yet).

**Auth:** None (unauthenticated)
**Admin IP:** Required (route is under `/admin`)

#### Response 200 OK

```json
{
  "needs_setup": true
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `needs_setup` | bool | `true` when the users table is empty |

---

### POST /admin/api/setup

Perform initial server setup: create the owner account, default channels,
and a bootstrap invite code.

**Auth:** None (unauthenticated)
**Admin IP:** Required
**Restriction:** Only works when no users exist. Returns 403 after setup.

#### Request

```json
{
  "username": "owner",
  "password": "Str0ng!P@ssw0rd"
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `username` | string | Yes | HTML-stripped, trimmed |
| `password` | string | Yes | Validated for strength |

#### Response 201 Created

```json
{
  "token": "raw-session-token",
  "user_id": 1,
  "username": "owner",
  "invite_code": "bootstrap-invite-code"
}
```

The response includes a session token (immediately logged in) and a bootstrap
invite code with unlimited uses and no expiry, so the owner can invite others.

Two default channels are created automatically:
- `#general` (text, category "Text Channels")
- `General` (voice, category "Voice Channels")

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Missing username/password, or weak password |
| 403 | `FORBIDDEN` | Setup already completed (users exist) |
| 500 | `INTERNAL_ERROR` | DB or session creation failure |

---

### GET /admin/api/stats

Server statistics overview.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 200 OK

```json
{
  "user_count": 25,
  "message_count": 10542,
  "channel_count": 8,
  "invite_count": 15,
  "db_size_bytes": 5242880,
  "online_count": 12
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `user_count` | int64 | Total registered users |
| `message_count` | int64 | Total non-deleted messages |
| `channel_count` | int64 | Total channels |
| `invite_count` | int64 | Active (non-revoked) invites |
| `db_size_bytes` | int64 | SQLite database file size (page_count * page_size) |
| `online_count` | int | Active WebSocket connections (populated from hub) |

---

### GET /admin/api/users

List all users with admin-level detail (ban status, role name, last seen).

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `limit` | int | 50 | 1-500 | Number of users per page |
| `offset` | int | 0 | >= 0 | Number of users to skip |

#### Response 200 OK

```json
[
  {
    "id": 1,
    "username": "owner",
    "avatar": null,
    "role_id": 1,
    "role_name": "Owner",
    "status": "online",
    "created_at": "2026-03-20T10:00:00Z",
    "last_seen": "2026-03-28T14:30:00Z",
    "banned": false,
    "ban_reason": null,
    "ban_expires": null
  },
  {
    "id": 2,
    "username": "alex",
    "avatar": "uuid.png",
    "role_id": 4,
    "role_name": "Member",
    "status": "offline",
    "created_at": "2026-03-22T12:00:00Z",
    "last_seen": "2026-03-27T09:00:00Z",
    "banned": false,
    "ban_reason": null,
    "ban_expires": null
  }
]
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | User ID |
| `username` | string | Display name |
| `avatar` | string or null | Avatar UUID filename |
| `role_id` | int64 | Numeric role ID |
| `role_name` | string | Role display name ("Owner", "Admin", "Member") |
| `status` | string | `online`, `idle`, `dnd`, `offline` |
| `created_at` | string | ISO 8601 registration timestamp |
| `last_seen` | string or null | ISO 8601 last activity timestamp |
| `banned` | bool | Whether the user is currently banned |
| `ban_reason` | string or null | Reason for the ban |
| `ban_expires` | string or null | ISO 8601 ban expiry (null = permanent) |

Note: `password_hash` and `totp_secret` are deliberately excluded from
this response for security.

---

### PATCH /admin/api/users/{id}

Update a user's role or ban status. Cannot modify your own account (prevents
self-lockout).

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Request

All fields are optional. Only included fields are applied.

```json
{
  "role_id": 2,
  "banned": true,
  "ban_reason": "Spam"
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `role_id` | int64 | No | New role ID to assign |
| `banned` | bool | No | `true` to ban, `false` to unban |
| `ban_reason` | string | No | Reason for ban (only used when `banned` is `true`) |

#### Side Effects

- **Role change:** Broadcasts a `member_update` WebSocket event with the
  new role name so all connected clients update immediately.
- **Ban:** Broadcasts a `member_ban` WebSocket event. The banned user's
  WebSocket connections are terminated.
- **Unban:** No broadcast (user must re-login).
- All changes are logged to the audit log.

#### Response 200 OK

Returns the updated user object (same shape as `GET /admin/api/users` items).

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid user ID, invalid body, or attempting to modify own account |
| 404 | `NOT_FOUND` | User not found |
| 500 | `INTERNAL_ERROR` | DB update failure |

---

### DELETE /admin/api/users/{id}/sessions

Force-logout a user by deleting all their sessions. Their WebSocket
connections will be terminated on the next heartbeat check.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid user ID |
| 500 | `INTERNAL_ERROR` | DB deletion failure |

---

### GET /admin/api/channels

List all channels (unfiltered, including archived and DM channels).

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 200 OK

Same channel object shape as `GET /api/v1/channels`, but without permission
filtering. Returns all channels.

---

### POST /admin/api/channels

Create a new channel.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Request

```json
{
  "name": "announcements",
  "type": "announcement",
  "category": "Text Channels",
  "topic": "Important server announcements",
  "position": 1
}
```

| Field | Type | Required | Default | Notes |
| ----- | ---- | -------- | ------- | ----- |
| `name` | string | Yes | -- | Must be non-empty (trimmed) |
| `type` | string | No | `"text"` | `text`, `voice`, or `announcement` |
| `category` | string | No | `""` | Category grouping name |
| `topic` | string | No | `""` | Channel description |
| `position` | int | No | 0 | Sort order within category |

#### Category-Type Validation

- Voice channels can only be created under a category containing "voice"
  (case-insensitive).
- Non-voice categories only allow `text` and `announcement` types.
- Empty category allows any type.

#### Side Effects

Broadcasts a `channel_create` WebSocket event to all connected clients.

#### Response 201 Created

Returns the created channel object.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Missing name or invalid body |
| 400 | `INVALID_INPUT` | Type/category mismatch (e.g., text channel under voice category) |
| 500 | `INTERNAL_ERROR` | DB insertion failure |

---

### PATCH /admin/api/channels/{id}

Update a channel's properties. Supports partial updates (unspecified fields
retain their current values).

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Request

```json
{
  "name": "general-chat",
  "topic": "Updated topic",
  "slow_mode": 5,
  "position": 2,
  "archived": false
}
```

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | string | No | Channel name |
| `topic` | string | No | Channel topic |
| `slow_mode` | int | No | Slow-mode delay in seconds |
| `position` | int | No | Sort order |
| `archived` | bool | No | Archive/unarchive the channel |

#### Side Effects

Broadcasts a `channel_update` WebSocket event.

#### Response 200 OK

Returns the updated channel object.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid channel ID or body |
| 404 | `NOT_FOUND` | Channel not found |
| 500 | `INTERNAL_ERROR` | DB update failure |

---

### DELETE /admin/api/channels/{id}

Delete a channel permanently. Messages in the channel are cascade-deleted.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Side Effects

Broadcasts a `channel_delete` WebSocket event.

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid channel ID |
| 404 | `NOT_FOUND` | Channel not found |
| 500 | `INTERNAL_ERROR` | DB deletion failure |

---

### GET /admin/api/audit-log

View the server audit log, paginated.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Query Parameters

| Param | Type | Default | Range | Description |
| ----- | ---- | ------- | ----- | ----------- |
| `limit` | int | 50 | 1-500 | Entries per page |
| `offset` | int | 0 | >= 0 | Entries to skip |

#### Response 200 OK

```json
[
  {
    "id": 42,
    "actor_id": 1,
    "actor_name": "owner",
    "action": "user_ban",
    "target_type": "user",
    "target_id": 5,
    "detail": "banned spammer: excessive spam",
    "created_at": "2026-03-28T12:00:00Z"
  }
]
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `id` | int64 | Audit log entry ID |
| `actor_id` | int64 | User ID of the admin who performed the action (0 = system) |
| `actor_name` | string | Username of the actor (empty string if actor was deleted) |
| `action` | string | Action type (e.g., `user_ban`, `channel_create`, `setting_change`) |
| `target_type` | string | Target resource type (`user`, `channel`, `server`, `setting`) |
| `target_id` | int64 | Target resource ID (0 for server-level actions) |
| `detail` | string | Human-readable description |
| `created_at` | string | ISO 8601 timestamp |

---

### GET /admin/api/settings

Get all server settings as key-value pairs.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 200 OK

```json
{
  "server_name": "My OwnCord",
  "server_icon": "",
  "motd": "Welcome!",
  "max_upload_bytes": "26214400",
  "voice_quality": "high",
  "require_2fa": "0",
  "registration_open": "0",
  "backup_schedule": "daily",
  "backup_retention": "7"
}
```

All values are stored and returned as strings.

---

### PATCH /admin/api/settings

Update one or more server settings. All updates are applied atomically
within a single transaction.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Request

```json
{
  "server_name": "Updated Server Name",
  "motd": "New message of the day"
}
```

Only the following keys are accepted (whitelist):
- `server_name`, `server_icon`, `motd`, `max_upload_bytes`, `voice_quality`,
  `require_2fa`, `registration_open`, `backup_schedule`, `backup_retention`

Any unrecognized key causes the entire request to be rejected (no partial apply).

#### Response 200 OK

Returns the full settings map (same as `GET /admin/api/settings`) after the update.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid body or unknown setting key |
| 500 | `INTERNAL_ERROR` | Transaction failure |

---

### POST /admin/api/backup

Trigger a manual database backup.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR + Owner role, position >= 100)

#### Response 200 OK

```json
{
  "path": "data/backups/chatserver_20260328_143000.db",
  "created": "20260328_143000"
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 403 | `FORBIDDEN` | Not Owner role |
| 500 | `INTERNAL_ERROR` | Backup directory creation or SQLite backup failure |

---

### GET /admin/api/backups

List all available database backups, sorted newest first.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 200 OK

```json
[
  {
    "name": "chatserver_20260328_143000.db",
    "size": 5242880,
    "date": "2026-03-28T14:30:00Z"
  }
]
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Backup filename |
| `size` | int64 | File size in bytes |
| `date` | string | ISO 8601 modification timestamp |

Returns empty array `[]` if no backups exist or the backup directory
does not exist.

---

### DELETE /admin/api/backups/{name}

Delete a backup file from disk.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR + Owner role)

#### Path Parameters

| Param | Type | Notes |
| ----- | ---- | ----- |
| `name` | string | Backup filename. Must not contain `..`, `/`, or `\` (path traversal protection). |

#### Response 204 No Content

No response body.

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid backup name (path traversal attempt) |
| 403 | `FORBIDDEN` | Not Owner role |
| 404 | `NOT_FOUND` | Backup file does not exist |
| 500 | `INTERNAL_ERROR` | File deletion failure |

---

### POST /admin/api/backups/{name}/restore

Restore the database from a backup file. A pre-restore safety backup is
automatically created before overwriting the live database.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR + Owner role)

**WARNING:** This overwrites the live database. A server restart is
recommended after restore.

#### Response 200 OK

```json
{
  "message": "database restored \u2014 server restart recommended",
  "backup": "chatserver_20260328_143000.db"
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 400 | `BAD_REQUEST` | Invalid backup name |
| 403 | `FORBIDDEN` | Not Owner role |
| 404 | `NOT_FOUND` | Backup file does not exist |
| 500 | `INTERNAL_ERROR` | File copy failure |

---

### GET /admin/api/updates

Check for available server updates from GitHub releases.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR)

#### Response 200 OK

```json
{
  "current": "v1.0.0",
  "latest": "v1.2.0",
  "update_available": true,
  "release_url": "https://github.com/J3vb/OwnCord/releases/tag/v1.2.0",
  "download_url": "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/chatserver.exe",
  "checksum_url": "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/checksums.sha256",
  "release_notes": "## What's Changed\n..."
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 502 | `UPDATE_CHECK_FAILED` | GitHub API unreachable or returned error |
| 503 | `UPDATE_UNAVAILABLE` | Updater not configured |

---

### POST /admin/api/updates/apply

Download and apply a server update. Downloads the new binary, verifies its
SHA256 checksum, broadcasts a `server_restart` WebSocket message (5-second
delay), then replaces the binary and spawns a new process.

**Auth:** Admin IP + Bearer token (ADMINISTRATOR + Owner role)

The update process:
1. Check for available update
2. Download new binary to `chatserver.exe.new`
3. Verify SHA256 checksum against `checksums.sha256`
4. Send HTTP response to caller
5. Broadcast `server_restart` event (5-second countdown)
6. Rename: `chatserver.exe` -> `chatserver.exe.old`, `.new` -> `chatserver.exe`
7. Spawn detached new process
8. Exit current process

#### Response 200 OK

```json
{
  "status": "applying",
  "version": "v1.2.0"
}
```

#### Errors

| Status | Code | Cause |
| ------ | ---- | ----- |
| 403 | `FORBIDDEN` | Not Owner role |
| 409 | `NO_UPDATE` | Server is already up-to-date |
| 502 | `UPDATE_CHECK_FAILED` | GitHub API failure |
| 502 | `MISSING_ASSETS` | Release is missing binary or checksum file |
| 502 | `DOWNLOAD_FAILED` | Download failure or checksum mismatch |
| 503 | `UPDATE_UNAVAILABLE` | Updater not configured |

---

### GET /admin/api/logs/stream

Server-Sent Events (SSE) endpoint that streams structured log entries
in real-time.

**Auth:** Query parameter `?token={session-token}` (because `EventSource`
cannot set `Authorization` headers). Requires ADMINISTRATOR permission.
**Admin IP:** Required (route is under `/admin`)

#### Query Parameters

| Param | Type | Required | Description |
| ----- | ---- | -------- | ----------- |
| `token` | string | Yes | Raw session token (same as used in Bearer header) |

#### Response 200 OK (SSE stream)

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"ts":"2026-03-28T14:30:00.123Z","level":"INFO","msg":"user logged in","source":"http","attrs":"{\"username\":\"alex\",\"user_id\":1}"}

data: {"ts":"2026-03-28T14:30:01.456Z","level":"DEBUG","msg":"ws message received","source":"websocket","attrs":"{\"type\":\"typing\"}"}
```

Each `data:` line is a JSON-encoded log entry:

| Field | Type | Description |
| ----- | ---- | ----------- |
| `ts` | string | RFC3339Nano timestamp |
| `level` | string | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `msg` | string | Log message text |
| `source` | string | Category: `websocket`, `http`, `admin`, `auth`, `database`, `storage`, `updater`, `config`, `server` |
| `attrs` | string or empty | JSON-encoded structured attributes (key-value pairs) |

**Behavior:**
- On connect, the server sends a backfill of all entries currently in the
  ring buffer (most recent N entries).
- New entries are streamed as they occur.
- A keepalive comment (`: keepalive\n\n`) is sent every 15 seconds to
  prevent connection timeout.
- The ring buffer is bounded (drops oldest entries when full).
- Slow subscribers have entries dropped (non-blocking fan-out).

#### Errors

| Status | Response | Cause |
| ------ | -------- | ----- |
| 401 | JSON error | Missing token, invalid/expired session, or not ADMINISTRATOR |

---

## Complete Route Summary

### Public (No Auth)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health` | Health check |
| GET | `/api/v1/health` | Health check (versioned) |
| GET | `/api/v1/info` | Server name and version |
| POST | `/api/v1/auth/register` | Register (rate-limited: 3/min) |
| POST | `/api/v1/auth/login` | Login (rate-limited: 5/min, lockout after 10 fails) |
| GET | `/api/v1/files/{id}` | Serve uploaded file (UUID is unguessable) |
| GET | `/api/v1/client-update/{target}/{current_version}` | Tauri client update check |

### Authenticated (Bearer Token)

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/api/v1/auth/me` | Any | Current user profile |
| POST | `/api/v1/auth/logout` | Any | Invalidate session |
| GET | `/api/v1/channels` | `READ_MESSAGES` | List visible channels |
| GET | `/api/v1/channels/{id}/messages` | `READ_MESSAGES` or DM participant | Paginated messages |
| GET | `/api/v1/channels/{id}/pins` | `READ_MESSAGES` | Pinned messages |
| POST | `/api/v1/channels/{id}/pins/{msgId}` | `MANAGE_MESSAGES` | Pin a message |
| DELETE | `/api/v1/channels/{id}/pins/{msgId}` | `MANAGE_MESSAGES` | Unpin a message |
| GET | `/api/v1/search` | `READ_MESSAGES` (filtered) | Full-text message search |
| POST | `/api/v1/dms` | Any | Create/get DM channel |
| GET | `/api/v1/dms` | Any | List open DM channels |
| DELETE | `/api/v1/dms/{channelId}` | DM participant | Close DM channel |
| POST | `/api/v1/invites` | `MANAGE_INVITES` | Create invite |
| GET | `/api/v1/invites` | `MANAGE_INVITES` | List invites |
| DELETE | `/api/v1/invites/{code}` | `MANAGE_INVITES` | Revoke invite |
| POST | `/api/v1/uploads` | Any | Upload file (100 MiB limit) |
| GET | `/api/v1/diagnostics/connectivity` | Any | Connectivity diagnostics |
| GET | `/api/v1/ws` | In-band WS auth | WebSocket connection |

### Admin IP-Restricted (No Token)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/v1/metrics` | Runtime server metrics |
| POST | `/api/v1/livekit/webhook` | LiveKit webhook receiver |
| GET | `/api/v1/livekit/health` | LiveKit health check |
| * | `/livekit/*` | LiveKit reverse proxy (rate-limited: 30/min) |

### Admin Panel (Admin IP + ADMINISTRATOR Token)

| Method | Path | Extra Auth | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/admin/api/setup/status` | None | Check if setup needed |
| POST | `/admin/api/setup` | None | Initial setup |
| GET | `/admin/api/logs/stream` | Query token | SSE log stream |
| GET | `/admin/api/stats` | ADMINISTRATOR | Server statistics |
| GET | `/admin/api/users` | ADMINISTRATOR | List all users |
| PATCH | `/admin/api/users/{id}` | ADMINISTRATOR | Update user role/ban |
| DELETE | `/admin/api/users/{id}/sessions` | ADMINISTRATOR | Force logout |
| GET | `/admin/api/channels` | ADMINISTRATOR | List all channels |
| POST | `/admin/api/channels` | ADMINISTRATOR | Create channel |
| PATCH | `/admin/api/channels/{id}` | ADMINISTRATOR | Update channel |
| DELETE | `/admin/api/channels/{id}` | ADMINISTRATOR | Delete channel |
| GET | `/admin/api/audit-log` | ADMINISTRATOR | View audit log |
| GET | `/admin/api/settings` | ADMINISTRATOR | Get settings |
| PATCH | `/admin/api/settings` | ADMINISTRATOR | Update settings |
| POST | `/admin/api/backup` | Owner | Create backup |
| GET | `/admin/api/backups` | ADMINISTRATOR | List backups |
| DELETE | `/admin/api/backups/{name}` | Owner | Delete backup |
| POST | `/admin/api/backups/{name}/restore` | Owner | Restore backup |
| GET | `/admin/api/updates` | ADMINISTRATOR | Check for updates |
| POST | `/admin/api/updates/apply` | Owner | Apply update |
