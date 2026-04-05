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

1. **RequestID** -- assigns a unique `X-Request-Id` response header.
2. **Recoverer** -- catches panics and returns 500.
3. **Request Logger** -- structured logging of method, path, status, duration.
4. **SecurityHeaders** -- sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: default-src 'self'`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cache-Control: no-store`.
5. **MaxBodySize** -- 1 MiB default for all routes except `/api/v1/uploads` (which has its own 100 MiB limit).

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
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

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
**Rate limit:** 60 requests/minute per IP. After 10 consecutive failures from the same IP, the IP is locked out for 15 minutes.

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
    "avatar": "uuid.png",
    "status": "offline",
    "role_id": 4,
    "totp_enabled": false,
    "created_at": "2026-03-24T12:00:00Z"
  }
}
```

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
| `category` | string | Category grouping |
| `position` | int | Sort order within category |
| `slow_mode` | int | Slow-mode delay in seconds (0 = disabled) |
| `archived` | bool | Whether the channel is archived |

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
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ],
  "has_more": true
}
```

#### Pagination

Use cursor-based pagination by passing the `id` of the last message as the `before` parameter:

```
GET /api/v1/channels/5/messages?before=1042&limit=50
```

When `has_more` is `false`, you have reached the beginning of the channel history.

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
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ]
}
```

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

---

### DELETE /api/v1/dms/{channelId}

Close a DM channel for the authenticated user (hides it from their sidebar). The channel and messages remain in the database. If the other user sends a new message, the channel is automatically re-opened.

**Auth:** Required

#### Response 204 No Content

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

**Auth:** None (URLs are unguessable UUIDs)
**Caching:** `Cache-Control: public, max-age=31536000, immutable`

Supports HTTP range requests and conditional requests.

---

## Health Check

### GET /health

### GET /api/v1/health

Public health check endpoint, no authentication required.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 86400,
  "online_users": 3
}
```

---

## Server Info

### GET /api/v1/info

Returns the server name and version.

**Auth:** None

```json
{
  "name": "My OwnCord Server",
  "version": "1.2.0"
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
  "livekit_healthy": true
}
```

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
| `target` | string | Platform target (e.g., `windows-x86_64`) |
| `current_version` | string | Client's current semver version (e.g., `1.0.0`) |

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

Client is already up-to-date.

---

## WebSocket

### GET /api/v1/ws

WebSocket upgrade endpoint. Authentication is performed in-band (first message must be an `auth` frame with the session token). See [protocol.md](protocol.md) for the full WebSocket message protocol.
