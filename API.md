# REST API Spec

Base URL: `https://{server}:{port}/api/v1`

Auth: session token in cookie `session` (set on login)
or `Authorization: Bearer {token}` header.

All responses are JSON. Errors return
`{ "error": "CODE", "message": "Human-readable detail" }`.

---

## Auth

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| POST | `/api/v1/auth/register` | None (invite code) | Create account |
| POST | `/api/v1/auth/login` | None | Login, returns session token |
| POST | `/api/v1/auth/logout` | Yes | Invalidate current session |
| POST | `/api/v1/auth/verify-totp` | Partial (2FA) | Submit TOTP code |

### POST /api/v1/auth/register

```json
// Request
{ "username": "alex", "password": "strongpassword", "invite_code": "abc123" }
// Response 201
{ "user": { "id": 1, "username": "alex" }, "token": "session-token" }
```

### POST /api/v1/auth/login

```json
// Request
{ "username": "alex", "password": "strongpassword" }
// Response 200 (no 2FA)
{ "token": "session-token", "requires_2fa": false }
// Response 200 (2FA required)
{ "partial_token": "temp-token", "requires_2fa": true }
```

---

## Users

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/users/me` | Yes | Get current user profile |
| PATCH | `/api/v1/users/me` | Yes | Update own profile (username, avatar) |
| PUT | `/api/v1/users/me/password` | Yes | Change password |
| POST | `/api/v1/users/me/totp/enable` | Yes | Start 2FA setup, returns QR |
| POST | `/api/v1/users/me/totp/confirm` | Yes | Confirm 2FA with TOTP code |
| DELETE | `/api/v1/users/me/totp` | Yes | Disable 2FA |
| GET | `/api/v1/users/me/sessions` | Yes | List active sessions |
| DELETE | `/api/v1/users/me/sessions/{id}` | Yes | Revoke a session |

---

## Channels

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/channels` | Yes | List all channels user can see |
| GET | `/api/v1/channels/{id}/messages` | Yes | Paginated message history |
| GET | `/api/v1/channels/{id}/pins` | Yes | Get pinned messages |
| POST | `/api/v1/channels/{id}/pins/{msg_id}` | Yes (mod) | Pin a message |
| DELETE | `/api/v1/channels/{id}/pins/{msg_id}` | Yes (mod) | Unpin a message |

### GET /api/v1/channels/{id}/messages

Query params: `before` (message ID), `limit` (1-100, default 50)

```json
// Response 200
{
  "messages": [
    {
      "id": 1042,
      "channel_id": 5,
      "user": { "id": 1, "username": "alex", "avatar": "uuid.png" },
      "content": "Hello!",
      "reply_to": null,
      "attachments": [],
      "reactions": [{ "emoji": "👍", "count": 2, "me": true }],
      "pinned": false,
      "edited_at": null,
      "deleted": false,
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ],
  "has_more": true
}
```

---

## File Uploads

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| POST | `/api/v1/uploads` | Yes | Upload a file (multipart) |
| GET | `/api/v1/files/{uuid}` | Yes | Download a file |

### POST /api/v1/uploads

Multipart form data. Field: `file`. Max size from server config (default 25MB).

```json
// Response 201
{
  "id": "upload-uuid",
  "filename": "photo.jpg",
  "size": 204800,
  "mime": "image/jpeg",
  "url": "/api/v1/files/upload-uuid"
}
```

Server validates: magic bytes, rejects executables,
strips EXIF, stores with UUID filename.

---

## Search

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/search` | Yes | Full-text search across accessible channels |

Query params: `q` (search query),
`channel_id` (optional filter), `limit` (default 25)

```json
// Response 200
{
  "results": [
    {
      "message_id": 1042,
      "channel_id": 5,
      "channel_name": "general",
      "user": { "id": 1, "username": "alex" },
      "content": "...matched text...",
      "timestamp": "2026-03-14T10:30:00Z"
    }
  ]
}
```

---

## Invites

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/invites` | Yes (admin) | List all invites |
| POST | `/api/v1/invites` | Yes (manage_invites) | Create an invite |
| DELETE | `/api/v1/invites/{id}` | Yes (manage_invites) | Revoke an invite |

### POST /api/v1/invites

```json
// Request
{ "max_uses": 5, "expires_in_hours": 48 }
// Response 201
{
  "id": 1,
  "code": "abc123def",
  "url": "chatserver://invite/abc123def",
  "max_uses": 5,
  "expires_at": "2026-03-16T10:30:00Z"
}
```

---

## Admin Endpoints (admin panel uses these)

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/admin/stats` | Admin | Server stats (users, msgs, disk) |
| GET | `/api/v1/admin/users` | Admin | List all users with details |
| PATCH | `/api/v1/admin/users/{id}` | Admin | Update user (role, ban/unban) |
| DELETE | `/api/v1/admin/users/{id}/sessions` | Admin | Force logout a user |
| POST | `/api/v1/admin/channels` | Admin | Create channel |
| PATCH | `/api/v1/admin/channels/{id}` | Admin | Update channel |
| DELETE | `/api/v1/admin/channels/{id}` | Admin | Delete channel |
| GET | `/api/v1/admin/audit-log` | Admin | View audit log (paginated) |
| POST | `/api/v1/admin/backup` | Owner | Trigger manual backup |
| GET | `/api/v1/admin/backups` | Owner | List available backups |
| POST | `/api/v1/admin/backups/{id}/restore` | Owner | Restore from backup |
| GET | `/api/v1/admin/settings` | Admin | Get server settings |
| PATCH | `/api/v1/admin/settings` | Admin | Update server settings |
| GET | `/api/v1/admin/update-check` | Admin | Check for new server version |
| GET | `/api/v1/admin/updates` | Admin | Check for available server updates |
| POST | `/api/v1/admin/updates/apply` | Owner | Apply a server update |

### GET /api/v1/admin/updates

Check for available server updates.

Authentication: Bearer token (ADMINISTRATOR permission required)

```json
// Response 200
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

Error responses:

- 401: Unauthorized (missing/invalid token)
- 403: Forbidden (not an administrator)
- 502: Bad Gateway (GitHub API unreachable or returned error)

### POST /api/v1/admin/updates/apply

Download and apply a server update. Downloads the
new binary, verifies its SHA256 checksum, broadcasts
a `server_restart` WS message, then restarts.

Authentication: Bearer token (Owner role required)

```json
// Response 200
{
  "status": "applying",
  "version": "v1.2.0"
}
```

Error responses:

- 401: Unauthorized
- 403: Forbidden (not Owner)
- 409: Conflict (server is already up to date)
- 502: Bad Gateway (download failed, checksum mismatch, or missing release assets)

---

## WebRTC / TURN Credentials

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/voice/credentials` | Yes | Get time-limited TURN credentials |

```json
// Response 200
{
  "ice_servers": [
    { "urls": "stun:server:3478" },
    { "urls": "turn:server:3478", "username": "ts:uid", "credential": "hmac" }
  ],
  "expires_in": 86400
}
```

---

## Custom Emoji

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/emoji` | Yes | List all custom emoji |
| POST | `/api/v1/emoji` | Yes (admin) | Upload new emoji |
| DELETE | `/api/v1/emoji/{id}` | Yes (admin) | Delete emoji |

---

## Soundboard

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/sounds` | Yes | List all soundboard sounds |
| POST | `/api/v1/sounds` | Yes (permission) | Upload a sound |
| DELETE | `/api/v1/sounds/{id}` | Yes (admin) | Delete a sound |

---

## Health Check

| Method | Endpoint | Auth | Description |
| ------ | -------- | ---- | ----------- |
| GET | `/api/v1/health` | None | Returns 200 if server is running |

```json
{ "status": "ok", "version": "1.0.0", "uptime": 86400 }
```

---

## Error Codes

| Code | HTTP Status | Meaning |
| ---- | ----------- | ------- |
| `UNAUTHORIZED` | 401 | Missing or invalid session |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `RATE_LIMITED` | 429 | Too many requests (includes `retry_after`) |
| `INVALID_INPUT` | 400 | Bad request body or params |
| `CONFLICT` | 409 | e.g. username already taken |
| `TOO_LARGE` | 413 | File exceeds upload limit |
| `SERVER_ERROR` | 500 | Internal server error |
